    let currentThemeMode = 'auto';

    function normalizeThemeMode(raw) {
      const val = String(raw || '').trim().toLowerCase();
      return val === 'light' || val === 'mocha' || val === 'auto' ? val : 'auto';
    }

    function readSavedThemeMode() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage) {
          return normalizeThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
        }
      } catch {}
      return 'auto';
    }

    function resolveEffectiveTheme(mode) {
      if (mode === 'mocha') return 'mocha';
      if (mode === 'light') return 'light';
      try {
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
          return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'mocha' : 'light';
        }
      } catch {}
      return 'light';
    }

    function toggleHiddenClass(el, hide) {
      if (!el || !el.classList) return;
      if (hide) el.classList.add('hidden');
      else el.classList.remove('hidden');
    }

    function updateThemeButton() {
      const btn = document.getElementById('theme-toggle-btn');
      const iconAuto = document.getElementById('theme-icon-auto');
      const iconLight = document.getElementById('theme-icon-light');
      const iconMocha = document.getElementById('theme-icon-mocha');
      const effective = resolveEffectiveTheme(currentThemeMode);
      toggleHiddenClass(iconAuto, currentThemeMode !== 'auto');
      toggleHiddenClass(iconLight, currentThemeMode === 'auto' || effective !== 'light');
      toggleHiddenClass(iconMocha, currentThemeMode === 'auto' || effective !== 'mocha');
      if (btn) {
        const modeLabel = currentThemeMode === 'mocha'
          ? t('themeModeMocha')
          : currentThemeMode === 'light'
            ? t('themeModeLight')
            : t('themeModeAuto');
        const tip = t('themeToggleTip', { mode: modeLabel });
        btn.title = tip;
        if (typeof btn.setAttribute === 'function') {
          btn.setAttribute('aria-label', tip);
        }
        if (btn.dataset) {
          btn.dataset.themeMode = currentThemeMode;
        }
      }
    }

    function applyThemeMode(mode, persist = false) {
      const next = normalizeThemeMode(mode);
      currentThemeMode = next;
      const effective = resolveEffectiveTheme(next);
      try {
        const root = document.documentElement;
        if (root) {
          const disableTransitions = persist && root.classList && typeof root.classList.add === 'function';
          if (disableTransitions) root.classList.add('theme-switching');
          if (root.dataset) {
            root.dataset.themeMode = next;
          }
          if (typeof root.setAttribute === 'function') {
            root.setAttribute('data-theme', effective === 'mocha' ? 'mocha' : 'light');
          }
          if (disableTransitions) {
            void root.offsetHeight;
            const release = () => {
              if (root.classList && typeof root.classList.remove === 'function') {
                root.classList.remove('theme-switching');
              }
            };
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
              window.requestAnimationFrame(release);
            } else {
              setTimeout(release, 0);
            }
          }
        }
      } catch {}
      if (persist) {
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(THEME_STORAGE_KEY, next);
          }
        } catch {}
      }
      updateThemeButton();
    }

    let themeMediaQuery = null;
    let themeMediaQueryHandler = null;

    function cycleThemeMode(ev) {
      if (ev && (ev.altKey || ev.shiftKey)) {
        applyThemeMode('auto', true);
        return;
      }
      const effective = resolveEffectiveTheme(currentThemeMode);
      const next = effective === 'mocha' ? 'light' : 'mocha';
      applyThemeMode(next, true);
    }

    function handleThemeToggleKeydown(ev) {
      if (!ev) return;
      if (ev.shiftKey && (ev.key === 'Enter' || ev.key === ' ')) {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        applyThemeMode('auto', true);
      }
    }

    function resetThemeAuto(ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      applyThemeMode('auto', true);
    }

    function initThemeSync() {
      applyThemeMode(readSavedThemeMode(), false);
      if (themeMediaQuery && themeMediaQueryHandler) return;
      try {
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
          const mq = window.matchMedia('(prefers-color-scheme: dark)');
          const onSchemeChange = () => {
            if (currentThemeMode === 'auto') {
              applyThemeMode('auto', false);
            }
          };
          themeMediaQuery = mq;
          themeMediaQueryHandler = onSchemeChange;
          if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', onSchemeChange);
          } else if (typeof mq.addListener === 'function') {
            mq.addListener(onSchemeChange);
          }
        }
      } catch {}
    }

    let sectionNavFlashTimer = null;
    let sectionNavFlashTarget = null;
    let activeJumpSectionId = 'kv-cache-card';
    let lastAppliedJumpSectionId = '';
    let lastJumpVisibilityKey = '';
    let sectionSpyLockUntil = 0;
    let pinnedJumpSectionId = '';
    let sectionSpyRafPending = false;
    let sectionLayoutRafPending = false;
    let cachedJumpWidths = null;
    let sectionJumpResizeObserver = null;
    let sectionJumpListenersBound = false;
    let fontsReadyHooked = false;
    let lastObservedRowWidth = -1;
    let lastObservedBrandWidth = -1;
    let lastObservedNarrow = null;

    function invalidateSectionJumpWidthCache() {
      cachedJumpWidths = null;
    }

    function clearPinnedJumpSection() {
      pinnedJumpSectionId = '';
    }

    function handleSectionManualScrollKey(ev) {
      if (!ev) return;
      if (
        ev.key === 'ArrowDown' ||
        ev.key === 'ArrowUp' ||
        ev.key === 'PageDown' ||
        ev.key === 'PageUp' ||
        ev.key === 'Home' ||
        ev.key === 'End' ||
        ev.key === ' '
      ) {
        pinnedJumpSectionId = '';
      }
    }

    function getSectionJumpChips() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
      return Array.from(document.querySelectorAll('[data-section-jump-strip] [data-nav-target]'));
    }

    function positionSectionJumpThumb(activeChip) {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
      const thumb = document.querySelector('[data-section-jump-thumb]');
      if (!thumb || !thumb.style) return;
      if (!activeChip || !activeChip.offsetWidth) {
        thumb.style.opacity = '0';
        return;
      }
      thumb.style.width = activeChip.offsetWidth + 'px';
      thumb.style.transform = 'translateX(' + activeChip.offsetLeft + 'px)';
      thumb.style.opacity = '1';
      try {
        const dotColor = activeChip.style && typeof activeChip.style.getPropertyValue === 'function'
          ? activeChip.style.getPropertyValue('--nav-dot')
          : '';
        if (dotColor) thumb.style.borderColor = dotColor;
      } catch {}
    }

    function getBrandNaturalWidth(brand) {
      if (!brand) return 0;
      if (brand.children && brand.children.length > 0) {
        let sum = 0;
        let visibleCount = 0;
        for (let i = 0; i < brand.children.length; i++) {
          const child = brand.children[i];
          if (!child || (child.classList && child.classList.contains('hidden'))) continue;
          const w = Math.ceil(child.offsetWidth || child.scrollWidth || 0);
          if (w > 0) {
            sum += w;
            visibleCount++;
          }
        }
        if (visibleCount > 0) {
          return sum + Math.max(0, visibleCount - 1) * 6;
        }
      }
      return Math.ceil(brand.offsetWidth || brand.scrollWidth || 0);
    }

    function measureSectionJumpWidths(strip) {
      const narrow = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth <= 390;
      const baseKey = `${lastJumpVisibilityKey}|${currentLang}|${narrow ? '1' : '0'}`;
      if (cachedJumpWidths && cachedJumpWidths.baseKey === baseKey && cachedJumpWidths.activeId === activeJumpSectionId) {
        return cachedJumpWidths;
      }
      const prevDensity = typeof strip.getAttribute === 'function' ? (strip.getAttribute('data-density') || 'medium') : 'medium';
      const prevMaxWidth = strip.style ? strip.style.maxWidth : '';
      let expanded = cachedJumpWidths && cachedJumpWidths.baseKey === baseKey ? cachedJumpWidths.expanded : 0;
      let compact = cachedJumpWidths && cachedJumpWidths.baseKey === baseKey ? cachedJumpWidths.compact : 0;
      let medium = 0;
      const readNaturalWidth = () => Math.ceil(Math.max(strip.offsetWidth || 0, strip.scrollWidth || 0));
      try {
        if (strip.style) strip.style.maxWidth = 'none';
        if (!expanded) {
          strip.setAttribute('data-density', 'expanded');
          expanded = readNaturalWidth();
        }
        strip.setAttribute('data-density', 'medium');
        medium = readNaturalWidth();
        if (!compact) {
          strip.setAttribute('data-density', 'compact');
          compact = readNaturalWidth();
        }
      } finally {
        if (strip.style) strip.style.maxWidth = prevMaxWidth;
        strip.setAttribute('data-density', prevDensity);
      }
      cachedJumpWidths = { baseKey, activeId: activeJumpSectionId, expanded, medium, compact };
      return cachedJumpWidths;
    }

    function syncSectionJumpDensity(skipThumb) {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
      const strip = document.querySelector('[data-section-jump-strip]');
      if (!strip || typeof strip.setAttribute !== 'function') return;
      const row = typeof strip.closest === 'function' ? strip.closest('.topbar-row') : null;
      const brand = row && typeof row.querySelector === 'function' ? row.querySelector('.brand-group') : null;
      const rowWidth = row ? Math.floor(row.clientWidth || 0) : 0;
      const brandWidth = getBrandNaturalWidth(brand);
      if (rowWidth <= 0 || brandWidth <= 0) return;

      const sameLineAvailable = rowWidth - brandWidth - 10;
      const prevDensity = typeof strip.getAttribute === 'function' ? (strip.getAttribute('data-density') || 'medium') : 'medium';
      const { expanded: expandedWidth, medium: mediumWidth, compact: compactWidth } = measureSectionJumpWidths(strip);

      // If even compact dots cannot fit beside brand-group on row 1, the flex row wraps the strip
      // onto its own line where the full rowWidth is available instead of locking into dots-only.
      const fitsSameLine = compactWidth > 0 ? sameLineAvailable >= compactWidth : sameLineAvailable >= 0;
      const available = fitsSameLine ? sameLineAvailable : rowWidth;

      let nextDensity = 'medium';
      if (expandedWidth > 0 && available >= expandedWidth) {
        nextDensity = 'expanded';
      } else if (mediumWidth > 0 && available >= mediumWidth) {
        nextDensity = 'medium';
      } else if (mediumWidth > 0) {
        nextDensity = 'compact';
      }

      if (nextDensity !== prevDensity) {
        strip.setAttribute('data-density', nextDensity);
      }
      if (!skipThumb && nextDensity !== prevDensity) {
        const activeChip = getSectionJumpChips().find((c) => c.classList && c.classList.contains('is-active')) || null;
        positionSectionJumpThumb(activeChip);
      }
    }

    function setActiveSectionJump(sectionId, forceLayout) {
      if (!sectionId) return;
      const changed = sectionId !== lastAppliedJumpSectionId;
      if (!changed && !forceLayout) return;
      activeJumpSectionId = sectionId;
      lastAppliedJumpSectionId = sectionId;
      let matched = null;
      getSectionJumpChips().forEach((chip) => {
        const tid = chip.getAttribute ? chip.getAttribute('data-nav-target') : '';
        const isCurrent = tid === sectionId;
        if (chip.classList) {
          if (isCurrent) chip.classList.add('is-active');
          else chip.classList.remove('is-active');
        }
        if (typeof chip.setAttribute === 'function') {
          chip.setAttribute('aria-current', isCurrent ? 'true' : 'false');
        }
        if (isCurrent) matched = chip;
      });
      if (forceLayout || changed) {
        syncSectionJumpDensity(true);
      }
      positionSectionJumpThumb(matched);
    }

    function syncSectionJumpVisibilityAndSpy(forceLayout) {
      const chips = getSectionJumpChips();
      if (!chips.length) return;
      const visiblePairs = [];
      chips.forEach((chip) => {
        const tid = chip.getAttribute ? chip.getAttribute('data-nav-target') : '';
        const target = tid ? document.getElementById(tid) : null;
        const isHidden = !target || Boolean(target.hidden) || (target.classList && target.classList.contains('hidden'));
        toggleHiddenClass(chip, isHidden);
        if (!isHidden) visiblePairs.push({ id: tid, target, chip });
      });
      if (!visiblePairs.length) return;
      const visKey = visiblePairs.map((p) => p.id).join(',');
      const visChanged = visKey !== lastJumpVisibilityKey;
      const needsLayout = Boolean(forceLayout) || visChanged;
      lastJumpVisibilityKey = visKey;
      if (visChanged) invalidateSectionJumpWidthCache();
      if (Date.now() < sectionSpyLockUntil) {
        setActiveSectionJump(activeJumpSectionId, needsLayout);
        return;
      }
      const topbar = typeof document.querySelector === 'function' ? document.querySelector('.topbar') : null;
      const headerOffset = topbar && typeof topbar.getBoundingClientRect === 'function'
        ? Math.ceil(topbar.getBoundingClientRect().height) + 28
        : 100;
      const docEl = document.documentElement;
      const scrollY = typeof window !== 'undefined' ? (window.scrollY || 0) : 0;
      const winH = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 0;
      const nearBottom = scrollY > 2 && docEl && typeof docEl.scrollHeight === 'number' && winH > 0
        ? (scrollY + winH >= docEl.scrollHeight - 24)
        : false;
      let pickedId = visiblePairs[0].id;
      if (nearBottom) {
        const pinnedPair = pinnedJumpSectionId ? visiblePairs.find((p) => p.id === pinnedJumpSectionId) : null;
        if (pinnedPair && typeof pinnedPair.target.getBoundingClientRect === 'function') {
          const pTop = pinnedPair.target.getBoundingClientRect().top;
          if (pTop >= 0 && pTop < winH * 0.75) {
            pickedId = pinnedPair.id;
          } else {
            pinnedJumpSectionId = '';
            pickedId = visiblePairs[visiblePairs.length - 1].id;
          }
        } else {
          pickedId = visiblePairs[visiblePairs.length - 1].id;
        }
      } else {
        pinnedJumpSectionId = '';
        for (const pair of visiblePairs) {
          if (typeof pair.target.getBoundingClientRect === 'function') {
            const top = pair.target.getBoundingClientRect().top;
            if (top <= headerOffset) pickedId = pair.id;
          }
        }
      }
      setActiveSectionJump(pickedId, needsLayout);
    }

    function scheduleSectionSpy() {
      if (sectionSpyRafPending) return;
      sectionSpyRafPending = true;
      const run = () => {
        sectionSpyRafPending = false;
        syncSectionJumpVisibilityAndSpy(false);
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        setTimeout(run, 16);
      }
    }

    function scheduleSectionJumpLayout() {
      if (sectionLayoutRafPending) return;
      sectionLayoutRafPending = true;
      const run = () => {
        sectionLayoutRafPending = false;
        syncSectionJumpVisibilityAndSpy(true);
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        setTimeout(run, 16);
      }
    }

    function updateSectionJumpTooltips() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
      if (typeof document.querySelector === 'function') {
        const strip = document.querySelector('[data-section-jump-strip]');
        if (strip && typeof strip.setAttribute === 'function') {
          strip.setAttribute('aria-label', t('sectionNavTip'));
        }
      }
      document.querySelectorAll('[data-nav-full-key]').forEach((chip) => {
        const key = chip.getAttribute ? chip.getAttribute('data-nav-full-key') : '';
        if (!key) return;
        const fullLabel = t(key);
        if (typeof chip.removeAttribute === 'function') {
          chip.removeAttribute('title');
        }
        if (typeof chip.setAttribute === 'function') {
          chip.setAttribute('data-tooltip', fullLabel);
          chip.setAttribute('aria-label', fullLabel);
        }
      });
      invalidateSectionJumpWidthCache();
      scheduleSectionJumpLayout();
    }

    function jumpToSection(sectionId, triggerEl) {
      const target = document.getElementById(sectionId);
      if (!target) return;
      if (triggerEl && triggerEl.classList) {
        triggerEl.classList.add('is-tooltip-dismissed');
      }
      pinnedJumpSectionId = sectionId;
      sectionSpyLockUntil = Date.now() + 700;
      setActiveSectionJump(sectionId, true);
      if (String(target.tagName || '').toUpperCase() === 'DETAILS') {
        target.open = true;
      }
      try {
        const topbar = typeof document.querySelector === 'function' ? document.querySelector('.topbar') : null;
        const headerOffset = topbar && typeof topbar.getBoundingClientRect === 'function'
          ? Math.ceil(topbar.getBoundingClientRect().height) + 10
          : 84;
        if (typeof target.getBoundingClientRect === 'function' && typeof window.scrollTo === 'function') {
          const top = Math.max(0, (window.scrollY || 0) + target.getBoundingClientRect().top - headerOffset);
          window.scrollTo({ top, behavior: 'smooth' });
        } else if (typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch {}
      if (sectionNavFlashTarget && sectionNavFlashTarget !== target && sectionNavFlashTarget.classList) {
        sectionNavFlashTarget.classList.remove('is-nav-flash');
      }
      if (target.classList) {
        target.classList.remove('is-nav-flash');
        target.classList.add('is-nav-flash');
        sectionNavFlashTarget = target;
        if (sectionNavFlashTimer !== null) clearTimeout(sectionNavFlashTimer);
        sectionNavFlashTimer = setTimeout(() => {
          sectionNavFlashTimer = null;
          if (sectionNavFlashTarget && sectionNavFlashTarget.classList) {
            sectionNavFlashTarget.classList.remove('is-nav-flash');
          }
          sectionNavFlashTarget = null;
        }, 900);
      }
    }

    function initSectionJumpSpy() {
      getSectionJumpChips().forEach((chip) => {
        if (typeof chip.addEventListener === 'function' && !(chip.dataset && chip.dataset.jumpBound === '1')) {
          if (chip.dataset) chip.dataset.jumpBound = '1';
          const clearDismiss = () => {
            if (chip.classList) chip.classList.remove('is-tooltip-dismissed');
          };
          chip.addEventListener('mouseleave', clearDismiss);
          chip.addEventListener('blur', clearDismiss);
        }
      });
      if (!sectionJumpListenersBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        sectionJumpListenersBound = true;
        window.addEventListener('scroll', scheduleSectionSpy, { passive: true });
        window.addEventListener('resize', scheduleSectionJumpLayout);
        window.addEventListener('wheel', clearPinnedJumpSection, { passive: true });
        window.addEventListener('touchstart', clearPinnedJumpSection, { passive: true });
        window.addEventListener('keydown', handleSectionManualScrollKey);
      }
      if (!fontsReadyHooked && typeof document !== 'undefined' && document.fonts && typeof document.fonts.ready?.then === 'function') {
        fontsReadyHooked = true;
        document.fonts.ready.then(() => {
          invalidateSectionJumpWidthCache();
          scheduleSectionJumpLayout();
        }).catch(() => {});
      }
      if (!sectionJumpResizeObserver && typeof ResizeObserver === 'function' && typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        const strip = document.querySelector('[data-section-jump-strip]');
        const row = strip && typeof strip.closest === 'function' ? strip.closest('.topbar-row') : null;
        const brand = row && typeof row.querySelector === 'function' ? row.querySelector('.brand-group') : null;
        if (row) {
          lastObservedRowWidth = Math.floor(row.clientWidth || 0);
          lastObservedBrandWidth = getBrandNaturalWidth(brand);
          lastObservedNarrow = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth <= 390;
          sectionJumpResizeObserver = new ResizeObserver(() => {
            const nextRowW = Math.floor(row.clientWidth || 0);
            const nextBrandW = getBrandNaturalWidth(brand);
            const nextNarrow = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth <= 390;
            if (nextRowW === lastObservedRowWidth && nextBrandW === lastObservedBrandWidth && nextNarrow === lastObservedNarrow) return;
            lastObservedRowWidth = nextRowW;
            lastObservedBrandWidth = nextBrandW;
            if (nextNarrow !== lastObservedNarrow) {
              lastObservedNarrow = nextNarrow;
              invalidateSectionJumpWidthCache();
            }
            scheduleSectionJumpLayout();
          });
          sectionJumpResizeObserver.observe(row);
          if (brand) sectionJumpResizeObserver.observe(brand);
        }
      }
      scheduleSectionJumpLayout();
    }
