"use client";

import { useState } from "react";
import { RECORDS_ROLES, type RecordsRole } from "@/lib/auth/records-permissions";

// The admin gives and takes away the instructor and training-manager roles
// (card d3e16430) through PUT /api/admin/records/roles, which re-checks the
// admin, the tenant and its records switch. Admins and authors are set by the
// operator's admin group or its setup, so their rows are read-only here.

export interface RecordsRolesPerson {
  appUserId: string;
  displayName: string;
  email: string;
  role: string;
}

export const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  author: "Author",
  learner: "Learner",
  instructor: "Instructor",
  training_manager: "Training manager",
};

const settable = (role: string): role is RecordsRole => RECORDS_ROLES.some((r) => r === role);

export default function RecordsRoles({ people: initial }: { people: RecordsRolesPerson[] }) {
  const [people, setPeople] = useState(initial);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function setRole(person: RecordsRolesPerson, role: RecordsRole) {
    setSaving(person.appUserId);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/records/roles", {
        method: "PUT",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appUserId: person.appUserId, role }),
      });
      const data = (await res.json().catch(() => ({}))) as { role?: string; error?: string };
      if (!res.ok || !data.role) {
        setMessage({ ok: false, text: data.error ?? `Request failed (${res.status})` });
        return;
      }
      const now = data.role;
      setPeople((list) => list.map((p) => (p.appUserId === person.appUserId ? { ...p, role: now } : p)));
      setMessage({ ok: true, text: `${person.displayName} is now ${ROLE_LABELS[now] ?? now}. This takes effect within a minute.` });
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold" style={{ color: "var(--brand-primary)" }}>Records roles</h2>
      <p className="max-w-prose text-sm text-gray-600">
        An instructor enters the training they ran or assessed (checks, OJT, line indoctrination, familiarization and
        monitor flights, vendor training), marks written exam answers and reads everyone&rsquo;s training records. A
        training manager can also enter any kind of record, correct a record, import paper records and mark someone as
        having left. Neither can change settings or roles. Every record keeps who wrote it, and no record is ever
        edited or deleted.
      </p>
      <table className="w-full text-left text-sm">
        <thead className="text-gray-600">
          <tr><th>Name</th><th>Email</th><th>Role</th></tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.appUserId} className="border-t border-gray-100 align-middle">
              <td className="py-1">{p.displayName}</td>
              <td className="py-1">{p.email}</td>
              <td className="py-1">
                {settable(p.role) ? (
                  <select
                    aria-label={`Role for ${p.displayName}`}
                    className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                    value={p.role}
                    disabled={saving !== null}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (settable(next)) void setRole(p, next);
                    }}
                  >
                    {RECORDS_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                ) : (
                  <span className="text-gray-700">{ROLE_LABELS[p.role] ?? p.role}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {message ? <p className={`text-sm ${message.ok ? "text-gray-800" : "text-rose-700"}`}>{message.text}</p> : null}
    </section>
  );
}
