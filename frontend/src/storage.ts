import { DIMENSIONS, validVector } from "./math.ts";
import type { Operator } from "./math.ts";

export const STORAGE_KEY = "semantic-calculator:state:v1";
export const MAX_SOURCE_WORDS = 128;
export interface Model {
  model_id: string;
  model_revision: string;
  dimensions: number;
  count: number;
}
export interface Operand {
  word: string;
  vector: number[];
  expression: string;
  similarity?: number;
  sourceWords?: string[];
}
export interface HistoryEntry extends Operand {
  id: string;
  timestamp: number;
}
export interface CalculatorState {
  schemaVersion: 1;
  modelId: string;
  modelRevision: string;
  current: Operand | null;
  right: Operand | null;
  operation: Operator | null;
  draft: string;
  memory: number[] | null;
  memoryWord?: string;
  memorySourceWords?: string[];
  history: HistoryEntry[];
}
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function emptyState(model: Model): CalculatorState {
  return {
    schemaVersion: 1,
    modelId: model.model_id,
    modelRevision: model.model_revision,
    current: null,
    right: null,
    operation: null,
    draft: "",
    memory: null,
    memorySourceWords: [],
    history: [],
  };
}

export function mergeSourceWords(...groups: string[][]): string[] {
  const words = [...new Set(groups.flat().map((word) =>
    word.trim().normalize("NFC").toLocaleLowerCase("ru"),
  ).filter(Boolean))];
  if (words.length > MAX_SOURCE_WORDS)
    throw new Error("В одной цепочке можно использовать до 128 разных слов. Начните новую кнопкой AC.");
  return words;
}

export function operandSources(operand: Operand): string[] {
  if (operand.sourceWords) return operand.sourceWords;
  // Recover inputs from expressions saved before source tracking was added.
  if (operand.expression === "Память") return [];
  return mergeSourceWords(
    operand.expression.replace(/−\(/gu, "").replace(/\)/gu, "")
      .split(/\s+[+−×÷]\s+/u).filter((word) => word !== "…"),
  );
}

export function memorySources(state: CalculatorState): string[] {
  if (state.memorySourceWords) return state.memorySourceWords;
  if (!state.memory) return [];
  // Older memory did not record inputs; recover them when its vector is known.
  const match = [state.right, state.current, ...state.history].find((operand) =>
    operand && operand.vector.every((value, i) => value === state.memory![i]),
  );
  return match ? operandSources(match) : [];
}

export function knownMemoryWord(state: CalculatorState): string | undefined {
  if (!state.memory) return undefined;
  if (state.memoryWord) return state.memoryWord;
  if (!state.memory.some((n) => n !== 0)) return "0";
  return [state.right, state.current, ...state.history].find((operand) =>
    operand && operand.vector.every((value, i) => value === state.memory![i]),
  )?.word;
}

function validSources(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) &&
    value.length <= MAX_SOURCE_WORDS && value.every((word) =>
      typeof word === "string" && word.length > 0 && word.length <= 128 &&
      word.trim().length > 0,
    ));
}

function validOperand(value: unknown): value is Operand {
  if (!value || typeof value !== "object") return false;
  const item = value as Operand;
  return (
    typeof item.word === "string" &&
    item.word.length <= 128 &&
    typeof item.expression === "string" &&
    item.expression.length <= 2048 &&
    validVector(item.vector) &&
    item.vector.some((n) => n !== 0) &&
    validSources(item.sourceWords) &&
    (item.similarity === undefined ||
      (typeof item.similarity === "number" &&
        Number.isFinite(item.similarity) &&
        Math.abs(item.similarity) <= 1))
  );
}

export function restore(
  model: Model,
  storage: StorageLike,
): { state: CalculatorState; warning?: string } {
  const initial = emptyState(model);
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { state: initial };
    if (raw.length > 2_000_000) throw new Error("Oversized state");
    const item = JSON.parse(raw) as CalculatorState;
    if (!item || item.schemaVersion !== 1 || model.dimensions !== DIMENSIONS)
      throw new Error("Schema");
    if (
      item.modelId !== model.model_id ||
      item.modelRevision !== model.model_revision
    ) {
      return {
        state: initial,
        warning: "Модель обновилась. Начинаем с чистого калькулятора.",
      };
    }
    if (
      (item.current !== null && !validOperand(item.current)) ||
      (item.right !== null && !validOperand(item.right)) ||
      (item.memory !== null && !validVector(item.memory)) ||
      (item.memoryWord !== undefined && (typeof item.memoryWord !== "string" ||
        !item.memoryWord.trim() || item.memoryWord.length > 128)) ||
      !validSources(item.memorySourceWords) ||
      ![null, "+", "−", "×", "÷"].includes(item.operation) ||
      (item.right !== null && (!item.current || !item.operation)) ||
      (item.operation !== null && !item.current) ||
      typeof item.draft !== "string" ||
      item.draft.length > 1024 ||
      !Array.isArray(item.history) ||
      item.history.length > 50 ||
      !item.history.every(
        (entry) =>
          validOperand(entry) &&
          typeof entry.id === "string" &&
          entry.id.length <= 128 &&
          typeof entry.timestamp === "number" &&
          Number.isFinite(entry.timestamp),
      )
    ) {
      throw new Error("Invalid saved state");
    }
    return { state: item };
  } catch {
    return {
      state: initial,
      warning:
        "Сохранение недоступно или повреждено. Можно продолжить в этой вкладке.",
    };
  }
}

export function persist(state: CalculatorState, storage: StorageLike): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
