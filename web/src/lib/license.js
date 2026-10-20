// The two licences stare.pub states in its machine-readable files (#161): CC0 1.0
// for the Caselaw Access Project data and anything else republished under its
// source's CC0 terms, and CC BY-NC-ND 4.0 for what the project produces, with
// stare.pub as the source to credit. crates/stare/src/license.rs holds the same
// two for reporters.json; the schemas and openapi.json state them by hand, and the
// tests check that they all agree.

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
