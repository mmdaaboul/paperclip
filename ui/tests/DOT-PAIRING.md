# Public Dot pairing local checks

The public entry can be checked with the dashboard APIs unavailable. These fixtures use synthetic request IDs and synthetic codes; no real OAuth grant is created. The request component and runtime are the production source.

From ui/:

    node node_modules/vitest/vitest.mjs run --config vitest.config.ts src/dot-entry.test.tsx src/dot-entry-lifecycle.test.tsx src/pages/McpConnect.test.tsx src/lib/ui-entry.test.ts src/lib/dot-pairing-runtime.test.ts
    node node_modules/typescript/bin/tsc --noEmit -p tsconfig.dot-pairing.json
    node node_modules/vite/bin/vite.js build --config vite.dot-pairing.config.ts
    node --experimental-vm-modules --test tests/verify-dot-pairing-build.mjs

The isolated build and compiled DOM check do not qualify the complete production board build, browser rendering, final production chunk graph, service-worker rollout, Cloudflare ingress or real OAuth pairing. The normal full build/typecheck and applicable release gates still apply. Requalify the exact production static-file allowlist after the complete build.

When loopback listeners are permitted, the optional Python fixture can serve dist-dot-pairing for a real-browser check. It binds only 127.0.0.1, logs method/path/status without headers or bodies, rejects all non-Dot APIs, and has no grant/approval implementation. Suffix A is a valid fixture, B is expired, C simulates preview failure and recovery. The host used for the November26 local check refused socket.bind, so no real-browser pass was claimed.
