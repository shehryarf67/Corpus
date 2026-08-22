export type CitationTextFragment = {
  text: string;
  sourceIndex: number;
  lineBreakBefore: boolean;
};

export type NormalizedTextWithMap = {
  text: string;
  // Each normalized character points back to the React-PDF span it came from.
  sourceIndexes: number[];
};

export type CitationMatch = {
  start: number;
  end: number;
  passage: string;
};

export type RenderedCitationSpan = {
  text: string;
  top: number;
};

/** Convert rendered span positions into the line-aware fragments we match. */
export function citationFragmentsFromRenderedSpans(
  spans: RenderedCitationSpan[],
): CitationTextFragment[] {
  let previousTop: number | null = null;

  return spans.map((span, sourceIndex) => {
    const fragment = {
      text: span.text,
      sourceIndex,
      lineBreakBefore:
        previousTop !== null && Math.abs(span.top - previousTop) > 2,
    };
    previousTop = span.top;
    return fragment;
  });
}

/** Return the React-PDF span indexes supporting one citation passage. */
export function matchCitationSpanIndexes(
  chunkContent: string,
  fragments: CitationTextFragment[],
): number[] | null {
  const normalizedPage = normalizePageFragments(fragments);
  const match = matchCitationPassage(chunkContent, normalizedPage.text);
  if (!match) return null;

  return [
    ...new Set(normalizedPage.sourceIndexes.slice(match.start, match.end)),
  ];
}

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
};

function normalizeCharacter(character: string): string {
  const compatibilityForm = character.normalize("NFKC");
  let result = "";

  for (const normalizedCharacter of compatibilityForm) {
    const expanded = LIGATURES[normalizedCharacter] ?? normalizedCharacter;

    for (const expandedCharacter of expanded.toLocaleLowerCase()) {
      // Matching words instead of punctuation makes smart quotes, dash styles,
      // repeated whitespace, and small punctuation differences equivalent.
      result += /[\p{L}\p{N}]/u.test(expandedCharacter)
        ? expandedCharacter
        : " ";
    }
  }

  return result;
}

function normalizeFragment(text: string): string {
  let result = "";

  for (const character of text) {
    result += normalizeCharacter(character);
  }

  return result.replace(/\s+/g, " ").trim();
}

/** Normalize backend chunk text without keeping browser span positions. */
export function normalizeCitationText(text: string): string {
  // Remove only hyphens directly followed by a line break. Ordinary hyphenated
  // words are normalized as two words on both the chunk and page sides.
  const withoutWrappedHyphens = text.normalize("NFKC").replace(
    /([\p{L}\p{N}])-\s*\r?\n\s*(?=[\p{Ll}])/gu,
    "$1",
  );

  return normalizeFragment(withoutWrappedHyphens);
}

/** Normalize rendered PDF spans while mapping output back to span indexes. */
export function normalizePageFragments(
  fragments: CitationTextFragment[],
): NormalizedTextWithMap {
  let text = "";
  const sourceIndexes: number[] = [];
  let previousRawText = "";

  for (const fragment of fragments) {
    const normalizedFragment = normalizeFragment(fragment.text);
    if (!normalizedFragment) continue;

    const previousEndedWithHyphen = /-\s*$/.test(previousRawText);
    const joinsWrappedWord =
      text.length > 0 &&
      fragment.lineBreakBefore &&
      previousEndedWithHyphen &&
      /^[\p{Ll}]/u.test(normalizedFragment);

    if (text.length > 0 && !joinsWrappedWord) {
      text += " ";
      sourceIndexes.push(fragment.sourceIndex);
    }

    text += normalizedFragment;
    sourceIndexes.push(
      ...Array.from(
        { length: normalizedFragment.length },
        () => fragment.sourceIndex,
      ),
    );
    previousRawText = fragment.text;
  }

  return { text, sourceIndexes };
}

function findOccurrences(pageText: string, passage: string): number[] {
  const occurrences: number[] = [];
  let searchFrom = 0;

  while (searchFrom <= pageText.length - passage.length) {
    const index = pageText.indexOf(passage, searchFrom);
    if (index === -1) break;

    const startsOnWord = index === 0 || pageText[index - 1] === " ";
    const end = index + passage.length;
    const endsOnWord = end === pageText.length || pageText[end] === " ";

    if (startsOnWord && endsOnWord) occurrences.push(index);
    searchFrom = index + 1;
  }

  return occurrences;
}

const COMMON_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to",
  "was", "were", "with",
]);

/** Find one distinctive, unique chunk passage on the normalized target page. */
export function matchCitationPassage(
  chunkContent: string,
  normalizedPageText: string,
): CitationMatch | null {
  const normalizedChunk = normalizeCitationText(chunkContent);
  const words = normalizedChunk.split(" ").filter(Boolean);

  if (words.length < 4 || !normalizedPageText) return null;

  const windowSizes = [24, 18, 12, 8, 6, 4].filter(
    (size) => size <= words.length,
  );
  let bestMatch: (CitationMatch & { score: number }) | null = null;

  for (const windowSize of windowSizes) {
    for (let startWord = 0; startWord <= words.length - windowSize; startWord++) {
      const candidateWords = words.slice(startWord, startWord + windowSize);
      const passage = candidateWords.join(" ");
      const occurrences = findOccurrences(normalizedPageText, passage);

      // Repeated text is ambiguous. Try another, usually longer/more specific,
      // window instead of highlighting the first occurrence and possibly lying.
      if (occurrences.length !== 1) continue;

      const distinctiveWords = new Set(
        candidateWords.filter(
          (word) => word.length >= 4 && !COMMON_WORDS.has(word),
        ),
      ).size;
      const score = windowSize * 10 + distinctiveWords * 3;

      if (!bestMatch || score > bestMatch.score) {
        const start = occurrences[0] ?? 0;
        bestMatch = {
          start,
          end: start + passage.length,
          passage,
          score,
        };
      }
    }

    // A unique long passage is already safer than dropping to shorter windows.
    if (bestMatch) break;
  }

  if (!bestMatch) return null;
  return {
    start: bestMatch.start,
    end: bestMatch.end,
    passage: bestMatch.passage,
  };
}
