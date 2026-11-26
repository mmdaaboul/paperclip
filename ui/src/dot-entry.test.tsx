// @vitest-environment jsdom
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotPairingApp } from "./dot-entry";
import { createDotPairingRuntime, type DotPairingRuntime } from "./lib/dot-pairing-runtime";

const id = "pcmcp_request_" + "A".repeat(43);
const path = "/dot-connect/" + id;
const requestApi = "/api/dot-mcp/requests/" + id;
const fixtureCode = "x".repeat(32);
const details = {
  id, agentConnection: true, clientName: "Fixture assistant", clientOrigin: null,
  redirectOrigin: "https://assistant.example.test", requestedWrite: false,
  requestedConfigure: false, offlineAccess: true, requiresSignIn: true,
  requestedCompanyId: null, companies: [], setupUrl: null,
};
const preview = {
  company: { id: "fixture-company", name: "Fixture company" },
  agent: { id: "fixture-agent", name: "Fixture reviewer" },
  permissions: "Fixture agent permissions", accessDuration: "Until revoked",
  pairingExpiresAt: "2099-01-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

let runtime: DotPairingRuntime;
let root: Root;
let container: HTMLDivElement;
let requests: { url: string; method: string; body: unknown }[];
let networkDown: boolean;
let terminalStatus: number;

beforeEach(() => {
  onlineManager.setOnline(true);
  window.history.replaceState({}, "", path);
  requests = []; networkDown = false; terminalStatus = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", body: init?.body });
    // Every board/session/settings/health endpoint fails as it does behind Access.
    if (!url.startsWith(requestApi)) throw new TypeError("Failed to fetch: protected API");
    if (networkDown) throw new TypeError("Failed to fetch");
    if (url === requestApi) return terminalStatus ? json({ error: "invalid_request" }, terminalStatus) : json(details);
    if (url === requestApi + "/dot-pairing/preview") return json(preview);
    throw new Error("Unexpected fixture request: " + url);
  }));
  runtime = createDotPairingRuntime(path);
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount()); runtime.dispose(); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); onlineManager.setOnline(true);
});

function render(navigateDocument?: (url: string) => void) {
  flushSync(() => root.render(<StrictMode><DotPairingApp runtime={runtime} navigateDocument={navigateDocument} /></StrictMode>));
}

async function enterFixtureCode() {
  await vi.waitFor(() => expect(container.querySelector("#dot-pairing-code")).not.toBeNull());
  const input = container.querySelector<HTMLInputElement>("#dot-pairing-code")!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, fixtureCode);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("public Dot pairing without board access", () => {
  it("loads a real fixture preview with all non-Dot APIs refused and no board persistence", async () => {
    const localWrites = vi.spyOn(window.localStorage, "setItem");
    const sessionWrites = vi.spyOn(window.sessionStorage, "setItem");
    render(); await enterFixtureCode();
    await vi.waitFor(() => expect(container.textContent).toContain("Fixture reviewer"));
    const allow = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Allow agent connection")!;
    expect(allow.disabled).toBe(false);
    expect(requests.some(request => request.url === requestApi + "/dot-pairing/preview"
      && request.method === "POST" && request.body === JSON.stringify({ pairingCode: fixtureCode }))).toBe(true);
    expect(requests.every(request => request.url === requestApi || request.url === requestApi + "/dot-pairing/preview")).toBe(true);
    expect(runtime.store.getSnapshot().status).toBe("online");
    expect(container.textContent).not.toContain("Reconnecting automatically");
    expect(runtime.client.getQueryCache().getAll().map(query => query.queryKey)).toEqual([["dot-mcp-request", id]]);
    expect(JSON.stringify(localWrites.mock.calls)).not.toContain(fixtureCode);
    expect(JSON.stringify(localWrites.mock.calls)).not.toContain("paperclip:query-cache");
    expect(JSON.stringify(sessionWrites.mock.calls)).not.toContain(fixtureCode);
    const signIn = container.querySelector<HTMLAnchorElement>('a[href^="/auth?"]')!;
    expect(signIn.getAttribute("href")).toBe("/auth?next=" + encodeURIComponent(path));
    expect(signIn.hasAttribute("data-discover")).toBe(false); // native anchor, not a board router Link
  });

  it.each([403, 404, 410])("renders terminal request %s without an endless reconnect loop", async status => {
    terminalStatus = status; render();
    await vi.waitFor(() => expect(container.textContent).toContain("Start a new connection"));
    expect(container.querySelector("#dot-pairing-code")).toBeNull();
    expect(runtime.store.getSnapshot().status).toBe("online");
    expect(requests.every(request => request.url === requestApi)).toBe(true);
  });

  it("recovers preview against the same public request after an actual fetch failure", async () => {
    render();
    await vi.waitFor(() => expect(container.querySelector("#dot-pairing-code")).not.toBeNull());
    networkDown = true; await enterFixtureCode();
    await vi.waitFor(() => expect(runtime.store.getSnapshot().status).toBe("reconnecting"));
    networkDown = false; runtime.store.probeNow();
    await vi.waitFor(() => expect(container.textContent).toContain("Fixture reviewer"));
    expect(runtime.store.getSnapshot().status).toBe("online");
    expect(requests.every(request => request.url === requestApi || request.url === requestApi + "/dot-pairing/preview")).toBe(true);
    expect(requests.filter(request => request.url === requestApi).length).toBeGreaterThan(1);
  });

  it.each(["/auth?next=fixture", "/CAR/issues#review", "/dot-connect/" + id.replace(/A/g, "B")])(
    "hands %s off to a fresh document without loading the board in this root", async destination => {
      const navigateDocument = vi.fn(); render(navigateDocument);
      await vi.waitFor(() => expect(container.querySelector("#dot-pairing-code")).not.toBeNull());
      flushSync(() => {
        window.history.pushState({}, "", destination);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await vi.waitFor(() => expect(navigateDocument).toHaveBeenCalledExactlyOnceWith(destination));
      expect(container.querySelector("#dot-pairing-code")).toBeNull();
      expect(requests.every(request => request.url === requestApi)).toBe(true);
    });
});
