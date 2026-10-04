import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { resolvePublicUrl, trustedDnsRecords } from "../server/image-service-network.mjs";

const publicRecords = [{ address: "104.21.28.210", family: 4 }];
const syntheticRecords = [{ address: "198.18.0.42", family: 4 }, { address: "198.19.255.1", family: 4 }];

function dnsTransport(reply) {
  const calls = [];
  const requests = [];
  const requestImpl = (options, callback) => {
    calls.push(options);
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return;
      const data = reply(options);
      if (data === null) return;
      const response = Readable.from([Buffer.from(typeof data.body === "string" ? data.body : JSON.stringify(data.body))]);
      response.statusCode = data.status ?? 200;
      callback(response);
    });
    requests.push(request);
    return request;
  };
  return { requestImpl, calls, requests };
}

test("only all-synthetic proxy DNS replies use trusted fallback, preserving checked public records", async () => {
  const calls = [];
  const controller = new AbortController();
  const { url, records } = await resolvePublicUrl("https://api.qizhi.cc/docs/", async () => syntheticRecords,
    controller.signal, async (hostname, options) => { calls.push({ hostname, options }); return publicRecords; });
  assert.equal(url.hostname, "api.qizhi.cc");
  assert.deepEqual(records, publicRecords);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, "api.qizhi.cc");
  assert.deepEqual(Object.keys(calls[0].options), ["signal"]);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("ordinary private or mixed DNS addresses never enable proxy fallback", async () => {
  let fallbacks = 0;
  const fallback = async () => { fallbacks++; return publicRecords; };
  for (const records of [
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "192.168.1.2", family: 4 }],
    [{ address: "10.0.0.1", family: 4 }],
    [syntheticRecords[0], publicRecords[0]],
    [syntheticRecords[0], { address: "172.16.0.1", family: 4 }],
  ]) {
    await assert.rejects(resolvePublicUrl("https://public.example.com/a.png", async () => records,
      undefined, fallback), { code: "IMAGE_URL_PRIVATE" });
  }
  const result = await resolvePublicUrl("https://public.example.com/a.png", async () => publicRecords,
    undefined, fallback);
  assert.deepEqual(result.records, publicRecords);
  await assert.rejects(resolvePublicUrl("https://198.18.0.1/a.png", undefined, undefined, fallback), { code: "IMAGE_URL_INVALID" });
  assert.equal(fallbacks, 0);
});

test("trusted DNS uses fixed HTTPS hosts, public A/AAAA records and no provider credentials", async () => {
  const transport = dnsTransport(options => ({ body: {
    Status: 0, Answer: new URL(`https://resolver.example${options.path}`).searchParams.get("type") === "A"
      ? [{ type: 5, data: "alias.example.com" }, { type: 1, data: "104.21.28.210" }]
      : [{ type: 28, data: "2606:4700:4700::1111" }],
  } }));
  const records = await trustedDnsRecords("api.qizhi.cc", { requestImpl: transport.requestImpl });
  assert.deepEqual(records, [...publicRecords, { address: "2606:4700:4700::1111", family: 6 }]);
  assert.equal(transport.calls.length, 2);
  for (const options of transport.calls) {
    assert.equal(options.protocol, "https:");
    assert.equal(options.hostname, "cloudflare-dns.com");
    assert.equal(options.port, 443);
    assert.equal(options.method, "GET");
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, undefined, "default TLS certificate validation remains enabled");
    assert.deepEqual(options.headers, { Accept: "application/dns-json" });
    assert.equal(options.headers.Authorization, undefined);
    assert.match(options.path, /^\/dns-query\?name=api\.qizhi\.cc&type=(A|AAAA)$/);
  }
});

test("trusted DNS rejects private, synthetic and malformed address replies", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "198.18.0.5", "not-an-address"] ) {
    const transport = dnsTransport(() => ({ body: { Status: 0, Answer: [{ type: 1, data: address }] } }));
    await assert.rejects(trustedDnsRecords("public.example.com", { requestImpl: transport.requestImpl }), { code: "IMAGE_URL_PRIVATE" });
    assert.equal(transport.calls.length, 2, "a private reply must not be replaced by another resolver's answer");
  }
  await assert.rejects(resolvePublicUrl("https://public.example.com/a.png", async () => syntheticRecords,
    undefined, async () => [{ address: "192.168.1.1", family: 4 }]), { code: "IMAGE_URL_PRIVATE" });
});

test("trusted DNS does not follow redirects and may try only the second fixed resolver", async () => {
  const transport = dnsTransport(options => options.hostname === "cloudflare-dns.com"
    ? { status: 302, body: { location: "https://127.0.0.1/private" } }
    : { body: { Status: 0, Answer: [{ type: 1, data: "104.21.28.210" }] } });
  assert.deepEqual(await trustedDnsRecords("api.qizhi.cc", { requestImpl: transport.requestImpl }), publicRecords);
  assert.deepEqual(transport.calls.map(options => options.hostname), ["cloudflare-dns.com", "cloudflare-dns.com", "dns.google", "dns.google"]);
  assert.ok(transport.calls.slice(2).every(options => options.path.startsWith("/resolve?")));
});

test("trusted DNS timeout and cancellation destroy outstanding connections", async () => {
  const hanging = dnsTransport(() => null);
  const started = Date.now();
  await assert.rejects(trustedDnsRecords("api.qizhi.cc", { requestImpl: hanging.requestImpl, timeoutMs: 10 }), { code: "IMAGE_URL_DNS_INVALID" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(hanging.requests.length, 4);
  assert.ok(hanging.requests.every(request => request.destroyed));

  const cancelled = dnsTransport(() => null);
  const controller = new AbortController();
  const pending = trustedDnsRecords("api.qizhi.cc", { requestImpl: cancelled.requestImpl, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "IMAGE_URL_DNS_INVALID" });
  assert.equal(cancelled.requests.length, 2);
  assert.ok(cancelled.requests.every(request => request.destroyed));
});

test("trusted DNS bounds response bytes and rejects invalid or truncated JSON", async () => {
  for (const body of ["x".repeat(64 * 1024 + 1), "not-json", { Status: 0, TC: true }, { Status: 0, Answer: {} }]) {
    const transport = dnsTransport(() => ({ body }));
    await assert.rejects(trustedDnsRecords("api.qizhi.cc", { requestImpl: transport.requestImpl }), { code: "IMAGE_URL_DNS_INVALID" });
  }
});
