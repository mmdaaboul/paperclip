import os from "node:os";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { validatePrpEvent } from "../../vendor/paperclip-runner/index.js";
import { currentProcessSpaceHash } from "../controller-process-identity.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../native-local-process-stop.js";
import { nativeSha256 } from "./canonical.js";
import { proveNativeLocalRunnerStopped } from "./native-restart-recovery.js";

const PID_KEYS = ["processId", "process_id", "previousProcessId", "processGroupId", "providerPid", "codexPid", "sidecarPid", "agentPid", "agentProcessId"] as const;
const PRIVATE_EVENTS = [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, "native.local_process_stopped"];
const processPredicate = `$.prpEvent.payload.** ? (${PID_KEYS.map(key => `exists(@.${key})`).join(" || ")} || exists(@.pid))`;
type Run = typeof heartbeatRuns.$inferSelect;
export type ReviewerProcessEvidence = typeof heartbeatRunEvents.$inferSelect;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function refuse(reason: string): never { throw conflict("Native owner stop evidence is incomplete; permissions and retained state are unchanged.", { code: `reviewer_retirement_${reason}` }); }

/** Select identity-bearing records, not a recent-event window: ordinary output
 * can never evict an earlier provider identity from this bounded observation.
 * Overflow is explicit and never silently truncated. Also used DB-only at CAS. */
export async function readReviewerProcessEvidence(db: Db, companyId: string, runIds: string[]) {
  if (!runIds.length) return [];
  const rows = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, companyId), inArray(heartbeatRunEvents.runId, runIds),
    or(and(isNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType, PRIVATE_EVENTS)),
      inArray(heartbeatRunEvents.eventType, ["session.started", "session.resumed", "session.reconciled"]),
      sql`jsonb_path_exists(coalesce(${heartbeatRunEvents.payload}, '{}'::jsonb), ${processPredicate}::jsonpath)`),
  )).orderBy(asc(heartbeatRunEvents.runId), asc(heartbeatRunEvents.seq)).limit(1025);
  if (rows.length > 1024) refuse("process_evidence_bound");
  return rows;
}

/** Strictly inspect every recorded process reference, including nested sidecar
 * descriptors. This deliberately requires absence (PID and process group), so
 * missing/conflicting birth data cannot make a live or reused PID a waiver. */
export function reviewerRecordedProcessIds(value: unknown): number[] {
  const pids = new Set<number>();
  let visited = 0;
  function visit(input: unknown, depth: number) {
    if (++visited > 16_384 || depth > 24) refuse("process_evidence_shape");
    if (Array.isArray(input)) { for (const item of input) visit(item, depth + 1); return; }
    if (!input || typeof input !== "object") return;
    const owner = input as Record<string, unknown>;
    for (const [key, field] of Object.entries(owner)) {
      if ((PID_KEYS as readonly string[]).includes(key) || key === "pid" && owner.providerMethod === "acpx/process") {
        if (field == null) continue;
        if (!Number.isSafeInteger(field) || Number(field) <= 1) refuse("process_identity_malformed");
        pids.add(Number(field));
      } else if (field && typeof field === "object") visit(field, depth + 1);
    }
  }
  visit(value, 0);
  return [...pids];
}
function absent(pid: number) {
  return [pid, -pid].every(target => {
    try { process.kill(target, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  });
}

/** Read-only reuse of native restart recovery's exact Runner/group proof.
 * A terminal DB row, released lease or cleared mutable PID is not a stop proof.
 * The server launch event binds this PID observation to this local host. */
export async function proveReviewerRecordedOwnerStopped(run: Run, rows: ReviewerProcessEvidence[]) {
  const selected = rows.filter(row => row.runId === run.id);
  const launches = selected.filter(row => row.sourceEventId === null && PRIVATE_EVENTS.includes(row.eventType));
  const latest = launches.at(-1), identity = launches.findLast(row => row.eventType === PROCESS_IDENTITY_RECORDED);
  const providerRows = selected.filter(row => row.sourceEventId !== null || !PRIVATE_EVENTS.includes(row.eventType));
  if (!latest && !run.processPid && !run.processGroupId && !run.processStartedAt && !providerRows.length &&
      reviewerRecordedProcessIds(record(run.runnerProfileJson).sessionCheckpoint).length === 0) {
    if (run.nativeSessionId || run.runnerInstanceId || record(run.runnerProfileJson).nativeExecutionInput) refuse("runner_identity_missing");
    return { recheck: async () => true, current: () => true };
  }
  if (!identity || latest?.eventType === PROCESS_START_REQUESTED) refuse("runner_launch_unidentified");
  const launch = record(identity.payload);
  if (launch.targetKind !== "local" || launch.hostname !== os.hostname() ||
      run.processHostHash && run.processHostHash !== currentProcessSpaceHash()) refuse("foreign_process_space");
  const pid = launch.processPid, group = launch.processGroupId;
  const started = typeof launch.processStartedAt === "string" ? new Date(launch.processStartedAt) : null;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1 || group !== pid || !started || Number.isNaN(started.getTime()) ||
      run.processPid !== null && run.processPid !== pid || run.processGroupId !== null && run.processGroupId !== group ||
      run.processStartedAt && run.processStartedAt.getTime() !== started.getTime()) refuse("runner_identity_malformed");
  if (latest?.eventType === "native.local_process_stopped" &&
      (latest.payload?.processPid !== pid || latest.payload?.processGroupId !== group || latest.payload?.processStartedAt !== launch.processStartedAt)) refuse("runner_stop_mismatch");
  const pids = new Set(reviewerRecordedProcessIds(record(run.runnerProfileJson).sessionCheckpoint));
  for (const row of providerRows) {
    const event = record(record(row.payload).prpEvent);
    if (!validatePrpEvent(event).ok || event.sourceKind !== "runner" || event.sourceInstanceId !== run.runnerInstanceId ||
        event.runId !== run.id || event.normalizedSessionId !== run.nativeSessionId || event.sourceSeq !== row.sourceSeq ||
        event.eventType !== row.eventType || row.sourceInstanceId !== run.runnerInstanceId ||
        event.sourceEventId !== row.sourceEventId || row.sourceEventId !== `${run.runnerInstanceId}:${run.id}:${row.sourceSeq}` ||
        row.sourcePayloadSha256 !== nativeSha256(event)) refuse("provider_provenance");
    for (const providerPid of reviewerRecordedProcessIds(event.payload)) pids.add(providerPid);
  }
  if (!pids.size) refuse("provider_identity_unrecorded");
  const current = () => absent(Number(pid)) && [...pids].every(absent);
  const recheck = async () => {
    const proof = await proveNativeLocalRunnerStopped({ processPid: Number(pid), processGroupId: Number(group), processStartedAt: started,
      providerProcesses: [...pids].map(providerPid => ({ pid: providerPid, processStartedAt: null })) });
    return proof.stopped && current();
  };
  if (!await recheck()) refuse("recorded_process_alive_or_ambiguous");
  return { recheck, current };
}
