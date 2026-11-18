// "Sign in with ChatGPT" with ChatGPT plan usage, for open-source / locally hosted clients.
// Lets users spend their ChatGPT Go/Plus/Pro/Business plan instead of an API key.
// Spec: https://developers.openai.com/siwc/token-sharing-open-source (OAuth 2.0 + PKCE + OIDC).
//
// Ownership: the interactive sign-in runs in the options page (it owns the popup window);
// token refresh runs only in the service worker, so rotating refresh tokens never race.

export const CHATGPT = {
  issuer: "https://auth.openai.com",
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  revokeUrl: "https://auth.openai.com/api/accounts/oauth/revoke",
  jwksUrl: "https://auth.openai.com/.well-known/jwks.json",
  apiBase: "https://api.openai.com/v1",
  resource: "https://api.openai.com/v1",
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  planScope: "chatgpt.tokens.use.direct",
  registrationClientId: "dynamic_agent_client",
  agentName: "Nibly",
  usageUrl: "https://chatgpt.com/settings/usage",
};

/** Origins the extension must be allowed to contact for ChatGPT plan usage. */
export const CHATGPT_ORIGINS = ["https://auth.openai.com/*", "https://api.openai.com/*", "http://127.0.0.1/*"];

const CLIENT_KEY = "chatgptClient"; // {hostId, clientId} - survives sign-out, reused for later sign-ins
const SESSION_KEY = "chatgptSession"; // tokens + identity
const REFRESH_MARGIN_MS = 60_000;
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export class ChatGptAuthError extends Error {
  /** @param {string} message @param {{needsSignIn?: boolean, cause?: unknown}} [opts] */
  constructor(message, opts = {}) {
    super(message, { cause: opts.cause });
    this.name = "ChatGptAuthError";
    this.needsSignIn = !!opts.needsSignIn;
  }
}

/**
 * @typedef {Object} ChatGptSession
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {string} idToken
 * @property {number} expiresAt       epoch ms
 * @property {string[]} scopes
 * @property {{sub: string, email?: string, name?: string}} account
 * @property {boolean} welcomed       first-sign-in notice shown
 */

/** @typedef {{hostId: string, clientId?: string}} ChatGptClient */

/**
 * @typedef {Object} PendingSignIn
 * @property {string} state
 * @property {string} nonce
 * @property {string} verifier
 * @property {string} redirectUri
 * @property {string} clientId       the client_id sent in the authorize request
 * @property {boolean} registering
 */

// ---------------------------------------------------------------------------------------------
// Storage

/** @returns {Promise<ChatGptClient>} */
async function loadClient() {
  const { [CLIENT_KEY]: client } = await chrome.storage.local.get(CLIENT_KEY);
  if (client?.hostId) return client;
  // Stable, opaque, per-host id (never user-identifying), created once per browser profile.
  const fresh = { hostId: `urn:uuid:${crypto.randomUUID()}` };
  await chrome.storage.local.set({ [CLIENT_KEY]: fresh });
  return fresh;
}

/** @returns {Promise<ChatGptSession | null>} */
export async function loadSession() {
  const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY);
  return session ?? null;
}

/** @param {ChatGptSession | null} session */
async function saveSession(session) {
  if (session) await chrome.storage.local.set({ [SESSION_KEY]: session });
  else await chrome.storage.local.remove(SESSION_KEY);
}

export async function markWelcomed() {
  const session = await loadSession();
  if (session && !session.welcomed) await saveSession({ ...session, welcomed: true });
}

// ---------------------------------------------------------------------------------------------
// Interactive sign-in (options page)

/**
 * Build the authorize URL and the state needed to finish the flow.
 * @returns {Promise<{url: string, pending: PendingSignIn}>}
 */
export async function beginSignIn() {
  const client = await loadClient();
  const session = await loadSession();
  const registering = !client.clientId;
  // Only the port of the loopback redirect may change between sign-ins. Nothing listens on it:
  // the extension watches the sign-in tab and reads the code from its URL.
  const port = 49152 + Math.floor(Math.random() * 16000);
  const pending = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    clientId: client.clientId ?? CHATGPT.registrationClientId,
    registering,
  };
  const params = new URLSearchParams({
    client_id: pending.clientId,
    ext_agent_host_id: client.hostId,
    response_type: "code",
    redirect_uri: pending.redirectUri,
    scope: CHATGPT.scope,
    resource: CHATGPT.resource,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: "S256",
    code_challenge: await pkceChallenge(pending.verifier),
  });
  if (registering) params.set("agent_name_hint", CHATGPT.agentName);
  if (session?.idToken) params.set("id_token_hint", session.idToken);
  return { url: `${CHATGPT.authorizeUrl}?${params}`, pending };
}

/** @param {string} url @param {PendingSignIn} pending */
export function isCallbackUrl(url, pending) {
  return typeof url === "string" && (url === pending.redirectUri || url.startsWith(`${pending.redirectUri}?`));
}

/**
 * Finish sign-in from the loopback callback URL: validate, exchange the code, verify the ID token,
 * and store the session.
 * @param {string} callbackUrl
 * @param {PendingSignIn} pending
 * @returns {Promise<ChatGptSession>}
 */
export async function completeSignIn(callbackUrl, pending) {
  const params = new URL(callbackUrl).searchParams;
  if (params.get("state") !== pending.state) throw new ChatGptAuthError("Sign-in failed a security check (state mismatch). Please try again.");
  const error = params.get("error");
  if (error === "access_denied") throw new ChatGptAuthError("Sign-in was cancelled.");
  if (error) throw new ChatGptAuthError(`ChatGPT sign-in failed: ${params.get("error_description") || error}`);
  const code = params.get("code");
  if (!code) throw new ChatGptAuthError("ChatGPT did not return an authorization code. Please try again.");

  const client = await loadClient();
  const returnedClientId = params.get("client_id");
  let clientId;
  if (pending.registering) {
    if (!returnedClientId) throw new ChatGptAuthError("ChatGPT registration did not complete. Please try again.");
    clientId = returnedClientId;
  } else {
    if (returnedClientId && returnedClientId !== pending.clientId) {
      throw new ChatGptAuthError("ChatGPT returned an unexpected client. Please try again.");
    }
    clientId = pending.clientId;
  }

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    resource: CHATGPT.resource,
  });
  const claims = await verifyIdToken(tokens.id_token, { clientId, nonce: pending.nonce });
  const scopes = parseScopes(tokens.scope);

  await chrome.storage.local.set({ [CLIENT_KEY]: { ...client, clientId } });
  if (!scopes.includes(CHATGPT.planScope)) {
    throw new ChatGptAuthError(
      "You signed in, but did not allow Nibly to use your ChatGPT plan. Sign in again and allow plan usage, " +
        "or choose a provider that uses an API key.",
    );
  }
  const previous = await loadSession();
  const session = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    scopes,
    account: { sub: claims.sub, email: claims.email, name: claims.name },
    welcomed: !!previous?.welcomed && previous.account?.sub === claims.sub,
  };
  await saveSession(session);
  return session;
}

/** Forget the session (keeps the registered client id and host id, as the spec asks). */
export async function signOut() {
  const session = await loadSession();
  const client = await loadClient();
  await saveSession(null);
  if (session?.refreshToken && client.clientId) {
    // Best effort; the user can also disconnect Nibly in ChatGPT settings.
    fetch(CHATGPT.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: session.refreshToken, token_type_hint: "refresh_token", client_id: client.clientId }),
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Access tokens (service worker)

/** @type {Promise<ChatGptSession> | null} */
let refreshInFlight = null;

/**
 * A valid access token, refreshed if it expires within a minute (or when forced after a 401).
 * @param {{force?: boolean}} [opts]
 */
export async function getAccessToken({ force = false } = {}) {
  const session = await loadSession();
  if (!session) throw new ChatGptAuthError("Sign in with ChatGPT in the Nibly settings first.", { needsSignIn: true });
  if (!force && session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken;
  // Serialize refreshes: refresh tokens rotate, so two concurrent refreshes would invalidate each other.
  refreshInFlight ??= refresh(session).finally(() => (refreshInFlight = null));
  return (await refreshInFlight).accessToken;
}

/** @param {ChatGptSession} session @returns {Promise<ChatGptSession>} */
async function refresh(session) {
  const client = await loadClient();
  if (!client.clientId) {
    await saveSession(null);
    throw new ChatGptAuthError("Your ChatGPT sign-in is incomplete. Please sign in again.", { needsSignIn: true });
  }
  let tokens;
  try {
    tokens = await tokenRequest({
      grant_type: "refresh_token",
      client_id: client.clientId,
      refresh_token: session.refreshToken,
      resource: CHATGPT.resource,
    });
  } catch (err) {
    if (err instanceof TokenEndpointError && TERMINAL_REFRESH_ERRORS.has(err.code)) {
      await saveSession(null);
      throw new ChatGptAuthError("Your ChatGPT sign-in expired or was disconnected. Please sign in again.", {
        needsSignIn: true,
        cause: err,
      });
    }
    // Network or temporary failures: keep the credentials.
    throw new ChatGptAuthError(`Could not refresh your ChatGPT sign-in: ${err.message}`, { cause: err });
  }
  const updated = {
    ...session,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    idToken: tokens.id_token ?? session.idToken,
    expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    scopes: tokens.scope ? parseScopes(tokens.scope) : session.scopes,
  };
  await saveSession(updated);
  return updated;
}

// ---------------------------------------------------------------------------------------------
// Helpers

class TokenEndpointError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {Record<string, string>} form */
async function tokenRequest(form) {
  let res;
  try {
    res = await fetch(CHATGPT.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form),
    });
  } catch (err) {
    throw new ChatGptAuthError("Could not reach ChatGPT. Check your internet connection.", { cause: err });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : (body.error?.code ?? `http_${res.status}`);
    const description = body.error_description ?? body.error?.message ?? body.detail ?? `HTTP ${res.status}`;
    if (form.grant_type === "authorization_code") {
      throw new ChatGptAuthError(`ChatGPT sign-in failed (${code}). Please try again.`, { cause: description });
    }
    throw new TokenEndpointError(code, description);
  }
  if (!body.access_token) throw new ChatGptAuthError("ChatGPT returned an incomplete sign-in response.");
  return body;
}

/** @param {string | undefined} scope */
function parseScopes(scope) {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Verify the ID token's signature against OpenAI's published keys and check its claims.
 * @param {string} idToken @param {{clientId: string, nonce: string}} expected
 */
export async function verifyIdToken(idToken, { clientId, nonce }) {
  const parts = (idToken ?? "").split(".");
  if (parts.length !== 3) throw new ChatGptAuthError("ChatGPT returned an invalid ID token.");
  const [h, p, s] = parts;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));

  const jwks = await fetch(CHATGPT.jwksUrl).then((r) => r.json());
  const jwk = jwks.keys?.find((/** @type {any} */ k) => k.kid === header.kid);
  if (!jwk) throw new ChatGptAuthError("Could not verify the ChatGPT sign-in (unknown signing key).");
  const algs = {
    RS256: { imp: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, ver: { name: "RSASSA-PKCS1-v1_5" }, jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e } },
    ES256: { imp: { name: "ECDSA", namedCurve: "P-256" }, ver: { name: "ECDSA", hash: "SHA-256" }, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } },
  };
  const alg = algs[header.alg];
  if (!alg) throw new ChatGptAuthError(`Unsupported ID token algorithm ${header.alg}.`);
  const key = await crypto.subtle.importKey("jwk", alg.jwk, alg.imp, false, ["verify"]);
  const valid = await crypto.subtle.verify(alg.ver, key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) throw new ChatGptAuthError("Could not verify the ChatGPT sign-in (bad signature).");

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== CHATGPT.issuer) throw new ChatGptAuthError("ChatGPT sign-in came from an unexpected issuer.");
  if (!aud.includes(clientId)) throw new ChatGptAuthError("ChatGPT sign-in was issued for a different client.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) throw new ChatGptAuthError("ChatGPT sign-in expired. Please try again.");
  if (claims.nonce !== nonce) throw new ChatGptAuthError("Sign-in failed a security check (nonce mismatch). Please try again.");
  if (!claims.sub) throw new ChatGptAuthError("ChatGPT sign-in did not identify an account.");
  return claims;
}

function randomToken(bytes = 32) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** @param {string} verifier */
async function pkceChallenge(verifier) {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** @param {Uint8Array} bytes */
function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} str */
function b64urlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
