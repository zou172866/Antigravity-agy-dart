import fs from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { getConfigSnapshot } from "./config.js";
import { executeCode, inferLanguageFromFile, resolveExecTimeoutMs, runProcess, OUTPUT_CAP } from "./executor.js";
import { SNIPPET_MAX_BYTES } from "./store.js";
import {
  detectSensitiveFile,
  getSensitiveFileGuardMode,
  isSecretRedactionEnabled,
  redactSecrets,
  sanitizeUrlForDisplay,
  validateFetchTarget
} from "./security.js";

const EXEC_PREVIEW_BYTES = 4096;
const MAX_INLINE_PREVIEW_BYTES = 8100; // Keep total MCP JSON response <= 8.8 KB to avoid Antigravity output.txt disk spills
const MAX_MCP_JSON_BYTES = 8700;
const MAX_FETCH_REDIRECTS = 5;
const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;
const MAX_INDEX_FILE_BYTES = 32 * 1024 * 1024;
const RESERVED_SESSION_SENTINELS = new Set(["all", "lifetime", "app", "default"]);

function isAnonymousSession(id) {
  return id === "default" || /^workspace:[a-f0-9]{64}$/.test(id);
}

export function normalizeSessionId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (/[\x00-\x1f\x7f\\/]/.test(trimmed)) return null;
  if (RESERVED_SESSION_SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function expandArgPath(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  while (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) {
      const inner = s.slice(1, -1);
      if (inner.includes(q)) break;
      s = inner.trim();
      continue;
    }
    break;
  }
  if (!s) return "";
  const joinExpandedTail = (base, rawTail) => {
    const segs = String(rawTail || "").split(/[\\/]+/).filter(Boolean);
    return segs.length > 0 ? path.join(base, ...segs) : base;
  };
  if (/^file:\/\//i.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      return s;
    }
  } else if (s === "~") {
    s = os.homedir();
  } else if (s.startsWith("~/") || s.startsWith("~\\")) {
    s = joinExpandedTail(os.homedir(), s.slice(2));
  } else {
    const tmpMatch = s.match(
      /^(?:\$\{(?:env:)?(?:TMPDIR|TEMP|TMP)\}|\$(?:env:)?(?:TMPDIR|TEMP|TMP)|%(?:TEMP|TMP)%)(?=$|[\\/])(.*)$/i
    );
    if (tmpMatch) {
      s = joinExpandedTail(os.tmpdir(), tmpMatch[1]);
    } else {
      const homeMatch = s.match(
        /^(?:\$\{(?:env:)?(?:HOME|USERPROFILE)\}|\$(?:env:)?(?:HOME|USERPROFILE)|%(?:HOME|USERPROFILE)%)(?=$|[\\/])(.*)$/i
      );
      if (homeMatch) {
        s = joinExpandedTail(os.homedir(), homeMatch[1]);
      } else {
        const localAppMatch = s.match(
          /^(?:\$\{(?:env:)?LOCALAPPDATA\}|\$(?:env:)?LOCALAPPDATA|%LOCALAPPDATA%)(?=$|[\\/])(.*)$/i
        );
        if (localAppMatch) {
          const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
          s = joinExpandedTail(base, localAppMatch[1]);
        }
      }
    }
  }
  return s;
}

const MAX_INTENT_LABEL_BYTES = 240;

function resolveIntentText(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const collapsed = candidate.replace(/\s+/g, " ").trim();
      if (collapsed) return truncateUtf8(collapsed, MAX_INTENT_LABEL_BYTES);
    }
  }
  return "";
}

function resolveCallCwd(
  argCwd,
  fallbackCwd,
  { requireConfirmedWorkspace = false, workspaceConfirmed = true } = {}
) {
  const base = fallbackCwd || process.cwd();
  const cleanedArg = expandArgPath(argCwd);
  if (!cleanedArg) {
    if (requireConfirmedWorkspace && !workspaceConfirmed) {
      throw new Error(
        `Workspace root could not be determined from server cwd '${base}'. Pass the active workspace absolute path in 'cwd'.`
      );
    }
    return base;
  }
  if (!path.isAbsolute(cleanedArg) && requireConfirmedWorkspace && !workspaceConfirmed) {
    throw new Error(
      `Workspace root could not be determined from server cwd '${base}'. Pass the active workspace absolute path in 'cwd'.`
    );
  }
  const resolved = path.resolve(base, cleanedArg);
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error(`Working directory not found: ${argCwd}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${argCwd}`);
  }
  return resolved;
}

let jsonCrusherMod = undefined;
async function getJsonCrusher() {
  if (jsonCrusherMod === undefined) {
    try {
      jsonCrusherMod = await import("./json-crusher.js");
    } catch {
      jsonCrusherMod = null;
    }
  }
  return jsonCrusherMod;
}

/** Truncate string strictly by UTF-8 byte length without breaking surrogate/multi-byte chars */
function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (!text || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return sliced.replace(/\uFFFD+$/, "");
}

/**
 * Guarantee that BOTH `JSON.stringify(obj, null, 2)` AND its double-encoded MCP JSON-RPC
 * wire envelope (`{ jsonrpc:"2.0", id, result:{ content:[{ type:"text", text: JSON.stringify(obj) }], isError:false } }\n`)
 * stay strictly <= maxJsonBytes UTF-8 bytes even after JSON-in-JSON escaping (quotes/newlines) expands string fields.
 */
export function capSerializedJsonField(obj, fieldName, rawBody, suffix = "", maxJsonBytes = MAX_MCP_JSON_BYTES) {
  obj[fieldName] = `${rawBody}${suffix}`;
  const measure = () => {
    const prettyBytes = Buffer.byteLength(JSON.stringify(obj, null, 2), "utf8");
    const wireEnvelope = JSON.stringify({
      jsonrpc: "2.0",
      id: "00000000-0000-0000-0000-000000000000",
      result: {
        content: [{ type: "text", text: JSON.stringify(obj) }],
        isError: false
      }
    });
    const wireBytes = Buffer.byteLength(wireEnvelope, "utf8") + 1; // +1 for trailing \n
    return Math.max(prettyBytes, wireBytes);
  };
  if (measure() <= maxJsonBytes) {
    return { truncatedForJson: false, keptBody: rawBody };
  }
  const rawBytes = Buffer.byteLength(rawBody, "utf8");
  let lo = 0;
  let hi = rawBytes;
  let best = "";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = truncateUtf8(rawBody, mid);
    obj[fieldName] = `${candidate}${suffix}`;
    if (measure() <= maxJsonBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  obj[fieldName] = `${best}${suffix}`;
  return { truncatedForJson: true, keptBody: best };
}

const MAX_TOOL_CALL_WIRE_BYTES = 8800;

function truncateUtf8ForWire(text, maxBytes) {
  if (maxBytes <= 0 || !text) return "";
  const buf = Buffer.from(String(text), "utf8");
  if (buf.length <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    let start = end - 1;
    while (start > 0 && (buf[start] & 0xc0) === 0x80) start -= 1;
    const lead = buf[start];
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;
    if (end - start < seqLen) end = start;
  }
  return buf.subarray(0, end).toString("utf8");
}

function binarySearchWireUtf8(rawText, suffix, fitsFn) {
  const totalBytes = Buffer.byteLength(rawText, "utf8");
  let lo = 0;
  let hi = totalBytes;
  let best = "";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = truncateUtf8ForWire(rawText, mid);
    if (fitsFn(`${candidate}${suffix}`)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (fitsFn(`${best}${suffix}`)) return `${best}${suffix}`;
  let sLo = 0;
  let sHi = Buffer.byteLength(suffix, "utf8");
  let sBest = "";
  while (sLo <= sHi) {
    const mid = (sLo + sHi) >> 1;
    const cand = truncateUtf8ForWire(suffix, mid);
    if (fitsFn(cand)) {
      sBest = cand;
      sLo = mid + 1;
    } else {
      sHi = mid - 1;
    }
  }
  return sBest;
}

/**
 * Enforce an absolute UTF-8 byte ceiling (default 8,800 B) on the complete outbound
 * JSON-RPC line (`JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"`), covering
 * double-escaped `content[0].text`, `structuredContent` dual payloads, and `isError` replies.
 */
export function enforceToolCallWireBudget(id, response, maxWireBytes = MAX_TOOL_CALL_WIRE_BYTES) {
  const measureLine = (resObj) =>
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result: resObj }) + "\n", "utf8");

  if (!response || typeof response !== "object" || measureLine(response) <= maxWireBytes) {
    return response;
  }

  const next = {
    ...response,
    ...(Array.isArray(response.content)
      ? { content: response.content.map((item) => (item && typeof item === "object" ? { ...item } : item)) }
      : {})
  };

  if (next.structuredContent !== undefined && measureLine(next) > maxWireBytes) {
    if (next.structuredContent && typeof next.structuredContent === "object") {
      next.structuredContent = { kind: next.structuredContent.kind || "diagnostics", wireTruncated: true };
      if (measureLine(next) > maxWireBytes) {
        delete next.structuredContent;
      }
    } else {
      delete next.structuredContent;
    }
  }

  if (measureLine(next) <= maxWireBytes) {
    return next;
  }

  const firstTextItem = Array.isArray(next.content)
    ? next.content.find((item) => item && item.type === "text" && typeof item.text === "string")
    : null;

  if (firstTextItem) {
    let parsed = null;
    try {
      const maybe = JSON.parse(firstTextItem.text);
      if (maybe && typeof maybe === "object" && !Array.isArray(maybe)) {
        parsed = maybe;
      }
    } catch {}

    if (parsed) {
      const setJsonText = (obj) => {
        firstTextItem.text = JSON.stringify(obj);
        return measureLine(next) <= maxWireBytes;
      };
      const truncSuffix = parsed.sourceId
        ? `\n... [wire-capped <=8.8 KB; use ctx_search(sourceId: "${parsed.sourceId}")]`
        : "\n... [wire-capped <=8.8 KB]";

      const preferredFields = ["output", "content", "summary", "brief", "snippet", "text", "error"];
      const stringKeys = Object.keys(parsed)
        .filter((k) => typeof parsed[k] === "string" && parsed[k].length > 0)
        .sort((a, b) => {
          const ai = preferredFields.indexOf(a);
          const bi = preferredFields.indexOf(b);
          if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
          return parsed[b].length - parsed[a].length;
        });

      for (const key of stringKeys) {
        if (measureLine(next) <= maxWireBytes) break;
        const origVal = parsed[key];
        parsed[key] = binarySearchWireUtf8(origVal, truncSuffix, (cand) => {
          parsed[key] = cand;
          if (Object.prototype.hasOwnProperty.call(parsed, "returnedBytes")) {
            parsed.returnedBytes = Buffer.byteLength(cand, "utf8");
          }
          parsed.wireTruncated = true;
          return setJsonText(parsed);
        });
        if (Object.prototype.hasOwnProperty.call(parsed, "returnedBytes")) {
          parsed.returnedBytes = Buffer.byteLength(parsed[key], "utf8");
        }
        parsed.wireTruncated = true;
        setJsonText(parsed);
      }

      const arrayKeys = Object.keys(parsed)
        .filter((k) => Array.isArray(parsed[k]) && parsed[k].length > 0)
        .sort((a, b) => JSON.stringify(parsed[b]).length - JSON.stringify(parsed[a]).length);
      for (const arrKey of arrayKeys) {
        if (measureLine(next) <= maxWireBytes) break;
        const origArr = parsed[arrKey];
        parsed.wireTruncated = true;
        while (origArr.length > 0 && !setJsonText(parsed)) {
          origArr.pop();
        }
      }

      if (measureLine(next) > maxWireBytes) {
        const minimal = {
          ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}),
          ...(parsed.ok !== undefined ? { ok: parsed.ok } : {}),
          ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
          wireTruncated: true
        };
        if (!setJsonText(minimal)) {
          firstTextItem.text = binarySearchWireUtf8(JSON.stringify(minimal), "", (cand) => {
            firstTextItem.text = cand;
            return measureLine(next) <= maxWireBytes;
          });
        }
      }
      return next;
    }

    const plainSuffix = "... [truncated to <=8.8 KB wire budget]";
    firstTextItem.text = binarySearchWireUtf8(firstTextItem.text, plainSuffix, (cand) => {
      firstTextItem.text = cand;
      return measureLine(next) <= maxWireBytes;
    });
  }

  return next;
}

/**
 * Fetch URL text content with SSRF hardening:
 *  - Enforces http:/https: protocol whitelist
 *  - Resolves relative Location redirects up to maxRedirects (default 5)
 *  - Validates DNS per hop against private/loopback/link-local IPs & pins resolved IP
 */
export async function fetchUrlText(urlStr, timeoutOrOptions = 15000) {
  const opts =
    typeof timeoutOrOptions === "number"
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions && typeof timeoutOrOptions === "object"
        ? timeoutOrOptions
        : {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 15000;
  const maxRedirects =
    Number.isInteger(opts.maxRedirects) && opts.maxRedirects >= 0 ? opts.maxRedirects : MAX_FETCH_REDIRECTS;
  const maxBodyBytes =
    Number.isFinite(opts.maxBodyBytes) && opts.maxBodyBytes > 0 ? opts.maxBodyBytes : MAX_FETCH_BODY_BYTES;

  const deadline = Date.now() + timeoutMs;
  let currentUrl = String(urlStr || "").trim();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remainingBeforeDns = deadline - Date.now();
    if (remainingBeforeDns <= 0) {
      throw new Error("Request timed out");
    }

    const { parsed, pinned, pinnedRecords } = await validateFetchTarget(currentUrl, {
      ...(opts.allowPrivate !== undefined ? { allowPrivate: Boolean(opts.allowPrivate) } : {}),
      lookupFn: opts.lookupFn,
      timeoutMs: remainingBeforeDns
    });

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Request timed out");
    }

    const outcome = await new Promise((resolve, reject) => {
      let settled = false;
      const client = parsed.protocol === "https:" ? https : http;
      const validated = Array.isArray(pinnedRecords) && pinnedRecords.length > 0 ? pinnedRecords : [pinned];
      const pinnedLookup = (_hostname, lookupOpts, cb) => {
        const callback = typeof lookupOpts === "function" ? lookupOpts : cb;
        const wantAll = typeof lookupOpts === "object" && lookupOpts && lookupOpts.all;
        const reqFamily = typeof lookupOpts === "object" && lookupOpts ? lookupOpts.family : 0;
        const filtered =
          reqFamily === 4 || reqFamily === 6 ? validated.filter((r) => r.family === reqFamily) : validated;
        const chosen = filtered.length > 0 ? filtered : validated;
        if (wantAll) {
          callback(
            null,
            chosen.map((r) => ({ address: r.address, family: r.family }))
          );
        } else {
          callback(null, chosen[0].address, chosen[0].family);
        }
      };

      let req = null;
      const finishResolve = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        resolve(val);
      };
      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        reject(err);
      };

      const deadlineTimer = setTimeout(() => {
        if (!settled) {
          finishReject(new Error("Request timed out"));
          if (req) req.destroy();
        }
      }, remainingMs);
      deadlineTimer.unref();

      req = client.get(
        parsed,
        {
          timeout: remainingMs,
          lookup: pinnedLookup,
          ...(opts.agent ? { agent: opts.agent } : {}),
          headers: { "User-Agent": "agy-dart/1.2" }
        },
        (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400) {
            const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
            if (!loc) {
              finishReject(new Error(`HTTP ${code} redirect missing Location header`));
              res.destroy();
              req.destroy();
              return;
            }
            let nextUrl;
            try {
              nextUrl = new URL(loc, parsed).toString();
            } catch {
              finishReject(new Error(`Invalid redirect Location header: ${loc}`));
              res.destroy();
              req.destroy();
              return;
            }
            finishResolve({ redirectTo: nextUrl });
            res.destroy();
            req.destroy();
            return;
          }
          if (code >= 400) {
            finishReject(new Error(`HTTP ${code} ${res.statusMessage || ""}`.trim()));
            res.destroy();
            req.destroy();
            return;
          }
          const chunks = [];
          let total = 0;
          let truncatedByLimit = false;
          const doneBody = () => {
            let buf = Buffer.concat(chunks);
            if (truncatedByLimit && buf.length > 0) {
              let start = buf.length - 1;
              while (start > 0 && (buf[start] & 0xc0) === 0x80) {
                start -= 1;
              }
              const lead = buf[start];
              let expectedLen = 1;
              if ((lead & 0xe0) === 0xc0) expectedLen = 2;
              else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
              else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
              if (buf.length - start < expectedLen) {
                buf = buf.subarray(0, start);
              }
            }
            finishResolve({ body: buf.toString("utf8") });
          };
          res.on("data", (c) => {
            if (settled) return;
            if (total < maxBodyBytes) {
              const remain = maxBodyBytes - total;
              if (c.byteLength > remain) {
                truncatedByLimit = true;
                chunks.push(c.subarray(0, remain));
                total += remain;
              } else {
                chunks.push(c);
                total += c.byteLength;
              }
            } else {
              truncatedByLimit = true;
            }
            if (total >= maxBodyBytes) {
              truncatedByLimit = true;
              doneBody();
              res.destroy();
              req.destroy();
            }
          });
          res.on("end", doneBody);
          res.on("error", (err) => finishReject(err));
        }
      );
      req.on("error", (err) => finishReject(err));
      req.on("timeout", () => {
        finishReject(new Error("Request timed out"));
        req.destroy();
      });
    });

    if (outcome.redirectTo) {
      if (hop >= maxRedirects) {
        throw new Error(`Too many redirects (exceeded max ${maxRedirects} hops)`);
      }
      currentUrl = outcome.redirectTo;
      continue;
    }
    return outcome.body || "";
  }

  throw new Error(`Too many redirects (exceeded max ${maxRedirects} hops)`);
}

/** Render helper for ASCII bar chart */
function renderBar(ratio, width = 28) {
  const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
  const empty = width - filled;
  return `[${"=".repeat(filled)}${" ".repeat(empty)}]`;
}

/** Format size nicely */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Build tools registry bound to store and active context */
export function createTools({
  store,
  getCwd = () => process.cwd(),
  getWorkspaceState = null,
  getSessionId = () => "default",
  getDirectConversationId = null
}) {
  const resolveWs = () => {
    if (typeof getWorkspaceState === "function") {
      const st = getWorkspaceState();
      if (st && typeof st === "object") {
        return {
          cwd: st.cwd || getCwd(),
          confirmed: st.confirmed !== false
        };
      }
    }
    return { cwd: getCwd(), confirmed: true };
  };
  return {
    // 1. ctx_execute
    async ctx_execute({
      language = undefined,
      code = "",
      file = "",
      args = [],
      intent = "",
      summary = "",
      description = "",
      cwd: argCwd = "",
      timeoutSec = undefined,
      timeoutMs: argTimeoutMs = undefined
    } = {}) {
      const startTime = Date.now();
      const resolvedIntent = resolveIntentText(intent, summary, description);
      const expandedFile = typeof file === "string" && file.trim() ? expandArgPath(file) : "";
      const effectiveCode = expandedFile && typeof code === "string" && !code.trim() ? "" : code;
      const rawLang = typeof language === "string" ? language.trim() : "";
      const effectiveLanguage =
        rawLang || (expandedFile ? inferLanguageFromFile(expandedFile) : "") || "shell";
      const ws = resolveWs();
      const cwd = resolveCallCwd(argCwd, ws.cwd, {
        requireConfirmedWorkspace: true,
        workspaceConfirmed: ws.confirmed
      });
      const sessionId = getSessionId(cwd);

      if (expandedFile) {
        const absFile = path.isAbsolute(expandedFile)
          ? path.normalize(expandedFile)
          : path.resolve(cwd, expandedFile);
        let realAbsFile = absFile;
        try {
          realAbsFile = fs.realpathSync(absFile);
        } catch {}
        const sensDirect = detectSensitiveFile(absFile);
        const sensReal =
          realAbsFile !== absFile ? detectSensitiveFile(realAbsFile) : { sensitive: false, reason: null };
        const sens = sensDirect.sensitive ? sensDirect : sensReal;
        if (sens.sensitive && getSensitiveFileGuardMode() === "deny") {
          throw new Error(
            `Blocked executing sensitive file '${path.basename(absFile)}' (${sens.reason}) because sensitiveFileGuard is set to 'deny'.`
          );
        }
      }

      const cfgTimeoutMs = getConfigSnapshot().values.execTimeoutMs;
      const requestedTimeoutMs =
        timeoutSec !== undefined && timeoutSec !== null && timeoutSec !== "" && typeof timeoutSec !== "boolean"
          ? Number(timeoutSec) * 1000
          : argTimeoutMs;
      const effTimeoutMs = resolveExecTimeoutMs(requestedTimeoutMs, cfgTimeoutMs);

      const result = await executeCode({
        language: effectiveLanguage,
        code: effectiveCode,
        file: expandedFile,
        args,
        cwd,
        timeoutMs: effTimeoutMs
      });

      const elapsedMs = Date.now() - startTime;
      const timeoutHint = result.timedOut
        ? `\n[ctx_execute timed out after ${Math.round(effTimeoutMs / 1000)}s. For >60s builds/tests or background servers/watchers, use native run_command (WaitMsBeforeAsync <= 2000) instead of synchronous MCP.]`
        : "";
      const rawCombined =
        (result.stdout ? result.stdout : "") +
        (result.stderr ? "\n" + result.stderr : "") +
        timeoutHint;
      const redacted = redactSecrets(rawCombined);
      const fullOutput = redacted.text;
      const fullBytes = Buffer.byteLength(fullOutput, "utf8");
      const executionReceipt = isAnonymousSession(sessionId) ? randomBytes(16).toString("hex") : null;

      let sourceId = null;
      let deduplicated = false;
      if (fullBytes > 0) {
        const indexed = store.indexContent({
          sessionId,
          worktree: cwd,
          agent: "antigravity",
          kind: "execution",
          label: resolvedIntent || `${effectiveLanguage} script (${elapsedMs}ms)`,
          content: fullOutput,
          dedup: !isAnonymousSession(sessionId)
        });
        sourceId = indexed.sourceId;
        deduplicated = Boolean(indexed.deduplicated);
      }

      const cutoffBytes = store.getCutoff(sessionId);
      // Hard-cap preview to keep total MCP JSON response <= 8.8 KB inline (avoid Antigravity output.txt spills)
      const previewCapBytes = Math.min(
        MAX_INLINE_PREVIEW_BYTES,
        cutoffBytes > 0 ? cutoffBytes * 2 : EXEC_PREVIEW_BYTES * 2
      );

      let returnedText = fullOutput;
      let truncated = false;
      let crushedJson = false;
      if (fullBytes > previewCapBytes) {
        const crusher = await getJsonCrusher();
        if (crusher && crusher.isJsonLike(fullOutput)) {
          const initialBudget = Math.min(previewCapBytes, 6800);
          let crushed = crusher.smartCrushJson(fullOutput, {
            maxBytes: initialBudget,
            sourceId
          });
          if (crushed.crushed) {
            // Check JSON-in-JSON escaping overhead so capSerializedJsonField doesn't chop valid crushed JSON
            const probeObj = {
              ...(executionReceipt ? { executionReceipt } : {}),
              ok: result.ok,
              exitCode: result.exitCode,
              ...(result.timedOut ? { timedOut: true } : {}),
              elapsedMs,
              language: effectiveLanguage,
              intent: resolvedIntent || null,
              sourceId,
              deduplicated,
              crushedJson: true,
              rawBytes: fullBytes,
              returnedBytes: crushed.crushedBytes,
              ...(redacted.redactedCount > 0 ? { redactedSecrets: redacted.redactedCount } : {}),
              output: crushed.text
            };
            const probeBytes = Buffer.byteLength(JSON.stringify(probeObj, null, 2), "utf8");
            if (probeBytes > MAX_MCP_JSON_BYTES) {
              const targetBudget = Math.max(
                512,
                Math.floor((initialBudget * (MAX_MCP_JSON_BYTES - 450)) / probeBytes)
              );
              const reCrushed = crusher.smartCrushJson(fullOutput, {
                maxBytes: targetBudget,
                sourceId
              });
              if (reCrushed.crushed) crushed = reCrushed;
            }
            returnedText = crushed.text;
            crushedJson = true;
          }
        }
        if (!crushedJson) {
          returnedText = truncateUtf8(fullOutput, previewCapBytes);
          truncated = true;
        }
      }

      const truncSuffix = sourceId
        ? `\n\n... [truncated to protect context window; full output indexed into ${sourceId}. Use ctx_search(queries: [...], sourceId: "${sourceId}") to query it]`
        : "\n\n... [truncated to protect context window]";

      const responseObj = {
        ...(executionReceipt ? { executionReceipt } : {}),
        ok: result.ok,
        exitCode: result.exitCode,
        ...(result.timedOut ? { timedOut: true } : {}),
        elapsedMs,
        language: effectiveLanguage,
        intent: resolvedIntent || null,
        sourceId,
        deduplicated,
        ...(crushedJson ? { crushedJson: true } : {}),
        rawBytes: fullBytes,
        returnedBytes: Buffer.byteLength(returnedText, "utf8"),
        ...(redacted.redactedCount > 0 ? { redactedSecrets: redacted.redactedCount } : {}),
        output: ""
      };

      const cappedExec = capSerializedJsonField(
        responseObj,
        "output",
        returnedText,
        truncated ? truncSuffix : "",
        MAX_MCP_JSON_BYTES
      );
      if (cappedExec.truncatedForJson && !truncated) {
        const reCapped = capSerializedJsonField(
          responseObj,
          "output",
          returnedText,
          truncSuffix,
          MAX_MCP_JSON_BYTES
        );
        returnedText = reCapped.keptBody;
        truncated = true;
      } else {
        returnedText = cappedExec.keptBody;
      }

      const returnedBytes = Buffer.byteLength(returnedText, "utf8");
      responseObj.returnedBytes = returnedBytes;

      store.recordEvent({
        sessionId,
        worktree: cwd,
        agent: "antigravity",
        kind: "execution",
        tool: "ctx_execute",
        executionReceipt,
        sourceId,
        key: effectiveLanguage,
        path: expandedFile || null,
        ok: result.ok ? 1 : 0,
        exitCode: result.exitCode,
        bytes: fullBytes,
        body: returnedText,
        sandboxBytes: fullBytes,
        returnedBytes
      });

      return responseObj;
    },

    // 2. ctx_batch
    async ctx_batch({ commands = [], queries = [], cwd: argCwd = "" } = {}) {
      const ws = resolveWs();
      const cwd = resolveCallCwd(argCwd, ws.cwd, {
        requireConfirmedWorkspace: true,
        workspaceConfirmed: ws.confirmed
      });
      const sessionId = getSessionId(cwd);
      const cmdList = Array.isArray(commands) ? commands : [commands];
      const outputs = [];
      let totalRawBytes = 0;
      const effTimeoutMs = resolveExecTimeoutMs(undefined, getConfigSnapshot().values.execTimeoutMs);

      for (const cmd of cmdList) {
        if (!cmd) continue;
        const res = await executeCode({ language: "shell", code: cmd, cwd, timeoutMs: effTimeoutMs });
        const text = `=== Command: ${cmd} (exit: ${res.exitCode}) ===\n${res.stdout || ""}${res.stderr ? "\n[stderr]\n" + res.stderr : ""}\n`;
        totalRawBytes += Buffer.byteLength(text, "utf8");
        outputs.push(text);
      }

      const redactedBatch = redactSecrets(outputs.join("\n"));
      const combined = redactedBatch.text;
      totalRawBytes = Buffer.byteLength(combined, "utf8");
      const executionReceipt = isAnonymousSession(sessionId) ? randomBytes(16).toString("hex") : null;
      const indexed = store.indexContent({
        sessionId,
        worktree: cwd,
        agent: "antigravity",
        kind: "batch",
        label: `batch: ${cmdList.length} commands`,
        content: combined,
        dedup: !isAnonymousSession(sessionId)
      });
      const deduplicated = Boolean(indexed.deduplicated);

      let returnedContent = "";
      let batchTruncated = false;
      if (queries && queries.length > 0) {
        const searchRes = store.search({
          queries,
          sourceId: indexed.sourceId,
          sessionId,
          limit: 10
        });
        returnedContent = searchRes.hits.map((h) => `[ord ${h.ord}] ${h.snippet}`).join("\n\n---\n\n");
        if (Buffer.byteLength(returnedContent, "utf8") > MAX_INLINE_PREVIEW_BYTES) {
          returnedContent = truncateUtf8(returnedContent, MAX_INLINE_PREVIEW_BYTES - 160);
          batchTruncated = true;
        }
      } else {
        returnedContent = truncateUtf8(combined, EXEC_PREVIEW_BYTES);
        if (totalRawBytes > EXEC_PREVIEW_BYTES) {
          batchTruncated = true;
        }
      }

      const batchSuffix = `\n\n... [truncated to stay <=8.8 KB inline; use ctx_search(queries: [...], sourceId: "${indexed.sourceId}")]`;
      const batchResp = {
        ...(executionReceipt ? { executionReceipt } : {}),
        commandsRun: cmdList.length,
        sourceId: indexed.sourceId,
        deduplicated,
        rawBytes: totalRawBytes,
        returnedBytes: 9999,
        ...(redactedBatch.redactedCount > 0 ? { redactedSecrets: redactedBatch.redactedCount } : {}),
        content: ""
      };
      const cappedBatch = capSerializedJsonField(
        batchResp,
        "content",
        returnedContent,
        batchTruncated ? batchSuffix : "",
        MAX_MCP_JSON_BYTES
      );
      if (cappedBatch.truncatedForJson && !batchTruncated) {
        const reCapped = capSerializedJsonField(
          batchResp,
          "content",
          returnedContent,
          batchSuffix,
          MAX_MCP_JSON_BYTES
        );
        returnedContent = reCapped.keptBody;
      } else {
        returnedContent = cappedBatch.keptBody;
      }

      const returnedBytes = Buffer.byteLength(batchResp.content, "utf8");
      batchResp.returnedBytes = returnedBytes;
      store.recordEvent({
        sessionId,
        worktree: cwd,
        agent: "antigravity",
        kind: "batch",
        tool: "ctx_batch",
        executionReceipt,
        sourceId: indexed.sourceId,
        ok: 1,
        bytes: totalRawBytes,
        body: returnedContent,
        sandboxBytes: totalRawBytes,
        returnedBytes
      });

      return batchResp;
    },

    // 3. ctx_index
    async ctx_index({ path: filePath = "", url = "", content = "", label = "", cwd: argCwd = "" } = {}) {
      const ws = resolveWs();
      const expandedFilePath = filePath ? expandArgPath(filePath) : "";
      const needsWorkspaceForRelativeFile = Boolean(expandedFilePath && !path.isAbsolute(expandedFilePath));
      const fileDir = !ws.confirmed && !argCwd && path.isAbsolute(expandedFilePath) ? path.dirname(expandedFilePath) : ws.cwd;
      const cwd = resolveCallCwd(argCwd, fileDir, {
        requireConfirmedWorkspace: needsWorkspaceForRelativeFile,
        workspaceConfirmed: ws.confirmed
      });
      const sessionId = getSessionId(cwd);
      let rawText = content || "";
      let resolvedLabel = label;
      let sensitiveFileWarning = null;

      let safeUrlForMeta = "";
      if (url) {
        safeUrlForMeta = sanitizeUrlForDisplay(url);
        resolvedLabel = resolvedLabel || safeUrlForMeta;
        rawText = await fetchUrlText(url);
      } else if (expandedFilePath) {
        resolvedLabel = resolvedLabel || filePath;
        const absPath = path.isAbsolute(expandedFilePath)
          ? path.normalize(expandedFilePath)
          : path.resolve(cwd, expandedFilePath);
        let st;
        try {
          st = fs.statSync(absPath);
        } catch {
          throw new Error(`File not found: ${filePath}`);
        }
        if (!st.isFile()) {
          throw new Error(`Not a regular file: ${filePath}`);
        }
        if (st.size > MAX_INDEX_FILE_BYTES) {
          throw new Error(
            `File too large to index (${formatBytes(st.size)} exceeds ${formatBytes(MAX_INDEX_FILE_BYTES)} limit): ${filePath}`
          );
        }
        let realAbsPath = absPath;
        try {
          realAbsPath = fs.realpathSync(absPath);
        } catch {
          // ignore
        }
        const sensDirect = detectSensitiveFile(absPath);
        const sensReal = realAbsPath !== absPath ? detectSensitiveFile(realAbsPath) : { sensitive: false, reason: null };
        const sens = sensDirect.sensitive ? sensDirect : sensReal;
        if (sens.sensitive) {
          if (getSensitiveFileGuardMode() === "deny") {
            throw new Error(
              `Blocked indexing sensitive file '${path.basename(absPath)}' (${sens.reason}) because sensitiveFileGuard is set to 'deny'.`
            );
          }
          sensitiveFileWarning = isSecretRedactionEnabled()
            ? `Indexed file '${path.basename(absPath)}' matches sensitive pattern (${sens.reason}); detected credentials were redacted before indexing.`
            : `Indexed file '${path.basename(absPath)}' matches sensitive pattern (${sens.reason}); warning: secret redaction is currently disabled.`;
        }
        rawText = fs.readFileSync(absPath, "utf8");
      }

      if (!rawText) {
        throw new Error("No content, file path, or url provided to index");
      }

      if (resolvedLabel) {
        resolvedLabel = /^https?:\/\//i.test(resolvedLabel)
          ? sanitizeUrlForDisplay(resolvedLabel)
          : redactSecrets(resolvedLabel).text;
      }

      const redacted = redactSecrets(rawText);
      const safeText = redacted.text;
      const executionReceipt = isAnonymousSession(sessionId) ? randomBytes(16).toString("hex") : null;

      const indexed = store.indexContent({
        sessionId,
        worktree: cwd,
        agent: "antigravity",
        kind: url ? "web" : filePath ? "file" : "text",
        label: resolvedLabel || "manual_index",
        content: safeText,
        dedup: !isAnonymousSession(sessionId)
      });

      const deduplicated = Boolean(indexed.deduplicated);
      const returnObj = {
        ...(executionReceipt ? { executionReceipt } : {}),
        sourceId: indexed.sourceId,
        label: indexed.label,
        bytesTotal: indexed.bytesTotal,
        chunkCount: indexed.chunkCount,
        deduplicated,
        ...(redacted.redactedCount > 0 ? { redactedSecrets: redacted.redactedCount } : {}),
        ...(sensitiveFileWarning ? { sensitiveFileWarning } : {}),
        message: deduplicated
          ? `Reused existing indexed source ${indexed.sourceId} (${formatBytes(indexed.bytesTotal)}, ${indexed.chunkCount} chunks, unchanged content). Query with ctx_search.`
          : `Indexed ${formatBytes(indexed.bytesTotal)} into ${indexed.chunkCount} chunks. Query with ctx_search.`
      };

      const returnedBytes = Buffer.byteLength(JSON.stringify(returnObj), "utf8");

      store.recordEvent({
        sessionId,
        worktree: cwd,
        agent: "antigravity",
        kind: "index",
        tool: "ctx_index",
        executionReceipt,
        sourceId: indexed.sourceId,
        path: filePath || safeUrlForMeta || null,
        ok: 1,
        bytes: deduplicated ? 0 : indexed.bytesTotal,
        body: returnObj.message,
        sandboxBytes: deduplicated ? 0 : indexed.bytesTotal,
        returnedBytes
      });

      return returnObj;
    },

    // 4. ctx_search
    async ctx_search({ queries = [], sourceId = null, scope = "session", limit = 5, offset = 0, cwd: argCwd = "" } = {}) {
      const ws = resolveWs();
      const cwd = resolveCallCwd(argCwd, ws.cwd, {
        requireConfirmedWorkspace: scope === "worktree",
        workspaceConfirmed: ws.confirmed
      });
      const sessionId = scope === "all" || scope === "worktree" ? null : getSessionId(cwd);

      const res = store.search({
        queries,
        sourceId,
        sessionId,
        worktree: cwd,
        scope,
        limit,
        offset
      });

      // Enforce <= 8.8 KB total JSON response UTF-8 cap (prevents Antigravity disk spills on large/CJK hits)
      const MAX_SEARCH_JSON_BYTES = 8600;
      const rawQueries = Array.isArray(queries) ? queries : typeof queries === "string" ? [queries] : [];
      const echoedQueries = rawQueries.slice(0, 20).map((q) => {
        const s = String(q ?? "");
        return Buffer.byteLength(s, "utf8") > 200 ? `${truncateUtf8(s, 196)}...` : s;
      });
      const boundedHits = [];
      const payload = {
        queries: echoedQueries,
        totalMatches: res.totalMatches,
        returned: 0,
        offset: res.offset,
        hits: boundedHits
      };
      const measurePayload = () => Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8");
      const snipSuffix = "\n... [capped <=8.8KB]";
      for (const hit of res.hits) {
        const entry = { ...hit };
        if (typeof entry.title === "string" && Buffer.byteLength(entry.title, "utf8") > 240) {
          entry.title = `${truncateUtf8(entry.title, 236)}...`;
        }
        boundedHits.push(entry);
        payload.returned = boundedHits.length;
        if (measurePayload() <= MAX_SEARCH_JSON_BYTES) {
          continue;
        }
        // Binary-search snippet length to fit exact outer JSON byte cap
        const origSnippet = typeof entry.snippet === "string" ? entry.snippet : "";
        let lo = 0;
        let hi = Buffer.byteLength(origSnippet, "utf8");
        let best = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const cand = truncateUtf8(origSnippet, mid);
          entry.snippet = `${cand}${snipSuffix}`;
          if (measurePayload() <= MAX_SEARCH_JSON_BYTES) {
            best = cand;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (best === null || (origSnippet.length > 0 && best.length === 0)) {
          boundedHits.pop();
          payload.returned = boundedHits.length;
          break;
        }
        entry.snippet = `${best}${snipSuffix}`;
      }

      return payload;
    },

    // 5. ctx_resume
    async ctx_resume({ seq = null, sessionId: argSessionId = null, cwd: argCwd = "" } = {}) {
      const explicitSid = normalizeSessionId(argSessionId);
      const sessionId = explicitSid || getSessionId(resolveCallCwd(argCwd, resolveWs().cwd));
      if (seq !== null && seq !== undefined) {
        const ev = store.getEventBySeq(seq, sessionId);
        if (!ev) throw new Error(`Event sequence #${seq} not found`);
        const boundedEv = { ...ev };
        if (typeof boundedEv.body === "string") {
          const wrap = { event: boundedEv };
          if (Buffer.byteLength(JSON.stringify(wrap, null, 2), "utf8") > MAX_MCP_JSON_BYTES) {
            capSerializedJsonField(
              boundedEv,
              "body",
              boundedEv.body,
              "\n... [capped <=8.8KB]",
              MAX_MCP_JSON_BYTES - 64
            );
          }
        }
        return { event: boundedEv };
      }

      // Calling ctx_resume signals compaction recovery: clear both shared and direct conversation read/snapshot caches
      try {
        store.invalidateFileReads(sessionId, null);
        const directConvId =
          explicitSid ||
          (typeof getDirectConversationId === "function"
            ? getDirectConversationId()
            : process.env.ANTIGRAVITY_CONVERSATION_ID || null);
        if (directConvId && directConvId !== sessionId) {
          store.invalidateFileReads(directConvId, null);
        }
      } catch {}

      const state = store.getResumeState(sessionId, 5);
      const stats = store.getStats(sessionId);
      const rawCp = state.sessionCheckpoint || store.getSessionCheckpoint(sessionId);
      const checkpoint = rawCp
        ? {
            ...rawCp,
            modifiedFiles: Array.isArray(rawCp.modifiedFiles) ? [...rawCp.modifiedFiles] : [],
            lastTest: rawCp.lastTest ? { ...rawCp.lastTest } : null,
            lastBuild: rawCp.lastBuild ? { ...rawCp.lastBuild } : null
          }
        : null;

      const isCheckpointEmpty =
        !checkpoint ||
        (checkpoint.modifiedFileCount === 0 && !checkpoint.lastTest && !checkpoint.lastBuild && !checkpoint.updatedAt);

      const resumePayload = {
        sessionId,
        stats: {
          calls: stats.calls,
          savedBytes: formatBytes(stats.keptOutBytes),
          savingsPercent: `${stats.savingsPercent}%`,
          tokensSaved: stats.tokensKeptOut
        },
        sessionCheckpoint: checkpoint,
        recentSources: Array.isArray(state.recentSources) ? [...state.recentSources] : [],
        recentEvents: Array.isArray(state.recentEvents) ? [...state.recentEvents] : []
      };

      if (
        isAnonymousSession(sessionId) &&
        isCheckpointEmpty &&
        typeof store.hasNonDefaultCheckpoints === "function" &&
        store.hasNonDefaultCheckpoints()
      ) {
        resumePayload.hint =
          "No host conversation ID was provided. Pass sessionId: '<your Conversation ID>' to recover this conversation's PostToolUse checkpoint and stats.";
      }

      // Strictly guarantee <= 8.8 KB UTF-8 inline cap even with adversarial CJK paths/commands
      const MAX_RESUME_JSON_BYTES = 8500;
      const jsonBytes = () => Buffer.byteLength(JSON.stringify(resumePayload, null, 2), "utf8");
      const shortenTailPath = (p, maxBytes = 120) => {
        const s = String(p || "");
        if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
        const buf = Buffer.from(s, "utf8");
        const tail = buf.subarray(Math.max(0, buf.length - (maxBytes - 3))).toString("utf8").replace(/^\uFFFD+/, "");
        return `...${tail}`;
      };

      while (jsonBytes() > MAX_RESUME_JSON_BYTES && resumePayload.recentEvents.length > 0) {
        resumePayload.recentEvents.pop();
      }
      while (jsonBytes() > MAX_RESUME_JSON_BYTES && resumePayload.recentSources.length > 0) {
        resumePayload.recentSources.pop();
      }
      if (jsonBytes() > MAX_RESUME_JSON_BYTES && Array.isArray(resumePayload.sessionCheckpoint?.modifiedFiles)) {
        resumePayload.sessionCheckpoint.modifiedFiles = resumePayload.sessionCheckpoint.modifiedFiles.map((p) =>
          shortenTailPath(p, 120)
        );
      }
      while (
        jsonBytes() > MAX_RESUME_JSON_BYTES &&
        Array.isArray(resumePayload.sessionCheckpoint?.modifiedFiles) &&
        resumePayload.sessionCheckpoint.modifiedFiles.length > 0
      ) {
        resumePayload.sessionCheckpoint.modifiedFiles.pop();
      }
      if (jsonBytes() > MAX_RESUME_JSON_BYTES && resumePayload.sessionCheckpoint) {
        for (const k of ["lastTest", "lastBuild"]) {
          const item = resumePayload.sessionCheckpoint[k];
          if (!item) continue;
          if (typeof item.failureExcerpt === "string") {
            item.failureExcerpt = truncateUtf8(item.failureExcerpt, 240);
          }
          if (typeof item.summary === "string") item.summary = truncateUtf8(item.summary, 180);
          if (typeof item.command === "string") item.command = truncateUtf8(item.command, 120);
        }
      }
      if (jsonBytes() > MAX_RESUME_JSON_BYTES && resumePayload.sessionCheckpoint) {
        for (const k of ["lastTest", "lastBuild"]) {
          const item = resumePayload.sessionCheckpoint[k];
          if (!item) continue;
          if (typeof item.failureExcerpt === "string") {
            item.failureExcerpt = truncateUtf8(item.failureExcerpt, 100);
          }
          if (typeof item.summary === "string") item.summary = truncateUtf8(item.summary, 64);
          if (typeof item.command === "string") item.command = truncateUtf8(item.command, 64);
        }
      }
      if (jsonBytes() > MAX_RESUME_JSON_BYTES && resumePayload.sessionCheckpoint) {
        for (const k of ["lastTest", "lastBuild"]) {
          const item = resumePayload.sessionCheckpoint[k];
          if (!item) continue;
          if ("failureExcerpt" in item) delete item.failureExcerpt;
        }
      }

      return resumePayload;
    },

    // 6. ctx_stats
    async ctx_stats({ reset = false, sessionId: argSessionId = null, cwd: argCwd = "" } = {}) {
      const explicitSid = normalizeSessionId(argSessionId);
      const sessionId = explicitSid || getSessionId(resolveCallCwd(argCwd, resolveWs().cwd));
      if (reset) {
        store.purge({ scope: "session", sessionId });
      }

      const s = store.getStats(sessionId);
      const ghost = store.getGhostStats(sessionId);
      const featureRoi = store.getFeatureRoi(sessionId);
      const bd = s.breakdown || {};
      const reportLines = [
        "────────────────────────────────────────────────────────────────────────────────",
        ` agy-dart context stats [session: ${sessionId}]`,
        "────────────────────────────────────────────────────────────────────────────────",
        `  Total Operations:      ${s.calls} (exec:${bd.executions || 0}, idx:${bd.indexes || 0}, fast:${bd.fastTools || 0}, cli-filter:${bd.cliFilters || 0}, dedup:${bd.dedups || 0}, blocked:${bd.interceptions || 0})`,
        `  Raw Data Handled:      ${formatBytes(s.totalRawBytes)}`,
        `  Data Fed into LLM:     ${formatBytes(s.totalReturnedBytes)}`,
        `  Tokens Kept Out:       ~${s.tokensKeptOut.toLocaleString()} tokens (${formatBytes(s.keptOutBytes)})`,
        `  Reduction Rate:        ${s.savingsPercent}% saved`
      ];
      if (ghost.totalBlocked > 0) {
        reportLines.push(
          `  Ghost Efficiency:      ${Math.round(ghost.evictionEfficiency * 100)}% (ghost recalls: ${ghost.ghostRecalls}/${ghost.totalBlocked})`
        );
      }
      reportLines.push(
        "",
        `  Without agy-dart       ${renderBar(1.0)}  ${formatBytes(s.totalRawBytes)}`,
        `  With agy-dart          ${renderBar(s.totalRawBytes > 0 ? s.totalReturnedBytes / s.totalRawBytes : 0)}  ${formatBytes(s.totalReturnedBytes)}`,
        "────────────────────────────────────────────────────────────────────────────────"
      );
      const report = reportLines.join("\n");

      return {
        stats: s,
        ghost,
        featureRoi,
        report
      };
    },

    // 7. ctx_doctor
    async ctx_doctor({ cwd: argCwd = "" } = {}) {
      const ws = resolveWs();
      const cwd = resolveCallCwd(argCwd, ws.cwd);
      const doc = store.doctor();
      const cfgSnap = getConfigSnapshot();
      let projectFilters = { exists: false, error: null, loadedCount: 0, rejectedCount: 0, rejected: [] };
      try {
        const { inspectProjectFilterRules } = await import("../../hooks/filter-rules.mjs");
        const diag = inspectProjectFilterRules(cwd);
        projectFilters = {
          path: diag.path,
          exists: diag.exists,
          error: diag.error,
          loadedCount: diag.loadedCount,
          rejectedCount: diag.rejectedCount,
          rejected: diag.rejected
        };
      } catch {}
      const sessionId = getSessionId(cwd, { optional: true });
      const cutoffInfo = store.getCutoffInfo(sessionId);
      let safetyReport = null;
      let formatSafetyCompactFn = null;
      let safetyMonitor = { status: "not_detected", severity: "none" };
      try {
        const safetyMod = await import("./safety-monitor-audit.js");
        formatSafetyCompactFn = safetyMod.formatSafetyAuditCompactForDoctor;
        const tmpRoot = path.resolve(os.tmpdir()).toLowerCase();
        const dbPathNorm = typeof store?.dbPath === "string" && store.dbPath ? path.resolve(store.dbPath).toLowerCase() : "";
        const isEphemeralTestStore = Boolean(dbPathNorm && dbPathNorm.startsWith(tmpRoot));
        const hasExplicitSafetyPaths =
          Array.isArray(cfgSnap.values.safetyLogPaths) && cfgSnap.values.safetyLogPaths.length > 0;
        const hasExplicitStatePath = Boolean(cfgSnap.values.safetyStatePath);
        safetyReport = safetyMod.auditSafetyMonitor({
          persistState: hasExplicitStatePath || !isEphemeralTestStore,
          disableDefaultDiscovery: isEphemeralTestStore && !hasExplicitSafetyPaths && !process.env.AGY_DART_SAFETY_LOG_PATHS
        });
        safetyMonitor = safetyMod.formatSafetyAuditCompactForDoctor(safetyReport);
      } catch {}
      const out = {
        doctor: doc,
        features: {
          cliFilterEnabled: store.isCliFilterEnabled(sessionId),
          readDedupEnabled: store.isReadDedupEnabled(sessionId),
          diffReadEnabled: cfgSnap.values.diffRead,
          headingAwareMarkdownChunking: true,
          secretRedactionEnabled: isSecretRedactionEnabled(),
          sensitiveFileGuardMode: getSensitiveFileGuardMode(),
          readGuardMode: cfgSnap.values.readGuardMode,
          safetyAuditEnabled: cfgSnap.values.safetyAudit !== false
        },
        readGuard: {
          mode: cfgSnap.values.readGuardMode,
          modeSource: cfgSnap.sources.readGuardMode,
          sourceCutoffBytes: cutoffInfo.cutoffBytes,
          sourceCutoffSource: cutoffInfo.source,
          noiseMaxReadBytes: cfgSnap.values.noiseMaxReadBytes,
          reviewMaxReadBytes: cfgSnap.values.reviewMaxReadBytes,
          shellDumpMaxBytes: cfgSnap.values.shellDumpMaxBytes,
          exemptPathsCount: Array.isArray(cfgSnap.values.exemptPaths) ? cfgSnap.values.exemptPaths.length : 0,
          exemptExtensionsCount: Array.isArray(cfgSnap.values.exemptExtensions) ? cfgSnap.values.exemptExtensions.length : 0
        },
        readDedup: {
          enabled: store.isReadDedupEnabled(sessionId),
          minBytes: cfgSnap.values.readDedupMinBytes,
          maxSteps: cfgSnap.values.readDedupMaxSteps,
          maxTurns: cfgSnap.values.readDedupMaxTurns
        },
        safetyMonitor,
        config: {
          path: cfgSnap.configPath,
          loaded: cfgSnap.fileExists && !cfgSnap.configError,
          error: cfgSnap.configError,
          overrides: Object.fromEntries(
            Object.entries(cfgSnap.sources)
              .filter(([, src]) => src !== "default")
              .map(([k, src]) => [k, { value: cfgSnap.values[k], source: src }])
          )
        },
        projectFilters,
        runtimes: {
          node: process.version,
          platform: process.platform,
          arch: process.arch
        }
      };

      // Hard invariant: keep serialized ctx_doctor JSON (even with MCP envelope) strictly <= 8.8 KB
      const maxDoctorBytes = Math.min(MAX_MCP_JSON_BYTES, 8400);
      if (Buffer.byteLength(JSON.stringify(out, null, 2), "utf8") > maxDoctorBytes) {
        const trimmedRejected = Array.isArray(out.projectFilters.rejected)
          ? out.projectFilters.rejected.slice()
          : [];
        while (
          trimmedRejected.length > 0 &&
          Buffer.byteLength(
            JSON.stringify({ ...out, projectFilters: { ...out.projectFilters, rejected: trimmedRejected, rejectedTruncated: true } }, null, 2),
            "utf8"
          ) > maxDoctorBytes
        ) {
          trimmedRejected.pop();
        }
        out.projectFilters = {
          ...out.projectFilters,
          rejected: trimmedRejected,
          rejectedTruncated: true
        };
      }
      if (Buffer.byteLength(JSON.stringify(out, null, 2), "utf8") > maxDoctorBytes && safetyReport && formatSafetyCompactFn) {
        out.safetyMonitor = formatSafetyCompactFn(safetyReport, { minimal: true });
      }
      return out;
    },

    // 8. ctx_purge
    async ctx_purge({
      scope = "session",
      olderThanDays = 14,
      vacuum = false,
      sessionId: argSessionId = null,
      cwd: argCwd = ""
    } = {}) {
      const explicitSid = normalizeSessionId(argSessionId);
      const ws = resolveWs();
      const cwd = resolveCallCwd(argCwd, ws.cwd, {
        requireConfirmedWorkspace: scope === "worktree",
        workspaceConfirmed: ws.confirmed
      });
      const sessionId = scope === "session" || scope === "conversation" ? explicitSid || getSessionId(cwd) : null;
      return store.purge({ scope, sessionId, worktree: cwd, olderThanDays, vacuum });
    }
  };
}
