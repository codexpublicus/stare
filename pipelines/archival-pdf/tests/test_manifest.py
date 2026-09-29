import json
from datetime import UTC, datetime
from pathlib import Path

import jsonschema
import pytest

from stare_archival import __version__
from stare_archival.build import BuildResult
from stare_archival.errors import ManifestError
from stare_archival.images import PINNED_JBIG2_IMAGE, PINNED_VERAPDF_IMAGE
from stare_archival.manifest import (
    MANIFEST_SCHEMA_VERSION,
    build_manifest,
    error_manifest,
    manifest_schema,
    manifest_succeeded,
    read_manifest,
    write_manifest,
)
from stare_archival.verify import CheckResult, Failure, VerifyReport

GENERATED = datetime(2026, 9, 29, 12, 0, 0, tzinfo=UTC)
SRC = "a" * 64
OUT = "b" * 64


def _report(
    *, failing: bool = False, recorded: str | None = SRC, tools: dict | None = None
) -> VerifyReport:
    failures = (
        (Failure("image_pixels", "1 pixel differs, within x 7-7, y 9-9", 2, 871, "839"),)
        if failing
        else ()
    )
    checks = (
        CheckResult("source_sha256", "pass", {"computed": SRC}),
        CheckResult("structure", "pass", {"pages": 4}),
        CheckResult("image_pixels", "fail" if failing else "pass", {"pages_compared": 4}, failures),
        CheckResult("pdfa", "skipped", {"reason": "not requested"}),
    )
    return VerifyReport(
        pdf_path=Path("/out/a2d/152.pdf"),
        tar_path=Path("/mirror/downloads/a2d/152.tar"),
        volume_id="a2d/152",
        barcode="32044109578831",
        page_count=4,
        labels=("838", "839", "840", "841"),
        output_sha256=OUT,
        output_size=80_252,
        source_sha256=SRC,
        recorded_source_sha256=recorded,
        embedded_source_sha256=SRC,
        encoder="jbig2enc 0.28",
        encoder_settings="jbig2 -p -d (lossless generic region coding)",
        checks=checks,
        tools={"pdfimages": "pdfimages version 24.02.0", "pikepdf": "10.15.0", **(tools or {})},
    )


def _build_result() -> BuildResult:
    return BuildResult(
        out_path=Path("/out/a2d/152.pdf"),
        volume_id="a2d/152",
        page_count=4,
        bookmark_count=3,
        pages_without_text=2,
        attachments=("32044109578831_redacted_METS.xml.gz",),
        image_bytes=52_304,
        output_size=80_252,
        output_sha256=OUT,
        source_sha256=SRC,
        encoder="jbig2enc 0.28",
        encoder_settings="jbig2 -p -d (lossless generic region coding)",
    )


def _validate(manifest: dict) -> None:
    jsonschema.Draft202012Validator(manifest_schema()).validate(manifest)


def test_schema_is_a_valid_versioned_json_schema():
    schema = manifest_schema()
    jsonschema.Draft202012Validator.check_schema(schema)
    assert schema["properties"]["schema_version"]["const"] == MANIFEST_SCHEMA_VERSION == 1
    assert schema["$id"].endswith("/manifest/1.json")


def test_passing_manifest_records_volume_source_output_encoder_and_checks():
    m = build_manifest(_report(), _build_result(), generated=GENERATED)
    _validate(m)
    assert m["schema_version"] == 1
    assert m["status"] == "pass"
    assert m["volume_id"] == "a2d/152"
    assert m["barcode"] == "32044109578831"
    assert m["generated"] == "2026-09-29T12:00:00Z"
    assert m["source"] == {
        "tar": "152.tar",
        "sha256": SRC,
        "recorded_sha256": SRC,
        "embedded_sha256": SRC,
    }
    assert m["output"] == {"file": "152.pdf", "sha256": OUT, "size": 80_252, "page_count": 4}
    assert m["encoder"] == {
        "name": "jbig2enc 0.28",
        "settings": "jbig2 -p -d (lossless generic region coding)",
    }
    assert m["build"] == {
        "bookmark_count": 3,
        "pages_without_text": 2,
        "image_bytes": 52_304,
        "attachments": ["32044109578831_redacted_METS.xml.gz"],
    }
    assert [c["name"] for c in m["checks"]] == [
        "source_sha256",
        "structure",
        "image_pixels",
        "pdfa",
    ]
    assert m["error"] is None


def test_manifest_records_tool_versions_and_image_pins():
    m = build_manifest(_report(), generated=GENERATED)
    assert m["tools"]["stare-archival"] == __version__
    assert m["tools"]["pdfimages"] == "pdfimages version 24.02.0"
    assert {"python", "pikepdf", "qpdf", "pillow", "lxml"} <= set(m["tools"])
    assert m["build"] is None
    _validate(m)


def test_pins_list_only_the_images_this_volume_used():
    # a G4 build, or jbig2 from PATH, verified without veraPDF: no container image involved
    assert build_manifest(_report(), generated=GENERATED)["pins"] == {}
    report = _report(tools={"verapdf": "veraPDF 1.30.2", "verapdf_image": PINNED_VERAPDF_IMAGE})
    m = build_manifest(report, jbig2_image=PINNED_JBIG2_IMAGE, generated=GENERATED)
    _validate(m)
    assert m["pins"] == {"jbig2": PINNED_JBIG2_IMAGE, "verapdf": PINNED_VERAPDF_IMAGE}


def test_failing_manifest_lists_the_failures_with_their_page():
    m = build_manifest(_report(failing=True), generated=GENERATED)
    _validate(m)
    assert m["status"] == "fail"
    (pixels,) = [c for c in m["checks"] if c["name"] == "image_pixels"]
    assert pixels["status"] == "fail"
    assert pixels["failures"] == [
        {
            "check": "image_pixels",
            "page": 2,
            "order": 871,
            "label": "839",
            "message": "1 pixel differs, within x 7-7, y 9-9",
        }
    ]


def test_no_recorded_sha256_is_null():
    m = build_manifest(_report(recorded=None), generated=GENERATED)
    _validate(m)
    assert m["source"]["recorded_sha256"] is None


def test_error_manifest_for_a_volume_that_could_not_be_built():
    m = error_manifest(
        "a2d/152", ValueError("boom"), source_sha256=SRC, generated=GENERATED, tar="152.tar"
    )
    _validate(m)
    assert m["status"] == "error"
    assert m["error"] == "ValueError: boom"
    assert m["source"]["sha256"] == SRC
    assert m["output"] is None and m["checks"] == []


def test_generated_must_be_timezone_aware():
    with pytest.raises(ValueError, match="timezone"):
        build_manifest(_report(), generated=datetime(2026, 9, 29))  # noqa: DTZ001


def test_write_and_read_round_trip(tmp_path):
    m = build_manifest(_report(), generated=GENERATED)
    path = tmp_path / "a2d" / "152.json"
    write_manifest(path, m)
    assert read_manifest(path) == m
    text = path.read_text()
    assert text.endswith("\n")
    assert not list(path.parent.glob("*.tmp"))
    assert json.loads(text)["schema_version"] == 1


def test_read_rejects_other_schema_versions_and_bad_json(tmp_path):
    path = tmp_path / "m.json"
    path.write_text(json.dumps({"schema_version": 2}))
    with pytest.raises(ManifestError, match="schema_version 2"):
        read_manifest(path)
    path.write_text("{")
    with pytest.raises(ManifestError, match=r"m\.json"):
        read_manifest(path)


def test_manifest_succeeded_needs_a_pass_for_the_same_source():
    good = build_manifest(_report(), generated=GENERATED)
    assert manifest_succeeded(good, SRC)
    assert not manifest_succeeded(good, "c" * 64)
    assert not manifest_succeeded(build_manifest(_report(failing=True), generated=GENERATED), SRC)
    err = error_manifest("a2d/152", "boom", source_sha256=SRC, generated=GENERATED)
    assert not manifest_succeeded(err, SRC)


def test_the_pipeline_image_is_pinned_when_given():
    image = "stare-archival@sha256:" + "e" * 64
    m = build_manifest(_report(), pipeline_image=image, generated=GENERATED)
    assert m["pins"] == {"pipeline": image}
    jsonschema.validate(m, manifest_schema())
    e = error_manifest("a2d/152", "BuildError: x", pipeline_image=image, generated=GENERATED)
    assert e["pins"] == {"pipeline": image}
    jsonschema.validate(e, manifest_schema())


def test_the_schema_names_every_check_verify_runs():
    from stare_archival.verify import CHECKS

    item = manifest_schema()["properties"]["checks"]["items"]
    assert tuple(item["properties"]["name"]["enum"]) == CHECKS


def test_the_image_revision_is_recorded_with_the_tools(monkeypatch):
    from stare_archival.manifest import package_versions

    monkeypatch.delenv("STARE_ARCHIVAL_REVISION", raising=False)
    assert "stare-archival-revision" not in package_versions()
    monkeypatch.setenv("STARE_ARCHIVAL_REVISION", "8d49c78" + "0" * 33)
    assert package_versions()["stare-archival-revision"] == "8d49c78" + "0" * 33
    m = build_manifest(_report(), generated=GENERATED)
    assert m["tools"]["stare-archival-revision"] == "8d49c78" + "0" * 33
    jsonschema.validate(m, manifest_schema())
