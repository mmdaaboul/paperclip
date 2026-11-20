import {it,expect} from "vitest";
import {fork} from "node:child_process";
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer} from "node:net";
import {randomBytes} from "node:crypto";
import {reviewerNativeTestDatabase} from "../__tests__/helpers/reviewer-native-database.js";
import {NativeMaintenanceHold} from "./native-maintenance-hold.js";
import {verifyNativeMaintenanceBoot} from "./native-maintenance-server.js";
import {readNativePreservationContent} from "./native-preservation.js";
it("actual native held index starts before keys/auth/plugin/workers, preserves all native data/config and closes through native shutdown",async()=>{
 const fixture=await reviewerNativeTestDatabase(1),home=realpathSync(mkdtempSync(join(process.env.TMPDIR!,"f09-index-"))),root=join(home,"instances","held"),sha="a".repeat(40),key=randomBytes(32);
 mkdirSync(root,{recursive:true,mode:0o700});const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,"127.0.0.1",resolve));const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
 const config=join(root,"config.json"),configBytes=JSON.stringify({$meta:{version:1,updatedAt:new Date().toISOString(),source:"onboard"},database:{mode:"postgres",connectionString:fixture.connectionString,backup:{enabled:false}},logging:{mode:"file",logDir:join(root,"logs")},server:{deploymentMode:"authenticated",exposure:"private",bind:"loopback",host:"127.0.0.1",port,allowedHostnames:["localhost"]},auth:{baseUrlMode:"explicit",publicBaseUrl:`http://localhost:${port}`},telemetry:{enabled:false},storage:{provider:"local_disk",localDisk:{baseDir:join(root,"data")}},secrets:{provider:"local_encrypted",localEncrypted:{keyFilePath:join(root,"secrets","master.key")}}});writeFileSync(config,configBytes,{mode:0o600});
 const hold=new NativeMaintenanceHold(root,"held"),handle=hold.acquire(sha,sha),before=await readNativePreservationContent(fixture.db,key);let logs="";
 const child=fork(fileURLToPath(new URL("../__tests__/fixtures/native-maintenance-startup-child.ts",import.meta.url)),[],{cwd:home,execArgv:["--import",fileURLToPath(import.meta.resolve("tsx"))],env:{PATH:process.env.PATH,HOME:home,TMPDIR:process.env.TMPDIR,PAPERCLIP_HOME:home,PAPERCLIP_INSTANCE_ID:"held",PAPERCLIP_CONFIG:config,PAPERCLIP_BUILD_COMMIT:sha,DATABASE_POOL_MAX:"2",PAPERCLIP_TELEMETRY_DISABLED:"1",PAPERCLIP_WORKTREE_ENV_SKIP:"1",PGHOST:process.env.PGHOST,PGPORT:process.env.PGPORT,PGUSER:process.env.PGUSER},stdio:["ignore","pipe","pipe","ipc"]});child.stdout?.on("data",chunk=>{logs=(logs+String(chunk)).slice(-32000);});child.stderr?.on("data",chunk=>{logs=(logs+String(chunk)).slice(-32000);});
 let exited=false;const exit=new Promise<number|null>(resolve=>child.once("exit",code=>{exited=true;resolve(code);}));
 try{
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error("held startup deadline: "+logs)),60000);child.once("error",error=>{clearTimeout(timeout);reject(error);});child.once("exit",code=>{clearTimeout(timeout);reject(Error(`held child exited ${code}: ${logs}`));});child.once("message",message=>{clearTimeout(timeout);if((message as {type:string}).type==="held-started")resolve();else reject(Error(JSON.stringify(message)+logs));});});
  expect((await verifyNativeMaintenanceBoot(hold,handle,sha)).pid).toBe(child.pid);for(const path of ["/api/auth/get-session","/api/issues","/mcp"])expect((await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(2000)})).status).toBe(503);
  expect(await readNativePreservationContent(fixture.db,key)).toEqual(before);expect(readFileSync(config,"utf8")).toBe(configBytes);expect(existsSync(join(root,"secrets","master.key"))).toBe(false);expect(existsSync(join(root,"secrets","decision-signing.key"))).toBe(false);expect(hold.status()?.holdId).toBe(handle.holdId);
  child.kill("SIGTERM");const code=await Promise.race([exit,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("native shutdown deadline")),10000).unref())]);expect(code,logs).toBe(0);expect(hold.status()?.holdId).toBe(handle.holdId);
 }finally{if(!exited){child.kill("SIGKILL");await exit;}await fixture.end();rmSync(home,{recursive:true,force:true});}
},90000);
