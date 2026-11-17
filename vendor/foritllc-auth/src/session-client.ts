/** Browser half of an opaque server session. No provider tokens, Next imports or write replay. */
export const CSRF_HEADER = 'X-ForIT-CSRF';
export const DEFAULT_SESSION_BASE = '/api/auth';
export interface SessionInfo {
  signedIn: true;
  provider: 'microsoft' | 'google';
  displayName: string;
  expiresAt: string;
  personTag: string;
}
export type SessionRead = SessionInfo | { signedIn: false; reason: 'signed_out' | 'ended' | 'unavailable' | 'failed' };
export type SessionEvent =
  | { type: 'signed-in'; session: SessionInfo }
  | { type: 'person-changed'; session: SessionInfo }
  | { type: 'ended' }
  | { type: 'unavailable' };
export interface SessionClientOptions { base?: string; fetch?: typeof fetch; document?: Document }
export interface SessionClient {
  signInHref(returnTo?: string): string;
  readSession(): Promise<SessionRead>;
  csrfToken(): Promise<string | null>;
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
  signOut(): void;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
function pathOnly(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) {
    throw new TypeError('A same-origin path is required');
  }
  const parsed = new URL(value, 'https://session.invalid');
  if (parsed.origin !== 'https://session.invalid') throw new TypeError('A same-origin path is required');
  return value;
}
export function createSessionClient(options: SessionClientOptions = {}): SessionClient {
  const base = options.base ?? DEFAULT_SESSION_BASE;
  if (!/^(?:\/[a-z0-9][a-z0-9_-]*)+$/.test(base)) throw new TypeError('Invalid session base path');
  const fetcher = options.fetch ?? globalThis.fetch;
  let token: string | null = null;
  let generation = 0;
  let readSequence = 0;
  let csrfFlight: Promise<string | null> | null = null;
  let person: string | null = null;
  let state = 'initial';
  const listeners = new Set<(event: SessionEvent) => void>();
  const clearToken = () => { token = null; generation++; csrfFlight = null; };
  const emit = (event: SessionEvent) => { for (const listener of listeners) listener(event); };
  const unavailable = () => {
    if (state !== 'unavailable') { state = 'unavailable'; emit({ type: 'unavailable' }); }
  };
  const ended = () => {
    clearToken();
    if (person !== null && state !== 'ended') { state = 'ended'; emit({ type: 'ended' }); }
    else state = 'ended';
  };
  async function readSession(): Promise<SessionRead> {
    const sequence = ++readSequence;
    const sessionGeneration = generation;
    const stale = () => sequence !== readSequence || sessionGeneration !== generation;
    const discarded = (): SessionRead => ({ signedIn: false, reason: 'failed' });
    let response: Response;
    try { response = await fetcher(`${base}/me`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); }
    catch {
      if (stale()) return discarded();
      unavailable(); return { signedIn: false, reason: 'unavailable' };
    }
    if (stale()) return discarded();
    if (response.status === 401) {
      const hadPerson = person !== null; ended();
      return { signedIn: false, reason: hadPerson ? 'ended' : 'signed_out' };
    }
    if (response.status === 503) {
      // A refused/malformed verification is distinct from an unreachable producer.
      // Only the server's fixed failure projection changes that reason.
      let failure: unknown;
      try { failure = await response.json(); } catch { /* An unreadable outage answer stays unavailable. */ }
      if (stale()) return discarded();
      const value = failure as { signedIn?: unknown; reason?: unknown; code?: unknown } | null;
      const failed = value !== null && typeof value === 'object'
        && ((value.signedIn === false && value.reason === 'failed') || value.code === 'SIGNIN_FAILED');
      unavailable();
      return { signedIn: false, reason: failed ? 'failed' : 'unavailable' };
    }
    let body: unknown;
    try { body = await response.json(); } catch {
      if (stale()) return discarded();
      unavailable(); return { signedIn: false, reason: 'failed' };
    }
    if (stale()) return discarded();
    const value = body as Partial<SessionInfo> | null;
    if (response.status !== 200 || !value || value.signedIn !== true || !['microsoft', 'google'].includes(value.provider ?? '')
      || typeof value.displayName !== 'string' || typeof value.personTag !== 'string' || !value.personTag
      || typeof value.expiresAt !== 'string' || (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now())) {
      unavailable(); return { signedIn: false, reason: 'failed' };
    }
    const session: SessionInfo = { signedIn: true, provider: value.provider!, displayName: value.displayName,
      personTag: value.personTag, expiresAt: value.expiresAt };
    const changed = person !== null && person !== session.personTag;
    if (person !== session.personTag) clearToken();
    const was = state;
    person = session.personTag; state = 'signed-in';
    if (changed) emit({ type: 'person-changed', session });
    else if (was !== state) emit({ type: 'signed-in', session });
    return session;
  }
  async function csrfToken(): Promise<string | null> {
    if (token !== null) return token;
    if (csrfFlight) return csrfFlight;
    const current = generation;
    const flight = (async () => {
      try {
        const response = await fetcher(`${base}/csrf`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        if (current !== generation) return null;
        if (response.status === 401) { ended(); return null; }
        if (response.status === 403) { clearToken(); return null; }
        if (response.status !== 200) { unavailable(); return null; }
        const body = await response.json() as { csrfToken?: unknown };
        if (typeof body.csrfToken !== 'string' || !body.csrfToken || current !== generation) return null;
        token = body.csrfToken;
        return token;
      } catch {
        if (current !== generation) return null;
        unavailable(); return null;
      }
    })();
    csrfFlight = flight;
    try { return await flight; } finally { if (csrfFlight === flight) csrfFlight = null; }
  }
  async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    pathOnly(path);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (!SAFE.has(method)) {
      const csrf = await csrfToken();
      if (!csrf) throw new Error('Session CSRF is unavailable; request was not sent');
      headers.set(CSRF_HEADER, csrf);
    }
    const requestGeneration = generation;
    let response: Response;
    try { response = await fetcher(path, { ...init, method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); }
    catch (error) {
      if (requestGeneration === generation) unavailable();
      throw error;
    }
    // Return the original operation result, but an old session's response cannot
    // invalidate a newer person's lifecycle or cached CSRF value.
    if (requestGeneration !== generation) return response;
    if (response.status === 401) ended();
    else if (response.status === 403) clearToken();
    else if (response.status === 503) unavailable();
    return response;
  }
  return {
    signInHref(returnTo = '/') {
      let safe = '/';
      try { safe = pathOnly(returnTo); } catch { /* A rejected return path stays on the app. */ }
      return `${base}/login?${new URLSearchParams({ returnTo: safe })}`;
    },
    readSession, csrfToken, apiFetch,
    signOut() {
      const doc = options.document ?? globalThis.document;
      if (!doc?.body) throw new Error('Sign-out requires a document');
      clearToken();
      const form = doc.createElement('form');
      form.method = 'POST'; form.action = `${base}/logout`; form.hidden = true;
      doc.body.appendChild(form); form.submit(); form.remove();
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
