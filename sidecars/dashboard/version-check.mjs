import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHeader } from "./http-helpers.mjs";

export const REPO = "zou172866/Antigravity-agy-dart";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const VERSION_ROUTE = "/api/version";
const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

const MAX_UNSPECIFIED_RATE_LIMITS = 4;
const MANUAL_DEDUPE_MS = 5000;
const DEFAULT_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const digits = /^\d+$/;
const order = (a, b) => (a === b ? 0 : a > b ? 1 : -1);
const numericOrder = (a, b) => order(a.length, b.length) || order(a, b);

/**
 * Parse a SemVer 2.0 version string (with optional leading `v`).
 * Rejects leading-zero numeric pre-release identifiers.
 */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value.trim()
    );
  if (!match) return null;
  const pre = match[4] ? match[4].split(".") : [];
  if (pre.some((id) => /^0\d+$/.test(id))) return null;
  return {
    core: match.slice(1, 4),
    pre,
    version: match[0].replace(/^v/, "")
  };
}

/**
 * Compare two SemVer strings: returns -1, 0, 1, or null if either is invalid.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const cmp = numericOrder(left.core[i], right.core[i]);
    if (cmp) return cmp;
  }
  if (!left.pre.length || !right.pre.length) {
    return order(!left.pre.length, !right.pre.length);
  }
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    const xn = digits.test(x);
    const yn = digits.test(y);
    const cmp = xn && yn ? numericOrder(x, y) : xn !== yn ? order(yn, xn) : order(x, y);
    if (cmp) return cmp;
  }
  return order(left.pre.length, right.pre.length);
}

/**
 * Read normalized version from plugin.json or package.json under pluginRoot.
 */
export function readLocalVersion(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  for (const filename of ["plugin.json", "package.json"]) {
    try {
      const raw = readFileSync(path.join(pluginRoot, filename), "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      const normalized = parseVersion(parsed?.version)?.version;
      if (normalized) return normalized;
    } catch {
      // Try next manifest file
    }
  }
  return "";
}

function getRetryAt(headers, currentNow) {
  const readDeadline = (name, offset = 0) => {
    const seconds = getHeader(headers, name);
    if (!seconds || !/^\d+$/.test(seconds.trim())) return 0;
    const deadline = offset + Number(seconds.trim()) * 1000;
    return deadline > currentNow && Number.isFinite(new Date(deadline).getTime()) ? deadline : 0;
  };
  const retryAt = readDeadline("retry-after", currentNow);
  const resetAt = getHeader(headers, "x-ratelimit-remaining") === "0" ? readDeadline("x-ratelimit-reset") : 0;
  return Math.max(retryAt, resetAt) || null;
}

/**
 * Select the published release npm-pack .tgz asset when GitHub provides a valid SHA-256 digest.
 */
export function selectReleasePackageAsset(assets, version) {
  if (!Array.isArray(assets) || !version) return null;
  const expectedName = `agy-dart-${version}.tgz`;
  for (const asset of assets) {
    if (!asset || asset.name !== expectedName) continue;
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url.trim() : "";
    if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX)) continue;
    const digest = typeof asset.digest === "string" ? asset.digest.trim() : "";
    const match = /^sha256:([0-9a-f]{64})$/i.exec(digest);
    if (!match) continue;
    return {
      assetName: expectedName,
      assetUrl: url,
      assetSha256: match[1].toLowerCase()
    };
  }
  return null;
}

/**
 * Create a rate-limit-aware, single-flight GitHub Releases version checker.
 */
export function createVersionChecker({
  getCurrentVersion = () => readLocalVersion(),
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  successTtlMs = 6 * 60 * 60_000,
  failureTtlMs = 30 * 60_000,
  timeoutMs = 5000
} = {}) {
  let cached = null;
  let nextAutoAt = 0;
  let manualReuseUntil = 0;
  let inFlight = null;
  let unspecifiedRateLimits = 0;

  async function load(currentVersion) {
    const signal = AbortSignal.timeout(timeoutMs);
    const makeResult = (status, fields = {}) => ({
      ok: status !== "error",
      status,
      currentVersion,
      ...fields
    });
    const makeError = (reason, fields = {}) => makeResult("error", { reason, ...fields });

    try {
      const res = await fetchImpl(LATEST_RELEASE_API, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "agy-dart"
        },
        redirect: "error",
        signal
      });
      if (!res.ok) {
        if (
          res.status === 429 ||
          (res.status === 403 &&
            (getHeader(res.headers, "retry-after") ||
              getHeader(res.headers, "x-ratelimit-remaining") === "0" ||
              /\bsecondary rate limit\b/i.test((await res.json().catch(() => null))?.message || "")))
        ) {
          return makeError("rateLimit", { retryAt: getRetryAt(res.headers, now()) });
        }
        if (res.status === 404) return makeError("noRelease");
        return makeError("http", { httpStatus: res.status });
      }

      const data = await res.json();
      const latest = parseVersion(data?.tag_name);
      if (!latest || latest.pre.length > 0 || data?.draft || data?.prerelease) {
        return makeError("invalidRelease");
      }
      const releaseTag = data.tag_name.trim();
      const releaseUrl = `${RELEASES_URL}/tag/${encodeURIComponent(releaseTag)}`;
      const isNewer = compareVersions(latest.version, currentVersion) > 0;
      const pkgAsset = selectReleasePackageAsset(data?.assets, latest.version);
      if (isNewer) {
        return makeResult("update", {
          latestVersion: latest.version,
          releaseTag,
          releaseUrl,
          publishedAt: typeof data?.published_at === "string" ? data.published_at : "",
          ...(pkgAsset ? pkgAsset : {})
        });
      }
      return makeResult("current", {
        latestVersion: latest.version,
        releaseTag,
        releaseUrl
      });
    } catch (err) {
      const reason =
        signal.aborted || err?.name === "TimeoutError" || err?.name === "AbortError"
          ? "timeout"
          : err instanceof SyntaxError
            ? "invalidRelease"
            : "network";
      return makeError(reason);
    }
  }

  return async function check(mode = "manual", { fresh = false } = {}) {
    const currentVersion = String(getCurrentVersion?.() || "").trim();
    if (mode !== "manual" && mode !== "auto") {
      return { ok: false, status: "error", currentVersion, reason: "invalidMode" };
    }
    const automatic = mode === "auto";
    if (!parseVersion(currentVersion)) {
      return automatic
        ? { ok: true, status: "idle", currentVersion }
        : { ok: false, status: "error", currentVersion, reason: "localVersion" };
    }

    if (
      cached?.reason === "rateLimit" &&
      (now() < cached.retryAt || (automatic && unspecifiedRateLimits >= MAX_UNSPECIFIED_RATE_LIMITS))
    ) {
      return automatic ? { ok: true, status: "idle", currentVersion } : cached;
    }

    const dedupeManual = !automatic && !fresh;
    if (
      dedupeManual &&
      !inFlight &&
      cached &&
      cached.status !== "error" &&
      cached.currentVersion === currentVersion &&
      now() < manualReuseUntil
    ) {
      return cached;
    }

    const shouldFetch =
      !inFlight &&
      (!automatic || !cached || cached.currentVersion !== currentVersion || now() >= nextAutoAt);

    if (shouldFetch) {
      inFlight = load(currentVersion)
        .then((value) => {
          unspecifiedRateLimits =
            value.reason === "rateLimit" && value.retryAt === null
              ? Math.min(unspecifiedRateLimits + 1, MAX_UNSPECIFIED_RATE_LIMITS)
              : 0;
          let normalized = value;
          if (value.reason === "rateLimit") {
            const retryAt = value.retryAt ?? now() + 60_000 * 2 ** (unspecifiedRateLimits - 1);
            normalized = { ...value, retryAt };
          }
          cached = normalized;
          nextAutoAt =
            normalized.retryAt ?? now() + (normalized.status === "error" ? failureTtlMs : successTtlMs);
          return normalized;
        })
        .finally(() => {
          inFlight = null;
        });
    }

    const value = await (inFlight || cached);
    if (dedupeManual && value.status !== "error") {
      manualReuseUntil = now() + MANUAL_DEDUPE_MS;
    }
    if (automatic && value.status === "error") {
      return { ok: true, status: "idle", currentVersion };
    }
    return value;
  };
}
