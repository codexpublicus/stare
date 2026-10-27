---
name: stare-citations
description: Use before presenting, filing or relying on any text with U.S. case citations that you wrote or were given (a brief, a memo, a draft opinion, an answer that cites cases), and whenever you're asked whether a case exists, whether a citation is right, or whether a case says what a text claims. Checks every citation against stare.pub's index of U.S. case law through the stare MCP server (or the stare CLI), and reads the cited cases to compare them with the propositions they support.
---

# Checking case citations with stare

stare.pub indexes U.S. case law by citation: the Caselaw Access Project's cases and
CourtListener's records. `stare mcp` is a local MCP server over that index, run by the `stare`
binary on your machine; it reads only stare.pub's static files (or a mirror of them) and keeps a
cache in `~/.cache/stare/`. Its five tools are `check_brief`, `get_case`,
`resolve_citation`, `find_citations_in_text` and `index_info`.

## When

- Before you present, file or rely on any text with case citations, whether you wrote it or
  were given it.
- When you're asked whether a case exists, whether a citation is right, or whether a case says
  something.

A citation you generated from memory is a guess until stare has found it. Check it before
anyone sees it.

## How, with the MCP server

1. Run `check_brief` on the whole text. It finds every citation, looks each up, reconciles
   parallel citations, settles a page several cases start on by the case name the text gives,
   and groups the citations by the case they cite. Read `summary.line` first, then
   `cited_cases`.
2. Compare each cited case's `name` with the name the text gives. A right citation with the
   wrong name is a mistake too.
3. For each found case that supports a proposition, call `get_case` with its `case_ref` and
   `find` set to the quoted words, or to the words of the proposition that the opinion would
   have to contain. Read the excerpts and compare them with the claim. A `near` match is not the
   quoted text: report the difference.
4. When the text quotes a case at length, or `find` comes back empty, read the text itself with
   `get_case` (20,000 characters at a time; follow `next_cursor`).
5. Results come 200 at a time; follow `next_cursor` on `check_brief` for a long document.

Use `resolve_citation` for one citation, with `case_name` and `year` when the text gives them,
and `parallel` for the run's other printings. Use `find_citations_in_text` when you only need to
know what a passage cites; it makes no lookups.

## What the statuses mean

- `found`: a case starts at that page, and it is the one the citation names. Report it as
  found, never as "verified".
- `found_alias`, `found_partner`: found, through the provenance the result gives (for
  example "Resolved through CourtListener's citation metadata", or "Reported at 128 Neb. 783,
  inferred from the citing text"). Quote that label; don't call it verified.
- `held_miss`: stare.pub holds the volume and no case starts at that page. This is the
  strongest sign the data can give of a fabricated or mistyped citation. Say so plainly.
- `not_held`: stare.pub doesn't hold that volume. The citation is unverified, not false; the
  result's `case_links` (CourtListener, Google Scholar) are where to try next.
- `ambiguous` (from `resolve_citation`): several cases start at the page and nothing given
  settles which; all are listed. Pass the case name and year.
- `needs_review`: the printings of a parallel run open different cases. One of them is wrong.
- `statute`, `external`: a statute or regulation; `external_url` links its text when there is
  one. stare doesn't check statutes.
- `no_antecedent`: a short form (`Id.`, `supra`) whose earlier citation couldn't be identified.

Errors come back with `isError` and a code: `bad_input`, `unparsed` and `bad_ref` mean fix the
call; `network` means retry later or use a mirror; `not_in_copy` means the mirror lacks the case
text and the public URL is in the error; `index_too_new` means the user needs a newer `stare`;
`data_error` and `stale_cursor` say what to do in their message.

## What you must not claim

- That a case is good law, or that a holding is still followed. stare has no treatment,
  history or citator data, and nothing in a result says either.
- Anything the case text doesn't say. A found citation proves the case exists, not that it
  supports the proposition; only the text you read can show that.

## Credit

Every result's `meta.sources` names each source it used and the licence that source states.
When you reproduce case text, quote the credit line `get_case` ends its text with, such as
"Text: Caselaw Access Project, CC0 1.0. Citation index: stare.pub, CC BY-NC-ND 4.0."

## Without the MCP server

With the `stare` binary but no MCP client, the same checks run from a shell:

```bash
stare check --json brief.txt      # or - for stdin: check_brief's citations, as JSON
stare resolve --json "31 A.2d 647"
stare resolve a2d 31 647
```

With neither, `https://stare.pub/llms.txt` gives the recipe in plain GETs: the index manifest,
the volume's index file, then the case.

## Installing the server

`stare` is a single binary (Linux x86_64 and aarch64 for now). Register it with any MCP client
that launches stdio servers:

```json
{ "mcpServers": { "stare": { "command": "stare", "args": ["mcp"] } } }
```

In Claude Code: `claude mcp add stare -- stare mcp`. `--index` and `--data` (or `STARE_INDEX`
and `STARE_DATA`) point it at a mirror that `stare download` filled; `--index-version
v2026.10.22` reads one index build, for reproducing a report. The session reads one index build
from its first lookup; `index_info` with `refresh: true` moves it to the live one.
