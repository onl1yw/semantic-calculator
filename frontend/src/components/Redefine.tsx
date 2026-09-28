import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { expressionKey } from "../definitions.ts";
import type { DefinitionEdit, DefinitionMode } from "../definitions.ts";
import type { Operand } from "../storage.ts";
interface Props {
  context: Operand | null;
  editing: DefinitionEdit | null;
  onClose: () => void;
  onSave: (
    mode: DefinitionMode,
    name: string,
    expression: string,
  ) => Promise<void>;
}

export function Redefine({ context, editing, onClose, onSave }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<DefinitionMode>(editing?.mode || "word");
  const [name, setName] = useState(
    editing?.mode === "word"
      ? editing.word.name
      : editing?.mode === "rule"
        ? editing.rule.targetWord
        : "",
  );
  const [savedExpression, setSavedExpression] = useState(
    editing?.mode === "rule"
      ? editing.rule.expression
      : context?.expression || "",
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const expression =
    editing || mode === "rule" ? savedExpression : context?.expression || "";
  const canRule = /[+−×÷]/u.test(expressionKey(savedExpression));

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    if (!saving && (context || mode === "rule")) field.current?.focus();
  }, [context, mode, saving]);

  const modes = (
    <div
      className="definition-tabs"
      role="tablist"
      aria-label="Тип определения"
    >
      <button
        type="button"
        className={`key ${mode === "word" ? "utility" : ""}`}
        role="tab"
        aria-selected={mode === "word"}
        aria-controls="definition-form"
        disabled={saving || !context || editing?.mode === "rule"}
        onClick={() => {
          if (!editing) {
            setMode("word");
            setName("");
            setError("");
          }
        }}
      >
        Назвать результат
      </button>
      <button
        type="button"
        className={`key ${mode === "rule" ? "utility" : ""}`}
        role="tab"
        aria-selected={mode === "rule"}
        aria-controls="definition-form"
        disabled={saving || !canRule || editing?.mode === "word"}
        onClick={() => {
          if (!editing) {
            setMode("rule");
            setName("");
            setError("");
          }
        }}
      >
        Задать ответ
      </button>
    </div>
  );

  return (
    <dialog
      ref={dialog}
      className="redefine-dialog"
      aria-labelledby="redefine-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <div className="redefine-heading">
        <h2 id="redefine-title">REDEFINE</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Закрыть REDEFINE"
          disabled={saving}
          onClick={onClose}
        >
          <X size={22} strokeWidth={1.7} />
        </button>
      </div>
      {context || mode === "rule" ? (
        <form
          id="definition-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving) return;
            setSaving(true);
            setError("");
            try {
              await onSave(mode, name, expression);
              onClose();
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Не удалось сохранить определение.",
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="display definition-display">
            {editing ? (
              <input
                className="expression result-input definition-expression-input"
                value={savedExpression}
                aria-label={
                  mode === "word" ? "Определение слова" : "Выражение правила"
                }
                maxLength={2048}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={saving}
                required
                onChange={(event) => {
                  setSavedExpression(event.target.value);
                  setError("");
                }}
              />
            ) : (
              <p
                className="expression definition-expression"
                title={expression}
              >
                {expression}
              </p>
            )}
            <input
              ref={field}
              id="definition-name"
              className={`result result-input ${name.length > 14 ? "long-result" : ""}`}
              value={name}
              maxLength={64}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={saving}
              required
              aria-label={
                mode === "word" ? "Имя слова" : "Какой ответ показывать"
              }
              aria-invalid={Boolean(error)}
              placeholder={mode === "word" ? "слово" : "ответ"}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
          </div>
          <p className="definition-help">
            {mode === "word"
              ? "Переопределяет слову новый вектор"
              : "Запоминает ответ только для конкретного выражения"}
          </p>
          {modes}
          <button
            className="key operator definition-save"
            disabled={saving || !name.trim()}
          >
            {saving ? "Сохраняю…" : "Сохранить"}
          </button>
        </form>
      ) : (
        <>
          <p className="definition-help">
            Посчитайте выражение, затем нажмите RE, чтобы сохранить своё
            определение.
          </p>
          {modes}
        </>
      )}
      {error && (
        <p className="definition-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
