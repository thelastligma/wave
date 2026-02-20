const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const zlib = require('zlib');

let mainWindow;
const panelWindows = new Map();

class WaveExecutorAPI {
  static HYDRO_START = 6969;
  static HYDRO_END = 7069;
  static MACSPLOIT_START = 5553;
  static MACSPLOIT_END = 5562;
  static OPIUM_START = 8392;
  static OPIUM_END = 8397;

  constructor() {
    this.baseDirectory = path.join(os.homedir(), 'Wave');
    this.scriptsDirectory = path.join(this.baseDirectory, 'scripts');
    this.hydrogenAutoexecDir = path.join(os.homedir(), 'Hydrogen', 'autoexecute');
    this.opiumwareAutoexecDir = path.join(os.homedir(), 'Opiumware', 'autoexec');

    this.ensureDirectories();
    this.syncAutoexecFolders();
  }

  ensureDirectories() {
    fs.mkdirSync(this.baseDirectory, { recursive: true });
    fs.mkdirSync(this.scriptsDirectory, { recursive: true });
  }

  getExistingAutoexecDirs() {
    return [
      { path: this.hydrogenAutoexecDir, name: 'Hydrogen' },
      { path: this.opiumwareAutoexecDir, name: 'OpiumWare' }
    ].filter((entry) => fs.existsSync(entry.path));
  }

  syncAutoexecFolders() {
    try {
      const dirs = this.getExistingAutoexecDirs();
      if (dirs.length === 0) {
        return;
      }

      const allScripts = new Map();
      dirs.forEach(({ path: dirPath }) => {
        fs.readdirSync(dirPath)
          .filter((fileName) => fileName.endsWith('.lua'))
          .forEach((fileName) => {
            if (!allScripts.has(fileName)) {
              const content = fs.readFileSync(path.join(dirPath, fileName), 'utf8');
              allScripts.set(fileName, content);
            }
          });
      });

      allScripts.forEach((content, scriptName) => {
        const localPath = path.join(this.scriptsDirectory, scriptName);
        if (!fs.existsSync(localPath)) {
          fs.writeFileSync(localPath, content, 'utf8');
        }

        dirs.forEach(({ path: dirPath }) => {
          const targetPath = path.join(dirPath, scriptName);
          if (!fs.existsSync(targetPath)) {
            fs.writeFileSync(targetPath, content, 'utf8');
          }
        });
      });
    } catch (error) {
      console.error('Failed syncing autoexec folders:', error.message);
    }
  }

  sanitizeScriptName(name) {
    let fileName = String(name || '').trim();
    if (!fileName.endsWith('.lua')) {
      fileName += '.lua';
    }

    fileName = path.basename(fileName);
    return fileName.replace(/[^a-zA-Z0-9. _-]/g, '');
  }

  sendOpiumwareScript(scriptContent, port) {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('Timeout'));
      }, 3000);

      client.connect(port, '127.0.0.1', () => {
        clearTimeout(timeout);
        const formattedScript = `OpiumwareScript ${scriptContent}`;
        const compressed = zlib.deflateSync(Buffer.from(formattedScript, 'utf8'));
        client.write(compressed);
        client.end();
        resolve();
      });

      client.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /* MacSploit executor support */
  buildMacSploitPacketExecute(scriptContent) {
    const payload = Buffer.from(String(scriptContent ?? ''), 'utf8');
    const packet = Buffer.alloc(16 + payload.length);
    // uint8 type at offset 0
    packet.writeUInt8(0, 0); // IPC_EXECUTE
    // uint64 length at offset 8
    packet.writeBigUInt64LE(BigInt(payload.length), 8);
    payload.copy(packet, 16);
    return packet;
  }

  sendMacSploitScript(scriptContent, port) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`MacSploit timed out on port ${port}`));
      }, 4000);

      socket.connect(port, '127.0.0.1', () => {
        try {
          const packet = this.buildMacSploitPacketExecute(scriptContent);
          socket.write(packet);
          socket.end();
          clearTimeout(timeout);
          resolve();
        } catch (err) {
          clearTimeout(timeout);
          socket.destroy();
          reject(err);
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`MacSploit connection error on port ${port}: ${err?.message || String(err)}`));
      });
    });
  }

  checkHydrogenSecret(port) {
    return new Promise((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/secret',
        timeout: 1000
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve(res.statusCode === 200 && body === '0xdeadbeef');
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.on('error', () => resolve(false));
    });
  }

  postHydrogenExecute(port, scriptContent) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/execute',
        method: 'POST',
        timeout: 10000,
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': 'Wave/1.0'
        }
      }, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Hydrogen returned HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Hydrogen execute timed out'));
      });
      req.on('error', reject);
      req.write(scriptContent);
      req.end();
    });
  }

  async findHydrogenPort() {
    for (let port = WaveExecutorAPI.HYDRO_START; port <= WaveExecutorAPI.HYDRO_END; port += 1) {
      const online = await this.checkHydrogenSecret(port);
      if (online) {
        return port;
      }
    }
    return null;
  }

  async checkPortStatus() {
    const status = [];

    for (let port = WaveExecutorAPI.HYDRO_START; port <= WaveExecutorAPI.HYDRO_END; port += 1) {
      const online = await this.checkHydrogenSecret(port);
      if (online) {
        status.push({ port, type: 'hydrogen', online: true, label: `Hydrogen :${port}` });
      }
    }

    for (let port = WaveExecutorAPI.MACSPLOIT_START; port <= WaveExecutorAPI.MACSPLOIT_END; port += 1) {
      const online = await this.isTcpPortOpen(port);
      status.push({ port, type: 'macsploit', online, label: `MacSploit :${port}` });
    }

    for (let port = WaveExecutorAPI.OPIUM_START; port <= WaveExecutorAPI.OPIUM_END; port += 1) {
      const online = await this.isTcpPortOpen(port);
      status.push({ port, type: 'opiumware', online, label: `OpiumWare :${port}` });
    }

    return status;
  }

  isTcpPortOpen(port) {
    return new Promise((resolve) => {
      const client = new net.Socket();
      const timeout = setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 500);

      client.connect(port, '127.0.0.1', () => {
        clearTimeout(timeout);
        client.destroy();
        resolve(true);
      });

      client.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  async executeScriptOnPort(scriptContent, targetPort) {
    if (!targetPort || targetPort === 'auto') {
      return this.executeScript(scriptContent);
    }

    const port = Number.parseInt(targetPort, 10);
    if (!Number.isFinite(port)) {
      return { status: 'error', message: 'Invalid target port' };
    }

    // Hydrogen range
    if (port >= WaveExecutorAPI.HYDRO_START && port <= WaveExecutorAPI.HYDRO_END) {
      try {
        await this.postHydrogenExecute(port, scriptContent);
        return { status: 'success', message: `Script executed via Hydrogen on port ${port}` };
      } catch (error) {
        return { status: 'error', message: `Failed to execute on Hydrogen port ${port}: ${error?.message || String(error)}` };
      }
    }

    // MacSploit range
    if (port >= WaveExecutorAPI.MACSPLOIT_START && port <= WaveExecutorAPI.MACSPLOIT_END) {
      try {
        await this.sendMacSploitScript(scriptContent, port);
        return { status: 'success', message: `Script executed via MacSploit on port ${port}` };
      } catch (error) {
        return { status: 'error', message: `Failed to execute on MacSploit port ${port}: ${error?.message || String(error)}` };
      }
    }

    // OpiumWare range
    if (port >= WaveExecutorAPI.OPIUM_START && port <= WaveExecutorAPI.OPIUM_END) {
      try {
        await this.sendOpiumwareScript(scriptContent, port);
        return { status: 'success', message: `Script executed via OpiumWare on port ${port}` };
      } catch (error) {
        return { status: 'error', message: `Failed to execute on OpiumWare port ${port}: ${error?.message || String(error)}` };
      }
    }

    return { status: 'error', message: 'Unsupported executor/port' };
  }

  async executeScript(scriptContent) {
    const content = typeof scriptContent === 'string' ? scriptContent : '';
    if (!content.trim()) {
      return { status: 'error', message: 'Script content is empty' };
    }

    const hydrogenPort = await this.findHydrogenPort();
    if (hydrogenPort) {
      try {
        await this.postHydrogenExecute(hydrogenPort, content);
        return { status: 'success', executor: 'hydrogen', message: `Executed via Hydrogen on port ${hydrogenPort}` };
      } catch {
      }
    }

    for (let port = WaveExecutorAPI.OPIUM_START; port <= WaveExecutorAPI.OPIUM_END; port += 1) {
      try {
        await this.sendOpiumwareScript(content, port);
        return { status: 'success', executor: 'opiumware', message: `Executed via OpiumWare on port ${port}` };
      } catch {
      }
    }

    // Try MacSploit range
    for (let port = WaveExecutorAPI.MACSPLOIT_START; port <= WaveExecutorAPI.MACSPLOIT_END; port += 1) {
      try {
        await this.sendMacSploitScript(content, port);
        return { status: 'success', executor: 'macsploit', message: `Executed via MacSploit on port ${port}` };
      } catch {
      }
    }

    return {
      status: 'error',
      message: 'No compatible executor detected (Hydrogen, OpiumWare, MacSploit)'
    };
  }

  saveScript(name, content, autoExec = false) {
    try {
      const fileName = this.sanitizeScriptName(name);
      if (!fileName || fileName === '.lua') {
        return { status: 'error', message: 'Invalid script name' };
      }

      const filePath = path.join(this.scriptsDirectory, fileName);
      fs.writeFileSync(filePath, String(content ?? ''), 'utf8');

      this.applyAutoExecForScript(fileName, String(content ?? ''), Boolean(autoExec));

      return { status: 'success', path: filePath, autoExec: Boolean(autoExec) };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }

  applyAutoExecForScript(scriptName, content, enabled) {
    [this.hydrogenAutoexecDir, this.opiumwareAutoexecDir].forEach((dirPath) => {
      if (!fs.existsSync(dirPath)) {
        return;
      }

      const targetPath = path.join(dirPath, scriptName);
      if (enabled) {
        fs.writeFileSync(targetPath, content, 'utf8');
      } else if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
    });
  }

  toggleAutoExec(scriptName, enabled) {
    try {
      const fileName = this.sanitizeScriptName(scriptName);
      const scriptPath = path.join(this.scriptsDirectory, fileName);
      if (!fs.existsSync(scriptPath)) {
        return { status: 'error', message: `Script ${fileName} not found` };
      }

      const content = fs.readFileSync(scriptPath, 'utf8');
      this.applyAutoExecForScript(fileName, content, Boolean(enabled));
      return { status: 'success', message: `Auto-exec ${enabled ? 'enabled' : 'disabled'} for ${fileName}` };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }

  getLocalScripts() {
    try {
      const scripts = fs.readdirSync(this.scriptsDirectory)
        .filter((fileName) => fileName.endsWith('.lua'))
        .map((fileName) => {
          const filePath = path.join(this.scriptsDirectory, fileName);
          const autoExec = [this.hydrogenAutoexecDir, this.opiumwareAutoexecDir]
            .some((dirPath) => fs.existsSync(path.join(dirPath, fileName)));  

          return {
            name: fileName,
            path: filePath,
            content: fs.readFileSync(filePath, 'utf8'),
            autoExec
          };
        });

      return { status: 'success', scripts };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }

  deleteScript(scriptName) {
    try {
      const fileName = this.sanitizeScriptName(scriptName);
      const scriptPath = path.join(this.scriptsDirectory, fileName);

      if (!fs.existsSync(scriptPath)) {
        return { status: 'error', message: `Script ${fileName} not found` };
      }

      fs.unlinkSync(scriptPath);
      [this.hydrogenAutoexecDir, this.opiumwareAutoexecDir].forEach((dirPath) => {
        const targetPath = path.join(dirPath, fileName);
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
      });

      return { status: 'success', message: `Script ${fileName} deleted` };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }

  renameScript(oldName, newName) {
    try {
      const previousName = this.sanitizeScriptName(oldName);
      const nextName = this.sanitizeScriptName(newName);
      if (!nextName || nextName === '.lua') {
        return { status: 'error', message: 'Invalid new name' };
      }

      const oldPath = path.join(this.scriptsDirectory, previousName);
      const newPath = path.join(this.scriptsDirectory, nextName);

      if (!fs.existsSync(oldPath)) {
        return { status: 'error', message: `Script ${previousName} not found` };
      }

      if (fs.existsSync(newPath) && previousName !== nextName) {
        return { status: 'error', message: `Script ${nextName} already exists` };
      }

      fs.renameSync(oldPath, newPath);
      const content = fs.readFileSync(newPath, 'utf8');

      [this.hydrogenAutoexecDir, this.opiumwareAutoexecDir].forEach((dirPath) => {
        if (!fs.existsSync(dirPath)) {
          return;
        }

        const oldAutoexecPath = path.join(dirPath, previousName);
        const newAutoexecPath = path.join(dirPath, nextName);
        if (fs.existsSync(oldAutoexecPath)) {
          fs.writeFileSync(newAutoexecPath, content, 'utf8');
          fs.unlinkSync(oldAutoexecPath);
        }
      });

      return { status: 'success', message: `Renamed ${previousName} -> ${nextName}` };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }

  openScriptsFolder() {
    shell.openPath(this.scriptsDirectory);
    return { status: 'success', path: this.scriptsDirectory };
  }
}

let waveExecutor;

const DEFAULT_SETTINGS = {
  topMost: false,
  mountPosition: 'Top'
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'wave-settings.json');
}

function loadSettings() {
  const filePath = settingsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_SETTINGS };
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...DEFAULT_SETTINGS,
      ...parsed
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  const filePath = settingsPath();
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
}

let appSettings = DEFAULT_SETTINGS;

function getTopCenterPosition(winBounds) {
  const display = screen.getDisplayMatching(winBounds);
  const workArea = display.workArea;
  const notchPaddingY = 18;

  const x = Math.round(workArea.x + (workArea.width - winBounds.width) / 2);
  const y = workArea.y + notchPaddingY;

  return { x, y };
}

function getWindowPositionForMount(mountPosition, winBounds) {
  const display = screen.getDisplayMatching(winBounds);
  const workArea = display.workArea;
  const margin = 16;

  const centeredX = Math.round(workArea.x + (workArea.width - winBounds.width) / 2);
  const centeredY = Math.round(workArea.y + (workArea.height - winBounds.height) / 2);

  switch (mountPosition) {
    case 'Left':
      return { x: workArea.x + margin, y: centeredY };
    case 'Right':
      return { x: workArea.x + workArea.width - winBounds.width - margin, y: centeredY };
    case 'Bottom':
      return { x: centeredX, y: workArea.y + workArea.height - winBounds.height - margin };
    case 'Top':
    default:
      return getTopCenterPosition(winBounds);
  }
}

function applyWindowSettings(win) {
  if (!win || win.isDestroyed()) {
    return;
  }

  win.setAlwaysOnTop(Boolean(appSettings.topMost));

  const bounds = win.getBounds();
  const target = getWindowPositionForMount(appSettings.mountPosition, bounds);
  win.setPosition(target.x, target.y, true);
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
}

function createPanelWindow(panel) {
  const settings = {
    editor: { width: 921, height: 519, minWidth: 780, minHeight: 460, file: 'WaveEditorFull.html' },
    script: { width: 921, height: 519, minWidth: 720, minHeight: 420, file: 'wavetabs.html', panel: 'script' },
    chat: { width: 606, height: 628, minWidth: 520, minHeight: 500, file: 'wavetabs.html', panel: 'chat' },
    terminal: { width: 880, height: 628, minWidth: 700, minHeight: 460, file: 'wavetabs.html', panel: 'terminal' },
    settings: { width: 696, height: 596, minWidth: 600, minHeight: 500, file: 'wavetabs.html', panel: 'settings' }
  };

  const config = settings[panel];
  if (!config) {
    return null;
  }

  const panelWindow = new BrowserWindow({
    width: config.width,
    height: config.height,
    useContentSize: true,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    frame: false,
    transparent: true,
    hasShadow: false,
    autoHideMenuBar: true,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const filePath = path.join(__dirname, config.file);
  if (config.panel) {
    panelWindow.loadFile(filePath, { query: { panel: config.panel } });
  } else {
    panelWindow.loadFile(filePath);
  }

  panelWindow.once('ready-to-show', () => {
    panelWindow.setContentSize(config.width, config.height, true);
  });

  panelWindow.webContents.on('did-finish-load', () => {
    panelWindow.setContentSize(config.width, config.height, true);
  });

  panelWindow.setAlwaysOnTop(Boolean(appSettings.topMost));

  panelWindows.set(panel, panelWindow);
  panelWindow.on('closed', () => {
    panelWindows.delete(panel);
  });

  return panelWindow;
}

function createWindow() {
  const tabWindowWidth = 430;
  const tabWindowHeight = 140;

  mainWindow = new BrowserWindow({
    width: tabWindowWidth,
    height: tabWindowHeight,
    minWidth: tabWindowWidth,
    minHeight: tabWindowHeight,
    maxWidth: tabWindowWidth,
    maxHeight: tabWindowHeight,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'wavetabs.html'));

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isCmdOrCtrl = input.meta || input.control;
    const isCmdW = isCmdOrCtrl && input.key.toLowerCase() === 'w';

    if (isCmdW) {
      event.preventDefault();
      revealMainWindow();
    }
  });

  applyWindowSettings(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  appSettings = loadSettings();
  waveExecutor = new WaveExecutorAPI();

  createWindow();

  globalShortcut.register('CommandOrControl+W', () => {
    revealMainWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      revealMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle('settings:get', () => {
  return appSettings;
});

ipcMain.handle('settings:update', (_event, payload) => {
  const { key, value } = payload || {};

  if (!key) {
    return appSettings;
  }

  appSettings = {
    ...appSettings,
    [key]: value
  };

  saveSettings(appSettings);

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (key === 'topMost') {
      mainWindow.setAlwaysOnTop(Boolean(value));
    }

    if (key === 'mountPosition') {
      applyWindowSettings(mainWindow);
    }
  }

  return appSettings;
});

ipcMain.handle('window:apply-position', (_event, mountPosition) => {
  if (mountPosition) {
    appSettings = {
      ...appSettings,
      mountPosition
    };

    saveSettings(appSettings);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    applyWindowSettings(mainWindow);
  }

  return appSettings;
});

ipcMain.handle('window:reopen', () => {
  revealMainWindow();
  return true;
});

ipcMain.handle('panel:open', (_event, panel) => {
  const existing = panelWindows.get(panel);

  if (existing && !existing.isDestroyed()) {
    existing.close();
    panelWindows.delete(panel);
    return { action: 'closed', panel };
  }

  const win = createPanelWindow(panel);
  return { action: win ? 'opened' : 'failed', panel };
});

ipcMain.handle('execute-script', (_event, scriptContent) => {
  return waveExecutor.executeScript(scriptContent);
});

ipcMain.handle('execute-script-on-port', (_event, scriptContent, targetPort) => {
  return waveExecutor.executeScriptOnPort(scriptContent, targetPort);
});

ipcMain.handle('check-port-status', () => {
  return waveExecutor.checkPortStatus();
});

ipcMain.handle('open-scripts-folder', () => {
  return waveExecutor.openScriptsFolder();
});

ipcMain.handle('save-script', (_event, name, content, autoExec) => {
  return waveExecutor.saveScript(name, content, autoExec);
});

ipcMain.handle('toggle-autoexec', (_event, scriptName, enabled) => {
  return waveExecutor.toggleAutoExec(scriptName, enabled);
});

ipcMain.handle('get-local-scripts', () => {
  return waveExecutor.getLocalScripts();
});

ipcMain.handle('delete-script', (_event, scriptName) => {
  return waveExecutor.deleteScript(scriptName);
});

ipcMain.handle('rename-script', (_event, oldName, newName) => {
  return waveExecutor.renameScript(oldName, newName);
});
