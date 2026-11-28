/**
 * Sidecar plugin version-check, manual/auto update coordination, and single-flight
 * update lifecycle state extracted from `sidecars/dashboard/server.mjs`.
 */
import { createVersionChecker, parseVersion, readLocalVersion } from "./version-check.mjs";
import { createPluginUpdater, evaluateAutoInstallEligibility } from "./version-update.mjs";
import { getEffectiveConfig } from "../../context/lib/config.js";

export const AUTO_UPDATE_ROUTE = "/api/auto-update";

const NON_CIRCUIT_AUTO_FAIL_REASONS = new Set(["gitCheckout", "notInstalled", "busy", "releaseChanged"]);
const AUTO_UPDATE_MUTATION_ALLOWED_KEYS = new Set(["enabled", "dismissNotice"]);
const VERSION_CHECK_ALLOWED_KEYS = new Set(["mode", "fresh"]);
const PLUGIN_UPDATE_ALLOWED_KEYS = new Set(["version"]);

export function createUpdateCoordinator({
  sidecarDirectory,
  getRuntimeStore,
  getExistingRuntimeStore = () => null,
  getPackageVersion,
  invalidateVersionCache
}) {
  let _defaultVersionChecker = null;
  let _defaultPluginUpdater = null;
  let _updateInFlight = false;
  let _updateRestartScheduled = false;
  let _autoCycleInFlight = null;

  function isPluginUpdateBusy() {
    return _updateInFlight || _updateRestartScheduled;
  }

  function isAutoUpdateCheckEnabled() {
    try {
      return getEffectiveConfig().autoUpdateCheck !== false;
    } catch {
      return process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK !== "1";
    }
  }

  function getDefaultVersionChecker() {
    if (!_defaultVersionChecker) {
      _defaultVersionChecker = createVersionChecker({
        getCurrentVersion: () => readLocalVersion() || getPackageVersion()
      });
    }
    return _defaultVersionChecker;
  }

  function getDefaultPluginUpdater() {
    if (!_defaultPluginUpdater) {
      _defaultPluginUpdater = createPluginUpdater({
        sidecarDirectory,
        checkVersion: getDefaultVersionChecker()
      });
    }
    return _defaultPluginUpdater;
  }

  async function handleVersionCheck(
    data = {},
    checker = getDefaultVersionChecker(),
    { autoCheckEnabled = null } = {}
  ) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, status: 400, error: "Request body must be a JSON object" };
    }
    for (const key of Object.keys(data)) {
      if (!VERSION_CHECK_ALLOWED_KEYS.has(key)) {
        return { ok: false, status: 400, error: `Unexpected field '${key}' in request body` };
      }
    }
    const mode = data.mode === undefined ? "manual" : data.mode;
    if (mode !== "manual" && mode !== "auto") {
      return { ok: false, status: 400, error: "Invalid 'mode' value: expected 'manual' or 'auto'" };
    }
    if (data.fresh !== undefined && typeof data.fresh !== "boolean") {
      return { ok: false, status: 400, error: "Field 'fresh' must be a boolean" };
    }
    const allowAuto = typeof autoCheckEnabled === "boolean" ? autoCheckEnabled : isAutoUpdateCheckEnabled();
    if (mode === "auto" && !allowAuto) {
      return {
        ok: true,
        status: "idle",
        currentVersion: readLocalVersion() || getPackageVersion(),
        disabled: true
      };
    }
    return checker(mode, { fresh: Boolean(data.fresh) });
  }

  async function handlePluginUpdate(
    data = {},
    updater = getDefaultPluginUpdater(),
    onUpdated = null,
    { automatic = false, store = null, nowIso = null, approvedAsset = null } = {}
  ) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, status: 400, error: "Request body must be a JSON object" };
    }
    for (const key of Object.keys(data)) {
      if (!PLUGIN_UPDATE_ALLOWED_KEYS.has(key)) {
        return { ok: false, status: 400, error: `Unexpected field '${key}' in request body` };
      }
    }
    const parsed = typeof data.version === "string" ? parseVersion(data.version) : null;
    if (!parsed) {
      return { ok: false, status: 400, error: "Invalid or missing 'version' SemVer string" };
    }
    let result;
    _updateInFlight = true;
    try {
      result = automatic
        ? await updater(parsed.version, {
            automatic: true,
            requireVerifiedAsset: true,
            ...(approvedAsset ? { expectedAsset: approvedAsset } : {})
          })
        : await updater(parsed.version);
    } finally {
      _updateInFlight = false;
    }
    if (result?.status === "updated") {
      invalidateVersionCache();
      try {
        const targetStore = store || getExistingRuntimeStore();
        if (targetStore && typeof targetStore.setAutoUpdateRuntimeState === "function") {
          const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();
          if (automatic) {
            targetStore.setAutoUpdateRuntimeState({
              lastAutoUpdatedVersion: result.version || parsed.version,
              lastAutoUpdatedFrom: result.previousVersion || "",
              lastAutoUpdatedAt: ts,
              lastAutoUpdatedUrl: result.releaseUrl || "",
              failedVersion: "",
              failedReason: "",
              failedAt: ""
            });
          } else {
            targetStore.setAutoUpdateRuntimeState({
              lastAutoUpdatedVersion: "",
              lastAutoUpdatedFrom: "",
              lastAutoUpdatedAt: "",
              lastAutoUpdatedUrl: "",
              failedVersion: "",
              failedReason: "",
              failedAt: ""
            });
          }
        }
      } catch {}
      if (typeof onUpdated === "function") {
        _updateRestartScheduled = true;
        try {
          onUpdated(result);
        } catch {
          _updateRestartScheduled = false;
        }
      }
    }
    return result;
  }

  function handleAutoUpdateMutation(
    data = {},
    { store = getRuntimeStore(), onAutoInstallEnabled = null } = {}
  ) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, status: 400, error: "Request body must be a JSON object" };
    }
    const keys = Object.keys(data);
    if (keys.length === 0) {
      return { ok: false, status: 400, error: "Expected 'enabled' or 'dismissNotice' field" };
    }
    for (const key of keys) {
      if (!AUTO_UPDATE_MUTATION_ALLOWED_KEYS.has(key)) {
        return { ok: false, status: 400, error: `Unexpected field '${key}' in request body` };
      }
    }
    if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
      return { ok: false, status: 400, error: "Field 'enabled' must be a boolean" };
    }
    if (data.dismissNotice !== undefined && data.dismissNotice !== true) {
      return { ok: false, status: 400, error: "Field 'dismissNotice' must be true" };
    }
    if (typeof data.enabled === "boolean") {
      store.setAutoUpdateInstallEnabled(data.enabled);
      if (data.enabled === true && typeof onAutoInstallEnabled === "function") {
        void Promise.resolve(onAutoInstallEnabled()).catch(() => {});
      }
    }
    if (data.dismissNotice === true) {
      store.clearAutoUpdateNotice();
    }
    const info = store.getAutoUpdateInstallInfo();
    const state = store.getAutoUpdateRuntimeState();
    const localVer = readLocalVersion() || getPackageVersion();
    const notice =
      state.lastAutoUpdatedVersion && (!localVer || state.lastAutoUpdatedVersion === localVer)
        ? {
            version: state.lastAutoUpdatedVersion,
            previousVersion: state.lastAutoUpdatedFrom || "",
            updatedAt: state.lastAutoUpdatedAt || "",
            releaseUrl: state.lastAutoUpdatedUrl || ""
          }
        : null;
    return {
      ok: true,
      autoUpdateInstall: info,
      autoUpdateNotice: notice
    };
  }

  async function runAutoUpdateCycle({
    store = getRuntimeStore(),
    checker = getDefaultVersionChecker(),
    updater = getDefaultPluginUpdater(),
    monitor = null,
    onUpdated = null,
    currentVersion = null,
    nowIso = null
  } = {}) {
    if (_autoCycleInFlight) return _autoCycleInFlight;

    const task = (async () => {
      if (!isAutoUpdateCheckEnabled()) {
        return { ok: true, action: "skipped", reason: "checkDisabled" };
      }
      const release = await checker("auto");
      if (!store.isAutoUpdateInstallEnabled()) {
        return { ok: true, action: "checked", release, autoInstallSkipped: "installDisabled" };
      }
      if (isPluginUpdateBusy()) {
        return { ok: true, action: "skipped", reason: "busy", release };
      }
      if (monitor?._keepaliveInFlight && monitor._keepaliveInFlight.size > 0) {
        return { ok: true, action: "deferred", reason: "keepaliveInFlight", release };
      }
      const runtimeState = store.getAutoUpdateRuntimeState();
      const curVer =
        typeof currentVersion === "string" && currentVersion.trim()
          ? currentVersion.trim()
          : release?.currentVersion || readLocalVersion() || getPackageVersion();
      const eligibility = evaluateAutoInstallEligibility({
        release,
        currentVersion: curVer,
        failedVersion: runtimeState.failedVersion
      });
      if (!eligibility.eligible) {
        return { ok: true, action: "checked", release, autoInstallSkipped: eligibility.skipReason };
      }

      const approvedAsset = {
        version: eligibility.targetVersion,
        releaseTag: typeof release.releaseTag === "string" ? release.releaseTag.trim() : "",
        assetName: typeof release.assetName === "string" ? release.assetName.trim() : "",
        assetUrl: typeof release.assetUrl === "string" ? release.assetUrl.trim() : "",
        assetSha256: typeof release.assetSha256 === "string" ? release.assetSha256.trim().toLowerCase() : ""
      };

      const updRes = await handlePluginUpdate(
        { version: eligibility.targetVersion },
        updater,
        onUpdated,
        { automatic: true, store, nowIso, approvedAsset }
      );
      if (updRes?.status === "updated") {
        return { ok: true, action: "updated", result: updRes };
      }
      const failReason = updRes?.reason || "install";
      if (!NON_CIRCUIT_AUTO_FAIL_REASONS.has(failReason)) {
        const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();
        store.setAutoUpdateRuntimeState({
          failedVersion: eligibility.targetVersion,
          failedReason: failReason,
          failedAt: ts
        });
      }
      return { ok: false, action: "failed", result: updRes };
    })().finally(() => {
      _autoCycleInFlight = null;
    });

    _autoCycleInFlight = task;
    return task;
  }

  function resetUpdateState() {
    _updateInFlight = false;
    _updateRestartScheduled = false;
    _autoCycleInFlight = null;
  }

  return {
    isPluginUpdateBusy,
    resetUpdateState,
    isAutoUpdateCheckEnabled,
    getDefaultVersionChecker,
    getDefaultPluginUpdater,
    handleVersionCheck,
    handlePluginUpdate,
    handleAutoUpdateMutation,
    runAutoUpdateCycle
  };
}
