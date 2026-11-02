import {
  readingMinutes,
  SOURCE_TEXT_MAX,
  SOURCE_TITLE_MAX,
  SourceRefusedError,
  type SourceExtract,
} from "./source";

export interface PastedText {
  title: string;
  text: string;
}

const count = (n: number) => n.toLocaleString("en-US");

// A paste is checked when it is queued and again when the job reads it back.
// The cap counts the text as given, before trimming.
export function checkPastedText(input: { title?: unknown; text?: unknown }): PastedText {
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  if (!title) throw new SourceRefusedError("Pasted text needs a title.");
  if (title.length > SOURCE_TITLE_MAX) {
    throw new SourceRefusedError(`The title is ${count(title.length)} characters; the most is ${count(SOURCE_TITLE_MAX)}.`);
  }
  if (typeof input.text !== "string") throw new SourceRefusedError("There is no pasted text.");
  if (input.text.length > SOURCE_TEXT_MAX) {
    throw new SourceRefusedError(
      `The pasted text is ${count(input.text.length)} characters; the most is ${count(SOURCE_TEXT_MAX)}.`,
    );
  }
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new SourceRefusedError("The pasted text is empty.");
  return { title, text };
}

export function extractText(input: { title?: unknown; text?: unknown }): SourceExtract {
  const { title, text } = checkPastedText(input);
  return { kind: "text", title, author: null, url: null, text, approxMinutes: readingMinutes(text) };
}
