import assert from "node:assert/strict";
import test from "node:test";
import { changePdfZoom, clampPdfPage } from "./pdf-viewer-state";

test("page navigation clamps requests to the loaded PDF", () => {
  assert.equal(clampPdfPage(0, 8), 1);
  assert.equal(clampPdfPage(4, 8), 4);
  assert.equal(clampPdfPage(99, 8), 8);
  assert.equal(clampPdfPage(2, 0), null);
  assert.equal(clampPdfPage(Number.NaN, 8), null);
});

test("zoom controls stay between 75 and 200 percent", () => {
  assert.equal(changePdfZoom(0.75, "out"), 0.75);
  assert.equal(changePdfZoom(1, "in"), 1.25);
  assert.equal(changePdfZoom(2, "in"), 2);
});
