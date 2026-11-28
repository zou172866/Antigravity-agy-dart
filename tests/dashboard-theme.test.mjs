import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HTML_PATH = path.join(ROOT, "sidecars", "dashboard", "index.html");

const MOCHA_OFFICIAL_HEX = new Set([
  "#11111b", // Crust
  "#181825", // Mantle
  "#1e1e2e", // Base
  "#313244", // Surface0
  "#45475a", // Surface1
  "#585b70", // Surface2
  "#6c7086", // Overlay0
  "#7f849c", // Overlay1
  "#9399b2", // Overlay2
  "#a6adc8", // Subtext0
  "#bac2de", // Subtext1
  "#cdd6f4", // Text
  "#cba6f7", // Mauve
  "#b4befe", // Lavender
  "#89b4fa", // Blue
  "#89dceb", // Sky
  "#74c7ec", // Sapphire
  "#94e2d5", // Teal
  "#a6e3a1", // Green
  "#f9e2af", // Yellow
  "#fab387", // Peach
  "#f38ba8", // Red
  "#eba0ac", // Maroon
  "#f5c2e7", // Pink
  "#f2cdcd", // Flamingo
  "#f5e0dc"  // Rosewater
]);

const MOCHA_ALLOWED_HEX = new Set([
  "#09090f", // Deep canvas (-2 stops below Crust, Mocha 240deg hue)
  "#0d0d15", // Deep inset (-1 stop below Crust, Mocha 240deg hue)
  ...MOCHA_OFFICIAL_HEX
]);

function makeEl(id, initialClasses = []) {
  const classes = new Set(initialClasses);
  const attrs = new Map();
  return {
    id,
    textContent: "",
    innerText: "",
    innerHTML: "",
    title: "",
    value: "",
    options: [],
    dataset: {},
    style: {},
    classList: {
      add(...cs) {
        for (const c of cs) classes.add(c);
      },
      remove(...cs) {
        for (const c of cs) classes.delete(c);
      },
      contains(c) {
        return classes.has(c);
      }
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) || "";
    },
    removeAttribute(k) {
      attrs.delete(k);
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    appendChild() {}
  };
}

test("1. Catppuccin Mocha CSS block uses official Mocha palette, valid/used tokens, and proper responsive cascade order", () => {
  const html = readDashboardHtml();
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
  assert.ok(styleMatch, "Dashboard must contain an inline <style> block");
  const css = styleMatch[1];

  const mochaBlockMatch = css.match(/(?::root|html)?\[data-theme="mocha"\]\s*\{([\s\S]*?)\}/);
  assert.ok(mochaBlockMatch, 'CSS must define [data-theme="mocha"] token overrides');
  const mochaBlock = mochaBlockMatch[1];

  assert.match(mochaBlock, /color-scheme:\s*dark;/, "Mocha theme must declare color-scheme: dark");
  assert.match(mochaBlock, /--bg-panel:\s*#11111b;/, "Mocha card panel must map to Crust (#11111b)");
  assert.match(mochaBlock, /--bg-subtle:\s*#181825;/, "Mocha control surface must map to Mantle (#181825)");
  assert.match(mochaBlock, /--bg-hover:\s*#1e1e2e;/, "Mocha hover surface must map to Base (#1e1e2e)");
  assert.match(mochaBlock, /--accent:\s*#cba6f7;/, "Mocha accent must map to Mauve (#cba6f7)");
  assert.match(mochaBlock, /--accent-fg:\s*#(?:11111b|1e1e2e);/, "Mocha accent foreground must use Crust or Base for readability");

  // Verify every hex literal in the Mocha block belongs to the Mocha palette + deep canvas extension
  const hexes = mochaBlock.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.ok(hexes.length >= 20, "Mocha theme block should define palette tokens");
  for (const hex of hexes) {
    assert.ok(
      MOCHA_ALLOWED_HEX.has(hex.toLowerCase()),
      `Unexpected hex color in Mocha block: ${hex}`
    );
  }

  // Ensure every custom property referenced via var(--...) in CSS is defined in :root, and none in :root go unused
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(rootMatch, "CSS must define :root tokens");
  const definedVars = new Set([...rootMatch[1].matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]));
  const referencedVars = [...css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  for (const v of referencedVars) {
    assert.ok(definedVars.has(v), `CSS variable ${v} is referenced but not defined in :root`);
  }
  const allReferencedInHtml = new Set([...html.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
  for (const v of definedVars) {
    assert.ok(allReferencedInHtml.has(v), `CSS variable ${v} in :root is unused`);
  }
  const mochaDefinedVars = [...mochaBlock.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]);
  for (const v of mochaDefinedVars) {
    assert.ok(definedVars.has(v), `Mocha CSS variable ${v} is not defined in :root`);
  }

  // Verify narrow-screen @media (max-width: 390px) comes AFTER base .star-banner / details.accordion-band rules
  const starBaseIdx = css.indexOf(".star-banner {");
  const accBaseIdx = css.indexOf("details.accordion-band {");
  const media390Idx = css.indexOf("@media (max-width: 390px)");
  assert.ok(starBaseIdx > 0 && accBaseIdx > 0 && media390Idx > Math.max(starBaseIdx, accBaseIdx),
    "@media (max-width: 390px) must appear after base .star-banner and details.accordion-band rules");

  // Ensure anti-FOUC head script uses an attribute so bare <script> extractors still match only the main script
  const bareScriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(bareScriptMatch && bareScriptMatch[1].includes("function cycleThemeMode"),
    "Bare <script> regex must still match the main dashboard script");
  assert.match(html, /<script\s+data-theme-init>[\s\S]*?<\/script>\s*<\/head>/i,
    "Head must include an attributed <script data-theme-init> block before </head>");
});

test("2. Theme switcher supports instant Light/Mocha flip, Auto reset (contextmenu & keyboard), i18n, and responsive jump density", () => {
  const html = readDashboardHtml();
  const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const mainScript = scriptMatches.map((m) => m[1]).find((s) => s.includes("function cycleThemeMode"));
  assert.ok(mainScript, "Dashboard main script must define cycleThemeMode");

  const storage = new Map();
  let prefersDark = false;
  let schemeListener = null;

  const docElAttrs = new Map();
  const docEl = {
    lang: "en",
    dataset: {},
    setAttribute(k, v) {
      docElAttrs.set(k, String(v));
    },
    getAttribute(k) {
      return docElAttrs.get(k) || null;
    },
    removeAttribute(k) {
      docElAttrs.delete(k);
    }
  };

  const els = new Map([
    ["theme-toggle-btn", makeEl("theme-toggle-btn")],
    ["theme-icon-auto", makeEl("theme-icon-auto")],
    ["theme-icon-light", makeEl("theme-icon-light", ["hidden"])],
    ["theme-icon-mocha", makeEl("theme-icon-mocha", ["hidden"])],
    ["lang-zh-btn", makeEl("lang-zh-btn")],
    ["lang-en-btn", makeEl("lang-en-btn", ["is-active"])],
    ["cutoff-select", makeEl("cutoff-select")],
    ["exempt-accordion", Object.assign(makeEl("exempt-accordion"), { tagName: "DETAILS", open: false })],
    ["gates-health-accordion", Object.assign(makeEl("gates-health-accordion"), { tagName: "DETAILS", open: false })]
  ]);

  const brandEl = { scrollWidth: 350, offsetWidth: 350 };
  const rowEl = {
    clientWidth: 790,
    querySelector: (sel) => (sel === ".brand-group" ? brandEl : null)
  };
  const stripAttrs = new Map([["data-density", "medium"]]);
  const stripEl = {
    style: {},
    closest: (sel) => (sel === ".topbar-row" ? rowEl : null),
    setAttribute: (k, v) => stripAttrs.set(k, String(v)),
    getAttribute: (k) => stripAttrs.get(k) || "",
    get scrollWidth() {
      const d = stripAttrs.get("data-density");
      const raw = d === "expanded" ? 340 : d === "medium" ? 180 : 140;
      return this.style.maxWidth === "none" ? raw : Math.min(raw, rowEl.clientWidth);
    },
    get offsetWidth() {
      return this.scrollWidth;
    }
  };
  const thumbEl = { style: {} };
  const activeChip = Object.assign(makeEl("chip-active", ["is-active"]), {
    offsetWidth: 52,
    offsetLeft: 3,
    style: { getPropertyValue: () => "var(--accent)" }
  });

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    URL,
    URLSearchParams,
    Headers,
    Promise,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    navigator: { language: "en-US", clipboard: { writeText: async () => {} } },
    document: {
      hidden: false,
      title: "",
      documentElement: docEl,
      getElementById: (id) => els.get(id) || null,
      querySelector: (sel) => {
        if (sel === "[data-section-jump-strip]") return stripEl;
        if (sel === "[data-section-jump-thumb]") return thumbEl;
        return null;
      },
      querySelectorAll: (sel) =>
        sel === "[data-section-jump-strip] [data-nav-target]" ? [activeChip] : [],
      addEventListener: () => {}
    },
    window: {
      innerWidth: 820,
      innerHeight: 900,
      scrollY: 0,
      scrollTo: () => {},
      location: { origin: "http://127.0.0.1:18765", pathname: "/", search: "" },
      matchMedia: (query) => ({
        matches: query.includes("dark") ? prefersDark : false,
        addEventListener: (ev, fn) => {
          if (ev === "change") schemeListener = fn;
        },
        removeEventListener: () => {}
      }),
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mainScript, sandbox);

  // Default: auto mode + light system preference -> resolves to light
  assert.equal(docEl.dataset.themeMode, "auto");
  assert.equal(docEl.getAttribute("data-theme"), "light");
  assert.equal(els.get("theme-icon-auto").classList.contains("hidden"), false);
  assert.equal(els.get("theme-icon-mocha").classList.contains("hidden"), true);

  // OS switches to dark while in auto mode -> resolves to mocha
  prefersDark = true;
  assert.equal(typeof schemeListener, "function", "Should subscribe to prefers-color-scheme changes");
  schemeListener();
  assert.equal(docEl.getAttribute("data-theme"), "mocha");

  // Direct instant flip: currently mocha -> click flips straight to light -> click flips straight to mocha
  sandbox.cycleThemeMode();
  assert.equal(docEl.dataset.themeMode, "light");
  assert.equal(docEl.getAttribute("data-theme"), "light");
  assert.equal(storage.get("agy-dart-ui-theme"), "light");
  assert.equal(els.get("theme-icon-light").classList.contains("hidden"), false);

  sandbox.cycleThemeMode();
  assert.equal(docEl.dataset.themeMode, "mocha");
  assert.equal(docEl.getAttribute("data-theme"), "mocha");
  assert.equal(storage.get("agy-dart-ui-theme"), "mocha");
  assert.equal(els.get("theme-icon-mocha").classList.contains("hidden"), false);

  // Right-click reset restores auto mode
  sandbox.resetThemeAuto({ preventDefault: () => {} });
  assert.equal(docEl.dataset.themeMode, "auto");
  assert.equal(storage.get("agy-dart-ui-theme"), "auto");

  // Keyboard Shift+Enter and Shift+Click also restore auto mode for accessibility
  sandbox.cycleThemeMode();
  assert.equal(docEl.dataset.themeMode, "light");
  let prevented = false;
  sandbox.handleThemeToggleKeydown({ shiftKey: true, key: "Enter", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(docEl.dataset.themeMode, "auto");

  sandbox.cycleThemeMode();
  assert.equal(docEl.dataset.themeMode, "light");
  sandbox.cycleThemeMode({ shiftKey: true });
  assert.equal(docEl.dataset.themeMode, "auto");

  // Switching UI language updates theme button tooltip & nav strip aria-label
  sandbox.setLanguage("zh", false);
  assert.ok(els.get("theme-toggle-btn").title.includes("当前主题"), "Chinese tooltip should update on language switch");
  assert.equal(stripAttrs.get("aria-label"), "快速跳转板块", "Chinese nav aria-label should sync from sectionNavTip");
  sandbox.setLanguage("en", false);
  assert.ok(els.get("theme-toggle-btn").title.includes("Theme:"), "English tooltip should update on language switch");
  assert.equal(stripAttrs.get("aria-label"), "Jump to section", "English nav aria-label should sync from sectionNavTip");

  // Inline section jump chips expand target <details> and clear previous flash on rapid clicks
  sandbox.jumpToSection("exempt-accordion");
  assert.equal(els.get("exempt-accordion").open, true, "Jumping to a collapsed <details> section should expand it");
  assert.equal(els.get("exempt-accordion").classList.contains("is-nav-flash"), true, "Target card should flash on jump");
  sandbox.jumpToSection("gates-health-accordion");
  assert.equal(els.get("exempt-accordion").classList.contains("is-nav-flash"), false, "Previous flashed card must clear on rapid click");
  assert.equal(els.get("gates-health-accordion").classList.contains("is-nav-flash"), true, "New target card should flash on rapid click");

  // Wide row (790 - 350 - 10 = 430 >= 340) -> expanded (all short labels)
  rowEl.clientWidth = 790;
  sandbox.syncSectionJumpDensity();
  assert.equal(stripAttrs.get("data-density"), "expanded");

  // Medium row (580 - 350 - 10 = 220, fits 180 but not 340) -> medium (active label + dots)
  rowEl.clientWidth = 580;
  sandbox.syncSectionJumpDensity();
  assert.equal(stripAttrs.get("data-density"), "medium");

  // Tight same-line row (500 - 350 - 10 = 140, fits compact 140 but not medium 180) -> compact
  rowEl.clientWidth = 500;
  sandbox.syncSectionJumpDensity();
  assert.equal(stripAttrs.get("data-density"), "compact");

  // Wrapped row (390 - 350 - 10 = 30 < compact 140 -> strip wraps onto full 390px line >= expanded 340) -> expanded
  rowEl.clientWidth = 390;
  sandbox.syncSectionJumpDensity();
  assert.equal(stripAttrs.get("data-density"), "expanded");

  // Narrow wrapped row (300px full line fits medium 180 but not expanded 340) -> medium
  rowEl.clientWidth = 300;
  sandbox.syncSectionJumpDensity();
  assert.equal(stripAttrs.get("data-density"), "medium");
});

test("3. Anti-FOUC head script and scroll-spy nearBottom guards prevent white flash and false bottom highlight", () => {
  const html = readDashboardHtml();
  const headInitMatch = html.match(/<script\s+data-theme-init>([\s\S]*?)<\/script>/i);
  assert.ok(headInitMatch, "Anti-FOUC <script data-theme-init> must exist");

  // Execute head script across saved/system combinations before <body> renders
  function runHeadInit(savedVal, prefersDark) {
    const attrs = new Map();
    const root = {
      dataset: {},
      setAttribute: (k, v) => attrs.set(k, String(v))
    };
    const ctx = {
      localStorage: { getItem: () => savedVal },
      window: { matchMedia: () => ({ matches: prefersDark }) },
      document: { documentElement: root }
    };
    vm.createContext(ctx);
    vm.runInContext(headInitMatch[1], ctx);
    return { mode: root.dataset.themeMode, theme: attrs.get("data-theme") };
  }
  assert.deepEqual(runHeadInit(null, true), { mode: "auto", theme: "mocha" });
  assert.deepEqual(runHeadInit(null, false), { mode: "auto", theme: "light" });
  assert.deepEqual(runHeadInit("mocha", false), { mode: "mocha", theme: "mocha" });
  assert.deepEqual(runHeadInit("light", true), { mode: "light", theme: "light" });

  // Scroll-spy nearBottom behavior: must not hijack scrollY===0 or explicit jump to exempt-accordion
  const mainScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const docEl = { lang: "en", dataset: {}, scrollHeight: 1341, setAttribute() {}, getAttribute: () => "light" };
  const makeSection = (id, top) => Object.assign(makeEl(id), {
    tagName: id.endsWith("accordion") ? "DETAILS" : "SECTION",
    open: false,
    getBoundingClientRect: () => ({ top })
  });
  const sections = new Map([
    ["kv-cache-card", makeSection("kv-cache-card", 90)],
    ["exempt-accordion", makeSection("exempt-accordion", 220)],
    ["gates-health-accordion", makeSection("gates-health-accordion", 520)]
  ]);
  const makeChip = (targetId) => {
    const c = makeEl(`chip-${targetId}`);
    c.setAttribute("data-nav-target", targetId);
    c.offsetWidth = 44;
    c.offsetLeft = 4;
    return c;
  };
  const chips = [makeChip("kv-cache-card"), makeChip("exempt-accordion"), makeChip("gates-health-accordion")];
  const topbarEl = { getBoundingClientRect: () => ({ height: 64 }) };
  let nowMs = 10000;
  class MockDate extends Date {
    static now() { return nowMs; }
  }

  const sandbox = {
    console,
    Date: MockDate,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    URL,
    URLSearchParams,
    Headers,
    Promise,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: () => new Promise(() => {}),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: "en-US", clipboard: { writeText: async () => {} } },
    document: {
      hidden: false,
      title: "",
      documentElement: docEl,
      getElementById: (id) => sections.get(id) || (id === "cutoff-select" ? makeEl("cutoff-select") : null),
      querySelector: (sel) => (sel === ".topbar" ? topbarEl : null),
      querySelectorAll: (sel) => (sel === "[data-section-jump-strip] [data-nav-target]" ? chips : []),
      addEventListener: () => {}
    },
    window: {
      innerWidth: 820,
      innerHeight: 1400,
      scrollY: 0,
      scrollTo: () => {},
      location: { origin: "http://127.0.0.1:18765", pathname: "/", search: "" },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mainScript, sandbox);

  // Case A: Tall viewport (scrollY === 0, innerHeight 1400 >= scrollHeight 1341) must stay on first section, not last
  sandbox.syncSectionJumpVisibilityAndSpy(true);
  assert.equal(chips[0].classList.contains("is-active"), true, "scrollY===0 must highlight first section even when whole page fits");
  assert.equal(chips[2].classList.contains("is-active"), false, "scrollY===0 must not jump to last section");

  // Case B: Click jump to exempt-accordion near bottom -> must stay pinned after lock expires while visible in viewport
  sandbox.window.innerHeight = 900;
  sandbox.window.scrollY = 441; // 441 + 900 === 1341 (exact bottom)
  sandbox.jumpToSection("exempt-accordion");
  nowMs += 1000; // past 700ms lock
  sandbox.syncSectionJumpVisibilityAndSpy(false);
  assert.equal(chips[1].classList.contains("is-active"), true, "Pinned jump to exempt-accordion must survive lock expiry at bottom");
  assert.equal(chips[2].classList.contains("is-active"), false, "nearBottom must not hijack explicit jump to exempt-accordion");

  // Case C: After manual scroll clears pin at bottom, nearBottom highlights last section normally
  sandbox.clearPinnedJumpSection();
  sandbox.syncSectionJumpVisibilityAndSpy(false);
  assert.equal(chips[2].classList.contains("is-active"), true, "Manual scroll at bottom should highlight last section");
});
