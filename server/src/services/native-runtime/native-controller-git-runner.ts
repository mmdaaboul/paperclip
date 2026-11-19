import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { NativeProviderStateIncompatibleError, createIsolatedCodexAppServerArgs, CODEX_SKILLLESS_PERMISSION_PROFILE, codexExecutableReadOnlyRoots, type WorkspaceAccessSnapshot } from "../../vendor/paperclip-runner/index.js";
import type { AttributedGitCommandRunner } from "../github-attributed-push-git.js";
import type { createNativeAttributedGitScope } from "./native-attributed-git-scope.js";

/** Native Codex permission builder + ordinary Node child lifecycle, not the
 * stronger SDK kernel/custody owner. Result means captured launcher closed.
 * Errors without a numeric exit retain scratch and retire the run epoch; this
 * adapter never produces descendant-empty or physical-settlement evidence. */
export async function createNativeControllerGitRunner(input: {
  scope: ReturnType<typeof createNativeAttributedGitScope>; workspace: WorkspaceAccessSnapshot;
  runtimeDirectory: string; gitBinary: string; codexCommand: string; protectedPaths: string[];
  filesystemEnvironment: Pick<NodeJS.ProcessEnv,"PAPERCLIP_GIT_METADATA_ROOTS"|"PAPERCLIP_RUNNER_NETWORK_ACCESS"|"PAPERCLIP_RUNNER_NETWORK_ROOTS">;
  assertCurrent: () => Promise<void>;
}): Promise<AttributedGitCommandRunner> {
  if (input.workspace.policy.readOnlyWorkspace || ![input.runtimeDirectory,input.gitBinary,input.codexCommand,...input.protectedPaths].every(isAbsolute)) throw new Error("controller_git_runtime_paths_unsupported");
  const trust = async (name:string) => { const file=await realpath(name); for(let path=file;;path=dirname(path)){const s=await lstat(path);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)||(path===file?!s.isFile()||!(s.mode&0o111):!s.isDirectory()))throw new Error("controller_git_executable_untrusted");if(path==="/")break;}return file; };
  const git=await trust(input.gitBinary);
  // Codex may be a native installed dependency owned by the service account;
  // the native pinned resolver selects it, never PATH or tool arguments.
  if (await realpath(input.codexCommand) !== input.codexCommand) throw new Error("controller_codex_path_alias");
  const codexStat=await lstat(input.codexCommand);if(!codexStat.isFile()||(codexStat.mode&0o022)||![0,process.getuid?.()].includes(codexStat.uid))throw new Error("controller_codex_untrusted");
  await mkdir(input.runtimeDirectory,{recursive:true,mode:0o700});
  const runtime=await lstat(input.runtimeDirectory);if(!runtime.isDirectory()||runtime.isSymbolicLink()||runtime.uid!==process.getuid?.()||(runtime.mode&0o077)||await realpath(input.runtimeDirectory)!==input.runtimeDirectory)throw new Error("controller_git_private_runtime_required");
  const metadata=await new Promise<string>((resolve,reject)=>execFile(git,["--exec-path"],{cwd:input.runtimeDirectory,env:{PATH:"/usr/bin:/bin",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_SYSTEM:"/dev/null"},encoding:"utf8",timeout:5000,maxBuffer:4096,signal:input.scope.signal},(e,out)=>e?reject(new Error("controller_git_metadata_unavailable")):resolve(out.trim())));
  if(!isAbsolute(metadata)||metadata==="/"||/[\x00-\x1f\x7f]/.test(metadata))throw new Error("controller_git_resource_unavailable");
  return command=>input.scope.track(async()=>{
    await input.assertCurrent();input.scope.signal.throwIfAborted();
    if(command.binary!==git||command.cwd!==input.workspace.policy.workspaceDirectory||await realpath(command.cwd)!==command.cwd)throw new Error("controller_git_command_scope_changed");
    const root=await mkdtemp(join(input.runtimeDirectory,"operation-")),home=join(root,"home"),scratch=join(root,"tmp");
    await mkdir(home,{mode:0o700});await mkdir(scratch,{mode:0o700});
    let normalClose=false;
    try {
      const env:NodeJS.ProcessEnv={...command.env,...input.filesystemEnvironment,PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,HOME:home,CODEX_HOME:home,TMPDIR:scratch,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_NO_LAZY_FETCH:"1",GIT_TERMINAL_PROMPT:"0"};
      const native=createIsolatedCodexAppServerArgs(env,[...codexExecutableReadOnlyRoots(env,input.codexCommand),git,metadata],undefined,input.protectedPaths, true,{...input.workspace.policy,scratchDirectory:scratch});
      const args:string[]=[];for(let n=0;n<native.length-1;n++)if(native[n]==="-c"&&native[n+1]!.startsWith("permissions."))args.push("-c",native[++n]!);
      args.push("-P",CODEX_SKILLLESS_PERMISSION_PROFILE,"-C",command.cwd,"--",git,...command.args);
      await input.assertCurrent();input.scope.signal.throwIfAborted();
      const binary=input.codexCommand.endsWith(".js")?process.execPath:input.codexCommand;
      const argv=input.codexCommand.endsWith(".js")?[input.codexCommand,"sandbox",...args]:["sandbox",...args];
      const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve)=>{
        let closed=false,outcome:{code:number|null;stdout:string}|undefined,deadline:ReturnType<typeof setTimeout>|undefined,done=false;
        const absoluteCloseAt=Date.now()+Math.min(command.timeoutMs,60000)+5000;
        const detach=()=>{if(deadline)clearTimeout(deadline);input.scope.signal.removeEventListener("abort",onAbort);};
        const arm=(ms:number)=>{if(done)return;if(deadline)clearTimeout(deadline);deadline=setTimeout(()=>{
          if(done)return;done=true;detach();input.scope.failSettlement(new NativeProviderStateIncompatibleError("native_git_launcher_close_unobserved"));resolve({code:null,stdout:"",stderr:""});
        },Math.max(0,Math.min(ms,absoluteCloseAt-Date.now())));};
        const onAbort=()=>arm(5000);
        const finish=()=>{
          if(done || !outcome || !closed)return;done=true;detach();
          normalClose=outcome.code!==null && !input.scope.signal.aborted;
          resolve({code:normalClose?outcome.code:null,stdout:normalClose?outcome.stdout:"",stderr:""});
        };
        input.scope.signal.addEventListener("abort",onAbort,{once:true});
        const child=execFile(binary,argv,{cwd:command.cwd,env,encoding:"utf8",timeout:Math.min(command.timeoutMs,60000),maxBuffer:1024*1024,signal:input.scope.signal},(error,stdout)=>{
          outcome={code:error?(typeof error.code==="number"?error.code:null):0,stdout};finish();if(!done)arm(5000);
        });
        child.once("close",()=>{closed=true;finish();});
        // execFile's timeout alone waits forever if SIGTERM is ignored. Bound
        // the observed closure independently; unknown ownership is fenced,
        // never treated as a successful kill or deleted scratch.
        if(!deadline)arm(Math.min(command.timeoutMs,60000)+5000);
      });
      if(!normalClose)input.scope.failSettlement(new NativeProviderStateIncompatibleError("native_git_command_settlement_unknown"));
      return result;
    } finally { if(normalClose)await rm(root,{recursive:true,force:true}); }
  });
}
