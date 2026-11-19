import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { reviewerNativeTestDatabase } from "../__tests__/helpers/reviewer-native-database.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { executeAttributedGitPush, type GitPushBinding, type GitPushRequest, type GitPushReceiptStore } from "./github-attributed-push.js";
import { createAttributedGitPushTransport, assertGitHubPushRemote, parseAttributedPushStatus, type AttributedGitCommandRunner } from "./github-attributed-push-git.js";
import { createPostgresGitPushReceiptStore, nativeGitPushReceiptSql, type PushReceiptSqlClient } from "./github-attributed-push-store.js";

const roots: string[] = [];
const fixtureEnv = { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, args: string[]) => execFileSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8", env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
const binding = (): GitPushBinding => ({ companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID(), issueId: randomUUID(), projectId: randomUUID(), executionWorkspaceId: randomUUID(),
  repositoryId: "123", repositoryFullName: "example/repository", nameAtTime: "Pushing Builder" });
const request = (newOid: string, expectedOldOid: string | null = null): GitPushRequest => ({ idempotencyKey: randomUUID(), ref: "refs/heads/main", expectedOldOid, newOid });

function gitFixture() {
  const root = mkdtempSync(join(process.cwd(), ".push-operation-test-")); roots.push(root);
  const repo = join(root, "repo"), remote = join(root, "remote.git"); mkdirSync(repo); mkdirSync(remote);
  git(repo, ["init", "-b", "main"]); git(remote, ["init", "--bare"]);
  git(repo, ["config", "user.name", "Original Creator"]); git(repo, ["config", "user.email", "123+shared@users.noreply.github.com"]);
  git(repo, ["commit", "--allow-empty", "-m", "Original creator commit"]);
  const initial = git(repo, ["rev-parse", "HEAD"]);
  let pushes = 0;
  const runner: AttributedGitCommandRunner = async input => {
    // Only this test dependency redirects the fixed GitHub URL to an owned bare
    // remote. The production adapter still supplies every actual Git argument.
    const args = input.args.map(arg => arg === "https://github.com/example/repository.git" ? remote
      : arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
    if (args.includes("push")) pushes++;
    const result = spawnSync(input.binary, args, { cwd: input.cwd, env: input.env, encoding: "utf8", timeout: input.timeoutMs });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const transport = (override?: AttributedGitCommandRunner) => createAttributedGitPushTransport({ cwd: repo, remoteUrl: "https://github.com/example/repository.git",
    repositoryFullName: "example/repository", credentialEnvironment: {} }, override ?? runner);
  return { root, repo, remote, initial, runner, transport, get pushes() { return pushes; },
    seed(oid = initial) { git(repo, ["push", remote, `${oid}:refs/heads/main`]); },
    tip() { try { return git(remote, ["rev-parse", "refs/heads/main"]); } catch { return null; } },
    next(message = "Next creator commit") { git(repo, ["commit", "--allow-empty", "-m", message]); return git(repo, ["rev-parse", "HEAD"]); },
  };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("closed attributed Git push transport", () => {
  it.each(["http://github.com/example/repository.git", "https://token@github.com/example/repository.git", "https://evil.example/example/repository.git", "https://github.com/other/repository.git", "https://github.com/example/repository.git?token=secret", "ssh://git@github.com/example/repository.git"])("rejects unsupported remote %s", remote => {
    expect(() => assertGitHubPushRemote(remote, "example/repository")).toThrow("Unsupported");
  });
  it("accepts only exact single-ref acknowledgement, not generic zero exit", () => {
    const req = request("a".repeat(40));
    expect(parseAttributedPushStatus(`*\t${req.newOid}:${req.ref}\t[new branch]\n`, 0, req)).toEqual({ kind: "accepted", ref: req.ref, oid: req.newOid });
    expect(parseAttributedPushStatus("done", 0, req)).toEqual({ kind: "unknown" });
    expect(parseAttributedPushStatus(`*\t${"b".repeat(40)}:${req.ref}\t[new branch]\n`, 0, req)).toEqual({ kind: "unknown" });
    expect(parseAttributedPushStatus(`*\tx:refs/heads/foreign\t[new branch]\n`, 0, req)).toEqual({ kind: "unknown" });
    expect(parseAttributedPushStatus(`+\tx:${req.ref}\tforced\n`, 0, req)).toEqual({ kind: "unknown" });
  });

  it.each([["http.sslVerify", "false"], ["http.https://github.com.proxy", "http://proxy.invalid"], ["credential.helper", "!false"], ["core.fsmonitor", "!false"], ["protocol.https.allow", "always"], ["include.path", "/untrusted/config"]])("refuses local transport/executable steering %s", async (key,value) => {
    const f = gitFixture(); git(f.repo,["config",key,value]);
    await expect(f.transport().verifyCandidate(f.initial)).rejects.toThrow("overrides"); expect(f.pushes).toBe(0);
  });
  it("passes only the bounded native credential projection to the Git child", async () => {
    let observed: Record<string, string | undefined> = {};
    const transport = createAttributedGitPushTransport({ cwd: "/owned/candidate", remoteUrl: "https://github.com/example/repository.git",
      repositoryFullName: "example/repository", credentialEnvironment: { GH_TOKEN: "fixture-token", GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_EXEC_PATH: "/model/executables",
        GIT_CONFIG_KEY_99: "model.extra", GIT_CONFIG_VALUE_99: "model-selected", PAPERCLIP_GITHUB_BROKER_TOKEN: "private-server-capability", SECRET_HOST_PASSWORD: "host-secret" } },
    async command => { observed = command.env; return { code: command.args.includes("config") ? 1 : 0, stdout: "", stderr: "" }; });
    await transport.verifyCandidate("a".repeat(40));
    expect(observed.GH_TOKEN).toBe("fixture-token"); expect(observed.GIT_CONFIG_KEY_0).toBe("credential.helper");
    for (const key of ["GIT_EXEC_PATH", "GIT_CONFIG_KEY_99", "PAPERCLIP_GITHUB_BROKER_TOKEN", "SECRET_HOST_PASSWORD"]) expect(observed).not.toHaveProperty(key);
    expect(() => createAttributedGitPushTransport({ cwd: "/owned/candidate", remoteUrl: "https://github.com/example/repository.git", repositoryFullName: "example/repository",
      credentialEnvironment: { GIT_CONFIG_COUNT: "999" } })).toThrow("Invalid");
  });
});

describe("durable server-executed push attribution with real local PostgreSQL and Git", () => {
  let fixture:Awaited<ReturnType<typeof reviewerNativeTestDatabase>>,client:PushReceiptSqlClient;
  let store: GitPushReceiptStore;
  beforeAll(async () => {
    fixture=await reviewerNativeTestDatabase();client=nativeGitPushReceiptSql(fixture.db);
    store=createPostgresGitPushReceiptStore(client);
  },30000);
  afterAll(async()=>{await fixture?.end();});

  it("confirms the actual pushing agent separately from an existing commit creator", async () => {
    const f = gitFixture(), actor = binding(), req = request(f.initial);
    const result = await executeAttributedGitPush({ binding: actor, request: req, store, authorizeCurrent: async () => true, createTransport: async () => f.transport() });
    expect(result.state).toBe("confirmed"); expect(result.confirmationSource).toBe("git_receive_pack_status"); expect(result.binding.agentId).toBe(actor.agentId);
    expect(f.tip()).toBe(f.initial); expect(git(f.remote, ["show", "-s", "--format=%an", f.initial])).toBe("Original Creator");
    expect(JSON.stringify(result)).not.toMatch(/token|password|credential/i); expect(f.pushes).toBe(1);
  });
  it("returns a durable same-request receipt after controller recreation and agent rename", async () => {
    const f = gitFixture(), actor = binding(), req = request(f.initial);
    const first = await executeAttributedGitPush({ binding: actor, request: req, store, authorizeCurrent: async () => true, createTransport: async () => f.transport() });
    const recreated = createPostgresGitPushReceiptStore(client);
    const replay = await executeAttributedGitPush({ binding: { ...actor, nameAtTime: "Renamed later" }, request: req, store: recreated, authorizeCurrent: async () => true, createTransport: async () => { throw new Error("Must not rerun"); } });
    expect(replay).toEqual(first); expect(replay.binding.nameAtTime).toBe("Pushing Builder"); expect(f.pushes).toBe(1);
  });
  it("does not manufacture pusher success when the ref was already at the target", async () => {
    const f = gitFixture(); f.seed();
    const result = await executeAttributedGitPush({ binding: binding(), request: request(f.initial), store, authorizeCurrent: async () => true, createTransport: async () => f.transport() });
    expect(result.state).toBe("no_change"); expect(result.confirmationSource).toBeNull(); expect(f.pushes).toBe(0);
  });
  it("refuses a stale expected ref without pushing", async () => {
    const f = gitFixture();
    const result = await executeAttributedGitPush({ binding: binding(), request: request(f.initial, "b".repeat(40)), store, authorizeCurrent: async () => true, createTransport: async () => f.transport() });
    expect(result.state).toBe("failed"); expect(result.reason).toBe("remote_ref_changed"); expect(f.tip()).toBeNull(); expect(f.pushes).toBe(0);
  });
  it("refuses an unrequested non-fast-forward rewrite", async () => {
    const f = gitFixture(); f.seed(); git(f.repo, ["checkout", "--orphan", "other-history"]);
    const other = f.next("Unrelated root");
    const result = await executeAttributedGitPush({ binding: binding(), request: request(other, f.initial), store, authorizeCurrent: async () => true, createTransport: async () => f.transport() });
    expect(result.reason).toBe("non_fast_forward_unsupported"); expect(f.tip()).toBe(f.initial); expect(f.pushes).toBe(0);
  });
  it("rechecks revocation immediately before the network write", async () => {
    const f = gitFixture(); let authorizations = 0;
    const result = await executeAttributedGitPush({ binding: binding(), request: request(f.initial), store, authorizeCurrent: async () => ++authorizations < 3, createTransport: async () => f.transport() });
    expect(result.state).toBe("failed"); expect(result.reason).toBe("authorization_revoked_before_write"); expect(f.pushes).toBe(0);
  });
  it("records uncertain after a real push whose acknowledgement is lost, and never blindly replays it", async () => {
    const f = gitFixture(), actor = binding(), req = request(f.initial);
    const result = await executeAttributedGitPush({ binding: actor, request: req, store, authorizeCurrent: async () => true,
      createTransport: async () => f.transport(async command => { const actual = await f.runner(command); return command.args.includes("push") ? { code: null, stdout: "", stderr: "lost acknowledgement" } : actual; }) });
    expect(result.state).toBe("uncertain"); expect(result.confirmationSource).toBeNull(); expect(f.tip()).toBe(f.initial);
    const retry = await executeAttributedGitPush({ binding: actor, request: req, store, authorizeCurrent: async () => true, createTransport: async () => { throw new Error("No replay"); } });
    expect(retry.id).toBe(result.id); expect(f.pushes).toBe(1);
  });
  it("preserves pending intent when durable settlement is unavailable after a real push", async () => {
    const f = gitFixture(), actor = binding(), req = request(f.initial);
    const unavailable: GitPushReceiptStore = { begin: receipt => store.begin(receipt), finish: async () => { throw new Error("Unavailable DB"); } };
    await expect(executeAttributedGitPush({ binding: actor, request: req, store: unavailable, authorizeCurrent: async () => true, createTransport: async () => f.transport() })).rejects.toThrow("Unavailable DB");
    const recovered = await executeAttributedGitPush({ binding: actor, request: req, store, authorizeCurrent: async () => true, createTransport: async () => { throw new Error("No replay"); } });
    expect(recovered.state).toBe("pending"); expect(f.tip()).toBe(f.initial); expect(f.pushes).toBe(1);
  });
  it("prevents two same-key concurrent invocations from executing twice", async () => {
    const f = gitFixture(), actor = binding(), req = request(f.initial);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const first = executeAttributedGitPush({ binding: actor, request: req, store, authorizeCurrent: async () => true, createTransport: async () => { started(); await gate; return f.transport(); } });
    await entered;
    const duplicate = await executeAttributedGitPush({ binding: actor, request: req, store, authorizeCurrent: async () => true, createTransport: async () => { throw new Error("Duplicate execution"); } });
    expect(duplicate.state).toBe("pending"); release(); expect((await first).state).toBe("confirmed"); expect(f.pushes).toBe(1);
  });
  it("rejects request mutation under an existing idempotency key", async () => {
    const f = gitFixture(), actor = binding(), req = request(f.initial);
    await executeAttributedGitPush({ binding: actor, request: req, store, authorizeCurrent: async () => true, createTransport: async () => f.transport() });
    await expect(executeAttributedGitPush({ binding: actor, request: { ...req, ref: "refs/heads/other" }, store, authorizeCurrent: async () => true, createTransport: async () => f.transport() })).rejects.toMatchObject({ code: "push_idempotency_conflict" });
    expect(f.pushes).toBe(1);
  });
  it("does not inherit local follow-tags or pre-push hook side effects", async () => {
    const f = gitFixture(); git(f.repo, ["tag", "-a", "fixture-tag", "-m", "No automatic tag push"]); git(f.repo, ["config", "push.followTags", "true"]);
    const hooks = join(f.root, "hooks"); mkdirSync(hooks); const marker = join(f.root, "hook-executed");
    writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\nprintf marker > '${marker}'\n`, { mode: 0o700 }); git(f.repo, ["config", "core.hooksPath", hooks]);
    const result = await executeAttributedGitPush({ binding: binding(), request: request(f.initial), store, authorizeCurrent: async () => true, createTransport: async () => f.transport() });
    expect(result.state).toBe("confirmed"); expect(git(f.remote, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
    expect(() => readFileSync(marker)).toThrow();
  });
  it("rejects local URL steering before a remote request", async () => {
    const f = gitFixture(); git(f.repo, ["config", "url.https://evil.example/.insteadOf", "https://github.com/"]);
    const result = await executeAttributedGitPush({ binding: binding(), request: request(f.initial), store, authorizeCurrent: async () => true, createTransport: async () => f.transport() });
    expect(result.state).toBe("failed"); expect(result.reason).toBe("push_preflight_unavailable"); expect(f.pushes).toBe(0);
  });
  it("rejects caller-selected actor fields and unauthorized runs before any push", async () => {
    const f = gitFixture();
    await expect(executeAttributedGitPush({ binding: binding(), request: { ...request(f.initial), agentId: randomUUID(), success: true }, store, authorizeCurrent: async () => true, createTransport: async () => f.transport() })).rejects.toMatchObject({ code: "push_request_invalid" });
    await expect(executeAttributedGitPush({ binding: binding(), request: request(f.initial), store, authorizeCurrent: async () => false, createTransport: async () => f.transport() })).rejects.toMatchObject({ code: "push_not_authorized" });
    expect(f.pushes).toBe(0);
  });
  it("blocks a new key or new run on an uncertain branch without confusing remote tip with pusher proof",async()=>{
    const f=gitFixture(),actor=binding(),req=request(f.initial);
    const uncertain=await executeAttributedGitPush({binding:actor,request:req,store,authorizeCurrent:async()=>true,createTransport:async()=>{
      const actual=f.transport();return {...actual,push:async value=>{await actual.push(value);return {kind:"unknown" as const};}};
    }});
    expect(uncertain.state).toBe("uncertain");expect(f.tip()).toBe(f.initial);
    for(const nextActor of [actor,{...actor,agentId:randomUUID(),runId:randomUUID()}])await expect(executeAttributedGitPush({binding:nextActor,request:{...req,idempotencyKey:randomUUID()},store,authorizeCurrent:async()=>true,
      createTransport:async()=>{throw Error("Must refuse before transport");}})).rejects.toMatchObject({code:"push_branch_reconciliation_required"});
    expect((await executeAttributedGitPush({binding:actor,request:req,store,authorizeCurrent:async()=>true,createTransport:async()=>f.transport()})).state).toBe("uncertain");expect(f.pushes).toBe(1);
  });
  it("serializes different request keys on one pending branch while unrelated branches remain responsive",async()=>{
    const f=gitFixture(),actor=binding(),req=request(f.initial);let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const first=executeAttributedGitPush({binding:actor,request:req,store,authorizeCurrent:async()=>true,createTransport:async()=>{enter();await gate;return f.transport();}});
    await entered;
    try {
      await expect(executeAttributedGitPush({binding:actor,request:{...req,idempotencyKey:randomUUID()},store,authorizeCurrent:async()=>true,createTransport:async()=>f.transport()})).rejects.toMatchObject({code:"push_branch_reconciliation_required"});
      const other=await executeAttributedGitPush({binding:actor,request:{...req,idempotencyKey:randomUUID(),ref:"refs/heads/unrelated"},store,authorizeCurrent:async()=>true,createTransport:async()=>f.transport()});
      expect(other.state).toBe("confirmed");
    }finally{release();}
    expect((await first).state).toBe("confirmed");expect(f.pushes).toBe(2);
  });
  it("retains confirmed durable settlement when its reply is lost",async()=>{
    const f=gitFixture(),actor=binding(),req=request(f.initial);let lost=false;
    const lostReply:GitPushReceiptStore={begin:r=>store.begin(r),finish:async(...args)=>{const saved=await store.finish(...args);if(!lost){lost=true;throw Error("Synthetic lost postcommit reply");}return saved;}};
    const result=await executeAttributedGitPush({binding:actor,request:req,store:lostReply,authorizeCurrent:async()=>true,createTransport:async()=>f.transport()});
    expect(result.state).toBe("confirmed");expect(f.tip()).toBe(f.initial);expect(f.pushes).toBe(1);
  });

  it("native receipt transactions select READ COMMITTED even when this isolated database defaults to REPEATABLE READ",async()=>{
    const result=await client.query("SELECT current_database() AS name");const name=String(result.rows[0].name);expect(name).toMatch(/^paperclip/);
    const quoted='"'+name.replaceAll('"','""')+'"';let extra:Awaited<ReturnType<typeof reviewerNativeTestDatabase>>|undefined;
    await client.query(`ALTER DATABASE ${quoted} SET default_transaction_isolation TO 'repeatable read'`);
    try {
      extra=await reviewerNativeTestDatabase();const isolated=nativeGitPushReceiptSql(extra.db);
      expect(String((await isolated.query("SHOW default_transaction_isolation")).rows[0].default_transaction_isolation)).toBe("repeatable read");
      expect(await isolated.transaction(async tx=>String((await tx.query("SHOW transaction_isolation")).rows[0].transaction_isolation))).toBe("read committed");
    }finally{await client.query(`ALTER DATABASE ${quoted} RESET default_transaction_isolation`);await extra?.end();}
  });

});
