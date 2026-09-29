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
