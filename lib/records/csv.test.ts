import { test } from "node:test";
import assert from "node:assert/strict";
import { CsvError, parseCsv } from "./csv";

// The CSV reader behind the training-record import (slice R2a): RFC 4180
// quoting, CRLF or LF, a byte order mark dropped, and every cell kept as the
// exact text it holds.

test("quoted fields keep commas, line breaks and doubled quotes; CRLF and LF both end a row", () => {
  const text = 'a,b,c\r\n"x, y","line one\nline two","say ""hi"""\n1,,3\r\n';
  assert.deepEqual(parseCsv(text), [
    ["a", "b", "c"],
    ["x, y", "line one\nline two", 'say "hi"'],
    ["1", "", "3"],
  ]);
});

test("a leading byte order mark is dropped, and only a leading one", () => {
  assert.deepEqual(parseCsv("\uFEFFemail,kind\nx@a.test,check"), [["email", "kind"], ["x@a.test", "check"]]);
  assert.deepEqual(parseCsv("a,\uFEFFb"), [["a", "\uFEFFb"]]);
});

test("cells are not trimmed, converted or evaluated: a formula stays text", () => {
  const rows = parseCsv('=1+1,"=HYPERLINK(""http://x.test"")", +2 ,-3,@SUM(A1)\n');
  assert.deepEqual(rows, [["=1+1", '=HYPERLINK("http://x.test")', " +2 ", "-3", "@SUM(A1)"]]);
});

test("a final row with no line break is kept, a trailing empty field too, and an empty text is no rows", () => {
  assert.deepEqual(parseCsv("a,b\n1,"), [["a", "b"], ["1", ""]]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv('""'), [[""]]);
});

test("broken quoting is refused with the line it starts on", () => {
  assert.throws(() => parseCsv('a\n"open\nstill open'), (e: unknown) => e instanceof CsvError && /never closed \(line 2\)/.test(e.message));
  assert.throws(() => parseCsv('a,"b"c\n'), (e: unknown) => e instanceof CsvError && /closing quote/.test(e.message));
  assert.throws(() => parseCsv('a,b"c"\n'), (e: unknown) => e instanceof CsvError && /quote inside an unquoted field/.test(e.message));
});
