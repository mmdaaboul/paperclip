import { createUuid } from "../lib/uuid";
import { useEffect, useId, useRef, useState } from "react";
import type { Issue } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

type Props = { issue: Issue; currentUserId: string | undefined };

function decisionKey({ issue, currentUserId }: Props): string | null {
  const state = issue.executionState;
  if (!currentUserId || typeof issue.statusVersion !== "number" || !Number.isSafeInteger(issue.statusVersion) || issue.statusVersion < 0
    || issue.assigneeAgentId || issue.assigneeUserId !== currentUserId || issue.status !== "in_review" || state?.status !== "pending"
    || !state.currentStageId || !["review", "approval"].includes(state.currentStageType ?? "")
    || state.currentParticipant?.type !== "user"
    || state.currentParticipant.userId !== currentUserId) return null;
  if (!issue.executionPolicy?.stages.some((stage) =>
    stage.id === state.currentStageId && stage.type === state.currentStageType)) return null;
  return JSON.stringify([issue.id, issue.companyId, issue.statusVersion, issue.executionPolicy, state]);
}

export function IssueExecutionDecision(props: Props) {
  const key = decisionKey(props);
  // A different task, stage, or participant must never inherit a decision draft.
  return key ? <DecisionForm key={key} {...props} expectedKey={key} /> : null;
}

function DecisionForm({ issue, currentUserId, expectedKey }: Props & { expectedKey: string }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const busy = useRef(false);
  const allowanceId = useRef(createUuid());
  const mounted = useRef(true);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [allowanceSaved, setAllowanceSaved] = useState(false);
  const stage = issue.executionState?.currentStageType === "review" ? "review" : "approval";

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function refresh() {
    // Refresh task detail by UUID and identifier, the thread, lists, and inbox.
    for (const queryKey of [
      ["issues"], queryKeys.attention(issue.companyId), queryKeys.sidebarBadges(issue.companyId),
      ["decisions", issue.companyId], ["decision-queues", issue.companyId],
      queryKeys.dashboard(issue.companyId), queryKeys.activity(issue.companyId),
    ]) void queryClient.invalidateQueries({ queryKey });
  }

  async function decide(status: "done" | "in_progress" | "allow_one_more") {
    const body = comment.trim();
    if (!body || busy.current || locked || saved) return;
    busy.current = true;
    setPending(true);
    setError(null);
    let submitted = false;
    try {
      const latest = await issuesApi.get(issue.id, { cache: "no-store" });
      if (!mounted.current) return;
      if (decisionKey({ issue: latest, currentUserId }) !== expectedKey) {
        setLocked(true);
        setError("This task's review stage changed. Refresh the task and review its latest state before deciding.");
        refresh();
        return;
      }
      submitted = true;
      // The server checks the current human participant and records the decision
      // and comment together. Do not override assignees, policies, or execution state.
      await issuesApi.update(issue.id, status==="allow_one_more"
        ? {reviewCycleAllowance:{id:allowanceId.current,additionalCycles:1,reason:body}}
        : {
        status, comment: body,
        expectedExecutionDecision: { statusVersion: latest.statusVersion, executionPolicy: latest.executionPolicy, executionState: latest.executionState },
      });
      setAllowanceSaved(status==="allow_one_more");
      setSaved(true);
      setComment("");
      refresh();
    } catch (cause) {
      if (submitted && !(cause instanceof ApiError && cause.status < 500)) {
        setLocked(true);
        setError("Could not confirm whether your decision was saved. Refresh this task and check its activity before trying again.");
        refresh();
      } else if (cause instanceof ApiError && cause.status === 409) {
        setLocked(true);
        setError("This task changed before your decision was saved. Review its latest stage before deciding.");
        refresh();
      } else {
        setError(cause instanceof Error ? cause.message : "Could not save your decision. Please try again.");
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy={pending}>
      {saved ? <p role="status" className="text-sm">{allowanceSaved?"One additional review cycle was authorized; earlier usage is retained.":<>Your {stage} decision was saved.</>}</p> : <>
        {issue.executionPolicy?.totalReviewCycles===5 && issue.executionState?.totalReviewCyclesUsed!==undefined && <p className="text-xs text-muted-foreground">Review cycles: {issue.executionState.totalReviewCyclesUsed} of {issue.executionState.totalReviewCycleAllowance} used.</p>}
        {issue.executionState?.totalReviewBudgetHold && <p className="text-sm">The review allowance is exhausted. Earlier usage remains counted; only an explicit human allowance permits another correction cycle.</p>}
        <label htmlFor={inputId} className="text-sm font-medium">Decision comment (required)</label>
        <Textarea
          id={inputId} value={comment} required disabled={pending || locked}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Explain your approval or the changes needed."
        />
        {issue.executionPolicy?.totalReviewCycles===5 && issue.executionState?.totalReviewBudgetHold && <Button type="button" variant="outline" disabled={pending||locked||!comment.trim()} onClick={()=>void decide("allow_one_more")}>Allow one additional review cycle</Button>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" disabled={pending || locked || !comment.trim()}
            onClick={() => void decide("in_progress")}>Request changes</Button>
          <Button type="button" disabled={pending || locked || !comment.trim()}
            onClick={() => void decide("done")}>{pending ? "Saving…" : "Approve"}</Button>
        </div>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
