import { join,dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp,mkdir,realpath,rm,writeFile,symlink,unlink } from "node:fs/promises";
import { afterEach,expect,it,vi } from "vitest";
const state=vi.hoisted(()=>({own:null as string|null}));
vi.mock("node:url",async original=>{const actual=await original<typeof import("node:url")>();return {...actual,fileURLToPath:(value:URL|string)=>state.own && String(value).endsWith("/native-controller-installation.ts")?state.own:actual.fileURLToPath(value)};});
import { nativeControllerInstallationIdentity } from "./native-controller-installation.js";
const roots:string[]=[];
afterEach(async()=>{state.own=null;vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
// Actual read-only format/path/file-identity checks. Loaded module position is
// a controlled seam; these are NOT an emitted native install or host proof.
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),"controller-install-")));roots.push(root);const home=join(root,"paperclip"),store=join(home,"cli"),sha="a".repeat(40),payload=join(store,"installs","git",sha.slice(0,12)),server=join(payload,"node_modules","@paperclipai","server");
 const own=join(server,"dist/services/native-runtime/native-controller-installation.js");await mkdir(dirname(own),{recursive:true,mode:0o700});
 await writeFile(own,"Synthetic emitted module identity bytes; not executed\n",{mode:0o600});await writeFile(join(server,"package.json"),JSON.stringify({name:"@paperclipai/server"}),{mode:0o600});await writeFile(join(server,"dist/build-info.json"),JSON.stringify({commit:sha}),{mode:0o600});
 const manifest={schemaVersion:1,source:"git",version:"2026.1117.0",channel:"pinned",payloadPath:payload,repo:"owner/paperclip",sha,installedAt:new Date().toISOString(),previous:[]};
 await writeFile(join(store,"install.json"),JSON.stringify(manifest),{mode:0o600});await writeFile(join(store,".managed-install"),"paperclipai managed install store v1\n",{mode:0o600});await symlink(payload,join(store,"current"));vi.stubEnv("PAPERCLIP_HOME",home);state.own=own;
 return {root,home,store,server,own,manifest};
}
it("joins native manifest/marker/current/loaded-server/build identities without mutation",async()=>{const f=await fixture();const first=await nativeControllerInstallationIdentity();expect(first).toMatch(/^[a-f0-9]{64}$/);expect(await nativeControllerInstallationIdentity()).toBe(first);});
it.each(["source","schema","commit","marker"])("permanently refuses incompatible native installation %s",async change=>{const f=await fixture();if(change==="source")await writeFile(join(f.store,"install.json"),JSON.stringify({...f.manifest,source:"npm"}));if(change==="schema")await writeFile(join(f.store,"install.json"),JSON.stringify({...f.manifest,schemaVersion:99}));if(change==="commit")await writeFile(join(f.server,"dist/build-info.json"),JSON.stringify({commit:"b".repeat(40)}));if(change==="marker")await writeFile(join(f.store,".managed-install"),"unmanaged");await expect(nativeControllerInstallationIdentity()).rejects.toThrow("native_github_installation_identity_incompatible");});
it("refuses a manifest symlink and preserves both original evidence files",async()=>{const f=await fixture();const path=join(f.store,"install.json"),other=join(f.root,"other.json");await writeFile(other,JSON.stringify(f.manifest),{mode:0o600});await unlink(path);await symlink(other,path);await expect(nativeControllerInstallationIdentity()).rejects.toThrow("native_github_installation_identity_incompatible");});
it("ordinary source/dev module position remains unavailable by a permanent named code",async()=>{state.own=null;await expect(nativeControllerInstallationIdentity()).rejects.toThrow("native_github_installation_identity_incompatible");});
