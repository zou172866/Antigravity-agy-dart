/**
 * agy-dart Security Utilities (zero-dependency clean-room MIT implementation):
 *  1. SSRF URL / DNS / IPv4 & IPv6 private-range validator with DNS pinning
 *  2. Lightweight configurable credential & secret redaction before indexing/return
 *  3. Sensitive credential file path detector for optional PreToolUse / ctx_index reminders
 */
import dns from "node:dns";
import net from "node:net";
import path from "node:path";
import { getEffectiveConfig } from "./config.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.goog",
  "metadata"
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal"
];

/** Parse strict dotted-quad IPv4 string into 4 octets, or null */
export function parseIpv4ToBytes(ip) {
  if (typeof ip !== "string") return null;
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    if (parts[i].length > 1 && parts[i].startsWith("0")) return null;
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

function isPrivateOrReservedIpv4Bytes(b) {
  const [a, c, d] = [b[0], b[1], b[2]];
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && c >= 64 && c <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && c === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && c >= 16 && c <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && c === 0 && d === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && c === 0 && d === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && c === 88 && d === 99) return true; // 192.88.99.0/24 (6to4 relay)
  if (a === 192 && c === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (c === 18 || c === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && c === 51 && d === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && c === 0 && d === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved & broadcast
  return false;
}

/** Expand IPv6 string (handling ::, mixed dotted-quad, brackets, %zone) into 16 bytes, or null */
export function parseIpv6ToBytes(rawIp) {
  if (typeof rawIp !== "string") return null;
  let ip = rawIp.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  if (!ip.includes(":")) return null;

  // Handle embedded trailing IPv4 (e.g. ::ffff:127.0.0.1 or 64:ff9b::10.0.0.1)
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4ToBytes(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dblParts = ip.split("::");
  if (dblParts.length > 2) return null;

  const parseSide = (side) => {
    if (!side) return [];
    const segs = side.split(":");
    const nums = [];
    for (const seg of segs) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return null;
      nums.push(parseInt(seg, 16));
    }
    return nums;
  };

  let groups;
  if (dblParts.length === 2) {
    const left = parseSide(dblParts[0]);
    const right = parseSide(dblParts[1]);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    const all = parseSide(dblParts[0]);
    if (!all || all.length !== 8) return null;
    groups = all;
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i] >> 8) & 0xff;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

/**
 * Returns true if an IPv4 or IPv6 address is private, loopback, link-local,
 * multicast, reserved, cloud-metadata, or invalid (fail-closed).
 */
export function isPrivateOrReservedIp(rawIp) {
  if (typeof rawIp !== "string" || !rawIp.trim()) return true;
  let cleaned = rawIp.trim();
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    cleaned = cleaned.slice(1, -1);
  }
  const zoneIdx = cleaned.indexOf("%");
  if (zoneIdx !== -1) cleaned = cleaned.slice(0, zoneIdx);

  const v4 = parseIpv4ToBytes(cleaned);
  if (v4) return isPrivateOrReservedIpv4Bytes(v4);

  const v6 = parseIpv6ToBytes(cleaned);
  if (!v6) return true; // Fail closed on unparseable address

  // :: (unspecified) and ::1 (loopback)
  const first15Zero = v6.slice(0, 15).every((b) => b === 0);
  if (first15Zero && (v6[15] === 0 || v6[15] === 1)) return true;

  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    return isPrivateOrReservedIpv4Bytes(v6.subarray(12, 16));
  }

  // ::ffff:0:0:0/96 (RFC 2765 IPv4-translated IPv6)
  if (
    v6.slice(0, 8).every((b) => b === 0) &&
    v6[8] === 0xff &&
    v6[9] === 0xff &&
    v6[10] === 0x00 &&
    v6[11] === 0x00
  ) {
    return isPrivateOrReservedIpv4Bytes(v6.subarray(12, 16));
  }

  // ::/96 (deprecated IPv4-compatible IPv6)
  if (v6.slice(0, 12).every((b) => b === 0)) {
    return true;
  }

  // 64:ff9b::/96 (NAT64 well-known prefix — inspect embedded IPv4)
  if (
    v6[0] === 0x00 &&
    v6[1] === 0x64 &&
    v6[2] === 0xff &&
    v6[3] === 0x9b &&
    v6.slice(4, 12).every((b) => b === 0)
  ) {
    return isPrivateOrReservedIpv4Bytes(v6.subarray(12, 16));
  }

  // 64:ff9b:1::/48 (NAT64 local-use)
  if (
    v6[0] === 0x00 &&
    v6[1] === 0x64 &&
    v6[2] === 0xff &&
    v6[3] === 0x9b &&
    v6[4] === 0x00 &&
    v6[5] === 0x01
  ) {
    return true;
  }

  // 0000::/8 (IANA reserved, after checking ::ffff:, ::/96, and 64:ff9b:: above)
  if (v6[0] === 0x00) return true;

  // 2002::/16 (6to4 — inspect embedded IPv4 in bytes 2..5)
  if (v6[0] === 0x20 && v6[1] === 0x02) {
    if (isPrivateOrReservedIpv4Bytes(v6.subarray(2, 6))) return true;
  }

  // fc00::/7 (Unique Local Address)
  if ((v6[0] & 0xfe) === 0xfc) return true;
  // fe00::/8 (covers fe00::/9 reserved, fe80::/10 Link-Local, fec0::/10 deprecated Site-Local)
  if (v6[0] === 0xfe) return true;
  // ff00::/8 (Multicast)
  if (v6[0] === 0xff) return true;
  // 100::/64 (Discard-Only)
  if (v6[0] === 0x01 && v6[1] === 0x00 && v6.slice(2, 8).every((b) => b === 0)) return true;
  // 2001:0000::/32 (Teredo tunneling — classic SSRF vector)
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && v6[3] === 0x00) return true;
  // 2001:0002::/48 (Benchmarking)
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && v6[3] === 0x02 && v6[4] === 0x00 && v6[5] === 0x00) return true;
  // 2001:0010::/28 & 2001:0020::/28 (ORCHID / ORCHIDv2)
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && ((v6[3] & 0xf0) === 0x10 || (v6[3] & 0xf0) === 0x20)) return true;
  // 2001:db8::/32 (Documentation)
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) return true;

  return false;
}

export function isBlockedHostname(hostname) {
  if (!hostname || typeof hostname !== "string") return true;
  const h = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Validate a URL target against SSRF rules:
 *  - Only http: and https: protocols allowed
 *  - Blocks localhost / .local / .internal / metadata hostnames
 *  - Resolves all DNS A/AAAA records and rejects if ANY record is private/loopback/link-local
 *  - Returns a pinned { address, family } for DNS-rebinding-resistant socket connection
 */
export async function validateFetchTarget(urlStr, options = {}) {
  const allowPrivate =
    typeof options.allowPrivate === "boolean"
      ? options.allowPrivate
      : Boolean(getEffectiveConfig().allowPrivateUrls);
  const lookupFn = options.lookupFn || dns.promises.lookup;

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL protocol '${parsed.protocol}': only http: and https: are allowed`);
  }

  const rawHost = parsed.hostname || "";
  const bareHost = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (!bareHost) {
    throw new Error(`Invalid URL hostname: ${urlStr}`);
  }

  const ipFamily = net.isIP(bareHost);
  if (ipFamily === 4 || ipFamily === 6) {
    if (!allowPrivate && isPrivateOrReservedIp(bareHost)) {
      throw new Error(`Blocked SSRF target IP '${bareHost}' (private, loopback, or link-local range)`);
    }
    const pinned = { address: bareHost, family: ipFamily };
    return { parsed, pinned, pinnedRecords: [pinned] };
  }

  if (!allowPrivate && isBlockedHostname(bareHost)) {
    throw new Error(`Blocked SSRF target hostname '${bareHost}'`);
  }

  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : null;

  let records;
  try {
    const lookupPromise = Promise.resolve().then(() => lookupFn(bareHost, { all: true, verbatim: true }));
    // Swallow any late rejection if timeout wins the race so Node never emits unhandledRejection.
    lookupPromise.catch(() => {});
    let res;
    if (timeoutMs !== null) {
      let dnsTimer = null;
      try {
        res = await Promise.race([
          lookupPromise,
          new Promise((_, reject) => {
            dnsTimer = setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
            dnsTimer.unref?.();
          })
        ]);
      } finally {
        if (dnsTimer) clearTimeout(dnsTimer);
      }
    } else {
      res = await lookupPromise;
    }
    records = Array.isArray(res) ? res : res ? [res] : [];
  } catch (err) {
    if (err?.message === "Request timed out") {
      throw err;
    }
    throw new Error(`DNS lookup failed for '${bareHost}': ${err?.message || err}`);
  }

  if (records.length === 0) {
    throw new Error(`DNS lookup returned no addresses for '${bareHost}'`);
  }

  const pinnedRecords = [];
  for (const rec of records) {
    const addr = rec?.address;
    if (!addr || (!allowPrivate && isPrivateOrReservedIp(addr))) {
      throw new Error(
        `Blocked SSRF DNS resolution for '${bareHost}' -> '${addr || "unknown"}' (private, loopback, or link-local range)`
      );
    }
    pinnedRecords.push({
      address: addr,
      family: rec.family || net.isIP(addr) || 4
    });
  }

  return {
    parsed,
    pinned: pinnedRecords[0],
    pinnedRecords
  };
}

const SENSITIVE_QUERY_KEY_RE =
  /(?:^|[_-])(?:api[_-]?key|key|token|secret|pass(?:word)?|pwd|auth(?:orization)?|sig(?:nature)?|cred(?:ential)?s?|jwt|bearer|access[_-]?token|refresh[_-]?token|id[_-]?token|session(?:[_-]?id)?|cookie|private[_-]?key)$/i;

function isSensitiveQueryParamKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return false;
  const decamel = rawKey.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_QUERY_KEY_RE.test(rawKey) || SENSITIVE_QUERY_KEY_RE.test(decamel);
}

/** Strip embedded userinfo credentials and redact sensitive query params from a URL before logging/indexing */
export function sanitizeUrlForDisplay(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return "";
  try {
    const u = new URL(urlStr);
    let mutated = false;
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      mutated = true;
    }
    if (u.search) {
      const keys = [...new Set([...u.searchParams.keys()])];
      for (const key of keys) {
        const vals = u.searchParams.getAll(key);
        const keySensitive = isSensitiveQueryParamKey(key);
        let keyChanged = false;
        const nextVals = vals.map((v) => {
          if (keySensitive && v) {
            keyChanged = true;
            return "[REDACTED]";
          }
          if (v && redactSecrets(v, { force: true }).redactedCount > 0) {
            keyChanged = true;
            return "[REDACTED]";
          }
          return v;
        });
        if (keyChanged) {
          mutated = true;
          u.searchParams.delete(key);
          for (const nv of nextVals) {
            u.searchParams.append(key, nv);
          }
        }
      }
    }
    if (u.hash && u.hash.length > 1) {
      const hashBody = u.hash.slice(1);
      if (hashBody.includes("=")) {
        const parts = hashBody.split("&");
        let hashChanged = false;
        const nextParts = parts.map((seg) => {
          const eq = seg.indexOf("=");
          if (eq === -1) return seg;
          const qIdx = seg.lastIndexOf("?", eq);
          const routePrefix = qIdx !== -1 ? seg.slice(0, qIdx + 1) : "";
          const rawKey = qIdx !== -1 ? seg.slice(qIdx + 1, eq) : seg.slice(0, eq);
          let decodedKey = rawKey;
          try {
            decodedKey = decodeURIComponent(rawKey);
          } catch {}
          const v = seg.slice(eq + 1);
          if (v && (isSensitiveQueryParamKey(decodedKey) || redactSecrets(v, { force: true }).redactedCount > 0)) {
            hashChanged = true;
            return `${routePrefix}${rawKey}=[REDACTED]`;
          }
          return seg;
        });
        if (hashChanged) {
          u.hash = `#${nextParts.join("&")}`;
          mutated = true;
        }
      }
      const hashRedacted = redactSecrets(u.hash, { force: true });
      if (hashRedacted.redactedCount > 0) {
        u.hash = hashRedacted.text;
        mutated = true;
      }
    }
    const out = mutated ? u.toString() : urlStr;
    return redactSecrets(out, { force: true }).text;
  } catch {
    const stripped = urlStr.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1[REDACTED:URL_CREDS]@");
    return redactSecrets(stripped, { force: true }).text;
  }
}

/** Check whether secret redaction is active (enabled by default; disable via config/env) */
export function isSecretRedactionEnabled() {
  return getEffectiveConfig().secretRedaction !== false;
}

const PLACEHOLDER_VALUE_RE =
  /^(?:your[_-]|example|changeme|placeholder|dummy|fake[_-]|mock[_-]|sample[_-]|redacted|\[redacted|\$\{|\{\{|<[^>]+>|\*{4,}|x{6,}|0{8,}|123456)/i;

const CODE_EXPR_VALUE_RE =
  /^(?:process\.env\.|os\.environ|env\.|config\.|opts\.|options\.|args\.|this\.)/i;

const SECRET_PATTERNS = [
  {
    kind: "PRIVATE_KEY",
    re: /-----BEGIN (?:[A-Z0-9 ]{1,32} )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{1,16384}?-----END (?:[A-Z0-9 ]{1,32} )?PRIVATE KEY(?: BLOCK)?-----/g,
    replace: () => "[REDACTED:PRIVATE_KEY]"
  },
  {
    kind: "ANTHROPIC_KEY",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => "[REDACTED:ANTHROPIC_KEY]"
  },
  {
    kind: "OPENAI_KEY",
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: () => "[REDACTED:OPENAI_KEY]"
  },
  {
    kind: "STRIPE_KEY",
    re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
    replace: () => "[REDACTED:STRIPE_KEY]"
  },
  {
    kind: "GITHUB_TOKEN",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
    replace: () => "[REDACTED:GITHUB_TOKEN]"
  },
  {
    kind: "GOOGLE_API_KEY",
    re: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replace: () => "[REDACTED:GOOGLE_API_KEY]"
  },
  {
    kind: "AWS_ACCESS_KEY",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => "[REDACTED:AWS_ACCESS_KEY]"
  },
  {
    kind: "SLACK_TOKEN",
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    replace: () => "[REDACTED:SLACK_TOKEN]"
  },
  {
    kind: "HF_TOKEN",
    re: /\bhf_[A-Za-z0-9]{25,}\b/g,
    replace: () => "[REDACTED:HF_TOKEN]"
  },
  {
    kind: "NPM_TOKEN",
    re: /\bnpm_[A-Za-z0-9]{30,}\b/g,
    replace: () => "[REDACTED:NPM_TOKEN]"
  },
  {
    kind: "PYPI_TOKEN",
    re: /\bpypi-[A-Za-z0-9_-]{30,}\b/g,
    replace: () => "[REDACTED:PYPI_TOKEN]"
  },
  {
    kind: "BEARER_TOKEN",
    re: /(\bAuthorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/gi,
    replace: (_m, prefix, token) =>
      PLACEHOLDER_VALUE_RE.test(token) ? `${prefix}${token}` : `${prefix}[REDACTED:BEARER_TOKEN]`
  },
  {
    kind: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => "[REDACTED:JWT]"
  },
  {
    kind: "DB_URL_PASSWORD",
    re: /(\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]{1,64}:)([^@\s/]{4,})(@)/gi,
    replace: (_m, prefix, pass, suffix) =>
      PLACEHOLDER_VALUE_RE.test(pass) ? `${prefix}${pass}${suffix}` : `${prefix}[REDACTED:DB_PASS]${suffix}`
  },
  {
    kind: "ENV_SECRET",
    re: /((?:^|[\s,{])["']?(?:[A-Za-z][A-Za-z0-9_]{0,40}_)?(?:api_?key|secret_?key|access_?key|auth_?token|private_?key|client_?secret|db_?password|api_?secret|signing_?secret|access_?token|refresh_?token)["']?\s*[:=]\s*["']?)([^\s"'`,;}\r\n]{12,})(["']?)/gim,
    replace: (_m, prefix, val, suffix) => {
      if (
        PLACEHOLDER_VALUE_RE.test(val) ||
        CODE_EXPR_VALUE_RE.test(val) ||
        /[()]/.test(val) ||
        val.startsWith("[REDACTED:")
      ) {
        return `${prefix}${val}${suffix}`;
      }
      return `${prefix}[REDACTED:SECRET]${suffix}`;
    }
  }
];

/**
 * Redact common credential/secret patterns from text before indexing into SQLite or returning inline.
 * Returns { text, redactedCount, matchedKinds }.
 */
export function redactSecrets(text, options = {}) {
  if (!text || typeof text !== "string") {
    return { text: text || "", redactedCount: 0, matchedKinds: [] };
  }
  const enabled = options.force === true ? true : isSecretRedactionEnabled();
  if (!enabled) {
    return { text, redactedCount: 0, matchedKinds: [] };
  }

  let out = text;
  let redactedCount = 0;
  const matchedKinds = new Set();

  const patterns = Array.isArray(options.extraPatterns) && options.extraPatterns.length > 0
    ? [...SECRET_PATTERNS, ...options.extraPatterns]
    : SECRET_PATTERNS;

  for (const rule of patterns) {
    if (!rule || !(rule.re instanceof RegExp)) continue;
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`);
    out = out.replace(re, (...args) => {
      const original = args[0];
      const replaced = typeof rule.replace === "function" ? rule.replace(...args) : "[REDACTED:SECRET]";
      if (replaced !== original) {
        redactedCount += 1;
        matchedKinds.add(rule.kind || "CUSTOM_SECRET");
      }
      return replaced;
    });
  }

  return {
    text: out,
    redactedCount,
    matchedKinds: Array.from(matchedKinds)
  };
}

/** Optional sensitive-file guard mode for PreToolUse: "off" (default) | "warn" | "deny" */
export function getSensitiveFileGuardMode() {
  return getEffectiveConfig().sensitiveFileGuard || "off";
}

const SAFE_DOTENV_SUFFIXES = [".example", ".sample", ".template", ".schema", ".dist", ".defaults"];
const SAFE_DOTENV_STEM_RE = /(?:^|[._-])(?:example|sample|template|schema|dist|defaults)$/;

function detectSensitiveNormalizedPath(lower) {
  const base = path.posix.basename(lower);
  const ext = path.posix.extname(base);

  if (base === ".env" || base.startsWith(".env.")) {
    if (SAFE_DOTENV_SUFFIXES.some((s) => base.endsWith(s))) {
      return { sensitive: false, reason: null };
    }
    return { sensitive: true, reason: "dotenv secrets file" };
  }

  if (base === ".envrc") {
    return { sensitive: true, reason: "direnv secrets file (.envrc)" };
  }

  if (ext === ".env") {
    const stem = base.slice(0, -4);
    if (SAFE_DOTENV_STEM_RE.test(stem)) {
      return { sensitive: false, reason: null };
    }
    return { sensitive: true, reason: "dotenv secrets file" };
  }

  if (
    ext === ".pem" ||
    ext === ".key" ||
    ext === ".p12" ||
    ext === ".pfx" ||
    ext === ".jks" ||
    ext === ".keystore"
  ) {
    return { sensitive: true, reason: `private key / keystore (${ext})` };
  }

  if (/^id_(?:rsa|ed25519|ecdsa|dsa)$/.test(base) || (/(?:^|\/)\.ssh\/id_/.test(lower) && !base.endsWith(".pub"))) {
    return { sensitive: true, reason: "SSH private key" };
  }

  if (
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === ".netrc" ||
    base === "_netrc" ||
    base === ".git-credentials"
  ) {
    return { sensitive: true, reason: `credential config (${base})` };
  }

  if (
    /(?:^|\/)\.aws\/credentials$/.test(lower) ||
    /(?:^|\/)\.kube\/config$/.test(lower) ||
    base === "credentials.json" ||
    base === "application_default_credentials.json" ||
    /^service[-_]?account.*\.json$/.test(base) ||
    /^secrets?\.(?:ya?ml|json|toml)$/.test(base)
  ) {
    return { sensitive: true, reason: `cloud/service credential file (${base})` };
  }

  return { sensitive: false, reason: null };
}

/** Detect whether a file path likely contains raw credentials, private keys, or secrets */
export function detectSensitiveFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return { sensitive: false, reason: null };
  }
  let normalized = filePath.replace(/\\/g, "/");
  // Strip Windows extended-length / device path prefixes (`\\?\C:...`, `\\.\C:...`, `\\?\UNC\server\share`) first
  if (/^\/\/[?.]\/unc\//i.test(normalized)) {
    normalized = `//${normalized.slice(8)}`;
  } else if (/^\/\/[?.]\//.test(normalized)) {
    normalized = normalized.slice(4);
  }
  // Handle Windows drive prefix cleanly for both `C:/foo` and drive-relative `C:.env` / `C:.aws/credentials`
  let drivePrefix = "";
  if (/^[a-zA-Z]:/.test(normalized)) {
    drivePrefix = normalized.slice(0, 2).toLowerCase();
    normalized = normalized.slice(2);
  }

  // 1. Check raw (drive-stripped) lowercased path so POSIX filenames containing literal `:` (e.g. `prod:api.env`) are caught
  const rawLower = normalized.toLowerCase();
  const rawHit = detectSensitiveNormalizedPath(rawLower);
  if (rawHit.sensitive) return rawHit;

  // 2. Check Windows NTFS-normalized path (strip `:stream` ADS suffixes and trailing dots/spaces per segment)
  const cleanSegments = normalized.split("/").map((seg) => {
    let s = seg.toLowerCase();
    const colonIdx = s.indexOf(":");
    if (colonIdx > 0) {
      s = s.slice(0, colonIdx);
    }
    s = s.replace(/[. ]+$/, "");
    return s;
  });
  const ntfsLower = cleanSegments.join("/");
  if (ntfsLower !== rawLower) {
    const ntfsHit = detectSensitiveNormalizedPath(ntfsLower);
    if (ntfsHit.sensitive) return ntfsHit;
  }

  void drivePrefix;
  return { sensitive: false, reason: null };
}
