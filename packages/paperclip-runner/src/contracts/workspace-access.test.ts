import { describe, expect, it } from "vitest";
import { createWorkspaceAccessSnapshot, parseWorkspaceAccessSnapshot, workspaceAccessSessionCompatible, type WorkspaceAccessBinding } from "./workspace-access.js";

const binding: WorkspaceAccessBinding = {
  companyId: "10000000-0000-0000-0000-000000000001",
  agentId: "10000000-0000-0000-0000-000000000002",
  projectId: "10000000-0000-0000-0000-000000000003",
  runId: "10000000-0000-0000-0000-000000000004",
  workspaceId: "10000000-0000-0000-0000-000000000005",
};
const policy = { workspaceDirectory: "/work/candidate", referenceDirectories: ["/references/b", "/references/a"], readOnlyWorkspace: true, scratchDirectory: "/work/scratch" };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("versioned controller-owned workspace snapshot", () => {
  it("round-trips a stable sorted snapshot with all run identities", () => {
    const original = createWorkspaceAccessSnapshot(binding, policy);
    const restored = parseWorkspaceAccessSnapshot(copy(original), binding);
    expect(restored).toEqual(original);
    expect(original.policy.referenceDirectories).toEqual(["/references/a", "/references/b"]);
    expect(original.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(createWorkspaceAccessSnapshot(binding, { ...policy, referenceDirectories: [...policy.referenceDirectories].reverse() })).toEqual(original);
  });
  it("isolates saved policy from future edits and prevents mutation", () => {
    const selected = copy(policy); const original = createWorkspaceAccessSnapshot(binding, selected);
    selected.referenceDirectories.length = 0;
    expect(original.policy.referenceDirectories).toHaveLength(2);
    expect(() => { (original.policy.referenceDirectories as string[]).push("/self/granted"); }).toThrow();
  });
  it.each(Object.keys(binding) as Array<keyof WorkspaceAccessBinding>)("refuses a snapshot for another %s", field => {
    expect(() => parseWorkspaceAccessSnapshot(createWorkspaceAccessSnapshot(binding, policy), { ...binding, [field]: "20000000-0000-0000-0000-000000000001" })).toThrow("binding mismatch");
  });
  it.each(["schema", "digest", "policy", "binding"])("rejects tampered %s", field => {
    const value = copy(createWorkspaceAccessSnapshot(binding, policy));
    if (field === "schema") (value as { schema: string }).schema = "paperclip.workspace-access.v99";
    if (field === "digest") value.digest = `sha256:${"0".repeat(64)}`;
    if (field === "policy") value.policy.readOnlyWorkspace = false;
    if (field === "binding") value.binding.agentId = "20000000-0000-0000-0000-000000000001";
    expect(() => parseWorkspaceAccessSnapshot(value, binding)).toThrow();
  });
  it("rejects additional grant fields at every level", () => {
    const value = copy(createWorkspaceAccessSnapshot(binding, policy));
    for (const extra of [{ ...value, allowEverything: true }, { ...value, binding: { ...value.binding, role: "owner" } }, { ...value, policy: { ...value.policy, writableRoots: ["/"] } }]) {
      expect(() => parseWorkspaceAccessSnapshot(extra, binding)).toThrow("Unknown");
    }
  });
  it.each(["/", "relative", "/work/../secret", "/work/./candidate", "/work//candidate", "/work/candidate/", "/work/\nsecret"])("rejects noncanonical path %j", path => {
    expect(() => createWorkspaceAccessSnapshot(binding, { ...policy, workspaceDirectory: path })).toThrow("canonical");
  });
  it("rejects duplicate, excessive or malformed reference grants", () => {
    for (const references of [["/ref", "/ref"], Array(33).fill("/ref"), ["relative"]]) {
      expect(() => createWorkspaceAccessSnapshot(binding, { ...policy, referenceDirectories: references })).toThrow();
    }
    expect(() => createWorkspaceAccessSnapshot(binding, { ...policy, scratchDirectory: undefined })).toThrow("scratch");
  });
  it("reuses equivalent scoped permissions for a later run", () => {
    const previous = createWorkspaceAccessSnapshot(binding, policy);
    const next = createWorkspaceAccessSnapshot({ ...binding, runId: "20000000-0000-0000-0000-000000000001" }, policy);
    expect(previous.digest).not.toBe(next.digest);
    expect(workspaceAccessSessionCompatible(previous, next)).toBe(true);
    expect(workspaceAccessSessionCompatible(undefined, undefined)).toBe(true);
  });
  it("requires a fresh process on grant addition, removal or policy/scope change", () => {
    const previous = createWorkspaceAccessSnapshot(binding, policy);
    const changed = [
      createWorkspaceAccessSnapshot(binding, { ...policy, referenceDirectories: [] }),
      createWorkspaceAccessSnapshot(binding, { ...policy, readOnlyWorkspace: false }),
      createWorkspaceAccessSnapshot(binding, { ...policy, scratchDirectory: "/work/other-scratch" }),
      createWorkspaceAccessSnapshot({ ...binding, projectId: "20000000-0000-0000-0000-000000000001" }, policy),
    ];
    expect(workspaceAccessSessionCompatible(undefined, previous)).toBe(false);
    expect(workspaceAccessSessionCompatible(previous, undefined)).toBe(false);
    for (const next of changed) expect(workspaceAccessSessionCompatible(previous, next)).toBe(false);
  });
});
