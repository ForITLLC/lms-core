import { queryOne } from "@/lib/db";

// A person who leaves the operator is marked 'left' and never deleted
// (docs/plans/2026-10-29-training-records-design.md §3.2, slice R1b). Their
// training records point at the learner row, so the row and their history
// stay. A left learner gets no new assignment (lib/db/assignments.ts) and no
// overdue reminder, daily digest or learning summary: each of those reads
// only learners with Status = 'active'. Marking them 'active' again undoes it.
// Only 'active' and 'left' move here; a row with any other status, such as a
// service account set 'inactive', is left alone. The change and its audit
// event are one transaction, so no status moves without a record of who moved
// it and from what.

export const LEARNER_STATUSES = ["active", "left"] as const;
export type LearnerStatus = (typeof LEARNER_STATUSES)[number];

export type LearnerStatusResult =
  | { outcome: "changed" | "unchanged"; status: LearnerStatus; was: LearnerStatus }
  | { outcome: "not_found" }
  | { outcome: "other_status"; status: string };

export const SET_LEARNER_STATUS = `
SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRANSACTION;
DECLARE @was NVARCHAR(32), @changed BIT = 0;
SELECT @was = Status
  FROM lms.Learner WITH (UPDLOCK, HOLDLOCK)
 WHERE TenantId = @tenantId AND LearnerId = @learnerId;
IF @was IN (N'active', N'left') AND @was <> @status
BEGIN
  UPDATE lms.Learner SET Status = @status WHERE TenantId = @tenantId AND LearnerId = @learnerId;
  INSERT INTO lms.AuditEvent (EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson)
  VALUES (NEWID(), @tenantId, @by, 'learner.status', 'learner', LOWER(CONVERT(varchar(36), @learnerId)),
          CONCAT('{"status":"', @status, '","was":"', @was, '"}'));
  SET @changed = 1;
END;
COMMIT TRANSACTION;
SELECT @was AS Was, @changed AS Changed;
`;

export async function setLearnerStatus(
  tenantId: string,
  learnerId: string,
  status: LearnerStatus,
  by: string,
): Promise<LearnerStatusResult> {
  const row = await queryOne<{ Was: string | null; Changed: boolean | number }>(SET_LEARNER_STATUS, { tenantId, learnerId, status, by });
  const was = row?.Was ?? null;
  if (was === null) return { outcome: "not_found" };
  const known = LEARNER_STATUSES.find((s) => s === was.toLowerCase());
  if (!known) return { outcome: "other_status", status: was };
  const changed = row?.Changed === true || row?.Changed === 1;
  return { outcome: changed ? "changed" : "unchanged", status, was: known };
}
