"""Paths of the a2d/152 fixture and of members inside its tar slice."""

from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "a2d-152"
ROOT = "32044109578831_redacted"


def member(kind: str, name: str) -> str:
    """Tar path of a fixture member, e.g. member("alto", "..._ALTO_00436_0.xml.gz")."""
    return f"{ROOT}/{kind}/{name}" if kind else f"{ROOT}/{name}"


ALTO_TEXT = member("alto", f"{ROOT}_ALTO_00436_0.xml.gz")  # page 871, label 839, 302 words
ALTO_EMPTY = member("alto", f"{ROOT}_ALTO_00437_0.xml.gz")  # page 873, duplicative, no words
TIFF_TEXT = member("images", "32044109578831_00436_0.tif")
METS = member("", f"{ROOT}_METS.xml.gz")
CASEMETS = {n: member("casemets", f"{ROOT}_CASEMETS_{n:04d}.xml.gz") for n in (201, 202, 203)}
