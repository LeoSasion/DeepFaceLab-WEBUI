async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    const error = new Error("无法连接本地服务，请确认服务在线后重试");
    error.code = "RUNTIME_UNREACHABLE";
    error.retryable = true;
    error.cause = cause;
    throw error;
  }
  const payload = await response.json().catch(() => ({
    ok: false,
    error: { message: `本地服务返回了无法解析的响应（HTTP ${response.status}）` },
  }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error?.message ?? `请求失败（HTTP ${response.status}）`);
    error.code = payload.error?.code ?? "REQUEST_FAILED";
    error.details = payload.error?.details;
    error.status = response.status;
    error.retryable = response.status === 408
      || response.status === 425
      || response.status === 429
      || response.status >= 500;
    throw error;
  }
  return payload.data;
}

const ACTIVE_OPERATION_STATES = new Set(["queued", "running", "cancelling"]);

function abortError() {
  if (typeof DOMException === "function") {
    return new DOMException("后台操作轮询已取消", "AbortError");
  }
  const error = new Error("后台操作轮询已取消");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason?.name === "AbortError" ? signal.reason : abortError();
}

function wait(milliseconds, { signal } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(signal.reason?.name === "AbortError" ? signal.reason : abortError());
    };
    const timer = globalThis.setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function boundedInterval(value, fallback, { minimum = 100, maximum = 30_000 } = {}) {
  const parsed = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

function notifyProgress(callback, operation, previousFingerprint) {
  const fingerprint = JSON.stringify(operation);
  if (fingerprint === previousFingerprint) return previousFingerprint;
  try {
    callback?.(operation);
  } catch {
    // Progress presentation must not abandon a server-side operation.
  }
  return fingerprint;
}

function operationError(operation) {
  const error = new Error(
    operation?.error?.message
      ?? (operation?.status === "cancelled" ? "操作已取消" : "后台操作未完成"),
  );
  error.code = operation?.error?.code
    ?? (operation?.status === "cancelled" ? "OPERATION_CANCELLED" : "OPERATION_INCOMPLETE");
  error.operation = operation;
  return error;
}

async function runOperation(kind, side, parameters = {}, {
  onProgress,
  pollIntervalMs = 350,
  maxPollIntervalMs = 5_000,
  maxConsecutiveErrors = 5,
  signal,
} = {}) {
  const baseInterval = boundedInterval(pollIntervalMs, 350, { maximum: 5_000 });
  const maximumInterval = boundedInterval(maxPollIntervalMs, 5_000, {
    minimum: baseInterval,
    maximum: 30_000,
  });
  const retryLimit = Math.max(0, Math.min(20, Number.isFinite(Number(maxConsecutiveErrors))
    ? Math.floor(Number(maxConsecutiveErrors))
    : 5));
  throwIfAborted(signal);
  let operation = await request("/api/operations", {
    method: "POST",
    body: JSON.stringify({ kind, side, parameters }),
    signal,
  });
  let progressFingerprint = notifyProgress(onProgress, operation, null);
  let consecutiveErrors = 0;
  while (ACTIVE_OPERATION_STATES.has(operation.status)) {
    const retryMultiplier = consecutiveErrors > 0 ? 2 ** Math.min(consecutiveErrors, 6) : 1;
    await wait(Math.min(maximumInterval, baseInterval * retryMultiplier), { signal });
    try {
      operation = await request(`/api/operations/${encodeURIComponent(operation.id)}`, { signal });
      consecutiveErrors = 0;
      progressFingerprint = notifyProgress(onProgress, operation, progressFingerprint);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      consecutiveErrors += 1;
      if (!error?.retryable || consecutiveErrors > retryLimit) throw error;
    }
  }
  if (operation.status !== "succeeded") throw operationError(operation);
  return operation.result;
}

function operationListFingerprint(records) {
  return JSON.stringify(records);
}

export function watchOperations({
  fetchOperations = ({ signal } = {}) => request("/api/operations", { signal }),
  onUpdate,
  onError,
  pollIntervalMs = 750,
  maxPollIntervalMs = 8_000,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  const baseInterval = boundedInterval(pollIntervalMs, 750);
  const maximumInterval = boundedInterval(maxPollIntervalMs, 8_000, {
    minimum: baseInterval,
    maximum: 60_000,
  });
  let disposed = false;
  let timer = null;
  let requestController = null;
  let consecutiveErrors = 0;
  let errorReported = false;
  let previousFingerprint = null;

  const refresh = async () => {
    requestController = new AbortController();
    try {
      const records = await fetchOperations({ signal: requestController.signal });
      if (disposed) return;
      if (!Array.isArray(records)) {
        const error = new Error("后台操作列表格式无效");
        error.code = "INVALID_OPERATION_LIST";
        throw error;
      }
      const activeRecords = records.filter((item) => ACTIVE_OPERATION_STATES.has(item?.status));
      const fingerprint = operationListFingerprint(activeRecords);
      if (fingerprint !== previousFingerprint) {
        previousFingerprint = fingerprint;
        try {
          onUpdate?.(activeRecords);
        } catch {
          // A presentation callback must not stop monitoring.
        }
      }
      consecutiveErrors = 0;
      errorReported = false;
    } catch (error) {
      if (disposed || error?.name === "AbortError") return;
      consecutiveErrors += 1;
      if (!errorReported) {
        errorReported = true;
        try {
          onError?.(error);
        } catch {
          // Error presentation is isolated from the monitor lifecycle.
        }
      }
    } finally {
      requestController = null;
      if (!disposed) {
        const retryMultiplier = consecutiveErrors > 1
          ? 2 ** Math.min(consecutiveErrors - 1, 6)
          : 1;
        timer = setTimer(refresh, Math.min(maximumInterval, baseInterval * retryMultiplier));
      }
    }
  };

  void refresh();
  return () => {
    disposed = true;
    requestController?.abort();
    if (timer != null) clearTimer(timer);
  };
}

async function uploadVideoWithFetch(side, file, replace) {
  const query = replace ? "?replace=1" : "";
  const response = await fetch(`/api/workspace/import/${side}${query}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: { message: `视频导入返回了无法解析的响应（HTTP ${response.status}）` },
  }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error?.message ?? `视频导入失败（HTTP ${response.status}）`);
    error.code = payload.error?.code ?? "IMPORT_FAILED";
    error.details = payload.error?.details;
    throw error;
  }
  return payload.data;
}

async function uploadVideo(side, file, { replace = false, onProgress } = {}) {
  if (typeof XMLHttpRequest === "undefined" || typeof onProgress !== "function") {
    return uploadVideoWithFetch(side, file, replace);
  }

  const query = replace ? "?replace=1" : "";
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/workspace/import/${side}${query}`);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      onProgress({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null,
        percent: event.lengthComputable && event.total > 0
          ? (event.loaded / event.total) * 100
          : null,
      });
    });
    request.addEventListener("load", () => {
      let payload;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        payload = { ok: false, error: { message: `视频导入返回了无法解析的响应（HTTP ${request.status}）` } };
      }
      if (request.status < 200 || request.status >= 300 || payload.ok === false) {
        const error = new Error(payload.error?.message ?? `视频导入失败（HTTP ${request.status}）`);
        error.code = payload.error?.code ?? "IMPORT_FAILED";
        error.details = payload.error?.details;
        reject(error);
        return;
      }
      onProgress({ loaded: file.size, total: file.size, percent: 100 });
      resolve(payload.data);
    });
    request.addEventListener("error", () => reject(new Error("视频上传连接中断，请检查本地服务后重试")));
    request.addEventListener("abort", () => reject(new Error("视频上传已取消")));
    request.send(file);
  });
}

export const runtimeApi = {
  imageServiceSettings: (options = {}) => request("/api/image-service/settings", options),
  saveImageServiceSettings: (data, options = {}) => request("/api/image-service/settings", {
    ...options, method: "PUT", body: JSON.stringify(data),
  }),
  stageImageInput: (file, options = {}) => request(`/api/image-service/inputs?name=${encodeURIComponent(file.name)}`, {
    ...options, method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", ...options.headers },
  }),
  stageAlignedImageInput: (side, name, options = {}) => request("/api/image-service/inputs/aligned", {
    ...options, method: "POST", body: JSON.stringify({ side, name }),
  }),
  imageServiceTasks: (options = {}) => request("/api/image-service/tasks", options),
  imageServiceTask: (id, options = {}) => request(`/api/image-service/tasks/${encodeURIComponent(id)}`, options),
  createImageServiceTask: (body, options = {}) => request("/api/image-service/tasks", {
    ...options, method: "POST", body: JSON.stringify(body),
  }),
  checkImageServiceTask: (id, options = {}) => request(`/api/image-service/tasks/${encodeURIComponent(id)}/check`, {
    ...options, method: "POST",
  }),
  imageInputUrl: id => `/api/image-service/inputs/${encodeURIComponent(id)}`,
  imageResultUrl: (id, index, { download = false } = {}) => `/api/image-service/tasks/${encodeURIComponent(id)}/results/${index}${download ? "?download=1" : ""}`,

  health: () => request("/api/health"),
  telemetry: () => request("/api/telemetry"),
  commands: () => request("/api/commands"),
  workspace: () => request("/api/workspace"),
  storage: (requiredBytes = 0) => request(
    `/api/system/storage?requiredBytes=${encodeURIComponent(requiredBytes)}`,
  ),
  diagnostics: () => request("/api/system/diagnostics"),
  operations: (options = {}) => request("/api/operations", options),
  operation: (id, options = {}) => request(`/api/operations/${encodeURIComponent(id)}`, options),
  startOperation: (kind, side, parameters = {}, options = {}) => request("/api/operations", {
    ...options,
    method: "POST",
    body: JSON.stringify({ kind, side, parameters }),
  }),
  runOperation,
  watchOperations,
  cancelOperation: (id, options = {}) => request(`/api/operations/${encodeURIComponent(id)}/cancel`, {
    ...options,
    method: "POST",
  }),
  materialArchives: (side, options = {}) => request(
    `/api/workspace/material-archives/${encodeURIComponent(side)}`,
    options,
  ),
  restoreMaterialArchive: (side, token, options = {}) => request(
    `/api/workspace/material-archives/${encodeURIComponent(side)}/${encodeURIComponent(token)}/restore`,
    { ...options, method: "POST" },
  ),
  projects: () => request("/api/projects"),
  createProject: (payload) => request("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  activateProject: (id) => request(`/api/projects/${encodeURIComponent(id)}/activate`, {
    method: "POST",
  }),
  alignedAssets: (side, { offset = 0, limit = 60 } = {}) => request(
    `/api/assets/${side}/aligned?offset=${offset}&limit=${limit}`,
  ),
  alignedPoseAtlas: (side, options = {}) => runOperation("pose-atlas", side, {}, options),
  trainingEvaluationManifests: (modelKey) => request(
    `/api/training-evaluations/${encodeURIComponent(modelKey)}/manifests`,
  ),
  trainingEvaluationSnapshots: (modelKey) => request(
    `/api/training-evaluations/${encodeURIComponent(modelKey)}/snapshots`,
  ),
  trainingEvaluationSnapshot: (modelKey, snapshotId) => request(
    `/api/training-evaluations/${encodeURIComponent(modelKey)}`
      + `/snapshots/${encodeURIComponent(snapshotId)}`,
  ),
  alignedAudit: (side, {
    refresh = false, offset = 0, limit = 120, ...operationOptions
  } = {}) => runOperation(
    "asset-audit",
    side,
    { refresh, offset, limit },
    operationOptions,
  ),
  alignedSimilarity: (side, {
    refresh = false, threshold = 0.86, limit = 500, ...operationOptions
  } = {}) => runOperation(
    "similarity",
    side,
    { refresh, threshold, limit },
    operationOptions,
  ),
  alignedPack: (side, { refresh = false, ...operationOptions } = {}) => runOperation(
    "pack",
    side,
    { refresh },
    operationOptions,
  ),
  extractionCoverage: (side, {
    refresh = false, offset = 0, limit = 120, ...operationOptions
  } = {}) => runOperation(
    "coverage",
    side,
    { refresh, offset, limit },
    operationOptions,
  ),
  mergeReview: ({ offset = 0, limit = 120 } = {}) => request(
    `/api/tools/merge-review?offset=${offset}&limit=${limit}`,
  ),
  exportPreflight: () => request("/api/tools/export-preflight"),
  alignedAnnotation: (side, name) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/annotation`,
  ),
  saveAlignedAnnotation: (side, name, polygons) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/annotation`,
    {
      method: "PUT",
      body: JSON.stringify({ polygons }),
    },
  ),
  previewAlignedRepair: (side, name, landmarks) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/alignment-preview`,
    { method: "POST", body: JSON.stringify({ landmarks }) },
  ),
  applyAlignedRepair: (side, name, landmarks) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/alignment-apply`,
    { method: "POST", body: JSON.stringify({ landmarks }) },
  ),
  alignedRepairBackups: (side) => request(`/api/assets/${side}/alignment-backups`),
  restoreAlignedRepair: (side, token, name) => request(
    `/api/assets/${side}/alignment-backups/${encodeURIComponent(token)}/${encodeURIComponent(name)}/restore`,
    { method: "POST" },
  ),
  quarantineAligned: (side, name) => request(
    `/api/assets/${side}/aligned/${encodeURIComponent(name)}/quarantine`,
    { method: "POST" },
  ),
  quarantineAlignedBatch: (side, names) => request(
    `/api/assets/${side}/aligned/quarantine-batch`,
    { method: "POST", body: JSON.stringify({ names }) },
  ),
  alignedQuarantine: (side, { offset = 0, limit = 60 } = {}) => request(
    `/api/assets/${side}/quarantine?offset=${offset}&limit=${limit}`,
  ),
  quarantinedAnnotation: (side, token, name) => request(
    `/api/assets/${side}/quarantine/${encodeURIComponent(token)}`
      + `/${encodeURIComponent(name)}/annotation`,
  ),
  restoreAligned: (side, token, name) => request(
    `/api/assets/${side}/quarantine/${encodeURIComponent(token)}/${encodeURIComponent(name)}/restore`,
    { method: "POST" },
  ),
  importVideo: uploadVideo,
  videoTimeline: (side) => request(`/api/tools/video/${side}/timeline`),
  detectVideoScenes: (side, threshold, options = {}) => runOperation(
    "detect-scenes",
    side,
    { threshold },
    options,
  ),
  saveVideoSegments: (side, segments) => request(`/api/tools/video/${side}/segments`, {
    method: "PUT",
    body: JSON.stringify({ segments }),
  }),
  extractVideoSegments: (side, segments, fps = 0) => request(
    `/api/tools/video/${side}/extract-segments`,
    { method: "POST", body: JSON.stringify({ segments, fps }) },
  ),
  frameArchives: (side) => request(`/api/tools/video/${side}/frame-archives`),
  restoreFrameArchive: (side, token) => request(
    `/api/tools/video/${side}/frame-archives/${encodeURIComponent(token)}/restore`,
    { method: "POST" },
  ),
  archiveCompletedJobs: () => request("/api/jobs/archive-completed", { method: "POST" }),
  preflight: (commandId, options = {}) => request(
    `/api/commands/${encodeURIComponent(commandId)}/preflight`,
    {
      method: "POST",
      body: JSON.stringify(options),
    },
  ),
  jobs: () => request("/api/jobs"),
  events: (jobId, after = 0) => request(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${after}`),
  start: (commandId, options = {}) => request("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ commandId, ...options }),
  }),
  input: (jobId, input) => request(`/api/jobs/${encodeURIComponent(jobId)}/input`, {
    method: "POST",
    body: JSON.stringify({ input }),
  }),
  control: (jobId, operation) => request(`/api/jobs/${encodeURIComponent(jobId)}/control`, {
    method: "POST",
    body: JSON.stringify({ operation }),
  }),
  retry: (jobId) => request(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
};

export function runtimeWebSocketUrl(jobId, after = 0) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ jobId, after: String(after) });
  return `${protocol}//${window.location.host}/ws?${query}`;
}
