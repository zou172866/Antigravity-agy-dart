import { createHash } from "node:crypto";

function compareAsciiKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively rebuild plain objects with lexicographically sorted keys while preserving array order.
 */
export function stableSortObject(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((item) => stableSortObject(item, seen));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  seen.add(value);
  const sorted = {};
  for (const key of Object.keys(value).sort(compareAsciiKeys)) {
    Object.defineProperty(sorted, key, {
      value: stableSortObject(value[key], seen),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  seen.delete(value);
  return sorted;
}

/** Deterministic JSON serialization with recursively sorted object keys */
export function stableStringify(value, space) {
  return JSON.stringify(stableSortObject(value), null, space);
}

/** Compute lowercase hex SHA-256 digest of a UTF-8 string */
export function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}
