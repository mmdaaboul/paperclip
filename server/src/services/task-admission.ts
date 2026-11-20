import { randomUUID } from "node:crypto";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

export type TaskDrainState = { startedAt: Date; expiresAt: Date | null; ownerId?: string };
let taskDrainState: TaskDrainState | null = null;
let persistentDrain:(()=>TaskDrainState|null)|undefined;
let observedPersistentOwner:string|null=null;
/** Local native maintenance owner only; no request/model controls this reader. */
export function installPersistentTaskDrain(reader:()=>TaskDrainState|null){
 if(persistentDrain)throw new Error("native_maintenance_provider_already_installed");
 reader();persistentDrain=reader;notifyDrainChanged();
 return ()=>{if(persistentDrain===reader){persistentDrain=undefined;observedPersistentOwner=null;notifyDrainChanged();}};
}
function readPersistentTaskDrain(){
 const drain=persistentDrain?.()??null,owner=drain?.ownerId??(drain?"persistent":null);
 if(owner!==observedPersistentOwner){observedPersistentOwner=owner;notifyDrainChanged();}
 return drain;
}

const expiryListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();

function notifyDrainChanged() {
  for (const listener of changeListeners) listener();
}
export function subscribeTaskDrainChanges(listener: () => void) {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}
export function subscribeTaskDrainExpiry(listener: () => void) {
  expiryListeners.add(listener);
  return () => { expiryListeners.delete(listener); };
}

// The shared coordinator owns this process-local deadline and its shutdown.
// Reading admission can also establish expiry, so both paths notify the same
// listener. No database scan or recurring timer is needed while idle.
export function registerTaskDrainExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  onExpired: () => void,
) {
  const worker = coordinator.register(DELIVERY_QUEUES.taskDrainExpiry, {
    retryMs: 1000,
    runDuringDrain: true,
    run: async () => { readTaskDrain(new Date()); },
    hasPending: async () => false,
    nextRunAt: () => taskDrainState?.expiresAt?.getTime() ?? null,
  });
  expiryListeners.add(onExpired);
  changeListeners.add(worker.wake);
  return {
    ready: worker.ready,
    async stop() {
      changeListeners.delete(worker.wake);
      expiryListeners.delete(onExpired);
      await worker.stop();
    },
  };
}

// Set while this server cannot renew its controller instance lease: it stops
// dispatching new work until the lease is renewed (or it exits). It never
// replaces an operator's drain and has no idle owner, so HTTP stays open.
let controllerLeaseQuiesce: TaskDrainState | null = null;
export function setControllerLeaseQuiesce(quiesced: boolean): void {
  if (quiesced === (controllerLeaseQuiesce !== null)) return;
  controllerLeaseQuiesce = quiesced ? { startedAt: new Date(), expiresAt: null } : null;
  notifyDrainChanged();
}

export function readTaskDrain(now: Date): TaskDrainState | null {
  const durable=readPersistentTaskDrain();
  if (taskDrainState?.expiresAt && taskDrainState.expiresAt.getTime() <= now.getTime()) {
    taskDrainState = null;
    for (const listener of expiryListeners) {
      try { listener(); } catch (error) { process.emitWarning(`Task drain expiry notification failed: ${String(error)}`); }
    }
  }
  return durable ?? taskDrainState ?? controllerLeaseQuiesce;
}

export function computeTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): TaskDrainState {
  const startedAt = new Date();
  return { startedAt, expiresAt: opts.ttlMs == null ? null : new Date(startedAt.getTime() + opts.ttlMs),
    ...(opts.purpose === "idle" ? { ownerId: randomUUID() } : {}) };
}

export function applyTaskDrain(drain: TaskDrainState): void {
  if(readPersistentTaskDrain())throw new Error("native_maintenance_hold_active");
  taskDrainState = drain;
  notifyDrainChanged();
}
export function startTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): TaskDrainState {
  const drain = computeTaskDrain(opts);
  applyTaskDrain(drain);
  return drain;
}
export function stopTaskDrain(): { wasActive: boolean } {
  if(readPersistentTaskDrain())throw new Error("native_maintenance_hold_active");
  const wasActive = readTaskDrain(new Date()) !== null && taskDrainState !== null;
  taskDrainState = null;
  notifyDrainChanged();
  return { wasActive };
}
export function isIdleTaskDrainActive(): boolean { return Boolean(readTaskDrain(new Date())?.ownerId); }

// Tokens count work until its actual promise settles, including after HTTP
// disconnects and after a cleanup batch has been removed from its input queue.
// The generation also catches work which starts AND finishes during a scan.
let generation = 0;
let active = 0;
const settledListeners = new Set<() => void>();
/** Called (synchronously) whenever the last tracked work finishes. */
export function subscribeIdleWorkSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}
export function beginIdleTrackedWork(): () => void {
  generation++;
  active++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    active--;
    generation++;
    if (active === 0) for (const listener of settledListeners) {
      try { listener(); } catch { /* a listener never blocks work accounting */ }
    }
  };
}
export function trackIdleWork<T>(work: Promise<T>): Promise<T> {
  const finish = beginIdleTrackedWork();
  return work.finally(finish);
}
export function idleWorkSnapshot() { return { generation, active }; }
