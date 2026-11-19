import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, projects, principalPermissionGrants, agentReferenceFolderConfigs, agentReviewerPolicies, type Db } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/error-handler.js";
import { reviewerNativeTestDatabase } from "./helpers/reviewer-native-database.js";

describe("mounted native agent optional-policy routes, real PostgreSQL",()=>{
 let connection:Awaited<ReturnType<typeof reviewerNativeTestDatabase>>,db:Db,home:string;
 const originalHome=process.env.PAPERCLIP_HOME;
 beforeAll(async()=>{connection=await reviewerNativeTestDatabase();db=connection.db;home=await realpath(await mkdtemp(join(tmpdir(),"f05-policy-http-")));process.env.PAPERCLIP_HOME=join(home,"instance");});
 afterEach(()=>vi.restoreAllMocks());
 afterAll(async()=>{await connection?.end();if(originalHome===undefined)delete process.env.PAPERCLIP_HOME;else process.env.PAPERCLIP_HOME=originalHome;await rm(home,{recursive:true,force:true});});
 async function fixture(){
  const companyId=randomUUID(),userId=randomUUID(),agentId=randomUUID(),projectId=randomUUID(),foreignCompany=randomUUID(),foreignAgent=randomUUID();
  await db.insert(companies).values([{id:companyId,name:"Optional routes",issuePrefix:`O${companyId.slice(0,6)}`},{id:foreignCompany,name:"Foreign",issuePrefix:`F${foreignCompany.slice(0,6)}`}]);
  await db.insert(authUsers).values({id:userId,name:"Operator",email:`${userId}@example.test`,createdAt:new Date(),updatedAt:new Date()});
  await db.insert(companyMemberships).values({companyId,principalId:userId,principalType:"user",membershipRole:"member",status:"active"});
  await db.insert(principalPermissionGrants).values(["agents:read","agents:configure"].map(permissionKey=>({companyId,principalId:userId,principalType:"user",permissionKey})));
  await db.insert(agents).values([{id:agentId,companyId,name:"Native agent",adapterType:"paperclip_runner",adapterConfig:{provider:"codex",homeMode:"isolated"}},{id:foreignAgent,companyId:foreignCompany,name:"Foreign"}]);
  await db.insert(projects).values({id:projectId,companyId,name:"Private project",visibility:"private"});
  const directory=join(home,randomUUID());await mkdir(directory);
  let actor:express.Request["actor"]={type:"board",source:"session",userId,companyIds:[companyId]};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor=actor;next();});app.use("/api",agentRoutes(db));app.use(errorHandler);
  const ref=`/api/agents/${agentId}/reference-folders`,review=`/api/agents/${agentId}/reviewer-policy`;
  const entry={projectId,path:directory},scope={projectId,repositoryId:"99",repository:"fixture/repository"};
  const seed=async()=>{
   await db.insert(agentReferenceFolderConfigs).values({companyId,agentId,revision:1,entries:[entry],updatedByUserId:userId});
   await db.insert(agentReviewerPolicies).values({companyId,agentId,revision:1,enabled:true,scopes:[scope],updatedByUserId:userId});
  };
  const forbidProvider=()=>vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No external provider request is permitted in this route test"));
  return {app,companyId,userId,agentId,projectId,foreignAgent,ref,review,entry,seed,forbidProvider,setActor:(value:typeof actor)=>{actor=value;},board:()=>({type:"board" as const,source:"session" as const,userId,companyIds:[companyId]})};
 }
 it("GET defaults off through the actual native authorization chain, with no provider call or policy writes",async()=>{
  const f=await fixture(),fetch=f.forbidProvider();
  expect((await request(f.app).get(f.ref).expect(200)).body).toMatchObject({revision:0,entries:[],canGrantHostPaths:false,supported:true});
  expect((await request(f.app).get(f.review).expect(200)).body).toMatchObject({revision:0,enabled:false,scopes:[],supported:true});
  expect(fetch).not.toHaveBeenCalled();expect(await db.select().from(agentReviewerPolicies).where(eq(agentReviewerPolicies.agentId,f.agentId))).toEqual([]);
 });
 it.each(["reference-folders","reviewer-policy"])("rejects same-agent API actors before dedicated operator policy access: %s",async suffix=>{
  const f=await fixture();f.setActor({type:"agent",source:"agent_key",agentId:f.agentId,companyId:f.companyId,runId:randomUUID()});
  await request(f.app).get(`/api/agents/${f.agentId}/${suffix}`).expect(403);
  await request(f.app).put(`/api/agents/${f.agentId}/${suffix}`).send(suffix==="reference-folders"?{expectedRevision:0,entries:[]}:{expectedRevision:0,enabled:false,scopes:[]}).expect(403);
 });
 it.each(["reference-folders","reviewer-policy"])("keeps foreign-company targets unavailable: %s",async suffix=>{
  const f=await fixture();await request(f.app).get(`/api/agents/${f.foreignAgent}/${suffix}`).expect(404);
 });
 it("redacts hidden reference metadata and allows audited CAS clear after admin/project access loss",async()=>{
  const f=await fixture();await f.seed();const fetch=f.forbidProvider();
  const read=await request(f.app).get(f.ref).expect(200);expect(read.body).toMatchObject({revision:1,entries:[],hiddenEntryCount:1,canGrantHostPaths:false});
  expect(JSON.stringify(read.body)).not.toContain(f.entry.path);expect(JSON.stringify(read.body)).not.toContain(f.projectId);
  await request(f.app).put(f.ref).send({expectedRevision:1,entries:[]}).expect(200);
  await request(f.app).put(f.ref).send({expectedRevision:1,entries:[]}).expect(409);
  expect((await db.select().from(agentReferenceFolderConfigs).where(eq(agentReferenceFolderConfigs.agentId,f.agentId)))[0]!.revision).toBe(2);
  expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.agentId),eq(activityLog.action,"agent.reference_folders_updated")))).toHaveLength(1);expect(fetch).not.toHaveBeenCalled();
 });
 it("redacts private Reviewer scopes and revokes them without GitHub requalification",async()=>{
  const f=await fixture();await f.seed();const fetch=f.forbidProvider();
  const read=await request(f.app).get(f.review).expect(200);expect(read.body).toMatchObject({revision:1,enabled:true,scopes:[],hiddenScopeCount:1});
  expect(JSON.stringify(read.body)).not.toContain("fixture/repository");expect(JSON.stringify(read.body)).not.toContain(f.projectId);
  await request(f.app).put(f.review).send({expectedRevision:1,enabled:false,scopes:[]}).expect(200);
  await request(f.app).put(f.review).send({expectedRevision:1,enabled:false,scopes:[]}).expect(409);expect(fetch).not.toHaveBeenCalled();
  expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.agentId),eq(activityLog.action,"agent.reviewer_policy_updated")))).toHaveLength(1);
 });
 it("denies new host-folder grants for a configurator without instance-admin authority",async()=>{
  const f=await fixture();await request(f.app).put(f.ref).send({expectedRevision:0,entries:[f.entry]}).expect(403);
  expect(await db.select().from(agentReferenceFolderConfigs).where(eq(agentReferenceFolderConfigs.agentId,f.agentId))).toEqual([]);
 });
 it("rechecks native configuration authority for revocation",async()=>{
  const f=await fixture();await f.seed();await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId,f.userId),eq(principalPermissionGrants.permissionKey,"agents:configure")));
  await request(f.app).put(f.ref).send({expectedRevision:1,entries:[]}).expect(403);
  await request(f.app).put(f.review).send({expectedRevision:1,enabled:false,scopes:[]}).expect(403);
 });
 it("generic adapter JSON cannot replace dedicated operator policy",async()=>{
  const f=await fixture();await f.seed();f.setActor({...f.board(),isInstanceAdmin:true});
  const response=await request(f.app).patch(`/api/agents/${f.agentId}`).send({adapterConfig:{referenceFolders:[],reviewerRole:false}});expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect((await db.select().from(agentReviewerPolicies).where(eq(agentReviewerPolicies.agentId,f.agentId)))[0]!.enabled).toBe(true);
  expect((await db.select().from(agentReferenceFolderConfigs).where(eq(agentReferenceFolderConfigs.agentId,f.agentId)))[0]!.entries).toEqual([f.entry]);
 });
});
