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

`/api/chat` and `/api/demo-script` are opt-in — they return a disabled response until you set `LLM_API_KEY`. Use
`LLM_PROVIDER=openai` for Chat Completions (including Ollama and other compatible endpoints), or
`LLM_PROVIDER=anthropic` for Claude's Messages API. The browser-facing chat response remains OpenAI-shaped so both providers
use the same frontend code.

Chatbot CRUD routes let you create and manage Connect chatbots from the sample server:

| Route                                | Description                                                                |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `GET /api/chatbots`                  | List all chatbots                                                          |
| `POST /api/chatbots`                 | Create a chatbot (`{ name, custom_instructions?, tools? }`)                |
| `GET /api/chatbots/:id`              | Get chatbot detail including tools                                         |
| `PATCH /api/chatbots/:id`            | Update name, instructions, or tools                                        |
| `DELETE /api/chatbots/:id`           | Delete a chatbot                                                           |
| `POST /api/chatbots/:id/knowledge`   | Upload a knowledge file (`{ filename, content_base64, mime_type? }`)       |
| `DELETE /api/chatbots/:id/knowledge` | Remove the knowledge file                                                  |
| `POST /api/chatbots/:id/chat`        | Chat with a chatbot (`{ messages: [...] }`) → `{ id, status, reply_text }` |

Create and update are forwarded as `multipart/form-data` — send plain JSON from the browser; the proxy handles re-encoding.
Knowledge uploads accept `.txt`, `.pdf`, `.doc`, `.docx`, `.csv` files encoded as base64 in the JSON body.
Tools (function-calling definitions for external APIs) are documented in `public/demos/chatbot/connect-chat-bot-function-tools.md`.

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

### Direct presentation API

`POST /api/v1/connect/presentation` is a direct Connect API endpoint; the sample deliberately does not proxy it. Its optional
`emotion` and `intensity` fields guide facial-expression selection for suggested motions and soft-rank motion candidates. When
both are omitted, no facial expression is attached. Use `intensity`, not `intens`; its accepted values are `low`, `neutral`,
and `high`. Consult `docs/openapi.yaml` for the accepted `emotion` values and complete schema. Keep direct calls server-side
so a service bearer token is not exposed in browser code.

### `docs/` — contract reference

`openapi.yaml` describes the Connect API — treat it as read-only reference. The presenter contract
(`IPresentationWidget`) isn't in `docs/`; it's already installed as `@perxona/presenter-types` (see `package.json`) — point
your IDE at that package for autocomplete and JSDoc on presenter methods.

## Project Structure

- `server.mjs` — Express backend. Mints the Connect bearer token (`GET /api/connect-token`) and proxies catalog reads; it no
  longer builds presenter-ready payloads (`<sv-presenter>` resolves those itself against the Connect API using the token).
- `public/` — the browser UI: `index.html` is a landing page listing demos; each demo (e.g. `demos/basic/`) has its own
  `index.html`, `style.css`, and `app.js` (plain ESM, no build step).
- `docs/` — reference material: `openapi.yaml` (the Connect API).

## Getting Started

Requires Node `>=22` — run `nvm use` (reads `.nvmrc`) if you use nvm, or install Node 22+ directly.

1. `cp .env.example .env`
2. Fill in `PERXONA_API_BASE_URL`, `PERXONA_CONNECT_EMAIL`, and `PERXONA_CONNECT_PASSWORD` — use the Connect `signup` and
   `confirm-signup` API to register an account (see Account sign-up below). Set `PERXONA_API_BASE_URL` to your region's URL
   (e.g. `https://console.perxona.ai/asia`).
3. `npm install` — fails fast if your Node version is too old (`engine-strict` in `.npmrc`).
4. `npm run dev` — runs with live reload (or `npm start` without watch). The app serves on the port from your `.env` (`8083` by
   default). If your Node is too old or you skipped step 1, `dev`/`start` fail fast with an actionable message instead of a
   cryptic error.

## Coding Style

Modern ESM JavaScript (`"type": "module"`) and Node built-ins. Follow `.editorconfig`: UTF-8, LF line endings, 2-space
indentation, trimmed trailing whitespace, and final newlines. The frontend is dependency-free vanilla JS by design — keep it
that way unless you have a concrete reason to add a build step.

## Configuration

Required (the server exits at startup if either is missing):

- `PERXONA_API_BASE_URL` — region-specific Connect API base URL.
- `PERXONA_CONNECT_EMAIL` / `PERXONA_CONNECT_PASSWORD` — your Perxona Connect account credentials. The server signs in with
  these; there is no browser login.

### Account sign-up

If you do not have a Connect account, create one through the Connect Auth API before running this sample:

1. **Request a sign-up token** — `POST /api/v1/connect/auth/signup` with `{ "email": "you@example.com" }`. A token is sent to
   the email address.
2. **Confirm and set a password** — `POST /api/v1/connect/auth/confirm-signup` with `{ "token": "<from email>", "username":
"your-username", "password": "your-password" }`. Returns `{ "access_token": "..." }` on success.
3. Use the email and password you set as `PERXONA_CONNECT_EMAIL` / `PERXONA_CONNECT_PASSWORD` in `.env`.

Forgot your password? Use `POST /api/v1/connect/auth/forgot-password` with `{ "email": "..." }` to start the reset flow, then
`POST /api/v1/connect/auth/reset-password` with the token from the email. See the Developer Handbook for full API details.

Optional: `PORT`; and `LLM_API_KEY` (+ `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`) to enable the chat panel. Keep secrets in
`.env` and never commit it; update `.env.example` when you add a new variable.
