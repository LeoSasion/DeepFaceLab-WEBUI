import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { releaseVersion } from "../../release/version.mjs";
import {
  auditAlignedAssets,
  applyAlignedRepair,
  buildAlignedPoseAtlas,
  buildAlignedSimilarityGroups,
  inspectAlignedPack,
  inspectAlignedAnnotation,
  inspectQuarantinedAnnotation,
  inspectExtractionCoverage,
  listAlignedAssets,
  listAlignedRepairBackups,
  listAlignedQuarantine,
  previewAlignedRepair,
  quarantineAlignedImage,
  quarantineAlignedImages,
  restoreAlignedRepair,
  restoreAlignedImage,
  saveAlignedAnnotation,
  streamAlignedImage,
  streamAlignedPoster,
  streamQuarantinedImage,
} from "./asset-manager.mjs";
import { listCommands, prepareCommand } from "./command-registry.mjs";
import { describeEnvironment } from "./environment.mjs";
import { DisabledExternalWindowAdapter } from "./external-window-adapter.mjs";
import { JobManager } from "./job-manager.mjs";
import { OperationManager } from "./operation-manager.mjs";
import { ImageServiceManager } from "./image-service-manager.mjs";
import { PATHS, pathExists } from "./paths.mjs";
import { ProjectManager } from "./project-manager.mjs";
import { buildDiagnosticSnapshot, inspectStorage } from "./system-diagnostics.mjs";
import { getGpuTelemetry } from "./telemetry.mjs";
import { TrainingEvaluationManager } from "./training-evaluation-manager.mjs";
import {
  importWorkspaceVideo,
  inspectExportReadiness,
  inspectWorkspace,
  listMergeReview,
  listWorkspaceMaterialArchives,
  resolveReviewAsset,
  resolveWorkspaceArtifact,
  resolveWorkspaceMaterial,
  restoreWorkspaceMaterial,
} from "./workspace-manager.mjs";
import {
  detectVideoScenes,
  extractVideoSegments,
  inspectVideoTimeline,
  listFrameArchives,
  restoreFrameArchive,
  saveVideoSegments,
} from "./video-tool-manager.mjs";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;

async function readImageInput(request) {
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > MAX_IMAGE_INPUT_BYTES) {
    throw apiError("单张图片不能超过 50 MB", "IMAGE_INPUT_TOO_LARGE", 413);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_IMAGE_INPUT_BYTES) {
      throw apiError("单张图片不能超过 50 MB", "IMAGE_INPUT_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  if (request.aborted) throw apiError("本地图片暂存已中断", "IMAGE_INPUT_ABORTED", 400);
  return Buffer.concat(chunks, bytes);
}

async function sendImageServiceFile(response, file, { download = false } = {}) {
  const info = await stat(file.path);
  response.writeHead(200, {
    "Content-Type": file.mimeType,
    "Content-Length": info.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(download ? {
      "Content-Disposition": `attachment; filename="image${path.extname(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    } : {}),
  });
  createReadStream(file.path).on("error", () => response.destroy()).pipe(response);
}
export const LARGE_UPLOAD_REQUEST_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const PROJECT_RESTART_RETRY_MS = 2_000;
export const SUPPORTED_OPERATION_KINDS = Object.freeze([
  "asset-audit",
  "pose-atlas",
  "similarity",
  "pack",
  "coverage",
  "detect-scenes",
]);
const OPERATION_KIND_SET = new Set(SUPPORTED_OPERATION_KINDS);
const OPERATION_STAGE_LABELS = Object.freeze({
  "audit-samples": "分析素材质量",
  "coverage-alignments": "关联 aligned 人脸",
  "coverage-frames": "检查源帧覆盖",
  "pose-atlas": "估计姿态与质量",
  "similarity-features": "提取相似度特征",
  "similarity-pairs": "比较相似样本",
  "similarity-groups": "整理相似样本组",
});
const RUNTIME_VERSION = releaseVersion.version;
const SESSION_COOKIE = "dfl_web_session";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const ACTIVE_JOB_STATES = new Set(["queued", "starting", "running", "waiting_input", "stopping"]);
const ACTIVE_OPERATION_STATES = new Set(["queued", "running", "cancelling"]);
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://terminal.local:4173",
]);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status >= 500 ? "本地服务发生错误" : error?.message ?? "请求失败";
  sendJson(response, status, {
    ok: false,
    error: {
      code: error?.code ?? "INTERNAL_ERROR",
      message,
      ...(error?.details ? { details: error.details } : {}),
    },
  });
}

function runtimeConflict(message, code, details) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.details = details;
  return error;
}

function apiError(message, code, status = 400, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function parseRequiredBytes(value) {
  if (value == null || value === "") return 0;
  if (!/^\d+$/.test(String(value))) {
    throw apiError("requiredBytes 必须是非负整数字节数", "REQUIRED_BYTES_INVALID");
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) {
    throw apiError("requiredBytes 超出安全整数范围", "REQUIRED_BYTES_INVALID");
  }
  return bytes;
}

async function sendVideoArtifact(request, response, target) {
  if (!(await pathExists(target))) {
    return sendJson(response, 404, {
      ok: false,
      error: { code: "ARTIFACT_MISSING", message: "输出文件尚未生成" },
    });
  }
  const fileStat = await stat(target);
  const contentType = path.extname(target).toLowerCase() === ".avi"
    ? "video/x-msvideo"
    : path.extname(target).toLowerCase() === ".mov"
      ? "video/quicktime"
      : "video/mp4";
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileStat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    return createReadStream(target).pipe(response);
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), fileStat.size - 1) : fileStat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= fileStat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
    return response.end();
  }
  response.writeHead(206, {
    "Content-Type": contentType,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  return createReadStream(target, { start, end }).pipe(response);
}

async function sendReviewImage(response, target) {
  if (!(await pathExists(target))) {
    return sendJson(response, 404, {
      ok: false,
      error: { code: "REVIEW_IMAGE_MISSING", message: "复核图片尚未生成" },
    });
  }
  const fileStat = await stat(target);
  const extension = path.extname(target).toLowerCase();
  const contentType = extension === ".png"
    ? "image/png"
    : extension === ".webp"
      ? "image/webp"
      : "image/jpeg";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fileStat.size,
    "Cache-Control": "private, max-age=30",
  });
  return createReadStream(target).pipe(response);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf("=");
        return separator === -1
          ? [decodeURIComponent(item), ""]
          : [decodeURIComponent(item.slice(0, separator)), decodeURIComponent(item.slice(separator + 1))];
      }),
  );
}

function safeTokenEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求体过大");
      error.code = "REQUEST_TOO_LARGE";
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("JSON 请求体无效");
    error.code = "INVALID_JSON";
    error.status = 400;
    throw error;
  }
}

function isWriteRequest(request) {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
}

export class RuntimeServer {
  constructor({
    trainingEvaluationManager = new TrainingEvaluationManager(),
    jobManager = null,
    operationManager = new OperationManager(),
    imageServiceManager = new ImageServiceManager(),
    externalWindowAdapter = new DisabledExternalWindowAdapter(),
    projectManager = new ProjectManager(),
    commandPreparer = prepareCommand,
    onProjectActivation = null,
    requestProcessExit = (code) => process.exit(code),
    requestTimeoutMs = LARGE_UPLOAD_REQUEST_TIMEOUT_MS,
    projectRestartRetryMs = PROJECT_RESTART_RETRY_MS,
    staticRoot = PATHS.staticRoot,
    allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  } = {}) {
    this.trainingEvaluationManager = trainingEvaluationManager;
    this.jobManager = jobManager ?? new JobManager({ trainingEvaluationManager });
    this.operationManager = operationManager;
    this.imageServiceManager = imageServiceManager;
    this.imageServiceInitializationError = null;
    this.externalWindowAdapter = externalWindowAdapter;
    this.projectManager = projectManager;
    this.commandPreparer = commandPreparer;
    this.onProjectActivation = onProjectActivation ?? ((result) => this.scheduleProjectRestart(result));
    this.requestProcessExit = requestProcessExit;
    this.requestTimeoutMs = Math.max(Number(requestTimeoutMs) || LARGE_UPLOAD_REQUEST_TIMEOUT_MS, 5 * 60 * 1000);
    this.projectRestartRetryMs = Math.max(500, Number(projectRestartRetryMs) || PROJECT_RESTART_RETRY_MS);
    this.staticRoot = staticRoot;
    this.allowedOrigins = new Set(allowedOrigins);
    this.sessionToken = randomBytes(32).toString("hex");
    this.workspaceMutation = null;
    this.projectRestartPending = false;
    this.projectRestartTimer = null;
    this.projectRestartBusyWarningIssued = false;
    this.httpServer = null;
    this.webSocketServer = null;
  }

  async start({ host = "127.0.0.1", port = 4174 } = {}) {
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error("本地运行时只允许监听 loopback 地址");
    }
    await Promise.all([
      this.jobManager.initialize(),
      this.operationManager.initialize(),
      this.trainingEvaluationManager.initialize(),
      Promise.resolve().then(() => this.imageServiceManager.initialize()).catch(error => {
        // An unreadable optional image-service record must not disable DFL.
        // Preserve the file and report an unknown state on this feature's API.
        this.imageServiceInitializationError = error;
      }),
    ]);
    this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.httpServer = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.httpServer.requestTimeout = this.requestTimeoutMs;
    this.httpServer.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
    const address = this.address();
    if (address) {
      for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
        this.allowedOrigins.add(`http://${hostname}:${address.port}`);
      }
    }
    return address;
  }

  address() {
    const address = this.httpServer?.address();
    return typeof address === "object" && address
      ? { host: address.address, port: address.port }
      : null;
  }

  activeJobs() {
    if (typeof this.jobManager.activeJobs === "function") return this.jobManager.activeJobs();
    return this.jobManager.list().filter((job) => ACTIVE_JOB_STATES.has(job?.state));
  }

  activeOperations() {
    return [
      ...this.operationManager.list().filter((operation) => ACTIVE_OPERATION_STATES.has(operation?.status)),
      ...(this.imageServiceManager.activeTasks?.() ?? []),
    ];
  }

  scheduleProjectRestart(result) {
    if (!result.restartRequired) return;
    this.projectRestartPending = true;
    this.projectRestartBusyWarningIssued = false;
    this.armProjectRestart(250);
  }

  armProjectRestart(delayMs) {
    if (this.projectRestartTimer) clearTimeout(this.projectRestartTimer);
    this.projectRestartTimer = setTimeout(() => {
      this.projectRestartTimer = null;
      void (async () => {
        const activeJobs = this.activeJobs();
        const activeOperations = this.activeOperations();
        if (activeJobs.length || activeOperations.length) {
          if (!this.projectRestartBusyWarningIssued) {
            this.projectRestartBusyWarningIssued = true;
            this.jobManager.emit?.("warning", {
              message: "项目切换后的计划重启正在等待运行中任务结束，服务不会放弃任务控制权",
              jobId: activeJobs[0]?.id,
              operationId: activeOperations[0]?.id,
            });
          }
          this.armProjectRestart(this.projectRestartRetryMs);
          return;
        }
        try {
          await this.stop({ plannedRestart: true });
          this.requestProcessExit(75);
        } catch (error) {
          if (["RUNTIME_RESTART_JOB_BUSY", "RUNTIME_RESTART_OPERATION_BUSY"].includes(error?.code)) {
            this.armProjectRestart(this.projectRestartRetryMs);
            return;
          }
          this.projectRestartPending = false;
          this.projectRestartBusyWarningIssued = false;
          this.jobManager.emit?.("warning", {
            message: "项目切换后的计划重启失败，请手动重启本地服务",
            error,
          });
        }
      })();
    }, delayMs);
    this.projectRestartTimer.unref?.();
  }

  async stop({ plannedRestart = false } = {}) {
    const activeJobs = this.activeJobs();
    if (plannedRestart && activeJobs.length) {
      throw runtimeConflict(
        "运行中的任务阻止本地服务计划重启；请先安全停止任务",
        "RUNTIME_RESTART_JOB_BUSY",
        { jobIds: activeJobs.map((job) => job.id) },
      );
    }
    const activeOperations = this.activeOperations();
    if (plannedRestart && activeOperations.length) {
      throw runtimeConflict(
        "运行中的后台操作阻止本地服务计划重启；请等待操作完成或取消操作",
        "RUNTIME_RESTART_OPERATION_BUSY",
        { operationIds: activeOperations.map((operation) => operation.id) },
      );
    }
    if (!plannedRestart) {
      if (this.projectRestartTimer) clearTimeout(this.projectRestartTimer);
      this.projectRestartTimer = null;
      this.projectRestartPending = false;
      this.projectRestartBusyWarningIssued = false;
    }
    await this.jobManager.flushAll?.();
    await this.imageServiceManager.close?.();
    for (const client of this.webSocketServer?.clients ?? []) client.close(1001, "服务停止");
    await new Promise((resolve) => {
      if (!this.httpServer?.listening) return resolve();
      this.httpServer.close(() => resolve());
    });
    this.webSocketServer?.close();
  }

  requestHasSession(request) {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return safeTokenEqual(token, this.sessionToken);
  }

  assertNoWorkspaceMutation() {
    if (this.projectRestartPending) {
      throw runtimeConflict(
        "项目已切换，正在重启本地服务；请稍候",
        "PROJECT_RESTART_PENDING",
      );
    }
    if (this.workspaceMutation) {
      throw runtimeConflict(
        `工作区正在执行“${this.workspaceMutation}”，请等待完成后重试`,
        "WORKSPACE_MUTATION_BUSY",
        { operation: this.workspaceMutation },
      );
    }
  }

  async withWorkspaceMutation(operation, callback, { allowActiveJobs = false } = {}) {
    this.assertNoWorkspaceMutation();
    const activeJobs = this.jobManager.list().filter((job) => ACTIVE_JOB_STATES.has(job?.state));
    if (!allowActiveJobs && activeJobs.length) {
      throw runtimeConflict(
        "运行中的任务会占用工作区；请先安全停止任务再修改素材或数据集",
        "WORKSPACE_JOB_BUSY",
        { jobIds: activeJobs.map((job) => job.id) },
      );
    }
    this.workspaceMutation = operation;
    try {
      return await callback();
    } finally {
      this.workspaceMutation = null;
    }
  }

  operationSpec(body = {}) {
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    if (!OPERATION_KIND_SET.has(kind)) {
      throw apiError(
        "不支持的后台操作类型",
        "OPERATION_KIND_NOT_ALLOWED",
        400,
        { allowedKinds: SUPPORTED_OPERATION_KINDS },
      );
    }
    const parameters = body.parameters && typeof body.parameters === "object" && !Array.isArray(body.parameters)
      ? body.parameters
      : body;
    const side = body.side ?? parameters.side;
    if (!["src", "dst"].includes(side)) {
      throw apiError("后台操作需要指定 src 或 dst", "OPERATION_SIDE_INVALID");
    }
    const refresh = parameters.refresh === true;
    const definitions = {
      "asset-audit": {
        label: `${side.toUpperCase()} 数据审计`,
        stage: "分析素材质量",
        run: ({ signal, onProgress }) => auditAlignedAssets(side, {
          refresh,
          offset: parameters.offset,
          limit: parameters.limit,
          signal,
          onProgress,
        }),
      },
      "pose-atlas": {
        label: `${side.toUpperCase()} 姿势图谱`,
        stage: "生成姿势图谱",
        run: ({ signal, onProgress }) => buildAlignedPoseAtlas(side, { signal, onProgress }),
      },
      similarity: {
        label: `${side.toUpperCase()} 相似样本分析`,
        stage: "生成相似样本候选",
        run: ({ signal, onProgress }) => buildAlignedSimilarityGroups(side, {
          refresh,
          threshold: parameters.threshold,
          limit: parameters.limit,
          signal,
          onProgress,
        }),
      },
      pack: {
        label: `${side.toUpperCase()} 对齐包检查`,
        stage: "检查对齐包",
        run: ({ signal }) => inspectAlignedPack(side, { refresh, signal }),
      },
      coverage: {
        label: `${side.toUpperCase()} 提取覆盖检查`,
        stage: "检查提取覆盖",
        run: ({ signal, onProgress }) => inspectExtractionCoverage(side, {
          refresh,
          offset: parameters.offset,
          limit: parameters.limit,
          signal,
          onProgress,
        }),
      },
      "detect-scenes": {
        label: `${side.toUpperCase()} 场景检测`,
        stage: "检测视频场景",
        cancellable: false,
        run: () => detectVideoScenes(side, { threshold: parameters.threshold }),
      },
    };
    return { kind, side, ...definitions[kind] };
  }

  async startOperation(body) {
    const spec = this.operationSpec(body);
    return this.operationManager.start(
      spec.kind,
      async ({ signal, report }) => {
        await report({ stage: "准备输入" });
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        await report({ stage: spec.stage });
        let progressError = null;
        let progressWrites = Promise.resolve();
        const onProgress = (update = {}) => {
          progressWrites = progressWrites
            .then(() => report({
              ...update,
              stage: OPERATION_STAGE_LABELS[update.stage] ?? spec.stage,
            }))
            .catch((error) => {
              progressError ??= error;
            });
        };
        const result = await spec.run({ signal, onProgress });
        await progressWrites;
        if (progressError) throw progressError;
        await report({ stage: "整理结果" });
        return result;
      },
      {
        label: spec.label,
        cancellable: spec.cancellable !== false,
        detail: `${spec.side.toUpperCase()} · ${spec.kind}`,
      },
    );
  }

  async inspectSystemStorage(requiredBytes) {
    return inspectStorage(PATHS.workspaceRoot, { requiredBytes });
  }

  async buildSystemDiagnostic() {
    const [workspace, telemetry, storage, pythonAvailable, currentAvailable, legacyAvailable, workspaceAvailable] =
      await Promise.all([
        inspectWorkspace(),
        getGpuTelemetry(),
        inspectStorage(PATHS.workspaceRoot),
        pathExists(PATHS.python),
        pathExists(PATHS.currentMain),
        pathExists(PATHS.legacyMain),
        pathExists(PATHS.workspaceRoot),
      ]);
    return buildDiagnosticSnapshot({
      version: RUNTIME_VERSION,
      workspace: { ...workspace, projectId: PATHS.activeProject.id },
      telemetry,
      storage,
      jobs: this.jobManager.list().map((job) => ({
        ...job,
        status: job.state,
        finishedAt: job.endedAt,
      })),
      runtime: {
        profile: "local",
        pythonAvailable,
        currentAvailable,
        legacyAvailable,
        workspaceAvailable,
      },
    });
  }

  async listMaterialArchives(side) {
    return listWorkspaceMaterialArchives(side);
  }

  async restoreMaterialArchive(side, token) {
    return restoreWorkspaceMaterial(side, token);
  }

  async handleRequest(request, response) {
    try {
      if (!isAllowedOrigin(request.headers.origin, this.allowedOrigins)) {
        return sendJson(response, 403, {
          ok: false,
          error: { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不是本机 Web 管理器" },
        });
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { Allow: "GET,HEAD,POST,PUT,OPTIONS" });
        return response.end();
      }

      const baseUrl = `http://${request.headers.host ?? "127.0.0.1"}`;
      const url = new URL(request.url ?? "/", baseUrl);
      if (url.pathname.startsWith("/api/")) {
        if (isWriteRequest(request) && !this.requestHasSession(request)) {
          return sendJson(response, 403, {
            ok: false,
            error: { code: "SESSION_REQUIRED", message: "本地服务会话已失效，请刷新页面" },
          });
        }
        return await this.handleApi(request, response, url);
      }
      return await this.serveStatic(request, response, url);
    } catch (error) {
      return sendError(response, error);
    }
  }

  async handleApi(request, response, url) {
    if (url.pathname.startsWith("/api/image-service/") && this.imageServiceInitializationError) {
      throw this.imageServiceInitializationError;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const [pythonAvailable, currentAvailable, legacyAvailable, workspaceAvailable] =
        await Promise.all([
          pathExists(PATHS.python),
          pathExists(PATHS.currentMain),
          pathExists(PATHS.legacyMain),
          pathExists(PATHS.workspaceRoot),
        ]);
      return sendJson(
        response,
        200,
        {
          ok: true,
          data: {
            service: "DeepFaceLabSN Local Runtime",
            version: RUNTIME_VERSION,
            loopbackOnly: true,
            runtime: {
              pythonAvailable,
              currentAvailable,
              legacyAvailable,
              workspaceAvailable,
              current: describeEnvironment("current"),
              legacy: describeEnvironment("legacy"),
            },
            project: PATHS.activeProject,
            capabilities: {
              pty: true,
              websocket: true,
              trainerBridge: true,
              persistentLogs: true,
              externalWindows: this.externalWindowAdapter.capabilities(),
            },
          },
        },
        {
          "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(this.sessionToken)}; Path=/; HttpOnly; SameSite=Strict`,
        },
      );
    }

    if (request.method === "GET" && url.pathname === "/api/commands") {
      return sendJson(response, 200, { ok: true, data: listCommands() });
    }
    if (request.method === "GET" && url.pathname === "/api/image-service/settings") {
      return sendJson(response, 200, { ok: true, data: await this.imageServiceManager.settings() });
    }
    if (request.method === "PUT" && url.pathname === "/api/image-service/settings") {
      this.assertNoWorkspaceMutation();
      return sendJson(response, 200, { ok: true, data: await this.imageServiceManager.saveSettings(await readJsonBody(request)) });
    }
    if (request.method === "POST" && url.pathname === "/api/image-service/inputs") {
      this.assertNoWorkspaceMutation();
      return sendJson(response, 201, { ok: true, data: await this.withWorkspaceMutation("暂存图像素材", async () => (
        this.imageServiceManager.stageInput({ name: url.searchParams.get("name"), bytes: await readImageInput(request) })
      ), { allowActiveJobs: true }) });
    }
    if (request.method === "POST" && url.pathname === "/api/image-service/inputs/aligned") {
      const body = await readJsonBody(request);
      return sendJson(response, 201, { ok: true, data: await this.withWorkspaceMutation("暂存已选 aligned 图片", () => (
        this.imageServiceManager.stageAligned({ side: body.side, name: body.name })
      ), { allowActiveJobs: true }) });
    }
    if (request.method === "GET" && url.pathname === "/api/image-service/tasks") {
      return sendJson(response, 200, { ok: true, data: await this.imageServiceManager.listTasks() });
    }
    if (request.method === "POST" && url.pathname === "/api/image-service/tasks") {
      const body = await readJsonBody(request);
      return sendJson(response, 202, { ok: true, data: await this.withWorkspaceMutation("提交图像生成任务", () => (
        this.imageServiceManager.createTask(body)
      ), { allowActiveJobs: true }) });
    }
    const imageTaskCheck = url.pathname.match(/^\/api\/image-service\/tasks\/([a-z0-9_-]{1,128})\/check$/i);
    if (request.method === "POST" && imageTaskCheck) {
      this.assertNoWorkspaceMutation();
      return sendJson(response, 200, { ok: true, data: await this.imageServiceManager.checkTask(imageTaskCheck[1]) });
    }
    const imageTaskResult = url.pathname.match(/^\/api\/image-service\/tasks\/([a-z0-9_-]{1,128})\/results\/(\d{1,2})$/i);
    if (request.method === "GET" && imageTaskResult) {
      return sendImageServiceFile(response, await this.imageServiceManager.resultFile(imageTaskResult[1], Number(imageTaskResult[2])), {
        download: url.searchParams.get("download") === "1",
      });
    }
    const imageTask = url.pathname.match(/^\/api\/image-service\/tasks\/([a-z0-9_-]{1,128})$/i);
    if (request.method === "GET" && imageTask) {
      const task = await this.imageServiceManager.getTask(imageTask[1]);
      if (!task) throw apiError("图像任务不存在", "IMAGE_TASK_NOT_FOUND", 404);
      return sendJson(response, 200, { ok: true, data: task });
    }
    const imageInput = url.pathname.match(/^\/api\/image-service\/inputs\/([a-z0-9_-]{1,128})$/i);
    if (request.method === "GET" && imageInput) {
      return sendImageServiceFile(response, await this.imageServiceManager.inputFile(imageInput[1]));
    }
    if (request.method === "GET" && url.pathname === "/api/telemetry") {
      return sendJson(response, 200, { ok: true, data: await getGpuTelemetry() });
    }
    if (request.method === "GET" && url.pathname === "/api/workspace") {
      return sendJson(response, 200, { ok: true, data: await inspectWorkspace() });
    }
    if (request.method === "GET" && url.pathname === "/api/system/storage") {
      const requiredBytes = parseRequiredBytes(url.searchParams.get("requiredBytes"));
      return sendJson(response, 200, {
        ok: true,
        data: await this.inspectSystemStorage(requiredBytes),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/system/diagnostics") {
      return sendJson(response, 200, { ok: true, data: await this.buildSystemDiagnostic() });
    }
    if (request.method === "GET" && url.pathname === "/api/operations") {
      return sendJson(response, 200, { ok: true, data: this.operationManager.list() });
    }
    if (request.method === "POST" && url.pathname === "/api/operations") {
      return sendJson(response, 202, {
        ok: true,
        data: await this.startOperation(await readJsonBody(request)),
      });
    }
    const operationCancelMatch = url.pathname.match(/^\/api\/operations\/(op-[a-z0-9-]+)\/cancel$/i);
    if (request.method === "POST" && operationCancelMatch) {
      const operation = await this.operationManager.cancel(operationCancelMatch[1]);
      if (!operation) throw apiError("后台操作不存在", "OPERATION_NOT_FOUND", 404);
      return sendJson(response, 200, { ok: true, data: operation });
    }
    const operationMatch = url.pathname.match(/^\/api\/operations\/(op-[a-z0-9-]+)$/i);
    if (request.method === "GET" && operationMatch) {
      const operation = this.operationManager.get(operationMatch[1]);
      if (!operation) throw apiError("后台操作不存在", "OPERATION_NOT_FOUND", 404);
      return sendJson(response, 200, { ok: true, data: operation });
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      return sendJson(response, 200, { ok: true, data: await this.projectManager.list() });
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      return sendJson(response, 201, {
        ok: true,
        data: await this.projectManager.create(await readJsonBody(request)),
      });
    }
    const projectActivateMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-]{0,47})\/activate$/);
    if (request.method === "POST" && projectActivateMatch) {
      const imageTasks = this.imageServiceManager.activeTasks?.() ?? [];
      if (imageTasks.length) throw runtimeConflict("图像任务正在上传、生成或保存，请等待任务暂停或结束后切换项目", "PROJECT_IMAGE_TASK_BUSY", {
        taskIds: imageTasks.map(task => task.id),
      });
      const result = await this.withWorkspaceMutation("切换项目", () => (
        this.projectManager.activate(projectActivateMatch[1], this.jobManager.list())
      ));
      if (result.restartRequired) this.projectRestartPending = true;
      this.onProjectActivation(result);
      return sendJson(response, 200, { ok: true, data: result });
    }
    const evaluationManifestsMatch = url.pathname.match(
      /^\/api\/training-evaluations\/([a-z0-9][a-z0-9_-]{0,63})\/manifests$/,
    );
    if (request.method === "GET" && evaluationManifestsMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.trainingEvaluationManager.listManifests(evaluationManifestsMatch[1]),
      });
    }
    const evaluationSnapshotsMatch = url.pathname.match(
      /^\/api\/training-evaluations\/([a-z0-9][a-z0-9_-]{0,63})\/snapshots$/,
    );
    if (request.method === "GET" && evaluationSnapshotsMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.trainingEvaluationManager.listSnapshots(evaluationSnapshotsMatch[1]),
      });
    }
    const evaluationArchiveMatch = url.pathname.match(
      /^\/api\/training-evaluations\/([a-z0-9][a-z0-9_-]{0,63})\/archive$/,
    );
    if (request.method === "POST" && evaluationArchiveMatch) {
      const body = await readJsonBody(request);
      return sendJson(response, 200, {
        ok: true,
        data: await this.trainingEvaluationManager.archiveSnapshots(
          evaluationArchiveMatch[1],
          body.snapshotIds,
        ),
      });
    }
    const evaluationRestoreMatch = url.pathname.match(
      /^\/api\/training-evaluations\/([a-z0-9][a-z0-9_-]{0,63})\/restore$/,
    );
    if (request.method === "POST" && evaluationRestoreMatch) {
      const body = await readJsonBody(request);
      return sendJson(response, 200, {
        ok: true,
        data: await this.trainingEvaluationManager.restoreSnapshots(
          evaluationRestoreMatch[1],
          body.snapshotIds,
        ),
      });
    }
    const evaluationSnapshotMatch = url.pathname.match(
      /^\/api\/training-evaluations\/([a-z0-9][a-z0-9_-]{0,63})\/snapshots\/(iter-\d{8,12}-[a-f0-9]{8,32})$/,
    );
    if (request.method === "GET" && evaluationSnapshotMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.trainingEvaluationManager.getSnapshot(
          evaluationSnapshotMatch[1],
          evaluationSnapshotMatch[2],
        ),
      });
    }
    const evaluationSampleMatch = url.pathname.match(
      /^\/api\/training-evaluations\/([a-z0-9][a-z0-9_-]{0,63})\/snapshots\/(iter-\d{8,12}-[a-f0-9]{8,32})\/samples\/((?:src|dst)-p-?\d+-y-?\d+-\d{2})\/(input|reconstruction|swap|target-mask|predicted-mask)$/,
    );
    if (request.method === "GET" && evaluationSampleMatch) {
      return sendReviewImage(
        response,
        await this.trainingEvaluationManager.resolveSnapshotImage(
          evaluationSampleMatch[1],
          evaluationSampleMatch[2],
          evaluationSampleMatch[3],
          evaluationSampleMatch[4],
        ),
      );
    }
    const toolAuditMatch = url.pathname.match(/^\/api\/tools\/assets\/(src|dst)\/audit$/);
    if (request.method === "GET" && toolAuditMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await auditAlignedAssets(toolAuditMatch[1], {
          refresh: url.searchParams.get("refresh") === "1",
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        }),
      });
    }
    const toolSimilarityMatch = url.pathname.match(/^\/api\/tools\/assets\/(src|dst)\/similarity$/);
    if (request.method === "GET" && toolSimilarityMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await buildAlignedSimilarityGroups(toolSimilarityMatch[1], {
          refresh: url.searchParams.get("refresh") === "1",
          threshold: url.searchParams.get("threshold"),
          limit: url.searchParams.get("limit"),
        }),
      });
    }
    const toolPackMatch = url.pathname.match(/^\/api\/tools\/assets\/(src|dst)\/pack$/);
    if (request.method === "GET" && toolPackMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await inspectAlignedPack(toolPackMatch[1], {
          refresh: url.searchParams.get("refresh") === "1",
        }),
      });
    }
    const toolCoverageMatch = url.pathname.match(/^\/api\/tools\/assets\/(src|dst)\/coverage$/);
    if (request.method === "GET" && toolCoverageMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await inspectExtractionCoverage(toolCoverageMatch[1], {
          refresh: url.searchParams.get("refresh") === "1",
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        }),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/tools/export-preflight") {
      return sendJson(response, 200, { ok: true, data: await inspectExportReadiness() });
    }
    if (request.method === "GET" && url.pathname === "/api/tools/merge-review") {
      return sendJson(response, 200, {
        ok: true,
        data: await listMergeReview({
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        }),
      });
    }
    const videoTimelineMatch = url.pathname.match(/^\/api\/tools\/video\/(src|dst)\/timeline$/);
    if (request.method === "GET" && videoTimelineMatch) {
      return sendJson(response, 200, { ok: true, data: await inspectVideoTimeline(videoTimelineMatch[1]) });
    }
    const videoScenesMatch = url.pathname.match(/^\/api\/tools\/video\/(src|dst)\/detect-scenes$/);
    if (request.method === "POST" && videoScenesMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await detectVideoScenes(videoScenesMatch[1], await readJsonBody(request)),
      });
    }
    const videoSegmentsMatch = url.pathname.match(/^\/api\/tools\/video\/(src|dst)\/segments$/);
    if (request.method === "PUT" && videoSegmentsMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await saveVideoSegments(videoSegmentsMatch[1], await readJsonBody(request)),
      });
    }
    const videoExtractMatch = url.pathname.match(/^\/api\/tools\/video\/(src|dst)\/extract-segments$/);
    if (request.method === "POST" && videoExtractMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("分段提帧", async () => (
          extractVideoSegments(videoExtractMatch[1], await readJsonBody(request))
        )),
      });
    }
    const videoArchivesMatch = url.pathname.match(/^\/api\/tools\/video\/(src|dst)\/frame-archives$/);
    if (request.method === "GET" && videoArchivesMatch) {
      return sendJson(response, 200, { ok: true, data: await listFrameArchives(videoArchivesMatch[1]) });
    }
    const videoArchiveRestoreMatch = url.pathname.match(
      /^\/api\/tools\/video\/(src|dst)\/frame-archives\/(\d{14}-[a-f0-9]{10})\/restore$/,
    );
    if (request.method === "POST" && videoArchiveRestoreMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("恢复帧归档", () => (
          restoreFrameArchive(videoArchiveRestoreMatch[1], videoArchiveRestoreMatch[2])
        )),
      });
    }
    const workspaceMaterialMatch = url.pathname.match(/^\/api\/workspace\/materials\/(src|dst)$/);
    if (request.method === "GET" && workspaceMaterialMatch) {
      return sendVideoArtifact(
        request,
        response,
        await resolveWorkspaceMaterial(workspaceMaterialMatch[1]),
      );
    }
    const reviewImageMatch = url.pathname.match(
      /^\/api\/workspace\/review\/(src-frame|dst-frame|merged|mask)\/([^/]+)$/,
    );
    if (request.method === "GET" && reviewImageMatch) {
      return sendReviewImage(
        response,
        resolveReviewAsset(reviewImageMatch[1], reviewImageMatch[2]),
      );
    }
    const alignedListMatch = url.pathname.match(/^\/api\/assets\/(src|dst)\/aligned$/);
    if (request.method === "GET" && alignedListMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await listAlignedAssets(alignedListMatch[1], {
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        }),
      });
    }
    const alignedPosterMatch = url.pathname.match(/^\/api\/assets\/(src|dst)\/poster$/);
    if (request.method === "GET" && alignedPosterMatch) {
      return streamAlignedPoster(response, alignedPosterMatch[1]);
    }
    const poseAtlasMatch = url.pathname.match(/^\/api\/assets\/(src|dst)\/pose-atlas$/);
    if (request.method === "GET" && poseAtlasMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await buildAlignedPoseAtlas(poseAtlasMatch[1]),
      });
    }
    const alignedAnnotationMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/aligned\/([^/]+)\/annotation$/,
    );
    if (request.method === "GET" && alignedAnnotationMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await inspectAlignedAnnotation(
          alignedAnnotationMatch[1],
          alignedAnnotationMatch[2],
        ),
      });
    }
    if (request.method === "PUT" && alignedAnnotationMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("保存 XSeg 标注", async () => (
          saveAlignedAnnotation(
            alignedAnnotationMatch[1],
            alignedAnnotationMatch[2],
            await readJsonBody(request),
          )
        )),
      });
    }
    const alignedRepairPreviewMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/aligned\/([^/]+)\/alignment-preview$/,
    );
    if (request.method === "POST" && alignedRepairPreviewMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await previewAlignedRepair(
          alignedRepairPreviewMatch[1],
          alignedRepairPreviewMatch[2],
          await readJsonBody(request),
        ),
      });
    }
    const alignedRepairApplyMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/aligned\/([^/]+)\/alignment-apply$/,
    );
    if (request.method === "POST" && alignedRepairApplyMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("应用对齐修复", async () => (
          applyAlignedRepair(
            alignedRepairApplyMatch[1],
            alignedRepairApplyMatch[2],
            await readJsonBody(request),
          )
        )),
      });
    }
    const alignedRepairBackupsMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/alignment-backups$/,
    );
    if (request.method === "GET" && alignedRepairBackupsMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await listAlignedRepairBackups(alignedRepairBackupsMatch[1]),
      });
    }
    const alignedRepairRestoreMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/alignment-backups\/([0-9]{14}-[a-f0-9]{10})\/([^/]+)\/restore$/,
    );
    if (request.method === "POST" && alignedRepairRestoreMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("恢复对齐备份", () => (
          restoreAlignedRepair(
            alignedRepairRestoreMatch[1],
            alignedRepairRestoreMatch[2],
            alignedRepairRestoreMatch[3],
          )
        )),
      });
    }
    const alignedImageMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/aligned\/([^/]+)$/,
    );
    if (request.method === "GET" && alignedImageMatch) {
      return streamAlignedImage(response, alignedImageMatch[1], alignedImageMatch[2]);
    }
    const quarantineListMatch = url.pathname.match(/^\/api\/assets\/(src|dst)\/quarantine$/);
    if (request.method === "GET" && quarantineListMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await listAlignedQuarantine(quarantineListMatch[1], {
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        }),
      });
    }
    const quarantinedAnnotationMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/quarantine\/([0-9]{14}-[a-f0-9]{10})\/([^/]+)\/annotation$/,
    );
    if (request.method === "GET" && quarantinedAnnotationMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await inspectQuarantinedAnnotation(
          quarantinedAnnotationMatch[1],
          quarantinedAnnotationMatch[2],
          quarantinedAnnotationMatch[3],
        ),
      });
    }
    const quarantinedImageMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/quarantine\/([0-9]{14}-[a-f0-9]{10})\/([^/]+)$/,
    );
    if (request.method === "GET" && quarantinedImageMatch) {
      return streamQuarantinedImage(
        response,
        quarantinedImageMatch[1],
        quarantinedImageMatch[2],
        quarantinedImageMatch[3],
      );
    }
    const quarantineImageMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/aligned\/([^/]+)\/quarantine$/,
    );
    if (request.method === "POST" && quarantineImageMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("隔离 aligned 图片", () => (
          quarantineAlignedImage(
            quarantineImageMatch[1],
            quarantineImageMatch[2],
          )
        )),
      });
    }
    const quarantineBatchMatch = url.pathname.match(/^\/api\/assets\/(src|dst)\/aligned\/quarantine-batch$/);
    if (request.method === "POST" && quarantineBatchMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("批量隔离 aligned 图片", async () => {
          const body = await readJsonBody(request);
          return quarantineAlignedImages(quarantineBatchMatch[1], body.names);
        }),
      });
    }
    const restoreImageMatch = url.pathname.match(
      /^\/api\/assets\/(src|dst)\/quarantine\/([0-9]{14}-[a-f0-9]{10})\/([^/]+)\/restore$/,
    );
    if (request.method === "POST" && restoreImageMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("恢复 aligned 图片", () => (
          restoreAlignedImage(
            restoreImageMatch[1],
            restoreImageMatch[2],
            restoreImageMatch[3],
          )
        )),
      });
    }
    const materialArchivesMatch = url.pathname.match(/^\/api\/workspace\/material-archives\/(src|dst)$/);
    if (request.method === "GET" && materialArchivesMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.listMaterialArchives(materialArchivesMatch[1]),
      });
    }
    const materialRestoreMatch = url.pathname.match(
      /^\/api\/workspace\/material-archives\/(src|dst)\/(\d{14}(?:-[a-f0-9]{10})?)\/restore$/,
    );
    if (request.method === "POST" && materialRestoreMatch) {
      return sendJson(response, 200, {
        ok: true,
        data: await this.withWorkspaceMutation("恢复视频素材", () => (
          this.restoreMaterialArchive(materialRestoreMatch[1], materialRestoreMatch[2])
        )),
      });
    }
    const workspaceImportMatch = url.pathname.match(/^\/api\/workspace\/import\/(src|dst)$/);
    if (request.method === "POST" && workspaceImportMatch) {
      const imported = await this.withWorkspaceMutation("导入视频素材", () => (
        importWorkspaceVideo(workspaceImportMatch[1], request, {
          encodedFileName: request.headers["x-file-name"],
          replace: url.searchParams.get("replace") === "1",
        })
      ));
      return sendJson(response, 201, { ok: true, data: imported });
    }
    const workspaceArtifactMatch = url.pathname.match(
      /^\/api\/workspace\/artifacts\/(result(?:_mask)?\.(?:mp4|avi|mov))$/,
    );
    if (request.method === "GET" && workspaceArtifactMatch) {
      return sendVideoArtifact(
        request,
        response,
        resolveWorkspaceArtifact(workspaceArtifactMatch[1]),
      );
    }
    const commandPreflightMatch = url.pathname.match(
      /^\/api\/commands\/([a-z0-9._-]+)\/preflight$/i,
    );
    if (request.method === "POST" && commandPreflightMatch) {
      const body = await readJsonBody(request);
      const commandId = decodeURIComponent(commandPreflightMatch[1]);
      const prepared = await this.withWorkspaceMutation("检查任务参数", () => (
        this.commandPreparer(commandId, {
          launchMode: body.launchMode,
          parameters: body.parameters,
          trainingEvaluationManager: this.trainingEvaluationManager,
        })
      ), { allowActiveJobs: true });
      return sendJson(response, 200, {
        ok: true,
        data: {
          commandId,
          launchMode: prepared.launchMode,
          parameters: prepared.parameters,
          profile: prepared.definition.profile,
          stage: prepared.definition.stage,
          locks: prepared.definition.locks,
          resources: prepared.preflight?.resources ?? null,
          evaluation: prepared.preflight?.evaluation
            ? {
                enabled: prepared.preflight.evaluation.enabled,
                modelKey: prepared.preflight.evaluation.modelKey,
                manifestId: prepared.preflight.evaluation.manifestId,
                reason: prepared.preflight.evaluation.reason,
              }
            : null,
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      return sendJson(response, 200, { ok: true, data: this.jobManager.list() });
    }
    if (request.method === "POST" && url.pathname === "/api/jobs/archive-completed") {
      return sendJson(response, 200, {
        ok: true,
        data: await this.jobManager.archiveCompleted(),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
      const body = await readJsonBody(request);
      const job = await this.withWorkspaceMutation("启动任务", () => (
        this.jobManager.start(body.commandId, {
          cols: body.cols,
          rows: body.rows,
          launchMode: body.launchMode,
          parameters: body.parameters,
        })
      ), { allowActiveJobs: true });
      return sendJson(response, 201, { ok: true, data: job });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && jobMatch) {
      return sendJson(response, 200, { ok: true, data: this.jobManager.get(jobMatch[1]) });
    }

    const eventMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/events$/i);
    if (request.method === "GET" && eventMatch) {
      const after = Math.max(Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0, 0);
      const events = await this.jobManager.eventsAfter(eventMatch[1], after);
      return sendJson(response, 200, { ok: true, data: events });
    }

    const inputMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/input$/i);
    if (request.method === "POST" && inputMatch) {
      const body = await readJsonBody(request);
      const job = await this.jobManager.sendInput(inputMatch[1], body.input);
      return sendJson(response, 200, { ok: true, data: job });
    }

    const controlMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/control$/i);
    if (request.method === "POST" && controlMatch) {
      const body = await readJsonBody(request);
      const job = await this.jobManager.control(controlMatch[1], body.operation);
      return sendJson(response, 200, { ok: true, data: job });
    }

    const retryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/retry$/i);
    if (request.method === "POST" && retryMatch) {
      const body = await readJsonBody(request);
      const job = await this.jobManager.retry(retryMatch[1], {
        cols: body.cols,
        rows: body.rows,
      });
      return sendJson(response, 201, { ok: true, data: job });
    }

    const previewMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/preview$/i);
    if (request.method === "GET" && previewMatch) {
      const job = this.jobManager.getInternal(previewMatch[1]);
      if (!(await pathExists(job.previewFile))) {
        return sendJson(response, 404, {
          ok: false,
          error: { code: "PREVIEW_NOT_READY", message: "训练预览尚未生成" },
        });
      }
      const [content, fileStat] = await Promise.all([readFile(job.previewFile), stat(job.previewFile)]);
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": content.length,
        "Cache-Control": "no-cache",
        ETag: `"${Math.round(fileStat.mtimeMs)}-${fileStat.size}"`,
      });
      return response.end(content);
    }

    return sendJson(response, 404, {
      ok: false,
      error: { code: "API_NOT_FOUND", message: "接口不存在" },
    });
  }

  async serveStatic(request, response, url) {
    if (!["GET", "HEAD"].includes(request.method ?? "GET")) {
      return sendJson(response, 405, {
        ok: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "方法不允许" },
      });
    }
    if (!(await pathExists(this.staticRoot))) {
      return sendJson(response, 404, {
        ok: false,
        error: { code: "STATIC_BUILD_MISSING", message: "前端尚未构建" },
      });
    }
    const requested = decodeURIComponent(url.pathname);
    const normalized = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
    let filePath = path.resolve(this.staticRoot, normalized);
    const staticRoot = path.resolve(this.staticRoot).toLocaleLowerCase("en-US");
    if (!filePath.toLocaleLowerCase("en-US").startsWith(`${staticRoot}${path.sep}`)) {
      return sendJson(response, 403, {
        ok: false,
        error: { code: "PATH_NOT_ALLOWED", message: "静态资源路径不允许" },
      });
    }
    if (!(await pathExists(filePath)) || (await stat(filePath)).isDirectory()) {
      filePath = path.join(this.staticRoot, "index.html");
    }
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (request.method === "HEAD") return response.end();
    return response.end(content);
  }

  async handleUpgrade(request, socket, head) {
    try {
      if (
        !isAllowedOrigin(request.headers.origin, this.allowedOrigins)
        || !this.requestHasSession(request)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      const jobId = url.searchParams.get("jobId");
      if (!jobId) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      this.jobManager.get(jobId);
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        void this.attachWebSocket(webSocket, jobId, url);
      });
    } catch {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }

  async attachWebSocket(webSocket, jobId, url) {
    const after = Math.max(Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0, 0);
    const send = (value) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(value));
    };
    const listener = (event) => {
      if (event.jobId === jobId) send(event);
    };
    this.jobManager.on("event", listener);
    webSocket.once("close", () => this.jobManager.off("event", listener));
    webSocket.on("message", (raw) => {
      void (async () => {
        try {
          const message = JSON.parse(raw.toString("utf8"));
          if (message.type === "terminal.input") {
            await this.jobManager.sendInput(jobId, message.input);
          } else if (message.type === "terminal.resize") {
            this.jobManager.resize(jobId, message.cols, message.rows);
          } else if (message.type === "job.control") {
            await this.jobManager.control(jobId, message.operation);
          } else {
            throw new Error("不支持的 WebSocket 消息");
          }
        } catch (error) {
          send({
            jobId,
            sequence: 0,
            timestamp: new Date().toISOString(),
            type: "protocol.error",
            payload: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      })();
    });
    send({ type: "snapshot", payload: this.jobManager.get(jobId) });
    for (const event of await this.jobManager.eventsAfter(jobId, after)) send(event);
  }
}
