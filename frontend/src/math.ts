export const DIMENSIONS = 300;
export type Operator = "+" | "−" | "×" | "÷";

export function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === DIMENSIONS &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export function normalize(vector: number[]): number[] {
  if (!validVector(vector))
    throw new Error("Вектор должен содержать 300 конечных чисел.");
  const scale = Math.max(...vector.map(Math.abs));
  if (!scale)
    throw new Error("Получился нулевой вектор. У него нет ближайшего слова.");
  const scaled = vector.map((n) => n / scale);
  const norm = Math.hypot(...scaled);
  return scaled.map((n) => n / norm);
}

export function calculate(a: number[], op: Operator, b: number[]): number[] {
  if (!validVector(a) || !validVector(b))
    throw new Error("Некорректный вектор операнда.");
  const result = a.map((value, i) => {
    switch (op) {
      case "+":
        return value + b[i];
      case "−":
        return value - b[i];
      case "×":
        return value * b[i];
      case "÷":
        if (b[i] === 0)
          throw new Error("Деление невозможно: в векторе делителя есть ноль.");
        return value / b[i];
    }
  });
  if (!validVector(result))
    throw new Error("Результат слишком большой для вычисления.");
  // Validate its direction without changing the accumulator's magnitude.
  normalize(result);
  return result;
}
