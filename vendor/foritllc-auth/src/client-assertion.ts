// ============================================================================
// @foritllc/auth - Client assertion (0.9.0)
// ============================================================================
//
// An app can redeem the authorization code with a client assertion instead of
// a client secret. The assertion that matters here is a managed-identity token
// for `api://AzureADTokenExchange`: the shared sign-in registration holds a
// federated identity credential that trusts the app's own managed identity, so
// the app has no secret to leak or rotate (forit-sign-in-client.md rule 3).

/** The `client_assertion_type` Entra expects for a JWT client assertion. */
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** The audience a managed-identity token must carry for a federated credential. */
export const TOKEN_EXCHANGE_AUDIENCE = 'api://AzureADTokenExchange';

/**
 * The host's managed-identity endpoint refused the token request. `status` is
 * its HTTP status, kept as a value so a caller can tell a throttle (429) from
 * a misconfiguration (400) without reading the message.
 */
export class ManagedIdentityTokenError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ManagedIdentityTokenError';
    this.status = status;
  }
}

/** Refresh a cached assertion this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ManagedIdentityAssertionOptions {
  /**
   * Client id of a user-assigned managed identity. Omit to use the app's
   * system-assigned identity. Either way the identity is assigned to this app
   * alone (rule 3).
   */
  clientId?: string;
  /** Default: `process.env.IDENTITY_ENDPOINT`, read on each token request. */
  endpoint?: string;
  /** Default: `process.env.IDENTITY_HEADER`, read on each token request. */
  header?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * A `clientAssertion` source backed by the managed identity of an App
 * Service, Functions or Container Apps host: `GET $IDENTITY_ENDPOINT` with
 * `X-IDENTITY-HEADER: $IDENTITY_HEADER`, `resource=api://AzureADTokenExchange`,
 * `api-version=2019-08-01`. The token is cached until five minutes before it
 * expires.
 *
 * The environment is read when a sign-in redeems its code, not when the app
 * starts, so `next build` runs without it. A host with no managed identity
 * throws at that point, and the callback answers `callback_failed`. It never
 * falls back to a secret.
 */
export function managedIdentityClientAssertion(
  options: ManagedIdentityAssertionOptions = {}
): () => Promise<string> {
  let cached: { token: string; refreshAt: number } | undefined;

  return async () => {
    if (cached && Date.now() < cached.refreshAt) return cached.token;

    const endpoint = options.endpoint ?? process.env.IDENTITY_ENDPOINT;
    const header = options.header ?? process.env.IDENTITY_HEADER;
    if (!endpoint || !header) {
      throw new Error(
        '[forit/auth] managedIdentityClientAssertion: IDENTITY_ENDPOINT and IDENTITY_HEADER are not set. ' +
          'Turn on a managed identity for this app and give the shared sign-in registration a ' +
          'federated credential that trusts it (forit-sign-in-client.md rule 3).'
      );
    }

    const url = new URL(endpoint);
    url.searchParams.set('resource', TOKEN_EXCHANGE_AUDIENCE);
    url.searchParams.set('api-version', '2019-08-01');
    if (options.clientId) url.searchParams.set('client_id', options.clientId);

    const res = await (options.fetch ?? fetch)(url, { headers: { 'X-IDENTITY-HEADER': header } });
    if (!res.ok) {
      // The body is not logged: the status says enough, and a token
      // endpoint's body is no place to start printing from.
      throw new ManagedIdentityTokenError('[forit/auth] managed identity token request failed', res.status);
    }
    const body = (await res.json()) as { access_token?: unknown; expires_on?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error('[forit/auth] managed identity token response has no access_token');
    }

    // expires_on is epoch seconds (a string on api-version 2019-08-01). An
    // unreadable value caches nothing.
    const expiresOn = Number(body.expires_on);
    cached = Number.isFinite(expiresOn)
      ? { token: body.access_token, refreshAt: expiresOn * 1000 - REFRESH_MARGIN_MS }
      : undefined;
    return body.access_token;
  };
}
