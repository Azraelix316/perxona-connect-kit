import express from "express";

// ── Config ──────────────────────────────────────────────────

const PORT = process.env.PORT || 8088;
const PERXONA_API_BASE_URL = process.env.PERXONA_API_BASE_URL;
const USE_MOCK = process.env.USE_MOCK === "true";
const PRESENTER_URL =
  process.env.PRESENTER_URL ||
  "https://cdn.perxona.ai/connect/latest/widget/entry/presenter.js";
// Server-side credentials for the one shared Connect API identity this sample
// uses — see README "Auth model". Every browser hitting this server acts
// through the same upstream account; there is no per-user login.
const CONNECT_EMAIL = process.env.PERXONA_CONNECT_EMAIL;
const CONNECT_PASSWORD = process.env.PERXONA_CONNECT_PASSWORD;

// Real credentials are only needed when actually calling the upstream API.
// USE_MOCK=true skips callUpstream() entirely (see api selection below), so
// don't force dummy values into these fields just to pass a startup check.
if (!USE_MOCK) {
  if (!PERXONA_API_BASE_URL) {
    console.error(
      "ERROR: PERXONA_API_BASE_URL is required. Copy .env.example to .env and fill it in.",
    );
    process.exit(1);
  }

  if (!CONNECT_EMAIL || !CONNECT_PASSWORD) {
    console.error(
      "ERROR: PERXONA_CONNECT_EMAIL and PERXONA_CONNECT_PASSWORD are required.\n" +
        "Copy .env.example to .env and fill them in with your Perxona service credentials.",
    );
    process.exit(1);
  }
}

// ── Upstream API implementation ────────────────────────────────────────────

/**
 * Send an authenticated request to the Perxona upstream API.
 * @param {string} path  - Upstream path, e.g. '/api/v1/connect/voices'
 * @param {object} opts  - fetch options (method, body, headers…)
 * @param {string} [token] - JWT access token; omit for unauthenticated calls
 */
async function callUpstream(path, opts, token) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${PERXONA_API_BASE_URL}${path}`, { ...opts, headers });
}

/**
 * Parse a callUpstream() Response as JSON, throwing a structured error
 * ({ status, payload }) on any non-2xx status. Centralising this means every
 * connectApi method — not just the ones that used to check r.ok by hand —
 * surfaces 401/403 the same way, which is what lets authedCall() (see below)
 * detect an expired bearer token and transparently re-login and retry.
 * @param {Response} r
 * @param {string} label  Used in the thrown error message, e.g. "voices".
 */
async function upstreamJson(r, label) {
  if (!r.ok) {
    const payload = await r.json().catch(() => ({}));
    throw Object.assign(new Error(`upstream ${label} failed`), {
      status: r.status,
      payload,
    });
  }
  return r.json();
}

/**
 * Probe whether the presenter engine is reachable at PRESENTER_URL.
 * Non-fatal diagnostic only — a HEAD request with a short timeout so startup
 * never blocks. Catches the common "PRESENTER_URL points at a channel that
 * isn't published yet" case (404) before the browser hits a blank stage.
 * @returns {Promise<"reachable" | string>} "reachable", "unreachable (<status>)", or "unreachable"
 */
async function checkPresenter() {
  try {
    const r = await fetch(PRESENTER_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    return r.ok ? "reachable" : `unreachable (${r.status})`;
  } catch {
    return "unreachable";
  }
}

// ── Profile assembly helpers ───────────────────────────────────────────────

const MOTION_STATES = ["idle", "talking", "listening", "loading", "error"];

/**
 * Categorise ConnectMotionAssetResponse items into a MotionSet keyed by
 * MotionState. Motions whose tags start with 'face:' are excluded (see buildDefaultFacial).
 * @param {Array} items  ConnectMotionAssetResponse[]
 * @returns {Record<string, Array>}
 */
const isFaceTag = (tag) => tag.startsWith("face:");

/**
 * Resolve the presenter lipsync mode from the avatar detail response.
 *
 * Preference order:
 * 1. `wlipsync` when available
 * 2. `xrlipsync` as the fallback legacy mode
 * 3. `wlipsync` as the default when no known config exists
 *
 * @param {Record<string, unknown>} lipsyncConfigs
 * Avatar lipsync config map from ConnectAvatarDetailResponse.lipsync_configs.
 *
 * @returns {"wlipsync" | "xrlipsync"}
 * The selected lipsync mode used to read the matching config map.
 */
const getLipsyncMode = (lipsyncConfigs) => {
  if ("wlipsync" in lipsyncConfigs) return "wlipsync";
  if ("xrlipsync" in lipsyncConfigs) return "xrlipsync";
  return "wlipsync";
};

function buildMotionSet(items) {
  const motionSet = Object.fromEntries(MOTION_STATES.map((s) => [s, []]));
  for (const m of items) {
    if (m.tags?.some(isFaceTag)) continue;
    const assetUrl =
      m.lod_urls?.lod0 ?? m.lod_urls?.lod1 ?? m.lod_urls?.lod2 ?? "";
    const asset = { id: m.motion_id, type: "body", assetUrl };
    for (const tag of m.tags ?? []) {
      if (MOTION_STATES.includes(tag)) motionSet[tag].push(asset);
    }
  }
  return motionSet;
}

/**
 * Extract face motions (any tag starting with 'face:') as defaultFacial MotionAsset entries.
 * @param {Array} items  ConnectMotionAssetResponse[]
 * @returns {Array}
 */
function buildDefaultFacial(items) {
  return items
    .filter((m) => m.tags?.some(isFaceTag))
    .map((m) => ({
      id: m.motion_id,
      type: "face",
      assetUrl: m.lod_urls?.lod0 ?? m.lod_urls?.lod1 ?? m.lod_urls?.lod2 ?? "",
    }));
}

/**
 * Map upstream LipSyncConfig entries to presenter shape.
 * Backend: { config_url, resource_url } → Presenter: { configUrl, profileUrl }
 * @param {Record<string, object>} rawMap  voice_name → upstream LipSyncConfig
 * @returns {Record<string, { configUrl: string, profileUrl: string }>}
 */
function buildLipsyncConfig(rawMap) {
  return Object.fromEntries(
    Object.entries(rawMap).map(([voiceName, cfg]) => [
      voiceName,
      { configUrl: cfg.config_url ?? "", profileUrl: cfg.resource_url ?? "" },
    ]),
  );
}

// Map an upstream manifest entry's asset type → presenter MotionType.
// The Connect API reports 'motion' (body) and 'facial_motion' (face).
const MOTION_TYPE_BY_ASSET_TYPE = { motion: "body", facial_motion: "face" };

// The presenter's `ssml` field expects SSML. The backend currently only emits
// 'ssml', but ConnectPresentationResponse.speech_format also allows 'raw_text'
// and 'markup'. Guard so a future format change fails loudly here instead of
// silently feeding non-SSML into the presenter.
const SUPPORTED_SPEECH_FORMAT = "ssml";

/**
 * Map an upstream ConnectPresentationResponse to the presenter `Performance`
 * shape ({ motions, message, ssml, voiceName }) that playPerformance() expects.
 *
 * Backend → presenter:
 *   performance_manifest (motionId → AssetLodCdnUrl) → motions: MotionAsset[]
 *   display_text   → message   (clean, displayable text)
 *   speech_content → ssml      (synthesis-ready payload, must be SSML)
 *   voice_name     → voiceName
 *
 * @param {object} resp  ConnectPresentationResponse
 * @returns {{ motions: Array, message: string, ssml: string, voiceName: string }}
 */
function buildPerformance(resp) {
  if (resp.speech_format !== SUPPORTED_SPEECH_FORMAT) {
    throw Object.assign(
      new Error(
        `Unsupported speech_format '${resp.speech_format}'. ` +
          `This sample only maps '${SUPPORTED_SPEECH_FORMAT}' to the presenter; ` +
          `add a mapper for the new format before enabling it.`,
      ),
      { status: 502 },
    );
  }
  const motions = Object.entries(resp.performance_manifest ?? {}).map(
    ([id, lod]) => ({
      id,
      type: MOTION_TYPE_BY_ASSET_TYPE[lod.type] ?? "body",
      assetUrl: lod.lod0 ?? lod.lod1 ?? lod.lod2 ?? "",
    }),
  );
  return {
    motions,
    message: resp.display_text ?? "",
    ssml: resp.speech_content ?? "",
    voiceName: resp.voice_name ?? "",
  };
}

// connectApi — real upstream implementation, thin wrappers around call().
// Route handlers reference api.* and never touch USE_MOCK directly.
const connectApi = {
  async checkUpstream() {
    try {
      const r = await fetch(`${PERXONA_API_BASE_URL}/ready`);
      return r.ok ? "reachable" : "unreachable";
    } catch {
      return "unreachable";
    }
  },

  async login(body) {
    const r = await callUpstream("/api/v1/connect/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return upstreamJson(r, "login");
  },

  // TTS token: POST /api/v1/connect/voice-tokens/tts
  // If voiceId is omitted the first available voice is auto-selected so the
  // frontend can call /api/tts-token without managing voice selection itself.
  // Named after presenter.refreshSpeechToken() — the same token this mints is
  // what initialize() consumes first and refreshSpeechToken() re-mints later.
  async refreshSpeechToken(voiceId, token) {
    let id = voiceId;
    if (!id) {
      const vr = await this.voices(token);
      id = (vr.items ?? [])[0]?.id;
      if (!id) {
        throw Object.assign(
          new Error("No voices available to generate TTS token"),
          {
            status: 503,
            payload: { error: "No voices configured for this organization." },
          },
        );
      }
    }
    const r = await callUpstream(
      "/api/v1/connect/voice-tokens/tts",
      { method: "POST", body: JSON.stringify({ voice_id: id }) },
      token,
    );
    const { token: azureToken } = await upstreamJson(r, "tts-token");
    // Normalise to { speech_token } — the string presenter.initialize() /
    // refreshSpeechToken() expects.
    return { speech_token: azureToken };
  },

  async voices(token) {
    const r = await callUpstream("/api/v1/connect/voices", {}, token);
    return upstreamJson(r, "voices"); // Page[ConnectVoiceResponse] — items already have { id, name, … }
  },

  // Normalize avatar list: backend uses avatar_id; frontend dropdowns expect id.
  async avatars(token) {
    const r = await callUpstream("/api/v1/connect/assets/avatars", {}, token);
    const page = await upstreamJson(r, "avatars");
    return {
      ...page,
      items: (page.items ?? []).map(({ avatar_id, ...rest }) => ({
        id: avatar_id,
        ...rest,
      })),
    };
  },

  // Raw detail — consumed by profile() for AvatarConfig assembly.
  async avatar(id, token) {
    const r = await callUpstream(
      `/api/v1/connect/assets/avatars/${id}`,
      {},
      token,
    );
    return upstreamJson(r, "avatar detail");
  },

  // Motions are a sub-resource of an avatar, not a top-level collection.
  async avatarMotions(avatarId, token) {
    const r = await callUpstream(
      `/api/v1/connect/assets/avatars/${avatarId}/motions`,
      {},
      token,
    );
    return upstreamJson(r, "avatar motions"); // Page[ConnectMotionAssetResponse]
  },

  // Normalize scene list: backend uses scene_id; frontend dropdowns expect id.
  async scenes(token) {
    const r = await callUpstream("/api/v1/connect/assets/scenes", {}, token);
    const page = await upstreamJson(r, "scenes");
    return {
      ...page,
      items: (page.items ?? []).map(({ scene_id, ...rest }) => ({
        id: scene_id,
        ...rest,
      })),
    };
  },

  // Raw detail — consumed by profile() for SceneConfig assembly.
  async scene(id, token) {
    const r = await callUpstream(
      `/api/v1/connect/assets/scenes/${id}`,
      {},
      token,
    );
    return upstreamJson(r, "scene detail");
  },

  async createPresentation(body, token) {
    const r = await callUpstream(
      "/api/v1/connect/presentation",
      { method: "POST", body: JSON.stringify(body) },
      token,
    );
    // Map ConnectPresentationResponse → presenter Performance shape.
    return buildPerformance(await upstreamJson(r, "presentation"));
  },

  // Profile bundle — assembles the full AvatarConfig + SceneConfig + voices the
  // presenter needs for initialize(), so the frontend makes one call instead of
  // stitching catalog endpoints together.
  //
  // Upstream connect endpoints:
  //   GET  /api/v1/connect/assets/avatars/:id         → ConnectAvatarDetailResponse
  //   GET  /api/v1/connect/assets/scenes/:id          → ConnectSceneDetailResponse
  //   GET  /api/v1/connect/assets/avatars/:id/motions → Page[ConnectMotionAssetResponse]
  //   GET  /api/v1/connect/voices                     → Page[ConnectVoiceResponse]
  async profile(avatarId, sceneId, token) {
    const [avatarDetail, sceneDetail, voicesResp, motionsPage] =
      await Promise.all([
        this.avatar(avatarId, token),
        this.scene(sceneId, token),
        this.voices(token),
        this.avatarMotions(avatarId, token),
      ]);

    // Prefer wlipsync; fall back to xrlipsync; default to wlipsync.
    const lipsyncConfigs = avatarDetail.lipsync_configs ?? {};
    const lipsyncMode = getLipsyncMode(lipsyncConfigs);

    return {
      avatar: {
        id: avatarDetail.avatar_id,
        // lod_urls keys ('lod0','lod1','lod2') match AssetQuality enum values
        // ('lod0'='High','lod1'='Medium','lod2'='Low') used by the presenter.
        assetUrls: avatarDetail.lod_urls ?? {},
        motions: buildMotionSet(motionsPage.items ?? []),
        defaultFacial: buildDefaultFacial(motionsPage.items ?? []),
        lipsyncMode,
        lipsyncConfig: buildLipsyncConfig(lipsyncConfigs[lipsyncMode] ?? {}),
      },
      scene: {
        id: sceneDetail.scene_id,
        assetUrls: sceneDetail.lod_urls ?? {},
      },
      voices: voicesResp,
    };
  },
};

// Select implementation at boot: mock (internal dev only) or real upstream.
let api;
if (USE_MOCK) {
  try {
    api = await import("./mocks/upstream.mjs");
  } catch {
    console.error(
      "ERROR: USE_MOCK=true but mocks/upstream.mjs is not present.\n" +
        "The mock implementation is internal-only and is not included in this " +
        "public sample — set USE_MOCK=false (or remove it) and fill in real " +
        "PERXONA_API_BASE_URL / PERXONA_CONNECT_EMAIL / PERXONA_CONNECT_PASSWORD instead.",
    );
    process.exit(1);
  }
} else {
  api = connectApi;
}

// ── Global upstream auth (token manager) ────────────────────────────────────
//
// This sample exchanges ONE set of server-side credentials (PERXONA_CONNECT_EMAIL /
// PERXONA_CONNECT_PASSWORD) for ONE Connect API bearer token, shared by every
// browser that hits this server. There is no per-user login — see README "Auth
// model" for the rationale and its tradeoffs.

/** The current shared bearer token, or null before the first login. */
let cachedToken = null;
/** In-flight login request — de-dupes concurrent callers into one upstream login call. */
let loginPromise = null;

/**
 * Return the current bearer token, logging in with the configured Connect
 * credentials on first use (lazy — no login happens until the first protected
 * route is hit) or when forceRefresh is set (after upstream rejects the
 * cached token with 401/403). Concurrent callers share the same in-flight
 * login request instead of each triggering their own.
 * @param {{ forceRefresh?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function getToken({ forceRefresh = false } = {}) {
  if (cachedToken && !forceRefresh) return cachedToken;
  if (forceRefresh) cachedToken = null;
  if (!loginPromise) {
    loginPromise = api
      .login({ email: CONNECT_EMAIL, password: CONNECT_PASSWORD })
      .then(({ access_token }) => {
        cachedToken = access_token;
        return cachedToken;
      })
      .finally(() => {
        loginPromise = null;
      });
  }
  return loginPromise;
}

/**
 * Run an upstream call with the shared token, transparently re-logging in and
 * retrying once if the token was rejected (401/403). This is what makes token
 * expiry invisible to the browser — no re-login UI or refresh token needed.
 * Any other error (network failure, 5xx, etc.) is rethrown as-is.
 * @param {(token: string) => Promise<any>} fn
 */
async function authedCall(fn) {
  const token = await getToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err.status !== 401 && err.status !== 403) throw err;
    const freshToken = await getToken({ forceRefresh: true });
    return fn(freshToken);
  }
}

// ── Express app ────────────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");

// ── Static frontend ────────────────────────────────────────────────────────

// Disable ETags in dev so a plain browser refresh always fetches the latest
// files from disk. Production keeps ETags for efficient caching.
const IS_DEV = process.env.NODE_ENV !== "production";

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(express.static("public", { etag: !IS_DEV }));

app.use(express.json());

/**
 * Wrap a route handler so any thrown error (upstream failure, or auth retry
 * exhaustion from authedCall) becomes a JSON error response instead of an
 * unhandled rejection — Express 4 does not catch async handler rejections on
 * its own.
 * @param {(req: express.Request, res: express.Response) => Promise<void>} handler
 */
function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      const status = err.status ?? 502;
      res.status(status).json(err.payload ?? { error: String(err) });
    }
  };
}

// ── Health & config ─────────────────────────────────────────────────────────

// GET /api/health → { status: "ok", upstream: "reachable"|"unreachable"|"mock" }. Always 200.
// Liveness plus the one dynamic field: `upstream` probes the backend on every
// call (and reads "mock" in mock mode). Static per-process flags (mock, chat)
// live in /api/config, which needs no network round-trip.
app.get("/api/health", async (_req, res) => {
  res.json({
    status: "ok",
    upstream: await api.checkUpstream(),
  });
});

// GET /api/config → { mock, chat, presenterUrl }. Static per-process flags fixed
// at startup; no upstream probe, so the frontend can read them cheaply without
// triggering a backend round-trip on every poll. `chat` reflects the presence of
// LLM_API_KEY only — never the key itself. `presenterUrl` lets demo frontends
// inject the presenter engine <script> dynamically instead of server-side HTML
// templating.
app.get("/api/config", (_req, res) => {
  res.json({
    mock: USE_MOCK,
    chat: Boolean(process.env.LLM_API_KEY),
    presenterUrl: PRESENTER_URL,
  });
});

// POST /api/tts-token
// Request: { voice_id? } — when omitted the server auto-selects the first available voice.
// Returns: { speech_token } — the string presenter.initialize()/refreshSpeechToken() expects.
// Errors:  502 upstream failure · 503 no voices configured.
app.post(
  "/api/tts-token",
  route(async (req, res) => {
    const voiceId = req.body?.voice_id;
    res.json(
      await authedCall((token) => api.refreshSpeechToken(voiceId, token)),
    );
  }),
);

// ── Catalog + presentation routes ───────────────────────────────────────────
// GET  /api/voices
// GET  /api/avatars          GET  /api/avatars/:id    GET  /api/avatars/:id/motions
// GET  /api/scenes           GET  /api/scenes/:id
// GET  /api/profile?avatar=&scene=
// POST /api/presentation
// POST /api/chat             (disabled when LLM_API_KEY is unset → 501)
//
// All routes below share the one server-side Connect identity via authedCall();
// there is no per-request auth check — see the token manager above.

// GET /api/profile?avatar=<id>&scene=<id>
// Returns: { avatar: AvatarConfig, scene: SceneConfig, voices: Page } — one bundle the
//          presenter needs, so the frontend can initialize() without stitching catalog
//          responses together. Mirrors the production widget's profile pattern.
// Errors:  400 when 'avatar' or 'scene' is missing.
// Shapes:  AvatarConfig / SceneConfig are defined in docs/presenter.d.ts.
app.get(
  "/api/profile",
  route(async (req, res) => {
    const { avatar, scene } = req.query;
    if (!avatar || !scene) {
      res
        .status(400)
        .json({ error: "Query params 'avatar' and 'scene' are required." });
      return;
    }
    res.json(
      await authedCall((token) =>
        api.profile(
          encodeURIComponent(avatar),
          encodeURIComponent(scene),
          token,
        ),
      ),
    );
  }),
);

// Catalog — read-only lists + single items used to populate UI dropdowns.
//   GET /api/voices              → Page { items: [{ id, name, … }] }
//   GET /api/avatars             → Page { items: [{ id, name, … }] }  (id normalized from avatar_id)
//   GET /api/avatars/:id         → raw avatar detail (avatar_id, lod_urls, lipsync_configs, …)
//   GET /api/avatars/:id/motions → Page { items: [ … ] }
//   GET /api/scenes              → Page { items: [{ id, name, … }] }  (id normalized from scene_id)
//   GET /api/scenes/:id          → raw scene detail
app.get(
  "/api/voices",
  route(async (_req, res) => {
    res.json(await authedCall((token) => api.voices(token)));
  }),
);

app.get(
  "/api/avatars",
  route(async (_req, res) => {
    res.json(await authedCall((token) => api.avatars(token)));
  }),
);

app.get(
  "/api/avatars/:id",
  route(async (req, res) => {
    const id = encodeURIComponent(req.params.id);
    res.json(await authedCall((token) => api.avatar(id, token)));
  }),
);

// Motions are a sub-resource of an avatar (no top-level collection endpoint).
app.get(
  "/api/avatars/:id/motions",
  route(async (req, res) => {
    const id = encodeURIComponent(req.params.id);
    res.json(await authedCall((token) => api.avatarMotions(id, token)));
  }),
);

app.get(
  "/api/scenes",
  route(async (_req, res) => {
    res.json(await authedCall((token) => api.scenes(token)));
  }),
);

app.get(
  "/api/scenes/:id",
  route(async (req, res) => {
    const id = encodeURIComponent(req.params.id);
    res.json(await authedCall((token) => api.scene(id, token)));
  }),
);

// POST /api/presentation
// Request: { avatar_id, voice_id, message } — avatar_id/voice_id select the assets and
//          voice profile; a real app may also add SSML or motion timing on top.
// Returns: a presenter-ready Performance payload (see docs/presenter.d.ts), mapped from
//          the upstream ConnectPresentationResponse.
// Errors:  any failure (error status or network error) signals the frontend to fall back to
//          a client-built, TTS-only Performance (line only, no motions).
app.post(
  "/api/presentation",
  route(async (req, res) => {
    res.json(
      await authedCall((token) => api.createPresentation(req.body, token)),
    );
  }),
);

// POST /api/chat
// Request: { messages: [...] } (OpenAI chat format).
// Returns: the OpenAI-compatible chat-completion JSON from the configured endpoint.
// Errors:  501 until LLM_API_KEY is set · 502 LLM upstream unreachable.
// Note: chat talks directly to the configured LLM endpoint, not the Connect API,
// so it does not go through authedCall().
app.post("/api/chat", async (req, res) => {
  if (!process.env.LLM_API_KEY) {
    res.status(501).json({
      error: "LLM_API_KEY not configured. Set it in .env to enable chat.",
    });
    return;
  }
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({
      error: "Request body must include a non-empty 'messages' array.",
    });
    return;
  }
  const base = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      },
      body: JSON.stringify({ model, messages }),
    });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res
      .status(502)
      .json({ error: "LLM upstream unreachable", message: String(err) });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

const CHECK_ICONS = { reachable: "✓", unreachable: "✗", mock: "–" };

app.listen(PORT, () => {
  console.log(`\nPerxona Connect Kit`);
  console.log(`  URL  : http://localhost:${PORT}`);
  console.log(`  Mode : ${USE_MOCK ? "MOCK (no real API calls)" : "live"}`);
  // Deferred probes so the banner prints immediately and startup never blocks.
  // Labeled API/CDN so each line reads as that resource's reachability.
  api.checkUpstream().then((status) => {
    const icon = CHECK_ICONS[status] ?? "✗";
    const hint =
      status === "unreachable" ? " — check PERXONA_API_BASE_URL" : "";
    console.log(`  API  : ${icon} ${status}  ${PERXONA_API_BASE_URL}${hint}`);
  });
  checkPresenter().then((status) => {
    const icon = CHECK_ICONS[status] ?? "✗";
    const hint =
      status === "reachable"
        ? ""
        : " — set PRESENTER_URL to a reachable engine (see .env)";
    console.log(`  CDN  : ${icon} ${status}  ${PRESENTER_URL}${hint}`);
  });
});
