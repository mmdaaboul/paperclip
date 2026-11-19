import { NativeProviderStateIncompatibleError } from "../vendor/paperclip-runner/index.js";
import { and, eq, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";

export const NATIVE_CONTROLLER_GITHUB_MODE = "native_controller";
type Binding = { companyId: string; agentId: string; runId: string };
const object = (x: unknown): Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
export function controllerGitConfigured(config: unknown) { const mode=object(config).githubWriteMode; if(mode!==undefined&&mode!=="native"&&mode!==NATIVE_CONTROLLER_GITHUB_MODE)throw new NativeProviderStateIncompatibleError("native_github_write_mode_incompatible"); return mode === NATIVE_CONTROLLER_GITHUB_MODE; }
function retainedMode(profile: unknown, binding: Binding) {
  if(!Object.hasOwn(object(profile),"nativeGithubWriteAdmission"))return false;
  const value = object(object(profile).nativeGithubWriteAdmission);
  if (value.schema !== "paperclip.native-github-write-admission.v1" || (typeof value.mode!=="string"||!["native", NATIVE_CONTROLLER_GITHUB_MODE].includes(value.mode))
    || Object.keys(value).some(k => !["schema", "mode", "companyId", "agentId", "runId"].includes(k))
    || value.companyId !== binding.companyId || value.agentId !== binding.agentId || value.runId !== binding.runId) throw new NativeProviderStateIncompatibleError("native_github_write_admission_incompatible");
  return value.mode === NATIVE_CONTROLLER_GITHUB_MODE;
}

/** Current selection denies exports immediately; a retained marker remains
 * restrictive after disable. Neither is a credential or successful action. */
export async function nativeControllerGitState(db: Pick<Db,"select">, binding: Binding) {
  const [agent] = await db.select({ config:sql<Record<string,unknown>>`case when ${agents.adapterConfig} ? 'githubWriteMode' then jsonb_build_object('githubWriteMode',${agents.adapterConfig}->'githubWriteMode') else '{}'::jsonb end` }).from(agents).where(and(eq(agents.id,binding.agentId),eq(agents.companyId,binding.companyId)));
  const [run] = await db.select({ profile:sql<Record<string,unknown>>`case when ${heartbeatRuns.runnerProfileJson} ? 'nativeGithubWriteAdmission' then jsonb_build_object('nativeGithubWriteAdmission',${heartbeatRuns.runnerProfileJson}->'nativeGithubWriteAdmission') else '{}'::jsonb end`, status: heartbeatRuns.status, mode: heartbeatRuns.runtimeMode,
    cancellation: sql<unknown>`${heartbeatRuns.resultJson}->'startupCancellation'` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id,binding.runId),eq(heartbeatRuns.agentId,binding.agentId),eq(heartbeatRuns.companyId,binding.companyId)));
  if (!agent || !run) throw forbidden("GitHub run binding unavailable");
  const selected = controllerGitConfigured(agent.config), retained = retainedMode(run.profile,binding);
  return { restrictExport: selected || retained, admitted: selected && retained && run.status === "running" && run.mode === "native" && !run.cancellation };
}

/** First admission only. Recovery never upgrades an older run by reinterpretation.
 * Uses the existing persisted run profile, not an environment switch. */
export async function prepareNativeControllerGitAdmission(db: Db, binding: Binding, supported: boolean) {
  return db.transaction(async tx => {
    const [agent] = await tx.select({ config: agents.adapterConfig }).from(agents)
      .where(and(eq(agents.id,binding.agentId),eq(agents.companyId,binding.companyId))).for("share");
    const [run] = await tx.select({ profile: heartbeatRuns.runnerProfileJson, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id,binding.runId),eq(heartbeatRuns.agentId,binding.agentId),eq(heartbeatRuns.companyId,binding.companyId))).for("update");
    if (!agent || !run || run.status !== "running") throw forbidden("GitHub admission requires current running agent");
    if (object(run.profile).nativeGithubWriteAdmission !== undefined) { retainedMode(run.profile,binding); if(controllerGitConfigured(agent.config) && !supported)throw new NativeProviderStateIncompatibleError("native_github_write_runtime_unsupported");return object(run.profile).nativeGithubWriteAdmission; }
    if (object(run.profile).nativeExecutionInput !== undefined) {
      if (controllerGitConfigured(agent.config)) throw new NativeProviderStateIncompatibleError("native_github_write_new_run_required");
      return;
    }
    const selected = controllerGitConfigured(agent.config);
    if(!selected)return;
    if (selected && !supported) throw new NativeProviderStateIncompatibleError("native_github_write_runtime_unsupported");
    const marker = { schema: "paperclip.native-github-write-admission.v1", mode: selected ? NATIVE_CONTROLLER_GITHUB_MODE : "native", companyId:binding.companyId,agentId:binding.agentId,runId:binding.runId };
    await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({nativeGithubWriteAdmission:marker})}::jsonb` }).where(eq(heartbeatRuns.id,binding.runId));
    return marker;
  });
}

/** Generic GitHub connector credential acquisition has no recorded-write owner.
 * Deny before grant/secret resolution; other providers remain unaffected. */
export async function assertNoControllerGitGateway(db: Pick<Db,"select">, session: { companyId:string; agentId?:string|null; runId?:string|null }) {
  if (!session.agentId || !session.runId) return;
  if ((await nativeControllerGitState(db,{companyId:session.companyId,agentId:session.agentId,runId:session.runId})).restrictExport)
    throw forbidden("Use this run's recorded GitHub actions; generic GitHub connector credentials are unavailable");
}

/** Even absent a managed connection, configured/inherited host tokens or SSH
 * access must not bypass recorded mode. Native isolated home/policy remains. */
export function controllerGitProviderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
 const env={...source};
 for(const key of Object.keys(env))if(/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*|GIT_CONFIG_.*|PAPERCLIP_GITHUB_HOST_HOME)$/.test(key))env[key]="";
 return {...env,PAPERCLIP_GITHUB_AUTH_MODE:"managed",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",GH_CONFIG_DIR:""};
}
