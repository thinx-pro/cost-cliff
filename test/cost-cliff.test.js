import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseClaudeFile, parseCodexFile, parseAnyFile, promptSize } from '../src/parse.js';
import { priceRequest, resolveModel, tokenRatio, tokenizerOf, summarize, histogram } from '../src/price.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const prices = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8'));
const claudeFile = path.join(here, 'fixtures/claude/proj/session-a.jsonl');
const codexFile = path.join(here, 'fixtures/codex/2026/10/01/rollout-b.jsonl');
const cli = path.join(root, 'bin/cost-cliff.js');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('claude: dedupes content-block lines, keeps the last usage, drops synthetic errors', () => {
  const rs = parseClaudeFile(claudeFile);
  assert.equal(rs.length, 3);
  const [a, b, c] = rs;
  assert.equal(a.output, 500);
  assert.equal(a.cacheWrite1h, 40000);
  assert.equal(promptSize(a), 40010);
  assert.equal(promptSize(b), 150000);
  assert.equal(a.project, 'demo-app');
  assert.equal(c.sidechain, true);
  assert.equal(c.model, 'claude-haiku-5-5');
});

test('codex: dedupes repeated token_count snapshots and splits cached input', () => {
  const rs = parseCodexFile(codexFile);
  assert.equal(rs.length, 2);
  assert.equal(rs[0].model, 'gpt-6-luna');
  assert.equal(rs[0].uncached, 100000);
  assert.equal(rs[0].cacheRead, 200000);
  assert.equal(rs[0].project, 'other-app');
  assert.equal(rs[0].session, 'sb');
});

test('format sniffing picks the right parser', () => {
  assert.equal(parseAnyFile(claudeFile).length, 3);
  assert.equal(parseAnyFile(codexFile)[0].source, 'codex');
});

test('Haiku 5.5: a 150K prompt is billed wholly at the >100K tier', () => {
  const b = parseClaudeFile(claudeFile)[1];
  const p = priceRequest(b, 'claude-haiku-5-5', prices);
  assert.equal(p.overCliff, true);
  close(p.cost, 0.0195); // 10K*1 + 140K*0.05 + 1K*2.5
  close(p.premium, 0.0195 - 0.0039);
  const a = parseClaudeFile(claudeFile)[0];
  const pa = priceRequest(a, 'claude-haiku-5-5', prices);
  assert.equal(pa.overCliff, false);
  close(pa.cost, 0.008251);
});

test('exactly 100,000 tokens stays in the lower tier', () => {
  const r = { uncached: 100000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  assert.equal(priceRequest(r, 'claude-haiku-5-5', prices).overCliff, false);
  assert.equal(priceRequest({ ...r, uncached: 100001 }, 'claude-haiku-5-5', prices).overCliff, true);
});

test('GPT-6 Luna: over 272K flips the whole request', () => {
  const [r1, r2] = parseCodexFile(codexFile);
  const p1 = priceRequest(r1, 'gpt-6-luna', prices);
  assert.equal(p1.overCliff, true);
  close(p1.cost, 0.024375);
  close(p1.premium, 0.024375 - 0.01225);
  close(priceRequest(r2, 'gpt-6-luna', prices).cost, 0.0019);
});

test('actual cost uses the model that ran, with fast-mode and US-geo multipliers', () => {
  const [a, b] = parseClaudeFile(claudeFile);
  close(priceRequest(a, 'claude-opus-5-5', prices, { actual: true }).cost, 0.33004);
  close(priceRequest(b, 'claude-opus-5-5', prices, { actual: true }).cost, 0.128);
  close(priceRequest({ ...b, speed: 'fast' }, 'claude-opus-5-5', prices, { actual: true }).cost, 0.256);
  close(priceRequest({ ...b, geo: 'us' }, 'claude-opus-5-5', prices, { actual: true }).cost, 0.1408);
});

test('model id resolution', () => {
  assert.equal(resolveModel('claude-opus-5-5', prices), 'claude-opus-5-5');
  assert.equal(resolveModel('claude-haiku-4-5-20251001', prices), 'claude-haiku-4-5');
  assert.equal(resolveModel('claude-opus-5-5[1m]', prices), 'claude-opus-5-5');
  assert.equal(resolveModel('gpt-5.5', prices), 'gpt-5-5');
  assert.equal(resolveModel('claude-opus-5', prices), 'claude-opus-5');
  assert.equal(resolveModel('haiku-5.5', prices), 'claude-haiku-5-5');
  assert.equal(resolveModel('mystery-model', prices), null);
});

test('tokenizer ratios', () => {
  assert.equal(tokenizerOf('claude-sonnet-4-6', prices), 'claude-legacy');
  assert.equal(tokenizerOf('claude-opus-4-9', prices), 'claude-2026');
  assert.equal(tokenizerOf('gpt-5.3-codex', prices), 'openai');
  close(tokenRatio('claude-2026', 'claude-legacy'), 1 / 1.3);
  close(tokenRatio('claude-legacy', 'claude-2026'), 1.3);
  assert.equal(tokenRatio('claude-2026', 'openai'), 1);
  close(tokenRatio('claude-2026', 'openai', { openaiRatio: 0.65 }), 0.65);
  close(tokenRatio('openai', 'claude-2026', { openaiRatio: 0.5 }), 2);
});

test('summarize + histogram', () => {
  const rs = [...parseClaudeFile(claudeFile), ...parseCodexFile(codexFile)];
  const s = summarize(rs, prices, { models: ['claude-haiku-5-5', 'gpt-6-luna'] });
  const haiku = s.rows[0];
  assert.equal(haiku.over, 2); // the 150K Claude request and the 300K Codex request
  assert.equal(s.actual.priced, 5);
  const h = histogram(rs);
  assert.deepEqual(h.map((x) => x.count), [3, 0, 1, 0, 1, 0]); // 40K, 2K and exactly 50K are all ≤50K
});

test('CLI: --help, --version, bad option', () => {
  assert.match(execFileSync('node', [cli, '--help'], { encoding: 'utf8' }), /Usage/);
  assert.equal(execFileSync('node', [cli, '--version'], { encoding: 'utf8' }).trim(), '0.1.0');
  const bad = spawnSync('node', [cli, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option/);
});

test('CLI: JSON and HTML on fixture paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-cliff-'));
  const html = path.join(tmp, 'r.html');
  const out = execFileSync('node', [cli, path.join(here, 'fixtures'), '--since', 'all', '--json', '--html', html], { encoding: 'utf8' });
  const rep = JSON.parse(out);
  assert.equal(rep.requests, 5);
  assert.equal(rep.sessions, 2);
  assert.ok(rep.models.find((m) => m.id === 'claude-haiku-5-5').over === 2);
  assert.match(fs.readFileSync(html, 'utf8'), /Same trajectory, replayed on/);
  const text = execFileSync('node', [cli, path.join(here, 'fixtures'), '--since', 'all', '--no-color', '--project', 'demo'], { encoding: 'utf8' });
  assert.match(text, /3 requests/);
  assert.doesNotMatch(text, /\x1b\[/);
});

test('CLI: empty window exits 1 with a hint', () => {
  const r = spawnSync('node', [cli, path.join(here, 'fixtures'), '--since', '2099-01-01'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--since all/);
});
