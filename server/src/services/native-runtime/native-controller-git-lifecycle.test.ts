import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtemp,mkdir,realpath,readdir,rm,writeFile } from "node:fs/promises";
import { afterEach,describe,expect,it,vi } from "vitest";
const child=vi.hoisted(()=>({pending:null as null|{emit:(name:string,...args:unknown[])=>boolean;callback:(error:unknown,out:string)=>void;args:string[];env:NodeJS.ProcessEnv},entered:null as null|(()=>void)}));
vi.mock("node:child_process",()=>({execFile:(_binary:string,args:string[],options:any,callback:any)=>{
 const process=new EventEmitter();if(args.includes("--exec-path")){queueMicrotask(()=>callback(null,"/usr/libexec/git-core\n"));return process;}
 child.pending={emit:process.emit.bind(process),callback,args,env:options.env};child.entered?.();return process;
}}));
import { createNativeControllerGitRunner, nativeControllerGitDirectories } from "./native-controller-git-runner.js";
import { createNativeAttributedGitScope } from "./native-attributed-git-scope.js";
import { bindNativeControllerGitSession } from "./native-controller-github-session.js";
import { createWorkspaceAccessSnapshot,type NativeSession } from "../../vendor/paperclip-runner/index.js";
const roots:string[]=[];
afterEach(async()=>{vi.useRealTimers();child.pending=null;child.entered=null;for(const root of roots.splice(0))if(process.env.PAPERCLIP_NATIVE_GIT_RETAIN_TEST_FIXTURES!=="1")await rm(root,{recursive:true,force:true});});
async function fixture(protectedOperationRoot?: "controller" | "credential" | "instruction"){
 const root=await realpath(await mkdtemp(join(tmpdir(),"controller-lifecycle-")));roots.push(root);
 const workspace=join(root,"workspace"),reference=join(root,"reference"),codex=join(root,"codex");
 const {controllerRoot,runtimeDirectory}=nativeControllerGitDirectories(join(root,"instance"));
 const credential=join(root,"credentials"),instruction=join(root,"instructions");
 const protectedPaths=[controllerRoot,credential,instruction];
 const protectedRoot=protectedOperationRoot && {controller:controllerRoot,credential,instruction}[protectedOperationRoot];
 const runtime=protectedRoot ? join(protectedRoot,"recorded-controller-git") : runtimeDirectory;
 for(const path of [workspace,reference,controllerRoot,credential,instruction,runtime])await mkdir(path,{recursive:true,mode:0o700});await writeFile(codex,"fixture executable, never launched",{mode:0o700});
 const scope=createNativeAttributedGitScope(),snapshot=createWorkspaceAccessSnapshot({companyId:randomUUID(),agentId:randomUUID(),runId:randomUUID(),projectId:randomUUID(),workspaceId:randomUUID()},
  {workspaceDirectory:workspace,referenceDirectories:[reference],readOnlyWorkspace:false});
 const run=await createNativeControllerGitRunner({scope,workspace:snapshot,runtimeDirectory:runtime,gitBinary:"/usr/bin/git",codexCommand:codex,protectedPaths,filesystemEnvironment:{PAPERCLIP_RUNNER_NETWORK_ACCESS:"disabled",PAPERCLIP_GIT_METADATA_ROOTS:undefined,PAPERCLIP_RUNNER_NETWORK_ROOTS:undefined},assertCurrent:async()=>{}});
 const command=(args=["status","--porcelain"])=>run({binary:"/usr/bin/git",args,cwd:workspace,env:{},timeoutMs:1000});
 return {root,workspace,reference,runtime,protectedPaths,scope,command};
}
describe("actual controller lifecycle owner with controlled child close events",()=>{
 it("admits production directory topology and settles a numeric closed Git config miss",async()=>{
  const f=await fixture();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});child.entered=entered;
  const work=f.command(["config","--local","--no-includes","--get-regexp","^credential\\."]);
  await Promise.race([ready,work.then(()=>{throw new Error("Git command closed before the controlled child boundary");})]);
  const pending=child.pending!,config=pending.args.join(" ");
  for(const path of f.protectedPaths)expect(config).toContain(`${JSON.stringify(path)}="none"`);
  expect(config).toContain(`${JSON.stringify(f.reference)}="read"`);
  expect(config).toContain(`${JSON.stringify(pending.env.TMPDIR)}="write"`);
  expect(pending.env.HOME).not.toBe(pending.env.TMPDIR);
  pending.callback({code:1},"");pending.emit("close",1,null);
  expect(await work).toEqual({code:1,stdout:"",stderr:""});
  await f.scope.retire();expect(await readdir(f.runtime)).toEqual([]);
 });
 it.each(["controller","credential","instruction"] as const)("still refuses operation scratch beneath protected %s before child launch",async protectedRoot=>{
  const f=await fixture(protectedRoot);
  await expect(f.command()).rejects.toThrow("Workspace access overlaps protected runtime or credential paths");
  expect(child.pending).toBeNull();expect(await readdir(f.runtime)).toHaveLength(1);
  await f.scope.retire();
 });
 it("uses current native scoped permissions and joins close after the callback",async()=>{
  const f=await fixture();let done=false;const work=f.command().then(value=>{done=true;return value;});
  while(!child.pending)await new Promise(resolve=>setTimeout(resolve,1));
  const pending=child.pending!;expect(pending.args.join(" ")).toContain(f.workspace);expect(pending.args.join(" ")).toContain(f.reference);
  expect(pending.args).toContain("sandbox");expect(pending.args).toContain("/usr/bin/git");
  pending.callback(null,"known result");await Promise.resolve();expect(done).toBe(false);pending.emit("close",0,null);
  expect(await work).toEqual({code:0,stdout:"known result",stderr:""});await f.scope.retire();expect((await readdir(f.runtime)).length).toBe(0);
 });
 it("unobserved close retains private operation data and blocks successor settlement",async()=>{
  const f=await fixture();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});child.entered=entered;
  const work=f.command();await ready;vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});child.pending!.callback({code:"ABORT_ERR"},"");
  await vi.advanceTimersByTimeAsync(5001);expect((await work).code).toBeNull();
  await expect(f.scope.retire()).rejects.toThrow("native_git_launcher_close_unobserved");expect((await readdir(f.runtime)).length).toBe(1);
 });
 it("an observed aborted launcher remains an explicit unknown outcome fence",async()=>{
  const f=await fixture();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});child.entered=entered;
  const work=f.command();await ready;child.pending!.callback({code:"ABORT_ERR"},"");child.pending!.emit("close",null,"SIGTERM");expect((await work).code).toBeNull();
  await expect(f.scope.retire()).rejects.toThrow("native_git_command_settlement_unknown");expect((await readdir(f.runtime)).length).toBe(1);
 });
 it("no callback after command timeout cannot hang native Stop or successor settlement",async()=>{
  const f=await fixture();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});child.entered=entered;
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});const work=f.command();await ready;
  await vi.advanceTimersByTimeAsync(6001);expect((await work).code).toBeNull();await expect(f.scope.retire()).rejects.toThrow("native_git_launcher_close_unobserved");expect((await readdir(f.runtime)).length).toBe(1);
 });
 it("retained warm Stop resolves the current native epoch and joins its cleanup",async()=>{
  const first={revoke:vi.fn(),settle:vi.fn(async()=>{})};let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const second={revoke:vi.fn(),settle:vi.fn(()=>gate)};let current=first;
  const nativeCancel=vi.fn(()=>({cleanup:Promise.resolve(),fixture:"native synchronous commit"}));const nativeClose=vi.fn(async()=>{});
  const session={cancel:nativeCancel,close:nativeClose,interrupt:vi.fn(async()=>{}),detachControllerForRestart:vi.fn(async()=>{})} as unknown as NativeSession;
  bindNativeControllerGitSession(session,()=>current);current=second;bindNativeControllerGitSession(session,()=>current);
  const cancellation=session.cancel!({reason:"Synthetic Stop"} as never);expect(second.revoke).toHaveBeenCalledTimes(1);expect(first.revoke).not.toHaveBeenCalled();expect(nativeCancel).toHaveBeenCalledTimes(1);
  let settled=false;const cleanup=cancellation.cleanup.then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);release();await cleanup;expect(settled).toBe(true);
  await session.detachControllerForRestart!();expect(second.revoke).toHaveBeenCalledTimes(2);expect(first.revoke).not.toHaveBeenCalled();
 });
});
