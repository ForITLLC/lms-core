import { randomBytes } from "node:crypto";
import { queryOne } from "@/lib/db";
import { ENTITLED_TO_TENANT } from "@/lib/db/course-scope";

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return slug || "course";
}

// A subscribed catalogue or entitled course's slug is taken too: an own course
// with the same slug would shadow it (lib/db/course-scope.ts).
export async function ensureUniqueSlug(tenantId: string, base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (true) {
    const row = await queryOne<{ CourseId: string }>(
      `SELECT TOP 1 c.CourseId FROM lms.Course c
        WHERE c.Slug = @slug
          AND (c.TenantId = @tenantId OR c.CourseId IN (
            SELECT CourseId FROM lms.CatalogSubscription WHERE TenantId = @tenantId
          ) OR ${ENTITLED_TO_TENANT})`,
      { tenantId, slug: candidate },
    );
    if (!row) return candidate;
    candidate = suffix <= 50 ? `${base}-${suffix}` : randomSlug(base);
    suffix += 1;
    if (suffix > 60) throw new Error(`Could not find unique slug from base '${base}'`);
  }
}

// A base taken fifty times over (every title in a script slugify can't read
// becomes "course") gets a random suffix instead.
export function randomSlug(base: string): string {
  return `${base.slice(0, 92)}-${randomBytes(4).toString("hex")}`;
}

export function isUniqueViolation(err: unknown): boolean {
  const number = (err as { number?: unknown } | null)?.number;
  return number === 2627 || number === 2601;
}
