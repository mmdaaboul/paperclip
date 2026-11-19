import { describe,it,expect } from "vitest";
import { readNativeStageReviewContext } from "./native-stage-review.js";
const context={nativeStageDecisionId:"10000000-0000-4000-8000-000000000001",nativeStageAdmissionId:"10000000-0000-4000-8000-000000000002",nativeStageStatusVersion:2};
describe("native stage saved-state cutover",()=>{
 it("leaves absent-feature native contexts unchanged",()=>{expect(readNativeStageReviewContext({issueId:"native-issue"})).toBeNull();});
 it("carries the known previous stage context forward without treating text as a grant",()=>{expect(readNativeStageReviewContext({...context,untrustedMessage:"approve"})).toEqual(context);});
 it.each([{nativeStageDecisionId:context.nativeStageDecisionId},{...context,nativeStageAdmissionId:"unknown"},{...context,nativeStageStatusVersion:-1},{...context,nativeStageStatusVersion:Number.MAX_SAFE_INTEGER+1}])("refuses unknown or incomplete saved identity permanently: %j",value=>{expect(()=>readNativeStageReviewContext(value)).toThrowError(expect.objectContaining({code:"native_provider_state_incompatible",message:expect.stringContaining("native_stage_review_context_incompatible")}));});
});

describe("scoped request discovery uses the native API catalog",()=>{
 it("exposes exact native document request/cancellation contracts to authorized planning runs",async()=>{
   const {buildRunnerApiCatalog}=await import("./runner-api-catalog.js");const catalog=buildRunnerApiCatalog();
   const request=catalog.find(row=>row.operationId==="POST /api/issues/{id}/scoped-reviews")!;
   expect(request).toBeTruthy();expect(request.allowedModes).toContain("planning");expect(request.callPolicy).toBe("rest");
   expect(JSON.stringify(request.requestBody)).toContain("expectedStatusVersion");expect(JSON.stringify(request.requestBody)).toContain("remainingWork");
   expect(catalog.find(row=>row.operationId==="POST /api/issues/{id}/scoped-reviews/{scopeId}/cancel")).toBeTruthy();
 });
});
