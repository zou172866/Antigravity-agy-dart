import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { getConfigSnapshot } from "./config.js";
import { executeCode, runProcess, OUTPUT_CAP } from "./executor.js";
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
 * Guarantee that JSON.stringify(obj, null, 2) stays strictly <= maxJsonBytes UTF-8 bytes
 * even after JSON escaping (e.g. thousands of \n -> \\n or quotes) expands string fields.
 */
export function capSerializedJsonField(obj, fieldName, rawBody, suffix = "", maxJsonBytes = MAX_MCP_JSON_BYTES) {
  obj[fieldName] = `${rawBody}${suffix}`;
  const measure = () => Buffer.byteLength(JSON.stringify(obj, null, 2), "utf8");
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
      lookupFn: opts.lookupFn
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
  getSessionId = () => "default",
  getDirectConversationId = null
}) {
  return {
    // 1. ctx_execute
    async ctx_execute({ language = "shell", code = "", file = "", args = [], intent = "" } = {}) {
      const startTime = Date.now();
      const cwd = getCwd();
      const sessionId = getSessionId();

      const result = await executeCode({
        language,
        code,
        file,
        args,
        cwd
      });

      const elapsedMs = Date.now() - startTime;
      const rawCombined = (result.stdout ? result.stdout : "") + (result.stderr ? "\n" + result.stderr : "");
      const redacted = redactSecrets(rawCombined);
      const fullOutput = redacted.text;
      const fullBytes = Buffer.byteLength(fullOutput, "utf8");

      let sourceId = null;
      let deduplicated = false;
      if (fullBytes > 0) {
        const indexed = store.indexContent({
          sessionId,
          worktree: cwd,
          agent: "antigravity",
          kind: "execution",
          label: intent || `${language} script (${elapsedMs}ms)`,
          content: fullOutput,
          dedup: true
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
              ok: result.ok,
              exitCode: result.exitCode,
              elapsedMs,
              language,
              intent: intent || null,
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
        ok: result.ok,
        exitCode: result.exitCode,
        elapsedMs,
        language,
        intent: intent || null,
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
        key: language,
        path: file || null,
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
    async ctx_batch({ commands = [], queries = [] } = {}) {
      const cwd = getCwd();
      const sessionId = getSessionId();
      const cmdList = Array.isArray(commands) ? commands : [commands];
      const outputs = [];
      let totalRawBytes = 0;

      for (const cmd of cmdList) {
        if (!cmd) continue;
        const res = await executeCode({ language: "shell", code: cmd, cwd });
        const text = `=== Command: ${cmd} (exit: ${res.exitCode}) ===\n${res.stdout || ""}${res.stderr ? "\n[stderr]\n" + res.stderr : ""}\n`;
        totalRawBytes += Buffer.byteLength(text, "utf8");
        outputs.push(text);
      }

      const redactedBatch = redactSecrets(outputs.join("\n"));
      const combined = redactedBatch.text;
      totalRawBytes = Buffer.byteLength(combined, "utf8");
      const indexed = store.indexContent({
        sessionId,
        worktree: cwd,
        agent: "antigravity",
        kind: "batch",
        label: `batch: ${cmdList.length} commands`,
        content: combined,
        dedup: true
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
        ok: 1,
        bytes: totalRawBytes,
        body: returnedContent,
        sandboxBytes: totalRawBytes,
        returnedBytes
      });

      return batchResp;
    },

    // 3. ctx_index
    async ctx_index({ path: filePath = "", url = "", content = "", label = "" } = {}) {
      const cwd = getCwd();
      const sessionId = getSessionId();
      let rawText = content || "";
      let resolvedLabel = label;
      let sensitiveFileWarning = null;

      let safeUrlForMeta = "";
      if (url) {
        safeUrlForMeta = sanitizeUrlForDisplay(url);
        resolvedLabel = resolvedLabel || safeUrlForMeta;
        rawText = await fetchUrlText(url);
      } else if (filePath) {
        resolvedLabel = resolvedLabel || filePath;
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
        if (!fs.existsSync(absPath)) {
          throw new Error(`File not found: ${filePath}`);
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

      const indexed = store.indexContent({
        sessionId,
        worktree: cwd,
        agent: "antigravity",
        kind: url ? "web" : filePath ? "file" : "text",
        label: resolvedLabel || "manual_index",
        content: safeText,
        dedup: true
      });

      const deduplicated = Boolean(indexed.deduplicated);
      const returnObj = {
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
    async ctx_search({ queries = [], sourceId = null, scope = "session", limit = 5, offset = 0 } = {}) {
      const cwd = getCwd();
      const sessionId = getSessionId();

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
    async ctx_resume({ seq = null, sessionId: argSessionId = null } = {}) {
      const explicitSid =
        typeof argSessionId === "string" && argSessionId.trim() && argSessionId.trim().length <= 128 && !/[\x00-\x1f\x7f\\/]/.test(argSessionId.trim())
          ? argSessionId.trim()
          : null;
      const sessionId = explicitSid || getSessionId();
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
        sessionId === "default" &&
        isCheckpointEmpty &&
        typeof store.hasNonDefaultCheckpoints === "function" &&
        store.hasNonDefaultCheckpoints()
      ) {
        resumePayload.hint =
          "Shared MCP server resolved sessionId='default' (no host conversationId env). Pass sessionId: '<your Conversation ID>' to recover this conversation's PostToolUse checkpoint & isolated stats.";
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
          if (typeof item.summary === "string") item.summary = truncateUtf8(item.summary, 180);
          if (typeof item.command === "string") item.command = truncateUtf8(item.command, 120);
        }
      }
      if (jsonBytes() > MAX_RESUME_JSON_BYTES && resumePayload.sessionCheckpoint) {
        for (const k of ["lastTest", "lastBuild"]) {
          const item = resumePayload.sessionCheckpoint[k];
          if (!item) continue;
          if (typeof item.summary === "string") item.summary = truncateUtf8(item.summary, 64);
          if (typeof item.command === "string") item.command = truncateUtf8(item.command, 64);
        }
      }

      return resumePayload;
    },

    // 6. ctx_stats
    async ctx_stats({ reset = false, sessionId: argSessionId = null } = {}) {
      const explicitSid =
        typeof argSessionId === "string" && argSessionId.trim() && argSessionId.trim().length <= 128 && !/[\x00-\x1f\x7f\\/]/.test(argSessionId.trim())
          ? argSessionId.trim()
          : null;
      const sessionId = explicitSid || getSessionId();
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
        `  Total Operations:      ${s.calls} (exec:${bd.executions || 0}, idx:${bd.indexes || 0}, cli-filter:${bd.cliFilters || 0}, dedup:${bd.dedups || 0}, blocked:${bd.interceptions || 0})`,
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
    async ctx_doctor() {
      const doc = store.doctor();
      const cfgSnap = getConfigSnapshot();
      let projectFilters = { exists: false, error: null, loadedCount: 0, rejectedCount: 0, rejected: [] };
      try {
        const { inspectProjectFilterRules } = await import("../../hooks/filter-rules.mjs");
        const diag = inspectProjectFilterRules(getCwd());
        projectFilters = {
          path: diag.path,
          exists: diag.exists,
          error: diag.error,
          loadedCount: diag.loadedCount,
          rejectedCount: diag.rejectedCount,
          rejected: diag.rejected
        };
      } catch {}
      const out = {
        doctor: doc,
        features: {
          cliFilterEnabled: store.isCliFilterEnabled(getSessionId()),
          readDedupEnabled: store.isReadDedupEnabled(getSessionId()),
          diffReadEnabled: cfgSnap.values.diffRead,
          headingAwareMarkdownChunking: true,
          secretRedactionEnabled: isSecretRedactionEnabled(),
          sensitiveFileGuardMode: getSensitiveFileGuardMode()
        },
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
      return out;
    },

    // 8. ctx_purge
    async ctx_purge({ scope = "session", olderThanDays = 14, vacuum = false, sessionId: argSessionId = null } = {}) {
      const explicitSid =
        typeof argSessionId === "string" && argSessionId.trim() && argSessionId.trim().length <= 128 && !/[\x00-\x1f\x7f\\/]/.test(argSessionId.trim())
          ? argSessionId.trim()
          : null;
      const sessionId = explicitSid || getSessionId();
      const cwd = getCwd();
      return store.purge({ scope, sessionId, worktree: cwd, olderThanDays, vacuum });
    }
  };
}
