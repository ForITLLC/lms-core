"use client";

import { useState } from "react";

interface AvatarProps {
  oid: string | undefined;
  name: string;
  size?: number;
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

// Round directory avatar. Pulls the AAD profile photo through the
// /api/users/[oid]/avatar proxy when an oid is known; on a missing oid or any
// image error (the proxy 404s when the user has no photo) it falls back to a
// neutral-gray initials circle. Background is intentionally gray, not a brand
// colour — this is a white-label app.
export default function Avatar({ oid, name, size = 32 }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(oid) && !failed;

  const dimension = { width: size, height: size };

  if (showImage) {
    return (
      <img
        src={`/api/users/${encodeURIComponent(oid as string)}/avatar`}
        alt={name}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="rounded-full object-cover flex-shrink-0 bg-gray-200"
        style={dimension}
      />
    );
  }

  return (
    <span
      aria-label={name}
      title={name}
      className="rounded-full flex items-center justify-center flex-shrink-0 bg-gray-300 text-gray-700 font-semibold select-none"
      style={{ ...dimension, fontSize: Math.round(size * 0.4) }}
    >
      {initials(name)}
    </span>
  );
}
