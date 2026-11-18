// Provider-agnostic LLM client. Three wire protocols cover every supported provider:
// - OpenAI Chat Completions (OpenAI, Gemini, OpenRouter, Ollama, LM Studio, ...)
// - Anthropic Messages
// - OpenAI Responses, billed to the user's ChatGPT plan ("Sign in with ChatGPT")
//
// Responses are streamed. Besides allowing progress feedback, this matters in an MV3 service worker:
// Chrome may terminate a worker whose fetch() response takes more than 30s to start arriving, and
// slow local models can easily exceed that for a non-streamed reply.

const REQUEST_TIMEOUT_MS = 180_000;
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 8192;

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** @typedef {"settings" | "retry"} ErrorAction */

export class LlmError extends Error {
  /**
   * @param {string} message  User-facing message.
   * @param {{status?: number, code?: string, link?: {text: string, url: string}, actions?: ErrorAction[], cause?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { cause: opts.cause });
    this.name = "LlmError";
    /** What the user can do about it; drives the buttons on the error card. */
    this.actions = opts.actions ?? [];
    this.status = opts.status;
    /** Provider error code, e.g. "subscription_sharing_usage_limit_exceeded". */
    this.code = opts.code;
    /** Optional action for the user, e.g. a "Manage usage" link. */
    this.link = opts.link;
  }
}

/** ChatGPT plan errors that are temporary: keep the sign-in, retry with backoff. */
export const TRANSIENT_PLAN_ERRORS = new Set(["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"]);

/**
 * @typedef {ReturnType<typeof import("./settings.js").activeConnection>} Connection
 */

/**
 * Run a single system+user turn and return the model's full text reply.
 * @param {Connection} conn
 * @param {{system: string, user: string, onDelta?: (textSoFar: string) => void}} req
 * @returns {Promise<string>}
 */
export async function complete(conn, { system, user, onDelta }) {
  validateConnection(conn);
  const protocol = PROTOCOLS[conn.api];
  const { url, init } = protocol.request(conn, system, user);

  const res = await fetchWithTimeout(url, init, conn);
  let text = "";
  let completed = false;
  for await (const data of readSse(res)) {
    const { delta, done } = protocol.event(data);
    if (delta) {
      text += delta;
      onDelta?.(text);
    }
    if (done) completed = true;
  }
  if (protocol.requireCompleted && !completed) {
    throw new LlmError(`${conn.label} stopped before finishing the reply. Please try again.`, { actions: ["retry"] });
  }
  return cleanOutput(text);
}

/**
 * List the models the provider exposes to this account.
 * @param {Connection} conn
 * @returns {Promise<{id: string, label: string}[]>}
 */
export async function listModels(conn) {
  validateConnection(conn, { requireModel: false });
  const headers = conn.api === "anthropic" ? anthropicHeaders(conn) : openaiHeaders(conn);
  const query = conn.api === "chatgpt" ? "" : "?limit=1000";
  const res = await fetchWithTimeout(`${conn.baseUrl}/models${query}`, { headers }, conn);
  const body = await res.json();
  const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  /** @type {Map<string, string>} */
  const models = new Map();
  for (const m of items) {
    if (m.visibility && m.visibility !== "list") continue; // ChatGPT plan: only user-selectable models
    const id = String(m.id ?? m.slug ?? m.name ?? "").replace(/^models\//, "");
    if (id && !models.has(id)) models.set(id, String(m.display_name ?? id));
  }
  const list = [...models].map(([id, label]) => ({ id, label }));
  // ChatGPT returns its models in a meaningful order; other providers' lists are sorted by id.
  return conn.api === "chatgpt" ? list : list.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// Request builders

/** @param {Connection} conn */
function openaiHeaders(conn) {
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  if (conn.apiKey) headers.authorization = `Bearer ${conn.apiKey}`;
  return headers;
}

/** @param {Connection} conn */
function anthropicHeaders(conn) {
  return {
    "content-type": "application/json",
    "x-api-key": conn.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    // Required for requests that carry a browser/extension Origin header.
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** @param {Connection} conn @param {string} system @param {string} user */
function openaiRequest(conn, system, user) {
  // No temperature / max_tokens: several current models (reasoning models in particular) reject
  // non-default values, and provider defaults are fine for proofreading-length outputs.
  return {
    url: `${conn.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: openaiHeaders(conn),
      body: JSON.stringify({
        model: conn.model,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
  };
}

/** @param {Connection} conn @param {string} system @param {string} user */
function anthropicRequest(conn, system, user) {
  return {
    url: `${conn.baseUrl}/messages`,
    init: {
      method: "POST",
      headers: anthropicHeaders(conn),
      body: JSON.stringify({
        model: conn.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        stream: true,
        system,
        messages: [{ role: "user", content: user }],
      }),
    },
  };
}

/**
 * ChatGPT plan usage: Responses API with store:false + stream:true. Sampling parameters
 * (temperature, max_output_tokens, ...) are not supported in this mode.
 * @param {Connection} conn @param {string} system @param {string} user
 */
function chatgptRequest(conn, system, user) {
  return {
    url: `${conn.baseUrl}/responses`,
    init: {
      method: "POST",
      headers: openaiHeaders(conn),
      body: JSON.stringify({
        model: conn.model,
        instructions: system,
        input: [{ role: "user", content: user }],
        store: false,
        stream: true,
      }),
    },
  };
}

/** @typedef {{delta?: string, done?: boolean}} StreamEvent */

/** @param {any} data @returns {StreamEvent} */
function openaiEvent(data) {
  if (data?.error) throw new LlmError(errorMessageFromBody(data) ?? "The provider returned an error.", { actions: ["retry"] });
  return { delta: data?.choices?.[0]?.delta?.content ?? "" };
}

/** @param {any} data @returns {StreamEvent} */
function anthropicEvent(data) {
  if (data?.type === "error") throw new LlmError(errorMessageFromBody(data) ?? "The provider returned an error.", { actions: ["retry"] });
  if (data?.type === "content_block_delta" && data.delta?.type === "text_delta") return { delta: data.delta.text ?? "" };
  return {};
}

/** @param {any} data @returns {StreamEvent} */
function responsesEvent(data) {
  switch (data?.type) {
    case "response.output_text.delta":
      return { delta: data.delta ?? "" };
    case "response.completed":
      return { done: true };
    case "response.failed":
      throw planError(data.response?.error ?? {});
    case "response.incomplete":
      throw new LlmError("ChatGPT stopped before finishing the reply (it may be too long). Try a shorter selection.");
    case "error":
      throw planError(data.error ?? data);
  }
  return {};
}

/**
 * @type {Record<import("./settings.js").ApiKind, {
 *   request: (conn: Connection, system: string, user: string) => {url: string, init: RequestInit},
 *   event: (data: any) => StreamEvent,
 *   requireCompleted: boolean,
 * }>}
 */
const PROTOCOLS = {
  openai: { request: openaiRequest, event: openaiEvent, requireCompleted: false },
  anthropic: { request: anthropicRequest, event: anthropicEvent, requireCompleted: false },
  chatgpt: { request: chatgptRequest, event: responsesEvent, requireCompleted: true },
};

/**
 * Map ChatGPT plan-usage error codes to what the user should see and do.
 * https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 * @param {{code?: string, message?: string, param?: string}} err
 * @param {number} [status]
 */
function planError(err, status) {
  const code = err.code ?? "unknown_error";
  const manage = { text: "Manage usage", url: CHATGPT_USAGE_URL };
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new LlmError("Usage limit reached. Requests using your ChatGPT plan are paused for now.", { status, code, link: manage });
    case "subscription_sharing_user_not_eligible":
      return new LlmError(
        "Your ChatGPT account or workspace cannot use its plan in other apps. Choose a provider with an API key in the Nibly settings.",
        { status, code, actions: ["settings"] },
      );
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return new LlmError("ChatGPT plan usage is temporarily unavailable. You are still signed in - try again in a moment.", { status, code, actions: ["retry"] });
    case "subscription_sharing_invalid_user":
      return new LlmError("ChatGPT did not accept your sign-in. Sign in again in the Nibly settings.", { status, code, actions: ["settings"] });
    case "subscription_sharing_unsupported_capability":
      return new LlmError(`ChatGPT plan usage does not support ${err.param ? `"${err.param}"` : "this request"}. Try another model.`, { status, code, actions: ["settings"] });
    default:
      return new LlmError(err.message ? `ChatGPT: ${err.message}` : `ChatGPT returned an error (${code}).`, { status, code, actions: ["retry"] });
  }
}

// ---------------------------------------------------------------------------------------------
// Transport

/**
 * @param {Connection} conn
 * @param {{requireModel?: boolean}} [opts]
 */
function validateConnection(conn, { requireModel = true } = {}) {
  if (!conn.baseUrl) throw new LlmError(`Set a base URL for ${conn.label} in the Nibly settings.`, { actions: ["settings"] });
  try {
    new URL(conn.baseUrl);
  } catch {
    throw new LlmError(`"${conn.baseUrl}" is not a valid URL.`, { actions: ["settings"] });
  }
  if (conn.needsKey && !conn.apiKey) throw new LlmError(`Add your ${conn.label} API key in the Nibly settings.`, { actions: ["settings"] });
  if (requireModel && !conn.model) throw new LlmError(`Choose a model for ${conn.label} in the Nibly settings.`, { actions: ["settings"] });
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {Connection} conn
 */
async function fetchWithTimeout(url, init, conn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  /** @type {Response} */
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new LlmError(`${conn.label} did not respond in time.`, { cause: err, actions: ["retry"] });
    const hint = isLocalUrl(url)
      ? " Is the local server running? For Ollama you may need to allow extension origins (see the README)."
      : " Check your internet connection and the base URL.";
    throw new LlmError(`Could not reach ${conn.label}.${hint}`, { cause: err, actions: ["retry", "settings"] });
  }
  // The timer keeps running while the body streams; it is cleared when the stream ends.
  const clear = () => clearTimeout(timer);
  if (!res.ok) {
    clear();
    throw await httpError(res, conn);
  }
  if (!res.body) {
    clear();
    return res;
  }
  // Wrap the body so the timeout is cleared when the caller finishes reading it.
  const reader = res.body.getReader();
  const body = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clear();
          ctrl.close();
        } else {
          ctrl.enqueue(value);
        }
      } catch (err) {
        clear();
        ctrl.error(
          controller.signal.aborted ? new LlmError(`${conn.label} did not respond in time.`, { cause: err, actions: ["retry"] }) : err,
        );
      }
    },
    cancel(reason) {
      clear();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

/**
 * Parse a Server-Sent Events stream, yielding each `data:` payload as JSON.
 * Falls back to treating the whole body as one JSON document when the server ignored `stream: true`.
 * @param {Response} res
 * @returns {AsyncGenerator<any>}
 */
export async function* readSse(res) {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const body = await res.json().catch(() => null);
    // Convert a non-streamed reply into the shape of a single delta event.
    if (body?.choices) yield { choices: [{ delta: { content: body.choices[0]?.message?.content ?? "" } }] };
    else if (body?.content) {
      for (const block of body.content) {
        if (block.type === "text") yield { type: "content_block_delta", delta: { type: "text_delta", text: block.text } };
      }
    } else if (body) yield body;
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  /** @type {string[]} */
  let dataLines = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        const payload = dataLines.join("\n");
        dataLines = [];
        if (payload && payload !== "[DONE]") yield parseJson(payload);
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  const tail = [...dataLines, buffer.startsWith("data:") ? buffer.slice(5).trim() : ""].filter(Boolean).join("\n");
  if (tail && tail !== "[DONE]") yield parseJson(tail);
}

/** @param {string} payload */
function parseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch (err) {
    throw new LlmError("The provider sent a response Nibly could not understand.", { cause: err });
  }
}

/** @param {Response} res @param {Connection} conn */
async function httpError(res, conn) {
  const raw = await res.text().catch(() => "");
  let detail;
  let body;
  try {
    body = JSON.parse(raw);
    detail = errorMessageFromBody(body);
  } catch {
    detail = raw.slice(0, 300).trim();
  }
  if (conn.api === "chatgpt") {
    if (body?.error?.code) return planError(body.error, res.status);
    if (res.status === 401) {
      return new LlmError("ChatGPT did not accept your sign-in.", { status: 401, code: "subscription_sharing_invalid_user", actions: ["settings"] });
    }
  }
  const prefix = {
    401: `${conn.label} rejected the API key.`,
    403: isLocalUrl(res.url)
      ? `${conn.label} refused the request. For Ollama, allow extension origins (see the README).`
      : `${conn.label} denied access.`,
    404: `${conn.label} could not find that endpoint or model.`,
    429: `${conn.label} rate limit or quota reached.`,
  }[res.status] ?? `${conn.label} returned HTTP ${res.status}.`;
  const actions = res.status === 429 || res.status >= 500 ? ["retry"] : ["settings"];
  return new LlmError(detail ? `${prefix} ${detail}` : prefix, { status: res.status, actions });
}

/** @param {any} body @returns {string | undefined} */
function errorMessageFromBody(body) {
  const e = body?.error;
  if (typeof e === "string") return e;
  if (typeof e?.message === "string") return e.message;
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.detail === "string") return body.detail;
  if (Array.isArray(body) && body[0]?.error?.message) return body[0].error.message;
  return undefined;
}

/** @param {string} url */
function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".local");
  } catch {
    return false;
  }
}

/**
 * Remove artifacts models sometimes add despite instructions: reasoning blocks from local
 * "thinking" models and a code fence wrapped around the whole answer.
 * @param {string} text
 */
export function cleanOutput(text) {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // An unterminated <think> at the very start means the model never closed it; drop it entirely.
  out = out.replace(/^\s*<think>[\s\S]*$/i, "");
  const fenced = out.trim().match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fenced) out = fenced[1];
  return out.trim();
}
