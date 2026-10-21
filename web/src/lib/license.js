// The two licences stare.pub states in its machine-readable files (#161): CC0 1.0
// for the Caselaw Access Project data and anything else republished under its
// source's CC0 terms, and CC BY-NC-ND 4.0 for what the project produces, with
// stare.pub as the source to credit. crates/stare/src/license.rs holds the same
// two for reporters.json; the schemas and openapi.json state them by hand, and the
// tests check that they all agree.
//
// The owner's ruling D65 adds the upstreams' own terms where stare.pub republishes
// their data: Free Law Project's reporters-db and courts-db (BSD 2-Clause, the
// sources of the reporter map's names, variations and editions and of the citare
// data bundle), and the Public Domain Mark CourtListener puts on its bulk data, for
// the CourtListener records, crediting CourtListener.

export const SOURCE = 'https://stare.pub';

export const CC0 = {
  id: 'CC0-1.0',
  name: 'CC0 1.0 Universal',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/',
};

export const CC_BY_NC_ND = {
  id: 'CC-BY-NC-ND-4.0',
  name: 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International',
  url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
};

export const LICENSE_URLS = [CC0.url, CC_BY_NC_ND.url];

export const PUBLIC_DOMAIN_MARK = {
  id: 'CC-PDM-1.0',
  name: 'Public Domain Mark 1.0 Universal',
  url: 'https://creativecommons.org/publicdomain/mark/1.0/',
};

export const BSD_2_CLAUSE = {
  id: 'BSD-2-Clause',
  name: 'BSD 2-Clause "Simplified" License',
  url: 'https://spdx.org/licenses/BSD-2-Clause.html',
};

export const FREE_LAW_PROJECT = { '@type': 'Organization', name: 'Free Law Project', url: 'https://free.law/' };

export const REPORTERS_DB = {
  name: 'reporters-db',
  url: 'https://github.com/freelawproject/reporters-db',
  license: BSD_2_CLAUSE,
  copyright: 'Copyright (c) 2014, Free Law Project',
};

export const COURTS_DB = {
  name: 'courts-db',
  url: 'https://github.com/freelawproject/courts-db',
  license: BSD_2_CLAUSE,
  copyright: 'Copyright (c) 2020, Free Law Project',
};
