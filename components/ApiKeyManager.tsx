"use client";

import { useState } from "react";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ui/ResponsiveTable";
import Button from "@/components/Button";

export interface ApiKey {
  apiKeyId: string;
  name: string;
  prefix: string;
  ownerOnly: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface MintedKey {
  apiKeyId: string;
  name: string;
  prefix: string;
  ownerOnly: boolean;
  plaintextKey: string;
}

interface Props {
  initialKeys: ApiKey[];
  apiBaseUrl: string;
  specUrl: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function CopyBox({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="flex items-start gap-2">
        <pre className="flex-1 overflow-x-auto rounded bg-gray-50 border border-gray-200 p-3 text-xs text-gray-800 whitespace-pre-wrap break-all">
          {value}
        </pre>
        <button
          type="button"
          className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          onClick={() => {
            navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function ApiKeyManager({ initialKeys, apiBaseUrl, specUrl }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownerOnly, setOwnerOnly] = useState(false);

  async function mint() {
    const name = window.prompt("Name this key (e.g. 'Reporting script')");
    if (!name || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/integrations/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), ownerOnly }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const { key } = (await res.json()) as { key: MintedKey };
      setMinted(key);
      setKeys((prev) => [
        {
          apiKeyId: key.apiKeyId,
          name: key.name,
          prefix: key.prefix,
          ownerOnly: key.ownerOnly,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create key");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(apiKeyId: string, name: string) {
    if (!window.confirm(`Revoke "${name}"? Anything using it will lose access.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/integrations/keys?id=${encodeURIComponent(apiKeyId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const now = new Date().toISOString();
      setKeys((prev) =>
        prev.map((k) => (k.apiKeyId === apiKeyId ? { ...k, revokedAt: now } : k)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke key");
    } finally {
      setBusy(false);
    }
  }

  const columns: ResponsiveColumn<ApiKey>[] = [
    { key: "name", header: "Name", primary: true, className: "font-medium" },
    {
      key: "prefix",
      header: "Prefix",
      render: (k) => <code className="text-xs text-gray-600">{k.prefix}…</code>,
    },
    {
      key: "ownerOnly",
      header: "Reads",
      className: "text-gray-500",
      render: (k) => (k.ownerOnly ? "Only my own learning summary" : "Everything my role can read"),
    },
    {
      key: "createdAt",
      header: "Created",
      className: "text-gray-500",
      render: (k) => formatDate(k.createdAt),
    },
    {
      key: "lastUsedAt",
      header: "Last used",
      className: "text-gray-500",
      render: (k) => formatDate(k.lastUsedAt),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      render: (k) =>
        k.revokedAt !== null ? (
          <span className="text-xs text-gray-500">Revoked</span>
        ) : (
          <button
            type="button"
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={() => revoke(k.apiKeyId, k.name)}
          >
            Revoke
          </button>
        ),
    },
  ];

  const curlCmd = minted?.ownerOnly
    ? `curl -H "Authorization: Bearer ${minted.plaintextKey}" \\
  "${apiBaseUrl}/learning-summary?recipient=<your-email>"`
    : `curl -H "Authorization: Bearer ${minted ? minted.plaintextKey : "<your-key>"}" \\
  ${apiBaseUrl}/courses`;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold" style={{ color: "var(--brand-primary)" }}>
          Your API keys
        </h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input type="checkbox" checked={ownerOnly} disabled={busy} onChange={(e) => setOwnerOnly(e.target.checked)} />
            Reads only my own learning summary
          </label>
          <Button onClick={mint} disabled={busy}>
            {busy ? "Working…" : "Create key"}
          </Button>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded bg-red-50 border border-red-200 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {minted && (
        <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Copy this key now — it won&rsquo;t be shown again.
          </p>
          <CopyBox label={`Key — ${minted.name}`} value={minted.plaintextKey} />
          <CopyBox label="Try it" value={curlCmd} />
          <p className="mt-2 text-xs text-amber-900">
            Full operation list:{" "}
            <a className="underline" href={specUrl} target="_blank" rel="noreferrer">
              {specUrl}
            </a>
          </p>
        </div>
      )}

      <div className="mt-5 overflow-x-auto">
        <ResponsiveTable
          data={keys}
          columns={columns}
          rowKey={(k) => k.apiKeyId}
          collapseAt="md"
          emptyMessage="No keys yet. Create one to call the LMS API from your own scripts or tools."
        />
      </div>
    </div>
  );
}
