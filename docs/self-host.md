# Self-hosting

`docker-compose.yml` runs the whole LMS on one machine:

| Service | What it does |
|---|---|
| `certs` | Makes a private CA and a certificate for `sql` once, into the `certs` volume. |
| `sql` | SQL Server 2022 (Express by default) with that certificate, data in the `sql-data` volume. |
| `init` | Runs on every start, then exits. It creates the database if missing, applies pending migrations, creates or updates the app's SQL login and creates the first tenant. It changes nothing a second time. |
| `app` | The LMS on port 3000 (`LMS_PORT` on the host). |

## Start

```bash
cp .env.example .env                          # the app's settings
cp docker/selfhost.env.example selfhost.env   # database passwords, first tenant
# edit both, then:
docker compose --env-file selfhost.env up -d --build
```

In `.env`, set at least:
- `SESSION_SECRET`;
- `AZURE_AD_CLIENT_ID` and `AZURE_AD_CLIENT_SECRET` (sign-in);
- `LMS_APEX_DOMAIN`;
- `LMS_APEX_TENANT_SLUG`, set to the tenant in `LMS_BOOTSTRAP_SLUG`.

Leave the `SQL_*` lines empty: compose sets them.

`selfhost.env` holds the `sa` password. Compose passes it only to `sql` and `init`, never to the app.

## Database

- **Encrypted, verified connections.** The app and `init` connect to `sql` over TLS and check its certificate against the private CA (`NODE_EXTRA_CA_CERTS`). A connection by any other name, or without the CA, is refused.
- **The app's login is `LMS_APP_SQL_USER`.** It can read and write the `lms` schema. It cannot change the schema or the migration history (`lms.SchemaMigration`). Only `init` runs migrations, as `sa`.
- **Upgrading.** Pull, then run `up -d --build` again; `init` applies the new migrations before the app starts.
- **Backups.** Back up the `sql-data` volume, or run `BACKUP DATABASE` against `sql`.

**An existing database migrated before the history table.** Record what it already has once, then let `init` take over:

```bash
docker compose --env-file selfhost.env run --rm init node scripts/run-migration.cjs --baseline-through NNNN
```

## Tenants

`init` creates one tenant from `LMS_BOOTSTRAP_*`. For more tenants, run `scripts/bootstrap-tenant.cjs` the same way. A tenant is served:
- at `<slug>.<LMS_APEX_DOMAIN>`;
- at its own `--hostname`;
- at the apex, if it is `LMS_APEX_TENANT_SLUG`.

Any other host gets 404.

People sign in with Microsoft Entra. They land in a tenant through:
- its directory (`--aad-tenant-id`, preferred);
- otherwise, a verified email domain (`--domain`).

`--admin-email` makes the first admin. Everyone else starts as a learner.

## Build

The exported source includes the auth package under `vendor/foritllc-auth`.
The app image copies that folder and the root manifests before `npm ci`.
After the rest of the source is copied, `npm run build` runs the root `prebuild`
hook, which compiles the local auth package before Next.js consumes its exports.
The root dependency uses an in-tree `file:` path. The image uses this source tree
as its only build context.

Docker pulls the Node and SQL Server images and installs the dependencies named
in the source. Configure the application sign-in and database settings above
for the installation you operate.

This is private source preparation. Clean dependency installation, auth
compilation, container build and startup still need to be verified against this
exact exported tree; the commands above are the proposed self-host path.

## Not yet

- Mail (feedback tickets) goes through Microsoft Graph only; SMTP comes with row 0.2.
- Service runs and errors go to the app container's console (`docker compose logs app`), because the database has no `logging` schema for them.
