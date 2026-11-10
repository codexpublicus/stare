# Host your own copy of stare.pub

This kit serves a copy of [stare.pub](https://stare.pub) from your own machine. The copy is
static files: the reader runs in each visitor's browser, so the server only hands out files.
A Raspberry Pi with a USB SSD is plenty. The copy presents itself as "A mirror of stare.pub",
with its release and the date of its data, and links to stare.pub for anything it doesn't
hold.

A copy is one of four tiers. Tier 1 (citation lookup, the brief checker, the `/k/` and `/c/`
addresses) is what stare.pub publishes today, about 0.46 GB as one tar. Tiers 2 to 4 (case
text and full-text search, the archival page PDFs, the raw CAP archive) follow.

## What you need

- A machine that stays on. For tier 1, a Raspberry Pi 4 or 5 with Raspberry Pi OS Lite and an
  SSD over USB, or any Linux box.
- Disk: a 32 GB SD card or any USB stick holds tier 1; a 128 GB SSD holds tier 2; a 2 TB SSD
  holds tier 3; tier 4 (about 12 TB) needs a disk array. Use ext4, or another filesystem that handles a
  million small files well. exFAT struggles with tier 2's 860,000 CourtListener records.
- Docker with the compose plugin, or a web server you already run: Caddy, nginx or Apache.
- `minisign` and `sha256sum` to check what you download (`apt install minisign`).

## Layout

The tier 1 tar extracts into a directory, the copy's root:

```
<root>/
  site -> site.v2026.11.05.1/   the site build; a symlink, so a new site swaps in at once
  site.v2026.11.05.1/
  kit/                          this directory
  mirror/
    mirror.json                 what this copy holds (below)
    idx/                        idx.stare.pub's files: the citation index
    data/                       data.stare.pub's files: the key ledger, the PDF list
    releases/                   the release's signed list and per-component manifests
```

The server maps `/` to `site/`, `/mirror/` to `mirror/`, and `/robots.txt` to
`kit/robots.txt`. Nothing else in the root is served.

## Install

Every release is under `https://data.stare.pub/releases/`. `latest.json` names the newest
one; its files are in `releases/<release>/`.

```sh
mkdir -p /srv/stare && cd /srv/stare
curl -fsSLO https://data.stare.pub/releases/latest.json
curl -fsSLO https://data.stare.pub/releases/latest.json.minisig
minisign -Vm latest.json -P RWRuuIWL1hnu8l81OQ/pyqka6QPtVyiesfn6wIr4CtHdhnBChGViuSa0
release=v2026.11.10   # the release latest.json names
curl -fsSLO https://data.stare.pub/releases/$release/release.json
curl -fsSLO https://data.stare.pub/releases/$release/release.json.minisig
curl -fsSLO https://data.stare.pub/releases/$release/stare-tier1-$release.tar
```

Check it (next section), then extract it into the root:

```sh
tar -xf stare-tier1-$release.tar -C /srv/stare
```

Then serve it, with Docker:

```sh
cd /srv/stare/kit && docker compose up -d
```

The copy is then at `http://<your machine>:8080/`. `STARE_PORT=80 docker compose up -d` (or
`STARE_PORT=80` in a `.env` file beside `compose.yaml`) puts it on another port.
`compose.yaml` runs the official `caddy:2` image with `Caddyfile`, and mounts the root
read-only.

Or with a web server you already run:

- Caddy: `Caddyfile`, with `STARE_ROOT` set to the root (or the default path edited).
- nginx: `nginx.conf` into `conf.d/`, with `/srv/stare` and the port replaced.
- Apache 2.4: `apache-vhost.conf`, which includes `apache.htaccess` into the root's
  `<Directory>`. Where only `.htaccess` files are allowed, copy `apache.htaccess` to
  `<root>/.htaccess`; the root must be the document root. If your Apache configuration has
  `AddEncoding x-gzip .gz` (some packages ship it), remove it: it makes browsers unpack the
  index files before the reader sees them. `apache.htaccess` undoes it for the copy too.

## Upgrade

The same steps with the new release: download, check, extract over the root, which replaces
the pointer files (`mirror.json`, the manifests, the `site` symlink) and adds the new
version's files beside the old ones. The server needs no restart. Old versions' directories
(`site.<old>/`, `mirror/idx/v/<old>/`) can be deleted once nothing uses them.

A `sync` service in `compose.yaml`, running `stare mirror sync` from the stare CLI on a
timer, comes with the CLI's mirror commands.

## Verify by hand

Each release's `release.json` is signed with stare.pub's release key. Everything else is
pinned by its SHA-256 in `release.json`: the tier 1 tar, and each component's `SHA256SUMS`,
which lists every file in the component.

1. Check the signature:

   ```sh
   minisign -Vm release.json -P RWRuuIWL1hnu8l81OQ/pyqka6QPtVyiesfn6wIr4CtHdhnBChGViuSa0
   ```

2. Check the tar against the SHA-256 that `release.json` gives for it:

   ```sh
   sha256sum stare-tier1-$release.tar
   ```

3. Extract it, then check every file from the root against its component's list:

   ```sh
   cd /srv/stare
   for sums in mirror/releases/components/*/*/SHA256SUMS; do sha256sum -c --quiet "$sums"; done
   ```

   Each `SHA256SUMS` is pinned in `release.json` too; compare its hash with
   `sha256sum mirror/releases/components/*/*/SHA256SUMS` before trusting what it lists.

The keys, also published at `https://stare.pub/.well-known/stare-release-key.pub` and
`https://stare.pub/.well-known/stare-recovery-key.pub`:

Release key (ID F2EE19D68B85B86E), which signs every release:

```
untrusted comment: minisign public key F2EE19D68B85B86E
RWRuuIWL1hnu8l81OQ/pyqka6QPtVyiesfn6wIr4CtHdhnBChGViuSa0
```

Recovery key (ID 6882DE6FA53FD7D1), kept offline and used only to sign a change of release
key:

```
untrusted comment: minisign public key 6882DE6FA53FD7D1
RWTR1z+lb96CaCdVkipBJO+O6KJyVIZkYQz2syiFItetSW+S74fWeKrF
```

A key change is published under `releases/keys/`, signed by the old key or by the recovery
key. If the key on this page ever differs from the one at stare.pub, trust neither until
you know why.

Signing protects people who download a copy. Someone browsing your copy is trusting you, as
with any website, and the banner on your copy doesn't claim otherwise.

## What the server does

`Caddyfile`, `nginx.conf` and `apache.htaccess` implement the same six rules, and
`scripts/mirror-kit/servers.test.mjs` in the stare repository checks each against the real
server:

1. Real files win.
2. A browser navigation (`Sec-Fetch-Mode: navigate`) to a path no file matches gets
   `/index.html` with a 200, which is how `/k/<key>/` and `/c/...` addresses open in the
   reader. Any other request for a missing path gets a 404, so crawlers and scripts see
   what's really there.
3. `/mirror/` never falls back. A missing data file is a 404; the reader would otherwise try
   to read the reader's own page as an index file.
4. Range requests work, and nothing under `/mirror/` is compressed on the fly.
5. `.gz` files are `application/gzip` with no `Content-Encoding`; the reader unpacks them
   itself. JSON and text are `charset=utf-8`.
6. Files whose names change with their content (`/_astro/`, the hashed WASM, `/vendor/pdfjs-*`,
   `/vendor/stare-search-*`, `/data/citare/`) and immutable data (`/mirror/idx/v/`,
   `/mirror/data/crk/ledger/s/`, `/mirror/data/cl/c/`, the PDFs) are cached for a year;
   everything else is `max-age=0, must-revalidate`. They also send the two security headers
   stare.pub sends.

`robots.txt` asks search engines not to index the copy, so that searches lead to stare.pub.
Keep it unless you want your copy indexed. On a copy, the reader also points each page's
canonical link at stare.pub.

## mirror.json

`mirror/mirror.json` says what the copy holds. The reader reads it on any host other than
stare.pub's; if it's there and is a `stare-mirror` file, the reader reads the index and data
from `/mirror/idx` and `/mirror/data`, shows the banner, and says in place what the copy
doesn't have ("Text not in this copy", "Pages not in this copy", search needing tier 2), with
a link to the same page on stare.pub. It never fetches anything from stare.pub. Without the
file, the reader reads stare.pub's hosts, as on any other site serving the build.

The release writes it. If you assemble a copy yourself, write it by hand:

```json
{
  "format": "stare-mirror",
  "format_version": "1.0.0",
  "upstream": "https://stare.pub",
  "release": "v2026.11.10",
  "data_date": "2026-11-08",
  "tiers": [1],
  "components": {
    "site": { "version": "v2026.11.05.1" },
    "index": { "version": "v2026.11.05.3" },
    "crk": { "version": "v2026.11.08" },
    "pdf-manifest": { "version": "2026-11-01" },
    "kit": { "version": "v2026.11.05.1" }
  }
}
```

- `format` is `stare-mirror`, and `format_version` is SemVer; the reader accepts any 1.x.
- `upstream` is always `https://stare.pub`.
- `release` is the mirror release (CalVer), and `data_date` the date of the copy's newest
  data, which the banner shows.
- `tiers` lists the tiers held in full.
- `components` lists each component present by id, with its version. Tier 1 is `site`,
  `index`, `crk`, `pdf-manifest` and `kit`. The ids that turn on a feature are `cap` or `cl`
  (case text), `search` (full-text search), any id starting `pdf/` (the archival PDFs, per
  reporter) and any starting `cap-raw/` (CAP's raw scans, per reporter, which the Raw Scans
  view then reads from `/mirror/data/cap/`).

The schema is [`schemas/mirror.v1.schema.json`](https://stare.pub/schemas/mirror.v1.schema.json).
