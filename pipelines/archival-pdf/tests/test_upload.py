import hashlib
import os
import shutil
import stat
from pathlib import Path

import pytest

from stare_archival.errors import UploadError
from stare_archival.upload import RcloneUploader, RemoteObject, md5_file


def _md5(data: bytes) -> str:
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


def test_md5_file(tmp_path):
    f = tmp_path / "a.bin"
    f.write_bytes(b"hello\n")
    assert md5_file(f) == _md5(b"hello\n")


def test_commands_use_one_put_and_read_the_remote_hash():
    up = RcloneUploader("r2:codex-data", rclone="/usr/bin/rclone")
    copy = up.copy_command(Path("/out/cap-pdf/a2d/152.pdf"), "cap-pdf/a2d/152.pdf")
    assert copy[:2] == ["/usr/bin/rclone", "copyto"]
    assert copy[-2:] == ["/out/cap-pdf/a2d/152.pdf", "r2:codex-data/cap-pdf/a2d/152.pdf"]
    # a single PUT, so R2's ETag is the MD5 the object store computed itself
    assert "--s3-upload-cutoff" in copy
    assert "--s3-no-check-bucket" in copy
    stat_cmd = up.stat_command("cap-pdf/a2d/152.pdf")
    assert stat_cmd[:2] == ["/usr/bin/rclone", "lsjson"]
    assert "--hash" in stat_cmd
    assert stat_cmd[-1] == "r2:codex-data/cap-pdf/a2d/152.pdf"


def test_remote_is_joined_without_doubled_slashes():
    assert RcloneUploader("r2:codex-data/").remote_path("cap-pdf/x.pdf") == (
        "r2:codex-data/cap-pdf/x.pdf"
    )
    assert (
        RcloneUploader("/srv/remote").remote_path("/cap-pdf/x.pdf") == "/srv/remote/cap-pdf/x.pdf"
    )


def _fake_rclone(tmp_path: Path, *, corrupt: bool = False, fail_copy: bool = False) -> Path:
    """A stand-in rclone: copyto copies (optionally corrupting), lsjson reports size and md5."""
    script = tmp_path / "rclone"
    corrupt_line = 'printf x >> "$dst"' if corrupt else ":"
    copy_exit = "exit 5" if fail_copy else ":"
    script.write_text(
        f"""#!/bin/sh
cmd="$1"; shift
last=""; prev=""
for a in "$@"; do prev="$last"; last="$a"; done
case "$cmd" in
  copyto)
    {copy_exit}
    dst="$last"; mkdir -p "$(dirname "$dst")"; cp "$prev" "$dst"; {corrupt_line} ;;
  lsjson)
    f="$last"
    [ -f "$f" ] || {{ echo "directory not found" >&2; exit 3; }}
    size=$(wc -c < "$f" | tr -d ' ')
    sum=$(md5sum "$f" | cut -d' ' -f1)
    printf '[{{"Path":"x","Name":"x","Size":%s,"IsDir":false,"Hashes":{{"md5":"%s"}}}}]\\n' \\
      "$size" "$sum" ;;
esac
"""
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


def test_upload_copies_and_checks_the_remote_md5(tmp_path):
    rclone = _fake_rclone(tmp_path)
    remote = tmp_path / "remote"
    local = tmp_path / "152.pdf"
    local.write_bytes(b"%PDF-1.7 fake\n")
    obj = RcloneUploader(str(remote), rclone=str(rclone)).upload(local, "cap-pdf/a2d/152.pdf")
    assert obj == RemoteObject(
        key="cap-pdf/a2d/152.pdf", size=local.stat().st_size, md5=_md5(local.read_bytes())
    )
    assert (remote / "cap-pdf/a2d/152.pdf").read_bytes() == local.read_bytes()


def test_a_remote_checksum_mismatch_is_an_upload_error(tmp_path):
    rclone = _fake_rclone(tmp_path, corrupt=True)
    local = tmp_path / "152.pdf"
    local.write_bytes(b"%PDF-1.7 fake\n")
    up = RcloneUploader(str(tmp_path / "remote"), rclone=str(rclone))
    with pytest.raises(UploadError, match="md5"):
        up.upload(local, "cap-pdf/a2d/152.pdf")


def test_a_failed_copy_is_an_upload_error(tmp_path):
    rclone = _fake_rclone(tmp_path, fail_copy=True)
    local = tmp_path / "152.pdf"
    local.write_bytes(b"x")
    up = RcloneUploader(str(tmp_path / "remote"), rclone=str(rclone))
    with pytest.raises(UploadError, match="exited 5"):
        up.upload(local, "cap-pdf/a2d/152.pdf")


def test_a_missing_rclone_is_an_upload_error(tmp_path):
    local = tmp_path / "152.pdf"
    local.write_bytes(b"x")
    up = RcloneUploader(str(tmp_path / "remote"), rclone=str(tmp_path / "no-rclone"))
    with pytest.raises(UploadError, match="could not run"):
        up.upload(local, "k.pdf")


@pytest.mark.skipif(shutil.which("rclone") is None, reason="rclone is not on PATH")
def test_real_rclone_against_a_local_directory(tmp_path):
    local = tmp_path / "152.pdf"
    local.write_bytes(os.urandom(4096))
    remote = tmp_path / "remote"
    obj = RcloneUploader(
        str(remote),
        rclone=shutil.which("rclone"),
        env={"RCLONE_CONFIG": str(tmp_path / "none.conf")},
    ).upload(local, "cap-pdf/a2d/152.pdf")
    assert obj.md5 == _md5(local.read_bytes())
    assert (remote / "cap-pdf/a2d/152.pdf").read_bytes() == local.read_bytes()
