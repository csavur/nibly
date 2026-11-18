// Sign in with ChatGPT: OAuth/PKCE, ID token verification, refresh, and plan-billed inference.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";

// Minimal chrome.storage.local stand-in.
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
      },
      async remove(key) {
        store.delete(key);
      },
    },
  },
};

const auth = await import("../src/chatgpt-auth.js");
const { complete, listModels, LlmError } = await import("../src/llm.js");
const { CHATGPT } = auth;

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64url = (buf) => Buffer.from(buf).toString("base64url");

let server;
let base = "";
const calls = { token: [], responses: [] };
/** Behaviour switches for the mock. */
const mock = { grantPlan: true, nonceOverride: null, badSignature: false, refreshError: null, responses: "ok", tokenDelayMs: 0 };
let lastAuthorize = null;

function signIdToken(claims) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  let sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  if (mock.badSignature) sig = Buffer.alloc(sig.length, 1);
  return `${header}.${payload}.${b64url(sig)}`;
}

before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, base);
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(raw));
      calls.token.push(form);
      if (mock.tokenDelayMs) await new Promise((r) => setTimeout(r, mock.tokenDelayMs));
      if (form.grant_type === "authorization_code") {
        // Verify PKCE like the real server would.
        const challenge = b64url(crypto.createHash("sha256").update(form.code_verifier).digest());
        if (challenge !== lastAuthorize.get("code_challenge") || form.code !== "the-code") return json(400, { error: "invalid_grant" });
        return json(200, {
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: mock.grantPlan ? CHATGPT.scope : "openid profile email offline_access",
          id_token: signIdToken({
            iss: CHATGPT.issuer,
            aud: form.client_id,
            sub: "user-123",
            email: "pat@example.com",
            exp: Math.floor(Date.now() / 1000) + 600,
            nonce: mock.nonceOverride ?? lastAuthorize.get("nonce"),
          }),
        });
      }
      if (form.grant_type === "refresh_token") {
        if (mock.refreshError) return json(400, { error: mock.refreshError });
        const n = Number(form.refresh_token.split("-")[1]) + 1;
        return json(200, { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 });
      }
    }
    if (url.pathname === "/v1/models") {
      return json(200, {
        models: [
          { slug: "gpt-x", display_name: "GPT X", visibility: "list" },
          { slug: "internal", display_name: "Hidden", visibility: "hide" },
          { slug: "gpt-a", display_name: "GPT A", visibility: "list" },
        ],
      });
    }
    if (url.pathname === "/v1/responses") {
      calls.responses.push({ headers: req.headers, body: JSON.parse(raw) });
      if (mock.responses === "http429") {
        return json(429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      ev({ type: "response.created", response: {} });
      ev({ type: "response.output_text.delta", delta: "Fixed " });
      ev({ type: "response.output_text.delta", delta: "text." });
      if (mock.responses === "failed") {
        ev({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "x" } } });
      } else if (mock.responses !== "truncated") {
        ev({ type: "response.completed", response: {} });
      }
      return res.end();
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(CHATGPT, { tokenUrl: `${base}/token`, jwksUrl: `${base}/jwks`, revokeUrl: `${base}/revoke` });
});

after(() => server.close());

beforeEach(() => {
  store.clear();
  Object.assign(mock, { grantPlan: true, nonceOverride: null, badSignature: false, refreshError: null, responses: "ok", tokenDelayMs: 0 });
  calls.token.length = 0;
  calls.responses.length = 0;
});

/** Run begin + complete as the options page would, with the server "approving" the sign-in. */
async function signIn({ issuedClientId = "oaiapp_abc", stateOverride } = {}) {
  const { url, pending } = await auth.beginSignIn();
  lastAuthorize = new URL(url).searchParams;
  const cb = new URL(pending.redirectUri);
  cb.searchParams.set("code", "the-code");
  cb.searchParams.set("state", stateOverride ?? pending.state);
  if (pending.registering) cb.searchParams.set("client_id", issuedClientId);
  return auth.completeSignIn(cb.toString(), pending);
}

test("authorize URL follows the open-source registration spec", async () => {
  const { url, pending } = await auth.beginSignIn();
  const u = new URL(url);
  const p = u.searchParams;
  assert.equal(`${u.origin}${u.pathname}`, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(p.get("client_id"), "dynamic_agent_client");
  assert.equal(p.get("agent_name_hint"), "Nibly");
  assert.match(p.get("ext_agent_host_id"), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(p.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(p.get("resource"), "https://api.openai.com/v1");
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.match(p.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(p.get("code_challenge"), b64url(crypto.createHash("sha256").update(pending.verifier).digest()));
  assert.ok(p.get("state") && p.get("nonce") && p.get("state") !== p.get("nonce"));
  assert.ok(auth.isCallbackUrl(`${pending.redirectUri}?code=x`, pending));
  assert.ok(!auth.isCallbackUrl("https://auth.openai.com/log-in", pending));
});

test("sign-in stores the session and later sign-ins reuse the issued client id and host id", async () => {
  const session = await signIn();
  assert.equal(session.accessToken, "at-1");
  assert.equal(session.account.email, "pat@example.com");
  assert.equal(session.welcomed, false);
  const tokenCall = calls.token.at(-1);
  assert.equal(tokenCall.client_id, "oaiapp_abc");
  assert.equal(tokenCall.resource, "https://api.openai.com/v1");
  const hostId = store.get("chatgptClient").hostId;

  await auth.signOut();
  assert.equal(await auth.loadSession(), null);
  const { url } = await auth.beginSignIn();
  const p = new URL(url).searchParams;
  assert.equal(p.get("client_id"), "oaiapp_abc");
  assert.equal(p.get("agent_name_hint"), null);
  assert.equal(p.get("ext_agent_host_id"), hostId);
});

test("state mismatch, nonce mismatch and bad signatures are rejected", async () => {
  await assert.rejects(signIn({ stateOverride: "evil" }), /state mismatch/);
  mock.nonceOverride = "evil";
  await assert.rejects(signIn(), /nonce mismatch/);
  mock.nonceOverride = null;
  mock.badSignature = true;
  await assert.rejects(signIn(), /bad signature/);
  assert.equal(await auth.loadSession(), null);
});

test("signing in without allowing plan usage is reported and stores no tokens", async () => {
  mock.grantPlan = false;
  await assert.rejects(signIn(), /did not allow Nibly to use your ChatGPT plan/);
  assert.equal(await auth.loadSession(), null);
});

test("access tokens refresh when expiring, rotate, and refresh only once under concurrency", async () => {
  await signIn();
  assert.equal(await auth.getAccessToken(), "at-1");
  const s = await auth.loadSession();
  await chrome.storage.local.set({ chatgptSession: { ...s, expiresAt: Date.now() + 10_000 } });
  mock.tokenDelayMs = 50;
  const before = calls.token.length;
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(a, "at-2");
  assert.equal(b, "at-2");
  assert.equal(calls.token.length - before, 1);
  const refreshCall = calls.token.at(-1);
  assert.deepEqual(
    { grant_type: refreshCall.grant_type, client_id: refreshCall.client_id, refresh_token: refreshCall.refresh_token },
    { grant_type: "refresh_token", client_id: "oaiapp_abc", refresh_token: "rt-1" },
  );
  assert.equal((await auth.loadSession()).refreshToken, "rt-2");
});

test("a terminal refresh error signs the user out; others keep the session", async () => {
  await signIn();
  mock.refreshError = "temporarily_unavailable";
  await assert.rejects(auth.getAccessToken({ force: true }), (e) => !e.needsSignIn);
  assert.ok(await auth.loadSession());
  mock.refreshError = "refresh_token_reused";
  await assert.rejects(auth.getAccessToken({ force: true }), (e) => e.needsSignIn === true);
  assert.equal(await auth.loadSession(), null);
  assert.ok(store.get("chatgptClient").clientId, "issued client id is kept for the next sign-in");
});

const planConn = () => ({
  providerId: "chatgpt",
  label: "ChatGPT plan",
  api: "chatgpt",
  baseUrl: `${base}/v1`,
  apiKey: "at-1",
  model: "gpt-x",
  needsKey: false,
  signIn: true,
});

test("plan-billed inference uses the Responses API with store:false and stream:true", async () => {
  const text = await complete(planConn(), { system: "SYS", user: "USER" });
  assert.equal(text, "Fixed text.");
  const { headers, body } = calls.responses.at(-1);
  assert.equal(headers.authorization, "Bearer at-1");
  assert.deepEqual(body, {
    model: "gpt-x",
    instructions: "SYS",
    input: [{ role: "user", content: "USER" }],
    store: false,
    stream: true,
  });
});

test("a stream without response.completed is an error", async () => {
  mock.responses = "truncated";
  await assert.rejects(complete(planConn(), { system: "s", user: "u" }), /stopped before finishing/);
});

test("usage limit errors (in-stream and HTTP) link to Manage usage", async () => {
  for (const mode of ["failed", "http429"]) {
    mock.responses = mode;
    await assert.rejects(complete(planConn(), { system: "s", user: "u" }), (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, "subscription_sharing_usage_limit_exceeded");
      assert.match(err.message, /Usage limit reached/);
      assert.deepEqual(err.link, { text: "Manage usage", url: "https://chatgpt.com/settings/usage" });
      return true;
    });
  }
});

test("model list keeps only user-visible models in server order", async () => {
  assert.deepEqual(await listModels(planConn()), [
    { id: "gpt-x", label: "GPT X" },
    { id: "gpt-a", label: "GPT A" },
  ]);
});
