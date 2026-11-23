import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

const MAX_BYTES = 8 * 1024 * 1024;

function decodeBody(buffer, encoding) {
  const value = String(encoding || "").trim().toLowerCase();
  if (!value || value === "identity") return buffer;
  if (value === "gzip" || value === "x-gzip") return zlib.gunzipSync(buffer);
  if (value === "deflate") return zlib.inflateSync(buffer);
  if (value === "br") return zlib.brotliDecompressSync(buffer);
  throw Object.assign(new Error("unsupported content encoding"), { code: "CONTENT_ENCODING" });
}

function timeoutError() {
  return Object.assign(new Error("request timeout"), { name: "TimeoutError", code: "TIMEOUT" });
}

export function isRequestTimeout(err) {
  const name = err?.name;
  const code = err?.code;
  return name === "TimeoutError"
    || name === "AbortError"
    || code === "TIMEOUT"
    || code === "ABORT_ERR"
    || code === 20
    || code === "UND_ERR_HEADERS_TIMEOUT"
    || code === "UND_ERR_BODY_TIMEOUT"
    || code === "UND_ERR_CONNECT_TIMEOUT";
}

// Absolute deadline for both response headers and body. The global http(s)
// agent is left in place so NODE_USE_ENV_PROXY still selects managed egress.
// Do not pass a custom agent or agent:false here.
export function boundedRequest(url, { method = "GET", headers = {}, body = null, timeoutMs } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(Object.assign(new Error("invalid timeout"), { code: "INVALID_TIMEOUT" }));
  }
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(Object.assign(new Error("unsupported protocol"), { code: "UNSUPPORTED_PROTOCOL" }));
  }
  const lib = target.protocol === "https:" ? https : http;
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;
    let timedOut = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(absolute);
      if (err) reject(err);
      else resolve(value);
    };
    const failTimeout = () => {
      if (settled || timedOut) return;
      timedOut = true;
      const err = timeoutError();
      response?.destroy(err);
      req.destroy(err);
    };
    const absolute = setTimeout(failTimeout, timeoutMs);
    const req = lib.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers: payload
        ? { ...headers, "Content-Length": String(payload.length) }
        : headers,
    }, (res) => {
      response = res;
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          const err = Object.assign(new Error("response too large"), { code: "RESPONSE_TOO_LARGE" });
          res.destroy(err);
          req.destroy(err);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (timedOut) {
          finish(timeoutError());
          return;
        }
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          finish(Object.assign(new Error(`HTTP ${status}`), { code: "HTTP_STATUS", status }));
          return;
        }
        let buffer;
        try {
          buffer = decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]);
        } catch (err) {
          finish(err.code === "CONTENT_ENCODING" ? err : Object.assign(err, { code: err.code || "CONTENT_ENCODING" }));
          return;
        }
        finish(null, { status, headers: res.headers, buffer });
      });
      res.on("error", (err) => finish(timedOut ? timeoutError() : err));
      res.on("aborted", () => finish(timeoutError()));
    });
    req.on("error", (err) => finish(timedOut || isRequestTimeout(err) ? timeoutError() : err));
    req.on("timeout", failTimeout);
    req.setTimeout(timeoutMs);
    if (payload) req.end(payload);
    else req.end();
  });
}
