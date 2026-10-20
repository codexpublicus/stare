---
name: doc-review
description: Review stare.pub's user- and agent-facing docs against what has actually shipped since the last review, fix every stale claim, and open one PR with a claim/where/was/now/source table. Use this whenever someone asks to review the docs, update the site docs, check the docs before a release, do a doc review, refresh /about, /data, llms.txt, openapi.json, AGENTS.md or the README, or asks whether the site still describes what's live, even if they don't say "doc review".
---

# Doc review

stare.pub's pages and the repo's docs drift behind what ships. This review finds what changed
since the last one, checks every description of those things against the live files and the
merged code, fixes what's stale, and records the commit it reviewed so the next run starts
there (codexpublicus/stare#201). It runs before each site release and on demand.

Static only: read git, GitHub and the public static files. Nothing here runs or changes
anything server-side, and the review never publishes an index build or deploys the site.

## 1. Set up

Work in a fresh worktree from `origin/main` (the repo's own rules: no `cd dir && cmd`, `gh`
as `env -u GITHUB_TOKEN -u GH_TOKEN gh`, mise with `MISE_EXPERIMENTAL=1`):

```
git -C <repo> fetch origin
git -C <repo> worktree add <repo>/.wt/<user>/doc-review-<date> -b docs/review-<date> origin/main
```

## 2. Find what changed and gather the live state

```
.claude/skills/doc-review/scripts/changes.sh [<base-ref>]
```

It prints the base (the commit in `docs/.reviewed-at`, else the last site release tag), every
commit on `main` since it with its PR number, the release notes of site releases since it,
the open PRs, and the live state: idx.stare.pub's root manifest and `reports/index.json`,
data.stare.pub, the production release and the main preview with each one's citare version,
WASM data bundle, `reporters.json` and `openapi.json` as served.

Then read each merged PR that could change a description (`gh pr view <n> -R
codexpublicus/stare --json title,body,files`), and the issue comments that record rulings
(the `D<N>` decisions). Skip pure dependency bumps unless they move citare.

Keep three kinds of truth apart; mixing them is the usual way a doc goes wrong:

- **Live data**: only what idx.stare.pub's root `manifest.json` names (`version`, `base`) is
  the live index, and only builds in `reports/index.json` were published. A build that exists
  on ml-01 or in a stare-builder PR but isn't in the root manifest isn't live, however ready.
- **Shipped code**: the repo docs and the site's pages describe the code on `main`, which the
  next release ships. Production may be a release or two behind (the script shows which), so
  a sentence about what stare.pub serves today, such as an issue comment or the README's
  status line, is checked against production, not the main preview.
- **Not shipped**: open PRs and open issues. Never describe their content as current.

Every number written into a doc comes from the live files or the merged code, not from a PR
description, an issue, a plan or memory. Quote the file it came from in the table.

## 3. List every description

Read, don't skim, each of these, and note every claim about versions, counts, sources,
features, URLs, paths, limits, headers and licences:

- Site pages: `web/src/pages/` (`index.astro`, `about.astro`, `data.astro`, `check.astro`
  and its help text, `updates.astro`), the components in `web/src/components/`, and the
  figures in `web/src/data/collection.json` and `web/src/lib/` (`jsonld.js`, `license.js`,
  `robots.js`, `sitemap.js`).
- Agent files: `web/public/llms.txt`, `web/public/openapi.json`, the JSON-LD
  (`web/src/lib/jsonld.js`), `schemas/*.schema.json` (`title`, `description`, `x-license`),
  and what `crates/stare/src/reporters.rs` writes into `reporters.json`.
- Repo docs: `AGENTS.md` (Repository Structure, Architecture, Current Status especially),
  `README.md`, `web/README.md`, `docs/` (plans are history; fix a plan only where AGENTS.md or
  README points readers to it as current).
- The CLI: `cargo run -q -p stare-cli -- --help` and each subcommand's `--help`, plus the doc
  comments in `crates/stare-cli/src/`.

`rg -n '<term>'` across these for each changed feature finds the stragglers (an old path, an
old version number, a feature called "planned" that shipped).

## 4. Compare and fix

For each claim, compare it with the live state or the merged code. Fix it in place when it's
stale; leave a correct one alone, and don't rewrite prose that's accurate just to restyle it.
Leave out of the edits anything a workflow owns: `CHANGELOG.md`, release tags,
`scripts/release-baseline`, and generated files such as `web/public/reporters.json`.

Writing rules for every line you add, in the docs, the commits and the PR:

- Plain, direct prose in the voice of the surrounding text. State what is true now; no
  "now supports" or "recently added", since the doc will be read long after.
- No em-dashes in new prose; use a semicolon, colon, comma or parentheses.
- Specific over vague: name the version, the count, the path, the PR.
- No references to AI, assistants, sessions or tooling in the docs, commit messages or PR
  text, and no attribution trailers or co-author lines.

If a claim can't be settled from the files (a ruling the owner hasn't made, a number only the
data build knows), leave the text and list it under "Open" in the PR instead of guessing.

## 5. Record the review

Write the reviewed `main` commit (the one the worktree branched from) to `docs/.reviewed-at`:

```
# The main commit the last doc review covered (.claude/skills/doc-review).
<full sha> <YYYY-MM-DD>
```

## 6. Check, commit and open the PR

Run `MISE_EXPERIMENTAL=1 mise run check`, and `mise run build-web` if a page or `llms.txt`
changed, since the build validates `robots.txt`, `llms.txt` and the sitemap. Commit as
Conventional Commits (`docs: ...`; a page change that ships is still `docs:` unless it fixes
behaviour). Push and open one PR, `docs: bring the docs up to date with <base>..<sha>`, whose
body has:

1. One line saying what range it reviewed and against which live index version.
2. The summary table, one row per changed claim:

   | Claim | Where | Was | Now | Source |
   |---|---|---|---|---|
   | citare version | `AGENTS.md` WASM table | 0.7.0 | 0.7.1 | #190 |

   Source is the PR that changed the fact, or the live file for a data fact
   (`idx.stare.pub/manifest.json`).
3. "Checked, still correct": the surfaces reviewed with nothing to change, in one line each.
4. "Open": claims left alone and why.
5. `Refs #201` (or the issue that asked for the run).

Write GitHub references in the PR as `#N` (GitHub links them). Don't merge it; the owner
reviews the table.
