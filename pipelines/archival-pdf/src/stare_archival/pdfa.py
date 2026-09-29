"""PDF/A-3b pieces: the sRGB OutputIntent, the XMP packet, and PDF/XMP date strings.

The XMP is written here in full, not through pikepdf's metadata editor, so that every byte
is a function of the inputs (no editor timestamps) and so that the archive's own properties
(namespace `stare`) can be declared in the PDF/A extension schema that PDF/A requires for any
property outside the predefined schemas.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache
from xml.sax.saxutils import escape

import pikepdf
from PIL import ImageCms

STARE_NS = "https://stare.pub/ns/archival/1.0/"
STARE_PREFIX = "stare"

# (name, value type, description) of each property in the stare namespace
STARE_PROPERTIES = (
    ("volumeId", "Text", "Codex Publicus volume id: reporter slug and volume, as a2d/152"),
    ("barcode", "Text", "Harvard Law School Library barcode of the scanned volume"),
    ("sourceSha256", "Text", "SHA-256 of the CAP volume tar this PDF was built from"),
    ("imageEncoder", "Text", "The tool and version that encoded the page images"),
    ("imageEncoderSettings", "Text", "The page image encoder's settings"),
)

# ICC header date (bytes 24-35): pinned, so the profile doesn't carry the build time
_ICC_DATE = struct.pack(">6H", 2024, 1, 1, 0, 0, 0)


@cache
def srgb_icc_profile() -> bytes:
    """LittleCMS's built-in sRGB profile, with its creation date pinned."""
    icc = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    icc[24:36] = _ICC_DATE
    return bytes(icc)


def add_output_intent(pdf: pikepdf.Pdf) -> None:
    """The PDF/A OutputIntent (GTS_PDFA1) with an embedded sRGB profile."""
    profile = pikepdf.Stream(pdf, srgb_icc_profile())
    profile.N = 3
    pdf.Root.OutputIntents = pikepdf.Array(
        [
            pdf.make_indirect(
                pikepdf.Dictionary(
                    Type=pikepdf.Name.OutputIntent,
                    S=pikepdf.Name.GTS_PDFA1,
                    OutputConditionIdentifier=pikepdf.String("sRGB"),
                    Info=pikepdf.String("sRGB IEC61966-2.1"),
                    DestOutputProfile=pdf.make_indirect(profile),
                )
            )
        ]
    )


def _utc(when: datetime) -> datetime:
    if when.tzinfo is None:
        raise ValueError("dates must be timezone-aware")
    return when.astimezone(UTC).replace(microsecond=0)


def pdf_date(when: datetime) -> str:
    """A PDF date string in UTC, e.g. D:20260929120000Z."""
    return _utc(when).strftime("D:%Y%m%d%H%M%SZ")


def xmp_date(when: datetime) -> str:
    """An XMP (ISO 8601) date in UTC, e.g. 2026-09-29T12:00:00Z."""
    return _utc(when).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class XmpFields:
    title: str
    volume_id: str
    barcode: str
    source_sha256: str
    image_encoder: str
    image_encoder_settings: str
    producer: str
    creator_tool: str
    created: datetime


def xmp_packet(f: XmpFields) -> bytes:
    """The document's XMP: PDF/A-3b identification, Dublin Core, dates, producer, and the
    archive's own properties with their PDF/A extension schema declaration."""
    date = xmp_date(f.created)
    stare_values = {
        "volumeId": f.volume_id,
        "barcode": f.barcode,
        "sourceSha256": f.source_sha256,
        "imageEncoder": f.image_encoder,
        "imageEncoderSettings": f.image_encoder_settings,
    }
    stare_xml = "".join(
        f"   <{STARE_PREFIX}:{name}>{escape(stare_values[name])}</{STARE_PREFIX}:{name}>\n"
        for name, _type, _desc in STARE_PROPERTIES
    )
    property_decls = "".join(
        '        <rdf:li rdf:parseType="Resource">\n'
        f"         <pdfaProperty:name>{name}</pdfaProperty:name>\n"
        f"         <pdfaProperty:valueType>{value_type}</pdfaProperty:valueType>\n"
        "         <pdfaProperty:category>external</pdfaProperty:category>\n"
        f"         <pdfaProperty:description>{escape(desc)}</pdfaProperty:description>\n"
        "        </rdf:li>\n"
        for name, value_type, desc in STARE_PROPERTIES
    )
    xml = (
        '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"\n'
        '    xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
        '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
        '    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"\n'
        f'    xmlns:{STARE_PREFIX}="{STARE_NS}">\n'
        "   <pdfaid:part>3</pdfaid:part>\n"
        "   <pdfaid:conformance>B</pdfaid:conformance>\n"
        "   <dc:format>application/pdf</dc:format>\n"
        "   <dc:title><rdf:Alt>"
        f'<rdf:li xml:lang="x-default">{escape(f.title)}</rdf:li>'
        "</rdf:Alt></dc:title>\n"
        f"   <dc:source>{escape(f.volume_id)}</dc:source>\n"
        f"   <xmp:CreateDate>{date}</xmp:CreateDate>\n"
        f"   <xmp:ModifyDate>{date}</xmp:ModifyDate>\n"
        f"   <xmp:MetadataDate>{date}</xmp:MetadataDate>\n"
        f"   <xmp:CreatorTool>{escape(f.creator_tool)}</xmp:CreatorTool>\n"
        f"   <pdf:Producer>{escape(f.producer)}</pdf:Producer>\n"
        f"{stare_xml}"
        "  </rdf:Description>\n"
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"\n'
        '    xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"\n'
        '    xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">\n'
        "   <pdfaExtension:schemas>\n"
        "    <rdf:Bag>\n"
        '     <rdf:li rdf:parseType="Resource">\n'
        "      <pdfaSchema:schema>Codex Publicus archival PDF</pdfaSchema:schema>\n"
        f"      <pdfaSchema:namespaceURI>{STARE_NS}</pdfaSchema:namespaceURI>\n"
        f"      <pdfaSchema:prefix>{STARE_PREFIX}</pdfaSchema:prefix>\n"
        "      <pdfaSchema:property>\n"
        "       <rdf:Seq>\n"
        f"{property_decls}"
        "       </rdf:Seq>\n"
        "      </pdfaSchema:property>\n"
        "     </rdf:li>\n"
        "    </rdf:Bag>\n"
        "   </pdfaExtension:schemas>\n"
        "  </rdf:Description>\n"
        " </rdf:RDF>\n"
        "</x:xmpmeta>\n"
        '<?xpacket end="w"?>'
    )
    return xml.encode("utf-8")


def add_metadata(pdf: pikepdf.Pdf, fields: XmpFields) -> None:
    """Set the XMP metadata stream and a document info dictionary that agrees with it."""
    metadata = pikepdf.Stream(pdf, xmp_packet(fields))
    metadata.Type = pikepdf.Name.Metadata
    metadata.Subtype = pikepdf.Name.XML
    pdf.Root.Metadata = pdf.make_indirect(metadata)
    date = pdf_date(fields.created)
    pdf.trailer.Info = pdf.make_indirect(
        pikepdf.Dictionary(
            Title=pikepdf.String(fields.title),
            Producer=pikepdf.String(fields.producer),
            Creator=pikepdf.String(fields.creator_tool),
            CreationDate=pikepdf.String(date),
            ModDate=pikepdf.String(date),
        )
    )
