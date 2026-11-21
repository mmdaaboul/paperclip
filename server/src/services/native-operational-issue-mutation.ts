import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { persistActivity, type ActivityPublication } from "./activity-log.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueService, type IssuePostCommitAction } from "./issues.js";
import { applyLockedReviewBudgetTransition } from "./review-cycle-budget-store.js";

export type NativeOperationalTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Issue = typeof issues.$inferSelect;
export type NativeOperationalIssueSnapshot = Pick<Issue,
  "statusVersion" | "status" | "assigneeAgentId" | "assigneeUserId" | "executionRunId" | "checkoutRunId">;

/** These are internal, already-authorized native operations, not request bodies.
 * The caller must validate its actual lease/hold/durable receipt in this SAME
 * outer transaction. A receiptId is audit provenance, never proof by itself. */
export type NativeOperationalIssueOperation =
  | { kind: "failure_block"; runId: string; target: "blocked" | "in_review" }
  | { kind: "owned_resume"; runId: string; receiptId: string; target: "todo" | "in_progress" | "in_review" }
  | { kind: "continuation"; receiptId: string }
  | { kind: "handoff"; receiptId: string; caseHandoffId?: string; assignee: { agentId: string; userId?: never } | { userId: string; agentId?: never } }
  | { kind: "owned_cancel"; receiptId: string };

export interface NativeOperationalIssueMutation {
  companyId: string;
  issueId: string;
  expected: NativeOperationalIssueSnapshot;
  operation: NativeOperationalIssueOperation;
  actor?: { agentId?: string | null; userId?: string | null; runId?: string | null };
}

type DeferredCode = "native_operational_issue_changed" | "native_operational_review_pending"
  | "native_operational_scope_pending" | "native_operational_review_transition_required";
export type NativeOperationalIssueMutationResult =
  | { kind: "applied" | "unchanged"; issue: Issue }
  | { kind: "deferred"; code: DeferredCode }
  | { kind: "projection_failed"; code: "native_operational_projection_failed"; errorClass: "database" | "domain" | "unknown" };

class DeferredProjection extends Error {
  constructor(readonly code: DeferredCode) { super(code); }
}

export function nativeOperationalIssueSnapshot(issue: NativeOperationalIssueSnapshot): NativeOperationalIssueSnapshot {
  return { statusVersion: issue.statusVersion, status: issue.status, assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId, executionRunId: issue.executionRunId, checkoutRunId: issue.checkoutRunId };
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function requestedPatch(operation: NativeOperationalIssueOperation): Record<string, unknown> {
  // Runtime validation also rejects an accidental/untyped external patch. No
  // policy, state, done/review verdict, allowance or arbitrary field is accepted.
  const keys = Object.keys(operation).sort().join(",");
  switch (operation.kind) {
    case "failure_block":
      if (keys !== "kind,runId,target" || !nonempty(operation.runId)
        || !["blocked", "in_review"].includes(operation.target)) break;
      return { status: operation.target };
    case "owned_resume":
      if (keys !== "kind,receiptId,runId,target" || !nonempty(operation.runId) || !nonempty(operation.receiptId)
        || !["todo", "in_progress", "in_review"].includes(operation.target)) break;
      return { status: operation.target };
    case "continuation":
      if (keys !== "kind,receiptId" || !nonempty(operation.receiptId)) break;
      return { status: "todo" };
    case "handoff": {
      if (!["assignee,kind,receiptId", "assignee,caseHandoffId,kind,receiptId"].includes(keys)
        || !nonempty(operation.receiptId) || !operation.assignee
        || (operation.caseHandoffId !== undefined && operation.caseHandoffId !== operation.receiptId)) break;
      // Preserve the native setter's exception for the SAME admitted case
      // handoff; otherwise assignment invalidates/cancels its pending owner.
      const caseOwner = operation.caseHandoffId ? { caseHandoffId: operation.caseHandoffId } : {};
      const principalKeys = Object.keys(operation.assignee).join(",");
      if (principalKeys === "agentId" && nonempty(operation.assignee.agentId)) {
        return { status: "todo", assigneeAgentId: operation.assignee.agentId, assigneeUserId: null, ...caseOwner };
      }
      if (principalKeys === "userId" && nonempty(operation.assignee.userId)) {
        return { status: "todo", assigneeAgentId: null, assigneeUserId: operation.assignee.userId, ...caseOwner };
      }
      break;
    }
    case "owned_cancel":
      if (keys !== "kind,receiptId" || !nonempty(operation.receiptId)) break;
      return { status: "cancelled" };
  }
  throw new Error("native_operational_operation_invalid");
}

function stageIdentity(state: unknown) {
  if (state == null) return state;
  if (typeof state !== "object" || Array.isArray(state)) throw new Error("native_operational_state_invalid");
  const { monitor: _monitor, totalReviewCyclesUsed: _used, totalReviewCycleAllowance: _allowance, ...identity } = state as Record<string, unknown>;
  return identity;
}

/** A projection savepoint is deliberately separate from the caller's original
 * run failure/recovery writes. A refusal rolls back ONLY this projection. The
 * caller must retain the returned secondary outcome with its original error,
 * and publish queued activities/actions only after its OUTER transaction commits.
 * No result permits an automatic retry, replacement run or review verdict. */
export async function mutateNativeOperationalIssue(
  owner: NativeOperationalTransaction,
  input: NativeOperationalIssueMutation,
  publications: ActivityPublication[],
  postCommitActions: IssuePostCommitAction[],
): Promise<NativeOperationalIssueMutationResult> {
  if (typeof owner.rollback !== "function") throw new Error("native_operational_outer_transaction_required");
  if (!Array.isArray(publications) || !Array.isArray(postCommitActions)
    || !Object.isExtensible(publications) || !Object.isExtensible(postCommitActions)) {
    throw new Error("native_operational_outer_commit_effect_queues_required");
  }
  const localPublications: ActivityPublication[] = [], localActions: IssuePostCommitAction[] = [];
  try {
    const outcome = await owner.transaction(async tx => {
      const request = requestedPatch(input.operation);
      const [locked] = await tx.select().from(issues).where(and(
        eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
      )).for("update");
      if (!locked || !Number.isSafeInteger(input.expected.statusVersion)
        || !isDeepStrictEqual(nativeOperationalIssueSnapshot(locked), nativeOperationalIssueSnapshot(input.expected))) {
        throw new DeferredProjection("native_operational_issue_changed");
      }
      const operationRunId = "runId" in input.operation ? input.operation.runId : null;
      if (operationRunId && [locked.executionRunId, locked.checkoutRunId].some(id => id && id !== operationRunId)) {
        throw new DeferredProjection("native_operational_issue_changed");
      }
      const policy = normalizeIssueExecutionPolicy(locked.executionPolicy);
      const total5 = policy?.totalReviewCycles === 5;
      const previousState = parseIssueExecutionState(locked.executionState);
      if (total5) {
        if (locked.executionState != null && !previousState) throw new Error("native_operational_state_invalid");
        if (previousState?.status === "pending" || previousState?.totalReviewBudgetHold) {
          throw new DeferredProjection("native_operational_review_pending");
        }
        const scopes = await tx.execute(sql`select id from issue_scoped_reviews where company_id=${input.companyId}
          and issue_id=${input.issueId} and state in ('draft','pending','cancelling') limit 1 for share`);
        if (Array.from(scopes).length) throw new DeferredProjection("native_operational_scope_pending");
        if (request.status === "in_review") throw new DeferredProjection("native_operational_review_transition_required");
      }
      const setter = issueService(tx as unknown as Db);
      let updated: Issue | null = null;
      const persist = async (patch: Record<string, unknown>) => {
        updated = await setter.update(input.issueId, { ...patch, companyGuard: input.companyId,
          actorAgentId: input.actor?.agentId ?? null, actorUserId: input.actor?.userId ?? null,
          actorRunId: input.actor?.runId ?? null }, tx, localPublications, localActions);
        if (!updated) throw new DeferredProjection("native_operational_issue_changed");
      };
      if (total5) {
        await applyLockedReviewBudgetTransition(tx, { companyId: input.companyId, issueId: input.issueId,
          expectedStoredPolicy: policy, transition: { previousPolicy: policy,
            requestedStatus: request.status as string, requestedAssigneePatch: {
              ...(request.assigneeAgentId !== undefined ? { assigneeAgentId: request.assigneeAgentId as string | null } : {}),
              ...(request.assigneeUserId !== undefined ? { assigneeUserId: request.assigneeUserId as string | null } : {}),
            }, actor: {} } }, async (_sameTx, _issue, result) => {
          const merged = { ...request, ...result.patch };
          const terminalContinuation = input.operation.kind === "continuation" && ["done", "cancelled"].includes(locked.status)
            && (!previousState || previousState.status === "completed") && result.patch.executionState === null;
          const nextState = result.patch.executionState === undefined ? locked.executionState : result.patch.executionState;
          if (result.decision || result.workflowControlledAssignment
            || Object.entries(request).some(([key, value]) => !isDeepStrictEqual(merged[key], value))
            || (!terminalContinuation && !isDeepStrictEqual(stageIdentity(nextState), stageIdentity(locked.executionState)))) {
            throw new DeferredProjection("native_operational_review_transition_required");
          }
          await persist(merged);
        });
      } else await persist(input.operation.kind === "continuation" && ["done", "cancelled"].includes(locked.status)
        ? { ...request, executionState: null } : request);
      const saved = updated as Issue | null;
      if (!saved) throw new Error("native_operational_projection_missing");
      const unchanged = isDeepStrictEqual(nativeOperationalIssueSnapshot(locked), nativeOperationalIssueSnapshot(saved))
        && isDeepStrictEqual(locked.executionState, saved.executionState);
      const { publication } = await persistActivity(tx as unknown as Db, {
        companyId: input.companyId, actorType: input.actor?.agentId ? "agent" : input.actor?.userId ? "user" : "system",
        actorId: input.actor?.agentId ?? input.actor?.userId ?? "native-operational-issue", agentId: input.actor?.agentId,
        runId: input.actor?.runId ?? ("runId" in input.operation ? input.operation.runId : null),
        action: "issue.native_operational_projection", entityType: "issue", entityId: input.issueId, issueId: input.issueId,
        details: { operation: input.operation.kind, previousStatus: locked.status, status: saved.status,
          receiptId: "receiptId" in input.operation ? input.operation.receiptId : null,
          reviewAdmissionCreated: false, reviewDecisionCreated: false },
      });
      localPublications.push(publication);
      return { kind: unchanged ? "unchanged" as const : "applied" as const, issue: saved };
    });
    publications.push(...localPublications); postCommitActions.push(...localActions);
    return outcome;
  } catch (error) {
    if (error instanceof DeferredProjection) return { kind: "deferred", code: error.code };
    return { kind: "projection_failed", code: "native_operational_projection_failed",
      errorClass: error instanceof HttpError ? "domain" : typeof error === "object" && error !== null && "severity" in error ? "database" : "unknown" };
  }
}
