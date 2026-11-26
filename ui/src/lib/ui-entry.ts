const DOT_PAIRING_PATH = /^\/dot-connect\/(pcmcp_request_[A-Za-z0-9_-]{43})$/;

/** Public pairing must be selected before the board's module side effects run. */
export function dotPairingRequestId(pathname: string): string | null {
  return DOT_PAIRING_PATH.exec(pathname)?.[1] ?? null;
}

export function loadUiEntry(pathname: string, loaders: {
  board: () => Promise<unknown>;
  dot: () => Promise<unknown>;
}): Promise<unknown> {
  return dotPairingRequestId(pathname) ? loaders.dot() : loaders.board();
}
