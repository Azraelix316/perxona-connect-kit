/**
 * Perxona Connect Kit — Studio Demo
 *
 * The full client, for when you are building the application itself:
 *   1. Catalog pickers — browse avatars, scenes and voices
 *   2. Chatbot CRUD — create, read, update, delete via /api/chatbots proxy
 *   3. Multi-turn conversation, with interrupt and a send lock
 *   4. Each assistant reply is piped into sv-presenter for live speech playback
 *
 * A source switch chooses who runs the model — a Connect-hosted chatbot or your
 * own LLM_API_KEY — and can be flipped mid-conversation. That is why the history
 * is held provider-neutral as { role, text } and serialized only at the call
 * site: the Connect chat API takes a `parts` array,
 *   { role: "user"|"assistant", parts: [{ type: "text", text: "…" }] }
 * while /api/chat takes OpenAI's `content` string. See toConnectMessages /
 * toOpenAiMessages.
 *
 * Zero dependencies — plain ESM, no build step required.
 */

// ── Presenter engine bootstrap ───────────────────────────────────────────────

/**
 * Dynamically inject the presenter engine <script>. Resolved from the server's
 * PRESENTER_URL env var (GET /api/config → presenterUrl) so the same static
 * build can target any CDN by changing the env var alone.
 * @param {string} presenterUrl
 * @returns {Promise<void>}
 */
async function loadPresenterEngine(presenterUrl) {
  // DEMO-ONLY: presenterUrl is trusted without host validation. A production
  // integration should verify presenterUrl against a known CDN allowlist.
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

const appConfig = await request("/api/config");
const isPresenterLaunchDisabled = appConfig.mock;

// Loaded in the bootstrap at the end, not here: a rejection in top-level await
// would abort module evaluation and leave every handler below unregistered.
// Launch waits on this flag; everything else works without the engine.
let presenterEngineReady = false;

// ── DOM refs ───────────────────────────────────────────────────────────────

const avatarSelect = document.getElementById("avatar-select");
const sceneSelect = document.getElementById("scene-select");
const voiceSelect = document.getElementById("voice-select");
const avatarIcon = document.getElementById("avatar-icon");
const sceneIcon = document.getElementById("scene-icon");
const initBtn = document.getElementById("init-btn");
const statusMsg = document.getElementById("status-msg");
const stagePlaceholder = document.getElementById("stage-placeholder");

// Chatbot manager — custom bot picker (replaces native <select> to avoid
// Chrome's native-dropdown misposition bug inside scrolled overflow containers)
const botPickerBtn = document.getElementById("bot-picker-btn");
const botPickerLabel = document.getElementById("bot-picker-label");
const botPickerList = document.getElementById("bot-picker-list");
const botDeleteBtn = document.getElementById("bot-delete-btn");
const botEditor = document.getElementById("bot-editor");
const botEditorSummary = document.getElementById("bot-editor-summary");
const botNameInput = document.getElementById("bot-name");
const botInstructionsInput = document.getElementById("bot-instructions");
const botSaveBtn = document.getElementById("bot-save-btn");
const botCancelBtn = document.getElementById("bot-cancel-btn");
const botStatusMsg = document.getElementById("bot-status");
// Knowledge file
const botKnowledgeFileInput = document.getElementById("bot-knowledge-file");
const botKnowledgeFilename = document.getElementById("bot-knowledge-filename");
const botKnowledgeStatus = document.getElementById("bot-knowledge-status");
const botKnowledgeRemoveBtn = document.getElementById(
  "bot-knowledge-remove-btn",
);
// Function tools
const botToolsInput = document.getElementById("bot-tools");
const botToolsCount = document.getElementById("bot-tools-count");
const botToolsExampleBtn = document.getElementById("bot-tools-example-btn");
const botIdRow = document.getElementById("bot-id-row");
const botIdValue = document.getElementById("bot-id-value");
const botIdCopy = document.getElementById("bot-id-copy");
const botNewBtn = document.getElementById("bot-new-btn");

// Chat panel
const chatPlaceholder = document.getElementById("chat-placeholder");
const chatHintText = document.getElementById("chat-hint-text");
const chatContent = document.getElementById("chat-content");
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const chatStopBtn = document.getElementById("chat-stop-btn");

// Source switch
const sourceRadios = document.querySelectorAll('input[name="source"]');
const sourceOwnRadio = document.getElementById("source-own");
const sourceOwnHint = document.getElementById("source-own-hint");
const sourceLabel = document.getElementById("active-source-label");
const chatbotManager = document.getElementById("chatbot-manager");

// The one place this demo hand-writes motion markup, and the only kind of place
// that earns it: a specific action at a specific moment. Everything the chatbot
// replies with is sent as plain text, because the Connect API picks motions on
// its own — that is the normal case, not a fallback.
//
// Two things to know before copying this pattern:
//   1. A message containing ANY motion mark skips automatic motion selection for
//      the whole utterance. Markup is all-or-nothing per message, not a hint
//      layered on top of the automatic choice.
//   2. A motion id your Connect account cannot see is dropped, not rejected — the
//      line still speaks, it just carries no gesture. Combined with (1) that
//      means this greeting is silent-handed on any account but the one the id
//      came from. Replace it with an id from your own catalog; `tools/motion-browser`
//      composes these strings for you.
// The two ways the chat can be busy: a request is in flight, or a performance is
// open. Both are read by syncChatControls() and written nowhere but the two
// setters beside it — a third writer that knows only one of them is what this
// pair exists to prevent.
let isSpeaking = false;
let isAwaitingReply = false;

const GREETING =
  "Hi there! [MOTION 01KRW97VSEA5G49W2YXWGV8JRV:1] Ask me anything.";

// Prefilled so a new organization can reach a working avatar by pressing Save.
// Every reply is read aloud by present(), so the instructions ask for short
// sentences and no markdown — the two things that sound wrong through an avatar.
const NEW_BOT_DEFAULTS = {
  name: "Demo Assistant",
  instructions:
    "You are a friendly assistant speaking out loud through an avatar. " +
    "Keep replies to one or two short sentences, and never use markdown — " +
    "everything you say is read aloud.",
};

// Sent only on the own-LLM path. The Connect chatbot gets its persona from its
// own `custom_instructions` field instead, which is why there is no equivalent
// for that source — the difference in *where the persona lives* is part of what
// the switch is demonstrating.
const OWN_LLM_SYSTEM_PROMPT =
  "You are a helpful avatar assistant speaking out loud. Keep replies to one " +
  "or two short sentences. Never use markdown formatting.";

// Debug timeline panel
const debugPanel = document.getElementById("debug-panel");
const debugLog = document.getElementById("debug-log");
const debugClearBtn = document.getElementById("debug-clear-btn");

/** @type {HTMLElement & import('@perxona/presenter-types').IPresentationWidget} */
const presenter = document.querySelector("sv-presenter");

// ── App state ──────────────────────────────────────────────────────────────

/**
 * Conversation history in this app's own shape — `{ role, text }`, belonging to
 * neither API. Each source serializes it at the boundary (see
 * toConnectMessages / toOpenAiMessages), which is the whole difference between
 * them: same conversation, two wire formats.
 * @type {{ role: "user"|"assistant", text: string }[]}
 */
let chatHistory = [];

/**
 * Which model answers. `"connect"` posts to the selected Connect chatbot;
 * `"own"` posts to /api/chat, which forwards to whatever LLM_API_KEY points at.
 * @type {"connect" | "own"}
 */
let source = "connect";

/** Whether LLM_API_KEY is configured — /api/chat 501s without it. */
const ownLlmAvailable = Boolean(appConfig.chat);
/** ID of the currently selected chatbot, or null. */
let activeBotId = null;
/** Lightweight chatbot list from the last /api/chatbots call. */
let chatbotList = [];
/** Whether the presenter has reached Ready status. */
let presenterReady = false;
/** Catalog caches for thumbnail lookups. */
let avatars = [];
let scenes = [];

// ── API helper ─────────────────────────────────────────────────────────────

/**
 * Thin fetch wrapper for JSON APIs. Throws a structured error on non-2xx.
 * 204 No Content resolves to null.
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
  if (res.status === 204) return null;
  return res.json();
}

// ── Catalog ────────────────────────────────────────────────────────────────

/**
 * Fill a picker and preselect the first item, so Launch is one click away.
 * `emptyLabel` stays selectable — clearing the voice selects BYO-TTS.
 */
function fillSelect(select, items, emptyLabel) {
  select.replaceChildren(
    Object.assign(document.createElement("option"), {
      value: "",
      textContent: emptyLabel,
    }),
    ...items.map(({ id, name }) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      return opt;
    }),
  );
  select.value = items[0]?.id ?? "";
}

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
  initBtn.disabled =
    isPresenterLaunchDisabled ||
    !presenterEngineReady ||
    !avatarSelect.value ||
    !sceneSelect.value;
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
    fillSelect(avatarSelect, avatarList, "— select avatar —");
    fillSelect(sceneSelect, sceneList, "— select scene —");
    fillSelect(voiceSelect, voiceList, "— no voice —");
    updateInitBtn();
    updateAssetIcon(avatarIcon, avatars, avatarSelect.value, "head");
    updateAssetIcon(sceneIcon, scenes, sceneSelect.value, "default");
    if (isPresenterLaunchDisabled) {
      stagePlaceholder.querySelector("p").textContent =
        "Mock mode supports catalog browsing only.";
      setStatus("Configure live credentials to launch the presenter.");
    } else {
      setStatus("");
    }
  } catch (err) {
    // Catalog reads need only asset:read and voice:read, which every key type
    // carries — so a wrong key *type* is never why these three failed.
    const credentialHint =
      err.status === 401 || err.status === 403
        ? " — the server's Connect key was refused: revoked, expired, or restricted to allowed domains (a server sends no Origin, so any domain restriction refuses it)"
        : "";
    setStatus(`Catalog error: ${err.message}${credentialHint}`);
  }
}

// ── Presenter events ───────────────────────────────────────────────────────

const STATUS_LABELS = {
  Uninitialized: "",
  Initializing: "Initializing…",
  Ready: "✓ Ready",
};

presenter.addEventListener("PRESENTER_STATUS", (e) => {
  const { status } = e.detail;
  setStatus(STATUS_LABELS[status] ?? status);
  if (status === "Ready") {
    presenterReady = true;
    stagePlaceholder.hidden = true;
    presenter.hidden = false;
    debugPanel.hidden = false; // reveal the timeline once the avatar is live
    updateChatUI();
    // Same rule the submit handler applies: a line that never queued has no
    // ALL_PERFORMANCE_FINISHED coming, so nothing else will release the controls.
    // Without this a failed greeting leaves the reader pressing Stop to type.
    speak(GREETING).then((queued) => {
      if (!queued) setSpeaking(false);
    });
  }
});

// A refused key has no refresh to fall back on — it is revoked, expired, or
// was never granted the scope, and presenting it again fails identically. The
// call that triggered this already failed; the reader has to fix the key and
// launch again.
presenter.addEventListener("CONNECT_KEY_REJECTED", () => {
  setStatus(
    "Connect key rejected — revoked, expired, or missing a scope. Check PERXONA_CONNECT_PUBLISHABLE_KEY.",
  );
  updateInitBtn();
});

// ── Presenter lifecycle events (debug timeline) ──────────────────────────
//
// These events expose the internal state machine of sv-presenter so the demo
// can show exactly what happens after present() is called.

presenter.addEventListener("PERFORMANCE_STATE", (e) => {
  const { state } = e.detail;
  appendDebug("sdk", `Presenter state → ${state}`);
});

presenter.addEventListener("PERFORMANCE_START", () => {
  appendDebug("sdk", "Performance started");
});

presenter.addEventListener("PERFORMANCE_END", () => {
  appendDebug("sdk", "Performance segment ended");
});

presenter.addEventListener("ALL_PERFORMANCE_FINISHED", () => {
  appendDebug("ok", "All performances finished — avatar returned to idle ✓");
  setSpeaking(false);
});

presenter.addEventListener("PLAYING_SPEECH_TEXT", (e) => {
  const raw = e.detail?.text ?? "";
  const preview = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
  appendDebug("sdk", `Speaking: “${preview}”`);
});

// ── Initialize presenter ───────────────────────────────────────────────────

async function fetchConnectKey() {
  const { connect_key } = await request("/api/connect-key");
  return connect_key;
}

initBtn.addEventListener("click", async () => {
  if (isPresenterLaunchDisabled) {
    setStatus("Configure live credentials to launch the presenter.");
    return;
  }
  initBtn.disabled = true;
  setStatus("Fetching connect key…");
  try {
    // resumeAudioPlayback must be called from a direct user gesture to satisfy
    // browser autoplay policy before the presenter attempts audio playback.
    await presenter.resumeAudioPlayback?.();
    const connectKey = await fetchConnectKey();
    setStatus("Initializing…");
    await presenter.initializeWithConnectKey(connectKey, {
      avatarId: avatarSelect.value,
      sceneId: sceneSelect.value,
      voiceId: voiceSelect.value || undefined,
    });
    // Status label is then driven by PRESENTER_STATUS events above.
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    initBtn.disabled = false;
  }
});

// ── Speak helper ──────────────────────────────────────────────────────────

/**
 * Send text to the presenter for speech synthesis and playback. Silently
 * skips if the presenter is not yet ready (chat still works as text-only).
 * @param {string} text
 * @returns {Promise<boolean>} whether a performance was queued — the caller
 * needs this to know whether to expect ALL_PERFORMANCE_FINISHED at all.
 */
async function speak(text) {
  if (!presenterReady || !text.trim()) return false;
  appendDebug("cmd", "presenter.setThinking(false)");
  presenter.setThinking?.(false);
  appendDebug("cmd", "presenter.present() — queuing speech + motion");
  // Lock from the moment the request goes in rather than from PERFORMANCE_START.
  // present() can resolve queued and then never start playing, and a Stop button
  // that only lights up once speech begins would leave that window with no event
  // coming and no control to press.
  setSpeaking(true);
  try {
    const result = await presenter.present(text.trim());
    if (!result?.success) {
      setStatus(`Playback failed (${result?.code}): ${result?.message ?? ""}`);
      appendDebug(
        "err",
        `present() failed: ${result?.code} — ${result?.message ?? ""}`,
      );
      return false;
    }
    appendDebug("ok", "present() accepted — performance queued ✓");
    return true;
  } catch (err) {
    setStatus(`Playback error: ${err.message}`);
    appendDebug("err", `present() threw: ${err.message}`);
    return false;
  }
}

// ── Chatbot Manager ────────────────────────────────────────────────────────

// ── Custom bot picker (replaces native <select>) ───────────────────────────
// Reason: native <select> dropdowns misposition when opened inside a scrolled
// overflow-y: auto container (Chrome). A custom absolute-positioned list avoids
// the issue entirely.

function openBotPicker() {
  botPickerList.hidden = false;
  botPickerBtn.setAttribute("aria-expanded", "true");
}

function closeBotPicker() {
  botPickerList.hidden = true;
  botPickerBtn.setAttribute("aria-expanded", "false");
}

/**
 * Rebuild the picker's option list from the current chatbotList array.
 * @param {Array<{ id: string, name: string, status: string }>} bots
 */
function populateBotPicker(bots) {
  function makeOption(id, label) {
    const li = document.createElement("li");
    li.role = "option";
    li.dataset.botId = id ?? "";
    li.className = `bot-picker-option${id ? "" : " empty-option"}`;
    li.setAttribute("aria-selected", (id === activeBotId).toString());
    li.textContent = label;
    return li;
  }
  botPickerList.replaceChildren(
    makeOption(null, bots.length ? "— select a chatbot —" : "— none yet —"),
    ...bots.map(({ id, name, status }) =>
      makeOption(id, status === "disabled" ? `${name} (disabled)` : name),
    ),
  );
}

/**
 * Update activeBotId, the picker label, and all dependent UI.
 * Resets conversation history when the active bot changes.
 * @param {string|null} id
 */
function selectChatbot(id) {
  const newId = id || null;
  if (newId !== activeBotId) {
    activeBotId = newId;
    chatHistory = [];
    chatLog.replaceChildren();
  }
  const bot = chatbotList.find((b) => b.id === newId);
  botPickerLabel.textContent = bot
    ? bot.status === "disabled"
      ? `${bot.name} (disabled)`
      : bot.name
    : chatbotList.length
      ? "— select a chatbot —"
      : "— none yet —";
  // Sync aria-selected in the open list
  botPickerList.querySelectorAll(".bot-picker-option").forEach((li) => {
    li.setAttribute(
      "aria-selected",
      (li.dataset.botId === (newId ?? "")).toString(),
    );
  });
  botDeleteBtn.hidden = !activeBotId;
  if (activeBotId) {
    botIdValue.textContent = activeBotId;
    botIdRow.hidden = false;
  } else {
    botIdRow.hidden = true;
    botIdValue.textContent = "";
  }
  updateChatUI();
}

botPickerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  botPickerList.hidden ? openBotPicker() : closeBotPicker();
});

botPickerList.addEventListener("click", (e) => {
  e.stopPropagation();
  const option = e.target.closest(".bot-picker-option");
  if (!option) return;
  const id = option.dataset.botId || null;
  selectChatbot(id);
  closeBotPicker();
  botEditor.open = false;
  setBotStatus("");
});

// Close picker on any outside click or Escape key.
document.addEventListener("click", closeBotPicker);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeBotPicker();
});

/**
 * Fetch the chatbot list and refresh the picker.
 * Preserves the currently selected bot ID if it still exists after the refresh.
 */
async function loadChatbots() {
  try {
    const { items } = await request("/api/chatbots");
    chatbotList = items ?? [];
    populateBotPicker(chatbotList);
    // Restore previous selection, or clear if the bot was deleted.
    const previousId = activeBotId;
    if (previousId && chatbotList.some((b) => b.id === previousId)) {
      selectChatbot(previousId);
    } else {
      selectChatbot(null);
    }
    // A new organization has none; an empty picker on its own is a dead end.
    if (chatbotList.length === 0) {
      openNewBotForm(false);
      setBotStatus(
        "No chatbots yet — this form is filled in, just press Save.",
      );
    }
  } catch (err) {
    setBotStatus(`Failed to load chatbots: ${err.message}`);
  }
}

// Prefill editor when the <details> opens for an existing bot.
botEditor.addEventListener("toggle", async () => {
  if (!botEditor.open || !activeBotId) return;
  try {
    const detail = await request(`/api/chatbots/${activeBotId}`);
    botNameInput.value = detail.name ?? "";
    botInstructionsInput.value = detail.custom_instructions ?? "";
    // Show current knowledge status
    updateKnowledgeStatus(detail.knowledge ?? null);
    // Show tools count but leave textarea empty — the user only fills it
    // when they intend to replace tools (empty = leave unchanged per API semantics)
    const toolCount = detail.tools?.length ?? 0;
    botToolsCount.textContent =
      toolCount > 0
        ? `${toolCount} tool${toolCount === 1 ? "" : "s"} configured`
        : "";
    botToolsInput.value = "";
    // Reset file picker
    botKnowledgeFileInput.value = "";
    botKnowledgeFilename.textContent = "";
  } catch (err) {
    setBotStatus(`Failed to load chatbot details: ${err.message}`);
  }
});

/**
 * Open the create form, prefilled and ready to submit.
 * @param {boolean} focus false when opening unprompted — do not steal focus.
 */
function openNewBotForm(focus = true) {
  selectChatbot(null); // deselect any active bot
  botNameInput.value = NEW_BOT_DEFAULTS.name;
  botInstructionsInput.value = NEW_BOT_DEFAULTS.instructions;
  botToolsInput.value = "";
  botToolsCount.textContent = "";
  botKnowledgeFileInput.value = "";
  botKnowledgeFilename.textContent = "";
  updateKnowledgeStatus(null);
  botEditorSummary.textContent = "Create New Chatbot";
  botEditor.open = true;
  if (focus) botNameInput.focus();
}

botNewBtn.addEventListener("click", () => {
  openNewBotForm();
  setBotStatus("");
});

botCancelBtn.addEventListener("click", () => {
  botEditor.open = false;
  // Restore summary label to default
  botEditorSummary.textContent = "Create / Edit";
  setBotStatus("");
});

botSaveBtn.addEventListener("click", async () => {
  const name = botNameInput.value.trim();
  if (!name) {
    setBotStatus("Name is required.");
    return;
  }

  // Validate and parse tools JSON if the user provided any
  let tools = undefined; // undefined = "leave unchanged"
  const toolsRaw = botToolsInput.value.trim();
  if (toolsRaw) {
    try {
      tools = JSON.parse(toolsRaw);
      if (!Array.isArray(tools))
        throw new Error("Tools must be a JSON array — e.g. [] or [{...}].");
    } catch (parseErr) {
      setBotStatus(`Tools JSON error: ${parseErr.message}`);
      return;
    }
  }

  setBotStatus("Saving…");
  botSaveBtn.disabled = true;

  try {
    if (activeBotId) {
      // Update existing chatbot
      await request(`/api/chatbots/${activeBotId}`, {
        method: "PATCH",
        body: {
          name,
          custom_instructions: botInstructionsInput.value.trim() || null,
          tools,
        },
      });
      setBotStatus("Chatbot updated.");
    } else {
      // Create new chatbot
      const created = await request("/api/chatbots", {
        method: "POST",
        body: {
          name,
          custom_instructions: botInstructionsInput.value.trim() || null,
          tools,
        },
      });
      // Select the newly created bot right away
      activeBotId = created.id;
      setBotStatus("Chatbot created.");
    }

    // Upload knowledge file if the user selected one
    const knowledgeFile = botKnowledgeFileInput.files[0];
    if (knowledgeFile && activeBotId) {
      setBotStatus("Uploading knowledge file…");
      const base64 = await fileToBase64(knowledgeFile);
      const updated = await request(`/api/chatbots/${activeBotId}/knowledge`, {
        method: "POST",
        body: {
          filename: knowledgeFile.name,
          content_base64: base64,
          mime_type: knowledgeFile.type || "application/octet-stream",
        },
      });
      updateKnowledgeStatus(updated.knowledge ?? null);
      botKnowledgeFileInput.value = "";
      botKnowledgeFilename.textContent = "";
      setBotStatus("Chatbot saved with knowledge file.");
    }

    botEditor.open = false;
    botEditorSummary.textContent = "Create / Edit";

    const targetChatbotId = activeBotId;
    await loadChatbots();

    // Guard against upstream eventual consistency: if the just-created bot isn't
    // in the refreshed list yet, add it manually so the user sees it immediately.
    if (targetChatbotId && !chatbotList.some((b) => b.id === targetChatbotId)) {
      chatbotList.push({ id: targetChatbotId, name, status: "active" });
      populateBotPicker(chatbotList);
    }
    selectChatbot(targetChatbotId);
  } catch (err) {
    setBotStatus(`Save failed: ${err.message}`);
  } finally {
    botSaveBtn.disabled = false;
  }
});

botDeleteBtn.addEventListener("click", async () => {
  if (!activeBotId) return;
  const bot = chatbotList.find((b) => b.id === activeBotId);
  const botName = bot?.name ?? activeBotId;
  if (!confirm(`Delete chatbot "${botName}"?\n\nThis action cannot be undone.`))
    return;

  try {
    await request(`/api/chatbots/${activeBotId}`, { method: "DELETE" });
    activeBotId = null;
    chatHistory = [];
    chatLog.replaceChildren();
    await loadChatbots();
    setBotStatus("Chatbot deleted.");
  } catch (err) {
    setBotStatus(`Delete failed: ${err.message}`);
  }
});

// ── Chat ───────────────────────────────────────────────────────────────────

/**
 * Show or hide the chat UI depending on whether a bot is active and the
 * presenter is ready. If only one condition is met, show a contextual hint.
 */
function updateChatUI() {
  const ready = canSend();

  // Chat is available as soon as the active source can answer — no presenter
  // required. speak() already silently skips audio when the presenter isn't
  // ready, so the text conversation works independently of presenter state.
  chatContent.hidden = !ready;
  sourceLabel.textContent =
    source === "connect" ? "Connect Chatbot" : "Your own LLM";
  syncChatControls();

  if (ready) {
    chatPlaceholder.hidden = true;
    return;
  }

  chatPlaceholder.hidden = false;
  if (source === "connect") {
    // "Select" is the wrong verb when there is nothing to select from, which
    // is every brand-new organization.
    const verb = chatbotList.length ? "Select" : "Create";
    chatHintText.textContent = presenterReady
      ? `${verb} a chatbot to start chatting.`
      : `${verb} a chatbot to chat. Launch the presenter first to also hear the replies.`;
  } else {
    // The only way to land here: the own-LLM source is selected but the server
    // reported chat: false. Say which variable, not just "unavailable".
    chatHintText.textContent =
      "Set LLM_API_KEY in .env and restart the server to use your own model.";
  }
}

/**
 * Append a message bubble to the chat log.
 * @param {"user"|"assistant"|"error"} role
 * @param {string} text
 */
function appendChat(role, text) {
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  el.textContent = text;
  chatLog.append(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

chatStopBtn.addEventListener("click", () => {
  appendDebug("cmd", "presenter.interruptPresentation()");
  presenter.interruptPresentation?.();
  // interruptPresentation() cancels the queue, so ALL_PERFORMANCE_FINISHED is
  // not coming for the performance we just cut short — leave the speaking state
  // here rather than waiting for an event that will never arrive.
  setSpeaking(false);
});

// ── Wire formats ───────────────────────────────────────────────────────────
//
// The only place the two sources actually differ. Everything above and below
// this pair — the lock lifecycle, the history window, the presenter calls — is
// identical no matter which one is answering.

/** Connect's parts-based shape: `{ role, parts: [{ type, text }] }`. */
const toConnectMessages = (turns) =>
  turns.map(({ role, text }) => ({ role, parts: [{ type: "text", text }] }));

/** OpenAI's shape: `{ role, content }`. Used by /api/chat for both providers. */
const toOpenAiMessages = (turns) =>
  turns.map(({ role, text }) => ({ role, content: text }));

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !canSend()) return;

  chatInput.value = "";
  setAwaitingReply(true);
  let queued = false;

  // Add user message to history and display it
  appendChat("user", text);
  chatHistory.push({ role: "user", text });

  // Signal "thinking" on the presenter while the LLM processes the request
  appendDebug("cmd", "presenter.setThinking(true)");
  presenter.setThinking?.(true);
  presenter.setListening?.(false);

  const route =
    source === "connect" ? `/api/chatbots/${activeBotId}/chat` : "/api/chat";
  appendDebug("cmd", `POST ${route}`);
  try {
    // Send only the last MAX_HISTORY_TURNS turns. Gemini (the LLM powering the
    // Connect chatbot) has a fixed backend deadline, and an unbounded history
    // grows the prompt until it exceeds it → 504 DEADLINE_EXCEEDED. The same
    // bound is applied on the own-LLM path: every provider has some ceiling,
    // and /api/chat enforces one server-side too. The full history stays in
    // chatHistory for display in the chat log.
    const MAX_HISTORY_TURNS = 20; // 10 user + 10 assistant messages
    const windowed = chatHistory.slice(-MAX_HISTORY_TURNS);

    // The one fork. Two routes, two wire formats, two response shapes —
    // and from `reply` onward the code is shared again.
    let reply = null;
    let failureReason = null;

    if (source === "connect") {
      // POST /api/chatbots/:id/chat → { id, status, reply_text }
      const res = await request(route, {
        method: "POST",
        body: { messages: toConnectMessages(windowed) },
      });
      if (res.status === "succeeded" && res.reply_text) {
        reply = res.reply_text;
      } else {
        failureReason =
          res.status === "failed"
            ? "The chatbot failed to generate a response."
            : `Unexpected response (status: ${res.status}).`;
      }
    } else {
      // POST /api/chat → OpenAI-compatible { choices: [{ message: { content } }] }
      const res = await request(route, {
        method: "POST",
        body: {
          messages: [
            { role: "system", content: OWN_LLM_SYSTEM_PROMPT },
            ...toOpenAiMessages(windowed),
          ],
        },
      });
      reply = res.choices?.[0]?.message?.content?.trim() || null;
      if (!reply) failureReason = "The model returned an empty reply.";
    }

    if (reply) {
      appendChat("assistant", reply);
      appendDebug(
        "ok",
        `Reply: “${reply.length > 60 ? reply.slice(0, 60) + "…" : reply}”`,
      );
      // Add assistant turn to history so follow-up messages have full context
      chatHistory.push({ role: "assistant", text: reply });
      // Hand the reply text to the presenter for speech + motion playback
      queued = await speak(reply);
    } else {
      // Roll back the user turn — no usable assistant reply was produced.
      // Without this pop, the orphaned user turn would be re-sent on every
      // subsequent message, producing consecutive role:"user" entries that
      // break the multi-turn format both APIs expect.
      chatHistory.pop();
      appendChat("error", failureReason);
      appendDebug("err", failureReason);
      presenter.setThinking?.(false);
    }
  } catch (err) {
    // Roll back the user turn so a retry doesn't send a duplicate.
    chatHistory.pop();
    appendChat("error", `${err.message}`);
    appendDebug("err", `API error: ${err.message}`);
    presenter.setThinking?.(false);
  } finally {
    // Once a performance is queued, ALL_PERFORMANCE_FINISHED or Stop owns the
    // unlock — releasing here too is exactly what let the send button come back
    // while the avatar was still speaking. Every other path queued nothing, so
    // no such event is coming and this is the only place left to unlock.
    setAwaitingReply(false);
    if (!queued) setSpeaking(false);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Record that a performance opened or closed, then re-derive the controls.
 * @param {boolean} speaking
 */
function setSpeaking(speaking) {
  isSpeaking = speaking;
  syncChatControls();
  if (!speaking) chatInput.focus();
}

/**
 * Record that a chatbot request opened or closed, then re-derive the controls.
 * @param {boolean} awaiting
 */
function setAwaitingReply(awaiting) {
  isAwaitingReply = awaiting;
  syncChatControls();
}

/**
 * The only place the chat controls' enabled state is computed. Both inputs are
 * read here — whether a performance is open, and whether a chatbot is selected —
 * because anything that writes one of these properties while knowing only one of
 * the two will silently undo the other. That is exactly how selecting a chatbot
 * mid-speech used to re-enable Send.
 */
/**
 * Whether the active source has everything it needs to answer. The asymmetry
 * is real and deliberate: Connect needs a chatbot picked first, the own-LLM
 * path needs only a key the server already confirmed.
 */
function canSend() {
  return source === "connect" ? Boolean(activeBotId) : ownLlmAvailable;
}

/**
 * Switch which model answers. Nothing about the conversation is reset — the
 * history carries across, so the next reply comes from the other provider with
 * the same context. That continuity is the point: it is the only way to see
 * the two sources answer the *same* conversation.
 */
function setSource(next) {
  source = next;
  // The chatbot picker is Connect-only machinery; hiding it keeps the sidebar
  // honest about what the active source actually uses.
  chatbotManager.hidden = next !== "connect";
  updateChatUI();
}

sourceRadios.forEach((radio) =>
  radio.addEventListener("change", () => {
    if (radio.checked) setSource(radio.value);
  }),
);

// /api/chat 501s without LLM_API_KEY, and appConfig.chat is how the server
// says so. Until this demo read that flag it was reported and ignored — the
// participant found out by sending a message and getting an error back.
if (!ownLlmAvailable) {
  sourceOwnRadio.disabled = true;
  sourceOwnHint.hidden = false;
}

function syncChatControls() {
  const busy = isSpeaking || isAwaitingReply;
  // Stop follows the performance alone: there is nothing to interrupt while a
  // request is merely in flight.
  chatStopBtn.disabled = !isSpeaking;
  chatSendBtn.disabled = busy || !canSend();
  chatInput.disabled = busy;
}

function setStatus(text) {
  statusMsg.textContent = text;
}

function setBotStatus(text) {
  botStatusMsg.textContent = text;
}

// ── Knowledge file helpers ────────────────────────────────────────────────

/** Knowledge status badge copy & CSS class map. */
const KNOWLEDGE_STATUS_MAP = {
  processing: { label: "Processing…", badgeClass: "processing" },
  ready: { label: "Ready", badgeClass: "ready" },
  error: { label: "Error", badgeClass: "error" },
};

/**
 * Update the knowledge status badge and Remove button from a knowledge DO.
 * @param {{ name: string, status: string } | null} knowledge
 */
function updateKnowledgeStatus(knowledge) {
  if (!knowledge) {
    botKnowledgeStatus.textContent = "No file";
    botKnowledgeStatus.className = "knowledge-badge knowledge-badge--none";
    botKnowledgeRemoveBtn.hidden = true;
    return;
  }
  const { label, badgeClass } = KNOWLEDGE_STATUS_MAP[knowledge.status] ?? {
    label: knowledge.status,
    badgeClass: "none",
  };
  botKnowledgeStatus.textContent = `${knowledge.name} \u2014 ${label}`;
  botKnowledgeStatus.className = `knowledge-badge knowledge-badge--${badgeClass}`;
  botKnowledgeRemoveBtn.hidden = false;
}

/**
 * Read a File as a base64-encoded data string (without the data-URL prefix).
 * @param {File} file
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(/** @type {string} */ (reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Show selected file name next to the file picker
botKnowledgeFileInput.addEventListener("change", () => {
  const file = botKnowledgeFileInput.files[0];
  botKnowledgeFilename.textContent = file ? file.name : "";
});

// Remove knowledge file from the active chatbot
botKnowledgeRemoveBtn.addEventListener("click", async () => {
  if (!activeBotId) return;
  if (!confirm("Remove the knowledge file from this chatbot?")) return;
  try {
    setBotStatus("Removing knowledge file…");
    const updated = await request(`/api/chatbots/${activeBotId}/knowledge`, {
      method: "DELETE",
    });
    updateKnowledgeStatus(updated.knowledge ?? null);
    setBotStatus("Knowledge file removed.");
  } catch (err) {
    setBotStatus(`Remove failed: ${err.message}`);
  }
});

// ── Function tools helpers ────────────────────────────────────────────────

/**
 * A ready-to-use example tool: weather lookup via wttr.in (no API key needed).
 * Good for hackathon demos because it works immediately without any signup.
 */
const TOOL_EXAMPLE = [
  {
    name: "get_weather",
    description:
      "Look up the current weather for a city. Use this when the user asks about weather, temperature, or forecast.",
    settings: {
      request: {
        method: "get",
        url: "https://wttr.in",
        query_params: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "City name in English, e.g. Taipei",
            },
            format: {
              type: "string",
              description:
                "Response format. ALWAYS pass the literal string value '3'",
            },
          },
          required: ["location", "format"],
        },
      },
      auth: { secret_type: "no_auth" },
      response: { body_schema: {} },
    },
  },
];

// Load the example tool JSON into the tools textarea
botToolsExampleBtn.addEventListener("click", () => {
  botToolsInput.value = JSON.stringify(TOOL_EXAMPLE, null, 2);
  botToolsInput.focus();
});

/**
 * Append a timestamped entry to the debug timeline panel.
 *
 * Types and their meaning:
 *   user  — the user sent a message
 *   api   — an API call is in-flight
 *   bot   — chatbot reply received
 *   cmd   — a command sent to sv-presenter (present, setThinking…)
 *   sdk   — an event emitted by the sv-presenter SDK
 *   ok    — a successful outcome
 *   err   — an error
 *
 * @param {"user"|"api"|"bot"|"cmd"|"sdk"|"ok"|"err"} type
 * @param {string} message
 */
function appendDebug(type, message) {
  const now = new Date();
  const ts =
    [
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join(":") +
    "." +
    String(now.getMilliseconds()).padStart(3, "0");

  const li = document.createElement("li");
  li.className = `debug-entry debug-entry--${type}`;

  const tsEl = document.createElement("span");
  tsEl.className = "debug-ts";
  tsEl.textContent = ts;

  const msgEl = document.createElement("span");
  msgEl.className = "debug-msg";
  msgEl.textContent = message;

  li.append(tsEl, msgEl);
  debugLog.append(li);
  debugLog.scrollTop = debugLog.scrollHeight;
}

debugClearBtn.addEventListener("click", () => {
  debugLog.replaceChildren();
});

botIdCopy.addEventListener("click", () => {
  if (!activeBotId) return;
  navigator.clipboard.writeText(activeBotId).then(() => {
    const prev = botIdCopy.textContent;
    botIdCopy.textContent = "Copied!";
    setTimeout(() => {
      botIdCopy.textContent = prev;
    }, 1500);
  });
});

// ── Bootstrap ──────────────────────────────────────────────────────────────
//
// Runs last, once every handler above is attached, and swallows its own
// failures. The three calls are independent; only the presenter engine's
// absence is survivable, and Launch is disabled when it is.

await Promise.all([
  loadCatalog(),
  loadChatbots(),
  isPresenterLaunchDisabled
    ? Promise.resolve()
    : loadPresenterEngine(appConfig.presenterUrl).then(
        () => {
          presenterEngineReady = true;
          updateInitBtn();
        },
        (err) => {
          stagePlaceholder.querySelector("p").textContent =
            "Presenter engine unavailable — check PRESENTER_URL and the browser console. Chat still works as text.";
          setStatus(`Presenter engine failed to load: ${err.message}`);
          console.error(err);
        },
      ),
]);
updateChatUI();
