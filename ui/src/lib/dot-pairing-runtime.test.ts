import { afterEach, describe, expect, it, vi } from "vitest";
import { onlineManager } from "@tanstack/react-query";
import { createDotPairingRuntime, probeDotPairingRequest } from "./dot-pairing-runtime";

const id = "pcmcp_request_" + "A".repeat(43);
const reply = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...headers },
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); onlineManager.setOnline(true); });

describe("request-bound Dot reachability", () => {
  it("probes only the current request and rejects redirects", async () => {
    const fetch = vi.fn(async () => reply({ id, agentConnection: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(probeDotPairingRequest(id)).resolves.toEqual({ reachable: true });
    expect(fetch).toHaveBeenCalledWith("/api/dot-mcp/requests/" + id, expect.objectContaining({
      redirect: "error", cache: "no-store", signal: expect.any(AbortSignal),
    }));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 409, 410])("treats structured terminal %s as reachable", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "invalid_request" }, status)));
    await expect(probeDotPairingRequest(id)).resolves.toEqual({ reachable: true });
  });

  it.each([408, 425, 429, 503])("retains Retry-After on transient %s", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "temporarily_unavailable" }, status, { "Retry-After": "12" })));
    await expect(probeDotPairingRequest(id)).resolves.toEqual({ reachable: false, retryAfterMs: 12_000 });
  });

  it("does not mistake a login HTML page or a different resource for reachability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("<html>sign in</html>"))
      .mockResolvedValueOnce(reply({ id: "another-request", agentConnection: true })));
    expect((await probeDotPairingRequest(id)).reachable).toBe(false);
    expect((await probeDotPairingRequest(id)).reachable).toBe(false);
  });

  it("does not issue a request for an invalid capability path", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await probeDotPairingRequest("../health")).reachable).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a hung probe after ten seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const result = probeDotPairingRequest(id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    expect(await result).toEqual({ reachable: false, retryAfterMs: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an active request-bound recovery probe on disposal", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const runtime = createDotPairingRuntime("/dot-connect/" + id);
    runtime.store.reportError(new TypeError("Failed to fetch"));
    expect(signal?.aborted).toBe(false);
    runtime.dispose();
    expect(signal?.aborted).toBe(true);
  });
});
