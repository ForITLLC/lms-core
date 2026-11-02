"use client";

import { useEffect, useState } from "react";

// The tenant admin's switch for AI marking of written answers (slice A5b). It
// reads and writes /api/admin/ai-settings, which takes admins only and writes
// an audit event on every change. The switch does nothing unless the platform
// also has AI on for the tenant (`available`), so it is disabled until then.

interface Settings {
  gradeWrittenAnswers: boolean;
  available: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

const URL_PATH = "/api/admin/ai-settings";

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
}

export default function AiSettingsToggle() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(URL_PATH, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()) as Settings;
      })
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(URL_PATH, {
        method: "PUT",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gradeWrittenAnswers: next }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setSettings((await res.json()) as Settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the setting.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return error ? <p className="text-sm text-rose-700">{error}</p> : <p className="text-sm text-gray-500">Loading…</p>;
  }

  const on = settings.gradeWrittenAnswers;
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={on}
          disabled={!settings.available || saving}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block font-semibold text-gray-900">Mark written answers with AI</span>
          <span className="block text-sm text-gray-600">
            Learners&rsquo; written answers and the question&rsquo;s rubric are sent to the AI model, which gives a
            provisional mark and feedback. An instructor confirms or overrides every mark, and only an instructor&rsquo;s
            mark counts toward pass or fail. Learners are told their answers are marked by AI first.
          </span>
        </span>
      </label>
      {!settings.available ? <p className="text-sm text-gray-600">Not available on this platform yet.</p> : null}
      {settings.updatedBy && settings.updatedAt ? (
        <p className="text-xs text-gray-500">
          Last changed by {settings.updatedBy} on {new Date(settings.updatedAt).toLocaleString()}.
        </p>
      ) : null}
      {error ? <p className="text-sm text-rose-700">{error}</p> : null}
    </div>
  );
}
