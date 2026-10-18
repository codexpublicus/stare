// Parallel-citation reconciliation (#160), the rules of stare::parallel::reconcile
// (crates/stare/src/parallel.rs), which has the reasoning. Both are tested on the
// vectors in crates/stare/tests/fixtures/parallel-reconcile.json.
//
// `printings` are `{ run, official, lookup }`: `run` is the index of the first citation
// of the printing's parallel run (its own index when it starts one or is in none), and
// `lookup` is `{ status: 'found', case }`, `{ status: 'held_miss' }`,
// `{ status: 'not_held' }` or `{ status: 'unknown' }`. Returns one
// `{ partner, conflicts, preferred }` per printing, in order.
export function reconcileParallels(printings) {
  const verdicts = printings.map(() => ({ partner: null, conflicts: [], preferred: false }));
  const runs = new Map();
  printings.forEach((p, i) => {
    if (!runs.has(p.run)) runs.set(p.run, []);
    runs.get(p.run).push(i);
  });
  for (const members of runs.values()) {
    if (members.length < 2) continue;
    const found = members
      .filter((i) => printings[i].lookup?.status === 'found')
      .map((i) => [i, printings[i].lookup.case]);
    if (!found.length) continue;
    const [[first, theCase]] = found;
    if (found.some(([, c]) => c !== theCase)) {
      for (const [i, mine] of found) {
        verdicts[i].conflicts = found.filter(([, other]) => other !== mine).map(([j]) => j);
      }
      continue;
    }
    const preferred = found.map(([i]) => i).find((i) => printings[i].official) ?? first;
    verdicts[preferred].preferred = true;
    for (const i of members) {
      const status = printings[i].lookup?.status;
      if (status === 'held_miss' || status === 'not_held') verdicts[i].partner = preferred;
    }
  }
  return verdicts;
}
