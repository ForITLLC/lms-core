"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";

export interface CatalogCourse {
  CourseId: string;
  Title: string;
  Slug: string;
  Description: string | null;
  Status: string;
  Category: string | null;
  Tags: string[];
}

interface Props {
  courses: CatalogCourse[];
}

// Client-side filter only. The catalog is the published-course list for a
// single tenant — small N (low hundreds even at scale) so in-memory search
// stays under a millisecond and avoids round-tripping the typeahead.
export default function CourseCatalog({ courses }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of courses) if (c.Category) set.add(c.Category);
    return Array.from(set).sort();
  }, [courses]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of courses) for (const t of c.Tags) set.add(t);
    return Array.from(set).sort();
  }, [courses]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return courses.filter((c) => {
      if (category && c.Category !== category) return false;
      if (activeTag && !c.Tags.includes(activeTag)) return false;
      if (!q) return true;
      if (c.Title.toLowerCase().includes(q)) return true;
      if (c.Description && c.Description.toLowerCase().includes(q)) return true;
      if (c.Tags.some((t) => t.includes(q))) return true;
      return false;
    });
  }, [courses, query, category, activeTag]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search courses, tags, or keywords…"
          className="w-full md:max-w-md rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--brand-primary)]"
          aria-label="Search course catalog"
        />
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <CategoryChip label="All" active={category === null} onClick={() => setCategory(null)} />
            {categories.map((cat) => (
              <CategoryChip
                key={cat}
                label={cat}
                active={category === cat}
                onClick={() => setCategory(category === cat ? null : cat)}
              />
            ))}
          </div>
        )}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((t) => (
            <TagChip
              key={t}
              label={t}
              active={activeTag === t}
              onClick={() => setActiveTag(activeTag === t ? null : t)}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-gray-500">
        Showing {filtered.length} of {courses.length} course{courses.length === 1 ? "" : "s"}
      </p>

      {filtered.length === 0 ? (
        <Card variant="white" padding="lg" className="text-center">
          <p className="text-sm text-gray-600">
            No courses match your filters. Try clearing the search or tags.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((c) => (
            <Link key={c.CourseId} href={`/learn/${c.Slug}`} prefetch={false}>
              <Card variant="white" padding="md" className="h-full hover:shadow-md transition-shadow">
                <h2 className="font-semibold mb-2" style={{ color: "var(--brand-primary)" }}>
                  {c.Title}
                </h2>
                {c.Description && (
                  <p className="text-sm text-gray-600 line-clamp-3">{c.Description}</p>
                )}
                {c.Tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {c.Tags.slice(0, 5).map((t) => (
                      <span
                        key={t}
                        className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-4 text-xs text-gray-400 uppercase tracking-wide">
                  {c.Category ?? c.Status}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-[color:var(--brand-primary)] text-white"
          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
      }`}
    >
      {label}
    </button>
  );
}

function TagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "bg-[color:var(--brand-primary)] text-white"
          : "bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200"
      }`}
    >
      #{label}
    </button>
  );
}
