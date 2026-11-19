// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentReferenceFoldersCard } from "./AgentReferenceFoldersCard";
import { referenceFolderQueryKey, type AgentReferenceFolderSettings } from "../api/agent-reference-folders";
import { ApiError } from "../api/client";
const calls = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), projects: vi.fn() }));
vi.mock("../api/agent-reference-folders", async original => ({ ...await original<object>(), agentReferenceFoldersApi: { get: calls.get, update: calls.update } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: calls.projects } }));
const COMPANY="a1111111-1111-4111-8111-111111111111", AGENT="a2222222-2222-4222-8222-222222222222", PROJECT="a3333333-3333-4333-8333-333333333333";
const ENTRY={projectId:PROJECT,path:"/reference/current"};
const fresh=(patch:Partial<AgentReferenceFolderSettings>={}):AgentReferenceFolderSettings=>({revision:0,entries:[],updatedAt:null,activeRuns:[],canGrantHostPaths:true,supported:true,reason:null,...patch});
let root:Root,container:HTMLDivElement,client:QueryClient;
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
beforeEach(()=>{vi.clearAllMocks();calls.get.mockResolvedValue(fresh());calls.projects.mockResolvedValue([{id:PROJECT,companyId:COMPANY,name:"Visible project"}]);calls.update.mockResolvedValue({revision:1,entries:[ENTRY],updatedAt:"2026-11-15T12:00:00Z"});client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());client.clear();container.remove();});
async function render(extra:{hasPendingAgentChanges?:boolean;agentSaving?:boolean;savedAgentVersion?:string}={}){await act(async()=>root.render(<QueryClientProvider client={client}><AgentReferenceFoldersCard agentId={AGENT} companyId={COMPANY} {...extra}/></QueryClientProvider>));await settle();}
async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15));});}
function button(text:string){const value=Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item=>item.textContent===text);if(!value)throw Error(`Missing button ${text}`);return value;}
async function click(text:string){await act(async()=>button(text).click());await settle();}
async function field(label:string,value:string){const node=container.querySelector<HTMLInputElement|HTMLSelectElement>(`[aria-label="${label}"]`)!;const proto=node instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(node,value);node.dispatchEvent(new Event(node instanceof HTMLSelectElement?"change":"input",{bubbles:true}));});await settle();}
async function add(path="/reference/new"){await click("Add reference folder");await field("Reference folder 1 project",PROJECT);await field("Reference folder 1 path",path);}

describe("native Agent reference-folder independent settings card",()=>{
 it("starts off with no grant and never writes on load",async()=>{await render();expect(container.textContent).toContain("Additional folder access is off");expect(calls.update).not.toHaveBeenCalled();expect(button("Save reference folders").disabled).toBe(true);});
 it("uses only visible same-company native projects and no fixed default selection",async()=>{calls.projects.mockResolvedValue([{id:PROJECT,companyId:COMPANY,name:"Visible project"},{id:"other",companyId:"other-company",name:"Foreign project"}]);await render();await click("Add reference folder");const select=container.querySelector("select")!;expect(select.value).toBe("");expect(select.textContent).toContain("Visible project");expect(select.textContent).not.toContain("Foreign project");});
 it("keeps draft separate and sends only exact revision/project/path on explicit save",async()=>{await render();await add();expect(container.textContent).toContain("Saved access has not changed");expect(calls.update).not.toHaveBeenCalled();calls.get.mockResolvedValue(fresh({revision:1,entries:[ENTRY]}));await click("Save reference folders");expect(calls.update).toHaveBeenCalledWith(AGENT,COMPANY,{expectedRevision:0,entries:[{projectId:PROJECT,path:"/reference/new"}]});expect(container.textContent).toContain("Reference folders saved");expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(ENTRY.path);});
 it.each(["relative/folder","/bad\u0001path"])("rejects invalid path %j without a write",async path=>{await render();await add(path);await click("Save reference folders");expect(calls.update).not.toHaveBeenCalled();expect(container.querySelector('[role="alert"]')).toBeTruthy();});
 it("rejects duplicate selected entries",async()=>{calls.get.mockResolvedValue(fresh({revision:1,entries:[ENTRY]}));await render();await click("Add reference folder");await field("Reference folder 2 project",PROJECT);await field("Reference folder 2 path",ENTRY.path);await click("Save reference folders");expect(calls.update).not.toHaveBeenCalled();expect(container.textContent).toContain("only once");});
 it("does not add beyond the native32-entry limit",async()=>{calls.get.mockResolvedValue(fresh({revision:1,entries:Array.from({length:32},(_,i)=>({...ENTRY,path:`/reference/${i}`}))}));await render();expect(button("Add reference folder").disabled).toBe(true);});
 it("shows server validation failure and retains the draft and saved access",async()=>{calls.update.mockRejectedValue(new ApiError("Folder contains unsupported aliases",422,{}));await render();await add();await click("Save reference folders");expect(container.textContent).toContain("unsupported aliases");expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("/reference/new");expect(container.textContent).toContain("Additional folder access is off");expect(container.textContent).not.toContain("Reference folders saved");});
 it("retains stale draft and requires explicit discard/reload after409",async()=>{calls.update.mockRejectedValue(new ApiError("Settings changed",409,{}));await render();await add();await click("Save reference folders");expect(container.textContent).toContain("Your draft is retained");expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("/reference/new");expect(button("Save reference folders").disabled).toBe(true);calls.get.mockResolvedValue(fresh({revision:2,entries:[ENTRY]}));await click("Discard draft and reload");expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(ENTRY.path);expect(container.textContent).toContain("Saved revision 2");});
 it("does not replace a dirty draft during a background refetch",async()=>{await render();await add();await act(async()=>{client.setQueryData(referenceFolderQueryKey(COMPANY,AGENT),fresh({revision:3,entries:[ENTRY]}));});await settle();expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("/reference/new");expect(container.textContent).toContain("Your draft is retained");});
 it("makes unsupported runtime clear while allowing an existing entry to be revoked",async()=>{calls.get.mockResolvedValue(fresh({revision:1,entries:[ENTRY],supported:false,reason:"Managed execution is not qualified"}));calls.update.mockResolvedValue({revision:2,entries:[],updatedAt:null});await render();expect(container.textContent).toContain("Managed execution is not qualified");expect(button("Add reference folder").disabled).toBe(true);await click("Remove");await click("Save reference folders");expect(calls.update).toHaveBeenCalledWith(AGENT,COMPANY,{expectedRevision:1,entries:[]});});
 it("lets a configurator revoke but never edit or add host paths",async()=>{calls.get.mockResolvedValue(fresh({revision:1,entries:[ENTRY],canGrantHostPaths:false}));calls.update.mockResolvedValue({revision:2,entries:[],updatedAt:null});await render();expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);expect(button("Add reference folder").disabled).toBe(true);await click("Remove");await click("Save reference folders");expect(calls.update).toHaveBeenCalledWith(AGENT,COMPANY,{expectedRevision:1,entries:[]});});
 it("missing server capability fields never imply support or a grant",async()=>{calls.get.mockResolvedValue({revision:0,entries:[],updatedAt:null,activeRuns:[]});await render();expect(button("Add reference folder").disabled).toBe(true);expect(container.textContent).toContain("has not reported support");});
 it("shows inaccessible existing project without silently dropping its path",async()=>{calls.get.mockResolvedValue(fresh({revision:1,entries:[{projectId:"b3333333-3333-4333-8333-333333333333",path:"/retained/reference"}]}));await render();expect(container.textContent).toContain("Unavailable project");expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("/retained/reference");expect(calls.update).not.toHaveBeenCalled();});
 it("shows load failure and does not pretend the default is saved",async()=>{calls.get.mockRejectedValue(new ApiError("Not authorized",403,{}));await render();expect(container.textContent).toContain("Not authorized");expect(container.textContent).not.toContain("Additional folder access is off");expect(calls.update).not.toHaveBeenCalled();});
 it("keeps old active admissions visible when draft access is removed",async()=>{calls.get.mockResolvedValue(fresh({revision:4,entries:[ENTRY],activeRuns:[{runId:"run-old",admission:{schema:"paperclip.reference-folder-admission.v1",binding:{companyId:COMPANY,agentId:AGENT,runId:"run-old",projectId:PROJECT,workspaceId:"workspace"},revision:3,paths:["/old/admitted/path"]}},{runId:"legacy-run",admission:null}]}));await render();await click("Remove");expect(container.textContent).toContain("admitted revision 3 (older than saved settings)");expect(container.textContent).toContain("/old/admitted/path");expect(container.textContent).toContain("no recorded reference-folder admission");expect(container.textContent).toContain("does not establish that run");expect(calls.update).not.toHaveBeenCalled();});
 it("blocks editing during a pending save and never reports success early",async()=>{let resolve!: (value:unknown)=>void;calls.update.mockImplementation(()=>new Promise(r=>{resolve=r;}));await render();await add();await click("Save reference folders");expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);expect(container.textContent).not.toContain("Reference folders saved");await act(async()=>resolve({revision:1,entries:[ENTRY],updatedAt:null}));await settle();});
 it("warns about unsaved parent changes without calling any parent save or cache invalidation",async()=>{const invalidate=vi.spyOn(client,"invalidateQueries");await render({hasPendingAgentChanges:true});await add();calls.get.mockResolvedValue(fresh({revision:1,entries:[ENTRY]}));await click("Save reference folders");expect(container.textContent).toContain("Other agent changes are still unsaved");expect(invalidate.mock.calls.every(([options])=>JSON.stringify(options?.queryKey)===JSON.stringify(referenceFolderQueryKey(COMPANY,AGENT)))).toBe(true);});
 it("never rolls a successful authoritative save back to an older delayed GET",async()=>{await render();await add();await click("Save reference folders");expect(container.textContent).toContain("Saved revision 1");expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(ENTRY.path);expect(container.textContent).not.toContain("Additional folder access is off");});
 it("a successful revoke preserves the displayed older active admission without an interruption action",async()=>{
  const admission={schema:"paperclip.reference-folder-admission.v1" as const,binding:{companyId:COMPANY,agentId:AGENT,runId:"run-active",projectId:PROJECT,workspaceId:"workspace"},revision:1,paths:[ENTRY.path]};
  calls.get.mockResolvedValue(fresh({revision:1,entries:[ENTRY],activeRuns:[{runId:"run-active",admission}]}));calls.update.mockResolvedValue({revision:2,entries:[],updatedAt:null});await render();await click("Remove");
  calls.get.mockResolvedValue(fresh({revision:2,entries:[],activeRuns:[{runId:"run-active",admission}]}));await click("Save reference folders");expect(container.textContent).toContain("Additional folder access is off");expect(container.textContent).toContain("admitted revision 1 (older than saved settings)");expect(container.textContent).toContain(ENTRY.path);expect(calls.update).toHaveBeenCalledTimes(1);
 });
 it("refreshes native availability after a saved agent change while preserving its independent draft",async()=>{await render({savedAgentVersion:"v1"});await add();calls.get.mockResolvedValue(fresh({supported:false,reason:"The saved target is unavailable"}));await render({savedAgentVersion:"v2"});expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("/reference/new");expect(container.textContent).toContain("The saved target is unavailable");expect(button("Save reference folders").disabled).toBe(true);expect(calls.update).not.toHaveBeenCalled();});
 it("cancel resets only reference changes and beforeunload warns only while dirty",async()=>{await render();await add();const dirtyEvent=new Event("beforeunload",{cancelable:true});window.dispatchEvent(dirtyEvent);expect(dirtyEvent.defaultPrevented).toBe(true);await click("Cancel reference changes");expect(container.querySelector("input")).toBeNull();const cleanEvent=new Event("beforeunload",{cancelable:true});window.dispatchEvent(cleanEvent);expect(cleanEvent.defaultPrevented).toBe(false);expect(calls.update).not.toHaveBeenCalled();});
 it("permits privacy-safe full revocation after project visibility is lost",async()=>{
  calls.get.mockResolvedValue(fresh({revision:4,entries:[],hiddenEntryCount:2,canGrantHostPaths:false,supported:false}));
  calls.update.mockResolvedValue({revision:5,entries:[],updatedAt:null});await render();
  expect(container.textContent).toContain("Some saved reference folders are private");
  expect(container.textContent).not.toContain("Additional folder access is off");
  expect(button("Add reference folder").disabled).toBe(true);expect(container.querySelector("input")).toBeNull();
  await click("Clear all reference folders");
  expect(calls.update).toHaveBeenCalledWith(AGENT,COMPANY,{expectedRevision:4,entries:[]});
  expect(calls.update).toHaveBeenCalledTimes(1);
 });
 it("clears hidden-entry state after authoritative revocation while GET is pending",async()=>{
  calls.get.mockResolvedValue(fresh({revision:4,entries:[],hiddenEntryCount:1}));
  calls.update.mockResolvedValue({revision:5,entries:[],updatedAt:null});await render();
  calls.get.mockImplementation(()=>new Promise(()=>{}));await click("Clear all reference folders");
  expect(container.textContent).not.toContain("Some saved reference folders are private");
  expect(container.textContent).toContain("Additional folder access is off");
 });
 it("never submits an ordinary visible-subset save when private grants exist",async()=>{
  calls.get.mockResolvedValue(fresh({revision:4,entries:[ENTRY],hiddenEntryCount:1}));await render();
  expect(container.querySelector("input")).toBeNull();expect(button("Save reference folders").disabled).toBe(true);
  expect(button("Add reference folder").disabled).toBe(true);expect(calls.update).not.toHaveBeenCalled();
 });

 it("refreshes a clean private projection when visibility returns at the same revision",async()=>{
  calls.get.mockResolvedValue(fresh({revision:4,entries:[],hiddenEntryCount:1}));await render();
  await act(async()=>client.setQueryData(referenceFolderQueryKey(COMPANY,AGENT),fresh({revision:4,entries:[ENTRY],hiddenEntryCount:0})));await settle();
  expect(Array.from(container.querySelectorAll<HTMLInputElement>("input")).some(input=>input.value===ENTRY.path)).toBe(true);expect(container.textContent).not.toContain("No reference folders saved");
  expect(calls.update).not.toHaveBeenCalled();
 });

});
