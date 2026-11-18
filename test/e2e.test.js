// End-to-end: loads the real extension into Chrome for Testing, drives the Fix/Rewrite flow
// against a mock OpenAI-compatible server, and checks the page's text is replaced.
//
// Two test-only patches are applied to a temporary copy of the extension:
// - host_permissions <all_urls>: automation cannot click the permission prompt or a context menu
//   (which is what grants activeTab in real use).
// - a global hook exposing runAction, standing in for the context-menu click.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import puppeteer from "puppeteer";

const ROOT = path.resolve(import.meta.dirname, "..");
let server, base, browser, worker, page, extDir;
const requests = [];
let mode = "ok";

// Mock OpenAI auth server (Sign in with ChatGPT).
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256" };
const b64url = (b) => Buffer.from(b).toString("base64url");
let authorizeParams = null;
const responsesCalls = [];
function idToken(claims) {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "e2e" }));
  const p = b64url(JSON.stringify(claims));
  return `${h}.${p}.${b64url(crypto.sign("sha256", Buffer.from(`${h}.${p}`), privateKey))}`;
}

/** Handles the ChatGPT endpoints; returns true when it answered. */
async function chatgptMock(req, res, raw) {
  const url = new URL(req.url, base);
  const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname === "/oauth/authorize") {
    authorizeParams = url.searchParams;
    const cb = new URL(url.searchParams.get("redirect_uri"));
    cb.searchParams.set("code", "e2e-code");
    cb.searchParams.set("state", url.searchParams.get("state"));
    cb.searchParams.set("client_id", "oaiapp_e2e");
    res.writeHead(302, { location: cb.toString() }).end();
    return true;
  }
  if (url.pathname === "/oauth/jwks") return json(200, { keys: [jwk] }), true;
  if (url.pathname === "/oauth/token") {
    const form = Object.fromEntries(new URLSearchParams(raw));
    const challenge = b64url(crypto.createHash("sha256").update(form.code_verifier ?? "").digest());
    if (form.grant_type !== "authorization_code" || challenge !== authorizeParams.get("code_challenge")) {
      return json(400, { error: "invalid_grant" }), true;
    }
    return json(200, {
      access_token: "e2e-access",
      refresh_token: "e2e-refresh",
      expires_in: 3600,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      id_token: idToken({
        iss: "https://auth.openai.com",
        aud: form.client_id,
        sub: "u1",
        email: "pat@example.com",
        exp: Math.floor(Date.now() / 1000) + 600,
        nonce: authorizeParams.get("nonce"),
      }),
    }), true;
  }
  if (url.pathname === "/v1/models") {
    return json(200, { models: [{ slug: "gpt-e2e", display_name: "GPT E2E", visibility: "list" }] }), true;
  }
  if (url.pathname === "/v1/responses") {
    const body = JSON.parse(raw);
    responsesCalls.push({ auth: req.headers.authorization, body });
    const input = body.input[0].content.replace(/^<text>\n/, "").replace(/\n<\/text>$/, "");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: input.replace(/teh/g, "the") })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`);
    return true;
  }
  return false;
}

const PAGE = `<!doctype html><meta charset="utf-8"><body>
  <textarea id="ta" rows="4" cols="60">Hello,  teh meeting is tommorow. Thanks</textarea>
  <div id="ce" contenteditable="true">Hi team, plese review teh doc. Bye</div>
  <p id="static">This paragraf is not editable.</p>
  <div id="gmail" contenteditable="true"><div>Hi Sam,</div><div><br></div><div>teh report is ready.</div><div>Thanks</div></div>
</body>`;

before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    let raw = "";
    for await (const c of req) raw += c;
    if (await chatgptMock(req, res, raw)) return;
    if (req.method !== "POST") return res.writeHead(404).end();
    const body = JSON.parse(raw);
    requests.push(body);
    if (mode === "401") {
      return res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"bad key"}}');
    }
    const user = body.messages[1].content;
    const input = user.replace(/^<text>\n/, "").replace(/\n<\/text>$/, "");
    const out = input.replace(/teh/g, "the").replace(/tommorow/g, "tomorrow").replace(/plese/g, "please").replace(/paragraf/g, "paragraph");
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Stream it in two chunks.
    const half = Math.ceil(out.length / 2);
    for (const part of [out.slice(0, half), out.slice(half)]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  extDir = fs.mkdtempSync(path.join(os.tmpdir(), "nibly-e2e-"));
  for (const entry of ["manifest.json", "src", "icons"]) {
    fs.cpSync(path.join(ROOT, entry), path.join(extDir, entry), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest));
  // Point Sign in with ChatGPT at the mock server (the issuer stays https://auth.openai.com).
  const authFile = path.join(extDir, "src/chatgpt-auth.js");
  fs.writeFileSync(
    authFile,
    fs
      .readFileSync(authFile, "utf8")
      .replace('"https://auth.openai.com/api/accounts/authorize"', `"${base}/oauth/authorize"`)
      .replace('"https://auth.openai.com/api/accounts/oauth/token"', `"${base}/oauth/token"`)
      .replace('"https://auth.openai.com/api/accounts/oauth/revoke"', `"${base}/oauth/revoke"`)
      .replace('"https://auth.openai.com/.well-known/jwks.json"', `"${base}/oauth/jwks"`)
      .replace('apiBase: "https://api.openai.com/v1"', `apiBase: "${base}/v1"`),
  );
  fs.appendFileSync(path.join(extDir, "src/background.js"), [
      'import * as __settings from "./settings.js";',
      "globalThis.__runAction = runAction;",
      "globalThis.__settings = __settings;",
    ].join("\n"));

  browser = await puppeteer.launch({ headless: true, enableExtensions: [extDir], pipe: true });
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"));
  worker = await swTarget.worker();

  // Close the welcome/options tab opened on install.
  await new Promise((r) => setTimeout(r, 500));
  for (const p of await browser.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();

  page = await browser.newPage();
  await page.goto(`${base}/page`);
  await page.bringToFront();
});

after(async () => {
  await browser?.close();
  server?.close();
  if (extDir) fs.rmSync(extDir, { recursive: true, force: true });
});

async function configure(extra = {}) {
  await worker.evaluate(
    async (baseUrl, extra) => {
      const { loadSettings, saveSettings } = globalThis.__settings;
      const s = await loadSettings();
      s.provider = "custom";
      s.providerConfig.custom = { baseUrl, apiKey: "", model: "test-model" };
      Object.assign(s, extra);
      await saveSettings(s);
    },
    `${base}/v1`,
    extra,
  );
}

async function run(action) {
  await worker.evaluate(async (action) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await globalThis.__runAction(action, tab.id, 0, "");
  }, action);
}

const uiShown = () => page.evaluate(() => !!document.querySelector("nibly-ui"));
/** Text and buttons of the in-page card. */
const card = () =>
  page.evaluate(() => {
    const root = document.querySelector("nibly-ui")?.shadowRoot;
    if (!root) return null;
    return {
      title: root.querySelector(".title")?.textContent ?? "",
      text: root.querySelector(".card")?.innerText ?? "",
      buttons: [...root.querySelectorAll("button.btn")].map((b) => b.textContent.trim()),
    };
  });
const clickCardButton = (label) =>
  page.evaluate((label) => {
    const btn = [...document.querySelector("nibly-ui").shadowRoot.querySelectorAll("button.btn")].find((b) => b.textContent.trim() === label);
    btn.click();
  }, label);
const pillText = (p) => p.$eval("#statusPill", (el) => el.textContent.trim());
const selectIn = (value, start, end) =>
  page.evaluate(
    (value, start, end) => {
      const ta = document.getElementById("ta");
      ta.value = value;
      ta.focus();
      ta.setSelectionRange(start, end);
    },
    value,
    start,
    end,
  );

test("Fix replaces the selected text in a textarea, keeping surrounding whitespace", async () => {
  await configure();
  await page.evaluate(() => {
    const ta = document.getElementById("ta");
    ta.focus();
    // Select "  teh meeting is tommorow. " including the leading double space and trailing space.
    const start = ta.value.indexOf("  teh");
    const end = ta.value.indexOf("Thanks");
    ta.setSelectionRange(start, end);
  });
  await run("fix");
  assert.equal(await page.$eval("#ta", (el) => el.value), "Hello,  the meeting is tomorrow. Thanks");
  const req = requests.at(-1);
  assert.equal(req.model, "test-model");
  assert.equal(req.messages[1].content, "<text>\nteh meeting is tommorow.\n</text>");
  assert.match(req.messages[0].content, /proofreader/);
});

test("Fixing in a textarea is undoable", async () => {
  await page.evaluate(() => document.execCommand("undo"));
  assert.equal(await page.$eval("#ta", (el) => el.value), "Hello,  teh meeting is tommorow. Thanks");
});

test("Rewrite replaces a selection inside a contenteditable (Gmail-style) editor", async () => {
  await page.evaluate(() => {
    const ce = document.getElementById("ce");
    ce.focus();
    const node = ce.firstChild;
    const range = document.createRange();
    range.setStart(node, node.textContent.indexOf("plese"));
    range.setEnd(node, node.textContent.indexOf(" Bye"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await run("rewrite");
  assert.equal(await page.$eval("#ce", (el) => el.textContent), "Hi team, please review the doc. Bye");
  assert.match(requests.at(-1).messages[0].content, /Rewrite/);
});

test("Multi-line selection in a Gmail-style editor is replaced in place, keeping line breaks", async () => {
  await configure();
  const before = await page.$eval("#gmail", (el) => ({ text: el.innerText, html: el.innerHTML }));
  await page.evaluate(() => {
    const ed = document.getElementById("gmail");
    ed.focus();
    const range = document.createRange();
    range.setStart(ed.firstChild.firstChild, 0); // "Hi Sam,"
    range.setEnd(ed.children[2].firstChild, "teh report is ready.".length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await run("fix");
  assert.equal(requests.at(-1).messages[1].content, "<text>\nHi Sam,\n\nteh report is ready.\n</text>");
  const after = await page.$eval("#gmail", (el) => ({ text: el.innerText, html: el.innerHTML }));
  // Same line structure as before, with only the fix applied.
  assert.equal(after.text, before.text.replace("teh", "the"));
  assert.match(after.text, /^Hi Sam,\n+the report is ready\.\nThanks$/);
  assert.equal(await uiShown(), true); // the short "Fixed" confirmation
  await page.keyboard.press("Escape");
});

test("Non-editable selection shows a result panel and leaves the page untouched", async () => {
  await page.evaluate(() => {
    document.activeElement?.blur();
    const p = document.getElementById("static");
    const range = document.createRange();
    range.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await run("fix");
  assert.equal(requests.at(-1).messages[1].content, "<text>\nThis paragraf is not editable.\n</text>");
  assert.equal(await page.$eval("#static", (el) => el.textContent), "This paragraf is not editable.");
  assert.equal(await uiShown(), true);
  await page.keyboard.press("Escape");
  assert.equal(await uiShown(), false);
});

test("Preview mode waits for Replace, which sits next to Copy", async () => {
  await configure({ previewBeforeReplace: true });
  await page.evaluate(() => {
    const ta = document.getElementById("ta");
    ta.value = "teh end";
    ta.focus();
    ta.setSelectionRange(0, 3);
  });
  await run("fix");
  assert.equal(await page.$eval("#ta", (el) => el.value), "teh end");
  assert.equal(await uiShown(), true);
  // Replace sits next to Copy and has focus: Enter applies the result.
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("ta").value === "the end", { timeout: 3000 });
  await page.keyboard.press("Escape");
  await configure({ previewBeforeReplace: false });
});

test("Provider errors are shown and the text is left alone", async () => {
  mode = "401";
  try {
    await page.evaluate(() => {
      const ta = document.getElementById("ta");
      ta.value = "teh end";
      ta.focus();
      ta.setSelectionRange(0, 3);
    });
    await run("fix");
    assert.equal(await page.$eval("#ta", (el) => el.value), "teh end");
    const c = await card();
    assert.equal(c.title, "Couldn't fix the text");
    assert.match(c.text, /rejected the API key/);
    assert.deepEqual(c.buttons, ["Open settings"], "a rejected key leads to settings, not a pointless retry");
    await page.keyboard.press("Escape");
  } finally {
    mode = "ok";
  }
});

test("After an automatic fix, the confirmation shows the number of changes and Undo restores the text", async () => {
  await selectIn("teh cat and teh dog", 0, 19);
  await run("fix");
  assert.equal(await page.$eval("#ta", (el) => el.value), "the cat and the dog");
  const c = await card();
  assert.match(c.title, /Fixed\s*2 changes/);
  assert.deepEqual(c.buttons, ["Undo"]);
  await clickCardButton("Undo");
  assert.equal(await page.$eval("#ta", (el) => el.value), "teh cat and teh dog");
  assert.match((await card()).title, /undone/);
  await page.keyboard.press("Escape");
});

test("When Fix finds nothing to change, the text is left alone and the user is told", async () => {
  await selectIn("All good here.", 0, 14);
  await run("fix");
  assert.equal(await page.$eval("#ta", (el) => el.value), "All good here.");
  assert.match((await card()).title, /no mistakes found/);
  await page.keyboard.press("Escape");
});

test("Review panel highlights changes and Try again asks the AI again", async () => {
  await configure({ previewBeforeReplace: true });
  try {
    await selectIn("teh end", 0, 7);
    await run("fix");
    const c = await card();
    assert.match(c.title, /Review fix\s*1 change/);
    assert.deepEqual(c.buttons, ["Try again", "Copy", "Replace"]);
    const highlighted = await page.evaluate(() => {
      const root = document.querySelector("nibly-ui").shadowRoot;
      return { ins: root.querySelector("ins")?.textContent, del: root.querySelector("del")?.textContent };
    });
    assert.deepEqual(highlighted, { ins: "the", del: "teh" });
    const before = requests.length;
    await clickCardButton("Try again");
    await page.waitForFunction(() => document.querySelector("nibly-ui")?.shadowRoot.querySelector(".review"), { timeout: 5000 });
    assert.equal(requests.length, before + 1);
    await page.keyboard.press("Escape");
  } finally {
    await configure({ previewBeforeReplace: false });
  }
});

test("Settings: connect an API provider, then try Fix in the settings page", async () => {
  await configure({ provider: "openai" }); // start elsewhere, connect "Other (OpenAI-compatible)" through the UI
  const swUrl = new URL(worker.url());
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${swUrl.host}/src/options/options.html`);
  await options.waitForSelector('.seg-opt[data-group="api"][aria-checked="true"]');
  assert.match(await pillText(options), /API key/);
  assert.equal(await options.$eval("#keyLink", (el) => el.href), "https://platform.openai.com/api-keys");

  await options.select("#provider", "custom");
  await options.waitForSelector("#baseUrlField", { visible: true });
  await options.$eval("#baseUrl", (el) => (el.value = ""));
  await options.type("#baseUrl", `${base}/v1`);
  await options.$eval("#modelInput", (el) => {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await options.click("#connect");
  await options
    .waitForFunction(() => document.getElementById("connectStatus").classList.contains("ok"), { timeout: 10000 })
    .catch(async () => assert.fail(`not connected: ${await options.$eval("#connectStatus", (el) => el.textContent)}`));
  assert.match(await options.$eval("#connectStatus", (el) => el.textContent), /Connected to Your AI provider · gpt-e2e/);
  assert.equal(await options.$eval("#modelSelect", (el) => el.value), "gpt-e2e", "first listed model is picked");
  assert.equal(await pillText(options), "Ready");

  await options.click("#tryFix");
  await options.waitForSelector("#tryResult:not([hidden])", { timeout: 10000 });
  assert.equal(await options.$eval("#tryOutput ins", (el) => el.textContent), "the");
  await options.click("#tryUse");
  assert.match(await options.$eval("#tryText", (el) => el.value), /that the report/);

  const stored = await worker.evaluate(async () => globalThis.__settings.loadSettings());
  assert.equal(stored.provider, "custom");
  assert.equal(stored.groupProvider.api, "custom");
  assert.equal(stored.providerConfig.custom.model, "gpt-e2e");
  await options.close();
  await page.bringToFront();
});

test("Sign in with ChatGPT in the settings page, then Fix bills the ChatGPT plan", async () => {
  const swUrl = new URL(worker.url());
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${swUrl.host}/src/options/options.html`);
  await options.click('.seg-opt[data-group="plan"]');
  await options.waitForSelector("#chatgptSignIn", { visible: true });
  for (const sel of ["#keyedPanel", "#connectFoot", "#modelField"]) {
    assert.equal(await options.$eval(sel, (el) => el.checkVisibility()), false, `${sel} must not be visible before signing in`);
  }
  assert.match(await pillText(options), /Sign in/);

  await options.click("#chatgptSignIn");
  await options
    .waitForSelector("#planSignedIn:not([hidden])", { timeout: 15000 })
    .catch(async () => assert.fail(`not signed in: ${await options.$eval("#planPanel", (el) => el.innerText)}`));
  assert.equal(await options.$eval("#chatgptAccount", (el) => el.textContent), "pat@example.com");
  assert.equal(await options.$eval("#welcome", (el) => el.open), true, "first sign-in shows the plan notice");
  assert.equal(authorizeParams.get("client_id"), "dynamic_agent_client");
  assert.equal(authorizeParams.get("agent_name_hint"), "Nibly");
  await options.click("#welcomeOk");
  await options.waitForFunction(() => document.getElementById("modelSelect").value === "gpt-e2e");
  await options.waitForFunction(() => document.querySelector("#statusPill").classList.contains("ready"));

  // The sign-in popup window is closed after the callback.
  const pages = (await browser.pages()).map((p) => p.url());
  assert.ok(!pages.some((u) => u.includes("/auth/callback")), `callback window left open: ${pages}`);

  const stored = await worker.evaluate(async () => (await globalThis.__settings.loadSettings()));
  assert.equal(stored.provider, "chatgpt");
  assert.equal(stored.providerConfig.chatgpt.model, "gpt-e2e");
  await options.close();

  await page.bringToFront();
  await page.evaluate(() => {
    const ta = document.getElementById("ta");
    ta.value = "teh plan works";
    ta.focus();
    ta.setSelectionRange(0, 3);
  });
  await run("fix");
  assert.equal(await page.$eval("#ta", (el) => el.value), "the plan works");
  const call = responsesCalls.at(-1);
  assert.equal(call.auth, "Bearer e2e-access");
  assert.equal(call.body.model, "gpt-e2e");
  assert.equal(call.body.store, false);
  assert.equal(call.body.stream, true);
});
