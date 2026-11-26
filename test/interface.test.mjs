import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Execute the actual inline UI module with a minimal DOM and controlled fetch.
// This covers state transitions, not real browser rendering/accessibility.
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const readyResponse = (topic, draft) => ({ ok: true, status: 200, json: async () => ({ status: "ready", topic, draft }) });
const manualResponse = { ok: true, status: 200, json: async () => ({ status: "manual_review", topic: null, draft: null }) };

function setup() {
  const elements = Object.fromEntries(["form", "#message", "#status", "#ready", "#topic", "#draft"].map(selector => {
    const listeners = new Map();
    return [selector, {
      value: "", textContent: "", hidden: selector === "#ready",
      addEventListener: (event, listener) => listeners.set(event, listener),
      dispatch: event => listeners.get(event)?.({ preventDefault() {} }),
    }];
  }));
  const pending = [];
  const fetch = (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject }));
  runInNewContext(script, { document: { querySelector: selector => elements[selector] }, fetch, AbortController, setTimeout, clearTimeout });
  function submit(text) {
    elements["#message"].value = text;
    elements["#message"].dispatch("input");
    return elements.form.dispatch("submit");
  }
  function assertCleared() {
    assert.equal(elements["#draft"].textContent, "");
    assert.equal(elements["#topic"].textContent, "");
    assert.equal(elements["#ready"].hidden, true);
  }
  return { elements, pending, submit, assertCleared };
}

async function showSuccess(ui) {
  const completion = ui.submit("доставка");
  ui.pending.at(-1).resolve(readyResponse("delivery", "Первый черновик"));
  await completion;
  assert.equal(ui.elements["#draft"].textContent, "Первый черновик");
  assert.equal(ui.elements["#ready"].hidden, false);
}

test("UI clears previous draft on manual review and preserves input", async () => {
  const ui = setup();
  await showSuccess(ui);
  const completion = ui.submit("[bad-topic]");
  ui.assertCleared();
  ui.pending.at(-1).resolve(manualResponse);
  await completion;
  ui.assertCleared();
  assert.match(ui.elements["#status"].textContent, /Требуется ручной разбор/);
  assert.equal(ui.elements["#message"].value, "[bad-topic]");
});

test("UI rejects whitespace without sending a request", async () => {
  const ui = setup();
  await showSuccess(ui);
  await ui.submit("   \n");
  ui.assertCleared();
  assert.equal(ui.pending.length, 1);
  assert.equal(ui.elements["#status"].textContent, "Введите текст заявки.");
});

test("UI keeps the latest successful response when the earlier one arrives last", async () => {
  const ui = setup();
  const first = ui.submit("доставка");
  const second = ui.submit("цена");
  assert.equal(ui.pending[0].options.signal.aborted, true);
  // The fake transport deliberately ignores cancellation.
  ui.pending[1].resolve(readyResponse("pricing", "Свежий черновик"));
  await second;
  ui.pending[0].resolve(readyResponse("delivery", "Устаревший черновик"));
  await first;
  assert.equal(ui.elements["#draft"].textContent, "Свежий черновик");
  assert.equal(ui.elements["#topic"].textContent, "Стоимость");
});

test("UI ignores a late network error from a superseded request", async () => {
  const ui = setup();
  const first = ui.submit("доставка");
  const second = ui.submit("цена");
  ui.pending[1].resolve(readyResponse("pricing", "Свежий черновик"));
  await second;
  ui.pending[0].reject(new Error("Network error"));
  await first;
  assert.equal(ui.elements["#draft"].textContent, "Свежий черновик");
  assert.match(ui.elements["#status"].textContent, /Черновик готов/);
});

test("UI enters manual review on current network error", async () => {
  const ui = setup();
  await showSuccess(ui);
  const completion = ui.submit("новая заявка");
  ui.pending.at(-1).reject(new Error("Network error"));
  await completion;
  ui.assertCleared();
  assert.match(ui.elements["#status"].textContent, /Требуется ручной разбор/);
});

test("UI rejects an invalid ready payload", async () => {
  const ui = setup();
  const completion = ui.submit("новая заявка");
  ui.pending.at(-1).resolve(readyResponse("refund", "  "));
  await completion;
  ui.assertCleared();
  assert.match(ui.elements["#status"].textContent, /Требуется ручной разбор/);
});
