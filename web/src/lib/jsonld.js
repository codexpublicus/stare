// schema.org JSON-LD for the site's pages (#161): a WebSite on the home page
// and a Dataset on /data, built at build time and embedded as
// <script type="application/ld+json"> by components/JsonLd.astro. The figures
// come from collection.json, like every other figure on the site.
import { casesLabel, collection } from './collection.js';
import { CC0, CC_BY_NC_ND, COURTS_DB, FREE_LAW_PROJECT, PUBLIC_DOMAIN_MARK, REPORTERS_DB, SOURCE } from './license.js';

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

// What a CC BY-NC-ND part credits: stare.pub, the authoritative copy.
const creditText = `stare.pub (${SOURCE})`;

const capDataset = {
  '@type': 'Dataset',
  name: 'Caselaw Access Project',
  url: 'https://case.law/',
  license: CC0.url,
};

// Free Law Project's datasets some parts come from, each with its own licence and
// copyright notice (D65).
const upstream = (u) => ({
  '@type': 'Dataset',
  name: u.name,
  url: u.url,
  license: u.license.url,
  copyrightNotice: u.copyright,
  creator: FREE_LAW_PROJECT,
});

// CourtListener's bulk data, which CourtListener marks with the Public Domain Mark
// ("free of known copyright restrictions"). The CourtListener records stare.pub will
// publish carry the same mark, crediting CourtListener (D65).
const courtListenerDataset = {
  '@type': 'Dataset',
  name: 'CourtListener bulk data',
  url: 'https://www.courtlistener.com/help/api/bulk-data/',
  license: PUBLIC_DOMAIN_MARK.url,
  creator: FREE_LAW_PROJECT,
};

// The Dataset's parts, one per licence (#161): the CAP case files stare.pub
// republishes under CAP's CC0 terms, and the citation index, the reporter map and
// the citare data bundle the project produces, under CC BY-NC-ND. The reporter map
// and the bundle name reporters-db (and the bundle courts-db) as what they are
// based on, with their licence (D65). The CourtListener records aren't published
// yet and aren't a part.
function parts() {
  return [
    {
      '@type': 'Dataset',
      '@id': `${SITE}/data/#cap-case-files`,
      name: 'Caselaw Access Project case files',
      description:
        `${casesLabel} from the Harvard Caselaw Access Project, one zip per reporter volume, ` +
        'republished under CAP’s CC0 terms.',
      url: 'https://data.stare.pub/cap/',
      license: CC0.url,
      isBasedOn: capDataset,
      publisher,
      distribution: [
        {
          '@type': 'DataDownload',
          name: 'A volume’s case files (Atlantic Reporter, Second Series, volume 31)',
          description: 'One zip per volume at https://data.stare.pub/cap/<slug>/<volume>.zip, with each case as json/<file>.json.',
          contentUrl: 'https://data.stare.pub/cap/a2d/31.zip',
          encodingFormat: 'application/zip',
          license: CC0.url,
        },
      ],
    },
    {
      '@type': 'Dataset',
      '@id': `${SITE}/data/#citation-index`,
      name: 'stare.pub citation index',
      description:
        'The citation index stare.pub builds over the case files: one gzipped file per reporter volume ' +
        'mapping first pages to case files, the manifest naming the live build, and every build’s report.',
      url: `${SITE}/data/`,
      license: CC_BY_NC_ND.url,
      creditText,
      creator: publisher,
      publisher,
      distribution: [
        {
          '@type': 'DataDownload',
          name: 'Index manifest',
          description: 'The live index build: every reporter slug and the volumes held, and where the build’s files are.',
          contentUrl: 'https://idx.stare.pub/manifest.json',
          encodingFormat: 'application/json',
          license: CC_BY_NC_ND.url,
        },
        {
          '@type': 'DataDownload',
          name: 'Index build reports',
          contentUrl: 'https://idx.stare.pub/reports/index.json',
          encodingFormat: 'application/json',
          license: CC_BY_NC_ND.url,
        },
        {
          '@type': 'DataDownload',
          name: 'A volume’s citation index (Atlantic Reporter, Second Series, volume 31)',
          description: 'One file per volume at https://idx.stare.pub/<base><slug>/<volume>.idx.gz; lines are page,source,ref.',
          contentUrl: 'https://idx.stare.pub/v/v2026.10.18/a2d/31.idx.gz',
          encodingFormat: 'application/gzip',
          license: CC_BY_NC_ND.url,
        },
      ],
    },
    {
      '@type': 'Dataset',
      '@id': `${SITE}/data/#reporter-map`,
      name: 'stare.pub reporter map',
      description:
        'Reporter abbreviations to the slugs the index and case files use, with volume ranges and URL templates. ' +
        'The names, variations and editions come from Free Law Project’s reporters-db under its BSD 2-Clause licence, ' +
        'and the file’s `sources` gives reporters-db’s commit, licence and copyright notice.',
      url: `${SITE}/reporters.json`,
      license: CC_BY_NC_ND.url,
      creditText,
      creator: publisher,
      publisher,
      isBasedOn: [upstream(REPORTERS_DB)],
      distribution: [
        {
          '@type': 'DataDownload',
          name: 'Reporter map',
          description: 'Reporter abbreviations to the slugs the index and case files use, with volume ranges and URL templates.',
          contentUrl: `${SITE}/reporters.json`,
          encodingFormat: 'application/json',
          license: CC_BY_NC_ND.url,
        },
      ],
    },
    {
      '@type': 'Dataset',
      '@id': `${SITE}/data/#citare-data`,
      name: 'citare data bundle',
      description:
        'The reporter, edition, law, journal and court tables the site’s citation finder loads, one binary file ' +
        'at https://stare.pub/data/citare/v1/citare-data-<hash>.bin.gz. Its sidecar, citare-data-<hash>.json ' +
        'next to it, gives its licence and, for the sections built from Free Law Project’s reporters-db and ' +
        'courts-db, their commits, BSD 2-Clause licence and copyright notices.',
      url: `${SITE}/data/citare/v1/`,
      license: CC_BY_NC_ND.url,
      creditText,
      creator: publisher,
      publisher,
      isBasedOn: [upstream(REPORTERS_DB), upstream(COURTS_DB)],
    },
  ];
}

export function dataset() {
  const hasPart = parts();
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    '@id': `${SITE}/data/#dataset`,
    name: 'stare.pub U.S. case law citation index and case text',
    description:
      `A citation index over U.S. case law, ${casesLabel} from the Harvard Caselaw Access Project, ` +
      'with the case text, published as static files: one gzipped index file per reporter volume ' +
      'mapping first pages to case files, and the volumes’ case files as zips. The case files are CC0 1.0, ' +
      'under CAP’s terms; the index and the reporter map are CC BY-NC-ND 4.0, with stare.pub as the source.',
    url: `${SITE}/data/`,
    isAccessibleForFree: true,
    inLanguage: 'en-US',
    keywords: ['case law', 'legal citations', 'United States', 'court opinions', 'Caselaw Access Project'],
    spatialCoverage: { '@type': 'Place', name: 'United States' },
    temporalCoverage: `${collection.first_year}/${collection.last_year}`,
    creator: publisher,
    publisher,
    isPartOf: { '@id': `${SITE}/#website` },
    isBasedOn: [capDataset, courtListenerDataset],
    hasPart,
    // The bundle's name changes with its content, so its part has no fixed download.
    distribution: hasPart.flatMap((part) => part.distribution ?? []),
  };
}

// The JSON for a <script type="application/ld+json">, with "<" escaped so no
// string in it can close the script element.
export function serialize(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
