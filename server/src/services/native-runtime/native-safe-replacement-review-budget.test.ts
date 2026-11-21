import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issueExecutionDecisions, issueRecoveryActions, issueReviewCycleBudgets,
  issues, migratePostgresIfEmpty, nativeRunFinalizations, startEmbeddedPostgresTestDatabase } from '@paperclipai/db';
import { mutateNativeOperationalIssue } from '../native-operational-issue-mutation.js';
import { issueRecoveryActionService } from '../issue-recovery-actions.js';
import { admitReviewCycle, createReviewCycleBudget } from '../total-review-budget.js';
import { invalidateNativeReplacementDiscovery, reconcileSafeNativeReplacements } from './native-safe-replacement.js';

// Actual PostgreSQL, failed-run/hold records, operational helper, successor and
// wake producer. The stopped-session/retire proof is CONTROLLED, not OS/provider
// termination evidence. No adapter, provider, process kill or network is invoked.
vi.mock('../issue-assignment-wakeup.js',()=>({queueIssueAssignmentWakeup:vi.fn()}));
let db:ReturnType<typeof createDb>;
let temporary:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>|undefined;
let failed=false;
beforeAll(async()=>{
 try{
  const url=process.env.PAPERCLIP_SAFE_REPLACEMENT_CONSUMER_TEST_DATABASE_URL;
  if(url!==undefined){
   if(!/^pc_safe_replacement_[a-f0-9]+_test$/.test(new URL(url).pathname.slice(1)))throw Error('new_synthetic_replacement_database_required');
   await migratePostgresIfEmpty(url);db=createDb(url,{maxConnections:3,applicationName:'safe-replacement-budget-consumer-test'});
  }else{
   temporary=await startEmbeddedPostgresTestDatabase('paperclip-safe-replacement-budget-');
   db=createDb(temporary.connectionString,{maxConnections:3,applicationName:'safe-replacement-budget-consumer-test'});
  }
 }catch(error){failed=true;throw error;}
},90000);
afterEach(context=>{if(context.task.result?.state==='fail')failed=true;});
afterAll(async()=>{await db?.$client.end({timeout:5});if(temporary&&!failed)await temporary.cleanup();});

async function seed(total5=true){
 const workspace=await mkdtemp(join(tmpdir(),'safe-replacement-budget-'));
 const canary=join(workspace,'saved.txt'),saved='Synthetic work retained before interruption.\n';await writeFile(canary,saved,{mode:0o600,flag:'wx'});
 const now=new Date(),userId='replacement-owner-'+randomUUID();
 await db.insert(authUsers).values({id:userId,name:'Synthetic owner',email:userId+'@example.test',createdAt:now,updatedAt:now});
 const [company]=await db.insert(companies).values({name:'Synthetic replacement',issuePrefix:'SR'+randomUUID().replaceAll('-','').slice(0,8)}).returning();
 await db.insert(companyMemberships).values({companyId:company.id,principalType:'user',principalId:userId,status:'active',membershipRole:'owner'});
 const [agent,reviewer]=await db.insert(agents).values(['Builder','Reviewer'].map(name=>({companyId:company.id,name,role:'engineer',status:'idle',adapterType:'paperclip_runner',adapterConfig:{provider:'codex',homeMode:'isolated'},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true}}}))).returning();
 const policy=total5?{totalReviewCycles:5,stages:[{id:randomUUID(),type:'review',participants:[{id:randomUUID(),type:'agent',agentId:reviewer.id}]},{id:randomUUID(),type:'approval',participants:[{id:randomUUID(),type:'user',userId}]}]}:null;
 const [issue]=await db.insert(issues).values({companyId:company.id,title:'Retain interrupted work',status:'in_progress',assigneeAgentId:agent.id,responsibleUserId:userId,executionPolicy:policy}).returning();
 if(total5)await db.insert(issueReviewCycleBudgets).values({companyId:company.id,issueId:issue.id,ledger:createReviewCycleBudget(company.id,issue.id)});
 const context={issueId:issue.id,preservedRecoveryContext:true,fixtureHistory:'retained',paperclipWake:{comments:[{id:'stale-consumed-comment'}]},paperclipWakeComment:{id:'stale-consumed-comment'},paperclipTaskMarkdown:'historical task',paperclipTurnContext:{version:1,assignment:{owner:'task_markdown'},events:{owner:'wake_prompt',comments:[{id:'stale-consumed-comment'}]}}};
 const [run]=await db.insert(heartbeatRuns).values({companyId:company.id,agentId:agent.id,issueId:issue.id,nativeIssueId:issue.id,scopeKind:'issue',runtimeMode:'native',status:'failed',error:'Original synthetic provider interruption',errorCode:'adapter_failed',finishedAt:now,responsibleUserId:userId,contextSnapshot:context,runnerProfileJson:{recoveryEventInventoryVersion:1,nativeExecutionInput:{provider:{kind:'codex'},workspace:{cwd:workspace}}}}).returning();
 // Nonempty historical accounting DATA is produced through the native pure
 // ledger API, so an accidental reset is observable. It is not a live verdict.
 if(total5){
  const ledger=admitReviewCycle(createReviewCycleBudget(company.id,issue.id),{id:randomUUID(),companyId:company.id,issueId:issue.id,builderAgentId:agent.id,builderRunId:run.id,candidateId:'synthetic-historical-candidate',kind:'normal',scopeId:null},now.toISOString()).budget;
  await db.update(issueReviewCycleBudgets).set({ledger}).where(eq(issueReviewCycleBudgets.issueId,issue.id));
 }
 const [coordinator]=await db.insert(nativeRunFinalizations).values({runId:run.id,companyId:company.id,issueId:issue.id,phase:'terminal_failure',attempt:2,failureCode:'native_session_cleanup_quarantined',failureDetail:{originalFailureCode:'synthetic_stopped_session',fixtureEvidence:'retained'}}).returning();
 const read=async()=>(await db.select().from(issues).where(eq(issues.id,issue.id)))[0];
 // The same real helper produces the selected failure block. Stop proof itself
 // remains a separate explicitly controlled seam in the recovery call below.
 const hold=await db.transaction(async tx=>{
  const projection=await mutateNativeOperationalIssue(tx,{companyId:company.id,issueId:issue.id,expected:await read(),operation:{kind:'failure_block',runId:run.id,target:'blocked'}},[],[]);
  if(!('issue' in projection))throw Error('fixture_native_block_failed');
  return issueRecoveryActionService(tx as unknown as typeof db).upsertSourceScoped({companyId:company.id,sourceIssueId:issue.id,kind:'active_run_watchdog',cause:coordinator.failureCode!,fingerprint:run.id,ownerType:'board',returnOwnerAgentId:agent.id,evidence:{runId:run.id,nativeFailureBlock:{runId:run.id,statusVersion:projection.issue.statusVersion},fixtureFailureEvidence:'retain'},nextAction:'Inspect the stopped execution before continuing.'});
 });
 const budget=async()=>(await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId,issue.id)))[0];
 const currentHold=async()=>(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,hold.id)))[0];
 const currentRun=async()=>(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id)))[0];
 const currentCoordinator=async()=>(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,run.id)))[0];
 const successors=()=>db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,run.id));
 const retire=vi.fn(()=>true);
 const verifyStoppedSession=vi.fn(async(candidate:typeof heartbeatRuns.$inferSelect)=>candidate.id===run.id?{evidence:{controlledStoppedSession:true},retire}:null);
 const sweep=async(options:{failpoint?:(point:'successor_inserted'|'lineage_committed')=>void}={})=>{invalidateNativeReplacementDiscovery(db);return reconcileSafeNativeReplacements(db,new Date(),{verifyStoppedSession,...options});};
 return {company,agent,issue,run,hold,workspace,canary,saved,read,budget,currentHold,currentRun,currentCoordinator,successors,retire,verifyStoppedSession,sweep};
}

describe('native safe replacement consumes owned review-budget failure blocks',()=>{
 it.each([true,false])('schedules exactly one real successor while retaining work and accounting with total-five=%s',async enabled=>{
  const f=await seed(enabled),before=await f.budget();
  expect((await f.sweep()).scheduled).toBe(1);expect((await f.sweep()).scheduled).toBe(0);
  const successors=await f.successors();expect(successors).toHaveLength(1);
  expect(await f.read()).toMatchObject({status:'in_progress',assigneeAgentId:f.agent.id,executionRunId:null,checkoutRunId:null});
  if(enabled)expect((await f.budget()).ledger).toEqual(before.ledger);else expect(await f.budget()).toBeUndefined();
  expect(successors[0]).toMatchObject({status:'scheduled_retry',retryOfRunId:f.run.id,responsibleUserId:f.run.responsibleUserId});
  expect(successors[0].contextSnapshot).toMatchObject({issueId:f.issue.id,preservedRecoveryContext:true,fixtureHistory:'retained',retryOfRunId:f.run.id,forceFreshSession:true});
  for(const key of ['paperclipWake','paperclipWakeComment','paperclipTaskMarkdown','paperclipTurnContext'])expect(successors[0].contextSnapshot).not.toHaveProperty(key);
  expect(await readFile(f.canary,'utf8')).toBe(f.saved);expect(f.retire).toHaveBeenCalledOnce();
  expect(await f.currentHold()).toMatchObject({status:'resolved',outcome:'handed_back',evidence:expect.objectContaining({verifiedReplacement:expect.objectContaining({successorRunId:successors[0].id}),fixtureFailureEvidence:'retain'})});
  expect((await f.currentCoordinator()).failureDetail).toMatchObject({originalFailureCode:'synthetic_stopped_session',fixtureEvidence:'retained',successorRunId:successors[0].id});
  expect((await f.currentRun()).error).toBe('Original synthetic provider interruption');
  expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,f.issue.id))).toEqual([]);
  const [wake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId,successors[0].id));expect(wake).toMatchObject({status:'queued',reason:'native_safe_replacement'});
 });
 it.each(['wrong-run','stale-version','wrong-cause'] as const)('refuses an owned-failure receipt mismatch (%s) without a successor',async mismatch=>{
  const f=await seed(),hold=await f.currentHold();
  await db.update(issueRecoveryActions).set(mismatch==='wrong-cause'?{cause:'unrelated_failure'}:{evidence:{...hold.evidence,nativeFailureBlock:{runId:mismatch==='wrong-run'?randomUUID():f.run.id,statusVersion:mismatch==='stale-version'?(await f.read()).statusVersion+1:(await f.read()).statusVersion}}}).where(eq(issueRecoveryActions.id,hold.id));
  const task=await f.read(),budget=await f.budget(),retainedHold=await f.currentHold(),run=await f.currentRun(),coordinator=await f.currentCoordinator();
  expect((await f.sweep()).scheduled).toBe(0);expect(await f.successors()).toEqual([]);expect(f.retire).not.toHaveBeenCalled();
  expect(await f.read()).toEqual(task);expect(await f.budget()).toEqual(budget);expect(await f.currentHold()).toEqual(retainedHold);expect(await f.currentRun()).toEqual(run);expect(await f.currentCoordinator()).toEqual(coordinator);expect(await readFile(f.canary,'utf8')).toBe(f.saved);
 });
 it('rolls back restored status, successor and hold retirement together after a native successor-insert fault',async()=>{
  const f=await seed(),task=await f.read(),budget=await f.budget(),hold=await f.currentHold(),run=await f.currentRun(),coordinator=await f.currentCoordinator();
  const priorAudit=await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.issue.id),eq(activityLog.action,'issue.native_operational_projection')));
  await expect(f.sweep({failpoint:point=>{if(point==='successor_inserted')throw Error('synthetic_successor_commit_fault');}})).rejects.toThrow('synthetic_successor_commit_fault');
  expect(await f.successors()).toEqual([]);expect(await f.read()).toEqual(task);expect(await f.budget()).toEqual(budget);expect(await f.currentHold()).toEqual(hold);expect(await f.currentRun()).toEqual(run);expect(await f.currentCoordinator()).toEqual(coordinator);expect(await readFile(f.canary,'utf8')).toBe(f.saved);
  expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.issue.id),eq(activityLog.action,'issue.native_operational_projection')))).toEqual(priorAudit);
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.company.id))).toEqual([]);
 });
});
