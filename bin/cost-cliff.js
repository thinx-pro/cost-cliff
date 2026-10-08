#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJsonl, parseClaudeFile, parseCodexFile, parseAnyFile } from '../src/parse.js';
import { summarize, histogram, resolveModel } from '../src/price.js';
import { buildReport, toText, toJson, toHtml } from '../src/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const HELP = `cost-cliff ${pkg.version}
Replay your own Claude Code / Codex sessions against other models' price
tables, including prompt-length tiers (the Haiku 5.5 100K line, the GPT-6
272K line), and see what the "cheap" model would really have cost.

Usage
  cost-cliff [paths...] [options]

  With no paths, reads ~/.claude/projects and ~/.codex/sessions.
  Paths can be .jsonl files or directories; the format is detected per file.

Options
  --since <30d|12h|YYYY-MM-DD|all>  time window (default: 30d)
  --source <claude|codex|all>       which default log dirs to read (default: all)
  --project <text>                  only sessions whose project name contains text
  --models <id,id,...>              models to replay on (see --list-models)
  --openai-ratio <n>                GPT tokens per Claude token (default: 1, an assumption)
  --no-sidechain                    ignore subagent (sidechain) requests
  --prices <file>                   use your own price table (same shape as prices.json)
  --json                            print the report as JSON
  --html <file>                     also write a self-contained HTML report
  --list-models                     list models in the price table
  --no-color                        disable ANSI colors
  -h, --help                        show this help
  -v, --version                     show version

Nothing is sent anywhere; logs are read locally.`;

function parseArgs(argv) {
  const o = { paths: [], since: '30d', source: 'all', color: process.stdout.isTTY && !process.env.NO_COLOR, sidechain: true };
  const need = (i, name) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${name} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '--json') o.json = true;
    else if (a === '--list-models') o.listModels = true;
    else if (a === '--no-color') o.color = false;
    else if (a === '--no-sidechain') o.sidechain = false;
    else if (a === '--since') o.since = need(++i, a);
    else if (a === '--source') o.source = need(++i, a);
    else if (a === '--project') o.project = need(++i, a);
    else if (a === '--models') o.models = need(++i, a);
    else if (a === '--openai-ratio') o.openaiRatio = Number(need(++i, a));
    else if (a === '--prices') o.prices = need(++i, a);
    else if (a === '--html') o.html = need(++i, a);
    else if (a.startsWith('-')) throw new Error(`unknown option ${a} (see --help)`);
    else o.paths.push(a);
  }
  if (!['claude', 'codex', 'all'].includes(o.source)) throw new Error('--source must be claude, codex or all');
  if (o.openaiRatio !== undefined && !(o.openaiRatio > 0)) throw new Error('--openai-ratio must be a positive number');
  return o;
}

function sinceToMs(s, now = Date.now()) {
  if (!s || s === 'all') return -Infinity;
  const m = String(s).match(/^(\d+(?:\.\d+)?)([hdw])$/);
  if (m) return now - Number(m[1]) * { h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2]];
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  throw new Error(`cannot read --since ${s}`);
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error('cost-cliff: ' + e.message); process.exit(2); }
  if (o.help) { console.log(HELP); return; }
  if (o.version) { console.log(pkg.version); return; }

  const pricesPath = o.prices || path.join(here, '..', 'prices.json');
  const prices = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
  if (o.listModels) {
    for (const [id, m] of Object.entries(prices.models)) {
      const t = m.tiers.map((t) => `$${t.input}/$${t.output}${t.upTo ? ` ≤${t.upTo / 1000}K` : ''}`).join(' → ');
      console.log(`${id.padEnd(20)} ${m.label.padEnd(12)} ${t}`);
    }
    return;
  }
  let models = prices.defaultCompare;
  if (o.models) {
    models = o.models.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const id = resolveModel(s, prices);
      if (!id) { console.error(`cost-cliff: unknown model ${s} (see --list-models)`); process.exit(2); }
      return id;
    });
  }

  let since;
  try { since = sinceToMs(o.since); } catch (e) { console.error('cost-cliff: ' + e.message); process.exit(2); }

  let requests = [];
  if (o.paths.length) {
    for (const p of o.paths) for (const f of listJsonl(p)) requests.push(...parseAnyFile(f));
  } else {
    const home = os.homedir();
    if (o.source !== 'codex') for (const f of listJsonl(path.join(home, '.claude', 'projects'))) requests.push(...parseClaudeFile(f));
    if (o.source !== 'claude') for (const f of listJsonl(path.join(home, '.codex', 'sessions'))) requests.push(...parseCodexFile(f));
  }
  requests = requests.filter((r) => (Number.isFinite(r.ts) ? r.ts >= since : since === -Infinity));
  if (o.project) requests = requests.filter((r) => r.project.toLowerCase().includes(o.project.toLowerCase()));
  if (!o.sidechain) requests = requests.filter((r) => !r.sidechain);

  if (!requests.length) {
    console.error('cost-cliff: no model requests found' + (o.paths.length ? ' in the given paths' : ' in ~/.claude/projects or ~/.codex/sessions') + ` (window: ${o.since}). Try --since all.`);
    process.exit(1);
  }

  const summary = summarize(requests, prices, { models, openaiRatio: o.openaiRatio });
  const crossVendor = requests.some((r) => !String(r.model).startsWith('claude')) || models.some((m) => prices.models[m].vendor !== 'anthropic');
  const assumptions = [
    'Same trajectory: every request is replayed with the token counts that were logged. A different model would write different output and take a different number of turns.',
    'A request whose prompt (uncached + cache writes + cache reads) is over a tier line is billed entirely at the higher tier, as both vendors document.',
    'Cache hits, 5m/1h cache writes and uncached input keep the split the original run had. Effort level and thinking tokens are counted as logged output.',
    crossVendor
      ? `Claude ↔ GPT token counts are converted at ${o.openaiRatio || 1} GPT token(s) per Claude token${o.openaiRatio ? ' (your --openai-ratio)' : ' — no official ratio exists; try --openai-ratio'}.`
      : 'All models compared share the same Claude tokenizer, so no token conversion is applied.',
    'Context-window limits are not checked: a request larger than a model\'s window is still priced as if it fit.',
    'List prices only: no batch, enterprise discounts or subscription plans. Cliff premium = extra paid because the request was over the line.',
  ];
  const rep = buildReport({
    requests,
    summary,
    hist: histogram(requests),
    meta: { version: pkg.version, since: o.since, assumptions, pricesRetrieved: prices.retrieved },
  });

  if (o.json) console.log(toJson(rep));
  else console.log(toText(rep, o.color));
  if (o.html) {
    fs.writeFileSync(o.html, toHtml(rep));
    if (!o.json) console.log(`\nHTML report written to ${o.html}`);
  }
}

main();
