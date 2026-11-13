// Citation detection, through citare compiled to WASM. There is no fallback:
// if the WASM fails to load, detectCitations rejects with a WasmLoadError and
// callers show an error, not empty or degraded results.

import { fetchCached, fetchCachedText } from './cache.js';
import { idxEntries } from './idx.js';
import {
  citedSlug, hasAliasVolume, hasIdx, holdsVolume, indexPath, loadManifest, volumeCandidates,
} from './manifest.js';
import { indexUrl } from './sources.js';
import { pinSuffix } from './router.js';
import { loadWasm } from './wasm.js';
import { citedPage, filePage, labelCases, pageSegment } from './pagekey.js';

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
    // The edition citare read a variation as (`Ohio St.` for `127 Ohio
    // 545`, citare#86), else null.
    correctedReporter: c.corrected_reporter || null,
    // An official reporter's citation (a state's, the U.S. Reports), which
    // a parallel run shows by default when stare.pub holds it (#160).
    official: Boolean(c.official),
    year: c.year || null,
    start: c.span[0],
    end: c.span[1],
    externalUrl: c.external_url || null,
    law: c.law || null,
    caseLinks: Array.isArray(c.case_links) ? c.case_links : [],
    caseName: c.case_name || null,
    // For a nameless citation in another's subsequent history (`..., cert. denied,
    // 261 Conn. 941`), the name the citation it follows gives (#212), else null.
    historyName: c.history_name || null,
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
 * the shared Codex Publicus page viewer's convention, not UTF-16 code units. Convert
 * to UTF-16 offsets before using them with String.prototype.slice or any
 * other native JS string indexing. renderTextHtml, below, highlights by
 * these offsets.
 */
export async function detectCitations(text) {
  const w = useWasm(await loadWasm());
  return citationsFromRust(JSON.parse(w.detect_citations(text)));
}

/**
 * Parallel-citation reconciliation (#160): `stare::parallel::reconcile`, the
 * rules `stare check` applies, through the WASM. `printings` are
 * `{ run, official, lookup }`: `run` is the index of the first citation of
 * the printing's parallel run (its own index when it starts one or is in
 * none), and `lookup` is `{ status: 'found', case }`,
 * `{ status: 'held_miss' }`, `{ status: 'not_held' }` or
 * `{ status: 'unknown' }`. Resolves to one `{ partner, conflicts, preferred }`
 * per printing, in order. Rejects, with a WasmLoadError, if the WASM fails to
 * load.
 */
export async function reconcileParallels(printings) {
  const w = useWasm(await loadWasm());
  return JSON.parse(w.reconcile_parallels(JSON.stringify(printings)));
}

// The stare WASM once loaded, for groupCitations, which is synchronous: anything that
// groups has detected or reconciled citations through the WASM first.
let loadedWasm = null;

/**
 * Remember the loaded stare WASM module `w` for groupCitations, and return it. The
 * site's own loads call it; tests, which load the module in Node, hand it in.
 */
export function useWasm(w) {
  loadedWasm = w;
  return w;
}

/**
 * Cited cases (#198): `stare::cited::group`, which `stare check` uses too, through
 * the WASM. `input` is `{ entries, places }` (see groupCitations); returns
 * `{ groups, entries, places }`. Throws if the WASM isn't loaded.
 */
export function groupByCase(input) {
  if (!loadedWasm) throw new Error('groupCitations needs the stare WASM loaded first');
  return JSON.parse(loadedWasm.group_citations(JSON.stringify(input)));
}

/** The WASM's `detect_citations` output, parsed, as detectCitations returns it. */
export function citationsFromRust(raw) {
  return raw.map(c => ({
    ...fromRust(c),
    pin: c.pin || null,
    antecedent: c.antecedent ? fromRust(c.antecedent) : null,
    // A parallel citation of the full citation it follows (`123 Ill. 2d 45,
    // 524 N.E.2d 1`): that first citation's raw string, else null.
    parallelTo: Number.isInteger(c.parallel_of) ? raw[c.parallel_of]?.matched_text || null : null,
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
 * through CourtListener's citation metadata" for `cl:<cluster>`, and "Resolved as
 * the U.S. Reports under its reporter's name" for a nominative alias, and "Resolved
 * by the reporter's official page; CAP's scan numbers the case on another page" for
 * an official-page alias, `official:<slug>`. The `cl:` aliases come
 * from CourtListener's `citations` table (publisher, scraper and import data), a
 * third party's metadata; nothing here calls such a link verified.
 */
export function viaLabel(via) {
  if (!via) return '';
  if (via === VIA_NOMINATIVE) return "Resolved as the U.S. Reports under its reporter's name";
  if (isOfficialVia(via)) return "Resolved by the reporter's official page; CAP's scan numbers the case on another page";
  return /^cl:\d+$/.test(via) ? "Resolved through CourtListener's citation metadata" : `Resolved through ${via}`;
}

/**
 * The `via` of a nominative alias: U.S. Reports volumes 1 to 90
 * filed under the early reporter's name and volume (`22 Wall. 238` is `89 U.S. 238`).
 */
export const VIA_NOMINATIVE = 'nominative:us';

/**
 * The `via` of an official-page alias in the U.S. Reports: a case
 * filed at its official page in its own volume (`8 U.S. 29` is CAP's `us/8` page 18).
 * Every reporter's is `official:<slug>` (`isOfficialVia`).
 */
export const VIA_OFFICIAL = 'official:us';

/**
 * Whether `via` is an official-page alias's, in any reporter (`official:ohio`): a case whose official citation gives another page than the one
 * CAP's scan numbers it by.
 */
export function isOfficialVia(via) {
  return /^official:[a-z0-9._-]+$/.test(via || '');
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
 * Given the page as looked up (`slug`, `volume`, `page`), a page several cases start
 * on (#204) answers with an object for its first case too (`via` and `target` null
 * for the volume's own), with `cases`, pageCases' list of them.
 */
export function pageResult(entries, slug = null, volume = null, page = null) {
  if (!entries.length) return false;
  const first = entries[0];
  const cases = slug ? pageCases(slug, volume, page, entries) : [];
  const several = cases.length > 1 ? { cases } : {};
  if (first.source !== 'cap' || !first.reporter) {
    return cases.length > 1 ? { via: null, target: null, ...several } : true;
  }
  return {
    via: first.via || null,
    target: { slug: first.reporter, folder: first.folder, caseFile: first.case_file },
    ...several,
  };
}

// The sequence a case file ends with (`0647-02` is 2), else 1.
function fileSeq(caseFile) {
  const m = /-(\d+)$/.exec(String(caseFile || ''));
  return m ? Math.max(parseInt(m[1], 10), 1) : 1;
}

// The case an alias's target names, as caseIdentity names it, or null.
function aliasIdentity(target) {
  const file = String(target?.caseFile || '');
  const page = filePage(file);
  if (!target?.slug || page === null) return null;
  const seq = fileSeq(file);
  const volume = String(target.folder || '').replace(/-\d+$/, '');
  return `${target.slug}/${volume}/${page}${seq > 1 ? `-${seq}` : ''}`;
}

/**
 * Every case that starts at `page` of `volume` (as cited) of `slug`, from the page's
 * index entries (#204), as `stare::parallel::page_cases` lists them: the volume's own
 * CAP cases, then the cases aliases name, then, on a page with neither, each
 * CourtListener record. Each is `{ id, slug, volume, page, seq, aliasOf, via }`: `id`
 * as caseIdentity names the case, and the rest the fields a citation that opens it
 * links with, and `ref`, where its name is read from (#212): `{ source: 'cap', reporter,
 * folder, caseFile }` for a CAP case, the index entry (`cluster_id`, `hash`) for a
 * CourtListener record. The first is the case a reader opens at the page.
 */
export function pageCases(slug, volume, page, entries) {
  const cited = String(volume);
  const at = `${slug}/${cited.replace(/-\d+$/, '')}/${citedPage(page)}`;
  const cases = [];
  const push = (c) => { if (c.id && !cases.some(x => x.id === c.id)) cases.push(c); };
  const own = (seq, ref) => ({
    id: seq > 1 ? `${at}-${seq}` : at, slug, volume: cited, page, seq: seq > 1 ? seq : null, aliasOf: null, via: null, ref,
  });
  let cap = false;
  for (const e of entries || []) {
    if (e.source !== 'cap') continue;
    cap = true;
    if (e.reporter) {
      const target = { slug: e.reporter, folder: e.folder, caseFile: e.case_file };
      const seq = fileSeq(e.case_file);
      push({
        id: aliasIdentity(target), slug: e.reporter, volume: e.folder, page: String(filePage(e.case_file)),
        seq: seq > 1 ? seq : null, aliasOf: target, via: e.via || null,
        ref: { source: 'cap', reporter: e.reporter, folder: e.folder, caseFile: e.case_file },
      });
    } else {
      push(own(fileSeq(e.case_file), { source: 'cap', reporter: slug, folder: e.folder || cited, caseFile: e.case_file }));
    }
  }
  if (!cap) {
    (entries || []).filter(e => e.source === 'cl')
      .forEach((e, i) => push(own(i + 1, { source: 'cl', cluster_id: e.cluster_id, hash: e.hash })));
  }
  return cases;
}

// A volume folder's .multi text, or null when it has none (a 404).
async function readMulti(slug, volume) {
  const key = await indexPath(`${slug}/${volume}.multi`);
  return fetchCachedText('multi', key, indexUrl(key));
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
 * `deps` ({ manifest, readBin, readMulti, lookup, idxEntries, retryDelay }) are injectable for
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
  const p = citedPage(page);
  if (p === null) return false;
  const cited = String(volume);
  const m = deps.manifest || await loadManifest();
  if (hasIdx(m)) {
    const entries = await (deps.idxEntries || idxEntries)(slug, cited, p);
    if (entries) return pageResult(entries, slug, cited, page);
  }
  return capHasPage(slug, cited, p, m, deps);
}

async function capHasPage(slug, cited, p, m, deps) {
  // A labelled page (`xxix`) is in the folder's .multi; a split volume's other folders
  // cover number ranges only.
  if (typeof p === 'string') return labelCases(await (deps.readMulti || readMulti)(slug, cited), p).length > 0;
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
 * - `seq`: the case's sequence at its page when it isn't the first (#204), else
 *   null
 * - `pageCases`: for a page several cases start on (#204), pageCases' list of
 *   them, which parallel-citation reconciliation compares; else null
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
  const none = { ...c, key: citationKey(c), slug: null, volumeHeld: false, resolvable: false, via: null, aliasOf: null, seq: null, pageCases: null };
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
  const aliasFields = {
    via: alias?.via || null, aliasOf: alias?.target || null, seq: null, pageCases: alias?.cases || null,
  };
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
  const own = { ...c, key: citationKey(c), page: null, slug: null, volumeHeld: false, resolvable: false, externalUrl: null, law: a?.law || null, caseLinks: [], via: null, aliasOf: null, seq: null };
  if (!a) return { ...own, noAntecedent: true };
  if (safeExternalUrl(a.externalUrl) && c.pin) return own;
  return {
    ...own,
    slug: a.slug,
    harvard_slug: a.harvard_slug,
    reporter: a.reporter,
    correctedReporter: a.correctedReporter || null,
    volume: a.volume,
    page: a.page,
    volumeHeld: a.volumeHeld,
    resolvable: a.resolvable,
    pageUnknown: a.pageUnknown,
    externalUrl: a.externalUrl,
    caseLinks: a.caseLinks,
    via: a.via || null,
    aliasOf: a.aliasOf || null,
    seq: a.seq || null,
    partner: a.partner || null,
  };
}

/**
 * Check a list of detected citations, each distinct citation once: full
 * citations by raw string, short forms through their antecedent's status
 * (looked up once, with the antecedent's own entry). Returns one entry per
 * `citationKey`, in order of first occurrence. `check`, `pageCheck` and
 * `reconcile` are injectable for tests, as in processCitations.
 */
export async function checkCitations(
  citations, check = checkAvailability, pageCheck = checkPage, reconcile = reconcileParallels,
  readNames = readCaseNamesLazily,
) {
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
  const reconciled = await applyParallels(citations, await Promise.all(entries.values()), reconcile);
  return applyNames(reconciled, readNames);
}

// casenames.js's readCaseNames, loaded when a page several cases share is cited.
async function readCaseNamesLazily(pageCase) {
  return (await import('./casenames.js')).readCaseNames(pageCase);
}

/**
 * The case the citing text's `name` (and `year`, or null) means among `cases`
 * (`[{ id, names, date }]`), by `stare::byname::pick` through the WASM: its id, or
 * null when no one case matches clearly. Null too when the WASM isn't loaded.
 */
export function matchCaseName(cases, name, year = null) {
  if (!loadedWasm) return null;
  return loadedWasm.match_case_name(JSON.stringify(cases), name, year ?? undefined) ?? null;
}

/**
 * The owner's rulings D90 and D98 (1), by `stare::byname::pick_on_official_page`
 * through the WASM: for the official printing of a run whose printings share `shared`
 * (their ids), the case on its whole page (`cases`, `[{ id, names, date }]`) the citing
 * text's `name` means, when the shared cases miss it (several, none of which fits; or
 * one that clearly doesn't) and exactly one case on the page fits. Its id, or null;
 * null too when the WASM isn't loaded.
 */
export function matchCaseNameOfficial(cases, shared, name, year = null) {
  if (!loadedWasm) return null;
  return loadedWasm.match_case_name_official(JSON.stringify(cases), JSON.stringify(shared), name, year ?? undefined) ?? null;
}

// The cases a checked full citation is still open among, as `{ open, shared }` (`shared`
// when its parallel citations narrowed the page's cases to them), or null when
// something else settles it: a run whose printings share one case (or none), or a page
// with one case.
function namesOpen(e) {
  if (!e.resolvable || e.partner || e.conflicts?.length || !e.pageCases?.length) return null;
  const open = Array.isArray(e.tied) ? e.tied : e.pageCases.map(x => x.id);
  return open.length > 1 ? { open, shared: open.length < e.pageCases.length } : null;
}

// For a run's official printing (`runOfficial`) whose printings share one case at a page
// several cases start on, that case's id (D98 (1)); null for any other citation.
function sharesOne(e) {
  if (!e.resolvable || e.partner || e.conflicts?.length || e.runOfficial !== e.raw) return null;
  if (!Array.isArray(e.tied) || e.tied.length || (e.pageCases?.length || 0) < 2) return null;
  return caseIdentity(e) || null;
}

/**
 * Picking the case at a page several cases start on by the citing text's case name
 * (#212, D72 (2)): for each of checkCitations' full citations whose page has several
 * cases and nothing else to say which it means (no alias names one, and its parallel
 * citations, if any, share more than one), compare its case name (`caseName`, or for
 * subsequent history `historyName`) and year with each case's names and decision date
 * (`readNames(pageCase)`, `{ names, date }`), and open the one case that matches
 * clearly. That citation gets the case's `slug`, `volume`, `page`, `seq`, `aliasOf`
 * and `via`, and `byName`, `{ among, shared }`, the number of cases it was picked
 * among and whether those were the ones its parallel citations share (byNameLabel).
 * A parallel citation resolved through it, and a short form of either, follow it.
 * Anything that doesn't match, or can't be read, keeps opening the page's first case.
 *
 * When a run's printings share several cases and none of them fits the name, the
 * run's official printing (`runOfficial`, applyParallels) is matched against every
 * case at its page (D90, `matchOfficial`), and when exactly one fits, every printing
 * of the run opens it, with `byName` `{ among, shared: false, official }`, `among`
 * the cases at the official page and `official` its raw string. A printing whose own
 * page doesn't list the case opens it without a `via`. Likewise when the run's
 * printings share one case and it clearly isn't the one the name names (D98 (1)),
 * with `sharesOne: true` in `byName`.
 */
export async function applyNames(
  checked, readNames = readCaseNamesLazily, match = matchCaseName, matchOfficial = matchCaseNameOfficial,
) {
  const picks = new Map();
  const officialPicks = new Map();
  // The citations a name would have decided among cases whose names couldn't be read (#271):
  // they open the page's first case, and say so (byNameLabel).
  const unread = new Set();
  const readCase = async (x) => {
    let failed = false;
    const read = await Promise.resolve(readNames(x)).catch((err) => {
      console.warn(`Couldn't read the case names for ${x.id}:`, err);
      failed = true;
      return null;
    });
    return { id: x.id, names: read?.names || [], date: read?.date || null, failed };
  };
  await Promise.all(checked.map(async (e) => {
    if (isShortForm(e) || picks.has(e.raw)) return;
    const name = e.caseName || e.historyName;
    if (!name) return;
    const one = sharesOne(e);
    if (one) {
      try {
        const page = await Promise.all(e.pageCases.map(readCase));
        const official = await matchOfficial(page, [one], name, e.year ?? null);
        const pick = official && e.pageCases.find(x => x.id === official);
        if (pick) officialPicks.set(e.raw, { to: pick, among: e.pageCases.length, shared: false, official: e.raw, sharesOne: true });
      } catch {
        // A name that can't be read or matched leaves the case the run shares.
      }
      return;
    }
    const at = namesOpen(e);
    if (!at) return;
    try {
      const cases = await Promise.all(e.pageCases.filter(x => at.open.includes(x.id)).map(readCase));
      if (cases.some(c => c.failed)) unread.add(e.raw);
      if (!cases.some(c => c.names.length)) return;
      const id = await match(cases, name, e.year ?? null);
      const to = id && e.pageCases.find(x => x.id === id);
      if (to) picks.set(e.raw, { to, among: at.open.length, shared: at.shared });
      else if (at.shared && e.runOfficial === e.raw) {
        const page = await Promise.all(e.pageCases.map(readCase));
        const official = await matchOfficial(page, at.open, name, e.year ?? null);
        const pick = official && e.pageCases.find(x => x.id === official);
        if (pick) officialPicks.set(e.raw, { to: pick, among: e.pageCases.length, shared: false, official: e.raw });
      }
    } catch {
      // A name that can't be read or matched leaves the page's first case.
    }
  }));
  // Every printing of a run its official printing's page decided opens that case.
  for (const e of checked) {
    const p = !isShortForm(e) && !e.partner && e.runOfficial && officialPicks.get(e.runOfficial);
    if (!p) continue;
    const own = (e.pageCases || []).find(x => x.id === p.to.id);
    picks.set(e.raw, { ...p, to: own || { ...p.to, via: null } });
  }
  for (const raw of picks.keys()) unread.delete(raw);
  if (!picks.size && !unread.size) return checked;
  const changed = new Map();
  for (const e of checked) {
    if (!isShortForm(e) && unread.has(e.raw)) changed.set(e.raw, { ...e, namesUnread: true });
  }
  for (const e of checked) {
    const p = !isShortForm(e) && picks.get(e.raw);
    if (!p) continue;
    const { to } = p;
    changed.set(e.raw, {
      ...e, slug: to.slug, volume: to.volume, page: to.page, seq: to.seq, aliasOf: to.aliasOf, via: to.via,
      byName: {
        among: p.among, shared: p.shared,
        ...(p.official ? { official: p.official } : {}), ...(p.sharesOne ? { sharesOne: true } : {}),
      },
    });
  }
  for (const e of checked) {
    const p = !isShortForm(e) && e.partner && changed.get(e.partner);
    if (p && !changed.has(e.raw)) {
      changed.set(e.raw, { ...e, slug: p.slug, volume: p.volume, page: p.page, seq: p.seq || null, aliasOf: p.aliasOf || null });
    }
  }
  return checked.map((c) => {
    if (!isShortForm(c)) return changed.get(c.key ?? c.raw) || c;
    const a = c.antecedent && changed.get(c.antecedent.raw);
    return a ? inheritStatus(c, a) : c;
  });
}

/**
 * The note on a citation picked by its case name at a shared page (#212): "Matched
 * by case name among the 3 cases on this page", or "... among the 2 cases its
 * parallel citations share" when its parallel citations had narrowed them, or, when
 * its official printing's page decided (D90), "... among the 12 cases on the official
 * page, 455 U.S. 989; the cases its parallel citations share don't include it" ("...;
 * the case its parallel citations share doesn't fit the name" when they shared one,
 * D98 (1)). '' for any other citation.
 */
export function byNameLabel(c) {
  if (c?.namesUnread && !c.byName) {
    return "Several cases start on this page and their names couldn't be read, so this opens the first of them";
  }
  if (!c?.byName) return '';
  const { among, shared, official, sharesOne } = c.byName;
  if (official) {
    const missed = sharesOne
      ? "the case its parallel citations share doesn't fit the name"
      : "the cases its parallel citations share don't include it";
    return `Matched by case name among the ${among} cases on the official page, ${official}; ${missed}`;
  }
  return shared
    ? `Matched by case name among the ${among} cases its parallel citations share`
    : `Matched by case name among the ${among} cases on this page`;
}

// What the index says of a checked full citation, for reconcileParallels: every
// case at its page (#204), the one it opens first.
function parallelLookup(c) {
  if (c.resolvable) {
    const id = caseIdentity(c);
    if (!id) return { status: 'unknown' };
    const others = (c.pageCases || []).map(x => x.id).filter(x => x && x !== id);
    return { status: 'found', cases: [id, ...others] };
  }
  if (c.pageUnknown || !c.page || !c.volume || c.externalUrl || isStatute(c)) return { status: 'unknown' };
  return { status: c.volumeHeld ? 'held_miss' : 'not_held' };
}

/**
 * Parallel-citation reconciliation (#160) over checkCitations' entries
 * (`checked`), for the parallel runs citare finds in `detected`
 * (`parallelTo`), by the rules of `reconcile` (reconcileParallels, the
 * WASM's, unless a test injects one):
 *
 * - A member that doesn't resolve on its own, in a run whose members that
 *   do all open one case, resolves through the run's preferred printing:
 *   it gets that printing's `slug`, `volume`, `page` and `aliasOf`, so it
 *   opens the same case, and `partner`, the printing's raw string, which
 *   labels it "inferred from the citing text" (partnerLabel). A short form
 *   whose antecedent it is follows it.
 * - Members that open different cases get `conflicts`, the raw strings of
 *   the others, and `conflictRun`, the run's first citation; groupCitations
 *   keeps them apart, and each is flagged as needing review.
 * - The run's preferred printing (the official reporter's, when stare.pub
 *   holds it) gets `preferred`, which groupCitations shows first.
 *
 * Resolves to the entries in the same order, the changed ones replaced. A
 * text with no parallel run never calls `reconcile`.
 */
export async function applyParallels(detected, checked, reconcile = reconcileParallels) {
  const byKey = new Map(checked.map(c => [c.key ?? c.raw, c]));
  const members = [];
  const lastAt = new Map();
  for (const c of detected || []) {
    if (c.type !== 'FullCaseCitation' || !byKey.has(c.raw)) continue;
    const run = c.parallelTo && lastAt.has(c.parallelTo) ? members[lastAt.get(c.parallelTo)].run : members.length;
    lastAt.set(c.raw, members.length);
    members.push({ raw: c.raw, run, official: Boolean(c.official) });
  }
  if (!members.some((m, i) => m.run !== i)) return checked;

  const entryOf = (m) => byKey.get(m.raw);
  const verdicts = await reconcile(members.map(m => ({
    run: m.run, official: m.official, lookup: parallelLookup(entryOf(m)),
  })));
  const changed = new Map();
  const current = (raw) => changed.get(raw) || byKey.get(raw);
  // Each run's official printing, when it is the one the run shows by default (D90).
  const officialOf = new Map();
  verdicts.forEach((v, i) => { if (v.preferred && members[i].official) officialOf.set(members[i].run, members[i].raw); });
  const update = (raw, fields) => changed.set(raw, { ...current(raw), ...fields });
  verdicts.forEach((v, i) => {
    const m = members[i];
    if (v.conflicts.length) {
      const others = v.conflicts.map(j => members[j].raw).filter(r => r !== m.raw);
      update(m.raw, { conflicts: [...new Set(others)], conflictRun: members[m.run].raw });
    }
    if (v.preferred) update(m.raw, { preferred: true });
    // The cases a run that agrees shares when there are several (#212), which the
    // citing text's case name may decide among (applyNames); none past `case` else.
    if (v.case) {
      update(m.raw, { tied: v.tied || [], ...(officialOf.has(m.run) ? { runOfficial: officialOf.get(m.run) } : {}) });
    }
    // A member that resolves opens the case its run agrees on, which at a page several
    // cases start on can be other than the first (#204).
    const e = current(m.raw);
    if (v.case && e.resolvable && !e.partner && caseIdentity(e) !== v.case) {
      const to = (e.pageCases || []).find(x => x.id === v.case);
      if (to) update(m.raw, { slug: to.slug, volume: to.volume, page: to.page, seq: to.seq, aliasOf: to.aliasOf, via: to.via });
    }
  });
  verdicts.forEach((v, i) => {
    const m = members[i];
    if (v.partner !== null && !current(m.raw).resolvable) {
      const p = current(members[v.partner].raw);
      update(m.raw, {
        resolvable: true, pageUnknown: false, slug: p.slug, volume: p.volume, page: p.page, seq: p.seq || null,
        via: null, aliasOf: p.aliasOf || null, partner: p.raw,
      });
    }
  });
  if (!changed.size) return checked;
  return checked.map((c) => {
    if (!isShortForm(c)) return changed.get(c.key ?? c.raw) || c;
    const a = c.antecedent && changed.get(c.antecedent.raw);
    return a ? inheritStatus(c, a) : c;
  });
}

/**
 * The hash suffix for a case after the first at its page (#204): `-02` for `seq` 2,
 * as the reader's links name it; '' for the first, which the page alone opens.
 */
export function seqSuffix(seq) {
  return seq > 1 ? `-${String(seq).padStart(2, '0')}` : '';
}

/**
 * The label on a citation resolved through its parallel partner (#160): "Reported
 * at 128 Neb. 783, inferred from the citing text". citare read the two as one
 * decision; no data says so, and nothing here calls the link verified. '' for
 * any other citation.
 */
export function partnerLabel(c) {
  return c?.partner ? `Reported at ${c.partner}, inferred from the citing text` : '';
}

/**
 * The flag on a citation whose parallel citations open a different case (#160):
 * "Cited in parallel with 31 A.2d 650, which opens a different case; needs
 * review". '' for any other citation.
 */
export function conflictNote(c) {
  if (!c?.conflicts?.length) return '';
  const many = c.conflicts.length > 1;
  return `Cited in parallel with ${c.conflicts.join(' and ')}, which ${many ? 'open' : 'opens'} a different case; needs review`;
}

// ---------------------------------------------------------------------------
// Process citations for a case
// ---------------------------------------------------------------------------

/**
 * Process all citations in a case's opinions.
 * Uses citare for detection, checks availability for each.
 *
 * Returns `{ unique, occurrencesByOpinion, groups }`:
 * - `unique`: one entry per `citationKey` (a full citation's raw string; a
 *   short form's raw string and antecedent), with availability (`slug`,
 *   `resolvable`) resolved; the sidebar's list.
 * - `occurrencesByOpinion`: for each opinion in `casebody.opinions`, in
 *   order, every detected occurrence as `{ raw, key, pin, start, end, place }`,
 *   where `start`/`end` are code point offsets into that opinion's `text`.
 *   The reader highlights from these, looking each `key` up in `unique`.
 * - `groups`: groupCitations' cited cases, one per case, for the lists.
 *
 * `check`, `detect`, `pageCheck` and `reconcile` are injectable replacements
 * for `checkAvailability`, `detectCitations`, `checkPage` and
 * `reconcileParallels`, used by tests to stub the network fetch and to hand
 * in the WASM, which Node can't load from the site path. Rejects, with a
 * WasmLoadError, if the WASM fails to load.
 *
 * `signal` (an AbortSignal) ends the pass once another case replaces this one (#267):
 * no detection, index lookup or name read starts after it aborts, and the pass rejects
 * with its reason, an AbortError, instead of returning.
 */
export async function processCitations(
  caseData, check = checkAvailability, detect = detectCitations, pageCheck = checkPage,
  reconcile = reconcileParallels, readNames = readCaseNamesLazily, { signal = null } = {},
) {
  // Each step checks the signal before it starts and once it's done.
  const step = (fn) => async (...args) => {
    signal?.throwIfAborted();
    const out = await fn(...args);
    signal?.throwIfAborted();
    return out;
  };
  if (signal) {
    [check, detect, pageCheck, reconcile, readNames] = [check, detect, pageCheck, reconcile, readNames].map(step);
  }
  const allCites = [];
  const byOpinion = [];

  for (const op of caseData.casebody?.opinions || []) {
    const detected = await detect(op.text);
    allCites.push(...detected);
    byOpinion.push(detected);
  }

  const unique = await checkCitations(allCites, check, pageCheck, reconcile, readNames);
  signal?.throwIfAborted();
  // Grouping numbers each citation's place in the text, which the occurrences carry.
  const groups = groupCitations(allCites, unique);
  const occurrencesByOpinion = byOpinion.map(detected => detected.map(c => occurrence(c)));
  return { unique, occurrencesByOpinion, groups };
}

/**
 * One detected citation as the renderers place it: `{ raw, key, pin, start, end,
 * place }`, `place` the citing place groupCitations numbered it with (#198: the
 * printings of a parallel run share one), or null before grouping.
 */
export function occurrence(c) {
  return { raw: c.raw, key: citationKey(c), pin: c.pin || null, start: c.start, end: c.end, place: c.place ?? null };
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
  return `No case found at this page in ${info.correctedReporter || info.reporter || info.slug} vol. ${info.volume}`;
}

/**
 * For a citation to a held volume whose index couldn't be read (checkPage's
 * null, after its retry), the note to show; else null. It is neither a link
 * nor a miss: the case may well be there (#144).
 */
export function lookupFailed(info) {
  if (!info?.pageUnknown || info.resolvable || !info.volumeHeld) return null;
  return `Couldn't reach the index for ${info.correctedReporter || info.reporter || info.slug} vol. ${info.volume}; reload to try again`;
}

/**
 * For a full citation whose reporter citare read as a variation of an
 * edition with another name (citare#86), what it was read as: "Read as 127
 * Ohio St. 545" for `127 Ohio 545`, which stare.pub looks up under the Ohio
 * State Reports. Null otherwise.
 */
export function readAs(info) {
  if (!info?.correctedReporter || isShortForm(info) || !info.volume || !info.page) return null;
  return `Read as ${info.volume} ${info.correctedReporter} ${info.page}`;
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
function citationHtml(raw, inner, info, pin = info.pin, place = null) {
  const html = citationElementHtml(raw, inner, info, pin);
  // Its place among the cited case's appearances (#159): the group it is
  // listed under, the citing place it is part of (#198: a parallel run's
  // printings are one), and whether it is a short form, which the highlight
  // marks apart from a full citation.
  if (!info.group || isSectionReference(info)) return html;
  const form = isShortForm(info) ? ' data-cite-form="short"' : '';
  const at = place != null ? ` data-cite-place="${escapeHtml(String(place))}"` : '';
  return html.replace(/^<(a|span) /, `<$1 data-cite-group="${escapeHtml(info.group)}"${at}${form} `);
}

function citationElementHtml(raw, inner, info, pin) {
  if (isSectionReference(info)) {
    return `<span class="cite-section" title="${escapeHtml(SECTION_NOTE)}">${inner}</span>`;
  }
  const refers = refersTo(info, pin);
  if (info.noAntecedent) {
    return `<span class="cite-unresolved cite-no-antecedent" title="${escapeHtml(NO_ANTECEDENT)}">${inner}</span>`;
  }
  const read = readAs(info);
  const titled = (note) => escapeHtml([refers, read, note].filter(Boolean).join('. '));
  const externalUrl = safeExternalUrl(info.externalUrl);
  if (externalUrl) {
    return `<a class="cite-link cite-external" href="${escapeHtml(externalUrl)}" ${OUTBOUND} title="${titled('View on external site')}">${inner}</a>`;
  }
  if (info.resolvable) {
    const slug = escapeHtml(info.slug);
    const volume = escapeHtml(String(info.volume));
    const page = escapeHtml(String(info.page));
    const segment = escapeHtml(pageSegment(citedPage(info.page) ?? info.page));
    const pinAttr = pin ? ` data-pin="${escapeHtml(pin)}"` : '';
    const at = escapeHtml(pinSuffix(pin, info.page));
    const via = viaLabel(info.via) || partnerLabel(info);
    const title = [refers || raw, read, via, byNameLabel(info), conflictNote(info)].filter(Boolean).join('. ');
    const viaAttr = info.via ? ` data-via="${escapeHtml(info.via)}"` : '';
    const partnerAttr = info.partner ? ` data-partner="${escapeHtml(info.partner)}"` : '';
    const byNameAttr = info.byName ? ` data-by-name="${escapeHtml(String(info.byName.among))}"` : '';
    const review = info.conflicts?.length ? ' cite-review' : '';
    return `<a class="cite-link${review}" href="#${slug}/${volume}/${segment}${seqSuffix(info.seq)}${at}" data-slug="${slug}" data-volume="${volume}" data-page="${page}"${pinAttr}${viaAttr}${partnerAttr}${byNameAttr} title="${escapeHtml(title)}">${inner}</a>`;
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
  return `<span class="cite-unresolved" title="${titled(refers ? '' : 'Not yet indexed')}">${inner}</span>`;
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
export function citedCaseHtml(c, caseHref, caseRel = 'noopener', formCount = null) {
  if (isSectionReference(c)) return '';
  const raw = escapeHtml(c.raw);
  // The places that cite its case in this form, for a case cited in several
  // (citedGroupHtml); it follows the form, wherever the form is a link.
  const countHtml = formCount == null ? '' : ` ${formCountHtml(formCount)}`;
  // A short form's entry stands for every occurrence with its key, whose
  // pins differ, so the sidebar names the antecedent without a pin.
  const refers = refersTo(c, null);
  const refersHtml = refers ? `\n          <span class="cited-lookup cited-miss cited-refers">${escapeHtml(refers)}</span>` : '';
  const wrap = refers ? ' cited-case-lookup' : '';
  if (c.noAntecedent) {
    return `<div class="cited-case${wrap}">
          <span class="cited-status none">&#8211;</span>
          <span class="cited-case-unresolved">${raw}</span>${countHtml}${refersHtml}
        </div>`;
  }
  if (c.resolvable) {
    const rel = caseRel ? ` rel="${escapeHtml(caseRel)}"` : '';
    // A case reached through an alias says where the link came from (#151).
    // So does one resolved through its parallel partner (#160), and one whose
    // parallel citations open a different case is flagged.
    const via = viaLabel(c.via) || partnerLabel(c);
    const viaHtml = via ? `\n          <span class="cited-lookup cited-via">${escapeHtml(via)}</span>` : '';
    // One picked by its case name among the cases at its page says so (#212).
    const named = byNameLabel(c);
    const namedHtml = named ? `\n          <span class="cited-lookup cited-by-name">${escapeHtml(named)}</span>` : '';
    const review = conflictNote(c);
    const reviewHtml = review ? `\n          <span class="cited-lookup cited-review">${escapeHtml(review)}</span>` : '';
    return `<div class="cited-case${via || named || review ? ' cited-case-lookup' : wrap}">
          <span class="cited-status ok">&#10003;</span>
          <a class="cited-case-link" href="${escapeHtml(caseHref(c))}" target="_blank"${rel}>${raw}</a>${countHtml}${refersHtml}${viaHtml}${namedHtml}${reviewHtml}
        </div>`;
  }
  const externalUrl = safeExternalUrl(c.externalUrl);
  if (externalUrl) {
    return `<div class="cited-case${wrap}">
          <span class="cited-status ext">&#8599;</span>
          <a class="cited-case-link" href="${escapeHtml(externalUrl)}" ${OUTBOUND}>${raw}</a>${countHtml}${refersHtml}
        </div>`;
  }
  if (isStatute(c)) {
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status statute">&#167;</span>
          <span class="cited-case-unresolved">${raw}</span>${countHtml}${refersHtml}
          <span class="cited-lookup cited-miss">${escapeHtml(STATUTE_NOTE)}</span>
        </div>`;
  }
  const unknown = lookupFailed(c);
  if (unknown) {
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status unknown">?</span>
          <span class="cited-case-unresolved">${raw}</span>${countHtml}${refersHtml}
          <span class="cited-lookup cited-miss">${escapeHtml(unknown)}</span>
        </div>`;
  }
  const miss = heldVolumeMiss(c);
  if (miss) {
    return `<div class="cited-case cited-case-lookup">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${raw}</span>${countHtml}${refersHtml}
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
          <span class="cited-case-unresolved">${raw}</span>${countHtml}${refersHtml}
          <span class="cited-lookup"><a class="cited-lookup-link" href="${escapeHtml(first.url)}" ${OUTBOUND}>${escapeHtml(lookupLabel(first))}</a>${more}</span>
        </div>`;
  }
  return `<div class="cited-case${wrap}">
          <span class="cited-status no">&#10007;</span>
          <span class="cited-case-unresolved">${raw}</span>${countHtml}${refersHtml}
        </div>`;
}

// ---------------------------------------------------------------------------
// Cited cases: one list entry per case, with its places in the text (#159)
// ---------------------------------------------------------------------------

/**
 * For a citation stare.pub resolves, the case it opens, as a string two
 * citations of the same case share: `slug/volume/page`, with the volume as
 * cited (a split volume's `138-2` folder is volume 138) and `-<seq>` for a
 * case after the first on its page. Null for anything else. A citation
 * resolved through an alias (#151) names the case it reaches, so `260 N.W.
 * 287` and `128 Neb. 783` meet here when the text cites both.
 */
export function caseIdentity(c) {
  if (!c?.resolvable || isShortForm(c)) return null;
  if (c.aliasOf) return aliasIdentity(c.aliasOf);
  if (!c.slug || c.volume == null || c.page == null) return null;
  const seq = c.seq > 1 ? `-${c.seq}` : '';
  return `${c.slug}/${String(c.volume).replace(/-\d+$/, '')}/${citedPage(c.page)}${seq}`;
}

/**
 * Which category a list entry's status chips filter it under: `held` (a
 * case stare.pub opens), `statute` (a statute or regulation, linked or
 * not), `elsewhere` (a case in a volume stare.pub doesn't hold yet) or
 * `unresolved` (a miss in a held volume, an index that couldn't be read, a
 * short form with no antecedent).
 */
export function citeCategory(c) {
  if (c.conflicts?.length) return 'review';
  if (c.resolvable) return 'held';
  if (isStatute(c) || safeExternalUrl(c.externalUrl)) return 'statute';
  if (c.noAntecedent || heldVolumeMiss(c) || lookupFailed(c)) return 'unresolved';
  return 'elsewhere';
}

/** The status chips' labels, by citeCategory, in the order they're shown. */
export const CITE_CATEGORIES = [
  ['held', 'In stare.pub'],
  ['review', 'Needs review'],
  ['elsewhere', 'Not yet indexed'],
  ['statute', 'Statutes'],
  ['unresolved', 'Unresolved'],
];

/**
 * Text for the list filter to match: lowercased, with punctuation dropped,
 * so `a.2d` and `A.2d` meet. Letters and digits of any script stay; runs of
 * anything else become one space.
 */
export function searchText(str) {
  return String(str || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A filter query's words, as searchText makes them. */
export function filterTokens(query) {
  const t = searchText(String(query || '').replace(/[.'’]/g, ''));
  return t ? t.split(' ') : [];
}

/**
 * Whether an entry's search text (groupCitations' `search`) has every word
 * of a query (filterTokens), each anywhere in it; spaces in the entry are
 * ignored too, so `a2d` finds `A. 2d`.
 */
export function matchesFilter(search, tokens) {
  if (!tokens.length) return true;
  const spaced = String(search || '');
  const joined = spaced.replace(/ /g, '');
  return tokens.every(t => spaced.includes(t) || joined.includes(t));
}

/**
 * The cited cases in a text (#159, #198): checkCitations' entries (`checked`)
 * gathered one group per case, in order of first appearance, by
 * `stare::cited::group` (groupByCase, the WASM's, unless a test injects one). A
 * group holds every citation that resolves to one case (caseIdentity): its
 * printings, a parallel citation resolved through its partner, an alias; the
 * members of a parallel run (citare's reading of `123 Ill. 2d 45, 524 N.E.2d 1`,
 * the detected citation's `parallelTo`) unless reconciliation flagged them for
 * review, which stay apart; and the short forms whose antecedent is one of those
 * (`Id.`, `supra`, short cites). A citation that resolves to nothing groups by its
 * reporter, volume and page, so spellings of it meet. A short form to a statute
 * with a pin of its own (`Id. § 1985`) is a different section and stays apart, as
 * does one with no antecedent. Bare section references aren't grouped.
 *
 * `detected` is every detected citation (detectCitations' output, across
 * opinions), for the parallels and the count; null leaves both out. Each gets
 * `place`, its citing place in the text: the printings of a parallel run share
 * one, which the text's citations carry as `data-cite-place`.
 *
 * Each group is `{ id, members, primary, count, search, category }`: `id`
 * is `g0`, `g1`, ...; `members` its entries in order; `primary` the one the
 * list shows (a parallel run's preferred printing, else an official
 * reporter's that stare.pub holds, else the first it holds, else the first
 * full citation, else the first entry); `count` how many places in the text
 * cite it, a parallel run one place and each short form one more (null
 * without `detected`); `search` the filter's text for it (every citation
 * form, the reporters, and the case names the text gives); and `category`
 * citeCategory of the primary. Every entry also gets `group`, its group's
 * id, which the text's citations carry as `data-cite-group`, and `formCount`,
 * the places that cite the case in its form: a parallel run once for each of
 * its printings, a short form where it appears (null without `detected`),
 * and `formPlaces`, those places' ids.
 */
export function groupCitations(detected, checked, group = groupByCase) {
  const keyOf = (c) => c.key ?? c.raw;
  const entries = (checked || []).filter(c => !isSectionReference(c));
  const fullKeys = new Set(entries.filter(c => !isShortForm(c)).map(keyOf));
  const lastAt = new Map();
  const places = (detected || []).map((c, i) => {
    const parallelOf = c.parallelTo && lastAt.has(c.parallelTo) ? lastAt.get(c.parallelTo) : null;
    lastAt.set(c.raw, i);
    return { key: citationKey(c), parallel_of: parallelOf };
  });
  const out = group({ entries: entries.map(c => groupEntry(c, fullKeys)), places });

  const groups = out.groups.map((g, i) => ({ id: `g${i}`, members: g.members.map(j => entries[j]), count: g.count }));
  entries.forEach((c, j) => {
    c.group = groups[out.entries[j]].id;
    c.formCount = detected ? out.entry_counts[j] : null;
  });
  // Each entry's places, so a form that folds several entries (citedForms)
  // counts a place they share once.
  const entryOfKey = new Map(entries.map(c => [keyOf(c), c]));
  entries.forEach((c) => { c.formPlaces = detected ? [] : null; });
  (detected || []).forEach((c, i) => {
    c.place = out.places[i] ?? null;
    const e = entryOfKey.get(places[i].key);
    if (e && c.place != null && !e.formPlaces.includes(c.place)) e.formPlaces.push(c.place);
  });

  const groupOfKey = new Map(entries.map(c => [keyOf(c), c.group]));
  const names = new Map();
  for (const c of detected || []) {
    if (c.caseName && fullKeys.has(c.raw)) {
      const g = groupOfKey.get(c.raw);
      if (!names.has(g)) names.set(g, new Set());
      names.get(g).add(c.caseName);
    }
  }

  for (const g of groups) {
    const full = g.members.filter(m => !isShortForm(m));
    const own = (m) => m.resolvable && !m.partner;
    // A parallel run's preferred printing (#160), else the official reporter's
    // printing stare.pub holds on its own, else any it holds on its own, else one
    // resolved through its partner.
    g.primary = full.find(m => m.preferred) || full.find(m => own(m) && m.official) || full.find(own)
      || full.find(m => m.resolvable) || full[0] || g.members[0];
    if (!detected) g.count = null;
    g.category = citeCategory(g.primary);
    const words = [];
    for (const m of g.members) {
      words.push(m.raw, m.reporter, m.caseName, m.antecedent?.raw);
    }
    words.push(...(names.get(g.id) || []));
    g.search = searchText([...new Set(words.filter(Boolean))].join(' '));
  }
  return groups;
}

// One entry as stare::cited::group reads it: `{ key, case, citation, antecedent, review }`.
function groupEntry(c, fullKeys) {
  const key = c.key ?? c.raw;
  if (isShortForm(c)) {
    // A short form joins its antecedent's case unless its status is its own
    // (inheritStatus: a pinned short form of a linked statute).
    const own = safeExternalUrl(c.antecedent?.externalUrl) && c.pin;
    const antecedent = c.antecedent && !own && fullKeys.has(c.antecedent.raw) ? c.antecedent.raw : null;
    return { key, case: null, citation: null, antecedent, review: false };
  }
  const id = caseIdentity(c);
  return { key, case: id, citation: id ? null : citedForm(c), antecedent: null, review: Boolean(c.conflicts?.length) };
}

// A case citation that doesn't resolve, normalized (`a2d/31/950`), or null.
function citedForm(c) {
  if (isStatute(c) || c.externalUrl || c.volume == null || !c.page) return null;
  const slug = c.slug || (c.reporter ? guessSlug(c.reporter) : null);
  const page = citedPage(c.page);
  return slug && page !== null ? `${slug}/${c.volume}/${page}` : null;
}

// A form's count of places in the text: `(2×)`.
function formCountHtml(n) {
  return `<span class="cited-form-count" title="${n} ${n === 1 ? 'place cites' : 'places cite'} it in this form">(${n}×)</span>`;
}

// The kinds of short form a cited case's entry folds its short forms into
// (D81), by citare's type, in the order they're listed: an `Id.`, a `supra`,
// and a short cite (`303 Conn. at 850`, or a reference by the case's name).
const SHORT_FORM_KINDS = [
  { kind: 'id', label: 'Id.', types: ['IdCitation'] },
  { kind: 'supra', label: 'supra', types: ['SupraCitation'] },
  { kind: 'short', label: 'a short cite', types: ['ShortCaseCitation', 'ReferenceCitation'] },
];

/**
 * The forms a cited case's entry lists (D72, D81): the primary citation, then
 * its other full citations (a parallel citation, another reporter that opens
 * the same case), each once by its text, as `{ member, count }`; then its
 * short forms folded into one form per kind (SHORT_FORM_KINDS), as `{ kind,
 * label, texts, member, count }`, `texts` the short forms' own texts. `count`
 * is the places that cite the case in that form (its members' `formPlaces`,
 * a place they share once), null without counts. A short form with the primary's text (a group
 * of short forms alone) counts with the primary.
 */
export function citedForms(g) {
  const forms = new Map();
  const add = (id, m, extra) => {
    const f = forms.get(id);
    if (!f) forms.set(id, { ...extra, member: m, count: m.formCount ?? null, places: new Set(m.formPlaces ?? []), seen: new Set([m]) });
    else if (!f.seen.has(m)) {
      f.seen.add(m);
      for (const p of m.formPlaces ?? []) f.places.add(p);
      // A place two of its entries share counts once (a run of two short cites).
      f.count = f.count != null && m.formCount != null ? (m.formPlaces ? f.places.size : f.count + m.formCount) : null;
      if (f.texts && !f.texts.includes(m.raw)) f.texts.push(m.raw);
    }
  };
  if (g.primary) add(`raw:${g.primary.raw}`, g.primary, {});
  for (const m of g.members.filter(m => !isShortForm(m))) add(`raw:${m.raw}`, m, {});
  for (const k of SHORT_FORM_KINDS) {
    for (const m of g.members.filter(m => isShortForm(m) && k.types.includes(m.type))) {
      if (m.raw === g.primary?.raw) add(`raw:${m.raw}`, m, {});
      else add(`kind:${k.kind}`, m, { kind: k.kind, label: k.label, texts: [m.raw] });
    }
  }
  return [...forms.values()].map(({ seen, places, ...f }) => f);
}

/**
 * One cited case's list entry: the primary citation's entry (citedCaseHtml,
 * with its status, link and labels unchanged), the case's other forms, and,
 * when the text cites it, a control that shows where, with the count and the
 * previous and next controls citenav.js drives. A case cited in more than one
 * form gives each form its own count of places (citedForms). '' for a group
 * with no entry (citedCaseHtml's '').
 */
export function citedGroupHtml(g, caseHref, caseRel = 'noopener') {
  const forms = citedForms(g);
  const counted = forms.length > 1;
  const countOf = (f) => (counted && f.count != null ? f.count : null);
  const inner = citedCaseHtml(g.primary, caseHref, caseRel, countOf(forms[0]));
  if (!inner) return '';
  // Each other form: a full citation with the label or note its own entry
  // would have (where an alias came from, a miss in a held volume, an index
  // that couldn't be read), or one kind of short form, which names the short
  // forms' own texts in its title (D81).
  const also = forms.slice(1)
    .map((f) => {
      const m = f.member;
      const full = !f.kind && !isShortForm(m);
      const note = full ? (m.resolvable && (viaLabel(m.via) || partnerLabel(m))) || lookupFailed(m) || heldVolumeMiss(m) || '' : '';
      const n = countOf(f);
      const title = f.kind ? ` title="${escapeHtml(f.texts.join('; '))}" data-cite-kind="${f.kind}"` : '';
      return `\n        <div class="cited-also"${title}>Also cited as ${escapeHtml(f.label ?? m.raw)}${n == null ? '' : ` ${formCountHtml(n)}`}${note ? ` <span class="cited-also-note">${escapeHtml(note)}</span>` : ''}</div>`;
    })
    .join('');
  const raw = escapeHtml(g.primary.raw);
  const nav = g.count ? `
        <div class="cited-nav">
          <button type="button" class="cited-show" aria-label="${g.count}× in text: show where the text cites ${raw}"><span class="cited-count">${g.count}×</span> in text</button>
          <span class="cited-step" hidden>
            <button type="button" class="cited-prev" aria-label="Previous place ${raw} is cited" title="Previous ([)">&#8249;</button>
            <span class="cited-pos"></span>
            <button type="button" class="cited-next" aria-label="Next place ${raw} is cited" title="Next (])">&#8250;</button>
          </span>
        </div>` : '';
  return `<div class="cited-entry" data-cite-group="${escapeHtml(g.id)}" data-cite-category="${escapeHtml(g.category)}" data-cite-search="${escapeHtml(g.search)}">
        ${inner}${also}${nav}
      </div>`;
}

/**
 * The cited-cases list (the case viewer's sidebar and /check): one entry
 * per group, ordered as orderCitedCases orders their primary citations.
 */
export function citedListHtml(groups, caseHref, caseRel = 'noopener') {
  const byPrimary = new Map(groups.map(g => [g.primary, g]));
  return orderCitedCases(groups.map(g => g.primary))
    .map(p => citedGroupHtml(byPrimary.get(p), caseHref, caseRel))
    .join('');
}

/**
 * Counts for the cited cases in a list (groupCitations' groups, #198), with
 * statutes apart from cases: `{ cases, resolvable, statutes, other, review }`.
 * `cases` counts the cases cited, by full citation or short form,
 * `resolvable` those stare.pub opens (one resolved through its parallel
 * partner among them, #160), `statutes` statutes and regulations, linked or
 * not, and `other` anything else citare names (law reviews); each by its
 * group's primary citation. `review` counts the parallel runs whose citations
 * open different cases. Bare section references aren't counted.
 */
export function citationCounts(groups) {
  const n = { cases: 0, resolvable: 0, statutes: 0, other: 0, review: 0 };
  const members = (groups || []).flatMap(g => g.members || []);
  n.review = new Set(members.filter(c => c.conflicts?.length).map(c => c.conflictRun ?? c.raw)).size;
  for (const g of groups || []) {
    const c = g.primary;
    if (!c || isSectionReference(c)) continue;
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
 * "3 cited cases found (2 resolvable), 1 statute, 1 needs review", from
 * citationCounts over groupCitations' groups; the statute, other and review
 * parts only when there are any.
 */
export function citationSummary(groups) {
  const n = citationCounts(groups);
  let text = `${plural(n.cases, 'cited case', 'cited cases')} found (${n.resolvable} resolvable)`;
  if (n.statutes) text += `, ${plural(n.statutes, 'statute', 'statutes')}`;
  if (n.other) text += `, ${n.other} other`;
  if (n.review) text += `, ${n.review} ${n.review === 1 ? 'needs' : 'need'} review`;
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
    html += citationHtml(o.raw, formatPlain(text.slice(from, to)), citationMap.get(o.key ?? o.raw), o.pin, o.place);
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

/**
 * The preview for a citation link's case, `{ name, date, court, cite }`, from
 * `previewFn` (resolve.js's casePreview, which reads the case's JSON by its zip span and
 * keeps what it read), or null when it can't be read. `page` is the link's page segment,
 * with a sequence (`148-02`) for a case after the first at its page (#204).
 */
export async function fetchCasePreview(slug, volume, page, previewFn) {
  const seq = /-(\d+)(?:@\d+)?$/.exec(String(page))?.[1];
  try {
    return await previewFn(slug, volume, citedPage(page), seq ? parseInt(seq, 10) : null);
  } catch {
    return null;
  }
}

/**
 * Set up hover tooltips and click-to-open on citation links.
 * Resolvable citations open in a new tab. Hover shows preview tooltip.
 */
export function setupCiteHovers(container, previewFn) {
  container.querySelectorAll('a.cite-link:not(.cite-external)').forEach(el => {
    let tooltipEl = null;
    let savedTitle = null;

    // Shown on hover and on keyboard focus alike (#270), and linked to the link by
    // aria-describedby while it's up.
    const show = async () => {
      const hash = el.getAttribute('href');
      if (!hash || !hash.startsWith('#') || tooltipEl) return;
      const parts = hash.slice(1).split('/');
      if (parts.length !== 3) return;
      const [slug, volume, pageStr] = parts;

      // Suppress browser tooltip while our custom one is showing
      savedTitle = el.getAttribute('title');
      el.removeAttribute('title');

      const tip = createTooltip(el);
      tooltipEl = tip;
      el.setAttribute('aria-describedby', tip.id);
      tip.innerHTML = `<span class="spinner"></span> Loading...`;

      const preview = await fetchCasePreview(slug, volume, pageStr, previewFn);
      if (tooltipEl !== tip) return;

      if (preview) {
        tip.innerHTML = `<div><strong>${esc(preview.name)}</strong><br><span style="opacity:0.7">${esc(preview.cite)} &mdash; ${esc(preview.date)}</span></div>`;
      } else {
        tip.textContent = "Couldn't load the preview. Point at the citation again to retry, or click to open the case.";
      }
    };

    const hide = () => {
      if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
      }
      el.removeAttribute('aria-describedby');
      // Restore title for accessibility
      if (savedTitle !== null) {
        el.setAttribute('title', savedTitle);
        savedTitle = null;
      }
    };

    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', () => { if (document.activeElement !== el) hide(); });
    el.addEventListener('focus', () => { if (el.matches(':focus-visible')) show(); });
    el.addEventListener('blur', hide);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tooltipEl) {
        e.stopPropagation();
        hide();
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

let tooltips = 0;

function createTooltip(anchor) {
  const tip = document.createElement('div');
  tip.className = 'cite-tooltip';
  tip.id = `cite-tooltip-${++tooltips}`;
  tip.setAttribute('role', 'tooltip');
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
