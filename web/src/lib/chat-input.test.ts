import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitChatKey } from "./chat-input";

test("Enter submits while Shift+Enter keeps a newline", () => {
  assert.equal(shouldSubmitChatKey("Enter", false, false), true);
  assert.equal(shouldSubmitChatKey("Enter", true, false), false);
  assert.equal(shouldSubmitChatKey("a", false, false), false);
});

test("Enter does not submit while an input method is composing text", () => {
  assert.equal(shouldSubmitChatKey("Enter", false, true), false);
});
