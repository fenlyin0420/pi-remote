# pi-remote — development notes

The Pi plugin `remote-pi`. **The repository root is the package root**: `src/` is the source,
`dist/` is the compiled output.

## Build & test

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest
npm run typecheck
```

CI uses pnpm with `pnpm-lock.yaml`; npm is equivalent for local work (the npm lockfile is
gitignored).

**`dist/` is committed on purpose.** Pi installs this plugin from a git source, and a git
source is only cloned — never built. Anything that runs the compiled entry points (the Pi
extension itself, and the supervisor that keeps headless sessions alive: it resolves
`dist/bin/supervisord.js` relative to its own module and spawns it with plain `node`) needs
`dist/` to exist in the repository. When you change `src/`, rebuild and commit `dist/` in the
same commit.

## CI

- `ci.yml` — tests + typecheck, then `pnpm build` followed by
  `git diff --exit-code -- dist`: the committed `dist/` must be byte-identical to a fresh build
  of `src/`. Also runs the protocol drift check.
- `release.yml` — version tags `v<semver>` (this repository's own version line, independent of
  the phone app's) build the tarball and publish a GitHub release.

## Protocol (shared with the phone app)

`PROTOCOL.md` and `src/protocol/types.ts` are the authoritative wire contract. The Flutter
client mirrors them by hand, with no compile-time link, so both repositories run
`scripts/check-protocol-drift.mjs`:

```bash
node scripts/check-protocol-drift.mjs \
  --ts src/protocol/types.ts \
  --dart <app repo>/lib/protocol/protocol.dart \
  --fixtures .orchestration/contracts/fixtures
```

It checks three things: every field name declared in TS exists on the Dart side, every TS
discriminant literal (`type: "…"`) exists on the Dart side, and the wire fixtures match the
committed manifest (`scripts/protocol-fixtures.sha256`) — including against the other
repository's manifest. Intentional divergences go into `scripts/protocol-drift-allow.txt`.
Regenerate the manifest with `--write-manifest` after editing fixtures.

## Running locally

Install the plugin with `pi install git:github.com/<owner>/pi-remote`; Pi clones it under its
agent directory and a later `pi update --extensions` reconciles the checkout. Two things to keep
in mind when switching between a local build and the clone:

- The settings entry and the supervisor's extension path must resolve to the **same file**. Two
  different copies in one session make tool registration conflict and the session refuses to
  start.
- The supervisor reads its extension path once at startup, so restart it after the checkout
  changes if headless/paired sessions should pick up the new build.

`remote-pi install` writes the service unit and CLI shims from the location of the module that
runs it, so run it from the copy you intend to keep.
