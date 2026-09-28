import { Divide, Equal, Keyboard, Minus, Plus, X } from "lucide-react";
import type { Operator } from "../math.ts";

const OPERATORS: Operator[] = ["÷", "×", "−", "+"];
const OP_ICONS = { "÷": Divide, "×": X, "−": Minus, "+": Plus };
const OP_LABELS = {
  "÷": "Деление",
  "×": "Умножение",
  "−": "Вычитание",
  "+": "Сложение",
};

interface Props {
  disabled: boolean;
  hasOperand: boolean;
  typing: boolean;
  operation: Operator | null | undefined;
  words: string[];
  highlighted: number;
  onClear: () => void;
  onChangeSign: () => void;
  onRedefine: () => void;
  onOperator: (op: Operator) => void;
  onChoose: (word: string) => void;
  onType: () => void;
  onEquals: () => void;
}

function OperatorKey({
  op,
  selected,
  disabled,
  onClick,
}: {
  op: Operator;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = OP_ICONS[op];
  return (
    <button
      className={`key operator ${selected ? "selected" : ""}`}
      disabled={disabled}
      aria-label={OP_LABELS[op]}
      aria-pressed={selected}
      onClick={onClick}
    >
      <Icon aria-hidden="true" strokeWidth={1.7} />
    </button>
  );
}

export function CalculatorKeypad({
  disabled,
  hasOperand,
  typing,
  operation,
  words,
  highlighted,
  onClear,
  onChangeSign,
  onRedefine,
  onOperator,
  onChoose,
  onType,
  onEquals,
}: Props) {
  return (
    <div
      className="keypad"
      id="word-options"
      role="group"
      aria-label="Слова и операции"
    >
      <button className="key utility" disabled={disabled} onClick={onClear}>
        AC
      </button>
      <button
        className="key utility"
        disabled={disabled || !hasOperand}
        onClick={onChangeSign}
        aria-label="Изменить знак вектора"
      >
        <svg
          aria-hidden="true"
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        >
          <path d="M4 10h10M9 5v10M18 23h10M21 4 11 28" />
        </svg>
      </button>
      <button
        className="key utility"
        disabled={disabled}
        aria-label="RE — переопределить результат"
        onClick={onRedefine}
      >
        RE
      </button>
      <OperatorKey
        op="÷"
        selected={operation === "÷"}
        disabled={disabled}
        onClick={() => onOperator("÷")}
      />
      {[0, 1, 2].map((row) => (
        <div className="key-row" key={row}>
          {[0, 1, 2].map((col) => {
            const index = row * 3 + col;
            const word = words[index];
            return (
              <button
                id={`word-option-${index}`}
                className={`key word-key ${highlighted === index ? "highlighted" : ""}`}
                key={col}
                disabled={disabled || !word}
                onClick={() => word && onChoose(word)}
                title={word}
              >
                {word || "·"}
              </button>
            );
          })}
          <OperatorKey
            op={OPERATORS[row + 1]}
            selected={operation === OPERATORS[row + 1]}
            disabled={disabled}
            onClick={() => onOperator(OPERATORS[row + 1])}
          />
        </div>
      ))}
      <button
        className="key type-key"
        disabled={disabled}
        aria-label="Ввести слово или выражение"
        aria-pressed={typing}
        onClick={onType}
      >
        <Keyboard aria-hidden="true" strokeWidth={1.7} />
      </button>
      <button
        className="key operator equals"
        disabled={disabled}
        aria-label="Равно"
        onClick={onEquals}
      >
        <Equal aria-hidden="true" strokeWidth={1.7} />
      </button>
    </div>
  );
}
