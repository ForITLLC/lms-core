# LMS

A white-label, multi-tenant learning management system. One install serves many organisations, each on its own subdomain or custom domain, with its own name, logo, colours and support address. Learners take assigned courses with quizzes and earn certificates; admins assign training, track completion and export compliance records.

## What it does

- **Tenants.** Each organisation is a row in `lms.Tenant` with branding in `lms.TenantBranding`. A request is matched to its tenant by host name (`<slug>.<LMS_APEX_DOMAIN>` or the tenant's custom hostname); an unknown host gets a 404, never another tenant's site. Every query is scoped to the tenant.
- **Courses.** Lessons made of typed blocks: text, callout, image, video, embed, quiz and role-play. Course text can use `{{company_name}}`, `{{support_email}}` and `{{work_email_domain}}`, which resolve against the reading tenant's branding, so one course serves every tenant.
- **Starter library.** Eight general courses (account security, phishing, AI at work, handling client data, incident response, the history of AI and of cloud computing, and authoring in this LMS), loaded into a tenant with `npm run seed:starter -- --tenant <TenantId>`.
- **Assignments.** Assign courses to learners with due dates and notes. A course can set a retraining interval, after which its certificate expires.
- **Learner experience.** A dashboard of assigned training, the course player, quizzes with passing scores, a daily review drill, and certificates with a public verification page.
- **AI tutor.** An in-lesson chat that answers from the course's own material, using Anthropic's Claude.
- **Reporting.** Completion and mandatory-training status per learner, and a compliance CSV export.
- **Read-only REST API.** See below.

## Run it

The quickest route is Docker Compose, which runs SQL Server, the migrations, a first tenant and the app:

```bash
cp .env.example .env
cp docker/selfhost.env.example selfhost.env
# edit both, then:
docker compose --env-file selfhost.env up -d --build
```

[`docs/self-host.md`](docs/self-host.md) covers the settings, TLS to the database, upgrades, backups and adopting an existing database.

The exported tree includes its auth source in [`vendor/foritllc-auth`](vendor/foritllc-auth/README.md).
The image copies that package before installing dependencies; the root build
compiles it before Next.js. Installation and compilation need no private package
registry token.

## Develop

Requires Node.js 20 and a SQL Server or Azure SQL database.

```bash
npm ci
cp .env.example .env.local                 # fill in the sign-in and database groups
node scripts/run-migration.cjs --pending   # apply db/migrations
npm run dev                                # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests (`node --test`) |
| `npm run typecheck` | TypeScript, strict |
| `npm run validate:courses` | Checks every course seed against the block and quiz schemas |
| `npm run seed:starter -- --tenant <TenantId>` | Loads the starter library into a tenant |

### Settings

`.env.example` lists every setting with a comment. The groups that matter first:

- **Sign-in:** `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID` and `SESSION_SECRET` (32 or more random bytes). Sign-in is Microsoft Entra ID. A tenant is bound to a directory by its Entra tenant id, not by email domain alone.
- **Database:** the `SQL_*` group.
- **Hosts:** `LMS_APEX_DOMAIN` and `LMS_APEX_TENANT_SLUG`. Set `LMS_TRUST_FORWARDED_HOST=true` only behind a proxy you control that overwrites `X-Forwarded-Host`.
- **AI:** `ANTHROPIC_API_KEY`, used by the tutor and to write daily-drill questions. `AI_AUTHORING_TENANTS` lists the tenant slugs whose authors may draft courses with AI; empty, it is off for every tenant.
- **Mail:** `LMS_DIGEST_FROM`, the `EMAIL_UNSUBSCRIBE_*` keys and `EMAIL_ADDRESS_PEPPER`, for feedback mail. Mail goes out through Microsoft Graph (`lib/vendor/mail.public.ts`), as an Entra app with the `Mail.Send` application permission; limit it to the sending mailbox with an Exchange application access policy or RBAC for Applications.

## Layout

```
app/              Next.js App Router: learner, admin and API routes
lib/              Domain logic, data access (lib/db), AI (lib/ai), theming (lib/theme.ts)
components/ui/    UI components
db/migrations/    Numbered SQL migrations for the lms schema
db/seed/          Starter courses and their quizzes
scripts/          Migration runner, tenant bootstrap, course tools
docker/           Self-host support files (docker-compose.yml is at the root)
```

All tables live in the `lms` schema. `scripts/run-migration.cjs --pending` applies the `db/migrations` files not yet recorded in `lms.SchemaMigration`, in order.

## REST API

A read-only API under `/api/v1/*`, described by the OpenAPI 3.1 document at `/api/openapi.json`. Callers send `Authorization: Bearer lms_…`, a per-user key minted under **Admin → Integrations**. The key carries its tenant, so no operation takes a tenant argument.

| Operation | Path | Returns |
|---|---|---|
| `list_courses` | `/api/v1/courses` | The tenant's courses, including drafts, and subscribed catalogue courses |
| `get_course` | `/api/v1/courses/{slug}` | Lessons with block and quiz counts |
| `list_learners` | `/api/v1/learners` | Learners with enrolment and completion counts and last activity |
| `get_progress` | `/api/v1/courses/{slug}/progress` | Completion per learner |
| `compliance_summary` | `/api/v1/compliance` | Mandatory training done and outstanding |

## Licence

The application source, bundled starter examples and embedded instruction
templates are distributed under the GNU Affero General Public License, version 3
only ([LICENSE](LICENSE)). The vendored auth component keeps its separate MIT
licence and notice; see [NOTICE](NOTICE) and
[its licence](vendor/foritllc-auth/LICENSE). Keep the applicable notices with
copies of the source. The code licence does not grant trademark rights or rights
to customer settings, learner records or courses supplied by an operator or
publisher.

## Validation scope

The source installation route has been checked with a credential-free clean
install, auth compilation, the Next.js 15.5.18 production build and typecheck,
and isolated standalone startup on Node.js 20.20.2 with npm 10.8.2. The startup
check used a synthetic session secret and requested `/api/version`; it did not
sign anyone in or connect to a real database or provider.

Real sign-in, database migrations, tenant workflows, mail and AI integrations
need their documented configuration and separate acceptance. The complete
Compose setup has not been validated end to end. This source build check is not
a claim that a configured hosted installation is ready for users.
