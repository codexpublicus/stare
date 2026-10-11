# The CourtListener pipeline (codexpublicus/stare#83, #84): stare-cl with lbzip2, which
# decompresses the 55 GB opinions table on every core. Base images are pinned by digest,
# and apt installs lbzip2 at an exact version from a fixed Debian archive snapshot.
#
# Build: mise run cl-build builds it on the target host from a git ref (tags
# stare-cl:<short sha> and stare-cl:local) and runs the pipeline in it; it is never pushed
# to a registry. The entrypoint is stare-cl; run the container with --init.

ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.21@sha256:15f68a476b768083505fe1dbfcc998344d0135f0ca1b8465c4760b323904f05a
# Python 3.13.16 on Debian 13 (trixie)
ARG BASE_IMAGE=python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f

FROM ${UV_IMAGE} AS uv

FROM ${BASE_IMAGE}

ARG APT_SNAPSHOT=20260928T000000Z
ARG LBZIP2_VERSION=2.5-4
# COMMIT: the repository commit the image was built from, for provenance.
ARG COMMIT=unknown

LABEL org.opencontainers.image.title="stare-cl" \
      org.opencontainers.image.description="CourtListener bulk export to per-case records" \
      org.opencontainers.image.source="https://github.com/codexpublicus/stare" \
      org.opencontainers.image.revision="${COMMIT}"

# a snapshot's suite Release files expire a week after they were signed, so their
# Valid-Until is not checked (the signatures still are)
RUN printf 'APT::Snapshot "%s";\nAcquire::Check-Valid-Until "false";\n' "${APT_SNAPSHOT}" \
        > /etc/apt/apt.conf.d/50snapshot \
    && apt-get update -q \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
        lbzip2="${LBZIP2_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON=/usr/local/bin/python3.13 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/stare-cl/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1

WORKDIR /opt/stare-cl/src
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv sync --locked --no-dev --no-editable \
    && lbzip2 --version 2>&1 | head -1 \
    && /opt/stare-cl/venv/bin/stare-cl --version

# uid/gid 1000 owns the NAS datasets; nothing writes to $HOME or site-packages at runtime,
# so any --user works too.
RUN groupadd --gid 1000 stare \
    && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/stare stare
ENV PATH=/opt/stare-cl/venv/bin:${PATH} \
    PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["stare-cl"]
CMD ["--help"]
