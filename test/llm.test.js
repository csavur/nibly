import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { complete, listModels, cleanOutput, LlmError } from "../src/llm.js";

/** @type {http.Server} */
let server;
let base = "";
/** @type {{url: string, headers: http.IncomingHttpHeaders, body: any}[]} */
const seen = [];

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(e);
  res.end();
};

before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const path = req.url.split("?")[0];

    if (path === "/openai/chat/completions") {
      // Split one event across two writes and use CRLF to exercise the parser.
      return sse(res, [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\r\n\r\ndata: {"choices":[{"del',
        'ta":{"content":"world."}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    if (path === "/think/chat/completions") {
      return sse(res, [`data: ${JSON.stringify({ choices: [{ delta: { content: "<think>hmm\nok</think>\n\nFixed text" } }] })}\n\n`]);
    }
    if (path === "/nostream/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "Plain reply" } }] }));
    }
    if (path === "/anthropic/messages") {
      return sse(res, [
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Bonjour"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" le monde"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    }
    if (path === "/anthropic-err/messages") {
      return sse(res, ['event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n']);
    }
    if (path === "/bad-key/chat/completions") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Incorrect API key provided." } }));
    }
    if (path === "/openai/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }] }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const conn = (path, extra = {}) => ({
  providerId: "x",
  label: "Test",
  api: "openai",
  baseUrl: `${base}/${path}`,
  apiKey: "sk-test",
  model: "m",
  needsKey: true,
  ...extra,
});

test("OpenAI-compatible streaming reply is assembled and request is well-formed", async () => {
  const deltas = [];
  const text = await complete(conn("openai"), { system: "SYS", user: "USER", onDelta: (t) => deltas.push(t) });
  assert.equal(text, "Hello world.");
  assert.deepEqual(deltas, ["Hello ", "Hello world."]);
  const req = seen.at(-1);
  assert.equal(req.headers.authorization, "Bearer sk-test");
  assert.equal(req.body.stream, true);
  assert.equal(req.body.model, "m");
  assert.deepEqual(req.body.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "USER" },
  ]);
  assert.equal("temperature" in req.body, false);
});

test("Anthropic streaming reply and headers", async () => {
  const text = await complete(conn("anthropic", { api: "anthropic" }), { system: "SYS", user: "USER" });
  assert.equal(text, "Bonjour le monde");
  const req = seen.at(-1);
  assert.equal(req.headers["x-api-key"], "sk-test");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(req.body.system, "SYS");
  assert.ok(req.body.max_tokens > 0);
});

test("Anthropic in-stream error surfaces as LlmError", async () => {
  await assert.rejects(complete(conn("anthropic-err", { api: "anthropic" }), { system: "s", user: "u" }), {
    name: "LlmError",
    message: /Overloaded/,
  });
});

test("reasoning blocks are stripped", async () => {
  assert.equal(await complete(conn("think"), { system: "s", user: "u" }), "Fixed text");
});

test("server that ignores stream:true still works", async () => {
  assert.equal(await complete(conn("nostream"), { system: "s", user: "u" }), "Plain reply");
});

test("HTTP 401 gives a clear message including the provider's detail", async () => {
  await assert.rejects(complete(conn("bad-key"), { system: "s", user: "u" }), (err) => {
    assert.ok(err instanceof LlmError);
    assert.equal(err.status, 401);
    assert.match(err.message, /rejected the API key/);
    assert.match(err.message, /Incorrect API key/);
    return true;
  });
});

test("unreachable local server gives a helpful hint", async () => {
  const c = conn("x", { baseUrl: "http://localhost:1/v1", needsKey: false, apiKey: "" });
  await assert.rejects(complete(c, { system: "s", user: "u" }), { message: /Is the local server running/ });
});

test("missing key / model are reported before any request", async () => {
  const before = seen.length;
  await assert.rejects(complete(conn("openai", { apiKey: "" }), { system: "s", user: "u" }), { message: /API key/ });
  await assert.rejects(complete(conn("openai", { model: "" }), { system: "s", user: "u" }), { message: /model/ });
  assert.equal(seen.length, before);
});

test("local providers do not send an Authorization header", async () => {
  await complete(conn("openai", { apiKey: "", needsKey: false }), { system: "s", user: "u" });
  assert.equal(seen.at(-1).headers.authorization, undefined);
});

test("listModels returns sorted unique ids", async () => {
  assert.deepEqual(await listModels(conn("openai", { model: "" })), [
    { id: "a-model", label: "a-model" },
    { id: "b-model", label: "b-model" },
  ]);
});

test("cleanOutput", () => {
  assert.equal(cleanOutput("  hi  "), "hi");
  assert.equal(cleanOutput("```\nline1\nline2\n```"), "line1\nline2");
  assert.equal(cleanOutput("<think>never closed"), "");
  assert.equal(cleanOutput("Keep ``` inside"), "Keep ``` inside");
});
