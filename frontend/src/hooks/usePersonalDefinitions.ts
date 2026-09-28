import { useMemo, useState } from "react";
import {
  finish,
  insertOperand,
  lookupWord,
  parseInput,
  UnknownWordError,
} from "../calculator.ts";
import {
  createDictionary,
  defineRule,
  defineWord,
  expressionKey,
  persistDefinitions,
  removeRule,
  removeWord,
  replaceRule,
  replaceWord,
  validateName,
} from "../definitions.ts";
import type {
  DefinitionEdit,
  DefinitionMode,
  Definitions,
} from "../definitions.ts";
import { operandSources } from "../storage.ts";
import type { Operand } from "../storage.ts";
import type { CalculatorSession } from "./useCalculator.ts";

export function usePersonalDefinitions({
  model,
  stateRef,
  commit,
  run,
  setTyping,
}: CalculatorSession) {
  const [definitions, setDefinitions] = useState<Definitions>({
    schemaVersion: 1,
    modelId: "",
    modelRevision: "",
    words: [],
    rules: [],
  });
  const dictionary = useMemo(
    () => createDictionary(definitions),
    [definitions],
  );
  const [isOpen, setOpen] = useState(false);
  const [context, setContext] = useState<Operand | null>(null);
  const [editing, setEditing] = useState<DefinitionEdit | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<Definitions | null>(null);

  const open = () =>
    run(async (snapshot, info) => {
      const next =
        snapshot.draft.trim() || (snapshot.operation && snapshot.right)
          ? await finish(snapshot, info, dictionary)
          : snapshot;
      setEditing(null);
      setContext(next.operation ? null : next.current);
      setOpen(true);
      return next;
    });

  const edit = (entry: DefinitionEdit) => {
    setEditing(entry);
    setContext(
      entry.mode === "word"
        ? {
            word: entry.word.name,
            expression: entry.word.definition,
            vector: [...entry.word.vector],
            sourceWords: [entry.word.name],
          }
        : null,
    );
    setOpen(true);
  };

  const commitDefinitions = (next: Definitions) => {
    if (!model) throw new Error("Словарь ещё загружается.");
    try {
      if (!persistDefinitions(next, model, window.localStorage))
        throw new Error("Storage unavailable");
    } catch {
      throw new Error(
        "Не удалось сохранить личный словарь в браузере. Освободите место и попробуйте ещё раз.",
      );
    }
    setDefinitions(next);
  };

  const save = async (
    mode: DefinitionMode,
    value: string,
    expression: string,
  ) => {
    if (!model || !stateRef.current) return;
    const name = validateName(value);
    if (mode === "word") {
      if (!context) throw new Error("Сначала получите результат.");
      let operand = context;
      if (editing?.mode === "word" && expression !== context.expression) {
        const result = await finish(
          {
            ...stateRef.current,
            current: null,
            right: null,
            operation: null,
            draft: expression,
            history: [],
          },
          model,
          dictionary,
        );
        if (!result.current || result.operation)
          throw new Error("Введите законченное выражение.");
        operand = result.current;
      }
      commitDefinitions(
        editing?.mode === "word"
          ? replaceWord(definitions, editing.word.name, name, operand)
          : defineWord(definitions, name, operand),
      );
      if (!editing)
        commit(
          insertOperand(stateRef.current, {
            word: name,
            expression: name,
            vector: [...operand.vector],
            sourceWords: [name],
          }),
        );
    } else {
      if (
        editing?.mode === "rule" &&
        expressionKey(expression) !== expressionKey(editing.rule.expression)
      ) {
        const tokens = parseInput(expression);
        if (tokens.at(-1)?.kind !== "word")
          throw new Error("Введите законченное выражение.");
        for (const token of tokens)
          if (token.kind === "word")
            await lookupWord(token.value, model, dictionary);
        if (tokens[0]?.kind === "operator" && tokens[0].value !== "−")
          throw new Error(
            "Выражение должно начинаться со слова или со знака −.",
          );
      }
      const target = await lookupWord(name, model, dictionary).catch(
        (cause) => {
          if (cause instanceof UnknownWordError)
            throw new Error(
              `«${name}» нет в словаре. Введите известное слово или сначала создайте его через «Назвать результат».`,
            );
          throw cause;
        },
      );
      commitDefinitions(
        editing?.mode === "rule"
          ? replaceRule(definitions, editing.rule.expression, expression, name)
          : defineRule(definitions, expression, name),
      );
      if (
        !editing &&
        context &&
        expressionKey(context.expression) === expressionKey(expression)
      ) {
        commit(
          insertOperand(stateRef.current, {
            word: target.word,
            expression,
            vector: [...target.vector],
            sourceWords: operandSources(context),
          }),
        );
      }
    }
    setUndoSnapshot(null);
    if (!editing) setTyping(false);
  };

  const remove = (mode: DefinitionMode, key: string) => {
    commitDefinitions(
      mode === "word"
        ? removeWord(definitions, key)
        : removeRule(definitions, key),
    );
    setUndoSnapshot(definitions);
  };

  const undo = () => {
    if (!undoSnapshot) return;
    commitDefinitions(undoSnapshot);
    setUndoSnapshot(null);
  };

  return {
    definitions,
    dictionary,
    initialize: setDefinitions,
    isOpen,
    context,
    editing,
    open,
    close: () => setOpen(false),
    edit,
    save,
    remove,
    undo,
    canUndo: Boolean(undoSnapshot),
  };
}
