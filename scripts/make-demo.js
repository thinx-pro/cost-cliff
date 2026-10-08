// Generate a synthetic, deterministic Claude Code log for the README demo.
// Shape: agent sessions whose context grows a few K tokens per turn and is
// compacted when it gets large — the pattern that crosses a 100K tier line.
// Usage: node scripts/make-demo.js [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || path.join(here, '..', 'demo', 'claude');

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const between = (a, b) => Math.round(a + rnd() * (b - a));

const sessions = [
  { id: 'demo-refactor', turns: 220, start: 22000, compactAt: 185000 },
  { id: 'demo-bugfix', turns: 90, start: 18000, compactAt: 160000 },
  { id: 'demo-feature', turns: 160, start: 26000, compactAt: 210000 },
];

fs.mkdirSync(outDir, { recursive: true });
let t = Date.parse('2026-10-01T09:00:00Z');
for (const s of sessions) {
  const lines = [];
  let ctx = s.start;
  for (let i = 0; i < s.turns; i++) {
    const growth = between(1500, 7000);
    const output = between(200, 1800);
    const first = i === 0;
    const usage = {
      input_tokens: between(1, 40),
      cache_creation_input_tokens: first ? ctx : growth,
      cache_read_input_tokens: first ? 0 : ctx,
      output_tokens: output,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: first ? ctx : growth },
      speed: 'standard',
    };
    t += between(8, 60) * 1000;
    lines.push(JSON.stringify({
      type: 'assistant', sessionId: s.id, cwd: '/demo/' + s.id, requestId: `req_${s.id}_${i}`,
      timestamp: new Date(t).toISOString(),
      message: { id: `msg_${s.id}_${i}`, model: 'claude-sonnet-5-5', role: 'assistant', content: [], usage },
    }));
    ctx += growth + output;
    if (ctx > s.compactAt) ctx = between(30000, 45000);
  }
  fs.writeFileSync(path.join(outDir, s.id + '.jsonl'), lines.join('\n') + '\n');
}
console.log(`wrote ${sessions.length} demo sessions to ${outDir}`);
