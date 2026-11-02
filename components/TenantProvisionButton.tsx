"use client";

import { useState } from "react";

interface ProvisionStep {
  step: string;
  status: "success" | "skipped" | "error";
  detail: string;
}

interface Props {
  slug: string;
}

type RunState = "idle" | "running" | "ok" | "error";

export default function TenantProvisionButton({ slug }: Props) {
  const [state, setState] = useState<RunState>("idle");
  const [steps, setSteps] = useState<ProvisionStep[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setState("running");
    setSteps([]);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/tenants/${encodeURIComponent(slug)}/provision-dns`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        steps?: ProvisionStep[];
      };
      setSteps(data.steps ?? []);
      setMessage(data.message ?? data.error ?? `HTTP ${res.status}`);
      setState(res.ok ? "ok" : "error");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Request failed");
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={state === "running"}
        className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        style={{ backgroundColor: "var(--brand-primary)" }}
      >
        {state === "running" ? "Provisioning…" : "Provision DNS"}
      </button>

      {message && (
        <p
          className={`mt-2 rounded p-2 text-sm ${
            state === "error"
              ? "bg-red-50 border border-red-200 text-red-700"
              : "bg-green-50 border border-green-200 text-green-700"
          }`}
        >
          {message}
        </p>
      )}

      {steps.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-gray-700">
          {steps.map((s, i) => (
            <li key={i} className="font-mono">
              <span
                className={
                  s.status === "success"
                    ? "text-green-700"
                    : s.status === "error"
                      ? "text-red-700"
                      : "text-gray-500"
                }
              >
                [{s.status}]
              </span>{" "}
              {s.step}: {s.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
