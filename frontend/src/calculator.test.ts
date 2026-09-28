import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "./api.ts";
import {
  addMemory, draftCompletion, finish, operate, parseInput, recallMemory, UnknownWordError,
} from "./calculator.ts";
import { emptyState } from "./storage.ts";
import type { Model, Operand } from "./storage.ts";

const model = { model_id: "test", model_revision: "one", dimensions: 300, count: 100 };
const operand = (word: string, value: number): Operand => ({
  word, vector: Array(300).fill(value), expression: word, sourceWords: [word],
});
const words = new Map([
  ["король", operand("король", 5)], ["мужчина", operand("мужчина", 2)],
  ["женщина", operand("женщина", 3)], ["королева", operand("королева", 99)],
]);
const api = {
  word: async (word: string, _model: Model) => {
    if (!words.has(word)) throw new ApiError("Not found", 404);
    return words.get(word)!;
  },
  nearest: async (vector: number[], expression: string, _model: Model, sources: string[] = []) =>
    ({ word: "королева", vector, expression, sourceWords: sources, similarity: 0.75 }),
};

test("typed chains keep the full accumulator rather than the intermediate displayed word", async () => {
  const state = await finish({ ...emptyState(model), draft: "король - мужчина+женщина=" }, model, api);
  assert.equal(state.current?.word, "королева");
  assert.deepEqual(state.current?.vector, Array(300).fill(6));
  assert.equal(state.current?.expression, "король − мужчина + женщина");
  assert.deepEqual(state.current?.sourceWords, ["король", "мужчина", "женщина"]);
  assert.equal(state.history.length, 2);
  assert.equal(state.operation, null);
  assert.equal(state.draft, "");
});

test("an operator suffix starts an operation and the next Enter completes it", async () => {
  const pending = await finish({ ...emptyState(model), draft: "королева +" }, model, api);
  assert.equal(pending.current?.word, "королева");
  assert.equal(pending.operation, "+");
  assert.equal(pending.right, null);
  assert.equal(pending.history.length, 0);
  const result = await finish({ ...pending, draft: "женщина" }, model, api);
  assert.deepEqual(result.current?.vector, Array(300).fill(102));
});

test("a leading sign continues a result; a whole expression starts its own calculation", async () => {
  const previous = { ...emptyState(model), current: operand("король", 10) };
  const continued = await finish({ ...previous, draft: "+ женщина" }, model, api);
  assert.deepEqual(continued.current?.vector, Array(300).fill(13));
  const pending = await operate(previous, "+", model, api);
  const fresh = await finish({ ...pending, draft: "король − мужчина" }, model, api);
  assert.deepEqual(fresh.current?.vector, Array(300).fill(3));
});

test("unknown words reject the entire draft before search, leaving result and memory intact", async () => {
  const previous = {
    ...emptyState(model), current: operand("король", 10), memory: Array(300).fill(7),
    draft: "король − мужчина + абракадабраззз",
  };
  const copy = structuredClone(previous);
  let searches = 0;
  await assert.rejects(finish(previous, model, {
    ...api, nearest: async (...args) => { searches++; return api.nearest(...args); },
  }), (error: unknown) => error instanceof UnknownWordError && /абракадабраззз/.test(error.message));
  assert.equal(searches, 0);
  assert.deepEqual(previous, copy);
});

test("syntax errors stay local and dictionary hyphens are preserved", () => {
  assert.deepEqual(parseInput("вице-король + женщина").map((token) => token.value),
    ["вице-король", "+", "женщина"]);
  assert.deepEqual(parseInput("король*женщина/мужчина").map((token) => token.value),
    ["король", "×", "женщина", "÷", "мужчина"]);
  assert.throws(() => parseInput("король + + женщина"), /После знака/);
  assert.throws(() => parseInput("король женщина"), /Между словами/);
  assert.throws(() => parseInput("король = + женщина"), /Между словами/);
});

test("suggestion completion replaces only the last word in the expression", () => {
  const completion = draftCompletion("король − мужчина + же");
  assert.equal(completion.prefix, "же");
  assert.equal(completion.replaceWith("женщина"), "король − мужчина + женщина");
  assert.equal(draftCompletion("королева +").prefix, "");
});

test("memory displays its saved word and recall retains its full vector", async () => {
  const result = { ...operand("королева", 6), expression: "король − мужчина + женщина" };
  const saved = await addMemory({ ...emptyState(model), current: result }, model, api);
  assert.equal(saved.memoryWord, "королева");
  const recalled = await recallMemory(saved, model, api);
  assert.deepEqual(recalled.current?.vector, Array(300).fill(6));
  assert.equal(recalled.current?.word, "королева");
  const added = await addMemory({ ...saved, current: operand("женщина", 3) }, model, api);
  assert.deepEqual(added.memory, Array(300).fill(9));
  assert.equal(added.memoryWord, "королева");
});

test("zero memory can be displayed but cannot become a word operand", async () => {
  const zero = await addMemory({ ...emptyState(model), memory: Array(300).fill(-3),
    current: operand("женщина", 3) }, model, api);
  assert.equal(zero.memoryWord, "0");
  await assert.rejects(recallMemory(zero, model, api), /нулевой вектор/);
});
