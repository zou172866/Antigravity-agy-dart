
    const CAT_I18N_KEYS = {
      images: 'catImages',
      documents: 'catDocuments',
      code: 'catCode',
      models3d: 'catModels3d',
      music: 'catMusic',
      video: 'catVideo',
      archives: 'catArchives'
    };

    const SEG_I18N_KEYS = {
      thinking: 'segThinking',
      fileReads: 'segFileReads',
      toolResults: 'segToolResults',
      assistant: 'segAssistant',
      user: 'segUser',
      toolCalls: 'segToolCalls',
      media: 'segMedia'
    };

    const SOURCE_I18N_KEYS = {
      empirical: 'srcEmpirical',
      explicit: 'srcExplicit',
      profile: 'srcProfile',
      transcript: 'srcTranscript',
      history: 'srcHistory',
      session: 'srcSession'
    };

    const BUST_CAUSE_I18N_KEYS = {
      ttl_idle_expiry: 'bustTtl',
      compaction_or_truncation: 'bustCompact',
      model_switch: 'bustModel',
      system_injection: 'bustSysMsg',
      multimodal_media: 'bustMedia',
      prefix_drift: 'bustDrift'
    };

    const BUST_READ_STATE_I18N_KEYS = {
      zero: 'bustReadZero',
      partial: 'bustReadPartial',
      unreported: 'bustReadUnreported'
    };

    function detectInitialLang() {
      try {
        const params = new URLSearchParams(window.location?.search || '');
        const qp = String(params.get('lang') || '').toLowerCase();
        if (qp === 'zh' || qp === 'en') return qp;
      } catch {}
      try {
        if (typeof localStorage !== 'undefined' && localStorage) {
          const saved = String(localStorage.getItem(LANG_STORAGE_KEY) || '').toLowerCase();
          if (saved === 'zh' || saved === 'en') return saved;
        }
      } catch {}
      try {
        const navLang = String(navigator?.language || '').toLowerCase();
        if (navLang.startsWith('zh')) return 'zh';
      } catch {}
      return 'en';
    }

    let currentLang = detectInitialLang();
    let currentScope = 'conversation';
    let cachedStats = null;
    let cachedCutoffMeta = null;
    let cachedGhost = null;
    let cachedKv = null;
    let cachedResume = null;
    let cachedDoctor = null;
    let cachedSafetyAudit = null;
    let safetyUserExpanded = null;
    let safetyHandoffGuided = false;
    let safetyHandoffAutoCopied = false;
    let safetyAuditTimer = null;
    let safetyAuditInitDone = false;
    let lastSafetyAuditFetchMs = 0;
    let cachedCompactAdvice = 'none';
    let cachedLastUpdatedDate = null;
    let cachedDisconnectedErr = null;
    let cachedConvId = '';
    let selectedConvOverride = '';
    let inferredFallbackConvId = '';
    let cachedHostWorkspacePaths = null;
    let hostWorkspaceInitStarted = false;
    const HOST_WORKSPACE_TIMEOUT_MS = 200;
    const CONSUMED_JUMPS_STORAGE_KEY = 'agy-dart-consumed-jumps';
    const consumedJumpIds = new Set();
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage && typeof sessionStorage.getItem === 'function') {
        const rawStored = sessionStorage.getItem(CONSUMED_JUMPS_STORAGE_KEY);
        if (rawStored) {
          const parsedStored = JSON.parse(rawStored);
          if (Array.isArray(parsedStored)) {
            parsedStored.slice(-32).forEach((id) => {
              if (typeof id === 'string' && id) consumedJumpIds.add(id);
            });
          }
        }
      }
    } catch {}
    const claimingJumpIds = new Set();
    const localOriginatedJumpIds = new Set();
    function rememberBoundedId(setObj, id, maxSize = 64) {
      if (!id) return;
      setObj.add(id);
      if (setObj.size > maxSize) {
        const oldest = setObj.values().next().value;
        if (oldest !== undefined) setObj.delete(oldest);
      }
      if (setObj === consumedJumpIds) {
        try {
          if (typeof sessionStorage !== 'undefined' && sessionStorage && typeof sessionStorage.setItem === 'function') {
            sessionStorage.setItem(CONSUMED_JUMPS_STORAGE_KEY, JSON.stringify(Array.from(consumedJumpIds).slice(-32)));
          }
        } catch {}
      }
    }
    let pendingJumpFallbackTimer = null;
    let pendingJumpFallbackId = '';
    let focusFollowupTimer = null;
    let jumpPillFlashTimer = null;
    let lastFlashedPillEl = null;
    let jumpActionSeq = 0;
    let cachedHandoffData = null;
    let cachedHandoffSnapshot = null;
    let handoffLoading = false;
    let cachedWatchdog = null;
    let wdLiveState = null;
    let wdLiveTimer = null;
    let wdCopyResetTimer = null;
    let isProtectionPaused = false;
    let kvTtlState = null;
    let kvTtlTimer = null;
    let pollTimer = null;
    let handoffDrawerOpen = false;
    let lastHandoffMarkdown = '';
    let handoffCopyResetTimer = null;
    let handoffPromptCopyResetTimer = null;
    let guidanceHandoffCopyResetTimer = null;
    let errorViewerOpen = false;
    let currentGuidanceErrorDetail = null;
    let currentGuidanceErrorIsPrevious = false;
    let handoffFetchSeq = 0;
    let rescueCopySeq = 0;
    let lastObservedWatchdogIncidentKey = '';
    let refreshSeq = 0;
    let watchdogActionSeq = 0;
    let inFlightWatchdogActionCount = 0;
    let latestStartedWatchdogActionSeq = 0;
    let latestAppliedWatchdogActionSeq = 0;
    let sawOutOfOrderWatchdogAction = false;
    let pendingCustomOverrideConvId = '';
    const GITHUB_REPO_URL = 'https://github.com/zou172866/Antigravity-agy-dart';
    const GITHUB_RELEASES_URL = GITHUB_REPO_URL + '/releases';
    const GH_STAR_CLI_CMD = 'gh api -X PUT /user/starred/zou172866/Antigravity-agy-dart';
    let cachedStarPrompt = null;
    let starPromptResolvedLocally = false;
    let starCopyHideTimer = null;
    let autoVersionCheckDone = false;
    let autoVersionCheckTimer = null;
    let versionReloadTimer = null;
    const versionCheckState = {
      checking: false,
      updating: false,
      updated: false,
      manual: false,
      available: null,
      lastCheck: null,
      lastUpdate: null,
      dismissedVersion: '',
      dismissedAutoNoticeVersion: '',
      autoUpdatedNotice: null,
      autoUpdateInstall: { enabled: false, source: 'default' },
      autoUpdateToggling: false,
      reloadPending: false
    };

    function getNativeHostConversationId() {
      try {
        const params = new URLSearchParams(window.location?.search || '');
        const raw = window.sidecar?.conversationId || params.get('conversationId') || '';
        return typeof raw === 'string' ? raw.trim() : '';
      } catch {
        const raw = window.sidecar?.conversationId || '';
        return typeof raw === 'string' ? raw.trim() : '';
      }
    }

    let lastSeenNativeConvId = getNativeHostConversationId();
    let hostSwitchEpoch = 0;
    let handoffInFlightRequest = null;
    let pendingServerAheadSync = null;
    let handoffDrawerTargetedAlert = false;
    let handoffDrawerTargetedConvId = '';
    let handoffDrawerTargetedEnded = false;
    let handoffDrawerSelectionSeq = 0;

    function resetHandoffDrawerTargetMode({ bumpSelection = true } = {}) {
      handoffDrawerTargetedAlert = false;
      handoffDrawerTargetedConvId = '';
      handoffDrawerTargetedEnded = false;
      if (bumpSelection) {
        ++handoffDrawerSelectionSeq;
      }
    }
    const RESERVED_SWITCHER_CONV_IDS = new Set([
      '',
      'default',
      'all',
      'lifetime',
      'app',
      '__unbound__',
      'unknown',
      'none',
      'null',
      'undefined'
    ]);

    function isSpecificConversationId(id) {
      if (typeof id !== 'string') return false;
      const trimmed = id.trim();
      if (!trimmed || trimmed.length > 128) return false;
      if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) return false;
      if (RESERVED_SWITCHER_CONV_IDS.has(trimmed.toLowerCase())) return false;
      return /^[A-Za-z0-9._-]+$/.test(trimmed);
    }

    function isValidSwitcherConvId(id) {
      return isSpecificConversationId(id);
    }

    function getConfirmedConversationId() {
      if (isSpecificConversationId(selectedConvOverride)) {
        return selectedConvOverride.trim();
      }
      const nativeId = getNativeHostConversationId();
      if (isSpecificConversationId(nativeId)) {
        return nativeId;
      }
      return '';
    }

    function isCurrentConversationConfirmed() {
      return currentScope === 'conversation' && Boolean(getConfirmedConversationId());
    }

    function syncNativeHostConversation({ reloadIfOpen = handoffDrawerOpen } = {}) {
      const nativeId = getNativeHostConversationId();
      if (nativeId !== lastSeenNativeConvId) {
        const prevNative = lastSeenNativeConvId;
        lastSeenNativeConvId = nativeId;
        ++hostSwitchEpoch;
        selectedConvOverride = '';
        inferredFallbackConvId = '';
        pendingCustomOverrideConvId = '';
        windowCustomIntervalOpen = false;
        sawOutOfOrderWatchdogAction = false;
        lastObservedWatchdogIncidentKey = '';
        resetManualWarmState();
        resetHandoffDrawerTargetMode();
        ++watchdogActionSeq;
        ++searchRequestSeq;
        clearHandoffSnapshot({ resetPreview: true, reloadIfOpen });
        resetPanelGuidanceState();
        updateWatchdogIncidentButtons();
        renderSessionSwitcher(cachedWatchdog);
        if (!prevNative && nativeId) {
          const gm = cachedGlobalKeepalive.globalMaxCount;
          const fm = cachedGlobalKeepalive.fallbackMaxCount;
          const gi = cachedGlobalKeepalive.globalIntervalSec;
          unboundKeepaliveState = {
            enabled: gm >= 1,
            maxCount: gm >= 1 ? gm : fm,
            globalMaxCount: gm,
            fallbackMaxCount: fm,
            intervalSec: gi,
            globalIntervalSec: gi,
            isCustomOverride: false,
            usedCount: 0,
            lastError: ''
          };
        }
      }
      return nativeId;
    }

    function getActiveConversationId() {
      const nativeId = syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
      return selectedConvOverride || nativeId || (!window.sidecar ? inferredFallbackConvId : '');
    }

    function decodeWorkspaceUriClient(raw) {
      if (typeof raw !== 'string') return '';
      let s = raw.trim();
      if (!s) return '';
      if (/^file:\/\//i.test(s)) {
        s = s.replace(/^file:\/\/\/?/i, '');
        s = s.replace(/^([a-zA-Z])%3[aA](?=\/|$)/, '$1:');
        try {
          s = decodeURIComponent(s);
        } catch {}
        if (!/^[a-zA-Z]:/.test(s) && !s.startsWith('/')) {
          s = '/' + s;
        }
      }
      s = s.replace(/\\/g, '/').replace(/\/+$/, '');
      if (/^[a-zA-Z]:/.test(s)) {
        return s.toLowerCase();
      }
      return s;
    }

    function resolveRefinedCwdWithWorkspaceLabel(normCwd, workspaceLabel) {
      if (!normCwd || typeof workspaceLabel !== 'string' || !workspaceLabel.trim()) return '';
      const wsNorm = workspaceLabel.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const slashIdx = wsNorm.indexOf('/');
      if (slashIdx <= 0) return '';
      const wsParent = wsNorm.slice(0, slashIdx).trim();
      const wsSub = wsNorm.slice(slashIdx + 1).trim();
      if (!wsParent || !wsSub) return '';
      const cwdParts = normCwd.split('/').filter(Boolean);
      const cwdLeaf = cwdParts.length > 0 ? cwdParts[cwdParts.length - 1] : '';
      const cmpA = /^[a-z]:/.test(normCwd) ? cwdLeaf.toLowerCase() : cwdLeaf;
      const cmpB = /^[a-z]:/.test(normCwd) ? wsParent.toLowerCase() : wsParent;
      if (cmpA && cmpA === cmpB) {
        const subNorm = /^[a-z]:/.test(normCwd) ? wsSub.toLowerCase() : wsSub;
        return `${normCwd}/${subNorm}`;
      }
      return '';
    }

    function classifyWorkspaceCwdMatch(wsList, cwd, workspaceLabel = '') {
      const normCwd = decodeWorkspaceUriClient(cwd);
      if (!normCwd || !Array.isArray(wsList) || wsList.length === 0) return 'none';
      const refinedCwd = resolveRefinedCwdWithWorkspaceLabel(normCwd, workspaceLabel);
      let sawAncestor = false;
      for (const rawWs of wsList) {
        const normWs = decodeWorkspaceUriClient(rawWs);
        if (!normWs) continue;
        if (normCwd === normWs || (refinedCwd && refinedCwd === normWs)) {
          return 'exact';
        }
        if (normCwd.startsWith(normWs + '/') || (refinedCwd && refinedCwd.startsWith(normWs + '/'))) {
          sawAncestor = true;
        }
      }
      return sawAncestor ? 'ancestor' : 'none';
    }

    function doesWorkspaceMatchCwd(wsList, cwd, workspaceLabel = '') {
      return classifyWorkspaceCwdMatch(wsList, cwd, workspaceLabel) !== 'none';
    }

    async function resolveHostWorkspacePaths() {
      if (!window.sidecar || typeof window.sidecar.getWorkspaceUris !== 'function') {
        return [];
      }
      if (!hostWorkspaceInitStarted) {
        hostWorkspaceInitStarted = true;
        if (typeof window.sidecar.onWorkspaceChange === 'function') {
          try {
            window.sidecar.onWorkspaceChange((uris) => {
              if (Array.isArray(uris)) {
                cachedHostWorkspacePaths = uris.map(decodeWorkspaceUriClient).filter(Boolean);
                if (cachedWatchdog && cachedWatchdog.pendingJump) {
                  consumePendingJumpIfEligible(cachedWatchdog);
                }
              }
            });
          } catch {}
        }
      }
      if (Array.isArray(cachedHostWorkspacePaths)) {
        return cachedHostWorkspacePaths;
      }
      try {
        let guardTimer = null;
        const urisPromise = Promise.resolve(window.sidecar.getWorkspaceUris()).then(
          (uris) => {
            const decoded = Array.isArray(uris) ? uris.map(decodeWorkspaceUriClient).filter(Boolean) : [];
            cachedHostWorkspacePaths = decoded;
            return { timedOut: false, decoded };
          },
          () => ({ timedOut: true, decoded: [] })
        );
        const timeoutPromise = new Promise((resolve) => {
          guardTimer = setTimeout(() => {
            guardTimer = null;
            resolve({ timedOut: true, decoded: [] });
          }, HOST_WORKSPACE_TIMEOUT_MS);
        });
        const winner = await Promise.race([urisPromise, timeoutPromise]);
        if (guardTimer !== null) clearTimeout(guardTimer);
        return winner.decoded;
      } catch {
        return [];
      }
    }

    function t(key, vars) {
      const dict = I18N[currentLang] || I18N.en;
      let str = Object.prototype.hasOwnProperty.call(dict, key)
        ? dict[key]
        : (Object.prototype.hasOwnProperty.call(I18N.en, key) ? I18N.en[key] : key);
      if (vars && typeof vars === 'object') {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replaceAll(`{${k}}`, String(v ?? ''));
        }
      }
      return str;
    }

    function tCat(catId, fallback) {
      const k = CAT_I18N_KEYS[catId];
      return k ? t(k) : (fallback || catId);
    }

    function tSeg(segKey, fallback) {
      const k = SEG_I18N_KEYS[segKey];
      return k ? t(k) : (fallback || segKey);
    }

    function fmtSourceLabel(src) {
      const raw = String(src || '').trim();
      if (!raw) return '';
      const k = SOURCE_I18N_KEYS[raw];
      return k ? t(k) : raw;
    }

    function fmtBustCause(cause) {
      const raw = String(cause || '').trim();
      if (!raw) return '';
      const k = Object.prototype.hasOwnProperty.call(BUST_CAUSE_I18N_KEYS, raw) ? BUST_CAUSE_I18N_KEYS[raw] : null;
      return k ? t(k) : raw;
    }

    function fmtBustReadState(state) {
      const raw = String(state || '').trim();
      if (!raw) return '';
      const k = Object.prototype.hasOwnProperty.call(BUST_READ_STATE_I18N_KEYS, raw) ? BUST_READ_STATE_I18N_KEYS[raw] : null;
      return k ? t(k) : '';
    }

    function isNonNegFiniteCount(val) {
      return typeof val === 'number' && Number.isFinite(val) && val >= 0;
    }

    function hasValidDriftBreakdown(db, expectedTotal = null) {
      if (
        !db ||
        typeof db !== 'object' ||
        !isNonNegFiniteCount(db.zeroRead) ||
        !isNonNegFiniteCount(db.partialRead) ||
        !isNonNegFiniteCount(db.unreportedRead)
      ) {
        return false;
      }
      if (expectedTotal !== null) {
        return db.zeroRead + db.partialRead + db.unreportedRead === expectedTotal;
      }
      return true;
    }

    function hasValidPriorContextMatch(pm) {
      return Boolean(
        pm &&
        typeof pm === 'object' &&
        isNonNegFiniteCount(pm.referenceStepIndex) &&
        isNonNegFiniteCount(pm.recoveryStepIndex)
      );
    }

    function fmtTurnBustDetail(turnItem, turns, turnIdx, isMultiSession = false) {
      if (!turnItem || !turnItem.isBust) return '';
      const causeLabel = fmtBustCause(turnItem.bustCause);
      const parts = [];
      if (turnItem.bustCause === 'prefix_drift') {
        const rsLabel = fmtBustReadState(turnItem.bustReadState);
        if (rsLabel) parts.push(rsLabel);
      }
      const pm = turnItem.priorContextMatch;
      if (hasValidPriorContextMatch(pm)) {
        const refStep = pm.referenceStepIndex;
        const prevTurn = !isMultiSession && turnIdx > 0 ? turns[turnIdx - 1] : null;
        const refLabel =
          prevTurn && isNonNegFiniteCount(prevTurn.stepIndex) && prevTurn.stepIndex === refStep && isNonNegFiniteCount(prevTurn.turn)
            ? t('turnRefNum', { turn: prevTurn.turn })
            : t('stepRefNum', { step: refStep });
        parts.push(t('priorContextMatchNote', { ref: refLabel }));
      }
      const causeWithDetail =
        parts.length > 0
          ? t('turnBustCauseWithDetail', { cause: causeLabel, detail: parts.join(t('turnBustDetailSep')) })
          : causeLabel;
      return t('turnBustTag', { cause: causeWithDetail });
    }

    function updateLangButtons() {
      const zhBtn = document.getElementById('lang-zh-btn');
      const enBtn = document.getElementById('lang-en-btn');
      if (zhBtn) zhBtn.className = currentLang === 'zh' ? 'seg-btn is-active' : 'seg-btn';
      if (enBtn) enBtn.className = currentLang === 'en' ? 'seg-btn is-active' : 'seg-btn';
    }

    function applyStaticTranslations() {
      try {
        if (document.documentElement) {
          document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
        }
        document.title = t('pageTitle');
      } catch {}
      if (typeof document.querySelectorAll !== 'function') return;
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
      });
      document.querySelectorAll('[data-i18n-html]').forEach((el) => {
        const key = el.getAttribute('data-i18n-html');
        if (key) el.innerHTML = t(key);
      });
      document.querySelectorAll('[data-i18n-title]').forEach((el) => {
        const key = el.getAttribute('data-i18n-title');
        if (key) el.title = t(key);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) el.placeholder = t(key);
      });
      document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
        const key = el.getAttribute('data-i18n-aria-label');
        if (key && typeof el.setAttribute === 'function') el.setAttribute('aria-label', t(key));
      });
    }

    function updateScopeUiTexts() {
      const purgeBtn = document.getElementById('purge-btn');
      const cutoffLabel = document.getElementById('cutoff-scope-label');
      if (currentScope === 'conversation') {
        if (purgeBtn) {
          purgeBtn.innerText = t('purgeConvBtn');
          purgeBtn.title = t('purgeConvTip');
        }
        if (cutoffLabel) cutoffLabel.innerText = t('cutoffConvLabel');
      } else if (currentScope === 'app') {
        if (purgeBtn) {
          purgeBtn.innerText = t('purgeAppBtn');
          purgeBtn.title = t('purgeAppTip');
        }
        if (cutoffLabel) cutoffLabel.innerText = t('cutoffAppLabel');
      } else {
        if (purgeBtn) {
          purgeBtn.innerText = t('purgeLifetimeBtn');
          purgeBtn.title = t('purgeLifetimeTip');
        }
        if (cutoffLabel) cutoffLabel.innerText = t('cutoffLifetimeLabel');
      }

      const scopeName =
        currentScope === 'conversation'
          ? t('scopeConv')
          : currentScope === 'app'
            ? t('scopeApp')
            : t('scopeLifetime');
      const explainEl = document.getElementById('exempt-scope-explain');
      if (explainEl) {
        explainEl.innerHTML = t('scopeExplainHtml', { scope: escapeHtml(scopeName) });
      } else {
        const scopeNote = document.getElementById('exempt-scope-note');
        if (scopeNote) scopeNote.innerText = scopeName;
      }
    }

    function renderTelemetryBanner() {
      const srcEl = document.getElementById('telemetry-source');
      const updEl = document.getElementById('last-updated-text');
      if (cachedDisconnectedErr) {
        if (updEl) updEl.innerText = t('errorPrefix', { msg: cachedDisconnectedErr });
        if (srcEl) {
          srcEl.innerHTML = `${escapeHtml(t('showingStatsFor'))} <span class="text-err">${escapeHtml(t('disconnected'))}</span>`;
        }
        return;
      }
      if (updEl) {
        updEl.innerText = cachedLastUpdatedDate
          ? t('updatedAt', { t: cachedLastUpdatedDate.toLocaleTimeString() })
          : t('updating');
      }
      let scopeLabel = t('scopeBannerConv');
      if (currentScope === 'app') {
        const bootStr = cachedStats?.appStartTime
          ? new Date(cachedStats.appStartTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '';
        scopeLabel = bootStr
          ? `${t('scopeBannerApp')} (${t('scopeBannerSince', { t: bootStr })})`
          : t('scopeBannerApp');
      } else if (currentScope === 'lifetime') {
        scopeLabel = t('scopeBannerLifetime');
      } else if (cachedConvId) {
        scopeLabel = `${t('scopeBannerConv')} (${cachedConvId.slice(0, 8)}...)`;
      }
      if (srcEl) {
        srcEl.innerHTML = `
          ${escapeHtml(t('showingStatsFor'))} <span class="telemetry-source-val">${escapeHtml(scopeLabel)}</span>
        `;
      }
    }

    function renderHandoffMeta() {
      const metaEl = document.getElementById('kv-handoff-meta');
      if (!metaEl || !cachedHandoffData) return;
      const sizeLabel = formatBytes(Number(cachedHandoffData.bytes || 0));
      const truncTag = cachedHandoffData.truncated ? ` · ${t('handoffTruncated')}` : '';
      const sumPart = cachedHandoffData.summary ? ` · ${cachedHandoffData.summary}` : '';
      metaEl.textContent = `${sizeLabel}${truncTag}${sumPart}`;
    }

    let userSwitchedLang = false;
    let autoSyncedInitialZh = false;

    async function syncUiLangToServer(lang) {
      try {
        await sendWatchdogAction({ action: 'setUiLang', lang });
      } catch {}
    }

    function setLanguage(lang, syncServer = false) {
      const next = lang === 'zh' ? 'zh' : 'en';
      currentLang = next;
      if (syncServer) {
        userSwitchedLang = true;
      }
      try {
        if (typeof localStorage !== 'undefined' && localStorage) {
          localStorage.setItem(LANG_STORAGE_KEY, next);
        }
      } catch {}
      applyLanguageUi();
      if (syncServer) {
        syncUiLangToServer(next);
      }
    }


    function applyLanguageUi() {
      updateLangButtons();
      applyStaticTranslations();
      updateThemeButton();
      updateSectionJumpTooltips();
      updateActiveBadge(isProtectionPaused);
      updateScopeUiTexts();
      updateHandoffButtonStyle(cachedCompactAdvice);
      renderTelemetryBanner();
      if (cachedStats) {
        updateCutoffDropdown(cachedStats);
        updateExemptionsList(cachedStats);
        updateFeaturePill('toggle-cli-filter-btn', t('cliFilterLabel'), cachedStats.cliFilterEnabled !== false);
        updateFeaturePill('toggle-read-dedup-btn', t('readDedupLabel'), cachedStats.readDedupEnabled !== false);
        renderCoreSettingsOverrides(cachedStats);
        renderStorageHealth(cachedDoctor?.storageHealth || cachedStats.storageHealth);
        renderGhostEfficiency(cachedStats.ghost);
        if (cachedStats.sandboxCapBytes) {
          const capEl = document.getElementById('sandbox-cap');
          if (capEl) capEl.innerText = t('capFormat', { size: formatBytes(cachedStats.sandboxCapBytes) });
        }
        const totalRaw = Number(cachedStats.totalRawBytes || 0);
        const totalRet = Number(cachedStats.totalReturnedBytes || 0);
        const keptOut = Number(cachedStats.keptOutBytes !== undefined ? cachedStats.keptOutBytes : Math.max(0, totalRaw - totalRet));
        const rawRate = totalRaw > 0 ? ((keptOut / totalRaw) * 100) : Number(cachedStats.savingsPercent || 0);
        const rateStr = rawRate.toFixed(1) + '%';
        const sources = Number(cachedStats.sourcesCount || 0);
        const srcCntEl = document.getElementById('sources-count');
        if (srcCntEl) srcCntEl.innerText = sources === 1 ? t('inSourcesOne') : t('inSourcesMany', { n: sources });
        const badgeEl = document.getElementById('comparison-badge');
        if (badgeEl) badgeEl.innerText = t('pctSaved', { rate: totalRaw > 0 || rawRate > 0 ? rateStr : '0.0%' });
      } else {
        const cutoffSelect = document.getElementById('cutoff-select');
        if (cutoffSelect && Array.isArray(cutoffSelect.options)) {
          for (const opt of cutoffSelect.options) {
            if (opt.value === '46080') opt.textContent = t('cutoffHostCap');
            else if (opt.value === '0') opt.textContent = t('cutoffNone');
            else if (opt.dataset && opt.dataset.customCutoff === '1') {
              opt.textContent = t('cutoffCustomFmt', { size: formatBytes(Number(opt.value)) });
            }
          }
        }
        const rawCutoffVal = cutoffSelect && cutoffSelect.value !== undefined && cutoffSelect.value !== ''
          ? Number(cutoffSelect.value)
          : 46080;
        renderGateReadCutoff(Number.isFinite(rawCutoffVal) ? rawCutoffVal : 46080, cachedCutoffMeta);
        if (cachedGhost) {
          renderGhostEfficiency(cachedGhost);
        }
        const cliBtn = document.getElementById('toggle-cli-filter-btn');
        const dedupBtn = document.getElementById('toggle-read-dedup-btn');
        updateFeaturePill('toggle-cli-filter-btn', t('cliFilterLabel'), cliBtn?.dataset?.enabled !== '0');
        updateFeaturePill('toggle-read-dedup-btn', t('readDedupLabel'), dedupBtn?.dataset?.enabled !== '0');
      }
      if (cachedDoctor) {
        const docEl = document.getElementById('doctor-status');
        if (docEl && cachedDoctor.status) {
          docEl.innerText = cachedDoctor.status === 'HEALTHY' ? t('statusHealthy') : cachedDoctor.status;
        }
      } else {
        const docEl = document.getElementById('doctor-status');
        if (docEl && (docEl.innerText === 'HEALTHY' || docEl.innerText === '健康')) {
          docEl.innerText = t('statusHealthy');
        }
      }
      if (cachedResume) {
        renderRecentSourcesAndEvents(cachedResume);
      }
      if (cachedSafetyAudit) {
        renderSafetyAuditCard(cachedSafetyAudit);
      }
      if (cachedKv) {
        renderKvCacheCard(cachedKv);
      } else {
        renderSynthesizedContextSummary();
        renderPanelGuidance();
        if (kvTtlState) {
          renderLocalTtlCountdown();
        }
      }
      if (cachedWatchdog) {
        renderWatchdogCard(cachedWatchdog, { preserveEpoch: true });
        if (
          !shouldAcceptKeepalivePayload(cachedWatchdog.ttlKeepalive) &&
          !shouldAcceptKeepalivePayload(cachedKv?.ttlKeepalive)
        ) {
          renderKeepaliveControls(window.sidecar && !getActiveConversationId() ? unboundKeepaliveState : null);
        }
      } else {
        const wdEnableBtn = document.getElementById('wd-enable-btn');
        const wdNotifyBtn = document.getElementById('wd-notify-btn');
        const kvTtlNotifyBtn = document.getElementById('kv-ttl-notify-btn');
        updateFeaturePill('wd-enable-btn', t('wdEnableLabel'), wdEnableBtn?.dataset?.enabled !== '0');
        updateFeaturePill('wd-notify-btn', t('wdNotifyLabel'), wdNotifyBtn?.dataset?.enabled === '1');
        updateFeaturePill('kv-ttl-notify-btn', t('kvTtlNotifyLabel'), kvTtlNotifyBtn?.dataset?.enabled === '1');
        renderGlobalKeepaliveControls(
          cachedGlobalKeepalive.globalMaxCount,
          cachedGlobalKeepalive.fallbackMaxCount,
          cachedGlobalKeepalive.globalIntervalSec
        );
        renderKeepaliveMinContextControls(cachedGlobalKeepalive.minContextPct);
        renderKeepaliveControls(null);
        const sevBadge = document.getElementById('wd-severity-badge');
        const phaseBadge = document.getElementById('wd-phase-badge');
        const statusHint = document.getElementById('wd-status-hint');
        if (sevBadge) {
          sevBadge.className = 'meta-tag is-ok';
          sevBadge.textContent = t('wdSevIdle');
        }
        if (phaseBadge) phaseBadge.classList.add('hidden');
        if (statusHint) {
          statusHint.textContent = t('wdHintIdle');
          statusHint.classList.remove('hidden');
        }
        renderSessionSwitcher(null);
      }
      if (handoffDrawerOpen && handoffDrawerTargetedAlert && handoffDrawerTargetedEnded && !cachedHandoffData) {
        renderTargetedHandoffAlertEndedUi();
      } else {
        if (cachedHandoffData) {
          renderHandoffMeta();
        }
        renderHandoffWarmthHint();
        updateHandoffActionButtons();
        const previewEl = document.getElementById('kv-handoff-preview');
        if (previewEl && lastHandoffMarkdown) {
          previewEl.textContent = lastHandoffMarkdown;
        }
      }
      if (cachedStats && cachedStats.starPrompt) {
        renderStarMilestoneBanner(cachedStats.starPrompt);
      }
      updateAutoUpdateInstallBtn();
      renderVersionUpdateUi();
    }

    function renderStarMilestoneBanner(sp) {
      const banner = document.getElementById('star-milestone-banner');
      if (!banner) return;
      if (!sp || typeof sp !== 'object') {
        if (starCopyHideTimer === null) banner.classList.add('hidden');
        return;
      }
      cachedStarPrompt = sp;
      if (sp.state && sp.state !== 'pending') {
        starPromptResolvedLocally = true;
      }
      if (starPromptResolvedLocally || !sp.shouldShow || sp.state !== 'pending') {
        if (starCopyHideTimer === null) banner.classList.add('hidden');
        return;
      }
      const msgEl = document.getElementById('star-banner-msg');
      if (msgEl) {
        const savedBytes = Number(sp.lifetimeSavedBytes || sp.milestoneSavedBytes || 0);
        msgEl.textContent =
          savedBytes > 0
            ? t('starBannerMsgSavings', { savedText: formatBytes(savedBytes) })
            : t('starBannerMsgAudit');
      }
      banner.classList.remove('hidden');
    }

    async function persistStarPromptState(state) {
      try {
        const res = await apiFetch('/api/star-prompt', {
          method: 'POST',
          body: JSON.stringify({ state })
        });
        if (res && res.ok) {
          const data = await res.json();
          if (data && data.starPrompt) {
            cachedStarPrompt = data.starPrompt;
            if (cachedStats) cachedStats.starPrompt = data.starPrompt;
          }
        }
      } catch {}
    }

    function hideStarBannerNow() {
      const banner = document.getElementById('star-milestone-banner');
      if (banner) banner.classList.add('hidden');
    }

    function handleHeaderStarClick() {
      if (cachedStarPrompt && cachedStarPrompt.state === 'pending' && !starPromptResolvedLocally) {
        starPromptResolvedLocally = true;
        if (starCopyHideTimer !== null) {
          clearTimeout(starCopyHideTimer);
          starCopyHideTimer = null;
        }
        hideStarBannerNow();
        persistStarPromptState('clicked');
      }
    }

    function handleStarBannerOpen() {
      starPromptResolvedLocally = true;
      if (starCopyHideTimer !== null) {
        clearTimeout(starCopyHideTimer);
        starCopyHideTimer = null;
      }
      hideStarBannerNow();
      persistStarPromptState('clicked');
    }

    function handleStarBannerDismiss() {
      starPromptResolvedLocally = true;
      if (starCopyHideTimer !== null) {
        clearTimeout(starCopyHideTimer);
        starCopyHideTimer = null;
      }
      hideStarBannerNow();
      persistStarPromptState('dismissed');
    }

    async function handleStarBannerCopyCli() {
      starPromptResolvedLocally = true;
      let copied = false;
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(GH_STAR_CLI_CMD);
          copied = true;
        } catch {}
      }
      if (!copied && typeof document.createElement === 'function' && document.body) {
        const ta = document.createElement('textarea');
        ta.value = GH_STAR_CLI_CMD;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          copied = Boolean(document.execCommand('copy'));
        } catch {
          copied = false;
        } finally {
          document.body.removeChild(ta);
        }
      }
      persistStarPromptState('copied_cli');
      const fb = document.getElementById('star-banner-feedback');
      if (fb) {
        fb.textContent = copied
          ? t('starBannerCopiedNotice')
          : t('starBannerCopyFailedNotice', { cmd: GH_STAR_CLI_CMD });
        fb.classList.remove('hidden');
      }
      if (starCopyHideTimer !== null) clearTimeout(starCopyHideTimer);
      starCopyHideTimer = setTimeout(() => {
        starCopyHideTimer = null;
        if (fb) fb.classList.add('hidden');
        hideStarBannerNow();
      }, 2500);
    }

    function updateActiveBadge(isPaused) {
      isProtectionPaused = Boolean(isPaused);
      const btn = document.getElementById('toggle-active-btn');
      const dot = document.getElementById('active-dot');
      const text = document.getElementById('active-text');
      if (!btn || !dot || !text) return;

      if (isProtectionPaused) {
        btn.className = 'status-btn is-paused';
        btn.title = t('pausedTip');
        dot.className = 'status-dot is-paused';
        text.innerText = t('pausedText');
      } else {
        btn.className = 'status-btn is-active';
        btn.title = t('activeTip');
        dot.className = 'status-dot is-active';
        text.innerText = t('activeText');
      }
    }

    async function toggleActiveState() {
      ++refreshSeq;
      const mutScope = currentScope;
      const prevPaused = isProtectionPaused;
      const nextPaused = !prevPaused;
      updateActiveBadge(nextPaused);
      try {
        const convId = getActiveConversationId();

        const res = await apiFetch('/api/toggle-active', {
          method: 'POST',
          body: JSON.stringify({ scope: mutScope, conversationId: convId, paused: nextPaused })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (currentScope === mutScope && data && data.isPaused !== undefined) {
          updateActiveBadge(data.isPaused);
        }
      } catch (e) {
        console.error('Failed to toggle active state', e);
        if (currentScope === mutScope) updateActiveBadge(prevPaused);
      }
    }

    function applyScopeSelection(scope) {
      currentScope = scope;
      const convBtn = document.getElementById('scope-conv-btn');
      const appBtn = document.getElementById('scope-app-btn');
      const lifetimeBtn = document.getElementById('scope-lifetime-btn');

      if (convBtn) convBtn.className = scope === 'conversation' ? 'seg-btn is-active' : 'seg-btn';
      if (appBtn) appBtn.className = scope === 'app' ? 'seg-btn is-active' : 'seg-btn';
      if (lifetimeBtn) lifetimeBtn.className = scope === 'lifetime' ? 'seg-btn is-active' : 'seg-btn';

      updateScopeUiTexts();

      if (cachedStats) {
        updateCutoffDropdown(cachedStats);
        updateExemptionsList(cachedStats);
      }
    }

    function setScope(scope) {
      applyScopeSelection(scope);

      ++watchdogActionSeq;
      ++searchRequestSeq;
      lastObservedWatchdogIncidentKey = '';
      resetManualWarmState();
      resetHandoffDrawerTargetMode();
      clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: handoffDrawerOpen });
      resetPanelGuidanceState();
      updateWatchdogIncidentButtons();
      renderSessionSwitcher(cachedWatchdog);
      renderManualWarmControls();

      refreshData(true);
    }

    function calculateMaxLineRange(bytes) {
      const b = Number(bytes || 0);
      if (b <= 0) return 0;
      return Math.min(800, Math.max(50, Math.round(b / 40)));
    }

    function formatBytes(bytes) {
      const b = Number(bytes || 0);
      if (b <= 0) return "0 B";
      if (b < 1024) return b + " B";
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
      return (b / (1024 * 1024)).toFixed(2) + " MB";
    }

    function escapeHtml(val) {
      return String(val ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function getCsrfToken() {
      return document.querySelector('meta[name="agy-dart-token"]')?.getAttribute('content') || '';
    }

    async function apiFetch(path, options = {}) {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      const csrfToken = getCsrfToken();

      const finalUrl = path;

      const headers = new Headers(options.headers || {});
      if (token && !headers.has('X-Sidecar-Token')) {
        headers.set('X-Sidecar-Token', token);
      }
      if (csrfToken && !headers.has('X-Agy-Dart-Token')) {
        headers.set('X-Agy-Dart-Token', csrfToken);
      }
      const method = (options.method || 'GET').toUpperCase();
      let body = options.body;
      if (method === 'POST') {
        if (!headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
        if (body === undefined) {
          body = '{}';
        }
      }

      const fetchOpts = { ...options, method, headers };
      if (body !== undefined) fetchOpts.body = body;

      if (window.sidecar && typeof window.sidecar.fetch === 'function') {
        return window.sidecar.fetch(finalUrl, fetchOpts);
      }
      return fetch(finalUrl, fetchOpts);
    }

    function renderGateReadCutoff(activeCutoff, s) {
      const gateReadCutoff = document.getElementById('gate-read-cutoff');
      if (!gateReadCutoff) return;
      const guardMode = (s && s.readGuardMode) || 'soft';
      if (activeCutoff === 0 || guardMode === 'off') {
        gateReadCutoff.innerText = t('gateReadDisabled');
      } else {
        const fmtTier = (b) => {
          const n = Number(b || 0);
          if (n <= 0) return t('tierOff');
          return n % 1024 === 0 ? `${n / 1024} KB` : formatBytes(n);
        };
        const maxLines = calculateMaxLineRange(activeCutoff);
        const noiseStr = fmtTier(s && s.noiseMaxReadBytes !== undefined ? s.noiseMaxReadBytes : 16384);
        const reviewStr = fmtTier(s && s.reviewMaxReadBytes !== undefined ? s.reviewMaxReadBytes : 131072);
        const key = guardMode === 'strict' ? 'gateReadStrict' : 'gateReadEnabled';
        gateReadCutoff.innerText = t(key, { size: formatBytes(activeCutoff), lines: maxLines, noise: noiseStr, review: reviewStr });
      }
    }

    function updateCutoffDropdown(s) {
      if (s && typeof s === 'object') cachedCutoffMeta = s;
      const cutoffSelect = document.getElementById('cutoff-select');
      const DEFAULT_CUTOFF_VAL = 46080;
      let activeCutoff = DEFAULT_CUTOFF_VAL;
      if (currentScope === 'lifetime') {
        activeCutoff = s.globalCutoffBytes !== undefined && s.globalCutoffBytes !== null ? s.globalCutoffBytes : DEFAULT_CUTOFF_VAL;
      } else if (currentScope === 'app') {
        activeCutoff = s.appCutoffBytes !== undefined && s.appCutoffBytes !== null ? s.appCutoffBytes : (s.globalCutoffBytes ?? DEFAULT_CUTOFF_VAL);
      } else {
        activeCutoff = s.conversationCutoffBytes !== undefined && s.conversationCutoffBytes !== null ? s.conversationCutoffBytes : (s.cutoffBytes ?? DEFAULT_CUTOFF_VAL);
      }

      const targetVal = String(activeCutoff);
      let matched = false;
      const existingCustom = typeof cutoffSelect.querySelector === 'function'
        ? cutoffSelect.querySelector('option[data-custom-cutoff="1"]')
        : null;
      for (const opt of cutoffSelect.options) {
        if (opt.value === '46080') opt.textContent = t('cutoffHostCap');
        else if (opt.value === '0') opt.textContent = t('cutoffNone');
      }
      for (const opt of cutoffSelect.options) {
        if (opt.value === targetVal && !(opt.dataset && opt.dataset.customCutoff === '1')) {
          cutoffSelect.value = targetVal;
          matched = true;
          break;
        }
      }
      if (matched) {
        if (existingCustom && typeof cutoffSelect.removeChild === 'function') {
          try { cutoffSelect.removeChild(existingCustom); } catch {}
        }
      } else if (targetVal === '0') {
        cutoffSelect.value = '0';
      } else if (typeof document.createElement === 'function' && typeof cutoffSelect.appendChild === 'function') {
        const customOpt = existingCustom || document.createElement('option');
        customOpt.value = targetVal;
        customOpt.textContent = t('cutoffCustomFmt', { size: formatBytes(activeCutoff) });
        if (typeof customOpt.setAttribute === 'function') customOpt.setAttribute('data-custom-cutoff', '1');
        if (customOpt.dataset) customOpt.dataset.customCutoff = '1';
        if (!existingCustom) {
          cutoffSelect.appendChild(customOpt);
          if (Array.isArray(cutoffSelect.options) && !cutoffSelect.options.includes(customOpt)) {
            cutoffSelect.options.push(customOpt);
          }
        }
        cutoffSelect.value = targetVal;
      } else {
        cutoffSelect.value = targetVal;
      }
      if (cutoffSelect.dataset) cutoffSelect.dataset.lastConfirmedCutoff = cutoffSelect.value;

      renderGateReadCutoff(activeCutoff, s);
      renderCutoffOverrideBadge(activeCutoff, s);
    }

    function renderCutoffOverrideBadge(activeCutoff, s) {
      const badge = document.getElementById('cutoff-override-badge');
      if (!badge) return;
      const meta = s && typeof s === 'object' ? s : {};
      const scopeSource =
        currentScope === 'lifetime'
          ? (meta.globalCutoffSource || meta.cutoffSource || '')
          : currentScope === 'app'
            ? (meta.appCutoffSource || meta.cutoffSource || '')
            : (meta.conversationCutoffSource || meta.cutoffSource || '');
      const overrideSource =
        scopeSource === 'env' || scopeSource === 'config'
          ? scopeSource
          : currentScope === 'lifetime' && (meta.cutoffOverriddenBy === 'env' || meta.cutoffOverriddenBy === 'config')
            ? meta.cutoffOverriddenBy
            : null;
      if (!overrideSource) {
        badge.textContent = '';
        badge.title = '';
        if (badge.dataset) delete badge.dataset.overrideSource;
        badge.classList?.add('hidden');
        return;
      }
      const srcLabel = overrideSource === 'env' ? t('cutoffSourceEnv') : t('cutoffSourceConfig');
      const fmtCutoff = (b) => (Number(b) === 0 ? t('cutoffNone') : formatBytes(Number(b)));
      const effText = fmtCutoff(activeCutoff);
      badge.textContent = t('cutoffOverrideBadge', { source: srcLabel });
      if (
        currentScope === 'lifetime' &&
        meta.savedGlobalCutoffBytes !== null &&
        meta.savedGlobalCutoffBytes !== undefined
      ) {
        badge.title = t('cutoffOverrideTip', {
          source: srcLabel,
          effective: effText,
          saved: fmtCutoff(meta.savedGlobalCutoffBytes)
        });
      } else {
        badge.title = t('cutoffOverrideTipNoSaved', {
          source: srcLabel,
          effective: effText
        });
      }
      if (badge.dataset) badge.dataset.overrideSource = overrideSource;
      badge.classList?.remove('hidden');
    }

    function renderCoreSettingsOverrides(s) {
      const info = s && s.settingsInfo && typeof s.settingsInfo === 'object' ? s.settingsInfo : null;
      const applyBadge = (elId, item, fmtVal) => {
        const badge = document.getElementById(elId);
        if (!badge) return;
        const overrideSource = item && (item.overriddenBy === 'env' || item.overriddenBy === 'config')
          ? item.overriddenBy
          : null;
        if (!overrideSource) {
          badge.textContent = '';
          badge.title = '';
          if (badge.dataset) delete badge.dataset.overrideSource;
          badge.classList?.add('hidden');
          return;
        }
        const srcLabel = overrideSource === 'env' ? t('cutoffSourceEnv') : t('cutoffSourceConfig');
        const effVal = fmtVal(item.effective, item);
        const savedRaw = item.saved !== undefined ? item.saved : item.savedMaxCount;
        const savedVal = savedRaw === null || savedRaw === undefined ? '--' : fmtVal(savedRaw, item);
        badge.textContent = t('settingOverrideBadge', { source: srcLabel });
        badge.title = t('settingOverrideTip', {
          source: srcLabel,
          effective: effVal,
          saved: savedVal
        });
        if (badge.dataset) badge.dataset.overrideSource = overrideSource;
        badge.classList?.remove('hidden');
      };
      const fmtBool = (v) => (v ? t('stateOn') : t('stateOff'));
      const fmtKa = (v, item) => {
        const count = typeof v === 'number' ? v : Number(item?.effectiveMaxCount || 0);
        return count > 0 ? `×${count}` : t('stateOff');
      };
      applyBadge('cli-filter-override-badge', info?.cliFilter, fmtBool);
      applyBadge('read-dedup-override-badge', info?.readDedup, fmtBool);
      applyBadge('wd-override-badge', info?.watchdog, fmtBool);
      applyBadge('ka-override-badge', info?.ttlKeepalive, fmtKa);
    }

    function renderStorageHealth(storageHealth) {
      const subEl = document.getElementById('db-reclaimable-sub');
      const compactBtn = document.getElementById('vacuum-only-btn');
      const reclaimBytes = Number(storageHealth?.reclaimableBytes || 0);
      const reclaimPct = Number(storageHealth?.reclaimablePct || 0);
      const showFragmentation = reclaimBytes > 0 && (reclaimBytes >= 65536 || reclaimPct >= 10);
      if (subEl) {
        if (showFragmentation) {
          subEl.textContent = t('storageReclaimableFmt', {
            size: formatBytes(reclaimBytes),
            pct: Math.round(reclaimPct)
          });
          subEl.classList?.remove('hidden');
        } else {
          subEl.textContent = '';
          subEl.classList?.add('hidden');
        }
      }
      if (compactBtn) {
        if (showFragmentation) compactBtn.classList?.remove('hidden');
        else compactBtn.classList?.add('hidden');
      }
    }

    async function changeCutoff(newVal) {
      ++refreshSeq;
      const mutScope = currentScope;
      const cutoffSelect = document.getElementById('cutoff-select');
      const prevSelectVal = cutoffSelect ? (cutoffSelect.dataset?.lastConfirmedCutoff ?? '46080') : null;
      const prevStatsSnapshot = cachedStats ? { ...cachedStats } : null;
      try {
        const convId = getActiveConversationId();
        const cutoffBytes = newVal === '0' || newVal === 0 ? 0 : parseInt(newVal, 10);

        if (cutoffSelect) cutoffSelect.value = String(cutoffBytes);
        renderGateReadCutoff(cutoffBytes, cachedStats);
        if (cachedStats) {
          if (mutScope === 'lifetime') {
            cachedStats.globalCutoffBytes = cutoffBytes;
            cachedStats.appCutoffBytes = cutoffBytes;
            if (!cachedStats.hasConversationCutoffOverride) {
              cachedStats.conversationCutoffBytes = cutoffBytes;
              cachedStats.cutoffBytes = cutoffBytes;
            }
          } else if (mutScope === 'app') {
            cachedStats.appCutoffBytes = cutoffBytes;
            cachedStats.hasAppCutoffOverride = true;
          } else {
            cachedStats.conversationCutoffBytes = cutoffBytes;
            cachedStats.cutoffBytes = cutoffBytes;
            cachedStats.hasConversationCutoffOverride = true;
          }
        }

        const res = await apiFetch('/api/cutoff', {
          method: 'POST',
          body: JSON.stringify({ cutoff: cutoffBytes, scope: mutScope, conversationId: convId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const respData = await res.json().catch(() => null);
        if (respData && cachedStats) {
          if (respData.globalCutoffBytes !== undefined) cachedStats.globalCutoffBytes = respData.globalCutoffBytes;
          if (respData.appCutoffBytes !== undefined) cachedStats.appCutoffBytes = respData.appCutoffBytes;
          if (respData.conversationCutoffBytes !== undefined) cachedStats.conversationCutoffBytes = respData.conversationCutoffBytes;
          if (respData.globalCutoffSource !== undefined) cachedStats.globalCutoffSource = respData.globalCutoffSource;
          if (respData.appCutoffSource !== undefined) cachedStats.appCutoffSource = respData.appCutoffSource;
          if (respData.conversationCutoffSource !== undefined) cachedStats.conversationCutoffSource = respData.conversationCutoffSource;
          if (respData.savedGlobalCutoffBytes !== undefined) cachedStats.savedGlobalCutoffBytes = respData.savedGlobalCutoffBytes;
          if (respData.effectiveSource !== undefined) cachedStats.cutoffSource = respData.effectiveSource;
          cachedStats.cutoffOverriddenBy = respData.overriddenBy ?? null;
          if (respData.effectiveCutoffBytes !== undefined && mutScope === currentScope) {
            cachedStats.cutoffBytes = respData.effectiveCutoffBytes;
          }
        }
        if (currentScope === mutScope && respData && (respData.overriddenBy || cachedStats)) {
          if (cachedStats) {
            updateCutoffDropdown(cachedStats);
          } else if (respData.effectiveCutoffBytes !== undefined) {
            updateCutoffDropdown({
              cutoffBytes: respData.effectiveCutoffBytes,
              globalCutoffBytes: respData.globalCutoffBytes ?? respData.effectiveCutoffBytes,
              appCutoffBytes: respData.appCutoffBytes ?? respData.effectiveCutoffBytes,
              conversationCutoffBytes: respData.conversationCutoffBytes ?? respData.effectiveCutoffBytes,
              cutoffSource: respData.effectiveSource,
              globalCutoffSource: respData.globalCutoffSource ?? respData.effectiveSource,
              appCutoffSource: respData.appCutoffSource,
              conversationCutoffSource: respData.conversationCutoffSource,
              savedGlobalCutoffBytes: respData.savedGlobalCutoffBytes ?? respData.savedCutoffBytes,
              cutoffOverriddenBy: respData.overriddenBy ?? null
            });
          }
        }
        if (currentScope === mutScope && cutoffSelect && cutoffSelect.dataset) cutoffSelect.dataset.lastConfirmedCutoff = cutoffSelect.value;
        refreshData(true);
      } catch (err) {
        console.error("Failed to update cutoff:", err);
        cachedStats = prevStatsSnapshot;
        if (currentScope === mutScope) {
          if (cachedStats) {
            updateCutoffDropdown(cachedStats);
          } else if (cutoffSelect && prevSelectVal !== null) {
            cutoffSelect.value = prevSelectVal;
            const restoredBytes = prevSelectVal === '0' ? 0 : (parseInt(prevSelectVal, 10) || 46080);
            updateCutoffDropdown({ cutoffBytes: restoredBytes, appCutoffBytes: restoredBytes, globalCutoffBytes: restoredBytes, conversationCutoffBytes: restoredBytes });
          }
        }
      }
    }

    const DEFAULT_CATEGORIES_META = [
      { id: 'images', name: 'Images', extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.psd'] },
      { id: 'documents', name: 'Documents', extensions: ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.rtf'] },
      { id: 'code', name: 'Source Code', extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.cs', '.html', '.css', '.yaml', '.yml', '.sh', '.ps1'] },
      { id: 'models3d', name: '3D Models', extensions: ['.blend', '.fbx', '.obj', '.gltf', '.glb', '.stl', '.dae', '.3ds', '.step', '.iges'] },
      { id: 'music', name: 'Music', extensions: ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.midi'] },
      { id: 'video', name: 'Video', extensions: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'] },
      { id: 'archives', name: 'Archives', extensions: ['.zip', '.tar', '.gz', '.7z', '.rar', '.wasm'] }
    ];

    const DEFAULT_ACTIVE_CATEGORIES = ['images', 'documents', 'models3d', 'music', 'video', 'archives'];

    function getActiveCategories(s) {
      if (!s) return [...DEFAULT_ACTIVE_CATEGORIES];
      let list = null;
      if (currentScope === 'lifetime') {
        list = s.globalExemptCategories;
      } else if (currentScope === 'app') {
        list = s.appExemptCategories || s.globalExemptCategories;
      } else {
        list = s.conversationExemptCategories || s.exemptCategories;
      }
      return Array.isArray(list) ? list : [...DEFAULT_ACTIVE_CATEGORIES];
    }

    function setActiveCategories(s, cats, scope = currentScope) {
      if (!s) return;
      if (scope === currentScope) s.exemptCategories = cats;
      if (scope === 'lifetime') {
        s.globalExemptCategories = cats;
      } else if (scope === 'app') {
        s.appExemptCategories = cats;
      } else {
        s.conversationExemptCategories = cats;
      }
    }

    function updateExemptionsList(s) {
      const categoriesContainer = document.getElementById('category-toggles');
      const catSummary = document.getElementById('category-summary');
      const categoriesList = s && s.fileCategories && s.fileCategories.length ? s.fileCategories : DEFAULT_CATEGORIES_META;
      const activeCats = getActiveCategories(s);

      if (categoriesContainer) {
        categoriesContainer.innerHTML = categoriesList.map(cat => {
          const isActive = activeCats.includes(cat.id);
          const extCount = cat.extensions ? cat.extensions.length : 0;
          const extSample = cat.extensions ? cat.extensions.slice(0, 6).join(', ') + (cat.extensions.length > 6 ? ', ...' : '') : '';
          const localizedName = tCat(cat.id, cat.name);
          const tooltip = escapeHtml(t('catTip', {
            name: localizedName,
            count: extCount,
            sample: extSample,
            action: isActive ? t('actionDisable') : t('actionEnable')
          }));
          const safeId = escapeHtml(cat.id);
          const safeName = escapeHtml(localizedName);

          return `
            <button data-cat="${safeId}" onclick="toggleCategory(this.dataset.cat)"
                    class="toggle-chip ${isActive ? 'is-on' : ''}"
                    title="${tooltip}">
              <span class="toggle-chip-dot"></span>
              <span>${safeName}</span>
            </button>
          `;
        }).join('');
      }

      if (catSummary) {
        catSummary.innerText = t('catSummary', { active: activeCats.length, total: categoriesList.length });
      }

      const tagsContainer = document.getElementById('exempt-tags');
      const customCount = document.getElementById('custom-count');
      let customList = [];
      if (s) {
        if (currentScope === 'lifetime') {
          customList = s.globalCustomExtensions || [];
        } else if (currentScope === 'app') {
          customList = s.appCustomExtensions || s.globalCustomExtensions || [];
        } else {
          customList = s.conversationCustomExtensions || s.customExtensions || [];
        }
      }

      if (tagsContainer) {
        if (customList && customList.length > 0) {
          tagsContainer.innerHTML = customList.map(ext => {
            const safeExt = escapeHtml(ext);
            return `
            <span class="ext-chip">
              <span>${safeExt}</span>
              <button data-ext="${safeExt}" onclick="removeExemption(this.dataset.ext)" class="ext-remove" title="${escapeHtml(t('removeCustomTip'))}">×</button>
            </span>
          `;
          }).join('');
        } else {
          tagsContainer.innerHTML = `<span class="muted-note">${escapeHtml(t('noCustomExt'))}</span>`;
        }
      }

      if (customCount) {
        customCount.innerText = t('customCount', { n: customList.length });
      }
    }

    async function toggleCategory(categoryId) {
      ++refreshSeq;
      const mutScope = currentScope;
      if (!cachedStats) cachedStats = {};
      const activeCats = getActiveCategories(cachedStats);
      const isCurrentlyActive = activeCats.includes(categoryId);
      const nextEnabled = !isCurrentlyActive;
      const nextActive = isCurrentlyActive
        ? activeCats.filter(c => c !== categoryId)
        : [...activeCats, categoryId];

      setActiveCategories(cachedStats, nextActive, mutScope);
      updateExemptionsList(cachedStats);

      const convId = getActiveConversationId();
      try {
        const res = await apiFetch('/api/exemptions', {
          method: 'POST',
          body: JSON.stringify({ action: 'toggleCategory', category: categoryId, enabled: nextEnabled, scope: mutScope, conversationId: convId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && data.exemptCategories) {
          setActiveCategories(cachedStats, data.exemptCategories, mutScope);
          if (currentScope === mutScope) updateExemptionsList(cachedStats);
        }
      } catch (err) {
        console.error("Failed to toggle category:", err);
        setActiveCategories(cachedStats, activeCats, mutScope);
        if (currentScope === mutScope) {
          updateExemptionsList(cachedStats);
        }
      }
    }

    async function addExemption() {
      const input = document.getElementById('new-exempt-input');
      const val = input.value.trim();
      if (!val) return;
      const cleanExt = val.startsWith('*.') ? val.slice(1) : val;
      if (!/^\.?[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(cleanExt)) {
        alert(t('alertAddExemptFail', { msg: t('invalidExtFmt') }));
        return;
      }

      ++refreshSeq;
      const convId = getActiveConversationId();

      try {
        const res = await apiFetch('/api/exemptions', {
          method: 'POST',
          body: JSON.stringify({ action: 'add', ext: cleanExt, scope: currentScope, conversationId: convId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        input.value = '';
        refreshData(true);
      } catch (err) {
        alert(t('alertAddExemptFail', { msg: err.message }));
      }
    }

    async function removeExemption(ext) {
      ++refreshSeq;
      const convId = getActiveConversationId();

      try {
        const res = await apiFetch('/api/exemptions', {
          method: 'POST',
          body: JSON.stringify({ action: 'remove', ext, scope: currentScope, conversationId: convId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        refreshData(true);
      } catch (err) {
        alert(t('alertRemoveExemptFail', { msg: err.message }));
      }
    }

    async function resetExemptions() {
      if (!confirm(t('confirmResetExempt'))) return;
      ++refreshSeq;
      const convId = getActiveConversationId();

      try {
        const res = await apiFetch('/api/exemptions', {
          method: 'POST',
          body: JSON.stringify({ action: 'reset', scope: currentScope, conversationId: convId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        refreshData(true);
      } catch (err) {
        alert(t('alertResetExemptFail', { msg: err.message }));
      }
    }

    function renderRecentSourcesAndEvents(r) {
      if (!r) return;
      const recentSec = document.getElementById('recent-sources-section');
      if (recentSec && recentSec.classList && recentSec.classList.contains('hidden')) return;
      const sourcesDiv = document.getElementById('sources-list');
      if (!sourcesDiv) return;

      function formatItemPath(p) {
        if (!p) return "";
        const normalized = p.replace(/\\/g, "/");
        const parts = normalized.split("/").filter(Boolean);
        if (parts.length <= 3) return parts.join("/");
        return parts.slice(-3).join("/");
      }

      const items = [];
      if (r.recentEvents && r.recentEvents.length > 0) {
        const guardEvents = r.recentEvents.filter(ev => ev.kind === 'interception' || ev.kind === 'cli_filter' || ev.kind === 'dedup');
        for (const ev of guardEvents) {
          const displayPath = escapeHtml(formatItemPath(ev.path || ev.tool));
          const rawTitle = escapeHtml(`${ev.path || ev.tool}`);
          const saved = Math.max(0, Number(ev.sandbox_bytes || 0) - Number(ev.returned_bytes || 0));
          const safeAgent = escapeHtml(ev.agent || '');
          const agentBadge = (ev.agent && ev.agent !== 'antigravity' && ev.agent !== 'primary')
            ? `<span class="agent-tag" title="${escapeHtml(t('triggeredBySubagent', { agent: ev.agent }))}">${safeAgent}</span>`
            : '';
          const isFilter = ev.kind === 'cli_filter';
          const isDedup = ev.kind === 'dedup';
          const dotCls = isFilter ? 'is-filter' : isDedup ? 'is-dedup' : 'is-block';
          const labelCls = isFilter ? 'source-action-filter' : isDedup ? 'source-action-dedup' : 'source-action-block';
          const actionText = escapeHtml(
            isFilter
              ? t('filteredPrefix', { key: ev.key || 'cli' })
              : isDedup
                ? t('dedupPrefix', { tool: ev.tool })
                : t('blockedPrefix', { tool: ev.tool })
          );
          items.push(`
            <div class="source-row" title="${actionText} ${rawTitle}">
              <div class="source-left">
                <span class="source-dot ${dotCls}"></span>
                ${agentBadge}
                <span class="truncate">
                  <span class="${labelCls}">${actionText}</span>
                  <span>${displayPath}</span>
                </span>
              </div>
              <div class="source-right">
                <span class="${labelCls}">${formatBytes(saved)}</span>
                <span class="muted-note">${escapeHtml(t('savedWord'))}</span>
              </div>
            </div>
          `);
        }
      }

      if (r.recentSources && r.recentSources.length > 0) {
        for (const src of r.recentSources) {
          const safeId = escapeHtml(src.id);
          const safeLabel = escapeHtml(src.label);
          const chunkCount = Number(src.chunk_count) || 0;
          const bytesTotal = Number(src.bytes_total) || 0;
          const chunkWord = chunkCount === 1 ? t('chunkOne') : t('chunkMany');
          items.push(`
            <div data-source-id="${safeId}" data-source-label="${safeLabel}" onclick="inspectSourceEl(this)"
                 class="source-row is-clickable"
                 title="${escapeHtml(t('clickToInspectSource', { label: src.label }))}">
              <div class="source-left">
                <span class="source-dot is-index"></span>
                <span class="truncate">${safeLabel}</span>
              </div>
              <div class="source-right">
                <span>${formatBytes(bytesTotal)}</span>
                <span class="muted-note">(${chunkCount} ${escapeHtml(chunkWord)})</span>
                <svg class="btn-icon muted-note" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          `);
        }
      }

      if (items.length > 0) {
        sourcesDiv.innerHTML = items.join('');
      } else {
        sourcesDiv.innerHTML = `<div class="muted-note">${escapeHtml(t('noSourcesView'))}</div>`;
      }
    }

    let autoRefreshInFlight = false;
    let autoRefreshPromise = null;

    function refreshData(manual = false) {
      if (!manual && autoRefreshInFlight && autoRefreshPromise) return autoRefreshPromise;
      if (!manual) autoRefreshInFlight = true;
      let followUpAutoRefresh = false;
      const run = executeRefreshData(manual, () => {
        followUpAutoRefresh = true;
      }).finally(() => {
        if (!manual) {
          autoRefreshInFlight = false;
          if (autoRefreshPromise === run) autoRefreshPromise = null;
        }
        if (followUpAutoRefresh) {
          queueMicrotask(() => refreshData(false));
        }
      });
      if (!manual) autoRefreshPromise = run;
      return run;
    }

    async function executeRefreshData(manual = false, scheduleFollowUpAutoRefresh = null) {
      const reqSeq = ++refreshSeq;
      const reqScope = currentScope;
      let reqNativeId = getNativeHostConversationId();
      let reqConfirmedConv = getConfirmedConversationId();
      let reqHostEpoch = hostSwitchEpoch;
      const isStale = () => {
        if (getNativeHostConversationId() !== reqNativeId) {
          syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
          return true;
        }
        return (
          reqSeq !== refreshSeq ||
          hostSwitchEpoch !== reqHostEpoch ||
          currentScope !== reqScope ||
          getConfirmedConversationId() !== reqConfirmedConv
        );
      };
      const refreshIcon = document.getElementById('refresh-icon');
      if (manual && refreshIcon) refreshIcon.classList.add('spinning');

      try {
        const convId = getActiveConversationId();
        reqNativeId = getNativeHostConversationId();
        reqConfirmedConv = getConfirmedConversationId();
        reqHostEpoch = hostSwitchEpoch;
        const confirmedConv = isCurrentConversationConfirmed();
        cachedConvId = convId;
        const scopeBody = JSON.stringify({ scope: reqScope, conversationId: convId, conversationConfirmed: confirmedConv });
        const kaScopeBody = window.sidecar
          ? JSON.stringify({ scope: reqScope, conversationId: convId, conversationConfirmed: confirmedConv, fromSidecarHost: true })
          : scopeBody;

        const [statsRes, docRes, kvRes, wdRes, resumeRes] = await Promise.all([
          apiFetch('/api/stats', { method: 'POST', body: scopeBody }),
          apiFetch('/api/doctor', { method: 'POST', body: '{}' }).catch(() => null),
          apiFetch('/api/cache-diag', { method: 'POST', body: kaScopeBody }).catch(() => null),
          apiFetch('/api/watchdog', { method: 'POST', body: kaScopeBody }).catch(() => null),
          apiFetch('/api/resume', { method: 'POST', body: kaScopeBody }).catch(() => null)
        ]);
        if (!statsRes.ok) throw new Error(`Stats HTTP ${statsRes.status}`);
        const s = await statsRes.json();
        if (isStale()) return;
        cachedStats = s;
        renderStarMilestoneBanner(s.starPrompt);
        if (s.autoUpdateInstall && typeof s.autoUpdateInstall === 'object') {
          versionCheckState.autoUpdateInstall = s.autoUpdateInstall;
          updateAutoUpdateInstallBtn();
        }
        if (s.autoUpdateNotice && s.autoUpdateNotice.version) {
          if (versionCheckState.dismissedAutoNoticeVersion !== s.autoUpdateNotice.version) {
            versionCheckState.autoUpdatedNotice = s.autoUpdateNotice;
            renderVersionUpdateUi();
          }
        } else if (versionCheckState.autoUpdatedNotice) {
          versionCheckState.autoUpdatedNotice = null;
          renderVersionUpdateUi();
        }

        updateCutoffDropdown(s);
        updateExemptionsList(s);
        if (s.isPaused !== undefined) {
          updateActiveBadge(s.isPaused);
        }
        updateFeaturePill('toggle-cli-filter-btn', t('cliFilterLabel'), s.cliFilterEnabled !== false);
        updateFeaturePill('toggle-read-dedup-btn', t('readDedupLabel'), s.readDedupEnabled !== false);
        renderCoreSettingsOverrides(s);
        if (s.storageHealth) {
          renderStorageHealth(s.storageHealth);
        }
        if (s.breakdown) {
          const cdEl = document.getElementById('cli-dedup-counts');
          if (cdEl) cdEl.innerText = `${Number(s.breakdown.cliFilters) || 0} / ${Number(s.breakdown.dedups) || 0}`;
        }
        renderGhostEfficiency(s.ghost);
        if (s.version) {
          const verEl = document.getElementById('dashboard-version');
          if (verEl) verEl.innerText = s.version.startsWith('v') ? s.version : `v${s.version}`;
        }

        if (s.sandboxCapBytes) {
          document.getElementById('sandbox-cap').innerText = t('capFormat', { size: formatBytes(s.sandboxCapBytes) });
        }

        const totalRaw = Number(s.totalRawBytes || 0);
        const totalRet = Number(s.totalReturnedBytes || 0);
        const keptOut = Number(s.keptOutBytes !== undefined ? s.keptOutBytes : Math.max(0, totalRaw - totalRet));
        const rawRate = totalRaw > 0 ? ((keptOut / totalRaw) * 100) : Number(s.savingsPercent || 0);
        const rateStr = rawRate.toFixed(1) + "%";
        const tokensPreserved = Number(s.tokensKeptOut !== undefined ? s.tokensKeptOut : Math.round(keptOut / 4));
        const chunks = Number(s.chunksCount || 0);
        const sources = Number(s.sourcesCount || 0);

        document.getElementById('reduction-rate').innerText = rateStr;
        document.getElementById('tokens-preserved').innerText = "~" + tokensPreserved.toLocaleString();
        document.getElementById('kept-out-kb').innerText = formatBytes(keptOut);
        document.getElementById('total-raw').innerText = formatBytes(totalRaw);
        document.getElementById('total-returned').innerText = formatBytes(totalRet);
        document.getElementById('chunks-count').innerText = chunks;
        document.getElementById('sources-count').innerText = sources === 1 ? t('inSourcesOne') : t('inSourcesMany', { n: sources });

        const badgeEl = document.getElementById('comparison-badge');
        const savedFillEl = document.getElementById('bar-saved-fill');
        const usedFillEl = document.getElementById('bar-used-fill');

        if (totalRaw > 0) {
          const savedPct = Math.max(0, Math.min(100, rawRate));
          const usedPct = Math.max(0, 100 - savedPct);

          if (badgeEl) badgeEl.innerText = t('pctSaved', { rate: rateStr });
          if (savedFillEl) savedFillEl.style.width = `${savedPct}%`;
          if (usedFillEl) usedFillEl.style.width = `${usedPct}%`;
        } else {
          const savedPct = Math.max(0, Math.min(100, rawRate));
          if (badgeEl) badgeEl.innerText = t('pctSaved', { rate: rawRate > 0 ? rateStr : '0.0%' });
          if (savedFillEl) savedFillEl.style.width = `${savedPct}%`;
          if (usedFillEl) usedFillEl.style.width = '0%';
        }
        renderSynthesizedContextSummary();

        try {
          if (docRes && docRes.ok) {
            const d = await docRes.json();
            if (isStale()) return;
            cachedDoctor = d;
            if (d.status) {
              document.getElementById('doctor-status').innerText = d.status === 'HEALTHY' ? t('statusHealthy') : d.status;
            }
            const dbSizeEl = document.getElementById('db-size-label');
            if (dbSizeEl && d.dbSizeBytes !== undefined) {
              const totalDb = Number(d.dbSizeBytes || 0) + Number(d.walSizeBytes || 0);
              dbSizeEl.innerText = `SQLite (${formatBytes(totalDb)})`;
            }
            if (d.storageHealth || d.reclaimableBytes !== undefined) {
              renderStorageHealth(d.storageHealth || d);
            }
          }
        } catch {}

        try {
          if (kvRes && kvRes.ok) {
            const kv = await kvRes.json();
            if (isStale()) return;
            cachedKv = kv;
            const preferredFallbackConvId =
              typeof kv.ttlKeepalive?.conversationId === 'string' &&
              kv.ttlKeepalive.conversationId &&
              kv.ttlKeepalive.conversationId !== '__unbound__'
                ? kv.ttlKeepalive.conversationId
                : !kv.ttlKeepalive?.isSubagent && typeof kv.resolvedConversationId === 'string'
                  ? kv.resolvedConversationId
                  : '';
            if (
              !window.sidecar &&
              !convId &&
              preferredFallbackConvId &&
              preferredFallbackConvId !== 'default' &&
              inferredFallbackConvId !== preferredFallbackConvId
            ) {
              inferredFallbackConvId = preferredFallbackConvId;
              renderSessionSwitcher(cachedWatchdog);
              if (typeof scheduleFollowUpAutoRefresh === 'function') {
                scheduleFollowUpAutoRefresh();
              } else {
                queueMicrotask(() => refreshData(false));
              }
            }
            renderKvCacheCard(kv);
          }
        } catch {}

        try {
          if (wdRes && wdRes.ok) {
            const wd = await wdRes.json();
            if (isStale()) return;
            if (wd.enabled === false) {
              if (cachedKv) cachedKv.conversationActive = false;
              if (kvTtlState) kvTtlState.conversationActive = false;
            }
            if (
              cachedKv?.ttlKeepalive?.coldMissTripped === true &&
              wd.ttlKeepalive &&
              wd.ttlKeepalive.coldMissTripped === false &&
              wd.ttlKeepalive.conversationId &&
              wd.ttlKeepalive.conversationId === cachedKv.ttlKeepalive.conversationId &&
              wd.ttlKeepalive.lastSentTs === cachedKv.ttlKeepalive.lastSentTs
            ) {
              wd.ttlKeepalive = { ...wd.ttlKeepalive, coldMissTripped: true };
            }
            wd._hostEpoch = reqHostEpoch;
            renderWatchdogCard(wd, { expectedEpoch: reqHostEpoch });
          }
        } catch {}

        try {
          if (resumeRes && resumeRes.ok) {
            const r = await resumeRes.json();
            if (isStale()) return;
            cachedResume = r;
            renderRecentSourcesAndEvents(r);
            renderPanelGuidance();
          }
        } catch {}

        cachedDisconnectedErr = null;
        cachedLastUpdatedDate = new Date();
        renderTelemetryBanner();

      } catch (err) {
        if (isStale()) return;
        console.error("Telemetry refresh failed:", err);
        cachedDisconnectedErr = err.message;
        renderTelemetryBanner();
      } finally {
        if (refreshIcon && reqSeq === refreshSeq) {
          setTimeout(() => refreshIcon.classList.remove('spinning'), 400);
        }
      }
    }

    function formatCompactK(n) {
      const v = Number(n) || 0;
      if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
      if (v >= 1000) return `${Math.round(v / 1000)}K`;
      return String(v);
    }

    function formatHumanSafetyDuration(sec, lang) {
      const s = Math.max(0, Math.round(Number(sec) || 0));
      if (lang === 'zh') {
        if (s < 60) return `${s} 秒`;
        if (s < 3600) {
          const m = Math.floor(s / 60);
          const r = s % 60;
          return r > 0 ? `${m} 分 ${r} 秒` : `${m} 分钟`;
        }
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
      }
      if (s < 60) return `${s}s`;
      if (s < 3600) {
        const m = Math.floor(s / 60);
        const r = s % 60;
        return r > 0 ? `${m}m ${r}s` : `${m}m`;
      }
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }

    function formatSafetyTokensByLang(n, lang) {
      const v = Number(n) || 0;
      if (lang === 'zh' && v >= 10000) {
        if (v >= 1000000) return `${Math.round(v / 10000)}万`;
        return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
      }
      return formatCompactK(v);
    }

    function formatSafetyAvgCharsByLang(chars, lang) {
      const v = Number(chars) || 0;
      if (lang === 'zh') {
        if (v <= 0) return '约 0 字';
        if (v >= 10000) return `均长约 ${Math.round(v / 10000)} 万字`;
        if (v >= 1000) return `均长约 ${(v / 10000).toFixed(1)} 万字`;
        return `均长 ${v} 字`;
      }
      return `avg ${Math.round(v / 1000)}K chars`;
    }

    function formatSafetyReasonLabel(reason, lang) {
      const key = String(reason || '').trim();
      const mapZh = {
        unknown_command: '复杂终端命令',
        edit_file: '编辑文件',
        write_file: '新建/写文件',
        call_mcp_tool: '调用插件工具',
        absolute_path: '跨路径访问',
        run_command: '执行命令',
        unsupported_tool: '未列白名单工具',
        read_file: '读取文件'
      };
      const mapEn = {
        unknown_command: 'complex shell cmd',
        edit_file: 'edit_file',
        write_file: 'write_file',
        call_mcp_tool: 'MCP tool',
        absolute_path: 'outside path',
        run_command: 'run_command',
        unsupported_tool: 'non-allowlisted tool',
        read_file: 'read_file'
      };
      if (lang === 'zh' && mapZh[key]) return mapZh[key];
      if (lang !== 'zh' && mapEn[key]) return mapEn[key];
      return key;
    }

    function renderSafetyAuditCard(data) {
      const card = document.getElementById('safety-audit-card');
      if (!card || !data || typeof data !== 'object') return;
      const badgeEl = document.getElementById('safety-status-badge');
      const inlineEl = document.getElementById('safety-inline-summary');
      const detailsEl = document.getElementById('safety-details-body');
      const toggleBtn = document.getElementById('safety-toggle-btn');
      const adviceEl = document.getElementById('safety-advice-box');
      const diagEl = document.getElementById('safety-diagnosis-text');
      const preEl = document.getElementById('safety-kpi-prechecks');
      const preSubEl = document.getElementById('safety-kpi-prechecks-sub');
      const heavyEl = document.getElementById('safety-kpi-heavy');
      const heavySubEl = document.getElementById('safety-kpi-heavy-sub');
      const hiddenEl = document.getElementById('safety-kpi-hidden');
      const hiddenSubEl = document.getElementById('safety-kpi-hidden-sub');
      const kpi429El = document.getElementById('safety-kpi-429');
      const kpi429SubEl = document.getElementById('safety-kpi-429-sub');
      const reasonsEl = document.getElementById('safety-reasons-row');
      const restartEl = document.getElementById('safety-restart-note');
      const handoffBtn = document.getElementById('safety-handoff-btn');

      const status = String(data.status || 'not_detected');
      const severity = String(data.severity || 'none');
      const w = data.window || {};
      const sr = data.streamRequests || {};
      const src = data.sources || {};
      const winH = Number(data.windowHours || 5);
      const recent5m = Number(w.recentHeavyBurst5m || 0);
      const heavyCount = Number(w.heavyReviewCount || 0);
      const preCount = Number(w.precheckCount || 0);
      const preLimit = Number(w.precheckLimit || 4400);
      const prePct = Number(w.precheckUtilizationPct || 0);
      const c429 = Number(w.rateLimit429Count || 0) + Number(w.fallbackEscalationCount || 0);
      const isCalmRecently = status === 'heavy_burst_or_sticky' && recent5m === 0;
      const isAlerting =
        severity === 'warn' ||
        severity === 'critical' ||
        status === '429_avalanche' ||
        status === 'heavy_burst_or_sticky' ||
        status === 'approaching_quota';
      const isActiveCritical =
        status === '429_avalanche' ||
        (status === 'heavy_burst_or_sticky' && !isCalmRecently && severity === 'critical');

      card.classList.remove('is-warn', 'is-critical');
      if (isActiveCritical) {
        card.classList.add('is-critical');
      } else if (isAlerting) {
        card.classList.add('is-warn');
      }

      if (badgeEl) {
        badgeEl.classList.remove('is-ok', 'is-warn', 'is-danger', 'is-info');
        if (status === '429_avalanche') {
          badgeEl.textContent = t('safetyBadgeAvalanche');
          badgeEl.classList.add('is-danger');
        } else if (status === 'heavy_burst_or_sticky') {
          if (isCalmRecently) {
            badgeEl.textContent = t('safetyBadgeCalm');
            badgeEl.classList.add('is-warn');
          } else {
            badgeEl.textContent = t('safetyBadgeBurst');
            badgeEl.classList.add(isActiveCritical ? 'is-danger' : 'is-warn');
          }
        } else if (status === 'approaching_quota') {
          badgeEl.textContent = t('safetyBadgeWarn');
          badgeEl.classList.add('is-warn');
        } else if (status === 'ok') {
          badgeEl.textContent = t('safetyBadgeOk');
          badgeEl.classList.add('is-ok');
        } else if (status === 'disabled') {
          badgeEl.textContent = t('safetyBadgeDisabled');
        } else if (status === 'no_safety_events') {
          badgeEl.textContent = t('safetyBadgeNoEvents');
        } else {
          badgeEl.textContent = t('safetyBadgeNotDetected');
        }
      }

      const hiddenPctStr = sr.hiddenSharePct !== null && sr.hiddenSharePct !== undefined ? `${sr.hiddenSharePct}%` : '--%';
      const avgCharsLabel = formatSafetyAvgCharsByLang(w.heavyAvgChars || 0, currentLang);
      const hasFalseAlarmPct =
        Number(w.heavyTriggeredFalse || 0) > 0 &&
        w.heavyFalseAlarmRatePct !== null &&
        w.heavyFalseAlarmRatePct !== undefined;
      const falsePart = hasFalseAlarmPct ? t('safetyFalsePart', { pct: w.heavyFalseAlarmRatePct }) : '';

      let inlineText = '';
      let adviceText = '';
      let diagMsg = '';
      if (status === '429_avalanche') {
        inlineText = t('safetyInlineAvalanche', { h: winH, heavy: heavyCount });
        adviceText = t('safetyAdviceAvalanche');
        diagMsg = t('safetyDiagAvalanche', { h: winH, c429, heavy: heavyCount, avgChars: avgCharsLabel });
      } else if (status === 'heavy_burst_or_sticky' && isCalmRecently) {
        inlineText = t('safetyInlineCalm', { h: winH, heavy: heavyCount, hidden: hiddenPctStr });
        adviceText = t('safetyAdviceCalm');
        diagMsg = t('safetyDiagCalm', { h: winH, heavy: heavyCount, falsePart, avgChars: avgCharsLabel });
      } else if (status === 'heavy_burst_or_sticky') {
        inlineText = t('safetyInlineBurst', { h: winH, recent: recent5m, heavy: heavyCount });
        adviceText = t('safetyAdviceBurst');
        diagMsg = t('safetyDiagBurst', { h: winH, recent: recent5m, heavy: heavyCount, falsePart, avgChars: avgCharsLabel });
      } else if (status === 'approaching_quota') {
        inlineText = t('safetyInlineWarn', {
          h: winH,
          pre: preCount.toLocaleString(),
          lim: preLimit.toLocaleString(),
          pct: prePct
        });
        adviceText = t('safetyAdviceWarn');
        diagMsg = t('safetyDiagWarn', {
          h: winH,
          pre: preCount.toLocaleString(),
          lim: preLimit.toLocaleString(),
          pct: prePct
        });
      } else if (status === 'ok') {
        inlineText = t('safetyInlineOk', {
          pre: preCount.toLocaleString(),
          lim: preLimit.toLocaleString(),
          h: winH,
          hidden: hiddenPctStr
        });
        adviceText = t('safetyAdviceOk');
        diagMsg = t('safetyDiagOk', {
          h: winH,
          pre: preCount.toLocaleString(),
          lim: preLimit.toLocaleString(),
          heavy: heavyCount
        });
      } else if (status === 'no_safety_events') {
        inlineText = t('safetyInlineNoEvents', {
          files: Number(src.filesScanned || 0),
          h: winH
        });
        adviceText = t('safetyAdviceQuiet');
        diagMsg = inlineText;
      } else if (status === 'disabled') {
        inlineText = t('safetyInlineDisabled');
        adviceText = '';
        diagMsg = inlineText;
      } else {
        inlineText = t('safetyInlineNotDetected');
        adviceText = t('safetyAdviceQuiet');
        diagMsg = inlineText;
      }

      const shouldExpand = safetyUserExpanded !== null ? safetyUserExpanded : isAlerting;
      if (inlineEl) {
        inlineEl.textContent = inlineText;
        if (inlineEl.classList) {
          if (shouldExpand) inlineEl.classList.add('hidden');
          else inlineEl.classList.remove('hidden');
        }
      }
      if (detailsEl && detailsEl.classList) {
        if (shouldExpand) detailsEl.classList.remove('hidden');
        else detailsEl.classList.add('hidden');
      }
      if (toggleBtn) {
        toggleBtn.textContent = shouldExpand ? t('safetyHideBtn') : t('safetyDetailsBtn');
      }

      if (adviceEl) {
        adviceEl.textContent = adviceText;
        if (adviceEl.classList) {
          if (adviceText) adviceEl.classList.remove('hidden');
          else adviceEl.classList.add('hidden');
        }
      }
      if (diagEl) diagEl.textContent = diagMsg;

      if (preEl) {
        preEl.textContent = `${preCount.toLocaleString()} / ${preLimit.toLocaleString()}`;
      }
      if (preSubEl) {
        preSubEl.textContent = t(prePct >= 80 ? 'safetyPreSubWarn' : 'safetyPreSubOk', { pct: prePct });
      }
      if (heavyEl) {
        heavyEl.textContent = t('safetyHeavyCountFmt', { count: heavyCount });
      }
      if (heavySubEl) {
        if (hasFalseAlarmPct) {
          heavySubEl.textContent = t('safetyFalseAlarmFmt', {
            pct: w.heavyFalseAlarmRatePct,
            avgChars: avgCharsLabel
          });
        } else {
          heavySubEl.textContent = t('safetyAvgCharsFmt', { avgChars: avgCharsLabel });
        }
      }
      if (hiddenEl) {
        hiddenEl.textContent = hiddenPctStr;
      }
      if (hiddenSubEl) {
        hiddenSubEl.textContent = t('safetyReqsFmt', {
          hidden: Number(sr.hiddenTotal || 0).toLocaleString(),
          total: Number(sr.total || 0).toLocaleString()
        });
      }
      if (kpi429El) {
        const durLabel = formatHumanSafetyDuration(w.totalLatencySec || 0, currentLang);
        kpi429El.textContent = c429 > 0 ? t('safetyWaitWith429Fmt', { dur: durLabel, c429 }) : durLabel;
      }
      if (kpi429SubEl) {
        kpi429SubEl.textContent = t('safetyEstTokFmt', {
          low: formatSafetyTokensByLang(w.estimatedHiddenInputTokensLow || 0, currentLang),
          high: formatSafetyTokensByLang(w.estimatedHiddenInputTokensHigh || 0, currentLang)
        });
      }

      if (reasonsEl) {
        const reasons = Array.isArray(data.triggerReasons) ? data.triggerReasons.slice(0, 6) : [];
        if (reasons.length > 0) {
          reasonsEl.innerHTML = reasons
            .map((r) => {
              const label = formatSafetyReasonLabel(r.reason, currentLang);
              return `<span class="safety-reason-chip" title="${escapeHtml(r.reason)}">${escapeHtml(label)} · ${Number(r.count)} (${Number(r.pct)}%)</span>`;
            })
            .join('');
          reasonsEl.classList.remove('hidden');
        } else {
          reasonsEl.innerHTML = '';
          reasonsEl.classList.add('hidden');
        }
      }

      if (restartEl) {
        const truncs = Number(src.restartTruncationsDetected || 0);
        if (truncs > 0) {
          restartEl.textContent = t('safetyRestartNote', {
            count: truncs,
            h: winH
          });
          restartEl.classList.remove('hidden');
        } else {
          restartEl.textContent = '';
          restartEl.classList.add('hidden');
        }
      }

      if (handoffBtn && handoffBtn.classList) {
        if (isAlerting) handoffBtn.classList.remove('hidden');
        else handoffBtn.classList.add('hidden');
      }

      renderSafetyDesktopNotifyChip(data.desktopNotify);
      renderSafetyContextSynergyTip();
    }

    function renderSafetyDesktopNotifyChip(info) {
      const btn = document.getElementById('safety-notify-btn');
      if (!btn) return;
      const enabled = Boolean(info && info.enabled === true);
      btn.dataset.enabled = enabled ? '1' : '0';
      btn.textContent = enabled ? t('safetyNotifyOn') : t('safetyNotifyOff');
      btn.classList.remove('is-on');
      if (enabled) btn.classList.add('is-on');
      const isEnvLocked = info && info.source === 'env';
      btn.disabled = Boolean(isEnvLocked);
    }

    async function toggleSafetyDesktopNotify() {
      const btn = document.getElementById('safety-notify-btn');
      const curEnabled = btn ? btn.dataset.enabled === '1' : Boolean(cachedSafetyAudit?.desktopNotify?.enabled);
      try {
        const res = await apiFetch('/api/safety-audit', {
          method: 'POST',
          body: JSON.stringify({ setDesktopNotify: !curEnabled })
        });
        if (!res.ok) return;
        const sa = await res.json();
        cachedSafetyAudit = sa;
        renderSafetyAuditCard(sa);
      } catch {}
    }

    function renderSafetyContextSynergyTip() {
      const tipEl = document.getElementById('kv-safety-synergy-tip');
      if (!tipEl || !tipEl.classList) return;
      const curTokens = Number(cachedKv?.currentContextTokens || 0);
      const winTokens = Number(cachedKv?.modelProfile?.windowTokens || 200000);
      const pct = winTokens > 0 ? (curTokens / winTokens) * 100 : 0;
      const isLongChat = Boolean(cachedKv && cachedKv.transcriptFound && (curTokens >= 120000 || pct >= 60));

      const sa = cachedSafetyAudit;
      const heavyCnt = Number(sa?.window?.heavyReviewCount || 0);
      const hiddenPct = Number(sa?.streamRequests?.hiddenSharePct || 0);
      const isSafetyHeavy = Boolean(
        sa &&
          (sa.status === '429_avalanche' ||
            sa.status === 'heavy_burst_or_sticky' ||
            heavyCnt >= 3 ||
            hiddenPct >= 40)
      );

      if (isLongChat && isSafetyHeavy) {
        tipEl.textContent = t('safetySynergyTip', { curK: Math.round(curTokens / 1000) });
        tipEl.classList.remove('hidden');
      } else {
        tipEl.textContent = '';
        tipEl.classList.add('hidden');
      }
    }

    function toggleSafetyAuditDetails() {
      const detailsEl = document.getElementById('safety-details-body');
      const isHidden = detailsEl && detailsEl.classList && typeof detailsEl.classList.contains === 'function'
        ? detailsEl.classList.contains('hidden')
        : true;
      safetyUserExpanded = isHidden;
      if (cachedSafetyAudit) {
        renderSafetyAuditCard(cachedSafetyAudit);
      } else if (detailsEl && detailsEl.classList) {
        if (isHidden) detailsEl.classList.remove('hidden');
        else detailsEl.classList.add('hidden');
      }
    }

    function scheduleInitialSafetyAudit() {
      if (safetyAuditInitDone) return;
      safetyAuditInitDone = true;
      safetyAuditTimer = setTimeout(() => {
        safetyAuditTimer = null;
        if (typeof document === 'undefined' || document.hidden !== true) {
          return refreshSafetyAudit(false);
        }
      }, 400);
    }

    async function refreshSafetyAudit(force = true) {
      lastSafetyAuditFetchMs = Date.now();
      try {
        const res = await apiFetch('/api/safety-audit', {
          method: 'POST',
          body: JSON.stringify({ forceRefresh: Boolean(force) })
        });
        if (!res.ok) return;
        const sa = await res.json();
        cachedSafetyAudit = sa;
        renderSafetyAuditCard(sa);
      } catch {}
    }

    async function openSafetyHandoffBrief() {
      safetyHandoffGuided = true;
      safetyHandoffAutoCopied = false;
      toggleHandoffDrawer(true);
      await loadHandoffBrief({ forceRefresh: true });
      const md = cachedHandoffSnapshot?.markdown || '';
      if (md) {
        try {
          safetyHandoffAutoCopied = Boolean(await copyTextToClipboard(md));
        } catch {
          safetyHandoffAutoCopied = false;
        }
      }
      renderHandoffWarmthHint();
    }

    async function copySafetyAuditReport() {
      const fb = document.getElementById('safety-action-feedback');
      try {
        const res = await apiFetch('/api/safety-audit', {
          method: 'POST',
          body: JSON.stringify({ includeMarkdown: true })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const sa = await res.json();
        const md = typeof sa.markdown === 'string' && sa.markdown ? sa.markdown : JSON.stringify(sa, null, 2);
        const ok = await copyTextToClipboard(md);
        if (fb) {
          fb.textContent = ok ? t('safetyCopied') : t('safetyCopyFailed');
          fb.classList.remove('hidden');
          setTimeout(() => fb.classList.add('hidden'), 2600);
        }
      } catch {
        if (fb) {
          fb.textContent = t('safetyCopyFailed');
          fb.classList.remove('hidden');
          setTimeout(() => fb.classList.add('hidden'), 2600);
        }
      }
    }

    function updateFeaturePill(elId, label, enabled) {
      const btn = document.getElementById(elId);
      if (!btn) return;
      btn.dataset.enabled = enabled ? '1' : '0';
      const sep = currentLang === 'zh' ? '：' : ': ';
      btn.className = enabled ? 'toggle-chip is-on' : 'toggle-chip';
      btn.innerText = `${label}${sep}${enabled ? t('stateOn') : t('stateOff')}`;
    }

    async function toggleCliFilter() {
      ++refreshSeq;
      const mutScope = currentScope;
      const btn = document.getElementById('toggle-cli-filter-btn');
      const prev = btn?.dataset.enabled === '1';
      const next = !prev;
      updateFeaturePill('toggle-cli-filter-btn', t('cliFilterLabel'), next);
      const convId = getActiveConversationId();
      try {
        const res = await apiFetch('/api/cli-filter', {
          method: 'POST',
          body: JSON.stringify({ enabled: next, scope: mutScope, conversationId: convId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        refreshData(false);
      } catch (e) {
        console.error(e);
        if (currentScope === mutScope) updateFeaturePill('toggle-cli-filter-btn', t('cliFilterLabel'), prev);
      }
    }

    async function toggleReadDedup() {
      ++refreshSeq;
      const mutScope = currentScope;
      const btn = document.getElementById('toggle-read-dedup-btn');
      const prev = btn?.dataset.enabled === '1';
      const next = !prev;
      updateFeaturePill('toggle-read-dedup-btn', t('readDedupLabel'), next);
      const convId = getActiveConversationId();
      try {
        const res = await apiFetch('/api/read-dedup', {
          method: 'POST',
          body: JSON.stringify({ enabled: next, scope: mutScope, conversationId: convId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        refreshData(false);
      } catch (e) {
        console.error(e);
        if (currentScope === mutScope) updateFeaturePill('toggle-read-dedup-btn', t('readDedupLabel'), prev);
      }
    }

    function fmtSec(sec) {
      if (sec === null || sec === undefined) return '--';
      const s = Math.max(0, Math.round(sec));
      if (s >= 3600) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
      }
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m > 0 ? `${m}m ${r}s` : `${r}s`;
    }

    function fmtUsd(val) {
      const n = Number(val);
      if (!Number.isFinite(n) || n === 0) return '$0.00';
      const abs = Math.abs(n);
      const sign = n < 0 ? '-' : '';
      if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
      return `${sign}$${abs.toFixed(2)}`;
    }

    function resolveGhostRecommendationText(ghost) {
      if (!ghost) return '';
      if (ghost.recommendationCode === 'raise_to_host_45k') return t('ghostRecRaise45k');
      if (ghost.recommendationCode === 'use_outlines_or_exempt') return t('ghostRecAtHostCap');
      if (typeof ghost.recommendation === 'string' && ghost.recommendation) {
        if (ghost.recommendation.includes('switching to 45 KB')) return t('ghostRecRaise45k');
        if (ghost.recommendation.includes('45 KB host cap') || ghost.recommendation.includes('switching to 64 KB')) {
          return t('ghostRecAtHostCap');
        }
        return ghost.recommendation;
      }
      return '';
    }

    function renderGhostEfficiency(ghost) {
      cachedGhost = ghost || null;
      const rowEl = document.getElementById('kv-ghost-row');
      const effEl = document.getElementById('kv-ghost-efficiency');
      const recEl = document.getElementById('kv-ghost-recalls');
      const tipEl = document.getElementById('kv-ghost-recommendation');
      if (!rowEl) return;
      if (!ghost || !ghost.totalBlocked) {
        rowEl.classList.add('hidden');
        return;
      }
      rowEl.classList.remove('hidden');
      const effPct = Math.round(Number(ghost.evictionEfficiency ?? 1) * 100);
      const isHostCapNote = ghost.recommendationCode === 'use_outlines_or_exempt';
      if (effEl) {
        effEl.innerText = t('guardEfficiency', { pct: effPct });
        effEl.className = effPct < 65 && !isHostCapNote ? 'val-warn' : 'val-ok';
      }
      if (recEl) {
        recEl.innerText = t('guardRecalls', { rec: ghost.ghostRecalls || 0, tot: ghost.totalBlocked });
      }
      if (tipEl) {
        const recText = resolveGhostRecommendationText(ghost);
        if (recText) {
          tipEl.innerText = recText;
          tipEl.className = isHostCapNote ? 'muted-note' : 'muted-note val-warn';
          if (tipEl.classList) {
            tipEl.classList.remove('hidden');
            if (isHostCapNote && typeof tipEl.classList.remove === 'function') tipEl.classList.remove('val-warn');
            else if (!isHostCapNote && typeof tipEl.classList.add === 'function') tipEl.classList.add('val-warn');
          }
        } else {
          tipEl.innerText = '';
          tipEl.className = 'hidden muted-note val-warn';
          if (tipEl.classList && typeof tipEl.classList.add === 'function') tipEl.classList.add('hidden');
        }
      }
    }

    function updateHandoffButtonStyle(compactAdvice) {
      cachedCompactAdvice = String(compactAdvice || 'none');
      const btn = document.getElementById('kv-handoff-btn');
      const cue = document.getElementById('kv-handoff-cue');
      if (!btn) return;
      const advice = cachedCompactAdvice;
      if (advice === 'critical_compact') {
        btn.className = 'btn btn-secondary btn-sm is-warn';
        btn.title = t('handoffTipCritical');
        if (cue) {
          cue.textContent = t('handoffCueCompact');
          cue.className = 'cue-tag';
        }
      } else if (advice === 'opportunistic_cold_compact') {
        btn.className = 'btn btn-secondary btn-sm is-warn';
        btn.title = t('handoffTipCold');
        if (cue) {
          cue.textContent = t('handoffCueCold');
          cue.className = 'cue-tag';
        }
      } else {
        btn.className = 'btn btn-secondary btn-sm';
        btn.title = t('handoffTipDefault');
        if (cue) {
          cue.textContent = '';
          cue.className = 'hidden';
        }
      }
    }

    function stopKvTtlTimer() {
      if (kvTtlTimer !== null) {
        clearInterval(kvTtlTimer);
        kvTtlTimer = null;
      }
    }

    function computeLocalTtlSnapshot(state, nowMs = Date.now()) {
      if (!state || !Number.isFinite(state.lastPlannerMs) || !(state.cacheTtlSec > 0)) {
        return null;
      }
      const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
      const offset = Number.isFinite(state.clockOffsetMs) ? state.clockOffsetMs : 0;
      const estServerNow = safeNow + offset;
      const elapsedExact = Math.max(0, (estServerNow - state.lastPlannerMs) / 1000);
      const idleSeconds = Math.max(0, Math.round(elapsedExact));
      const remainingExact = Math.max(0, state.cacheTtlSec - elapsedExact);
      const remainingSec = Math.max(0, state.cacheTtlSec - idleSeconds);
      const pct = Math.max(0, Math.min(100, (remainingExact / state.cacheTtlSec) * 100));
      let ttlStatus = 'warm';
      if (idleSeconds >= state.cacheTtlSec || remainingSec <= 0) ttlStatus = 'expired';
      else if (remainingSec <= 60) ttlStatus = 'expiring';
      let cacheTemperature = 'cold';
      if (idleSeconds < Math.min(60, state.cacheTtlSec)) cacheTemperature = 'hot';
      else if (idleSeconds < state.cacheTtlSec) cacheTemperature = 'warm';
      return {
        idleSeconds,
        remainingSec,
        cacheTtlSec: state.cacheTtlSec,
        pct: Number(pct.toFixed(2)),
        ttlStatus,
        cacheTemperature
      };
    }

    function isCurrentConversationTurnActive(kvOverride = null) {
      if (cachedWatchdog && cachedWatchdog.enabled === false) {
        return false;
      }
      if (kvOverride && kvOverride.conversationActive === true) {
        return true;
      }
      const wdActive = cachedWatchdog?.enabled !== false;
      const curWd = wdActive ? (cachedWatchdog?.current || null) : null;
      const activeId = getActiveConversationId();
      const targetId = activeId || kvOverride?.resolvedConversationId || cachedKv?.resolvedConversationId || '';
      const sessions = wdActive && Array.isArray(cachedWatchdog?.sessions) ? cachedWatchdog.sessions : [];
      if (targetId) {
        const activeChild = sessions.some(
          (s) =>
            s &&
            s.isSubagent &&
            (s.parentConversationId === targetId || s.rootSessionId === targetId) &&
            (s.phase !== 'IDLE' || s.subphase === 'stopped_bg_pending')
        );
        if (activeChild) return true;
      }
      const hasActiveChildInWd = Boolean(
        targetId &&
          sessions.some(
            (s) =>
              s &&
              s.conversationId !== targetId &&
              ((s.phase && s.phase !== 'IDLE') || s.subphase === 'stopped_bg_pending') &&
              (s.parentConversationId === targetId || s.rootSessionId === targetId)
          )
      );
      if (hasActiveChildInWd) return true;
      if (curWd && (!targetId || curWd.conversationId === targetId)) {
        if (curWd.phase && curWd.phase !== 'IDLE') return true;
        if (curWd.subphase === 'stopped_bg_pending') return true;
        if (curWd.phase === 'IDLE') return Boolean(cachedKv?.conversationActive === true);
      }
      if (targetId) {
        const matchedSess = sessions.find((s) => s && s.conversationId === targetId);
        if (matchedSess) {
          if (matchedSess.phase && matchedSess.phase !== 'IDLE') return true;
          if (matchedSess.subphase === 'stopped_bg_pending') return true;
          if (matchedSess.phase === 'IDLE') return Boolean(cachedKv?.conversationActive === true);
        }
      }
      return Boolean(wdActive && (cachedKv?.conversationActive === true || kvTtlState?.conversationActive === true));
    }

    function renderLocalTtlCountdown() {
      const rowEl = document.getElementById('kv-ttl-bar-row');
      const labelEl = document.getElementById('kv-ttl-bar-label');
      const textEl = document.getElementById('kv-ttl-bar-text');
      const trackEl = document.getElementById('kv-ttl-bar-track');
      const fillEl = document.getElementById('kv-ttl-bar-fill');
      const ttlEl = document.getElementById('kv-ttl-badge');
      const tempEl = document.getElementById('kv-temp-badge');

      const snap = computeLocalTtlSnapshot(kvTtlState);
      if (!snap || !kvTtlState) {
        if (rowEl) rowEl.classList.add('hidden');
        if (fillEl) fillEl.style.width = '0%';
        renderManualWarmControls(null, false);
        stopKvTtlTimer();
        return;
      }

      if (rowEl) rowEl.classList.remove('hidden');
      const hasCustomTtlSrc = Boolean(kvTtlState.ttlSource && kvTtlState.ttlSource !== 'profile');
      const ttlSrcLabel = hasCustomTtlSrc ? fmtSourceLabel(kvTtlState.ttlSource) : '';
      const ttlSrcTag = ttlSrcLabel ? (currentLang === 'zh' ? `（${ttlSrcLabel}）` : ` (${ttlSrcLabel})`) : '';
      if (labelEl) {
        labelEl.textContent = `${t('ttlBarLabel')}${ttlSrcTag}`;
      }

      const turnActive = isCurrentConversationTurnActive();
      if (turnActive) {
        if (fillEl) {
          fillEl.style.width = '100%';
          fillEl.className = 'ttl-fill is-active';
        }
        if (trackEl) trackEl.className = 'ttl-track is-active';
        if (textEl) {
          textEl.className = 'ttl-text-info';
          textEl.textContent = t('ttlActiveBar');
        }
        if (ttlEl) {
          ttlEl.className = 'meta-tag is-info';
          ttlEl.textContent = t('ttlActiveBadge');
        }
        if (tempEl && snap.cacheTemperature === 'cold') {
          tempEl.className = 'meta-tag is-info';
          tempEl.textContent = t('tempWarm');
        }
        if (cachedCompactAdvice === 'opportunistic_cold_compact') {
          updateHandoffButtonStyle('none');
        }
        renderManualWarmControls(snap, true);
        return;
      }

      if (snap.ttlStatus === 'expired') {
        if (fillEl) {
          fillEl.style.width = '0%';
          fillEl.className = 'ttl-fill is-expired';
        }
        if (trackEl) trackEl.className = 'ttl-track is-expired';
        if (textEl) {
          textEl.className = 'ttl-text-danger';
          textEl.textContent = t('ttlExpiredBar', { total: fmtSec(snap.cacheTtlSec), idle: fmtSec(snap.idleSeconds) });
        }
        if (ttlEl) {
          ttlEl.className = 'meta-tag is-danger';
          ttlEl.textContent = t('ttlExpiredBadge', { idle: fmtSec(snap.idleSeconds) });
        }
      } else if (snap.ttlStatus === 'expiring') {
        if (fillEl) {
          fillEl.style.width = `${snap.pct}%`;
          fillEl.className = 'ttl-fill is-expiring bg-amber-400';
        }
        if (trackEl) trackEl.className = 'ttl-track is-expiring';
        if (textEl) {
          textEl.className = 'ttl-text-warn';
          textEl.textContent = t('ttlExpiringBar', { rem: fmtSec(snap.remainingSec), total: fmtSec(snap.cacheTtlSec) });
        }
        if (ttlEl) {
          ttlEl.className = 'meta-tag is-warn';
          ttlEl.textContent = t('ttlLeftBadge', { rem: fmtSec(snap.remainingSec) });
        }
      } else {
        if (fillEl) {
          fillEl.style.width = `${snap.pct}%`;
          fillEl.className = 'ttl-fill';
        }
        if (trackEl) trackEl.className = 'ttl-track';
        if (textEl) {
          textEl.className = 'ttl-text-ok';
          textEl.textContent = t('ttlWarmBar', { rem: fmtSec(snap.remainingSec), total: fmtSec(snap.cacheTtlSec) });
        }
        if (ttlEl) {
          ttlEl.className = 'meta-tag is-info';
          ttlEl.textContent = t('ttlLeftBadge', { rem: fmtSec(snap.remainingSec) });
        }
      }

      if (tempEl) {
        if (snap.cacheTemperature === 'hot') {
          tempEl.className = 'meta-tag is-ok';
          tempEl.textContent = t('tempHot');
        } else if (snap.cacheTemperature === 'warm') {
          tempEl.className = 'meta-tag is-info';
          tempEl.textContent = t('tempWarm');
        } else {
          tempEl.className = 'meta-tag';
          tempEl.textContent = t('tempCold');
        }
      }

      if (snap.ttlStatus === 'expired' && kvTtlState.compactAdvice !== 'critical_compact' && kvTtlState.currentContextTokens >= kvTtlState.coldCompactTokens) {
        updateHandoffButtonStyle('opportunistic_cold_compact');
      }
      renderManualWarmControls(snap, false);
    }

    function syncKvTtlState(kv) {
      const alignedKa =
        kv?.ttlKeepalive && shouldAcceptKeepalivePayload(kv.ttlKeepalive) ? kv.ttlKeepalive : null;
      const useAlignedLeaseTiming = Boolean(
        alignedKa &&
          alignedKa.hasLease === true &&
          alignedKa.leasePhase === 'IDLE' &&
          alignedKa.leaseSubphase === 'stopped' &&
          Number.isFinite(Number(alignedKa.cacheOriginTs)) &&
          Number(alignedKa.cacheOriginTs) > 0 &&
          Number.isFinite(Number(alignedKa.effectiveTtlSec)) &&
          Number(alignedKa.effectiveTtlSec) > 0
      );
      const lastMs = useAlignedLeaseTiming
        ? Math.floor(Number(alignedKa.cacheOriginTs))
        : (kv && kv.lastPlannerAt ? Date.parse(kv.lastPlannerAt) : NaN);
      const ttlSec = useAlignedLeaseTiming
        ? Math.floor(Number(alignedKa.effectiveTtlSec))
        : Number(kv?.cacheTtlSec);
      const ctxTokens = Number(kv?.currentContextTokens || 0);
      if (!kv || !kv.transcriptFound || !kv.turnsWithUsage || !Number.isFinite(lastMs) || !(ttlSec > 0) || ctxTokens < 4000) {
        kvTtlState = null;
        stopKvTtlTimer();
        const rowEl = document.getElementById('kv-ttl-bar-row');
        const fillEl = document.getElementById('kv-ttl-bar-fill');
        if (rowEl) rowEl.classList.add('hidden');
        if (fillEl) fillEl.style.width = '0%';
        renderManualWarmControls(null, false);
        return;
      }
      const serverNow = Number(kv.serverNowMs);
      let clockOffsetMs;
      if (Number.isFinite(kv._clockOffsetMs)) {
        clockOffsetMs = kv._clockOffsetMs;
      } else {
        clockOffsetMs = Number.isFinite(serverNow) && serverNow > 0 ? serverNow - Date.now() : 0;
        kv._clockOffsetMs = clockOffsetMs;
      }
      kvTtlState = {
        lastPlannerMs: lastMs,
        cacheTtlSec: ttlSec,
        clockOffsetMs,
        currentContextTokens: ctxTokens,
        coldCompactTokens: Number(kv.coldCompactTokens) > 0 ? Number(kv.coldCompactTokens) : 60000,
        compactAdvice: kv.compactAdvice || 'none',
        conversationActive: kv.conversationActive === true,
        ttlSource: kv.ttlSource || 'profile',
        maxWarmHitGapSec: kv.maxWarmHitGapSec ?? null
      };
      renderLocalTtlCountdown();
      if (kvTtlTimer === null) {
        kvTtlTimer = setInterval(renderLocalTtlCountdown, 1000);
      }
    }

    async function copyTextToClipboard(text) {
      if (!text) return false;
      let copied = false;
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {}
      }
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = text;
        if (typeof ta.setAttribute === 'function') {
          ta.setAttribute('readonly', '');
        }
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        if (typeof ta.focus === 'function') ta.focus();
        if (typeof ta.select === 'function') ta.select();
        try {
          copied = Boolean(document.execCommand('copy'));
        } catch {
          copied = false;
        } finally {
          document.body.removeChild(ta);
        }
      }
      return copied;
    }

    function hasHandoffConfirmMeta(data) {
      return Boolean(
        data &&
          typeof data === 'object' &&
          (data.confirmedConversation !== undefined ||
            data.anchors !== undefined ||
            data.mode === 'agent')
      );
    }

    const CLIENT_CONV_ID_SECRET_RULES = [
      { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED:ANTHROPIC_KEY]' },
      { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED:OPENAI_KEY]' },
      { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED:STRIPE_KEY]' },
      { re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, replacement: '[REDACTED:GITHUB_TOKEN]' },
      { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: '[REDACTED:GOOGLE_API_KEY]' },
      { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED:AWS_ACCESS_KEY]' },
      { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, replacement: '[REDACTED:SLACK_TOKEN]' },
      { re: /\bhf_[A-Za-z0-9]{25,}\b/g, replacement: '[REDACTED:HF_TOKEN]' },
      { re: /\bnpm_[A-Za-z0-9]{30,}\b/g, replacement: '[REDACTED:NPM_TOKEN]' },
      { re: /\bpypi-[A-Za-z0-9_-]{30,}\b/g, replacement: '[REDACTED:PYPI_TOKEN]' },
      { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED:JWT]' }
    ];

    function redactConvIdForDisplayAnchor(id) {
      let out = String(id ?? '');
      for (const rule of CLIENT_CONV_ID_SECRET_RULES) {
        out = out.replace(rule.re, rule.replacement);
      }
      return out;
    }

    function flattenDisplayAnchorClient(val, maxBytes = 96) {
      if (val === null || val === undefined) return '';
      let s = String(val);
      if (typeof s.toWellFormed === 'function') {
        s = s.toWellFormed();
      }
      const flat = s
        .replace(/[\r\n\t\x00-\x1f\x7f-\x9f]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!flat) return '';
      // Confirmed conversationIds (^[A-Za-z0-9._-]+$) and [REDACTED:...] markers are pure ASCII.
      if (flat.length <= maxBytes) return flat;
      const suffix = maxBytes >= 16 ? '...' : '';
      const bodyCap = Math.max(0, maxBytes - suffix.length);
      return `${flat.slice(0, bodyCap)}${suffix}`;
    }

    function isConversationDisplayAnchorValid(anchorConvId, targetConv, redactionEnabled = true) {
      if (typeof anchorConvId !== 'string' || !anchorConvId) return false;
      if (!isSpecificConversationId(targetConv)) return false;
      const expectedRedacted = flattenDisplayAnchorClient(redactConvIdForDisplayAnchor(targetConv), 96);
      const expectedRaw = flattenDisplayAnchorClient(targetConv, 96);
      if (redactionEnabled === false) {
        return anchorConvId === expectedRaw;
      }
      return anchorConvId === expectedRedacted;
    }

    function isHandoffPayloadAttributionValid(
      rawData,
      {
        expectedScope = currentScope,
        expectedConfirmed = isCurrentConversationConfirmed(),
        expectedConfirmedConv = getConfirmedConversationId(),
        requireScope = false,
        requireDisplayAnchor = false
      } = {}
    ) {
      if (!rawData || typeof rawData !== 'object' || rawData.ok === false) {
        return false;
      }
      const targetScope = typeof expectedScope === 'string' && expectedScope ? expectedScope : currentScope;
      if (rawData.scope === undefined) {
        if (requireScope) {
          return false;
        }
      } else if (typeof rawData.scope !== 'string' || !rawData.scope || rawData.scope !== targetScope) {
        return false;
      }
      const expectConfirmed = Boolean(expectedConfirmed);
      const targetConv = expectConfirmed && typeof expectedConfirmedConv === 'string' ? expectedConfirmedConv : '';
      if (expectConfirmed && (targetScope !== 'conversation' || !isSpecificConversationId(targetConv))) {
        return false;
      }
      const anchorsObj = rawData.anchors && typeof rawData.anchors === 'object' ? rawData.anchors : null;
      const bothConfirmed =
        rawData.confirmedConversation === true &&
        Boolean(anchorsObj && anchorsObj.confirmed === true);
      if (expectConfirmed) {
        if (!bothConfirmed) {
          return false;
        }
        // 1. Full attribution ID check: exact match on payload's own conversationId required;
        //    display anchors and outer context can never substitute for a missing full ID.
        if (typeof rawData.conversationId !== 'string' || rawData.conversationId !== targetConv) {
          return false;
        }
        // 2. Display anchor check: validate against generator's active redaction setting + 96-byte truncation rules.
        const redactionEnabled = rawData.secretRedactionEnabled !== false;
        if (anchorsObj && anchorsObj.conversationId !== undefined) {
          if (!isConversationDisplayAnchorValid(anchorsObj.conversationId, targetConv, redactionEnabled)) {
            return false;
          }
        } else if (requireDisplayAnchor) {
          return false;
        }
        return true;
      }
      // Unconfirmed / aggregate / overview expectation: reject any confirmation claim or conversation anchor,
      // while preserving legacy anchorless (pre-agent) brief compatibility.
      if (
        Boolean(rawData.confirmedConversation) ||
        Boolean(anchorsObj?.confirmed) ||
        Boolean(anchorsObj?.conversationId)
      ) {
        return false;
      }
      return true;
    }

    function getMatchingRescueBrief() {
      if (currentScope !== 'conversation') return null;
      if (!cachedWatchdog || cachedWatchdog.enabled === false || cachedWatchdog._hostEpoch !== hostSwitchEpoch) {
        return null;
      }
      if (
        cachedWatchdog.scope !== undefined &&
        (typeof cachedWatchdog.scope !== 'string' || cachedWatchdog.scope !== 'conversation')
      ) {
        return null;
      }
      const cur = cachedWatchdog.current || null;
      const brief = cur?.rescueBrief || null;
      if (!brief || typeof brief !== 'object' || typeof brief.markdown !== 'string' || !brief.markdown) return null;
      const confirmedId = getConfirmedConversationId();
      if (confirmedId) {
        if (!cur.conversationId || cur.conversationId !== confirmedId) {
          return null;
        }
        if (
          !isHandoffPayloadAttributionValid(brief, {
            expectedScope: 'conversation',
            expectedConfirmed: true,
            expectedConfirmedConv: confirmedId,
            requireScope: false,
            requireDisplayAnchor: true
          })
        ) {
          return null;
        }
        return {
          ...brief,
          conversationId: brief.conversationId,
          hasStallContext: true,
          confirmedConversation: true
        };
      }
      // Without a confirmed conversation, never expose rich v1.7.3 rescue briefs,
      // unbound host-tab briefs, explicit reserved/unsafe native IDs, or inferred-only fallback briefs.
      const nativeId = getNativeHostConversationId();
      const isRichBrief = hasHandoffConfirmMeta(brief);
      if (window.sidecar || (nativeId && !isSpecificConversationId(nativeId)) || inferredFallbackConvId || isRichBrief) {
        return null;
      }
      if (
        !isHandoffPayloadAttributionValid(brief, {
          expectedScope: 'conversation',
          expectedConfirmed: false,
          expectedConfirmedConv: '',
          requireScope: false,
          requireDisplayAnchor: false
        })
      ) {
        return null;
      }
      // Legacy v1.4 standalone fallback (pre-agent brief without anchors)
      return {
        ...brief,
        conversationId: brief.conversationId || cur.conversationId || '',
        hasStallContext: true,
        confirmedConversation: false
      };
    }

    function renderHandoffWarmthHint() {
      const hintEl = document.getElementById('kv-handoff-warmth-hint');
      if (!hintEl) return;
      if (handoffDrawerTargetedAlert && handoffDrawerTargetedEnded) {
        hintEl.className = 'handoff-warmth-hint is-warn';
        hintEl.textContent = t('handoffWarmthAlertEnded');
        return;
      }
      const curWd = cachedWatchdog?.current || null;
      const alignedStall = Boolean(
        isWatchdogIncidentAlignedWithTarget({ requireActive: true }) &&
          curWd &&
          (curWd.severity === 'stalled' || curWd.severity === 'suspect')
      );
      const snapCurrent = isHandoffSnapshotCurrent(cachedHandoffSnapshot);
      const isStalled = Boolean(
        alignedStall ||
          (snapCurrent &&
            (cachedHandoffSnapshot?.hasStallContext || cachedHandoffSnapshot?.anchors?.stallSummary))
      );
      const isConfirmed = Boolean(
        cachedHandoffSnapshot
          ? cachedHandoffSnapshot.confirmedConversation === true
          : isCurrentConversationConfirmed()
      );
      let temp = cachedKv?.cacheTemperature || '';
      if (kvTtlState) {
        const snap = computeLocalTtlSnapshot(kvTtlState, Date.now());
        if (snap && snap.cacheTemperature) temp = snap.cacheTemperature;
      }
      if (isStalled) {
        hintEl.className = 'handoff-warmth-hint is-danger';
        hintEl.textContent = t('handoffWarmthStall');
      } else if (safetyHandoffGuided) {
        hintEl.className = 'handoff-warmth-hint is-warn';
        hintEl.textContent = safetyHandoffAutoCopied ? t('safetyHandoffStepCopied') : t('safetyHandoffStepManual');
      } else if (!isConfirmed) {
        hintEl.className = 'handoff-warmth-hint is-warn';
        hintEl.textContent = t('handoffWarmthOverview');
      } else if (temp === 'cold') {
        hintEl.className = 'handoff-warmth-hint';
        hintEl.textContent = t('handoffWarmthCold');
      } else if (temp === 'hot' || temp === 'warm') {
        hintEl.className = 'handoff-warmth-hint';
        hintEl.textContent = t('handoffWarmthWarm');
      } else {
        hintEl.className = 'handoff-warmth-hint';
        hintEl.textContent = t('handoffWarmthDefault');
      }
    }

    function computeWatchdogIncidentKey(cur) {
      if (!cur || typeof cur !== 'object' || cur.phase === 'IDLE') return '';
      const sev = cur.rawSeverity || cur.severity || '';
      if (sev !== 'suspect' && sev !== 'stalled') return '';
      if (typeof cur.incidentKey === 'string' && cur.incidentKey) {
        return cur.incidentKey;
      }
      if (typeof cur.rescueBrief?.incidentKey === 'string' && cur.rescueBrief.incidentKey) {
        return cur.rescueBrief.incidentKey;
      }
      const cid = typeof cur.conversationId === 'string' ? cur.conversationId : '';
      const ts = cur.phaseChangedTs || cur.startedTs || '';
      const phase = cur.phase || '';
      const cause = cur.diagnosis?.causeId || 'unknown';
      return cid ? `${cid}:${ts}:${phase}:${sev}:${cause}` : '';
    }

    function getCurrentWatchdogIncidentKey() {
      if (!cachedWatchdog || cachedWatchdog.enabled === false) return '';
      if (!isWatchdogIncidentAlignedWithTarget({ requireActive: false })) return '';
      return computeWatchdogIncidentKey(cachedWatchdog.current || null);
    }

    function getCurrentWatchdogCardConversationId() {
      if (!cachedWatchdog || cachedWatchdog.enabled === false) return '';
      if (!isWatchdogIncidentAlignedWithTarget({ requireActive: false })) return '';
      const cid = cachedWatchdog.current?.conversationId;
      return typeof cid === 'string' ? cid : '';
    }

    function isWatchdogIncidentAlignedWithTarget({ requireActive = false } = {}) {
      if (!cachedWatchdog || cachedWatchdog.enabled === false || cachedWatchdog._hostEpoch !== hostSwitchEpoch) {
        return false;
      }
      const cur = cachedWatchdog.current || null;
      if (!cur || !cur.conversationId) return false;
      if (requireActive && cur.phase === 'IDLE') return false;
      if (currentScope !== 'conversation') {
        const wdScope = typeof cachedWatchdog.scope === 'string' && cachedWatchdog.scope ? cachedWatchdog.scope : 'conversation';
        return wdScope === currentScope;
      }
      if (
        cachedWatchdog.scope !== undefined &&
        (typeof cachedWatchdog.scope !== 'string' || cachedWatchdog.scope !== 'conversation')
      ) {
        return false;
      }
      const confirmedId = getConfirmedConversationId();
      if (confirmedId) {
        return cur.conversationId === confirmedId;
      }
      if (window.sidecar) {
        return false;
      }
      const nativeId = getNativeHostConversationId();
      if (nativeId && !isSpecificConversationId(nativeId)) {
        return false;
      }
      const activeId = selectedConvOverride || inferredFallbackConvId || '';
      return !activeId || cur.conversationId === activeId;
    }

    function getActiveWatchdogCardTarget() {
      if (!isWatchdogIncidentAlignedWithTarget({ requireActive: true })) {
        return { stallConversationId: '', incidentKey: '' };
      }
      const stallConversationId = getCurrentWatchdogCardConversationId();
      const incidentKey = getCurrentWatchdogIncidentKey();
      if (!stallConversationId || !incidentKey) {
        return { stallConversationId: '', incidentKey: '' };
      }
      return { stallConversationId, incidentKey };
    }

    function updateWatchdogIncidentButtons() {
      const aligned = isWatchdogIncidentAlignedWithTarget({ requireActive: true });
      for (const id of ['wd-copy-rescue-btn', 'wd-open-rescue-btn', 'wd-snooze-btn', 'wd-clear-btn']) {
        const el = document.getElementById(id);
        if (el) el.disabled = !aligned;
      }
    }

    function isHandoffSnapshotCurrent(snap) {
      if (handoffLoading || !snap || typeof snap !== 'object') return false;
      if (typeof snap.markdown !== 'string' || !snap.markdown) return false;
      if (snap._hostEpoch !== undefined && snap._hostEpoch !== hostSwitchEpoch) return false;
      const expectedConfirmed = isCurrentConversationConfirmed();
      const expectedConv = getConfirmedConversationId();
      if (
        !isHandoffPayloadAttributionValid(snap, {
          expectedScope: currentScope,
          expectedConfirmed,
          expectedConfirmedConv: expectedConv,
          requireScope: true,
          requireDisplayAnchor: true
        })
      ) {
        return false;
      }
      const snapScope = typeof snap.scope === 'string' && snap.scope ? snap.scope : 'conversation';
      if (snapScope !== currentScope) return false;
      if (snap.confirmedConversation !== expectedConfirmed) return false;
      const curIncident = getCurrentWatchdogIncidentKey();
      if (snapScope !== 'conversation') {
        if (snap.stallConversationId) {
          if (!isWatchdogIncidentAlignedWithTarget({ requireActive: true })) return false;
          if (!curIncident) return false;
          if (getCurrentWatchdogCardConversationId() !== snap.stallConversationId) return false;
          if ((snap.incidentKey || '') !== curIncident) return false;
          return true;
        }
        if (snap._cardIncidentKey !== undefined && (snap._cardIncidentKey || '') !== curIncident) {
          return false;
        }
        return true;
      }
      if ((snap.incidentKey || '') !== curIncident) {
        return false;
      }
      return true;
    }

    function updateHandoffActionButtons() {
      const copyBtn = document.getElementById('kv-handoff-copy-btn');
      const promptBtn = document.getElementById('kv-handoff-prompt-btn');
      const snap = cachedHandoffSnapshot;
      const hasFact = isHandoffSnapshotCurrent(snap);
      const hasPrompt =
        hasFact &&
        snap.confirmedConversation === true &&
        Boolean(snap.anchors && snap.anchors.confirmed === true);
      if (copyBtn) {
        copyBtn.disabled = !hasFact;
        copyBtn.title = t('handoffCopyTip');
        if (handoffCopyResetTimer === null) {
          copyBtn.textContent = t('copyBriefBtn');
        }
      }
      if (promptBtn) {
        promptBtn.disabled = !hasPrompt;
        promptBtn.title = hasPrompt ? t('handoffPromptTip') : t('handoffPromptDisabledOverview');
        if (handoffPromptCopyResetTimer === null) {
          promptBtn.textContent = t('copyPromptBtn');
        }
      }
    }

    function isPendingServerAheadSyncMatch(nextIncidentKey, nextStallConvId = '') {
      const pending = pendingServerAheadSync;
      if (!pending || pending.seq !== handoffFetchSeq) return false;
      return (
        currentScope === pending.scope &&
        hostSwitchEpoch === pending.hostEpoch &&
        isCurrentConversationConfirmed() === pending.confirmed &&
        getConfirmedConversationId() === pending.confirmedConv &&
        (!pending.stallConversationId || nextStallConvId === pending.stallConversationId) &&
        nextIncidentKey === pending.incidentKey
      );
    }

    function renderTargetedHandoffAlertEndedUi() {
      const previewEl = document.getElementById('kv-handoff-preview');
      const metaEl = document.getElementById('kv-handoff-meta');
      if (previewEl) {
        previewEl.textContent = t('handoffAlertEndedBody');
      }
      if (metaEl) {
        metaEl.textContent = t('handoffAlertEndedMeta');
      }
      renderHandoffWarmthHint();
      updateHandoffActionButtons();
    }

    function markTargetedHandoffAlertEnded() {
      ++handoffFetchSeq;
      ++rescueCopySeq;
      handoffLoading = false;
      handoffInFlightRequest = null;
      pendingServerAheadSync = null;
      cachedHandoffSnapshot = null;
      cachedHandoffData = null;
      lastHandoffMarkdown = '';
      if (handoffCopyResetTimer !== null) {
        clearTimeout(handoffCopyResetTimer);
        handoffCopyResetTimer = null;
      }
      if (handoffPromptCopyResetTimer !== null) {
        clearTimeout(handoffPromptCopyResetTimer);
        handoffPromptCopyResetTimer = null;
      }
      handoffDrawerTargetedAlert = true;
      handoffDrawerTargetedEnded = true;
      renderTargetedHandoffAlertEndedUi();
    }

    function clearHandoffSnapshot({ resetPreview = true, reloadIfOpen = false } = {}) {
      ++handoffFetchSeq;
      ++rescueCopySeq;
      handoffLoading = false;
      handoffInFlightRequest = null;
      pendingServerAheadSync = null;
      cachedHandoffSnapshot = null;
      cachedHandoffData = null;
      lastHandoffMarkdown = '';
      if (handoffCopyResetTimer !== null) {
        clearTimeout(handoffCopyResetTimer);
        handoffCopyResetTimer = null;
      }
      if (handoffPromptCopyResetTimer !== null) {
        clearTimeout(handoffPromptCopyResetTimer);
        handoffPromptCopyResetTimer = null;
      }
      const isTargetedAggregateDrawer = Boolean(
        handoffDrawerOpen && handoffDrawerTargetedAlert && currentScope !== 'conversation'
      );
      const nextTarget = isTargetedAggregateDrawer
        ? getActiveWatchdogCardTarget()
        : { stallConversationId: '', incidentKey: '' };
      if (isTargetedAggregateDrawer && !nextTarget.stallConversationId) {
        handoffDrawerTargetedEnded = true;
        if (resetPreview) {
          renderTargetedHandoffAlertEndedUi();
        } else {
          renderHandoffWarmthHint();
          updateHandoffActionButtons();
        }
        return;
      }
      if (isTargetedAggregateDrawer && nextTarget.stallConversationId) {
        handoffDrawerTargetedConvId = nextTarget.stallConversationId;
        handoffDrawerTargetedEnded = false;
      } else {
        handoffDrawerTargetedEnded = false;
      }
      if (resetPreview) {
        const previewEl = document.getElementById('kv-handoff-preview');
        const metaEl = document.getElementById('kv-handoff-meta');
        if (previewEl) {
          previewEl.textContent = reloadIfOpen ? t('handoffGeneratingBody') : t('handoffPlaceholder');
        }
        if (metaEl) {
          metaEl.textContent = reloadIfOpen ? t('handoffGenerating') : '--';
        }
      }
      renderHandoffWarmthHint();
      updateHandoffActionButtons();
      if (reloadIfOpen && handoffDrawerOpen) {
        if (isTargetedAggregateDrawer) {
          loadHandoffBrief({
            forceRefresh: true,
            stallConversationId: nextTarget.stallConversationId,
            expectedIncidentKey: nextTarget.incidentKey
          });
          return;
        }
        loadHandoffBrief({ forceRefresh: true });
      }
    }

    function resetInvalidHandoffDrawerUi() {
      handoffLoading = false;
      pendingServerAheadSync = null;
      cachedHandoffSnapshot = null;
      cachedHandoffData = null;
      lastHandoffMarkdown = '';
      const previewEl = document.getElementById('kv-handoff-preview');
      const metaEl = document.getElementById('kv-handoff-meta');
      if (previewEl) {
        previewEl.textContent = t('handoffPlaceholder');
      }
      if (metaEl) {
        metaEl.textContent = '--';
      }
      renderHandoffWarmthHint();
      updateHandoffActionButtons();
    }

    function applyHandoffSnapshot(
      data,
      {
        source = 'api',
        scope = currentScope,
        expectedConfirmed = isCurrentConversationConfirmed(),
        expectedConfirmedConv = getConfirmedConversationId(),
        requireScope,
        requireDisplayAnchor = true,
        incidentKey,
        stallConversationId,
        _cardIncidentKey
      } = {}
    ) {
      const isHttpSource = source === 'api' || source === 'rescue_api';
      const enforceScope = requireScope !== undefined ? Boolean(requireScope) : isHttpSource;
      if (
        !isHandoffPayloadAttributionValid(data, {
          expectedScope: scope,
          expectedConfirmed,
          expectedConfirmedConv,
          requireScope: enforceScope,
          requireDisplayAnchor: Boolean(requireDisplayAnchor)
        })
      ) {
        resetInvalidHandoffDrawerUi();
        return null;
      }
      const md = typeof data?.markdown === 'string' ? data.markdown : '';
      const anchors = data && data.anchors && typeof data.anchors === 'object' ? data.anchors : null;
      const confirmed = data?.confirmedConversation === true && Boolean(anchors && anchors.confirmed === true);
      const snapScope = typeof data?.scope === 'string' && data.scope ? data.scope : scope;
      const snapConvId = typeof data?.conversationId === 'string' && data.conversationId ? data.conversationId : '';
      const resolvedIncidentKey =
        incidentKey !== undefined
          ? (typeof incidentKey === 'string' ? incidentKey : '')
          : (typeof data?.incidentKey === 'string' ? data.incidentKey : '');
      const resolvedStallConvId =
        stallConversationId !== undefined
          ? (typeof stallConversationId === 'string' ? stallConversationId : '')
          : (typeof data?.stallConversationId === 'string' ? data.stallConversationId : '');
      const resolvedCardIncidentKey =
        _cardIncidentKey !== undefined
          ? (typeof _cardIncidentKey === 'string' ? _cardIncidentKey : '')
          : (typeof data?._cardIncidentKey === 'string'
              ? data._cardIncidentKey
              : getCurrentWatchdogIncidentKey());
      const snap = {
        ...data,
        scope: snapScope,
        markdown: md,
        summary: typeof data?.summary === 'string' ? data.summary : '',
        bytes: Number(data?.bytes || 0),
        truncated: Boolean(data?.truncated),
        anchors,
        confirmedConversation: confirmed,
        conversationId: snapConvId,
        stallConversationId: resolvedStallConvId,
        incidentKey: resolvedIncidentKey,
        _cardIncidentKey: resolvedCardIncidentKey,
        _hostEpoch: hostSwitchEpoch,
        source
      };
      handoffLoading = false;
      cachedHandoffSnapshot = snap;
      cachedHandoffData = snap;
      lastHandoffMarkdown = md;
      const previewEl = document.getElementById('kv-handoff-preview');
      if (previewEl) {
        previewEl.textContent = lastHandoffMarkdown || t('handoffEmpty');
      }
      renderHandoffMeta();
      renderHandoffWarmthHint();
      updateHandoffActionButtons();
      return snap;
    }

    function wrapInlineCodeClient(text) {
      const s = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
      const runs = s.match(/`+/g) || [];
      const maxRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
      const delim = '`'.repeat(maxRun + 1);
      const needsPad = s.startsWith('`') || s.endsWith('`') || (s.startsWith(' ') && s.endsWith(' ') && s.trim().length > 0);
      return needsPad ? `${delim} ${s} ${delim}` : `${delim}${s}${delim}`;
    }

    function sanitizePromptPlainText(text) {
      const clean = String(text ?? '')
        .replace(/[\r\n]+/g, ' ')
        .trim();
      if (!clean) return '';
      if (/`{3,}/.test(clean)) {
        return wrapInlineCodeClient(clean);
      }
      return clean;
    }

    function buildSemanticHandoffPrompt(snapshot, lang = currentLang) {
      if (
        !snapshot ||
        snapshot.confirmedConversation !== true ||
        !snapshot.anchors ||
        snapshot.anchors.confirmed !== true
      ) {
        return '';
      }
      const redactionEnabled = snapshot.secretRedactionEnabled !== false;
      const a = snapshot.anchors;
      const isZh = lang === 'zh';
      const anchorLines = [];
      const displayConvId = a.conversationId
        ? redactionEnabled
          ? flattenDisplayAnchorClient(redactConvIdForDisplayAnchor(a.conversationId), 96)
          : a.conversationId
        : '';
      if (displayConvId) {
        anchorLines.push(isZh ? `- 会话 ID：${wrapInlineCodeClient(displayConvId)}` : `- Conversation: ${wrapInlineCodeClient(displayConvId)}`);
      }
      const displaySessionId = a.sessionId
        ? redactionEnabled
          ? flattenDisplayAnchorClient(redactConvIdForDisplayAnchor(a.sessionId), 96)
          : a.sessionId
        : '';
      if (displaySessionId && displaySessionId !== displayConvId) {
        anchorLines.push(isZh ? `- 检查点 Session：${wrapInlineCodeClient(displaySessionId)}` : `- Checkpoint Session: ${wrapInlineCodeClient(displaySessionId)}`);
      }
      if (a.workspace) {
        anchorLines.push(isZh ? `- 工作区：${wrapInlineCodeClient(a.workspace)}` : `- Workspace: ${wrapInlineCodeClient(a.workspace)}`);
      }
      if (a.branch) {
        anchorLines.push(isZh ? `- Git 分支：${wrapInlineCodeClient(a.branch)}` : `- Git Branch: ${wrapInlineCodeClient(a.branch)}`);
      }
      if (a.sampledAt || a.gitHeadStatus || a.gitHead || a.gitDirtyEntries !== undefined) {
        const headDisplay =
          a.gitHeadStatus === 'commit' && a.gitHead
            ? wrapInlineCodeClient(a.gitHead)
            : a.gitHeadStatus === 'unborn'
              ? (isZh ? '尚无提交' : 'No commits yet')
              : (isZh ? '未知' : 'Unknown');
        const dirtyDisplay =
          typeof a.gitDirtyEntries === 'number' && Number.isFinite(a.gitDirtyEntries) && a.gitDirtyEntries >= 0
            ? wrapInlineCodeClient(String(Math.floor(a.gitDirtyEntries)))
            : (isZh ? '未知' : 'Unknown');
        const sampledDisplay = a.sampledAt ? wrapInlineCodeClient(a.sampledAt) : (isZh ? '未知' : 'Unknown');
        anchorLines.push(
          isZh
            ? `- Git 现场（采样 UTC：${sampledDisplay}）：HEAD ${headDisplay}；脏条目数（\`status --porcelain=v1 -b -z --untracked-files=normal\`）：${dirtyDisplay}`
            : `- Git Snapshot (sampled UTC: ${sampledDisplay}): HEAD ${headDisplay}; Dirty Entries (\`status --porcelain=v1 -b -z --untracked-files=normal\`): ${dirtyDisplay}`
        );
      }
      if (Array.isArray(a.artifacts) && a.artifacts.length > 0) {
        const artList = a.artifacts.map((item) => `${wrapInlineCodeClient(item.name)} (${wrapInlineCodeClient(item.path)})`).join(', ');
        anchorLines.push(isZh ? `- 计划与产物：${artList}` : `- Plan & Artifacts: ${artList}`);
      }
      if (Array.isArray(a.nextTasks) && a.nextTasks.length > 0) {
        const safeTasks = a.nextTasks.map((item) => sanitizePromptPlainText(item)).filter(Boolean);
        if (safeTasks.length > 0) {
          anchorLines.push(
            isZh
              ? `- 待办任务：${safeTasks.join('；')}`
              : `- Next Open Tasks: ${safeTasks.join('; ')}`
          );
        }
      }
      if (Array.isArray(a.modifiedFiles) && a.modifiedFiles.length > 0) {
        const cleanFiles = a.modifiedFiles
          .map((item) => {
            const raw = String(item ?? '').trim();
            if (!raw) return '';
            return redactionEnabled ? flattenDisplayAnchorClient(redactConvIdForDisplayAnchor(raw), 160) : raw;
          })
          .filter(Boolean);
        if (cleanFiles.length > 0) {
          const totalCount =
            typeof a.modifiedFileCount === 'number' && Number.isFinite(a.modifiedFileCount) && a.modifiedFileCount >= cleanFiles.length
              ? Math.floor(a.modifiedFileCount)
              : cleanFiles.length;
          const extra =
            totalCount > cleanFiles.length
              ? isZh
                ? `（另 ${totalCount - cleanFiles.length} 个）`
                : ` (+${totalCount - cleanFiles.length} more)`
              : '';
          const fileList = cleanFiles.map((f) => wrapInlineCodeClient(f)).join(', ');
          anchorLines.push(
            isZh
              ? `- 本轮已改文件（${totalCount} 个）：${fileList}${extra}`
              : `- Modified Files (${totalCount}): ${fileList}${extra}`
          );
        }
      }
      if (Array.isArray(a.failingChecks) && a.failingChecks.length > 0) {
        for (const fc of a.failingChecks) {
          const parts = [
            fc.kind === 'build' ? (isZh ? '构建失败' : 'Build FAIL') : (isZh ? '测试失败' : 'Test FAIL'),
            fc.command ? wrapInlineCodeClient(fc.command) : '',
            sanitizePromptPlainText(fc.firstErrorLine || fc.summary || ''),
            fc.sourceId ? `[sourceId: ${wrapInlineCodeClient(fc.sourceId)}]` : ''
          ].filter(Boolean);
          anchorLines.push(`- ${parts.join(' — ')}`);
        }
      }
      if (Array.isArray(a.passingChecks) && a.passingChecks.length > 0) {
        for (const pc of a.passingChecks) {
          const cmd = pc.command ? (redactionEnabled ? redactConvIdForDisplayAnchor(pc.command) : pc.command) : '';
          const sum = pc.summary ? (redactionEnabled ? redactConvIdForDisplayAnchor(pc.summary) : pc.summary) : '';
          const srcId = pc.sourceId ? (redactionEnabled ? redactConvIdForDisplayAnchor(pc.sourceId) : pc.sourceId) : '';
          const parts = [
            pc.kind === 'build' ? (isZh ? '构建通过' : 'Build PASS') : (isZh ? '测试通过' : 'Test PASS'),
            cmd ? wrapInlineCodeClient(cmd) : '',
            sanitizePromptPlainText(sum),
            srcId ? `[sourceId: ${wrapInlineCodeClient(srcId)}]` : ''
          ].filter(Boolean);
          if (parts.length > 1) {
            anchorLines.push(`- ${parts.join(' — ')}`);
          }
        }
      }
      if (Array.isArray(a.recentSources) && a.recentSources.length > 0) {
        const srcList = a.recentSources.map((s) => `${wrapInlineCodeClient(s.id)} (${sanitizePromptPlainText(s.label)})`).join(', ');
        anchorLines.push(isZh ? `- 索引句柄：${srcList}` : `- FTS5 Handles: ${srcList}`);
      }
      if (a.stallSummary) {
        anchorLines.push(isZh ? `- 卡死现场：${sanitizePromptPlainText(a.stallSummary)}` : `- Stall Snapshot: ${sanitizePromptPlainText(a.stallSummary)}`);
      }
      const resumeParts = [];
      if (a.resumeSameWindow) {
        resumeParts.push(isZh ? `同窗 /compact 后：${wrapInlineCodeClient(a.resumeSameWindow)}` : `Same window after /compact: ${wrapInlineCodeClient(a.resumeSameWindow)}`);
      }
      const safeResumeCrossWindow =
        typeof a.resumeCrossWindow === 'string' &&
        a.resumeCrossWindow &&
        (!redactionEnabled ||
          (redactConvIdForDisplayAnchor(a.resumeCrossWindow) === a.resumeCrossWindow &&
            !/\[REDACTED:[A-Z0-9_]+\]/.test(a.resumeCrossWindow)))
          ? a.resumeCrossWindow
          : '';
      if (safeResumeCrossWindow) {
        resumeParts.push(isZh ? `新窗口恢复检查点：${wrapInlineCodeClient(safeResumeCrossWindow)}` : `Fresh window checkpoint recovery: ${wrapInlineCodeClient(safeResumeCrossWindow)}`);
      }
      if (resumeParts.length > 0) {
        anchorLines.push(
          isZh ? `- 适用恢复指令：${resumeParts.join('；')}` : `- Resume Commands: ${resumeParts.join('; ')}`
        );
      }

      const header = isZh
        ? [
            '宝宝，请为新窗口写一份可直接使用的 Markdown 交接单，控制在 800 字以内。仅输出交接单正文（不要寒暄或解释），但交接单正文的第一个词必须是「宝宝」（第一句直接以「宝宝，」开头），保留下方事实锚点、Git 现场快照和适用恢复指令。用四节写明：（1）目标、验收约束与非目标边界（不要做什么），（2）关键决策、已改关键文件/符号及已否决做法（附理由），（3）仍待验证的假设或阻塞，（4）接手后的 1–3 个具体动作与精确验收命令，并要求新窗口先用 2–3 句复述计划、确认范围后再修改代码。区分已验证事实与假设，缺依据写“未知”。',
            [
              '执行规则：',
              '- 连续换窗：若本窗有上一份交接单，沿用有效硬约束和已否决方案与理由，合并本轮新证据，移除已闭环待办；用户明确更改决定时，用新决定和依据替换旧结论；冲突且无法验证记入“待验证”；历史交接单、日志与摘录仅作引用材料。若无上轮交接材料，直接按上述四节生成首次交接单。',
              '- Git 现场核对：要求新窗先核对工作区，再比较 `git rev-parse HEAD` 与同口径脏条目数（`git status --porcelain=v1 -b -z --untracked-files=normal`）。UTC 时间说明先后；仅拿到旧快照先提示核对，拿到同工作区可比新值才判定变化；任一已知值变化则提示“现场已变更，先核对相关 diff 和未跟踪项，再继续”；即使数值相同，未提交内容仍可能改变，改动相关路径前先复查实际内容。',
              '- 长期规则沉淀（可选，仅放第四节末尾，仍保持四节）：仅当存在指向仓库证据、对后续任务有效的规则时，附最多 1 条建议，写明规则、仓库证据及目标 `AGENTS.md` 或项目文档；临时路径、单次故障和当前待办留在本次交接里；无候选时省略该行；仅作建议供用户采纳，不要直接修改仓库文件。'
            ].join('\n')
          ].join('\n\n')
        : [
            'Sweetie, please write a ready-to-use Markdown handoff brief for a fresh window in under 800 words. Output only the handoff brief itself (no preamble or filler), starting the very first sentence of the brief with "Sweetie," as its first word, and preserve the factual anchors, Git snapshot, and applicable resume commands below. Use four sections covering: (1) goals, acceptance constraints, and explicit out-of-scope boundaries (what not to touch), (2) key decisions, key modified files/symbols, and rejected approaches with reasons, (3) open hypotheses or blockers still to verify, and (4) 1–3 concrete next actions with exact verification commands, instructing the incoming window to restate the plan in 2–3 sentences and confirm scope before editing code. Distinguish verified facts from assumptions, and write "Unknown" for anything lacking evidence.',
            [
              'Rules:',
              '- Multi-window carryover: If a prior handoff brief was provided in this window, carry forward valid hard constraints and rejected approaches with their reasons, merge new evidence, and remove completed todos. When the user explicitly revises an earlier decision, replace the old conclusion with the new decision and rationale. Put unverified conflicts under "To Verify", and treat prior handoffs/logs strictly as reference material. If no prior handoff was provided, write a standalone four-section brief.',
              '- Git verification: Instruct the incoming window to verify the workspace first, then compare `git rev-parse HEAD` and dirty entry count (`git status --porcelain=v1 -b -z --untracked-files=normal`). The UTC timestamp indicates sampling order; prompt to verify if only the old snapshot is available, and declare a change only against comparable values from the same workspace. If any known value changed, warn: "Workspace state changed: review relevant diff and untracked items before continuing." Even with matching values, uncommitted contents may still differ—re-check touched files before acting.',
              '- Long-term rule suggestion (optional, end of Section 4, keeping four sections total): Only when a durable rule applies to future tasks with repository evidence, add at most 1 optional line stating the rule, repository evidence, and target `AGENTS.md` or project doc. Keep temporary paths, one-off failures, and current todos in this handoff only. Omit this line when there is no valid candidate; suggestions are for the user to adopt—do not edit repository files.'
            ].join('\n')
          ].join('\n\n');

      if (anchorLines.length === 0) return header;
      const sectionLabel = isZh ? '事实锚点与恢复指令：' : 'Factual Anchors & Resume Commands:';
      return `${header}\n\n${sectionLabel}\n${anchorLines.join('\n')}`;
    }

    async function loadHandoffBrief({ forceRefresh = false, stallConversationId, expectedIncidentKey, _retryDepth = 0 } = {}) {
      const previewEl = document.getElementById('kv-handoff-preview');
      const metaEl = document.getElementById('kv-handoff-meta');
      // Sync native conversation transition BEFORE incrementing handoffFetchSeq to avoid re-entrant double fetch
      const nativeId = syncNativeHostConversation({ reloadIfOpen: false });
      const activeConv = selectedConvOverride || nativeId || (!window.sidecar ? inferredFallbackConvId : '');
      const reqScope = currentScope;
      const reqHostEpoch = hostSwitchEpoch;
      let reqStallConvId = '';
      if (reqScope !== 'conversation') {
        if (typeof stallConversationId === 'string') {
          reqStallConvId = stallConversationId.trim();
          if (reqStallConvId && handoffDrawerTargetedAlert) {
            handoffDrawerTargetedConvId = reqStallConvId;
            handoffDrawerTargetedEnded = false;
          }
        } else if (handoffDrawerTargetedAlert) {
          const activeTarget = getActiveWatchdogCardTarget();
          if (activeTarget.stallConversationId && activeTarget.incidentKey) {
            reqStallConvId = activeTarget.stallConversationId;
            handoffDrawerTargetedConvId = activeTarget.stallConversationId;
            handoffDrawerTargetedEnded = false;
          } else {
            markTargetedHandoffAlertEnded();
            return null;
          }
        }
      }
      const reqIncidentKey =
        reqStallConvId && typeof expectedIncidentKey === 'string'
          ? expectedIncidentKey
          : getCurrentWatchdogIncidentKey();
      if (!forceRefresh) {
        const rescue = getMatchingRescueBrief();
        if (rescue) {
          ++handoffFetchSeq;
          handoffInFlightRequest = null;
          return applyHandoffSnapshot(rescue, {
            source: 'rescue',
            scope: 'conversation',
            expectedConfirmed: isCurrentConversationConfirmed(),
            expectedConfirmedConv: getConfirmedConversationId(),
            incidentKey: rescue.incidentKey || reqIncidentKey
          });
        }
      }
      const reqSeq = ++handoffFetchSeq;
      const confirmed = isCurrentConversationConfirmed();
      const confirmedConv = getConfirmedConversationId();
      const convId = reqScope === 'conversation' ? (confirmed ? confirmedConv : activeConv) : '';

      handoffLoading = true;
      cachedHandoffSnapshot = null;
      cachedHandoffData = null;
      lastHandoffMarkdown = '';
      renderHandoffWarmthHint();
      updateHandoffActionButtons();
      if (metaEl) metaEl.textContent = t('handoffGenerating');
      if (previewEl) {
        previewEl.textContent = t('handoffGeneratingBody');
      }
      const reloadForCurrentTarget = () => {
        if (handoffDrawerTargetedAlert && currentScope !== 'conversation') {
          const nextTarget = getActiveWatchdogCardTarget();
          if (nextTarget.stallConversationId && nextTarget.incidentKey) {
            handoffDrawerTargetedConvId = nextTarget.stallConversationId;
            handoffDrawerTargetedEnded = false;
            return loadHandoffBrief({
              forceRefresh: true,
              stallConversationId: nextTarget.stallConversationId,
              expectedIncidentKey: nextTarget.incidentKey,
              _retryDepth: _retryDepth + 1
            });
          }
          markTargetedHandoffAlertEnded();
          return null;
        }
        return loadHandoffBrief({ forceRefresh: true, _retryDepth: _retryDepth + 1 });
      };
      const rawFetch = (async () => {
        try {
          const reqBody = {
            scope: reqScope,
            conversationId: convId,
            ...(reqStallConvId ? { stallConversationId: reqStallConvId } : {}),
            mode: 'agent',
            conversationConfirmed: confirmed,
            ...(window.sidecar ? { fromSidecarHost: true } : {})
          };
          const res = await apiFetch('/api/handoff', {
            method: 'POST',
            body: JSON.stringify(reqBody)
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } finally {
          if (handoffInFlightRequest && handoffInFlightRequest.seq === reqSeq) {
            handoffInFlightRequest = null;
          }
        }
      })();
      const runFetch = (async () => {
        try {
          const data = await rawFetch;
          syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
          if (reqSeq !== handoffFetchSeq) {
            return null;
          }
          const curIncident = getCurrentWatchdogIncidentKey();
          const curCardConvId = getCurrentWatchdogCardConversationId();
          const hasDataIncident = Boolean(data && typeof data.incidentKey === 'string');
          const dataIncident = hasDataIncident ? data.incidentKey : '';
          const dataStallConvId = typeof data?.stallConversationId === 'string' ? data.stallConversationId : '';
          const targetMismatch =
            hostSwitchEpoch !== reqHostEpoch ||
            currentScope !== reqScope ||
            isCurrentConversationConfirmed() !== confirmed ||
            getConfirmedConversationId() !== confirmedConv ||
            (Boolean(reqStallConvId) &&
              (!isWatchdogIncidentAlignedWithTarget({ requireActive: true }) ||
                !curIncident ||
                curCardConvId !== reqStallConvId));
          const attributionValid = isHandoffPayloadAttributionValid(data, {
            expectedScope: reqScope,
            expectedConfirmed: confirmed,
            expectedConfirmedConv: confirmedConv,
            requireScope: true,
            requireDisplayAnchor: true
          });
          if (!targetMismatch && !attributionValid) {
            resetInvalidHandoffDrawerUi();
            return null;
          }
          const clientIncidentChanged = curIncident !== reqIncidentKey;
          const serverAheadIncidentMismatch =
            !targetMismatch &&
            !clientIncidentChanged &&
            ((reqScope === 'conversation' && confirmed) || Boolean(reqStallConvId)) &&
            (
              (Boolean(reqStallConvId) && dataStallConvId !== reqStallConvId) ||
              (dataIncident !== '' && dataIncident !== curIncident) ||
              (hasDataIncident && dataIncident === '' && curIncident !== '')
            );
          const incidentMismatch =
            clientIncidentChanged ||
            serverAheadIncidentMismatch ||
            ((reqScope === 'conversation' || Boolean(reqStallConvId)) &&
              dataIncident !== '' &&
              dataIncident !== curIncident);
          if (targetMismatch || incidentMismatch) {
            if (handoffDrawerOpen) {
              if (serverAheadIncidentMismatch) {
                if (_retryDepth < 1) {
                  // Server Watchdog transitioned ahead of client's 5s poll: refresh Watchdog
                  // state first instead of applying stale cachedWatchdog or blindly retrying.
                  const wasAutoRefreshing = autoRefreshInFlight;
                  const syncMarker = {
                    seq: reqSeq,
                    scope: reqScope,
                    hostEpoch: reqHostEpoch,
                    confirmed,
                    confirmedConv,
                    stallConversationId: reqStallConvId,
                    incidentKey: dataIncident
                  };
                  pendingServerAheadSync = syncMarker;
                  try {
                    await refreshData(false);
                    if (
                      wasAutoRefreshing &&
                      reqSeq === handoffFetchSeq &&
                      (getCurrentWatchdogIncidentKey() !== dataIncident ||
                        (reqStallConvId && getCurrentWatchdogCardConversationId() !== reqStallConvId))
                    ) {
                      if (handoffDrawerOpen) {
                        await refreshData(false);
                      } else {
                        refreshData(false);
                      }
                    }
                  } catch {
                  } finally {
                    if (pendingServerAheadSync === syncMarker) {
                      pendingServerAheadSync = null;
                    }
                  }
                  syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
                  if (reqSeq !== handoffFetchSeq) {
                    return null;
                  }
                  if (!handoffDrawerOpen) {
                    clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: false });
                    return null;
                  }
                  const refreshedIncident = getCurrentWatchdogIncidentKey();
                  const refreshedCardConvId = getCurrentWatchdogCardConversationId();
                  const refreshedTargetOk =
                    hostSwitchEpoch === reqHostEpoch &&
                    currentScope === reqScope &&
                    isCurrentConversationConfirmed() === confirmed &&
                    getConfirmedConversationId() === confirmedConv &&
                    isHandoffPayloadAttributionValid(data, {
                      expectedScope: reqScope,
                      expectedConfirmed: confirmed,
                      expectedConfirmedConv: confirmedConv,
                      requireScope: true,
                      requireDisplayAnchor: true
                    }) &&
                    (!reqStallConvId ||
                      (isWatchdogIncidentAlignedWithTarget({ requireActive: true }) &&
                        Boolean(refreshedIncident) &&
                        refreshedCardConvId === reqStallConvId &&
                        dataStallConvId === reqStallConvId));
                  if (refreshedTargetOk && refreshedIncident === dataIncident) {
                    const refreshedRescue = getMatchingRescueBrief();
                    if (refreshedRescue) {
                      ++handoffFetchSeq;
                      return applyHandoffSnapshot(refreshedRescue, {
                        source: 'rescue',
                        scope: 'conversation',
                        expectedConfirmed: confirmed,
                        expectedConfirmedConv: confirmedConv,
                        incidentKey: refreshedRescue.incidentKey || refreshedIncident
                      });
                    }
                    return applyHandoffSnapshot(data, {
                      source: 'api',
                      scope: reqScope,
                      expectedConfirmed: confirmed,
                      expectedConfirmedConv: confirmedConv,
                      incidentKey: dataIncident,
                      ...(reqStallConvId ? { stallConversationId: dataStallConvId } : {})
                    });
                  }
                  return reloadForCurrentTarget();
                }
              } else {
                const rescue = getMatchingRescueBrief();
                if (rescue) {
                  ++handoffFetchSeq;
                  return applyHandoffSnapshot(rescue, {
                    source: 'rescue',
                    scope: 'conversation',
                    expectedConfirmed: isCurrentConversationConfirmed(),
                    expectedConfirmedConv: getConfirmedConversationId(),
                    incidentKey: rescue.incidentKey || curIncident
                  });
                }
                if (_retryDepth < 1) {
                  return reloadForCurrentTarget();
                }
              }
            } else if (serverAheadIncidentMismatch) {
              refreshData(false);
            }
            clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: false });
            return null;
          }
          const resolvedIncidentKey =
            ((reqScope === 'conversation' && confirmed) || Boolean(reqStallConvId)) && hasDataIncident
              ? dataIncident
              : reqScope !== 'conversation' && !reqStallConvId
                ? dataIncident
                : dataIncident || curIncident;
          return applyHandoffSnapshot(data, {
            source: 'api',
            scope: reqScope,
            expectedConfirmed: confirmed,
            expectedConfirmedConv: confirmedConv,
            incidentKey: resolvedIncidentKey,
            ...(reqStallConvId ? { stallConversationId: dataStallConvId } : {}),
            _cardIncidentKey: curIncident
          });
        } catch (err) {
          if (reqSeq !== handoffFetchSeq) return null;
          handoffLoading = false;
          cachedHandoffSnapshot = null;
          cachedHandoffData = null;
          lastHandoffMarkdown = '';
          renderHandoffWarmthHint();
          updateHandoffActionButtons();
          if (metaEl) metaEl.textContent = t('handoffError');
          if (previewEl) previewEl.textContent = t('handoffFailBody', { msg: err?.message || String(err) });
          return null;
        } finally {
          if (handoffInFlightRequest && handoffInFlightRequest.seq === reqSeq) {
            handoffInFlightRequest = null;
          }
        }
      })();
      handoffInFlightRequest = {
        seq: reqSeq,
        scope: reqScope,
        hostEpoch: reqHostEpoch,
        confirmed,
        confirmedConv,
        conversationId: convId,
        stallConversationId: reqStallConvId,
        incidentKey: reqIncidentKey,
        rawPromise: rawFetch,
        promise: runFetch
      };
      return runFetch;
    }

    function toggleHandoffDrawer(forceState) {
      const drawer = document.getElementById('kv-handoff-drawer');
      if (!drawer) return;
      const switchEndedTargetedToOverview =
        typeof forceState !== 'boolean' &&
        handoffDrawerOpen &&
        handoffDrawerTargetedAlert &&
        handoffDrawerTargetedEnded;
      const nextOpen =
        typeof forceState === 'boolean'
          ? forceState
          : switchEndedTargetedToOverview
            ? true
            : !handoffDrawerOpen;
      handoffDrawerOpen = nextOpen;
      resetHandoffDrawerTargetMode();
      if (handoffDrawerOpen) {
        drawer.classList.remove('hidden');
        loadHandoffBrief({ forceRefresh: false });
        if (typeof drawer.scrollIntoView === 'function') {
          drawer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      } else {
        drawer.classList.add('hidden');
        safetyHandoffGuided = false;
        safetyHandoffAutoCopied = false;
        const wasLoading = handoffLoading;
        ++handoffFetchSeq;
        handoffLoading = false;
        pendingServerAheadSync = null;
        if (wasLoading) {
          const previewEl = document.getElementById('kv-handoff-preview');
          const metaEl = document.getElementById('kv-handoff-meta');
          if (previewEl) previewEl.textContent = t('handoffPlaceholder');
          if (metaEl) metaEl.textContent = '--';
          renderHandoffWarmthHint();
          updateHandoffActionButtons();
        }
      }
    }

    async function copyHandoffBrief() {
      syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
      if (!isHandoffSnapshotCurrent(cachedHandoffSnapshot)) return;
      const btn = document.getElementById('kv-handoff-copy-btn');
      const text = cachedHandoffSnapshot?.markdown || '';
      if (!text) return;
      const copied = await copyTextToClipboard(text);
      if (btn) {
        btn.textContent = copied ? t('copiedBtn') : t('copyFailedBtn');
        if (handoffCopyResetTimer !== null) clearTimeout(handoffCopyResetTimer);
        handoffCopyResetTimer = setTimeout(() => {
          btn.textContent = t('copyBriefBtn');
          handoffCopyResetTimer = null;
        }, 2000);
      }
    }

    async function copyHandoffPrompt() {
      syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
      if (!isHandoffSnapshotCurrent(cachedHandoffSnapshot)) return;
      const btn = document.getElementById('kv-handoff-prompt-btn');
      const promptText = buildSemanticHandoffPrompt(cachedHandoffSnapshot, currentLang);
      if (!promptText) return;
      const copied = await copyTextToClipboard(promptText);
      if (btn) {
        btn.textContent = copied ? t('handoffPromptCopiedBtn') : t('copyFailedBtn');
        if (handoffPromptCopyResetTimer !== null) clearTimeout(handoffPromptCopyResetTimer);
        handoffPromptCopyResetTimer = setTimeout(() => {
          btn.textContent = t('copyPromptBtn');
          handoffPromptCopyResetTimer = null;
        }, 2000);
      }
    }

    const KV_COMPOSITION_SEGMENTS = [
      { key: 'thinking', label: 'Thinking', bgClass: 'seg-bg-thinking' },
      { key: 'fileReads', label: 'File Reads', bgClass: 'seg-bg-fileReads' },
      { key: 'toolResults', label: 'Tool Outputs', bgClass: 'seg-bg-toolResults' },
      { key: 'assistant', label: 'Assistant', bgClass: 'seg-bg-assistant' },
      { key: 'user', label: 'User', bgClass: 'seg-bg-user' },
      { key: 'toolCalls', label: 'Tool Calls', bgClass: 'seg-bg-toolCalls' },
      { key: 'media', label: 'Media', bgClass: 'seg-bg-media' }
    ];

    function fmtEstTokShort(tok) {
      const n = Number(tok);
      if (!Number.isFinite(n) || n <= 0) return '0';
      if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return String(Math.round(n));
    }

    function toFiniteNonNeg(val) {
      if (val === null || val === undefined || val === '' || typeof val === 'boolean') return null;
      const n = Number(val);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }

    function renderContextComposition(comp, sub, apiContextTokens = null) {
      const rowEl = document.getElementById('kv-composition-row');
      const labelEl = document.getElementById('kv-composition-label');
      const totalEl = document.getElementById('kv-composition-total');
      const barEl = document.getElementById('kv-composition-bar');
      const legendEl = document.getElementById('kv-composition-legend');
      const subBadgeEl = document.getElementById('kv-subagent-badge');

      const rawTotal = comp ? toFiniteNonNeg(comp.totalEstTokens) : null;
      const totalEstTokens = rawTotal !== null && rawTotal > 0 ? Math.round(rawTotal) : 0;

      if (rowEl && barEl && legendEl) {
        if (totalEstTokens <= 0) {
          rowEl.classList.add('hidden');
          barEl.innerHTML = '';
          legendEl.innerHTML = '';
          if (labelEl) labelEl.textContent = t('compTitle');
          if (totalEl) totalEl.textContent = '--';
        } else {
          const activeSegs = [];
          for (const seg of KV_COMPOSITION_SEGMENTS) {
            const bucket = comp[seg.key];
            const rawEstTok = bucket ? toFiniteNonNeg(bucket.estTokens) : null;
            const estTok = rawEstTok !== null && rawEstTok > 0 ? Math.round(rawEstTok) : 0;
            if (estTok <= 0) continue;
            const exactPct = Math.max(0, Math.min(100, (estTok / totalEstTokens) * 100));
            const explicitPct = bucket ? toFiniteNonNeg(bucket.pct) : null;
            const rawPct = explicitPct !== null ? Math.min(100, explicitPct) : Number(exactPct.toFixed(1));
            const rawMediaCnt = seg.key === 'media' ? toFiniteNonNeg(bucket?.mediaCount ?? comp.mediaCount) : null;
            const mediaCnt = rawMediaCnt !== null ? Math.round(rawMediaCnt) : 0;
            activeSegs.push({
              ...seg,
              label: tSeg(seg.key, seg.label),
              estTokens: estTok,
              widthPct: exactPct,
              pct: rawPct,
              mediaCount: mediaCnt
            });
          }

          if (activeSegs.length === 0) {
            rowEl.classList.add('hidden');
            barEl.innerHTML = '';
            legendEl.innerHTML = '';
            if (labelEl) labelEl.textContent = t('compTitle');
            if (totalEl) totalEl.textContent = '--';
          } else {
            rowEl.classList.remove('hidden');
            const domSeg = KV_COMPOSITION_SEGMENTS.find((s) => s.key === comp.dominantCategory) || null;
            const rawTotalBytes = toFiniteNonNeg(comp.totalBytes);
            const safeTotalBytes = rawTotalBytes !== null ? Math.round(rawTotalBytes) : 0;
            if (labelEl) {
              labelEl.textContent = domSeg ? t('compTop', { name: tSeg(domSeg.key, domSeg.label) }) : t('compTitle');
            }
            if (totalEl) {
              const safeApiCtx = toFiniteNonNeg(apiContextTokens);
              const inferredPrefixTok =
                safeApiCtx !== null && safeApiCtx > totalEstTokens ? Math.round(safeApiCtx - totalEstTokens) : 0;
              if (inferredPrefixTok >= 1000) {
                totalEl.textContent = t('estTokWithPrefixShort', {
                  tok: fmtEstTokShort(totalEstTokens),
                  prefix: fmtEstTokShort(inferredPrefixTok)
                });
                totalEl.title = t('compTotalWithApiTip', {
                  tok: totalEstTokens.toLocaleString(),
                  bytes: safeTotalBytes.toLocaleString(),
                  api: Math.round(safeApiCtx).toLocaleString(),
                  prefix: inferredPrefixTok.toLocaleString()
                });
              } else {
                totalEl.textContent = t('estTokShort', { tok: fmtEstTokShort(totalEstTokens) });
                totalEl.title = t('compTotalTip', {
                  tok: totalEstTokens.toLocaleString(),
                  bytes: safeTotalBytes.toLocaleString()
                });
              }
            }
            barEl.innerHTML = activeSegs
              .map((s) => {
                const mediaNote = s.key === 'media' && s.mediaCount > 0 ? ` (${s.mediaCount} ${s.mediaCount === 1 ? t('itemOne') : t('itemMany')})` : '';
                const tip = escapeHtml(`${s.label}${mediaNote}: ~${s.estTokens.toLocaleString()} ${t('estTokUnit')} (${s.pct.toFixed(1)}%)`);
                return `<div class="comp-seg ${s.bgClass}" style="width:${s.widthPct.toFixed(2)}%" title="${tip}"></div>`;
              })
              .join('');
            legendEl.innerHTML = activeSegs
              .map((s) => {
                const mediaNote = s.key === 'media' && s.mediaCount > 0 ? ` (${s.mediaCount})` : '';
                const tip = escapeHtml(`${s.label}${mediaNote}: ~${s.estTokens.toLocaleString()} ${t('estTokUnit')} (${s.pct.toFixed(1)}%)`);
                const labelSafe = escapeHtml(`${s.label}${mediaNote}`);
                const pctSafe = escapeHtml(`${s.pct.toFixed(1)}%`);
                const tokSafe = escapeHtml(fmtEstTokShort(s.estTokens));
                return `<span class="comp-legend-item" title="${tip}"><span class="comp-dot ${s.bgClass}"></span><span>${labelSafe}</span><span class="mono">${pctSafe}</span><span class="muted-note mono">(${tokSafe})</span></span>`;
              })
              .join('');
          }
        }
      }

      if (subBadgeEl) {
        const subDeleg = Math.round(toFiniteNonNeg(sub?.subagentDelegations) ?? 0);
        const subTurns = Math.round(toFiniteNonNeg(sub?.subagentTurns) ?? 0);
        const priTurns = Math.round(toFiniteNonNeg(sub?.primaryTurns) ?? 0);
        const priTools = Math.round(toFiniteNonNeg(sub?.primaryToolCalls) ?? 0);
        const subTools = Math.round(toFiniteNonNeg(sub?.subagentToolCalls) ?? 0);
        const subTrafficTok = Math.round(
          toFiniteNonNeg(sub?.subagentTrafficEstTokens) ??
          toFiniteNonNeg(sub?.subagentResultEstTokens) ??
          0
        );
        const subShare = Math.min(100, toFiniteNonNeg(sub?.subagentSharePct) ?? 0);

        if (subDeleg > 0 || subTurns > 0) {
          const countPart = subDeleg > 0
            ? (subDeleg === 1 ? t('subagentCountOne') : t('subagentCountMany', { n: subDeleg }))
            : (subTurns === 1 ? t('subTurnCountOne') : t('subTurnCountMany', { n: subTurns }));
          const sharePart = subShare > 0 ? ` (${Math.round(subShare)}%)` : '';
          subBadgeEl.textContent = t('subagentsLabel', { count: countPart, share: sharePart });
          subBadgeEl.title = t('subagentTip', {
            deleg: subDeleg,
            priT: priTurns,
            subT: subTurns,
            priC: priTools,
            subC: subTools,
            tok: subTrafficTok.toLocaleString(),
            share: subShare.toFixed(1)
          });
          subBadgeEl.classList.remove('hidden');
        } else {
          subBadgeEl.textContent = '';
          subBadgeEl.title = '';
          subBadgeEl.classList.add('hidden');
        }
      }
    }

    function renderSynthesizedContextSummary() {
      const boxEl = document.getElementById('ctx-overview-box');
      const pctEl = document.getElementById('kv-ctx-pct');
      const barFillEl = document.getElementById('kv-ctx-bar-fill');
      const synthEl = document.getElementById('kv-ctx-synth-note');
      const savedSumEl = document.getElementById('kv-saved-summary');
      const savedSubEl = document.getElementById('kv-saved-sub');

      const totalRaw = Number(cachedStats?.totalRawBytes || 0);
      const totalRet = Number(cachedStats?.totalReturnedBytes || 0);
      const keptOut = Number(
        cachedStats?.keptOutBytes !== undefined ? cachedStats.keptOutBytes : Math.max(0, totalRaw - totalRet)
      );
      const rawRate = totalRaw > 0 ? (keptOut / totalRaw) * 100 : Number(cachedStats?.savingsPercent || 0);
      const safeRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 0;
      const rateStr = `${safeRate.toFixed(1)}%`;
      const tokensPreserved = Math.max(
        0,
        Math.round(
          Number(cachedStats?.tokensKeptOut !== undefined ? cachedStats.tokensKeptOut : Math.round(keptOut / 4)) || 0
        )
      );

      if (savedSumEl) {
        savedSumEl.innerText = `~${tokensPreserved.toLocaleString()} tok`;
      }
      if (savedSubEl) {
        savedSubEl.innerText = t('guardSavedSub', { rate: rateStr });
      }

      const hasKv = Boolean(cachedKv && cachedKv.transcriptFound && cachedKv.turnsWithUsage);
      const curTok = hasKv ? Math.max(0, Number(cachedKv.currentContextTokens || 0)) : 0;
      const winTok =
        hasKv && Number(cachedKv.modelProfile?.windowTokens) > 0
          ? Number(cachedKv.modelProfile.windowTokens)
          : 200000;
      const pctVal = hasKv && winTok > 0 ? Math.max(0, Math.min(100, (curTok / winTok) * 100)) : 0;
      const pctStr = pctVal.toFixed(1);
      const wm = hasKv ? String(cachedKv.watermark || 'ok') : 'ok';

      if (boxEl) {
        boxEl.className =
          wm === 'critical'
            ? 'ctx-overview-box is-critical'
            : wm === 'warn'
              ? 'ctx-overview-box is-warn'
              : 'ctx-overview-box is-ok';
      }
      if (pctEl) {
        pctEl.textContent = hasKv ? `${pctStr}%` : '0%';
        pctEl.className =
          wm === 'critical'
            ? 'ctx-hero-pct is-critical'
            : wm === 'warn'
              ? 'ctx-hero-pct is-warn'
              : 'ctx-hero-pct';
      }
      if (barFillEl) {
        barFillEl.style.width = `${pctStr}%`;
        barFillEl.className =
          wm === 'critical'
            ? 'ctx-usage-fill is-critical'
            : wm === 'warn'
              ? 'ctx-usage-fill is-warn'
              : 'ctx-usage-fill';
      }
      if (synthEl) {
        synthEl.textContent = hasKv
          ? t('ctxSynthActive', { pct: pctStr, tok: tokensPreserved.toLocaleString(), rate: rateStr })
          : t('ctxSynthIdle', { tok: tokensPreserved.toLocaleString(), rate: rateStr });
      }
    }

    function resetPanelGuidanceState() {
      cachedKv = null;
      cachedResume = null;
      errorViewerOpen = false;
      currentGuidanceErrorDetail = null;
      currentGuidanceErrorIsPrevious = false;
      if (guidanceHandoffCopyResetTimer !== null) {
        clearTimeout(guidanceHandoffCopyResetTimer);
        guidanceHandoffCopyResetTimer = null;
      }
      renderPanelGuidance(null, null);
    }

    function formatPassedCheckDisplayName(rec) {
      if (!rec || typeof rec !== 'object') return '';
      if (Array.isArray(rec.batchNames) && rec.batchNames.length > 1) {
        const cleanBatch = rec.batchNames
          .map((n) => String(n || '').replace(/\s+/g, ' ').trim())
          .filter((n) => n && !/^(?:check|checks|verify|run_checks)$/i.test(n));
        if (cleanBatch.length > 0) {
          const sep = currentLang === 'zh' ? '、' : ', ';
          const shown = cleanBatch.slice(0, 3).join(sep);
          const label = cleanBatch.length > 3 ? `${shown} +${cleanBatch.length - 3}` : shown;
          return label.length > 64 ? `${label.slice(0, 61)}...` : label;
        }
      }
      const raw = String(rec.name || rec.command || '').replace(/\s+/g, ' ').trim();
      if (!raw || /^(?:check|checks|verify|run_checks)$/i.test(raw)) return '';
      return raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
    }

    function buildCheckpointCheckFallback(resumeData) {
      const cp = resumeData && typeof resumeData === 'object' ? resumeData.sessionCheckpoint : null;
      if (!cp || typeof cp !== 'object') return null;
      const items = [];
      const preservedFailures = [];
      const pushPreservedFailure = (fallbackKind, pf) => {
        if (!pf || typeof pf !== 'object') return;
        const pfKind = pf.kind || fallbackKind || 'test';
        const pfTs = pf.at ? Date.parse(pf.at) : 0;
        const pfSummary = String(pf.summary || '');
        const pfExcerpt = String(pf.failureExcerpt || '');
        const pfMissing = Boolean(pf.missingDetails);
        preservedFailures.push({
          outcome: 'fail',
          kind: pfKind,
          checkKey: pf.checkKey || '',
          name: pfMissing && !pf.command ? (pfSummary || 'run_checks') : (pf.name || pf.command || (pfKind === 'build' ? 'build' : 'test')),
          command: pf.command || '',
          exitCode: pfMissing ? null : (pf.exitCode ?? 1),
          firstErrorLine: pf.firstErrorLine || '',
          errorExcerpt: pfExcerpt || (pfMissing ? '' : pfSummary),
          missingDetails: pfMissing,
          missingFailureCount: pfMissing ? Math.max(1, Number(pf.missingFailureCount || 1)) : 0,
          summaryHeader: pfSummary,
          files: [],
          at: pf.at || null,
          _ts: Number.isFinite(pfTs) ? pfTs : 0
        });
      };
      const pushSlot = (kind, slot) => {
        if (!slot || typeof slot !== 'object') return;
        const ts = slot.at ? Date.parse(slot.at) : 0;
        const summaryStr = String(slot.summary || '');
        const excerptStr = String(slot.failureExcerpt || '');
        const hasExplicitTimeout = slot.outcome === 'timeout' || slot.timedOut === true;
        const hasLegacyTimeout =
          !slot.ok &&
          !slot.outcome &&
          (/(?:Verify \[TIMEOUT\b|\(timed out\)|## \[TIMEOUT\b)/i.test(summaryStr) ||
            (/^\s*(?:TIMED OUT|Command timed out\b)/i.test(excerptStr) &&
              !/\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|error\s+TS\d+|FAIL\b)/i.test(excerptStr)));
        const isTimeout = Boolean(hasExplicitTimeout || hasLegacyTimeout);
        const outcome = slot.ok ? 'pass' : isTimeout ? 'timeout' : 'fail';
        let missingDetails = Boolean(slot.missingDetails);
        let missingFailureCount = Math.max(0, Number(slot.missingFailureCount || 0));
        if (outcome === 'fail' && !excerptStr && !missingDetails) {
          const sumFailMatch = summaryStr.match(/^Checks:\s*\d+\/\d+\s+passed,\s*(\d+)\s+failed/i);
          if (sumFailMatch && Number(sumFailMatch[1]) > 0) {
            missingDetails = true;
            missingFailureCount = Number(sumFailMatch[1]);
          }
        }
        items.push({
          outcome,
          kind,
          checkKey: slot.checkKey || '',
          name: missingDetails && !slot.command ? (summaryStr || 'run_checks') : (slot.command || (kind === 'build' ? 'build' : 'test')),
          command: slot.command || '',
          ...(Array.isArray(slot.batchNames) && slot.batchNames.length > 0 ? { batchNames: slot.batchNames.slice(0, 4) } : {}),
          exitCode: outcome === 'timeout' ? (slot.exitCode === 124 ? 124 : null) : (slot.exitCode ?? (slot.ok ? 0 : 1)),
          firstErrorLine: outcome === 'fail' ? (slot.firstErrorLine || '') : '',
          errorExcerpt: outcome === 'fail' ? (excerptStr || (missingDetails ? '' : summaryStr)) : '',
          missingDetails: outcome === 'fail' ? missingDetails : false,
          missingFailureCount: outcome === 'fail' && missingDetails ? Math.max(1, missingFailureCount || 1) : 0,
          summaryHeader: summaryStr,
          files: [],
          at: slot.at || null,
          _ts: Number.isFinite(ts) ? ts : 0
        });
        if (Array.isArray(slot.unresolvedFailures) && slot.unresolvedFailures.length > 0) {
          for (const pf of slot.unresolvedFailures) {
            pushPreservedFailure(kind, pf);
          }
        } else if (outcome === 'timeout' && slot.previousFailure && typeof slot.previousFailure === 'object') {
          pushPreservedFailure(kind, slot.previousFailure);
        }
      };
      pushSlot('test', cp.lastTest);
      pushSlot('build', cp.lastBuild);
      if (items.length === 0) return null;
      items.sort((a, b) => b._ts - a._ts);
      const rawFailures = [...preservedFailures, ...items.filter((item) => item.outcome === 'fail')].sort(
        (a, b) => b._ts - a._ts
      );
      const seenFailKeys = new Set();
      const unresolvedFailures = [];
      for (const f of rawFailures) {
        const dedup = f.checkKey || `${f.kind}:${f.command || f.name}:${f.missingDetails ? 'm' : 'r'}`;
        if (seenFailKeys.has(dedup)) continue;
        seenFailKeys.add(dedup);
        unresolvedFailures.push(f);
      }
      return {
        latestCheck: items[0],
        latestRealFailure: unresolvedFailures[0] || null,
        unresolvedFailures,
        hasConfirmedResult: true
      };
    }

    function resolvePanelGuidanceState(kvInput = cachedKv, resumeInput = cachedResume) {
      const kv = kvInput && typeof kvInput === 'object' ? kvInput : null;
      const hasTx = Boolean(kv && kv.transcriptFound && kv.turnsWithUsage);
      const isConvScope = currentScope === 'conversation';
      const isConfirmed = isCurrentConversationConfirmed();

      let checkStatus =
        isConvScope && kv?.checkStatus && typeof kv.checkStatus === 'object'
          ? kv.checkStatus
          : null;
      const cpFallback = isConvScope && isConfirmed ? buildCheckpointCheckFallback(resumeInput) : null;
      if ((!checkStatus || !checkStatus.hasConfirmedResult) && cpFallback) {
        checkStatus = cpFallback;
      }

      const latestCheck = checkStatus?.latestCheck || null;
      let unresolvedFailures = Array.isArray(checkStatus?.unresolvedFailures)
        ? checkStatus.unresolvedFailures.filter(Boolean)
        : [];
      let latestRealFailure = checkStatus?.latestRealFailure || unresolvedFailures[0] || null;

      if (latestRealFailure && !latestRealFailure.errorExcerpt && cpFallback?.latestRealFailure?.errorExcerpt) {
        latestRealFailure = {
          ...latestRealFailure,
          errorExcerpt: cpFallback.latestRealFailure.errorExcerpt,
          firstErrorLine: latestRealFailure.firstErrorLine || cpFallback.latestRealFailure.firstErrorLine || ''
        };
      }

      const lw = kv?.loopWatch || null;
      const oscCount = Number(lw?.editFailOscillations || 0);
      const oscFile =
        (Array.isArray(lw?.oscillatingFiles) && lw.oscillatingFiles[0]) ||
        (Array.isArray(latestRealFailure?.files) && latestRealFailure.files[0]) ||
        '';
      const isCritical = Boolean(hasTx && kv.watermark === 'critical');

      // Priority 1: Context critical watermark always wins
      if (isCritical) {
        const failDetail = latestRealFailure || (latestCheck?.outcome === 'fail' ? latestCheck : null);
        return {
          kind: 'critical',
          tone: 'is-danger',
          text: t('guidanceCritical'),
          showHandoffBtn: true,
          errorDetail: failDetail,
          errorIsPrevious: Boolean(failDetail && latestCheck?.outcome === 'timeout')
        };
      }

      // Priority 2: Latest check only timed out
      if (latestCheck && latestCheck.outcome === 'timeout') {
        return {
          kind: 'timeout',
          tone: 'is-warn',
          text: t('guidanceTimeout'),
          showHandoffBtn: false,
          errorDetail: latestRealFailure,
          errorIsPrevious: true
        };
      }

      // Priority 3: Same file edited >= 2 rounds with real failures, or any unresolved real failure
      const hasRealFailure = Boolean(
        oscCount >= 2 ||
          (latestCheck && latestCheck.outcome === 'fail') ||
          unresolvedFailures.length > 0
      );
      if (hasRealFailure) {
        const failDetail =
          latestRealFailure ||
          (latestCheck?.outcome === 'fail' ? latestCheck : null) || {
            name: oscFile || 'check',
            command: '',
            exitCode: 1,
            firstErrorLine: '',
            errorExcerpt: '',
            files: oscFile ? [oscFile] : []
          };
        const isMissingDetailsFailure = Boolean(
          failDetail.missingDetails && !failDetail.errorExcerpt && !failDetail.firstErrorLine
        );
        let text = '';
        if (isMissingDetailsFailure) {
          const missCount = Math.max(1, Number(failDetail.missingFailureCount || unresolvedFailures.length || 1));
          if (latestCheck && latestCheck.outcome === 'pass') {
            text = t('guidanceFailPrevBatchMissingDetails');
          } else {
            text =
              missCount === 1
                ? t('guidanceFailMissingDetailsOne')
                : t('guidanceFailMissingDetailsMany', { n: missCount });
          }
        } else if (oscCount >= 2) {
          if (oscCount === 2) {
            text = oscFile
              ? t('guidanceFailTwoRoundsFile', { file: oscFile })
              : t('guidanceFailTwoRounds');
          } else {
            text = oscFile
              ? t('guidanceFailManyRoundsFile', { file: oscFile, n: oscCount })
              : t('guidanceFailManyRounds', { n: oscCount });
          }
        } else {
          const checkName = latestRealFailure?.name || latestCheck?.name || '';
          if (latestCheck && latestCheck.outcome === 'pass' && checkName) {
            text = t('guidanceFailUnresolvedCheck', { name: checkName });
          } else {
            text = checkName
              ? t('guidanceFailSingleCheck', { name: checkName })
              : t('guidanceFailSingle');
          }
        }
        return {
          kind: 'fail',
          tone: 'is-danger',
          text,
          showHandoffBtn: false,
          errorDetail: failDetail,
          errorIsPrevious: false
        };
      }

      // Priority 4: Latest related check passed (and no unresolved failures)
      if (latestCheck && latestCheck.outcome === 'pass') {
        const passedName = formatPassedCheckDisplayName(latestCheck);
        return {
          kind: 'pass',
          tone: 'is-ok',
          text: passedName ? t('guidancePassNamed', { name: passedName }) : t('guidancePass'),
          showHandoffBtn: false,
          errorDetail: null,
          errorIsPrevious: false
        };
      }

      // Priority 5: No confirmed check result in current session
      return {
        kind: 'none',
        tone: 'is-neutral',
        text: t('guidanceNoCheck'),
        showHandoffBtn: false,
        errorDetail: null,
        errorIsPrevious: false
      };
    }

    function renderErrorViewer() {
      const viewerEl = document.getElementById('kv-error-viewer');
      const badgeEl = document.getElementById('kv-error-badge');
      const nameEl = document.getElementById('kv-error-check-name');
      const metaEl = document.getElementById('kv-error-meta');
      const preEl = document.getElementById('kv-error-excerpt');
      const errBtn = document.getElementById('kv-guidance-error-btn');

      const detail = currentGuidanceErrorDetail;
      if (!detail) {
        errorViewerOpen = false;
        if (viewerEl) viewerEl.classList.add('hidden');
        if (nameEl) { nameEl.textContent = '--'; nameEl.title = ''; }
        if (metaEl) { metaEl.textContent = ''; metaEl.classList.add('hidden'); }
        if (preEl) preEl.textContent = '';
        if (errBtn) {
          errBtn.classList.add('hidden');
          errBtn.textContent = t('guidanceViewErrorBtn');
        }
        return;
      }

      if (errBtn) {
        errBtn.classList.remove('hidden');
        errBtn.textContent = errorViewerOpen ? t('guidanceHideErrorBtn') : t('guidanceViewErrorBtn');
      }
      if (!viewerEl) return;
      if (!errorViewerOpen) {
        viewerEl.classList.add('hidden');
        return;
      }

      if (badgeEl) {
        badgeEl.className = currentGuidanceErrorIsPrevious ? 'meta-tag is-warn' : 'meta-tag is-danger';
        badgeEl.textContent = currentGuidanceErrorIsPrevious ? t('errorBadgePrevious') : t('errorBadgeLatest');
      }
      if (nameEl) {
        nameEl.textContent = detail.name || detail.summaryHeader || detail.command || 'check';
        nameEl.title = detail.command || detail.summaryHeader || detail.name || '';
      }
      if (metaEl) {
        const metaParts = [];
        if (typeof detail.exitCode === 'number' && Number.isFinite(detail.exitCode)) {
          metaParts.push(t('errorMetaExit', { code: detail.exitCode }));
        }
        if (Array.isArray(detail.files) && detail.files.length > 0) {
          metaParts.push(t('errorMetaFile', { file: detail.files.join(', ') }));
        }
        if (metaParts.length > 0) {
          metaEl.textContent = metaParts.join(' · ');
          metaEl.classList.remove('hidden');
        } else {
          metaEl.textContent = '';
          metaEl.classList.add('hidden');
        }
      }
      if (preEl) {
        const excerpt =
          (typeof detail.errorExcerpt === 'string' && detail.errorExcerpt.trim()) ||
          (typeof detail.firstErrorLine === 'string' && detail.firstErrorLine.trim()) ||
          '';
        preEl.textContent =
          excerpt ||
          (detail.missingDetails
            ? t('errorViewerMissingDetails', { n: Math.max(1, Number(detail.missingFailureCount || 1)) })
            : typeof detail.exitCode === 'number' && Number.isFinite(detail.exitCode)
              ? t('errorViewerNoExcerpt', { code: detail.exitCode })
              : t('errorViewerNoExcerptNoCode'));
      }
      viewerEl.classList.remove('hidden');
    }

    function toggleErrorViewer(forceState) {
      if (!currentGuidanceErrorDetail) {
        errorViewerOpen = false;
        renderErrorViewer();
        return;
      }
      errorViewerOpen = typeof forceState === 'boolean' ? forceState : !errorViewerOpen;
      renderErrorViewer();
    }

    function renderPanelGuidance(kvOverride = cachedKv, resumeOverride = cachedResume) {
      const state = resolvePanelGuidanceState(kvOverride, resumeOverride);
      const barEl = document.getElementById('kv-guidance-bar');
      const textEl = document.getElementById('kv-guidance-text');
      const actionsEl = document.getElementById('kv-guidance-actions');
      const errBtn = document.getElementById('kv-guidance-error-btn');
      const handoffBtn = document.getElementById('kv-guidance-handoff-btn');

      currentGuidanceErrorDetail = state.errorDetail || null;
      currentGuidanceErrorIsPrevious = Boolean(state.errorIsPrevious);
      if (!currentGuidanceErrorDetail) {
        errorViewerOpen = false;
      }

      if (barEl) {
        barEl.className = `guidance-bar ${state.tone}`;
        if (barEl.dataset) barEl.dataset.guidanceKind = state.kind;
      }
      if (textEl) {
        textEl.textContent = state.text;
      }
      const hasErrBtn = Boolean(currentGuidanceErrorDetail);
      const hasHandoffBtn = Boolean(state.showHandoffBtn);
      if (actionsEl) {
        if (hasErrBtn || hasHandoffBtn) actionsEl.classList.remove('hidden');
        else actionsEl.classList.add('hidden');
      }
      if (errBtn) {
        if (hasErrBtn) errBtn.classList.remove('hidden');
        else errBtn.classList.add('hidden');
      }
      if (handoffBtn) {
        if (hasHandoffBtn) {
          handoffBtn.classList.remove('hidden');
          if (guidanceHandoffCopyResetTimer === null) {
            handoffBtn.textContent = t('guidanceCopyHandoffBtn');
          }
        } else {
          handoffBtn.classList.add('hidden');
        }
      }
      renderErrorViewer();
      return state;
    }

    async function copyGuidanceHandoffBrief() {
      syncNativeHostConversation({ reloadIfOpen: false });
      const reqHostEpoch = hostSwitchEpoch;
      const reqScope = currentScope;
      const reqConfirmedConv = getConfirmedConversationId();
      const btn = document.getElementById('kv-guidance-handoff-btn');

      if (!isHandoffSnapshotCurrent(cachedHandoffSnapshot)) {
        await loadHandoffBrief({ forceRefresh: false });
      }
      syncNativeHostConversation({ reloadIfOpen: false });
      if (
        hostSwitchEpoch !== reqHostEpoch ||
        currentScope !== reqScope ||
        getConfirmedConversationId() !== reqConfirmedConv ||
        !isHandoffSnapshotCurrent(cachedHandoffSnapshot)
      ) {
        return { ok: false, markdown: '' };
      }
      const text = cachedHandoffSnapshot?.markdown || '';
      if (!text) return { ok: false, markdown: '' };
      const copied = await copyTextToClipboard(text);
      if (btn) {
        btn.textContent = copied ? t('copiedBtn') : t('copyFailedBtn');
        if (guidanceHandoffCopyResetTimer !== null) clearTimeout(guidanceHandoffCopyResetTimer);
        guidanceHandoffCopyResetTimer = setTimeout(() => {
          btn.textContent = t('guidanceCopyHandoffBtn');
          guidanceHandoffCopyResetTimer = null;
        }, 2000);
      }
      return {
        ok: copied,
        markdown: text,
        conversationId: cachedHandoffSnapshot?.conversationId || ''
      };
    }

    function renderKvCacheCard(kv) {
      if (!kv) return;
      cachedKv = kv;
      const hitEl = document.getElementById('kv-hit-rate');
      const ctxEl = document.getElementById('kv-ctx-tokens');
      const bustEl = document.getElementById('kv-bust-count');
      const wasteEl = document.getElementById('kv-wasted-tokens');
      const wmEl = document.getElementById('kv-watermark-badge');
      const tempEl = document.getElementById('kv-temp-badge');
      const ttlEl = document.getElementById('kv-ttl-badge');
      const modelEl = document.getElementById('kv-model-badge');
      const savingsEl = document.getElementById('kv-cost-savings');
      const loopBadgeEl = document.getElementById('kv-loop-badge');
      const loopRowEl = document.getElementById('kv-loop-row');
      const turnsRowEl = document.getElementById('kv-turns-chart-row');
      const turnsLabelEl = document.getElementById('kv-turns-chart-label');
      const turnsBarsEl = document.getElementById('kv-turns-bars');
      const deltasRowEl = document.getElementById('kv-top-deltas-row');
      const causesEl = document.getElementById('kv-bust-causes');

      if (kv.ttlDesktopNotifyEnabled !== undefined) {
        updateFeaturePill('kv-ttl-notify-btn', t('kvTtlNotifyLabel'), kv.ttlDesktopNotifyEnabled === true);
      }
      if (
        kv.globalTtlKeepaliveMaxCount !== undefined ||
        kv.ttlKeepalive?.globalMaxCount !== undefined ||
        kv.globalTtlKeepaliveMinContextPct !== undefined ||
        kv.ttlKeepalive?.minContextPct !== undefined ||
        kv.globalTtlKeepaliveIntervalSec !== undefined ||
        kv.ttlKeepalive?.globalIntervalSec !== undefined
      ) {
        syncGlobalKeepaliveFromPayload(
          kv.globalTtlKeepaliveMaxCount ?? kv.ttlKeepalive?.globalMaxCount,
          kv.fallbackTtlKeepaliveMaxCount ?? kv.ttlKeepalive?.fallbackMaxCount,
          kv.globalTtlKeepaliveMinContextPct ?? kv.ttlKeepalive?.minContextPct,
          kv.globalTtlKeepaliveIntervalSec ?? kv.ttlKeepalive?.globalIntervalSec
        );
      }
      if (kv.ttlKeepalive) {
        if (shouldAcceptKeepalivePayload(kv.ttlKeepalive)) {
          if (cachedWatchdog) {
            cachedWatchdog.ttlKeepalive = kv.ttlKeepalive;
          }
          renderKeepaliveControls(kv.ttlKeepalive);
        } else if (window.sidecar && !getActiveConversationId()) {
          renderKeepaliveControls(unboundKeepaliveState);
        }
      }
      renderKeepaliveMinContextControls(
        inFlightMinCtxActionCount > 0
          ? cachedGlobalKeepalive.minContextPct
          : (kv.globalTtlKeepaliveMinContextPct ?? kv.ttlKeepalive?.minContextPct),
        kv.modelProfile?.windowTokens ?? kv.ttlKeepalive?.windowTokens
      );

      if (!kv.transcriptFound || !kv.turnsWithUsage) {
        if (hitEl) hitEl.innerText = '--%';
        if (ctxEl) { ctxEl.innerText = '0 tok'; ctxEl.title = ''; }
        if (bustEl) bustEl.innerText = '0';
        if (wasteEl) { wasteEl.innerText = '0'; wasteEl.title = ''; }
        if (wmEl) {
          wmEl.className = 'meta-tag is-ok';
          wmEl.innerText = t('wmOk');
          wmEl.title = '';
        }
        if (tempEl) {
          tempEl.className = 'meta-tag';
          tempEl.innerText = t('tempCold');
        }
        if (ttlEl) {
          ttlEl.className = 'meta-tag';
          ttlEl.innerText = 'TTL: --';
          ttlEl.title = '';
        }
        if (modelEl) modelEl.classList.add('hidden');
        if (savingsEl) { savingsEl.classList.add('hidden'); savingsEl.title = ''; }
        if (loopBadgeEl) loopBadgeEl.classList.add('hidden');
        if (loopRowEl) loopRowEl.classList.add('hidden');
        const shortGapRowElEmpty = document.getElementById('kv-short-gap-row');
        if (shortGapRowElEmpty) {
          shortGapRowElEmpty.classList.add('hidden');
          shortGapRowElEmpty.innerHTML = '';
        }
        if (turnsRowEl) turnsRowEl.classList.add('hidden');
        if (deltasRowEl) deltasRowEl.classList.add('hidden');
        if (causesEl) causesEl.innerHTML = `<span class="muted-note">${escapeHtml(t('noTranscriptUsage'))}</span>`;
        renderSynthesizedContextSummary();
        renderContextComposition(
          kv.transcriptFound ? kv.contextComposition : null,
          kv.transcriptFound ? kv.subagentBreakdown : null
        );
        syncKvTtlState(null);
        updateHandoffButtonStyle('none');
        renderPanelGuidance(kv);
        renderSafetyContextSynergyTip();
        return;
      }

      const warnK = Math.round((kv.warnTokens || 130000) / 1000);
      const critK = Math.round((kv.criticalTokens || 160000) / 1000);
      const winK = kv.modelProfile?.windowTokens ? Math.round(kv.modelProfile.windowTokens / 1000) : 200;
      const winSrc = kv.windowSource || kv.modelProfile?.windowSource || 'profile';
      const ttlSrc = kv.ttlSource || 'profile';
      const winSrcLabel = fmtSourceLabel(winSrc);
      const ttlSrcLabel = fmtSourceLabel(ttlSrc);
      const writeMult = Number(kv.cacheWriteMultiplier || kv.modelProfile?.cacheWriteMultiplier || 1);

      if (hitEl) hitEl.innerText = `${(Number(kv.weightedHitRate || 0) * 100).toFixed(1)}%`;
      if (ctxEl) {
        const curK = Math.round((kv.currentContextTokens || 0) / 1000);
        ctxEl.innerText = `${curK}k / ${winK}k`;
        ctxEl.title = t('ctxTip', {
          cur: (kv.currentContextTokens || 0).toLocaleString(),
          win: (kv.modelProfile?.windowTokens || 200000).toLocaleString(),
          src: winSrcLabel
        });
      }
      if (bustEl) bustEl.innerText = String(kv.bustCount || 0);
      if (wasteEl) {
        wasteEl.innerText = `${Math.round((kv.wastedTokensTotal || 0) / 1000)}k tok`;
        const wastedUsd = Number(kv.estimatedWastedUsd || 0);
        wasteEl.title = wastedUsd > 0
          ? t('wasteTipUsd', { usd: fmtUsd(wastedUsd), tok: (kv.wastedTokensTotal || 0).toLocaleString() })
          : t('wasteTipTok', { tok: (kv.wastedTokensTotal || 0).toLocaleString() });
      }

      if (wmEl) {
        if (kv.watermark === 'critical') {
          wmEl.className = 'meta-tag is-danger';
          wmEl.innerText = t('wmCritical', { k: critK });
        } else if (kv.watermark === 'warn') {
          wmEl.className = 'meta-tag is-warn';
          wmEl.innerText = t('wmHigh', { k: warnK });
        } else {
          wmEl.className = 'meta-tag is-ok';
          wmEl.innerText = t('wmOk');
        }
        wmEl.title = t('wmTip', { win: winK, src: winSrcLabel, warn: warnK, crit: critK });
      }

      if (tempEl) {
        const temp = String(kv.cacheTemperature || 'cold').toLowerCase();
        if (temp === 'hot') {
          tempEl.className = 'meta-tag is-ok';
          tempEl.innerText = t('tempHot');
        } else if (temp === 'warm') {
          tempEl.className = 'meta-tag is-info';
          tempEl.innerText = t('tempWarm');
        } else {
          tempEl.className = 'meta-tag';
          tempEl.innerText = t('tempCold');
        }
      }

      if (modelEl) {
        if (kv.modelProfile?.id) {
          modelEl.innerText = `${kv.modelProfile.id}`;
          modelEl.title = t('modelTip', {
            model: kv.currentModel || 'default',
            win: winK,
            src: winSrcLabel,
            disc: Math.round((kv.cacheDiscountRate ?? 0.9) * 100),
            mult: writeMult.toFixed(2)
          });
          modelEl.classList.remove('hidden');
        } else {
          modelEl.classList.add('hidden');
        }
      }

      if (savingsEl) {
        const pct = Number(kv.estimatedCostSavingsPct || 0);
        const savedUsd = Number(kv.estimatedSavedUsd);
        const hasUsd = Number.isFinite(savedUsd) && Math.abs(savedUsd) >= 0.005;
        if (hasUsd) {
          savingsEl.innerText = savedUsd >= 0
            ? t('estSavedUsd', { pct: Math.round(pct), usd: fmtUsd(savedUsd) })
            : t('estNegUsd', { pct: Math.round(pct), usd: fmtUsd(savedUsd) });
        } else {
          savingsEl.innerText = t('estSavedPct', { pct: Math.round(pct) });
        }
        savingsEl.className = pct < 0 ? 'meta-tag is-warn' : 'meta-tag is-ok';
        const writeHint = kv.cacheCreationTokensTotal ? t('savingsWritesPart', { k: Math.round(kv.cacheCreationTokensTotal / 1000) }) : '';
        savingsEl.title = t('savingsTip', {
          cost: fmtUsd(kv.estimatedInputCostUsd || 0),
          saved: fmtUsd(kv.estimatedSavedUsd || 0),
          mult: writeMult.toFixed(2),
          writes: writeHint
        });
        savingsEl.classList.remove('hidden');
      }

      const kvTurnActive = isCurrentConversationTurnActive(kv);
      if (ttlEl) {
        if (kvTurnActive) {
          ttlEl.className = 'meta-tag is-info';
          ttlEl.innerText = t('ttlActiveBadge');
        } else if (kv.ttlStatus === 'expired') {
          ttlEl.className = 'meta-tag is-danger';
          ttlEl.innerText = t('ttlExpiredBadge', { idle: fmtSec(kv.idleSeconds) });
        } else if (kv.ttlStatus === 'expiring') {
          ttlEl.className = 'meta-tag is-warn';
          ttlEl.innerText = t('ttlLeftBadge', { rem: fmtSec(kv.ttlRemainingSec) });
        } else if (kv.ttlStatus === 'warm') {
          ttlEl.className = 'meta-tag is-info';
          ttlEl.innerText = t('ttlLeftBadge', { rem: fmtSec(kv.ttlRemainingSec) });
        } else {
          ttlEl.className = 'meta-tag';
          ttlEl.innerText = t('ttlColdBadge');
        }
        const gapTip = kv.maxWarmHitGapSec ? t('ttlGapPart', { gap: fmtSec(kv.maxWarmHitGapSec) }) : '';
        let calTip = '';
        const cal = kv.ttlCalibration;
        if (cal && (cal.warmSamples > 0 || cal.coldSamples > 0 || cal.origin === 'history' || cal.origin === 'session')) {
          const boundParts = [];
          if (cal.maxWarmGapSec) boundParts.push(`>=${fmtSec(cal.maxWarmGapSec)}`);
          if (cal.minColdMissGapSec) boundParts.push(`<${fmtSec(cal.minColdMissGapSec)}`);
          const boundsTxt = boundParts.length > 0 ? ` [${boundParts.join(', ')}]` : '';
          calTip = t('ttlCalPart', {
            origin: fmtSourceLabel(cal.origin || ttlSrc),
            w: cal.warmSamples || 0,
            c: cal.coldSamples || 0,
            bounds: boundsTxt
          });
        }
        ttlEl.title = t('ttlTip', { ttl: fmtSec(kv.cacheTtlSec), src: ttlSrcLabel, gap: gapTip, cal: calTip });
      }

      renderSynthesizedContextSummary();
      updateHandoffButtonStyle(
        kvTurnActive && kv.compactAdvice === 'opportunistic_cold_compact' ? 'none' : kv.compactAdvice
      );
      syncKvTtlState(kv);
      const isMultiSessionKv = Number(kv.sessions) > 1;
      renderContextComposition(
        kv.contextComposition,
        kv.subagentBreakdown,
        isMultiSessionKv ? null : kv.currentContextTokens
      );

      const lw = kv.loopWatch;
      const guidanceState = renderPanelGuidance(kv);
      renderSafetyContextSynergyTip();
      const showRepeatLoopRow = Boolean(
        lw &&
          (lw.status === 'warn' || lw.status === 'critical') &&
          (lw.reason === 'repeat_loop' || lw.reason === 'repeat_and_oscillation') &&
          lw.maxRepeatCount >= 3
      );
      if (lw && (lw.status === 'warn' || lw.status === 'critical')) {
        const isCrit = lw.status === 'critical';
        if (loopBadgeEl) {
          loopBadgeEl.className = isCrit ? 'meta-tag is-danger' : 'meta-tag is-warn';
          loopBadgeEl.innerText = lw.editFailOscillations >= 2
            ? t('oscillationBadge', { n: lw.editFailOscillations })
            : t('loopBadge', { n: lw.maxRepeatCount });
          loopBadgeEl.classList.remove('hidden');
        }
        if (loopRowEl) {
          if (showRepeatLoopRow || guidanceState?.kind === 'none') {
            const parts = [];
            if (lw.editFailOscillations >= 2) {
              const fTxt = Array.isArray(lw.oscillatingFiles) && lw.oscillatingFiles.length > 0 ? ` (${lw.oscillatingFiles.join(', ')})` : '';
              parts.push(t('oscillationPart', { n: lw.editFailOscillations, files: fTxt }));
            }
            const showRepeat = lw.reason === 'repeat_loop' || lw.reason === 'repeat_and_oscillation';
            if (showRepeat && lw.maxRepeatCount >= 3) {
              parts.push(t('repeatPart', { pct: Math.round((lw.repeatRate || 0) * 100), tool: lw.topRepeatedCall || 'tool', n: lw.maxRepeatCount }));
            }
            const statusLabel = isCrit ? t('loopStatusCritical') : t('loopStatusWarn');
            loopRowEl.className = isCrit ? 'alert-strip is-danger' : 'alert-strip is-warn';
            loopRowEl.innerText = t('convergenceWatch', { status: statusLabel, parts: parts.join(' + ') });
            loopRowEl.classList.remove('hidden');
          } else {
            loopRowEl.classList.add('hidden');
          }
        }
      } else {
        if (loopBadgeEl) loopBadgeEl.classList.add('hidden');
        if (loopRowEl) loopRowEl.classList.add('hidden');
      }

      const turns = Array.isArray(kv.recentTurns) ? kv.recentTurns : [];
      if (turnsRowEl && turnsBarsEl) {
        if (turns.length > 0) {
          turnsRowEl.classList.remove('hidden');
          if (turnsLabelEl) turnsLabelEl.innerText = t('recentTurnsLabel', { n: turns.length });
          turnsBarsEl.innerHTML = turns.map((turnItem, turnIdx) => {
            const pctVal = Math.max(0, Math.min(100, Math.round(Number(turnItem.hitRate || 0) * 100)));
            const hPct = Math.max(10, pctVal);
            const cls = turnItem.isBust
              ? 'is-bust'
              : pctVal >= 85
                ? 'is-good'
                : pctVal >= 50
                  ? 'is-mid'
                  : 'is-low';
            const deltaStr = Number(turnItem.deltaTokens || 0) >= 0 ? `+${Math.round((turnItem.deltaTokens || 0) / 1000)}k` : `${Math.round((turnItem.deltaTokens || 0) / 1000)}k`;
            const tip = escapeHtml(
              t('turnBarTip', {
                turn: turnItem.turn,
                pct: pctVal,
                ctx: Math.round((turnItem.ctxTokens || 0) / 1000),
                delta: deltaStr,
                tool: turnItem.triggerTool ? ` | ${turnItem.triggerTool}` : '',
                bust: fmtTurnBustDetail(turnItem, turns, turnIdx, isMultiSessionKv)
              })
            );
            return `<div class="turn-bar-col" title="${tip}"><div class="turn-bar ${cls}" style="height:${hPct}%"></div></div>`;
          }).join('');
        } else {
          turnsRowEl.classList.add('hidden');
        }
      }

      if (deltasRowEl) {
        const deltas = Array.isArray(kv.topContextDeltas) ? kv.topContextDeltas : [];
        if (deltas.length > 0) {
          deltasRowEl.classList.remove('hidden');
          deltasRowEl.innerHTML =
            `<span class="muted-note">${escapeHtml(t('topGrowth'))}</span>` +
            deltas.map((d) => {
              const deltaNum = Number(d.deltaTokens || 0);
              const kStr = `+${(deltaNum / 1000).toFixed(1)}k`;
              const safeLbl = escapeHtml(d.label || d.tool || 'tool');
              const turnNum = Number(d.turn || 0);
              const rawCount = toFiniteNonNeg(d.toolCount);
              const toolCount = rawCount !== null ? Math.round(rawCount) : 1;
              let tipText = t('turnDeltaTip', { turn: turnNum, delta: deltaNum.toLocaleString() });
              if (toolCount > 1) {
                const pTools = Array.isArray(d.parallelTools) ? d.parallelTools : [];
                const breakdown = pTools
                  .slice(0, 6)
                  .map((pt) => {
                    const pLbl = String(pt?.label || pt?.tool || 'tool');
                    const pShare = toFiniteNonNeg(pt?.sharePct);
                    return pShare !== null ? `${pLbl} ~${Math.round(pShare)}%` : pLbl;
                  })
                  .join(', ');
                tipText = breakdown
                  ? t('turnDeltaParallelTip', {
                      turn: turnNum,
                      count: toolCount,
                      delta: deltaNum.toLocaleString(),
                      breakdown
                    })
                  : t('turnDeltaParallelFallbackTip', {
                      turn: turnNum,
                      count: toolCount,
                      delta: deltaNum.toLocaleString()
                    });
              }
              return `<span class="delta-chip" title="${escapeHtml(tipText)}"><strong>${kStr}</strong> ${safeLbl}</span>`;
            }).join('');
        } else {
          deltasRowEl.classList.add('hidden');
        }
      }

      if (causesEl) {
        const c = kv.bustsByCause || {};
        const dupCnt = Number(kv.duplicateReadCount) || 0;
        const driftCnt = Number(c.prefix_drift) || 0;
        const db = kv.driftBreakdown;
        let driftSpanHtml = `<span>${escapeHtml(t('bustDrift'))} <strong>${driftCnt}</strong></span>`;
        if (hasValidDriftBreakdown(db, driftCnt)) {
          const detailText = t('bustDriftBreakdown', {
            zero: Number(db.zeroRead),
            partial: Number(db.partialRead),
            unreported: Number(db.unreportedRead)
          });
          const driftTip = escapeHtml(t('bustDriftTip', { detail: detailText }));
          const inlineDetail = driftCnt > 0 ? `<span class="muted-note">${escapeHtml(t('bustDriftInline', { detail: detailText }))}</span>` : '';
          driftSpanHtml = `<span title="${driftTip}">${escapeHtml(t('bustDrift'))} <strong>${driftCnt}</strong>${inlineDetail}</span>`;
        }
        const turnNumByStep = new Map();
        if (!isMultiSessionKv) {
          for (const item of turns) {
            if (item && isNonNegFiniteCount(item.stepIndex) && isNonNegFiniteCount(item.turn)) {
              if (turnNumByStep.has(item.stepIndex)) {
                turnNumByStep.set(item.stepIndex, null);
              } else {
                turnNumByStep.set(item.stepIndex, item.turn);
              }
            }
          }
        }
        const fmtStepOrTurn = (stepVal) => {
          const mapped = turnNumByStep.get(stepVal);
          if (isNonNegFiniteCount(mapped)) return t('turnRefNum', { turn: mapped });
          return t('stepRefNum', { step: stepVal });
        };
        const priorKeyOf = (b) =>
          `${b.at ?? ''}|${isNonNegFiniteCount(b.stepIndex) ? b.stepIndex : '?'}|${b.priorContextMatch.referenceStepIndex}|${b.priorContextMatch.recoveryStepIndex}`;
        const bustPriors = Array.isArray(kv.recentBusts)
          ? kv.recentBusts.filter((b) => b && hasValidPriorContextMatch(b.priorContextMatch))
          : [];
        const bustPriorCounts = new Map();
        for (const b of bustPriors) {
          const k = priorKeyOf(b);
          bustPriorCounts.set(k, (bustPriorCounts.get(k) || 0) + 1);
        }
        const extraTurnPriors = [];
        for (const item of turns) {
          if (!item || !hasValidPriorContextMatch(item.priorContextMatch)) continue;
          const k = priorKeyOf(item);
          const rem = bustPriorCounts.get(k) || 0;
          if (rem > 0) {
            bustPriorCounts.set(k, rem - 1);
          } else {
            extraTurnPriors.push(item);
          }
        }
        const priorMatches = [...extraTurnPriors, ...bustPriors];
        const priorChipHtml =
          priorMatches.length > 0
            ? `<span title="${escapeHtml(
                priorMatches
                  .map((b) =>
                    t('priorContextMatchTipItem', {
                      bust: isNonNegFiniteCount(b.stepIndex) ? fmtStepOrTurn(b.stepIndex) : t('stepRefNum', { step: '?' }),
                      ref: fmtStepOrTurn(b.priorContextMatch.referenceStepIndex),
                      rec: fmtStepOrTurn(b.priorContextMatch.recoveryStepIndex)
                    })
                  )
                  .join(t('turnBustDetailSep'))
              )}">${escapeHtml(t('priorContextMatchChip'))} <strong>${priorMatches.length}</strong></span>`
            : '';
        causesEl.innerHTML = [
          `<span class="muted-note">${escapeHtml(t('bustsLabel'))}</span>`,
          `<span>${escapeHtml(t('bustTtl'))} <strong>${Number(c.ttl_idle_expiry) || 0}</strong></span>`,
          `<span>${escapeHtml(t('bustCompact'))} <strong>${Number(c.compaction_or_truncation) || 0}</strong></span>`,
          `<span>${escapeHtml(t('bustModel'))} <strong>${Number(c.model_switch) || 0}</strong></span>`,
          `<span>${escapeHtml(t('bustSysMsg'))} <strong>${Number(c.system_injection) || 0}</strong></span>`,
          `<span>${escapeHtml(t('bustMedia'))} <strong>${Number(c.multimodal_media) || 0}</strong></span>`,
          driftSpanHtml,
          priorChipHtml,
          dupCnt > 0 ? `<span class="val-warn">${escapeHtml(t('bustDupReads'))} <strong>${dupCnt}</strong></span>` : '',
          kv.cacheCreationTokensTotal ? `<span title="${escapeHtml(t('bustWritesTip', { mult: writeMult.toFixed(2) }))}">${escapeHtml(t('bustWrites'))} <strong>${Math.round(kv.cacheCreationTokensTotal / 1000)}k</strong></span>` : '',
          kv.thinkingTokensTotal ? `<span title="${escapeHtml(t('bustThinkTip'))}">${escapeHtml(t('bustThink'))} <strong>${Math.round(kv.thinkingTokensTotal / 1000)}k</strong></span>` : ''
        ].filter(Boolean).join('');
      }
      const shortGapRowEl = document.getElementById('kv-short-gap-row');
      if (shortGapRowEl) {
        const sg = kv.shortGapColdSummary && typeof kv.shortGapColdSummary === 'object' ? kv.shortGapColdSummary : null;
        const sgCountRaw = sg ? Number(sg.count) : 0;
        const sgCount = Number.isFinite(sgCountRaw) && sgCountRaw > 0 ? Math.floor(sgCountRaw) : 0;
        if (sgCount > 0) {
          const sgMinRaw = Number(sg.minGapSec);
          const sgMin = Number.isFinite(sgMinRaw) && sgMinRaw >= 0 ? Math.round(sgMinRaw) : 0;
          const sgKey = sg.attribution === 'server_cliff_likely' ? 'shortGapColdCliff' : 'shortGapColdUnknown';
          shortGapRowEl.innerHTML = `<span>${escapeHtml(t(sgKey, { count: sgCount, minGap: sgMin }))}</span>`;
          shortGapRowEl.classList.remove('hidden');
        } else {
          shortGapRowEl.classList.add('hidden');
          shortGapRowEl.innerHTML = '';
        }
      }
      if (handoffDrawerOpen) {
        renderHandoffWarmthHint();
      }
    }

    function stopWdLiveTimer() {
      if (wdLiveTimer !== null) {
        clearInterval(wdLiveTimer);
        wdLiveTimer = null;
      }
    }

    function renderWatchdogLocalTick() {
      const timerRow = document.getElementById('wd-timer-row');
      const timerText = document.getElementById('wd-timer-text');
      const barTrack = document.getElementById('wd-bar-track');
      const barFill = document.getElementById('wd-bar-fill');
      const sevBadge = document.getElementById('wd-severity-badge');

      if (!wdLiveState || !wdLiveState.stalledSec || wdLiveState.phase === 'IDLE') {
        if (timerRow) timerRow.classList.add('hidden');
        stopWdLiveTimer();
        return;
      }

      const nowClientMs = Date.now();
      if (Number.isFinite(wdLiveState.lastTickClientMs)) {
        const tickDeltaMs = nowClientMs - wdLiveState.lastTickClientMs;
        if (tickDeltaMs > 15000 || tickDeltaMs < -5000) {
          // Guard client tab against OS sleep/resume wall-clock jumps until Sidecar poll reconciles
          wdLiveState.sleepJumpOffsetMs = (wdLiveState.sleepJumpOffsetMs || 0) + (tickDeltaMs - 1000);
        }
      }
      wdLiveState.lastTickClientMs = nowClientMs;
      const elapsedLocalSec = Math.max(
        0,
        Math.round((nowClientMs - wdLiveState.syncedAtClientMs - (wdLiveState.sleepJumpOffsetMs || 0)) / 1000)
      );
      const silentSec = Math.max(0, (wdLiveState.baseSilentSec || 0) + elapsedLocalSec);
      const suspectSec = wdLiveState.suspectSec || Math.max(5, Math.round(wdLiveState.stalledSec * 0.6));
      const stalledSec = wdLiveState.stalledSec;
      const pct = Math.max(0, Math.min(100, (silentSec / stalledSec) * 100));

      let liveSev = wdLiveState.severity || 'active';
      if (liveSev !== 'snoozed') {
        if (silentSec >= stalledSec) liveSev = 'stalled';
        else if (silentSec >= suspectSec) liveSev = 'suspect';
        else liveSev = 'active';
      }

      if (timerRow) timerRow.classList.remove('hidden');
      if (timerText) {
        timerText.textContent = t('wdTimerFmt', {
          silent: fmtSec(silentSec),
          thresh: fmtSec(stalledSec),
          warn: fmtSec(suspectSec)
        });
        timerText.className = liveSev === 'stalled' ? 'ttl-text-danger' : liveSev === 'suspect' ? 'ttl-text-warn' : 'ttl-text-ok';
      }
      if (barFill) {
        barFill.style.width = `${pct.toFixed(1)}%`;
        barFill.className = liveSev === 'stalled' ? 'ttl-fill is-expired' : liveSev === 'suspect' ? 'ttl-fill is-expiring' : 'ttl-fill';
      }
      if (barTrack) {
        barTrack.className = liveSev === 'stalled' ? 'ttl-track is-expired' : liveSev === 'suspect' ? 'ttl-track is-expiring' : 'ttl-track';
      }
      if (sevBadge && wdLiveState.enabled) {
        if (liveSev === 'stalled') {
          sevBadge.className = 'meta-tag is-danger';
          sevBadge.textContent = t('wdSevStalled');
        } else if (liveSev === 'suspect') {
          sevBadge.className = 'meta-tag is-warn';
          sevBadge.textContent = t('wdSevSuspect');
        } else if (liveSev === 'snoozed') {
          sevBadge.className = 'meta-tag is-info';
          sevBadge.textContent = t('wdSevSnoozed');
        } else {
          sevBadge.className = 'meta-tag is-ok';
          sevBadge.textContent = t('wdSevActive');
        }
      }
    }

    const WD_BUCKET_I18N_KEYS = {
      llm_low_ctx: 'wdBucketLlmLow',
      llm_high_ctx: 'wdBucketLlmHigh',
      llm_compact: 'wdBucketLlmCompact',
      llm_multimodal_high_ctx: 'wdBucketLlmMedia',
      llm_reasoning: 'wdBucketLlmReasoning',
      llm_ultra_high_ctx: 'wdBucketLlmUltraHigh',
      llm_reasoning_compound: 'wdBucketLlmCompound',
      subagent_llm: 'wdBucketSubagentLlm',
      tool_sync_cmd: 'wdBucketToolCmd',
      tool_mcp_long: 'wdBucketToolMcpLong',
      tool_mcp_fast: 'wdBucketToolMcpFast',
      tool_read: 'wdBucketToolRead',
      tool_host: 'wdBucketToolHost',
      subagent_bg: 'wdBucketBg'
    };

    function formatWdBucketLabel(bucket, fallback) {
      const key = bucket && WD_BUCKET_I18N_KEYS[bucket];
      if (key) return t(key);
      return fallback || bucket || '';
    }

    function formatWdPhaseLabel(phase) {
      if (phase === 'LLM_INFLIGHT') return t('wdPhaseLlm');
      if (phase === 'TOOL_RUNNING') return t('wdPhaseTool');
      if (phase === 'SUBAGENT_BG') return t('wdPhaseBg');
      return t('wdPhaseIdle');
    }

    function renderSessionSwitcher(wd = cachedWatchdog) {
      const sessionSwitcher = document.getElementById('wd-session-switcher');
      if (!sessionSwitcher) return;
      const MAX_SWITCHER_ENTRIES = 8;
      const confirmedId = getConfirmedConversationId();
      const wdEnabled = Boolean(wd && wd.enabled !== false);
      const curId = confirmedId || getActiveConversationId() || (wdEnabled ? wd.current?.conversationId : '') || '';
      const leaseList = [];
      const leaseMap = new Map();

      if (wdEnabled && Array.isArray(wd.sessions)) {
        for (const s of wd.sessions) {
          if (!s || s.isSubagent || !isValidSwitcherConvId(s.conversationId)) continue;
          const cid = s.conversationId.trim();
          if (leaseMap.has(cid)) continue;
          const normalized = { ...s, conversationId: cid };
          leaseMap.set(cid, normalized);
          leaseList.push(normalized);
        }
      }

      const entries = [];
      const seen = new Set();
      const priorityIds = [selectedConvOverride, confirmedId, !window.sidecar ? inferredFallbackConvId : ''];
      for (const cand of priorityIds) {
        if (entries.length >= MAX_SWITCHER_ENTRIES) break;
        if (!isValidSwitcherConvId(cand)) continue;
        const cid = cand.trim();
        if (seen.has(cid)) continue;
        seen.add(cid);
        if (leaseMap.has(cid)) {
          entries.push(leaseMap.get(cid));
          continue;
        }
        const kvMatches = Boolean(
          cachedKv &&
            (cachedKv.resolvedConversationId === cid || cachedKv.ttlKeepalive?.conversationId === cid)
        );
        entries.push({
          conversationId: cid,
          workspaceLabel: '',
          convTitle: '',
          cwd: '',
          phase: 'IDLE',
          severity: 'idle',
          contextTokens: kvMatches ? Number(cachedKv.currentContextTokens || 0) : 0,
          watermark: kvMatches ? (cachedKv.watermark || '') : '',
          isSubagent: false
        });
      }

      for (const s of leaseList) {
        if (entries.length >= MAX_SWITCHER_ENTRIES) break;
        if (seen.has(s.conversationId)) continue;
        seen.add(s.conversationId);
        entries.push(s);
      }

      const needsConfirmEntry = entries.length >= 1 && (!isCurrentConversationConfirmed() || Boolean(selectedConvOverride));
      const shouldShowSwitcher =
        entries.length >= 2 ||
        needsConfirmEntry ||
        entries.some((s) => String(s.conversationId) !== curId);

      if (shouldShowSwitcher) {
        sessionSwitcher.classList.remove('hidden');
        sessionSwitcher.innerHTML =
          `<span class="wd-session-label">${escapeHtml(t('wdSessionsPrefix'))}</span>` +
          entries
            .slice(0, MAX_SWITCHER_ENTRIES)
            .map((s) => {
              const rawId = String(s.conversationId || '');
              const safeId = escapeHtml(rawId);
              const safeCwd = escapeHtml(s.cwd || '');
              const safeWsLabel = escapeHtml(s.workspaceLabel || '');
              const isCurrent = Boolean(confirmedId && rawId === confirmedId);
              const labelText = [s.workspaceLabel, s.convTitle]
                .map((v) => (typeof v === 'string' ? v.trim() : ''))
                .filter(Boolean)
                .join(' · ') || rawId.slice(0, 8);
              const ctxK = Number(s.contextTokens) >= 1000 ? ` · ${Math.round(Number(s.contextTokens) / 1000)}k` : '';
              let toneCls = '';
              if (s.severity === 'stalled' || s.watermark === 'critical') toneCls = ' is-danger';
              else if (s.severity === 'suspect' || s.watermark === 'warn') toneCls = ' is-warn';
              else if (s.phase && s.phase !== 'IDLE') toneCls = ' is-info';
              const curCls = isCurrent ? ' is-current' : '';
              const tipText = escapeHtml(
                isCurrent ? t('wdCurrentSessionTip', { id: rawId }) : t('wdJumpTip', { id: rawId })
              );
              const curAttr = isCurrent ? ' aria-current="true"' : '';
              return `<button type="button" class="wd-session-pill${toneCls}${curCls}" data-jump-conv="${safeId}" data-jump-cwd="${safeCwd}" data-jump-ws="${safeWsLabel}" title="${tipText}"${curAttr}><span class="wd-session-pill-text">${escapeHtml(labelText)}${escapeHtml(ctxK)}</span></button>`;
            })
            .join('');
      } else {
        sessionSwitcher.classList.add('hidden');
        sessionSwitcher.innerHTML = '';
      }
    }

    function renderWatchdogCard(wd, { preserveEpoch = false, expectedEpoch = null } = {}) {
      if (!wd) return;
      let hostSwitched = false;
      if (!preserveEpoch) {
        const prevEpoch = hostSwitchEpoch;
        syncNativeHostConversation({ reloadIfOpen: false });
        hostSwitched = hostSwitchEpoch !== prevEpoch;
        const stampedEpoch = Number.isFinite(expectedEpoch)
          ? expectedEpoch
          : Number.isFinite(wd._hostEpoch)
            ? wd._hostEpoch
            : null;
        if (stampedEpoch !== null && stampedEpoch !== hostSwitchEpoch) {
          updateWatchdogIncidentButtons();
          if (hostSwitched && handoffDrawerOpen) {
            clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: true });
          }
          return;
        }
        wd._hostEpoch = hostSwitchEpoch;
        cachedWatchdog = wd;
      }
      const sevBadge = document.getElementById('wd-severity-badge');
      const statusHint = document.getElementById('wd-status-hint');
      const phaseBadge = document.getElementById('wd-phase-badge');
      const bucketBadge = document.getElementById('wd-bucket-badge');
      const toolBadge = document.getElementById('wd-tool-badge');
      const metaExtra = document.getElementById('wd-meta-extra');
      const timerRow = document.getElementById('wd-timer-row');
      const rescueBox = document.getElementById('wd-rescue-box');
      const causeTitle = document.getElementById('wd-cause-title');
      const tipsList = document.getElementById('wd-tips-list');
      const otherAlerts = document.getElementById('wd-other-alerts');

      consumePendingJumpIfEligible(wd);

      updateFeaturePill('wd-enable-btn', t('wdEnableLabel'), wd.enabled !== false);
      updateFeaturePill('wd-notify-btn', t('wdNotifyLabel'), wd.desktopNotifyEnabled === true);
      if (wd.ttlDesktopNotifyEnabled !== undefined) {
        updateFeaturePill('kv-ttl-notify-btn', t('kvTtlNotifyLabel'), wd.ttlDesktopNotifyEnabled === true);
      }
      if (
        wd.globalTtlKeepaliveMaxCount !== undefined ||
        wd.ttlKeepalive?.globalMaxCount !== undefined ||
        wd.globalTtlKeepaliveMinContextPct !== undefined ||
        wd.ttlKeepalive?.minContextPct !== undefined ||
        wd.globalTtlKeepaliveIntervalSec !== undefined ||
        wd.ttlKeepalive?.globalIntervalSec !== undefined
      ) {
        syncGlobalKeepaliveFromPayload(
          wd.globalTtlKeepaliveMaxCount ?? wd.ttlKeepalive?.globalMaxCount,
          wd.fallbackTtlKeepaliveMaxCount ?? wd.ttlKeepalive?.fallbackMaxCount,
          wd.globalTtlKeepaliveMinContextPct ?? wd.ttlKeepalive?.minContextPct,
          wd.globalTtlKeepaliveIntervalSec ?? wd.ttlKeepalive?.globalIntervalSec
        );
      }
      if (wd.ttlKeepalive) {
        if (shouldAcceptKeepalivePayload(wd.ttlKeepalive)) {
          if (cachedKv) {
            cachedKv.ttlKeepalive = wd.ttlKeepalive;
          }
          if (
            wd.ttlKeepalive.hasLease === true &&
            wd.ttlKeepalive.leasePhase === 'IDLE' &&
            wd.ttlKeepalive.leaseSubphase === 'stopped' &&
            Number.isFinite(Number(wd.ttlKeepalive.cacheOriginTs)) &&
            Number(wd.ttlKeepalive.cacheOriginTs) > 0 &&
            Number.isFinite(Number(wd.ttlKeepalive.effectiveTtlSec)) &&
            Number(wd.ttlKeepalive.effectiveTtlSec) > 0
          ) {
            if (kvTtlState) {
              kvTtlState.lastPlannerMs = Math.floor(Number(wd.ttlKeepalive.cacheOriginTs));
              kvTtlState.cacheTtlSec = Math.floor(Number(wd.ttlKeepalive.effectiveTtlSec));
              if (Number.isFinite(Number(wd.serverNowMs)) && Number(wd.serverNowMs) > 0) {
                kvTtlState.clockOffsetMs = Number(wd.serverNowMs) - Date.now();
              }
            } else if (cachedKv) {
              syncKvTtlState(cachedKv);
            }
          }
          renderKeepaliveControls(wd.ttlKeepalive);
        } else if (window.sidecar && !getActiveConversationId()) {
          renderKeepaliveControls(unboundKeepaliveState);
        }
      }
      renderKeepaliveMinContextControls(
        inFlightMinCtxActionCount > 0
          ? cachedGlobalKeepalive.minContextPct
          : (wd.globalTtlKeepaliveMinContextPct ?? wd.ttlKeepalive?.minContextPct),
        cachedKv?.modelProfile?.windowTokens ?? wd.ttlKeepalive?.windowTokens ?? wd.current?.windowTokens
      );
      let shouldAutoSwitchLang = '';
      if (!preserveEpoch && wd.uiLangSource === 'default' && currentLang === 'zh' && !autoSyncedInitialZh) {
        autoSyncedInitialZh = true;
        syncUiLangToServer('zh');
      } else if (
        !preserveEpoch &&
        wd.uiLangSource &&
        wd.uiLangSource !== 'default' &&
        (wd.uiLang === 'zh' || wd.uiLang === 'en') &&
        !userSwitchedLang &&
        currentLang !== wd.uiLang
      ) {
        shouldAutoSwitchLang = wd.uiLang;
      }

      const nextIncidentKey =
        wd.enabled === false || !isWatchdogIncidentAlignedWithTarget({ requireActive: false })
          ? ''
          : computeWatchdogIncidentKey(wd.current || null);
      const nextCardConvId =
        wd.enabled === false || !isWatchdogIncidentAlignedWithTarget({ requireActive: false })
          ? ''
          : (typeof wd.current?.conversationId === 'string' ? wd.current.conversationId : '');
      const incidentChanged = !preserveEpoch && nextIncidentKey !== lastObservedWatchdogIncidentKey;
      const deferredToServerAheadSync =
        !preserveEpoch && !hostSwitched && isPendingServerAheadSyncMatch(nextIncidentKey, nextCardConvId);
      if (!preserveEpoch) {
        lastObservedWatchdogIncidentKey = nextIncidentKey;
        if (incidentChanged) {
          ++rescueCopySeq;
          if (!deferredToServerAheadSync) {
            ++handoffFetchSeq;
          }
        }
      }

      if (wd.enabled === false) {
        wdLiveState = null;
        stopWdLiveTimer();
        if (sevBadge) { sevBadge.className = 'meta-tag'; sevBadge.textContent = t('wdSevOff'); }
        if (phaseBadge) phaseBadge.classList.add('hidden');
        if (statusHint) { statusHint.textContent = t('wdHintOff'); statusHint.classList.remove('hidden'); }
        if (bucketBadge) bucketBadge.classList.add('hidden');
        if (toolBadge) toolBadge.classList.add('hidden');
        if (metaExtra) metaExtra.classList.add('hidden');
        if (timerRow) timerRow.classList.add('hidden');
        if (rescueBox) rescueBox.classList.add('hidden');
        if (otherAlerts) otherAlerts.classList.add('hidden');
        renderSessionSwitcher(wd);
        updateWatchdogIncidentButtons();
        if (kvTtlState) {
          renderLocalTtlCountdown();
        }
        if (!preserveEpoch && !deferredToServerAheadSync) {
          const isLegacyUnconfirmedRescueOnly = Boolean(
            !isCurrentConversationConfirmed() &&
              !handoffLoading &&
              cachedHandoffSnapshot &&
              cachedHandoffSnapshot.source === 'rescue' &&
              cachedHandoffSnapshot.mode !== 'agent' &&
              !cachedHandoffSnapshot.anchors
          );
          if (
            incidentChanged ||
            hostSwitched ||
            (cachedHandoffSnapshot && cachedHandoffSnapshot.markdown && !isHandoffSnapshotCurrent(cachedHandoffSnapshot))
          ) {
            clearHandoffSnapshot({
              resetPreview: true,
              reloadIfOpen: handoffDrawerOpen && !isLegacyUnconfirmedRescueOnly
            });
          } else if (handoffDrawerOpen) {
            renderHandoffWarmthHint();
            updateHandoffActionButtons();
          }
        }
        if (shouldAutoSwitchLang) {
          setLanguage(shouldAutoSwitchLang, false);
        }
        return;
      }

      const cur = wd.current || null;
      if (!cur || cur.phase === 'IDLE') {
        wdLiveState = null;
        stopWdLiveTimer();
        if (sevBadge) { sevBadge.className = 'meta-tag is-ok'; sevBadge.textContent = t('wdSevIdle'); }
        if (phaseBadge) phaseBadge.classList.add('hidden');
        if (statusHint) {
          statusHint.textContent = cur?.subphase === 'stopped_bg_pending' ? t('wdHintIdleBg') : t('wdHintIdle');
          statusHint.classList.remove('hidden');
        }
        if (bucketBadge) bucketBadge.classList.add('hidden');
        if (toolBadge) toolBadge.classList.add('hidden');
        if (metaExtra) {
          if (wd.sleepGuard?.triggeredCount > 0) {
            metaExtra.textContent = t('wdSleepGuardTag');
            metaExtra.className = 'meta-tag is-info';
            metaExtra.classList.remove('hidden');
          } else {
            metaExtra.classList.add('hidden');
          }
        }
        if (timerRow) timerRow.classList.add('hidden');
        if (rescueBox) rescueBox.classList.add('hidden');
      } else {
        if (statusHint) {
          statusHint.textContent = '';
          statusHint.classList.add('hidden');
        }
        if (phaseBadge) {
          phaseBadge.textContent = formatWdPhaseLabel(cur.phase);
          phaseBadge.className = cur.phase === 'SUBAGENT_BG' ? 'meta-tag is-info' : 'meta-tag';
        }
        if (bucketBadge) {
          const ctxPart = cur.contextTokens > 0 ? ` · ${Math.round(cur.contextTokens / 1000)}k` : '';
          const subPart = cur.isSubagent ? ` · ${t('wdSubagentTag')}` : '';
          const bucketText = formatWdBucketLabel(cur.bucket, cur.subphase || cur.phase);
          bucketBadge.textContent = `${bucketText}${ctxPart}${subPart}`;
          bucketBadge.title = [cur.workspaceLabel, cur.convTitle, cur.conversationId].filter(Boolean).join(' · ');
          bucketBadge.classList.remove('hidden');
        }
        if (toolBadge) {
          if (cur.activeTool) {
            const sum = cur.activeToolSummary ? `: ${cur.activeToolSummary.slice(0, 42)}` : '';
            toolBadge.textContent = `${cur.activeTool}${sum}`;
            toolBadge.title = cur.activeToolSummary || cur.activeTool;
            toolBadge.classList.remove('hidden');
          } else {
            toolBadge.classList.add('hidden');
          }
        }
        if (metaExtra) {
          if (cur.transcriptGrowing) {
            metaExtra.textContent = t('wdTranscriptGrowing');
            metaExtra.className = 'meta-tag is-ok';
            metaExtra.classList.remove('hidden');
          } else if (wd.sleepGuard?.triggeredCount > 0) {
            metaExtra.textContent = t('wdSleepGuardTag');
            metaExtra.className = 'meta-tag is-info';
            metaExtra.classList.remove('hidden');
          } else {
            metaExtra.classList.add('hidden');
          }
        }

        const syncedAtClientMs = Number.isFinite(wd._syncedAtClientMs) ? wd._syncedAtClientMs : Date.now();
        wd._syncedAtClientMs = syncedAtClientMs;
        wdLiveState = {
          enabled: true,
          conversationId: cur.conversationId,
          phase: cur.phase,
          severity: cur.severity,
          baseSilentSec: Number(cur.silentSec || 0),
          suspectSec: Number(cur.suspectSec || 0),
          stalledSec: Number(cur.stalledSec || 0),
          syncedAtClientMs,
          lastTickClientMs: Date.now(),
          sleepJumpOffsetMs: 0
        };
        renderWatchdogLocalTick();
        if (wdLiveTimer === null) {
          wdLiveTimer = setInterval(renderWatchdogLocalTick, 1000);
        }

        if (rescueBox && (cur.severity === 'suspect' || cur.severity === 'stalled')) {
          rescueBox.className = cur.severity === 'stalled' ? 'wd-rescue-box is-stalled' : 'wd-rescue-box';
          const diag = cur.diagnosis || null;
          if (causeTitle) {
            const label = diag ? (currentLang === 'zh' ? diag.labelZh : diag.label) : formatWdPhaseLabel(cur.phase);
            causeTitle.textContent = `${cur.severity === 'stalled' ? '!' : '~'} ${label}`;
          }
          if (tipsList) {
            const tips = diag ? (currentLang === 'zh' ? diag.tipsZh : diag.tips) : [];
            tipsList.innerHTML = (Array.isArray(tips) ? tips : [])
              .slice(0, 2)
              .map((tip) => `<li>${escapeHtml(tip)}</li>`)
              .join('');
          }
        } else if (rescueBox) {
          rescueBox.classList.add('hidden');
        }
      }

      if (otherAlerts) {
        const curId = cur?.conversationId || '';
        const others = (Array.isArray(wd.alertingSessions) ? wd.alertingSessions : []).filter(
          (s) => s.conversationId && s.conversationId !== curId
        );
        if (others.length > 0) {
          otherAlerts.classList.remove('hidden');
          otherAlerts.innerHTML =
            `<span>${escapeHtml(t('wdOtherAlertPrefix'))}</span>` +
            others
              .map((s) => {
                const rawId = String(s.conversationId || '');
                const labelText = [s.workspaceLabel, s.convTitle]
                  .map((v) => (typeof v === 'string' ? v.trim() : ''))
                  .filter(Boolean)
                  .join(' · ') || rawId.slice(0, 8);
                const displayLabel = escapeHtml(labelText);
                const fullIdTitle = escapeHtml(rawId);
                const safeCwd = escapeHtml(s.cwd || '');
                const safeWsLabel = escapeHtml(s.workspaceLabel || '');
                const sevTag = escapeHtml(s.severity === 'stalled' ? t('wdSevStalled') : t('wdSevSuspect'));
                const cls = s.severity === 'stalled' ? 'meta-tag is-danger' : 'meta-tag is-warn';
                const subMark = s.isSubagent ? ` (${escapeHtml(t('wdSubagentTag'))})` : '';
                return `<span class="${cls} wd-jump-pill is-clickable" role="button" tabindex="0" data-jump-conv="${fullIdTitle}" data-jump-cwd="${safeCwd}" data-jump-ws="${safeWsLabel}" title="${fullIdTitle}">${displayLabel}${subMark}: ${sevTag} ${escapeHtml(fmtSec(s.silentSec))}</span>`;
              })
              .join('');
        } else {
          otherAlerts.classList.add('hidden');
          otherAlerts.innerHTML = '';
        }
      }

      renderSessionSwitcher(wd);
      updateWatchdogIncidentButtons();
      if (kvTtlState) {
        renderLocalTtlCountdown();
      }
      if (!preserveEpoch && !deferredToServerAheadSync) {
        const nextRescue = getMatchingRescueBrief();
        const nextRescueKey = nextRescue ? (nextRescue.incidentKey || nextIncidentKey) : '';
        if (handoffDrawerOpen && nextRescue) {
          const snapAlreadyMatchesRescue = Boolean(
            cachedHandoffSnapshot &&
              (cachedHandoffSnapshot.source === 'rescue' || cachedHandoffSnapshot.source === 'rescue_api') &&
              cachedHandoffSnapshot.conversationId === nextRescue.conversationId &&
              (cachedHandoffSnapshot.incidentKey || '') === nextRescueKey &&
              cachedHandoffSnapshot.markdown === nextRescue.markdown &&
              isHandoffSnapshotCurrent(cachedHandoffSnapshot)
          );
          if (!snapAlreadyMatchesRescue) {
            ++handoffFetchSeq;
            handoffInFlightRequest = null;
            applyHandoffSnapshot(nextRescue, {
              source: 'rescue',
              scope: 'conversation',
              expectedConfirmed: isCurrentConversationConfirmed(),
              expectedConfirmedConv: getConfirmedConversationId(),
              incidentKey: nextRescueKey
            });
          }
        } else if (
          incidentChanged ||
          (cachedHandoffSnapshot && cachedHandoffSnapshot.markdown && !isHandoffSnapshotCurrent(cachedHandoffSnapshot))
        ) {
          const isLegacyUnconfirmedRescueOnly = Boolean(
            !isCurrentConversationConfirmed() &&
              !handoffLoading &&
              cachedHandoffSnapshot &&
              cachedHandoffSnapshot.source === 'rescue' &&
              cachedHandoffSnapshot.mode !== 'agent' &&
              !cachedHandoffSnapshot.anchors
          );
          if (
            !handoffDrawerOpen &&
            nextRescue &&
            cachedHandoffSnapshot &&
            (!cachedHandoffSnapshot.conversationId || nextRescue.conversationId === cachedHandoffSnapshot.conversationId)
          ) {
            ++handoffFetchSeq;
            handoffInFlightRequest = null;
            applyHandoffSnapshot(nextRescue, {
              source: 'rescue',
              scope: 'conversation',
              expectedConfirmed: isCurrentConversationConfirmed(),
              expectedConfirmedConv: getConfirmedConversationId(),
              incidentKey: nextRescueKey
            });
          } else {
            clearHandoffSnapshot({
              resetPreview: true,
              reloadIfOpen: handoffDrawerOpen && !isLegacyUnconfirmedRescueOnly
            });
          }
        } else if (hostSwitched && handoffDrawerOpen) {
          clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: true });
        } else if (handoffDrawerOpen) {
          renderHandoffWarmthHint();
          updateHandoffActionButtons();
        }
      }
      if (shouldAutoSwitchLang) {
        setLanguage(shouldAutoSwitchLang, false);
      }
    }

    function clearPendingJumpFallbackTimer() {
      if (pendingJumpFallbackTimer !== null) {
        clearTimeout(pendingJumpFallbackTimer);
        pendingJumpFallbackTimer = null;
      }
      pendingJumpFallbackId = '';
    }

    async function ackPendingJumpOnServer(jumpId) {
      if (!jumpId) return;
      try {
        await apiFetch('/api/watchdog/action', {
          method: 'POST',
          keepalive: true,
          body: JSON.stringify({
            scope: currentScope,
            conversationId: getActiveConversationId(),
            conversationConfirmed: isCurrentConversationConfirmed(),
            ...(window.sidecar ? { fromSidecarHost: true } : {}),
            action: 'ackJump',
            jumpId
          })
        });
      } catch {}
    }

    async function jumpToConversation(convId, opts = {}) {
      const targetId = typeof convId === 'string' ? convId.trim() : '';
      if (!isSpecificConversationId(targetId)) return { ok: false };
      const myJumpSeq = ++jumpActionSeq;

      const pillEl = opts?.pillEl || null;
      if (pillEl && pillEl.classList && typeof pillEl.classList.add === 'function') {
        if (lastFlashedPillEl && lastFlashedPillEl !== pillEl && lastFlashedPillEl.classList) {
          try { lastFlashedPillEl.classList.remove('is-jumped'); } catch {}
        }
        lastFlashedPillEl = pillEl;
        pillEl.classList.add('is-jumped');
        if (jumpPillFlashTimer !== null) clearTimeout(jumpPillFlashTimer);
        jumpPillFlashTimer = setTimeout(() => {
          try { pillEl.classList.remove('is-jumped'); } catch {}
          if (lastFlashedPillEl === pillEl) lastFlashedPillEl = null;
          jumpPillFlashTimer = null;
        }, 900);
      }

      const nativeId = getNativeHostConversationId();
      const hasHostToggle = typeof window.sidecar?.ui?.toggleConversation === 'function';

      if (opts && opts.fromPendingJump) {
        if (opts.jumpId) {
          rememberBoundedId(consumedJumpIds, opts.jumpId);
        }
        const nextOverride = targetId === nativeId ? '' : targetId;
        const convChanged = selectedConvOverride !== nextOverride;
        const scopeChanged = currentScope !== 'conversation';
        selectedConvOverride = nextOverride;
        pendingCustomOverrideConvId = '';
        sawOutOfOrderWatchdogAction = false;
        ++watchdogActionSeq;
        ++searchRequestSeq;
        if (scopeChanged) {
          applyScopeSelection('conversation');
        }
        if (convChanged || scopeChanged) {
          lastObservedWatchdogIncidentKey = '';
          resetManualWarmState();
          resetHandoffDrawerTargetMode();
          clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: handoffDrawerOpen });
          resetPanelGuidanceState();
          updateWatchdogIncidentButtons();
          renderSessionSwitcher(cachedWatchdog);
        }
        const ackPromise = opts.jumpId ? ackPendingJumpOnServer(opts.jumpId) : Promise.resolve();
        if (hasHostToggle) {
          try {
            window.sidecar.ui.toggleConversation(targetId);
          } catch {}
        }
        await ackPromise;
        if (myJumpSeq === jumpActionSeq) {
          refreshData(false);
        }
        return { ok: true, conversationId: targetId, fromPendingJump: true };
      }

      if (hasHostToggle) {
        try {
          window.sidecar.ui.toggleConversation(targetId);
        } catch {}
      }

      let sameWorkspaceConfirmed = false;
      let crossWorkspaceConfirmed = false;
      const targetCwd = typeof opts?.cwd === 'string' ? opts.cwd : '';
      const targetWsLabel = typeof opts?.workspaceLabel === 'string' ? opts.workspaceLabel : '';
      if (hasHostToggle && targetCwd) {
        const wsList = await resolveHostWorkspacePaths();
        if (wsList.length > 0) {
          sameWorkspaceConfirmed = doesWorkspaceMatchCwd(wsList, targetCwd, targetWsLabel);
          crossWorkspaceConfirmed = !sameWorkspaceConfirmed;
        }
      }
      if (!crossWorkspaceConfirmed && myJumpSeq === jumpActionSeq) {
        const nextOverride = targetId === nativeId ? '' : targetId;
        const convChanged = selectedConvOverride !== nextOverride;
        const scopeChanged = currentScope !== 'conversation';
        selectedConvOverride = nextOverride;
        pendingCustomOverrideConvId = '';
        sawOutOfOrderWatchdogAction = false;
        ++watchdogActionSeq;
        ++searchRequestSeq;
        if (scopeChanged) {
          applyScopeSelection('conversation');
        }
        if (convChanged || scopeChanged) {
          lastObservedWatchdogIncidentKey = '';
          resetManualWarmState();
          resetHandoffDrawerTargetMode();
          clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: handoffDrawerOpen });
          resetPanelGuidanceState();
          updateWatchdogIncidentButtons();
          renderSessionSwitcher(cachedWatchdog);
        }
      }

      try {
        ++refreshSeq;
        const reqHostEpoch = hostSwitchEpoch;
        const bodyPayload = {
          scope: currentScope,
          conversationId: targetId,
          conversationConfirmed: currentScope === 'conversation' && !crossWorkspaceConfirmed,
          ...(window.sidecar ? { fromSidecarHost: true } : {}),
          action: 'focusConversation'
        };
        if (sameWorkspaceConfirmed) {
          bodyPayload.skipOsFocus = true;
        }
        const res = await apiFetch('/api/watchdog/action', {
          method: 'POST',
          body: JSON.stringify(bodyPayload)
        });
        if (res.ok) {
          const data = await res.json();
          syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
          const createdJumpId = data?.pendingJump?.jumpId || '';
          if (createdJumpId) {
            rememberBoundedId(localOriginatedJumpIds, createdJumpId);
            if (sameWorkspaceConfirmed) {
              rememberBoundedId(consumedJumpIds, createdJumpId);
              await ackPendingJumpOnServer(createdJumpId);
            }
          }
          if (data && data.status && !crossWorkspaceConfirmed && myJumpSeq === jumpActionSeq && hostSwitchEpoch === reqHostEpoch) {
            renderWatchdogCard(
              { ...data.status, scope: data.status.scope || currentScope, _hostEpoch: reqHostEpoch },
              { expectedEpoch: reqHostEpoch }
            );
          }
        }
      } catch (e) {
        console.error(e);
      }

      if (myJumpSeq === jumpActionSeq) {
        refreshData(false);
      }
      return { ok: true, conversationId: targetId };
    }

    async function consumePendingJumpIfEligible(wd) {
      const pj = wd && wd.pendingJump && typeof wd.pendingJump === 'object' ? wd.pendingJump : null;
      if (!pj || !pj.jumpId || !pj.conversationId) {
        clearPendingJumpFallbackTimer();
        return false;
      }
      if (consumedJumpIds.has(pj.jumpId) || claimingJumpIds.has(pj.jumpId)) {
        return false;
      }
      if (typeof window.sidecar?.ui?.toggleConversation !== 'function') {
        return false;
      }
      if (localOriginatedJumpIds.has(pj.jumpId)) {
        const wsList = await resolveHostWorkspacePaths();
        if (pj.cwd && doesWorkspaceMatchCwd(wsList, pj.cwd, pj.workspaceLabel || '')) {
          rememberBoundedId(consumedJumpIds, pj.jumpId);
          const nativeId = getNativeHostConversationId();
          const nextOverride = pj.conversationId === nativeId ? '' : pj.conversationId;
          const changedConv = selectedConvOverride !== nextOverride;
          const changedScope = currentScope !== 'conversation';
          if (changedScope) {
            applyScopeSelection('conversation');
          }
          if (changedConv || changedScope) {
            selectedConvOverride = nextOverride;
            lastObservedWatchdogIncidentKey = '';
            resetManualWarmState();
            resetHandoffDrawerTargetMode();
            clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: handoffDrawerOpen });
            resetPanelGuidanceState();
            updateWatchdogIncidentButtons();
            renderSessionSwitcher(cachedWatchdog);
          }
          await ackPendingJumpOnServer(pj.jumpId);
          if (changedConv || changedScope) {
            refreshData(false);
          }
        }
        return false;
      }

      claimingJumpIds.add(pj.jumpId);
      try {
        const wsList = await resolveHostWorkspacePaths();
        if (consumedJumpIds.has(pj.jumpId)) return false;

        if (pj.cwd && wsList.length > 0) {
          const matchKind = classifyWorkspaceCwdMatch(wsList, pj.cwd, pj.workspaceLabel || '');
          const isWindowFocused = typeof document?.hasFocus !== 'function' || document.hasFocus();
          if (matchKind === 'exact' || (matchKind === 'ancestor' && isWindowFocused)) {
            clearPendingJumpFallbackTimer();
            await jumpToConversation(pj.conversationId, {
              fromPendingJump: true,
              jumpId: pj.jumpId,
              cwd: pj.cwd,
              workspaceLabel: pj.workspaceLabel || ''
            });
            return true;
          }
        }
      } finally {
        claimingJumpIds.delete(pj.jumpId);
      }

      if (typeof document !== 'undefined' && document.hidden === true) {
        return false;
      }
      if (pendingJumpFallbackId === pj.jumpId && pendingJumpFallbackTimer !== null) {
        return false;
      }
      clearPendingJumpFallbackTimer();
      const targetJumpId = pj.jumpId;
      pendingJumpFallbackId = targetJumpId;
      pendingJumpFallbackTimer = setTimeout(async () => {
        pendingJumpFallbackTimer = null;
        pendingJumpFallbackId = '';
        if (consumedJumpIds.has(targetJumpId) || localOriginatedJumpIds.has(targetJumpId)) return;
        try {
          const checkRes = await apiFetch('/api/watchdog', {
            method: 'POST',
            body: JSON.stringify({
              scope: currentScope,
              conversationId: getActiveConversationId(),
              conversationConfirmed: isCurrentConversationConfirmed(),
              ...(window.sidecar ? { fromSidecarHost: true } : {})
            })
          });
          if (!checkRes.ok) return;
          const latestWd = await checkRes.json();
          const latestPj = latestWd?.pendingJump;
          if (!latestPj || latestPj.jumpId !== targetJumpId || !latestPj.conversationId) {
            return;
          }
          await jumpToConversation(latestPj.conversationId, {
            fromPendingJump: true,
            jumpId: latestPj.jumpId,
            cwd: latestPj.cwd || '',
            workspaceLabel: latestPj.workspaceLabel || ''
          });
        } catch {}
      }, 1200);
      return false;
    }

    function findJumpTargetEl(startEl) {
      if (!startEl) return null;
      if (typeof startEl.closest === 'function') {
        return startEl.closest('[data-jump-conv]');
      }
      let curEl = startEl;
      while (curEl && curEl !== document) {
        if (curEl.dataset && curEl.dataset.jumpConv) return curEl;
        if (typeof curEl.getAttribute === 'function') {
          const attr = curEl.getAttribute('data-jump-conv');
          if (attr) return curEl;
        }
        curEl = curEl.parentElement || curEl.parentNode || null;
      }
      return null;
    }

    function handleWatchdogJumpEvent(ev) {
      if (!ev) return;
      if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') {
        return;
      }
      const pill = findJumpTargetEl(ev.target);
      if (!pill) return;
      const convId =
        (pill.dataset && pill.dataset.jumpConv) ||
        (typeof pill.getAttribute === 'function' ? pill.getAttribute('data-jump-conv') : '') ||
        '';
      const cwd =
        (pill.dataset && pill.dataset.jumpCwd) ||
        (typeof pill.getAttribute === 'function' ? pill.getAttribute('data-jump-cwd') : '') ||
        '';
      const workspaceLabel =
        (pill.dataset && pill.dataset.jumpWs) ||
        (typeof pill.getAttribute === 'function' ? pill.getAttribute('data-jump-ws') : '') ||
        '';
      if (!convId) return;
      if (ev.type === 'keydown' && typeof ev.preventDefault === 'function') {
        ev.preventDefault();
      }
      jumpToConversation(convId, { cwd, workspaceLabel, pillEl: pill });
    }

    function bindWatchdogJumpListeners() {
      for (const id of ['wd-other-alerts', 'wd-session-switcher']) {
        const el = document.getElementById(id);
        if (el && typeof el.addEventListener === 'function') {
          el.addEventListener('click', handleWatchdogJumpEvent);
          el.addEventListener('keydown', handleWatchdogJumpEvent);
        }
      }
    }

    async function copyWatchdogRescueBrief() {
      const btn = document.getElementById('wd-copy-rescue-btn');
      const nativeId = syncNativeHostConversation({ reloadIfOpen: false });
      updateWatchdogIncidentButtons();
      if (!isWatchdogIncidentAlignedWithTarget()) {
        return;
      }
      const activeConv = selectedConvOverride || nativeId || (!window.sidecar ? inferredFallbackConvId : '');
      const rescue = getMatchingRescueBrief();
      const reqIncidentKey = getCurrentWatchdogIncidentKey();
      const reqHostEpoch = hostSwitchEpoch;
      const reqScope = currentScope;
      const reqStallConvId = reqScope !== 'conversation' ? getCurrentWatchdogCardConversationId() : '';
      if (reqScope !== 'conversation' && (!reqStallConvId || !reqIncidentKey)) {
        return;
      }
      const startedWithDrawerOpen = handoffDrawerOpen;
      const startedWithDrawerTargeted = handoffDrawerTargetedAlert;
      const startedWithDrawerTargetedConvId = handoffDrawerTargetedConvId;
      const reqDrawerSelectionSeq = handoffDrawerSelectionSeq;
      const reqFetchSeq = handoffFetchSeq;
      let md = rescue?.markdown || '';
      if (!md) {
        const myCopySeq = ++rescueCopySeq;
        const confirmed = isCurrentConversationConfirmed();
        const confirmedConv = getConfirmedConversationId();
        const convId = reqScope === 'conversation' ? (confirmed ? confirmedConv : activeConv) : '';
        const matchingInFlight =
          handoffInFlightRequest &&
          handoffInFlightRequest.rawPromise &&
          handoffInFlightRequest.scope === reqScope &&
          handoffInFlightRequest.hostEpoch === reqHostEpoch &&
          handoffInFlightRequest.confirmed === confirmed &&
          handoffInFlightRequest.confirmedConv === confirmedConv &&
          (handoffInFlightRequest.conversationId || '') === convId &&
          (handoffInFlightRequest.stallConversationId || '') === reqStallConvId &&
          (handoffInFlightRequest.incidentKey || '') === (reqIncidentKey || '')
            ? handoffInFlightRequest
            : null;
        const reusedInFlight = Boolean(matchingInFlight);
        let data = null;
        try {
          if (matchingInFlight) {
            data = await matchingInFlight.rawPromise;
          } else {
            const res = await apiFetch('/api/handoff', {
              method: 'POST',
              body: JSON.stringify({
                scope: reqScope,
                conversationId: convId,
                ...(reqStallConvId ? { stallConversationId: reqStallConvId } : {}),
                mode: 'agent',
                includeStall: true,
                conversationConfirmed: confirmed,
                ...(window.sidecar ? { fromSidecarHost: true } : {})
              })
            });
            if (res.ok) {
              data = await res.json();
            }
          }
        } catch {}
        if (data && typeof data === 'object' && data.ok !== false) {
          syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
          const curIncidentKey = getCurrentWatchdogIncidentKey();
          const curCardConvId = getCurrentWatchdogCardConversationId();
          const hasDataIncidentKey = Boolean(typeof data.incidentKey === 'string');
          const dataIncidentKey = hasDataIncidentKey ? data.incidentKey : '';
          const dataStallConvId = typeof data?.stallConversationId === 'string' ? data.stallConversationId : '';
          const recoveredMismatch =
            ((reqScope === 'conversation' && confirmed) || Boolean(reqStallConvId)) &&
            hasDataIncidentKey &&
            dataIncidentKey === '' &&
            curIncidentKey !== '';
          const targetedStallMismatch =
            Boolean(reqStallConvId) &&
            (dataStallConvId !== reqStallConvId || dataIncidentKey !== curIncidentKey);
          const serverIncidentMismatch =
            recoveredMismatch ||
            targetedStallMismatch ||
            Boolean(dataIncidentKey && dataIncidentKey !== curIncidentKey);
          const stillTargetsRequest =
            myCopySeq === rescueCopySeq &&
            hostSwitchEpoch === reqHostEpoch &&
            currentScope === reqScope &&
            isCurrentConversationConfirmed() === confirmed &&
            getConfirmedConversationId() === confirmedConv &&
            isWatchdogIncidentAlignedWithTarget({ requireActive: Boolean(reqStallConvId || reqIncidentKey) }) &&
            curIncidentKey === reqIncidentKey &&
            (!reqStallConvId || curCardConvId === reqStallConvId);
          if (
            !stillTargetsRequest ||
            !isHandoffPayloadAttributionValid(data, {
              expectedScope: reqScope,
              expectedConfirmed: confirmed,
              expectedConfirmedConv: confirmedConv,
              requireScope: true,
              requireDisplayAnchor: true
            })
          ) {
            return;
          }
          if (serverIncidentMismatch) {
            refreshData(false);
            return;
          }
          md = typeof data.markdown === 'string' ? data.markdown : '';
          const canUpdateOpenDrawer = Boolean(
            !reusedInFlight &&
              md &&
              startedWithDrawerOpen &&
              handoffDrawerOpen &&
              !handoffLoading &&
              handoffDrawerSelectionSeq === reqDrawerSelectionSeq &&
              handoffFetchSeq === reqFetchSeq &&
              (!reqStallConvId ||
                (startedWithDrawerTargeted &&
                  handoffDrawerTargetedAlert &&
                  !handoffDrawerTargetedEnded &&
                  (!startedWithDrawerTargetedConvId || startedWithDrawerTargetedConvId === reqStallConvId) &&
                  (!handoffDrawerTargetedConvId || handoffDrawerTargetedConvId === reqStallConvId)))
          );
          if (canUpdateOpenDrawer) {
            ++handoffFetchSeq;
            handoffInFlightRequest = null;
            const resolvedRescueIncidentKey =
              ((reqScope === 'conversation' && confirmed) || Boolean(reqStallConvId)) && hasDataIncidentKey
                ? dataIncidentKey
                : dataIncidentKey || curIncidentKey;
            applyHandoffSnapshot(data, {
              source: 'rescue_api',
              scope: reqScope,
              expectedConfirmed: confirmed,
              expectedConfirmedConv: confirmedConv,
              incidentKey: resolvedRescueIncidentKey,
              ...(reqStallConvId ? { stallConversationId: dataStallConvId } : {})
            });
          }
        }
      }
      if (!md) return;
      const copied = await copyTextToClipboard(md);
      if (btn) {
        btn.textContent = copied ? t('copiedBtn') : t('copyFailedBtn');
        if (wdCopyResetTimer !== null) clearTimeout(wdCopyResetTimer);
        wdCopyResetTimer = setTimeout(() => {
          btn.textContent = t('wdCopyRescueBtn');
          wdCopyResetTimer = null;
        }, 2000);
      }
    }

    function openWatchdogRescueDrawer() {
      syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
      updateWatchdogIncidentButtons();
      if (!isWatchdogIncidentAlignedWithTarget()) {
        return;
      }
      const rescue = getMatchingRescueBrief();
      if (rescue && rescue.markdown) {
        resetHandoffDrawerTargetMode();
        ++handoffFetchSeq;
        const drawer = document.getElementById('kv-handoff-drawer');
        if (drawer) {
          handoffDrawerOpen = true;
          drawer.classList.remove('hidden');
        }
        const rescueIncidentKey = rescue.incidentKey || getCurrentWatchdogIncidentKey();
        applyHandoffSnapshot(rescue, {
          source: 'rescue',
          scope: 'conversation',
          expectedConfirmed: isCurrentConversationConfirmed(),
          expectedConfirmedConv: getConfirmedConversationId(),
          incidentKey: rescueIncidentKey
        });
        if (drawer && typeof drawer.scrollIntoView === 'function') {
          drawer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        return;
      }
      if (currentScope !== 'conversation') {
        const activeTarget = getActiveWatchdogCardTarget();
        if (!activeTarget.stallConversationId || !activeTarget.incidentKey) {
          return;
        }
        const drawer = document.getElementById('kv-handoff-drawer');
        if (drawer) {
          handoffDrawerOpen = true;
          drawer.classList.remove('hidden');
        }
        handoffDrawerTargetedAlert = true;
        handoffDrawerTargetedConvId = activeTarget.stallConversationId;
        handoffDrawerTargetedEnded = false;
        ++handoffDrawerSelectionSeq;
        loadHandoffBrief({
          forceRefresh: true,
          stallConversationId: activeTarget.stallConversationId,
          expectedIncidentKey: activeTarget.incidentKey
        });
        if (drawer && typeof drawer.scrollIntoView === 'function') {
          drawer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        return;
      }
      toggleHandoffDrawer(true);
    }

    async function sendWatchdogAction(payload) {
      const act = payload?.action || '';
      const isIncidentAct = act === 'ack' || act === 'snooze' || act === 'clear' || act === 'markIdle';
      const isManualWarmAct = act === 'manualTtlKeepalive';
      syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
      updateWatchdogIncidentButtons();
      if (
        isIncidentAct &&
        !isWatchdogIncidentAlignedWithTarget({ requireActive: act === 'ack' || act === 'snooze' })
      ) {
        return { ok: false, cancelled: true, reason: 'watchdog_target_unaligned' };
      }
      if (
        isManualWarmAct &&
        (!isCurrentConversationConfirmed() ||
          !payload?.conversationId ||
          payload.conversationId !== getConfirmedConversationId())
      ) {
        return { ok: false, cancelled: true, reason: 'manual_warm_target_unaligned' };
      }

      const reqActionSeq = ++watchdogActionSeq;
      latestStartedWatchdogActionSeq = reqActionSeq;
      inFlightWatchdogActionCount += 1;
      if (inFlightWatchdogActionCount > 1) {
        sawOutOfOrderWatchdogAction = true;
      }
      ++refreshSeq;
      const reqScope = currentScope;
      const reqNativeId = getNativeHostConversationId();
      const reqHostEpoch = hostSwitchEpoch;
      const activeId = getActiveConversationId();
      const confirmedId = getConfirmedConversationId();
      const curWd = cachedWatchdog?.current || null;
      const fallbackPrimaryConv =
        cachedWatchdog?.ttlKeepalive?.conversationId ||
        (!curWd?.isSubagent ? curWd?.conversationId : '') ||
        '';
      const convId = isIncidentAct
        ? (curWd?.conversationId || '')
        : (activeId || (window.sidecar ? '' : fallbackPrimaryConv));
      const confirmed = isIncidentAct
        ? Boolean(reqScope === 'conversation' && confirmedId && convId === confirmedId)
        : isCurrentConversationConfirmed();
      try {
        const res = await apiFetch('/api/watchdog/action', {
          method: 'POST',
          body: JSON.stringify({
            scope: reqScope,
            conversationId: convId,
            conversationConfirmed: confirmed,
            ...payload,
            ...(window.sidecar ? { fromSidecarHost: true } : {})
          })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
        if (
          reqActionSeq !== watchdogActionSeq ||
          hostSwitchEpoch !== reqHostEpoch ||
          currentScope !== reqScope ||
          getNativeHostConversationId() !== reqNativeId ||
          (isIncidentAct &&
            (isCurrentConversationConfirmed() !== confirmed ||
              (confirmed && getConfirmedConversationId() !== convId)))
        ) {
          if (latestStartedWatchdogActionSeq === watchdogActionSeq) {
            sawOutOfOrderWatchdogAction = true;
          }
          return data;
        }
        latestAppliedWatchdogActionSeq = reqActionSeq;
        pendingCustomOverrideConvId = '';
        if (inFlightWatchdogActionCount > 1 && latestStartedWatchdogActionSeq === watchdogActionSeq) {
          sawOutOfOrderWatchdogAction = true;
        }
        if (data && data.status) {
          const nextWd = { ...data.status, scope: data.status.scope || reqScope, _hostEpoch: reqHostEpoch };
          if (
            data.status.enabled === false ||
            payload?.action === 'clear' ||
            payload?.action === 'markIdle' ||
            (data.status.current &&
              data.status.current.phase === 'IDLE' &&
              data.status.current.subphase !== 'stopped_bg_pending')
          ) {
            if (cachedKv) cachedKv.conversationActive = false;
            if (kvTtlState) kvTtlState.conversationActive = false;
          }
          if (cachedKv && data.status.ttlKeepalive && shouldAcceptKeepalivePayload(data.status.ttlKeepalive)) {
            cachedKv.ttlKeepalive = data.status.ttlKeepalive;
          }
          renderWatchdogCard(nextWd, { expectedEpoch: reqHostEpoch });
        } else {
          refreshData(false);
        }
        return data;
      } catch (err) {
        if (
          (reqActionSeq !== watchdogActionSeq || inFlightWatchdogActionCount > 1) &&
          latestStartedWatchdogActionSeq === watchdogActionSeq
        ) {
          sawOutOfOrderWatchdogAction = true;
        }
        throw err;
      } finally {
        inFlightWatchdogActionCount = Math.max(0, inFlightWatchdogActionCount - 1);
        if (inFlightWatchdogActionCount === 0) {
          pendingCustomOverrideConvId = '';
          if (sawOutOfOrderWatchdogAction && latestStartedWatchdogActionSeq === watchdogActionSeq) {
            sawOutOfOrderWatchdogAction = false;
            refreshData(true);
          }
        }
      }
    }

    async function snoozeWatchdogAlert() {
      try {
        await sendWatchdogAction({ action: 'ack', snoozeSec: 300 });
      } catch (e) {
        console.error(e);
      }
    }

    async function markWatchdogIdle() {
      try {
        await sendWatchdogAction({ action: 'clear' });
      } catch (e) {
        console.error(e);
      }
    }

    async function toggleWatchdogEnabled() {
      const btn = document.getElementById('wd-enable-btn');
      const next = btn?.dataset?.enabled !== '1';
      try {
        await sendWatchdogAction({ action: 'setEnabled', enabled: next });
      } catch (e) {
        console.error(e);
      }
    }

    async function toggleWatchdogNotify() {
      const btn = document.getElementById('wd-notify-btn');
      const next = btn?.dataset?.enabled !== '1';
      try {
        await sendWatchdogAction({ action: 'setDesktopNotify', enabled: next });
      } catch (e) {
        console.error(e);
      }
    }

    const KEEPALIVE_INTERVAL_PRESETS = [0, 240, 540, 900];
    let cachedGlobalKeepalive = { globalMaxCount: 0, fallbackMaxCount: 1, minContextPct: 15, globalIntervalSec: 0 };
    let globalCustomIntervalOpen = false;
    let windowCustomIntervalOpen = false;
    let minCtxActionSeq = 0;
    let inFlightMinCtxActionCount = 0;
    let unboundKeepaliveState = {
      enabled: false,
      maxCount: 1,
      globalMaxCount: 0,
      fallbackMaxCount: 1,
      intervalSec: 0,
      globalIntervalSec: 0,
      isCustomOverride: false,
      usedCount: 0,
      coldMissTripped: false,
      lastError: ''
    };

    function normalizeKeepaliveIntervalSecClient(raw, fallback = 0) {
      if (raw === null || raw === undefined || raw === '') return fallback;
      const n = Number(raw);
      if (!Number.isFinite(n)) return fallback;
      const floored = Math.floor(n);
      if (floored <= 0) return 0;
      return Math.min(3600, Math.max(60, floored));
    }

    function syncKeepaliveIntervalOptionLabels(prefix) {
      const mapping = [
        ['0', 'kvKeepaliveIntervalAuto'],
        ['240', 'kvKeepaliveInterval4m'],
        ['540', 'kvKeepaliveInterval9m'],
        ['900', 'kvKeepaliveInterval15m'],
        ['custom', 'kvKeepaliveIntervalCustom']
      ];
      for (const [suffix, key] of mapping) {
        const opt = document.getElementById(`${prefix}-opt-${suffix}`);
        if (opt) opt.textContent = t(key);
      }
    }

    function resolveActiveWindowCapTokens(explicitWinTokens) {
      const candidates = [
        explicitWinTokens,
        cachedKv?.modelProfile?.windowTokens,
        cachedKv?.ttlKeepalive?.windowTokens,
        cachedWatchdog?.ttlKeepalive?.windowTokens,
        cachedWatchdog?.current?.windowTokens
      ];
      for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n >= 8000) return Math.floor(n);
      }
      return 200000;
    }

    function renderKeepaliveMinContextControls(rawPct, rawWinTokens) {
      const pctInput = document.getElementById('ka-min-ctx-pct-input');
      const hintEl = document.getElementById('ka-min-ctx-k-hint');
      const ctrlEl = document.getElementById('ka-min-ctx-control');
      const lblEl = document.getElementById('ka-min-ctx-label');
      const pct = Number.isFinite(Number(rawPct))
        ? Math.min(100, Math.max(0, Math.floor(Number(rawPct))))
        : cachedGlobalKeepalive.minContextPct;
      const winTokens = resolveActiveWindowCapTokens(rawWinTokens);
      if (lblEl) lblEl.textContent = t('kaMinCtxLabel');
      if (ctrlEl) ctrlEl.title = t('kaMinCtxTip');
      if (pctInput && document.activeElement !== pctInput) {
        pctInput.value = String(pct);
      }
      if (hintEl) {
        if (pct <= 0) {
          hintEl.textContent = t('kaMinCtxNoMin');
        } else {
          const minTok = Math.round((winTokens * pct) / 100);
          const kNum = Math.round(minTok / 1000);
          const kStr = kNum > 0 ? `${kNum}k` : `${(minTok / 1000).toFixed(1)}k`;
          const winK = Math.round(winTokens / 1000);
          hintEl.textContent = `≈${kStr}/${winK}k`;
        }
      }
    }

    async function changeTtlKeepaliveMinContextPct(rawVal) {
      const prevPct = cachedGlobalKeepalive.minContextPct;
      const pctInput = document.getElementById('ka-min-ctx-pct-input');
      const trimmed = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim();
      if (trimmed === '' || !Number.isFinite(Number(trimmed))) {
        if (pctInput) pctInput.value = String(prevPct);
        renderKeepaliveMinContextControls(prevPct);
        return;
      }
      const parsed = Math.min(100, Math.max(0, Math.floor(Number(trimmed))));
      if (pctInput) pctInput.value = String(parsed);
      cachedGlobalKeepalive = { ...cachedGlobalKeepalive, minContextPct: parsed };
      renderKeepaliveMinContextControls(parsed);
      const myMinCtxSeq = ++minCtxActionSeq;
      inFlightMinCtxActionCount += 1;
      const expectedSeq = watchdogActionSeq + 1;
      try {
        const data = await sendWatchdogAction({
          action: 'setTtlKeepaliveMinContextPct',
          minContextPct: parsed
        });
        const effPct = data?.globalTtlKeepaliveMinContextPct ?? data?.status?.globalTtlKeepaliveMinContextPct;
        if (myMinCtxSeq === minCtxActionSeq && Number.isFinite(Number(effPct))) {
          const snapped = Math.min(100, Math.max(0, Math.floor(Number(effPct))));
          cachedGlobalKeepalive = { ...cachedGlobalKeepalive, minContextPct: snapped };
          if (pctInput) pctInput.value = String(snapped);
          renderKeepaliveMinContextControls(snapped);
        }
      } catch (e) {
        console.error(e);
        if (myMinCtxSeq === minCtxActionSeq && watchdogActionSeq === expectedSeq) {
          cachedGlobalKeepalive = { ...cachedGlobalKeepalive, minContextPct: prevPct };
          if (pctInput) pctInput.value = String(prevPct);
          renderKeepaliveMinContextControls(prevPct);
        }
      } finally {
        inFlightMinCtxActionCount = Math.max(0, inFlightMinCtxActionCount - 1);
      }
    }

    function syncGlobalKeepaliveFromPayload(rawGlobalMax, rawFallbackMax, rawMinContextPct, rawGlobalIntervalSec) {
      const nextGlobal = Number.isFinite(Number(rawGlobalMax))
        ? Math.min(20, Math.max(0, Math.floor(Number(rawGlobalMax))))
        : cachedGlobalKeepalive.globalMaxCount;
      const nextFallback = Number.isFinite(Number(rawFallbackMax)) && Number(rawFallbackMax) >= 1
        ? Math.min(20, Math.max(1, Math.floor(Number(rawFallbackMax))))
        : nextGlobal >= 1
          ? nextGlobal
          : cachedGlobalKeepalive.fallbackMaxCount;
      const nextMinPct =
        inFlightMinCtxActionCount > 0
          ? cachedGlobalKeepalive.minContextPct
          : Number.isFinite(Number(rawMinContextPct))
            ? Math.min(100, Math.max(0, Math.floor(Number(rawMinContextPct))))
            : cachedGlobalKeepalive.minContextPct;
      const nextGlobalInterval =
        rawGlobalIntervalSec !== undefined && rawGlobalIntervalSec !== null
          ? normalizeKeepaliveIntervalSecClient(rawGlobalIntervalSec, cachedGlobalKeepalive.globalIntervalSec)
          : cachedGlobalKeepalive.globalIntervalSec;
      cachedGlobalKeepalive = {
        globalMaxCount: nextGlobal,
        fallbackMaxCount: nextFallback,
        minContextPct: nextMinPct,
        globalIntervalSec: nextGlobalInterval
      };
      if (!unboundKeepaliveState.isCustomOverride) {
        unboundKeepaliveState = {
          ...unboundKeepaliveState,
          enabled: nextGlobal >= 1,
          maxCount: nextGlobal >= 1 ? nextGlobal : nextFallback,
          globalMaxCount: nextGlobal,
          fallbackMaxCount: nextFallback,
          intervalSec: nextGlobalInterval,
          globalIntervalSec: nextGlobalInterval
        };
      }
      renderGlobalKeepaliveControls(nextGlobal, nextFallback, nextGlobalInterval);
      renderKeepaliveMinContextControls(nextMinPct);
    }

    function renderGlobalKeepaliveControls(rawGlobalMax, rawFallbackMax, rawGlobalIntervalSec) {
      const btn = document.getElementById('kv-global-keepalive-btn');
      const grp = document.getElementById('kv-global-keepalive-group');
      const maxInput = document.getElementById('kv-global-keepalive-max');
      const intervalSelect = document.getElementById('kv-global-keepalive-interval');
      const customWrap = document.getElementById('kv-global-keepalive-interval-custom-wrap');
      const customInput = document.getElementById('kv-global-keepalive-interval-custom');
      const globalMax = Number.isFinite(Number(rawGlobalMax))
        ? Math.min(20, Math.max(0, Math.floor(Number(rawGlobalMax))))
        : cachedGlobalKeepalive.globalMaxCount;
      const fallbackMax = Number.isFinite(Number(rawFallbackMax)) && Number(rawFallbackMax) >= 1
        ? Math.min(20, Math.max(1, Math.floor(Number(rawFallbackMax))))
        : globalMax >= 1
          ? globalMax
          : cachedGlobalKeepalive.fallbackMaxCount;
      const globalInterval =
        rawGlobalIntervalSec !== undefined && rawGlobalIntervalSec !== null
          ? normalizeKeepaliveIntervalSecClient(rawGlobalIntervalSec, cachedGlobalKeepalive.globalIntervalSec)
          : cachedGlobalKeepalive.globalIntervalSec;
      const isOn = globalMax >= 1;
      if (btn) {
        if (btn.dataset) {
          btn.dataset.max = String(globalMax);
          btn.dataset.fallback = String(fallbackMax);
          btn.dataset.interval = String(globalInterval);
        }
        btn.className = isOn ? 'toggle-chip is-on' : 'toggle-chip';
        const label = t('kvGlobalKeepaliveLabel');
        const sep = currentLang === 'zh' ? '：' : ': ';
        btn.innerText = isOn ? `${label}${sep}×` : `${label}${sep}${t('stateOff')}`;
        btn.title = t('kvGlobalKeepaliveTip');
      }
      if (grp) {
        grp.className = isOn
          ? 'keepalive-group keepalive-global-group is-on'
          : 'keepalive-group keepalive-global-group';
      }
      if (maxInput && document.activeElement !== maxInput) {
        maxInput.value = String(globalMax);
      }
      syncKeepaliveIntervalOptionLabels('kv-global-keepalive-interval');
      const isPreset = KEEPALIVE_INTERVAL_PRESETS.includes(globalInterval);
      const showCustom = !isPreset || globalCustomIntervalOpen;
      if (intervalSelect) {
        intervalSelect.title = t('kvGlobalKeepaliveIntervalTip');
        if (document.activeElement !== intervalSelect) {
          intervalSelect.value = showCustom ? 'custom' : String(globalInterval);
        }
      }
      if (customWrap) {
        customWrap.title = t('kvKeepaliveIntervalCustomTip');
        customWrap.className = showCustom
          ? 'keepalive-interval-custom-wrap'
          : 'keepalive-interval-custom-wrap hidden';
      }
      if (customInput && !isPreset && document.activeElement !== customInput) {
        customInput.value = String(Math.max(1, Math.min(60, Math.round(globalInterval / 60))));
      }
    }

    async function toggleGlobalTtlKeepalive() {
      const btn = document.getElementById('kv-global-keepalive-btn');
      const curGlobal = Number.isFinite(Number(btn?.dataset?.max))
        ? Math.min(20, Math.max(0, Math.floor(Number(btn.dataset.max))))
        : cachedGlobalKeepalive.globalMaxCount;
      const curFallback = Number.isFinite(Number(btn?.dataset?.fallback)) && Number(btn?.dataset?.fallback) >= 1
        ? Math.min(20, Math.max(1, Math.floor(Number(btn.dataset.fallback))))
        : cachedGlobalKeepalive.fallbackMaxCount;
      const nextMax = curGlobal >= 1 ? 0 : curFallback;
      return changeGlobalTtlKeepaliveMax(nextMax);
    }

    async function changeGlobalTtlKeepaliveMax(rawVal) {
      const prevGlobalMax = cachedGlobalKeepalive.globalMaxCount;
      const prevFallbackMax = cachedGlobalKeepalive.fallbackMaxCount;
      const prevUnbound = { ...unboundKeepaliveState };
      const prevWindowSnap = snapshotKeepaliveUiState();
      const trimmed = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim();
      const maxInput = document.getElementById('kv-global-keepalive-max');
      if (trimmed === '' || !Number.isFinite(Number(trimmed))) {
        if (maxInput) maxInput.value = String(prevGlobalMax);
        return;
      }
      const parsed = Math.min(20, Math.max(0, Math.floor(Number(trimmed))));
      const nextFallback = parsed >= 1 ? parsed : prevFallbackMax;
      if (maxInput) maxInput.value = String(parsed);
      syncGlobalKeepaliveFromPayload(parsed, nextFallback);
      const curTargetId = resolveKeepaliveConversationId() || '__default__';
      const hasInFlightWindowCustom =
        Boolean(pendingCustomOverrideConvId) && pendingCustomOverrideConvId === curTargetId;
      if (!prevWindowSnap.isSubagent && !prevWindowSnap.isCustomOverride && !hasInFlightWindowCustom) {
        renderKeepaliveControls({
          ...prevWindowSnap,
          enabled: parsed >= 1,
          maxCount: parsed >= 1 ? parsed : nextFallback,
          globalMaxCount: parsed,
          fallbackMaxCount: nextFallback
        });
      }
      const expectedSeq = watchdogActionSeq + 1;
      try {
        const data = await sendWatchdogAction({
          action: 'setGlobalTtlKeepalive',
          maxCount: parsed
        });
        if (
          watchdogActionSeq === expectedSeq &&
          maxInput &&
          data &&
          Number.isFinite(Number(data.globalTtlKeepaliveMaxCount)) &&
          Number(data.globalTtlKeepaliveMaxCount) !== parsed
        ) {
          maxInput.value = String(Math.min(20, Math.max(0, Math.floor(Number(data.globalTtlKeepaliveMaxCount)))));
        }
      } catch (e) {
        console.error(e);
        if (watchdogActionSeq === expectedSeq) {
          cachedGlobalKeepalive = {
            ...cachedGlobalKeepalive,
            globalMaxCount: prevGlobalMax,
            fallbackMaxCount: prevFallbackMax
          };
          unboundKeepaliveState = prevUnbound;
          renderGlobalKeepaliveControls(prevGlobalMax, prevFallbackMax, cachedGlobalKeepalive.globalIntervalSec);
          renderKeepaliveControls(prevWindowSnap);
        }
      }
    }

    async function commitGlobalTtlKeepaliveInterval(nextIntervalSec) {
      const prevGlobalInterval = cachedGlobalKeepalive.globalIntervalSec;
      const prevUnbound = { ...unboundKeepaliveState };
      const prevWindowSnap = snapshotKeepaliveUiState();
      const parsed = normalizeKeepaliveIntervalSecClient(nextIntervalSec, 0);
      globalCustomIntervalOpen = false;
      syncGlobalKeepaliveFromPayload(
        cachedGlobalKeepalive.globalMaxCount,
        cachedGlobalKeepalive.fallbackMaxCount,
        undefined,
        parsed
      );
      const curTargetId = resolveKeepaliveConversationId() || '__default__';
      const hasInFlightWindowCustom =
        Boolean(pendingCustomOverrideConvId) && pendingCustomOverrideConvId === curTargetId;
      if (!prevWindowSnap.isSubagent && !prevWindowSnap.isCustomOverride && !hasInFlightWindowCustom) {
        renderKeepaliveControls({
          ...prevWindowSnap,
          intervalSec: parsed,
          globalIntervalSec: parsed
        });
      }
      const expectedSeq = watchdogActionSeq + 1;
      try {
        const data = await sendWatchdogAction({
          action: 'setGlobalTtlKeepaliveInterval',
          intervalSec: parsed
        });
        const effInterval = data?.globalTtlKeepaliveIntervalSec ?? data?.status?.globalTtlKeepaliveIntervalSec;
        if (watchdogActionSeq === expectedSeq && Number.isFinite(Number(effInterval))) {
          const snapped = normalizeKeepaliveIntervalSecClient(effInterval, parsed);
          syncGlobalKeepaliveFromPayload(
            cachedGlobalKeepalive.globalMaxCount,
            cachedGlobalKeepalive.fallbackMaxCount,
            undefined,
            snapped
          );
        }
      } catch (e) {
        console.error(e);
        if (watchdogActionSeq === expectedSeq) {
          cachedGlobalKeepalive = {
            ...cachedGlobalKeepalive,
            globalIntervalSec: prevGlobalInterval
          };
          unboundKeepaliveState = prevUnbound;
          renderGlobalKeepaliveControls(
            cachedGlobalKeepalive.globalMaxCount,
            cachedGlobalKeepalive.fallbackMaxCount,
            prevGlobalInterval
          );
          renderKeepaliveControls(prevWindowSnap);
        }
      }
    }

    async function changeGlobalTtlKeepaliveInterval(rawPreset) {
      const str = String(rawPreset ?? '').trim();
      if (str === 'custom') {
        globalCustomIntervalOpen = true;
        const customInput = document.getElementById('kv-global-keepalive-interval-custom');
        const curSec = cachedGlobalKeepalive.globalIntervalSec;
        if (customInput) {
          customInput.value = String(curSec >= 60 ? Math.max(1, Math.min(60, Math.round(curSec / 60))) : 5);
        }
        renderGlobalKeepaliveControls(
          cachedGlobalKeepalive.globalMaxCount,
          cachedGlobalKeepalive.fallbackMaxCount,
          curSec
        );
        if (customInput && typeof customInput.focus === 'function') customInput.focus();
        if (customInput && typeof customInput.select === 'function') customInput.select();
        return;
      }
      return commitGlobalTtlKeepaliveInterval(normalizeKeepaliveIntervalSecClient(str, 0));
    }

    async function changeGlobalTtlKeepaliveCustomMin(rawMin) {
      const trimmed = rawMin === null || rawMin === undefined ? '' : String(rawMin).trim();
      const num = Number(trimmed);
      if (trimmed === '' || !Number.isFinite(num)) {
        globalCustomIntervalOpen = false;
        renderGlobalKeepaliveControls(
          cachedGlobalKeepalive.globalMaxCount,
          cachedGlobalKeepalive.fallbackMaxCount,
          cachedGlobalKeepalive.globalIntervalSec
        );
        return;
      }
      const mins = Math.min(60, Math.max(1, Math.floor(num)));
      const customInput = document.getElementById('kv-global-keepalive-interval-custom');
      if (customInput) customInput.value = String(mins);
      return commitGlobalTtlKeepaliveInterval(mins * 60);
    }

    function resolveKeepaliveConversationId() {
      const activeId = getActiveConversationId();
      if (activeId) return activeId;
      if (!window.sidecar) {
        return (
          cachedWatchdog?.ttlKeepalive?.conversationId ||
          cachedKv?.ttlKeepalive?.conversationId ||
          (!cachedWatchdog?.current?.isSubagent ? cachedWatchdog?.current?.conversationId : '') ||
          ''
        );
      }
      return '__unbound__';
    }

    function shouldAcceptKeepalivePayload(ka) {
      if (!ka || typeof ka !== 'object') return false;
      if (ka.conversationId === undefined) return true;
      const activeId = getActiveConversationId();
      if (activeId) {
        return ka.conversationId === activeId;
      }
      if (window.sidecar) {
        if (ka.conversationId === '__unbound__') {
          unboundKeepaliveState = { ...unboundKeepaliveState, ...ka };
          return true;
        }
        return false;
      }
      return true;
    }

    function snapshotKeepaliveUiState() {
      const btn = document.getElementById('kv-keepalive-btn');
      const maxInput = document.getElementById('kv-keepalive-max');
      const isSubagent = btn ? btn.dataset?.subagent === '1' : false;
      const isCustomOverride = !isSubagent && (btn ? btn.dataset?.custom === '1' : false);
      const coldMissTripped = !isSubagent && (btn ? btn.dataset?.cold === '1' : false);
      const intervalSec = btn && btn.dataset?.interval !== undefined && btn.dataset?.interval !== ''
        ? normalizeKeepaliveIntervalSecClient(btn.dataset.interval, cachedGlobalKeepalive.globalIntervalSec)
        : cachedGlobalKeepalive.globalIntervalSec;
      return {
        isSubagent,
        isCustomOverride,
        coldMissTripped,
        enabled: !isSubagent && btn?.dataset?.enabled === '1',
        maxCount: Math.min(20, Math.max(1, parseInt(btn?.dataset?.max || maxInput?.value || '1', 10) || 1)),
        intervalSec,
        usedCount: isSubagent ? 0 : Math.max(0, parseInt(btn?.dataset?.used || '0', 10) || 0)
      };
    }

    function renderKeepaliveControls(ka) {
      const btn = document.getElementById('kv-keepalive-btn');
      const grp = document.getElementById('kv-keepalive-group');
      const maxInput = document.getElementById('kv-keepalive-max');
      const intervalSelect = document.getElementById('kv-keepalive-interval');
      const customWrap = document.getElementById('kv-keepalive-interval-custom-wrap');
      const customInput = document.getElementById('kv-keepalive-interval-custom');
      const followBtn = document.getElementById('kv-keepalive-follow-btn');
      const resetBtn = document.getElementById('kv-keepalive-reset-btn');
      if (
        ka &&
        (ka.globalMaxCount !== undefined ||
          ka.fallbackMaxCount !== undefined ||
          ka.minContextPct !== undefined ||
          ka.globalIntervalSec !== undefined)
      ) {
        syncGlobalKeepaliveFromPayload(
          ka.globalMaxCount,
          ka.fallbackMaxCount,
          ka.minContextPct,
          ka.globalIntervalSec
        );
      }
      if (!btn) return;
      const isSubagent = ka ? ka.isSubagent === true : (btn.dataset?.subagent === '1');
      const isCustom = !isSubagent && (ka ? ka.isCustomOverride === true : (btn.dataset?.custom === '1'));
      const enabled = !isSubagent && (ka?.enabled ?? (btn.dataset?.enabled === '1'));
      const maxCount = ka && Number.isFinite(Number(ka.maxCount))
        ? Math.min(20, Math.max(1, Math.floor(Number(ka.maxCount))))
        : Math.min(20, Math.max(1, parseInt(btn.dataset?.max || maxInput?.value || '1', 10) || 1));
      const intervalSec =
        ka && ka.intervalSec !== undefined && ka.intervalSec !== null
          ? normalizeKeepaliveIntervalSecClient(ka.intervalSec, cachedGlobalKeepalive.globalIntervalSec)
          : btn.dataset?.interval !== undefined && btn.dataset?.interval !== ''
            ? normalizeKeepaliveIntervalSecClient(btn.dataset.interval, cachedGlobalKeepalive.globalIntervalSec)
            : cachedGlobalKeepalive.globalIntervalSec;
      const usedCount = isSubagent
        ? 0
        : ka && Number.isFinite(Number(ka.usedCount))
          ? Math.max(0, Math.floor(Number(ka.usedCount)))
          : Math.max(0, parseInt(btn.dataset?.used || '0', 10) || 0);
      const coldMissTripped = isSubagent
        ? false
        : ka && ka.coldMissTripped !== undefined
          ? Boolean(ka.coldMissTripped)
          : (btn.dataset?.cold === '1');
      if (btn.dataset) {
        btn.dataset.subagent = isSubagent ? '1' : '0';
        btn.dataset.custom = isCustom ? '1' : '0';
        btn.dataset.enabled = enabled ? '1' : '0';
        btn.dataset.max = String(maxCount);
        btn.dataset.interval = String(intervalSec);
        btn.dataset.used = String(usedCount);
        btn.dataset.cold = coldMissTripped ? '1' : '0';
      }
      btn.className = enabled ? 'toggle-chip is-on' : 'toggle-chip';
      if (grp) {
        const exhausted = enabled && (usedCount >= maxCount || coldMissTripped);
        const baseCls = enabled
          ? (exhausted ? 'keepalive-group is-on is-exhausted' : 'keepalive-group is-on')
          : 'keepalive-group';
        grp.className = isCustom ? `${baseCls} is-custom` : baseCls;
      }
      const label = isSubagent
        ? t('kvKeepaliveLabel')
        : isCustom
          ? t('kvKeepaliveCustomLabel')
          : t('kvKeepaliveLabel');
      const sep = currentLang === 'zh' ? '：' : ': ';
      btn.innerText = isSubagent
        ? `${label}${sep}${t('kvKeepaliveSubagentState')}`
        : enabled
          ? `${label}${sep}${usedCount}/${maxCount}${coldMissTripped ? t('kvKeepaliveColdSuffix') : ''}`
          : `${label}${sep}${t('stateOff')}`;
      if (isSubagent) {
        btn.title = t('kvKeepaliveSubagentTip');
      } else {
        const baseTip =
          intervalSec > 0
            ? t('kvKeepaliveFixedTip', { min: Math.max(1, Math.round(intervalSec / 60)) })
            : t('kvKeepaliveTip');
        const coldNote = coldMissTripped ? ` — ${t('kvKeepaliveColdTip')}` : '';
        let minGateNote = '';
        if (!coldMissTripped && enabled && !isCustom && cachedKv?.transcriptFound && Number(cachedKv.currentContextTokens) > 0) {
          const effPct = cachedGlobalKeepalive.minContextPct;
          const winCap = resolveActiveWindowCapTokens(ka?.windowTokens);
          const reqMinTok = effPct > 0 ? Math.round((winCap * effPct) / 100) : 0;
          if (reqMinTok > 0 && Number(cachedKv.currentContextTokens) < reqMinTok) {
            minGateNote = ` — ${t('kvKeepaliveBelowMinTip', {
              cur: Math.max(1, Math.round(Number(cachedKv.currentContextTokens) / 1000)),
              min: Math.max(1, Math.round(reqMinTok / 1000)),
              pct: effPct
            })}`;
          }
        }
        const errText = ka && typeof ka.lastError === 'string' ? ka.lastError.trim() : '';
        const narrowNote =
          ka?.narrowMarginSkipped === true
            ? ` — ${t('kvKeepaliveNarrowSkipTip', {
                rem: fmtSec(ka.narrowMarginRemSec ?? ka.remainingSec ?? 0),
                minRem: fmtSec(ka.effectiveMinRemainSec ?? ka.minRemainSec ?? 15)
              })}`
            : '';
        const cliffSkipObj = ka?.shortCliffSkip && typeof ka.shortCliffSkip === 'object' ? ka.shortCliffSkip : null;
        const cliffCntRaw = cliffSkipObj ? Number(cliffSkipObj.count) : 0;
        const cliffCnt = Number.isFinite(cliffCntRaw) && cliffCntRaw >= 0 ? Math.floor(cliffCntRaw) : 0;
        const cliffMinRaw = cliffSkipObj ? Number(cliffSkipObj.minGapSec) : 0;
        const cliffMin = Number.isFinite(cliffMinRaw) && cliffMinRaw >= 0 ? Math.round(cliffMinRaw) : 0;
        const cliffNote = cliffSkipObj
          ? ` — ${t('ttlShortCliffSkippedBadge')} (${t('ttlShortCliffSkippedTip', { count: cliffCnt, minGap: cliffMin })})`
          : '';
        btn.title = errText
          ? `${baseTip}${coldNote}${narrowNote}${cliffNote}${minGateNote} (⚠️ ${errText})`
          : `${baseTip}${coldNote}${narrowNote}${cliffNote}${minGateNote}`;
      }
      if (maxInput) {
        maxInput.disabled = isSubagent;
        if (document.activeElement !== maxInput) {
          maxInput.value = String(maxCount);
        }
      }
      syncKeepaliveIntervalOptionLabels('kv-keepalive-interval');
      const isPreset = KEEPALIVE_INTERVAL_PRESETS.includes(intervalSec);
      const showCustom = !isSubagent && (!isPreset || windowCustomIntervalOpen);
      if (intervalSelect) {
        intervalSelect.disabled = isSubagent;
        intervalSelect.title = t('kvKeepaliveIntervalTip');
        if (document.activeElement !== intervalSelect) {
          intervalSelect.value = showCustom ? 'custom' : String(intervalSec);
        }
      }
      if (customWrap) {
        customWrap.title = t('kvKeepaliveIntervalCustomTip');
        customWrap.className = showCustom
          ? 'keepalive-interval-custom-wrap'
          : 'keepalive-interval-custom-wrap hidden';
      }
      if (customInput) {
        customInput.disabled = isSubagent;
        if (!isPreset && document.activeElement !== customInput) {
          customInput.value = String(Math.max(1, Math.min(60, Math.round(intervalSec / 60))));
        }
      }
      if (followBtn) {
        followBtn.textContent = t('kvKeepaliveFollowBtn');
        followBtn.title = t('kvKeepaliveFollowTip');
        followBtn.className = !isSubagent && isCustom ? 'keepalive-follow-btn' : 'keepalive-follow-btn hidden';
      }
      if (resetBtn) {
        resetBtn.className =
          !isSubagent && (usedCount > 0 || coldMissTripped)
            ? 'keepalive-reset-btn'
            : 'keepalive-reset-btn hidden';
      }
      syncManualWarmWaitFromKeepalive(ka);
      if (kvTtlState) {
        renderLocalTtlCountdown();
      } else {
        renderManualWarmControls(null, false);
      }
    }

    const MANUAL_WARM_WAIT_TIMEOUT_MS = 60000;
    const INELIGIBLE_LEASE_STOP_RE =
      /^(?:EXECUTOR_TERMINATION_REASON_)?(?:USER_CANCELED|USER_CANCELLED|CANCELED|CANCELLED|ABORTED|ERROR|watchdog_disabled|stale_|orphan_)/i;
    let manualWarmTimeoutTimer = null;
    let manualWarmState = {
      requestInFlight: false,
      waitingAck: false,
      convId: '',
      clickSeq: 0,
      feedbackKey: '',
      feedbackParams: null,
      feedbackRawError: '',
      feedbackTone: ''
    };

    function clearManualWarmTimeoutTimer() {
      if (manualWarmTimeoutTimer !== null) {
        clearTimeout(manualWarmTimeoutTimer);
        manualWarmTimeoutTimer = null;
      }
    }

    function resetManualWarmState() {
      clearManualWarmTimeoutTimer();
      manualWarmState = {
        requestInFlight: false,
        waitingAck: false,
        convId: '',
        clickSeq: manualWarmState.clickSeq + 1,
        feedbackKey: '',
        feedbackParams: null,
        feedbackRawError: '',
        feedbackTone: ''
      };
    }

    function getManualWarmTargetConversationId() {
      syncNativeHostConversation({ reloadIfOpen: handoffDrawerOpen });
      return isCurrentConversationConfirmed() ? getConfirmedConversationId() : '';
    }

    function resolveCurrentKeepalivePayload(targetConvIdOverride = '') {
      const wdKa = cachedWatchdog?.ttlKeepalive;
      const kvKa = cachedKv?.ttlKeepalive;
      const activeId = targetConvIdOverride || getActiveConversationId();
      if (activeId) {
        if (wdKa && wdKa.conversationId === activeId) return wdKa;
        if (kvKa && kvKa.conversationId === activeId) return kvKa;
      }
      if (targetConvIdOverride) return null;
      if (wdKa && shouldAcceptKeepalivePayload(wdKa)) return wdKa;
      if (kvKa && shouldAcceptKeepalivePayload(kvKa)) return kvKa;
      return null;
    }

    function syncManualWarmWaitFromKeepalive(ka) {
      if (!manualWarmState.waitingAck || !ka || typeof ka !== 'object') return;
      const activeId = getManualWarmTargetConversationId();
      if (!activeId || (manualWarmState.convId && manualWarmState.convId !== activeId)) {
        resetManualWarmState();
        return;
      }
      if (ka.conversationId && manualWarmState.convId && ka.conversationId !== manualWarmState.convId) {
        return;
      }
      const turnActive = isCurrentConversationTurnActive();
      const settled =
        turnActive ||
        (ka.inFlight === false && ka.pendingAck === false) ||
        Boolean(ka.coldMissTripped) ||
        Boolean(typeof ka.lastError === 'string' && ka.lastError.trim());
      if (settled) {
        clearManualWarmTimeoutTimer();
        manualWarmState.waitingAck = false;
        if (typeof ka.lastError === 'string' && ka.lastError.trim()) {
          manualWarmState.feedbackKey = 'kvWarmErrNote';
          manualWarmState.feedbackParams = null;
          manualWarmState.feedbackRawError = ka.lastError.trim();
          manualWarmState.feedbackTone = 'danger';
        } else if (manualWarmState.feedbackKey === 'kvWarmDispatchedNote') {
          manualWarmState.feedbackKey = '';
          manualWarmState.feedbackParams = null;
          manualWarmState.feedbackRawError = '';
          manualWarmState.feedbackTone = '';
        }
      }
    }

    function mapManualWarmSkipReason(reason, ttlSec) {
      const ttlLabel = fmtSec(ttlSec > 0 ? ttlSec : 300);
      switch (reason) {
        case 'turn_active':
          return { key: 'kvWarmSkipTurnActive', params: null, tone: 'warn' };
        case 'cold_miss_tripped':
          return { key: 'kvWarmSkipCold', params: null, tone: 'danger' };
        case 'no_lease':
          return { key: 'kvWarmSkipNoLease', params: null, tone: 'warn' };
        case 'already_expired':
          return { key: 'kvWarmSkipExpired', params: { ttl: ttlLabel }, tone: 'danger' };
        case 'in_flight':
        case 'pending_ack':
          return { key: 'kvWarmSkipPending', params: null, tone: 'warn' };
        case 'cooldown':
          return { key: 'kvWarmSkipCooldown', params: null, tone: 'warn' };
        case 'already_dispatched':
          return { key: 'kvWarmSkipAlreadyDispatched', params: null, tone: 'warn' };
        case 'idle_cycle_changed':
          return { key: 'kvWarmSkipCycleChanged', params: null, tone: 'warn' };
        case 'ineligible_stop_state':
        case 'ineligible_stop_reason':
          return { key: 'kvWarmSkipIneligible', params: null, tone: 'warn' };
        case 'no_time_anchor':
          return { key: 'kvWarmSkipNoAnchor', params: null, tone: 'warn' };
        case 'subagent':
          return { key: 'kvWarmSkipSubagent', params: null, tone: 'warn' };
        case 'killed':
          return { key: 'kvWarmSkipKilled', params: null, tone: 'danger' };
        case 'archived':
          return { key: 'kvWarmSkipArchived', params: null, tone: 'warn' };
        case 'unsupported':
          return { key: 'kvWarmSkipUnsupported', params: null, tone: 'warn' };
        default:
          return { key: 'kvWarmErrNote', params: null, rawError: String(reason || 'blocked'), tone: 'warn' };
      }
    }

    function evaluateManualWarmUiState(snapOverride = null, turnActiveOverride = null) {
      const targetConvId = getManualWarmTargetConversationId();
      const ka = targetConvId ? resolveCurrentKeepalivePayload(targetConvId) : null;
      const snap = snapOverride || computeLocalTtlSnapshot(kvTtlState);
      const turnActive = turnActiveOverride !== null ? Boolean(turnActiveOverride) : isCurrentConversationTurnActive();
      const isBoundSpecific = Boolean(targetConvId && isSpecificConversationId(targetConvId));
      const isSubagent = Boolean(ka?.isSubagent === true);
      const unsupported = Boolean(ka && ka.supported === false);
      if (!kvTtlState || !snap || !isBoundSpecific || isSubagent || unsupported) {
        return { visible: false, canClick: false, mode: 'hidden', targetConvId, ka, snap, turnActive };
      }
      const sameConvWait = Boolean(
        manualWarmState.convId === targetConvId &&
          (manualWarmState.requestInFlight || manualWarmState.waitingAck)
      );
      const isBusy = Boolean(sameConvWait || ka?.inFlight === true || ka?.pendingAck === true);
      const isLeaseRunning = Boolean(
        ka?.hasLease === true &&
          ((ka.leasePhase && ka.leasePhase !== 'IDLE') || ka.leaseSubphase === 'stopped_bg_pending')
      );
      if (turnActive || isLeaseRunning) {
        return { visible: true, canClick: false, mode: 'active', targetConvId, ka, snap, turnActive: true };
      }
      if (isBusy) {
        return { visible: true, canClick: false, mode: 'pending', targetConvId, ka, snap, turnActive: false };
      }
      if (ka?.coldMissTripped === true) {
        return { visible: true, canClick: false, mode: 'cold', targetConvId, ka, snap, turnActive: false };
      }
      if (ka && ka.hasLease === false) {
        return { visible: true, canClick: false, mode: 'no_lease', targetConvId, ka, snap, turnActive: false };
      }
      if (
        ka?.hasLease === true &&
        ((ka.leaseSubphase && ka.leaseSubphase !== 'stopped') ||
          (ka.leaseStopReason && INELIGIBLE_LEASE_STOP_RE.test(ka.leaseStopReason)))
      ) {
        return { visible: true, canClick: false, mode: 'ineligible', targetConvId, ka, snap, turnActive: false };
      }
      if (snap.ttlStatus === 'expired' || snap.remainingSec <= 0) {
        return { visible: true, canClick: false, mode: 'expired', targetConvId, ka, snap, turnActive: false };
      }
      const effMinRem =
        ka && Number.isFinite(Number(ka.effectiveMinRemainSec))
          ? Math.max(0, Math.floor(Number(ka.effectiveMinRemainSec)))
          : 0;
      if (effMinRem > 0 && snap.remainingSec <= effMinRem) {
        return { visible: true, canClick: true, mode: 'tight', targetConvId, ka, snap, turnActive: false, effMinRem };
      }
      return { visible: true, canClick: true, mode: 'ready', targetConvId, ka, snap, turnActive: false, effMinRem };
    }

    function renderManualWarmControls(snapOverride = null, turnActiveOverride = null) {
      const btn = document.getElementById('kv-warm-now-btn');
      const skipBadge = document.getElementById('kv-ttl-auto-skip-badge');
      const noteEl = document.getElementById('kv-warm-now-note');
      if (!btn && !skipBadge && !noteEl) return;

      const st = evaluateManualWarmUiState(snapOverride, turnActiveOverride);
      if (!st.visible) {
        if (btn) {
          btn.className = 'warm-now-btn hidden';
          btn.disabled = true;
          btn.textContent = '';
          btn.title = '';
          if (btn.dataset) btn.dataset.mode = 'hidden';
        }
        if (skipBadge) {
          skipBadge.className = 'meta-tag is-warn hidden';
          skipBadge.textContent = '';
          skipBadge.title = '';
        }
        if (noteEl) {
          noteEl.className = 'warm-now-note hidden';
          noteEl.textContent = '';
        }
        return;
      }

      const { ka, snap } = st;
      const ttlFmt = fmtSec(snap.cacheTtlSec);
      const remFmt = fmtSec(snap.remainingSec);
      const delivSec = ka && Number(ka.deliveryLatencyMs) > 0 ? Math.min(20, Math.ceil(Number(ka.deliveryLatencyMs) / 1000)) : 0;
      const effMinRem =
        ka && Number.isFinite(Number(ka.effectiveMinRemainSec))
          ? Math.max(0, Math.floor(Number(ka.effectiveMinRemainSec)))
          : 15;

      if (skipBadge) {
        const cliffSkip = ka?.shortCliffSkip && typeof ka.shortCliffSkip === 'object' ? ka.shortCliffSkip : null;
        if (cliffSkip && !st.turnActive) {
          const cliffCntRaw = Number(cliffSkip.count);
          const cliffCnt = Number.isFinite(cliffCntRaw) && cliffCntRaw >= 0 ? Math.floor(cliffCntRaw) : 0;
          const cliffMinRaw = Number(cliffSkip.minGapSec);
          const cliffMin = Number.isFinite(cliffMinRaw) && cliffMinRaw >= 0 ? Math.round(cliffMinRaw) : 0;
          skipBadge.className = 'meta-tag is-warn';
          skipBadge.textContent = t('ttlShortCliffSkippedBadge');
          skipBadge.title = t('ttlShortCliffSkippedTip', { count: cliffCnt, minGap: cliffMin });
        } else if (ka?.narrowMarginSkipped === true && !st.turnActive && snap.remainingSec > 0) {
          skipBadge.className = 'meta-tag is-warn';
          skipBadge.textContent = t('ttlAutoSkippedBadge');
          skipBadge.title = t('ttlAutoSkippedTip', { minRem: fmtSec(effMinRem) });
        } else {
          skipBadge.className = 'meta-tag is-warn hidden';
          skipBadge.textContent = '';
          skipBadge.title = '';
        }
      }

      if (btn) {
        if (btn.dataset) btn.dataset.mode = st.mode;
        btn.disabled = !st.canClick;
        if (st.mode === 'active') {
          btn.className = 'warm-now-btn is-disabled';
          btn.textContent = t('kvWarmNowBtn');
          btn.title = t('kvWarmActiveTip');
        } else if (st.mode === 'pending') {
          btn.className = 'warm-now-btn is-pending';
          btn.textContent = t('kvWarmPendingBtn');
          btn.title = t('kvWarmPendingTip');
        } else if (st.mode === 'cold') {
          btn.className = 'warm-now-btn is-blocked';
          btn.textContent = t('kvWarmColdBtn');
          btn.title = t('kvWarmColdTip');
        } else if (st.mode === 'no_lease') {
          btn.className = 'warm-now-btn is-blocked';
          btn.textContent = t('kvWarmNoLeaseBtn');
          btn.title = t('kvWarmNoLeaseTip');
        } else if (st.mode === 'ineligible') {
          btn.className = 'warm-now-btn is-blocked';
          btn.textContent = t('kvWarmBlockedBtn');
          btn.title = t('kvWarmIneligibleTip');
        } else if (st.mode === 'expired') {
          btn.className = 'warm-now-btn is-expired';
          btn.textContent = t('kvWarmExpiredBtn');
          btn.title = t('kvWarmExpiredTip', { ttl: ttlFmt });
        } else if (st.mode === 'tight') {
          btn.className = 'warm-now-btn is-tight';
          btn.textContent = t('kvWarmTightBtn');
          btn.title = t('kvWarmTightTip', {
            rem: remFmt,
            minRem: fmtSec(effMinRem),
            deliv: fmtSec(delivSec)
          });
        } else {
          btn.className = 'warm-now-btn';
          btn.textContent = t('kvWarmNowBtn');
          btn.title = t('kvWarmNowTip', { rem: remFmt, ttl: ttlFmt });
        }
      }

      if (noteEl) {
        let noteText = '';
        let noteTone = '';
        const isCurrentFeedback = !manualWarmState.convId || manualWarmState.convId === st.targetConvId;
        if (isCurrentFeedback && manualWarmState.feedbackKey) {
          if (manualWarmState.feedbackKey === 'kvWarmErrNote') {
            noteText = t('kvWarmErrNote', { msg: manualWarmState.feedbackRawError || 'error' });
          } else {
            noteText = t(manualWarmState.feedbackKey, manualWarmState.feedbackParams || undefined);
          }
          noteTone = manualWarmState.feedbackTone || '';
        } else if (ka && typeof ka.lastError === 'string' && ka.lastError.trim()) {
          noteText = t('kvWarmErrNote', { msg: ka.lastError.trim() });
          noteTone = 'danger';
        }
        if (noteText) {
          noteEl.textContent = noteText;
          noteEl.className = noteTone === 'danger'
            ? 'warm-now-note is-danger'
            : noteTone === 'warn'
              ? 'warm-now-note is-warn'
              : 'warm-now-note';
        } else {
          noteEl.textContent = '';
          noteEl.className = 'warm-now-note hidden';
        }
      }
    }

    async function triggerManualTtlKeepalive() {
      const st = evaluateManualWarmUiState();
      if (!st.visible) return null;
      if (manualWarmState.requestInFlight || (manualWarmState.waitingAck && manualWarmState.convId === st.targetConvId)) {
        return null;
      }
      if (!st.canClick) {
        const mappedReason =
          st.mode === 'active'
            ? 'turn_active'
            : st.mode === 'pending'
              ? 'pending_ack'
              : st.mode === 'cold'
                ? 'cold_miss_tripped'
                : st.mode === 'no_lease'
                  ? 'no_lease'
                  : st.mode === 'expired'
                    ? 'already_expired'
                    : 'ineligible_stop_state';
        const fb = mapManualWarmSkipReason(mappedReason, st.snap?.cacheTtlSec);
        manualWarmState.convId = st.targetConvId;
        manualWarmState.feedbackKey = fb.key;
        manualWarmState.feedbackParams = fb.params;
        manualWarmState.feedbackRawError = fb.rawError || '';
        manualWarmState.feedbackTone = fb.tone;
        renderManualWarmControls(st.snap, st.turnActive);
        return null;
      }

      const reqConvId = st.targetConvId;
      const reqHostEpoch = hostSwitchEpoch;
      const reqScope = currentScope;
      const myClickSeq = ++manualWarmState.clickSeq;
      clearManualWarmTimeoutTimer();
      manualWarmState = {
        requestInFlight: true,
        waitingAck: false,
        convId: reqConvId,
        clickSeq: myClickSeq,
        feedbackKey: 'kvWarmDispatchedNote',
        feedbackParams: null,
        feedbackRawError: '',
        feedbackTone: ''
      };
      renderManualWarmControls();

      try {
        if (!isCurrentConversationConfirmed()) {
          manualWarmState.requestInFlight = false;
          return null;
        }
        const data = await sendWatchdogAction({
          action: 'manualTtlKeepalive',
          conversationId: reqConvId
        });
        const isStale =
          manualWarmState.clickSeq !== myClickSeq ||
          hostSwitchEpoch !== reqHostEpoch ||
          currentScope !== reqScope ||
          getManualWarmTargetConversationId() !== reqConvId;
        if (isStale || data?.cancelled === true) {
          if (manualWarmState.clickSeq === myClickSeq) {
            manualWarmState.requestInFlight = false;
            manualWarmState.waitingAck = false;
            manualWarmState.feedbackKey = '';
            renderManualWarmControls();
          }
          return null;
        }
        manualWarmState.requestInFlight = false;
        if (data && data.dispatched === true) {
          manualWarmState.waitingAck = true;
          manualWarmState.feedbackKey = 'kvWarmDispatchedNote';
          manualWarmState.feedbackParams = null;
          manualWarmState.feedbackRawError = '';
          manualWarmState.feedbackTone = '';
          clearManualWarmTimeoutTimer();
          manualWarmTimeoutTimer = setTimeout(() => {
            manualWarmTimeoutTimer = null;
            if (
              manualWarmState.clickSeq !== myClickSeq ||
              hostSwitchEpoch !== reqHostEpoch ||
              getManualWarmTargetConversationId() !== reqConvId
            ) {
              return;
            }
            manualWarmState.waitingAck = false;
            manualWarmState.feedbackKey = 'kvWarmTimeoutNote';
            manualWarmState.feedbackParams = null;
            manualWarmState.feedbackRawError = '';
            manualWarmState.feedbackTone = 'warn';
            renderManualWarmControls();
            refreshData(true);
          }, MANUAL_WARM_WAIT_TIMEOUT_MS);
          renderManualWarmControls();
          return data;
        }
        const reason = data?.skippedReason || data?.error || 'blocked';
        const ttlSec = Number(data?.effectiveTtlSec) || Number(kvTtlState?.cacheTtlSec) || 300;
        const fb = mapManualWarmSkipReason(reason, ttlSec);
        manualWarmState.waitingAck = false;
        manualWarmState.feedbackKey = fb.key;
        manualWarmState.feedbackParams = fb.params;
        manualWarmState.feedbackRawError = fb.rawError || '';
        manualWarmState.feedbackTone = fb.tone;
        renderManualWarmControls();
        return data;
      } catch (err) {
        const isStale =
          manualWarmState.clickSeq !== myClickSeq ||
          hostSwitchEpoch !== reqHostEpoch ||
          currentScope !== reqScope ||
          getManualWarmTargetConversationId() !== reqConvId;
        if (isStale) {
          return null;
        }
        manualWarmState.requestInFlight = false;
        manualWarmState.waitingAck = false;
        manualWarmState.feedbackKey = 'kvWarmErrNote';
        manualWarmState.feedbackParams = null;
        manualWarmState.feedbackRawError = String(err?.message || err || 'request_failed');
        manualWarmState.feedbackTone = 'danger';
        renderManualWarmControls();
        return null;
      }
    }

    async function toggleTtlKeepalive() {
      const prevSnap = snapshotKeepaliveUiState();
      if (prevSnap.isSubagent) return;
      const next = !prevSnap.enabled;
      const targetId = resolveKeepaliveConversationId();
      pendingCustomOverrideConvId = targetId || '__default__';
      const optimistic = { ...prevSnap, isCustomOverride: true, enabled: next };
      if (targetId === '__unbound__') {
        unboundKeepaliveState = { ...unboundKeepaliveState, ...optimistic };
      }
      renderKeepaliveControls(optimistic);
      const expectedSeq = watchdogActionSeq + 1;
      try {
        await sendWatchdogAction({
          action: 'setTtlKeepalive',
          enabled: next,
          ...(targetId ? { conversationId: targetId } : {})
        });
      } catch (e) {
        console.error(e);
        if (watchdogActionSeq === expectedSeq && resolveKeepaliveConversationId() === targetId) {
          pendingCustomOverrideConvId = '';
          if (targetId === '__unbound__') {
            unboundKeepaliveState = { ...unboundKeepaliveState, ...prevSnap };
          }
          renderKeepaliveControls(prevSnap);
        }
      }
    }

    async function changeTtlKeepaliveMax(rawVal) {
      const prevSnap = snapshotKeepaliveUiState();
      if (prevSnap.isSubagent) return;
      const trimmed = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim();
      if (trimmed === '') {
        return resetTtlKeepaliveOverride();
      }
      const maxInput = document.getElementById('kv-keepalive-max');
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        if (maxInput) maxInput.value = String(prevSnap.maxCount);
        return;
      }
      const parsed = Math.min(20, Math.max(1, Math.floor(num)));
      if (maxInput) maxInput.value = String(parsed);
      const targetId = resolveKeepaliveConversationId();
      pendingCustomOverrideConvId = targetId || '__default__';
      const optimistic = { ...prevSnap, isCustomOverride: true, enabled: true, maxCount: parsed };
      if (targetId === '__unbound__') {
        unboundKeepaliveState = { ...unboundKeepaliveState, ...optimistic };
      }
      renderKeepaliveControls(optimistic);
      const expectedSeq = watchdogActionSeq + 1;
      try {
        const data = await sendWatchdogAction({
          action: 'setTtlKeepalive',
          maxCount: parsed,
          ...(targetId ? { conversationId: targetId } : {})
        });
        const effMax = data?.ttlKeepaliveMaxCount ?? data?.status?.ttlKeepalive?.maxCount;
        if (
          watchdogActionSeq === expectedSeq &&
          resolveKeepaliveConversationId() === targetId &&
          maxInput &&
          Number.isFinite(Number(effMax)) &&
          Number(effMax) !== parsed
        ) {
          maxInput.value = String(Math.min(20, Math.max(1, Math.floor(Number(effMax)))));
        }
      } catch (e) {
        console.error(e);
        if (watchdogActionSeq === expectedSeq && resolveKeepaliveConversationId() === targetId) {
          pendingCustomOverrideConvId = '';
          if (maxInput) maxInput.value = String(prevSnap.maxCount);
          if (targetId === '__unbound__') {
            unboundKeepaliveState = { ...unboundKeepaliveState, ...prevSnap };
          }
          renderKeepaliveControls(prevSnap);
        }
      }
    }

    async function commitTtlKeepaliveInterval(nextIntervalSec) {
      const prevSnap = snapshotKeepaliveUiState();
      if (prevSnap.isSubagent) return;
      const parsed = normalizeKeepaliveIntervalSecClient(nextIntervalSec, 0);
      windowCustomIntervalOpen = false;
      const targetId = resolveKeepaliveConversationId();
      pendingCustomOverrideConvId = targetId || '__default__';
      const nextEnabled = parsed >= 60 ? true : prevSnap.enabled;
      const optimistic = {
        ...prevSnap,
        isCustomOverride: true,
        enabled: nextEnabled,
        intervalSec: parsed
      };
      if (targetId === '__unbound__') {
        unboundKeepaliveState = { ...unboundKeepaliveState, ...optimistic };
      }
      renderKeepaliveControls(optimistic);
      const expectedSeq = watchdogActionSeq + 1;
      try {
        const data = await sendWatchdogAction({
          action: 'setTtlKeepalive',
          intervalSec: parsed,
          ...(targetId ? { conversationId: targetId } : {})
        });
        const effInterval = data?.ttlKeepaliveIntervalSec ?? data?.status?.ttlKeepalive?.intervalSec;
        if (
          watchdogActionSeq === expectedSeq &&
          resolveKeepaliveConversationId() === targetId &&
          Number.isFinite(Number(effInterval))
        ) {
          const snapped = normalizeKeepaliveIntervalSecClient(effInterval, parsed);
          renderKeepaliveControls({ ...optimistic, intervalSec: snapped });
        }
      } catch (e) {
        console.error(e);
        if (watchdogActionSeq === expectedSeq && resolveKeepaliveConversationId() === targetId) {
          pendingCustomOverrideConvId = '';
          if (targetId === '__unbound__') {
            unboundKeepaliveState = { ...unboundKeepaliveState, ...prevSnap };
          }
          renderKeepaliveControls(prevSnap);
        }
      }
    }

    async function changeTtlKeepaliveInterval(rawPreset) {
      const prevSnap = snapshotKeepaliveUiState();
      if (prevSnap.isSubagent) return;
      const str = String(rawPreset ?? '').trim();
      if (str === 'custom') {
        windowCustomIntervalOpen = true;
        const customInput = document.getElementById('kv-keepalive-interval-custom');
        if (customInput) {
          customInput.value = String(
            prevSnap.intervalSec >= 60 ? Math.max(1, Math.min(60, Math.round(prevSnap.intervalSec / 60))) : 5
          );
        }
        renderKeepaliveControls(prevSnap);
        if (customInput && typeof customInput.focus === 'function') customInput.focus();
        if (customInput && typeof customInput.select === 'function') customInput.select();
        return;
      }
      return commitTtlKeepaliveInterval(normalizeKeepaliveIntervalSecClient(str, 0));
    }

    async function changeTtlKeepaliveCustomMin(rawMin) {
      const prevSnap = snapshotKeepaliveUiState();
      if (prevSnap.isSubagent) return;
      const trimmed = rawMin === null || rawMin === undefined ? '' : String(rawMin).trim();
      const num = Number(trimmed);
      if (trimmed === '' || !Number.isFinite(num)) {
        windowCustomIntervalOpen = false;
        renderKeepaliveControls(prevSnap);
        return;
      }
      const mins = Math.min(60, Math.max(1, Math.floor(num)));
      const customInput = document.getElementById('kv-keepalive-interval-custom');
      if (customInput) customInput.value = String(mins);
      return commitTtlKeepaliveInterval(mins * 60);
    }

    async function resetTtlKeepaliveOverride() {
      const prevSnap = snapshotKeepaliveUiState();
      if (prevSnap.isSubagent) return;
      const targetId = resolveKeepaliveConversationId();
      pendingCustomOverrideConvId = '';
      windowCustomIntervalOpen = false;
      const gm = cachedGlobalKeepalive.globalMaxCount;
      const fm = cachedGlobalKeepalive.fallbackMaxCount;
      const gi = cachedGlobalKeepalive.globalIntervalSec;
      const optimistic = {
        ...prevSnap,
        isCustomOverride: false,
        enabled: gm >= 1,
        maxCount: gm >= 1 ? gm : fm,
        intervalSec: gi,
        globalIntervalSec: gi
      };
      const maxInput = document.getElementById('kv-keepalive-max');
      if (maxInput) maxInput.value = String(optimistic.maxCount);
      if (targetId === '__unbound__') {
        unboundKeepaliveState = { ...unboundKeepaliveState, ...optimistic };
      }
      renderKeepaliveControls(optimistic);
      const expectedSeq = watchdogActionSeq + 1;
      try {
        await sendWatchdogAction({
          action: 'resetTtlKeepaliveOverride',
          ...(targetId ? { conversationId: targetId } : {})
        });
      } catch (e) {
        console.error(e);
        if (watchdogActionSeq === expectedSeq && resolveKeepaliveConversationId() === targetId) {
          if (maxInput) maxInput.value = String(prevSnap.maxCount);
          if (targetId === '__unbound__') {
            unboundKeepaliveState = { ...unboundKeepaliveState, ...prevSnap };
          }
          renderKeepaliveControls(prevSnap);
        }
      }
    }

    async function resetTtlKeepalive() {
      const prevSnap = snapshotKeepaliveUiState();
      if (prevSnap.isSubagent) return;
      const targetId = resolveKeepaliveConversationId();
      const optimistic = { ...prevSnap, usedCount: 0, coldMissTripped: false };
      if (targetId === '__unbound__') {
        unboundKeepaliveState = { ...unboundKeepaliveState, ...optimistic };
      }
      renderKeepaliveControls(optimistic);
      const expectedSeq = watchdogActionSeq + 1;
      try {
        await sendWatchdogAction({
          action: 'resetTtlKeepalive',
          ...(targetId ? { conversationId: targetId } : {})
        });
      } catch (e) {
        console.error(e);
        if (watchdogActionSeq === expectedSeq && resolveKeepaliveConversationId() === targetId) {
          if (targetId === '__unbound__') {
            unboundKeepaliveState = { ...unboundKeepaliveState, ...prevSnap };
          }
          renderKeepaliveControls(prevSnap);
        }
      }
    }

    async function toggleTtlNotify() {
      const btn = document.getElementById('kv-ttl-notify-btn');
      const next = btn?.dataset?.enabled !== '1';
      try {
        await sendWatchdogAction({ action: 'setTtlDesktopNotify', enabled: next });
      } catch (e) {
        console.error(e);
      }
    }

    async function runMaintenanceVacuum() {
      const btn = document.getElementById('vacuum-btn');
      if (btn) btn.innerText = t('vacuumingBtn');
      try {
        const res = await apiFetch('/api/maintenance', {
          method: 'POST',
          body: JSON.stringify({ action: 'vacuum', maxAgeDays: 14 })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (btn) btn.innerText = data.reclaimedBytes > 0 ? t('vacuumFreedBtn', { size: formatBytes(data.reclaimedBytes) }) : t('vacuumOkBtn');
        setTimeout(() => { if (btn) btn.innerText = t('vacuumBtn'); }, 2500);
        refreshData(true);
      } catch (err) {
        if (btn) btn.innerText = t('vacuumBtn');
        alert(t('alertMaintFail', { msg: err.message }));
      }
    }

    async function runStorageVacuumOnly() {
      const btn = document.getElementById('vacuum-only-btn');
      if (btn) btn.innerText = t('vacuumingBtn');
      try {
        const res = await apiFetch('/api/maintenance', {
          method: 'POST',
          body: JSON.stringify({ action: 'vacuum_only' })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (btn) btn.innerText = data.reclaimedBytes > 0 ? t('vacuumFreedBtn', { size: formatBytes(data.reclaimedBytes) }) : t('vacuumOkBtn');
        setTimeout(() => { if (btn) btn.innerText = t('vacuumOnlyBtn'); }, 2500);
        refreshData(true);
      } catch (err) {
        if (btn) btn.innerText = t('vacuumOnlyBtn');
        alert(t('alertMaintFail', { msg: err.message }));
      }
    }

    async function handlePurgeClick() {
      const convId = getActiveConversationId();

      let confirmMsg = t('confirmPurgeConv');
      if (currentScope === 'app') {
        confirmMsg = t('confirmPurgeApp');
      } else if (currentScope === 'lifetime') {
        confirmMsg = t('confirmPurgeLifetime');
      }

      if (!confirm(confirmMsg)) return;
      ++refreshSeq;

      try {
        const res = await apiFetch('/api/purge', {
          method: 'POST',
          body: JSON.stringify({ scope: currentScope, conversationId: convId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        refreshData(true);
      } catch (err) {
        alert(t('alertPurgeFail', { msg: err.message }));
      }
    }

    function triggerWakeupRefresh() {
      refreshData(false);
      if (focusFollowupTimer !== null) clearTimeout(focusFollowupTimer);
      focusFollowupTimer = setTimeout(() => {
        focusFollowupTimer = null;
        if (typeof document !== 'undefined' && document.hidden === true) return;
        refreshData(false);
      }, 350);
    }

    function setElVisible(el, visible) {
      if (!el) return;
      if (visible) {
        el.classList.remove('hidden');
        el.hidden = false;
      } else {
        el.classList.add('hidden');
        el.hidden = true;
      }
    }

    function isSafeReleaseUrl(rawUrl) {
      if (typeof rawUrl !== 'string') return false;
      return rawUrl === GITHUB_RELEASES_URL || rawUrl.startsWith(GITHUB_RELEASES_URL + '/tag/');
    }

    function formatVersionRateLimit(retryAt) {
      if (!Number.isFinite(retryAt) || retryAt <= 0) return t('versionErrRateLimit');
      try {
        const locale = currentLang === 'zh' ? 'zh-CN' : 'en-US';
        const time = new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23'
        }).format(retryAt);
        return t('versionErrRateLimitUntil', { time });
      } catch {
        return t('versionErrRateLimit');
      }
    }

    function formatVersionError(payload, isUpdate) {
      const reason = payload?.reason || '';
      if (reason === 'rateLimit') return formatVersionRateLimit(payload?.retryAt);
      if (reason === 'http') return t('versionErrHttp', { status: payload?.httpStatus || '--' });
      const keyMap = {
        timeout: 'versionErrTimeout',
        noRelease: 'versionErrNoRelease',
        invalidRelease: 'versionErrInvalidRelease',
        network: 'versionErrNetwork',
        localVersion: 'versionErrLocalVersion',
        busy: 'versionErrBusy',
        releaseChanged: 'versionErrReleaseChanged',
        releaseCheck: 'versionErrNetwork',
        download: 'versionErrDownload',
        redirect: 'versionErrRedirect',
        size: 'versionErrSize',
        integrity: 'versionErrIntegrity',
        archive: 'versionErrArchive',
        version: 'versionErrArchive',
        incomplete: 'versionErrArchive',
        notInstalled: 'versionErrNotInstalled',
        gitCheckout: 'versionErrGitCheckout',
        permission: 'versionErrPermission',
        locked: 'versionErrLocked',
        pathConflict: 'versionErrInstall',
        recovery: 'versionErrRecovery'
      };
      const base = t(keyMap[reason] || (isUpdate ? 'versionErrInstall' : 'versionErrNetwork'));
      const restored = isUpdate && payload?.diagnostics?.restored === true ? t('versionErrRestoredSuffix') : '';
      return base + restored;
    }

    function updateAutoUpdateInstallBtn() {
      const btn = document.getElementById('auto-update-install-btn');
      if (!btn) return;
      const info = versionCheckState.autoUpdateInstall || { enabled: false, source: 'default' };
      const enabled = Boolean(info.enabled);
      const lockedByEnv = info.source === 'env';
      const sep = currentLang === 'zh' ? '：' : ': ';
      btn.dataset.enabled = enabled ? '1' : '0';
      btn.disabled = versionCheckState.autoUpdateToggling || lockedByEnv;
      btn.className = enabled ? 'toggle-chip is-on' : 'toggle-chip';
      btn.textContent = `${t('autoUpdateInstallLabel')}${sep}${enabled ? t('stateOn') : t('stateOff')}`;
      btn.title = lockedByEnv ? t('autoUpdateInstallEnvTip') : t('autoUpdateInstallTip');
    }

    async function toggleAutoUpdateInstall() {
      if (versionCheckState.autoUpdateToggling) return null;
      const curInfo = versionCheckState.autoUpdateInstall || { enabled: false, source: 'default' };
      if (curInfo.source === 'env') return null;
      const nextEnabled = !curInfo.enabled;
      versionCheckState.autoUpdateToggling = true;
      versionCheckState.autoUpdateInstall = { enabled: nextEnabled, source: 'sqlite' };
      updateAutoUpdateInstallBtn();
      try {
        const res = await apiFetch('/api/auto-update', {
          method: 'POST',
          body: JSON.stringify({ enabled: nextEnabled })
        });
        const data = res && res.ok ? await res.json().catch(() => null) : null;
        if (data?.ok && data.autoUpdateInstall) {
          versionCheckState.autoUpdateInstall = data.autoUpdateInstall;
          return data;
        }
        versionCheckState.autoUpdateInstall = curInfo;
        return null;
      } catch {
        versionCheckState.autoUpdateInstall = curInfo;
        return null;
      } finally {
        versionCheckState.autoUpdateToggling = false;
        updateAutoUpdateInstallBtn();
      }
    }

    function renderVersionUpdateUi() {
      const btn = document.getElementById('version-check-btn');
      const btnDot = document.getElementById('version-check-dot');
      const btnLabel = document.getElementById('version-check-label');
      const banner = document.getElementById('version-update-banner');
      const statusEl = document.getElementById('version-status-text');
      const detailEl = document.getElementById('version-detail-text');
      const updateBtn = document.getElementById('version-update');
      const releaseLink = document.getElementById('version-release-link');
      const dismissBtn = document.getElementById('version-dismiss-btn');

      const avail = versionCheckState.available;
      const hasUpdate = Boolean(avail && avail.latestVersion);
      const isDismissed =
        hasUpdate &&
        !versionCheckState.updating &&
        !versionCheckState.updated &&
        versionCheckState.dismissedVersion === avail.latestVersion &&
        !versionCheckState.manual &&
        versionCheckState.lastUpdate?.status !== 'error';

      const autoNotice =
        versionCheckState.autoUpdatedNotice &&
        versionCheckState.autoUpdatedNotice.version &&
        versionCheckState.dismissedAutoNoticeVersion !== versionCheckState.autoUpdatedNotice.version
          ? versionCheckState.autoUpdatedNotice
          : null;

      let state = '';
      if (versionCheckState.updating) state = 'updating';
      else if (versionCheckState.updated) state = 'updated';
      else if (versionCheckState.lastUpdate?.status === 'error') state = 'error';
      else if (hasUpdate && !isDismissed) state = 'available';
      else if (versionCheckState.checking && versionCheckState.manual) state = 'checking';
      else if (versionCheckState.manual && versionCheckState.lastCheck?.status === 'error') state = 'check-error';
      else if (versionCheckState.manual && versionCheckState.lastCheck?.status === 'current') state = 'current';
      else if (autoNotice) state = 'auto-updated';

      if (btn) {
        btn.disabled = versionCheckState.checking || versionCheckState.updating;
        if (hasUpdate && !versionCheckState.updated) btn.classList.add('has-update');
        else btn.classList.remove('has-update');
      }
      setElVisible(btnDot, hasUpdate && !versionCheckState.updated);
      if (btnLabel) {
        if (versionCheckState.checking) btnLabel.textContent = t('versionCheckingBtn');
        else if (versionCheckState.updating) btnLabel.textContent = t('versionUpdatingBtn');
        else if (hasUpdate && !versionCheckState.updated) {
          btnLabel.textContent = t('versionUpdateAvailableBtn', { version: avail.latestVersion });
        } else {
          btnLabel.textContent = t('versionCheckBtn');
        }
      }

      if (!banner) return;
      banner.dataset.state = state;
      setElVisible(banner, Boolean(state));
      if (!state) return;

      let titleText = '';
      let detailText = '';
      let showUpdateBtn = false;
      let updateBtnText = t('versionUpdateBtn');
      let releaseHref = '';
      let releaseLabel = t('versionReleaseBtn');

      if (state === 'checking') {
        titleText = t('versionChecking');
      } else if (state === 'current') {
        const ver = versionCheckState.lastCheck?.currentVersion || (cachedStats?.version || '').replace(/^v/, '') || '--';
        titleText = t('versionUpToDate', { version: ver });
      } else if (state === 'available') {
        titleText = t('versionAvailable', {
          current: avail.currentVersion || '--',
          latest: avail.latestVersion
        });
        showUpdateBtn = true;
        updateBtnText = t('versionUpdateBtn');
        releaseHref = isSafeReleaseUrl(avail.releaseUrl) ? avail.releaseUrl : GITHUB_RELEASES_URL;
      } else if (state === 'updating') {
        titleText = t('versionUpdatingBtn');
        detailText = t('versionAvailable', {
          current: avail?.currentVersion || '--',
          latest: avail?.latestVersion || '--'
        });
      } else if (state === 'updated') {
        const targetVer = versionCheckState.lastUpdate?.version || avail?.latestVersion || '--';
        titleText = t('versionUpdatedTitle', { version: targetVer });
        detailText = versionCheckState.reloadPending
          ? t('versionUpdatedDetailReloading')
          : t('versionUpdatedDetailManual');
      } else if (state === 'auto-updated') {
        titleText = autoNotice.previousVersion
          ? t('versionAutoUpdatedTitleFrom', { version: autoNotice.version, prev: autoNotice.previousVersion })
          : t('versionAutoUpdatedTitle', { version: autoNotice.version });
        detailText = t('versionAutoUpdatedDetail');
        releaseHref = isSafeReleaseUrl(autoNotice.releaseUrl) ? autoNotice.releaseUrl : GITHUB_RELEASES_URL;
      } else if (state === 'check-error') {
        titleText = t('versionCheckFailed');
        detailText = formatVersionError(versionCheckState.lastCheck, false);
        showUpdateBtn = true;
        updateBtnText = t('versionRetryBtn');
        if (versionCheckState.lastCheck?.reason === 'rateLimit') {
          releaseHref = GITHUB_RELEASES_URL;
          releaseLabel = t('versionManualBtn');
        }
      } else if (state === 'error') {
        titleText = t('versionUpdateFailed');
        detailText = formatVersionError(versionCheckState.lastUpdate, true);
        showUpdateBtn = true;
        updateBtnText = t('versionRetryBtn');
        releaseHref = isSafeReleaseUrl(avail?.releaseUrl) ? avail.releaseUrl : GITHUB_RELEASES_URL;
        releaseLabel = t('versionManualBtn');
      }

      if (statusEl) statusEl.textContent = titleText;
      if (detailEl) {
        detailEl.textContent = detailText;
        setElVisible(detailEl, Boolean(detailText));
      }
      if (updateBtn) {
        updateBtn.textContent = updateBtnText;
        updateBtn.disabled = versionCheckState.updating || versionCheckState.checking;
        setElVisible(updateBtn, showUpdateBtn);
      }
      if (releaseLink) {
        if (releaseHref) {
          releaseLink.href = releaseHref;
          releaseLink.textContent = releaseLabel;
        }
        setElVisible(releaseLink, Boolean(releaseHref));
      }
      if (dismissBtn) {
        dismissBtn.disabled = versionCheckState.updating;
        dismissBtn.textContent = state === 'auto-updated' ? t('versionAckBtn') : t('versionDismissBtn');
        setElVisible(dismissBtn, !versionCheckState.updating);
      }
    }

    async function checkForUpdates(manual = false, { fresh = false } = {}) {
      if (versionCheckState.checking || versionCheckState.updating) return null;
      versionCheckState.checking = true;
      versionCheckState.manual = Boolean(manual);
      if (manual) {
        versionCheckState.updated = false;
        versionCheckState.lastUpdate = null;
        versionCheckState.dismissedVersion = '';
      }
      renderVersionUpdateUi();
      try {
        const payload = { mode: manual ? 'manual' : 'auto' };
        if (fresh) payload.fresh = true;
        const res = await apiFetch('/api/version', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const data = res ? await res.json().catch(() => null) : null;
        if (!data || typeof data.status !== 'string' || !['update', 'current', 'idle', 'error'].includes(data.status)) {
          if (manual) {
            versionCheckState.lastCheck = {
              status: 'error',
              reason: res && !res.ok && Number.isFinite(res.status) ? 'http' : 'network',
              ...(res && !res.ok && Number.isFinite(res.status) ? { httpStatus: res.status } : {})
            };
          }
          return null;
        }
        versionCheckState.lastCheck = data;
        if (data.status === 'update' && typeof data.latestVersion === 'string' && data.latestVersion) {
          versionCheckState.available = data;
          versionCheckState.updated = false;
        } else if (data.status === 'current') {
          versionCheckState.available = null;
        }
        return data;
      } catch {
        if (manual) {
          versionCheckState.lastCheck = { status: 'error', reason: 'network' };
        }
        return null;
      } finally {
        versionCheckState.checking = false;
        renderVersionUpdateUi();
      }
    }

    function handleVersionButtonClick() {
      const avail = versionCheckState.available;
      if (avail && avail.latestVersion && !versionCheckState.updated) {
        if (versionCheckState.dismissedVersion === avail.latestVersion) {
          versionCheckState.dismissedVersion = '';
          versionCheckState.manual = true;
          renderVersionUpdateUi();
        }
        const banner = document.getElementById('version-update-banner');
        if (banner && typeof banner.scrollIntoView === 'function') {
          banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        const updateBtn = document.getElementById('version-update');
        if (updateBtn && !updateBtn.hidden && !updateBtn.disabled && typeof updateBtn.focus === 'function') {
          updateBtn.focus();
        }
        return null;
      }
      return checkForUpdates(true);
    }

    function handleVersionUpdateClick() {
      if (versionCheckState.manual && versionCheckState.lastCheck?.status === 'error' && !versionCheckState.available) {
        return checkForUpdates(true, { fresh: true });
      }
      return runPluginUpdate();
    }

    function pollForUpdatedRestart(targetVersion, attempt = 0) {
      if (attempt >= 12) {
        versionCheckState.reloadPending = false;
        renderVersionUpdateUi();
        return;
      }
      versionReloadTimer = setTimeout(async () => {
        versionReloadTimer = null;
        try {
          const res = await apiFetch('/api/stats', {
            method: 'POST',
            body: JSON.stringify({ scope: currentScope, conversationId: getActiveConversationId() })
          });
          if (res && res.ok) {
            const s = await res.json().catch(() => null);
            const rawVer = typeof s?.version === 'string' ? s.version.replace(/^v/, '') : '';
            if (rawVer === targetVersion) {
              if (typeof window?.location?.reload === 'function') {
                window.location.reload();
                return;
              }
            }
          }
        } catch {}
        pollForUpdatedRestart(targetVersion, attempt + 1);
      }, 750);
    }

    async function runPluginUpdate() {
      const targetVersion = versionCheckState.available?.latestVersion;
      if (!targetVersion || versionCheckState.updating || versionCheckState.checking) return null;
      versionCheckState.updating = true;
      versionCheckState.updated = false;
      versionCheckState.lastUpdate = null;
      versionCheckState.manual = true;
      renderVersionUpdateUi();
      try {
        const res = await apiFetch('/api/update', {
          method: 'POST',
          body: JSON.stringify({ version: targetVersion })
        });
        const data = res ? await res.json().catch(() => null) : null;
        if (!data || (data.status !== 'updated' && data.status !== 'error')) {
          versionCheckState.lastUpdate = { status: 'error', reason: 'install' };
          return versionCheckState.lastUpdate;
        }
        versionCheckState.lastUpdate = data;
        if (data.status === 'updated') {
          const nextVer = data.version || targetVersion;
          versionCheckState.updated = true;
          versionCheckState.available = null;
          versionCheckState.reloadPending = Boolean(window?.sidecar);
          if (versionCheckState.reloadPending) {
            pollForUpdatedRestart(nextVer, 0);
          } else {
            const verEl = document.getElementById('dashboard-version');
            if (verEl && nextVer) verEl.textContent = 'v' + nextVer;
          }
        }
        return data;
      } catch {
        versionCheckState.lastUpdate = { status: 'error', reason: 'network' };
        return versionCheckState.lastUpdate;
      } finally {
        versionCheckState.updating = false;
        renderVersionUpdateUi();
      }
    }

    function dismissVersionBanner() {
      if (versionCheckState.updating) return;
      const activeNoticeVer = versionCheckState.autoUpdatedNotice?.version || '';
      if (versionCheckState.available?.latestVersion) {
        versionCheckState.dismissedVersion = versionCheckState.available.latestVersion;
      }
      if (activeNoticeVer) {
        versionCheckState.dismissedAutoNoticeVersion = activeNoticeVer;
        versionCheckState.autoUpdatedNotice = null;
        void apiFetch('/api/auto-update', {
          method: 'POST',
          body: JSON.stringify({ dismissNotice: true })
        }).catch(() => {});
      }
      versionCheckState.manual = false;
      versionCheckState.updated = false;
      versionCheckState.lastCheck = null;
      versionCheckState.lastUpdate = null;
      renderVersionUpdateUi();
    }

    function scheduleAutoVersionCheck() {
      if (autoVersionCheckDone) return;
      autoVersionCheckDone = true;
      autoVersionCheckTimer = setTimeout(() => {
        autoVersionCheckTimer = null;
        return checkForUpdates(false);
      }, 600);
    }


    function startDashboardPolling() {
      if (pollTimer !== null) return;
      pollTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden === true) return;
        refreshData(false);
        if (Date.now() - lastSafetyAuditFetchMs >= 15000) {
          void refreshSafetyAudit(false);
        }
      }, 3000);
    }

    function teardownDashboardLifecycle() {
      stopKvTtlTimer();
      stopWdLiveTimer();
      clearPendingJumpFallbackTimer();
      clearManualWarmTimeoutTimer();
      if (autoVersionCheckTimer !== null) {
        clearTimeout(autoVersionCheckTimer);
        autoVersionCheckTimer = null;
      }
      if (safetyAuditTimer !== null) {
        clearTimeout(safetyAuditTimer);
        safetyAuditTimer = null;
      }
      if (versionReloadTimer !== null) {
        clearTimeout(versionReloadTimer);
        versionReloadTimer = null;
      }
      if (focusFollowupTimer !== null) {
        clearTimeout(focusFollowupTimer);
        focusFollowupTimer = null;
      }
      if (jumpPillFlashTimer !== null) {
        clearTimeout(jumpPillFlashTimer);
        jumpPillFlashTimer = null;
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (handoffCopyResetTimer !== null) {
        clearTimeout(handoffCopyResetTimer);
        handoffCopyResetTimer = null;
      }
      if (handoffPromptCopyResetTimer !== null) {
        clearTimeout(handoffPromptCopyResetTimer);
        handoffPromptCopyResetTimer = null;
      }
      if (wdCopyResetTimer !== null) {
        clearTimeout(wdCopyResetTimer);
        wdCopyResetTimer = null;
      }
      if (starCopyHideTimer !== null) {
        clearTimeout(starCopyHideTimer);
        starCopyHideTimer = null;
      }
      if (sectionNavFlashTimer !== null) {
        clearTimeout(sectionNavFlashTimer);
        sectionNavFlashTimer = null;
      }
      if (sectionJumpResizeObserver && typeof sectionJumpResizeObserver.disconnect === 'function') {
        sectionJumpResizeObserver.disconnect();
        sectionJumpResizeObserver = null;
      }
      sectionJumpListenersBound = false;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('scroll', scheduleSectionSpy);
        window.removeEventListener('resize', scheduleSectionJumpLayout);
        window.removeEventListener('wheel', clearPinnedJumpSection);
        window.removeEventListener('touchstart', clearPinnedJumpSection);
        window.removeEventListener('keydown', handleSectionManualScrollKey);
      }
      if (themeMediaQuery && themeMediaQueryHandler) {
        if (typeof themeMediaQuery.removeEventListener === 'function') {
          themeMediaQuery.removeEventListener('change', themeMediaQueryHandler);
        } else if (typeof themeMediaQuery.removeListener === 'function') {
          themeMediaQuery.removeListener(themeMediaQueryHandler);
        }
        themeMediaQuery = null;
        themeMediaQueryHandler = null;
      }
    }

    function resumeDashboardLifecycle() {
      initThemeSync();
      initSectionJumpSpy();
      startDashboardPolling();
      triggerWakeupRefresh();
    }

    initThemeSync();
    initSectionJumpSpy();
    bindWatchdogJumpListeners();
    resolveHostWorkspacePaths();
    applyLanguageUi();
    refreshData(true);
    scheduleAutoVersionCheck();
    scheduleInitialSafetyAudit();
    startDashboardPolling();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden === false) {
          triggerWakeupRefresh();
        }
      });
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('focus', () => {
        triggerWakeupRefresh();
      });
      window.addEventListener('beforeunload', teardownDashboardLifecycle);
      window.addEventListener('pagehide', teardownDashboardLifecycle);
      window.addEventListener('pageshow', (ev) => {
        if (ev && ev.persisted) {
          resumeDashboardLifecycle();
        }
      });
    }
