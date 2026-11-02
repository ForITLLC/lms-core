# Vendored auth source

This directory supplies the LMS build with auth source instead of a private
package-registry dependency. Its package manifest declares MIT, and the supplied
[MIT notice](LICENSE) is retained separately from the application's AGPL licence.
That upstream declaration and notice are the licence basis carried with this
component; they are not a certification of exclusive ownership of every
contributor's work.

The 20 source modules are byte-for-byte copies of `ForITLLC/forit-Common`
`packages/auth/src` at `8b89abd06736aceff4655a7ccc1b9441d1af45fc`. The notice input is
`d96a09d2358f15ebc453d16cf16ba1bc69e5f1e8`. `SOURCE.json` records
every input, exported-source and notice hash. One comment example address is rewritten
by the export script to an example domain; no executable implementation or trust default is changed.

The local manifest keeps version 0.13.0, the existing root, browser and Google exports,
and the optional Next/React peers. It is private and has no publish configuration or
package-local devDependencies: the LMS root supplies the locked compiler and framework.
The standalone tsconfig flattens the upstream NodeNext compiler settings. As upstream
has no package `type` field, NodeNext's existing CommonJS output mode is preserved.

Run `npm run build:auth` from the exported LMS root after installation; its predev,
prebuild, pretypecheck and pretest hooks do this automatically. This generates `dist`
before the unchanged LMS imports resolve the package's compiled export targets.
There is no install lifecycle script and no registry publication step.

The source route has passed a clean installation, auth compilation, a full LMS
production build and isolated standalone version startup on Node.js 20.20.2.
That check did not exercise real sign-in, cookies, database or provider flows.
