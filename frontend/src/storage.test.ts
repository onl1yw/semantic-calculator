import test from "node:test";
import assert from "node:assert/strict";
import { calculate } from "./math.ts";
import {
  emptyState, knownMemoryWord, memorySources, mergeSourceWords, operandSources, persist, restore, STORAGE_KEY,
} from "./storage.ts";

const model = {
  model_id: "test",
  model_revision: "one",
  dimensions: 300,
  count: 100,
};
const storage = () => {
  const items = new Map<string, string>([["unrelated", "keep"]]);
  return {
    items,
    getItem: (key: string) => items.get(key) || null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
};

test("reload restores full accumulated vectors and memory rather than the displayed word", () => {
  const data = storage();
  const raw = calculate(Array(300).fill(2), "+", Array(300).fill(3));
  const state = {
    ...emptyState(model),
    current: { word: "ближайшее", vector: raw, expression: "A + B" },
    memory: raw,
  };
  assert.equal(persist(state, data), true);
  const loaded = restore(model, data).state;
  assert.deepEqual(loaded.memory, Array(300).fill(5));
  assert.deepEqual(
    calculate(loaded.memory!, "+", Array(300).fill(4)),
    Array(300).fill(9),
  );
  assert.equal(data.items.get("unrelated"), "keep");
});

test("a pending operation survives reload", () => {
  const data = storage();
  const operand = { word: "A", vector: Array(300).fill(2), expression: "A" };
  const state = {
    ...emptyState(model),
    current: operand,
    right: operand,
    operation: "+" as const,
    draft: "ко",
  };
  persist(state, data);
  assert.deepEqual(restore(model, data).state, state);
});

test("model changes and corrupted storage start safely", () => {
  const data = storage();
  persist(emptyState(model), data);
  assert.ok(restore({ ...model, model_revision: "two" }, data).warning);
  data.setItem(STORAGE_KEY, "{bad");
  assert.deepEqual(restore(model, data).state, emptyState(model));
  const bad = { ...emptyState(model), memory: [1, 2] };
  data.setItem(STORAGE_KEY, JSON.stringify(bad));
  assert.ok(restore(model, data).warning);
});

test("storage failures do not require a server fallback", () => {
  const blocked = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.equal(persist(emptyState(model), blocked), false);
  assert.deepEqual(restore(model, blocked).state, emptyState(model));
});

test("source words survive chains, memory, history, and reload", () => {
  const sources = mergeSourceWords(["Король", "мужчина"], ["женщина", "КОРОЛЬ"]);
  assert.deepEqual(sources, ["король", "мужчина", "женщина"]);
  const operand = {
    word: "правитель", vector: Array(300).fill(3),
    expression: "король − мужчина + женщина", sourceWords: sources,
  };
  const state = {
    ...emptyState(model), current: operand, memory: operand.vector,
    memorySourceWords: sources,
    history: [{ ...operand, id: "one", timestamp: 1 }],
  };
  const data = storage();
  persist(state, data);
  const loaded = restore(model, data).state;
  assert.deepEqual(operandSources(loaded.current!), sources);
  assert.deepEqual(memorySources(loaded), sources);
  assert.deepEqual(operandSources(loaded.history[0]), sources);
  assert.deepEqual(mergeSourceWords(memorySources(loaded), ["собака"]),
    [...sources, "собака"]);
});

test("older saved expressions and known memory recover their source words", () => {
  const operand = {
    word: "король", vector: Array(300).fill(3),
    expression: "−(король − мужчина) + женщина",
  };
  const state = { ...emptyState(model), current: operand, memory: operand.vector };
  delete state.memorySourceWords;
  const data = storage();
  persist(state, data);
  const loaded = restore(model, data).state;
  assert.deepEqual(operandSources(loaded.current!), ["король", "мужчина", "женщина"]);
  assert.deepEqual(memorySources(loaded), ["король", "мужчина", "женщина"]);
});

test("invalid source metadata is rejected and long chains fail explicitly", () => {
  const data = storage();
  const state = { ...emptyState(model), memorySourceWords: [1] };
  data.setItem(STORAGE_KEY, JSON.stringify(state));
  assert.ok(restore(model, data).warning);
  assert.throws(() => mergeSourceWords(Array.from({ length: 129 }, (_, i) => `слово${i}`)),
    /128/);
});

test("memory labels and expression drafts survive reload, including legacy known memory", () => {
  const data = storage();
  const current = { word: "королева", vector: Array(300).fill(3), expression: "король − мужчина + женщина" };
  const state = { ...emptyState(model), current, memory: current.vector,
    memoryWord: "королева", draft: "король − мужчина + женщина + королева + мужчина + женщина + король" };
  assert.ok(state.draft.length > 64);
  persist(state, data);
  assert.deepEqual(restore(model, data).state, state);
  assert.equal(knownMemoryWord({ ...state, memoryWord: undefined }), "королева");
});

test("invalid memory labels and oversized drafts are rejected on reload", () => {
  const data = storage();
  for (const patch of [{ memoryWord: 42 }, { memoryWord: "" }, { draft: "а".repeat(1025) }]) {
    data.setItem(STORAGE_KEY, JSON.stringify({ ...emptyState(model), ...patch }));
    assert.ok(restore(model, data).warning);
  }
});
