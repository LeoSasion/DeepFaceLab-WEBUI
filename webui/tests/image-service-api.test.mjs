import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { RuntimeServer } from "../server/app-server.mjs";

function runtime(imageServiceManager, extra = {}) {
  return new RuntimeServer({
    imageServiceManager,
    jobManager: { list: () => [] },
    operationManager: { list: () => [] },
    ...extra,
  });
}

async function call(server, method, url, { body, headers = {}, session = true } = {}) {
  const raw = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const request = Readable.from(raw.length ? [raw] : []);
  Object.assign(request, {
    method, url, headers: {
      host: "127.0.0.1:4174",
      ...(session ? { cookie: `dfl_web_session=${server.sessionToken}` } : {}),
      ...headers,
    },
  });
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  response.writeHead = (status, responseHeaders) => { response.status = status; response.headers = responseHeaders; };
  const finished = new Promise(resolve => response.on("finish", resolve));
  await server.handleRequest(request, response);
  await finished;
  return { status: response.status, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
}

test("image settings retain local-session write authorization and never expose a key", async () => {
  const writes = [];
  const server = runtime({
    settings: async () => ({ hasKey: true, provider: "qizhi" }),
    saveSettings: async value => { writes.push(value); return { hasKey: true }; },
  });
  const noSession = await call(server, "PUT", "/api/image-service/settings", { session: false, body: { apiKey: "secret" } });
  assert.equal(noSession.status, 403);
  assert.equal(writes.length, 0);
  const foreign = await call(server, "PUT", "/api/image-service/settings", {
    body: { apiKey: "secret" }, headers: { origin: "https://other.example" },
  });
  assert.equal(foreign.status, 403);
  const saved = await call(server, "PUT", "/api/image-service/settings", { body: { apiKey: "secret" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(writes, [{ apiKey: "secret" }]);
  assert.equal(JSON.stringify(saved.body).includes("secret"), false);
  const read = await call(server, "GET", "/api/image-service/settings");
  assert.deepEqual(read.body.data, { hasKey: true, provider: "qizhi" });
});

test("image staging is local binary data and oversized uploads never reach the manager", async () => {
  const staged = [];
  const server = runtime({ stageInput: async data => { staged.push(data); return { inputId: "input-1", name: data.name }; } });
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const response = await call(server, "POST", "/api/image-service/inputs?name=%E4%BA%BA%E8%84%B8.jpg", { body: bytes });
  assert.equal(response.status, 201);
  assert.equal(staged[0].name, "人脸.jpg");
  assert.deepEqual(staged[0].bytes, bytes);
  const tooLarge = await call(server, "POST", "/api/image-service/inputs?name=large.png", {
    headers: { "content-length": String(50 * 1024 * 1024 + 1) },
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(staged.length, 1);
});

test("create, history and check preserve request identity and report a missing task honestly", async () => {
  const task = { id: "image-1", requestId: "request-1", status: "pending" };
  const writes = [];
  const checks = [];
  const server = runtime({
    createTask: async body => { writes.push(body); return task; },
    listTasks: () => [task],
    getTask: id => id === task.id ? task : null,
    checkTask: async id => { checks.push(id); return { ...task, status: "completed" }; },
  });
  const body = { requestId: task.requestId, consent: { provider: "qizhi", inputIds: [], imageUrls: [] } };
  assert.equal((await call(server, "POST", "/api/image-service/tasks", { body })).status, 202);
  assert.deepEqual(writes, [body]);
  assert.deepEqual((await call(server, "GET", "/api/image-service/tasks")).body.data, [task]);
  assert.equal((await call(server, "GET", "/api/image-service/tasks/image-1")).body.data.status, "pending");
  assert.equal((await call(server, "GET", "/api/image-service/tasks/missing")).status, 404);
  assert.equal((await call(server, "POST", "/api/image-service/tasks/image-1/check")).body.data.status, "completed");
  assert.deepEqual(checks, ["image-1"]);
  assert.equal(writes.length, 1);
});

test("active image work blocks project activation before the registry is written", async () => {
  let activated = false;
  const server = runtime({ activeTasks: () => [{ id: "image-1", status: "uploading" }] }, {
    projectManager: { activate: async () => { activated = true; return {}; } },
  });
  const result = await call(server, "POST", "/api/projects/other/activate");
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "PROJECT_IMAGE_TASK_BUSY");
  assert.equal(activated, false);
  assert.deepEqual(server.activeOperations().map(task => task.id), ["image-1"]);
});

test("pending project restart refuses new staged material and generation", async () => {
  let called = false;
  const server = runtime({ createTask: async () => { called = true; }, stageInput: async () => { called = true; } });
  server.projectRestartPending = true;
  assert.equal((await call(server, "POST", "/api/image-service/tasks", { body: {} })).status, 409);
  assert.equal((await call(server, "POST", "/api/image-service/inputs?name=test.jpg")).status, 409);
  assert.equal(called, false);
});

test("an unreadable image history is unknown and does not become an empty list", async () => {
  let read = false;
  const server = runtime({ listTasks: () => { read = true; return []; } });
  server.imageServiceInitializationError = Object.assign(new Error("项目图像记录无法读取"), {
    status: 500, code: "IMAGE_RECORD_INVALID",
  });
  const result = await call(server, "GET", "/api/image-service/tasks");
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, "IMAGE_RECORD_INVALID");
  assert.equal(read, false);
  assert.equal((await call(server, "GET", "/api/commands")).status, 200);
});
