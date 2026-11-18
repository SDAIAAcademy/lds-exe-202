// Writes every synthetic file of LDS-EXE-202 into labs/files/, the runner page labs/tools/rerun.html
// and the trainer's reference numbers labs/solutions/key.json. Fixed seeds: the same bytes on
// every run. Run from the repository root: node labs/_tools/prepare_files.mjs
// With --check it writes nothing and exits 1 if any file on disk differs from what it would write.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './wasif_sim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labs = join(here, '..');
const CHECK = process.argv.includes('--check');

// ---- the case's fixed assumptions (the course's own, not market prices) ----
export const SEED = 38;            // the 50 labelled runs and every re-run
export const N_TASKS = 45;         // 45 publication requests give exactly 50 runs at baseline
export const PROFILE_SEED = 2026;  // the usage profile of lab 1.3 (1,000 requests in September)
export const PRICES_A = { L: { in: 15, cached: 1.5, out: 75 }, S: { in: 1.2, cached: 0.12, out: 6 } };
export const REVIEW_RATE = 3;      // SAR per steward minute, loaded
export const SHEET_B = { unit_hour: 50, unit_tpm: 550000, hours_month: 730, work_minutes: 10560, peak: 2 };
export const SHEET_C = { per_pack: 4.75, platform_month: 4000 };
export const RUNAWAY = { day: 19, extra_sar: 6631.2, runs: 16, max_run_sar: 412.8 }; // 19 October: a stuck loop with the retry limit switched off by a configuration change
export const VOLUMES = [1500, 6000, 24000];
export const PROFILE = { runs: 1.085, input: 312000, output: 14400, delivered: 0.995, accepted: 0.815, review_min: 5.3 };

// Parallel example for slides, checkpoints and the bank: the Communications Department's
// bilingual public-notice workflow, with its own seed and prices
export const PAR = { seed: 77, tasks: 36, prices: { L: { in: 10, cached: 1, out: 40 }, S: { in: 0.8, cached: 0.08, out: 3.2 } }, rate: 2.5 };

const out = new Map();
const BOM = '﻿';
function csv(rows) {
  const esc = (v) => {
    const s = typeof v === 'number' ? String(v) : String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return BOM + rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}
const put = (rel, text) => out.set(rel, text);
const r2 = (x) => Math.round(x * 100) / 100;

// ---- the 45 requests and the register ----
const tasks = S.makeTasks(N_TASKS, SEED);
const DATASETS = ['مواقف السيارات العامة', 'رخص المحلات التجارية', 'الحدائق والمتنزهات', 'إنارة الشوارع', 'حاويات النفايات', 'مسارات المشي', 'المرافق الرياضية', 'محطات الحافلات', 'أعمال الطرق المجدولة', 'المباني التراثية', 'نقاط الشحن الكهربائي', 'جودة الهواء اليومية', 'الفعاليات العامة', 'المكتبات العامة', 'زراعة الأشجار'];
const datasetOf = (t) => DATASETS[(parseInt(t.task_id.slice(1), 10) * 7) % DATASETS.length];

put('files/data_register.csv', csv([
  ['field', 'source', 'classification', 'enters_agent', 'note'],
  ['dataset_title', 'publication request', 'عام', 'yes', 'title of a dataset already approved for open publication'],
  ['dataset_columns_and_profile', 'approved dataset', 'عام', 'yes', 'the dataset itself is classified Public before the request is raised'],
  ['metadata_standard_sections', 'published metadata standard', 'عام', 'yes', 'the authority publishes its metadata standard'],
  ['owner_department', 'publication request', 'عام', 'yes', 'department name only'],
  ['requester_name_and_contact', 'request system', 'مقيد', 'no', 'stays in the request system; never sent to the agent'],
  ['internal_review_comments', 'steward workspace', 'مقيد', 'no', 'stewards write them after the run; never sent to the agent']
]));
// Guard: every field that enters the agent is Public
for (const line of out.get('files/data_register.csv').slice(1).trim().split('\n').slice(1)) {
  const c = line.split(',');
  if (c[3] === 'yes' && c[2] !== 'عام') throw new Error('a non-Public field enters the agent: ' + line);
}

// ---- lab 1.2: the 50 labelled runs ----
const base = S.runBatch(tasks, SEED, []);
if (base.length !== 50) throw new Error('expected 50 runs, got ' + base.length);
const RUNCOLS = ['run_id', 'task_id', 'dataset', 'attempt', 'status', 'fail_reason', 'retries', 'model_calls', 'in_L', 'cached_L', 'out_L', 'reason_L', 'in_S', 'cached_S', 'out_S', 'reason_S', 'review_min', 'data_class'];
const taskById = new Map(tasks.map((t) => [t.task_id, t]));
function runRows(runs) {
  return [RUNCOLS, ...runs.map((r) => RUNCOLS.map((k) => k === 'dataset' ? datasetOf(taskById.get(r.task_id)) : k === 'data_class' ? 'عام' : r[k]))];
}
put('files/runs_50.csv', csv(runRows(base)));

// ---- lab 1.1: the token log of one run (accepted after two retries) ----
const pick = base.find((r) => r.status === 'accepted' && r.retries === 2);
if (!pick) throw new Error('no accepted run with two retries');
const segRows = [['call_no', 'step', 'model', 'retry_call', 'segment_no', 'segment', 'tokens', 'billed_as', 'category']];
for (const c of pick.calls) {
  let k = 0;
  const model = c.model === 'L' ? 'large' : 'small';
  for (const s of c.segments) segRows.push([c.n, c.step, model, c.retry ? 'yes' : 'no', ++k, s.label, s.tokens, 'input', '']);
  if (c.reasoning > 0) segRows.push([c.n, c.step, model, c.retry ? 'yes' : 'no', ++k, 'وحدات الاستدلال (لا تظهر في الرد)', c.reasoning, 'output', '']);
  segRows.push([c.n, c.step, model, c.retry ? 'yes' : 'no', ++k, 'المخرَج المرئي لهذا الاستدعاء', c.output, 'output', '']);
}
put('files/token_log_' + pick.run_id + '.csv', csv(segRows));
// reference attribution
const attrib = { instructions: 0, user: 0, history: 0, retrieval: 0, tool: 0, reasoning: 0, output: 0 };
let retryTokens = 0;
for (const c of pick.calls) {
  for (const s of c.segments) attrib[s.cat] += s.tokens;
  attrib.reasoning += c.reasoning; attrib.output += c.output;
  if (c.retry) retryTokens += c.input + c.output + c.reasoning;
}
const billed = Object.values(attrib).reduce((a, b) => a + b, 0);

// ---- lab 1.3: price sheets, assumptions, usage profile ----
put('files/price_sheet_a_tokens.csv', csv([
  ['item', 'model', 'price_sar', 'per', 'note'],
  ['input', 'large', PRICES_A.L.in, '1,000,000 tokens', 'uncached input'],
  ['cached_input', 'large', PRICES_A.L.cached, '1,000,000 tokens', 'input read from the provider cache'],
  ['output', 'large', PRICES_A.L.out, '1,000,000 tokens', 'visible output and reasoning tokens'],
  ['input', 'small', PRICES_A.S.in, '1,000,000 tokens', 'uncached input'],
  ['cached_input', 'small', PRICES_A.S.cached, '1,000,000 tokens', 'input read from the provider cache'],
  ['output', 'small', PRICES_A.S.out, '1,000,000 tokens', 'visible output and reasoning tokens'],
  ['failed_runs', 'all', '', '', 'every token sent or generated is billed, whatever the result'],
  ['commitment', 'all', 0, 'month', 'pay as you go; no minimum']
]));
put('files/price_sheet_b_capacity.csv', csv([
  ['item', 'value', 'unit', 'note'],
  ['unit_price', SHEET_B.unit_hour, 'SAR per unit per hour', 'a dedicated deployment of the same large model'],
  ['unit_throughput', SHEET_B.unit_tpm, 'tokens per minute per unit', 'input and output tokens together'],
  ['billed_hours', SHEET_B.hours_month, 'hours per month', 'every hour of the month, used or not'],
  ['minimum_term', 1, 'month', 'units are bought for whole months'],
  ['tokens', 0, 'SAR', 'no charge per token inside the units bought']
]));
put('files/price_sheet_c_outcome.csv', csv([
  ['item', 'value', 'unit', 'note'],
  ['price_per_pack', SHEET_C.per_pack, 'SAR per delivered pack', 'the vendor runs its own copy of the workflow; a pack counts when it is delivered to the steward, accepted or not'],
  ['platform_fee', SHEET_C.platform_month, 'SAR per month', 'whatever the volume'],
  ['failed_runs', 0, 'SAR', 'runs that deliver no pack are not billed'],
  ['tokens', 0, 'SAR', 'included in the pack price']
]));
put('files/assumptions.csv', csv([
  ['item', 'value', 'unit', 'note'],
  ['steward_rate', REVIEW_RATE, 'SAR per minute', 'loaded cost of a data steward, the course assumption'],
  ['working_minutes', SHEET_B.work_minutes, 'minutes per month', '22 working days of 8 hours: the agent runs when requests arrive'],
  ['peak_factor', SHEET_B.peak, 'ratio', 'the busiest minute carries twice the average working-hours load'],
  ['volumes', VOLUMES.join(' / '), 'requests per month', 'today, next year, full rollout across all departments']
]));
put('files/usage_profile.csv', csv([
  ['measure', 'value', 'unit', 'note'],
  ['runs_per_request', PROFILE.runs, 'runs', 'a failed run is re-run once'],
  ['input_tokens_per_request', PROFILE.input, 'tokens', 'all runs of the request, large model, no cache'],
  ['output_tokens_per_request', PROFILE.output, 'tokens', 'visible output and reasoning, all runs'],
  ['delivered_packs_per_request', PROFILE.delivered, 'packs', 'accepted or rejected by the steward'],
  ['accepted_packs_per_request', PROFILE.accepted, 'packs', 'the success rate'],
  ['review_minutes_per_request', PROFILE.review_min, 'minutes', 'steward review of delivered packs'],
  ['source', 'September 2026', '', '1,000 requests of the Open Data Office, measured with the same definitions']
]));

// check the profile against a fresh 1,000-request run (rounded values stay close)
{
  const pt = S.makeTasks(1000, PROFILE_SEED);
  const pr = S.runBatch(pt, PROFILE_SEED, []);
  const tot = (f) => pr.reduce((s, r) => s + f(r), 0);
  const close = (a, b, tol) => Math.abs(a - b) / b <= tol;
  const checks = [
    [tot((r) => r.in_L) / 1000, PROFILE.input], [tot((r) => r.out_L + r.reason_L) / 1000, PROFILE.output],
    [pr.length / 1000, PROFILE.runs], [pr.filter((r) => r.status !== 'failed').length / 1000, PROFILE.delivered],
    [pr.filter((r) => r.status === 'accepted').length / 1000, PROFILE.accepted], [tot((r) => r.review_min) / 1000, PROFILE.review_min]
  ];
  for (const [a, b] of checks) if (!close(a, b, 0.01)) throw new Error('profile drifted: ' + a + ' vs ' + b);
}

// reference pricing
const a = (PROFILE.input * PRICES_A.L.in + PROFILE.output * PRICES_A.L.out) / 1e6;
const tokPerReq = PROFILE.input + PROFILE.output;
const unitMonth = SHEET_B.unit_hour * SHEET_B.hours_month;
const reqPerUnit = SHEET_B.work_minutes * SHEET_B.unit_tpm / (tokPerReq * SHEET_B.peak);
const costA = (v) => v * a;
const unitsB = (v) => Math.ceil(v / reqPerUnit);
const costB = (v) => unitsB(v) * unitMonth;
const costC = (v) => SHEET_C.platform_month + SHEET_C.per_pack * PROFILE.delivered * v;
const pricing = VOLUMES.map((v) => {
  const A = costA(v), B = costB(v), C = costC(v);
  const best = [['A', A], ['B', B], ['C', C]].sort((x, y) => x[1] - y[1])[0][0];
  const review = v * PROFILE.review_min * REVIEW_RATE;
  const acc = v * PROFILE.accepted;
  return { volume: v, A: r2(A), B: r2(B), C: r2(C), units_B: unitsB(v), best,
    utilisation_B: r2(100 * v * tokPerReq / (unitsB(v) * SHEET_B.unit_tpm * 60 * SHEET_B.hours_month)),
    per_accepted: { A: r2((A + review) / acc), B: r2((B + review) / acc), C: r2((C + review) / acc) } };
});
const marginal = SHEET_C.per_pack * PROFILE.delivered;
const breakeven = {
  A_C: r2(SHEET_C.platform_month / (a - marginal)),
  A_B_one_unit: r2(unitMonth / a),
  C_B_one_unit: r2((unitMonth - SHEET_C.platform_month) / marginal),
  A_B_three_units: r2(3 * unitMonth / a),
  C_B_three_units: r2((3 * unitMonth - SHEET_C.platform_month) / marginal),
  requests_per_unit: r2(reqPerUnit)
};
const order = pricing.map((p) => p.best).join('');
if (order !== 'ACB') throw new Error('pricing choices changed: ' + order);
for (const p of pricing) {
  const s = [p.A, p.B, p.C].sort((x, y) => x - y);
  if ((s[1] - s[0]) / s[0] < 0.05) throw new Error('margin under 5% at ' + p.volume);
}

// ---- lab 2.1: fallback logs of every re-run ----
const SETS = [[], ['routing'], ['caching'], ['short'], ['retrycap'], ['novalidate'],
  ['routing', 'caching'], ['routing', 'short'], ['routing', 'retrycap'], ['caching', 'short'], ['caching', 'retrycap'], ['short', 'retrycap']];
const levers = {};
for (const L of SETS) {
  const name = L.length ? L.join('+') : 'baseline';
  const runs = S.runBatch(tasks, SEED, L);
  put('files/reruns/' + name + '.csv', csv(runRows(runs)));
  const s = S.summarise(runs, PRICES_A, REVIEW_RATE);
  levers[name] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
}
// the baseline re-run is the 50 labelled runs
if (out.get('files/reruns/baseline.csv') !== out.get('files/runs_50.csv')) throw new Error('baseline re-run differs from runs_50');

// ---- capstone: synthetic spend data ----
let capstoneKey = null;
{
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const r = S.rng(505);
  const rows = [['month', 'workflow', 'pricing', 'requests', 'accepted', 'token_or_usage_sar', 'fixed_fees_sar', 'review_minutes']];
  const wasifReq = [620, 840, 1010, 1180, 1000, 1420];
  const noticeReq = [300, 320, 290, 410, 380, 450];
  months.forEach((m, i) => {
    const req = wasifReq[i];
    const acc = Math.round(req * (0.80 + 0.03 * r()));
    let spend = req * a * (0.95 + 0.1 * r());
    spend = r2(spend);
    rows.push([m, 'Wasif publication packs', 'A tokens', req, acc, spend, 0, Math.round(req * PROFILE.review_min)]);
    const nreq = noticeReq[i];
    const nacc = Math.round(nreq * (0.86 + 0.04 * r()));
    rows.push([m, 'Communications notices', 'A tokens', nreq, nacc, r2(nreq * 2.1 * (0.95 + 0.1 * r())), 0, Math.round(nreq * 4.1)]);
    rows.push([m, 'Staff policy assistant', 'seats', '', '', 0, 120 * 110, 0]);
  });
  // October, day by day, for Wasif: one runaway day
  const days = [];
  const dr = S.rng(1010);
  const workdays = [];
  for (let d = 1; d <= 31; d++) { const wd = new Date(Date.UTC(2026, 9, d)).getUTCDay(); if (wd !== 5 && wd !== 6) workdays.push(d); }
  const per = Math.floor(1420 / workdays.length);
  let left = 1420;
  const daily = [['date', 'requests', 'runs', 'token_sar', 'max_run_sar']];
  let sum = 0;
  workdays.forEach((d, i) => {
    const req = i === workdays.length - 1 ? left : per + (i % 3 === 0 ? 1 : 0);
    left -= req;
    const runaway = d === RUNAWAY.day;
    let tok = req * a * (0.95 + 0.1 * dr());
    let maxRun = 9 + 6 * dr();
    if (runaway) { tok += RUNAWAY.extra_sar; maxRun = RUNAWAY.max_run_sar; }
    tok = r2(tok);
    sum += tok;
    daily.push(['2026-10-' + String(d).padStart(2, '0'), req, Math.round(req * PROFILE.runs) + (runaway ? RUNAWAY.runs : 0), tok, r2(maxRun)]);
  });
  put('files/spend_october_daily.csv', csv(daily));
  rows.find((x) => x[0] === '2026-10' && x[1] === 'Wasif publication packs')[5] = r2(sum);
  put('files/spend_monthly.csv', csv(rows));
  capstoneKey = { months: rows.slice(1).filter((x) => x[1] === 'Wasif publication packs').map((x) => ({ month: x[0], requests: x[3], accepted: x[4], token_sar: x[5], review_min: x[7], unit_cost_sar: r2((x[5] + x[7] * REVIEW_RATE) / x[4]), token_per_accepted: r2(x[5] / x[4]) })), october_daily_sum: r2(sum), runaway_day: RUNAWAY };
  put('files/budget_2026.csv', csv([
    ['item', 'value_sar', 'note'],
    ['ai_budget_line_2026', 420000, 'the dedicated AI line in the authority budget, approved for the calendar year'],
    ['spent_jan_apr', 61200, 'pilots before Wasif went live'],
    ['evaluation_and_monitoring_2026', 36000, 'fixed: test sets, trace viewer licence, monthly checks'],
    ['integration_build_2026', 95000, 'one-off build of the request system connector, paid in May']
  ]));
}

// ---- parallel example (slides, checkpoints, bank): the notices workflow ----
const ptasks = S.makeTasks(PAR.tasks, PAR.seed, 'notices', 'N');
const pruns = S.runBatch(ptasks, PAR.seed, [], 'notices');
const ps = S.summarise(pruns, PAR.prices, PAR.rate);
const pone = pruns.find((r) => r.status === 'accepted' && r.retries === 1) || pruns.find((r) => r.status === 'accepted');
const pattr = { instructions: 0, user: 0, history: 0, retrieval: 0, tool: 0, reasoning: 0, output: 0 };
let pretry = 0;
for (const c of pone.calls) {
  for (const s of c.segments) pattr[s.cat] += s.tokens;
  pattr.reasoning += c.reasoning; pattr.output += c.output;
  if (c.retry) pretry += c.input + c.output + c.reasoning;
}
const plev = {};
for (const L of [[], ['caching'], ['retrycap'], ['novalidate']]) {
  const s = S.summarise(S.runBatch(ptasks, PAR.seed, L, 'notices'), PAR.prices, PAR.rate);
  plev[L.join('+') || 'baseline'] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
}

// ---- reference numbers ----
const s50 = S.summarise(base, PRICES_A, REVIEW_RATE);
const key = {
  lab_1_1: { run: pick.run_id, task: pick.task_id, calls: pick.calls.length, retries: pick.retries,
    attribution: attrib, billed, user_input: attrib.user, billed_over_user: r2(billed / taskById.get(pick.task_id).user),
    retry_tokens: retryTokens, retry_share_pct: r2(100 * retryTokens / billed),
    token_cost_sar: r2(S.tokenCost(pick, PRICES_A)),
    naive_cost_sar: r2((taskById.get(pick.task_id).user * PRICES_A.L.in + pick.calls[pick.calls.length - 1].output * PRICES_A.L.out) / 1e6),
    review_min: pick.review_min, run_cost_with_review: r2(S.tokenCost(pick, PRICES_A) + pick.review_min * REVIEW_RATE) },
  lab_1_2: Object.fromEntries(Object.entries(s50).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])),
  lab_1_3: { token_cost_per_request: r2(a), tokens_per_request: tokPerReq, unit_month: unitMonth, pricing, breakeven },
  lab_2_1: levers,
  capstone: capstoneKey,
  parallel: { attribution: pattr, billed: Object.values(pattr).reduce((x, y) => x + y, 0), retry_tokens: pretry, run: pone.run_id,
    user: pattr.user, calls: pone.calls.length, token_cost: r2(S.tokenCost(pone, PAR.prices)),
    summary: Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])), levers: plev }
};
put('solutions/key.json', JSON.stringify(key, null, 2) + '\n');

// ---- the runner page: the simulator embedded, with the 45 requests ----
{
  const tpl = readFileSync(join(here, 'rerun.tpl.html'), 'utf8');
  const sim = readFileSync(join(here, 'wasif_sim.mjs'), 'utf8').replace(/^export /gm, '');
  const data = JSON.stringify({ seed: SEED, tasks: tasks.map((t) => ({ ...t, dataset: datasetOf(t) })), prices: PRICES_A, rate: REVIEW_RATE });
  put('tools/rerun.html', tpl.replace('/*SIM*/', () => sim).replace('/*DATA*/', () => 'const CASE = ' + data + ';'));
}

// ---- write or compare ----
let diff = 0;
for (const [rel, text] of out) {
  const p = join(labs, rel);
  if (CHECK) {
    if (!existsSync(p) || readFileSync(p, 'utf8') !== text) { console.log('differs: ' + rel); diff++; }
  } else {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}
if (CHECK) { console.log(diff ? diff + ' file(s) differ' : 'all ' + out.size + ' files identical'); process.exit(diff ? 1 : 0); }
console.log('wrote ' + out.size + ' files');
