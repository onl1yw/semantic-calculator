import { History } from "lucide-react";
import { knownMemoryWord } from "../storage.ts";
import type { CalculatorState } from "../storage.ts";

interface Props {
  state: CalculatorState | null;
  disabled: boolean;
  hasOperand: boolean;
  typing: boolean;
  error: string;
  historyOpen: boolean;
  onClear: () => void;
  onRecall: () => void;
  onAdd: () => void;
  onToggleHistory: () => void;
}

export function MemoryBar({
  state,
  disabled,
  hasOperand,
  typing,
  error,
  historyOpen,
  onClear,
  onRecall,
  onAdd,
  onToggleHistory,
}: Props) {
  const active = state?.right || state?.current;
  const memoryWord = state && knownMemoryWord(state);
  const similarity =
    !typing && !error && active?.similarity !== undefined
      ? `${(active.similarity * 100).toLocaleString("ru", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
      : null;

  return (
    <div className="memory-row">
      <button
        disabled={disabled || !state?.memory}
        onClick={onClear}
        aria-label="MC — очистить память"
      >
        MC
      </button>
      <button
        disabled={disabled || !state?.memory}
        onClick={onRecall}
        aria-label="MR — вызвать память"
      >
        MR
      </button>
      <button
        disabled={disabled || !hasOperand}
        onClick={onAdd}
        aria-label="M+ — добавить в память"
      >
        M+
      </button>
      <span
        className="memory-value"
        title={
          state?.memory ? `В памяти: ${memoryWord || "вектор"}` : "Память пуста"
        }
      >
        {state?.memory
          ? (memoryWord || "вектор").toLocaleUpperCase("ru")
          : "Память пуста"}
      </span>
      {similarity && (
        <span
          className="similarity"
          title={`Косинусная близость к слову «${active?.word}»: ${similarity}`}
          aria-label={`Близость результата: ${similarity}`}
        >
          {similarity}
        </span>
      )}
      <button
        className={`history-toggle ${historyOpen ? "is-active" : ""}`}
        aria-label="История вычислений и мой словарь"
        aria-expanded={historyOpen}
        onClick={onToggleHistory}
      >
        <History aria-hidden="true" strokeWidth={1.7} />
      </button>
    </div>
  );
}
