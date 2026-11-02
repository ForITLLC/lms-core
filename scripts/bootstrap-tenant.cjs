// Creates a tenant, its branding row and optionally its first admin, so a new
// install has someone who can sign in and run it. Safe to run again: an
// existing tenant is left as it is, and the admin row is created or promoted.
//
//   node scripts/bootstrap-tenant.cjs --slug acme --name "Acme Aviation" \
//     --aad-tenant-id <Entra directory id> [--domain acme.example] \
//     [--admin-email ops@acme.example] [--hostname learn.acme.example]
//
// Sign-in and the EXPECT_DB_USER check are the same as scripts/run-migration.cjs.
// A user lands in the tenant by their Entra directory (--aad-tenant-id,
// preferred) or, when no directory is pinned, by a verified email domain
// (--domain); one of the two is required (lib/auth/tenant-binding.ts).
const { connect } = require("./run-migration.cjs");

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith("--") || argv[i + 1] === undefined) throw new Error(`expected --name value pairs, got ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

function validate(args) {
  const known = ["slug", "name", "aad-tenant-id", "domain", "admin-email", "hostname"];
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`unknown option ${unknown.map((k) => `--${k}`).join(", ")}`);
  const slug = (args.slug || "").toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error("--slug must be lowercase letters, digits and hyphens");
  const name = (args.name || "").trim();
  if (!name || name.length > 256) throw new Error("--name is required (256 characters at most)");
  const aad = args["aad-tenant-id"] ? args["aad-tenant-id"].toLowerCase() : null;
  if (aad && !GUID_RE.test(aad)) throw new Error("--aad-tenant-id must be a directory (tenant) id GUID");
  const domain = args.domain ? args.domain.toLowerCase() : null;
  if (domain && !HOST_RE.test(domain)) throw new Error("--domain must be an email domain like acme.example");
  if (!aad && !domain) throw new Error("give --aad-tenant-id or --domain, or nobody can sign in to the tenant");
  const adminEmail = args["admin-email"] ? args["admin-email"].toLowerCase() : null;
  if (adminEmail && !EMAIL_RE.test(adminEmail)) throw new Error("--admin-email is not an email address");
  const hostname = args.hostname ? args.hostname.toLowerCase() : null;
  if (hostname && !HOST_RE.test(hostname)) throw new Error("--hostname must be a host name like learn.acme.example");
  return { slug, name, aad, domain, adminEmail, hostname };
}

const BOOTSTRAP_SQL = `
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @id UNIQUEIDENTIFIER = (SELECT TenantId FROM lms.Tenant WITH (UPDLOCK, HOLDLOCK) WHERE Slug = @slug);
DECLARE @created BIT = 0;
IF @domain IS NOT NULL AND EXISTS (SELECT 1 FROM lms.TenantDomain d JOIN lms.Tenant o ON o.TenantId = d.TenantId WHERE d.Domain = @domain AND o.Slug <> @slug)
    THROW 50001, 'that email domain already belongs to another tenant; nothing was written', 1;
IF @aad IS NOT NULL AND EXISTS (SELECT 1 FROM lms.Tenant WHERE AadTenantId = @aad AND Slug <> @slug)
    THROW 50002, 'that Entra directory is already pinned to another tenant; nothing was written', 1;
IF @id IS NULL
BEGIN
    SET @id = NEWID();
    SET @created = 1;
    INSERT lms.Tenant (TenantId, Slug, Name, AadTenantId, CustomHostname) VALUES (@id, @slug, @name, @aad, @hostname);
END
IF NOT EXISTS (SELECT 1 FROM lms.TenantBranding WHERE TenantId = @id)
    INSERT lms.TenantBranding (TenantId, CompanyName) VALUES (@id, @name);
IF @domain IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lms.TenantDomain WHERE Domain = @domain)
    INSERT lms.TenantDomain (TenantDomainId, TenantId, Domain) VALUES (NEWID(), @id, @domain);
IF @adminEmail IS NOT NULL
    MERGE lms.AppUser AS t
    USING (SELECT @id AS TenantId, @adminEmail AS Email) AS s ON t.TenantId = s.TenantId AND t.Email = s.Email
    WHEN MATCHED THEN UPDATE SET Role = 'admin'
    WHEN NOT MATCHED THEN INSERT (AppUserId, TenantId, Email, DisplayName, Role) VALUES (NEWID(), @id, @adminEmail, @adminEmail, 'admin');
COMMIT;
SELECT CONVERT(varchar(36), t.TenantId) AS TenantId, t.Slug, t.Name, t.AadTenantId, t.CustomHostname, @created AS Created
  FROM lms.Tenant t WHERE t.TenantId = @id;`;

async function bootstrap(argv, { env = process.env, sql = require("mssql"), log = console.log } = {}) {
  const t = validate(parseArgs(argv));
  const { pool } = await connect({ env, sql, log });
  try {
    if (env.CHECK_ONLY === "1") {
      log(`Check only: tenant ${t.slug} not written.`);
      return null;
    }
    const { recordset } = await pool
      .request()
      .input("slug", t.slug)
      .input("name", t.name)
      .input("aad", t.aad)
      .input("domain", t.domain)
      .input("adminEmail", t.adminEmail)
      .input("hostname", t.hostname)
      .query(BOOTSTRAP_SQL);
    const row = recordset[0];
    log(`${row.Created ? "Created" : "Kept existing"} tenant ${row.Slug} (${row.TenantId}).`);
    if (!row.Created && (row.Name !== t.name || (t.aad && row.AadTenantId !== t.aad) || (t.hostname && row.CustomHostname !== t.hostname))) {
      log("Note: the existing tenant's name, directory or host name differ from these options and were not changed.");
    }
    if (t.adminEmail) log(`${t.adminEmail} is an admin of ${row.Slug}.`);
    return row;
  } finally {
    await pool.close();
  }
}

module.exports = { bootstrap, validate, parseArgs, BOOTSTRAP_SQL };

if (require.main === module) {
  bootstrap(process.argv.slice(2)).catch((err) => {
    console.error(`Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
