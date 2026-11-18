# Nibly privacy policy

_Last updated: 2026-11-18_

Nibly is a browser extension that fixes or rewrites text you select, using an AI provider that **you** choose and configure.

## What data Nibly handles

- **Text you select** when you choose "Fix" or "Rewrite" from the right-click menu. Only that selection is read, only at that moment.
- **Your settings:** the chosen provider, its base URL, model name, API key, and your custom instructions.
- **If you sign in with ChatGPT:** the sign-in tokens OpenAI issues to Nibly and your ChatGPT account's email address and name (shown in the settings page so you know which account is connected). Nibly cannot see your ChatGPT conversations or other account data.

## Where it goes

- The selected text is sent **directly from your browser to the AI provider you configured** (for example OpenAI - including through your ChatGPT plan when you sign in with ChatGPT - Anthropic, Google, OpenRouter, or a server running on your own computer such as Ollama or LM Studio). It is not sent anywhere else.
- When you use a cloud provider, that provider's own privacy policy and data retention terms apply to the text you send it. When you use a local provider, the text does not leave your computer.
- The developer of Nibly runs **no servers** and receives **no data**: no text, no keys, no usage statistics, no analytics, no crash reports.

## Storage

- Settings, including API keys and ChatGPT sign-in tokens, are stored with `chrome.storage.local` in your browser profile on this device. They are not synced to other devices and are deleted when you remove the extension.
- Selected text and AI results are not stored; they exist only in memory while the request runs.

## Permissions

- **Context menus** - adds the Fix / Rewrite entries.
- **Active tab + scripting** - after you click a menu entry, reads the selected text in that tab and puts the result back. Nibly cannot read pages you have not invoked it on.
- **Storage** - saves your settings.
- **Access to your provider's address** - requested when you save settings, only for the provider URL you entered, so the extension can send requests to it.
- **Sign in with ChatGPT** - access to `auth.openai.com` and `api.openai.com` for sign-in and requests, and to `127.0.0.1`, which is where OpenAI sends you back after signing in (Nibly reads the sign-in code from that address; nothing is sent to your computer's network).

You can sign out in the Nibly settings at any time, and disconnect Nibly from your ChatGPT account in ChatGPT settings.

## Not done

Nibly does not sell or transfer user data to third parties (beyond sending your selected text to the provider you chose, at your request), does not use it for advertising or creditworthiness, and does not use it for any purpose unrelated to fixing or rewriting your text.

## Contact

Questions: <!-- TODO: add a support email or URL before publishing -->
