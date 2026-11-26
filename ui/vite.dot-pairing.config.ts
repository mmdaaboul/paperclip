// Local browser fixture build only; this does not qualify the complete board build.
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  build: {
    outDir: "dist-dot-pairing",
    rolldownOptions: { input: path.resolve(import.meta.dirname, "./tests/dot-pairing.html") },
  },
});
