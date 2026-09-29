"""Errors raised while reading a volume's tar and metadata."""


class ArchivalError(Exception):
    """Base class for every error this package raises about its input data."""


class TarIndexError(ArchivalError):
    """A .tar.csv manifest is malformed."""


class MemberNotFoundError(ArchivalError):
    """A path is not in the volume's .tar.csv."""


class MemberReadError(ArchivalError):
    """A member's bytes could not be read as the index describes them."""


class MetadataError(ArchivalError):
    """A METS, CASEMETS or ALTO member (or its gzip wrapper) is malformed."""


class EncodeError(ArchivalError):
    """A page image could not be read or encoded for the PDF."""


class BuildError(ArchivalError):
    """A volume's PDF could not be assembled from its tar."""
