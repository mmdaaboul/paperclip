import { spawn } from "node:child_process";
import { once } from "node:events";
import { reviewerNativeTestDatabase } from "./helpers/reviewer-native-database.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns,
  issueExecutionDecisions, issueReviewCycleBudgets, issues, completionContracts, nativeRunResults, nativeRunFinalizations, workAssessments, statusDecisions, statusDecisionEffects, agentWakeupRequests, issueRecoveryActions, projects, projectWorkspaces, executionWorkspaces, documents, documentRevisions, issueDocuments, issueScopedReviews, issueThreadInteractions, environmentLeases, heartbeatRunEvents, toolInvocations, workspaceOperations } from "@paperclipai/db";

// Provider dispatch and executor-stop confirmation are stubbed; native authorization,
// run rows, task state, ledger, decisions and audit use the real migrated database.
const executionFixture = vi.hoisted(() => ({ rejectStop:false,suppressStopProof:false,loseStopReply:false,realWake:false,holdTaskRetryNudge:false }));
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async (loadActual) => {
  const actual = await loadActual<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
    const service = actual.heartbeatService(...args);
    return { ...service, resumeTaskRetry: vi.fn(async (...retryArgs: Parameters<typeof service.resumeTaskRetry>) => {
      if (!executionFixture.holdTaskRetryNudge) return service.resumeTaskRetry(...retryArgs);
    }), wakeup: vi.fn(async (...wakeArgs: Parameters<typeof service.wakeup>) =>
      executionFixture.realWake ? service.wakeup(...wakeArgs) : null), cancelRun: vi.fn(async (runId: string, _reason: unknown, options: any) => {
      if (executionFixture.rejectStop) throw new Error("Unconfirmed executor stop in budget fixture");
      const database=args[0];
      const [stopped]=await database.update(heartbeatRuns).set({status:"cancelled",resultJson:options?.resultJson??{},finishedAt:new Date()}).where(eq(heartbeatRuns.id,runId)).returning();
      if(executionFixture.loseStopReply)throw new Error("Synthetic lost Stop reply before termination proof");
      if(!executionFixture.suppressStopProof) {
        if(stopped.runtimeMode==="native") {
          // Harmless local process + native physical receipt; no actual Runner,
          // provider, account or model runs. Stop remains a controlled seam.
          const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});await once(child,"spawn");
          const started=await (await import("../services/hot-restart.js")).readProcessStartedAt(child.pid!);
          child.kill("SIGTERM");await once(child,"exit");
          await database.transaction(async tx=>{
            const [withIdentity]=await tx.update(heartbeatRuns).set({processPid:child.pid!,processGroupId:child.pid!,processStartedAt:new Date(started!)}).where(eq(heartbeatRuns.id,runId)).returning();
            expect(await (await import("../services/native-local-process-stop.js")).recordNativeLocalProcessStop(tx as unknown as Db,withIdentity)).toBe(true);
            await tx.update(heartbeatRuns).set({processPid:null,processGroupId:null,processStartedAt:null}).where(eq(heartbeatRuns.id,runId));
          });
        }
        await database.update(issues).set({executionRunId:null,checkoutRunId:null,executionAgentNameKey:null,executionLockedAt:null}).where(eq(issues.executionRunId,runId));
      }
      return (await database.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId)))[0];
    }) };
  } };
});
type Db = ReturnType<typeof createDb>;
let db: Db;
let fixture: Pick<Awaited<ReturnType<typeof reviewerNativeTestDatabase>>, "end">;
async function appFor(actor: Express.Request["actor"], enforceReviewerBoundary=false) {
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  if(enforceReviewerBoundary)app.use((await import("../middleware/reviewer-role-boundary.js")).reviewerRoleBoundary(db));
  app.use("/api", issueRoutes(db, {} as never));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(err.status ?? 500).json({ error: err.message, details: err.details }));
  return app;
}
async function retryAppFor(userId: string, companyId: string) {
  const { agentRoutes } = await import("../routes/agents.js");
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", userId, companyIds: [companyId],
    source: "session", isInstanceAdmin: false }; next(); });
  app.use("/api", agentRoutes(db));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(err.status ?? 500).json({ error: err.message, details: err.details }));
  return app;
}
async function seed() {
  const userId = `budget-owner-${randomUUID()}`, now = new Date();
  await db.insert(authUsers).values({ id: userId, name: "Synthetic human", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
  const [company] = await db.insert(companies).values({ name: "Synthetic total-budget fixture", issuePrefix: `TB${randomUUID().replaceAll("-", "").slice(0,8)}` }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
  const [builder, reviewer] = await db.insert(agents).values(["Builder", "Only Reviewer"].map(name => ({ companyId: company.id, name, role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } }))).returning();
  const policy = { totalReviewCycles: 5, stages: [
    { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: reviewer.id }] },
    { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId }] },
  ] };
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Synthetic review-budget task", identifier: `${company.issuePrefix}-1`, status: "in_progress", assigneeAgentId: builder.id, responsibleUserId: userId, executionPolicy: policy }).returning();
  async function run(agentId: string, status = "succeeded") {
    return (await db.insert(heartbeatRuns).values({ companyId: company.id, agentId, issueId: issue.id, nativeIssueId: issue.id, scopeKind: "issue", status, responsibleUserId: userId, startedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning())[0];
  }
  const board = await appFor({ type: "board", userId, companyIds: [company.id], source: "session", isInstanceAdmin: false });
  const agentApp = async (agentId: string, runId: string) => appFor({ type: "agent", agentId, companyId: company.id, runId, onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }], source: "agent_jwt" });
  const read = async () => (await db.select().from(issues).where(eq(issues.id,issue.id)))[0];
  const ledger = async () => (await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId,issue.id)))[0]?.ledger as any;
  return { userId, company, builder, reviewer, issue, board, run, agentApp, read, ledger };
}
async function draftFixture(existing?:Awaited<ReturnType<typeof seed>>) {
  const f=existing??await seed(),runId=randomUUID();
  const observed=await f.read();
  await db.update(agents).set({adapterType:"paperclip_runner",adapterConfig:{provider:"codex",model:"gpt-6.1-sol"}}).where(eq(agents.companyId,f.company.id));
  const cwd=path.join(process.env.TMPDIR!,`scoped-workspace-${randomUUID()}`); await fs.mkdir(cwd,{recursive:true});
  const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Scoped document fixture",status:"in_progress"}).returning();
  const [primary]=await db.insert(projectWorkspaces).values({companyId:f.company.id,projectId:project.id,name:"Native scope anchor",cwd,isPrimary:true}).returning();
  const [workspace]=await db.insert(executionWorkspaces).values({companyId:f.company.id,projectId:project.id,projectWorkspaceId:primary.id,sourceIssueId:f.issue.id,mode:"isolated_workspace",strategyType:"git_worktree",providerType:"git_worktree",name:"Synthetic scoped candidate",cwd,providerRef:cwd,status:"active"}).returning();
  const {buildNativeExecutionInput}=await import("../services/native-runtime/native-execution-input.js");
  const {nativeRuntimeContextFixture}=await import("../services/native-runtime/runtime-context.test-fixture.js");
  const {canonicalNativeRuntimeContextDigest}=await import("../vendor/paperclip-runner/index.js");
  const runtime=nativeRuntimeContextFixture(); runtime.instructions.bundle.rootPath=cwd; runtime.aggregateDigest=canonicalNativeRuntimeContextDigest(runtime);
  const execution=buildNativeExecutionInput({companyId:f.company.id,agentId:f.builder.id,runId,issue:observed,taskPrompt:"Inspect the scoped native document fixture",workspace:{id:workspace.id,cwd,repoUrl:null,repoRef:null,branchName:null},normalizedSessionId:randomUUID(),provider:"codex",runtimeContext:runtime,
    completionContract:{id:randomUUID(),sha256:"a".repeat(64),schemaVersion:"paperclip.run-result.v1",contract:{revision:"1",objective:"Review the plan before remaining implementation",criteria:[{id:"plan",requirement:"Review exact plan revision"}]}}});
  await db.insert(heartbeatRuns).values({id:runId,companyId:f.company.id,agentId:f.builder.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"running",responsibleUserId:f.userId,runnerProfileJson:{nativeExecutionInput:execution},contextSnapshot:{issueId:f.issue.id}});
  await db.update(issues).set({executionWorkspaceId:workspace.id,projectId:project.id,projectWorkspaceId:primary.id,executionRunId:runId,checkoutRunId:runId}).where(eq(issues.id,f.issue.id));
  const [document]=await db.insert(documents).values({companyId:f.company.id,title:"Scoped native plan",format:"markdown",latestBody:"# Exact native plan\nRemaining implementation is unfinished."}).returning();
  const [revision]=await db.insert(documentRevisions).values({companyId:f.company.id,documentId:document.id,revisionNumber:1,title:document.title,format:document.format,body:document.latestBody,createdByAgentId:f.builder.id,createdByRunId:runId}).returning();
  await db.update(documents).set({latestRevisionId:revision.id}).where(eq(documents.id,document.id));
  await db.insert(issueDocuments).values({companyId:f.company.id,issueId:f.issue.id,documentId:document.id,key:"plan"});
  const app=await f.agentApp(f.builder.id,runId);
  const requestBody={id:randomUUID(),documentId:document.id,revisionId:revision.id,executionWorkspaceId:workspace.id,expectedStatusVersion:observed.statusVersion,purpose:"Check this plan before implementing",remainingWork:"Implement the remaining plan after partial review; final review still required."};
  return {...f,runId,workspace,document,revision,app,requestBody,execution};
}

async function admittedDraftFixture(existing?:Awaited<ReturnType<typeof seed>>) {
  const f=await draftFixture(existing);
  const prior=await f.read();
  const draft=await request(f.app).post(`/api/issues/${f.issue.id}/scoped-reviews`).send(f.requestBody); expect(draft.status,JSON.stringify(draft.body)).toBe(201);
  const resultId=randomUUID(),assessmentId=randomUUID(),contract=f.execution.completionContract;
  await db.update(heartbeatRuns).set({completionContractId:contract.id,completionContractSha256:contract.sha256}).where(eq(heartbeatRuns.id,f.runId));
  await db.insert(completionContracts).values({id:contract.id,companyId:f.company.id,issueId:f.issue.id,revision:1,schemaVersion:contract.schemaVersion,policyVersion:"phase6-v13",risk:"standard",completionAuthority:"server_arbiter",incompleteCriteriaPolicy:"preserve_non_terminal",contractJson:contract.contract as any,canonicalSha256:contract.sha256,createdByActorType:"system",createdByActorId:"native-scoped-fixture"});
  const {nativeSha256}=await import("../services/native-runtime/canonical.js");
  const resultJson={result:{reportedWorkDisposition:"needs_review",summary:"Review pinned document before remaining implementation",attentionRequests:[{kind:"review",ownerClass:"agent",targetAgentId:f.reviewer.id,summary:f.requestBody.purpose}]},terminal:{runTerminalState:"succeeded"}};
  await db.insert(nativeRunResults).values({id:resultId,companyId:f.company.id,issueId:f.issue.id,runId:f.runId,completionContractId:contract.id,serverFingerprint:nativeSha256(resultJson),schemaStatus:"accepted",resultJson,canonicalSha256:nativeSha256(resultJson)});
  await db.insert(workAssessments).values({id:assessmentId,companyId:f.company.id,issueId:f.issue.id,runId:f.runId,contractId:contract.id,resultId,triggerKind:"native_result",triggerActorCompanyId:f.company.id,priorIssueStatus:prior.status,priorStatusVersion:prior.statusVersion,priorDecisionId:prior.lastStatusDecisionId,policyVersion:"phase6-v13",assessmentJson:{reportedDisposition:"needs_review",attentionRequests:resultJson.result.attentionRequests},inputDigest:`scope:${resultId}`});
  await db.insert(nativeRunFinalizations).values({runId:f.runId,companyId:f.company.id,issueId:f.issue.id,phase:"assessing",resultId,assessmentId});
  const {commitNativeStatusDecision}=await import("../services/native-runtime/status-decision-committer.js");
  const input={db,companyId:f.company.id,issueId:f.issue.id,runId:f.runId,assessmentId,priorStatus:prior.status,priorStatusVersion:prior.statusVersion,priorDecisionId:prior.lastStatusDecisionId,
    decision:{policyVersion:"phase6-v13" as const,statusAction:"in_review" as const,toStatus:"in_review" as const,reasonCode:"actionable_attention_pending",unblockDescriptor:null,effects:[{kind:"bind_reviewer" as const,ownerAgentId:f.reviewer.id,prompt:f.requestBody.purpose}]}};
  const committed=await commitNativeStatusDecision(input);
  const scope=(await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.requestBody.id)))[0];
  return {...f,scope,input,committed,commitNativeStatusDecision};
}

async function reviewingDraftFixture(existing?:Awaited<ReturnType<typeof seed>>) {
  const f=await admittedDraftFixture(existing);
  const context={issueId:f.issue.id,nativeReviewInteractionId:f.scope.interactionId,nativeReviewDecisionId:f.scope.sourceDecisionId};
  const [reviewerRun]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.reviewer.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"running",responsibleUserId:f.userId,contextSnapshot:context}).returning();
  const {claimNativeReviewExecutionLock}=await import("../services/native-runtime/native-review-participant.js");
  expect(await claimNativeReviewExecutionLock(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:reviewerRun.id,contextSnapshot:context,agentNameKey:"one-scope-reviewer",claimedAt:new Date()})).toBe(true);
  return {...f,reviewerRun,reviewerApp:await f.agentApp(f.reviewer.id,reviewerRun.id)};
}

// A real native result/status commit creates the pending scope, review card and
// durable wake. Only provider completion/dispatch is simulated: this is the
// queue's persisted pre-resolution shape, not a pre-filled native run.
async function unresolvedScopedReviewerFixture() {
  const f = await admittedDraftFixture();
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.agentId, f.reviewer.id)));
  const context = (wake.payload as { _paperclipWakeContext: Record<string, unknown> })._paperclipWakeContext;
  expect(context).toMatchObject({ issueId: f.issue.id, nativeReviewInteractionId: f.scope.interactionId,
    nativeReviewDecisionId: f.scope.sourceDecisionId });
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
  await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.runId));
  await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issue.id));
  const [reviewerRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.reviewer.id,
    issueId: f.issue.id, scopeKind: "issue", status: "queued", responsibleUserId: f.userId,
    wakeupRequestId: wake.id, contextSnapshot: context }).returning();
  expect(reviewerRun).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null, nativeIssueId: null });
  const { claimNativeReviewExecutionLock } = await import("../services/native-runtime/native-review-participant.js");
  expect(await claimNativeReviewExecutionLock(db, { companyId: f.company.id, issueId: f.issue.id,
    agentId: f.reviewer.id, runId: reviewerRun.id, contextSnapshot: context,
    agentNameKey: "unresolved-scoped-reviewer", claimedAt: new Date() })).toBe(true);
  return { ...f, wake, context, reviewerRun };
}

async function nativeCandidate(existing?: Awaited<ReturnType<typeof seed>>, agentId?: string) {
    const f=existing ?? await seed(), prior=await f.read(), runId=randomUUID(),contractId=randomUUID(),resultId=randomUUID(),assessmentId=randomUUID();
    const { nativeSha256 }=await import("../services/native-runtime/canonical.js");
    const resultJson={result:{reportedWorkDisposition:"done",summary:"Synthetic completed candidate",attentionRequests:[]},terminal:{runTerminalState:"succeeded"}};
    await db.insert(heartbeatRuns).values({id:runId,companyId:f.company.id,agentId:agentId ?? f.builder.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"succeeded",completionContractId:contractId,completionContractSha256:`synthetic-contract:${runId}`,contextSnapshot:{issueId:f.issue.id}});
    await db.insert(completionContracts).values({id:contractId,companyId:f.company.id,issueId:f.issue.id,revision:prior.statusVersion+1,schemaVersion:"paperclip.completion-contract.v1",policyVersion:"phase6-v13",risk:"standard",completionAuthority:"server_arbiter",incompleteCriteriaPolicy:"preserve_non_terminal",contractJson:{criteria:[]},canonicalSha256:`synthetic-contract:${runId}`,createdByActorType:"system",createdByActorId:"budget-component-fixture"});
    await db.insert(nativeRunResults).values({id:resultId,companyId:f.company.id,issueId:f.issue.id,runId,completionContractId:contractId,serverFingerprint:nativeSha256(resultJson),schemaStatus:"accepted",resultJson,canonicalSha256:nativeSha256(resultJson)});
    await db.insert(workAssessments).values({id:assessmentId,companyId:f.company.id,issueId:f.issue.id,runId,contractId,resultId,triggerKind:"native_result",triggerActorCompanyId:f.company.id,priorIssueStatus:prior.status,priorStatusVersion:prior.statusVersion,priorDecisionId:prior.lastStatusDecisionId,policyVersion:"phase6-v13",assessmentJson:{allCriteriaSatisfied:true},inputDigest:`synthetic-assessment:${runId}`});
    await db.insert(nativeRunFinalizations).values({runId,companyId:f.company.id,issueId:f.issue.id,phase:"assessing",resultId,assessmentId});
    await db.update(issues).set({executionRunId:runId,checkoutRunId:runId}).where(eq(issues.id,f.issue.id));
    const { commitNativeStatusDecision }=await import("../services/native-runtime/status-decision-committer.js");
    const input={db,companyId:f.company.id,issueId:f.issue.id,runId,assessmentId,priorStatus:prior.status,priorStatusVersion:prior.statusVersion,priorDecisionId:prior.lastStatusDecisionId,
      decision:{policyVersion:"phase6-v13" as const,statusAction:"done" as const,toStatus:"done" as const,reasonCode:"completion_contract_satisfied",unblockDescriptor:null,effects:[{kind:"release_checkout" as const}]}};
    return {f,runId,contractId,resultId,assessmentId,nativeSha256,resultJson,commitNativeStatusDecision,input};
}

async function stageFixture(existing?: Awaited<ReturnType<typeof seed>>) {
  const base=await draftFixture(existing),candidate=await nativeCandidate(base),execution=structuredClone(base.execution);
  execution.binding.runId=candidate.runId;
  await db.update(heartbeatRuns).set({runnerProfileJson:{nativeExecutionInput:execution}}).where(eq(heartbeatRuns.id,candidate.runId));
  await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,base.runId));
  const committed=await candidate.commitNativeStatusDecision(candidate.input);
  const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,base.company.id),eq(agentWakeupRequests.agentId,base.reviewer.id)));
  const context=(wake.payload as any)._paperclipWakeContext;
  const [reviewerRun]=await db.insert(heartbeatRuns).values({companyId:base.company.id,agentId:base.reviewer.id,runtimeMode:"native",nativeIssueId:base.issue.id,issueId:base.issue.id,scopeKind:"issue",status:"running",responsibleUserId:base.userId,wakeupRequestId:wake.id,contextSnapshot:context}).returning();
  await db.update(issues).set({executionRunId:reviewerRun.id}).where(eq(issues.id,base.issue.id));
  return {...base,candidate,committed,wake,context,reviewerRun,reviewerApp:await base.agentApp(base.reviewer.id,reviewerRun.id)};
}

async function qualifyProtectedReview(f:Awaited<ReturnType<typeof stageFixture>>|Awaited<ReturnType<typeof reviewingDraftFixture>>, convertAfterPreparation=false) {
  const previousHome=process.env.PAPERCLIP_HOME;
  let child:ReturnType<typeof spawn>|undefined;
  try {
  process.env.PAPERCLIP_HOME=await fs.mkdtemp(path.join(process.env.TMPDIR!,"protected-review-home-"));
  await fs.mkdir((await import("../home-paths.js")).resolvePaperclipInstanceRoot(),{recursive:true,mode:0o700});
  const {agentReviewerPolicies}=await import("@paperclipai/db");
  await db.insert(agentReviewerPolicies).values({companyId:f.company.id,agentId:f.reviewer.id,enabled:true,revision:1,scopes:[{projectId:f.workspace.projectId!,repositoryId:"99",repository:"fixture/repository"}],updatedByUserId:f.userId});
  const [agent]=await db.select().from(agents).where(eq(agents.id,f.reviewer.id));
  const identity={companyId:f.company.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,issueId:f.issue.id,projectId:f.workspace.projectId!,workspaceId:f.workspace.id,workspaceDirectory:f.workspace.cwd!,executionDriver:"local" as const};
  await (await import("../services/agent-reference-folder-admission.js")).prepareAgentReferenceFolderAdmission(db,{agent, ...identity});
  const admission=(await (await import("../services/native-runtime/reviewer-workspace-admission.js")).prepareNativeReviewerWorkspaceAdmission(db,identity))!;
  // Actual startup prepares the protected workspace BEFORE native conversion.
  if(convertAfterPreparation)await db.update(heartbeatRuns).set({runtimeMode:"native",nativeIssueId:f.issue.id}).where(eq(heartbeatRuns.id,f.reviewerRun.id));
  const asset=await (await import("../services/native-runtime/runtime-context.js")).materializeAsset([{path:"AGENTS.md",content:Buffer.from("Synthetic protected review"),mode:0o400},{path:admission.instructionFile.path,content:Buffer.from(admission.instructionFile.content),mode:0o400}]);
  const base=(await import("../services/native-runtime/runtime-context.test-fixture.js")).nativeRuntimeContextFixture();
  const context={...base,instructions:{entryPath:"AGENTS.md",bundle:asset}};
  const {parseNativeExecutionInput,canonicalNativeRuntimeContextDigest}=await import("../vendor/paperclip-runner/index.js");context.aggregateDigest=canonicalNativeRuntimeContextDigest(context);
  const execution=parseNativeExecutionInput({...f.execution,binding:{...f.execution.binding,agentId:f.reviewer.id,runId:f.reviewerRun.id},runtimeContext:context});
  await db.update(heartbeatRuns).set({runnerProfileJson:sql`coalesce(${heartbeatRuns.runnerProfileJson},'{}'::jsonb)||${JSON.stringify({nativeExecutionInput:execution})}::jsonb`}).where(eq(heartbeatRuns.id,f.reviewerRun.id));
  child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});await once(child,"spawn");
  const started=await (await import("../services/hot-restart.js")).readProcessStartedAt(child.pid!);const runnerInstanceId=randomUUID();
  await db.update(heartbeatRuns).set({runnerInstanceId,nativeSessionId:randomUUID(),driverKind:"codex_app_server",processPid:child.pid!,processStartedAt:new Date(started!)}).where(eq(heartbeatRuns.id,f.reviewerRun.id));
  await (await import("../services/native-runtime/reviewer-runtime-admission.js")).recordNativeReviewerProcessAdmission(db,{execution,workspaceAccess:admission.workspaceAccess,runnerInstanceId,process:{pid:child.pid!,processGroupId:null,startedAt:started!}});
  const actor={type:"agent" as const,agentId:f.reviewer.id,runId:f.reviewerRun.id,companyId:f.company.id,source:"agent_jwt" as const,onBehalfOfUserId:f.userId,onBehalfOfMemberships:[{companyId:f.company.id,membershipRole:"owner",status:"active"}]};
  return {admission,execution,actor,close:async()=>{child!.kill("SIGTERM");await once(child!,"exit");if(previousHome===undefined)delete process.env.PAPERCLIP_HOME;else process.env.PAPERCLIP_HOME=previousHome;}};
  } catch(error) {
    if(child?.pid && child.exitCode===null){child.kill("SIGTERM");await once(child,"exit");}
    if(previousHome===undefined)delete process.env.PAPERCLIP_HOME;else process.env.PAPERCLIP_HOME=previousHome;
    throw error;
  }
}

// Real scoped resolution, durable outbox dispatch, transactional claim and
// checkout/DB trigger. Queued-run construction and native preparation output
// are controlled fixture seams; no provider executor is called.
async function claimedScopedReturnFixture(outcome: "passed" | "changes_requested" = "passed") {
  const f = await reviewingDraftFixture();
  ok(await request(f.reviewerApp).post(`/api/issues/${f.issue.id}/interactions/${f.scope.interactionId}/${outcome === "passed" ? "accept" : "reject"}`)
    .send(outcome === "passed" ? {} : { reason: "One concrete synthetic clarification remains" }));
  const [scope] = await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id, f.scope.id));
  await db.update(agentWakeupRequests).set({ status: "completed", runId: f.reviewerRun.id })
    .where(and(eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.agentId, f.reviewer.id)));
  const { heartbeatService } = await import("../services/heartbeat.js");
  await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId: f.company.id, requestId: scope.returnWakeupId! });
  const [delivery] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${scope.returnWakeupId}`));
  expect(delivery).toMatchObject({ status: "deferred_issue_execution", agentId: f.builder.id });
  // Model provider/finalization settlement and queue creation only. The real
  // claim below must acquire its own run/wake/task locks and ownership.
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.reviewerRun.id));
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
  await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.runId));
  await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issue.id));
  const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.builder.id,
    issueId: f.issue.id, scopeKind: "issue", status: "queued", invocationSource: "automation", triggerDetail: "system",
    responsibleUserId: f.userId, wakeupRequestId: delivery.id, contextSnapshot: (delivery.payload as any)._paperclipWakeContext }).returning();
  await db.update(agentWakeupRequests).set({ status: "queued", runId: queued.id }).where(eq(agentWakeupRequests.id, delivery.id));
  const { createHeartbeatQueueTestDependencies } = await import("./helpers/heartbeat-queue.js");
  const { createHeartbeatQueue } = await import("../services/heartbeat/queue.js");
  const { createHeartbeatRunState } = await import("../services/heartbeat/run-state.js");
  const { createHeartbeatRunPreparation } = await import("../services/heartbeat/run-preparation.js");
  const { createHeartbeatLifecycle } = await import("../services/heartbeat/run-lifecycle.js");
  const { issueService } = await import("../services/issues.js");
  const deps = createHeartbeatQueueTestDependencies(db), service = issueService(db);
  deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
  type Lifecycle = Parameters<typeof createHeartbeatLifecycle>[1];
  const lifecycle = createHeartbeatLifecycle(db, { ...createHeartbeatRunState(db), ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn<Lifecycle["issuesSvc"]["addComment"]>(), listReviewAttention: vi.fn<Lifecycle["issuesSvc"]["listReviewAttention"]>() },
    recovery: { escalateStrandedAssignedIssue: vi.fn<Lifecycle["recovery"]["escalateStrandedAssignedIssue"]>() },
    companySkills: { completeTestRunForIssue: vi.fn<Lifecycle["companySkills"]["completeTestRunForIssue"]>() },
    budgets: { getInvocationBlock: vi.fn(async () => null) }, treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn<Lifecycle["enqueueWakeup"]>(), getCurrentUserRedactionOptions: vi.fn(async () => ({})),
    getAgentInvokability: vi.fn<Lifecycle["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn<Lifecycle["emitTerminalAgentTaskRun"]>(), budgetHooks: {} });
  deps.setWakeupStatus.mockImplementation(lifecycle.setWakeupStatus);
  deps.issuesSvc.getDependencyReadiness.mockImplementation(service.getDependencyReadiness);
  deps.issuesSvc.listDependencyReadiness.mockImplementation(service.listDependencyReadiness);
  deps.executeRun.mockImplementation(async () => { throw new Error("Provider execution is outside this fixture"); });
  const claimed = await createHeartbeatQueue(db, deps).claimQueuedRun(queued);
  expect(claimed).toMatchObject({ id: queued.id, status: "running" });
  expect(deps.executeRun).not.toHaveBeenCalled();
  expect(await f.read()).toMatchObject({ status: "todo", statusVersion: scope.returnStatusVersion, executionRunId: queued.id });
  return { ...f, scope, delivery, claimed: claimed!, service, deps };
}

// Keep the controlled no-provider preparation seam, then execute the REAL
// native release adapter to clear bindings, project blocked/v+1 and record its
// terminal coordinator/recovery marker. Do not manually manufacture that shape.
async function failedScopedReturnFixture() {
  const f = await claimedScopedReturnFixture();
  await f.service.checkout(f.issue.id, f.builder.id, ["todo"], f.claimed.id);
  const execution = structuredClone(f.execution); execution.binding.runId = f.claimed.id;
  const [failed] = await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: f.issue.id,
    runtimeModeResolvedAt: new Date(), nativeSessionId: randomUUID(), runnerInstanceId: randomUUID(), finishedAt: new Date(),
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    errorCode: "adapter_failed", error: "The scoped return target or native receipt is no longer current",
    contextSnapshot: { ...f.claimed.contextSnapshot, taskId: f.issue.id, nativeStatusWakeIntentId: f.scope.returnWakeupId },
    runnerProfileJson: { nativeExecutionInput: execution }, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
    .where(eq(heartbeatRuns.id, f.claimed.id)).returning();
  await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.delivery.id));
  await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, issueId: f.issue.id, runId: failed.id,
    phase: "observed", attempt: 0 });
  const [lease] = await db.insert(environmentLeases).values({ companyId: f.company.id, issueId: f.issue.id,
    executionWorkspaceId: f.workspace.id, heartbeatRunId: failed.id, provider: "local", status: "failed", releasedAt: new Date() }).returning();
  const { createReleaseIssueExecution } = await import("../modules/wake-queue/application/use-cases.js");
  const { createPostgresWakeQueueAdapter } = await import("../modules/wake-queue/adapters/postgres.js");
  const unexpected = vi.fn(async () => { throw new Error("Unexpected release callback: native terminal projection must not dispatch or recover"); });
  const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
    resolveResponsibleUserId: unexpected, getRoutineEnv: unexpected, resolveSessionBeforeForWakeup: unexpected,
  }), recovery: { escalateStrandedAssignedIssue: unexpected, escalateStrandedRecoveryIssueInPlace: unexpected } });
  const released = await release({ companyId: f.company.id, runId: failed.id, now: new Date(), suppressImmediateRecovery: true });
  expect(released.outcome.kind).toBe("released");
  expect(unexpected).not.toHaveBeenCalled();
  const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, failed.id));
  expect(owner).toMatchObject({ phase: "terminal_failure", attempt: 0, controllerGeneration: 0,
    recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
  const blocked = await f.read();
  expect(blocked).toMatchObject({ status: "blocked", executionRunId: null, checkoutRunId: null });
  expect(blocked.statusVersion).toBe(f.scope.returnStatusVersion! + 2);
  const [failure] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.company.id),
    eq(issueRecoveryActions.sourceIssueId, f.issue.id), eq(issueRecoveryActions.cause, "native_continuation_requires_reconciliation")));
  expect(failure.evidence.nativeFailureBlock).toEqual({ runId: failed.id, statusVersion: blocked.statusVersion });
  return { ...f, failed, execution, owner, lease, failure, blocked };
}

const patch = (app: express.Express, id: string, body: object) => request(app).patch(`/api/issues/${id}`).send(body);
function ok(response: any) { expect(response.status, JSON.stringify(response.body)).toBe(200); }

describe("actual normal PATCH + native postgres-js + native issue service (injected actor, no worker execution)", () => {
  beforeAll(async () => {
    const supplied = process.env.PAPERCLIP_SCOPED_REVIEW_STARTUP_TEST_DATABASE_URL;
    if (supplied !== undefined) {
      const url = new URL(supplied);
      if (!/^postgres(?:ql)?:$/.test(url.protocol)
        || !/^pc_scoped_review_startup_[a-f0-9]+_test$/.test(url.pathname.slice(1))) {
        throw new Error("scoped_review_startup_test_database_not_isolated");
      }
      db = createDb(supplied, { maxConnections: 2, applicationName: "scoped-review-startup-regression" });
      // Externally allocated fixtures and filesystem evidence are retained.
      fixture = { end: () => db.$client.end({ timeout: 5 }) };
    } else {
      const nativeFixture = await reviewerNativeTestDatabase();
      db = nativeFixture.db; fixture = nativeFixture;
    }
    expect((await db.execute(sql`select to_regclass('issue_review_cycle_budgets') as name`))[0].name).toBe("issue_review_cycle_budgets");
    expect((await db.execute(sql`select to_regclass('issue_scoped_reviews') as name`))[0].name).toBe("issue_scoped_reviews");
    expect((await db.execute(sql`show server_version`))[0].server_version).toMatch(/^18\.1/);
    await import("../routes/issues.js");
  }, 120000);
  afterAll(async () => { await fixture?.end(); });
  it("guarded total-five promotion retains its real locked ledger and rejects a stale repeat", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.issue.id));
    const before = await f.read();
    const response = await request(f.board).patch(`/api/issues/${f.issue.id}`)
      .send({ status: "todo", expectedStatusVersion: before.statusVersion });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await f.read();
    expect(saved.status).toBe("todo");
    expect(saved.statusVersion).toBe(before.statusVersion + 1);
    const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
    expect(normalizeIssueExecutionPolicy(saved.executionPolicy)).toEqual(normalizeIssueExecutionPolicy(before.executionPolicy));
    const ledger = await f.ledger();
    expect(ledger).toMatchObject({ issueId: f.issue.id, initialAllowance: 5, admissions: [], allowances: [] });
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issue.id))).toHaveLength(0);
    const stale = await request(f.board).patch(`/api/issues/${f.issue.id}`)
      .send({ status: "todo", expectedStatusVersion: before.statusVersion });
    expect(stale.status).toBe(409);
    expect(await f.read()).toEqual(saved);
    expect(await f.ledger()).toEqual(ledger);
  });
  it("guarded total-five concurrent promotions commit only one status change without spending a review", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.issue.id));
    const before = await f.read();
    const promote = () => request(f.board).patch(`/api/issues/${f.issue.id}`)
      .send({ status: "todo", expectedStatusVersion: before.statusVersion });
    const responses = await Promise.all([promote(), promote()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await f.read()).statusVersion).toBe(before.statusVersion + 1);
    expect((await f.ledger()).admissions).toHaveLength(0);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issue.id))).toHaveLength(0);
  });
  it("guarded total-five direct native setter still refuses an unadapted promotion", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.issue.id));
    const before = await f.read();
    const { issueService } = await import("../services/issues.js");
    await expect(issueService(db).update(f.issue.id, {
      status: "todo", expectedStatusVersion: before.statusVersion, actorUserId: f.userId,
    })).rejects.toThrow("locked task-wide review budget adapter");
    expect(await f.read()).toEqual(before);
    expect(await f.ledger()).toBeUndefined();
  });
  it("scoped draft pins native document revision, workspace and one configured Reviewer; duplicates neither dispatch nor spend", async () => {
    const f=await draftFixture();
    const first=await request(f.app).post(`/api/issues/${f.issue.id}/scoped-reviews`).send(f.requestBody);
    expect(first.status,JSON.stringify(first.body)).toBe(201); expect(first.body.review.state).toBe("draft");
    const {nativeSha256}=await import("../services/native-runtime/canonical.js");
    expect(first.body.review.snapshot).toMatchObject({builderAgentId:f.builder.id,builderRunId:f.runId,reviewerAgentId:f.reviewer.id,contentSha256:nativeSha256({title:f.revision.title,format:f.revision.format,body:f.revision.body})});
    const retry=await request(f.app).post(`/api/issues/${f.issue.id}/scoped-reviews`).send(f.requestBody); expect(retry.status).toBe(200); expect(retry.body.replayed).toBe(true);
    const changed=await request(f.app).post(`/api/issues/${f.issue.id}/scoped-reviews`).send({...f.requestBody,purpose:"Changed purpose"}); expect(changed.status).toBe(409);
    expect(await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.issueId,f.issue.id))).toHaveLength(1);
    expect(await f.ledger()).toBeUndefined(); expect((await f.read()).assigneeAgentId).toBe(f.builder.id);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.company.id))).toHaveLength(0);
  });
  it("scoped draft rejects stale revisions, foreign documents, changed workspace and unauthenticated human submission", async () => {
    const f=await draftFixture();
    for(const bad of [{revisionId:randomUUID()},{documentId:randomUUID()},{executionWorkspaceId:randomUUID()},{expectedStatusVersion:99}]) {
      const response=await request(f.app).post(`/api/issues/${f.issue.id}/scoped-reviews`).send({...f.requestBody,...bad}); expect(response.status,JSON.stringify(response.body)).toBe(409);
    }
    const board=await request(f.board).post(`/api/issues/${f.issue.id}/scoped-reviews`).send(f.requestBody); expect(board.status).toBe(403);
    expect(await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.issueId,f.issue.id))).toHaveLength(0); expect(await f.ledger()).toBeUndefined();
  });
  it("scoped native admission shares parent ledger and native Reviewer claim rejects a competing execution owner", async () => {
    const f=await admittedDraftFixture();
    expect(f.scope).toMatchObject({state:"pending",sourceDecisionId:f.committed.decision.id});
    expect((await f.ledger()).admissions).toEqual([expect.objectContaining({kind:"scoped",scopeId:f.requestBody.id,id:f.requestBody.id})]);
    expect(await f.read()).toMatchObject({status:"in_review",assigneeAgentId:f.builder.id});
    const [interaction]=await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,f.scope.interactionId!));
    expect(interaction.payload).toMatchObject({target:{key:"scoped_review",revisionId:f.committed.decision.id},acceptLabel:"Scope passed; return remaining work"});
    const {getNativeReviewAssignment,claimNativeReviewExecutionLock}=await import("../services/native-runtime/native-review-participant.js");
    const context={issueId:f.issue.id,nativeReviewInteractionId:interaction.id,nativeReviewDecisionId:f.committed.decision.id};
    expect(await getNativeReviewAssignment(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,contextSnapshot:context})).toMatchObject({scopedReview:{id:f.scope.id}});
    const [reviewerRun]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.reviewer.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"queued",contextSnapshot:context}).returning();
    const claim={companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:reviewerRun.id,contextSnapshot:context,agentNameKey:"synthetic-reviewer",claimedAt:new Date()};
    // Native status projection normally clears checkout. Inject a competing
    // current execution owner to test the atomic claim, not process cleanup.
    await db.update(issues).set({executionRunId:f.runId}).where(eq(issues.id,f.issue.id));
    expect(await claimNativeReviewExecutionLock(db,claim)).toBe(false);
    // Synthetic observation of controller release, not a claim of real process cleanup.
    await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,f.runId));
    await db.update(issues).set({executionRunId:null,checkoutRunId:null}).where(eq(issues.id,f.issue.id));
    expect(await claimNativeReviewExecutionLock(db,claim)).toBe(true);
    expect((await f.commitNativeStatusDecision(f.input)).replayed).toBe(true);
    expect((await f.ledger()).admissions).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,f.company.id),eq(agentWakeupRequests.agentId,f.reviewer.id)))).toHaveLength(1);
  });
  it.each(["accept","reject"] as const)("scoped %s records partial verdict and one durable gated Builder return without completing parent",async decision=>{
    const f=await reviewingDraftFixture();
    const endpoint=`/api/issues/${f.issue.id}/interactions/${f.scope.interactionId}/${decision}`;
    const response=await request(f.reviewerApp).post(endpoint).send(decision==="reject"?{reason:"Correct the pinned plan before implementing remaining work"}:{});
    ok(response);
    const [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));
    expect(scope).toMatchObject({state:decision==="accept"?"passed":"changes_requested",verdict:decision==="accept"?"passed":"changes_requested",verdictRunId:f.reviewerRun.id,version:2});
    expect(await f.read()).toMatchObject({status:"todo",assigneeAgentId:f.builder.id,executionRunId:f.reviewerRun.id});
    expect((await f.ledger()).admissions).toHaveLength(1);
    const [wake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,scope.returnWakeupId!));
    expect(wake).toMatchObject({agentId:f.builder.id,status:"queued",idempotencyKey:`native-scoped-return:${f.scope.id}:${decision==="accept"?"accepted":"rejected"}`});
    expect(JSON.stringify(wake.payload)).toContain(f.requestBody.remainingWork);
    const retry=await request(f.reviewerApp).post(endpoint).send(decision==="reject"?{reason:"Correct the pinned plan before implementing remaining work"}:{});
    expect([200,409]).toContain(retry.status);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,wake.idempotencyKey!))).toHaveLength(1);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,f.issue.id))).toHaveLength(0);
  });
  it("fifth scoped correction shares four previous normal cycles, holds selected human and refuses allowance until Reviewer settles",async()=>{
    const base=await seed();
    for(let n=1;n<=4;n++) {await base.run(base.builder.id);ok(await patch(base.board,base.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));const r=await base.run(base.reviewer.id);ok(await patch(await base.agentApp(base.reviewer.id,r.id),base.issue.id,{status:"in_progress",comment:`Correction ${n}`}));}
    const f=await reviewingDraftFixture(base);
    ok(await request(f.reviewerApp).post(`/api/issues/${f.issue.id}/interactions/${f.scope.interactionId}/reject`).send({reason:"The fifth shared candidate still needs correction"}));
    expect((await f.ledger()).admissions.map((a:any)=>a.kind)).toEqual(["normal","normal","normal","normal","scoped"]);
    expect(await f.read()).toMatchObject({status:"in_review",assigneeAgentId:null,assigneeUserId:f.userId,executionRunId:f.reviewerRun.id,executionState:{status:"changes_requested",totalReviewBudgetHold:true,totalReviewCyclesUsed:5}});
    const [held]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));expect(held).toMatchObject({state:"held",verdict:"changes_requested",returnWakeupId:null});
    const allowance={id:randomUUID(),additionalCycles:1,reason:"One explicit further shared review cycle"};
    const blocked=await patch(f.board,f.issue.id,{reviewCycleAllowance:allowance});expect(blocked.status).toBe(409);expect((await f.ledger()).allowances).toHaveLength(0);
    // Synthetic observed settlement; full native process/lease acceptance remains separate.
    await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,f.reviewerRun.id));await db.update(issues).set({executionRunId:null}).where(eq(issues.id,f.issue.id));
    ok(await patch(f.board,f.issue.id,{reviewCycleAllowance:allowance}));expect((await f.ledger()).admissions).toHaveLength(5);expect((await f.ledger()).allowances).toHaveLength(1);
    expect(await f.read()).toMatchObject({assigneeAgentId:f.builder.id,executionState:{totalReviewBudgetHold:false}});
  },90000);
  it("unresolved scoped Reviewer reaches the real runtime guard boundary without changing native identity", async () => {
    const f = await unresolvedScopedReviewerFixture();
    const { assertScopedRunAdmission } = await import("../services/scoped-review-admission.js");
    const identity = { companyId: f.company.id, issueId: f.issue.id, runId: f.reviewerRun.id };
    await expect(assertScopedRunAdmission(db, identity)).resolves.toBeUndefined();
    const [running] = await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.reviewerRun.id)).returning();
    const { executeHeartbeatRuntime } = await import("../services/heartbeat/runtime-execution.js");
    const sentinel = new Error("scoped-reviewer-after-production-admission-before-runtime");
    let reachedRuntime = 0;
    const input = { run: running, agent: f.reviewer, options: {}, task: { issueId: f.issue.id }, services: {},
      get runtime() { reachedRuntime++; throw sentinel; } } as unknown as Parameters<typeof executeHeartbeatRuntime>[1];
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(sentinel);
    expect(reachedRuntime).toBe(1);
    const [unchanged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, running.id));
    expect(unchanged).toMatchObject({ runtimeMode: "legacy", nativeIssueId: null, runtimeModeResolvedAt: null,
      processPid: null, nativeSessionId: null });
    expect((await f.ledger()).admissions).toHaveLength(1);
    expect(await f.read()).toMatchObject({ status: "in_review", executionRunId: running.id });
    expect((await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id, f.scope.id)))[0].state).toBe("pending");
    // Preparation publishes native identity later; its fully resolved check stays strict.
    await db.update(heartbeatRuns).set({ runtimeMode: "native", runtimeModeResolvedAt: new Date(), nativeIssueId: f.issue.id })
      .where(eq(heartbeatRuns.id, running.id));
    await expect(assertScopedRunAdmission(db, identity)).resolves.toBeUndefined();
    await db.update(heartbeatRuns).set({ nativeIssueId: null }).where(eq(heartbeatRuns.id, running.id));
    await expect(assertScopedRunAdmission(db, identity)).rejects.toThrow("new Builder turn cannot start");
  });

  it.each(["eligible", "stale after queue", "resolved legacy", "provider started", "live controller",
    "coordinator", "source mismatch", "revoked review", "changed artifact"] as const)(
    "exact failed unresolved scoped Reviewer retry through real route and queue: %s", async change => {
    const f = await unresolvedScopedReviewerFixture();
    const context = { ...f.context, nativeStatusWakeIntentId: f.wake.id, source: "native_status_decision",
      statusDecisionSource: "native_status_decision", wakeReason: "native_completion_review" };
    const [delivery] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.reviewer.id,
      source: f.wake.source, triggerDetail: "system", reason: "native_completion_review", status: "failed",
      requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${f.wake.id}`,
      runId: f.reviewerRun.id, payload: { issueId: f.issue.id, _paperclipWakeContext: context }, finishedAt: new Date() }).returning();
    await db.update(agentWakeupRequests).set({ status: "coalesced", runId: f.reviewerRun.id, finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wake.id));
    const [failed] = await db.update(heartbeatRuns).set({ status: "failed", startedAt: new Date(), finishedAt: new Date(),
      errorCode: "setup_failed", error: "A new Builder turn cannot start during the pending scoped review",
      executionStage: "preparing", runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      wakeupRequestId: delivery.id, contextSnapshot: context }).where(eq(heartbeatRuns.id, f.reviewerRun.id)).returning();
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issue.id));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, f.reviewer.id));
    if (change === "resolved legacy") await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, failed.id));
    if (change === "provider started") await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } }).where(eq(heartbeatRuns.id, failed.id));
    if (change === "live controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now()+60_000) }).where(eq(heartbeatRuns.id, failed.id));
    if (change === "coordinator") {
      // An unresolved run cannot acquire a native coordinator with invented
      // task identity; the native owner FK rejects it before route admission.
      await expect(db.insert(nativeRunFinalizations).values({ companyId: f.company.id, issueId: f.issue.id,
        runId: failed.id, phase: "terminal_failure" })).rejects.toMatchObject({
        cause: { code: "23503", constraint_name: "native_run_finalizations_run_owner_fk" },
      });
      return;
    }
    if (change === "source mismatch") await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, sourceRunId: randomUUID() } }).where(eq(heartbeatRuns.id, failed.id));
    if (change === "revoked review") await db.update(issueThreadInteractions).set({ status: "rejected" }).where(eq(issueThreadInteractions.id, f.scope.interactionId!));
    if (change === "changed artifact") await db.update(documentRevisions).set({ body: "Artifact changed before Retry" }).where(eq(documentRevisions.id, f.revision.id));
    // The real queue persists the successor but cannot dispatch a provider while
    // this synthetic slot is occupied. Atomic review claim is exercised below.
    const [occupied] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.reviewer.id,
      status: "running", startedAt: new Date() }).returning();
    const app = await retryAppFor(f.userId, f.company.id);
    const body = { failedRunId: failed.id, reason: "retry_failed_run", idempotencyKey: randomUUID(),
      payload: { issueId: randomUUID(), nativeReviewDecisionId: randomUUID(), nativeReviewInteractionId: randomUUID() } };
    executionFixture.realWake = true;
    try {
      const response = await request(app).post(`/api/agents/${f.reviewer.id}/wakeup`).send(body);
      if (!["eligible", "stale after queue"].includes(change)) {
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failed.id))).toHaveLength(0);
        return;
      }
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failed.id));
      expect(successors).toHaveLength(1);
      const successor = successors[0];
      expect(successor).toMatchObject({ status: "queued", runtimeMode: "legacy", nativeIssueId: null,
        contextSnapshot: { issueId: f.issue.id, nativeReviewDecisionId: f.scope.sourceDecisionId,
          nativeReviewInteractionId: f.scope.interactionId, previousRunId: failed.id, forceFreshSession: true } });
      const repeated = await request(app).post(`/api/agents/${f.reviewer.id}/wakeup`).send({ ...body, idempotencyKey: randomUUID() });
      expect(repeated.status, JSON.stringify(repeated.body)).toBe(202);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failed.id))).toHaveLength(1);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, occupied.id));
      const { claimQueuedNativeReviewRun } = await import("../services/native-runtime/native-review-dispatch.js");
      if (change === "stale after queue") {
        await db.update(documentRevisions).set({ body: "Artifact changed after Retry admission" }).where(eq(documentRevisions.id, f.revision.id));
        expect(await claimQueuedNativeReviewRun(db, { run: successor, agentNameKey: "retried-scoped-reviewer",
          claimedAt: new Date(), claimValues: {} })).toBeNull();
        expect((await f.read()).executionRunId).toBeNull();
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id)))[0]).toMatchObject({ status: "queued", processPid: null });
        return;
      }
      expect(await claimQueuedNativeReviewRun(db, { run: successor, agentNameKey: "retried-scoped-reviewer",
        claimedAt: new Date(), claimValues: {} })).toMatchObject({ id: successor.id, status: "running", nativeIssueId: null });
      const { assertScopedRunAdmission } = await import("../services/scoped-review-admission.js");
      await expect(assertScopedRunAdmission(db, { companyId: f.company.id, issueId: f.issue.id, runId: successor.id })).resolves.toBeUndefined();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed.id)))[0]).toEqual(failed);
      expect((await f.ledger()).admissions).toHaveLength(1);
      expect((await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id, f.scope.id)))[0].state).toBe("pending");
    } finally { executionFixture.realWake = false; }
  });

  it.each(["builder", "canonical issue", "context issue", "source run", "revision", "decision", "interaction",
    "revoked interaction", "artifact", "workspace", "policy", "resolved legacy", "legacy adapter", "paused reviewer",
    "execution owner", "foreign native identity", "terminal run"] as const)(
    "unresolved scoped Reviewer refuses changed %s before runtime", async change => {
      const f = await unresolvedScopedReviewerFixture();
      let admissionRunId = f.reviewerRun.id;
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.reviewerRun.id));
      const runChange = (values: Partial<typeof heartbeatRuns.$inferInsert>) => db.update(heartbeatRuns).set(values).where(eq(heartbeatRuns.id, f.reviewerRun.id));
      if (change === "builder") await runChange({ agentId: f.builder.id });
      if (change === "canonical issue") {
        const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Other task" }).returning();
        const [foreign] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.reviewer.id,
          issueId: other.id, scopeKind: "issue", status: "running", contextSnapshot: { ...f.context, issueId: other.id } }).returning();
        admissionRunId = foreign.id;
      }
      if (change === "context issue") await runChange({ contextSnapshot: { ...f.context, issueId: randomUUID() } });
      if (change === "source run") await runChange({ contextSnapshot: { ...f.context, sourceRunId: randomUUID() } });
      if (change === "revision") await runChange({ contextSnapshot: { ...f.context, revisionId: randomUUID() } });
      if (change === "decision") await runChange({ contextSnapshot: { ...f.context, nativeReviewDecisionId: randomUUID() } });
      if (change === "interaction") await runChange({ contextSnapshot: { ...f.context, nativeReviewInteractionId: randomUUID() } });
      if (change === "revoked interaction") await db.update(issueThreadInteractions).set({ status: "rejected" }).where(eq(issueThreadInteractions.id, f.scope.interactionId!));
      if (change === "artifact") await db.update(documentRevisions).set({ body: "Changed pinned artifact" }).where(eq(documentRevisions.id, f.revision.id));
      if (change === "workspace") await db.update(issues).set({ workspaceBindingRevision: sql`${issues.workspaceBindingRevision}+1` }).where(eq(issues.id, f.issue.id));
      if (change === "policy") {
        const policy = structuredClone(f.issue.executionPolicy) as { totalReviewCycles: number; stages: Array<{ id: string }> };
        policy.stages[0].id = randomUUID();
        await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, f.issue.id));
      }
      if (change === "resolved legacy") await runChange({ runtimeModeResolvedAt: new Date() });
      if (change === "legacy adapter") await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, f.reviewer.id));
      if (change === "paused reviewer") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewer.id));
      if (change === "execution owner") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
      if (change === "foreign native identity") {
        // Native/canonical task disagreement is rejected even before admission.
        await expect(runChange({ nativeIssueId: randomUUID() })).rejects.toMatchObject({
          cause: { message: expect.stringContaining("native run task binding disagrees") },
        });
        return;
      }
      if (change === "terminal run") await runChange({ status: "cancelled", finishedAt: new Date() });
      const { assertScopedRunAdmission } = await import("../services/scoped-review-admission.js");
      await expect(assertScopedRunAdmission(db, { companyId: f.company.id, issueId: f.issue.id,
        runId: admissionRunId })).rejects.toThrow();
      expect((await f.ledger()).admissions).toHaveLength(1);
    });

  it("scoped controller admission rejects a new Builder during review and accepts only exact Reviewer run context",async()=>{
    const f=await reviewingDraftFixture(); const {assertScopedRunAdmission}=await import("../services/scoped-review-admission.js");
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:f.reviewerRun.id})).resolves.toBeUndefined();
    const [builder]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.builder.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"queued",contextSnapshot:{issueId:f.issue.id}}).returning();
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:builder.id})).rejects.toThrow("new Builder turn cannot start");
    await db.update(issues).set({workspaceBindingRevision:sql`${issues.workspaceBindingRevision}+1`}).where(eq(issues.id,f.issue.id));
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:f.reviewerRun.id})).rejects.toThrow("workspace or configured workflow changed");
    expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it.each(["passed", "changes_requested"] as const)("scoped return survives real native dispatch claim and checkout before the repeated production runtime gate: %s", async outcome => {
    const f = await claimedScopedReturnFixture(outcome);
    const { assertScopedRunAdmission } = await import("../services/scoped-review-admission.js");
    const identity = { companyId: f.company.id, issueId: f.issue.id, runId: f.claimed.id };
    await expect(assertScopedRunAdmission(db, identity)).resolves.toBeUndefined();
    const checkout = await f.service.checkout(f.issue.id, f.builder.id, ["todo"], f.claimed.id);
    expect(checkout).toMatchObject({ status: "in_progress", statusVersion: f.scope.returnStatusVersion! + 1,
      checkoutRunId: f.claimed.id, executionRunId: f.claimed.id });
    // Native preparation's identity output is the only remaining fixture seam.
    const [prepared] = await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issue.id, runtimeModeResolvedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.claimed.id)).returning();
    const { executeHeartbeatRuntime } = await import("../services/heartbeat/runtime-execution.js");
    const sentinel = new Error("scoped-return-passed-production-gate-before-any-provider");
    let reachedRuntime = 0;
    const input = { run: prepared, agent: f.builder, options: {}, task: { issueId: f.issue.id }, services: {},
      get runtime() { reachedRuntime++; throw sentinel; } } as unknown as Parameters<typeof executeHeartbeatRuntime>[1];
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(sentinel);
    expect(reachedRuntime).toBe(1);
    expect(f.deps.executeRun.mock.calls.length).toBeLessThanOrEqual(1);
    expect((await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id, f.scope.id)))[0].returnStatusVersion).toBe(f.scope.returnStatusVersion);
    expect((await f.ledger()).admissions).toHaveLength(1);
  });

  it.each(["manual in_progress", "manual transition then adoption", "foreign checkout", "missing checkout", "foreign execution", "unresolved run",
    "extra version", "foreign receipt owner", "receipt linked elsewhere", "artifact drift", "workspace drift", "policy drift"] as const)(
    "scoped return owned checkout rejects %s before runtime", async change => {
    const f = await claimedScopedReturnFixture();
    if (change === "manual in_progress" || change === "manual transition then adoption") {
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issue.id));
      if (change === "manual transition then adoption") await f.service.checkout(f.issue.id, f.builder.id, ["todo"], f.claimed.id);
    } else await f.service.checkout(f.issue.id, f.builder.id, ["todo"], f.claimed.id);
    if (change !== "unresolved run") await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issue.id, runtimeModeResolvedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.claimed.id));
    if (change === "foreign checkout") await db.update(issues).set({ checkoutRunId: f.reviewerRun.id }).where(eq(issues.id, f.issue.id));
    if (change === "missing checkout") await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, f.issue.id));
    if (change === "foreign execution") await db.update(issues).set({ executionRunId: f.reviewerRun.id }).where(eq(issues.id, f.issue.id));
    if (change === "extra version") await db.update(issues).set({ statusVersion: sql`${issues.statusVersion}+1` }).where(eq(issues.id, f.issue.id));
    if (change === "foreign receipt owner") await db.update(agentWakeupRequests).set({ requestedByActorId: "not-the-native-return-dispatcher" }).where(eq(agentWakeupRequests.id, f.delivery.id));
    if (change === "receipt linked elsewhere") await db.update(agentWakeupRequests).set({ runId: f.runId }).where(eq(agentWakeupRequests.id, f.delivery.id));
    if (change === "artifact drift") await db.update(documentRevisions).set({ body: "A different unreviewed artifact" }).where(eq(documentRevisions.id, f.revision.id));
    if (change === "workspace drift") await db.update(issues).set({ workspaceBindingRevision: sql`${issues.workspaceBindingRevision}+1` }).where(eq(issues.id, f.issue.id));
    if (change === "policy drift") { const policy = structuredClone(f.issue.executionPolicy) as any; policy.stages[0].id = randomUUID();
      await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, f.issue.id)); }
    const { assertScopedRunAdmission } = await import("../services/scoped-review-admission.js");
    await expect(assertScopedRunAdmission(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.claimed.id })).rejects.toThrow();
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    expect((await f.ledger()).admissions).toHaveLength(1);
  });

  it("unclaimed scoped return proves no launch without inventing a stop receipt or legacy classification", async () => {
    const f = await failedScopedReturnFixture();
    const { isUnclaimedScopedReturnPreparation } = await import("../services/scoped-review-admission.js");
    const { isFailedNativePreparation } = await import("../services/cancelled-native-startup.js");
    expect(await isFailedNativePreparation(db, f.failed, f.owner)).toBe(false);
    expect(await isUnclaimedScopedReturnPreparation(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.failed.id })).toBe(true);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.failed.id))).toHaveLength(0);
    expect(await f.read()).toMatchObject({ status: "blocked", statusVersion: f.blocked.statusVersion });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.delivery.id)))[0].status).toBe("failed");
  });

  it("unclaimed scoped return retains the earlier null recovery marker with all native proof guards", async () => {
    const f = await failedScopedReturnFixture();
    await db.update(nativeRunFinalizations).set({ recoveryState: null }).where(eq(nativeRunFinalizations.runId, f.failed.id));
    const { isUnclaimedScopedReturnPreparation } = await import("../services/scoped-review-admission.js");
    expect(await isUnclaimedScopedReturnPreparation(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.failed.id })).toBe(true);
  });

  it("unclaimed scoped return real TaskRetry and queue preserve one new user successor across a lost response", async () => {
    const f = await failedScopedReturnFixture();
    // Occupied company-level fixture slot prevents actual worker/provider
    // dispatch; it is not a run bound to this task or a fake stop receipt.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.builder.id));
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.builder.id, status: "running", startedAt: new Date() });
    const body = { idempotencyKey: randomUUID(), observedRunId: f.failed.id };
    // Model a committed receipt whose response/nudge was lost. Deliver its
    // exact durable generation once, after both HTTP transactions settle.
    executionFixture.holdTaskRetryNudge = true;
    try {
    const response = await request(f.board).post(`/api/issues/${f.issue.id}/retry`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body.accepted).toBe(true);
    const requestId = response.body.requestId;
    const repeated = await request(f.board).post(`/api/issues/${f.issue.id}/retry`).send(body);
    expect([200, 202]).toContain(repeated.status);
    expect(repeated.body.requestId).toBe(requestId);
    const actual = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
    await actual.heartbeatService(db).resumeTaskRetry(f.company.id, requestId);
    let successors: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (let n = 0; n < 30; n++) {
      successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.company.id), sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${requestId}`));
      if (successors.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ agentId: f.builder.id, status: "queued", contextSnapshot: {
      issueId: f.issue.id, previousRunId: f.failed.id, forceFreshSession: true, taskRetryRequestId: requestId } });
    expect(successors[0].contextSnapshot?.scopedReviewId).toBeUndefined();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.failed.id)))[0]).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
    expect((await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id, f.scope.id)))[0]).toMatchObject({ state: "passed", returnStatusVersion: f.scope.returnStatusVersion });
    expect((await f.ledger()).admissions).toHaveLength(1);
    } finally { executionFixture.holdTaskRetryNudge = false; }
  });

  it.each(["claimed", "controller", "lease holder", "process", "provider started", "launch event", "provider event", "tool event",
    "source event", "stop event", "tool invocation", "unreleased lease", "remote lease", "provider lease", "cleanup failed", "cleanup in flight",
    "invalid scope", "foreign dispatcher", "failure version", "extra task version", "foreign execution", "artifact", "native binding", "reference binding",
    "active recovery state", "awaiting evidence", "runner reattach", "unknown recovery state", "recovery request", "recovery history"] as const)(
    "unclaimed scoped return refuses contradictory %s evidence without mutation", async change => {
    const f = await failedScopedReturnFixture();
    const activeRecoveryStates: Record<string, string> = { "active recovery state": "resuming_session", "awaiting evidence": "awaiting_evidence",
      "runner reattach": "awaiting_runner_reattach", "unknown recovery state": "unknown-recovery-owner" };
    if (activeRecoveryStates[change]) await db.update(nativeRunFinalizations).set({ recoveryState: activeRecoveryStates[change] }).where(eq(nativeRunFinalizations.runId, f.failed.id));
    if (change === "recovery request") await db.update(nativeRunFinalizations).set({ recoveryRequestId: randomUUID() }).where(eq(nativeRunFinalizations.runId, f.failed.id));
    if (change === "recovery history") await db.update(nativeRunFinalizations).set({ recoveryHistory: [{ syntheticContradiction: true }] }).where(eq(nativeRunFinalizations.runId, f.failed.id));
    if (change === "claimed") await db.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.failed.id));
    if (change === "controller") await db.update(nativeRunFinalizations).set({ controllerPid: process.pid }).where(eq(nativeRunFinalizations.runId, f.failed.id));
    if (change === "lease holder") await db.update(nativeRunFinalizations).set({ leaseOwner: "another-controller" }).where(eq(nativeRunFinalizations.runId, f.failed.id));
    if (change === "process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.failed.id));
    if (change === "provider started") await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } }).where(eq(heartbeatRuns.id, f.failed.id));
    const eventTypes: Record<string, string> = { "launch event": "native.process_start_requested", "provider event": "turn.started", "tool event": "tool.execution.started", "source event": "otherwise-unknown", "stop event": "native.local_process_stopped" };
    if (eventTypes[change]) await db.insert(heartbeatRunEvents).values({ companyId: f.company.id, runId: f.failed.id, agentId: f.builder.id,
      seq: 1, eventType: eventTypes[change], stream: "system", sourceEventId: change === "source event" ? randomUUID() : null });
    if (change === "tool invocation") await db.insert(toolInvocations).values({ companyId: f.company.id, agentId: f.builder.id,
      issueId: f.issue.id, runId: f.failed.id, toolName: "synthetic-no-launch-contradiction", status: "succeeded" });
    if (change === "unreleased lease") await db.update(environmentLeases).set({ releasedAt: null }).where(eq(environmentLeases.id, f.lease.id));
    if (change === "remote lease") await db.update(environmentLeases).set({ provider: "ssh" }).where(eq(environmentLeases.id, f.lease.id));
    if (change === "provider lease") await db.update(environmentLeases).set({ providerLeaseId: "unexpected-resource" }).where(eq(environmentLeases.id, f.lease.id));
    if (change === "cleanup failed") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, f.lease.id));
    if (change === "cleanup in flight") await db.update(environmentLeases).set({ metadata: { pendingCleanupInFlight: true } }).where(eq(environmentLeases.id, f.lease.id));
    if (change === "invalid scope") await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.failed.contextSnapshot, scopedReviewId: "not-a-uuid" } }).where(eq(heartbeatRuns.id, f.failed.id));
    if (change === "foreign dispatcher") await db.update(agentWakeupRequests).set({ requestedByActorType: "user" }).where(eq(agentWakeupRequests.id, f.delivery.id));
    if (change === "failure version") await db.update(issueRecoveryActions).set({ evidence: { ...f.failure.evidence,
      nativeFailureBlock: { runId: f.failed.id, statusVersion: f.blocked.statusVersion + 1 } } }).where(eq(issueRecoveryActions.id, f.failure.id));
    if (change === "extra task version") await db.update(issues).set({ statusVersion: sql`${issues.statusVersion}+1` }).where(eq(issues.id, f.issue.id));
    if (change === "foreign execution") await db.update(issues).set({ executionRunId: f.reviewerRun.id }).where(eq(issues.id, f.issue.id));
    if (change === "artifact") await db.update(documentRevisions).set({ body: "Different unreviewed artifact" }).where(eq(documentRevisions.id, f.revision.id));
    if (change === "native binding") { const execution = structuredClone(f.execution); execution.binding.runId = f.runId;
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.failed.id)); }
    if (change === "reference binding") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: f.execution,
      referenceFolderAdmission: { schema: "paperclip.reference-folder-admission.v1", binding: { companyId: f.company.id,
        agentId: f.builder.id, runId: f.failed.id, projectId: f.workspace.projectId, workspaceId: randomUUID() },
        workspaceDirectory: f.workspace.cwd!, revision: 1, paths: [] } } }).where(eq(heartbeatRuns.id, f.failed.id));
    const before = await f.read();
    const { isUnclaimedScopedReturnPreparation } = await import("../services/scoped-review-admission.js");
    expect(await isUnclaimedScopedReturnPreparation(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.failed.id })).toBe(false);
    expect(await f.read()).toEqual(before);
  });

  it("scoped return admission checks durable receipt, settlement, task version and exact artifact before workspace startup",async()=>{
    const f=await reviewingDraftFixture();ok(await request(f.reviewerApp).post(`/api/issues/${f.issue.id}/interactions/${f.scope.interactionId}/accept`).send({}));
    const [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));
    const [returned]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.builder.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"queued",wakeupRequestId:scope.returnWakeupId,contextSnapshot:{issueId:f.issue.id,scopedReviewId:scope.id}}).returning();
    const {assertScopedRunAdmission}=await import("../services/scoped-review-admission.js");
    const identity={companyId:f.company.id,issueId:f.issue.id,runId:returned.id};
    await expect(assertScopedRunAdmission(db,identity)).rejects.toThrow("Reviewer must settle");
    await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,f.reviewerRun.id));await db.update(issues).set({executionRunId:null}).where(eq(issues.id,f.issue.id));
    await expect(assertScopedRunAdmission(db,identity)).resolves.toBeUndefined();
    await db.update(issues).set({statusVersion:sql`${issues.statusVersion}+1`}).where(eq(issues.id,f.issue.id));
    await expect(assertScopedRunAdmission(db,identity)).rejects.toThrow("no longer current");
    expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it("scoped cancellation withdraws an unsubmitted draft idempotently without spending or dispatching",async()=>{
    const f=await draftFixture();ok(await request(f.app).post(`/api/issues/${f.issue.id}/scoped-reviews`).send(f.requestBody).then(r=>({...r,status:r.status===201?200:r.status})));
    const url=`/api/issues/${f.issue.id}/scoped-reviews/${f.requestBody.id}/cancel`,body={requestId:randomUUID(),expectedVersion:0,reason:"Replace this unsubmitted plan"};
    ok(await request(f.app).post(url).send(body));ok(await request(f.app).post(url).send(body));
    const [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.requestBody.id));expect(scope).toMatchObject({state:"cancelled",version:1,sourceDecisionId:null,cancellation:{requestId:body.requestId,targetRunIds:[]}});
    expect(await f.ledger()).toBeUndefined();expect(await f.read()).toMatchObject({status:"in_progress",assigneeAgentId:f.builder.id});
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.company.id))).toHaveLength(0);
  });
  it("scoped cancellation persists uncertain native Stop, rejects retargeting and resumes one charged Builder return",async()=>{
    const f=await reviewingDraftFixture(),url=`/api/issues/${f.issue.id}/scoped-reviews/${f.scope.id}/cancel`,body={requestId:randomUUID(),expectedVersion:1,reason:"Discard this stale partial candidate"};
    expect((await request(f.reviewerApp).post(url).send(body)).status).toBe(403);
    await db.update(documents).set({latestBody:"Changed after admission"}).where(eq(documents.id,f.document.id));
    expect((await request(f.reviewerApp).post(`/api/issues/${f.issue.id}/interactions/${f.scope.interactionId}/accept`).send({})).status).toBe(409);
    executionFixture.rejectStop=true;
    try {expect((await request(f.board).post(url).send(body)).status).toBe(500);} finally {executionFixture.rejectStop=false;}
    let [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));expect(scope).toMatchObject({state:"cancelling",cancellation:{requestId:body.requestId,targetRunIds:[f.reviewerRun.id]},returnWakeupId:null});
    expect((await request(f.board).post(url).send({...body,reason:"Different reason"})).status).toBe(409);
    const {assertScopedRunAdmission}=await import("../services/scoped-review-admission.js");
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:f.reviewerRun.id})).rejects.toThrow("cancellation");
    ok(await request(f.board).post(url).send(body));ok(await request(f.board).post(url).send(body));
    [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));expect(scope).toMatchObject({state:"cancelled",verdict:null,verdictRunId:null,cancellation:{targetRunIds:[f.reviewerRun.id]}});
    expect((await f.ledger()).admissions).toHaveLength(1);expect(await f.read()).toMatchObject({status:"todo",assigneeAgentId:f.builder.id});
    const wakes=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,`native-scoped-return:${f.scope.id}:cancelled`));expect(wakes).toHaveLength(1);
    const [returned]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.builder.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"queued",wakeupRequestId:scope.returnWakeupId,contextSnapshot:{issueId:f.issue.id,scopedReviewId:scope.id}}).returning();
    await db.update(issues).set({executionRunId:null}).where(eq(issues.id,f.issue.id));
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:returned.id},{readRunTerminationProof:(await import("../services/heartbeat.js")).heartbeatService(db).readRunTerminationProof})).resolves.toBeUndefined();
  });
  it("enabled protected Reviewer refuses generic human and Builder PATCH before any cycle/task/wake mutation",async()=>{
    const f=await seed(),run=await f.run(f.builder.id,"running");await db.update(issues).set({executionRunId:run.id}).where(eq(issues.id,f.issue.id));const prior=await f.read();
    await db.execute(sql`insert into agent_reviewer_policies(company_id,agent_id,revision,enabled,updated_by_user_id) values(${f.company.id},${f.reviewer.id},1,true,${f.userId})`);
    for(const app of [f.board,await f.agentApp(f.builder.id,run.id)]) {
      const response=await patch(app,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()});expect(response.status,JSON.stringify(response.body)).toBe(409);expect(response.body.error).toContain("paperclip_finish");
      const after=await f.read();expect(after,JSON.stringify(Object.keys(after).filter(key=>JSON.stringify((after as any)[key])!==JSON.stringify((prior as any)[key])).map(key=>({key,before:(prior as any)[key],after:(after as any)[key]})))).toEqual(prior);expect(await f.ledger()).toBeUndefined();expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.company.id))).toHaveLength(0);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id)))[0].status).toBe("running");
    }
    await db.execute(sql`update agent_reviewer_policies set enabled=false where company_id=${f.company.id} and agent_id=${f.reviewer.id}`);
    await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,run.id));await db.update(issues).set({executionRunId:null}).where(eq(issues.id,f.issue.id));
    ok(await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it("locked protected-role recheck refuses policy enablement after a role-off preview without persistence",async()=>{
    const f=await seed(),run=await f.run(f.builder.id),prior=await f.read();
    const {applyIssueExecutionPolicyTransition,normalizeIssueExecutionPolicy}=await import("../services/issue-execution-policy.js");
    const {readReviewBudgetPreviewContext,applyLockedReviewBudgetTransition}=await import("../services/review-cycle-budget-store.js");
    const policy=normalizeIssueExecutionPolicy(prior.executionPolicy),transition={issue:prior,policy,previousPolicy:policy,requestedStatus:"done",requestedAssigneePatch:{},actor:{agentId:f.builder.id,runId:run.id},reviewCycleNow:new Date().toISOString(),
      ...await readReviewBudgetPreviewContext(db,{companyId:f.company.id,issueId:f.issue.id}),reviewCycleAdmission:{id:run.id,companyId:f.company.id,issueId:f.issue.id,builderAgentId:f.builder.id,builderRunId:run.id,candidateId:`run:${run.id}`,kind:"normal" as const,scopeId:null}};
    const expected=applyIssueExecutionPolicyTransition(transition);await db.execute(sql`insert into agent_reviewer_policies(company_id,agent_id,revision,enabled,updated_by_user_id) values(${f.company.id},${f.reviewer.id},1,true,${f.userId})`);
    const persist=vi.fn(async()=>{});await expect(db.transaction(tx=>applyLockedReviewBudgetTransition(tx,{companyId:f.company.id,issueId:f.issue.id,transition,expectedPreview:expected,expectedStoredPolicy:policy},persist))).rejects.toThrow("accepted native completion result");
    expect(persist).not.toHaveBeenCalled();expect(await f.ledger()).toBeUndefined();expect(await f.read()).toEqual(prior);
  });
  it("enabled protected Reviewer accepts the real native completion producer and derives its selected stage proof",async()=>{
    const base=await draftFixture();await db.execute(sql`insert into agent_reviewer_policies(company_id,agent_id,revision,enabled,updated_by_user_id) values(${base.company.id},${base.reviewer.id},1,true,${base.userId})`);
    const candidate=await nativeCandidate(base),execution=structuredClone(base.execution);execution.binding.runId=candidate.runId;
    await db.update(heartbeatRuns).set({runnerProfileJson:{nativeExecutionInput:execution}}).where(eq(heartbeatRuns.id,candidate.runId));
    const committed=await candidate.commitNativeStatusDecision(candidate.input);expect(committed.issue).toMatchObject({status:"in_review",assigneeAgentId:base.reviewer.id});
    const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,base.company.id),eq(agentWakeupRequests.agentId,base.reviewer.id)));
    const {getNativeStageReviewAssignment}=await import("../services/native-runtime/native-stage-review.js");expect(await getNativeStageReviewAssignment(db,{companyId:base.company.id,issueId:base.issue.id,agentId:base.reviewer.id,contextSnapshot:(wake.payload as any)._paperclipWakeContext})).not.toBeNull();
    expect((await base.ledger()).admissions).toHaveLength(1);
  });
  it("actual normal-stage pre-native workspace admission ignores incidental binding runId but keeps acting-run fences",async()=>{
    const f=await stageFixture();
    const {heartbeatService}=await import("../services/heartbeat.js");
    await heartbeatService(db).dispatchPendingNativeStatusWakeups({companyId:f.company.id,requestId:f.wake.id});
    const [delivery]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.requestedByActorId,`native-status-wake-dispatch:${f.wake.id}`));
    expect(delivery).toBeDefined();
    await db.update(agentWakeupRequests).set({status:"failed"}).where(eq(agentWakeupRequests.id,delivery.id));
    await db.update(heartbeatRuns).set({runtimeMode:"legacy",nativeIssueId:null}).where(eq(heartbeatRuns.id,f.reviewerRun.id));
    const protectedRun=await qualifyProtectedReview(f,true);
    try {
      expect(protectedRun.admission.record.assignment.kind).toBe("execution_stage_review");
      const {resolveNativeReviewerAssignment}=await import("../services/native-runtime/reviewer-native-assignment.js");
      const input={companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,contextSnapshot:f.context,actingRunId:f.reviewerRun.id};
      expect(await resolveNativeReviewerAssignment(db,input)).not.toBeNull();
      expect(await resolveNativeReviewerAssignment(db,{...input,actingRunId:randomUUID()})).toBeNull();
      await db.update(heartbeatRuns).set({runtimeMode:"legacy",nativeIssueId:null}).where(eq(heartbeatRuns.id,f.reviewerRun.id));
      expect(await resolveNativeReviewerAssignment(db,input)).toBeNull();
      expect((await f.ledger()).admissions).toHaveLength(1);
    }finally{await protectedRun.close();}
  });
  it("normal-stage authority selects the exact committer effect intent across failed duplicate delivery and rejects forged intent",async()=>{
    const f=await stageFixture();
    const {heartbeatService}=await import("../services/heartbeat.js");
    await heartbeatService(db).dispatchPendingNativeStatusWakeups({companyId:f.company.id,requestId:f.wake.id});
    const [delivery]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.requestedByActorId,`native-status-wake-dispatch:${f.wake.id}`));
    expect(delivery).toBeDefined();expect(delivery.id).not.toBe(f.wake.id);expect(delivery.idempotencyKey).toBe(f.wake.idempotencyKey);
    await db.update(agentWakeupRequests).set({status:"failed"}).where(eq(agentWakeupRequests.id,delivery.id));
    const {getNativeStageReviewAssignment,getNativeStageReviewRecoveryContext}=await import("../services/native-runtime/native-stage-review.js");
    const input={companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,contextSnapshot:{...f.context,nativeStatusWakeIntentId:f.wake.id}};
    expect((await getNativeStageReviewAssignment(db,input))?.wake.id).toBe(f.wake.id);
    expect(await getNativeStageReviewAssignment(db,{...input,contextSnapshot:{...f.context,nativeStatusWakeIntentId:delivery.id}})).toBeNull();
    expect(await getNativeStageReviewRecoveryContext(db,input)).toMatchObject({nativeStageDecisionId:f.context.nativeStageDecisionId,nativeStageAdmissionId:f.context.nativeStageAdmissionId,nativeStageStatusVersion:f.context.nativeStageStatusVersion,nativeStatusWakeIntentId:f.wake.id,forceFreshSession:true});
    await db.update(statusDecisionEffects).set({deliveryState:"failed"}).where(and(eq(statusDecisionEffects.decisionId,f.context.nativeStageDecisionId),eq(statusDecisionEffects.effectKind,"execution_stage_wake")));
    expect(await getNativeStageReviewAssignment(db,input)).toBeNull();expect(await getNativeStageReviewRecoveryContext(db,input)).toBeNull();
  });
  it("normal-stage recovery enqueue derives native whitelist and guards current issue version without granting stale work",async()=>{
    const f=await stageFixture();
    await db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.reviewerRun.id));
    await db.update(issues).set({executionRunId:null,checkoutRunId:null}).where(eq(issues.id,f.issue.id));
    await db.update(agentWakeupRequests).set({status:"completed",finishedAt:new Date()}).where(eq(agentWakeupRequests.id,f.wake.id));
    const {recoveryService}=await import("../services/recovery/service.js");
    const enqueueWakeup=vi.fn(async()=>null);
    const service=recoveryService(db,{enqueueWakeup});
    await service.reconcileStrandedAssignedIssues({companyId:f.company.id,issueId:f.issue.id,skipRelatedRecovery:true,skipExternalConversationSettlement:true});
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [agentId,options]=(enqueueWakeup.mock.calls as unknown as [string,any][])[0];
    expect(agentId).toBe(f.reviewer.id);expect(options.contextSnapshot).toMatchObject({nativeStageDecisionId:f.context.nativeStageDecisionId,nativeStageAdmissionId:f.context.nativeStageAdmissionId,nativeStageStatusVersion:f.context.nativeStageStatusVersion,nativeStatusWakeIntentId:f.wake.id,forceFreshSession:true});
    expect(options.payload).toMatchObject({nativeStageDecisionId:f.context.nativeStageDecisionId,nativeStageAdmissionId:f.context.nativeStageAdmissionId,nativeStageStatusVersion:f.context.nativeStageStatusVersion,nativeStatusWakeIntentId:f.wake.id});
    expect(options.issueStateGuard).toEqual({statuses:["in_review"],assigneeAgentId:f.reviewer.id,statusVersion:f.context.nativeStageStatusVersion});
    enqueueWakeup.mockClear();await db.update(issues).set({statusVersion:sql`${issues.statusVersion}+1`}).where(eq(issues.id,f.issue.id));
    await service.reconcileStrandedAssignedIssues({companyId:f.company.id,issueId:f.issue.id,skipRelatedRecovery:true,skipExternalConversationSettlement:true});
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await db.update(issues).set({statusVersion:f.context.nativeStageStatusVersion,workspaceBindingRevision:sql`${issues.workspaceBindingRevision}+1`}).where(eq(issues.id,f.issue.id));
    await service.reconcileStrandedAssignedIssues({companyId:f.company.id,issueId:f.issue.id,skipRelatedRecovery:true,skipExternalConversationSettlement:true});
    expect(enqueueWakeup).not.toHaveBeenCalled();expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it.each(["current", "changed_stage", "changed_workspace", "operator_stop", "active_successor",
    "different_receipt", "duplicate_receipt", "previous_reviewer_run", "scheduling_suppressed",
    "paused_reviewer", "builder_cleanup", "cancelled_run_cleanup"] as const)(
    "resumes only the original deferred native Reviewer after the former Builder releases: %s", async (scenario) => {
      const f = await seed();
      for (let cycle = 1; cycle <= 4; cycle++) {
        const prior = await nativeCandidate(f);
        await prior.commitNativeStatusDecision(prior.input);
        const reviewer = await f.run(f.reviewer.id);
        ok(await patch(await f.agentApp(f.reviewer.id, reviewer.id), f.issue.id, {
          status: "in_progress", comment: `Request synthetic correction ${cycle}`,
        }));
      }
      const base = await draftFixture(f);
      const candidate = await nativeCandidate(base);
      const execution = structuredClone(base.execution);
      execution.binding.runId = candidate.runId;
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, base.runId));
      await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(),
        responsibleUserId: f.userId, runnerProfileJson: { nativeExecutionInput: execution },
      }).where(eq(heartbeatRuns.id, candidate.runId));
      const committed = await candidate.commitNativeStatusDecision(candidate.input);
      expect(committed.issue).toMatchObject({ status: "in_review", assigneeAgentId: f.reviewer.id });
      const [intent] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.agentId, f.reviewer.id),
        sql`${agentWakeupRequests.payload}->>'nativeStageAdmissionId' = ${candidate.resultId}`,
      ));
      const [older] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id,
        agentId: f.builder.id, source: "automation", reason: "issue_execution_deferred",
        status: "deferred_issue_execution", requestedAt: new Date(intent.requestedAt.getTime() - 1000),
        payload: { issueId: f.issue.id, mutation: "interaction", _paperclipWakeContext: {
          issueId: f.issue.id, wakeReason: "issue_continuation_needed",
        } },
      }).returning();
      const { heartbeatService } = await import("../services/heartbeat.js");
      await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId: f.company.id, requestId: intent.id });
      const [dispatch] = await db.select().from(agentWakeupRequests).where(
        eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${intent.id}`));
      expect(dispatch).toMatchObject({ status: "deferred_issue_execution", runId: null });
      const [intentAfterDispatch] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent.id));
      expect(intentAfterDispatch).toMatchObject({ status: "coalesced", runId: null });

      const { createHeartbeatQueueTestDependencies } = await import("./helpers/heartbeat-queue.js");
      const { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } = await import("../services/heartbeat/queue.js");
      const { createWakeQueue } = await import("../modules/wake-queue/index.js");
      const { mergeCoalescedContextSnapshot } = await import("../services/heartbeat/run-preparation.js");
      const { createHeartbeatRunControl } = await import("../services/heartbeat/run-control.js");
      const { callbacks: runControlCallbacks } = await import("../services/heartbeat/__tests__/run-control-fixtures.js");
      const deps = createHeartbeatQueueTestDependencies(db);
      deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0]);
      const nativeQueue = createWakeQueue(db, {
        resolveResponsibleUserId: async () => f.userId,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
        wakeAdmissionHelpers: { filterZombieCoalesceTarget: deps.filterZombieCoalesceTarget,
          mergeCoalescedContextSnapshot, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
        recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
      });
      const controlDeps = runControlCallbacks(db);
      controlDeps.wakeQueue.releaseIssueExecution = nativeQueue.releaseIssueExecution;
      const control = createHeartbeatRunControl(db, controlDeps);
      deps.releaseIssueExecutionAndPromote.mockImplementation(control.releaseIssueExecutionAndPromote);
      const queue = createHeartbeatQueue(db, deps);

      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, candidate.runId));
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, candidate.runId));
      const released = await nativeQueue.releaseIssueExecution({ companyId: f.company.id,
        runId: candidate.runId, now: new Date(), suppressImmediateRecovery: true });
      expect(released.outcome).toMatchObject({ kind: "promoted", run: { wakeupRequestId: older.id, agentId: f.builder.id } });
      const [formerBuilder] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, older.id));
      expect(await queue.claimQueuedRun(formerBuilder)).toBeNull();
      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, formerBuilder.id));
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed", startedAt: null, nativeIssueId: null });

      const ledger = await f.ledger();
      expect(ledger.admissions).toHaveLength(5);
      if (scenario === "changed_stage") await db.update(issues).set({ statusVersion: sql`${issues.statusVersion}+1` }).where(eq(issues.id, f.issue.id));
      if (scenario === "changed_workspace") await db.update(issues).set({ workspaceBindingRevision: sql`${issues.workspaceBindingRevision}+1` }).where(eq(issues.id, f.issue.id));
      if (scenario === "operator_stop") await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, cancelled.id));
      if (scenario === "active_successor") await db.insert(heartbeatRuns).values({ companyId: f.company.id,
        agentId: f.reviewer.id, status: "queued", issueId: f.issue.id, scopeKind: "issue", contextSnapshot: { issueId: f.issue.id } });
      if (scenario === "different_receipt") await db.update(agentWakeupRequests).set({ idempotencyKey: "unrelated" }).where(eq(agentWakeupRequests.id, dispatch.id));
      if (scenario === "duplicate_receipt") await db.insert(agentWakeupRequests).values({ ...dispatch, id: randomUUID() });
      if (scenario === "previous_reviewer_run") await db.insert(heartbeatRuns).values({ companyId: f.company.id,
        agentId: f.reviewer.id, status: "failed", startedAt: new Date(), finishedAt: new Date(),
        // Older than the stray cancellation, so choosing a terminal latest
        // row alone cannot distinguish an already attempted stage.
        createdAt: new Date(cancelled.createdAt.getTime() - 1),
        issueId: f.issue.id, scopeKind: "issue", contextSnapshot: dispatch.payload?._paperclipWakeContext as Record<string, unknown>,
      });
      if (scenario === "scheduling_suppressed") deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
      if (scenario === "paused_reviewer") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewer.id));
      if (scenario === "builder_cleanup" || scenario === "cancelled_run_cleanup") {
        const runId = scenario === "builder_cleanup" ? candidate.runId : cancelled.id;
        await db.update(heartbeatRuns).set({ runnerProfileJson:
          sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || '{"nativeWorkspaceFinalizationOwner": "fixture"}'::jsonb`,
        }).where(eq(heartbeatRuns.id, runId));
      }

      const before = await f.read();
      expect(before.executionRunId).toBeNull();
      const scope = { companyId: f.company.id, requestId: dispatch.id };
      const recover = () => Promise.all([queue.resumeDeferredExecutionReceipts(scope), queue.resumeDeferredExecutionReceipts(scope)]);
      if (scenario === "current") {
        const { registerDeferredReceiptWork } = await import("../services/heartbeat/deferred-receipt-work.js");
        const { createDeliveryWorkCoordinator } = await import("../services/delivery-work-coordinator.js");
        const onError = vi.fn();
        const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
        const resume = vi.fn(async (request: { requestId?: string }) => {
          if (request.requestId === dispatch.id) await recover();
        });
        const worker = registerDeferredReceiptWork(db, coordinator, { resume,
          settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true);
        try {
          await worker.ready;
          await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(expect.objectContaining(scope)), { timeout: 5000 });
          expect(onError).not.toHaveBeenCalled();
        } finally {
          await worker.stop();
        }
      } else {
        await recover();
      }
      await queue.resumeDeferredExecutionReceipts(scope);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, dispatch.id));
      if (scenario === "current") {
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ agentId: f.reviewer.id, status: "queued", contextSnapshot: {
          issueId: f.issue.id, nativeStageAdmissionId: candidate.resultId,
          nativeStageStatusVersion: before.statusVersion, nativeStatusWakeIntentId: intent.id,
        } });
        expect(await queue.claimQueuedRun(runs[0])).toMatchObject({ id: runs[0].id, status: "running" });
      } else {
        expect(runs).toHaveLength(0);
      }
      expect(await f.ledger()).toEqual(ledger);
      expect((await f.read()).statusVersion).toBe(before.statusVersion);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent.id)))[0]).toEqual(intentAfterDispatch);
      expect(deps.executeRun).not.toHaveBeenCalled();
    }, 90000);
  it.each(["current","stale_version","missing_context"] as const)("normal-stage bounded retry revalidates canonical authority under native issue lock: %s",async mode=>{
    const f=await stageFixture();
    const [failed]=await db.update(heartbeatRuns).set({runtimeMode:"legacy",nativeIssueId:null,status:"failed",errorCode:"adapter_failed",error:"Synthetic pre-native admission failure",resultJson:{executionRecovery:{kind:"bootstrap",providerWorkStarted:false}},finishedAt:new Date(),contextSnapshot:mode==="missing_context"?{issueId:f.issue.id}:f.context}).where(eq(heartbeatRuns.id,f.reviewerRun.id)).returning();
    await db.update(issues).set({executionRunId:null,checkoutRunId:null,...(mode==="stale_version"?{statusVersion:sql`${issues.statusVersion}+1`}:{})}).where(eq(issues.id,f.issue.id));
    await db.update(agentWakeupRequests).set({status:"completed",finishedAt:new Date()}).where(eq(agentWakeupRequests.id,f.wake.id));
    const {heartbeatService}=await import("../services/heartbeat.js");
    const result=await heartbeatService(db).scheduleBoundedRetry(failed.id,{random:()=>0,delayMs:60000,retryReason:"transient_failure",maxAttempts:1});
    const successors=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,failed.id));
    if(mode==="current") {
      expect(result).toMatchObject({outcome:"scheduled"});expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot).toMatchObject({nativeStageDecisionId:f.context.nativeStageDecisionId,nativeStageAdmissionId:f.context.nativeStageAdmissionId,nativeStageStatusVersion:f.context.nativeStageStatusVersion,nativeStatusWakeIntentId:f.wake.id,forceFreshSession:true});
      const same=await heartbeatService(db).scheduleBoundedRetry(failed.id,{random:()=>0,delayMs:60000,retryReason:"transient_failure",maxAttempts:1});
      expect(same).toMatchObject({outcome:"scheduled",run:{id:successors[0].id}});
    }else {expect(result).toMatchObject({outcome:"not_scheduled",errorCode:"native_stage_review_retry_assignment_changed"});expect(successors).toHaveLength(0);}
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,failed.id)))[0].contextSnapshot).toEqual(failed.contextSnapshot);
    expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it.each(["admit", "unrelated version change", "provider started", "owned Stop", "unsettled predecessor",
    "different candidate", "different workspace", "different Reviewer", "claim configuration changed"] as const)(
    "keeps the sixth review receipt immutable for %s", async (scenario) => {
    const base = await seed();
    const { createReviewCycleBudget, admitReviewCycle, grantReviewCycles } = await import("../services/total-review-budget.js");
    const timestamp = new Date().toISOString();
    let budget = createReviewCycleBudget(base.company.id, base.issue.id);
    for (let cycle = 1; cycle <= 5; cycle++) {
      const history = await base.run(base.builder.id);
      budget = admitReviewCycle(budget, {
        id: randomUUID(), companyId: base.company.id, issueId: base.issue.id,
        builderAgentId: base.builder.id, builderRunId: history.id,
        candidateId: "synthetic prior candidate " + cycle, kind: "normal", scopeId: null,
      }, timestamp).budget;
    }
    budget = grantReviewCycles(budget, {
      id: randomUUID(), additionalCycles: 1, reason: "Synthetic sixth-cycle recovery fixture",
    }, { userId: base.userId }, true, timestamp);
    await db.insert(issueReviewCycleBudgets).values({
      companyId: base.company.id, issueId: base.issue.id, ledger: budget,
    });
    await db.update(issues).set({ statusVersion: 20 }).where(eq(issues.id, base.issue.id));

    const f = await stageFixture(base);
    [f.wake] = await db.update(agentWakeupRequests).set({ status: "coalesced" })
      .where(eq(agentWakeupRequests.id, f.wake.id)).returning();
    const stage = await f.read();
    const savedLedger = await f.ledger();
    expect(stage).toMatchObject({ status: "in_review", statusVersion: 21, assigneeAgentId: f.reviewer.id });
    expect(f.context.nativeStageStatusVersion).toBe(21);
    expect(savedLedger.admissions).toHaveLength(6);
    expect(savedLedger.allowances).toHaveLength(1);
    await db.update(heartbeatRuns).set({
      status: "failed", errorCode: "adapter_failed", error: "native_session_supervisor_busy", finishedAt: new Date(),
      contextSnapshot: { ...f.context, nativeStatusWakeIntentId: f.wake.id },
      runnerProfileJson: { nativeExecutionInput: { ...f.execution,
        binding: { ...f.execution.binding, agentId: f.reviewer.id, runId: f.reviewerRun.id } } },
    }).where(eq(heartbeatRuns.id, f.reviewerRun.id));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issue.id));

    const { getNativeStageReviewAssignment, getNativeStageReviewRecoveryContext } =
      await import("../services/native-runtime/native-stage-review.js");
    const scope = { companyId: f.company.id, issueId: f.issue.id, agentId: f.reviewer.id };
    expect(await getNativeStageReviewRecoveryContext(db, scope)).toMatchObject({
      nativeStageStatusVersion: 21, nativeStageAdmissionId: savedLedger.admissions.at(-1).id,
      nativeStatusWakeIntentId: f.wake.id,
    });

    if (scenario === "unrelated version change") {
      await db.update(issues).set({ statusVersion: 23 }).where(eq(issues.id, f.issue.id));
    } else {
      // Start at the observed terminal-failure projection. The real committer
      // must advance this same Builder result from blocked v22 to review v23.
      await db.update(issues).set({ status: "blocked", statusVersion: 22 }).where(eq(issues.id, f.issue.id));
      await db.insert(nativeRunFinalizations).values({
        companyId: f.company.id, issueId: f.issue.id, runId: f.reviewerRun.id, phase: "terminal_failure",
        failureCode: "native_continuation_requires_reconciliation", recoveryState: "blocked",
      });
      await db.insert(issueRecoveryActions).values({
        companyId: f.company.id, sourceIssueId: f.issue.id, kind: "active_run_watchdog", status: "resolved",
        ownerType: "board", returnOwnerAgentId: f.reviewer.id, cause: "native_continuation_requires_reconciliation",
        fingerprint: randomUUID(), nextAction: "Inspect retained native startup",
        evidence: { runId: f.reviewerRun.id, nativeFailureBlock: { runId: f.reviewerRun.id, statusVersion: 22 },
          automaticRecovery: { replay: "blocked" } },
      });
      await db.insert(heartbeatRunEvents).values([
        ...["native.coordinator.claim", "task.prepare"].map((span, index) => ({
          companyId: f.company.id, agentId: f.reviewer.id, runId: f.reviewerRun.id, seq: index + 1,
          eventType: "run.performance.span", stream: "system",
          payload: { schema: "paperclip.run-performance-span.v1", span, outcome: index ? "failed" : "ok" },
        })),
        ...(scenario === "provider started" ? [{
          companyId: f.company.id, agentId: f.reviewer.id, runId: f.reviewerRun.id, seq: 3,
          eventType: "native.process_start_requested", stream: "system",
        }] : []),
      ]);
      const [original] = await db.select().from(workAssessments)
        .where(eq(workAssessments.id, f.candidate.assessmentId));
      const [assessment] = await db.insert(workAssessments).values({
        companyId: f.company.id, issueId: f.issue.id, runId: f.candidate.runId,
        resultId: original.resultId, contractId: original.contractId,
        triggerKind: "native_reconciliation", triggerActorCompanyId: f.company.id,
        priorIssueStatus: "blocked", priorStatusVersion: 22, priorDecisionId: f.committed.decision.id,
        policyVersion: original.policyVersion, assessmentJson: original.assessmentJson,
        inputDigest: f.candidate.nativeSha256({ previous: original.id, source: "sixth-recovery-fixture" }),
        supersedesAssessmentId: original.id,
      }).returning();
      const reassessed = await f.candidate.commitNativeStatusDecision({
        ...f.candidate.input,
        assessmentId: assessment.id,
        priorStatus: "blocked",
        priorStatusVersion: 22,
        priorDecisionId: f.committed.decision.id,
        supersedesCommittedDecisionId: f.committed.decision.id,
        decision: { ...f.candidate.input.decision, effects: [{ kind: "append_superseding_assessment" }] },
      });
      const [savedProjection] = await db.select().from(statusDecisions)
        .where(eq(statusDecisions.id, reassessed.decision.id));
      expect(savedProjection).toMatchObject({
        fromStatus: "blocked", toStatus: "in_review", reasonCode: "task_total_review_pending",
        applicationState: "applied", supersedesDecisionId: f.committed.decision.id,
        decisionJson: { priorStatusVersion: 22, projectedStatusVersion: 23 },
      });
      const effects = await db.select().from(statusDecisionEffects)
        .where(eq(statusDecisionEffects.decisionId, reassessed.decision.id));
      expect(effects.map(effect => effect.effectKind).sort()).toEqual([
        "append_superseding_assessment", "issue_status_projection",
      ]);
      const [currentOwner] = await db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, f.candidate.runId));
      expect(currentOwner).toMatchObject({
        phase: "committed", resultId: f.candidate.resultId, decisionId: reassessed.decision.id,
      });
    }
    expect(await getNativeStageReviewAssignment(db, { ...scope, contextSnapshot: f.context })).toBeNull();
    expect(await getNativeStageReviewRecoveryContext(db, scope)).toBeNull();

    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, f.reviewer.id));
    const [occupied] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.reviewer.id, status: "running", startedAt: new Date(),
    }).returning();
    const body = { idempotencyKey: randomUUID(), observedRunId: f.reviewerRun.id };

    executionFixture.holdTaskRetryNudge = true;
    try {
      const response = await request(f.board).post("/api/issues/" + f.issue.id + "/retry").send(body);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      expect(response.body.accepted).toBe(true);
      if (scenario === "owned Stop") await db.update(heartbeatRuns).set({ resultJson: { operatorInterrupted: true } })
        .where(eq(heartbeatRuns.id, f.reviewerRun.id));
      if (scenario === "unsettled predecessor") await db.update(nativeRunFinalizations).set({ leaseOwner: "retained-owner" })
        .where(eq(nativeRunFinalizations.runId, f.reviewerRun.id));
      if (scenario === "different workspace") await db.update(issues).set({
        workspaceBindingRevision: stage.workspaceBindingRevision + 1,
      }).where(eq(issues.id, f.issue.id));
      if (scenario === "different Reviewer") await db.update(issues).set({ assigneeAgentId: f.builder.id })
        .where(eq(issues.id, f.issue.id));
      if (scenario === "different candidate") await db.update(nativeRunResults).set({ canonicalSha256: "1".repeat(64) })
        .where(eq(nativeRunResults.id, f.candidate.resultId));

      const heartbeat = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
      const resume = () => heartbeat.heartbeatService(db).resumeTaskRetry(f.company.id, response.body.requestId);
      const retries = () => db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.company.id),
        sql`context_snapshot->>'taskRetryRequestId' = ${response.body.requestId}`,
      ));
      if (scenario !== "admit" && scenario !== "claim configuration changed") {
        await expect(resume()).rejects.toMatchObject({ status: 409,
          details: { code: "native_stage_review_retry_assignment_changed" } });
        expect(await retries()).toHaveLength(0);
      } else {
        await resume();
        const successors = await retries();
        expect(successors).toHaveLength(1);
        const successor = successors[0];
        expect(successor).toMatchObject({ status: "queued", retryOfRunId: f.reviewerRun.id,
          wakeupRequestId: response.body.requestId, contextSnapshot: {
            nativeStageStatusVersion: 23, nativeStageRetryRequestId: response.body.requestId,
            nativeStatusWakeIntentId: f.wake.id, nativeStageAdmissionId: savedLedger.admissions.at(-1).id,
          },
        });
        const replay = await request(f.board).post("/api/issues/" + f.issue.id + "/retry").send(body);
        expect(replay.body.requestId).toBe(response.body.requestId);
        await resume();
        expect(await retries()).toHaveLength(1);
        await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, occupied.id));
        const { createHeartbeatQueueTestDependencies } = await import("./helpers/heartbeat-queue.js");
        const { createHeartbeatQueue } = await import("../services/heartbeat/queue.js");
        const { issueService } = await import("../services/issues.js");
        const deps = createHeartbeatQueueTestDependencies(db), service = issueService(db);
        deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0]);
        deps.issuesSvc.getDependencyReadiness.mockImplementation(service.getDependencyReadiness);
        deps.issuesSvc.listDependencyReadiness.mockImplementation(service.listDependencyReadiness);
        const claim = () => createHeartbeatQueue(db, deps).claimQueuedRun(successor);
        if (scenario === "claim configuration changed") {
          await db.update(agents).set({ adapterConfig: { modified: true } }).where(eq(agents.id, f.reviewer.id));
          await expect(claim()).rejects.toMatchObject({ status: 403,
            details: { code: "native_stage_review_retry_assignment_changed" } });
        } else {
          const claimed = await claim();
          expect(claimed).toMatchObject({ id: successor.id, status: "running" });
          expect(deps.executeRun).not.toHaveBeenCalled();
          const protectedRun = await qualifyProtectedReview({ ...f, reviewerRun: claimed! }, true);
          try {
            const assignment = protectedRun.admission.record.assignment;
            expect(assignment).toMatchObject({ kind: "execution_stage_review", statusVersion: 23 });
            if (assignment.kind !== "execution_stage_review") throw new Error("Expected native stage");
            const { decideNativeStageReview } = await import("../services/native-runtime/native-stage-review-decision.js");
            const { nativeStageReviewOutcome } = await import("../services/native-runtime/native-stage-review.js");
            const input = { ...scope, runId: successor.id, contextSnapshot: successor.contextSnapshot };
            const verdict = { id: randomUUID(), stageId: assignment.stageId, admissionId: assignment.admissionId,
              sourceDecisionId: assignment.sourceDecisionId, expectedStatusVersion: 23,
              outcome: "approved" as const, body: "Approved exact synthetic sixth candidate" };
            expect(await decideNativeStageReview(db, { ...input, request: verdict, actor: protectedRun.actor }))
              .toMatchObject({ replayed: false });
            expect(await decideNativeStageReview(db, { ...input, request: verdict, actor: protectedRun.actor }))
              .toMatchObject({ replayed: true });
            expect(await nativeStageReviewOutcome(db, input)).toBe("resolved");
            expect(await f.read()).toMatchObject({ status: "in_review", assigneeUserId: f.userId,
              executionState: { currentStageType: "approval" } });
          } finally {
            await protectedRun.close();
          }

          const approved = await f.read();
          const { reassessNativeStatusFromSource } = await import("../services/native-runtime/native-status-reassessment.js");
          const [builderOwner] = await db.select().from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, f.candidate.runId));
          expect(await reassessNativeStatusFromSource(db, {
            companyId: f.company.id, issueId: f.issue.id, agentId: f.builder.id, runId: f.candidate.runId,
            issueStatus: approved.status, issueStatusVersion: approved.statusVersion,
            issueDecisionId: approved.lastStatusDecisionId, coordinatorPhase: "committed",
            decisionId: builderOwner.decisionId, assessmentId: builderOwner.assessmentId,
            nativeStatusWakeIntentId: null,
          })).toMatchObject({ kind: "committed", result: { reconciliationAction: "prior_status_terminal_preserved" } });

          // Synthetic accepted report after the actual Board and stage flows.
          // The native finalizer must settle it without creating a new stage.
          const contractId = randomUUID(), resultId = randomUUID();
          const contract = { revision: "reassessed-stage-retry", objective: "Deliver the recorded review", criteria: [] };
          const contractSha = f.candidate.nativeSha256(contract);
          await db.insert(completionContracts).values({
            id: contractId, companyId: f.company.id, issueId: f.issue.id, revision: approved.statusVersion + 1,
            schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v13",
            risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
            contractJson: contract, canonicalSha256: contractSha, createdByActorType: "system",
            createdByActorId: "reassessed-stage-retry-fixture",
          });
          await db.update(heartbeatRuns).set({
            completionContractId: contractId, completionContractSha256: contractSha, status: "failed",
            errorCode: "adapter_failed", finishedAt: new Date(), processPid: null, processGroupId: null,
            processStartedAt: null,
          }).where(eq(heartbeatRuns.id, successor.id));
          const resultJson = {
            result: { reportedWorkDisposition: "done", summary: "Exact sixth verdict recorded", attentionRequests: [] },
            terminal: { runTerminalState: "succeeded" },
          };
          const resultSha = f.candidate.nativeSha256(resultJson);
          await db.insert(nativeRunResults).values({
            id: resultId, companyId: f.company.id, issueId: f.issue.id, runId: successor.id,
            completionContractId: contractId, serverFingerprint: resultSha, schemaStatus: "accepted",
            canonicalSha256: resultSha, resultJson,
          });
          await db.insert(nativeRunFinalizations).values({
            runId: successor.id, companyId: f.company.id, issueId: f.issue.id, resultId,
            phase: "retryable_failure", failureCode: "side_effect_planning_failed",
          });
          const { finalizeNativeRun } = await import("../services/native-runtime/native-run-finalizer.js");
          expect(await finalizeNativeRun({
            db, runId: successor.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true,
            skipExternalConversationSettlement: true, skipExternalAgentSettlement: true,
          })).toMatchObject({ phase: "committed", resultId });
          const [settled] = await retries();
          expect(settled.status).toBe("succeeded");
          expect(await f.read()).toMatchObject({ statusVersion: approved.statusVersion, assigneeUserId: f.userId,
            executionState: { currentStageType: "approval" } });
          expect(await db.select().from(issueExecutionDecisions)
            .where(eq(issueExecutionDecisions.createdByRunId, successor.id))).toHaveLength(1);
        }
      }
    } finally {
      executionFixture.holdTaskRetryNudge = false;
    }

    expect(await f.ledger()).toEqual(savedLedger);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id)))[0]).toEqual(f.wake);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.reviewerRun.id)))[0].status).toBe("failed");
  });

  it("normal-stage owner TaskRetry carries canonical authority from missing-context failure through real queue and protected startup",async()=>{
    const f=await stageFixture();
    const [failed]=await db.update(heartbeatRuns).set({runtimeMode:"legacy",nativeIssueId:null,status:"failed",errorCode:"adapter_failed",error:"Synthetic protected Reviewer startup failure",finishedAt:new Date(),resultJson:{executionRecovery:{kind:"bootstrap",providerWorkStarted:false}},contextSnapshot:{issueId:f.issue.id,taskId:f.issue.id,source:"issue.execution_review_recovery",retryReason:"execution_review_participant_recovery"}}).where(eq(heartbeatRuns.id,f.reviewerRun.id)).returning();
    await db.update(issues).set({executionRunId:null,checkoutRunId:null}).where(eq(issues.id,f.issue.id));
    await db.update(agentWakeupRequests).set({status:"completed",finishedAt:new Date()}).where(eq(agentWakeupRequests.id,f.wake.id));
    await db.update(agents).set({runtimeConfig:{heartbeat:{enabled:false,maxConcurrentRuns:1}}}).where(eq(agents.id,f.reviewer.id));
    const [occupied]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.reviewer.id,status:"running",startedAt:new Date()}).returning();
    executionFixture.holdTaskRetryNudge=true;
    try {
      const body={idempotencyKey:randomUUID(),observedRunId:failed.id};
      const response=await request(f.board).post(`/api/issues/${f.issue.id}/retry`).send(body);
      expect(response.status,JSON.stringify(response.body)).toBe(202);expect(response.body.accepted).toBe(true);
      const actual=await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
      await actual.heartbeatService(db).resumeTaskRetry(f.company.id,response.body.requestId);
      const successors=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,f.company.id),sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${response.body.requestId}`));
      expect(successors).toHaveLength(1);const successor=successors[0];
      expect(successor).toMatchObject({status:"queued",runtimeMode:"legacy",nativeIssueId:null,contextSnapshot:{nativeStageDecisionId:f.context.nativeStageDecisionId,nativeStageAdmissionId:f.context.nativeStageAdmissionId,nativeStageStatusVersion:f.context.nativeStageStatusVersion,nativeStatusWakeIntentId:f.wake.id,previousRunId:failed.id,forceFreshSession:true}});
      const repeated=await request(f.board).post(`/api/issues/${f.issue.id}/retry`).send(body);expect(repeated.body.requestId).toBe(response.body.requestId);
      await actual.heartbeatService(db).resumeTaskRetry(f.company.id,response.body.requestId);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,f.company.id),sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${response.body.requestId}`))).toHaveLength(1);
      await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,occupied.id));
      const {createHeartbeatQueueTestDependencies}=await import("./helpers/heartbeat-queue.js"),{createHeartbeatQueue}=await import("../services/heartbeat/queue.js"),{issueService}=await import("../services/issues.js");
      const deps=createHeartbeatQueueTestDependencies(db),service=issueService(db);deps.getAgent.mockImplementation(async id=>(await db.select().from(agents).where(eq(agents.id,id)))[0]);deps.issuesSvc.getDependencyReadiness.mockImplementation(service.getDependencyReadiness);deps.issuesSvc.listDependencyReadiness.mockImplementation(service.listDependencyReadiness);
      const claimed=await createHeartbeatQueue(db,deps).claimQueuedRun(successor);expect(claimed).toMatchObject({id:successor.id,status:"running"});expect(deps.executeRun).not.toHaveBeenCalled();
      const protectedRun=await qualifyProtectedReview({...f,reviewerRun:claimed!},true);
      try{expect(protectedRun.admission.record.assignment.kind).toBe("execution_stage_review");}finally{await protectedRun.close();}
      expect((await f.ledger()).admissions).toHaveLength(1);expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,failed.id)))[0].contextSnapshot).toEqual(failed.contextSnapshot);
    }finally{executionFixture.holdTaskRetryNudge=false;}
  });
  it.each(["status_version","policy","workspace_revision","newer_source","wrong_assignee"] as const)("normal-stage owner TaskRetry refuses changed authority before successor: %s",async change=>{
    const f=await stageFixture();const [failed]=await db.update(heartbeatRuns).set({runtimeMode:"legacy",nativeIssueId:null,status:"failed",errorCode:"adapter_failed",finishedAt:new Date(),resultJson:{executionRecovery:{kind:"bootstrap",providerWorkStarted:false}},contextSnapshot:{issueId:f.issue.id,taskId:f.issue.id}}).where(eq(heartbeatRuns.id,f.reviewerRun.id)).returning();
    await db.update(issues).set({executionRunId:null,checkoutRunId:null}).where(eq(issues.id,f.issue.id));await db.update(agentWakeupRequests).set({status:"completed",finishedAt:new Date()}).where(eq(agentWakeupRequests.id,f.wake.id));
    executionFixture.holdTaskRetryNudge=true;
    try {
      const response=await request(f.board).post(`/api/issues/${f.issue.id}/retry`).send({idempotencyKey:randomUUID(),observedRunId:failed.id});expect(response.status,JSON.stringify(response.body)).toBe(202);expect(response.body.accepted).toBe(true);
      if(change==="status_version")await db.update(issues).set({statusVersion:sql`${issues.statusVersion}+1`}).where(eq(issues.id,f.issue.id));
      if(change==="workspace_revision")await db.update(issues).set({workspaceBindingRevision:sql`${issues.workspaceBindingRevision}+1`}).where(eq(issues.id,f.issue.id));
      if(change==="policy"){const current=await f.read(),policy=structuredClone(current.executionPolicy) as any;policy.stages[0].participants[0].id=randomUUID();await db.update(issues).set({executionPolicy:policy}).where(eq(issues.id,f.issue.id));}
      if(change==="newer_source")await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.reviewer.id,issueId:f.issue.id,scopeKind:"issue",status:"failed",finishedAt:new Date(),contextSnapshot:{issueId:f.issue.id}});
      if(change==="wrong_assignee")await db.update(issues).set({assigneeAgentId:f.builder.id}).where(eq(issues.id,f.issue.id));
      const actual=await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
      const resumed=await Promise.allSettled([actual.heartbeatService(db).resumeTaskRetry(f.company.id,response.body.requestId)]);
      if(resumed[0].status==="rejected")expect(resumed[0].reason).toMatchObject({status:409});
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,f.company.id),sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${response.body.requestId}`))).toHaveLength(0);expect((await f.ledger()).admissions).toHaveLength(1);
    }finally{executionFixture.holdTaskRetryNudge=false;}
  });
  it.each([false,true])("normal-stage exhausted pre-native failure retains explicit owner retry only when provider work did not start: %s",async providerStarted=>{
    const f=await stageFixture();const [failed]=await db.update(heartbeatRuns).set({runtimeMode:"legacy",nativeIssueId:null,status:"failed",executionStage:"preparing",errorCode:"adapter_failed",error:"Synthetic protected Reviewer startup failure",finishedAt:new Date(),resultJson:{executionRecovery:{kind:"bootstrap",providerWorkStarted:providerStarted}},contextSnapshot:{issueId:f.issue.id,taskId:f.issue.id,source:"issue.execution_review_recovery",retryReason:"execution_review_participant_recovery"}}).where(eq(heartbeatRuns.id,f.reviewerRun.id)).returning();
    await db.update(issues).set({executionRunId:null,checkoutRunId:null}).where(eq(issues.id,f.issue.id));await db.update(agentWakeupRequests).set({status:"completed",finishedAt:new Date()}).where(eq(agentWakeupRequests.id,f.wake.id));
    const stageModule=await import("../services/native-runtime/native-stage-review.js"),proofReader=vi.spyOn(stageModule,"getNativeStageReviewRecoveryContext");
    const {recoveryService}=await import("../services/recovery/service.js"),enqueueWakeup=vi.fn(async()=>null),service=recoveryService(db,{enqueueWakeup}),before=await f.read(),outcomes=[];
    try {
      for(let n=0;n<2;n++)outcomes.push(await service.reconcileStrandedAssignedIssues({companyId:f.company.id,issueId:f.issue.id,skipRelatedRecovery:true,skipExternalConversationSettlement:true}));
      expect(enqueueWakeup).not.toHaveBeenCalled();
      if(!providerStarted){expect(proofReader).toHaveBeenCalledTimes(2);expect(outcomes.every(x=>x.escalated===0)).toBe(true);expect(await f.read()).toEqual(before);}
      else{expect(proofReader).not.toHaveBeenCalled();expect(outcomes.some(x=>x.escalated>0)).toBe(true);}
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,failed.id)))[0].contextSnapshot).toEqual(failed.contextSnapshot);expect((await f.ledger()).admissions).toHaveLength(1);
    }finally{proofReader.mockRestore();}
  });
  it("native scheduler consumes scoped return intent once and defers actual dispatch until Reviewer release",async()=>{
    const f=await reviewingDraftFixture();ok(await request(f.reviewerApp).post(`/api/issues/${f.issue.id}/interactions/${f.scope.interactionId}/accept`).send({}));
    const [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));
    // Ignore the earlier captured Reviewer wake in this targeted return test:
    // its actual runtime was already represented by reviewingDraftFixture.
    await db.update(agentWakeupRequests).set({status:"completed",runId:f.reviewerRun.id}).where(and(eq(agentWakeupRequests.companyId,f.company.id),eq(agentWakeupRequests.agentId,f.reviewer.id)));
    const {heartbeatService}=await import("../services/heartbeat.js");const heartbeat=heartbeatService(db);
    const first=await heartbeat.dispatchPendingNativeStatusWakeups({companyId:f.company.id});expect(first.scanned).toBe(1);
    const receipts=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.requestedByActorId,`native-status-wake-dispatch:${scope.returnWakeupId}`));
    expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({agentId:f.builder.id,status:"deferred_issue_execution"});
    expect(receipts[0].payload).toMatchObject({scopedReviewId:f.scope.id,_paperclipWakeContext:{scopedReviewId:f.scope.id,forceFreshSession:true}});
    await heartbeat.dispatchPendingNativeStatusWakeups({companyId:f.company.id});
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.requestedByActorId,`native-status-wake-dispatch:${scope.returnWakeupId}`))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId,receipts[0].id))).toHaveLength(0);
    // A synthetic persisted queued run tests the ACTUAL scheduler receipt chain;
    // no provider starts. Execution settlement is represented explicitly.
    const [returned]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.builder.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"queued",wakeupRequestId:receipts[0].id,contextSnapshot:(receipts[0].payload as any)._paperclipWakeContext}).returning();
    const {assertScopedRunAdmission}=await import("../services/scoped-review-admission.js");
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:returned.id})).rejects.toThrow("Reviewer must settle");
    await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,f.reviewerRun.id));await db.update(issues).set({executionRunId:null}).where(eq(issues.id,f.issue.id));
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:returned.id},{readRunTerminationProof:(await import("../services/heartbeat.js")).heartbeatService(db).readRunTerminationProof})).resolves.toBeUndefined();
  });
  it("native normal stage refuses same-workspace revision drift and same-stage policy edits",async()=>{
    const f=await stageFixture();const {getNativeStageReviewAssignment}=await import("../services/native-runtime/native-stage-review.js");
    const input={companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,contextSnapshot:f.context};
    expect(await getNativeStageReviewAssignment(db,input)).not.toBeNull();
    await db.update(issues).set({workspaceBindingRevision:sql`${issues.workspaceBindingRevision}+1`}).where(eq(issues.id,f.issue.id));expect(await getNativeStageReviewAssignment(db,input)).toBeNull();
    await db.update(issues).set({workspaceBindingRevision:f.issue.workspaceBindingRevision,executionPolicy:{...(await f.read()).executionPolicy as any,maxReviewRounds:4}}).where(eq(issues.id,f.issue.id));expect(await getNativeStageReviewAssignment(db,input)).toBeNull();
    expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it.each(["approved","changes_requested"] as const)("narrow native normal stage %s binds the accepted candidate and records one immutable decision",async outcome=>{
    const f=await stageFixture(),url=`/api/issues/${f.issue.id}/execution-stage-review/decisions`;
    const {getNativeStageReviewAssignment,nativeStageReviewOutcome}=await import("../services/native-runtime/native-stage-review.js");
    const proof=await getNativeStageReviewAssignment(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,contextSnapshot:f.context});expect(proof).not.toBeNull();
    const body={id:randomUUID(),stageId:proof!.stage.id,admissionId:proof!.admission.id,sourceDecisionId:proof!.sourceDecision.id,expectedStatusVersion:proof!.issue.statusVersion,outcome,body:"Concrete independent review finding"};
    expect((await request(f.board).post(url).send(body)).status).toBe(403);
    expect((await request(f.reviewerApp).post(url).send({...body,sourceDecisionId:randomUUID()})).status).toBe(403);
    const {PaperclipRunnerToolAuthority}=await import("../services/native-runtime/paperclip-runner-tool-authority.js");
    const authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,nativeStageReview:{nativeStageDecisionId:f.context.nativeStageDecisionId,nativeStageAdmissionId:f.context.nativeStageAdmissionId,nativeStageStatusVersion:f.context.nativeStageStatusVersion}});
    expect(authority.definitions().map(tool=>tool.name)).toContain("resolve_stage_review");expect(authority.definitions().map(tool=>tool.name)).not.toContain("call_api");
    await expect(authority.execute({tool:"finish_task",callId:randomUUID(),arguments:{}})).rejects.toThrow("may only inspect");
    if(outcome==="approved") await authority.execute({tool:"resolve_stage_review",callId:randomUUID(),arguments:{id:body.id,outcome,body:body.body}});
    else ok(await request(f.reviewerApp).post(url).send(body));
    const retry=await request(f.reviewerApp).post(url).send(body);ok(retry);expect(retry.body.replayed).toBe(true);
    expect(await authority.execute({tool:"resolve_stage_review",callId:randomUUID(),arguments:{id:body.id,outcome,body:body.body}})).toMatchObject({replayed:true});authority.close();
    expect((await request(f.reviewerApp).post(url).send({...body,body:"Altered replay"})).status).toBe(409);
    expect(await f.read()).toMatchObject({status:outcome==="approved"?"in_review":"in_progress",assigneeAgentId:outcome==="approved"?null:f.builder.id,assigneeUserId:outcome==="approved"?f.userId:null,executionRunId:f.reviewerRun.id});
    expect((await f.ledger()).admissions).toHaveLength(1);expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.createdByRunId,f.reviewerRun.id))).toHaveLength(1);
    expect(await nativeStageReviewOutcome(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,contextSnapshot:f.context})).toBe("resolved");
    if(outcome==="changes_requested") {
      const [returnIntent]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,`native-stage-decision:${body.id}`));
      expect(returnIntent).toMatchObject({requestedByActorType:"system",requestedByActorId:"native-status-committer",agentId:f.builder.id,status:"queued"});
    }
  });
  async function approvedStageWithBuilderReassessment() {
    const f = await stageFixture();
    const { getNativeStageReviewAssignment } = await import("../services/native-runtime/native-stage-review.js");
    const { decideNativeStageReview } = await import("../services/native-runtime/native-stage-review-decision.js");
    const { reassessNativeStatusFromSource } = await import("../services/native-runtime/native-status-reassessment.js");
    const input = {
      companyId: f.company.id, issueId: f.issue.id, agentId: f.reviewer.id,
      runId: f.reviewerRun.id, contextSnapshot: f.context,
    };
    const assignment = (await getNativeStageReviewAssignment(db, input))!;
    expect(assignment).not.toBeNull();
    const request = {
      id: randomUUID(), stageId: assignment.stage.id, admissionId: assignment.admission.id,
      sourceDecisionId: assignment.sourceDecision.id, expectedStatusVersion: assignment.issue.statusVersion,
      outcome: "approved" as const, body: "Exact native Reviewer approval of the admitted candidate",
    };
    const verdict = await decideNativeStageReview(db, { ...input, request });
    expect(verdict.replayed).toBe(false);
    const approved = await f.read();
    expect(approved.executionState).toMatchObject({ currentStageType: "approval" });
    const reassessed = await reassessNativeStatusFromSource(db, {
      companyId: f.company.id, issueId: f.issue.id, agentId: f.builder.id, runId: f.candidate.runId,
      issueStatus: approved.status, issueStatusVersion: approved.statusVersion,
      issueDecisionId: approved.lastStatusDecisionId, coordinatorPhase: "committed",
      decisionId: f.committed.decision.id, assessmentId: f.candidate.assessmentId,
      nativeStatusWakeIntentId: null,
    });
    expect(reassessed).toMatchObject({ kind: "committed", result: {
      reconciliationAction: "prior_status_terminal_preserved",
    } });
    const [coordinator] = await db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, f.candidate.runId));
    expect(coordinator).toMatchObject({ phase: "committed", resultId: f.candidate.resultId });
    expect(coordinator.decisionId).not.toBe(f.committed.decision.id);
    return { ...f, input, request, approved, coordinator };
  }
  it("settles the saved Reviewer result after the Builder preserve decision advances", async () => {
    const f = await approvedStageWithBuilderReassessment();
    const { getNativeStageReviewAssignment, historicalNativeStageDecision, nativeStageReviewOutcome } =
      await import("../services/native-runtime/native-stage-review.js");
    expect(await getNativeStageReviewAssignment(db, f.input)).toBeNull();
    expect(await historicalNativeStageDecision(db, { ...f.input, request: f.request })).toBeNull();
    expect(await nativeStageReviewOutcome(db, f.input)).toBe("resolved");
    for (const input of [
      { ...f.input, issueId: randomUUID() },
      { ...f.input, agentId: f.builder.id },
      { ...f.input, runId: f.candidate.runId },
      { ...f.input, contextSnapshot: { ...f.context, nativeStageStatusVersion: f.approved.statusVersion } },
      { ...f.input, contextSnapshot: { ...f.context, nativeStageAdmissionId: randomUUID() } },
      { ...f.input, contextSnapshot: { ...f.context, nativeStageDecisionId: randomUUID() } },
      { ...f.input, contextSnapshot: { ...f.context, nativeStatusWakeIntentId: randomUUID() } },
    ]) expect(await nativeStageReviewOutcome(db, input)).toBe("stale");

    const contractId = randomUUID(), resultId = randomUUID();
    const contractSha = f.candidate.nativeSha256({ revision: "stage-preserve", criteria: [] });
    await db.insert(completionContracts).values({
      id: contractId, companyId: f.company.id, issueId: f.issue.id, revision: f.approved.statusVersion + 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v13",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "stage-preserve", objective: "Deliver the recorded review", criteria: [] },
      canonicalSha256: contractSha, createdByActorType: "system", createdByActorId: "stage-preserve-fixture",
    });
    await db.update(heartbeatRuns).set({
      completionContractId: contractId, completionContractSha256: contractSha,
      status: "failed", errorCode: "adapter_failed", finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, f.reviewerRun.id));
    const resultJson = {
      result: { reportedWorkDisposition: "done", summary: "Exact stage approval recorded", attentionRequests: [] },
      terminal: { runTerminalState: "succeeded" },
    };
    const resultSha = f.candidate.nativeSha256(resultJson);
    await db.insert(nativeRunResults).values({
      id: resultId, companyId: f.company.id, issueId: f.issue.id, runId: f.reviewerRun.id,
      completionContractId: contractId, serverFingerprint: resultSha, schemaStatus: "accepted",
      canonicalSha256: resultSha, resultJson,
    });
    await db.insert(nativeRunFinalizations).values({
      runId: f.reviewerRun.id, companyId: f.company.id, issueId: f.issue.id, resultId,
      phase: "retryable_failure", failureCode: "side_effect_planning_failed",
    });
    const { finalizeNativeRun } = await import("../services/native-runtime/native-run-finalizer.js");
    const { executionProjectionForRun } = await import("../services/execution-projection.js");
    const finalizer = {
      db, runId: f.reviewerRun.id, workspaceFinalizeStatus: "succeeded" as const, projectRunStatus: true,
      skipExternalConversationSettlement: true, skipExternalAgentSettlement: true,
    };
    const runsBefore = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.company.id)).orderBy(heartbeatRuns.id);
    const wakesBefore = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.company.id)).orderBy(agentWakeupRequests.id);
    const failed = await finalizeNativeRun({ ...finalizer, workspaceFinalizeStatus: "failed" });
    expect(failed).toMatchObject({ phase: "retryable_failure", resultId });
    const [workspaceNotice] = await db.select().from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.sourceIssueId, f.issue.id), eq(issueRecoveryActions.cause, "workspace_finalization_failed")));
    expect(workspaceNotice).toMatchObject({ status: "active" });
    await db.insert(workspaceOperations).values({ companyId: f.company.id, issueId: f.issue.id,
      heartbeatRunId: f.reviewerRun.id, phase: "workspace_finalize", status: "succeeded",
      metadata: { owningService: "native_workspace_finalizer" } });
    const completed = await finalizeNativeRun(finalizer);
    expect(completed).toMatchObject({ phase: "committed", resultId });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.reviewerRun.id));
    expect(run.status).toBe("succeeded");
    const [settledNotice] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, workspaceNotice.id));
    expect(settledNotice).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(await executionProjectionForRun(db, f.company.id, f.reviewerRun.id)).toMatchObject({ phase: "completed" });
    expect(await f.read()).toMatchObject({ statusVersion: f.approved.statusVersion,
      assigneeUserId: f.userId, executionState: { currentStageType: "approval" } });
    expect((await f.ledger()).admissions).toHaveLength(1);
    expect(await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.createdByRunId, f.reviewerRun.id))).toHaveLength(1);
    expect(await db.select().from(nativeRunResults)
      .where(eq(nativeRunResults.runId, f.reviewerRun.id))).toHaveLength(1);
    expect(await finalizeNativeRun(finalizer)).toMatchObject({ phase: "committed", decisionId: completed.decisionId });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.company.id)).orderBy(heartbeatRuns.id))
      .toEqual(runsBefore);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.company.id)).orderBy(agentWakeupRequests.id))
      .toEqual(wakesBefore);
  });
  it.each(["broken lineage", "cyclic lineage", "different result", "new effect", "non-preserve", "unapplied", "uncommitted"] as const)(
    "historical stage finalization refuses a later Builder projection with %s", async change => {
      const f = await approvedStageWithBuilderReassessment();
      const { nativeStageReviewOutcome } = await import("../services/native-runtime/native-stage-review.js");
      const [later] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, f.coordinator.decisionId!));
      if (change === "broken lineage" || change === "cyclic lineage") {
        await db.update(workAssessments).set({
          supersedesAssessmentId: change === "broken lineage" ? null : later.assessmentId,
        }).where(eq(workAssessments.id, later.assessmentId));
      } else if (change === "different result") {
        const otherResultId = randomUUID();
        const resultJson = { ...f.candidate.resultJson, result: { ...f.candidate.resultJson.result, summary: "Different result" } };
        const digest = f.candidate.nativeSha256(resultJson);
        await db.insert(nativeRunResults).values({
          id: otherResultId, companyId: f.company.id, issueId: f.issue.id, runId: f.candidate.runId,
          completionContractId: f.candidate.contractId, schemaStatus: "accepted",
          resultJson, canonicalSha256: digest, serverFingerprint: digest,
        });
        await db.update(workAssessments).set({ resultId: otherResultId })
          .where(eq(workAssessments.id, later.assessmentId));
      } else if (change === "new effect" || change === "non-preserve") {
        const decisionJson = change === "new effect"
          ? { ...later.decisionJson, effects: [...(later.decisionJson.effects as unknown[]), { kind: "release_checkout" }] }
          : { ...later.decisionJson, statusAction: "in_review" };
        await db.update(statusDecisions).set({ decisionJson }).where(eq(statusDecisions.id, later.id));
      } else if (change === "unapplied") {
        await db.update(statusDecisions).set({ applicationState: "proposed" }).where(eq(statusDecisions.id, later.id));
      } else {
        await db.update(nativeRunFinalizations).set({ phase: "retryable_failure" })
          .where(eq(nativeRunFinalizations.runId, f.candidate.runId));
      }
      expect(await nativeStageReviewOutcome(db, f.input)).toBe("stale");
      expect((await f.ledger()).admissions).toHaveLength(1);
      expect(await db.select().from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.createdByRunId, f.reviewerRun.id))).toHaveLength(1);
    });
  it("counts five manual Builder candidates, holds fifth, records one allowance, restarts same Reviewer and retains decision/audit history", async () => {
    const f = await seed();
    for (let n=1;n<=5;n++) {
      await f.run(f.builder.id);
      ok(await patch(f.board,f.issue.id,{ status: "done", reviewCycleSubmissionId: randomUUID() }));
      expect((await f.read()).assigneeAgentId).toBe(f.reviewer.id);
      const reviewRun=await f.run(f.reviewer.id);
      ok(await patch(await f.agentApp(f.reviewer.id,reviewRun.id),f.issue.id,{ status: "in_progress", comment: `Correction ${n}` }));
      expect((await f.ledger()).admissions).toHaveLength(n);
    }
    const held=await f.read(); expect(held.status).toBe("in_review"); expect(held.assigneeUserId).toBe(f.userId);
    expect(held.executionState).toMatchObject({ totalReviewBudgetHold: true, totalReviewCyclesUsed:5 });
    const { issueService }=await import("../services/issues.js");
    const claimRun=await f.run(f.builder.id,"running");
    await expect(issueService(db).checkout(f.issue.id,f.builder.id,["in_review"],claimRun.id)).rejects.toThrow();
    expect((await f.read()).assigneeUserId).toBe(f.userId);
    // Retire this synthetic fixture run so the following allowance does not need executor stop.
    await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,claimRun.id));
    const receipt={id:randomUUID(),additionalCycles:1,reason:"One explicit additional correction"};
    ok(await patch(f.board,f.issue.id,{ reviewCycleAllowance:receipt }));
    expect((await f.ledger()).allowances).toHaveLength(1);
    expect((await f.read()).assigneeAgentId).toBe(f.builder.id);
    await f.run(f.builder.id); ok(await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));
    expect((await f.read()).assigneeAgentId).toBe(f.reviewer.id); expect((await f.ledger()).admissions).toHaveLength(6);
    const decisions=await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,f.issue.id)); expect(decisions).toHaveLength(5);
    const audit=await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.issue.id),eq(activityLog.action,"issue.updated")));
    expect(audit.some(e=>(e.details as any)?.reviewCycleAllowance?.id===receipt.id)).toBe(true);
  }, 90000);
  it("native status committer admits accepted Builder completion, durably wakes selected Reviewer once and replays without another cycle", async () => {
    const {f,runId,resultId,nativeSha256,resultJson,commitNativeStatusDecision,input}=await nativeCandidate();
    const first=await commitNativeStatusDecision(input);
    expect(first.issue).toMatchObject({status:"in_review",assigneeAgentId:f.reviewer.id,checkoutRunId:null});
    expect((await f.ledger()).admissions[0]).toMatchObject({id:resultId,builderRunId:runId,candidateId:`native-result:${resultId}:${nativeSha256(resultJson)}`});
    const wakes=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,f.company.id),eq(agentWakeupRequests.agentId,f.reviewer.id)));
    expect(wakes).toHaveLength(1); expect(wakes[0].payload).toMatchObject({executionStage:{wakeRole:"reviewer",allowedActions:["approve","request_changes"]}});
    expect((await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId,first.decision.id))).some(e=>e.effectKind==="execution_stage_wake")).toBe(true);
    const replay=await commitNativeStatusDecision(input); expect(replay.replayed).toBe(true);
    expect((await f.ledger()).admissions).toHaveLength(1);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId,f.issue.id))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,f.company.id),eq(agentWakeupRequests.agentId,f.reviewer.id)))).toHaveLength(1);
  });
  it("native Builder candidates share the same five-total hold as normal HTTP review corrections", async () => {
    const f=await seed();
    for(let n=1;n<=5;n++) {
      const native=await nativeCandidate(f); await native.commitNativeStatusDecision(native.input);
      expect((await f.read()).assigneeAgentId).toBe(f.reviewer.id);
      const reviewerRun=await f.run(f.reviewer.id);
      ok(await patch(await f.agentApp(f.reviewer.id,reviewerRun.id),f.issue.id,{status:"in_progress",comment:`Native candidate correction ${n}`}));
      expect((await f.ledger()).admissions).toHaveLength(n);
    }
    expect(await f.read()).toMatchObject({status:"in_review",assigneeAgentId:null,assigneeUserId:f.userId,executionState:{totalReviewBudgetHold:true,totalReviewCyclesUsed:5}});
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,f.issue.id))).toHaveLength(5);
  },90000);
  it("native projection failure rolls back decision, ledger, task and Reviewer wake", async () => {
    const {f,input,commitNativeStatusDecision}=await nativeCandidate();
    await expect(commitNativeStatusDecision({...input,failpoint:"status_projection"})).rejects.toThrow("native_status_failpoint:status_projection");
    expect(await f.ledger()).toBeUndefined(); expect((await f.read()).status).toBe("in_progress");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId,f.issue.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.company.id))).toHaveLength(0);
  });
  it("native rejected result cannot supply a review admission", async () => {
    const {f,input,resultId,commitNativeStatusDecision}=await nativeCandidate();
    await db.update(nativeRunResults).set({schemaStatus:"rejected"}).where(eq(nativeRunResults.id,resultId));
    await expect(commitNativeStatusDecision(input)).rejects.toThrow("accepted bound Builder result");
    expect(await f.ledger()).toBeUndefined(); expect((await f.read()).status).toBe("in_progress");
  });
  it("native completion-review attention conflicts are explicit rather than creating a second review engine", async () => {
    const {f,input,commitNativeStatusDecision}=await nativeCandidate();
    await expect(commitNativeStatusDecision({...input,decision:{...input.decision,statusAction:"in_review",toStatus:"in_review",effects:[{kind:"bind_reviewer",ownerAgentId:f.reviewer.id,prompt:"Different native completion review"}]}})).rejects.toThrow("shared-owner adapter");
    expect(await f.ledger()).toBeUndefined(); expect((await f.read()).status).toBe("in_progress");
  });
  it("native Reviewer terminal report preserves its pending stage without approving or spending another cycle", async () => {
    const first=await nativeCandidate(); await first.commitNativeStatusDecision(first.input);
    const second=await nativeCandidate(first.f,first.f.reviewer.id);
    const result=await second.commitNativeStatusDecision({...second.input,decision:{...second.input.decision,statusAction:"in_review",toStatus:"in_review",reasonCode:"governed_gate_pending",effects:[{kind:"create_interaction",gate:{kind:"execution_stage",id:second.runId}}]}});
    expect(result.issue.executionState).toMatchObject({status:"pending",currentParticipant:{type:"agent",agentId:first.f.reviewer.id}});
    expect((await first.f.ledger()).admissions).toHaveLength(1);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,first.f.issue.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,first.f.company.id),eq(agentWakeupRequests.agentId,first.f.reviewer.id)))).toHaveLength(1);
  });
  it("actual tiny Git quarantine restore preserves pending Reviewer and the original cycle ledger", async () => {
    const f=await seed(); await f.run(f.builder.id);
    ok(await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));
    const fixture=path.resolve(fileURLToPath(new URL("../../../../",import.meta.url)),"private",`quarantine-${randomUUID()}`);
    const repo=path.join(fixture,"repo"),work=path.join(fixture,"work"); await fs.mkdir(repo,{recursive:true});
    const exec=promisify(execFile),git=async(cwd:string,args:string[]) => (await exec("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false","-C",cwd,...args])).stdout.trim();
    await git(repo,["init"]); await git(repo,["config","user.name","Paperclip Synthetic Fixture"]); await git(repo,["config","user.email","fixture@example.test"]);
    await fs.writeFile(path.join(repo,"README.md"),"Synthetic source candidate\n"); await git(repo,["add","README.md"]); await git(repo,["commit","-m","Synthetic candidate"]); await git(repo,["branch","-M","main"]);
    await git(repo,["branch","feature/recorded"]); await git(repo,["worktree","add","-b","feature/live",work,"feature/recorded"]);
    await fs.appendFile(path.join(work,"README.md"),"Retained synthetic dirty work\n");
    const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Synthetic quarantine project",status:"in_progress"}).returning();
    const [primary]=await db.insert(projectWorkspaces).values({companyId:f.company.id,projectId:project.id,name:"Synthetic primary",cwd:repo,isPrimary:true}).returning();
    const [workspace]=await db.insert(executionWorkspaces).values({companyId:f.company.id,projectId:project.id,projectWorkspaceId:primary.id,sourceIssueId:f.issue.id,mode:"isolated_workspace",strategyType:"git_worktree",providerType:"git_worktree",name:"feature/recorded",branchName:"feature/recorded",baseRef:"main",cwd:work,providerRef:work,status:"active"}).returning();
    await db.update(issues).set({status:"blocked",assigneeAgentId:f.builder.id,projectId:project.id,projectWorkspaceId:primary.id,executionWorkspaceId:workspace.id}).where(eq(issues.id,f.issue.id));
    const { executionWorkspaceService }=await import("../services/execution-workspaces.js");
    const restored=await executionWorkspaceService(db).reconcileExecutionWorkspaceBranch(workspace.id,{mode:"quarantine_restore",reason:"Retain synthetic dirty work and restore recorded branch",actor:{actorType:"user",actorId:f.userId,agentId:null,runId:null}});
    expect(restored.restoredSourceIssue).toMatchObject({status:"in_review",assigneeAgentId:f.reviewer.id});
    expect((await f.ledger()).admissions).toHaveLength(1);
    expect(await git(work,["branch","--show-current"])).toBe("feature/recorded");
    expect(await git(work,["status","--porcelain"])).toBe("");
    expect(await git(repo,["branch","--list","paperclip/rescue/*"])).not.toBe("");
  },90000);
  it("native recovery hand-back preserves total ledger and requires fresh same-Reviewer review after correction", async () => {
    const f=await seed(); await f.run(f.builder.id);
    ok(await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));
    const reviewRun=await f.run(f.reviewer.id);
    ok(await patch(await f.agentApp(f.reviewer.id,reviewRun.id),f.issue.id,{status:"in_progress",comment:"Correct this candidate before retry"}));
    // Synthetic environmental failure; recovery itself uses actual native HTTP/service gates.
    await db.update(issues).set({status:"blocked",executionRunId:null,checkoutRunId:null}).where(eq(issues.id,f.issue.id));
    const [action]=await db.insert(issueRecoveryActions).values({companyId:f.company.id,sourceIssueId:f.issue.id,kind:"active_run_watchdog",ownerType:"board",ownerUserId:f.userId,returnOwnerAgentId:f.builder.id,cause:"synthetic_fixture_repair",fingerprint:randomUUID(),nextAction:"Repair synthetic fixture",evidence:{}}).returning();
    const response=await request(f.board).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send({actionId:action.id,outcome:"restored",sourceIssueStatus:"todo",resolutionNote:"Synthetic environmental repair confirmed; candidate still requires independent review."});
    ok(response); expect((await f.ledger()).admissions).toHaveLength(1);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,action.id)))[0].status).toBe("resolved");
    await f.run(f.builder.id); ok(await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));
    expect((await f.read()).assigneeAgentId).toBe(f.reviewer.id); expect((await f.ledger()).admissions).toHaveLength(2);
  });
  it("unadapted native setter fails closed; Reviewer release retains stage assignment and total ledger", async () => {
    const f=await seed(); await f.run(f.builder.id);
    ok(await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));
    const { issueService }=await import("../services/issues.js");
    await expect(issueService(db).update(f.issue.id,{status:"done"})).rejects.toThrow("locked task-wide review budget adapter");
    const run=await f.run(f.reviewer.id);
    await db.update(issues).set({status:"in_progress",checkoutRunId:run.id,executionRunId:run.id}).where(eq(issues.id,f.issue.id));
    await issueService(db).release(f.issue.id,f.reviewer.id,run.id);
    expect(await f.read()).toMatchObject({status:"in_review",assigneeAgentId:f.reviewer.id,checkoutRunId:null});
    expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it("native approval comment advances the same Reviewer stage atomically without another cycle", async () => {
    const f=await seed(); await f.run(f.builder.id);
    ok(await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));
    const reviewerRun=await f.run(f.reviewer.id);
    const app=await f.agentApp(f.reviewer.id,reviewerRun.id);
    const response=await request(app).post(`/api/issues/${f.issue.id}/comments`).send({body:"## Review: APPROVED\nChecked this candidate."});
    expect(response.status,JSON.stringify(response.body)).toBe(201);
    expect((await f.read()).assigneeUserId).toBe(f.userId); expect((await f.ledger()).admissions).toHaveLength(1);
    const decisions=await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,f.issue.id));
    expect(decisions).toHaveLength(1); expect(decisions[0].outcome).toBe("approved");
    const audit=await db.select().from(activityLog).where(eq(activityLog.entityId,f.issue.id));
    expect(audit.some(e=>(e.details as any)?.source==="auto_approval_comment")).toBe(true);
  });
  it("does not admit or mutate a candidate when native active-run stop is unconfirmed", async () => {
    const f=await seed(); executionFixture.rejectStop=true; const run=await f.run(f.builder.id,"running");
    await db.update(issues).set({checkoutRunId:run.id,executionRunId:run.id}).where(eq(issues.id,f.issue.id));
    const response=await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()});
    expect(response.status).toBe(500); expect(response.body.error).toContain("Unconfirmed executor stop"); executionFixture.rejectStop=false;
    expect(await f.ledger()).toBeUndefined(); expect((await f.read()).status).toBe("in_progress");
  });
  it("derives automatic receipt from authenticated Builder run and duplicate submit does not charge twice", async () => {
    const f=await seed(), run=await f.run(f.builder.id,"running"), app=await f.agentApp(f.builder.id,run.id);
    await db.update(issues).set({checkoutRunId:run.id,executionRunId:run.id}).where(eq(issues.id,f.issue.id));
    ok(await patch(app,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));
    expect((await f.ledger()).admissions[0]).toMatchObject({id:run.id,builderRunId:run.id,builderAgentId:f.builder.id});
    const response=await patch(app,f.issue.id,{status:"done"});
    // The old Builder no longer owns the pending Reviewer stage; native refusal is retained.
    expect([200,403,409,422]).toContain(response.status); expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it("native completion-review history without legacy decisions cannot receive a new five-cycle ledger",async()=>{
    const f=await seed();
    const policy=structuredClone(f.issue.executionPolicy) as any;delete policy.totalReviewCycles;
    await db.update(issues).set({executionPolicy:policy}).where(eq(issues.id,f.issue.id));
    const c=await nativeCandidate(f);
    await c.commitNativeStatusDecision({...c.input,decision:{...c.input.decision,statusAction:"in_review",toStatus:"in_review",reasonCode:"actionable_attention_pending",effects:[{kind:"bind_reviewer",ownerAgentId:f.reviewer.id,prompt:"Native prior review"}]}});
    await db.update(issues).set({executionPolicy:f.issue.executionPolicy}).where(eq(issues.id,f.issue.id));
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId,f.issue.id))).toHaveLength(0);
    const context=await (await import("../services/review-cycle-budget-store.js")).readReviewBudgetPreviewContext(db,{companyId:f.company.id,issueId:f.issue.id});
    expect(context.reviewCycleBudget).toBeNull();expect(context.reviewCycleInitializationAuthorized).toBe(false);
  });
  it("concurrent native commit and lost-reply replay spend one candidate and persist one Reviewer wake",async()=>{
    const c=await nativeCandidate();const results=await Promise.allSettled([c.commitNativeStatusDecision(c.input),c.commitNativeStatusDecision(c.input)]);
    expect(results.some(result=>result.status==="fulfilled"),JSON.stringify(results.map(result=>result.status==="rejected"?{name:result.reason?.name,message:result.reason?.message,code:result.reason?.code,stack:result.reason?.stack}:"fulfilled"))).toBe(true);
    expect((await c.f.ledger()).admissions).toHaveLength(1);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId,c.f.issue.id))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,c.f.company.id))).toHaveLength(1);
    expect((await c.commitNativeStatusDecision(c.input)).replayed).toBe(true);
  });
  it.each(["admissionId","sourceDecisionId","expectedStatusVersion","stageId"] as const)("historical stage replay refuses altered %s and never changes its budget",async field=>{
    const f=await stageFixture(),{getNativeStageReviewAssignment,decideNativeStageReview}=await (async()=>({...await import("../services/native-runtime/native-stage-review.js"),...await import("../services/native-runtime/native-stage-review-decision.js")}))();
    const proof=(await getNativeStageReviewAssignment(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,contextSnapshot:f.context}))!;
    const requestBody={id:randomUUID(),stageId:proof.stage.id,admissionId:proof.admission.id,sourceDecisionId:proof.sourceDecision.id,expectedStatusVersion:proof.issue.statusVersion,outcome:"changes_requested" as const,body:"Exact receipt finding"};
    const input={companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,request:requestBody};
    await decideNativeStageReview(db,input);
    await expect(decideNativeStageReview(db,{...input,request:{...requestBody,[field]:field==="expectedStatusVersion"?requestBody.expectedStatusVersion+1:randomUUID()}})).rejects.toMatchObject({status:409});
    expect((await f.ledger()).admissions).toHaveLength(1);
  });

  it.each(["title","executionPolicy"])("refuses allowance combined with %s before any task or ledger effect",async field=>{
    const f=await seed(),before=await f.read();
    const response=await patch(f.board,f.issue.id,{reviewCycleAllowance:{id:randomUUID(),additionalCycles:1,reason:"Separate operation required"},[field]:field==="title"?"Changed title":{...f.issue.executionPolicy as any,stages:[]}});
    expect(response.status).toBe(422);expect(await f.read()).toEqual(before);expect(await f.ledger()).toBeUndefined();
  });

  it.each(["stage","scoped"] as const)("protected %s admission reaches actual HTTP verdict and retains F05 policy/process boundaries",async kind=>{
    const f=kind==="stage"?await stageFixture():await reviewingDraftFixture();const protectedRun=await qualifyProtectedReview(f);
    try {
      expect(protectedRun.admission.record.assignment.kind).toBe(kind==="stage"?"execution_stage_review":"scoped_review");
      const app=await appFor(protectedRun.actor,true);
      expect((await patch(app,f.issue.id,{status:"done"})).status).toBe(403);
      if(kind==="stage") {
        const stage=f as Awaited<ReturnType<typeof stageFixture>>;
        const body={id:randomUUID(),stageId:protectedRun.admission.record.assignment.kind==="execution_stage_review"?protectedRun.admission.record.assignment.stageId:"",admissionId:stage.context.nativeStageAdmissionId,sourceDecisionId:stage.context.nativeStageDecisionId,expectedStatusVersion:stage.context.nativeStageStatusVersion,outcome:"approved",body:"Protected native stage approved"};
        const url=`/api/issues/${f.issue.id}/execution-stage-review/decisions`;
        ok(await request(app).post(url).send(body));ok(await request(app).post(url).send(body));
        expect((await request(app).post(url).send({...body,admissionId:randomUUID()})).status).toBe(403);
        expect((await f.read()).assigneeUserId).toBe(f.userId);
      } else {
        const scope=f as Awaited<ReturnType<typeof reviewingDraftFixture>>;
        ok(await request(app).post(`/api/issues/${f.issue.id}/interactions/${scope.scope.interactionId}/accept`).send({}));
        expect((await f.read()).status).not.toBe("done");expect((await f.read()).assigneeAgentId).toBe(f.builder.id);
      }
      expect((await f.ledger()).admissions).toHaveLength(1);
    } finally {await protectedRun.close();}
  });
  it.each(["responsible_operator","authorizing_operator","responsible_viewer","authorizing_viewer"])("protected stage keeps native delegated mutation ceiling: %s",async mode=>{
    const f=await stageFixture(),protectedRun=await qualifyProtectedReview(f);
    try {
      const user=`delegated-${randomUUID()}`;await db.insert(authUsers).values({id:user,name:"Delegated fixture",email:`${user}@example.test`,createdAt:new Date(),updatedAt:new Date()});
      await db.insert(companyMemberships).values({companyId:f.company.id,principalType:"user",principalId:user,status:"active",membershipRole:mode.endsWith("operator")?"operator":"viewer"});
      const actor={...protectedRun.actor,...(mode.startsWith("authorizing")?{authorizingUserId:user}:{onBehalfOfUserId:user})};
      const proof=(await (await import("../services/native-runtime/native-stage-review.js")).getNativeStageReviewAssignment(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,contextSnapshot:f.context}))!;
      const body={id:randomUUID(),stageId:proof.stage.id,admissionId:proof.admission.id,sourceDecisionId:proof.sourceDecision.id,expectedStatusVersion:proof.issue.statusVersion,outcome:"changes_requested" as const,body:"Delegated native verdict"};
      const {decideNativeStageReview}=await import("../services/native-runtime/native-stage-review-decision.js");
      const operation=decideNativeStageReview(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,request:body,actor});
      if(mode.endsWith("operator"))await expect(operation).resolves.toMatchObject({replayed:false});
      else {await expect(operation).rejects.toMatchObject({status:403});expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.createdByRunId,f.reviewerRun.id))).toHaveLength(0);}
    } finally {await protectedRun.close();}
  });

  it("historical native stage replay still checks the current actor and delegated mutation ceiling",async()=>{
    const f=await stageFixture();const {getNativeStageReviewAssignment,nativeStageReviewOutcome}=await import("../services/native-runtime/native-stage-review.js");
    const {decideNativeStageReview}=await import("../services/native-runtime/native-stage-review-decision.js");
    const proof=(await getNativeStageReviewAssignment(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,contextSnapshot:f.context}))!;
    const input={companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,request:{id:randomUUID(),stageId:proof.stage.id,admissionId:proof.admission.id,sourceDecisionId:proof.sourceDecision.id,expectedStatusVersion:proof.issue.statusVersion,outcome:"changes_requested" as const,body:"Original exact verdict"}};
    await decideNativeStageReview(db,input);
    const user=`replay-viewer-${randomUUID()}`;await db.insert(authUsers).values({id:user,name:"Replay viewer",email:`${user}@example.test`,createdAt:new Date(),updatedAt:new Date()});
    await db.insert(companyMemberships).values({companyId:f.company.id,principalType:"user",principalId:user,status:"active",membershipRole:"viewer"});
    const actor={type:"agent" as const,agentId:f.reviewer.id,runId:f.reviewerRun.id,companyId:f.company.id,source:"agent_jwt" as const,onBehalfOfUserId:user};
    await expect(decideNativeStageReview(db,{...input,actor})).rejects.toMatchObject({status:403});
    await expect(decideNativeStageReview(db,{...input,actor:{...actor,agentId:f.builder.id}})).rejects.toMatchObject({status:403});
    expect(await nativeStageReviewOutcome(db,{...input,contextSnapshot:{...f.context,nativeStageAdmissionId:randomUUID()}})).toBe("stale");
    expect((await f.ledger()).admissions).toHaveLength(1);
  });
  it.each([false,true])("stage-only actual executor suppresses generic GitHub preparation before stale=%s backend admission",async stale=>{
    const f=await stageFixture();const {materializeAsset}=await import("../services/native-runtime/runtime-context.js");
    const {nativeRuntimeContextFixture}=await import("../services/native-runtime/runtime-context.test-fixture.js");
    const {parseNativeExecutionInput,canonicalNativeRuntimeContextDigest}=await import("../vendor/paperclip-runner/index.js");
    const runtime=nativeRuntimeContextFixture();runtime.instructions={entryPath:"AGENTS.md",bundle:await materializeAsset([{path:"AGENTS.md",content:Buffer.from("Synthetic stage preparation test"),mode:0o400}])};runtime.aggregateDigest=canonicalNativeRuntimeContextDigest(runtime);
    const execution=parseNativeExecutionInput({...f.execution,binding:{...f.execution.binding,agentId:f.reviewer.id,runId:f.reviewerRun.id},runtimeContext:runtime});
    await db.update(heartbeatRuns).set({completionContractId:execution.completionContract.id,completionContractSha256:execution.completionContract.sha256,runnerProfileJson:{nativeExecutionInput:execution}}).where(eq(heartbeatRuns.id,f.reviewerRun.id));
    await db.insert(nativeRunFinalizations).values({runId:f.reviewerRun.id,companyId:f.company.id,issueId:f.issue.id,phase:"executing"});
    if(stale)await db.update(issues).set({statusVersion:sql`${issues.statusVersion}+1`}).where(eq(issues.id,f.issue.id));
    const github=await import("../services/native-runtime/native-github-access.js");const access=vi.spyOn(github,"createNativeGitHubAccess").mockImplementation(async()=>{throw new Error("Generic GitHub must not prepare a stage run");});
    const backend={descriptor:vi.fn(async()=>{throw new Error("bounded_stage_backend_reached");}),openSession:vi.fn(async()=>{throw new Error("provider_must_not_start");})};
    try {
      const result=await (await import("../services/native-runtime/native-session-executor.js")).executePaperclipNativeSession({db,execution,managedGitHub:true,backend,runnerInstanceId:randomUUID()}).catch(error=>error);
      expect(access).not.toHaveBeenCalled();expect(backend.openSession).not.toHaveBeenCalled();
      if(stale)expect(result).toMatchObject({code:"native_provider_state_incompatible"});
      else expect(backend.descriptor,result instanceof Error?result.stack:JSON.stringify(result)).toHaveBeenCalled();
    } finally {access.mockRestore();}
  });

  it("concurrent fifth manual submissions serialize to one debit and the selected human hold",async()=>{
    const f=await seed();
    for(let cycle=0;cycle<4;cycle++) {
      await f.run(f.builder.id);ok(await patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}));
      const reviewer=await f.run(f.reviewer.id);ok(await patch(await f.agentApp(f.reviewer.id,reviewer.id),f.issue.id,{status:"in_progress",comment:"Correction required"}));
    }
    await f.run(f.builder.id);
    const results=await Promise.all([patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()}),patch(f.board,f.issue.id,{status:"done",reviewCycleSubmissionId:randomUUID()})]);
    expect(results.filter(result=>result.status===200)).toHaveLength(1);
    expect(results.some(result=>[409,422].includes(result.status))).toBe(true);
    expect((await f.ledger()).admissions).toHaveLength(5);
    const reviewer=await f.run(f.reviewer.id);ok(await patch(await f.agentApp(f.reviewer.id,reviewer.id),f.issue.id,{status:"in_progress",comment:"Fifth unresolved candidate"}));
    expect(await f.read()).toMatchObject({status:"in_review",assigneeUserId:f.userId,executionState:{totalReviewBudgetHold:true,totalReviewCyclesUsed:5}});
  });

  it("native nested stage setter rolls back its verdict, task and return wake on outer audit failure",async()=>{
    const f=await stageFixture(),{getNativeStageReviewAssignment}=await import("../services/native-runtime/native-stage-review.js");
    const {decideNativeStageReview}=await import("../services/native-runtime/native-stage-review-decision.js");
    const proof=(await getNativeStageReviewAssignment(db,{companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,contextSnapshot:f.context}))!;
    const input={companyId:f.company.id,issueId:f.issue.id,agentId:f.reviewer.id,runId:f.reviewerRun.id,request:{id:randomUUID(),stageId:proof.stage.id,admissionId:proof.admission.id,sourceDecisionId:proof.sourceDecision.id,expectedStatusVersion:proof.issue.statusVersion,outcome:"changes_requested" as const,body:"Audit atomicity"}};
    const before=await f.read(),ledger=await f.ledger();
    await db.execute(sql.raw(`create function f06_stage_audit_failure() returns trigger language plpgsql as $$ begin if new.action='issue.execution_stage_decided' then raise exception 'synthetic_f06_outer_audit_failure'; end if; return new; end $$; create trigger f06_stage_audit_failure before insert on activity_log for each row execute function f06_stage_audit_failure();`));
    try {await expect(decideNativeStageReview(db,input)).rejects.toMatchObject({cause:{message:"synthetic_f06_outer_audit_failure"}});}
    finally {await db.execute(sql.raw("drop trigger f06_stage_audit_failure on activity_log; drop function f06_stage_audit_failure();"));}
    expect(await f.read()).toEqual(before);expect(await f.ledger()).toEqual(ledger);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id,input.request.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,`native-stage-decision:${input.request.id}`))).toHaveLength(0);
    expect((await decideNativeStageReview(db,input)).replayed).toBe(false);
  });

  it("terminal scoped cancellation retains every lost-reply target and refuses Builder return without native termination proof",async()=>{
    const f=await reviewingDraftFixture(),url=`/api/issues/${f.issue.id}/scoped-reviews/${f.scope.id}/cancel`,body={requestId:randomUUID(),expectedVersion:1,reason:"Stop exact partial review"};
    executionFixture.loseStopReply=true;
    try {expect((await request(f.board).post(url).send(body)).status).toBe(500);}finally{executionFixture.loseStopReply=false;}
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.reviewerRun.id)))[0].status).toBe("cancelled");
    // Model native lock release arriving before the missing physical receipt.
    await db.update(issues).set({executionRunId:null}).where(eq(issues.id,f.issue.id));
    executionFixture.suppressStopProof=true;
    try {const denied=await request(f.board).post(url).send(body);expect(denied.status,JSON.stringify(denied.body)).toBe(409);expect(denied.body.details.code).toBe("scoped_review_stop_unsettled");}
    finally {executionFixture.suppressStopProof=false;}
    let [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));
    expect(scope).toMatchObject({state:"cancelling",returnWakeupId:null,cancellation:{targetRunIds:[f.reviewerRun.id]}});
    expect((await f.ledger()).admissions).toHaveLength(1);
    ok(await request(f.board).post(url).send(body));ok(await request(f.board).post(url).send(body));
    [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));
    expect(scope).toMatchObject({state:"cancelled",cancellation:{targetRunIds:[f.reviewerRun.id]}});
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,`native-scoped-return:${f.scope.id}:cancelled`))).toHaveLength(1);
    const [returned]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.builder.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,scopeKind:"issue",status:"queued",wakeupRequestId:scope.returnWakeupId,contextSnapshot:{issueId:f.issue.id,scopedReviewId:scope.id}}).returning();
    const {assertScopedRunAdmission}=await import("../services/scoped-review-admission.js");const reader=(await import("../services/heartbeat.js")).heartbeatService(db).readRunTerminationProof;
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:returned.id},{readRunTerminationProof:reader})).resolves.toBeUndefined();
    await db.update(heartbeatRuns).set({processPid:process.pid,processGroupId:null,processStartedAt:new Date()}).where(eq(heartbeatRuns.id,f.reviewerRun.id));
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:returned.id},{readRunTerminationProof:reader})).rejects.toMatchObject({details:{code:"scoped_review_stop_unsettled"}});
  });

  it("queued context-only scoped Stop uses native never-dispatched proof and refuses a foreign task binding",async()=>{
    const f=await admittedDraftFixture();
    const [queued]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.reviewer.id,status:"queued",responsibleUserId:f.userId,
      contextSnapshot:{taskId:f.issue.id,nativeReviewInteractionId:f.scope.interactionId}}).returning();
    const body={requestId:randomUUID(),expectedVersion:1,reason:"Withdraw queued partial review"};
    ok(await request(f.board).post(`/api/issues/${f.issue.id}/scoped-reviews/${f.scope.id}/cancel`).send(body));
    const [scope]=await db.select().from(issueScopedReviews).where(eq(issueScopedReviews.id,f.scope.id));
    expect(scope).toMatchObject({state:"cancelled",cancellation:{targetRunIds:[queued.id]}});
    const reader=(await import("../services/heartbeat.js")).heartbeatService(db).readRunTerminationProof;
    expect(await reader({companyId:f.company.id,runId:queued.id})).toMatchObject({runId:queued.id,issueId:f.issue.id,proof:"never_dispatched"});
    const [returned]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.builder.id,runtimeMode:"native",nativeIssueId:f.issue.id,issueId:f.issue.id,status:"queued",wakeupRequestId:scope.returnWakeupId,contextSnapshot:{issueId:f.issue.id,scopedReviewId:scope.id}}).returning();
    const {assertScopedRunAdmission}=await import("../services/scoped-review-admission.js");
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:returned.id},{readRunTerminationProof:reader})).resolves.toBeUndefined();
    const foreignId=randomUUID();
    await db.update(heartbeatRuns).set({issueId:null,nativeIssueId:null,contextSnapshot:{taskId:foreignId,nativeReviewInteractionId:f.scope.interactionId}}).where(eq(heartbeatRuns.id,queued.id));
    const [changedTarget]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,queued.id));
    expect((await import("../services/run-task-binding.js")).boundRunIssueId(changedTarget)).toBe(foreignId);
    await expect(assertScopedRunAdmission(db,{companyId:f.company.id,issueId:f.issue.id,runId:returned.id},{readRunTerminationProof:reader})).rejects.toMatchObject({details:{code:"scoped_review_return_waiting_release"}});
  });

});
