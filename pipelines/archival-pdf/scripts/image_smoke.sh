#!/usr/bin/env bash
# Build the fixture volume inside the pipeline image with its native jbig2, twice: the first
# run must build and pass it, the second must skip it as done. Usage: image_smoke.sh [image]
set -euo pipefail

image="${1:-stare-archival:local}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

run() {
  docker run --rm --init --network=none --user "$(id -u):$(id -g)" \
    -e STARE_ARCHIVAL_IMAGE="$(docker image inspect --format '{{.Id}}' "$image")" \
    -v "$here/tests/fixtures/a2d-152:/mirror/a2d:ro" -v "$out:/out" \
    "$image" build-all --src /mirror --out /out --jobs 2
}

run | tee "$out/first.txt"
grep -q "selected 1: pass 1," "$out/first.txt"
manifest="$out/cap-pdf/_manifests/a2d/152.json"
grep -q '"status": "pass"' "$manifest"
grep -q '"name": "jbig2enc 0.28"' "$manifest"
grep -q '"pipeline": "sha256:' "$manifest"
test -s "$out/cap-pdf/a2d/152.pdf"
run | tee "$out/second.txt"
grep -q "selected 1: pass 0, uploaded 0, skipped 1," "$out/second.txt"
echo "image smoke test passed: $image"
