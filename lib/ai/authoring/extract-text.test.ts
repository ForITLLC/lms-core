import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPastedText, extractText } from "./extract-text";
import { SOURCE_TEXT_MAX, SourceRefusedError } from "./source";

// Pasted text as a course source (docs/plans/2026-10-29-ai-authoring.md, slice A3).

const refusedWith = (input: { title?: unknown; text?: unknown }, message: string) =>
  assert.throws(() => extractText(input), (err: unknown) => err instanceof SourceRefusedError && err.message === message);

test("a paste over 200,000 characters is refused; exactly 200,000 is accepted", () => {
  refusedWith({ title: "Big", text: "a".repeat(SOURCE_TEXT_MAX + 1) }, "The pasted text is 200,001 characters; the most is 200,000.");
  const full = extractText({ title: "Full", text: "a".repeat(SOURCE_TEXT_MAX) });
  assert.equal(full.text.length, SOURCE_TEXT_MAX);
  // The cap counts the text as given, so padding can't smuggle more in.
  refusedWith({ title: "Padded", text: ` ${"a".repeat(SOURCE_TEXT_MAX)}` }, "The pasted text is 200,001 characters; the most is 200,000.");
});

test("an empty paste, a missing title and text that isn't a string are refused", () => {
  refusedWith({ title: "Blank", text: "" }, "The pasted text is empty.");
  refusedWith({ title: "Blank", text: " \r\n\t \n" }, "The pasted text is empty.");
  refusedWith({ text: "words" }, "Pasted text needs a title.");
  refusedWith({ title: " \n ", text: "words" }, "Pasted text needs a title.");
  refusedWith({ title: 7, text: "words" }, "Pasted text needs a title.");
  refusedWith({ title: "t".repeat(201), text: "words" }, "The title is 201 characters; the most is 200.");
  refusedWith({ title: "Notes" }, "There is no pasted text.");
  refusedWith({ title: "Notes", text: ["words"] }, "There is no pasted text.");
});

test("a paste becomes a text extract: line endings made \\n, the ends trimmed, the title on one line, minutes of reading", () => {
  const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
  assert.deepEqual(extractText({ title: "  Hangar\n\tnotes ", text: `\r\n  Chock the wheels.\r\nCheck the tow bar.\r${words}\n\n` }), {
    kind: "text",
    title: "Hangar notes",
    author: null,
    url: null,
    text: `Chock the wheels.\nCheck the tow bar.\n${words}`,
    approxMinutes: 3,
  });
  assert.equal(extractText({ title: "Short", text: "One line." }).approxMinutes, 1);
  assert.deepEqual(checkPastedText({ title: "T", text: "x" }), { title: "T", text: "x" });
});
