"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import type { ManagerMapping } from "@/lib/db/learning-summary";

export default function SummaryManagers() {
  const [mappings, setMappings] = useState<ManagerMapping[]>([]);
  const [manager, setManager] = useState("");
  const [learner, setLearner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ manager: string; learner: string } | null>(null);

  async function load() {
    const response = await fetch("/api/admin/summary-managers", { cache: "no-store" });
    if (!response.ok) throw new Error("Couldn’t load manager access. Try again.");
    const data = await response.json() as { mappings: ManagerMapping[] };
    setMappings(data.mappings);
  }

  useEffect(() => { void load().catch(reason => setError(reason.message)); }, []);

  async function change(managerEmail: string, learnerEmail: string, enabled: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/summary-managers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manager_email: managerEmail, learner_email: learnerEmail, enabled }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? "Couldn’t update manager access. Try again.");
      }
      await load();
      setNotice(enabled ? "Manager access added." : "Manager access removed.");
      setUndo(enabled ? null : { manager: managerEmail, learner: learnerEmail });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn’t update manager access.");
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change(manager.trim(), learner.trim(), true);
  }

  return (
    <section aria-labelledby="summary-manager-heading" className="mt-10">
      <h2 id="summary-manager-heading" className="text-xl font-semibold text-gray-900">Manager summaries</h2>
      <p className="text-gray-600 mt-2">Choose whose training each manager may see. Managers see only the learners assigned here; administrators see the organisation.</p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-4 mt-4">
        <label className="text-sm font-medium text-gray-800">Manager work email
          <input type="email" required value={manager} onChange={event => setManager(event.target.value)} className="block border border-gray-300 rounded-md p-2 mt-1" autoComplete="off" />
        </label>
        <label className="text-sm font-medium text-gray-800">Learner work email
          <input type="email" required value={learner} onChange={event => setLearner(event.target.value)} className="block border border-gray-300 rounded-md p-2 mt-1" autoComplete="off" />
        </label>
        <Button type="submit" loading={busy}>Add manager access</Button>
      </form>
      {error ? <p role="alert" className="mt-3 text-red-700">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 text-gray-700">{notice}</p> : null}
      {undo ? <Button variant="ghost" disabled={busy} onClick={() => void change(undo.manager, undo.learner, true)}>Undo removal</Button> : null}
      <ul className="mt-4 divide-y divide-gray-200">
        {mappings.map(mapping => (
          <li key={`${mapping.manager_id}:${mapping.learner_id}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <p>{mapping.manager_name} ({mapping.manager_email}) → {mapping.learner_name} ({mapping.learner_email})</p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(mapping.manager_email, mapping.learner_email, false)}>Remove access</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
