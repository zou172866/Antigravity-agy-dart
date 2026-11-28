import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Reads `sidecars/dashboard/index.html` and inlines external `/ui/*` assets into
 * `<style>`, `<script data-theme-init>`, and one combined `<script>` block so VM/regex
 * unit tests remain compatible with the modular runtime UI files.
 */
export function readDashboardHtml(rootDir = REPO_ROOT) {
  const dashDir = path.join(rootDir, "sidecars", "dashboard");
  let html = fs.readFileSync(path.join(dashDir, "index.html"), "utf8");

  html = html.replace(
    /<link\s+rel="stylesheet"\s+href="\/ui\/([^"]+)"\s*\/?>/gi,
    (_m, relPath) => {
      const css = fs.readFileSync(path.join(dashDir, "ui", relPath), "utf8");
      return `<style>\n${css}</style>`;
    }
  );

  html = html.replace(
    /<script\s+data-theme-init\s+src="\/ui\/([^"]+)"\s*><\/script>/gi,
    (_m, relPath) => {
      const js = fs.readFileSync(path.join(dashDir, "ui", relPath), "utf8");
      return `<script data-theme-init>\n${js}</script>`;
    }
  );

  const mainScripts = [];
  let firstScriptIdx = -1;
  html = html.replace(/<script\s+src="\/ui\/([^"]+)"\s*><\/script>/gi, (_m, relPath, offset) => {
    const js = fs.readFileSync(path.join(dashDir, "ui", relPath), "utf8");
    mainScripts.push(js);
    if (firstScriptIdx < 0) {
      firstScriptIdx = offset;
      return "__AGY_DART_INLINE_MAIN_SCRIPT__";
    }
    return "";
  });

  if (mainScripts.length > 0) {
    html = html.replace(
      "__AGY_DART_INLINE_MAIN_SCRIPT__",
      () => `<script>\n${mainScripts.join("\n")}</script>`
    );
  }

  return html;
}

/**
 * Fetches `/` from a live standalone dashboard server and resolves its `/ui/*`
 * stylesheet and script tags over HTTP into an inline document for VM/DOM tests.
 */
export async function fetchDashboardHtml(baseUrl) {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const htmlRes = await fetch(`${origin}/`);
  if (!htmlRes.ok) {
    throw new Error(`GET ${origin}/ failed with HTTP ${htmlRes.status}`);
  }
  let html = await htmlRes.text();

  const fetchText = async (assetPath) => {
    const res = await fetch(`${origin}${assetPath}`);
    if (!res.ok) {
      throw new Error(`GET ${origin}${assetPath} failed with HTTP ${res.status}`);
    }
    return res.text();
  };

  for (const m of [...html.matchAll(/<link\s+rel="stylesheet"\s+href="(\/ui\/[^"]+)"\s*\/?>/gi)]) {
    const css = await fetchText(m[1]);
    html = html.replace(m[0], () => `<style>\n${css}</style>`);
  }

  for (const m of [...html.matchAll(/<script\s+data-theme-init\s+src="(\/ui\/[^"]+)"\s*><\/script>/gi)]) {
    const js = await fetchText(m[1]);
    html = html.replace(m[0], () => `<script data-theme-init>\n${js}</script>`);
  }

  const scriptMatches = [...html.matchAll(/<script\s+src="(\/ui\/[^"]+)"\s*><\/script>/gi)];
  if (scriptMatches.length > 0) {
    const parts = [];
    for (const m of scriptMatches) {
      parts.push(await fetchText(m[1]));
    }
    html = html.replace(scriptMatches[0][0], () => `<script>\n${parts.join("\n")}</script>`);
    for (let i = 1; i < scriptMatches.length; i++) {
      html = html.replace(scriptMatches[i][0], "");
    }
  }

  return html;
}
