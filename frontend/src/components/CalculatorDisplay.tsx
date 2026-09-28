import type { Dispatch, RefObject, SetStateAction } from "react";
import { MAX_DRAFT_LENGTH } from "../calculator.ts";
import type { CalculatorState } from "../storage.ts";

interface Props {
  state: CalculatorState | null;
  typing: boolean;
  disabled: boolean;
  error: string;
  warning: string;
  inputRef: RefObject<HTMLInputElement | null>;
  matches: string[];
  highlighted: number;
  onHighlight: Dispatch<SetStateAction<number>>;
  onChange: (draft: string) => void;
  onChoose: (word: string, complete: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function CalculatorDisplay({
  state,
  typing,
  disabled,
  error,
  warning,
  inputRef,
  matches,
  highlighted,
  onHighlight,
  onChange,
  onChoose,
  onSubmit,
  onCancel,
}: Props) {
  const active = state?.right || state?.current;
  const displayWord = typing ? state?.draft || "" : active?.word || "ноль";
  const resultClass = `result ${displayWord.length > 14 ? "long-result" : ""} ${!typing && !active ? "empty-result" : ""}`;
  const trail =
    state?.operation && state.current
      ? `${state.current.expression} ${state.operation} ${state.right?.word || "…"}`
      : active?.expression || "";

  return (
    <div className={`display ${error ? "has-error" : ""}`} aria-live="polite">
      <div className="expression" title={trail}>
        {trail}
      </div>
      {error && (
        <div className="result result-error" data-testid="result">
          ERROR
        </div>
      )}
      {typing ? (
        <form
          className="display-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <input
            ref={inputRef}
            className={`${resultClass} result-input`}
            aria-label="Введите слово или выражение"
            aria-describedby={error || warning ? "input-feedback" : undefined}
            aria-invalid={Boolean(error)}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={matches.length > 0}
            aria-controls="word-options"
            aria-activedescendant={
              highlighted >= 0 ? `word-option-${highlighted}` : undefined
            }
            maxLength={MAX_DRAFT_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
            value={displayWord}
            placeholder={state?.operation ? "слово" : "ноль"}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              const count = Math.min(matches.length, 9);
              if (event.key === "ArrowDown" && count) {
                event.preventDefault();
                onHighlight((index) => (index + 1) % count);
              }
              if (event.key === "ArrowUp" && count) {
                event.preventDefault();
                onHighlight((index) => (index - 1 + count) % count);
              }
              if (
                event.key === "Enter" &&
                highlighted >= 0 &&
                matches[highlighted]
              ) {
                event.preventDefault();
                onChoose(matches[highlighted], true);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
            }}
          />
        </form>
      ) : (
        !error && (
          <div className={resultClass} data-testid="result">
            {displayWord}
          </div>
        )
      )}
    </div>
  );
}
