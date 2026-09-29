import subprocess
import sys
from pathlib import Path

from stare_archival.images import PINNED_IMAGES, PINNED_JBIG2_IMAGE, PINNED_VERAPDF_IMAGE

WORKFLOW = Path(__file__).parents[3] / ".github" / "workflows" / "pipelines.yml"


def test_images_are_pinned_by_digest():
    assert PINNED_JBIG2_IMAGE.startswith("jbarlow83/ocrmypdf:v16.10.4@sha256:")
    assert PINNED_VERAPDF_IMAGE.startswith("verapdf/cli:v1.30.2@sha256:")
    for image in PINNED_IMAGES:
        digest = image.partition("@sha256:")[2]
        assert len(digest) == 64
        int(digest, 16)


def test_module_prints_the_images_to_pull():
    out = subprocess.run(
        [sys.executable, "-m", "stare_archival.images"], capture_output=True, check=True, text=True
    ).stdout
    assert out.split() == list(PINNED_IMAGES)


def test_ci_pulls_the_images_from_the_module_not_a_copy():
    workflow = WORKFLOW.read_text()
    assert "python -m stare_archival.images" in workflow
    assert "sha256:" not in workflow
