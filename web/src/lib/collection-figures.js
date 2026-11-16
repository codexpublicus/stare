// The phrases the site states the collection's size and range in, from a
// collection.json (#297). No data import, so web/scripts/collection.mjs can use it
// to rewrite a snapshot whatever shape the old one has; web/src/lib/collection.js
// applies it to the snapshot.

// 6,920,596 -> "6.9 million". One decimal, rounded down, so the site never
// claims more cases than it has.
export function formatMillions(n) {
  if (!Number.isInteger(n) || n < 1_000_000) {
    throw new RangeError(`formatMillions expects an integer of at least a million, got ${n}`);
  }
  const tenths = Math.floor(n / 100_000);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return frac === 0 ? `${whole} million` : `${whole}.${frac} million`;
}

// 40622 -> "40,622"
export function formatCount(n) {
  return n.toLocaleString('en-US');
}

// Each source's name in running text, and the longer form llms.txt gives.
export const SOURCE_NAMES = {
  cap: { name: 'the Caselaw Access Project', long: 'the Harvard Caselaw Access Project (CAP)' },
  courtlistener: { name: 'CourtListener', long: 'CourtListener (Free Law Project)' },
};

// ['a'] -> "a"; ['a', 'b'] -> "a and b"; ['a', 'b', 'c'] -> "a, b and c"
function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// The collection's sources, named open-ended so the sentence holds when one is added
// (#300): "sources including the Caselaw Access Project and CourtListener". A snapshot
// written before collection.json listed its sources has CAP and CourtListener.
export function sourcesPhrase(c, form = 'name') {
  const ids = c.sources ?? ['cap', 'courtlistener'];
  const names = ids.map((id) => {
    const known = SOURCE_NAMES[id];
    if (!known) throw new Error(`collection.json names a source with no name in SOURCE_NAMES: ${id}`);
    return known[form];
  });
  return `sources including ${joinNames(names)}`;
}

/** The phrases the pages use, from a collection.json. */
export function figures(c) {
  const decisionsLabel = `${formatMillions(c.decisions)} decisions`;
  const yearSpan = `${c.first_year} to ${c.last_year}`;
  const sources = sourcesPhrase(c);
  return {
    // "<n> million decisions"
    decisionsLabel,
    // "<first year> to <last year>"
    yearSpan,
    // "sources including the Caselaw Access Project and CourtListener"
    sources,
    // "<n> million decisions from <first year> to <last year>, from sources including the Caselaw Access Project and CourtListener"
    coverage: `${decisionsLabel} from ${yearSpan}, from ${sources}`,
    // CAP's finished scan alone, for sentences about CAP: "<n> million cases"
    capCasesLabel: `${formatMillions(c.cap.cases)} cases`,
    // The OG image's last line
    ogLine: `${decisionsLabel} · ${yearSpan} · Serverless. Actually.`,
    // llms.txt's summary, the line after its title
    llmsSummary:
      '> stare.pub resolves U.S. case law citations to the full text of the case. It aggregates published case law, ' +
      `${decisionsLabel} from ${yearSpan}, from ${sourcesPhrase(c, 'long')}; CourtListener's records ` +
      "cover cases CAP doesn't have, including the decisions after CAP's last volumes. stare.pub produces it all as static, " +
      'self-hostable data: the citation index, the case records, the reporter map and the schemas. ' +
      'There is no API, no account, no key and no server to call; resolving a citation is two or three plain HTTPS GETs, ' +
      'and the same files work from a mirror.',
  };
}
