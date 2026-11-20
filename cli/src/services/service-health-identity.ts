/** Native public health exposes the exact commit even when auth redacts version.
 * A same-version old process is insufficient evidence for a Git-source update. */
export function nativeServiceHealthMatches(health:{ok:boolean;serverVersion:string|null;commit?:string|null},expectedVersion:string|null,expectedCommit:string|null):boolean{
 if(!health.ok)return false;
 if(expectedCommit){
  if(!/^[0-9a-f]{40}$/.test(expectedCommit)||health.commit!==expectedCommit)return false;
  return !expectedVersion||health.serverVersion===null||health.serverVersion===expectedVersion;
 }
 return !expectedVersion||health.serverVersion===expectedVersion;
}
