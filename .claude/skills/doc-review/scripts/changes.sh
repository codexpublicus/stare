#!/usr/bin/env bash
# What changed since the last doc review, and the live state the docs describe.
# Usage: changes.sh [<base-ref>]
# Base: the argument, else the commit in docs/.reviewed-at, else the last site release tag.
# Reads git, GitHub and the public static files; writes nothing.
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
repo=codexpublicus/stare
main=${MAIN_REF:-origin/main}
site=https://stare.pub
preview=https://main-stare-pub.nick-441.workers.dev
idx=https://idx.stare.pub
ghx() { env -u GITHUB_TOKEN -u GH_TOKEN gh "$@"; }
g() { git -C "$root" "$@"; }

if [ $# -ge 1 ]; then base=$1 why=argument
elif [ -s "$root/docs/.reviewed-at" ]; then
  base=$(grep -v '^#' "$root/docs/.reviewed-at" | awk 'NF{print $1; exit}') why=docs/.reviewed-at
else base=$(g describe --tags --abbrev=0 --match 'v[0-9]*' "$main") why="last site release tag"
fi
base_sha=$(g rev-parse "$base^{commit}")

echo "# Base: $base ($why): $(g log -1 --format='%h %cs %s' "$base_sha")"
echo "# $main: $(g log -1 --format='%h %cs %s' "$main")"
echo
echo "## Commits on $main since the base (first parent; (#N) is the PR)"
g log --first-parent --format='%h %cs %s' "$base_sha..$main"
echo
echo "## Site releases since the base, with their notes"
for t in $(g tag --contains "$base_sha" --list 'v[0-9]*' --sort=creatordate); do
  [ "$(g rev-parse "$t^{commit}")" = "$base_sha" ] && continue
  echo "### $t ($(g log -1 --format=%h "$t"))"
  ghx release view "$t" -R "$repo" --json body -q .body || true
done
echo
echo "## Open PRs (not shipped: don't describe them as live)"
ghx pr list -R "$repo" --state open --limit 50 --json number,title -q '.[]|"#\(.number) \(.title)"'
echo
echo "## Live index ($idx)"
curl -fsS "$idx/manifest.json" | jq -r '"version \(.version), generated_at \(.generated_at), format \(.format), idx \(.idx // "absent"), base \(.base), volumes \(.volumes), entries \(.entries), reporters \(.reporters|length), aliases \(.aliases // [] | length)"'
echo "Published builds (reports/index.json): version and totals"
curl -fsS "$idx/reports/index.json" | jq -c '.reports[]|{version,generated_at,totals}'
echo
echo "## data.stare.pub (HEAD of a sample zip and robots.txt)"
for u in https://data.stare.pub/cap/a2d/31.zip https://data.stare.pub/robots.txt; do
  echo "$u $(curl -s -o /dev/null -I -w '%{http_code} %{content_type}' "$u")"
done
echo
echo "## Site: production ($site) and the main preview ($preview)"
prod=$(curl -fsS "$site/" | grep -o 'v20[0-9][0-9]\.[0-9][0-9]\.[0-9][0-9]\.[0-9]*' | head -1 || true)
echo "production release: ${prod:-unknown}"
for tag in ${prod:+$prod} "$main"; do
  echo "citare-core at $tag: $(g show "$tag:Cargo.lock" | awk '/^name = "citare-core"/{getline; print $3}' | tr -d '"')"
done
for host in "$site" "$preview"; do
  echo "### $host"
  echo "wasm: $(curl -fsS "$host/wasm/stare_wasm_bg.json" 2>/dev/null | jq -c . || echo missing)"
  for p in llms.txt robots.txt sitemap.xml reporters.json openapi.json schemas/reporters.v1.schema.json; do
    echo "$p $(curl -s -o /dev/null -w '%{http_code}' "$host/$p")"
  done
  curl -fsS "$host/reporters.json" 2>/dev/null | jq -c '{format,license:.license.id,generated_from,reporters:(.reporters|length)}' || true
  curl -fsS "$host/openapi.json" 2>/dev/null | jq -c '{openapi,version:.info.version,license:.info.license.name,paths:(.paths|keys)}' || true
done
