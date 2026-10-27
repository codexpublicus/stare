# A local MCP server and CLI over stare.pub's static data: design

_2026-10-27. For [stare#162](https://github.com/codexpublicus/stare/issues/162). Draft for the owner's review; nothing here is built yet._

## Goal

An agent that writes or reviews legal text can ask, on the user's own machine, whether a cited
case exists, read it, and check that it says what the text claims. The tool is `stare mcp`, a
stdio MCP server in the `stare` binary, reading only the static files stare.pub already
publishes (`idx.stare.pub`, `data.stare.pub`) or a local mirror of them, with an on-disk cache.
No server of ours is in the loop, which is the owner's rule from
[stare#161](https://github.com/codexpublicus/stare/issues/161) (2026-10-17) and the
constraint restated on 2026-10-27: R2 reads are fine, Worker invocations are not, and a hosted
copy is a later option with its costs stated below.

Done for the first milestone (M1) means:

- `stare mcp` speaks MCP over stdio and registers with any client that launches stdio servers.
- Five tools: `find_citations_in_text`, `resolve_citation`, `get_case`, `check_brief` and
  `index_info`, with the inputs and outputs specified below.
- Every answer names the index version it came from and carries the licence and credit of each
  source it used.
- The same input gives the same answer from `stare check --json`, from `check_brief`, and (for
  the shared fixtures) from the site.
- Linux binaries (x86_64 and aarch64) attached to a release, and a skill document telling an
  agent when and how to use the tools.

## What exists today

The CLI already does most of the work, against the same hosts and a mirror:

- `stare resolve <citation>` (a citation as written, `31 A.2d 647`, or the slug form
  `a2d 31 647`, or a labelled page such as `cai-cas 1 xxix`) prints one case.
- `stare list <slug> <volume>` lists a volume's cases.
- `stare check <file|->` is the brief checker: citare finds every citation, each is looked up,
  parallel runs are reconciled (`stare::parallel::reconcile`), shared pages are settled by case
  name (`stare::byname`), and cited cases are grouped (`stare::cited::group`). `--json` gives
  per citation `raw`, `type`, `reporter`, `slug`, `volume`, `page`, `pin`, `antecedent`,
  `status` (`found`, `found_alias`, `found_partner`, `external`, `statute`, `held_miss`,
  `not_held`, `no_antecedent`, `unchecked`), `case`, `via`, `partner`, `by_name`, `conflicts`,
  `needs_review`, `external_url`, `case_links`, `group` and `count`.
- `stare download --reporters a2d,a3d` fills a local mirror; `--index`/`--data` (or
  `STARE_INDEX`/`STARE_DATA`, or `stare config set`) point at a path or URL.
- The cache is `~/.cache/stare/` (`XDG_CACHE_HOME` respected) with `bins`, `zips` and `tars`
  stores. Index files are cached under their versioned path (`v/<version>/<slug>/<vol>.idx.gz`),
  so a new index build is new keys. The manifest is always fetched, and the cached copy is read
  only when the host is unreachable.

Two things in that code matter for this design. First, the orchestration (`resolve_case`,
`idx_entries`, `resolve_entries`, `check_citations`, `names_pick`, `reconcile_parallels`, the
fetchers) lives in `crates/stare-cli/src/main.rs`, 2,569 lines, not in a library; the
server can't call it until it moves. Second, `fetch_zip` downloads the whole volume zip
(`a2d/31.zip` is 422,856 bytes; CAP's 40,622 zips average about 1.9 MB), while the name
reader already reads single entries by range request through `stare::ziprange`.

The site does the same orchestration a second time in JavaScript (`web/public/js/resolve.js`,
`citations.js`, `idx.js`, `manifest.js`, `cl.js`), calling the WASM for the rules
(`lookup_idx`, `reconcile_parallels`, `group_citations`). Pin pages exist only there:
`web/public/js/pages.js` finds CAP's `<a class="page-label" data-label="1023">` anchors in the
case's HTML (`html/<file>.html` in the zip) and places them in the opinion text by matching the
words that follow. The case JSON's text has no page breaks, and CourtListener records have no
page labels at all.

`crates/stare/src/cite.rs` has `case_links`, the one place link-outs to CourtListener and
Google Scholar are built, written "so the website, the CLI and a later MCP server offer the same
links". `crates/stare/src/license.rs` holds the licences (CC0 1.0, CC BY-NC-ND 4.0, the Public
Domain Mark, reporters-db and courts-db's BSD 2-Clause) and `CaseJson` carries a CourtListener
record's own `license` and `attribution`.

## Data the server reads

All of it is what `llms.txt` and `openapi.json` already describe:

| What | Where | Notes |
|---|---|---|
| Live manifest | `idx.stare.pub/manifest.json` | max-age 60; `version`, `base` (`v/v2026.10.26.2/`), `reporters`, `parts`, `aliases`, `idx`, `license`, `based_on`, `format` (2) |
| A build's own manifest | `idx.stare.pub/v/<version>/manifest.json` | immutable, no `base` |
| Volume index | `idx.stare.pub/<base><slug>/<vol>.idx.gz`, later parts `<vol>.<n>.idx.gz` | `page,source,ref` lines, gzip without Content-Encoding, immutable |
| Build reports | `idx.stare.pub/reports/index.json` | every published version, oldest first |
| CAP case | `data.stare.pub/cap/<slug>/<folder>.zip`, entries `json/<file>.json`, `html/<file>.html`, `metadata/CasesMetadata.json` | Range requests work (`accept-ranges: bytes`) |
| CourtListener record | `data.stare.pub/cl/c/<cluster>/<hash>.json.gz` | immutable; `license`, `attribution`, `source.cl_blocked` |
| Archival PDF | `data.stare.pub/pdf/<jur>/<slug>/<vol>.pdf` and `.json` beside it; `pdf/manifest.json` lists every volume, with `no_scans` | PDF pages are METS ORDERs 1 to N |
| Reporter map | `stare.pub/reporters.json` | not needed by the server, which has citare built in |
| CRK ledger (planned) | `data.stare.pub/crk/ledger/<version>/` shards and `latest.json` | [stare-builder#71](https://github.com/codexpublicus/stare-builder/issues/71) |
| Full-text search (planned) | roaringbuckets files on idx | D143 on [stare#113](https://github.com/codexpublicus/stare/issues/113) |

CORS doesn't apply outside a browser; the binary reads both hosts directly.

## Transport

**stdio is the default and the only M1 transport.** The client launches `stare mcp` as a child
process and talks JSON-RPC over stdin and stdout; logs go to stderr. This is how most MCP
clients run local servers, needs no port, and gives the server exactly one user.

**Local HTTP comes in M2, opt-in:** `stare mcp --http 127.0.0.1:8765` serves the MCP
Streamable HTTP transport for clients that only connect to URLs, or for one server shared by
several local agents. It binds to loopback only (a non-loopback address is refused unless
`--http-allow-remote` is given), checks the `Origin` header as the MCP spec asks against DNS
rebinding, and takes an optional `--token` that clients send as a bearer token. Sessions are
per connection, each with its own pinned index version.

## Language and packaging

**Recommended: a subcommand of the existing Rust `stare` binary**, built on `crates/stare` and
citare, with the official Rust MCP SDK (`rmcp`, pinned exactly) behind a default-on cargo
feature `mcp` so the binary's size with and without it can be measured.

- It reuses the index reader (`stare::idx`), the manifest (`stare::manifest`), zip range reads
  (`stare::ziprange`), the case JSON and CourtListener readers, the parallel, by-name and
  grouping rules, `case_links` and `license.rs` as they are. Nothing in the rules is
  reimplemented.
- One static binary per platform (musl on Linux, rustls already), no runtime to install, and
  the citare data bundle compiled in (`embedded-data`, the CLI's default).
- The CLI and the server share a cache, a config file and `stare download`'s mirror layout.

The alternatives I considered:

- **TypeScript on Node, with stare-wasm.** `npx` makes installing easy, and it could reuse the
  site's JavaScript orchestration (`resolve.js`, `citations.js`) and its pin-page code. It
  needs Node on the user's machine, the WASM loads citare's bundle at start, and it would be a
  third orchestration to keep in step with the CLI's. It also can't be built by a stranger
  while citare is private, the same as the Rust route.
- **Python (FastMCP).** No citare bindings exist; it would call the `stare` binary or the WASM,
  which is the Rust route with an extra layer.
- **A separate `stare-mcp` binary.** Possible with the same code, but two binaries to install
  and version for no gain; `stare mcp` keeps `stare check` and the server one download.

### The refactor this needs

Before the server, the orchestration moves out of `main.rs` into `stare-cli`'s library
(`crates/stare-cli/src/lib.rs` already exists, with `http.rs` and `download.rs`), as
`engine/` modules:

- `engine::Sources`: the index and data locations, the pinned manifest, and a `Fetch` trait
  with an HTTP implementation (reqwest, `http::send_with_retry`, the existing User-Agent and
  per-host request interval), a directory implementation for mirrors, and a test
  implementation over fixture files.
- `engine::resolve`: `resolve_case`, `resolve_label`, `idx_entries`, `resolve_entries`,
  `locate_cap`, returning structs instead of printing.
- `engine::check`: `check_citations` returning a `CheckReport` struct that serializes to
  today's `--json` output field for field.
- `engine::case_text`: range reads of one case's JSON (and HTML, for pin pages) out of a zip.

`main.rs` keeps argument parsing and printing. The CLI's output must not change, and
`stare check --json` on the existing fixtures is the guard: a golden file of today's output is
committed before the move.

The core stays synchronous. The server runs on tokio (rmcp needs it) and calls the engine on
`spawn_blocking` threads. Rewriting the engine async would touch every fetch path for a server
that serves one user, and `crates/stare` is shared with the WASM, which has its own fetch layer
in JavaScript.

## Tools

Conventions for every tool:

- Names are snake_case verbs. Inputs are JSON Schema objects with descriptions written for the
  model; outputs are declared as `outputSchema` and returned as `structuredContent`, with a
  short text rendering in `content` for clients that ignore structured output.
- Each result has a `meta` object: `index_version` (the pinned build, `v2026.10.26.2`),
  `server_version`, `cached` (true when no network request was made), and `sources` (below).
- A miss is a result, not an error. `held_miss` (stare.pub holds the volume and no case starts at
  that page) is the strongest sign of a fabricated citation the data can give, and the agent
  needs it as data. Tool errors (`isError: true`) are for bad input and for data that couldn't
  be read.
- A `case_ref` names one case in the pinned build: `cap:<slug>/<folder>/<file>`
  (`cap:a2d/31/0647-01`) or `cl:<cluster>/<hash>` (`cl:4893133/62f253f296600fb7`). It is
  stable across builds for CAP cases and for CourtListener records (both are immutable
  objects), and `crk:<key>` joins them once the ledger exists.
- `reader_url` is the stare.pub address for a person, built in one function that follows the
  site: `https://stare.pub/#a2d/31/647-01` today, `/c/<jur>/<slug>/<vol>/<page>/` once
  [stare#283](https://github.com/codexpublicus/stare/issues/283) ships, and `/k/<key>/` with
  the ledger.

### `find_citations_in_text` (M1)

Runs citare on a passage and returns what it found, with no network access. It's the cheap
first step and works offline with nothing cached.

Input:

```json
{ "text": "string, required, up to 200,000 characters",
  "types": ["case", "law", "journal", "short"]   // optional filter; default all
}
```

Output, per citation in text order:

```json
{ "citations": [
  { "index": 0, "raw": "128 Neb. 783", "type": "FullCaseCitation",
    "span": { "start": 1042, "end": 1054 },          // character offsets (code points)
    "reporter": "Neb.", "corrected_reporter": null, "slug": "neb",
    "volume": "128", "page": "783", "pin": null, "year": "1935",
    "case_name": "Smith v. Jones", "parallel_of": null,
    "antecedent": null, "history_name": null,
    "law": null, "external_url": null } ],
  "meta": { ... } }
```

The fields are `stare::cite::DetectedCitation`'s, renamed where its names are internal.
citare's spans are UTF-8 byte offsets; the tool converts them to character offsets with
`spans_to_char_offsets`, as stare-wasm does at its boundary, since a model counts neither bytes
nor UTF-16 units reliably and a client in any language can index a string by code point.

### `resolve_citation` (M1)

Looks up one citation. It takes the citation as written, the slug form, or structured parts
(the issue's `resolve_case`), and an optional case name and year from the citing text, which
settle a page several cases start on the way `stare check` does.

Input:

```json
{ "citation": "31 A.2d 647",            // or "a2d 31 647", "1 Cai. Cas. xxix"
  "reporter": "a2d", "volume": "31", "page": "647",   // alternative to `citation`
  "case_name": "string, optional",
  "year": 1943,                         // optional
  "parallel": ["128 Neb. 783"]          // optional: the run's other printings
}
```

Output:

```json
{ "status": "found",          // found | found_alias | found_partner | held_miss | not_held | ambiguous | unparsed
  "citation": { "slug": "a2d", "volume": "31", "page": "647", "reporter": "A.2d" },
  "cases": [
    { "case_ref": "cap:a2d/31/0647-01",
      "name": "...", "name_abbreviation": "...", "decision_date": "1943-06-10",
      "court": "...", "jurisdiction": "...",
      "citations": [ { "type": "official", "cite": "31 A.2d 647" } ],
      "first_page": "647", "last_page": "649",
      "source": "cap",                // cap | courtlistener
      "provenance": null,             // or the label: "Resolved through CourtListener's citation metadata", ...
      "reader_url": "https://stare.pub/#a2d/31/647-01",
      "pdf": { "url": "https://data.stare.pub/pdf/us/a2d/31.pdf#page=12", "pages": [12, 14] } } ],
  "by_name": null,                    // { "among": 3, "note": "Matched by case name among the 3 cases on this page" }
  "case_links": [],                   // CourtListener and Scholar, filled when status is not_held
  "meta": { ... } }
```

`ambiguous` is new to this tool: several cases start at the page and nothing in the input
settles which. All of them are returned in `cases`, in CAP's file order, and the text rendering
says so. The provenance labels are the site's and the CLI's exact strings ("Resolved through
CourtListener's citation metadata", "Resolved as the U.S. Reports under its reporter's name",
"Resolved by the reporter's official page; CAP's scan numbers the case on another page",
"Reported at ..., inferred from the citing text"), and none of them is ever "verified".

### `get_case` (M1, pin pages in M2)

Returns a case's metadata and text, sized for a model's context.

Input:

```json
{ "case_ref": "cap:a2d/31/0647-01",   // or `citation`, resolved first as resolve_citation does
  "parts": ["metadata", "text"],      // default both
  "opinion": 0,                       // optional: one opinion by index; default all
  "find": "string, optional",         // return excerpts around each match instead of the whole text
  "pin": "648",                       // M2: excerpt starting at this printed page
  "pages": { "from": "648", "to": "649" },  // M2: the printed pages' text
  "max_chars": 20000,                 // default 20,000; at most 100,000
  "cursor": "string, optional"        // from a previous call's next_cursor
}
```

Output:

```json
{ "case_ref": "...", "metadata": { ...as in resolve_citation..., "opinions": [ { "type": "majority", "author": "..." } ],
    "courtlistener": { "url": "...", "docket_number": "...", "precedential_status": "...",
                       "blocked_notice": "CourtListener excludes this case from search engines. (inferred: ...)" } },
  "text": "...",                       // whole text, a window of it, or the excerpts
  "excerpts": [ { "opinion": 0, "start": 1200, "end": 1800, "page": "648", "text": "..." } ],
  "page_markers": true,                // M2: text carries [*648] markers where CAP's HTML marks pages
  "truncated": true, "next_cursor": "...", "total_chars": 61234,
  "meta": { ... } }
```

`find` is normalized matching: case, whitespace and curly quotes folded, and a near match
reported as such with its edit distance, since a quotation in a brief often differs from the
opinion by a word. It is how an agent checks a quoted proposition without reading 60,000
characters, and it needs nothing new from the data.

Pin pages (M2) are a Rust port of `pages.js`'s placement: read `html/<file>.html` from the zip
by range request, collect the `page-label` anchors, and place each in the opinion text by the
words that follow it (40 characters, then 16). The port is tested on the same fixtures as
`web/tests/pages.test.js` so the two place markers identically. CourtListener records have no
page labels; `pin` on one returns the whole text with `pin_unavailable: "courtlistener"`.

### `check_brief` (M1)

The brief checker over a whole document: what `stare check --json` returns, plus a summary.
The issue called it `check_text`; I've used the site's name for the feature.

Input:

```json
{ "text": "string, required, up to 500,000 characters",
  "include": ["citations", "cited_cases"],   // default both
  "max_items": 200                           // pagination of citations, with cursor
}
```

Output:

```json
{ "summary": { "cited_cases": 14, "resolvable": 12, "found": 11, "held_miss": 1,
               "not_held": 2, "needs_review": 1, "statutes": 3,
               "line": "14 cited cases found (12 resolvable), 3 statutes" },
  "citations": [ { ...stare check --json's fields..., "case_ref": "...", "reader_url": "..." } ],
  "cited_cases": [ { "group": 0, "case_ref": "...", "name": "...", "status": "found",
                     "forms": [ { "text": "128 Neb. 783, 260 N.W. 287", "count": 3 } ],
                     "also_cited_as": { "id": 2, "supra": 0, "short": 1 } } ],
  "next_cursor": null, "meta": { ... } }
```

The JSON per citation is `CheckReport`'s serialization, the same struct the CLI prints, so the
parity test is a byte comparison after dropping `meta`, `case_ref` and `reader_url`.

### `index_info` (M1)

What the server is reading and under which terms.

Input: `{ "refresh": false }`. With `refresh: true` the session moves to the live build.

Output: `index_version`, `pinned_at`, `live_version` (when the host was reachable),
`source` (`https://idx.stare.pub`, a mirror path, or `offline`), `based_on`, `licenses` (below),
counts from the manifest (`volumes`, `entries`, slugs held), and `cache` (location, bytes per
store).

### `list_cited_cases` (M2)

The case reader's sidebar for one case: the citations in that case's own opinions, grouped and
resolved. Input `{ "case_ref": "...", "max_items": 200, "cursor": null }`; output the
`cited_cases` and `summary` of `check_brief` run on the case's text. An agent following
authority uses it to go one hop down without pasting the text back in.

### `list_volume` (M2)

`stare list` as a tool: `{ "slug": "a2d", "volume": "31" }` returns every case in the volume
with `first_page`, `last_page`, `name_abbreviation`, `decision_date` and `case_ref`, from
`metadata/CasesMetadata.json` read by range request, plus the `cl` lines in the volume's
index. Paginated at 200.

### `get_page_scan` (M2)

The archival PDF for a case or a page, as links: `{ "case_ref": "...", "page": "648" }` returns
the PDF's URL with `#page=<order>`, the page orders the case spans, its printed label, the PDF's
size and SHA-256 from its `.json` manifest, and `no_scans: true` for the 658 volumes CAP
published without them and for every CourtListener record. A model can't read a page image
through most clients, and the PDF's OCR text layer is what the case text already is, so M2
returns links only. Returning one page's text from the PDF's text layer by range request (the
way the site's viewer reads it) is possible later with a PDF reader such as `lopdf`; I've left
it out until someone needs it.

### `lookup_key` (M3, after the ledger)

`{ "key": "<CRK key>" }` follows the ledger's `replaced-by` chain to the current key and returns
the decision with its CAP `case_ref` and CourtListener id, its status (provisional keys say so,
as the reader's notice does), and `reader_url` `/k/<key>/`. Every other tool adds `crk_key` to
its cases once the ledger is published. It waits on
[stare-builder#71](https://github.com/codexpublicus/stare-builder/issues/71) for the shard
format; the server reads the same one or two small shard files the reader will
([stare#283](https://github.com/codexpublicus/stare/issues/283)).

### `search_cases` (M4, after full-text search ships)

Full-text and faceted search over the roaringbuckets files D143 approved, read by multi-range
requests the way the site's client will:
`{ "query": "...", "court": "...", "jurisdiction": "...", "year_from": 1950, "year_to": 1990, "limit": 20, "cursor": null }`
returns result cards (name, citation, court, date, `case_ref`). The search decision id stays
internal, as D143 (3) requires; results carry case refs and reader URLs. It can't be specified
further until roaringbuckets [#7](https://github.com/lokkju/roaringbuckets/issues/7),
[#49](https://github.com/lokkju/roaringbuckets/issues/49) and
[#50](https://github.com/lokkju/roaringbuckets/issues/50) land and the build exists. Until
then, the tool is not registered, and no agent is offered a search that can't run.

### Statutes and regulations

Citations to them come back as citare reads them, with the link to their text where citare has
one (`external`) and `statute` otherwise. Checking a statute as of a date
([stare#174](https://github.com/codexpublicus/stare/issues/174)) is out of scope here.

## Resources and prompts

Tools carry everything, since client support for resources and prompts is uneven. Where a
client supports them, M2 adds:

- Resource `stare://index` (the pinned manifest's summary, as `index_info`) and
  `stare://licenses` (the licence text below, for a client to attach once).
- Resource template `stare://case/{case_ref}`: the case as Markdown, metadata block then text,
  for clients that let a user attach a case to a conversation.
- Prompt `check-citations`: takes a draft and asks the model to run `check_brief`, read each
  found case at its pin with `get_case`, and report misses, unverified citations and
  mismatched propositions in a fixed table.

## Response sizing

Case text is the problem: a long opinion runs past 100,000 characters, and some clients
truncate or refuse tool results past roughly 25,000 tokens.

- `get_case` returns at most `max_chars` (default 20,000, about 5,000 tokens; ceiling 100,000)
  and a `next_cursor`. Cuts fall at paragraph ends where one is within 10% of the limit.
- `find` and `pin` return excerpts instead of the text: 600 characters around each match by
  default (`context_chars`, up to 4,000), at most 10 matches, each with its opinion, offsets
  and (with page markers) printed page.
- `check_brief` and `list_cited_cases` return the summary, then the citations and cited cases
  200 at a time. Case text is never included in them, only metadata and refs.
- Cursors are opaque base64 of `(case_ref or input hash, offset, index_version)`. A cursor from
  another index version is refused with `stale_cursor`, never silently applied to different data.
- Every text rendering starts with the counts ("showing characters 0 to 20,000 of 61,234") so a
  model that reads only `content` knows there is more.

## Caching, mirrors and offline use

- **One cache with the CLI**, `~/.cache/stare/`. The server adds no store; case JSON and HTML
  entries read by range are cached under `zips/<slug>/<folder>/<entry>` beside whole zips, and
  a whole zip in the cache (from `stare resolve` or `stare download`) is read in place of a
  range request.
- **Immutable things are kept forever**: anything under `v/<version>/`, zip entries, records,
  PDF manifests. Only the root manifest is refetched, at session start and on
  `index_info(refresh)`.
- **A size cap**, new in M2: `cache.max_bytes` in the config (default 2 GiB) with
  least-recently-used eviction of zips and entries, never of a mirror and never of the
  pinned build's index files. The CLI has no cap today, and a long agent session reading cases
  across many volumes grows the cache faster than a person does.
- **Mirror mode** is the CLI's: `--index` and `--data` (or the config) name directories laid
  out as the hosts are, which is what `stare download` writes and what a
  [stare#231](https://github.com/codexpublicus/stare/issues/231) copy holds. A tier-1 copy
  (index only) answers `resolve_citation` and `check_brief`; `get_case` then says the text isn't
  in the copy and gives the public URL, as [stare#231](https://github.com/codexpublicus/stare/issues/231)'s "Offline behaviour" asks.
- **`--offline`** makes no network requests at all: the cache and mirror answer or the tool
  says `offline_miss` with the URL it would have fetched.
- **Concurrency**: requests to one host are limited to the existing per-host interval
  (`http::request_interval`), and identical in-flight fetches are shared, so a brief with 80
  citations into 30 volumes makes 30 index requests.

## Versioning against the live index

- **Pinned per session.** At start the server reads `manifest.json`, takes `version` and
  `base`, and reads that build's own `v/<version>/manifest.json` for the rest of the session.
  Every response's `meta.index_version` names it. A build that goes live mid-session doesn't
  change answers under the agent; `index_info(refresh: true)` moves to it explicitly, and
  cursors from before the move are refused.
- **Explicit pin**: `stare mcp --index-version v2026.10.22` reads that build, for reproducing a
  report. Published versions are listed in `reports/index.json`.
- **Format checks**: the server knows manifest `format` 2 and `idx` 1. A newer format gets a
  tool error, `index_too_new`, telling the user to update `stare`, never a guess. D97's next
  index version adds a jurisdiction level to the paths, and the reader of the manifest is the
  one place that learns it.
- **The binary's own version** is SemVer (below) and reported in `serverInfo` and `meta`. Tool
  names and output fields are the contract: a field may be added in a minor release; renaming
  or removing one, or changing a status value's meaning, is a major release.

## Licences and attribution in responses

Each result's `meta.sources` lists what that answer was made from, with each source's stated
licence, as facts from the files themselves. The server makes no determination about what
terms apply to its output.

- **The citation index** (resolution status, provenance labels, the manifest's facts): the
  manifest's own `license` (CC BY-NC-ND 4.0, credit stare.pub, https://stare.pub) and its
  `based_on` (the Caselaw Access Project, CC0 1.0; CourtListener's bulk data, Public Domain
  Mark 1.0, Free Law Project).
- **A CAP case's text and metadata**: Caselaw Access Project, CC0 1.0, the terms CAP published
  them under (`stare::license`'s CC0 constant), with the volume zip's URL.
- **A CourtListener record**: the record's own `license` (Public Domain Mark 1.0) and
  `attribution` (CourtListener, Free Law Project, the export date, CourtListener's URL), copied
  from the record, and `blocked_notice` when `source.cl_blocked` is set.
- **citare's detection** (the citations found, reporter names and slugs): citare's data bundle
  sections from reporters-db and courts-db (BSD 2-Clause, Free Law Project) and citare's own
  supplement (CC BY-NC-ND), as the bundle's sidecar states them.

The text rendering of `get_case` ends with one credit line ("Text: Caselaw Access Project,
CC0 1.0. Citation index: stare.pub, CC BY-NC-ND 4.0."), and `stare://licenses` has the full
statement, written from `llms.txt`'s Licences section so the two can't drift. The release
archives include `crates/stare/src/licenses/` (the reporters-db and courts-db LICENSE files),
since BSD 2-Clause asks that binary redistributions reproduce the notice, and the binary's own
code licence (PolyForm Shield 1.0.0).

Every tool description also says what the data can't tell an agent: a found case exists and is
the one cited, and the server has no treatment, history or citator data and says nothing
about whether a case is still good law.

## Errors

Protocol errors (unknown tool, schema violation) are JSON-RPC errors. Everything else is a tool
result with `isError: true` and a structured `error`:

| `error.code` | When | The agent should |
|---|---|---|
| `bad_input` | input fails validation beyond the schema (a volume key with a slash) | fix the call |
| `unparsed` | citare finds no citation in `citation` | rephrase, or pass parts |
| `bad_ref` | a `case_ref` that isn't one | use a ref from a result |
| `stale_cursor` | cursor from another index version | restart the read |
| `network` | host unreachable, nothing cached, after the existing retries | retry later, or use a mirror |
| `offline_miss` | `--offline` and not cached | report the URL to the user |
| `not_in_copy` | a mirror without that tier's files | use the public host |
| `index_too_new` | manifest format newer than the binary | tell the user to update `stare` |
| `data_error` | a file that doesn't parse (malformed lines are skipped and counted, as readers do; a corrupt gzip or zip is this) | report it |

`held_miss`, `not_held`, `ambiguous` and `needs_review` are statuses in successful results.

Case text is data from the corpus. The server never fetches a URL taken from tool input; it
reads only the configured index and data locations, and the paths it builds are checked with
the existing validators (`manifest::is_volume_key`, `cl::is_hash`, `cl::is_reporter_slug`).

## Tests

- **Engine parity first.** Before the refactor, commit `stare check --json` output on the
  existing fixtures (`a2d-31.zip`, `cl-sample-build.json`, `parallel-reconcile.json`,
  `cl-record.json`) as golden files; the refactored CLI must match them byte for byte.
- **Golden vectors per tool.** `crates/stare-cli/tests/mcp/` holds input/output pairs for each
  tool, run against a fixture mirror directory (the fixtures laid out as the hosts are), with
  `meta.server_version` and timings masked. `UPDATE_GOLDEN=1` rewrites them for review.
- **Protocol tests.** An in-process client (rmcp's) over a duplex pipe runs initialize,
  `tools/list` (checking every `inputSchema` and `outputSchema` against the JSON Schema
  meta-schema, which `stare-site`'s tests already vendor for OpenAPI), each tool, cursors, a
  stale cursor and every error code.
- **Three-way agreement.** `cl-sample-build.json` is already resolved end to end by the Rust and
  JS tests; `check_brief`'s citations on the same inputs must equal `stare check --json` and the
  site's `checkCitations` output on the shared fields. The pin-page port shares its fixtures
  with `web/tests/pages.test.js`.
- **A live smoke test**, not in CI's required set: one `check_brief` on a short known brief
  against `idx.stare.pub`, run by `mise run mcp-smoke`. A format change on the hosts then shows
  up before a user finds it.
- **Size checks**: no tool result over its declared ceiling on the largest case in the fixture
  set, and the release binary's size with and without the `mcp` feature recorded in the PR.

## Distribution

- **Binaries attached to a release**, built by a new workflow on the homelab runners with the
  existing `CITARE_DEPLOY_KEY`: `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`
  (the Pi of [stare#231](https://github.com/codexpublicus/stare/issues/231)) in M1;
  `x86_64-apple-darwin`, `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` in M2. Each archive
  holds the binary, the licence files, the skill document and a `SHA256SUMS`.
- **No container image.** The client launches a stdio server itself, and an image adds nothing for
  M1, and none is pushed to ghcr.io for this private project. A later HTTP deployment builds on
  its host from a git commit.
- **macOS and Windows.** The homelab runners are Linux. Cross-compiling with `cargo zigbuild`
  covers macOS from Linux for this dependency set (rustls, no system TLS) and avoids GitHub's
  hosted macOS minutes, which private repositories pay for at a multiple of Linux minutes.
  Unsigned macOS binaries are quarantined by Gatekeeper; the install notes give the
  `xattr -d com.apple.quarantine` step until signing is decided.
- **Who can download.** Release assets on a private repository are visible only to people with
  access to it. That is enough for the owner and invited testers; anyone else needs the
  binaries somewhere public, which ties to D34 ([stare#23](https://github.com/codexpublicus/stare/issues/23)) and the public/private questions [stare#162](https://github.com/codexpublicus/stare/issues/162) names.
- **Install instructions** for registering the server with MCP clients: the generic stdio
  entry (`"command": "stare", "args": ["mcp"]`) and, per client, its own config file or
  command, kept in the skill document and the README.
- **Listing** in the MCP registry and a skills marketplace comes after the public question is
  settled.

### Release versioning

The CLI and server are something people script against and agents call by tool schema, which is
a compatibility contract, so they take SemVer (`stare` 0.x until the tool set settles), not the
site's CalVer. Tags would be `stare-cli-v0.1.0`. The site's release tooling must ignore them:
`scripts/calver.mjs` and `release.yml` look for `vYYYY.MM.DD.N`, and the prefix keeps the two
apart. The CLI's release notes come from Conventional Commits touching `crates/stare` and
`crates/stare-cli`, with git-cliff and its own config.

## The agent skill

`skills/stare-citations/SKILL.md` in this repo, in the lokkju/skills format, shipped in each
release archive. Its content:

- **When**: before presenting, filing or relying on any text with case citations the agent
  wrote or was given, and when asked whether a case exists or says something.
- **How, with the MCP server**: `check_brief` on the whole text; for each `found` citation
  that supports a proposition, `get_case` with `find` (the quoted words) or `pin`; read the
  excerpt and compare it with the claim.
- **What the statuses mean**, in the agent's terms: `held_miss` is a citation to a page where
  stare.pub holds the volume and no case starts, the strongest sign of a fabricated or
  mistyped citation; `not_held` means unverified, not false, with the CourtListener and Scholar
  links to try; `needs_review` means the printings of a parallel run open different cases;
  `found_alias` and `found_partner` are found, with the provenance label quoted, never
  described as verified.
- **What it must not claim**: that a case is good law, that a holding is still followed, or
  anything the case text doesn't say.
- **Without the MCP server**: the same steps with `stare check --json -` and
  `stare resolve --json`, and for an agent with neither, `https://stare.pub/llms.txt`'s
  recipe.
- **Credit**: quote the licence line from the result when reproducing case text.

## Hosted later: a Worker, with its costs

A remote copy for agents that can't run a binary is possible: the stare-wasm build plus an MCP
Streamable HTTP handler in a Cloudflare Worker, reading R2 through bindings. It would have to be
access-gated (Cloudflare Access with service tokens, or OAuth per the MCP authorization spec)
and it costs compute on every call, which the owner avoids. The facts to weigh, from
Cloudflare's published Workers pricing as I understand it (to check against the pricing page
before any decision):

- Every MCP message is a Worker invocation: initialize, `tools/list`, and each tool call. A
  `check_brief` session is a handful of invocations, plus subrequests to R2.
- The free plan's 10 ms CPU limit per invocation rules it out: citare's first detection pass
  took 133 to 140 ms in a browser ([stare#117](https://github.com/codexpublicus/stare/issues/117)'s measurements), and loading the data bundle more.
- Workers Paid is $5 a month with 10 million requests and 30 million CPU-milliseconds included,
  then $0.30 per million requests and $0.02 per million CPU-milliseconds.
- R2 reads through a binding are Class B operations (10 million a month free, then $0.36 per
  million), and the Worker's own cache is per location, so a hosted server reads more from R2
  than browsers do through the CDN.
- Cloudflare Access is free up to 50 users.

At small use the bill is the $5 floor; the reason to wait is the owner's rule, not the amount.
Nothing in the local design blocks it later: the tool schemas are the contract either way.

## Phases

**M1, the smallest useful set.**

1. Golden files of `stare check --json` and `stare resolve --json` on the fixtures.
2. The engine refactor into `stare_cli::engine`, CLI output unchanged.
3. Range reads of single zip entries in the engine, used by `stare resolve` too.
4. `stare mcp` over stdio with `find_citations_in_text`, `resolve_citation`, `get_case` (text,
   metadata, `find`, `max_chars`, cursors), `check_brief` and `index_info`; session pinning;
   `meta.sources`; the error codes.
5. Golden-vector and protocol tests; the parity test against `stare check --json`.
6. Linux x86_64 and aarch64 musl binaries on a `stare-cli-v0.1.0` release; the skill document.

**M2.** Pin pages (`get_case`'s `pin` and `pages`, the `pages.js` port), `list_cited_cases`,
`list_volume`, `get_page_scan`, resources and the `check-citations` prompt, `--http` on
loopback, `--offline`, the cache size cap, macOS and Windows binaries.

**M3.** `lookup_key` and `crk_key` on results once [stare-builder#71](https://github.com/codexpublicus/stare-builder/issues/71) publishes the ledger;
`reader_url` moves to `/c/` and `/k/` when [stare#283](https://github.com/codexpublicus/stare/issues/283) ships; the jurisdiction level in index
paths with D97's next index version.

**M4.** `search_cases` once D143's full-text search is built.

**Later, if wanted.** The hosted Worker above; registry and marketplace listings once the
binaries are public.

## Open decisions

1. **Where the server lives.** Recommended: `stare mcp`, a subcommand of the existing binary,
   behind a default-on `mcp` cargo feature. The alternative is a separate `stare-mcp` binary.
2. **MCP library.** Recommended: the official Rust SDK, `rmcp`, pinned exactly. The alternative
   is a hand-written JSON-RPC layer, smaller but ours to keep current with the spec.
3. **Where the orchestration goes.** Recommended: `stare_cli::engine` in the CLI crate's
   library, synchronous, called from tokio's blocking pool. The alternative is native-only
   modules in `crates/stare`, which the WASM build would have to keep excluding.
4. **Zip access.** Recommended: range-read single entries (case JSON, HTML, CasesMetadata) and
   use a whole cached zip when present, for the CLI as well. The alternative keeps the CLI's
   whole-zip download, about 1.9 MB on average per volume touched.
5. **Default response budget.** Recommended: 20,000 characters per `get_case` result, ceiling
   100,000, citations 200 per page.
6. **Session pinning.** Recommended: pin the live build at session start, move only on
   `index_info(refresh: true)`, refuse stale cursors. The alternative, always reading the live
   manifest, can change an answer mid-session.
7. **Tool names.** Recommended as in this document: `check_brief` for the issue's `check_text`,
   and `resolve_citation` taking structured parts in place of a separate `resolve_case`.
8. **Binary versioning.** Recommended: SemVer tags `stare-cli-vX.Y.Z`, separate from the site's
   CalVer, with their own release notes.
9. **Where binaries are published for people outside the repo.** Recommended: release assets on
   codexpublicus/stare for M1 (the owner and invited testers), and decide the public location
   with D34. The options then are a public releases-only repository, or a path on
   data.stare.pub served from R2 (reads only, no Worker).
10. **macOS and Windows builds.** Recommended: cross-compile on the homelab runners with
    `cargo zigbuild` and ship unsigned in M2. The alternative is GitHub-hosted macOS and Windows
    runners, billed for a private repository, which signing would need anyway.
11. **The skill's home.** Recommended: `skills/stare-citations/` in this repo, shipped in the
    release archives, and listed in lokkju/skills once binaries are public.
12. **Local HTTP transport.** Recommended: in M2, loopback only, Origin-checked, optional
    bearer token. The alternative is stdio only.
13. **Hosted Worker.** Recommended: not now; revisit with the costs above if users who can't run
    a binary ask for it.
14. **Pin pages in M1 or M2.** Recommended: M2. `find` covers checking a quotation in M1 with no
    new parsing; the `pages.js` port is the larger piece and wants its shared fixtures.
