import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertReferenceDirectorySafe } from "./workspace-access-policy.js";

const refuse = () => new Error("Reviewer linked Git metadata is unsupported or changed; engineering is required");
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};

/** Inspector-only read roots, never model policy or caller-supplied environment.
 * Support native nested worktrees with reciprocal Git links. External sibling
 * worktrees require an independently authorized repository anchor instead.
 */
export async function resolveReviewerGitMetadata(workspace: string, scratch: string, protectedPaths: string[]) {
  const dotGit = join(workspace, ".git");
  const selected = await lstat(dotGit);
  if (selected.isSymbolicLink()) throw refuse();
  if (selected.isDirectory()) return { readOnlyRoots: [] as string[], assertCurrent: async () => {
    const current = await lstat(dotGit);
    if (current.dev !== selected.dev || current.ino !== selected.ino || !current.isDirectory() || current.isSymbolicLink()) throw refuse();
  } };
  const owner = (await lstat(workspace)).uid;
  const identities: { path: string; dev: number; ino: number; mode: number; uid: number; bytes?: Buffer }[] = [];
  const control = async (path: string, expected: { dev: number; ino: number }) => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await handle.stat();
      if (!s.isFile() || s.uid !== owner || s.nlink !== 1 || s.size > 4096 || s.dev !== expected.dev || s.ino !== expected.ino) throw refuse();
      const bytes = Buffer.alloc(4097), read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 4096 || read.bytesRead !== s.size) throw refuse();
      return bytes.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
  };
  const capture = async (path: string, file = false) => {
    const s = await lstat(path);
    if (s.isSymbolicLink() || s.uid !== owner || await realpath(path) !== resolve(path)
      || (file ? !s.isFile() || s.nlink !== 1 || s.size > 4096 : !s.isDirectory())) throw refuse();
    const bytes = file ? await control(path, s) : undefined;
    identities.push({ path, dev: s.dev, ino: s.ino, mode: s.mode, uid: s.uid, bytes });
    return bytes?.toString("utf8");
  };
  const pointer = await capture(dotGit, true);
  const match = /^gitdir: ([^\x00-\x1f\x7f]+)\n?$/.exec(pointer!);
  if (!match) throw refuse();
  const gitDir = resolve(workspace, match[1]!);
  // The nearest existing ancestor marker is authoritative. Never skip a bad
  // marker and fall back to a broader grant.
  let common: string | undefined;
  for (let parent = dirname(workspace); ; parent = dirname(parent)) {
    const candidate = join(parent, ".git");
    try {
      const s = await lstat(candidate);
      if (!s.isDirectory() || s.isSymbolicLink()) throw refuse();
      common = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (parent === dirname(parent)) break;
  }
  if (!common || dirname(gitDir) !== join(common, "worktrees") || !basename(gitDir) || /[\x00-\x1f\x7f]/.test(gitDir)) throw refuse();
  for (const denied of [workspace, scratch, ...protectedPaths]) {
    let canonical: string;
    try { canonical = await realpath(denied); } catch { canonical = resolve(denied); }
    if (inside(common, canonical) || inside(canonical, common)) throw refuse();
  }
  await capture(common);
  await capture(join(common, "worktrees"));
  await capture(gitDir);
  const commonPointer = await capture(join(gitDir, "commondir"), true);
  const backPointer = await capture(join(gitDir, "gitdir"), true);
  const line = (value: string | undefined) => {
    if (!value || !/^[^\x00-\x1f\x7f]+\n?$/.test(value)) throw refuse();
    return value.replace(/\n$/, "");
  };
  if (resolve(gitDir, line(commonPointer)) !== common || resolve(gitDir, line(backPointer)) !== dotGit) throw refuse();
  // Same bounded alias/special-object checks as native read-only references.
  // A larger repository refuses; this is not a promise of unlimited support.
  assertReferenceDirectorySafe(common);
  const assertCurrent = async () => {
    for (const before of identities) {
      const s = await lstat(before.path);
      if (s.dev !== before.dev || s.ino !== before.ino || s.mode !== before.mode || s.uid !== before.uid
        || s.isSymbolicLink() || await realpath(before.path) !== resolve(before.path)
        || (before.bytes && (s.nlink !== 1 || s.size > 4096 || !before.bytes.equals(await control(before.path, s))))) throw refuse();
    }
  };
  await assertCurrent();
  return { readOnlyRoots: [common], assertCurrent };
}
