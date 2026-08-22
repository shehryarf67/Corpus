import assert from "node:assert/strict";
import test from "node:test";
import {
  citationFragmentsFromRenderedSpans,
  matchCitationPassage,
  matchCitationSpanIndexes,
  normalizeCitationText,
  normalizePageFragments,
} from "./citation-matching";

test("normal text is normalized and matched", () => {
  const page = normalizeCitationText(
    "The quantization policy improves model compression during training.",
  );
  const match = matchCitationPassage(
    "The quantization policy improves model compression during training.",
    page,
  );

  assert.ok(match);
  assert.equal(page.slice(match.start, match.end), match.passage);
});

test("multiple spaces collapse into one searchable space", () => {
  assert.equal(
    normalizeCitationText("model     compression\t improves   accuracy"),
    "model compression improves accuracy",
  );
});

test("line breaks normalize like ordinary spaces", () => {
  assert.equal(
    normalizeCitationText("knowledge\ndistillation\r\nimproves training"),
    "knowledge distillation improves training",
  );
});

test("words hyphenated across lines are joined", () => {
  const page = normalizePageFragments([
    {
      text: "The quantiza-",
      sourceIndex: 0,
      lineBreakBefore: false,
    },
    {
      text: "tion policy improves model compression",
      sourceIndex: 1,
      lineBreakBefore: true,
    },
  ]);

  assert.equal(
    normalizeCitationText("The quantiza-\ntion policy improves model compression"),
    page.text,
  );
  assert.equal(page.text, "the quantization policy improves model compression");
});

test("Unicode compatibility ligatures expand to ordinary letters", () => {
  assert.equal(
    normalizeCitationText("A ﬁnal eﬃcient ﬂow"),
    "a final efficient flow",
  );
});

test("an ambiguous repeated passage is not matched", () => {
  const match = matchCitationPassage(
    "the results show improved accuracy",
    normalizeCitationText(
      "the results show improved accuracy while testing and the results show improved accuracy again",
    ),
  );

  assert.equal(match, null);
});

test("unrelated chunk and page text produce no match", () => {
  const match = matchCitationPassage(
    "quantization policy improves model compression",
    normalizeCitationText("this page discusses a completely unrelated topic"),
  );

  assert.equal(match, null);
});

test("citation span matching stays stable at different PDF zoom levels", () => {
  const chunk = "The supporting passage remains correctly highlighted after zooming.";

  for (const zoom of [0.75, 1, 1.25, 1.5, 2]) {
    const fragments = citationFragmentsFromRenderedSpans([
      { text: "A nearby heading", top: 100 * zoom },
      { text: "The supporting passage remains", top: 130 * zoom },
      { text: "correctly highlighted after zooming.", top: 150 * zoom },
    ]);

    assert.deepEqual(matchCitationSpanIndexes(chunk, fragments), [1, 2]);
  }
});
