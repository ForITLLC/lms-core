// @foritllc/auth/google-principal-users (0.22.0): explicit principal-mode
// business entitlements. No imports, providers, Next.js or positive cache.
// Stored schema: {schema, workspaceId, users:[{principalId, role,
// directoryRecordId?, appRecordId?}]}. No issuer, subject or email at rest.
// This is NOT an authenticator: consumers still perform actual fresh Auth
// verification and preserve provider, app, audience, session and workspace checks.
// This additive mode relies on Auth's supported immutable principal mapping.
// google-signin-users/v1 retains its independent exact four-field semantics.
// 0.23.0: explicit application-only lowercase admin opt-in; denied by default.

/** The schema id a list must carry, exactly. */
export const GOOGLE_PRINCIPAL_USERS_SCHEMA = 'forit.google-principal-users/v1';

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
const ROW_KEYS = ['principalId', 'role', 'directoryRecordId', 'appRecordId'] as const;
const ROW_REQUIRED = ['principalId', 'role'] as const;

/** One person on the list. Frozen. */
export interface GooglePrincipalUser<R extends string = string> {
  /** forit-Auth's principal id (lower-case GUID). */
  readonly principalId: string;
  /** One of the role codes the app passed in `roles`, subject to its admin policy. */
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
export interface GooglePrincipalUserList<R extends string = string> {
  readonly schema: typeof GOOGLE_PRINCIPAL_USERS_SCHEMA;
  /** forit-Auth's workspace id (lower-case GUID). A sign-in from any other workspace matches nobody. */
  readonly workspaceId: string;
  /** At least one row. */
  readonly users: readonly GooglePrincipalUser<R>[];
}

/** What the app allows. There is no default. */
export interface GooglePrincipalUsersOptions<R extends string = string> {
  /** The role codes a Google user may hold in this app, e.g. ['chiefPilot', 'flightOperationsView', 'viewer']. */
  readonly roles: readonly R[];
  /**
   * Role codes this app treats as admin-level. A row naming one is refused,
   * even if it is also in `roles` or `allowApplicationAdmin` is true.
   */
  readonly adminRoles?: readonly string[];
  /**
   * Explicitly allow this app's exact lowercase `admin` role, only if it is
   * also in `roles` and not in `adminRoles`. Absent or false denies admin;
   * all other case spellings remain refused. Grants no Auth or tenant access.
   */
  readonly allowApplicationAdmin?: boolean;
}

/** Why a list admits nobody. */
export type GooglePrincipalUsersRefusal =
  /** The options were missing or malformed (including a nonboolean admin opt-in). */
  | 'BAD_OPTIONS'
  /** No value: undefined, null or an empty string. */
  | 'ABSENT'
  /** A stored value whose canonical JSON is over 64 KiB. */
  | 'TOO_LARGE'
  /** A string that is not JSON. */
  | 'NOT_JSON'
  /** A string that is not exactly `canonicalGooglePrincipalUsers` of what it holds (this also rules out duplicate JSON keys). */
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
  /** A role not in the app's `roles`. */
  | 'UNKNOWN_ROLE'
  /** A denied admin spelling or a role in the app's unconditional `adminRoles` deny list. */
  | 'ADMIN_ROLE'
  | 'BAD_DIRECTORY_RECORD'
  /** An `appRecordId` that is not an opaque id of 1-128 letters, digits, `_` or `-`, starting with a letter or digit. */
  | 'BAD_APP_RECORD'
  | 'DUPLICATE_PRINCIPAL'
  | 'DUPLICATE_DIRECTORY_RECORD'
  | 'DUPLICATE_APP_RECORD';

/** The validator's answer. Frozen. On a refusal, `row` is the 0-based index of the row at fault. */
export type GooglePrincipalUsersResult<R extends string = string> =
  | { readonly ok: true; readonly list: GooglePrincipalUserList<R> }
  | { readonly ok: false; readonly reason: GooglePrincipalUsersRefusal; readonly row?: number };

/** The four values the app gets from forit-Auth's verify for this request (a `GooglePrincipal` fits). */
export interface GooglePrincipalIdentity {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly issuer: string;
  readonly subject: string;
}

// Provenance only: the lists this module's validator returned in this process.
const validated = new WeakSet<object>();

function refuse(reason: GooglePrincipalUsersRefusal, row?: number): { ok: false; reason: GooglePrincipalUsersRefusal; row?: number } {
  return Object.freeze(row === undefined ? { ok: false as const, reason } : { ok: false as const, reason, row });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownKeys(value: Record<string, unknown>): string[] {
  // JSON has only string keys; object inputs must not hide extra symbol keys.
  return Reflect.ownKeys(value).map((key) => typeof key === 'string' ? key : '\u0000');
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
  options: GooglePrincipalUsersOptions<R> | null | undefined,
): { roles: ReadonlySet<string>; admin: ReadonlySet<string>; allowApplicationAdmin: boolean } | null {
  if (!options || typeof options !== 'object') return null;
  const { roles, adminRoles, allowApplicationAdmin } = options;
  if (allowApplicationAdmin !== undefined && typeof allowApplicationAdmin !== 'boolean') return null;
  if (!Array.isArray(roles) || roles.length === 0) return null;
  // Snapshot each array once: sparse holes are invalid and the values checked
  // are the values retained, even for caller-built arrays with getters.
  const roleCodes = Array.from(roles);
  if (!roleCodes.every((role) => typeof role === 'string' && ROLE_CODE.test(role))) return null;
  let deniedCodes: string[] = [];
  if (adminRoles !== undefined) {
    if (!Array.isArray(adminRoles)) return null;
    deniedCodes = Array.from(adminRoles);
    if (!deniedCodes.every((role) => typeof role === 'string' && ROLE_CODE.test(role))) return null;
  }
  return { roles: new Set<string>(roleCodes), admin: new Set<string>(deniedCodes), allowApplicationAdmin: allowApplicationAdmin === true };
}

type Checked = { ok: true; user: GooglePrincipalUser } | { ok: false; reason: GooglePrincipalUsersRefusal };

function checkRow(value: unknown, allowed: { roles: ReadonlySet<string>; admin: ReadonlySet<string>; allowApplicationAdmin: boolean }): Checked {
  if (!isPlainObject(value)) return { ok: false, reason: 'BAD_ROW' };
  const problem = keyProblem(ownKeys(value), ROW_KEYS, ROW_REQUIRED);
  if (problem) return { ok: false, reason: problem };
  // Each value is read once, so the value checked is the value kept.
  const principalId = value.principalId;
  const role = value.role;
  const hasRecord = Object.prototype.hasOwnProperty.call(value, 'directoryRecordId');
  const directoryRecordId = hasRecord ? value.directoryRecordId : undefined;
  const hasAppRecord = Object.prototype.hasOwnProperty.call(value, 'appRecordId');
  const appRecordId = hasAppRecord ? value.appRecordId : undefined;

  if (typeof principalId !== 'string' || !GUID.test(principalId)) return { ok: false, reason: 'BAD_PRINCIPAL' };
  if (typeof role === 'string' && (allowed.admin.has(role) ||
      (role.toLowerCase() === 'admin' && !(role === 'admin' && allowed.allowApplicationAdmin)))) {
    return { ok: false, reason: 'ADMIN_ROLE' };
  }
  if (typeof role !== 'string' || !allowed.roles.has(role)) return { ok: false, reason: 'UNKNOWN_ROLE' };
  if (hasRecord && (typeof directoryRecordId !== 'string' || !DIRECTORY_RECORD.test(directoryRecordId))) {
    return { ok: false, reason: 'BAD_DIRECTORY_RECORD' };
  }
  if (hasAppRecord && (typeof appRecordId !== 'string' || !APP_RECORD.test(appRecordId))) {
    return { ok: false, reason: 'BAD_APP_RECORD' };
  }

  const user: { -readonly [K in keyof GooglePrincipalUser]: GooglePrincipalUser[K] } = {
    principalId,
    role,
  };
  if (typeof directoryRecordId === 'string') user.directoryRecordId = directoryRecordId;
  if (typeof appRecordId === 'string') user.appRecordId = appRecordId;
  return { ok: true, user: Object.freeze(user) };
}

function check<R extends string>(
  input: unknown,
  options: GooglePrincipalUsersOptions<R> | null | undefined,
): GooglePrincipalUsersResult<R> {
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
  const problem = keyProblem(ownKeys(value), LIST_KEYS, LIST_KEYS);
  if (problem) return refuse(problem);
  const schema = value.schema;
  const workspaceId = value.workspaceId;
  const rows = value.users;
  if (schema !== GOOGLE_PRINCIPAL_USERS_SCHEMA) return refuse('BAD_SCHEMA');
  if (typeof workspaceId !== 'string' || !GUID.test(workspaceId)) return refuse('BAD_WORKSPACE');
  if (!Array.isArray(rows)) return refuse('NOT_A_LIST');
  const count = rows.length;
  if (count === 0) return refuse('EMPTY');
  // Even the shortest valid row costs this many bytes. Bound object inputs
  // before traversing an arbitrarily large array; this is the same 64-KiB cap.
  const minimumRowBytes = 64;
  if (count > Math.floor(MAX_BYTES / minimumRowBytes)) return refuse('TOO_LARGE');

  const users: GooglePrincipalUser<R>[] = [];
  const principals = new Set<string>();
  const records = new Set<string>();
  const appRecords = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const row = checkRow(rows[index], allowed);
    if (!row.ok) return refuse(row.reason, index);
    const user = row.user as GooglePrincipalUser<R>;
    if (principals.has(user.principalId)) return refuse('DUPLICATE_PRINCIPAL', index);
    if (user.directoryRecordId !== undefined && records.has(user.directoryRecordId)) {
      return refuse('DUPLICATE_DIRECTORY_RECORD', index);
    }
    if (user.appRecordId !== undefined && appRecords.has(user.appRecordId)) {
      return refuse('DUPLICATE_APP_RECORD', index);
    }
    principals.add(user.principalId);
    if (user.directoryRecordId !== undefined) records.add(user.directoryRecordId);
    if (user.appRecordId !== undefined) appRecords.add(user.appRecordId);
    users.push(user);
  }

  const list: GooglePrincipalUserList<R> = Object.freeze({
    schema: GOOGLE_PRINCIPAL_USERS_SCHEMA as typeof GOOGLE_PRINCIPAL_USERS_SCHEMA,
    workspaceId,
    users: Object.freeze(users) as readonly GooglePrincipalUser<R>[],
  });
  const canonical = canonicalGooglePrincipalUsers(list);
  if (new TextEncoder().encode(canonical).byteLength > MAX_BYTES) return refuse('TOO_LARGE');
  if (raw !== null && canonical !== raw) return refuse('NOT_CANONICAL');
  validated.add(list);
  return Object.freeze({ ok: true as const, list });
}

/**
 * Check an app's list of Google sign-in users. `input` is the stored value:
 * a JSON string (an app setting or secret), which must be exactly
 * `canonicalGooglePrincipalUsers` of the list it holds, or an object already read
 * from a store. Answers `{ ok: true, list }` only when every check passes;
 * otherwise `{ ok: false, reason, row? }`, and that list admits nobody. Never throws.
 */
export function validateGooglePrincipalUsers<R extends string>(
  input: unknown,
  options: GooglePrincipalUsersOptions<R>,
): GooglePrincipalUsersResult<R> {
  try {
    return check(input, options);
  } catch {
    // A throwing getter or proxy in a caller-built object: nobody is admitted.
    return refuse('UNREADABLE');
  }
}

/**
 * The only stored form of a list: compact JSON with the keys in schema order
 * (schema, workspaceId, users; in each row principalId, role,
 * directoryRecordId, appRecordId). Fields outside the schema are left out.
 * Write this, then read it back with `validateGooglePrincipalUsers` before
 * relying on it.
 */
export function canonicalGooglePrincipalUsers(list: GooglePrincipalUserList): string {
  return JSON.stringify({
    schema: list.schema,
    workspaceId: list.workspaceId,
    users: list.users.map((user) => {
      const row: Record<string, string> = {
        principalId: user.principalId,
        role: user.role,
      };
      if (user.directoryRecordId !== undefined) row.directoryRecordId = user.directoryRecordId;
      if (user.appRecordId !== undefined) row.appRecordId = user.appRecordId;
      return row;
    }),
  });
}

/**
 * Match an entitlement only after the consumer has authenticated THIS request
 * through Auth: verify provider/app/audience/session and pass its cohesive
 * principal/workspace/issuer/subject unchanged. This helper cannot authenticate
 * plain JSON or establish where it came from. Never cache a positive answer.
 *
 * The actual Google subject is shape-checked, never stored or compared with a
 * configured subject. Auth guarantees a supported immutable principal mapping
 * (app sign-in contract §4.4). Products relying on this explicit trust boundary
 * must not substitute it for the separate four-field google-signin-users mode.
 */
export function matchGooglePrincipalUser<R extends string>(
  result: GooglePrincipalUsersResult<R> | null | undefined,
  signIn: GooglePrincipalIdentity | null | undefined,
): GooglePrincipalUser<R> | null {
  try {
    if (!result || result.ok !== true) return null;
    // Read once: an untrusted wrapper getter cannot swap the checked list.
    const list = result.list;
    if (!validated.has(list)) return null;
    if (!signIn || typeof signIn !== 'object') return null;
    const { principalId, workspaceId, issuer, subject } = signIn;
    if (typeof principalId !== 'string' || !GUID.test(principalId) ||
        typeof workspaceId !== 'string' || !GUID.test(workspaceId) ||
        issuer !== ISSUER || typeof subject !== 'string' || !SUBJECT.test(subject)) return null;
    if (list.workspaceId !== workspaceId) return null;
    const matches = list.users.filter((user) => user.principalId === principalId);
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}
