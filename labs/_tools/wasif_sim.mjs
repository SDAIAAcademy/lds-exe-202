// Wasif, the stand-in publication-pack agent of LDS-EXE-202. NOT a language model: a scripted
// program with fixed random draws that behaves like an agent loop (plan, tool calls, retrieval,
// drafts, validation, retries) so that every participant gets the same runs.
// The effect of each lever comes from the parameters below: they are the course's synthetic
// assumptions, not measurements of any real model or provider.
// This file is the single source: prepare_files.mjs embeds it into tools/rerun.html, and the
// solutions import it. Plain JavaScript, no imports, so it runs in Node and in a browser.

export const LEVERS = ['routing', 'caching', 'short', 'retrycap', 'novalidate'];

export const WORKFLOWS = {
  publish: {
    instructions: 3400, retrieval: 14000, userMin: 140, userMax: 260,
    profileBase: 4000, profilePerCol: 480, colsMin: 8, colsMax: 60,
    toolError: 0.03, maxRetries: 6, retryCap: 3
  },
  notices: {
    instructions: 2600, retrieval: 5200, userMin: 260, userMax: 520,
    profileBase: 1500, profilePerCol: 120, colsMin: 4, colsMax: 20,
    toolError: 0.04, maxRetries: 5, retryCap: 2
  }
};

// mulberry32: a small seeded generator, the same numbers in Node and in a browser
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 124; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function makeTasks(n, seed, workflow = 'publish', prefix = 'T') {
  const w = WORKFLOWS[workflow];
  const r = rng(seed);
  const tasks = [];
  for (let i = 1; i <= n; i++) {
    const cols = w.colsMin + Math.floor(r() * (w.colsMax - w.colsMin + 1));
    const user = w.userMin + Math.floor(r() * (w.userMax - w.userMin + 1));
    const difficulty = Math.round(r() * 1000) / 1000;
    tasks.push({
      task_id: prefix + String(i).padStart(3, '0'),
      cols, user, difficulty,
      profile: w.profileBase + cols * w.profilePerCol
    });
  }
  return tasks;
}

const round = (x) => Math.round(x);

// One run of one task. levers: a Set or array of lever names. Returns the run with its calls.
export function simulateRun(task, attempt, seed, leverList, workflow = 'publish') {
  const levers = new Set(leverList || []);
  const w = WORKFLOWS[workflow];
  const r = rng(hash(seed, task.task_id, attempt));
  const u = Array.from({ length: 64 }, () => r()); // drawn once, in the same order for every lever
  const jit = (i) => 0.85 + 0.3 * u[24 + (i % 40)];
  const d = task.difficulty;
  const routing = levers.has('routing');
  const caching = levers.has('caching');
  const short = levers.has('short');
  const validate = !levers.has('novalidate');
  const maxRetries = levers.has('retrycap') ? w.retryCap : w.maxRetries;

  // the context: a list of segments sent with every call, in order
  const instr = { id: 'instr', cat: 'instructions', label: 'تعليمات النظام وتعريفات الأدوات', tokens: w.instructions };
  const userSeg = { id: 'user', cat: 'user', label: 'طلب النشر كما كتبه مالك البيانات', tokens: task.user };
  let history = [];
  const calls = [];
  let prevInput = { L: null, S: null };

  function call(step, model, out, reasoning, retry) {
    const input = [instr, userSeg, ...history];
    let cached = 0;
    if (caching) {
      const prev = prevInput[model];
      if (prev) {
        for (let i = 0; i < Math.min(prev.length, input.length); i++) {
          if (prev[i].id !== input[i].id) break;
          cached += input[i].tokens;
        }
      }
      prevInput[model] = input;
    }
    const idx = calls.length;
    const o = round(out * jit(idx));
    const re = model === 'L' ? round(reasoning * jit(idx + 7)) : 0;
    const inTokens = input.reduce((s, x) => s + x.tokens, 0);
    calls.push({ n: idx + 1, step, model, retry: !!retry, segments: input.map((x) => ({ ...x })), input: inTokens, cached, output: o, reasoning: re });
    return { id: 'out' + (idx + 1), cat: 'history', label: 'مخرَج الاستدعاء ' + (idx + 1) + ': ' + step, tokens: o };
  }

  const small = (m) => (routing ? 'S' : m);
  let status = 'accepted';
  let retries = 0;
  let failReason = '';

  history.push(call('خطة العمل', small('L'), 320, 800, false));
  history.push(call('طلب أداة فحص البيانات', small('L'), 110, 0, false));
  if (u[0] < w.toolError) {
    status = 'failed'; failReason = 'tool_error';
  } else {
    history.push({ id: 'profile', cat: 'tool', label: 'نتيجة أداة الفحص: ملف تعريف الأعمدة (' + task.cols + ' عمودًا)', tokens: task.profile });
    history.push(call('طلب أقسام معيار البيانات الوصفية', small('L'), 90, 0, false));
    history.push({ id: 'std', cat: 'retrieval', label: 'أقسام مسترجعة من معيار البيانات الوصفية ودليل المصطلحات', tokens: w.retrieval });
    history.push(call('مسودة الوصف العربي والبيانات الوصفية', 'L', 2300, 2400, false));
    if (short) {
      history = history.map((s) => {
        if (s.id === 'profile') return { id: 'profile-sum', cat: 'tool', label: 'ملخص ملف تعريف الأعمدة', tokens: 1200 };
        if (s.id === 'std') return { id: 'std-sum', cat: 'retrieval', label: 'ملخص أقسام المعيار', tokens: 1500 };
        return s;
      });
    }
    history.push(call('مسودة الوصف الإنجليزي', small('L'), routing ? 1800 : 1700, 1000, false));
    if (validate) {
      let pfail = 0.22 + 0.6 * d + (routing ? 0.05 : 0) + (short ? 0.02 : 0);
      // a stuck loop: the validator reports an error the drafts never fix, so every retry fails
      const stuck = u[22] < 0.05 + 0.08 * d;
      let k = 0;
      for (;;) {
        const retry = k > 0;
        history.push(call('طلب أداة التحقق من مخطط البوابة', small('L'), 140, 0, retry));
        const passed = u[1 + k] > (stuck && k > 0 ? 0.97 : pfail);
        const vId = short ? 'val' : 'val' + k;
        if (short) history = history.filter((s) => s.id !== 'val');
        history.push({ id: vId, cat: 'tool', label: 'نتيجة أداة التحقق' + (passed ? ': مقبول' : ': أخطاء في المخطط'), tokens: passed ? 180 : 520 });
        if (passed) break;
        if (k >= maxRetries) { status = 'failed'; failReason = 'retry_limit'; break; }
        k += 1; retries = k;
        history.push(call('مراجعة المسودة بعد أخطاء التحقق', 'L', 1900, 1800, true));
        pfail = stuck ? 0.97 : pfail * 0.7;
      }
    }
    if (status !== 'failed') history.push(call('تجميع حزمة النشر', small('L'), 850, 0, false));
  }

  let review = 0;
  if (status !== 'failed') {
    const rej = 0.06 + 0.22 * d + 0.03 * retries + (routing ? 0.02 : 0) + (short ? 0.02 : 0) + (validate ? 0 : 0.3);
    status = u[20] > rej ? 'accepted' : 'rejected';
    review = status === 'accepted' ? 3 + 3 * u[21] : 7 + 4 * u[21];
    if (!validate) review += 2;
    review = Math.round(review * 2) / 2;
  }

  const sum = (m, f) => calls.filter((c) => c.model === m).reduce((s, c) => s + c[f], 0);
  return {
    task_id: task.task_id, attempt, status, fail_reason: failReason, retries,
    model_calls: calls.length,
    in_L: sum('L', 'input') - sum('L', 'cached'), cached_L: sum('L', 'cached'), out_L: sum('L', 'output'), reason_L: sum('L', 'reasoning'),
    in_S: sum('S', 'input') - sum('S', 'cached'), cached_S: sum('S', 'cached'), out_S: sum('S', 'output'), reason_S: sum('S', 'reasoning'),
    review_min: review, calls
  };
}

// Every task once; a failed run is re-run once
export function runBatch(tasks, seed, levers, workflow = 'publish') {
  const runs = [];
  for (const t of tasks) {
    const first = simulateRun(t, 1, seed, levers, workflow);
    runs.push(first);
    if (first.status === 'failed') runs.push(simulateRun(t, 2, seed, levers, workflow));
  }
  return runs.map((x, i) => ({ run_id: 'R' + String(i + 1).padStart(3, '0'), ...x }));
}

export function tokenCost(run, prices) {
  const m = (k, p) => (run['in_' + k] * p.in + run['cached_' + k] * p.cached + (run['out_' + k] + run['reason_' + k]) * p.out) / 1e6;
  return m('L', prices.L) + m('S', prices.S);
}

// PERCENTILE.INC of LibreOffice Calc and Excel: linear interpolation on (n - 1) * p
export function percentileInc(values, p) {
  const v = [...values].sort((a, b) => a - b);
  const h = (v.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

export function summarise(runs, prices, rate) {
  const byTask = new Map();
  let total = 0, tokenTotal = 0, reviewMin = 0;
  for (const r of runs) {
    const tc = tokenCost(r, prices);
    const c = tc + r.review_min * rate;
    total += c; tokenTotal += tc; reviewMin += r.review_min;
    const t = byTask.get(r.task_id) || { cost: 0, token: 0, last: null };
    t.cost += c; t.token += tc; t.last = r.status;
    byTask.set(r.task_id, t);
  }
  const ok = [...byTask.values()].filter((t) => t.last === 'accepted');
  const costs = ok.map((t) => t.cost);
  return {
    runs: runs.length,
    tasks: byTask.size,
    accepted: ok.length,
    rejected: runs.filter((r) => r.status === 'rejected').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    success_rate: ok.length / byTask.size,
    total_cost: total,
    token_cost: tokenTotal,
    review_min: reviewMin,
    median: percentileInc(costs, 0.5),
    p90: percentileInc(costs, 0.9),
    loaded_mean: total / ok.length,
    mean_ok_only: costs.reduce((s, x) => s + x, 0) / ok.length,
    mean_per_run: total / runs.length,
    token_per_success: tokenTotal / ok.length
  };
}
