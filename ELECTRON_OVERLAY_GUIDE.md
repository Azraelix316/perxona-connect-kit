# Building a Transparent Overlay Desktop App with Perxona Connect

This guide explains how to build a **transparent, floating avatar assistant** that overlays on any desktop
application (like Google Maps, browsers, etc.) using the Perxona Connect Kit. The avatar accepts speech
and text input, responds via LLM, and performs gestures.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│           Your Electron/Tauri Desktop App               │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Transparent Window with <sv-presenter>           │  │
│  │  • Avatar only (no scene/background)              │  │
│  │  • Speech input (Web Speech API)                  │  │
│  │  • Text input box                                 │  │
│  │  • Always-on-top overlay                          │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          ↓ HTTP
┌─────────────────────────────────────────────────────────┐
│     Express Backend (samples/express/)                  │
│     Running on http://localhost:8083                    │
│  ┌──────────────────────────────────────────────────┐   │
│  │  GET  /api/config                                │   │
│  │  GET  /api/connect-key                           │   │
│  │  POST /api/chatbots/{id}/chat                    │   │
│  │  GET  /api/v1/connect/assets/avatars             │   │
│  │  GET  /api/v1/connect/assets/scenes              │   │
│  │  GET  /api/v1/connect/voices                     │   │
│  │  GET  /api/v1/connect/assets/avatars/{id}/motions│  │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│        Perxona Connect API (console.perxona.ai)         │
│        • Avatar/Scene/Voice catalog                     │
│        • Presentation generation                        │
│        • TTS token minting                              │
│        • Chatbot conversations                          │
└─────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### 1. Backend Server (Already Running)

You should already have the Express server running from `samples/express/`:

```bash
# In samples/express/ directory
npm start
```

This runs on `http://localhost:8083` and provides:
- `/api/config` - Configuration (avatarId, sceneId, voiceId, chatbotId)
- `/api/connect-key` - Publishable Connect key
- `/api/chatbots/{id}/chat` - Chat with LLM-powered chatbot
- All catalog endpoints (avatars, scenes, voices, motions)

**Required Environment Variables** (already configured in `samples/express/.env`):
```bash
PERXONA_API_BASE_URL=https://console.perxona.ai/asia
PERXONA_CONNECT_SECRET_KEY=pxc_01M15R9P0BYJ4089ENE3AC3V61_tJ15m54Zz5pnNJd-txXuDxr1qWFDAlKvf-Qw7YArjgY
PERXONA_CONNECT_PUBLISHABLE_KEY=pxc_01M15RCSPNC6EFQZ3JBC3BGR5E_wHkdlsiF7th82ElH8vzmPXnBz4ebd8CzH7E60n87e2s
PORT=8083
PRESENTER_URL=https://cdn.perxona.ai/asia/prod/latest/widget/entry/presenter.js
```

**⚠️ IMPORTANT**: Never put the SECRET key in your Electron app. Only the backend uses it.

### 2. Create a Chatbot (If Not Already Done)

Visit `http://localhost:8083/demos/studio/` and create a chatbot with:
- Name: "Desktop Assistant"
- Custom instructions: "You are a helpful desktop assistant. Keep responses concise."
- (Optional) Knowledge file for specific domain knowledge

---

## Building the Electron App

### Step 1: Project Setup

Create a new directory for your Electron app (separate from the backend):

```bash
mkdir perxona-desktop-avatar
cd perxona-desktop-avatar
npm init -y
```

Install dependencies:

```bash
npm install electron
```

### Step 2: Project Structure

```
perxona-desktop-avatar/
├── package.json
├── main.js              (Electron main process)
├── preload.js           (Secure bridge between main/renderer)
├── renderer.js          (Avatar UI logic)
├── index.html           (Transparent window HTML)
└── styles.css           (Styling for overlay)
```

### Step 3: package.json Configuration

```json
{
  "name": "perxona-desktop-avatar",
  "version": "1.0.0",
  "description": "Transparent desktop avatar overlay",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  },
  "dependencies": {
    "electron": "^28.0.0"
  }
}
```

### Step 4: main.js (Electron Main Process)

```javascript
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    transparent: true,        // Transparent background
    frame: false,             // No window chrome
    alwaysOnTop: true,        // Float above all apps
    hasShadow: false,         // No shadow
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  
  // Enable dragging the window
  mainWindow.setIgnoreMouseEvents(false);
  
  // Optional: Open DevTools for debugging
  // mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers for window controls
ipcMain.on('minimize-window', () => {
  mainWindow?.minimize();
});

ipcMain.on('close-window', () => {
  mainWindow?.close();
});

ipcMain.on('set-draggable', (event, draggable) => {
  mainWindow?.setIgnoreMouseEvents(!draggable, { forward: true });
});
```

### Step 5: preload.js (Security Bridge)

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  setDraggable: (draggable) => ipcRenderer.send('set-draggable', draggable)
});
```

### Step 6: index.html (Transparent Avatar UI)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Perxona Desktop Avatar</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <!-- Window Controls -->
  <div class="window-controls">
    <button id="minimize-btn" class="control-btn" title="Minimize">−</button>
    <button id="close-btn" class="control-btn" title="Close">×</button>
  </div>

  <!-- Avatar Container -->
  <div class="avatar-container">
    <sv-presenter id="presenter"></sv-presenter>
    <div id="loading" class="loading">Loading avatar...</div>
    <div id="error" class="error" hidden></div>
  </div>

  <!-- Input Controls -->
  <div class="input-container">
    <!-- Text Input -->
    <div class="text-input-group">
      <input 
        type="text" 
        id="text-input" 
        placeholder="Type or speak..."
        autocomplete="off"
      />
      <button id="send-btn" class="icon-btn" title="Send">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <!-- Speech Controls -->
    <div class="speech-controls">
      <button id="mic-btn" class="mic-btn" title="Hold to speak">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" stroke-width="2"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
      <span id="listening-indicator" class="listening-indicator" hidden>Listening...</span>
    </div>
  </div>

  <!-- Status Display -->
  <div id="status" class="status"></div>

  <script type="module" src="renderer.js"></script>
</body>
</html>
```

### Step 7: styles.css (Styling)

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: transparent;
  color: #333;
  overflow: hidden;
  -webkit-app-region: drag; /* Make window draggable */
}

button, input {
  -webkit-app-region: no-drag; /* Prevent drag on interactive elements */
}

/* Window Controls */
.window-controls {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  z-index: 1000;
}

.control-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(10px);
  color: #333;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.4);
}

#close-btn:hover {
  background: rgba(255, 59, 48, 0.8);
  color: white;
}

/* Avatar Container */
.avatar-container {
  position: relative;
  width: 400px;
  height: 500px;
  background: radial-gradient(circle at center, rgba(255,255,255,0.1) 0%, transparent 70%);
  border-radius: 20px;
  overflow: hidden;
}

sv-presenter {
  width: 100%;
  height: 100%;
  display: block;
}

.loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
  text-align: center;
  padding: 12px 24px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 8px;
  backdrop-filter: blur(10px);
}

.error {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #ff3b30;
  font-size: 13px;
  text-align: center;
  padding: 12px 24px;
  background: rgba(0, 0, 0, 0.8);
  border-radius: 8px;
  backdrop-filter: blur(10px);
  max-width: 300px;
}

/* Input Container */
.input-container {
  position: absolute;
  bottom: 16px;
  left: 16px;
  right: 16px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  border-radius: 12px;
  padding: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.text-input-group {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

#text-input {
  flex: 1;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 14px;
  outline: none;
  background: white;
}

#text-input:focus {
  border-color: #007AFF;
}

.icon-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: #007AFF;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.icon-btn:hover {
  background: #0051D5;
}

.icon-btn:active {
  transform: scale(0.95);
}

/* Speech Controls */
.speech-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mic-btn {
  width: 100%;
  height: 40px;
  border: 2px solid #007AFF;
  border-radius: 8px;
  background: white;
  color: #007AFF;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.mic-btn:hover {
  background: #007AFF;
  color: white;
}

.mic-btn.listening {
  background: #FF3B30;
  border-color: #FF3B30;
  color: white;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

.listening-indicator {
  font-size: 12px;
  color: #FF3B30;
  font-weight: 500;
}

/* Status Display */
.status {
  position: absolute;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(10px);
  color: white;
  font-size: 12px;
  border-radius: 8px;
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
}

.status.visible {
  opacity: 1;
}
```

### Step 8: renderer.js (Core Logic)

```javascript
/**
 * Perxona Desktop Avatar - Renderer Process
 * 
 * This script:
 * 1. Loads the Perxona presenter SDK
 * 2. Initializes the avatar with no background scene
 * 3. Handles speech input via Web Speech API
 * 4. Sends messages to the Express backend
 * 5. Makes the avatar speak responses
 */

const BACKEND_URL = 'http://localhost:8083';
const MAX_HISTORY = 20; // 10 user + 10 assistant turns

// State
let presenter = null;
let config = null;
let history = [];
let audioUnlocked = false;
let recognition = null;

// DOM Elements
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const listeningIndicator = document.getElementById('listening-indicator');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const statusEl = document.getElementById('status');
const presenterEl = document.getElementById('presenter');

// Window Controls
document.getElementById('minimize-btn')?.addEventListener('click', () => {
  window.electronAPI?.minimizeWindow();
});

document.getElementById('close-btn')?.addEventListener('click', () => {
  window.electronAPI?.closeWindow();
});

/**
 * Fetch helper with error handling
 */
async function request(path, body) {
  const url = path.startsWith('http') ? path : `${BACKEND_URL}${path}`;
  const options = body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  } : {};

  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  
  if (!res.ok) {
    const message = data.details || data.detail || data.error || res.statusText;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  
  return data;
}

/**
 * Show temporary status message
 */
function showStatus(message, duration = 3000) {
  statusEl.textContent = message;
  statusEl.classList.add('visible');
  setTimeout(() => {
    statusEl.classList.remove('visible');
  }, duration);
}

/**
 * Show error message
 */
function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  loadingEl.hidden = true;
  console.error('Avatar error:', message);
}

/**
 * Load Perxona presenter SDK dynamically
 */
async function loadPresenterSDK(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load presenter: ${url}`));
    document.head.append(script);
  });
}

/**
 * Initialize the avatar presenter
 */
async function initializePresenter() {
  try {
    // 1. Get config from backend
    config = await request('/api/config');
    
    if (!config.fixedTarget) {
      throw new Error('No avatar configured. Check backend startup logs.');
    }
    
    if (!config.chatbotId) {
      throw new Error('No chatbot found. Create one at http://localhost:8083/demos/studio/');
    }

    // 2. Load presenter SDK
    await loadPresenterSDK(config.presenterUrl);
    
    // 3. Get publishable Connect key
    const { connect_key } = await request('/api/connect-key');
    
    // 4. Initialize presenter WITHOUT scene (avatar only)
    presenter = presenterEl;
    
    // Listen for Ready status
    presenter.addEventListener('PRESENTER_STATUS', (event) => {
      if (event.detail?.status === 'Ready') {
        loadingEl.hidden = true;
        showStatus('Avatar ready!');
        console.log('Presenter ready:', event.detail);
      }
    });

    // Handle key rejection
    presenter.addEventListener('CONNECT_KEY_REJECTED', () => {
      showError('Connect key rejected. Check backend credentials.');
    });

    // Initialize with avatar and voice, but NO scene for transparency
    // If you want transparent background, use sceneId: null or omit it
    await presenter.initializeWithConnectKey(connect_key, {
      avatarId: config.fixedTarget.avatarId,
      sceneId: null, // null = no background scene (transparent)
      voiceId: config.fixedTarget.voiceId
    });

    console.log('Presenter initialized successfully');
    
  } catch (error) {
    showError(`Failed to initialize: ${error.message}`);
    throw error;
  }
}

/**
 * Send message to chatbot and get response
 */
async function sendMessage(text) {
  if (!text.trim() || !config?.chatbotId) return;

  try {
    // Add to history
    history.push({ role: 'user', text });
    
    // Unlock audio on first interaction
    if (!audioUnlocked) {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    }

    // Show thinking state
    presenter.setThinking?.(true);
    showStatus('Thinking...');

    // Send to backend
    const messages = history.slice(-MAX_HISTORY).map(({ role, text }) => ({
      role,
      parts: [{ type: 'text', text }]
    }));

    const response = await request(`/api/chatbots/${config.chatbotId}/chat`, { messages });
    
    if (!response.reply_text) {
      throw new Error('No response from chatbot');
    }

    // Add response to history
    history.push({ role: 'assistant', text: response.reply_text });
    
    // Make avatar speak
    presenter.setThinking?.(false);
    const result = await presenter.present(response.reply_text);
    
    if (!result?.success) {
      console.error('Present failed:', result?.code, result?.message);
      showStatus('Failed to speak response');
    }

  } catch (error) {
    presenter.setThinking?.(false);
    
    // Handle subscription errors gracefully
    if (error.data?.code === 1003 || error.data?.code === 14005) {
      showStatus('Subscription issue. Check console at console.perxona.ai', 5000);
    } else {
      showStatus(`Error: ${error.message}`, 5000);
    }
    
    // Remove failed user message from history
    if (history.at(-1)?.role === 'user') {
      history.pop();
    }
    
    console.error('Message error:', error);
  }
}

/**
 * Setup speech recognition (Web Speech API)
 */
function setupSpeechRecognition() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    console.warn('Speech recognition not supported');
    micBtn.disabled = true;
    micBtn.title = 'Speech recognition not supported';
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    micBtn.classList.add('listening');
    listeningIndicator.hidden = false;
    console.log('Speech recognition started');
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    console.log('Recognized:', transcript);
    textInput.value = transcript;
    sendMessage(transcript);
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    micBtn.classList.remove('listening');
    listeningIndicator.hidden = true;
    
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      showStatus(`Speech error: ${event.error}`, 3000);
    }
  };

  recognition.onend = () => {
    micBtn.classList.remove('listening');
    listeningIndicator.hidden = true;
  };

  // Hold to speak
  micBtn.addEventListener('mousedown', () => {
    recognition.start();
  });

  micBtn.addEventListener('mouseup', () => {
    recognition.stop();
  });

  // Also support click for toggle behavior
  micBtn.addEventListener('click', (e) => {
    e.preventDefault(); // Prevent double-trigger from mousedown
  });
}

/**
 * Setup text input
 */
function setupTextInput() {
  sendBtn.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (text) {
      sendMessage(text);
      textInput.value = '';
    }
  });

  textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = textInput.value.trim();
      if (text) {
        sendMessage(text);
        textInput.value = '';
      }
    }
  });
}

/**
 * Initialize everything
 */
async function init() {
  try {
    console.log('Initializing Perxona Desktop Avatar...');
    console.log('Backend URL:', BACKEND_URL);
    
    setupTextInput();
    setupSpeechRecognition();
    
    await initializePresenter();
    
    console.log('Initialization complete');
  } catch (error) {
    console.error('Initialization failed:', error);
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

---

## API Reference

### Backend Endpoints (localhost:8083)

All endpoints expect JSON requests and return JSON responses unless noted.

#### GET /api/config
Returns the current configuration for the avatar.

**Response:**
```json
{
  "presenterUrl": "https://cdn.perxona.ai/asia/prod/latest/widget/entry/presenter.js",
  "fixedTarget": {
    "avatarId": "01KVQ59VW18PC6P2HQET51NMYS",
    "sceneId": "01KWVBXE9Q9CZ9FENATQHZYXJV",
    "voiceId": "01M15N94Z9PV9T442N7JMS0WEH"
  },
  "chatbotId": "01KWVF2X3ABCDEF1234567890",
  "subscriptionUrl": "https://console.perxona.ai/asia/organization/subscription",
  "mock": false
}
```

#### GET /api/connect-key
Returns the publishable Connect API key for browser-side use.

**Response:**
```json
{
  "connect_key": "pxc_01M15RCSPNC6EFQZ3JBC3BGR5E_wHkdlsiF7th82ElH8vzmPXnBz4ebd8CzH7E60n87e2s"
}
```

**⚠️ Security**: This is the PUBLISHABLE key, safe for client-side use. Never expose the SECRET key.

#### POST /api/chatbots/{chatbotId}/chat
Send a message to the chatbot and get a response.

**Request:**
```json
{
  "messages": [
    {
      "role": "user",
      "parts": [{ "type": "text", "text": "What's the weather?" }]
    }
  ]
}
```

**Response:**
```json
{
  "id": "01KWX123456789ABCDEFGHIJK",
  "status": "succeeded",
  "reply_text": "I don't have access to live weather data, but I can help you find weather information online."
}
```

**Error Response (Subscription Issue):**
```json
{
  "code": 1003,
  "details": "credit_points exhausted for org_id: ..."
}
```

#### GET /api/v1/connect/assets/avatars
List all available avatars.

**Response:**
```json
{
  "items": [
    {
      "id": "01KVQ59VW18PC6P2HQET51NMYS",
      "name": "Avatar Name",
      "thumbnail_urls": {
        "default": "https://..."
      }
    }
  ]
}
```

#### GET /api/v1/connect/assets/avatars/{avatarId}/motions
List motions compatible with an avatar.

**Query Parameters:**
- `pose_tag` (optional): Filter by pose (e.g., `pose:standing`)
- `motion_ids` (optional): Array of specific motion IDs to retrieve
- `page` (optional): Page number (default: 1)
- `size` (optional): Page size (default: 50, max: 100)

**Response:**
```json
{
  "items": [
    {
      "motion_id": "01KRW97VSEA5G49W2YXWGV8JRV",
      "name": "Wave",
      "tags": ["greeting", "gesture", "pose:standing"],
      "lod_urls": {
        "lod0": "https://cdn.perxona.ai/...",
        "lod1": "https://cdn.perxona.ai/...",
        "lod2": "https://cdn.perxona.ai/..."
      },
      "thumbnail": "https://..."
    }
  ]
}
```

---

## Presenter SDK Reference

The `<sv-presenter>` web component is the core of the avatar system.

### Initialization

```javascript
const presenter = document.querySelector('sv-presenter');

// Initialize with Connect key
await presenter.initializeWithConnectKey(connectKey, {
  avatarId: 'avatar-id',
  sceneId: 'scene-id',  // or null for transparent background
  voiceId: 'voice-id'   // or null for BYO-TTS mode
});
```

### Core Methods

#### `present(text: string): Promise<PresentationResult>`
Synthesize speech and perform gestures for the given text.

```javascript
const result = await presenter.present("Hello! How can I help?");
console.log(result.success); // true/false
```

**Motion Markup**: Embed specific motions using `[MOTION motion_id:priority]`:
```javascript
await presenter.present("Look over there [MOTION 01KRW97VSEA5G49W2YXWGV8JRV:1] and tell me what you see.");
```

**Important**: If ANY motion markup is present, automatic motion selection is disabled for that entire message.

#### `playMotion(motionId: string): Promise<MotionResult>`
Play a single motion independently of speech.

```javascript
await presenter.playMotion('01KRW97VSEA5G49W2YXWGV8JRV');
```

#### `presentWithAudio(audioBuffer: ArrayBuffer, text: string): Promise<PresentationResult>`
Play pre-generated audio with transcript (BYO-TTS mode).

```javascript
const audioBuffer = await fetch('audio.mp3').then(r => r.arrayBuffer());
await presenter.presentWithAudio(audioBuffer, "This is the transcript");
```

#### `resumeAudioPlayback(): Promise<void>`
Unlock audio playback (required by browser autoplay policy).

**⚠️ Must be called from a user gesture** (click, keypress, etc.).

```javascript
document.getElementById('start-btn').addEventListener('click', async () => {
  await presenter.resumeAudioPlayback();
});
```

#### `interruptPresentation(): void`
Stop current performance and clear the queue.

```javascript
presenter.interruptPresentation();
```

#### `setThinking(thinking: boolean): void`
Show/hide thinking indicator (visual feedback).

```javascript
presenter.setThinking(true);  // Show thinking
// ... do work ...
presenter.setThinking(false); // Hide thinking
```

### Events

Listen for presenter events:

```javascript
presenter.addEventListener('PRESENTER_STATUS', (event) => {
  console.log('Status:', event.detail.status);
  // 'Uninitialized' → 'Initializing' → 'Ready'
});

presenter.addEventListener('CONNECT_KEY_REJECTED', () => {
  console.error('Connect key rejected');
});
```

---

## Advanced Features

### 1. No Background Scene (Transparent Avatar)

To render only the avatar without a background scene:

```javascript
await presenter.initializeWithConnectKey(connectKey, {
  avatarId: 'avatar-id',
  sceneId: null,  // ← null = no background
  voiceId: 'voice-id'
});
```

Set your Electron window to `transparent: true` and the avatar will float on a clear background.

### 2. Motion Insertion

Get motion IDs from the Motion Browser (`http://localhost:8083/demos/studio/`) or the API:

```javascript
// List motions for an avatar
const { items } = await fetch('http://localhost:8083/api/v1/connect/assets/avatars/AVATAR_ID/motions')
  .then(r => r.json());

// Find pointing motion
const pointingMotion = items.find(m => m.tags.includes('pointing'));

// Use in text
await presenter.present(`Look over there [MOTION ${pointingMotion.motion_id}:1]`);
```

### 3. Emotion & Intensity

When calling the presentation API directly (not via `presenter.present()`), you can guide motion selection:

```javascript
const response = await fetch('http://localhost:8083/api/v1/connect/presentation', {
  method: 'POST',
  headers: {
    'X-Connect-Key': 'YOUR_SECRET_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    avatar_id: 'avatar-id',
    voice_id: 'voice-id',
    message: 'This is amazing!',
    emotion: 'excitement',
    intensity: 'high'
  })
});
```

**Valid emotions**: `joy`, `excitement`, `admiration`, `caring`, `gratitude`, `sadness`, `disappointment`, `annoyance`, `embarrassment`, `curiosity`, `surprise`, `realization`, `confusion`

**Valid intensities**: `low`, `neutral`, `high`

### 4. Speech Recognition (Web Speech API)

Already implemented in `renderer.js`, but you can customize:

```javascript
const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
recognition.continuous = true;  // Keep listening
recognition.interimResults = true;  // Get partial results
recognition.lang = 'en-US';  // Language

recognition.onresult = (event) => {
  const last = event.results.length - 1;
  const text = event.results[last][0].transcript;
  console.log('Recognized:', text);
};

recognition.start();
```

**Browser Support**: Chrome, Edge, Safari (webkit prefix)

### 5. Custom Window Shapes

Electron supports custom window shapes with `frame: false`:

```javascript
// Rounded window
mainWindow = new BrowserWindow({
  transparent: true,
  frame: false,
  hasShadow: false,
  webPreferences: { ... }
});

// Then use CSS border-radius in your HTML
```

### 6. Click-Through Regions

Make parts of the window click-through (for overlay mode):

```javascript
// In main.js
mainWindow.setIgnoreMouseEvents(true, { forward: true });

// Re-enable for interactive areas
ipcMain.on('set-clickable-region', (event, bounds) => {
  mainWindow.setIgnoreMouseEvents(false);
});
```

---

## Troubleshooting

### Avatar doesn't appear

**Check:**
1. Backend is running: `http://localhost:8083/api/config` should return data
2. Browser console for errors (Electron DevTools: `mainWindow.webContents.openDevTools()`)
3. `PRESENTER_STATUS` event reaches `Ready` state
4. `sceneId` is set to `null` for transparent background

**Common causes:**
- Secret key has expired or is revoked
- Backend not running
- Network firewall blocking CDN (cdn.perxona.ai)

### Speech recognition doesn't work

**Check:**
1. Microphone permissions granted
2. Using Chromium-based browser/Electron (required for Web Speech API)
3. Console for `Speech recognition not supported` warning

**Workaround**: Use text input instead of speech.

### Audio doesn't play

**Cause**: Browser autoplay policy requires user interaction.

**Fix**: Call `resumeAudioPlayback()` from a click handler:

```javascript
document.getElementById('start-btn').addEventListener('click', async () => {
  await presenter.resumeAudioPlayback();
});
```

### Chatbot returns error 1003 or 14005

**Cause**: Organization credits exhausted or subscription inactive.

**Fix**: 
1. Visit `https://console.perxona.ai/asia/organization/subscription`
2. Top up credits or upgrade plan

### Window not draggable

**Check**: CSS has `-webkit-app-region: drag` on body, and `-webkit-app-region: no-drag` on buttons/inputs.

### Transparent background shows black/white

**Electron**: Ensure `transparent: true` and `backgroundColor` is NOT set in BrowserWindow options.

**CSS**: Use `background: transparent` or `rgba()` colors, not solid colors.

---

## Best Practices

### 1. Security

- **Never expose the SECRET key** in Electron app code
- Use backend proxy for all sensitive operations
- Validate all user input before sending to backend
- Set `contextIsolation: true` and `nodeIntegration: false` in Electron

### 2. Performance

- Limit conversation history to 20 turns (backend does this automatically)
- Use `interruptPresentation()` to cancel long speeches when user interrupts
- Preload commonly used motions at startup
- Use motion markup sparingly (automatic selection is optimized)

### 3. User Experience

- Always show visual feedback for speech recognition (listening indicator)
- Provide both text and speech input options (accessibility)
- Handle network errors gracefully with user-friendly messages
- Show avatar "thinking" state during LLM processing

### 4. Motion Usage

- Preview motions in Studio demo before using in production
- Tag motions in your database for easy lookup
- Use `pose_tag` filtering to get contextually appropriate motions
- Test motion timing with different speech lengths

---

## Deployment

### Building for Distribution

```bash
npm install --save-dev electron-builder
```

Add to `package.json`:

```json
{
  "build": {
    "appId": "com.yourcompany.perxona-avatar",
    "productName": "Perxona Avatar",
    "directories": {
      "output": "dist"
    },
    "files": [
      "main.js",
      "preload.js",
      "renderer.js",
      "index.html",
      "styles.css"
    ],
    "win": {
      "target": "nsis"
    },
    "mac": {
      "target": "dmg"
    },
    "linux": {
      "target": "AppImage"
    }
  },
  "scripts": {
    "build": "electron-builder"
  }
}
```

Build:

```bash
npm run build
```

### Packaging Backend

For production, you'll need to either:

1. **Bundle backend with Electron**: Package Express server using `pkg` or similar
2. **Run backend separately**: Require users to run backend server manually
3. **Cloud backend**: Deploy Express server to cloud and point Electron app to it

**Recommended**: Option 3 (cloud backend) for easier updates and centralized API key management.

---

## Next Steps

### Enhancements to Consider

1. **Hotkeys**: Global keyboard shortcuts to show/hide avatar
2. **Screen detection**: Auto-position avatar based on active window
3. **Context awareness**: Detect active app and provide relevant assistance
4. **Voice wake word**: "Hey Avatar" to trigger listening
5. **Multi-monitor support**: Remember position per monitor
6. **Custom scenes**: Upload custom background scenes
7. **Plugin system**: Allow extensions for different app integrations
8. **Offline mode**: Cache responses for common questions
9. **Analytics**: Track usage patterns (with user consent)
10. **Auto-updates**: Electron auto-updater for seamless updates

---

## Resources

### Official Documentation
- Perxona Console: `https://console.perxona.ai/asia`
- Presenter SDK Types: `node_modules/@perxona/presenter-types/`
- Backend API Spec: `samples/express/docs/openapi.yaml`

### Tools
- Motion Browser: `http://localhost:8083` (tools/motion-browser)
- Studio Demo: `http://localhost:8083/demos/studio/`
- Embed Demo: `http://localhost:8083/demos/embed/`

### Community
- GitHub Issues: Report bugs and feature requests
- Discord: Join community discussions (check Perxona website)

---

## Complete File Checklist

Your project should have these files:

```
perxona-desktop-avatar/
├── package.json         ✓ Dependencies and scripts
├── main.js              ✓ Electron main process
├── preload.js           ✓ IPC bridge
├── renderer.js          ✓ Avatar logic
├── index.html           ✓ UI structure
└── styles.css           ✓ Styling
```

Backend (already running):
```
samples/express/
├── .env                 ✓ API keys (DO NOT COMMIT)
├── server.mjs           ✓ Express server
└── package.json         ✓ Dependencies
```

---

## Quick Reference

### Start Backend
```bash
cd samples/express
npm start
```

### Start Electron App
```bash
cd perxona-desktop-avatar
npm start
```

### Test Avatar
1. Backend should show: `✓ reachable` for CDN and API
2. Electron window opens with transparent avatar
3. Click mic button and speak, or type message
4. Avatar should respond with speech and gestures

### Common Commands
```bash
# Backend health check
curl http://localhost:8083/api/health

# Get avatar config
curl http://localhost:8083/api/config

# List avatars
curl http://localhost:8083/api/v1/connect/assets/avatars

# List motions for avatar
curl http://localhost:8083/api/v1/connect/assets/avatars/AVATAR_ID/motions
```

---

**That's everything you need to build a transparent desktop avatar overlay!** The backend handles all Perxona API complexity, and your Electron app just focuses on UI and speech input. Keep the backend running, and build your overlay app in a separate directory following this guide.
