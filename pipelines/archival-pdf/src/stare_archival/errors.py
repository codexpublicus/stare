"""Errors raised while reading, building and verifying a volume."""


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


class ToolError(ArchivalError):
    """An external tool (poppler, veraPDF) is missing or could not run."""


class VerifyError(ArchivalError):
    """A volume's PDF could not be verified at all (as opposed to failing a check)."""


class ManifestError(ArchivalError):
    """A volume manifest is unreadable or has an unknown schema version."""
