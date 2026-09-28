# Pulumi secrets and state: one pattern for every project

**Status:** draft for review, 2026-09-28. The model was agreed in conversation; this document
fixes the details. codexpublicus/stare#3 is paused at Task 6 until this lands.

**Tickets:** lokkju/infra#19 (lokkju-infra adoption, alongside #6), codexpublicus/infra#31,
codexpublicus/gorsuch-library#74 (the #63 stack starts on this pattern). This repo's
adoption is part of #3.

## Where things are now

Each project holds its Pulumi credentials as age-encrypted mise env in `.mise/config.toml`:
the state backend's R2 keys as `AWS_*`, `PULUMI_CONFIG_PASSPHRASE`, and the provider tokens
`CLOUDFLARE_API_TOKEN` and `GITHUB_TOKEN`. Every stack on the backend shares one passphrase.
stare's `.mise/tasks/pulumi` borrows the codexpublicus-infra checkout's env because its own
`AWS_*` are the idx upload keys (#35). `lokkju-infra` pushes GitHub Actions secrets into
other projects' repos, so it has to know about their stacks. None of the stacks runs in CI.

## The model

1. **One shared state backend**, `s3://lokkju-pulumi-state` on R2, for every project.
   There's no bucket per project or per org. Each project records the URL in its
   `Pulumi.yaml` under `backend.url`. The URL isn't a secret, and pinning it there means no
   env var can point a project at the wrong backend.
2. **Stacks serve themselves.** No stack creates credentials for, pushes secrets to, or
   lists another project's stacks. Values move between stacks only through `StackReference`,
   and only as plain outputs (see rule 6).
3. **Per-stack passphrases, derived.** A stack's passphrase is
   `base64url(HKDF-SHA256(ikm=master, salt="pulumi-kit/passphrase/v1", info=FQSN, L=32))`
   without padding. FQSN is the fully qualified stack name, `organization/<project>/<stack>`.
   The master is 32 random bytes, base64. Nothing stores a per-stack passphrase except CI
   (rule 7). The version in the salt allows a v2 derivation if the master is rotated.
4. **Local bootstrap from three values.** `~/.config/pulumi-kit/bootstrap.env`, mode 0600,
   holds `PULUMI_KIT_MASTER`, `PULUMI_KIT_BACKEND_ACCESS_KEY_ID` and
   `PULUMI_KIT_BACKEND_SECRET_ACCESS_KEY`. Bitwarden holds a copy of all three, and the
   master is also kept offline as break-glass. I picked the env file as the runtime source
   because the Bitwarden CLI needs an unlock per shell; `pulumi-kit` can grow a `bw` loader
   later without changing anything else.
5. **Provider credentials are stack config secrets:** `cloudflare:apiToken` and
   `github:token`, set with `pulumi config set --secret`. Explicit providers
   (`github.Provider(...)`) get `token=` from `pulumi.Config("github").require_secret("token")`,
   because an explicit provider reads env vars, not the `github:` config namespace.
   `pulumi-kit run` removes `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN` and `AWS_*` from the
   environment, so a project's own mise env can't leak into a provider. Each stack gets its
   own token, least-privilege where the API allows it; a stack may start on a copy of an
   existing token and get its own scoped one later.
6. **No secret outputs on a stack anyone references.** This is the one real constraint the
   design found. A `StackReference` decrypts all of the referenced stack's root outputs
   (`stack.DeserializeStackOutputs`), and a wrong passphrase fails only when one of those
   outputs is a secret. With per-stack passphrases, a consumer can't read a producer that
   has any secret output, even when it only wants the plain ones. So:
   - referenced stacks export only plain outputs (IDs, names, URLs);
   - secrets reach consumers only by push: Actions secrets now, Vault later;
   - operator tooling that needs its own stack's secret values reads them with
     `pulumi-kit secret <resource> <property>` (an `export --show-secrets` over the stack's
     own resources) instead of from outputs.

   The same constraint holds under Vault Transit, since a consumer without decrypt rights
   on the producer's key fails the same way. The rule survives that migration unchanged.
7. **CI credentials are self-published.** Each stack calls
   `publish_ci_credentials(repo, provider)` from `pulumi_kit`, which writes three Actions
   secrets into its own repo:
   - `PULUMI_BACKEND_ACCESS_KEY_ID` and `PULUMI_BACKEND_SECRET_ACCESS_KEY`, from the env
     `pulumi-kit run` set up;
   - `PULUMI_CONFIG_PASSPHRASE_<STACK>` (the stack name uppercased), from the running
     stack's `PULUMI_CONFIG_PASSPHRASE`.

   Values come from the process env at run time and are wrapped with `pulumi.Output.secret`.
   A CI run republishes the same values, which is a no-op diff. The master never leaves the
   operator's machine.
8. **CI behavior:** `preview --diff` on pull requests, `up --yes` on push to `main` and on a
   published release, one concurrency group per stack. PRs from forks get no secrets, so the
   preview job is skipped for them.
9. **Later, without changing programs:** self-hosted runners (ARC in the homelab)
   authenticate to Vault with GitHub's OIDC token and read the same three values. Stacks
   move one at a time to `hashivault://` Transit keys with
   `pulumi stack change-secrets-provider`; the stack that runs Vault itself stays on its
   derived passphrase. `publish_ci_credentials` is then deleted from each program.

## `lokkju/pulumi-kit`

A new private repo, Polyform Shield 1.0.0, a uv-managed Python package, pinned by tag in each
consumer (`pulumi-kit @ git+https://github.com/lokkju/pulumi-kit@v0.1.0`).

- `pulumi_kit.derive_passphrase(master: bytes, fqsn: str) -> str`: rule 3, with test
  vectors checked in.
- `pulumi_kit.publish_ci_credentials(repo: str, provider: github.Provider, stack: str | None = None)`:
  rule 7. `stack` defaults to `pulumi.get_stack()`. It raises a clear error naming the
  missing variable, instead of a `KeyError`.
- The `pulumi-kit` CLI:
  - `run [--cwd DIR] -- <pulumi args>` loads the bootstrap file, reads the project name from
    `DIR/Pulumi.yaml`, and requires an explicit `--stack`/`-s` (it refuses to guess). It
    derives the passphrase, sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
    `PULUMI_CONFIG_PASSPHRASE`, strips the variables in rule 5, and execs `pulumi -C DIR`.
    When the bootstrap file is missing but `PULUMI_CONFIG_PASSPHRASE` and `AWS_*` are
    already set (CI), it passes through.
  - `passphrase <fqsn>` prints a derived passphrase, for rotation and break-glass.
  - `secret --cwd DIR --stack S <resource> <property>` prints one secret property of one of
    the stack's own resources (rule 6).
- `templates/mise-pulumi-task`: the one-line `.mise/tasks/pulumi` every project copies
  (`exec uvx --from "$PULUMI_KIT" pulumi-kit run --cwd "$MISE_PROJECT_ROOT/<dir>" -- "$@"`).
- `templates/pulumi.yml`: the GitHub workflow for rule 8, with Actions pinned by SHA.

## Adoption: codexpublicus-infra, then stare-infra

The order matters because of rule 6 and the existing references
(stare-infra reads codexpublicus-infra, and codexpublicus-infra reads lokkju-infra).

1. **Cut the lokkju-infra reference.** codexpublicus-infra reads only `account_id` from
   lokkju-infra. That becomes plain stack config (`codexpublicus-infra:accountId`), which
   also removes the last link from the org's infra to a personal stack.
2. **Drop codexpublicus-infra's secret outputs.** There are five:
   - `pages_deploy_token_stare-pub` and `r2_token_secret_stare-pub-idx` are dropped as
     outputs, and their resources stay. stare holds copies in mise until #3 moves the idx
     token into stare-infra and retires Pages.
   - `lfs_operator_token`, `lfs_r2_access_key_id` and `lfs_r2_secret_access_key` are read by
     the `lfs-*` mise tasks, which switch to `pulumi-kit secret`.
3. **Move provider tokens into stack config** for both stacks, and remove `GITHUB_TOKEN`,
   `CLOUDFLARE_API_TOKEN`, `AWS_*` and `PULUMI_CONFIG_PASSPHRASE` from codexpublicus-infra's
   `.mise/config.toml`. stare keeps its idx `AWS_*` for s5cmd until #3, and loses the
   borrowed-env Pulumi task from #35.
4. **Rotate each stack to its derived passphrase.** The operator runs
   `pulumi-kit passphrase organization/<project>/prod | PULUMI_CONFIG_PASSPHRASE=<current> pulumi -C <dir> stack change-secrets-provider passphrase --stack prod`.
   The old passphrase comes from the env, and the new one from stdin when non-interactive
   (`promptForNewPassphrase`). The command rewrites `encryptionsalt` in `Pulumi.prod.yaml`,
   which is committed. Before rotating, a `stack export` backup goes to
   `~/backups/pulumi/<stack>-<date>.json`, since it holds decrypted values under the old
   salt only.
5. **Add `publish_ci_credentials`, and add the workflow.**
6. **Update each repo's `AGENTS.md`**, and delete the now-dead mise secrets.

Every state-changing step (`config set`, `change-secrets-provider`, `up`) is the operator's.
The plan hands each one over as a single command with its expected result.

## Known gaps, accepted

- R2 tokens are bucket-scoped, so any repo's CI keys can overwrite or delete another
  stack's state file, though not decrypt it. R2 bucket versioning on `lokkju-pulumi-state`
  makes that recoverable; the plan turns it on if it's off. Homelab object storage with
  per-path policies closes the gap later. Until then CI applies only from `main` or a
  release.
- A leaked master exposes every stack. Break-glass is: generate a new master, re-derive, and
  rotate every stack (step 4, once per stack), with the old master supplying the current
  passphrases.

## Out of scope

lokkju-infra's own adoption (lokkju/infra#19); gorsuch-library (#74); Vault, the runners, and
the homelab object store; the citare deploy key, which is blocked on the org policy
`deploy_keys_enabled_for_repositories: false` and belongs to #3.
