import type { ManualKind } from "@/lib/records/manual";

// Who may do what with training records. Every records route and page asks
// here and nowhere else. Card d3e16430 (decided "add both", 2026-10-29) adds
// two roles inside one operator, neither of them staff (lib/auth/roles.ts):
// an instructor enters training they ran or assessed, marks written exam
// answers and reads the operator's records; a training manager does all of
// that for every kind of record, and also corrects records, imports paper
// records and marks a learner left. Personnel rows, settings, branding,
// connections and roles stay the admin's. No role edits or deletes a record.

type MaybeRole = string | null | undefined;

const oneOf = (role: MaybeRole, ...allowed: string[]) => typeof role === "string" && allowed.includes(role);

// A tenant's records: its learners, their records and each record's line.
export function canReadRecords(role: MaybeRole): boolean {
  return oneOf(role, "admin", "training_manager", "instructor");
}

// Entering a record by hand, of a kind the role may write (writableKinds).
export function canWriteRecords(role: MaybeRole): boolean {
  return oneOf(role, "admin", "training_manager", "instructor");
}

// Correcting or voiding a record.
export function canCorrectRecords(role: MaybeRole): boolean {
  return oneOf(role, "admin", "training_manager");
}

// Importing paper records from CSV, its dry run included.
export function canImportRecords(role: MaybeRole): boolean {
  return oneOf(role, "admin", "training_manager");
}

// Reading and adding a learner's personnel rows.
export function canManagePersonnel(role: MaybeRole): boolean {
  return oneOf(role, "admin");
}

// Marking a learner left or active again.
export function canMarkLeft(role: MaybeRole): boolean {
  return oneOf(role, "admin", "training_manager");
}

// Marking written exam answers: the marking queue (/author/grading) and
// POST /api/author/grades, and no other author page or route.
export function canMarkExams(role: MaybeRole): boolean {
  return oneOf(role, "admin", "author", "instructor", "training_manager");
}

// Giving or taking away the instructor and training-manager roles.
export function canGrantRecordsRoles(role: MaybeRole): boolean {
  return oneOf(role, "admin");
}

// The roles /api/admin/records/roles sets. Admin and author come from the
// HR-admin group, a seed or tenant bootstrap, never from there.
export const RECORDS_ROLES = ["learner", "instructor", "training_manager"] as const;
export type RecordsRole = (typeof RECORDS_ROLES)[number];

// Every kind of record entered by hand (MANUAL_KINDS in lib/records/manual.ts;
// records-permissions.test.ts holds the two lists equal).
const EVERY_KIND: readonly ManualKind[] = ["check", "ojt", "line_indoc", "familiarization", "monitor", "qualification", "vendor_training", "acp_ppc"];
// Training an instructor runs or assesses. A qualification or an ACP PPC
// reference is the operator's to record.
const INSTRUCTOR_KINDS: readonly ManualKind[] = ["check", "ojt", "line_indoc", "familiarization", "monitor", "vendor_training"];

export function writableKinds(role: MaybeRole): readonly ManualKind[] {
  if (oneOf(role, "admin", "training_manager")) return EVERY_KIND;
  if (oneOf(role, "instructor")) return INSTRUCTOR_KINDS;
  return [];
}

export function canWriteRecordKind(role: MaybeRole, kind: string): boolean {
  return canWriteRecords(role) && writableKinds(role).some((k) => k === kind);
}

export interface RecordsRights {
  write: boolean;
  correct: boolean;
  import: boolean;
  personnel: boolean;
  markLeft: boolean;
  kinds: readonly ManualKind[];
  // An instructor records training they ran or assessed, so the entry form
  // starts with their own name as the instructor.
  ownTraining: boolean;
}

export function recordsRights(role: MaybeRole): RecordsRights {
  return {
    write: canWriteRecords(role),
    correct: canCorrectRecords(role),
    import: canImportRecords(role),
    personnel: canManagePersonnel(role),
    markLeft: canMarkLeft(role),
    kinds: canWriteRecords(role) ? writableKinds(role) : [],
    ownTraining: oneOf(role, "instructor"),
  };
}
