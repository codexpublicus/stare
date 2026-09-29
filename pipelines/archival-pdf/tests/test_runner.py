import hashlib
import json
import os
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path

import jsonschema
import pytest
from fixture_paths import FIXTURES, TIFF_TEXT

from stare_archival.encoders import G4Encoder
from stare_archival.errors import RunnerError, UploadError
from stare_archival.manifest import manifest_schema, read_manifest
from stare_archival.runner import (
    Layout,
    VolumeJob,
    VolumeRef,
    VolumeResult,
    current_toolchain,
    find_volumes,
    format_summary,
    parse_size,
    process_volume,
    run_batch,
    summarize,
    write_run,
)
from stare_archival.upload import RemoteObject, md5_file

CREATED = datetime(2026, 9, 29, 12, 0, 0, tzinfo=UTC)
IMAGE = "stare-archival@sha256:" + "c" * 64


# --- test doubles ------------------------------------------------------------------------


class FakeUploader:
    """Uploads into a local directory; `fail` makes every upload raise."""

    def __init__(self, root: Path, *, fail: bool = False) -> None:
        self.root = root
        self.fail = fail

    def upload(self, local: Path, key: str) -> RemoteObject:
        if self.fail:
            raise UploadError(f"{key}: the remote is unreachable")
        dst = self.root / key
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(local, dst)
        return RemoteObject(key=key, size=dst.stat().st_size, md5=md5_file(dst))


class FlippingEncoder(G4Encoder):
    """G4, but one pixel of the page with ALTO words is flipped before encoding, so the PDF
    builds and then fails the pixel check."""

    def encode(self, tiff: bytes, path: str = "<TIFF>"):
        import io

        from PIL import Image

        if path != TIFF_TEXT:
            return super().encode(tiff, path)
        with Image.open(io.BytesIO(tiff)) as im:
            im.load()
            im.putpixel((700, 900), 255 - im.getpixel((700, 900)))
            buf = io.BytesIO()
            im.save(buf, "TIFF", compression="group4", dpi=im.info.get("dpi", (300, 300)))
        return super().encode(buf.getvalue(), path)


# --- fixtures ----------------------------------------------------------------------------


def _add_volume(src: Path, ref: str, *, sha256: bool = True) -> None:
    reporter, volume = ref.split("/")
    d = src / reporter
    d.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURES / "152.tar", d / f"{volume}.tar")
    shutil.copyfile(FIXTURES / "152.tar.csv", d / f"{volume}.tar.csv")
    if sha256:
        digest = hashlib.sha256((FIXTURES / "152.tar").read_bytes()).hexdigest()
        (d / f"{volume}.tar.sha256").write_text(digest + "\n")


@pytest.fixture
def src(tmp_path) -> Path:
    s = tmp_path / "mirror"
    _add_volume(s, "a2d/152")
    return s


@pytest.fixture
def out(tmp_path) -> Path:
    return tmp_path / "out"


@pytest.fixture(scope="module")
def toolchain() -> dict:
    from stare_archival.external import Poppler

    poppler = Poppler.locate()
    if poppler is None:
        pytest.skip("poppler (pdfimages, pdftotext) is not on PATH")
    return current_toolchain(G4Encoder(), poppler)


def _job(src, out, toolchain, ref="a2d/152", **kw) -> VolumeJob:
    kw.setdefault("encoder", "g4")
    kw.setdefault("created", CREATED)
    kw.setdefault("pipeline_image", IMAGE)
    return VolumeJob(ref=VolumeRef.parse(ref), src=src, out=out, toolchain=toolchain, **kw)


# --- volume discovery --------------------------------------------------------------------


def _touch_volume(src: Path, ref: str, size: int = 0) -> None:
    reporter, volume = ref.split("/")
    (src / reporter).mkdir(parents=True, exist_ok=True)
    (src / reporter / f"{volume}.tar").write_bytes(b"\0" * size)
    (src / reporter / f"{volume}.tar.csv").write_text("")


def test_volume_ref_parse():
    ref = VolumeRef.parse("a2d/152")
    assert (ref.reporter, ref.volume, ref.id) == ("a2d", "152", "a2d/152")
    for bad in ("a2d", "a2d/152/x", "/152", "a2d/", "../x/1", "a2d/.."):
        with pytest.raises(ValueError):
            VolumeRef.parse(bad)


def test_find_volumes_sorts_naturally_and_filters(tmp_path):
    src = tmp_path / "downloads"
    for ref in ("us/10", "us/2", "us/1", "a2d/152", "a2d/31", "ill-app-3d/100"):
        _touch_volume(src, ref)
    (src / "us" / "notes.txt").write_text("not a volume")
    (src / "metadata.json").write_text("{}")
    ids = [r.id for r in find_volumes(src)]
    assert ids == ["a2d/31", "a2d/152", "ill-app-3d/100", "us/1", "us/2", "us/10"]
    assert [r.id for r in find_volumes(src, only=["us"])] == ["us/1", "us/2", "us/10"]
    assert [r.id for r in find_volumes(src, only=["us/10", "a2d"])] == [
        "a2d/31",
        "a2d/152",
        "us/10",
    ]
    assert [r.id for r in find_volumes(src, limit=2)] == ["a2d/31", "a2d/152"]


def test_find_volumes_rejects_unknown_only_entries(tmp_path):
    src = tmp_path / "downloads"
    _touch_volume(src, "us/10")
    with pytest.raises(RunnerError, match="us/11"):
        find_volumes(src, only=["us/11"])
    with pytest.raises(RunnerError, match="nope"):
        find_volumes(src, only=["nope"])
    with pytest.raises(RunnerError, match="no such directory"):
        find_volumes(tmp_path / "missing")


def test_parse_size():
    assert parse_size("123") == 123
    assert parse_size("400G") == 400 * 1024**3
    assert parse_size("1.5T") == int(1.5 * 1024**4)
    assert parse_size("20m") == 20 * 1024**2
    with pytest.raises(ValueError):
        parse_size("lots")


def test_layout_paths(tmp_path):
    lay = Layout(tmp_path)
    ref = VolumeRef.parse("a2d/152")
    assert lay.pdf(ref) == tmp_path / "cap-pdf/a2d/152.pdf"
    assert lay.manifest(ref) == tmp_path / "cap-pdf/_manifests/a2d/152.json"
    assert lay.pdf_key(ref) == "cap-pdf/a2d/152.pdf"
    assert lay.manifest_key(ref) == "cap-pdf/_manifests/a2d/152.json"
    assert lay.failed_manifest(ref) == tmp_path / "failed/a2d/152.json"
    assert lay.failed_pdf(ref) == tmp_path / "failed/a2d/152.pdf"
    assert lay.receipt(ref) == tmp_path / "uploaded/a2d/152.json"


# --- one volume --------------------------------------------------------------------------


@pytest.mark.poppler
def test_process_volume_builds_verifies_and_writes_the_manifest(src, out, toolchain):
    result = process_volume(_job(src, out, toolchain))
    assert result.status == "pass", result
    assert result.pages == 4
    assert result.build_s > 0 and result.verify_s > 0
    lay = Layout(out)
    ref = VolumeRef.parse("a2d/152")
    pdf = lay.pdf(ref)
    assert pdf.is_file()
    assert result.output_size == pdf.stat().st_size
    assert result.local_bytes == pdf.stat().st_size
    m = read_manifest(lay.manifest(ref))
    jsonschema.validate(m, manifest_schema())
    assert m["status"] == "pass"
    assert m["volume_id"] == "a2d/152"
    assert m["pins"] == {"pipeline": IMAGE}
    assert m["source"]["recorded_sha256"] == m["source"]["sha256"]
    # nothing is left in the scratch directories
    assert not (out / "work").exists() or not any((out / "work").rglob("*"))
    assert not (out / "failed").exists()


@pytest.mark.poppler
def test_a_finished_volume_is_skipped(src, out, toolchain):
    assert process_volume(_job(src, out, toolchain)).status == "pass"
    pdf = Layout(out).pdf(VolumeRef.parse("a2d/152"))
    before = pdf.stat().st_mtime_ns
    again = process_volume(_job(src, out, toolchain))
    assert again.status == "skipped"
    assert again.pages == 4
    assert pdf.stat().st_mtime_ns == before


@pytest.mark.poppler
def test_force_rebuilds_a_finished_volume(src, out, toolchain):
    assert process_volume(_job(src, out, toolchain)).status == "pass"
    assert process_volume(_job(src, out, toolchain, force=True)).status == "pass"


@pytest.mark.poppler
@pytest.mark.parametrize("change", ["toolchain", "encoder", "source", "pdf", "manifest"])
def test_a_volume_is_rebuilt_when_its_record_no_longer_holds(src, out, toolchain, change):
    assert process_volume(_job(src, out, toolchain)).status == "pass"
    ref = VolumeRef.parse("a2d/152")
    lay = Layout(out)
    tc = dict(toolchain)
    if change == "toolchain":
        tc["pdfimages"] = "pdfimages version 99.0"
    elif change == "encoder":
        tc["encoder"] = "jbig2enc 0.29"
    elif change == "source":
        # the mirror's recorded sha256 changed (a re-download)
        (src / "a2d" / "152.tar.sha256").write_text("0" * 64 + "\n")
    elif change == "pdf":
        with lay.pdf(ref).open("ab") as f:
            f.write(b"%junk\n")
    else:
        lay.manifest(ref).write_text("{not json")
    result = process_volume(_job(src, out, tc))
    if change == "source":
        # rebuilt, and the build fails source_sha256 against the new record
        assert result.status == "fail"
        assert result.failed_checks == {"source_sha256": 1}
    else:
        assert result.status == "pass", result


@pytest.mark.poppler
def test_a_failing_volume_is_recorded_outside_the_upload_tree(src, out, toolchain):
    result = process_volume(_job(src, out, toolchain, encoder=FlippingEncoder()))
    assert result.status == "fail"
    assert result.failed_checks == {"image_pixels": 1}
    lay = Layout(out)
    ref = VolumeRef.parse("a2d/152")
    assert not lay.pdf(ref).exists()
    assert not lay.manifest(ref).exists()
    m = read_manifest(lay.failed_manifest(ref))
    jsonschema.validate(m, manifest_schema())
    assert m["status"] == "fail"
    assert lay.failed_pdf(ref).is_file()
    assert result.local_bytes == lay.failed_pdf(ref).stat().st_size
    # a later good build clears the failure record
    assert process_volume(_job(src, out, toolchain)).status == "pass"
    assert not lay.failed_manifest(ref).exists()
    assert not lay.failed_pdf(ref).exists()


def test_a_volume_that_cant_be_built_gets_an_error_manifest(src, out):
    (src / "a2d" / "152.tar.csv").unlink()
    result = process_volume(_job(src, out, {"encoder": "x"}))
    assert result.status == "error"
    assert "152.tar.csv" in result.error
    m = read_manifest(Layout(out).failed_manifest(VolumeRef.parse("a2d/152")))
    jsonschema.validate(m, manifest_schema())
    assert m["status"] == "error"
    assert m["volume_id"] == "a2d/152"
    assert m["pins"] == {"pipeline": IMAGE}


# --- streaming upload --------------------------------------------------------------------


@pytest.mark.poppler
def test_streaming_uploads_verifies_and_deletes_the_local_pdf(src, out, toolchain, tmp_path):
    remote = tmp_path / "remote"
    result = process_volume(_job(src, out, toolchain, uploader=FakeUploader(remote)))
    assert result.status == "pass", result
    assert result.upload_s > 0
    lay = Layout(out)
    ref = VolumeRef.parse("a2d/152")
    assert not lay.pdf(ref).exists()
    assert result.local_bytes == 0
    manifest = read_manifest(lay.manifest(ref))
    uploaded = remote / "cap-pdf/a2d/152.pdf"
    assert hashlib.sha256(uploaded.read_bytes()).hexdigest() == manifest["output"]["sha256"]
    assert (remote / "cap-pdf/_manifests/a2d/152.json").read_bytes() == (
        lay.manifest(ref).read_bytes()
    )
    receipt = json.loads(lay.receipt(ref).read_text())
    assert receipt["pdf"]["key"] == "cap-pdf/a2d/152.pdf"
    assert receipt["pdf"]["sha256"] == manifest["output"]["sha256"]
    assert receipt["manifest"]["key"] == "cap-pdf/_manifests/a2d/152.json"
    # uploaded and verified remotely counts as done, with no local PDF
    again = process_volume(_job(src, out, toolchain, uploader=FakeUploader(remote)))
    assert again.status == "skipped"
    # and so it does for a run without upload
    assert process_volume(_job(src, out, toolchain)).status == "skipped"


@pytest.mark.poppler
def test_a_failed_upload_keeps_the_pdf_and_the_next_run_only_uploads(src, out, toolchain, tmp_path):
    remote = tmp_path / "remote"
    result = process_volume(_job(src, out, toolchain, uploader=FakeUploader(remote, fail=True)))
    assert result.status == "upload_failed"
    assert "unreachable" in result.error
    lay = Layout(out)
    ref = VolumeRef.parse("a2d/152")
    assert lay.pdf(ref).is_file()
    assert result.local_bytes == lay.pdf(ref).stat().st_size
    assert not lay.receipt(ref).exists()
    manifest_before = lay.manifest(ref).read_bytes()
    again = process_volume(_job(src, out, toolchain, uploader=FakeUploader(remote)))
    assert again.status == "uploaded"
    assert again.build_s == 0
    assert lay.manifest(ref).read_bytes() == manifest_before
    assert (remote / "cap-pdf/a2d/152.pdf").is_file()
    assert not lay.pdf(ref).exists()
    assert lay.receipt(ref).is_file()


# --- the batch ---------------------------------------------------------------------------


@pytest.mark.poppler
def test_run_batch_builds_in_parallel_and_summarizes(src, out, toolchain):
    _add_volume(src, "us/10", sha256=False)
    jobs = [_job(src, out, toolchain, r.id) for r in find_volumes(src)]
    lines: list[str] = []
    outcome = run_batch(jobs, workers=2, timeout=300, log=lines.append)
    assert sorted(r.status for r in outcome.results) == ["pass", "pass"]
    assert outcome.stopped is None
    assert len(lines) == 2 and all("PASS" in line for line in lines)
    summary = summarize(outcome, run_id="test", workers=2, settings={"jobs": 2})
    assert summary["counts"]["pass"] == 2
    assert summary["counts"]["selected"] == 2
    assert summary["pages"]["built"] == 8
    assert summary["throughput"]["pages_per_worker_second"] > 0
    assert summary["throughput"]["pages_per_second"] > 0
    assert summary["failures_by_check"] == {}
    text = format_summary(summary)
    assert "pass 2" in text
    json_path, text_path = write_run(Layout(out), summary)
    assert json.loads(json_path.read_text())["run_id"] == "test"
    assert text_path.read_text() == text
    # resumed: nothing to do
    again = run_batch(jobs, workers=2, timeout=300)
    assert [r.status for r in again.results] == ["skipped", "skipped"]


def test_summary_counts_failures_by_check():
    results = [
        VolumeResult("a/1", "pass", pages=10, build_s=1.0, verify_s=1.0),
        VolumeResult(
            "a/2",
            "fail",
            pages=5,
            build_s=1.0,
            verify_s=1.0,
            failed_checks={"image_pixels": 2, "text_layer": 1},
        ),
        VolumeResult("a/3", "fail", pages=5, failed_checks={"image_pixels": 1}),
        VolumeResult("a/4", "error", error="BuildError: bad METS"),
        VolumeResult("a/5", "timeout", error="timed out after 10 s"),
        VolumeResult("a/6", "skipped", pages=7),
        VolumeResult("a/7", "upload_failed", pages=3, error="UploadError: x"),
    ]
    from stare_archival.runner import BatchOutcome

    summary = summarize(
        BatchOutcome(results=results, elapsed_s=4.0, stopped=None, selected=7),
        run_id="r",
        workers=2,
        settings={},
    )
    assert summary["counts"] == {
        "selected": 7,
        "pass": 1,
        "uploaded": 0,
        "skipped": 1,
        "fail": 2,
        "error": 1,
        "timeout": 1,
        "upload_failed": 1,
        "not_run": 0,
    }
    assert summary["failures_by_check"] == {"image_pixels": 2, "text_layer": 1}
    assert summary["ok"] is False
    text = format_summary(summary)
    assert "FAIL a/2: image_pixels (2), text_layer (1)" in text
    assert "ERROR a/4: BuildError: bad METS" in text
    assert "TIMEOUT a/5" in text


# fake workers: module level so a forked child runs them


def _slow_for_a2(job: VolumeJob) -> VolumeResult:
    if job.ref.id == "a/2":
        time.sleep(60)
    return VolumeResult(job.ref.id, "pass", pages=1, build_s=0.01, verify_s=0.01)


def _crash(_job: VolumeJob) -> VolumeResult:
    os._exit(3)


def _record_concurrency(job: VolumeJob) -> VolumeResult:
    running = job.out / "running"
    running.mkdir(parents=True, exist_ok=True)
    mine = running / job.ref.volume
    mine.touch()
    seen = len(list(running.iterdir()))
    time.sleep(0.3)
    seen = max(seen, len(list(running.iterdir())))
    mine.unlink()
    (job.out / "seen").mkdir(exist_ok=True)
    (job.out / "seen" / job.ref.volume).write_text(str(seen))
    return VolumeResult(job.ref.id, "pass", pages=1, build_s=0.3, verify_s=0.0)


def _plain_jobs(tmp_path: Path, n: int, size: int = 0) -> list[VolumeJob]:
    src = tmp_path / "src"
    for i in range(1, n + 1):
        _touch_volume(src, f"a/{i}", size)
    return [
        VolumeJob(ref=r, src=src, out=tmp_path / "out", toolchain={}, encoder="g4")
        for r in find_volumes(src)
    ]


def test_a_volume_over_its_timeout_is_killed_and_recorded(tmp_path):
    jobs = _plain_jobs(tmp_path, 3)
    start = time.monotonic()
    outcome = run_batch(jobs, workers=3, timeout=1.0, worker=_slow_for_a2)
    assert time.monotonic() - start < 20
    by_id = {r.volume_id: r for r in outcome.results}
    assert by_id["a/1"].status == "pass"
    assert by_id["a/3"].status == "pass"
    assert by_id["a/2"].status == "timeout"
    assert "1 s" in by_id["a/2"].error
    m = read_manifest(Layout(tmp_path / "out").failed_manifest(VolumeRef.parse("a/2")))
    assert m["status"] == "error" and "timed out" in m["error"]


def test_a_crashed_worker_is_an_error(tmp_path):
    outcome = run_batch(_plain_jobs(tmp_path, 1), workers=1, timeout=30, worker=_crash)
    (result,) = outcome.results
    assert result.status == "error"
    assert "exited with code 3" in result.error


def test_the_disk_guard_limits_what_runs_at_once(tmp_path):
    # each volume reserves its tar's size (1,000 bytes) while it runs: 2,500 allows two
    jobs = _plain_jobs(tmp_path, 4, size=1000)
    outcome = run_batch(
        jobs, workers=4, timeout=30, max_local_bytes=2500, worker=_record_concurrency
    )
    assert [r.status for r in outcome.results] == ["pass"] * 4
    seen = [int(p.read_text()) for p in (tmp_path / "out" / "seen").iterdir()]
    assert max(seen) <= 2
    assert outcome.stopped is None


def test_the_disk_guard_stops_the_run_when_local_files_fill_it(tmp_path):
    jobs = _plain_jobs(tmp_path, 3, size=1000)
    # 1,500 bytes of PDFs already waiting locally leave no room for a 1,000-byte volume
    stale = Layout(tmp_path / "out").pdf(VolumeRef.parse("z/1"))
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"\0" * 1500)
    outcome = run_batch(
        jobs, workers=2, timeout=30, max_local_bytes=2000, worker=_record_concurrency
    )
    assert outcome.results == []
    assert outcome.stopped is not None and "disk guard" in outcome.stopped
    summary = summarize(outcome, run_id="r", workers=2, settings={})
    assert summary["counts"]["not_run"] == 3
    assert summary["ok"] is False
    assert "disk guard" in format_summary(summary)
