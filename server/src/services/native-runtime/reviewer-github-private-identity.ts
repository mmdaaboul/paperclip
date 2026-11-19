import type { Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { captureRunIdentity } from "../run-identity.js";
import { resolveManagedGitHubCredential } from "../git-credentials.js";
import { secretService } from "../secrets.js";
import type { ReviewerGitHubBinding } from "../reviewer-github-actions.js";
/** Reuses native accepted identity/grant resolution privately. Never exported
 * through environment, argv, tools, receipts or a second credential broker. */
export async function nativeReviewerPrivateToken(db:Db,binding:ReviewerGitHubBinding):Promise<string>{
 const {context}=await captureRunIdentity(db,binding);if(!context)throw forbidden("The current accepted GitHub identity is unavailable");
 const result=await resolveManagedGitHubCredential(db,secretService(db),binding.companyId,{agentId:binding.agentId,heartbeatRunId:binding.runId,issueId:binding.issueId,
 responsibleUserId:context.cause==="company_default"?null:context.responsibleUserId,allowStandingDelegation:false});
 if(!result.configured||!result.credential)throw forbidden("Select an available native managed GitHub identity for this Reviewer");return result.credential.token;
}
