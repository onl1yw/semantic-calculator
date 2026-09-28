import { normalize } from "./math.ts";
import { mergeSourceWords } from "./storage.ts";
import type { Model, Operand } from "./storage.ts";

export class ApiError extends Error {
  public status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok)
      throw new ApiError(
        body.detail || "Не удалось выполнить запрос.",
        response.status,
      );
    return body as T;
  } catch (error) {
    if (
      error instanceof ApiError ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw error;
    throw new Error("Нет связи со словарём. Попробуйте ещё раз.");
  }
}

const cache = new Map<string, Operand>();
export const health = () => request<Model & { status: string }>("/api/health");
export const suggest = (prefix: string, signal: AbortSignal) =>
  request<{ words: string[] }>(
    `/api/words?prefix=${encodeURIComponent(prefix)}`,
    { signal },
  );

export async function wordVector(word: string, model: Model): Promise<Operand> {
  const key = `${model.model_revision}:${word.toLocaleLowerCase("ru")}`;
  if (cache.has(key)) return cache.get(key)!;
  const data = await request<Model & { word: string; vector: number[] }>(
    `/api/words/${encodeURIComponent(word)}/vector`,
  );
  if (data.model_revision !== model.model_revision)
    throw new Error("Модель обновилась. Перезагрузите страницу.");
  const value = { word: data.word, vector: data.vector, expression: data.word,
    sourceWords: [data.word] };
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

export async function nearest(
  vector: number[],
  expression: string,
  model: Model,
  sourceWords: string[] = [],
): Promise<Operand> {
  const sources = mergeSourceWords(sourceWords);
  const data = await request<Model & { word: string; similarity: number }>(
    "/api/nearest",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_revision: model.model_revision,
        vector: normalize(vector),
        exclude_words: sources,
      }),
    },
  );
  return { word: data.word, similarity: data.similarity, vector, expression,
    sourceWords: sources };
}
