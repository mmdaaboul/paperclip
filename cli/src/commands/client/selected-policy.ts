import {createHash} from "node:crypto";
import type {Command} from "commander";
import {addCommonClientOptions,resolveCommandContext,handleCommandError,printOutput,type BaseClientOptions} from "./common.js";
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const canonical=(v:unknown):string=>Array.isArray(v)?"["+v.map(canonical).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical((v as Record<string,unknown>)[k])).join(",")+"}":JSON.stringify(v);
/** Fixed authorized native GET projections. No raw paths, policy bodies or credentials leave this command. */
export function projectSelectedPolicy(operation:string,id:string,companyId:string,native:Record<string,unknown>){
 const base={schema:"paperclip.selected-policy-read.v1",operation,companyId,...(operation==="scoped-reviews"?{issueId:id}:{agentId:id})};
 if(operation==="scoped-reviews"){
  if(native.issueId!==id||native.companyId!==companyId||!Array.isArray(native.reviews)||native.totalReviewCycles!==5||!native.budget||typeof native.budget!=="object")throw Error("Native scoped-review response does not match selected scope.");
  const source=native.budget as Record<string,unknown>,budget={used:source.used as number,allowance:source.allowance as number,remaining:source.remaining as number};
  if(!Object.values(budget).every(Number.isSafeInteger)||budget.used<0||budget.allowance<5||budget.used>budget.allowance||budget.remaining!==budget.allowance-budget.used)throw Error("Malformed native review budget.");
  const bound={...base,totalReviewCycles:native.totalReviewCycles,budget,reviews:native.reviews};
  return {...base,totalReviewCycles:native.totalReviewCycles,budget,scopedReviewCount:native.reviews.length,snapshotSha256:createHash("sha256").update(canonical(bound)).digest("hex")};
 }
 const collection=operation==="reference-folders"?native.entries:native.scopes;
 if(!Array.isArray(collection)||!Number.isSafeInteger(native.revision)||Number(native.revision)<0||typeof native.supported!=="boolean"||operation==="reviewer-policy"&&typeof native.enabled!=="boolean")throw Error("Malformed native selected-policy response.");
 const hidden=operation==="reference-folders"?native.hiddenEntryCount??0:native.hiddenScopeCount??0;
 if(!Number.isSafeInteger(hidden)||Number(hidden)<0)throw Error("Malformed native hidden-policy count.");
 const bound={...base,revision:native.revision,supported:native.supported,collection,hidden,...(operation==="reviewer-policy"?{enabled:native.enabled}:{})};
 return {...base,revision:native.revision,supported:native.supported,...(operation==="reference-folders"?{entryCount:collection.length,hiddenEntryCount:hidden}:{enabled:native.enabled,scopeCount:collection.length,hiddenScopeCount:hidden}),snapshotSha256:createHash("sha256").update(canonical(bound)).digest("hex")};
}
export function registerSelectedPolicyReads(parent:Command,kind:"agent"|"issue"){
 for(const operation of kind==="agent"?["reference-folders","reviewer-policy"]:["scoped-reviews"]){
  addCommonClientOptions(parent.command(operation+" <id>").description("Read a bounded native policy projection without private policy content").action(async(id:string,opts:BaseClientOptions)=>{
   try{if(!UUID.test(id)||!opts.companyId||!UUID.test(opts.companyId))throw Error("Exact UUID and explicit --company-id required.");const ctx=resolveCommandContext(opts,{requireCompany:true});const path=`/api/${kind==="agent"?"agents":"issues"}/${encodeURIComponent(id)}`;const resource=await ctx.api.get<Record<string,unknown>>(path);if(!resource||resource.id!==id||resource.companyId!==opts.companyId)throw Error("Selected native resource scope mismatch.");const native=await ctx.api.get<Record<string,unknown>>(path+"/"+operation);if(!native)throw Error("Selected native policy unavailable.");printOutput(projectSelectedPolicy(operation,id,opts.companyId,native),{json:ctx.json});}catch(error){handleCommandError(error);}
  }),{includeCompany:true});
 }
}
