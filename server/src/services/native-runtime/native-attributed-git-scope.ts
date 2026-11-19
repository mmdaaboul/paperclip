import { randomUUID } from "node:crypto";

/** One controller-owned lifetime per run/tool-authority epoch, not a random
 * recovery/deadline signal and not an environment-supplied grant. */
export function createNativeAttributedGitScope() {
  const controller = new AbortController();const epochId=randomUUID();const retirementHooks=new Set<()=>Promise<void>>();let retirement:Promise<void>|undefined;
  const pending = new Set<Promise<unknown>>();
  let settlementFailure: unknown;
  const abort = (reason = "native Git scope retired") => {controller.abort(new Error(reason));void retire().catch(()=>undefined);};
  const settle = async () => { while (pending.size) await Promise.allSettled([...pending]); if(settlementFailure !== undefined) throw settlementFailure; };
  const retire=()=>{if(!controller.signal.aborted)controller.abort(new Error("native Git scope retired"));return retirement??=(async()=>{await settle();await join([...retirementHooks].map(hook=>hook()));})();};
  const failSettlement=(error:Error)=>{settlementFailure??=error;abort("native Git settlement unknown");};
  const onRetire=(hook:()=>Promise<void>)=>{controller.signal.throwIfAborted();if(retirement)throw new Error("native_git_scope_already_retiring");retirementHooks.add(hook);};
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    const work = operation(); pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const join = async (work: Promise<unknown>[]) => {
    const results = await Promise.allSettled(work);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  return { epochId, signal: controller.signal, abort, settle, retire, failSettlement, onRetire, track };
}
