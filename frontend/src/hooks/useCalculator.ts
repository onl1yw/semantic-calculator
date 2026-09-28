import { useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { flushSync } from "react-dom";
import { health } from "../api.ts";
import {
  addMemory,
  draftCompletion,
  finish,
  insertOperand,
  lookupWord,
  negate,
  operate,
  parseInput,
  recallMemory,
} from "../calculator.ts";
import {
  createDictionary,
  emptyDefinitions,
  restoreDefinitions,
} from "../definitions.ts";
import type { Operator } from "../math.ts";
import {
  knownMemoryWord,
  memorySources,
  persist,
  restore,
} from "../storage.ts";
import type { CalculatorState, HistoryEntry, Model } from "../storage.ts";
import { usePersonalDefinitions } from "./usePersonalDefinitions.ts";

type Calculation = (
  snapshot: CalculatorState,
  model: Model,
) => Promise<CalculatorState> | CalculatorState;
export interface CalculatorSession {
  model: Model | null;
  stateRef: RefObject<CalculatorState | null>;
  commit: (next: CalculatorState) => void;
  run: (work: Calculation, keepInput?: boolean) => Promise<void>;
  setTyping: Dispatch<SetStateAction<boolean>>;
}

export function useCalculator() {
  const [model, setModel] = useState<Model | null>(null);
  const [state, setState] = useState<CalculatorState | null>(null);
  const stateRef = useRef<CalculatorState | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [typing, setTyping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const run = async (work: Calculation, keepInput = false) => {
    if (busyRef.current || !stateRef.current || !model) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await work(stateRef.current, model);
      commit(next);
      if (!next.draft)
        setTyping(keepInput && Boolean(next.operation && !next.right));
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

  const personal = usePersonalDefinitions({
    model,
    stateRef,
    commit,
    run,
    setTyping,
  });
  const { dictionary } = personal;

  const boot = async () => {
    setError("");
    try {
      const info = await health();
      let savedDefinitions;
      try {
        savedDefinitions = restoreDefinitions(info, window.localStorage);
      } catch {
        savedDefinitions = {
          definitions: emptyDefinitions(info),
          warning: "Личный словарь недоступен в этом браузере.",
        };
      }
      const restoredDictionary = createDictionary(savedDefinitions.definitions);
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
      if (restored.state.memory && !restored.state.memoryWord) {
        let word = knownMemoryWord(restored.state);
        if (!word) {
          try {
            word = (
              await restoredDictionary.nearest(
                restored.state.memory,
                "Память",
                info,
                memorySources(restored.state),
              )
            ).word;
          } catch {
            /* A missing label does not prevent using the calculator. */
          }
        }
        if (word) {
          restored.state = { ...restored.state, memoryWord: word };
          try {
            persist(restored.state, window.localStorage);
          } catch {
            /* Use this tab's state. */
          }
        }
      }
      stateRef.current = restored.state;
      setState(restored.state);
      setTyping(Boolean(restored.state.draft));
      setModel(info);
      personal.initialize(savedDefinitions.definitions);
      setWarning(
        [restored.warning, savedDefinitions.warning].filter(Boolean).join(" "),
      );
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

  const choose = (word: string, complete = false) =>
    run(async (snapshot, info) => {
      const completed = draftCompletion(snapshot.draft).replaceWith(word);
      if (snapshot.draft.trim() && parseInput(completed).length > 1)
        return finish({ ...snapshot, draft: completed }, info, dictionary);
      const next = insertOperand(
        snapshot,
        await lookupWord(word, info, dictionary),
      );
      return complete ? finish(next, info, dictionary) : next;
    }, true);

  const selectOperator = (op: Operator) =>
    run((snapshot, info) => operate(snapshot, op, info, dictionary), typing);
  const complete = (keepInput = typing) =>
    run((snapshot, info) => finish(snapshot, info, dictionary), keepInput);
  const changeSign = () =>
    run((snapshot, info) => negate(snapshot, info, dictionary));
  const remember = () =>
    run((snapshot, info) => addMemory(snapshot, info, dictionary));
  const recall = () =>
    run((snapshot, info) => recallMemory(snapshot, info, dictionary));

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
    setTyping(false);
  };

  const changeDraft = (draft: string) => {
    if (stateRef.current) commit({ ...stateRef.current, draft });
    setError("");
  };

  const cancelTyping = () => {
    changeDraft("");
    setTyping(false);
  };

  const typeWord = () => {
    if (busyRef.current || !stateRef.current) return;
    // Mount and focus during the click so mobile browsers open the keyboard.
    flushSync(() => setTyping(true));
    inputRef.current?.focus();
    setError("");
  };

  const clearMemory = () => {
    if (stateRef.current)
      commit({
        ...stateRef.current,
        memory: null,
        memoryWord: undefined,
        memorySourceWords: [],
      });
  };

  const clearHistory = () => {
    if (stateRef.current) commit({ ...stateRef.current, history: [] });
  };

  const selectHistory = (entry: HistoryEntry) => {
    if (stateRef.current) commit(insertOperand(stateRef.current, entry));
    setTyping(false);
  };

  return {
    model,
    state,
    busy,
    error,
    warning,
    typing,
    inputRef,
    personal,
    disabled: !state || busy,
    hasOperand: Boolean(state?.right || state?.current || state?.draft.trim()),
    boot,
    choose,
    selectOperator,
    complete,
    changeSign,
    remember,
    recall,
    clear,
    changeDraft,
    cancelTyping,
    typeWord,
    clearMemory,
    clearHistory,
    selectHistory,
  };
}
