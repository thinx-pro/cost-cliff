// Read Claude Code and Codex session logs into a flat list of API requests.
// A request is { source, model, ts, session, project, sidechain, speed, geo,
//                uncached, cacheWrite5m, cacheWrite1h, cacheRead, output }.
// Prompt size of a request = uncached + cacheWrite5m + cacheWrite1h + cacheRead.

import fs from 'node:fs';
import path from 'node:path';

export function listJsonl(root) {
  const out = [];
  let st;
  try { st = fs.statSync(root); } catch { return out; }
  if (st.isFile()) return root.endsWith('.jsonl') ? [root] : out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out.sort();
}

function* lines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try { yield JSON.parse(line); } catch { /* skip partial line */ }
  }
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function claudeSplit(u) {
  const cc = u.cache_creation || {};
  let cw1 = n(cc.ephemeral_1h_input_tokens);
  let cw5 = n(cc.ephemeral_5m_input_tokens);
  const cwTotal = n(u.cache_creation_input_tokens);
  if (cw1 + cw5 === 0 && cwTotal > 0) cw5 = cwTotal; // older logs: no split, assume 5m
  return {
    uncached: n(u.input_tokens),
    cacheWrite5m: cw5,
    cacheWrite1h: cw1,
    cacheRead: n(u.cache_read_input_tokens),
    output: n(u.output_tokens),
  };
}

function projectName(cwd, file) {
  if (cwd) return path.basename(cwd);
  return path.basename(path.dirname(file));
}

// Claude Code writes one JSONL line per content block, each repeating the
// message usage. Keep the last line per message id.
export function parseClaudeFile(file) {
  const byId = new Map();
  let anon = 0;
  for (const d of lines(file)) {
    if (d.type !== 'assistant' || !d.message || !d.message.usage) continue;
    const m = d.message;
    if (!m.model || m.model === '<synthetic>' || d.isApiErrorMessage) continue;
    const key = m.id || d.requestId ? (m.id || '') + '|' + (d.requestId || '') : 'anon' + anon++;
    const base = {
      source: 'claude',
      model: m.model,
      ts: d.timestamp ? Date.parse(d.timestamp) : NaN,
      session: d.sessionId || d.session_id || path.basename(file, '.jsonl'),
      project: projectName(d.cwd, file),
      sidechain: !!d.isSidechain,
      speed: m.usage.speed || 'standard',
      geo: m.usage.inference_geo || null,
    };
    const iters = Array.isArray(m.usage.iterations)
      ? m.usage.iterations.filter((it) => it && (it.type === 'message' || it.type === undefined))
      : [];
    // Each iteration is a separate model call with its own prompt size.
    const parts = iters.length > 1 ? iters.map(claudeSplit) : [claudeSplit(m.usage)];
    byId.set(key, parts.map((p) => ({ ...base, ...p })));
  }
  return [...byId.values()].flat();
}

// Codex emits event_msg/token_count with last_token_usage after each model
// call; the same snapshot can repeat, so dedupe on the running total.
export function parseCodexFile(file) {
  const out = [];
  let model = null;
  let session = path.basename(file, '.jsonl');
  let project = path.basename(path.dirname(file));
  let lastTotal = -1;
  for (const d of lines(file)) {
    const p = d.payload || {};
    if (d.type === 'session_meta') {
      if (p.id) session = p.id;
      if (p.cwd) project = path.basename(p.cwd);
    } else if (d.type === 'turn_context') {
      if (p.model) model = p.model;
      if (p.cwd) project = path.basename(p.cwd);
    } else if (d.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage) {
      const total = p.info.total_token_usage ? n(p.info.total_token_usage.total_tokens) : -2;
      if (total === lastTotal) continue;
      lastTotal = total;
      const u = p.info.last_token_usage;
      const input = n(u.input_tokens);
      const cached = Math.min(n(u.cached_input_tokens), input);
      const cw = Math.min(n(u.cache_write_input_tokens), input - cached);
      out.push({
        source: 'codex',
        model: model || 'unknown',
        ts: d.timestamp ? Date.parse(d.timestamp) : NaN,
        session,
        project,
        sidechain: false,
        speed: 'standard',
        geo: null,
        uncached: input - cached - cw,
        cacheWrite5m: cw,
        cacheWrite1h: 0,
        cacheRead: cached,
        output: n(u.output_tokens),
      });
    }
  }
  return out;
}

// Sniff the first useful line to decide the format of an arbitrary file.
export function parseAnyFile(file) {
  for (const d of lines(file)) {
    if (d.type === 'session_meta' || d.type === 'turn_context' || d.type === 'event_msg' || d.type === 'response_item') {
      return parseCodexFile(file);
    }
    if (d.type === 'assistant' || d.type === 'user' || d.sessionId) return parseClaudeFile(file);
  }
  return [];
}

export function promptSize(r) {
  return r.uncached + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead;
}
