import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, completionContracts, createDb,
  heartbeatRuns, issueComments, issueExecutionDecisions, issueRecoveryActions, issueRelations,
  issueReviewCycleBudgets, issues, migratePostgresIfEmpty, nativeRunFinalizations, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { issueExecutionStateSchema } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";
import { escalateExhaustedIssueReviewPathRecovery } from "../services/recovery/review-path-recovery-escalation.js";
import { issueService } from "../services/issues.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { createReviewCycleBudget } from "../services/total-review-budget.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

// Actual native migrated PostgreSQL + recovery consumer/setter/ledger. Only
// dispatch is controlled; no provider, runner or network service is started.
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));
let db: ReturnType<typeof createDb>;
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let failed=false;
beforeAll(async()=>{
 try {
  const url=process.env.PAPERCLIP_RECOVERY_CALLER_TEST_DATABASE_URL;
  if(url !== undefined){
   if(!/^pc_recovery_callers_[a-f0-9]+_test$/.test(new URL(url).pathname.slice(1)))throw Error('new_synthetic_recovery_database_required');
   await migratePostgresIfEmpty(url);
   db=createDb(url,{maxConnections:3,applicationName:'native-recovery-caller-test'});
  }else{
   temporary=await startEmbeddedPostgresTestDatabase('paperclip-native-recovery-callers-');
   db=createDb(temporary.connectionString,{maxConnections:3,applicationName:'native-recovery-caller-test'});
  }
 }catch(error){failed=true;throw error;}
},90000);
afterEach(context=>{if(context.task.result?.state==='fail')failed=true;});
afterAll(async()=>{
 await db?.$client.end({timeout:5});
 // Only the native helper's NEW owned embedded fixture may be cleaned after
 // success. Supplied databases and failed synthetic state are always retained.
 if(temporary && !failed)await temporary.cleanup();
});
async function seed(total5=true){
 const now=new Date(),userId='recovery-human-'+randomUUID();
 await db.insert(authUsers).values({id:userId,name:'Synthetic owner',email:userId+'@example.test',createdAt:now,updatedAt:now});
 const [company]=await db.insert(companies).values({name:'Synthetic recovery callers',issuePrefix:'RC'+randomUUID().replaceAll('-','').slice(0,8),requireBoardApprovalForNewAgents:false}).returning();
 await db.insert(companyMemberships).values({companyId:company.id,principalType:'user',principalId:userId,status:'active',membershipRole:'owner'});
 const [builder,reviewer]=await db.insert(agents).values(['Builder','Reviewer'].map(name=>({companyId:company.id,name,role:'engineer',status:'idle',adapterType:'process',adapterConfig:{},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true}}}))).returning();
 const policy=total5?{totalReviewCycles:5,stages:[{id:randomUUID(),type:'review',participants:[{id:randomUUID(),type:'agent',agentId:reviewer.id}]},{id:randomUUID(),type:'approval',participants:[{id:randomUUID(),type:'user',userId}]}]}:null;
 const [issue]=await db.insert(issues).values({companyId:company.id,title:'Synthetic retained request',status:'in_progress',assigneeAgentId:builder.id,responsibleUserId:userId,executionPolicy:policy,issueNumber:1,identifier:company.issuePrefix+'-1'}).returning();
 const [run]=await db.insert(heartbeatRuns).values({companyId:company.id,agentId:builder.id,issueId:issue.id,nativeIssueId:issue.id,scopeKind:'issue',status:'failed',error:'Original synthetic bootstrap error',errorCode:'adapter_failed',startedAt:now,finishedAt:now,contextSnapshot:{issueId:issue.id},resultJson:{executionRecovery:{kind:'bootstrap',providerWorkStarted:false,reason:'fixture_pre_provider'}}}).returning();
 if(total5)await db.insert(issueReviewCycleBudgets).values({companyId:company.id,issueId:issue.id,ledger:createReviewCycleBudget(company.id,issue.id)});
 const read=async()=>(await db.select().from(issues).where(eq(issues.id,issue.id)))[0];
 const budget=async()=>(await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId,issue.id)))[0];
 const actions=()=>db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId,issue.id));
 const enqueue=vi.fn(async()=>null),recovery=recoveryService(db,{enqueueWakeup:enqueue});
 const escalate=async(latestRun:typeof run|null=run)=>recovery.escalateStrandedAssignedIssue({issue:await read(),previousStatus:'in_progress',latestRun,comment:'Original source requires attention.'});
 return {company,userId,builder,reviewer,policy,issue,run,read,budget,actions,enqueue,recovery,escalate};
}
function pending(f:Awaited<ReturnType<typeof seed>>){return issueExecutionStateSchema.parse({status:'pending',currentStageId:f.policy!.stages[0].id,currentStageIndex:0,currentStageType:'review',currentParticipant:{type:'agent',agentId:f.reviewer.id,userId:null},returnAssignee:{type:'agent',agentId:f.builder.id,userId:null},completedStageIds:[],lastDecisionId:null,lastDecisionOutcome:null,totalReviewBudgetHold:false,totalReviewCyclesUsed:0,totalReviewCycleAllowance:5});}
async function nativeBlocker(f:Awaited<ReturnType<typeof seed>>){
 const contractId=randomUUID(),runnerInstanceId=randomUUID(),commentId=randomUUID();
 await db.insert(issueComments).values({id:commentId,companyId:f.company.id,issueId:f.issue.id,authorType:'user',authorUserId:f.userId,body:'Retain this exact current request.'});
 await db.insert(completionContracts).values({id:contractId,companyId:f.company.id,issueId:f.issue.id,revision:1,schemaVersion:'paperclip.completion-contract.v1',policyVersion:'phase6-v3',risk:'low',completionAuthority:'agent_claim_policy',incompleteCriteriaPolicy:'preserve_non_terminal',contractJson:{revision:'1',objective:'Current request',criteria:[{id:'objective',requirement:'Retain request'}]},canonicalSha256:'synthetic-'+f.run.id,createdByActorType:'system',createdByActorId:'test'});
 const context={issueId:f.issue.id,taskId:f.issue.id,wakeReason:'issue_commented',wakeCommentId:commentId,wakeCommentIds:[commentId]};
 await db.update(heartbeatRuns).set({status:'succeeded',runtimeMode:'native',nativeSessionId:f.run.id,runnerInstanceId,completionContractId:contractId,completionContractSha256:'synthetic-'+f.run.id,contextSnapshot:context,livenessState:'advanced'}).where(eq(heartbeatRuns.id,f.run.id));
 const port=new PaperclipControlPlanePort(db,{companyId:f.company.id,issueId:f.issue.id,runId:f.run.id,agentId:f.builder.id,sessionId:f.run.id,completionContractId:contractId,completionContractSha256:'synthetic-'+f.run.id,sourceInstanceId:runnerInstanceId,controlPlaneSourceInstanceId:'synthetic-control-'+f.run.id});
 await port.completeRun({result:{schema:'paperclip.run_result.v1',reportedWorkDisposition:'blocked',summary:'Current request needs an owner decision.',blocker:{scope:'current_track',owner:{kind:'system',name:'Fixture'},reasonCode:'permission_denied',unblockAction:'Grant current request access, then explicitly retry.'},completionClaim:{contractRevision:'1',objectiveSatisfied:false,criteria:[{criterionId:'objective',status:'not_satisfied',evidenceRefs:[]}],remainingWork:[{description:'Current request',blocksCompletion:true}]},evidence:[],verification:[],attentionRequests:[],artifacts:[]},terminal:{schema:'paperclip.prp.terminal.v1',runTerminalState:'succeeded',turnTerminalState:'completed',reportedWorkDisposition:'blocked'}});
 await db.update(nativeRunFinalizations).set({phase:'committed'}).where(eq(nativeRunFinalizations.runId,f.run.id));
 return port;
}
describe('actual native recovery consumers preserve total-five ownership',()=>{
 it('commits an authenticated real stopped-run escalation with unchanged ledger and original failure',async()=>{
  const f=await seed(),before=await f.budget();
  const [blocker]=await db.insert(issues).values({companyId:f.company.id,title:'Retained blocker',status:'todo'}).returning();
  await db.insert(issueRelations).values({companyId:f.company.id,issueId:blocker.id,relatedIssueId:f.issue.id,type:'blocks'});
  expect((await f.escalate())?.status).toBe('blocked');
  expect((await f.read()).assigneeAgentId).toBe(f.builder.id);expect((await f.budget()).ledger).toEqual(before.ledger);
  expect((await f.actions())[0]).toMatchObject({status:'active',ownerType:'board'});
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.run.id)))[0].error).toBe('Original synthetic bootstrap error');
  expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId,f.issue.id))).toHaveLength(1);
  expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,f.issue.id))).toEqual([]);expect(f.enqueue).not.toHaveBeenCalled();
 });
 it('default-off stranded escalation retains native behavior without requiring a fabricated run',async()=>{
  const f=await seed(false);expect((await f.escalate(null))?.status).toBe('blocked');expect((await f.actions())[0].status).toBe('active');expect(f.enqueue).not.toHaveBeenCalled();
 });
 it('pending review refuses projection while retaining incident/evidence and emitting no false blocked notice',async()=>{
  const f=await seed();await db.update(issues).set({executionState:pending(f)}).where(eq(issues.id,f.issue.id));
  const before=await f.read(),budget=await f.budget();expect(await f.escalate()).toBeNull();expect(await f.read()).toEqual(before);expect((await f.budget()).ledger).toEqual(budget.ledger);
  expect((await f.actions())[0]).toMatchObject({status:'active',evidence:expect.objectContaining({nativeIssueProjection:{kind:'deferred',code:'native_operational_review_pending',projectionApplied:false,sourceRunId:f.run.id}})});
  expect(await db.select().from(issueComments).where(eq(issueComments.issueId,f.issue.id))).toEqual([]);
  expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.issue.id),eq(activityLog.action,'issue.native_recovery_projection_deferred')))).toHaveLength(1);
 });
 it('missing stopped-source proof retains a named incident and does not synthesize authority',async()=>{
  const f=await seed(),before=await f.read();expect(await f.escalate(null)).toBeNull();expect(await f.read()).toEqual(before);
  expect((await f.actions())[0].evidence).toMatchObject({nativeIssueProjection:{code:'native_recovery_source_proof_unavailable',projectionApplied:false,sourceRunId:null}});
 });
 it('a foreign actual run cannot authorize the issue projection',async()=>{
  const f=await seed(),other=await seed(),before=await f.read();expect(await f.escalate(other.run)).toBeNull();expect(await f.read()).toEqual(before);
  expect((await f.actions())[0].evidence).toMatchObject({nativeIssueProjection:{code:'native_recovery_source_proof_unavailable'}});
 });
 it('cannot block a replacement owner from a same-issue previous-assignee run with cleared pointers',async()=>{
  const f=await seed();await db.update(issues).set({assigneeAgentId:f.reviewer.id,assigneeUserId:null,executionRunId:null,checkoutRunId:null}).where(eq(issues.id,f.issue.id));
  const before=await f.read(),budget=await f.budget();expect(await f.escalate(f.run)).toBeNull();
  expect(await f.read()).toEqual(before);expect((await f.budget()).ledger).toEqual(budget.ledger);
  expect((await f.actions())[0]).toMatchObject({status:'active',evidence:expect.objectContaining({nativeIssueProjection:{code:'native_recovery_source_proof_unavailable',projectionApplied:false,kind:'deferred',sourceRunId:f.run.id}})});
  expect(await db.select().from(issueComments).where(eq(issueComments.issueId,f.issue.id))).toEqual([]);expect(f.enqueue).not.toHaveBeenCalled();
 });
 it.each(['unassigned','human'] as const)('requires a current agent owner rather than %s ownership',async owner=>{
  const f=await seed();await db.update(issues).set({assigneeAgentId:null,assigneeUserId:owner==='human'?f.userId:null,executionRunId:null,checkoutRunId:null}).where(eq(issues.id,f.issue.id));
  const before=await f.read();expect(await f.escalate(f.run)).toBeNull();expect(await f.read()).toEqual(before);
  expect((await f.actions())[0].evidence).toMatchObject({nativeIssueProjection:{code:'native_recovery_source_proof_unavailable',projectionApplied:false}});
 });
 it('refuses stale source status and a superseded same-owner source under the task lock',async()=>{
  const f=await seed();await db.update(heartbeatRuns).set({status:'succeeded'}).where(eq(heartbeatRuns.id,f.run.id));
  const before=await f.read();expect(await f.escalate(f.run)).toBeNull();expect(await f.read()).toEqual(before);
  const [fresh]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.run.id));
  await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.builder.id,issueId:f.issue.id,nativeIssueId:f.issue.id,status:'failed',scopeKind:'issue',contextSnapshot:{issueId:f.issue.id},createdAt:new Date(f.run.createdAt.getTime()+1000),finishedAt:new Date()});
  expect(await f.escalate(fresh)).toBeNull();expect(await f.read()).toEqual(before);
  expect((await f.actions()).every(action=>(action.evidence as any)?.nativeIssueProjection?.code==='native_recovery_source_proof_unavailable')).toBe(true);
 });
 it('checks actual xmin source CAS while accepting an unchanged current native source snapshot',async()=>{
  const f=await seed();
  const [row]=await db.execute<{version:string}>(sql`select xmin::text as version from heartbeat_runs where id=${f.run.id}`);
  const stale={...f.run,rowVersion:row.version};
  await db.update(heartbeatRuns).set({error:'Retained newer diagnostic, same status'}).where(eq(heartbeatRuns.id,f.run.id));
  const before=await f.read();expect(await f.escalate(stale)).toBeNull();expect(await f.read()).toEqual(before);
  expect((await f.actions())[0].evidence).toMatchObject({nativeIssueProjection:{code:'native_recovery_source_proof_unavailable'}});
  const g=await seed();
  const [current]=await db.execute<{version:string}>(sql`select xmin::text as version from heartbeat_runs where id=${g.run.id}`);
  const unchanged={...g.run,rowVersion:current.version};
  expect((await g.escalate(unchanged))?.status).toBe('blocked');
 });
 it('does not resolve a selected recovery incident when healthy-child projection is explicitly deferred',async()=>{
  const f=await seed();
  const action=await issueRecoveryActionService(db).upsertSourceScoped({companyId:f.company.id,sourceIssueId:f.issue.id,kind:'stranded_assigned_issue',ownerType:'board',returnOwnerAgentId:f.builder.id,cause:'stranded_assigned_issue',fingerprint:'healthy-child-'+f.issue.id,evidence:{sourceRunId:f.run.id},nextAction:'Inspect retained source.',wakePolicy:{type:'board_escalation'}});
  const [child]=await db.insert(issues).values({companyId:f.company.id,title:'Actual active child fixture',parentId:f.issue.id,status:'in_progress',assigneeAgentId:f.builder.id}).returning();
  const [run]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.builder.id,issueId:child.id,nativeIssueId:child.id,status:'running',scopeKind:'issue',contextSnapshot:{issueId:child.id}}).returning();
  await db.update(issues).set({executionRunId:run.id,checkoutRunId:run.id}).where(eq(issues.id,child.id));
  const before=await f.read(),result=await f.recovery.reconcileActiveRecoveryActions({companyId:f.company.id});
  expect(result.resolved).toBe(0);expect(result.skipped).toBeGreaterThan(0);expect(await f.read()).toEqual(before);
  expect((await f.actions()).find(row=>row.id===action.id)).toMatchObject({status:'active',outcome:null});expect(f.enqueue).not.toHaveBeenCalled();
 });
 it('does not assign an orphan total-five blocker from heuristic creator evidence',async()=>{
  const f=await seed();await db.update(issues).set({status:'blocked'}).where(eq(issues.id,f.issue.id));
  const [orphan]=await db.insert(issues).values({companyId:f.company.id,title:'Selected orphan',status:'todo',createdByAgentId:f.builder.id,executionPolicy:f.policy}).returning();
  await db.insert(issueRelations).values({companyId:f.company.id,issueId:orphan.id,relatedIssueId:f.issue.id,type:'blocks'});
  const before=(await db.select().from(issues).where(eq(issues.id,orphan.id)))[0];
  const result=await f.recovery.reconcileUnassignedBlockingIssues({companyId:f.company.id});
  expect(result.assigned).toBe(0);expect(result.skipped).toBeGreaterThan(0);
  expect((await db.select().from(issues).where(eq(issues.id,orphan.id)))[0]).toEqual(before);expect(f.enqueue).not.toHaveBeenCalled();
 });
 it('accepted native current-request blocker joins result/contract and projects descriptor through the locked consumer',async()=>{
  const f=await seed();await nativeBlocker(f);const before=await f.budget();
  const result=await f.recovery.reconcileStrandedAssignedIssues({companyId:f.company.id,issueId:f.issue.id,skipRelatedRecovery:true});
  expect(result.escalated).toBe(1);expect(await f.read()).toMatchObject({status:'blocked',assigneeAgentId:f.builder.id,unblockDescriptor:{owner:'board',action:'Grant current request access, then explicitly retry.'}});
  expect((await f.budget()).ledger).toEqual(before.ledger);expect(f.enqueue).not.toHaveBeenCalled();
  expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,f.issue.id))).toEqual([]);
 });
 it('accepted-blocker notice failure rolls back the helper status and descriptor together',async()=>{
  const f=await seed();await nativeBlocker(f);const before=await f.read(),budget=await f.budget();
  const name='fixture_recovery_'+f.issue.id.replaceAll('-','');
  await db.execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin if new.issue_id='${f.issue.id}'::uuid and new.author_type='system' then raise exception 'fixture_recovery_notice_failure'; end if; return new; end $$`));
  await db.execute(sql.raw(`create trigger ${name} before insert on issue_comments for each row execute function ${name}()`));
  await expect(f.recovery.reconcileStrandedAssignedIssues({companyId:f.company.id,issueId:f.issue.id,skipRelatedRecovery:true})).rejects.toThrow();
  expect(await f.read()).toEqual(before);expect((await f.budget()).ledger).toEqual(budget.ledger);
  expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.issue.id),eq(activityLog.action,'issue.native_operational_projection')))).toEqual([]);
 });
 it('an in-place historical recovery issue with selected review remains untouched pending its proper owner',async()=>{
  const f=await seed();await db.update(issues).set({originKind:'stranded_issue_recovery',originId:randomUUID()}).where(eq(issues.id,f.issue.id));
  const before=await f.read();expect(await f.recovery.escalateStrandedRecoveryIssueInPlace({issue:before,previousStatus:'in_progress',latestRun:f.run})).toBeNull();expect(await f.read()).toEqual(before);
 });
 it('review-path exhaustion keeps total-five stage and board incident instead of a false blocked notice',async()=>{
  const f=await seed();await db.update(issues).set({status:'in_review'}).where(eq(issues.id,f.issue.id));
  const context={issueId:f.issue.id,wakeReason:'issue_review_path_lost',sourceRunId:randomUUID(),consumedPathRef:'fixture-consumed'};
  const [run]=await db.update(heartbeatRuns).set({contextSnapshot:context,status:'failed'}).where(eq(heartbeatRuns.id,f.run.id)).returning();
  const before=await f.read();const action=await escalateExhaustedIssueReviewPathRecovery(db,{run,issueId:f.issue.id});
  expect(action).not.toBeNull();expect(await f.read()).toEqual(before);expect((await f.actions())[0].status).toBe('active');
  expect(await db.select().from(issueComments).where(eq(issueComments.issueId,f.issue.id))).toEqual([]);
  expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.issue.id),eq(activityLog.action,'issue.review_path_recovery_projection_deferred')))).toHaveLength(1);
 });
});
