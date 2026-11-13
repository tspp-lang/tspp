# Releasing TS++

A TS++ release is the `version` of the root `package.json`. Set it and regenerate
the versioned AI skill with `pnpm build:skills`: when the change reaches master
and the checks pass, CI assembles the release, tests it, tags the commit and
publishes it on GitHub Releases.

## What a release contains

Each release attaches three files, all at the root version:

- `ts-plus-plus-X.Y.Z.tgz`, the compiler package. The feature plugins and the
  plugin SDK travel inside it as bundled dependencies, and projects name the
  plugins `ts-plus-plus/plugins/<name>`.
- `tspp-vscode-X.Y.Z.vsix`, the VS Code extension. It carries the language
  server and the compiler it runs.
- `tspp-playground-X.Y.Z.zip`, the playground as a static site, with
  `index.html` at the root of the zip. It loads Z3 from `z3/<hash>/`, a
  directory named by the content of the Z3 files, under the `sharedRoot` that
  its `deployment.json` gives. It is built as a release
  (`TSPP_PLAYGROUND_CHANNEL=release`), so it names itself by its version.

Nothing is published to npm or the VS Code Marketplace.

The release tag also contains the generated `skills/tspp/` directory. The
[AI skill installation command](ai-skills.md) installs it directly from that tag;
it does not need a separate release attachment.

Only the root version changes between releases. Leave the other versions in the
repository as they are:

- `packages/compiler/package.json` keeps the TypeScript version the compiler
  implements, such as `6.0.3`. The released manifest records it as
  `typescriptVersion`, and the language server reads that field to decide which
  TypeScript features to offer.
- Every other package is internal, stays at `0.0.0` and is never published on
  its own. So do the plugin manifests' `version` fields. Compatibility between
  the host and the plugins is checked by `TSPP_PLUGIN_API_VERSION`, not by these
  versions.

## Steps

1. **Set the version on dev.** Change `version` in the root
   `package.json`, for example to `0.2.0`, run `pnpm build:skills`, and commit
   the version and regenerated `skills/tspp/` together, for example as
   `chore(release): 0.2.0`. Do not create the tag yourself; the release creates
   it.

2. **Optionally, rehearse locally.** These are the commands the release runs:

   ```sh
   node scripts/release-version.mjs   # says whether the version is unreleased
   pnpm pack:release                  # builds, then assembles release/
   pnpm test:release                  # installs release/ into an empty project and exercises it
   ```

   Run them one after another, not in parallel; the build and the test each need
   a lot of memory.

3. **Merge into master and push.** The push starts the `TSPP` workflow. When it
   succeeds, `.github/workflows/release.yml` starts on the commit it checked. The
   commit may be behind master by then. The release workflow:
   1. runs `scripts/release-version.mjs` to find whether the version is released;
   2. runs `pnpm pack:release` and `pnpm test:release` on that commit;
   3. runs `gh release create vX.Y.Z`, which tags the commit, attaches both files
      and generates the release notes.

4. **Check the result** on the repository's Releases page.

## Choosing the version

While TS++ is at 0.x:

| Change | Bump | Example |
| --- | --- | --- |
| A breaking change: a commit marked `!`, or a new `TSPP_PLUGIN_API_VERSION` | minor | `0.1.0` → `0.2.0` |
| Fixes and other compatible changes | patch | `0.1.0` → `0.1.1` |
| A test build ahead of a release | prerelease | `0.2.0-beta.1` |

A version with a prerelease part is published as a GitHub prerelease.

## When something goes wrong

| What happened | Result | What to do |
| --- | --- | --- |
| The `TSPP` checks fail or are cancelled | Nothing is released | Fix and push to master again; the next passing run releases the version, because it is still untagged |
| The release workflow itself fails, for example on the network | No tag is created | Re-run that run from the Actions page |
| A push leaves the version unchanged | The tag exists, so the release is skipped | Nothing |
| The version is below one already released | `scripts/release-version.mjs` fails the `TSPP` checks, so nothing is released | Set a version above the latest release |
| A published release is broken | It is out | Release a new patch version rather than deleting and reusing the version |

`scripts/release-version.mjs` reads the `vX.Y.Z` tags on origin and compares
versions by SemVer precedence. It ignores `v0.0.0`, which marks the upstream
TypeScript commit this fork started from, not a TS++ release.

## The playground site

After TSPP passes on a push to `master` or `dev`, the Pages workflow publishes
the tested preview for that branch. A single workflow on `master` assembles and
deploys the whole site. It restores the other branch's zip from the last
successful Pages deployment and checks its checksum, preserving its assets and URLs.
Release updates reuse both published previews. A failed build or a missing
published archive leaves the live site in place.

| Path | Serves |
|---|---|
| `/` | Redirects to the latest stable release, or to `/master/` before one is available |
| `/master/` | The published Master preview |
| `/dev/` | The published Dev preview, once it passes checks |
| `/v/X.Y.Z/` | Every release whose GitHub release carries a playground zip |
| `/z3/<hash>/` | One copy of each Z3 the builds above load |
| `/versions.json` | The previews and releases available in the version selector |

The first Master publication can also seed Dev from its latest successful push
with a preview archive. To publish a tested preview manually, run the Pages
workflow on `master` and select the branch to update.

Each release is served from its own zip, so it runs the code it was released
with. The site updates the archived v0.1.0 page's version selector to use the
published branch links. The root redirect carries the query string and project
hash to the target.
The version selector opens the chosen version with the current project, and Share
copies the editor's current URL. A build whose Z3 changes gets a new `/z3/<hash>/`, and the old one
stays for as long as a served release uses it.
