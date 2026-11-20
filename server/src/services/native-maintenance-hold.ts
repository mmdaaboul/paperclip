import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, rmdirSync, realpathSync, fstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { TaskDrainState } from "./task-admission.js";

export interface MaintenanceHandle { instanceId: string; holdId: string; ownerKey: string }
export type MaintenancePhase = "draining" | "validating" | "verified" | "recovery_required";
export interface MaintenanceRecord {
  schema: "paperclip.native-maintenance.v1"; instanceId: string; holdId: string; ownerDigest: string;
  createdAt: string; phase: MaintenancePhase; installedSha: string; candidateSha: string;
  baselineDigest?: string; verifiedDigest?: string; failure?: string;
}
export interface MaintenanceBoot { schema: "paperclip.native-maintenance-boot.v1"; holdId: string; bootId: string; probeKey: string; host: string; port: number; commit: string; pid: number }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = /^[a-f0-9]{40}$/;
const key = /^[a-f0-9]{64}$/;
function fail(reason: string): never { throw new Error(`native_maintenance_${reason}`); }
function present(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function privateNode(path: string, directory: boolean) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
    || process.getuid && s.uid !== process.getuid() || (s.mode & 0o077) !== 0) fail("unsafe_private_state");
}
function privateRead(path: string): unknown {
  privateNode(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > 1024 * 1024 || (s.mode & 0o077) !== 0 || process.getuid && s.uid !== process.getuid()) fail("unsafe_private_state"); return JSON.parse(readFileSync(fd, "utf8")); }
  finally { closeSync(fd); }
}
function syncDirectory(path: string) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** Local service-account control only. Never exported to model/native tool
 * authority. Private nonce/handles must not be stored in the reusable kit.
 * No timeout automatically resumes an incomplete deployment.
 */
export class NativeMaintenanceHold {
  readonly directory: string;
  constructor(readonly instanceRoot: string, readonly instanceId: string) {
    if (!isAbsolute(instanceRoot) || realpathSync(instanceRoot) !== instanceRoot || !/^[A-Za-z0-9_-]+$/.test(instanceId)) fail("instance_binding");
    const s = lstatSync(instanceRoot); if (!s.isDirectory() || s.isSymbolicLink() || process.getuid && s.uid !== process.getuid()) fail("instance_binding");
    this.directory = join(instanceRoot, ".native-maintenance");
    if (present(this.directory)) privateNode(this.directory, true);
    this.status(); // Malformed state refuses startup, never infers no hold.
  }
  #path(name: string) { return join(this.directory, name); }
  #exclusive<T>(work: () => T): T {
    if (!present(this.directory)) mkdirSync(this.directory, { mode: 0o700 });
    privateNode(this.directory, true);
    const lock = this.#path("transition.lock"); mkdirSync(lock, { mode: 0o700 });
    try { return work(); } finally { rmdirSync(lock); syncDirectory(this.directory); }
  }
  #write(name: string, value: unknown) {
    const temporary = this.#path(`.${name}-${randomUUID()}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.#path(name)); syncDirectory(this.directory);
  }
  status(): MaintenanceRecord | null {
    if (!present(this.directory)) return null;
    privateNode(this.directory, true);
    if (!present(this.#path("active.json"))) return null;
    const v = privateRead(this.#path("active.json")) as MaintenanceRecord;
    if (v.schema !== "paperclip.native-maintenance.v1" || v.instanceId !== this.instanceId || !/^[a-f0-9-]{36}$/.test(v.holdId)
      || !key.test(v.ownerDigest) || !sha.test(v.installedSha) || !sha.test(v.candidateSha) || !Number.isFinite(Date.parse(v.createdAt))
      || !["draining", "validating", "verified", "recovery_required"].includes(v.phase)) fail("malformed_state");
    return Object.freeze(v);
  }
  drain(): TaskDrainState | null { const state = this.status(); return state ? { startedAt: new Date(state.createdAt), expiresAt: null, ownerId: `maintenance:${state.holdId}` } : null; }
  authorize(handle: MaintenanceHandle): MaintenanceRecord {
    const state = this.status();
    if (!state || handle.instanceId !== this.instanceId || handle.holdId !== state.holdId || !key.test(handle.ownerKey)
      || !timingSafeEqual(Buffer.from(hash(handle.ownerKey)), Buffer.from(state.ownerDigest))) fail("ownership_changed");
    return state;
  }
  acquire(installedSha: string, candidateSha: string): MaintenanceHandle {
    if (!sha.test(installedSha) || !sha.test(candidateSha)) fail("source_identity");
    return this.#exclusive(() => {
      if (this.status()) fail("already_active");
      const handle = { instanceId: this.instanceId, holdId: randomUUID(), ownerKey: randomBytes(32).toString("hex") };
      this.#write("active.json", { schema: "paperclip.native-maintenance.v1", instanceId: this.instanceId, holdId: handle.holdId,
        ownerDigest: hash(handle.ownerKey), createdAt: new Date().toISOString(), phase: "draining", installedSha, candidateSha });
      return handle;
    });
  }
  /** Caller is the native capture consumer after it has produced actual content
   * evidence. Not an HTTP/model boolean; digest binds its private proof bytes. */
  bindBaseline(handle: MaintenanceHandle, digest: string) {
    if (!key.test(digest)) fail("baseline_digest");
    this.#exclusive(() => { const s = this.authorize(handle); if (s.phase !== "draining" || s.baselineDigest) fail("baseline_already_bound"); this.#write("active.json", { ...s, phase: "validating", baselineDigest: digest }); });
  }
  bindVerified(handle: MaintenanceHandle, baseline: string, verified: string) {
    if (!key.test(verified)) fail("verified_digest");
    this.#exclusive(() => { const s = this.authorize(handle); if (s.phase !== "validating" || s.baselineDigest !== baseline) fail("baseline_changed"); this.#write("active.json", { ...s, phase: "verified", verifiedDigest: verified }); });
  }
  recovery(handle: MaintenanceHandle, failure: string) {
    if (!/^[a-z0-9_]{1,120}$/.test(failure)) fail("failure_code");
    this.#exclusive(() => { const s = this.authorize(handle); this.#write("active.json", { ...s, phase: "recovery_required", failure }); });
  }
  release(handle: MaintenanceHandle, verifiedDigest: string) {
    this.#exclusive(() => { const s = this.authorize(handle); if (s.phase !== "verified" || s.verifiedDigest !== verifiedDigest) fail("validation_required");
      // Retain the final owner-bound receipt; remove only the active latch.
      this.#write(`released-${s.holdId}.json`, { ...s, releasedAt: new Date().toISOString() }); unlinkSync(this.#path("active.json")); syncDirectory(this.directory); });
  }
  boot(handleId: string, value: Omit<MaintenanceBoot, "schema" | "holdId" | "bootId" | "probeKey" | "pid">): MaintenanceBoot {
    const s = this.status(); if (!s || s.holdId !== handleId || !sha.test(value.commit) || ![s.installedSha, s.candidateSha].includes(value.commit)) fail("boot_source_or_owner");
    const boot: MaintenanceBoot = { schema: "paperclip.native-maintenance-boot.v1", holdId: s.holdId, bootId: randomUUID(), probeKey: randomBytes(32).toString("hex"), pid: process.pid, ...value };
    this.#exclusive(() => { if (this.status()?.holdId !== s.holdId) fail("ownership_changed"); this.#write("boot.json", boot); }); return boot;
  }
  readBoot(handle: MaintenanceHandle): MaintenanceBoot {
    const s = this.authorize(handle); const boot = privateRead(this.#path("boot.json")) as MaintenanceBoot;
    if (boot.schema !== "paperclip.native-maintenance-boot.v1" || boot.holdId !== s.holdId || !key.test(boot.probeKey) || !sha.test(boot.commit)
      || ![s.installedSha, s.candidateSha].includes(boot.commit) || !Number.isSafeInteger(boot.port) || boot.port < 1 || boot.port > 65535
      || !["127.0.0.1", "::1", "localhost"].includes(boot.host)) fail("boot_binding");
    return boot;
  }
}
