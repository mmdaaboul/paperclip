import { PaperclipRunnerToolAuthority } from "./native-runtime/paperclip-runner-tool-authority.js";
import { createToolGatewayService } from "./tool-gateway.js";
import { registerAgentReviewerPolicyRoutes } from "../routes/agent-reviewer-policies.js";
import { agents, projects, agentReviewerPolicies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { reviewerNativeTestDatabase } from "../__tests__/helpers/reviewer-native-database.js";
import { assertReviewerNativeToolBoundary } from "./native-runtime/reviewer-native-tool-boundary.js";
import { agentReviewerPoliciesService } from "./agent-reviewer-policies.js";
import { nativeReviewerGitHubAuthorization } from "./native-runtime/reviewer-github-authorization.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { authorizationService, type AuthorizationActor, type AuthorizationAction } from "./authorization.js";
import { reviewerRoleBoundary } from "../middleware/reviewer-role-boundary.js";
const pool=await reviewerNativeTestDatabase();
const db=pool.db;let companyId:string,agentId:string,runId:string,issueId:string;let actor:AuthorizationActor;
beforeAll(async()=>{await db.select().from(agentReviewerPolicies).limit(0);}); // Require the actual full native table; never create a partial replacement.

afterAll(async()=>{await pool.end();});
beforeEach(async()=>{
 companyId=randomUUID();agentId=randomUUID();runId=randomUUID();issueId=randomUUID();
 await pool.query("INSERT INTO companies(id,name,issue_prefix) VALUES($1,'Reviewer native fixture',$2)",[companyId,`RV${randomUUID().replaceAll('-','').slice(0,12)}`]);
 await pool.query("INSERT INTO agents(id,company_id,name,role,permissions) VALUES($1,$2,'One Reviewer','ceo',$3)",[agentId,companyId,{canCreateAgents:true}]);
 await pool.query("INSERT INTO issues(id,company_id,title,status,assignee_agent_id) VALUES($1,$2,'Native review','in_review',$3)",[issueId,companyId,agentId]);
 await pool.query("INSERT INTO heartbeat_runs(id,company_id,agent_id,status,runtime_mode,native_issue_id,context_snapshot,runner_profile_json) VALUES($1,$2,$3,'running','native',$4,$5,$6)",[runId,companyId,agentId,issueId,{issueId},{reviewerPolicy:{revision:1}}]);
 await pool.query("UPDATE issues SET execution_run_id=$1 WHERE id=$2",[runId,issueId]);
 await pool.query("INSERT INTO agent_reviewer_policies(company_id,agent_id,revision,enabled,updated_by_user_id) VALUES($1,$2,1,true,'fixture-board')",[companyId,agentId]);
 actor={type:"agent",agentId,companyId,runId,source:"agent_jwt"};
});
const mutations=["agents:create","agents:configure","agents:suggest-changes","skills:create","skills:suggest-changes","environments:manage","tools:admin","tools:manage_connections","tools:manage_profiles","tools:use","tools:manage_runtime","inbox:manage","users:invite","users:manage_permissions","tasks:assign","tasks:assign_scope","tasks:manage_active_checkouts","joins:approve","agent_config:update","agent_config:read","agent_instructions:update","skill_config:update","agent:wake","decision_queue:manage","decision_triage:manage","issue:comment","issue:mutate","project:write_workspace","runtime:manage","secrets:read","secrets:propose"] as AuthorizationAction[];
describe("actual native authorizationService Reviewer boundary, migrated PG18",()=>{
 it.each(mutations)("denies %s even for CEO self authority",async action=>{const d=await authorizationService(db).decide({actor,action,resource:action==="project:write_workspace"?{type:"issue",companyId,issueId,projectId:randomUUID()}:{type:"agent",companyId,agentId}});expect(d.allowed).toBe(false);expect(d.reason).toBe("deny_policy_restricted");});
 it.each(["skill_test","task_bridge"])("blocks %s scoped key before its shortcut",async kind=>{const d=await authorizationService(db).decide({actor:{...actor,keyScope:{kind} as never},action:"agents:create",resource:{type:"company",companyId}});expect(d.reason).toBe("deny_policy_restricted");});
 it("preserves native company boundary",async()=>{const d=await authorizationService(db).decide({actor,action:"agents:create",resource:{type:"company",companyId:randomUUID()}});expect(d.reason).toBe("deny_company_boundary");});
 it("retains active-run restriction after disabling policy",async()=>{await pool.query("UPDATE agent_reviewer_policies SET enabled=false WHERE agent_id=$1",[agentId]);const d=await authorizationService(db).decide({actor,action:"agents:create",resource:{type:"company",companyId}});expect(d.reason).toBe("deny_policy_restricted");});
 it("keeps board native authority",async()=>{const d=await authorizationService(db).decide({actor:{type:"board",source:"local_implicit"},action:"agents:create",resource:{type:"company",companyId}});expect(d.reason).toBe("allow_local_board");});
 it("rejects unassigned narrow review action",async()=>{const d=await authorizationService(db).decide({actor,action:"issue:resolve_assigned_review",resource:{type:"issue",companyId,issueId,interactionId:randomUUID()}});expect(d.allowed).toBe(false);});
});
async function boundary(method:string,path:string,selected:AuthorizationActor=actor){let result:unknown="not-called";await reviewerRoleBoundary(db)({method,path,actor:selected} as never,{} as never,(error?:unknown)=>{result=error??"next";});return result;}
const escapes:[string,string][]=[["POST","/api/companies/C/agents"],["POST","/api/companies/C/agent-hires"],["PATCH","/api/agents/A"],["PATCH","/api/agents/A/permissions"],["POST","/api/agents/A/keys"],["POST","/api/agents/A/config-revisions/random/rollback"],["POST","/api/companies/C/connections"],["POST","/api/companies/C/tool-action-requests"],["POST","/api/tool-gateway/invoke"],["POST","/api/companies/C/projects"],["PATCH","/api/projects/random"],["POST","/api/issues/I/checkout"],["PATCH","/api/issues/I"],["POST","/api/issues/I/comments"],["GET","/api/agents/me"],["GET","/api/agents/A/configuration"],["GET","/api/agents/me/secrets"],["POST","/api/issues/I/interactions/random/accept"],["POST","/api/issues/I/interactions/random/accept/extra"],["PUT","/api/issues/I/interactions/random/accept"],["POST","/api/issues/I/interactions/random/answer"]];
describe("native authenticated Reviewer API escape-path containment",()=>{
 it.each(escapes)("rejects %s %s before route mutation",async(method,path)=>{expect(await boundary(method,path.replaceAll('/C/','/'+companyId+'/').replaceAll('/A','/'+agentId).replaceAll('/I','/'+issueId))).toMatchObject({status:403});});
 it("rejects UUID-shaped foreign or tool-approval interaction",async()=>{expect(await boundary("POST",`/api/issues/${issueId}/interactions/${randomUUID()}/accept`)).toMatchObject({status:403});});
 it("preserves board operator route authorization",async()=>{expect(await boundary("PATCH",`/api/agents/${agentId}`,{type:"board",source:"local_implicit"})).toBe("next");});
 it("rejects another task read",async()=>{expect(await boundary("GET",`/api/issues/${randomUUID()}`)).toMatchObject({status:403});});
});

describe("assembled native authority early shortcuts and recovery",()=>{
 it.each(["create_case","handoff_case","write_file","create_issue","update_issue","execute_tool"])("denies %s before normal mutation or recovery shortcuts",async tool=>{
  const authority=new PaperclipRunnerToolAuthority(db,{companyId,agentId,runId,issueId,casesEnabled:true});
  const call={tool,callId:randomUUID(),arguments:{}};
  await expect(authority.execute(call)).rejects.toMatchObject({status:403});
  await expect(authority.recover(call)).rejects.toMatchObject({status:403});
 });
 it("exposes only the protected catalog when the controller admitted the role",()=>{
  const authority=new PaperclipRunnerToolAuthority(db,{companyId,agentId,runId,issueId,reviewerRole:true,casesEnabled:true});
  const names=authority.definitions().map(tool=>tool.name);expect(names).not.toContain("create_case");expect(names).not.toContain("execute_tool");expect(names).not.toContain("update_issue");
 });
});
describe("assembled generic gateway with absent identityContextId",()=>{
 it("refuses new sessions and plugin discovery for the actual dedicated role",async()=>{
  const gateway=createToolGatewayService(db,{});
  await expect(gateway.createSession({companyId,agentId,runId})).rejects.toMatchObject({status:403});
  await expect(gateway.listPluginToolsForAgent({companyId,agentId})).rejects.toMatchObject({status:403});
 });
 it("rechecks an existing default-off session at discovery and invocation after role enablement",async()=>{
  await pool.query("UPDATE agent_reviewer_policies SET enabled=false WHERE agent_id=$1",[agentId]);
  await pool.query("UPDATE heartbeat_runs SET runner_profile_json='{}' WHERE id=$1",[runId]);
  const gateway=createToolGatewayService(db,{}),session=await gateway.createSession({companyId,agentId,runId});
  await pool.query("UPDATE agent_reviewer_policies SET enabled=true WHERE agent_id=$1",[agentId]);
  await expect(gateway.listToolsForSession(session.token)).rejects.toMatchObject({status:403});
  await expect(gateway.executeTool({sessionToken:session.token,tool:"not-a-real-tool",parameters:{}} as never)).rejects.toMatchObject({status:403});
 });
});
