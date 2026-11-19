import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, runnerProviderLaunchRequirements,
  validatePreparedRunnerLaunch, type RunnerProviderLaunchEnvironment, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";

const roots: string[] = [];
function fixture() {
  const parent = resolve(".test-artifacts/reference-launch"); mkdirSync(parent, { recursive: true });
  const root = realpathSync(mkdtempSync(join(parent, "case-"))); roots.push(root);
  const directory = (name: string) => { const value = join(root, name); mkdirSync(value); return value; };
  const workspaceDirectory = directory("candidate"), reference = directory("reference"), home = directory("home"), codexHome = directory("codex");
  writeFileSync(join(reference, "retained.txt"), "reference-original\n");
  const policy = { workspaceDirectory, referenceDirectories: [reference], readOnlyWorkspace: false };
  const requirements: RunnerProviderLaunchRequirements = {
    schema: "paperclip.runner.launch-requirements.v1", identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
      normalizedSessionId: "session", turnId: "turn", itemId: "item" },
    provider: "codex", model: "selected", approvalPolicy: "never", readOnly: false, preparedConversation: false,
    includeCollaborationModeInstructions: false, settings: {}, instructions: "Assigned task", runtimeContext: null, workspaceAccess: policy,
  };
  const environment = { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: codexHome };
  const input: RunnerProviderLaunchEnvironment = { options: { environment }, root: directory("state"), cwd: workspaceDirectory,
    codexHome, codexCommand: "/opt/homebrew/bin/codex", providerNodeCommand: "/runtime/node", opencodeProxyPath: "", acpxSidecarPath: "" };
  const launch = () => createRunnerProviderLaunch(requirements, input);
  const prepared = (provider = launch()) => ({ configurationId: "fixture", requirementsDigest: runnerLaunchRequirementsDigest(requirements), provider });
  return { root, workspaceDirectory, reference, policy, requirements, input, environment, launch, prepared };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("controller reference grants through actual native launch ownership", () => {
  it("includes policy in strict launch requirements without mutating its source", () => {
    const f = fixture(); const identity = f.requirements.identity;
    const value = runnerProviderLaunchRequirements({ workspaceAccess: f.policy }, identity, {}, null, "assigned");
    expect(value.workspaceAccess).toEqual(f.policy);
    f.policy.referenceDirectories.push("/later-change");
    expect(value.workspaceAccess?.referenceDirectories).toEqual([f.reference]);
    expect(runnerLaunchRequirementsDigest(value)).not.toBe(runnerLaunchRequirementsDigest({ ...value, workspaceAccess: undefined }));
  });
  it("builds and validates real scoped native arguments", () => {
    const f = fixture(); const prepared = f.prepared();
    expect(() => validatePreparedRunnerLaunch(f.requirements, prepared, f.input)).not.toThrow();
    expect((prepared.provider.args as string[]).join("\n")).toContain(`${JSON.stringify(f.reference)}="read"`);
    expect(prepared.provider).toMatchObject({ cwd: f.workspaceDirectory, collaborationMode: "default" });
  });
  it("does not treat a public descriptor/digest as a trusted host permission derivation",()=>{
    const f=fixture();expect(()=>validatePreparedRunnerLaunch(f.requirements,f.prepared())).toThrow("prepared_environment_unqualified");
  });
  it.each(["custom-args", "external", "preconfigured", "provider", "cwd"])("refuses a scoped %s fallback", kind => {
    const f = fixture();
    const options = { ...f.input.options, ...(kind === "custom-args" ? { codexArgs: ["app-server"] } : {}),
      ...(kind === "external" ? { externallySandboxed: true } : {}), ...(kind === "preconfigured" ? { homeMode: "preconfigured" as const } : {}) };
    expect(() => createRunnerProviderLaunch({ ...f.requirements, ...(kind === "provider" ? { provider: "opencode" as const } : {}) },
      { ...f.input, options, ...(kind === "cwd" ? { cwd: f.root } : {}) })).toThrow("runner_workspace_access_launch_unsupported");
  });
  it.each(["writable-reference", "extra-profile", "bypass-flag", "changed-cwd"])("refuses %s in a recovered prepared descriptor", kind => {
    const f = fixture(), prepared = f.prepared();
    let args = prepared.provider.args as string[];
    if (kind === "writable-reference") args = args.map(arg => arg.replace(`${JSON.stringify(f.reference)}="read"`, `${JSON.stringify(f.reference)}="write"`));
    if (kind === "extra-profile") args = ["-c", 'permissions.extra.filesystem={":root"="write"}', ...args];
    if (kind === "bypass-flag") args = ["--dangerously-bypass-approvals-and-sandbox", ...args];
    prepared.provider.args = args;
    if (kind === "changed-cwd") prepared.provider.cwd = f.root;
    expect(() => validatePreparedRunnerLaunch(f.requirements, prepared, f.input)).toThrow();
  });
  it.each(["extra-write", "root-write", "root-read", "home-read", "credential-deny-removed", "tmpdir", "tmpdir-contained-alias", "secret-set", "secret-inherit"])("refuses Reviewer descriptor expansion: %s", kind => {
    const f = fixture(); const scratch = join(f.root, "scratch"); mkdirSync(scratch);
    f.requirements.workspaceAccess = { ...f.policy, readOnlyWorkspace: true, scratchDirectory: scratch };
    f.input.options.environment = { ...f.environment, TMPDIR: scratch };
    if (kind === "tmpdir-contained-alias") symlinkSync(f.root, join(scratch, "escape"));
    const prepared = f.prepared(); expect(() => validatePreparedRunnerLaunch(f.requirements, prepared, f.input)).not.toThrow();
    prepared.provider.args = (prepared.provider.args as string[]).map(arg => {
      if (kind === "extra-write" && arg.startsWith("permissions.paperclip-runner-workspace-only.filesystem=")) return arg.slice(0, -1) + ',"/unrelated-host-root"="write"}';
      if (kind === "root-read" && arg.startsWith("permissions.paperclip-runner-workspace-only.filesystem=")) return arg.slice(0,-1) + ',"/"="read"}';
      if (kind === "home-read" && arg.startsWith("permissions.paperclip-runner-workspace-only.filesystem=")) return arg.slice(0,-1) + ',"/home"="read"}';
      if (kind === "credential-deny-removed" && arg.startsWith("permissions.paperclip-runner-workspace-only.filesystem=")) return arg.replace(`${JSON.stringify(f.input.codexHome)}="none"`,`${JSON.stringify(f.input.codexHome)}="read"`);
      if (kind === "root-write") return arg.replace('\":root\"=\"none\"', '\":root\"=\"write\"');
      if (kind === "tmpdir" && arg.startsWith("shell_environment_policy.set=")) return arg.replace(JSON.stringify(scratch), '\"/tmp\"');
      if (kind === "tmpdir-contained-alias" && arg.startsWith("shell_environment_policy.set=")) return arg.replace(JSON.stringify(scratch), JSON.stringify(join(scratch, "escape")));
      if (kind === "secret-set" && arg.startsWith("shell_environment_policy.set=")) return arg.slice(0, -1) + ',GH_TOKEN="canary"}';
      if (kind === "secret-inherit" && arg === 'shell_environment_policy.inherit="none"') return 'shell_environment_policy.inherit="all"';
      return arg;
    });
    expect(() => validatePreparedRunnerLaunch(f.requirements, prepared, f.input)).toThrow("runner_prepared_launch_workspace_access_mismatch");
  });
  it.runIf(process.platform === "darwin")("enforces read-only reference access using the actual launch arguments in native macOS Codex sandbox", () => {
    const f = fixture(), prepared = f.prepared(); validatePreparedRunnerLaunch(f.requirements, prepared, f.input);
    const args = (prepared.provider.args as string[]).filter(arg => arg !== "app-server");
    const run = (command: string) => spawnSync(process.env.PAPERCLIP_TEST_CODEX_BINARY ?? "/opt/homebrew/bin/codex",
      ["sandbox", ...args, "-P", "paperclip-runner-workspace-only", "-C", f.workspaceDirectory, "--", "/bin/sh", "-c", command,
        "reference-test", join(f.reference, "retained.txt"), join(f.workspaceDirectory, "allowed.txt")],
      { encoding: "utf8", timeout: 15_000, env: { ...f.environment, LANG: "C" } });
    const allowed = run('cat "$1"; printf allowed > "$2"');
    expect({ status: allowed.status, stderr: allowed.stderr, error: allowed.error?.message }).toEqual({ status: 0, stderr: "", error: undefined });
    expect(allowed.stdout).toBe("reference-original\n");
    expect(readFileSync(join(f.workspaceDirectory, "allowed.txt"), "utf8")).toBe("allowed");
    expect(run('printf changed > "$1"').status).not.toBe(0);
    expect(readFileSync(join(f.reference, "retained.txt"), "utf8")).toBe("reference-original\n");
  });
});
