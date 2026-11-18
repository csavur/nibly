# Nibly - AI Fix & Rewrite

A Chrome extension (Manifest V3). Select text anywhere - an email in Gmail or Outlook, a form field, any web page - right-click, and choose **Nibly → Fix spelling and grammar** or **Nibly → Rewrite**. You pick the AI provider: a cloud API or a model running on your own machine.

## Features

- **Use your ChatGPT plan:** users with ChatGPT Go, Plus, Pro or Business click **Continue with ChatGPT** - no API key. Built on OpenAI's official [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) plan usage.
- **Or an API key / local model:** OpenAI, Anthropic (Claude), Google Gemini, OpenRouter, Ollama (local), LM Studio (local), and any OpenAI-compatible server (vLLM, llama.cpp server, LocalAI, Groq, Mistral, ...).
- **Replaces text in place** in text fields and rich editors (Gmail, Outlook web, etc.), with an **Undo** button (or Ctrl+Z / ⌘Z). The confirmation says how many mistakes were fixed, or that none were found.
- **Live progress:** the reply streams into the panel while the AI writes.
- **Review mode** (optional, and always for non-editable text): Fix results highlight exactly what changed; buttons for **Try again / Another version**, **Copy** and **Replace** (Enter).
- **Keyboard shortcuts:** Alt+Shift+F (Fix) and Alt+Shift+R (Rewrite); Ctrl+Shift+F / R on macOS. Changeable at `chrome://extensions/shortcuts`.
- **Helpful errors:** every error offers the next step - *Open settings* for setup problems, *Try again* for temporary ones, *Manage usage* for ChatGPT plan limits.
- **Guided settings page:** pick *ChatGPT plan*, *API key* or *Local model*; **Connect** grants access, loads the model list, picks a model and tests the connection in one click; a **Try it here** box to test Fix and Rewrite without leaving the page; a status pill shows whether Nibly is ready. Changes save automatically.
- Editable **Fix** and **Rewrite** instructions (under *Customize instructions*).
- Keys are stored in `chrome.storage.local` (this browser profile only, never synced). No servers of our own, no analytics.
- Asks for network access **only to the provider you choose**, at the moment you save.

## Try it locally

1. Open `chrome://extensions`, turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. The settings page opens. Choose a provider, enter the key (cloud) or start your local server, click **Test connection**, then **Save** and accept the permission prompt.
4. Select text on any page, right-click → **Nibly**.

After editing code, click the reload icon on the extension card in `chrome://extensions` and reload the page you are testing on.

### ChatGPT plan (Sign in with ChatGPT)

How it works, per OpenAI's spec for open-source / locally hosted clients:

- OAuth 2.0 authorization code + PKCE + OpenID Connect against `auth.openai.com`. First sign-in registers the app (`client_id=dynamic_agent_client`, `agent_name_hint=Nibly`) and OpenAI issues a per-user client id, which is reused for later sign-ins together with a random, non-identifying `ext_agent_host_id`.
- OpenAI only allows loopback redirects (`http://127.0.0.1:<port>/auth/callback`). An extension cannot open a port, so the settings page opens the sign-in in a popup window and reads the code from that window's URL when it is redirected there; nothing needs to listen on the port.
- The ID token is verified against OpenAI's published JWKS (signature, issuer, audience, expiry, nonce). Sign-in is rejected unless the user granted the `chatgpt.tokens.use.direct` (plan usage) scope.
- Requests go to the public Responses API (`POST https://api.openai.com/v1/responses`, `store: false`, `stream: true`). Never to ChatGPT's private `backend-api`.
- Access tokens last ~1 hour and are refreshed by the service worker only (refresh tokens rotate, so refreshes are serialized in one place).
- Required UI from OpenAI's guidelines: "Continue with ChatGPT" button, a first-sign-in "You're using your ChatGPT plan" notice, a "Using ChatGPT plan - Manage usage" indicator on every request, and "Usage limit reached" with a Manage usage link.

Anthropic (Claude Pro/Max) and Google (Gemini) do not allow their consumer subscriptions to be used by third-party apps, so those providers need an API key.

### Local models

- **Ollama:** install from ollama.com, run `ollama pull llama3.2` (or another model). If requests fail with HTTP 403, Ollama is rejecting the extension's origin; start it with `OLLAMA_ORIGINS="chrome-extension://*" ollama serve` (on macOS app: `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` and restart Ollama).
- **LM Studio:** load a model, start the server from the Developer tab, and enable CORS.

Small local models (1-3B) handle *Fix* well; *Rewrite* is noticeably better with 7B+ models.

## How it works

```
right-click menu ─► background.js (service worker)
                      │ 1. inject content.js into the clicked frame (activeTab + scripting)
                      │ 2. content.js captures the selection (input / contenteditable / static) and shows a spinner
                      │ 3. llm.js streams the reply from the provider (OpenAI or Anthropic wire format)
                      ▼ 4. content.js replaces the selection via execCommand("insertText") or shows a panel
```

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. No host permissions at install; per-provider origins are requested at runtime. |
| `src/background.js` | Context menu, orchestration, permission check, service-worker keep-alive. |
| `src/llm.js` | Provider client: Chat Completions, Anthropic Messages and Responses (ChatGPT plan) protocols, SSE streaming parser, error messages, output cleanup. |
| `src/chatgpt-auth.js` | Sign in with ChatGPT: PKCE flow, ID token verification, token storage and refresh. |
| `src/settings.js` | Provider presets, default prompts, storage. Add a provider here. |
| `src/content.js` | Injected on demand: selection capture, text replacement, Undo, in-page UI (shadow DOM). |
| `src/diff.js` | Word-level diff used to highlight Fix changes (shared by the page UI and settings page). |
| `src/options/` | Settings page. |

**Adding a provider:** if it speaks the OpenAI Chat Completions API, add an entry to `PROVIDERS` in `src/settings.js` - nothing else. A new wire format needs a request builder and a delta extractor in `src/llm.js`.

## Tests

```sh
npm install   # installs Puppeteer + Chrome for Testing (dev only)
npm test
```

- `test/llm.test.js` - provider client against a mock HTTP server (streaming, Anthropic + OpenAI formats, errors, non-streaming fallback, reasoning-tag stripping).
- `test/chatgpt.test.js` - Sign in with ChatGPT against a mock OpenAI auth server: authorize parameters, PKCE, state/nonce/signature checks, plan-scope requirement, refresh rotation and concurrency, sign-out, Responses API streaming and usage-limit errors.
- `test/e2e.test.js` - loads the real extension into Chrome for Testing and runs Fix/Rewrite on a textarea, a contenteditable editor and static text against a mock provider, including undo, preview mode and error handling, plus the full "Continue with ChatGPT" popup sign-in followed by a Fix billed to the plan.

## Publishing to the Chrome Web Store

See [store/PUBLISHING.md](store/PUBLISHING.md) for the step-by-step, the listing text and the permission justifications. The privacy policy is in [PRIVACY.md](PRIVACY.md).

```sh
npm run package   # -> dist/nibly-<version>.zip, upload this
```

Bump `version` in `manifest.json` for every upload.

## License

[MIT](LICENSE)
