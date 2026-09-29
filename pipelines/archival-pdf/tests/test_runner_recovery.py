"""The runner's recovery paths (A4 review): the disk guard's accounting, staging before
cap-pdf/, parent-side failures, and timeouts that kill a worker's own children."""

import multiprocessing
import os
import subprocess
import time
from pathlib import Path

import pytest
from test_runner import FakeUploader, _job, _plain_jobs, _touch_volume

from stare_archival.encoders import G4Encoder
from stare_archival.manifest import read_manifest
from stare_archival.runner import (
    Layout,
    VolumeJob,
    VolumeRef,
    VolumeResult,
    current_toolchain,
    find_volumes,
    manifest_toolchain,
    process_volume,
    run_batch,
)


def _put(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\0" * size)


# --- I-1: the disk guard counts what's actually on disk ----------------------------------


def _skip_as_before(job: VolumeJob) -> VolumeResult:
    # what a skipped volume with its PDF on disk used to report
    return VolumeResult(job.ref.id, "skipped", local_bytes=600)


def test_skipped_volumes_with_pdfs_on_disk_dont_stop_the_run(tmp_path):
    jobs = _plain_jobs(tmp_path, 3, size=100)
    lay = Layout(tmp_path / "out")
    for job in jobs:
        _put(lay.pdf(job.ref), 600)
    outcome = run_batch(jobs, workers=1, timeout=30, max_local_bytes=2500, worker=_skip_as_before)
    assert outcome.stopped is None
    assert [r.status for r in outcome.results] == ["skipped"] * 3


def _upload_or_build(job: VolumeJob) -> VolumeResult:
    lay = Layout(job.out)
    pdf = lay.pdf(job.ref)
    if pdf.exists():
        pdf.unlink()
        return VolumeResult(job.ref.id, "uploaded", local_bytes=0)
    _put(pdf, 600)
    return VolumeResult(job.ref.id, "pass", build_s=0.1, local_bytes=600)


def test_a_run_at_the_limit_uploads_waiting_pdfs_first(tmp_path):
    # an upload outage left three verified PDFs; the disk is at --max-local-bytes
    src = tmp_path / "src"
    for i in range(1, 5):
        _touch_volume(src, f"a/{i}", 100)
    lay = Layout(tmp_path / "out")
    refs = find_volumes(src)
    for ref in refs[1:]:
        _put(lay.pdf(ref), 600)
        _put(lay.manifest(ref), 10)
    jobs = [
        VolumeJob(
            ref=r,
            src=src,
            out=tmp_path / "out",
            toolchain={},
            encoder="g4",
            uploader=FakeUploader(tmp_path / "remote"),
        )
        for r in refs
    ]
    outcome = run_batch(jobs, workers=1, timeout=30, max_local_bytes=1800, worker=_upload_or_build)
    assert outcome.stopped is None
    assert [r.volume_id for r in outcome.results] == ["a/2", "a/3", "a/4", "a/1"]
    assert [r.status for r in outcome.results] == ["uploaded"] * 3 + ["pass"]


# --- I-2: nothing unverified in cap-pdf/ ------------------------------------------------


def _crash_in_verify(job: VolumeJob) -> None:
    import stare_archival.runner as runner

    def die(*_args, **_kwargs):
        os._exit(9)

    runner.verify_volume = die
    process_volume(job)


def test_a_crash_mid_volume_leaves_nothing_in_cap_pdf(src, out):
    job = _job(src, out, {"encoder": "x"}, encoder=G4Encoder())
    child = multiprocessing.get_context("fork").Process(target=_crash_in_verify, args=(job,))
    child.start()
    child.join(60)
    assert child.exitcode == 9
    cap_pdf = Layout(out).root
    assert not cap_pdf.exists() or not [p for p in cap_pdf.rglob("*") if p.is_file()]
    # the PDF was built, in staging
    assert [p.name for p in (out / ".staging").rglob("*.pdf")] == ["152.pdf"]


@pytest.mark.poppler
def test_a_passing_volume_leaves_no_staging_files(src, out, toolchain):
    assert process_volume(_job(src, out, toolchain)).status == "pass"
    staging = out / ".staging"
    assert not staging.exists() or not [p for p in staging.rglob("*") if p.is_file()]


def test_the_next_run_clears_a_crashed_volume_from_staging(src, out):
    job = _job(src, out, {"encoder": "x"}, encoder=G4Encoder())
    child = multiprocessing.get_context("fork").Process(target=_crash_in_verify, args=(job,))
    child.start()
    child.join(60)
    (src / "a2d" / "152.tar.csv").unlink()  # the retry errors before building
    assert process_volume(job).status == "error"
    assert not [p for p in (out / ".staging").rglob("*") if p.is_file()]


# --- M-1: a failure in the parent stops the pool and still reports ----------------------


def _fast_or_slow(job: VolumeJob) -> VolumeResult:
    if job.ref.id == "a/2":
        time.sleep(60)
    return VolumeResult(job.ref.id, "pass", pages=1, build_s=0.01)


def test_a_parent_side_failure_stops_the_workers_and_returns(tmp_path):
    jobs = _plain_jobs(tmp_path, 3)

    def record(_result):
        raise OSError(28, "No space left on device")

    start = time.monotonic()
    outcome = run_batch(jobs, workers=3, timeout=120, worker=_fast_or_slow, record=record)
    assert time.monotonic() - start < 30
    assert outcome.stopped is not None and outcome.stopped.startswith("crashed: OSError")
    m = read_manifest(Layout(tmp_path / "out").failed_manifest(VolumeRef.parse("a/2")))
    assert m["status"] == "error"


# --- M-2: a timeout kills the worker's children too ---------------------------------------


def _spawn_and_hang(job: VolumeJob) -> VolumeResult:
    child = subprocess.Popen(["sleep", "60"])  # noqa: S607
    (job.out / "child.pid").parent.mkdir(parents=True, exist_ok=True)
    (job.out / "child.pid").write_text(str(child.pid))
    time.sleep(60)
    return VolumeResult(job.ref.id, "pass")


def _alive(pid: int) -> bool:
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != "Z"


def test_a_timeout_kills_the_workers_subprocesses(tmp_path):
    jobs = _plain_jobs(tmp_path, 1)
    outcome = run_batch(jobs, workers=1, timeout=1.0, worker=_spawn_and_hang)
    assert outcome.results[0].status == "timeout"
    pid = int((tmp_path / "out" / "child.pid").read_text())
    deadline = time.monotonic() + 5
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not _alive(pid)


# --- M-10: the encoder's settings are part of the toolchain -------------------------------


def test_the_encoder_settings_are_part_of_the_toolchain():
    from stare_archival.external import Poppler

    poppler = Poppler.locate()
    if poppler is None:
        pytest.skip("poppler is not on PATH")
    enc = G4Encoder()
    tc = current_toolchain(enc, poppler)
    assert tc["encoder"] == enc.name
    assert tc["encoder_settings"] == enc.settings
    manifest = {"tools": {}, "encoder": {"name": "jbig2enc 0.28", "settings": "jbig2 -p -d"}}
    assert manifest_toolchain(manifest)["encoder_settings"] == "jbig2 -p -d"
