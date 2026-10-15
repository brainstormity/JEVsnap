import { test } from "node:test";
import assert from "node:assert/strict";
import { JevClient, JevError, Question } from "../src/core/jevClient";
import { mockFetch, ok } from "./support";

const client = (m: ReturnType<typeof mockFetch>, over: Partial<ConstructorParameters<typeof JevClient>[0]> = {}) =>
  new JevClient({ apiKey: "test-key-123", baseURL: "https://api.example.test", maxRetries: 3, fetch: m.fetch, sleep: async () => {}, ...over });

test("request shape and headers (text-only requests do not opt in to the danger zone)", async () => {
  const m = mockFetch(() => ok({ q: { type: "noul", noul: 0.9 } }));
  const resp = await client(m).systemOne({ model: "jev-latest", state: "hello", questions: { q: Question.noul("Is it?", { true: "yes", false: "no" }) } });
  assert.deepEqual(resp.answers.q, { type: "noul", noul: 0.9 });
  assert.equal(resp.inputTokens, 10);
  const r = m.requests[0];
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://api.example.test/v1/systemone");
  assert.equal(r.headers.Authorization, "Bearer test-key-123");
  assert.equal(r.headers["TypeSafe-Danger-Zone-Images"], undefined);
  assert.equal(r.body.model, "jev-latest");
  assert.equal(r.body.questions.q.type, "noul");
  assert.equal(r.body.assets, undefined);
});

test("images and Box send the danger-zone header", async () => {
  const m = mockFetch(() => ok({ m: { type: "box", box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 }, confidence: 0.92 } }));
  const resp = await client(m).systemOne({
    model: "jev-preview", state: { photo: "ref-1" }, questions: { m: Question.box("the mug in `photo`") },
    assets: { "ref-1": { type: "image", format: "png", data_base64: "AAAA" } },
  });
  assert.equal(m.requests[0].headers["TypeSafe-Danger-Zone-Images"], "true");
  assert.deepEqual(resp.answers.m, { type: "box", box: { left: 0.44, top: 0.25, right: 0.84, bottom: 0.82 }, confidence: 0.92 });
  assert.equal(m.requests[0].body.assets["ref-1"].format, "png");
});

test("a Box question alone triggers the header", async () => {
  const m = mockFetch(() => ok({ b: { type: "box", box: { left: 0, top: 0, right: 1, bottom: 1 }, confidence: 0.9 } }));
  await client(m).systemOne({ model: "jev-preview", state: "x", questions: { b: Question.box("a") } });
  assert.equal(m.requests[0].headers["TypeSafe-Danger-Zone-Images"], "true");
});

test("answer parsing: invalid box, choice, score, junk", () => {
  assert.deepEqual(JevClient.parseAnswer({ type: "box", box: { top: 0.5, bottom: 0.2, left: 0.1, right: 0.3 }, confidence: 0.9 }), { type: "unknown" });
  assert.deepEqual(JevClient.parseAnswer({ type: "choice", choice: "one", probabilities: { none: 0.1, one: 0.9 }, confidence: 0.8 }),
    { type: "choice", choice: "one", probabilities: { none: 0.1, one: 0.9 }, confidence: 0.8 });
  assert.deepEqual(JevClient.parseAnswer({ type: "score", score: 1.5, confidence: 0.7 }), { type: "score", score: 1.5, confidence: 0.7 });
  assert.deepEqual(JevClient.parseAnswer("junk"), { type: "unknown" });
  assert.deepEqual(JevClient.parseAnswer({ type: "noul", noul: 7 }), { type: "unknown" });
});

test("retries 429 (honouring Retry-After) then succeeds", async () => {
  const m = mockFetch((_r, n) => (n < 3 ? { status: 429, body: {}, headers: { "retry-after": "0" } } : ok({ q: { type: "noul", noul: 0.1 } })));
  const resp = await client(m).systemOne({ model: "m", state: "s", questions: { q: Question.noul("?") } });
  assert.equal(resp.answers.q.type, "noul");
  assert.equal(m.requests.length, 3);
});

test("gives up after maxRetries", async () => {
  const m = mockFetch(() => ({ status: 529, body: {} }));
  await assert.rejects(client(m, { maxRetries: 2 }).systemOne({ model: "m", state: "s", questions: {} }), (e: JevError) => e.kind === "overloaded");
  assert.equal(m.requests.length, 3); // 1 try + 2 retries
});

test("does not retry client errors", async () => {
  const m = mockFetch(() => ({ status: 401, body: { error: { message: "bad key" } } }));
  await assert.rejects(client(m).systemOne({ model: "m", state: "s", questions: {} }), (e: JevError) => e.kind === "unauthorized");
  assert.equal(m.requests.length, 1);
});

test("surfaces the server's message but never the key", async () => {
  const m = mockFetch(() => ({ status: 422, body: { error: { message: "questions.q.type is invalid" } } }));
  await assert.rejects(client(m, { apiKey: "SECRET-KEY-XYZ" }).systemOne({ model: "m", state: "s", questions: {} }), (e: Error) => {
    assert.match(e.message, /rejected the request/);
    assert.doesNotMatch(e.message, /SECRET-KEY-XYZ/);
    return true;
  });
});

test("parses the real api.typesafe.ai error shape", () => {
  const body = JSON.stringify({ detail: { error_type: "authentication_error", message: "Cannot authenticate with the server." } });
  assert.equal(JevClient.errorMessage(body), "Cannot authenticate with the server.");
});

test("constructor validation", () => {
  assert.throws(() => new JevClient({ apiKey: "  " }), (e: JevError) => e.kind === "missingAPIKey");
  assert.throws(() => new JevClient({ apiKey: "k", baseURL: "http://api.typesafe.ai" }), (e: JevError) => e.kind === "insecureBaseURL");
  assert.throws(() => new JevClient({ apiKey: "bad\nkey" }), (e: JevError) => e.kind === "badRequest");
  assert.throws(() => new JevClient({ apiKey: "k", baseURL: "not a url" }), (e: JevError) => e.kind === "invalidBaseURL");
  assert.doesNotThrow(() => new JevClient({ apiKey: "k", baseURL: "http://localhost:8080" }));
  assert.doesNotThrow(() => new JevClient({ apiKey: " k \n" }));
});

test("listModels", async () => {
  const m = mockFetch(() => ({ status: 200, body: { models: [{ name: "jev-latest", description: "d" }, { name: "jev-preview" }] } }));
  assert.deepEqual(await client(m).listModels(), ["jev-latest", "jev-preview"]);
  assert.equal(m.requests[0].method, "GET");
  assert.ok(m.requests[0].url.endsWith("/v1/models"));
});

test("malformed responses are invalidResponse", async () => {
  const m = mockFetch(() => ({ status: 200, body: "not json" }));
  await assert.rejects(client(m).systemOne({ model: "m", state: "s", questions: {} }), (e: JevError) => e.kind === "invalidResponse");
});

test("network failures are retried then reported without leaking details of the key", async () => {
  let calls = 0;
  const c = new JevClient({
    apiKey: "SECRET-KEY-XYZ", baseURL: "https://api.example.test", maxRetries: 1, sleep: async () => {},
    fetch: async () => { calls++; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); },
  });
  await assert.rejects(c.listModels(), (e: JevError) => e.kind === "network" && !e.message.includes("SECRET"));
  assert.equal(calls, 2);
});
