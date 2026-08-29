const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Allow audio to play without user gesture requirement in Electron
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

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

async function captureScreenFrame() {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const scaleFactor = primaryDisplay.scaleFactor || 1.0;
    const physW = Math.round(primaryDisplay.bounds.width * scaleFactor);
    const physH = Math.round(primaryDisplay.bounds.height * scaleFactor);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: physW, height: physH }
    });
    if (sources && sources.length > 0) {
      const img = sources[0].thumbnail;
      const jpegBase64 = img.toJPEG(85).toString('base64');
      return {
        dataUrl: `data:image/jpeg;base64,${jpegBase64}`,
        buffer: img.toBitmap(),
        width: physW,
        height: physH,
        scaleFactor
      };
    }
  } catch (err) {
    console.error('Screen capture error:', err);
  }
  return null;
}

// ── Pure Local Pixel Color Change Detection (Zero API Tokens Used) ─────────

let lastPredictionCallTime = 0;
let predictionPausedUntil = 0;
let isPredictionPendingResolution = false;
const MIN_PREDICTION_COOLDOWN_MS = 10000; // Minimum 10 seconds between API prediction calls

// Pure local pixel color diff check: compares RGB values
function calculatePixelColorDiff(newBuffer, oldBuffer) {
  if (!oldBuffer || !newBuffer) return 1.0; // 100% change on first capture
  if (newBuffer.length !== oldBuffer.length) return 1.0;

  let changedPixels = 0;
  const sampleStep = 16; // Sample every 4th pixel (each pixel is 4 bytes RGBA)
  const totalSamples = Math.floor(newBuffer.length / sampleStep);

  for (let i = 0; i < newBuffer.length; i += sampleStep) {
    const rDiff = Math.abs(newBuffer[i] - oldBuffer[i]);
    const gDiff = Math.abs(newBuffer[i + 1] - oldBuffer[i + 1]);
    const bDiff = Math.abs(newBuffer[i + 2] - oldBuffer[i + 2]);
    // Significant color difference per pixel (RGB delta > 60)
    if (rDiff + gDiff + bDiff > 60) {
      changedPixels++;
    }
  }
  return changedPixels / totalSamples;
}

// Proactive screen prediction runner — ONLY called when a large visual screen change occurs AND previous is resolved
async function checkAndRunPrediction() {
  if (isPredicting) return;
  if (isPredictionPendingResolution) return; // Do NOT send another prediction until previous is accepted/denied
  if (Date.now() < predictionPausedUntil) return; // User dismissed prediction, pause for period

  try {
    const frame = await captureScreenFrame(1280, 720);
    if (!frame) return;

    const diffRatio = calculatePixelColorDiff(frame.buffer, lastCapturedBuffer);

    // Only update stored buffer if there was some change
    if (diffRatio > 0.05) {
      lastCapturedBuffer = frame.buffer;
    }

    // Require >25% large screen change AND cooldown passed
    const now = Date.now();
    const isLargeChange = diffRatio >= 0.25;
    const cooldownPassed = (now - lastPredictionCallTime) >= MIN_PREDICTION_COOLDOWN_MS;

    if (!isLargeChange || !cooldownPassed) {
      // Screen didn't change enough, zero API tokens used!
      return;
    }

    isPredicting = true;
    lastPredictionCallTime = now;
    console.log(`[Local Screen Diff] Large change detected (${(diffRatio * 100).toFixed(1)}% pixels changed). Calling Gemini 3.5 Flash Lite...`);

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
      isPredictionPendingResolution = true; // Lock until user accepts or denies
      console.log('[Gemini 3.5 Flash Lite] Prediction ready (locked until user accepts/denies):', latestPrediction.prediction);
      mainWindow?.webContents.send('proactive-prediction', latestPrediction);
    }
  } catch (err) {
    // Backend may not be ready or LLM_API_KEY not configured
    // Fail silently in background loop
  } finally {
    isPredicting = false;
  }
}

// Activity monitor loop (checks screen pixels every 4 seconds)
function startActivityMonitor() {
  setInterval(async () => {
    try {
      const currentPos = screen.getCursorScreenPoint();
      const mouseMoved = Math.abs(currentPos.x - lastCursorPos.x) > 5 || Math.abs(currentPos.y - lastCursorPos.y) > 5;
      lastCursorPos = currentPos;

      if (mouseMoved) {
        lastActivityTime = Date.now();
      }

      // Check pixel diff (local calculation only)
      await checkAndRunPrediction();
    } catch (err) {
      console.error('Activity monitor tick error:', err);
    }
  }, 4000);
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
    x: screenWidth - windowWidth - 24,
    y: screenHeight - windowHeight - 24,
    transparent: false,
    backgroundColor: '#090c11',
    frame: false,
    alwaysOnTop: true,
    hasShadow: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setIgnoreMouseEvents(false);

  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[Renderer] ${message}`);
  });

  // Force always on top across all workspaces and apps
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('blur', () => {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  mainWindow.on('restore', () => {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  // 2. Fullscreen transparent highlight overlay window (hidden by default to prevent DWM alpha occlusion)
  overlayWindow = new BrowserWindow({
    x: primaryDisplay.bounds.x,
    y: primaryDisplay.bounds.y,
    width: primaryDisplay.bounds.width,
    height: primaryDisplay.bounds.height,
    transparent: true,
    frame: false,
    show: false,
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

  overlayWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[Overlay Window] ${message}`);
  });

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

// Universal coordinate normalizer: Auto-detects normalized (0-1), percent (0-100), 1000-grid, 10000-grid (Gemini standard), or direct pixel values
function normalizeCoordinate(val, maxScreenDimension, fallback = 0) {
  if (val === undefined || val === null) return fallback;
  const num = parseFloat(String(val).replace('%', '').replace('px', ''));
  if (isNaN(num)) return fallback;

  if (num <= 1.0) {
    // 0.0 to 1.0 (normalized unit vector)
    return Math.round(num * maxScreenDimension);
  } else if (num <= 100.0) {
    // 0 to 100 percentage
    return Math.round((num / 100) * maxScreenDimension);
  } else if (num <= 1000.0) {
    // 0 to 1000 normalized grid
    return Math.round((num / 1000) * maxScreenDimension);
  } else if (num <= 10000.0) {
    // 0 to 10000 normalized grid (Gemini bounding box convention, e.g. 5804 -> 58.04%)
    return Math.round((num / 10000) * maxScreenDimension);
  } else {
    // Direct pixels (clamped to screen size)
    return Math.min(Math.round(num), maxScreenDimension);
  }
}

// Highlighting
ipcMain.on('show-highlight', (_event, rect) => {
  if (!overlayWindow || !rect) return;
  const primaryDisplay = screen.getPrimaryDisplay();
  const screenW = primaryDisplay.bounds.width;
  const screenH = primaryDisplay.bounds.height;

  let x = 0, y = 0, width = 120, height = 36;

  // 1. Native Gemini 2D visual grounding box: [ymin, xmin, ymax, xmax] on 0-1000 scale
  if (Array.isArray(rect.box_2d) && rect.box_2d.length === 4) {
    const [ymin, xmin, ymax, xmax] = rect.box_2d.map(Number);
    x = Math.round((xmin / 1000) * screenW);
    y = Math.round((ymin / 1000) * screenH);
    width = Math.round(((xmax - xmin) / 1000) * screenW);
    height = Math.round(((ymax - ymin) / 1000) * screenH);
  } else {
    const rawX = rect.x !== undefined ? rect.x : rect.x_pct;
    const rawY = rect.y !== undefined ? rect.y : rect.y_pct;
    const rawW = rect.width !== undefined ? rect.width : (rect.w_pct !== undefined ? rect.w_pct : 8);
    const rawH = rect.height !== undefined ? rect.height : (rect.h_pct !== undefined ? rect.h_pct : 4);

    x = normalizeCoordinate(rawX, screenW, 0);
    y = normalizeCoordinate(rawY, screenH, 0);
    width = Math.max(normalizeCoordinate(rawW, screenW, 120), 60);
    height = Math.max(normalizeCoordinate(rawH, screenH, 36), 24);
  }

  // Ensure minimum visible size and padding
  width = Math.max(width, 70);
  height = Math.max(height, 28);

  console.log(`[Pixel-Perfect Highlight] Mapped to (${x}px, ${y}px, ${width}x${height}px) on ${screenW}x${screenH} viewport | Label: "${rect.label || 'Target'}"`);

  // Ensure overlayWindow matches current primary display geometry
  overlayWindow.setBounds({
    x: primaryDisplay.bounds.x,
    y: primaryDisplay.bounds.y,
    width: screenW,
    height: screenH
  });

  // Show overlay window and raise z-order
  overlayWindow.showInactive();
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 999);
  overlayWindow.webContents.send('highlight', {
    rect: { x, y, width, height, label: rect.label }
  });

  // Keep avatar above the overlay
  mainWindow?.setAlwaysOnTop(true, 'screen-saver', 1000);
  mainWindow?.moveTop();
});

ipcMain.on('hide-highlight', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('hide-highlight');
    overlayWindow.hide();
  }
});

ipcMain.on('pause-predictions', (_event, durationMs = 90000) => {
  isPredictionPendingResolution = false;
  predictionPausedUntil = Date.now() + (durationMs || 90000);
  console.log(`[Predictions] Denied/Paused for ${Math.round((durationMs || 90000) / 1000)}s`);
});

ipcMain.on('resolve-prediction', (_event, action) => {
  isPredictionPendingResolution = false;
  console.log(`[Predictions] Prediction resolved (${action || 'accepted'}). Ready for next screen change.`);
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
