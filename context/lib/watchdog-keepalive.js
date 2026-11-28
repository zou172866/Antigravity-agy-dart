/**
 * Pure KV-cache TTL timing & keepalive eligibility helpers extracted from
 * `context/lib/watchdog.js` for clean separation and reuse.
 */
export const MANUAL_KEEPALIVE_COOLDOWN_MS = 15_000;
export const KEEPALIVE_PENDING_ACK_WINDOW_MS = 60_000;
export const INELIGIBLE_KEEPALIVE_STOP_REASON_RE =
  /^(?:EXECUTOR_TERMINATION_REASON_)?(?:USER_CANCELED|USER_CANCELLED|CANCELED|CANCELLED|ABORTED|ERROR|watchdog_disabled|stale_|orphan_)/i;

export function resolveLeaseCacheOriginTs(lease, idleAnchorTs) {
  const safeAnchor =
    Number.isFinite(Number(idleAnchorTs)) && Number(idleAnchorTs) > 0
      ? Math.floor(Number(idleAnchorTs))
      : 0;
  const rawOrigin = Number(lease?.cacheOriginTs);
  if (
    Number.isFinite(rawOrigin) &&
    rawOrigin > 0 &&
    safeAnchor > 0 &&
    rawOrigin <= safeAnchor &&
    safeAnchor - rawOrigin <= 30 * 60 * 1000
  ) {
    return Math.floor(rawOrigin);
  }
  return safeAnchor;
}

export function computeLeaseTtlTiming(lease, { effectiveTtlSec, nowWallMs } = {}) {
  const safeNow = Number.isFinite(Number(nowWallMs)) ? Math.floor(Number(nowWallMs)) : Date.now();
  const safeTtl =
    Number.isFinite(Number(effectiveTtlSec)) && Number(effectiveTtlSec) > 0
      ? Math.floor(Number(effectiveTtlSec))
      : 0;
  const idleAnchorTs =
    (Number.isFinite(Number(lease?.idleAnchorTs)) && Number(lease.idleAnchorTs) > 0
      ? Math.floor(Number(lease.idleAnchorTs))
      : 0) ||
    (Number.isFinite(Number(lease?.phaseChangedTs)) && Number(lease.phaseChangedTs) > 0
      ? Math.floor(Number(lease.phaseChangedTs))
      : 0) ||
    (Number.isFinite(Number(lease?.updatedTs)) && Number(lease.updatedTs) > 0
      ? Math.floor(Number(lease.updatedTs))
      : 0) ||
    0;
  if (idleAnchorTs <= 0 || safeNow < idleAnchorTs || safeTtl <= 0) {
    return {
      valid: false,
      idleAnchorTs,
      originTs: 0,
      effectiveTtlSec: safeTtl,
      estimatedExpireTs: 0,
      idleSec: null,
      remSec: null
    };
  }
  const originTs = resolveLeaseCacheOriginTs(lease, idleAnchorTs);
  const idleSec = Math.floor((safeNow - originTs) / 1000);
  const remSec = safeTtl - idleSec;
  return {
    valid: true,
    idleAnchorTs,
    originTs,
    effectiveTtlSec: safeTtl,
    estimatedExpireTs: originTs + safeTtl * 1000,
    idleSec,
    remSec
  };
}

export function computeEffectiveKeepaliveMinRemainSec(
  minRemainSec,
  deliveryCompSec,
  effectiveTriggerLeadSec
) {
  const baseMin = Math.min(120, Math.max(0, Math.floor(Number(minRemainSec) || 0)));
  if (baseMin <= 0) return 0;
  const safeDelivery = Math.min(20, Math.max(0, Math.floor(Number(deliveryCompSec) || 0)));
  const safeLead = Math.max(0, Math.floor(Number(effectiveTriggerLeadSec) || 0));
  return Math.max(safeDelivery, Math.min(Math.floor(safeLead / 2), baseMin + safeDelivery));
}

export function isKeepalivePendingAckActive(kaState, nowWallMs = Date.now()) {
  if (!kaState || !kaState.pendingAck) return false;
  const lastSentTs = Number(kaState.lastSentTs || 0);
  const safeNow = Number.isFinite(Number(nowWallMs)) ? Math.floor(Number(nowWallMs)) : Date.now();
  return lastSentTs > 0 && safeNow - lastSentTs < KEEPALIVE_PENDING_ACK_WINDOW_MS;
}

export function buildManualKeepaliveMessage(uiLang = "en") {
  return uiLang === "zh"
    ? "[agy-dart TTL保活 手动] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。"
    : "[agy-dart TTL Keepalive Manual] Reply OK only to keep the prompt cache warm. Do not call any tools or modify any files.";
}
