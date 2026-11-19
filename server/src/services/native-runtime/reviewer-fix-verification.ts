import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { documentRevisions, issueDocuments, type Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { documentService } from "../documents.js";
import { githubBotRequest } from "../chat-github-client.js";
import type { ReviewerGitHubAuthorization, ReviewerGitHubBinding, ReviewerFixVerification } from "../reviewer-github-actions.js";
import type { ReviewerGitHubStore } from "../reviewer-github-store.js";
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const uuid=z.string().guid();
const bindingSchema=z.object({companyId:uuid,agentId:uuid,runId:uuid,issueId:uuid,projectId:uuid}).strict();
const artifactSchema=z.object({schema:z.literal("paperclip.reviewer-fix-verification.v1"),binding:bindingSchema,findingOperationId:uuid,repositoryId:z.string().regex(/^[1-9][0-9]*$/),repository:z.string().min(3),pullNumber:z.number().int().positive(),checkedHeadSha:z.string().regex(/^[a-f0-9]{40}$/),path:z.string().min(1).max(1024),gitBlobSha:z.string().regex(/^[a-f0-9]{40}$/),fileSha256:z.string().regex(/^[a-f0-9]{64}$/),decision:z.literal("fixed"),explanation:z.string().min(1).max(10000)}).strict();
const inputSchema=z.object({findingOperationId:uuid,explanation:z.string().trim().min(1).max(10000)}).strict();
const exactBinding=(a:ReviewerGitHubBinding,b:ReviewerGitHubBinding)=>(["companyId","agentId","runId","issueId","projectId"] as const).every(key=>a[key]===b[key]);
function safePath(value:unknown):string{if(typeof value!=="string"||!value||value.length>1024||value.startsWith("/")||/[\\\x00-\x1f\x7f]/.test(value)||value.split("/").some(x=>!x||x==="."||x===".."))throw forbidden("This finding has no supported file path");return value;}
/** Read immutable native revision ownership; caller-provided receipt IDs/hashes
 * alone are never proof. Generic Reviewer document mutation remains denied. */
export async function loadNativeReviewerFixVerification(db:Db,binding:ReviewerGitHubBinding,id:string):Promise<ReviewerFixVerification|null>{
 if(!uuid.safeParse(id).success)return null;
 const [row]=await db.select({revision:documentRevisions,issueId:issueDocuments.issueId,key:issueDocuments.key}).from(documentRevisions).innerJoin(issueDocuments,eq(issueDocuments.documentId,documentRevisions.documentId)).where(and(eq(documentRevisions.id,id),eq(documentRevisions.companyId,binding.companyId),eq(issueDocuments.issueId,binding.issueId)));
 if(!row||row.revision.createdByAgentId!==binding.agentId||row.revision.createdByRunId!==binding.runId||row.key!==`reviewer-fix-${sha(row.revision.body).slice(0,48)}`)return null;
 let parsed:unknown;try{parsed=JSON.parse(row.revision.body);}catch{return null;}const artifact=artifactSchema.safeParse(parsed);if(!artifact.success||!exactBinding(artifact.data.binding,binding))return null;
 return {id:row.revision.id,binding:artifact.data.binding,findingOperationId:artifact.data.findingOperationId,checkedHeadSha:artifact.data.checkedHeadSha,artifactDigest:sha(row.revision.body),decision:'fixed'};
}
/** A recorded Reviewer judgment is not an automatic semantic proof. This closed
 * producer proves which exact provider bytes were examined and by which native
 * agent/run, then records that judgment in an immutable native document revision.
 * Deleted/binary/large/symlink/submodule findings currently refuse explicitly. */
export function createReviewerFixVerificationProducer(db:Db,options:{authorize:(binding:ReviewerGitHubBinding)=>Promise<ReviewerGitHubAuthorization>;store:ReviewerGitHubStore;resolvePrivateToken:(scope:ReviewerGitHubAuthorization)=>Promise<string>;fetchImpl?:typeof fetch}){
 return async(binding:ReviewerGitHubBinding,argumentsValue:unknown)=>{
  const input=inputSchema.parse(argumentsValue),scope=await options.authorize(binding),original=await options.store.get(input.findingOperationId,binding.companyId);
  if(!original||original.status!=="confirmed"||original.action!=="comment"||!original.receipt?.findingKey||!original.receipt.commentId||original.company_id!==binding.companyId||original.agent_id!==binding.agentId||original.issue_id!==binding.issueId||original.project_id!==binding.projectId||original.repository_id!==scope.repositoryId||original.repository.toLowerCase()!==scope.repository.toLowerCase()||original.pull_number!==scope.pullNumber)throw forbidden("Only this Paperclip agent's confirmed finding may be verified");
  const finding=original.request_payload.finding as Record<string,unknown>|undefined,path=safePath(finding?.path),token=await options.resolvePrivateToken(scope),fetchImpl=options.fetchImpl??fetch;
  const prefix=`/repos/${scope.repository.split('/').map(encodeURIComponent).join('/')}`;
  const check=async()=>{const pull=await githubBotRequest<{number:number;head:{sha:string};base:{repo:{id:number;full_name:string}}}>(fetchImpl,token,`${prefix}/pulls/${scope.pullNumber}`);if(pull.number!==scope.pullNumber||pull.head.sha!==scope.headSha||String(pull.base.repo.id)!==scope.repositoryId||pull.base.repo.full_name.toLowerCase()!==scope.repository.toLowerCase())throw forbidden("The PR candidate changed during verification");};
  await check();
  const file=await githubBotRequest<{type:string;encoding:string;content:string;size:number;sha:string;path:string}>(fetchImpl,token,`${prefix}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${scope.headSha}`);
  if(file.type!=="file"||file.encoding!=="base64"||file.path!==path||!Number.isSafeInteger(file.size)||file.size<0||file.size>1048576||typeof file.content!=="string"||file.content.length>1500000||!/^([A-Za-z0-9+/=\r\n]*)$/.test(file.content))throw forbidden("This finding requires manual verification: unsupported provider file");
  const bytes=Buffer.from(file.content,'base64'),blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(bytes.length!==file.size||blob!==file.sha||bytes.includes(0))throw forbidden("Provider file content could not be verified");
  await check();const current=await options.authorize(binding);
  if(current.repositoryId!==scope.repositoryId||current.repository.toLowerCase()!==scope.repository.toLowerCase()||current.pullNumber!==scope.pullNumber||current.headSha!==scope.headSha||current.assignment.id!==scope.assignment.id||current.role.revision!==scope.role.revision)throw forbidden("Reviewer assignment changed during verification");
  const artifact=artifactSchema.parse({schema:'paperclip.reviewer-fix-verification.v1',binding,findingOperationId:original.id,repositoryId:scope.repositoryId,repository:scope.repository,pullNumber:scope.pullNumber,checkedHeadSha:scope.headSha,path,gitBlobSha:blob,fileSha256:sha(bytes),decision:'fixed',explanation:input.explanation});
  const body=JSON.stringify(artifact),key=`reviewer-fix-${sha(body).slice(0,48)}`,service=documentService(db),existing=await service.getIssueDocumentByKey(binding.issueId,key);
  if(existing){if(existing.body!==body||existing.updatedByAgentId!==binding.agentId||!existing.latestRevisionId)throw forbidden("Verification evidence identity collision");return {verificationEvidenceId:existing.latestRevisionId,artifactDigest:sha(body),checkedHeadSha:scope.headSha,decision:'fixed' as const};}
  const saved=await db.transaction(async tx=>{
   const result=await documentService(tx as unknown as Db).upsertIssueDocument({issueId:binding.issueId,key,title:'Reviewer corresponding fix verification',format:'markdown',body,createdByAgentId:binding.agentId,createdByRunId:binding.runId,baseRevisionId:null});
   const audit=await persistActivity(tx as unknown as Db,{companyId:binding.companyId,actorType:'agent',actorId:binding.agentId,agentId:binding.agentId,runId:binding.runId,action:'reviewer.fix_verification_recorded',entityType:'issue',entityId:binding.issueId,details:{findingOperationId:original.id,verificationEvidenceId:result.document.latestRevisionId,checkedHeadSha:scope.headSha,artifactDigest:sha(body)}});
   return {verificationEvidenceId:result.document.latestRevisionId!,publication:audit.publication};
  });
  publishActivity(saved.publication);
  return {verificationEvidenceId:saved.verificationEvidenceId,artifactDigest:sha(body),checkedHeadSha:scope.headSha,decision:'fixed' as const};
 };
}
