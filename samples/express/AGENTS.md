# Repository Guidelines

The **Perxona Connect Kit** — a minimal, self-contained sample that integrates the Perxona Connect API and the `<sv-presenter>`
avatar Web Component. Use it as a starting point for your project.

## Architecture

A minimal full-stack sample: a thin Express proxy plus a zero-dependency browser UI that drives the Perxona `<sv-presenter>`
avatar Web Component.

### `server.mjs` — token minting + catalog proxy

The server does two jobs:

1. Auth — it authenticates itself with your Connect service credentials (`PERXONA_CONNECT_EMAIL` / `PERXONA_CONNECT_PASSWORD`
   in `.env`); there is no browser login. It logs in lazily on the first protected request, caches the bearer token in memory,
   and transparently re-logs in and retries once if upstream rejects the cached token (e.g. it expired). `GET /api/connect-token`
   validates that cached token before handing it to the browser — from there, `<sv-presenter>` talks to the Connect API directly
   (see "Auth model" in README).
2. Catalog proxy — `GET /api/avatars`, `/api/scenes`, `/api/voices` (+ `:id`/`:id/motions` detail routes) stay server-proxied
   purely to populate the picker dropdowns; they normalize a couple of field names (`avatar_id`/`scene_id` → `id`) but otherwise
   pass upstream responses through unchanged.

`/api/chat` is opt-in — it returns `501` until you set `LLM_API_KEY`, then forwards to an OpenAI-compatible `/chat/completions`
endpoint. Ollama works via `LLM_BASE_URL`.

### `public/demos/basic/app.js` — vanilla JS, no build step

Zero dependencies, no bundler. The presenter is a Web Component loaded from Perxona's CDN; `app.js` fetches `GET /api/config` on
load to get `presenterUrl`, dynamically appends a `<script type="module">` for it, then drives `<sv-presenter>` through its JS
API and listens for its events. `public/index.html` is a landing page linking to each demo under `public/demos/`.

Two presenter details worth knowing:

- `presenter.resumeAudioPlayback()` must run from a direct user gesture (the Launch click) to satisfy browser autoplay policy
  before audio starts.
- `presenter.initialize(connectToken, target)` resolves the avatar/scene/voice and mints its own speech token directly against
  the Connect API — the token refresh cycle is entirely internal to the widget now (no `SPEECH_TOKEN_EXPIRED` handling needed
  in `app.js`).

Every entry point — the preset buttons, the text box, and chat — goes through `speak`, which just calls
`presenter.present(text)`: the widget builds the Performance (speech + motion) internally via the Connect API, using the
avatar/voice resolved by `initialize()`. There is no server-side presentation-building route or client-built fallback anymore.

### `docs/` — contract reference

`openapi.yaml` and `presenter.d.ts` describe the Connect API and the presenter contract. Treat
them as read-only reference — point your IDE at `presenter.d.ts` for autocomplete and JSDoc on presenter methods.

## Project Structure

- `server.mjs` — Express backend. Mints the Connect bearer token (`GET /api/connect-token`) and proxies catalog reads; it no
  longer builds presenter-ready payloads (`<sv-presenter>` resolves those itself against the Connect API using the token).
- `public/` — the browser UI: `index.html` is a landing page listing demos; each demo (e.g. `demos/basic/`) has its own
  `index.html`, `style.css`, and `app.js` (plain ESM, no build step).
- `docs/` — reference material: `openapi.yaml` (the Connect API), plus `presenter.d.ts` (the
  presenter contract, handy for IDE autocomplete).

## Getting Started

Requires Node `>=22` — run `nvm use` (reads `.nvmrc`) if you use nvm, or install Node 22+ directly.

1. `cp .env.example .env`
2. Fill in `PERXONA_API_BASE_URL`, `PERXONA_CONNECT_EMAIL`, and `PERXONA_CONNECT_PASSWORD` — ask your Perxona contact for the
   API URL and a service account.
3. `npm install` — fails fast if your Node version is too old (`engine-strict` in `.npmrc`).
4. `npm run dev` — runs with live reload (or `npm start` without watch). The app serves on the port from your `.env` (`8088` by
   default). If your Node is too old or you skipped step 1, `dev`/`start` fail fast with an actionable message instead of a
   cryptic error.

## Coding Style

Modern ESM JavaScript (`"type": "module"`) and Node built-ins. Follow `.editorconfig`: UTF-8, LF line endings, 2-space
indentation, trimmed trailing whitespace, and final newlines. The frontend is dependency-free vanilla JS by design — keep it
that way unless you have a concrete reason to add a build step.

## Configuration

Required (the server exits at startup if either is missing):

- `PERXONA_API_BASE_URL` — region-specific Connect API base URL.
- `PERXONA_CONNECT_EMAIL` / `PERXONA_CONNECT_PASSWORD` — your Perxona service account. The server signs in with these; there is
  no browser login.

Optional: `PORT`; and `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL`) to enable the chat panel. Keep secrets in `.env` and never
commit it; update `.env.example` when you add a new variable.
