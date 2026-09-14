/** Wait for a usable socket without leaving a prompt callback behind on failure. */
export function waitForSocketOpen(ws: WebSocket, signal: AbortSignal, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Send cancelled')); return; }
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    if (ws.readyState !== WebSocket.CONNECTING) { reject(new Error('WebSocket connection failed')); return; }
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', open);
      ws.removeEventListener('error', fail);
      ws.removeEventListener('close', fail);
      signal.removeEventListener('abort', cancel);
    };
    const open = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('WebSocket connection failed')); };
    const cancel = () => { cleanup(); reject(new Error('Send cancelled')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket connection timed out')); }, timeoutMs);
    ws.addEventListener('open', open);
    ws.addEventListener('error', fail);
    ws.addEventListener('close', fail);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
