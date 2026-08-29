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

const quickActionsEl = document.getElementById('quick-actions');

function showBubble(role, text, autoHide = 8000, actions = []) {
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleRole.textContent = role;
  bubbleRole.style.color = role === 'You' ? '#94a1b2' : '#7c9cf5';
  bubbleText.textContent = text;

  if (quickActionsEl) {
    quickActionsEl.innerHTML = '';
    if (actions && actions.length > 0) {
      actions.forEach(({ label, action, secondary }) => {
        const btn = document.createElement('button');
        btn.className = `quick-btn ${secondary ? 'secondary' : ''}`;
        btn.textContent = label;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          action();
        });
        quickActionsEl.appendChild(btn);
      });
      quickActionsEl.hidden = false;
    } else {
      quickActionsEl.hidden = true;
    }
  }

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

    // Initialize presenter with valid avatar, scene, and voice
    await presenter.initializeWithConnectKey(connect_key, {
      avatarId: config.fixedTarget.avatarId,
      sceneId: config.fixedTarget.sceneId,
      voiceId: config.fixedTarget.voiceId
    });

    // Load motions for body animations
    await loadAvatarMotions(config.fixedTarget.avatarId);

  } catch (err) {
    console.error('Initialization error:', err);
    loadingEl.hidden = true;
    errorEl.textContent = `Error: ${err.message}`;
    errorEl.hidden = false;
  }
}

// Motions cache for animated body reactions
let availableMotions = [];

async function loadAvatarMotions(avatarId) {
  try {
    const data = await apiRequest(`/api/avatars/${avatarId}/motions`);
    availableMotions = data?.items || [];
    console.log('Loaded avatar motions:', availableMotions.map(m => m.name));
  } catch (e) {
    console.warn('Failed to load avatar motions:', e);
  }
}

function getRandomTalkingMotion() {
  const talking = availableMotions.filter(m => m.tags?.some(t => t.includes('talking')));
  if (talking.length > 0) {
    const idx = Math.floor(Math.random() * talking.length);
    return talking[idx].motion_id;
  }
  return availableMotions[0]?.motion_id || null;
}

async function unlockAudio() {
  if (presenter) {
    try {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    } catch (e) {
      console.warn('Audio unlock warning:', e);
    }
  }
}

async function speakWithAvatar(text) {
  if (!presenter || !text) return;
  console.log(`[Step: Audio] Unlocking audio context... Current state: ${audioUnlocked ? 'unlocked' : 'locking'}`);
  await unlockAudio();

  try {
    console.log(`[Step: Presenter Call] Invoking presenter.present("${text.slice(0, 60)}...")`);
    const result = await presenter.present(text);
    console.log(`[Step: Presenter Result] success=${result?.success}, code=${result?.code ?? 'OK'}, message=${result?.message || 'none'}`);

    if (!result?.success) {
      console.warn(`[Presenter Issue] code: ${result?.code}, details: ${result?.message}`);
      if (result?.code === 'AUDIO_CONTEXT_UNAVAILABLE') {
        console.log('[Step: Presenter Retry] Resuming audio playback and retrying present()...');
        await presenter.resumeAudioPlayback?.();
        const retryRes = await presenter.present(text);
        console.log(`[Step: Presenter Retry Result] success=${retryRes?.success}, code=${retryRes?.code}`);
      }
    }
  } catch (err) {
    if (!String(err).toLowerCase().includes('abort')) {
      console.error('[Step: Presenter Exception]', err);
    }
  }
}

const toConnectMessages = (turns) =>
  turns.map(({ role, text }) => ({ role, parts: [{ type: "text", text }] }));

// ── Proactive Click Summoning & Multimodal Conversation ───────────────────

let isBusy = false;

async function handleAvatarClick() {
  if (isBusy) return;
  isBusy = true;
  console.log('\n=== [Action: Avatar Clicked] ===');

  try {
    await unlockAudio();
    showToast('Observing screen...');

    // 1. Capture screen and analyze with Gemini Vision
    console.log('[Step 1] Capturing desktop screen...');
    const screenshot = await window.electronAPI?.captureScreen?.();
    const memory = await window.electronAPI?.getMemory?.();

    console.log('[Step 2] Sending screen capture to Gemini 3.5 Flash Lite (/api/predict)...');
    let analysis = await apiRequest('/api/predict', {
      screenshot_base64: screenshot,
      memoryProfile: memory?.profile || ''
    }).catch(() => null);

    const screenDesc = analysis?.screenContext || analysis?.prediction || "the user's current screen";
    const highlightTarget = analysis?.highlight;
    console.log(`[Step 3] Gemini Vision output: "${screenDesc}"`);

    // 2. Compile prompt for Perxona Chatbot including Gemini's visual intelligence
    const promptForPerxona = `[Visual Screen Context: ${screenDesc}. Prediction: ${analysis?.prediction || ''}] Greet the user in 1 concise sentence and offer specific guidance for this screen.`;
    history.push({ role: 'user', text: promptForPerxona });

    // 3. Request reply from Perxona Chatbot
    console.log('[Step 4] Calling Perxona Chatbot API (/api/chatbots/:id/chat)...');
    const chatbotRes = await apiRequest(`/api/chatbots/${config.chatbotId}/chat`, {
      messages: toConnectMessages(history.slice(-MAX_HISTORY))
    });

    const replyText = chatbotRes?.reply_text || analysis?.prediction || "I'm watching your screen! Need help with anything here?";
    console.log(`[Step 5] Perxona Chatbot reply: "${replyText}"`);
    history.push({ role: 'assistant', text: replyText });

    // 4. Present interactive quick buttons
    const actions = [
      {
        label: '💡 Help Me With This',
        action: () => sendUserMessage('Please guide me step by step on what to do on this screen.')
      },
      {
        label: '📍 Point Out Target',
        action: () => sendUserMessage('Please point out where to click on this screen.', highlightTarget)
      },
      {
        label: '❌ Not Now',
        secondary: true,
        action: () => {
          window.electronAPI?.hideHighlight?.();
          window.electronAPI?.pausePredictions?.(90000);
          hideBubble();
          speakWithAvatar("Got it! I'll give you space and won't interrupt.");
        }
      }
    ];

    console.log('[Step 6] Rendering speech bubble in UI...');
    showBubble('NavGuide', replyText, 18000, actions);

    // 5. Avatar speaks with official Perxona voice & lip-sync motions
    console.log('[Step 7] Calling avatar speech synthesis...');
    await speakWithAvatar(replyText);

  } catch (err) {
    if (!String(err).toLowerCase().includes('abort')) {
      console.error('[Avatar Click Error]', err);
      showToast('Checking screen...');
    }
  } finally {
    isBusy = false;
  }
}

async function sendUserMessage(text, precomputedHighlight = null) {
  if (!text || !text.trim() || isBusy) return;
  isBusy = true;
  const userText = text.trim();
  console.log(`\n=== [Action: User Message: "${userText}"] ===`);

  try {
    window.electronAPI?.resolvePrediction?.('accepted');
    await unlockAudio();
    showBubble('You', userText, 4000);
    showToast('Analyzing screen...');

    // 1. Capture screen
    console.log('[Step 1] Capturing desktop frame...');
    const screenshot = await window.electronAPI?.captureScreen?.();
    const memory = await window.electronAPI?.getMemory?.();

    // 2. Vision analysis
    console.log('[Step 2] Querying Gemini Vision intelligence...');
    const analysis = await apiRequest('/api/predict', {
      screenshot_base64: screenshot,
      memoryProfile: memory?.profile || ''
    }).catch(() => null);

    const screenDesc = analysis?.screenContext || analysis?.prediction || "Current Screen";
    const highlightTarget = precomputedHighlight || analysis?.highlight;
    console.log(`[Step 3] Visual Context: "${screenDesc}"`);

    // 3. Compile message for Perxona Chatbot including Gemini visual context
    const compiledUserPrompt = `[Screen Vision Intelligence: ${screenDesc}] ${userText}`;
    history.push({ role: 'user', text: compiledUserPrompt });

    // 4. Send to Perxona Chatbot
    console.log('[Step 4] Requesting response from Perxona Chatbot...');
    const chatbotRes = await apiRequest(`/api/chatbots/${config.chatbotId}/chat`, {
      messages: toConnectMessages(history.slice(-MAX_HISTORY))
    });

    const replySpeech = chatbotRes?.reply_text || "I see your screen. Let me know what you'd like me to do!";
    console.log(`[Step 5] Perxona Chatbot reply: "${replySpeech}"`);

    // Return response on webpage speech bubble
    showBubble('NavGuide', replySpeech, 18000);
    history.push({ role: 'assistant', text: replySpeech });

    // 5. Trigger highlight overlay if user asked for guidance / click target
    const asksToPoint = /yes|show|point|where|click|help|button|link|tab|target/i.test(userText);
    if (highlightTarget && asksToPoint) {
      console.log('[Step 6] Triggering desktop highlight overlay at:', highlightTarget);
      window.electronAPI?.showHighlight?.(highlightTarget);
      setTimeout(() => {
        window.electronAPI?.hideHighlight?.();
      }, 8000);
    } else {
      window.electronAPI?.hideHighlight?.();
    }

    // 6. Speak Perxona response (voice + lip-sync + motion markup)
    console.log('[Step 7] Triggering avatar speech...');
    await speakWithAvatar(replySpeech);

    // 7. Memory compaction
    interactionCount++;
    if (interactionCount % 3 === 0) {
      compressUserMemory(userText, replySpeech);
    }

  } catch (err) {
    const msg = String(err?.message || err);
    if (!msg.toLowerCase().includes('abort')) {
      console.error('[Vision Chat Error]', err);
      showBubble('NavGuide', `Sorry, I ran into an issue: ${err.message}`);
    }
  } finally {
    isBusy = false;
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
    if (event.error === 'network') {
      showToast('Voice offline: use quick buttons or type below', 3500);
    } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
      showToast(`Voice: ${event.error}`, 2500);
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
  // Proactive background prediction display
  window.electronAPI?.onProactivePrediction?.(async (predData) => {
    console.log('[Proactive Prediction Received]', predData?.prediction);
    const predictionText = predData?.prediction || "Need guidance with your current screen?";
    const highlightTarget = predData?.highlight;

    const actions = [
      {
        label: '💡 Help Me With This',
        action: () => sendUserMessage('Please guide me step by step on what to do on this screen.')
      },
      {
        label: '📍 Point Out Target',
        action: () => sendUserMessage('Please point out where to click on this screen.', highlightTarget)
      },
      {
        label: '❌ Not Now',
        secondary: true,
        action: () => {
          window.electronAPI?.hideHighlight?.();
          window.electronAPI?.pausePredictions?.(90000);
          hideBubble();
        }
      }
    ];

    console.log('[Proactive Prediction] Displaying in speech bubble...');
    showBubble('NavGuide', predictionText, 25000, actions);
  });
}

// Start
document.addEventListener('DOMContentLoaded', async () => {
  setupUI();
  setupSpeechRecognition();
  await initializePresenter();
});
