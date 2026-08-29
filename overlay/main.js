const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let overlayWindow = null;

// Proactive prediction & activity tracking state
let latestPrediction = {
  prediction: "Ready to assist you with any application or webpage on your screen.",
  activeApp: "Desktop",
  confidence: "medium",
  timestamp: Date.now()
};

let lastCursorPos = { x: 0, y: 0 };
let lastActivityTime = Date.now();
let lastCapturedBuffer = null;
let isPredicting = false;

const MEMORY_FILE_PATH = path.join(__dirname, 'data', 'memory.json');

function getMemoryData() {
  try {
    if (fs.existsSync(MEMORY_FILE_PATH)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading memory bank:', err);
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sessionCount: 0,
    profile: "New user. Prefers concise step-by-step guidance.",
    recentInteractions: []
  };
}

function saveMemoryData(data) {
  try {
    const dir = path.dirname(MEMORY_FILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving memory bank:', err);
    return false;
  }
}

// ── Screen Capture & Difference Detection ──────────────────────────────────

async function captureScreenFrame(width = 1280, height = 720) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });
    if (sources && sources.length > 0) {
      const img = sources[0].thumbnail;
      const base64 = img.toDataURL(); // 'data:image/png;base64,...'
      const jpegBase64 = img.toJPEG(60).toString('base64');
      return {
        dataUrl: `data:image/jpeg;base64,${jpegBase64}`,
        buffer: img.toBitmap()
      };
    }
  } catch (err) {
    console.error('Screen capture error:', err);
  }
  return null;
}

// Fast downsampled pixel difference check
function hasSignificantScreenChange(newBuffer, oldBuffer) {
  if (!oldBuffer || !newBuffer) return true;
  if (newBuffer.length !== oldBuffer.length) return true;

  let diffCount = 0;
  const sampleStep = 64; // Sample every 64th byte for speed
  const totalSamples = Math.floor(newBuffer.length / sampleStep);

  for (let i = 0; i < newBuffer.length; i += sampleStep) {
    if (Math.abs(newBuffer[i] - oldBuffer[i]) > 30) {
      diffCount++;
    }
  }
  return (diffCount / totalSamples) > 0.12; // >12% difference considered significant
}

// Proactive screen prediction runner
async function runBackgroundPrediction() {
  if (isPredicting) return;
  isPredicting = true;

  try {
    const frame = await captureScreenFrame(1280, 720);
    if (!frame) return;

    const changed = hasSignificantScreenChange(frame.buffer, lastCapturedBuffer);
    lastCapturedBuffer = frame.buffer;

    if (!changed && latestPrediction.timestamp) {
      return; // No major change, keep current prediction
    }

    const memory = getMemoryData();
    const res = await fetch('http://localhost:8083/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screenshot_base64: frame.dataUrl,
        memoryProfile: memory?.profile || ""
      })
    });

    if (res.ok) {
      const data = await res.json();
      latestPrediction = {
        ...data,
        timestamp: Date.now()
      };
      console.log('Updated screen prediction:', latestPrediction.prediction);
    }
  } catch (err) {
    // Backend may not be ready or LLM_API_KEY not configured
    // Fail silently in background loop
  } finally {
    isPredicting = false;
  }
}

// Activity monitor loop
function startActivityMonitor() {
  setInterval(async () => {
    try {
      const currentPos = screen.getCursorScreenPoint();
      const mouseMoved = Math.abs(currentPos.x - lastCursorPos.x) > 5 || Math.abs(currentPos.y - lastCursorPos.y) > 5;
      lastCursorPos = currentPos;

      if (mouseMoved) {
        lastActivityTime = Date.now();
      }

      const isIdle = (Date.now() - lastActivityTime) > 25000; // >25s without movement
      const now = Date.now();

      // Active: check prediction every 6s
      // Idle: back off to 35s
      const interval = isIdle ? 35000 : 6000;
      if (!latestPrediction.lastCheck || (now - latestPrediction.lastCheck) >= interval) {
        latestPrediction.lastCheck = now;
        await runBackgroundPrediction();
      }
    } catch (err) {
      console.error('Activity monitor tick error:', err);
    }
  }, 3000);
}

// ── Window Management ──────────────────────────────────────────────────────

function createWindows() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // 1. Avatar companion window (bottom-right)
  const windowWidth = 360;
  const windowHeight = 520;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: screenWidth - windowWidth - 20,
    y: screenHeight - windowHeight - 20,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setIgnoreMouseEvents(false);

  // Force always on top across all workspaces and apps
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('blur', () => {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  mainWindow.on('restore', () => {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  // 2. Fullscreen transparent highlight overlay window
  overlayWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: primaryDisplay.bounds.width,
    height: primaryDisplay.bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  startActivityMonitor();
}

app.whenReady().then(() => {
  createWindows();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindows();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.on('minimize-window', () => {
  mainWindow?.minimize();
});

ipcMain.on('close-window', () => {
  overlayWindow?.close();
  mainWindow?.close();
});

ipcMain.on('set-draggable', (_event, draggable) => {
  mainWindow?.setIgnoreMouseEvents(!draggable, { forward: true });
});

// Highlighting
ipcMain.on('show-highlight', (_event, rect) => {
  if (!overlayWindow || !rect) return;
  const primaryDisplay = screen.getPrimaryDisplay();
  const screenW = primaryDisplay.bounds.width;
  const screenH = primaryDisplay.bounds.height;

  // Convert percentage coordinates if needed
  let x = rect.x;
  let y = rect.y;
  let width = rect.width;
  let height = rect.height;

  if (rect.x_pct !== undefined) {
    x = Math.round((rect.x_pct / 100) * screenW);
    y = Math.round((rect.y_pct / 100) * screenH);
    width = Math.round(((rect.w_pct || 8) / 100) * screenW);
    height = Math.round(((rect.h_pct || 4) / 100) * screenH);
  }

  overlayWindow.webContents.send('highlight', {
    rect: { x, y, width, height, label: rect.label }
  });
});

ipcMain.on('hide-highlight', () => {
  overlayWindow?.webContents.send('hide-highlight');
});

// Screen capture for renderer
ipcMain.handle('capture-screen', async () => {
  const frame = await captureScreenFrame(1280, 720);
  return frame ? frame.dataUrl : null;
});

// Prediction buffer
ipcMain.handle('get-latest-prediction', () => {
  return latestPrediction;
});

ipcMain.handle('set-latest-prediction', (_event, pred) => {
  latestPrediction = {
    ...latestPrediction,
    ...pred,
    timestamp: Date.now()
  };
  return latestPrediction;
});

// Memory Bank
ipcMain.handle('get-memory', () => {
  return getMemoryData();
});

ipcMain.handle('save-memory', (_event, data) => {
  return saveMemoryData(data);
});
