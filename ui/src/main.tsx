import { loadUiEntry } from "./lib/ui-entry";

void loadUiEntry(window.location.pathname, {
  board: () => import("./main-board"),
  dot: () => import("./dot-entry").then(({ bootstrapDotPairing }) => bootstrapDotPairing()),
});
