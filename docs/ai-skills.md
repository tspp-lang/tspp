# TS++ AI coding skill

The versioned [TS++ skill](../skills/tspp/SKILL.md) guides an AI coding agent through
project configuration, capsule-specific syntax and constraints, and verification
with the project's TS++ compiler. Capsule entries and their supporting references
are bundled with the skill so they remain available after installation.

## Install into a project

From the consuming project's root, replace `vX.Y.Z` with the TS++ release it uses:

```sh
npx skills add tspp-lang/tspp@vX.Y.Z --skill tspp --agent universal --copy --yes
```

Use a release tag that contains `skills/tspp/`; older tags created before this
skill was added do not contain it. The command uses the external
[Skills CLI](https://github.com/vercel-labs/skills) and copies the skill to
`.agents/skills/tspp/`. Commit the installed directory to share it with the team.
When changing TS++ versions, install the matching skill version again.

Client discovery varies. Add this instruction to the project's `AGENTS.md` when
explicit guidance is needed:

> Before writing, modifying or reviewing `.tspp` files, read
> `.agents/skills/tspp/SKILL.md` and follow its configuration and verification guidance.

## Maintain capsule content

Each feature shipped by the compiler owns `packages/plugins/<id>/skills/SKILL.md`.
Keep essential constraints and reading guidance in this entry. Add supporting
files under the same `skills/` directory when the feature needs more detail.
Use exactly one `name: tspp-<id>` and one `description` field, with plain,
single-line YAML string values and no additional frontmatter fields. The
description also supplies the feature's trigger text in the generated index.

The shared project workflow lives in `scripts/skills-entry.md`; feature-specific
instructions belong to their capsules. The generator reuses the shipped-plugin
list from `scripts/plugin-entries.mjs`, so internal test/support packages are not
included and a newly shipped capsule must provide its own skill entry.

```sh
pnpm build:skills   # regenerate skills/tspp/
pnpm check:skills   # report missing, edited or obsolete generated files without writing
pnpm test:skills    # test collection, references and stale-output handling
```

Commit the source changes and generated `skills/tspp/` changes together. The normal
root build regenerates skills; CI checks the committed output independently before
any build can update it. Release packaging also checks the committed output,
including when `--skip-build` is used. Skill generation needs only Node.js, with
no built compiler, plugin activation, dependency installation or network access.

## References and versions

The generator copies each complete capsule skill tree into
`skills/tspp/references/<id>/`. Relative Markdown links within that tree retain
their paths. Links to existing files or directories outside the capsule's
`skills/` tree are rewritten to GitHub `blob`/`tree` URLs pinned to `v<version>`
from the root `package.json`. Anchors are retained. New skills and references
become available through versioned URLs only after a new release tag contains
them. An already published tag does not pick up changes from this working tree;
bump the root version and regenerate the skill when preparing that release.

Use standard inline Markdown links/images or reference-style link definitions.
For destinations containing spaces or parentheses, use `<...>` around the
destination. Links in fenced code examples are left alone. Missing local link
targets fail generation; remote URLs and heading anchors are not fetched or
validated. Symlinks are rejected so the installed resources come from the
maintained skill tree.

The generated directory is owned by the script: regeneration removes obsolete
files there. Edit the capsule sources or shared template instead of editing the
generated copies.
