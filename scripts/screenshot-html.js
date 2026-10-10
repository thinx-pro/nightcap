// Runs the demo and the morning report, and renders both as an HTML terminal
// window for the README screenshot (captured with headless Chrome).
// Usage: node scripts/screenshot-html.js <out.html>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (args) => execFileSync('node', args, { cwd: root, encoding: 'utf8' });
const demo = run(['demo/overnight.js']).split('\nLedger:')[0];
const report = run(['bin/nightcap.js', 'report', '--policy', 'demo/policy.json', '--ledger', 'demo/.out/ledger.jsonl', '--color']);

const color = { 1: 'font-weight:700', 31: 'color:#ff7b72', 32: 'color:#7ee787', 33: 'color:#e3b341', 36: 'color:#56d4dd', 90: 'color:#8b949e' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ansi = (src) => {
  let open = 0;
  return esc(src).replace(/\x1b\[(\d+)m/g, (_, c) => {
    if (c === '0') { const s = '</span>'.repeat(open); open = 0; return s; }
    open += 1;
    return `<span style="${color[c] || ''}">`;
  });
};
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0d1117}
.win{margin:24px;border-radius:10px;background:#161b22;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden;width:max-content}
.bar{height:30px;background:#21262d;display:flex;align-items:center;gap:8px;padding:0 12px}
.dot{width:12px;height:12px;border-radius:50%}
pre{margin:0;padding:18px 22px 22px;color:#c9d1d9;font:14px/1.45 "SF Mono",Menlo,Consolas,monospace}
.cmd{color:#8b949e}
</style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span></div><pre><span class="cmd">$ node demo/overnight.js</span>
${ansi(demo.trimEnd())}

<span class="cmd">$ nightcap report</span>

${ansi(report.trimEnd())}</pre></div>`;
fs.writeFileSync(process.argv[2] || 'screenshot.html', html);
