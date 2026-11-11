import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  capSource, citationPath, clusters, fnv1a32, keyParts, keyPath, parseCasePath, pickPrinting,
  resolveInShard, resolveKey, shardFor,
} from '../public/js/caseaddress.js';
import { isCasePath } from '../src/lib/caseroute.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/crk/${name}`, import.meta.url)));
// Recorded from data.stare.pub/crk/ledger/ (v2026.11.08), trimmed to two courts and the
// rows the tests use, with one replaced row added (fixtures/README.md).
const LATEST = fixture('latest.json');
const DC = fixture('06c10ecd78449fba.json');
const PA = fixture('cee7d68f8f52c5d8.json');

describe('parseCasePath', () => {
  test('reads a key', () => {
    assert.deepEqual(parseCasePath('/k/us/dc/69/1943-05-11/'), { kind: 'k', key: 'us/dc/69/1943-05-11' });
    assert.deepEqual(parseCasePath('/k/us/pa/rpt.500-pa-524/1983-04-27~2/'),
      { kind: 'k', key: 'us/pa/rpt.500-pa-524/1983-04-27~2' });
    // Without the trailing slash, percent-encoded, or in capitals.
    assert.deepEqual(parseCasePath('/k/us/dc/69/1943-05-11'), { kind: 'k', key: 'us/dc/69/1943-05-11' });
    assert.deepEqual(parseCasePath('/k/us/pa/rpt.500-pa-524/1983-04-27%7E2/'),
      { kind: 'k', key: 'us/pa/rpt.500-pa-524/1983-04-27~2' });
    assert.deepEqual(parseCasePath('/k/US/DC/69/1943-05-11/'), { kind: 'k', key: 'us/dc/69/1943-05-11' });
  });

  test('reads a citation, with the nth case on a shared page', () => {
    assert.deepEqual(parseCasePath('/c/us/a2d/31/647/'),
      { kind: 'c', jurisdiction: 'us', reporter: 'a2d', volume: '31', page: 647, n: null });
    assert.deepEqual(parseCasePath('/c/us/a2d/31/647/2/'),
      { kind: 'c', jurisdiction: 'us', reporter: 'a2d', volume: '31', page: 647, n: 2 });
    assert.deepEqual(parseCasePath('/c/us/a3d/138-2/1012'),
      { kind: 'c', jurisdiction: 'us', reporter: 'a3d', volume: '138-2', page: 1012, n: null });
  });

  test('a /k/ or /c/ path that names nothing is bad', () => {
    for (const p of ['/k/', '/k/us/', '/k/us/dc/', '/k/us//69/', '/k/us/dc/<x>/', '/k/%E0%A4%A/a/b/',
      '/c/', '/c/us/a2d/31/', '/c/us/a2d/x31/647/', '/c/us/a2d/31/xxix/', '/c/us/a2d/31/647/0/',
      '/c/us/a2d/31/647/2/3/', '/c/us/A 2d/31/647/']) {
      assert.equal(parseCasePath(p)?.kind, 'bad', p);
    }
  });

  test('any other path is not a case address', () => {
    for (const p of ['/', '/index.html', '/about', '/search', '/kk/us/dc/1/', '/k', '/c', '/data/a2d/31.bin']) {
      assert.equal(parseCasePath(p), null, p);
    }
  });

  test('the head script marks every path parseCasePath reads', () => {
    for (const p of ['/k/us/dc/69/1943-05-11/', '/c/us/a2d/31/647/', '/k/us/', '/c/x/']) {
      assert.equal(isCasePath(p), parseCasePath(p) !== null, p);
    }
    for (const p of ['/', '/about', '/k', '/c']) assert.equal(isCasePath(p), false, p);
  });

  test('keyPath and citationPath give back what parseCasePath reads', () => {
    for (const key of ['us/dc/69/1943-05-11', 'us/pa/rpt.500-pa-524/1983-04-27~2']) {
      assert.equal(parseCasePath(keyPath(key)).key, key);
    }
    assert.equal(keyPath('us/pa/rpt.500-pa-524/1983-04-27~2'), '/k/us/pa/rpt.500-pa-524/1983-04-27~2/');
    assert.equal(citationPath('us', 'a2d', '31', 647), '/c/us/a2d/31/647/');
    assert.equal(citationPath('us', 'a2d', '31', 647, 2), '/c/us/a2d/31/647/2/');
  });
});

describe('the ledger bucket rule', () => {
  test('fnv1a32 matches FNV-1a 32', () => {
    assert.equal(fnv1a32(''), 0x811c9dc5);
    assert.equal(fnv1a32('a'), 0xe40c292c);
    assert.equal(fnv1a32('foobar'), 0xbf9cf968);
  });

  test('a key\'s court and stem', () => {
    assert.deepEqual(keyParts('us/pa/rpt.500-pa-524/1983-04-27~2'),
      { court: 'us/pa', stem: 'us/pa/rpt.500-pa-524/1983-04-27' });
    assert.deepEqual(keyParts('us/dc/69/1943-05-11'), { court: 'us/dc', stem: 'us/dc/69/1943-05-11' });
  });

  test('finds the shard the published ledger put each key in', () => {
    assert.equal(shardFor(LATEST, 'us/dc/69/1943-05-11'), 's/06c10ecd78449fba.json.gz');
    // Every ordinal of a stem is in one shard.
    assert.equal(shardFor(LATEST, 'us/dc/69/1943-05-11~9'), 's/06c10ecd78449fba.json.gz');
    assert.equal(shardFor(LATEST, 'us/pa/rpt.500-pa-524/1983-04-27~2'), 's/cee7d68f8f52c5d8.json.gz');
  });

  test('a court with no shards, or an empty bucket, has no shard', () => {
    assert.equal(shardFor(LATEST, 'us/zz/1/2000-01-01'), null);
    const empty = { courts: { 'us/x': [''] } };
    assert.equal(shardFor(empty, 'us/x/1/2000-01-01'), null);
  });
});

describe('a decision\'s printing', () => {
  test('reads a CAP source', () => {
    assert.deepEqual(capSource('cap:a2d/31/0647-01'), { reporter: 'a2d', volume: '31', page: 647, seq: 1, file: '0647-01' });
    assert.deepEqual(capSource('cap:cai-cas/1/xxix-02'), { reporter: 'cai-cas', volume: '1', page: 'xxix', seq: 2, file: 'xxix-02' });
    assert.equal(capSource('cl-cluster:5123106'), null);
  });

  test('opens the printing a citation key names', () => {
    const p = pickPrinting(['cap:a2d/460/0722-01', 'cap:pa/500/0524-02'], 'us/pa/rpt.500-pa-524/1983-04-27~2');
    assert.equal(p.reporter, 'pa');
    assert.equal(p.seq, 2);
  });

  test('prefers the court\'s own reports to a regional reporter', () => {
    const p = pickPrinting(['cap:a2d/690/1146-01', 'cap:pa/547/0402-01', 'cl-cluster:1969972'], 'us/pa/x/1997-03-18');
    assert.deepEqual([p.reporter, p.volume, p.page], ['pa', '547', 402]);
    assert.equal(pickPrinting(['cap:a2d/31/0647-01'], 'us/dc/69/1943-05-11').reporter, 'a2d');
  });

  test('none without a CAP source', () => {
    assert.equal(pickPrinting(['cl-cluster:1'], 'us/x/1/2000-01-01'), null);
    assert.deepEqual(clusters(['cap:a2d/31/0647-01', 'cl-cluster:5123106']), [5123106]);
  });
});

describe('resolveInShard', () => {
  test('an active key', () => {
    const r = resolveInShard(DC, 'us/dc/69/1943-05-11');
    assert.equal(r.found, true);
    assert.equal(r.current, 'us/dc/69/1943-05-11');
    assert.equal(r.replaced, false);
    assert.equal(r.provisional, false);
    assert.deepEqual(r.decision.sources, ['cap:a2d/31/0647-01', 'cl-cluster:5123106']);
  });

  test('a replaced key follows current', () => {
    const r = resolveInShard(DC, 'us/dc/69/1943-05-11~9');
    assert.equal(r.current, 'us/dc/69/1943-05-11');
    assert.equal(r.replaced, true);
    assert.equal(r.decision.id, '01cd294');
  });

  test('a key not minted is not found', () => {
    assert.deepEqual(resolveInShard(DC, 'us/dc/70/1943-05-11'), { found: false });
    assert.deepEqual(resolveInShard(null, 'us/dc/70/1943-05-11'), { found: false });
  });

  test('a retargeted errata key resolves to its decision; a provisional one says so', () => {
    const shard = {
      keys: [{ key: 'us/x/a/2000-01-01', id: '000002', status: 'errata' }],
      decisions: [{ id: '000002', key: 'us/x/b/2000-01-01', provisional: true, sources: ['cap:a2d/1/0001-01'] }],
    };
    const r = resolveInShard(shard, 'us/x/a/2000-01-01');
    assert.equal(r.current, 'us/x/a/2000-01-01');
    assert.equal(r.decision.id, '000002');
    assert.equal(r.provisional, true);
  });

  test('a merged decision stands for the one it was merged into', () => {
    const shard = {
      keys: [{ key: 'us/x/a/2000-01-01', id: '000001', status: 'active' }],
      decisions: [
        { id: '000001', merged_into: '000003', sources: ['cl-cluster:9'] },
        { id: '000003', sources: ['cap:a2d/1/0001-01', 'cl-cluster:9'] },
      ],
    };
    assert.equal(resolveInShard(shard, 'us/x/a/2000-01-01').decision.id, '000003');
  });
});

describe('resolveKey', () => {
  const shards = { 's/06c10ecd78449fba.json.gz': DC, 's/cee7d68f8f52c5d8.json.gz': PA };
  const deps = (extra = {}) => ({
    loadLedger: async () => LATEST,
    loadShard: async (path) => ({ ...shards, ...extra }[path] || { keys: [], decisions: [] }),
  });

  test('two reads: latest.json, then the key\'s shard', async () => {
    const r = await resolveKey('us/pa/rpt.500-pa-524/1983-04-27~2', deps());
    assert.equal(r.found, true);
    assert.deepEqual(pickPrinting(r.decision.sources, r.current), {
      reporter: 'pa', volume: '500', page: 524, seq: 2, file: '0524-02',
    });
  });

  test('a court the ledger has no keys in reads no shard', async () => {
    let reads = 0;
    const r = await resolveKey('us/zz/1/2000-01-01', { loadLedger: async () => LATEST, loadShard: async () => { reads += 1; } });
    assert.deepEqual(r, { found: false });
    assert.equal(reads, 0);
  });

  test('a replacement in another court is read from that court\'s shard', async () => {
    const pa = {
      keys: [{ key: 'us/pa/old/1983-04-27', id: '050z7n5', status: 'replaced',
        replaced_by: 'us/pa/rpt.500-pa-524/1983-04-27~2', current: 'us/dc/69/1943-05-11' }],
      decisions: [],
    };
    const path = shardFor(LATEST, 'us/pa/old/1983-04-27');
    const r = await resolveKey('us/pa/old/1983-04-27', deps({ [path]: pa }));
    assert.equal(r.current, 'us/dc/69/1943-05-11');
    assert.equal(r.decision.id, '01cd294');
  });
});
