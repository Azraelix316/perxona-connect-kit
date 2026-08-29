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
let isWindowExpanded = false;

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

// Proactive screen prediction runner — keeps updating predictions in circle mode until user expands
async function checkAndRunPrediction() {
  if (isPredicting) return;
  if (isWindowExpanded) return; // Never trigger random background predictions during an active avatar session!
  if (Date.now() < predictionPausedUntil) return; // User dismissed prediction, pause for period

  try {
    const frame = await captureScreenFrame();
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
      if (data?.prediction && data.prediction !== 'null' && data.hasMeaningfulTask !== false) {
        latestPrediction = {
          ...data,
          timestamp: Date.now()
        };
        if (isWindowExpanded) {
          isPredictionPendingResolution = true; // Lock only if in expanded view
        }
        console.log('[Gemini 3.5 Flash Lite] Proactive prediction:', latestPrediction.prediction);
        mainWindow?.webContents.send('proactive-prediction', latestPrediction);
      } else {
        console.log('[Gemini 3.5 Flash Lite] Screen is idle/trivial. Skipping prediction.');
      }
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
      // Check mouse activity
      const currentMousePos = screen.getCursorScreenPoint();
      const mouseMoved = currentMousePos.x !== lastCursorPos.x || currentMousePos.y !== lastCursorPos.y;
      lastCursorPos = currentMousePos;

      if (mouseMoved) {
        lastActivityTime = Date.now();
      }

      // Auto-dismiss active highlight after 25s timeout
      if (currentHighlight && (Date.now() - currentHighlight.displayedAt > 25000)) {
        console.log('[Highlight Auto-Timeout] 25s elapsed -> auto-dismissing highlight.');
        currentHighlight = null;
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('hide-highlight');
          overlayWindow.hide();
        }
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

  // 1. Avatar companion window (Starts in Collapsed Circle Mode bottom-right)
  const windowWidth = 380;
  const windowHeight = 260;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: screenWidth - windowWidth - 16,
    y: screenHeight - windowHeight - 16,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
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

ipcMain.on('set-window-mode', (_event, mode) => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  if (mode === 'expanded') {
    isWindowExpanded = true;
    const w = 360;
    const h = 540;
    mainWindow?.setBounds({
      x: screenWidth - w - 24,
      y: screenHeight - h - 24,
      width: w,
      height: h
    });
  } else {
    // Collapsed circle mode
    isWindowExpanded = false;
    isPredictionPendingResolution = false;
    const w = 380;
    const h = 260;
    mainWindow?.setBounds({
      x: screenWidth - w - 16,
      y: screenHeight - h - 16,
      width: w,
      height: h
    });
  }
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

// Universal bounding box extractor & coordinate converter
function extractBoundingBox(rect, screenW, screenH) {
  if (!rect) return null;

  let box = null;
  let label = rect.label || 'Target';

  // 1. Direct array or nested box properties
  if (Array.isArray(rect) && rect.length === 4) {
    box = rect;
  } else if (Array.isArray(rect.box_2d) && rect.box_2d.length === 4) {
    box = rect.box_2d;
  } else if (Array.isArray(rect.box) && rect.box.length === 4) {
    box = rect.box;
  } else if (Array.isArray(rect.box2d) && rect.box2d.length === 4) {
    box = rect.box2d;
  } else if (Array.isArray(rect.coordinates) && rect.coordinates.length === 4) {
    box = rect.coordinates;
  } else if (Array.isArray(rect.bounding_box) && rect.bounding_box.length === 4) {
    box = rect.bounding_box;
  } else if (rect.ymin !== undefined && rect.xmin !== undefined && rect.ymax !== undefined && rect.xmax !== undefined) {
    box = [rect.ymin, rect.xmin, rect.ymax, rect.xmax];
  }

  if (box) {
    const [ymin, xmin, ymax, xmax] = box.map(Number);
    // Auto-detect 0-1 normalized scale vs 0-1000 scale vs 0-10000 scale
    const maxVal = Math.max(ymin, xmin, ymax, xmax);
    const scale = maxVal <= 1.0 ? 1.0 : (maxVal <= 100.0 ? 100.0 : 1000.0);

    const x = Math.round((xmin / scale) * screenW);
    const y = Math.round((ymin / scale) * screenH);
    const width = Math.max(Math.round(((xmax - xmin) / scale) * screenW), 60);
    const height = Math.max(Math.round(((ymax - ymin) / scale) * screenH), 28);
    return { x, y, width, height, label };
  }

  // 2. Direct x, y, width, height
  const rawX = rect.x !== undefined ? rect.x : rect.x_pct;
  const rawY = rect.y !== undefined ? rect.y : rect.y_pct;
  const rawW = rect.width !== undefined ? rect.width : (rect.w_pct !== undefined ? rect.w_pct : null);
  const rawH = rect.height !== undefined ? rect.height : (rect.h_pct !== undefined ? rect.h_pct : null);

  if (rawX !== undefined && rawY !== undefined) {
    const x = normalizeCoordinate(rawX, screenW, 0);
    const y = normalizeCoordinate(rawY, screenH, 0);
    const width = Math.max(normalizeCoordinate(rawW, screenW, 120), 60);
    const height = Math.max(normalizeCoordinate(rawH, screenH, 36), 28);
    return { x, y, width, height, label };
  }

  return null;
}

let currentHighlight = null;

// Highlighting
ipcMain.on('show-highlight', (_event, rect) => {
  if (!overlayWindow || !rect) return;
  const primaryDisplay = screen.getPrimaryDisplay();
  const screenW = primaryDisplay.bounds.width;
  const screenH = primaryDisplay.bounds.height;

  const parsed = extractBoundingBox(rect, screenW, screenH);
  if (!parsed) {
    console.warn('[Highlight Warning] Received unparseable highlight payload:', rect);
    return;
  }

  let { x, y, width, height, label } = parsed;

  // Snug precision buffer (4px horizontal, 3px vertical)
  const BUFFER_X = 4;
  const BUFFER_Y = 3;
  x = Math.max(0, x - BUFFER_X);
  y = Math.max(0, y - BUFFER_Y);
  width = width + (BUFFER_X * 2);
  height = height + (BUFFER_Y * 2);

  currentHighlight = { x, y, width, height, displayedAt: Date.now() };

  console.log(`[Pixel-Perfect Highlight] Mapped to (${x}px, ${y}px, ${width}x${height}px) on ${screenW}x${screenH} viewport | Label: "${label}"`);

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
    rect: { x, y, width, height, label }
  });

  // Keep avatar above the overlay
  mainWindow?.setAlwaysOnTop(true, 'screen-saver', 1000);
  mainWindow?.moveTop();
});

ipcMain.on('hide-highlight', () => {
  currentHighlight = null;
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
