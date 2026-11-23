import { execFileSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectReadonlyReviewerCandidate } from "./reviewer-candidate-inspection.js";
import { resolveReviewerGitMetadata } from "./reviewer-git-metadata.js";
import { createIsolatedCodexAppServerArgs, codexExecutableReadOnlyRoots, CODEX_SKILLLESS_PERMISSION_PROFILE } from "./codex-security-config.js";
import { resolvePinnedCodexCommand } from "./codex-command.js";

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const supported=["darwin","linux"].includes(process.platform);
describe("actual offline native Reviewer Git inspector",()=>{
 async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),"reviewer-git-")));roots.push(root);
  const candidate=join(root,"candidate"),scratch=join(root,"scratch"),runtime=join(root,"runtime"),home=join(root,"git-home");
  for(const directory of [candidate,scratch,runtime,home])await mkdir(directory,{mode:0o700});
  const env={PATH:"/usr/bin:/bin",HOME:home,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0"};
  const git=(...args:string[])=>execFileSync("/usr/bin/git",args,{cwd:candidate,env,encoding:"utf8"});
  git("init","-q");await writeFile(join(candidate,"original.txt"),"Retained candidate\n");git("add","original.txt");git("-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","-qm","fixture");
  return {candidate,scratch,runtime,home,git,policy:{workspaceDirectory:candidate,referenceDirectories:[],readOnlyWorkspace:true,scratchDirectory:scratch}};
 }
 it.runIf(supported)("reads actual HEAD and cleanliness with unchanged Git/candidate bytes",async()=>{
  const f=await fixture(),head=f.git("rev-parse","HEAD").trim(),index=await readFile(join(f.candidate,".git/index")),config=await readFile(join(f.candidate,".git/config"));
  expect(await inspectReadonlyReviewerCandidate({policy:f.policy,privateRuntimeDirectory:f.runtime,protectedPaths:[]})).toEqual({headSha:head,clean:true});
  expect(await readFile(join(f.candidate,".git/index"))).toEqual(index);expect(await readFile(join(f.candidate,".git/config"))).toEqual(config);expect(f.git("status","--porcelain")).toBe("");
 });
 it.runIf(supported)("refuses dirty candidates without resetting or modifying them",async()=>{
  const f=await fixture();await writeFile(join(f.candidate,"original.txt"),"Unsaved local work\n");
  await expect(inspectReadonlyReviewerCandidate({policy:f.policy,privateRuntimeDirectory:f.runtime,protectedPaths:[]})).rejects.toThrow("uncommitted or untracked changes");
  expect(await readFile(join(f.candidate,"original.txt"),"utf8")).toBe("Unsaved local work\n");
 });
 it.runIf(supported)("reads a real nested linked worktree without changing shared Git metadata",async()=>{
  const f=await fixture(),linked=join(f.candidate,".paperclip/worktrees/review");
  f.git("worktree","add","-qb","review",linked);
  const head=f.git("rev-parse","HEAD").trim(),index=await readFile(join(f.candidate,".git/worktrees/review/index")),config=await readFile(join(f.candidate,".git/config"));
  expect(await inspectReadonlyReviewerCandidate({policy:{...f.policy,workspaceDirectory:linked},privateRuntimeDirectory:f.runtime,protectedPaths:[]})).toEqual({headSha:head,clean:true});
  expect(await readFile(join(f.candidate,".git/worktrees/review/index"))).toEqual(index);
  expect(await readFile(join(f.candidate,".git/config"))).toEqual(config);
 });
 async function linkedFixture(){
  const f=await fixture(),workspace=join(f.candidate,".paperclip/worktrees/review");
  f.git("worktree","add","-qb","review",workspace);
  return {...f,workspace,common:join(f.candidate,".git"),gitDir:join(f.candidate,".git/worktrees/review")};
 }
 it.runIf(supported)("refuses a dirty linked candidate and preserves the edit",async()=>{
  const f=await linkedFixture();await writeFile(join(f.workspace,"original.txt"),"Retain this edit\n");
  await expect(inspectReadonlyReviewerCandidate({policy:{...f.policy,workspaceDirectory:f.workspace},privateRuntimeDirectory:f.runtime,protectedPaths:[]})).rejects.toThrow("uncommitted or untracked changes");
  expect(await readFile(join(f.workspace,"original.txt"),"utf8")).toBe("Retain this edit\n");
 });
 it.runIf(supported)("native sandbox reads linked metadata but denies metadata, candidate, reference and protected writes",async()=>{
  const f=await linkedFixture(),reference=join(f.runtime,"reference"),privateHome=join(f.runtime,"private-home");
  await mkdir(reference);await mkdir(privateHome);await writeFile(join(reference,"reference.txt"),"Retain reference\n");
  const grant=await resolveReviewerGitMetadata(f.workspace,f.scratch,[f.home]),codex=resolvePinnedCodexCommand(import.meta.url,{PATH:""},privateHome);
  const env={PATH:"/usr/bin:/bin",HOME:privateHome,CODEX_HOME:privateHome,TMPDIR:f.scratch,LANG:"C"};
  const args=createIsolatedCodexAppServerArgs(env,[...codexExecutableReadOnlyRoots(env,codex),"/bin/sh",...grant.readOnlyRoots],undefined,[f.home],false,{...f.policy,workspaceDirectory:f.workspace,referenceDirectories:[reference]});
  const config:string[]=[];for(let i=0;i<args.length-1;i++)if(args[i]==="-c"&&args[i+1]!.startsWith("permissions."))config.push("-c",args[++i]!);
  const script='test -r "$1/HEAD" || exit 21; for p in "$1/forbidden" "$2/original.txt" "$3/reference.txt" "$5/forbidden"; do if (printf bad > "$p") 2>/dev/null; then exit 22; fi; done; printf allowed > "$4/allowed"';
  execFileSync(codex.endsWith(".js")?process.execPath:codex,[...(codex.endsWith(".js")?[codex]:[]),"sandbox",...config,"-P",CODEX_SKILLLESS_PERMISSION_PROFILE,"-C",f.workspace,"--","/bin/sh","-c",script,"inspector-denial",f.common,f.workspace,reference,f.scratch,f.home],{cwd:f.workspace,env,timeout:15000,maxBuffer:4096});
  expect(await readFile(join(f.scratch,"allowed"),"utf8")).toBe("allowed");
  expect(await readFile(join(f.workspace,"original.txt"),"utf8")).toBe("Retained candidate\n");
  expect(await readFile(join(reference,"reference.txt"),"utf8")).toBe("Retain reference\n");
  await grant.assertCurrent();
 });
 it("returns only the verified metadata read root and detects a changed reciprocal pointer",async()=>{
  const f=await linkedFixture(),grant=await resolveReviewerGitMetadata(f.workspace,f.scratch,[]);
  expect(grant.readOnlyRoots).toEqual([f.common]);
  await writeFile(join(f.gitDir,"gitdir"),join(f.candidate,"foreign/.git")+"\n");
  await expect(grant.assertCurrent()).rejects.toThrow("unsupported or changed");
 });
 it("detects replacement of the admitted Git directory",async()=>{
  const f=await linkedFixture(),grant=await resolveReviewerGitMetadata(f.workspace,f.scratch,[]);
  await rename(f.gitDir,f.gitDir+"-retained");await mkdir(f.gitDir);
  await expect(grant.assertCurrent()).rejects.toThrow("unsupported or changed");
 });
 it.each(["foreign-pointer","wrong-common","wrong-backlink","symlink-pointer","hardlink-pointer","hardlink-metadata","protected-common","scratch-overlap"])("refuses %s without broadening the read grant",async(kind)=>{
  const f=await linkedFixture();let protectedPaths:string[]=[],scratch=f.scratch;
  if(kind==="foreign-pointer")await writeFile(join(f.workspace,".git"),"gitdir: "+join(f.runtime,"foreign")+"\n");
  if(kind==="wrong-common")await writeFile(join(f.gitDir,"commondir"),f.runtime+"\n");
  if(kind==="wrong-backlink")await writeFile(join(f.gitDir,"gitdir"),join(f.candidate,"unrelated/.git")+"\n");
  if(kind==="symlink-pointer"){await unlink(join(f.gitDir,"commondir"));await writeFile(join(f.runtime,"pointer"),"../..\n");await symlink(join(f.runtime,"pointer"),join(f.gitDir,"commondir"));}
  if(kind==="hardlink-pointer")await link(join(f.workspace,".git"),join(f.runtime,"alias"));
  if(kind==="hardlink-metadata")await link(join(f.common,"config"),join(f.runtime,"alias"));
  if(kind==="protected-common")protectedPaths=[f.common];
  if(kind==="scratch-overlap")scratch=join(f.common,"worktrees");
  await expect(resolveReviewerGitMetadata(f.workspace,scratch,protectedPaths)).rejects.toThrow(/unsupported or changed|hardlinked/);
 });
 it("refuses oversized control files before reading or granting them",async()=>{
  const f=await linkedFixture();await writeFile(join(f.gitDir,"commondir"),"x".repeat(4097));
  await expect(resolveReviewerGitMetadata(f.workspace,f.scratch,[])).rejects.toThrow("unsupported or changed");
 });
 it.runIf(supported)("refuses a real FIFO control file before any candidate inspection",async()=>{
  const f=await linkedFixture();await unlink(join(f.gitDir,"commondir"));execFileSync("/usr/bin/mkfifo",[join(f.gitDir,"commondir")]);
  await expect(resolveReviewerGitMetadata(f.workspace,f.scratch,[])).rejects.toThrow("unsupported or changed");
 });
 it("refuses external sibling worktrees instead of inferring an unrelated repository grant",async()=>{
  const f=await fixture(),outside=join(f.runtime,"external-review");f.git("worktree","add","-qb","external-review",outside);
  await expect(resolveReviewerGitMetadata(outside,f.scratch,[])).rejects.toThrow("unsupported or changed");
 });
 it.runIf(supported)("retains safe command diagnostics without exposing stderr or filesystem paths",async()=>{
  const f=await linkedFixture();await writeFile(join(f.gitDir,"HEAD"),"ref: refs/heads/ABSENT-PRIVATE-CANARY\n");
  let error:Error|undefined;try{await inspectReadonlyReviewerCandidate({policy:{...f.policy,workspaceDirectory:f.workspace},privateRuntimeDirectory:f.runtime,protectedPaths:[]});}catch(e){error=e as Error;}
  expect(error?.message).toMatch(/stage=git_head; class=command_failed; code=128; signal=none; killed=false; stderrSha256=[a-f0-9]{64}/);
  expect(error?.message).not.toContain(f.candidate);expect(error?.message).not.toContain("ABSENT-PRIVATE-CANARY");
 });
 it("refuses an unrestricted caller policy before any inspector execution",async()=>{
  const f=await fixture();await expect(inspectReadonlyReviewerCandidate({policy:{...f.policy,readOnlyWorkspace:false},privateRuntimeDirectory:f.runtime,protectedPaths:[]})).rejects.toThrow("unavailable");
 });
});
