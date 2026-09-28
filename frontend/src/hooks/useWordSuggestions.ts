import { useEffect, useState } from "react";
import { suggest } from "../api.ts";
import { draftCompletion } from "../calculator.ts";
import { matchingWords } from "../definitions.ts";
import type { Definitions } from "../definitions.ts";
import type { Model } from "../storage.ts";

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

export function useWordSuggestions(
  draft: string,
  model: Model | null,
  definitions: Definitions,
) {
  const [matches, setMatches] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState(-1);
  const prefix = draftCompletion(draft).prefix;

  useEffect(() => {
    setMatches(prefix.length >= 2 ? matchingWords(definitions, prefix) : []);
    setHighlighted(-1);
    if (prefix.length < 2 || !model) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void suggest(prefix, controller.signal)
        .then((response) =>
          setMatches(matchingWords(definitions, prefix, response.words)),
        )
        .catch(() => {});
    }, 220);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [draft, model, definitions]);

  return {
    matches,
    highlighted,
    setHighlighted,
    words: prefix.length >= 2 ? matches.slice(0, 9) : EXAMPLES,
  };
}
