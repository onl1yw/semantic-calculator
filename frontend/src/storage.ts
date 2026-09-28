import { DIMENSIONS, validVector } from "./math.ts";
import type { Operator } from "./math.ts";

export const STORAGE_KEY = "semantic-calculator:state:v1";
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
    history: [],
  };
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
      ![null, "+", "−", "×", "÷"].includes(item.operation) ||
      (item.right !== null && (!item.current || !item.operation)) ||
      (item.operation !== null && !item.current) ||
      typeof item.draft !== "string" ||
      item.draft.length > 64 ||
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
