import { and, eq } from "drizzle-orm";
import { agents, projects, type Db } from "@paperclipai/db";
import { agentReviewerScopeSchema, type AgentReviewerScope } from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { resolveManagedGitHubCredential } from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { ghFetch } from "./github-fetch.js";
import { githubBotRequest } from "./chat-github-client.js";

export const resolveReviewerRepositorySchema = agentReviewerScopeSchema.pick({ projectId: true, repository: true }).strict();

/** Operator configuration uses the existing native selected identity privately.
 * No supplied provider ID, raw token, company-secret or host fallback is used.
 */
export async function resolveReviewerRepositoryScope(db: Db, input: {
  actor: AuthorizationActor; companyId: string; agentId: string;
  selection: { projectId: string; repository: string };
}, ports?: { fetchImpl?: typeof fetch; resolveCredential?: typeof resolveManagedGitHubCredential }): Promise<AgentReviewerScope> {
  if (input.actor.type !== "board") throw forbidden("Only an authorized operator may select Reviewer repositories");
  const selection = resolveReviewerRepositorySchema.parse(input.selection);
  if (selection.repository.split("/").some(segment => segment === "." || segment === "..")) {
    throw unprocessable("Choose a canonical GitHub owner/repository");
  }
  const access = authorizationService(db);
  for (const request of [
    { action: "agent_config:update" as const, resource: { type: "agent" as const, companyId: input.companyId, agentId: input.agentId } },
    { action: "project:read" as const, resource: { type: "project" as const, companyId: input.companyId, projectId: selection.projectId } },
  ]) {
    const decision = await access.decide({ actor: input.actor, ...request });
    if (!decision.allowed) throw forbidden("The agent or selected project is outside your configuration access");
  }
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, selection.projectId), eq(projects.companyId, input.companyId)));
  if (!agent || !project) throw notFound("Agent or selected project not found");
  const resolved = await (ports?.resolveCredential ?? resolveManagedGitHubCredential)(db, secretService(db), input.companyId, {
    agentId: input.agentId, responsibleUserId: input.actor.userId?.trim() || null, allowStandingDelegation: false,
  });
  if (!resolved.configured || !resolved.credential) throw unprocessable("Select an available native managed GitHub identity for this agent before choosing a repository");
  const [owner, name] = selection.repository.split("/");
  const metadata = await githubBotRequest<{ id?: unknown; full_name?: unknown }>(ports?.fetchImpl ?? ((url, init) => ghFetch(String(url), init)),
    resolved.credential.token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  const id = typeof metadata.id === "number" && Number.isSafeInteger(metadata.id) && metadata.id > 0
    ? String(metadata.id) : typeof metadata.id === "string" ? metadata.id : "";
  if (typeof metadata.full_name !== "string" || metadata.full_name.toLowerCase() !== selection.repository.toLowerCase()) {
    throw unprocessable("The repository identity changed; reload the selected repository");
  }
  const parsed = agentReviewerScopeSchema.safeParse({ projectId: selection.projectId, repository: metadata.full_name.toLowerCase(), repositoryId: id });
  if (!parsed.success) throw unprocessable("GitHub did not return a supported exact repository identity");
  return parsed.data;
}

/** Parse the trusted native workspace repository; no push producer dependency. */
export function reviewerWorkspaceRepository(url: string): { fullName: string; httpsUrl: string } {
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  let name = scp?.[1];
  if (!name) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw forbidden("The admitted repository URL is unsupported for Reviewer discussion"); }
    const allowed = parsed.protocol === "https:" && !parsed.username || parsed.protocol === "ssh:" && parsed.username === "git";
    if (!allowed || parsed.hostname !== "github.com" || parsed.password || parsed.port || parsed.hash || parsed.search) throw forbidden("The admitted repository URL is unsupported for Reviewer discussion");
    name = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) || name.split("/").some(part => part === "." || part === "..")) {
    throw forbidden("The admitted repository identity is unavailable");
  }
  return { fullName: name, httpsUrl: `https://github.com/${name}.git` };
}
