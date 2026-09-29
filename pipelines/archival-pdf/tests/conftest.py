from pathlib import Path

import pytest
from fixture_paths import FIXTURES, ROOT


@pytest.fixture
def tar_path() -> Path:
    return FIXTURES / "152.tar"


@pytest.fixture
def csv_path() -> Path:
    return FIXTURES / "152.tar.csv"


@pytest.fixture
def source_csv_path() -> Path:
    """The mirror's unmodified a2d/152.tar.csv (for the full volume, not the fixture tar)."""
    return FIXTURES / "source" / "152.tar.csv"


@pytest.fixture
def source_mets_bytes() -> bytes:
    """The unmodified volume METS of a2d/152 (1,056 pages, 225 cases)."""
    return (FIXTURES / "source" / f"{ROOT}_METS.xml.gz").read_bytes()


@pytest.fixture(scope="session")
def jbig2_encoder():
    """The real jbig2 encoder (PATH, $STARE_JBIG2, or the pinned image if pulled), or skip."""
    from stare_archival.encoders import Jbig2Encoder

    enc = Jbig2Encoder.locate()
    if enc is None:
        pytest.skip("jbig2 is not available (no jbig2 on PATH, no $STARE_JBIG2, no local image)")
    return enc


@pytest.fixture(autouse=True)
def _skip_poppler_tests_without_poppler(request):
    """Tests marked `poppler` skip when pdfimages or pdftotext isn't on PATH."""
    from stare_archival.external import Poppler

    if request.node.get_closest_marker("poppler") and Poppler.locate() is None:
        pytest.skip("poppler (pdfimages, pdftotext) is not on PATH")
