# Pulumi secrets and state Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `lokkju/pulumi-kit` and move `codexpublicus-infra/prod` and `stare-infra/prod` onto derived per-stack passphrases, config-held provider tokens, plain-only outputs and self-published CI credentials.

**Architecture:** A small Python package (library plus `pulumi-kit` CLI) derives each stack's passphrase from one master secret, wraps every local Pulumi invocation, and gives programs `publish_ci_credentials`. The two stacks take it as a tag-pinned dependency, stop exporting secrets, read provider tokens from stack config, and gain a GitHub workflow that previews on PRs and applies on `main` or a release. The operator runs every rotation, `config set` and `up`, in the order the runbook fixes.

**Tech Stack:** Python 3.11+, uv, Pulumi 3 (Python, DIY S3 backend on R2), pulumi-github 6, pulumi-cloudflare 6.13.0 (pinned), pytest, bash mise file tasks, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-28-pulumi-secrets-and-state-design.md` (this repo).

## Global Constraints

- Derivation: `base64url(HKDF-SHA256(ikm=master, salt=b"pulumi-kit/passphrase/v1", info=FQSN.encode(), L=32))`, no padding. FQSN is `organization/<project>/<stack>`. Master is at least 32 bytes, stored base64.
- Bootstrap file: `~/.config/pulumi-kit/bootstrap.env` (override: env `PULUMI_KIT_BOOTSTRAP`), mode 0600, keys `PULUMI_KIT_MASTER`, `PULUMI_KIT_BACKEND_ACCESS_KEY_ID`, `PULUMI_KIT_BACKEND_SECRET_ACCESS_KEY`.
- Backend URL, pinned in each `Pulumi.yaml` under `backend: url:`: `s3://lokkju-pulumi-state?endpoint=https://441c9b9997aeedf42f0c48d5bdb996cb.r2.cloudflarestorage.com&region=auto`.
- CI secret names: `PULUMI_BACKEND_ACCESS_KEY_ID`, `PULUMI_BACKEND_SECRET_ACCESS_KEY`, `PULUMI_CONFIG_PASSPHRASE_<STACK>` (stack name uppercased, non-alphanumerics to `_`; `prod` gives `PULUMI_CONFIG_PASSPHRASE_PROD`).
- Provider tokens are stack config secrets: `cloudflare:apiToken`, `github:token`.
- No stack output of `codexpublicus-infra` or `stare-infra` may be secret (spec rule 6).
- `pulumi-kit` is pinned as `pulumi-kit @ git+https://github.com/lokkju/pulumi-kit@v0.1.0`.
- `pulumi-cloudflare==6.13.0` stays pinned in both consumers; tests enforce it.
- The operator runs every `pulumi up`, `config set`, `change-secrets-provider`, `import` and `state` command. Agents run `preview`, `stack export` (no `--show-secrets`) and tests only.
- Never print a secret value, in a log, a commit, a PR body or a report.
- Worktrees only; never edit `~/projects/lokkju/codexpublicus-infra` or `~/projects/lokkju/codex-publicus` main checkouts. No `cd dir && cmd`. `uv run`, never bare `python`.
- Conventional commits, no AI attribution. No em-dashes in prose or comments.
- GitHub Actions are pinned by full commit SHA, with the tag in a trailing comment.
- License: PolyForm Shield 1.0.0 (copy `~/projects/lokkju/codexpublicus-infra/LICENSE`).

## Review Focus

1. A stack name given as `--stack=prod`, `-s prod` or fully qualified (`organization/x/prod`) must derive the same passphrase as `--stack prod`; a missing stack flag must refuse, not guess. (Task 2 tests all four.)
2. A bootstrap file readable by group or other must refuse to load, naming the file and the mode. (Task 1 test.)
3. `pulumi-kit run` must not leak a project's own `AWS_ENDPOINT_URL_S3`, `CLOUDFLARE_API_TOKEN` or `GITHUB_TOKEN` into Pulumi; stare's env carries all three. (Task 2 test.)
4. The CI workflow on a PR from a fork, or before credentials are published, must skip Pulumi with a notice instead of failing. (Task 4 template, exercised in Tasks 6 and 7.)
5. A program run without `pulumi-kit run` must fail `publish_ci_credentials` with a message naming the missing variable, not a `KeyError` (the stare#34 lesson). (Task 3 test.)

---

## File structure

**`lokkju/pulumi-kit`** (new repo, checkout `~/projects/lokkju/pulumi-kit`):

| File | Responsibility |
|---|---|
| `src/pulumi_kit/derive.py` | HKDF-SHA256 and `derive_passphrase` |
| `src/pulumi_kit/bootstrap.py` | read and create the bootstrap file |
| `src/pulumi_kit/stack.py` | project name from `Pulumi.yaml`, FQSN from pulumi args |
| `src/pulumi_kit/env.py` | build the environment Pulumi runs under |
| `src/pulumi_kit/cli.py` | `init`, `passphrase`, `run`, `secret` |
| `src/pulumi_kit/publish.py` | `publish_ci_credentials` |
| `src/pulumi_kit/__init__.py` | re-exports `derive_passphrase`, `publish_ci_credentials` |
| `templates/mise-pulumi-task`, `templates/pulumi.yml` | files consumers copy |
| `tests/…` | one test module per source module |

**`codexpublicus/infra`** (worktree `~/projects/lokkju/codexpublicus-infra-wt/pulumi-kit`, branch `lokkju/pulumi-kit`): `pulumi/Pulumi.yaml`, `pulumi/Pulumi.prod.yaml`, `pulumi/pyproject.toml`, `pulumi/uv.lock`, `pulumi/__main__.py`, new `pulumi/codexpublicus_infra/providers.py`, `settings.py`, `site.py`, `lfs.py`, `stare_pub.py`, delete `shared.py`; tests alongside; `.mise/tasks/{pulumi,lfs-deploy,lfs-verify,lfs-allowlist-put}`, `.github/workflows/pulumi.yml`, `AGENTS.md`.

**`codexpublicus/stare`** (worktree `~/projects/lokkju/codex-publicus/.claude/worktrees/pulumi-kit-adopt`, branch `lokkju/pulumi-kit-adopt`): `infra/Pulumi.yaml`, `infra/pyproject.toml`, `infra/uv.lock`, `infra/__main__.py`, new `infra/stare_infra/providers.py`, `infra/stare_infra/deploy.py`; tests; `.mise/tasks/pulumi`, `.github/workflows/pulumi.yml`, `AGENTS.md`.

---

## Controller setup (before Task 1)

- [ ] Create the repo and its first commit on `main` (README stub + LICENSE), then a work branch:

```bash
gh repo create lokkju/pulumi-kit --public --description "Shared Pulumi secrets and state helpers" --clone=false
git clone git@github.com:lokkju/pulumi-kit.git /home/lokkju/projects/lokkju/pulumi-kit
cp /home/lokkju/projects/lokkju/codexpublicus-infra/LICENSE /home/lokkju/projects/lokkju/pulumi-kit/LICENSE
printf '# pulumi-kit\n\nShared Pulumi secrets and state helpers.\n' > /home/lokkju/projects/lokkju/pulumi-kit/README.md
git -C /home/lokkju/projects/lokkju/pulumi-kit add LICENSE README.md
git -C /home/lokkju/projects/lokkju/pulumi-kit commit -m "chore: initial commit"
git -C /home/lokkju/projects/lokkju/pulumi-kit push -u origin main
git -C /home/lokkju/projects/lokkju/pulumi-kit checkout -b lokkju/v0.1.0
```

The repo is public: both consumers' CI installs it with `uv sync`, and a private repo would need a deploy key or token in every consumer. It holds no secrets.

---

### Task 1: pulumi-kit package, derivation and bootstrap file

**Files:**
- Create: `pyproject.toml`, `src/pulumi_kit/__init__.py`, `src/pulumi_kit/derive.py`, `src/pulumi_kit/bootstrap.py`, `tests/__init__.py`, `tests/test_derive.py`, `tests/test_bootstrap.py`, `.gitignore`

**Interfaces:**
- Produces: `derive_passphrase(master: bytes, fqsn: str) -> str`; `hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes`; `Bootstrap(master: bytes, access_key_id: str, secret_access_key: str)`; `bootstrap_path() -> Path`; `load_bootstrap(path: Path | None = None) -> Bootstrap`; `create_bootstrap(access_key_id: str, secret_access_key: str, path: Path | None = None) -> Path`; `BootstrapError(Exception)`.

- [ ] **Step 1: Write `pyproject.toml` and `.gitignore`**

```toml
[project]
name = "pulumi-kit"
version = "0.1.0"
description = "Shared Pulumi secrets and state helpers"
requires-python = ">=3.11"
license = "LicenseRef-PolyForm-Shield-1.0.0"
dependencies = [
    "pulumi>=3.0.0,<4.0.0",
    "pulumi-github>=6.0.0,<7.0.0",
    "pyyaml>=6.0",
]

[project.scripts]
pulumi-kit = "pulumi_kit.cli:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/pulumi_kit"]

[dependency-groups]
dev = ["pytest>=8.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`.gitignore`: `.venv/`, `__pycache__/`, `*.egg-info/`, `dist/`.

- [ ] **Step 2: Write the failing tests**

`tests/test_derive.py`:

```python
import base64

import pytest

from pulumi_kit.derive import derive_passphrase, hkdf_sha256

MASTER = bytes(range(32))


def test_hkdf_matches_rfc5869_case_1():
    okm = hkdf_sha256(
        bytes.fromhex("0b" * 22),
        bytes.fromhex("000102030405060708090a0b0c"),
        bytes.fromhex("f0f1f2f3f4f5f6f7f8f9"),
        42,
    )
    assert okm.hex() == (
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    )


@pytest.mark.parametrize(
    ("fqsn", "expected"),
    [
        ("organization/stare-infra/prod", "YLZL3r7J2vFXj5LN9gl34Zpmctebdn9sxp8AcjWGTNg"),
        ("organization/codexpublicus-infra/prod", "eUemVhyv8lPtt3xvbwl14ZfYECTTegYKTZVz9za8nr8"),
    ],
)
def test_derive_vectors(fqsn, expected):
    assert derive_passphrase(MASTER, fqsn) == expected


def test_different_stacks_differ():
    a = derive_passphrase(MASTER, "organization/a/prod")
    b = derive_passphrase(MASTER, "organization/b/prod")
    assert a != b


def test_output_is_unpadded_base64url_of_32_bytes():
    out = derive_passphrase(MASTER, "organization/a/prod")
    assert "=" not in out
    assert len(base64.urlsafe_b64decode(out + "=")) == 32


def test_short_master_refused():
    with pytest.raises(ValueError, match="at least 32 bytes"):
        derive_passphrase(b"x" * 31, "organization/a/prod")


@pytest.mark.parametrize("fqsn", ["prod", "a/prod", "organization/a/prod/x", "organization//prod", "org/a b/prod"])
def test_malformed_fqsn_refused(fqsn):
    with pytest.raises(ValueError, match="fully qualified"):
        derive_passphrase(MASTER, fqsn)
```

`tests/test_bootstrap.py`:

```python
import base64
import os
import stat

import pytest

from pulumi_kit.bootstrap import BootstrapError, bootstrap_path, create_bootstrap, load_bootstrap

MASTER_B64 = base64.b64encode(bytes(range(32))).decode()


def _write(path, body, mode=0o600):
    path.write_text(body)
    os.chmod(path, mode)
    return path


def _good(tmp_path, mode=0o600):
    return _write(
        tmp_path / "bootstrap.env",
        "# comment\n\n"
        f"PULUMI_KIT_MASTER={MASTER_B64}\n"
        "PULUMI_KIT_BACKEND_ACCESS_KEY_ID=akid\n"
        "PULUMI_KIT_BACKEND_SECRET_ACCESS_KEY=sk\n",
        mode,
    )


def test_load(tmp_path):
    b = load_bootstrap(_good(tmp_path))
    assert b.master == bytes(range(32))
    assert (b.access_key_id, b.secret_access_key) == ("akid", "sk")


def test_path_override(tmp_path, monkeypatch):
    monkeypatch.setenv("PULUMI_KIT_BOOTSTRAP", str(tmp_path / "x.env"))
    assert bootstrap_path() == tmp_path / "x.env"


def test_default_path(monkeypatch):
    monkeypatch.delenv("PULUMI_KIT_BOOTSTRAP", raising=False)
    assert str(bootstrap_path()).endswith(".config/pulumi-kit/bootstrap.env")


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o644])
def test_loose_mode_refused(tmp_path, mode):
    path = _good(tmp_path, mode)
    with pytest.raises(BootstrapError, match=r"bootstrap.env.*0600"):
        load_bootstrap(path)


def test_missing_file_named(tmp_path):
    with pytest.raises(BootstrapError, match="pulumi-kit init"):
        load_bootstrap(tmp_path / "nope.env")


def test_missing_key_named(tmp_path):
    path = _write(tmp_path / "b.env", f"PULUMI_KIT_MASTER={MASTER_B64}\nPULUMI_KIT_BACKEND_ACCESS_KEY_ID=a\n")
    with pytest.raises(BootstrapError, match="PULUMI_KIT_BACKEND_SECRET_ACCESS_KEY"):
        load_bootstrap(path)


def test_bad_master_refused_without_echoing_it(tmp_path):
    path = _write(
        tmp_path / "b.env",
        "PULUMI_KIT_MASTER=not-base64!!\nPULUMI_KIT_BACKEND_ACCESS_KEY_ID=a\nPULUMI_KIT_BACKEND_SECRET_ACCESS_KEY=b\n",
    )
    with pytest.raises(BootstrapError) as err:
        load_bootstrap(path)
    assert "not-base64" not in str(err.value)


def test_create(tmp_path):
    path = create_bootstrap("akid", "sk", tmp_path / "sub" / "bootstrap.env")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    b = load_bootstrap(path)
    assert len(b.master) == 32
    assert (b.access_key_id, b.secret_access_key) == ("akid", "sk")


def test_create_refuses_overwrite(tmp_path):
    path = _good(tmp_path)
    before = path.read_text()
    with pytest.raises(BootstrapError, match="already exists"):
        create_bootstrap("x", "y", path)
    assert path.read_text() == before
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest -q` (from `~/projects/lokkju/pulumi-kit`, via `uv run --directory /home/lokkju/projects/lokkju/pulumi-kit pytest -q`)
Expected: collection errors, `ModuleNotFoundError: No module named 'pulumi_kit'` or missing names.

- [ ] **Step 4: Implement**

`src/pulumi_kit/derive.py`:

```python
"""Per-stack passphrases derived from one master secret (HKDF-SHA256, RFC 5869)."""

import base64
import hashlib
import hmac
import re

SALT = b"pulumi-kit/passphrase/v1"
_PART = r"[A-Za-z0-9_.-]+"
_FQSN = re.compile(rf"^{_PART}/{_PART}/{_PART}$")


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, block, counter = b"", b"", 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def derive_passphrase(master: bytes, fqsn: str) -> str:
    """The passphrase for stack `fqsn` (`organization/<project>/<stack>`)."""
    if len(master) < 32:
        raise ValueError("master secret must be at least 32 bytes")
    if not _FQSN.match(fqsn):
        raise ValueError(f"stack name must be fully qualified (organization/<project>/<stack>), got {fqsn!r}")
    okm = hkdf_sha256(master, SALT, fqsn.encode(), 32)
    return base64.urlsafe_b64encode(okm).rstrip(b"=").decode()
```

`src/pulumi_kit/bootstrap.py`:

```python
"""The operator's three local values: the master secret and the state backend's keys."""

import base64
import binascii
import os
import secrets
import stat
from dataclasses import dataclass
from pathlib import Path

KEYS = ("PULUMI_KIT_MASTER", "PULUMI_KIT_BACKEND_ACCESS_KEY_ID", "PULUMI_KIT_BACKEND_SECRET_ACCESS_KEY")


class BootstrapError(Exception):
    pass


@dataclass(frozen=True)
class Bootstrap:
    master: bytes
    access_key_id: str
    secret_access_key: str


def bootstrap_path() -> Path:
    override = os.environ.get("PULUMI_KIT_BOOTSTRAP")
    if override:
        return Path(override)
    return Path.home() / ".config" / "pulumi-kit" / "bootstrap.env"


def _parse(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def load_bootstrap(path: Path | None = None) -> Bootstrap:
    path = path or bootstrap_path()
    if not path.exists():
        raise BootstrapError(f"{path} does not exist; create it with `pulumi-kit init`")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise BootstrapError(f"{path} is mode {mode:04o}; it must be 0600 (chmod 600 {path})")
    values = _parse(path.read_text())
    for key in KEYS:
        if not values.get(key):
            raise BootstrapError(f"{path} has no {key}")
    try:
        master = base64.b64decode(values["PULUMI_KIT_MASTER"], validate=True)
    except (binascii.Error, ValueError):
        raise BootstrapError(f"PULUMI_KIT_MASTER in {path} is not valid base64") from None
    if len(master) < 32:
        raise BootstrapError(f"PULUMI_KIT_MASTER in {path} decodes to fewer than 32 bytes")
    return Bootstrap(master, values["PULUMI_KIT_BACKEND_ACCESS_KEY_ID"], values["PULUMI_KIT_BACKEND_SECRET_ACCESS_KEY"])


def create_bootstrap(access_key_id: str, secret_access_key: str, path: Path | None = None) -> Path:
    """Write a new bootstrap file with a fresh 32-byte master. Never overwrites."""
    path = path or bootstrap_path()
    if path.exists():
        raise BootstrapError(f"{path} already exists; refusing to overwrite it")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    master = base64.b64encode(secrets.token_bytes(32)).decode()
    body = (
        "# pulumi-kit bootstrap. Keep a copy in Bitwarden; the master also offline.\n"
        f"PULUMI_KIT_MASTER={master}\n"
        f"PULUMI_KIT_BACKEND_ACCESS_KEY_ID={access_key_id}\n"
        f"PULUMI_KIT_BACKEND_SECRET_ACCESS_KEY={secret_access_key}\n"
    )
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)
    return path
```

`src/pulumi_kit/__init__.py` (Task 3 adds `publish_ci_credentials`):

```python
from pulumi_kit.derive import derive_passphrase

__all__ = ["derive_passphrase"]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run --directory /home/lokkju/projects/lokkju/pulumi-kit pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git -C /home/lokkju/projects/lokkju/pulumi-kit add pyproject.toml uv.lock .gitignore src tests
git -C /home/lokkju/projects/lokkju/pulumi-kit commit -m "feat: derive per-stack passphrases and load bootstrap"
```

---

### Task 2: stack resolution, the Pulumi environment and the CLI

**Files:**
- Create: `src/pulumi_kit/stack.py`, `src/pulumi_kit/env.py`, `src/pulumi_kit/cli.py`, `tests/test_stack.py`, `tests/test_env.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: Task 1's `derive_passphrase`, `load_bootstrap`, `create_bootstrap`, `Bootstrap`, `BootstrapError`.
- Produces: `project_name(project_dir: Path) -> str`; `stack_from_args(args: list[str]) -> str | None`; `fqsn(project: str, stack: str) -> str`; `pulumi_env(base: Mapping[str, str], boot: Bootstrap, fqsn: str) -> dict[str, str]`; `find_secret(deployment: dict, resource: str, prop: str) -> str`; CLI `main(argv: list[str] | None = None) -> int` with subcommands `init [--backend-keys-from-env]`, `passphrase FQSN`, `run [--cwd DIR] -- ARGS...`, `secret [--cwd DIR] --stack S RESOURCE PROPERTY`.

- [ ] **Step 1: Write the failing tests**

`tests/test_stack.py`:

```python
import pytest

from pulumi_kit.stack import StackError, fqsn, project_name, stack_from_args


def test_project_name(tmp_path):
    (tmp_path / "Pulumi.yaml").write_text("name: stare-infra\nruntime: python\n")
    assert project_name(tmp_path) == "stare-infra"


def test_project_name_missing(tmp_path):
    with pytest.raises(StackError, match="Pulumi.yaml"):
        project_name(tmp_path)


@pytest.mark.parametrize(
    "args",
    [
        ["preview", "--stack", "prod"],
        ["preview", "--stack=prod"],
        ["preview", "-s", "prod"],
        ["up", "--yes", "-s", "prod", "--diff"],
    ],
)
def test_stack_from_args(args):
    assert stack_from_args(args) == "prod"


def test_stack_absent():
    assert stack_from_args(["preview", "--diff"]) is None


def test_stack_after_double_dash_ignored():
    assert stack_from_args(["preview", "--", "--stack", "prod"]) is None


def test_fqsn_short_and_qualified():
    assert fqsn("stare-infra", "prod") == "organization/stare-infra/prod"
    assert fqsn("stare-infra", "organization/stare-infra/prod") == "organization/stare-infra/prod"


def test_fqsn_other_project_refused():
    with pytest.raises(StackError, match="belongs to project other"):
        fqsn("stare-infra", "organization/other/prod")
```

`tests/test_env.py`:

```python
from pulumi_kit.bootstrap import Bootstrap
from pulumi_kit.derive import derive_passphrase
from pulumi_kit.env import pulumi_env

BOOT = Bootstrap(bytes(range(32)), "backend-akid", "backend-sk")
FQSN = "organization/stare-infra/prod"


def test_sets_backend_keys_and_passphrase():
    env = pulumi_env({"PATH": "/bin", "HOME": "/h"}, BOOT, FQSN)
    assert env["AWS_ACCESS_KEY_ID"] == "backend-akid"
    assert env["AWS_SECRET_ACCESS_KEY"] == "backend-sk"
    assert env["PULUMI_CONFIG_PASSPHRASE"] == derive_passphrase(BOOT.master, FQSN)
    assert env["PATH"] == "/bin" and env["HOME"] == "/h"


def test_strips_project_credentials():
    base = {
        "PATH": "/bin",
        "AWS_ENDPOINT_URL_S3": "https://wrong",
        "AWS_ACCESS_KEY_ID": "idx-key",
        "AWS_PROFILE": "p",
        "AWS_SESSION_TOKEN": "t",
        "CLOUDFLARE_API_TOKEN": "cf",
        "CLOUDFLARE_API_KEY": "cfk",
        "CLOUDFLARE_EMAIL": "e",
        "GITHUB_TOKEN": "gh",
        "PULUMI_CONFIG_PASSPHRASE_FILE": "/f",
        "PULUMI_BACKEND_URL": "file:///wrong",
        "PULUMI_KIT_MASTER": "m",
    }
    env = pulumi_env(base, BOOT, FQSN)
    for key in ("AWS_ENDPOINT_URL_S3", "AWS_PROFILE", "AWS_SESSION_TOKEN", "CLOUDFLARE_API_TOKEN",
                "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "GITHUB_TOKEN", "PULUMI_CONFIG_PASSPHRASE_FILE",
                "PULUMI_BACKEND_URL", "PULUMI_KIT_MASTER"):
        assert key not in env
    assert env["AWS_ACCESS_KEY_ID"] == "backend-akid"


def test_does_not_mutate_base():
    base = {"GITHUB_TOKEN": "gh"}
    pulumi_env(base, BOOT, FQSN)
    assert base == {"GITHUB_TOKEN": "gh"}
```

`tests/test_cli.py` (a fake `pulumi` on `PATH` records argv and env as JSON):

```python
import base64
import json
import os
import stat
import subprocess
import sys
import textwrap

import pytest

from pulumi_kit.derive import derive_passphrase

MASTER = bytes(range(32))


@pytest.fixture
def setup(tmp_path):
    boot = tmp_path / "bootstrap.env"
    boot.write_text(
        f"PULUMI_KIT_MASTER={base64.b64encode(MASTER).decode()}\n"
        "PULUMI_KIT_BACKEND_ACCESS_KEY_ID=backend-akid\n"
        "PULUMI_KIT_BACKEND_SECRET_ACCESS_KEY=backend-sk\n"
    )
    os.chmod(boot, 0o600)
    proj = tmp_path / "infra"
    proj.mkdir()
    (proj / "Pulumi.yaml").write_text("name: stare-infra\nruntime: python\n")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    record = tmp_path / "record.json"
    fake = bindir / "pulumi"
    fake.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, os, sys
        if sys.argv[1:4] == ["-C", {str(proj)!r}, "stack"] and "export" in sys.argv:
            print(json.dumps({{"deployment": {{"resources": [
                {{"urn": "urn:pulumi:prod::stare-infra::random:index/randomPassword:RandomPassword::op",
                  "outputs": {{"result": {{"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
                                           "plaintext": "\\"s3cret\\""}}}}}}]}}}}))
            sys.exit(0)
        json.dump({{"argv": sys.argv[1:], "env": dict(os.environ)}}, open({str(record)!r}, "w"))
        """))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{bindir}:{os.environ['PATH']}", "PULUMI_KIT_BOOTSTRAP": str(boot),
           "HOME": str(tmp_path), "GITHUB_TOKEN": "leak"}
    return proj, record, env


def _cli(args, env, **kw):
    return subprocess.run([sys.executable, "-m", "pulumi_kit.cli", *args], env=env,
                          capture_output=True, text=True, **kw)


def test_run_execs_pulumi_with_derived_env(setup):
    proj, record, env = setup
    r = _cli(["run", "--cwd", str(proj), "--", "preview", "--stack", "prod", "--diff"], env)
    assert r.returncode == 0, r.stderr
    got = json.loads(record.read_text())
    assert got["argv"] == ["-C", str(proj), "preview", "--stack", "prod", "--diff"]
    assert got["env"]["PULUMI_CONFIG_PASSPHRASE"] == derive_passphrase(MASTER, "organization/stare-infra/prod")
    assert got["env"]["AWS_ACCESS_KEY_ID"] == "backend-akid"
    assert "GITHUB_TOKEN" not in got["env"]


def test_run_without_stack_refuses(setup):
    proj, record, env = setup
    r = _cli(["run", "--cwd", str(proj), "--", "preview"], env)
    assert r.returncode == 2
    assert "--stack" in r.stderr
    assert not record.exists()


def test_run_without_bootstrap_names_init(setup, tmp_path):
    proj, _, env = setup
    env = {**env, "PULUMI_KIT_BOOTSTRAP": str(tmp_path / "missing.env")}
    r = _cli(["run", "--cwd", str(proj), "--", "preview", "-s", "prod"], env)
    assert r.returncode == 1
    assert "pulumi-kit init" in r.stderr


def test_passphrase(setup):
    _, _, env = setup
    r = _cli(["passphrase", "organization/stare-infra/prod"], env)
    assert r.stdout.strip() == derive_passphrase(MASTER, "organization/stare-infra/prod")


def test_secret_reads_own_resource(setup):
    proj, _, env = setup
    r = _cli(["secret", "--cwd", str(proj), "--stack", "prod", "op", "result"], env)
    assert r.returncode == 0, r.stderr
    assert r.stdout == "s3cret"


def test_secret_unknown_resource(setup):
    proj, _, env = setup
    r = _cli(["secret", "--cwd", str(proj), "--stack", "prod", "nope", "result"], env)
    assert r.returncode == 1
    assert "no resource named nope" in r.stderr


def test_init_from_env(tmp_path):
    target = tmp_path / "cfg" / "bootstrap.env"
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "PULUMI_KIT_BOOTSTRAP": str(target),
           "AWS_ACCESS_KEY_ID": "akid", "AWS_SECRET_ACCESS_KEY": "sk"}
    r = _cli(["init", "--backend-keys-from-env"], env)
    assert r.returncode == 0, r.stderr
    assert "akid" not in r.stdout + r.stderr and "sk\n" not in r.stdout
    assert "Bitwarden" in r.stdout
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --directory /home/lokkju/projects/lokkju/pulumi-kit pytest -q tests/test_stack.py tests/test_env.py tests/test_cli.py`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

`src/pulumi_kit/stack.py`:

```python
"""Which stack a Pulumi invocation targets."""

from pathlib import Path

import yaml


class StackError(Exception):
    pass


def project_name(project_dir: Path) -> str:
    path = project_dir / "Pulumi.yaml"
    if not path.exists():
        raise StackError(f"no Pulumi.yaml in {project_dir}")
    name = (yaml.safe_load(path.read_text()) or {}).get("name")
    if not name:
        raise StackError(f"{path} has no name")
    return str(name)


def stack_from_args(args: list[str]) -> str | None:
    for i, arg in enumerate(args):
        if arg == "--":
            return None
        if arg in ("--stack", "-s") and i + 1 < len(args):
            return args[i + 1]
        if arg.startswith("--stack="):
            return arg.split("=", 1)[1]
    return None


def fqsn(project: str, stack: str) -> str:
    parts = stack.split("/")
    if len(parts) == 1:
        return f"organization/{project}/{stack}"
    if len(parts) == 3:
        if parts[1] != project:
            raise StackError(f"stack {stack} belongs to project {parts[1]}, not {project}")
        return stack
    raise StackError(f"cannot read stack name {stack!r}")
```

`src/pulumi_kit/env.py`:

```python
"""The environment Pulumi runs under: bootstrap backend keys, the derived passphrase, and none of the
project's own credentials, so a provider only ever sees tokens from stack config."""

from collections.abc import Mapping

from pulumi_kit.bootstrap import Bootstrap
from pulumi_kit.derive import derive_passphrase

_STRIP = {
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "GITHUB_TOKEN",
    "PULUMI_CONFIG_PASSPHRASE",
    "PULUMI_CONFIG_PASSPHRASE_FILE",
    "PULUMI_BACKEND_URL",
}
_STRIP_PREFIXES = ("AWS_", "PULUMI_KIT_MASTER", "PULUMI_KIT_BACKEND_")


def pulumi_env(base: Mapping[str, str], boot: Bootstrap, fqsn: str) -> dict[str, str]:
    env = {k: v for k, v in base.items() if k not in _STRIP and not k.startswith(_STRIP_PREFIXES)}
    env["AWS_ACCESS_KEY_ID"] = boot.access_key_id
    env["AWS_SECRET_ACCESS_KEY"] = boot.secret_access_key
    env["PULUMI_CONFIG_PASSPHRASE"] = derive_passphrase(boot.master, fqsn)
    return env


_SECRET_SIG_KEY = "4dabf18193072939515e22adb298388d"


def find_secret(deployment: dict, resource: str, prop: str) -> str:
    """One property of one resource from `pulumi stack export --show-secrets` output."""
    matches = [r for r in deployment.get("resources", []) if r.get("urn", "").endswith(f"::{resource}")]
    if not matches:
        raise KeyError(f"no resource named {resource}")
    if len(matches) > 1:
        raise KeyError(f"{len(matches)} resources named {resource}; this command needs a unique name")
    res = matches[0]
    if prop == "id" and "id" in res:
        return str(res["id"])
    outputs = res.get("outputs", {})
    if prop not in outputs:
        raise KeyError(f"resource {resource} has no output {prop}")
    value = outputs[prop]
    if isinstance(value, dict) and _SECRET_SIG_KEY in value:
        import json

        return str(json.loads(value["plaintext"]))
    return str(value)
```

`src/pulumi_kit/cli.py`:

```python
"""pulumi-kit: run Pulumi with a stack's derived passphrase and the shared backend's keys."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from pulumi_kit.bootstrap import BootstrapError, create_bootstrap, load_bootstrap
from pulumi_kit.derive import derive_passphrase
from pulumi_kit.env import find_secret, pulumi_env
from pulumi_kit.stack import StackError, fqsn, project_name, stack_from_args


def _env_for(cwd: Path, stack: str) -> dict[str, str]:
    return pulumi_env(os.environ, load_bootstrap(), fqsn(project_name(cwd), stack))


def _cmd_run(ns) -> int:
    args = ns.args[1:] if ns.args[:1] == ["--"] else ns.args
    stack = stack_from_args(args)
    if stack is None:
        print("pulumi-kit run: pass --stack (or -s); the passphrase depends on it", file=sys.stderr)
        return 2
    cwd = Path(ns.cwd).resolve()
    env = _env_for(cwd, stack)
    os.execvpe("pulumi", ["pulumi", "-C", str(cwd), *args], env)
    return 0  # not reached


def _cmd_passphrase(ns) -> int:
    print(derive_passphrase(load_bootstrap().master, ns.fqsn))
    return 0


def _cmd_secret(ns) -> int:
    cwd = Path(ns.cwd).resolve()
    env = _env_for(cwd, ns.stack)
    out = subprocess.run(
        ["pulumi", "-C", str(cwd), "stack", "export", "--stack", ns.stack, "--show-secrets"],
        env=env, capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        print(out.stderr, file=sys.stderr, end="")
        return out.returncode
    try:
        value = find_secret(json.loads(out.stdout)["deployment"], ns.resource, ns.property)
    except KeyError as e:
        print(f"pulumi-kit secret: {e.args[0]}", file=sys.stderr)
        return 1
    sys.stdout.write(value)
    return 0


def _cmd_init(ns) -> int:
    if not ns.backend_keys_from_env:
        print("pulumi-kit init: pass --backend-keys-from-env (reads AWS_ACCESS_KEY_ID and "
              "AWS_SECRET_ACCESS_KEY)", file=sys.stderr)
        return 2
    akid, sk = os.environ.get("AWS_ACCESS_KEY_ID"), os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not akid or not sk:
        print("pulumi-kit init: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set", file=sys.stderr)
        return 2
    path = create_bootstrap(akid, sk)
    print(f"wrote {path} (mode 0600) with a new master secret.")
    print("Copy all three values into Bitwarden now, and keep an offline copy of PULUMI_KIT_MASTER.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pulumi-kit")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run", help="exec pulumi with the derived environment")
    p.add_argument("--cwd", default=".")
    p.add_argument("args", nargs=argparse.REMAINDER)
    p.set_defaults(fn=_cmd_run)
    p = sub.add_parser("passphrase", help="print a stack's derived passphrase")
    p.add_argument("fqsn")
    p.set_defaults(fn=_cmd_passphrase)
    p = sub.add_parser("secret", help="print one property of one of the stack's own resources")
    p.add_argument("--cwd", default=".")
    p.add_argument("--stack", required=True)
    p.add_argument("resource")
    p.add_argument("property")
    p.set_defaults(fn=_cmd_secret)
    p = sub.add_parser("init", help="create the bootstrap file with a new master secret")
    p.add_argument("--backend-keys-from-env", action="store_true")
    p.set_defaults(fn=_cmd_init)
    ns = parser.parse_args(argv)
    try:
        return ns.fn(ns)
    except (BootstrapError, StackError, ValueError) as e:
        print(f"pulumi-kit: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
```

Move the `import json` in `find_secret` to the module top when implementing; it is inline above only for brevity.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --directory /home/lokkju/projects/lokkju/pulumi-kit pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git -C /home/lokkju/projects/lokkju/pulumi-kit add src tests
git -C /home/lokkju/projects/lokkju/pulumi-kit commit -m "feat: add pulumi-kit run, passphrase, secret, init"
```

---

### Task 3: `publish_ci_credentials`

**Files:**
- Create: `src/pulumi_kit/publish.py`, `tests/conftest.py`, `tests/test_publish.py`
- Modify: `src/pulumi_kit/__init__.py`

**Interfaces:**
- Produces: `publish_ci_credentials(repo: str, provider: pulumi_github.Provider, stack: str | None = None, env: Mapping[str, str] | None = None) -> list[pulumi_github.ActionsSecret]`; `ci_secret_values(stack: str, env: Mapping[str, str]) -> dict[str, str]`; `CredentialsError(Exception)`. Resource names: `pulumi-kit-ci-<repo name>-<secret name lowercased>`.

- [ ] **Step 1: Write the failing tests**

`tests/conftest.py`:

```python
import pulumi

created: list[tuple[str, str, dict]] = []


class _Mocks(pulumi.runtime.Mocks):
    def new_resource(self, args):
        created.append((args.typ, args.name, dict(args.inputs)))
        return [f"{args.name}_id", dict(args.inputs)]

    def call(self, args):
        return {}


pulumi.runtime.set_mocks(_Mocks(), project="demo", stack="prod", preview=False)
```

`tests/test_publish.py`:

```python
import pulumi
import pulumi_github as github
import pytest

from pulumi_kit.publish import CredentialsError, ci_secret_values, publish_ci_credentials
from tests.conftest import created

ENV = {"AWS_ACCESS_KEY_ID": "akid", "AWS_SECRET_ACCESS_KEY": "sk", "PULUMI_CONFIG_PASSPHRASE": "pp"}


def test_values_named_for_stack():
    assert ci_secret_values("prod", ENV) == {
        "PULUMI_BACKEND_ACCESS_KEY_ID": "akid",
        "PULUMI_BACKEND_SECRET_ACCESS_KEY": "sk",
        "PULUMI_CONFIG_PASSPHRASE_PROD": "pp",
    }


def test_stack_suffix_sanitized():
    assert "PULUMI_CONFIG_PASSPHRASE_DEV_EU_1" in ci_secret_values("dev-eu.1", ENV)


@pytest.mark.parametrize("missing", sorted(ENV))
def test_missing_variable_named(missing):
    env = {k: v for k, v in ENV.items() if k != missing}
    with pytest.raises(CredentialsError, match=f"{missing}.*pulumi-kit run"):
        ci_secret_values("prod", env)


@pytest.mark.parametrize("repo", ["stare", "a/b/c", "/stare", "codexpublicus/"])
def test_bad_repo_refused(repo):
    with pytest.raises(ValueError, match="owner/repo"):
        publish_ci_credentials(repo, provider=None, stack="prod", env=ENV)


@pulumi.runtime.test
def test_creates_three_secret_actions_secrets():
    before = len(created)
    gh = github.Provider("gh", owner="codexpublicus")
    secrets = publish_ci_credentials("codexpublicus/stare", gh, env=ENV)

    def check(_):
        mine = [c for c in created[before:] if c[0] == "github:index/actionsSecret:ActionsSecret"]
        assert sorted(c[2]["secretName"] for c in mine) == sorted(ci_secret_values("prod", ENV))
        assert {c[2]["repository"] for c in mine} == {"stare"}
        assert {c[1] for c in mine} == {
            "pulumi-kit-ci-stare-pulumi_backend_access_key_id",
            "pulumi-kit-ci-stare-pulumi_backend_secret_access_key",
            "pulumi-kit-ci-stare-pulumi_config_passphrase_prod",
        }

    return pulumi.Output.all(*[s.id for s in secrets]).apply(check)
```

(If the installed pulumi-github names the input `value` rather than `plaintextValue` in the mock's inputs, keep the assertions on `secretName` and `repository` only, as written; do not assert on the value.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --directory /home/lokkju/projects/lokkju/pulumi-kit pytest -q tests/test_publish.py`
Expected: FAIL, `No module named 'pulumi_kit.publish'`.

- [ ] **Step 3: Implement**

`src/pulumi_kit/publish.py`:

```python
"""A stack pushes the credentials its own repo's CI needs to run it: the state backend's keys
and this stack's own derived passphrase. Values come from the environment `pulumi-kit run`
(or CI) set up, so the master secret never leaves the operator's machine."""

import os
import re
from collections.abc import Mapping

import pulumi
import pulumi_github as github

_SOURCES = {
    "PULUMI_BACKEND_ACCESS_KEY_ID": "AWS_ACCESS_KEY_ID",
    "PULUMI_BACKEND_SECRET_ACCESS_KEY": "AWS_SECRET_ACCESS_KEY",
}


class CredentialsError(Exception):
    pass


def _need(env: Mapping[str, str], key: str) -> str:
    value = env.get(key)
    if not value:
        raise CredentialsError(
            f"publish_ci_credentials needs {key} in the environment; run Pulumi through `pulumi-kit run`"
        )
    return value


def ci_secret_values(stack: str, env: Mapping[str, str]) -> dict[str, str]:
    suffix = re.sub(r"[^A-Z0-9]", "_", stack.upper())
    values = {name: _need(env, source) for name, source in _SOURCES.items()}
    values[f"PULUMI_CONFIG_PASSPHRASE_{suffix}"] = _need(env, "PULUMI_CONFIG_PASSPHRASE")
    return values


def publish_ci_credentials(
    repo: str,
    provider: github.Provider,
    stack: str | None = None,
    env: Mapping[str, str] | None = None,
) -> list[github.ActionsSecret]:
    parts = repo.split("/")
    if len(parts) != 2 or not all(parts):
        raise ValueError(f"repo must be owner/repo, got {repo!r}")
    name = parts[1]
    values = ci_secret_values(stack or pulumi.get_stack(), os.environ if env is None else env)
    opts = pulumi.ResourceOptions(provider=provider)
    return [
        github.ActionsSecret(
            f"pulumi-kit-ci-{name}-{secret_name.lower()}",
            repository=name,
            secret_name=secret_name,
            value=pulumi.Output.secret(value),
            opts=opts,
        )
        for secret_name, value in values.items()
    ]
```

`src/pulumi_kit/__init__.py`:

```python
from pulumi_kit.derive import derive_passphrase
from pulumi_kit.publish import publish_ci_credentials

__all__ = ["derive_passphrase", "publish_ci_credentials"]
```

Use `value=` if the installed `pulumi_github.ActionsSecret` accepts it (6.x marks `plaintext_value` deprecated in favor of `value`); the consumers already use `value=`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --directory /home/lokkju/projects/lokkju/pulumi-kit pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git -C /home/lokkju/projects/lokkju/pulumi-kit add src tests
git -C /home/lokkju/projects/lokkju/pulumi-kit commit -m "feat: add publish_ci_credentials"
```

---

### Task 4: templates and README

**Files:**
- Create: `templates/mise-pulumi-task`, `templates/pulumi.yml`, `tests/test_templates.py`
- Modify: `README.md`

**Interfaces:**
- Produces: the two templates, with placeholders `__PULUMI_DIR__` (project dir relative to the repo root, e.g. `infra`) and `__STACK__` (e.g. `prod`), which Tasks 6 and 7 substitute.

- [ ] **Step 1: Write the failing test**

`tests/test_templates.py`:

```python
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).parent.parent


def test_mise_task_header_and_exec():
    text = (ROOT / "templates/mise-pulumi-task").read_text()
    assert text.startswith("#!/usr/bin/env bash\n#MISE description=")
    assert '#USAGE arg "[args]..." var=#true' in text
    assert 'exec uv run --directory "$DIR" pulumi-kit run --cwd "$DIR" -- "$@"' in text


def test_workflow_shape():
    text = (ROOT / "templates/pulumi.yml").read_text()
    wf = yaml.safe_load(text)
    on = wf[True] if True in wf else wf["on"]
    assert set(on) == {"pull_request", "push", "release"}
    assert on["push"]["branches"] == ["main"]
    assert on["release"]["types"] == ["published"]
    assert wf["permissions"] == {"contents": "read"}
    for line in re.findall(r"uses: (\S+)", text):
        assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", line), line
    assert "${{ secrets.PULUMI_CONFIG_PASSPHRASE___STACK_UPPER__ }}" in text
    assert "::notice::" in text
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run --directory /home/lokkju/projects/lokkju/pulumi-kit pytest -q tests/test_templates.py`
Expected: FAIL, missing files.

- [ ] **Step 3: Write the templates**

`templates/mise-pulumi-task` (consumers copy to `.mise/tasks/pulumi` and `chmod +x`):

```bash
#!/usr/bin/env bash
#MISE description="Run Pulumi on __PULUMI_DIR__/ through pulumi-kit (derived passphrase, shared backend keys)"
#USAGE arg "[args]..." var=#true help="Arguments passed through to pulumi; --stack is required"
set -euo pipefail

# pulumi-kit comes from this project's own lockfile, so the version is the pinned tag.
# It loads ~/.config/pulumi-kit/bootstrap.env, derives this stack's passphrase and
# strips this repo's own AWS_*, CLOUDFLARE_* and GITHUB_TOKEN before exec'ing pulumi.
ROOT="${MISE_PROJECT_ROOT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}"
DIR="$ROOT/__PULUMI_DIR__"
exec uv run --directory "$DIR" pulumi-kit run --cwd "$DIR" -- "$@"
```

`templates/pulumi.yml` (consumers copy to `.github/workflows/pulumi.yml`; substitute `__PULUMI_DIR__`, `__STACK__`, `__STACK_UPPER__`). Resolve each action's SHA at write time with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` for the latest release tag of `actions/checkout`, `astral-sh/setup-uv` and `pulumi/actions`, and record the tag in the trailing comment:

```yaml
name: pulumi

on:
  pull_request:
    paths: ["__PULUMI_DIR__/**", ".github/workflows/pulumi.yml"]
  push:
    branches: [main]
    paths: ["__PULUMI_DIR__/**", ".github/workflows/pulumi.yml"]
  release:
    types: [published]

permissions:
  contents: read

concurrency:
  group: pulumi-__STACK__
  cancel-in-progress: false

jobs:
  pulumi:
    runs-on: ubuntu-latest
    env:
      AWS_ACCESS_KEY_ID: ${{ secrets.PULUMI_BACKEND_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.PULUMI_BACKEND_SECRET_ACCESS_KEY }}
      PULUMI_CONFIG_PASSPHRASE: ${{ secrets.PULUMI_CONFIG_PASSPHRASE___STACK_UPPER__ }}
    steps:
      - id: creds
        name: Check CI credentials
        run: |
          if [ -z "$PULUMI_CONFIG_PASSPHRASE" ] || [ -z "$AWS_ACCESS_KEY_ID" ]; then
            echo "::notice::No Pulumi CI credentials (fork PR, or the stack has not published them yet); skipping."
            echo "ok=false" >> "$GITHUB_OUTPUT"
          else
            echo "ok=true" >> "$GITHUB_OUTPUT"
          fi
      - if: steps.creds.outputs.ok == 'true'
        uses: actions/checkout@<sha> # <tag>
      - if: steps.creds.outputs.ok == 'true'
        uses: astral-sh/setup-uv@<sha> # <tag>
      - if: steps.creds.outputs.ok == 'true'
        uses: pulumi/actions@<sha> # <tag>; no command: installs the CLI only
      - if: steps.creds.outputs.ok == 'true' && github.event_name == 'pull_request'
        run: pulumi -C __PULUMI_DIR__ preview --stack __STACK__ --diff --non-interactive
      - if: steps.creds.outputs.ok == 'true' && github.event_name != 'pull_request'
        run: pulumi -C __PULUMI_DIR__ up --stack __STACK__ --yes --non-interactive
```

CI calls `pulumi` directly: the job env already holds the backend keys and this stack's passphrase, and the backend URL comes from `Pulumi.yaml`. Confirm from `pulumi/actions`'s README at the pinned tag that omitting `command` only installs the CLI; if it does not, install with `curl -fsSL https://get.pulumi.com | sh -s -- --version <pinned>` plus `echo "$HOME/.pulumi/bin" >> "$GITHUB_PATH"` instead, and adjust the test's `uses:` expectations.

- [ ] **Step 4: README**

Replace `README.md` with: what the package is (two sentences); the bootstrap file and `pulumi-kit init --backend-keys-from-env`; the four commands with one example each; `publish_ci_credentials` usage in a program; how to adopt the two templates (copy, substitute placeholders, `chmod +x`); spec rule 6 in one paragraph (no secret outputs on referenced stacks; use `pulumi-kit secret` for your own); the derivation formula; rotation (`pulumi-kit passphrase <fqsn> | PULUMI_CONFIG_PASSPHRASE=<old> pulumi -C <dir> stack change-secrets-provider passphrase --stack <stack>`). No em-dashes.

- [ ] **Step 5: Run all tests**

Run: `uv run --directory /home/lokkju/projects/lokkju/pulumi-kit pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git -C /home/lokkju/projects/lokkju/pulumi-kit add templates tests README.md
git -C /home/lokkju/projects/lokkju/pulumi-kit commit -m "docs: add mise task and workflow templates"
```

### Controller, after Task 4 review

- [ ] Push `lokkju/v0.1.0`, open a PR, and hand the merge to the operator if the permission system refuses it. After merge, tag `v0.1.0` on the merge commit and push the tag.
- [ ] Back up both stacks (read-only; encrypted values stay encrypted):
  `mise -C /home/lokkju/projects/lokkju/codexpublicus-infra exec -- pulumi -C /home/lokkju/projects/lokkju/codexpublicus-infra/pulumi stack export --stack prod --file /home/lokkju/backups/pulumi/codexpublicus-infra-prod-2026-09-28.json`, and the same for `stare-infra` with `-C /home/lokkju/projects/lokkju/codex-publicus/infra`.
- [ ] Operator: `! mise -C /home/lokkju/projects/lokkju/codexpublicus-infra exec -- uvx --from git+https://github.com/lokkju/pulumi-kit@v0.1.0 pulumi-kit init --backend-keys-from-env`, then copy the file's three values into Bitwarden and the master offline.

---

### Task 5: codexpublicus-infra program

Worktree: `git -C /home/lokkju/projects/lokkju/codexpublicus-infra fetch origin` then `git -C /home/lokkju/projects/lokkju/codexpublicus-infra worktree add /home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit -b lokkju/pulumi-kit origin/main`. Paths below are relative to that worktree.

**Files:**
- Create: `pulumi/codexpublicus_infra/providers.py`, `pulumi/tests/test_providers.py`, `pulumi/tests/test_outputs.py`
- Modify: `pulumi/Pulumi.yaml`, `pulumi/Pulumi.prod.yaml`, `pulumi/pyproject.toml`, `pulumi/uv.lock`, `pulumi/__main__.py`, `pulumi/codexpublicus_infra/settings.py`, `pulumi/codexpublicus_infra/site.py`, `pulumi/codexpublicus_infra/lfs.py`, `pulumi/codexpublicus_infra/stare_pub.py`, `pulumi/tests/conftest.py`, `pulumi/tests/test_settings.py`, and any test asserting on the removed exports
- Delete: `pulumi/codexpublicus_infra/shared.py`, `pulumi/tests/test_shared.py`

**Interfaces:**
- Consumes: `pulumi_kit.publish_ci_credentials(repo, provider)`.
- Produces: `github_provider(owner: str) -> github.Provider` (one instance per owner, logical name `github-<owner>`, `token` from `pulumi.Config("github").require_secret("token")`); `Settings.account_id: str` replacing `Settings.shared_stack`; stack outputs, all plain: `account_id`, `zone_id_<zone>`, `lfs_proxy_url`, `lfs_bucket`, `worker_name_codexpublicus-org`, plus stare_pub's non-secret exports.

- [ ] **Step 1: Write the failing tests**

`pulumi/tests/test_providers.py`:

```python
import pulumi

from codexpublicus_infra.providers import github_provider
from tests.conftest import created


@pulumi.runtime.test
def test_one_provider_per_owner_with_config_token():
    before = len(created)
    a = github_provider("codexpublicus")
    b = github_provider("codexpublicus")
    assert a is b

    def check(_):
        mine = [c for c in created[before:] if c[0] == "pulumi:providers:github"]
        assert [c[1] for c in mine] == ["github-codexpublicus"]
        assert mine[0][2]["owner"] == "codexpublicus"
        assert "token" in mine[0][2]

    return a.id.apply(check)
```

`pulumi/tests/test_outputs.py` runs the whole program under mocks with a recording `pulumi.export` and asserts no output is secret (spec rule 6):

```python
import asyncio
import runpy
from pathlib import Path

import pulumi

PROGRAM = Path(__file__).parent.parent / "__main__.py"


def test_no_stack_output_is_secret(monkeypatch):
    recorded: dict[str, object] = {}
    monkeypatch.setattr(pulumi, "export", lambda name, value: recorded.__setitem__(name, value))
    runpy.run_path(str(PROGRAM), run_name="__main__")

    async def secret_names():
        names = []
        for name, value in recorded.items():
            out = pulumi.Output.from_input(value)
            if await out._is_secret:  # private, but the only way to ask an Output this
                names.append(name)
        return names

    loop = asyncio.get_event_loop()
    assert loop.run_until_complete(secret_names()) == []
    assert {"account_id", "lfs_proxy_url", "lfs_bucket"} <= set(recorded)
```

For this to run, `conftest.py` must set the program's config: add `"codexpublicus-infra:account_id": "acct-123"`, the `zones`, `redirects`, `data_hosts`, `lfs_host`, `lfs_bucket`, `site` values from `Pulumi.prod.yaml` (as JSON strings for objects), and `"github:token": "gh-token"` (in `secret_keys` with `email_destination`), plus `PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` set with `monkeypatch.setenv` in this test (or `os.environ.setdefault` in conftest) so `publish_ci_credentials` can read them. Drop the `StackReference` branch from the mocks. If the existing tests' `settle()` helper is the established way to wait on resources, use it instead of `run_until_complete`; match `tests/conftest.py`.

In `test_settings.py`, replace every `shared_stack` case with `account_id`, and add: a missing `account_id` raises `KeyError`/`pulumi.ConfigMissingError` as `load_settings` surfaces it today for other required keys.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --directory pulumi pytest -q` (absolute: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit/pulumi pytest -q`)
Expected: FAIL (no `providers` module; secret outputs recorded).

- [ ] **Step 3: Implement**

`pulumi/Pulumi.yaml`: add

```yaml
backend:
  url: s3://lokkju-pulumi-state?endpoint=https://441c9b9997aeedf42f0c48d5bdb996cb.r2.cloudflarestorage.com&region=auto
```

`pulumi/Pulumi.prod.yaml`: replace `codexpublicus-infra:shared_stack: organization/lokkju-infra/prod` with `codexpublicus-infra:account_id: 441c9b9997aeedf42f0c48d5bdb996cb`. Touch nothing else in the file (the operator's `config set` and rotation edit it later).

`pulumi/pyproject.toml`: add `"pulumi-kit @ git+https://github.com/lokkju/pulumi-kit@v0.1.0"` to `dependencies`; run `uv lock --directory pulumi`.

`pulumi/codexpublicus_infra/providers.py`:

```python
"""Explicit providers, one per GitHub owner. An explicit provider reads env vars, not the
`github:` config namespace, so the token is passed from stack config here."""

import functools

import pulumi
import pulumi_github as github


@functools.cache
def github_provider(owner: str) -> github.Provider:
    token = pulumi.Config("github").require_secret("token")
    return github.Provider(f"github-{owner}", owner=owner, token=token)
```

`settings.py`: `shared_stack: str` becomes `account_id: str`; `parse_settings` reads `raw["account_id"]`; `load_settings`'s `required_keys` becomes `["account_id", "lfs_host", "lfs_bucket"]`.

`__main__.py`:

```python
"""codexpublicus-infra: resources shared by every Codex Publicus site."""

import pulumi
from pulumi_kit import publish_ci_credentials

from codexpublicus_infra.edge_rules import declare_edge_rules
from codexpublicus_infra.email_routing import declare_codexpublicus_email
from codexpublicus_infra.lfs import declare_lfs
from codexpublicus_infra.providers import github_provider
from codexpublicus_infra.redirects import declare_redirects
from codexpublicus_infra.settings import load_settings
from codexpublicus_infra.site import declare_site
from codexpublicus_infra.stare_pub import declare_stare_pub
from codexpublicus_infra.zones import declare_zones

settings = load_settings(pulumi.Config())
account_id = pulumi.Output.from_input(settings.account_id)

pulumi.export("account_id", account_id)

zones = declare_zones(settings.zones, account_id)
stare_pub = declare_stare_pub(zones["stare.pub"], account_id)
codexpublicus_email = declare_codexpublicus_email(zones)
declare_redirects(settings.redirects, zones)
declare_edge_rules(settings.data_hosts, zones)
lfs = declare_lfs(settings, account_id)
declare_site(settings.site, zones, account_id)
publish_ci_credentials("codexpublicus/infra", github_provider("codexpublicus"))
```

`site.py`: replace `gh = github.Provider(f"github-{owner}", owner=owner)` with `gh = github_provider(owner)`. The logical name stays `github-codexpublicus`, so Pulumi updates the provider in place instead of replacing it.

`lfs.py`: delete the three `pulumi.export` lines for `lfs_r2_access_key_id`, `lfs_r2_secret_access_key` and `lfs_operator_token`; keep `LfsOutputs` and its return value. Add to the module docstring: "The R2 keys and operator token are not stack outputs (a secret output breaks every StackReference to this stack under per-stack passphrases); the `lfs-*` tasks read them with `pulumi-kit secret`: `lfs-worker-r2 id`, `lfs-worker-r2 value` (the S3 secret is its SHA-256) and `lfs-operator-token result`."

`stare_pub.py`: remove `pages_deploy_token_<project>` and `r2_token_secret_<bucket>` from the `exports` dict (lines ~143-151); keep the plain ones. The resources themselves stay.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit/pulumi pytest -q`
Expected: all pass, including `test_provider_version.py` (the 6.13.0 pin).

- [ ] **Step 5: Commit**

```bash
git -C /home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit add pulumi
git -C /home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit commit -m "feat(pulumi): adopt pulumi-kit, plain outputs only"
```

---

### Task 6: codexpublicus-infra tooling, CI and docs

Same worktree as Task 5.

**Files:**
- Create: `.mise/tasks/pulumi`, `.github/workflows/pulumi.yml`
- Modify: `.mise/tasks/lfs-deploy`, `.mise/tasks/lfs-verify`, `.mise/tasks/lfs-allowlist-put`, `AGENTS.md`

**Interfaces:**
- Consumes: Task 4's templates (`__PULUMI_DIR__` = `pulumi`, `__STACK__` = `prod`, `__STACK_UPPER__` = `PROD`); pulumi-kit CLI `run`, `secret`.

- [ ] **Step 1: `.mise/tasks/pulumi`** from `/home/lokkju/projects/lokkju/pulumi-kit/templates/mise-pulumi-task`, `__PULUMI_DIR__` → `pulumi`; `chmod +x`.

- [ ] **Step 2: the `lfs-*` tasks.** Add near the top of each, after `ROOT=`:

```bash
PK=(uv run --directory "$ROOT/pulumi" pulumi-kit)
pulumi_() { "${PK[@]}" run --cwd "$ROOT/pulumi" -- "$@"; }
```

- `lfs-deploy`: replace the `STACK=(...)` block's four reads with
  - `ACCOUNT_ID="$(pulumi_ stack output account_id --stack prod)"`
  - `R2_ACCESS_KEY_ID="$("${PK[@]}" secret --cwd "$ROOT/pulumi" --stack prod lfs-worker-r2 id)"`
  - `R2_TOKEN_VALUE="$("${PK[@]}" secret --cwd "$ROOT/pulumi" --stack prod lfs-worker-r2 value)"` then `R2_SECRET_ACCESS_KEY="$(printf '%s' "$R2_TOKEN_VALUE" | sha256sum | cut -d' ' -f1)"` and `unset R2_TOKEN_VALUE`
  - `OPERATOR_TOKEN="$("${PK[@]}" secret --cwd "$ROOT/pulumi" --stack prod lfs-operator-token result)"`
  - `export CLOUDFLARE_API_TOKEN="$(pulumi_ config get cloudflare:apiToken --stack prod)"` before any Wrangler call.
  Keep every existing emptiness and length check, renaming "pulumi output" to "pulumi-kit value" in the messages.
- `lfs-verify`: `URL` via `pulumi_ stack output lfs_proxy_url --stack prod`; `OP` via `"${PK[@]}" secret ... lfs-operator-token result`.
- `lfs-allowlist-put`: `ACCOUNT_ID` via `pulumi_ stack output account_id --stack prod`; add the same `CLOUDFLARE_API_TOKEN` export before `wrangler`.

Keep the comment that plain assignments let `set -e` trip. Check each script with `bash -n` and, if installed, `shellcheck`.

- [ ] **Step 3: `.github/workflows/pulumi.yml`** from the template, placeholders substituted, the three actions pinned by SHA (resolve fresh; copy the SHAs Task 4 used if they are still the latest tags).

- [ ] **Step 4: `AGENTS.md`.** Rewrite the Pulumi usage and outputs sections: run Pulumi as `mise run pulumi -- <args> --stack prod`; the bootstrap file and `pulumi-kit init`; provider tokens are stack config (`cloudflare:apiToken`, `github:token`); the output list without the five removed secrets and with a paragraph stating rule 6 and `pulumi-kit secret` for the LFS values; CI previews on PRs and applies on `main` or a release once the stack has published its credentials; the StackReference to lokkju-infra is gone (`account_id` is config). Keep the existing Rules section; the "operator runs every state-changing command" rule now reads "…locally; CI applies on `main`".

- [ ] **Step 5: Verify**

Run: `bash -n` on the four task files; `uv run --directory /home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit/pulumi pytest -q`; `uv run --no-project --with pyyaml python -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/pulumi.yml` (absolute path).
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git -C /home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit add .mise/tasks .github AGENTS.md
git -C /home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit commit -m "build: run pulumi through pulumi-kit, add CI"
```

### Operator runbook: codexpublicus-infra (controller hands over one command at a time)

W = `/home/lokkju/projects/lokkju/codexpublicus-infra-wt/pulumi-kit`, M = `/home/lokkju/projects/lokkju/codexpublicus-infra` (still holds the old env).

1. Rotate to the derived passphrase (old passphrase from M's env, new one on stdin):
   `! uv run --directory W/pulumi pulumi-kit passphrase organization/codexpublicus-infra/prod | mise -C M exec -- pulumi -C W/pulumi stack change-secrets-provider passphrase --stack prod`
   Expected: "Migrating old configuration and state to new secrets provider"; `W/pulumi/Pulumi.prod.yaml` gets a new `encryptionsalt` and re-encrypted `email_destination`. Controller commits it (`chore(pulumi): rotate prod to derived passphrase`).
2. Provider tokens into config, under the new passphrase:
   `! mise -C M exec -- sh -c 'printf %s "$CLOUDFLARE_API_TOKEN" | uv run --directory W/pulumi pulumi-kit run --cwd W/pulumi -- config set --secret cloudflare:apiToken --stack prod'`
   `! mise -C M exec -- sh -c 'printf %s "$GITHUB_TOKEN" | uv run --directory W/pulumi pulumi-kit run --cwd W/pulumi -- config set --secret github:token --stack prod'`
   Controller commits (`chore(pulumi): provider tokens in stack config`).
3. Controller previews: `uv run --directory W/pulumi pulumi-kit run --cwd W/pulumi -- preview --stack prod --diff`. Expected, and stated exactly before step 4: 3 creates (`pulumi-kit-ci-infra-*`), updates limited to the `github-codexpublicus` provider and the default Cloudflare provider (new token input), the lokkju-infra StackReference read dropped, 5 outputs removed; no replace and no delete of a real resource. Anything else stops the runbook.
4. Controller pushes and opens the PR; operator merges. CI's first run skips with the notice.
5. `! git -C M pull --ff-only` then `! mise run --cd M pulumi -- up --stack prod --yes`. Expected: the step 3 counts.
6. Controller verifies: `gh secret list -R codexpublicus/infra` shows the three names; `mise run --cd M lfs-verify` passes (read-only round trip on a fixed object).

---

### Task 7: stare-infra program, tooling, CI and docs

Worktree: `git -C /home/lokkju/projects/lokkju/codex-publicus fetch origin` then `git -C /home/lokkju/projects/lokkju/codex-publicus worktree add /home/lokkju/projects/lokkju/codex-publicus/.claude/worktrees/pulumi-kit-adopt -b lokkju/pulumi-kit-adopt origin/main`.

**Files:**
- Create: `infra/stare_infra/providers.py`, `infra/tests/test_providers.py`, `infra/tests/test_outputs.py`, `.github/workflows/pulumi.yml`
- Modify: `infra/Pulumi.yaml`, `infra/pyproject.toml`, `infra/uv.lock`, `infra/__main__.py`, `infra/stare_infra/deploy.py`, `infra/tests/conftest.py`, `.mise/tasks/pulumi`, `AGENTS.md`

**Interfaces:**
- Consumes: `pulumi_kit.publish_ci_credentials`; the Task 4 templates (`__PULUMI_DIR__` = `infra`, `__STACK__` = `prod`, `__STACK_UPPER__` = `PROD`).
- Produces: `github_provider(owner)` with the same contract as Task 5's; outputs `worker_name`, `r2_bucket_codex-data`, all plain.

- [ ] **Step 1: Failing tests.** `test_providers.py` as in Task 5 with `stare_infra.providers`. `test_outputs.py` as in Task 5 with this repo's `__main__.py`, asserting `{"worker_name", "r2_bucket_codex-data"} <= set(recorded)` and no secret output. Add `"github:token"` (secret) and the program's config to `conftest.py` if it does not already set them; keep the `StackReference` mock (this stack still reads codexpublicus-infra).

- [ ] **Step 2: Run to verify failure:** `uv run --directory /home/lokkju/projects/lokkju/codex-publicus/.claude/worktrees/pulumi-kit-adopt/infra pytest -q`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `infra/Pulumi.yaml`: the same `backend.url` block as Task 5.
  - `infra/pyproject.toml`: add the pulumi-kit dependency; `uv lock`.
  - `infra/stare_infra/providers.py`: identical to Task 5's `providers.py`.
  - `deploy.py`: `gh = github_provider(owner)` in place of `github.Provider(f"github-{owner}", owner=owner)`.
  - `__main__.py`: after `declare_data(...)`, `publish_ci_credentials(settings.github_repo, github_provider(settings.github_repo.split("/")[0]))`.
  - `.mise/tasks/pulumi`: replace with the template (`__PULUMI_DIR__` → `infra`). The borrowed-env logic and `CODEXPUBLICUS_INFRA_DIR` go away; `pulumi-kit run` strips stare's own `AWS_*`, `AWS_ENDPOINT_URL_S3` and `CLOUDFLARE_API_TOKEN`.
  - `.github/workflows/pulumi.yml`: from the template.
  - `AGENTS.md`: rewrite the "Pulumi (`infra/`, …)" subsection the same way as Task 6 Step 4 (no borrowed env; bootstrap file; tokens in stack config; CI behavior; `infra/` tests command unchanged).

- [ ] **Step 4: Verify:** tests pass (`test_pins.py` included); `bash -n .mise/tasks/pulumi`; workflow YAML parses.

- [ ] **Step 5: Commit** (two commits: `feat(infra): adopt pulumi-kit` for `infra/`; `build: run pulumi through pulumi-kit, add CI` for `.mise`, `.github`, `AGENTS.md`).

### Operator runbook: stare-infra (after codexpublicus-infra's step 5)

W = the Task 7 worktree, M = `/home/lokkju/projects/lokkju/codexpublicus-infra` (old env, still present until Task 8). S = `/home/lokkju/projects/lokkju/codex-publicus`.

1. `! uv run --directory W/infra pulumi-kit passphrase organization/stare-infra/prod | mise -C M exec -- pulumi -C W/infra stack change-secrets-provider passphrase --stack prod`; controller commits.
2. `! mise -C M exec -- sh -c 'printf %s "$CLOUDFLARE_API_TOKEN" | uv run --directory W/infra pulumi-kit run --cwd W/infra -- config set --secret cloudflare:apiToken --stack prod'` and the same for `GITHUB_TOKEN` → `github:token`; controller commits.
3. Controller previews. Expected: 3 creates (`pulumi-kit-ci-stare-*`) plus the 2 left from stare#3 Task 5 (`citare-deploy-key`, `gh-secret-cf-token-stare-pub`), provider updates only, no replace or delete. If the org still has `deploy_keys_enabled_for_repositories: false`, the operator runs `! gh api -X PATCH orgs/codexpublicus -F deploy_keys_enabled_for_repositories=true` first, or the deploy key is expected to fail again.
4. PR, merge, `! git -C S pull --ff-only`, `! mise run --cd S pulumi -- up --stack prod --yes`.
5. Controller verifies `gh secret list -R codexpublicus/stare`.

---

### Task 8: remove the old credentials

Only after both runbooks finish. New branches from fresh `origin/main` in both repos.

**Files:**
- Modify: `codexpublicus-infra/.mise/config.toml` (delete `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`, `PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`; delete `[settings.age]` if no `age =` value remains), `codexpublicus-infra/AGENTS.md` (drop any mention of those env vars)
- Modify: `stare/AGENTS.md` only if it still mentions `PULUMI_STATE_AWS_*` or the borrowed env

- [ ] **Step 1:** Make the edits. `grep -rn "PULUMI_CONFIG_PASSPHRASE\|PULUMI_STATE_AWS\|CODEXPUBLICUS_INFRA_DIR" <repo>` returns only the workflow and pulumi-kit references.
- [ ] **Step 2:** From the branch worktree, `mise run pulumi -- preview --stack prod` (codexpublicus-infra) still reports no changes, and `mise run lfs-verify` passes. Wrangler-only tasks get their token from stack config, so nothing else read the removed env.
- [ ] **Step 3:** Commit (`chore: drop mise-held Pulumi credentials`), push, PR.

### Controller wrap-up

- [ ] R2 bucket versioning: check Cloudflare's R2 S3-compatibility docs for `PutBucketVersioning`. If R2 does not support it, file an issue on lokkju/infra#19's side ("scheduled backup of lokkju-pulumi-state to TrueNAS") and amend the spec's gap section; do not change the bucket.
- [ ] Amend the spec: CI calls `pulumi` directly (no pass-through mode in `pulumi-kit run`); pulumi-kit is public; the LFS S3 secret is computed from the token value by the task.
- [ ] Comment on codexpublicus/infra#31 and close it; tick stare#3's secrets item; update `HANDOFF-secrets-redesign.md` and resume stare#3 at Task 6 with the new CI pattern.
