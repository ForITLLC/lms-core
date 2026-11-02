import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_FIELDS,
  canonicalRecord,
  computeRowHash,
  GENESIS_HASH,
  verifyChain,
  type ChainedRecord,
  type RecordFields,
} from "./chain";

// The training-record hash chain (docs/plans/2026-10-29-training-records-design.md
// §3.1, slice R1a). The canonical text and the hash below are pinned: a change
// to the recipe changes them, and needs a new CANONICAL_VERSION. The hash was
// checked against an independent SHA-256 of 32 zero bytes and the UTF-8 text.

const FIELDS: RecordFields = {
  recordId: "11111111-1111-4111-8111-111111111111",
  tenantId: "AAAAAAAA-0000-4000-8000-00000000000A",
  seq: 1,
  learnerId: "bbbbbbbb-0000-4000-8000-00000000000b",
  personName: "Zoë Pilot",
  personEmail: "zoe@example.test",
  kind: "exam_fail",
  occurredAt: new Date("2026-10-29T12:34:56.789Z"),
  courseId: "cccccccc-0000-4000-8000-00000000000c",
  courseVersionId: null,
  courseTitle: "Principles of Flight",
  quizId: "dddddddd-0000-4000-8000-00000000000d",
  attemptId: "eeeeeeee-0000-4000-8000-00000000000e",
  result: "fail",
  score: 60,
  passingScore: 70,
  failureDetail: "scored 60, needed 70",
  source: "auto",
  recordedBy: "zoe@example.test",
  recordedAt: new Date("2026-10-29T12:35:00.000Z"),
  correctsRecordId: null,
  payloadJson: null,
};

const CANONICAL =
  '{"v":1,"recordId":"11111111-1111-4111-8111-111111111111","tenantId":"aaaaaaaa-0000-4000-8000-00000000000a","seq":1,' +
  '"learnerId":"bbbbbbbb-0000-4000-8000-00000000000b","personName":"Zoë Pilot","personEmail":"zoe@example.test",' +
  '"kind":"exam_fail","occurredAt":"2026-10-29T12:34:56.789Z","courseId":"cccccccc-0000-4000-8000-00000000000c",' +
  '"courseVersionId":null,"courseTitle":"Principles of Flight","quizId":"dddddddd-0000-4000-8000-00000000000d",' +
  '"attemptId":"eeeeeeee-0000-4000-8000-00000000000e","result":"fail","score":60,"passingScore":70,' +
  '"failureDetail":"scored 60, needed 70","source":"auto","recordedBy":"zoe@example.test",' +
  '"recordedAt":"2026-10-29T12:35:00.000Z","correctsRecordId":null,"payloadJson":null}';
const HASH = "a971d1f461c07aec29095bdd870c7a65c86e7a16a19e1f9b92de92b200bdda67";

test("the canonical text and its hash are pinned: keys in CANONICAL_FIELDS order, ids lower-case, times in UTC milliseconds", () => {
  assert.equal(canonicalRecord(FIELDS), CANONICAL);
  assert.deepEqual(Object.keys(JSON.parse(CANONICAL)), ["v", ...CANONICAL_FIELDS]);
  assert.equal(computeRowHash(GENESIS_HASH, FIELDS), HASH);
  assert.equal(computeRowHash(GENESIS_HASH.toUpperCase(), { ...FIELDS, tenantId: FIELDS.tenantId.toLowerCase() }), HASH);
  assert.notEqual(computeRowHash("ff".repeat(32), FIELDS), HASH, "the previous hash is part of what is hashed");
});

test("changing any one field changes the hash", () => {
  const changed: Record<string, unknown> = {
    recordId: "11111111-1111-4111-8111-111111111112", tenantId: "aaaaaaaa-0000-4000-8000-00000000000b", seq: 2,
    learnerId: "bbbbbbbb-0000-4000-8000-00000000000c", personName: "Zoe Pilot", personEmail: "zoe2@example.test",
    kind: "exam_pass", occurredAt: new Date("2026-10-29T12:34:56.788Z"), courseId: null,
    courseVersionId: "cccccccc-0000-4000-8000-00000000000d", courseTitle: "Principles of flight", quizId: null, attemptId: null,
    result: "pass", score: 61, passingScore: 69, failureDetail: null, source: "manual", recordedBy: "staff@example.test",
    recordedAt: new Date("2026-10-29T12:35:00.001Z"), correctsRecordId: "11111111-1111-4111-8111-111111111113", payloadJson: "{}",
  };
  assert.deepEqual(Object.keys(changed).sort(), [...CANONICAL_FIELDS].sort());
  const seen = new Set([HASH]);
  for (const name of CANONICAL_FIELDS) {
    const hash = computeRowHash(GENESIS_HASH, { ...FIELDS, [name]: changed[name] } as RecordFields);
    assert.ok(!seen.has(hash), name);
    seen.add(hash);
  }
});

test("a value of the wrong shape can't be hashed", () => {
  for (const [name, value] of [
    ["recordId", "not-a-guid"], ["learnerId", ""], ["seq", 1.5], ["seq", "1"], ["score", Number.NaN],
    ["occurredAt", new Date("nope")], ["personName", 7], ["payloadJson", { a: 1 }],
  ] as const) {
    assert.throws(() => computeRowHash(GENESIS_HASH, { ...FIELDS, [name]: value } as unknown as RecordFields), Error, `${name}=${String(value)}`);
  }
  for (const prev of ["", "00", "g".repeat(64), "0".repeat(63)]) assert.throws(() => computeRowHash(prev, FIELDS), /prevHash/);
});

function chainOf(count: number): ChainedRecord[] {
  const rows: ChainedRecord[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= count; seq++) {
    const fields: RecordFields = {
      ...FIELDS,
      tenantId: FIELDS.tenantId.toLowerCase(),
      recordId: `11111111-1111-4111-8111-${String(seq).padStart(12, "0")}`,
      seq,
      kind: "exam_pass",
      result: "pass",
      score: 70 + seq,
      failureDetail: null,
    };
    const rowHash = computeRowHash(prev, fields);
    rows.push({ ...fields, prevHash: prev, rowHash });
    prev = rowHash;
  }
  return rows;
}

const head = (rows: ChainedRecord[]) => ({ lastSeq: rows.length, lastHash: rows.at(-1)?.rowHash ?? GENESIS_HASH });

test("an untouched chain verifies, with or without its head, and so does an empty one", () => {
  const rows = chainOf(4);
  assert.deepEqual(verifyChain(rows, head(rows)), { ok: true, count: 4, headSeq: 4, headHash: rows[3]!.rowHash });
  assert.equal(verifyChain(rows).ok, true);
  assert.deepEqual(verifyChain([], null), { ok: true, count: 0, headSeq: 0, headHash: GENESIS_HASH });
  assert.equal(verifyChain([], { lastSeq: 0, lastHash: GENESIS_HASH }).ok, true);
  const upper = rows.map((r) => ({ ...r, prevHash: r.prevHash.toUpperCase(), rowHash: r.rowHash.toUpperCase() }));
  assert.equal(verifyChain(upper, { lastSeq: 4, lastHash: rows[3]!.rowHash.toUpperCase() }).ok, true, "hex compares without case");
});

test("a deleted, reordered or edited row is found at its Seq, with the reason", () => {
  const rows = chainOf(4);
  const verdict = (broken: ChainedRecord[], h: ReturnType<typeof head> | null = head(rows)) => {
    const v = verifyChain(broken, h);
    return v.ok ? "ok" : `${v.reason}@${v.seq}`;
  };

  assert.equal(verdict([rows[0]!, rows[2]!, rows[3]!]), "gap@2");
  assert.equal(verdict([rows[0]!, rows[2]!, rows[1]!, rows[3]!]), "order@2");
  assert.equal(verdict(rows.map((r) => (r.seq === 3 ? { ...r, score: 99 } : r))), "hash@3");
  assert.equal(verdict(rows.map((r) => (r.seq === 3 ? { ...r, personEmail: "someone@example.test" } : r))), "hash@3");
  assert.equal(verdict(rows.map((r) => (r.seq === 2 ? { ...r, rowHash: "0".repeat(64) } : r))), "hash@2");

  // An edit whose own hash is recomputed still breaks the row after it.
  const edited = { ...rows[1]!, score: 10, result: "fail" as const, failureDetail: "scored 10, needed 70" };
  edited.rowHash = computeRowHash(edited.prevHash, edited);
  assert.equal(verdict([rows[0]!, edited, rows[2]!, rows[3]!]), "prev@3");

  // A row that names another previous hash, with its own hash made to match.
  const forked = { ...rows[2]!, prevHash: "ab".repeat(32) };
  forked.rowHash = computeRowHash(forked.prevHash, forked);
  assert.equal(verdict([rows[0]!, rows[1]!, forked, rows[3]!]), "prev@3");

  // Rows removed from the end: only the head shows it.
  assert.equal(verdict(rows.slice(0, 3)), "head@4");
  assert.equal(verdict(rows.slice(0, 3), null), "ok");
  assert.equal(verdict([], head(rows)), "head@1");
  assert.equal(verdict(rows, { lastSeq: 4, lastHash: "cd".repeat(32) }), "head@4");
  assert.equal(verdict(rows, { lastSeq: 5, lastHash: rows[3]!.rowHash }), "head@5");
});
