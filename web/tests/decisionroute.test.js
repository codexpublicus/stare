import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkChar, decisionPath, normalizeId, openDecisionRecord, parseDecisionPath, recordsIn,
  resolveDecision, shardPath,
} from '../public/js/decisionroute.js';
import { parseCasePath } from '../public/js/caseaddress.js';
import { isCasePath } from '../src/lib/caseroute.js';
import { caseHref } from '../public/js/searchquery.js';

// Rows of the decision-route table for index build v2026.11.05.3 (ledger v2026.11.08):
// shard 0 and shard 4, which has an id that opens two records.
const SHARD_0 = {
  format: 'stare-decision-routes-shard', format_version: 1, shard: '0',
  records: { '01cm306': [{ cluster: 6933195, hash: 'e83587f4216900b9' }] },
};
const SHARD_4 = {
  format: 'stare-decision-routes-shard', format_version: 1, shard: '4',
  records: {
    '06k6q4p': [
      { cluster: 8503923, hash: '0eb363138af3ff4b' },
      { cluster: 8503924, hash: '7cd6802cf422a935' },
    ],
  },
};

describe('ids', () => {
  test('the check character is Luhn mod 32, as the ledger mints it', () => {
    // 000001y is the first id; the ledger's own.
    assert.equal(checkChar('000001'), 'y');
    for (const id of ['000001y', '075000d', '01cm306', '06k6q4p', '00nw60c']) {
      assert.equal(normalizeId(id), id);
    }
  });

  test('an id as typed is made canonical, and anything else is no id', () => {
    assert.equal(normalizeId('01CM306'), '01cm306');
    assert.equal(normalizeId(' 0lcm3O6 '), '01cm306');
    for (const bad of ['', '01cm307', '01cm30', '01cm3066', '01cu306', '0000000', null, '01cm-06']) {
      assert.equal(normalizeId(bad), null, String(bad));
    }
  });
});

describe('parseDecisionPath', () => {
  test('reads /d/<id>/, with or without the slash, in capitals or misread letters', () => {
    for (const p of ['/d/01cm306/', '/d/01cm306', '/d/01CM306/', '/d/0Lcm3o6/']) {
      assert.deepEqual(parseDecisionPath(p), { kind: 'd', id: '01cm306' }, p);
    }
  });

  test('a /d/ path that names no id is bad, and another path is none of its business', () => {
    for (const p of ['/d/', '/d/01cm307/', '/d/01cm306/x/', '/d/%E0%A4%A/', '/d/01cm306//']) {
      assert.deepEqual(parseDecisionPath(p), { kind: 'bad', prefix: 'd' }, p);
    }
    for (const p of ['/', '/k/us/dc/69/1943-05-11/', '/data/', '/dx/01cm306/']) {
      assert.equal(parseDecisionPath(p), null, p);
    }
  });

  test('the reader reads it as a permanent address, and the head script marks the case route', () => {
    assert.deepEqual(parseCasePath('/d/01cm306/'), { kind: 'd', id: '01cm306' });
    assert.deepEqual(parseCasePath('/d/nope/'), { kind: 'bad', prefix: 'd' });
    assert.equal(isCasePath('/d/01cm306/'), true);
    assert.equal(isCasePath('/data/'), false);
  });

  test('paths', () => {
    assert.equal(decisionPath('01cm306'), '/d/01cm306/');
    assert.equal(shardPath('01cm306'), 'd/0.json.gz');
    assert.equal(shardPath('06k6q4p'), 'd/4.json.gz');
  });
});

describe('the table', () => {
  test('an id opens its records, as the entries a cl line gives', () => {
    assert.deepEqual(recordsIn(SHARD_0, '01cm306'),
      [{ source: 'cl', cluster_id: 6933195, hash: 'e83587f4216900b9' }]);
    assert.equal(recordsIn(SHARD_4, '06k6q4p').length, 2);
    assert.deepEqual(recordsIn(SHARD_0, '06k6q4p'), []);
    assert.deepEqual(recordsIn({ records: { x: [{ cluster: '1', hash: 'zz' }] } }, 'x'), []);
    assert.deepEqual(recordsIn(null, 'x'), []);
  });

  test('resolves from the shard the id names, and a missing table is no record', async () => {
    const asked = [];
    const loadShard = async (id) => {
      asked.push(shardPath(id));
      return { '0': SHARD_0, '4': SHARD_4 }[shardPath(id)[2]];
    };
    assert.deepEqual(await resolveDecision('01cm306', { loadShard }), {
      found: true, records: [{ source: 'cl', cluster_id: 6933195, hash: 'e83587f4216900b9' }],
    });
    assert.deepEqual(await resolveDecision('075000d', { loadShard: async () => SHARD_0 }), { found: false });
    assert.deepEqual(asked, ['d/0.json.gz']);
    const missing = async () => { throw new Error('NOT_FOUND:https://idx.stare.pub/v/v1/d/6.json.gz'); };
    assert.deepEqual(await resolveDecision('01cm306', { loadShard: missing }), { found: false });
    const down = async () => { throw new Error('HTTP 503 fetching it'); };
    await assert.rejects(resolveDecision('01cm306', { loadShard: down }), /503/);
  });

  test('opens the nth record, with the others to switch to', async () => {
    const records = recordsIn(SHARD_4, '06k6q4p');
    const fetched = [];
    const fetchRecord = async (e) => {
      fetched.push(e.cluster_id);
      return { name_abbreviation: `Case ${e.cluster_id}`, source: { name: 'courtlistener' } };
    };
    const r = await openDecisionRecord('06k6q4p', records, 2, () => {}, { fetchRecord });
    assert.deepEqual(fetched, [8503924]);
    assert.equal(r.caseFile, 'cl/8503924');
    assert.deepEqual(r.allCases, ['cl/8503923', 'cl/8503924']);
    assert.equal(r.seq, 2);
    assert.equal(r.decision, '06k6q4p');
    assert.equal(r.zipData, null);
    assert.equal(r.reporter, null);
    // out of range opens the first
    assert.equal((await openDecisionRecord('06k6q4p', records, 9, () => {}, { fetchRecord })).seq, 1);
    const fail = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(openDecisionRecord('06k6q4p', records, 1, () => {}, { fetchRecord: fail }),
      /Couldn't reach the server/);
  });
});

test('a search card routed by decision id links to /d/<id>/', () => {
  assert.equal(caseHref('d/01cm306'), '/d/01cm306/');
  assert.equal(caseHref('ny/248/339'), '/#ny/248/339');
  for (const bad of ['d/01cm30', 'd/01CM306', 'd/']) {
    assert.equal(caseHref(bad), null, bad);
  }
});
