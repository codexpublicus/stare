# stare.pub infrastructure, CI and the move to Workers: design

_2026-09-27. Implements codexpublicus/stare#3._

## Goal

stare.pub builds and deploys from GitHub Actions, runs on Workers Static Assets instead of the
hand-deployed `stare-pub` Pages project, and owns its infrastructure in this repository. Afterwards,
`codexpublicus-infra` holds nothing stare.pub-specific.

Done means:

- A push to `main` builds the WASM and the Astro site and deploys it to stare.pub.
- Every pull request runs the Rust checks and builds the site. It also uploads a preview version and
  comments its URL.
- `stare-infra/prod` owns every stare.pub resource: the zone, the records, `idx.stare.pub`, the
  deploy token and the Actions secrets. `codexpublicus-infra` has no stare.pub resources or outputs.
- stare.pub has no email.
- A fresh clone passes `cargo test --workspace` and `cargo clippy --workspace -- -D warnings`.

## Decisions

- **In-repo Pulumi.** A Python Pulumi project in `infra/`, stack `stare-infra/prod`, on the same
  R2 state backend as the other Codex Publicus stacks. It follows `codexpublicus/infra`'s AGENTS.md:
  - pulumi-cloudflare pinned at 6.13.0;
  - the shared-mock test pattern;
  - secrets in age-encrypted mise env or Pulumi secret config;
  - the operator runs every state-changing command, and agents stop at a preview.
- **The zone moves too.** `stare-infra/prod` reads only `account_id` from
  `organization/codexpublicus-infra/prod`. The stare.pub zone, its records, the `stare-pub-idx`
  bucket, its custom domain, CORS and R2 token move over by `pulumi state move`.
- **stare.pub email goes away.** It isn't moved. Once codexpublicus/stare#19 is live, nothing
  publishes `info@stare.pub`, and the project address is `info@codexpublicus.org`. The stare.pub
  email routing (settings, rule, catch-all) and its SPF record are deleted.
- **citare moves to the org.** `lokkju/citare` transfers to `codexpublicus/citare`, and the Cargo
  dependency moves to the new URL. CI reads it with a read-only deploy key that `stare-infra` creates
  on `codexpublicus/citare` and stores as an Actions secret on `codexpublicus/stare`.
- **Data buckets.** `stare-pub-idx` stays the index bucket on `idx.stare.pub`; renaming it to the
  plans' `codex-index` would mean a copy and a cutover for nothing. `codex-data` is created now,
  private, with no custom domain. Exposing it (`data.stare.pub`, a cache rule) and uploading the
  mirror from TrueNAS is its own ticket.
- **Pull requests get checks plus a preview.** `cargo fmt --check`, clippy with `-D warnings`,
  `cargo test --workspace`, the WASM build and the Astro build, then `wrangler versions upload` with a
  PR comment giving the preview URL. `main` runs the same build, then `wrangler deploy`.
- **Pinned tooling.** Actions pinned to commit SHAs, and wrangler pinned to an exact version, as in
  codexpublicus.org's deploy workflow (infra#17).

## Resources in `stare-infra/prod`

| Resource | Source |
|---|---|
| Zone `stare.pub` | moved from codexpublicus-infra (`zone-stare.pub`), protected |
| Apex CNAME to `stare-pub.pages.dev` | moved, then deleted at cutover |
| `stare-pub` Pages project, domain, deploy token | moved, then deleted after cutover |
| R2 `stare-pub-idx`, custom domain `idx.stare.pub`, CORS, R2 token | moved |
| Worker deploy token: Workers Scripts Write (account), Workers Routes Write and Zone Read (stare.pub zone) | new |
| Actions secrets on `codexpublicus/stare`: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CITARE_DEPLOY_KEY` | new |
| Deploy key on `codexpublicus/citare`, read-only | new |
| R2 `codex-data`, private, no domain | new |

**Deleted rather than moved:** stare.pub email routing settings, rule and catch-all, and the SPF TXT
record.

**Outputs:** `zone_id_stare.pub`, `worker_name`, `r2_bucket_stare-pub-idx`, `r2_bucket_codex-data`,
and the idx R2 token id and secret, the secret one wrapped.

The Worker itself isn't a Pulumi resource. `wrangler deploy` creates it and its custom domain from
`wrangler.jsonc`, the same model as codexpublicus.org.

## Site and CI

- **`wrangler.jsonc` at the repo root:**
  - name `stare-pub`;
  - `account_id` set, because the token is account-scoped and Wrangler would otherwise hit
    `/memberships` and fail with 9106;
  - `assets: { directory: "./web/dist" }`;
  - `routes: [{ pattern: "stare.pub", custom_domain: true }]`, added only at cutover, not in the
    first deploy;
  - `workers_dev: true` until cutover, for checking the Worker.
- **Headers:** `web/public/_headers` carries the security headers the Pages deploy had, if any. Check
  the live response headers before the move and keep parity.
- **The workflow** (`.github/workflows/site.yml`) runs these steps:
  1. Check out.
  2. Install the Rust toolchain with the `wasm32-unknown-unknown` target, and wasm-pack.
  3. Configure the citare deploy key as an SSH key for `git@github.com:codexpublicus/citare`.
  4. Run the Rust checks.
  5. `wasm-pack build` into `web/public/wasm`, the path the site already loads from.
  6. `npm ci` and `npm run build` in `web/`.
  7. On pull requests, `wrangler versions upload` and a PR comment with the preview URL. On `main`,
     `wrangler deploy`.
- **Green from a fresh clone first.** Six tests need `crates/stare/tests/fixtures/a2d-31.zip`, which
  is gitignored and fetched by hand. Either commit the fixture, if it's small and CC0 (the CAP data
  is), or have the tests fetch it with a cached download step in CI. Committing it is simpler and
  keeps the tests offline; do that unless the file is over about 5 MB. Fix the 7 existing clippy
  errors in the same change. This comes before the workflow becomes a required check.

## Cutover

The order matters. A hostname can't hold a Pages domain and a Worker custom domain at once, and a
Worker custom domain won't attach while a CNAME exists.

1. **Worker first.** Deploy the Worker with `workers_dev: true` and no route, and check the
   workers.dev URL: the resolve and viewer paths, the WASM loading from `/wasm/`, and the headers.
2. **State move.** Move the stare.pub resources from `codexpublicus-infra` to `stare-infra` with a
   versioned-provider procedure, as in codexpublicus/infra AGENTS.md. Both stacks' previews must
   show zero changes before any `up`. `codexpublicus-infra` drops `stare_pub.py`, the zone entry and
   the stare.pub outputs in the same step.
3. **Maintenance step,** with a gap of about a minute on the apex:
   - apply `stare-infra` to delete the Pages domain and the apex CNAME;
   - merge the PR that adds the custom-domain route to `wrangler.jsonc`, which deploys it;
   - check `https://stare.pub`.
4. **Pages removal.** Apply `stare-infra` to delete the `stare-pub` Pages project and its token.
5. **Email removal.** After stare#19 is live, apply the deletion of the stare.pub email routing and
   SPF.

## Tickets this spec creates

- stare: upload the mirror from TrueNAS to `codex-data`, and decide on `data.stare.pub` exposure and
  its cache rule.
- infra: remove stare.pub from `codexpublicus-infra` (tracked as part of the cutover, not separately,
  unless the state move slips).

## Risks

- **The cutover gap.** The apex is down between the CNAME delete and the custom domain attaching.
  Keep it to one sitting.
- **The citare transfer** changes the Cargo git URL. GitHub redirects the old SSH URL, so nothing
  breaks mid-change, but `Cargo.lock` records the URL, and the lock update belongs in the same PR.
- **Provider parity.** The state move needs both stacks on pulumi-cloudflare 6.13.0 and the same
  provider inputs, or `state move` fails with "provider ... already exists".
- **The deploy token's reach.** Workers Scripts Write can redeploy any Worker in the account,
  including `codexpublicus-lfs`. That's the same accepted risk as infra#17, and the same mitigation
  applies before any repo goes public.

## Amendment, 2026-09-29: the central infra repo

This replaces the "In-repo Pulumi" and "The zone moves too" decisions above, and the parked secrets
redesign (the closed stare#36).

**The model.** Infra repos provision, and app repos only deploy.
- `codexpublicus/infra` (stack `codexpublicus-infra/prod`) owns every Pulumi resource that carries
  the Codex Publicus name. That includes everything stare.pub needs: the zone, the idx bucket, the
  Worker deploy token, the citare deploy key, the stare Actions secrets and `codex-data`.
- This repo runs no Pulumi. Its CI holds only what the infra stack pushes into its Actions secrets
  (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CITARE_DEPLOY_KEY`), and it deploys with
  Wrangler.
- A stare.pub infrastructure change is a PR in `codexpublicus/infra`.

**Why.** Running Pulumi in each app repo means handing every repo state-backend credentials and a
passphrase. Each way of scoping those was either custom code (derived passphrases, a vending chain)
or a paid service: Pulumi Cloud gives per-stack CI tokens only on Pro. In the central model, stare's
CI holds one deploy token and one read-only deploy key. It can't read any state or decrypt
anything, and it can't touch a sibling. Everything uses stock Pulumi resources; codexpublicus-infra's
`site.py` already works this way for codexpublicus.org.

**Two roots, not a hierarchy.**
- `lokkju-infra` and `codexpublicus-infra` are peers. The Cloudflare account and the GitHub org were
  created by hand, and neither stack can create them.
- codexpublicus-infra reads nothing from lokkju-infra. `account_id` becomes plain stack config, and
  the `lokkju-infra` StackReference in `shared.py` goes away.
- codexpublicus-infra also owns the codexpublicus GitHub org's configuration: repos, settings,
  Actions secrets, deploy keys and rulesets, through `pulumi-github` with `owner=codexpublicus`. The
  org setting `deploy_keys_enabled_for_repositories` has no pulumi-github field; it's a one-time
  `gh api -X PATCH orgs/codexpublicus -F deploy_keys_enabled_for_repositories=true`, recorded in
  codexpublicus/infra's AGENTS.md.
- Secrets stay as they are today: age-encrypted mise env in each infra repo, with Pulumi run
  locally by the operator. Giving each root its own passphrase and state bucket, and running an
  infra repo's Pulumi in CI, come later and don't change this model. A GitOps controller (the
  Pulumi Kubernetes Operator with Flux and SOPS) fits the same shape; it isn't planned yet.

**What changes in this spec.**
- **`stare-infra/prod` is retired.**
  - `r2-codex-data` moves to codexpublicus-infra by `pulumi state move`. It's protected and
    `retain_on_delete`, and it must never be deleted.
  - The other resources are recreated there: the Workers deploy token, the three Actions secrets,
    the citare TLS key and deploy key, and the explicit GitHub provider. None of them holds data.
  - stare-infra is destroyed, then removed with `stack rm`. `infra/` and `.mise/tasks/pulumi` leave
    this repo.
- **The stare.pub zone and idx resources stay in codexpublicus-infra.** The "Move the survivors"
  step (plan Task 9) is cancelled. The Pages cutover and the email removal (Tasks 7 and 8) were
  already edits to codexpublicus-infra, so they're unchanged.
- **Done means,** revised: codexpublicus-infra owns every stare.pub resource; this repo has no
  `infra/` and no Pulumi credentials; the other criteria stand.
- **Outputs:** codexpublicus-infra exports `worker_name_stare-pub` and `r2_bucket_codex-data`, both
  plain.

**Tickets revised:** lokkju/infra#19, codexpublicus/infra#31 and codexpublicus/gorsuch-library#74
describe this model in place of derived passphrases. gorsuch's own un-applied `infra/` folds into
codexpublicus-infra the same way. The Workers KMS idea is parked as lokkju/meta#3.
