
const { app, BrowserWindow, screen, ipcMain } = require("electron");
const { Client, MessageTypes } = require("./macsploit");
const Net = require("net");
const Zlib = require("zlib");
const https = require("https");

let barWindow;
const tabWindows = new Map();
let isTopMostEnabled = false;
let macClient = null;
let macClientPort = 5553;
let currentExecutor = "Disconnected";
let hydrogenServerPort = null;
let opiumwarePort = null;
let appIconImage = null;

const APP_ICON_URL = "https://i.ibb.co/mC7BKQ83/wavelogo.png";

const BAR_EXPANDED_BOUNDS = { width: 420, height: 130, y: 10 };
const BAR_COLLAPSED_BOUNDS = { width: 130, height: 14, y: 10 };

function getCenteredBarX(width) {
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
  return Math.floor(screenWidth / 2 - width / 2);
}

function setBarWindowMode(mode) {
  if (!barWindow || barWindow.isDestroyed()) return;

  const bounds = mode === "collapsed" ? BAR_COLLAPSED_BOUNDS : BAR_EXPANDED_BOUNDS;
  barWindow.setBounds({
    x: getCenteredBarX(bounds.width),
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  });
}

function setWindowIcon(win) {
  if (!win || win.isDestroyed() || !appIconImage) return;

  try {
    if (typeof win.setIcon === "function") {
      win.setIcon(appIconImage);
    }
  } catch (_error) {
  }
}

function loadAppIcon() {
  return new Promise((resolve) => {
    https
      .get(APP_ICON_URL, (response) => {
        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const icon = require("electron").nativeImage.createFromBuffer(Buffer.concat(chunks));
            if (!icon || icon.isEmpty()) {
              resolve(null);
              return;
            }

            resolve(icon);
          } catch (_error) {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}

function getAllWindows() {
  const windows = [];
  if (barWindow && !barWindow.isDestroyed()) {
    windows.push(barWindow);
  }

  for (const win of tabWindows.values()) {
    if (win && !win.isDestroyed()) {
      windows.push(win);
    }
  }

  return windows;
}

function broadcastToRenderers(channel, payload) {
  for (const win of getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function getMacStatusPayload() {
  return {
    attached: currentExecutor !== "Disconnected",
    executor: currentExecutor,
    port: macClientPort,
    hydrogenPort: hydrogenServerPort,
    opiumwarePort,
  };
}

function broadcastMacStatus() {
  broadcastToRenderers("macsploit-status", getMacStatusPayload());
}

function setExecutorStatus(name) {
  currentExecutor = name || "Disconnected";
  broadcastMacStatus();
}

async function tryMacsploitExecute(script) {
  const client = ensureMacClient();

  try {
    if (client.isAttached()) {
      await client.detach().catch(() => {});
    }

    await client.attach(macClientPort);
    client.executeScript(String(script || ""));
    setExecutorStatus("MacSploit");
    return { ok: true, executor: "MacSploit" };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function findHydrogenPort() {
  const START_PORT = 6969;
  const END_PORT = 7069;

  for (let port = START_PORT; port <= END_PORT; port++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/secret`, { method: "GET" });
      if (!response.ok) continue;

      const text = await response.text();
      if (text === "0xdeadbeef") {
        hydrogenServerPort = port;
        return port;
      }
    } catch (_error) {
      continue;
    }
  }

  return null;
}

async function tryHydrogenExecute(script) {
  try {
    const port = await findHydrogenPort();
    if (!port) {
      return { ok: false, error: "Hydrogen server not found." };
    }

    const response = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: String(script || ""),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return { ok: false, error: `Hydrogen HTTP ${response.status}: ${errorText}` };
    }

    setExecutorStatus("Hydrogen");
    return { ok: true, executor: "Hydrogen" };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function connectOpiumwarePort(port) {
  return new Promise((resolve, reject) => {
    const socket = Net.createConnection({ host: "127.0.0.1", port }, () => {
      resolve(socket);
    });

    socket.setTimeout(700);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Opiumware connection timeout"));
    });

    socket.once("error", (error) => {
      reject(error);
    });
  });
}

function deflateBuffer(data) {
  return new Promise((resolve, reject) => {
    Zlib.deflate(data, (error, compressed) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(compressed);
    });
  });
}

async function tryOpiumwareExecute(script) {
  const ports = [8392, 8393, 8394, 8395, 8396, 8397];
  const payloadBase = String(script || "").trim();
  const payload = payloadBase.startsWith("OpiumwareScript ") || payloadBase.startsWith("OpiumwareSetting ")
    ? payloadBase
    : `OpiumwareScript ${payloadBase}`;

  for (const port of ports) {
    let socket = null;
    try {
      socket = await connectOpiumwarePort(port);
      const compressed = await deflateBuffer(Buffer.from(payload, "utf8"));

      await new Promise((resolve, reject) => {
        socket.write(compressed, (writeError) => {
          if (writeError) {
            reject(writeError);
            return;
          }

          resolve();
        });
      });

      socket.end();
      opiumwarePort = port;
      setExecutorStatus("Opiumware");
      return { ok: true, executor: "Opiumware" };
    } catch (_error) {
      if (socket) socket.destroy();
      continue;
    }
  }

  return { ok: false, error: "Failed to connect Opiumware on ports 8392-8397." };
}

function ensureMacClient() {
  if (macClient) return macClient;

  macClient = new Client();
  macClient.on("message", (message, type) => {
    broadcastToRenderers("macsploit-message", {
      type,
      kind: type === MessageTypes.ERROR ? "error" : "print",
      message,
    });
  });

  macClient.on("error", (error) => {
    broadcastToRenderers("macsploit-error", {
      message: error?.message || String(error),
    });
  });

  macClient.on("close", (error) => {
    broadcastToRenderers("macsploit-close", {
      message: error?.message || null,
    });
    if (currentExecutor === "MacSploit") {
      setExecutorStatus("Disconnected");
    } else {
      broadcastMacStatus();
    }
  });

  return macClient;
}

const TAB_CONFIG = {
  editor: { title: "Editor", file: "WaveEditorFull.html", width: 921, height: 519, resizable: false },
  script: { title: "Script Hub", panel: "script", width: 900, height: 650 },
  chat: { title: "AI Chat", panel: "chat", width: 900, height: 650 },
  terminal: { title: "Terminal", panel: "terminal", width: 900, height: 650 },
  settings: { title: "Settings", panel: "settings", width: 900, height: 650 }
};

function createBar() {
  barWindow = new BrowserWindow({
    width: BAR_EXPANDED_BOUNDS.width,
    height: BAR_EXPANDED_BOUNDS.height,
    x: getCenteredBarX(BAR_EXPANDED_BOUNDS.width),
    y: BAR_EXPANDED_BOUNDS.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: __dirname + "/preload.js",
      contextIsolation: true
    }
  });

  setWindowIcon(barWindow);
  barWindow.loadFile("wavetabs.html");
  setBarWindowMode("collapsed");
}

function createContent(page) {
  const contentWindow = new BrowserWindow({
    width: 950,
    height: 650,
    frame: false,
    titleBarStyle: "hidden",
    alwaysOnTop: true,
    resizable: true,
    movable: true,
  });

  contentWindow.loadFile(page);
}

function openTabWindow(tabKey) {
  const config = TAB_CONFIG[tabKey];
  if (!config) return { isOpen: false };

  const existing = tabWindows.get(tabKey);
  if (existing && !existing.isDestroyed()) {
    existing.close();
    return { isOpen: false };
  }

  const tabWindow = new BrowserWindow({
    width: config.width,
    height: config.height,
    title: config.title,
    frame: false,
    titleBarStyle: "hidden",
    alwaysOnTop: isTopMostEnabled,
    resizable: config.resizable ?? true,
    movable: true,
    backgroundColor: "#011627",
    webPreferences: {
      preload: __dirname + "/preload.js",
      contextIsolation: true,
    }
  });

  setWindowIcon(tabWindow);

  if (config.file) {
    tabWindow.loadFile(config.file);
  } else if (config.panel) {
    tabWindow.loadFile("wavetabs.html", { hash: `panel=${config.panel}` });
  } else {
    tabWindow.loadFile("wavetabs.html");
  }

  tabWindow.on("closed", () => {
    tabWindows.delete(tabKey);
  });

  tabWindows.set(tabKey, tabWindow);
  return { isOpen: true };
}

ipcMain.on("open-editor", () => {
  openTabWindow("editor");
});

ipcMain.handle("toggle-tab", (_event, tabKey) => {
  return openTabWindow(tabKey);
});

ipcMain.handle("kill-wave", () => {
  for (const win of tabWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  }
  tabWindows.clear();

  if (barWindow && !barWindow.isDestroyed()) {
    barWindow.close();
  }

  app.quit();
  return { ok: true };
});

ipcMain.handle("set-top-most", (_event, enabled) => {
  isTopMostEnabled = !!enabled;

  for (const win of tabWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(isTopMostEnabled, isTopMostEnabled ? "floating" : "normal");
    }
  }

  return { ok: true, isTopMost: isTopMostEnabled };
});

ipcMain.handle("set-bar-mode", (_event, mode) => {
  if (mode === "expanded" || mode === "collapsed") {
    setBarWindowMode(mode);
    return { ok: true, mode };
  }

  return { ok: false, mode: "expanded" };
});

ipcMain.handle("macsploit-attach", async (_event, port = 5553) => {
  const client = ensureMacClient();

  if (client.isAttached()) {
    setExecutorStatus("MacSploit");
    return { ok: true, attached: true, port: macClientPort };
  }

  try {
    macClientPort = Number(port) || 5553;
    await client.attach(macClientPort);
    setExecutorStatus("MacSploit");
    return { ok: true, attached: true, port: macClientPort };
  } catch (error) {
    setExecutorStatus("Disconnected");
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("macsploit-detach", async () => {
  if (!macClient) {
    setExecutorStatus("Disconnected");
    return { ok: true, detached: true };
  }

  if (!macClient.isAttached()) {
    setExecutorStatus("Disconnected");
    return { ok: true, detached: true };
  }

  try {
    await macClient.detach();
    setExecutorStatus("Disconnected");
    return { ok: true, detached: true };
  } catch (error) {
    setExecutorStatus("Disconnected");
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("macsploit-execute", async (_event, script) => {
  const macResult = await tryMacsploitExecute(script);
  if (macResult.ok) return { ok: true, executor: macResult.executor };

  const hydrogenResult = await tryHydrogenExecute(script);
  if (hydrogenResult.ok) return { ok: true, executor: hydrogenResult.executor };

  const opiumwareResult = await tryOpiumwareExecute(script);
  if (opiumwareResult.ok) return { ok: true, executor: opiumwareResult.executor };

  setExecutorStatus("Disconnected");
  return {
    ok: false,
    error: [macResult.error, hydrogenResult.error, opiumwareResult.error].filter(Boolean).join(" | "),
  };
});

ipcMain.handle("macsploit-setting", async (_event, key, value) => {
  const client = ensureMacClient();

  if (!client.isAttached()) {
    try {
      await client.attach(macClientPort);
      broadcastMacStatus();
    } catch (error) {
      broadcastMacStatus();
      return { ok: false, error: error?.message || String(error) };
    }
  }

  try {
    client.updateSetting(String(key || ""), !!value);
    broadcastMacStatus();
    return { ok: true };
  } catch (error) {
    broadcastMacStatus();
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("macsploit-status", () => {
  return { ok: true, ...getMacStatusPayload() };
});

app.whenReady().then(() => {
  loadAppIcon().then((icon) => {
    if (!icon) return;

    appIconImage = icon;
    if (process.platform === "darwin" && app.dock) {
      app.dock.setIcon(icon);
    }
  });

  createBar();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
