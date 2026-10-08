// Price one request on a target model, honoring prompt-length tiers.
import { promptSize } from './parse.js';

const LEGACY_RATIO = 1.3; // Anthropic: Claude 4.7+ tokenizer yields ~30% more tokens

export function resolveModel(id, prices) {
  if (!id) return null;
  if (prices.models[id]) return id;
  let s = String(id).toLowerCase().replace(/\[.*?\]$/, '').replace(/^(anthropic|openai)\//, '');
  s = s.replace(/[-@]\d{8}$/, '').replace(/\./g, '-');
  if (prices.models[s]) return s;
  if (prices.models['claude-' + s]) return 'claude-' + s; // short names: haiku-5.5, opus-5.5
  // "claude-haiku-5-5-latest" or similar suffixes
  const keys = Object.keys(prices.models).sort((a, b) => b.length - a.length);
  const hit = keys.find((k) => s.startsWith(k + '-'));
  return hit || null;
}

// Tokenizer family for a model id that may not be in the price table.
export function tokenizerOf(id, prices) {
  const known = resolveModel(id, prices);
  if (known) return prices.models[known].tokenizer;
  const s = String(id || '').toLowerCase();
  const m = s.match(/claude-(?:[a-z]+-)?(\d+)-(\d+)/) || s.match(/claude-(?:[a-z]+-)?(\d+)/);
  if (m) {
    const major = Number(m[1]);
    const minor = Number(m[2] || 0);
    return major > 4 || (major === 4 && minor >= 7) ? 'claude-2026' : 'claude-legacy';
  }
  if (s.startsWith('gpt') || /^o\d/.test(s) || s.includes('codex')) return 'openai';
  return null;
}

// How many target-tokenizer tokens one source token becomes.
export function tokenRatio(fromTok, toTok, opts = {}) {
  const unit = {
    'claude-2026': 1,
    'claude-legacy': 1 / LEGACY_RATIO,
    openai: opts.openaiRatio || 1,
  };
  if (!fromTok || !toTok || fromTok === toTok) return 1;
  return unit[toTok] / unit[fromTok];
}

function tierFor(model, size) {
  return model.tiers.find((t) => t.upTo == null || size <= t.upTo);
}

function rawCost(tier, tok, mult = { input: 1, output: 1 }) {
  return (
    (tok.uncached * tier.input +
      tok.cacheWrite5m * tier.cacheWrite5m +
      tok.cacheWrite1h * tier.cacheWrite1h +
      tok.cacheRead * tier.cacheRead) * mult.input +
    tok.output * tier.output * mult.output
  ) / 1e6;
}

// Returns { cost, size, overCliff, premium } in USD.
// premium = what the request would have cost less at the first tier's rates.
export function priceRequest(r, modelId, prices, opts = {}) {
  const model = prices.models[modelId];
  const ratio = opts.ratio ?? 1;
  const tok = {
    uncached: r.uncached * ratio,
    cacheWrite5m: r.cacheWrite5m * ratio,
    cacheWrite1h: r.cacheWrite1h * ratio,
    cacheRead: r.cacheRead * ratio,
    output: r.output * ratio,
  };
  const size = promptSize(tok);
  const tier = tierFor(model, size);
  let mult = { input: 1, output: 1 };
  if (opts.actual) {
    if (r.speed === 'fast' && model.fast) {
      mult = { input: model.fast.input / model.tiers[0].input, output: model.fast.output / model.tiers[0].output };
    }
    if (r.geo === 'us') mult = { input: mult.input * 1.1, output: mult.output * 1.1 };
  }
  const cost = rawCost(tier, tok, mult);
  const overCliff = tier !== model.tiers[0];
  const premium = overCliff ? cost - rawCost(model.tiers[0], tok, mult) : 0;
  return { cost, size, overCliff, premium };
}

export function summarize(requests, prices, opts = {}) {
  const targets = opts.models || prices.defaultCompare;
  const rows = targets.map((id) => {
    const target = prices.models[id];
    const row = { id, label: target.label, cost: 0, over: 0, premium: 0, threshold: target.tiers[0].upTo, n: requests.length };
    for (const r of requests) {
      const ratio = tokenRatio(tokenizerOf(r.model, prices), target.tokenizer, opts);
      const p = priceRequest(r, id, prices, { ratio });
      row.cost += p.cost;
      row.premium += p.premium;
      if (p.overCliff) row.over += 1;
    }
    return row;
  });

  const actual = { cost: 0, priced: 0, unpriced: 0, unpricedModels: new Set() };
  for (const r of requests) {
    const id = resolveModel(r.model, prices);
    if (!id) { actual.unpriced += 1; actual.unpricedModels.add(r.model); continue; }
    actual.cost += priceRequest(r, id, prices, { actual: true }).cost;
    actual.priced += 1;
  }
  actual.unpricedModels = [...actual.unpricedModels];
  return { rows, actual };
}

export const BUCKETS = [
  { label: '0–50K', max: 50000 },
  { label: '50–100K', max: 100000 },
  { label: '100–200K', max: 200000 },
  { label: '200–272K', max: 272000 },
  { label: '272K–500K', max: 500000 },
  { label: '500K+', max: Infinity },
];

export function histogram(requests) {
  const counts = BUCKETS.map(() => 0);
  for (const r of requests) {
    const s = promptSize(r);
    counts[BUCKETS.findIndex((b) => s <= b.max)] += 1;
  }
  return BUCKETS.map((b, i) => ({ label: b.label, count: counts[i] }));
}
