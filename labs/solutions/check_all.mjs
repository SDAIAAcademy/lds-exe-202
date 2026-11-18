// Trainer's check of every lab of LDS-EXE-202. From the repository root:
//   node labs/solutions/check_all.mjs
// 1. The generator writes the same bytes as the files on disk.
// 2. Each lab's reference answers are recomputed from the CSV files alone, the way a spreadsheet
//    does it (no use of the simulator), and compared with labs/solutions/key.json.
// 3. The runner page labs/tools/rerun.html runs in a sandbox and gives the same runs as the module.
// Prints PASS, or the first difference and exits 1.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import * as S from '../_tools/wasif_sim.mjs';

const labs = join(dirname(fileURLToPath(import.meta.url)), '..');
const key = JSON.parse(readFileSync(join(labs, 'solutions', 'key.json'), 'utf8'));
let fails = 0;
function eq(name, got, want, tol = 0.006) {
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : got === want;
  if (!ok) { console.log('DIFF ' + name + ': got ' + got + ', want ' + want); fails++; }
}

function parseCsv(path) {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, /^-?\d+(\.\d+)?$/.test(r[i]) ? Number(r[i]) : r[i]])));
}
const f = (name) => parseCsv(join(labs, 'files', name));

// 1. bytes
const gen = spawnSync(process.execPath, [join(labs, '_tools', 'prepare_files.mjs'), '--check'], { encoding: 'utf8' });
if (gen.status !== 0) { console.log(gen.stdout + gen.stderr); fails++; } else console.log('generator: ' + gen.stdout.trim());

// prices as a spreadsheet reads them
const sheetA = f('price_sheet_a_tokens.csv');
const price = (item, model) => sheetA.find((r) => r.item === item && r.model === model).price_sar;
const P = { L: { in: price('input', 'large'), cached: price('cached_input', 'large'), out: price('output', 'large') },
  S: { in: price('input', 'small'), cached: price('cached_input', 'small'), out: price('output', 'small') } };
const rate = f('assumptions.csv').find((r) => r.item === 'steward_rate').value;

// 2a. lab 1.1: label every segment by the reference rules, then add up
{
  const name = readdirSync(join(labs, 'files')).find((n) => n.startsWith('token_log_'));
  const log = f(name);
  const cat = (s) => s.startsWith('تعليمات') ? 'instructions' : s.startsWith('طلب النشر') ? 'user' : s.startsWith('مخرَج الاستدعاء') ? 'history'
    : s.startsWith('أقسام مسترجعة') || s.startsWith('ملخص أقسام') ? 'retrieval' : s.startsWith('نتيجة أداة') || s.startsWith('ملخص ملف') ? 'tool'
    : s.startsWith('وحدات الاستدلال') ? 'reasoning' : s.startsWith('المخرَج المرئي') ? 'output' : 'UNKNOWN';
  const sums = {};
  let billed = 0, retry = 0, cost = 0;
  for (const r of log) {
    const c = cat(r.segment);
    sums[c] = (sums[c] || 0) + r.tokens;
    billed += r.tokens;
    if (r.retry_call === 'yes') retry += r.tokens;
    const p = r.model === 'large' ? P.L : P.S;
    cost += r.tokens * (r.billed_as === 'output' ? p.out : p.in) / 1e6;
  }
  eq('1.1 unknown segments', sums.UNKNOWN || 0, 0);
  for (const k of Object.keys(key.lab_1_1.attribution)) eq('1.1 ' + k, sums[k] || 0, key.lab_1_1.attribution[k]);
  eq('1.1 billed', billed, key.lab_1_1.billed);
  eq('1.1 retry tokens', retry, key.lab_1_1.retry_tokens);
  eq('1.1 token cost', Math.round(cost * 100) / 100, key.lab_1_1.token_cost_sar);
  const userOnce = log.find((r) => cat(r.segment) === 'user').tokens;
  eq('1.1 billed over user', Math.round(100 * billed / userOnce) / 100, key.lab_1_1.billed_over_user);
}

// a spreadsheet's way: run cost, task cost, MEDIAN, PERCENTILE.INC, loaded mean
function measures(runs) {
  const cost = (r) => (r.in_L * P.L.in + r.cached_L * P.L.cached + (r.out_L + r.reason_L) * P.L.out
    + r.in_S * P.S.in + r.cached_S * P.S.cached + (r.out_S + r.reason_S) * P.S.out) / 1e6 + r.review_min * rate;
  const tok = (r) => cost(r) - r.review_min * rate;
  const tasks = new Map();
  for (const r of runs) {
    const t = tasks.get(r.task_id) || { c: 0, last: '' };
    t.c += cost(r); t.last = r.status; tasks.set(r.task_id, t);
  }
  const ok = [...tasks.values()].filter((t) => t.last === 'accepted').map((t) => t.c).sort((a, b) => a - b);
  const pct = (p) => { const h = (ok.length - 1) * p, lo = Math.floor(h); return ok[lo] + (h - lo) * ((ok[lo + 1] ?? ok[lo]) - ok[lo]); };
  const total = runs.reduce((s, r) => s + cost(r), 0);
  return { runs: runs.length, tasks: tasks.size, accepted: ok.length, success_rate: ok.length / tasks.size,
    median: pct(0.5), p90: pct(0.9), loaded_mean: total / ok.length, mean_ok_only: ok.reduce((s, x) => s + x, 0) / ok.length,
    mean_per_run: total / runs.length, token_per_success: runs.reduce((s, r) => s + tok(r), 0) / ok.length,
    review_min: runs.reduce((s, r) => s + r.review_min, 0), total_cost: total };
}

// 2b. lab 1.2
{
  const runs = f('runs_50.csv');
  eq('1.2 rows', runs.length, 50);
  eq('1.2 all Public', runs.every((r) => r.data_class === 'عام'), true);
  const m = measures(runs);
  for (const k of Object.keys(m)) eq('1.2 ' + k, Math.round(m[k] * 100) / 100, key.lab_1_2[k]);
}

// 2c. lab 1.3
{
  const prof = Object.fromEntries(f('usage_profile.csv').map((r) => [r.measure, r.value]));
  const B = Object.fromEntries(f('price_sheet_b_capacity.csv').map((r) => [r.item, r.value]));
  const C = Object.fromEntries(f('price_sheet_c_outcome.csv').map((r) => [r.item, r.value]));
  const as = Object.fromEntries(f('assumptions.csv').map((r) => [r.item, r.value]));
  const a = (prof.input_tokens_per_request * P.L.in + prof.output_tokens_per_request * P.L.out) / 1e6;
  const tok = prof.input_tokens_per_request + prof.output_tokens_per_request;
  const perUnit = as.working_minutes * B.unit_throughput / (tok * as.peak_factor);
  const unitMonth = B.unit_price * B.billed_hours;
  eq('1.3 a', Math.round(a * 100) / 100, key.lab_1_3.token_cost_per_request);
  eq('1.3 requests per unit', Math.round(perUnit * 100) / 100, key.lab_1_3.breakeven.requests_per_unit);
  for (const p of key.lab_1_3.pricing) {
    const v = p.volume;
    const A = v * a, Bc = Math.ceil(v / perUnit) * unitMonth, Cc = C.platform_fee + C.price_per_pack * prof.delivered_packs_per_request * v;
    eq('1.3 A@' + v, Math.round(A * 100) / 100, p.A);
    eq('1.3 B@' + v, Math.round(Bc * 100) / 100, p.B);
    eq('1.3 C@' + v, Math.round(Cc * 100) / 100, p.C);
    const best = [['A', A], ['B', Bc], ['C', Cc]].sort((x, y) => x[1] - y[1])[0][0];
    eq('1.3 best@' + v, best, p.best);
  }
  eq('1.3 break-even A/C', Math.round(100 * C.platform_fee / (a - C.price_per_pack * prof.delivered_packs_per_request)) / 100, key.lab_1_3.breakeven.A_C);
  eq('1.3 break-even A/B one unit', Math.round(100 * unitMonth / a) / 100, key.lab_1_3.breakeven.A_B_one_unit);
}

// 2d. lab 2.1: every fallback log, and the trap
for (const [name, want] of Object.entries(key.lab_2_1)) {
  const m = measures(f('reruns/' + name + '.csv'));
  for (const k of ['runs', 'accepted', 'success_rate', 'median', 'p90', 'loaded_mean', 'token_per_success', 'review_min']) eq('2.1 ' + name + ' ' + k, Math.round(m[k] * 100) / 100, want[k]);
}
eq('2.1 trap lowers success', key.lab_2_1.novalidate.success_rate < key.lab_2_1.baseline.success_rate - 0.2, true);
eq('2.1 caching keeps success', key.lab_2_1.caching.success_rate, key.lab_2_1.baseline.success_rate);

// 2e. numbers the solution pages state beyond key.json
{
  const runs = f('runs_50.csv');
  const m = measures(runs);
  const perReq = m.total_cost / m.tasks;
  eq('1.2 cost per request', Math.round(perReq * 100) / 100, 23.5);
  eq('1.2 monthly at 1,420', Math.round(1420 * perReq), 33370);
  eq('1.2 per success at 70%', Math.round(perReq / 0.7 * 100) / 100, 33.57);
  const cost = (r) => (r.in_L * P.L.in + r.cached_L * P.L.cached + (r.out_L + r.reason_L) * P.L.out + r.in_S * P.S.in + r.cached_S * P.S.cached + (r.out_S + r.reason_S) * P.S.out) / 1e6 + r.review_min * rate;
  const t = new Map();
  for (const r of runs) { const x = t.get(r.task_id) || { c: 0, last: '' }; x.c += cost(r); x.last = r.status; t.set(r.task_id, x); }
  const top = [...t.entries()].filter(([, x]) => x.last === 'accepted').sort((a, b) => b[1].c - a[1].c).slice(0, 5).map(([id, x]) => id + ':' + x.c.toFixed(2)).join(' ');
  eq('1.2 top five', top, 'T026:38.34 T011:32.12 T010:29.79 T045:29.37 T007:26.38');
  const rej = [...t.values()].filter((x) => x.last === 'rejected').map((x) => x.c);
  eq('1.2 rejected min', Math.round(Math.min(...rej) * 100) / 100, 26.6);
  eq('1.2 rejected max', Math.round(Math.max(...rej) * 100) / 100, 40.89);
  const unit = 0.8 * 50 * 730, a = 5.76, mc = 4.75 * 0.995;
  eq('1.3 stretch A/B', Math.round(unit / a), 5069);
  eq('1.3 stretch C/B', Math.round((unit - 4000) / mc), 5332);
  eq('1.3 stretch commitment', unit * 12, 350400);
  eq('1.3 C per accepted', Math.round(mc / 0.815 * 100) / 100, 5.8);
}

// 3. the runner page in a sandbox
{
  const html = readFileSync(join(labs, 'tools', 'rerun.html'), 'utf8');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const handlers = {};
  const el = (id) => ({ id, textContent: '', disabled: true, className: '', children: [],
    set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; },
    appendChild(c) { this.children.push(c); return c; }, click() {}, remove() {}, addEventListener(ev, fn) { handlers[id + ':' + ev] = fn; } });
  const els = {};
  let checked = [];
  const document = {
    getElementById: (id) => (els[id] = els[id] || el(id)),
    querySelector: (sel) => (els[sel] = els[sel] || el(sel)),
    querySelectorAll: () => checked.map((v) => ({ value: v })),
    createElement: (t) => el(t),
    body: el('body')
  };
  let blobText = null;
  class Blob { constructor(parts) { blobText = parts.join(''); } }
  const URL = { createObjectURL: () => 'blob:x' };
  const ctx = vm.createContext({ document, Math, String, Array, Map, Set, JSON, Number, Object, Blob, URL });
  vm.runInContext(script, ctx);
  const tasks = S.makeTasks(45, 38);
  for (const L of [[], ['routing'], ['caching', 'short'], ['retrycap'], ['novalidate'], ['routing', 'retrycap']]) {
    const a = JSON.stringify(vm.runInContext('runBatch(CASE.tasks, CASE.seed, ' + JSON.stringify(L) + ')', ctx).map((r) => ({ ...r, calls: r.calls.length })));
    const b = JSON.stringify(S.runBatch(tasks, 38, L).map((r) => ({ ...r, calls: r.calls.length })));
    eq('runner ' + (L.join('+') || 'baseline'), a === b, true);
    checked = L;
    handlers['run:click']();
    eq('runner rows ' + (L.join('+') || 'baseline'), els['#tbl tbody'].children.length, JSON.parse(b).length);
    handlers['dl:click']();
    const name = L.length ? L.join('+') : 'baseline';
    eq('runner csv bytes ' + name, blobText === readFileSync(join(labs, 'files', 'reruns', name + '.csv'), 'utf8'), true);
  }
}

if (fails) { console.log(fails + ' difference(s)'); process.exit(1); }
console.log('PASS: labs 1.1, 1.2, 1.3, 2.1, the runner page and the generator');
