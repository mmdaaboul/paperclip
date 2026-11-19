import { join } from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { referenceFolderProtectedPaths } from "../agent-reference-folder-paths.js";
import { and, eq, sql } from "drizzle-orm";
import { agentReviewerPolicies, heartbeatRuns, issueWorkProducts, executionWorkspaces, type Db } from "@paperclipai/db";
import { agentReviewerScopeSchema } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { githubBotRequest } from "../chat-github-client.js";
import { parseNativeExecutionInput, inspectReadonlyReviewerCandidate, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { resolveNativeReviewerAssignment, nativeReviewerAssignmentId } from "./reviewer-native-assignment.js";
import { parseReviewerWorkspaceAdmission } from "./reviewer-workspace-admission.js";
import { validateNativeReviewerExecution } from "./reviewer-runtime-admission.js";
import { reviewerWorkspaceRepository } from "../reviewer-repository-scope.js";
import { nativeReviewerPrivateToken } from "./reviewer-github-private-identity.js";
import type { NativeReviewerGitHubScope } from "./reviewer-github-authorization.js";
const repoPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function reviewerPullLocator(value:string|null){
 if(!value)throw forbidden("A native PR work-product locator is required");let url:URL;try{url=new URL(value);}catch{throw forbidden("Native PR locator is invalid");}
 const match=/^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
 if(url.protocol!=="https:"||url.hostname!=="github.com"||url.port||url.username||url.password||url.search||url.hash||!match||!repoPattern.test(`${match[1]}/${match[2]}`)||!Number.isSafeInteger(Number(match[3])))throw forbidden("Only a canonical native GitHub PR locator is supported");
 return {repository:`${match[1]}/${match[2]}`,pullNumber:Number(match[3])};
}
type Pull={number:number;state:string;head:{sha:string;ref:string;repo:{id:number;full_name:string}|null};base:{repo:{id:number;full_name:string}}};
/** Model-visible URLs are only locators. Authority comes from the real current
 * native assignment + source run/workspace + a confirmed server Git receive-pack
 * receipt and fresh provider PR identity. First producer supports same-repo PRs;
 * forks/ambiguous/unattributed heads refuse instead of inferring authority. */
export async function prepareNativeReviewerGitHubScope(db:Db,execution:NativeExecutionInput,fetchImpl:typeof fetch=fetch):Promise<NativeReviewerGitHubScope>{
 const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,execution.binding.runId));
 const admitted=parseReviewerWorkspaceAdmission(run?.runnerProfileJson?.reviewerPolicy);
 await validateNativeReviewerExecution(db,execution,admitted.workspaceAccess);
 const binding={companyId:admitted.binding.companyId,agentId:admitted.binding.agentId,runId:admitted.binding.runId,issueId:admitted.binding.issueId,projectId:admitted.binding.projectId};
 const [role]=await db.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId,binding.companyId),eq(agentReviewerPolicies.agentId,binding.agentId)));
 const assignment=await resolveNativeReviewerAssignment(db,{...binding,contextSnapshot:run!.contextSnapshot,actingRunId:run!.id,issueExecutionRunId:run!.id});
 if(!role?.enabled||role.revision!==admitted.revision||!assignment||nativeReviewerAssignmentId(assignment.record)!==nativeReviewerAssignmentId(admitted.assignment)||assignment.record.kind!==admitted.assignment.kind||assignment.sourceDecision.id!==admitted.assignment.sourceDecisionId||assignment.sourceRun.id!==admitted.assignment.sourceRunId)throw forbidden("The native Reviewer assignment changed");
 let source: NativeExecutionInput;
 try { source=parseNativeExecutionInput(assignment.sourceRun.runnerProfileJson?.nativeExecutionInput); }
 catch(error) {
  if(error instanceof Error && (error as Error & {code?:unknown}).code==='native_execution_input_invalid')throw forbidden("The source native execution is unavailable or incompatible; PR discussion is unavailable",{code:"reviewer_source_execution_unverified"});
  throw error;
 }
 if(source.binding.companyId!==binding.companyId||source.binding.issueId!==binding.issueId||source.binding.agentId!==assignment.sourceRun.agentId||source.binding.runId!==assignment.sourceRun.id)throw forbidden("The native source run has no exact execution proof");
 const [workspace]=await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id,source.binding.executionWorkspaceId),eq(executionWorkspaces.companyId,binding.companyId),eq(executionWorkspaces.projectId,binding.projectId)));
 if(!workspace||workspace.status!=="active"||workspace.cwd!==source.workspace.cwd||workspace.branchName!==source.workspace.branchName||workspace.repoUrl!==source.workspace.repoUrl)throw forbidden("The source native workspace changed or is unsupported");
 const products=await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId,binding.companyId),eq(issueWorkProducts.issueId,binding.issueId),eq(issueWorkProducts.projectId,binding.projectId),eq(issueWorkProducts.executionWorkspaceId,workspace.id),eq(issueWorkProducts.createdByRunId,assignment.sourceRun.id),eq(issueWorkProducts.type,"pull_request"),eq(issueWorkProducts.provider,"github")));
 const locators=new Map(products.map(product=>{const locator=reviewerPullLocator(product.url);return [`${locator.repository.toLowerCase()}#${locator.pullNumber}`,locator] as const;}));
 if(locators.size!==1)throw forbidden("Native PR ownership is missing or ambiguous; engineering or an explicit work-product correction is required");
 const locator=[...locators.values()][0]!,sourceRepo=reviewerWorkspaceRepository(workspace.repoUrl!).fullName;
 if(locator.repository.toLowerCase()!==sourceRepo.toLowerCase())throw forbidden("Fork-head PR mapping is not qualified for Reviewer discussion");
 const permitted=role.scopes.map(value=>agentReviewerScopeSchema.parse(value)).find(scope=>scope.projectId===binding.projectId&&scope.repository.toLowerCase()===locator.repository.toLowerCase());
 if(!permitted)throw forbidden("The PR base repository is outside the operator-owned Reviewer policy");
 const token=await nativeReviewerPrivateToken(db,binding),pull=await githubBotRequest<Pull>(fetchImpl,token,`/repos/${locator.repository}/pulls/${locator.pullNumber}`);
 if(pull.state!=="open"||pull.number!==locator.pullNumber||!pull.head.repo||!Number.isSafeInteger(pull.head.repo.id)||!Number.isSafeInteger(pull.base.repo.id)||String(pull.base.repo.id)!==permitted.repositoryId||pull.base.repo.full_name.toLowerCase()!==locator.repository.toLowerCase()||pull.head.repo.id!==pull.base.repo.id||pull.head.repo.full_name.toLowerCase()!==sourceRepo.toLowerCase()||pull.head.ref!==workspace.branchName||!/^([a-f0-9]{40})$/.test(pull.head.sha))throw forbidden("The provider PR is not the exact current authorized native candidate");
 const receipts=await db.execute(sql`SELECT id FROM github_push_operation_receipts WHERE company_id=${binding.companyId}::uuid AND agent_id=${assignment.sourceRun.agentId}::uuid AND run_id=${assignment.sourceRun.id}::uuid AND state='confirmed' AND confirmation_source='git_receive_pack_status' AND binding->>'issueId'=${binding.issueId} AND binding->>'projectId'=${binding.projectId} AND binding->>'executionWorkspaceId'=${workspace.id} AND binding->>'repositoryId'=${String(pull.head.repo.id)} AND lower(binding->>'repositoryFullName')=${pull.head.repo.full_name.toLowerCase()} AND request->>'ref'=${`refs/heads/${pull.head.ref}`} AND request->>'newOid'=${pull.head.sha} LIMIT 1`);
 if(receipts.length!==1)throw forbidden("This exact PR head has no confirmed native server push ownership receipt; discussion is unavailable", { code: "reviewer_source_push_unverified" });
 const candidate=await inspectReadonlyReviewerCandidate({policy:admitted.workspaceAccess.policy,privateRuntimeDirectory:join(resolvePaperclipInstanceRoot(),'reviewer-inspection',binding.runId),protectedPaths:referenceFolderProtectedPaths()});
 if(candidate.headSha!==pull.head.sha)throw forbidden("The read-only local candidate is not the exact admitted PR head");
 const scope:NativeReviewerGitHubScope={schema:"paperclip.reviewer-github-scope.v1",binding,roleRevision:role.revision,assignment:{kind:assignment.record.kind,id:nativeReviewerAssignmentId(assignment.record),sourceDecisionId:assignment.sourceDecision.id},repositoryId:permitted.repositoryId,repository:pull.base.repo.full_name,pullNumber:pull.number,headSha:pull.head.sha};
 // Recheck authority after the remote read; a stale provider response grants nothing.
 await validateNativeReviewerExecution(db,execution,admitted.workspaceAccess);
 const current=await resolveNativeReviewerAssignment(db,{...binding,contextSnapshot:run!.contextSnapshot,actingRunId:run!.id,issueExecutionRunId:run!.id});
 if(!current||nativeReviewerAssignmentId(current.record)!==scope.assignment.id||current.record.kind!==scope.assignment.kind||current.sourceDecision.id!==scope.assignment.sourceDecisionId)throw forbidden("The native review changed during PR inspection");
 await db.update(heartbeatRuns).set({runnerProfileJson:sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({reviewerGitHubScope:scope})}::jsonb`}).where(and(eq(heartbeatRuns.id,binding.runId),eq(heartbeatRuns.status,"running")));
 return scope;
}
