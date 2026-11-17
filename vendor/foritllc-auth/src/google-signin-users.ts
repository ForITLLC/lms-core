// ============================================================================
// @foritllc/auth/google-signin-users - an app's list of Google sign-in users (0.21.0)
//
// forit-Auth admits a Google user into a workspace: the owner enrolls the exact
// verified issuer and Google `sub` from the refusal Auth recorded (Auth contract
// §6). Admission into the workspace grants no product. The app keeps a small
// list that maps each admitted person to one of its own roles, and this module
// is the one reader and matcher for that list, schema
// `forit.google-signin-users/v1`:
//
//   { "schema": "forit.google-signin-users/v1",
//     "workspaceId": "<Auth workspace id>",
//     "users": [ { "principalId": "<Auth principal id>",
//                  "issuer": "https://accounts.google.com",
//                  "subject": "<Google sub>",
//                  "role": "<one of the app's role codes>",
//                  "directoryRecordId": "<optional, display only>",
//                  "appRecordId": "<optional, the app's own record id>" } ] }
//
// What the list is matched on: Auth's verify answer (contract §4.1 and §4.2)
// returns `principalId`, `workspaceId`, `issuer` and `subject`, lower-cased ids
// included, and this module compares all four exactly. Auth may also return a
// verified `email` to an app that opted in (§4.4); Auth says never to match or
// authorize on it, so this list has no email field and refuses a row that has one.
//
// FAIL CLOSED FOR THE WHOLE LIST. A wrong schema, an unknown key anywhere, a
// missing key, one bad row, a role the app did not allow, an admin role, a
// duplicate or an empty list makes the list admit nobody. There is no default
// role, no skipping of a bad row and no raising of a role, and Google never
// grants an admin role. A refusal says why, for the app's log, and never
// carries a subject, an id or a key name from the data. Nothing throws on bad
// data or bad options.
//
// `directoryRecordId` and `appRecordId` ride along on the matched row for the
// app to use; neither is ever compared to the sign-in, so neither can admit.
//
// The matcher answers only for a list this module's validator returned in this
// process, so a hand-built object never admits anyone.
//
// No imports: the module loads without Next.js, for a Function App or a
// reviewed writer script.
// ============================================================================

/** The schema id a list must carry, exactly. */
export const GOOGLE_SIGNIN_USERS_SCHEMA = 'forit.google-signin-users/v1';

// The same value as GOOGLE_ISSUER in google-config.ts (a test pins the two).
const ISSUER = 'https://accounts.google.com';
// A stored value larger than this is refused before it is parsed.
const MAX_BYTES = 65_536;
// Auth returns principal and workspace ids as lower-case GUIDs. No trimming or
// case folding: another spelling is refused.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Google `sub`: up to 255 case-sensitive ASCII characters. Printable, no space.
const SUBJECT = /^[\x21-\x7e]{1,255}$/;
// Display only. No "@", so an address can never ride in this field.
const DIRECTORY_RECORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The app's own record id for the person: an opaque id of 1 to 128 letters,
// digits, "_" or "-", starting with a letter or digit, so a lower-case GUID and
// a Prisma cuid() both pass. No "@" and no ".", so an address can never ride in
// this field. Case is kept as given; duplicates compare the exact string.
const APP_RECORD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// An app role code, e.g. chiefPilot or flightOperationsView.
const ROLE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
// Any key that looks like an address field gets its own refusal in the log.
const MAIL_KEY = /mail/i;

const LIST_KEYS = ['schema', 'workspaceId', 'users'] as const;
const ROW_KEYS = ['principalId', 'issuer', 'subject', 'role', 'directoryRecordId', 'appRecordId'] as const;
const ROW_REQUIRED = ['principalId', 'issuer', 'subject', 'role'] as const;

/** One person on the list. Frozen. */
export interface GoogleSignInUser<R extends string = string> {
  /** forit-Auth's principal id (lower-case GUID). */
  readonly principalId: string;
  /** Google's issuer, exactly. */
  readonly issuer: 'https://accounts.google.com';
  /** Google's `sub`, compared exactly. */
  readonly subject: string;
  /** One of the role codes the app passed in `roles`. Never an admin role. */
  readonly role: R;
  /** Optional, display only (for example a for-Directory record id). Grants nothing. */
  readonly directoryRecordId?: string;
  /**
   * Optional: the app's own record id for this person, an opaque id of 1-128
   * letters, digits, "_" or "-" (never an email), kept exactly as given, for
   * the app to use once the person has matched. Never compared to the sign-in,
   * so it never decides a match or admits anyone.
   */
  readonly appRecordId?: string;
}

/** A list that passed every check. Frozen. */
export interface GoogleSignInUserList<R extends string = string> {
  readonly schema: typeof GOOGLE_SIGNIN_USERS_SCHEMA;
  /** forit-Auth's workspace id (lower-case GUID). A sign-in from any other workspace matches nobody. */
  readonly workspaceId: string;
  /** At least one row. */
  readonly users: readonly GoogleSignInUser<R>[];
}

/** What the app allows. There is no default. */
export interface GoogleSignInUsersOptions<R extends string = string> {
  /** The role codes a Google user may hold in this app, e.g. ['chiefPilot', 'flightOperationsView', 'viewer']. */
  readonly roles: readonly R[];
  /**
   * Role codes this app treats as admin-level. A row naming one is refused,
   * even if it is also in `roles`. A role named `admin`, in any case, is
   * always refused.
   */
  readonly adminRoles?: readonly string[];
}

/** Why a list admits nobody. */
export type GoogleSignInUsersRefusal =
  /** The options were missing or malformed (no `roles`, an empty or bad role code). */
  | 'BAD_OPTIONS'
  /** No value: undefined, null or an empty string. */
  | 'ABSENT'
  /** A string over 64 KiB. */
  | 'TOO_LARGE'
  /** A string that is not JSON. */
  | 'NOT_JSON'
  /** A string that is not exactly `canonicalGoogleSignInUsers` of what it holds (this also rules out duplicate JSON keys). */
  | 'NOT_CANONICAL'
  /** The value could not be read without an error (a throwing getter or proxy). */
  | 'UNREADABLE'
  /** The top level is not a plain object (a bare array is refused here). */
  | 'NOT_AN_OBJECT'
  /** A key that looks like an email field, at the top level or in a row (`row` says which). */
  | 'EMAIL_KEY'
  /** A key the schema does not have, at the top level or in a row (`row` says which). */
  | 'UNKNOWN_KEY'
  /** A required key is missing, at the top level or in a row (`row` says which). */
  | 'MISSING_KEY'
  | 'BAD_SCHEMA'
  | 'BAD_WORKSPACE'
  /** `users` is not an array. */
  | 'NOT_A_LIST'
  /** `users` is empty. */
  | 'EMPTY'
  /** A row that is not a plain object. */
  | 'BAD_ROW'
  | 'BAD_PRINCIPAL'
  | 'BAD_ISSUER'
  | 'BAD_SUBJECT'
  /** A role not in the app's `roles`. */
  | 'UNKNOWN_ROLE'
  /** `admin` (any case) or a role in the app's `adminRoles`. */
  | 'ADMIN_ROLE'
  | 'BAD_DIRECTORY_RECORD'
  /** An `appRecordId` that is not an opaque id of 1-128 letters, digits, `_` or `-`, starting with a letter or digit. */
  | 'BAD_APP_RECORD'
  | 'DUPLICATE_PRINCIPAL'
  /** The same issuer and subject on two rows. */
  | 'DUPLICATE_SUBJECT'
  | 'DUPLICATE_DIRECTORY_RECORD'
  | 'DUPLICATE_APP_RECORD';

/** The validator's answer. Frozen. On a refusal, `row` is the 0-based index of the row at fault. */
export type GoogleSignInUsersResult<R extends string = string> =
  | { readonly ok: true; readonly list: GoogleSignInUserList<R> }
  | { readonly ok: false; readonly reason: GoogleSignInUsersRefusal; readonly row?: number };

/** The four values the app gets from forit-Auth's verify for this request (a `GooglePrincipal` fits). */
export interface GoogleSignInIdentity {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly issuer: string;
  readonly subject: string;
}

// Provenance only: the lists this module's validator returned in this process.
const validated = new WeakSet<object>();

function refuse(reason: GoogleSignInUsersRefusal, row?: number): { ok: false; reason: GoogleSignInUsersRefusal; row?: number } {
  return Object.freeze(row === undefined ? { ok: false as const, reason } : { ok: false as const, reason, row });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The first key problem, in the order EMAIL_KEY, UNKNOWN_KEY, MISSING_KEY. */
function keyProblem(
  keys: readonly string[],
  allowed: readonly string[],
  required: readonly string[],
): 'EMAIL_KEY' | 'UNKNOWN_KEY' | 'MISSING_KEY' | null {
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.some((key) => MAIL_KEY.test(key))) return 'EMAIL_KEY';
  if (unknown.length > 0) return 'UNKNOWN_KEY';
  if (required.some((key) => !keys.includes(key))) return 'MISSING_KEY';
  return null;
}

function readOptions<R extends string>(
  options: GoogleSignInUsersOptions<R> | null | undefined,
): { roles: ReadonlySet<string>; admin: ReadonlySet<string> } | null {
  if (!options || typeof options !== 'object') return null;
  const { roles, adminRoles } = options;
  if (!Array.isArray(roles) || roles.length === 0) return null;
  if (!roles.every((role) => typeof role === 'string' && ROLE_CODE.test(role))) return null;
  if (adminRoles !== undefined) {
    if (!Array.isArray(adminRoles)) return null;
    if (!adminRoles.every((role) => typeof role === 'string' && ROLE_CODE.test(role))) return null;
  }
  return { roles: new Set<string>(roles), admin: new Set<string>(adminRoles ?? []) };
}

type Checked = { ok: true; user: GoogleSignInUser } | { ok: false; reason: GoogleSignInUsersRefusal };

function checkRow(value: unknown, allowed: { roles: ReadonlySet<string>; admin: ReadonlySet<string> }): Checked {
  if (!isPlainObject(value)) return { ok: false, reason: 'BAD_ROW' };
  const problem = keyProblem(Object.keys(value), ROW_KEYS, ROW_REQUIRED);
  if (problem) return { ok: false, reason: problem };
  // Each value is read once, so the value checked is the value kept.
  const principalId = value.principalId;
  const issuer = value.issuer;
  const subject = value.subject;
  const role = value.role;
  const hasRecord = Object.prototype.hasOwnProperty.call(value, 'directoryRecordId');
  const directoryRecordId = hasRecord ? value.directoryRecordId : undefined;
  const hasAppRecord = Object.prototype.hasOwnProperty.call(value, 'appRecordId');
  const appRecordId = hasAppRecord ? value.appRecordId : undefined;

  if (typeof principalId !== 'string' || !GUID.test(principalId)) return { ok: false, reason: 'BAD_PRINCIPAL' };
  if (issuer !== ISSUER) return { ok: false, reason: 'BAD_ISSUER' };
  if (typeof subject !== 'string' || !SUBJECT.test(subject)) return { ok: false, reason: 'BAD_SUBJECT' };
  if (typeof role === 'string' && (role.toLowerCase() === 'admin' || allowed.admin.has(role))) {
    return { ok: false, reason: 'ADMIN_ROLE' };
  }
  if (typeof role !== 'string' || !allowed.roles.has(role)) return { ok: false, reason: 'UNKNOWN_ROLE' };
  if (hasRecord && (typeof directoryRecordId !== 'string' || !DIRECTORY_RECORD.test(directoryRecordId))) {
    return { ok: false, reason: 'BAD_DIRECTORY_RECORD' };
  }
  if (hasAppRecord && (typeof appRecordId !== 'string' || !APP_RECORD.test(appRecordId))) {
    return { ok: false, reason: 'BAD_APP_RECORD' };
  }

  const user: { -readonly [K in keyof GoogleSignInUser]: GoogleSignInUser[K] } = {
    principalId,
    issuer: ISSUER,
    subject,
    role,
  };
  if (typeof directoryRecordId === 'string') user.directoryRecordId = directoryRecordId;
  if (typeof appRecordId === 'string') user.appRecordId = appRecordId;
  return { ok: true, user: Object.freeze(user) };
}

function check<R extends string>(
  input: unknown,
  options: GoogleSignInUsersOptions<R> | null | undefined,
): GoogleSignInUsersResult<R> {
  const allowed = readOptions(options);
  if (!allowed) return refuse('BAD_OPTIONS');

  if (input === undefined || input === null || input === '') return refuse('ABSENT');
  let raw: string | null = null;
  let value: unknown = input;
  if (typeof input === 'string') {
    if (input.length > MAX_BYTES || new TextEncoder().encode(input).byteLength > MAX_BYTES) return refuse('TOO_LARGE');
    raw = input;
    try {
      value = JSON.parse(input);
    } catch {
      return refuse('NOT_JSON');
    }
  }

  if (!isPlainObject(value)) return refuse('NOT_AN_OBJECT');
  const problem = keyProblem(Object.keys(value), LIST_KEYS, LIST_KEYS);
  if (problem) return refuse(problem);
  const schema = value.schema;
  const workspaceId = value.workspaceId;
  const rows = value.users;
  if (schema !== GOOGLE_SIGNIN_USERS_SCHEMA) return refuse('BAD_SCHEMA');
  if (typeof workspaceId !== 'string' || !GUID.test(workspaceId)) return refuse('BAD_WORKSPACE');
  if (!Array.isArray(rows)) return refuse('NOT_A_LIST');
  const count = rows.length;
  if (count === 0) return refuse('EMPTY');

  const users: GoogleSignInUser<R>[] = [];
  const principals = new Set<string>();
  const subjects = new Set<string>();
  const records = new Set<string>();
  const appRecords = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const row = checkRow(rows[index], allowed);
    if (!row.ok) return refuse(row.reason, index);
    const user = row.user as GoogleSignInUser<R>;
    const subjectKey = JSON.stringify([user.issuer, user.subject]);
    if (principals.has(user.principalId)) return refuse('DUPLICATE_PRINCIPAL', index);
    if (subjects.has(subjectKey)) return refuse('DUPLICATE_SUBJECT', index);
    if (user.directoryRecordId !== undefined && records.has(user.directoryRecordId)) {
      return refuse('DUPLICATE_DIRECTORY_RECORD', index);
    }
    if (user.appRecordId !== undefined && appRecords.has(user.appRecordId)) {
      return refuse('DUPLICATE_APP_RECORD', index);
    }
    principals.add(user.principalId);
    subjects.add(subjectKey);
    if (user.directoryRecordId !== undefined) records.add(user.directoryRecordId);
    if (user.appRecordId !== undefined) appRecords.add(user.appRecordId);
    users.push(user);
  }

  const list: GoogleSignInUserList<R> = Object.freeze({
    schema: GOOGLE_SIGNIN_USERS_SCHEMA as typeof GOOGLE_SIGNIN_USERS_SCHEMA,
    workspaceId,
    users: Object.freeze(users) as readonly GoogleSignInUser<R>[],
  });
  if (raw !== null && canonicalGoogleSignInUsers(list) !== raw) return refuse('NOT_CANONICAL');
  validated.add(list);
  return Object.freeze({ ok: true as const, list });
}

/**
 * Check an app's list of Google sign-in users. `input` is the stored value:
 * a JSON string (an app setting or secret), which must be exactly
 * `canonicalGoogleSignInUsers` of the list it holds, or an object already read
 * from a store. Answers `{ ok: true, list }` only when every check passes;
 * otherwise `{ ok: false, reason, row? }`, and that list admits nobody. Never throws.
 */
export function validateGoogleSignInUsers<R extends string>(
  input: unknown,
  options: GoogleSignInUsersOptions<R>,
): GoogleSignInUsersResult<R> {
  try {
    return check(input, options);
  } catch {
    // A throwing getter or proxy in a caller-built object: nobody is admitted.
    return refuse('UNREADABLE');
  }
}

/**
 * The only stored form of a list: compact JSON with the keys in schema order
 * (schema, workspaceId, users; in each row principalId, issuer, subject, role,
 * directoryRecordId, appRecordId). Fields outside the schema are left out.
 * Write this, then read it back with `validateGoogleSignInUsers` before
 * relying on it.
 */
export function canonicalGoogleSignInUsers(list: GoogleSignInUserList): string {
  return JSON.stringify({
    schema: list.schema,
    workspaceId: list.workspaceId,
    users: list.users.map((user) => {
      const row: Record<string, string> = {
        principalId: user.principalId,
        issuer: user.issuer,
        subject: user.subject,
        role: user.role,
      };
      if (user.directoryRecordId !== undefined) row.directoryRecordId = user.directoryRecordId;
      if (user.appRecordId !== undefined) row.appRecordId = user.appRecordId;
      return row;
    }),
  });
}

/**
 * The one row for this request's verified Google sign-in, or null. A row
 * matches only when its principalId, issuer and subject all equal the sign-in's
 * exactly (no trimming or case folding) and the list's workspaceId equals the
 * sign-in's workspaceId. `directoryRecordId` and `appRecordId` are returned on
 * the row and never compared. A refused result, a list this module did not
 * validate, or a sign-in missing any of the four values matches nobody. Pass
 * the principal from THIS request's verify; never one kept from an earlier request.
 */
export function matchGoogleSignInUser<R extends string>(
  result: GoogleSignInUsersResult<R> | null | undefined,
  signIn: GoogleSignInIdentity | null | undefined,
): GoogleSignInUser<R> | null {
  try {
    if (!result || result.ok !== true || !validated.has(result.list)) return null;
    if (!signIn || typeof signIn !== 'object') return null;
    const { principalId, workspaceId, issuer, subject } = signIn;
    if (
      typeof principalId !== 'string' || typeof workspaceId !== 'string' ||
      typeof issuer !== 'string' || typeof subject !== 'string'
    ) {
      return null;
    }
    const list = result.list;
    if (list.workspaceId !== workspaceId) return null;
    const matches = list.users.filter(
      (user) => user.principalId === principalId && user.issuer === issuer && user.subject === subject,
    );
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}
