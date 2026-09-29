"""Page image encoders: a bitonal TIFF from the tar in, one PDF image stream out.

Two encoders share the `ImageEncoder` interface. `Jbig2Encoder` is the archival one: lossless
JBIG2 generic region coding by jbig2enc (`jbig2 -p -d`; never `-s`, so no symbol matching and
no /JBIG2Globals). `G4Encoder` re-encodes the page as one CCITT G4 strip with Pillow; it needs
no external tool, so the test suite and any machine without jbig2 can still build a PDF.

The tars' TIFFs are multi-strip G4. Passing their strips through as separate images is not an
option: it bloats the file and poppler drops rows at the strip seams (spike, 2026-09-29).
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Protocol, runtime_checkable

import pikepdf
import PIL
from PIL import Image, UnidentifiedImageError

from stare_archival.errors import EncodeError

# CAP scanned at 300 ppi; used only when a TIFF has no usable resolution tags
DEFAULT_DPI = 300.0

# the container image that ships jbig2enc 0.28, pinned by digest (tag kept for readability)
PINNED_JBIG2_IMAGE = (
    "jbarlow83/ocrmypdf:v16.10.4"
    "@sha256:60908d9f007a6f621769f6ecabdbc04e39845b5ca5342debaad504bc8efe050b"
)
# -p: PDF-ready output (no file header); -d: TPGD in the generic region coder. Never -s.
JBIG2_FLAGS = ("-p", "-d")
JBIG2_FILE_MAGIC = b"\x97JB2\r\n\x1a\n"


@dataclass(frozen=True)
class TiffInfo:
    """A page scan's pixel size and resolution; `page_size` is its size in PDF points."""

    width: int
    height: int
    dpi: tuple[float, float]

    @property
    def page_size(self) -> tuple[float, float]:
        return self.width * 72.0 / self.dpi[0], self.height * 72.0 / self.dpi[1]


def _open_tiff(data: bytes, path: str) -> Image.Image:
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise EncodeError(f"{path}: not a readable TIFF ({exc})") from exc
    if im.format != "TIFF":
        raise EncodeError(f"{path}: expected a TIFF, got {im.format}")
    return im


def _dpi(im: Image.Image) -> tuple[float, float]:
    # read the tags directly: Pillow reports "dpi" for a unitless resolution too
    tags = im.tag_v2  # type: ignore[attr-defined]
    unit = int(tags.get(296, 2))  # ResolutionUnit: 1 none, 2 inch (default), 3 cm
    per_inch = {2: 1.0, 3: 2.54}.get(unit)
    try:
        x, y = float(tags[282]), float(tags[283])
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return DEFAULT_DPI, DEFAULT_DPI
    if per_inch is None or x <= 0 or y <= 0:
        return DEFAULT_DPI, DEFAULT_DPI
    return x * per_inch, y * per_inch


def read_tiff(data: bytes, path: str = "<TIFF>") -> TiffInfo:
    """Pixel size and resolution of a TIFF (300 ppi when its resolution tags are missing)."""
    with _open_tiff(data, path) as im:
        return TiffInfo(im.size[0], im.size[1], _dpi(im))


@dataclass(frozen=True)
class EncodedImage:
    """An encoded page image, ready to be an image XObject's stream data.

    `filter` is a PDF filter name ("/JBIG2Decode" or "/CCITTFaxDecode"); `decode_parms` its
    DecodeParms entries, or None.
    """

    data: bytes
    width: int
    height: int
    filter: str
    decode_parms: Mapping[str, int] | None

    def stream_dict(self) -> dict[str, pikepdf.Object]:
        """The image XObject dictionary entries for this stream (1 bit DeviceGray)."""
        d: dict[str, pikepdf.Object] = {
            "/Type": pikepdf.Name.XObject,
            "/Subtype": pikepdf.Name.Image,
            "/Width": self.width,
            "/Height": self.height,
            "/ColorSpace": pikepdf.Name.DeviceGray,
            "/BitsPerComponent": 1,
            "/Filter": pikepdf.Name(self.filter),
        }
        if self.decode_parms is not None:
            d["/DecodeParms"] = pikepdf.Dictionary(dict(self.decode_parms))
        return d


@runtime_checkable
class ImageEncoder(Protocol):
    """Encodes one bitonal TIFF page. `name` (tool and version) and `settings` go into XMP."""

    @property
    def name(self) -> str: ...

    @property
    def settings(self) -> str: ...

    def encode(self, tiff: bytes, path: str = "<TIFF>") -> EncodedImage: ...


class G4Encoder:
    """Lossless CCITT G4 re-encode of the whole page into one strip (Pillow's libtiff).

    Pillow writes mode "1" as MinIsBlack, which a PDF's CCITTFaxDecode (BlackIs1 false) would
    show inverted, so the TIFF is written WhiteIsZero (PhotometricInterpretation 0). Each page
    is decoded again and compared with the source pixels before it's returned.
    """

    @property
    def name(self) -> str:
        return f"Pillow {PIL.__version__} (libtiff) CCITT G4"

    @property
    def settings(self) -> str:
        return "CCITT Group 4 (K -1), single strip, lossless re-encode, BlackIs1 false"

    def encode(self, tiff: bytes, path: str = "<TIFF>") -> EncodedImage:
        with _open_tiff(tiff, path) as im:
            if im.mode != "1":
                raise EncodeError(f"{path}: expected a bitonal (mode 1) page, got mode {im.mode}")
            buf = io.BytesIO()
            im.save(buf, "TIFF", compression="group4", strip_size=2**31 - 1, tiffinfo={262: 0})
            source_pixels = im.tobytes()
            width, height = im.size
        encoded = buf.getvalue()
        with Image.open(io.BytesIO(encoded)) as out:
            offsets, counts = out.tag_v2[273], out.tag_v2[279]
            if len(offsets) != 1:
                raise EncodeError(f"{path}: G4 re-encode wrote {len(offsets)} strips, not 1")
            if out.convert("1").tobytes() != source_pixels:
                raise EncodeError(f"{path}: G4 re-encode does not match the source pixels")
        strip = encoded[offsets[0] : offsets[0] + counts[0]]
        return EncodedImage(
            strip,
            width,
            height,
            "/CCITTFaxDecode",
            {"/K": -1, "/Columns": width, "/Rows": height},
        )


class Jbig2Encoder:
    """Lossless JBIG2 generic region coding with jbig2enc: `jbig2 -p -d <page.tif>`.

    Runs `binary` directly, or, with `docker_image`, the same command in a throwaway container
    (`docker run --rm -i --network=none`) with the TIFF on stdin. `extra_env` is added to the
    subprocess environment.
    """

    def __init__(
        self,
        binary: str = "jbig2",
        *,
        docker_image: str | None = None,
        extra_env: Mapping[str, str] | None = None,
        timeout: float = 300.0,
    ) -> None:
        self.binary = binary
        self.docker_image = docker_image
        self._env = {**os.environ, **extra_env} if extra_env else None
        self._timeout = timeout

    @classmethod
    def docker(cls, image: str = PINNED_JBIG2_IMAGE) -> Jbig2Encoder:
        """jbig2 from the pinned container image (the image must be pulled already)."""
        return cls(docker_image=image)

    @classmethod
    def locate(
        cls, env: Mapping[str, str] | None = None, *, docker: bool = True
    ) -> Jbig2Encoder | None:
        """Find jbig2: $STARE_JBIG2 (a binary path, "docker", or "none" to opt out), then
        PATH, then the pinned image if Docker has it locally (never pulled here). None when
        there's no jbig2."""
        env = os.environ if env is None else env
        search_path = env.get("PATH", "")
        chosen = env.get("STARE_JBIG2")
        if chosen:
            if chosen == "none":
                return None
            if chosen == "docker":
                return cls.docker()
            if not (os.path.isfile(chosen) and os.access(chosen, os.X_OK)):
                raise EncodeError(f"STARE_JBIG2={chosen!r} is not an executable file")
            return cls(chosen)
        found = shutil.which("jbig2", path=search_path)
        if found:
            return cls(found)
        if docker:
            docker_bin = shutil.which("docker", path=search_path)
            if docker_bin and _docker_has_image(docker_bin, PINNED_JBIG2_IMAGE):
                return cls.docker()
        return None

    def command(self, args: Sequence[str], input_path: str | None = None) -> list[str]:
        """The argv that runs `jbig2 <args> [input]` locally or in the container. In the
        container the input is read from stdin into /tmp/page.tif."""
        if self.docker_image is None:
            return [self.binary, *args, *([input_path] if input_path else [])]
        script = "exec jbig2 " + " ".join(args)
        if input_path is not None:
            script = f"cat > /tmp/page.tif && {script} /tmp/page.tif"
        return [
            "docker",
            "run",
            "--rm",
            "-i",
            "--network=none",
            "--entrypoint",
            "sh",
            self.docker_image,
            "-c",
            script,
        ]

    @cached_property
    def name(self) -> str:
        """jbig2enc's own version string, e.g. "jbig2enc 0.28"."""
        proc = self._run(self.command(["--version"]), b"")
        text = (proc.stdout + proc.stderr).decode(errors="replace").strip()
        if proc.returncode != 0 or not text:
            raise EncodeError(f"jbig2 --version failed: {text or proc.returncode}")
        return text.splitlines()[0].strip()

    @property
    def settings(self) -> str:
        return (
            "jbig2 " + " ".join(JBIG2_FLAGS) + " (lossless generic region coding with TPGD; "
            "no symbol coding, no JBIG2Globals)"
        )

    def encode(self, tiff: bytes, path: str = "<TIFF>") -> EncodedImage:
        info = read_tiff(tiff, path)
        if self.docker_image is None:
            with tempfile.TemporaryDirectory(prefix="stare-jbig2-") as tmp:
                page = Path(tmp) / "page.tif"
                page.write_bytes(tiff)
                proc = self._run(self.command(JBIG2_FLAGS, str(page)), b"")
        else:
            proc = self._run(self.command(JBIG2_FLAGS, "-"), tiff)
        if proc.returncode != 0:
            err = proc.stderr.decode(errors="replace").strip()
            raise EncodeError(f"{path}: jbig2 exited {proc.returncode}: {err}")
        data = proc.stdout
        if not data:
            raise EncodeError(f"{path}: jbig2 wrote no output")
        if data.startswith(JBIG2_FILE_MAGIC):
            raise EncodeError(f"{path}: jbig2 wrote a JBIG2 file header, not PDF-ready data")
        return EncodedImage(data, info.width, info.height, "/JBIG2Decode", None)

    def _run(self, argv: list[str], stdin: bytes) -> subprocess.CompletedProcess[bytes]:
        try:
            return subprocess.run(  # noqa: S603 (argv built from fixed flags, no shell)
                argv,
                input=stdin,
                capture_output=True,
                check=False,
                env=self._env,
                timeout=self._timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise EncodeError(f"could not run {argv[0]}: {exc}") from exc


def _docker_has_image(docker_bin: str, image: str) -> bool:
    try:
        probe = subprocess.run(  # noqa: S603 (fixed argv)
            [docker_bin, "image", "inspect", image],
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0
