/**
 * HTTP request security, anti-CSRF / anti-DNS-rebinding validators, bounded JSON body
 * reader, and common query/scope helpers for `sidecars/dashboard/server.mjs`.
 */
import crypto from "node:crypto";

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const OVERSIZED_BODY_DRAIN_TIMEOUT_MS = 5_000;
const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const MAX_SEARCH_QUERIES = 20;
const MAX_SEARCH_QUERY_CHARS = 256;

export function isAllowedHostHeader(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  return LOCAL_HOST_RE.test(hostHeader.trim());
}

export function isAllowedOriginHeader(originHeader, hostHeader = null) {
  if (originHeader === undefined || originHeader === null || originHeader === "") return true;
  if (typeof originHeader !== "string") return false;
  const trimmed = originHeader.trim();
  if (!LOCAL_ORIGIN_RE.test(trimmed)) return false;
  try {
    const originUrl = new URL(trimmed);
    if (originUrl.protocol !== "http:") return false;
    if (typeof hostHeader === "string" && hostHeader.trim()) {
      const reqHostUrl = new URL(`http://${hostHeader.trim()}`);
      if (originUrl.hostname.toLowerCase() !== reqHostUrl.hostname.toLowerCase()) return false;
      const originPort = originUrl.port || "80";
      const hostPort = reqHostUrl.port || "80";
      if (originPort !== hostPort) return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function isAllowedRefererHeader(refererHeader, hostHeader = null) {
  if (refererHeader === undefined || refererHeader === null || refererHeader === "") return true;
  if (typeof refererHeader !== "string") return false;
  const trimmed = refererHeader.trim();
  if (!trimmed) return true;
  try {
    const refUrl = new URL(trimmed);
    return isAllowedOriginHeader(refUrl.origin, hostHeader);
  } catch {
    return false;
  }
}

export function isCrossSiteFetchHeader(secFetchSite, { allowSameSite = false } = {}) {
  if (secFetchSite === undefined || secFetchSite === null) return false;
  if (typeof secFetchSite !== "string") return true;
  const normalized = secFetchSite.trim().toLowerCase();
  if (!normalized || normalized === "same-origin" || normalized === "none") return false;
  if (allowSameSite && normalized === "same-site") return false;
  return true;
}

export function isJsonContentType(contentType) {
  return typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType.trim());
}

export function timingSafeTokenMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function discardOversizedBody(req) {
  req.resume();
  if (req.complete || req.destroyed) return;
  const timer = setTimeout(() => {
    if (!req.complete && !req.destroyed) req.destroy();
  }, OVERSIZED_BODY_DRAIN_TIMEOUT_MS);
  timer.unref();
  const cancelTimer = () => clearTimeout(timer);
  req.once("end", cancelTimer);
  req.once("close", cancelTimer);
}

export function readBoundedJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve) => {
    const rawContentLen = req.headers?.["content-length"];
    if (rawContentLen !== undefined) {
      const declaredLen = Number(rawContentLen);
      if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
        req.on("error", () => {});
        discardOversizedBody(req);
        resolve({ ok: false, status: 413, error: `Request body exceeds ${Math.round(maxBytes / 1024)} KB limit` });
        return;
      }
    }
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let overflowed = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk) => {
      if (overflowed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        discardOversizedBody(req);
        finish({ ok: false, status: 413, error: `Request body exceeds ${Math.round(maxBytes / 1024)} KB limit` });
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (overflowed || settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish({ ok: true, data: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, error: "Request body must be a JSON object" });
          return;
        }
        finish({ ok: true, data: parsed });
      } catch (err) {
        finish({ ok: false, status: 400, error: err instanceof Error ? err.message : "Invalid JSON body" });
      }
    });

    req.on("error", (err) => {
      finish({ ok: false, status: 400, error: err instanceof Error ? err.message : "Request stream error" });
    });

    req.on("aborted", () => {
      finish({ ok: false, status: 400, error: "Request stream aborted" });
    });

    req.on("close", () => {
      if (!settled && !req.complete) {
        finish({ ok: false, status: 400, error: "Request stream closed prematurely" });
      }
    });
  });
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

export function isUncPath(p) {
  return typeof p === "string" && /^[\\/]{2}/.test(p.trim());
}

export function validateStringFields(data, fields) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: true };
  for (const field of fields) {
    const val = data[field];
    if (val !== undefined && val !== null && typeof val !== "string") {
      return { ok: false, error: `Field '${field}' must be a string` };
    }
  }
  return { ok: true };
}

export function validateAndNormalizeSearchInput(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  if (data.queries !== undefined) {
    if (!Array.isArray(data.queries)) {
      return { ok: false, error: "Field 'queries' must be an array of strings" };
    }
    if (data.queries.length > MAX_SEARCH_QUERIES) {
      return { ok: false, error: `At most ${MAX_SEARCH_QUERIES} search queries are allowed per request` };
    }
    const queries = [];
    for (const q of data.queries) {
      if (typeof q !== "string") {
        return { ok: false, error: "Each item in 'queries' must be a string" };
      }
      queries.push(q.slice(0, MAX_SEARCH_QUERY_CHARS));
    }
    return { ok: true, queries };
  }
  if (data.query !== undefined && data.query !== null && typeof data.query !== "string") {
    return { ok: false, error: "Field 'query' must be a string" };
  }
  return { ok: true, queries: [typeof data.query === "string" ? data.query.slice(0, MAX_SEARCH_QUERY_CHARS) : ""] };
}

export function resolveTargetSession(data, defaultConvId = "default") {
  const safeSessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  const safeConvId = typeof data?.conversationId === "string" ? data.conversationId : "";
  const rawScope = typeof data?.scope === "string" && data.scope.trim() ? data.scope.trim() : "";
  const scope =
    rawScope === "all"
      ? "lifetime"
      : rawScope === "session"
        ? "app"
        : rawScope || (safeSessionId === "all" ? "lifetime" : safeSessionId === "app" ? "app" : "conversation");
  const convId =
    safeConvId ||
    (safeSessionId && safeSessionId !== "all" && safeSessionId !== "app" ? safeSessionId : defaultConvId || "default");
  let targetSid = convId;
  if (scope === "lifetime" || scope === "all") targetSid = "all";
  else if (scope === "app" || scope === "session") targetSid = "app";
  return { scope, convId, targetSid };
}

/**
 * Only allow SidecarApp mode when ANTIGRAVITY_SIDECAR_UI_TOKEN is explicitly non-empty
 * (sidecar_sdk fails open on authentication when its token is empty/missing).
 */
export function shouldUseSidecarApp(env = process.env, hasSidecarApp = true) {
  return Boolean(
    hasSidecarApp &&
      typeof env?.ANTIGRAVITY_LS_ADDRESS === "string" && env.ANTIGRAVITY_LS_ADDRESS.trim() &&
      typeof env?.ANTIGRAVITY_CSRF_TOKEN === "string" && env.ANTIGRAVITY_CSRF_TOKEN.trim() &&
      typeof env?.ANTIGRAVITY_SIDECAR_WEB_PORT === "string" && env.ANTIGRAVITY_SIDECAR_WEB_PORT.trim() &&
      typeof env?.ANTIGRAVITY_SIDECAR_UI_TOKEN === "string" && env.ANTIGRAVITY_SIDECAR_UI_TOKEN.trim() &&
      env?.SIDECAR_FORCE_HTTP !== "1"
  );
}

/**
 * Resolve standalone HTTP port: prefer explicit PORT, then host-assigned
 * ANTIGRAVITY_SIDECAR_WEB_PORT, and finally default to 8765.
 */
export function resolveStandalonePort(env = process.env) {
  for (const raw of [env?.PORT, env?.ANTIGRAVITY_SIDECAR_WEB_PORT]) {
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 65535) {
      return raw === 0 ? 0 : raw;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
          return parsed;
        }
      }
    }
  }
  return 8765;
}
