import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNativeCapacity,nativeCapacityFailure} from './qualify-native-capacity.mjs';
const GiB=1024**3,snapshot={freeBytes:16*GiB,availableMemoryBytes:8*GiB,totalMemoryBytes:16*GiB},required={diskGiB:12,memoryGiB:4};
test('conservative capacity admits the boundary without calling it a measured build minimum',()=>{const p=assertNativeCapacity(snapshot,required);assert.equal(p.requiredFreeBytes,12*GiB);assert.equal(p.measuredMinimum,false);assertNativeCapacity({...snapshot,freeBytes:12*GiB,availableMemoryBytes:4*GiB},required);});
test('one byte below disk or available-memory requirement refuses before a build',()=>{assert.throws(()=>assertNativeCapacity({...snapshot,freeBytes:12*GiB-1},required),/disk/);assert.throws(()=>assertNativeCapacity({...snapshot,availableMemoryBytes:4*GiB-1},required),/memory/);});
test('invalid measurement and implicit/unbounded requirements do not admit a build',()=>{for(const value of [NaN,-1,'16',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>assertNativeCapacity({...snapshot,freeBytes:value},required));for(const value of [0,1.5,129,undefined])assert.throws(()=>assertNativeCapacity(snapshot,{...required,diskGiB:value}));});

test('capacity refusal retains only owned numeric diagnostics rather than arbitrary error data',()=>{let failure;try{assertNativeCapacity({...snapshot,freeBytes:1},required);}catch(error){failure=error;}assert.equal(nativeCapacityFailure(failure).freeBytes,1);assert.equal(nativeCapacityFailure(failure).requiredFreeBytes,12*GiB);assert.equal(nativeCapacityFailure(Object.assign(new Error('private'),{capacity:{secret:'not-accepted'}})),null);});
