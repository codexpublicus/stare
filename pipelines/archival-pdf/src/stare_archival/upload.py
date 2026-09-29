"""Uploading finished volumes: copy a file to the object store, then check the remote copy.

`RcloneUploader` runs rclone against a remote such as `r2:codex-data`, configured the usual
rclone way (for the pipeline image, `RCLONE_CONFIG_R2_*` variables from an env file). Each
file goes up as a single PUT (`--s3-upload-cutoff` well above any volume PDF), so R2's ETag
is an MD5 the store computed itself; after the copy, `rclone lsjson --hash` reads the
remote size and MD5 back, and a mismatch with the local file is an `UploadError`.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from stare_archival.errors import UploadError

# R2 takes a single PUT up to 5 GiB; the largest volume PDF is far below this
SINGLE_PUT_CUTOFF = "4G"


def md5_file(path: str | os.PathLike[str]) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class RemoteObject:
    """An uploaded object as the remote reports it."""

    key: str
    size: int
    md5: str


class Uploader(Protocol):
    def upload(self, local: Path, key: str) -> RemoteObject:
        """Copy `local` to `key` and return the remote object once its size and MD5 match
        the local file; UploadError otherwise."""
        ...


class RcloneUploader:
    """Uploads with rclone to `remote` (an rclone remote and bucket, e.g. `r2:codex-data`,
    or a local directory). `env` replaces the subprocess environment when given."""

    def __init__(
        self,
        remote: str,
        *,
        rclone: str = "rclone",
        env: Mapping[str, str] | None = None,
        timeout: float = 1800.0,
    ) -> None:
        self.remote = remote
        self.rclone = rclone
        self.env = dict(env) if env is not None else None
        self.timeout = timeout

    def remote_path(self, key: str) -> str:
        return f"{self.remote.rstrip('/')}/{key.lstrip('/')}"

    def copy_command(self, local: Path, key: str) -> list[str]:
        return [
            self.rclone,
            "copyto",
            "--s3-upload-cutoff",
            SINGLE_PUT_CUTOFF,
            "--s3-no-check-bucket",
            "--retries",
            "3",
            str(local),
            self.remote_path(key),
        ]

    def stat_command(self, key: str) -> list[str]:
        return [
            self.rclone,
            "lsjson",
            "--hash",
            "--hash-type",
            "md5",
            "--files-only",
            self.remote_path(key),
        ]

    def _run(self, argv: list[str]) -> subprocess.CompletedProcess[bytes]:
        try:
            proc = subprocess.run(  # noqa: S603 (argv from fixed flags and our own paths)
                argv, capture_output=True, check=False, env=self.env, timeout=self.timeout
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise UploadError(f"could not run {argv[0]}: {exc}") from exc
        if proc.returncode != 0:
            err = proc.stderr.decode(errors="replace").strip().splitlines()
            raise UploadError(
                f"rclone {argv[1]} exited {proc.returncode}: {err[-1] if err else ''}"
            )
        return proc

    def upload(self, local: Path, key: str) -> RemoteObject:
        size = local.stat().st_size
        md5 = md5_file(local)
        self._run(self.copy_command(local, key))
        listing = self._run(self.stat_command(key)).stdout
        try:
            (entry,) = json.loads(listing)
            remote = RemoteObject(key, int(entry["Size"]), str(entry["Hashes"]["md5"]).lower())
        except (ValueError, KeyError, TypeError) as exc:
            raise UploadError(f"{key}: can't read rclone's listing of the upload ({exc})") from exc
        if remote.size != size:
            raise UploadError(f"{key}: the remote has {remote.size} bytes, the local {size}")
        if remote.md5 != md5:
            raise UploadError(f"{key}: the remote md5 is {remote.md5 or 'missing'}, local {md5}")
        return remote
