import { afterEach, describe, expect, it } from "vitest";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createIsolatedCodexAppServerArgs, CODEX_SKILLLESS_PERMISSION_PROFILE, CODEX_PLANNING_PERMISSION_PROFILE } from "./codex-security-config.js";
import { createIsolatedCodexAppServerArgs as baselineArgs } from "./codex-security-config.baseline.js";
import { assertReferenceDirectorySafe, codexWorkspaceAccessRules, resolveCodexWorkspaceAccessPolicy } from "./workspace-access-policy.js";

const roots: string[] = [];
function fixture() {
  // Test-owned tiny files only; no project/Docker/VPS fixture is reused or removed.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-access-")));
  roots.push(root);
  const dir = (name: string) => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; };
  const workspaceDirectory = dir("candidate");
  const referenceDirectory = dir("reference");
  const nestedReference = dir("candidate/reference");
  const scratchDirectory = dir("scratch");
  const home = dir("runtime-home");
  const codexHome = dir("codex-home");
  for (const path of [workspaceDirectory, referenceDirectory, nestedReference, scratchDirectory, home]) {
    writeFileSync(join(path, "retained.txt"), "original\n");
  }
  const source = { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: codexHome, TMPDIR: scratchDirectory };
  const policy = { workspaceDirectory, referenceDirectories: [referenceDirectory, nestedReference], readOnlyWorkspace: false, scratchDirectory };
  return { root, dir, workspaceDirectory, referenceDirectory, nestedReference, scratchDirectory, home, codexHome, source, policy };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("controller-owned workspace grants", () => {
  it("canonicalizes and deduplicates real reference directories", () => {
    const f = fixture();
    const policy = resolveCodexWorkspaceAccessPolicy({ ...f.policy, referenceDirectories: [f.referenceDirectory, f.referenceDirectory] }, [f.home]);
    expect(policy.referenceDirectories).toEqual([f.referenceDirectory]);
  });
  it.each(["/", "relative", "bad\npath", "bad\0path"])("rejects broad or invalid selected path %j", path => {
    const f = fixture();
    expect(() => resolveCodexWorkspaceAccessPolicy({ ...f.policy, referenceDirectories: [path] }, [])).toThrow();
  });
  it("rejects missing paths, files and selected symlinks", () => {
    const f = fixture();
    const link = join(f.root, "link"); symlinkSync(f.referenceDirectory, link);
    for (const path of [join(f.root, "missing"), join(f.referenceDirectory, "retained.txt"), link]) {
      expect(() => resolveCodexWorkspaceAccessPolicy({ ...f.policy, referenceDirectories: [path] }, [])).toThrow();
    }
  });
  it("rejects protected roots, their descendants and their parents", () => {
    const f = fixture(); const child = f.dir("runtime-home/private");
    for (const path of [f.home, child, f.root]) {
      expect(() => resolveCodexWorkspaceAccessPolicy({ ...f.policy, referenceDirectories: [path] }, [f.home])).toThrow("protected");
    }
  });
  it("rejects a reference containing the workspace", () => {
    const f = fixture();
    expect(() => resolveCodexWorkspaceAccessPolicy({ ...f.policy, referenceDirectories: [f.root] }, [])).toThrow("contain");
  });
  it("requires disjoint scratch for a read-only candidate", () => {
    const f = fixture();
    expect(() => resolveCodexWorkspaceAccessPolicy({ ...f.policy, readOnlyWorkspace: true, scratchDirectory: undefined }, [])).toThrow("scratch");
    for (const path of [f.workspaceDirectory, f.nestedReference, f.referenceDirectory, f.root]) {
      expect(() => resolveCodexWorkspaceAccessPolicy({ ...f.policy, readOnlyWorkspace: true, scratchDirectory: path }, [])).toThrow("disjoint");
    }
  });
  it("bounds reference grants and requires an explicit boolean", () => {
    const f = fixture();
    expect(() => resolveCodexWorkspaceAccessPolicy({ ...f.policy, referenceDirectories: Array(33).fill(f.referenceDirectory) }, [])).toThrow("Invalid");
    expect(() => resolveCodexWorkspaceAccessPolicy({ ...f.policy, readOnlyWorkspace: "yes" as unknown as boolean }, [])).toThrow("Invalid");
  });
  it("refuses unsupported reference trees and bounds metadata inspection", () => {
    const f = fixture();
    expect(() => assertReferenceDirectorySafe(f.referenceDirectory, { entries: 1 })).toThrow("bounded");
    symlinkSync(f.workspaceDirectory, join(f.referenceDirectory, "redirect"));
    expect(() => resolveCodexWorkspaceAccessPolicy(f.policy, [])).toThrow("symlink");
  });
  it("does not grant write access in planning mode", () => {
    const f = fixture(); const policy = resolveCodexWorkspaceAccessPolicy(f.policy, []);
    expect(codexWorkspaceAccessRules(policy, true).every(rule => rule.endsWith('="read"'))).toBe(true);
  });
  it("rejects delegated or preconfigured-home access rather than weakening it", () => {
    const f = fixture();
    for (const extra of [{ PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1" }, { PAPERCLIP_RUNNER_HOME_MODE: "preconfigured" }]) {
      expect(() => createIsolatedCodexAppServerArgs({ ...f.source, ...extra }, [], undefined, [], false, f.policy)).toThrow("workspace_access_requires_isolated_local_codex");
    }
  });
  it("does not accept self-supplied environment grants", () => {
    const f = fixture();
    const args = createIsolatedCodexAppServerArgs({ ...f.source, PAPERCLIP_WORKSPACE_ACCESS: JSON.stringify(f.policy) });
    expect(args.join("\n")).not.toContain(f.referenceDirectory);
    expect(args.join("\n")).not.toContain(f.scratchDirectory);
  });
  it.each([{}, { PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled" }, { PAPERCLIP_RUNNER_HOME_MODE: "preconfigured" }, { PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1" }])("preserves the complete native configuration when feature is absent: %j", extra => {
    const f = fixture(); const source = { ...f.source, ...extra };
    expect(createIsolatedCodexAppServerArgs(source)).toEqual(baselineArgs(source));
  });
  it("refuses missing or unrelated TMPDIR for granted scratch", () => {
    const f = fixture();
    for (const value of [undefined, f.workspaceDirectory, f.root]) {
      expect(() => createIsolatedCodexAppServerArgs({ ...f.source, TMPDIR: value }, [], undefined, [], false, f.policy)).toThrow(/TMPDIR/);
    }
  });
  it("downgrades writable Git metadata for read-only candidate and references", () => {
    const f = fixture(); const git = f.dir("reference/.git");
    const args = createIsolatedCodexAppServerArgs({ ...f.source, PAPERCLIP_GIT_METADATA_ROOTS: JSON.stringify([git]) }, [], undefined, [], false, f.policy);
    expect(args.find(arg => arg.startsWith(`permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.filesystem=`))).toContain(`${JSON.stringify(git)}="read"`);
    const reviewer = createIsolatedCodexAppServerArgs({ ...f.source, PAPERCLIP_GIT_METADATA_ROOTS: JSON.stringify([f.dir("candidate/.git")]) }, [], undefined, [], false, { ...f.policy, readOnlyWorkspace: true });
    expect(reviewer.find(arg => arg.startsWith(`permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.filesystem=`))).not.toContain(`${JSON.stringify(f.workspaceDirectory + "/.git")}="write"`);
  });
});

describe.runIf(process.platform === "darwin")("real native Codex sandbox, no provider or authentication", () => {
  function run(f: ReturnType<typeof fixture>, readOnly: boolean, command: string, paths: string[], planning = false) {
    const args = createIsolatedCodexAppServerArgs(f.source, [], undefined, [], false, { ...f.policy, readOnlyWorkspace: readOnly });
    const config = args.filter(arg => arg.startsWith("permissions.")).flatMap(arg => ["-c", arg]);
    return spawnSync(process.env.PAPERCLIP_TEST_CODEX_BINARY ?? "/opt/homebrew/bin/codex", ["sandbox", ...config, "-P", planning ? CODEX_PLANNING_PERMISSION_PROFILE : CODEX_SKILLLESS_PERMISSION_PROFILE,
      "-C", f.workspaceDirectory, "--", "/bin/sh", "-c", command, "access-test", ...paths], {
      encoding: "utf8", timeout: 15_000, env: { ...f.source, LANG: "C", TMPDIR: f.scratchDirectory },
    });
  }
  it("allows ordinary workspace writes and selected reference reads", () => {
    const f = fixture();
    const result = run(f, false, 'cat "$1" "$2"; printf allowed > "$3"', [join(f.referenceDirectory, "retained.txt"), join(f.nestedReference, "retained.txt"), join(f.workspaceDirectory, "allowed.txt")]);
    expect({ status: result.status, stderr: result.stderr, error: result.error?.message }).toEqual({ status: 0, stderr: "", error: undefined });
    expect(result.stdout).toBe("original\noriginal\n");
    expect(readFileSync(join(f.workspaceDirectory, "allowed.txt"), "utf8")).toBe("allowed");
  });
  it.each(["external", "nested"])("denies write/delete/rename for %s reference contents", kind => {
    const f = fixture(); const directory = kind === "external" ? f.referenceDirectory : f.nestedReference;
    for (const command of ['printf changed > "$1"', 'rm "$1"', 'mv "$1" "$2"']) {
      const result = run(f, false, command, [join(directory, "retained.txt"), join(directory, "renamed.txt")]);
      expect(result.status, result.stderr).not.toBe(0);
      expect(readFileSync(join(directory, "retained.txt"), "utf8")).toBe("original\n");
    }
  });
  it("denies candidate and Git writes while allowing Reviewer scratch", () => {
    const f = fixture(); const git = f.dir("candidate/.git"); writeFileSync(join(git, "config"), "original\n");
    for (const file of [join(f.workspaceDirectory, "retained.txt"), join(git, "config")]) {
      const result = run(f, true, 'printf changed > "$1"', [file]);
      expect(result.status, result.stderr).not.toBe(0); expect(readFileSync(file, "utf8")).toBe("original\n");
    }
    const result = run(f, true, 'printf build-output > "$1"', [join(f.scratchDirectory, "output.txt")]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.scratchDirectory, "output.txt"), "utf8")).toBe("build-output");
  });
  it("denies unrelated credential reads and refuses reference symlink escape before launch", () => {
    const f = fixture();
    const result = run(f, false, 'cat "$1"', [join(f.home, "retained.txt")]);
    expect(result.status, result.stderr).not.toBe(0); expect(result.stdout).toBe("");
    symlinkSync(join(f.home, "retained.txt"), join(f.referenceDirectory, "escape"));
    expect(() => run(f, false, 'cat "$1"', [join(f.referenceDirectory, "escape")])).toThrow("symlink");
  });
  it("keeps planning mode read-only including scratch", () => {
    const f = fixture(); const result = run(f, false, 'printf changed > "$1"', [join(f.scratchDirectory, "retained.txt")], true);
    expect(result.status, result.stderr).not.toBe(0);
    expect(readFileSync(join(f.scratchDirectory, "retained.txt"), "utf8")).toBe("original\n");
  });
  it("denies renaming the nested reference root through its writable parent", () => {
    const f = fixture(); const result = run(f, false, 'mv "$1" "$2"', [f.nestedReference, join(f.workspaceDirectory, "moved-reference")]);
    expect(result.status, result.stderr).not.toBe(0);
    expect(readFileSync(join(f.nestedReference, "retained.txt"), "utf8")).toBe("original\n");
  });
  it("denies making a writable hardlink alias to a read-only reference", () => {
    const f = fixture();
    const result = run(f, false, 'ln "$1" "$2" && printf changed > "$2"', [join(f.referenceDirectory, "retained.txt"), join(f.workspaceDirectory, "alias")]);
    expect(result.status, result.stderr).not.toBe(0);
    expect(readFileSync(join(f.referenceDirectory, "retained.txt"), "utf8")).toBe("original\n");
  });
  it("protects reference bytes when a writable-workspace hardlink already exists", () => {
    const f = fixture();
    const alias = join(f.workspaceDirectory, "existing-alias");
    linkSync(join(f.referenceDirectory, "retained.txt"), alias);
    expect(() => run(f, false, 'printf changed > "$1"', [alias])).toThrow("hardlinked");
    expect(readFileSync(join(f.referenceDirectory, "retained.txt"), "utf8")).toBe("original\n");
  });
  it("refuses an existing scratch hardlink to the read-only candidate", () => {
    const f = fixture(); const alias = join(f.scratchDirectory, "candidate-alias");
    linkSync(join(f.workspaceDirectory, "retained.txt"), alias);
    expect(() => run(f, true, 'printf changed > "$1"', [alias])).toThrow("hardlinked");
    expect(readFileSync(join(f.workspaceDirectory, "retained.txt"), "utf8")).toBe("original\n");
  });
  it("denies scratch symlink writes to the read-only candidate", () => {
    const f = fixture(); const alias = join(f.scratchDirectory, "candidate-symlink");
    symlinkSync(join(f.workspaceDirectory, "retained.txt"), alias);
    const result = run(f, true, 'printf changed > "$1"', [alias]);
    expect(result.status, result.stderr).not.toBe(0);
    expect(readFileSync(join(f.workspaceDirectory, "retained.txt"), "utf8")).toBe("original\n");
  });
});
