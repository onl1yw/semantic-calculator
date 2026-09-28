import { useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { expressionKey } from "../definitions.ts";
import type {
  DefinitionEdit,
  DefinitionMode,
  Definitions,
} from "../definitions.ts";

interface Props {
  definitions: Definitions;
  disabled: boolean;
  canUndo: boolean;
  onEdit: (entry: DefinitionEdit) => void;
  onUse: (name: string) => void;
  onRemove: (mode: DefinitionMode, key: string) => void;
  onUndo: () => void;
}

export function PersonalDictionary({
  definitions,
  disabled,
  canUndo,
  onEdit,
  onUse,
  onRemove,
  onUndo,
}: Props) {
  const [error, setError] = useState("");
  const attempt = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить изменения.",
      );
    }
  };
  return (
    <>
      {canUndo && (
        <button
          type="button"
          className="undo-definition"
          disabled={disabled}
          onClick={() => attempt(onUndo)}
        >
          Отменить удаление
        </button>
      )}
      {error && (
        <p className="definition-error" role="alert">
          {error}
        </p>
      )}
      {definitions.words.length || definitions.rules.length ? (
        <ul className="personal-list">
          {definitions.words.map((word) => (
            <li key={word.name}>
              <button
                type="button"
                className="personal-entry"
                disabled={disabled}
                aria-label={`Изменить слово ${word.name}`}
                onClick={() => onEdit({ mode: "word", word })}
              >
                <strong>{word.name}</strong>
                <span>{word.definition}</span>
              </button>
              <button
                type="button"
                className="personal-use"
                disabled={disabled}
                aria-label={`Использовать слово ${word.name}`}
                onClick={() => onUse(word.name)}
              >
                <ArrowUpRight aria-hidden="true" size={20} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="remove-definition"
                disabled={disabled}
                aria-label={`Удалить слово ${word.name}`}
                onClick={() => attempt(() => onRemove("word", word.name))}
              >
                <X aria-hidden="true" size={18} strokeWidth={1.7} />
              </button>
            </li>
          ))}
          {definitions.rules.map((rule) => (
            <li key={expressionKey(rule.expression)}>
              <button
                type="button"
                className="personal-entry"
                disabled={disabled}
                aria-label={`Изменить правило ${rule.expression}`}
                onClick={() => onEdit({ mode: "rule", rule })}
              >
                <strong>
                  {rule.expression} → {rule.targetWord}
                </strong>
                <span>Свой ответ</span>
              </button>
              <button
                type="button"
                className="remove-definition"
                disabled={disabled}
                aria-label={`Удалить правило ${rule.expression}`}
                onClick={() => attempt(() => onRemove("rule", rule.expression))}
              >
                <X aria-hidden="true" size={18} strokeWidth={1.7} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="history-empty">
          <p>Пока пусто.</p>
          <span>
            Посчитайте выражение и нажмите RE,
            <br />
            чтобы добавить слово или свой ответ.
          </span>
        </div>
      )}
    </>
  );
}
