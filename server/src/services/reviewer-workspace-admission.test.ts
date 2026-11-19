import { prepareOptionalNativeReviewerDiscussion } from "./native-runtime/reviewer-github-native-actions.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createNativeReviewerGitHubStore } from "./reviewer-github-native-store.js";
import { createReviewerFixVerificationProducer, loadNativeReviewerFixVerification } from "./native-runtime/reviewer-fix-verification.js";
import { authorizationService } from "./authorization.js";
import { resolveNativeWorkspacePolicy, resolveNativeWorkspacePolicyForClaimedStop } from "./native-runtime/workspace-policy-admission.js";
import { executePaperclipNativeSession } from "./native-runtime/native-session-executor.js";
import { createWorkspaceAccessSnapshot } from "../vendor/paperclip-runner/index.js";
import { nativeReviewerAssignmentId } from "./native-runtime/reviewer-native-assignment.js";
import { beforeEach, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("./native-runtime/reviewer-github-private-identity.js",()=>({nativeReviewerPrivateToken:async()=>"synthetic-fixture-only-native-identity"}));
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { recordNativeReviewerProcessAdmission, validateNativeReviewerExecution, nativeReviewerRuntimeQualification } from "./native-runtime/reviewer-runtime-admission.js";
import { readProcessStartedAt } from "./hot-restart.js";
import { materializeAsset } from "./native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import { canonicalNativeRuntimeContextDigest, parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { createHeartbeatInstructionWorkingCopy } from "./heartbeat/instruction-working-copy.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { reviewerNativeTestDatabase } from "../__tests__/helpers/reviewer-native-database.js";
import { prepareNativeReviewerWorkspaceAdmission, parseReviewerWorkspaceAdmission } from "./native-runtime/reviewer-workspace-admission.js";
import { prepareAgentReferenceFolderAdmission } from "./agent-reference-folder-admission.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { agents, authUsers, activityLog, heartbeatRuns, nativeRunFinalizations, budgetReservations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createHeartbeatRunPreparation } from "./heartbeat/run-preparation.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./heartbeat/runtime-selection.js";
import { resolveHeartbeatNativeRuntimeMode } from "./native-runtime/runtime-mode.js";
import { issueService } from "./issues.js";
const pool=await reviewerNativeTestDatabase(),db=pool.db;
let companyId:string,agentId:string,runId:string,issueId:string,projectId:string,workspaceDirectory:string;
const roots:string[]=[]; const oldHome=process.env.PAPERCLIP_HOME;
beforeEach(async()=>{
 companyId=randomUUID();agentId=randomUUID();runId=randomUUID();issueId=randomUUID();projectId=randomUUID();
 const root=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR!,"admission-")));roots.push(root);process.env.PAPERCLIP_HOME=join(root,"instance-home");await fs.mkdir(resolvePaperclipInstanceRoot(),{recursive:true,mode:0o700});workspaceDirectory=join(root,"candidate");await fs.mkdir(workspaceDirectory);await fs.writeFile(join(workspaceDirectory,"original"),"preserved");
 await pool.query("INSERT INTO companies(id,name,issue_prefix) VALUES($1,'Reviewer admission fixture',$2)",[companyId,`RA${randomUUID().replaceAll('-','').slice(0,12)}`]);
 await pool.query("INSERT INTO agents(id,company_id,name,role,adapter_type,adapter_config) VALUES($1,$2,'Same single Reviewer','ceo','paperclip_runner',$3)",[agentId,companyId,{provider:'codex',homeMode:'isolated'}]);
 await pool.query("INSERT INTO projects(id,company_id,name) VALUES($1,$2,'Scoped project')",[projectId,companyId]);
 await pool.query("INSERT INTO issues(id,company_id,project_id,title,status,assignee_agent_id) VALUES($1,$2,$3,'Actual native review','in_review',$4)",[issueId,companyId,projectId,agentId]);
 await pool.query("INSERT INTO heartbeat_runs(id,company_id,agent_id,status,runtime_mode,native_issue_id,context_snapshot) VALUES($1,$2,$3,'running','native',$4,$5)",[runId,companyId,agentId,issueId,{issueId}]);
 await pool.query("UPDATE issues SET execution_run_id=$1 WHERE id=$2",[runId,issueId]);
 await pool.query("INSERT INTO agent_reviewer_policies(company_id,agent_id,revision,enabled,scopes,updated_by_user_id) VALUES($1,$2,1,true,$3,'fixture-board')",[companyId,agentId,[{projectId,repositoryId:'99',repository:'fixture/repository'}]]);
 await assignedReview(); const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));await prepareAgentReferenceFolderAdmission(db,{agent:agent!,runId,issueId,projectId,workspaceId:runId,workspaceDirectory,executionDriver:'local'});
});
afterAll(async()=>{await pool.end();if(oldHome===undefined)delete process.env.PAPERCLIP_HOME;else process.env.PAPERCLIP_HOME=oldHome;for(const path of roots){const writable=async(p:string):Promise<void>=>{const st=await fs.lstat(p);if(st.isDirectory()){await fs.chmod(p,0o700);for(const item of await fs.readdir(p))await writable(join(p,item));}else await fs.chmod(p,0o600);};await writable(path);await fs.rm(path,{recursive:true,force:true});}});
async function assignedReview() {
 const builder=randomUUID(),sourceRun=randomUUID(),contract=randomUUID(),result=randomUUID(),assessment=randomUUID(),decision=randomUUID(),interaction=randomUUID();
 await pool.query("INSERT INTO agents(id,company_id,name) VALUES($1,$2,'Generic Builder')",[builder,companyId]);
 await pool.query("INSERT INTO completion_contracts(id,company_id,issue_id,revision,schema_version,policy_version,risk,completion_authority,incomplete_criteria_policy,contract_json,canonical_sha256,created_by_actor_type,created_by_actor_id) VALUES($1,$2,$3,1,'fixture','fixture','low','review','reject','{}',$4,'user','fixture-board')",[contract,companyId,issueId,'a'.repeat(64)]);
 await pool.query("INSERT INTO heartbeat_runs(id,company_id,agent_id,status,runtime_mode,native_issue_id,completion_contract_id) VALUES($1,$2,$3,'succeeded','native',$4,$5)",[sourceRun,companyId,builder,issueId,contract]);
 await pool.query("INSERT INTO native_run_results(id,company_id,issue_id,run_id,completion_contract_id,server_fingerprint,schema_status,result_json,canonical_sha256) VALUES($1,$2,$3,$4,$5,'fixture','valid','{}',$6)",[result,companyId,issueId,sourceRun,contract,'b'.repeat(64)]);
 await pool.query("INSERT INTO work_assessments(id,company_id,issue_id,run_id,contract_id,result_id,trigger_kind,trigger_actor_company_id,prior_issue_status,prior_status_version,policy_version,assessment_json,input_digest) VALUES($1,$2,$3,$4,$5,$6,'run_result',$2,'in_progress',0,'fixture','{}',$7)",[assessment,companyId,issueId,sourceRun,contract,result,'c'.repeat(64)]);
 await pool.query("INSERT INTO status_decisions(id,company_id,issue_id,run_id,assessment_id,decision_version,policy_version,from_status,to_status,reason_code,decision_json,decision_digest,application_state) VALUES($1,$2,$3,$4,$5,1,'fixture','in_progress','in_review','review_required',$6,$7,'applied')",[decision,companyId,issueId,sourceRun,assessment,{projectedStatusVersion:1},'d'.repeat(64)]);
 await pool.query("INSERT INTO issue_thread_interactions(id,company_id,issue_id,kind,effective_resolver_policy,resolver_policy_provenance,source_run_id,created_by_agent_id,addressee_agent_id,payload) VALUES($1,$2,$3,'request_confirmation','anyone','explicit',$4,$5,$6,$7)",[interaction,companyId,issueId,sourceRun,builder,agentId,{version:1,prompt:'Verify candidate',target:{type:'custom',key:'native_completion_review',revisionId:decision}}]);
 await pool.query("UPDATE issues SET assignee_agent_id=$1,status_version=1,last_status_decision_id=$2 WHERE id=$3",[builder,decision,issueId]);
 await pool.query("UPDATE heartbeat_runs SET context_snapshot=$1 WHERE id=$2",[{issueId,nativeReviewInteractionId:interaction,nativeReviewDecisionId:decision,sourceRunId:sourceRun},runId]);
 return {builder,sourceRun,decision,interaction};
}

const prepare=()=>prepareNativeReviewerWorkspaceAdmission(db,{companyId,agentId,runId,issueId,workspaceId:runId,workspaceDirectory,executionDriver:'local'});
describe("composed native heartbeat Reviewer selection",()=>{
 it("persists the actual immutable readonly admission and context before execution without a mutable instruction copy",async()=>{
  const { heartbeatRuns, issues }=await import('@paperclipai/db');
  await db.update(agents).set({status:'running',adapterConfig:{provider:'codex',homeMode:'isolated',model:'gpt-6-luna'}}).where(eq(agents.id,agentId));
  const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
  const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
  const [issue]=await db.select().from(issues).where(eq(issues.id,issueId));
  const now=new Date();const input:HeartbeatRuntimeSelectionInput={run:run!,agent:agent!,
   nativeRuntimeResolution:resolveHeartbeatNativeRuntimeMode({persisted:run!,enabled:true,runtimeConfig:{},adapterConfig:agent!.adapterConfig,agent:agent!,issue:issue!,target:null,workspaceId:runId}),
   task:{issueRef:issue!,issueContext:await createHeartbeatRunPreparation(db).getIssueExecutionContext(companyId,issueId),context:run!.contextSnapshot??{},executionContinuation:null,safeWakeComments:[],safeWakeCommentContext:null,paperclipWakePayload:null,acceptedPlanContinuationWake:false},
   session:{persistedNativeExecutionInput:null,persistedRunnerProfile:run!.runnerProfileJson??{},taskSessionCredentialCompatible:true,taskSessionDecodedParams:null,taskSessionForRun:null,isFailedChatRunRetry:false,getFreshSessionHandoff:undefined},
   workspace:{persistedExecutionWorkspace:null,executionWorkspace:{cwd:workspaceDirectory,repoUrl:null,repoRef:null,branchName:null},executionTarget:null,isDotRun:false,projectRepositoryPaths:[],activeEnvironmentLease:{lease:{id:randomUUID(),companyId,environmentId:null,executionWorkspaceId:runId,issueId,heartbeatRunId:runId,status:'active',leasePolicy:'ephemeral',provider:null,providerLeaseId:null,acquiredAt:now,lastUsedAt:now,expiresAt:null,releasedAt:null,failureReason:null,cleanupStatus:null,metadata:null,createdAt:now,updatedAt:now}}},
   config:{runtimeConfig:{},runtimeSkillEntries:[],runScopedMentionedSkillKeys:[],instructionCopy:null,agentIdentity:undefined,issueAssigneeOverrides:null,resolvedConfig:{},managedAiRuntime:undefined},recovery:{},trace:{providerTraceRequested:false,providerTraceCapture:null},issuesSvc:issueService(db),runtimeEnv:{},
   onAdapterEvent:async()=>{},onNativeLifecycleSelected:()=>{},onProviderResourceDisposition:()=>{},onNativeOwnershipHeld:()=>{},stopControllerLease:()=>{}};
  const selected=await selectHeartbeatRuntime(db,input);
  if(!selected.selected||!selected.nativeExecution||!selected.reviewerWorkspaceAccess||!('runtimeContext' in selected.nativeExecution))throw Error('Actual protected Reviewer selection missing');
  expect(selected.nativeExecution.runtimeContext.instructions.workingCopy).toBeUndefined();
  expect(selected.reviewerWorkspaceAccess.workspaceAccess.policy.readOnlyWorkspace).toBe(true);
  const admitted=JSON.parse(await fs.readFile(join(selected.nativeExecution.runtimeContext.instructions.bundle.rootPath,selected.reviewerWorkspaceAccess.instructionFile.path),'utf8'));
  expect(admitted).toMatchObject({schema:'paperclip.reviewer-admission.v1',binding:{companyId,agentId,runId,issueId,projectId}});
  await expect(validateNativeReviewerExecution(db,selected.nativeExecution,selected.reviewerWorkspaceAccess.workspaceAccess)).resolves.toEqual(selected.reviewerWorkspaceAccess.record);
  expect(selected.nativeExecution.task.prompt).toContain('Use $TMPDIR for temporary output');
 });
});
describe("actual native completion Reviewer workspace admission, migrated native PG18",()=>{
 it("freezes the real assignment, read-only candidate, server-owned scratch and reference revision",async()=>{const prepared=await prepare();expect(prepared?.record.assignment.kind).toBe('native_completion_review');expect(prepared?.workspaceAccess.policy).toMatchObject({workspaceDirectory,readOnlyWorkspace:true,referenceDirectories:[]});expect(prepared?.tmpdir).toContain(`/reviewer-scratch/${companyId}/${agentId}/${runId}`);expect(prepared?.record.scratchIdentity.owner).toBe(process.getuid!());const stored=(await pool.query<{runner_profile_json:Record<string,unknown>}>("SELECT runner_profile_json FROM heartbeat_runs WHERE id=$1",[runId])).rows[0]!.runner_profile_json;expect(parseReviewerWorkspaceAdmission(stored.reviewerPolicy)).toEqual(prepared!.record);expect(stored.referenceFolderAdmission).toBeTruthy();});
 it("retains the exact immutable snapshot on same-run recovery, including JSONB object key order",async()=>{const first=await prepare();expect((await prepare())?.record).toEqual(first?.record);});
 it('serializes even an initially-off role against the actual operator agent lock',async()=>{await pool.query("UPDATE agent_reviewer_policies SET enabled=false WHERE agent_id=$1",[agentId]);let locked!:()=>void,release!:()=>void;const acquired=new Promise<void>(resolve=>{locked=resolve;});const resume=new Promise<void>(resolve=>{release=resolve;});const owner=db.transaction(async tx=>{await tx.select().from(agents).where(eq(agents.id,agentId)).for('update');await tx.execute((await import('drizzle-orm')).sql`UPDATE agent_reviewer_policies SET enabled=true,revision=2 WHERE agent_id=${agentId}::uuid`);locked();await resume;});await acquired;const admission=prepare();release();await owner;expect((await admission)?.record.revision).toBe(2);});
 it("keeps reference-only operation absent when no Reviewer role was ever granted",async()=>{await pool.query("DELETE FROM agent_reviewer_policies WHERE agent_id=$1",[agentId]);expect(await prepare()).toBeNull();});
 it.each(['role_revoked','role_revision','cwd_changed','scratch_replaced','interaction_replaced','source_run_context','low_trust','paused_reviewer','foreign_project','missing_reference','retrofit_execution'])('refuses %s without restoring unrestricted access',async kind=>{
  if(!['missing_reference','retrofit_execution','low_trust','paused_reviewer'].includes(kind))await prepare();
  if(kind==='role_revoked')await pool.query("UPDATE agent_reviewer_policies SET enabled=false WHERE agent_id=$1",[agentId]);
  if(kind==='role_revision')await pool.query("UPDATE agent_reviewer_policies SET revision=2 WHERE agent_id=$1",[agentId]);
  if(kind==='cwd_changed'){workspaceDirectory=join(workspaceDirectory,'different');await fs.mkdir(workspaceDirectory);}
  if(kind==='scratch_replaced'){const admitted=(await prepare())!;await fs.rename(admitted.tmpdir,admitted.tmpdir+'.retained');await fs.mkdir(admitted.tmpdir,{mode:0o700});}
  if(kind==='interaction_replaced')await pool.query("UPDATE heartbeat_runs SET context_snapshot=context_snapshot||$1::jsonb WHERE id=$2",[{nativeReviewInteractionId:randomUUID()},runId]);
  if(kind==='source_run_context')await pool.query("UPDATE heartbeat_runs SET context_snapshot=context_snapshot||$1::jsonb WHERE id=$2",[{sourceRunId:randomUUID()},runId]);
  if(kind==='low_trust')await pool.query("UPDATE agents SET permissions=$1 WHERE id=$2",[{trustPreset:'low_trust_review'},agentId]);
  if(kind==='paused_reviewer')await pool.query("UPDATE agents SET status='paused' WHERE id=$1",[agentId]);
  if(kind==='foreign_project')await pool.query("UPDATE issues SET project_id=NULL WHERE id=$1",[issueId]);
  if(kind==='missing_reference')await pool.query("UPDATE heartbeat_runs SET runner_profile_json='{}' WHERE id=$1",[runId]);
  if(kind==='retrofit_execution')await pool.query("UPDATE heartbeat_runs SET runner_profile_json=runner_profile_json||'{\"nativeExecutionInput\":{}}' WHERE id=$1",[runId]);
  await expect(prepare()).rejects.toThrow();
 });
});

async function admittedExecution(){
 const admission=(await prepare())!;const asset=await materializeAsset([{path:'AGENTS.md',content:Buffer.from('Read only Reviewer'),mode:0o400},{path:admission.instructionFile.path,content:Buffer.from(admission.instructionFile.content),mode:0o400}]);
 const base=nativeRuntimeContextFixture(),context={...base,instructions:{entryPath:'AGENTS.md',bundle:asset}};context.aggregateDigest=canonicalNativeRuntimeContextDigest(context);
 const execution=parseNativeExecutionInput({schema:'paperclip.native-execution-input.v7',homeMode:'isolated',executionMode:'default',planningContext:null,binding:{companyId,agentId,runId,issueId,executionWorkspaceId:runId},task:{identifier:'FIX-1',title:'Actual native Reviewer fixture',description:null,prompt:'Verify current candidate',workMode:'standard'},workspace:{cwd:workspaceDirectory,repoUrl:null,repoRef:null,branchName:null},session:{normalizedSessionId:null,driverKind:'codex_app_server',protocolVersion:1,lifecyclePolicy:{mode:'per_turn',idleTimeoutMs:null}},provider:{kind:'codex',model:null,approvalPolicy:'never'},runtimeContext:context,completionContract:{id:'contract-fixture',sha256:'fixture',schemaVersion:'fixture',contract:{revision:'1',objective:'Verify',criteria:[{id:'test',requirement:'Check'}]}},interactionResponses:[],credentialBindings:[]});
 if(execution.schema!=="paperclip.native-execution-input.v7")throw Error("fixture must be native v7");
 await pool.query("UPDATE heartbeat_runs SET runner_profile_json=runner_profile_json||$1::jsonb WHERE id=$2",[{nativeExecutionInput:execution},runId]);return {admission,execution};
}
describe('concrete controller runtime/context receipt predicate, actual native input + PG + harmless child process fixture',()=>{
 it('validates exact protected snapshot and immutable server asset; rejects policy/working-copy/input forgery',async()=>{const {admission,execution}=await admittedExecution();expect((await validateNativeReviewerExecution(db,execution,admission.workspaceAccess)).binding.runId).toBe(runId);
  await expect(validateNativeReviewerExecution(db,{...execution,workspace:{...execution.workspace,cwd:workspaceDirectory+'/other'}},admission.workspaceAccess)).rejects.toThrow();
  const mutable={...execution,...('runtimeContext' in execution?{runtimeContext:{...execution.runtimeContext,instructions:{...execution.runtimeContext.instructions,workingCopy:{rootPath:workspaceDirectory,entryPath:'AGENTS.md'}}}}:{})};await expect(validateNativeReviewerExecution(db,mutable,admission.workspaceAccess)).rejects.toThrow(/immutable/);
  await pool.query("UPDATE agent_reviewer_policies SET enabled=false WHERE agent_id=$1",[agentId]);await expect(validateNativeReviewerExecution(db,execution,admission.workspaceAccess)).rejects.toThrow();
 });
 it('accepts the native v5 implicit isolated home contract and rejects explicit preconfigured v7',async()=>{const {admission,execution}=await admittedExecution();const {homeMode,...withoutHome}=execution;expect(homeMode).toBe('isolated');const v5=parseNativeExecutionInput({...withoutHome,schema:'paperclip.native-execution-input.v5'});await pool.query("UPDATE heartbeat_runs SET runner_profile_json=runner_profile_json||$1::jsonb WHERE id=$2",[{nativeExecutionInput:v5},runId]);await expect(validateNativeReviewerExecution(db,v5,admission.workspaceAccess)).resolves.toMatchObject({revision:1});const external=parseNativeExecutionInput({...execution,homeMode:'preconfigured'});await pool.query("UPDATE heartbeat_runs SET runner_profile_json=runner_profile_json||$1::jsonb WHERE id=$2",[{nativeExecutionInput:external},runId]);await expect(validateNativeReviewerExecution(db,external,admission.workspaceAccess)).rejects.toThrow(/isolated local Codex/);});
 it.each(['resolved_interaction','lost_execution_lock'])('rechecks the native assignment at the transport boundary: %s',async kind=>{const {admission,execution}=await admittedExecution();if(kind==='resolved_interaction')await pool.query("UPDATE issue_thread_interactions SET status='resolved' WHERE id=$1",[nativeReviewerAssignmentId(admission.record.assignment)]);else await pool.query("UPDATE issues SET execution_run_id=NULL WHERE id=$1",[issueId]);await expect(validateNativeReviewerExecution(db,execution,admission.workspaceAccess)).rejects.toThrow();});
 it('requires controller-persisted actual PID/start/session ownership, rejects stale receipt and missing runtime proof',async()=>{const {admission,execution}=await admittedExecution();const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(child,'spawn');
  try{const started=await readProcessStartedAt(child.pid!);expect(started).toBeTruthy();const runnerInstanceId=randomUUID(),nativeSessionId=randomUUID();
   await expect(recordNativeReviewerProcessAdmission(db,{execution,workspaceAccess:admission.workspaceAccess,runnerInstanceId,process:{pid:child.pid!,processGroupId:null,startedAt:started!}})).rejects.toThrow(/controller process ownership/);
   await pool.query("UPDATE heartbeat_runs SET runner_instance_id=$1,native_session_id=$2,driver_kind='codex_app_server',process_pid=$3,process_started_at=$4 WHERE id=$5",[runnerInstanceId,nativeSessionId,child.pid,started,runId]);
   const receipt=await recordNativeReviewerProcessAdmission(db,{execution,workspaceAccess:admission.workspaceAccess,runnerInstanceId,process:{pid:child.pid!,processGroupId:null,startedAt:new Date().toISOString()}});expect(receipt.pid).toBe(child.pid);
   const facts=async()=>{const {heartbeatRuns,issues}=await import('@paperclipai/db');const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));const [issue]=await db.select().from(issues).where(eq(issues.id,issueId));const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));return {run:run!,issue:issue!,agent:agent!,scope:{schema:'paperclip.reviewer-github-scope.v1' as const,binding:{companyId,agentId,runId,issueId,projectId},roleRevision:1,assignment:{kind:'native_completion_review' as const,id:nativeReviewerAssignmentId(admission.record.assignment),sourceDecisionId:admission.record.assignment.sourceDecisionId},repositoryId:'99',repository:'fixture/repository',pullNumber:1,headSha:'a'.repeat(40)}};};
   await expect(nativeReviewerRuntimeQualification(db)(await facts())).resolves.toBeUndefined();
   await pool.query("UPDATE heartbeat_runs SET process_pid=$1 WHERE id=$2",[process.pid,runId]);await expect(nativeReviewerRuntimeQualification(db)(await facts())).rejects.toThrow(/missing or stale/);
   await pool.query("UPDATE heartbeat_runs SET runner_profile_json=runner_profile_json-'reviewerRuntimeAdmission' WHERE id=$1",[runId]);await expect(nativeReviewerRuntimeQualification(db)(await facts())).rejects.toThrow();
  }finally{child.kill('SIGTERM');await once(child,'exit');}
 });
});

describe("qualified native review delegated write ceilings",()=>{
 it.each(["authorized","authorizing_operator","responsible_viewer","authorizing_viewer"])("keeps native human mutation authority: %s",async mode=>{
  const {admission,execution}=await admittedExecution();const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});await once(child,"spawn");
  try{
   const started=await readProcessStartedAt(child.pid!),runnerInstanceId=randomUUID(),nativeSessionId=randomUUID(),user=randomUUID();
   await pool.query("UPDATE heartbeat_runs SET runner_instance_id=$1,native_session_id=$2,driver_kind='codex_app_server',process_pid=$3,process_started_at=$4 WHERE id=$5",[runnerInstanceId,nativeSessionId,child.pid,started,runId]);
   await recordNativeReviewerProcessAdmission(db,{execution,workspaceAccess:admission.workspaceAccess,runnerInstanceId,process:{pid:child.pid!,processGroupId:null,startedAt:started!}});
   await db.insert(authUsers).values({id:user,name:"Delegated user",email:`${user}@example.test`,createdAt:new Date(),updatedAt:new Date()});
   await pool.query("INSERT INTO company_memberships(company_id,principal_type,principal_id,status,membership_role) VALUES($1,'user',$2,'active',$3)",[companyId,user,['authorized','authorizing_operator'].includes(mode)?'operator':'viewer']);
   const actor={type:'agent' as const,agentId,companyId,runId,source:'agent_jwt' as const,...(mode.startsWith('authorizing_')?{authorizingUserId:user}:{onBehalfOfUserId:user})};
   const decision=await authorizationService(db).decide({actor,action:'issue:resolve_assigned_review',resource:{type:'issue',companyId,issueId,interactionId:nativeReviewerAssignmentId(admission.record.assignment)}});
   expect(decision.allowed).toBe(['authorized','authorizing_operator'].includes(mode));
  }finally{child.kill('SIGTERM');await once(child,'exit');}
 });
});
describe("actual native Stop claim preserves original restrictions",()=>{
 async function claimedStop(){
  const saved=await admittedExecution(),auditId=randomUUID(),intentId=`native-cancellation:${randomUUID()}`,leaseOwner="f05-owned-stop";
  await db.insert(activityLog).values({id:auditId,companyId,runId,actorType:"system",actorId:"fixture",action:"native.cancellation_intent_recorded",entityType:"heartbeat_run",entityId:runId});
  await db.update(heartbeatRuns).set({resultJson:{nativeCancellation:{schema:"paperclip.native-cancellation.v1",scope:"run",reasonCode:"cancellation_run_only",runId,companyId,issueId,intentId,intentAuditId:auditId,dispatchState:"pending",dispatched:false,effects:["release_run_resources"]}}}).where(eq(heartbeatRuns.id,runId));
  await db.insert(nativeRunFinalizations).values({companyId,issueId,runId,phase:"observed",leaseOwner,leaseExpiresAt:new Date(Date.now()+60_000),controllerGeneration:2,attempt:1,recoveryState:"awaiting_runner_reattach",recoveryHistory:[{disposition:"reattach_remote_runner",controllerGeneration:2,providerAttempt:1}]});
  await db.insert(budgetReservations).values({companyId,runId,agentId,state:"held",amountCents:"1"});
  await pool.query("UPDATE agent_reviewer_policies SET enabled=false WHERE agent_id=$1",[agentId]);
  await pool.query("UPDATE issue_thread_interactions SET status='resolved' WHERE id=$1",[nativeReviewerAssignmentId(saved.admission.record.assignment)]);
  return {...saved,leaseOwner};
 }
 it("allows only the genuinely held Stop claim after review resolution and role revocation",async()=>{
  const f=await claimedStop();expect(await resolveNativeWorkspacePolicyForClaimedStop(db,f.execution,f.leaseOwner)).toEqual(f.admission.workspaceAccess);
  await expect(resolveNativeWorkspacePolicy(db,f.execution)).rejects.toThrow();
  await expect(resolveNativeWorkspacePolicyForClaimedStop(db,f.execution,"foreign-owner")).rejects.toThrow("native_stop_claim_missing");
 });
 it.each(["audit","budget","expired","terminal"])("refuses a Stop claim without native ownership evidence: %s",async mode=>{
  const f=await claimedStop();
  if(mode==="audit")await db.delete(activityLog).where(eq(activityLog.runId,runId));
  if(mode==="budget")await db.update(budgetReservations).set({state:"released"}).where(eq(budgetReservations.runId,runId));
  if(mode==="expired")await db.update(nativeRunFinalizations).set({leaseExpiresAt:new Date(Date.now()-1000)}).where(eq(nativeRunFinalizations.runId,runId));
  if(mode==="terminal")await db.update(heartbeatRuns).set({status:"cancelled"}).where(eq(heartbeatRuns.id,runId));
  await expect(resolveNativeWorkspacePolicyForClaimedStop(db,f.execution,f.leaseOwner)).rejects.toThrow("native_stop_claim_missing");
 });
});
describe("controller origin and optional provider boundary",()=>{
 it.each(["missing","malformed"])("keeps native review available while unsupported PR ownership stays unavailable: %s",async mode=>{
  const f=await admittedExecution();
  if(mode==="malformed")await db.update(heartbeatRuns).set({runnerProfileJson:{nativeExecutionInput:{schema:"unsupported"}}}).where(eq(heartbeatRuns.id,f.admission.record.assignment.sourceRunId));
  const fetchImpl=vi.fn<typeof fetch>().mockRejectedValue(new Error("No external request")),onUnavailable=vi.fn(async()=>undefined);
  expect(await prepareOptionalNativeReviewerDiscussion(db,{execution:f.execution,workspaceAccess:f.admission.workspaceAccess,fetchImpl,onUnavailable})).toBeUndefined();
  expect(onUnavailable).toHaveBeenCalledOnce();expect(fetchImpl).not.toHaveBeenCalled();await expect(validateNativeReviewerExecution(db,f.execution,f.admission.workspaceAccess)).resolves.toMatchObject({revision:1});
 });

 it("reconstructs only the originally admitted policy without caller assistance",async()=>{
  const {admission,execution}=await admittedExecution();expect(await resolveNativeWorkspacePolicy(db,execution)).toEqual(admission.workspaceAccess);
 });
 it("refuses a public recomputed writable policy",async()=>{
  const {admission,execution}=await admittedExecution();
  const forged=createWorkspaceAccessSnapshot(admission.workspaceAccess.binding,{...admission.workspaceAccess.policy,readOnlyWorkspace:false});
  await expect(resolveNativeWorkspacePolicy(db,execution,forged)).rejects.toThrow("workspace_policy_caller_snapshot_mismatch");
 });
 it("refuses a coherently copied admission from another run",async()=>{
  const {admission,execution}=await admittedExecution(),foreignRun=randomUUID();
  const copied={...admission.record,binding:{...admission.record.binding,runId:foreignRun},workspaceAccess:createWorkspaceAccessSnapshot({...admission.workspaceAccess.binding,runId:foreignRun},admission.workspaceAccess.policy)};
  await pool.query("UPDATE heartbeat_runs SET runner_profile_json=runner_profile_json||$1::jsonb WHERE id=$2",[{reviewerPolicy:copied},runId]);
  await expect(resolveNativeWorkspacePolicy(db,execution)).rejects.toThrow("workspace_policy_saved_admission_invalid");
 });
 it("the actual executor refuses a custom backend rather than dropping protection",async()=>{
  const {execution}=await admittedExecution();
  await expect(executePaperclipNativeSession({db,execution,useRunnerd:true,backend:{} as never,runnerInstanceId:randomUUID()})).rejects.toThrow("workspace_policy_requires_isolated_local_runner");
 });
});
describe('actual native instruction lifecycle preparation with the persisted optional Reviewer role',()=>{
 it.each([false,true])('allocates no mutable copy, warm reservation or collection when retainedAfterRevocation=%s',async revoked=>{
  if(revoked){await prepare();await pool.query("UPDATE agent_reviewer_policies SET enabled=false WHERE agent_id=$1",[agentId]);}
  const {heartbeatRuns}=await import('@paperclipai/db');const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
  const copies={prepare:vi.fn(),collectStopped:vi.fn(),hasChanges:vi.fn(),checkpointWarm:vi.fn()};type Input=Parameters<typeof createHeartbeatInstructionWorkingCopy>[0];
  const controller=createHeartbeatInstructionWorkingCopy({db,instructionCopies:copies as unknown as Input['instructionCopies'],readRun:()=>run!,agent:agent!,context:{},session:{taskSession:null,taskSessionForRun:null,sessionConfigMetadata:{} as Input['session']['sessionConfigMetadata']},workspace:{executionTarget:null,executionWorkspace:{cwd:workspaceDirectory} as Input['workspace']['executionWorkspace'],persistedExecutionWorkspace:null},appendRunEvent:vi.fn()});
  const config={retained:true};expect(await controller.prepare({runtimeConfig:config,hasInstructionFilesystem:true,nativeLifecyclePolicy:null,nativeRuntimeResolution:{kind:'native',profile:{backend:'codex_app_server'}} as Parameters<typeof controller.prepare>[0]['nativeRuntimeResolution']})).toBe(config);await controller.collectStoppedInstructions();expect(copies.prepare).not.toHaveBeenCalled();expect(copies.collectStopped).not.toHaveBeenCalled();expect(controller.nativeInstructionWorkingCopy()).toBeUndefined();expect(controller.nativeInstructionReservation).toBeNull();
 });
});

// Closed producer tests use an explicit authorization seam and loopback HTTP;
// actual native run/process/role authority is tested above, no real GitHub call.
async function providerFixture(initialHead='a'.repeat(40)){
 let head=initialHead,repositoryId=99,blobText='fixed bytes',blobShaOverride:string|null=null;const seen:string[]=[];
 const server=createServer((req,res)=>{seen.push(`${req.method} ${req.url}`);if(req.method!=='GET'){res.writeHead(405);res.end();return;}res.setHeader('content-type','application/json');
  if(req.url==='/repos/fixture/repository/pulls/7'){res.end(JSON.stringify({number:7,state:'open',head:{sha:head,ref:'review-branch',repo:{id:repositoryId,full_name:'fixture/repository'}},base:{repo:{id:99,full_name:'fixture/repository'}}}));return;}
  if(req.url?.startsWith('/repos/fixture/repository/contents/src/file.ts?ref=')){const bytes=Buffer.from(blobText);res.end(JSON.stringify({type:'file',encoding:'base64',path:'src/file.ts',size:bytes.length,sha:blobShaOverride??createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),content:bytes.toString('base64')}));return;}
  res.writeHead(404);res.end('{}');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as import('node:net').AddressInfo).port;const fetchImpl:typeof fetch=async(input,init)=>{const url=new URL(String(input));expect(url.origin).toBe('https://api.github.com');return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`,init);};
 return {fetchImpl,seen,setHead:(v:string)=>{head=v;},setHeadRepository:(v:number)=>{repositoryId=v;},corruptBlob:()=>{blobShaOverride='0'.repeat(40);},close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
async function findingFixture(){
 const {admission}=await admittedExecution(),binding={companyId,agentId,runId,issueId,projectId},store=createNativeReviewerGitHubStore(db);

 const scope={binding,agentName:'One Reviewer',role:{enabled:true,configuredBy:'board' as const,revision:'1',projectIds:[projectId],repositoryIds:['99']},assignment:{kind:'native_completion_review' as const,id:nativeReviewerAssignmentId(admission.record.assignment),current:true,reviewerAgentId:agentId,builderAgentId:admission.record.assignment.builderAgentId},runtime:{filesystemQualified:true,rawCredentialExportDenied:true,hostCredentialFallbackDenied:true,trustKind:'standard' as const},repositoryId:'99',repository:'fixture/repository',pullNumber:7,headSha:'a'.repeat(40)};
 const original=await store.stage({company_id:companyId,agent_id:agentId,run_id:runId,issue_id:issueId,project_id:projectId,repository_id:'99',repository:'fixture/repository',pull_number:7,head_sha:'b'.repeat(40),action:'comment',idempotency_key:randomUUID(),request_hash:'f'.repeat(64),agent_name:'Name at finding',request_payload:{action:'comment',finding:{key:'finding-1',path:'src/file.ts',line:1,side:'RIGHT'}}});const claim=(await store.claim(original.id,companyId))!;
 await store.settle(original.id,companyId,'confirmed',{operationId:original.id,action:'comment',companyId,agentId,agentNameAtTime:'Name at finding',runId,issueId,projectId,repositoryId:'99',repository:'fixture/repository',pullNumber:7,headSha:'b'.repeat(40),commentId:'123',findingKey:'finding-1',url:'https://github.com/fixture/repository/pull/7#discussion_r123'},null,claim.claim_token);
 return {binding,store,scope,findingOperationId:original.id};
}
describe('native corresponding-fix evidence producer + immutable document-revision ownership',()=>{
 it('records exact server-fetched bytes + Reviewer judgment, replays same evidence and proves native run/agent ownership',async()=>{const f=await findingFixture(),provider=await providerFixture();try{const producer=createReviewerFixVerificationProducer(db,{authorize:async()=>f.scope,store:f.store,resolvePrivateToken:async()=> 'synthetic-fixture-only',fetchImpl:provider.fetchImpl});const result=await producer(f.binding,{findingOperationId:f.findingOperationId,explanation:'I checked the corresponding fix against this candidate.'});expect((await loadNativeReviewerFixVerification(db,f.binding,result.verificationEvidenceId))?.findingOperationId).toBe(f.findingOperationId);expect(await producer(f.binding,{findingOperationId:f.findingOperationId,explanation:'I checked the corresponding fix against this candidate.'})).toEqual(result);expect(await loadNativeReviewerFixVerification(db,{...f.binding,agentId:randomUUID()},result.verificationEvidenceId)).toBeNull();expect(provider.seen.every(value=>value.startsWith('GET '))).toBe(true);}finally{await provider.close();}});
 it.each(['foreign_agent_finding','provider_blob_mismatch','head_changed','caller_path_override'])('refuses %s without producing evidence',async kind=>{const f=await findingFixture(),provider=await providerFixture();try{if(kind==='foreign_agent_finding')await pool.query("UPDATE reviewer_github_operations SET agent_id=$1,status='rejected',receipt=NULL WHERE id=$2",[randomUUID(),f.findingOperationId]);if(kind==='provider_blob_mismatch')provider.corruptBlob();if(kind==='head_changed')provider.setHead('b'.repeat(40));const producer=createReviewerFixVerificationProducer(db,{authorize:async()=>f.scope,store:f.store,resolvePrivateToken:async()=> 'synthetic-fixture-only',fetchImpl:provider.fetchImpl});await expect(producer(f.binding,{findingOperationId:f.findingOperationId,explanation:'Verified',...(kind==='caller_path_override'?{path:'arbitrary/secret'}:{})})).rejects.toThrow();}finally{await provider.close();}});
});

