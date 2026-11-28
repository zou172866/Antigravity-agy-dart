import { createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { getHeader } from "./http-helpers.mjs";

export class UpdateError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const unzip = promisify(gunzip);

/**
 * Verify a downloaded archive buffer against an expected hex SHA-256 digest.
 */
export function verifyArchiveSha256(buffer, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    throw new UpdateError("integrity");
  }
  const actual = createHash("sha256").update(buffer).digest();
  const expected = Buffer.from(expectedSha256.toLowerCase(), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new UpdateError("integrity");
  }
}

/**
 * Download a GitHub release archive with strict HTTPS host allowlist, manual redirect checks,
 * timeout, bounded byte size, and optional SHA-256 digest verification.
 */
export async function downloadArchive(
  startUrl,
  {
    fetchImpl = (...args) => fetch(...args),
    timeoutMs = 30_000,
    maxBytes = 16 * 1024 * 1024,
    expectedSha256 = ""
  } = {}
) {
  const signal = AbortSignal.timeout(timeoutMs);

  function approvedUrl(value, base) {
    if (typeof value !== "string" || !value.trim()) {
      throw new UpdateError("redirect");
    }
    let url = null;
    try {
      url = base ? new URL(value, base) : new URL(value);
    } catch {
      throw new UpdateError("redirect");
    }
    if (
      !url ||
      url.protocol !== "https:" ||
      !ALLOWED_HOSTS.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    ) {
      throw new UpdateError("redirect");
    }
    return url.href;
  }

  try {
    let url = approvedUrl(startUrl);
    for (let i = 0; i <= 4; i++) {
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": "agy-dart" }
      });
      if (res.url) {
        try {
          approvedUrl(res.url);
        } catch (error) {
          void res.body?.cancel?.().catch(() => {});
          throw error;
        }
      }
      if (REDIRECT_STATUSES.has(res.status)) {
        void res.body?.cancel?.().catch(() => {});
        url = approvedUrl(getHeader(res.headers, "location"), url);
        continue;
      }
      if (!res.ok) {
        void res.body?.cancel?.().catch(() => {});
        throw new UpdateError("download");
      }
      const declaredLength = Number(getHeader(res.headers, "content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        void res.body?.cancel?.().catch(() => {});
        throw new UpdateError("size");
      }
      if (!res.body) {
        if (typeof res.arrayBuffer === "function") {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength > maxBytes) throw new UpdateError("size");
          if (expectedSha256) verifyArchiveSha256(buf, expectedSha256);
          return buf;
        }
        throw new UpdateError("download");
      }

      const chunks = [];
      let size = 0;
      const reader = res.body.getReader();
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) {
            const buf = Buffer.concat(chunks, size);
            if (expectedSha256) verifyArchiveSha256(buf, expectedSha256);
            return buf;
          }
          size += value.byteLength;
          if (size > maxBytes) throw new UpdateError("size");
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        void reader.cancel?.().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    throw new UpdateError("redirect");
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(
      signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "download"
    );
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function textField(bytes) {
  const end = bytes.indexOf(0);
  try {
    return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
  } catch {
    throw new UpdateError("archive");
  }
}

function octal(bytes) {
  const value = bytes.toString("latin1").replace(/[\0 ]+$/g, "").trimStart();
  if (!/^[0-7]+$/.test(value)) throw new UpdateError("archive");
  return Number.parseInt(value, 8);
}

function safePath(rawPath) {
  const parts = rawPath.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\:*?"<>|\x00-\x1f\x7f]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)
    )
  ) {
    throw new UpdateError("archive");
  }
  return parts;
}

const ALLOWED_PAX_KEYS = new Set(["path", "mtime", "ctime", "atime", "size"]);

function parsePaxRecords(buf, maxBytes) {
  const result = {};
  let offset = 0;
  while (offset < buf.length) {
    const spaceIdx = buf.indexOf(0x20, offset);
    if (spaceIdx <= offset) throw new UpdateError("archive");
    const lenStr = buf.subarray(offset, spaceIdx).toString("latin1");
    if (!/^\d+$/.test(lenStr)) throw new UpdateError("archive");
    const recordLen = Number.parseInt(lenStr, 10);
    if (recordLen <= 0 || offset + recordLen > buf.length) throw new UpdateError("archive");
    const record = buf.subarray(spaceIdx + 1, offset + recordLen);
    if (record[record.length - 1] !== 0x0a) throw new UpdateError("archive");
    let line;
    try {
      line = utf8.decode(record.subarray(0, record.length - 1));
    } catch {
      throw new UpdateError("archive");
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) throw new UpdateError("archive");
    const key = line.slice(0, eqIdx);
    const val = line.slice(eqIdx + 1);
    if (
      !ALLOWED_PAX_KEYS.has(key) &&
      !key.startsWith("LIBARCHIVE.") &&
      !key.startsWith("SCHILY.")
    ) {
      throw new UpdateError("archive");
    }
    if (key === "path") {
      result.path = val;
    } else if (key === "size") {
      if (!/^\d+$/.test(val)) throw new UpdateError("archive");
      const parsedSize = Number(val);
      if (!Number.isSafeInteger(parsedSize) || parsedSize < 0 || parsedSize > maxBytes) {
        throw new UpdateError("archive");
      }
      result.size = parsedSize;
    }
    offset += recordLen;
  }
  return result;
}

/**
 * Pure-JS ustar (+ GitHub pax) .tar.gz reader with strict path/link/size validation.
 * Strips the top-level GitHub repository directory and returns Map<relPath, Buffer>.
 */
export async function readReleaseArchive(compressed, maxBytes = 48 * 1024 * 1024) {
  let tar;
  try {
    tar = await unzip(compressed, { maxOutputLength: maxBytes });
  } catch (error) {
    throw new UpdateError(error?.code === "ERR_BUFFER_TOO_LARGE" ? "size" : "archive");
  }

  const files = new Map();
  const seen = new Set();
  const block = 512;
  let archiveRoot;
  let nextPaxPath = null;
  let nextPaxSize = null;

  for (let pos = 0; pos + block <= tar.length; ) {
    const header = tar.subarray(pos, pos + block);
    if (header.every((byte) => byte === 0)) {
      if (
        nextPaxPath === null &&
        nextPaxSize === null &&
        tar.length - pos >= 2 * block &&
        tar.length % block === 0 &&
        tar.subarray(pos).every((b) => b === 0)
      ) {
        return files;
      }
      break;
    }
    const magic = header.toString("latin1", 257, 263);
    if ((magic !== "ustar\0" && magic !== "ustar ") || seen.size >= 4096) break;

    let checksum = 0;
    for (let i = 0; i < block; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(header.subarray(148, 156))) break;

    const type = header[156];
    const isPaxHeader = type === 103 || type === 120;
    const headerSize = octal(header.subarray(124, 136));
    const size = !isPaxHeader && nextPaxSize !== null ? nextPaxSize : headerSize;
    if (!isPaxHeader) nextPaxSize = null;
    if (size > maxBytes) throw new UpdateError("size");
    const start = pos + block;
    const end = start + Math.ceil(size / block) * block;
    if (end > tar.length) break;

    const contents = Buffer.from(tar.subarray(start, start + size));
    const isFirst = pos === 0;
    pos = end;

    // GitHub global pax comment header (40-hex SHA-1 or 64-hex SHA-256 commit comment)
    if (
      type === 103 &&
      isFirst &&
      size <= 256 &&
      /^(?:52 comment=[0-9a-f]{40}|76 comment=[0-9a-f]{64})\n$/.test(contents.toString("latin1"))
    ) {
      continue;
    }

    // Per-entry pax extended header (used for long paths > 255 bytes or large sizes)
    if (type === 120) {
      if (size > 16 * 1024) throw new UpdateError("archive");
      const pax = parsePaxRecords(contents, maxBytes);
      nextPaxPath = pax.path ?? null;
      nextPaxSize = pax.size ?? null;
      continue;
    }

    const isDirectory = type === 53;
    if ((!isDirectory && type !== 0 && type !== 48) || (isDirectory && size !== 0)) {
      throw new UpdateError("archive");
    }

    let rawPath;
    if (nextPaxPath !== null) {
      rawPath = nextPaxPath;
      nextPaxPath = null;
    } else {
      const prefix = textField(header.subarray(345, 500));
      const name = textField(header.subarray(0, 100));
      rawPath = prefix ? `${prefix}/${name}` : name;
    }

    const cleanedPath = isDirectory ? rawPath.replace(/\/$/, "") : rawPath;
    const parts = safePath(cleanedPath);
    archiveRoot ??= parts[0];
    if (parts[0] !== archiveRoot) throw new UpdateError("archive");

    const key = parts.join("/").normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new UpdateError("archive");
    seen.add(key);

    if (isDirectory || parts.length < 2) continue;
    const relative = parts.slice(1).join("/");
    files.set(relative, contents);
  }

  throw new UpdateError("archive");
}
