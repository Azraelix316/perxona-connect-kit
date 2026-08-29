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
