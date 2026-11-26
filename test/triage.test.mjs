import assert from "node:assert/strict";
import { once } from "node:events";
import { test, before, after } from "node:test";
import { createTriageServer } from "../server.mjs";

const server = createTriageServer();
let baseUrl;
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function postRaw(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  return { status: response.status, body: await response.json() };
}
const post = input => postRaw(JSON.stringify(input));
const manualReview = { status: 200, body: { status: "manual_review", topic: null, draft: null } };

for (const [label, input] of [
  ["empty", { text: "" }], ["whitespace", { text: " \t\n" }],
  ["missing", {}], ["number", { text: 42 }], ["boolean", { text: true }],
  ["null text", { text: null }], ["null body", null], ["array text", { text: [] }],
]) {
  test(`invalid input: ${label}`, async () => {
    assert.deepEqual(await post(input), { status: 400, body: { status: "invalid_input" } });
  });
}
test("malformed JSON returns 400", async () => {
  assert.deepEqual(await postRaw('{"text":'), { status: 400, body: { status: "invalid_input" } });
});

for (const [text, topic] of [["  Где доставка?  ", "delivery"], ["Какая цена?", "pricing"], ["Здравствуйте", "other"]]) {
  test(`valid AI response: ${topic}`, async () => {
    assert.deepEqual(await post({ text }), { status: 200, body: {
      status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки.",
    } });
  });
}

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`AI failure ${marker} returns manual review`, async () => {
    assert.deepEqual(await post({ text: marker }), manualReview);
  });
}

test("AI timeout returns manual review before the 1200 ms mock delay", async () => {
  const start = performance.now();
  assert.deepEqual(await post({ text: "[timeout]" }), manualReview);
  // Allow scheduling/HTTP overhead in CI, but reject waiting for the full mock delay.
  assert.ok(performance.now() - start < 1000, "request should not wait for the mock's 1200 ms delay");
});

test("a failure after success never returns a previous draft", async () => {
  assert.equal((await post({ text: "доставка" })).body.status, "ready");
  assert.deepEqual(await post({ text: "[empty-draft]" }), manualReview);
  assert.equal((await post({ text: "цена" })).body.topic, "pricing");
});
