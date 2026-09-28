import test from "node:test";
import assert from "node:assert/strict";
import { nearest, wordVector } from "./api.ts";

const model = { model_id: "test", model_revision: "api-tests", dimensions: 300, count: 100 };

test("search sends source exclusions while preserving the full accumulated vector", async (t) => {
  const vector = Array(300).fill(3);
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    assert.equal(path, "/api/nearest");
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.exclude_words, ["король", "мужчина", "женщина"]);
    assert.equal(body.model_revision, model.model_revision);
    assert.ok(Math.abs(Math.hypot(...body.vector) - 1) < 1e-12);
    assert.equal(body.expression, undefined);
    assert.equal(body.history, undefined);
    return Response.json({ ...model, word: "правитель", similarity: .69 });
  });
  const result = await nearest(vector, "король − мужчина + женщина", model,
    ["Король", "мужчина", "женщина", "КОРОЛЬ"]);
  assert.equal(result.vector, vector);
  assert.deepEqual(vector, Array(300).fill(3));
  assert.deepEqual(result.sourceWords, ["король", "мужчина", "женщина"]);
});

test("a directly entered word starts a new source list", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    ...model, word: "король", vector: Array(300).fill(1 / Math.sqrt(300)),
  }));
  const operand = await wordVector("король", model);
  assert.deepEqual(operand.sourceWords, ["король"]);
});
