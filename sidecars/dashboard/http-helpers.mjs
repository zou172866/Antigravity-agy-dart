/**
 * Shared HTTP header helpers for sidecar dashboard update & version-check modules.
 */
export function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v == null ? null : String(v);
  }
  return null;
}
