// ── Benchmarks (formerly "Tests") ─────────────────────────────────────────────
// Rules: 01_System/10_Benchmark_Framework.md · Library: 03_Environment/Benchmark_Library.md
// (synced to test_types by 05_Scripts/sync_benchmarks.py) · Plan: 07_Documentation/
// Benchmarks_Plan_2026-10-11.md. Tables: test_types (library + custom), testing_results,
// benchmark_prefs (05_Scripts/sql/2026-10-11_benchmarks.sql).
//
// Layout:  §1 engine (pure — no DOM/Supabase; tested by 05_Scripts/test_benchmarks_engine.js)
//          §2 data (load, cache, writes, offline ops)   §3 screen   §4 detail
//          §5 log sheet   §6 custom benchmarks   §7 Trends section

// ═══════════════════════════════ §1 ENGINE ═══════════════════════════════════

const BM_GROUPS = [
  { key: 'lift',           label: 'Lift tests' },
  { key: 'bodyweight',     label: 'Bodyweight strength' },
  { key: 'engine_machine', label: 'Engine — machines' },
  { key: 'engine_aerobic', label: 'Engine — aerobic quality' },
  { key: 'engine_run',     label: 'Engine — run & hike' },
  { key: 'carry',          label: 'Carries & strongman' },
  { key: 'power',          label: 'Power' },
  { key: 'wod',            label: 'Benchmark WODs' },
  { key: 'longevity',      label: 'Longevity' },
  { key: 'custom',         label: 'Your custom benchmarks' },
];
const BM_LIFT_FORMATS = [
  { key: '1RM', label: '1RM', reps: 1 }, { key: '3RM', label: '3RM', reps: 3 },
  { key: '5RM', label: '5RM', reps: 5 }, { key: 'reps_at_load', label: 'Reps at a load', reps: null },
];
// Pain-log body regions → benchmark caution regions (Benchmark_Library.md "Regions").
const BM_PAIN_REGION = { 'Hip': 'hip', 'Knee': 'knee', 'Ankle': 'ankle', 'Low Back': 'low_back',
  'Upper Back': 'upper_back', 'Shoulder': 'shoulder', 'Elbow': 'elbow', 'Wrist': 'wrist', 'Neck': 'neck' };
const BM_REGION_LABEL = { hip: 'hip', knee: 'knee', ankle: 'ankle', low_back: 'low back', upper_back: 'upper back',
  shoulder: 'shoulder', elbow: 'elbow', wrist: 'wrist', neck: 'neck' };
// Lift-test picker: loadable equipment only; patterns that are never a max test.
const BM_LIFT_EQUIP = ['Barbell', 'Specialty Bar', 'Dumbbell', 'Machine', 'Cable', 'Kettlebell', 'Landmine'];
const BM_LIFT_SKIP_PATTERNS = ['Mobility-Stability', 'Shoulder Support', 'Neck', 'Conditioning', 'Carry', 'Trunk-Core'];

function bmEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function bmNum(v) { if (v === '' || v == null) return null; const n = Number(v); return isFinite(n) ? n : null; }
function bmRound(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f; }

// Normalise a test_types row (library or custom) into the shape the app uses.
function bmNormType(r) {
  const rc = String(r.real_change || '').trim();
  const pct = /%$/.test(rc);
  return {
    id: r.id, key: r.key, name: r.name, kind: r.kind || 'number', unit: r.unit,
    grp: r.owner_athlete_id ? 'custom' : (r.grp || r.category || 'custom'),
    better: r.kind === 'drift' ? 'band' : (r.higher_is_better === false ? 'lower' : 'higher'),
    realChange: rc ? { pct: pct, v: Number(pct ? rc.slice(0, -1) : rc) } : null,
    cadence: r.cadence_days != null ? Number(r.cadence_days) : null,
    standard: r.standard || null,
    regions: r.regions || [], flags: r.flags || [], equipment: r.equipment || [],
    status: r.status || 'set', shows: r.shows || '',
    params: Array.isArray(r.params) ? r.params : [], steps: Array.isArray(r.steps) ? r.steps : [],
    featured: Array.isArray(r.featured) ? r.featured : [],
    custom: !!r.owner_athlete_id, sort: Number(r.sort_order || 0),
  };
}
function bmParams(t, role) { return (t.params || []).filter(function (p) { return !role || p.role === role; }); }
function bmParamDefault(t, name, division) {
  const p = (t.params || []).filter(function (x) { return x.param === name; })[0];
  if (!p) return null;
  return division === 'women' ? p.women : p.men;
}
function bmHasFlag(t, f) { return (t.flags || []).indexOf(f) !== -1; }

// ── Trend lines (framework §3) ──
function bmNormParamVal(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (String(v).trim() !== '' && isFinite(n)) return String(bmRound(n, 2));
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}
// r: { exercise_id, lift_format, standard, side, params }. Only rx + locked params split lines.
function bmLineKey(t, r) {
  const parts = [t.key];
  if (t.kind === 'lift') {
    parts.push(r.exercise_id || '?', r.lift_format || '?');
    if (r.lift_format === 'reps_at_load') parts.push('load=' + bmNormParamVal(r.load));
  }
  if (t.standard === 'rx') parts.push(r.standard || 'rx_men');
  if (r.side) parts.push('side=' + r.side);
  const vals = r.params || {};
  (t.params || []).filter(function (p) { return p.role === 'rx' || p.role === 'locked'; })
    .map(function (p) { return p.param; }).sort()
    .forEach(function (k) { const v = bmNormParamVal(vals[k]); if (v !== '') parts.push(k + '=' + v); });
  return parts.join('|');
}
function bmLiftPrefKey(exId, fmt) { return 'lift:' + exId + ':' + fmt; }

// ── Values ──
function bmE1rm(load, reps) {
  load = bmNum(load); reps = bmNum(reps);
  if (!load || !reps || reps < 1 || reps > 12) return null;
  return reps === 1 ? load : Math.round(load * (1 + reps / 30));
}
// HR Drift (framework §5). mode 'output' = steady pace/watts, compare HR halves;
// mode 'hr' = steady HR, compare pace halves (pace in seconds per unit distance).
function bmDrift(mode, a1, a2) {
  a1 = bmNum(a1); a2 = bmNum(a2);
  if (!a1 || !a2 || a1 <= 0 || a2 <= 0) return null;
  return bmRound((a2 / a1 - 1) * 100, 1);     // HR2/HR1 − 1, or pace2/pace1 − 1 (= speed1/speed2 − 1)
}
function bmDriftVerdict(pct) {
  if (pct == null) return null;
  if (pct < 3.5) return { key: 'under', label: 'Under AeT', tip: 'AeT is probably higher. Retest a few beats higher.' };
  if (pct <= 5)  return { key: 'at',    label: 'At AeT',    tip: 'Your first-half average HR ≈ your aerobic threshold.' };
  return { key: 'over', label: 'Over AeT', tip: 'You started above AeT. Retest a few beats lower.' };
}
function bmRoundsToTotal(rounds, extra, perRound) {
  rounds = bmNum(rounds) || 0; extra = bmNum(extra) || 0; perRound = bmNum(perRound);
  if (!perRound) return null;
  return rounds * perRound + extra;
}
function bmTotalToRounds(total, perRound) {
  perRound = bmNum(perRound); total = bmNum(total);
  if (!perRound || total == null) return null;
  return { rounds: Math.floor(total / perRound), extra: total % perRound };
}

// ── Time: stored in seconds. Input "m:ss", "h:mm:ss", or a plain number = seconds. ──
function bmParseTime(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (!/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) return null;
  const p = s.split(':').map(Number);
  if (p.slice(1).some(function (x) { return x >= 60; })) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
function bmFmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = (s < 10 ? '0' : '') + s;
  return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + ss : m + ':' + ss;
}

// ── Units. units = 'imperial' | 'metric'. Returns { unit, toStored, fromStored, dp } ──
function bmDispUnit(t, units) {
  const imp = units !== 'metric';
  if (t.unit === 'cm') return imp ? { unit: 'in', f: 1 / 2.54, dp: 1 } : { unit: 'cm', f: 1, dp: 0 };
  if (t.unit === 'm') {
    if (t.grp === 'engine_run') return imp ? { unit: 'mi', f: 1 / 1609.344, dp: 2 } : { unit: 'm', f: 1, dp: 0 };
    return imp ? { unit: 'ft', f: 3.28084, dp: 0 } : { unit: 'm', f: 1, dp: 1 };
  }
  const lbl = { lb: 'lb', reps: 'reps', s: '', cal: 'cal', bpm: 'bpm', pct: '%' }[t.unit];
  return { unit: lbl == null ? (t.unit || '') : lbl, f: 1, dp: t.unit === 'pct' ? 1 : (t.unit === 'lb' ? 1 : 0) };
}
function bmToStored(t, disp, units) {
  if (t.unit === 's') return bmParseTime(disp);
  const n = bmNum(disp); if (n == null) return null;
  const u = bmDispUnit(t, units);
  return bmRound(n / u.f, 3);
}
function bmFromStored(t, stored, units) {
  if (stored == null) return null;
  const u = bmDispUnit(t, units);
  return bmRound(Number(stored) * u.f, u.dp);
}
// Human-readable value for a result row (or a bare stored value).
function bmFmtValue(t, v, units, r) {
  if (v == null) return '—';
  if (r && r.finished === false) return bmRound(Number(v), 1) + ' ' + (r.unit === 's' ? 's' : (r.unit || '')) + ' (not finished)';
  if (t.kind === 'lift') {
    if (r && r.lift_format === 'reps_at_load') return v + ' reps @ ' + (r.load != null ? r.load : '?') + ' lb';
    return bmRound(Number(v), 1) + ' lb' + (r && r.reps > 1 ? ' × ' + r.reps : '');
  }
  if (t.kind === 'rounds_reps') {
    const per = bmParamDefault(t, 'round_reps', 'men');
    const rr = bmTotalToRounds(v, per);
    return rr ? rr.rounds + ' rds + ' + rr.extra : v + ' reps';
  }
  if (t.unit === 's') return bmFmtTime(Number(v));
  if (t.kind === 'drift') return bmRound(Number(v), 1) + '% drift';
  const u = bmDispUnit(t, units);
  return bmFromStored(t, v, units) + (u.unit ? ' ' + u.unit : '');
}

// ── Real-change verdict (framework §4). Returns null when no verdict applies. ──
function bmVerdict(t, prev, cur, opts) {
  if (!t || !prev || !cur || t.custom || t.better === 'band') return null;
  if (prev.finished === false || cur.finished === false) return null;
  const a = Number(prev.value), b = Number(cur.value);
  if (!isFinite(a) || !isFinite(b)) return null;
  let thr;
  if (t.kind === 'lift' && cur.lift_format === 'reps_at_load') thr = 1;
  else if (!t.realChange) return null;
  else thr = t.realChange.pct ? Math.abs(a) * t.realChange.v / 100 : t.realChange.v;
  const diff = b - a;
  const gain = t.better === 'lower' ? -diff : diff;
  const key = gain >= thr - 1e-9 ? 'improved' : (gain <= -thr + 1e-9 ? 'worse' : 'same');
  return { key: key, label: { improved: 'Improved', same: 'No real change', worse: 'Worse' }[key],
    diff: diff, threshold: thr, provisional: t.status === 'provisional' && !(opts && opts.noProvisional) };
}
function bmFmtDiff(t, diff, units) {
  if (diff == null) return '';
  const sign = diff > 0 ? '+' : (diff < 0 ? '−' : '±');
  const a = Math.abs(diff);
  if (t.unit === 's') return sign + bmFmtTime(a);
  if (t.kind === 'lift') return sign + bmRound(a, 1) + ' lb';
  const u = bmDispUnit(t, units);
  return sign + bmRound(a * u.f, u.dp) + (u.unit ? ' ' + u.unit : '');
}

// ── Lines: group results into like-for-like trend lines ──
// results: testing_results rows (already filtered to this athlete). types: { id → normType }.
function bmLines(results, typesById) {
  const by = {};
  (results || []).forEach(function (r) {
    const t = typesById[r.test_type_id]; if (!t) return;
    const k = r.line_key || bmLineKey(t, r);
    (by[k] = by[k] || { key: k, type: t, results: [] }).results.push(r);
  });
  return Object.keys(by).map(function (k) {
    const L = by[k];
    L.results.sort(function (a, b) {
      return (a.test_date || '').localeCompare(b.test_date || '') || (a.created_at || '').localeCompare(b.created_at || '');
    });
    const done = L.results.filter(function (r) { return r.finished !== false; });
    L.latest = L.results[L.results.length - 1];
    L.first = done[0] || null;
    L.best = bmBest(L.type, done);
    L.lastDate = L.latest ? L.latest.test_date : null;
    const lastTwo = done.slice(-2);
    L.verdict = lastTwo.length === 2 && L.latest === lastTwo[1] ? bmVerdict(L.type, lastTwo[0], lastTwo[1]) : null;
    return L;
  });
}
function bmBest(t, rows) {
  let best = null;
  (rows || []).forEach(function (r) {
    if (r.finished === false || r.value == null) return;
    const v = Number(r.value);
    if (best == null) { best = r; return; }
    const bv = Number(best.value);
    if (t.better === 'lower' ? v < bv : v > bv) best = r;
  });
  return t.better === 'band' ? null : best;
}
// A short description of what makes a line distinct (shown when a test has several lines).
function bmLineLabel(t, r, exName, division) {
  const bits = [];
  if (t.kind === 'lift') bits.push((exName || 'Lift') + ' · ' + (r.lift_format === 'reps_at_load' ? 'reps @ ' + (r.load || '?') + ' lb' : r.lift_format));
  if (t.standard === 'rx') bits.push(r.standard === 'scaled' ? 'Scaled' : (r.standard === 'rx_women' ? "Rx (women's)" : "Rx (men's)"));
  if (r.side) bits.push(r.side === 'L' ? 'Left' : 'Right');
  const vals = r.params || {};
  (t.params || []).forEach(function (p) {
    if ((p.role === 'rx' || p.role === 'locked') && vals[p.param] != null && vals[p.param] !== '') {
      const isDefault = p.role === 'rx' && String(vals[p.param]) === String(r.standard === 'rx_women' ? p.women : p.men);
      if (!isDefault) bits.push(p.label + ' ' + vals[p.param] + (p.unit && p.unit !== 'text' ? ' ' + p.unit : ''));
    }
  });
  return bits.join(' · ');
}

// ── Date helpers (local, string dates) ──
function bmToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function bmDaysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
    Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}
function bmAddDays(ds, n) {
  const d = new Date(Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10)) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// ── Due (framework §7): pinned, has a result, cadence passed, not snoozed. ──
function bmDue(pinned, lastDate, cadenceDays, today, snoozeUntil) {
  if (!pinned || !lastDate || !cadenceDays) return { due: false, days: null };
  const since = bmDaysBetween(lastDate, today);
  if (snoozeUntil && snoozeUntil >= today) return { due: false, days: since, snoozed: true };
  return { due: since >= cadenceDays, days: since };
}

// ── Cautions (framework §6): warn, never block. ctx = { injuries, pref, settings, liftFormat } ──
function bmCautions(t, ctx) {
  ctx = ctx || {};
  const out = [];
  const regions = t.regions || [];
  (ctx.injuries || []).forEach(function (i) {
    const reg = BM_PAIN_REGION[i.body_region];
    if (!reg || regions.indexOf(reg) === -1) return;
    const s = Number(i.pain_score || 0);
    if (i.neuro_flag || s >= 6) out.push({ level: 'strong', text: 'Your ' + BM_REGION_LABEL[reg] + ' is flagged red (' + s + '/10' + (i.neuro_flag ? ', nerve symptoms' : '') + '). Talk to your coach before testing this.' });
    else if (s >= 3) out.push({ level: 'warn', text: 'Your ' + BM_REGION_LABEL[reg] + ' is at ' + s + '/10. This test loads it — consider waiting.' });
  });
  if (ctx.pref && ctx.pref.coach_caution && !ctx.pref.caution_override) out.push({ level: 'warn', coach: true, text: 'Coach: ' + ctx.pref.coach_caution });
  if (t.kind === 'lift' && ctx.liftFormat === '1RM' && ctx.settings && ctx.settings.masters)
    out.push({ level: 'info', text: 'A 3RM, 5RM or reps-at-a-load test gives the same information with less risk. Consider one of those instead of a 1RM.' });
  if (bmHasFlag(t, 'max_effort') || bmHasFlag(t, 'anaerobic'))
    out.push({ level: 'info', text: 'Test fresh — not in a hard or deload week.' + (bmHasFlag(t, 'anaerobic') ? ' Skip all-out sprints while you are still building your aerobic base.' : '') });
  return out;
}

// ── Lift picker filter ──
function bmLiftEligible(ex) {
  if (!ex || !ex.name) return false;
  if (BM_LIFT_EQUIP.indexOf(ex.equipment) === -1) return false;
  if (BM_LIFT_SKIP_PATTERNS.indexOf(ex.movement_pattern) !== -1) return false;
  if (ex.exercise_type === 'conditioning') return false;
  if (/\b(iso|isometric|hold|stretch)\b/i.test(ex.name)) return false;
  return true;
}

// ── Custom benchmark key ──
function bmCustomKey(rand) {
  const r = rand || Math.random;
  let s = 'c_';
  for (let i = 0; i < 8; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}
function bmUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Sparkline SVG for a line's values (oldest → newest). Lower-is-better lines are drawn inverted.
function bmSparkSvg(vals, better, w, h) {
  w = w || 120; h = h || 32;
  const v = (vals || []).filter(function (x) { return x != null && isFinite(x); });
  if (v.length < 2) return '';
  let lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pts = v.map(function (x, i) {
    const nx = 3 + i * (w - 6) / (v.length - 1);
    let ny = (x - lo) / (hi - lo);
    if (better === 'lower') ny = 1 - ny;
    return [bmRound(nx, 1), bmRound(h - 3 - ny * (h - 6), 1)];
  });
  return '<svg class="bm-spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">'
    + '<polyline fill="none" stroke="var(--accent2)" stroke-width="2" stroke-linejoin="round" points="'
    + pts.map(function (p) { return p.join(','); }).join(' ') + '"/>'
    + '<circle cx="' + pts[pts.length - 1][0] + '" cy="' + pts[pts.length - 1][1] + '" r="3" fill="var(--accent2)"/></svg>';
}

// ═══════════════════════════════ §2 DATA ═════════════════════════════════════

const BM = {
  loaded: false, loading: null, unavailable: false, lastLoad: 0,
  types: [], byId: {}, byKey: {}, results: [], prefs: {},
  training: {},                     // exercise_id → { best, loadedAt } ("best from training")
  ui: { open: {} },                 // library group open state
  detail: null,                     // { key, ex, fmt, line, showSteps }
  form: null,                       // log-sheet / custom / standard sheet state
};
function bmSettings() {
  const p = BM.prefs.settings;
  const s = (p && p.settings) || {};
  return { division: s.division || null, units: s.units || 'imperial', masters: !!s.masters };
}
function bmIndex() {
  BM.byId = {}; BM.byKey = {};
  BM.types.forEach(function (t) { BM.byId[t.id] = t; if (t.key) BM.byKey[t.key] = t; });
}
function bmActiveTypes() { return BM.types.filter(function (t) { return t.status !== 'retired'; }); }
function bmExName(id) {
  const ex = (S.exerciseLib || []).filter(function (e) { return e.id === id; })[0];
  return ex ? ex.name : 'Lift';
}
function bmExIdByName(name) {
  const ex = (S.exerciseLib || []).filter(function (e) { return e.name === name; })[0];
  return ex ? ex.id : null;
}

async function bmSaveCache() {
  try {
    await idbSet('benchmarksCache', { athleteId: S.athlete.id, types: BM.types, results: BM.results, prefs: BM.prefs });
  } catch (_) {}
}

async function loadBenchmarks(force) {
  if (!S || !S.athlete) return;
  if (BM.loading) return BM.loading;
  if (!force && BM.loaded && Date.now() - BM.lastLoad < 60000) return;
  BM.loading = (async function () {
    let fromNet = false;
    if (!isOffline) {
      try {
        const id = S.athlete.id;
        const res = await Promise.all([
          db.from('test_types').select('*').order('sort_order'),
          db.from('testing_results').select('*').eq('athlete_id', id).order('test_date'),
          db.from('benchmark_prefs').select('*').eq('athlete_id', id),
        ]);
        const err = res.map(function (r) { return r.error; }).filter(Boolean)[0];
        if (err) throw err;
        // Rows without a key are old seed rows that sync_benchmarks.py has not claimed yet.
        BM.types = (res[0].data || []).filter(function (r) { return r.key; }).map(bmNormType);
        BM.results = res[1].data || [];
        BM.prefs = {};
        (res[2].data || []).forEach(function (p) { BM.prefs[p.pref_key] = p; });
        BM.unavailable = false;
        fromNet = true;
        bmIndex();
        await bmSaveCache();
      } catch (e) {
        console.error('loadBenchmarks:', e);
        // 42P01 table missing / 42703 column missing: the migration hasn't been run yet.
        if (e && (e.code === '42P01' || e.code === '42703' || e.code === 'PGRST205' || e.code === 'PGRST204'
          || /does not exist|schema cache/i.test(e.message || ''))) BM.unavailable = true;
      }
    }
    if (!fromNet) {
      try {
        const c = await idbGet('benchmarksCache');
        if (c && c.athleteId === S.athlete.id) { BM.types = c.types || []; BM.results = c.results || []; BM.prefs = c.prefs || {}; }
      } catch (_) {}
    }
    bmIndex();
    BM.loaded = true;
    BM.lastLoad = Date.now();
  })();
  try { await BM.loading; } finally { BM.loading = null; }
}

// Replays one queued write (offline) or performs it directly (online).
// Called from syncQueue() in core.js. Throws on failure so the item stays queued.
async function bmSyncOp(op, p) {
  let r;
  if (op === 'bm_result_upsert') r = await db.from('testing_results').upsert(p.rows, { onConflict: 'id' });
  else if (op === 'bm_result_delete') r = await db.from('testing_results').delete().eq('id', p.id);
  else if (op === 'bm_pref_upsert') r = await db.from('benchmark_prefs').upsert(p, { onConflict: 'athlete_id,pref_key' });
  else if (op === 'bm_type_upsert') r = await db.from('test_types').upsert(p, { onConflict: 'key' });
  else if (op === 'bm_type_delete') r = await db.from('test_types').delete().eq('key', p.key).eq('owner_athlete_id', p.owner_athlete_id);
  else throw new Error('unknown benchmark op ' + op);
  if (r && r.error) throw r.error;
  return r;
}
async function bmWrite(op, payload) {
  if (!isOffline) {
    try { await bmSyncOp(op, payload); bmSaveCache(); return true; }
    catch (e) {
      console.error('benchmark write failed:', op, e);
      let online = false;
      try { online = await checkOnline(); } catch (_) {}
      if (online) { toast('Could not save — ' + (e.message || e.code || 'error'), 4000); return false; }
      isOffline = true;
      try { updateOfflineBanner(); } catch (_) {}
    }
  }
  try { await idbQueueWrite({ op: op, payload: payload }); bmSaveCache(); return true; }
  catch (e) { toast('Could not save offline'); return false; }
}
// Merge fields into a pref row locally, then write just those fields (upsert merges columns).
async function bmSetPref(prefKey, fields) {
  const stamp = new Date().toISOString();
  BM.prefs[prefKey] = Object.assign({}, BM.prefs[prefKey] || { athlete_id: S.athlete.id, pref_key: prefKey }, fields, { updated_at: stamp });
  return bmWrite('bm_pref_upsert', Object.assign({ athlete_id: S.athlete.id, pref_key: prefKey, updated_at: stamp }, fields));
}

// ── Derived ──
function bmAllLines() { return bmLines(BM.results, BM.byId); }
function bmLinesFor(key, exId, fmt) {
  return bmAllLines().filter(function (L) {
    if (L.type.key !== key) return false;
    if (exId && L.latest.exercise_id !== exId) return false;
    if (fmt && L.latest.lift_format !== fmt) return false;
    return true;
  }).sort(function (a, b) { return (b.lastDate || '').localeCompare(a.lastDate || ''); });
}
function bmPrefKeyFor(key, exId, fmt) { return key === 'lift_test' && exId ? bmLiftPrefKey(exId, fmt) : key; }
function bmIsPinned(prefKey) { const p = BM.prefs[prefKey]; return !!(p && p.pinned); }
// Pinned entries → [{ prefKey, type, exId, fmt, lines }], destination metrics first.
function bmPinnedEntries() {
  return Object.keys(BM.prefs).filter(function (k) { return BM.prefs[k].pinned; }).map(function (k) {
    if (k.indexOf('lift:') === 0) {
      const parts = k.split(':');
      return { prefKey: k, type: BM.byKey.lift_test, exId: parts[1], fmt: parts[2], lines: bmLinesFor('lift_test', parts[1], parts[2]) };
    }
    return { prefKey: k, type: BM.byKey[k], lines: bmLinesFor(k) };
  }).filter(function (e) { return e.type && e.type.status !== 'retired'; })
    .sort(function (a, b) {
      const pa = BM.prefs[a.prefKey].pinned_by === 'destination' ? 0 : 1, pb = BM.prefs[b.prefKey].pinned_by === 'destination' ? 0 : 1;
      return pa - pb || a.type.sort - b.type.sort;
    });
}
function bmEntryName(e) {
  return e.type.kind === 'lift' ? bmExName(e.exId) + ' · ' + (e.fmt === 'reps_at_load' ? 'Reps at a load' : e.fmt) : e.type.name;
}
function bmDetailArgs(key, exId, fmt) {
  return '\'' + key + '\'' + (exId ? ',\'' + exId + '\',\'' + fmt + '\'' : '');
}

// ═══════════════════════════════ §3 SCREEN ═══════════════════════════════════

async function openBenchmarks() {
  showScreen('benchmarks');
  const body = document.getElementById('bm-body');
  if (!BM.loaded) { body.innerHTML = '<div class="spinner">Loading…</div>'; await loadBenchmarks(true); }
  else if (!isOffline) loadBenchmarks(true).then(bmRefreshViews).catch(function () {});
  bmRenderScreen();
}
function closeBenchmarks() { BM.detail = null; if (typeof renderWeek === 'function') renderWeek(); else showScreen('week'); }

function bmVerdictPill(v) {
  if (!v) return '';
  return '<span class="bm-pill bm-pill-' + v.key + '">' + v.label + (v.provisional ? '*' : '') + '</span>';
}
function bmDateShort(ds) {
  if (!ds) return '';
  return new Date(Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10), 12))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: ds.slice(0, 4) === bmToday().slice(0, 4) ? undefined : 'numeric', timeZone: 'UTC' });
}

function bmPinCardHtml(e) {
  const t = e.type, pref = BM.prefs[e.prefKey] || {};
  const L = e.lines[0];
  const units = bmSettings().units;
  const badge = pref.pinned_by === 'destination' ? '<span class="bm-badge">Coach — destination</span>'
    : (pref.pinned_by === 'coach' ? '<span class="bm-badge">Coach</span>' : '');
  const due = L ? bmDue(true, L.lastDate, t.cadence, bmToday(), pref.snooze_until) : { due: false };
  const vals = L ? L.results.filter(function (r) { return r.finished !== false; }).map(function (r) { return Number(r.value); }) : [];
  let h = '<div class="card bm-pin" onclick="bmOpenDetail(' + bmDetailArgs(t.key, e.exId, e.fmt) + ')">'
    + '<div class="bm-pin-top"><div class="bm-pin-name">' + bmEsc(bmEntryName(e)) + '</div>' + badge + '</div>';
  if (!L) {
    h += '<div class="card-sub">No result yet — tap to see how the test works.</div>';
  } else {
    h += '<div class="bm-pin-row"><div><div class="bm-pin-val">' + bmEsc(bmFmtValue(t, L.latest.value, units, L.latest)) + '</div>'
      + '<div class="bm-pin-meta">' + bmDateShort(L.lastDate) + ' ' + bmVerdictPill(L.verdict)
      + (L.best && L.best !== L.latest ? ' · best ' + bmEsc(bmFmtValue(t, L.best.value, units, L.best)) : '') + '</div></div>'
      + bmSparkSvg(vals, t.better) + '</div>';
    if (e.lines.length > 1) h += '<div class="bm-pin-meta">+' + (e.lines.length - 1) + ' other setup' + (e.lines.length > 2 ? 's' : '') + '</div>';
  }
  if (due.due) h += '<div class="bm-due" onclick="event.stopPropagation()"><span>Due — last tested ' + due.days + ' days ago</span>'
    + '<button class="mv-mini" onclick="bmSnooze(\'' + e.prefKey + '\')">Later</button></div>';
  return h + '</div>';
}

function bmRenderScreen() {
  const body = document.getElementById('bm-body');
  if (!body) return;
  if (BM.unavailable) {
    body.innerHTML = '<div class="card"><div class="card-title">Almost ready</div><div class="card-sub">Benchmarks needs a one-time database update. Ask your coach to run the migration, then reopen this screen.</div></div>';
    return;
  }
  if (!BM.types.length) {
    body.innerHTML = '<div class="card"><div class="card-title">No benchmarks yet</div><div class="card-sub">' + (isOffline
      ? 'Connect once to download the benchmark library.' : 'The benchmark library hasn\'t been loaded yet. Ask your coach to run sync_benchmarks.py.') + '</div></div>';
    return;
  }
  const st = bmSettings();
  let h = '<button class="btn" onclick="bmOpenLog()">+ Log a result</button>';
  const pins = bmPinnedEntries();
  h += '<div class="bm-sec">My benchmarks</div>';
  h += pins.length ? pins.map(bmPinCardHtml).join('')
    : '<div class="card-sub" style="margin:0 0 8px">Pin ☆ the tests you want to track. They show up here with your latest result and a reminder when a retest is due.</div>';

  h += '<div class="bm-sec">Library</div>';
  const active = bmActiveTypes();
  BM_GROUPS.forEach(function (g) {
    const list = active.filter(function (t) { return t.grp === g.key; }).sort(function (a, b) { return a.sort - b.sort || a.name.localeCompare(b.name); });
    if (!list.length && g.key !== 'custom') return;
    const open = !!BM.ui.open[g.key];
    h += '<div class="bm-grp"><div class="bm-grp-hdr" onclick="bmToggleGroup(\'' + g.key + '\')"><span>' + g.label
      + ' <span class="mv-muted">' + list.length + '</span></span><span class="bm-caret' + (open ? ' open' : '') + '">›</span></div>';
    if (open) {
      h += list.map(function (t) {
        const lines = bmLinesFor(t.key);
        const latest = lines[0] && t.kind !== 'lift' ? bmFmtValue(t, lines[0].latest.value, st.units, lines[0].latest) : '';
        const pinnable = t.kind !== 'lift';
        const pinned = bmIsPinned(t.key);
        return '<div class="bm-row"><div class="bm-row-body" onclick="bmOpenDetail(\'' + t.key + '\')">'
          + '<div class="bm-row-name">' + bmEsc(t.name) + '</div>'
          + '<div class="bm-row-sub">' + bmEsc(t.kind === 'lift' ? 'Any lift: 1, 3 or 5RM, or reps at a load' : (t.shows || (t.custom ? 'Custom' : ''))) + '</div></div>'
          + (latest ? '<div class="bm-row-val">' + bmEsc(latest) + '</div>' : '')
          + (pinnable ? '<button class="bm-star' + (pinned ? ' on' : '') + '" onclick="bmTogglePin(\'' + t.key + '\')" aria-label="' + (pinned ? 'Unpin' : 'Pin') + '">' + (pinned ? '★' : '☆') + '</button>' : '<span class="bm-chev">›</span>')
          + '</div>';
      }).join('');
      if (g.key === 'custom') h += '<button class="btn secondary" style="margin:6px 0 4px" onclick="bmOpenCustom()">+ Create a custom benchmark</button>';
    }
    h += '</div>';
  });

  if (typeof openMvTests === 'function' && typeof MV !== 'undefined' && MV.loaded && typeof mvPlan === 'function' && mvPlan('mobility')) {
    h += '<div class="bm-link" onclick="openMvTests()">Mobility self-tests ›</div>';
  }
  h += '<div class="bm-sec">Settings</div><div class="card bm-settings">'
    + '<div class="bm-set-row"><span>WOD standard</span><div class="bm-seg">'
    + ['men', 'women'].map(function (d) { return '<button class="' + (st.division === d ? 'on' : '') + '" onclick="bmSetSetting(\'division\',\'' + d + '\')">' + (d === 'men' ? "Men's" : "Women's") + '</button>'; }).join('')
    + '</div></div><div class="bm-set-row"><span>Units</span><div class="bm-seg">'
    + [['imperial', 'mi · ft · in'], ['metric', 'm · cm']].map(function (u) { return '<button class="' + (st.units === u[0] ? 'on' : '') + '" onclick="bmSetSetting(\'units\',\'' + u[0] + '\')">' + u[1] + '</button>'; }).join('')
    + '</div></div></div>';
  body.innerHTML = h;
}
function bmToggleGroup(g) { BM.ui.open[g] = !BM.ui.open[g]; bmRenderScreen(); }
async function bmSetSetting(k, v) {
  const cur = Object.assign({}, (BM.prefs.settings && BM.prefs.settings.settings) || {});
  cur[k] = v;
  await bmSetPref('settings', { settings: cur });
  bmRenderScreen();
}
async function bmTogglePin(prefKey) {
  if (window.event) window.event.stopPropagation();
  const p = BM.prefs[prefKey] || {};
  const on = !p.pinned;
  await bmSetPref(prefKey, on ? { pinned: true, pinned_by: p.pinned_by || 'athlete' } : { pinned: false });
  toast(on ? 'Pinned to My benchmarks' : 'Unpinned');
  bmRefreshViews();
}
async function bmSnooze(prefKey) {
  if (window.event) window.event.stopPropagation();
  await bmSetPref(prefKey, { snooze_until: bmAddDays(bmToday(), 7) });
  toast('Reminder snoozed for 7 days');
  bmRefreshViews();
}
function bmScreenActive(id) { const el = document.getElementById('screen-' + id); return !!(el && el.classList.contains('active')); }
function bmRefreshViews() {
  if (bmScreenActive('benchmarks')) bmRenderScreen();
  if (BM.detail && bmScreenActive('benchmark')) bmRenderDetail();
}

// ═══════════════════════════════ §4 DETAIL ═══════════════════════════════════

function bmOpenDetail(key, exId, fmt) {
  BM.detail = { key: key, ex: exId || null, fmt: fmt || null, line: null, showSteps: false };
  showScreen('benchmark');
  bmRenderDetail();
  if (key === 'lift_test' && exId) bmLoadTraining(exId);
}
function bmCloseDetail() {
  const d = BM.detail;
  // From a lift line, go back to the lift hub; otherwise back to the list.
  if (d && d.key === 'lift_test' && d.ex) { bmOpenDetail('lift_test'); return; }
  BM.detail = null; showScreen('benchmarks'); bmRenderScreen();
}

function bmRenderDetail() {
  const d = BM.detail; if (!d) return;
  const t = BM.byKey[d.key];
  const body = document.getElementById('bm-detail-body');
  if (!t) { body.innerHTML = '<div class="card-sub">This benchmark is no longer in the library.</div>'; return; }
  const st = bmSettings();
  const isLiftHub = t.kind === 'lift' && !d.ex;
  document.getElementById('bm-detail-title').textContent = isLiftHub ? 'Lift tests' : (t.kind === 'lift' ? bmExName(d.ex) : t.name);
  document.getElementById('bm-detail-sub').textContent = t.kind === 'lift' && d.ex ? (d.fmt === 'reps_at_load' ? 'Reps at a load' : d.fmt)
    : (t.custom ? 'Custom benchmark' : ((BM_GROUPS.filter(function (g) { return g.key === t.grp; })[0] || {}).label || ''));
  if (isLiftHub) { body.innerHTML = bmLiftHubHtml(t); return; }

  const prefKey = bmPrefKeyFor(t.key, d.ex, d.fmt);
  const pref = BM.prefs[prefKey] || {};
  let h = '';
  const shows = t.kind === 'lift' ? 'Your best ' + (d.fmt === 'reps_at_load' ? 'reps at a set load' : d.fmt) + ' on this lift.' : t.shows;
  if (shows) h += '<div class="bm-shows">' + bmEsc(shows) + '</div>';
  bmCautions(t, { injuries: S.openInjuries || [], pref: pref, settings: st, liftFormat: d.fmt })
    .filter(function (c) { return c.level !== 'info'; })
    .forEach(function (c) { h += '<div class="bm-caution bm-caution-' + c.level + '">' + bmEsc(c.text) + '</div>'; });
  if (pref.coach_note) h += '<div class="mv-coach-note">' + bmEsc(pref.coach_note) + '</div>';

  const pinned = !!pref.pinned;
  h += '<div class="bm-actions"><button class="btn" onclick="bmOpenLog(' + bmDetailArgs(t.key, d.ex, d.fmt) + ')">Log a result</button>'
    + '<button class="btn secondary bm-pinbtn" onclick="bmTogglePin(\'' + prefKey + '\')">' + (pinned ? '★ Pinned' : '☆ Pin') + '</button></div>';
  if (pref.pinned_by === 'destination') h += '<div class="bm-pin-meta">Your coach tracks this as a destination metric.</div>';

  const lines = bmLinesFor(t.key, d.ex, d.fmt);
  if (lines.length) {
    if (!d.line || !lines.some(function (L) { return L.key === d.line; })) d.line = lines[0].key;
    const L = lines.filter(function (x) { return x.key === d.line; })[0];
    if (lines.length > 1) {
      h += '<div class="bm-sec">Setups</div><div class="triage-chips">' + lines.map(function (x) {
        return '<button class="triage-chip' + (x.key === d.line ? ' active' : '') + '" onclick="bmPickLine(\'' + encodeURIComponent(x.key) + '\')">'
          + bmEsc(bmLineLabel(t, x.latest, bmExName(x.latest.exercise_id)) || 'Standard') + '</button>';
      }).join('') + '</div><div class="bm-pin-meta">Results are only compared within one setup.</div>';
    } else {
      const lbl = bmLineLabel(t, L.latest, bmExName(L.latest.exercise_id));
      if (lbl && t.kind !== 'lift') h += '<div class="bm-pin-meta">Setup: ' + bmEsc(lbl) + '</div>';
    }
    h += bmLineStatsHtml(t, L, pref, st);
    h += bmResultsListHtml(t, L, st);
  } else {
    h += '<div class="card-sub" style="margin:12px 0">No results yet. Your first result becomes your baseline.</div>';
  }
  if (t.kind === 'lift' && d.ex) h += '<div id="bm-training">' + bmTrainingHtml(d.ex) + '</div>';
  if (t.standard === 'rx') h += bmStandardHtml(t, pref, st);
  h += bmStepsHtml(t);
  const meta = [];
  if (t.cadence) meta.push('Suggested retest: every ' + (t.cadence % 7 === 0 ? (t.cadence / 7) + ' weeks' : t.cadence + ' days'));
  if (t.equipment.length && t.equipment[0] !== 'none') meta.push('Equipment: ' + t.equipment.map(function (q) { return q.replace(/_/g, ' '); }).join(', '));
  if (t.status === 'provisional') meta.push('* "Real change" for this test is provisional until it\'s checked against real results.');
  if (meta.length) h += '<div class="bm-meta">' + meta.map(bmEsc).join('<br>') + '</div>';
  if (t.custom) h += '<button class="btn secondary" onclick="bmDeleteCustom(\'' + t.key + '\')">' + (BM.results.some(function (r) { return r.test_type_id === t.id; }) ? 'Archive this benchmark' : 'Delete this benchmark') + '</button>';
  body.innerHTML = h;
}
function bmPickLine(enc) { BM.detail.line = decodeURIComponent(enc); bmRenderDetail(); }

function bmLineStatsHtml(t, L, pref, st) {
  const pill = function (v, l) { return '<div class="trends-stat-pill"><div class="trends-stat-num">' + v + '</div><div class="trends-stat-lbl">' + l + '</div></div>'; };
  const done = L.results.filter(function (r) { return r.finished !== false; });
  let h = '<div class="trends-stat-strip" style="margin-top:10px">'
    + pill(bmEsc(bmFmtValue(t, L.latest.value, st.units, L.latest)), 'Latest · ' + bmDateShort(L.lastDate))
    + (t.better !== 'band' && L.best ? pill(bmEsc(bmFmtValue(t, L.best.value, st.units, L.best)), 'Best') : '')
    + (L.first && L.first !== L.latest ? pill(bmEsc(bmFmtValue(t, L.first.value, st.units, L.first)), 'Baseline') : '')
    + '</div>';
  if (t.kind === 'drift') {
    const v = bmDriftVerdict(Number(L.latest.value));
    const p = L.latest.params || {};
    if (v) h += '<div class="bm-caution bm-caution-' + (v.key === 'at' ? 'good' : 'info') + '"><b>' + v.label + '</b> at ' + bmEsc(p.hr1 || '?') + ' bpm. ' + bmEsc(v.tip) + '</div>';
  }
  if (done.length >= 2) {
    h += '<div class="trends-chart-box" style="text-align:center">' + bmSparkSvg(done.map(function (r) { return Number(r.value); }), t.better, 300, 80) + '</div>';
  }
  if (L.verdict) {
    const thr = t.kind === 'lift' && L.latest.lift_format === 'reps_at_load' ? '1 rep'
      : (t.realChange && t.realChange.pct ? t.realChange.v + '%' : bmFmtDiff(t, L.verdict.threshold, st.units).replace(/^[+−±]/, ''));
    h += '<div class="bm-pin-meta">Last change: ' + bmVerdictPill(L.verdict) + ' ' + bmEsc(bmFmtDiff(t, L.verdict.diff, st.units)) + ' (real change is ' + bmEsc(thr) + ')</div>';
  }
  const due = bmDue(!!pref.pinned, L.lastDate, t.cadence, bmToday(), pref.snooze_until);
  if (due.due) h += '<div class="bm-due"><span>Due — last tested ' + due.days + ' days ago</span><button class="mv-mini" onclick="bmSnooze(\'' + bmPrefKeyFor(t.key, BM.detail.ex, BM.detail.fmt) + '\')">Later</button></div>';
  return h;
}
function bmResultsListHtml(t, L, st) {
  const rows = L.results.slice().reverse();
  const done = L.results.filter(function (r) { return r.finished !== false; });
  return '<div class="bm-sec">History</div>' + rows.map(function (r) {
    const i = done.indexOf(r);
    const v = i > 0 ? bmVerdict(t, done[i - 1], r) : null;
    const extra = [];
    if (t.standard === 'rx') extra.push(r.standard === 'scaled' ? 'Scaled' + (r.scaling_note ? ': ' + r.scaling_note : '') : 'Rx');
    if (r.e1rm && t.kind === 'lift' && r.lift_format !== '1RM') extra.push('e1RM ' + r.e1rm);
    if (t.kind === 'drift' && r.params) extra.push('HR ' + (r.params.hr1 || '?') + ' → ' + (r.params.hr2 || '?'));
    if (r.rpe) extra.push('RPE ' + r.rpe);
    if (r.pain_flag) extra.push('⚠ hurt' + (r.pain_region ? ' (' + r.pain_region + ')' : ''));
    return '<div class="bm-res"><div class="bm-res-main"><div><b>' + bmEsc(bmFmtValue(t, r.value, st.units, r)) + '</b> ' + bmVerdictPill(v) + '</div>'
      + '<div class="bm-pin-meta">' + bmDateShort(r.test_date) + (extra.length ? ' · ' + bmEsc(extra.join(' · ')) : '') + '</div>'
      + (r.notes ? '<div class="bm-pin-meta">' + bmEsc(r.notes) + '</div>' : '') + '</div>'
      + '<button class="mv-x" onclick="bmDeleteResult(\'' + r.id + '\')" aria-label="Delete result">✕</button></div>';
  }).join('');
}
function bmStepsHtml(t) {
  if (!t.steps.length) return '';
  const open = BM.detail && BM.detail.showSteps;
  return '<div class="bm-grp"><div class="bm-grp-hdr" onclick="bmToggleSteps()"><span>How to do it</span><span class="bm-caret' + (open ? ' open' : '') + '">›</span></div>'
    + (open ? '<ol class="bm-steps">' + t.steps.map(function (s) { return '<li>' + bmEsc(s) + '</li>'; }).join('') + '</ol>' : '') + '</div>';
}
function bmToggleSteps() { if (BM.detail) { BM.detail.showSteps = !BM.detail.showSteps; bmRenderDetail(); } }
function bmStandardHtml(t, pref, st) {
  const rx = bmParams(t, 'rx'); if (!rx.length) return '';
  const div = st.division || 'men';
  const mine = pref.my_standard || {};
  return '<div class="bm-sec">Your standard <span class="mv-muted">(' + (div === 'women' ? "women's" : "men's") + ')</span></div><div class="card bm-std">'
    + rx.map(function (p) {
      const def = div === 'women' ? p.women : p.men;
      const v = mine[p.param] != null ? mine[p.param] : def;
      return '<div class="bm-set-row"><span>' + bmEsc(p.label) + '</span><span>' + bmEsc(v) + ' ' + bmEsc(p.unit) + (String(v) !== String(def) ? ' <span class="mv-muted">(standard ' + bmEsc(def) + ')</span>' : '') + '</span></div>';
    }).join('') + '<button class="btn secondary" onclick="bmOpenStandard(\'' + t.key + '\')">Change my standard</button></div>';
}

// "Best from training": best e1RM from logged sets in the last 12 weeks (framework §4).
async function bmLoadTraining(exId) {
  if (isOffline || !S.athlete) return;
  const cached = BM.training[exId];
  if (cached && Date.now() - cached.loadedAt < 300000) return;
  try {
    const since = bmAddDays(bmToday(), -84);
    const r = await db.from('completed_strength_sets')
      .select('actual_load,actual_reps,measure_type,cs:completed_session_id!inner(session_date,athlete_id,status)')
      .eq('exercise_id', exId).eq('is_skipped', false).gt('set_number', 0)
      .eq('cs.athlete_id', S.athlete.id).gte('cs.session_date', since);
    if (r.error) throw r.error;
    let best = null;
    (r.data || []).forEach(function (s) {
      if ((s.measure_type || 'reps') !== 'reps' || !s.cs || s.cs.status === 'skipped') return;
      const e = bmE1rm(s.actual_load, s.actual_reps);
      if (e && (!best || e > best.e1rm)) best = { e1rm: e, load: s.actual_load, reps: s.actual_reps, date: s.cs.session_date };
    });
    BM.training[exId] = { best: best, loadedAt: Date.now() };
  } catch (e) {
    console.error('bmLoadTraining:', e);
    BM.training[exId] = { best: null, failed: true, loadedAt: Date.now() };
  }
  const el = document.getElementById('bm-training');
  if (el && BM.detail && BM.detail.ex === exId) el.innerHTML = bmTrainingHtml(exId);
}
function bmTrainingHtml(exId) {
  const c = BM.training[exId];
  if (!c) return isOffline ? '' : '<div class="bm-train mv-muted">Checking your training sets…</div>';
  if (c.failed) return '';
  if (!c.best) return '<div class="bm-train mv-muted">No logged training sets for this lift in the last 12 weeks.</div>';
  return '<div class="bm-train"><div class="bm-train-lbl">Best from training (estimated)</div><div><b>' + c.best.e1rm + ' lb</b> e1RM · '
    + c.best.load + ' × ' + c.best.reps + ' on ' + bmDateShort(c.best.date) + '</div><div class="mv-muted">From your logged sets, last 12 weeks. A reference, not a test result.</div></div>';
}

function bmLiftHubHtml(t) {
  const st = bmSettings();
  const lines = bmLinesFor('lift_test');
  const seen = {}, groups = [];
  lines.forEach(function (L) {
    const k = L.latest.exercise_id + ':' + L.latest.lift_format;
    if (seen[k]) return; seen[k] = true; groups.push(L);
  });
  let h = '<div class="bm-shows">Test any loaded lift: a 1, 3 or 5-rep max, or max reps at a set load. Each lift and format is tracked separately.</div>';
  h += '<div class="bm-sec">Your lift tests</div>';
  h += groups.length ? groups.map(function (L) {
    const ex = L.latest.exercise_id, fmt = L.latest.lift_format;
    const pk = bmLiftPrefKey(ex, fmt);
    return '<div class="bm-row"><div class="bm-row-body" onclick="bmOpenDetail(\'lift_test\',\'' + ex + '\',\'' + fmt + '\')">'
      + '<div class="bm-row-name">' + bmEsc(bmExName(ex)) + '</div><div class="bm-row-sub">' + (fmt === 'reps_at_load' ? 'Reps at a load' : fmt) + ' · ' + bmDateShort(L.lastDate) + '</div></div>'
      + '<div class="bm-row-val">' + bmEsc(bmFmtValue(t, L.latest.value, st.units, L.latest)) + '</div>'
      + '<button class="bm-star' + (bmIsPinned(pk) ? ' on' : '') + '" onclick="bmTogglePin(\'' + pk + '\')">' + (bmIsPinned(pk) ? '★' : '☆') + '</button></div>';
  }).join('') : '<div class="card-sub" style="margin-bottom:8px">None yet.</div>';
  h += '<div class="bm-sec">Start a lift test</div><div class="triage-chips">' + (t.featured || []).map(function (n) {
    const id = bmExIdByName(n);
    return id ? '<button class="triage-chip" onclick="bmOpenLog(\'lift_test\',\'' + id + '\')">' + bmEsc(n) + '</button>' : '';
  }).join('') + '<button class="triage-chip" onclick="bmOpenLog(\'lift_test\')">Other lift…</button></div>';
  h += bmStepsHtml(t);
  return h;
}

function bmDeleteResult(id) {
  showConfirm('Delete this result?', 'It will be removed from your history and trends.', 'Delete', async function () {
    BM.results = BM.results.filter(function (r) { return r.id !== id; });
    await bmWrite('bm_result_delete', { id: id });
    bmRefreshViews();
  }, true);
}

// ═══════════════════════════════ §5 LOG SHEET ════════════════════════════════

function bmSheetShow() {
  document.getElementById('bm-overlay').classList.add('open');
  document.getElementById('bm-sheet').classList.add('open');
}
function bmSheetOpen(title, html) {
  document.getElementById('bm-sheet-title').textContent = title;
  document.getElementById('bm-sheet-body').innerHTML = html;
  bmSheetShow();
}
function closeBmSheet() {
  document.getElementById('bm-overlay').classList.remove('open');
  document.getElementById('bm-sheet').classList.remove('open');
  BM.form = null;
}

// Entry point. No key → choose a test first.
async function bmOpenLog(key, exId, fmt) {
  if (!BM.loaded) await loadBenchmarks();
  if (!key) { bmChooseTest(); return; }
  const t = BM.byKey[key]; if (!t) return;
  const st = bmSettings();
  const f = {
    key: key, date: bmToday(), notes: '', rpe: '', pain: false, painRegion: null, finished: true,
    exId: exId || null, fmt: fmt || (t.kind === 'lift' ? '3RM' : null), load: '', reps: '',
    value: '', valueL: '', valueR: '', rounds: '', extra: '',
    driftMode: 'output', hr1: '', hr2: '', pace1: '', pace2: '',
    scaled: false, scalingNote: '', params: {}, saveStd: false, startLoad: '',
  };
  // Pre-fill rx loads from My standard (or the published default), locked/info values from last time.
  const pref = BM.prefs[bmPrefKeyFor(key, f.exId, f.fmt)] || {};
  (t.params || []).forEach(function (p) {
    const def = bmParamDefault(t, p.param, st.division || 'men');
    if (p.role === 'rx') {
      const mine = (pref.my_standard || {})[p.param];
      f.params[p.param] = mine != null ? mine : def;
    } else {
      const last = (pref.locked || {})[p.param];
      f.params[p.param] = last != null ? last : (def != null ? def : '');
    }
  });
  f.startParams = Object.assign({}, f.params);
  BM.form = f;
  if (t.kind === 'lift' && f.exId) { bmSetFmt(f.fmt); } else bmRenderForm();
  bmSheetShow();
}

function bmChooseTest() {
  const pins = bmPinnedEntries();
  const act = bmActiveTypes();
  let h = '';
  if (pins.length) h += '<div class="bm-sec" style="margin-top:0">Pinned</div>' + pins.map(function (e) {
    return '<div class="bm-pick" onclick="bmOpenLog(' + bmDetailArgs(e.type.key, e.exId, e.fmt) + ')">' + bmEsc(bmEntryName(e)) + '</div>';
  }).join('');
  h += '<input class="bm-search" id="bm-search" placeholder="Search benchmarks…" oninput="bmFilterPick()">';
  h += '<div id="bm-pick-list">' + BM_GROUPS.map(function (g) {
    const list = act.filter(function (t) { return t.grp === g.key; }).sort(function (a, b) { return a.sort - b.sort; });
    if (!list.length) return '';
    return '<div class="bm-sec bm-pick-sec">' + g.label + '</div>' + list.map(function (t) {
      return '<div class="bm-pick" data-name="' + bmEsc(t.name.toLowerCase()) + '" onclick="bmOpenLog(\'' + t.key + '\')">' + bmEsc(t.name) + '</div>';
    }).join('');
  }).join('') + '</div>';
  bmSheetOpen('Log a result', h);
}
function bmFilterPick() {
  const q = (document.getElementById('bm-search').value || '').toLowerCase().trim();
  document.querySelectorAll('#bm-pick-list .bm-pick').forEach(function (el) {
    el.style.display = !q || el.getAttribute('data-name').indexOf(q) !== -1 ? '' : 'none';
  });
  document.querySelectorAll('#bm-pick-list .bm-pick-sec').forEach(function (el) { el.style.display = q ? 'none' : ''; });
}

function bmF(field, value) { if (BM.form) { BM.form[field] = value; bmLivePreview(); } }
function bmFP(param, value) { if (BM.form) { BM.form.params[param] = value; bmLivePreview(); } }
function bmFR(field, value) { if (BM.form) { BM.form[field] = value; bmRenderForm(); } }   // re-render (chips)

function bmInput(label, field, val, opts) {
  opts = opts || {};
  return '<div class="form-field' + (opts.wide ? ' wide' : '') + '"><label>' + bmEsc(label) + '</label><input '
    + 'inputmode="' + (opts.mode || 'decimal') + '" placeholder="' + bmEsc(opts.ph || '') + '" value="' + bmEsc(val == null ? '' : val) + '" '
    + 'oninput="' + (opts.param ? 'bmFP(\'' + field + '\',this.value)' : 'bmF(\'' + field + '\',this.value)') + '"></div>';
}

function bmRenderForm() {
  const f = BM.form; if (!f || !f.key) return;
  const t = BM.byKey[f.key]; const st = bmSettings();
  const pref = BM.prefs[bmPrefKeyFor(f.key, f.exId, f.fmt)] || {};
  let h = '';
  bmCautions(t, { injuries: S.openInjuries || [], pref: pref, settings: st, liftFormat: f.fmt })
    .forEach(function (c) { h += '<div class="bm-caution bm-caution-' + c.level + '">' + bmEsc(c.text) + '</div>'; });
  h += '<div class="form-grid"><div class="form-field"><label>Date</label><input type="date" value="' + f.date + '" max="' + bmToday() + '" onchange="bmF(\'date\',this.value)"></div>'
    + bmInput('RPE (optional)', 'rpe', f.rpe, { ph: '—' }) + '</div>';

  const ps = (t.params || []).filter(function (p) { return p.param !== 'round_reps'; });
  const paramsHtml = ps.length ? '<div class="form-grid">' + ps.map(function (p) {
    return bmInput(p.label + (p.unit && p.unit !== 'text' ? ' (' + p.unit + ')' : ''), p.param, f.params[p.param], { param: true, mode: p.unit === 'text' ? 'text' : 'decimal' });
  }).join('') + '</div><div class="bm-preview bm-warn" id="bm-linewarn" style="display:none"></div>' : '';
  if (t.standard !== 'rx' && paramsHtml) h += '<div class="bm-sub">Setup — keep the same each time</div>' + paramsHtml;

  if (t.kind === 'lift') {
    h += '<div class="form-field wide" style="margin-bottom:10px"><label>Lift</label><button class="test-ex-select-btn' + (f.exId ? ' selected' : '') + '" onclick="bmPickLift()">'
      + bmEsc(f.exId ? bmExName(f.exId) : 'Select a lift…') + '</button></div>';
    h += '<div class="bm-sub">Format</div><div class="triage-chips" style="margin-bottom:10px">' + BM_LIFT_FORMATS.map(function (x) {
      return '<button class="triage-chip' + (f.fmt === x.key ? ' active' : '') + '" onclick="bmSetFmt(\'' + x.key + '\')">' + x.label + '</button>';
    }).join('') + '</div>';
    if (f.fmt === 'reps_at_load') {
      h += '<div class="form-grid">' + bmInput('Load (lb)', 'load', f.load) + bmInput('Reps done', 'reps', f.reps, { mode: 'numeric' }) + '</div>';
      h += '<div class="bm-preview bm-warn" id="bm-linewarn" style="display:none"></div>';
    } else {
      h += '<div class="form-grid">' + bmInput(f.fmt + ' load (lb)', 'load', f.load) + '<div class="form-field"><label>e1RM</label><div class="test-e1rm-display" id="bm-e1rm">—</div></div></div>';
    }
  } else if (t.kind === 'drift') {
    h += '<div class="bm-sub">What did you hold steady?</div><div class="triage-chips" style="margin-bottom:10px">'
      + [['output', 'Pace or watts'], ['hr', 'Heart rate']].map(function (m) { return '<button class="triage-chip' + (f.driftMode === m[0] ? ' active' : '') + '" onclick="bmFR(\'driftMode\',\'' + m[0] + '\')">' + m[1] + '</button>'; }).join('') + '</div>';
    h += '<div class="form-grid">' + bmInput('Avg HR, min 0–30', 'hr1', f.hr1, { mode: 'numeric' }) + bmInput('Avg HR, min 30–60', 'hr2', f.hr2, { mode: 'numeric' }) + '</div>';
    if (f.driftMode === 'hr') h += '<div class="form-grid">' + bmInput('Pace, 1st half (m:ss)', 'pace1', f.pace1, { mode: 'text', ph: '11:30' }) + bmInput('Pace, 2nd half (m:ss)', 'pace2', f.pace2, { mode: 'text', ph: '11:50' }) + '</div>';
    h += '<div class="bm-preview" id="bm-drift">Enter both halves to see your drift.</div>';
  } else if (t.kind === 'rounds_reps') {
    h += '<div class="form-grid">' + bmInput('Full rounds', 'rounds', f.rounds, { mode: 'numeric' }) + bmInput('Extra reps', 'extra', f.extra, { mode: 'numeric' }) + '</div>';
  } else if (bmHasFlag(t, 'per_side')) {
    h += '<div class="form-grid">' + bmInput('Left' + bmUnitSuffix(t, st), 'valueL', f.valueL, bmValOpts(t, f)) + bmInput('Right' + bmUnitSuffix(t, st), 'valueR', f.valueR, bmValOpts(t, f)) + '</div>';
  } else {
    h += '<div class="form-grid">' + bmInput(bmValueLabel(t, st, f), 'value', f.value, Object.assign({ wide: true }, bmValOpts(t, f))) + '</div>';
  }
  if (t.unit === 's' && !bmHasFlag(t, 'per_side')) h += '<div class="bm-preview" id="bm-time"></div>';
  if (t.unit === 's' && t.kind === 'time' && t.better === 'lower') {
    h += '<label class="bm-check"><input type="checkbox"' + (f.finished ? '' : ' checked') + ' onchange="bmFR(\'finished\',!this.checked)"> Didn\'t finish (capped or stopped)</label>';
  }

  // Standard + params
  if (t.standard === 'rx') {
    const div = st.division || 'men';
    h += '<div class="bm-sub">Standard</div><div class="triage-chips" style="margin-bottom:8px">'
      + '<button class="triage-chip' + (!f.scaled ? ' active' : '') + '" onclick="bmFR(\'scaled\',false)">Rx (' + (div === 'women' ? "women's" : "men's") + ')</button>'
      + '<button class="triage-chip' + (f.scaled ? ' active' : '') + '" onclick="bmFR(\'scaled\',true)">Scaled</button></div>';
    if (!st.division) h += '<div class="bm-pin-meta">Men\'s or women\'s standard can be changed in Benchmarks → Settings.</div>';
    if (f.scaled) h += '<div class="form-grid">' + bmInput('What did you scale?', 'scalingNote', f.scalingNote, { wide: true, mode: 'text', ph: 'e.g. banded pull-ups' }) + '</div>';
  }
  if (t.standard === 'rx' && paramsHtml) h += paramsHtml;

  // It hurt
  const regions = (typeof PAIN_REGIONS !== 'undefined' ? PAIN_REGIONS : Object.keys(BM_PAIN_REGION)).filter(function (r) { return r !== 'Other'; });
  h += '<label class="bm-check"><input type="checkbox"' + (f.pain ? ' checked' : '') + ' onchange="bmFR(\'pain\',this.checked)"> It hurt</label>';
  if (f.pain) h += '<div class="triage-chips" style="margin-bottom:8px">' + regions.map(function (r) {
    return '<button class="triage-chip' + (f.painRegion === r ? ' active' : '') + '" onclick="bmFR(\'painRegion\',\'' + r + '\')">' + r + '</button>';
  }).join('') + '</div>';
  h += '<div class="form-field wide"><label>Notes (optional)</label><textarea oninput="bmF(\'notes\',this.value)" placeholder="Conditions, how it felt…">' + bmEsc(f.notes) + '</textarea></div>';
  h += '<button class="btn" style="margin-top:12px" onclick="bmSaveResult()">Save result</button>'
    + '<button class="btn secondary" onclick="closeBmSheet()">Cancel</button>';
  if (t.steps.length) h += '<details class="bm-howto"><summary>How to do it</summary><ol class="bm-steps">' + t.steps.map(function (s) { return '<li>' + bmEsc(s) + '</li>'; }).join('') + '</ol></details>';

  document.getElementById('bm-sheet-title').textContent = t.kind === 'lift' ? 'Log a lift test' : t.name;
  document.getElementById('bm-sheet-body').innerHTML = h;
  bmLivePreview();
}
function bmUnitSuffix(t, st) { const u = bmDispUnit(t, st.units).unit; return t.unit === 's' ? ' (m:ss)' : (u ? ' (' + u + ')' : ''); }
function bmValOpts(t, f) {
  if (t.unit === 's' && (!f || f.finished)) return { mode: 'text', ph: 'm:ss' };
  return { mode: t.unit === 'reps' || t.unit === 'cal' || t.unit === 'bpm' ? 'numeric' : 'decimal' };
}
function bmValueLabel(t, st, f) {
  if (f && !f.finished) return 'Reps or distance completed';
  if (t.kind === 'hr_fixed') return 'Average heart rate (bpm)';
  if (t.unit === 's') return 'Time (m:ss)';
  const u = bmDispUnit(t, st.units).unit;
  if (t.kind === 'reps') return 'Reps';
  if (t.kind === 'calories') return 'Calories';
  if (t.kind === 'distance') return 'Distance (' + u + ')';
  return 'Result' + (u ? ' (' + u + ')' : '');
}
function bmSetFmt(fmt) {
  const f = BM.form; f.fmt = fmt;
  f.startLoad = '';
  if (fmt === 'reps_at_load' && f.exId) {
    const lp = BM.prefs[bmLiftPrefKey(f.exId, 'reps_at_load')];
    if (lp && lp.locked && lp.locked.load != null) { f.startLoad = lp.locked.load; if (f.load === '') f.load = lp.locked.load; }
  }
  bmRenderForm();
}
function bmPickLift() {
  document.getElementById('bm-overlay').classList.remove('open');
  document.getElementById('bm-sheet').classList.remove('open');
  S.sheetMode = 'bm-lift';
  document.getElementById('ex-sheet-title').textContent = 'Choose a lift to test';
  openExSheet(null);
}
// Called by selectExercise() in exercises.js when sheetMode === 'bm-lift'.
function bmOnLiftPicked(exId) {
  if (!BM.form) return;
  BM.form.exId = exId;
  bmSetFmt(BM.form.fmt || '3RM');
  bmSheetShow();
}

// Live, non-destructive previews (no re-render while typing).
function bmLivePreview() {
  const f = BM.form; if (!f || !f.key) return;
  const t = BM.byKey[f.key];
  const set = function (id, html, show) { const el = document.getElementById(id); if (el) { el.innerHTML = html; if (show != null) el.style.display = show ? '' : 'none'; } };
  if (t.kind === 'lift' && f.fmt !== 'reps_at_load') {
    const fmt = BM_LIFT_FORMATS.filter(function (x) { return x.key === f.fmt; })[0];
    const e = bmE1rm(f.load, fmt ? fmt.reps : 1);
    set('bm-e1rm', e ? e + ' lb' : '—');
  }
  if (t.kind === 'drift') {
    const pct = f.driftMode === 'hr' ? bmDrift('hr', bmParseTime(f.pace1), bmParseTime(f.pace2)) : bmDrift('output', f.hr1, f.hr2);
    const v = bmDriftVerdict(pct);
    set('bm-drift', v ? '<b>' + pct + '% drift → ' + v.label + '.</b> ' + bmEsc(v.tip) : 'Enter both halves to see your drift.');
  }
  if (t.unit === 's') {
    const s = f.finished ? bmParseTime(f.value) : null;
    set('bm-time', f.finished && f.value ? (s == null ? 'Use m:ss, e.g. 4:35' : '= ' + bmFmtTime(s)) : '');
  }
  // Changing a locked/rx value (or the reps-at-load weight) starts a new trend line.
  const changed = [];
  (t.params || []).forEach(function (p) {
    if ((p.role === 'locked' || p.role === 'rx') && f.startParams[p.param] != null && f.startParams[p.param] !== ''
      && bmNormParamVal(f.params[p.param]) !== bmNormParamVal(f.startParams[p.param])) changed.push(p.label.toLowerCase());
  });
  if (t.kind === 'lift' && f.fmt === 'reps_at_load' && f.startLoad !== '' && f.startLoad != null && bmNormParamVal(f.load) !== bmNormParamVal(f.startLoad)) changed.push('the load');
  const rxChanged = t.standard === 'rx' && changed.length;
  set('bm-linewarn', changed.length ? 'Changing ' + bmEsc(changed.join(', ')) + ' starts a new trend line — results are only compared like for like.'
    + (rxChanged && !f.scaled ? '<label class="bm-check" style="margin-top:6px"><input type="checkbox"' + (f.saveStd ? ' checked' : '') + ' onchange="BM.form.saveStd=this.checked"> Make this my standard</label>' : '') : '', !!changed.length);
}

// Pure: build the result row(s) from the form. Returns { rows } or { error }.
function bmBuildRows(f, t, st, athleteId) {
  const base = {
    athlete_id: athleteId, test_type_id: t.id, test_date: f.date || bmToday(),
    rpe: bmNum(f.rpe), notes: (f.notes || '').trim() || null,
    pain_flag: !!f.pain, pain_region: f.pain ? (f.painRegion || null) : null,
    finished: f.finished !== false, source: 'app', params: {},
  };
  (t.params || []).forEach(function (p) {
    const v = (f.params || {})[p.param];
    if (v == null || v === '') return;
    base.params[p.param] = p.unit === 'text' ? String(v).trim() : (bmNum(v) != null ? bmNum(v) : String(v).trim());
  });
  if (t.standard === 'rx') {
    base.standard = f.scaled ? 'scaled' : ((st.division || 'men') === 'women' ? 'rx_women' : 'rx_men');
    base.scaling_note = f.scaled ? ((f.scalingNote || '').trim() || null) : null;
  }
  const rows = [];
  if (t.kind === 'lift') {
    if (!f.exId) return { error: 'Choose a lift first.' };
    const load = bmNum(f.load);
    if (!load || load <= 0) return { error: 'Enter the load.' };
    base.exercise_id = f.exId; base.lift_format = f.fmt; base.load = load;
    if (f.fmt === 'reps_at_load') {
      const reps = bmNum(f.reps);
      if (!reps || reps < 1) return { error: 'Enter the reps you did.' };
      Object.assign(base, { reps: reps, value: reps, unit: 'reps', e1rm: bmE1rm(load, reps) });
    } else {
      const reps = BM_LIFT_FORMATS.filter(function (x) { return x.key === f.fmt; })[0].reps;
      Object.assign(base, { reps: reps, value: load, unit: 'lb', e1rm: bmE1rm(load, reps) });
    }
    rows.push(base);
  } else if (t.kind === 'drift') {
    const hr1 = bmNum(f.hr1), hr2 = bmNum(f.hr2);
    if (!hr1 || !hr2) return { error: 'Enter average HR for both halves.' };
    let pct;
    if (f.driftMode === 'hr') {
      const p1 = bmParseTime(f.pace1), p2 = bmParseTime(f.pace2);
      if (!p1 || !p2) return { error: 'Enter your pace for both halves (m:ss).' };
      pct = bmDrift('hr', p1, p2);
      base.params.pace1_s = p1; base.params.pace2_s = p2;
    } else pct = bmDrift('output', hr1, hr2);
    Object.assign(base.params, { hr1: hr1, hr2: hr2, drift_mode: f.driftMode, verdict: bmDriftVerdict(pct).key });
    Object.assign(base, { value: pct, unit: 'pct' });
    rows.push(base);
  } else if (t.kind === 'rounds_reps') {
    const per = bmParamDefault(t, 'round_reps', 'men');
    if ((f.rounds === '' || f.rounds == null) && (f.extra === '' || f.extra == null)) return { error: 'Enter your rounds and extra reps.' };
    const total = bmRoundsToTotal(f.rounds, f.extra, per);
    if (total == null) return { error: 'This benchmark is missing its reps per round.' };
    Object.assign(base, { value: total, unit: 'reps' });
    rows.push(base);
  } else if (bmHasFlag(t, 'per_side')) {
    ['L', 'R'].forEach(function (side) {
      const raw = side === 'L' ? f.valueL : f.valueR;
      if (raw === '' || raw == null) return;
      const v = bmToStored(t, raw, st.units);
      if (v != null) rows.push(Object.assign({}, base, { params: Object.assign({}, base.params), side: side, value: v, unit: t.unit }));
    });
    if (!rows.length) return { error: 'Enter at least one side.' };
  } else {
    if (f.finished === false) {
      const n = bmNum(f.value);
      if (n == null) return { error: 'Enter how many reps (or meters) you completed.' };
      Object.assign(base, { value: n, unit: 'reps' });
    } else {
      const v = bmToStored(t, f.value, st.units);
      if (v == null) return { error: t.unit === 's' ? 'Enter a time like 4:35.' : 'Enter your result.' };
      Object.assign(base, { value: v, unit: t.unit || 'number' });
    }
    rows.push(base);
  }
  rows.forEach(function (r) { r.id = bmUuid(); r.line_key = bmLineKey(t, r); });
  return { rows: rows };
}

async function bmSaveResult() {
  const f = BM.form; if (!f) return;
  const t = BM.byKey[f.key]; const st = bmSettings();
  const built = bmBuildRows(f, t, st, S.athlete.id);
  if (built.error) { toast(built.error, 3000); return; }
  const rows = built.rows;
  // Verdict vs the previous finished result in the same line (for the toast).
  const L = bmAllLines().filter(function (x) { return x.key === rows[0].line_key; })[0];
  const prevDone = L ? L.results.filter(function (r) { return r.finished !== false && r.test_date <= rows[0].test_date; }) : [];
  const v = prevDone.length ? bmVerdict(t, prevDone[prevDone.length - 1], rows[0]) : null;

  const ok = await bmWrite('bm_result_upsert', { rows: rows });
  if (!ok) return;
  const now = new Date().toISOString();
  BM.results = BM.results.concat(rows.map(function (r) { return Object.assign({ created_at: now }, r); }));
  // Remember locked/info values, the reps-at-load weight, and (if asked) a new My standard.
  const prefKey = bmPrefKeyFor(f.key, f.exId, f.fmt);
  const locked = Object.assign({}, (BM.prefs[prefKey] || {}).locked || {});
  (t.params || []).forEach(function (p) { if (p.role !== 'rx' && rows[0].params[p.param] != null) locked[p.param] = rows[0].params[p.param]; });
  if (t.kind === 'lift' && f.fmt === 'reps_at_load') locked.load = rows[0].load;
  const fields = {};
  if (Object.keys(locked).length) fields.locked = locked;
  if (f.saveStd && t.standard === 'rx' && !f.scaled) {
    const mine = Object.assign({}, (BM.prefs[prefKey] || {}).my_standard || {});
    bmParams(t, 'rx').forEach(function (p) { if (rows[0].params[p.param] != null) mine[p.param] = rows[0].params[p.param]; });
    fields.my_standard = mine;
  }
  if (Object.keys(fields).length) await bmSetPref(prefKey, fields);
  const pain = f.pain;
  closeBmSheet();
  const valTxt = bmFmtValue(t, rows[0].value, st.units, rows[0]);
  toast(v ? 'Saved — ' + v.label.toLowerCase() + ' (' + bmFmtDiff(t, v.diff, st.units) + ')'
    : (prevDone.length || rows[0].finished === false ? 'Saved ' + valTxt : 'Saved — baseline set: ' + valTxt), 3500);
  // Land on the detail for what was just logged.
  if (bmScreenActive('benchmarks') || bmScreenActive('benchmark')) {
    bmOpenDetail(f.key, t.kind === 'lift' ? f.exId : null, t.kind === 'lift' ? f.fmt : null);
    BM.detail.line = rows[0].line_key; bmRenderDetail();
  }
  if (pain && typeof openPainSheet === 'function') {
    showConfirm('It hurt', 'Log it in 🚩 Pain so your coach sees it and the app can adjust?', 'Open Pain', function () { openPainSheet(); });
  }
}

// My standard (WOD Rx loads)
function bmOpenStandard(key) {
  const t = BM.byKey[key]; const st = bmSettings(); const div = st.division || 'men';
  const mine = (BM.prefs[key] || {}).my_standard || {};
  BM.form = { stdKey: key, std: {} };
  const rx = bmParams(t, 'rx');
  rx.forEach(function (p) { BM.form.std[p.param] = mine[p.param] != null ? mine[p.param] : (div === 'women' ? p.women : p.men); });
  bmSheetOpen('My standard — ' + t.name, '<div class="bm-pin-meta" style="margin-bottom:10px">Your Rx loads for ' + bmEsc(t.name)
    + '. Results at different loads are tracked as separate lines.</div><div class="form-grid">' + rx.map(function (p) {
      return '<div class="form-field"><label>' + bmEsc(p.label) + ' (' + bmEsc(p.unit) + ')</label><input inputmode="decimal" value="' + bmEsc(BM.form.std[p.param]) + '" oninput="BM.form.std[\'' + p.param + '\']=this.value"></div>';
    }).join('') + '</div><button class="btn" onclick="bmSaveStandard(false)">Save</button><button class="btn secondary" onclick="bmSaveStandard(true)">Reset to the published standard</button>');
}
async function bmSaveStandard(reset) {
  const f = BM.form; const t = BM.byKey[f.stdKey];
  const std = {};
  if (!reset) bmParams(t, 'rx').forEach(function (p) { const n = bmNum(f.std[p.param]); if (n != null) std[p.param] = n; });
  await bmSetPref(f.stdKey, { my_standard: std });
  closeBmSheet();
  toast(reset ? 'Back to the published standard' : 'Standard saved');
  bmRefreshViews();
}

// ═══════════════════════════════ §6 CUSTOM BENCHMARKS ════════════════════════

const BM_CUSTOM_KINDS = [
  { key: 'reps', label: 'Reps', unit: 'reps', better: 'higher' },
  { key: 'time', label: 'Time', unit: 's', better: null },
  { key: 'distance', label: 'Distance', unit: 'm', better: 'higher' },
  { key: 'calories', label: 'Calories', unit: 'cal', better: 'higher' },
  { key: 'rounds_reps', label: 'Rounds + reps', unit: 'reps', better: 'higher' },
  { key: 'number', label: 'Other number', unit: null, better: null },
];
function bmOpenCustom() {
  BM.form = { custom: true, name: '', kind: 'reps', unit: '', better: 'higher', perRound: '', lockLabel: '', lockUnit: '' };
  bmRenderCustom();
}
function bmCustomKind(k) {
  const x = BM_CUSTOM_KINDS.filter(function (c) { return c.key === k; })[0];
  BM.form.kind = k; if (x && x.better) BM.form.better = x.better;
  if (k === 'time' && BM.form.better === 'higher') BM.form.better = 'lower';
  bmRenderCustom();
}
function bmRenderCustom() {
  const f = BM.form;
  let h = '<div class="form-field wide" style="margin-bottom:10px"><label>Name</label><input maxlength="60" value="' + bmEsc(f.name) + '" oninput="BM.form.name=this.value" placeholder="e.g. Max plank hold"></div>'
    + '<div class="bm-sub">What do you record?</div><div class="triage-chips" style="margin-bottom:10px">' + BM_CUSTOM_KINDS.map(function (k) {
      return '<button class="triage-chip' + (f.kind === k.key ? ' active' : '') + '" onclick="bmCustomKind(\'' + k.key + '\')">' + k.label + '</button>';
    }).join('') + '</div>';
  if (f.kind === 'number') h += '<div class="form-grid"><div class="form-field wide"><label>Unit</label><input maxlength="12" value="' + bmEsc(f.unit) + '" oninput="BM.form.unit=this.value" placeholder="e.g. lb, watts, in"></div></div>';
  if (f.kind === 'rounds_reps') h += '<div class="form-grid"><div class="form-field wide"><label>Reps in one full round</label><input inputmode="numeric" value="' + bmEsc(f.perRound) + '" oninput="BM.form.perRound=this.value"></div></div>';
  if (f.kind === 'time' || f.kind === 'number') {
    h += '<div class="bm-sub">Which is better?</div><div class="triage-chips" style="margin-bottom:10px">'
      + [['lower', f.kind === 'time' ? 'Faster (lower)' : 'Lower'], ['higher', f.kind === 'time' ? 'Longer (e.g. a hold)' : 'Higher']].map(function (b) {
        return '<button class="triage-chip' + (f.better === b[0] ? ' active' : '') + '" onclick="BM.form.better=\'' + b[0] + '\';bmRenderCustom()">' + b[1] + '</button>';
      }).join('') + '</div>';
  }
  h += '<div class="bm-sub">Something to keep the same each time? (optional)</div><div class="form-grid">'
    + '<div class="form-field"><label>What</label><input maxlength="30" value="' + bmEsc(f.lockLabel) + '" oninput="BM.form.lockLabel=this.value" placeholder="e.g. Weight"></div>'
    + '<div class="form-field"><label>Unit</label><input maxlength="10" value="' + bmEsc(f.lockUnit) + '" oninput="BM.form.lockUnit=this.value" placeholder="e.g. lb"></div></div>'
    + '<div class="bm-pin-meta">Custom benchmarks are private to you. They show your results and trend, but no "real change" verdict.</div>'
    + '<button class="btn" style="margin-top:12px" onclick="bmSaveCustom()">Create</button><button class="btn secondary" onclick="closeBmSheet()">Cancel</button>';
  bmSheetOpen('New custom benchmark', h);
}
// Pure: the test_types row for a custom benchmark form. Returns { row } or { error }.
function bmCustomRow(f, athleteId, existingNames, key, id) {
  const name = (f.name || '').trim();
  if (!name) return { error: 'Give it a name.' };
  if ((existingNames || []).some(function (n) { return n.toLowerCase() === name.toLowerCase(); })) return { error: 'You already have a benchmark with that name.' };
  const k = BM_CUSTOM_KINDS.filter(function (x) { return x.key === f.kind; })[0];
  if (!k) return { error: 'Choose what you record.' };
  const unit = k.unit || (f.unit || '').trim();
  if (!unit) return { error: 'Enter a unit.' };
  const params = [];
  if (f.kind === 'rounds_reps') {
    const per = bmNum(f.perRound);
    if (!per || per < 1) return { error: 'Enter the reps in one full round.' };
    params.push({ param: 'round_reps', label: 'Reps per round', unit: 'reps', role: 'info', men: per, women: per });
  }
  if ((f.lockLabel || '').trim()) params.push({ param: 'locked1', label: f.lockLabel.trim(), unit: (f.lockUnit || '').trim() || 'text', role: 'locked', men: null, women: null });
  return { row: {
    id: id, key: key, name: name, category: 'custom', grp: 'custom', kind: f.kind, unit: unit,
    higher_is_better: (f.better || k.better || 'higher') === 'higher', status: 'set', params: params, steps: [],
    regions: [], flags: [], equipment: [], owner_athlete_id: athleteId,
  } };
}
async function bmSaveCustom() {
  const names = bmActiveTypes().map(function (t) { return t.name; });
  const built = bmCustomRow(BM.form, S.athlete.id, names, bmCustomKey(), bmUuid());
  if (built.error) { toast(built.error, 3000); return; }
  const ok = await bmWrite('bm_type_upsert', built.row);
  if (!ok) return;
  BM.types.push(bmNormType(built.row)); bmIndex();
  closeBmSheet();
  BM.ui.open.custom = true;
  toast('Created ' + built.row.name);
  bmOpenDetail(built.row.key);
}
function bmDeleteCustom(key) {
  const t = BM.byKey[key]; if (!t) return;
  const has = BM.results.some(function (r) { return r.test_type_id === t.id; });
  showConfirm(has ? 'Archive ' + t.name + '?' : 'Delete ' + t.name + '?', has ? 'It disappears from your library. Your results are kept.' : 'This can\'t be undone.', has ? 'Archive' : 'Delete', async function () {
    if (has) {
      t.status = 'retired';
      await bmWrite('bm_type_upsert', { key: t.key, id: t.id, name: t.name, category: 'custom', unit: t.unit, kind: t.kind, owner_athlete_id: S.athlete.id, status: 'retired' });
    } else {
      BM.types = BM.types.filter(function (x) { return x.key !== key; }); bmIndex();
      await bmWrite('bm_type_delete', { key: key, owner_athlete_id: S.athlete.id });
    }
    BM.detail = null; showScreen('benchmarks'); bmRenderScreen();
  }, !has);
}

// ═══════════════════════════════ §7 TRENDS ═══════════════════════════════════

// Called from the Trends body in trends.js. Data loads async → paints into its own slot.
function renderTrendsBenchmarks() {
  try {
    if (!BM.loaded) {
      loadBenchmarks().then(function () { const el = document.getElementById('bm-trends-slot'); if (el) el.outerHTML = bmTrendsHtml(); }).catch(function () {});
      return '<div id="bm-trends-slot"></div>';
    }
    return bmTrendsHtml();
  } catch (e) { console.error('renderTrendsBenchmarks:', e); return ''; }
}
function bmTrendsHtml() {
  const pins = bmPinnedEntries().filter(function (e) { return e.lines.length; });
  if (!pins.length) return '<div id="bm-trends-slot"></div>';
  const units = bmSettings().units;
  const body = pins.map(function (e) {
    const t = e.type, L = e.lines[0];
    const vals = L.results.filter(function (r) { return r.finished !== false; }).map(function (r) { return Number(r.value); });
    return '<div class="bm-trend-row" onclick="openBenchmarks();bmOpenDetail(' + bmDetailArgs(t.key, e.exId, e.fmt) + ')">'
      + '<div><div class="bm-row-name">' + bmEsc(bmEntryName(e)) + '</div><div class="bm-pin-meta">' + bmEsc(bmFmtValue(t, L.latest.value, units, L.latest)) + ' · ' + bmDateShort(L.lastDate) + ' ' + bmVerdictPill(L.verdict) + '</div></div>'
      + bmSparkSvg(vals, t.better, 100, 28) + '</div>';
  }).join('');
  return '<div id="bm-trends-slot">' + (typeof trendSection === 'function' ? trendSection('benchmarks', '🏆 Benchmarks', body) : body) + '</div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bmNormType: bmNormType, bmLineKey: bmLineKey, bmE1rm: bmE1rm, bmDrift: bmDrift, bmDriftVerdict: bmDriftVerdict,
    bmParseTime: bmParseTime, bmFmtTime: bmFmtTime, bmToStored: bmToStored, bmFromStored: bmFromStored, bmFmtValue: bmFmtValue,
    bmVerdict: bmVerdict, bmLines: bmLines, bmBest: bmBest, bmDue: bmDue, bmCautions: bmCautions, bmLiftEligible: bmLiftEligible,
    bmCustomKey: bmCustomKey, bmCustomRow: bmCustomRow, bmBuildRows: bmBuildRows, bmRoundsToTotal: bmRoundsToTotal,
    bmTotalToRounds: bmTotalToRounds, bmDaysBetween: bmDaysBetween, bmAddDays: bmAddDays, bmSparkSvg: bmSparkSvg,
    bmLineLabel: bmLineLabel, bmFmtDiff: bmFmtDiff, bmDispUnit: bmDispUnit };
}
