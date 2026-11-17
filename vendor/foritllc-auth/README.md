# Vendored auth source

This directory supplies the LMS with Auth 0.29.3 source instead of a private
package-registry dependency. The upstream manifest declares MIT; its existing
[MIT notice](LICENSE) is retained unchanged and separately from the application's
AGPL licence. That declaration and notice are the licence basis carried here,
not a certification of exclusive ownership of every contribution.

All 30 Node runtime source modules come from `ForITLLC/forit-Common`
`packages/auth/src` at `0f5a9c450a805c865e043a33f54c53af1ba9014e`.
`SOURCE.json` records each exact Git blob, upstream byte count/SHA256 and exported
SHA256. Local comment-only adaptations replace an example address, customer
references, internal incident details and deployment identifiers with generic
wording; executable source and trust defaults match that release. The retained notice
input remains `d96a09d2358f15ebc453d16cf16ba1bc69e5f1e8`.

The curated local manifest keeps the published version, Node export targets,
production `jose` dependency and Next peer. It is private and has no publish
configuration, install script or package-local devDependencies. The root supplies
the locked TypeScript compiler and framework. Its flattened NodeNext/ES2022
configuration preserves upstream's CommonJS output mode. This source bundle does
not include the npm archive's separate Python payload.

Run `npm run build:auth` from the LMS root after installation. Its predev,
prebuild, pretypecheck and pretest hooks compile `src` into `dist` before the app
imports the package. Installation continues to use `file:vendor/foritllc-auth`
and public dependencies; no private registry token is required.

The 0.29.3 refresh passed a clean anonymous install, auth compilation, typecheck,
all 749 unit tests, course validation and production build on 2026-11-17 using
Node.js 20.20.2 and npm 10.8.2. Standalone startup with a synthetic session secret
returned HTTP 200 and the checked revision from `/api/version`. Those checks do
not establish real sign-in, cookie, database or provider acceptance.
