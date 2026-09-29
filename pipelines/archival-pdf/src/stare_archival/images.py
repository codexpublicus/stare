"""The container images the pipeline's external tools come from, pinned by digest.

This module is the one place the pins live: the code runs these references, and CI pulls
whatever `python -m stare_archival.images` prints (one image per line).
"""

# jbig2enc 0.28 (the tag is kept for readability; the digest is what Docker resolves)
PINNED_JBIG2_IMAGE = (
    "jbarlow83/ocrmypdf:v16.10.4"
    "@sha256:60908d9f007a6f621769f6ecabdbc04e39845b5ca5342debaad504bc8efe050b"
)
# veraPDF 1.30.2, the version that validated the spike's PDF/A-3b build
PINNED_VERAPDF_IMAGE = (
    "verapdf/cli:v1.30.2@sha256:d5ee329657cf9bc4b2400392dd54c7d0a0ce9980ff6fa2da5590eebeec007cdb"
)
PINNED_IMAGES = (PINNED_JBIG2_IMAGE, PINNED_VERAPDF_IMAGE)

if __name__ == "__main__":
    print("\n".join(PINNED_IMAGES))
