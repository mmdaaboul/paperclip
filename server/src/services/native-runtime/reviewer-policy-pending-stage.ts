import { and, eq, or, sql } from "drizzle-orm";
import { issues, issueReviewCycleBudgets, type Db } from "@paperclipai/db";
import { issueReviewCycleBudgetSchema } from "@paperclipai/shared";
import { getNativeStageReviewAssignment } from "./native-stage-review.js";
import { conflict } from "../../errors.js";

/** Enabling restrictions may retain an already genuine native stage. A manual
 * or historical assignment may never acquire an invented accepted source. */
export async function assertReviewerPendingStagesHaveNativeSource(db:Db,input:{companyId:string;agentId:string}) {
  const pending=await db.select().from(issues).where(and(eq(issues.companyId,input.companyId),eq(issues.status,"in_review"),
    or(eq(issues.assigneeAgentId,input.agentId),sql`${issues.executionState}->'currentParticipant'->>'agentId'=${input.agentId}`))).limit(129);
  if(pending.length>128)throw conflict("Pending native stages exceed the bounded owner inspection; reconcile them before enabling",{code:"reviewer_pending_stage_inspection_overflow"});
  for(const issue of pending) {
    const [ledger]=await db.select().from(issueReviewCycleBudgets).where(and(eq(issueReviewCycleBudgets.companyId,input.companyId),eq(issueReviewCycleBudgets.issueId,issue.id)));
    const admission=ledger?issueReviewCycleBudgetSchema.parse(ledger.ledger).admissions.at(-1):null;
    const proof=admission && issue.lastStatusDecisionId?await getNativeStageReviewAssignment(db,{...input,issueId:issue.id,
      contextSnapshot:{nativeStageDecisionId:issue.lastStatusDecisionId,nativeStageAdmissionId:admission.id,nativeStageStatusVersion:issue.statusVersion}}):null;
    if(!proof)throw conflict("An existing manual stage cannot acquire protected Reviewer authority; reconcile its native source first",{code:"reviewer_pending_manual_stage_requires_native_source"});
  }
}
