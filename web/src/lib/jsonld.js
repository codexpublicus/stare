// schema.org JSON-LD for the site's pages (#161): a WebSite on the home page
// and a Dataset on /data, built at build time and embedded as
// <script type="application/ld+json"> by components/JsonLd.astro. The figures
// come from collection.json, like every other figure on the site.
import { casesLabel, collection } from './collection.js';

export const SITE = 'https://stare.pub';

const publisher = {
  '@type': 'Organization',
  name: 'Codex Publicus',
  url: 'https://codexpublicus.org',
  email: 'info@codexpublicus.org',
};

export function webSite() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE}/#website`,
    name: 'stare.pub',
    url: `${SITE}/`,
    description:
      'Resolves U.S. case law citations to the full text of the case and the original scanned pages, from static files.',
    inLanguage: 'en-US',
    publisher,
    subjectOf: [
      { '@type': 'CreativeWork', name: 'llms.txt', url: `${SITE}/llms.txt`, encodingFormat: 'text/markdown' },
      { '@type': 'CreativeWork', name: 'OpenAPI description of the static files', url: `${SITE}/openapi.json`, encodingFormat: 'application/vnd.oai.openapi+json' },
    ],
  };
}

export function dataset() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    '@id': `${SITE}/data/#dataset`,
    name: 'stare.pub U.S. case law citation index and case text',
    description:
      `A citation index over U.S. case law, ${casesLabel} from the Harvard Caselaw Access Project, ` +
      'with the case text, published as static files: one gzipped index file per reporter volume ' +
      'mapping first pages to case files, and the volumes’ case files as zips.',
    url: `${SITE}/data/`,
    isAccessibleForFree: true,
    inLanguage: 'en-US',
    keywords: ['case law', 'legal citations', 'United States', 'court opinions', 'Caselaw Access Project'],
    spatialCoverage: { '@type': 'Place', name: 'United States' },
    temporalCoverage: `${collection.first_year}/${collection.last_year}`,
    creator: publisher,
    publisher,
    isPartOf: { '@id': `${SITE}/#website` },
    isBasedOn: [
      { '@type': 'Dataset', name: 'Caselaw Access Project', url: 'https://case.law/' },
      { '@type': 'Dataset', name: 'CourtListener bulk data', url: 'https://www.courtlistener.com/help/api/bulk-data/' },
    ],
    distribution: [
      {
        '@type': 'DataDownload',
        name: 'Index manifest',
        description: 'The live index build: every reporter slug and the volumes held, and where the build’s files are.',
        contentUrl: 'https://idx.stare.pub/manifest.json',
        encodingFormat: 'application/json',
      },
      {
        '@type': 'DataDownload',
        name: 'Reporter map',
        description: 'Reporter abbreviations to the slugs the index and case files use, with volume ranges and URL templates.',
        contentUrl: `${SITE}/reporters.json`,
        encodingFormat: 'application/json',
      },
      {
        '@type': 'DataDownload',
        name: 'Index build reports',
        contentUrl: 'https://idx.stare.pub/reports/index.json',
        encodingFormat: 'application/json',
      },
      {
        '@type': 'DataDownload',
        name: 'A volume’s citation index (Atlantic Reporter, Second Series, volume 31)',
        description: 'One file per volume at https://idx.stare.pub/<base><slug>/<volume>.idx.gz; lines are page,source,ref.',
        contentUrl: 'https://idx.stare.pub/v/v2026.10.18/a2d/31.idx.gz',
        encodingFormat: 'application/gzip',
      },
      {
        '@type': 'DataDownload',
        name: 'A volume’s case files (Atlantic Reporter, Second Series, volume 31)',
        description: 'One zip per volume at https://data.stare.pub/cap/<slug>/<volume>.zip, with each case as json/<file>.json.',
        contentUrl: 'https://data.stare.pub/cap/a2d/31.zip',
        encodingFormat: 'application/zip',
      },
    ],
  };
}

// The JSON for a <script type="application/ld+json">, with "<" escaped so no
// string in it can close the script element.
export function serialize(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
