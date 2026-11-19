import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { agents, agentReviewerPolicies, agentTaskSessions, agentInstructionWorkingCopies, heartbeatRuns,
  environmentLeases, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../../errors.js";
import { nativeSha256 } from "./canonical.js";
import { readReviewerProcessEvidence } from "./reviewer-policy-process-proof.js";
import { closeWarmNativeSessionsForAgentPolicy, inspectNativeAgentPolicyWarmOwners, inspectStoppedNativeReviewerOwners } from "./native-session-executor.js";

type Scope = { companyId: string; agentId: string; expectedRevision: number };
const issued = new WeakMap<object, () => boolean>();
const frontierBound = 128;
function refuse(message: string, code = "reviewer_policy_retirement_unverified"): never { throw conflict(message, { code }); }
export function rethrowNativeReviewerPolicyBudgetFailure(error: unknown): never {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "55P03" || candidate.code === "57014") refuse("Native permission verification is busy. Saved state and Reviewer permissions are unchanged.", "reviewer_retirement_time_budget");
    current = candidate.cause;
  }
  throw error;
}
export function nativeReviewerAgentConfigurationFingerprint(agent: typeof agents.$inferSelect) {
  return nativeSha256(JSON.parse(JSON.stringify({ adapterType: agent.adapterType, adapterConfig: agent.adapterConfig,
    runtimeConfig: agent.runtimeConfig, defaultEnvironmentId: agent.defaultEnvironmentId, permissions: agent.permissions,
    status: agent.status, lifecycleState: agent.lifecycleState, lifecycleVersion: agent.lifecycleVersion })));
}
export interface NativeReviewerRetirementReceipt {
  readonly companyId: string; readonly agentId: string; readonly expectedRevision: number;
  readonly fingerprint: string; readonly configurationBeforeSha256: string; readonly configurationAfterSha256: string;
}

/** A bounded current-owner frontier, not a replay or rewrite of old history.
 * A terminal status/finalizer/expired lease is never process-stop evidence.
 * Unproved latest launches remain candidates even after PID fields were cleared.
 */
async function frontier(db: Db, scope: Scope, beforeClose = false) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId)));
  if (!agent) throw notFound("Agent not found");
  const [role] = await db.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId, scope.companyId), eq(agentReviewerPolicies.agentId, scope.agentId)));
  if ((role?.revision ?? 0) !== scope.expectedRevision) refuse("Reviewer settings changed; reload before saving.", "reviewer_policy_revision_changed");
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
    notInArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]))).limit(1);
  if (active) refuse("Stop active or queued work through its native owner before changing the Reviewer role.", "reviewer_active_execution");
  const [coordinator] = await db.select({ id: heartbeatRuns.id }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId), eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId), or(
      notInArray(nativeRunFinalizations.phase, ["committed", "terminal_failure"]),
      sql`${nativeRunFinalizations.recoveryState} is not null`,
      sql`${nativeRunFinalizations.leaseOwner} is not null`, sql`${nativeRunFinalizations.nextAttemptAt} is not null`))).limit(1);
  if (coordinator) refuse("Native recovery or finalization still owns this agent; use that existing owner before changing permissions.");
  const leases = await db.select({ lease: environmentLeases }).from(environmentLeases).innerJoin(heartbeatRuns,
    and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId), or(
      isNull(environmentLeases.releasedAt), eq(environmentLeases.status, "pending_cleanup"), eq(environmentLeases.cleanupStatus, "failed")))).limit(1);
  if (leases.length) refuse("A retained environment still needs native release or cleanup. An expired lease is not retirement.");
  const copies = await db.select().from(agentInstructionWorkingCopies).where(and(eq(agentInstructionWorkingCopies.companyId, scope.companyId), eq(agentInstructionWorkingCopies.agentId, scope.agentId),
    notInArray(agentInstructionWorkingCopies.state, ["saved", "unchanged", "resolved", "superseded"]))).limit(1);
  if (copies.length && !beforeClose) refuse("Native instruction collection is unfinished; saved candidates were preserved.", "reviewer_instruction_collection_pending");
  const sessions = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, scope.companyId), eq(agentTaskSessions.agentId, scope.agentId))).limit(frontierBound + 1);
  if (sessions.length > frontierBound) refuse("Too many retained session scopes to qualify in this bounded permission change.", "reviewer_retirement_frontier_bound");
  const lastIds = sessions.flatMap(session => session.lastRunId ? [session.lastRunId] : []);
  const latestLaunch = sql<string>`(select e.event_type from heartbeat_run_events e where e.company_id = ${heartbeatRuns.companyId}
    and e.run_id = ${heartbeatRuns.id} and e.source_event_id is null
    and e.event_type in ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped') order by e.seq desc limit 1)`;
  const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId), or(
    lastIds.length ? inArray(heartbeatRuns.id, lastIds) : sql`false`,
    sql`${heartbeatRuns.processPid} is not null or ${heartbeatRuns.processGroupId} is not null`,
    sql`${heartbeatRuns.runtimeMode} = 'native' and (${heartbeatRuns.nativeSessionId} is not null or ${heartbeatRuns.runnerInstanceId} is not null) and ${latestLaunch} is null`,
    sql`${latestLaunch} in ('native.process_start_requested', 'native.process_identity_recorded')`,
    sql`${heartbeatRuns.runnerProfileJson} ? 'nativeStartupContext'`,
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'`))).limit(frontierBound + 1);
  if (runs.length > frontierBound) refuse("The retained owner frontier exceeds this operation's bounded inspection. No history was removed.", "reviewer_retirement_frontier_bound");
  if (lastIds.some(id => !runs.some(run => run.id === id))) refuse("A session pointer has no matching native run owner; engineering reconciliation is required.");
  if (runs.some(run => run.runnerProfileJson?.nativeStartupContext || (run.runnerProfileJson?.nativeWorkspaceSync as { state?: unknown } | undefined)?.state === "prepared")) {
    refuse("Native startup or workspace preservation is unfinished; permissions were not changed.");
  }
  const coordinators = runs.length ? await db.select({ owner: nativeRunFinalizations, result: nativeRunResults })
    .from(nativeRunFinalizations).leftJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.runId, nativeRunFinalizations.runId), eq(nativeRunResults.companyId, nativeRunFinalizations.companyId), eq(nativeRunResults.issueId, nativeRunFinalizations.issueId)))
    .where(and(eq(nativeRunFinalizations.companyId, scope.companyId), inArray(nativeRunFinalizations.runId, runs.map(run => run.id)))) : [];
  for (const run of runs) {
    const matched = coordinators.find(row => row.owner.runId === run.id);
    if (!matched || matched.owner.issueId !== run.nativeIssueId || !run.finishedAt ||
        run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date() ||
        run.status === "succeeded" && (matched.owner.phase !== "committed" || !matched.result || matched.result.schemaStatus !== "accepted" || matched.result.completionContractId !== run.completionContractId)) {
      refuse("A retained native run lacks its settled, correctly bound coordinator/result owner. Use native reconciliation; state was preserved.");
    }
  }
  const events = await readReviewerProcessEvidence(db, scope.companyId, runs.map(run => run.id));
  const fingerprint = nativeSha256(JSON.parse(JSON.stringify({ configuration: nativeReviewerAgentConfigurationFingerprint(agent), role: role ?? null,
    sessions: sessions.sort((a, b) => a.id.localeCompare(b.id)), runs: runs.sort((a, b) => a.id.localeCompare(b.id)), coordinators, events })));
  return { agent, runs, events, fingerprint };
}

export async function retireNativeReviewerExecutions(db: Db, scope: Scope): Promise<NativeReviewerRetirementReceipt> {
  const before = await frontier(db, scope, true);
  const closure = await closeWarmNativeSessionsForAgentPolicy(scope);
  if (closure.busy || closure.failed || inspectNativeAgentPolicyWarmOwners(scope).length) refuse("The selected native owner did not retire and collect successfully. No active work was interrupted.");
  const after = await frontier(db, scope);
  const configurationBeforeSha256 = nativeReviewerAgentConfigurationFingerprint(before.agent);
  const configurationAfterSha256 = nativeReviewerAgentConfigurationFingerprint(after.agent);
  if (configurationBeforeSha256 !== configurationAfterSha256) refuse("Saved runtime configuration changed during native retirement. Reload before changing Reviewer permissions.", "reviewer_configuration_drift");
  let proof: Awaited<ReturnType<typeof inspectStoppedNativeReviewerOwners>>;
  try { proof = await inspectStoppedNativeReviewerOwners({ runs: after.runs, processEvidence: after.events }); }
  catch (error) {
    if (error instanceof Error && /^reviewer_retirement_[a-z_]+$/.test(error.message)) refuse("A retained native owner needs native reconciliation; permissions and saved state are unchanged.", error.message);
    throw error;
  }
  if (!await proof.recheck()) refuse("Native stopped-owner evidence changed during permission verification.");
  if (inspectNativeAgentPolicyWarmOwners(scope).length) refuse("A native owner appeared during permission verification.");
  const receipt = Object.freeze({ ...scope, fingerprint: after.fingerprint, configurationBeforeSha256, configurationAfterSha256 });
  issued.set(receipt, proof.current); return receipt;
}

/** Caller holds the native agent row lock. Recheck the DB frontier, then the
 * fixed bounded local file/PID observation synchronously immediately before CAS.
 * No process is signalled or started; there is no network or async OS probe.
 * A changed observation refuses instead of qualifying a new owner under lock. */
export async function assertNativeReviewerRetirementCurrent(db: Db, receipt: NativeReviewerRetirementReceipt, scope: Scope) {
  if (!issued.has(receipt) || receipt.companyId !== scope.companyId || receipt.agentId !== scope.agentId || receipt.expectedRevision !== scope.expectedRevision) refuse("Native retirement evidence is missing or belongs to another operation.");
  if (inspectNativeAgentPolicyWarmOwners(scope).length) refuse("A native owner appeared before the policy commit.");
  const current = await frontier(db, scope);
  if (current.fingerprint !== receipt.fingerprint) refuse("Native execution or configuration changed after retirement; reload before saving.");
  if (!issued.get(receipt)!()) refuse("Native file or process evidence changed before the policy commit. Saved state is intact.");
}
