// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootstrapDotPairing } from "./dot-entry";
import type { PaperclipReactRootHost } from "./lib/react-root";

const id = "pcmcp_request_" + "A".repeat(43);
let container: HTMLDivElement;
let dispose: (() => void) | undefined;
let down: boolean;
const host = window as Window & PaperclipReactRootHost;

beforeEach(() => {
  onlineManager.setOnline(true); down = false;
  window.history.replaceState({}, "", "/dot-connect/" + id);
  container = document.createElement("div"); container.id = "root"; document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (down) throw new TypeError("Failed to fetch");
    const currentId = String(input).split("/").at(-1);
    return new Response(JSON.stringify({ id: currentId, agentConnection: true, clientName: "Fixture",
      companies: [], requiresSignIn: true, requestedWrite: false, requestedConfigure: false }),
    { headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  flushSync(() => dispose?.()); container.remove();
  vi.unstubAllGlobals(); onlineManager.setOnline(true);
});

function pageTransition(type: string, persisted: boolean) {
  const event = new Event(type); Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

it("reuses a single live entry and recreates its owned root after disposal", async () => {
  flushSync(() => { dispose = bootstrapDotPairing(); });
  const firstRoot = host.__paperclipReactRoot;
  expect(bootstrapDotPairing()).toBe(dispose);
  expect(host.__paperclipReactRoot).toBe(firstRoot);
  await vi.waitFor(() => expect(container.querySelector("#dot-pairing-code")).not.toBeNull());
  flushSync(() => dispose?.());
  expect(host.__paperclipReactRoot).toBeUndefined();
  expect(container.textContent).toBe("");
  flushSync(() => { dispose = bootstrapDotPairing(); });
  expect(host.__paperclipReactRoot).not.toBe(firstRoot);
  await vi.waitFor(() => expect(container.querySelector("#dot-pairing-code")).not.toBeNull());
});

it("rebinds online state after replacing an offline entry", async () => {
  down = true; flushSync(() => { dispose = bootstrapDotPairing(); });
  await vi.waitFor(() => expect(onlineManager.isOnline()).toBe(false));
  down = false;
  window.history.replaceState({}, "", "/dot-connect/" + id.replace(/A/g, "B"));
  flushSync(() => { dispose = bootstrapDotPairing(); });
  await vi.waitFor(() => expect(container.querySelector("#dot-pairing-code")).not.toBeNull());
  expect(onlineManager.isOnline()).toBe(true);
});

it("retains a frozen page but requires a new document on BFCache restore", async () => {
  const reload = vi.fn();
  flushSync(() => { dispose = bootstrapDotPairing(reload); });
  await vi.waitFor(() => expect(container.querySelector("#dot-pairing-code")).not.toBeNull());
  const firstRoot = host.__paperclipReactRoot;
  pageTransition("pagehide", true);
  expect(host.__paperclipReactRoot).toBe(firstRoot);
  pageTransition("pageshow", true);
  expect(reload).toHaveBeenCalledOnce();
  flushSync(() => pageTransition("pagehide", false));
  expect(host.__paperclipReactRoot).toBeUndefined();
  pageTransition("pageshow", true);
  expect(reload).toHaveBeenCalledOnce(); // disposed listeners cannot run again
});
