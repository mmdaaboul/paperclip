/** Conservative read-only preflight for fresh disposable CI builds. It is not
 * a measured minimum, cgroup limit, or a guarantee against later exhaustion. */
import assert from 'node:assert/strict';
import {statfsSync,readFileSync} from 'node:fs';
import {freemem,totalmem} from 'node:os';
const GiB=1024**3,failures=new WeakMap();
export const nativeCapacityFailure=error=>failures.get(error)??null;
export function assertNativeCapacity(snapshot,required){
 for(const key of ['freeBytes','availableMemoryBytes','totalMemoryBytes'])assert(Number.isSafeInteger(snapshot[key])&&snapshot[key]>=0,'native_capacity_measurement_invalid');
 for(const key of ['diskGiB','memoryGiB'])assert(Number.isSafeInteger(required[key])&&required[key]>0&&required[key]<=128,'native_capacity_requirement_invalid');
 assert(snapshot.availableMemoryBytes<=snapshot.totalMemoryBytes&&snapshot.totalMemoryBytes>0,'native_capacity_measurement_invalid');
 const proof={...snapshot,requiredFreeBytes:required.diskGiB*GiB,requiredAvailableMemoryBytes:required.memoryGiB*GiB,conservativePreflight:true,measuredMinimum:false};
 if(snapshot.freeBytes<proof.requiredFreeBytes||snapshot.availableMemoryBytes<proof.requiredAvailableMemoryBytes){const error=new Error(snapshot.freeBytes<proof.requiredFreeBytes?'native_disk_capacity_insufficient':'native_memory_capacity_insufficient');failures.set(error,Object.freeze(proof));throw error;}
 return proof;
}
export function nativeCapacity(root,required,phase){
 const fs=statfsSync(root,{bigint:true});let available=freemem();
 if(process.platform==='linux'){const line=readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB$/m);assert(line,'native_available_memory_missing');available=Number(line[1])*1024;}
 return {phase,...assertNativeCapacity({freeBytes:Number(fs.bavail*fs.bsize),availableMemoryBytes:available,totalMemoryBytes:totalmem()},required)};
}
