import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { applyGitAgentIdentity, createGitAgentAttribution, type GitAgentAttribution } from "./github-agent-attribution.js";
import { githubLauncherSource } from "./github-launcher.js";

const agentA = "10000000-0000-0000-0000-000000000001";
const agentB = "10000000-0000-0000-0000-000000000002";
const runA = "10000000-0000-0000-0000-000000000003";
const runB = "10000000-0000-0000-0000-000000000004";
const issue = "10000000-0000-0000-0000-000000000005";
const roots: string[] = [];
const servers: Server[] = [];
const baseEnv = { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, args: string[]) => execFileSync("/usr/bin/git", ["-C", cwd, ...args], { env: baseEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(attribution: GitAgentAttribution | undefined) {
  const root = mkdtempSync(join(process.cwd(), ".git-attribution-test-")); roots.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"commonjs"}\n');
  const repo = join(root, "repo"); mkdirSync(repo); git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Native account"]); git(repo, ["config", "user.email", "123+shared@users.noreply.github.com"]);
  const wrapper = join(root, "git"); writeFileSync(wrapper, githubLauncherSource());
  const config = join(root, "config"); mkdirSync(config);
  let selected = attribution;
  const server = createServer((req, res) => {
    expect(req.url).toBe("/runtime-tools/github/credentials");
    expect(req.headers.authorization).toBe("Bearer test-session-capability");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "available", env: selected
      ? applyGitAgentIdentity({ GH_TOKEN: "test-not-a-real-token", GIT_AUTHOR_EMAIL: "123+shared@users.noreply.github.com", GIT_COMMITTER_EMAIL: "123+shared@users.noreply.github.com" }, selected)
      : {}, ...(selected ? { attribution: selected } : {}) }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture not listening");
  const call = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], { cwd: repo, env: { ...baseEnv, GH_CONFIG_DIR: config,
      PAPERCLIP_GITHUB_BROKER_URL: `http://127.0.0.1:${address.port}`, PAPERCLIP_GITHUB_BROKER_TOKEN: "test-session-capability",
      PAPERCLIP_COMMIT_ATTRIBUTION: "forged model label", GIT_AUTHOR_NAME: "forged inherited name" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); }); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr }));
  });
  return { root, repo, call, setAttribution(value: GitAgentAttribution) { selected = value; } };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("server-owned non-secret Git creator attribution", () => {
  it("preserves native verified email/credential fields while distinguishing agents", () => {
    const native = { GIT_AUTHOR_EMAIL: "123+shared@users.noreply.github.com", GIT_COMMITTER_EMAIL: "123+shared@users.noreply.github.com", GH_TOKEN: "test-not-a-real-token" };
    const a = applyGitAgentIdentity(native, createGitAgentAttribution({ agentId: agentA, runId: runA, issueId: issue, nameAtTime: "Builder A" }));
    const b = applyGitAgentIdentity(native, createGitAgentAttribution({ agentId: agentB, runId: runB, issueId: issue, nameAtTime: "Builder B" }));
    expect(a.GIT_AUTHOR_NAME).toContain("Builder A"); expect(a.GIT_AUTHOR_NAME).toContain(agentA); expect(a.GIT_AUTHOR_NAME).toContain(runA); expect(a.GIT_AUTHOR_NAME).toContain(issue);
    expect(b.GIT_AUTHOR_NAME).not.toBe(a.GIT_AUTHOR_NAME);
    expect(a.GIT_AUTHOR_EMAIL).toBe(native.GIT_AUTHOR_EMAIL); expect(a.GH_TOKEN).toBe(native.GH_TOKEN); expect(native).not.toHaveProperty("GIT_AUTHOR_NAME");
  });
  it("sanitizes display-name control/identity delimiters and validates stable IDs", () => {
    const a = createGitAgentAttribution({ agentId: agentA, runId: runA, issueId: null, nameAtTime: "Builder\n<fake>\u0000Name" });
    expect(a.nameAtTime).toBe("Builder fake Name"); expect(Object.isFrozen(a)).toBe(true);
    expect(() => createGitAgentAttribution({ agentId: "caller-selected-name", runId: runA, issueId: null, nameAtTime: "A" })).toThrow("server-bound");
  });
  it("actual native launcher adds visible labels to an ordinary local commit", async () => {
    const a = createGitAgentAttribution({ agentId: agentA, runId: runA, issueId: issue, nameAtTime: "Builder A" });
    const f = await fixture(a); const result = await f.call(["commit", "--allow-empty", "-m", "Implement feature"]);
    expect(result.code, result.stderr).toBe(0);
    const details = git(f.repo, ["show", "-s", "--format=%an%n%ae%n%B", "HEAD"]);
    expect(details).toContain(`Builder A [Paperclip agent:${agentA}`); expect(details).toContain("123+shared@users.noreply.github.com");
    expect(details).toContain(`Paperclip-Agent: Builder A (${agentA})`); expect(details).toContain(`Paperclip-Run: ${runA}`); expect(details).toContain(`Paperclip-Task: ${issue}`);
    expect(details + result.stdout + result.stderr).not.toContain("test-not-a-real-token"); expect(details).not.toContain("forged");
  });
  it("handles a global working-directory argument and preserves old creator after rename", async () => {
    const f = await fixture(createGitAgentAttribution({ agentId: agentA, runId: runA, issueId: issue, nameAtTime: "Builder A" }));
    expect((await f.call(["-C", f.repo, "commit", "--allow-empty", "-m", "First"])).code).toBe(0);
    const first = git(f.repo, ["rev-parse", "HEAD"]);
    f.setAttribution(createGitAgentAttribution({ agentId: agentA, runId: runB, issueId: issue, nameAtTime: "Renamed Builder" }));
    expect((await f.call(["commit", "--allow-empty", "-m", "Second"])).code).toBe(0);
    expect(git(f.repo, ["show", "-s", "--format=%B", first])).toContain(`Paperclip-Agent: Builder A (${agentA})`);
    expect(git(f.repo, ["show", "-s", "--format=%B", "HEAD"])).toContain(`Paperclip-Agent: Renamed Builder (${agentA})`);
    expect(git(f.repo, ["rev-parse", "HEAD^"])).toBe(first);
  });
  it("another agent pushing an existing commit does not rewrite its creator or message", async () => {
    const f = await fixture(createGitAgentAttribution({ agentId: agentA, runId: runA, issueId: issue, nameAtTime: "Builder A" }));
    expect((await f.call(["commit", "--allow-empty", "-m", "Created by A"])).code).toBe(0);
    const before = git(f.repo, ["rev-parse", "HEAD"]); const body = git(f.repo, ["show", "-s", "--format=%B", "HEAD"]);
    const remote = join(f.root, "remote.git"); mkdirSync(remote); git(remote, ["init", "--bare"]);
    f.setAttribution(createGitAgentAttribution({ agentId: agentB, runId: runB, issueId: issue, nameAtTime: "Builder B" }));
    const result = await f.call(["push", remote, "HEAD:refs/heads/main"]); expect(result.code, result.stderr).toBe(0);
    expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(before); expect(git(remote, ["show", "-s", "--format=%B", before])).toBe(body);
  });
  it("leaves the native no-attribution commit path usable", async () => {
    const f = await fixture(undefined); const result = await f.call(["commit", "--allow-empty", "-m", "Native behavior"]);
    expect(result.code, result.stderr).toBe(0); expect(git(f.repo, ["show", "-s", "--format=%B", "HEAD"])).not.toContain("Paperclip-Agent:");
    expect(git(f.repo, ["show", "-s", "--format=%an", "HEAD"])).toBe("Native account");
  });
});
