// The collection's size and range, from one data file (web/src/data/collection.json).
// web/scripts/collection.mjs writes it from the live index before every site build
// (#297); the copy in git is the snapshot the tests run on. Every page, social
// description, llms.txt's summary and the OG image take their figures from here;
// web/tests/collection.test.js fails on a figure typed anywhere else, and
// web/tests/stale-figures.test.js on CAP's own figures given as the whole collection.
import collection from '../data/collection.json' with { type: 'json' };
import { figures } from './collection-figures.js';

export { collection };
export { SOURCES, figures, formatCount, formatMillions } from './collection-figures.js';

export const { decisionsLabel, yearSpan, coverage, capCasesLabel, ogLine, llmsSummary } = figures(collection);

// CAP's release: its cases, volumes and years.
export const cap = collection.cap;

// The CourtListener records the index build points at: the export it was built
// from, and how many records it published.
export const courtListener = collection.courtlistener;

// The index build the figures were read from.
export const indexVersion = collection.index_version;
