// An RFC 4180 CSV reader for the training-record import (slice R2a). Fields
// are separated by commas and rows by CRLF or LF; a field in double quotes
// may hold commas, line breaks and "" for one quote. A leading UTF-8 byte
// order mark is dropped. Every cell comes back as the exact text it holds:
// nothing is trimmed, converted or evaluated, so a cell that looks like a
// spreadsheet formula stays text.

export class CsvError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = "CsvError";
  }
}

export function parseCsv(text: string): string[][] {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let quoteLine = 1;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          const next = src[i + 1];
          if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") {
            throw new CsvError("a closing quote must end its field", line);
          }
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) throw new CsvError("a quote inside an unquoted field must be in a quoted field", line);
      quoted = true;
      fieldStarted = true;
      quoteLine = line;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r" && src[i + 1] === "\n") {
      endRow();
      i++;
      line++;
    } else if (ch === "\n") {
      endRow();
      line++;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvError("a quoted field is never closed", quoteLine);
  if (fieldStarted || row.length > 0) endRow();
  return rows;
}
