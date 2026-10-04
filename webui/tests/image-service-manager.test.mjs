import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ImageServiceManager, stripImagePrivateMetadata } from "../server/image-service-manager.mjs";
import { localImageCredentialCodec } from "../server/image-service-credentials.mjs";
import { isPublicAddress, publicHttpsUrl, resolvePublicUrl } from "../server/image-service-network.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK0kAAAAASUVORK5CYII=", "base64");
const KEY = "test-local-secret-NEVER-RETURN-THIS";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const complete = (usage = { amount: 8.75, currency: "CNY" }) => ({ code: "success", data: { status: "SUCCESS", progress: "100%", result_url: "https://cdn.example.com/result.png", ...(usage ? { usage } : {}) } });
const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
const codec = {
  persistence: "windows-dpapi",
  seal: async (key) => ({ scheme: "test-only", ciphertext: Buffer.from(key.split("").reverse().join("")).toString("base64") }),
  unseal: async (envelope) => Buffer.from(envelope.ciphertext, "base64").toString("utf8").split("").reverse().join(""),
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-image-service-"));
  const paths = { workspaceRoot: path.join(root, "workspace"), runtimeRoot: path.join(root, "workspace", ".webui"), webuiRoot: path.join(root, "webui"), projectRegistryRoot: path.join(root, "webui", ".runtime") };
  await mkdir(paths.workspaceRoot, { recursive: true });
  const calls = [];
  const fetch = options.fetch ?? (async (url, request) => {
    calls.push({ url, request });
    if (url.endsWith("/v1/files/upload")) return json({ url: `https://cdn.example.com/upload-${calls.length}.png`, expires_in: 86400 });
    if (request.method === "POST") return json({ task_id: "provider-task-1", status: "queued" });
    if (url.includes("/v1/image/generations/")) return json(complete());
    return new Response(PNG, { headers: { "Content-Type": "image/png" } });
  });
  const manager = new ImageServiceManager({ paths, fetch, credentials: codec, resolveHostname: resolver, delay: async () => {}, ...options });
  await manager.initialize();
  await manager.saveSettings({ apiKey: KEY });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, paths, manager, calls, fetch };
}

function request(inputs = [], imageUrls = [], extra = {}) {
  return { requestId: randomUUID(), mode: inputs.length || imageUrls.length ? "ai-edit" : "generate", prompt: "保留原主体，增强细节", size: "16:9", resolution: "1k", inputs, imageUrls, consent: { provider: "qizhi", inputIds: [...inputs], imageUrls: [...imageUrls] }, ...extra };
}

async function finish(manager, task) {
  await manager.workers.get(task.id)?.promise;
  return manager.getTask(task.id);
}

async function until(callback) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (callback()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("mock did not reach expected state");
}

test("exact provider and ordered material consent is checked before any external call", async (t) => {
  const { manager, calls } = await fixture(t);
  const a = await manager.stageInput({ name: "a.png", bytes: PNG });
  const b = await manager.stageInput({ name: "b.png", bytes: PNG });
  for (const consent of [undefined, { provider: "other", inputIds: [a.inputId, b.inputId], imageUrls: [] }, { provider: "qizhi", inputIds: [b.inputId, a.inputId], imageUrls: [] }]) {
    await assert.rejects(manager.createTask(request([a.inputId, b.inputId], [], { consent })), { code: "IMAGE_CONSENT_REQUIRED" });
  }
  assert.equal(calls.length, 0);
  const task = await manager.createTask(request([a.inputId, b.inputId], ["https://public.example.com/ref.png"]));
  assert.equal((await finish(manager, task)).status, "completed");
  const uploadCalls = calls.filter((call) => call.url.endsWith("/v1/files/upload"));
  assert.equal(uploadCalls.length, 2);
  assert.ok(uploadCalls[0].request.body.get("file").name.startsWith(a.inputId));
  assert.ok(uploadCalls[1].request.body.get("file").name.startsWith(b.inputId));
  const post = calls.find((call) => call.url.endsWith("/v1/image/generations"));
  const payload = JSON.parse(post.request.body);
  assert.deepEqual(payload.images, ["https://cdn.example.com/upload-1.png", "https://cdn.example.com/upload-2.png", "https://public.example.com/ref.png"]);
  assert.equal(payload.n, 1);
  assert.equal(payload.nsfw_check, false);
  assert.equal(calls.at(-1).request.headers, undefined, "download never receives the platform API Key");
});

test("key is sealed locally, never returned, and session-only storage is explicit", async (t) => {
  const { manager, paths } = await fixture(t);
  const task = await manager.createTask(request());
  const result = await finish(manager, task);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, { amount: 8.75, currency: "CNY" });
  assert.equal(JSON.stringify([manager.settings(), manager.listTasks(), result]).includes(KEY), false);
  const settings = await readFile(path.join(paths.projectRegistryRoot, "image-service", "settings.json"), "utf8");
  assert.equal(settings.includes(KEY), false);
  assert.equal(settings.includes("test-only"), true);
  const record = await readFile(path.join(paths.runtimeRoot, "image-service", "tasks", `${task.id}.json`), "utf8");
  assert.equal(record.includes(KEY), false);
  await manager.saveSettings({ clearKey: true });
  assert.equal(manager.settings().hasKey, false);
  assert.equal(localImageCredentialCodec("linux").persistence, "session-only");
  const memory = new ImageServiceManager({ paths, credentials: localImageCredentialCodec("linux"), fetch: async () => { throw new Error("not allowed"); } });
  await memory.initialize();
  await memory.saveSettings({ apiKey: KEY });
  assert.equal(memory.settings().keyPersistence, "session-only");
  assert.equal(JSON.parse(await readFile(memory.settingsFile, "utf8")).credential, null);
  await memory.close();
});

test("concurrent duplicate creation is idempotent and lost submission never makes a second POST", async (t) => {
  let posts = 0;
  const { manager } = await fixture(t, { fetch: async (_url, options) => { if (options.method === "POST") { posts++; throw new Error(`timeout ${KEY}`); } throw new Error("unexpected query"); } });
  const body = request();
  const [a, b] = await Promise.all([manager.createTask(body), manager.createTask(body)]);
  assert.equal(a.id, b.id);
  const completed = await finish(manager, a);
  assert.equal(completed.status, "unconfirmed");
  assert.equal(completed.error.includes(KEY), false);
  assert.equal((await manager.createTask(body)).id, a.id);
  assert.equal(posts, 1);
  await assert.rejects(manager.checkTask(a.id), { code: "IMAGE_TASK_UNCONFIRMED" });
  await assert.rejects(manager.createTask({ ...body, prompt: "另一提示词" }), { code: "IMAGE_REQUEST_ID_CONFLICT" });
  await assert.rejects(manager.createTask({ ...body, model: "another-model" }), { code: "IMAGE_REQUEST_ID_CONFLICT" });
});

test("known statuses, nested results and only final actual usage are recognized", async (t) => {
  let gets = 0;
  const { manager } = await fixture(t, { fetch: async (url, options) => {
    if (options.method === "POST") return json({ id: "p-nested" });
    if (url.includes("/v1/image/generations/")) {
      gets++;
      if (gets < 4) return json({ code: "success", data: { status: ["NOT_START", "SUBMITTED", "IN_PROGRESS"][gets - 1], progress: "20%", usage: { amount: 99, currency: "CNY" } } });
      return json({ code: "success", data: { status: "SUCCESS", usage: { amount: 1.25, currency: "CNY" }, data: { status: "succeeded", content: { image_urls: ["https://cdn.example.com/a.png"] } } } });
    }
    return new Response(PNG, { headers: { "content-type": "application/octet-stream" } });
  } });
  const result = await finish(manager, await manager.createTask(request()));
  assert.equal(result.status, "completed");
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.usage, { amount: 1.25, currency: "CNY" });
  assert.equal((await manager.resultFile(result.id, 0)).mimeType, "image/png");
});

test("missing final settlement remains null after bounded read-only checks", async (t) => {
  let queries = 0;
  let downloads = 0;
  const { manager } = await fixture(t, { fetch: async (url, options) => {
    if (options.method === "POST") return json({ id: "p-unsettled" });
    if (url.includes("/v1/image/generations/")) { queries++; return json(complete(null)); }
    downloads++;
    return new Response(PNG, { headers: { "content-type": "image/png" } });
  } });
  const result = await finish(manager, await manager.createTask(request()));
  assert.equal(result.status, "completed");
  assert.equal(result.usage, null);
  assert.equal(queries, 3);
  assert.equal(downloads, 1);
});

test("failed refund reports final zero and sanitizes raw provider errors", async (t) => {
  const { manager } = await fixture(t, { fetch: async (_url, options) => options.method === "POST" ? json({ id: "p-fail" }) : json({ code: "success", data: { status: "failed", fail_reason: `raw token ${KEY}`, usage: { amount: 0, currency: "CNY" } } }) });
  const result = await finish(manager, await manager.createTask(request()));
  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { amount: 0, currency: "CNY" });
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("unknown provider status is paused, never fabricated as completed", async (t) => {
  const { manager } = await fixture(t, { fetch: async (_url, options) => options.method === "POST" ? json({ id: "p-unknown" }) : json({ data: { status: "SOMETHING_NEW", result_url: "https://cdn.example.com/a.png", usage: { amount: 123, currency: "CNY" } } }) });
  const result = await finish(manager, await manager.createTask(request()));
  assert.equal(result.status, "paused");
  assert.equal(result.results.length, 0);
  assert.equal(result.usage, null);
});

test("download failure retains original provider task and retries only query/download", async (t) => {
  let posts = 0;
  let downloads = 0;
  const { manager } = await fixture(t, { fetch: async (url, options) => {
    if (options.method === "POST") { posts++; return json({ task_id: "p-download" }); }
    if (url.includes("/v1/image/generations/")) return json(complete());
    downloads++;
    return downloads === 1 ? new Response("temporary", { status: 503 }) : new Response(PNG, { headers: { "content-type": "image/png" } });
  } });
  const first = await finish(manager, await manager.createTask(request()));
  assert.equal(first.status, "paused");
  assert.equal(first.providerTaskId, "p-download");
  assert.equal(first.results.length, 0);
  assert.deepEqual(first.usage, { amount: 8.75, currency: "CNY" });
  const retry = await manager.checkTask(first.id);
  assert.equal((await finish(manager, retry)).status, "completed");
  assert.equal(posts, 1);
  assert.equal(downloads, 2);
});

test("shutdown bounds a non-settling fetch and restart resumes GET without POST", async (t) => {
  let posts = 0;
  let startedQuery = false;
  const { manager, paths } = await fixture(t, { fetch: async (_url, options) => {
    if (options.method === "POST") { posts++; return json({ id: "p-restart" }); }
    startedQuery = true;
    return new Promise(() => {});
  } });
  const task = await manager.createTask(request());
  await until(() => startedQuery);
  const started = Date.now();
  await manager.close();
  assert.ok(Date.now() - started < 1000);
  assert.equal(manager.getTask(task.id).status, "paused");
  const resumedCalls = [];
  const resumed = new ImageServiceManager({ paths, credentials: codec, resolveHostname: resolver, delay: async () => {}, fetch: async (url, options) => {
    resumedCalls.push(options.method);
    if (url.includes("/v1/image/generations/")) return json(complete());
    return new Response(PNG, { headers: { "content-type": "image/png" } });
  } });
  await resumed.initialize();
  assert.equal((await finish(resumed, resumed.getTask(task.id))).status, "completed");
  assert.deepEqual(resumedCalls, ["GET", "GET"]);
  assert.equal(posts, 1);
  await resumed.close();
});

test("shutdown also bounds a hanging response body and no-id interrupted submit remains unconfirmed", async (t) => {
  let responseStarted = false;
  const { manager, paths } = await fixture(t, { fetch: async () => {
    responseStarted = true;
    return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
  } });
  const task = await manager.createTask(request());
  await until(() => responseStarted);
  await manager.close();
  assert.equal(manager.getTask(task.id).status, "unconfirmed");
  const resumed = new ImageServiceManager({ paths, credentials: codec, resolveHostname: resolver, fetch: async () => { throw new Error("must never submit"); } });
  await resumed.initialize();
  assert.equal(resumed.getTask(task.id).status, "unconfirmed");
  assert.equal(resumed.activeTasks().length, 0);
  await resumed.close();
});

test("one active task blocks another request, and model mismatch requires reconfirmation", async (t) => {
  const { manager } = await fixture(t, { fetch: async () => new Promise(() => {}) });
  await assert.rejects(manager.createTask(request([], [], { model: "another-model" })), { code: "IMAGE_CONFIG_CHANGED" });
  await manager.createTask(request());
  await assert.rejects(manager.createTask(request()), { code: "IMAGE_TASK_BUSY" });
  assert.equal(manager.activeTasks().length, 1);
});

test("image references reject public-name/private-DNS, loopback, credentials and data URLs", async (t) => {
  const { manager } = await fixture(t, { resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }] });
  await assert.rejects(manager.createTask(request([], ["https://looks-public.example.com/a.png"])), { code: "IMAGE_URL_PRIVATE" });
  for (const url of ["http://example.com/a", "https://127.0.0.1/a", "https://[::1]/a", "https://u:p@example.com/a", "data:image/png;base64,x", "https://example.com:4173/a", "https://metadata.google.internal/a", "https://2130706433/a"]) {
    assert.throws(() => publicHttpsUrl(url));
  }
  for (const ip of ["10.0.0.1", "172.16.2.1", "192.168.1.1", "100.64.0.1", "169.254.169.254", "::ffff:127.0.0.1", "2001:db8::1", "2001::1", "2002:7f00:1::"]) assert.equal(isPublicAddress(ip), false);
  await assert.rejects(resolvePublicUrl("https://public.example.com/a", async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.1", family: 4 }]), { code: "IMAGE_URL_PRIVATE" });
});

test("download redirect to private host is refused and never carries API credentials", async (t) => {
  const calls = [];
  const { manager } = await fixture(t, { fetch: async (url, options) => {
    calls.push({ url, options });
    if (options.method === "POST") return json({ id: "p-redirect" });
    if (url.includes("/v1/image/generations/")) return json(complete());
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
  } });
  const result = await finish(manager, await manager.createTask(request()));
  assert.equal(result.status, "paused");
  assert.equal(calls.some((call) => call.url.includes("127.0.0.1")), false);
  assert.equal(calls.at(-1).options.headers, undefined);
});

test("POST redirects are rejected, not followed with a Bearer key", async (t) => {
  const calls = [];
  const { manager } = await fixture(t, { fetch: async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 307, headers: { location: "https://evil.example.com" } }); } });
  const result = await finish(manager, await manager.createTask(request()));
  assert.equal(result.status, "unconfirmed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "manual");
});

test("non-image downloads fail without changing project source media", async (t) => {
  const { manager, paths } = await fixture(t, { fetch: async (url, options) => {
    if (url.endsWith("/v1/files/upload")) return json({ url: "https://cdn.example.com/upload.png" });
    if (options.method === "POST") return json({ id: "p-html" });
    if (url.includes("/v1/image/generations/")) return json(complete());
    return new Response("<html>not an image</html>", { headers: { "content-type": "text/html" } });
  } });
  const source = path.join(paths.workspaceRoot, "data_src", "aligned", "source.png");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, PNG);
  const input = await manager.stageAligned({ side: "src", name: "source.png" });
  const result = await finish(manager, await manager.createTask(request([input.inputId])));
  assert.equal(result.status, "paused");
  assert.deepEqual(await readFile(source), PNG);
  assert.equal(result.results.length, 0);
});

test("JPEG APP15 and PNG private chunks are stripped without touching pixel chunks", () => {
  const privateData = Buffer.from("pickle:/private/source/path.jpg");
  const app = Buffer.alloc(4 + privateData.length);
  app[0] = 255; app[1] = 239; app.writeUInt16BE(privateData.length + 2, 2); privateData.copy(app, 4);
  const pixel = Buffer.from([255, 218, 0, 2, 4, 5, 6, 255, 217]);
  const jpeg = Buffer.concat([Buffer.from([255, 216]), app, pixel]);
  assert.deepEqual(stripImagePrivateMetadata(jpeg), Buffer.concat([Buffer.from([255, 216]), pixel]));
  assert.equal(jpeg.includes(privateData), true);
  const chunk = Buffer.alloc(12 + privateData.length);
  chunk.writeUInt32BE(privateData.length, 0); chunk.write("fcWp", 4); privateData.copy(chunk, 8);
  const decorated = Buffer.concat([PNG.subarray(0, 33), chunk, PNG.subarray(33)]);
  assert.deepEqual(stripImagePrivateMetadata(decorated), PNG);
});

test("corrupt settings are retained with a scoped error, never silently overwritten", async (t) => {
  const { paths, manager } = await fixture(t);
  await manager.close();
  await writeFile(manager.settingsFile, "bad-json");
  const broken = new ImageServiceManager({ paths, credentials: codec, fetch: async () => { throw new Error("must not call"); } });
  await broken.initialize();
  assert.ok(broken.settings().settingsError);
  assert.equal(broken.settings().hasKey, false);
  await assert.rejects(broken.saveSettings({ apiKey: KEY }), { code: "IMAGE_SETTINGS_READ_FAILED" });
  assert.equal(await readFile(manager.settingsFile, "utf8"), "bad-json");
  await broken.close();
});

test("polling reaches its finite bound and offers continuing the same task", async (t) => {
  let posts = 0;
  const { manager } = await fixture(t, { pollTimeoutMs: 10, delay: () => new Promise((resolve) => setTimeout(resolve, 20)), fetch: async (_url, options) => {
    if (options.method === "POST") { posts++; return json({ id: "p-long" }); }
    return json({ data: { status: "IN_PROGRESS" } });
  } });
  const task = await finish(manager, await manager.createTask(request()));
  assert.equal(task.status, "paused");
  assert.equal(task.canCheck, true);
  assert.equal(posts, 1);
});

test("shutdown bounds a DNS lookup that never settles during image download", async (t) => {
  let resolving = false;
  const { manager } = await fixture(t, {
    resolveHostname: async () => { resolving = true; return new Promise(() => {}); },
    fetch: async (_url, options) => options.method === "POST" ? json({ id: "p-dns" }) : json(complete()),
  });
  const task = await manager.createTask(request());
  await until(() => resolving);
  const started = Date.now();
  await manager.close();
  assert.ok(Date.now() - started < 1000);
  assert.equal(manager.getTask(task.id).status, "paused");
});

test("announced oversize and image MIME mismatch cannot be saved as results", async (t) => {
  let downloadKind = "oversize";
  const { manager } = await fixture(t, { fetch: async (url, options) => {
    if (options.method === "POST") return json({ id: "p-size-type" });
    if (url.includes("/v1/image/generations/")) return json(complete());
    return new Response(PNG, { headers: downloadKind === "oversize"
      ? { "content-type": "image/png", "content-length": String(50 * 1024 * 1024 + 1) }
      : { "content-type": "image/jpeg" } });
  } });
  let task = await finish(manager, await manager.createTask(request()));
  assert.equal(task.status, "paused");
  assert.equal(task.results.length, 0);
  assert.match(task.error, /大小/);
  downloadKind = "mismatch";
  task = await finish(manager, await manager.checkTask(task.id));
  assert.equal(task.status, "paused");
  assert.equal(task.results.length, 0);
  assert.match(task.error, /类型/);
});

test("confirmed model is immutable while a local input is being uploaded", async (t) => {
  let uploading = false;
  let releaseUpload;
  let submitted;
  const uploaded = new Promise((resolve) => { releaseUpload = resolve; });
  const { manager } = await fixture(t, { fetch: async (url, options) => {
    if (url.endsWith("/v1/files/upload")) { uploading = true; await uploaded; return json({ url: "https://cdn.example.com/reference.png" }); }
    if (options.method === "POST") { submitted = JSON.parse(options.body); return json({ id: "p-model" }); }
    if (url.includes("/v1/image/generations/")) return json(complete());
    return new Response(PNG, { headers: { "content-type": "image/png" } });
  } });
  const previousModel = manager.settings().model;
  const input = await manager.stageInput({ name: "reference.png", bytes: PNG });
  const task = await manager.createTask(request([input.inputId], [], { model: previousModel }));
  await until(() => uploading);
  await manager.saveSettings({ model: "another-confirmed-model" });
  releaseUpload();
  assert.equal((await finish(manager, task)).status, "completed");
  assert.equal(submitted.model, previousModel);
  assert.equal(manager.getTask(task.id).model, previousModel);
  assert.equal(manager.settings().model, "another-confirmed-model");
});
