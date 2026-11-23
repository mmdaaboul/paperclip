import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createIsolatedCodexAppServerArgs, codexExecutableReadOnlyRoots, CODEX_SKILLLESS_PERMISSION_PROFILE } from "./codex-security-config.js";
import { resolvePinnedCodexCommand } from "./codex-command.js";
import { resolveCodexWorkspaceAccessPolicy } from "./workspace-access-policy.js";
import { resolveReviewerGitMetadata } from "./reviewer-git-metadata.js";
import type { WorkspaceAccessPolicy } from "../../contracts/workspace-access.js";
const run=(stage:string,binary:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,maxBuffer=1024*1024)=>new Promise<string>((resolve,reject)=>execFile(binary,args,{cwd,env,encoding:'utf8',timeout:15000,maxBuffer},(error,stdout,stderr)=>{
 if(!error){resolve(stdout);return;}
 const code=typeof error.code==='number'?String(error.code):/^[A-Z_]+$/.test(String(error.code))?String(error.code):'unknown';
 const signal=/^SIG[A-Z0-9]+$/.test(String(error.signal))?String(error.signal):'none';
 const classification=code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'output_limit':error.killed?'terminated':/permission denied|operation not permitted/i.test(stderr)?'access_denied':/not a git repository/i.test(stderr)?'repository_unavailable':'command_failed';
 reject(new Error(`Reviewer native candidate inspection failed: stage=${stage}; class=${classification}; code=${code}; signal=${signal}; killed=${error.killed===true}; stderrSha256=${createHash('sha256').update(stderr).digest('hex')}`));
}));
/** Separate readonly inspector, never a push runner. No command/model/env
 * override or credentials are accepted. Unsupported linked metadata refuses. */
export async function inspectReadonlyReviewerCandidate(input:{policy:WorkspaceAccessPolicy;privateRuntimeDirectory:string;protectedPaths:string[]}):Promise<{headSha:string;clean:true}>{
 if(!input.policy.readOnlyWorkspace||!input.policy.scratchDirectory||!['darwin','linux'].includes(process.platform))throw new Error('Reviewer readonly native inspector is unavailable');
 const policy=resolveCodexWorkspaceAccessPolicy(input.policy,input.protectedPaths);
 if(!isAbsolute(input.privateRuntimeDirectory))throw new Error('Reviewer inspector requires a server private runtime directory');
 await mkdir(input.privateRuntimeDirectory,{recursive:true,mode:0o700});const runtime=await lstat(input.privateRuntimeDirectory);
 if(!runtime.isDirectory()||runtime.isSymbolicLink()||!process.getuid||runtime.uid!==process.getuid()||(runtime.mode&0o077)!==0)throw new Error('Reviewer private runtime ownership changed');
 const home=await mkdtemp(join(input.privateRuntimeDirectory,'readonly-inspect-'));let completed=false;
 try{
  const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',HOME:home,CODEX_HOME:home,TMPDIR:policy.scratchDirectory,LANG:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'};
  const git=await realpath(process.platform==='darwin'?(await run('resolve_git','/usr/bin/xcrun',['--find','git'],home,{PATH:'/usr/bin:/bin'},4096)).trim():'/usr/bin/git');
  if(!isAbsolute(git)||!(await stat(git)).isFile())throw new Error('Native Git executable unavailable');await access(git,constants.X_OK);
  const gitExecPath=(await run('git_exec_path',git,['--exec-path'],home,env,4096)).trim();if(!isAbsolute(gitExecPath)||gitExecPath==='/')throw new Error('Native Git resource path unavailable');
  const codex=resolvePinnedCodexCommand(import.meta.url,{PATH:''},home);if(!isAbsolute(codex))throw new Error('Native Codex sandbox unavailable');
  const metadata=await resolveReviewerGitMetadata(policy.workspaceDirectory,policy.scratchDirectory!,input.protectedPaths);
  const native=createIsolatedCodexAppServerArgs(env,[...codexExecutableReadOnlyRoots(env,codex),git,gitExecPath,...metadata.readOnlyRoots],undefined,input.protectedPaths,false,policy);
  const config:string[]=[];for(let i=0;i<native.length-1;i++)if(native[i]==='-c'&&native[i+1].startsWith('permissions.'))config.push('-c',native[++i]);
  const read=async(stage:string,args:string[])=>{await metadata.assertCurrent();const result=await run(stage,codex.endsWith('.js')?process.execPath:codex,[...(codex.endsWith('.js')?[codex]:[]),'sandbox',...config,'-P',CODEX_SKILLLESS_PERMISSION_PROFILE,'-C',policy.workspaceDirectory,'--',git,'--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false',...args],policy.workspaceDirectory,env);await metadata.assertCurrent();return result;};
  const headSha=(await read('git_head',['rev-parse','--verify','HEAD'])).trim();if(!/^[a-f0-9]{40}$/.test(headSha))throw new Error('Unsupported native Reviewer object format');
  if((await read('git_status',['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=all'])).trim())throw new Error('Reviewer candidate has uncommitted or untracked changes');
  completed=true;
  return {headSha,clean:true};
 }finally{if(completed)await rm(home,{recursive:true,force:true});}
}
