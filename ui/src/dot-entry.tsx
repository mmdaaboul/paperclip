import { StrictMode, useEffect, useRef } from "react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ConnectionStatusBanner } from "./components/ConnectionStatusBanner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ThemeProvider } from "./context/ThemeContext";
import { McpConnectRequest } from "./pages/McpConnectRequest";
import { ConnectivityProvider } from "./lib/connectivity";
import { createDotPairingRuntime, type DotPairingRuntime } from "./lib/dot-pairing-runtime";
import { getOrCreatePaperclipReactRoot, type PaperclipReactRootHost } from "./lib/react-root";
import "./index.css";

function DotPairingRoute({ runtime, navigateDocument }: {
  runtime: DotPairingRuntime;
  navigateDocument: (url: string) => void;
}) {
  const location = useLocation();
  const leave = location.pathname !== runtime.pathname;
  const handedOff = useRef<string | null>(null);
  useEffect(() => {
    const target = location.pathname + location.search + location.hash;
    if (leave && handedOff.current !== target) {
      handedOff.current = target;
      navigateDocument(target);
    }
  }, [leave, location.pathname, location.search, location.hash, navigateDocument]);
  if (leave) return null;
  return <><ConnectionStatusBanner /><McpConnectRequest id={runtime.requestId} agentPairingOnly /></>;
}

/** No session/company providers, persisted query cache or service-worker boot. */
export function DotPairingApp({ runtime, navigateDocument = url => window.location.assign(window.location.origin + url) }: {
  runtime: DotPairingRuntime;
  navigateDocument?: (url: string) => void;
}) {
  return <AppErrorBoundary><ConnectivityProvider store={runtime.store}>
    <QueryClientProvider client={runtime.client}><ThemeProvider><BrowserRouter>
      <TooltipProvider><DotPairingRoute runtime={runtime} navigateDocument={navigateDocument} /></TooltipProvider>
    </BrowserRouter></ThemeProvider></QueryClientProvider>
  </ConnectivityProvider></AppErrorBoundary>;
}

let activeEntry: { pathname: string; dispose: () => void } | null = null;

export function bootstrapDotPairing(reloadDocument = () => window.location.reload()) {
  if (activeEntry?.pathname === window.location.pathname) return activeEntry.dispose;
  activeEntry?.dispose();
  const container = document.getElementById("root");
  if (!container) throw new Error("Paperclip root element is missing");
  const runtime = createDotPairingRuntime(window.location.pathname);
  const root = getOrCreatePaperclipReactRoot(window, container);
  const host = window as Window & PaperclipReactRootHost;
  let disposed = false;
  const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
  // A restored capability page must re-check expiry and drop its old preview/code.
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) reloadDocument(); };
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    if (host.__paperclipReactRoot === root) {
      root.unmount();
      delete host.__paperclipReactRoot;
    }
    runtime.dispose();
    if (activeEntry?.dispose === dispose) activeEntry = null;
  }
  activeEntry = { pathname: runtime.pathname, dispose };
  root.render(<StrictMode><DotPairingApp runtime={runtime} /></StrictMode>);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  return dispose;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => activeEntry?.dispose());
  import.meta.hot.accept(module => module?.bootstrapDotPairing());
}
