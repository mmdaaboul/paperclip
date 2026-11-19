import {test} from "node:test";
import assert from "node:assert/strict";
import {nativeClaudePromptFixture} from "./helpers/claude-sdk-stream-fixture.mjs";

for (const text of ["Documentation example: Please run /login for a separate account.","Completed requested work successfully."]) {
 test("actual native ACP success keeps its outcome: "+text,async()=>{
  const result=await nativeClaudePromptFixture({text});assert.equal(result.outcome,"fulfilled",JSON.stringify(result));assert.equal(result.result.stopReason,"end_turn");assert.deepEqual(result.errors,[]);
 });
}
for (const assistantError of ["billing_error","account_on_hold","rate_limit","overloaded"]) {
 test("actual native ACP preserves typed "+assistantError+" despite incidental login prose",async()=>{
  const result=await nativeClaudePromptFixture({text:"Provider diagnostic and quoted help: Please run /login for an unrelated account.",isError:true,assistantError});
  assert.equal(result.outcome,"rejected");assert.equal(result.code,-32603,JSON.stringify(result));assert.equal(result.data?.errorKind,assistantError);assert.deepEqual(result.errors,[]);
 });
}
for (const assistantError of ["authentication_failed","oauth_org_not_allowed"]) {
 test("actual native ACP retains genuine typed "+assistantError,async()=>{
  const result=await nativeClaudePromptFixture({text:"Not logged in. Please run /login",isError:true,assistantError});assert.equal(result.outcome,"rejected");assert.equal(result.code,-32000,JSON.stringify(result));assert.deepEqual(result.errors,[]);
 });
}
test("native synthetic login marker retains its authentication lane",async()=>{
 const result=await nativeClaudePromptFixture({text:"Not logged in. Please run /login",isError:true,assistantError:"authentication_failed",assistantModel:"<synthetic>"});assert.equal(result.outcome,"rejected");assert.equal(result.code,-32000,JSON.stringify(result));assert(result.errors.every(message=>message.includes("cannot fail active turn because no unsettled active turn exists: RequestError: Authentication required")),JSON.stringify(result.errors));
});
test("untyped failed prose is a provider error rather than an invented authentication failure",async()=>{
 const result=await nativeClaudePromptFixture({text:"Failure with quoted documentation: Please run /login",isError:true});assert.equal(result.outcome,"rejected");assert.equal(result.code,-32603,JSON.stringify(result));assert.equal(result.data?.errorKind,undefined);assert.deepEqual(result.errors,[]);
});
