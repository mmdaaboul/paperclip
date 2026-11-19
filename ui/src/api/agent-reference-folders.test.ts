import { beforeEach, describe, expect, it, vi } from "vitest";
const calls=vi.hoisted(()=>({get:vi.fn(),put:vi.fn()}));
vi.mock("./client",()=>({api:calls}));
import { agentReferenceFoldersApi,referenceFolderQueryKey } from "./agent-reference-folders";
beforeEach(()=>vi.clearAllMocks());
describe("native per-agent reference-folder API client",()=>{
 it("encodes the agent and company scope using the dedicated read endpoint",async()=>{await agentReferenceFoldersApi.get("agent/a","company?b");expect(calls.get).toHaveBeenCalledWith("/agents/agent%2Fa/reference-folders?companyId=company%3Fb");});
 it("sends only dedicated revisioned configuration instead of a generic agent patch",async()=>{const input={expectedRevision:3,entries:[{projectId:"project",path:"/generic/path"}]};await agentReferenceFoldersApi.update("agent","company",input);expect(calls.put).toHaveBeenCalledWith("/agents/agent/reference-folders?companyId=company",input);});
 it("separates company and agent cache identities",()=>{expect(referenceFolderQueryKey("company","agent")).not.toEqual(referenceFolderQueryKey("other","agent"));expect(referenceFolderQueryKey("company","agent")).not.toEqual(referenceFolderQueryKey("company","other"));});
});
