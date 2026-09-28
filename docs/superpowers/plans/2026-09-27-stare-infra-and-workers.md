# stare.pub Infrastructure, CI and Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stare.pub builds and deploys from GitHub Actions to Workers Static Assets. Its infrastructure lives in this repo's `stare-infra/prod` stack. `codexpublicus-infra` keeps nothing stare-specific. The deployed index data in `stare-pub-idx` is never at risk.

**Architecture:**
- CI goes green from a fresh clone first.
- `citare` moves to the org.
- A new in-repo Pulumi project creates the deploy credentials and the `codex-data` bucket.
- A workflow builds the WASM and the site, uploads preview versions on PRs, and deploys on `main`.
- Cutover swaps the apex from Pages to the Worker.
- stare.pub's email is deleted.
- The surviving resources (the zone, and the idx bucket with its domain, CORS and token) move by `pulumi state move` into `stare-infra/prod`.

**Tech Stack:**
- Rust (cargo, clippy, wasm-pack 0.13, the wasm32 target)
- Astro 6 on Node 22 (npm)
- Pulumi 3 with Python via uv: pulumi-cloudflare pinned at 6.13.0, pulumi-github 6.x, pulumi-tls
- Wrangler 4, pinned exactly
- GitHub Actions, pinned by commit SHA
- mise, using `.mise/config.toml` and `.mise/tasks/`

**Spec:** `docs/superpowers/specs/2026-09-27-stare-infra-and-workers-design.md`. This plan changes its cutover order; see "Deviations from the spec" below.

## Global Constraints

- **The deployed index data must survive every step.**
  - `stare-pub-idx` holds 60,195 objects (289.3 MB), measured 2026-09-27 with `s5cmd du`.
  - It's never deleted and never recreated. It's declared `protect=True` and `retain_on_delete=True` in whichever stack owns it.
  - Its object count and byte total are re-checked after every `up` that touches either stack.
  - A backup copy exists before any stack surgery.
- **The raw corpus is out of scope and must stay untouched.** It's the TrueNAS NFS share `mega/codex-publicus`, mounted in ml-01's `codex-mirror` container at `/aria2/data`, about 10.4 TB. As of 2026-09-27 it holds 40,622 zips and 39,964 each of tars and PDFs. No task reads, writes, moves or deletes anything on TrueNAS or ml-01. The site keeps reading case data from static.case.law. `codex-data` starts empty.
- **The operator runs every state-changing command:** `pulumi up`, `import`, `state` and `config set`, `wrangler deploy` outside CI, and the `gh repo transfer`. Agents stop at `pulumi preview` and hand over one-line commands with `--yes`, with exact expected counts, including the unchanged count.
- **pulumi-cloudflare stays at `==6.13.0`** in `infra/pyproject.toml`, matching `codexpublicus-infra` and lokkju-infra. A test asserts the pin.
- **The stack is `organization/stare-infra/prod`** on backend `s3://lokkju-pulumi-state?endpoint=https://441c9b9997aeedf42f0c48d5bdb996cb.r2.cloudflarestorage.com&region=auto`, with the same `PULUMI_CONFIG_PASSPHRASE`. It reads only from `organization/codexpublicus-infra/prod`.
- **Fixed identifiers:**
  - Cloudflare account `441c9b9997aeedf42f0c48d5bdb996cb`.
  - stare.pub zone id `b103fb4c3e45425bcd037f8857620f19`.
  - The source stack's provider URN `urn:pulumi:prod::codexpublicus-infra::pulumi:providers:cloudflare::default_6_13_0`, id `930b2849-ee7a-4a7c-a438-0c11bcd8a0bf`.
  - Worker name `stare-pub`.
- **Wrangler:** `account_id` goes in `wrangler.jsonc`, because the token is account-scoped and without it Wrangler fails on `/memberships` with 9106.
- **Actions** are pinned to full commit SHAs with a version comment. Wrangler is pinned to an exact version.
- **Shell and git habits:** never use `cd dir && cmd`; use `uv run`, never bare python. Commits are conventional, with the subject under 50 characters and no AI attribution. Prose has no em-dashes.
- **Worktrees:** each task works in its own git worktree. The main checkouts belong to the operator.

## Deviations from the spec (ruled at planning time)

- **Delete in the source stack first, then move only the survivors.**
  - The Pages project, Pages domain, apex CNAME and Pages token are deleted in `codexpublicus-infra` at cutover.
  - stare.pub email routing and its SPF record are deleted there afterwards.
  - Only the 5 surviving resources move: `zone-stare.pub`, `r2-stare-pub-idx`, `r2-domain-stare-pub-idx`, `r2-cors-stare-pub-idx` and `r2-token-stare-pub-idx`.
  - This moves less state and copies less code. Until the move, `stare-infra` reads `zone_id_stare.pub` from the org stack.
- **The Pages project is deleted a week after cutover, not at cutover.** That keeps a one-record rollback.
- **The bucket gets protected and backed up first.** This is new, at the operator's request.

## Review Focus

1. **Any code change that stops declaring `r2-stare-pub-idx`, in either stack,** while that stack still owns it in state. Pulumi would plan a delete. `retain_on_delete` limits the damage, but the preview gates must catch it first. Task 1 adds `retain_on_delete`, and each later task's gate names this resource.
2. **The state move with mismatched declarations.** The destination must declare the 5 resources with identical names, types and inputs, or the first preview shows replacements. Task 9 tests the inputs against the source.
3. **CI checking out citare.** The deploy key must be read-only and scoped to `codexpublicus/citare` only. Task 4 tests `read_only=True`.
4. **The apex gap at cutover.** Keep it to one sitting, and have rollback commands ready (Task 7).
5. **Preview URLs and security headers.** They depend on `workers_dev` or `preview_urls` and on `_headers` being honored. Task 6 checks both on a real PR.

---

## Parallel tracks

| Track | Tasks | Needs |
|---|---|---|
| A: fresh-clone green, mise | 2 | nothing |
| B: citare transfer | 3 | operator runs the transfer |
| C: safeguards | 1 | operator `up` and backup |
| D: stare-infra | 4, then 5 | 3 (deploy key target), operator `up` |
| E: site and CI | 6 | 2, 5 |
| F: cutover, email, move | 7, then 8, then 9 | 1, 6 |
| G: wrap-up | 10 | all |

Tasks 1, 2 and 3 start together.

---

### Task 1: Protect and back up `stare-pub-idx` (codexpublicus/infra)

**Files:**
- Modify: `pulumi/codexpublicus_infra/stare_pub.py`: bucket and custom-domain options
- Test: `pulumi/tests/test_stare_pub.py`

**Interfaces:**
- Produces: `r2-stare-pub-idx` and `r2-domain-stare-pub-idx` with `protect=True, retain_on_delete=True`.

- [ ] **Step 1: Record the baseline.**
  Run it with codex-publicus's mise env:
  ```
  mise exec --cd /home/lokkju/projects/lokkju/codex-publicus -- s5cmd --endpoint-url "$AWS_ENDPOINT_URL_S3" du "s3://stare-pub-idx/*"
  ```
  Expect `289...M bytes in 60195 objects`, or more if the index grew. Put the exact numbers in the task report; they're the baseline for every later gate.
- [ ] **Step 2: Write the failing test.**
  In `test_stare_pub.py`, capture resource options through the mock. The shared `conftest.py` records `args.inputs` only, so extend `created` to record `(typ, name, inputs, options)`, where `args.custom` and options come from the mock's `new_resource` args. If the mock API doesn't expose protect or retain, test through a small helper instead: `stare_pub.index_bucket_options()` returns the `ResourceOptions`, and the test asserts `protect is True` and `retain_on_delete is True`.
  ```python
  def test_index_bucket_is_protected_and_retained():
      opts = stare_pub.index_bucket_options()
      assert opts.protect is True
      assert opts.retain_on_delete is True
  ```
  Run: `uv run --directory pulumi pytest -q tests/test_stare_pub.py`. Expected: FAIL (`AttributeError: index_bucket_options`).
- [ ] **Step 3: Implement it.**
  In `stare_pub.py`:
  ```python
  def index_bucket_options(**extra) -> pulumi.ResourceOptions:
      """stare-pub-idx holds the deployed citation index; never let Pulumi delete it."""
      return pulumi.ResourceOptions(protect=True, retain_on_delete=True, **extra)
  ```
  Pass `opts=index_bucket_options()` to the R2Bucket, and `opts=index_bucket_options(depends_on=...)` to R2CustomDomain, merging with any existing options.
- [ ] **Step 4: Test and preview.**
  - `uv run --directory pulumi pytest -q`: all pass.
  - `pulumi preview --stack prod --diff`: expect `38 unchanged`, with no create, update, delete or replace. Protect and retain are state-only.
- [ ] **Step 5: Commit, PR and merge.**
  Commit as `fix(stare): protect and retain the index bucket`, then open the PR and merge it.
- [ ] **Step 6: Operator runbook.**
  1. `git -C /home/lokkju/projects/lokkju/codexpublicus-infra pull --ff-only`
  2. `mise exec --cd /home/lokkju/projects/lokkju/codexpublicus-infra -- pulumi -C /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi up --stack prod --yes`. Expect 0 changes.
  3. Back up to TrueNAS:
     ```
     mise exec --cd /home/lokkju/projects/lokkju/codex-publicus -- s5cmd --endpoint-url "$AWS_ENDPOINT_URL_S3" sync "s3://stare-pub-idx/*" /mnt/truenas/codex-publicus/backups/stare-pub-idx-2026-09-27/
     ```
     Adjust the local path if needed. Expect 60,195 files. Check with `find <dir> -type f | wc -l`.
- [ ] **Step 7: Controller verifies.**
  `pulumi stack export`, piped through jq, shows `protect: true` and `retainOnDelete: true` on both resources. The bucket still holds 60,195 objects.

---

### Task 2: Fresh-clone green, and mise layout (codexpublicus/stare)

**Files:**
- Modify: `crates/stare/tests/fixtures/.gitignore`, which gets a `!a2d-31.zip` exception.
- Add: `crates/stare/tests/fixtures/a2d-31.zip` (422,856 bytes, from `https://static.case.law/a2d/31.zip`, etag `b4894af85617122a6235c16fdd8c87c2`; CAP data is CC0).
- Modify: `crates/stare/src/{alto,case,cite,config,index,resolve}.rs`, to fix the doc comments (`///` followed by a blank line becomes `//!` module docs), and `alto.rs:138` to collapse the match.
- Replace: `mise.toml` with `.mise/config.toml` (keeping the `[env]` age values and `[settings.age]` exactly).
- Create: `.mise/tasks/check`, `.mise/tasks/build-wasm`, `.mise/tasks/build-web`.

- [ ] **Step 1: RED.** In a fresh clone (`git clone` into a scratch dir), `cargo test --workspace` shows 6 failures from the missing fixture, and `cargo clippy --workspace --all-targets -- -D warnings` shows 7 errors. Record both.
- [ ] **Step 2: Add the fixture.** `curl -4 -sfo crates/stare/tests/fixtures/a2d-31.zip https://static.case.law/a2d/31.zip`, then check that its size is 422856 bytes. Add `!a2d-31.zip` to the fixture `.gitignore`.
- [ ] **Step 3: Fix the 7 clippy errors.**
  - `empty_line_after_doc_comments` at `alto.rs:4`, `case.rs:1`, `cite.rs:4`, `config.rs:4`, `index.rs:5` and `resolve.rs:3`: convert each leading `///` block to `//!`.
  - `collapsible_match` at `alto.rs:138`: collapse it.
- [ ] **Step 4: Move mise to `.mise/`.**
  - `.mise/config.toml`:
    - `[tools]`: keep `claude` and `s5cmd`, and add `node = "22"`, `"cargo:wasm-pack" = "0.13.1"` (or the aqua or ubi backend if that's faster), `wrangler = "4.141.0"`, `pulumi = "latest"` and `uv = "latest"`.
    - Keep `[env]` and `[settings.age]` byte-for-byte.
  - Delete `mise.toml`.
  - Tasks, each using the `#MISE` header:
    - `build-wasm`: `wasm-pack build crates/stare-wasm --target web --out-dir ../../web/public/wasm`. Check the relative out-dir: wasm-pack's `--out-dir` is relative to the crate.
    - `build-web`: `npm --prefix web ci && npm --prefix web run build`.
    - `check`: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`.
- [ ] **Step 5: GREEN.** In a fresh clone of the branch, run `mise trust`, then `mise run check`, `mise run build-wasm` and `mise run build-web`. All pass, and `web/dist/index.html` exists.
- [ ] **Step 6: Commit and PR.** Split it into three commits: `test: commit the a2d-31 fixture`, `style: fix clippy doc-comment lints`, `build: move mise config to .mise/`. Open the PR and merge it.

---

### Task 3: Transfer citare to the org

**Files:**
- In codexpublicus/stare: `crates/stare/Cargo.toml` and `Cargo.lock`.
- In the citare repo: `Cargo.toml` `homepage` fields and README badges.

- [ ] **Step 1: Operator transfers the repo.**
  ```
  gh api -X POST repos/lokkju/citare/transfer -f new_owner=codexpublicus
  ```
  Then confirm with `gh repo view codexpublicus/citare --json visibility`. Expect PRIVATE.
- [ ] **Step 2: Update the dependency.** In stare, switch the dependency to `ssh://git@github.com/codexpublicus/citare.git`, keeping `tag = "v0.2.0"`. Run `cargo update -p citare-core -p citare-data-build`. `Cargo.lock` should now show `codexpublicus/citare`, still on commit `1c8cdf43d1adcea379f0799afc89117b10e547e4`.
- [ ] **Step 3: Build.** `mise run check` and `mise run build-wasm` both pass.
- [ ] **Step 4: Commit, PR and merge.** Commit as `build: fetch citare from codexpublicus`. In the citare repo, update the `homepage` URLs and badges in a separate PR.

---

### Task 4: Scaffold `stare-infra` (codexpublicus/stare, `infra/`)

**Files:**
- Create in `infra/`:
  - `Pulumi.yaml` (`name: stare-infra`, `runtime: {name: python, options: {toolchain: uv}}`)
  - `pyproject.toml`, with deps `pulumi>=3,<4`, `pulumi-cloudflare==6.13.0`, `pulumi-github>=6,<7`, `pulumi-tls>=5,<6`, and dev dep `pytest>=8`
  - `stare_infra/__init__.py`, `settings.py`, `shared.py`
  - `__main__.py`
  - `tests/__init__.py`, `tests/conftest.py`, `tests/test_settings.py`, `tests/test_shared.py`, `tests/test_pins.py`
- Create `infra/Pulumi.prod.yaml` from the operator's `stack init`, not by hand.

**Interfaces:**
- Produces:
  - `load_settings(cfg) -> Settings(shared_stack, zone, worker_name, github_repo, citare_repo, data_bucket, bucket_location)`
  - `read_shared(stack) -> Shared(account_id, zone_id)`, reading `account_id` and `zone_id_stare.pub` from the org stack until Task 9.

- [ ] **Step 1: Copy the test mocks.** Copy `codexpublicus/infra`'s `pulumi/tests/conftest.py` verbatim, keeping `created`, `settle()` and the branching `call()`. Add a StackReference output for `zone_id_stare.pub: "zone-123"`, and a `tls:index/privateKey:PrivateKey` output of `publicKeyOpenssh: "ssh-ed25519 AAAA test"` and `privateKeyOpenssh: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n"`.
- [ ] **Step 2: Write the failing tests.**
  - `test_pins.py` asserts `pulumi-cloudflare==6.13.0` appears in `pyproject.toml`.
  - `test_settings.py` parses a RAW dict:
    - `shared_stack` `organization/codexpublicus-infra/prod`
    - `zone` `stare.pub`
    - `worker_name` `stare-pub`
    - `github_repo` `codexpublicus/stare`
    - `citare_repo` `codexpublicus/citare`
    - `data_bucket` `codex-data`
    - `bucket_location` `WNAM`

    It also rejects a `github_repo` without an owner.
  - `test_shared.py` checks that `read_shared` returns `account_id` "acct-123" and `zone_id` "zone-123".

  Run: `uv run --directory infra pytest -q`. Expected: FAIL (`ModuleNotFoundError`).
- [ ] **Step 3: Implement** `settings.py` and `shared.py`, following `codexpublicus/infra`'s implementations, with `cfg.require` for required keys. `__main__.py` loads the settings, reads the shared values, and exports nothing yet.
- [ ] **Step 4: GREEN.** Run `uv run --directory infra pytest -q`.
- [ ] **Step 5: Commit, PR and merge.** Commit as `feat(infra): scaffold stare-infra Pulumi project`.
- [ ] **Step 6: Operator runbook.**
  ```
  mise exec --cd /home/lokkju/projects/lokkju/codex-publicus -- pulumi -C /home/lokkju/projects/lokkju/codex-publicus/infra stack init organization/stare-infra/prod
  ```
  Then set the plain config keys with `pulumi config set` (the task report lists each one). Commit the resulting `Pulumi.prod.yaml` through a PR. Run `pulumi preview`: expect `+ 1 to create` (the stack), with no errors.

---

### Task 5: New resources in `stare-infra`

**Files:**
- Create: `infra/stare_infra/deploy.py` and `infra/tests/test_deploy.py`
- Create: `infra/stare_infra/data.py` and `infra/tests/test_data.py`
- Modify: `infra/__main__.py`

**Interfaces:**
- `declare_deploy(settings, shared) -> Deploy(resources, exports)` creates:
  - AccountToken `workers-token-stare-pub`. Policy 1: Workers Scripts Write on the account. Policy 2: Workers Routes Write and Zone Read on `com.cloudflare.api.account.zone.{shared.zone_id}`. It carries `ignore_changes=["policies"]`, matching site.py's comment.
  - GitHub provider `github-codexpublicus`, plus ActionsSecrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` on `stare`. Use `value=`, not `plaintext_value`.
  - `tls.PrivateKey("citare-deploy-key", algorithm="ED25519")`.
  - `github.RepositoryDeployKey("citare-deploy-key", repository="citare", title="stare CI (read-only)", key=<public_key_openssh>, read_only=True)`.
  - ActionsSecret `CITARE_DEPLOY_KEY` on `stare` from `private_key_openssh`.
- `declare_data(settings, account_id) -> R2Bucket`: `codex-data`, location WNAM, with `protect=True, retain_on_delete=True`. No custom domain.
- Exports: `worker_name`, `r2_bucket_codex-data`.

- [ ] **Step 1: Write the failing tests.**
  - The token's two policies and their resource JSON are exact, using the `Output.all` pattern from `codexpublicus/infra`'s `test_site.py`.
  - `RepositoryDeployKey` has `readOnly` true and repository `citare`.
  - Three ActionsSecrets exist with the right names.
  - The `codex-data` bucket options are `protect` and `retain_on_delete`, tested through an options helper as in Task 1.
  - No custom domain is declared.

  Expected: FAIL.
- [ ] **Step 2: Implement.** Follow the code shape of `codexpublicus/infra/pulumi/codexpublicus_infra/site.py`, including its permission-group lookup by name. Then run the tests to GREEN.
- [ ] **Step 3: Preview.** Expect 9 to create (token, provider, 3 secrets, private key, deploy key, bucket, plus the stack) and 1 unchanged. It must not touch anything named stare-pub-idx.
- [ ] **Step 4: Commit, PR and merge.** Commit as `feat(infra): deploy credentials and codex-data`.
- [ ] **Step 5: Operator applies.** Run `up`. Then the controller checks:
  - `gh secret list -R codexpublicus/stare` shows the three secrets;
  - `gh api repos/codexpublicus/citare/keys` lists one read-only key;
  - the `stare-pub-idx` count is unchanged.

---

### Task 6: Worker config and the CI workflow (codexpublicus/stare)

**Files:**
- Create: `wrangler.jsonc`, `web/public/_headers`, `.github/workflows/site.yml`.

**Interfaces:**
- Consumes the secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `CITARE_DEPLOY_KEY` from Task 5.

- [ ] **Step 1: Write `wrangler.jsonc`.**
  ```jsonc
  {
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "stare-pub",
    "account_id": "441c9b9997aeedf42f0c48d5bdb996cb",
    "compatibility_date": "2026-09-01",
    "assets": { "directory": "./web/dist" },
    "workers_dev": true,
    "preview_urls": true
  }
  ```
  There are no `routes` until Task 7.
- [ ] **Step 2: Write `web/public/_headers`,** matching the live Pages response headers:
  ```
  /*
    X-Content-Type-Options: nosniff
    Referrer-Policy: strict-origin-when-cross-origin
  ```
  The `access-control-allow-origin: *` header seen on Pages is a Pages default. Check whether the site's JS needs CORS on `/wasm/` or `/data/`: same origin doesn't. Add it only if needed.
- [ ] **Step 3: Write `.github/workflows/site.yml`.** It triggers on `pull_request` and on `push` to `main`, with `permissions: {contents: read, pull-requests: write}`. Steps:
  1. `actions/checkout@<sha>`.
  2. `webfactory/ssh-agent@<sha>` with `ssh-private-key: ${{ secrets.CITARE_DEPLOY_KEY }}`.
  3. `dtolnay/rust-toolchain@<sha>` with `targets: wasm32-unknown-unknown` and `components: clippy, rustfmt`.
  4. `Swatinem/rust-cache@<sha>`.
  5. Install wasm-pack with `taiki-e/install-action@<sha>` and `tool: wasm-pack@0.13.1`.
  6. `actions/setup-node@<sha>` with `node-version: 22` and `cache: npm`, `cache-dependency-path: web/package-lock.json`.
  7. `cargo fmt --all --check`, then `cargo clippy --workspace --all-targets -- -D warnings`, then `cargo test --workspace`.
  8. `wasm-pack build crates/stare-wasm --target web --out-dir ../../web/public/wasm`.
  9. `npm --prefix web ci`, then `npm --prefix web run build`.
  10. On pull requests: `npx --yes wrangler@4.141.0 versions upload --message "PR #${{ github.event.number }}"`, capturing the preview URL from its output, then `gh pr comment` with that URL (`GH_TOKEN: ${{ github.token }}`).
  11. On `main`: `npx --yes wrangler@4.141.0 deploy`.
  12. The Wrangler steps take `env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID` from secrets.

  Look up every SHA with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, and put the tag in a comment.
- [ ] **Step 4: Verify locally,** as far as possible: `npx wrangler@4.141.0 deploy --dry-run` after `mise run build-web`.
- [ ] **Step 5: Open the PR.** CI runs on it, and every step must pass. The controller then checks:
  - the preview URL from the PR comment returns 200 with the page title;
  - it loads `/wasm/stare_wasm_bg.wasm` as `application/wasm`;
  - `x-content-type-options` and `referrer-policy` are present;
  - an example citation route (`#a2d/31/647-01`) renders when fetched through a headless browser.
- [ ] **Step 6: Merge.** The push to `main` deploys `stare-pub` to workers.dev. The controller checks `https://stare-pub.<subdomain>.workers.dev/` the same way. stare.pub itself still serves from Pages.

---

### Task 7: Cutover (codexpublicus/infra, then codexpublicus/stare)

**Files:**
- codexpublicus/infra: `pulumi/codexpublicus_infra/stare_pub.py` loses `pages_project`, `pages_domain`, `deploy_token` and the apex CNAME. It keeps the zone reference, the email call (until Task 8), and the idx bucket with its domain, CORS and token.
- codexpublicus/stare: `wrangler.jsonc` gains `"routes": [{ "pattern": "stare.pub", "custom_domain": true }]`.

- [ ] **Step 1: Infra PR.** Remove the Pages domain and the apex CNAME only; the Pages project and its token stay for rollback. Update the tests. Preview: expect `- 2 to delete` (`pages-domain-stare.pub`, `dns-stare.pub-CNAME-@-1`), 36 unchanged, and no change to any `r2-*` resource. Merge.
- [ ] **Step 2: Stare PR** with the route, opened and left unmerged.
- [ ] **Step 3: Operator, in one sitting.**
  1. Pull codexpublicus-infra.
  2. Run `up`, and expect 2 deletes. **Apex down from here.**
  3. `gh pr merge <route PR> -R codexpublicus/stare --merge --delete-branch`.
  4. Watch the workflow with `gh run watch`.
  5. `curl -4 -sI https://stare.pub/` returns 200 with `x-content-type-options`. **Apex up.**
- [ ] **Step 4: Rollback, if step 3.5 fails.** Revert the infra PR (`gh pr revert` or a new PR restoring the two resources), then `up`. The Pages project still has its deployment, so stare.pub serves Pages again.
- [ ] **Step 5: Controller verifies.**
  - stare.pub serves the Worker: the `cf-ray` headers show a Worker, or check with `wrangler deployments list`.
  - `idx.stare.pub/a2d/31.bin` returns 200.
  - The idx count is unchanged.
- [ ] **Step 6: One week later, remove Pages.** An infra PR deletes the Pages project and its token (`- 2 to delete`), and the operator runs `up`. File this as a dated issue at cutover so it isn't forgotten.

---

### Task 8: Remove stare.pub email (codexpublicus/infra)

**Files:** `stare_pub.py` drops its `declare_email_routing(...)` call; `tests/test_stare_pub.py` changes to match.

- [ ] **Step 1: PR.** Preview: expect `- 4 to delete` (`dns-stare.pub-TXT-@-0`, `email-settings-stare.pub`, `email-rule-stare.pub-0`, `email-catchall-stare.pub`), with nothing else changed and no `r2-*` changes. Merge.
- [ ] **Step 2: Operator runs `up`.** The controller checks that `dig MX stare.pub` is empty (routing is disabled) and that the idx count is unchanged.

---

### Task 9: Move the survivors into `stare-infra`

**Files:**
- codexpublicus/stare, new: `infra/stare_infra/zone.py`, `infra/stare_infra/index_bucket.py`, and their tests. They declare, with identical logical names and inputs:
  - `zone-stare.pub` (Zone: `account.id`, `name`, `type: full`; `protect=True`);
  - `r2-stare-pub-idx`;
  - `r2-domain-stare-pub-idx`;
  - `r2-cors-stare-pub-idx`;
  - `r2-token-stare-pub-idx`, with `ignore_changes=["policies"]` and the same export names: `zone_id_stare.pub`, `r2_bucket_stare-pub-idx`, `r2_token_id_stare-pub-idx`, and `r2_token_secret_stare-pub-idx` as a secret.

  The bucket and its domain use `protect=True, retain_on_delete=True`. `shared.py` stops reading `zone_id_stare.pub`; `deploy.py` uses the local zone.
- codexpublicus/infra: delete `stare_pub.py` and its tests, remove `stare.pub` from the `zones` config, and delete the `declare_stare_pub` call from `__main__.py`.

- [ ] **Step 1: Inventory.** From `codexpublicus-infra` state, `jq` out the 5 resources' inputs (non-secret fields only) into the task report.
- [ ] **Step 2: Failing tests.** In stare-infra, assert every input field from Step 1, following the Task 9 approach from the org migration. Then implement until GREEN.
- [ ] **Step 3: Two PRs, merged after the move, not before.**
  - PR-A (stare): the declarations.
  - PR-B (infra): the removal.

  Merging PR-B first would plan deletes; `retain_on_delete` keeps the bucket, but the zone deletion would fail on `protect`.
- [ ] **Step 4: Operator runbook.** Each command gets its expected output and a do-NOT-continue condition in the task report.
  1. Preview `codexpublicus-infra` on PR-B's branch in a worktree. Expect 5 deletes, exactly the 5, plus the protected-zone error. This is the sanity check, **not an apply**.
  2. State move, from the infra worktree, with both envs loaded:
     ```
     pulumi state move --source organization/codexpublicus-infra/prod --dest organization/stare-infra/prod --yes <5 URNs>
     ```
     Expect "Planning to move" to list exactly 5. Stop on "already exists".
  3. The protect bits carried over, confirmed with `jq` on the stare-infra export.
  4. **Gate A:** `stare-infra` preview on PR-A's branch shows 0 changes (every resource unchanged). Any replace or delete means **stop**, then roll back.
  5. **Gate B:** `codexpublicus-infra` preview on PR-B's branch shows 0 changes, and 5 fewer resources.
  6. Merge PR-A and PR-B.
  7. `up` both stacks. Expect 0 changes, with output additions and removals only.
  8. Check the idx count and `idx.stare.pub`.
  9. The rollback is a literal reverse `state move` of the 5 URNs; write it out in the report.
- [ ] **Step 5: Controller verifies.** `codexpublicus-infra` exports no stare output, `stare-infra` exports `zone_id_stare.pub`, and the idx count equals the Task 1 baseline, or is higher if the index grew.

---

### Task 10: Docs, tickets, close-out

- [ ] **codexpublicus/stare AGENTS.md:** stare-infra ownership, `mise run check|build-wasm|build-web`, the CI and preview URLs, and the `stare-pub-idx` protection rule.
- [ ] **codexpublicus/infra AGENTS.md and README:** remove stare.pub. Note that the org stack now owns only the codexpublicus zones and shared things.
- [ ] **Issues:**
  - stare: "Upload the mirror from TrueNAS to codex-data; decide data.stare.pub exposure and its cache rule".
  - stare: the dated Pages deletion from Task 7 Step 6.
  - stare: "Triage 12 npm audit findings in web/" (npm ci reported 1 critical and 10 high).
- [ ] **Close stare#3** with a summary comment.
- [ ] **Memory:** trim anything superseded.
