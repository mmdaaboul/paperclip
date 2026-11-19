import { sql } from "drizzle-orm";
import { conflict } from "../errors.js";
import { parseIssueExecutionState, normalizeIssueExecutionPolicy, selectStageParticipant, type TransitionResult } from "./issue-execution-policy.js";
import type { ReviewCycleSubmission } from "@paperclipai/shared";
import type { ReviewBudgetTransaction } from "./review-cycle-budget-store.js";
function rows(value:unknown):Record<string,unknown>[] {if(Array.isArray(value))return value;if(value && typeof value==="object" && "rows" in value && Array.isArray(value.rows))return value.rows;throw new Error("Unsupported native policy SQL result");}
/** No11's operator-owned role table is the authority. This guard grants no
 * credential/tool privilege. It refuses an unusable generic handoff BEFORE any
 * task/count/wake mutation; the native accepted-result owner remains supported.
 */
export async function assertProtectedReviewSubmissionSupported(db:ReviewBudgetTransaction,input:{companyId:string;issueId:string;admission?:ReviewCycleSubmission;result:TransitionResult;lock?:boolean}) {
  const state=parseIssueExecutionState(input.result.patch.executionState),admission=input.admission;
  if(!admission || state?.status!=="pending" || state.currentStageType!=="review" || state.currentParticipant?.type!=="agent" || !state.currentParticipant.agentId)return;
  if(input.lock) {
    // The role setter locks this agent before its policy row. Lock the same
    // identity even when no policy row exists, so concurrent first enablement
    // cannot slip between this check and the native task/ledger commit.
    const reviewer=rows(await db.execute(sql`select id from agents where company_id=${input.companyId} and id=${state.currentParticipant.agentId} for share`));
    if(reviewer.length!==1)throw conflict("The selected independent Reviewer no longer exists");
  }
  const policy=rows(await db.execute(sql`select enabled from agent_reviewer_policies where company_id=${input.companyId} and agent_id=${state.currentParticipant.agentId} ${input.lock?sql`for share`:sql``}`))[0];
  if(policy?.enabled!==true)return;
  const accepted=rows(await db.execute(sql`select result.id from native_run_results result join heartbeat_runs r on r.id=result.run_id
    join native_run_finalizations coordinator on coordinator.run_id=r.id and coordinator.result_id=result.id
    where result.id::text=${admission.id} and result.company_id=${input.companyId} and result.issue_id=${input.issueId}
      and result.schema_status='accepted' and r.company_id=${input.companyId} and r.native_issue_id=${input.issueId}
      and r.id=${admission.builderRunId} and r.agent_id=${admission.builderAgentId} and r.runtime_mode='native'
      and ${admission.candidateId}='native-result:'||result.id::text||':'||result.canonical_sha256 ${input.lock?sql`for share of result,r,coordinator`:sql``}`));
  if(accepted.length!==1)throw conflict("This protected Reviewer requires the Builder's accepted native completion result. Finish this Builder turn with paperclip_finish so the native result owner can admit the candidate; generic manual/PATCH review submission is unsupported for this role. No cycle was spent and no handoff was made.",{code:"protected_review_requires_native_result"});
}

/** Generic PATCH cannot supply the server's accepted-native-result receipt.
 * Run this read-only check before native mutation authorization can adopt the
 * caller's checkout. The locked owner below repeats authoritative mediation.
 */
export async function assertProtectedGenericReviewHandoff(db:ReviewBudgetTransaction,input:{companyId:string;issueId:string;requestedStatus:unknown;executionPolicy:unknown;executionState:unknown;assigneeAgentId:string|null;assigneeUserId:string|null;requestedAssigneeAgentId?:string|null;requestedAssigneeUserId?:string|null}) {
  const current=parseIssueExecutionState(input.executionState),policy=normalizeIssueExecutionPolicy(input.executionPolicy);
  if(policy?.totalReviewCycles!==5 || !["done","in_review"].includes(String(input.requestedStatus)) || current?.status==="pending" || current?.status==="completed")return;
  const first=policy.stages[0];if(first?.type!=="review")return;
  const preferred=input.requestedAssigneeAgentId?{type:"agent" as const,agentId:input.requestedAssigneeAgentId,userId:null}:input.requestedAssigneeUserId?{type:"user" as const,userId:input.requestedAssigneeUserId,agentId:null}:null;
  const exclude=current?.returnAssignee??(input.assigneeAgentId?{type:"agent" as const,agentId:input.assigneeAgentId,userId:null}:input.assigneeUserId?{type:"user" as const,userId:input.assigneeUserId,agentId:null}:null);
  const selected=selectStageParticipant(first,{preferred,exclude}),reviewer=selected?.type==="agent"?selected.agentId:null;if(!reviewer)return;
  const role=rows(await db.execute(sql`select enabled from agent_reviewer_policies where company_id=${input.companyId} and agent_id=${reviewer}`))[0];
  if(role?.enabled===true)throw conflict("This protected Reviewer requires the Builder's accepted native completion result. Finish this Builder turn with paperclip_finish so the native result owner can admit the candidate; generic manual/PATCH review submission is unsupported for this role. No cycle was spent and no handoff was made.",{code:"protected_review_requires_native_result"});
}
