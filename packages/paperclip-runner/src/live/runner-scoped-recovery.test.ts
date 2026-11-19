import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createRunnerProviderLaunch, runnerProviderLaunchRequirements } from "./runner-provider-launch.js";
import { createCapabilityRunnerdCodexTransport, type CapabilityRunnerdCodexTransportOptions } from "./runnerd-codex-transport.js";

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
describe("scoped native local recovery validates complete trusted launch before adoption",()=>{
 async function fixture(mode:string){
  const root=await realpath(await mkdtemp(join(tmpdir(),"scoped-recovery-")));roots.push(root);
  const candidate=join(root,"candidate"),scratch=join(root,"scratch"),codexHome=join(root,"codex-home");
  for(const path of [candidate,scratch,codexHome])await mkdir(path,{mode:0o700});
  const identity={runnerInstanceId:"fixture-runner",environmentLeaseId:"fixture-lease",runId:"fixture-run",normalizedSessionId:"fixture-session",turnId:"fixture-turn",itemId:"fixture-item"};
  const workspaceAccess={workspaceDirectory:candidate,referenceDirectories:[],readOnlyWorkspace:true,scratchDirectory:scratch};
  const runnerBinary=join(root,"unexecuted-runner"),artifactBytes="unexecuted native fixture artifact";
  await writeFile(runnerBinary,artifactBytes,{mode:0o700});
  const runnerArtifact={version:"fixture",digest:`sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`};
  const registration=vi.fn(async()=>{throw Error("fixture_validated_before_runner_dispatch");}),launch=vi.fn(()=>{throw Error("No process may start");});
  const options:CapabilityRunnerdCodexTransportOptions={provider:"codex",stateDirectory:root,sourceCodexHome:"",prpIdentity:identity,
   runnerBinary,runnerArtifact,codexCommand:process.env.PAPERCLIP_TEST_CODEX_BINARY!,environment:{PATH:"/usr/bin:/bin",TMPDIR:scratch},
   workspaceAccess,resumeWorkingDirectory:candidate,controlPlaneRegistration:registration,runnerProcessLauncher:launch};
  const requirements=runnerProviderLaunchRequirements(options,identity,{model:"selected",approvalPolicy:"never",config:{include_collaboration_mode_instructions:false}},null,"Assigned review");
  const provider=createRunnerProviderLaunch(requirements,{options,root,cwd:candidate,codexHome,codexCommand:options.codexCommand,
   providerNodeCommand:process.execPath,opencodeProxyPath:"",acpxSidecarPath:""});
  const addRead=(args:unknown)=> (args as string[]).map(arg=>arg.startsWith("permissions.paperclip-runner-workspace-only.filesystem=")?arg.slice(0,-1)+',"/"="read"}':arg);
  const template:Record<string,unknown>={provider};
  if(mode==="template-read")provider.args=addRead(provider.args);
  if(mode==="override-read")template.runtimeLaunchArgs=addRead(provider.args);
  if(mode==="command")provider.command="/usr/bin/true";
  if(mode==="credential-read")provider.args=(provider.args as string[]).map(arg=>arg.replace(`${JSON.stringify(codexHome)}="none"`,`${JSON.stringify(codexHome)}="read"`));
  if(mode==="fresh")return {root,candidate,options,registration,launch,original:Buffer.alloc(0)};
  const core=new DurablePrpControlPlane({stateDirectory:join(root,"control-plane"),identity,expectedRunnerVersion:runnerArtifact.version,expectedRunnerDigest:runnerArtifact.digest});
  core.persistRunAttachTemplate(template);await core.stop();
  await mkdir(join(root,"runner"),{mode:0o700});await writeFile(join(root,"runner/runner-state.json"),JSON.stringify({schema:"paperclip.runner.durable.state.v1",...identity,lifecycle:"suspended"}),{mode:0o600});
  if(mode.startsWith("provider-state-"))await writeFile(join(root,"runner/codex-provider-state.json"),JSON.stringify({schema:"paperclip.runner.codex-provider-state.v1",config:{provider:"codex",command:provider.command,args:mode==="provider-state-read"?addRead(provider.args):provider.args,cwd:candidate},lifecycle:"prepared"}),{mode:0o600});
  const original=await readFile(join(root,"control-plane/control-plane-state.json"));
  return {root,candidate,options,registration,launch,original};
 }
 it.each(["template-read","override-read","credential-read","command","provider-state-read"])("refuses %s without registering, launching or replacing retained state",async mode=>{
  const f=await fixture(mode),{transport}=createCapabilityRunnerdCodexTransport(f.options);
  try{
   await expect(transport.request("thread/read",{})).rejects.toThrow("workspace_policy_saved_launch_changed");
   expect(f.registration).not.toHaveBeenCalled();expect(f.launch).not.toHaveBeenCalled();
   expect(await readFile(join(f.root,"control-plane/control-plane-state.json"))).toEqual(f.original);
  }finally{await transport.close();}
 });
 it.each(["exact","provider-state-exact"])("accepts exact native derivation up to the pre-dispatch fence: %s",async mode=>{
  const f=await fixture(mode),{transport}=createCapabilityRunnerdCodexTransport(f.options);
  try{await expect(transport.request("thread/read",{})).rejects.toThrow("fixture_validated_before_runner_dispatch");expect(f.registration).toHaveBeenCalledOnce();expect(f.launch).not.toHaveBeenCalled();}finally{await transport.close();}
 });
 it("first scoped launch still reaches the native pre-dispatch owner",async()=>{
  const f=await fixture("fresh"),{transport}=createCapabilityRunnerdCodexTransport(f.options);
  try{await expect(transport.request("thread/start",{cwd:f.candidate,model:"selected",dynamicTools:[]})).rejects.toThrow("fixture_validated_before_runner_dispatch");expect(f.registration).toHaveBeenCalledOnce();expect(f.launch).not.toHaveBeenCalled();}finally{await transport.close();}
 });

 it.each(["prepareLaunch","recoveryLaunch","runnerFilesystemRoot","readRunnerState"])("does not silently route scoped local policy through unsupported %s",async key=>{
  const f=await fixture("fresh"),value=key==="runnerFilesystemRoot"?"/remote":key==="recoveryLaunch"?{}:vi.fn();
  expect(()=>createCapabilityRunnerdCodexTransport({...f.options,[key]:value})).toThrow("runner_workspace_access_launch_unsupported");
 });

});
