// Lifecycle only: no credential reads, manifest exchange, or network implementation.
export function startSetupListener(
  server,
  options,
  clock = { setTimeout, clearTimeout },
) {
  const { port, signal, onListening, onStop, timeoutMs = 300_000 } = options;
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3_600_000
  ) {
    throw new Error("invalid setup listener limits");
  }
  let ended = false;
  let started = false;
  let timer;
  const cleanup = () => {
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      timer = undefined;
    }
    signal?.removeEventListener("abort", abort);
    server.removeListener("error", failed);
  };
  const stop = (reason, error) => {
    if (ended) return;
    ended = true;
    cleanup();
    if (started) {
      server.close();
      server.closeAllConnections?.();
    }
    onStop?.(reason, error);
  };
  const abort = () => stop("aborted");
  const failed = (error) => stop("listen-failed", error);
  if (signal?.aborted) {
    stop("aborted");
    return;
  }
  server.once("close", () => {
    ended = true;
    cleanup();
  });
  server.once("error", failed);
  signal?.addEventListener("abort", abort, { once: true });
  timer = clock.setTimeout(() => stop("timeout"), timeoutMs);
  timer.unref?.();
  started = true;
  try {
    server.listen(port, "127.0.0.1", onListening);
  } catch (error) {
    failed(error);
  }
}
