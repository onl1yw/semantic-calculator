import { nearest, wordVector } from "./api.ts";
import { normalize, validVector } from "./math.ts";
import { mergeSourceWords } from "./storage.ts";
import type { Model, Operand } from "./storage.ts";
import type { Dictionary } from "./calculator.ts";

export const DEFINITIONS_KEY = "semantic-calculator:definitions:v1";
const MAX_DEFINITIONS = 100;
type StorageLike = Pick<Storage, "getItem" | "setItem">;
export interface LocalWord {
  name: string;
  vector: number[];
  definition: string;
  updatedAt: number;
}
export interface LocalRule {
  expression: string;
  targetWord: string;
  updatedAt: number;
}
export type DefinitionMode = "word" | "rule";
export type DefinitionEdit = { mode: "word"; word: LocalWord } | { mode: "rule"; rule: LocalRule };
export interface Definitions {
  schemaVersion: 1;
  modelId: string;
  modelRevision: string;
  words: LocalWord[];
  rules: LocalRule[];
}
export const cleanName = (value: string) => value.trim().normalize("NFC").toLocaleLowerCase("ru");

export function validateName(value: string): string {
  const name = cleanName(value);
  if (!name || name.length > 64 || !/^[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*$/u.test(name))
    throw new Error("Введите одно слово, до 64 букв. Дефис внутри слова можно.");
  return name;
}

export function expressionKey(value: string): string {
  const symbols: Record<string, string> = { "-": "−", "*": "×", "/": "÷" };
  return cleanName(value)
    .replace(/([+−×÷*/]|(?<!\p{L})-|-(?!\p{L}))/gu, (symbol) => ` ${symbols[symbol] || symbol} `)
    .replace(/−\s*\(\s*([\p{L}\p{M}-]+)\s*\)/gu, "− $1")
    .replace(/\s+/gu, " ").trim();
}

export const emptyDefinitions = (model: Model): Definitions => ({
  schemaVersion: 1, modelId: model.model_id, modelRevision: model.model_revision, words: [], rules: [],
});
const storageKey = (model: Model) => `${DEFINITIONS_KEY}:${model.model_id}:${model.model_revision}`;

export function restoreDefinitions(model: Model, storage: StorageLike): { definitions: Definitions; warning?: string } {
  const initial = emptyDefinitions(model);
  try {
    const raw = storage.getItem(storageKey(model));
    if (!raw) return { definitions: initial };
    if (raw.length > 2_000_000) throw new Error("Oversized definitions");
    const item = JSON.parse(raw) as Definitions;
    if (!item || item.schemaVersion !== 1 || item.modelId !== model.model_id ||
      item.modelRevision !== model.model_revision || !Array.isArray(item.words) ||
      !Array.isArray(item.rules) || item.words.length > MAX_DEFINITIONS || item.rules.length > MAX_DEFINITIONS)
      throw new Error("Invalid definitions");
    for (const word of item.words) {
      if (!word || validateName(word.name) !== word.name || !validVector(word.vector) ||
        !word.vector.some((n) => n !== 0) || typeof word.definition !== "string" ||
        !word.definition.trim() || word.definition.length > 2048 || !Number.isFinite(word.updatedAt))
        throw new Error("Invalid local word");
    }
    for (const rule of item.rules) {
      if (!rule || typeof rule.expression !== "string" || !rule.expression.trim() ||
        rule.expression.length > 2048 || !/[+−×÷]/u.test(expressionKey(rule.expression)) ||
        validateName(rule.targetWord) !== rule.targetWord || !Number.isFinite(rule.updatedAt))
        throw new Error("Invalid local rule");
    }
    if (new Set(item.words.map((word) => word.name)).size !== item.words.length ||
      new Set(item.rules.map((rule) => expressionKey(rule.expression))).size !== item.rules.length)
      throw new Error("Duplicate definitions");
    return { definitions: item };
  } catch {
    return { definitions: initial, warning: "Личный словарь недоступен или повреждён. Расчёты можно продолжить." };
  }
}

export function persistDefinitions(definitions: Definitions, model: Model, storage: StorageLike): boolean {
  try {
    storage.setItem(storageKey(model), JSON.stringify(definitions));
    return true;
  } catch { return false; }
}

export function defineWord(definitions: Definitions, name: string, operand: Operand): Definitions {
  name = validateName(name);
  normalize(operand.vector);
  if (!definitions.words.some((word) => word.name === name) && definitions.words.length >= MAX_DEFINITIONS)
    throw new Error("В личном словаре можно сохранить до 100 слов.");
  const word = { name, vector: [...operand.vector], definition: operand.expression, updatedAt: Date.now() };
  return { ...definitions, words: [word, ...definitions.words.filter((item) => item.name !== name)] };
}

export function defineRule(definitions: Definitions, expression: string, targetWord: string): Definitions {
  const key = expressionKey(expression);
  if (!key || !/[+−×÷]/u.test(key) || expression.length > 2048)
    throw new Error("Свой ответ можно задать для выражения с операцией.");
  targetWord = validateName(targetWord);
  if (!definitions.rules.some((rule) => expressionKey(rule.expression) === key) && definitions.rules.length >= MAX_DEFINITIONS)
    throw new Error("Можно сохранить до 100 своих правил.");
  return { ...definitions, rules: [{ expression, targetWord, updatedAt: Date.now() },
    ...definitions.rules.filter((rule) => expressionKey(rule.expression) !== key)] };
}

export function replaceWord(definitions: Definitions, previousName: string, name: string, operand: Operand): Definitions {
  name = validateName(name);
  if (name !== previousName && definitions.words.some((word) => word.name === name))
    throw new Error(`«${name}» уже есть в личном словаре. Выберите другое имя.`);
  const next = defineWord({ ...definitions,
    words: definitions.words.filter((word) => word.name !== previousName) }, name, operand);
  return { ...next, rules: next.rules.map((rule) => rule.targetWord === previousName
    ? { ...rule, targetWord: name } : rule) };
}

export function replaceRule(definitions: Definitions, previousExpression: string, expression: string, name: string): Definitions {
  const previousKey = expressionKey(previousExpression);
  if (expressionKey(expression) !== previousKey && definitions.rules.some((rule) =>
    expressionKey(rule.expression) === expressionKey(expression)))
    throw new Error("Для этого выражения уже есть свой ответ. Измените существующее правило.");
  return defineRule(removeRule(definitions, previousExpression), expression, name);
}

export function removeWord(definitions: Definitions, name: string): Definitions {
  return { ...definitions, words: definitions.words.filter((word) => word.name !== name),
    rules: definitions.rules.filter((rule) => rule.targetWord !== name) };
}
export const removeRule = (definitions: Definitions, expression: string): Definitions => ({
  ...definitions, rules: definitions.rules.filter((rule) => expressionKey(rule.expression) !== expressionKey(expression)),
});

export function matchingWords(definitions: Definitions, prefix: string, base: string[] = []): string[] {
  const names = definitions.words.filter((word) => word.name.startsWith(cleanName(prefix))).map((word) => word.name);
  return [...new Set([...names, ...base])].slice(0, 9);
}

// Each resolver captures one version of the personal dictionary for a whole calculation.
export function createDictionary(definitions: Definitions, base: Dictionary = { word: wordVector, nearest }): Dictionary {
  const findWord = (name: string) => definitions.words.find((word) => word.name === cleanName(name));
  const dictionary: Dictionary = {
    word: async (name, model) => {
      const local = findWord(name);
      return local ? { word: local.name, vector: [...local.vector], expression: local.name,
        sourceWords: [local.name] } : base.word(name, model);
    },
    nearest: async (vector, expression, model, sourceWords = []) => {
      const sources = mergeSourceWords(sourceWords);
      const rule = definitions.rules.find((item) => expressionKey(item.expression) === expressionKey(expression));
      if (rule) {
        const target = await dictionary.word(rule.targetWord, model);
        return { word: target.word, vector: [...target.vector], expression, sourceWords: sources };
      }
      const direction = normalize(vector);
      let localBest: Operand | undefined;
      for (const word of definitions.words) {
        if (sources.includes(word.name)) continue;
        const candidate = normalize(word.vector);
        const score = Math.max(-1, Math.min(1, direction.reduce((sum, n, i) => sum + n * candidate[i], 0)));
        if (!localBest || score > localBest.similarity!)
          localBest = { word: word.name, vector, expression, sourceWords: sources, similarity: score };
      }
      if (localBest && localBest.similarity! >= 1 - 1e-10) return localBest;
      // Custom names need not be sent to the base dictionary. Retry only if its winner
      // uses an overridden name: that old vector no longer represents the local word.
      let excluded = sources.filter((name) => !findWord(name));
      for (let i = 0; i <= definitions.words.length; i++) {
        const result = await base.nearest(vector, expression, model, excluded);
        if (!findWord(result.word)) {
          return localBest && localBest.similarity! >= result.similarity! - 1e-6 ? localBest
            : { ...result, sourceWords: sources };
        }
        excluded = mergeSourceWords(excluded, [result.word]);
      }
      throw new Error("Не удалось выбрать слово. Попробуйте другое выражение.");
    },
  };
  return dictionary;
}
