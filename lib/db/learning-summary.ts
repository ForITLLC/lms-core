import { execute, query, queryOne } from "@/lib/db";
import { lastCompletedAt } from "@/lib/db/completion";
import { entitledToTenant, seatHeldBy } from "@/lib/db/course-scope";
import { isServiceAccount } from "@/lib/service-account";
import { nextDueForLearner, type ScheduleKind } from "@/lib/db/schedule";
import { emptySummarySection, normalizeSummarySection, summaryWindow, type LearningSummary, type SummaryItem, type SummarySection } from "@/lib/learning-summary";

interface Learner { LearnerId: string; Email: string; DisplayName: string }
interface Identity { AppUserId: string; Role: string }
interface Course { CourseId: string; Slug: string; Title: string }
interface Assignment extends Course { AssignmentId: string; LearnerId: string; AssignedAt: Date; DueDate: Date | null; CompletedAt: Date | null }
interface Completion extends Course { LearnerId: string; CompletedAt: Date }
interface Mandatory extends Course { LearnerId: string; LearnerStart: Date | null; ScheduleKind: ScheduleKind; RecurrenceMonths: number | null; CertIssuedAt: Date | null; CertExpiresAt: Date | null }
interface AccessRow { LearnerId: string | null; Email: string | null; DisplayName: string | null; IsAdmin: boolean }
export interface SummaryRecipient { email: string; displayName: string }

const emailKey = (email: string) => email.trim().toLowerCase();
const idKey = (id: string) => id.toLowerCase();
const catalogue = `(c.IsCatalog = 1
  AND EXISTS (SELECT 1 FROM lms.Tenant publisher WHERE publisher.TenantId = c.TenantId AND publisher.Slug = @foritSlug)
  AND EXISTS (SELECT 1 FROM lms.CatalogSubscription subscription WHERE subscription.TenantId = @tenantId AND subscription.CourseId = c.CourseId))`;
// A course the tenant sees as of @now, and the narrower set one learner can
// take: an entitled course counts for a learner only while they hold its seat.
const visibility = `(c.TenantId = @tenantId OR ${catalogue}
  OR ${entitledToTenant("@now")})`;
const learnerVisibility = (learner: string) => `(c.TenantId = @tenantId OR ${catalogue}
  OR ${seatHeldBy(learner, "@now")})`;

export async function getSummaryIdentity(tenantId: string, email: string): Promise<Identity | null> {
  return queryOne<Identity>(`SELECT CONVERT(varchar(64), AppUserId) AS AppUserId, Role
    FROM lms.AppUser WHERE TenantId = @tenantId AND LOWER(Email) = @email`, { tenantId, email: emailKey(email) });
}

function item(learner: Learner, course: Course, category: string, due: Date | null = null, occurred: Date | null = null): SummaryItem {
  return { id: `${category}:${learner.LearnerId}:${course.CourseId}`.toLowerCase(),
    course_id: course.CourseId, course_slug: course.Slug, course_title: course.Title,
    learner_id: learner.LearnerId, learner_name: learner.DisplayName, learner_email: learner.Email,
    due_date: due ? new Date(due).toISOString() : null, occurred_at: occurred ? new Date(occurred).toISOString() : null };
}

export async function getLearningSummary(tenantId: string, email: string, options: { now?: Date; windowStart?: Date } = {}): Promise<LearningSummary> {
  return (await getSummaryDeliverySnapshot(tenantId, email, options)).summary;
}

export async function getSummaryDeliverySnapshot(tenantId: string, email: string, options: { now?: Date; windowStart?: Date } = {}): Promise<{ eligible: boolean; summary: LearningSummary }> {
  const { now, start } = summaryWindow(options.now ?? new Date(), options.windowStart);
  const params = { tenantId, foritSlug: process.env.FORIT_TENANT_SLUG ?? "forit", start, now };
  const [courses, mandatory, assignments, completions] = await Promise.all([
    query<Course>(`SELECT CONVERT(varchar(64), c.CourseId) AS CourseId, c.Slug, c.Title
      FROM lms.Course c WHERE c.Status = 'published' AND ${visibility}`, params),
    query<Mandatory>(`WITH mandatory_for_tenant AS (
      SELECT DISTINCT c.CourseId, c.Slug, c.Title, c.ScheduleKind, c.RecurrenceMonths
      FROM lms.Course c
      JOIN lms.CurriculumCourse cc ON cc.CourseId = c.CourseId AND cc.IsMandatory = 1
      JOIN lms.Curriculum cu ON cu.CurriculumId = cc.CurriculumId AND cu.TenantId = @tenantId
      WHERE c.Status = 'published' AND ${visibility}
    ) SELECT CONVERT(varchar(64), l.LearnerId) AS LearnerId, l.CreatedAt AS LearnerStart,
        CONVERT(varchar(64), m.CourseId) AS CourseId, m.Slug, m.Title, m.ScheduleKind, m.RecurrenceMonths,
        cert.IssuedAt AS CertIssuedAt, cert.ExpiresAt AS CertExpiresAt
      FROM lms.Learner l CROSS JOIN mandatory_for_tenant m
      JOIN lms.Course c ON c.CourseId = m.CourseId AND ${learnerVisibility("l.LearnerId")}
      OUTER APPLY (SELECT TOP 1 certificate.IssuedAt, certificate.ExpiresAt
        FROM lms.Certificate certificate
        WHERE certificate.LearnerId = l.LearnerId AND certificate.CourseId = m.CourseId
          AND certificate.TenantId = @tenantId AND certificate.RevokedAt IS NULL AND certificate.IssuedAt <= @now
        ORDER BY certificate.IssuedAt DESC, certificate.CertificateId DESC) cert
      WHERE l.TenantId = @tenantId AND l.Status = 'active'`, params),
    query<Assignment>(`SELECT CONVERT(varchar(64), a.AssignmentId) AS AssignmentId,
      CONVERT(varchar(64), a.LearnerId) AS LearnerId, CONVERT(varchar(64), c.CourseId) AS CourseId,
      c.Slug, c.Title, a.AssignedAt, a.DueDate,
      ${lastCompletedAt("e")} AS CompletedAt
      FROM lms.CourseAssignment a
      JOIN lms.Learner l ON l.LearnerId = a.LearnerId AND l.TenantId = @tenantId AND l.Status = 'active'
      JOIN lms.Course c ON c.CourseId = a.CourseId AND c.Status = 'published' AND ${learnerVisibility("a.LearnerId")}
      LEFT JOIN lms.Enrollment e ON e.LearnerId = a.LearnerId AND e.CourseId = a.CourseId AND e.TenantId = @tenantId
      WHERE a.TenantId = @tenantId AND a.Status = 'active' AND a.AssignedAt <= @now`, params),
    query<Completion>(`SELECT CONVERT(varchar(64), e.LearnerId) AS LearnerId,
      CONVERT(varchar(64), c.CourseId) AS CourseId, c.Slug, c.Title, e.CompletedAt
      FROM lms.Enrollment e
      JOIN lms.Learner l ON l.LearnerId = e.LearnerId AND l.TenantId = @tenantId AND l.Status = 'active'
      JOIN lms.Course c ON c.CourseId = e.CourseId AND c.Status = 'published' AND ${learnerVisibility("e.LearnerId")}
      WHERE e.TenantId = @tenantId AND e.CompletedAt > @start AND e.CompletedAt <= @now`, params),
  ]);
  // Scope is resolved after collecting data, in one live-role/live-mapping statement.
  // No earlier role snapshot can restore access revoked while the data queries ran.
  const access = await query<AccessRow>(`SELECT CONVERT(varchar(64), l.LearnerId) AS LearnerId, l.Email, l.DisplayName,
    CAST(CASE WHEN actor.Role = 'admin' THEN 1 ELSE 0 END AS bit) AS IsAdmin
    FROM (SELECT @email AS Email) recipient
    LEFT JOIN lms.AppUser actor ON actor.TenantId = @tenantId AND LOWER(actor.Email) = recipient.Email
    LEFT JOIN lms.Learner l ON l.TenantId = @tenantId AND l.Status = 'active' AND (
      LOWER(l.Email) = recipient.Email OR actor.Role = 'admin' OR EXISTS (
        SELECT 1 FROM lms.LearnerManager mapping
        WHERE mapping.TenantId = @tenantId AND mapping.ManagerAppUserId = actor.AppUserId AND mapping.LearnerId = l.LearnerId))`,
    { tenantId, email: emailKey(email) });
  const admin = access.some(row => row.IsAdmin);
  const scopedLearners: Learner[] = access.flatMap(row => row.LearnerId && row.Email && !isServiceAccount(row.Email)
    ? [{ LearnerId: row.LearnerId, Email: row.Email, DisplayName: row.DisplayName ?? row.Email }] : []);
  const visible = new Set(courses.map(course => idKey(course.CourseId)));
  const personal = emptySummarySection();
  const team = emptySummarySection();
  let hasTeam = admin;
  const append = (section: SummarySection, source: SummarySection) => {
    for (const category of ["due", "overdue", "completions", "new_assignments"] as const) section[category].push(...source[category]);
  };
  for (const learner of scopedLearners) {
    const section = emptySummarySection();
    const learnerId = idKey(learner.LearnerId);
    for (const row of mandatory.filter(row => idKey(row.LearnerId) === learnerId && visible.has(idKey(row.CourseId)))) {
      const learnerStart = row.LearnerStart ? new Date(row.LearnerStart) : null;
      const issued = row.CertIssuedAt ? new Date(row.CertIssuedAt) : null;
      // A never-issued first deadline is fixed when training starts; reading it
      // after Jan 31 must not roll that missed deadline into another year.
      // Issued certificate expiry stays authoritative if the course schedule changes.
      const due = row.CertExpiresAt ? new Date(row.CertExpiresAt) : nextDueForLearner(row.ScheduleKind, row.RecurrenceMonths,
        learnerStart, issued, issued ? now : learnerStart ?? now);
      if (due) {
        const dueDay = due.toISOString().slice(0, 10);
        if (dueDay < now.toISOString().slice(0, 10)) section.overdue.push(item(learner, row, "overdue", due));
        else if (dueDay <= new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)) section.due.push(item(learner, row, "due", due));
      } else if (row.ScheduleKind === null && row.CertIssuedAt === null) {
        section.overdue.push(item(learner, row, "overdue"));
      }
    }
    for (const row of assignments.filter(row => idKey(row.LearnerId) === learnerId)) {
      if (new Date(row.AssignedAt) > start) section.new_assignments.push(item(learner, row, "assignment", row.DueDate, row.AssignedAt));
      if (!row.CompletedAt && row.DueDate) {
        const due = new Date(row.DueDate);
        if (due.toISOString().slice(0, 10) < now.toISOString().slice(0, 10)) section.overdue.push(item(learner, row, "overdue", due));
        else if (due.toISOString().slice(0, 10) <= new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)) section.due.push(item(learner, row, "due", due));
      }
    }
    for (const row of completions.filter(row => idKey(row.LearnerId) === learnerId)) section.completions.push(item(learner, row, "completion", null, row.CompletedAt));
    if (emailKey(learner.Email) === emailKey(email)) append(personal, section);
    else { hasTeam = true; append(team, section); }
  }
  return { eligible: !isServiceAccount(email) && (admin || scopedLearners.length > 0),
    summary: { generated_at: now.toISOString(), window_start: start.toISOString(), personal: normalizeSummarySection(personal),
      team: hasTeam ? { ...normalizeSummarySection(team), scope: admin ? "admin" : "manager" } : null } };
}

export async function listSummaryRecipients(tenantId: string): Promise<SummaryRecipient[]> {
  const rows = await query<{ Email: string; DisplayName: string }>(`SELECT Email, DisplayName FROM lms.Learner WHERE TenantId = @tenantId AND Status = 'active'
    UNION SELECT u.Email, u.DisplayName FROM lms.AppUser u WHERE u.TenantId = @tenantId
      AND NOT EXISTS (SELECT 1 FROM lms.Learner gone WHERE gone.TenantId = @tenantId AND gone.Email = u.Email AND gone.Status = 'left')
      AND (u.Role = 'admin' OR EXISTS (
      SELECT 1 FROM lms.LearnerManager mapping JOIN lms.Learner l ON l.LearnerId = mapping.LearnerId AND l.TenantId = @tenantId AND l.Status = 'active'
      WHERE mapping.TenantId = @tenantId AND mapping.ManagerAppUserId = u.AppUserId))`, { tenantId });
  const unique = new Map<string, SummaryRecipient>();
  for (const row of rows) if (!isServiceAccount(row.Email)) unique.set(emailKey(row.Email), { email: emailKey(row.Email), displayName: row.DisplayName });
  return [...unique.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export interface ManagerMapping { manager_id: string; manager_email: string; manager_name: string; learner_id: string; learner_email: string; learner_name: string }
export async function listSummaryManagers(tenantId: string): Promise<ManagerMapping[]> {
  return query<ManagerMapping>(`SELECT CONVERT(varchar(64), manager.AppUserId) AS manager_id, manager.Email AS manager_email,
    manager.DisplayName AS manager_name, CONVERT(varchar(64), learner.LearnerId) AS learner_id,
    learner.Email AS learner_email, learner.DisplayName AS learner_name
    FROM lms.LearnerManager mapping
    JOIN lms.AppUser manager ON manager.AppUserId = mapping.ManagerAppUserId AND manager.TenantId = @tenantId
    JOIN lms.Learner learner ON learner.LearnerId = mapping.LearnerId AND learner.TenantId = @tenantId
    WHERE mapping.TenantId = @tenantId ORDER BY manager.Email, learner.Email`, { tenantId });
}

export async function setSummaryManager(tenantId: string, managerEmail: string, learnerEmail: string, enabled: boolean, changedBy: string): Promise<boolean> {
  const row = await queryOne<{ Applied: number }>(`DECLARE @manager UNIQUEIDENTIFIER = (SELECT AppUserId FROM lms.AppUser WHERE TenantId = @tenantId AND LOWER(Email) = @managerEmail);
    DECLARE @learner UNIQUEIDENTIFIER = (SELECT LearnerId FROM lms.Learner WHERE TenantId = @tenantId AND LOWER(Email) = @learnerEmail);
    IF @manager IS NOT NULL AND @learner IS NOT NULL AND EXISTS (
      SELECT 1 FROM lms.AppUser administrator WHERE administrator.TenantId = @tenantId
        AND LOWER(administrator.Email) = @changedBy AND administrator.Role = 'admin')
    BEGIN
      IF @enabled = 0 DELETE FROM lms.LearnerManager WHERE TenantId = @tenantId AND ManagerAppUserId = @manager AND LearnerId = @learner;
      ELSE MERGE lms.LearnerManager WITH (HOLDLOCK) AS target
        USING (SELECT @tenantId AS TenantId, @manager AS ManagerAppUserId, @learner AS LearnerId) AS source
        ON target.TenantId = source.TenantId AND target.ManagerAppUserId = source.ManagerAppUserId AND target.LearnerId = source.LearnerId
        WHEN NOT MATCHED THEN INSERT (TenantId, ManagerAppUserId, LearnerId, CreatedBy) VALUES (@tenantId, @manager, @learner, @changedBy);
      SELECT 1 AS Applied;
    END`, { tenantId, managerEmail: emailKey(managerEmail), learnerEmail: emailKey(learnerEmail), enabled, changedBy: emailKey(changedBy) });
  return row?.Applied === 1;
}

export async function previousDigestWindowEnd(tenantId: string, email: string, now: Date): Promise<Date | undefined> {
  const row = await queryOne<{ WindowEnd: Date }>(`SELECT MAX(WindowEnd) AS WindowEnd FROM lms.DigestDelivery
    WHERE TenantId = @tenantId AND RecipientEmail = @email AND Status = 'sent' AND WindowEnd <= @now`, { tenantId, email: emailKey(email), now });
  return row?.WindowEnd ? new Date(row.WindowEnd) : undefined;
}

export async function claimSummaryDelivery(tenantId: string, email: string, now: Date, windowStart: Date): Promise<string | null> {
  const row = await queryOne<{ ClaimId: string }>(`DECLARE @claimed TABLE (ClaimId UNIQUEIDENTIFIER);
    BEGIN TRY
      INSERT INTO lms.DigestDelivery (TenantId, RecipientEmail, DigestDay, Status, WindowStart, WindowEnd)
      OUTPUT inserted.ClaimId INTO @claimed
      VALUES (@tenantId, @email, CONVERT(date, @now), 'claimed', @windowStart, @now);
    END TRY BEGIN CATCH
      IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;
    END CATCH;
    SELECT CONVERT(varchar(64), ClaimId) AS ClaimId FROM @claimed;`, { tenantId, email: emailKey(email), now, windowStart });
  return row?.ClaimId ?? null;
}

export async function finishSummaryDelivery(tenantId: string, claimId: string, status: "sent" | "uncertain", error: string | null = null): Promise<void> {
  const affected = await execute(`UPDATE lms.DigestDelivery SET Status = @status,
    SentAt = CASE WHEN @status = 'sent' THEN SYSUTCDATETIME() ELSE NULL END, Error = @error
    WHERE TenantId = @tenantId AND ClaimId = @claimId AND Status = 'claimed'`, { tenantId, claimId, status, error: error?.slice(0, 2048) ?? null });
  if (affected !== 1) throw new Error("Digest delivery claim could not be finalized");
}
