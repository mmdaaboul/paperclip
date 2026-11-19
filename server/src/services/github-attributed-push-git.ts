import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { GitPushRequest, GitPushTransport } from "./github-attributed-push.js";

export interface AttributedGitCommand {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
export interface AttributedGitCommandResult { code: number | null; stdout: string; stderr: string }
export type AttributedGitCommandRunner = (input: AttributedGitCommand) => Promise<AttributedGitCommandResult>;

const runGit: AttributedGitCommandRunner = input => new Promise(resolve => {
  execFile(input.binary, input.args, { cwd: input.cwd, env: input.env, encoding: "utf8", timeout: input.timeoutMs,
    maxBuffer: 1024 * 1024, killSignal: "SIGTERM" }, (error, stdout, stderr) => resolve({
      code: error ? typeof error.code === "number" ? error.code : null : 0, stdout, stderr,
    }));
});

/** Only direct canonical GitHub HTTPS destinations, not model-supplied URLs. */
export function assertGitHubPushRemote(remote: string, repositoryFullName: string): void {
  let url: URL;
  try { url = new URL(remote); } catch { throw new Error("Unsupported attributed Git remote"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash
    || ![`/${repositoryFullName}`, `/${repositoryFullName}.git`].includes(url.pathname)) throw new Error("Unsupported attributed Git remote");
}

/** Single-ref receive-pack acknowledgement, never an agent-provided success claim. */
export function parseAttributedPushStatus(output: string, code: number | null, request: GitPushRequest): Awaited<ReturnType<GitPushTransport["push"]>> {
  if (code === null) return { kind: "unknown" };
  const statuses = output.split(/\r?\n/).filter(line => /^[ *+=!\-]\t/.test(line));
  if (statuses.length !== 1) return { kind: "unknown" };
  const [flag, mapping] = statuses[0].split("\t");
  const colon = mapping?.lastIndexOf(":") ?? -1;
  if (colon < 0 || mapping.slice(0, colon) !== request.newOid || mapping.slice(colon + 1) !== request.ref) return { kind: "unknown" };
  if (flag === "!") return { kind: "rejected" };
  if (code !== 0) return { kind: "unknown" };
  if (flag === "=") return { kind: "no_change" };
  if (flag === " " || flag === "*") return { kind: "accepted", ref: request.ref, oid: request.newOid };
  // Deletion, forced-update and unexpected output are unsupported, not success.
  return { kind: "unknown" };
}

/** The controller owns workspace, remote and native credential environment.
 * This local adapter is not qualified for a remote/sandbox execution target.
 */
export function createAttributedGitPushTransport(input: {
  cwd: string;
  repositoryFullName: string;
  remoteUrl: string;
  /** Existing native buildGitAuthInvocation output; no second token resolver. */
  credentialEnvironment: Record<string, string>;
  gitBinary?: string;
}, runner: AttributedGitCommandRunner = runGit): GitPushTransport {
  assertGitHubPushRemote(input.remoteUrl, input.repositoryFullName);
  const binary = input.gitBinary ?? "/usr/bin/git";
  if (!isAbsolute(input.cwd) || !isAbsolute(binary)) throw new Error("Attributed push requires controller-owned absolute paths");
  const native: Record<string, string> = {};
  const count = input.credentialEnvironment.GIT_CONFIG_COUNT;
  if (count !== undefined && (!/^\d+$/.test(count) || Number(count) > 32)) throw new Error("Invalid native Git config projection");
  for (const [key, value] of Object.entries(input.credentialEnvironment)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT)$/.test(key)) native[key] = value;
    const config = /^GIT_CONFIG_(KEY|VALUE)_(\d+)$/.exec(key);
    if (config && count !== undefined && Number(config[2]) < Number(count)) native[key] = value;
  }
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C", ...native,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const prefix = ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never",
    "-c", "push.followTags=false", "-c", "push.recurseSubmodules=no", "-c", "push.gpgSign=false",
    "-c", "http.sslVerify=true", "-c", "http.followRedirects=false", "-c", "http.proxy="];
  const run = (args: string[]) => runner({ binary, args: [...prefix, ...args], cwd: input.cwd, env, timeoutMs: 60_000 });
  let checked = false;
  const checkConfig = async () => {
    if (checked) return;
    const result = await run(["config", "--local", "--no-includes", "--get-regexp", "^(url\\.|include\\.|includeif\\.|http\\.|https\\.|credential\\.|protocol\\.|core\\.(gitproxy|sshcommand|fsmonitor))"]);
    if (result.code !== 1 || result.stdout.length !== 0) throw new Error("Recorded push cannot use repository transport, credential or executable overrides");
    checked = true;
  };
  return {
    async verifyCandidate(oid) {
      await checkConfig();
      return (await run(["cat-file", "-e", `${oid}^{commit}`])).code === 0;
    },
    async readRemoteRef(ref) {
      await checkConfig();
      const result = await run(["ls-remote", "--refs", "--exit-code", input.remoteUrl, ref]);
      if (result.code === 2 && !result.stdout.trim()) return null;
      if (result.code !== 0) throw new Error("Remote reference is unavailable");
      const lines = result.stdout.trim().split("\n");
      if (lines.length !== 1) throw new Error("Remote reference is ambiguous");
      const [oid, found] = lines[0].split(/\s+/);
      if (found !== ref || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) throw new Error("Remote reference is invalid");
      return oid;
    },
    async isAncestor(oldOid, newOid) { return (await run(["merge-base", "--is-ancestor", oldOid, newOid])).code === 0; },
    async push(request) {
      checked = false;
      await checkConfig();
      // Lease is an exact CAS; preflight ancestry separately forbids a rewrite.
      const result = await run(["push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no",
        `--force-with-lease=${request.ref}:${request.expectedOldOid ?? ""}`, input.remoteUrl, `${request.newOid}:${request.ref}`]);
      return parseAttributedPushStatus(result.stdout, result.code, request);
    },
  };
}
