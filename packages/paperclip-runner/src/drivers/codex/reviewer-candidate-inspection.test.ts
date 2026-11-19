import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectReadonlyReviewerCandidate } from "./reviewer-candidate-inspection.js";

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
  return {candidate,scratch,runtime,git,policy:{workspaceDirectory:candidate,referenceDirectories:[],readOnlyWorkspace:true,scratchDirectory:scratch}};
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
 it("refuses an unrestricted caller policy before any inspector execution",async()=>{
  const f=await fixture();await expect(inspectReadonlyReviewerCandidate({policy:{...f.policy,readOnlyWorkspace:false},privateRuntimeDirectory:f.runtime,protectedPaths:[]})).rejects.toThrow("unavailable");
 });
});
