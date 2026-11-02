// Reads the collection's figures from the live index (#297): web/scripts/collection.mjs
// writes them to web/src/data/collection.json before every site build, and the smoke
// suite reads them for the index build a deployed page names, to check the page.
//
// From the build's own files under idx.stare.pub/v/<version>/:
// - report.json: CAP's cases (`totals.cases`), CAP's release (`build.cap_release`), and
//   the CourtListener records the build took from its export (`idx.cl_input`);
// - manifest.json: CAP's volume folders in the index (`volumes`);
// - search/facets.json: decisions by year, over CAP and CourtListener together. The
//   report has no decision dates, so the years come from the search tree's year facet.
//
// Anything missing or inconsistent throws: the site build fails rather than ship
// figures it couldn't read.

// CAP's release is finished, and the report names it by the SHA-256 of its
// VolumesMetadata.json. Its volume count and its range of decision years were counted
// from the Codex Publicus mirror of that release (codexpublicus/stare#92), and hold
// only for it: a report naming another release fails the build until they are
// counted again.
export const CAP_RELEASE = {
  release: 'VolumesMetadata.json sha256:df5da71c76b6d75b59cfbb07387c71fb255e7a9f8d095c8a676559527532204d',
  volumes: 40622,
  first_year: 1658,
  last_year: 2020,
};

const VERSION = /^v\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function need(cond, what) {
  if (!cond) throw new Error(`collection: ${what}`);
}

function count(value, what) {
  need(Number.isInteger(value) && value >= 0, `${what} is not a count: ${JSON.stringify(value)}`);
  return value;
}

/**
 * The collection's figures from one index build's manifest, report and search facets.
 * Years after the CourtListener export's year are dates no decision can have had
 * when the export was made (a typo in a source record); they are left out of the
 * range and listed in `years_ignored`.
 */
export function collectionFromIndex({ manifest, report, facets }) {
  const version = report?.version;
  need(typeof version === 'string' && VERSION.test(version), `report.json has no build version: ${JSON.stringify(version)}`);
  need(manifest?.version === version, `manifest.json is build ${manifest?.version}, report.json is ${version}`);
  need(facets?.version === version, `search/facets.json is build ${facets?.version}, report.json is ${version}`);

  const capRelease = report.build?.cap_release;
  need(
    capRelease === CAP_RELEASE.release,
    `report.json names CAP release "${capRelease}", not the one CAP_RELEASE in web/src/lib/collection-read.js was counted from; recount its volumes and years`,
  );
  const capCases = count(report.totals?.cases, 'report.json totals.cases');
  const indexedVolumes = count(manifest.volumes, 'manifest.json volumes');
  need(indexedVolumes <= CAP_RELEASE.volumes, `manifest.json has ${indexedVolumes} CAP volumes, more than CAP's ${CAP_RELEASE.volumes}`);

  const cl = report.idx?.cl_input;
  need(cl && typeof cl === 'object', 'report.json has no idx.cl_input (a build without CourtListener)');
  need(typeof cl.export === 'string' && DAY.test(cl.export), `report.json idx.cl_input.export is not a date: ${JSON.stringify(cl.export)}`);
  const clRecords = count(cl.records, 'report.json idx.cl_input.records');
  need(clRecords > 0, 'report.json idx.cl_input.records is 0');

  need(Array.isArray(facets.years) && facets.years.length > 0, 'search/facets.json has no years');
  const lastPossible = Number(cl.export.slice(0, 4));
  const years = [];
  const ignored = [];
  for (const { key, decisions } of facets.years) {
    need(/^\d{4}$/.test(key), `search/facets.json year ${JSON.stringify(key)}`);
    const year = Number(key);
    count(decisions, `search/facets.json year ${key}`);
    if (year > lastPossible) ignored.push({ year, decisions });
    else if (decisions > 0) years.push(year);
  }
  need(years.length > 0, 'search/facets.json has no year up to the CourtListener export');
  const firstYear = Math.min(...years);
  const lastYear = Math.max(...years);
  need(firstYear <= CAP_RELEASE.first_year, `the earliest decision year is ${firstYear}, after CAP's ${CAP_RELEASE.first_year}`);
  need(lastYear >= CAP_RELEASE.last_year, `the latest decision year is ${lastYear}, before CAP's ${CAP_RELEASE.last_year}`);

  return {
    index_version: version,
    index_generated_at: report.generated_at,
    decisions: capCases + clRecords,
    first_year: firstYear,
    last_year: lastYear,
    cap: {
      cases: capCases,
      volumes: CAP_RELEASE.volumes,
      indexed_volumes: indexedVolumes,
      first_year: CAP_RELEASE.first_year,
      last_year: CAP_RELEASE.last_year,
      release: capRelease,
    },
    courtlistener: {
      export: cl.export,
      records: clRecords,
      records_without_lines: count(cl.records_without_lines ?? 0, 'report.json idx.cl_input.records_without_lines'),
    },
    years_ignored: ignored,
    source:
      `Read from idx.stare.pub/v/${version}/ by web/scripts/collection.mjs: decisions is CAP's cases ` +
      '(report.json totals.cases) plus the CourtListener records the build published (idx.cl_input.records); ' +
      'first_year and last_year are the range of search/facets.json years, over both sources, up to the ' +
      "CourtListener export's year; indexed_volumes is manifest.json volumes. CAP's volumes and years are " +
      "CAP_RELEASE in web/src/lib/collection-read.js, counted from the release that report.json's build.cap_release names.",
  };
}

async function getJson(fetchFn, url) {
  let res;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new Error(`collection: couldn't fetch ${url}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`collection: HTTP ${res.status} for ${url}`);
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`collection: ${url} is not JSON: ${err.message}`);
  }
}

/**
 * Reads the figures for one index build, or for the live one (the build
 * `<index>/manifest.json` names) when `version` is omitted.
 */
export async function readCollection({
  index = 'https://idx.stare.pub',
  version,
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
} = {}) {
  const root = index.replace(/\/$/, '');
  let base;
  if (version) {
    need(VERSION.test(version), `not an index build: ${JSON.stringify(version)}`);
    base = `${root}/v/${version}/`;
  } else {
    const live = await getJson(fetchFn, `${root}/manifest.json`);
    need(typeof live.base === 'string' && /^v\/[^/]+\/$/.test(live.base), `${root}/manifest.json has no base: ${JSON.stringify(live.base)}`);
    base = `${root}/${live.base}`;
  }
  const [manifest, report, facets] = await Promise.all([
    getJson(fetchFn, `${base}manifest.json`),
    getJson(fetchFn, `${base}report.json`),
    getJson(fetchFn, `${base}search/facets.json`),
  ]);
  return collectionFromIndex({ manifest, report, facets });
}
