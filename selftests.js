// ═══════════════════════════════════════════════════════════════════════════
// selftests.js — Self-tests (mobility screens): engine, data, test list + test
// sheet, phone tilt meter, Today row, area-row results, Trends lines, check-in
// add-on. Was section 5 of movement.js until 2026-11-15 (self-tests redesign
// Phase 2: 07_Documentation/Self_Tests_Redesign_Plan_2026-11-13.md).
//
// Loads AFTER movement.js (uses MV, mvRegion, mvExclusions, mvWrite, mvSaveCache,
// mvPaintCard, mvPlan…) and BEFORE week.js. Engine functions are pure and are
// unit-tested in Node by 05_Scripts/test_movement_engine.js (which loads both files).
// ═══════════════════════════════════════════════════════════════════════════

// ── 5. SELF-TESTS (Phase 3 — outcomes) ──────────────────────────────────────
// Rules: 01_System/09_Daily_Movement_Framework.md §10. Test inventory:
// 03_Environment/Mobility_Drill_Map.md → Self-tests → mobility_self_tests.
// Results: mobility_screens (one row per test / side / date). Opt-outs:
// mobility_screen_prefs. Snooze, unit choice and declined focus-area offers
// live on the device (IndexedDB 'movementScreenUi').
//
// Engine functions first — pure (no DOM / Supabase / globals), tested by
// 05_Scripts/test_movement_engine.js. Then data, then UI.

const MV_SCREEN_CHECKUP_DAYS = 182;   // ~6 months
const MV_SCREEN_RETEST_DAYS = 28;     // focus-area retest
const MV_SCREEN_SNOOZE_DAYS = 7;      // "Later"
const MV_CM_PER_IN = 2.54;
const MV_SIDE_LABEL = { L: 'Left', R: 'Right', B: 'Both' };
const MV_SCREEN_RANGE = { deg: [0, 200], cm: [0, 80], fingers: [0, 15], points: [0, 10] };

// v2 columns (2026-11-14) are read here; the legacy `tilt` column is ignored (the
// phone meter now reads only tilt_cfg — a test without one has no phone button).
function mvTestNorm(r) {
  const num = function (v) { return v == null || v === '' || !isFinite(Number(v)) ? null : Number(v); };
  return {
    key: r.test_key, region: r.region, name: r.name, measure: r.measure, sides: r.sides,
    unit: r.unit || null, tiltCfg: mvTiltCfgNorm(r.tilt_cfg), better: r.better || null,
    tier: r.tier || 'core', version: num(r.version) || 1, target: num(r.target),
    needs: r.needs || [], helper: r.helper || 'no', estMinutes: num(r.est_minutes), painRule: r.pain_rule || 'standard',
    suggestWhen: r.suggest_when || [], defaultEvery: num(r.default_every), implication: r.implication || '',
    guide: r.guide || {}, checklist: r.checklist || null, videoUrl: r.video_url || null,
    mdc: r.mdc == null ? null : Number(r.mdc), defOp: r.deficient_op || null,
    defValue: r.deficient_value == null ? null : Number(r.deficient_value),
    asym: r.asymmetry == null ? null : Number(r.asymmetry), provisional: !!r.provisional,
    tags: r.caution_tags || [], findings: r.findings || [], good: r.good || '', shows: r.shows || '',
    steps: r.steps || [], sort: Number(r.sort_order || 0), offersHabit: r.offers_habit || null,
  };
}
function mvScreenSides(test) {
  return test.sides === 'LR' ? ['L', 'R'] : test.sides === 'LR+B' ? ['L', 'R', 'B'] : ['B'];
}
// On an LR+B test the "both together" step is pass/fail only.
function mvSideTakesNumber(test, side) { return test.measure !== 'pass' && !(test.sides === 'LR+B' && side === 'B'); }
function mvSideTakesPass(test, side) { return test.measure !== 'number' || (test.sides === 'LR+B' && side === 'B'); }
function mvSideName(test, side) {
  if (test.sides === 'B') return '';
  if (side === 'B') return 'Both arms together';
  return MV_SIDE_LABEL[side];
}

// Units — distances are stored in cm; the athlete enters and sees inches by default.
function mvScreenToStored(test, v, unitPref) {
  if (v == null || String(v).trim() === '') return null;
  let n = Number(v);
  if (!isFinite(n)) return null;
  if (test.unit === 'cm' && unitPref !== 'cm') n = n * MV_CM_PER_IN;
  return Math.round(n * 100) / 100;
}
function mvScreenDisp(test, v, unitPref) {
  if (v == null) return null;
  const n = Number(v);
  if (test.unit === 'cm') return unitPref !== 'cm' ? Math.round(n / MV_CM_PER_IN * 4) / 4 : Math.round(n * 2) / 2;
  if (test.unit === 'fingers' || test.unit === 'points') return Math.round(n * 2) / 2;
  return Math.round(n);
}
function mvScreenUnitLabel(test, unitPref) {
  return test.unit === 'deg' ? '°' : test.unit === 'cm' ? (unitPref !== 'cm' ? 'in' : 'cm') : test.unit === 'fingers' ? 'fingers'
    : test.unit === 'points' ? 'points' : '';
}
function mvFmtScreenValue(test, v, unitPref, signed) {
  const d = mvScreenDisp(test, v, unitPref);
  if (d == null) return '';
  const s = (signed && d > 0 ? '+' : '') + d;
  if (test.unit === 'deg') return s + '°';
  if (test.unit === 'fingers') return s + (Math.abs(d) === 1 ? ' finger' : ' fingers');
  if (test.unit === 'points') return s + (Math.abs(d) === 1 ? ' point' : ' points');
  return s + ' ' + mvScreenUnitLabel(test, unitPref);
}
// Typed-number range check (the phone's believable range is tilt_cfg min/max, checked in the run).
function mvScreenValueOk(test, stored) {
  const r = MV_SCREEN_RANGE[test.unit];
  if (!r) return true;
  if (test.unit === 'points' && Math.abs(stored * 2 - Math.round(stored * 2)) > 1e-9) return false;   // half-point steps
  return stored >= r[0] && stored <= r[1];
}
function mvTiltFmt(test, a) { return Math.round(a) + '°'; }

// ── Versions (Plan §6.5 Ver) ──
// Results carry the version they were taken under (mobility_screens.test_version; a
// row without one counts as 1). Only rows of the test's current version are compared.
// `test` may be a test object (filtered to its version) or a bare key (all versions —
// kept for callers that only need "any result").
function mvRowVer(r) { return r.test_version == null ? 1 : Number(r.test_version); }
function mvScreenRows(screens, test) {
  const key = typeof test === 'string' ? test : test.key;
  const ver = typeof test === 'string' ? null : (test.version || 1);
  return (screens || []).filter(function (s) { return s.test_key === key && (ver == null || mvRowVer(s) === ver); })
    .sort(function (a, b) { return a.test_date < b.test_date ? -1 : a.test_date > b.test_date ? 1 : 0; });
}
// Rows taken under an older version of the test ("earlier method").
function mvScreenOldRows(screens, test) {
  return (screens || []).filter(function (s) { return s.test_key === test.key && mvRowVer(s) !== (test.version || 1); });
}
// The most recent test date for a test, with its rows by side.
function mvScreenLatest(screens, test) {
  const rows = mvScreenRows(screens, test);
  if (!rows.length) return null;
  const d = rows[rows.length - 1].test_date;
  const out = { date: d, sides: {}, pain: false, finding: null };
  rows.filter(function (r) { return r.test_date === d; }).forEach(function (r) {
    out.sides[r.side] = r;
    if (r.pain_flag) out.pain = true;
    if (r.finding) out.finding = r.finding;
  });
  return out;
}

// "Worth working on" from one test date's rows (framework §10.2 / §10.4).
// A painful test is never deficient — pain routes to the Pain flow instead.
// reasons: [{side, kind: 'fail'|'below'|'above'|'asym', value}]
// hint:    'upper_back' (each arm passes alone, both together fail) | 'hip' (passes only with knees bent)
function mvScreenDeficient(test, latest) {
  const res = { deficient: false, painful: false, painRoute: false, reasons: [], hint: null };
  if (!latest) return res;
  if (latest.pain) { res.painful = true; return res; }
  const sd = latest.sides;
  ['L', 'R', 'B'].forEach(function (s) {
    const r = sd[s];
    if (!r) return;
    if (test.sides === 'LR+B' && s === 'B') return;          // reading aid, not a deficiency
    if (test.defOp === 'fail' && r.passed === false) res.reasons.push({ side: s, kind: 'fail' });
    if (test.defOp === 'fail_pain' && r.passed === false) res.painRoute = true;
    if ((test.defOp === '<' || test.defOp === '>') && r.value != null && test.defValue != null) {
      const v = Number(r.value);
      if (test.defOp === '<' ? v < test.defValue : v > test.defValue) {
        res.reasons.push({ side: s, kind: test.defOp === '<' ? 'below' : 'above', value: v });
      }
    }
  });
  if (test.asym != null && sd.L && sd.R && sd.L.value != null && sd.R.value != null) {
    const gap = Math.abs(Number(sd.L.value) - Number(sd.R.value));
    if (gap >= test.asym - 1e-9) res.reasons.push({ side: null, kind: 'asym', value: Math.round(gap * 100) / 100 });
  }
  if (test.sides === 'LR+B' && sd.B && sd.B.passed === false && sd.L && sd.R && sd.L.passed === true && sd.R.passed === true) {
    res.hint = 'upper_back';
  }
  if (latest.finding && /knees bent/i.test(latest.finding)) res.hint = 'hip';
  res.deficient = res.reasons.length > 0;
  return res;
}

// Change between two results for the same side. real = at least the test's
// Real Change, or a pass/fail flip. direction: 'better' | 'worse' | 'same'.
function mvScreenChange(test, baseline, latest) {
  if (!baseline || !latest) return null;
  const out = { delta: null, real: false, direction: 'same', flip: false };
  if (baseline.passed != null && latest.passed != null && !!baseline.passed !== !!latest.passed) {
    out.flip = true; out.real = true; out.direction = latest.passed ? 'better' : 'worse';
  }
  if (baseline.value != null && latest.value != null && test.unit) {
    out.delta = Math.round((Number(latest.value) - Number(baseline.value)) * 100) / 100;
    if (test.mdc != null && out.delta !== 0 && Math.abs(out.delta) >= test.mdc - 1e-9) {
      out.real = true;
      if (!out.flip) out.direction = ((out.delta > 0) === (test.better === 'higher')) ? 'better' : 'worse';
    }
  }
  return out;
}

// One side's history, oldest first. "It hurt" rows carry no score and are left out.
function mvScreenTrend(screens, test, side) {
  return mvScreenRows(screens, test).filter(function (r) {
    return r.side === side && !r.pain_flag && (r.value != null || r.passed != null);
  }).map(function (r) {
    return { date: r.test_date, value: r.value == null ? null : Number(r.value), passed: r.passed == null ? null : !!r.passed };
  });
}

// Per side: baseline (first result), latest, previous, and the changes — current version only.
function mvScreenSummary(test, screens) {
  const out = {};
  mvScreenSides(test).forEach(function (s) {
    const tr = mvScreenTrend(screens, test, s);
    if (!tr.length) return;
    const base = tr[0], last = tr[tr.length - 1], prev = tr.length > 1 ? tr[tr.length - 2] : null;
    out[s] = { baseline: base, latest: last, previous: prev, count: tr.length,
      sinceBaseline: tr.length > 1 ? mvScreenChange(test, base, last) : null,
      sinceLast: prev ? mvScreenChange(test, prev, last) : null };
  });
  return out;
}

// Result band (Plan §6.5 Target): at or past Target → 'good'; past the Deficient
// line → 'work' ("Worth working on"); between → 'fine' ("Fine — room to improve").
// value may be a number or a pass (true) / fail (false). null when the test has no lines.
function mvScreenBand(test, value) {
  if (value === true) return 'good';
  if (value === false) return 'work';
  if (value == null || !isFinite(Number(value))) return null;
  const v = Number(value), eps = 1e-9;
  if (test.defValue != null && (test.defOp === '<' || test.defOp === '>')) {
    if (test.defOp === '<' ? v < test.defValue - eps : v > test.defValue + eps) return 'work';
  }
  if (test.target != null) {
    const good = test.better === 'lower' ? v <= test.target + eps : v >= test.target - eps;
    return good ? 'good' : 'fine';
  }
  return test.defValue != null && (test.defOp === '<' || test.defOp === '>') ? 'fine' : null;
}
const MV_BAND_TEXT = { good: 'Good', fine: 'Fine — room to improve', work: 'Worth working on' };

// Why a test can't be prompted right now (ex = mvExclusions(); ctx.coachAssigned = {key:true}).
// kind 'paused' (red pain / neuro — unavailable), 'caution' (coach caution — skipped),
// 'amber' (open pain 3–5 — not prompted, still takeable by hand). null = fine.
// Plan §4.4: pain_rule 'safe' is never blocked by pain (knee swelling). A coach-assigned
// test is still prompted during amber pain → { kind: 'pain_free', painFree: true }.
function mvScreenBlock(test, ex, ctx) {
  if (!ex) return null;
  const safe = test.painRule === 'safe';
  const regs = mvRegion(test.region).loads || [test.region];       // whole_body → hip, knee, ankle, low back
  const red = regs.map(function (r) { return ex.red && ex.red[r]; }).filter(Boolean)[0];
  if (red && !safe) return { kind: 'paused', why: red.neuro ? 'nerve symptoms flagged' : 'open pain episode ' + red.score + '/10' };
  for (let i = 0; i < (test.tags || []).length; i++) {
    const why = ex.tags && ex.tags[test.tags[i]];
    if (why) return { kind: 'caution', why: why };
  }
  const amb = regs.map(function (r) { return ex.amber && ex.amber[r]; }).filter(Boolean)[0];
  if (amb && !safe) {
    if (ctx && ctx.coachAssigned && ctx.coachAssigned[test.key]) {
      return { kind: 'pain_free', painFree: true, why: 'open pain episode ' + amb.score + '/10 — pain-free range only' };
    }
    return { kind: 'amber', why: 'open pain episode ' + amb.score + '/10 — scores during a pain episode aren\'t comparable' };
  }
  return null;
}
function mvBlocks(b) { return !!(b && b.kind !== 'pain_free'); }

// Active assignment rows by test (mobility_test_assignments). Coach rows win over the
// athlete's own; 'suggested' rows that were accepted (status active) count as the athlete's.
function mvAssignIndex(assignments) {
  const out = { coach: {}, mine: {}, dismissed: {} };
  (assignments || []).forEach(function (a) {
    if (a.status === 'active') {
      if (a.source === 'coach') out.coach[a.test_key] = a;
      else if (!out.mine[a.test_key] || a.source === 'athlete') out.mine[a.test_key] = a;
    } else if (a.status === 'dismissed' && a.source === 'suggested') out.dismissed[a.test_key] = a;
  });
  return out;
}
function mvFocusRegions(ctx) {
  const f = {};
  if (ctx && ctx.mobilityOn && ctx.mode === 'targeted') (ctx.areas || []).forEach(function (a) { if (a.is_active !== false) f[a.region] = a; });
  return f;
}
function mvCtxCoach(ctx) {
  if (ctx.coachAssigned) return ctx.coachAssigned;
  const c = {};
  Object.keys(mvAssignIndex(ctx.assignments).coach).forEach(function (k) { c[k] = true; });
  return c;
}
function mvSortTests(list) { return list.slice().sort(function (a, b) { return a.sort - b.sort; }); }

// My tests (Plan §4.2). ctx = { areas, mobilityOn, mode, habitsOn, optouts, snoozes,
// exclusions, assignments, painHistory, remindersOff, coachAssigned, screens?, today? }.
// Lists may overlap (a coach-assigned core test is in both); the screen shows each test
// once, in the first of: coach, core, focus, mine, suggested.
//   core      — Quick Screen: every core test not opted out
//   coach     — [{test, row}] active coach assignments
//   focus     — core + follow-up tests of active focus-area regions (never monitor tests)
//   mine      — [{test, row}] added by the athlete (from All tests, or a suggestion they accepted)
//   suggested — [{test, why, trigger}] (needs ctx.screens + ctx.today)
//   all       — every test
function mvTestsMine(tests, ctx) {
  ctx = ctx || {};
  const opt = ctx.optouts || {}, ai = mvAssignIndex(ctx.assignments), focusR = mvFocusRegions(ctx);
  const ts = mvSortTests(tests || []);
  const out = { core: [], coach: [], focus: [], mine: [], suggested: [], all: ts };
  ts.forEach(function (t) {
    if (t.tier === 'core' && !opt[t.key]) out.core.push(t);
    if (ai.coach[t.key]) out.coach.push({ test: t, row: ai.coach[t.key] });
    else if (ai.mine[t.key]) out.mine.push({ test: t, row: ai.mine[t.key] });
    if (focusR[t.region] && t.tier !== 'monitor' && !opt[t.key]) out.focus.push(t);
  });
  out.suggested = ctx.today ? mvSuggestions(tests, ctx.screens || [], ctx, ctx.today) : [];
  return out;
}

// Suggested follow-up tests (Plan §4.2). Triggers from the test's Suggest When:
//   flag:<test>          that test's latest (current-version) result is worth working on
//   finding:<test>=<chip> that test's latest result carries that chip
//   history              a pain episode in this body area in the last 365 days (open or closed)
//   blocked:<test>       that test is skipped for this athlete by a coach caution
// Not suggested when: already in My tests (coach / added / focus), opted out, itself
// blocked, or "Not now" (a dismissed 'suggested' row) less than 182 days ago.
const MV_SUGGEST_HIDE_DAYS = 182;
const MV_HISTORY_DAYS = 365;
function mvSuggestions(tests, screens, ctx, todayStr) {
  ctx = ctx || {};
  const ai = mvAssignIndex(ctx.assignments), focusR = mvFocusRegions(ctx), opt = ctx.optouts || {};
  const byKey = {};
  (tests || []).forEach(function (t) { byKey[t.key] = t; });
  const out = [];
  mvSortTests(tests || []).forEach(function (t) {
    if (t.tier !== 'follow_up' || !(t.suggestWhen || []).length) return;
    if (ai.coach[t.key] || ai.mine[t.key] || focusR[t.region] || opt[t.key]) return;
    const dis = ai.dismissed[t.key];
    if (dis && mvDaysBetween(String(dis.updated_at || dis.assigned_on || '').slice(0, 10), todayStr) < MV_SUGGEST_HIDE_DAYS) return;
    if (mvBlocks(mvScreenBlock(t, ctx.exclusions, ctx))) return;
    let hit = null;
    (t.suggestWhen || []).some(function (trig) {
      const m = /^(flag|finding|blocked):([a-z0-9_]+)(?:=(.+))?$/.exec(trig);
      if (trig === 'history') {
        const ph = ctx.painHistory || {};
        const reg = mvRegion(t.region);
        const last = (reg.pain || []).map(function (p) { return ph[p]; }).filter(Boolean).sort().pop();
        if (last && mvDaysBetween(last, todayStr) <= MV_HISTORY_DAYS) {
          hit = { trigger: trig, why: 'You logged ' + reg.label.toLowerCase() + ' pain in the last year.' };
        }
      } else if (m && byKey[m[2]]) {
        const src = byKey[m[2]];
        if (m[1] === 'flag') {
          if (mvScreenDeficient(src, mvScreenLatest(screens, src)).deficient) hit = { trigger: trig, why: 'Your ' + src.name.toLowerCase() + ' result is worth working on.' };
        } else if (m[1] === 'finding') {
          const lt = mvScreenLatest(screens, src);
          const chips = lt && lt.finding ? String(lt.finding).split(';').map(function (x) { return x.trim(); }) : [];
          if (chips.indexOf(m[3]) >= 0) hit = { trigger: trig, why: src.name + ': “' + m[3] + '”.' };
        } else if (m[1] === 'blocked') {
          const b = mvScreenBlock(src, ctx.exclusions, ctx);
          if (b && b.kind === 'caution') hit = { trigger: trig, why: 'Your coach\'s caution skips the ' + src.name.toLowerCase() + ' test; this one avoids that position.' };
        }
      }
      return !!hit;
    });
    if (hit) out.push({ test: t, why: hit.why, trigger: hit.trigger });
  });
  return out;
}

// What is due (Plan §4.3). For each test in My tests, the first rule that applies:
//   1. coach or athlete assignment, cadence N days: due when there is no result since it
//      was assigned, then every N days counted from the later of assigned_on and the last
//      result. Cadence 0 = once.                                       → reason 'assigned'
//   2. focus area: never taken → 'baseline'; latest deficient and ≥ 28 days → 'retest';
//      area (re)started since the last result and ≥ 28 days → 'baseline'
//   3. habit-linked whole-body test (sit_rise while Floor sitting is on): deficient and
//      ≥ 28 days → 'retest'
//   4. Quick Screen: never taken or ≥ 182 days → 'checkup'
// Mobility being off no longer hides anything (only rule 2 needs it). Monitor and
// follow-up tests are never due without an assignment or a focus area.
// Returns { due, skipped, snoozed, optedOut }; items = { test, reason, source, focus,
// last, age, cadence, row, painFree }. Snoozes ("Later") hold every item for 7 days.
function mvScreensDue(tests, screens, ctx, todayStr) {
  ctx = ctx || {};
  const out = { due: [], skipped: [], snoozed: [], optedOut: [] };
  const ai = mvAssignIndex(ctx.assignments), focusR = mvFocusRegions(ctx);
  const habitsOn = ctx.habitsOn || {}, opt = ctx.optouts || {};
  const bctx = Object.assign({}, ctx, { coachAssigned: mvCtxCoach(ctx) });
  mvSortTests(tests || []).forEach(function (t) {
    const asg = ai.coach[t.key] || ai.mine[t.key] || null;
    const area = t.tier !== 'monitor' ? focusR[t.region] : null;
    const viaHabit = !!(t.offersHabit && habitsOn[t.offersHabit]);
    if (!asg && !area && t.tier !== 'core') return;
    if (opt[t.key]) { out.optedOut.push(t); return; }
    const block = mvScreenBlock(t, ctx.exclusions, bctx);
    if (mvBlocks(block)) { out.skipped.push({ test: t, kind: block.kind, why: block.why }); return; }
    const rows = mvScreenRows(screens, t);
    const last = rows.length ? rows[rows.length - 1].test_date : null;
    const age = last ? mvDaysBetween(last, todayStr) : null;
    let reason = null;
    if (asg) {
      const since = asg.assigned_on || null;
      const cad = asg.cadence_days == null ? (t.defaultEvery || 0) : Number(asg.cadence_days);
      if (!last || (since && last < since)) reason = 'assigned';
      else if (cad > 0) {
        const from = since && since > last ? since : last;
        if (mvDaysBetween(from, todayStr) >= cad) reason = 'assigned';
      }
    } else if (area) {
      if (!last) reason = 'baseline';
      else if (age >= MV_SCREEN_RETEST_DAYS && mvScreenDeficient(t, mvScreenLatest(screens, t)).deficient) reason = 'retest';
      else if (age >= MV_SCREEN_RETEST_DAYS && area.started_on && area.started_on > last) reason = 'baseline';
    } else if (viaHabit && last && age >= MV_SCREEN_RETEST_DAYS && mvScreenDeficient(t, mvScreenLatest(screens, t)).deficient) {
      reason = 'retest';
    }
    if (!reason && !asg && t.tier === 'core' && (!last || age >= MV_SCREEN_CHECKUP_DAYS)) reason = 'checkup';
    if (!reason) return;
    const item = { test: t, reason: reason, source: asg ? (asg.source === 'coach' ? 'coach' : 'mine') : area ? 'focus' : 'core',
      focus: reason === 'retest' || reason === 'baseline', last: last, age: age,
      cadence: asg ? (asg.cadence_days == null ? t.defaultEvery : Number(asg.cadence_days)) : null, row: asg,
      painFree: !!(block && block.painFree) };
    const sn = ctx.snoozes && ctx.snoozes[t.key];
    if (sn && todayStr < sn) { out.snoozed.push(item); return; }
    out.due.push(item);
  });
  const rank = { coach: 0, focus: 1, mine: 2, core: 3 };
  out.due.sort(function (a, b) { return (rank[a.source] - rank[b.source]) || (a.test.sort - b.test.sort); });
  return out;
}
// When an assigned test is next due (for "Every 7 days · next Thursday"), or null.
function mvNextDue(test, screens, row, todayStr) {
  if (!row) return null;
  const cad = row.cadence_days == null ? (test.defaultEvery || 0) : Number(row.cadence_days);
  const rows = mvScreenRows(screens, test);
  const last = rows.length ? rows[rows.length - 1].test_date : null;
  if (!last || (row.assigned_on && last < row.assigned_on)) return todayStr;
  if (!cad) return null;
  const from = row.assigned_on && row.assigned_on > last ? row.assigned_on : last;
  return mvAddDays(from, cad);
}
// The phone's / an older app's measure we can't show → "update the app" instead of a crash.
const MV_KNOWN_MEASURES = ['number', 'pass', 'both'];
function mvMeasureKnown(test) { return MV_KNOWN_MEASURES.indexOf(test.measure) >= 0; }

// ── Phone tilt v2 (Plan §5.2, 2026-11-15) ──
// One reading: the elevation of the phone's LONG edge (y axis), from the gravity
// vector g = devicemotion accelerationIncludingGravity {x, y, z}:
//   E = atan2(g.y, hypot(g.x, g.z))  (degrees, −90…90)
// Twisting the phone about its long edge changes g.x / g.z but not hypot(g.x, g.z),
// so E does not move. iOS and Android report opposite signs; everything below
// uses |E|, differences of E, or products of two readings, so the sign never matters.
// Modes (per test, tilt_cfg): incline = |E| (or |E − E0| with zero 'start'),
// plumb = 90 − |E| (0 = straight up and down), swing = travel from the start, 0–180°.
const MV_TILT_VERSION = 'tilt v2.0';
const MV_TILT_STILL_DEG = 3;          // "still" = every sample within 3° of the window's average
const MV_TILT_GATE_MS = 1200;         // flat / upright gates: still this long
const MV_TILT_REST_MS = 2000;         // still / after gates, and the hold capture window
const MV_TILT_REST_MIN_MS = 3000;     // 'still' gate: at least this long after the side starts
const MV_TILT_HINT_MS = 45000;        // gate not met → say what we're waiting for
const MV_TILT_GIVEUP_MS = 120000;     // → stop and offer the typed number
const MV_TILT_KEEP_MS = 2500;         // sample history kept for stillness checks
const MV_TILT_HOLD_MS = 1000;         // reach: steady run this long near the best range
const MV_TILT_BAND = 6;
const MV_TILT_PEAK_MS = 400;          // best range = highest level sustained this long
const MV_TILT_DROP = 25;              // coming back this far below the best range captures it
const MV_TILT_MODES = ['incline', 'plumb', 'swing'];

function mvWrap180(a) { return ((a + 180) % 360 + 360) % 360 - 180; }
function mvVecAngle(a, b) {
  const na = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z), nb = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
  if (!na || !nb) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (na * nb)))) * 180 / Math.PI;
}
// Signed long-edge elevation in degrees, or null without a usable vector.
function mvTiltE(g) {
  if (!g || !isFinite(g.x) || !isFinite(g.y) || !isFinite(g.z)) return null;
  const h = Math.hypot(g.x, g.z);
  if (!h && !g.y) return null;
  return Math.atan2(g.y, h) * 180 / Math.PI;
}
// Travel of the long edge from the start vector g0, 0–180°, valid past vertical.
// s flips once the segment has passed vertical (the x/z part reverses); 0 counts as +1.
function mvTiltSwing(g0, g) {
  if (!g0 || !g) return null;
  const s = (g.x * g0.x + g.z * g0.z) >= 0 ? 1 : -1;
  const phi = Math.atan2(g.y, s * Math.hypot(g.x, g.z));
  const ph0 = Math.atan2(g0.y, Math.hypot(g0.x, g0.z));
  return Math.abs(mvWrap180((phi - ph0) * 180 / Math.PI));
}
// tilt_cfg from mobility_self_tests → normalized, or null (no phone button).
function mvTiltCfgNorm(c) {
  if (!c || MV_TILT_MODES.indexOf(c.mode) < 0) return null;
  const num = function (v, d) { return v == null || v === '' || !isFinite(Number(v)) ? d : Number(v); };
  return { mode: c.mode, zero: c.zero === 'start' ? 'start' : 'none', gate: String(c.gate || 'still'),
    capture: c.capture === 'reach' ? 'reach' : 'hold', tries: Math.max(1, Math.min(3, num(c.tries, 1))),
    min: num(c.min, 0), max: num(c.max, 180), placement: c.placement || '' };
}
// The test's reading from a start vector g0 (needed for zero 'start' and swing) and now g.
function mvTiltRead(cfg, g0, g) {
  if (!cfg) return null;
  const E = mvTiltE(g);
  if (E == null) return null;
  if (cfg.mode === 'plumb') return 90 - Math.abs(E);
  if (cfg.mode === 'swing') return mvTiltSwing(g0, g);
  if (cfg.mode === 'incline') {
    if (cfg.zero !== 'start') return Math.abs(E);
    const E0 = mvTiltE(g0);
    return E0 == null ? null : Math.abs(E - E0);
  }
  return null;
}
function mvTiltGate(cfg) {
  const m = /^(flat|upright|after):(\d+(?:\.\d+)?)$/.exec((cfg && cfg.gate) || '');
  return m ? { kind: m[1], n: Number(m[2]) } : { kind: 'still', n: null };
}
// Average vector of the last `ms`, but only if every sample in it is within 3° of
// that average and the window really spans ~ms. samples: [{t, x, y, z}] oldest first.
function mvTiltStill(samples, now, ms) {
  const w = (samples || []).filter(function (s) { return now - s.t <= ms; });
  if (w.length < 3 || now - w[0].t < ms * 0.75) return null;
  const m = { x: 0, y: 0, z: 0 };
  w.forEach(function (s) { m.x += s.x; m.y += s.y; m.z += s.z; });
  m.x /= w.length; m.y /= w.length; m.z /= w.length;
  for (let i = 0; i < w.length; i++) { if (mvVecAngle(m, w[i]) > MV_TILT_STILL_DEG) return null; }
  return m;
}
// Kept for the old call sites' meaning: the start reading once the phone is still 400 ms.
function mvTiltZero(samples, now) { return mvTiltStill(samples, now, 400); }
// Is the start position seen right now (pose only, no stillness)? flat / upright only.
function mvTiltInGate(cfg, g) {
  const gt = mvTiltGate(cfg), E = mvTiltE(g);
  if (E == null) return false;
  if (gt.kind === 'flat') return Math.abs(E) <= gt.n;
  if (gt.kind === 'upright') return 90 - Math.abs(E) <= gt.n;
  return false;
}
// Start gate. state: { t0 (side/try start, ms), maxAbsE (largest |E| since t0) }.
// Returns the still window's average vector (the start reading) when the gate is met, else null.
//   flat:N    |E| ≤ N and still 1.2 s       upright:N  90 − |E| ≤ N and still 1.2 s
//   still     still 2 s, ≥ 3 s after t0     after:N    still 2 s, once |E| has passed N since t0
function mvTiltGateOk(cfg, state, g, samples, now) {
  const gt = mvTiltGate(cfg);
  if (gt.kind === 'flat' || gt.kind === 'upright') {
    const m = mvTiltStill(samples, now, MV_TILT_GATE_MS);
    return m && mvTiltInGate(cfg, m) ? m : null;
  }
  if (gt.kind === 'after' && !((state && state.maxAbsE) > gt.n)) return null;
  if (gt.kind === 'still' && now - ((state && state.t0) || 0) < MV_TILT_REST_MIN_MS) return null;
  return mvTiltStill(samples, now, MV_TILT_REST_MS);
}
function mvTiltPlausible(cfg, value) {
  if (!cfg || value == null || !isFinite(value)) return false;
  const v = Math.round(value);
  return v >= cfg.min && v <= cfg.max;
}
// Two tries within Real Change → their average; otherwise ask for a third and take
// the middle one. Whole degrees. tries: numbers in the order taken.
function mvTiltCombine(tries, realChange) {
  const t = (tries || []).filter(function (v) { return v != null && isFinite(v); }).map(Number);
  if (!t.length) return { value: null, needAnother: true };
  if (t.length === 1) return { value: Math.round(t[0]), needAnother: false };
  if (t.length === 2) {
    const avg = Math.round((t[0] + t[1]) / 2);
    const rc = realChange == null ? Infinity : Number(realChange);
    return { value: avg, needAnother: Math.abs(t[0] - t[1]) > rc + 1e-9 };
  }
  const s = t.slice(-3).sort(function (a, b) { return a - b; });
  return { value: Math.round(s[1]), needAnother: false };
}
// Reach capture (today's logic, made mode-free). Feed (state, ms, reading, inGate).
//   hold — readings within MV_TILT_BAND for MV_TILT_HOLD_MS, near the best range, ≥ 10° off the start
//   peak — the reading falls MV_TILT_DROP below the best range
//   gate — the segment is back inside the start gate after moving ≥ 10°
// "Best range" = the highest level SUSTAINED for MV_TILT_PEAK_MS, so a spike is not range.
function mvTiltTrack(st, t, a, inGate) {
  st = st || {};
  if (!st.win) st.win = [];
  if (st.captured === undefined) st.captured = null;
  if (st.captured != null) return st;
  if (st.start == null) st.start = a;
  if (Math.abs(a - st.start) >= 10) st.moved = true;
  st.win.push({ t: t, a: a });
  while (st.win.length > 1 && t - st.win[0].t > MV_TILT_PEAK_MS) st.win.shift();
  if (st.moved && t - st.win[0].t >= MV_TILT_PEAK_MS * 0.75) {
    let lo = Infinity, sum = 0;
    st.win.forEach(function (w) { lo = Math.min(lo, w.a); sum += w.a; });
    if (st.best == null || lo > st.best) { st.best = lo; st.bestMean = sum / st.win.length; }
  }
  const r = st.run;
  if (r && Math.max(r.hi, a) - Math.min(r.lo, a) <= MV_TILT_BAND) {
    r.hi = Math.max(r.hi, a); r.lo = Math.min(r.lo, a); r.sum += a; r.n++;
  } else {
    st.run = { t0: t, lo: a, hi: a, sum: a, n: 1 };
  }
  st.steadyMs = t - st.run.t0;
  const runMean = st.run.sum / st.run.n;
  const offStart = Math.abs(runMean - st.start) >= 10;
  const nearBest = st.best == null || runMean >= st.best - MV_TILT_BAND;
  const ranged = st.best != null && st.best - st.start >= 10;
  if (st.moved && st.steadyMs >= MV_TILT_HOLD_MS && nearBest && offStart) {
    st.captured = runMean; st.how = 'hold';
  } else if (ranged && a <= st.best - MV_TILT_DROP) {
    st.captured = st.bestMean; st.how = 'peak';
  } else if (ranged && inGate) {
    st.captured = st.bestMean; st.how = 'gate';
  }
  return st;
}
// What the app says while waiting for the gate.
function mvTiltGateHint(cfg) {
  const gt = mvTiltGate(cfg), p = ((cfg && cfg.placement) || '').toLowerCase();
  const seg = /forearm/.test(p) ? 'forearm' : /breastbone|chest/.test(p) ? 'chest' : /thigh/.test(p) ? 'thigh' : 'shin';
  if (gt.kind === 'upright') return seg === 'chest' ? 'I\'m waiting for your shoulders to be stacked, one above the other.'
    : 'I\'m waiting for your ' + seg + ' to be straight up and down.';
  if (gt.kind === 'flat') return seg === 'chest' ? 'I\'m waiting for your shoulders to be level.'
    : 'I\'m waiting for your leg to be flat.';
  return 'I\'m waiting for you to hold still.';
}
const MV_TILT_OFF_SAY = 'That reading looks off. Check the phone is lengthwise.';
function mvTiltSideSay(side, v) { return (side === 'R' ? 'Right' : side === 'L' ? 'Left' : 'Reading') + ': ' + v + ' degrees.'; }
function mvTiltMoveSay(next) { return 'Now move the phone to the ' + (next === 'R' ? 'right' : 'left') + ' side.'; }

// One side's run. Create with mvTiltSide(cfg, now); feed every (smoothed) sample with
// mvTiltRun(state, now, g, cfg) — cfg is the test's tilt_cfg plus realChange.
// Phases: arming → ready → reach | hold → (try captured: 'arming' again for the next
// try) → side_done. Also: 'off' (implausible reading — mvTiltOffAccept / mvTiltRearm),
// 'timeout' (gate never met, or no capture, in 120 s). Returns events, never touches the DOM:
//   {type:'say', text} {type:'beep', n} {type:'hint', text} {type:'value', value}
//   {type:'phase', phase} {type:'try', value, n} {type:'off', value} {type:'done', value, tries} {type:'timeout'}
function mvTiltSide(cfg, now) {
  return { phase: 'arming', t0: now, armT0: now, samples: [], maxAbsE: 0, hinted: false,
    g0: null, track: null, readyT: null, tries: [], live: null, value: null, offValue: null };
}
function mvTiltRearm(st, now) {
  st.phase = 'arming'; st.t0 = now; st.armT0 = now; st.samples = []; st.maxAbsE = 0; st.hinted = false;
  st.g0 = null; st.track = null; st.readyT = null; st.live = null; st.offValue = null;
}
function mvTiltTry(st, now, v, cfg, ev) {
  if (!mvTiltPlausible(cfg, v)) {
    st.phase = 'off'; st.offValue = Math.round(v);
    ev.push({ type: 'off', value: st.offValue }, { type: 'say', text: MV_TILT_OFF_SAY });
    return;
  }
  st.tries.push(Math.round(v * 10) / 10);
  ev.push({ type: 'try', value: Math.round(v), n: st.tries.length });
  const c = mvTiltCombine(st.tries, cfg.realChange);
  const want = cfg.tries || 1;
  if (st.tries.length < want) {
    ev.push({ type: 'beep', n: 2 }, { type: 'say', text: 'Got it. ' + Math.round(v) + '. Once more.' });
    mvTiltRearm(st, now);
    return;
  }
  if (c.needAnother && st.tries.length < 3) {
    ev.push({ type: 'beep', n: 2 }, { type: 'say', text: 'One more.' });
    mvTiltRearm(st, now);
    return;
  }
  st.phase = 'side_done'; st.value = c.value;
  ev.push({ type: 'beep', n: 2 }, { type: 'done', value: c.value, tries: st.tries.slice() });
}
function mvTiltOffAccept(st, now, cfg) {
  const ev = [];
  if (st.phase !== 'off' || st.offValue == null) return ev;
  const v = st.offValue;
  st.phase = 'arming';
  mvTiltTry(st, now, v, Object.assign({}, cfg, { min: -Infinity, max: Infinity }), ev);
  return ev;
}
function mvTiltRun(st, now, g, cfg) {
  const ev = [];
  if (!st || !g || !cfg) return ev;
  const E = mvTiltE(g);
  if (E == null) return ev;
  st.samples.push({ t: now, x: g.x, y: g.y, z: g.z });
  while (st.samples.length && now - st.samples[0].t > MV_TILT_KEEP_MS) st.samples.shift();
  st.maxAbsE = Math.max(st.maxAbsE || 0, Math.abs(E));
  if (st.phase === 'arming') {
    const m = mvTiltGateOk(cfg, st, g, st.samples, now);
    if (m) {
      st.g0 = m; st.readyT = now;
      st.phase = cfg.capture === 'reach' ? 'reach' : 'hold';
      st.track = cfg.capture === 'reach' ? mvTiltTrack(null, now, mvTiltRead(cfg, m, m), true) : null;
      ev.push({ type: 'phase', phase: 'ready' }, { type: 'beep', n: 1 }, { type: 'say', text: 'Ready. Go.' });
      return ev;
    }
    const waited = now - st.armT0;
    if (waited >= MV_TILT_GIVEUP_MS) { st.phase = 'timeout'; ev.push({ type: 'timeout' }); }
    else if (waited >= MV_TILT_HINT_MS && !st.hinted) {
      st.hinted = true;
      const h = mvTiltGateHint(cfg);
      ev.push({ type: 'hint', text: h }, { type: 'say', text: h });
    }
    return ev;
  }
  if (st.phase !== 'reach' && st.phase !== 'hold') return ev;
  const a = mvTiltRead(cfg, st.g0, g);
  if (a == null || !isFinite(a)) return ev;
  st.live = a;
  ev.push({ type: 'value', value: a });
  if (now - st.readyT >= MV_TILT_GIVEUP_MS) { st.phase = 'timeout'; ev.push({ type: 'timeout' }); return ev; }
  if (st.phase === 'reach') {
    st.track = mvTiltTrack(st.track, now, a, mvTiltInGate(cfg, g));
    if (st.track.captured != null) mvTiltTry(st, now, st.track.captured, cfg, ev);
    return ev;
  }
  // hold: the middle reading of a 2 s still window taken after "Ready".
  const w = st.samples.filter(function (s) { return s.t >= st.readyT; });
  if (now - st.readyT >= MV_TILT_REST_MS && mvTiltStill(w, now, MV_TILT_REST_MS)) {
    const vals = w.filter(function (s) { return now - s.t <= MV_TILT_REST_MS; })
      .map(function (s) { return mvTiltRead(cfg, st.g0, s); }).sort(function (x, y) { return x - y; });
    mvTiltTry(st, now, vals[Math.floor(vals.length / 2)], cfg, ev);
  }
  return ev;
}
// Between sides: has the phone been picked up and moved? gEnd = the vector when the side
// finished; s = a raw sample. Moved = turned > 15° or jolted (|a| off by > 1.5 m/s²).
function mvTiltMoved(gEnd, s) {
  if (!gEnd || !s) return false;
  const ne = Math.sqrt(gEnd.x * gEnd.x + gEnd.y * gEnd.y + gEnd.z * gEnd.z), ns = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
  return mvVecAngle(gEnd, s) > 15 || Math.abs(ns - ne) > 1.5;
}
// Tilt check (first use): flat on the floor → 0° ± 3; on its short edge against a wall → 90° ± 3.
function mvTiltCheckOk(step, absE) {
  if (absE == null) return false;
  return step === 'flat' ? absE <= 3 : Math.abs(90 - absE) <= 3;
}

// ── Self-tests: data ──

MV.tests = MV.tests || [];
MV.screens = MV.screens || [];
MV.screenPrefs = MV.screenPrefs || [];
MV.assignments = MV.assignments || [];   // mobility_test_assignments (coach / athlete / suggested)
MV.screenUi = MV.screenUi || { unit: 'in', snoozes: {}, declined: {}, speak: true, tiltChecked: null };
MV.testDrafts = MV.testDrafts || {};   // unsaved entries per test (today) — survive leaving / reopening the test
MV.st = MV.st || { from: 'week', allOpen: {} };
const MV_REMINDERS_KEY = 'reminders';  // mobility_screen_prefs row: opted_out = reminders off (Plan §9)

// Called inside loadMovement() when online. Its own try: a missing table must never
// break the walk / mobility check-off. Assignments have their own try too.
async function mvLoadScreens() {
  try {
    const id = S.athlete.id;
    const res = await Promise.all([
      db.from('mobility_self_tests').select('*').order('sort_order'),
      db.from('mobility_screens').select('*').eq('athlete_id', id).order('test_date'),
      db.from('mobility_screen_prefs').select('*').eq('athlete_id', id),
    ]);
    const err = res.map(function (r) { return r.error; }).filter(Boolean)[0];
    if (err) throw err;
    MV.tests = (res[0].data || []).map(mvTestNorm);
    MV.screens = res[1].data || [];
    MV.screenPrefs = res[2].data || [];
  } catch (e) { console.error('mvLoadScreens:', e); }
  try {
    const r = await db.from('mobility_test_assignments').select('*').eq('athlete_id', S.athlete.id);
    if (r.error) throw r.error;
    MV.assignments = r.data || [];
  } catch (e) { console.error('mvLoadScreens (assignments):', e); }
}
async function mvLoadScreenUi() {
  try {
    const u = await idbGet('movementScreenUi');
    if (u && u.athleteId === S.athlete.id) {
      MV.screenUi = { unit: u.unit === 'cm' ? 'cm' : 'in', snoozes: u.snoozes || {}, declined: u.declined || {},
        speak: u.speak !== false, tiltChecked: u.tiltChecked || null };
    }
  } catch (_) {}
}
async function mvSaveScreenUi() {
  try { await idbSet('movementScreenUi', Object.assign({ athleteId: S.athlete.id }, MV.screenUi)); } catch (_) {}
}

async function mvSaveScreens(rows) {
  const ok = await mvWrite('movement_screen_upsert', { rows: rows });
  if (!ok) return false;
  rows.forEach(function (r) {
    MV.screens = MV.screens.filter(function (x) {
      return !(x.test_key === r.test_key && x.side === r.side && x.test_date === r.test_date);
    }).concat([r]);
  });
  await mvSaveCache();
  return true;
}
async function mvSetOptOut(key, out) {
  const row = { athlete_id: S.athlete.id, test_key: key, opted_out: !!out, updated_at: new Date().toISOString() };
  const ok = await mvWrite('movement_screen_pref', row);
  if (!ok) return false;
  MV.screenPrefs = MV.screenPrefs.filter(function (p) { return p.test_key !== key; }).concat([row]);
  await mvSaveCache();
  return true;
}
// One assignment row (upsert on athlete_id, test_key, source). The athlete writes only
// 'athlete' and 'suggested' rows; coach rows come from push_program.py (RLS enforces it).
async function mvSaveAssignment(key, source, patch) {
  const cur = MV.assignments.filter(function (a) { return a.test_key === key && a.source === source; })[0];
  const t = mvTest(key);
  const row = Object.assign({ athlete_id: S.athlete.id, test_key: key, source: source, status: 'active',
    cadence_days: t && t.defaultEvery != null ? t.defaultEvery : 0, reason: null, trigger: null,
    assigned_on: mvToday(), ended_on: null }, cur || {}, patch || {}, { updated_at: new Date().toISOString() });
  delete row.id; delete row.created_at;
  const ok = await mvWrite('movement_test_assignment', row);
  if (!ok) return false;
  MV.assignments = MV.assignments.filter(function (a) { return !(a.test_key === key && a.source === source); }).concat([row]);
  await mvSaveCache();
  return true;
}

function mvTest(key) { return MV.tests.filter(function (t) { return t.key === key; })[0] || null; }
function mvOptouts() {
  const o = {};
  MV.screenPrefs.forEach(function (p) { if (p.opted_out && p.test_key !== MV_REMINDERS_KEY) o[p.test_key] = true; });
  return o;
}
function mvRemindersOff() { return MV.screenPrefs.some(function (p) { return p.test_key === MV_REMINDERS_KEY && p.opted_out; }); }
function mvScreenEx() { return mvExclusions(MV.cautions, (S && S.openInjuries) || []); }
function mvHabitsOn() {
  const on = {};
  mvHabits().forEach(function (h) { if (mvPlan(h.key)) on[h.key] = true; });
  return on;
}
function mvCtx() {
  const mob = mvPlan('mobility');
  const ctx = { areas: MV.areas, mobilityOn: !!mob, mode: mob ? mob.mode : null, habitsOn: mvHabitsOn(), optouts: mvOptouts(),
    snoozes: MV.screenUi.snoozes, exclusions: mvScreenEx(), assignments: MV.assignments,
    painHistory: (S && S.painHistory) || {}, remindersOff: mvRemindersOff(), screens: MV.screens, today: mvToday() };
  ctx.coachAssigned = mvCtxCoach(ctx);
  return ctx;
}
function mvDueNow() { return mvScreensDue(MV.tests, MV.screens, mvCtx(), mvToday()); }
function mvFocusArea(region) {
  const mob = mvPlan('mobility');
  if (!mob || mob.mode !== 'targeted') return null;
  return MV.areas.filter(function (a) { return a.region === region && a.is_active !== false; })[0] || null;
}
function mvShortDate(ds) {
  const p = ds.split('-');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + (+p[2]);
}
function mvDayName(ds) {
  const p = ds.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}
function mvCadenceText(n) { return !n ? 'Once' : n === 7 ? 'Every week' : n % 7 === 0 ? 'Every ' + (n / 7) + ' weeks' : 'Every ' + n + ' days'; }

// "L 152° (+6°) · R 160°" — latest per side, change since the first result (current version).
function mvScreenResultText(test, sum) {
  const u = MV.screenUi.unit;
  return mvScreenSides(test).filter(function (s) { return sum[s]; }).map(function (s) {
    const x = sum[s], v = x.latest;
    const lbl = test.sides === 'B' ? '' : (s === 'B' ? 'Both ' : s + ' ');
    let txt = lbl + (v.value != null && mvSideTakesNumber(test, s) ? mvFmtScreenValue(test, v.value, u)
      : (v.passed ? 'pass' : 'not yet'));
    const ch = x.sinceBaseline;
    if (ch && ch.delta != null && ch.delta !== 0 && mvSideTakesNumber(test, s)) txt += ' (' + mvFmtScreenValue(test, ch.delta, u, true) + ')';
    else if (ch && ch.flip) txt += ch.direction === 'better' ? ' (now passes)' : ' (was passing)';
    return txt;
  }).join(' · ');
}
function mvDefReasonText(test, r) {
  const u = MV.screenUi.unit;
  const side = r.side && test.sides !== 'B' ? MV_SIDE_LABEL[r.side].toLowerCase() + ' ' : '';
  if (r.kind === 'fail') return side + 'didn\'t pass';
  if (r.kind === 'below') return side + mvFmtScreenValue(test, r.value, u) + ' (under ' + mvFmtScreenValue(test, test.defValue, u) + ')';
  if (r.kind === 'above') return side + mvFmtScreenValue(test, r.value, u) + ' (over ' + mvFmtScreenValue(test, test.defValue, u) + ')';
  return 'left/right gap of ' + mvFmtScreenValue(test, r.value, u);
}
// One band for a test date: worth working on if deficient; good if every scored side is good.
function mvLatestBand(test, latest) {
  if (!latest || latest.pain) return null;
  if (mvScreenDeficient(test, latest).deficient) return 'work';
  const bands = Object.keys(latest.sides).filter(function (s) { return !(test.sides === 'LR+B' && s === 'B'); }).map(function (s) {
    const r = latest.sides[s];
    const byPass = test.defOp === 'fail' || test.defOp === 'fail_pain' || !(mvSideTakesNumber(test, s) && r.value != null);
    return mvScreenBand(test, byPass ? r.passed : Number(r.value));
  }).filter(Boolean);
  if (!bands.length) return null;
  return bands.every(function (b) { return b === 'good'; }) ? 'good' : 'fine';
}
function mvBandPill(b) { return b ? '<span class="mv-band mv-band-' + b + '">' + MV_BAND_TEXT[b] + '</span>' : ''; }

// ── Self-tests: UI ──

// Today card row — shown whenever something is due, even with every habit off
// (Plan §4.3). Wording: coach-assigned due → retest due → Quick Screen. Never "overdue".
function mvTestRowHtml() {
  if (!MV.tests.length || mvRemindersOff()) return '';
  const d = mvDueNow().due;
  if (!d.length) return '';
  const coach = d.filter(function (x) { return x.source === 'coach'; });
  const retest = d.filter(function (x) { return x.reason === 'retest'; });
  const focus = d.filter(function (x) { return x.source === 'focus' || x.source === 'mine'; });
  const core = d.filter(function (x) { return x.source === 'core'; });
  const names = function (l) { return l.slice(0, 2).map(function (x) { return x.test.name; }).join(' · ') + (l.length > 2 ? ' +' + (l.length - 2) : ''); };
  let title, sub;
  if (coach.length) { title = 'From your coach'; sub = names(coach); }
  else if (retest.length) { title = 'Retest due'; sub = names(retest); }
  else if (focus.length) { title = 'Self-test due'; sub = names(focus); }
  else {
    const mins = Math.round(core.reduce(function (s, x) { return s + (x.test.estMinutes || 2); }, 0));
    title = 'Quick Screen';
    sub = core.length + ' short test' + (core.length === 1 ? '' : 's') + ' · about ' + mins + ' min in total · any order, any day';
  }
  return '<div class="mv-row mv-test-row"><div class="mv-test-icon">📏</div>'
    + '<div class="mv-row-body" onclick="openMvTests(\'week\')"><div class="mv-row-title">' + title + '</div>'
    + '<div class="mv-row-sub">' + mvEsc(sub) + '</div></div>'
    + '<button class="mv-mini mv-later" onclick="mvSnoozeDue()">Later</button>'
    + '<div class="arrow" onclick="openMvTests(\'week\')">›</div></div>';
}
function mvSnoozeDue() {
  const until = mvAddDays(mvToday(), MV_SCREEN_SNOOZE_DAYS);
  mvDueNow().due.forEach(function (x) { MV.screenUi.snoozes[x.test.key] = until; });
  mvSaveScreenUi();
  mvPaintCard();
  toast('Okay — back in a week');
}

// Movement screen card.
function mvScreensCardHtml() {
  if (!MV.tests.length) return '';
  const n = mvDueNow().due.length;
  return '<div class="card"><div class="card-title" style="font-size:16px">📏 Self-tests</div>'
    + '<div class="card-sub" style="margin:4px 0 10px">Short checks that show whether your range is changing. '
    + (n ? '<b>' + n + ' due.</b> ' : '') + 'Optional — take any test any time.</div>'
    + '<button class="btn secondary" onclick="openMvTests(\'movement\')">Open self-tests</button></div>';
}

// Focus-area row line in the Movement screen.
function mvAreaScreenLineHtml(region) {
  const tests = MV.tests.filter(function (t) { return t.region === region && t.tier !== 'monitor'; });
  if (!tests.length) return '';
  const parts = tests.map(function (t) {
    const txt = mvScreenResultText(t, mvScreenSummary(t, MV.screens));
    return txt ? mvEsc(t.name) + ': ' + mvEsc(txt) : '';
  }).filter(Boolean);
  return '<div class="mv-area-test" onclick="openMvTests(\'movement\')">📏 '
    + (parts.length ? parts.join('<br>') : 'No self-test yet — take one') + '</div>';
}

// ── The self-tests screen (#screen-selftests): home, then one test in four steps ──
function mvStBody() { return document.getElementById('st-body'); }
function mvStHeader(title, sub) {
  const a = document.getElementById('st-title'), b = document.getElementById('st-sub');
  if (a) a.textContent = title;
  if (b) b.textContent = sub || '';
}
function mvStActive() { const s = document.getElementById('screen-selftests'); return !!(s && s.classList.contains('active')); }
function openMvTests(from) {
  mvTiltStop();
  if (from) MV.st.from = from;
  MV.test = null; MV.tiltCheck = null;
  if (!mvStActive()) showScreen('selftests');
  mvRenderTestList();
  const b = mvStBody(); if (b && b.parentNode) b.parentNode.scrollTop = 0;
  window.scrollTo(0, 0);
}
function mvStBack() {
  if (MV.test && MV.test.tilt && MV.test.tilt.phase === 'run') return;   // the guard owns the screen
  if (MV.test || MV.tiltCheck) { openMvTests(); return; }
  mvTiltStop();
  const from = MV.st.from;
  if (from === 'movement' && typeof openMovement === 'function') openMovement();
  else if (from === 'benchmarks' && typeof openBenchmarks === 'function') openBenchmarks();
  else if (typeof renderWeek === 'function') { showScreen('week'); renderWeek(); }
  else showScreen('week');
}

// Self-tests home (Plan §7.1).
function mvRenderTestList() {
  mvStHeader('📏 Self-tests', 'Short checks that track your range');
  const body = mvStBody();
  if (!body) return;
  if (!MV.tests.length) {
    body.innerHTML = '<div class="mv-note">The self-test library hasn\'t synced yet — ask your coach to run sync_mobility.py.</div>';
    return;
  }
  const ctx = mvCtx(), today = mvToday();
  const dn = mvScreensDue(MV.tests, MV.screens, ctx, today);
  const mine = mvTestsMine(MV.tests, ctx);
  const shown = {};
  const due = {};
  dn.due.forEach(function (x) { due[x.test.key] = x; });
  const rows = function (list, info) {
    return list.filter(function (t) { return !shown[t.key]; }).map(function (t) { shown[t.key] = true; return mvTestListRow(t, info ? info(t) : null); }).join('');
  };
  let h = '<div class="mv-note">Optional checks that show whether your range is changing. Take any test any time, skip any you like. '
    + 'They track change; they don\'t diagnose.</div>';
  if (dn.due.length) {
    h += '<div class="form-section-label">Due now</div>' + rows(dn.due.map(function (x) { return x.test; }), function (t) { return { due: due[t.key] }; });
  }
  if (mine.coach.length) {
    const ch = rows(mine.coach.map(function (x) { return x.test; }), function (t) { return { row: mine.coach.filter(function (x) { return x.test === t; })[0].row }; });
    h += '<div class="form-section-label">From your coach</div>' + (ch || '<div class="mv-muted mv-st-none">All due ones are above.</div>');
  }
  if (mine.core.length) {
    const fresh = function (t) { const r = mvScreenRows(MV.screens, t); return r.length && mvDaysBetween(r[r.length - 1].test_date, today) < MV_SCREEN_CHECKUP_DAYS; };
    const done = mine.core.filter(fresh).length;
    const qs = rows(mine.core);
    h += '<div class="form-section-label">Quick Screen <span class="mv-muted">· ' + done + ' of ' + mine.core.length + ' done</span></div>'
      + (qs || '<div class="mv-muted mv-st-none">Due ones are above.</div>');
  }
  const fo = rows(mine.focus);
  if (fo) h += '<div class="form-section-label">For your focus areas</div>' + fo;
  const sg = mine.suggested.filter(function (x) { return !shown[x.test.key]; });
  if (sg.length) {
    h += '<div class="form-section-label">Suggested for you</div>' + sg.map(function (x) {
      shown[x.test.key] = true;
      return mvTestListRow(x.test, { suggest: x });
    }).join('');
  }
  const mi = rows(mine.mine.map(function (x) { return x.test; }), function (t) { return { row: mine.mine.filter(function (x) { return x.test === t; })[0].row }; });
  if (mi) h += '<div class="form-section-label">Added by you</div>' + mi;
  // All tests, by body area, collapsed
  h += '<div class="form-section-label">All tests</div><div class="mv-st-all">';
  MV_REGION_ORDER.concat(MV_TEST_REGIONS.map(function (r) { return r.key; })).forEach(function (region) {
    const ts = mvSortTests(MV.tests.filter(function (t) { return t.region === region; }));
    if (!ts.length) return;
    const open = !!MV.st.allOpen[region];
    h += '<div class="mv-st-group" data-region="' + region + '"><div class="mv-st-group-hdr" onclick="mvStToggleGroup(\'' + region + '\')">'
      + mvEsc(mvRegion(region).label) + ' <span class="mv-muted">(' + ts.length + ')</span><span class="mv-st-chev">' + (open ? '▾' : '▸') + '</span></div>'
      + (open ? ts.map(function (t) { return mvTestListRow(t, { all: true }); }).join('') : '') + '</div>';
  });
  h += '</div>';
  // Settings
  const u = MV.screenUi.unit, rem = !mvRemindersOff();
  h += '<div class="form-section-label">Settings</div><div class="mv-st-settings">' + mvSpeakToggleHtml()
    + '<div class="triage-chips mv-speak-chips"><span class="mv-muted" style="align-self:center">Distances</span>'
    + '<button class="triage-chip' + (u !== 'cm' ? ' active' : '') + '" onclick="mvSetScreenUnit(\'in\')">Inches</button>'
    + '<button class="triage-chip' + (u === 'cm' ? ' active' : '') + '" onclick="mvSetScreenUnit(\'cm\')">cm</button></div>'
    + '<div class="triage-chips mv-speak-chips"><span class="mv-muted" style="align-self:center">Remind me on Today</span>'
    + '<button class="triage-chip' + (rem ? ' active' : '') + '" id="mv-rem-on" onclick="mvSetReminders(true)">On</button>'
    + '<button class="triage-chip' + (!rem ? ' active' : '') + '" id="mv-rem-off" onclick="mvSetReminders(false)">Off</button></div>'
    + '<div class="mv-test-optout" style="text-align:left"><a class="mv-link" id="mv-open-tiltcheck" onclick="mvTiltCheckOpen(false)">📐 Tilt check — live angle readout</a></div></div>';
  body.innerHTML = h;
}
function mvStToggleGroup(r) { MV.st.allOpen[r] = !MV.st.allOpen[r]; mvRenderTestList(); }
async function mvSetReminders(on) {
  const ok = await mvSetOptOut(MV_REMINDERS_KEY, !on);
  if (!ok) return;
  toast(on ? 'Self-test reminders on' : 'Okay — no self-test row on Today');
  mvRenderTestList();
  mvPaintCard();
}

const MV_NEED_CHIP = { 'phone': '📱 phone', 'tape measure': '📏 tape', 'soft tape': '📏 soft tape', 'long sock': '🧦 sock',
  'strap': '🎗 strap', 'bed or bench': '🛏 bed or bench', 'chair': '🪑 chair', 'mirror': '🪞 mirror', 'wall': '🧱 wall' };
function mvNeedChips(t) {
  const c = (t.needs || []).map(function (n) { return MV_NEED_CHIP[n]; }).filter(Boolean);
  if (t.helper === 'yes') c.push('👥 helper');
  return c;
}
// info: { due } | { row } (assignment) | { suggest: {why, trigger} } | { all: true } | null
function mvTestListRow(t, info) {
  info = info || {};
  const ctx = mvCtx();
  const block = mvScreenBlock(t, ctx.exclusions, ctx);
  const opted = mvOptouts()[t.key];
  const latest = mvScreenLatest(MV.screens, t);
  const band = mvLatestBand(t, latest);
  const dueItem = info.due;
  const ai = mvAssignIndex(MV.assignments);
  const row = info.row || ai.coach[t.key] || ai.mine[t.key] || null;
  let status;
  if (dueItem) {
    status = dueItem.reason === 'assigned' ? (dueItem.source === 'coach' ? 'Due · from your coach' : 'Due · you added this')
      : dueItem.reason === 'retest' ? 'Due · monthly retest' : dueItem.reason === 'baseline' ? 'Due · first test for this focus area' : 'Due · Quick Screen';
    if (dueItem.painFree) status += ' · pain-free range only';
  } else if (opted) status = 'Opted out';
  else if (block && (block.kind === 'paused' || block.kind === 'caution')) status = 'Skipped — ' + block.why;
  else if (block && block.kind === 'amber') status = 'Not now — ' + block.why;
  else if (row) {
    const nx = mvNextDue(t, MV.screens, row, mvToday());
    status = mvCadenceText(row.cadence_days == null ? t.defaultEvery : Number(row.cadence_days))
      + (nx ? ' · next ' + mvDayName(nx) + ', ' + mvShortDate(nx) : latest ? ' · done ' + mvShortDate(latest.date) : '');
  } else status = latest ? 'Last taken ' + mvShortDate(latest.date) : 'Not taken yet';
  const res = mvScreenResultText(t, mvScreenSummary(t, MV.screens));
  const chips = mvNeedChips(t);
  const off = opted || (block && (block.kind === 'paused' || block.kind === 'caution'));
  let h = '<div class="mv-test-item' + (off ? ' mv-test-item-off' : '') + (dueItem ? ' mv-test-item-due' : '') + '" data-test="' + t.key + '">'
    + '<div onclick="openMvTest(\'' + t.key + '\')">'
    + '<div class="mv-test-item-top"><span class="mv-drill-name">' + mvEsc(t.name) + '</span>'
    + (latest && latest.pain ? '<span class="mv-test-flag-tag">hurt</span>' : mvBandPill(band)) + '</div>'
    + '<div class="mv-test-meta">' + chips.map(function (c) { return '<span class="mv-need">' + c + '</span>'; }).join('')
    + (t.estMinutes ? '<span class="mv-need mv-need-min">' + t.estMinutes + ' min</span>' : '') + '</div>'
    + (res ? '<div class="mv-test-res">' + mvEsc(res) + '</div>' : '')
    + (row && row.source === 'coach' && row.reason ? '<div class="mv-test-reason">Coach: ' + mvEsc(row.reason) + '</div>' : '')
    + '<div class="mv-drill-dose' + (dueItem ? ' mv-test-due' : '') + '">' + mvEsc(status) + '</div></div>';
  if (info.suggest) {
    h += '<div class="mv-test-reason">' + mvEsc(info.suggest.why) + '</div><div class="triage-chips mv-suggest-btns">'
      + '<button class="triage-chip" onclick="mvSuggestAdd(\'' + t.key + '\',\'' + mvEsc(info.suggest.trigger) + '\')">Add</button>'
      + '<button class="triage-chip" onclick="mvSuggestNotNow(\'' + t.key + '\',\'' + mvEsc(info.suggest.trigger) + '\')">Not now</button></div>';
  }
  return h + '</div>';
}
async function mvSuggestAdd(key, trigger) {
  const ok = await mvSaveAssignment(key, 'suggested', { status: 'active', trigger: trigger, assigned_on: mvToday(), ended_on: null });
  if (!ok) return;
  toast(mvTest(key).name + ' added to your tests');
  if (MV.test) mvRenderTest(); else mvRenderTestList();
  mvPaintCard();
}
async function mvSuggestNotNow(key, trigger) {
  const ok = await mvSaveAssignment(key, 'suggested', { status: 'dismissed', trigger: trigger, assigned_on: mvToday() });
  if (!ok) return;
  toast('Okay — not suggested again for 6 months');
  if (MV.test) mvRenderTest(); else mvRenderTestList();
}
async function mvAddMine(key, add) {
  const t = mvTest(key);
  const ok = await mvSaveAssignment(key, 'athlete', add
    ? { status: 'active', cadence_days: t.defaultEvery != null ? t.defaultEvery : 0, assigned_on: mvToday(), ended_on: null }
    : { status: 'ended', ended_on: mvToday() });
  if (!ok) return;
  toast(add ? t.name + ' added to your tests' : t.name + ' removed from your tests');
  mvRenderTest();
  mvPaintCard();
}

// One test in four steps (Plan §7.2): ready → setup → measure → result.
function openMvTest(key) {
  const t = mvTest(key);
  if (!t) return;
  mvTiltStop();
  MV.sheet = null; MV.tiltCheck = null;
  if (!mvStActive()) showScreen('selftests');
  const d = mvToday();
  const dr = MV.testDrafts[key];
  if (dr && dr.date === d && !dr.saved) {           // unsaved typed / measured values come back
    dr.tilt = null; dr.offer = null;
    MV.test = dr;
    mvRenderTest();
    return;
  }
  const st = { key: key, date: d, step: 'ready', side: null, sides: {}, finding: null, notes: '', saved: false, tilt: null, offer: null };
  MV.screens.filter(function (r) { return r.test_key === key && r.test_date === d && !r.pain_flag && mvRowVer(r) === t.version; }).forEach(function (r) {
    if (r.finding) st.finding = r.finding;
    if (r.notes) st.notes = r.notes;
  });
  mvScreenSides(t).forEach(function (s) {
    const r = MV.screens.filter(function (x) { return x.test_key === key && x.test_date === d && x.side === s && !x.pain_flag && mvRowVer(x) === t.version; })[0];
    st.sides[s] = { value: r && r.value != null ? String(mvScreenDisp(t, r.value, MV.screenUi.unit)) : '',
      passed: r && r.passed != null ? !!r.passed : null };
  });
  st.side = mvScreenSides(t)[0];
  MV.test = st;
  MV.testDrafts[key] = st;
  mvRenderTest();
}
function mvTestStep(step) {
  if (!MV.test) return;
  MV.test.step = step;
  mvRenderTest();
  window.scrollTo(0, 0);
}
function mvTestSide(s) { if (MV.test) { MV.test.side = s; mvRenderTest(); } }

function mvStepsHtml(list) {
  return (list && list.length) ? '<ol class="mv-test-steps">' + list.map(function (s) { return '<li>' + mvEsc(s) + '</li>'; }).join('') + '</ol>' : '';
}
function mvStepDots(step) {
  const all = [['ready', 'Get ready'], ['setup', 'Set up'], ['measure', 'Measure'], ['result', 'Result']];
  return '<div class="mv-st-steps">' + all.map(function (x, i) {
    return '<span class="mv-st-step' + (x[0] === step ? ' on' : '') + '">' + (i + 1) + ' ' + x[1] + '</span>';
  }).join('') + '</div>';
}
function mvFigure(t, small) {
  try { if (typeof stFigureSvg === 'function') { const s = stFigureSvg(t.key); if (s) return '<div class="mv-st-fig' + (small ? ' small' : '') + '">' + s + '</div>'; } } catch (_) {}
  return '';
}

function mvRenderTest() {
  const st = MV.test;
  if (!st) return;
  const t = mvTest(st.key);
  const body = mvStBody();
  if (!t || !body) return;
  mvStHeader('📏 ' + t.name, t.tier === 'core' ? 'Quick Screen' : t.tier === 'monitor' ? 'Monitoring test' : 'Follow-up test');
  if (st.tilt) { body.innerHTML = mvTiltHtml(t, st.tilt); return; }
  if (st.saved) { body.innerHTML = mvStepDots('result') + mvTestResultHtml(t, st); return; }
  if (!mvMeasureKnown(t)) {
    body.innerHTML = '<div class="mv-paused">This test needs a newer version of the app. Close the app fully and reopen it to update.</div>'
      + '<button class="btn secondary" onclick="openMvTests()">Back to self-tests</button>';
    return;
  }
  const ctx = mvCtx();
  const block = mvScreenBlock(t, ctx.exclusions, ctx);
  const opted = mvOptouts()[t.key];
  const ai = mvAssignIndex(MV.assignments);
  const coachRow = ai.coach[t.key], mineRow = ai.mine[t.key];
  const g = t.guide || {};
  let h = mvStepDots(st.step);
  if (block && (block.kind === 'paused' || block.kind === 'caution')) {
    h += '<div class="mv-test-shows">' + mvEsc(t.shows) + '</div>'
      + '<div class="mv-paused">' + (block.kind === 'paused' ? '⏸ Paused — ' : 'Skipped — ') + mvEsc(block.why) + '</div>'
      + (block.kind === 'caution'
        ? '<div class="card-sub">Your coach suggests avoiding this position for now. You can change that under Cautions in 🚶 Movement.</div>'
        : '<div class="card-sub">This area has an open pain episode. <a class="mv-link" onclick="openPainSheet()">Open 🚩 Pain</a></div>');
    body.innerHTML = h + '<button class="btn secondary" onclick="openMvTests()">Back to self-tests</button>';
    return;
  }
  if (st.step === 'ready') {
    const needs = g.need_note || (t.needs || []).join(', ');
    h += '<div class="mv-test-shows">' + mvEsc(t.shows) + '</div>' + mvFigure(t)
      + '<div class="mv-st-facts">'
      + '<div><b>You need:</b> ' + mvEsc(needs || 'nothing') + '</div>'
      + '<div><b>Helper:</b> ' + (t.helper === 'yes' ? 'yes — this test needs a second person' : t.helper === 'optional' ? 'optional' : 'no') + (g.helper_note ? ' <span class="mv-muted">' + mvEsc(g.helper_note) + '</span>' : '') + '</div>'
      + (t.estMinutes ? '<div><b>Time:</b> about ' + t.estMinutes + ' min, both sides</div>' : '')
      + '</div>';
    if (coachRow) h += '<div class="mv-st-coach"><b>From your coach</b> · ' + mvEsc(mvCadenceText(coachRow.cadence_days)) + (coachRow.reason ? '<br>' + mvEsc(coachRow.reason) : '') + '</div>';
    if (block && block.painFree) h += '<div class="mv-note">⚠ Pain-free range only — ' + mvEsc(block.why.replace(/ — pain-free range only$/, '')) + '. Stop before it hurts.</div>';
    else if (block) h += '<div class="mv-note">⚠ ' + mvEsc(block.why) + '. You can still take it — keep it pain-free.</div>';
    if (t.videoUrl) h += '<a class="mv-link mv-st-video" href="' + mvEsc(t.videoUrl) + '" target="_blank" rel="noopener">▶ Watch a demo</a>';
    h += '<button class="btn" id="mv-step-next" onclick="mvTestStep(\'setup\')">Set up →</button>'
      + '<div class="mv-test-optout">'
      + (coachRow ? '' : mineRow ? '<a class="mv-link" onclick="mvAddMine(\'' + t.key + '\',false)">Remove from my tests</a> · '
        : (t.tier !== 'core' ? '<a class="mv-link" id="mv-add-mine" onclick="mvAddMine(\'' + t.key + '\',true)">Add to my tests</a> · ' : ''))
      + '<a class="mv-link" onclick="mvTestOptOut(\'' + t.key + '\',' + (opted ? 'false' : 'true') + ')">'
      + (opted ? 'Show this test again' : 'Don\'t suggest this test') + '</a></div>'
      + '<button class="btn secondary" onclick="openMvTests()">Back to self-tests</button>';
    body.innerHTML = h;
    return;
  }
  if (st.step === 'setup') {
    const setup = (g.setup && g.setup.length) ? g.setup : t.steps;
    h += '<div class="mv-st-setup">' + mvFigure(t, true) + '<div>'
      + (setup.length ? '<div class="form-section-label">Set up</div>' + mvStepsHtml(setup) : '')
      + (t.tiltCfg ? '<div class="mv-tilt-place">📱 <b>Phone:</b> ' + mvEsc(t.tiltCfg.placement) + ' Long edge in line, screen facing out.</div>' : '')
      + (g.do && g.do.length ? '<div class="form-section-label">Do it</div>' + mvStepsHtml(g.do) : '')
      + '</div></div>'
      + ((g.watch || []).length ? '<div class="mv-st-watch"><b>Watch for:</b> ' + g.watch.map(mvEsc).join(' · ') + '</div>' : '')
      + '<div class="mv-test-safety">Stop if pain goes above 2/10 and tap <b>It hurt</b>. Same set-up every time: same spot, shoes off.</div>'
      + '<button class="btn" id="mv-step-next" onclick="mvTestStep(\'measure\')">Measure →</button>'
      + '<button class="btn secondary" onclick="mvTestStep(\'ready\')">← Back</button>';
    body.innerHTML = h;
    return;
  }
  // measure — one side at a time with a large side label
  const u = MV.screenUi.unit;
  const sides = mvScreenSides(t);
  if (sides.indexOf(st.side) < 0) st.side = sides[0];
  h += '<div class="mv-test-good"><b>Good:</b> ' + mvEsc(t.good) + (t.provisional ? ' <span class="mv-muted">(rough guide for now)</span>' : '') + '</div>';
  if (g.measure && g.measure.length) h += mvStepsHtml(g.measure);
  if (t.unit === 'cm') {
    h += '<div class="triage-chips mv-unit-chips">'
      + '<button class="triage-chip' + (u !== 'cm' ? ' active' : '') + '" onclick="mvSetScreenUnit(\'in\')">Inches</button>'
      + '<button class="triage-chip' + (u === 'cm' ? ' active' : '') + '" onclick="mvSetScreenUnit(\'cm\')">cm</button></div>';
  }
  if (t.tiltCfg && mvTiltSidesOf(t).length) {
    const ts = mvTiltSidesOf(t);
    h += '<div class="mv-tilt-cta"><button class="btn secondary" id="mv-tilt-open" onclick="mvTiltOpen(null)">📐 Measure with phone'
      + (ts.length > 1 ? ' — both sides' : '') + '</button>'
      + '<div class="mv-muted">Or type the number' + (ts.length > 1 ? 's' : '') + ' below.</div></div>';
  }
  if (sides.length > 1) {
    h += '<div class="mv-side-tabs">' + sides.map(function (s) {
      const x = st.sides[s];
      const has = (x.value != null && String(x.value).trim() !== '') || x.passed != null;
      return '<button class="mv-side-tab' + (s === st.side ? ' on' : '') + '" data-side="' + s + '" onclick="mvTestSide(\'' + s + '\')">'
        + (s === 'B' ? 'Both' : MV_SIDE_LABEL[s]) + (has ? ' ✓' : '') + '</button>';
    }).join('') + '</div>';
  }
  sides.forEach(function (s) {
    const x = st.sides[s];
    const nm = mvSideName(t, s);
    h += '<div class="mv-test-side' + (s === st.side ? '' : ' mv-hidden') + '" data-side="' + s + '">'
      + (nm ? '<div class="mv-side-big">' + mvEsc(nm.toUpperCase()) + '</div>' : '');
    if (mvSideTakesPass(t, s)) {
      h += '<div class="triage-chips">'
        + '<button class="triage-chip' + (x.passed === true ? ' active' : '') + '" onclick="mvTestPass(\'' + s + '\',true)">Pass</button>'
        + '<button class="triage-chip' + (x.passed === false ? ' active' : '') + '" onclick="mvTestPass(\'' + s + '\',false)">Not yet</button></div>';
    }
    if (mvSideTakesNumber(t, s)) {
      h += '<div class="mv-num-row"><input class="mv-num" id="mv-num-' + s + '" type="number" inputmode="decimal" step="' + (t.unit === 'points' ? '0.5' : 'any') + '"'
        + (t.unit === 'points' ? ' max="10"' : '') + ' min="0"'
        + ' value="' + mvEsc(x.value) + '" placeholder="—" oninput="MV.test.sides[\'' + s + '\'].value=this.value">'
        + '<span class="mv-num-unit">' + mvScreenUnitLabel(t, u) + '</span>'
        + (x.tilt && String(x.value) === x.tilt.value ? '<span class="mv-muted mv-num-src">📐 phone</span>' : '')
        + '</div>';
    }
    const i = sides.indexOf(s);
    if (i < sides.length - 1) h += '<button class="btn secondary mv-side-next" onclick="mvTestSide(\'' + sides[i + 1] + '\')">Next: ' + mvEsc(mvSideName(t, sides[i + 1]) || '') + ' →</button>';
    h += '</div>';
  });
  if (t.findings.length) {
    h += '<div class="form-section-label">What did you notice? (optional)</div><div class="triage-chips">'
      + t.findings.map(function (f, i) {
        return '<button class="triage-chip' + (st.finding === f ? ' active' : '') + '" onclick="mvTestFinding(' + i + ')">' + mvEsc(f) + '</button>';
      }).join('') + '</div>';
  }
  h += '<textarea class="sheet-search mv-notes" placeholder="Notes (optional)" oninput="MV.test.notes=this.value">' + mvEsc(st.notes) + '</textarea>'
    + '<button class="btn" id="mv-test-save" onclick="mvTestSave(false)">Save</button>'
    + '<button class="btn secondary mv-hurt" onclick="mvTestHurt()">⚠ It hurt</button>'
    + '<button class="btn secondary" onclick="mvTestStep(\'setup\')">← Back</button>';
  body.innerHTML = h;
}

function mvTestPass(side, v) {
  const x = MV.test.sides[side];
  x.passed = x.passed === v ? null : v;
  mvRenderTest();
}
function mvTestFinding(i) {
  const f = mvTest(MV.test.key).findings[i];
  MV.test.finding = MV.test.finding === f ? null : f;
  mvRenderTest();
}
function mvSetScreenUnit(u) {
  const t = MV.test && mvTest(MV.test.key);
  const from = MV.screenUi.unit;
  if (u === from) return;
  if (t && t.unit === 'cm') {
    Object.keys(MV.test.sides).forEach(function (s) {
      const x = MV.test.sides[s];
      const stored = mvScreenToStored(t, x.value, from);
      if (stored != null) x.value = String(mvScreenDisp(t, stored, u));
    });
  }
  MV.screenUi.unit = u;
  mvSaveScreenUi();
  if (MV.test) mvRenderTest(); else mvRenderTestList();
}

// How a result was taken (mobility_screens.method): the phone reading when the field
// still holds it, otherwise by unit. trials = the phone's raw tries.
function mvScreenMethod(t, side, x, value, passed) {
  if (value != null && x && x.tilt && String(x.value).trim() === x.tilt.value) return 'tilt';
  if (value == null) return passed == null ? null : 'pass';
  if (t.unit === 'deg') return 'typed';
  if (t.unit === 'cm') return 'tape';
  if (t.measure === 'checklist') return 'checklist';
  return 'count';
}
function mvScreenRow(t, side, value, passed, pain) {
  const st = MV.test;
  const x = st.sides && st.sides[side];
  const method = pain ? null : mvScreenMethod(t, side, x, value, passed);
  return { athlete_id: S.athlete.id, test_date: st.date, test_key: t.key, side: side,
    value: value, unit: value == null ? null : t.unit, passed: passed, pain_flag: !!pain,
    finding: st.finding || null, notes: st.notes || null, updated_at: new Date().toISOString(),
    test_version: t.version || 1, method: method, trials: method === 'tilt' ? x.tilt.trials.slice() : null };
}

async function mvTestSave(hurt) {
  const st = MV.test;
  if (!st) return;
  const t = mvTest(st.key);
  const u = MV.screenUi.unit;
  let rows = [];
  const sides = mvScreenSides(t);
  for (let i = 0; i < sides.length; i++) {
    const s = sides[i], x = st.sides[s];
    const nm = mvSideName(t, s);
    let value = null, passed = mvSideTakesPass(t, s) ? x.passed : null;
    if (mvSideTakesNumber(t, s) && String(x.value).trim() !== '') {
      value = mvScreenToStored(t, x.value, u);
      if (value == null || !mvScreenValueOk(t, value)) { st.side = s; mvRenderTest(); toast('Check the ' + (nm ? nm.toLowerCase() + ' ' : '') + 'number', 3000); return; }
    }
    // Lower-is-better tests with the pass line at 0 (Thomas, toe touch, heel-to-butt).
    if (t.measure === 'both' && t.better === 'lower') {
      if (passed === true && value == null) value = 0;
      if (passed == null && value != null) passed = value <= 0;
    }
    if (value == null && passed == null) continue;
    rows.push(mvScreenRow(t, s, value, passed, false));
  }
  if (hurt) {
    rows = rows.filter(function (r) { return r.side !== 'B'; });
    rows.push(mvScreenRow(t, 'B', null, null, true));
  }
  if (!rows.length) { toast('Enter a result for at least one side — or tap It hurt'); return; }
  const ok = await mvSaveScreens(rows);
  if (!ok) return;
  if (MV.screenUi.snoozes[t.key]) { delete MV.screenUi.snoozes[t.key]; mvSaveScreenUi(); }
  st.saved = true;
  st.step = 'result';
  st.hurt = !!hurt;
  delete MV.testDrafts[t.key];
  mvRenderTest();
  mvPaintCard();
  window.scrollTo(0, 0);
}
function mvTestHurt() {
  showConfirm('Stop this test?', 'A painful test isn\'t a mobility problem. We\'ll note it for your coach — no score is saved for it.',
    'It hurt', function () { mvTestSave(true); });
}

// Result (Plan §7.2 step 4): per side the number and its band in words, change since
// last time and since the first test, then what happens next.
function mvTestResultHtml(t, st) {
  const u = MV.screenUi.unit;
  const latest = mvScreenLatest(MV.screens, t);
  const def = mvScreenDeficient(t, latest);
  const sum = mvScreenSummary(t, MV.screens);
  let h = '<div class="mv-test-saved">✓ Saved</div>';
  if (def.painful || def.painRoute) {
    h += '<div class="mv-paused">Pain isn\'t a mobility problem. Logging it in 🚩 Pain lets your coach see it and keeps your plan safe.</div>'
      + '<button class="btn" onclick="mvTestPain()">Log pain now</button>';
  } else {
    mvScreenSides(t).forEach(function (s) {
      const x = sum[s];
      if (!x) return;
      const nm = mvSideName(t, s);
      const num = mvSideTakesNumber(t, s) && x.latest.value != null;
      const cur = num ? mvFmtScreenValue(t, x.latest.value, u) : (x.latest.passed ? 'Pass' : 'Not yet');
      const byPass = t.defOp === 'fail' || t.defOp === 'fail_pain' || !num;      // pass/fail tests: the pass decides the band
      const band = t.sides === 'LR+B' && s === 'B' ? null : mvScreenBand(t, byPass ? x.latest.passed : x.latest.value);
      h += '<div class="mv-test-change" data-side="' + s + '"><b>' + (nm ? nm + ': ' : '') + mvEsc(cur) + '</b> ' + mvBandPill(band);
      if (x.count < 2) h += '<div class="mv-muted">First result — your baseline.</div>';
      [['sinceLast', 'last time', x.previous], ['sinceBaseline', 'your first test', x.baseline]].forEach(function (c) {
        const ch = x[c[0]];
        if (!ch || (c[0] === 'sinceBaseline' && x.count < 3)) return;
        const d = ch.delta != null && mvSideTakesNumber(t, s) ? mvFmtScreenValue(t, ch.delta, u, true)
          : (ch.flip ? (ch.direction === 'better' ? 'now passes' : 'no longer passes') : 'no change');
        h += '<div class="mv-muted">vs ' + c[1] + ' (' + mvShortDate(c[2].date) + '): ' + mvEsc(d)
          + (ch.real ? (ch.direction === 'better' ? ' — real improvement' : ch.direction === 'worse' ? ' — real drop' : '')
            : ' — within normal day-to-day wobble') + '</div>';
      });
      h += '</div>';
    });
    const old = mvScreenOldRows(MV.screens, t);
    if (old.length) h += '<div class="mv-muted" style="margin:4px 0">Results from an earlier method of this test aren\'t compared.</div>';
    if (def.hint === 'upper_back') h += '<div class="mv-note">Each arm passes alone but not both together — that points to your upper back.</div>';
    if (def.hint === 'hip') h += '<div class="mv-note">Passing only with knees bent points to the front of the hips — try the hip flexor (Thomas) test.</div>';
    if (def.deficient) {
      h += '<div class="mv-test-flag">⚑ Worth working on — ' + mvEsc(def.reasons.map(function (r) { return mvDefReasonText(t, r); }).join('; ')) + '.'
        + (t.provisional ? ' <span class="mv-muted">(rough guide for now)</span>' : '') + '</div>';
      if (t.region !== 'low_back' || t.defOp !== 'fail_pain') h += mvTestOfferHtml(t, st, latest);
    }
    // What happens next
    const ctx = mvCtx();
    const sugg = mvSuggestions(MV.tests, MV.screens, ctx, mvToday()).filter(function (x) {
      return x.trigger.indexOf(':' + t.key) >= 0;
    });
    if (sugg.length) {
      h += '<div class="form-section-label">Suggested next</div>' + sugg.map(function (x) { return mvTestListRow(x.test, { suggest: x }); }).join('');
    }
    const ai = mvAssignIndex(MV.assignments), row = ai.coach[t.key] || ai.mine[t.key];
    if (row) {
      const nx = mvNextDue(t, MV.screens, row, mvToday());
      h += '<div class="card-sub" style="margin:8px 0">' + (nx ? 'Next check ' + mvDayName(nx) + ', ' + mvShortDate(nx) + ' (' + mvEsc(mvCadenceText(row.cadence_days).toLowerCase()) + ').'
        : 'Done — your ' + (row.source === 'coach' ? 'coach asked' : 'plan was') + ' for this once.') + '</div>';
    } else if (!def.deficient && latest && !latest.pain) {
      h += '<div class="card-sub" style="margin:8px 0">' + (mvFocusArea(t.region) ? 'Comes back with your focus area.' : t.tier === 'core' ? 'Next check in about 6 months.' : 'Take it again any time.') + '</div>';
    }
  }
  h += '<button class="btn" onclick="openMvTests()">Back to self-tests</button>';
  return h;
}
// Deficient → focus-area OFFER, never automatic (framework §10.2). A whole-body
// test offers its habit instead (sit_rise → Floor sitting).
function mvTestOfferHtml(t, st, latest) {
  if (t.region === 'whole_body' && !t.offersHabit) return '';
  if (t.offersHabit) return mvTestHabitOfferHtml(t, st, latest);
  const label = mvRegion(t.region).label;
  if (st.offer === 'added') return '<div class="mv-levelup">' + mvEsc(label) + ' added as a focus area.</div>';
  if (mvFocusArea(t.region)) return '<div class="card-sub" style="margin:6px 0">' + mvEsc(label) + ' is already a focus area — this test comes back every 4 weeks.</div>';
  if (st.offer === 'declined' || MV.screenUi.declined[t.key + '|' + latest.date]) {
    return '<div class="card-sub" style="margin:6px 0">Okay — not added. It\'ll come up again at the next check-up.</div>';
  }
  const mob = mvPlan('mobility');
  const note = !mob ? ' This turns mobility on with focus areas.' : mob.mode !== 'targeted' ? ' This switches mobility from General flow to focus areas.' : '';
  return '<div class="mv-offer"><div>Make <b>' + mvEsc(label) + '</b> a focus area?' + (note ? ' <span class="mv-muted">' + note + '</span>' : '') + '</div>'
    + '<div class="triage-chips" style="margin-top:8px">'
    + '<button class="triage-chip" onclick="mvTestOfferAccept(\'daily\')">Daily</button>'
    + '<button class="triage-chip" onclick="mvTestOfferAccept(\'rotating\')">Rotating</button>'
    + '<button class="triage-chip" onclick="mvTestOfferDecline()">No thanks</button></div></div>';
}
async function mvTestOfferAccept(priority) {
  const t = mvTest(MV.test.key);
  const r = t.region;
  if (mvCount(priority) >= MV_CAPS[priority]) {
    toast('You already have ' + MV_CAPS[priority] + ' ' + priority + ' areas — remove or switch one first', 3500);
    return;
  }
  const mob = mvPlan('mobility');
  if (!mob) mvSavePlan('mobility', { mode: 'targeted' }, true);
  else if (mob.mode !== 'targeted') mvSavePlan('mobility', { mode: 'targeted' });
  const cur = MV.areas.filter(function (a) { return a.region === r; })[0];
  const ok = await mvWriteArea(r, { priority: priority, level: 1, started_on: mvToday(), is_active: true,
    drill_mobility: null, drill_control: null, source: cur ? cur.source : 'athlete' });
  if (!ok) return;
  MV.test.offer = 'added';
  toast(mvRegion(r).label + ' added as a ' + priority + ' focus area');
  mvRenderTest();
  mvPaintCard();
}
function mvTestHabitOfferHtml(t, st, latest) {
  const hb = mvHabit(t.offersHabit);
  const label = hb.label;
  if (st.offer === 'added') return '<div class="mv-levelup">' + mvEsc(label) + ' is on — see your Today card.</div>';
  if (mvPlan(hb.key)) return '<div class="card-sub" style="margin:6px 0">' + mvEsc(label) + ' is on — this test comes back every 4 weeks while the score is under the line.</div>';
  if (st.offer === 'declined' || MV.screenUi.declined[t.key + '|' + latest.date]) {
    return '<div class="card-sub" style="margin:6px 0">Okay — not turned on. It\'ll come up again at the next check-up.</div>';
  }
  return '<div class="mv-offer"><div>Turn on <b>' + mvEsc(label) + '</b>? <span class="mv-muted">'
    + mvEsc(hb.description || '') + ' Starts at ' + mvPlanDefaults(hb.key).minutes + ' min a day — you can change anything after.</span></div>'
    + '<div class="triage-chips" style="margin-top:8px">'
    + '<button class="triage-chip" onclick="mvTestHabitAccept()">Turn on</button>'
    + '<button class="triage-chip" onclick="mvTestOfferDecline()">No thanks</button></div></div>';
}
function mvTestHabitAccept() {
  const t = mvTest(MV.test.key);
  if (!t || !t.offersHabit) return;
  if (!mvPlan(t.offersHabit)) mvSavePlan(t.offersHabit, {}, true);
  MV.test.offer = 'added';
  toast(mvHabit(t.offersHabit).label + ' on');
  mvRenderTest();
  mvPaintCard();
}
function mvTestOfferDecline() {
  const t = mvTest(MV.test.key);
  const latest = mvScreenLatest(MV.screens, t);
  if (latest) MV.screenUi.declined[t.key + '|' + latest.date] = true;
  mvSaveScreenUi();
  MV.test.offer = 'declined';
  mvRenderTest();
}
function mvTestPain() {
  const t = mvTest(MV.test.key);
  openMvTests();
  const r = mvRegion(t.region);
  mvOpenPainFor(r.loads ? null : r.pain[0]);      // whole-body test: no preselected region
}
async function mvTestOptOut(key, out) {
  const ok = await mvSetOptOut(key, out);
  if (!ok) return;
  toast(out ? 'Okay — we won\'t suggest this test. You can still take it here.' : 'This test is back on');
  mvRenderTest();
  mvPaintCard();
}

// ── Phone tilt meter v2: guided run (Plan §5.2). The typed number always works too. ──
// One Start covers every number side (left, then right). The run engine (mvTiltRun)
// decides; this part only feeds it sensor samples, speaks, and paints. While a run is
// active a full-screen guard (#mv-tilt-guard) covers the app: only a 1 s press on
// "Hold to stop" does anything, so a sock or a forearm can't tap a button.
// State: MV.test.tilt = { phase: 'intro'|'check'|'run'|'done', sides, idx, results, run, … }.
function mvTiltCfgFor(t) { return t.tiltCfg ? Object.assign({ realChange: t.mdc }, t.tiltCfg) : null; }
function mvTiltSidesOf(t) { return mvScreenSides(t).filter(function (s) { return mvSideTakesNumber(t, s); }); }
function mvSpeakOn() { return MV.screenUi.speak !== false; }
MV.tiltSaid = MV.tiltSaid || [];        // everything spoken this visit (shown on screen; read by the smoke test)
function mvSay(text) {
  if (!text) return;
  MV.tiltSaid.push(text);
  const el = document.getElementById('mv-guard-say');
  if (el) el.textContent = text;
  if (!mvSpeakOn()) return;
  try {
    const ss = window.speechSynthesis;
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return;
    ss.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1; u.lang = 'en-US';
    ss.speak(u);
  } catch (_) {}
}
function mvSetSpeak(on) {
  MV.screenUi.speak = !!on;
  mvSaveScreenUi();
  if (MV.test) mvRenderTest(); else if (mvStActive()) mvRenderTestList();
}
function mvSpeakToggleHtml() {
  const on = mvSpeakOn();
  return '<div class="triage-chips mv-speak-chips"><span class="mv-muted" style="align-self:center">Spoken prompts</span>'
    + '<button class="triage-chip' + (on ? ' active' : '') + '" onclick="mvSetSpeak(true)">On</button>'
    + '<button class="triage-chip' + (!on ? ' active' : '') + '" onclick="mvSetSpeak(false)">Off</button></div>';
}

// sides: null = every number side; ['L'] = redo one side.
function mvTiltOpen(sides) {
  const t = mvTest(MV.test.key);
  if (!t || !t.tiltCfg) return;
  const list = sides || mvTiltSidesOf(t);
  const prev = MV.test.tilt && MV.test.tilt.results;
  MV.test.tilt = { phase: 'intro', sides: list, idx: 0, results: Object.assign({}, prev || {}), run: null, err: null, live: null };
  if (!MV.screenUi.tiltChecked) { mvTiltCheckOpen(true); return; }
  mvRenderTest();
}
function mvTiltHtml(t, tl) {
  if (tl.phase === 'check') return mvTiltCheckHtml(tl.check);
  let h = '<div class="mv-tilt">';
  const cfg = t.tiltCfg;
  if (tl.err) {
    return h + '<div class="mv-paused">' + mvEsc(tl.err) + '</div>'
      + (tl.retry ? '<button class="btn" onclick="mvTiltOpen(MV.test.tilt.sides)">Try again</button>' : '')
      + '<button class="btn secondary" onclick="mvTiltCancel()">Type a number instead</button></div>';
  }
  const sideTxt = tl.sides.map(function (s) { return (mvSideName(t, s) || 'reading').toLowerCase(); }).join(', then ');
  if (tl.phase === 'intro') {
    return h + '<div class="mv-tilt-title">📐 Measure with phone</div>'
      + '<div class="mv-tilt-place"><b>Phone:</b> ' + mvEsc(cfg.placement) + ' Long edge in line with the body part, screen facing out.</div>'
      + '<ol class="mv-test-steps">'
      + '<li>Tap Start, put the phone in place and get into the start position.</li>'
      + '<li>Wait for <b>“Ready. Go.”</b> — it waits for you, nothing is timed.</li>'
      + (cfg.capture === 'reach'
        ? '<li>Move slowly to your end range and hold a second, or just come back. ' + (cfg.tries > 1 ? 'Then once more.' : '') + '</li>'
        : '<li>Stay still until you hear the reading.</li>')
      + (tl.sides.length > 1 ? '<li>It tells you when to move the phone to the other side.</li>' : '')
      + '</ol><div class="mv-muted" style="margin-bottom:8px">Sides: ' + mvEsc(sideTxt) + '. Press and hold the bar for 1 second to stop.</div>'
      + mvSpeakToggleHtml()
      + '<button class="btn" id="mv-tilt-start" onclick="mvTiltStart()">Start</button>'
      + '<button class="btn secondary" onclick="mvTiltCancel()">Type a number instead</button>'
      + '<div class="mv-test-optout"><a class="mv-link" onclick="mvTiltCheckOpen(false)">📐 Tilt check</a></div></div>';
  }
  if (tl.phase === 'done') {
    h += '<div class="mv-tilt-title">✓ Readings in</div>';
    mvTiltSidesOf(t).forEach(function (s) {
      const r = tl.results[s];
      if (!r) return;
      const nm = mvSideName(t, s);
      h += '<div class="mv-tilt-side-res" data-side="' + s + '"><b>' + mvEsc(nm || 'Reading') + ': <span class="mv-tilt-result">' + r.value + '°</span></b>'
        + (r.trials && r.trials.length > 1 ? ' <span class="mv-muted">(tries ' + r.trials.map(Math.round).join(', ') + ')</span>' : '')
        + ' <button class="mv-mini" onclick="mvTiltOpen([\'' + s + '\'])">Redo ' + mvEsc((nm || '').toLowerCase()) + '</button></div>';
    });
    return h + '<div class="mv-tilt-msg">Saved to the fields. Tap Done, check them, then Save the test.</div>'
      + '<div class="mv-tilt-diag">' + mvEsc(tl.diag || '') + '</div>'
      + '<button class="btn" id="mv-tilt-done" onclick="mvTiltDone()">Done</button></div>';
  }
  // run: the sheet stays behind the guard
  return h + '<div class="mv-tilt-msg">Measuring…</div></div>';
}

async function mvTiltStart() {
  const tl = MV.test && MV.test.tilt;
  if (!tl) return;
  // All inside the tap: iOS needs the permission request, audio and speech unlocked from a gesture.
  let perm = null;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') perm = DeviceMotionEvent.requestPermission();
  } catch (e) { perm = Promise.reject(e); }
  try { ensureAudio(); } catch (_) {}
  try { if (window.speechSynthesis && mvSpeakOn()) window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (_) {}
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (l) { MV.wakeLock = l; }).catch(function () {});
    }
  } catch (_) {}
  if (perm) {
    try {
      const p = await perm;
      if (p !== 'granted') { tl.err = 'Motion access was declined. Type the number instead (you can allow motion access in your phone settings).'; mvRenderTest(); return; }
    } catch (e) { tl.err = 'Couldn\'t get motion access. Type the number instead.'; mvRenderTest(); return; }
  }
  tl.phase = 'run'; tl.idx = 0; tl.n = 0; tl.tm = Date.now(); tl.g = null; tl.lastT = null;
  MV.tiltSaid = [];
  mvTiltBeginSide(Date.now());
  window.addEventListener('devicemotion', mvTiltOnMotion);
  MV.tiltListening = true;
  tl.timer = setTimeout(function () {
    if (MV.test && MV.test.tilt === tl && !tl.g) {
      mvTiltStop();
      tl.phase = 'intro';
      tl.err = 'No motion sensor reading on this device. Type the number instead.';
      mvRenderTest();
    }
  }, 2500);
  mvRenderTest();
  mvGuardShow();
}
function mvTiltBeginSide(now) {
  const tl = MV.test.tilt;
  tl.side = tl.sides[tl.idx];
  tl.run = mvTiltSide(mvTiltCfgFor(mvTest(MV.test.key)), now);
  tl.switching = null; tl.live = null;
  tl.msg = 'Put the phone in place and get into the start position.';
}
function mvTiltOnMotion(e) {
  const tl = MV.test && MV.test.tilt;
  if (!tl || tl.phase !== 'run') { mvTiltStop(); return; }
  const a = e && e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  const now = Date.now();
  const s = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
  if (!isFinite(s.x) || !isFinite(s.y) || !isFinite(s.z)) return;
  tl.n = (tl.n || 0) + 1;
  // Low-pass with a fixed 150 ms time constant, whatever the sensor's event rate.
  const dt = tl.lastT ? Math.min(250, Math.max(1, now - tl.lastT)) : 16;
  tl.lastT = now;
  const k = 1 - Math.exp(-dt / 150);
  tl.g = tl.g ? { x: tl.g.x + (s.x - tl.g.x) * k, y: tl.g.y + (s.y - tl.g.y) * k, z: tl.g.z + (s.z - tl.g.z) * k } : s;
  if (tl.switching) {
    // Between sides: a reach try is often captured on the way down, so first let the
    // phone settle (still 0.8 s), then wait for it to be picked up and moved. If the
    // athlete moves straight on, the next side simply starts at its own gate.
    const sw = tl.switching;
    sw.samples.push({ t: now, x: s.x, y: s.y, z: s.z });
    while (sw.samples.length && now - sw.samples[0].t > MV_TILT_KEEP_MS) sw.samples.shift();
    if (!sw.ref) sw.ref = mvTiltStill(sw.samples, now, 800);
    else if (now - sw.t0 >= 1500 && mvTiltMoved(sw.ref, s)) { tl.idx++; mvTiltBeginSide(now); }
    mvGuardPaint(now);
    return;
  }
  const t = mvTest(MV.test.key);
  const ev = mvTiltRun(tl.run, now, tl.g, mvTiltCfgFor(t));
  ev.forEach(function (x) { mvTiltEvent(t, tl, x, now); });
  mvGuardPaint(now);
}
function mvTiltEvent(t, tl, x, now) {
  if (x.type === 'value') { tl.live = x.value; return; }
  if (x.type === 'beep') { try { beep(x.n); } catch (_) {} try { if (navigator.vibrate) navigator.vibrate(x.n > 1 ? [120, 80, 120] : 80); } catch (_) {} return; }
  if (x.type === 'say') { tl.msg = x.text; mvSay(x.text); return; }
  if (x.type === 'hint') { tl.msg = x.text; return; }
  if (x.type === 'phase' && x.phase === 'ready') { tl.msg = 'Ready. Go.'; return; }
  if (x.type === 'try') { tl.live = x.value; return; }
  if (x.type === 'off') { tl.msg = MV_TILT_OFF_SAY; return; }
  if (x.type === 'timeout') {
    mvTiltStop();
    tl.phase = 'intro'; tl.retry = true;
    tl.err = 'I couldn\'t get a reading in 2 minutes. Check the phone placement and try again, or type the number.';
    mvRenderTest();
    return;
  }
  if (x.type === 'done') {
    tl.results[tl.side] = { value: x.value, trials: x.tries };
    MV.test.sides[tl.side].value = String(x.value);        // straight into the field
    MV.test.sides[tl.side].tilt = { value: String(x.value), trials: x.tries };
    const last = tl.idx >= tl.sides.length - 1;
    mvSay(mvTiltSideSay(t.sides === 'B' ? null : tl.side, x.value) + (last ? '' : ' ' + mvTiltMoveSay(tl.sides[tl.idx + 1])));
    tl.msg = MV.tiltSaid[MV.tiltSaid.length - 1];
    if (!last) { tl.switching = { t0: now, ref: null, samples: [] }; tl.live = null; return; }
    tl.diag = mvTiltDiag(t, tl, now);
    mvTiltStop();
    tl.phase = 'done';
    mvRenderTest();
  }
}
// "That reading looks off" — the athlete decides (the only buttons on the guard besides stop).
function mvTiltOffUse() {
  const tl = MV.test && MV.test.tilt;
  if (!tl || !tl.run || tl.run.phase !== 'off') return;
  const now = Date.now(), t = mvTest(MV.test.key);
  mvTiltOffAccept(tl.run, now, mvTiltCfgFor(t)).forEach(function (x) { mvTiltEvent(t, tl, x, now); });
  mvGuardPaint(now);
}
function mvTiltOffRetry() {
  const tl = MV.test && MV.test.tilt;
  if (!tl || !tl.run || tl.run.phase !== 'off') return;
  mvTiltRearm(tl.run, Date.now());
  tl.msg = 'Okay — get back to the start position.';
  mvGuardPaint(Date.now());
}
function mvTiltDiag(t, tl, now) {
  const secs = Math.max(0.001, (now - (tl.tm || now)) / 1000);
  const r = tl.run || {};
  const E = mvTiltE(tl.g);
  return MV_TILT_VERSION + ' · ' + t.tiltCfg.mode + '/' + t.tiltCfg.gate + ' · ' + Math.round((tl.n || 0) / secs) + ' Hz · '
    + (tl.switching ? 'switch' : r.phase) + ' · tries ' + ((r.tries || []).map(Math.round).join('/') || '–')
    + ' · |E| ' + (E == null ? '–' : Math.round(Math.abs(E))) + (r.track && r.track.how ? ' · via ' + r.track.how : '');
}

// Screen guard
function mvGuardShow() {
  let g = document.getElementById('mv-tilt-guard');
  if (!g) {
    g = document.createElement('div');
    g.id = 'mv-tilt-guard';
    g.className = 'mv-guard';
    document.body.appendChild(g);
  }
  g.innerHTML = '<div class="mv-guard-side" id="mv-guard-side"></div>'
    + '<div class="mv-guard-live" id="mv-guard-live">—</div>'
    + '<div class="mv-guard-say" id="mv-guard-say"></div>'
    + '<div class="mv-guard-off" id="mv-guard-off"></div>'
    + '<div class="mv-tilt-diag" id="mv-guard-diag"></div>'
    + '<div class="mv-guard-stop" id="mv-guard-stop"><div class="mv-guard-fill" id="mv-guard-fill"></div><span>Hold to stop</span></div>';
  g.classList.add('open');
  const stop = document.getElementById('mv-guard-stop');
  const down = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    stop.classList.add('holding');
    MV.guardHold = setTimeout(function () { stop.classList.remove('holding'); mvTiltCancel(); }, 1000);
  };
  const up = function () { stop.classList.remove('holding'); if (MV.guardHold) { clearTimeout(MV.guardHold); MV.guardHold = null; } };
  stop.addEventListener('pointerdown', down);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (n) { stop.addEventListener(n, up); });
  mvGuardPaint(Date.now());
}
function mvGuardHide() {
  const g = document.getElementById('mv-tilt-guard');
  if (g) { g.classList.remove('open'); g.innerHTML = ''; }
  if (MV.guardHold) { clearTimeout(MV.guardHold); MV.guardHold = null; }
}
function mvGuardPaint(now) {
  const tl = MV.test && MV.test.tilt;
  if (!tl || tl.phase !== 'run' || !document.getElementById('mv-guard-side')) return;
  const t = mvTest(MV.test.key);
  const nm = mvSideName(t, tl.side);
  const part = /forearm/i.test(t.tiltCfg.placement) ? 'arm' : /breastbone|chest/i.test(t.tiltCfg.placement) ? 'side' : 'leg';
  document.getElementById('mv-guard-side').textContent = nm ? nm.toUpperCase() + ' ' + (nm === 'Both arms together' ? '' : part.toUpperCase()) : t.name;
  document.getElementById('mv-guard-live').textContent = tl.live != null ? Math.round(tl.live) + '°' : '—';
  document.getElementById('mv-guard-say').textContent = tl.msg || '';
  const off = document.getElementById('mv-guard-off');
  const isOff = tl.run && tl.run.phase === 'off';
  if (isOff && !off.dataset.v) {
    off.dataset.v = '1';
    off.innerHTML = '<button class="btn secondary" id="mv-off-use" onclick="mvTiltOffUse()" disabled>Use ' + tl.run.offValue + '° anyway</button>'
      + '<button class="btn" id="mv-off-retry" onclick="mvTiltOffRetry()" disabled>Try again</button>';
    setTimeout(function () { off.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); }, 900);
  } else if (!isOff && off.dataset.v) { off.innerHTML = ''; delete off.dataset.v; }
  document.getElementById('mv-guard-diag').textContent = mvTiltDiag(t, tl, now);
}

// "Done" on the result: back to the form, the numbers are already in their fields.
function mvTiltDone() {
  if (!MV.test) return;
  MV.test.tilt = null;
  mvRenderTest();
}
function mvTiltStop() {
  if (MV.tiltListening) { window.removeEventListener('devicemotion', mvTiltOnMotion); MV.tiltListening = false; }
  if (MV.tiltCheckListening) { window.removeEventListener('devicemotion', mvTiltCheckOnMotion); MV.tiltCheckListening = false; }
  const tl = MV.test && MV.test.tilt;
  if (tl && tl.timer) { clearTimeout(tl.timer); tl.timer = null; }
  if (MV.wakeLock) { try { MV.wakeLock.release(); } catch (_) {} MV.wakeLock = null; }
  mvGuardHide();
}
// Stop / Cancel: sides already finished keep their numbers in the fields.
function mvTiltCancel() {
  mvTiltStop();
  if (MV.test) MV.test.tilt = null;
  if (MV.test) mvRenderTest(); else mvRenderTestList();
}

// ── Tilt check (Plan §5.2): first phone test on a device, then a live readout ──
// first = true: part of opening a test's phone run (continues to it afterwards).
function mvTiltCheckOpen(first) {
  const ck = { step: first ? 'start' : 'live-start', first: !!first, flat: null, wall: null, live: null, samples: [], g: null };
  if (MV.test) {
    if (!MV.test.tilt) MV.test.tilt = { phase: 'intro', sides: mvTiltSidesOf(mvTest(MV.test.key)), idx: 0, results: {}, run: null };
    MV.test.tilt.back = MV.test.tilt.phase;
    MV.test.tilt.phase = 'check';
    MV.test.tilt.check = ck;
    mvRenderTest();
  } else {
    MV.tiltCheck = ck;
    if (!mvStActive()) showScreen('selftests');
    mvStHeader('📐 Tilt check', 'Live angle of the phone\'s long edge');
    mvStBody().innerHTML = mvTiltCheckHtml(ck);
  }
}
function mvTiltCheckCur() { return (MV.test && MV.test.tilt && MV.test.tilt.phase === 'check') ? MV.test.tilt.check : MV.tiltCheck; }
function mvTiltCheckPaint() {
  const ck = mvTiltCheckCur();
  if (!ck) return;
  const box = document.getElementById('mv-tiltcheck');
  if (box) box.outerHTML = mvTiltCheckHtml(ck);
}
function mvTiltCheckHtml(ck) {
  let h = '<div class="mv-tilt" id="mv-tiltcheck">';
  if (ck.err) return h + '<div class="mv-paused">' + mvEsc(ck.err) + '</div><button class="btn secondary" onclick="mvTiltCheckClose()">Close</button></div>';
  if (ck.step === 'start' || ck.step === 'live-start') {
    return h + '<div class="mv-tilt-title">📐 Tilt check</div>'
      + '<div class="mv-muted" style="margin-bottom:8px">' + (ck.step === 'start'
        ? 'First time on this phone: 20 seconds to prove the sensor works and show what “long edge” means.'
        : 'A live readout of the phone\'s long-edge angle. Check it against a level or a known angle.') + '</div>'
      + '<button class="btn" id="mv-check-start" onclick="mvTiltCheckStart()">Start</button>'
      + '<button class="btn secondary" onclick="mvTiltCheckClose()">' + (ck.first ? 'Skip' : 'Close') + '</button></div>';
  }
  const live = ck.live != null ? Math.round(ck.live) + '°' : '—';
  if (ck.step === 'live') {
    return h + '<div class="mv-tilt-title">Long edge</div><div class="mv-tilt-live" id="mv-check-live">' + live + '</div>'
      + '<div class="mv-tilt-msg">0° = lying flat · 90° = standing on its short edge</div>'
      + '<button class="btn secondary" onclick="mvTiltCheckClose()">Close</button></div>';
  }
  const res = function (v, want) {
    return v == null ? '' : '<div class="' + (mvTiltCheckOk(want, v) ? 'mv-levelup' : 'mv-paused') + '">'
      + (want === 'flat' ? 'Flat: ' : 'On its edge: ') + Math.round(v) + '° ' + (mvTiltCheckOk(want, v) ? '✓' : '— expected ' + (want === 'flat' ? '0°' : '90°') + ' ± 3') + '</div>';
  };
  if (ck.step === 'flat' || ck.step === 'wall') {
    return h + '<div class="mv-tilt-title">' + (ck.step === 'flat' ? '1. Lay the phone flat on the floor.' : '2. Stand it on its short edge against a wall.') + '</div>'
      + '<div class="mv-tilt-live" id="mv-check-live">' + live + '</div>'
      + '<div class="mv-tilt-msg">Hold still — it reads by itself.</div>' + res(ck.flat, 'flat')
      + '<button class="btn secondary" onclick="mvTiltCheckClose()">' + (ck.first ? 'Skip' : 'Close') + '</button></div>';
  }
  // done
  const good = mvTiltCheckOk('flat', ck.flat) && mvTiltCheckOk('wall', ck.wall);
  return h + '<div class="mv-tilt-title">' + (good ? '✓ Tilt check passed' : 'Tilt check done') + '</div>' + res(ck.flat, 'flat') + res(ck.wall, 'wall')
    + (good ? '' : '<div class="mv-muted" style="margin:6px 0">Readings on this phone may be off by about that much. Typing a number always works.</div>')
    + '<button class="btn" id="mv-check-done" onclick="mvTiltCheckClose(true)">' + (ck.first ? 'Continue' : 'Done') + '</button></div>';
}
async function mvTiltCheckStart() {
  const ck = mvTiltCheckCur();
  if (!ck) return;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const p = await DeviceMotionEvent.requestPermission();
      if (p !== 'granted') { ck.err = 'Motion access was declined. You can allow it in your phone settings; typing a number always works.'; mvTiltCheckPaint(); return; }
    }
  } catch (e) { ck.err = 'Couldn\'t get motion access.'; mvTiltCheckPaint(); return; }
  ck.step = ck.step === 'live-start' ? 'live' : 'flat';
  ck.samples = [];
  window.addEventListener('devicemotion', mvTiltCheckOnMotion);
  MV.tiltCheckListening = true;
  mvTiltCheckPaint();
}
function mvTiltCheckOnMotion(e) {
  const ck = mvTiltCheckCur();
  if (!ck) { mvTiltStop(); return; }
  const a = e && e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const now = Date.now();
  const s = { t: now, x: Number(a.x), y: Number(a.y), z: Number(a.z) };
  ck.g = ck.g ? { x: ck.g.x + (s.x - ck.g.x) * 0.3, y: ck.g.y + (s.y - ck.g.y) * 0.3, z: ck.g.z + (s.z - ck.g.z) * 0.3 } : s;
  const E = mvTiltE(ck.g);
  ck.live = E == null ? null : Math.abs(E);
  const el = document.getElementById('mv-check-live');
  if (el) el.textContent = ck.live != null ? Math.round(ck.live) + '°' : '—';
  if (ck.step !== 'flat' && ck.step !== 'wall') return;
  ck.samples.push(s);
  while (ck.samples.length && now - ck.samples[0].t > MV_TILT_KEEP_MS) ck.samples.shift();
  const m = mvTiltStill(ck.samples, now, MV_TILT_GATE_MS);
  if (!m) return;
  const v = Math.abs(mvTiltE(m));
  // Flat step takes any still reading under 45°; the wall step any still reading over 45°
  // (so setting the phone down flat doesn't count as the wall reading).
  if (ck.step === 'flat' && v < 45) { ck.flat = v; ck.step = 'wall'; ck.samples = []; try { beep(1); } catch (_) {} mvTiltCheckPaint(); }
  else if (ck.step === 'wall' && v >= 45) {
    ck.wall = v; ck.step = 'done';
    window.removeEventListener('devicemotion', mvTiltCheckOnMotion); MV.tiltCheckListening = false;
    try { beep(2); } catch (_) {}
    mvTiltCheckPaint();
  }
}
function mvTiltCheckClose(finished) {
  const ck = mvTiltCheckCur();
  if (MV.tiltCheckListening) { window.removeEventListener('devicemotion', mvTiltCheckOnMotion); MV.tiltCheckListening = false; }
  if (ck && ck.first) {
    MV.screenUi.tiltChecked = { date: mvToday(), flat: ck.flat == null ? null : Math.round(ck.flat * 10) / 10,
      wall: ck.wall == null ? null : Math.round(ck.wall * 10) / 10, skipped: !finished };
    mvSaveScreenUi();
  }
  if (MV.test && MV.test.tilt && MV.test.tilt.phase === 'check') {
    MV.test.tilt.phase = MV.test.tilt.back === 'check' ? 'intro' : (MV.test.tilt.back || 'intro');
    MV.test.tilt.check = null;
    mvRenderTest();
  } else {
    MV.tiltCheck = null;
    if (MV.test) mvRenderTest(); else mvRenderTestList();
  }
}

// ── Trends: one line per test per side, next to compliance ──
function mvScreenTrendsHtml() {
  const u = MV.screenUi.unit;
  // Current-version results only (Plan §7.4); an older method's results are left off the line.
  const tests = MV.tests.filter(function (t) { return mvScreenRows(MV.screens, t).some(function (r) { return !r.pain_flag; }); });
  const older = MV.tests.filter(function (t) { return mvScreenOldRows(MV.screens, t).some(function (r) { return !r.pain_flag; }); });
  if (!tests.length && !older.length) return '';
  let h = '<div class="trends-chart-title" style="margin-top:10px">📏 Self-tests</div>';
  tests.forEach(function (t) {
    const sum = mvScreenSummary(t, MV.screens);
    mvScreenSides(t).forEach(function (s) {
      const tr = mvScreenTrend(MV.screens, t, s).slice(-12);
      if (!tr.length) return;
      const nm = mvSideName(t, s);
      const title = mvEsc(t.name) + (nm ? ' — ' + nm.toLowerCase() : '');
      const labels = tr.map(function (x) { const p = x.date.split('-'); return (+p[1]) + '/' + (+p[2]); });
      const ch = sum[s] && sum[s].sinceBaseline;
      let foot = '';
      if (ch) {
        const d = ch.delta != null && mvSideTakesNumber(t, s) ? mvFmtScreenValue(t, ch.delta, u, true)
          : (ch.flip ? (ch.direction === 'better' ? 'now passes' : 'no longer passes') : 'no change');
        foot = '<div class="mv-muted" style="margin-top:2px">Since first test: ' + mvEsc(d) + (ch.real ? ' · real change' : ' · within normal wobble') + '</div>';
      }
      const nums = tr.filter(function (x) { return x.value != null; });
      if (mvSideTakesNumber(t, s) && nums.length === 1) {
        h += '<div class="trends-chart-box mv-screen-chart" data-test="' + t.key + '-' + s + '"><div class="trends-chart-title">' + title + '</div>'
          + '<div class="mv-muted">First result ' + mvShortDate(nums[0].date) + ': <b>' + mvEsc(mvFmtScreenValue(t, nums[0].value, u)) + '</b> — the line starts after your next test.</div></div>';
      } else if (mvSideTakesNumber(t, s) && nums.length) {
        const pts = tr.map(function (x) { return x.value == null ? null : mvScreenDisp(t, x.value, u); });
        h += '<div class="trends-chart-box mv-screen-chart" data-test="' + t.key + '-' + s + '"><div class="trends-chart-title">' + title
          + ' <span class="mv-muted">(' + mvScreenUnitLabel(t, u) + ')</span></div>'
          + trendsLineChart(pts, labels, { height: 100, decimals: t.unit === 'cm' && u !== 'cm' ? 2 : t.unit === 'deg' ? 0 : 1 }) + foot + '</div>';
      } else {
        h += '<div class="trends-chart-box mv-screen-chart" data-test="' + t.key + '-' + s + '"><div class="trends-chart-title">' + title + '</div><div class="mv-screen-dots">'
          + tr.map(function (x, i) {
            return '<span class="mv-screen-dot"><span class="mv-sym ' + (x.passed ? 'mv-sym-done' : 'mv-sym-missed') + '">' + (x.passed ? '●' : '○') + '</span>'
              + '<span class="mv-grid-lbl">' + labels[i] + '</span></span>';
          }).join('') + '</div>' + foot + '</div>';
      }
    });
  });
  if (older.length) h += '<div class="mv-muted mv-old-note">Earlier method not shown: ' + older.map(function (t) { return mvEsc(t.name); }).join(', ') + '.</div>';
  return h;
}

// Check-in add-on: real changes from tests taken this week ("Shoulder flexion, lying down L +8°").
function mvCheckinScreensText() {
  const mon = mvMonday(mvToday());
  const u = MV.screenUi.unit;
  const parts = [];
  MV.tests.forEach(function (t) {
    const sum = mvScreenSummary(t, MV.screens);
    const hit = mvScreenSides(t).filter(function (s) {
      const x = sum[s];
      return x && x.latest.date >= mon && x.sinceLast && x.sinceLast.real;
    })[0];
    if (!hit) return;
    const ch = sum[hit].sinceLast;
    const d = ch.delta != null && mvSideTakesNumber(t, hit) ? mvFmtScreenValue(t, ch.delta, u, true)
      : (ch.direction === 'better' ? 'now passes' : 'no longer passes');
    parts.push(t.name + (t.sides === 'B' ? '' : ' ' + hit) + ' ' + d);
  });
  return parts.slice(0, 2).join(' · ');
}
