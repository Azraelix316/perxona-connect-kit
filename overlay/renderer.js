/**
 * NavGuide Desktop Companion — Renderer Process
 * 
 * • Drives the Perxona <sv-presenter> Web Component
 * • Provides instant proactive prediction on avatar click
 * • Voice-first input via Web Speech API + text drawer fallback
 * • Triggers screen-wide click-through visual highlights
 * • Compact memory bank sync
 */

const BACKEND_URL = 'http://localhost:8083';
const MAX_HISTORY = 16;

// State
let presenter = null;
let config = null;
let history = [];
let audioUnlocked = false;
let recognition = null;
let bubbleTimer = null;
let interactionCount = 0;

// DOM Elements
const avatarStage = document.getElementById('avatar-stage');
const presenterEl = document.getElementById('presenter');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const toastEl = document.getElementById('toast');
const speechBubble = document.getElementById('speech-bubble');
const bubbleRole = document.getElementById('bubble-role');
const bubbleText = document.getElementById('bubble-text');
const micBtn = document.getElementById('mic-btn');
const textToggleBtn = document.getElementById('text-toggle-btn');
const textDrawer = document.getElementById('text-drawer');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');

// Window Controls
document.getElementById('minimize-btn')?.addEventListener('click', () => {
  window.electronAPI?.minimizeWindow();
});

document.getElementById('close-btn')?.addEventListener('click', () => {
  window.electronAPI?.closeWindow();
});

// Helper for API calls
async function apiRequest(path, body) {
  const url = path.startsWith('http') ? path : `${BACKEND_URL}${path}`;
  const options = body
    ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    : { method: 'GET' };

  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.details || data.detail || data.error || res.statusText;
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data;
}

function showToast(message, duration = 2500) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  setTimeout(() => {
    toastEl.classList.remove('visible');
  }, duration);
}

function showBubble(role, text, autoHide = 8000) {
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleRole.textContent = role;
  bubbleRole.style.color = role === 'You' ? '#94a1b2' : '#7c9cf5';
  bubbleText.textContent = text;
  speechBubble.classList.add('visible');

  if (autoHide > 0) {
    bubbleTimer = setTimeout(() => {
      speechBubble.classList.remove('visible');
    }, autoHide);
  }
}

function hideBubble() {
  speechBubble.classList.remove('visible');
}

// ── Perxona Presenter Bootstrap ────────────────────────────────────────────

async function loadPresenterSDK(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load presenter engine: ${url}`));
    document.head.append(script);
  });
}

async function initializePresenter() {
  try {
    config = await apiRequest('/api/config');
    if (!config.fixedTarget) {
      throw new Error('No avatar configured on backend.');
    }

    await loadPresenterSDK(config.presenterUrl);
    const { connect_key } = await apiRequest('/api/connect-key');

    presenter = presenterEl;

    presenter.addEventListener('PRESENTER_STATUS', (event) => {
      if (event.detail?.status === 'Ready') {
        loadingEl.hidden = true;
        showToast('NavGuide Ready');
        showBubble('NavGuide', "I'm ready! Click me anytime for instant screen help.", 5000);
      }
    });

    presenter.addEventListener('CONNECT_KEY_REJECTED', () => {
      loadingEl.hidden = true;
      errorEl.textContent = 'Connect Key Refused. Check backend credentials.';
      errorEl.hidden = false;
    });

    // Initialize with target
    await presenter.initializeWithConnectKey(connect_key, {
      avatarId: config.fixedTarget.avatarId,
      sceneId: config.fixedTarget.sceneId,
      voiceId: config.fixedTarget.voiceId
    });

  } catch (err) {
    console.error('Initialization error:', err);
    loadingEl.hidden = true;
    errorEl.textContent = `Error: ${err.message}`;
    errorEl.hidden = false;
  }
}

async function unlockAudio() {
  if (!audioUnlocked && presenter) {
    try {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    } catch (e) {
      console.warn('Audio unlock warning:', e);
    }
  }
}

// ── Proactive Click Summoning & Multimodal Conversation ───────────────────

async function handleAvatarClick() {
  await unlockAudio();

  try {
    const predData = await window.electronAPI?.getLatestPrediction?.();
    const predictionText = predData?.prediction;

    if (predictionText) {
      showBubble('NavGuide', predictionText);
      history.push({ role: 'assistant', content: predictionText });

      if (presenter && presenter.present) {
        presenter.setThinking?.(false);
        await presenter.present(predictionText);
      }
    } else {
      // If no cached prediction, run a fresh conversation query
      await sendUserMessage("Can you see what I'm doing and guide me?");
    }
  } catch (err) {
    console.error('Avatar click error:', err);
    showToast('Checking screen...');
  }
}

async function sendUserMessage(text) {
  if (!text || !text.trim()) return;
  const userText = text.trim();

  await unlockAudio();
  showBubble('You', userText, 4000);
  history.push({ role: 'user', content: userText });

  if (presenter) {
    presenter.setThinking?.(true);
  }
  showToast('Analyzing screen...');

  try {
    // 1. Capture fresh screenshot
    const screenshot = await window.electronAPI?.captureScreen?.();
    // 2. Fetch memory profile
    const memory = await window.electronAPI?.getMemory?.();
    // 3. Fetch latest prediction context
    const predData = await window.electronAPI?.getLatestPrediction?.();

    // 4. Send to Vision Chat endpoint
    const response = await apiRequest('/api/vision-chat', {
      messages: history.slice(-MAX_HISTORY),
      screenshot_base64: screenshot,
      prediction: predData?.prediction,
      memoryProfile: memory?.profile
    });

    if (presenter) {
      presenter.setThinking?.(false);
    }

    const replySpeech = response.speech || "I see your screen. How can I help you proceed?";
    showBubble('NavGuide', replySpeech);
    history.push({ role: 'assistant', content: replySpeech });

    // Speak response
    if (presenter) {
      const res = await presenter.present(replySpeech);
      if (res && !res.success) {
        console.warn('Present speech warning:', res);
      }
    }

    // Trigger visual highlight if target provided
    if (response.highlight) {
      window.electronAPI?.showHighlight?.(response.highlight);
      setTimeout(() => {
        window.electronAPI?.hideHighlight?.();
      }, 8000);
    } else {
      window.electronAPI?.hideHighlight?.();
    }

    // Memory compaction every 3 interactions
    interactionCount++;
    if (interactionCount % 3 === 0) {
      compressUserMemory(userText, replySpeech);
    }

  } catch (err) {
    if (presenter) presenter.setThinking?.(false);
    console.error('Vision chat error:', err);
    showBubble('NavGuide', `Sorry, I ran into an issue: ${err.message}`);
  }
}

async function compressUserMemory(userText, assistantText) {
  try {
    const memory = await window.electronAPI?.getMemory?.();
    const recent = memory?.recentInteractions || [];
    recent.push(`User: ${userText} | Guide: ${assistantText}`);

    const res = await apiRequest('/api/compress-memory', {
      currentProfile: memory?.profile,
      recentInteractions: recent.slice(-4)
    });

    if (res?.profile) {
      await window.electronAPI?.saveMemory?.({
        ...memory,
        profile: res.profile,
        sessionCount: (memory.sessionCount || 0) + 1,
        recentInteractions: recent.slice(-4)
      });
      console.log('Memory bank compacted:', res.profile);
    }
  } catch (e) {
    console.warn('Memory compression warning:', e);
  }
}

// ── Voice Input (Web Speech API) ──────────────────────────────────────────

function setupSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    micBtn.disabled = true;
    micBtn.title = 'Speech recognition not supported in this environment';
    return;
  }

  recognition = new SpeechRec();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  let isRecording = false;

  recognition.onstart = () => {
    isRecording = true;
    micBtn.classList.add('listening');
    showToast('Listening...');
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    if (transcript) {
      sendUserMessage(transcript);
    }
  };

  recognition.onerror = (event) => {
    isRecording = false;
    micBtn.classList.remove('listening');
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      showToast(`Voice error: ${event.error}`);
    }
  };

  recognition.onend = () => {
    isRecording = false;
    micBtn.classList.remove('listening');
  };

  // Toggle click or hold
  micBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (isRecording) {
      recognition.stop();
    } else {
      unlockAudio();
      recognition.start();
    }
  });
}

// ── UI Setup ──────────────────────────────────────────────────────────────

function setupUI() {
  // Avatar click handler for instant prediction
  avatarStage.addEventListener('click', handleAvatarClick);

  // Text drawer toggle
  textToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    textDrawer.classList.toggle('visible');
    if (textDrawer.classList.contains('visible')) {
      textInput.focus();
    }
  });

  // Text submit
  sendBtn.addEventListener('click', () => {
    const text = textInput.value;
    textInput.value = '';
    textDrawer.classList.remove('visible');
    sendUserMessage(text);
  });

  textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const text = textInput.value;
      textInput.value = '';
      textDrawer.classList.remove('visible');
      sendUserMessage(text);
    }
  });
}

// Start
document.addEventListener('DOMContentLoaded', async () => {
  setupUI();
  setupSpeechRecognition();
  await initializePresenter();
});
