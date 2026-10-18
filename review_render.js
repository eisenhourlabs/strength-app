/* review_render.js — Weekly Review renderer (coach view)
 *
 * One layout, two data sources:
 *   1. 05_Scripts/build_week_review.py pulls the raw rows from Supabase and
 *      writes 05_Weekly_Outputs/Week_Review_<Monday>.html with this file and
 *      the data inlined (static snapshot, opens offline).
 *   2. (Phase 2) a coach-only app page fetches the same raw rows live and
 *      calls the same functions.
 *
 * Public API:
 *   WeekReview.assemble(raw)        -> model (pairs sessions + exercises)
 *   WeekReview.render(model)        -> HTML string
 *   WeekReview.mount(raw, element)  -> assemble + render into element
 *   WeekReview.CSS                  -> stylesheet string
 *
 * raw = { week_of, last_week_of, generated_at, exercise_names: {id: name},
 *         athletes: [{ id, name, cycles, planned_sessions, planned_exercises,
 *                      planned_conditioning_blocks, completed_sessions,
 *                      completed_strength_sets, completed_conditioning,
 *                      decision_log, coach_notes, readiness_logs }] }
 * Rows are plain Supabase rows (column names as in the live schema).
 * planned_sessions holds BOTH weeks; a session belongs to the week whose
 * Monday is mondayOf(session.week_of).
 * No dependencies. Plain ES5 so it runs anywhere.
 */
(function (root) {
  'use strict';

  var DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  var DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ── small helpers ─────────────────────────────────────────────────────────
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function isNum(n) { return n !== null && n !== undefined && n !== '' && !isNaN(parseFloat(n)); }
  function num(n) {
    if (!isNum(n)) return n === null || n === undefined ? '' : String(n);
    return (Math.round(parseFloat(n) * 10) / 10).toString();
  }
  function dayIndex(label) {
    var i = DAYS.indexOf(String(label || '').toLowerCase().trim());
    return i < 0 ? 9 : i;
  }
  function dayShort(label) { var i = dayIndex(label); return i < 7 ? DAY_SHORT[i] : String(label || ''); }
  function byOrder(a, b) {
    return (a.item_order == null ? 999 : a.item_order) - (b.item_order == null ? 999 : b.item_order);
  }
  function sessSort(a, b) {
    var d = dayIndex(a.day_label) - dayIndex(b.day_label);
    if (d) return d;
    return (a.session_order || 0) - (b.session_order || 0);
  }
  function d10(x) { return String(x || '').slice(0, 10); }
  function weekdayOf(iso) {
    if (!iso) return null;
    var p = d10(iso).split('-');
    if (p.length < 3) return null;
    var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return (dt.getUTCDay() + 6) % 7; // Mon = 0
  }
  // Monday (ISO) of the week containing iso, as YYYY-MM-DD. Cycles the
  // athlete starts in the app can begin mid-week (week_of = start date).
  function mondayOf(iso) {
    var p = d10(iso).split('-');
    if (p.length < 3) return d10(iso);
    var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    return dt.toISOString().slice(0, 10);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var p = d10(iso).split('-');
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1];
    return m + ' ' + (+p[2]) + ', ' + p[0];
  }
  function rpeStr(lo, hi) {
    if (!isNum(lo) && !isNum(hi)) return '';
    if (!isNum(hi) || +hi === +lo) return 'RPE ' + num(isNum(lo) ? lo : hi);
    if (!isNum(lo)) return 'RPE ≤' + num(hi);
    return 'RPE ' + num(lo) + '–' + num(hi);
  }
  function groupBy(list, key) {
    var m = {};
    (list || []).forEach(function (r) { var k = r[key]; (m[k] = m[k] || []).push(r); });
    return m;
  }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; }
    return t;
  }
  function parseJson(v, dflt) {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return dflt; } }
    return v == null ? dflt : v;
  }

  // ── planned exercise text ─────────────────────────────────────────────────
  function setDetail(pe) {
    var sd = parseJson(pe && pe.set_detail, null);
    return (sd && sd.length) ? sd : null;
  }
  function topPlannedLoad(pe) {
    var sd = setDetail(pe);
    if (sd) {
      var mx = null;
      sd.forEach(function (s) { if (isNum(s.load) && (mx === null || +s.load > mx)) mx = +s.load; });
      if (mx !== null) return mx;
    }
    return isNum(pe.target_load) ? +pe.target_load : null;
  }
  function plannedSets(pe) {
    var sd = setDetail(pe);
    return sd ? sd.length : (pe.target_sets || null);
  }
  function compress(tokens) {
    var out = [], i = 0;
    while (i < tokens.length) {
      var j = i;
      while (j + 1 < tokens.length && tokens[j + 1] === tokens[i]) j++;
      var n = j - i + 1;
      out.push(n > 1 ? n + ' × (' + tokens[i] + ')' : tokens[i]);
      i = j + 1;
    }
    return out.join(', ');
  }
  function planText(pe) {
    var sd = setDetail(pe);
    var parts = [];
    if (sd) {
      parts.push(compress(sd.map(function (s) {
        var v = (s.mt && s.mt !== 'reps') ? (num(s.value) + (s.mt === 'time' ? 's' : ' yd')) : num(s.reps);
        return isNum(s.load) && +s.load > 0 ? num(s.load) + '×' + v : v;
      })));
    } else {
      var reps = pe.reps_display || (isNum(pe.reps_low) ? (isNum(pe.reps_high) && +pe.reps_high !== +pe.reps_low ? pe.reps_low + '–' + pe.reps_high : String(pe.reps_low)) : '');
      var s = (pe.target_sets ? pe.target_sets + ' × ' : '') + reps;
      if (isNum(pe.target_load) && +pe.target_load > 0) s += ' @ ' + num(pe.target_load) + ' lb';
      parts.push(s);
    }
    var r = rpeStr(pe.rpe_low, pe.rpe_high);
    if (r) parts.push(r);
    if (pe.tempo) parts.push('tempo ' + pe.tempo);
    return parts.join(' · ');
  }

  // ── actual sets text + verdict ────────────────────────────────────────────
  function setToken(s) {
    var mt = s.measure_type || 'reps';
    var v = mt === 'reps' ? num(s.actual_reps)
      : (isNum(s.actual_value) ? num(s.actual_value) + (mt === 'time' ? 's' : ' yd') : '');
    var t = isNum(s.actual_load) && +s.actual_load > 0 ? num(s.actual_load) + '×' + (v || '?') : (v || '✓');
    if (isNum(s.actual_rpe)) t += ' @' + num(s.actual_rpe);
    return t;
  }
  function doneSets(sets) {
    return (sets || []).filter(function (s) { return !s.is_skipped; })
      .sort(function (a, b) { return (a.set_number || 0) - (b.set_number || 0); });
  }
  function actualText(sets) { return compress(doneSets(sets).map(setToken)); }
  function setNotes(sets) {
    var n = [];
    (sets || []).forEach(function (s) { if (s.notes && n.indexOf(s.notes) < 0) n.push(s.notes); });
    return n;
  }
  function combine(marks) {
    if (!marks.length) return { mark: '✓', cls: 'ok', text: '' };
    return { mark: marks.map(function (m) { return m.mark; }).join(''), cls: marks[0].cls,
             text: marks.map(function (m) { return m.text; }).filter(Boolean).join(' · ') };
  }
  function verdict(pe, sets, logged) {
    if (!logged) return { mark: '—', cls: 'na', text: '' };
    if (!sets || !sets.length) return { mark: '✗', cls: 'bad', text: 'not done' };
    var done = doneSets(sets);
    if (!done.length) return { mark: '✗', cls: 'bad', text: 'skipped' };
    var marks = [];
    var target = pe ? plannedSets(pe) : null;
    if (target && done.length < target) marks.push({ mark: '◐', cls: 'warn', text: done.length + '/' + target + ' sets' });
    else if (target && done.length > target) marks.push({ mark: '▲', cls: 'up', text: done.length + '/' + target + ' sets' });
    if (pe) {
      var tl = topPlannedLoad(pe);
      var ml = null;
      done.forEach(function (s) { if (isNum(s.actual_load) && (ml === null || +s.actual_load > ml)) ml = +s.actual_load; });
      if (tl && ml !== null) {
        if (ml > tl * 1.015) marks.push({ mark: '▲', cls: 'up', text: 'top ' + num(ml) + ' (+' + num(ml - tl) + ' lb)' });
        else if (ml < tl * 0.985) marks.push({ mark: '▼', cls: 'warn', text: 'top ' + num(ml) + ' (−' + num(tl - ml) + ' lb)' });
      }
      if (!setDetail(pe) && isNum(pe.reps_low)) {
        var short = done.filter(function (s) { return (s.measure_type || 'reps') === 'reps' && isNum(s.actual_reps) && +s.actual_reps < +pe.reps_low; }).length;
        if (short) marks.push({ mark: '▼', cls: 'warn', text: short + ' set' + (short > 1 ? 's' : '') + ' under ' + pe.reps_low + ' reps' });
      }
      var cap = isNum(pe.rpe_high) ? +pe.rpe_high : (isNum(pe.rpe_low) ? +pe.rpe_low : null);
      if (cap !== null) {
        var mr = null;
        done.forEach(function (s) { if (isNum(s.actual_rpe) && (mr === null || +s.actual_rpe > mr)) mr = +s.actual_rpe; });
        if (mr !== null && mr >= cap + 1) marks.push({ mark: '⚑', cls: 'warn', text: 'RPE ' + num(mr) + ' vs ' + num(cap) + ' cap' });
      }
    }
    return combine(marks);
  }

  // ── week-over-week change for planned exercises ───────────────────────────
  function change(lp, tp) {
    if (!lp && tp) return { mark: 'NEW', cls: 'info', text: '' };
    if (lp && !tp) return { mark: 'DROPPED', cls: 'info', text: '' };
    var parts = [], dir = 0;
    var swapped = lp.exercise_id !== tp.exercise_id;
    if (swapped) parts.push('was ' + (lp.exercise_name || '?'));
    var a = topPlannedLoad(lp), b = topPlannedLoad(tp);
    if (a !== null && b !== null && a !== b) { parts.push((b > a ? '+' : '−') + num(Math.abs(b - a)) + ' lb'); dir = b > a ? 1 : -1; }
    var sa = plannedSets(lp), sb = plannedSets(tp);
    if (sa && sb && sa !== sb) {
      var ds = Math.abs(sb - sa);
      parts.push((sb > sa ? '+' : '−') + ds + ' set' + (ds > 1 ? 's' : ''));
      dir = dir || (sb > sa ? 1 : -1);
    }
    var ra = lp.reps_display || String(lp.reps_low == null ? '' : lp.reps_low);
    var rb = tp.reps_display || String(tp.reps_low == null ? '' : tp.reps_low);
    if (!setDetail(lp) && !setDetail(tp) && ra !== rb) {
      parts.push('reps ' + (ra || '—') + '→' + (rb || '—'));
      if (!dir && isNum(lp.reps_low) && isNum(tp.reps_low) && +lp.reps_low !== +tp.reps_low && a === b) dir = +tp.reps_low > +lp.reps_low ? 1 : -1;
    }
    var pa = rpeStr(lp.rpe_low, lp.rpe_high), pb = rpeStr(tp.rpe_low, tp.rpe_high);
    if (pa !== pb && (pa || pb)) {
      parts.push((pa || 'no RPE') + ' → ' + (pb ? pb.replace('RPE ', '') : 'none'));
      var x = isNum(lp.rpe_high) ? +lp.rpe_high : (isNum(lp.rpe_low) ? +lp.rpe_low : null);
      var y = isNum(tp.rpe_high) ? +tp.rpe_high : (isNum(tp.rpe_low) ? +tp.rpe_low : null);
      if (!dir && x !== null && y !== null && x !== y) dir = y > x ? 1 : -1;
    }
    if ((lp.tempo || '') !== (tp.tempo || '')) parts.push('tempo ' + (tp.tempo || 'none'));
    if (swapped) return { mark: '⇄', cls: 'info', text: parts.join(' · ') };
    if (!parts.length) return { mark: '=', cls: 'hold', text: 'held' };
    return { mark: dir > 0 ? '▲' : (dir < 0 ? '▼' : '↕'), cls: dir > 0 ? 'up' : (dir < 0 ? 'down' : 'info'), text: parts.join(' · ') };
  }

  // ── conditioning text / verdict / change ──────────────────────────────────
  function hrBand(lo, hi) {
    if (lo && hi) return 'HR ' + lo + '–' + hi;
    if (hi) return 'HR ≤' + hi;
    if (lo) return 'HR ≥' + lo;
    return '';
  }
  function condPlanText(b) {
    var p = [];
    if (isNum(b.target_duration_min)) p.push(num(b.target_duration_min) + ' min');
    if (b.target_rounds && b.work_duration_sec) p.push(b.target_rounds + ' × ' + b.work_duration_sec + 's on / ' + (b.rest_duration_sec || 0) + 's off');
    else if (b.target_rounds) p.push(b.target_rounds + ' rounds');
    var hr = hrBand(b.target_hr_low, b.target_hr_high); if (hr) p.push(hr);
    if (b.intensity_domain) p.push(String(b.intensity_domain).replace(/_/g, ' '));
    return p.join(' · ');
  }
  function condActualText(c) {
    var p = [];
    if (isNum(c.duration_minutes)) p.push(num(c.duration_minutes) + ' min');
    if (isNum(c.distance_meters) && +c.distance_meters > 0) p.push((c.distance_meters / 1609.34).toFixed(2) + ' mi');
    if (c.intervals_completed) p.push(c.intervals_completed + ' rounds');
    if (isNum(c.load_lbs) && +c.load_lbs > 0) p.push(num(c.load_lbs) + ' lb');
    if (c.avg_heart_rate) p.push('avg HR ' + c.avg_heart_rate + (c.max_heart_rate ? ' (max ' + c.max_heart_rate + ')' : ''));
    if (isNum(c.rpe)) p.push('RPE ' + num(c.rpe));
    return p.join(' · ');
  }
  function condVerdict(b, c, skip, logged) {
    if (skip) return { mark: '✗', cls: 'bad', text: 'skipped' + (skip.reason ? ' — ' + skip.reason : '') };
    if (!c) return logged ? { mark: '✗', cls: 'bad', text: 'not done' } : { mark: '—', cls: 'na', text: '' };
    var m = [];
    if (b && isNum(b.target_duration_min) && isNum(c.duration_minutes)) {
      var t = +b.target_duration_min, d = +c.duration_minutes;
      if (d < t * 0.9) m.push({ mark: '▼', cls: 'warn', text: num(d) + ' of ' + num(t) + ' min' });
      else if (d > t * 1.1) m.push({ mark: '▲', cls: 'up', text: '+' + num(d - t) + ' min' });
    }
    if (b && (b.target_hr_low || b.target_hr_high)) {
      if (!c.avg_heart_rate) m.push({ mark: '·', cls: 'na', text: 'no HR logged' });
      else if (b.target_hr_high && c.avg_heart_rate > b.target_hr_high + 2) m.push({ mark: '⚑', cls: 'warn', text: 'HR above band' });
      else if (b.target_hr_low && c.avg_heart_rate < b.target_hr_low - 5) m.push({ mark: '⚑', cls: 'warn', text: 'HR below band' });
    }
    if (m.length === 1 && m[0].cls === 'na') return { mark: '✓', cls: 'ok', text: m[0].text };
    return combine(m);
  }
  function condChange(lb, tb) {
    if (!lb && tb) return { mark: 'NEW', cls: 'info', text: '' };
    if (lb && !tb) return { mark: 'DROPPED', cls: 'info', text: '' };
    var p = [], dir = 0;
    var swapped = (lb.modality || '') !== (tb.modality || '');
    if (swapped) p.push('was ' + (lb.modality || '?'));
    if (isNum(lb.target_duration_min) && isNum(tb.target_duration_min) && +lb.target_duration_min !== +tb.target_duration_min) {
      var dd = tb.target_duration_min - lb.target_duration_min;
      p.push((dd > 0 ? '+' : '−') + num(Math.abs(dd)) + ' min'); dir = dd > 0 ? 1 : -1;
    }
    if ((lb.target_rounds || 0) !== (tb.target_rounds || 0)) {
      p.push('rounds ' + (lb.target_rounds || 0) + '→' + (tb.target_rounds || 0));
      dir = dir || ((tb.target_rounds || 0) > (lb.target_rounds || 0) ? 1 : -1);
    }
    if ((lb.work_duration_sec || 0) !== (tb.work_duration_sec || 0)) p.push('work ' + (lb.work_duration_sec || 0) + '→' + (tb.work_duration_sec || 0) + 's');
    var ha = hrBand(lb.target_hr_low, lb.target_hr_high), hb = hrBand(tb.target_hr_low, tb.target_hr_high);
    if (ha !== hb) p.push((ha || 'no HR') + ' → ' + (hb ? hb.replace('HR ', '') : 'none'));
    if (swapped) return { mark: '⇄', cls: 'info', text: p.join(' · ') };
    if (!p.length) return { mark: '=', cls: 'hold', text: 'held' };
    return { mark: dir > 0 ? '▲' : (dir < 0 ? '▼' : '↕'), cls: dir > 0 ? 'up' : (dir < 0 ? 'down' : 'info'), text: p.join(' · ') };
  }

  // ── greedy pairing over a list of predicates (strictest first) ────────────
  // A predicate returns true/false, or a number (score): the highest-scoring
  // unmatched candidate wins; 0 / false means no match.
  function pairUp(L, T, preds) {
    var usedL = {}, pairOfT = {};
    preds.forEach(function (pred) {
      T.forEach(function (t, ti) {
        if (pairOfT[ti] !== undefined) return;
        var best = -1, bestScore = 0;
        for (var li = 0; li < L.length; li++) {
          if (usedL[li]) continue;
          var sc = pred(L[li], t);
          sc = sc === true ? 1 : (+sc || 0);
          if (sc > bestScore) { bestScore = sc; best = li; }
        }
        if (best >= 0) { usedL[best] = true; pairOfT[ti] = best; }
      });
    });
    var pairs = [];
    T.forEach(function (t, ti) { pairs.push({ l: pairOfT[ti] !== undefined ? L[pairOfT[ti]] : null, t: t }); });
    L.forEach(function (l, li) { if (!usedL[li]) pairs.push({ l: l, t: null }); });
    return pairs;
  }

  // ── assemble ──────────────────────────────────────────────────────────────
  function buildWeek(a, weekOf, names) {
    var sessions = (a.planned_sessions || []).filter(function (s) { return mondayOf(s.week_of) === weekOf; });
    var ids = {}; sessions.forEach(function (s) { ids[s.id] = true; });
    var exBy = groupBy((a.planned_exercises || []).filter(function (e) { return ids[e.session_id]; }), 'session_id');
    var cbBy = groupBy((a.planned_conditioning_blocks || []).filter(function (b) { return ids[b.session_id]; }), 'session_id');
    sessions = sessions.map(function (s) {
      var exs = (exBy[s.id] || []).slice().sort(byOrder).map(function (e) {
        return assign({}, e, { exercise_name: e.exercise_name || names[e.exercise_id] || 'Unknown exercise' });
      });
      var cbs = (cbBy[s.id] || []).slice().sort(function (x, y) {
        return (x.block_order == null ? 99 : x.block_order) - (y.block_order == null ? 99 : y.block_order);
      });
      return assign({}, s, { exercises: exs, conditioning: cbs, kind: exs.length ? 'strength' : 'cond' });
    }).sort(sessSort);
    var counts = {};
    sessions.forEach(function (s) { if (s.cycle_id) counts[s.cycle_id] = (counts[s.cycle_id] || 0) + 1; });
    var cycleId = Object.keys(counts).sort(function (x, y) { return counts[y] - counts[x]; })[0];
    var cycles = a.cycles || [];
    var cycle = cycles.filter(function (c) { return c.id === cycleId; })[0]
      || cycles.filter(function (c) { return mondayOf(c.start_date) === weekOf; })[0] || null;
    return { week_of: weekOf, sessions: sessions, cycle: cycle };
  }

  // Share of exercises two strength sessions have in common (0..1), counted
  // against the smaller session. Catches renamed / moved sessions.
  function overlap(l, t) {
    if (l.kind !== 'strength' || t.kind !== 'strength') return 0;
    var a = {}, shared = 0;
    l.exercises.forEach(function (e) { a[e.exercise_id] = true; });
    var seen = {};
    t.exercises.forEach(function (e) { if (a[e.exercise_id] && !seen[e.exercise_id]) { seen[e.exercise_id] = true; shared++; } });
    var base = Math.min(Object.keys(a).length, t.exercises.length) || 1;
    var r = shared / base;
    return (shared >= 2 && r >= 0.4) ? r : 0;
  }
  // Word overlap (Jaccard) of two session_type labels, 0..1.
  function nameSim(l, t) {
    function words(x) {
      var o = {};
      String(x || '').toLowerCase().split(/[^a-z0-9]+/).forEach(function (w) { if (w && w !== 'only') o[w] = true; });
      return o;
    }
    var a = words(l.session_type), b = words(t.session_type), inter = 0, uni = 0, k;
    for (k in a) { uni++; if (b[k]) inter++; }
    for (k in b) if (!a[k]) uni++;
    return uni ? inter / uni : 0;
  }
  function firstModality(s) { return s.conditioning && s.conditioning[0] ? (s.conditioning[0].modality || '') : ''; }

  function assembleAthlete(a, raw) {
    var names = raw.exercise_names || {};
    var tw = buildWeek(a, raw.week_of, names);
    var lw = buildWeek(a, raw.last_week_of, names);

    var plannedIds = {}; (a.planned_sessions || []).forEach(function (p) { plannedIds[p.id] = true; });
    var lastIds = {}; lw.sessions.forEach(function (s) { lastIds[s.id] = s; });
    var rank = { completed: 3, partial: 2, in_progress: 1, skipped: 0 };
    var compByPlan = {}, unplannedComp = [];
    (a.completed_sessions || []).forEach(function (c) {
      if (c.planned_session_id && lastIds[c.planned_session_id]) {
        var prev = compByPlan[c.planned_session_id];
        if (!prev || (rank[c.status] || 0) > (rank[prev.status] || 0)) compByPlan[c.planned_session_id] = c;
      } else if (!c.planned_session_id || !plannedIds[c.planned_session_id]) {
        var d = d10(c.session_date || c.week_of);
        if (d >= raw.last_week_of && d < raw.week_of) unplannedComp.push(c);
      }
    });
    var allSets = (a.completed_strength_sets || []).map(function (s) {
      return assign({}, s, { exercise_name: s.exercise_name || names[s.exercise_id] || 'Unknown exercise' });
    });
    var setsByComp = groupBy(allSets, 'completed_session_id');
    var condByComp = groupBy(a.completed_conditioning || [], 'completed_session_id');

    var sp = pairUp(lw.sessions, tw.sessions, [
      function (l, t) { return l.day_label === t.day_label && l.session_type === t.session_type && l.kind === t.kind && firstModality(l) === firstModality(t); },
      function (l, t) { return l.day_label === t.day_label && l.session_type === t.session_type; },
      function (l, t) { return l.session_type === t.session_type && l.kind === t.kind && (l.kind === 'strength' || firstModality(l) === firstModality(t)); },
      overlap,
      function (l, t) { var r = nameSim(l, t); return (l.day_label === t.day_label && r >= 0.5) ? r : 0; },
      function (l, t) { return l.kind === 'cond' && t.kind === 'cond' && l.day_label === t.day_label && firstModality(l) === firstModality(t); },
      function (l, t) { return l.kind === 'strength' && t.kind === 'strength' && l.day_label === t.day_label; },
      function (l, t) { return l.kind === 'cond' && t.kind === 'cond' && firstModality(l) === firstModality(t); }
    ]);

    var pairs = sp.map(function (p) {
      var comp = p.l ? (compByPlan[p.l.id] || null) : null;
      var logged = !!(comp && comp.status !== 'skipped');
      var sets = comp ? (setsByComp[comp.id] || []) : [];
      var condLogs = comp ? (condByComp[comp.id] || []) : [];
      var skips = parseJson(comp && comp.conditioning_skips, []) || [];
      var usedCond = {};

      // exercise rows
      var LE = p.l ? p.l.exercises : [], TE = p.t ? p.t.exercises : [];
      var er = pairUp(LE, TE, [
        function (l, t) { return l.exercise_id === t.exercise_id; },
        function (l, t) { return l.exercise_role === 'main' && t.exercise_role === 'main'; },
        function (l, t) { return l.superset_group && l.superset_group === t.superset_group && l.exercise_role === t.exercise_role; },
        function (l, t) { return l.item_order === t.item_order && l.exercise_role === t.exercise_role; }
      ]);
      var lIds = {}; LE.forEach(function (e) { lIds[e.id] = true; });
      var lEx = {}; LE.forEach(function (e) { lEx[e.exercise_id] = true; });
      var rows = er.map(function (r) {
        var rs = r.l ? sets.filter(function (s) { return s.planned_exercise_id === r.l.id && !s.is_added; }) : [];
        var swapTo = null;
        rs.forEach(function (s) { if (s.is_swap) swapTo = s.exercise_name; });
        return { kind: 'ex', l: r.l, t: r.t, sets: rs, swapTo: swapTo, logged: logged,
                 v: r.l ? verdict(r.l, rs, logged) : null,
                 c: (!r.l && r.t && lEx[r.t.exercise_id]) ? { mark: 'NEW', cls: 'info', text: 'extra line of the same lift' } : change(r.l, r.t),
                 key: r.t ? (r.t.item_order || 0) : ((r.l.item_order || 0) + 0.5) };
      }).sort(function (x, y) { return x.key - y.key; });
      var added = groupBy(sets.filter(function (s) { return s.is_added || !s.planned_exercise_id || !lIds[s.planned_exercise_id]; }), 'exercise_id');
      Object.keys(added).forEach(function (eid) {
        rows.push({ kind: 'added', name: added[eid][0].exercise_name, sets: added[eid], logged: true });
      });

      // conditioning rows
      var LB = p.l ? p.l.conditioning : [], TB = p.t ? p.t.conditioning : [];
      var cr = pairUp(LB, TB, [
        function (l, t) { return (l.block_order || 0) === (t.block_order || 0) && (l.modality || '') === (t.modality || ''); },
        function (l, t) { return (l.modality || '') === (t.modality || ''); },
        function (l, t) { return (l.block_order || 0) === (t.block_order || 0); }
      ]);
      var condRows = cr.map(function (r) {
        var log = null, skip = null;
        if (r.l) {
          log = condLogs.filter(function (c) { return c.planned_block_id === r.l.id; })[0] || null;
          if (!log) log = condLogs.filter(function (c) { return !c.planned_block_id && !usedCond[c.id] && (c.modality || '') === (r.l.modality || ''); })[0] || null;
          if (!log && LB.length === 1) log = condLogs.filter(function (c) { return !c.planned_block_id && !usedCond[c.id]; })[0] || null;
          if (log) usedCond[log.id] = true;
          skip = skips.filter(function (k) { return k.planned_block_id === r.l.id; })[0] || null;
        }
        return { kind: 'cond', l: r.l, t: r.t, log: log, skip: skip, logged: logged,
                 v: r.l ? condVerdict(r.l, log, skip, logged) : null, c: condChange(r.l, r.t) };
      });
      condLogs.forEach(function (c) { if (!usedCond[c.id]) condRows.push({ kind: 'cond-added', log: c, logged: true }); });

      return { l: p.l, t: p.t, comp: comp, logged: logged, rows: rows, condRows: condRows };
    });

    pairs.sort(function (x, y) {
      var sx = x.t || x.l, sy = y.t || y.l;
      var d = dayIndex(sx.day_label) - dayIndex(sy.day_label);
      if (d) return d;
      if (!x.t !== !y.t) return x.t ? -1 : 1;
      return (sx.session_order || 0) - (sy.session_order || 0);
    });

    var extras = unplannedComp.map(function (c) {
      return { comp: c, sets: setsByComp[c.id] || [], cond: condByComp[c.id] || [] };
    });
    var looseCond = (a.completed_conditioning || []).filter(function (c) {
      var d = d10(c.conditioning_date || c.week_of);
      return !c.completed_session_id && d >= raw.last_week_of && d < raw.week_of;
    });

    var ad = { planned: lw.sessions.length, done: 0, partial: 0, skipped: 0, notLogged: 0 };
    lw.sessions.forEach(function (s) {
      var c = compByPlan[s.id];
      if (!c) ad.notLogged++;
      else if (c.status === 'completed') ad.done++;
      else if (c.status === 'skipped') ad.skipped++;
      else ad.partial++;
    });
    var rd = (a.readiness_logs || []).filter(function (r) {
      var d = d10(r.log_date); return d >= raw.last_week_of && d < raw.week_of && isNum(r.readiness_score);
    });
    var rAvg = rd.length ? rd.reduce(function (s, r) { return s + (+r.readiness_score); }, 0) / rd.length : null;

    function pickDecision(w) {
      return (a.decision_log || []).filter(function (d) { return d10(d.week_of) === w; })
        .sort(function (x, y) { return String(y.created_at || '').localeCompare(String(x.created_at || '')); })[0] || null;
    }
    function pickNotes(w) { return (a.coach_notes || []).filter(function (d) { return d10(d.week_of) === w; }); }

    return {
      name: a.name, id: a.id, tw: tw, lw: lw, pairs: pairs, extras: extras, looseCond: looseCond,
      adherence: ad, readiness: { avg: rAvg, n: rd.length },
      decision: { now: pickDecision(raw.week_of), last: pickDecision(raw.last_week_of) },
      notes: { now: pickNotes(raw.week_of), last: pickNotes(raw.last_week_of) }
    };
  }

  function assemble(raw) {
    return {
      week_of: raw.week_of, last_week_of: raw.last_week_of, generated_at: raw.generated_at, source: raw.source || 'snapshot',
      athletes: (raw.athletes || []).map(function (a) { return assembleAthlete(a, raw); })
    };
  }

  // ── render ────────────────────────────────────────────────────────────────
  function badge(v) {
    if (!v) return '';
    return '<span class="mk ' + v.cls + '">' + esc(v.mark) + '</span>' + (v.text ? ' <span class="mt ' + v.cls + '">' + esc(v.text) + '</span>' : '');
  }
  function sessTitle(s) {
    if (!s) return '';
    return esc(dayShort(s.day_label)) + ' · ' + esc(s.session_type || (s.kind === 'cond' ? 'Conditioning' : 'Session'));
  }
  function para(label, text, cls) {
    if (!text) return '';
    return '<div class="para ' + (cls || '') + '"><b>' + esc(label) + '</b> ' + esc(text) + '</div>';
  }
  function fold(summary, inner) {
    if (!inner) return '';
    return '<details class="fold"><summary>' + esc(summary) + '</summary>' + inner + '</details>';
  }
  function noteHtml(notes) {
    return (notes || []).map(function (n) { return '<div class="anote">“' + esc(n) + '”</div>'; }).join('');
  }
  var DASH = '<span class="muted">—</span>';

  function renderExRow(r) {
    if (r.kind === 'added') {
      return '<tr class="added"><td class="lbl">＋ ' + esc(r.name) + '</td><td class="muted">not planned</td>'
        + '<td><span class="mk up">＋</span> <span class="mt up">added</span><div>' + esc(actualText(r.sets)) + '</div>' + noteHtml(setNotes(r.sets)) + '</td><td></td></tr>';
    }
    var ref = r.t || r.l;
    var nm = ref.exercise_name;
    var grp = ref.superset_group || '';
    var label = (grp ? '<span class="grp">' + esc(grp) + '</span> ' : '') + esc(nm)
      + (ref.exercise_role === 'main' ? ' <span class="role">main</span>' : '');
    var lc, ac, tc;
    if (r.l) {
      lc = (r.l.exercise_name !== nm ? '<div class="alt">' + esc(r.l.exercise_name) + '</div>' : '') + esc(planText(r.l));
      if (!r.logged) ac = DASH;
      else {
        ac = badge(r.v) + (r.swapTo ? ' <span class="mk info">⇄</span> <span class="mt info">swapped to ' + esc(r.swapTo) + '</span>' : '');
        var at = actualText(r.sets);
        if (at) ac += '<div>' + esc(at) + '</div>';
        ac += noteHtml(setNotes(r.sets));
      }
    } else { lc = DASH; ac = DASH; }
    if (r.t) {
      tc = '<div>' + badge(r.c) + '</div>' + esc(planText(r.t))
        + (r.t.coaching_intent ? '<div class="intent">' + esc(r.t.coaching_intent) + '</div>' : '')
        + (r.t.coach_notes ? '<div class="cue">' + esc(r.t.coach_notes) + '</div>' : '');
    } else tc = badge(r.c);
    return '<tr><td class="lbl">' + label + '</td><td>' + lc + '</td><td>' + ac + '</td><td>' + tc + '</td></tr>';
  }
  function renderCondRow(r) {
    if (r.kind === 'cond-added') {
      return '<tr class="added"><td class="lbl">＋ ' + esc(r.log.modality || 'Conditioning') + '</td><td class="muted">not planned</td><td>'
        + '<span class="mk up">＋</span> <span class="mt up">added</span><div>' + esc(condActualText(r.log)) + '</div>' + noteHtml(r.log.notes ? [r.log.notes] : []) + '</td><td></td></tr>';
    }
    var b = r.t || r.l;
    var label = '<span class="grp cond">C</span> ' + esc(b.modality || 'Conditioning')
      + (b.session_purpose ? ' <span class="role">' + esc(String(b.session_purpose).replace(/_/g, ' ')) + '</span>' : '');
    var lc = r.l ? ((r.t && (r.l.modality || '') !== (r.t.modality || '')) ? '<div class="alt">' + esc(r.l.modality) + '</div>' : '') + esc(condPlanText(r.l)) : DASH;
    var ac;
    if (!r.l || (!r.logged && !r.skip)) ac = DASH;
    else {
      ac = badge(r.v);
      if (r.log) {
        var lm = (r.log.modality && r.log.modality !== r.l.modality) ? esc(r.log.modality) + ' · ' : '';
        ac += '<div>' + lm + esc(condActualText(r.log)) + '</div>' + noteHtml(r.log.notes ? [r.log.notes] : []);
      }
    }
    var tc = r.t ? '<div>' + badge(r.c) + '</div>' + esc(condPlanText(r.t)) + (r.t.coach_notes ? '<div class="cue">' + esc(r.t.coach_notes) + '</div>' : '') : badge(r.c);
    return '<tr><td class="lbl">' + label + '</td><td>' + lc + '</td><td>' + ac + '</td><td>' + tc + '</td></tr>';
  }

  function sessionStatus(p) {
    if (!p.l) return '<span class="muted">—</span>';
    var c = p.comp;
    if (!c) return '<span class="mk bad">⚠</span> <span class="mt bad">not logged</span>';
    var st = c.status || '?';
    var cls = st === 'completed' ? 'ok' : (st === 'skipped' ? 'bad' : 'warn');
    var mark = st === 'completed' ? '✓' : (st === 'skipped' ? '✗' : '◐');
    var bits = [st.replace('_', ' ')];
    var wd = weekdayOf(c.session_date);
    if (wd !== null && wd !== dayIndex(p.l.day_label)) bits.push('done ' + DAY_SHORT[wd]);
    if (isNum(c.overall_rpe)) bits.push('session RPE ' + num(c.overall_rpe));
    if (c.effort_level) bits.push(c.effort_level);
    return '<span class="mk ' + cls + '">' + mark + '</span> <span class="mt ' + cls + '">' + esc(bits.join(' · ')) + '</span>'
      + (c.session_notes ? '<div class="anote">“' + esc(c.session_notes) + '”</div>' : '');
  }

  function renderPair(p) {
    var lt = p.l ? sessTitle(p.l) : '', tt = p.t ? sessTitle(p.t) : '';
    var head = '<tr class="shead"><th class="lbl">' + (tt || lt) + '</th>'
      + '<th>' + (p.l ? (lt !== tt && tt ? '<span class="muted">was</span> ' + lt : '') : '<span class="mk info">NEW</span> <span class="mt info">no matching session last week</span>') + '</th>'
      + '<th>' + sessionStatus(p) + '</th>'
      + '<th>' + (p.t ? (p.t.session_notes ? '<div class="cue">' + esc(p.t.session_notes) + '</div>' : '') : '<span class="mk info">DROPPED</span> <span class="mt info">not on this week’s plan</span>') + '</th></tr>';
    var body = p.rows.map(renderExRow).join('') + p.condRows.map(renderCondRow).join('');
    if (!body) body = '<tr><td colspan="4" class="muted">No exercises on this session.</td></tr>';
    return '<table class="sess"><colgroup><col class="c0"><col class="c1"><col class="c2"><col class="c3"></colgroup>' + head + body + '</table>';
  }

  function renderExtras(A) {
    if (!A.extras.length && !A.looseCond.length) return '';
    var h = '<h4 class="xh">Logged last week without a planned session</h4>';
    A.extras.forEach(function (x) {
      var c = x.comp, day = weekdayOf(c.session_date), lines = [];
      var by = groupBy(x.sets, 'exercise_id');
      Object.keys(by).forEach(function (k) { lines.push('<div><b>' + esc(by[k][0].exercise_name) + '</b> ' + esc(actualText(by[k])) + noteHtml(setNotes(by[k])) + '</div>'); });
      x.cond.forEach(function (cc) { lines.push('<div><b>' + esc(cc.modality || 'Conditioning') + '</b> ' + esc(condActualText(cc)) + noteHtml(cc.notes ? [cc.notes] : []) + '</div>'); });
      h += '<div class="extra"><div class="xhead">' + esc(day !== null ? DAY_SHORT[day] : '') + ' · ' + esc(c.session_type || 'Session') + ' · ' + esc(c.status || '')
        + (c.session_notes ? ' — “' + esc(c.session_notes) + '”' : '') + '</div>' + lines.join('') + '</div>';
    });
    A.looseCond.forEach(function (cc) {
      var day = weekdayOf(cc.conditioning_date);
      h += '<div class="extra"><div class="xhead">' + esc(day !== null ? DAY_SHORT[day] : '') + ' · ' + esc(cc.modality || 'Conditioning') + '</div>'
        + esc(condActualText(cc)) + noteHtml(cc.notes ? [cc.notes] : []) + '</div>';
    });
    return h;
  }

  function anchor(name) { return 'a-' + String(name).replace(/\W+/g, ''); }

  function renderAthlete(A, model) {
    var c = A.tw.cycle || {}, lc = A.lw.cycle || {};
    var ad = A.adherence;
    var adText = ad.planned ? (ad.done + ' of ' + ad.planned + ' sessions completed'
      + (ad.partial ? ' · ' + ad.partial + ' partial' : '') + (ad.skipped ? ' · ' + ad.skipped + ' skipped' : '')
      + (ad.notLogged ? ' · ' + ad.notLogged + ' not logged' : '')) : 'no plan last week';
    var tiers = [c.tier1_focus && 'T1 ' + c.tier1_focus, c.tier2_focus && 'T2 ' + c.tier2_focus, c.tier3_focus && 'T3 ' + c.tier3_focus].filter(Boolean).join(' · ');
    var meta = [c.strength_system, c.phase_archetype, tiers,
      c.conditioning_active ? 'Conditioning: ' + (c.conditioning_system || 'on') + (c.conditioning_phase ? ' / ' + c.conditioning_phase : '') : 'Conditioning off'].filter(Boolean).join('  ·  ');

    var dn = A.decision.now, dl = A.decision.last;
    var reason = '<div class="reason"><div class="rcol"><h4>Last week' + (lc.name ? ' — ' + esc(lc.name) : '') + '</h4>'
      + (dl ? para('Coach said to watch:', dl.outcome_to_watch, 'watch') : '<div class="muted">No coaching decision on file for last week.</div>')
      + fold('Note sent to athlete last week', para('', lc.coach_notes))
      + '</div><div class="rcol"><h4>This week — ' + (dn ? '<span class="dtype">' + esc(dn.decision_type) + '</span>' : '<span class="muted">no decision pushed yet</span>') + '</h4>'
      + (dn ? para('Why:', dn.rationale) + para('What changed:', dn.action_taken) + para('Watching next:', dn.outcome_to_watch, 'watch') : '')
      + A.notes.now.map(function (n) { return para('Coach note' + (n.note_type ? ' (' + n.note_type + ')' : '') + ':', n.content); }).join('')
      + (c.coach_question ? para('Question for athlete:', c.coach_question) : '')
      + fold('Note sent to athlete this week', para('', c.coach_notes))
      + '</div></div>';

    var colHead = '<table class="sess colhead"><colgroup><col class="c0"><col class="c1"><col class="c2"><col class="c3"></colgroup><tr>'
      + '<th class="lbl">Session / exercise</th><th>Planned last week<div class="sub">' + esc(fmtDate(model.last_week_of)) + '</div></th>'
      + '<th>What was done</th><th>Planned this week<div class="sub">' + esc(fmtDate(model.week_of)) + '</div></th></tr></table>';

    return '<section class="ath" id="' + anchor(A.name) + '">'
      + '<h2>' + esc(A.name) + ' <span class="cyc">' + esc(c.name || '') + '</span></h2>'
      + '<div class="meta">' + esc(meta) + '</div>'
      + '<div class="meta">Last week: <b>' + esc(adText) + '</b>' + (A.readiness.avg !== null ? '  ·  readiness avg ' + num(A.readiness.avg) + ' (' + A.readiness.n + ' check-ins)' : '') + '</div>'
      + reason + colHead
      + A.pairs.map(renderPair).join('')
      + renderExtras(A)
      + '</section>';
  }

  function firstSentence(t) {
    if (!t) return '';
    var m = String(t).match(/^.*?[.!?](\s|$)/);
    var s = m ? m[0].trim() : String(t);
    return s.length > 160 ? s.slice(0, 157) + '…' : s;
  }
  function renderSummary(model) {
    var rows = model.athletes.map(function (A) {
      var ad = A.adherence, dn = A.decision.now;
      var cls = !ad.planned ? 'na' : (ad.done === ad.planned ? 'ok' : (ad.done + ad.partial >= ad.planned / 2 ? 'warn' : 'bad'));
      return '<tr><td><a href="#' + anchor(A.name) + '">' + esc(A.name) + '</a></td>'
        + '<td><span class="mk ' + cls + '">' + (ad.planned ? ad.done + '/' + ad.planned : '—') + '</span>'
        + (ad.partial ? ' <span class="mt warn">' + ad.partial + ' partial</span>' : '') + '</td>'
        + '<td>' + (A.readiness.avg !== null ? num(A.readiness.avg) : '—') + '</td>'
        + '<td>' + (dn ? '<span class="dtype">' + esc(dn.decision_type) + '</span> ' + esc(firstSentence(dn.action_taken)) : '<span class="muted">—</span>') + '</td>'
        + '<td>' + esc((A.tw.cycle && A.tw.cycle.name) || '') + ' <span class="muted">(' + A.tw.sessions.length + ' sessions)</span></td></tr>';
    }).join('');
    return '<table class="summary"><tr><th>Athlete</th><th>Done last wk</th><th>Readiness</th><th>This week’s call</th><th>This week</th></tr>' + rows + '</table>';
  }

  var LEGEND = '<div class="legend"><b>What was done:</b> <span class="mk ok">✓</span> as planned · <span class="mk up">▲</span> above plan · '
    + '<span class="mk warn">▼</span> below plan · <span class="mk warn">◐</span> partial · <span class="mk warn">⚑</span> RPE / HR off target · '
    + '<span class="mk bad">✗</span> skipped / not done · <span class="mk info">⇄</span> swapped · <span class="mk up">＋</span> added · <span class="mk bad">⚠</span> session not logged'
    + '<br><b>Planned this week</b> (vs last week’s plan): <span class="mk up">▲</span> progressed · <span class="mk hold">=</span> held · <span class="mk down">▼</span> backed off · '
    + '<span class="mk info">↕</span> mixed · <span class="mk info">⇄</span> variation changed · <span class="mk info">NEW</span> · <span class="mk info">DROPPED</span>'
    + ' · <i>italic</i> = coach’s reason for the exercise · <span class="anote">“purple”</span> = athlete’s note</div>';

  function render(model) {
    var gen = model.generated_at ? String(model.generated_at).replace('T', ' ').slice(0, 16) : '';
    return '<header class="top"><h1>Week Review — week of ' + esc(fmtDate(model.week_of)) + '</h1>'
      + '<div class="meta">Plan for ' + esc(fmtDate(model.last_week_of)) + ' · what was logged · plan for ' + esc(fmtDate(model.week_of))
      + (gen ? '  ·  generated ' + esc(gen) : '') + (model.source === 'live' ? '  ·  live' : '') + '</div></header>'
      + (model.athletes.length ? renderSummary(model) : '<p class="muted">No athletes have a plan for this week.</p>')
      + LEGEND
      + model.athletes.map(function (A) { return renderAthlete(A, model); }).join('');
  }

  function mount(raw, el) {
    var model = assemble(raw);
    el.innerHTML = render(model);
    return model;
  }

  var CSS = [
    ':root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#dcdce1;--soft:#f4f4f6;--ok:#1f7a3a;--warn:#a85d00;--bad:#b3261e;--up:#1f6fb2;--info:#5b4fb5;--hold:#6e6e73}',
    '@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--muted:#9a9aa2;--line:#33333a;--soft:#202024;--ok:#5fcf80;--warn:#f0a43a;--bad:#ff6b5e;--up:#6cb4ff;--info:#b4a8ff;--hold:#9a9aa2}}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#review{max-width:1500px;margin:0 auto;padding:16px}',
    'h1{font-size:22px;margin:0 0 4px}h2{font-size:19px;margin:0 0 4px}',
    'h4{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}h4.xh{margin-top:14px}',
    '.cyc{font-weight:400;color:var(--muted);font-size:15px}.meta{color:var(--muted);margin:2px 0}.meta b{color:var(--fg)}.sub{font-weight:400;color:var(--muted);font-size:12px}',
    '.ath{border-top:3px solid var(--fg);margin-top:30px;padding-top:12px}',
    '.summary{border-collapse:collapse;margin:14px 0;width:100%}.summary th,.summary td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}',
    '.summary a{color:var(--up);font-weight:600}.summary td:nth-child(4){overflow-wrap:anywhere}.summary td:first-child{white-space:nowrap}',
    'details.fold{margin:6px 0 2px}details.fold summary{cursor:pointer;color:var(--muted);font-size:12.5px}details.fold .para{margin-left:14px}',
    '.legend{background:var(--soft);padding:8px 10px;border-radius:6px;font-size:12.5px;line-height:1.8}',
    '.reason{display:grid;grid-template-columns:1fr 1.6fr;gap:18px;background:var(--soft);padding:10px 12px;border-radius:6px;margin:10px 0}',
    '.para{margin:4px 0}.para.watch b{color:var(--warn)}',
    '.dtype{display:inline-block;background:var(--fg);color:var(--bg);border-radius:4px;padding:0 6px;font-size:12px;font-weight:600;text-transform:none;letter-spacing:0}',
    'table.sess{border-collapse:collapse;width:100%;table-layout:fixed}',
    'table.sess td,table.sess th{border-bottom:1px solid var(--line);padding:5px 8px;vertical-align:top;text-align:left;overflow-wrap:anywhere}',
    'col.c0{width:19%}col.c1,col.c2,col.c3{width:27%}',
    'table.colhead{position:sticky;top:0;background:var(--bg);z-index:2}table.colhead th{border-bottom:2px solid var(--fg);font-size:13px}',
    'tr.shead th{background:var(--soft);font-weight:400;border-top:14px solid var(--bg)}tr.shead th.lbl{font-weight:700}',
    'td.lbl{font-weight:600}.grp{display:inline-block;min-width:22px;font-size:11px;color:var(--muted);font-weight:700}.grp.cond{color:var(--up)}',
    '.role{font-size:10px;font-weight:700;color:var(--muted);border:1px solid var(--line);border-radius:3px;padding:0 3px;text-transform:uppercase;vertical-align:1px}',
    '.alt{font-weight:600}.intent{font-style:italic;color:var(--muted);font-size:12.5px;margin-top:2px}.cue{color:var(--muted);font-size:12.5px;margin-top:2px}',
    '.anote{color:var(--info);font-size:12.5px}.muted{color:var(--muted)}tr.added td{background:var(--soft)}',
    '.mk{font-weight:700}.mk.ok,.mt.ok{color:var(--ok)}.mk.warn,.mt.warn{color:var(--warn)}.mk.bad,.mt.bad{color:var(--bad)}.mk.up,.mt.up{color:var(--up)}',
    '.mk.down,.mt.down{color:var(--warn)}.mk.info,.mt.info{color:var(--info)}.mk.hold,.mt.hold{color:var(--hold)}.mk.na,.mt.na{color:var(--muted)}.mt{font-size:12.5px}',
    '.extra{border-left:3px solid var(--up);padding:4px 10px;margin:6px 0}.xhead{font-weight:600}',
    '@media (max-width:760px){#review{padding:10px}.reason{grid-template-columns:1fr}table.colhead{display:none}',
    ' table.sess,table.sess tbody,table.sess tr,table.sess td,table.sess th{display:block;width:100%}table.sess colgroup{display:none}',
    ' table.sess td,table.sess th{border:0;padding:2px 8px}table.sess tr{border-bottom:1px solid var(--line);padding:4px 0}',
    ' table.sess td:nth-child(2):before{content:"Last wk plan: ";color:var(--muted);font-size:11px}',
    ' table.sess td:nth-child(3):before{content:"Done: ";color:var(--muted);font-size:11px}',
    ' table.sess td:nth-child(4):before{content:"This wk: ";color:var(--muted);font-size:11px}',
    ' .summary td:nth-child(5),.summary th:nth-child(5){display:none}}'
  ].join('\n');

  root.WeekReview = {
    assemble: assemble, render: render, mount: mount, CSS: CSS,
    mondayOf: mondayOf,
    _test: { planText: planText, actualText: actualText, verdict: verdict, change: change,
             condVerdict: condVerdict, condChange: condChange, pairUp: pairUp }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.WeekReview;
})(typeof window !== 'undefined' ? window : globalThis);
