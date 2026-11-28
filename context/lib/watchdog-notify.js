/**
 * Safe, zero-dependency, fail-open OS desktop notification & window foreground focus
 * helpers for `context/lib/watchdog.js` (pure env-var / argv indirection, zero shell interpolation).
 */
import { spawn } from "node:child_process";
import {
  decodeFileUriOrPath,
  formatWorkspaceWindowLabel,
  sanitizeConversationId,
  sanitizeWatchdogText,
  truncateUtf8Safe
} from "./watchdog-lease-core.js";

export const NOTIFY_CLICK_EXIT_CODE = 42;
export const NOTIFY_CLICK_STDOUT_TOKEN = "AGY_CLICKED";

function formatShortTitleWorkspace(label, maxBytes = 16) {
  const ws = String(label || "").trim();
  if (!ws) return "";
  if (Buffer.byteLength(ws, "utf8") <= maxBytes) return ws;
  const slashIdx = ws.lastIndexOf("/");
  if (slashIdx > 0 && slashIdx < ws.length - 1) {
    const leaf = ws.slice(slashIdx + 1);
    if (!/^\d+$/.test(leaf)) {
      const prefixed = `…/${leaf}`;
      if (Buffer.byteLength(prefixed, "utf8") <= maxBytes) return prefixed;
      if (Buffer.byteLength(leaf, "utf8") <= maxBytes) return leaf;
    }
  }
  const cut = truncateUtf8Safe(ws, Math.max(4, maxBytes - 2));
  return `${cut}..`;
}

/**
 * Format compact window/subproject tag for desktop notification titles (`<= 19B` so total
 * Windows BalloonTipTitle stays strictly `<= 60B`) and conversation title prefix for bodies.
 */
export function buildWindowNotificationPrefix(lease, { isZh = false } = {}) {
  if (!lease || typeof lease !== "object") {
    return { titleTag: "", bodyPrefix: "" };
  }
  const rawWs =
    (typeof lease.workspaceLabel === "string" && lease.workspaceLabel.trim()) ||
    (typeof lease.cwd === "string" && lease.cwd.trim() ? formatWorkspaceWindowLabel(lease.cwd) : "");
  const cleanWs = rawWs ? sanitizeWatchdogText(rawWs, 48) : "";
  const shortWs = cleanWs ? formatShortTitleWorkspace(cleanWs, 16) : "";
  const titleTag = shortWs ? ` [${shortWs}]` : "";

  const wsBody = cleanWs ? truncateUtf8Safe(cleanWs, 24) : "";
  const titleBody =
    typeof lease.convTitle === "string" && lease.convTitle.trim()
      ? sanitizeWatchdogText(lease.convTitle, 36)
      : "";
  const shortId = String(lease.conversationId || "").slice(0, 4) || "0000";

  let bodyPrefix = "";
  if (wsBody && titleBody) {
    bodyPrefix = isZh ? `【${wsBody} · ${titleBody}】` : `[${wsBody} · ${titleBody}] `;
  } else if (wsBody) {
    bodyPrefix = isZh ? `【窗口: ${wsBody} #${shortId}】` : `[${wsBody} #${shortId}] `;
  } else if (titleBody) {
    bodyPrefix = isZh ? `【${titleBody}】` : `[${titleBody}] `;
  }

  return { titleTag, bodyPrefix };
}

/**
 * C# 5.0 compatible Win32 P/Invoke helper (zero single quotes so it embeds inside a
 * single-quoted PowerShell literal with zero interpolation risk).
 */
export const WIN32_WINDOW_FOCUS_CSHARP = [
  "using System;",
  "using System.Diagnostics;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "public static class AgyDartWinFocus {",
  "  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);",
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);',
  "  private static bool ContainsCjk(string s) {",
  "    if (string.IsNullOrEmpty(s)) return false;",
  "    for (int i = 0; i < s.Length; i++) { if ((int)s[i] >= 0x2E80) return true; }",
  "    return false;",
  "  }",
  "  private static bool HasBoundaryToken(string title, string token) {",
  "    if (string.IsNullOrEmpty(title) || string.IsNullOrEmpty(token)) return false;",
  "    if (ContainsCjk(token)) return title.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0;",
  "    int idx = 0;",
  "    while (idx <= title.Length - token.Length) {",
  "      int pos = title.IndexOf(token, idx, StringComparison.OrdinalIgnoreCase);",
  "      if (pos < 0) return false;",
  "      bool leftOk = pos == 0 || !char.IsLetterOrDigit(title[pos - 1]);",
  "      int end = pos + token.Length;",
  "      bool rightOk = end >= title.Length || !char.IsLetterOrDigit(title[end]);",
  "      if (leftOk && rightOk) return true;",
  "      idx = pos + 1;",
  "    }",
  "    return false;",
  "  }",
  "  private static bool HasSegmentToken(string title, string token) {",
  "    if (string.IsNullOrEmpty(title) || string.IsNullOrEmpty(token)) return false;",
  "    if (title.Equals(token, StringComparison.OrdinalIgnoreCase)) return true;",
  '    if (title.StartsWith(token + " - ", StringComparison.OrdinalIgnoreCase)) return true;',
  '    if (title.IndexOf(" - " + token + " - ", StringComparison.OrdinalIgnoreCase) >= 0) return true;',
  '    if (title.EndsWith(" - " + token, StringComparison.OrdinalIgnoreCase)) return true;',
  "    return false;",
  "  }",
  "  public static int ScoreWindow(string wt, string pn, string convTitle, string wsLabel, string cwd) {",
  "    if (string.IsNullOrEmpty(wt)) return -1;",
  '    string proc = pn ?? "";',
  '    if (proc.IndexOf("launcher", StringComparison.OrdinalIgnoreCase) >= 0) return -1;',
  '    if (wt.StartsWith("Antigravity Launcher", StringComparison.OrdinalIgnoreCase) || wt.StartsWith("Developer Tools -", StringComparison.OrdinalIgnoreCase)) return -1;',
  '    bool isAgProc = proc.IndexOf("antigravity", StringComparison.OrdinalIgnoreCase) >= 0;',
  '    bool isAgTitle = proc.Length == 0 && (wt.EndsWith(" - Antigravity", StringComparison.OrdinalIgnoreCase) || wt.Equals("Antigravity", StringComparison.OrdinalIgnoreCase));',
  "    if (!isAgProc && !isAgTitle) return -1;",
  '    string tNeedle = (convTitle ?? "").Trim().TrimEnd(".\\u2026".ToCharArray()).Trim();',
  '    int dashIdx = wt.IndexOf(" - ", StringComparison.Ordinal);',
  "    string wtLead = (dashIdx > 0 ? wt.Substring(0, dashIdx) : wt).Trim();",
  '    bool wtTrunc = wt.EndsWith("...", StringComparison.Ordinal) || wt.EndsWith("\\u2026", StringComparison.Ordinal) || wtLead.EndsWith("...", StringComparison.Ordinal) || wtLead.EndsWith("\\u2026", StringComparison.Ordinal);',
  '    string wtStem = (wtLead.EndsWith("...", StringComparison.Ordinal) || wtLead.EndsWith("\\u2026", StringComparison.Ordinal) ? wtLead : wt).Trim().TrimEnd(".\\u2026".ToCharArray()).Trim();',
  '    string cwdNorm = (cwd ?? "").Trim().Replace("/", "\\\\").TrimEnd("\\\\".ToCharArray());',
  '    string cwdLeaf = "";',
  "    if (cwdNorm.Length > 0) {",
  '      int idx = cwdNorm.LastIndexOf("\\\\");',
  "      cwdLeaf = idx >= 0 ? cwdNorm.Substring(idx + 1) : cwdNorm;",
  '      if (cwdLeaf.EndsWith(":")) cwdLeaf = "";',
  "    }",
  '    string wsNorm = (wsLabel ?? "").Trim().Replace("\\\\", "/").Trim("/".ToCharArray());',
  '    string[] wsParts = wsNorm.Split("/".ToCharArray(), StringSplitOptions.RemoveEmptyEntries);',
  '    string wsLeaf = wsParts.Length > 0 ? wsParts[wsParts.Length - 1].Trim() : "";',
  '    string wsParent = wsParts.Length > 1 ? wsParts[0].Trim() : "";',
  "    int score = isAgProc ? 20 : 10;",
  "    if (tNeedle.Length >= 2 && wt.IndexOf(tNeedle, StringComparison.OrdinalIgnoreCase) >= 0) score += 1000;",
  "    else if (wtTrunc && wtStem.Length >= 4 && tNeedle.Length >= wtStem.Length && tNeedle.StartsWith(wtStem, StringComparison.OrdinalIgnoreCase)) score += 950;",
  '    if (wsNorm.IndexOf("/") > 0 && (HasBoundaryToken(wt, wsNorm) || HasBoundaryToken(wt, wsNorm.Replace("/", "\\\\")))) score += 560;',
  "    bool matchedLeaf = false;",
  "    bool matchedParent = false;",
  "    if (cwdLeaf.Length > 0) {",
  "      if (HasSegmentToken(wt, cwdLeaf)) { score += (wsParent.Length > 0 ? 220 : 420); matchedLeaf = true; }",
  "      else if (cwdLeaf.Length >= 2 && HasBoundaryToken(wt, cwdLeaf)) { score += (wsParent.Length > 0 ? 110 : 180); matchedLeaf = true; }",
  "    }",
  "    if (wsLeaf.Length > 0 && !wsLeaf.Equals(cwdLeaf, StringComparison.OrdinalIgnoreCase)) {",
  "      if (HasSegmentToken(wt, wsLeaf)) { score += 400; matchedLeaf = true; }",
  "      else if (wsLeaf.Length >= 2 && HasBoundaryToken(wt, wsLeaf)) { score += 200; matchedLeaf = true; }",
  "    }",
  "    if (wsParent.Length > 0 && !wsParent.Equals(cwdLeaf, StringComparison.OrdinalIgnoreCase) && !wsParent.Equals(wsLeaf, StringComparison.OrdinalIgnoreCase)) {",
  "      if (HasSegmentToken(wt, wsParent)) { score += 280; matchedParent = true; }",
  "      else if (wsParent.Length >= 2 && HasBoundaryToken(wt, wsParent)) { score += 140; matchedParent = true; }",
  "    }",
  "    if (matchedParent && matchedLeaf) score += 160;",
  "    return score;",
  "  }",
  "  public static bool FocusBest(string convTitle, string wsLabel, string cwd) {",
  "    IntPtr best = IntPtr.Zero;",
  "    int bestScore = -1;",
  "    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {",
  "      if (!IsWindowVisible(hWnd)) return true;",
  "      int cloaked = 0;",
  "      if (DwmGetWindowAttribute(hWnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;",
  "      int len = GetWindowTextLengthW(hWnd);",
  "      if (len <= 0) return true;",
  "      StringBuilder sb = new StringBuilder(Math.Min(len + 2, 512));",
  "      GetWindowTextW(hWnd, sb, sb.Capacity);",
  "      string wt = sb.ToString();",
  "      uint pid = 0;",
  "      GetWindowThreadProcessId(hWnd, out pid);",
  '      string pn = "";',
  "      if (pid != 0) {",
  '        try { pn = Process.GetProcessById((int)pid).ProcessName ?? ""; } catch {}',
  "      }",
  "      int sc = ScoreWindow(wt, pn, convTitle, wsLabel, cwd);",
  "      if (sc >= 0 && GetWindow(hWnd, 4) == IntPtr.Zero) sc += 5;",
  "      if (sc > bestScore) { bestScore = sc; best = hWnd; }",
  "      return true;",
  "    }, IntPtr.Zero);",
  "    if (best == IntPtr.Zero) return false;",
  "    if (IsIconic(best)) ShowWindow(best, 9); else ShowWindow(best, 5);",
  "    IntPtr fg = GetForegroundWindow();",
  "    uint curTid = GetCurrentThreadId();",
  "    uint dummy = 0;",
  "    uint fgTid = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out dummy) : 0;",
  "    uint targetTid = GetWindowThreadProcessId(best, out dummy);",
  "    bool attFg = false;",
  "    bool attTarget = false;",
  "    try {",
  "      if (fgTid != 0 && fgTid != curTid) attFg = AttachThreadInput(curTid, fgTid, true);",
  "      if (targetTid != 0 && targetTid != curTid && targetTid != fgTid) attTarget = AttachThreadInput(curTid, targetTid, true);",
  "      SetWindowPos(best, new IntPtr(-1), 0, 0, 0, 0, 0x0043);",
  "      SetWindowPos(best, new IntPtr(-2), 0, 0, 0, 0, 0x0043);",
  "      BringWindowToTop(best);",
  "      SetForegroundWindow(best);",
  "      if (GetForegroundWindow() != best) {",
  "        keybd_event(0xFF, 0, 0, UIntPtr.Zero);",
  "        keybd_event(0xFF, 0, 2, UIntPtr.Zero);",
  "        SetForegroundWindow(best);",
  "      }",
  "    } finally {",
  "      if (attTarget) AttachThreadInput(curTid, targetTid, false);",
  "      if (attFg) AttachThreadInput(curTid, fgTid, false);",
  "    }",
  "    return true;",
  "  }",
  "}"
].join(" ");

function buildWin32FocusCompilePowerShell() {
  return `if (-not ('AgyDartWinFocus' -as [type])) { Add-Type -TypeDefinition '${WIN32_WINDOW_FOCUS_CSHARP}' -ErrorAction Stop; }`;
}

function buildWin32FocusInvokePowerShell() {
  return [
    "$ct = [Environment]::GetEnvironmentVariable('AGY_DART_NOTIFY_CONV_TITLE');",
    "$ws = [Environment]::GetEnvironmentVariable('AGY_DART_NOTIFY_WS_LABEL');",
    "$cw = [Environment]::GetEnvironmentVariable('AGY_DART_NOTIFY_CWD');",
    "if ('AgyDartWinFocus' -as [type]) { [void][AgyDartWinFocus]::FocusBest($ct, $ws, $cw); }"
  ].join(" ");
}

function buildWin32FocusPowerShellCall() {
  return `${buildWin32FocusCompilePowerShell()} ${buildWin32FocusInvokePowerShell()}`;
}

function sanitizeNotificationIdentity({ conversationId = "", cwd = "", workspaceLabel = "", convTitle = "" } = {}) {
  const safeConvId = sanitizeConversationId(conversationId);
  const decodedCwd = decodeFileUriOrPath(cwd);
  const safeCwd = decodedCwd ? sanitizeWatchdogText(decodedCwd, 260) : "";
  const rawWs =
    (typeof workspaceLabel === "string" && workspaceLabel.trim()) ||
    (decodedCwd ? formatWorkspaceWindowLabel(decodedCwd) : "");
  const safeWsLabel = rawWs ? sanitizeWatchdogText(rawWs, 64) : "";
  const safeConvTitle =
    typeof convTitle === "string" && convTitle.trim() ? sanitizeWatchdogText(convTitle, 64) : "";
  return { safeConvId, safeCwd, safeWsLabel, safeConvTitle };
}

/**
 * Pure OS window focus command builder (env-var indirection on Windows,
 * static AppleScript on macOS — zero dynamic shell interpolation).
 */
export function buildWindowFocusCommand({
  conversationId = "",
  cwd = "",
  workspaceLabel = "",
  convTitle = "",
  platform = process.platform,
  baseEnv = process.env
} = {}) {
  const { safeConvId, safeCwd, safeWsLabel, safeConvTitle } = sanitizeNotificationIdentity({
    conversationId,
    cwd,
    workspaceLabel,
    convTitle
  });
  const env = { ...baseEnv };
  let cmd = "";
  let args = [];

  if (platform === "win32") {
    env.AGY_DART_NOTIFY_CONV_ID = safeConvId;
    env.AGY_DART_NOTIFY_CWD = safeCwd;
    env.AGY_DART_NOTIFY_WS_LABEL = safeWsLabel;
    env.AGY_DART_NOTIFY_CONV_TITLE = safeConvTitle;
    const psScript = `try { ${buildWin32FocusPowerShellCall()} } catch {}`;
    cmd = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript];
  } else if (platform === "darwin") {
    cmd = "osascript";
    args = ["-e", 'tell application "Antigravity" to activate'];
  }

  return { cmd, args, env, safeConvId, safeCwd, safeWsLabel, safeConvTitle, platform };
}

function isRunningInNodeTestRunner(env = process.env, execArgv = process.execArgv) {
  return Boolean(
    (typeof env?.NODE_TEST_CONTEXT === "string" && env.NODE_TEST_CONTEXT.trim() !== "") ||
      (Array.isArray(execArgv) && execArgv.includes("--test"))
  );
}

/**
 * Safe, zero-dependency, fail-open OS window foreground activator for cross-window jumps.
 */
export function focusDesktopConversationWindow({
  conversationId = "",
  cwd = "",
  workspaceLabel = "",
  convTitle = "",
  platform = process.platform,
  spawnFn = spawn,
  baseEnv = process.env
} = {}) {
  try {
    const spec = buildWindowFocusCommand({
      conversationId,
      cwd,
      workspaceLabel,
      convTitle,
      platform,
      baseEnv
    });
    if (!spec.cmd) {
      return { dispatched: false, platform };
    }
    const disableFlag = String(baseEnv?.AGY_DART_DISABLE_OS_FOCUS || "").trim().toLowerCase();
    if (
      spawnFn === spawn &&
      (disableFlag === "1" || disableFlag === "true" || isRunningInNodeTestRunner(baseEnv))
    ) {
      return { dispatched: false, platform, suppressed: true };
    }
    const child = spawnFn(spec.cmd, spec.args, {
      stdio: "ignore",
      windowsHide: true,
      env: spec.env
    });
    child.on?.("error", () => {});
    const killTimer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {}
    }, 8000);
    killTimer.unref?.();
    child.on?.("exit", () => clearTimeout(killTimer));
    child.unref?.();
    return { dispatched: true, platform };
  } catch {
    return { dispatched: false, platform };
  }
}

/**
 * Pure OS desktop notification command builder (env-var indirection on Windows,
 * strict argv-only dispatch on macOS/Linux — zero dynamic shell interpolation).
 */
export function buildDesktopNotificationCommand({
  title = "agy-dart Stall Watchdog",
  body = "",
  conversationId = "",
  cwd = "",
  workspaceLabel = "",
  convTitle = "",
  platform = process.platform,
  baseEnv = process.env
} = {}) {
  const safeTitle = sanitizeWatchdogText(title, 60) || "agy-dart Stall Watchdog";
  const safeBody =
    sanitizeWatchdogText(body, 220) || "Session appears stalled. Open agy-dart Sidecar for Rescue Brief.";
  const { safeConvId, safeCwd, safeWsLabel, safeConvTitle } = sanitizeNotificationIdentity({
    conversationId,
    cwd,
    workspaceLabel,
    convTitle
  });

  let cmd = "";
  let args = [];
  const env = { ...baseEnv };

  if (platform === "win32") {
    env.AGY_DART_NOTIFY_TITLE = safeTitle;
    env.AGY_DART_NOTIFY_BODY = safeBody;
    env.AGY_DART_NOTIFY_CONV_ID = safeConvId;
    env.AGY_DART_NOTIFY_CWD = safeCwd;
    env.AGY_DART_NOTIFY_WS_LABEL = safeWsLabel;
    env.AGY_DART_NOTIFY_CONV_TITLE = safeConvTitle;
    const psScript = [
      "$t = [Environment]::GetEnvironmentVariable('AGY_DART_NOTIFY_TITLE');",
      "$b = [Environment]::GetEnvironmentVariable('AGY_DART_NOTIFY_BODY');",
      "$script:clicked = $false;",
      "$script:closed = $false;",
      "try {",
      "  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop;",
      "  Add-Type -AssemblyName System.Drawing -ErrorAction Stop;",
      "  $ni = New-Object System.Windows.Forms.NotifyIcon;",
      "  $ni.Icon = [System.Drawing.SystemIcons]::Warning;",
      "  $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning;",
      "  $ni.BalloonTipTitle = $t;",
      "  $ni.BalloonTipText = $b;",
      "  $ni.add_BalloonTipClicked({ $script:clicked = $true });",
      "  $ni.add_BalloonTipClosed({ $script:closed = $true });",
      "  $ni.Visible = $true;",
      "  $ni.ShowBalloonTip(5000);",
      "  $sw = [System.Diagnostics.Stopwatch]::StartNew();",
      "  while (-not $script:clicked -and -not $script:closed -and $sw.ElapsedMilliseconds -lt 6500) {",
      "    [System.Windows.Forms.Application]::DoEvents();",
      "    Start-Sleep -Milliseconds 60;",
      "  }",
      "  [System.Windows.Forms.Application]::DoEvents();",
      "  $ni.Visible = $false;",
      "  $ni.Dispose();",
      "} catch {}",
      "if ($script:clicked) {",
      `  try { ${buildWin32FocusCompilePowerShell()} } catch {}`,
      `  try { [Console]::Out.WriteLine('${NOTIFY_CLICK_STDOUT_TOKEN}'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 25; } catch {}`,
      `  try { ${buildWin32FocusInvokePowerShell()} } catch {}`,
      `  [Environment]::Exit(${NOTIFY_CLICK_EXIT_CODE});`,
      "}"
    ].join(" ");
    cmd = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript];
  } else if (platform === "darwin") {
    cmd = "osascript";
    args = [
      "-e",
      "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
      "--",
      safeTitle,
      safeBody
    ];
  } else {
    cmd = "notify-send";
    args = ["--app-name=agy-dart", "--urgency=normal", "--", safeTitle, safeBody];
  }

  return {
    cmd,
    args,
    env,
    safeTitle,
    safeBody,
    safeConvId,
    safeCwd,
    safeWsLabel,
    safeConvTitle,
    platform
  };
}

/**
 * Safe, zero-dependency, fail-open OS desktop notification helper (opt-in only).
 * Supports click-to-jump callback via stdout fast-path token and exit code 42.
 */
export function sendDesktopNotification({
  title = "agy-dart Stall Watchdog",
  body = "",
  conversationId = "",
  cwd = "",
  workspaceLabel = "",
  convTitle = "",
  onClick = null,
  platform = process.platform,
  spawnFn = spawn
} = {}) {
  try {
    const spec = buildDesktopNotificationCommand({
      title,
      body,
      conversationId,
      cwd,
      workspaceLabel,
      convTitle,
      platform
    });
    const hasClickCallback = typeof onClick === "function";
    const child = spawnFn(spec.cmd, spec.args, {
      stdio: hasClickCallback ? ["ignore", "pipe", "ignore"] : "ignore",
      windowsHide: true,
      env: spec.env
    });
    let clickHandled = false;
    const fireClickOnce = () => {
      if (clickHandled || !hasClickCallback) return;
      clickHandled = true;
      try {
        onClick({
          conversationId: spec.safeConvId,
          cwd: spec.safeCwd,
          workspaceLabel: spec.safeWsLabel,
          convTitle: spec.safeConvTitle
        });
      } catch {}
    };
    if (hasClickCallback && child?.stdout) {
      let stdoutBuf = "";
      child.stdout.on?.("data", (chunk) => {
        stdoutBuf += String(chunk || "");
        if (stdoutBuf.includes(NOTIFY_CLICK_STDOUT_TOKEN)) {
          fireClickOnce();
        } else if (stdoutBuf.length > 256) {
          stdoutBuf = stdoutBuf.slice(-128);
        }
      });
      child.stdout.on?.("error", () => {});
      child.stdout.unref?.();
    }
    child.on?.("error", () => {});
    const killTimer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {}
    }, 15000);
    killTimer.unref?.();
    let finalized = false;
    const onTerminate = (code) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(killTimer);
      if (code === NOTIFY_CLICK_EXIT_CODE) {
        fireClickOnce();
      }
    };
    child.on?.("close", onTerminate);
    child.on?.("exit", onTerminate);
    child.unref?.();
    return { dispatched: true, platform };
  } catch {
    return { dispatched: false, platform };
  }
}
