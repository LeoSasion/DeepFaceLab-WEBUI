import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "./paths.mjs";
import { localImageCredentialCodec } from "./image-service-credentials.mjs";
import { ImageServiceError, abortable, publicHttpsUrl, publicImageFetch, resolvePublicUrl } from "./image-service-network.mjs";
import {
  ACTIVE_IMAGE_STATUSES, IMAGE_MODES, IMAGE_RESOLUTIONS, IMAGE_SERVICE, IMAGE_SIZES,
  imageUploadConsentMatches, normalizeProviderStatus,
} from "../shared/image-service-contract.mjs";

export { ImageServiceError } from "./image-service-network.mjs";

const INPUT_ID = /^in-[a-f0-9]{32}$/;
const TASK_ID = /^img-[a-f0-9]{32}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const ALIGNED_NAME = /^[^<>:"/\\|?*\u0000-\u001f]{1,220}\.(?:jpe?g|png|webp)$/i;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const now = () => new Date().toISOString();

function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

function imageKind(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.subarray(12, 16).toString("ascii") === "IHDR") return { extension: "png", mimeType: "image/png" };
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: "jpg", mimeType: "image/jpeg" };
  if (bytes.length >= 16 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  throw new ImageServiceError("只支持 JPG、PNG、WEBP 图片，请检查文件内容", "IMAGE_FORMAT_INVALID");
}

function imageBytes(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new ImageServiceError("图片内容无效", "IMAGE_INPUT_INVALID");
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > IMAGE_SERVICE.maxImageBytes) throw new ImageServiceError("每张图片必须小于或等于 50 MB", "IMAGE_SIZE_INVALID", 413);
  return bytes;
}

export function stripImagePrivateMetadata(bytes) {
  const kind = imageKind(bytes);
  if (kind.extension === "jpg") {
    const chunks = [bytes.subarray(0, 2)];
    let offset = 2;
    while (offset < bytes.length) {
      const start = offset;
      if (bytes[offset++] !== 255) throw new ImageServiceError("JPEG 图片结构无效", "IMAGE_FORMAT_INVALID");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) { chunks.push(bytes.subarray(start)); return Buffer.concat(chunks); }
      if (marker === 1 || marker >= 208 && marker <= 216) { chunks.push(bytes.subarray(start, offset)); continue; }
      if (offset + 2 > bytes.length) throw new ImageServiceError("JPEG 图片结构无效", "IMAGE_FORMAT_INVALID");
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new ImageServiceError("JPEG 图片结构无效", "IMAGE_FORMAT_INVALID");
      offset += length;
      // DFL uses APP15 for executable pickle metadata and original-frame paths.
      // The pixel codestream is copied verbatim without loading that metadata.
      if (marker !== 239) chunks.push(bytes.subarray(start, offset));
    }
    throw new ImageServiceError("JPEG 图片结构不完整", "IMAGE_FORMAT_INVALID");
  }
  if (kind.extension === "png") {
    const chunks = [bytes.subarray(0, 8)];
    const keep = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sRGB", "sBIT", "bKGD", "pHYs", "hIST", "acTL", "fcTL", "fdAT"]);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) throw new ImageServiceError("PNG 图片结构无效", "IMAGE_FORMAT_INVALID");
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      if (keep.has(type)) chunks.push(bytes.subarray(offset, end));
      offset = end;
      if (type === "IEND") return Buffer.concat(chunks);
    }
    throw new ImageServiceError("PNG 图片结构不完整", "IMAGE_FORMAT_INVALID");
  }
  return bytes;
}

function inputPublic(input) {
  return { inputId: input.inputId, name: input.name, size: input.size, imageUrl: `/api/image-service/inputs/${input.inputId}` };
}

function safeModel(value) {
  if (typeof value !== "string" || !MODEL_ID.test(value)) throw new ImageServiceError("模型 ID 无效", "IMAGE_MODEL_INVALID");
  return value;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(finish, ms);
    function finish() { signal?.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); reject(new Error("aborted")); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function boundedResponse(response, maximum, signal) {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new ImageServiceError("服务响应超出允许大小", "IMAGE_RESPONSE_TOO_LARGE", 502);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > maximum) throw new ImageServiceError("服务响应超出允许大小", "IMAGE_RESPONSE_TOO_LARGE", 502);
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
}

function actualUsage(value) {
  return typeof value?.amount === "number" && Number.isFinite(value.amount) && value.amount >= 0
    && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency)
    ? { amount: value.amount, currency: value.currency } : null;
}

function providerResultUrls(payload) {
  const result = [];
  const add = (value) => {
    if (typeof value === "string" && value && !result.includes(value)) result.push(value);
  };
  const data = payload?.data ?? payload;
  const nested = data?.data ?? {};
  const content = nested?.content ?? data?.content ?? {};
  add(data?.result_url);
  for (const values of [content.image_urls, data?.image_urls]) {
    if (Array.isArray(values)) values.forEach((item) => add(typeof item === "string" ? item : item?.url));
  }
  add(content.image_url);
  add(data?.image_url);
  if (Array.isArray(data?.data)) data.data.forEach((item) => add(item?.url));
  // The submitted n is always one; signed aliases must not be treated as extra images.
  return result.slice(0, 1);
}

function responseStatus(payload) {
  const data = payload?.data ?? payload;
  const value = data?.status ?? data?.data?.status ?? payload?.status;
  return normalizeProviderStatus(value) === "unknown" ? "UNKNOWN" : value.trim().toUpperCase();
}

export class ImageServiceManager {
  constructor({
    paths = PATHS, fetch: fetchImpl = publicImageFetch, credentials = localImageCredentialCodec(),
    delay: delayImpl = delay, resolveHostname, pollIntervalMs = 3000,
    pollTimeoutMs = 30 * 60_000, settlementChecks = 3,
  } = {}) {
    this.paths = paths;
    this.root = path.join(paths.runtimeRoot, "image-service");
    this.inputsRoot = path.join(this.root, "inputs");
    this.tasksRoot = path.join(this.root, "tasks");
    this.resultsRoot = path.join(this.root, "results");
    this.settingsRoot = path.join(paths.projectRegistryRoot ?? path.join(paths.webuiRoot, ".runtime"), "image-service");
    this.settingsFile = path.join(this.settingsRoot, "settings.json");
    this.fetch = fetchImpl;
    this.credentials = credentials;
    this.delay = delayImpl;
    this.resolveHostname = resolveHostname;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.settlementChecks = settlementChecks;
    this.inputs = new Map();
    this.tasks = new Map();
    this.requests = new Map();
    this.workers = new Map();
    this.key = "";
    this.model = IMAGE_SERVICE.defaultModel;
    this.keyError = null;
    this.settingsError = null;
    this.closed = false;
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await Promise.all([this.inputsRoot, this.tasksRoot, this.resultsRoot, this.settingsRoot].map((directory) => mkdir(directory, { recursive: true })));
    const workspace = await realpath(this.paths.workspaceRoot);
    for (const directory of [this.root, this.inputsRoot, this.tasksRoot, this.resultsRoot]) {
      if (!within(workspace, await realpath(directory))) throw new ImageServiceError("项目图片目录超出允许范围", "IMAGE_PATH_INVALID");
    }
    if (!within(await realpath(this.paths.webuiRoot), await realpath(this.settingsRoot))) throw new ImageServiceError("密钥目录超出允许范围", "IMAGE_PATH_INVALID");
    try {
      const settings = JSON.parse(await readFile(this.settingsFile, "utf8"));
      if (MODEL_ID.test(settings.model)) this.model = settings.model;
      if (settings.credential && this.credentials.persistence !== "session-only") {
        try { this.key = await this.credentials.unseal(settings.credential); }
        catch { this.keyError = "本机保存的密钥无法读取，请重新填写 API Key"; }
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.settingsError = "本机图像服务配置无法读取，原配置保留；请先修复或移走损坏文件";
    }
    for (const filename of await readdir(this.inputsRoot)) {
      const inputId = filename.replace(/\.json$/, "");
      if (!filename.endsWith(".json") || !INPUT_ID.test(inputId)) continue;
      const input = JSON.parse(await readFile(path.join(this.inputsRoot, filename), "utf8"));
      if (input.inputId !== inputId || !/^(?:png|jpg|webp)$/.test(input.extension)) throw new ImageServiceError("项目图片记录无法读取", "IMAGE_RECORD_INVALID", 500);
      this.inputs.set(inputId, input);
    }
    for (const filename of await readdir(this.tasksRoot)) {
      const taskId = filename.replace(/\.json$/, "");
      if (!filename.endsWith(".json") || !TASK_ID.test(taskId)) continue;
      const task = JSON.parse(await readFile(path.join(this.tasksRoot, filename), "utf8"));
      if (task.id !== taskId || !REQUEST_ID.test(task.requestId) || !Array.isArray(task.inputs) || !Array.isArray(task.results)) {
        throw new ImageServiceError("项目图像任务记录无法读取", "IMAGE_RECORD_INVALID", 500);
      }
      this.tasks.set(taskId, task);
      this.requests.set(task.requestId, taskId);
      if (ACTIVE_IMAGE_STATUSES.includes(task.status) || task.status === "paused") {
        if (task.providerTaskId) {
          task.status = "paused";
          task.error = "服务重启后正在恢复查询；不会再次提交生成";
        } else {
          task.status = task.status === "submitting" ? "unconfirmed" : "paused";
          task.error = task.status === "unconfirmed"
            ? "提交结果未确认，请在平台核对任务和扣费；不会自动重新提交"
            : "服务已重启，原任务未提交，请重新确认后新建任务";
        }
        await this.persist(task);
      }
    }
    // Restart recovery performs GET/download only. A persisted task is never
    // submitted again, including queued tasks whose upload may have started.
    for (const task of this.tasks.values()) {
      if (this.key && task.providerTaskId && (task.status === "paused"
        || task.status === "completed" && task.usage === null
        || task.status === "failed" && task.usage === null)) this.startWorker(task, false);
    }
    return this;
  }

  settings() {
    return {
      provider: IMAGE_SERVICE.provider, providerName: IMAGE_SERVICE.providerName,
      baseUrl: IMAGE_SERVICE.baseUrl, registrationUrl: IMAGE_SERVICE.registrationUrl,
      model: this.model, hasKey: Boolean(this.key), keyPersistence: this.credentials.persistence,
      keyError: this.keyError,
      settingsError: this.settingsError,
      capabilities: { maxImages: IMAGE_SERVICE.maxImages, masks: false },
    };
  }

  serializeMutation(callback) {
    const next = this.mutation.then(callback);
    this.mutation = next.catch(() => {});
    return next;
  }

  async saveSettings({ apiKey, clearKey = false, model } = {}) {
    return this.serializeMutation(async () => {
      if (this.settingsError) throw new ImageServiceError(this.settingsError, "IMAGE_SETTINGS_READ_FAILED", 500);
      let nextKey = this.key;
      if (clearKey === true) nextKey = "";
      else if (apiKey !== undefined) {
        if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey.trim())) {
          throw new ImageServiceError("API Key 不能为空或包含换行", "IMAGE_KEY_INVALID");
        }
        nextKey = apiKey.trim();
      }
      const nextModel = model === undefined ? this.model : safeModel(model);
      const credential = nextKey && this.credentials.persistence !== "session-only" ? await this.credentials.seal(nextKey) : null;
      await atomicJson(this.settingsFile, { schema: 1, provider: IMAGE_SERVICE.provider, model: nextModel, credential });
      this.key = nextKey;
      this.model = nextModel;
      this.keyError = null;
      return this.settings();
    });
  }

  async stageInput({ name, bytes }) {
    if (this.closed) throw new ImageServiceError("图像服务已关闭", "IMAGE_SERVICE_CLOSED", 503);
    const data = imageBytes(bytes);
    const kind = imageKind(data);
    const inputId = `in-${randomBytes(16).toString("hex")}`;
    const input = {
      schema: 1, inputId, name: String(name ?? `参考图.${kind.extension}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 220),
      size: data.length, ...kind, sha256: createHash("sha256").update(data).digest("hex"), createdAt: now(),
    };
    await writeFile(path.join(this.inputsRoot, `${inputId}.${kind.extension}`), data, { mode: 0o600, flag: "wx" });
    await atomicJson(path.join(this.inputsRoot, `${inputId}.json`), input);
    this.inputs.set(inputId, input);
    return inputPublic(input);
  }

  async stageAligned({ side, name }) {
    if (!["src", "dst"].includes(side) || typeof name !== "string" || !ALIGNED_NAME.test(name)) {
      throw new ImageServiceError("对齐图选择无效", "IMAGE_ALIGNED_INVALID");
    }
    const workspace = await realpath(this.paths.workspaceRoot);
    const directory = await realpath(path.join(this.paths.workspaceRoot, `data_${side}`, "aligned"));
    const target = await realpath(path.join(directory, name));
    if (!within(workspace, directory) || !within(directory, target)) throw new ImageServiceError("对齐图超出当前项目", "IMAGE_PATH_INVALID");
    const info = await stat(target);
    if (!info.isFile() || info.size > IMAGE_SERVICE.maxImageBytes) throw new ImageServiceError("对齐图大小无效", "IMAGE_SIZE_INVALID", 413);
    return this.stageInput({ name, bytes: await readFile(target) });
  }

  async inputFile(inputId) {
    const input = INPUT_ID.test(inputId) ? this.inputs.get(inputId) : null;
    if (!input) throw new ImageServiceError("本地参考图不存在", "IMAGE_INPUT_NOT_FOUND", 404);
    const target = path.join(this.inputsRoot, `${inputId}.${input.extension}`);
    const actual = await realpath(target).catch(() => null);
    if (!actual || !within(await realpath(this.inputsRoot), actual)) throw new ImageServiceError("本地参考图无法读取", "IMAGE_INPUT_NOT_FOUND", 404);
    return { path: actual, name: input.name, mimeType: input.mimeType };
  }

  publicTask(task) {
    return {
      id: task.id, requestId: task.requestId, mode: task.mode, status: task.status,
      providerStatus: task.providerStatus ?? null, providerTaskId: task.providerTaskId ?? null,
      progress: task.progress ?? null, createdAt: task.createdAt, updatedAt: task.updatedAt,
      prompt: task.prompt, model: task.model, size: task.size, resolution: task.resolution,
      nsfwCheck: task.nsfwCheck, inputs: task.inputs.map((inputId) => inputPublic(this.inputs.get(inputId)
        ?? { inputId, name: "参考图已缺失", size: 0 })), imageUrls: [...task.imageUrls],
      results: task.results.map((result, index) => ({
        index, name: result.name, size: result.size, imageUrl: `/api/image-service/tasks/${task.id}/results/${index}`,
      })), usage: task.usage ?? null, error: task.error ?? null,
      canCheck: Boolean(task.providerTaskId) && !this.workers.has(task.id),
    };
  }

  listTasks() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((task) => this.publicTask(task));
  }

  getTask(taskId) {
    const task = TASK_ID.test(taskId) ? this.tasks.get(taskId) : null;
    if (!task) throw new ImageServiceError("图像任务不存在", "IMAGE_TASK_NOT_FOUND", 404);
    return this.publicTask(task);
  }

  activeTasks() {
    return [...this.tasks.values()].filter((task) => ACTIVE_IMAGE_STATUSES.includes(task.status) || this.workers.has(task.id)).map((task) => this.publicTask(task));
  }

  async persist(task) {
    task.updatedAt = now();
    await atomicJson(path.join(this.tasksRoot, `${task.id}.json`), task);
  }

  async createTask(body = {}) {
    return this.serializeMutation(async () => {
      if (this.closed) throw new ImageServiceError("图像服务已关闭", "IMAGE_SERVICE_CLOSED", 503);
      if (!REQUEST_ID.test(body.requestId)) throw new ImageServiceError("请求 ID 无效", "IMAGE_REQUEST_ID_INVALID");
      if (!IMAGE_MODES.includes(body.mode)) throw new ImageServiceError("图像操作无效", "IMAGE_MODE_INVALID");
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt || prompt.length > IMAGE_SERVICE.maxPromptLength) throw new ImageServiceError("提示词需为 1–5000 个字符", "IMAGE_PROMPT_INVALID");
      const size = body.size ?? "auto";
      const resolution = body.resolution ?? "1k";
      if (!IMAGE_SIZES.includes(size) || !IMAGE_RESOLUTIONS.includes(resolution)) throw new ImageServiceError("图像比例或分辨率无效", "IMAGE_OPTIONS_INVALID");
      if (body.nsfwCheck !== undefined && typeof body.nsfwCheck !== "boolean") throw new ImageServiceError("内容检查选项无效", "IMAGE_OPTIONS_INVALID");
      const inputIds = body.inputs ?? [];
      const imageUrls = body.imageUrls ?? [];
      if (!Array.isArray(inputIds) || !Array.isArray(imageUrls) || inputIds.length + imageUrls.length > IMAGE_SERVICE.maxImages
        || inputIds.some((inputId) => !INPUT_ID.test(inputId) || !this.inputs.has(inputId))
        || imageUrls.some((url) => typeof url !== "string")) throw new ImageServiceError("最多选择 15 张本地或公开链接参考图", "IMAGE_REFERENCES_INVALID");
      if (body.mode !== "generate" && !inputIds.length && !imageUrls.length) throw new ImageServiceError("此操作需要至少一张参考图", "IMAGE_REFERENCES_REQUIRED");
      if (!imageUploadConsentMatches(body.consent, inputIds, imageUrls)) throw new ImageServiceError("请先确认奇智平台与本次所选图片范围", "IMAGE_CONSENT_REQUIRED");
      imageUrls.forEach(publicHttpsUrl);
      const requestId = body.requestId.toLowerCase();
      const normalized = { mode: body.mode, prompt, size, resolution, nsfwCheck: body.nsfwCheck ?? false, inputs: [...inputIds], imageUrls: [...imageUrls] };
      const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      const previous = this.requests.get(requestId);
      if (previous) {
        const task = this.tasks.get(previous);
        if (task.requestHash !== requestHash || body.model !== undefined && body.model !== task.model) throw new ImageServiceError("请求 ID 已用于其他图像参数", "IMAGE_REQUEST_ID_CONFLICT", 409);
        return this.publicTask(task);
      }
      if (!this.key) throw new ImageServiceError("请先在本机填写 API Key", "IMAGE_KEY_REQUIRED", 409);
      if (body.model !== undefined && body.model !== this.model) throw new ImageServiceError("本机模型配置已变化，请重新确认本次提交", "IMAGE_CONFIG_CHANGED", 409);
      if (this.activeTasks().length) throw new ImageServiceError("当前项目已有正在处理的图像任务", "IMAGE_TASK_BUSY", 409);
      // Reference links are validated before the provider is allowed to fetch them.
      for (const url of imageUrls) await resolvePublicUrl(url, this.resolveHostname);
      for (const inputId of inputIds) await this.inputFile(inputId);
      const task = {
        schema: 1, id: `img-${randomBytes(16).toString("hex")}`, requestId, requestHash,
        ...normalized, model: this.model, provider: IMAGE_SERVICE.provider,
        consent: { provider: IMAGE_SERVICE.provider, inputIds: [...inputIds], imageUrls: [...imageUrls] },
        status: "queued", createdAt: now(), updatedAt: now(), providerTaskId: null,
        providerStatus: null, progress: null, uploadedInputs: [], providerResultUrls: [],
        results: [], usage: null, error: null,
      };
      await this.persist(task);
      this.tasks.set(task.id, task);
      this.requests.set(requestId, task.id);
      this.startWorker(task, true);
      return this.publicTask(task);
    });
  }

  async checkTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !TASK_ID.test(taskId)) throw new ImageServiceError("图像任务不存在", "IMAGE_TASK_NOT_FOUND", 404);
    if (!task.providerTaskId) throw new ImageServiceError("没有可查询的平台任务 ID，请在平台核对；不会再次提交", "IMAGE_TASK_UNCONFIRMED", 409);
    if (!this.key) throw new ImageServiceError("请先在本机填写 API Key", "IMAGE_KEY_REQUIRED", 409);
    if (!this.workers.has(task.id)) {
      if (this.activeTasks().some((other) => other.id !== task.id)) throw new ImageServiceError("当前项目已有正在处理的图像任务", "IMAGE_TASK_BUSY", 409);
      this.startWorker(task, false);
    }
    return this.publicTask(task);
  }

  startWorker(task, submit) {
    if (this.workers.has(task.id) || this.closed) return;
    const controller = new AbortController();
    // The next microtask begins after the worker is registered, making task
    // creation immediately return a durable local receipt.
    const promise = Promise.resolve().then(() => this.runTask(task, submit, controller.signal))
      .finally(() => this.workers.delete(task.id));
    this.workers.set(task.id, { controller, promise });
    promise.catch(() => {});
  }

  async request(url, options, signal, maximum = MAX_JSON_BYTES, timeoutMs = 120_000) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const pending = Promise.resolve().then(() => this.fetch(url, { ...options, signal: controller.signal, redirect: "manual" }));
      pending.then((late) => { if (controller.signal.aborted) late.body?.cancel().catch(() => {}); }).catch(() => {});
      const response = await abortable(pending, controller.signal);
      const bytes = await abortable(boundedResponse(response, maximum, controller.signal), controller.signal);
      return { response, bytes };
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  }

  async api(method, endpoint, body, signal) {
    if (!this.key) throw new ImageServiceError("请重新填写 API Key 后继续查询", "IMAGE_KEY_REQUIRED", 409);
    const headers = { Authorization: `Bearer ${this.key}` };
    if (body != null && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    const { response, bytes } = await this.request(`${IMAGE_SERVICE.baseUrl}${endpoint}`, {
      method, headers, body: body instanceof FormData ? body : body == null ? undefined : JSON.stringify(body),
    }, signal, MAX_JSON_BYTES, method === "GET" ? 30_000 : 120_000);
    if (!response.ok) {
      const message = [401, 403].includes(response.status) ? "平台鉴权失败，请检查本机 API Key"
        : response.status === 429 ? "平台请求过多，请稍后继续查询"
          : `平台返回异常状态（HTTP ${response.status}）`;
      throw new ImageServiceError(message, "IMAGE_PROVIDER_HTTP", 502);
    }
    let payload;
    try { payload = JSON.parse(bytes.toString("utf8")); }
    catch { throw new ImageServiceError("平台响应格式无法识别", "IMAGE_PROVIDER_RESPONSE_INVALID", 502); }
    if (payload?.code && !["success", "SUCCESS", 0, 200].includes(payload.code)) {
      throw new ImageServiceError("平台未接受此次请求，请在平台查看详情", "IMAGE_PROVIDER_REJECTED", 502);
    }
    return payload;
  }

  async uploadInputs(task, signal) {
    task.status = "uploading";
    await this.persist(task);
    const urls = [];
    for (const inputId of task.inputs) {
      const local = await this.inputFile(inputId);
      const bytes = imageBytes(await readFile(local.path));
      const input = this.inputs.get(inputId);
      if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new ImageServiceError("参考图已发生变化，请重新选择并确认", "IMAGE_INPUT_CHANGED");
      const form = new FormData();
      const uploadBytes = stripImagePrivateMetadata(bytes);
      form.append("file", new Blob([uploadBytes], { type: local.mimeType }), `${inputId}.${input.extension}`);
      // No retries: even an upload whose response is lost is left to user review.
      const payload = await this.api("POST", "/v1/files/upload", form, signal);
      const url = payload?.url ?? payload?.data?.url;
      await resolvePublicUrl(url, this.resolveHostname, signal);
      urls.push(url);
      task.uploadedInputs.push({ inputId, url, uploadedAt: now() });
      await this.persist(task);
    }
    return [...urls, ...task.imageUrls];
  }

  async submitTask(task, signal) {
    const images = await this.uploadInputs(task, signal);
    if (signal.aborted || this.closed) throw new Error("aborted");
    // A crash/lost response after this durable phase cannot trigger a second POST.
    task.status = "submitting";
    task.error = null;
    await this.persist(task);
    const payload = await this.api("POST", "/v1/image/generations", {
      model: task.model, prompt: task.prompt, n: 1, size: task.size,
      resolution: task.resolution, nsfw_check: task.nsfwCheck,
      ...(images.length ? { images } : {}),
    }, signal);
    const providerId = payload?.task_id ?? payload?.id ?? payload?.data?.task_id ?? payload?.data?.id;
    if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId)) throw new ImageServiceError("平台未返回可查询的任务 ID，请在平台核对", "IMAGE_PROVIDER_ID_MISSING", 502);
    task.providerTaskId = providerId;
    task.providerStatus = responseStatus(payload);
    task.status = "pending";
    await this.persist(task);
  }

  async downloadResults(task, signal) {
    if (!task.providerResultUrls.length) throw new ImageServiceError("平台已完成任务，但结果链接尚未返回，请继续查询", "IMAGE_RESULTS_PENDING", 502);
    task.status = "downloading";
    await this.persist(task);
    for (let index = 0; index < task.providerResultUrls.length; index++) {
      if (task.results[index]) {
        try { await this.resultFile(task.id, index); continue; }
        catch { task.results.length = index; }
      }
      let current = task.providerResultUrls[index];
      let bytes;
      let mimeType;
      for (let hop = 0; hop <= 3; hop++) {
        await resolvePublicUrl(current, this.resolveHostname, signal);
        const result = await this.request(current, { method: "GET" }, signal, IMAGE_SERVICE.maxImageBytes);
        if ([301, 302, 303, 307, 308].includes(result.response.status)) {
          const location = result.response.headers.get("location");
          if (!location || hop === 3) throw new ImageServiceError("结果下载重定向无法确认", "IMAGE_RESULT_REDIRECT_INVALID", 502);
          current = new URL(location, current).toString();
          continue;
        }
        if (!result.response.ok) throw new ImageServiceError(`结果下载失败（HTTP ${result.response.status}），可再次查询下载`, "IMAGE_RESULT_DOWNLOAD_FAILED", 502);
        mimeType = result.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        bytes = imageBytes(result.bytes);
        const kind = imageKind(bytes);
        if (mimeType !== kind.mimeType && mimeType !== "application/octet-stream") throw new ImageServiceError("结果图片类型不符合声明，未保存", "IMAGE_RESULT_TYPE_INVALID", 502);
        mimeType = kind.mimeType;
        break;
      }
      const kind = imageKind(bytes);
      const directory = path.join(this.resultsRoot, task.id);
      await mkdir(directory, { recursive: true });
      if (!within(await realpath(this.resultsRoot), await realpath(directory))) throw new ImageServiceError("结果目录超出允许范围", "IMAGE_PATH_INVALID");
      const name = `result-${index + 1}.${kind.extension}`;
      const target = path.join(directory, name);
      const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(() => {}); }
      task.results[index] = { name, extension: kind.extension, mimeType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      await this.persist(task);
    }
    task.status = "completed";
    task.progress = 100;
    task.error = null;
    await this.persist(task);
  }

  async pollTask(task, signal) {
    const deadline = Date.now() + this.pollTimeoutMs;
    let failures = 0;
    let finalChecks = 0;
    while (!signal.aborted && !this.closed && Date.now() < deadline) {
      let payload;
      try { payload = await this.api("GET", `/v1/image/generations/${encodeURIComponent(task.providerTaskId)}`, undefined, signal); }
      catch (error) {
        if (signal.aborted || this.closed) throw error;
        failures++;
        if (failures >= 3 || error.code === "IMAGE_KEY_REQUIRED") throw error;
        await this.delay(this.pollIntervalMs, signal);
        continue;
      }
      failures = 0;
      const providerStatus = responseStatus(payload);
      const normalized = normalizeProviderStatus(providerStatus);
      task.providerStatus = providerStatus || "UNKNOWN";
      const data = payload?.data ?? payload;
      const progress = typeof data?.progress === "string" ? Number(data.progress.replace(/%$/, "")) : data?.progress;
      if (typeof progress === "number" && Number.isFinite(progress)) task.progress = Math.max(0, Math.min(100, progress));
      // Ignore pre-terminal usage entirely. A missing final settlement is unknown,
      // not a zero-cost inference.
      if (["completed", "failed"].includes(normalized)) task.usage = actualUsage(data?.usage ?? payload?.usage) ?? task.usage;
      if (normalized === "failed") {
        task.status = "failed";
        task.error = "平台图像任务失败，请在平台查看详情；最终退款以结算记录为准";
      } else if (normalized === "completed") {
        const urls = providerResultUrls(payload);
        if (urls.length) task.providerResultUrls = urls;
        await this.persist(task);
        await this.downloadResults(task, signal);
      } else if (normalized === "pending") {
        task.status = "pending";
        task.error = null;
      } else {
        task.status = "paused";
        task.error = "平台返回未知状态，请继续查询；尚未确认任务完成";
        await this.persist(task);
        return;
      }
      await this.persist(task);
      if (["completed", "failed"].includes(normalized)) {
        if (task.usage || ++finalChecks >= this.settlementChecks) return;
      }
      await this.delay(this.pollIntervalMs, signal);
    }
    if (!signal.aborted && !this.closed && !["completed", "failed"].includes(task.status)) {
      task.status = "paused";
      task.error = "已达到 30 分钟查询上限，可继续查询原任务；不会重新生成";
      await this.persist(task);
    }
  }

  async runTask(task, submit, signal) {
    try {
      if (submit) await this.submitTask(task, signal);
      await this.pollTask(task, signal);
    } catch (error) {
      if (!task.providerTaskId) {
        task.status = task.status === "submitting" ? "unconfirmed" : "failed";
        task.error = task.status === "unconfirmed"
          ? "提交结果未确认，请在平台核对任务和扣费；不会自动重新提交"
          : error instanceof ImageServiceError ? error.message : "参考图上传未完成；未再次提交，请检查网络后重新确认";
      } else if (!["completed", "failed"].includes(task.status)) {
        task.status = "paused";
        task.error = error instanceof ImageServiceError ? error.message : "查询或下载连接中断，可继续检查原任务；不会重新生成";
      }
      if (this.closed && task.providerTaskId && !["completed", "failed"].includes(task.status)) {
        task.status = "paused";
        task.error = "本地服务已停止，重启后继续查询原任务；不会重新生成";
      }
      await this.persist(task);
    }
  }

  async resultFile(taskId, index) {
    const task = TASK_ID.test(taskId) ? this.tasks.get(taskId) : null;
    const result = Number.isInteger(index) && index >= 0 ? task?.results[index] : null;
    if (!result || !/^result-[1-9][0-9]*\.(png|jpg|webp)$/.test(result.name)) throw new ImageServiceError("结果图片不存在", "IMAGE_RESULT_NOT_FOUND", 404);
    const target = await realpath(path.join(this.resultsRoot, taskId, result.name)).catch(() => null);
    if (!target || !within(await realpath(this.resultsRoot), target)) throw new ImageServiceError("结果图片无法读取", "IMAGE_RESULT_NOT_FOUND", 404);
    return { path: target, name: result.name, mimeType: result.mimeType };
  }

  async close() {
    this.closed = true;
    const workers = [...this.workers.values()];
    workers.forEach((worker) => worker.controller.abort());
    await Promise.allSettled(workers.map((worker) => worker.promise));
    this.key = "";
  }
}
