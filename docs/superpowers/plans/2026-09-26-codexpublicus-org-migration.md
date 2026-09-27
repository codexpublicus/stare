# Codex Publicus GitHub Organization Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `lokkju/codex-publicus` (as `stare`) and `lokkju/gorsuch-library` into the `codexpublicus` GitHub org, and stand up the org's shared infrastructure repo, its LFS proxy and the codexpublicus.org umbrella page.

**Architecture:** Four tracks with few joins.
- **A. Clean up and transfer the two existing repos.**
- **B. Fork r2-lfs to `lokkju/r2-lfs`** and add a GitHub Actions `ref` check and a per-object CI allow list.
- **C. Create `codexpublicus/infra`.** It holds a Python Pulumi project, `codexpublicus-infra/prod`, that owns the zones, the edge rules, the LFS bucket and the umbrella site's Pages project, and it deploys the pinned r2-lfs Worker with Wrangler.
- **D. Create `codexpublicus/codexpublicus.org`,** a static page deployed from Actions.

Consumers then point at `codexpublicus-infra/prod`.

**Tech Stack:**
- GitHub CLI (`gh`)
- `git filter-repo` (through `uvx`) and gitleaks (through Docker)
- Pulumi 3 with Python: `pulumi-cloudflare` 6.x, `pulumi-github` 6.x and `pulumi-random` 4.x, managed with uv and tested with pytest and Pulumi mocks
- TypeScript on Cloudflare Workers: vitest with `@cloudflare/vitest-plugin`, and pnpm 11.22.0 on Node 24
- Wrangler 4
- mise with age-encrypted env

**Spec:** `docs/superpowers/specs/2026-09-26-codexpublicus-org-migration-design.md` (read its "Amendments" section; it overrides the earlier sections where they differ).

## Global Constraints

- **Repos:** every org repo is private. `lokkju/r2-lfs` is a public fork; no secret goes into it.
- **Cloudflare account:** `441c9b9997aeedf42f0c48d5bdb996cb` (`lokkju`). Consumers read `account_id` only from `codexpublicus-infra/prod`, never from `lokkju-infra/prod`.
- **Pulumi state backend:** `s3://lokkju-pulumi-state?endpoint=https://441c9b9997aeedf42f0c48d5bdb996cb.r2.cloudflarestorage.com&region=auto`. The passphrase provider reads `PULUMI_CONFIG_PASSPHRASE` from the mise env.
- **Stack reference names:** `organization/<project>/<stack>`. The new project reads `organization/lokkju-infra/prod`, and consumers read `organization/codexpublicus-infra/prod`.
- **Zone output names:** `zone_id_<domain>`, the same as `lokkju-infra`.
- **LFS proxy URL:** `https://lfs.codexpublicus.org`. The batch path is `/<owner>/<repo>/objects/batch`.
- **LFS bucket:** `codexpublicus-lfs`, with `STORAGE_LAYOUT=per-repo` and `AUTH_MODE=token`.
- **Allow list:**
  - Key: `_allowlist/{owner}/{repo}.txt`, lowercased.
  - Format: one lowercase 64-hex object id per line, sorted and unique, `\n` after every line, no comments, no blank lines.
- **Accepted Actions refs:** `refs/heads/*` and `refs/pull/*/merge`.
- **r2-lfs upstream pin:** `v0.5.0` (`b5e6404c02928f81f25867b3c654821a20439119`). The fork's `package.json` `version` stays equal to the upstream release it's based on, because `scripts/upgrade-from-upstream.sh` depends on that.
- **Shell commands:** never use `cd dir && cmd`. Use `git -C`, `pulumi -C`, `pnpm --dir` and absolute paths.
- **Python:** `uv run python`, never bare `python`.
- **mise:** layout is `.mise/config.toml` plus `.mise/tasks/<name>`, with the `#MISE` and `#USAGE` headers.
- **Commits:** conventional commits with a subject under 50 characters, and no AI attribution of any kind.
- **Prose** in docs, README, tickets and the umbrella page has no em-dashes.

## Review Focus

1. **An Actions token must never read an object off the allow list by any route.** That covers the batch API, a direct `GET /<owner>/<repo>/objects/<oid>` with the OIDC credential, and any upstream endpoint that trades a credential for a session or action token. Task 7 adds a direct-GET test. Task 7 Step 1 also has the implementer grep for every place a token is minted and confirm none of them accepts an Actions credential.
2. **A missing, empty or malformed allow-list object must refuse every CI download, not allow all.** Task 7 tests the missing and malformed cases.
3. **A `ref` claim that's absent, or that matches no pattern, must be refused when `ACTIONS_OIDC_REFS` is set.** An empty setting keeps upstream's behavior. Task 6 tests the absent, mismatched and matching cases.
4. **A zone that already has an entry-point ruleset for a phase,** perhaps made in the dashboard, makes a new `Ruleset` fail or fight it. Task 11 lists the existing rulesets first and imports any that exist.
5. **The history rewrite must not lose work.** Unpushed commits, other branches and tags in `lokkju/codex-publicus` all have to survive it. Task 2 pushes the work branch first, rewrites every ref from a mirror clone, and checks the ref list and tree before and after.

---

## Parallel tracks

| Track | Tasks | Can start | Joins |
|---|---|---|---|
| A: cleanup and transfer | 1, 2, 3 | now | Task 3 has to finish before Task 14 |
| B: r2-lfs fork | 5, 6, 7 | now | Task 12 deploys its tag |
| C: org infra | 4, 8, 9, 10, 11, 12, 13 | Task 4 now; Task 8 onward after 4 | Task 12 needs 7; Task 13 needs 15 |
| D: umbrella page | 15 | now | Task 13 deploys it |
| E: consumers and tickets | 14, 16 | after 3, 8 and 12 | end |

Dispatch Tasks 1, 4, 5 and 15 at once. Task 2 waits for Task 1, and Task 8 waits for Task 4.

---

### Task 1: Scan both repos for secrets and merge the docs branch

**Files:**
- No file changes except merging `lokkju/org-migration` into `main` in `/home/lokkju/projects/lokkju/codex-publicus`.

**Interfaces:**
- Produces:
  - `main` on `lokkju/codex-publicus` contains the spec and this plan.
  - A clean gitleaks report for both repos, or a list of findings for the operator.

- [ ] **Step 1: Push the docs branch and merge it to main**

```bash
git -C /home/lokkju/projects/lokkju/codex-publicus push -u origin lokkju/org-migration
gh pr create -R lokkju/codex-publicus --base main --head lokkju/org-migration \
  --title "docs: Codex Publicus org migration spec and plan" \
  --body "Spec and implementation plan for moving this repo and gorsuch-library into the codexpublicus org."
gh pr merge -R lokkju/codex-publicus --merge --delete-branch
git -C /home/lokkju/projects/lokkju/codex-publicus checkout main
git -C /home/lokkju/projects/lokkju/codex-publicus pull --ff-only
```

Expected: `main` includes `docs/superpowers/specs/2026-09-26-codexpublicus-org-migration-design.md` and this plan.

- [ ] **Step 2: Run gitleaks over the full history of both repos**

```bash
mkdir -p /home/lokkju/projects/lokkju/.gitleaks
for r in codex-publicus gorsuch-library; do
  docker run --rm -v /home/lokkju/projects/lokkju/$r:/repo:ro -v /home/lokkju/projects/lokkju/.gitleaks:/out \
    zricethezav/gitleaks:latest git /repo --report-format json --report-path /out/$r.json --redact --exit-code 0
done
uv run python -c "import json;[print(r, len(json.load(open(f'/home/lokkju/projects/lokkju/.gitleaks/{r}.json')))) for r in ('codex-publicus','gorsuch-library')]"
```

Expected: a count per repo. Findings in `mise.toml` with `age =` values are ciphertext, and the spec already accepts them.

- [ ] **Step 3: Triage the findings**

For each finding that isn't an age ciphertext, print `File`, `StartLine`, `Commit` and `RuleID` from the JSON:

```bash
uv run python -c "import json;[print(f['RuleID'],f['File'],f['StartLine'],f['Commit'][:8]) for f in json.load(open('/home/lokkju/projects/lokkju/.gitleaks/codex-publicus.json')) if 'age' not in f['Match']]"
```

- If a real credential shows up, **stop and report it to the operator** before Task 2. It needs rotating, and its path gets added to Task 2's filter.
- If nothing real shows up, record "gitleaks: no live secrets" in the Task 2 commit notes.

---

### Task 2: Remove `target/` from codex-publicus's history

**Files:**
- History rewrite of `lokkju/codex-publicus`, every ref. There are no working-tree file changes.

**Interfaces:**
- Consumes: Task 1 (main includes the docs, no unreviewed secrets).
- Produces: `origin` has no blob under `target/` in any ref. The working clone at `/home/lokkju/projects/lokkju/codex-publicus` matches `origin/main` and keeps its untracked files.

- [ ] **Step 1: Confirm nothing local is unpushed, and record the ref list**

```bash
R=/home/lokkju/projects/lokkju/codex-publicus
git -C $R fetch origin --prune --tags
git -C $R status --porcelain --untracked-files=no     # expect empty
git -C $R log --branches --not --remotes --oneline    # expect empty
git -C $R ls-remote origin | awk '{print $2}' | sort > /home/lokkju/projects/lokkju/.gitleaks/refs-before.txt
git -C $R rev-parse origin/main^{tree} > /home/lokkju/projects/lokkju/.gitleaks/tree-before.txt
```

If either of the first two checks prints anything, push or stash that work first.

- [ ] **Step 2: Rewrite a mirror clone**

```bash
M=/home/lokkju/projects/lokkju/.codex-publicus-mirror.git
git clone --mirror git@github.com:lokkju/codex-publicus.git $M
uvx git-filter-repo --path target --invert-paths --force --source $M --target $M
```

- [ ] **Step 3: Verify the rewrite**

```bash
M=/home/lokkju/projects/lokkju/.codex-publicus-mirror.git
git -C $M rev-list --objects --all | grep -c '^[0-9a-f]* target/'   # expect 0
git -C $M for-each-ref --format='%(refname)' | sort > /home/lokkju/projects/lokkju/.gitleaks/refs-after.txt
diff <(grep -v -e '^refs/pull/' -e '^HEAD$' /home/lokkju/projects/lokkju/.gitleaks/refs-before.txt) \
     <(grep -v -e '^refs/pull/' /home/lokkju/projects/lokkju/.gitleaks/refs-after.txt)   # expect no output
diff <(git -C $M rev-parse main^{tree}) /home/lokkju/projects/lokkju/.gitleaks/tree-before.txt   # expect no output
git -C $M count-objects -vH | grep size-pack
```

- The tree of `main` has to be byte-identical, because `target/` isn't tracked at the tip.
- `size-pack` should drop from about 270 MB to under 40 MB.

- [ ] **Step 4: Force-push every rewritten ref**

`git filter-repo` removes the `origin` remote, so add it back first:

```bash
M=/home/lokkju/projects/lokkju/.codex-publicus-mirror.git
git -C $M remote add origin git@github.com:lokkju/codex-publicus.git
git -C $M push --force --mirror origin
```

Expected: pushes succeed. Hidden `refs/pull/*` refs are rejected, which is normal, and they keep old objects only on GitHub's side until GitHub's own gc runs.

- [ ] **Step 5: Reset the working clone and prune the old objects**

```bash
R=/home/lokkju/projects/lokkju/codex-publicus
git -C $R fetch origin --prune --force
git -C $R reset --hard origin/main
git -C $R reflog expire --expire=now --all
git -C $R gc --prune=now --aggressive
du -sh $R/.git
git -C $R status --short | head   # untracked .claude/ and friends still present
```

Expected: `.git` is under 50 MB, and `.claude/`, `data/` and `web/node_modules` are still there.

- [ ] **Step 6: Find other clones**

```bash
ssh ml-01 'find / -xdev -type d -name .git -path "*codex-publicus*" 2>/dev/null'
```

- For each clone found, the operator runs `git fetch origin --force && git reset --hard origin/main` there.
- If ml-01 has only the `mirror/` files and no clone, note that.
- Remove `/home/lokkju/projects/lokkju/.codex-publicus-mirror.git` once this is done.

---

### Task 3: Transfer both repos and update references

**Files:**
- Modify: `crates/stare/src/resolve.rs:89` (user agent)
- Modify: `crates/stare-cli/src/main.rs:229` (user agent)
- Modify: `web/src/pages/about.astro:69` (repo link)
- Modify: `AGENTS.md`, `README.md` (repo name and org)
- Modify: `/home/lokkju/.claude/projects/-home-lokkju-projects-lokkju-codex-publicus/memory/project_codex_publicus.md`

**Interfaces:**
- Consumes: Task 2 (rewritten history).
- Produces: the repos `codexpublicus/stare` and `codexpublicus/gorsuch-library`, and local remotes pointing at them.

- [ ] **Step 1: Rename, then transfer**

```bash
gh api -X PATCH repos/lokkju/codex-publicus -f name=stare --jq .full_name        # lokkju/stare
gh api -X POST repos/lokkju/stare/transfer -f new_owner=codexpublicus --jq .full_name
gh api -X POST repos/lokkju/gorsuch-library/transfer -f new_owner=codexpublicus --jq .full_name
```

The transfer is asynchronous, so poll until both repos resolve:

```bash
gh repo view codexpublicus/stare --json nameWithOwner,visibility
gh repo view codexpublicus/gorsuch-library --json nameWithOwner,visibility
```

Expected: both are `PRIVATE`.

- [ ] **Step 2: Verify that issues, labels and milestones came across**

```bash
gh issue list -R codexpublicus/stare --state all --limit 200 --json number --jq length            # 10
gh issue list -R codexpublicus/gorsuch-library --state all --limit 200 --json number --jq length  # 67
gh api repos/codexpublicus/gorsuch-library/milestones --jq '.[].title'                           # v1 launch
gh api repos/codexpublicus/gorsuch-library/labels --paginate --jq length
gh issue view 1 -R lokkju/codex-publicus --json url --jq .url    # redirect resolves to codexpublicus/stare
```

- [ ] **Step 3: Point local remotes at the org**

```bash
git -C /home/lokkju/projects/lokkju/codex-publicus remote set-url origin git@github.com:codexpublicus/stare.git
git -C /home/lokkju/projects/lokkju/gorsuch-library remote set-url origin git@github.com:codexpublicus/gorsuch-library.git
git -C /home/lokkju/projects/lokkju/codex-publicus fetch origin
git -C /home/lokkju/projects/lokkju/gorsuch-library fetch origin
```

The local directory names stay as they are. Project memory is keyed on the path.

- [ ] **Step 4: Update the repo URL in code and docs on a branch**

```bash
git -C /home/lokkju/projects/lokkju/codex-publicus fetch origin
git -C /home/lokkju/projects/lokkju/codex-publicus checkout -b lokkju/org-names origin/main
```

- In `crates/stare/src/resolve.rs:89` and `crates/stare-cli/src/main.rs:229`, replace `github.com/lokkju/codex-publicus` with `github.com/codexpublicus/stare`.
- In `web/src/pages/about.astro:69`, replace `https://github.com/lokkju/codex-publicus` with `https://github.com/codexpublicus/stare`.
- Leave the `https://github.com/lokkju` author links as they are.
- In `AGENTS.md`, add under "Project Overview":

```markdown
**Repository**: `codexpublicus/stare` in the Codex Publicus GitHub org, alongside
`codexpublicus/gorsuch-library`, `codexpublicus/infra` (shared zones, edge rules and the LFS proxy)
and `codexpublicus/codexpublicus.org` (umbrella site). Shared Cloudflare values come from the
Pulumi stack `organization/codexpublicus-infra/prod`.
```

- In `README.md`, add the same paragraph after the first heading block.
- Leave `mega/codex-publicus` (the NFS dataset), the mirror user agent and the npm package name alone. They're names, not repo references.

- [ ] **Step 5: Build and test**

```bash
cargo test --manifest-path /home/lokkju/projects/lokkju/codex-publicus/Cargo.toml --workspace
grep -rn "lokkju/codex-publicus" /home/lokkju/projects/lokkju/codex-publicus --include=*.rs --include=*.astro --include=*.md \
  --exclude-dir=target --exclude-dir=node_modules --exclude-dir=superpowers
```

Expected: the tests pass, and grep prints nothing. The spec and plan under `docs/superpowers` keep the historical name on purpose.

- [ ] **Step 6: Commit, open a PR and merge**

```bash
R=/home/lokkju/projects/lokkju/codex-publicus
git -C $R add crates/stare/src/resolve.rs crates/stare-cli/src/main.rs web/src/pages/about.astro AGENTS.md README.md
git -C $R commit -m "docs: point repo references at codexpublicus/stare"
git -C $R push -u origin lokkju/org-names
gh pr create -R codexpublicus/stare --fill && gh pr merge -R codexpublicus/stare --merge --delete-branch
```

- [ ] **Step 7: Update project memory**

In `project_codex_publicus.md`, replace the repo name with `codexpublicus/stare`, and add one line: the org layout plus the stack `organization/codexpublicus-infra/prod`.

---

### Task 4: Create `codexpublicus/infra` and scaffold the Pulumi project

**Files:**
- Create in `/home/lokkju/projects/lokkju/codexpublicus-infra` (the clone of `codexpublicus/infra`):
  - `.gitignore`
  - `.mise/config.toml`
  - `README.md`
  - `LICENSE` (PolyForm Shield 1.0.0)
  - `pulumi/Pulumi.yaml`
  - `pulumi/pyproject.toml`
  - `pulumi/__main__.py`
  - `pulumi/codexpublicus_infra/__init__.py`
  - `pulumi/codexpublicus_infra/settings.py`
  - `pulumi/tests/__init__.py`
  - `pulumi/tests/conftest.py`
  - `pulumi/tests/test_settings.py`

**Interfaces:**
- Produces: `codexpublicus_infra.settings.Settings` and `load_settings(cfg: pulumi.Config) -> Settings`, with these fields:
  - `shared_stack: str`
  - `zones: list[str]`
  - `redirects: dict[str, str]` (source zone to target zone)
  - `data_hosts: list[str]`
  - `lfs_host: str`
  - `lfs_bucket: str`
  - `bucket_location: str`
  - `site: SiteSettings(project_name: str, domain: str, github_repo: str)`

- [ ] **Step 1: Create the repo and clone it**

```bash
gh repo create codexpublicus/infra --private --description "Shared Codex Publicus infrastructure: zones, edge rules, LFS proxy, umbrella site"
git clone git@github.com:codexpublicus/infra.git /home/lokkju/projects/lokkju/codexpublicus-infra
```

- [ ] **Step 2: Write `.mise/config.toml`, `.gitignore` and `LICENSE`**

`.mise/config.toml`:

```toml
[tools]
pulumi = "latest"
uv = "latest"
wrangler = "latest"
node = "24"
"npm:pnpm" = "11.22.0"

[settings]
experimental = true

[settings.age]
identity_files = ["~/.config/mise/age.lokkju.txt"]

[env]
# Filled in Step 3 with `mise set --age-encrypt`.
```

`.gitignore`:

```
pulumi/.venv/
lfs/build/
__pycache__/
# stack config IS committed: secrets are encrypted
```

`LICENSE`: the PolyForm Shield 1.0.0 text, copied from `/home/lokkju/projects/lokkju/gorsuch-library/LICENSE`.

- [ ] **Step 3: Copy the operator env from lokkju/infra, age-encrypted**

Copy these values one at a time: `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`, `PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Each one comes from the decrypted lokkju/infra env and is re-encrypted to the same recipient:

```bash
for k in CLOUDFLARE_API_TOKEN GITHUB_TOKEN PULUMI_CONFIG_PASSPHRASE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  v=$(mise env --cd /home/lokkju/projects/lokkju/infra --json | jq -r --arg k "$k" '.[$k]')
  mise set --cd /home/lokkju/projects/lokkju/codexpublicus-infra --age-encrypt \
    --age-recipient age1jzx6xu75rjlzr6e5wtc7v9sj8rn9r2spf0k46chpkjh5er3pyvpsdwsv8g "$k=$v"
done
mise env --cd /home/lokkju/projects/lokkju/codexpublicus-infra --json | jq 'keys'
```

Expected: the five keys are listed, and `.mise/config.toml` has only `{ age = "..." }` values.

- [ ] **Step 4: Check what the tokens can do before writing resources**

```bash
eval "$(mise env --cd /home/lokkju/projects/lokkju/codexpublicus-infra)"
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | jq .result.status
for z in codexpublicus.org codexpublicus.com stare.pub; do
  curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/zones?name=$z" | jq -r --arg z "$z" '"\($z) \(.result[0].id) \(.result[0].account.id)"'
done
Z=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/zones?name=codexpublicus.org" | jq -r '.result[0].id')
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/zones/$Z/rulesets" | jq '.success, [.result[] | select(.kind=="zone") | {id, phase}]'
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/441c9b9997aeedf42f0c48d5bdb996cb/workers/scripts" | jq .success
gh api orgs/codexpublicus/memberships/lokkju --jq .role     # admin
```

Expected:
- The token status is `active`.
- Each zone prints an id and account `441c9b9997aeedf42f0c48d5bdb996cb`.
- Both the rulesets and the Workers calls print `success: true`.
- The org role is `admin`.

If the token can't read rulesets or Workers, **stop** and have the operator add the Zone Rulesets:Edit, Zone Cache Rules:Edit, Workers Scripts:Edit and Workers Routes:Edit permissions to the token. Record the zone ids for Task 9.

- [ ] **Step 5: Write `pulumi/Pulumi.yaml` and `pulumi/pyproject.toml`**

```yaml
name: codexpublicus-infra
runtime:
  name: python
  options:
    toolchain: uv
description: Shared Codex Publicus infrastructure (zones, edge rules, LFS proxy storage, umbrella site)
```

```toml
[project]
name = "codexpublicus-infra"
version = "0.1.0"
requires-python = ">=3.11"
license = "LicenseRef-PolyForm-Shield-1.0.0"
dependencies = [
    "pulumi>=3.0.0,<4.0.0",
    "pulumi-cloudflare>=6.0.0,<7.0.0",
    "pulumi-github>=6.0.0,<7.0.0",
    "pulumi-random>=4.0.0,<5.0.0",
]

[dependency-groups]
dev = ["pytest>=8.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 6: Write the failing settings test**

`pulumi/tests/__init__.py`: empty.

`pulumi/tests/conftest.py` holds the one set of Pulumi mocks every test shares. `set_mocks` is global, so a second call in another test file would silently replace it:

```python
"""Pulumi mocks shared by every test. Each test snapshots len(created) first and reads only what it added."""

import pulumi

from tests.conftest import created  # noqa: F401  (installs the mocks)
```

`pulumi/tests/test_settings.py`:

```python
import pytest

from codexpublicus_infra.settings import SiteSettings, parse_settings

RAW = {
    "shared_stack": "organization/lokkju-infra/prod",
    "zones": ["codexpublicus.org", "codexpublicus.com", "stare.pub"],
    "redirects": {"codexpublicus.com": "codexpublicus.org"},
    "data_hosts": ["data.gorsuch.codexpublicus.org"],
    "lfs_host": "lfs.codexpublicus.org",
    "lfs_bucket": "codexpublicus-lfs",
    "bucket_location": "WNAM",
    "site": {"project_name": "codexpublicus-org", "domain": "codexpublicus.org", "github_repo": "codexpublicus/codexpublicus.org"},
}


def test_parses_complete_config():
    s = parse_settings(RAW)
    assert s.zones == ["codexpublicus.org", "codexpublicus.com", "stare.pub"]
    assert s.redirects == {"codexpublicus.com": "codexpublicus.org"}
    assert s.site == SiteSettings("codexpublicus-org", "codexpublicus.org", "codexpublicus/codexpublicus.org")


def test_redirect_must_name_managed_zones():
    raw = {**RAW, "redirects": {"codexpublicus.net": "codexpublicus.org"}}
    with pytest.raises(ValueError, match="codexpublicus.net"):
        parse_settings(raw)


def test_data_host_must_sit_in_a_managed_zone():
    raw = {**RAW, "data_hosts": ["data.example.org"]}
    with pytest.raises(ValueError, match="data.example.org"):
        parse_settings(raw)


def test_site_domain_must_be_a_managed_zone():
    raw = {**RAW, "site": {**RAW["site"], "domain": "example.org"}}
    with pytest.raises(ValueError, match="example.org"):
        parse_settings(raw)
```

- [ ] **Step 7: Run it to check that it fails**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'codexpublicus_infra'`.

- [ ] **Step 8: Implement `settings.py`**

`pulumi/codexpublicus_infra/__init__.py`: empty.

`pulumi/codexpublicus_infra/settings.py`:

```python
"""Stack configuration for codexpublicus-infra, validated before any resource is declared."""

from dataclasses import dataclass
from typing import Any

import pulumi


@dataclass(frozen=True)
class SiteSettings:
    project_name: str
    domain: str
    github_repo: str


@dataclass(frozen=True)
class Settings:
    shared_stack: str
    zones: list[str]
    redirects: dict[str, str]
    data_hosts: list[str]
    lfs_host: str
    lfs_bucket: str
    bucket_location: str
    site: SiteSettings


def _zone_of(host: str, zones: list[str]) -> str | None:
    return next((z for z in zones if host == z or host.endswith("." + z)), None)


def parse_settings(raw: dict[str, Any]) -> Settings:
    zones = list(raw["zones"])
    redirects = dict(raw.get("redirects", {}))
    for source, target in redirects.items():
        for name in (source, target):
            if name not in zones:
                raise ValueError(f"redirect names {name}, which is not in zones")
    data_hosts = list(raw.get("data_hosts", []))
    for host in [*data_hosts, raw["lfs_host"]]:
        if _zone_of(host, zones) is None:
            raise ValueError(f"{host} is not inside a managed zone")
    site = SiteSettings(**raw["site"])
    if site.domain not in zones:
        raise ValueError(f"site domain {site.domain} is not in zones")
    return Settings(
        shared_stack=raw["shared_stack"],
        zones=zones,
        redirects=redirects,
        data_hosts=data_hosts,
        lfs_host=raw["lfs_host"],
        lfs_bucket=raw["lfs_bucket"],
        bucket_location=raw.get("bucket_location") or "WNAM",
        site=site,
    )


def load_settings(cfg: pulumi.Config) -> Settings:
    keys = ["shared_stack", "lfs_host", "lfs_bucket", "bucket_location"]
    raw: dict[str, Any] = {k: cfg.get(k) for k in keys}
    raw["zones"] = cfg.require_object("zones")
    raw["redirects"] = cfg.get_object("redirects") or {}
    raw["data_hosts"] = cfg.get_object("data_hosts") or []
    raw["site"] = cfg.require_object("site")
    return parse_settings(raw)


def zone_of(host: str, zones: list[str]) -> str:
    zone = _zone_of(host, zones)
    if zone is None:
        raise ValueError(f"{host} is not inside a managed zone")
    return zone
```

- [ ] **Step 9: Run the tests to check that they pass**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q`
Expected: 4 passed.

- [ ] **Step 10: Write a minimal `__main__.py`, the README, then commit**

`pulumi/__main__.py`:

```python
"""codexpublicus-infra: resources shared by every Codex Publicus site."""

import pulumi

from codexpublicus_infra.settings import load_settings

settings = load_settings(pulumi.Config())
```

`README.md` covers:
- What the repo owns: the zones, edge rules, the LFS proxy's bucket and deployment, and the umbrella site's Pages project.
- The exports consumers read, from the "Exports" list in the spec.
- The run commands:

```bash
eval "$(mise env --cd /home/lokkju/projects/lokkju/codexpublicus-infra)"
pulumi -C /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi preview
```

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R add .gitignore .mise/config.toml LICENSE README.md pulumi/Pulumi.yaml pulumi/pyproject.toml pulumi/uv.lock pulumi/__main__.py pulumi/codexpublicus_infra pulumi/tests/__init__.py pulumi/tests/conftest.py pulumi/tests/test_settings.py
git -C $R commit -m "feat: scaffold codexpublicus-infra Pulumi project"
git -C $R push -u origin main
```

This first commit on an empty repo goes straight to `main`. Everything after it uses a branch and a PR.

---

### Task 5: Fork r2-lfs and pin the baseline

**Files:**
- Create in `/home/lokkju/projects/lokkju/r2-lfs` (the clone of `lokkju/r2-lfs`): `.mise/config.toml`, `FORK.md`.

**Interfaces:**
- Produces: the fork at `lokkju/r2-lfs`, with branch `codexpublicus` based on tag `v0.5.0`, passing upstream's own tests.

- [ ] **Step 1: Fork and clone**

```bash
gh repo fork ken109/r2-lfs --clone=false --default-branch-only=false
git clone git@github.com:lokkju/r2-lfs.git /home/lokkju/projects/lokkju/r2-lfs
git -C /home/lokkju/projects/lokkju/r2-lfs remote add upstream https://github.com/ken109/r2-lfs.git
git -C /home/lokkju/projects/lokkju/r2-lfs fetch upstream --tags
git -C /home/lokkju/projects/lokkju/r2-lfs checkout -b codexpublicus v0.5.0
git -C /home/lokkju/projects/lokkju/r2-lfs rev-parse HEAD   # b5e6404c02928f81f25867b3c654821a20439119
```

- [ ] **Step 2: Add the toolchain and the fork notes**

`.mise/config.toml`:

```toml
[tools]
node = "24"
"npm:pnpm" = "11.22.0"
```

`FORK.md`:

```markdown
# lokkju/r2-lfs

A fork of [ken109/r2-lfs](https://github.com/ken109/r2-lfs) with two additions for GitHub Actions
callers:

- `ACTIONS_OIDC_REFS`: comma-separated ref patterns (`*` matches any characters). When set, an
  Actions token whose `ref` claim is missing or matches none is refused.
- `ACTIONS_OIDC_ALLOWLIST=on`: an Actions token may download only the object ids listed in
  `_allowlist/{owner}/{repo}.txt` in the bucket, one lowercase 64-hex id per line. A missing or
  malformed list refuses every Actions download. Operator and other credentials are unaffected.

Branch `codexpublicus` carries these changes on top of an upstream release tag. `package.json`
keeps the upstream version so `scripts/upgrade-from-upstream.sh` keeps working; releases of this
fork are tagged `v<upstream>-cp.<n>`.
```

- [ ] **Step 3: Install and run upstream's tests**

```bash
mise install --cd /home/lokkju/projects/lokkju/r2-lfs
mise exec --cd /home/lokkju/projects/lokkju/r2-lfs -- pnpm --dir /home/lokkju/projects/lokkju/r2-lfs install --frozen-lockfile
mise exec --cd /home/lokkju/projects/lokkju/r2-lfs -- pnpm --dir /home/lokkju/projects/lokkju/r2-lfs test
```

Expected: `Test Files 28 passed (28)`, `Tests 313 passed (313)`.

- [ ] **Step 4: Commit and push the branch**

```bash
R=/home/lokkju/projects/lokkju/r2-lfs
git -C $R add .mise/config.toml FORK.md
git -C $R commit -m "docs: describe the codexpublicus fork"
git -C $R push -u origin codexpublicus
```

---

### Task 6: r2-lfs: check the Actions `ref` claim

**Files:**
- Create: `src/domain/refs.ts`, `test/worker/actions-refs.test.ts`
- Modify:
  - `src/app/ports.ts` (`ActionsClaims`, `Authorization`)
  - `src/infra/actions-oidc.ts` (read `ref`)
  - `src/domain/config.ts` (`ConfigVars`, `ActionsOidcSettings`, `parseConfig`)
  - `src/app/authorize.ts` (enforce the ref check, tag the principal)
  - `wrangler.jsonc` (vars)

**Interfaces:**
- Consumes: Task 5's branch `codexpublicus`.
- Produces:
  - `refAllowed(patterns: readonly string[], ref: string | undefined): boolean`
  - `ActionsClaims.ref: string | undefined`
  - `ActionsOidcSettings.refs: readonly string[]`
  - `Authorization` (ok case) gains `principal?: "actions"`. Task 7 reads it.

- [ ] **Step 1: Write the failing tests**

`test/worker/actions-refs.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { refAllowed } from "../../src/domain/refs.ts";
import { handle } from "../../src/http/handler.ts";
import { clearHostCache, type Fetcher } from "../../src/infra/host-permissions.ts";
import { clearJwtKeysCache } from "../../src/infra/jwt.ts";
import { basic, envWith } from "./helpers.ts";
import { signingKey } from "./jwt-helpers.ts";

const ISSUER = "https://token.actions.githubusercontent.com";
const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: "r2-lfs", exp: now() + 300, repository: "acme/assets", actor: "octocat", ref: "refs/heads/main", ...over,
});
const makeEnv = envWith({ AUTH_MODE: "github", TRANSFER_MODE: "proxy", ACTIONS_OIDC: "read" });

async function setup() {
  const key = await signingKey("gh1");
  const fetcher: Fetcher = async (input) => {
    if (String(input) === `${ISSUER}/.well-known/jwks`) return Response.json({ keys: [key.jwk] });
    throw new Error(`unexpected request to ${String(input)}`);
  };
  const batch = (e: Env, token: string) =>
    handle(
      new Request("https://lfs.example.com/acme/assets/objects/batch", {
        method: "POST",
        headers: { Authorization: basic(token, "oidc"), "Content-Type": "application/vnd.git-lfs+json" },
        body: JSON.stringify({ operation: "download", objects: [] }),
      }),
      e,
      { fetch: fetcher },
    );
  return { key, batch };
}

beforeEach(() => {
  clearJwtKeysCache();
  clearHostCache();
});

describe("refAllowed", () => {
  it("allows any ref when no pattern is configured", () => {
    expect(refAllowed([], undefined)).toBe(true);
    expect(refAllowed([], "refs/tags/v1")).toBe(true);
  });
  it("matches * across any characters, including slashes", () => {
    const patterns = ["refs/heads/*", "refs/pull/*/merge"];
    expect(refAllowed(patterns, "refs/heads/main")).toBe(true);
    expect(refAllowed(patterns, "refs/heads/feature/x")).toBe(true);
    expect(refAllowed(patterns, "refs/pull/12/merge")).toBe(true);
    expect(refAllowed(patterns, "refs/tags/v1")).toBe(false);
    expect(refAllowed(patterns, "refs/pull/12/head")).toBe(false);
  });
  it("refuses a missing ref once patterns are configured", () => {
    expect(refAllowed(["refs/heads/*"], undefined)).toBe(false);
  });
  it("treats regex metacharacters in patterns literally", () => {
    expect(refAllowed(["refs/heads/v1.0"], "refs/heads/v1x0")).toBe(false);
  });
});

describe("ACTIONS_OIDC_REFS", () => {
  const refs = { ACTIONS_OIDC_REFS: "refs/heads/*,refs/pull/*/merge" };

  it("accepts a workflow on an allowed ref", async () => {
    const { key, batch } = await setup();
    expect((await batch(makeEnv(refs), await key.sign(claims()))).status).toBe(200);
    expect((await batch(makeEnv(refs), await key.sign(claims({ ref: "refs/pull/7/merge" })))).status).toBe(200);
  });

  it("refuses a workflow on a ref no pattern matches", async () => {
    const { key, batch } = await setup();
    const res = await batch(makeEnv(refs), await key.sign(claims({ ref: "refs/tags/v1" })));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("refs/tags/v1");
  });

  it("refuses a token without a ref claim", async () => {
    const { key, batch } = await setup();
    expect((await batch(makeEnv(refs), await key.sign(claims({ ref: undefined })))).status).toBe(403);
  });

  it("keeps upstream behaviour when unset", async () => {
    const { key, batch } = await setup();
    expect((await batch(makeEnv(), await key.sign(claims({ ref: "refs/tags/v1" })))).status).toBe(200);
  });

  it("rejects a pattern that does not start with refs/", async () => {
    const res = await handle(new Request("https://lfs.example.com/_r2-lfs/info"), makeEnv({ ACTIONS_OIDC_REFS: "main" }), { fetch });
    expect(await res.text()).toContain("ACTIONS_OIDC_REFS");
  });
});
```

- [ ] **Step 2: Run them to check that they fail**

Run: `mise exec --cd /home/lokkju/projects/lokkju/r2-lfs -- pnpm --dir /home/lokkju/projects/lokkju/r2-lfs exec vitest run test/worker/actions-refs.test.ts`
Expected: FAIL, because `src/domain/refs.ts` can't be resolved.

- [ ] **Step 3: Implement**

`src/domain/refs.ts`:

```ts
/** Whether `ref` matches a pattern in which `*` stands for any run of characters, slashes included. */
export function refMatches(pattern: string, ref: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(ref);
}

/** No patterns keeps upstream behaviour: any ref. With patterns, a missing ref is refused. */
export function refAllowed(patterns: readonly string[], ref: string | undefined): boolean {
  if (patterns.length === 0) return true;
  return ref !== undefined && patterns.some((pattern) => refMatches(pattern, ref));
}
```

In `src/app/ports.ts`, add to `ActionsClaims`:

```ts
  /** The `ref` claim, such as `refs/heads/main` or `refs/pull/7/merge`. */
  ref: string | undefined;
```

and change the ok arm of `Authorization` to:

```ts
  | { ok: true; permission: Permission; identify: () => Promise<string | undefined>; oid?: string; principal?: "actions" }
```

In `src/infra/actions-oidc.ts`, add this to the returned object:

```ts
      ref: typeof claims.ref === "string" ? claims.ref : undefined,
```

In `src/domain/config.ts`:
- Add `ACTIONS_OIDC_REFS?: string;` to `ConfigVars`.
- Add `refs: readonly string[];` to `ActionsOidcSettings`.
- In `parseConfig`, after `actionsAudience`:

```ts
  const actionsRefs = listOf(vars.ACTIONS_OIDC_REFS);
  for (const pattern of actionsRefs) {
    if (!pattern.startsWith("refs/")) problems.push(`ACTIONS_OIDC_REFS entry "${pattern}" must start with refs/`);
  }
```

and change the `actionsOidc` value in the returned config to:

```ts
    actionsOidc: actionsMode === "off" ? undefined : { permission: actionsMode, audience: actionsAudience, refs: actionsRefs },
```

In `src/app/authorize.ts`, import `refAllowed` from `"../domain/refs.ts"`. Inside the Actions branch, directly after the repository check:

```ts
      if (!refAllowed(config.actionsOidc.refs, claims.ref)) {
        return { ok: false, status: 403, message: `A GitHub Actions token from ${claims.ref ?? "an unknown ref"} cannot use this repository` };
      }
```

and change that branch's success return to:

```ts
      return { ok: true, permission: config.actionsOidc.permission, identify: async () => `${claims.actor} (GitHub Actions)`, principal: "actions" };
```

In `wrangler.jsonc` `vars`, add `"ACTIONS_OIDC_REFS": ""` after `"ACTIONS_OIDC_AUDIENCE"`.

- [ ] **Step 4: Run the new tests, then the whole suite, typecheck and lint**

```bash
R=/home/lokkju/projects/lokkju/r2-lfs
mise exec --cd $R -- pnpm --dir $R exec vitest run test/worker/actions-refs.test.ts
mise exec --cd $R -- pnpm --dir $R test
mise exec --cd $R -- pnpm --dir $R run typecheck
mise exec --cd $R -- pnpm --dir $R run lint
```

Expected: every test passes (313 plus the new ones), typecheck is clean, and lint is clean. If `oxfmt --check` complains, run `pnpm run format` and re-run lint.

- [ ] **Step 5: Commit**

```bash
R=/home/lokkju/projects/lokkju/r2-lfs
git -C $R add src/domain/refs.ts src/app/ports.ts src/infra/actions-oidc.ts src/domain/config.ts src/app/authorize.ts wrangler.jsonc test/worker/actions-refs.test.ts
git -C $R commit -m "feat: restrict Actions tokens by ref claim"
```

---

### Task 7: r2-lfs: per-object allow list for Actions downloads

**Files:**
- Create:
  - `src/domain/allowlist.ts`
  - `src/infra/r2-ci-allowlist.ts`
  - `test/worker/ci-allowlist.test.ts`
- Modify:
  - `src/shared/contract.ts` (key helper)
  - `src/app/ports.ts` (`CiAllowlist` port)
  - `src/domain/config.ts` (`ACTIONS_OIDC_ALLOWLIST`)
  - `src/app/lfs.ts` (`LfsContext.ciAllowlist`, and checks in `planObject` and `download`)
  - `src/http/handler.ts` (wiring)
  - `wrangler.jsonc`
  - `FORK.md`

**Interfaces:**
- Consumes: `Authorization.principal` (from Task 6).
- Produces:
  - `ciAllowlistKey(owner: string, repo: string): string`, which returns `_allowlist/{owner}/{repo}.txt`, lowercased.
  - `parseAllowlist(text: string): ReadonlySet<string> | undefined`, where `undefined` means malformed.
  - `interface CiAllowlist { allows(repo: Repo, oid: string): Promise<boolean> }`
  - `R2CiAllowlist` and `clearCiAllowlistCache()`
  - `ActionsOidcSettings.allowlist: boolean`

- [ ] **Step 1: Look for any other path that mints tokens (Review Focus 1)**

```bash
R=/home/lokkju/projects/lokkju/r2-lfs
grep -rn "sessions\.\(issue\|mint\|sign\)\|authorizeAction\|onlyOid\|SESSION_ENDPOINT" $R/src | grep -v test
```

For each hit, read the code and record in the commit message whether an Actions-authenticated request can reach it:
- A download action token minted inside `batch` is covered by the `planObject` check below.
- If `SESSION_ENDPOINT` accepts a request whose `authorize` result has `principal: "actions"` and returns a session token, add a refusal there in Step 5 (`if (auth.principal === "actions") return lfsError(403, "Actions tokens cannot open sessions")`), plus a test in Step 1b.

- [ ] **Step 1b: Write the failing tests**

`test/worker/ci-allowlist.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { parseAllowlist } from "../../src/domain/allowlist.ts";
import { handle } from "../../src/http/handler.ts";
import { clearHostCache, type Fetcher } from "../../src/infra/host-permissions.ts";
import { clearJwtKeysCache } from "../../src/infra/jwt.ts";
import { clearCiAllowlistCache } from "../../src/infra/r2-ci-allowlist.ts";
import { clearRepositoryIdentitiesCache } from "../../src/infra/r2-repository-identities.ts";
import { basic, blob, envWith } from "./helpers.ts";
import { signingKey } from "./jwt-helpers.ts";

const ISSUER = "https://token.actions.githubusercontent.com";
const OPERATOR = "operator-token-0123456789abcdef";
const now = () => Math.floor(Date.now() / 1000);
const makeEnv = envWith({
  AUTH_MODE: "token",
  AUTH_TOKENS: `acme/*:rw:${OPERATOR}`,
  TRANSFER_MODE: "proxy",
  ACTIONS_OIDC: "read",
  ACTIONS_OIDC_ALLOWLIST: "on",
});

let counter = 0;

async function setup() {
  const repo = `books-${counter++}-${Date.now()}`;
  const key = await signingKey("gh1");
  const fetcher: Fetcher = async (input) => {
    if (String(input) === `${ISSUER}/.well-known/jwks`) return Response.json({ keys: [key.jwk] });
    throw new Error(`unexpected request to ${String(input)}`);
  };
  const oidc = await key.sign({ iss: ISSUER, aud: "r2-lfs", exp: now() + 300, repository: `acme/${repo}`, actor: "ci", ref: "refs/heads/main" });
  const pub = await blob();
  const secret = await blob();
  for (const b of [pub, secret]) await env.BUCKET.put(`acme/${repo}/${b.oid}`, b.data);
  const batch = (e: Env, password: string, oids: { oid: string; size: number }[]) =>
    handle(
      new Request(`https://lfs.example.com/acme/${repo}/objects/batch`, {
        method: "POST",
        headers: { Authorization: basic(password, "oidc"), "Content-Type": "application/vnd.git-lfs+json" },
        body: JSON.stringify({ operation: "download", objects: oids }),
      }),
      e,
      { fetch: fetcher },
    );
  const get = (e: Env, password: string, oid: string) =>
    handle(new Request(`https://lfs.example.com/acme/${repo}/objects/${oid}`, { headers: { Authorization: basic(password, "oidc") } }), e, { fetch: fetcher });
  const setList = (text: string) => env.BUCKET.put(`_allowlist/acme/${repo}.txt`, text);
  return { repo, oidc, pub, secret, batch, get, setList };
}

type BatchBody = { objects: { oid: string; actions?: unknown; error?: { code: number } }[] };

beforeEach(() => {
  clearJwtKeysCache();
  clearHostCache();
  clearCiAllowlistCache();
  clearRepositoryIdentitiesCache();
});

describe("parseAllowlist", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  it("reads one lowercase 64-hex oid per line", () => {
    expect(parseAllowlist(`${a}\n${b}\n`)).toEqual(new Set([a, b]));
  });
  it("reads an empty file as an empty list", () => {
    expect(parseAllowlist("")).toEqual(new Set());
  });
  it("rejects a malformed line, an uppercase oid, a comment or a blank line", () => {
    for (const text of [`${a}\nnot-an-oid\n`, `${a.toUpperCase()}\n`, `# c\n${a}\n`, `${a}\n\n${b}\n`]) {
      expect(parseAllowlist(text)).toBeUndefined();
    }
  });
});

describe("ACTIONS_OIDC_ALLOWLIST", () => {
  it("lets CI download a listed object and refuses an unlisted one in the same batch", async () => {
    const s = await setup();
    await s.setList(`${s.pub.oid}\n`);
    const res = await s.batch(makeEnv(), s.oidc, [s.pub, s.secret].map(({ oid, size }) => ({ oid, size })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchBody;
    const byOid = new Map(body.objects.map((o) => [o.oid, o]));
    expect(byOid.get(s.pub.oid)?.actions).toBeDefined();
    expect(byOid.get(s.secret.oid)?.error?.code).toBe(403);
    expect(byOid.get(s.secret.oid)?.actions).toBeUndefined();
  });

  it("refuses a direct GET of an unlisted object with the OIDC credential", async () => {
    const s = await setup();
    await s.setList(`${s.pub.oid}\n`);
    expect((await s.get(makeEnv(), s.oidc, s.secret.oid)).status).toBe(403);
    expect((await s.get(makeEnv(), s.oidc, s.pub.oid)).status).toBe(200);
  });

  it("refuses everything to CI when the list is missing", async () => {
    const s = await setup();
    const body = (await (await s.batch(makeEnv(), s.oidc, [{ oid: s.pub.oid, size: s.pub.size }])).json()) as BatchBody;
    expect(body.objects[0]?.error?.code).toBe(403);
  });

  it("refuses everything to CI when the list is malformed", async () => {
    const s = await setup();
    await s.setList(`${s.pub.oid}\nnot-an-oid\n`);
    const body = (await (await s.batch(makeEnv(), s.oidc, [{ oid: s.pub.oid, size: s.pub.size }])).json()) as BatchBody;
    expect(body.objects[0]?.error?.code).toBe(403);
  });

  it("never lets CI write, even for a listed object", async () => {
    const s = await setup();
    await s.setList(`${s.pub.oid}\n`);
    const res = await handle(
      new Request(`https://lfs.example.com/acme/${s.repo}/objects/batch`, {
        method: "POST",
        headers: { Authorization: basic(s.oidc, "oidc"), "Content-Type": "application/vnd.git-lfs+json" },
        body: JSON.stringify({ operation: "upload", objects: [{ oid: s.pub.oid, size: s.pub.size }] }),
      }),
      makeEnv(),
      { fetch: async () => { throw new Error("no network"); } },
    );
    expect(res.status).toBe(403);
  });

  it("refuses a token from another repository", async () => {
    const s = await setup();
    await s.setList(`${s.pub.oid}\n`);
    const key = await signingKey("gh1");
    const fetcher: Fetcher = async () => Response.json({ keys: [key.jwk] });
    const foreign = await key.sign({ iss: ISSUER, aud: "r2-lfs", exp: now() + 300, repository: "acme/other", actor: "ci", ref: "refs/heads/main" });
    const res = await handle(
      new Request(`https://lfs.example.com/acme/${s.repo}/objects/batch`, {
        method: "POST",
        headers: { Authorization: basic(foreign, "oidc"), "Content-Type": "application/vnd.git-lfs+json" },
        body: JSON.stringify({ operation: "download", objects: [{ oid: s.pub.oid, size: s.pub.size }] }),
      }),
      makeEnv(),
      { fetch: fetcher },
    );
    expect(res.status).toBe(404);
  });

  it("does not restrict the operator token", async () => {
    const s = await setup();
    await s.setList(`${s.pub.oid}\n`);
    const body = (await (await s.batch(makeEnv(), OPERATOR, [{ oid: s.secret.oid, size: s.secret.size }])).json()) as BatchBody;
    expect(body.objects[0]?.actions).toBeDefined();
  });

  it("does not restrict CI when the setting is off", async () => {
    const s = await setup();
    const body = (await (await s.batch(makeEnv({ ACTIONS_OIDC_ALLOWLIST: "off" }), s.oidc, [{ oid: s.secret.oid, size: s.secret.size }])).json()) as BatchBody;
    expect(body.objects[0]?.actions).toBeDefined();
  });
});
```

- [ ] **Step 2: Run them to check that they fail**

Run: `mise exec --cd /home/lokkju/projects/lokkju/r2-lfs -- pnpm --dir /home/lokkju/projects/lokkju/r2-lfs exec vitest run test/worker/ci-allowlist.test.ts`
Expected: FAIL, because `src/domain/allowlist.ts` can't be resolved.

- [ ] **Step 3: Implement the domain, port and infra pieces**

`src/domain/allowlist.ts`:

```ts
const OID_LINE = /^[0-9a-f]{64}$/;

/**
 * Parses a CI allow list: one lowercase 64-hex object id per line, newline-terminated.
 * Any line that is not an oid makes the whole list invalid, so a damaged list refuses everything.
 */
export function parseAllowlist(text: string): ReadonlySet<string> | undefined {
  if (text === "") return new Set();
  if (!text.endsWith("\n")) return undefined;
  const lines = text.slice(0, -1).split("\n");
  if (!lines.every((line) => OID_LINE.test(line))) return undefined;
  return new Set(lines);
}
```

In `src/shared/contract.ts`, next to `repositoryIdKey`:

```ts
export const ALLOWLIST_PREFIX = "_allowlist/";
/** The object ids GitHub Actions may download from a repository, written by the operator. */
export function ciAllowlistKey(owner: string, repo: string): string {
  return `${ALLOWLIST_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}.txt`;
}
```

In `src/app/ports.ts`:

```ts
/** Which objects a GitHub Actions workflow may download from a repository. */
export interface CiAllowlist {
  allows(repo: Repo, oid: string): Promise<boolean>;
}
```

`src/infra/r2-ci-allowlist.ts`:

```ts
import type { CiAllowlist } from "../app/ports.ts";
import { parseAllowlist } from "../domain/allowlist.ts";
import type { Repo } from "../domain/repo.ts";
import { ciAllowlistKey } from "../shared/contract.ts";

const TTL_MS = 60_000;
const cache = new Map<string, { oids: ReadonlySet<string>; expires: number }>();

export function clearCiAllowlistCache(): void {
  cache.clear();
}

/** Reads `_allowlist/{owner}/{repo}.txt`. Missing or malformed means an empty list. */
export class R2CiAllowlist implements CiAllowlist {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async allows(repo: Repo, oid: string): Promise<boolean> {
    const key = ciAllowlistKey(repo.owner, repo.name);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.oids.has(oid);
    const text = await this.bucket.get(key).then((object) => object?.text());
    const oids = (text === undefined ? undefined : parseAllowlist(text)) ?? new Set<string>();
    cache.set(key, { oids, expires: Date.now() + TTL_MS });
    return oids.has(oid);
  }
}
```

In `src/domain/config.ts`:
- Add `ACTIONS_OIDC_ALLOWLIST?: string;` to `ConfigVars`.
- Add `allowlist: boolean;` to `ActionsOidcSettings`.
- In `parseConfig`:

```ts
  const actionsAllowlist = oneOf("ACTIONS_OIDC_ALLOWLIST", vars.ACTIONS_OIDC_ALLOWLIST, ["off", "on"], "off", problems) === "on";
```

- Change `actionsOidc` to:

```ts
    actionsOidc:
      actionsMode === "off" ? undefined : { permission: actionsMode, audience: actionsAudience, refs: actionsRefs, allowlist: actionsAllowlist },
```

- [ ] **Step 4: Enforce the list in `lfs.ts`**

In `src/app/lfs.ts`, import `CiAllowlist` from `./ports.ts`, and add this to `LfsContext`:

```ts
  /** Set for GitHub Actions callers when ACTIONS_OIDC_ALLOWLIST is on: downloads are limited to its oids. */
  ciAllowlist?: CiAllowlist;
```

Add a helper:

```ts
const CI_REFUSED = "This object is not on the repository's allow list for GitHub Actions";

async function ciMayRead(ctx: LfsContext, oid: string): Promise<boolean> {
  return ctx.ciAllowlist === undefined || (await ctx.ciAllowlist.allows(ctx.repo, oid));
}
```

In `planObject`, make the first statement of the `if (operation === "download")` block:

```ts
    if (!(await ciMayRead(ctx, object.oid))) return { ...object, error: { code: 403, message: CI_REFUSED } };
```

In `download`, directly after the `hasPermission` check:

```ts
  if (!(await ciMayRead(ctx, oid))) return reject(403, CI_REFUSED);
```

- [ ] **Step 5: Wire it up in `handler.ts`**

In `src/http/handler.ts`, import `R2CiAllowlist` from `../infra/r2-ci-allowlist.ts`, and add this to the `ctx` literal in `handleRepository`, after the `onlyOid` spread:

```ts
      ...(auth.principal === "actions" && config.actionsOidc?.allowlist ? { ciAllowlist: new R2CiAllowlist(env.BUCKET) } : {}),
```

If Step 1 found a session endpoint that Actions credentials can reach, add the refusal there now, plus a test in `ci-allowlist.test.ts` that asserts a 403.

In `wrangler.jsonc` `vars`, add `"ACTIONS_OIDC_ALLOWLIST": "off"`.

- [ ] **Step 6: Run the tests, the whole suite, typecheck and lint**

```bash
R=/home/lokkju/projects/lokkju/r2-lfs
mise exec --cd $R -- pnpm --dir $R exec vitest run test/worker/ci-allowlist.test.ts
mise exec --cd $R -- pnpm --dir $R test
mise exec --cd $R -- pnpm --dir $R run typecheck
mise exec --cd $R -- pnpm --dir $R run lint
```

Expected: everything passes.

- [ ] **Step 7: Commit, tag and push**

```bash
R=/home/lokkju/projects/lokkju/r2-lfs
git -C $R add src/domain/allowlist.ts src/infra/r2-ci-allowlist.ts src/shared/contract.ts src/app/ports.ts src/domain/config.ts src/app/lfs.ts src/http/handler.ts wrangler.jsonc test/worker/ci-allowlist.test.ts
git -C $R commit -m "feat: limit Actions downloads to an allow list"
git -C $R tag v0.5.0-cp.1
git -C $R push origin codexpublicus v0.5.0-cp.1
```

- [ ] **Step 8: Offer both changes upstream**

Open one issue on `ken109/r2-lfs`, titled "Optional ref restriction and per-object allow list for Actions OIDC". Describe the two settings from `FORK.md` and link the fork's compare view:

```bash
gh issue create -R ken109/r2-lfs --title "Optional ref restriction and per-object allow list for Actions OIDC" \
  --body "$(cat /home/lokkju/projects/lokkju/r2-lfs/FORK.md)

Implementation: https://github.com/lokkju/r2-lfs/compare/v0.5.0...v0.5.0-cp.1"
```

---

### Task 8: codexpublicus-infra: stack, shared values and exports

**Files:**
- Modify: `/home/lokkju/projects/lokkju/infra/pulumi/__main__.py` (export `account_id`; this is lokkju/infra#12)
- Create: `pulumi/Pulumi.prod.yaml`, `pulumi/codexpublicus_infra/shared.py`, `pulumi/tests/test_shared.py`
- Modify: `pulumi/__main__.py`

**Interfaces:**
- Consumes: `Settings` (from Task 4).
- Produces:
  - `read_shared(stack_name: str) -> Shared`, where `Shared` has `account_id: pulumi.Output[str]`.
  - The stack output `account_id`.

- [ ] **Step 1: Export `account_id` from lokkju-infra (lokkju/infra#12)**

```bash
git -C /home/lokkju/projects/lokkju/infra fetch origin
git -C /home/lokkju/projects/lokkju/infra checkout -b lokkju/export-account-id origin/main
```

Add after the `ACCOUNT_ID = ...` line in `/home/lokkju/projects/lokkju/infra/pulumi/__main__.py`:

```python
pulumi.export("account_id", ACCOUNT_ID)
```

```bash
eval "$(mise env --cd /home/lokkju/projects/lokkju/infra)"
pulumi -C /home/lokkju/projects/lokkju/infra/pulumi preview --stack prod    # expect: 1 output added, 0 resource changes
pulumi -C /home/lokkju/projects/lokkju/infra/pulumi up --stack prod --yes
pulumi -C /home/lokkju/projects/lokkju/infra/pulumi stack output account_id --stack prod
git -C /home/lokkju/projects/lokkju/infra commit -am "feat(pulumi): export account_id"
git -C /home/lokkju/projects/lokkju/infra push -u origin lokkju/export-account-id
gh pr create -R lokkju/infra --fill --body "Closes #12" && gh pr merge -R lokkju/infra --merge --delete-branch
```

If `preview` shows any resource change, **stop**. That's drift in lokkju-infra, not part of this work.

- [ ] **Step 2: Write the failing test**

`pulumi/tests/test_shared.py`:

```python
import pulumi

import tests.conftest  # noqa: F401  (installs the mocks; StackReference yields account_id "acct-123")

from codexpublicus_infra.shared import read_shared  # noqa: E402


@pulumi.runtime.test
def test_reads_account_id_from_the_shared_stack():
    shared = read_shared("organization/lokkju-infra/prod")
    return shared.account_id.apply(lambda v: _check(v))


def _check(value):
    assert value == "acct-123"
```

- [ ] **Step 3: Run it to check that it fails**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q tests/test_shared.py`
Expected: FAIL with `ModuleNotFoundError: ... codexpublicus_infra.shared`.

- [ ] **Step 4: Implement `shared.py`**

```python
"""Values this project reads from lokkju-infra, and nothing else reads from there."""

from dataclasses import dataclass

import pulumi


@dataclass(frozen=True)
class Shared:
    account_id: pulumi.Output[str]


def read_shared(stack_name: str) -> Shared:
    ref = pulumi.StackReference("lokkju-infra", stack_name=stack_name)
    return Shared(account_id=ref.require_output("account_id"))
```

- [ ] **Step 5: Run the test to check that it passes**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q`
Expected: all passed.

- [ ] **Step 6: Write the stack config and wire up `__main__.py`**

`pulumi/Pulumi.prod.yaml` (the `encryptionsalt` line comes from `stack init`):

```yaml
config:
  codexpublicus-infra:shared_stack: organization/lokkju-infra/prod
  codexpublicus-infra:zones:
    - codexpublicus.org
    - codexpublicus.com
    - stare.pub
  codexpublicus-infra:redirects:
    codexpublicus.com: codexpublicus.org
  codexpublicus-infra:data_hosts:
    - data.gorsuch.codexpublicus.org
  codexpublicus-infra:lfs_host: lfs.codexpublicus.org
  codexpublicus-infra:lfs_bucket: codexpublicus-lfs
  codexpublicus-infra:bucket_location: WNAM
  codexpublicus-infra:site:
    project_name: codexpublicus-org
    domain: codexpublicus.org
    github_repo: codexpublicus/codexpublicus.org
```

`pulumi/__main__.py`:

```python
"""codexpublicus-infra: resources shared by every Codex Publicus site."""

import pulumi

from codexpublicus_infra.settings import load_settings
from codexpublicus_infra.shared import read_shared

settings = load_settings(pulumi.Config())
shared = read_shared(settings.shared_stack)

pulumi.export("account_id", shared.account_id)
```

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R checkout -b lokkju/stack-and-shared
eval "$(mise env --cd $R)"
pulumi -C $R/pulumi stack init prod
pulumi -C $R/pulumi up --stack prod --yes
pulumi -C $R/pulumi stack output account_id --stack prod    # 441c9b9997aeedf42f0c48d5bdb996cb
```

- [ ] **Step 7: Commit and PR**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R add pulumi/Pulumi.prod.yaml pulumi/__main__.py pulumi/codexpublicus_infra/shared.py pulumi/tests/test_shared.py
git -C $R commit -m "feat: prod stack reading account_id from lokkju-infra"
git -C $R push -u origin lokkju/stack-and-shared
gh pr create -R codexpublicus/infra --fill && gh pr merge -R codexpublicus/infra --merge --delete-branch
```

---

### Task 9: Import the three zones

**Files:**
- Create: `pulumi/codexpublicus_infra/zones.py`, `pulumi/tests/test_zones.py`
- Modify: `pulumi/__main__.py`

**Interfaces:**
- Consumes: `Settings.zones`, `Shared.account_id`.
- Produces:
  - `declare_zones(zone_names: list[str], account_id) -> dict[str, cloudflare.Zone]`
  - The outputs `zone_id_codexpublicus.org`, `zone_id_codexpublicus.com` and `zone_id_stare.pub`.

- [ ] **Step 1: Write the failing test**

`pulumi/tests/test_zones.py`:

```python
import pulumi

from tests.conftest import created  # noqa: F401  (installs the mocks)

from codexpublicus_infra.zones import declare_zones  # noqa: E402


@pulumi.runtime.test
def test_declares_one_full_zone_per_name_with_lokkju_infra_naming():
    before = len(created)
    zones = declare_zones(["codexpublicus.org", "stare.pub"], "acct-123")

    def check(_):
        zone_resources = [(n, i) for t, n, i in created[before:] if t == "cloudflare:index/zone:Zone"]
        assert [n for n, _ in zone_resources] == ["zone-codexpublicus.org", "zone-stare.pub"]
        for _, inputs in zone_resources:
            assert inputs["type"] == "full"
            assert inputs["account"] == {"id": "acct-123"}

    return zones["stare.pub"].id.apply(check)
```

- [ ] **Step 2: Run it to check that it fails**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q tests/test_zones.py`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `zones.py`**

```python
"""The zones Codex Publicus sites share. Records inside them belong to each site's own project."""

import pulumi
import pulumi_cloudflare as cloudflare


def declare_zones(zone_names: list[str], account_id) -> dict[str, cloudflare.Zone]:
    zones: dict[str, cloudflare.Zone] = {}
    for name in zone_names:
        zones[name] = cloudflare.Zone(
            f"zone-{name}",
            account={"id": account_id},
            name=name,
            type="full",
            opts=pulumi.ResourceOptions(protect=True),
        )
        pulumi.export(f"zone_id_{name}", zones[name].id)
    return zones
```

In `__main__.py`, add:

```python
from codexpublicus_infra.zones import declare_zones

zones = declare_zones(settings.zones, shared.account_id)
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q`
Expected: all passed.

- [ ] **Step 5: Import the live zones, then preview**

Use the zone ids recorded in Task 4 Step 4:

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R checkout -b lokkju/zones origin/main
eval "$(mise env --cd $R)"
pulumi -C $R/pulumi import cloudflare:index/zone:Zone zone-codexpublicus.org <id-codexpublicus.org> --stack prod --yes
pulumi -C $R/pulumi import cloudflare:index/zone:Zone zone-codexpublicus.com <id-codexpublicus.com> --stack prod --yes
pulumi -C $R/pulumi import cloudflare:index/zone:Zone zone-stare.pub <id-stare.pub> --stack prod --yes
pulumi -C $R/pulumi preview --stack prod --diff
```

Expected: `preview` shows the three zones unchanged and only the new outputs. If it shows an update to a zone property (plan, paused, `vanity_name_servers`), make the code match the live value, so that nothing changes on `up`.

```bash
pulumi -C $R/pulumi up --stack prod --yes
pulumi -C $R/pulumi stack output --stack prod --json | jq 'keys'
```

Expected: `account_id` plus the three `zone_id_*` keys.

- [ ] **Step 6: Commit and PR**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R add pulumi/codexpublicus_infra/zones.py pulumi/tests/test_zones.py pulumi/__main__.py
git -C $R commit -m "feat: import codexpublicus and stare.pub zones"
git -C $R push -u origin lokkju/zones
gh pr create -R codexpublicus/infra --fill && gh pr merge -R codexpublicus/infra --merge --delete-branch
```

---

### Task 10: Redirect codexpublicus.com to codexpublicus.org

**Files:**
- Create: `pulumi/codexpublicus_infra/redirects.py`, `pulumi/tests/test_redirects.py`
- Modify: `pulumi/__main__.py`

**Interfaces:**
- Consumes: `Settings.redirects`, and the `zones` dict from Task 9.
- Produces: `declare_redirects(redirects: dict[str, str], zones: dict[str, cloudflare.Zone]) -> None`

- [ ] **Step 1: List existing records and rulesets on the .com zone**

```bash
eval "$(mise env --cd /home/lokkju/projects/lokkju/codexpublicus-infra)"
Z=$(pulumi -C /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi stack output 'zone_id_codexpublicus.com' --stack prod)
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/zones/$Z/dns_records" | jq '[.result[] | {name,type,content}]'
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/zones/$Z/rulesets" | jq '[.result[] | select(.kind=="zone") | {id,phase}]'
```

- If `@` or `www` records exist, import them under the names this task creates (`redirect-codexpublicus.com-apex`, `redirect-codexpublicus.com-www`) with `pulumi import cloudflare:index/dnsRecord:DnsRecord <name> <zone-id>/<record-id>`, or delete them if they point nowhere.
- If an `http_request_dynamic_redirect` ruleset exists, import it as `redirect-codexpublicus.com` with `pulumi import cloudflare:index/ruleset:Ruleset redirect-codexpublicus.com zones/<zone-id>/<ruleset-id>`.

- [ ] **Step 2: Write the failing test**

`pulumi/tests/test_redirects.py`:

```python
import pulumi

from tests.conftest import created  # noqa: F401  (installs the mocks)

import pulumi_cloudflare as cloudflare  # noqa: E402

from codexpublicus_infra.redirects import declare_redirects  # noqa: E402


@pulumi.runtime.test
def test_redirects_every_path_of_the_source_zone_to_the_target():
    before = len(created)
    zone = cloudflare.Zone("zone-codexpublicus.com", account={"id": "a"}, name="codexpublicus.com", type="full")
    declare_redirects({"codexpublicus.com": "codexpublicus.org"}, {"codexpublicus.com": zone})

    def check(_):
        records = [(n, i) for t, n, i in created[before:] if t == "cloudflare:index/dnsRecord:DnsRecord"]
        assert len(records) == 4
        assert sorted({i["name"] for _, i in records}) == ["@", "www"]
        assert all(i["proxied"] is True for _, i in records)
        rulesets = [i for t, _, i in created[before:] if t == "cloudflare:index/ruleset:Ruleset"]
        assert len(rulesets) == 1
        rule = rulesets[0]["rules"][0]
        assert rulesets[0]["phase"] == "http_request_dynamic_redirect"
        assert rule["action"] == "redirect"
        target = rule["action_parameters"]["from_value"]
        assert target["status_code"] == 301
        assert target["preserve_query_string"] is True
        assert target["target_url"]["expression"] == 'concat("https://codexpublicus.org", http.request.uri.path)'

    return zone.id.apply(check)
```

- [ ] **Step 3: Run it to check that it fails**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q tests/test_redirects.py`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 4: Implement `redirects.py`**

```python
"""Whole-zone redirects, such as codexpublicus.com to codexpublicus.org."""

import pulumi_cloudflare as cloudflare

# RFC 5737 / RFC 6666 discard addresses: the proxy answers before anything is dialled.
_DISCARD = [("A", "192.0.2.1"), ("AAAA", "100::")]


def declare_redirects(redirects: dict[str, str], zones: dict[str, cloudflare.Zone]) -> None:
    for source, target in redirects.items():
        zone = zones[source]
        for label, name in (("apex", "@"), ("www", "www")):
            for rtype, content in _DISCARD:
                suffix = "" if rtype == "A" else "-v6"
                cloudflare.DnsRecord(
                    f"redirect-{source}-{label}{suffix}",
                    zone_id=zone.id,
                    name=name,
                    type=rtype,
                    content=content,
                    proxied=True,
                    ttl=1,
                )
        cloudflare.Ruleset(
            f"redirect-{source}",
            zone_id=zone.id,
            name=f"Redirect {source} to {target}",
            kind="zone",
            phase="http_request_dynamic_redirect",
            rules=[
                {
                    "action": "redirect",
                    "expression": "true",
                    "description": f"{source} to {target}",
                    "enabled": True,
                    "action_parameters": {
                        "from_value": {
                            "status_code": 301,
                            "preserve_query_string": True,
                            "target_url": {"expression": f'concat("https://{target}", http.request.uri.path)'},
                        }
                    },
                }
            ],
        )
```

In `__main__.py`, add:

```python
from codexpublicus_infra.redirects import declare_redirects

declare_redirects(settings.redirects, zones)
```

- [ ] **Step 5: Run the tests, then apply and check the live redirect**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
uv run --directory $R/pulumi pytest -q
git -C $R checkout -b lokkju/com-redirect origin/main
eval "$(mise env --cd $R)"
pulumi -C $R/pulumi up --stack prod --yes
sleep 30; curl -sI https://codexpublicus.com/a/b?x=1 | grep -i '^\(HTTP\|location\)'
curl -sI https://www.codexpublicus.com/ | grep -i '^\(HTTP\|location\)'
```

Expected: `HTTP/2 301`, with `location: https://codexpublicus.org/a/b?x=1` and `location: https://codexpublicus.org/`. If the certificate isn't active yet, wait and retry; Universal SSL can take a few minutes on a newly proxied name.

- [ ] **Step 6: Commit and PR**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R add pulumi/codexpublicus_infra/redirects.py pulumi/tests/test_redirects.py pulumi/__main__.py
git -C $R commit -m "feat: redirect codexpublicus.com to .org"
git -C $R push -u origin lokkju/com-redirect
gh pr create -R codexpublicus/infra --fill && gh pr merge -R codexpublicus/infra --merge --delete-branch
```

---

### Task 11: Cache and compression rules for the data hosts

**Files:**
- Create: `pulumi/codexpublicus_infra/edge_rules.py`, `pulumi/tests/test_edge_rules.py`
- Modify: `pulumi/__main__.py`

**Interfaces:**
- Consumes: `Settings.data_hosts`, the `zones` dict, and `settings.zone_of` (from Task 4).
- Produces: `declare_edge_rules(data_hosts: list[str], zones: dict[str, cloudflare.Zone]) -> None`. Each zone gets one entry-point `Ruleset` for `http_request_cache_settings` and one for `http_response_compression`.

- [ ] **Step 1: List existing entry-point rulesets on each zone that has a data host (Review Focus 4)**

```bash
eval "$(mise env --cd /home/lokkju/projects/lokkju/codexpublicus-infra)"
Z=$(pulumi -C /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi stack output 'zone_id_codexpublicus.org' --stack prod)
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/zones/$Z/rulesets" \
  | jq '[.result[] | select(.kind=="zone" and (.phase=="http_request_cache_settings" or .phase=="http_response_compression")) | {id,phase}]'
```

If either exists, import it before `up`, as `cache-codexpublicus.org` or `compression-codexpublicus.org`:

```bash
pulumi -C /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi import cloudflare:index/ruleset:Ruleset cache-codexpublicus.org zones/$Z/<ruleset-id> --stack prod --yes
```

Then copy any rules it already has into `edge_rules.py` as additional rules, so `up` keeps them.

- [ ] **Step 2: Write the failing test**

`pulumi/tests/test_edge_rules.py`:

```python
import pulumi

from tests.conftest import created  # noqa: F401  (installs the mocks)

import pulumi_cloudflare as cloudflare  # noqa: E402

from codexpublicus_infra.edge_rules import declare_edge_rules  # noqa: E402


@pulumi.runtime.test
def test_one_cache_and_one_compression_rule_per_data_host():
    before = len(created)
    org = cloudflare.Zone("zone-codexpublicus.org", account={"id": "a"}, name="codexpublicus.org", type="full")
    declare_edge_rules(["data.gorsuch.codexpublicus.org", "data.x.codexpublicus.org"], {"codexpublicus.org": org})

    def check(_):
        rulesets = {i["phase"]: i for t, _, i in created[before:] if t == "cloudflare:index/ruleset:Ruleset"}
        assert set(rulesets) == {"http_request_cache_settings", "http_response_compression"}

        cache = rulesets["http_request_cache_settings"]["rules"]
        assert [r["expression"] for r in cache] == [
            '(http.host eq "data.gorsuch.codexpublicus.org")',
            '(http.host eq "data.x.codexpublicus.org")',
        ]
        params = cache[0]["action_parameters"]
        assert cache[0]["action"] == "set_cache_settings"
        assert params["cache"] is True
        assert params["edge_ttl"] == {
            "mode": "override_origin",
            "default": 31536000,
            "status_code_ttls": [{"status_code": 404, "value": 60}],
        }
        assert params["browser_ttl"] == {"mode": "respect_origin"}

        compression = rulesets["http_response_compression"]["rules"]
        assert compression[0]["action"] == "compress_response"
        assert compression[0]["action_parameters"] == {"algorithms": [{"name": "none"}]}

    return org.id.apply(check)


@pulumi.runtime.test
def test_no_rulesets_without_data_hosts():
    before = len(created)
    org = cloudflare.Zone("zone-empty", account={"id": "a"}, name="codexpublicus.org", type="full")
    declare_edge_rules([], {"codexpublicus.org": org})
    return org.id.apply(lambda _: _assert_no_rulesets(before))


def _assert_no_rulesets(before):
    assert not [t for t, _, _ in created[before:] if t == "cloudflare:index/ruleset:Ruleset"]
```

- [ ] **Step 3: Run it to check that it fails**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q tests/test_edge_rules.py`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 4: Implement `edge_rules.py`**

```python
"""Zone entry-point rulesets for the static data hosts: long edge cache, no compression."""

from collections import defaultdict

import pulumi_cloudflare as cloudflare

from codexpublicus_infra.settings import zone_of

YEAR = 365 * 24 * 60 * 60


def _host(host: str) -> str:
    return f'(http.host eq "{host}")'


def declare_edge_rules(data_hosts: list[str], zones: dict[str, cloudflare.Zone]) -> None:
    by_zone: dict[str, list[str]] = defaultdict(list)
    for host in data_hosts:
        by_zone[zone_of(host, list(zones))].append(host)

    for zone_name, hosts in by_zone.items():
        zone = zones[zone_name]
        cloudflare.Ruleset(
            f"cache-{zone_name}",
            zone_id=zone.id,
            name=f"Cache settings for {zone_name}",
            kind="zone",
            phase="http_request_cache_settings",
            rules=[
                {
                    "action": "set_cache_settings",
                    "expression": _host(host),
                    "description": f"{host}: write-once objects, cache for a year",
                    "enabled": True,
                    "action_parameters": {
                        "cache": True,
                        "edge_ttl": {
                            "mode": "override_origin",
                            "default": YEAR,
                            "status_code_ttls": [{"status_code": 404, "value": 60}],
                        },
                        "browser_ttl": {"mode": "respect_origin"},
                    },
                }
                for host in hosts
            ],
        )
        cloudflare.Ruleset(
            f"compression-{zone_name}",
            zone_id=zone.id,
            name=f"Compression for {zone_name}",
            kind="zone",
            phase="http_response_compression",
            rules=[
                {
                    "action": "compress_response",
                    "expression": _host(host),
                    "description": f"{host}: no Content-Encoding, so range requests work",
                    "enabled": True,
                    "action_parameters": {"algorithms": [{"name": "none"}]},
                }
                for host in hosts
            ],
        )
```

In `__main__.py`, add:

```python
from codexpublicus_infra.edge_rules import declare_edge_rules

declare_edge_rules(settings.data_hosts, zones)
```

- [ ] **Step 5: Run the tests, then apply**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
uv run --directory $R/pulumi pytest -q
git -C $R checkout -b lokkju/edge-rules origin/main
eval "$(mise env --cd $R)"
pulumi -C $R/pulumi preview --stack prod --diff
pulumi -C $R/pulumi up --stack prod --yes
```

Expected: two rulesets are created, or updated if Step 1 imported them. `data.gorsuch.codexpublicus.org` doesn't serve yet; gorsuch-library#63 creates it. Its live checks (range, cache HIT, no `Content-Encoding`) run in gorsuch-library's `infra-verify` after that.

- [ ] **Step 6: Commit and PR**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R add pulumi/codexpublicus_infra/edge_rules.py pulumi/tests/test_edge_rules.py pulumi/__main__.py
git -C $R commit -m "feat: cache and compression rules for data hosts"
git -C $R push -u origin lokkju/edge-rules
gh pr create -R codexpublicus/infra --fill --body "Implements lokkju/infra#14 in its new home." && gh pr merge -R codexpublicus/infra --merge --delete-branch
```

---

### Task 12: LFS bucket, Worker deployment and the live security checks

**Files:**
- Create in `codexpublicus/infra`:
  - `pulumi/codexpublicus_infra/lfs.py`
  - `pulumi/tests/test_lfs.py`
  - `lfs/wrangler.jsonc`
  - `.mise/tasks/lfs-deploy`
  - `.mise/tasks/lfs-verify`
- Modify: `pulumi/__main__.py`, `README.md`

**Interfaces:**
- Consumes:
  - `Settings.lfs_host`, `lfs_bucket` and `bucket_location`
  - `Shared.account_id`
  - the tag `v0.5.0-cp.1` of `lokkju/r2-lfs` (from Task 7)
- Produces:
  - The outputs `lfs_proxy_url` (plain), `lfs_bucket` (plain), and as secrets `lfs_r2_access_key_id`, `lfs_r2_secret_access_key` and `lfs_operator_token`.
  - `declare_lfs(settings, account_id) -> LfsOutputs`

- [ ] **Step 1: Write the failing test**

`pulumi/tests/test_lfs.py`:

```python
import json

import pulumi

from tests.conftest import created  # noqa: F401  (installs the mocks)

from codexpublicus_infra.lfs import declare_lfs  # noqa: E402
from codexpublicus_infra.settings import parse_settings  # noqa: E402
from tests.test_settings import RAW  # noqa: E402


@pulumi.runtime.test
def test_one_private_bucket_and_a_key_scoped_to_it():
    before = len(created)
    out = declare_lfs(parse_settings(RAW), "acct-123")

    def check(args):
        url, secret = args
        assert url == "https://lfs.codexpublicus.org"
        buckets = [i for t, _, i in created[before:] if t == "cloudflare:index/r2Bucket:R2Bucket"]
        assert [b["name"] for b in buckets] == ["codexpublicus-lfs"]
        assert not [t for t, _, _ in created[before:] if t == "cloudflare:index/r2CustomDomain:R2CustomDomain"]
        token = next(i for t, _, i in created[before:] if t == "cloudflare:index/accountToken:AccountToken")
        resources = json.loads(token["policies"][0]["resources"])
        assert resources == {"com.cloudflare.edge.r2.bucket.acct-123_default_codexpublicus-lfs": "*"}
        assert {g["id"] for g in token["policies"][0]["permission_groups"]} == {"read-id", "write-id"}
        import hashlib
        assert secret == hashlib.sha256(b"token-value").hexdigest()

    return pulumi.Output.all(out.proxy_url, out.r2_secret_access_key).apply(check)
```


- [ ] **Step 2: Run it to check that it fails**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q tests/test_lfs.py`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `lfs.py`**

```python
"""Storage and credentials for the organization's r2-lfs Worker. Wrangler deploys the Worker itself."""

import hashlib
import json
from dataclasses import dataclass

import pulumi
import pulumi_cloudflare as cloudflare
import pulumi_random as random

from codexpublicus_infra.settings import Settings

R2_READ = "Workers R2 Storage Bucket Item Read"
R2_WRITE = "Workers R2 Storage Bucket Item Write"


@dataclass(frozen=True)
class LfsOutputs:
    proxy_url: pulumi.Output[str]
    r2_access_key_id: pulumi.Output[str]
    r2_secret_access_key: pulumi.Output[str]
    operator_token: pulumi.Output[str]


def declare_lfs(settings: Settings, account_id) -> LfsOutputs:
    bucket = cloudflare.R2Bucket(
        "lfs-bucket",
        account_id=account_id,
        name=settings.lfs_bucket,
        location=settings.bucket_location,
        opts=pulumi.ResourceOptions(protect=True),
    )

    groups = cloudflare.get_account_api_token_permission_groups_list_output(account_id=account_id)
    by_name = groups.results.apply(lambda results: {g["name"]: g["id"] for g in results})
    token = cloudflare.AccountToken(
        "lfs-worker-r2",
        account_id=account_id,
        name=f"r2-lfs-{settings.lfs_bucket}",
        policies=[{
            "effect": "allow",
            "permission_groups": [
                {"id": by_name.apply(lambda m: m[R2_READ])},
                {"id": by_name.apply(lambda m: m[R2_WRITE])},
            ],
            "resources": pulumi.Output.from_input(account_id).apply(
                lambda acct: json.dumps({f"com.cloudflare.edge.r2.bucket.{acct}_default_{settings.lfs_bucket}": "*"})
            ),
        }],
        opts=pulumi.ResourceOptions(depends_on=[bucket], ignore_changes=["policies"]),
    )
    # R2's S3 credentials: the access key id is the token id, the secret is SHA-256 of the token value.
    secret = pulumi.Output.secret(token.value.apply(lambda v: hashlib.sha256(v.encode()).hexdigest()))

    operator = random.RandomPassword("lfs-operator-token", length=48, special=False)

    proxy_url = pulumi.Output.from_input(f"https://{settings.lfs_host}")
    pulumi.export("lfs_proxy_url", proxy_url)
    pulumi.export("lfs_bucket", bucket.name)
    pulumi.export("lfs_r2_access_key_id", pulumi.Output.secret(token.id))
    pulumi.export("lfs_r2_secret_access_key", secret)
    pulumi.export("lfs_operator_token", pulumi.Output.secret(operator.result))
    return LfsOutputs(proxy_url, token.id, secret, pulumi.Output.secret(operator.result))
```

If the Pulumi mocks don't serve the `_output` form of the permission-group invoke, add a `call` branch for `cloudflare:index/getAccountApiTokenPermissionGroupsList:getAccountApiTokenPermissionGroupsList` in `conftest.py` returning the same `results`.

In `__main__.py`:

```python
from codexpublicus_infra.lfs import declare_lfs

lfs = declare_lfs(settings, shared.account_id)
```

- [ ] **Step 4: Run the tests, then apply**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
uv run --directory $R/pulumi pytest -q
git -C $R checkout -b lokkju/lfs origin/main
eval "$(mise env --cd $R)"
pulumi -C $R/pulumi up --stack prod --yes
pulumi -C $R/pulumi stack output --stack prod --json | jq 'keys'
```

Expected: the keys include `lfs_proxy_url`, `lfs_bucket`, `lfs_r2_access_key_id`, `lfs_r2_secret_access_key` and `lfs_operator_token`.

- [ ] **Step 5: Write the Worker config and the deploy task**

`lfs/wrangler.jsonc` is upstream's file at the tag, changed in these places:
- `name`: `codexpublicus-lfs`
- The bucket and custom domain
- The `vars` block

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "codexpublicus-lfs",
  "main": "src/server.ts",
  "compatibility_date": "2026-08-22",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "run_worker_first": ["/_admin/*"] },
  "observability": { "enabled": true },
  "durable_objects": { "bindings": [{ "name": "LOCKS", "class_name": "RepoLocks" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RepoLocks"] }],
  "analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "codexpublicus_lfs" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "codexpublicus-lfs" }],
  "routes": [{ "pattern": "lfs.codexpublicus.org", "custom_domain": true }],
  "workers_dev": false,
  "vars": {
    "ALLOWED_REPOS": "codexpublicus/*",
    "AUTH_MODE": "token",
    "AUTH_HOST": "",
    "STORAGE_LAYOUT": "per-repo",
    "TRANSFER_MODE": "presigned",
    "PROXY_MAX_UPLOAD_MB": "100",
    "MAX_OBJECT_MB": "",
    "QUOTA_GB": "",
    "R2_ACCOUNT_ID": "441c9b9997aeedf42f0c48d5bdb996cb",
    "R2_BUCKET_NAME": "codexpublicus-lfs",
    "ACCESS_TEAM_DOMAIN": "",
    "ACCESS_AUD": "",
    "ADMIN_EMAILS": "",
    "ACTIONS_OIDC": "read",
    "ACTIONS_OIDC_AUDIENCE": "https://lfs.codexpublicus.org",
    "ACTIONS_OIDC_REFS": "refs/heads/*,refs/pull/*/merge",
    "ACTIONS_OIDC_ALLOWLIST": "on",
    "VERIFY_UPLOADS": "on"
  }
}
```

Before writing this file, diff it against `wrangler.jsonc` at `v0.5.0-cp.1`:

```bash
git -C /home/lokkju/projects/lokkju/r2-lfs show v0.5.0-cp.1:wrangler.jsonc
```

Any binding or setting upstream has that isn't listed above gets carried over unchanged.

`.mise/tasks/lfs-deploy`:

```bash
#!/usr/bin/env bash
#MISE description="Build lokkju/r2-lfs at the pinned tag and deploy it as codexpublicus-lfs"
#USAGE arg "[tag]" default="v0.5.0-cp.1" help="lokkju/r2-lfs tag to deploy"
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
TAG="${usage_tag:-v0.5.0-cp.1}"
BUILD="$ROOT/lfs/build"
rm -rf "$BUILD"
git clone --quiet --depth 1 --branch "$TAG" https://github.com/lokkju/r2-lfs.git "$BUILD"
cp "$ROOT/lfs/wrangler.jsonc" "$BUILD/wrangler.jsonc"
pnpm --dir "$BUILD" install --frozen-lockfile
pnpm --dir "$BUILD" run build
STACK=(pulumi -C "$ROOT/pulumi" stack output --stack prod --show-secrets)
printf '%s' "$("${STACK[@]}" lfs_r2_access_key_id)" | wrangler --cwd "$BUILD" secret put R2_ACCESS_KEY_ID
printf '%s' "$("${STACK[@]}" lfs_r2_secret_access_key)" | wrangler --cwd "$BUILD" secret put R2_SECRET_ACCESS_KEY
printf '%s' "codexpublicus/*:rw:$("${STACK[@]}" lfs_operator_token)" | wrangler --cwd "$BUILD" secret put AUTH_TOKENS
wrangler --cwd "$BUILD" deploy
```

`wrangler secret put` creates the Worker on its first call, if it doesn't exist yet. If this Wrangler version refuses to, run `wrangler --cwd "$BUILD" deploy` once before the secrets, then again after them.

- [ ] **Step 6: Deploy**

```bash
chmod +x /home/lokkju/projects/lokkju/codexpublicus-infra/.mise/tasks/lfs-deploy
mise run --cd /home/lokkju/projects/lokkju/codexpublicus-infra lfs-deploy
curl -s https://lfs.codexpublicus.org/_r2-lfs/info | jq .
```

Expected: the info JSON shows `actionsOidcAudience: "https://lfs.codexpublicus.org"` and no config problems.

- [ ] **Step 7: Write the live verification task**

`.mise/tasks/lfs-verify`:

```bash
#!/usr/bin/env bash
#MISE description="Check the deployed LFS proxy: operator round trip and CI refusals"
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
URL="$(pulumi -C "$ROOT/pulumi" stack output lfs_proxy_url --stack prod)"
OP="$(pulumi -C "$ROOT/pulumi" stack output lfs_operator_token --stack prod --show-secrets)"
REPO="codexpublicus/infra"
batch() { curl -s -u "operator:$OP" -H 'Content-Type: application/vnd.git-lfs+json' -d "$1" "$URL/$REPO/objects/batch"; }
DATA="lfs-verify $(date -u +%FT%TZ)"
OID=$(printf '%s' "$DATA" | sha256sum | cut -d' ' -f1); SIZE=${#DATA}
UP=$(batch "{\"operation\":\"upload\",\"objects\":[{\"oid\":\"$OID\",\"size\":$SIZE}]}")
HREF=$(jq -r '.objects[0].actions.upload.href' <<<"$UP")
jq -r '.objects[0].actions.upload.header // {} | to_entries[] | "\(.key): \(.value)"' <<<"$UP" > /tmp/lfs-verify-headers
printf '%s' "$DATA" | curl -sf -X PUT -H @/tmp/lfs-verify-headers --data-binary @- "$HREF" >/dev/null
VERIFY=$(jq -r '.objects[0].actions.verify.href // empty' <<<"$UP")
[ -n "$VERIFY" ] && curl -sf -u "operator:$OP" -H 'Content-Type: application/vnd.git-lfs+json' -d "{\"oid\":\"$OID\",\"size\":$SIZE}" "$VERIFY" >/dev/null
DOWN=$(batch "{\"operation\":\"download\",\"objects\":[{\"oid\":\"$OID\",\"size\":$SIZE}]}")
GOT=$(curl -sf "$(jq -r '.objects[0].actions.download.href' <<<"$DOWN")")
[ "$GOT" = "$DATA" ] && echo "ok: operator upload and download round trip" || { echo "FAIL: round trip"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -u "oidc:eyJhbGciOiJSUzI1NiJ9.eyJ4IjoxfQ.c2ln" -H 'Content-Type: application/vnd.git-lfs+json' \
  -d '{"operation":"download","objects":[]}' "$URL/$REPO/objects/batch")
[ "$CODE" = 401 ] && echo "ok: forged Actions token refused" || { echo "FAIL: forged token got $CODE"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -u "operator:$OP" -H 'Content-Type: application/vnd.git-lfs+json' \
  -d '{"operation":"download","objects":[]}' "$URL/someone-else/repo/objects/batch")
[ "$CODE" = 403 ] && echo "ok: repository outside codexpublicus/* refused" || { echo "FAIL: foreign repo got $CODE"; exit 1; }
rm -f /tmp/lfs-verify-headers
echo "CI checks (write refused, unlisted object refused, other repo and other ref refused) run from gorsuch-library's CI once it uses the proxy."
```

Run it:

```bash
chmod +x /home/lokkju/projects/lokkju/codexpublicus-infra/.mise/tasks/lfs-verify
mise run --cd /home/lokkju/projects/lokkju/codexpublicus-infra lfs-verify
```

Expected: three `ok:` lines.

- [ ] **Step 8: Document it, commit and PR**

In `README.md`, add an "LFS proxy" section covering:
- `mise run lfs-deploy [tag]` and `mise run lfs-verify`;
- the `.lfsconfig` a consumer commits (`[lfs] url = https://lfs.codexpublicus.org/codexpublicus/<repo>`);
- how the operator stores the token: `pulumi stack output lfs_operator_token --show-secrets`, then `git credential approve` with `protocol=https`, `host=lfs.codexpublicus.org`, `username=operator`;
- how the operator publishes an allow list:

```bash
wrangler r2 object put codexpublicus-lfs/_allowlist/codexpublicus/<repo>.txt --file lfs-policy/ci-readable.txt --content-type text/plain --remote
```

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R add pulumi/codexpublicus_infra/lfs.py pulumi/tests/test_lfs.py pulumi/__main__.py pulumi/pyproject.toml pulumi/uv.lock lfs/wrangler.jsonc .mise/tasks/lfs-deploy .mise/tasks/lfs-verify README.md
git -C $R commit -m "feat: LFS proxy storage, deploy and verify"
git -C $R push -u origin lokkju/lfs
gh pr create -R codexpublicus/infra --fill --body "Implements lokkju/infra#13 in its new home." && gh pr merge -R codexpublicus/infra --merge --delete-branch
```

---

### Task 13: Umbrella site Pages project and deploy

**Files:**
- Create in `codexpublicus/infra`: `pulumi/codexpublicus_infra/site.py`, `pulumi/tests/test_site.py`
- Modify: `pulumi/__main__.py`

**Interfaces:**
- Consumes:
  - `Settings.site`, the `zones` dict and `Shared.account_id`
  - the repo `codexpublicus/codexpublicus.org` (from Task 15)
- Produces:
  - A Pages project `codexpublicus-org` on `codexpublicus.org`.
  - The Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `codexpublicus/codexpublicus.org`.
  - The output `pages_project_codexpublicus-org`.

- [ ] **Step 1: Write the failing test**

`pulumi/tests/test_site.py`:

```python
import pulumi

from tests.conftest import created  # noqa: F401  (installs the mocks)

import pulumi_cloudflare as cloudflare  # noqa: E402

from codexpublicus_infra.settings import SiteSettings  # noqa: E402
from codexpublicus_infra.site import declare_site  # noqa: E402


@pulumi.runtime.test
def test_pages_project_domain_record_and_repo_secrets():
    before = len(created)
    zone = cloudflare.Zone("zone-codexpublicus.org", account={"id": "a"}, name="codexpublicus.org", type="full")
    site = SiteSettings("codexpublicus-org", "codexpublicus.org", "codexpublicus/codexpublicus.org")
    project = declare_site(site, {"codexpublicus.org": zone}, "acct-123")

    def check(_):
        kinds = {t for t, _, _ in created[before:]}
        assert "cloudflare:index/pagesProject:PagesProject" in kinds
        domain = next(i for t, _, i in created[before:] if t == "cloudflare:index/pagesDomain:PagesDomain")
        assert domain["name"] == "codexpublicus.org"
        record = next(i for t, _, i in created[before:] if t == "cloudflare:index/dnsRecord:DnsRecord")
        assert (record["name"], record["type"], record["content"], record["proxied"]) == ("@", "CNAME", "codexpublicus-org.pages.dev", True)
        secrets = {i["secret_name"]: i for t, _, i in created[before:] if t == "github:index/actionsSecret:ActionsSecret"}
        assert set(secrets) == {"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"}
        assert all(s["repository"] == "codexpublicus.org" for s in secrets.values())

    return project.name.apply(check)
```

- [ ] **Step 2: Run it to check that it fails**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi pytest -q tests/test_site.py`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `site.py`**

It uses the permission-group ids `lokkju-infra` already hardcodes (`__main__.py:31-33`):

```python
"""The codexpublicus.org umbrella page: a Pages project deployed from its own repo's Actions."""

import json

import pulumi
import pulumi_cloudflare as cloudflare
import pulumi_github as github

from codexpublicus_infra.settings import SiteSettings

PAGES_WRITE_ID = "8d28297797f24fb8a0c332fe0866ec89"
ACCOUNT_SETTINGS_READ_ID = "c1fde68c7bcc44588cbb6ddbc16d6480"


def declare_site(site: SiteSettings, zones: dict[str, cloudflare.Zone], account_id) -> cloudflare.PagesProject:
    project = cloudflare.PagesProject(
        f"pages-{site.project_name}",
        account_id=account_id,
        name=site.project_name,
        production_branch="main",
    )
    cloudflare.PagesDomain(
        f"pages-domain-{site.domain}",
        account_id=account_id,
        project_name=project.name,
        name=site.domain,
    )
    cloudflare.DnsRecord(
        f"dns-{site.domain}-pages",
        zone_id=zones[site.domain].id,
        name="@",
        type="CNAME",
        content=f"{site.project_name}.pages.dev",
        proxied=True,
        ttl=1,
    )
    token = cloudflare.AccountToken(
        f"pages-token-{site.project_name}",
        account_id=account_id,
        name=f"pages-deploy-{site.project_name}",
        policies=[{
            "effect": "allow",
            "permission_groups": [{"id": PAGES_WRITE_ID}, {"id": ACCOUNT_SETTINGS_READ_ID}],
            "resources": pulumi.Output.from_input(account_id).apply(
                lambda acct: json.dumps({f"com.cloudflare.api.account.{acct}": "*"})
            ),
        }],
        opts=pulumi.ResourceOptions(ignore_changes=["policies"]),
    )
    owner, repo = site.github_repo.split("/")
    gh = github.Provider(f"github-{owner}", owner=owner)
    opts = pulumi.ResourceOptions(provider=gh)
    github.ActionsSecret(f"gh-secret-cf-token-{site.project_name}", repository=repo,
                         secret_name="CLOUDFLARE_API_TOKEN", plaintext_value=token.value, opts=opts)
    github.ActionsSecret(f"gh-secret-cf-account-{site.project_name}", repository=repo,
                         secret_name="CLOUDFLARE_ACCOUNT_ID", plaintext_value=account_id, opts=opts)
    pulumi.export(f"pages_project_{site.project_name}", project.name)
    return project
```

In `__main__.py`:

```python
from codexpublicus_infra.site import declare_site

declare_site(settings.site, zones, shared.account_id)
```

- [ ] **Step 4: Check the apex before applying**

```bash
eval "$(mise env --cd /home/lokkju/projects/lokkju/codexpublicus-infra)"
Z=$(pulumi -C /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi stack output 'zone_id_codexpublicus.org' --stack prod)
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/zones/$Z/dns_records?name=codexpublicus.org" | jq '[.result[] | {id,type,content}]'
```

If an apex record exists, import it as `dns-codexpublicus.org-pages` or delete it. Then:

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
uv run --directory $R/pulumi pytest -q
git -C $R checkout -b lokkju/umbrella-site origin/main
pulumi -C $R/pulumi up --stack prod --yes
gh secret list -R codexpublicus/codexpublicus.org    # CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
```

- [ ] **Step 5: Trigger the site's deploy and check it**

```bash
gh workflow run deploy.yml -R codexpublicus/codexpublicus.org
gh run watch -R codexpublicus/codexpublicus.org --exit-status $(gh run list -R codexpublicus/codexpublicus.org -L1 --json databaseId --jq '.[0].databaseId')
sleep 60; curl -s https://codexpublicus.org/ | grep -o '<title>[^<]*</title>'
```

Expected: `<title>Codex Publicus</title>`.

- [ ] **Step 6: Commit and PR**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus-infra
git -C $R add pulumi/codexpublicus_infra/site.py pulumi/tests/test_site.py pulumi/__main__.py
git -C $R commit -m "feat: Pages project for the umbrella site"
git -C $R push -u origin lokkju/umbrella-site
gh pr create -R codexpublicus/infra --fill && gh pr merge -R codexpublicus/infra --merge --delete-branch
```

---

### Task 14: Retarget the tickets and update the consumers

**Files:**
- `gorsuch-library` (branch `lokkju/org-infra`):
  - `docs/superpowers/specs/2026-09-26-corpus-correctness-and-infrastructure-design.md`
  - `docs/superpowers/plans/2026-09-26-p1-storage-and-infrastructure.md`
  - `docs/superpowers/plans/2026-09-26-v1-plan-index.md`
- Issues on `lokkju/infra`, `codexpublicus/infra`, `codexpublicus/gorsuch-library` and `codexpublicus/stare`.

**Interfaces:**
- Consumes: Task 3 (the transfers), and Tasks 8, 11 and 12 (the outputs exist).
- Produces: every open reference points at the org and at `organization/codexpublicus-infra/prod`.

- [ ] **Step 1: Recreate infra#11, #13 and #14 in `codexpublicus/infra`, then close the originals**

```bash
for n in 11 13 14; do
  T=$(gh issue view $n -R lokkju/infra --json title --jq .title)
  B=$(gh issue view $n -R lokkju/infra --json body --jq .body)
  NEW=$(gh issue create -R codexpublicus/infra --title "$T" --body "$B

_Moved from lokkju/infra#$n: Codex Publicus shared infrastructure now lives in this repo (see codexpublicus/stare \`docs/superpowers/specs/2026-09-26-codexpublicus-org-migration-design.md\`)._")
  gh issue close $n -R lokkju/infra --comment "Moved to $NEW. Codex Publicus zones, edge rules and the LFS proxy live in codexpublicus/infra."
  echo "$n -> $NEW"
done
```

Close each new issue with a link to the PR that implemented it: #11 to Task 9's PR, #14 to Task 11's, and #13 to Task 12's. Each gets a comment naming the PR.

- [ ] **Step 2: Comment on infra#6**

```bash
gh issue comment 6 -R lokkju/infra --body "Partial update (2026-09-26): Codex Publicus now has its own GitHub org (codexpublicus) and its own Pulumi project, codexpublicus-infra/prod, which reads only account_id from lokkju-infra/prod. That settles where Codex Publicus infra lives. The question of an org for lokkju's own repos, and ARC runners, is unchanged."
```

- [ ] **Step 3: Update gorsuch-library#63 and stare#3**

```bash
gh issue comment 63 -R codexpublicus/gorsuch-library --body "Updated for the org move (2026-09-26):
- Stack reference: organization/codexpublicus-infra/prod (not lokkju-infra). Outputs: account_id, zone_id_codexpublicus.org, lfs_proxy_url.
- LFS: the org runs one r2-lfs instance at https://lfs.codexpublicus.org with one bucket, codexpublicus-lfs. This repo no longer creates an LFS bucket or LFS keys. .lfsconfig url: https://lfs.codexpublicus.org/codexpublicus/gorsuch-library
- CI allow list: the operator uploads lfs-policy/ci-readable.txt to codexpublicus-lfs/_allowlist/codexpublicus/gorsuch-library.txt with wrangler (see codexpublicus/infra README). Accepted refs: refs/heads/* and refs/pull/*/merge.
- Edge rules for data.gorsuch.codexpublicus.org are in codexpublicus-infra already, keyed by its data_hosts config, not by this repo's stack output.
- Prerequisites are now codexpublicus/infra issues, not lokkju/infra#11-#14."
gh issue comment 3 -R codexpublicus/stare --body "Stack reference target is organization/codexpublicus-infra/prod (account_id, zone_id_stare.pub). The stare.pub zone itself is managed there; this repo's Pulumi owns the records inside it."
```

- [ ] **Step 4: Update gorsuch-library's spec and P1 plan on a branch**

```bash
G=/home/lokkju/projects/lokkju/gorsuch-library
git -C $G fetch origin && git -C $G checkout -b lokkju/org-infra origin/main
```

Before editing, check that no other session has uncommitted work in these files: `git -C $G status --short docs/`. If there is, stop and ask the operator.

Apply these changes in the spec and in P1:

1. `organization/lokkju-infra/prod` becomes `organization/codexpublicus-infra/prod`. In P1's G1 check, change the path `/home/lokkju/projects/lokkju/infra` to `/home/lokkju/projects/lokkju/codexpublicus-infra`. Every other `lokkju-infra` that names the shared layer becomes `codexpublicus-infra`.
2. `lokkju/infra#11`, `#13` and `#14` become the issue numbers created in Step 1, in `codexpublicus/infra`. `lokkju/infra#12` becomes "done (codexpublicus-infra exports `account_id`)".
3. `lokkju/gorsuch-library` becomes `codexpublicus/gorsuch-library` in GitHub references, the LFS URL paths and the `github_repo` config.
4. Rewrite the spec's "Server and credentials" to match the amended org spec:
   - one org-wide r2-lfs instance at `https://lfs.codexpublicus.org`, bucket `codexpublicus-lfs`;
   - no LFS bucket or LFS keys in this repo;
   - the operator token lives in `codexpublicus-infra`'s `lfs_operator_token` output;
   - the allow list is uploaded by the operator to `_allowlist/codexpublicus/gorsuch-library.txt`.
5. In P1, delete the tasks or steps that create `gorsuch-library-lfs`, the LFS read-write and read-only keys, and the `lfs-proxy` key exported to lokkju-infra. Replace the allow-list delivery with a `mise run lfs-policy-push` task that runs the `wrangler r2 object put` command from the codexpublicus/infra README. Keep the `data_host` output; it's still useful for `infra-verify`, though the edge rules no longer read it.
6. In the plan index line 20, `lokkju/infra#11-#14` becomes the `codexpublicus/infra` issue numbers.

Leave filesystem paths under `/home/lokkju/projects/lokkju/gorsuch-library` alone; the local directory doesn't move.

```bash
grep -rn "lokkju-infra\|lokkju/infra#\|organization/lokkju-infra" $G/docs/superpowers/specs/2026-09-26-corpus-correctness-and-infrastructure-design.md $G/docs/superpowers/plans/2026-09-26-p1-storage-and-infrastructure.md $G/docs/superpowers/plans/2026-09-26-v1-plan-index.md
```

Expected: no hits except historical notes, which get kept on purpose and marked "(before the org move)".

```bash
git -C $G add docs/superpowers/specs/2026-09-26-corpus-correctness-and-infrastructure-design.md docs/superpowers/plans/2026-09-26-p1-storage-and-infrastructure.md docs/superpowers/plans/2026-09-26-v1-plan-index.md
git -C $G commit -m "docs: point infra at codexpublicus-infra"
git -C $G push -u origin lokkju/org-infra
gh pr create -R codexpublicus/gorsuch-library --fill
```

Leave this PR open for the operator to review, because it rewrites an active plan.

---

### Task 15: The codexpublicus.org umbrella page

**Files:**
- Create in `/home/lokkju/projects/lokkju/codexpublicus.org` (the clone of `codexpublicus/codexpublicus.org`):
  - `public/index.html`
  - `public/style.css`
  - `public/_headers`
  - `.github/workflows/deploy.yml`
  - `README.md`
  - `LICENSE`
  - `.mise/config.toml`
  - `.mise/tasks/check`

**Interfaces:**
- Produces:
  - A static page in `public/`.
  - A workflow `deploy.yml` that runs `wrangler pages deploy public --project-name codexpublicus-org --branch main` using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets (set by Task 13).

- [ ] **Step 1: Create the repo**

```bash
gh repo create codexpublicus/codexpublicus.org --private --description "The Codex Publicus umbrella site"
git clone git@github.com:codexpublicus/codexpublicus.org.git /home/lokkju/projects/lokkju/codexpublicus.org
```

- [ ] **Step 2: Write the failing check**

`.mise/tasks/check`:

```bash
#!/usr/bin/env bash
#MISE description="Check the page: links, no inline styles, no em-dashes, CSP-safe"
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
P="$ROOT/public"
fail() { echo "FAIL: $1"; exit 1; }
[ -f "$P/index.html" ] || fail "public/index.html missing"
grep -q '<title>Codex Publicus</title>' "$P/index.html" || fail "title"
grep -q 'href="https://stare.pub/"' "$P/index.html" || fail "stare.pub link"
grep -q 'href="https://gorsuch.codexpublicus.org/"' "$P/index.html" || fail "Gorsuch library link"
grep -q 'mailto:info@stare.pub' "$P/index.html" || fail "contact"
grep -q 'style=' "$P/index.html" && fail "inline style attribute"
grep -q '<style' "$P/index.html" && fail "inline style element"
grep -q '<script' "$P/index.html" && fail "script"
grep -rqP '\x{2014}' "$P" && fail "em-dash"
grep -q "Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'" "$P/_headers" || fail "CSP header"
echo ok
```

```bash
chmod +x /home/lokkju/projects/lokkju/codexpublicus.org/.mise/tasks/check
mise run --cd /home/lokkju/projects/lokkju/codexpublicus.org check
```

Expected: `FAIL: public/index.html missing`.

- [ ] **Step 3: Write the page**

`public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Publicus</title>
  <meta name="description" content="Codex Publicus keeps United States law freely readable: case law, the writings of judges, and the tools to cite them, as static files anyone can mirror.">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main>
    <h1>Codex Publicus</h1>
    <p>Codex Publicus keeps the law readable by anyone, without an account, a subscription or a server that can go away. Every project here publishes static files that anyone can mirror, and runs from a mirror with no network.</p>

    <h2>Projects</h2>
    <dl>
      <dt><a href="https://stare.pub/">stare.pub</a></dt>
      <dd>Resolves U.S. case law citations to the opinion text and the original scanned reporter page, built on the Harvard Caselaw Access Project's 6.7 million cases.</dd>
      <dt><a href="https://gorsuch.codexpublicus.org/">The Neil Gorsuch Library</a></dt>
      <dd>Every opinion and writing of Justice Neil Gorsuch, with the source documents they were read from, as a site and as a dataset.</dd>
    </dl>

    <h2>Contact</h2>
    <p><a href="mailto:info@stare.pub">info@stare.pub</a></p>
  </main>
  <footer>
    <p>Court opinions are public domain. Each project states its own code and data licenses.</p>
  </footer>
</body>
</html>
```

`public/style.css`:

```css
:root {
  --bg: #fbfaf7;
  --fg: #1d1b18;
  --muted: #5d584f;
  --link: #1f4e8c;
  --rule: #d9d4ca;
  --measure: 38rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161513;
    --fg: #ece8e1;
    --muted: #a9a398;
    --link: #8fb4ea;
    --rule: #3a3731;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 1.0625rem/1.6 Georgia, "Times New Roman", serif;
}
main, footer { max-width: var(--measure); margin: 0 auto; padding: 0 1rem; }
main { padding-top: 4rem; }
h1 { font-size: 2.25rem; font-weight: normal; margin: 0 0 1.5rem; }
h2 { font-size: 1.125rem; margin: 2.5rem 0 0.75rem; }
dt { margin-top: 1rem; font-weight: bold; }
dd { margin: 0.25rem 0 0; color: var(--muted); }
a { color: var(--link); }
footer { margin-top: 4rem; padding-bottom: 3rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: 0.9375rem; }
```

`public/_headers`:

```
/*
  Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
```

- [ ] **Step 4: Run the check and view the page**

```bash
mise run --cd /home/lokkju/projects/lokkju/codexpublicus.org check
uv run python -m http.server -d /home/lokkju/projects/lokkju/codexpublicus.org/public 8791
```

Expected: `ok`. Open `http://localhost:8791/` at a phone width and a desktop width, in light and dark mode. The text is readable, nothing scrolls horizontally, and both links work. Stop the server afterwards.

- [ ] **Step 5: Write the deploy workflow, the toolchain, README and LICENSE**

`.github/workflows/deploy.yml`:

```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Check
        run: bash .mise/tasks/check
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Deploy to Cloudflare Pages
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: npx --yes wrangler@4 pages deploy public --project-name codexpublicus-org --branch main
```

`.mise/config.toml`:

```toml
[tools]
wrangler = "latest"
```

`README.md`: two short paragraphs. The first says what the page is. The second says it deploys from `main` through `deploy.yml`, with the Pages project and secrets owned by `codexpublicus/infra` (`codexpublicus-infra/prod`).

`LICENSE`: PolyForm Shield 1.0.0, copied from `/home/lokkju/projects/lokkju/gorsuch-library/LICENSE`.

- [ ] **Step 6: Commit and push**

```bash
R=/home/lokkju/projects/lokkju/codexpublicus.org
git -C $R add public/index.html public/style.css public/_headers .github/workflows/deploy.yml .mise/config.toml .mise/tasks/check README.md LICENSE
git -C $R commit -m "feat: codexpublicus.org umbrella page"
git -C $R push -u origin main
```

This first push to an empty repo triggers `deploy.yml`, which fails until Task 13 sets the secrets. That's expected. Task 13 Step 5 re-runs it.

---

### Task 16: Wrap up

**Files:**
- Modify: `/home/lokkju/.claude/projects/-home-lokkju-projects-lokkju-codex-publicus/memory/project_codex_publicus.md`

- [ ] **Step 1: Check the end state**

```bash
gh repo list codexpublicus --json name,visibility --jq '.[] | "\(.name) \(.visibility)"'
# expect: stare, gorsuch-library, infra, codexpublicus.org, all PRIVATE
eval "$(mise env --cd /home/lokkju/projects/lokkju/codexpublicus-infra)"
pulumi -C /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi stack output --stack prod --json | jq 'keys'
curl -sI https://codexpublicus.com/ | grep -i location     # https://codexpublicus.org/
curl -s https://codexpublicus.org/ | grep -o '<title>[^<]*</title>'
curl -s https://lfs.codexpublicus.org/_r2-lfs/info | jq -r .actionsOidcAudience
gh issue list -R lokkju/infra --state open --json number,title --jq '.[] | "#\(.number) \(.title)"'
# expect: no Codex Publicus issues left open
```

- [ ] **Step 2: Update project memory**

Add to `project_codex_publicus.md`:
- the org's repo list;
- the stack `organization/codexpublicus-infra/prod` and its outputs;
- the LFS proxy URL;
- `lokkju/r2-lfs` as the fork, deployed with `mise run lfs-deploy` from `codexpublicus/infra`.

- [ ] **Step 3: Clean up the scratch directories**

```bash
rm -rf /home/lokkju/projects/lokkju/.gitleaks /home/lokkju/projects/lokkju/.r2-lfs-research /home/lokkju/projects/lokkju/.codex-publicus-mirror.git
```
