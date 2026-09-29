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
