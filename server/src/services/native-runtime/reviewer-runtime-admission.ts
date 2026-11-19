import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agentReviewerPolicies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden } from "../../errors.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { parseNativeExecutionInput, parseWorkspaceAccessSnapshot, resolveCodexWorkspaceAccessPolicy, type NativeExecutionInput, type WorkspaceAccessSnapshot } from "../../vendor/paperclip-runner/index.js";
import { referenceFolderProtectedPaths } from "../agent-reference-folder-paths.js";
import { parseReviewerWorkspaceAdmission, reviewerWorkspaceBinding, reviewerAdmissionDigest, reviewerAdmissionInstruction, REVIEWER_CONTEXT_PATH, type ReviewerWorkspaceAdmission } from "./reviewer-workspace-admission.js";
import { resolveNativeReviewerAssignment, nativeReviewerAssignmentId } from "./reviewer-native-assignment.js";
import type { NativeReviewerAuthorizationOptions } from "./reviewer-github-authorization.js";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const equal=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const digest=(value:unknown)=>hash(JSON.stringify(canonical(value)));
const uuid=z.string().guid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const reviewerRuntimeAdmissionSchema=z.object({schema:z.literal("paperclip.reviewer-runtime-admission.v1"),runId:uuid,runnerInstanceId:uuid,nativeSessionId:uuid,
 admissionDigest:sha,executionDigest:sha,contextDigest:sha,policyDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),pid:z.number().int().positive(),processGroupId:z.number().int().positive().nullable(),processStartedAt:z.string().datetime()}).strict();
export type ReviewerRuntimeAdmission=z.infer<typeof reviewerRuntimeAdmissionSchema>;
const profile=(value:unknown)=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** Public hashes are consistency checks only. The protected run row and actual
 * controller transport callback are the origin of this admission. */
export async function validateNativeReviewerExecution(db:Db,execution:NativeExecutionInput,supplied:WorkspaceAccessSnapshot, options: { allowResolvedReview?: boolean } = {}):Promise<ReviewerWorkspaceAdmission>{
 const {companyId,agentId,runId,executionWorkspaceId}=execution.binding;
 const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,runId),eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.agentId,agentId)));
 const saved=profile(run?.runnerProfileJson),admission=parseReviewerWorkspaceAdmission(saved.reviewerPolicy);
 const [issue]=await db.select().from(issues).where(and(eq(issues.id,admission.binding.issueId),eq(issues.companyId,companyId)));
 const [role]=await db.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId,companyId),eq(agentReviewerPolicies.agentId,agentId)));
 if(admission.binding.companyId!==companyId||admission.binding.agentId!==agentId||admission.binding.runId!==runId
  ||!run||run.status!=="running"||run.runtimeMode!=="native"||run.nativeIssueId!==admission.binding.issueId||run.resultJson?.startupCancellation
  ||!issue||issue.executionRunId!==runId||issue.projectId!==admission.binding.projectId||!role?.enabled||role.revision!==admission.revision||!role.updatedByUserId||admission.binding.workspaceId!==executionWorkspaceId
  ||execution.binding.issueId!==admission.binding.issueId||execution.workspace.cwd!==admission.workspaceAccess.policy.workspaceDirectory)throw forbidden("Reviewer execution no longer matches its operator-owned admission");
 const assignment=await resolveNativeReviewerAssignment(db,{companyId,agentId,issueId:admission.binding.issueId,contextSnapshot:run.contextSnapshot,actingRunId:runId,issueExecutionRunId:issue.executionRunId, ...(options.allowResolvedReview ? { allowResolvedByRunId: runId } : {})});
 if(!assignment||!equal(assignment.record,admission.assignment))throw forbidden("Reviewer native assignment is no longer current");
 const snapshot=parseWorkspaceAccessSnapshot(supplied,reviewerWorkspaceBinding(admission.binding));
 if(!equal(snapshot,admission.workspaceAccess))throw forbidden("Reviewer policy must be the original protected run admission");
 // Native v5 encodes the isolated default by omitting homeMode; native v7
 // carries it explicitly. Require that actual native contract, not a test-only
 // v7 shape, while retaining protected admission/native-input provenance.
 const isolatedHome = "homeMode" in execution ? execution.homeMode === "isolated" : execution.schema === "paperclip.native-execution-input.v5";
 if(execution.provider.kind!=="codex"||execution.session.driverKind!=="codex_app_server"||!isolatedHome
  ||!("runtimeContext" in execution)||execution.runtimeContext.instructions.workingCopy)throw forbidden("Reviewer requires isolated local Codex with immutable instructions and no writable working copy");
 const storedExecution=parseNativeExecutionInput(saved.nativeExecutionInput);
 if(!equal(storedExecution,execution))throw forbidden("Reviewer execution differs from the controller-persisted native input");
 const asset=execution.runtimeContext.instructions.bundle,expected=reviewerAdmissionInstruction(admission).content;
 const file=join(asset.rootPath,REVIEWER_CONTEXT_PATH),stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16384||await fs.readFile(file,"utf8")!==expected)throw forbidden("Reviewer immutable context does not contain the exact server admission");
 const scratch=await fs.lstat(admission.workspaceAccess.policy.scratchDirectory!);
 if(!scratch.isDirectory()||scratch.isSymbolicLink()||String(scratch.dev)!==admission.scratchIdentity.device||String(scratch.ino)!==admission.scratchIdentity.inode||scratch.uid!==admission.scratchIdentity.owner||(scratch.mode&0o077)!==0)throw forbidden("Reviewer server scratch identity changed");
 resolveCodexWorkspaceAccessPolicy(snapshot.policy,[...referenceFolderProtectedPaths(),asset.rootPath]);
 return admission;
}

/** Call ONLY from the actual isolated local Codex transport onSpawn, AFTER the
 * existing native onSpawn has persisted process identity. A warm handoff must
 * retire first unless this exact run/snapshot is retained. No provider/model
 * tool has access to this function or protected runner-profile field. */
export async function recordNativeReviewerProcessAdmission(db:Db,input:{execution:NativeExecutionInput;workspaceAccess:WorkspaceAccessSnapshot;runnerInstanceId:string;process:{pid:number;processGroupId:number|null;startedAt:string}}){
 const admitted=await validateNativeReviewerExecution(db,input.execution,input.workspaceAccess);
 const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,admitted.binding.runId));
 if(!run?.nativeSessionId||run.runnerInstanceId!==input.runnerInstanceId||run.processPid!==input.process.pid||run.processGroupId!==input.process.processGroupId
  ||!run.processStartedAt||run.driverKind!=="codex_app_server")throw forbidden("Persist native controller process ownership before Reviewer qualification");
 const started=await readProcessStartedAt(input.process.pid);
 if(!started||new Date(started).toISOString()!==run.processStartedAt.toISOString())throw forbidden("Reviewer process identity changed");
 if(!("runtimeContext" in input.execution))throw forbidden("Reviewer context is unavailable");
 const receipt=reviewerRuntimeAdmissionSchema.parse({schema:"paperclip.reviewer-runtime-admission.v1",runId:run.id,runnerInstanceId:input.runnerInstanceId,nativeSessionId:run.nativeSessionId,
 admissionDigest:reviewerAdmissionDigest(admitted),executionDigest:digest(input.execution),contextDigest:input.execution.runtimeContext.aggregateDigest,policyDigest:admitted.workspaceAccess.digest,
 pid:run.processPid,processGroupId:run.processGroupId,processStartedAt:run.processStartedAt.toISOString()});
 // Conditional CAS prevents a late spawn callback qualifying a retired/rebound run.
 const updated=await db.update(heartbeatRuns).set({runnerProfileJson:sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({reviewerRuntimeAdmission:receipt})}::jsonb`}).where(and(eq(heartbeatRuns.id,run.id),eq(heartbeatRuns.status,"running"),eq(heartbeatRuns.runnerInstanceId,input.runnerInstanceId),eq(heartbeatRuns.nativeSessionId,run.nativeSessionId),eq(heartbeatRuns.processPid,receipt.pid),eq(heartbeatRuns.processStartedAt,run.processStartedAt))).returning({id:heartbeatRuns.id});
 if(updated.length!==1)throw forbidden("Reviewer controller ownership changed before process admission");
 return receipt;
}

/** Shared current-process proof for both closed PR tools and native review
 * resolution. No GitHub scope is needed to finish a native-only review. */
export async function assertNativeReviewerProcessAdmissionCurrent(db: Db, binding: { companyId: string; agentId: string; runId: string }, options: { allowResolvedReview?: boolean } = {}) {
 const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,binding.runId),eq(heartbeatRuns.companyId,binding.companyId),eq(heartbeatRuns.agentId,binding.agentId)));
 if(!run||run.status!=="running")throw forbidden("Reviewer controller run is unavailable");
 const saved=profile(run.runnerProfileJson),admitted=parseReviewerWorkspaceAdmission(saved.reviewerPolicy),execution=parseNativeExecutionInput(saved.nativeExecutionInput);
 await validateNativeReviewerExecution(db,execution,admitted.workspaceAccess, options);
 const receipt=reviewerRuntimeAdmissionSchema.parse(saved.reviewerRuntimeAdmission);
 if(!("runtimeContext" in execution)||receipt.runId!==run.id||receipt.runnerInstanceId!==run.runnerInstanceId||receipt.nativeSessionId!==run.nativeSessionId
  ||receipt.admissionDigest!==reviewerAdmissionDigest(admitted)||receipt.executionDigest!==digest(execution)||receipt.contextDigest!==execution.runtimeContext.aggregateDigest||receipt.policyDigest!==admitted.workspaceAccess.digest
  ||receipt.pid!==run.processPid||receipt.processGroupId!==run.processGroupId||receipt.processStartedAt!==run.processStartedAt?.toISOString())throw forbidden("Reviewer process/context qualification is missing or stale");
 const currentStart=await readProcessStartedAt(receipt.pid);
 if(!currentStart||new Date(currentStart).toISOString()!==receipt.processStartedAt)throw forbidden("Reviewer process is no longer the admitted controller child");
 return {run,admitted,execution};
}
export function nativeReviewerRuntimeQualification(db:Db):NativeReviewerAuthorizationOptions["assertRuntimeQualified"]{
 return async({agent,run,issue,scope})=>{
  const {admitted}=await assertNativeReviewerProcessAdmissionCurrent(db,{companyId:run.companyId,agentId:run.agentId,runId:run.id});
  if(agent.id!==admitted.binding.agentId||issue.id!==admitted.binding.issueId||scope.roleRevision!==admitted.revision||scope.assignment.kind!==admitted.assignment.kind||scope.assignment.id!==nativeReviewerAssignmentId(admitted.assignment)||scope.assignment.sourceDecisionId!==admitted.assignment.sourceDecisionId)throw forbidden("Reviewer discussion is outside the admitted task and review");
 };
}
