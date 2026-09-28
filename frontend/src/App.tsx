import { useEffect, useRef, useState } from "react";
import { calculate, validVector } from "./math.ts";
import type { Operator } from "./math.ts";
import { health, nearest, suggest, wordVector } from "./api.ts";
import { persist, restore } from "./storage.ts";
import type {
  CalculatorState,
  HistoryEntry,
  Model,
  Operand,
} from "./storage.ts";

const EXAMPLES = [
  "король",
  "мужчина",
  "женщина",
  "кошка",
  "собака",
  "человек",
  "день",
  "ночь",
  "солнце",
];
const OPS: Operator[] = ["÷", "×", "−", "+"];

function insertOperand(
  state: CalculatorState,
  operand: Operand,
): CalculatorState {
  return state.current && state.operation
    ? { ...state, right: operand, draft: "" }
    : { ...state, current: operand, right: null, operation: null, draft: "" };
}

function historyEntry(operand: Operand): HistoryEntry {
  return { ...operand, id: crypto.randomUUID(), timestamp: Date.now() };
}

async function withDraft(
  state: CalculatorState,
  model: Model,
): Promise<CalculatorState> {
  return state.draft.trim()
    ? insertOperand(state, await wordVector(state.draft.trim(), model))
    : state;
}

async function finish(
  state: CalculatorState,
  model: Model,
): Promise<CalculatorState> {
  const next = await withDraft(state, model);
  if (!next.current) throw new Error("Сначала введите слово.");
  if (!next.operation) return next;
  if (!next.right)
    throw new Error("Введите второе слово или выберите его из подсказок.");
  const vector = calculate(
    next.current.vector,
    next.operation,
    next.right.vector,
  );
  let expression = `${next.current.expression} ${next.operation} ${next.right.expression}`;
  if (expression.length > 2048)
    expression = `… ${next.current.word} ${next.operation} ${next.right.word}`;
  const operand = await nearest(vector, expression, model);
  return {
    ...next,
    current: operand,
    right: null,
    operation: null,
    history: [historyEntry(operand), ...next.history].slice(0, 50),
  };
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 11a8 8 0 1 1 2 6M4 5v6h6M12 8v5l3 2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function App() {
  const [model, setModel] = useState<Model | null>(null);
  const [state, setState] = useState<CalculatorState | null>(null);
  const stateRef = useRef<CalculatorState | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [matches, setMatches] = useState<string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  const boot = async () => {
    setError("");
    try {
      const info = await health();
      let restored;
      try {
        restored = restore(info, window.localStorage);
      } catch {
        restored = {
          state: restore(info, { getItem: () => null, setItem: () => {} })
            .state,
          warning: "Сохранение недоступно. Можно продолжить в этой вкладке.",
        };
      }
      stateRef.current = restored.state;
      setState(restored.state);
      setModel(info);
      setWarning(restored.warning || "");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось подключиться к словарю.",
      );
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  const commit = (next: CalculatorState) => {
    stateRef.current = next;
    setState(next);
    try {
      if (!persist(next, window.localStorage))
        setWarning(
          "Сохранение недоступно. Результаты останутся в этой вкладке.",
        );
    } catch {
      setWarning("Сохранение недоступно. Результаты останутся в этой вкладке.");
    }
  };

  useEffect(() => {
    const prefix = state?.draft.trim() || "";
    setMatches([]);
    setSuggestionIndex(-1);
    if (prefix.length < 2 || !model) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void suggest(prefix, controller.signal)
        .then((response) => setMatches(response.words))
        .catch(() => {});
    }, 220);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [state?.draft, model]);

  const run = async (
    work: (
      snapshot: CalculatorState,
      model: Model,
    ) => Promise<CalculatorState> | CalculatorState,
  ) => {
    if (busyRef.current || !stateRef.current || !model) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      commit(await work(stateRef.current, model));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось выполнить действие.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const choose = (word: string) =>
    run(async (snapshot, info) =>
      insertOperand(snapshot, await wordVector(word, info)),
    );

  const operate = (op: Operator) =>
    run(async (snapshot, info) => {
      let next = await withDraft(snapshot, info);
      if (next.operation && next.right) next = await finish(next, info);
      if (!next.current) throw new Error("Сначала введите слово.");
      return { ...next, operation: op, right: null, draft: "" };
    });

  const addMemory = () =>
    run((snapshot) => {
      const active = snapshot.right || snapshot.current;
      if (!active)
        throw new Error("Сначала введите слово или получите результат.");
      const vector = snapshot.memory
        ? snapshot.memory.map((n, i) => n + active.vector[i])
        : [...active.vector];
      if (!validVector(vector))
        throw new Error("Вектор памяти слишком большой.");
      return { ...snapshot, memory: vector };
    });

  const recall = () =>
    run(async (snapshot, info) => {
      if (!snapshot.memory)
        throw new Error("Память пока пуста. Сохраните результат кнопкой M+.");
      return insertOperand(
        snapshot,
        await nearest(snapshot.memory, "Память", info),
      );
    });

  const negate = () =>
    run(async (snapshot, info) => {
      const active = snapshot.right || snapshot.current;
      if (!active) throw new Error("Сначала введите слово.");
      const vector = active.vector.map((n) => -n);
      const expression =
        active.expression.length < 2044
          ? `−(${active.expression})`
          : `−(${active.word})`;
      const operand = await nearest(vector, expression, info);
      return snapshot.right
        ? { ...snapshot, right: operand }
        : { ...snapshot, current: operand };
    });

  const clear = () => {
    if (busyRef.current || !stateRef.current) return;
    commit({
      ...stateRef.current,
      current: null,
      right: null,
      operation: null,
      draft: "",
    });
    setError("");
    input.current?.focus();
  };

  const active = state?.right || state?.current;
  const disabled = !state || busy;
  const keys =
    state?.draft.trim().length && state.draft.trim().length >= 2
      ? matches.slice(0, 9)
      : EXAMPLES;
  const trail =
    state?.operation && state.current
      ? `${state.current.word} ${state.operation} ${state.right?.word || "…"}`
      : active?.expression || "Слова. Смыслы. Арифметика.";

  return (
    <div className="app-shell">
      <header className="masthead">
        <a
          className="brand"
          href="/"
          aria-label="Семантический калькулятор — главная"
        >
          <span className="brand-mark">=</span>
          <span>
            semantic<span className="brand-soft"> / calculator</span>
          </span>
        </a>
        <span className="edition">
          РУССКИЙ ЯЗЫК <span className="edition-dot" /> ВЕРСИЯ 01
        </span>
      </header>

      <main className="workspace">
        <section className="intro">
          <div className="eyebrow">
            <span /> АРИФМЕТИКА СМЫСЛОВ
          </div>
          <h1>
            А если <br />
            складывать <br />
            <em>слова?</em>
          </h1>
          <p className="intro-copy">
            Знакомый калькулятор.
            <br />
            Совсем другой результат.
          </p>
          <div
            className="example-formula"
            aria-label="Пример: король минус мужчина плюс женщина"
          >
            <span>король</span>
            <b>−</b>
            <span>мужчина</span>
            <b>+</b>
            <span>женщина</span>
            <b>=</b>
            <span className="formula-unknown">?</span>
          </div>
          <p className="instruction">
            Введите слово, выберите действие,
            <br />
            добавьте второе слово — и нажмите <span>=</span>.
          </p>
          <div className="intro-bottom">
            <span className="privacy-icon">⌁</span>
            <p>
              Ваши вычисления и память
              <br />
              сохраняются в этом браузере.
            </p>
          </div>
        </section>

        <section className="calculator" aria-label="Калькулятор слов">
          <div className="calc-topline">
            <span className="status">
              <i className={model ? "online" : ""} />
              {model ? "СЛОВАРЬ ГОТОВ" : "ПОДКЛЮЧЕНИЕ"}
            </span>
            <button
              className={`history-toggle ${historyOpen ? "is-active" : ""}`}
              aria-label="История вычислений"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              <HistoryIcon />
            </button>
          </div>

          <div className="display" aria-live="polite">
            <div className="expression" title={trail}>
              {trail}
            </div>
            <div
              className={`result ${!active ? "placeholder" : ""} ${active && active.word.length > 14 ? "long-result" : ""}`}
              data-testid="result"
            >
              {active?.word || "слово"}
            </div>
            <div className="display-bottom">
              <span className="memory-indicator">
                {state?.memory ? "M · в памяти" : "память пуста"}
              </span>
              <span>
                {busy
                  ? "Ищем слово…"
                  : active?.similarity !== undefined
                    ? `${Math.round(active.similarity * 100)}% близости`
                    : " "}
              </span>
            </div>
          </div>

          <div className="memory-row">
            <button
              disabled={disabled || !state?.memory}
              onClick={() => state && commit({ ...state, memory: null })}
              aria-label="MC — очистить память"
            >
              MC
            </button>
            <button
              disabled={disabled || !state?.memory}
              onClick={() => void recall()}
              aria-label="MR — вызвать память"
            >
              MR
            </button>
            <button
              disabled={disabled || !active}
              onClick={() => void addMemory()}
              aria-label="M+ — добавить в память"
            >
              M+
            </button>
            <span className="memory-help">помнит смысл</span>
          </div>

          <form
            className="word-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(finish);
            }}
          >
            <span className="input-symbol">Aa</span>
            <input
              ref={input}
              aria-label="Введите слово"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={matches.length > 0}
              aria-controls="word-options"
              aria-activedescendant={
                suggestionIndex >= 0
                  ? `word-option-${suggestionIndex}`
                  : undefined
              }
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              value={state?.draft || ""}
              placeholder={
                state?.operation ? "Второе слово…" : "Введите слово…"
              }
              onChange={(event) => {
                if (state) commit({ ...state, draft: event.target.value });
                setError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && matches.length) {
                  event.preventDefault();
                  setSuggestionIndex(
                    (n) => (n + 1) % Math.min(matches.length, 9),
                  );
                }
                if (event.key === "ArrowUp" && matches.length) {
                  event.preventDefault();
                  setSuggestionIndex(
                    (n) =>
                      (n - 1 + Math.min(matches.length, 9)) %
                      Math.min(matches.length, 9),
                  );
                }
                if (
                  event.key === "Enter" &&
                  suggestionIndex >= 0 &&
                  matches[suggestionIndex]
                ) {
                  event.preventDefault();
                  void choose(matches[suggestionIndex]);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  clear();
                }
              }}
            />
            <button
              className="enter-word"
              type="button"
              aria-label="Добавить введённое слово"
              disabled={disabled || !state?.draft.trim()}
              onClick={() => state && void choose(state.draft.trim())}
            >
              ↵
            </button>
          </form>

          <div
            className="keypad"
            id="word-options"
            role="group"
            aria-label="Слова и операции"
          >
            <button className="key utility" disabled={disabled} onClick={clear}>
              AC
            </button>
            <button
              className="key utility"
              disabled={disabled || !active}
              onClick={() => void negate()}
              aria-label="Изменить знак вектора"
            >
              +/−
            </button>
            <button
              className="key utility"
              disabled={disabled}
              aria-label="Удалить последнюю букву"
              onClick={() => {
                if (state)
                  commit({ ...state, draft: state.draft.slice(0, -1) });
                input.current?.focus();
              }}
            >
              ⌫
            </button>
            <button
              className={`key operator ${state?.operation === "÷" ? "selected" : ""}`}
              disabled={disabled}
              aria-label="Деление"
              aria-pressed={state?.operation === "÷"}
              onClick={() => void operate("÷")}
            >
              ÷
            </button>
            {[0, 1, 2].map((row) => (
              <div className="key-row" key={row}>
                {[0, 1, 2].map((col) => {
                  const i = row * 3 + col;
                  const word = keys[i];
                  return (
                    <button
                      id={`word-option-${i}`}
                      className={`key word-key ${suggestionIndex === i ? "highlighted" : ""}`}
                      key={col}
                      disabled={disabled || !word}
                      onClick={() => word && void choose(word)}
                      title={word}
                    >
                      {word || "·"}
                    </button>
                  );
                })}
                <button
                  className={`key operator ${state?.operation === OPS[row + 1] ? "selected" : ""}`}
                  disabled={disabled}
                  aria-label={
                    {
                      "×": "Умножение",
                      "−": "Вычитание",
                      "+": "Сложение",
                      "÷": "Деление",
                    }[OPS[row + 1]]
                  }
                  aria-pressed={state?.operation === OPS[row + 1]}
                  onClick={() => void operate(OPS[row + 1])}
                >
                  {OPS[row + 1]}
                </button>
              </div>
            ))}
            <button
              className="key type-key"
              disabled={disabled}
              onClick={() => input.current?.focus()}
            >
              <span>Aa</span> своё слово
            </button>
            <button
              className="key operator equals"
              disabled={disabled}
              aria-label="Равно"
              onClick={() => void run(finish)}
            >
              =
            </button>
          </div>

          <div className={`feedback ${error ? "has-error" : ""}`} role="status">
            {error ||
              warning ||
              (state?.draft.trim().length && state.draft.trim().length >= 2
                ? matches.length
                  ? "Выберите слово или нажмите ↵"
                  : "Введите слово и нажмите ↵"
                : "Считаем по одному действию")}
          </div>
          {!model && error && (
            <button className="retry" onClick={() => void boot()}>
              Повторить подключение
            </button>
          )}
        </section>

        {historyOpen && (
          <aside className="history-panel" aria-label="История">
            <div className="history-heading">
              <div>
                <span className="eyebrow">В ЭТОМ БРАУЗЕРЕ</span>
                <h2>История</h2>
              </div>
              <button
                aria-label="Закрыть историю"
                onClick={() => setHistoryOpen(false)}
              >
                ×
              </button>
            </div>
            {state?.history.length ? (
              <>
                <button
                  className="clear-history"
                  disabled={busy}
                  onClick={() => commit({ ...state, history: [] })}
                >
                  Очистить историю
                </button>
                <ol>
                  {state.history.map((entry) => (
                    <li key={entry.id}>
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (state) commit(insertOperand(state, entry));
                          setHistoryOpen(false);
                        }}
                      >
                        <span className="history-expression">
                          {entry.expression}
                        </span>
                        <span className="history-result">
                          {entry.word}
                          <span>↗</span>
                        </span>
                        <time>
                          {new Date(entry.timestamp).toLocaleTimeString("ru", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <div className="history-empty">
                <HistoryIcon />
                <p>Пока чистый лист.</p>
                <span>
                  Здесь появятся ваши вычисления.
                  <br />
                  Любой результат можно продолжить.
                </span>
              </div>
            )}
          </aside>
        )}
      </main>

      <footer className="footer">
        <span>СЛОВА — ЭТО ТОЛЬКО НАЧАЛО.</span>
        <span>
          Модель{" "}
          <a
            href="https://rusvectores.org/ru/models/"
            target="_blank"
            rel="noreferrer"
          >
            RusVectōrēs
          </a>{" "}
          · GeoWAC · CC BY
        </span>
      </footer>
    </div>
  );
}
