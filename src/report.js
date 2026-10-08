// Render a summary as terminal text, JSON, or a self-contained HTML page.

const fmtUsd = (v) => {
  if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 100) return '$' + v.toFixed(0);
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(3);
};
const fmtInt = (v) => Math.round(v).toLocaleString('en-US');
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0) + '%';
const fmtK = (v) => (v >= 1000 ? Math.round(v / 1000) + 'K' : String(v));
const day = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '?');

export function buildReport(data) {
  const { requests, summary, hist, meta } = data;
  const sessions = new Set(requests.map((r) => r.source + ':' + r.session)).size;
  let tMin = Infinity, tMax = -Infinity;
  for (const r of requests) if (Number.isFinite(r.ts)) { if (r.ts < tMin) tMin = r.ts; if (r.ts > tMax) tMax = r.ts; }
  const times = Number.isFinite(tMin) ? [tMin, tMax] : [];
  const bySource = {};
  for (const r of requests) bySource[r.source] = (bySource[r.source] || 0) + 1;
  const sizes = requests.map((r) => r.uncached + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead).sort((a, b) => a - b);
  const q = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] : 0);
  const rows = summary.rows.map((r) => ({ ...r, overShare: r.n ? r.over / r.n : 0, premiumShare: r.cost ? r.premium / r.cost : 0 }));
  const tiered = rows.filter((r) => r.threshold != null && r.over > 0).sort((a, b) => b.premiumShare - a.premiumShare);
  return {
    version: meta.version,
    window: { from: times.length ? day(Math.min(...times)) : null, to: times.length ? day(Math.max(...times)) : null, since: meta.since },
    requests: requests.length,
    sessions,
    bySource,
    promptSize: { p50: q(0.5), p90: q(0.9), max: sizes.length ? sizes[sizes.length - 1] : 0 },
    histogram: hist,
    models: rows,
    actual: summary.actual,
    headline: tiered[0]
      ? `${tiered[0].label}: ${pct(tiered[0].over, tiered[0].n)} of your requests are over its ${fmtK(tiered[0].threshold)} line, and that is ${pct(tiered[0].premium, tiered[0].cost)} of its bill.`
      : null,
    assumptions: meta.assumptions,
    prices: meta.pricesRetrieved,
  };
}

export function toJson(rep) {
  return JSON.stringify(rep, null, 2);
}

export function toText(rep, color = false) {
  const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = c('1'), dim = c('2'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36');
  const out = [];
  const src = Object.entries(rep.bySource).map(([k, v]) => `${k === 'claude' ? 'Claude Code' : k === 'codex' ? 'Codex' : k} ${fmtInt(v)}`).join(' · ');
  out.push(bold('cost-cliff') + dim(` ${rep.version}`) + `  ${fmtInt(rep.requests)} requests · ${fmtInt(rep.sessions)} sessions · ${rep.window.from} → ${rep.window.to}`);
  out.push(dim(`sources: ${src || 'none'} · prices as of ${rep.prices}`));
  out.push('');
  out.push(bold('Prompt size per request') + dim(`   p50 ${fmtK(rep.promptSize.p50)} · p90 ${fmtK(rep.promptSize.p90)} · max ${fmtK(rep.promptSize.max)}`));
  const maxCount = Math.max(1, ...rep.histogram.map((h) => h.count));
  for (const h of rep.histogram) {
    const w = Math.round((h.count / maxCount) * 30);
    const bar = '█'.repeat(w) + (h.count > 0 && w === 0 ? '▏' : '');
    const over100 = h.label !== '0–50K' && h.label !== '50–100K';
    const over272 = over100 && h.label !== '100–200K' && h.label !== '200–272K';
    const tint = over272 ? red : over100 ? yellow : green;
    out.push(`  ${h.label.padEnd(10)} ${tint(bar.padEnd(31))}${fmtInt(h.count).padStart(7)}  ${dim(pct(h.count, rep.requests).padStart(4))}`);
  }
  out.push(dim('  yellow = over the 100K Haiku 5.5 line · red = also over the 272K GPT-6 line'));
  out.push('');
  out.push(bold('Same trajectory, replayed on'));
  out.push(dim('  ' + 'model'.padEnd(13) + 'est. cost'.padStart(11) + '   ' + 'requests over cliff'.padEnd(22) + 'cliff premium'));
  const cheapest = Math.min(...rep.models.map((m) => m.cost));
  for (const m of rep.models) {
    const over = m.threshold == null ? dim('no tier') : m.over ? yellow(`${fmtInt(m.over)} (${pct(m.over, m.n)}) >${fmtK(m.threshold)}`) : green(`0 >${fmtK(m.threshold)}`);
    const prem = m.premium > 0 ? red(`${fmtUsd(m.premium)} (${pct(m.premium, m.cost)} of bill)`) : dim('—');
    const cost = m.cost === cheapest ? green(fmtUsd(m.cost).padStart(11)) : fmtUsd(m.cost).padStart(11);
    const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    out.push('  ' + m.label.padEnd(13) + cost + '   ' + over + ' '.repeat(Math.max(1, 22 - visible(over).length)) + prem);
  }
  out.push('');
  const a = rep.actual;
  let line = `Actual list-price cost of what ran: ${bold(fmtUsd(a.cost))} over ${fmtInt(a.priced)} requests`;
  if (a.unpriced) line += dim(` (${fmtInt(a.unpriced)} requests from ${a.unpricedModels.join(', ')} not in the price table)`);
  out.push(line);
  if (rep.headline) out.push(cyan('→ ' + rep.headline));
  out.push('');
  for (const s of rep.assumptions) out.push(dim('· ' + s));
  return out.join('\n');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function toHtml(rep) {
  const maxCount = Math.max(1, ...rep.histogram.map((h) => h.count));
  const maxCost = Math.max(1e-9, ...rep.models.map((m) => m.cost));
  const hist = rep.histogram.map((h, i) => {
    const cls = i < 2 ? 'ok' : i < 4 ? 'warn' : 'bad';
    return `<div class="hrow"><span class="hl">${esc(h.label)}</span><span class="track"><span class="bar ${cls}" style="width:${((h.count / maxCount) * 100).toFixed(1)}%"></span></span><span class="hn">${fmtInt(h.count)} <em>${pct(h.count, rep.requests)}</em></span></div>`;
  }).join('');
  const models = rep.models.map((m) => {
    const base = m.cost - m.premium;
    const over = m.threshold == null ? '<span class="muted">no tier</span>' : `${fmtInt(m.over)} <em>(${pct(m.over, m.n)})</em> over ${fmtK(m.threshold)}`;
    return `<tr><td class="name">${esc(m.label)}</td>
      <td class="costcell"><span class="cbar"><span class="base" style="width:${((base / maxCost) * 100).toFixed(2)}%"></span><span class="prem" style="width:${((m.premium / maxCost) * 100).toFixed(2)}%"></span></span><b>${fmtUsd(m.cost)}</b></td>
      <td>${over}</td>
      <td>${m.premium > 0 ? `<span class="badtxt">${fmtUsd(m.premium)}</span> <em>(${pct(m.premium, m.cost)} of bill)</em>` : '<span class="muted">—</span>'}</td></tr>`;
  }).join('');
  const src = Object.entries(rep.bySource).map(([k, v]) => `${k === 'claude' ? 'Claude Code' : k === 'codex' ? 'Codex' : esc(k)} ${fmtInt(v)}`).join(' · ');
  const a = rep.actual;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cost-cliff report</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#77756f;--line:#e6e3dc;--ok:#3f8f5a;--warn:#d39b22;--bad:#c8453b;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#9a978f;--line:#2e2d2a;--card:#1e1e1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 20px 48px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}h1 small{font-weight:400;color:var(--muted);font-size:14px;margin-left:6px}
.meta{color:var(--muted);font-size:13px;margin-bottom:22px}
.headline{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--bad);padding:12px 16px;border-radius:8px;margin-bottom:22px;font-weight:600}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:18px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;font-weight:600}
.hrow{display:grid;grid-template-columns:90px 1fr 110px;gap:10px;align-items:center;margin:5px 0;font-variant-numeric:tabular-nums}
.hl{font-size:13px;color:var(--muted)}.hn{text-align:right;font-size:13px}.hn em,td em{color:var(--muted);font-style:normal}
.track{height:14px;background:var(--line);border-radius:3px;overflow:hidden}.bar{display:block;height:100%}
.ok{background:var(--ok)}.warn{background:var(--warn)}.bad{background:var(--bad)}
.legend{font-size:12px;color:var(--muted);margin-top:8px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:9px 8px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle}tr:last-child td{border-bottom:0}
.name{font-weight:600;white-space:nowrap}.costcell{min-width:220px}.cbar{display:flex;height:10px;width:140px;background:var(--line);border-radius:3px;overflow:hidden;float:left;margin:5px 10px 0 0}
.base{background:var(--fg);opacity:.75}.prem{background:var(--bad)}.badtxt{color:var(--bad);font-weight:600}.muted{color:var(--muted)}
ul{margin:0;padding-left:18px;color:var(--muted);font-size:13px}
@media (max-width:640px){.cbar{display:none}.hrow{grid-template-columns:72px 1fr 84px}}
</style></head><body><main>
<h1>cost-cliff <small>${esc(rep.version)}</small></h1>
<div class="meta">${fmtInt(rep.requests)} requests · ${fmtInt(rep.sessions)} sessions · ${esc(rep.window.from)} → ${esc(rep.window.to)} · ${src} · prices as of ${esc(rep.prices)}</div>
${rep.headline ? `<div class="headline">${esc(rep.headline)}</div>` : ''}
<section><h2>Prompt size per request <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· p50 ${fmtK(rep.promptSize.p50)} · p90 ${fmtK(rep.promptSize.p90)} · max ${fmtK(rep.promptSize.max)}</span></h2>${hist}
<div class="legend">amber = over the 100K Haiku 5.5 line · red = also over the 272K GPT-6 line</div></section>
<section><h2>Same trajectory, replayed on</h2>
<table><thead><tr><th>Model</th><th>Est. cost <span class="muted">(red = cliff premium)</span></th><th>Requests over cliff</th><th>Cliff premium</th></tr></thead><tbody>${models}</tbody></table>
<p class="muted" style="font-size:13px;margin:12px 0 0">Actual list-price cost of what ran: <b style="color:var(--fg)">${fmtUsd(a.cost)}</b> over ${fmtInt(a.priced)} requests${a.unpriced ? ` (${fmtInt(a.unpriced)} from ${esc(a.unpricedModels.join(', '))} not priced)` : ''}.</p></section>
<section><h2>Assumptions</h2><ul>${rep.assumptions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></section>
</main></body></html>
`;
}
