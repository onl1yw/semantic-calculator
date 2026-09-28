import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "./api.ts";
import { finish, lookupWord, negate } from "./calculator.ts";
import type { Dictionary } from "./calculator.ts";
import {
  createDictionary, defineRule, defineWord, emptyDefinitions, expressionKey, matchingWords,
  persistDefinitions, removeRule, removeWord, replaceRule, replaceWord, restoreDefinitions,
} from "./definitions.ts";
import { emptyState } from "./storage.ts";
import type { Operand } from "./storage.ts";

const model = { model_id: "test", model_revision: "definitions-test", dimensions: 300, count: 100 };
const vector = (x: number, y = 0) => [x, y, ...Array(298).fill(0)];
const operand = (word: string, x: number, y = 0): Operand => ({
  word, expression: word, vector: vector(x, y), sourceWords: [word],
});
const entries = [operand("ум", 1), operand("красота", 0, 1), operand("мужчина", 1), operand("женщина", 0, 1)];
const base: Dictionary = {
  word: async (word) => {
    const entry = entries.find((item) => item.word === word.toLocaleLowerCase("ru"));
    if (!entry) throw new ApiError("Not found", 404);
    return entry;
  },
  nearest: async (values, expression, _model, excluded = []) => {
    const norm = Math.hypot(...values);
    const candidates = entries.filter((word) => !excluded.includes(word.word))
      .map((word) => ({ word: word.word, similarity: values.reduce((sum, n, i) => sum + n * word.vector[i], 0) / norm }))
      .sort((a, b) => b.similarity - a.similarity);
    return { ...candidates[0], vector: values, expression, sourceWords: excluded };
  },
};
const storage = () => {
  const items = new Map<string, string>();
  return { items, getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); } };
};

test("a personal word retains magnitude and can be decomposed after reload", async () => {
  const result = await finish({ ...emptyState(model), draft: "ум + красота" }, model, base);
  const definitions = defineWord(emptyDefinitions(model), "МИША", result.current!);
  const data = storage();
  assert.equal(persistDefinitions(definitions, model, data), true);
  const dictionary = createDictionary(restoreDefinitions(model, data).definitions, base);
  const word = await lookupWord("Миша", model, dictionary);
  assert.deepEqual(word.vector, vector(1, 1));
  assert.deepEqual(word.sourceWords, ["миша"]);
  const answer = await finish({ ...emptyState(model), draft: "миша − красота" }, model, dictionary);
  assert.equal(answer.current?.word, "ум");
  assert.deepEqual(answer.current?.vector, vector(1));
});

test("personal words appear in completions and can become nearest results", async () => {
  const definitions = defineWord(emptyDefinitions(model), "миша", {
    ...operand("ум", 1, 1), expression: "ум + красота",
  });
  assert.deepEqual(matchingWords(definitions, "ми", ["мир", "миша"]), ["миша", "мир"]);
  const dictionary = createDictionary(definitions, base);
  const result = await finish({ ...emptyState(model), draft: "ум + красота" }, model, dictionary);
  assert.equal(result.current?.word, "миша");
  assert.ok(Math.abs(result.current!.similarity! - 1) < 1e-12);
});

test("rules replace the result vector and agree between typed unary minus and the sign button", async () => {
  const definitions = defineRule(emptyDefinitions(model), "−(мужчина)", "женщина");
  const dictionary = createDictionary(definitions, base);
  assert.equal(expressionKey("-мужчина"), expressionKey("−(мужчина)"));
  const state = await finish({ ...emptyState(model), current: operand("ум", 7), draft: "-мужчина" }, model, dictionary);
  assert.equal(state.current?.word, "женщина");
  assert.deepEqual(state.current?.vector, vector(0, 1));
  assert.deepEqual(state.current?.sourceWords, ["мужчина"]);
  const signed = await negate({ ...emptyState(model), current: entries[2] }, model, dictionary);
  assert.deepEqual(signed.current?.vector, state.current?.vector);
  const continued = await finish({ ...state, draft: "+ красота" }, model, dictionary);
  assert.deepEqual(continued.current?.vector, vector(0, 2));
  assert.deepEqual((await dictionary.word("женщина", model)).vector, vector(0, 1));
});

test("saved rules restore and can use local word definitions", async () => {
  const data = storage();
  let definitions = defineWord(emptyDefinitions(model), "миша", operand("ум", 4, 3));
  definitions = defineRule(definitions, "ум + красота", "миша");
  persistDefinitions(definitions, model, data);
  const dictionary = createDictionary(restoreDefinitions(model, data).definitions, base);
  const result = await finish({ ...emptyState(model), draft: "ум+красота" }, model, dictionary);
  assert.deepEqual(result.current?.vector, vector(4, 3));
  assert.equal(result.current?.word, "миша");
});

test("overridden base words use the local vector and their old vectors cannot win search", async () => {
  const definitions = defineWord(emptyDefinitions(model), "ум", operand("женщина", 0, 1));
  const searches: string[][] = [];
  const dictionary = createDictionary(definitions, { ...base, nearest: async (...args) => {
    searches.push(args[3] || []);
    return base.nearest(...args);
  } });
  assert.deepEqual((await dictionary.word("ум", model)).vector, vector(0, 1));
  const result = await dictionary.nearest(vector(1), "выражение", model);
  assert.equal(result.word, "мужчина");
  assert.deepEqual(searches, [[], ["ум"]]);
});

test("a used personal name is excluded locally without excluding its definition's components", async () => {
  const definitions = defineWord(emptyDefinitions(model), "миша", operand("ум", 1, 1));
  const searches: string[][] = [];
  const dictionary = createDictionary(definitions, { ...base, nearest: async (...args) => {
    searches.push(args[3] || []);
    return base.nearest(...args);
  } });
  const result = await dictionary.nearest(vector(1, 1), "миша + ум", model, ["миша", "ум"]);
  assert.notEqual(result.word, "миша");
  assert.deepEqual(searches, [["ум"]]);
  assert.deepEqual(result.sourceWords, ["миша", "ум"]);
});

test("definitions are isolated by model revision and storage failures are reported", () => {
  const data = storage();
  const definitions = defineWord(emptyDefinitions(model), "миша", operand("ум", 1));
  persistDefinitions(definitions, model, data);
  assert.deepEqual(restoreDefinitions({ ...model, model_revision: "next" }, data).definitions.words, []);
  assert.deepEqual(restoreDefinitions(model, data).definitions, definitions);
  assert.equal(persistDefinitions(definitions, model, { getItem: () => null,
    setItem: () => { throw new Error("quota"); } }), false);
  const key = [...data.items.keys()][0];
  for (const invalid of ["{bad", JSON.stringify({ ...definitions, words: [{ ...definitions.words[0], vector: [1] }] }),
    JSON.stringify({ ...definitions, words: [definitions.words[0], definitions.words[0]] })]) {
    data.setItem(key, invalid);
    assert.ok(restoreDefinitions(model, data).warning);
  }
});

test("editing and removal preserve other definitions and remove dependent rules", () => {
  let definitions = defineWord(emptyDefinitions(model), "миша", operand("ум", 1));
  definitions = defineWord(definitions, "миша", operand("ум", 2));
  assert.equal(definitions.words.length, 1);
  assert.deepEqual(definitions.words[0].vector, vector(2));
  definitions = defineRule(definitions, "ум + красота", "миша");
  definitions = defineRule(definitions, "ум+красота", "женщина");
  assert.equal(definitions.rules.length, 1);
  assert.equal(removeRule(definitions, "ум + красота").rules.length, 0);
  definitions = defineRule(definitions, "−мужчина", "миша");
  const removed = removeWord(definitions, "миша");
  assert.equal(removed.words.length, 0);
  assert.equal(removed.rules.length, 1);
  assert.equal(removed.rules[0].targetWord, "женщина");
  assert.throws(() => defineWord(definitions, "ум + красота", operand("ум", 1)), /одно слово/);
  assert.throws(() => defineWord(definitions, "ноль", operand("ум", 0)), /нулевой вектор/);
});

test("renaming a personal word retains its full value and updates dependent rules after reload", async () => {
  let definitions = defineWord(emptyDefinitions(model), "миша", {
    ...operand("ум", 4, 3), expression: "ум + красота",
  });
  definitions = defineRule(definitions, "−мужчина", "миша");
  const renamed = replaceWord(definitions, "миша", "Михаил", {
    ...operand("ум", 8, 2), expression: "ум + ум",
  });
  assert.equal(definitions.words[0].name, "миша");
  assert.equal(definitions.rules[0].targetWord, "миша");
  assert.equal(renamed.words.length, 1);
  assert.equal(renamed.rules[0].targetWord, "михаил");
  const data = storage();
  persistDefinitions(renamed, model, data);
  const restored = restoreDefinitions(model, data).definitions;
  assert.deepEqual(restored.words[0].vector, vector(8, 2));
  assert.equal(restored.words[0].definition, "ум + ум");
  const result = await finish({ ...emptyState(model), draft: "−мужчина" }, model, createDictionary(restored, base));
  assert.equal(result.current?.word, "михаил");
  assert.deepEqual(result.current?.vector, vector(8, 2));
});

test("editing a rule removes the old match and rejects conflicting or invalid edits atomically", async () => {
  let definitions = defineRule(emptyDefinitions(model), "−мужчина", "женщина");
  definitions = defineRule(definitions, "ум + красота", "женщина");
  const edited = replaceRule(definitions, "−мужчина", "−красота", "ум");
  assert.equal(edited.rules.length, 2);
  assert.equal(edited.rules.some((rule) => expressionKey(rule.expression) === expressionKey("−мужчина")), false);
  const answer = await finish({ ...emptyState(model), draft: "−красота" }, model, createDictionary(edited, base));
  assert.equal(answer.current?.word, "ум");
  assert.deepEqual(answer.current?.vector, vector(1));
  assert.throws(() => replaceRule(definitions, "−мужчина", "ум+красота", "ум"), /уже есть/);
  assert.throws(() => replaceRule(definitions, "−мужчина", "ум", "женщина"), /с операцией/);
  assert.equal(definitions.rules.length, 2);
  assert.equal(definitions.rules[1].expression, "−мужчина");
  let words = defineWord(emptyDefinitions(model), "миша", operand("ум", 4));
  words = defineWord(words, "саша", operand("ум", 2));
  assert.throws(() => replaceWord(words, "миша", "саша", operand("ум", 7)), /уже есть/);
  assert.throws(() => replaceWord(words, "миша", "миша", operand("ум", 0)), /нулевой вектор/);
  assert.deepEqual(words.words.find((word) => word.name === "миша")?.vector, vector(4));
});
