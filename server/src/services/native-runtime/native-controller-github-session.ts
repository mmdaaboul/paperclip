import type { NativeSession } from "../../vendor/paperclip-runner/index.js";
type Epoch={revoke():void;settle():Promise<void>};
const epochs=new WeakMap<NativeSession,()=>Epoch|undefined>();
async function join(work:Promise<unknown>[]){const results=await Promise.allSettled(work);const failed=results.find(r=>r.status==="rejected");if(failed?.status==="rejected")throw failed.reason;}
/** Bind the ACTUAL retained session handle. Control methods resolve the current
 * native epoch at invocation, so warm reuse cannot retain the previous run's
 * Git scope. Native controls still own cancellation and provider termination. */
export function bindNativeControllerGitSession(session:NativeSession,current:()=>Epoch|undefined):void {
 if(epochs.has(session)){epochs.set(session,current);return;}epochs.set(session,current);
 const revoke=()=>{const epoch=epochs.get(session)?.();epoch?.revoke();return epoch;};
 const close=session.close.bind(session);session.close=async input=>{const epoch=revoke();await join([Promise.resolve().then(()=>close(input)),epoch?.settle()??Promise.resolve()]);};
 const cancel=session.cancel?.bind(session);if(cancel)session.cancel=input=>{const epoch=revoke();const result=cancel(input);return {...result,cleanup:join([result.cleanup,epoch?.settle()??Promise.resolve()])};};
 const interrupt=session.interrupt?.bind(session);if(interrupt)session.interrupt=async input=>{const epoch=revoke();await join([Promise.resolve().then(()=>interrupt(input)),epoch?.settle()??Promise.resolve()]);};
 const detach=session.detachControllerForRestart?.bind(session);if(detach)session.detachControllerForRestart=async()=>{const epoch=revoke();await join([Promise.resolve().then(()=>detach()),epoch?.settle()??Promise.resolve()]);};
}
