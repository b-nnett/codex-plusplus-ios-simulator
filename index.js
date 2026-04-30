/**
 * co.bennett.ios-simulator
 *
 * Adds an "iOS Simulator" tab to Codex's right-panel + menu.
 *
 * - Native-looking right-panel tab + panel (parallel-injected, draggable,
 *   close-on-hover, sibling of summary/diff in the tablist).
 * - Headless capture via CoreSimulator IOSurface (sim-capture helper). No
 *   Simulator.app window is launched.
 * - Touch / hardware-button forwarding via SimDeviceLegacyHIDClient
 *   (sim-input helper, ported FBSimulatorIndigoHID).
 * - Toolbar (Home / Screenshot / device picker), auto-boots a sensible
 *   default device on panel open if nothing is booted.
 */

"use strict";

const TWEAK_ATTR = "data-codexpp-ios-sim";
const STYLE_ID = "codexpp-ios-sim-style";
const MENU_LABEL = "iOS Simulator";
const PANEL_LABEL = "iOS Simulator";
const BROWSER_PATTERNS = [
  /^browser$/i,
  /^browser use$/i,
  /\bbrowser\b/i,
  /浏览器/,
  /瀏覽器/,
];
const MENU_FALLBACK_PATTERNS = [
  /^open file$/i,
  /^browse files$/i,
  /打开文件/,
  /開啟檔案/,
];
const PICKER_TITLE_PATTERNS = [
  /^new chat$/i,
  /新(建)?聊天/,
  /新(建)?对话/,
  ...MENU_FALLBACK_PATTERNS,
];
const PICKER_SUBTITLE = "Mirror the iOS Simulator in this pane";
const HID_USAGE = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
};
const HID_MODIFIER_USAGE = {
  Control: 0xe0,
  Shift: 0xe1,
  Alt: 0xe2,
  Meta: 0xe3,
};

const PHONE_SVG =
  '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 rounded-2xs">' +
  '<rect x="6" y="3" width="8" height="14" rx="1.75" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M9 5h2" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
  '<circle cx="10" cy="14.5" r="0.75" fill="currentColor"/>' +
  "</svg>";
const PHONE_ICON =
  '<span aria-hidden="true" class="flex h-4 w-4 shrink-0 items-center justify-center">' +
  PHONE_SVG +
  "</span>";

const SVGS = {
  // iOS home indicator pill
  home:
    '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="icon-xs"><rect x="4" y="9" width="12" height="2.2" rx="1.1" fill="currentColor"/></svg>',
  // Camera — unchanged shape, slightly heavier strokes
  camera:
    '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="icon-xs"><path d="M7 5.5h6l1.1 1.5H16a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 4 7h1.9L7 5.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="10" cy="11.25" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg>',
  // Chevron-down for picker
  chevron:
    '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" class="icon-xs"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // Close X (matches native size)
  close:
    '<svg width="21" height="21" viewBox="0 0 21 21" fill="none" class="icon-xs"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.8 2.485A8.333 8.333 0 1 1 10.8 19.152a8.333 8.333 0 0 1 0-16.667zM9.008 7.518a.876.876 0 0 0-1.383 1.383L9.542 10.818l-1.917 1.916a.876.876 0 1 0 1.383 1.383L10.925 12.2l1.917 1.917a.876.876 0 1 0 1.382-1.383l-1.916-1.916 1.916-1.917a.876.876 0 0 0-1.382-1.383L10.925 9.434 9.008 7.518z" fill="currentColor"/></svg>',
  // Larger phone glyph for placeholder
  phoneLarge:
    '<svg width="96" height="96" viewBox="0 0 20 20" fill="none"><rect x="5.25" y="1.75" width="9.5" height="16.5" rx="2.25" stroke="currentColor" stroke-width="1.1"/><path d="M8.5 3.5h3" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/><rect x="8.25" y="15.75" width="3.5" height="0.6" rx="0.3" fill="currentColor"/></svg>',
};

module.exports = {
  async start(api) {
    this.api = api;
    this.cleanup = [];

    if (api.process === "main") {
      registerMainHandlers(api, this);
      return;
    }

    // Hide the menu entry entirely on non-macOS hosts. The right tablist
    // never gains an iOS Simulator option there; everything else short-
    // circuits cleanly because no IPC channels are registered either.
    if (typeof process !== "undefined" && process.platform && process.platform !== "darwin") {
      api.log?.info?.("ios-sim disabled (platform=" + process.platform + ")");
      return;
    }

    injectStyles();
    this.cleanup.push(() => document.getElementById(STYLE_ID)?.remove());
    this.cleanup.push(() => removeSimPanel());

    await api.react.waitForElement?.("body", 10_000);

    this.observer = new MutationObserver(() => this.installMenuEntries());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.cleanup.push(() => this.observer?.disconnect());

    this.installMenuEntries();
  },

  stop() {
    this.removeMainHandlers?.();
    this.removeMainHandlers = null;
    if (typeof document === "undefined") return;
    for (const dispose of this.cleanup ?? []) {
      try {
        dispose();
      } catch {}
    }
    this.cleanup = [];
    document.querySelectorAll(`[${TWEAK_ATTR}]`).forEach((node) => node.remove());
    removeSimPanel();
  },

  installMenuEntries() {
    for (const browserButton of findBrowserMenuButtons()) {
      if (browserButton.nextElementSibling?.getAttribute(TWEAK_ATTR) === "menu-entry") {
        continue;
      }
      const simButton = browserButton.cloneNode(true);
      simButton.setAttribute(TWEAK_ATTR, "menu-entry");
      simButton.setAttribute("aria-label", MENU_LABEL);
      rewriteMenuEntry(simButton);

      const activate = (event) => {
        event.preventDefault();
        event.stopPropagation();
        // The same gesture fires pointerdown → mousedown → click. We listen
        // to all three (capture phase) so we win over Codex's React handlers,
        // but we only want one activation per gesture.
        const now = Date.now();
        if (simButton.__codexppLastActivate && now - simButton.__codexppLastActivate < 400) return;
        simButton.__codexppLastActivate = now;
        closeTransientMenu(browserButton);
        this.api?.log?.info?.("opening iOS Simulator side panel");
        openSimPanel(this.api);
      };

      simButton.addEventListener("pointerdown", activate, true);
      simButton.addEventListener("mousedown", activate, true);
      simButton.addEventListener("click", activate, true);
      browserButton.insertAdjacentElement("afterend", simButton);
    }
  },
};

// ── main process ────────────────────────────────────────────────────────

function registerMainHandlers(api, tweak) {
  if (process.platform !== "darwin") {
    api.log?.info?.("ios-sim main handlers skipped (platform=" + process.platform + ")");
    tweak.removeMainHandlers = () => {};
    return;
  }
  const { spawn, spawnSync } = require("node:child_process");
  const electron = require("electron");
  const { ipcMain, webContents } = electron;
  const fs = require("node:fs");
  const path = require("node:path");
  const buildDir = path.join(electron.app.getPath("userData"), "codex-plusplus-ios-simulator");
  const id = api.manifest?.id || "co.bennett.ios-simulator";
  const ch = (name) => `codexpp:${id}:${name}`;
  const channels = [
    "ios-sim:launch",
    "ios-sim:devices",
    "ios-sim:simctl",
    "ios-sim:screenshot",
    "ios-sim:capture:start",
    "ios-sim:capture:stop",
    "ios-sim:input:event",
    "ios-sim:preflight",
  ].map(ch);

  const firstLine = (s) =>
    ((s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0]) || "";

  for (const c of channels) {
    try {
      ipcMain.removeHandler(c);
    } catch {}
  }

  // Capture state ------------------------------------------------------
  const helperDir = path.join(__dirname, "helpers");
  const swiftSrc = path.join(helperDir, "sim-capture.swift");
  const helperBin = path.join(buildDir, "sim-capture");
  const FRAME_CHANNEL = ch("ios-sim:capture:frame");
  const META_CHANNEL = ch("ios-sim:capture:meta");
  const STATUS_CHANNEL = ch("ios-sim:capture:status");

  const capture = (globalThis.__codexppIosSimCapture = globalThis.__codexppIosSimCapture || {
    proc: null,
    starting: false,
    lastMeta: null,
  });

  function broadcast(channel, ...args) {
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed?.()) continue;
        wc.send(channel, ...args);
      }
    } catch (e) {
      api.log?.warn?.("ios-sim broadcast failed", e);
    }
  }

  function sendStatus(payload) {
    broadcast(STATUS_CHANNEL, payload);
  }

  function ensureBinary() {
    if (!fs.existsSync(swiftSrc)) {
      return { ok: false, error: "missing sim-capture.swift" };
    }
    fs.mkdirSync(buildDir, { recursive: true });
    let needsBuild = !fs.existsSync(helperBin);
    if (!needsBuild) {
      const a = fs.statSync(helperBin).mtimeMs;
      const b = fs.statSync(swiftSrc).mtimeMs;
      if (b > a) needsBuild = true;
    }
    if (!needsBuild) return { ok: true };
    sendStatus({ kind: "compiling" });
    api.log?.info?.("ios-sim compiling helper");
    const r = spawnSync(
      "/usr/bin/swiftc",
      [
        "-O",
        "-framework", "ScreenCaptureKit",
        "-framework", "CoreImage",
        "-framework", "AppKit",
        "-framework", "CoreMedia",
        "-framework", "CoreVideo",
        swiftSrc,
        "-o", helperBin,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      api.log?.error?.("ios-sim compile failed", r.stderr);
      const head = firstLine(r.stderr) || firstLine(r.stdout) || "exit " + r.status;
      return { ok: false, error: "swiftc: " + head + " (see preload.log)" };
    }
    return { ok: true };
  }

  function stopCapture(reason) {
    if (capture.proc) {
      try {
        capture.proc.kill("SIGTERM");
      } catch {}
      capture.proc = null;
    }
    capture.starting = false;
    // Drop cached meta — otherwise the next start() re-broadcasts stale meta
    // (wrong device) before the fresh helper has emitted its own stream-started.
    capture.lastMeta = null;
    if (reason) sendStatus({ kind: "stopped", reason });
  }

  function startCapture() {
    if (capture.proc) return { ok: true, status: "already-running" };
    if (capture.starting) return { ok: true, status: "starting" };
    const built = ensureBinary();
    if (!built.ok) {
      sendStatus({ kind: "error", error: built.error });
      return { ok: false, error: built.error };
    }
    capture.starting = true;
    sendStatus({ kind: "starting" });

    const proc = spawn(helperBin, [], { stdio: ["ignore", "pipe", "pipe"] });
    capture.proc = proc;
    capture.starting = false;

    // stdout: [u32 BE length][JPEG]
    let buf = Buffer.alloc(0);
    proc.stdout.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0 || len > 8_000_000) {
          api.log?.warn?.("ios-sim bogus frame length", len);
          buf = Buffer.alloc(0);
          break;
        }
        if (buf.length < 4 + len) break;
        const jpeg = buf.subarray(4, 4 + len);
        // copy because we'll slice the underlying buffer
        broadcast(FRAME_CHANNEL, Buffer.from(jpeg));
        buf = buf.subarray(4 + len);
      }
    });

    let stderrLine = "";
    proc.stderr.on("data", (chunk) => {
      stderrLine += chunk.toString("utf8");
      let nl;
      while ((nl = stderrLine.indexOf("\n")) >= 0) {
        const line = stderrLine.slice(0, nl).trim();
        stderrLine = stderrLine.slice(nl + 1);
        if (!line) continue;
        const m = line.match(/^\[sim-capture\]\s+(\{.*\})\s*$/);
        if (m) {
          try {
            const meta = JSON.parse(m[1]);
            if (meta.type === "no-booted-device") {
              capture.lastMeta = null;
              stopInput("capture-no-booted-device");
              broadcast(META_CHANNEL, meta);
              continue;
            }
            capture.lastMeta = meta;
            if (meta.deviceUDID && input.proc && input.udid !== meta.deviceUDID) {
              stopInput("capture-device-changed");
            }
            broadcast(META_CHANNEL, meta);
          } catch (e) {
            api.log?.warn?.("ios-sim meta parse", e, line);
          }
        } else {
          if (/booted device gone/i.test(line)) {
            capture.lastMeta = null;
            stopInput("capture-device-gone");
          }
          api.log?.info?.("[sim-capture]", line);
        }
      }
    });

    proc.on("error", (e) => {
      api.log?.error?.("ios-sim helper error", e);
      capture.proc = null;
      sendStatus({ kind: "error", error: String(e) });
    });
    proc.on("exit", (code, signal) => {
      api.log?.info?.("ios-sim helper exit", code, signal);
      if (capture.proc === proc) capture.proc = null;
      sendStatus({ kind: "stopped", reason: `exit ${code} ${signal || ""}`.trim() });
    });

    return { ok: true, status: "started" };
  }

  // Input helper -------------------------------------------------------
  const inputSrc = path.join(helperDir, "sim-input.m");
  const inputBin = path.join(buildDir, "sim-input");

  const input = (globalThis.__codexppIosSimInput = globalThis.__codexppIosSimInput || {
    proc: null,
    udid: null,
    eventQueue: Promise.resolve(),
  });

  function ensureInputBinary() {
    if (!fs.existsSync(inputSrc)) return { ok: false, error: "missing sim-input.m" };
    fs.mkdirSync(buildDir, { recursive: true });
    let needsBuild = !fs.existsSync(inputBin);
    if (!needsBuild) {
      const a = fs.statSync(inputBin).mtimeMs;
      const b = fs.statSync(inputSrc).mtimeMs;
      if (b > a) needsBuild = true;
    }
    if (!needsBuild) return { ok: true };
    api.log?.info?.("ios-sim compiling input helper");
    const r = spawnSync(
      "/usr/bin/clang",
      ["-fobjc-arc", "-O2", "-framework", "Foundation", "-framework", "CoreGraphics", inputSrc, "-o", inputBin],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      api.log?.error?.("ios-sim input compile failed", r.stderr);
      const head = firstLine(r.stderr) || firstLine(r.stdout) || "exit " + r.status;
      return { ok: false, error: "clang: " + head + " (see preload.log)" };
    }
    return { ok: true };
  }

  function ensureInputProc(udid) {
    const targetUDID = udid || null;
    if (input.proc && !input.proc.killed && input.udid === targetUDID) return { ok: true };
    if (input.proc && input.udid !== targetUDID) {
      stopInput("target-device-changed");
    }
    const built = ensureInputBinary();
    if (!built.ok) return built;
    const proc = spawn(inputBin, targetUDID ? [targetUDID] : [], { stdio: ["pipe", "ignore", "pipe"] });
    let stderrBuf = "";
    proc.stderr.on("data", (b) => {
      stderrBuf += b.toString("utf8");
      let nl;
      while ((nl = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        const trimmed = line.trim();
        if (trimmed) {
          api.log?.info?.("[sim-input]", trimmed);
          if (/machPortInvalid/i.test(trimmed)) {
            stopInput("input-mach-port-invalid");
          }
        }
      }
    });
    proc.on("error", (e) => {
      api.log?.error?.("sim-input error", e);
      input.proc = null;
    });
    proc.on("exit", (code, sig) => {
      api.log?.info?.("sim-input exit", code, sig);
      if (input.proc === proc) input.proc = null;
    });
    input.proc = proc;
    input.udid = targetUDID;
    return { ok: true };
  }

  function stopInput(reason) {
    if (input.proc) {
      if (reason) api.log?.info?.("ios-sim stopping input helper", reason);
      try { input.proc.kill("SIGTERM"); } catch {}
      input.proc = null;
    }
    input.udid = null;
  }

  function writeInputEvent(event) {
    input.proc.stdin.write(JSON.stringify(event) + "\n");
  }

  function pbcopyToDevice(udid, text) {
    const device = udid || "booted";
    return new Promise((resolve) => {
      const p = spawn("xcrun", ["simctl", "pbcopy", device], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let err = "";
      p.stderr.on("data", (b) => (err += b));
      p.on("error", (e) => resolve({ ok: false, error: String(e) }));
      p.on("exit", (code) =>
        resolve({ ok: code === 0, code, error: err || undefined }),
      );
      try {
        p.stdin.end(text);
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  async function sendTextInput(targetUDID, text) {
    const value = String(text || "");
    if (!value) return { ok: true };
    if (value.length > 4096) return { ok: false, error: "text input too long" };

    const copied = await pbcopyToDevice(targetUDID, value);
    if (!copied.ok) return copied;

    const r = ensureInputProc(targetUDID);
    if (!r.ok) return r;
    writeInputEvent({ type: "key-tap", usage: 0x19, modifiers: [0xe3] }); // Cmd+V
    return { ok: true };
  }

  function enqueueTextInput(targetUDID, text) {
    return enqueueInputOperation(() => sendTextInput(targetUDID, text));
  }

  function sendHelperInputEvent(targetUDID, event) {
    const r = ensureInputProc(targetUDID);
    if (!r.ok) return r;
    try {
      writeInputEvent(event);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function enqueueInputOperation(fn) {
    const previous = input.eventQueue || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    input.eventQueue = next;
    return next;
  }

  ipcMain.handle(ch("ios-sim:input:event"), async (_evt, event) => {
    const targetUDID = event?.deviceUDID || capture.lastMeta?.deviceUDID || null;
    if (event?.type === "text") {
      return enqueueTextInput(targetUDID, event.text);
    }
    if (event?.type === "keyboard" || event?.type === "key-tap") {
      return enqueueInputOperation(() => sendHelperInputEvent(targetUDID, event));
    }
    const r = ensureInputProc(targetUDID);
    if (!r.ok) return r;
    try {
      writeInputEvent(event);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // Quit Simulator.app so booting a device doesn't pop up an attached window.
  // simctl boot itself is headless; only a running Simulator.app auto-attaches.
  async function killSimulatorApp() {
    return new Promise((resolve) => {
      const p = spawn("/usr/bin/killall", ["-q", "Simulator"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      p.on("error", () => resolve());
      // killall exits 1 when no process matches; either outcome is fine.
      p.on("exit", () => resolve());
    });
  }

  // Defense-in-depth: only the verbs the tweak actually needs are allowed
  // through this channel. Anything else (notably `spawn`, `install`, `push`)
  // would let a compromised renderer execute arbitrary code on the booted
  // device or on the host. Screenshots have a dedicated handler below.
  const SIMCTL_ALLOW = new Set(["boot", "shutdown"]);
  const UDID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

  ipcMain.handle(ch("ios-sim:simctl"), async (_evt, args) => {
    const list = Array.isArray(args) ? args.map(String) : [];
    const verb = list[0];
    if (!verb || !SIMCTL_ALLOW.has(verb)) {
      return { ok: false, error: "verb not allowed: " + verb };
    }
    if ((verb === "boot" || verb === "shutdown") && !UDID_RE.test(list[1] || "")) {
      return { ok: false, error: verb + " requires a UDID" };
    }
    if (verb === "boot") {
      await killSimulatorApp();
    }
    return new Promise((resolve) => {
      const p = spawn("xcrun", ["simctl", ...list], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (err += b));
      p.on("error", (e) => resolve({ ok: false, error: String(e) }));
      p.on("exit", (code) =>
        resolve({ ok: code === 0, code, stdout: out, stderr: err }),
      );
    });
  });

  // Dedicated screenshot handler. Renderer hands us a filename only; we
  // resolve the path against ~/Desktop here so the renderer never has to
  // know HOME (which it can't read on 0.1.x anyway) and can't request
  // writes to arbitrary filesystem locations.
  const os = require("node:os");
  ipcMain.handle(ch("ios-sim:screenshot"), async (_evt, filename) => {
    const safe = String(filename || "")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 128);
    if (!safe || !/\.(png|jpg|jpeg)$/i.test(safe)) {
      return { ok: false, error: "filename must end in .png/.jpg" };
    }
    const dest = path.join(os.homedir(), "Desktop", safe);
    return new Promise((resolve) => {
      const p = spawn("xcrun", ["simctl", "io", "booted", "screenshot", dest], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      p.stderr.on("data", (b) => (err += b));
      p.on("error", (e) => resolve({ ok: false, error: String(e) }));
      p.on("exit", (code) =>
        resolve({ ok: code === 0, code, path: dest, stderr: err }),
      );
    });
  });

  ipcMain.handle(ch("ios-sim:devices"), async () => {
    return new Promise((resolve) => {
      const p = spawn("xcrun", ["simctl", "list", "devices", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (err += b));
      p.on("error", (e) => resolve({ ok: false, error: String(e) }));
      p.on("exit", (code) => {
        if (code !== 0) {
          resolve({ ok: false, code, stderr: err });
          return;
        }
        try {
          const data = JSON.parse(out);
          resolve({ ok: true, data });
        } catch (e) {
          resolve({ ok: false, error: "json parse: " + String(e) });
        }
      });
    });
  });

  ipcMain.handle(ch("ios-sim:capture:start"), async () => {
    const r = startCapture();
    if (capture.lastMeta) {
      // re-emit last meta so newly-attached renderer gets it
      setTimeout(() => broadcast(META_CHANNEL, capture.lastMeta), 50);
    }
    return r;
  });

  ipcMain.handle(ch("ios-sim:capture:stop"), async () => {
    stopCapture("client-stop");
    stopInput("capture-stop");
    return { ok: true };
  });

  ipcMain.handle(ch("ios-sim:preflight"), async () => {
    // Renderer already bails on non-darwin, but be defensive.
    if (process.platform !== "darwin") {
      return {
        ok: false,
        reason: "platform",
        message: "iOS Simulator requires macOS.",
        hint: null,
        detail: "platform=" + process.platform,
      };
    }
    const xcrunFind = spawnSync("/usr/bin/xcrun", ["-find", "simctl"], { encoding: "utf8" });
    if (xcrunFind.status !== 0) {
      return {
        ok: false,
        reason: "xcrun",
        message: "Xcode developer tools are not configured on this Mac.",
        hint: "Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app",
        detail: firstLine(xcrunFind.stderr),
      };
    }
    const sel = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" });
    const devDir = (sel.stdout || "").trim();
    if (sel.status !== 0 || !devDir) {
      return {
        ok: false,
        reason: "xcode-select",
        message: "Cannot determine the Xcode developer directory.",
        hint: "Run: sudo xcode-select -s /Applications/Xcode.app",
        detail: firstLine(sel.stderr),
      };
    }
    if (!/Xcode.*\.app/i.test(devDir)) {
      return {
        ok: false,
        reason: "clt-only",
        message: "Command-Line Tools are active, but the iOS Simulator needs the full Xcode.",
        hint: "Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app",
        detail: "DEVELOPER_DIR=" + devDir,
      };
    }
    const simKit = path.join(devDir, "Library/PrivateFrameworks/SimulatorKit.framework");
    if (!fs.existsSync(simKit)) {
      return {
        ok: false,
        reason: "simkit",
        message: "SimulatorKit framework was not found in this Xcode install.",
        hint: "Open Xcode once so it finishes installing components, then try again.",
        detail: simKit,
      };
    }
    return { ok: true, developerDir: devDir };
  });

  tweak.removeMainHandlers = () => {
    stopCapture();
    stopInput();
    for (const c of channels) {
      try {
        ipcMain.removeHandler(c);
      } catch {}
    }
  };
  api.log?.info?.("ios-simulator main handlers registered");
}

// ── styles ──────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [${TWEAK_ATTR}="menu-entry"] svg { color: inherit; }
    [${TWEAK_ATTR}="side-tab"][data-selected="true"] > div {
      background: color-mix(in oklab, var(--color-token-text-primary) 8%, transparent);
    }
    [${TWEAK_ATTR}="side-tab"][data-selected="true"] .pointer-events-none {
      background: color-mix(in oklab, var(--color-token-text-primary) 8%, transparent);
    }
    [${TWEAK_ATTR}="tabpanel"] {
      background: var(--color-background-panel, var(--color-token-bg-fog));
    }
    [${TWEAK_ATTR}="toolbar-button"] {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      height: var(--token-button-composer-height, 28px);
      padding: 0 0.5rem;
      border-radius: 0.5rem;
      border: 1px solid transparent;
      color: var(--color-token-description-foreground, var(--color-token-text-secondary));
      background: transparent;
      cursor: pointer;
      font-size: 0.875rem;
    }
    [${TWEAK_ATTR}="toolbar-button"][data-square="true"] {
      width: var(--token-button-composer-height, 28px);
      padding: 0;
      justify-content: center;
    }
    [${TWEAK_ATTR}="toolbar-button"]:hover {
      background: var(--color-token-list-hover-background, color-mix(in oklab, var(--color-token-text-primary) 8%, transparent));
    }
    [${TWEAK_ATTR}="status"] {
      margin-top: 0.5rem;
      font-size: 0.75rem;
      color: var(--color-token-text-tertiary, var(--color-token-text-secondary));
    }
    @keyframes codexpp-ios-sim-progress {
      from { transform: translateX(-100%); }
      to   { transform: translateX(250%); }
    }
  `;
  document.head.appendChild(style);
}

// ── menu detection ──────────────────────────────────────────────────────

function findBrowserMenuButtons() {
  const found = new Set();
  const menuAnchors = new Map();
  const rememberMenuAnchor = (node, rank) => {
    const root = menuRootForCandidate(node);
    const existing = menuAnchors.get(root);
    if (!existing || rank < existing.rank) {
      menuAnchors.set(root, { node, rank });
    }
  };

  // Native Codex right-panel menu. Prefer "Browser"; if it is already open,
  // Codex hides that entry, so fall back to the always-present file row.
  const radixCandidates = Array.from(
    document.querySelectorAll(
      '[role="menuitem"], [role="menu"] button, [data-radix-popper-content-wrapper] button',
    ),
  );
  for (const node of radixCandidates) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.getAttribute(TWEAK_ATTR)) continue;
    if (!isMenuCandidate(node)) continue;
    const label = extractLabel(node);
    const text = compactText(node.textContent || "");
    if (
      matchesBrowserText(label) ||
      matchesBrowserText(text)
    ) {
      rememberMenuAnchor(node, 0);
    } else if (
      matchesMenuFallbackText(label) ||
      matchesMenuFallbackText(text)
    ) {
      rememberMenuAnchor(node, 1);
    }
  }
  for (const { node } of menuAnchors.values()) {
    found.add(node);
  }

  // codex-spitscreen picker dialog: clone the "New chat" picker row.
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (!(dialog instanceof HTMLElement)) continue;
    const rows = dialog.querySelectorAll(
      "button.flex.w-full, [data-codexpp-spitscreen-picker-row]",
    );
    for (const row of rows) {
      if (!(row instanceof HTMLElement)) continue;
      if (row.getAttribute(TWEAK_ATTR)) continue;
      const title = compactText(
        row.querySelector("[data-codexpp-spitscreen-picker-title]")?.textContent ||
          row.querySelector("span")?.textContent ||
          "",
      );
      const text = compactText(row.textContent || "");
      if (
        PICKER_TITLE_PATTERNS.some((p) => p.test(title)) ||
        /^\+?New chat\b/i.test(text)
      ) {
        found.add(row);
        break; // only inject once per dialog
      }
    }
  }

  return Array.from(found);
}

function menuRootForCandidate(node) {
  return (
    node.closest(
      '[role="menu"], [data-radix-popper-content-wrapper], [data-side][data-align], [role="dialog"]',
    ) ||
    node.parentElement ||
    node
  );
}

function isMenuCandidate(node) {
  if (node.closest('[role="tablist"], [role="tabpanel"]')) return false;
  if (node.getAttribute("role") === "menuitem") return true;
  if (node.closest('[role="dialog"]')) return true;
  return Boolean(
    node.closest(
      '[role="menu"], [data-radix-popper-content-wrapper], [data-side][data-align]',
    ),
  );
}

function rewriteMenuEntry(button) {
  rewriteMenuLabel(button);
  rewriteMenuIcon(button);
}

function rewriteMenuLabel(button) {
  const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    textNodes.push(node);
  }
  // Browser-style entries: replace inline "Browser" → "iOS Simulator".
  for (const node of textNodes) {
    if (matchesBrowserText(compactText(node.nodeValue || ""))) {
      replaceTextNodeLabel(node, MENU_LABEL);
      removeShortcutHints(button);
      return;
    }
  }
  // Picker-dialog entries (e.g. "New chat" / "Open a blank chat in this pane"):
  // first matching title text node becomes the label, the next becomes subtitle.
  let setTitle = false;
  for (const node of textNodes) {
    const t = compactText(node.nodeValue || "");
    if (!t) continue;
    if (!setTitle && matchesPickerTitleText(t.replace(/^\+/, ""))) {
      replaceTextNodeLabel(node, MENU_LABEL);
      setTitle = true;
      continue;
    }
    if (setTitle) {
      // First non-empty text after title is the subtitle.
      node.nodeValue = PICKER_SUBTITLE;
      break;
    }
  }
  removeShortcutHints(button);
}

function replaceTextNodeLabel(node, label) {
  const value = node.nodeValue || "";
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  const prefix = value.trim().startsWith("+") ? "+" : "";
  node.nodeValue = `${leading}${prefix}${label}${trailing}`;
}

function rewriteMenuIcon(button) {
  const ariaIcon = button.querySelector('span[aria-hidden="true"]');
  if (ariaIcon?.querySelector("svg")) {
    ariaIcon.innerHTML = PHONE_SVG;
    return;
  }
  const svg = button.querySelector("svg");
  if (svg) {
    svg.replaceWith(htmlToElement(PHONE_SVG));
    return;
  }
  button.prepend(htmlToElement(PHONE_ICON));
}

function removeShortcutHints(button) {
  for (const node of Array.from(button.querySelectorAll("kbd, span"))) {
    const text = compactText(node.textContent || "");
    if (
      text !== MENU_LABEL &&
      (/^[⌘⇧⌥⌃^]+/.test(text) || /Cmd|Ctrl|Alt|Shift|⌘/.test(text))
    ) {
      node.remove();
    }
  }
}

function closeTransientMenu(origin) {
  const menuRoot =
    origin.closest('[role="menu"]') ||
    origin.closest("[data-radix-popper-content-wrapper]") ||
    origin.closest("[data-state]");
  if (menuRoot instanceof HTMLElement) {
    menuRoot.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  }
}

// ── side panel ──────────────────────────────────────────────────────────

function openSimPanel(api) {
  ensureSidePanelVisible();
  // NOTE: requestAnimationFrame is paused when the window is unfocused, which
  // prevented mounting when the user tabbed away. setTimeout fires regardless.
  const startedAt = Date.now();
  const tryMount = () => {
    let mounted = false;
    try {
      mounted = mountSimPanel(api);
    } catch (err) {
      api?.log?.error?.("ios-sim mountSimPanel threw", String(err?.stack || err));
    }
    if (mounted) return;
    if (Date.now() - startedAt < 1_500) {
      setTimeout(tryMount, 50);
      return;
    }
    api?.log?.warn?.("ios-sim could not find side panel host");
  };
  setTimeout(tryMount, 16);
}

function mountSimPanel(api) {
  const tablist = findRightTablist();
  if (!(tablist instanceof HTMLElement)) return false;
  const panelHost = tablist.closest(".flex.h-full.min-h-0.flex-col");
  if (!(panelHost instanceof HTMLElement)) return false;
  installNativeTabDeactivation(tablist, panelHost);
  installTablistDrag(tablist);

  let tab = document.querySelector(`[${TWEAK_ATTR}="side-tab"]`);
  let panel = document.querySelector(`[${TWEAK_ATTR}="tabpanel"]`);

  if (!tab) {
    tab = createSideTab();
    tablist.appendChild(tab);
  }
  if (!panel) {
    panel = createPanel(api);
    panelHost.appendChild(panel);
  }

  activateSimPanel(panelHost, tab, panel);
  return true;
}

function createSideTab() {
  const controller = document.createElement("div");
  controller.setAttribute(TWEAK_ATTR, "side-tab");
  controller.setAttribute("data-app-shell-tab-controller", "right");
  controller.setAttribute("data-tab-id", "ios-simulator");
  controller.className =
    "my-auto flex shrink-0 relative max-w-40 pe-1 items-center contain-content gap-0.5";

  const shell = document.createElement("div");
  shell.setAttribute("data-tab-id", "ios-simulator");
  shell.setAttribute("aria-roledescription", "sortable");
  shell.className =
    "group/tab relative flex max-w-39 shrink-0 items-center overflow-hidden rounded-md bg-token-main-surface-primary px-2 py-1";
  shell.setAttribute("role", "button");
  shell.tabIndex = 0;
  shell.style.setProperty(
    "--app-shell-tab-background",
    "color-mix(in srgb, var(--color-token-foreground) 5%, var(--color-token-main-surface-primary))",
  );

  const bg = document.createElement("div");
  bg.className =
    "pointer-events-none absolute inset-0 z-0 rounded-md group-hover/tab:bg-[var(--app-shell-tab-background)]";

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "tab");
  button.className =
    "no-drag relative flex flex-1 items-center gap-2 z-10 text-sm min-w-0 overflow-hidden text-token-text-secondary";

  const iconSpan = document.createElement("span");
  iconSpan.setAttribute("aria-hidden", "true");
  // Hide the phone icon on tab hover so the close-X takes its place cleanly.
  iconSpan.className =
    "icon-xs flex shrink-0 items-center justify-center group-hover/tab:invisible";
  iconSpan.innerHTML = PHONE_SVG;

  // Close button — overlays the icon's slot on hover. The SVG itself is a
  // donut with an X cut out via fill-rule=evenodd, so it needs no background.
  const close = document.createElement("div");
  close.setAttribute("role", "button");
  close.setAttribute("aria-label", `Close ${MENU_LABEL} tab`);
  close.setAttribute(TWEAK_ATTR, "close-tab");
  close.className =
    "no-drag shrink-0 cursor-interaction items-center justify-center group-hover/tab:flex after:content-[''] after:absolute after:-inset-2 hidden absolute start-1 z-30 size-5 top-1/2 -translate-y-1/2 text-token-text-tertiary hover:text-token-text-primary";
  close.innerHTML = SVGS.close;
  close.addEventListener("mousedown", (e) => {
    // Stop the parent button (and any drag start) from reacting.
    e.preventDefault();
    e.stopPropagation();
  });
  close.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeSimTab();
  });

  const labelSpan = document.createElement("span");
  labelSpan.className = "inline-block min-w-0 whitespace-nowrap";
  labelSpan.textContent = MENU_LABEL;

  button.append(iconSpan, close, labelSpan);
  button.addEventListener("click", () => {
    const panelHost = controller.closest(".flex.h-full.min-h-0.flex-col");
    const panel = document.querySelector(`[${TWEAK_ATTR}="tabpanel"]`);
    if (panelHost instanceof HTMLElement && panel instanceof HTMLElement) {
      activateSimPanel(panelHost, controller, panel);
    }
  });

  shell.append(bg, button);
  controller.appendChild(shell);

  // Trailing separator (visual parity with native tabs).
  const sep = document.createElement("div");
  sep.setAttribute("aria-hidden", "true");
  sep.setAttribute("data-app-shell-tab-separator", "ios-simulator");
  sep.className =
    "h-3 w-px shrink-0 end-0 absolute bg-token-border transition-opacity duration-200 opacity-0";
  controller.appendChild(sep);

  // HTML5 drag-and-drop reordering inside the tablist (wired after append).
  controller.draggable = true;
  controller.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    if ((e.target instanceof Element) && e.target.closest(`[${TWEAK_ATTR}="close-tab"]`)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/x-codexpp-ios-sim", "1"); } catch {}
    controller.dataset.codexppDragging = "1";
    controller.style.opacity = "0.4";
  });
  controller.addEventListener("dragend", () => {
    delete controller.dataset.codexppDragging;
    controller.style.opacity = "";
  });

  return controller;
}

function closeSimTab() {
  const panelHost = findRightTablist()?.closest(".flex.h-full.min-h-0.flex-col");
  document.querySelector(`[${TWEAK_ATTR}="tabpanel"]`)?.__codexppIosSimDisposeKeyboard?.();
  if (panelHost instanceof HTMLElement) deactivateSimPanel(panelHost);
  document.querySelector(`[${TWEAK_ATTR}="side-tab"]`)?.remove();
  document.querySelector(`[${TWEAK_ATTR}="tabpanel"]`)?.remove();
  // Activate the first remaining native tab so the panel area isn't blank.
  const firstNative = panelHost?.querySelector?.(
    '[role="tablist"] [data-app-shell-tab-controller] [role="tab"]',
  );
  if (firstNative instanceof HTMLElement) {
    firstNative.click();
  }
}

function installTabDrag(controller) {
  // Now-no-op (drag handlers attached at controller-creation time);
  // tablist-level handlers wired separately in installTablistDrag.
}

function installTablistDrag(tablist) {
  if (!(tablist instanceof HTMLElement) || tablist.__codexppIosSimDragWired) return;
  tablist.__codexppIosSimDragWired = true;
  tablist.addEventListener("dragover", (e) => {
    const dragging = tablist.querySelector(
      `[${TWEAK_ATTR}="side-tab"][data-codexpp-dragging="1"]`,
    );
    if (!dragging) return;
    e.preventDefault();
    const target = (e.target instanceof Element) ? e.target.closest(
      '[data-app-shell-tab-controller], [' + TWEAK_ATTR + '="side-tab"]'
    ) : null;
    if (!(target instanceof HTMLElement) || target === dragging) return;
    const rect = target.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    if (before) target.parentElement.insertBefore(dragging, target);
    else target.parentElement.insertBefore(dragging, target.nextSibling);
  });
  tablist.addEventListener("drop", (e) => e.preventDefault());
}

function installNativeTabDeactivation(tablist, panelHost) {
  if (tablist.__codexppIosSimWired) return;
  tablist.__codexppIosSimWired = true;

  const handleNativeTab = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target?.closest?.('[role="tab"]');
    if (!(tab instanceof HTMLElement)) return;
    if (tab.closest(`[${TWEAK_ATTR}="side-tab"]`)) return;
    deactivateSimPanel(panelHost);
  };

  tablist.addEventListener("click", handleNativeTab);
  tablist.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    handleNativeTab(event);
  });
}

function createPanel(api) {
  const panel = document.createElement("div");
  panel.setAttribute(TWEAK_ATTR, "tabpanel");
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-label", PANEL_LABEL);
  panel.className = "relative flex min-h-0 flex-1 flex-col overflow-hidden";
  panel.__codexppIosSimApi = api;

  // Toolbar
  const toolbarHost = document.createElement("div");
  toolbarHost.className =
    "relative z-10 h-toolbar-pane min-w-0 shrink-0 border-b border-token-border";
  const toolbar = document.createElement("div");
  toolbar.className =
    "flex h-full min-w-0 items-center gap-1 px-2 text-token-description-foreground";
  toolbarHost.appendChild(toolbar);
  panel.appendChild(toolbarHost);

  toolbar.appendChild(
    makeToolbarButton({
      label: "返回桌面",
      icon: SVGS.home,
      text: "桌面",
      onClick: () => onHardwareButton(panel, api, "home"),
    }),
  );
  toolbar.appendChild(
    makeToolbarButton({
      label: "Screenshot",
      icon: SVGS.camera,
      onClick: () => onScreenshot(panel, api),
    }),
  );

  const spacer = document.createElement("div");
  spacer.className = "flex-1";
  toolbar.appendChild(spacer);

  const devicePickerButton = makeDevicePickerButton(panel, api);
  toolbar.appendChild(devicePickerButton);
  panel.__codexppIosSimDevicePickerButton = devicePickerButton;

  // Content area
  const content = document.createElement("div");
  content.className =
    "relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden";
  content.style.background = "var(--color-token-bg-fog, #000)";

  const stage = document.createElement("div");
  stage.className = "relative flex h-full w-full items-center justify-center";
  stage.style.padding = "24px 12px";

  const mirror = document.createElement("img");
  mirror.alt = "iOS Simulator";
  mirror.draggable = false;
  mirror.tabIndex = 0;
  mirror.style.maxWidth = "100%";
  mirror.style.maxHeight = "100%";
  mirror.style.objectFit = "contain";
  mirror.style.display = "none";
  mirror.style.userSelect = "none";
  mirror.style.touchAction = "none";
  mirror.style.outline = "none";
  mirror.style.borderRadius = "18px";
  mirror.style.boxShadow = "0 10px 40px rgba(0,0,0,0.35)";
  stage.appendChild(mirror);

  // ── pointer forwarding (Phase 3) ────────────────────────────────────
  let pointerDown = false;
  let activePointerId = null;
  function imgRatio(evt) {
    const rect = mirror.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    let x = (evt.clientX - rect.left) / rect.width;
    let y = (evt.clientY - rect.top) / rect.height;
    if (x < 0) x = 0; else if (x > 1) x = 1;
    if (y < 0) y = 0; else if (y > 1) y = 1;
    return { x, y };
  }
  function send(event) {
    const meta = panel.__codexppIosSimMeta;
    const payload = meta?.deviceUDID && !event.deviceUDID
      ? { ...event, deviceUDID: meta.deviceUDID }
      : event;
    try { api.ipc.invoke("ios-sim:input:event", payload).catch(() => {}); } catch {}
  }
  mirror.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = imgRatio(e); if (!r) return;
    panel.__codexppIosSimActivateKeyboard?.();
    pointerDown = true;
    activePointerId = e.pointerId;
    try { mirror.setPointerCapture(e.pointerId); } catch {}
    send({ type: "touch", phase: "down", x: r.x, y: r.y });
    e.preventDefault();
  });
  mirror.addEventListener("pointermove", (e) => {
    if (!pointerDown || e.pointerId !== activePointerId) return;
    const r = imgRatio(e); if (!r) return;
    send({ type: "touch", phase: "move", x: r.x, y: r.y });
  });
  function endPointer(e) {
    if (!pointerDown || e.pointerId !== activePointerId) return;
    const r = imgRatio(e) || { x: 0.5, y: 0.5 };
    pointerDown = false;
    activePointerId = null;
    try { mirror.releasePointerCapture(e.pointerId); } catch {}
    send({ type: "touch", phase: "up", x: r.x, y: r.y });
  }
  mirror.addEventListener("pointerup", endPointer);
  mirror.addEventListener("pointercancel", endPointer);
  mirror.addEventListener("contextmenu", (e) => e.preventDefault());
  installKeyboardForwarding(panel, mirror, stage, send);

  const placeholder = document.createElement("div");
  placeholder.className =
    "absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-token-text-secondary pointer-events-none";
  placeholder.innerHTML =
    `<div style="opacity:0.5">${SVGS.phoneLarge}</div>` +
    `<div class="text-base text-token-text-primary">${PANEL_LABEL}</div>` +
    `<div class="text-sm max-w-[320px]" ${TWEAK_ATTR}="placeholder-message">Booting the simulator headlessly. Mirroring will begin as soon as the device starts up.</div>` +
    `<div ${TWEAK_ATTR}="progress" class="text-token-text-tertiary" style="width:200px;height:2px;border-radius:2px;background:color-mix(in oklab,currentColor 15%,transparent);overflow:hidden;margin-top:4px;position:relative"><div style="position:absolute;inset:0;width:40%;border-radius:2px;background:currentColor;opacity:0.7;animation:codexpp-ios-sim-progress 1.6s linear infinite;will-change:transform"></div></div>`;
  stage.appendChild(placeholder);

  content.appendChild(stage);
  panel.__codexppIosSimPlaceholder = placeholder;
  panel.__codexppIosSimMirror = mirror;
  panel.__codexppIosSimStage = stage;
  panel.appendChild(content);

  // Wire capture lifecycle ----------------------------------------------
  let lastUrl = null;
  const onFrame = (payload) => {
    if (!payload) return;
    const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const url = URL.createObjectURL(new Blob([u8], { type: "image/jpeg" }));
    const prev = lastUrl;
    lastUrl = url;
    mirror.onload = () => {
      if (prev) URL.revokeObjectURL(prev);
    };
    mirror.src = url;
    if (mirror.style.display === "none") {
      mirror.style.display = "";
      placeholder.style.display = "none";
    }
  };
  const onMeta = (meta) => {
    panel.__codexppIosSimMeta = meta;
    api.log?.info?.("ios-sim stream meta", meta);
  };
  const onStatus = (status) => {
    if (!status) return;
    if (status.kind === "compiling") setStatus(panel, "Compiling capture helper…");
    else if (status.kind === "starting") setStatus(panel, "Starting capture…");
    else if (status.kind === "stopped") {
      mirror.style.display = "none";
      placeholder.style.display = "";
      if (status.reason && status.reason !== "client-stop") {
        setStatus(panel, "Capture stopped: " + status.reason);
      }
    } else if (status.kind === "error") {
      mirror.style.display = "none";
      placeholder.style.display = "";
      setStatus(panel, "Capture error: " + (status.error || "unknown"));
    }
  };

  panel.__codexppIosSimAttachCapture = () => {
    if (panel.__codexppIosSimCaptureAttached) return;
    panel.__codexppIosSimCaptureAttached = true;
    panel.__codexppIosSimCaptureOff = [
      api.ipc.on("ios-sim:capture:frame", onFrame),
      api.ipc.on("ios-sim:capture:meta", onMeta),
      api.ipc.on("ios-sim:capture:status", onStatus),
    ];
    api.ipc.invoke("ios-sim:capture:start").catch((e) =>
      setStatus(panel, "Capture start failed: " + e),
    );
  };
  // Also stash on globalThis as fallback in case DOM expandos get stripped
  globalThis.__codexppIosSimPanelHooks = globalThis.__codexppIosSimPanelHooks || new WeakMap();
  globalThis.__codexppIosSimPanelHooks.set(panel, {
    attach: panel.__codexppIosSimAttachCapture,
    api,
  });
  globalThis.__codexppIosSimLastCreate = Date.now();
  panel.__codexppIosSimDetachCapture = () => {
    if (!panel.__codexppIosSimCaptureAttached) return;
    panel.__codexppIosSimCaptureAttached = false;
    for (const off of panel.__codexppIosSimCaptureOff || []) {
      try {
        if (typeof off === "function") off();
      } catch {}
    }
    panel.__codexppIosSimCaptureOff = null;
    api.ipc.invoke("ios-sim:capture:stop").catch(() => {});
    if (lastUrl) {
      URL.revokeObjectURL(lastUrl);
      lastUrl = null;
    }
    mirror.removeAttribute("src");
    mirror.style.display = "none";
    placeholder.style.display = "";
  };

  return panel;
}

function makeToolbarButton({ label, icon, text, onClick }) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute(TWEAK_ATTR, "toolbar-button");
  b.setAttribute("aria-label", label);
  b.setAttribute("title", label);
  if (!text) b.setAttribute("data-square", "true");
  if (icon) {
    const i = document.createElement("span");
    i.className = "flex shrink-0 items-center justify-center";
    i.innerHTML = icon;
    b.appendChild(i);
  }
  if (text) {
    const t = document.createElement("span");
    t.textContent = text;
    b.appendChild(t);
  }
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      onClick?.();
    } catch {}
  });
  return b;
}

function installKeyboardForwarding(panel, mirror, stage, send) {
  const sink = document.createElement("textarea");
  sink.setAttribute(TWEAK_ATTR, "keyboard-sink");
  sink.setAttribute("aria-hidden", "true");
  sink.autocapitalize = "off";
  sink.autocomplete = "off";
  sink.spellcheck = false;
  sink.tabIndex = -1;
  sink.style.position = "absolute";
  sink.style.width = "1px";
  sink.style.height = "1px";
  sink.style.opacity = "0";
  sink.style.pointerEvents = "none";
  sink.style.left = "50%";
  sink.style.top = "50%";
  sink.style.resize = "none";
  sink.style.border = "0";
  sink.style.padding = "0";
  sink.style.outline = "0";
  stage.appendChild(sink);

  let keyboardActive = false;
  let composing = false;
  let queuedText = "";
  let textTimer = null;

  const isVisible = () => panel.isConnected && panel.style.display !== "none";
  const focusSink = () => {
    try { sink.focus({ preventScroll: true }); } catch { try { sink.focus(); } catch {} }
  };
  const stopEvent = (event, preventDefault = true) => {
    if (preventDefault) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  };
  const flushText = () => {
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = null;
    }
    const text = queuedText;
    queuedText = "";
    if (text) send({ type: "text", text });
  };
  const queueText = (text) => {
    if (!text) return;
    queuedText += text;
    if (textTimer) clearTimeout(textTimer);
    textTimer = setTimeout(flushText, 30);
  };
  const sendKeyTap = (usage, modifiers = []) => {
    flushText();
    send({ type: "key-tap", usage, modifiers });
  };
  const activate = () => {
    if (!isVisible()) return;
    keyboardActive = true;
    focusSink();
  };
  const deactivate = () => {
    flushText();
    keyboardActive = false;
    composing = false;
    sink.value = "";
    if (document.activeElement === sink) {
      try { sink.blur(); } catch {}
    }
  };
  const active = () => keyboardActive && isVisible();

  panel.__codexppIosSimActivateKeyboard = activate;
  panel.__codexppIosSimDeactivateKeyboard = deactivate;

  const onBeforeInput = (event) => {
    if (!active()) return;
    if (event.inputType === "insertCompositionText") return;
    if (event.inputType === "insertText" || event.inputType === "insertReplacementText") {
      stopEvent(event);
      queueText(event.data || sink.value);
      sink.value = "";
      return;
    }
    if (event.inputType === "insertLineBreak") {
      stopEvent(event);
      sendKeyTap(HID_USAGE.Enter);
      return;
    }
    if (event.inputType === "deleteContentBackward") {
      stopEvent(event);
      sendKeyTap(HID_USAGE.Backspace);
      return;
    }
    if (event.inputType === "deleteContentForward") {
      stopEvent(event);
      sendKeyTap(HID_USAGE.Delete);
    }
  };

  const onInput = () => {
    if (!active() || composing) return;
    const text = sink.value;
    sink.value = "";
    queueText(text);
  };

  const onCompositionStart = () => {
    if (active()) composing = true;
  };

  const onCompositionEnd = (event) => {
    if (!active()) return;
    composing = false;
    const text = event.data || sink.value;
    sink.value = "";
    queueText(text);
  };

  const onPaste = (event) => {
    if (!active()) return;
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!text) return;
    stopEvent(event);
    queueText(text);
  };

  const onDocumentMouseDown = (event) => {
    if (!keyboardActive) return;
    const target = event.target instanceof Node ? event.target : null;
    if (target && panel.contains(target)) return;
    deactivate();
  };

  const onDocumentKeyDown = (event) => {
    if (!active()) return;
    if (document.activeElement !== sink) focusSink();

    if (event.isComposing || composing) {
      stopEvent(event, false);
      return;
    }

    const usage = hidUsageForKeyboardEvent(event);
    const printable = event.key && event.key.length === 1 && !event.metaKey && !event.ctrlKey;
    if (printable) {
      if (event.target === sink) {
        stopEvent(event, false);
      } else {
        stopEvent(event);
        queueText(event.key);
      }
      return;
    }

    if (!usage) return;
    stopEvent(event);
    sendKeyTap(usage, hidModifierUsagesForEvent(event));
  };

  sink.addEventListener("beforeinput", onBeforeInput);
  sink.addEventListener("input", onInput);
  sink.addEventListener("compositionstart", onCompositionStart);
  sink.addEventListener("compositionend", onCompositionEnd);
  sink.addEventListener("paste", onPaste);
  document.addEventListener("mousedown", onDocumentMouseDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);

  panel.__codexppIosSimDisposeKeyboard = () => {
    deactivate();
    sink.removeEventListener("beforeinput", onBeforeInput);
    sink.removeEventListener("input", onInput);
    sink.removeEventListener("compositionstart", onCompositionStart);
    sink.removeEventListener("compositionend", onCompositionEnd);
    sink.removeEventListener("paste", onPaste);
    document.removeEventListener("mousedown", onDocumentMouseDown, true);
    document.removeEventListener("keydown", onDocumentKeyDown, true);
    sink.remove();
  };
}

function hidUsageForKeyboardEvent(event) {
  if (!event) return null;
  if (Object.prototype.hasOwnProperty.call(HID_USAGE, event.key)) {
    return HID_USAGE[event.key];
  }
  const code = event.code || "";
  const keyMatch = code.match(/^Key([A-Z])$/);
  if (keyMatch) return 0x04 + keyMatch[1].charCodeAt(0) - 65;
  const digitMatch = code.match(/^Digit([0-9])$/);
  if (digitMatch) {
    const digit = Number(digitMatch[1]);
    return digit === 0 ? 0x27 : 0x1d + digit;
  }
  const codeMap = {
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    Home: 0x4a,
    PageUp: 0x4b,
    End: 0x4d,
    PageDown: 0x4e,
  };
  if (Object.prototype.hasOwnProperty.call(codeMap, code)) return codeMap[code];
  if (Object.prototype.hasOwnProperty.call(HID_MODIFIER_USAGE, event.key)) {
    return HID_MODIFIER_USAGE[event.key];
  }
  return null;
}

function hidModifierUsagesForEvent(event) {
  const usage = hidUsageForKeyboardEvent(event);
  const modifiers = [];
  if (event.ctrlKey && usage !== HID_MODIFIER_USAGE.Control) modifiers.push(HID_MODIFIER_USAGE.Control);
  if (event.shiftKey && usage !== HID_MODIFIER_USAGE.Shift) modifiers.push(HID_MODIFIER_USAGE.Shift);
  if (event.altKey && usage !== HID_MODIFIER_USAGE.Alt) modifiers.push(HID_MODIFIER_USAGE.Alt);
  if (event.metaKey && usage !== HID_MODIFIER_USAGE.Meta) modifiers.push(HID_MODIFIER_USAGE.Meta);
  return modifiers;
}

function activateSimPanel(panelHost, tab, panel) {
  for (const nativePanel of panelHost.querySelectorAll(
    ':scope > [role="tabpanel"]',
  )) {
    if (nativePanel === panel) continue;
    if (!nativePanel.hasAttribute("data-codexpp-ios-sim-prev-display")) {
      nativePanel.setAttribute(
        "data-codexpp-ios-sim-prev-display",
        nativePanel.style.display || "",
      );
    }
    nativePanel.style.display = "none";
  }

  for (const nativeTab of panelHost.querySelectorAll('[role="tab"]')) {
    nativeTab.setAttribute("aria-selected", "false");
    nativeTab.classList.remove("text-token-text-primary");
    nativeTab.classList.add("text-token-text-secondary");
  }

  const tabButton = tab.querySelector('[role="tab"]');
  tab.dataset.selected = "true";
  tabButton?.setAttribute("aria-selected", "true");
  tabButton?.classList.remove("text-token-text-secondary");
  tabButton?.classList.add("text-token-text-primary");
  panel.style.display = "";
  // Auto-boot a default device if nothing is booted, then refresh label.
  // We gate everything behind a preflight check so users on Macs without a
  // working Xcode toolchain see a single explanatory message instead of the
  // generic "Booting…" placeholder followed by a cryptic spawn error.
  const api = panel.__codexppIosSimApi;
  if (!api) return;

  const showPreflightFailure = (pf) => {
    const placeholder = panel.__codexppIosSimPlaceholder;
    const msg = placeholder?.querySelector(`[${TWEAK_ATTR}="placeholder-message"]`);
    const progress = placeholder?.querySelector(`[${TWEAK_ATTR}="progress"]`);
    if (msg) {
      const hint = pf?.hint ? `\n\n${pf.hint}` : "";
      msg.textContent = (pf?.message || "iOS Simulator unavailable.") + hint;
      msg.style.whiteSpace = "pre-line";
    }
    progress?.remove();
    api.log?.warn?.("ios-sim preflight failed", pf);
  };

  api.ipc
    .invoke("ios-sim:preflight")
    .then((pf) => {
      if (!pf?.ok) {
        showPreflightFailure(pf);
        return;
      }
      try {
        panel.__codexppIosSimAttachCapture?.();
      } catch (e) {
        console.warn("ios-sim attach capture", e);
      }
      return ensureBootedDevice(panel, api).then(() => refreshDeviceLabel(panel, api));
    })
    .catch((e) => {
      showPreflightFailure({
        message: "iOS Simulator preflight failed.",
        hint: String(e?.message || e || ""),
      });
    });
}

function deactivateSimPanel(panelHost) {
  const tabWrap = document.querySelector(`[${TWEAK_ATTR}="side-tab"]`);
  const tab = tabWrap?.querySelector('[role="tab"]');
  const panel = document.querySelector(`[${TWEAK_ATTR}="tabpanel"]`);
  tabWrap?.removeAttribute("data-selected");
  tab?.setAttribute("aria-selected", "false");
  tab?.classList.remove("text-token-text-primary");
  tab?.classList.add("text-token-text-secondary");
  if (panel instanceof HTMLElement) {
    try {
      panel.__codexppIosSimDeactivateKeyboard?.();
    } catch {}
    panel.style.display = "none";
    try {
      panel.__codexppIosSimDetachCapture?.();
    } catch {}
  }

  for (const nativePanel of panelHost.querySelectorAll(
    ':scope > [role="tabpanel"]',
  )) {
    if (nativePanel === panel) continue;
    const previous = nativePanel.getAttribute(
      "data-codexpp-ios-sim-prev-display",
    );
    if (previous !== null) {
      nativePanel.style.display = previous;
      nativePanel.removeAttribute("data-codexpp-ios-sim-prev-display");
    }
  }
}

function removeSimPanel() {
  const panelHost = findRightTablist()?.closest(".flex.h-full.min-h-0.flex-col");
  document.querySelector(`[${TWEAK_ATTR}="tabpanel"]`)?.__codexppIosSimDisposeKeyboard?.();
  if (panelHost instanceof HTMLElement) deactivateSimPanel(panelHost);
  document.querySelector(`[${TWEAK_ATTR}="side-tab"]`)?.remove();
  document.querySelector(`[${TWEAK_ATTR}="tabpanel"]`)?.remove();
}

function ensureSidePanelVisible() {
  if (findRightTablist()) return;
  const toggle = findButtonByAriaLabel(
    /^(Toggle side panel|显示\/隐藏侧边栏|切换側邊面板)$/,
    '[aria-pressed="false"]',
  );
  if (toggle instanceof HTMLElement) toggle.click();
}

function findRightTablist() {
  const addButton = findButtonByAriaLabel(
    /^(Open side panel tab|打开侧边面板标签页|開啟側邊面板分頁)$/,
  );
  const toolbar = addButton?.closest(".flex.h-toolbar-pane");
  const localizedTablist = toolbar?.querySelector('[role="tablist"]');
  if (localizedTablist instanceof HTMLElement) return localizedTablist;

  for (const tablist of document.querySelectorAll('[role="tablist"]')) {
    if (!(tablist instanceof HTMLElement)) continue;
    const host = tablist.closest(".flex.h-full.min-h-0.flex-col");
    if (!(host instanceof HTMLElement)) continue;
    if (host.querySelector(':scope > [role="tabpanel"]')) return tablist;
    if (tablist.closest(".flex.h-toolbar-pane")) return tablist;
  }

  return null;
}

function findButtonByAriaLabel(pattern, extraSelector = "") {
  const selector = `button[aria-label]${extraSelector}`;
  for (const button of document.querySelectorAll(selector)) {
    if (!(button instanceof HTMLElement)) continue;
    const label = button.getAttribute("aria-label") || "";
    if (pattern.test(label)) return button;
  }
  return null;
}

// ── toolbar handlers ────────────────────────────────────────────────────

async function onHardwareButton(panel, api, button) {
  const map = { home: "home", lock: "lock", side: "side", siri: "siri" };
  const name = map[button] || "home";
  const res = await api.ipc.invoke("ios-sim:input:event", {
    type: "button-tap",
    name,
  });
  if (!res?.ok) setStatus(panel, `${button} failed: ${res?.error || "?"}`);
  else api.log?.info?.("ios-sim button", name);
}

async function onRotate() { /* removed in this build */ }

async function onScreenshot(panel, api) {
  setStatus(panel, "Saving screenshot to ~/Desktop…");
  const fname = `simulator-${Date.now()}.png`;
  const res = await api.ipc.invoke("ios-sim:screenshot", fname);
  if (res?.ok) setStatus(panel, "Saved to Desktop: " + fname);
  else
    setStatus(
      panel,
      "Screenshot failed: " + (res?.stderr || res?.error || "unknown"),
    );
}

async function onPickDevice(panel, api) {
  await openDevicePicker(panel, api);
}

// Build a popover dropdown listing every device, grouped by runtime.
async function openDevicePicker(panel, api) {
  api.log?.info?.("ios-sim openDevicePicker entry");
  // Toggle off if already open.
  const existing = document.querySelector(`[${TWEAK_ATTR}="device-popover"]`);
  if (existing) {
    api.log?.info?.("ios-sim openDevicePicker toggle-off");
    existing.remove();
    return;
  }
  const button = panel.__codexppIosSimDevicePickerButton;
  if (!button) {
    api.log?.warn?.("ios-sim openDevicePicker no button reference");
    return;
  }

  const res = await api.ipc.invoke("ios-sim:devices");
  api.log?.info?.("ios-sim openDevicePicker devices result", {
    ok: res?.ok,
    runtimeCount: Object.keys(res?.data?.devices || {}).length,
  });
  if (!res?.ok) {
    setStatus(panel, "simctl unavailable: " + (res?.error || res?.stderr || ""));
    return;
  }
  const runtimes = Object.keys(res.data?.devices || {})
    .filter((rt) => /iOS-/.test(rt))
    .sort()
    .reverse();

  const pop = document.createElement("div");
  pop.setAttribute(TWEAK_ATTR, "device-popover");
  pop.setAttribute("role", "menu");
  pop.tabIndex = -1;
  // Use fixed positioning since getBoundingClientRect returns viewport coords
  // and there's no guarantee body has a positioned ancestor.
  pop.className =
    "fixed z-[9999] max-h-[420px] min-w-[260px] overflow-y-auto rounded-lg border border-token-border bg-token-main-surface-primary py-1 shadow-xl text-sm";
  const br = button.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = br.bottom + 4 + "px";
  pop.style.right = (window.innerWidth - br.right) + "px";
  pop.style.zIndex = "9999";

  let anyShown = false;
  for (const rt of runtimes) {
    const list = (res.data.devices[rt] || []).filter((d) => d.isAvailable);
    if (!list.length) continue;
    anyShown = true;
    const header = document.createElement("div");
    header.className =
      "px-3 py-1 text-xs font-medium text-token-text-tertiary uppercase tracking-wide";
    header.textContent = rt.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "").replace(/-/g, " ");
    pop.appendChild(header);
    for (const d of list) {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.setAttribute(TWEAK_ATTR, "device-item");
      item.className =
        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-token-list-hover-background";
      const left = document.createElement("span");
      left.className = "truncate";
      left.textContent = d.name;
      const right = document.createElement("span");
      right.className = "shrink-0 text-xs text-token-text-tertiary";
      right.textContent = d.state === "Booted" ? "● Booted" : "";
      if (d.state === "Booted") right.style.color = "var(--color-token-success, #34c759)";
      item.append(left, right);
      item.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        api.log?.info?.("ios-sim picker item click", {
          udid: d.udid, name: d.name, state: d.state,
        });
        pop.remove();
        try {
          await selectDevice(panel, api, d);
        } catch (err) {
          api.log?.error?.("ios-sim selectDevice threw", String(err));
        }
      });
      pop.appendChild(item);
    }
  }

  if (!anyShown) {
    const empty = document.createElement("div");
    empty.className = "px-3 py-2 text-token-text-tertiary";
    empty.textContent = "No iOS simulators available.";
    pop.appendChild(empty);
  }

  document.body.appendChild(pop);
  api.log?.info?.("ios-sim openDevicePicker popover appended", {
    rect: pop.getBoundingClientRect().toJSON?.() || {
      x: pop.getBoundingClientRect().x,
      y: pop.getBoundingClientRect().y,
      w: pop.getBoundingClientRect().width,
      h: pop.getBoundingClientRect().height,
    },
    childCount: pop.children.length,
  });
  // Dismiss on outside click.
  const dismiss = (ev) => {
    if (pop.contains(ev.target) || button.contains(ev.target)) return;
    pop.remove();
    document.removeEventListener("mousedown", dismiss, true);
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
}

async function selectDevice(panel, api, device) {
  api.log?.info?.("ios-sim selectDevice entry", {
    udid: device.udid, name: device.name, state: device.state,
  });
  // Re-check live state right now — the popover snapshot may be stale.
  const bootedNow = await currentBootedUDIDs(api);
  const isAlreadyBooted = bootedNow.includes(device.udid);
  api.log?.info?.("ios-sim selectDevice booted state", {
    bootedNow, isAlreadyBooted,
  });
  if (!isAlreadyBooted) {
    setStatus(panel, `Booting ${device.name}…`);
    // Shut down any other booted device first so capture targets the new one.
    for (const udid of bootedNow) {
      if (udid !== device.udid) {
        api.log?.info?.("ios-sim selectDevice shutdown", udid);
        const sr = await api.ipc.invoke("ios-sim:simctl", ["shutdown", udid]);
        api.log?.info?.("ios-sim selectDevice shutdown result", {
          udid, ok: sr?.ok, code: sr?.code,
          stderr: (sr?.stderr || "").slice(0, 400),
          stdout: (sr?.stdout || "").slice(0, 200),
        });
      }
    }
    api.log?.info?.("ios-sim selectDevice boot invoke", device.udid);
    const r = await api.ipc.invoke("ios-sim:simctl", ["boot", device.udid]);
    const stderr = (r?.stderr || "").trim();
    const benign = /code=405|current state: Booted/.test(stderr);
    api.log?.info?.("ios-sim selectDevice boot result", {
      ok: r?.ok, code: r?.code, benign,
      stderr: stderr.slice(0, 400),
      stdout: (r?.stdout || "").slice(0, 200),
    });
    if (!r?.ok && !benign) {
      setStatus(panel, `Boot failed: ${stderr || "unknown"}`);
      return;
    }
  }
  // Restart capture so it latches the (possibly new) booted device.
  api.log?.info?.("ios-sim selectDevice capture stop");
  const cs = await api.ipc.invoke("ios-sim:capture:stop");
  api.log?.info?.("ios-sim selectDevice capture stop result", { ok: cs?.ok });
  await new Promise((r) => setTimeout(r, 250));
  api.log?.info?.("ios-sim selectDevice capture start");
  const cst = await api.ipc.invoke("ios-sim:capture:start");
  api.log?.info?.("ios-sim selectDevice capture start result", { ok: cst?.ok });
  setStatus(panel, `Active: ${device.name}`);
  // Reflect the picked device in the picker label immediately.
  const button = panel.__codexppIosSimDevicePickerButton;
  const label = button?.querySelector(`[${TWEAK_ATTR}="device-picker-label"]`);
  if (label) label.textContent = device.name;
  api.log?.info?.("ios-sim selectDevice done", device.name);
}

async function currentBootedUDIDs(api) {
  const res = await api.ipc.invoke("ios-sim:devices");
  if (!res?.ok) return [];
  const out = [];
  for (const list of Object.values(res.data?.devices || {})) {
    for (const d of list || []) if (d.state === "Booted") out.push(d.udid);
  }
  return out;
}

// Boot a sensible default if nothing is booted. Called on panel open.
async function ensureBootedDevice(panel, api) {
  api.log?.info?.("ios-sim ensureBootedDevice entry");
  const res = await api.ipc.invoke("ios-sim:devices");
  if (!res?.ok) {
    api.log?.warn?.("ios-sim ensureBootedDevice devices failed", {
      error: res?.error, stderr: (res?.stderr || "").slice(0, 200),
    });
    return;
  }
  const allRuntimes = Object.keys(res.data?.devices || {}).filter((rt) =>
    /iOS-/.test(rt),
  );
  for (const rt of allRuntimes) {
    for (const d of res.data.devices[rt] || []) {
      if (d.state === "Booted" && d.isAvailable) {
        api.log?.info?.("ios-sim ensureBootedDevice already booted", {
          udid: d.udid, name: d.name, runtime: rt,
        });
        return;
      }
    }
  }
  // Pick newest iOS runtime, prefer iPhone 16/15/14 family.
  const iosRuntimes = allRuntimes.sort().reverse();
  let pick = null;
  outer: for (const rt of iosRuntimes) {
    const devs = (res.data.devices[rt] || []).filter((d) => d.isAvailable);
    for (const pat of [/iPhone 16/, /iPhone 15/, /iPhone 14/, /iPhone/]) {
      const m = devs.find((d) => pat.test(d.name));
      if (m) { pick = { ...m, runtime: rt }; break outer; }
    }
  }
  if (!pick) {
    api.log?.warn?.("ios-sim ensureBootedDevice no pick", { runtimes: iosRuntimes });
    return;
  }
  api.log?.info?.("ios-sim ensureBootedDevice picked", {
    udid: pick.udid, name: pick.name, runtime: pick.runtime,
  });
  setStatus(panel, `Booting ${pick.name}…`);
  const r = await api.ipc.invoke("ios-sim:simctl", ["boot", pick.udid]);
  const stderr = (r?.stderr || "").trim();
  const benign = /code=405|current state: Booted/.test(stderr);
  api.log?.info?.("ios-sim ensureBootedDevice boot result", {
    ok: r?.ok, code: r?.code, benign,
    stderr: stderr.slice(0, 400),
    stdout: (r?.stdout || "").slice(0, 200),
  });
  if (!r?.ok && !benign) {
    setStatus(panel, `Boot failed: ${stderr || "unknown"}`);
    return;
  }
  // Start capture immediately — the helper polls for the booted device state,
  // so we get frames as soon as IOSurface is ready (Apple-logo phase included).
  const cs = await api.ipc.invoke("ios-sim:capture:stop").catch((e) => ({ ok: false, error: String(e) }));
  api.log?.info?.("ios-sim ensureBootedDevice capture stop", { ok: cs?.ok });
  const cst = await api.ipc.invoke("ios-sim:capture:start").catch((e) => ({ ok: false, error: String(e) }));
  api.log?.info?.("ios-sim ensureBootedDevice capture start", { ok: cst?.ok });
  setStatus(panel, `Active: ${pick.name}`);
}

function makeDevicePickerButton(panel, api) {
  const b = document.createElement("button");
  b.type = "button";
  // Inherit toolbar-button CSS for size/padding/cursor/hover.
  b.setAttribute(TWEAK_ATTR, "toolbar-button");
  b.dataset.codexppIosSimRole = "device-picker";
  b.setAttribute("aria-label", "Choose device");
  b.setAttribute("title", "Choose device");
  const label = document.createElement("span");
  label.setAttribute(TWEAK_ATTR, "device-picker-label");
  label.textContent = "Device";
  label.style.maxWidth = "150px";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  const chev = document.createElement("span");
  chev.className = "flex shrink-0 items-center justify-center";
  chev.innerHTML = SVGS.chevron;
  b.append(label, chev);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    api.log?.info?.("ios-sim picker clicked");
    openDevicePicker(panel, api).catch((err) =>
      api.log?.error?.("ios-sim openDevicePicker threw", String(err)),
    );
  });
  return b;
}

// Refresh device picker label from currently-booted device.
async function refreshDeviceLabel(panel, api) {
  const button = panel.__codexppIosSimDevicePickerButton;
  if (!button) return;
  const label = button.querySelector(`[${TWEAK_ATTR}="device-picker-label"]`);
  if (!label) return;
  const res = await api.ipc.invoke("ios-sim:devices");
  if (!res?.ok) return;
  for (const list of Object.values(res.data?.devices || {})) {
    for (const d of list || []) if (d.state === "Booted") {
      api.log?.info?.("ios-sim refreshDeviceLabel set", d.name);
      label.textContent = d.name;
      return;
    }
  }
  api.log?.info?.("ios-sim refreshDeviceLabel none booted");
  label.textContent = "Device";
}

function setStatus(panel, msg) {
  const placeholder = panel?.__codexppIosSimPlaceholder;
  if (!placeholder) return;
  let status = placeholder.querySelector(`[${TWEAK_ATTR}="status"]`);
  if (!status) {
    status = document.createElement("div");
    status.setAttribute(TWEAK_ATTR, "status");
    placeholder.appendChild(status);
  }
  status.textContent = msg;
}

// ── helpers ─────────────────────────────────────────────────────────────

function extractLabel(node) {
  return node.getAttribute("aria-label")?.trim() || compactText(node.textContent || "");
}

function matchesBrowserText(value) {
  return BROWSER_PATTERNS.some((pattern) => pattern.test(value));
}

function matchesMenuFallbackText(value) {
  return MENU_FALLBACK_PATTERNS.some((pattern) => pattern.test(value));
}

function matchesPickerTitleText(value) {
  return PICKER_TITLE_PATTERNS.some((pattern) => pattern.test(value));
}

function compactText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function htmlToElement(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}
