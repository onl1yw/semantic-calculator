import test from "node:test";
import assert from "node:assert/strict";
import { calculate } from "./math.ts";
import { emptyState, persist, restore, STORAGE_KEY } from "./storage.ts";

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
