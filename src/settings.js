// Settings model, provider presets and storage helpers.
import { CHATGPT } from "./chatgpt-auth.js";

// Settings live in chrome.storage.local (never sync) so API keys stay on this device.

/**
 * API protocol a provider speaks.
 * - "openai":    OpenAI Chat Completions (also Gemini, OpenRouter, Ollama, LM Studio, vLLM, ...)
 * - "anthropic": Anthropic Messages API
 * - "chatgpt":   OpenAI Responses API billed to the user's ChatGPT plan (Sign in with ChatGPT)
 * @typedef {"openai" | "anthropic" | "chatgpt"} ApiKind
 */

/**
 * How the user connects. Drives the settings page layout.
 * - "plan":  sign in with an AI subscription (ChatGPT plan)
 * - "api":   cloud provider with an API key
 * - "local": a model server on this computer
 * @typedef {"plan" | "api" | "local"} ConnectionGroup
 */

/**
 * @typedef {Object} ProviderPreset
 * @property {string} label       Shown in the provider picker.
 * @property {string} [name]      Used in messages ("Could not reach <name>"); defaults to label.
 * @property {ConnectionGroup} group
 * @property {ApiKind} api
 * @property {string} baseUrl
 * @property {string} model        Suggested default model; users can change it or load the live list.
 * @property {boolean} needsKey
 * @property {boolean} local
 * @property {boolean} [signIn]    Authenticates by signing in instead of an API key.
 * @property {string} [keyUrl]     Where users create an API key.
 * @property {boolean} [editableUrl] Show the base URL field (otherwise it is under "Advanced").
 */

/** @type {Record<string, ProviderPreset>} */
export const PROVIDERS = {
  chatgpt: {
    label: "ChatGPT plan",
    name: "ChatGPT",
    group: "plan",
    api: "chatgpt",
    baseUrl: CHATGPT.apiBase,
    model: "",
    needsKey: false,
    local: false,
    signIn: true,
  },
  openai: {
    label: "OpenAI",
    group: "api",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    needsKey: true,
    local: false,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    name: "Anthropic",
    group: "api",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-5-5",
    needsKey: true,
    local: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    label: "Google Gemini",
    group: "api",
    api: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    needsKey: true,
    local: false,
    keyUrl: "https://aistudio.google.com/apikey",
  },
  openrouter: {
    label: "OpenRouter",
    group: "api",
    api: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5-mini",
    needsKey: true,
    local: false,
    keyUrl: "https://openrouter.ai/keys",
  },
  custom: {
    label: "Other (OpenAI-compatible)",
    name: "Your AI provider",
    group: "api",
    api: "openai",
    baseUrl: "",
    model: "",
    needsKey: false,
    local: false,
    editableUrl: true,
  },
  ollama: {
    label: "Ollama",
    group: "local",
    api: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    needsKey: false,
    local: true,
    editableUrl: true,
  },
  lmstudio: {
    label: "LM Studio",
    group: "local",
    api: "openai",
    baseUrl: "http://localhost:1234/v1",
    model: "",
    needsKey: false,
    local: true,
    editableUrl: true,
  },
  localserver: {
    label: "Other local server",
    name: "Your local server",
    group: "local",
    api: "openai",
    baseUrl: "http://localhost:8080/v1",
    model: "",
    needsKey: false,
    local: true,
    editableUrl: true,
  },
};

/** @param {ConnectionGroup} group */
export function providersInGroup(group) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.group === group)
    .map(([id, p]) => ({ id, ...p }));
}

export const DEFAULT_PROMPTS = {
  fix: [
    "You are a meticulous proofreader.",
    "Correct spelling, grammar, punctuation and obvious typos in the user's text.",
    "Keep the original meaning, tone, wording, language and formatting (line breaks, lists, greetings, signatures) as much as possible.",
    "Do not add, remove or rephrase content beyond what is needed to fix errors.",
    "Reply with only the corrected text - no explanations, no quotes, no preamble.",
  ].join(" "),
  rewrite: [
    "You are an expert writing assistant.",
    "Rewrite the user's text so it is clear, concise, natural and professional, suitable for an email.",
    "Keep the original meaning, intent, language and any names, dates, numbers and links.",
    "Keep the overall structure (greeting, paragraphs, sign-off) when present.",
    "Reply with only the rewritten text - no explanations, no quotes, no preamble.",
  ].join(" "),
};

/**
 * @typedef {Object} Settings
 * @property {string} provider                          Key of PROVIDERS.
 * @property {Record<string, {apiKey: string, baseUrl: string, model: string}>} providerConfig
 *           Per-provider values, so switching providers keeps each one's key and model.
 * @property {Record<ConnectionGroup, string>} groupProvider
 *           Last provider chosen in each group, restored when the user switches groups.
 * @property {{fix: string, rewrite: string}} prompts
 * @property {boolean} previewBeforeReplace
 */

/** @returns {Settings} */
export function defaultSettings() {
  /** @type {Settings["providerConfig"]} */
  const providerConfig = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    providerConfig[id] = { apiKey: "", baseUrl: p.baseUrl, model: p.model };
  }
  return {
    provider: "chatgpt",
    providerConfig,
    groupProvider: { plan: "chatgpt", api: "openai", local: "ollama" },
    prompts: { ...DEFAULT_PROMPTS },
    previewBeforeReplace: false,
  };
}

const STORAGE_KEY = "settings";

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  const { [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY);
  const defaults = defaultSettings();
  if (!stored) return defaults;
  // Merge so settings saved by older versions pick up new providers and fields.
  const providerConfig = { ...defaults.providerConfig };
  for (const [id, cfg] of Object.entries(stored.providerConfig ?? {})) {
    if (id in providerConfig) providerConfig[id] = { ...providerConfig[id], ...cfg };
  }
  return {
    ...defaults,
    ...stored,
    provider: stored.provider in PROVIDERS ? stored.provider : defaults.provider,
    providerConfig,
    groupProvider: { ...defaults.groupProvider, ...stored.groupProvider },
    prompts: { ...defaults.prompts, ...stored.prompts },
  };
}

/** @param {Settings} settings */
export async function saveSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

/**
 * Resolve the effective connection details for the active provider.
 * @param {Settings} settings
 */
export function activeConnection(settings) {
  const preset = PROVIDERS[settings.provider];
  const cfg = settings.providerConfig[settings.provider];
  return {
    providerId: settings.provider,
    label: preset.name ?? preset.label,
    api: preset.api,
    baseUrl: normalizeBaseUrl(preset.signIn ? preset.baseUrl : cfg.baseUrl || preset.baseUrl),
    apiKey: cfg.apiKey.trim(),
    model: cfg.model.trim(),
    needsKey: preset.needsKey,
    signIn: !!preset.signIn,
  };
}

/** @param {string} url */
export function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Host permission pattern ("https://api.openai.com/*") for a base URL.
 * @param {string} baseUrl
 */
export function originPattern(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}
