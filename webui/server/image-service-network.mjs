import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import { Readable } from "node:stream";

const TRUSTED_DNS_RESOLVERS = Object.freeze([
  Object.freeze({ hostname: "cloudflare-dns.com", path: "/dns-query" }),
  Object.freeze({ hostname: "dns.google", path: "/resolve" }),
]);
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;

function isSyntheticProxyAddress(value) {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 198 && (second === 18 || second === 19);
}

function trustedDnsQuery(resolver, hostname, type, { signal, requestImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      request?.destroy();
      response?.destroy();
      finish(new ImageServiceError("公开 DNS 查询已中断或超时", "IMAGE_URL_DNS_INVALID"));
    };
    if (signal?.aborted) { abort(); return; }
    try {
      // Only these fixed, TLS-verified resolver hosts may be contacted. This
      // bootstrap intentionally uses system DNS so a TUN/fake-IP proxy can
      // route it. No provider headers, credentials or redirects are accepted.
      request = requestImpl({
        protocol: "https:", hostname: resolver.hostname, port: 443,
        path: `${resolver.path}?name=${encodeURIComponent(hostname)}&type=${type}`,
        method: "GET", headers: { Accept: "application/dns-json" }, agent: false,
      }, (incoming) => {
        response = incoming;
        if (response.statusCode !== 200) {
          finish(new ImageServiceError("公开 DNS 查询服务不可用", "IMAGE_URL_DNS_INVALID"));
          response.destroy();
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_DNS_RESPONSE_BYTES) { abort(); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.once("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (payload?.Status !== 0 || payload.TC === true || payload.Answer != null && !Array.isArray(payload.Answer)) {
              throw new Error("invalid DNS reply");
            }
            finish(null, payload.Answer ?? []);
          } catch {
            finish(new ImageServiceError("公开 DNS 查询响应无法识别", "IMAGE_URL_DNS_INVALID"));
          }
        });
        response.once("error", () => finish(new ImageServiceError("公开 DNS 查询连接中断", "IMAGE_URL_DNS_INVALID")));
        response.once("aborted", abort);
      });
      request.once("error", () => finish(new ImageServiceError("公开 DNS 查询服务无法连接", "IMAGE_URL_DNS_INVALID")));
      if (!settled) {
        timer = setTimeout(abort, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }
      request.end();
    } catch {
      finish(new ImageServiceError("公开 DNS 查询服务无法连接", "IMAGE_URL_DNS_INVALID"));
    }
  });
}

export async function trustedDnsRecords(hostname, {
  signal, requestImpl = https.request, timeoutMs = 5000,
} = {}) {
  for (const resolver of TRUSTED_DNS_RESOLVERS) {
    const replies = await Promise.allSettled(["A", "AAAA"].map((type) => (
      trustedDnsQuery(resolver, hostname, type, { signal, requestImpl, timeoutMs })
    )));
    if (signal?.aborted) throw new ImageServiceError("公开 DNS 查询已中断", "IMAGE_URL_DNS_INVALID");
    const records = replies.flatMap((reply) => reply.status === "fulfilled" ? reply.value : [])
      .filter((answer) => answer?.type === 1 || answer?.type === 28)
      .map((answer) => ({ address: answer.data, family: answer.type === 1 ? 4 : 6 }));
    if (records.some((record) => isIP(record.address) !== record.family || !isPublicAddress(record.address))) {
      throw new ImageServiceError("图片地址不能指向本机或私有网络", "IMAGE_URL_PRIVATE");
    }
    if (records.length) return records.filter((record, index) => records.findIndex((other) => other.address === record.address) === index);
  }
  throw new ImageServiceError("图片地址无法解析为公开地址", "IMAGE_URL_DNS_INVALID");
}

export class ImageServiceError extends Error {
  constructor(message, code = "IMAGE_SERVICE_ERROR", status = 400) {
    super(message);
    this.name = "ImageServiceError";
    this.code = code;
    this.status = status;
  }
}

export function isPublicAddress(value) {
  const address = String(value).toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Only global unicast. Exclude mapped IPv4, transition/tunnel and documentation ranges.
    return /^[23][0-9a-f]{3}:/.test(address)
      && !/^2001:(?:db8|0*|0{0,3}2|0{0,2}10|0{0,2}20):/.test(address)
      && !address.startsWith("2002:");
  }
  return false;
}

export function publicHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ImageServiceError("图片地址必须是公开 HTTPS 链接", "IMAGE_URL_INVALID"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (typeof value !== "string" || value.length > 4096 || url.protocol !== "https:"
    || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || !hostname || hostname === "localhost" || !hostname.includes(".") && !isIP(hostname)
    || /\.(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname)
    || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new ImageServiceError("图片地址必须是公开 HTTPS 链接", "IMAGE_URL_INVALID");
  }
  return url;
}

export function abortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("aborted")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export async function resolvePublicUrl(value, resolve = (hostname) => lookup(hostname, { all: true, verbatim: true }), signal, resolveSynthetic = trustedDnsRecords) {
  const url = publicHttpsUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let records;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 15_000);
  try {
    records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(Promise.resolve().then(() => resolve(hostname)), controller.signal);
    // Clash and similar TUN proxies may synthesize every DNS answer in the
    // benchmarking range. Resolve only that exact case through trusted DoH;
    // ordinary private addresses and mixed public/private replies still fail.
    if (!isIP(hostname) && Array.isArray(records) && records.length
      && records.every((record) => isSyntheticProxyAddress(record.address))) {
      records = await abortable(Promise.resolve().then(() => resolveSynthetic(hostname, { signal: controller.signal })), controller.signal);
    }
  }
  catch (error) {
    if (error instanceof ImageServiceError && error.code === "IMAGE_URL_PRIVATE") throw error;
    throw new ImageServiceError("图片地址无法解析为公开地址", "IMAGE_URL_DNS_INVALID");
  }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  if (!Array.isArray(records) || !records.length || records.some((record) => !isPublicAddress(record.address))) {
    throw new ImageServiceError("图片地址不能指向本机或私有网络", "IMAGE_URL_PRIVATE");
  }
  return { url, records };
}

// Resolve once and pin the checked public IP to the HTTPS connection. The host
// name is still used for SNI and certificate validation. This prevents a second
// DNS lookup from turning the check into a DNS-rebinding race.
export async function publicImageFetch(value, options = {}) {
  const { url, records } = await resolvePublicUrl(String(value), undefined, options.signal);
  const body = options.body;
  let outgoing = null;
  const headers = new Headers(options.headers ?? {});
  if (body instanceof FormData) {
    const encoded = new Request(url, { method: options.method || "POST", body });
    headers.set("content-type", encoded.headers.get("content-type"));
    outgoing = Readable.fromWeb(encoded.body);
  } else if (body != null) {
    outgoing = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    headers.set("content-length", String(outgoing.length));
  }
  return new Promise((resolve, reject) => {
    const record = records[0];
    const request = https.request(url, {
      method: options.method || "GET",
      headers: Object.fromEntries(headers),
      signal: options.signal,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions.all) callback(null, [record]);
        else callback(null, record.address, record.family);
      },
      agent: false,
    }, (response) => {
      const responseHeaders = new Headers();
      for (const [key, headerValue] of Object.entries(response.headers)) {
        if (Array.isArray(headerValue)) for (const item of headerValue) responseHeaders.append(key, item);
        else if (headerValue != null) responseHeaders.set(key, headerValue);
      }
      const noBody = [204, 205, 304].includes(response.statusCode);
      if (noBody) response.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(response), { status: response.statusCode, headers: responseHeaders }));
    });
    request.once("error", (error) => { if (outgoing instanceof Readable) outgoing.destroy(); reject(error); });
    if (outgoing instanceof Readable) {
      outgoing.once("error", (error) => request.destroy(error));
      outgoing.pipe(request);
    } else request.end(outgoing);
  });
}
