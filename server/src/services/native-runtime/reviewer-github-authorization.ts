import { authorizationService } from "../authorization.js";
import { and, eq } from "drizzle-orm";
import { agents, companies, agentReviewerPolicies, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { agentReviewerScopeSchema } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { resolveNativeReviewerAssignment, nativeReviewerAssignmentId } from "./reviewer-native-assignment.js";
import { resolveCoreTrustPreset } from "../trust-preset-resolver.js";
import { reviewerExecutionRestrictsCredentials } from "../reviewer-role.js";
import type { ReviewerGitHubAuthorization, ReviewerGitHubBinding } from "../reviewer-github-actions.js";

type Assignment = ReviewerGitHubAuthorization["assignment"];
type Agent = typeof agents.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type Issue = typeof issues.$inferSelect;

export interface NativeReviewerGitHubScope {
  schema: "paperclip.reviewer-github-scope.v1";
  binding: ReviewerGitHubBinding;
  roleRevision: number;
  assignment: { kind: Assignment["kind"]; id: string; sourceDecisionId: string };
  repositoryId: string;
  repository: string;
  pullNumber: number;
  headSha: string;
}

function readScope(value: unknown, binding: ReviewerGitHubBinding): NativeReviewerGitHubScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw forbidden("This run has no admitted Reviewer PR scope");
  const scope = value as NativeReviewerGitHubScope;
  const allowed = ["schema", "binding", "roleRevision", "assignment", "repositoryId", "repository", "pullNumber", "headSha"];
  if (Object.keys(scope).some(key => !allowed.includes(key)) || scope.schema !== "paperclip.reviewer-github-scope.v1"
    || !scope.binding || (["companyId", "agentId", "runId", "issueId", "projectId"] as const).some(key => scope.binding[key] !== binding[key])
    || !Number.isSafeInteger(scope.roleRevision) || scope.roleRevision < 1 || !scope.assignment
    || !["native_completion_review", "scoped_review", "execution_stage_review"].includes(scope.assignment.kind)) throw forbidden("Reviewer run scope is invalid");
  return scope;
}

export interface NativeReviewerAuthorizationOptions {
  /** Actual workspace/driver owner must verify the isolated read-only candidate,
   * disjoint scratch and this run's immutable native policy before enabling.
   */
  assertRuntimeQualified: (facts: { agent: Agent; run: Run; issue: Issue; scope: NativeReviewerGitHubScope }) => Promise<void>;

}

export function nativeReviewerGitHubAuthorization(db: Db, options: NativeReviewerAuthorizationOptions) {
  return async (binding: ReviewerGitHubBinding): Promise<ReviewerGitHubAuthorization> => {
    const [policy] = await db.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId, binding.companyId), eq(agentReviewerPolicies.agentId, binding.agentId)));
    if (!policy?.enabled || !policy.updatedByUserId) throw forbidden("The operator has not enabled this Reviewer role");
    const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, binding.companyId), eq(agents.id, binding.agentId)));
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.id, binding.runId)));
    const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, binding.companyId), eq(issues.id, binding.issueId), eq(issues.projectId, binding.projectId)));
    const [project] = await db.select().from(projects).where(and(eq(projects.companyId, binding.companyId), eq(projects.id, binding.projectId)));
    if (!agent || !run || !issue || !project || run.status !== "running" || run.nativeIssueId !== binding.issueId) throw forbidden("Reviewer task/run is no longer active");
    const [company] = await db.select().from(companies).where(eq(companies.id, binding.companyId));
    if (company?.status !== "active" || (company.budgetMonthlyCents > 0 && company.spentMonthlyCents >= company.budgetMonthlyCents)
      || (agent.budgetMonthlyCents > 0 && agent.spentMonthlyCents >= agent.budgetMonthlyCents) || run.runtimeMode !== "native") throw forbidden("Reviewer company or runtime is unavailable");
    const actor = { type: "agent" as const, ...binding, source: "agent_jwt" as const, onBehalfOfUserId: run.responsibleUserId };
    const native = authorizationService(db);
    const visible = await native.decide({ actor, action: "issue:read", resource: { type: "issue", companyId: binding.companyId, issueId: binding.issueId } });
    const readableProject = await native.decide({ actor, action: "project:read", resource: { type: "project", companyId: binding.companyId, projectId: binding.projectId } });
    if (!visible.allowed || !readableProject.allowed) throw forbidden("Reviewer task or project is outside native authorization");
    const scope = readScope(run.runnerProfileJson?.reviewerGitHubScope, binding);
    const scopes = policy.scopes.map(value => agentReviewerScopeSchema.parse(value));
    if (scope.roleRevision !== policy.revision || !scopes.some(value => value.projectId === binding.projectId
      && value.repositoryId === scope.repositoryId && value.repository.toLowerCase() === scope.repository.toLowerCase())) throw forbidden("Reviewer policy or repository scope changed");
    const assignedNative = await resolveNativeReviewerAssignment(db, { ...binding, contextSnapshot: run.contextSnapshot,
      actingRunId: run.id, issueExecutionRunId: issue.executionRunId });
    const assignment: Assignment | null = assignedNative && nativeReviewerAssignmentId(assignedNative.record) === scope.assignment.id
      && assignedNative.record.kind === scope.assignment.kind && assignedNative.sourceDecision.id === scope.assignment.sourceDecisionId
      ? { id: scope.assignment.id, current: true, kind: assignedNative.record.kind, reviewerAgentId: agent.id, builderAgentId: assignedNative.sourceRun.agentId } : null;
    if (!assignment) throw forbidden("The current native review assignment is unavailable");
    await options.assertRuntimeQualified({ agent, run, issue, scope });
    const trust = resolveCoreTrustPreset({ companyId: binding.companyId, agent, issue, project,
      run: { companyId: run.companyId, executionPolicy: run.contextSnapshot?.executionPolicy } });
    if (trust.kind !== "standard" || !await reviewerExecutionRestrictsCredentials(db, { ...binding, runnerProfileJson: run.runnerProfileJson })) {
      throw forbidden("Reviewer runtime policy is not qualified for scoped discussion");
    }
    return { binding: { ...binding }, agentName: agent.name,
      role: { enabled: true, configuredBy: "board", revision: String(policy.revision), projectIds: scopes.map(value => value.projectId), repositoryIds: scopes.map(value => value.repositoryId) },
      assignment, runtime: { filesystemQualified: true, rawCredentialExportDenied: true, hostCredentialFallbackDenied: true, trustKind: "standard" },
      repositoryId: scope.repositoryId, repository: scope.repository, pullNumber: scope.pullNumber, headSha: scope.headSha };
  };
}

