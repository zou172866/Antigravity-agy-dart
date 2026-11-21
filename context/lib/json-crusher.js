/**
 * Zero-dependency reversible JSON / JSONL structural crusher for agy-dart.
 * Clean-room ESM implementation inspired by headroomlabs-ai/headroom SmartCrusher patterns.
 *
 * Preserves schema summaries, head/tail samples, and error/status/anomaly items
 * with original indices while strictly honoring UTF-8 byte budgets (CJK-safe).
 */

const MAX_PARSE_CHARS = 20 * 1024 * 1024; // 20 MB defensive guard
const MIN_JSONL_LINES = 5;

const ERROR_KEY_RE =
  /^(?:err|error|errors|exception|fatal|fail|failed|failure|failures|err_?msg|error_?msg|error_?message|error_?code|stack|traceback)$/i;
const STATUS_KEY_RE = /^(?:status|status_?code|http_?status|http_?code)$/i;
const OK_BOOL_KEY_RE = /^(?:ok|success|passed|healthy|valid)$/i;
const LEVEL_KEY_RE = /^(?:level|severity|status|state|result|outcome|kind|type|log_?level)$/i;
const LEVEL_BAD_VAL_RE =
  /^(?:err|error|fail|failed|failure|exception|fatal|critical|crit|panic|crash|crashed|unhealthy|timeout|timed_out|aborted|rejected)$/i;
const ERROR_VAL_RE = /\b(?:error|err|fail|failed|exception|fatal)\b/i;
const BENIGN_ERR_RE =
  /\b(?:no|zero|0|without)\s+(?:err|error|errors|fail|failed|failures|exceptions?)\b|\berror[-_ ]?free\b/i;

function utf8Bytes(str) {
  return Buffer.byteLength(str, "utf8");
}

/** Truncate string strictly to <= maxBytes UTF-8 bytes without splitting multi-byte chars or surrogates */
function truncateUtf8Safe(text, maxBytes) {
  if (!text || maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  sliced = sliced.replace(/\uFFFD+$/, "");
  if (sliced.length > 0) {
    const last = sliced.charCodeAt(sliced.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      sliced = sliced.slice(0, -1);
    }
  }
  return sliced;
}

function valueType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse a JSON document (object/array) or JSONL/NDJSON stream (>= 5 valid JSON object lines).
 * Returns null if input is not valid JSON/JSONL.
 */
function parseJsonInput(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_PARSE_CHARS) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;

  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null;
  const last = trimmed[trimmed.length - 1];

  // 1. Standard JSON object or array
  if ((first === "{" && last === "}") || (first === "[" && last === "]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        return {
          format: "json",
          data: parsed,
          isArray: Array.isArray(parsed),
          invalidLines: 0
        };
      }
    } catch {
      // Might be JSONL where first line starts with '{' and last line ends with '}'
    }
  }

  // 2. JSONL / NDJSON (>= 5 valid JSON object lines, >= 90% valid)
  if (first === "{") {
    const rawLines = trimmed.split(/\r?\n/);
    const nonEmpty = [];
    for (let i = 0; i < rawLines.length; i++) {
      const l = rawLines[i].trim();
      if (l.length > 0) nonEmpty.push(l);
    }
    if (nonEmpty.length < MIN_JSONL_LINES) return null;

    // Fast reject if first non-empty line is not a JSON object candidate
    const firstLine = nonEmpty[0];
    if (!firstLine.startsWith("{") || !firstLine.endsWith("}")) return null;

    const objects = [];
    let invalidLines = 0;
    const maxAllowedInvalid = Math.floor(nonEmpty.length * 0.1);

    for (let i = 0; i < nonEmpty.length; i++) {
      const line = nonEmpty[i];
      if (!line.startsWith("{") || !line.endsWith("}")) {
        invalidLines += 1;
        if (invalidLines > maxAllowedInvalid) return null;
        continue;
      }
      try {
        const obj = JSON.parse(line);
        if (isPlainObject(obj)) {
          objects.push(obj);
        } else {
          invalidLines += 1;
          if (invalidLines > maxAllowedInvalid) return null;
        }
      } catch {
        invalidLines += 1;
        if (invalidLines > maxAllowedInvalid) return null;
      }
    }

    if (objects.length >= MIN_JSONL_LINES && objects.length / nonEmpty.length >= 0.9) {
      return {
        format: "jsonl",
        data: objects,
        isArray: true,
        invalidLines
      };
    }
  }

  return null;
}

/**
 * Fast predicate checking whether text is a valid JSON object/array or JSONL (>= 5 JSON object lines).
 */
export function isJsonLike(text) {
  return parseJsonInput(text) !== null;
}

function isNonEmptyErrorValue(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return false;
    if (/^(?:none|null|ok|false|0|n\/a)$/i.test(t)) return false;
    if (BENIGN_ERR_RE.test(t)) return false;
    return true;
  }
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/**
 * Inspect an array item (up to depth 3) for errors, failures, status >= 400, ok: false,
 * or unexpected nulls in mostly non-nullable fields.
 */
function scoreItemAnomaly(item, nonNullableKeys) {
  const reasons = [];
  let score = 0;

  function visit(val, depth) {
    if (val === null || val === undefined) return;
    if (typeof val === "string") {
      if (depth === 0 && val.length <= 4000 && ERROR_VAL_RE.test(val) && !BENIGN_ERR_RE.test(val)) {
        reasons.push("error_text");
        score += 6;
      }
      return;
    }
    if (Array.isArray(val)) {
      if (depth >= 3) return;
      const limit = Math.min(val.length, 15);
      for (let i = 0; i < limit; i++) {
        visit(val[i], depth + 1);
      }
      return;
    }
    if (typeof val !== "object") return;

    const keys = Object.keys(val);
    const limit = Math.min(keys.length, 60);
    for (let i = 0; i < limit; i++) {
      const k = keys[i];
      const v = val[k];

      if (depth === 0 && v === null && nonNullableKeys && nonNullableKeys.has(k)) {
        reasons.push(`unexpected_null(${k})`);
        score += 5;
        continue;
      }

      if (STATUS_KEY_RE.test(k)) {
        const num =
          typeof v === "number"
            ? v
            : typeof v === "string" && /^\d{3}$/.test(v.trim())
              ? Number(v.trim())
              : Number.NaN;
        if (Number.isFinite(num) && num >= 400) {
          reasons.push(`${k}=${num}`);
          score += 10;
        }
      } else if (k === "code" || k === "errCode" || k === "error_code") {
        if (typeof v === "number" && Number.isFinite(v) && v >= 400 && v < 600) {
          reasons.push(`${k}=${v}`);
          score += 8;
        } else if (typeof v === "string" && /^(?:ERR_|E[A-Z]{3,}|FAIL|FATAL)/i.test(v.trim())) {
          reasons.push(`${k}=${v.trim()}`);
          score += 8;
        }
      }

      if (OK_BOOL_KEY_RE.test(k) && v === false) {
        reasons.push(`${k}=false`);
        score += 10;
      }

      if (ERROR_KEY_RE.test(k) && isNonEmptyErrorValue(v)) {
        reasons.push(k);
        score += 10;
      }

      if (LEVEL_KEY_RE.test(k) && typeof v === "string" && LEVEL_BAD_VAL_RE.test(v.trim())) {
        reasons.push(`${k}=${v.trim()}`);
        score += 10;
      }

      if (typeof v === "string" && v.length <= 4000 && ERROR_VAL_RE.test(v) && !BENIGN_ERR_RE.test(v)) {
        if (!ERROR_KEY_RE.test(k) && !LEVEL_KEY_RE.test(k)) {
          reasons.push(`match(${k})`);
          score += 6;
        }
      }

      if (depth < 3 && v !== null && typeof v === "object") {
        visit(v, depth + 1);
      }
    }
  }

  visit(item, 0);
  if (score === 0) return null;
  const uniqueReasons = [];
  for (const r of reasons) {
    if (!uniqueReasons.includes(r)) uniqueReasons.push(r);
    if (uniqueReasons.length >= 4) break;
  }
  return { score, reason: uniqueReasons.join(", ") };
}

/**
 * Infer a compact schema summary across an array's items and identify mostly non-nullable fields.
 */
function analyzeArray(arr, maxSchemaKeys = 24) {
  const total = arr.length;
  const typeCounts = {};
  const fieldMap = new Map();
  let objectCount = 0;
  let extraKeyCount = 0;
  const MAX_TRACKED_KEYS = 80;

  // Scan up to 50k items directly; beyond that stride evenly to keep latency bounded
  const stride = total > 50000 ? Math.ceil(total / 50000) : 1;

  for (let i = 0; i < total; i += stride) {
    const item = arr[i];
    const t = valueType(item);
    typeCounts[t] = (typeCounts[t] || 0) + 1;

    if (t === "object") {
      objectCount += 1;
      const keys = Object.keys(item);
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        let info = fieldMap.get(k);
        if (!info) {
          if (fieldMap.size >= MAX_TRACKED_KEYS) {
            extraKeyCount += 1;
            continue;
          }
          info = { types: new Set(), present: 0, nulls: 0 };
          fieldMap.set(k, info);
        }
        info.present += 1;
        const vt = valueType(item[k]);
        info.types.add(vt);
        if (vt === "null") info.nulls += 1;
      }
    }
  }

  const nonNullableKeys = new Set();
  if (objectCount >= 5) {
    const maxRareNulls = Math.max(2, Math.floor(objectCount * 0.15));
    for (const [k, info] of fieldMap.entries()) {
      if (ERROR_KEY_RE.test(k)) continue;
      const nonNullCount = info.present - info.nulls;
      if (
        info.present / objectCount >= 0.8 &&
        nonNullCount / objectCount >= 0.8 &&
        info.nulls >= 1 &&
        info.nulls <= maxRareNulls
      ) {
        nonNullableKeys.add(k);
      }
    }
  }

  let schema;
  if (objectCount > 0) {
    const sortedFields = [...fieldMap.entries()].sort((a, b) => {
      if (b[1].present !== a[1].present) return b[1].present - a[1].present;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const shown = sortedFields.slice(0, maxSchemaKeys);
    schema = {};
    for (const [k, info] of shown) {
      const typeStr = [...info.types].sort().join("|");
      const missing = Math.max(0, objectCount - info.present);
      const notes = [];
      if (info.nulls > 0) notes.push(`null:${info.nulls}`);
      if (missing > 0) notes.push(`missing:${missing}`);
      const val = notes.length > 0 ? `${typeStr} (${notes.join(", ")})` : typeStr;
      if (k === "__proto__") {
        Object.defineProperty(schema, k, { value: val, enumerable: true, writable: true, configurable: true });
      } else {
        schema[k] = val;
      }
    }
    const omittedKeys = sortedFields.length - shown.length + extraKeyCount;
    if (omittedKeys > 0) {
      schema["..."] = `+${omittedKeys} more keys`;
    }
  } else {
    schema = { _elementTypes: typeCounts };
  }

  return { schema, nonNullableKeys, objectCount, typeCounts };
}

function findArrayAnomalies(arr, nonNullableKeys, headCount, tailCount, maxAnomalyItems) {
  if (maxAnomalyItems <= 0 || arr.length === 0) {
    return { totalAnomalies: 0, selected: [] };
  }
  const matches = [];
  const total = arr.length;
  for (let i = 0; i < total; i++) {
    const res = scoreItemAnomaly(arr[i], nonNullableKeys);
    if (res) {
      const isMiddle = i >= headCount && i < total - tailCount;
      matches.push({
        index: i,
        score: res.score + (isMiddle ? 1 : 0),
        reason: res.reason,
        item: arr[i]
      });
    }
  }
  if (matches.length === 0) {
    return { totalAnomalies: 0, selected: [] };
  }

  matches.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
  const selected = matches.slice(0, maxAnomalyItems).sort((a, b) => a.index - b.index);
  return { totalAnomalies: matches.length, selected };
}

function compactValue(val, opts, depth) {
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === "number" || t === "boolean") return val;

  if (t === "string") {
    const bytes = utf8Bytes(val);
    if (bytes > opts.maxStringBytes) {
      opts.stats.crushedStrings += 1;
      const suffix = `... [truncated, ${bytes}B]`;
      const keep = Math.max(16, opts.maxStringBytes - utf8Bytes(suffix));
      return `${truncateUtf8Safe(val, keep)}${suffix}`;
    }
    return val;
  }

  if (Array.isArray(val)) {
    if (depth >= opts.maxDepth) {
      opts.stats.crushedArrays += 1;
      return `[Array(${val.length})]`;
    }
    const needCrush =
      val.length > opts.nestedHead + opts.nestedTail + 2 ||
      (val.length > 0 && estimateQuickBytes(val, opts.nestedArrayByteThreshold + 1) > opts.nestedArrayByteThreshold);
    if (needCrush && val.length > 0) {
      opts.stats.crushedArrays += 1;
      return buildCrushedArrayNode(val, {
        ...opts,
        headItems: Math.min(opts.nestedHead, opts.headItems),
        tailItems: Math.min(opts.nestedTail, opts.tailItems),
        maxAnomalyItems: Math.min(opts.nestedAnomalies, opts.maxAnomalyItems),
        maxSchemaKeys: Math.min(opts.maxSchemaKeys, 16)
      }, depth + 1, false);
    }
    return val.map((el) => compactValue(el, opts, depth + 1));
  }

  if (t === "object") {
    const keys = Object.keys(val);
    if (depth >= opts.maxDepth) {
      opts.stats.crushedObjects += 1;
      const preview = keys.slice(0, 5).join(", ");
      return `[Object(${keys.length} keys${preview ? `: ${preview}${keys.length > 5 ? ", ..." : ""}` : ""})]`;
    }
    return compactObject(val, opts, depth);
  }

  return String(val);
}

/** Fast bounded byte-size estimator to avoid full JSON.stringify on massive nested subtrees */
function estimateQuickBytes(val, limit) {
  let acc = 0;
  function walk(v, d) {
    if (acc >= limit) return;
    if (v === null || v === undefined) {
      acc += 4;
      return;
    }
    const t = typeof v;
    if (t === "string") {
      acc += utf8Bytes(v) + 2;
      return;
    }
    if (t === "number" || t === "boolean") {
      acc += 6;
      return;
    }
    if (d > 4) {
      acc += 32;
      return;
    }
    if (Array.isArray(v)) {
      acc += 2;
      for (let i = 0; i < v.length && acc < limit; i++) {
        walk(v[i], d + 1);
        acc += 1;
      }
      return;
    }
    if (t === "object") {
      acc += 2;
      const ks = Object.keys(v);
      for (let i = 0; i < ks.length && acc < limit; i++) {
        acc += utf8Bytes(ks[i]) + 4;
        walk(v[ks[i]], d + 1);
      }
    }
  }
  walk(val, 0);
  return acc;
}

function setOwnSafeProp(obj, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  } else {
    obj[key] = value;
  }
}

function compactObject(obj, opts, depth) {
  const keys = Object.keys(obj);
  const maxKeys = depth === 0 ? opts.maxTopKeys : opts.maxObjKeys;
  const out = {};

  if (keys.length <= maxKeys) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      setOwnSafeProp(out, k, compactValue(obj[k], opts, depth + 1));
    }
    return out;
  }

  opts.stats.crushedObjects += 1;
  const headCount = Math.max(2, Math.floor(maxKeys * 0.5));
  const tailCount = Math.max(1, Math.min(2, maxKeys - headCount));
  const anomalySlots = Math.max(0, maxKeys - headCount - tailCount);

  const selected = new Set();
  for (let i = 0; i < Math.min(headCount, keys.length); i++) {
    selected.add(keys[i]);
  }

  // Prioritize keys whose names or values contain anomalies
  if (anomalySlots > 0) {
    let added = 0;
    for (let i = headCount; i < keys.length - tailCount && added < anomalySlots; i++) {
      const k = keys[i];
      const v = obj[k];
      const keyIsAnomaly =
        (ERROR_KEY_RE.test(k) && isNonEmptyErrorValue(v)) ||
        (OK_BOOL_KEY_RE.test(k) && v === false) ||
        scoreItemAnomaly(v, null) !== null;
      if (keyIsAnomaly) {
        selected.add(k);
        added += 1;
      }
    }
  }

  for (let i = Math.max(headCount, keys.length - tailCount); i < keys.length; i++) {
    selected.add(keys[i]);
  }

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (selected.has(k)) {
      setOwnSafeProp(out, k, compactValue(obj[k], opts, depth + 1));
    }
  }
  const omitted = keys.length - selected.size;
  if (omitted > 0) {
    out._omittedKeys = omitted;
  }
  return out;
}

function buildCrushedArrayNode(arr, opts, depth, isRoot) {
  const total = arr.length;
  const { schema, nonNullableKeys } = analyzeArray(arr, opts.maxSchemaKeys);

  const hCount = Math.min(opts.headItems, total);
  const tCount = Math.min(opts.tailItems, Math.max(0, total - hCount));

  const head = [];
  for (let i = 0; i < hCount; i++) {
    head.push(compactValue(arr[i], opts, depth + 1));
  }

  const tail = [];
  const tailStart = total - tCount;
  for (let i = tailStart; i < total; i++) {
    tail.push(compactValue(arr[i], opts, depth + 1));
  }

  const { totalAnomalies, selected } = findArrayAnomalies(
    arr,
    nonNullableKeys,
    hCount,
    tCount,
    opts.maxAnomalyItems
  );

  const anomalies = selected.map((a) => ({
    index: a.index,
    reason: a.reason,
    item: compactValue(a.item, opts, depth + 1)
  }));

  // Count distinct indices actually shown across head, tail, and anomalies
  const shownIndices = new Set();
  for (let i = 0; i < hCount; i++) shownIndices.add(i);
  for (let i = tailStart; i < total; i++) shownIndices.add(i);
  for (const a of selected) shownIndices.add(a.index);
  const omittedItems = Math.max(0, total - shownIndices.size);

  if (isRoot) {
    opts.stats.totalItems = total;
    opts.stats.keptHead = head.length;
    opts.stats.keptTail = tail.length;
    opts.stats.keptAnomalies += anomalies.length;
    opts.stats.totalAnomalies += totalAnomalies;
  } else {
    opts.stats.totalAnomalies += totalAnomalies;
    opts.stats.keptAnomalies += anomalies.length;
  }

  const node = isRoot
    ? {
        _crushed: true,
        format: opts.rootFormat,
        totalItems: total,
        rawBytes: opts.rawBytes,
        schema,
        head
      }
    : {
        _crushedArray: true,
        totalItems: total,
        schema,
        head
      };

  if (anomalies.length > 0) {
    node.anomalies = anomalies;
    if (totalAnomalies > anomalies.length) {
      node.anomaliesTotal = totalAnomalies;
    }
  }
  if (tail.length > 0) {
    node.tail = tail;
  }
  if (omittedItems > 0) {
    node.omittedItems = omittedItems;
  }
  if (isRoot && opts.invalidLines > 0) {
    node.skippedInvalidLines = opts.invalidLines;
  }
  if (isRoot && opts.hint) {
    node.hint = opts.hint;
  }
  return node;
}

function buildCrushedRoot(parsed, rawBytes, profile, hint) {
  const stats = {
    format: parsed.format === "jsonl" ? "jsonl" : parsed.isArray ? "json_array" : "json_object",
    crushedArrays: 0,
    crushedStrings: 0,
    crushedObjects: 0,
    keptAnomalies: 0,
    totalAnomalies: 0
  };

  const opts = {
    ...profile,
    rawBytes,
    rootFormat: stats.format,
    invalidLines: parsed.invalidLines || 0,
    hint,
    stats
  };

  let payload;
  if (parsed.isArray) {
    stats.crushedArrays += 1;
    payload = buildCrushedArrayNode(parsed.data, opts, 0, true);
  } else {
    const topKeys = Object.keys(parsed.data);
    stats.topLevelKeys = topKeys.length;
    const compacted = compactObject(parsed.data, opts, 0);
    const meta = {
      format: "json_object",
      rawBytes,
      topLevelKeys: topKeys.length,
      ...(hint ? { hint } : {})
    };
    payload = {
      ...compacted,
      _crushed: meta
    };
  }

  const text = profile.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  return { text, stats };
}

/**
 * Structurally crush large JSON or JSONL payloads into a strictly UTF-8 bounded
 * summary preserving schema, head/tail samples, and prioritized anomalies.
 */
export function smartCrushJson(
  text,
  {
    maxBytes = 7400,
    sourceId = null,
    headItems = 3,
    tailItems = 2,
    maxAnomalyItems = 5
  } = {}
) {
  const input = typeof text === "string" ? text : "";
  const rawBytes = utf8Bytes(input);
  const effectiveMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 7400;

  // Never inflate inputs that already fit within budget
  if (rawBytes <= effectiveMaxBytes) {
    const parsedSmall = parseJsonInput(input);
    return {
      crushed: false,
      format: parsedSmall ? parsedSmall.format : "text",
      text: input,
      rawBytes,
      crushedBytes: rawBytes,
      stats: {
        reason: "within_budget",
        savedBytes: 0,
        savingsPct: 0
      }
    };
  }

  const parsed = parseJsonInput(input);
  if (!parsed) {
    return {
      crushed: false,
      format: "text",
      text: input,
      rawBytes,
      crushedBytes: rawBytes,
      stats: {
        reason: "not_json",
        savedBytes: 0,
        savingsPct: 0
      }
    };
  }

  const safeHead = Math.max(0, Number.isFinite(headItems) ? Math.floor(headItems) : 3);
  const safeTail = Math.max(0, Number.isFinite(tailItems) ? Math.floor(tailItems) : 2);
  const safeAnom = Math.max(0, Number.isFinite(maxAnomalyItems) ? Math.floor(maxAnomalyItems) : 5);

  const hint = sourceId
    ? `Full raw ${parsed.format.toUpperCase()} (${rawBytes}B) indexed as ${sourceId}. Query via ctx_search(queries: [...], sourceId: "${sourceId}").`
    : null;

  const profiles = [
    {
      pretty: true,
      headItems: safeHead,
      tailItems: safeTail,
      maxAnomalyItems: safeAnom,
      nestedHead: Math.min(3, safeHead),
      nestedTail: Math.min(2, safeTail),
      nestedAnomalies: Math.min(4, safeAnom),
      nestedArrayByteThreshold: 900,
      maxStringBytes: 280,
      maxSchemaKeys: 24,
      maxTopKeys: 40,
      maxObjKeys: 24,
      maxDepth: 4
    },
    {
      pretty: true,
      headItems: safeHead,
      tailItems: safeTail,
      maxAnomalyItems: safeAnom,
      nestedHead: Math.min(2, safeHead),
      nestedTail: Math.min(1, safeTail),
      nestedAnomalies: Math.min(3, safeAnom),
      nestedArrayByteThreshold: 600,
      maxStringBytes: 160,
      maxSchemaKeys: 16,
      maxTopKeys: 28,
      maxObjKeys: 16,
      maxDepth: 3
    },
    {
      pretty: false,
      headItems: safeHead,
      tailItems: safeTail,
      maxAnomalyItems: safeAnom,
      nestedHead: Math.min(2, safeHead),
      nestedTail: Math.min(1, safeTail),
      nestedAnomalies: Math.min(3, safeAnom),
      nestedArrayByteThreshold: 500,
      maxStringBytes: 160,
      maxSchemaKeys: 16,
      maxTopKeys: 24,
      maxObjKeys: 14,
      maxDepth: 3
    },
    {
      pretty: false,
      headItems: Math.min(2, safeHead),
      tailItems: Math.min(1, safeTail),
      maxAnomalyItems: Math.min(3, safeAnom),
      nestedHead: 1,
      nestedTail: 1,
      nestedAnomalies: Math.min(2, safeAnom),
      nestedArrayByteThreshold: 320,
      maxStringBytes: 100,
      maxSchemaKeys: 12,
      maxTopKeys: 14,
      maxObjKeys: 10,
      maxDepth: 2
    },
    {
      pretty: false,
      headItems: Math.min(1, safeHead),
      tailItems: Math.min(1, safeTail),
      maxAnomalyItems: Math.min(2, safeAnom),
      nestedHead: 1,
      nestedTail: 0,
      nestedAnomalies: Math.min(1, safeAnom),
      nestedArrayByteThreshold: 200,
      maxStringBytes: 64,
      maxSchemaKeys: 8,
      maxTopKeys: 8,
      maxObjKeys: 6,
      maxDepth: 2
    },
    {
      pretty: false,
      headItems: Math.min(1, safeHead),
      tailItems: 0,
      maxAnomalyItems: Math.min(1, safeAnom),
      nestedHead: 1,
      nestedTail: 0,
      nestedAnomalies: 0,
      nestedArrayByteThreshold: 120,
      maxStringBytes: 40,
      maxSchemaKeys: 5,
      maxTopKeys: 5,
      maxObjKeys: 4,
      maxDepth: 1
    }
  ];

  let chosen = null;
  for (const profile of profiles) {
    const candidate = buildCrushedRoot(parsed, rawBytes, profile, hint);
    if (utf8Bytes(candidate.text) <= effectiveMaxBytes) {
      chosen = candidate;
      break;
    }
  }

  if (!chosen) {
    // Minimal valid JSON fallback for extremely tight maxBytes or adversarial giant CJK keys
    const minimalObj = {
      _crushed: true,
      format: parsed.format === "jsonl" ? "jsonl" : parsed.isArray ? "json_array" : "json_object",
      rawBytes,
      ...(parsed.isArray
        ? { totalItems: parsed.data.length }
        : { topLevelKeys: Object.keys(parsed.data).length }),
      ...(sourceId ? { sourceId } : {})
    };
    const fallbackCandidates = [
      JSON.stringify(minimalObj),
      JSON.stringify({ _crushed: true, rawBytes }),
      JSON.stringify({ _crushed: true }),
      "{}"
    ];
    let minimalText = fallbackCandidates.find((c) => utf8Bytes(c) <= effectiveMaxBytes);
    if (minimalText === undefined) {
      minimalText = effectiveMaxBytes >= 1 ? "0" : "";
    }
    chosen = {
      text: minimalText,
      stats: {
        format: minimalObj.format,
        ...(parsed.isArray
          ? { totalItems: parsed.data.length }
          : { topLevelKeys: Object.keys(parsed.data).length }),
        fallbackMinimal: true
      }
    };
  }

  const crushedBytes = utf8Bytes(chosen.text);
  const savedBytes = Math.max(0, rawBytes - crushedBytes);
  const savingsPct = rawBytes > 0 ? Number(((savedBytes / rawBytes) * 100).toFixed(1)) : 0;

  return {
    crushed: true,
    format: parsed.format,
    text: chosen.text,
    rawBytes,
    crushedBytes,
    stats: {
      ...chosen.stats,
      savedBytes,
      savingsPct
    }
  };
}
