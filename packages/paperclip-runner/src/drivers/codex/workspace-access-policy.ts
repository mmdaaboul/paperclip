import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceAccessPolicy } from "../../contracts/workspace-access.js";

/** Controller-owned grants, after company/project authorization. Never model input. */
export type CodexWorkspaceAccessPolicy = WorkspaceAccessPolicy;

export interface ResolvedCodexWorkspaceAccessPolicy {
  workspaceDirectory: string;
  referenceDirectories: string[];
  readOnlyWorkspace: boolean;
  scratchDirectory?: string;
}

/** Native path rules cannot protect a file through an existing writable hardlink.
 * Refuse unsupported trees instead of advertising a read-only grant that leaks.
 * This is metadata-only and bounded; it never reads or copies folder contents.
 */
export function assertReferenceDirectorySafe(root: string, remaining: { entries: number } = { entries: 10_000 }): void {
  inspectTree(root, remaining, "Reference", false);
}

function inspectTree(root: string, remaining: { entries: number }, label: string, permitSymlinks: boolean): void {
  const visit = (path: string, depth: number) => {
    if (depth > 32 || --remaining.entries < 0) throw new Error(`${label} tree exceeds the bounded metadata inspection; use a narrower folder`);
    const stat = lstatSync(path);
    // Scratch may contain ordinary build links; the native sandbox still checks
    // their actual targets. References themselves promise a real folder tree.
    if (stat.isSymbolicLink()) {
      if (permitSymlinks) return;
      throw new Error(`${label} tree contains a symlink; select a real, isolated folder`);
    }
    if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error(`${label} tree contains hardlinked files; read-only path rules cannot protect writable aliases`);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`${label} tree contains an unsupported filesystem object`);
    const opened = opendirSync(path);
    try {
      for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) {
        visit(join(path, entry.name), depth + 1);
      }
    } finally { opened.closeSync(); }
  };
  visit(root, 0);
}

function contains(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function directory(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Workspace access requires an absolute directory without control characters");
  }
  // Canonical grants prevent aliases from becoming a second writable spelling.
  // Do not follow a selected symlink; its meaning can change independently.
  const selected = lstatSync(value);
  if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error("Workspace access requires a real directory");
  const canonical = realpathSync(value);
  if (canonical === sep) throw new Error("Workspace access cannot grant the filesystem root");
  return canonical;
}

/** Save/admission preflight; authorization stays with the native controller. */
export function validateCodexReferenceDirectory(value: string, protectedPaths: readonly string[], budget = { entries: 10_000 }): string {
  const root = directory(value);
  for (const value of protectedPaths) {
    let protectedRoot: string;
    try { protectedRoot = realpathSync(value); } catch { protectedRoot = resolve(value); }
    if (contains(root, protectedRoot) || contains(protectedRoot, root)) throw new Error("Reference folder overlaps protected runtime or credential paths");
  }
  assertReferenceDirectorySafe(root, budget);
  return root;
}

/** Bounded metadata inspection once per provider launch; no file-content copy. */
export function resolveCodexWorkspaceAccessPolicy(
  input: CodexWorkspaceAccessPolicy,
  protectedDirectories: readonly string[],
): ResolvedCodexWorkspaceAccessPolicy {
  if (typeof input.readOnlyWorkspace !== "boolean" || !Array.isArray(input.referenceDirectories)
    || input.referenceDirectories.length > 32) throw new Error("Invalid workspace access policy");
  const workspaceDirectory = directory(input.workspaceDirectory);
  const protectedRoots = protectedDirectories.map((value) => {
    if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid protected directory");
    try { return realpathSync(value); } catch { return resolve(value); }
  });
  const denyProtected = (value: string) => {
    if (protectedRoots.some((root) => contains(root, value) || contains(value, root))) {
      throw new Error("Workspace access overlaps protected runtime or credential paths");
    }
  };
  denyProtected(workspaceDirectory);
  const referenceDirectories = [...new Set(input.referenceDirectories.map(directory))].sort();
  const remaining = { entries: 10_000 };
  for (const root of referenceDirectories) {
    denyProtected(root);
    if (contains(root, workspaceDirectory)) throw new Error("A reference folder cannot contain the execution workspace");
    assertReferenceDirectorySafe(root, remaining);
  }
  const scratchDirectory = input.scratchDirectory === undefined ? undefined : directory(input.scratchDirectory);
  if (input.readOnlyWorkspace && !scratchDirectory) throw new Error("Read-only review requires isolated writable scratch");
  if (scratchDirectory) {
    denyProtected(scratchDirectory);
    for (const root of [workspaceDirectory, ...referenceDirectories]) {
      if (contains(root, scratchDirectory) || contains(scratchDirectory, root)) {
        throw new Error("Review scratch must be disjoint from workspace and reference folders");
      }
    }
    if (input.readOnlyWorkspace) inspectTree(scratchDirectory, remaining, "Scratch", true);
  }
  return { workspaceDirectory, referenceDirectories, readOnlyWorkspace: input.readOnlyWorkspace,
    ...(scratchDirectory ? { scratchDirectory } : {}) };
}

/** Named native Codex permission rules; callers preserve existing base denies. */
export function codexWorkspaceAccessRules(policy: ResolvedCodexWorkspaceAccessPolicy, planning: boolean): string[] {
  const grants = new Map<string, "read" | "write">();
  grants.set(policy.workspaceDirectory, planning || policy.readOnlyWorkspace ? "read" : "write");
  for (const root of policy.referenceDirectories) grants.set(root, "read");
  if (policy.scratchDirectory) grants.set(policy.scratchDirectory, planning ? "read" : "write");
  return [...grants].map(([root, access]) => `${JSON.stringify(root)}=${JSON.stringify(access)}`);
}

/** Bind native :tmpdir to the granted scratch, never a shared host temp root. */
export function codexWorkspaceTemporaryDirectory(policy: ResolvedCodexWorkspaceAccessPolicy, value: string | undefined): string | undefined {
  if (!policy.scratchDirectory) return undefined;
  if (!value) throw new Error("Scoped scratch requires an explicit isolated TMPDIR");
  const selected = directory(value);
  if (!contains(policy.scratchDirectory, selected)) throw new Error("TMPDIR must stay inside granted scratch");
  return selected;
}
