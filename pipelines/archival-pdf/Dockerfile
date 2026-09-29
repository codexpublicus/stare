# The archival PDF pipeline (codexpublicus/stare#51): stare-archival with a native jbig2,
# poppler-utils and rclone. Every base image is pinned by digest, and apt installs poppler,
# leptonica and Python at exact versions from a fixed Ubuntu archive snapshot.
#
# Build: mise run archival-image (tags stare-archival:<git sha> and stare-archival:local).
# Run: see RUNBOOK.md. The entrypoint is stare-archival; run the container with --init.

# jbig2enc 0.28, the same binary as the image the tests and CI run (stare_archival.images)
ARG JBIG2_IMAGE=jbarlow83/ocrmypdf:v16.10.4@sha256:60908d9f007a6f621769f6ecabdbc04e39845b5ca5342debaad504bc8efe050b
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.21@sha256:15f68a476b768083505fe1dbfcc998344d0135f0ca1b8465c4760b323904f05a
ARG RCLONE_IMAGE=rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5
# Ubuntu 24.04, the release the ocrmypdf image is built on, so its jbig2 finds the same
# leptonica (liblept5 1.82.0-3build4) here
ARG BASE_IMAGE=ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

FROM ${JBIG2_IMAGE} AS jbig2
FROM ${UV_IMAGE} AS uv
FROM ${RCLONE_IMAGE} AS rclone

FROM ${BASE_IMAGE}

ARG APT_SNAPSHOT=20260928T000000Z
ARG POPPLER_VERSION=24.02.0-1ubuntu9.9
ARG LEPTONICA_VERSION=1.82.0-3build4
ARG PYTHON_VERSION=3.12.3-1ubuntu0.17
ARG CA_CERTIFICATES_VERSION=20260601~24.04.1
# REVISION: the git tree hash of pipelines/archival-pdf (`git rev-parse <commit>:pipelines/
# archival-pdf`), the resume key, so only a change to the pipeline itself rebuilds volumes.
# COMMIT: the repository commit, for provenance only.
ARG REVISION
ARG COMMIT=unknown

RUN test -n "${REVISION}" && test "${REVISION}" != unknown \
    || { echo "build with --build-arg REVISION=\$(git rev-parse HEAD:pipelines/archival-pdf)" >&2; exit 1; }

LABEL org.opencontainers.image.title="stare-archival" \
      org.opencontainers.image.description="Archival per-volume CAP PDFs: build, verify, upload" \
      org.opencontainers.image.source="https://github.com/codexpublicus/stare" \
      org.opencontainers.image.revision="${COMMIT}" \
      pub.stare.archival.pipeline-tree="${REVISION}"

# the snapshot service is HTTPS only, so a CA bundle comes first, from the live archive
# (apt still checks every index against the archive's signing keys); the snapshot's pinned
# version then replaces it
RUN apt-get update -q \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
        ca-certificates \
    && echo "APT::Snapshot \"${APT_SNAPSHOT}\";" > /etc/apt/apt.conf.d/50snapshot \
    && apt-get update -q \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
        --allow-downgrades \
        ca-certificates="${CA_CERTIFICATES_VERSION}" \
        liblept5="${LEPTONICA_VERSION}" \
        poppler-utils="${POPPLER_VERSION}" \
        python3.12="${PYTHON_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

COPY --from=jbig2 /usr/local/bin/jbig2 /usr/local/bin/jbig2
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone

ENV UV_PYTHON=/usr/bin/python3.12 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/stare-archival/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1

WORKDIR /opt/stare-archival/src
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv sync --locked --no-dev --no-editable \
    && jbig2 --version && pdfimages -v && rclone version \
    && /opt/stare-archival/venv/bin/stare-archival --version

# uid/gid 1000 owns the NAS datasets (codexpublicus-derived and friends); the base image's
# own uid 1000 user ("ubuntu") gives way to it. Nothing writes to $HOME, a cache or
# site-packages at runtime (bytecode is compiled at build time), so any --user works too.
RUN userdel --remove ubuntu \
    && groupadd --gid 1000 archival \
    && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/archival archival
ENV PATH=/opt/stare-archival/venv/bin:${PATH} \
    PYTHONDONTWRITEBYTECODE=1 \
    STARE_ARCHIVAL_REVISION=${REVISION}
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["stare-archival"]
CMD ["--help"]
