/**
 * Perxona Connect Kit — frontend
 *
 * Catalog selection, presenter initialization, performance playback, and an
 * optional LLM chat panel. The server authenticates with its own Connect
 * credentials (see .env) — there is no browser login step.
 * Zero dependencies — plain ESM, no build step required.
 */

// ── Presenter engine bootstrap ───────────────────────────────────────────────

/**
 * Load the presenter engine <script> for the URL the server resolved from
 * PRESENTER_URL (GET /api/config → presenterUrl). This replaces server-side
 * HTML templating (index.html has no %PRESENTER_URL% placeholder to fill) so
 * the same static build can target any CDN just by changing the env var.
 * @returns {Promise<void>} resolves once the presenter engine module has loaded
 */
async function loadPresenterEngine() {
  const { presenterUrl } = await fetch("/api/config").then((r) => r.json());
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = presenterUrl;
    script.onload = resolve;
    script.onerror = () =>
      reject(new Error(`Failed to load presenter engine from ${presenterUrl}`));
    document.head.append(script);
  });
}

// Block the rest of this module until the presenter engine is loaded, so
// <sv-presenter> is upgraded before any code below can call its methods.
await loadPresenterEngine();

// ── DOM refs ───────────────────────────────────────────────────────────────

const avatarSelect = document.getElementById("avatar-select");
const sceneSelect = document.getElementById("scene-select");
const voiceSelect = document.getElementById("voice-select");
const avatarIcon = document.getElementById("avatar-icon");
const sceneIcon = document.getElementById("scene-icon");
const initBtn = document.getElementById("init-btn");
const statusMsg = document.getElementById("status-msg");
const stagePlaceholder = document.getElementById("stage-placeholder");

// Performance controls
const perfControls = document.getElementById("perf-controls");
const sayForm = document.getElementById("say-form");
const sayInput = document.getElementById("say-input");
const stopBtn = document.getElementById("stop-btn");

// Chat panel (opt-in)
const chatPanel = document.getElementById("chat-panel");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");
const chatHint = document.getElementById("chat-hint");

/** In-memory conversation history (OpenAI message format), reset on reload. */
const chatHistory = [];

/**
 * AvatarConfig captured from /api/profile at launch. speak() reuses it to
 * hand-build a fallback Performance in the browser (see buildPerformance) when
 * the /api/presentation call fails.
 * @type {object | null}
 */
let avatarConfig = null;

/**
 * The voice_id selected at launch. The TTS token is minted for this voice, so
 * the same id is reused when refreshing an expired token.
 * @type {string | null}
 */
let selectedVoiceId = null;

/** @type {HTMLElement & import('./types').IPresentationWidget} */
const presenter = document.querySelector("sv-presenter");

// ── API helper ─────────────────────────────────────────────────────────────

/**
 * Thin fetch wrapper. Accepts a plain-object body (auto-serialised to JSON).
 * Throws on non-2xx with { message, status, data } attached.
 * @param {string} path
 * @param {{ method?: string, body?: object }} [opts]
 * @returns {Promise<any>}
 */
async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message =
      (Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail) ??
      data.error ??
      res.statusText;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return res.json();
}

// ── Catalog ────────────────────────────────────────────────────────────────

// Full catalog items (id, name, thumbnail_urls, …) keyed by list, so change
// handlers can look up thumbnail_urls without a second network round-trip.
// fillSelect() only needs { id, name } for <option>s — native <select> can't
// render images inline, so the preview <img> beside each select is updated
// separately via updateAssetIcon().
let avatars = [];
let scenes = [];

function fillSelect(select, items) {
  select.replaceChildren(
    ...items.map(({ id, name }) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      return opt;
    }),
  );
}

/**
 * Show the thumbnail for the selected item (looked up by id in `items`), or
 * hide the <img> when there's no matching thumbnail_urls entry. A broken/expired
 * CDN URL falls back to hidden via onerror rather than showing a broken-image icon.
 * @param {HTMLImageElement} img
 * @param {Array<{ id: string, thumbnail_urls?: Record<string, string> }>} items
 * @param {string} id
 * @param {string} thumbnailKey  e.g. 'head' for avatars, 'default' for scenes
 */
function updateAssetIcon(img, items, id, thumbnailKey) {
  const url = items.find((item) => item.id === id)?.thumbnail_urls?.[
    thumbnailKey
  ];
  if (!url) {
    img.hidden = true;
    img.removeAttribute("src");
    return;
  }
  img.onerror = () => {
    img.hidden = true;
  };
  img.src = url;
  img.hidden = false;
}

function updateInitBtn() {
  initBtn.disabled = !avatarSelect.value || !sceneSelect.value;
}

avatarSelect.addEventListener("change", () => {
  updateInitBtn();
  updateAssetIcon(avatarIcon, avatars, avatarSelect.value, "head");
});
sceneSelect.addEventListener("change", () => {
  updateInitBtn();
  updateAssetIcon(sceneIcon, scenes, sceneSelect.value, "default");
});

async function loadCatalog() {
  setStatus("Loading catalog…");
  try {
    const [{ items: avatarList }, { items: sceneList }, { items: voiceList }] =
      await Promise.all([
        request("/api/avatars"),
        request("/api/scenes"),
        request("/api/voices"),
      ]);
    avatars = avatarList;
    scenes = sceneList;
    fillSelect(avatarSelect, avatarList);
    fillSelect(sceneSelect, sceneList);
    fillSelect(voiceSelect, voiceList);
    updateInitBtn();
    updateAssetIcon(avatarIcon, avatars, avatarSelect.value, "head");
    updateAssetIcon(sceneIcon, scenes, sceneSelect.value, "default");
    setStatus("");
  } catch (err) {
    const hint =
      err.status === 401 || err.status === 403
        ? " — check the server's PERXONA_CONNECT_EMAIL/PASSWORD in .env"
        : "";
    setStatus(`Catalog error: ${err.message}${hint}`);
  }
}

// ── Presenter events ───────────────────────────────────────────────────────

const STATUS_LABEL = {
  Uninitialized: "",
  Initializing: "Initializing…",
  Ready: "✓ Ready",
};

presenter.addEventListener("PRESENTER_STATUS", (e) => {
  const { status } = e.detail;
  setStatus(STATUS_LABEL[status] ?? status);
  if (status === "Ready") {
    stagePlaceholder.hidden = true;
    presenter.hidden = false;
    perfControls.hidden = false;
  }
});

presenter.addEventListener("SPEECH_TOKEN_EXPIRED", async () => {
  try {
    const { speech_token } = await request("/api/tts-token", {
      method: "POST",
      body: { voice_id: selectedVoiceId },
    });
    presenter.refreshSpeechToken(speech_token);
  } catch {
    console.error("[connect-kit] Failed to refresh speech token");
  }
});

// ── Initialize presenter ───────────────────────────────────────────────────

initBtn.addEventListener("click", async () => {
  const avatarId = avatarSelect.value;
  const sceneId = sceneSelect.value;

  initBtn.disabled = true;
  setStatus("Fetching config…");

  // The TTS token is minted for the selected voice; remember it so the
  // SPEECH_TOKEN_EXPIRED handler can refresh the token for the same voice.
  selectedVoiceId = voiceSelect.value || null;

  try {
    // resumeAudioPlayback must be called from a direct user gesture to unlock
    // the browser's autoplay policy before the presenter starts audio. It
    // returns a Promise that resolves once the audio context has resumed.
    await presenter.resumeAudioPlayback?.();

    const [{ avatar, scene }, { speech_token }] = await Promise.all([
      request(
        `/api/profile?avatar=${encodeURIComponent(
          avatarId,
        )}&scene=${encodeURIComponent(sceneId)}`,
      ),
      request("/api/tts-token", {
        method: "POST",
        body: { voice_id: selectedVoiceId },
      }),
    ]);

    setStatus("Initializing…");
    // Keep the avatar config so speak() can build a Performance client-side as a
    // fallback when /api/presentation fails.
    avatarConfig = avatar;
    presenter.initialize(avatar, scene, speech_token);
    // Status label is then driven by PRESENTER_STATUS events above.
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    initBtn.disabled = false;
  }
});

// ── Performance ────────────────────────────────────────────────────────────
//
// All three entry points (preset buttons, the free-text box, and chat) drive
// the presenter through speak(): ask the backend to build the Performance
// (POST /api/presentation), which is where real apps add SSML, motion timing,
// and voice selection. If that upstream call fails, speak() falls back to a
// client-built, TTS-only Performance (buildPerformance → playLine) so the
// avatar still speaks the line.

/** Escape a string for safe interpolation into SSML/XML text. */
function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Hand-build a TTS-only Performance from a line of text. The avatar speaks the
 * message with no motions and clean SSML (no bookmarks) — the minimal payload
 * the presenter needs. voiceName is taken from the avatar's lip-sync config so
 * it's a voice the avatar is actually tuned for.
 * @param {string} message
 * @returns {{ motions: [], message: string, ssml: string, voiceName: string }}
 */
function buildPerformance(message) {
  const voiceName =
    Object.keys(avatarConfig?.lipsyncConfig ?? {})[0] ?? "en-US-AriaNeural";
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
    `<voice name="${voiceName}">${escapeXml(message)}</voice></speak>`;
  return { motions: [], message, ssml, voiceName };
}

/**
 * Surface a presenter PresentationResult. playPerformance returns a
 * PresentationResult (not void): when `success` is false, `code` and `message`
 * explain why the request was rejected (e.g. presenter not ready, audio context
 * unavailable) so the UI can react instead of silently dropping the line.
 * @param {{ success: boolean, code: string, message?: string }} result
 */
function reportPlaybackResult(result) {
  if (!result?.success) {
    setStatus(`Playback failed (${result?.code}): ${result?.message ?? ""}`);
  }
}

/** Play a line of text using a client-built Performance. */
function playLine(text) {
  const message = text.trim();
  if (!message || !avatarConfig) return;
  const result = presenter.playPerformance(buildPerformance(message), {
    strategy: "enqueueToPlay",
  });
  reportPlaybackResult(result);
}

/**
 * Turn a line of text into a presenter performance: ask the backend to build
 * the Performance payload, then enqueue it for playback. If the presentation
 * endpoint fails for any reason, fall back to a client-built, TTS-only
 * Performance (line only, no motions) so the avatar still speaks.
 * @param {string} message
 */
async function speak(message) {
  const text = message.trim();
  if (!text) return;
  try {
    const presentation = await request("/api/presentation", {
      method: "POST",
      body: {
        avatar_id: avatarConfig?.id,
        voice_id: selectedVoiceId,
        message: text,
      },
    });
    const result = presenter.playPerformance(presentation, {
      strategy: "enqueueToPlay",
    });
    reportPlaybackResult(result);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      // The server's Connect credentials are missing or rejected upstream —
      // a setup problem, not a transient presentation failure. Surface it
      // instead of silently falling back to a client-built performance.
      setStatus(
        `Auth error: ${err.message} — check the server's PERXONA_CONNECT_EMAIL/PASSWORD in .env`,
      );
      return;
    }
    console.warn(
      "[connect-kit] /api/presentation failed — speaking line only (no motions)",
      err.message,
    );
    playLine(text);
  }
}

// Preset buttons and the free-text box ask the backend to build the Performance
// (POST /api/presentation → speak), falling back to a client-built, TTS-only
// Performance only if that upstream call fails.
perfControls.querySelectorAll(".btn-preset").forEach((btn) => {
  btn.addEventListener("click", () => speak(btn.dataset.text));
});

sayForm.addEventListener("submit", (e) => {
  e.preventDefault();
  speak(sayInput.value);
  sayInput.value = "";
});

// Stop: clear the queue and interrupt the current performance immediately.
stopBtn.addEventListener("click", () => {
  presenter.interruptPerformance();
});

// ── Chat (opt-in) ──────────────────────────────────────────────────────────

/** Read the static chat flag from /api/config, then reveal panel or hint. */
async function updateChatPanel() {
  try {
    const { chat } = await request("/api/config");
    chatPanel.hidden = !chat;
    chatHint.hidden = Boolean(chat);
  } catch {
    chatHint.hidden = false;
  }
}

function appendChat(role, content) {
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  el.textContent = content;
  chatLog.append(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";

  appendChat("user", text);
  chatHistory.push({ role: "user", content: text });

  try {
    const completion = await request("/api/chat", {
      method: "POST",
      body: { messages: chatHistory },
    });
    const reply = completion.choices?.[0]?.message?.content ?? "";
    if (reply) {
      appendChat("assistant", reply);
      chatHistory.push({ role: "assistant", content: reply });
      speak(reply);
    }
  } catch (err) {
    appendChat("assistant", `⚠️ ${err.message}`);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function setStatus(text) {
  statusMsg.textContent = text;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
// No login step: the server already authenticated with its own Connect
// credentials (see .env), so the catalog can load as soon as the presenter
// engine is ready.
await loadCatalog();
await updateChatPanel();
