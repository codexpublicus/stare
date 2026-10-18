// Citation detection, through citare compiled to WASM. There is no fallback:
// if the WASM fails to load, detectCitations rejects with a WasmLoadError and
// callers show an error, not empty or degraded results.

import { fetchCached } from './cache.js';
import { idxEntries } from './idx.js';
import {
  citedSlug, hasAliasVolume, hasIdx, holdsVolume, indexPath, loadManifest, volumeCandidates,
} from './manifest.js';
import { indexUrl } from './sources.js';
import { pinSuffix } from './router.js';
import { loadWasm } from './wasm.js';

// External URL generation is now in Rust (stare::cite::external_url)

// ---------------------------------------------------------------------------
// Detection — citare WASM
// ---------------------------------------------------------------------------

/**
 * The citation types that refer back to an earlier full citation (the Rust
 * `SHORT_FORM_TYPES`). Their page is a pin page, so they are looked up only
 * through their `antecedent`.
 */
export const SHORT_FORM_TYPES = new Set(['ShortCaseCitation', 'IdCitation', 'SupraCitation', 'ReferenceCitation']);

export function isShortForm(c) {
  return SHORT_FORM_TYPES.has(c?.type);
}

/**
 * A statute or regulation: citare's `FullLawCitation`, or a short form
 * (`Id. § 1985`) whose antecedent is one, which carries its `law`.
 */
export function isStatute(c) {
  return c?.type === 'FullLawCitation' || !!c?.law;
}

/**
 * A bare section reference: a `§` or `§§` citare found without a code it
 * recognizes (`General Statutes § 52-584`, `§ 3(a)`), which it reports as
 * an `UnknownCitation`. It names no case and no code stare.pub could look
 * up, so it is neither linked, listed nor counted.
 */
export function isSectionReference(c) {
  return c?.type === 'UnknownCitation';
}

// One detected citation, or a short form's antecedent, as the renderers read it.
function fromRust(c) {
  return {
    raw: c.matched_text,
    type: c.citation_type,
    harvard_slug: c.harvard_slug || null,
    slug: citedSlug(c),
    volume: c.volume ? parseInt(c.volume, 10) : null,
    page: c.page || null,
    reporter: c.reporter || null,
    year: c.year || null,
    start: c.span[0],
    end: c.span[1],
    externalUrl: c.external_url || null,
    law: c.law || null,
    caseLinks: Array.isArray(c.case_links) ? c.case_links : [],
  };
}

/**
 * Detect citations using citare WASM.
 * Returns array of { raw, type, harvard_slug, slug, volume, page, reporter, year, start, end, externalUrl, law, caseLinks, pin, antecedent }
 *
 * `law` is the Rust `LawRef` of a statute or regulation (`{ jurisdiction,
 * code, subject, title, chapter, section }`, the shape of citare's own `law`
 * object), set whether or not `externalUrl` links
 * it; null for anything else.
 *
 * `pin` is the pin cite (`1023` for `997 P.2d at 1023`), or null. A short
 * form (`isShortForm`) has `page: null` and, when citare could tell which
 * earlier citation it refers to, that citation as `antecedent`, in the same
 * shape (without `pin` and `antecedent`); else `antecedent: null`.
 *
 * `caseLinks` are the Rust `case_links`: `{ source, kind, url }` for places
 * outside stare.pub that may hold a case citation, offered only when the
 * index doesn't (see caseLookupLinks).
 *
 * `start`/`end` are Unicode code point offsets into `text`, matching
 * gorsuch-library's page viewer convention, not UTF-16 code units. Convert
 * to UTF-16 offsets before using them with String.prototype.slice or any
 * other native JS string indexing. renderTextHtml, below, highlights by
 * these offsets.
 */
export async function detectCitations(text) {
  const w = await loadWasm();
  return citationsFromRust(JSON.parse(w.detect_citations(text)));
}

/** The WASM's `detect_citations` output, parsed, as detectCitations returns it. */
export function citationsFromRust(raw) {
  return raw.map(c => ({
    ...fromRust(c),
    pin: c.pin || null,
    antecedent: c.antecedent ? fromRust(c.antecedent) : null,
  }));
}

// ---------------------------------------------------------------------------
// Availability checking
// ---------------------------------------------------------------------------

export function guessSlug(reporter) {
  return reporter.toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
}

/** checkAvailability's answer for a volume whose index has only aliases. */
export const ALIASES_ONLY = 'aliases';

/**
 * Whether stare.pub holds `volume` (as cited) of `slug`: true when the manifest
 * lists the volume, or lists parts of it when CAP split the volume over several
 * folders (a3d 138 and 138-2). With the unified index the manifest's `reporters`
 * covers every source, so a volume only CourtListener has counts too.
 * ALIASES_ONLY for a volume whose index has only aliases (#151): stare.pub holds
 * none of its cases, but a page there may be a parallel citation of one it does.
 * False otherwise. `manifest` is injectable for tests.
 */
export async function checkAvailability(slug, volume, manifest = null) {
  const m = manifest || await loadManifest();
  if (holdsVolume(m, slug, volume)) return true;
  return hasAliasVolume(m, slug, volume) ? ALIASES_ONLY : false;
}

/**
 * The label for a link that came through an alias, from its `via`: "Resolved
 * through CourtListener's citation metadata" for `cl:<cluster>`. The aliases come
 * from CourtListener's `citations` table (publisher, scraper and import data), a
 * third party's metadata; nothing here calls such a link verified.
 */
export function viaLabel(via) {
  if (!via) return '';
  return /^cl:\d+$/.test(via) ? "Resolved through CourtListener's citation metadata" : `Resolved through ${via}`;
}

/**
 * The note above a case reached through an alias (#151): "Cited as nw 260 287.
 * Resolved through CourtListener's citation metadata (cluster 8077312)." `alias` is
 * resolve()'s `{ via, reporter, volume, page }`, the citation as looked up.
 */
export function aliasNoteHtml(alias) {
  if (!alias) return '';
  const m = /^cl:(\d+)$/.exec(alias.via || '');
  const via = viaLabel(alias.via) + (m ? ` (cluster ${m[1]})` : '');
  const cited = `Cited as ${alias.reporter} ${alias.volume} ${alias.page}.`;
  return `<div class="reader-alias" role="note">${escapeHtml(cited)}${via ? ` ${escapeHtml(via)}.` : ''}</div>`;
}

/**
 * What a page's index entries (CAP's own first, then aliases, then CourtListener's
 * records) say: false for none; true when the first is a case of the volume's own;
 * for an alias, `{ via, target: { slug, folder, caseFile } }`, the case it names.
 */
export function pageResult(entries) {
  if (!entries.length) return false;
  const first = entries[0];
  if (first.source !== 'cap' || !first.reporter) return true;
  return {
    via: first.via || null,
    target: { slug: first.reporter, folder: first.folder, caseFile: first.case_file },
  };
}

// A volume folder's .bin, or null when it isn't indexed (a 404).
async function readBin(slug, volume) {
  const key = await indexPath(`${slug}/${volume}.bin`);
  try {
    return await fetchCached('bins', key, indexUrl(key));
  } catch (e) {
    if (e.message.startsWith('NOT_FOUND')) return null;
    throw e;
  }
}

/**
 * Whether a case starts at `page` in an indexed volume, from the volumes'
 * .bin files (a few KB, cached like the case viewer's). The folder as cited
 * is tried first, then, as resolve.js does, the other parts of a split volume
 * whose page range holds the page (138 A.3d 1012 is in folder a3d/138-2), as
 * the format 2 manifest lists them.
 * With the unified index (the manifest's `idx`), the volume's `.idx.gz` answers
 * instead, for every source, in one fetch per volume (cached); a volume with no
 * `.idx.gz` falls back to the .bin files.
 * A read that fails (a network error, a timeout, a 5xx, or the WASM didn't load) is
 * tried once more after `retryDelay` ms; null when it fails again, which callers show
 * as "couldn't check" (lookupFailed), never as a link or a miss (#144). What did load
 * stays cached, so the retry and later checks don't fetch it again.
 *
 * `deps` ({ manifest, readBin, lookup, idxEntries, retryDelay }) are injectable for
 * tests, which can't load the WASM or reach idx.stare.pub.
 */
export async function checkPage(slug, volume, page, deps = {}) {
  const retryDelay = deps.retryDelay ?? 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await pageFound(slug, volume, page, deps);
    } catch {
      if (attempt > 0) return null;
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

async function pageFound(slug, volume, page, deps) {
  const p = parseInt(page, 10);
  const cited = String(volume);
  const m = deps.manifest || await loadManifest();
  if (hasIdx(m)) {
    const entries = await (deps.idxEntries || idxEntries)(slug, cited, p);
    if (entries) return pageResult(entries);
  }
  return capHasPage(slug, cited, p, m, deps);
}

async function capHasPage(slug, cited, p, m, deps) {
  const read = deps.readBin || readBin;
  let lookup = deps.lookup;
  if (!lookup) {
    const w = await loadWasm();
    lookup = (bin, pg) => w.lookup_page(bin, pg);
  }
  const tried = [cited];
  let bin = await read(slug, cited);
  if (bin && lookup(bin, p) != null) return true;
  // The legacy manifest can't name split volumes, and guessing "<n>-2" here,
  // as resolve.js does for one citation the reader asked for, would cost a
  // 404 for every page miss on the page. Until the format 2 manifest is up,
  // a citation into a second part shows as a held-volume miss, as it did
  // before #94.
  if (m.legacy) return false;
  for (const other of volumeCandidates(m, slug, cited, p)) {
    if (tried.includes(other)) continue;
    tried.push(other);
    bin = await read(slug, other);
    if (bin && lookup(bin, p) != null) return true;
  }
  return false;
}

/**
 * Availability for one detected citation, as the fields the renderers read:
 * - `slug`: the index slug when the volume is indexed, else null
 * - `volumeHeld`: the manifest lists the cited reporter and volume
 * - `resolvable`: a case starts at the cited page, or an alias there names one
 * - `pageUnknown`: held, but the page check failed (checkPage's null); not
 *   resolvable, and not a miss either (lookupFailed)
 * - `via`, `aliasOf`: for a citation that resolves through an alias (#151),
 *   where the alias came from (`cl:8077312`) and the case it names
 *   (`{ slug, folder, caseFile }`); null otherwise
 *
 * A volume whose index has only aliases (ALIASES_ONLY) isn't held: a hit
 * resolves, and a miss or a failed check is a volume stare.pub doesn't hold.
 *
 * A held volume with no case at the page is not linked out: it may be an
 * index gap or a bad citation, and nothing here can tell which. Only a
 * volume stare.pub doesn't hold gets the outside links (citedCaseHtml).
 * `check` and `pageCheck` are injectable for tests, as in processCitations.
 */
export async function checkCitation(c, check = checkAvailability, pageCheck = checkPage) {
  if (isShortForm(c)) {
    const a = c.antecedent ? await checkCitation(c.antecedent, check, pageCheck) : null;
    return inheritStatus(c, a);
  }
  const none = { ...c, key: citationKey(c), slug: null, volumeHeld: false, resolvable: false, via: null, aliasOf: null };
  // A statute is never looked up in the case index, so it never links
  // into stare.pub or picks up a page pin there.
  if (c.externalUrl || isStatute(c)) return none;
  // A blank page (`1 U.S. ___`) arrives as page: null and can't be looked
  // up, so it doesn't fall through to the slug guess below either.
  if (!c.page || !c.volume) return none;
  const cited = citedSlug(c);
  const slug = cited || (c.reporter ? guessSlug(c.reporter) : null);
  if (!slug) return none;
  const held = await check(slug, c.volume);
  if (!held) {
    // A guessed slug that isn't indexed is no slug at all.
    return { ...none, slug: cited ? slug : null };
  }
  const found = await pageCheck(slug, c.volume, c.page);
  const alias = found && typeof found === 'object' ? found : null;
  const aliasFields = { via: alias?.via || null, aliasOf: alias?.target || null };
  if (held === ALIASES_ONLY) {
    if (!found) return { ...none, slug: cited ? slug : null };
    return { ...c, key: citationKey(c), slug, volumeHeld: false, resolvable: true, ...aliasFields };
  }
  return {
    ...c, key: citationKey(c), slug, volumeHeld: true, resolvable: !!found, pageUnknown: found == null,
    ...aliasFields,
  };
}

/**
 * The key a citation's status is kept under: its raw string, and for a
 * short form the raw string of its antecedent too. Every `Id.` that refers
 * to the same case shares one status; `Id.`s that refer to different cases,
 * or to none, don't. A pinned `Id.` to a statute (`Id. § 1985`) has a
 * status of its own (see inheritStatus), so its key has the pin.
 */
export function citationKey(c) {
  if (!isShortForm(c) || !c.antecedent) return c.raw;
  const pinned = c.pin && safeExternalUrl(c.antecedent.externalUrl) ? `\u00a0${c.pin}` : '';
  return `${c.raw}\u2192${c.antecedent.raw}${pinned}`;
}

/**
 * A short form's status, from its antecedent's (`a`, as checkCitation
 * returns it, or null when it has none). The short form links where its
 * antecedent does, with the antecedent's reporter, volume and first page,
 * and keeps its own `raw`, `pin` and `antecedent`. With no antecedent it is
 * `noAntecedent` and never looked up. An `Id.` to a statute links to its
 * text only without a pin: `Id. § 1985` is a different section.
 */
export function inheritStatus(c, a) {
  const own = { ...c, key: citationKey(c), page: null, slug: null, volumeHeld: false, resolvable: false, externalUrl: null, law: a?.law || null, caseLinks: [], via: null, aliasOf: null };
  if (!a) return { ...own, noAntecedent: true };
  if (safeExternalUrl(a.externalUrl) && c.pin) return own;
  return {
    ...own,
    slug: a.slug,
    harvard_slug: a.harvard_slug,
    reporter: a.reporter,
    volume: a.volume,
    page: a.page,
    volumeHeld: a.volumeHeld,
    resolvable: a.resolvable,
    pageUnknown: a.pageUnknown,
    externalUrl: a.externalUrl,
    caseLinks: a.caseLinks,
    via: a.via || null,
    aliasOf: a.aliasOf || null,
  };
}

/**
 * Check a list of detected citations, each distinct citation once: full
 * citations by raw string, short forms through their antecedent's status
 * (looked up once, with the antecedent's own entry). Returns one entry per
 * `citationKey`, in order of first occurrence. `check` and `pageCheck` are
 * injectable for tests, as in processCitations.
 */
export async function checkCitations(citations, check = checkAvailability, pageCheck = checkPage) {
  const byRaw = new Map();
  const full = (c) => {
    if (!byRaw.has(c.raw)) byRaw.set(c.raw, checkCitation(c, check, pageCheck));
    return byRaw.get(c.raw);
  };
  const entries = new Map();
  for (const c of citations) {
    const key = citationKey(c);
    if (entries.has(key)) continue;
    if (!isShortForm(c)) entries.set(key, full(c));
    else entries.set(key, (c.antecedent ? full(c.antecedent) : Promise.resolve(null)).then(a => inheritStatus(c, a)));
  }
  return Promise.all(entries.values());
}

// ---------------------------------------------------------------------------
// Process citations for a case
// ---------------------------------------------------------------------------

/**
 * Process all citations in a case's opinions.
 * Uses citare for detection, checks availability for each.
 *
 * Returns `{ unique, occurrencesByOpinion }`:
 * - `unique`: one entry per `citationKey` (a full citation's raw string; a
 *   short form's raw string and antecedent), with availability (`slug`,
 *   `resolvable`) resolved; the sidebar's list.
 * - `occurrencesByOpinion`: for each opinion in `casebody.opinions`, in
 *   order, every detected occurrence as `{ raw, key, pin, start, end }`,
 *   where `start`/`end` are code point offsets into that opinion's `text`.
 *   The reader highlights from these, looking each `key` up in `unique`.
 *
 * `check`, `detect` and `pageCheck` are injectable replacements for
 * `checkAvailability`, `detectCitations` and `checkPage`, used by tests to
 * stub the network fetch and the WASM, which Node can't load from the site
 * path. Rejects, with a WasmLoadError, if the WASM fails to load.
 */
export async function processCitations(caseData, check = checkAvailability, detect = detectCitations, pageCheck = checkPage) {
  const allCites = [];
  const occurrencesByOpinion = [];

  for (const op of caseData.casebody?.opinions || []) {
    const detected = await detect(op.text);
    allCites.push(...detected);
    occurrencesByOpinion.push(detected.map(c => occurrence(c)));
  }

  return { unique: await checkCitations(allCites, check, pageCheck), occurrencesByOpinion };
}

/** One detected citation as the renderers place it: `{ raw, key, pin, start, end }`. */
export function occurrence(c) {
  return { raw: c.raw, key: citationKey(c), pin: c.pin || null, start: c.start, end: c.end };
}

// ---------------------------------------------------------------------------
// Highlighting (DOM-free, so node --test covers it)
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for use in HTML element content or a quoted attribute value.
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/**
 * Escape opinion text and wrap `[*123]` page markers.
 */
export function formatPlainText(text) {
  return escapeHtml(text).replace(
    /\[\*(\d+)\]/g,
    '<span class="page-marker">[*$1]</span>'
  );
}

/**
 * `url` if it is an http(s) URL, else null. External citation links, in
 * the reader and the sidebar, are emitted only for URLs this accepts.
 */
export function safeExternalUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

// Links that leave stare.pub open in a new tab and send no referrer, so the
// other site doesn't learn which page or brief the reader came from.
const OUTBOUND = 'target="_blank" rel="noopener noreferrer"';

/** Display names for the `source` of a case link (Rust `CaseLink`). */
export const LOOKUP_SOURCES = {
  courtlistener: 'CourtListener',
  google_scholar: 'Google Scholar',
};

/**
 * The outside links to offer for a citation to a volume stare.pub doesn't
 * hold: its `caseLinks` with a known source and an http(s) URL, in order.
 * Empty when the citation resolves here, links to a statute's text, or
 * cites a volume stare.pub holds (see heldVolumeMiss): a case missing from
 * a held volume isn't linked out until something can tell that it exists
 * (codexpublicus/citare#39; CAP's redacted reprints are #143).
 */
export function caseLookupLinks(info) {
  if (!info || info.resolvable || info.volumeHeld || safeExternalUrl(info.externalUrl)) return [];
  return (info.caseLinks || []).filter(l =>
    l && Object.hasOwn(LOOKUP_SOURCES, l.source) && safeExternalUrl(l.url));
}

/**
 * "Not in stare.pub: may be at CourtListener", for a case link. "May be":
 * nothing checks that the case exists there (codexpublicus/citare#39).
 */
export function lookupLabel(link) {
  return `Not in stare.pub: may be at ${LOOKUP_SOURCES[link.source]}`;
}

/**
 * The note for a statute or regulation with no link to its text: one
 * stare.pub recognizes but has no free source for yet (STATE_CODES in
 * crates/stare/src/cite.rs lists the codes it links).
 */
export const STATUTE_NOTE = 'Statute; no free source linked yet';

/** The note on a bare section reference (isSectionReference). */
export const SECTION_NOTE = 'Section reference';

/**
 * For a citation to a volume stare.pub holds where no case starts at the
 * cited page, the neutral note to show; else null. It claims nothing about
 * whether the case exists: an index gap and a bad citation look the same.
 */
export function heldVolumeMiss(info) {
  if (!info || info.resolvable || info.pageUnknown || !info.volumeHeld || safeExternalUrl(info.externalUrl)) return null;
  return `No case found at this page in ${info.reporter || info.slug} vol. ${info.volume}`;
}

/**
 * For a citation to a held volume whose index couldn't be read (checkPage's
 * null, after its retry), the note to show; else null. It is neither a link
 * nor a miss: the case may well be there (#144).
 */
export function lookupFailed(info) {
  if (!info?.pageUnknown || info.resolvable || !info.volumeHeld) return null;
  return `Couldn't reach the index for ${info.reporter || info.slug} vol. ${info.volume}; reload to try again`;
}

/** The note for a short form citare couldn't tie to an earlier citation. */
export const NO_ANTECEDENT = "Refers to an earlier citation that couldn't be identified";

/**
 * "at 1023" for a pin cite that starts with a number, else the pin as
 * written (`§ 1985`); '' for none.
 */
export function pinLabel(pin) {
  if (!pin) return '';
  return /^\d/.test(pin) ? `at ${pin}` : pin;
}

/**
 * For a short form, what it refers to: "Refers to 997 P.2d 1021, at 1023",
 * or NO_ANTECEDENT. Null for a full citation. `pin` is the occurrence's own
 * pin, which entries sharing a key don't share.
 */
export function refersTo(info, pin = info?.pin) {
  if (!isShortForm(info)) return null;
  if (!info.antecedent) return NO_ANTECEDENT;
  // A statute's pin is a section (`Id. 52-577`), not a page.
  const at = isStatute(info) && /^\d/.test(pin || '') ? `§ ${pin}` : pinLabel(pin);
  return `Refers to ${info.antecedent.raw}${at ? `, ${at}` : ''}`;
}

/**
 * Markup for one citation occurrence. `inner` is the already formatted
 * citation text; `info` is the citation's entry from processCitations;
 * `pin` is the occurrence's own pin cite. A short form links to its
 * antecedent's case (`info` carries the antecedent's slug, volume and
 * first page) and says what it refers to in its title. A pin page is
 * linked as `@1023` after the case, which the case view scrolls to.
 */
function citationHtml(raw, inner, info, pin = info.pin) {
  if (isSectionReference(info)) {
    return `<span class="cite-section" title="${escapeHtml(SECTION_NOTE)}">${inner}</span>`;
  }
  const refers = refersTo(info, pin);
  if (info.noAntecedent) {
    return `<span class="cite-unresolved cite-no-antecedent" title="${escapeHtml(NO_ANTECEDENT)}">${inner}</span>`;
  }
  const titled = (note) => escapeHtml(refers ? `${refers}. ${note}` : note);
  const externalUrl = safeExternalUrl(info.externalUrl);
  if (externalUrl) {
    return `<a class="cite-link cite-external" href="${escapeHtml(externalUrl)}" ${OUTBOUND} title="${titled('View on external site')}">${inner}</a>`;
  }
  if (info.resolvable) {
    const slug = escapeHtml(info.slug);
    const volume = escapeHtml(String(info.volume));
    const page = escapeHtml(String(info.page));
    const pinAttr = pin ? ` data-pin="${escapeHtml(pin)}"` : '';
    const at = escapeHtml(pinSuffix(pin, info.page));
    const via = viaLabel(info.via);
    const title = via ? `${refers || raw}. ${via}` : refers || raw;
    const viaAttr = info.via ? ` data-via="${escapeHtml(info.via)}"` : '';
    return `<a class="cite-link" href="#${slug}/${volume}/${page}${at}" data-slug="${slug}" data-volume="${volume}" data-page="${page}"${pinAttr}${viaAttr} title="${escapeHtml(title)}">${inner}</a>`;
  }
  if (isStatute(info)) {
    return `<span class="cite-statute" title="${titled(STATUTE_NOTE)}">${inner}</span>`;
  }
  const unknown = lookupFailed(info);
  if (unknown) {
    return `<span class="cite-unresolved cite-unknown" title="${titled(unknown)}">${inner}</span>`;
  }
  const miss = heldVolumeMiss(info);
  if (miss) {
    return `<span class="cite-unresolved" title="${titled(miss)}">${inner}</span>`;
  }
  const [lookup] = caseLookupLinks(info);
  if (lookup) {
    return `<a class="cite-lookup" href="${escapeHtml(lookup.url)}" ${OUTBOUND} title="${titled(lookupLabel(lookup))}">${inner}</a>`;
  }
  return `<span class="cite-unresolved" title="${escapeHtml(refers || 'Not yet indexed')}">${inner}</span>`;
}

/**
 * Sort citations for a cited-cases list: ones stare.pub holds, then
 * statutes linked to their text, then cases to look for elsewhere, then
 * statutes with no link, then the rest. Stable within each group. Bare
 * section references (isSectionReference) are left out.
 */
export function orderCitedCases(citations) {
  const rank = (c) => {
    if (c.resolvable) return 0;
    if (safeExternalUrl(c.externalUrl)) return 1;
    if (caseLookupLinks(c).length) return 2;
    if (isStatute(c)) return 3;
    return 4;
  };
  return citations
    .filter(c => !isSectionReference(c))
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * One entry in a cited-cases list (the case viewer's sidebar and /check),
 * and where the link-out decision is made: a case stare.pub holds links
 * here; a statute links to its text, or says it has no free source yet; a
 * held volume with no case at the cited page gets a neutral note and no
 * outside link; a volume stare.pub doesn't hold links to CourtListener and
 * Google Scholar, labelled as unverified. A bare section reference has no
 * entry ('').
 * `caseHref(c)` gives the stare.pub link for a citation it holds; that link
 * opens in a new tab with `caseRel` (pass '' for none).
 */
export function citedCaseHtml(c, caseHref, caseRel = 'noopener') {
  if (isSectionReference(c)) return '';
  const raw = escapeHtml(c.raw);
  // A short form's entry stands for every occurrence with its key, whose
  // pins differ, so the sidebar names the antecedent without a pin.
  const refers = refersTo(c, null);
  const refersHtml = refers ? `\n          <span class="cited-lookup cited-miss cited-refers">${escapeHtml(refers)}</span>` : '';
  const wrap = refers ? ' cited-case-lookup' : '';
  if (c.noAntecedent) {
    return `<div class="cited-case${wrap}">
          <span class="cited-status none">&#8211;</span>
          <span class="cited-case-unresolved">${raw}</span>${refersHtml}
        </div>`;
  }
  if (c.resolvable) {
    const rel = caseRel ? ` rel="${escapeHtml(caseRel)}"` : '';
    // A case reached through an alias says where the link came from (#151).
    const via = viaLabel(c.via);
    const viaHtml = via ? `\n          <span class="cited-lookup cited-via">${escapeHtml(via)}</span>` : '';
    return `<div class="cited-case${via ? ' cited-case-lookup' : wrap}">
          <span class="cited-status ok">&#10003;</span>
          <a class="cited-case-link" href="${escapeHtml(caseHref(c))}" target="_blank"${rel}>${raw}</a>${refersHtml}${viaHtml}
        </div>`;
  }
  const externalUrl = safeExternalUrl(c.externalUrl);
  if (externalUrl) {
    return `<div class="cited-case${wrap}">
          <span class="cited-status ext">&#8599;</span>
          <a class="cited-case-link" href="${escapeHtml(externalUrl)}" ${OUTBOUND}>${raw}</a>${refersHtml}
        </div>`;
  }
  if (isStatute(c)) {
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status statute">&#167;</span>
          <span class="cited-case-unresolved">${raw}</span>${refersHtml}
          <span class="cited-lookup cited-miss">${escapeHtml(STATUTE_NOTE)}</span>
        </div>`;
  }
  const unknown = lookupFailed(c);
  if (unknown) {
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status unknown">?</span>
          <span class="cited-case-unresolved">${raw}</span>${refersHtml}
          <span class="cited-lookup cited-miss">${escapeHtml(unknown)}</span>
        </div>`;
  }
  const miss = heldVolumeMiss(c);
  if (miss) {
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${raw}</span>${refersHtml}
          <span class="cited-lookup cited-miss">${escapeHtml(miss)}</span>
        </div>`;
  }
  const links = caseLookupLinks(c);
  if (links.length) {
    const [first, ...rest] = links;
    const more = rest.map(l =>
      ` <a class="cited-lookup-link" href="${escapeHtml(l.url)}" ${OUTBOUND}>or ${escapeHtml(LOOKUP_SOURCES[l.source])}</a>`).join('');
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status lookup">&#8599;</span>
          <span class="cited-case-unresolved">${raw}</span>${refersHtml}
          <span class="cited-lookup"><a class="cited-lookup-link" href="${escapeHtml(first.url)}" ${OUTBOUND}>${escapeHtml(lookupLabel(first))}</a>${more}</span>
        </div>`;
  }
  return `<div class="cited-case${wrap}">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${raw}</span>${refersHtml}
        </div>`;
}

/**
 * Counts for a list of checked citations (checkCitations' entries), with
 * statutes apart from cases: `{ cases, resolvable, statutes, other }`.
 * `cases` counts case citations and short forms that don't refer to a
 * statute, `resolvable` those of them stare.pub holds, `statutes` statutes
 * and regulations, linked or not, and `other` anything else citare names
 * (law reviews). Bare section references aren't counted.
 */
export function citationCounts(citations) {
  const n = { cases: 0, resolvable: 0, statutes: 0, other: 0 };
  for (const c of citations || []) {
    if (isSectionReference(c)) continue;
    if (isStatute(c) || safeExternalUrl(c.externalUrl)) n.statutes++;
    else if (c.type === 'FullJournalCitation') n.other++;
    else {
      n.cases++;
      if (c.resolvable) n.resolvable++;
    }
  }
  return n;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * "3 case citations found (2 resolvable), 1 statute", from
 * citationCounts; the statute and other parts only when there are any.
 */
export function citationSummary(citations) {
  const n = citationCounts(citations);
  let text = `${plural(n.cases, 'case citation', 'case citations')} found (${n.resolvable} resolvable)`;
  if (n.statutes) text += `, ${plural(n.statutes, 'statute', 'statutes')}`;
  if (n.other) text += `, ${n.other} other`;
  return text;
}

/**
 * Render one paragraph as HTML, highlighting citations by offset.
 *
 * `text` is the paragraph; `paragraphStart` is its code point offset in the
 * text the occurrences were detected in. `occurrences` are `{ raw, key,
 * pin, start, end }` with code point offsets into that same text; only
 * those lying wholly inside this paragraph are highlighted, and of
 * overlapping ones the earliest (then longest) wins. `citationMap` maps
 * `key` (or, for an occurrence without one, `raw`) to citation info; an
 * occurrence without an entry stays plain. `formatPlain` turns a raw text
 * segment into HTML.
 */
export function renderParagraphHtml(text, paragraphStart, occurrences, citationMap, formatPlain = formatPlainText) {
  // UTF-16 index of each code point boundary in the paragraph.
  const utf16At = [0];
  for (const ch of text) utf16At.push(utf16At[utf16At.length - 1] + ch.length);
  const length = utf16At.length - 1;

  const inside = (occurrences || [])
    .map(o => ({ ...o, start: o.start - paragraphStart, end: o.end - paragraphStart }))
    .filter(o => Number.isInteger(o.start) && Number.isInteger(o.end))
    .filter(o => o.start >= 0 && o.end <= length && o.start < o.end && citationMap?.get(o.key ?? o.raw))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  let html = '';
  let cursor = 0;
  for (const o of inside) {
    if (o.start < cursor) continue;
    const from = utf16At[o.start];
    const to = utf16At[o.end];
    html += formatPlain(text.slice(utf16At[cursor], from));
    html += citationHtml(o.raw, formatPlain(text.slice(from, to)), citationMap.get(o.key ?? o.raw), o.pin);
    cursor = o.end;
  }
  html += formatPlain(text.slice(utf16At[cursor]));
  return html;
}

/**
 * Split `text` into paragraphs on runs of newlines, drop blank ones, and
 * render each with renderParagraphHtml. Returns the paragraphs' inner HTML.
 * `occurrences` carry code point offsets into the whole of `text`; one that
 * crosses a paragraph break is left unhighlighted.
 */
export function renderTextHtml(text, occurrences, citationMap, formatPlain = formatPlainText) {
  const paragraphs = [];
  const breaks = /\n+/g;
  let from = 0;
  let codePoints = 0;
  for (;;) {
    const m = breaks.exec(text);
    const to = m ? m.index : text.length;
    const p = text.slice(from, to);
    if (p.trim()) {
      paragraphs.push(renderParagraphHtml(p, codePoints, occurrences, citationMap, formatPlain));
    }
    if (!m) break;
    // Newlines are one code point each, so the break adds its own length.
    codePoints += [...p].length + m[0].length;
    from = breaks.lastIndex;
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Hover previews
// ---------------------------------------------------------------------------

const previewCache = new Map();

export async function fetchCasePreview(slug, volume, page, resolveFn) {
  const key = `${slug}/${volume}/${page}`;
  if (previewCache.has(key)) return previewCache.get(key);

  const promise = (async () => {
    try {
      const result = await resolveFn(slug, volume, parseInt(page, 10), () => {});
      const c = result.caseData;
      return {
        name: c.name_abbreviation,
        date: c.decision_date,
        court: c.court?.name || '',
        cite: c.citations?.[0]?.cite || '',
      };
    } catch {
      return null;
    }
  })();

  previewCache.set(key, promise);
  const result = await promise;
  previewCache.set(key, result);
  return result;
}

/**
 * Set up hover tooltips and click-to-open on citation links.
 * Resolvable citations open in a new tab. Hover shows preview tooltip.
 */
export function setupCiteHovers(container, resolveFn) {
  container.querySelectorAll('a.cite-link:not(.cite-external)').forEach(el => {
    let tooltipEl = null;
    let savedTitle = null;

    el.addEventListener('mouseenter', async () => {
      const hash = el.getAttribute('href');
      if (!hash || !hash.startsWith('#')) return;
      const parts = hash.slice(1).split('/');
      if (parts.length !== 3) return;
      const [slug, volume, pageStr] = parts;

      // Suppress browser tooltip while our custom one is showing
      savedTitle = el.getAttribute('title');
      el.removeAttribute('title');

      tooltipEl = createTooltip(el);
      tooltipEl.innerHTML = `<span class="spinner"></span> Loading...`;

      const preview = await fetchCasePreview(slug, volume, pageStr, resolveFn);
      if (!tooltipEl) return;

      if (preview) {
        tooltipEl.innerHTML = `<div><strong>${esc(preview.name)}</strong><br><span style="opacity:0.7">${esc(preview.cite)} &mdash; ${esc(preview.date)}</span></div>`;
      } else {
        tooltipEl.innerHTML = 'Could not load preview';
      }
    });

    el.addEventListener('mouseleave', () => {
      if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
      }
      // Restore title for accessibility
      if (savedTitle !== null) {
        el.setAttribute('title', savedTitle);
        savedTitle = null;
      }
    });

    // Click opens citation in new tab
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const href = el.getAttribute('href');
      if (href) {
        window.open(window.location.pathname + href, '_blank');
      }
    });
  });
}

function createTooltip(anchor) {
  const tip = document.createElement('div');
  tip.className = 'cite-tooltip';
  document.body.appendChild(tip);
  const rect = anchor.getBoundingClientRect();
  tip.style.left = rect.left + 'px';
  tip.style.top = (rect.bottom + 4) + 'px';
  return tip;
}

function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
