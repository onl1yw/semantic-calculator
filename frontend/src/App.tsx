import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { CalculatorDisplay } from "./components/CalculatorDisplay.tsx";
import { CalculatorKeypad } from "./components/CalculatorKeypad.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";
import { MemoryBar } from "./components/MemoryBar.tsx";
import { Redefine } from "./components/Redefine.tsx";
import { useCalculator } from "./hooks/useCalculator.ts";
import { useWordSuggestions } from "./hooks/useWordSuggestions.ts";

export function App() {
  const calculator = useCalculator();
  const {
    model,
    state,
    busy,
    error,
    warning,
    typing,
    inputRef,
    personal,
    disabled,
    hasOperand,
  } = calculator;
  const [historyOpen, setHistoryOpen] = useState(false);
  const suggestions = useWordSuggestions(
    state?.draft || "",
    model,
    personal.definitions,
  );

  useEffect(() => {
    if (typing && !busy && !personal.isOpen && !historyOpen)
      inputRef.current?.focus();
  }, [typing, busy, personal.isOpen, historyOpen]);

  return (
    <div className="app-shell">
      <main className="workspace">
        <section className="calculator" aria-label="Калькулятор слов">
          <CalculatorDisplay
            state={state}
            typing={typing}
            disabled={disabled}
            error={error}
            warning={warning}
            inputRef={inputRef}
            matches={suggestions.matches}
            highlighted={suggestions.highlighted}
            onHighlight={suggestions.setHighlighted}
            onChange={calculator.changeDraft}
            onChoose={(word, complete) =>
              void calculator.choose(word, complete)
            }
            onSubmit={() => void calculator.complete(true)}
            onCancel={calculator.cancelTyping}
          />
          <MemoryBar
            state={state}
            disabled={disabled}
            hasOperand={hasOperand}
            typing={typing}
            error={error}
            historyOpen={historyOpen}
            onClear={calculator.clearMemory}
            onRecall={() => void calculator.recall()}
            onAdd={() => void calculator.remember()}
            onToggleHistory={() => setHistoryOpen(!historyOpen)}
          />
          <CalculatorKeypad
            disabled={disabled}
            hasOperand={hasOperand}
            typing={typing}
            operation={state?.operation}
            words={suggestions.words}
            highlighted={suggestions.highlighted}
            onClear={calculator.clear}
            onChangeSign={() => void calculator.changeSign()}
            onRedefine={() => void personal.open()}
            onOperator={(op) => void calculator.selectOperator(op)}
            onChoose={(word) => void calculator.choose(word)}
            onType={calculator.typeWord}
            onEquals={() => void calculator.complete()}
          />
          {(error || warning) && (
            <div
              id="input-feedback"
              className={`feedback ${error ? "has-error" : ""}`}
              role="status"
            >
              {error || warning}
            </div>
          )}
          {!model && error && (
            <button className="retry" onClick={() => void calculator.boot()}>
              Повторить подключение
            </button>
          )}
        </section>
        {historyOpen && (
          <HistoryPanel
            history={state?.history || []}
            definitions={personal.definitions}
            disabled={disabled}
            canUndo={personal.canUndo}
            onClose={() => setHistoryOpen(false)}
            onClearHistory={calculator.clearHistory}
            onSelectHistory={(entry) => {
              calculator.selectHistory(entry);
              setHistoryOpen(false);
            }}
            onEdit={personal.edit}
            onUseWord={(name) => {
              void calculator.choose(name);
              setHistoryOpen(false);
            }}
            onRemove={personal.remove}
            onUndo={personal.undo}
          />
        )}
      </main>
      {personal.isOpen && (
        <Redefine
          context={personal.context}
          editing={personal.editing}
          onClose={personal.close}
          onSave={personal.save}
        />
      )}
      {!historyOpen && !personal.isOpen && (
        <a
          className="project-link"
          href="https://github.com/onl1yw/semantic-calculator"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Открыть проект на GitHub"
        >
          GitHub <ArrowUpRight aria-hidden="true" size={13} strokeWidth={1.7} />
        </a>
      )}
    </div>
  );
}
