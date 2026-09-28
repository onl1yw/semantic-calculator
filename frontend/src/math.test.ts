import test from "node:test";
import assert from "node:assert/strict";
import { calculate, normalize, validVector } from "./math.ts";

const vector = (n: number) => Array<number>(300).fill(n);

test("sequential operations retain magnitude and equal the direct sum", () => {
  const a = vector(2),
    b = vector(3),
    d = vector(4);
  const accumulated = calculate(a, "+", b);
  const direction = normalize(accumulated);
  assert.deepEqual(accumulated, vector(5));
  assert.ok(Math.abs(Math.hypot(...direction) - 1) < 1e-12);
  assert.deepEqual(calculate(accumulated, "+", d), vector(9));
  assert.deepEqual(a, vector(2));
});

test("multiplication and division are componentwise", () => {
  assert.deepEqual(calculate(vector(6), "×", vector(2)), vector(12));
  assert.deepEqual(calculate(vector(6), "÷", vector(2)), vector(3));
  assert.deepEqual(calculate(vector(6), "−", vector(2)), vector(4));
});

test("zero results, division by zero, overflow, and invalid dimensions fail explicitly", () => {
  assert.throws(() => calculate(vector(2), "−", vector(2)), /нулевой/);
  assert.throws(() => calculate(vector(2), "÷", vector(0)), /делителя/);
  assert.throws(
    () => calculate(vector(Number.MAX_VALUE), "×", vector(2)),
    /слишком большой/,
  );
  assert.equal(validVector([1, 2]), false);
  assert.equal(validVector(vector(NaN)), false);
  assert.equal(validVector(vector(Infinity)), false);
});

test("normalization supports large finite magnitudes without changing the input", () => {
  const huge = vector(1e308);
  assert.ok(Math.abs(Math.hypot(...normalize(huge)) - 1) < 1e-12);
  assert.equal(huge[0], 1e308);
});
