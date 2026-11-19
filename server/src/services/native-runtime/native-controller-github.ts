import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { issueWorkProducts, type Db, type agents, type heartbeatRuns, type issues } from "@paperclipai/db";
import type { NativeExecutionInput, WorkspaceAccessSnapshot } from "../../vendor/paperclip-runner/index.js";
import { resolvePinnedCodexCommand } from "../../vendor/paperclip-runner/index.js";
import { forbidden, conflict } from "../../errors.js";
import { nativeControllerGitState } from "../github-controller-policy.js";
import { reviewerActorRestricted } from "../reviewer-role.js";
import { resolveNativeControllerGitHubCredentials } from "../github-operation-credentials.js";
import { captureRunIdentity } from "../run-identity.js";
import { createGitAgentAttribution } from "@paperclipai/adapter-utils/github-agent-attribution";
import { executeAttributedGitPush, parseGitPushRequest, type GitPushBinding } from "../github-attributed-push.js";
import { createAttributedGitPushTransport } from "../github-attributed-push-git.js";
import { createPostgresGitPushReceiptStore,nativeGitPushReceiptSql } from "../github-attributed-push-store.js";
import { createNativeReviewerGitHubStore } from "../reviewer-github-native-store.js";
import type { ReviewerGitHubReceipt } from "../reviewer-github-store.js";
import { githubBotRequest } from "../chat-github-client.js";
import { nativePushRepository, repositoryIdentity, publishReceipt, ATTRIBUTED_GIT_PUSH_TOOL } from "./native-controller-github-receipts.js";
import { reviewerPullLocator } from "./reviewer-github-scope-admission.js";
import { loadAdmittedNativeGitWorkspace } from "./native-attributed-git-admission.js";
import { resolveNativeAttributedGitBinary } from "./native-attributed-git-executables.js";
import { nativeControllerInstallationIdentity } from "./native-controller-installation.js";
import { createNativeControllerGitRunner } from "./native-controller-git-runner.js";
import type { createNativeAttributedGitScope } from "./native-attributed-git-scope.js";

type Context={actor:typeof agents.$inferSelect;run:Pick<typeof heartbeatRuns.$inferSelect,"id"|"companyId"|"agentId"|"status"|"responsibleUserId">;issue:typeof issues.$inferSelect};
const hash=(x:unknown)=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const COMMENT_TOOL={name:"comment_github_pull_request",description:"Post an attributed comment or PR review reply to this task's one native GitHub PR work product. Destination is server-selected. Use one stable UUID per distinct write; uncertain operations are never automatically retried.",inputSchema:{type:"object",additionalProperties:false,properties:{action:{type:"string",enum:["comment","reply"]},body:{type:"string",minLength:1,maxLength:10000},commentId:{type:"string",pattern:"^[1-9][0-9]*$"},idempotencyKey:{type:"string",format:"uuid"}},required:["action","body","idempotencyKey"]}};
function commentInput(value:unknown){
  if(!value||typeof value!=="object"||Array.isArray(value))throw forbidden("Invalid comment action");const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!["action","body","commentId","idempotencyKey"].includes(k))||(typeof v.action!=="string"||!["comment","reply"].includes(v.action))||typeof v.body!=="string"||!v.body.trim()||v.body.length>10000||typeof v.idempotencyKey!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.idempotencyKey))throw forbidden("Invalid comment action");
  if(v.action==="reply"?(typeof v.commentId!=="string"||!/^[1-9][0-9]{0,19}$/.test(v.commentId)):v.commentId!==undefined)throw forbidden("Invalid reply parent");
  return {action:v.action as "comment"|"reply",body:v.body,idempotencyKey:v.idempotencyKey,...(v.action==="reply"?{commentId:v.commentId as string}:{})};
}

/** Real native producer. No injection of runner, credentials, DB authority,
 * successful action or runtime availability from JSON/tool arguments. Existing
 * stronger auxiliary SDK mode remains separate and unavailable. */
export async function createNativeControllerGitActions(input:{db:Db;execution:NativeExecutionInput;workspaceAccess?:WorkspaceAccessSnapshot;targetKind:"local"|"remote";scope:ReturnType<typeof createNativeAttributedGitScope>;runtimeDirectory:string;protectedPaths:string[];filesystemEnvironment:Pick<NodeJS.ProcessEnv,"PAPERCLIP_GIT_METADATA_ROOTS"|"PAPERCLIP_RUNNER_NETWORK_ACCESS"|"PAPERCLIP_RUNNER_NETWORK_ROOTS">}){
 const {db,execution,scope}=input,binding=execution.binding;
 if(!(await nativeControllerGitState(db,binding)).admitted)return undefined;
 if(input.targetKind!=="local"||execution.provider.kind!=="codex"||execution.task.workMode!=="standard"||"homeMode"in execution&&execution.homeMode==="preconfigured"||!execution.workspace.repoUrl)throw forbidden("Recorded GitHub writes require isolated local native Codex");
 if(await reviewerActorRestricted(db,binding))return undefined; // Reviewer keeps its existing separate closed actions.
 const repository=nativePushRepository(execution.workspace.repoUrl);
 const installation=await nativeControllerInstallationIdentity();
 let saved:WorkspaceAccessSnapshot|undefined;
 const current=async()=>{
   scope.signal.throwIfAborted();
   if(await nativeControllerInstallationIdentity()!==installation)throw forbidden("Native installed source/current changed");
   if(await reviewerActorRestricted(db,binding)||!(await nativeControllerGitState(db,binding)).admitted)throw forbidden("Recorded GitHub run permissions changed");
   const value=await loadAdmittedNativeGitWorkspace(db,execution,input.workspaceAccess);
   scope.signal.throwIfAborted();if(value.policy.readOnlyWorkspace||saved&&value.digest!==saved.digest)throw forbidden("Recorded GitHub workspace admission changed");
   return value;
 };
 const admittedWorkspace=await current();saved=admittedWorkspace;
 await mkdir(input.runtimeDirectory,{recursive:true,mode:0o700});
 const gitBinary=await resolveNativeAttributedGitBinary(input.runtimeDirectory);
 const runner=await createNativeControllerGitRunner({scope,workspace:admittedWorkspace,runtimeDirectory:input.runtimeDirectory,gitBinary,codexCommand:resolvePinnedCodexCommand(undefined,{PATH:""},input.runtimeDirectory),protectedPaths:input.protectedPaths,filesystemEnvironment:input.filesystemEnvironment,assertCurrent:async()=>{await current();}});
 const authorize=async(callback:()=>Promise<Context>)=>{await current();const c=await callback();if(c.run.id!==binding.runId||c.run.agentId!==binding.agentId||c.run.companyId!==binding.companyId||c.issue.id!==binding.issueId||c.issue.companyId!==binding.companyId||!c.issue.projectId||c.run.status!=="running"||c.issue.workMode!=="standard")throw forbidden("Recorded GitHub actor/run changed");await current();return c;};
 const credentials=async()=>{await current();const value=await resolveNativeControllerGitHubCredentials(db,binding);await current();if(value.status!=="available"||value.authenticationMode!=="managed"||!value.identityContextId||!Number.isSafeInteger(value.revision)||!value.env.PAPERCLIP_GIT_TOKEN)throw forbidden("A current managed GitHub identity is required");return value;};
 return {
  retire:()=>scope.retire(),abort:()=>scope.abort("native tool authority retired"),
  push:{definition:ATTRIBUTED_GIT_PUSH_TOOL,async execute(value:unknown,callback:()=>Promise<Context>){return scope.track(async()=>{
   const request=parseGitPushRequest(value),initial=await authorize(callback),credential=await credentials();
   const provider=await repositoryIdentity(repository.fullName,credential.env.PAPERCLIP_GIT_TOKEN!);await authorize(callback);
   const label=createGitAgentAttribution({agentId:binding.agentId,runId:binding.runId,issueId:binding.issueId,nameAtTime:initial.actor.name});
   const bound:GitPushBinding={...binding,projectId:initial.issue.projectId!,repositoryId:provider.id,repositoryFullName:provider.fullName,nameAtTime:label.nameAtTime};
   const store=createPostgresGitPushReceiptStore(nativeGitPushReceiptSql(db));
   let writeCredential=credential;
   const receipt=await executeAttributedGitPush({binding:bound,request,store,authorizeCurrent:async(_bound,stage)=>{try{await authorize(callback);const now=await captureRunIdentity(db,binding);if(now.context?.id!==credential.identityContextId||now.context.revision!==credential.revision)return false;if(stage==="write"){const next=await credentials();if(next.identityContextId!==credential.identityContextId||next.revision!==credential.revision||next.connectionId!==credential.connectionId||next.grantId!==credential.grantId)return false;writeCredential=next;}return true;}catch{return false;}},createTransport:async()=>{
    const transport=()=>createAttributedGitPushTransport({cwd:admittedWorkspace.policy.workspaceDirectory,repositoryFullName:repository.fullName,remoteUrl:repository.httpsUrl,credentialEnvironment:writeCredential.env,gitBinary},runner);
    const reads=transport();return {...reads,push:request=>transport().push(request)};
   }});
   await publishReceipt(db,receipt,initial.run.responsibleUserId);return receipt;
  });}},
  comment:{definition:COMMENT_TOOL,async execute(value:unknown,callback:()=>Promise<Context>){return scope.track(async()=>{
   const action=commentInput(value),initial=await authorize(callback),credential=await credentials();
   const products=await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId,binding.companyId),eq(issueWorkProducts.issueId,binding.issueId),eq(issueWorkProducts.projectId,initial.issue.projectId!),eq(issueWorkProducts.executionWorkspaceId,binding.executionWorkspaceId),eq(issueWorkProducts.type,"pull_request"),eq(issueWorkProducts.provider,"github")));
   const locators=new Map(products.map(p=>{const l=reviewerPullLocator(p.url);return [`${l.repository.toLowerCase()}#${l.pullNumber}`,l] as const;}));
   if(locators.size!==1)throw forbidden("This task needs one unambiguous native PR work product");const locator=[...locators.values()][0]!;
   if(locator.repository.toLowerCase()!==repository.fullName.toLowerCase())throw forbidden("PR work product is outside the admitted repository");
   const scopedFetch:typeof fetch=(url,init)=>{scope.signal.throwIfAborted();return fetch(url,{...init,signal:AbortSignal.any([scope.signal,...(init?.signal?[init.signal]:[])])});};
   let writeToken=credential.env.PAPERCLIP_GIT_TOKEN!;
   const request=<T>(path:string,options?:{method?:string;body?:unknown})=>{scope.signal.throwIfAborted();return githubBotRequest<T>(scopedFetch,writeToken,path,options);};
   type Pull={number:number;state:string;head:{sha:string};base:{repo:{id:number;full_name:string}}};
   const path=`/repos/${repository.fullName}/pulls/${locator.pullNumber}`,pull=await request<Pull>(path);
   if(pull.number!==locator.pullNumber||pull.state!=="open"||!Number.isSafeInteger(pull.base.repo.id)||pull.base.repo.id<1||pull.base.repo.full_name.toLowerCase()!==repository.fullName.toLowerCase()||!/^[a-f0-9]{40}$/.test(pull.head.sha))throw forbidden("Native PR provider scope changed");
   const store=createNativeReviewerGitHubStore(db); // Shared durable schema; no fabricated Reviewer assignment or role grant.
   const base={company_id:binding.companyId,agent_id:binding.agentId,run_id:binding.runId,issue_id:binding.issueId,project_id:initial.issue.projectId!,repository_id:String(pull.base.repo.id),repository:pull.base.repo.full_name,pull_number:pull.number,head_sha:pull.head.sha};
   const requestHash=hash({base,action}),name=createGitAgentAttribution({agentId:binding.agentId,runId:binding.runId,issueId:binding.issueId,nameAtTime:initial.actor.name}).nameAtTime;
   const staged=await store.stage({...base,action:action.action,idempotency_key:action.idempotencyKey,request_hash:requestHash,agent_name:name,request_payload:action});
   if(staged.request_hash!==requestHash)throw conflict("Comment idempotency conflict");
   if(staged.status!=="pending")return {status:staged.status,receipt:staged.receipt};
   if(typeof staged.agent_name!=="string")throw conflict("Stored comment agent name invalid");
   const recordedName=createGitAgentAttribution({agentId:binding.agentId,runId:binding.runId,issueId:binding.issueId,nameAtTime:staged.agent_name}).nameAtTime;
   if(recordedName!==staged.agent_name)throw conflict("Stored comment agent name changed");
   const owned=await store.claim(staged.id,binding.companyId);if(!owned)return {status:"pending",receipt:null};let attempted=false;
   try{
    await authorize(callback);const now=await credentials();if(now.identityContextId!==credential.identityContextId||now.revision!==credential.revision||now.connectionId!==credential.connectionId||now.grantId!==credential.grantId)throw forbidden("GitHub identity changed");writeToken=now.env.PAPERCLIP_GIT_TOKEN!;
    if(action.action==="reply"){const parent=await request<{id:number;pull_request_url:string}>(`/repos/${repository.fullName}/pulls/comments/${action.commentId}`);if(String(parent.id)!==action.commentId||parent.pull_request_url!==`https://api.github.com/repos/${pull.base.repo.full_name}/pulls/${pull.number}`)throw forbidden("Reply parent is outside assigned PR");}
    await authorize(callback);scope.signal.throwIfAborted();attempted=true;
    const escaped=recordedName.replace(/[\\`*_{}[\]()<>]/g,c=>`\\${c}`),body=`${action.body}\n\n---\nPaperclip agent: ${escaped}\nAgent: \`${binding.agentId}\` · Task: \`${binding.issueId}\` · Run: \`${binding.runId}\``;
    const posted=await request<{id:number;html_url:string;in_reply_to_id?:number}>(action.action==="reply"?`${path}/comments/${action.commentId}/replies`:`/repos/${repository.fullName}/issues/${pull.number}/comments`,{method:"POST",body:{body}});
    if(!Number.isSafeInteger(posted.id)||posted.id<1||action.action==="reply"&&String(posted.in_reply_to_id)!==action.commentId)throw conflict("Comment acknowledgement unavailable");
    const url=new URL(posted.html_url);if(url.origin!=="https://github.com"||url.pathname!==`/${pull.base.repo.full_name}/pull/${pull.number}`||url.username||url.password||url.search)throw conflict("Comment target changed");
    const after=await request<Pull>(path);if(after.number!==pull.number||after.head.sha!==pull.head.sha||after.base.repo.id!==pull.base.repo.id||after.base.repo.full_name!==pull.base.repo.full_name)throw conflict("PR changed during comment publication");
    const receipt:ReviewerGitHubReceipt={operationId:staged.id,action:action.action,...binding,projectId:initial.issue.projectId!,agentNameAtTime:recordedName,repositoryId:base.repository_id,repository:base.repository,pullNumber:pull.number,headSha:pull.head.sha,commentId:String(posted.id),url:posted.html_url};
    const final=await store.settle(staged.id,binding.companyId,"confirmed",receipt,null,owned.claim_token);if(!final)throw conflict("Comment receipt settlement unavailable");return {status:final.status,receipt:final.receipt};
   }catch{const final=await store.settle(staged.id,binding.companyId,attempted?"uncertain":"rejected",null,attempted?"github_write_outcome_uncertain":"controller_preflight_rejected",owned.claim_token);if(!final)throw conflict("Comment requires reconciliation");return {status:final.status,receipt:final.receipt};}
  });}},
 };
}
export type NativeControllerGitActions=NonNullable<Awaited<ReturnType<typeof createNativeControllerGitActions>>>;
