#!/usr/bin/env node
// Chooses which smoke specs a Preview PR run needs (#294): a spec is skipped only when
// a previous run recorded a pass for the same hash of its inputs (inputs.js), and runs
// whenever that can't be shown. The record is a small JSON ledger of passing hashes
// kept in the Actions cache (.github/actions/smoke-test says where).
//
//   node web/e2e/select.mjs keys --out keys.json
//     Hashes each spec's inputs as they are on disk after the build. Exits non-zero if
//     a generated input is missing or an external manifest can't be fetched; the
//     caller then runs everything and records nothing.
//   node web/e2e/select.mjs plan --keys keys.json --mode affected|all [--ledger f]...
//     Writes the Playwright file filters to run to $GITHUB_OUTPUT (`filters`, `run`,
//     `reused`) and a table of what ran and what was reused to $GITHUB_STEP_SUMMARY.
//   node web/e2e/select.mjs record --keys keys.json --report report.json --out f
//       --run <url> [--ledger f]...
//     Merges the ledgers (the newest entry for a hash wins), records a pass for the
//     hash of each spec whose every test passed on its first try and a failure for
//     each spec with a failing or flaky test, and drops entries older than 30 days.
//     Only a pass is reused: a failure blocks reuse of an older pass of the same hash.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTERNAL, GENERATED, NOT_INPUTS, SHARED, SHARED_EXCLUDE, SPECS } from './inputs.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FORMAT = 1;
const MAX_AGE_DAYS = 30;

// A glob from inputs.js as a RegExp: `**` spans segments, `*` stays within one.
export function globRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const cache = new Map();
export function matches(path, globs) {
  return globs.some((g) => {
    if (!cache.has(g)) cache.set(g, globRegExp(g));
    return cache.get(g).test(path);
  });
}

// A spec's groups as [{ include, exclude }]: a file is in a group when an include
// matches and no exclude of that same group does.
export const inParts = (path, parts) =>
  parts.some((p) => matches(path, p.include) && !matches(path, p.exclude ?? []));

export const isShared = (path) => matches(path, SHARED) && !matches(path, SHARED_EXCLUDE);

// Whether `path` is one of `spec`'s inputs (SHARED, its groups, or the spec itself).
export const isInput = (path, spec) =>
  path === spec || isShared(path) || inParts(path, SPECS[spec]);

// Whether `spec` depends on `path` existing, though not on its contents (`names`).
export const isNamed = (path, spec) => SPECS[spec].some((p) => matches(path, p.names ?? []));

export const isNotInput = (path) => matches(path, Object.keys(NOT_INPUTS));

export function trackedFiles(root = ROOT) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

// The generated files on disk (gitignore keeps them out of `git ls-files`).
export function generatedFiles(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(posix.join(rel, name));
    } else if (matches(rel, GENERATED) && !isNotInput(rel)) {
      out.push(rel);
    }
  };
  for (const g of GENERATED) walk(g.replace(/\/?\*\*.*$/, ''));
  return [...new Set(out)].sort();
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function externalHashes(fetchFn = fetch) {
  const out = [];
  for (const url of EXTERNAL) {
    const res = await fetchFn(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    out.push(`external ${url} ${sha256(Buffer.from(await res.arrayBuffer()))}`);
  }
  return out;
}

// Each spec's key: the SHA-256 of its inputs' paths and contents, the external
// manifests, and the Node and runner image versions.
export async function computeKeys({ root = ROOT, fetchFn = fetch, env = process.env } = {}) {
  const tracked = trackedFiles(root);
  const generated = generatedFiles(root);
  const files = [...new Set([...tracked, ...generated])].sort();
  for (const g of GENERATED) {
    if (!generated.some((f) => matches(f, [g]))) throw new Error(`no ${g}: run the build first`);
  }
  const fileHash = new Map();
  const hashOf = (f) => {
    if (!fileHash.has(f)) fileHash.set(f, sha256(readFileSync(join(root, f))));
    return fileHash.get(f);
  };
  const common = [
    `format ${FORMAT}`,
    `node ${process.version}`,
    `image ${env.ImageOS || 'unknown'}-${env.ImageVersion || 'unknown'}`,
    ...(await externalHashes(fetchFn)),
  ];
  const specs = {};
  for (const spec of Object.keys(SPECS).sort()) {
    if (!existsSync(join(root, spec))) throw new Error(`${spec} is in inputs.js but doesn't exist`);
    const lines = [...common];
    for (const f of files) {
      if (!existsSync(join(root, f))) continue;
      if (isInput(f, spec)) lines.push(`${f} ${hashOf(f)}`);
      else if (isNamed(f, spec)) lines.push(`${f} exists`);
    }
    specs[spec] = sha256(`${lines.join('\n')}\n`);
  }
  return { format: FORMAT, specs };
}

export function readLedger(path) {
  if (!path || !existsSync(path)) return { format: FORMAT, entries: {} };
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    if (ledger.format !== FORMAT || typeof ledger.entries !== 'object') return { format: FORMAT, entries: {} };
    return ledger;
  } catch {
    return { format: FORMAT, entries: {} };
  }
}

export function mergeLedgers(ledgers) {
  const entries = {};
  for (const l of ledgers) {
    for (const [key, e] of Object.entries(l.entries)) {
      if (!entries[key] || entries[key].at < e.at) entries[key] = e;
    }
  }
  return { format: FORMAT, entries };
}

// The Playwright filter for one spec: its path, escaped and anchored, so cache.spec.js
// doesn't also pick up zipcache.spec.js.
export const filterFor = (spec) => `/${spec.replace(/^web\//, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&')}$`;

// Which specs run and which reuse a recorded pass. `onDisk` lists the spec files
// present; one the keys don't cover (not in inputs.js) always runs.
export function plan(keys, ledger, mode, onDisk = Object.keys(keys.specs)) {
  const run = [];
  const reused = [];
  for (const [spec, key] of Object.entries(keys.specs)) {
    const hit = mode === 'affected' ? ledger.entries[key] : undefined;
    if (hit && hit.ok === true && hit.spec === spec) reused.push({ spec, key, ...hit });
    else run.push({ spec, key });
  }
  for (const spec of onDisk) if (!(spec in keys.specs)) run.push({ spec, key: 'not in inputs.js' });
  return { run, reused };
}

export function specsOnDisk(root = ROOT) {
  return readdirSync(join(root, 'web/e2e')).filter((n) => /\.spec\.[cm]?js$/.test(n)).map((n) => `web/e2e/${n}`).sort();
}

// spec path (from web/) -> 'passed' | 'failed', from Playwright's JSON report. A spec
// passed only if it has tests and every one ran and passed on its first try.
export function specOutcomes(report) {
  const out = {};
  const visit = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const key = `web/e2e/${f}`;
        const ok = t.status === 'expected' && (t.results ?? []).length === 1;
        out[key] = out[key] === 'failed' || !ok ? 'failed' : 'passed';
      }
    }
    for (const child of suite.suites ?? []) visit(child, f);
  };
  for (const s of report.suites ?? []) visit(s, s.file);
  return out;
}

export function record(keys, report, ledger, { run, now = new Date() }) {
  const entries = { ...ledger.entries };
  const outcomes = specOutcomes(report);
  for (const [spec, outcome] of Object.entries(outcomes)) {
    const key = keys.specs[spec];
    if (!key) continue;
    entries[key] = { spec, ok: outcome === 'passed', run, at: now.toISOString() };
  }
  const cutoff = now.getTime() - MAX_AGE_DAYS * 86_400_000;
  for (const [key, e] of Object.entries(entries)) {
    if (!(Date.parse(e.at) >= cutoff)) delete entries[key];
  }
  return { ledger: { format: FORMAT, entries }, outcomes };
}

function args(argv) {
  const out = { ledger: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._ = a; continue; }
    const name = a.slice(2);
    const value = argv[++i];
    if (name === 'ledger') out.ledger.push(value);
    else out[name] = value;
  }
  return out;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
}

async function main(argv) {
  const opts = args(argv);
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  if (opts._ === 'keys') {
    const keys = await computeKeys();
    writeFileSync(opts.out, `${JSON.stringify(keys, null, 2)}\n`);
    for (const [spec, key] of Object.entries(keys.specs)) console.log(`${key.slice(0, 12)}  ${spec}`);
  } else if (opts._ === 'plan') {
    const keys = readJson(opts.keys);
    const mode = opts.mode === 'affected' ? 'affected' : 'all';
    const { run, reused } = plan(keys, mergeLedgers(opts.ledger.map(readLedger)), mode, specsOnDisk());
    // With nothing reused, no filters: Playwright runs every file under web/e2e/.
    output('filters', reused.length ? run.map((r) => filterFor(r.spec)).join(' ') : '');
    output('run', run.length);
    output('reused', reused.length);
    const rows = [
      ...run.map((r) => `| \`${r.spec}\` | \`${r.key.slice(0, 12)}\` | runs |`),
      ...reused.map((r) => `| \`${r.spec}\` | \`${r.key.slice(0, 12)}\` | reused from [${r.run.replace(/.*\/runs\//, 'run ')}](${r.run}), ${r.at.slice(0, 10)} |`),
    ];
    summary([
      '### Smoke specs',
      '',
      mode === 'all'
        ? `Every spec runs (${opts.reason || 'full run'}).`
        : `${run.length} of ${run.length + reused.length} specs run; ${reused.length ? 'the others passed in an earlier run on identical inputs' : 'none has inputs identical to an earlier passing run'} (\`web/e2e/inputs.js\`). The \`full-smoke\` label runs them all.`,
      '',
      '| Spec | Inputs | |',
      '| --- | --- | --- |',
      ...rows,
      '',
      '',
    ].join('\n'));
    for (const r of run) console.log(`run     ${r.spec}`);
    for (const r of reused) console.log(`reused  ${r.spec} (${r.run})`);
  } else if (opts._ === 'record') {
    const keys = readJson(opts.keys);
    const report = existsSync(opts.report) ? readJson(opts.report) : { suites: [] };
    const { ledger, outcomes } = record(keys, report, mergeLedgers(opts.ledger.map(readLedger)), { run: opts.run });
    writeFileSync(opts.out, `${JSON.stringify(ledger)}\n`);
    for (const [spec, outcome] of Object.entries(outcomes)) console.log(`${outcome.padEnd(7)} ${spec}`);
    console.log(`${Object.keys(ledger.entries).length} passing input hashes recorded`);
  } else {
    throw new Error('usage: select.mjs keys|plan|record (see the header)');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

