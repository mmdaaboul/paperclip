import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, projects, agentReviewerPolicies, activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import { agentReviewerPoliciesService } from "../services/agent-reviewer-policies.js";
import { forbidden } from "../errors.js";
import { reviewerNativeTestDatabase } from "./helpers/reviewer-native-database.js";

describe("operator Reviewer configuration, actual native persistence and empty-owner retirement",()=>{
 let connection:Awaited<ReturnType<typeof reviewerNativeTestDatabase>>,db:Db;
 beforeAll(async()=>{connection=await reviewerNativeTestDatabase(1);db=connection.db;});afterAll(async()=>connection?.end());
 async function fixture(){
  const companyId=randomUUID();await db.insert(companies).values({id:companyId,name:"Reviewer policy",issuePrefix:`P${companyId.slice(0,6)}`});
  const [agent]=await db.insert(agents).values({companyId,name:"Optional Reviewer",adapterType:"paperclip_runner",adapterConfig:{provider:"codex",homeMode:"isolated"}}).returning();
  const [project]=await db.insert(projects).values({companyId,name:"Qualified project"}).returning();
  const scope={companyId,agentId:agent!.id},actor={type:"board" as const,userId:"policy-operator"},selection={projectId:project!.id,repositoryId:"99",repository:"fixture/repository"};
  let checks=0,qualifiers=0,repositories=0,canConfigure=true,canRead=true;
  const options={assertCanConfigure:async(executor:Db)=>{checks++;await executor.execute(sql`select 1`);if(!canConfigure)throw forbidden("Configuration revoked");},assertSupportedAgent:async()=>{qualifiers++;},assertProjectReadable:async(_id:string,executor:Db)=>{await executor.execute(sql`select 1`);if(!canRead)throw forbidden("Private project");},assertRepositoryAccessible:async()=>{repositories++;}};
  const service=()=>agentReviewerPoliciesService(db,options),save=(enabled=true,scopes=[selection],expectedRevision=0)=>service().update(scope,actor,{enabled,scopes,expectedRevision});
  return {companyId,agent:agent!,scope,actor,selection,options,service,save,counts:()=>({checks,qualifiers,repositories}),denyConfigure:()=>{canConfigure=false;},denyRead:()=>{canRead=false;}};
 }
 it("defaults off without availability/provider calls or writes",async()=>{
  const f=await fixture();expect(await f.service().read(f.scope,f.actor)).toEqual({revision:0,enabled:false,scopes:[],updatedAt:null});expect(f.counts()).toEqual({checks:1,qualifiers:0,repositories:0});
 });
 it("enables only after qualification and commits the policy and native audit together",async()=>{
  const f=await fixture();expect(await f.save()).toMatchObject({revision:1,enabled:true,scopes:[f.selection]});expect(f.counts()).toEqual({checks:2,qualifiers:1,repositories:1});
  expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.agent.id),eq(activityLog.action,"agent.reviewer_policy_updated")))).toHaveLength(1);
 });
 it("does not requalify or revise an unchanged policy with active work",async()=>{
  const f=await fixture();await f.save();await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,status:"queued"});const before=f.counts();
  expect(await f.save(true,[{...f.selection,repository:"Fixture/Repository"}],1)).toMatchObject({revision:1,enabled:true});expect(f.counts().qualifiers).toBe(before.qualifiers);expect(f.counts().repositories).toBe(before.repositories);
 });
 it("refuses a changed operative role while native work is active",async()=>{
  const f=await fixture();await f.save();await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,status:"queued"});await expect(f.save(false,[],1)).rejects.toMatchObject({status:409});
  expect((await db.select().from(agentReviewerPolicies).where(eq(agentReviewerPolicies.agentId,f.agent.id)))[0]!.enabled).toBe(true);
 });
 it("does not grant if provider qualification fails",async()=>{
  const f=await fixture();f.options.assertRepositoryAccessible=async()=>{throw Error("Repository unavailable");};await expect(f.save()).rejects.toThrow("Repository unavailable");
  expect(await db.select().from(agentReviewerPolicies).where(eq(agentReviewerPolicies.agentId,f.agent.id))).toEqual([]);
 });
 it("rechecks authorization after qualification before committing",async()=>{
  const f=await fixture();f.options.assertRepositoryAccessible=async()=>{f.denyConfigure();};await expect(f.save()).rejects.toMatchObject({status:403});
  expect(await db.select().from(agentReviewerPolicies).where(eq(agentReviewerPolicies.agentId,f.agent.id))).toEqual([]);
 });
 it("does not smooth configuration drift during repository qualification",async()=>{
  const f=await fixture();f.options.assertRepositoryAccessible=async()=>{await db.update(agents).set({adapterConfig:{provider:"codex",model:"changed"}}).where(eq(agents.id,f.agent.id));};await expect(f.save()).rejects.toMatchObject({status:409});
 });
 it("can revoke scopes after project/provider access loss without provider calls",async()=>{
  const f=await fixture();await f.save();f.denyRead();f.options.assertRepositoryAccessible=async()=>{throw Error("No provider during revoke");};
  expect(await f.service().read(f.scope,f.actor)).toMatchObject({revision:1,enabled:true,scopes:[],hiddenScopeCount:1});expect(await f.save(false,[],1)).toMatchObject({revision:2,enabled:false,scopes:[]});
 });
 it("rejects stale CAS and agent self-configuration without qualification",async()=>{
  const f=await fixture();await f.save();const before=f.counts();await expect(f.save(false,[],0)).rejects.toMatchObject({status:409});
  await expect(f.service().update(f.scope,{type:"agent",userId:null},{expectedRevision:1,enabled:false,scopes:[]})).rejects.toMatchObject({status:403});expect(f.counts().qualifiers).toBe(before.qualifiers);
 });
});
