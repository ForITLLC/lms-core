"use client";

import { useCallback, useEffect, useState } from "react";
import type { RecordsRights } from "@/lib/auth/records-permissions";
import { Button } from "@/components/ui/Button";

// The training records screen (slices R2a and R2b of
// docs/plans/2026-10-29-training-records-design.md). Pick a learner to see
// the records in force, each record's line of corrections, and the
// learner's personnel details; enter a record by hand; correct or void a
// record with a reason; mark a learner left or active again; and import a
// CSV of paper records, checked by a dry run first. Each part shows only for
// a role holding its right (@/lib/auth/records-permissions), and every action
// goes through an API that re-checks the right and the tenant's records
// switch. Evidence is a reference written as text: files are not uploaded.

interface Learner {
  learnerId: string;
  email: string;
  displayName: string;
  status: string;
}

interface RecordView {
  recordId: string;
  kind: string;
  title: string | null;
  occurredAt: string;
  result: string;
  score: number | null;
  passingScore: number | null;
  failureDetail: string | null;
  source: string;
  recordedBy: string;
  recordedAt: string;
  correctsRecordId: string | null;
  details: Record<string, unknown>;
  void: boolean;
}

interface PersonnelLink {
  personnelLinkId: string;
  dutyPosition: string;
  employeeNo: string | null;
  hireDate: string | null;
  leaveDate: string | null;
  effectiveFrom: string;
  crewRecordsPersonRef: string | null;
  supersedesLinkId: string | null;
  reason: string | null;
  recordedBy: string;
  recordedAt: string;
}

interface Issue {
  row?: number;
  field?: string;
  column?: string;
  message: string;
}

const KINDS = ["check", "ojt", "line_indoc", "familiarization", "monitor", "qualification", "vendor_training", "acp_ppc"];
const RESULTS = ["pass", "fail", "completed", "attended", "incomplete"];
const CHECK_TYPES = ["", "ppc", "competency_check", "line_check", "monitor", "other"];
const DUTY_POSITIONS = ["pilot", "flight_attendant", "dispatcher", "dg", "ame", "other"];
const ENTRY_FIELDS: { name: string; label: string; required?: boolean }[] = [
  { name: "title", label: "Title", required: true },
  { name: "occurredOn", label: "Date (YYYY-MM-DD)", required: true },
  { name: "evidenceRef", label: "Evidence reference (paper file, certificate or PFTR number)", required: true },
  { name: "instructorName", label: "Instructor" },
  { name: "assessorName", label: "Assessor" },
  { name: "failureDetail", label: "What was failed and why (a fail needs it)" },
  { name: "score", label: "Score (0–100)" },
  { name: "passingScore", label: "Pass mark (0–100)" },
  { name: "externalRef", label: "External reference" },
  { name: "aircraftType", label: "Aircraft type" },
];

const label = (s: string) => s.replace(/_/g, " ");
const day = (iso: string) => iso.slice(0, 10);

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; issues: Issue[] }> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, data: data as T };
  return {
    ok: false,
    error: typeof data.error === "string" ? data.error : `Request failed (${res.status})`,
    issues: Array.isArray(data.issues) ? (data.issues as Issue[]) : [],
  };
}

function Issues({ error, issues }: { error: string | null; issues: Issue[] }) {
  if (!error) return null;
  return (
    <div className="text-sm text-rose-700">
      <p>{error}</p>
      {issues.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {issues.slice(0, 50).map((i, n) => (
            <li key={n}>
              {i.row !== undefined ? `Row ${i.row}` : ""}
              {i.column || i.field ? `${i.row !== undefined ? ", " : ""}${label(i.column || i.field || "")}` : ""}: {i.message}
            </li>
          ))}
          {issues.length > 50 ? <li>…and {issues.length - 50} more.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

const input = "mt-1 block w-full rounded-md border border-gray-300 px-2 py-1 text-sm";

function entryBody(form: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string" || value.trim() === "") continue;
    body[key] = key === "score" || key === "passingScore" ? Number(value) : value;
  }
  return body;
}

export default function RecordsManager({ rights, signedInName }: { rights: RecordsRights; signedInName?: string }) {
  const [learners, setLearners] = useState<Learner[] | null>(null);
  const [learnerId, setLearnerId] = useState("");
  const [records, setRecords] = useState<RecordView[]>([]);
  const [voided, setVoided] = useState(0);
  const [links, setLinks] = useState<PersonnelLink[]>([]);
  const [current, setCurrent] = useState<PersonnelLink | null>(null);
  const [history, setHistory] = useState<{ recordId: string; line: RecordView[] } | null>(null);
  const [correcting, setCorrecting] = useState<RecordView | null>(null);
  const [error, setError] = useState<{ where: string; error: string; issues: Issue[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [csv, setCsv] = useState("");
  const [importReport, setImportReport] = useState<string | null>(null);

  useEffect(() => {
    void call<{ learners: Learner[] }>("/api/admin/records").then((r) => {
      if (r.ok) setLearners(r.data.learners);
      else setError({ where: "load", error: r.error, issues: [] });
    });
  }, []);

  const loadLearner = useCallback(async (id: string) => {
    setHistory(null);
    setCorrecting(null);
    if (!id) return;
    const [rec, per] = await Promise.all([
      call<{ records: RecordView[]; voided: number }>(`/api/admin/records?learnerId=${encodeURIComponent(id)}`),
      rights.personnel ? call<{ links: PersonnelLink[]; current: PersonnelLink | null }>(`/api/admin/learners/${encodeURIComponent(id)}/personnel`) : null,
    ]);
    if (rec.ok) {
      setRecords(rec.data.records);
      setVoided(rec.data.voided);
    } else setError({ where: "load", error: rec.error, issues: [] });
    if (per?.ok) {
      setLinks(per.data.links);
      setCurrent(per.data.current);
    }
  }, [rights.personnel]);

  useEffect(() => {
    void loadLearner(learnerId);
  }, [learnerId, loadLearner]);

  async function submit(where: string, url: string, body: unknown, done?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await call(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        setError({ where, error: r.error, issues: r.issues });
        return;
      }
      done?.();
      await loadLearner(learnerId);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: "active" | "left") {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ status: string }>(`/api/admin/learners/${encodeURIComponent(id)}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) {
        setError({ where: "status", error: r.error, issues: [] });
        return;
      }
      setLearners((list) => list?.map((l) => (l.learnerId === id ? { ...l, status: r.data.status } : l)) ?? list);
    } finally {
      setBusy(false);
    }
  }

  async function showHistory(recordId: string) {
    const r = await call<{ line: RecordView[] }>(`/api/admin/records/${recordId}`);
    if (r.ok) setHistory({ recordId, line: r.data.line });
    else setError({ where: "history", error: r.error, issues: [] });
  }

  async function sendImport(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setImportReport(null);
    try {
      const res = await fetch(`/api/admin/records/import${dryRun ? "?dryRun=1" : ""}`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "text/csv" },
        body: csv,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const issues = Array.isArray(data.issues) ? (data.issues as Issue[]) : [];
      if (data.outcome === "dry_run") {
        setImportReport(`Checked ${data.rows} rows: ${data.wouldWrite} would be written, ${data.alreadyWritten} were written by an earlier run, ${issues.length} problems.`);
        if (issues.length > 0) setError({ where: "import", error: "Fix these rows before importing.", issues });
      } else if (data.outcome === "imported") {
        setImportReport(`Imported ${data.written} records${Number(data.alreadyWritten) > 0 ? ` (${data.alreadyWritten} were already written)` : ""}.`);
        await loadLearner(learnerId);
      } else {
        setError({ where: "import", error: typeof data.error === "string" ? data.error : `Import failed (${res.status})`, issues });
      }
    } finally {
      setBusy(false);
    }
  }

  if (!learners) {
    return error ? <p className="text-sm text-rose-700">{error.error}</p> : <p className="text-sm text-gray-500">Loading…</p>;
  }

  const learner = learners.find((l) => l.learnerId === learnerId);
  const errorFor = (where: string) => (error?.where === where ? <Issues error={error.error} issues={error.issues} /> : null);

  return (
    <div className="space-y-8">
      <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
        <label className="block text-sm font-semibold text-gray-900">
          Learner
          <select className={input} value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            <option value="">Choose a learner…</option>
            {learners.map((l) => (
              <option key={l.learnerId} value={l.learnerId}>
                {l.displayName} ({l.email}){l.status !== "active" ? ` (${l.status})` : ""}
              </option>
            ))}
          </select>
        </label>
        {errorFor("load")}
        {rights.markLeft && learner && (learner.status === "active" || learner.status === "left") ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" loading={busy} onClick={() => void setStatus(learner.learnerId, learner.status === "left" ? "active" : "left")}>
              {learner.status === "left" ? "Mark active again" : "Mark as left"}
            </Button>
            <span className="text-xs text-gray-500">Someone marked left keeps every record and gets no new assignment or reminder.</span>
          </div>
        ) : null}
        {errorFor("status")}
      </section>

      {learner ? (
        <>
          <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">Records in force</h2>
            {records.length === 0 ? <p className="text-sm text-gray-600">No records yet.</p> : (
              <table className="w-full text-left text-sm">
                <thead className="text-gray-600">
                  <tr><th>Date</th><th>Kind</th><th>Title</th><th>Result</th><th>Source</th><th>Recorded by</th><th /></tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.recordId} className="border-t border-gray-100 align-top">
                      <td>{day(r.occurredAt)}</td>
                      <td>{label(r.kind)}</td>
                      <td>{r.title}</td>
                      <td>{r.result}{r.score !== null ? ` (${r.score}${r.passingScore !== null ? `/${r.passingScore}` : ""})` : ""}</td>
                      <td>{r.source}{r.correctsRecordId ? ", corrected" : ""}</td>
                      <td>{r.recordedBy}</td>
                      <td className="space-x-2 whitespace-nowrap">
                        <button type="button" className="underline" onClick={() => void showHistory(r.recordId)}>History</button>
                        {rights.correct ? (
                          <button type="button" className="underline" onClick={() => { setCorrecting(r); setError(null); }}>Correct</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {voided > 0 ? <p className="text-xs text-gray-500">{voided} voided record{voided === 1 ? "" : "s"} not shown; each stays in its history.</p> : null}
            {errorFor("history")}
            {history ? (
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="font-semibold">History, oldest first</p>
                <ol className="mt-1 list-decimal pl-5">
                  {history.line.map((r) => (
                    <li key={r.recordId}>
                      {day(r.occurredAt)} · {r.title} · {r.result}{r.void ? " · VOID" : ""} · recorded by {r.recordedBy} on {new Date(r.recordedAt).toLocaleString()}
                      {typeof r.details.correctionReason === "string" ? <> · reason: {r.details.correctionReason}</> : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </section>

          {rights.correct && correcting ? (
            <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold text-gray-900">Correct “{correcting.title}” of {day(correcting.occurredAt)}</h2>
              <p className="text-sm text-gray-600">
                The record stays as it is. The correction is a new record that names it, with your reason and your name.
                {KINDS.includes(correcting.kind) ? "" : " This record was written by the LMS: only its date and title can be corrected here."}
              </p>
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  const { reason, void: voidIt, ...changes } = entryBody(form);
                  const body = voidIt === "on" ? { reason, void: true } : { reason, changes };
                  void submit("correct", `/api/admin/records/${correcting.recordId}/corrections`, body, () => setCorrecting(null));
                }}
              >
                <label className="block text-sm">Reason for the correction (required)<textarea name="reason" required className={input} /></label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="void" /> Void this record (entered against the wrong person, or twice)</label>
                <p className="text-xs text-gray-500">Or fill in only the fields that change:</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(KINDS.includes(correcting.kind) ? ENTRY_FIELDS : ENTRY_FIELDS.filter((f) => f.name === "title" || f.name === "occurredOn")).map((f) => (
                    <label key={f.name} className="block text-sm">{f.label}<input name={f.name} className={input} /></label>
                  ))}
                  {KINDS.includes(correcting.kind) ? (
                    <label className="block text-sm">Result
                      <select name="result" className={input} defaultValue=""><option value="">(unchanged)</option>{RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
                    </label>
                  ) : null}
                </div>
                {errorFor("correct")}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" loading={busy}>Save correction</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setCorrecting(null)}>Cancel</Button>
                </div>
              </form>
            </section>
          ) : null}

          {rights.write ? (
            <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold text-gray-900">Enter a record</h2>
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const target = e.currentTarget;
                  void submit("entry", "/api/admin/records", { learnerId, ...entryBody(new FormData(target)) }, () => target.reset());
                }}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-sm">Kind
                    <select name="kind" className={input} required>{rights.kinds.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select>
                  </label>
                  <label className="block text-sm">Result
                    <select name="result" className={input} required>{RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
                  </label>
                  <label className="block text-sm">Check type (checks only)
                    <select name="checkType" className={input}>{CHECK_TYPES.map((c) => <option key={c} value={c}>{c ? label(c) : "(none)"}</option>)}</select>
                  </label>
                  {ENTRY_FIELDS.map((f) => (
                    <label key={f.name} className="block text-sm">
                      {f.label}
                      <input
                        name={f.name}
                        required={f.required}
                        className={input}
                        defaultValue={rights.ownTraining && f.name === "instructorName" ? signedInName : undefined}
                      />
                    </label>
                  ))}
                </div>
                {errorFor("entry")}
                <Button type="submit" size="sm" loading={busy}>Add record</Button>
              </form>
            </section>
          ) : null}

          {rights.personnel ? (
            <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold text-gray-900">Personnel details</h2>
              {current ? (
                <p className="text-sm text-gray-700">
                  In force: {label(current.dutyPosition)} from {current.effectiveFrom}
                  {current.employeeNo ? ` · employee ${current.employeeNo}` : ""}
                  {current.hireDate ? ` · hired ${current.hireDate}` : ""}
                  {current.leaveDate ? ` · left ${current.leaveDate}` : ""}
                  {current.crewRecordsPersonRef ? ` · crew records ${current.crewRecordsPersonRef}` : ""}
                </p>
              ) : <p className="text-sm text-gray-600">None in force.</p>}
              {links.length > 0 ? (
                <ul className="list-disc pl-5 text-xs text-gray-600">
                  {links.map((l) => (
                    <li key={l.personnelLinkId}>
                      {l.effectiveFrom}: {label(l.dutyPosition)}{l.employeeNo ? `, ${l.employeeNo}` : ""} (by {l.recordedBy})
                      {l.supersedesLinkId ? ` · replaces an earlier row: ${l.reason}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const target = e.currentTarget;
                  void submit("personnel", `/api/admin/learners/${learnerId}/personnel`, entryBody(new FormData(target)), () => target.reset());
                }}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-sm">Duty position
                    <select name="dutyPosition" className={input} required>{DUTY_POSITIONS.map((d) => <option key={d} value={d}>{label(d)}</option>)}</select>
                  </label>
                  <label className="block text-sm">In force from (YYYY-MM-DD)<input name="effectiveFrom" required className={input} /></label>
                  <label className="block text-sm">Employee number<input name="employeeNo" className={input} /></label>
                  <label className="block text-sm">Hire date<input name="hireDate" className={input} /></label>
                  <label className="block text-sm">Leave date<input name="leaveDate" className={input} /></label>
                  <label className="block text-sm">Crew records reference<input name="crewRecordsPersonRef" className={input} /></label>
                  <label className="block text-sm">Replaces a row entered wrongly
                    <select name="supersedesLinkId" className={input} defaultValue="">
                      <option value="">(no: a new position or change)</option>
                      {links.map((l) => <option key={l.personnelLinkId} value={l.personnelLinkId}>{l.effectiveFrom}: {label(l.dutyPosition)}</option>)}
                    </select>
                  </label>
                  <label className="block text-sm">Why the earlier row was wrong<input name="reason" className={input} /></label>
                </div>
                {errorFor("personnel")}
                <Button type="submit" size="sm" loading={busy}>Add personnel row</Button>
              </form>
            </section>
          ) : null}
        </>
      ) : null}

      {rights.import ? (
        <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Import paper records (CSV)</h2>
          <p className="text-sm text-gray-600">
            Columns: email, kind, title, occurred_on, result, evidence_ref, and instructor or assessor; optionally
            failure_detail, score, passing_score, external_ref, check_type, aircraft_type. Up to 2,000 rows and 1 MB. Check
            the file first: nothing is imported unless every row is good, and sending the same file again writes only the
            rows not yet written.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then(setCsv);
            }}
          />
          <textarea className={`${input} h-32 font-mono`} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="Or paste the CSV here" />
          {importReport ? <p className="text-sm text-gray-800">{importReport}</p> : null}
          {errorFor("import")}
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" loading={busy} disabled={!csv} onClick={() => void sendImport(true)}>Check the file</Button>
            <Button type="button" size="sm" loading={busy} disabled={!csv} onClick={() => void sendImport(false)}>Import</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
