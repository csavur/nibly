// Generate Chrome Web Store images into store/images/:
//   screenshot-1..5.png (1280x800) and promo-small.png (440x280).
// The Nibly UI in the screenshots is the real extension, loaded into Chrome for Testing and driven
// against a local mock AI server. The mail window is a neutral mock (no third-party branding).
//
// Run: npm run store-images
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "store", "images");
const W = 1280;
const H = 800;

const EMAIL = [
  "Hi Jordan,",
  "",
  "Thanks for you're quick reply. I've attached teh updated proposal and the budget breakdown we discused on Monday.",
  "",
  "Could we schedule a call this week to go over the timeline? Im free Tuesday or Wednesday afternoon.",
  "",
  "Best,",
  "Alex",
];
const FIXES = [
  ["you're quick", "your quick"],
  ["teh ", "the "],
  ["discused", "discussed"],
  ["Im free", "I'm free"],
];
const REWRITE =
  "Thank you for the quick reply. I've attached the updated proposal along with the budget breakdown we discussed on Monday.\n\n" +
  "Would you have time for a call this week to review the timeline? I'm available Tuesday or Wednesday afternoon.";

const SHOTS = [
  { name: "screenshot-1", title: "Right-click any text", sub: "Fix spelling and grammar, or rewrite it - in email, forms, docs, anywhere on the web." },
  { name: "screenshot-2", title: "See exactly what changed", sub: "Review every correction before it goes in. Replace with one click, or press Enter." },
  { name: "screenshot-3", title: "Fixed in place", sub: "Press Enter and your text is corrected right where you typed it. Changed your mind? One-click Undo." },
  { name: "screenshot-4", title: "Rewrite in a second", sub: "Clearer, friendlier, more professional - and it keeps your meaning, names and dates." },
  { name: "screenshot-5", title: "Bring your own AI", sub: "Use your ChatGPT plan, an API key (OpenAI, Claude, Gemini), or a private local model." },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function framePage({ title, sub }, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
    body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1b1f24;
      background: radial-gradient(1200px 700px at 0% 0%, #fff3ea 0%, #fde3d2 45%, #f9cdb0 100%); }
    .caption { position: absolute; left: 64px; top: 0; bottom: 0; width: 360px; display: flex; flex-direction: column; justify-content: center; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; color: #c2410c; margin-bottom: 22px; }
    .brand img { width: 34px; height: 34px; border-radius: 9px; }
    h1 { font-size: 44px; line-height: 1.1; letter-spacing: -0.02em; margin: 0 0 16px; color: #1b1f24; }
    .caption p { font-size: 19px; line-height: 1.5; color: #4b5563; margin: 0; }
    .stage { position: absolute; left: 460px; top: 56px; right: 56px; bottom: 56px; }
    .window { position: absolute; inset: 0; background: #fff; border-radius: 16px; overflow: hidden;
      box-shadow: 0 30px 70px rgba(124, 45, 18, .22), 0 4px 14px rgba(124, 45, 18, .12); display: flex; flex-direction: column; }
    .titlebar { height: 44px; background: #f3f4f6; display: flex; align-items: center; gap: 8px; padding: 0 16px; font-weight: 600; font-size: 14px; color: #374151; }
    .titlebar i { width: 12px; height: 12px; border-radius: 50%; background: #e5e7eb; display: inline-block; }
    .titlebar span { margin-left: 10px; }
    .row { display: flex; gap: 14px; padding: 11px 22px; border-bottom: 1px solid #eef0f2; font-size: 14.5px; }
    .row b { width: 60px; color: #6b7280; font-weight: 500; }
    #body { flex: 1; padding: 20px 22px; font-size: 16px; line-height: 1.6; outline: none; }
    #body div { min-height: 1.6em; }
    .bottom { padding: 14px 22px; border-top: 1px solid #eef0f2; display: flex; gap: 10px; align-items: center; }
    .send { background: #2563eb; color: #fff; font-weight: 600; padding: 8px 22px; border-radius: 999px; font-size: 14px; }
    .bottom span { width: 26px; height: 8px; border-radius: 4px; background: #e5e7eb; }
    ::selection { background: #bfdbfe; }
    .menu { position: absolute; z-index: 5; font-size: 14px; width: 236px; padding: 6px; border-radius: 10px; background: #fff;
      border: 1px solid #d1d5db; box-shadow: 0 14px 34px rgba(0,0,0,.18); }
    .menu .it { padding: 6px 12px; border-radius: 6px; display: flex; align-items: center; gap: 9px; white-space: nowrap; color: #111827; }
    .menu .dim { color: #6b7280; }
    .menu .sep { height: 1px; background: #e5e7eb; margin: 5px 3px; }
    .menu .active { background: #f3f4f6; }
    .menu .hl { background: #e8590c; color: #fff; }
    .menu .arrow { margin-left: auto; color: #9ca3af; }
    .menu img { width: 16px; height: 16px; }
    .shot { position: absolute; inset: 0; border-radius: 14px; overflow: hidden; box-shadow: 0 30px 70px rgba(124,45,18,.22), 0 4px 14px rgba(124,45,18,.12); background: #fff; }
    .shot img { display: block; width: 100%; }
  </style></head><body>
    <div class="caption">
      <div class="brand"><img src="/icon-128.png" alt=""> Nibly</div>
      <h1>${esc(title)}</h1>
      <p>${esc(sub)}</p>
    </div>
    <div class="stage">${inner}</div>
  </body></html>`;
}

function mailWindow() {
  const lines = EMAIL.map((l) => `<div>${l ? esc(l) : "<br>"}</div>`).join("");
  return `<div class="window">
    <div class="titlebar"><i></i><i></i><i></i><span>New message</span></div>
    <div class="row"><b>To</b> Jordan Lee</div>
    <div class="row"><b>Subject</b> Updated proposal</div>
    <div id="body" contenteditable="true" spellcheck="false">${lines}</div>
    <div class="bottom"><div class="send">Send</div><span></span><span></span></div>
  </div>`;
}

function contextMenu(x, y) {
  return `<div class="menu" style="left:${x}px;top:${y}px">
    <div class="it dim">Cut</div><div class="it dim">Copy</div><div class="it dim">Paste</div>
    <div class="sep"></div>
    <div class="it active"><img src="/icon-16.png" alt=""> Nibly <span class="arrow">›</span></div>
    <div class="sep"></div>
    <div class="it dim">Inspect</div>
  </div>
  <div class="menu" style="left:${x + 238}px;top:${y + 112}px">
    <div class="it hl">Fix and review…</div>
    <div class="it">Rewrite</div>
    <div class="sep"></div>
    <div class="it">Settings…</div>
  </div>`;
}

function promoTile() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff;
      background: linear-gradient(135deg, #f77828 0%, #d6400c 100%); display: flex; align-items: center; gap: 22px; padding: 0 36px; box-sizing: border-box; }
    img { width: 120px; height: 120px; filter: drop-shadow(0 8px 18px rgba(0,0,0,.22)); margin-left: -8px; }
    h1 { margin: 0 0 6px; font-size: 40px; letter-spacing: -0.02em; }
    p { margin: 0; font-size: 17px; line-height: 1.35; opacity: .95; }
  </style></head><body><img src="/icon-512.png" alt=""><div><h1>Nibly</h1><p>Fix and rewrite any text<br>with the AI you choose.</p></div></body></html>`;
}

// ---------------------------------------------------------------------------------------------

function fixText(text) {
  let out = text;
  for (const [a, b] of FIXES) out = out.split(a).join(b);
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pages = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (pages.has(url.pathname)) return res.writeHead(200, { "content-type": "text/html" }).end(pages.get(url.pathname));
    if (/^\/icon-\d+\.png$/.test(url.pathname)) {
      return res.writeHead(200, { "content-type": "image/png" }).end(fs.readFileSync(path.join(ROOT, "icons", url.pathname.slice(1))));
    }
    if (url.pathname === "/settings.png") return res.writeHead(200, { "content-type": "image/png" }).end(fs.readFileSync(path.join(os.tmpdir(), "nibly-settings.png")));
    if (url.pathname === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"gpt-5-mini"}]}');
    if (req.method !== "POST") return res.writeHead(404).end();
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const input = body.messages[1].content.replace(/^<text>\n/, "").replace(/\n<\/text>$/, "");
    const output = /proofreader/.test(body.messages[0].content) ? fixText(input) : REWRITE;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: output } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Test build of the extension: host access granted up front, plus a hook to start an action
  // without a real right-click (automation cannot open native context menus).
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "nibly-shots-"));
  for (const entry of ["manifest.json", "src", "icons"]) fs.cpSync(path.join(ROOT, entry), path.join(ext, entry), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  fs.appendFileSync(
    path.join(ext, "src/background.js"),
    '\nimport * as __settings from "./settings.js";\nglobalThis.__runEntry = runEntry;\nglobalThis.__settings = __settings;\n',
  );

  const browser = await puppeteer.launch({ headless: true, enableExtensions: [ext], pipe: true });
  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("src/background.js"));
    const worker = await swTarget.worker();
    await new Promise((r) => setTimeout(r, 800));
    for (const p of await browser.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();

    const configure = (extra) =>
      worker.evaluate(
        async (baseUrl, extra) => {
          const s = await globalThis.__settings.loadSettings();
          s.provider = "custom";
          s.providerConfig.custom = { baseUrl, apiKey: "", model: "gpt-5-mini" };
          Object.assign(s, extra);
          await globalThis.__settings.saveSettings(s);
        },
        `${base}/v1`,
        extra,
      );
    /** Run a right-click menu entry ("fix" = Fix and review…, "rewrite"). */
    const run = (entryId) =>
      worker.evaluate(async (entryId) => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await globalThis.__runEntry(entryId, tab.id, 0, "menu");
      }, entryId);

    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    const open = async (shot, inner) => {
      pages.set(`/${shot.name}`, framePage(shot, inner));
      await page.goto(`${base}/${shot.name}`);
      await page.bringToFront();
    };
    /** Select body lines [from, to] (indexes into EMAIL), like a user would before right-clicking. */
    const selectLines = (from, to) =>
      page.evaluate(
        (from, to) => {
          const body = document.getElementById("body");
          body.focus();
          const lines = body.children;
          const range = document.createRange();
          range.setStart(lines[from].firstChild, 0);
          range.setEnd(lines[to].firstChild, lines[to].firstChild.textContent.length);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        },
        from,
        to,
      );
    const settle = () => new Promise((r) => setTimeout(r, 450));
    const save = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

    // 1. Right-click menu (drawn: native menus cannot be captured).
    await open(SHOTS[0], mailWindow() + contextMenu(250, 300));
    await selectLines(2, 4);
    await save(SHOTS[0].name);

    // 2. Review panel with highlighted fixes.
    await configure({ previewBeforeReplace: false });
    await open(SHOTS[1], mailWindow());
    await selectLines(2, 4);
    await run("fix");
    await settle();
    await save(SHOTS[1].name);

    // 3. Fixed in place (after Replace), with Undo.
    await open(SHOTS[2], mailWindow());
    await selectLines(2, 4);
    await run("fix");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("nibly-ui")?.shadowRoot.querySelector(".review"));
    await page.evaluate(() => getSelection().removeAllRanges());
    await settle();
    await save(SHOTS[2].name);

    // 4. Rewrite review.
    await configure({ previewBeforeReplace: true });
    await open(SHOTS[3], mailWindow());
    await selectLines(2, 4);
    await run("rewrite");
    await settle();
    await save(SHOTS[3].name);

    // 5. Settings page (connection step), framed.
    await configure({ previewBeforeReplace: false, provider: "chatgpt" });
    const settings = await browser.newPage();
    // Same size as the stage the image is framed in (1280-460-56 x 800-56-56), at 2x for crispness.
    await settings.setViewport({ width: W - 460 - 56, height: H - 112, deviceScaleFactor: 2 });
    await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await settings.goto(`chrome-extension://${new URL(swTarget.url()).host}/src/options/options.html`);
    await settings.waitForSelector("#chatgptSignIn", { visible: true });
    await settle();
    await settings.screenshot({ path: path.join(os.tmpdir(), "nibly-settings.png") });
    await settings.close();
    await open(SHOTS[4], `<div class="shot"><img src="/settings.png" alt=""></div>`);
    await page.waitForFunction(() => document.querySelector(".shot img").complete);
    await save(SHOTS[4].name);

    // Small promo tile.
    pages.set("/promo", promoTile());
    await page.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
    await page.goto(`${base}/promo`);
    await page.waitForFunction(() => document.querySelector("img").complete);
    await page.screenshot({ path: path.join(OUT, "promo-small.png") });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(ext, { recursive: true, force: true });
  }
  console.log(`Wrote ${fs.readdirSync(OUT).length} images to ${path.relative(ROOT, OUT)}/`);
}

await main();
