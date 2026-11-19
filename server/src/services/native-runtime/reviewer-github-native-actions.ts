import { createNativeAttributedGitScope } from "./native-attributed-git-scope.js";
import type { Db } from "@paperclipai/db";
import { createReviewerGitHubActions, type ReviewerGitHubBinding } from "../reviewer-github-actions.js";
import type { ReviewerGitHubStore } from "../reviewer-github-store.js";
import { createNativeReviewerGitHubStore } from "../reviewer-github-native-store.js";
import { nativeReviewerGitHubAuthorization, type NativeReviewerAuthorizationOptions } from "./reviewer-github-authorization.js";
import { nativeReviewerRuntimeQualification, validateNativeReviewerExecution } from "./reviewer-runtime-admission.js";
import { nativeReviewerPrivateToken } from "./reviewer-github-private-identity.js";
import { createReviewerFixVerificationProducer, loadNativeReviewerFixVerification } from "./reviewer-fix-verification.js";
import { HttpError } from "../../errors.js";
import type { NativeExecutionInput, WorkspaceAccessSnapshot } from "../../vendor/paperclip-runner/index.js";
import { prepareNativeReviewerGitHubScope } from "./reviewer-github-scope-admission.js";
import { createReviewerGitHubToolAdapter } from "./reviewer-github-tools.js";

/** Provider availability cannot grant discussion access or remove filesystem
 * restrictions. Unknown schema/database/programming failures remain fatal. */
export async function prepareOptionalNativeReviewerDiscussion(db: Db, input: {
 execution: NativeExecutionInput; workspaceAccess: WorkspaceAccessSnapshot;
 onUnavailable?: (message: string) => Promise<void>; fetchImpl?: typeof fetch;
}) {
 await validateNativeReviewerExecution(db,input.execution,input.workspaceAccess);
 try {
  const scope=await prepareNativeReviewerGitHubScope(db,input.execution,input.fetchImpl);
  return bindNativeReviewerDiscussionLifetime(db,scope.binding,input.fetchImpl);
 } catch(error) {
  const details=error instanceof HttpError && error.details && typeof error.details==='object' ? error.details as {code?:unknown;providerStatus?:unknown} : null;
  const providerUnavailable=error instanceof HttpError && error.status===422 && (
   details?.code==='github_bot_temporarily_unavailable'||details?.code==='github_bot_rate_limited'||
   (details?.code==='github_bot_operation_failed'&&typeof details.providerStatus==='number'&&Number.isInteger(details.providerStatus)&&details.providerStatus>=400&&details.providerStatus<=599));
  if(!(error instanceof HttpError)||!(error.status===403||providerUnavailable))throw error;
  // A permission change during remote IO is not an availability fallback.
  await validateNativeReviewerExecution(db,input.execution,input.workspaceAccess);
  await input.onUnavailable?.(error.message);
  return undefined;
 }
}
/** Production factory always binds the actual protected native runtime/context
 * predicate and immutable native fix-evidence owner. Neither can be replaced by
 * a controller caller's success boolean or an environment/model argument. */
export function createNativeReviewerGitHubActions(db:Db,options:Omit<NativeReviewerAuthorizationOptions,'assertRuntimeQualified'>&{store?:ReviewerGitHubStore;fetchImpl?:typeof fetch;assertCurrent?:()=>void}={}){
 const nativeAuthorize=nativeReviewerGitHubAuthorization(db,{...options,assertRuntimeQualified:nativeReviewerRuntimeQualification(db)}),store=options.store??createNativeReviewerGitHubStore(db);
 const authorize:typeof nativeAuthorize=async binding=>{options.assertCurrent?.();const scope=await nativeAuthorize(binding);options.assertCurrent?.();return scope;};
 const resolvePrivateToken=async(scope:Awaited<ReturnType<typeof authorize>>)=>{await authorize(scope.binding);return nativeReviewerPrivateToken(db,scope.binding);};
 const actions=createReviewerGitHubActions({store,authorize,resolvePrivateToken,loadVerifiedFix:(binding,id)=>loadNativeReviewerFixVerification(db,binding,id),fetchImpl:options.fetchImpl});
 return {...actions,recordFixVerification:createReviewerFixVerificationProducer(db,{store,authorize,resolvePrivateToken,fetchImpl:options.fetchImpl})};
}

/** One native tool-authority lifetime. Reuses the existing operation scope;
 * no timer, recovery producer or provider/session owner is introduced. */
export function bindNativeReviewerDiscussionLifetime(db:Db,binding:ReviewerGitHubBinding,fetchImpl:typeof fetch=fetch){
 const lifetime=createNativeAttributedGitScope();
 const assertCurrent=()=>lifetime.signal.throwIfAborted();
 const scopedFetch:typeof fetch=async(input,init)=>{
  assertCurrent();
  const incoming=init?.signal??(input instanceof Request?input.signal:undefined);
  const response=await fetchImpl(input,{...init,signal:incoming?AbortSignal.any([lifetime.signal,incoming]):lifetime.signal});
  assertCurrent();return response;
 };
 const adapter=createReviewerGitHubToolAdapter(binding,createNativeReviewerGitHubActions(db,{fetchImpl:scopedFetch,assertCurrent}));
 return {...adapter,execute:(call:Parameters<typeof adapter.execute>[0])=>lifetime.track(()=>adapter.execute(call)),
  close:()=>lifetime.abort("native Reviewer authority retired"),settle:()=>lifetime.retire()};
}
