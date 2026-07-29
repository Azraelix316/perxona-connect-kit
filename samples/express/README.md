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

---

## Contents

- [Perxona Connect Kit](#perxona-connect-kit)
  - [Quick start](#quick-start)
  - [Contents](#contents)
  - [1. Purpose](#1-purpose)
    - [Auth model](#auth-model)
  - [2. Installation](#2-installation)
    - [Prerequisites](#prerequisites)
    - [Steps](#steps)
  - [3. Running](#3-running)
  - [4. API \& SDK integration](#4-api--sdk-integration)
    - [Backend API routes](#backend-api-routes)
    - [SDK: the `<sv-presenter>` Web Component](#sdk-the-sv-presenter-web-component)
    - [Initialization (the basic flow)](#initialization-the-basic-flow)
    - [Error handling](#error-handling)
    - [Contracts](#contracts)
      - [Notes for agents](#notes-for-agents)
  - [5. Acceptance](#5-acceptance)
  - [6. Known limitations](#6-known-limitations)
  - [7. Troubleshooting (FAQ)](#7-troubleshooting-faq)
  - [Next steps](#next-steps)
  - [License](#license)

---

## 1. Purpose

`server.mjs` is a thin Express backend that authenticates with the Connect API and hands the browser a short-lived bearer token.
`public/` is a zero-dependency vanilla-JS frontend that drives the `<sv-presenter>` avatar Web Component loaded from Perxona's
CDN — the component talks to the Connect API directly using that token. Together they demonstrate the happy path end to end:

1. The server authenticates with its own Connect credentials (`.env`) — no browser login.
2. Load the catalog (avatars, scenes, voices) through the server's proxy.
3. Fetch a Connect token and initialize the presenter with it plus the picked avatar/scene/voice — the presenter resolves the
   rest directly against the Connect API.
4. Make the avatar speak — one call, the presenter handles synthesis and motion playback.

```text
.
├── server.mjs        # Express backend — proxies catalog reads and mints the Connect bearer token
├── public/
│   ├── index.html    # Landing page listing demos
│   └── demos/basic/  # This demo's UI — index.html, style.css, app.js (plain ESM, no build step)
└── docs/             # Reference — openapi.yaml + presenter.d.ts
```

`docs/` is reference material for your IDE: `openapi.yaml` describes the Connect API, and
`presenter.d.ts` describes the presenter contract (point your editor at `presenter.d.ts` for autocomplete and JSDoc on presenter
methods).

### Auth model

This sample uses **one set of server-side Connect credentials** (`PERXONA_CONNECT_EMAIL` / `PERXONA_CONNECT_PASSWORD` in `.env`)
for every visitor — there is no per-user login. The server logs in lazily on the first protected request, caches the bearer
token in memory, and reuses it for every subsequent call. `GET /api/connect-token` validates the cached bearer before handing
it to the browser, which passes it straight into `presenter.initialize(connectToken, target)` — from that point on,
`<sv-presenter>` talks to the Connect API directly for avatar/scene resolution, speech synthesis, and token refresh.

If the upstream API rejects the cached token (`401`/`403`) during a server-proxied call or connect-token validation — for
example because it expired — the server transparently logs in again and retries once. This convenience model is meant for demos
and hackathons: every browser hitting this server shares one upstream identity, which is not a multi-tenant, production-grade
auth design. Note also that once a `connect_token` reaches the browser, it is a real bearer credential for the shared identity
for its lifetime — wiring `refreshConnectToken`/`CONNECT_TOKEN_EXPIRED` for long sessions is a known gap (see
[Known limitations](#6-known-limitations)).

---

## 2. Installation

### Prerequisites

- **Node `>=22`** — check with `node --version`. Using nvm? Run `nvm use` in this directory (reads `.nvmrc`). If your Node is
  too old, `npm install` refuses to run and `npm run dev`/`npm start` fail with a message telling you what to upgrade to.
- **Perxona service account credentials** (email + password) with access to the Connect API — ask your Perxona contact. The same
  person provides the region-specific API base URL. The server uses these credentials directly — there is no browser sign-in.
- The credentials need permission to read avatars, scenes, and voices, and to mint TTS tokens and presentations \u2014 the browser
  calls all of those directly against the Connect API once it has the `connect_token` (see ["Auth model"](#auth-model)).

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
In live mode, open that URL, choose an avatar / scene / voice, and click **Launch** — the avatar appears and is ready to speak.
Mock mode supports catalog browsing only.

---

## 4. API & SDK integration

The backend exposes a small proxy API for catalog reads plus one endpoint that mints the Connect bearer token; the frontend
calls it and drives the presenter SDK. See ["Auth model"](#auth-model) above for how the token flows from server to browser to
the Connect API.

### Backend API routes

| Method & path                                                        | Purpose                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                                    | Liveness + diagnostics (`upstream` reachability; reads `mock` in mock mode). Probes the backend on each call. |
| `GET /api/config`                                                    | Static per-process flags (`mock`, `chat` availability, `presenterUrl`). No upstream probe.                    |
| `GET /api/connect-token`                                             | Mint/reuse the shared Connect bearer JWT — pass straight into `presenter.initialize()`.                       |
| `GET /api/voices`                                                    | List voices.                                                                                                  |
| `GET /api/avatars` · `/api/avatars/:id` · `/api/avatars/:id/motions` | List / detail / motions.                                                                                      |
| `GET /api/scenes` · `/api/scenes/:id`                                | List / detail.                                                                                                |
| `POST /api/chat`                                                     | Opt-in LLM chat. Returns `501` until `LLM_API_KEY` is set.                                                    |

### SDK: the `<sv-presenter>` Web Component

The presenter is loaded from Perxona's CDN. `app.js` fetches `GET /api/config` on load, reads `presenterUrl`, and appends a
`<script type="module">` for it — `index.html` itself only declares the element:

```html
<sv-presenter hidden></sv-presenter>
```

`app.js` drives it through its JS API. The members used by this sample:

| Member                                       | Role                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `presenter.initialize(connectToken, target)` | Boot the presenter: resolves `target` and mints its own speech token against the Connect API.  |
| `presenter.resumeAudioPlayback()`            | Unlock browser autoplay. **Must run from a direct user gesture** (the Launch click).           |
| `presenter.present(content)`                 | Synthesize `content` into speech and play it back on the avatar.                               |
| `presenter.presentWithAudio(audio, content)` | Play back a supplied speech audio buffer with `content` as the transcript for the performance. |
| `presenter.playMotion(motionId)`             | Resolve, preload, and play one body motion independently from the speech queue.                |
| `presenter.interruptPresentation()`          | Stop the current performance and clear the queue.                                              |
| event `PRESENTER_STATUS`                     | `Uninitialized` → `Initializing` → `Ready`.                                                    |

### Initialization (the basic flow)

```js
// 1. Unlock audio from the user's Launch click (autoplay policy).
await presenter.resumeAudioPlayback();

// 2. Fetch the Connect bearer token this server minted.
const { connect_token } = await api("/api/connect-token");

// 3. Initialize — the presenter resolves avatarId/sceneId/voiceId against the
//    Connect API itself and emits PRESENTER_STATUS as it becomes Ready.
await presenter.initialize(connect_token, {
  avatarId,
  sceneId,
  voiceId, // optional — omit to use presentWithAudio() instead of present()
});
```

Once `PRESENTER_STATUS` reports `Ready`, make the avatar speak:

```js
const result = await presenter.present("Hello!");

// Play a body motion without waiting for or changing the speech queue.
const motionResult = await presenter.playMotion("known-motion-id");
```

`present()` builds the speech + motion performance internally via the Connect API, using the avatar/voice resolved by
`initialize()` — there is no client-built fallback anymore (see [Known limitations](#6-known-limitations)).

### Error handling

The sample handles the common failure paths so you can see the patterns:

- **API errors** — the `api()` fetch wrapper throws on any non-2xx response with `status` and `data` attached, so callers can
  branch on the HTTP status. Catalog and connect-token failures show a status message.
- **Expired Connect bearer token (server-proxied catalog calls)** — the server detects a `401`/`403` from upstream, logs in
  again with `PERXONA_CONNECT_EMAIL`/`PERXONA_CONNECT_PASSWORD`, and retries the request once. This is transparent to the
  browser; there's no re-login UI. If credentials are actually invalid, the browser sees a `401`/`403` and the status message
  tells you to check the server's `.env`.
- **`initialize()`/`present()` failures** — `initialize()` rejects if the Connect API call to resolve the target fails (e.g.
  unknown avatar/scene id); the click handler catches it and shows a status message. `present()` never rejects — it resolves
  with a `PresentationResult` whose `success` is `false` and `code`/`message` explain why (e.g. no target resolved yet).

### Contracts

This README keeps shapes short on purpose. When you need exact fields, go to the source of truth:

| What                                                                                                | Where                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Presenter contract (`IPresentationWidget`, `PresentationTarget`, `PresentationResult`, event types) | [`docs/presenter.d.ts`](docs/presenter.d.ts)     |
| Perxona Connect API (the service the presenter and this proxy call)                                 | [`docs/openapi.yaml`](docs/openapi.yaml)         |
| Local `/api/*` proxy (request body · response shape · status codes)                                 | the route handlers in [`server.mjs`](server.mjs) |

The local proxy intentionally **reshapes** a few responses, so don't assume `/api/*` matches `openapi.yaml` one-to-one:

- `GET /api/connect-token` → `{ connect_token }`.
- List endpoints normalize `avatar_id` / `scene_id` to `id`.

#### Notes for agents

- `api(path, { method, body })` (in `public/demos/basic/app.js`) is the fetch wrapper for all `/api/*` calls: it JSON-encodes
  `body`, returns parsed JSON, and throws an `Error` with `status` and `data` attached on any non-2xx response.
- `avatarId`, `sceneId`, and `voiceId` are each the `id` field from the catalog list responses (the dropdown selections) — they
  are passed straight into the `PresentationTarget` object handed to `presenter.initialize()`.
- `connect_token` from `GET /api/connect-token` is a real bearer credential once it reaches the browser — don't log it, and
  don't assume it's safe to persist past the page session (see ["Auth model"](#auth-model)).

---

## 5. Acceptance

You've integrated the kit correctly when:

1. `npm run dev` starts without errors and prints the local URL.
2. `GET /api/health` returns `{ "status": "ok", ... }` — check it with `curl http://localhost:8088/api/health`.
3. The avatar / scene / voice dropdowns populate from the catalog with no sign-in step.
4. After **Launch**, the status reaches `✓ Ready` and the avatar renders on the stage.
5. A preset button (or the text box) makes the avatar speak.

---

## 6. Known limitations

- **Sample, not production.** It demonstrates the happy path; it is not hardened, scaled, or feature-complete versus the full
  SDK.
- **Shared credential model.** Every browser hitting this server shares one Connect identity (the `.env` service account) —
  there is no per-user login or per-user isolation. Fine for demos and hackathons; not a multi-tenant auth design.
- **Mock mode is catalog-only.** It supplies fake catalog data but cannot emulate the presenter’s direct Connect API calls, so
  Launch and playback are disabled until live credentials are configured.
- **`refreshConnectToken`/`CONNECT_TOKEN_EXPIRED` are not wired up.** The presenter dispatches `CONNECT_TOKEN_EXPIRED` when the
  Connect API rejects the token it's using; this sample doesn't listen for it or call `presenter.refreshConnectToken()` in
  response, so a long-running session can go stale once the shared `connect_token` expires — reload the page to mint a fresh
  one via `GET /api/connect-token`.
- **Chat is opt-in.** The chat panel stays disabled (and `POST /api/chat` returns `501`) until you set `LLM_API_KEY`.
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

**The avatar initializes but won't speak.** `present()` resolves with a `PresentationResult` whose `success` is `false` —
check the status message it surfaces (`code`/`message`) for why (e.g. no target resolved yet, or the Connect API rejected the
presentation request). Also confirm the presenter reached `Ready` first.

---

## Next steps

Once the happy path runs, make it yours:

- **Customize the UI.** Replace the preset buttons and layout in `public/demos/basic/app.js` and `public/demos/basic/index.html`
  with your own.
- **Get editor autocomplete.** Point your IDE at `docs/presenter.d.ts` for types and JSDoc on the presenter API.
- **Enable chat.** Set `LLM_API_KEY` (and optionally `LLM_BASE_URL`, `LLM_MODEL`) to turn on the chat panel.

---

## License

Apache License 2.0 — see [`LICENSE`](../../LICENSE).
