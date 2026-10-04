// Bound observation requests, including response-body reads and transports that
// do not settle promptly on abort. This never cancels a server-side operation.
export async function withRequestDeadline(action, { signal, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = Object.assign(new Error("本地服务响应超时，请重新检查状态"), {
    code: "RUNTIME_REQUEST_TIMEOUT", retryable: true,
  });
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(60_000, timeoutMs)) : 10_000;
  const timer = setTimeout(() => controller.abort(timeout), duration);
  let stop;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const interrupted = new Promise((resolve, reject) => {
      stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", stop, { once: true });
    });
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return action(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
    controller.abort();
  }
}
