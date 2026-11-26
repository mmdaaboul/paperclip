// Execute the actual compiled public bundle in a simulated browser, without a listener.
// This is deliberately separate from real-browser/complete-board qualification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SourceTextModule } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.resolve("vitest/package.json"));
const { JSDOM } = require("jsdom"); // existing Vitest peer, no second toolchain
const build = new URL("../dist-dot-pairing/", import.meta.url);
const html = readFileSync(new URL("tests/dot-pairing.html", build), "utf8");
const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
assert(script, "fixture build has no module script");
const bundle = readFileSync(new URL(script.slice(1), build), "utf8");
const id = "pcmcp_request_" + "A".repeat(43);
const requestApi = "/api/dot-mcp/requests/" + id;
const code = "x".repeat(32);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert(Date.now() < deadline, "compiled fixture did not reach its expected state");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture({ expired = false, recover = false } = {}) {
  const dom = new JSDOM(html, { url: "https://fixture.invalid/dot-connect/" + id,
    runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(window, { Headers, Response, Request });
  const requests = [];
  Object.defineProperty(window.navigator, "serviceWorker", { value: {
    controller: null, addEventListener() {}, getRegistration: async () => undefined,
    register: async url => {
      requests.push({ method: "SERVICE_WORKER", url: String(url) });
      throw new Error("Board service-worker startup ran");
    },
  } });
  window.WebSocket = class {
    constructor(url) {
      requests.push({ method: "WEBSOCKET", url: String(url) });
      throw new Error("Board event startup ran");
    }
  };
  let previewFailed = false, probeFailed = false;
  window.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ method: init.method ?? "GET", url });
    if (url === requestApi) {
      if (expired) return json({ error: "invalid_request" }, 404);
      if (recover && previewFailed && !probeFailed) {
        probeFailed = true; return json({ error: "tenant_app_unavailable" }, 503);
      }
      return json({ id, agentConnection: true, clientName: "Compiled fixture assistant",
        clientOrigin: null, redirectOrigin: "https://assistant.example.test", requiresSignIn: true,
        requestedWrite: false, requestedConfigure: false, companies: [] });
    }
    if (url === requestApi + "/dot-pairing/preview") {
      if (recover && !previewFailed) {
        previewFailed = true; return json({ error: "tenant_app_unavailable" }, 503);
      }
      return json({ company: { id: "fixture-company", name: "Compiled fixture company" },
        agent: { id: "fixture-agent", name: "Compiled fixture reviewer" },
        permissions: "Fixture only", accessDuration: "Fixture only", pairingExpiresAt: "2099-01-01T00:00:00Z" });
    }
    throw new TypeError("Failed to fetch: non-Dot API is protected");
  };
  // Evaluate the unmodified emitted ESM, with the DOM as its actual global scope.
  const module = new SourceTextModule(bundle, {
    context: dom.getInternalVMContext(),
    identifier: "https://fixture.invalid" + script,
    initializeImportMeta: meta => { meta.url = "https://fixture.invalid" + script; },
    importModuleDynamically: () => { throw new Error("Unexpected dynamic board import"); },
  });
  await module.link(() => { throw new Error("Unexpected external module import"); });
  await module.evaluate();
  return { window, requests,
    enterCode() {
      const input = window.document.querySelector("#dot-pairing-code");
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, code);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    close() {
      const event = new window.Event("pagehide");
      Object.defineProperty(event, "persisted", { value: false });
      window.dispatchEvent(event); window.close();
    },
    get recovered() { return previewFailed && probeFailed; },
  };
}

for (const recover of [false, true]) {
  test("compiled public page previews with protected board APIs" + (recover ? " after outage recovery" : ""), async () => {
    const f = await fixture({ recover });
    try {
      await until(() => f.window.document.querySelector("#dot-pairing-code"));
      f.enterCode();
      await until(() => f.window.document.body.textContent.includes("Compiled fixture reviewer"));
      const button = [...f.window.document.querySelectorAll("button")].find(node => node.textContent === "Allow agent connection");
      assert.equal(button.disabled, false);
      assert(f.requests.every(request => request.url === requestApi || request.url === requestApi + "/dot-pairing/preview"));
      assert(f.requests.some(request => request.method === "POST"));
      assert.equal(f.window.document.body.textContent.includes("Reconnecting automatically"), false);
      for (const storage of [f.window.localStorage, f.window.sessionStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          assert(!key.includes("query-cache"));
          assert(!storage.getItem(key).includes(code));
        }
      }
      if (recover) assert(f.recovered);
    } finally { f.close(); }
  });
}

test("compiled public page rejects an expired request without loading board APIs", async () => {
  const f = await fixture({ expired: true });
  try {
    await until(() => f.window.document.body.textContent.includes("Start a new connection"));
    assert.equal(f.window.document.querySelector("#dot-pairing-code"), null);
    assert.equal(f.window.document.body.textContent.includes("Reconnecting automatically"), false);
    assert(f.requests.every(request => request.url === requestApi));
  } finally { f.close(); }
});
