# Perxona Connect Kit

A minimal, self-contained sample that integrates the **Perxona Connect API** (Presentation Service) and the `<sv-presenter>`
avatar Web Component (Presentation SDK). Pick an avatar, scene, and voice, and make the avatar speak — then use it as the
starting point for your own project.

> This kit is built for a fast first run, not to cover the whole SDK or to be production-ready. The goal is to get you from
> clone to a talking avatar in **5–15 minutes**.

---

## Quick start

Need Node `>=22`. Then:

```bash
cp .env.example .env     # then open .env and set the required values:
                         #   PERXONA_API_BASE_URL      → ask your Perxona contact
                         #   PERXONA_CONNECT_EMAIL     → your Perxona service account email
                         #   PERXONA_CONNECT_PASSWORD  → your Perxona service account password
npm install
npm run dev              # open the URL it prints (default http://localhost:8088)
```

Pick an avatar / scene / voice, click **Launch** — the avatar speaks. The server signs in with its own credentials on the first
request; there's no login screen.

**No credentials yet?** Set `USE_MOCK=true` in `.env` and you get the full clickable flow with fake data.

---

## Contents

- [Quick start](#quick-start)
- [1. Purpose](#1-purpose)
- [2. Installation](#2-installation)
- [3. Running](#3-running)
- [4. API & SDK integration](#4-api--sdk-integration)
- [5. Acceptance](#5-acceptance)
- [6. Known limitations](#6-known-limitations)
- [7. Troubleshooting (FAQ)](#7-troubleshooting-faq)
- [Next steps](#next-steps)

---

## 1. Purpose

`server.mjs` is a thin Express backend that proxies the Perxona Connect API and keeps the bearer token server-side. `public/` is
a zero-dependency vanilla-JS frontend that drives the `<sv-presenter>` avatar Web Component loaded from Perxona's CDN. Together
they demonstrate the happy path end to end:

1. The server authenticates with its own Connect credentials (`.env`) — no browser login.
2. Load the catalog (avatars, scenes, voices).
3. Initialize the presenter with one combined config call.
4. Make the avatar speak — both from the browser and via the backend.

```text
.
├── server.mjs        # Express backend — proxies the Connect API, keeps your token server-side
├── public/
│   ├── index.html    # Landing page listing demos
│   └── demos/basic/  # This demo's UI — index.html, style.css, app.js (plain ESM, no build step)
└── docs/             # Reference — openapi.yaml + presenter-config.schema.json + presenter.d.ts
```

`docs/` is reference material for your IDE: `openapi.yaml` describes the Connect API, and `presenter-config.schema.json` /
`presenter.d.ts` describe the presenter contract (point your editor at `presenter.d.ts` for autocomplete and JSDoc on presenter
methods).

### Auth model

This sample uses **one set of server-side Connect credentials** (`PERXONA_CONNECT_EMAIL` / `PERXONA_CONNECT_PASSWORD` in `.env`)
for every visitor — there is no per-user login. The server logs in lazily on the first protected request, caches the bearer
token in memory, and reuses it for every subsequent call.

If the upstream API rejects the cached token (`401`/`403`) — for example because it expired — the server transparently logs in
again and retries the request once. The browser never sees the failure and never needs to re-authenticate. This convenience
model is meant for demos and hackathons: every browser hitting this server shares one upstream identity, which is not a
multi-tenant, production-grade auth design.

---

## 2. Installation

### Prerequisites

- **Node `>=22`** — check with `node --version`. Using nvm? Run `nvm use` in this directory (reads `.nvmrc`). If your Node is
  too old, `npm install` refuses to run and `npm run dev`/`npm start` fail with a message telling you what to upgrade to.
- **Perxona service account credentials** (email + password) with access to the Connect API — ask your Perxona contact. The same
  person provides the region-specific API base URL. The server uses these credentials directly — there is no browser sign-in.
- The credentials need permission to read avatars, scenes, and voices, and to mint TTS tokens.

### Steps

```bash
cp .env.example .env     # 1. create your local config
npm install              # 2. install dependencies
```

Then open `.env` and fill in the values:

| Variable                   | Required | Description                                                                                                                                                                                     |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERXONA_API_BASE_URL`     | ✅       | Region-specific Connect API base URL (e.g. `https://api.perxona.ai/eu`). From your Perxona contact.                                                                                             |
| `PERXONA_CONNECT_EMAIL`    | ✅       | Perxona service account email. The server signs in with this — no browser login.                                                                                                                |
| `PERXONA_CONNECT_PASSWORD` | ✅       | Perxona service account password.                                                                                                                                                               |
| `PORT`                     | —        | Port the app serves on (default `8088`).                                                                                                                                                        |
| `PRESENTER_URL`            | —        | URL of the Perxona presenter engine on the CDN. Defaults to the production engine. Override only if your Perxona contact provides a specific URL.                                               |
| `USE_MOCK`                 | —        | Set `true` to return documented response shapes without calling the real API — useful for UI work before you have credentials.                                                                  |
| `LLM_API_KEY`              | —        | Set (with optional `LLM_BASE_URL`, `LLM_MODEL`) to enable the chat panel. Any OpenAI-compatible endpoint works, including a local Ollama via `LLM_BASE_URL`. Leave blank to keep chat disabled. |

The server **exits at startup** if `PERXONA_API_BASE_URL`, `PERXONA_CONNECT_EMAIL`, or `PERXONA_CONNECT_PASSWORD` is missing. If
`.env` itself doesn't exist yet (you skipped step 1), `npm run dev`/`npm start` fail immediately with a reminder to run
`cp .env.example .env`. The same commands also fail fast with an upgrade hint if your Node version doesn't meet the `>=22`
requirement. Keep `.env` out of version control; update `.env.example` when you add a new variable.

---

## 3. Running

```bash
npm run dev     # start with live reload (node --watch)
# or
npm start       # start without watch
```

The terminal prints the local URL (e.g. `http://localhost:8088`), the API it targets, and whether it's in live or mock mode.
Open that URL, choose an avatar / scene / voice, and click **Launch** — the avatar appears and is ready to speak.

---

## 4. API & SDK integration

The backend exposes a small proxy API; the frontend calls it and drives the presenter SDK. The Connect bearer token lives only
in server memory and **never reaches the browser** — see ["Auth model"](#1-purpose) above.

### Backend API routes

| Method & path                                                        | Purpose                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                                    | Liveness + diagnostics (`upstream` reachability; reads `mock` in mock mode). Probes the backend on each call. |
| `GET /api/config`                                                    | Static per-process flags (`mock`, `chat` availability, `presenterUrl`). No upstream probe.                    |
| `POST /api/tts-token`                                                | Mint a speech token for a voice (`{ voice_id }`, optional).                                                   |
| `GET /api/voices`                                                    | List voices.                                                                                                  |
| `GET /api/avatars` · `/api/avatars/:id` · `/api/avatars/:id/motions` | List / detail / motions.                                                                                      |
| `GET /api/scenes` · `/api/scenes/:id`                                | List / detail.                                                                                                |
| `GET /api/profile?avatar=&scene=`                                    | **One call** returning the assembled `AvatarConfig` + `SceneConfig` the presenter needs.                      |
| `POST /api/presentation`                                             | Turn text into a presenter-ready `Performance` payload.                                                       |
| `POST /api/chat`                                                     | Opt-in LLM chat. Returns `501` until `LLM_API_KEY` is set.                                                    |

### SDK: the `<sv-presenter>` Web Component

The presenter is loaded from Perxona's CDN. `app.js` fetches `GET /api/config` on load, reads `presenterUrl`, and appends a
`<script type="module">` for it — `index.html` itself only declares the element:

```html
<sv-presenter hidden></sv-presenter>
```

`app.js` drives it through its JS API. The members used by this sample:

| Member                                                                  | Role                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `presenter.initialize(avatar, scene, speechToken)`                      | Boot the presenter with config + a TTS token.                                        |
| `presenter.resumeAudioPlayback()`                                       | Unlock browser autoplay. **Must run from a direct user gesture** (the Launch click). |
| `presenter.playPerformance(performance, { strategy: 'enqueueToPlay' })` | Queue and play a performance.                                                        |
| `presenter.interruptPerformance()`                                      | Stop the current performance and clear the queue.                                    |
| `presenter.refreshSpeechToken(token)`                                   | Swap in a fresh speech token.                                                        |
| event `PRESENTER_STATUS`                                                | `Uninitialized` → `Initializing` → `Ready`.                                          |
| event `SPEECH_TOKEN_EXPIRED`                                            | Fired when the speech token expires — refresh it.                                    |

### Initialization (the basic flow)

```js
// 1. Unlock audio from the user's Launch click (autoplay policy).
presenter.resumeAudioPlayback();

// 2. Fetch the combined config and a speech token in parallel.
const [{ avatar, scene }, { speech_token }] = await Promise.all([
  api(`/api/profile?avatar=${avatarId}&scene=${sceneId}`),
  api("/api/tts-token", {
    method: "POST",
    body: { voice_id: selectedVoiceId },
  }),
]);

// 3. Initialize — the presenter emits PRESENTER_STATUS as it becomes Ready.
presenter.initialize(avatar, scene, speech_token);
```

Once `PRESENTER_STATUS` reports `Ready`, make the avatar speak:

```js
presenter.playPerformance(performance, { strategy: "enqueueToPlay" });
```

This sample builds that `performance` through a single path with a fallback:

- **Backend-built** — every entry point (preset buttons, text box, and chat) calls `POST /api/presentation`, where a real app
  adds SSML, motion timing, and voice selection.
- **Client-built fallback** — if that request fails, the app assembles a TTS-only `Performance` in the browser, so you can see
  the presenter contract up close and the avatar still speaks.

### Error handling

The sample handles the common failure paths so you can see the patterns:

- **API errors** — the `api()` fetch wrapper throws on any non-2xx response with `status` and `data` attached, so callers can
  branch on the HTTP status. Catalog and presentation failures show a status message.
- **Expired Connect bearer token** — the server detects a `401`/`403` from upstream, logs in again with
  `PERXONA_CONNECT_EMAIL`/`PERXONA_CONNECT_PASSWORD`, and retries the request once. This is transparent to the browser; there's
  no re-login UI. If credentials are actually invalid, the browser sees a `401`/`403` and the status message tells you to check
  the server's `.env`.
- **Presentation endpoint failure** — if `POST /api/presentation` fails for a non-auth reason (error status or network failure),
  the app automatically **falls back** to a client-built, TTS-only performance (line only, no motions) so the avatar still
  speaks. Auth/setup failures are surfaced instead of silently falling back.
- **Expired speech token** — on `SPEECH_TOKEN_EXPIRED`, the app mints a new token for the _same_ voice and calls
  `presenter.refreshSpeechToken()`, so long sessions keep working.

### Contracts

This README keeps shapes short on purpose. When you need exact fields, go to the source of truth:

| What                                                                | Where                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Presenter config & `Performance` types                              | [`docs/presenter.d.ts`](docs/presenter.d.ts) (+ [`docs/presenter-config.schema.json`](docs/presenter-config.schema.json)) |
| Perxona Connect API (the service the proxy calls)                   | [`docs/openapi.yaml`](docs/openapi.yaml)                                                                                  |
| Local `/api/*` proxy (request body · response shape · status codes) | the route handlers in [`server.mjs`](server.mjs)                                                                          |

The local proxy intentionally **reshapes** a few responses, so don't assume `/api/*` matches `openapi.yaml` one-to-one:

- `POST /api/tts-token` → `{ speech_token }`.
- List endpoints normalize `avatar_id` / `scene_id` to `id`.
- `GET /api/profile` is bespoke: `{ avatar, scene, voices }`, assembled for `presenter.initialize()`.

#### Notes for agents

- `api(path, { method, body })` (in `public/demos/basic/app.js`) is the fetch wrapper for all `/api/*` calls: it JSON-encodes
  `body`, returns parsed JSON, and throws an `Error` with `status` and `data` attached on any non-2xx response.
- `avatarId`, `sceneId`, and `selectedVoiceId` are each the `id` field from the catalog list responses (the dropdown
  selections).
- The `avatar` / `scene` objects from `GET /api/profile` are passed verbatim to
  `presenter.initialize(avatar, scene, speech_token)` — see `docs/presenter.d.ts` for their shape.
- Treat any failure (error status or network error) from `POST /api/presentation` as a signal to fall back to a client-built,
  TTS-only `Performance`.

---

## 5. Acceptance

You've integrated the kit correctly when:

1. `npm run dev` starts without errors and prints the local URL.
2. `GET /api/health` returns `{ "status": "ok", ... }` — check it with `curl http://localhost:8088/api/health`.
3. The avatar / scene / voice dropdowns populate from the catalog with no sign-in step.
4. After **Launch**, the status reaches `✓ Ready` and the avatar renders on the stage.
5. A preset button (or the text box) makes the avatar speak.

No credentials yet? Set `USE_MOCK=true` in `.env` to walk through the whole UI flow against documented response shapes.

---

## 6. Known limitations

- **Sample, not production.** It demonstrates the happy path; it is not hardened, scaled, or feature-complete versus the full
  SDK.
- **Shared credential model.** Every browser hitting this server shares one Connect identity (the `.env` service account) —
  there is no per-user login or per-user isolation. Fine for demos and hackathons; not a multi-tenant auth design.
- **Chat is opt-in.** The chat panel stays disabled (and `POST /api/chat` returns `501`) until you set `LLM_API_KEY`.
- **Backend presentation is optional.** `POST /api/presentation` may be unavailable in your environment; the app falls back to
  client-built, TTS-only performances (no SSML/motion timing).
- **Minimal UI.** Plain vanilla JS with no framework or build step — intentionally, so the integration is easy to read.

---

## 7. Troubleshooting (FAQ)

**Server exits immediately with `PERXONA_API_BASE_URL is required` or
`PERXONA_CONNECT_EMAIL and PERXONA_CONNECT_PASSWORD are required`.** You haven't created `.env` or left a required value blank.
Run `cp .env.example .env` and fill in the API base URL and your Perxona service account credentials.

**Catalog fails to load with a `401`/`403` status message.** The server's `PERXONA_CONNECT_EMAIL`/`PERXONA_CONNECT_PASSWORD` are
wrong, or `PERXONA_API_BASE_URL` points at the wrong region. Confirm both with your Perxona contact. Check `GET /api/health` —
the `upstream` field shows whether the API is reachable.

**The avatar never appears, or there's no sound.** Audio playback must be unlocked by a real user gesture. Make sure you click
**Launch** (which calls `resumeAudioPlayback()`); audio won't start from page load alone. Watch for `PRESENTER_STATUS` to reach
`Ready`, and check the browser console for SDK errors.

**Chat returns `501 LLM_API_KEY not configured`.** Chat is disabled by default. Set `LLM_API_KEY` (and optionally
`LLM_BASE_URL`, `LLM_MODEL`) in `.env`, then restart. A local Ollama works via `LLM_BASE_URL=http://localhost:11434/v1`.

**The page won't load / port already in use.** Another process is using the port. Change `PORT` in `.env` (default `8088`) and
restart.

**`npm install` or `npm run dev`/`npm start` fails with an "ERROR: Node ... is too old" message.** You're on an older Node. This
kit requires **Node `>=22`** — run `nvm use` (reads `.nvmrc`) if you use nvm, or check `node --version` and upgrade at
[nodejs.org](https://nodejs.org/).

**The avatar loads but won't speak via the backend.** `POST /api/presentation` is likely unavailable in your environment. That's
expected — the app logs a warning and falls back to a client-built performance, so the avatar still speaks.

---

## Next steps

Once the happy path runs, make it yours:

- **Customize the UI.** Replace the preset buttons and layout in `public/demos/basic/app.js` and `public/demos/basic/index.html`
  with your own.
- **Build richer performances.** Add SSML, motion timing, and voice selection behind `POST /api/presentation` in `server.mjs` —
  the frontend already falls back gracefully when it's absent.
- **Get editor autocomplete.** Point your IDE at `docs/presenter.d.ts` for types and JSDoc on the presenter API.
- **Enable chat.** Set `LLM_API_KEY` (and optionally `LLM_BASE_URL`, `LLM_MODEL`) to turn on the chat panel.

---

## License

Apache License 2.0 — see [`LICENSE`](../../LICENSE).
