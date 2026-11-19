import { NativeProviderStateIncompatibleError } from "../../vendor/paperclip-runner/index.js";
import { constants } from "node:fs";
import { open, lstat, realpath, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaperclipInstanceRoot, resolvePaperclipHomeDir } from "../../home-paths.js";

/** Native current/source identity DATA, not SDK qualification or mint authority.
 * The module location selects the loaded server; caller paths cannot select it. */
async function readNativeControllerInstallationIdentity():Promise<string>{
 const own=fileURLToPath(import.meta.url),root=resolve(dirname(own),"../../..");
 if(own!==join(root,"dist/services/native-runtime/native-controller-installation.js")||await realpath(own)!==own)throw new Error("controller_git_emitted_server_required");
 const read=async(file:string,max:number)=>{
  for(let at=dirname(file);;at=dirname(at)){const s=await lstat(at);if(!s.isDirectory()||s.isSymbolicLink()||![0,process.getuid?.()].includes(s.uid)||(s.mode&0o7022)||await realpath(at)!==at)throw new Error("controller_git_installation_untrusted");if(at===dirname(at))break;}
  const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await h.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||![0n,BigInt(process.getuid!())].includes(before.uid)||before.size>BigInt(max)||(before.mode&0o7022n))throw new Error("controller_git_installation_metadata");const b=Buffer.alloc(Number(before.size));let off=0;while(off<b.length){const r=await h.read(b,off,b.length-off,off);if(!r.bytesRead)throw new Error("controller_git_installation_changed");off+=r.bytesRead;}for(const after of [await h.stat({bigint:true}),await lstat(file,{bigint:true})])if(["dev","ino","uid","gid","mode","nlink","size","mtimeNs","ctimeNs"].some(k=>before[k as keyof typeof before]!==after[k as keyof typeof after]))throw new Error("controller_git_installation_changed");return b;}finally{await h.close();}
 };
 // Read only the released native install-store data contract. CLI remains the
 // sole mutation/upgrade owner; this module neither initializes nor repairs it.
 const store=join(resolvePaperclipHomeDir(),"cli"),currentPath=join(store,"current");
 const manifest=await read(join(store,"install.json"),256*1024),marker=await read(join(store,".managed-install"),4096);
 const record=JSON.parse(manifest.toString()) as Record<string,unknown>;
 const linkStat=await lstat(currentPath,{bigint:true}),currentLink=await readlink(currentPath),payloadDirectory=await realpath(currentPath);
 if(record.schemaVersion!==1 || record.source!=="git" || typeof record.sha!=="string" || !/^[a-f0-9]{40}$/.test(record.sha)
   || typeof record.payloadPath!=="string" || !Array.isArray(record.previous) || marker.toString()!=="paperclipai managed install store v1\n"
   || !linkStat.isSymbolicLink() || linkStat.uid!==BigInt(process.getuid!())
   || record.payloadPath!==payloadDirectory || !payloadDirectory.startsWith(join(store,"installs","git")+"/")
   || root!==join(payloadDirectory,"node_modules/@paperclipai/server"))throw new Error("controller_git_native_current_changed");
 const pkg=await read(join(root,"package.json"),256*1024),build=await read(join(root,"dist/build-info.json"),65536),self=await read(own,65536);
 if(JSON.parse(pkg.toString()).name!=="@paperclipai/server"||JSON.parse(build.toString()).commit!==record.sha)throw new Error("controller_git_installed_source_changed");
  const after=await lstat(currentPath,{bigint:true});
 if(["dev","ino","uid","gid","mode","size","mtimeNs","ctimeNs"].some(k=>linkStat[k as keyof typeof linkStat]!==after[k as keyof typeof after]) || await readlink(currentPath)!==currentLink || await realpath(currentPath)!==payloadDirectory)throw new Error("controller_git_native_current_changed");
 return createHash("sha256").update(JSON.stringify([record,manifest.toString(),marker.toString(),payloadDirectory,currentLink,resolvePaperclipInstanceRoot(),pkg.toString(),build.toString(),self.toString()])).digest("hex");
}

export async function nativeControllerInstallationIdentity():Promise<string>{
 try{return await readNativeControllerInstallationIdentity();}catch(error){
  const value=error as Error & {code?:string};
  if(value.message?.startsWith("controller_git_") || error instanceof SyntaxError || ["ENOENT","ENOTDIR","ELOOP"].includes(value.code??""))throw new NativeProviderStateIncompatibleError("native_github_installation_identity_incompatible");
  throw error;
 }
}
