// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue, ScopedReview } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "../api/issues";
import { IssueScopedReviews } from "./IssueScopedReviews";
vi.mock("../api/issues",()=>({issuesApi:{scopedReviews:vi.fn(),cancelScopedReview:vi.fn(),update:vi.fn()}}));
let root:Root,container:HTMLDivElement,client:QueryClient;
const issue={id:"task",companyId:"company",statusVersion:5,assigneeUserId:"owner",executionPolicy:{totalReviewCycles:5},executionState:{totalReviewBudgetHold:false}} as Issue;
function scope(state:ScopedReview["state"]="pending"):ScopedReview{return {id:"scope",issueId:"task",companyId:"company",state,version:1,snapshot:{purpose:"Review this plan",revisionId:"revision",remainingWork:"Implement the plan"},cancellation:null} as ScopedReview;}
async function render(currentUserId:string|undefined="owner",task=issue){await act(async()=>{root.render(<QueryClientProvider client={client}><IssueScopedReviews issue={task} currentUserId={currentUserId}/></QueryClientProvider>);});await act(async()=>{await new Promise(r=>setTimeout(r,10));});}
async function type(value:string){await act(async()=>{const input=container.querySelector("textarea")!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});}
async function click(label:string){await act(async()=>{[...container.querySelectorAll("button")].find(b=>b.textContent===label)!.click();});}
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.clearAllMocks();container=document.createElement("div");document.body.append(container);root=createRoot(container);client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.mocked(issuesApi.scopedReviews).mockResolvedValue({reviews:[scope()],budget:{used:1,allowance:5,remaining:4}});vi.mocked(issuesApi.cancelScopedReview).mockResolvedValue(scope("cancelled"));vi.mocked(issuesApi.update).mockResolvedValue({...issue,changes:{}});});
afterEach(async()=>{await act(async()=>root.unmount());client.clear();container.remove();});
describe("scoped review UI (API doubles; no server authorization claim)",()=>{
 it("explains shared usage, exact revision and remaining work without human partial approval",async()=>{await render();expect(container.textContent).toContain("1 of 5 total task cycles");expect(container.textContent).toContain("revision");expect(container.textContent).toContain("Implement the plan");expect(container.textContent).toContain("Final configured review and human approval");expect([...container.querySelectorAll("button")].map(b=>b.textContent)).toEqual(["Cancel scoped review"]);});
 it("requires a reason and submits only the scoped cancellation identity",async()=>{await render();expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);await type("Stale scope");await click("Cancel scoped review");expect(issuesApi.cancelScopedReview).toHaveBeenCalledWith("task","scope",{requestId:expect.any(String),expectedVersion:1,reason:"Stale scope"});});
 it("resumes the exact durable cancellation after uncertain Stop without a fresh receipt",async()=>{const row=scope("cancelling");row.cancellation={requestId:"recorded-id",expectedVersion:1,reason:"Original reason",requestedByUserId:"owner",requestedByAgentId:null,requestedAt:"2026-11-15T00:00:00Z",targetRunIds:["review-run"]};row.version=2;vi.mocked(issuesApi.scopedReviews).mockResolvedValue({reviews:[row],budget:{used:1,allowance:5,remaining:4}});await render();expect(container.querySelector("textarea")).toBeNull();await click("Resume cancellation");expect(issuesApi.cancelScopedReview).toHaveBeenCalledWith("task","scope",{requestId:"recorded-id",expectedVersion:1,reason:"Original reason"});});
 it("does not expose cancellation to an unauthenticated viewer",async()=>{await render(null as never);expect(container.querySelector("button")).toBeNull();});
 it("exposes an explicit reasoned single extra cycle only to selected held human",async()=>{vi.mocked(issuesApi.scopedReviews).mockResolvedValue({reviews:[scope("held")],budget:{used:5,allowance:5,remaining:0}});await render("owner",{...issue,executionState:{totalReviewBudgetHold:true,currentStageId:null}} as Issue);await type("One more correction");await click("Authorize one additional cycle");expect(issuesApi.update).toHaveBeenCalledWith("task",{reviewCycleAllowance:{id:expect.any(String),additionalCycles:1,reason:"One more correction"}});});
});
