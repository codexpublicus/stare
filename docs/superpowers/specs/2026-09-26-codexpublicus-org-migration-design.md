# Codex Publicus GitHub organization: migration design

_2026-09-26_

## Goal

Codex Publicus is the umbrella name; stare.pub and the Neil Gorsuch Library are its projects. Both
repos move into the `codexpublicus` GitHub organization, which also gets a repo for the umbrella
site on codexpublicus.org and a repo for the infrastructure the Codex Publicus sites share.

Done means:

- Both projects live in the org with their history, issues, labels and milestones intact.
- codexpublicus.org serves an umbrella page.
- Nothing Codex Publicus-specific is left in `lokkju/infra` beyond the account-level values it
  exports.

## Decisions

- **Transfer, not recreate.** GitHub keeps issues, labels and milestones on a transfer and redirects
  the old repo URLs and cross-repo issue references.
- **`lokkju/codex-publicus` becomes `codexpublicus/stare`.** The crates are already named `stare`.
- **Every repo stays private for now.** The org is on the Free plan, where organization secrets only
  reach public repos, so secrets are set per repo; Pulumi pushes them, the way `lokkju-infra` does
  today. Going public is a later decision and waits on the code license (codex-publicus#4).
- **The `lokkju` Cloudflare account, behind one indirection.** Codex Publicus resources stay in the
  existing account. Site repos read shared values only from the `codexpublicus-infra/prod` stack,
  which re-exports `account_id` from `lokkju-infra/prod`. Moving to a dedicated account later then
  changes one repo, not every consumer.
- **Each organization deploys its own LFS proxy.** The code is a fork of
  [ken109/r2-lfs](https://github.com/ken109/r2-lfs) at `lokkju/r2-lfs`; `codexpublicus/infra`
  deploys an instance of it for Codex Publicus repos.
- **codexpublicus.org is a single static page**, with no framework and no Pulumi of its own.

## Repositories

| Repo | Origin | Owns |
|---|---|---|
| `codexpublicus/stare` | transfer and rename of `lokkju/codex-publicus` | the site, crates and mirror config; its own Pulumi later (codex-publicus#3) |
| `codexpublicus/gorsuch-library` | transfer of `lokkju/gorsuch-library` | its own Pulumi project (gorsuch-library#63) |
| `codexpublicus/infra` | new, private | Pulumi project `codexpublicus-infra`, stack `prod` |
| `codexpublicus/codexpublicus.org` | new, private | the umbrella page |
| `lokkju/r2-lfs` | fork of `ken109/r2-lfs` | the LFS Worker code, with our patches |

## `codexpublicus-infra/prod`

A Python Pulumi project, matching `lokkju-infra`. Its state goes in the same R2 backend as
`lokkju-infra`, and an operator runs it from a workstation, not CI.

**Resources.**

- **The `codexpublicus.org` and `codexpublicus.com` zones.** Both are registered on Cloudflare
  and get imported. `.com` redirects to `.org`.
- **The `stare.pub` zone,** imported. It exists in the account but no code manages it today.
- **Zone-wide edge rules.** A zone has one entry-point ruleset per phase, so the rules live here,
  next to their zone, and sites add entries to them. The first entries are the cache and
  compression rules for the Gorsuch data host (lokkju/infra#14).
- **The r2-lfs Worker** on a stable hostname under `codexpublicus.org`, with:
  - the R2 credentials and per-repository config as Worker secrets and vars;
  - the per-repository buckets and bucket-scoped keys, which the owning repo's Pulumi creates and
    this project takes as secrets.
- **The umbrella site:**
  - a Pages project for `codexpublicus.org`;
  - the apex DNS record;
  - a deploy token pushed to `codexpublicus/codexpublicus.org`'s Actions secrets.

**Exports.**

- `account_id`, read from `lokkju-infra/prod`.
- `zone_id_codexpublicus.org`, `zone_id_codexpublicus.com` and `zone_id_stare.pub`. These use the
  output names `lokkju-infra` already uses for zones, so gorsuch-library's planned stack reference
  only changes its stack name.
- `lfs_proxy_url`.

## r2-lfs

Upstream already has:

- presigned R2 URLs, with the R2 keys held only in Worker secrets;
- operator tokens and a git credential helper;
- GitHub Actions OIDC verified against GitHub's JWKS, with the `repository` and `repository_id`
  claims checked;
- read-only access for CI;
- one instance per organization, through `ALLOWED_REPOS`.

infra#13 needs two changes on top of that.

1. **Check the `ref` claim.** Add `ref` to the Actions claims and an allowed-refs setting per
   repository, and enforce it in `authorize.ts`.
2. **Per-object allow list for CI.** Refuse a CI download whose object id isn't on the repository's
   list, with a 403, in both presigned mode (`planObject`) and proxy mode (`download`).
   - The list lives in R2 at `allowlist/{owner}/{repo}.json`.
   - The owning repo's Pulumi uploads it on `pulumi up` from the committed file (gorsuch-library:
     `lfs-policy/ci-readable.txt`).
   - A job's own branch can never change what CI may read, and the Worker needs no GitHub
     credential.

**Tests.** The policy check is the security boundary, so each of these cases gets a direct test:

- a write from CI;
- a download of an object not on the list;
- an OIDC token from another repository;
- an OIDC token from a ref that isn't allowed.

**Upstream.** Upstream is two weeks old and has one maintainer. The fork pins a release, carries our
changes as a small patch, and takes upstream releases only after review, using upstream's
`scripts/upgrade-from-upstream.sh`. We offer both changes upstream.

## Umbrella site

`codexpublicus/codexpublicus.org` holds one hand-written HTML page and a stylesheet: what Codex
Publicus is, links to stare.pub and the Neil Gorsuch Library, contact details and license terms. The
CSS is plain or uses Open Props, and is self-hosted. Whether the sites share a design system stays
open (codex-publicus#5). A GitHub Actions workflow deploys it to Pages on push to `main`.

## Order of work

Independent steps run in parallel. Step 1 comes before step 2, and step 3 comes before the
deploy parts of steps 4 and 5.

1. **Clean up before the transfer.**
   - Scan both repos' full history with gitleaks, run through Docker.
   - Remove `target/` from `lokkju/codex-publicus`'s history with `git filter-repo`. It is 835 MB
     of `target/debug` blobs from an early commit made before `.gitignore` covered it.
   - Force-push the rewritten history, and replace the local clone with a fresh one.
   - Keep `mirror/urls*.txt`: `docker-compose.yaml` uses them and no script regenerates them.
   - Leave the age-encrypted credentials in `mise.toml`'s history until the repo goes public.
2. **Transfer.**
   - Rename `lokkju/codex-publicus` to `stare` and transfer it to the org.
   - Transfer `lokkju/gorsuch-library` to the org.
   - Update the local remotes, README, AGENTS.md and project memory to the new names.
3. **Create `codexpublicus/infra`.**
   - Close lokkju/infra#12 (export `account_id`) in `lokkju-infra`.
   - Import the zones, then add the `.com` redirect, the edge rules and the exports.
4. **r2-lfs.**
   - Fork to `lokkju/r2-lfs`, pin a release, and add the `ref` check and the allow list with their
     tests.
   - Deploy the Worker from `codexpublicus/infra` and export `lfs_proxy_url`.
5. **Umbrella site.**
   - Create the repo and write the page.
   - Create the Pages project in `codexpublicus/infra` and deploy from Actions.
6. **Consumers.**
   - Point gorsuch-library#63 and codex-publicus#3 at `codexpublicus-infra/prod`.
   - Update gorsuch-library's infrastructure spec to match.

## Tickets

GitHub only transfers issues between repos with the same owner.

- **lokkju/infra#11, #13 and #14:** recreate them in `codexpublicus/infra`, then close the originals
  with a link to the new ones.
- **lokkju/infra#12:** closes in place when step 3 exports `account_id`.
- **lokkju/infra#6:** gets a comment. The Codex Publicus org exists; the question of an org for
  lokkju's own repos is still open.
- **gorsuch-library#63 and codex-publicus#3:** get their stack reference and prerequisite links
  updated.

## Amendments after reading the r2-lfs and gorsuch-library sources (2026-09-26)

These amend the sections above. The implementation plan follows these where they differ.

- **One LFS bucket for the organization, not one per repository.**
  - An r2-lfs instance binds one bucket and keeps each repository under an `{owner}/{repo}/`
    prefix. `codexpublicus-infra` owns that bucket (`codexpublicus-lfs`) and its bucket-scoped
    key.
  - gorsuch-library's Pulumi no longer creates an LFS bucket or LFS keys, and
    `codexpublicus-infra` reads nothing from gorsuch-library's stack.
- **The allow list is an R2 object the operator uploads.**
  - It lives at `_allowlist/{owner}/{repo}.txt` in the LFS bucket. Upstream keeps every internal
    key under a `_` root, which no GitHub owner name can start with.
  - The format is gorsuch-library's `lfs-policy/ci-readable.txt`: one lowercase 64-hex object id
    per line, sorted and unique, with a newline after every line.
  - The operator uploads it with `wrangler r2 object put`, so no consumer stack holds a key to the
    org's bucket. A missing or malformed list refuses every CI download.
- **Edge-rule hosts are `codexpublicus-infra` config.** The data hosts the cache and compression
  rules match (`data.gorsuch.codexpublicus.org` first) are a list in `Pulumi.prod.yaml`, not an
  output read from gorsuch-library's stack.
- **Deploying the Worker.** Wrangler deploys it from a pinned tag of `lokkju/r2-lfs`, using a
  `wrangler.jsonc` kept in `codexpublicus/infra`. The build uses Vite, a Durable Object and admin
  assets, none of which Pulumi reasonably owns. Pulumi owns the bucket, the Worker's R2 key and the
  operator token, and its outputs feed `wrangler secret put`. Wrangler creates the custom domain
  `lfs.codexpublicus.org`.
- **The operator token** is an `AUTH_TOKENS` entry, `codexpublicus/*:rw:<token>`, with the Worker
  in `AUTH_MODE=token`.
- **The history rewrite doesn't re-clone.** The working clone resets to the rewritten `origin/main`
  and prunes, which keeps its untracked files (`.claude/`, `data/`, `web/node_modules`).
- **The public-fork caveat.** GitHub forks of public repositories are public, so `lokkju/r2-lfs`
  is public. The patches hold no secrets.

## Risks

- **The history rewrite changes every commit SHA** in `codex-publicus`. SHA links in issue text
  break. There are no forks. Any other clone, including one on ml-01 for the mirror, gets
  re-cloned, not pulled.
- **Neither repo has Actions secrets or webhooks today,** so the transfer has nothing to re-add.
- **stare.pub's Pages project is still deployed by hand** until codex-publicus#3 lands. The transfer
  doesn't change that.
