"""Assemble one volume's archival PDF from its tar.

Per page: the bitonal TIFF, encoded by an `ImageEncoder`, fills a page sized from its pixels
and resolution, with the ALTO words as an invisible text layer on top. The document gets METS
page labels, one bookmark per case, the METS, CASEMETS and BOXES members attached as PDF/A-3
associated files (the per-page ALTO stays in the tar), and PDF/A-3b metadata. Given the same
inputs, encoder and `created` date, the output is byte-identical.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from stare_archival import __version__
from stare_archival.alto import parse_alto
from stare_archival.casemets import Case
from stare_archival.encoders import ImageEncoder, read_tiff
from stare_archival.errors import BuildError
from stare_archival.mets import VolumeMets
from stare_archival.pdfa import XmpFields, add_metadata, add_output_intent, pdf_date
from stare_archival.tarindex import VolumeTar
from stare_archival.textlayer import FONT_RESOURCE, add_glyphless_font, text_operators
from stare_archival.volume import Volume, load_volume

_GZIP_MAGIC = b"\x1f\x8b"


@dataclass(frozen=True)
class BuildResult:
    """What `build_volume` wrote. Sizes are in bytes; `image_bytes` is the sum of the encoded
    page images. `attachments` are the attached members' paths below the tar's root."""

    out_path: Path
    volume_id: str
    page_count: int
    bookmark_count: int
    pages_without_text: int
    attachments: tuple[str, ...]
    image_bytes: int
    output_size: int
    output_sha256: str
    source_sha256: str
    encoder: str
    encoder_settings: str


def build_volume(
    tar_path: str | os.PathLike[str],
    csv_path: str | os.PathLike[str] | None,
    out_path: str | os.PathLike[str],
    encoder: ImageEncoder,
    *,
    volume_id: str | None = None,
    source_sha256: str | None = None,
    created: datetime | None = None,
) -> BuildResult:
    """Build the archival PDF for one volume tar and write it to `out_path`.

    `csv_path` defaults to `<tar_path>.csv`. `volume_id` (recorded as dc:source) defaults to
    `<parent dir>/<tar stem>`, which is `<reporter>/<volume>` in the mirror's layout.
    `source_sha256` is the tar's SHA-256 as recorded upstream; it's computed from the file
    when not given. `created` sets every date in the file (default: now); pass a fixed value
    for reproducible output. The file is written beside `out_path` and renamed into place.
    """
    tar_path = Path(tar_path)
    out_path = Path(out_path)
    volume_id = volume_id or f"{tar_path.parent.name}/{tar_path.stem}"
    source_sha256 = source_sha256 or _sha256_file(tar_path)
    created = created or datetime.now(UTC)

    pdf = pikepdf.new()
    with VolumeTar.open(tar_path, csv_path) as vt:
        volume = load_volume(vt)
        if not volume.mets.pages:
            raise BuildError(f"{volume.mets_path}: the METS lists no pages")
        font = add_glyphless_font(pdf)
        image_bytes, without_text = _add_pages(pdf, vt, volume.mets, encoder, font)
        _add_page_labels(pdf, volume.mets)
        bookmarks = _add_bookmarks(pdf, volume)
        attachments = _attach_sources(pdf, vt, volume, created)

    add_output_intent(pdf)
    add_metadata(
        pdf,
        XmpFields(
            title=_title(volume.mets),
            volume_id=volume_id,
            barcode=volume.mets.barcode or "",
            source_sha256=source_sha256,
            image_encoder=encoder.name,
            image_encoder_settings=encoder.settings,
            producer=(
                f"stare-archival {__version__} (pikepdf {pikepdf.__version__}, "
                f"qpdf {pikepdf.__libqpdf_version__})"
            ),
            creator_tool=f"stare-archival {__version__}",
            created=created,
        ),
    )
    _save(pdf, out_path)
    data = out_path.read_bytes()
    return BuildResult(
        out_path=out_path,
        volume_id=volume_id,
        page_count=len(volume.mets.pages),
        bookmark_count=bookmarks,
        pages_without_text=without_text,
        attachments=attachments,
        image_bytes=image_bytes,
        output_size=len(data),
        output_sha256=hashlib.sha256(data).hexdigest(),
        source_sha256=source_sha256,
        encoder=encoder.name,
        encoder_settings=encoder.settings,
    )


def _add_pages(
    pdf: pikepdf.Pdf,
    vt: VolumeTar,
    mets: VolumeMets,
    encoder: ImageEncoder,
    font: pikepdf.Object,
) -> tuple[int, int]:
    image_bytes = 0
    without_text = 0
    for page in mets.pages:
        if page.tiff is None:
            raise BuildError(f"METS page ORDER {page.order} has no TIFF")
        tiff = vt.read(page.tiff)
        info = read_tiff(tiff, page.tiff)
        encoded = encoder.encode(tiff, page.tiff)
        if (encoded.width, encoded.height) != (info.width, info.height):
            raise BuildError(
                f"{page.tiff}: encoder returned {encoded.width}x{encoded.height}, "
                f"the TIFF is {info.width}x{info.height}"
            )
        if encoded.decode_parms and "/JBIG2Globals" in encoded.decode_parms:
            raise BuildError(f"{page.tiff}: encoder produced a JBIG2Globals stream")
        image = pikepdf.Stream(pdf, encoded.data)
        for key, value in encoded.stream_dict().items():
            image[key] = value
        image_bytes += len(encoded.data)

        width, height = info.page_size
        content = b"q %.4f 0 0 %.4f 0 0 cm /Im0 Do Q\n" % (width, height)
        text = b""
        if page.alto is not None:
            alto = parse_alto(vt.read(page.alto), page.alto)
            text = text_operators(alto, page_height=height, dpi=info.dpi)
        if not text:
            without_text += 1
        resources = Dictionary(XObject=Dictionary(Im0=pdf.make_indirect(image)))
        if text:
            resources.Font = Dictionary({FONT_RESOURCE: font})
        pdf.pages.append(
            pikepdf.Page(
                Dictionary(
                    Type=Name.Page,
                    MediaBox=Array([0, 0, round(width, 4), round(height, 4)]),
                    Resources=resources,
                    Contents=pdf.make_indirect(pikepdf.Stream(pdf, content + text)),
                )
            )
        )
    return image_bytes, without_text


def _add_page_labels(pdf: pikepdf.Pdf, mets: VolumeMets) -> None:
    nums = Array()
    for index, page in enumerate(mets.pages):
        nums.append(index)
        if page.label:
            nums.append(Dictionary(P=String(page.label)))
        else:  # no printed label: fall back to the scan order as a decimal page number
            nums.append(Dictionary(S=Name.D, St=page.order))
    pdf.Root.PageLabels = Dictionary(Nums=nums)


def bookmark_title(order: int, case: Case) -> str:
    """ "<name>, <citation>" for a case with metadata, otherwise
    "Case <N> (pp. <first>-<last>[, duplicative])", N being the case's METS order."""
    name = case.name_abbreviation or case.name
    if name and not case.duplicative:
        return f"{name}, {case.citation}" if case.citation else name
    pages = f"{case.first_page}-{case.last_page}" if case.last_page else f"{case.first_page}"
    dup = ", duplicative" if case.duplicative else ""
    return f"Case {order} (pp. {pages}{dup})"


def _add_bookmarks(pdf: pikepdf.Pdf, volume: Volume) -> int:
    """One bookmark per case, at its first page present in the PDF. A case can start before
    (or lie wholly outside) the pages the METS lists; one with no page present is skipped."""
    index_of = {page.order: i for i, page in enumerate(volume.mets.pages)}
    count = 0
    with pdf.open_outline() as outline:
        for ref, case in volume.cases:
            present = [index_of[o] for o in case.page_orders if o in index_of]
            if not present:
                continue
            outline.root.append(pikepdf.OutlineItem(bookmark_title(ref.order, case), present[0]))
            count += 1
    return count


def _attach_sources(
    pdf: pikepdf.Pdf, vt: VolumeTar, volume: Volume, created: datetime
) -> tuple[str, ...]:
    """Attach the METS, every CASEMETS and the BOXES (when present) as they are in the tar
    (gzipped where the tar has them gzipped), as associated files with AFRelationship Source.

    /F and /UF hold the member's file name only, since some readers treat "/" there as a
    directory. The path below the tar's root is the name tree key, and /Desc ends with
    the full tar path."""
    members = [(volume.mets_path, "Volume METS")]
    members += [(ref.path, f"CASEMETS of case {ref.order}") for ref, _ in volume.cases]
    if volume.boxes_path is not None:
        members.append((volume.boxes_path, "Volume BOXES"))
    date = pdf_date(created)
    af = Array()
    names = []
    for path, description in members:
        data = vt.read(path)
        name = path.removeprefix(f"{vt.root}/")
        mime = "application/gzip" if data.startswith(_GZIP_MAGIC) else "application/xml"
        spec = pikepdf.AttachedFileSpec(
            pdf,
            data,
            description=f"{description} ({path})",
            filename=name.rsplit("/", 1)[-1],
            mime_type=mime,
            creation_date=date,
            mod_date=date,
        )
        spec.obj.AFRelationship = Name.Source
        ef = spec.obj.EF.F
        ef.Params.ModDate = String(date)
        ef.Params.Size = len(data)
        pdf.attachments[name] = spec
        af.append(spec.obj)
        names.append(name)
    pdf.Root.AF = af
    return tuple(names)


def _title(mets: VolumeMets) -> str:
    if mets.volume_number and mets.reporter:
        return f"{mets.volume_number} {mets.reporter}"
    return f"CAP volume {mets.barcode}"


def _save(pdf: pikepdf.Pdf, out_path: Path) -> None:
    tmp = out_path.with_name(out_path.name + ".tmp")
    try:
        pdf.save(
            tmp,
            min_version="1.7",
            compress_streams=True,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
            deterministic_id=True,
            fix_metadata_version=False,
        )
        os.replace(tmp, out_path)
    finally:
        tmp.unlink(missing_ok=True)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
