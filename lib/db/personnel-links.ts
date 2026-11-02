import { randomUUID } from "node:crypto";
import { execute, query } from "@/lib/db";

// lms.PersonnelLink (migration 0036; docs/plans/2026-10-29-training-records-design.md
// §3.3, slice R2a): a learner's duty position, employee number, hire and
// leave dates and for-CrewRecords reference, each row in force from its
// EffectiveFrom. Every statement names the tenant. Nothing here updates or
// deletes a row: the table refuses both. Dates travel as YYYY-MM-DD text,
// which SQL Server reads as a DATE whatever the session's language.

export interface PersonnelLinkInput {
  dutyPosition: string;
  employeeNo: string | null;
  hireDate: string | null;
  leaveDate: string | null;
  effectiveFrom: string;
  crewRecordsPersonRef: string | null;
  supersedesLinkId: string | null;
  reason: string | null;
}

export interface PersonnelLink extends PersonnelLinkInput {
  personnelLinkId: string;
  learnerId: string;
  recordedBy: string;
  recordedAt: Date;
}

const lower = (id: string | null) => (id === null ? null : id.toLowerCase());

// Adds the row for the tenant's learner. Null when the learner, or the row it
// supersedes, isn't that tenant's learner's.
export async function insertPersonnelLink(
  tenantId: string,
  learnerId: string,
  input: PersonnelLinkInput,
  recordedBy: string,
  now: () => Date = () => new Date(),
): Promise<PersonnelLink | null> {
  const row: PersonnelLink = {
    ...input,
    supersedesLinkId: lower(input.supersedesLinkId),
    personnelLinkId: randomUUID(),
    learnerId: learnerId.toLowerCase(),
    recordedBy,
    recordedAt: now(),
  };
  const added = await execute(
    `INSERT INTO lms.PersonnelLink (PersonnelLinkId, TenantId, LearnerId, DutyPosition, EmployeeNo, HireDate, LeaveDate,
                                    EffectiveFrom, CrewRecordsPersonRef, SupersedesLinkId, Reason, RecordedBy, RecordedAt)
     SELECT @personnelLinkId, @tenantId, @learnerId, @dutyPosition, @employeeNo, @hireDate, @leaveDate,
            @effectiveFrom, @crewRecordsPersonRef, @supersedesLinkId, @reason, @recordedBy, @recordedAt
      WHERE EXISTS (SELECT 1 FROM lms.Learner WHERE LearnerId = @learnerId AND TenantId = @tenantId)
        AND (@supersedesLinkId IS NULL
             OR EXISTS (SELECT 1 FROM lms.PersonnelLink WHERE PersonnelLinkId = @supersedesLinkId AND TenantId = @tenantId AND LearnerId = @learnerId))`,
    { ...row, tenantId },
  );
  return added === 1 ? row : null;
}

// A second row superseding one row breaks UX_lms_PersonnelLink_Supersedes.
export function isAlreadySuperseded(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UX_lms_PersonnelLink_Supersedes");
}

interface LinkRow {
  PersonnelLinkId: string;
  LearnerId: string;
  DutyPosition: string;
  EmployeeNo: string | null;
  HireDate: string | null;
  LeaveDate: string | null;
  EffectiveFrom: string;
  CrewRecordsPersonRef: string | null;
  SupersedesLinkId: string | null;
  Reason: string | null;
  RecordedBy: string;
  RecordedAt: Date;
}

// Every row of the tenant's learner, oldest first.
export async function listPersonnelLinks(tenantId: string, learnerId: string): Promise<PersonnelLink[]> {
  const rows = await query<LinkRow>(
    `SELECT CONVERT(varchar(36), PersonnelLinkId) AS PersonnelLinkId, CONVERT(varchar(36), LearnerId) AS LearnerId,
            DutyPosition, EmployeeNo, CONVERT(varchar(10), HireDate, 23) AS HireDate, CONVERT(varchar(10), LeaveDate, 23) AS LeaveDate,
            CONVERT(varchar(10), EffectiveFrom, 23) AS EffectiveFrom, CrewRecordsPersonRef,
            CONVERT(varchar(36), SupersedesLinkId) AS SupersedesLinkId, Reason, RecordedBy, RecordedAt
       FROM lms.PersonnelLink
      WHERE TenantId = @tenantId AND LearnerId = @learnerId
      ORDER BY EffectiveFrom, RecordedAt`,
    { tenantId, learnerId },
  );
  return rows.map((r) => ({
    personnelLinkId: r.PersonnelLinkId.toLowerCase(),
    learnerId: r.LearnerId.toLowerCase(),
    dutyPosition: r.DutyPosition,
    employeeNo: r.EmployeeNo,
    hireDate: r.HireDate,
    leaveDate: r.LeaveDate,
    effectiveFrom: r.EffectiveFrom,
    crewRecordsPersonRef: r.CrewRecordsPersonRef,
    supersedesLinkId: lower(r.SupersedesLinkId),
    reason: r.Reason,
    recordedBy: r.RecordedBy,
    recordedAt: new Date(r.RecordedAt),
  }));
}
