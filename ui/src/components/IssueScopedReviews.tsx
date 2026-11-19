import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, ScopedReview } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { createUuid } from "../lib/uuid";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function IssueScopedReviews({issue,currentUserId}:{issue:Issue;currentUserId:string|undefined}) {
  const query=useQuery({queryKey:["issues",issue.id,"scoped-reviews"],queryFn:()=>issuesApi.scopedReviews(issue.id),enabled:issue.executionPolicy?.totalReviewCycles===5});
  const client=useQueryClient();
  if(issue.executionPolicy?.totalReviewCycles!==5) return null;
  const refresh=()=>{void client.invalidateQueries({queryKey:["issues"]});};
  return <section aria-label="Scoped independent reviews" className="space-y-3 text-sm">
    <p className="font-medium">Scoped independent reviews</p>
    {query.isLoading?<p>Loading review history…</p>:query.isError?<p role="alert">Could not load scoped review usage. Refresh before deciding.</p>:<>
      {query.data?.budget?<p>{query.data.budget.used} of {query.data.budget.allowance} total task cycles used; {query.data.budget.remaining} remaining. Normal and partial reviews share this budget.</p>:<p>Usage requires reconciliation; a new allowance cannot erase history.</p>}
      <p>Passing a scope returns remaining work to the Builder. Final configured review and human approval still apply.</p>
      {query.data?.reviews.map(scope=><Scope key={`${issue.id}:${scope.id}`} scope={scope} currentUserId={currentUserId} refresh={refresh}/>)}
      {query.data?.reviews.length===0 && <p>No scoped reviews requested.</p>}
      {currentUserId && issue.assigneeUserId===currentUserId && issue.executionState?.totalReviewBudgetHold && issue.executionState.currentStageId===null && <Allowance key={`${issue.id}:${issue.statusVersion}`} issue={issue} refresh={refresh}/>}
    </>}
  </section>;
}
function Scope({scope,currentUserId,refresh}:{scope:ScopedReview;currentUserId:string|undefined;refresh:()=>void}) {
  const [reason,setReason]=useState(""),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
  const requestId=useRef(createUuid()),busy=useRef(false);
  async function cancel() {
    if(busy.current)return;const saved=scope.cancellation,body=saved?{requestId:saved.requestId,expectedVersion:saved.expectedVersion,reason:saved.reason}:{requestId:requestId.current,expectedVersion:scope.version,reason:reason.trim()};
    if(!body.reason)return;busy.current=true;setPending(true);setError(null);
    try {await issuesApi.cancelScopedReview(scope.issueId,scope.id,body);refresh();} catch(e) {setError(e instanceof Error?e.message:"Cancellation was not confirmed. Refresh and resume the recorded request.");refresh();} finally {busy.current=false;setPending(false);}
  }
  return <article className="space-y-2 rounded border p-2">
    <p>{scope.snapshot.purpose} — <strong>{scope.state}</strong></p>
    <p>Document revision: {scope.snapshot.revisionId}</p><p>Remaining work: {scope.snapshot.remainingWork}</p>
    {scope.verdict && <p>Recorded partial verdict: {scope.verdict}. Earlier usage remains counted.</p>}
    {currentUserId && ["draft","pending","cancelling"].includes(scope.state) && <>
      {scope.state==="cancelling"?<p>Native Stop is pending. Resume this exact recorded cancellation: {scope.cancellation?.reason}</p>:<label>Cancellation reason (required)<Textarea value={reason} onChange={e=>setReason(e.target.value)} disabled={pending}/></label>}
      <Button variant="outline" onClick={()=>void cancel()} disabled={pending || scope.state!=="cancelling" && !reason.trim()}>{pending?"Saving…":scope.state==="cancelling"?"Resume cancellation":"Cancel scoped review"}</Button>
      <p>Dispatched cycles stay counted. Cancellation returns no approval.</p>
    </>}{error && <p role="alert">{error}</p>}
  </article>;
}
function Allowance({issue,refresh}:{issue:Issue;refresh:()=>void}) {
  const [reason,setReason]=useState(""),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState(false);
  const id=useRef(createUuid()),busy=useRef(false);
  async function grant(){if(busy.current || !reason.trim() || saved)return;busy.current=true;setPending(true);
    try {await issuesApi.update(issue.id,{reviewCycleAllowance:{id:id.current,additionalCycles:1,reason:reason.trim()}});setSaved(true);refresh();}catch(e){setError(e instanceof Error?e.message:"Allowance was not confirmed. Refresh to inspect current usage.");refresh();}finally{busy.current=false;setPending(false);}}
  return <div className="space-y-2"><p>The shared allowance is exhausted. The Reviewer must settle before further work can start.</p>{saved?<p role="status">One additional shared cycle recorded; earlier usage is retained.</p>:<><label>Additional cycle reason (required)<Textarea value={reason} disabled={pending} onChange={e=>setReason(e.target.value)}/></label><Button disabled={pending || !reason.trim()} onClick={()=>void grant()}>Authorize one additional cycle</Button></>}{error && <p role="alert">{error}</p>}</div>;
}
