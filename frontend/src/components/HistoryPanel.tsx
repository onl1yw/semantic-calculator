import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowUpRight, X } from "lucide-react";
import type {
  DefinitionEdit,
  DefinitionMode,
  Definitions,
} from "../definitions.ts";
import type { HistoryEntry } from "../storage.ts";
import { PersonalDictionary } from "./PersonalDictionary.tsx";

interface Props {
  history: HistoryEntry[];
  definitions: Definitions;
  disabled: boolean;
  canUndo: boolean;
  onClose: () => void;
  onClearHistory: () => void;
  onSelectHistory: (entry: HistoryEntry) => void;
  onEdit: (entry: DefinitionEdit) => void;
  onUseWord: (name: string) => void;
  onRemove: (mode: DefinitionMode, key: string) => void;
  onUndo: () => void;
}

export function HistoryPanel({
  history,
  definitions,
  disabled,
  canUndo,
  onClose,
  onClearHistory,
  onSelectHistory,
  onEdit,
  onUseWord,
  onRemove,
  onUndo,
}: Props) {
  const [section, setSection] = useState<"history" | "dictionary">("history");
  const historyTab = useRef<HTMLButtonElement>(null);
  const dictionaryTab = useRef<HTMLButtonElement>(null);
  const switchTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "history"
        : event.key === "End"
          ? "dictionary"
          : section === "history"
            ? "dictionary"
            : "history";
    setSection(next);
    (next === "history" ? historyTab : dictionaryTab).current?.focus();
  };

  return (
    <aside className="history-panel" aria-label="История и мой словарь">
      <div className="history-heading">
        <div
          className="history-tabs"
          role="tablist"
          aria-label="История и словарь"
        >
          <button
            ref={historyTab}
            id="history-tab"
            role="tab"
            aria-controls="history-content"
            aria-selected={section === "history"}
            tabIndex={section === "history" ? 0 : -1}
            onKeyDown={switchTab}
            onClick={() => setSection("history")}
          >
            История
          </button>
          <button
            ref={dictionaryTab}
            id="dictionary-tab"
            role="tab"
            aria-controls="dictionary-content"
            aria-selected={section === "dictionary"}
            tabIndex={section === "dictionary" ? 0 : -1}
            onKeyDown={switchTab}
            onClick={() => setSection("dictionary")}
          >
            Мой словарь
          </button>
        </div>
        <button aria-label="Закрыть историю и словарь" onClick={onClose}>
          <X aria-hidden="true" size={24} strokeWidth={1.7} />
        </button>
      </div>
      {section === "dictionary" ? (
        <div
          id="dictionary-content"
          role="tabpanel"
          aria-labelledby="dictionary-tab"
        >
          <PersonalDictionary
            definitions={definitions}
            disabled={disabled}
            onEdit={onEdit}
            onUse={onUseWord}
            onRemove={onRemove}
            canUndo={canUndo}
            onUndo={onUndo}
          />
        </div>
      ) : (
        <div id="history-content" role="tabpanel" aria-labelledby="history-tab">
          {history.length ? (
            <>
              <button
                className="clear-history"
                disabled={disabled}
                onClick={onClearHistory}
              >
                Очистить историю
              </button>
              <ol>
                {history.map((entry) => (
                  <li key={entry.id}>
                    <button
                      disabled={disabled}
                      onClick={() => onSelectHistory(entry)}
                    >
                      <span className="history-expression">
                        {entry.expression}
                      </span>
                      <span className="history-result">
                        {entry.word}
                        <ArrowUpRight
                          aria-hidden="true"
                          size={20}
                          strokeWidth={1.7}
                        />
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
              <p>История пуста.</p>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
