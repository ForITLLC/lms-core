import { z } from "zod";
import { insertPersonnelLink, isAlreadySuperseded, type PersonnelLink } from "@/lib/db/personnel-links";

// Who a learner is at the operator (docs/plans/2026-10-29-training-records-design.md
// §3.3, slice R2a): duty position, employee number, hire and leave dates and
// a for-CrewRecords reference, from a date. A new position is a new row from
// a later date; a row entered wrongly is superseded by one that names it and
// says why. The LMS keeps no licence or medical details (design §3.6).

export const DUTY_POSITIONS = ["pilot", "flight_attendant", "dispatcher", "dg", "ame", "other"] as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (value: string) => DATE_ONLY.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const day = z.string().trim().refine(realDate, "Give the date as YYYY-MM-DD.");
const optionalDay = z.preprocess(blankToUndefined, day.optional());

export const PersonnelBody = z
  .object({
    dutyPosition: z.enum(DUTY_POSITIONS),
    employeeNo: optionalText(64),
    hireDate: optionalDay,
    leaveDate: optionalDay,
    effectiveFrom: day,
    crewRecordsPersonRef: optionalText(128),
    supersedesLinkId: z.preprocess(blankToUndefined, z.string().uuid().optional()),
    reason: optionalText(1000),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.hireDate && b.leaveDate && b.leaveDate < b.hireDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["leaveDate"], message: "The leave date is before the hire date." });
    }
    if (b.supersedesLinkId && !b.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Say why the earlier row was wrong." });
    }
  });

export type PersonnelInput = z.output<typeof PersonnelBody>;

// The row in force on `today` (YYYY-MM-DD): the latest one from that date or
// before that no later row supersedes.
export function currentLink(links: readonly PersonnelLink[], today: string): PersonnelLink | null {
  const superseded = new Set(links.map((l) => l.supersedesLinkId).filter((id): id is string => id !== null));
  let best: PersonnelLink | null = null;
  for (const link of links) {
    if (superseded.has(link.personnelLinkId) || link.effectiveFrom > today) continue;
    if (!best || link.effectiveFrom > best.effectiveFrom
      || (link.effectiveFrom === best.effectiveFrom && link.recordedAt.getTime() > best.recordedAt.getTime())) best = link;
  }
  return best;
}

export type PersonnelOutcome =
  | { outcome: "added"; link: PersonnelLink }
  | { outcome: "not_found" }
  | { outcome: "already_superseded" };

export async function recordPersonnelLink(tenantId: string, learnerId: string, body: PersonnelInput, recordedBy: string): Promise<PersonnelOutcome> {
  try {
    const link = await insertPersonnelLink(tenantId, learnerId, {
      dutyPosition: body.dutyPosition,
      employeeNo: body.employeeNo ?? null,
      hireDate: body.hireDate ?? null,
      leaveDate: body.leaveDate ?? null,
      effectiveFrom: body.effectiveFrom,
      crewRecordsPersonRef: body.crewRecordsPersonRef ?? null,
      supersedesLinkId: body.supersedesLinkId ?? null,
      reason: body.reason ?? null,
    }, recordedBy);
    return link ? { outcome: "added", link } : { outcome: "not_found" };
  } catch (error) {
    if (isAlreadySuperseded(error)) return { outcome: "already_superseded" };
    throw error;
  }
}
