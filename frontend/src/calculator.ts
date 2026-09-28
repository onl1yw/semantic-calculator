import { ApiError, nearest, wordVector } from "./api.ts";
import { calculate, validVector } from "./math.ts";
import type { Operator } from "./math.ts";
import { memorySources, mergeSourceWords, operandSources } from "./storage.ts";
import type { CalculatorState, Model, Operand } from "./storage.ts";

export const MAX_DRAFT_LENGTH = 1024;
const SYMBOLS: Record<string, Operator> = {
  "+": "+", "−": "−", "-": "−", "×": "×", "*": "×", "÷": "÷", "/": "÷",
};
const SEPARATOR = /([+−×÷*/=]|(?<!\p{L})-|-(?!\p{L}))/u;
type Token = { kind: "word"; value: string } | { kind: "operator"; value: Operator };
export type Dictionary = { word: typeof wordVector; nearest: typeof nearest };
const dictionary: Dictionary = { word: wordVector, nearest };

export class UnknownWordError extends Error {}

export function parseInput(value: string): Token[] {
  if (value.length > MAX_DRAFT_LENGTH) throw new Error("Выражение слишком длинное.");
  const parts = value.trim().split(SEPARATOR).map((part) => part.trim()).filter(Boolean);
  if (parts.at(-1) === "=") parts.pop();
  const tokens: Token[] = parts.map((part) => {
    if (SYMBOLS[part]) return { kind: "operator", value: SYMBOLS[part] };
    if (!/^[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*$/u.test(part))
      throw new Error("Между словами нужен знак + или −. Например: король − мужчина + женщина.");
    if (part.length > 64) throw new Error("Слово должно быть не длиннее 64 символов.");
    return { kind: "word", value: part };
  });
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].kind === tokens[i - 1].kind)
      throw new Error("После знака нужно слово. Например: королева + женщина.");
  }
  return tokens;
}

// Preserve the rest of a typed expression when choosing its last word.
export function draftCompletion(draft: string): { prefix: string; replaceWith: (word: string) => string } {
  const parts = draft.split(SEPARATOR);
  const tail = parts.at(-1) || "";
  const prefix = tail.trim();
  return {
    prefix: /^[\p{L}\p{M}-]+$/u.test(prefix) ? prefix : "",
    replaceWith: (word) => draft.slice(0, draft.length - tail.length) + tail.match(/^\s*/u)![0] + word,
  };
}

export async function lookupWord(word: string, model: Model, api = dictionary): Promise<Operand> {
  try {
    return await api.word(word, model);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404)
      throw new UnknownWordError(`«${word}» нет в словаре. Исправьте слово или выберите подсказку.`);
    throw cause;
  }
}

export function insertOperand(state: CalculatorState, operand: Operand): CalculatorState {
  return state.current && state.operation
    ? { ...state, right: operand, draft: "" }
    : { ...state, current: operand, right: null, operation: null, draft: "" };
}

async function finishCurrent(state: CalculatorState, model: Model, api: Dictionary): Promise<CalculatorState> {
  if (!state.current) throw new Error("Сначала введите слово.");
  if (!state.operation) return state;
  if (!state.right) throw new Error("Введите второе слово или выберите его из подсказок.");
  const vector = calculate(state.current.vector, state.operation, state.right.vector);
  let expression = `${state.current.expression} ${state.operation} ${state.right.expression}`;
  if (expression.length > 2048)
    expression = `… ${state.current.word} ${state.operation} ${state.right.word}`;
  const operand = await api.nearest(vector, expression, model,
    mergeSourceWords(operandSources(state.current), operandSources(state.right)));
  return {
    ...state, current: operand, right: null, operation: null,
    history: [{ ...operand, id: crypto.randomUUID(), timestamp: Date.now() }, ...state.history].slice(0, 50),
  };
}

async function evaluateDraft(state: CalculatorState, model: Model, complete: boolean, api: Dictionary): Promise<CalculatorState> {
  if (!state.draft.trim()) return complete ? finishCurrent(state, model, api) : state;
  const tokens = parseInput(state.draft);
  if (!tokens.length) throw new Error("Сначала введите слово.");
  // Validate every word before calculating; an unknown word leaves the snapshot intact.
  const operands: Operand[] = [];
  for (const token of tokens) {
    if (token.kind === "word") operands.push(await lookupWord(token.value, model, api));
  }
  let next = { ...state, draft: "" };
  const unaryMinus = tokens[0].kind === "operator" && tokens[0].value === "−" && tokens[1]?.kind === "word";
  if (unaryMinus || (tokens[0].kind === "word" && operands.length > 1))
    next = { ...next, current: null, right: null, operation: null };
  let index = 0;
  let start = 0;
  if (unaryMinus) {
    const first = operands[index++];
    const negative = await api.nearest(first.vector.map((n) => -n), `−${first.expression}`, model, operandSources(first));
    next = insertOperand(next, negative);
    next.history = [{ ...negative, id: crypto.randomUUID(), timestamp: Date.now() }, ...next.history].slice(0, 50);
    start = 2;
  }
  for (const token of tokens.slice(start)) {
    if (token.kind === "word") {
      next = insertOperand(next, operands[index++]);
    } else {
      if (next.operation && next.right) next = await finishCurrent(next, model, api);
      if (!next.current) throw new Error("Перед знаком нужно слово или результат.");
      next = { ...next, operation: token.value, right: null };
    }
  }
  return complete && tokens.at(-1)?.kind !== "operator" ? finishCurrent(next, model, api) : next;
}

export const withDraft = (state: CalculatorState, model: Model, api = dictionary) =>
  evaluateDraft(state, model, false, api);
export const finish = (state: CalculatorState, model: Model, api = dictionary) =>
  evaluateDraft(state, model, true, api);

export async function operate(state: CalculatorState, op: Operator, model: Model, api = dictionary): Promise<CalculatorState> {
  let next = await withDraft(state, model, api);
  if (next.operation && next.right) next = await finishCurrent(next, model, api);
  if (!next.current) throw new Error("Сначала введите слово.");
  return { ...next, operation: op, right: null, draft: "" };
}

export async function addMemory(state: CalculatorState, model: Model, api = dictionary): Promise<CalculatorState> {
  const next = await withDraft(state, model, api);
  const active = next.right || next.current;
  if (!active) throw new Error("Сначала введите слово или получите результат.");
  const vector = next.memory ? next.memory.map((n, i) => n + active.vector[i]) : [...active.vector];
  if (!validVector(vector)) throw new Error("Вектор памяти слишком большой.");
  const sources = mergeSourceWords(memorySources(next), operandSources(active));
  const word = !vector.some((n) => n !== 0) ? "0" : next.memory
    ? (await api.nearest(vector, "Память", model, sources)).word : active.word;
  return { ...next, memory: vector, memoryWord: word, memorySourceWords: sources };
}

export async function recallMemory(state: CalculatorState, model: Model, api = dictionary): Promise<CalculatorState> {
  if (!state.memory) throw new Error("Память пока пуста. Сохраните результат кнопкой M+.");
  if (!state.memory.some((n) => n !== 0)) throw new Error("В памяти нулевой вектор. Добавьте слово кнопкой M+.");
  const sources = memorySources(state);
  const operand = state.memoryWord
    ? { word: state.memoryWord, vector: [...state.memory], expression: "Память", sourceWords: sources }
    : await api.nearest(state.memory, "Память", model, sources);
  return insertOperand(state, operand);
}

export async function negate(state: CalculatorState, model: Model, api = dictionary): Promise<CalculatorState> {
  const next = await withDraft(state, model, api);
  const active = next.right || next.current;
  if (!active) throw new Error("Сначала введите слово.");
  const expression = active.expression.length < 2044 ? `−(${active.expression})` : `−(${active.word})`;
  const operand = await api.nearest(active.vector.map((n) => -n), expression, model, operandSources(active));
  return next.right ? { ...next, right: operand } : { ...next, current: operand };
}
