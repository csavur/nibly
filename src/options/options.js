import {
  CHATGPT_ORIGINS,
  ChatGptAuthError,
  beginSignIn,
  completeSignIn,
  isCallbackUrl,
  loadSession,
  markWelcomed,
  signOut,
} from "../chatgpt-auth.js";
import {
  DEFAULT_PROMPTS,
  PROVIDERS,
  activeConnection,
  loadSettings,
  originPattern,
  providersInGroup,
  saveSettings,
} from "../settings.js";

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

const PROVIDER_NOTES = {
  ollama:
    "Install <a href='https://ollama.com' target='_blank' rel='noopener'>Ollama</a> and download a model, for example " +
    "<code>ollama pull llama3.2</code>. If connecting fails with “refused” (HTTP 403), start Ollama with " +
    "<code>OLLAMA_ORIGINS=chrome-extension://*</code>.",
  lmstudio: "In LM Studio, load a model, open the Developer tab, start the server and turn on CORS.",
  localserver: "Any local server with an OpenAI-compatible API, such as llama.cpp, vLLM or LocalAI.",
  custom: "Any service with an OpenAI-compatible API, such as Groq, Mistral, Together or your own proxy.",
};

/** @type {import("../settings.js").Settings} */
let settings;
/** Model lists per provider id, loaded from the provider. */
const modelLists = /** @type {Record<string, {id: string, label: string}[]>} */ ({});
/** Providers for which the user chose to type a model id instead of picking from the list. */
const manualModel = new Set();
/** Aborts an in-progress ChatGPT sign-in (closes its window). */
let cancelSignIn = /** @type {(() => void) | null} */ (null);

// ---------------------------------------------------------------------------------------------
// Setup

async function init() {
  settings = await loadSettings();
  $("version").textContent = `Version ${chrome.runtime.getManifest().version}`;
  $("preview").checked = settings.previewBeforeReplace;
  $("promptFix").value = settings.prompts.fix;
  $("promptRewrite").value = settings.prompts.rewrite;
  bindEvents();
  await renderConnection();
  renderShortcuts();
  await refreshStatus();
  autoLoadModels();
}

function bindEvents() {
  for (const opt of document.querySelectorAll(".seg-opt")) {
    opt.addEventListener("click", () => selectGroup(opt.dataset.group));
    opt.addEventListener("keydown", onSegKeydown);
  }
  $("provider").addEventListener("change", () => {
    settings.provider = $("provider").value;
    settings.groupProvider[group()] = settings.provider;
    afterProviderChange();
  });

  const cfgInput = (/** @type {string} */ id, /** @type {"apiKey" | "baseUrl"} */ key) =>
    $(id).addEventListener("input", () => {
      cfg()[key] = $(id).value.trim();
      setStatus("connectStatus", "");
      saveSoon();
      refreshStatus();
    });
  cfgInput("apiKey", "apiKey");
  cfgInput("baseUrl", "baseUrl");
  cfgInput("baseUrlAdv", "baseUrl");
  $("toggleKey").addEventListener("click", () => {
    const show = $("apiKey").type === "password";
    $("apiKey").type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "Hide" : "Show";
    $("toggleKey").setAttribute("aria-label", show ? "Hide key" : "Show key");
  });

  $("modelSelect").addEventListener("change", () => setModel($("modelSelect").value));
  $("modelInput").addEventListener("input", () => setModel($("modelInput").value.trim(), { quiet: true }));
  $("modelManual").addEventListener("click", () => {
    if (manualModel.has(settings.provider)) manualModel.delete(settings.provider);
    else manualModel.add(settings.provider);
    renderModels();
    (manualModel.has(settings.provider) ? $("modelInput") : $("modelSelect")).focus();
  });
  $("refreshModels").addEventListener("click", onRefreshModels);
  $("connect").addEventListener("click", onConnect);

  $("chatgptSignIn").addEventListener("click", onChatGptSignIn);
  $("chatgptCancel").addEventListener("click", () => cancelSignIn?.());
  $("chatgptSignOut").addEventListener("click", onChatGptSignOut);
  $("welcomeOk").addEventListener("click", () => $("welcome").close());
  $("welcome").addEventListener("close", () => markWelcomed());

  $("tryFix").addEventListener("click", () => onTry("fix"));
  $("tryRewrite").addEventListener("click", () => onTry("rewrite"));
  $("tryCopy").addEventListener("click", onTryCopy);
  $("tryUse").addEventListener("click", onTryUse);
  $("editShortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

  $("preview").addEventListener("change", () => {
    settings.previewBeforeReplace = $("preview").checked;
    saveNow();
  });
  for (const [id, key] of [["promptFix", "fix"], ["promptRewrite", "rewrite"]]) {
    $(id).addEventListener("input", () => {
      settings.prompts[key] = $(id).value.trim() || DEFAULT_PROMPTS[key];
      saveSoon();
    });
  }
  for (const btn of document.querySelectorAll("[data-reset]")) {
    btn.addEventListener("click", () => {
      const key = /** @type {"fix" | "rewrite"} */ (btn.dataset.reset);
      $(key === "fix" ? "promptFix" : "promptRewrite").value = DEFAULT_PROMPTS[key];
      settings.prompts[key] = DEFAULT_PROMPTS[key];
      saveNow();
    });
  }

  // The service worker clears the session when a sign-in expires or is disconnected.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "chatgptSession" in changes) {
      renderChatGpt();
      refreshStatus();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// State helpers

const preset = () => PROVIDERS[settings.provider];
const group = () => preset().group;
const cfg = () => settings.providerConfig[settings.provider];

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 450);
}
/** @param {{quiet?: boolean}} [opts] */
async function saveNow({ quiet = false } = {}) {
  clearTimeout(saveTimer);
  await saveSettings(settings);
  if (!quiet) toast("Saved");
}

/** @param {string} model @param {{quiet?: boolean}} [opts] */
function setModel(model, { quiet = false } = {}) {
  cfg().model = model;
  setStatus("connectStatus", "");
  quiet ? saveSoon() : saveNow();
  refreshStatus();
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** @param {string} groupId */
async function selectGroup(groupId) {
  if (groupId === group()) return;
  settings.provider = settings.groupProvider[groupId];
  await afterProviderChange();
}

async function afterProviderChange() {
  setStatus("connectStatus", "");
  await renderConnection();
  await refreshStatus();
  saveNow({ quiet: true });
  autoLoadModels();
}

/** Arrow keys move between the connection types, like a radio group. */
function onSegKeydown(/** @type {KeyboardEvent} */ e) {
  const opts = [...document.querySelectorAll(".seg-opt")];
  const i = opts.indexOf(e.currentTarget);
  const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!next) return;
  e.preventDefault();
  const target = opts[(i + next + opts.length) % opts.length];
  target.focus();
  selectGroup(target.dataset.group);
}

async function renderConnection() {
  const g = group();
  const p = preset();
  for (const opt of document.querySelectorAll(".seg-opt")) {
    const on = opt.dataset.group === g;
    opt.setAttribute("aria-checked", String(on));
    opt.tabIndex = on ? 0 : -1;
  }
  $("planPanel").hidden = g !== "plan";
  $("keyedPanel").hidden = g === "plan";
  $("connectFoot").hidden = g === "plan";

  if (g === "plan") {
    await renderChatGpt();
  } else {
    $("provider").replaceChildren(...providersInGroup(g).map((x) => new Option(x.label, x.id)));
    $("provider").value = settings.provider;
    $("apiKeyField").hidden = g === "local";
    $("apiKeyOptional").hidden = p.needsKey;
    $("apiKey").value = cfg().apiKey;
    $("keyLink").hidden = !p.keyUrl;
    if (p.keyUrl) $("keyLink").href = p.keyUrl;
    $("baseUrlField").hidden = !p.editableUrl;
    $("advanced").hidden = !!p.editableUrl;
    $("baseUrl").value = cfg().baseUrl;
    $("baseUrl").placeholder = p.baseUrl || "https://example.com/v1";
    $("baseUrlAdv").value = cfg().baseUrl;
    $("baseUrlAdv").placeholder = p.baseUrl;
    const note = PROVIDER_NOTES[settings.provider];
    $("providerNote").hidden = !note;
    $("providerNote").innerHTML = note ?? ""; // static, trusted markup
    $("modelField").hidden = false;
  }
  renderModels();
}

function renderModels() {
  const list = modelLists[settings.provider];
  const model = cfg().model;
  const manual = manualModel.has(settings.provider) || !list?.length;
  $("modelSelect").hidden = manual;
  $("modelInput").hidden = !manual;
  $("modelManual").hidden = !list?.length;
  $("modelManual").textContent = manual ? "Choose from list" : "Enter a model ID";
  $("modelLabel").htmlFor = manual ? "modelInput" : "modelSelect";
  $("modelInput").value = model;
  $("modelInput").placeholder = preset().model ? `Model ID, e.g. ${preset().model}` : "Model ID";
  if (list?.length) {
    const options = list.map((m) => new Option(m.label === m.id ? m.id : `${m.label}  (${m.id})`, m.id));
    if (model && !list.some((m) => m.id === model)) options.unshift(new Option(`${model} (custom)`, model));
    $("modelSelect").replaceChildren(...options);
    $("modelSelect").value = model;
  }
}

async function renderChatGpt() {
  const session = await loadSession();
  $("planSignedOut").hidden = !!session;
  $("planSignedIn").hidden = !session;
  if (group() === "plan") $("modelField").hidden = !session;
  if (session) {
    const name = session.account.email ?? session.account.name ?? "Signed in";
    $("chatgptAccount").textContent = name;
    $("chatgptAvatar").textContent = name.trim().charAt(0) || "?";
  }
}

/** The pill in the header: is Nibly ready to use? */
async function refreshStatus() {
  const { ready, text } = await readiness();
  const pill = $("statusPill");
  pill.className = `pill ${ready ? "ready" : "setup"}`;
  pill.querySelector(".pill-text").textContent = text;
  $("connect").textContent = ready ? "Test connection" : "Connect";
  return ready;
}

async function readiness() {
  const conn = activeConnection(settings);
  if (conn.signIn) {
    if (!(await loadSession())) return { ready: false, text: "Sign in to start" };
    if (!conn.model) return { ready: false, text: "Choose a model" };
    return { ready: true, text: "Ready" };
  }
  if (conn.needsKey && !conn.apiKey) return { ready: false, text: "Add your API key" };
  if (!conn.baseUrl) return { ready: false, text: "Add the server address" };
  if (!conn.model) return { ready: false, text: "Choose a model" };
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [originPattern(conn.baseUrl)] });
  } catch {
    return { ready: false, text: "Check the address" };
  }
  return granted ? { ready: true, text: "Ready" } : { ready: false, text: "Not connected" };
}

function renderShortcuts() {
  if (!chrome.commands) return;
  chrome.commands.getAll((commands) => {
    for (const [cmd, el] of [["fix-selection", "kbdFix"], ["rewrite-selection", "kbdRewrite"]]) {
      const shortcut = commands.find((c) => c.name === cmd)?.shortcut ?? "";
      const keys = shortcut.includes("+") ? shortcut.split("+") : shortcut ? [...shortcut] : [];
      $(el).replaceChildren(...(keys.length ? keys.map((k) => Object.assign(document.createElement("kbd"), { textContent: k })) : ["Not set"]));
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Connect, models, test

/**
 * Ask for access to the provider's host(s). Must be called synchronously from a click handler
 * (before any await) because chrome.permissions.request requires a user gesture.
 */
function requestAccess() {
  /** @type {string[]} */
  let origins;
  if (preset().signIn) {
    origins = CHATGPT_ORIGINS;
  } else {
    try {
      origins = [originPattern(cfg().baseUrl || preset().baseUrl)];
    } catch {
      return Promise.reject(new Error("Enter a valid server address, for example http://localhost:11434/v1"));
    }
  }
  return chrome.permissions.request({ origins }).then((granted) => {
    if (!granted) throw new Error("Nibly needs permission to contact the provider. Click Connect and choose Allow.");
    return true;
  });
}

/**
 * Run a provider call in the service worker (which owns ChatGPT token refresh).
 * @param {"listModels" | "test" | "run"} type @param {object} [extra]
 */
async function callWorker(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, settings, ...extra });
  if (!res?.ok) throw new Error(res?.error ?? "No response from Nibly. Reload the extension and try again.");
  return res.result;
}

/** Load the model list and pick a sensible model if none is chosen. */
async function loadModels() {
  const list = /** @type {{id: string, label: string}[]} */ (await callWorker("listModels"));
  modelLists[settings.provider] = list;
  const current = cfg().model;
  if (list.length && (!current || (!list.some((m) => m.id === current) && !manualModel.has(settings.provider)))) {
    const suggested = list.find((m) => m.id === preset().model);
    if (!current || suggested) cfg().model = (suggested ?? list[0]).id;
    await saveSettings(settings);
  }
  renderModels();
  return list;
}

/** Load models in the background when the connection is already set up. */
async function autoLoadModels() {
  if (modelLists[settings.provider] || !(await canReachProvider())) return;
  try {
    await loadModels();
    await refreshStatus();
  } catch {
    /* shown when the user clicks Connect / Test connection */
  }
}

async function canReachProvider() {
  const conn = activeConnection(settings);
  if (conn.signIn) return !!(await loadSession());
  if (conn.needsKey && !conn.apiKey) return false;
  try {
    return await chrome.permissions.contains({ origins: [originPattern(conn.baseUrl)] });
  } catch {
    return false;
  }
}

async function onRefreshModels() {
  const access = preset().signIn ? Promise.resolve(true) : requestAccess();
  busy($("refreshModels"), true);
  try {
    await access;
    const list = await loadModels();
    toast(list.length ? `${list.length} models available` : "No models reported");
    await refreshStatus();
  } catch (err) {
    setStatus(preset().signIn ? "planStatus" : "connectStatus", message(err), "err");
  } finally {
    busy($("refreshModels"), false);
  }
}

async function onConnect() {
  const access = requestAccess();
  const btn = $("connect");
  busy(btn, true);
  setStatus("connectStatus", "Connecting…");
  try {
    if (preset().needsKey && !cfg().apiKey) {
      access.catch(() => {});
      $("apiKey").focus();
      throw new Error("Paste your API key first.");
    }
    await access;
    await saveSettings(settings);
    let listError = null;
    try {
      await loadModels();
    } catch (err) {
      listError = err; // some servers don't list models; the test below is what matters
    }
    if (!cfg().model) {
      manualModel.add(settings.provider);
      renderModels();
      $("modelInput").focus();
      throw listError ?? new Error("Enter the model you want to use.");
    }
    const started = performance.now();
    await callWorker("test");
    const ms = performance.now() - started;
    const took = ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
    setStatus("connectStatus", `Connected to ${preset().name ?? preset().label} · ${cfg().model} · ${took}`, "ok");
  } catch (err) {
    setStatus("connectStatus", message(err), "err");
  } finally {
    busy(btn, false);
    await refreshStatus();
  }
}

// ---------------------------------------------------------------------------------------------
// Sign in with ChatGPT

async function onChatGptSignIn() {
  const access = chrome.permissions.request({ origins: CHATGPT_ORIGINS }); // needs the click's user gesture
  const btn = $("chatgptSignIn");
  busy(btn, true);
  $("chatgptCancel").hidden = false;
  setStatus("planStatus", "Finish signing in in the ChatGPT window…");
  try {
    if (!(await access)) throw new Error("Nibly needs access to OpenAI to sign you in.");
    const { url, pending } = await beginSignIn();
    const callbackUrl = await runSignInWindow(url, (u) => isCallbackUrl(u, pending));
    setStatus("planStatus", "Signing in…");
    const session = await completeSignIn(callbackUrl, pending);
    setStatus("planStatus", "");
    settings.provider = "chatgpt";
    await saveSettings(settings);
    await renderConnection();
    if (!session.welcomed) $("welcome").showModal();
    try {
      await loadModels();
    } catch (err) {
      setStatus("planStatus", message(err), "err");
    }
  } catch (err) {
    setStatus("planStatus", message(err), "err");
  } finally {
    busy(btn, false);
    $("chatgptCancel").hidden = true;
    cancelSignIn = null;
    await refreshStatus();
  }
}

/**
 * Open the ChatGPT sign-in in a popup window and resolve with the loopback callback URL once the
 * window is redirected to it. Nothing listens on the loopback port; the URL is read from the tab.
 * @param {string} url @param {(url: string) => boolean} isCallback
 * @returns {Promise<string>}
 */
async function runSignInWindow(url, isCallback) {
  const win = await chrome.windows.create({ url, type: "popup", width: 520, height: 760, focused: true });
  const tabId = win.tabs?.[0]?.id;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onRemoved.removeListener(onRemoved);
      cancelSignIn = null;
    };
    const finish = (/** @type {() => void} */ settle) => {
      cleanup();
      settle();
      if (win.id !== undefined) chrome.windows.remove(win.id).catch(() => {});
    };
    /** @param {number} id @param {chrome.tabs.TabChangeInfo} info @param {chrome.tabs.Tab} tab */
    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      const current = info.url ?? tab.url ?? "";
      if (isCallback(current)) finish(() => resolve(current));
    };
    const onRemoved = (/** @type {number} */ windowId) => {
      if (windowId === win.id) {
        cleanup();
        reject(new ChatGptAuthError("The sign-in window was closed before finishing."));
      }
    };
    cancelSignIn = () => finish(() => reject(new ChatGptAuthError("Sign-in was cancelled.")));
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

async function onChatGptSignOut() {
  await signOut();
  cfg().model = "";
  delete modelLists.chatgpt;
  await saveSettings(settings);
  await renderConnection();
  await refreshStatus();
  toast("Signed out");
}

// ---------------------------------------------------------------------------------------------
// Try it

let tryResultText = "";

/** @param {"fix" | "rewrite"} actionId */
async function onTry(actionId) {
  const text = $("tryText").value.trim();
  const btn = $(actionId === "fix" ? "tryFix" : "tryRewrite");
  if (!text) return setStatus("tryStatus", "Type or paste some text first.", "err");
  if (!(await refreshStatus())) {
    setStatus("tryStatus", "Connect your AI first (step 1).", "err");
    document.querySelector(".seg-opt[aria-checked='true']")?.scrollIntoView({ block: "center" });
    return;
  }
  busy(btn, true);
  setStatus("tryStatus", actionId === "fix" ? "Fixing…" : "Rewriting…");
  $("tryResult").hidden = true;
  try {
    tryResultText = await callWorker("run", { actionId, text });
    setStatus("tryStatus", "");
    showTryResult(actionId, text, tryResultText);
  } catch (err) {
    setStatus("tryStatus", message(err), "err");
  } finally {
    busy(btn, false);
  }
}

/** @param {"fix" | "rewrite"} actionId @param {string} before @param {string} after */
function showTryResult(actionId, before, after) {
  const out = $("tryOutput");
  out.replaceChildren();
  const diff = actionId === "fix" ? globalThis.NiblyDiff?.diffWords(before, after) : null;
  if (after.trim() === before.trim()) {
    $("tryResultTitle").textContent = actionId === "fix" ? "Looks good - no mistakes found" : "Nothing to change";
    $("tryChip").hidden = true;
  } else {
    $("tryResultTitle").textContent = actionId === "fix" ? "Fixed" : "Rewritten";
    $("tryChip").hidden = !diff;
    if (diff) $("tryChip").textContent = diff.changes === 1 ? "1 change" : `${diff.changes} changes`;
  }
  if (diff) {
    for (const op of diff.ops) out.append(op.type === "same" ? op.text : Object.assign(document.createElement(op.type), { textContent: op.text }));
  } else {
    out.textContent = after;
  }
  $("tryResult").hidden = false;
}

async function onTryCopy() {
  await navigator.clipboard.writeText(tryResultText);
  toast("Copied");
}

function onTryUse() {
  $("tryText").value = tryResultText;
  $("tryResult").hidden = true;
  toast("Replaced");
}

// ---------------------------------------------------------------------------------------------
// Small UI helpers

/** @param {string} id @param {string} text @param {"ok" | "err" | ""} [kind] */
function setStatus(id, text, kind = "") {
  let el = $(id);
  if (!el && id === "planStatus") {
    // Status line for the ChatGPT panel, created on first use.
    el = Object.assign(document.createElement("p"), { id, className: "status" });
    el.setAttribute("role", "status");
    el.style.marginTop = "12px";
    $("planPanel").append(el);
  }
  el.textContent = text;
  el.className = `status ${kind}`;
}

/** @param {HTMLElement} btn @param {boolean} on */
function busy(btn, on) {
  btn.toggleAttribute("disabled", on);
  btn.setAttribute("aria-busy", String(on));
}

let toastTimer = 0;
/** @param {string} text */
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

init();
