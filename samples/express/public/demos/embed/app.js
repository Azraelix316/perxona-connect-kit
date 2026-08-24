/**
 * Perxona Connect Kit — Embed Demo
 *
 * An avatar answering questions on a page that already exists. Everything it
 * needs arrives resolved from GET /api/config; failures go to the console and
 * never to the page. See README.md.
 * Zero dependencies — plain ESM, no build step required.
 */

/** @type {HTMLElement & import('@perxona/presenter-types').IPresentationWidget} */
const presenter = document.querySelector("sv-presenter");
/** @type {HTMLFormElement} */
const chatForm = document.querySelector("#chat-form");
/** @type {HTMLInputElement} */
const chatInput = document.querySelector("#chat-input");
/** @type {HTMLButtonElement} */
const sendBtn = document.querySelector("#send-btn");
const chatLog = document.getElementById("chat-log");
const chatPanel = document.getElementById("chat");

// Serialized at the call site: the Connect chat API takes `parts`, not `content`.
/** @type {{role: "user"|"assistant", text: string}[]} */
const history = [];
const MAX_HISTORY_TURNS = 20; // 10 user + 10 assistant
const GREETING = "Hi! Ask me anything about XRSPACE.";
const FAILURE_REPLY = "Sorry — I couldn't reach the assistant just then.";
const toConnectMessages = (turns) =>
  turns.map(({ role, text }) => ({ role, parts: [{ type: "text", text }] }));
let audioUnlocked = false;
// Assigned by start(), which runs last — the chat can open before it resolves.
let config = null;

/** GET without `body`, POST as JSON with it. Throws on non-2xx with the server's `error`. */
async function request(path, body) {
  const res = await fetch(
    path,
    body && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(data.error ?? res.statusText), {
      status: res.status,
    });
  return data;
}

function appendMessage(role, text) {
  const li = document.createElement("li");
  li.className = `msg msg--${role}`;
  li.textContent = text;
  chatLog.append(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function loadPresenterEngine(url) {
  // DEMO-ONLY: url is trusted without host validation. A production
  // integration should verify it against a known CDN allowlist.
  await new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), {
      type: "module",
      src: url,
      onload: resolve,
      onerror: () => reject(new Error(`Presenter failed to load: ${url}`)),
    });
    document.head.append(script);
  });
}

// Attach before initializing: Ready is only ever an event, never readable state.
presenter.addEventListener("PRESENTER_STATUS", (/** @type {any} */ event) => {
  if (event.detail?.status !== "Ready") return;
  document.getElementById("stage-loading")?.remove();
  chatPanel.hidden = false;
  appendMessage("assistant", GREETING); // written, not spoken — no gesture yet
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !config?.chatbotId) return;

  chatInput.value = "";
  appendMessage("user", text);
  history.push({ role: "user", text });
  sendBtn.disabled = true;
  chatInput.disabled = true;
  presenter.setThinking?.(true);

  try {
    // present() returns AUDIO_CONTEXT_UNAVAILABLE until this has run, and
    // autoplay policy allows it only from a user action — this submit is one.
    if (!audioUnlocked) {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    }

    const { reply_text: reply, status } = await request(
      `/api/chatbots/${config.chatbotId}/chat`,
      { messages: toConnectMessages(history.slice(-MAX_HISTORY_TURNS)) },
    );
    if (!reply) throw new Error(`chatbot returned status "${status}"`);

    appendMessage("assistant", reply);
    history.push({ role: "assistant", text: reply });
    presenter.setThinking?.(false);
    // Resolves with { success: false, … } rather than rejecting.
    const result = await presenter.present(reply);
    if (!result?.success)
      console.error(
        `Embed: present() failed (${result?.code}): ${result?.message ?? ""}`,
      );
  } catch (err) {
    // Drop the unanswered question, not the answer that may already be pushed.
    if (history.at(-1)?.role === "user") history.pop();
    presenter.setThinking?.(false);
    // The page may not show configuration; it may say something went wrong.
    appendMessage("error", FAILURE_REPLY);
    console.error(`Embed: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
});

// Called last: a rejection in top-level await would abort module evaluation
// and leave every handler above unregistered.
async function start() {
  const cfg = await request("/api/config");
  const blocker =
    (cfg.mock && "mock mode cannot drive the presenter") ||
    (!cfg.fixedTarget &&
      "no presenter target — see the server's startup log") ||
    (!cfg.chatbotId &&
      "no chatbot in this account yet. Create one in the Studio demo and " +
        "reload — or set DEMO_FIXED_CHATBOT_ID");
  if (blocker) throw new Error(blocker);
  await loadPresenterEngine(cfg.presenterUrl);
  const { connect_key: connectKey } = await request("/api/connect-key");
  await presenter.initializeWithConnectKey(connectKey, cfg.fixedTarget);
  return cfg;
}

// .no-widget collapses the column so the page keeps its shape.
config = await start().catch((err) => {
  document.querySelector(".page").classList.add("no-widget");
  console.error(`Embed: ${err.message}`);
  return {};
});
