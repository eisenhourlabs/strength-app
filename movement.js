// ═══════════════════════════════════════════════════════════════════════════
// movement.js — Daily Movement: walk + mobility check-off
// Spec: 07_Documentation/Daily_Movement_Plan_2026-09-24.md (Rev 3)
// Rules: 01_System/09_Daily_Movement_Framework.md · Drills: 03_Environment/Mobility_Drill_Map.md
//
// Layout of this file:
//   1. ENGINE — pure functions, no DOM / Supabase / globals. Unit-tested in Node
//      by 05_Scripts/test_movement_engine.js. Keep them pure.
//   2. DATA   — load + IndexedDB cache, writes (online or offline queue), mvSyncOp()
//               (called from syncQueue() in core.js).
//   3. UI     — Today card (Week screen), log sheets, Movement screen, Trends
//               section, check-in line.
//   4. COACH  — recommendation banner + cautions (Phase 2).
//   5. SELF-TESTS (Phase 3) — engine (pure: mvScreensDue, mvScreenChange,
//               mvScreenTrend, mvTiltAngle…), data (mobility_screens), UI (test
//               list + test sheet in #mv-sheet, phone tilt meter, Today row,
//               area-row results, Trends lines, check-in add-on).
//
// Daily movement is NOT a session: it never touches planned/completed sessions,
// the week progress bar, or consistency numbers.
// Loads after session.js and BEFORE week.js (week.js must stay last).
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. ENGINE ───────────────────────────────────────────────────────────────

const MV_REGIONS = [
  { key: 'neck',        label: 'Neck',            pain: ['Neck'] },
  { key: 'upper_back',  label: 'Upper back',      pain: ['Upper Back'] },
  { key: 'shoulder',    label: 'Shoulders',       pain: ['Shoulder'] },
  { key: 'wrist_elbow', label: 'Wrists & elbows', pain: ['Wrist', 'Elbow'] },
  { key: 'low_back',    label: 'Low back',        pain: ['Low Back'] },
  { key: 'hip',         label: 'Hips',            pain: ['Hip'] },
  { key: 'hamstring',   label: 'Hamstrings',      pain: ['Hip', 'Low Back'] },
  { key: 'knee',        label: 'Knees & quads',   pain: ['Knee'] },
  { key: 'ankle',       label: 'Ankles & calves', pain: ['Ankle'] },
];
const MV_REGION_ORDER = MV_REGIONS.map(function (r) { return r.key; });
const MV_ALWAYS_EQUIP = ['none', 'wall', 'bench'];      // bench = bench, chair or couch edge
const MV_TOGGLE_EQUIP = ['band', 'foam roller', 'dumbbell'];
const MV_CAPS = { daily: 2, rotating: 3 };
const MV_ROTATION_EPOCH = '2024-01-01';                 // a Monday; rotation ordinal origin
const MV_BACKFILL_DAYS = 6;                             // today + prior 6 days

function mvRegion(key) {
  for (let i = 0; i < MV_REGIONS.length; i++) if (MV_REGIONS[i].key === key) return MV_REGIONS[i];
  return { key: key, label: key, pain: [] };
}

// Dates are 'YYYY-MM-DD' strings in the athlete's local calendar. Math is done in
// UTC so DST never shifts a day.
function mvUtc(ds) { const p = ds.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
function mvFmt(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function mvAddDays(ds, n) { return mvFmt(mvUtc(ds) + n * 86400000); }
function mvDaysBetween(a, b) { return Math.round((mvUtc(b) - mvUtc(a)) / 86400000); }
function mvIsoDow(ds) { const d = new Date(mvUtc(ds)).getUTCDay(); return d === 0 ? 7 : d; }
function mvMonday(ds) { return mvAddDays(ds, 1 - mvIsoDow(ds)); }
function mvDayOfYear(ds) { return mvDaysBetween(ds.slice(0, 4) + '-01-01', ds) + 1; }

// Plan version in force on a date (versioned movement_plans rows).
function mvPlanOn(plans, kind, ds) {
  let best = null;
  (plans || []).forEach(function (p) {
    if (p.kind !== kind) return;
    if (p.effective_from > ds) return;
    if (p.effective_to && p.effective_to < ds) return;
    if (!best || p.effective_from > best.effective_from
        || (p.effective_from === best.effective_from && (p.created_at || '') > (best.created_at || ''))) best = p;
  });
  return best;
}
function mvCurrentPlan(plans, kind) {
  let cur = null;
  (plans || []).forEach(function (p) { if (p.kind === kind && !p.effective_to) cur = p; });
  return cur;
}
function mvLastPlan(plans, kind) {
  let last = null;
  (plans || []).forEach(function (p) {
    if (p.kind !== kind) return;
    if (!last || p.effective_from > last.effective_from
        || (p.effective_from === last.effective_from && (p.created_at || '') > (last.created_at || ''))) last = p;
  });
  return last;
}
function mvIsScheduled(plan, ds) {
  return !!(plan && (plan.schedule_days || []).map(Number).indexOf(mvIsoDow(ds)) !== -1);
}

// Local mirror of the SQL function movement_save_plan() — keeps the optimistic
// UI and the offline path identical to what the server will do.
function mvApplyPlanLocal(plans, a) {
  const out = (plans || []).map(function (p) { return Object.assign({}, p); });
  let cur = null;
  out.forEach(function (p) { if (p.kind === a.kind && !p.effective_to) cur = p; });
  if (!a.enabled) {
    if (cur) { cur.effective_to = mvAddDays(a.today, -1); cur.closed_by = 'athlete'; }
    return out;
  }
  const fields = {
    schedule_days: a.days.slice().sort(), target_minutes: a.minutes, mode: a.mode || null,
    notes: a.notes || null, equipment: (a.equipment || []).slice(), set_by: a.setBy === 'coach' ? 'coach' : 'athlete',
  };
  if (cur && cur.effective_from >= a.today) { Object.assign(cur, fields); return out; }
  if (cur) { cur.effective_to = mvAddDays(a.today, -1); cur.closed_by = 'athlete'; }
  out.push(Object.assign({
    id: 'local-' + a.kind + '-' + a.today, athlete_id: a.athleteId, kind: a.kind,
    effective_from: a.today, effective_to: null, closed_by: null,
    created_at: new Date(mvUtc(a.today)).toISOString(),
  }, fields));
  return out;
}

// One row per calendar day (from..to inclusive) for a kind. `scheduled` comes
// from the plan version in force that day — same rule as v_movement_daily.
function mvDailyRows(plans, logs, kind, from, to) {
  const byDate = {};
  (logs || []).forEach(function (l) { if (l.kind === kind) byDate[l.log_date] = l; });
  const rows = [];
  for (let d = from; d <= to; d = mvAddDays(d, 1)) {
    const p = mvPlanOn(plans, kind, d);
    const l = byDate[d] || null;
    rows.push({
      date: d, planActive: !!p, scheduled: mvIsScheduled(p, d),
      target: p ? p.target_minutes : null,
      status: l ? l.status : null, minutes: l ? Number(l.minutes || 0) : 0,
      pain_flag: !!(l && l.pain_flag), pain_region: l ? l.pain_region : null,
    });
  }
  return rows;
}

// Compliance = (done + 0.5 × partial) ÷ (scheduled − excused). Logged
// unscheduled days are bonus: numerator only. A scheduled day that is today and
// not yet logged is pending, not missed. Future days are ignored.
function mvCompliance(rows, todayStr) {
  const c = { scheduled: 0, done: 0, partial: 0, excused: 0, missed: 0, bonus: 0, minutes: 0, credit: 0, pct: null };
  (rows || []).forEach(function (r) {
    if (r.date > todayStr) return;
    const s = r.status;
    if (s === 'done' || s === 'partial') c.minutes += Number(r.minutes || 0);
    if (r.scheduled) {
      if (!s && r.date === todayStr) return;      // pending
      c.scheduled++;
      if (s === 'excused') c.excused++;
      else if (s === 'done') { c.done++; c.credit += 1; }
      else if (s === 'partial') { c.partial++; c.credit += 0.5; }
      else c.missed++;
    } else if (s === 'done' || s === 'partial') {
      c.bonus++; c.credit += (s === 'done' ? 1 : 0.5);
    }
  });
  const denom = c.scheduled - c.excused;
  c.pct = denom > 0 ? Math.min(100, Math.round(c.credit / denom * 100)) : null;
  return c;
}

// Consecutive scheduled days done, counting back from today. Unscheduled and
// excused days don't break it; today-not-yet-logged is pending.
function mvStreak(rows, todayStr) {
  const sorted = (rows || []).filter(function (r) { return r.date <= todayStr; })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  let n = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (!r.scheduled || r.status === 'excused') continue;
    if (r.date === todayStr && !r.status) continue;
    if (r.status === 'done') n++;
    else break;
  }
  return n;
}

// Pain state per movement region from open pain episodes (S.openInjuries).
// Red (≥ 6 or neuro flag) = hard pause. Amber (3–5) = cap L1, drop tagged drills.
function mvRegionPain(regionKey, injuries) {
  const pr = mvRegion(regionKey).pain;
  let score = 0, neuro = false, name = null;
  (injuries || []).forEach(function (i) {
    if (pr.indexOf(i.body_region) === -1) return;
    const s = Number(i.pain_score || 0);
    if (i.neuro_flag) neuro = true;
    if (s >= score) { score = s; name = i.body_region; }
  });
  if (neuro || score >= 6) return { state: 'red', score: score, neuro: neuro, painRegion: name };
  if (score >= 3) return { state: 'amber', score: score, neuro: false, painRegion: name };
  return { state: 'none', score: score, neuro: false, painRegion: name };
}

// Exclusion set. Coach cautions apply wherever the tag appears (a deep-knee
// drill loads the knee whichever region it's filed under); an athlete override
// ("Include anyway") switches that caution off.
function mvExclusions(cautions, injuries) {
  const ex = { tags: {}, amber: {}, red: {} };
  (cautions || []).forEach(function (c) {
    if (c.is_active === false || c.athlete_override) return;
    (c.caution_tags || []).forEach(function (t) { if (!ex.tags[t]) ex.tags[t] = c.reason || 'Coach caution'; });
  });
  MV_REGION_ORDER.forEach(function (k) {
    const p = mvRegionPain(k, injuries);
    if (p.state === 'red') ex.red[k] = p;
    else if (p.state === 'amber') ex.amber[k] = p;
  });
  return ex;
}

function mvEquipOk(d, equip) {
  const e = (d.equipment || 'none').toLowerCase();
  return MV_ALWAYS_EQUIP.indexOf(e) !== -1 || (equip || []).indexOf(e) !== -1;
}

// Why a drill can't be used today (null = usable).
function mvDrillBlock(d, ex) {
  if (ex.red[d.region]) return 'paused';
  const tags = d.tags || [];
  for (let i = 0; i < tags.length; i++) if (ex.tags[tags[i]]) return 'caution';
  if (ex.amber[d.region] && tags.length) return 'pain';
  return null;
}
const MV_BLOCK_WORDS = { caution: 'coach caution', pain: 'open pain episode', paused: 'region paused', equipment: 'needs equipment you haven\'t turned on' };

function mvRegionDrills(map, region, slot) {
  return (map || []).filter(function (d) { return d.region === region && d.slot === slot && !d.is_swap; });
}

// Pick one drill for a region/slot. Saved drill first (coach suggestion or
// athlete swap), then sort_order at the level, then lower levels.
function mvPickDrill(map, region, slot, level, preferred, ex, equip, used) {
  const cands = mvRegionDrills(map, region, slot);
  let note = null;
  const why = function (d) {
    if (used && used[d.name]) return 'used';
    const b = mvDrillBlock(d, ex);
    if (b) return b;
    if (!mvEquipOk(d, equip)) return 'equipment';
    return null;
  };
  if (preferred) {
    const p = cands.filter(function (d) { return d.name === preferred; })[0];
    if (p) {
      const w = why(p);
      if (!w) return { drill: p, note: null };
      if (w !== 'used') note = p.name + ' left out today — ' + MV_BLOCK_WORDS[w];
    }
  }
  for (let L = level; L >= 1; L--) {
    const at = cands.filter(function (d) { return d.level === L; })
      .sort(function (a, b) { return a.sort_order - b.sort_order; });
    for (let i = 0; i < at.length; i++) if (!why(at[i])) return { drill: at[i], note: note };
  }
  return { drill: null, note: note };
}

// Ordinal of a date among the scheduled days since the epoch — drives rotation.
function mvScheduledOrdinal(days, ds) {
  const list = (days && days.length ? days : [1, 2, 3, 4, 5, 6, 7]).map(Number).sort();
  const weeks = Math.floor(mvDaysBetween(MV_ROTATION_EPOCH, ds) / 7);
  const dow = mvIsoDow(ds);
  return weeks * list.length + list.filter(function (d) { return d < dow; }).length;
}

function mvItem(d, extra) {
  return Object.assign({
    name: d.name, region: d.region, slot: d.slot, level: d.level,
    dose: d.dose || '', cue: d.cue || '', minutes: Number(d.minutes || 1), tags: d.tags || [],
  }, extra || {});
}

// THE generator. Same inputs → same routine. No randomness.
// Returns { mode, flow, items[], regions[], paused[], notes[], minutes }.
function buildRoutine(o) {
  const plan = o.plan || {};
  const map = o.drillMap || [];
  const equip = o.equipment || plan.equipment || [];
  const ex = mvExclusions(o.cautions, o.painEpisodes);
  const out = { mode: plan.mode || 'general', flow: null, items: [], regions: [], paused: [], notes: [], minutes: 0 };
  const pausedSeen = {};
  const pause = function (region) {
    if (pausedSeen[region]) return;
    pausedSeen[region] = true;
    const p = ex.red[region];
    out.paused.push({ region: region, label: mvRegion(region).label, score: p.score, neuro: p.neuro,
      reason: p.neuro ? 'nerve symptoms flagged' : 'open pain episode ' + p.score + '/10' });
  };

  if (out.mode !== 'targeted') {
    const flow = mvDayOfYear(o.date) % 2 === 1 ? 'flow_a' : 'flow_b';
    out.flow = flow;
    const rows = map.filter(function (d) { return d.slot === flow; });
    const steps = Array.from(new Set(rows.map(function (d) { return d.sort_order; }))).sort(function (a, b) { return a - b; });
    steps.forEach(function (st) {
      const prim = rows.filter(function (d) { return d.sort_order === st && !d.is_swap; })[0];
      const swap = rows.filter(function (d) { return d.sort_order === st && d.is_swap; })[0];
      if (!prim) return;
      if (ex.red[prim.region]) { pause(prim.region); return; }
      const w = mvDrillBlock(prim, ex) || (mvEquipOk(prim, equip) ? null : 'equipment');
      if (!w) { out.items.push(mvItem(prim)); return; }
      if (swap && !mvDrillBlock(swap, ex) && mvEquipOk(swap, equip)) {
        out.items.push(mvItem(swap, { swappedFrom: prim.name }));
        out.notes.push(swap.name + ' replaces ' + prim.name + ' — ' + MV_BLOCK_WORDS[w]);
      } else {
        out.notes.push(prim.name + ' left out — ' + MV_BLOCK_WORDS[w]);
      }
    });
  } else {
    const active = (o.areas || []).filter(function (a) { return a.is_active !== false; });
    const byOrder = function (a, b) { return MV_REGION_ORDER.indexOf(a.region) - MV_REGION_ORDER.indexOf(b.region); };
    const daily = active.filter(function (a) { return a.priority === 'daily'; }).sort(byOrder).slice(0, MV_CAPS.daily);
    const rot = active.filter(function (a) { return a.priority === 'rotating'; }).sort(byOrder).slice(0, MV_CAPS.rotating);
    let chosen = daily.slice();
    if (rot.length) {
      const per = Number(plan.target_minutes || 0) >= 15 ? Math.min(2, rot.length) : 1;
      const k = mvScheduledOrdinal(plan.schedule_days, o.date);
      for (let i = 0; i < per; i++) {
        const a = rot[(k * per + i) % rot.length];
        if (chosen.indexOf(a) === -1) chosen.push(a);
      }
    }
    const used = {};
    const blocks = [];
    chosen.forEach(function (a) {
      if (ex.red[a.region]) { pause(a.region); return; }
      const amber = !!ex.amber[a.region];
      const level = amber ? 1 : Math.max(1, Math.min(3, Number(a.level || 1)));
      const reg = { region: a.region, label: mvRegion(a.region).label, level: level,
        setLevel: Number(a.level || 1), cappedByPain: amber && Number(a.level || 1) > 1, priority: a.priority };
      out.regions.push(reg);
      if (amber) out.notes.push(reg.label + ': held at level 1, end-range drills left out — open pain episode ' + ex.amber[a.region].score + '/10');
      ['mobility', 'control'].forEach(function (slot) {
        const pref = slot === 'mobility' ? a.drill_mobility : a.drill_control;
        const r = mvPickDrill(map, a.region, slot, level, pref, ex, equip, used);
        if (r.note) out.notes.push(r.note);
        if (r.drill) { used[r.drill.name] = true; blocks.push(mvItem(r.drill, { level: r.drill.level })); }
      });
    });
    // 1-minute Cat Camel opener if there's room (≤ 3 regions) and it's usable.
    if (out.regions.length && out.regions.length <= 3 && !used['Cat Camel']) {
      const cc = map.filter(function (d) { return d.name === 'Cat Camel' && (d.slot === 'mobility' || d.slot === 'control'); })
        .sort(function (a, b) { return MV_REGION_ORDER.indexOf(a.region) - MV_REGION_ORDER.indexOf(b.region); })
        .filter(function (d) { return !mvDrillBlock(d, ex); })[0];
      if (cc) out.items.push(mvItem(cc, { isOpener: true, minutes: 1, dose: '1 × 8' }));
    }
    out.items = out.items.concat(blocks);
  }
  out.minutes = Math.round(out.items.reduce(function (s, i) { return s + Number(i.minutes || 0); }, 0));
  return out;
}

// Level-up is offered (never automatic): ≥ 14 days on the level, ≥ 75%
// compliance on scheduled days in the last 14 days, no pain flag in the region.
function mvLevelUpCheck(area, mobilityRows, logs, injuries, todayStr) {
  const res = { eligible: false, days: 0, pct: null };
  if (!area || area.is_active === false) return res;
  const lvl = Number(area.level || 1);
  res.days = mvDaysBetween(area.started_on, todayStr);
  if (lvl >= 3 || res.days < 14) return res;
  const from = mvAddDays(todayStr, -14), to = mvAddDays(todayStr, -1);
  const win = (mobilityRows || []).filter(function (r) { return r.date >= from && r.date <= to; });
  const c = mvCompliance(win, todayStr);
  res.pct = c.pct;
  if (c.pct == null || c.pct < 75) return res;
  const pr = mvRegion(area.region).pain;
  const flagged = (logs || []).some(function (l) {
    return l.pain_flag && l.log_date >= from && l.log_date <= todayStr && pr.indexOf(l.pain_region) !== -1;
  });
  if (flagged) return res;
  if (mvRegionPain(area.region, injuries).state !== 'none') return res;
  res.eligible = true;
  return res;
}

// Areas whose level should drop to 1 after a movement-log pain flag.
function mvRegionsForPain(painRegion) {
  return MV_REGIONS.filter(function (r) { return r.pain.indexOf(painRegion) !== -1; }).map(function (r) { return r.key; });
}

function mvStripSymbol(r, todayStr) {
  if (r.status === 'done') return 'done';
  if (r.status === 'partial') return 'partial';
  if (r.status === 'excused') return 'excused';
  if (r.date > todayStr) return r.scheduled ? 'future' : 'off';
  if (r.scheduled) return r.date === todayStr ? 'today' : 'missed';
  return 'off';
}

function mvParseHoldSeconds(dose) {
  const m = /(\d+)\s*s\b/.exec(dose || '');
  return m ? Number(m[1]) : 0;
}

// ── 2. DATA ─────────────────────────────────────────────────────────────────

const MV = {
  loaded: false, loading: null, lastLoad: 0, unavailable: false,
  plans: [], areas: [], logs: [], cautions: [], recs: [], drillMap: [], daily: null,
  sheet: null, addArea: null, review: null, timers: {}, planTimers: {},
};

function mvToday() { return typeof today === 'function' ? today() : mvFmt(Date.now()); }
function mvEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function mvNormDrill(r) {
  return {
    name: (r.exercise && r.exercise.name) || r.name, region: r.region, slot: r.slot,
    level: Number(r.level), sort_order: Number(r.sort_order), dose: r.dose, cue: r.cue,
    tags: r.caution_tags || [], equipment: r.equipment || 'none',
    minutes: Number(r.est_minutes || 1), is_swap: !!r.is_swap,
  };
}

async function mvSaveCache() {
  try {
    await idbSet('movementCache', { athleteId: S.athlete.id, plans: MV.plans, areas: MV.areas, logs: MV.logs,
      cautions: MV.cautions, recs: MV.recs, drillMap: MV.drillMap,
      tests: MV.tests, screens: MV.screens, screenPrefs: MV.screenPrefs });
  } catch (_) {}
}

async function loadMovement(force) {
  if (!S || !S.athlete) return;
  if (MV.loading) return MV.loading;
  MV.loading = (async function () {
    let fromNet = false;
    if (!isOffline) {
      try {
        const id = S.athlete.id;
        const since = mvAddDays(mvToday(), -120);
        const res = await Promise.all([
          db.from('movement_plans').select('*').eq('athlete_id', id).order('effective_from'),
          db.from('movement_focus_areas').select('*').eq('athlete_id', id),
          db.from('movement_logs').select('*').eq('athlete_id', id).gte('log_date', since).order('log_date'),
          db.from('movement_cautions').select('*').eq('athlete_id', id).eq('is_active', true),
          db.from('movement_recommendations').select('*').eq('athlete_id', id).order('pushed_at', { ascending: false }).limit(5),
          db.from('mobility_drill_map')
            .select('region,slot,level,sort_order,dose,cue,caution_tags,equipment,est_minutes,is_swap,exercise:exercise_id(name)'),
        ]);
        const err = res.map(function (r) { return r.error; }).filter(Boolean)[0];
        if (err) throw err;
        MV.plans = res[0].data || []; MV.areas = res[1].data || []; MV.logs = res[2].data || [];
        MV.cautions = res[3].data || []; MV.recs = res[4].data || [];
        MV.drillMap = (res[5].data || []).map(mvNormDrill);
        MV.unavailable = false;
        fromNet = true;
        await mvLoadScreens();   // Phase 3 self-tests (own try — never blocks the check-off)
        await mvSaveCache();
      } catch (e) {
        console.error('loadMovement:', e);
        // 42P01 = table missing: the migration hasn't been run yet.
        if (e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message || ''))) MV.unavailable = true;
      }
    }
    if (!fromNet) {
      try {
        const c = await idbGet('movementCache');
        if (c && c.athleteId === S.athlete.id) {
          MV.plans = c.plans || []; MV.areas = c.areas || []; MV.logs = c.logs || [];
          MV.cautions = c.cautions || []; MV.recs = c.recs || []; MV.drillMap = c.drillMap || [];
          MV.tests = c.tests || MV.tests; MV.screens = c.screens || MV.screens; MV.screenPrefs = c.screenPrefs || MV.screenPrefs;
        }
      } catch (_) {}
    }
    await mvLoadScreenUi();
    MV.loaded = true;
    MV.lastLoad = Date.now();
  })();
  try { await MV.loading; } finally { MV.loading = null; }
}

// Replays one queued write (offline path) or performs it directly (online).
// Called from syncQueue() in core.js. Throws on failure so the item stays queued.
async function mvSyncOp(op, p) {
  let r;
  if (op === 'movement_log_upsert') {
    r = await db.from('movement_logs').upsert(p, { onConflict: 'athlete_id,log_date,kind' });
  } else if (op === 'movement_log_delete') {
    r = await db.from('movement_logs').delete().eq('athlete_id', p.athlete_id).eq('log_date', p.log_date).eq('kind', p.kind);
  } else if (op === 'movement_plan_write') {
    r = await db.rpc('movement_save_plan', p);
  } else if (op === 'movement_area_write') {
    r = await db.from('movement_focus_areas').upsert(p, { onConflict: 'athlete_id,region' });
  } else if (op === 'movement_rec_status') {
    r = await db.from('movement_recommendations').update({ status: p.status, resolved_at: p.resolved_at }).eq('id', p.id);
  } else if (op === 'movement_caution_override') {
    r = await db.from('movement_cautions').update({ athlete_override: p.athlete_override, override_at: p.override_at }).eq('id', p.id);
  } else if (op === 'movement_screen_upsert') {
    r = await db.from('mobility_screens').upsert(p.rows, { onConflict: 'athlete_id,test_key,side,test_date' });
  } else if (op === 'movement_screen_pref') {
    r = await db.from('mobility_screen_prefs').upsert(p, { onConflict: 'athlete_id,test_key' });
  } else {
    throw new Error('unknown movement op ' + op);
  }
  if (r && r.error) throw r.error;
  MV.lastLoad = 0;   // server state changed — next render refreshes
  return r;
}

async function mvWrite(op, payload) {
  if (!isOffline) {
    try { await mvSyncOp(op, payload); return true; }
    catch (e) {
      console.error('movement write failed:', op, e);
      let online = false;
      try { online = await checkOnline(); } catch (_) {}
      if (online) { toast('Could not save — ' + (e.message || e.code || 'error'), 4000); return false; }
      isOffline = true;
      try { updateOfflineBanner(); } catch (_) {}
    }
  }
  try { await idbQueueWrite({ op: op, payload: payload }); return true; }
  catch (e) { toast('Could not save offline'); return false; }
}

// ── Derived state helpers ──
function mvPlan(kind) { return mvCurrentPlan(MV.plans, kind); }
function mvAnyOn() { return !!(mvPlan('walk') || mvPlan('mobility')); }
function mvEquipment() { const p = mvPlan('mobility') || mvLastPlan(MV.plans, 'mobility'); return (p && p.equipment) || []; }
function mvLog(kind, ds) {
  return MV.logs.filter(function (l) { return l.kind === kind && l.log_date === ds; })[0] || null;
}
function mvPendingRec() {
  return (MV.recs || []).filter(function (r) { return r.status === 'pending'; })[0] || null;
}
function mvRoutineFor(ds) {
  const plan = mvPlanOn(MV.plans, 'mobility', ds) || mvPlan('mobility') || { mode: 'general' };
  return buildRoutine({ date: ds, plan: plan, areas: MV.areas, drillMap: MV.drillMap,
    cautions: MV.cautions, painEpisodes: (S && S.openInjuries) || [], equipment: plan.equipment || mvEquipment() });
}
function mvRows(kind, from, to) { return mvDailyRows(MV.plans, MV.logs, kind, from, to); }

// ── 3. UI — Today card (Week screen) ────────────────────────────────────────

// Called by renderWeek() after it paints. Renders nothing when both habits are
// off; lazily loads data (covers the offline boot path, which skips onLogin).
function renderMovementCard() {
  const slot = document.getElementById('mv-card-slot');
  if (!MV.loaded || (!isOffline && Date.now() - MV.lastLoad > 60000)) {
    if (!MV.loading) loadMovement().then(function () { mvPaintCard(); }).catch(function () {});
  }
  mvPaintCard();
  return slot;
}

function mvPaintCard() {
  const dot = document.getElementById('mv-util-dot');
  if (dot) dot.style.display = mvPendingRec() ? '' : 'none';
  const slot = document.getElementById('mv-card-slot');
  if (!slot) return;
  if (!MV.loaded || !mvAnyOn()) { slot.innerHTML = ''; return; }
  const t = mvToday();
  const dateLbl = new Date(mvUtc(t) + 12 * 3600000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  let rows = '';
  ['walk', 'mobility'].forEach(function (kind) {
    const plan = mvPlan(kind);
    if (!plan) return;
    const log = mvLog(kind, t);
    const sched = mvIsScheduled(plan, t);
    const sym = log ? (log.status === 'done' ? '✓' : log.status === 'partial' ? '◐' : '✕') : '';
    const cls = log ? ' mv-circle-' + log.status : '';
    let title, sub = '';
    if (kind === 'walk') {
      title = 'Walk';
      sub = log && log.status !== 'excused' ? Math.round(Number(log.minutes || 0)) + ' min logged' : plan.target_minutes + ' min';
    } else {
      const r = mvRoutineFor(t);
      title = 'Mobility';
      const what = r.mode === 'targeted'
        ? (r.regions.map(function (x) { return x.label; }).join(' + ') || 'No focus areas yet')
        : 'General flow ' + (r.flow === 'flow_a' ? 'A' : 'B');
      sub = what + '<br><span class="mv-row-meta">~' + r.minutes + ' min · ' + r.items.length + ' drill' + (r.items.length === 1 ? '' : 's')
        + (r.paused.length ? ' · ' + r.paused.map(function (p) { return p.label; }).join(', ') + ' paused' : '') + '</span>';
    }
    if (!sched && !log) sub = '<span class="mv-muted">Not scheduled today — log anyway?</span>';
    rows += '<div class="mv-row' + (!sched && !log ? ' mv-row-off' : '') + '">'
      + '<button class="mv-circle' + cls + '" onclick="mvCircleTap(\'' + kind + '\')" aria-label="Check off ' + title + '">' + sym + '</button>'
      + '<div class="mv-row-body" onclick="openMvLogSheet(\'' + kind + '\')">'
      + '<div class="mv-row-title">' + title + '</div><div class="mv-row-sub">' + sub + '</div></div>'
      + '<div class="arrow" onclick="openMvLogSheet(\'' + kind + '\')">›</div></div>'
      + mvStripHtml(kind, t);
  });
  rows += mvTestRowHtml();   // Phase 3: retest / check-up row (only when something is due)
  slot.innerHTML = '<div class="card mv-card">'
    + '<div class="mv-card-hdr"><span class="card-label" style="margin:0">Today · ' + mvEsc(dateLbl) + '</span>'
    + '<button class="mv-gear" onclick="openMovement()" aria-label="Movement settings">⚙</button></div>'
    + rows + '</div>';
}

function mvStripHtml(kind, t) {
  const mon = mvMonday(t);
  const rows = mvRows(kind, mon, mvAddDays(mon, 6));
  const letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const glyph = { done: '●', partial: '◐', excused: '✕', missed: '○', today: '○', future: '○', off: '·' };
  return '<div class="mv-strip">' + rows.map(function (r, i) {
    const s = mvStripSymbol(r, t);
    const age = mvDaysBetween(r.date, t);
    const tappable = age >= 0 && age <= MV_BACKFILL_DAYS;
    return '<div class="mv-strip-day' + (r.date === t ? ' mv-strip-today' : '') + (tappable ? ' tap' : '') + '"'
      + (tappable ? ' onclick="openMvLogSheet(\'' + kind + '\',\'' + r.date + '\')"' : '') + '>'
      + '<span class="mv-strip-l">' + letters[i] + '</span><span class="mv-sym mv-sym-' + s + '">' + glyph[s] + '</span></div>';
  }).join('') + '</div>';
}

async function mvCircleTap(kind) {
  const t = mvToday();
  const log = mvLog(kind, t);
  if (log) {
    showConfirm('Un-check ' + (kind === 'walk' ? 'today\'s walk' : 'today\'s mobility') + '?',
      'This removes today\'s log.', 'Remove', function () { mvDeleteLog(kind, t); }, true);
    return;
  }
  const plan = mvPlan(kind);
  if (kind === 'walk') {
    const mins = plan ? plan.target_minutes : 20;
    const ok = await mvSaveLog({ kind: 'walk', date: t, status: 'done', minutes: mins });
    if (ok) toast('Walk logged · ' + mins + ' min — tap the row to edit');
  } else {
    const r = mvRoutineFor(t);
    if (!r.items.length) { openMvLogSheet('mobility'); return; }
    const ok = await mvSaveLog({ kind: 'mobility', date: t, status: 'done', minutes: r.minutes,
      routine: r.items.map(function (i) { return { name: i.name, region: i.region, slot: i.slot, level: i.level, checked: true }; }) });
    if (ok) toast('Mobility logged · ~' + r.minutes + ' min');
  }
}

async function mvSaveLog(o) {
  const plan = mvPlanOn(MV.plans, o.kind, o.date);
  const row = {
    athlete_id: S.athlete.id, log_date: o.date, kind: o.kind, status: o.status,
    minutes: o.minutes == null ? null : Number(o.minutes), was_scheduled: mvIsScheduled(plan, o.date),
    routine: o.routine || null, pain_flag: !!o.painFlag, pain_region: o.painFlag ? (o.painRegion || null) : null,
    notes: o.notes || null, updated_at: new Date().toISOString(),
  };
  const ok = await mvWrite('movement_log_upsert', row);
  if (!ok) return false;
  MV.logs = MV.logs.filter(function (l) { return !(l.kind === o.kind && l.log_date === o.date); }).concat([row]);
  if (row.pain_flag && row.pain_region) await mvLevelDownForPain(row.pain_region);
  await mvSaveCache();
  mvPaintCard();
  return true;
}

async function mvDeleteLog(kind, ds) {
  const ok = await mvWrite('movement_log_delete', { athlete_id: S.athlete.id, log_date: ds, kind: kind });
  if (!ok) return;
  MV.logs = MV.logs.filter(function (l) { return !(l.kind === kind && l.log_date === ds); });
  await mvSaveCache();
  mvPaintCard();
  toast('Removed');
}

// Any movement-log pain flag in a region → that region's focus area drops to L1.
async function mvLevelDownForPain(painRegion) {
  const keys = mvRegionsForPain(painRegion);
  const hits = MV.areas.filter(function (a) { return a.is_active !== false && keys.indexOf(a.region) !== -1 && Number(a.level) > 1; });
  for (let i = 0; i < hits.length; i++) {
    await mvWriteArea(hits[i].region, { level: 1, started_on: mvToday(), drill_mobility: null, drill_control: null }, true);
    toast(mvRegion(hits[i].region).label + ' back to level 1 after the pain flag', 3500);
  }
}

// ── Log sheets (walk + mobility) ────────────────────────────────────────────

function openMvLogSheet(kind, ds) {
  const t = mvToday();
  ds = ds || t;
  const age = mvDaysBetween(ds, t);
  if (age < 0 || age > MV_BACKFILL_DAYS) { toast('You can log today and the 6 days before'); return; }
  const log = mvLog(kind, ds);
  const plan = mvPlanOn(MV.plans, kind, ds) || mvPlan(kind);
  const st = {
    kind: kind, date: ds, existing: !!log,
    status: log ? log.status : 'done',
    minutes: log && log.minutes != null ? Number(log.minutes) : (plan ? plan.target_minutes : 20),
    painFlag: !!(log && log.pain_flag), painRegion: log ? log.pain_region : null,
    notes: log ? (log.notes || '') : '', plan: plan,
  };
  if (kind === 'mobility') {
    const r = mvRoutineFor(ds);
    st.routineInfo = r;
    if (log && Array.isArray(log.routine) && log.routine.length) {
      st.items = log.routine.map(function (x) {
        const d = MV.drillMap.filter(function (m) { return m.name === x.name && m.region === x.region; })[0] || {};
        return { name: x.name, region: x.region, slot: x.slot, level: x.level, dose: d.dose || '', cue: d.cue || '', minutes: d.minutes || 1, checked: !!x.checked };
      });
    } else {
      st.items = r.items.map(function (i) { return Object.assign({}, i, { checked: false }); });
    }
  }
  MV.sheet = st;
  mvRenderSheet();
  document.getElementById('mv-overlay').classList.add('open');
  document.getElementById('mv-sheet').classList.add('open');
}

function closeMvSheet() {
  mvStopTimers();
  mvTiltStop();
  const hadTest = !!MV.test;
  MV.test = null;
  if (hadTest && MV.loaded && document.getElementById('mv-body')) mvRenderScreen();
  document.getElementById('mv-overlay').classList.remove('open');
  document.getElementById('mv-sheet').classList.remove('open');
  MV.sheet = null;
}

function mvDateLabel(ds) {
  const t = mvToday();
  if (ds === t) return 'Today';
  if (ds === mvAddDays(t, -1)) return 'Yesterday';
  return new Date(mvUtc(ds) + 12 * 3600000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function mvPainBlockHtml(st) {
  const regions = (typeof PAIN_REGIONS !== 'undefined' ? PAIN_REGIONS : ['Hip', 'Knee', 'Low Back', 'Shoulder', 'Ankle', 'Neck', 'Upper Back', 'Wrist', 'Elbow'])
    .filter(function (r) { return r !== 'Other'; });
  return '<div class="triage-chips" style="margin-top:12px">'
    + '<button class="triage-chip' + (st.painFlag ? ' active' : '') + '" onclick="mvTogglePain()">⚠ Something hurt</button></div>'
    + (st.painFlag ? '<div class="triage-chips" style="margin-top:8px">' + regions.map(function (r) {
      return '<button class="triage-chip' + (st.painRegion === r ? ' active' : '') + '" onclick="mvSetPainRegion(\'' + r + '\')">' + r + '</button>';
    }).join('') + '</div>' : '');
}

function mvRenderSheet() {
  const st = MV.sheet;
  if (!st) return;
  const title = document.getElementById('mv-sheet-title');
  const body = document.getElementById('mv-sheet-body');
  const when = mvDateLabel(st.date);
  const sched = mvIsScheduled(st.plan, st.date);
  let h = '';
  if (!sched) h += '<div class="mv-note">Not a scheduled day — this counts as a bonus.</div>';
  if (st.kind === 'walk') {
    title.textContent = 'Walk · ' + when;
    if (st.plan && st.plan.notes) h += '<div class="mv-coach-note">Coach: ' + mvEsc(st.plan.notes) + '</div>';
    h += '<div class="form-section-label">Minutes</div>'
      + '<div class="mv-stepper"><button onclick="mvSheetMinutes(-5)">−5</button><span id="mv-sheet-min">' + st.minutes + '</span><button onclick="mvSheetMinutes(5)">+5</button></div>'
      + '<div class="triage-chips" style="margin-top:12px">'
      + [['done', 'Done'], ['partial', 'Partial'], ['excused', 'Rest day']].map(function (o) {
        return '<button class="triage-chip' + (st.status === o[0] ? ' active' : '') + '" onclick="mvSheetStatus(\'' + o[0] + '\')">' + o[1] + '</button>';
      }).join('') + '</div>'
      + mvPainBlockHtml(st)
      + '<textarea id="mv-sheet-notes" class="sheet-search mv-notes" placeholder="Notes (optional)" oninput="MV.sheet.notes=this.value">' + mvEsc(st.notes) + '</textarea>'
      + '<button class="btn" onclick="mvSubmitSheet()">Save</button>';
  } else {
    const r = st.routineInfo;
    title.textContent = 'Mobility · ' + when;
    const head = r.mode === 'targeted'
      ? r.regions.map(function (x) { return x.label + ' <span class="mv-lvl">L' + x.level + '</span>'; }).join(' + ')
      : 'General flow ' + (r.flow === 'flow_a' ? 'A' : 'B');
    const mins = Math.round(st.items.reduce(function (s, i) { return s + Number(i.minutes || 0); }, 0));
    h += '<div class="mv-sheet-head">' + head + ' · ~' + mins + ' min</div>';
    r.paused.forEach(function (p) {
      h += '<div class="mv-paused">⏸ ' + mvEsc(p.label) + ' paused — ' + mvEsc(p.reason) + '. '
        + '<a onclick="closeMvSheet();openPainSheet()">Open 🚩 Pain</a></div>';
    });
    r.notes.forEach(function (n) { h += '<div class="mv-note">' + mvEsc(n) + '</div>'; });
    h += mvLevelUpOffersHtml();
    if (!MV.drillMap.length) h += '<div class="mv-note">The drill library hasn\'t synced yet — ask your coach to run sync_mobility.py.</div>';
    if (!st.items.length && MV.drillMap.length) h += '<div class="mv-note">No drills today. Add focus areas in 🚶 Movement, or switch to General flow.</div>';
    h += st.items.map(function (it, idx) {
      const hold = mvParseHoldSeconds(it.dose);
      const canSwap = r.mode === 'targeted' && !it.isOpener && (it.slot === 'mobility' || it.slot === 'control');
      return '<div class="mv-drill' + (it.checked ? ' mv-drill-done' : '') + '">'
        + '<button class="mv-check" onclick="mvToggleDrill(' + idx + ')">' + (it.checked ? '✓' : '') + '</button>'
        + '<div class="mv-drill-body"><div class="mv-drill-name">' + mvEsc(it.name) + '</div>'
        + '<div class="mv-drill-dose">' + mvEsc(it.dose) + ' · <span class="mv-tag">' + mvEsc(it.isOpener ? 'opener' : mvRegion(it.region).label) + '</span></div>'
        + '<div class="mv-drill-cue">' + mvEsc(it.cue) + '</div>'
        + '<div class="mv-drill-actions">'
        + (hold ? '<button class="mv-mini" id="mv-timer-' + idx + '" onclick="mvHoldTimer(' + idx + ',' + hold + ')">⏱ ' + hold + ' s</button>' : '')
        + (canSwap ? '<button class="mv-mini" onclick="mvOpenSwap(\'' + it.region + '\',\'' + it.slot + '\')">Swap</button>' : '')
        + '</div></div></div>';
    }).join('');
    const all = st.items.length > 0 && st.items.every(function (i) { return i.checked; });
    h += mvPainBlockHtml(st)
      + '<textarea id="mv-sheet-notes" class="sheet-search mv-notes" placeholder="Notes (optional)" oninput="MV.sheet.notes=this.value">' + mvEsc(st.notes) + '</textarea>'
      + '<button class="btn" onclick="mvSubmitSheet()"' + (st.items.some(function (i) { return i.checked; }) ? '' : ' disabled') + '>' + (all ? 'Done' : 'Save as partial') + '</button>'
      + '<button class="btn secondary" onclick="mvSubmitSheet(\'excused\')">Rest day</button>';
  }
  if (st.existing) h += '<button class="btn secondary mv-remove" onclick="mvRemoveFromSheet()">Remove this log</button>';
  body.innerHTML = h;
}

function mvSheetMinutes(d) { const st = MV.sheet; st.minutes = Math.max(0, Math.min(240, Number(st.minutes || 0) + d)); document.getElementById('mv-sheet-min').textContent = st.minutes; }
function mvSheetStatus(s) { MV.sheet.status = s; mvRenderSheet(); }
function mvTogglePain() { MV.sheet.painFlag = !MV.sheet.painFlag; if (!MV.sheet.painFlag) MV.sheet.painRegion = null; mvRenderSheet(); }
function mvSetPainRegion(r) { MV.sheet.painRegion = r; mvRenderSheet(); }
function mvToggleDrill(i) { const it = MV.sheet.items[i]; it.checked = !it.checked; mvRenderSheet(); }

function mvRemoveFromSheet() {
  const st = MV.sheet;
  showConfirm('Remove this log?', mvDateLabel(st.date) + ' — ' + st.kind, 'Remove', async function () {
    await mvDeleteLog(st.kind, st.date);
    closeMvSheet();
  }, true);
}

async function mvSubmitSheet(forceStatus) {
  const st = MV.sheet;
  if (!st) return;
  if (st.painFlag && !st.painRegion) { toast('Pick where it hurt'); return; }
  let status = forceStatus || st.status, minutes = st.minutes, routine = null;
  if (st.kind === 'walk') {
    if ((status === 'done' || status === 'partial') && !(Number(minutes) > 0)) { toast('Add minutes'); return; }
    if (status === 'excused') minutes = null;
  } else {
    routine = st.items.map(function (i) { return { name: i.name, region: i.region, slot: i.slot, level: i.level, checked: !!i.checked }; });
    if (status !== 'excused') {
      const all = st.items.length && st.items.every(function (i) { return i.checked; });
      status = all ? 'done' : 'partial';
      minutes = Math.round(st.items.filter(function (i) { return i.checked; }).reduce(function (s, i) { return s + Number(i.minutes || 0); }, 0));
    } else minutes = null;
  }
  const painRegion = st.painFlag ? st.painRegion : null;
  const ok = await mvSaveLog({ kind: st.kind, date: st.date, status: status, minutes: minutes, routine: routine,
    painFlag: st.painFlag, painRegion: painRegion, notes: st.notes });
  if (!ok) return;
  closeMvSheet();
  toast(status === 'excused' ? 'Rest day logged' : 'Saved ✓');
  if (painRegion) {
    showConfirm('Log this in Pain now?', 'Opening a pain episode lets your coach see it and keeps your plan safe.',
      'Log pain', function () { mvOpenPainFor(painRegion); });
  }
}

function mvOpenPainFor(regionName) {
  Promise.resolve(openPainSheet({ newForm: true })).then(function () {
    const sel = document.getElementById('pain-region');
    if (sel && regionName) {
      sel.value = regionName;
      try { renderTriageBlock(); } catch (_) {}
    }
  });
}

// Hold timer — reuses the rest-timer beep() from session.js.
function mvHoldTimer(idx, secs) {
  try { ensureAudio(); } catch (_) {}
  const id = 'mv-timer-' + idx;
  if (MV.timers[id]) { clearInterval(MV.timers[id]); delete MV.timers[id]; const b0 = document.getElementById(id); if (b0) b0.textContent = '⏱ ' + secs + ' s'; return; }
  let left = secs;
  const tick = function () {
    const b = document.getElementById(id);
    if (!b) { clearInterval(MV.timers[id]); delete MV.timers[id]; return; }
    b.textContent = '⏱ ' + left + ' s';
    if (left <= 0) {
      clearInterval(MV.timers[id]); delete MV.timers[id];
      b.textContent = '✓ ' + secs + ' s';
      try { beep(2); } catch (_) {}
    }
    left--;
  };
  tick();
  MV.timers[id] = setInterval(tick, 1000);
}
function mvStopTimers() { Object.keys(MV.timers).forEach(function (k) { clearInterval(MV.timers[k]); }); MV.timers = {}; }

// Swap picker (targeted mode) — same region + slot, any level ≤ the area's.
function mvOpenSwap(region, slot) {
  const area = MV.areas.filter(function (a) { return a.region === region; })[0];
  if (!area) return;
  const ex = mvExclusions(MV.cautions, (S && S.openInjuries) || []);
  const equip = mvEquipment();
  const cands = mvRegionDrills(MV.drillMap, region, slot)
    .filter(function (d) { return d.level <= Math.max(1, Number(area.level || 1)); })
    .sort(function (a, b) { return a.level - b.level || a.sort_order - b.sort_order; });
  const cur = slot === 'mobility' ? area.drill_mobility : area.drill_control;
  const back = MV.sheet ? 'mvRenderSheet()' : 'mvCloseSwap()';
  document.getElementById('mv-sheet-title').textContent = 'Swap · ' + mvRegion(region).label + ' ' + slot;
  document.getElementById('mv-sheet-body').innerHTML = cands.map(function (d) {
    const why = mvDrillBlock(d, ex) || (mvEquipOk(d, equip) ? null : 'equipment');
    return '<div class="mv-swap' + (why ? ' mv-swap-off' : '') + (d.name === cur ? ' mv-swap-cur' : '') + '"'
      + ' onclick="mvChooseSwap(\'' + region + '\',\'' + slot + '\',\'' + mvEsc(d.name).replace(/&#39;/g, "\\'") + '\')">'
      + '<div class="mv-drill-name">' + mvEsc(d.name) + ' <span class="mv-lvl">L' + d.level + '</span></div>'
      + '<div class="mv-drill-dose">' + mvEsc(d.dose) + (why ? ' · ' + MV_BLOCK_WORDS[why] : '') + '</div>'
      + '<div class="mv-drill-cue">' + mvEsc(d.cue) + '</div></div>';
  }).join('')
    + '<button class="btn secondary" onclick="mvChooseSwap(\'' + region + '\',\'' + slot + '\',null)">Use the default</button>'
    + '<button class="btn secondary" onclick="' + back + '">Back</button>';
  if (!MV.sheet) {
    document.getElementById('mv-overlay').classList.add('open');
    document.getElementById('mv-sheet').classList.add('open');
  }
}
function mvCloseSwap() {
  document.getElementById('mv-overlay').classList.remove('open');
  document.getElementById('mv-sheet').classList.remove('open');
}

async function mvChooseSwap(region, slot, name) {
  const patch = slot === 'mobility' ? { drill_mobility: name } : { drill_control: name };
  await mvWriteArea(region, patch);
  if (MV.sheet && MV.sheet.kind === 'mobility') {
    const r = mvRoutineFor(MV.sheet.date);
    const checked = {};
    MV.sheet.items.forEach(function (i) { if (i.checked) checked[i.name] = true; });
    MV.sheet.routineInfo = r;
    MV.sheet.items = r.items.map(function (i) { return Object.assign({}, i, { checked: !!checked[i.name] }); });
    mvRenderSheet();
  } else {
    mvCloseSwap();
    mvRenderScreen();
  }
  mvPaintCard();
}

// Level-up offers (every region, including coach-recommended ones).
function mvLevelUpOffersHtml() {
  const t = mvToday();
  const rows = mvRows('mobility', mvAddDays(t, -15), t);
  let declines = MV.levelDeclines || {};
  return MV.areas.filter(function (a) { return a.is_active !== false; }).map(function (a) {
    const c = mvLevelUpCheck(a, rows, MV.logs, (S && S.openInjuries) || [], t);
    if (!c.eligible) return '';
    if (declines[a.region] && mvDaysBetween(declines[a.region], t) < 7) return '';
    return '<div class="mv-levelup">' + mvEsc(mvRegion(a.region).label) + ': ' + c.days + ' days at ' + c.pct + '% — ready for level ' + (Number(a.level) + 1) + '?'
      + '<div class="mv-levelup-btns"><button class="mv-mini" onclick="mvLevelUp(\'' + a.region + '\')">Level up</button>'
      + '<button class="mv-mini" onclick="mvDeclineLevelUp(\'' + a.region + '\')">Not yet</button></div></div>';
  }).join('');
}
async function mvLevelUp(region) {
  const a = MV.areas.filter(function (x) { return x.region === region; })[0];
  if (!a) return;
  const next = Math.min(3, Number(a.level) + 1);
  await mvWriteArea(region, { level: next, started_on: mvToday(), drill_mobility: null, drill_control: null });
  toast(mvRegion(region).label + ' → level ' + next);
  if (MV.sheet) { const s = MV.sheet; openMvLogSheet(s.kind, s.date); } else mvRenderScreen();
  mvPaintCard();
}
async function mvDeclineLevelUp(region) {
  MV.levelDeclines = MV.levelDeclines || {};
  MV.levelDeclines[region] = mvToday();
  try { await idbSet('mvLevelDeclines', MV.levelDeclines); } catch (_) {}
  if (MV.sheet) mvRenderSheet(); else mvRenderScreen();
}

// ── Movement screen (🚶 button) — the control center ────────────────────────

async function openMovement() {
  showScreen('movement');
  const body = document.getElementById('mv-body');
  if (!MV.loaded) { body.innerHTML = '<div class="spinner">Loading…</div>'; await loadMovement(); }
  else if (!isOffline) loadMovement().then(mvRenderScreen).catch(function () {});
  try { MV.levelDeclines = (await idbGet('mvLevelDeclines')) || {}; } catch (_) {}
  mvRenderScreen();
}
function closeMovement() { MV.addArea = null; if (typeof renderWeek === 'function') renderWeek(); else showScreen('week'); }

const MV_DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function mvDaysChips(kind, days) {
  return '<div class="mv-days">' + MV_DAY_LETTERS.map(function (l, i) {
    const on = (days || []).map(Number).indexOf(i + 1) !== -1;
    return '<button class="mv-daychip' + (on ? ' on' : '') + '" onclick="mvToggleDay(\'' + kind + '\',' + (i + 1) + ')">' + l + '</button>';
  }).join('') + '</div>';
}
function mvSwitch(kind, on) {
  return '<button class="mv-switch' + (on ? ' on' : '') + '" onclick="mvToggleHabit(\'' + kind + '\')" aria-label="Turn ' + kind + (on ? ' off' : ' on') + '"><span></span></button>';
}

function mvRenderScreen() {
  const body = document.getElementById('mv-body');
  if (!body) return;
  if (MV.unavailable) {
    body.innerHTML = '<div class="card"><div class="card-title">Almost ready</div><div class="card-sub">Daily Movement needs a one-time database update. Ask your coach to run the migration, then reopen this screen.</div></div>';
    return;
  }
  const walk = mvPlan('walk'), mob = mvPlan('mobility');
  let h = '';
  // Phase 2 adds the coach recommendation banner here.
  if (typeof mvRecBannerHtml === 'function') h += mvRecBannerHtml();
  if (!walk && !mob && !mvPendingRec()) {
    h += '<div class="card mv-quick"><div class="card-title" style="font-size:16px">Start simple</div>'
      + '<div class="card-sub" style="margin:4px 0 12px">Walk 20 min + General mobility 10 min, every day. You can change anything after.</div>'
      + '<button class="btn" onclick="mvQuickStart()">Turn on both</button></div>';
  }

  // Walk
  h += '<div class="card"><div class="mv-sec-hdr"><div class="card-title" style="font-size:16px">🚶 Walk</div>' + mvSwitch('walk', !!walk) + '</div>';
  if (walk) {
    if (walk.notes) h += '<div class="mv-coach-note">Coach: ' + mvEsc(walk.notes) + '</div>';
    h += '<div class="form-section-label">Days</div>' + mvDaysChips('walk', walk.schedule_days)
      + '<div class="form-section-label">Target minutes</div>'
      + '<div class="mv-stepper"><button onclick="mvPlanMinutes(\'walk\',-5)">−5</button><span>' + walk.target_minutes + '</span><button onclick="mvPlanMinutes(\'walk\',5)">+5</button></div>';
  } else h += '<div class="card-sub">Off</div>';
  h += '</div>';

  // Mobility
  h += '<div class="card"><div class="mv-sec-hdr"><div class="card-title" style="font-size:16px">🧘 Mobility</div>' + mvSwitch('mobility', !!mob) + '</div>';
  if (mob) {
    if (mob.notes) h += '<div class="mv-coach-note">Coach: ' + mvEsc(mob.notes) + '</div>';
    h += '<div class="form-section-label">Days</div>' + mvDaysChips('mobility', mob.schedule_days)
      + '<div class="form-section-label">Minutes</div><div class="triage-chips">'
      + [8, 10, 15].map(function (m) {
        return '<button class="triage-chip' + (Number(mob.target_minutes) === m ? ' active' : '') + '" onclick="mvSetMobMinutes(' + m + ')">' + m + ' min</button>';
      }).join('') + '</div>'
      + '<div class="form-section-label">What to work on</div><div class="triage-chips">'
      + '<button class="triage-chip' + (mob.mode !== 'targeted' ? ' active' : '') + '" onclick="mvSetMode(\'general\')">General flow</button>'
      + '<button class="triage-chip' + (mob.mode === 'targeted' ? ' active' : '') + '" onclick="mvSetMode(\'targeted\')">My focus areas</button></div>';
    if (mob.mode === 'targeted') h += mvAreasHtml();
    else h += '<div class="card-sub" style="margin-top:8px">Two ~10-minute whole-body flows that alternate by day.</div>';
  } else h += '<div class="card-sub">Off</div>';
  h += '</div>';

  h += mvScreensCardHtml();
  if (typeof mvCautionsHtml === 'function') h += mvCautionsHtml();

  // Equipment
  const eq = mvEquipment();
  h += '<div class="card"><div class="card-title" style="font-size:16px">Equipment I have</div>'
    + '<div class="card-sub" style="margin-bottom:8px">Bodyweight, a wall and a chair or bench are always assumed.</div><div class="triage-chips">'
    + MV_TOGGLE_EQUIP.map(function (e) {
      return '<button class="triage-chip' + (eq.indexOf(e) !== -1 ? ' active' : '') + '" onclick="mvToggleEquip(\'' + e + '\')">' + e.charAt(0).toUpperCase() + e.slice(1) + '</button>';
    }).join('') + '</div></div>';

  // Help
  h += '<div class="card mv-help"><div class="card-title" style="font-size:16px">ⓘ How this works</div><ul>'
    + '<li><b>Daily</b> areas show up every scheduled day — best for a real range limit you want to change.</li>'
    + '<li><b>Rotating</b> areas take turns, one per day, so each gets 2–3 visits a week.</li>'
    + '<li>Each area gets one range drill and one control drill, so new range is usable. Keep drills the same for at least 2 weeks.</li>'
    + '<li><b>Pain rule:</b> keep it at 2/10 or less, with no increase next morning. If an area has an open pain episode at 6/10 or more, or nerve symptoms, it pauses by itself.</li>'
    + '<li>Honest note: stretching doesn\'t prevent injuries, and full-range strength training improves flexibility about as well. This is a short habit for range and comfort, not a cure-all.</li>'
    + '<li>Missed days are fine. Rest days don\'t count against you.</li></ul></div>';

  body.innerHTML = h;
}

function mvAreasHtml() {
  const t = mvToday();
  const ex = mvExclusions(MV.cautions, (S && S.openInjuries) || []);
  const active = MV.areas.filter(function (a) { return a.is_active !== false; })
    .sort(function (a, b) { return MV_REGION_ORDER.indexOf(a.region) - MV_REGION_ORDER.indexOf(b.region); });
  const equip = mvEquipment();
  let h = '<div class="form-section-label">Focus areas</div>';
  if (!active.length) h += '<div class="card-sub">No areas yet. Add up to 2 daily and 3 rotating.</div>';
  active.forEach(function (a) {
    const lvl = Number(a.level || 1);
    const pain = ex.red[a.region] ? '<div class="mv-paused">⏸ Paused — ' + (ex.red[a.region].neuro ? 'nerve symptoms flagged' : 'open pain episode ' + ex.red[a.region].score + '/10') + '</div>'
      : ex.amber[a.region] ? '<div class="mv-note">Held at level 1 — open pain episode ' + ex.amber[a.region].score + '/10</div>' : '';
    const mob = mvPickDrill(MV.drillMap, a.region, 'mobility', ex.amber[a.region] ? 1 : lvl, a.drill_mobility, ex, equip, {}).drill;
    const con = mvPickDrill(MV.drillMap, a.region, 'control', ex.amber[a.region] ? 1 : lvl, a.drill_control, ex, equip, {}).drill;
    h += '<div class="mv-area">'
      + '<div class="mv-area-top"><div class="mv-area-name">' + mvEsc(mvRegion(a.region).label)
      + (a.source === 'coach_rec' ? ' <span class="mv-coach-tag">Coach recommended</span>' : '') + '</div>'
      + '<button class="mv-x" onclick="mvRemoveArea(\'' + a.region + '\')" aria-label="Remove">✕</button></div>'
      + (a.why ? '<div class="mv-area-why">' + mvEsc(a.why) + '</div>' : '')
      + pain
      + '<div class="mv-area-ctrls"><div class="triage-chips">'
      + '<button class="triage-chip' + (a.priority === 'daily' ? ' active' : '') + '" onclick="mvAreaPriority(\'' + a.region + '\',\'daily\')">Daily</button>'
      + '<button class="triage-chip' + (a.priority === 'rotating' ? ' active' : '') + '" onclick="mvAreaPriority(\'' + a.region + '\',\'rotating\')">Rotating</button></div>'
      + '<div class="mv-stepper mv-stepper-sm"><button onclick="mvAreaLevel(\'' + a.region + '\',-1)">−</button><span>Level ' + lvl + '</span><button onclick="mvAreaLevel(\'' + a.region + '\',1)">+</button></div></div>'
      + '<div class="mv-area-drills">'
      + '<div class="mv-area-drill" onclick="mvOpenSwap(\'' + a.region + '\',\'mobility\')"><span class="mv-slot">Range</span> ' + mvEsc(mob ? mob.name : '—') + ' ›</div>'
      + '<div class="mv-area-drill" onclick="mvOpenSwap(\'' + a.region + '\',\'control\')"><span class="mv-slot">Control</span> ' + mvEsc(con ? con.name : '—') + ' ›</div>'
      + '<div class="mv-area-meta">' + Math.max(0, mvDaysBetween(a.started_on, t)) + ' days on this level</div></div>' + mvAreaScreenLineHtml(a.region) + '</div>';
  });
  // Add-area flow
  const st = MV.addArea;
  if (!st) {
    h += '<button class="add-ex-btn" onclick="mvAddAreaStart()" style="margin-top:8px">＋ Add area</button>';
  } else if (!st.region) {
    const taken = active.map(function (a) { return a.region; });
    h += '<div class="mv-add"><div class="triage-q">Which area?</div><div class="triage-chips">'
      + MV_REGIONS.filter(function (r) { return taken.indexOf(r.key) === -1; }).map(function (r) {
        return '<button class="triage-chip" onclick="mvAddAreaPick(\'' + r.key + '\')">' + r.label + '</button>';
      }).join('') + '</div><button class="mv-mini" onclick="mvAddAreaCancel()">Cancel</button></div>';
  } else if (st.painful == null) {
    h += '<div class="mv-add"><div class="triage-q">Is your ' + mvEsc(mvRegion(st.region).label.toLowerCase()) + ' area painful right now?</div>'
      + '<div class="triage-chips"><button class="triage-chip" onclick="mvAddAreaPainful(true)">Yes</button>'
      + '<button class="triage-chip" onclick="mvAddAreaPainful(false)">No</button></div>'
      + '<button class="mv-mini" onclick="mvAddAreaCancel()">Cancel</button></div>';
  } else {
    h += '<div class="mv-add"><div class="triage-q">Daily or rotating?</div>'
      + '<div class="card-sub"><b>Daily</b>: every scheduled day — for a range limit you want to change.<br><b>Rotating</b>: takes turns with other areas — for general upkeep.</div>'
      + '<div class="triage-chips" style="margin-top:8px"><button class="triage-chip" onclick="mvAddAreaPriority(\'daily\')">Daily</button>'
      + '<button class="triage-chip" onclick="mvAddAreaPriority(\'rotating\')">Rotating</button></div>'
      + '<button class="mv-mini" onclick="mvAddAreaCancel()">Cancel</button></div>';
  }
  // Coach-suggested areas the athlete removed
  const removed = MV.areas.filter(function (a) { return a.is_active === false && a.source === 'coach_rec'; });
  if (removed.length) {
    h += '<div class="form-section-label">Coach suggested — not in your plan</div>' + removed.map(function (a) {
      return '<div class="mv-area mv-area-off"><span>' + mvEsc(mvRegion(a.region).label) + '</span>'
        + '<button class="mv-mini" onclick="mvAreaAddBack(\'' + a.region + '\')">Add back</button></div>';
    }).join('');
  }
  return h;
}

// ── Plan writes (debounced per kind; the UI updates immediately) ──
function mvPlanDefaults(kind) {
  const last = mvLastPlan(MV.plans, kind);
  if (last) return { days: (last.schedule_days || [1, 2, 3, 4, 5, 6, 7]).map(Number), minutes: last.target_minutes,
    mode: kind === 'mobility' ? (last.mode || 'general') : null, notes: last.notes || null, equipment: last.equipment || [] };
  return kind === 'walk' ? { days: [1, 2, 3, 4, 5, 6, 7], minutes: 20, mode: null, notes: null, equipment: [] }
    : { days: [1, 2, 3, 4, 5, 6, 7], minutes: 10, mode: 'general', notes: null, equipment: [] };
}

function mvSavePlan(kind, patch, enabled) {
  const cur = mvPlan(kind);
  const base = cur ? { days: (cur.schedule_days || []).map(Number), minutes: cur.target_minutes, mode: cur.mode,
    notes: cur.notes || null, equipment: cur.equipment || [] } : mvPlanDefaults(kind);
  const a = Object.assign({ kind: kind, enabled: enabled !== false, today: mvToday(), athleteId: S.athlete.id }, base, patch || {});
  MV.plans = mvApplyPlanLocal(MV.plans, a);
  mvSaveCache();
  clearTimeout(MV.planTimers[kind]);
  MV.planTimers[kind] = setTimeout(function () {
    const p = mvPlan(kind);
    const params = p ? {
      p_kind: kind, p_enabled: true, p_days: (p.schedule_days || []).map(Number), p_minutes: p.target_minutes,
      p_mode: p.mode || null, p_notes: p.notes || null, p_today: mvToday(), p_equipment: p.equipment || [],
    } : { p_kind: kind, p_enabled: false, p_days: null, p_minutes: null, p_mode: null, p_notes: null, p_today: mvToday(), p_equipment: null };
    mvWrite('movement_plan_write', params);
  }, 700);
  mvRenderScreen();
  mvPaintCard();
}

function mvToggleHabit(kind) {
  if (mvPlan(kind)) {
    showConfirm('Turn ' + kind + ' off?', 'Your history stays. You can turn it back on anytime.', 'Turn off',
      function () { mvSavePlan(kind, null, false); toast(kind === 'walk' ? 'Walk off' : 'Mobility off'); });
  } else {
    mvSavePlan(kind, {}, true);
    toast(kind === 'walk' ? 'Walk on' : 'Mobility on');
  }
}
function mvQuickStart() {
  mvSavePlan('walk', { days: [1, 2, 3, 4, 5, 6, 7], minutes: 20 }, true);
  mvSavePlan('mobility', { days: [1, 2, 3, 4, 5, 6, 7], minutes: 10, mode: 'general' }, true);
  toast('Walk + mobility on — see your Today card');
}
function mvToggleDay(kind, d) {
  const p = mvPlan(kind); if (!p) return;
  let days = (p.schedule_days || []).map(Number);
  days = days.indexOf(d) !== -1 ? days.filter(function (x) { return x !== d; }) : days.concat([d]);
  if (!days.length) { toast('Keep at least one day — or turn it off'); return; }
  mvSavePlan(kind, { days: days.sort() });
}
function mvPlanMinutes(kind, delta) {
  const p = mvPlan(kind); if (!p) return;
  mvSavePlan(kind, { minutes: Math.max(5, Math.min(120, Number(p.target_minutes) + delta)) });
}
function mvSetMobMinutes(m) { mvSavePlan('mobility', { minutes: m }); }
function mvSetMode(m) { mvSavePlan('mobility', { mode: m }); }
function mvToggleEquip(e) {
  const eq = mvEquipment().slice();
  const next = eq.indexOf(e) !== -1 ? eq.filter(function (x) { return x !== e; }) : eq.concat([e]);
  if (mvPlan('mobility')) mvSavePlan('mobility', { equipment: next });
  else { toast('Turn mobility on first'); }
}

// ── Area writes ──
async function mvWriteArea(region, patch, silent) {
  const cur = MV.areas.filter(function (a) { return a.region === region; })[0];
  const t = mvToday();
  const row = Object.assign({
    athlete_id: S.athlete.id, region: region, priority: 'rotating', level: 1, source: 'athlete',
    athlete_edited: false, drill_mobility: null, drill_control: null, why: null, started_on: t, is_active: true,
  }, cur ? {
    priority: cur.priority, level: cur.level, source: cur.source, athlete_edited: cur.athlete_edited,
    drill_mobility: cur.drill_mobility, drill_control: cur.drill_control, why: cur.why || null,
    started_on: cur.started_on, is_active: cur.is_active !== false,
  } : {}, patch || {});
  if (cur && cur.source === 'coach_rec' && !silent) row.athlete_edited = true;
  row.updated_at = new Date().toISOString();
  const ok = await mvWrite('movement_area_write', row);
  if (!ok) return false;
  MV.areas = MV.areas.filter(function (a) { return a.region !== region; }).concat([Object.assign({}, cur || {}, row)]);
  await mvSaveCache();
  return true;
}

function mvCount(priority) {
  return MV.areas.filter(function (a) { return a.is_active !== false && a.priority === priority; }).length;
}
function mvAddAreaStart() { MV.addArea = {}; mvRenderScreen(); }
function mvAddAreaCancel() { MV.addArea = null; mvRenderScreen(); }
function mvAddAreaPick(r) { MV.addArea = { region: r, painful: null }; mvRenderScreen(); }
function mvAddAreaPainful(yes) {
  const r = MV.addArea.region;
  if (yes) {
    MV.addArea = null;
    mvRenderScreen();
    toast('Pain isn\'t a mobility problem — log it in 🚩 Pain', 3500);
    mvOpenPainFor(mvRegion(r).pain[0]);
    return;
  }
  MV.addArea.painful = false;
  mvRenderScreen();
}
async function mvAddAreaPriority(p) {
  const r = MV.addArea.region;
  if (mvCount(p) >= MV_CAPS[p]) {
    toast('You already have ' + MV_CAPS[p] + ' ' + p + ' areas — remove or switch one first', 3500);
    return;
  }
  const cur = MV.areas.filter(function (a) { return a.region === r; })[0];
  await mvWriteArea(r, { priority: p, level: 1, started_on: mvToday(), is_active: true, drill_mobility: null, drill_control: null,
    source: cur ? cur.source : 'athlete' });
  MV.addArea = null;
  mvRenderScreen();
  mvPaintCard();
}
async function mvAreaPriority(region, p) {
  const a = MV.areas.filter(function (x) { return x.region === region; })[0];
  if (!a || a.priority === p) return;
  if (mvCount(p) >= MV_CAPS[p]) { toast('Max ' + MV_CAPS[p] + ' ' + p + ' areas', 3000); return; }
  await mvWriteArea(region, { priority: p });
  mvRenderScreen(); mvPaintCard();
}
async function mvAreaLevel(region, d) {
  const a = MV.areas.filter(function (x) { return x.region === region; })[0];
  if (!a) return;
  const n = Math.max(1, Math.min(3, Number(a.level || 1) + d));
  if (n === Number(a.level)) return;
  await mvWriteArea(region, { level: n, started_on: mvToday(), drill_mobility: null, drill_control: null });
  mvRenderScreen(); mvPaintCard();
}
function mvRemoveArea(region) {
  showConfirm('Remove ' + mvRegion(region).label + '?', 'It leaves your routine. You can add it back later.', 'Remove', async function () {
    await mvWriteArea(region, { is_active: false });
    mvRenderScreen(); mvPaintCard();
  }, true);
}
async function mvAreaAddBack(region) {
  const a = MV.areas.filter(function (x) { return x.region === region; })[0];
  const p = a ? a.priority : 'rotating';
  if (mvCount(p) >= MV_CAPS[p]) { toast('Max ' + MV_CAPS[p] + ' ' + p + ' areas — remove one first', 3000); return; }
  await mvWriteArea(region, { is_active: true, started_on: mvToday() });
  mvRenderScreen(); mvPaintCard();
}

// ── Coach recommendation + cautions (Phase 2) ───────────────────────────────
// The coach only recommends. push_program.py auto-applies when the athlete
// never set a habit up or is still on the last coach plan; otherwise the
// recommendation waits here as 'pending' (dot on the 🚶 button). Cautions are
// soft: "Include anyway" is allowed and reported to the coach.

const MV_TAG_WORDS = {
  hip_endrange_flexion_ir: 'deep hip bending with inward rotation', deep_hip_flexion_loaded: 'deep loaded hip bending',
  deep_knee_flexion: 'deep knee bending', knee_loaded_endrange: 'loaded deep knee work',
  lumbar_endrange_flexion: 'full spine rounding', lumbar_endrange_extension: 'full back arching',
  shoulder_endrange_loaded: 'loaded overhead end range', shoulder_impingement_position: 'overhead reaching with inward rotation',
  wrist_flexor_stretch_loaded: 'loaded wrist and forearm stretches', grip_loaded: 'heavy gripping',
  calf_stretch_aggressive: 'hard calf stretches', achilles_loaded_endrange: 'loaded Achilles end range',
  neck_endrange: 'end-range neck movement',
};
const MV_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function mvDaysLabel(days) {
  const d = (days || []).map(Number).sort();
  if (d.length === 7) return 'every day';
  if (d.join(',') === '1,2,3,4,5') return 'Mon–Fri';
  return d.map(function (x) { return MV_DAY_NAMES[x - 1]; }).join(' ');
}

// ENGINE (pure): the pending parts of a recommendation as selectable changes.
function mvRecChanges(payload, plans, areas) {
  payload = payload || {};
  const dec = payload._decision || {};
  const out = [];
  ['walk', 'mobility'].forEach(function (kind) {
    const part = payload[kind];
    if (!part || (dec[kind] && dec[kind] !== 'pending')) return;
    const label = kind === 'walk' ? 'Walk' : 'Mobility';
    if (!part.enabled) {
      if (mvCurrentPlan(plans, kind)) out.push({ id: kind, type: 'plan', kind: kind, part: part, label: label + ': turn off', checked: true });
      return;
    }
    const mode = kind === 'mobility' ? (part.mode || ((part.areas || []).length ? 'targeted' : 'general')) : null;
    out.push({ id: kind, type: 'plan', kind: kind, part: part, mode: mode, checked: true,
      label: label + ': ' + mvDaysLabel(part.days) + ' · ' + part.target_minutes + ' min'
        + (kind === 'mobility' ? (mode === 'targeted' ? ' · focus areas' : ' · general flow') : '') });
    if (kind === 'mobility' && mode === 'targeted') {
      const recRegions = {};
      (part.areas || []).forEach(function (ra) {
        recRegions[ra.region] = true;
        const cur = (areas || []).filter(function (a) { return a.region === ra.region; })[0];
        const lvl = Number(ra.level || 1);
        const same = cur && cur.is_active !== false && cur.priority === ra.priority && Number(cur.level) === lvl
          && (cur.drill_mobility || null) === (ra.drill_mobility || null) && (cur.drill_control || null) === (ra.drill_control || null);
        if (same) return;
        const drills = [ra.drill_mobility, ra.drill_control].filter(Boolean).join(' + ');
        out.push({ id: 'area:' + ra.region, type: 'area', region: ra.region, rec: ra, checked: true,
          label: (cur && cur.is_active !== false ? 'Change ' : 'Add ') + mvRegion(ra.region).label + ' — ' + ra.priority + ', level ' + lvl
            + (drills ? ' (' + drills + ')' : ''), why: ra.why || null });
      });
      (areas || []).forEach(function (a) {
        if (a.is_active === false || recRegions[a.region]) return;
        out.push({ id: 'drop:' + a.region, type: 'drop', region: a.region, checked: false,
          label: 'Turn off ' + mvRegion(a.region).label + ' (not in the coach\'s plan)' });
      });
    }
  });
  return out;
}

async function mvApplyRecChange(ch) {
  const t = mvToday();
  if (ch.type === 'plan') {
    const p = ch.part;
    const prev = mvCurrentPlan(MV.plans, ch.kind) || mvLastPlan(MV.plans, ch.kind);
    const equipment = (prev && prev.equipment) || [];
    if (!p.enabled) {
      MV.plans = mvApplyPlanLocal(MV.plans, { kind: ch.kind, enabled: false, today: t, athleteId: S.athlete.id });
      return mvWrite('movement_plan_write', { p_kind: ch.kind, p_enabled: false, p_days: null, p_minutes: null,
        p_mode: null, p_notes: null, p_today: t, p_equipment: null, p_set_by: 'coach' });
    }
    MV.plans = mvApplyPlanLocal(MV.plans, { kind: ch.kind, enabled: true, days: p.days, minutes: p.target_minutes,
      mode: ch.mode, notes: p.notes || null, equipment: equipment, today: t, athleteId: S.athlete.id, setBy: 'coach' });
    return mvWrite('movement_plan_write', { p_kind: ch.kind, p_enabled: true, p_days: p.days.slice().sort(), p_minutes: p.target_minutes,
      p_mode: ch.mode, p_notes: p.notes || null, p_today: t, p_equipment: equipment, p_set_by: 'coach' });
  }
  if (ch.type === 'area') {
    const ra = ch.rec;
    const cur = MV.areas.filter(function (a) { return a.region === ra.region; })[0];
    const lvl = Number(ra.level || 1);
    const keepClock = cur && cur.is_active !== false && Number(cur.level) === lvl;
    return mvWriteArea(ra.region, { priority: ra.priority, level: lvl, source: 'coach_rec', athlete_edited: false,
      drill_mobility: ra.drill_mobility || null, drill_control: ra.drill_control || null, why: ra.why || null,
      is_active: true, started_on: keepClock ? cur.started_on : t }, true);
  }
  if (ch.type === 'drop') return mvWriteArea(ch.region, { is_active: false });
  return true;
}

async function mvResolveRec(rec, status) {
  const patch = { status: status, resolved_at: new Date().toISOString() };
  const ok = await mvWrite('movement_rec_status', Object.assign({ id: rec.id }, patch));
  if (ok) Object.assign(rec, patch);
  await mvSaveCache();
  return ok;
}

function mvRecBannerHtml() {
  const rec = mvPendingRec();
  if (!rec) return '';
  const ch = mvRecChanges(rec.payload, MV.plans, MV.areas);
  const when = (rec.pushed_at || '').slice(0, 10);
  const whenLbl = when ? new Date(mvUtc(when) + 12 * 3600000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
  if (MV.review && MV.review.id === rec.id) {
    return '<div class="card mv-rec"><div class="card-label">Coach recommendation · ' + mvEsc(whenLbl) + ' — review</div>'
      + (ch.length ? ch.map(function (c) {
        const on = MV.review.checked[c.id] !== undefined ? MV.review.checked[c.id] : c.checked;
        return '<div class="mv-rec-item" onclick="mvReviewToggle(\'' + c.id + '\')"><span class="mv-check mv-check-sm' + (on ? ' on' : '') + '">' + (on ? '✓' : '') + '</span>'
          + '<div><div>' + mvEsc(c.label) + '</div>' + (c.why ? '<div class="mv-area-why">' + mvEsc(c.why) + '</div>' : '') + '</div></div>';
      }).join('') : '<div class="card-sub">Nothing left to change — your plan already matches.</div>')
      + '<button class="btn" onclick="mvReviewApply()">Apply selected</button>'
      + '<button class="btn secondary" onclick="mvReviewCancel()">Back</button></div>';
  }
  const bits = ch.filter(function (c) { return c.type === 'plan'; }).map(function (c) { return '<div>' + mvEsc(c.label) + '</div>'; }).join('');
  const areaBits = ch.filter(function (c) { return c.type === 'area'; }).map(function (c) {
    return mvRegion(c.region).label + ' (' + c.rec.priority + ')';
  });
  const cautions = (MV.cautions || []).filter(function (c) { return c.is_active !== false; }).map(function (c) { return c.reason; });
  return '<div class="card mv-rec"><div class="card-label">Coach recommendation · ' + mvEsc(whenLbl) + '</div>'
    + (bits || '<div class="card-sub">Your plan already matches — nothing to change.</div>')
    + (areaBits.length ? '<div class="mv-rec-areas">+ ' + mvEsc(areaBits.join(' · ')) + '</div>' : '')
    + (cautions.length ? '<div class="mv-rec-caution">⚠ Avoid: ' + mvEsc(cautions.join(' · ')) + '</div>' : '')
    + '<div class="mv-rec-btns"><button class="btn" onclick="mvRecUse()">Use this plan</button>'
    + '<button class="btn secondary" onclick="mvRecReview()">Review changes</button>'
    + '<button class="btn secondary" onclick="mvRecNotNow()">Not now</button></div></div>';
}

async function mvRecUse() {
  const rec = mvPendingRec(); if (!rec) return;
  const ch = mvRecChanges(rec.payload, MV.plans, MV.areas);
  const drops = ch.filter(function (c) { return c.type === 'drop'; });
  const go = async function () {
    for (let i = 0; i < ch.length; i++) { if (ch[i].type !== 'drop') await mvApplyRecChange(ch[i]); }
    for (let i = 0; i < drops.length; i++) await mvApplyRecChange(drops[i]);
    await mvResolveRec(rec, 'accepted');
    await mvSaveCache();
    toast('Coach plan applied — you can still change anything');
    mvRenderScreen(); mvPaintCard();
  };
  if (drops.length) {
    showConfirm('Use the coach\'s plan?', 'This also turns off ' + drops.map(function (d) { return mvRegion(d.region).label; }).join(', ')
      + '. You can add them back anytime. Use Review changes to keep them.', 'Use this plan', go);
  } else await go();
}
function mvRecReview() { const rec = mvPendingRec(); if (!rec) return; MV.review = { id: rec.id, checked: {} }; mvRenderScreen(); }
function mvReviewCancel() { MV.review = null; mvRenderScreen(); }
function mvReviewToggle(id) {
  const rec = mvPendingRec(); if (!rec || !MV.review) return;
  const c = mvRecChanges(rec.payload, MV.plans, MV.areas).filter(function (x) { return x.id === id; })[0];
  const cur = MV.review.checked[id] !== undefined ? MV.review.checked[id] : (c ? c.checked : false);
  MV.review.checked[id] = !cur;
  mvRenderScreen();
}
async function mvReviewApply() {
  const rec = mvPendingRec(); if (!rec || !MV.review) return;
  const ch = mvRecChanges(rec.payload, MV.plans, MV.areas).filter(function (c) {
    return MV.review.checked[c.id] !== undefined ? MV.review.checked[c.id] : c.checked;
  });
  // Caps (2 daily / 3 rotating) must still hold after the chosen changes.
  const after = {};
  MV.areas.forEach(function (x) { if (x.is_active !== false) after[x.region] = x.priority; });
  ch.forEach(function (c) { if (c.type === 'area') after[c.region] = c.rec.priority; if (c.type === 'drop') delete after[c.region]; });
  for (const pr in MV_CAPS) {
    const n = Object.keys(after).filter(function (k) { return after[k] === pr; }).length;
    if (n > MV_CAPS[pr]) { toast('That would give you ' + n + ' ' + pr + ' areas (max ' + MV_CAPS[pr] + ') — tick a "Turn off" item too', 4000); return; }
  }
  const hasAreas = ch.some(function (c) { return c.type === 'area'; });
  const hasMobPlan = ch.some(function (c) { return c.type === 'plan' && c.kind === 'mobility'; });
  for (let i = 0; i < ch.length; i++) await mvApplyRecChange(ch[i]);
  // Taking coach areas without the mobility plan change still needs targeted mode to show them.
  if (hasAreas && !hasMobPlan) {
    const m = mvPlan('mobility');
    if (m && m.mode !== 'targeted') mvSavePlan('mobility', { mode: 'targeted' });
  }
  await mvResolveRec(rec, 'accepted');
  MV.review = null;
  toast(ch.length ? 'Applied ' + ch.length + ' change' + (ch.length === 1 ? '' : 's') : 'Nothing applied — noted for your coach');
  mvRenderScreen(); mvPaintCard();
}
async function mvRecNotNow() {
  const rec = mvPendingRec(); if (!rec) return;
  await mvResolveRec(rec, 'dismissed');
  toast('Dismissed — your coach will see that');
  mvRenderScreen(); mvPaintCard();
}

function mvCautionsHtml() {
  const list = (MV.cautions || []).filter(function (c) { return c.is_active !== false; });
  if (!list.length) return '';
  return '<div class="card"><div class="card-title" style="font-size:16px">⚠ Coach cautions</div>'
    + list.map(function (c) {
      const words = (c.caution_tags || []).map(function (t) { return MV_TAG_WORDS[t] || t; }).join(', ');
      return '<div class="mv-caution' + (c.athlete_override ? ' mv-caution-off' : '') + '">'
        + '<div>' + mvEsc(c.reason) + '</div>'
        + '<div class="mv-area-why">Leaves out: ' + mvEsc(words) + (c.athlete_override ? ' — <b>you\'re including these anyway</b>' : '') + '</div>'
        + '<button class="mv-mini" onclick="mvToggleOverride(\'' + c.id + '\')">' + (c.athlete_override ? 'Follow caution again' : 'Include anyway') + '</button></div>';
    }).join('') + '</div>';
}

function mvToggleOverride(id) {
  const c = (MV.cautions || []).filter(function (x) { return x.id === id; })[0];
  if (!c) return;
  const apply = async function (val) {
    const patch = { athlete_override: val, override_at: val ? new Date().toISOString() : null };
    const ok = await mvWrite('movement_caution_override', Object.assign({ id: id }, patch));
    if (!ok) return;
    Object.assign(c, patch);
    await mvSaveCache();
    toast(val ? 'Included — your coach will see this choice' : 'Caution back on');
    mvRenderScreen(); mvPaintCard();
  };
  if (c.athlete_override) apply(false);
  else showConfirm('Include these drills anyway?', 'Your coach suggested avoiding them: ' + mvEsc(c.reason) + '. Keep pain at 2/10 or less. Your coach will see this choice.',
    'Include anyway', function () { apply(true); });
}

// ── Trends section ──────────────────────────────────────────────────────────

// Loads v_movement_daily (the one SQL definition of "scheduled") for Trends.
async function loadMovementTrends() {
  MV.daily = null;
  if (isOffline || !S || !S.athlete) return;
  try {
    if (!MV.loaded) await loadMovement();
    const since = mvAddDays(mvToday(), -90);
    const r = await db.from('v_movement_daily').select('kind,log_date,scheduled,status,minutes,pain_flag,pain_region')
      .eq('athlete_id', S.athlete.id).gte('log_date', since).order('log_date');
    if (r.error) throw r.error;
    MV.daily = (r.data || []).map(function (x) {
      return { kind: x.kind, date: x.log_date, scheduled: !!x.scheduled, status: x.status, minutes: Number(x.minutes || 0),
        pain_flag: !!x.pain_flag, pain_region: x.pain_region };
    });
  } catch (e) { console.error('loadMovementTrends:', e); MV.daily = null; }
}

function mvFillRows(src, kind, from, to) {
  const by = {};
  (src || []).forEach(function (r) { if (r.kind === kind) by[r.date] = r; });
  const out = [];
  for (let d = from; d <= to; d = mvAddDays(d, 1)) out.push(by[d] || { kind: kind, date: d, scheduled: false, status: null, minutes: 0 });
  return out;
}

function renderTrendsMovement(weekKeys, weekLabels) {
  try { return mvTrendsHtml(); } catch (e) { console.error('renderTrendsMovement:', e); return ''; }
}
function mvTrendsHtml() {
  if (!MV.daily) return '';
  const t = mvToday();
  const hasLogs = MV.daily.some(function (r) { return !!r.status; });
  if (!mvAnyOn() && !hasLogs && !MV.screens.length) return '';
  const firstMon = mvMonday(mvAddDays(t, -77));
  const weeks = [];
  for (let i = 0; i < 12; i++) weeks.push(mvAddDays(firstMon, i * 7));
  const labels = weeks.map(function (w) { const p = w.split('-'); return Number(p[1]) + '/' + Number(p[2]); });
  let h = '';
  ['walk', 'mobility'].forEach(function (kind) {
    const rows = mvFillRows(MV.daily, kind, firstMon, mvAddDays(firstMon, 83));
    if (!mvPlan(kind) && !rows.some(function (r) { return r.status; })) return;
    const wk = mvCompliance(rows.filter(function (r) { return r.date >= mvMonday(t); }), t);
    const four = mvCompliance(rows.filter(function (r) { return r.date >= mvAddDays(mvMonday(t), -21); }), t);
    const streak = mvStreak(rows, t);
    const pill = function (v, l) { return '<div class="trends-stat-pill"><div class="trends-stat-num">' + v + '</div><div class="trends-stat-lbl">' + l + '</div></div>'; };
    h += '<div class="trends-chart-title" style="margin-top:6px">' + (kind === 'walk' ? '🚶 Walk' : '🧘 Mobility') + (mvPlan(kind) ? '' : ' (off)') + '</div>'
      + '<div class="trends-stat-strip">' + pill(wk.pct == null ? '—' : wk.pct + '%', 'This week') + pill(four.pct == null ? '—' : four.pct + '%', '4 weeks')
      + pill(streak, 'Day streak') + '</div>';
    // 12-week calendar grid (rows = weeks, columns = Mon..Sun)
    const glyph = { done: '●', partial: '◐', excused: '✕', missed: '○', today: '○', future: '·', off: '·' };
    h += '<div class="trends-chart-box"><div class="mv-grid"><div class="mv-grid-row"><span></span>'
      + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(function (l) { return '<span class="mv-grid-lbl" style="text-align:center">' + l + '</span>'; }).join('')
      + '</div>' + weeks.map(function (w, wi) {
      return '<div class="mv-grid-row"><span class="mv-grid-lbl">' + labels[wi] + '</span>' + rows.slice(wi * 7, wi * 7 + 7).map(function (r) {
        const s = mvStripSymbol(r, t);
        return '<span class="mv-sym mv-sym-' + s + '">' + glyph[s] + '</span>';
      }).join('') + '</div>';
    }).join('') + '</div></div>';
    const pct = weeks.map(function (w) {
      const c = mvCompliance(rows.filter(function (r) { return r.date >= w && r.date <= mvAddDays(w, 6); }), t);
      return c.pct == null ? 0 : c.pct;
    });
    h += '<div class="trends-chart-box"><div class="trends-chart-title">Weekly compliance %</div>'
      + trendsBarChart(pct, labels, { height: 110, formatVal: function (v) { return v + '%'; } }) + '</div>';
    if (kind === 'walk') {
      const mins = weeks.map(function (w) {
        return Math.round(rows.filter(function (r) { return r.date >= w && r.date <= mvAddDays(w, 6) && (r.status === 'done' || r.status === 'partial'); })
          .reduce(function (s, r) { return s + Number(r.minutes || 0); }, 0));
      });
      h += '<div class="trends-chart-box"><div class="trends-chart-title">Walk minutes per week</div>' + trendsBarChart(mins, labels, { height: 110 }) + '</div>';
    } else {
      const act = MV.areas.filter(function (a) { return a.is_active !== false; });
      const mob = mvPlan('mobility');
      h += '<div class="trends-chart-box"><div class="trends-chart-title">Current focus</div>'
        + (mob && mob.mode === 'targeted' && act.length ? act.map(function (a) {
          return '<div class="mv-trend-area"><span>' + mvEsc(mvRegion(a.region).label) + ' · ' + a.priority + '</span><span>L' + a.level + ' · ' + Math.max(0, mvDaysBetween(a.started_on, t)) + ' days</span></div>';
        }).join('') : '<div class="card-sub">General flow</div>') + '</div>';
    }
  });
  h += mvScreenTrendsHtml();
  return h ? trendSection('movement', 'Daily Movement', h) : '';
}

// ── Weekly check-in line ────────────────────────────────────────────────────
function mvCheckinLineHtml() {
  if (!MV.loaded || !mvAnyOn()) return '';
  const t = mvToday();
  const mon = mvMonday(t);
  const parts = [];
  ['walk', 'mobility'].forEach(function (kind) {
    if (!mvPlan(kind)) return;
    const rows = mvRows(kind, mon, mvAddDays(mon, 6));
    const sched = rows.filter(function (r) { return r.scheduled && r.status !== 'excused'; }).length;
    const got = rows.filter(function (r) { return r.status === 'done' || r.status === 'partial'; }).length;
    parts.push((kind === 'walk' ? 'Walk ' : 'Mobility ') + got + '/' + sched);
  });
  const sc = mvCheckinScreensText();
  if (sc) parts.push('📏 ' + sc);
  return '<div class="mv-checkin-line">🚶 Movement this week — ' + parts.join(' · ') + '</div>';
}

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
const MV_SCREEN_RANGE = { deg: [0, 200], cm: [0, 80], fingers: [0, 15] };

function mvTestNorm(r) {
  return {
    key: r.test_key, region: r.region, name: r.name, measure: r.measure, sides: r.sides,
    unit: r.unit || null, tilt: r.tilt || null, better: r.better || null,
    mdc: r.mdc == null ? null : Number(r.mdc), defOp: r.deficient_op || null,
    defValue: r.deficient_value == null ? null : Number(r.deficient_value),
    asym: r.asymmetry == null ? null : Number(r.asymmetry), provisional: !!r.provisional,
    tags: r.caution_tags || [], findings: r.findings || [], good: r.good || '', shows: r.shows || '',
    steps: r.steps || [], sort: Number(r.sort_order || 0),
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
  if (test.unit === 'fingers') return Math.round(n * 2) / 2;
  return Math.round(n);
}
function mvScreenUnitLabel(test, unitPref) {
  return test.unit === 'deg' ? '°' : test.unit === 'cm' ? (unitPref !== 'cm' ? 'in' : 'cm') : test.unit === 'fingers' ? 'fingers' : '';
}
function mvFmtScreenValue(test, v, unitPref, signed) {
  const d = mvScreenDisp(test, v, unitPref);
  if (d == null) return '';
  const s = (signed && d > 0 ? '+' : '') + d;
  if (test.unit === 'deg') return s + '°';
  if (test.unit === 'fingers') return s + (Math.abs(d) === 1 ? ' finger' : ' fingers');
  return s + ' ' + mvScreenUnitLabel(test, unitPref);
}
function mvScreenValueOk(test, stored) {
  const r = MV_SCREEN_RANGE[test.unit];
  if (!r) return true;
  // start-90 (upper-back rotation) = arm angle to level: below level is negative.
  if (test.tilt === 'start-90') return stored >= -90 && stored <= 120;
  const max = test.tilt === 'level' ? 90 : r[1];
  return stored >= r[0] && stored <= max;
}
// Tilt readout. start-90 speaks in "above / below level" (the raw number starts
// at −90° with the arm hanging, which read as a bug on the phone test).
function mvTiltFmt(test, a) {
  const n = Math.round(a);
  if (test && test.tilt === 'start-90') return n >= 0 ? n + '° above level' : (-n) + '° below level';
  return n + '°';
}

function mvScreenRows(screens, key) {
  return (screens || []).filter(function (s) { return s.test_key === key; })
    .sort(function (a, b) { return a.test_date < b.test_date ? -1 : a.test_date > b.test_date ? 1 : 0; });
}
// The most recent test date for a test, with its rows by side.
function mvScreenLatest(screens, key) {
  const rows = mvScreenRows(screens, key);
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
function mvScreenTrend(screens, key, side) {
  return mvScreenRows(screens, key).filter(function (r) {
    return r.side === side && !r.pain_flag && (r.value != null || r.passed != null);
  }).map(function (r) {
    return { date: r.test_date, value: r.value == null ? null : Number(r.value), passed: r.passed == null ? null : !!r.passed };
  });
}

// Per side: baseline (first result), latest, previous, and the changes.
function mvScreenSummary(test, screens) {
  const out = {};
  mvScreenSides(test).forEach(function (s) {
    const tr = mvScreenTrend(screens, test.key, s);
    if (!tr.length) return;
    const base = tr[0], last = tr[tr.length - 1], prev = tr.length > 1 ? tr[tr.length - 2] : null;
    out[s] = { baseline: base, latest: last, previous: prev, count: tr.length,
      sinceBaseline: tr.length > 1 ? mvScreenChange(test, base, last) : null,
      sinceLast: prev ? mvScreenChange(test, prev, last) : null };
  });
  return out;
}

// Why a test can't be prompted right now (ex = mvExclusions()).
// kind 'paused' (red pain / neuro — unavailable), 'caution' (coach caution — skipped),
// 'amber' (open pain 3–5 — not prompted, still takeable by hand). null = fine.
function mvScreenBlock(test, ex) {
  if (!ex) return null;
  const red = ex.red && ex.red[test.region];
  if (red) return { kind: 'paused', why: red.neuro ? 'nerve symptoms flagged' : 'open pain episode ' + red.score + '/10' };
  for (let i = 0; i < (test.tags || []).length; i++) {
    const why = ex.tags && ex.tags[test.tags[i]];
    if (why) return { kind: 'caution', why: why };
  }
  const amb = ex.amber && ex.amber[test.region];
  if (amb) return { kind: 'amber', why: 'open pain episode ' + amb.score + '/10 — scores during a pain episode aren\'t comparable' };
  return null;
}

// Which tests are due (framework §10.2). Only while mobility is on.
//   focus area (targeted mode, active): never taken → 'baseline'; latest result
//     deficient and ≥ 28 days old → 'retest'; area (re)started since the last
//     result and ≥ 28 days → 'baseline'.
//   otherwise: never taken or ≥ 182 days → 'checkup'.
// o: { mobilityOn, mode, optouts: {key:true}, snoozes: {key:'YYYY-MM-DD'}, exclusions }
// Returns { due, skipped, snoozed, optedOut }; due items = { test, reason, focus, last, age }.
function mvScreensDue(areas, screens, tests, todayStr, o) {
  o = o || {};
  const out = { due: [], skipped: [], snoozed: [], optedOut: [] };
  if (!o.mobilityOn) return out;
  const focus = {};
  if (o.mode === 'targeted') (areas || []).forEach(function (a) { if (a.is_active !== false) focus[a.region] = a; });
  (tests || []).slice().sort(function (a, b) { return a.sort - b.sort; }).forEach(function (t) {
    if (o.optouts && o.optouts[t.key]) { out.optedOut.push(t); return; }
    const block = mvScreenBlock(t, o.exclusions);
    if (block) { out.skipped.push({ test: t, kind: block.kind, why: block.why }); return; }
    const rows = mvScreenRows(screens, t.key);
    const last = rows.length ? rows[rows.length - 1].test_date : null;
    const age = last ? mvDaysBetween(last, todayStr) : null;
    const area = focus[t.region];
    let reason = null;
    if (area) {
      if (!last) reason = 'baseline';
      else if (age >= MV_SCREEN_RETEST_DAYS && mvScreenDeficient(t, mvScreenLatest(screens, t.key)).deficient) reason = 'retest';
      else if (age >= MV_SCREEN_RETEST_DAYS && area.started_on && area.started_on > last) reason = 'baseline';
    }
    if (!reason && (!last || age >= MV_SCREEN_CHECKUP_DAYS)) reason = 'checkup';
    if (!reason) return;
    const item = { test: t, reason: reason, focus: reason !== 'checkup', last: last, age: age };
    const sn = o.snoozes && o.snoozes[t.key];
    if (sn && todayStr < sn) { out.snoozed.push(item); return; }
    out.due.push(item);
  });
  out.due.sort(function (a, b) { return (b.focus - a.focus) || (a.test.sort - b.test.sort); });
  return out;
}

// Phone tilt meter math. g0 / g = gravity vectors {x,y,z} (devicemotion
// accelerationIncludingGravity). Sign-free on purpose (platforms disagree on signs).
//   'start'    — angle moved from the start position (0–180°)
//   'start-90' — the same minus 90° (arm hanging down → angle above level)
//   'level'    — the phone's long edge above/below level (0–90°), no start needed
function mvTiltAngle(mode, g0, g) {
  if (!g) return null;
  const n = Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z);
  if (!n) return null;
  if (mode === 'level') return Math.abs(Math.asin(Math.max(-1, Math.min(1, g.y / n)))) * 180 / Math.PI;
  if (!g0) return null;
  const n0 = Math.sqrt(g0.x * g0.x + g0.y * g0.y + g0.z * g0.z);
  if (!n0) return null;
  const c = (g0.x * g.x + g0.y * g.y + g0.z * g.z) / (n0 * n);
  let a = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  if (mode === 'start-90') a -= 90;
  return a;
}
// Start ("zero") reading: the average gravity vector of the last 400 ms, but
// only once the phone has been still that long (every sample within 3° of the
// average). samples: [{t, x, y, z}] oldest first. Returns {x,y,z} or null.
function mvTiltZero(samples, now) {
  const w = (samples || []).filter(function (s) { return now - s.t <= 400; });
  if (w.length < 3 || now - w[0].t < 300) return null;
  const m = { x: 0, y: 0, z: 0 };
  w.forEach(function (s) { m.x += s.x; m.y += s.y; m.z += s.z; });
  m.x /= w.length; m.y /= w.length; m.z /= w.length;
  for (let i = 0; i < w.length; i++) { if (mvTiltAngle('start', m, w[i]) > 3) return null; }
  return m;
}

// Capture logic for the phone tilt meter. Feed (state, ms, angle, mode); returns
// the state. Two ways a reading is captured:
//   'hold' — a steady run: readings within MV_TILT_BAND of each other for
//            MV_TILT_HOLD_MS, at (or near) the best range reached so far.
//   'peak' — the athlete reaches end range and comes back down without ever
//            holding still enough: once the angle falls MV_TILT_DROP below the
//            best range, the best range is captured (a "max-hold" inclinometer).
// "Best range" = the highest level SUSTAINED for MV_TILT_PEAK_MS (the lowest
// reading in a 400 ms window, maximized over time), so a jerky overshoot spike
// is not taken as range. 'level' mode (Thomas) captures a steady run only.
// History (phone tests 2026-09-25): a 2° / 1.5 s hold never triggered in a real
// hand; a 4° / 1 s hold still didn't, and the rest position after lowering the
// arm was then captured as 0°. Hence the wider band, the "near best" rule and
// the peak capture.
const MV_TILT_HOLD_MS = 1000;
const MV_TILT_BAND = 6;
const MV_TILT_PEAK_MS = 400;
const MV_TILT_DROP = 25;
function mvTiltTrack(st, t, a, mode) {
  st = st || {};
  if (!st.win) st.win = [];
  if (st.captured === undefined) st.captured = null;
  if (st.captured != null) return st;
  if (st.start == null) st.start = a;
  if (mode === 'level' || Math.abs(a - st.start) >= 10) st.moved = true;
  // Sustained best range
  st.win.push({ t: t, a: a });
  while (st.win.length > 1 && t - st.win[0].t > MV_TILT_PEAK_MS) st.win.shift();
  if (st.moved && mode !== 'level' && t - st.win[0].t >= MV_TILT_PEAK_MS * 0.75) {
    let lo = Infinity, sum = 0;
    st.win.forEach(function (w) { lo = Math.min(lo, w.a); sum += w.a; });
    if (st.best == null || lo > st.best) { st.best = lo; st.bestMean = sum / st.win.length; }
  }
  // Steady run
  const r = st.run;
  if (r && Math.max(r.hi, a) - Math.min(r.lo, a) <= MV_TILT_BAND) {
    r.hi = Math.max(r.hi, a); r.lo = Math.min(r.lo, a); r.sum += a; r.n++;
  } else {
    st.run = { t0: t, lo: a, hi: a, sum: a, n: 1 };
  }
  st.steadyMs = t - st.run.t0;
  const runMean = st.run.sum / st.run.n;
  // Start modes measure the angle moved from the start position, so a result
  // within 10° of it is the athlete back at rest (or not started), never a range.
  const offStart = mode === 'level' || Math.abs(runMean - (mode === 'start-90' ? -90 : 0)) >= 10;
  const nearBest = mode === 'level' || st.best == null || runMean >= st.best - MV_TILT_BAND;
  if (st.moved && st.steadyMs >= MV_TILT_HOLD_MS && nearBest && offStart) {
    st.captured = runMean; st.how = 'hold';
  } else if (mode !== 'level' && st.best != null && st.best - st.start >= 10 && a <= st.best - MV_TILT_DROP) {
    st.captured = st.bestMean; st.how = 'peak';
  }
  return st;
}

// ── Self-tests: data ──

MV.tests = MV.tests || [];
MV.screens = MV.screens || [];
MV.screenPrefs = MV.screenPrefs || [];
MV.screenUi = MV.screenUi || { unit: 'in', snoozes: {}, declined: {} };
MV.testDrafts = MV.testDrafts || {};   // unsaved entries per test (today) — survive closing / reopening the sheet

// Called inside loadMovement() when online. Its own try: a missing Phase 3
// table must never break the walk / mobility check-off.
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
}
async function mvLoadScreenUi() {
  try {
    const u = await idbGet('movementScreenUi');
    if (u && u.athleteId === S.athlete.id) {
      MV.screenUi = { unit: u.unit === 'cm' ? 'cm' : 'in', snoozes: u.snoozes || {}, declined: u.declined || {} };
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

function mvTest(key) { return MV.tests.filter(function (t) { return t.key === key; })[0] || null; }
function mvOptouts() {
  const o = {};
  MV.screenPrefs.forEach(function (p) { if (p.opted_out) o[p.test_key] = true; });
  return o;
}
function mvScreenEx() { return mvExclusions(MV.cautions, (S && S.openInjuries) || []); }
function mvDueNow() {
  const mob = mvPlan('mobility');
  return mvScreensDue(MV.areas, MV.screens, MV.tests, mvToday(), {
    mobilityOn: !!mob, mode: mob ? mob.mode : null, optouts: mvOptouts(),
    snoozes: MV.screenUi.snoozes, exclusions: mvScreenEx(),
  });
}
function mvFocusArea(region) {
  const mob = mvPlan('mobility');
  if (!mob || mob.mode !== 'targeted') return null;
  return MV.areas.filter(function (a) { return a.region === region && a.is_active !== false; })[0] || null;
}
function mvShortDate(ds) {
  const p = ds.split('-');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + (+p[2]);
}

// "L 152° (+6°) · R 160°" — latest per side, change since the first result.
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

// ── Self-tests: UI ──

// Today card row — only while mobility is on and something is due (never "overdue").
function mvTestRowHtml() {
  if (!mvPlan('mobility') || !MV.tests.length) return '';
  const d = mvDueNow().due;
  if (!d.length) return '';
  const focus = d.filter(function (x) { return x.focus; });
  const title = focus.some(function (x) { return x.reason === 'retest'; }) ? 'Retest due'
    : focus.length ? 'Self-test due' : 'Mobility check-up';
  const list = focus.length ? focus : d;
  const sub = focus.length
    ? list.slice(0, 2).map(function (x) { return x.test.name; }).join(' · ') + (list.length > 2 ? ' +' + (list.length - 2) : '')
    : d.length + ' test' + (d.length === 1 ? '' : 's') + ' · any order, any day';
  return '<div class="mv-row mv-test-row"><div class="mv-test-icon">📏</div>'
    + '<div class="mv-row-body" onclick="openMvTests()"><div class="mv-row-title">' + title + '</div>'
    + '<div class="mv-row-sub">' + mvEsc(sub) + '</div></div>'
    + '<button class="mv-mini mv-later" onclick="mvSnoozeDue()">Later</button>'
    + '<div class="arrow" onclick="openMvTests()">›</div></div>';
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
    + '<button class="btn secondary" onclick="openMvTests()">Open self-tests</button></div>';
}

// Focus-area row line in the Movement screen.
function mvAreaScreenLineHtml(region) {
  const tests = MV.tests.filter(function (t) { return t.region === region; });
  if (!tests.length) return '';
  const parts = tests.map(function (t) {
    const txt = mvScreenResultText(t, mvScreenSummary(t, MV.screens));
    return txt ? mvEsc(t.name) + ': ' + mvEsc(txt) : '';
  }).filter(Boolean);
  return '<div class="mv-area-test" onclick="openMvTests()">📏 '
    + (parts.length ? parts.join('<br>') : 'No self-test yet — take one') + '</div>';
}

function mvOpenSheetDom() {
  document.getElementById('mv-overlay').classList.add('open');
  document.getElementById('mv-sheet').classList.add('open');
}

// Self-tests list (sheet).
function openMvTests() {
  mvTiltStop();
  MV.sheet = null; MV.test = null;
  mvRenderTestList();
  mvOpenSheetDom();
}
function mvRenderTestList() {
  document.getElementById('mv-sheet-title').textContent = '📏 Self-tests';
  const body = document.getElementById('mv-sheet-body');
  if (!MV.tests.length) {
    body.innerHTML = '<div class="mv-note">The self-test library hasn\'t synced yet — ask your coach to run sync_mobility.py.</div>'
      + '<button class="btn secondary" onclick="closeMvSheet()">Close</button>';
    return;
  }
  const dn = mvDueNow();
  const due = {};
  dn.due.forEach(function (x) { due[x.test.key] = x; });
  let h = '<div class="mv-note">Short checks that show whether your range is changing. Optional — take any test any time, skip any you like. '
    + 'They track change; they don\'t diagnose.</div>';
  if (dn.due.length) {
    h += '<div class="form-section-label">Due now</div>' + dn.due.map(function (x) { return mvTestListRow(x.test, x); }).join('');
  }
  MV_REGION_ORDER.forEach(function (region) {
    const ts = MV.tests.filter(function (t) { return t.region === region && !due[t.key]; });
    if (!ts.length) return;
    h += '<div class="form-section-label">' + mvEsc(mvRegion(region).label) + '</div>'
      + ts.map(function (t) { return mvTestListRow(t, null); }).join('');
  });
  h += '<button class="btn secondary" onclick="closeMvSheet()">Close</button>';
  body.innerHTML = h;
}
function mvTestListRow(t, dueItem) {
  const block = mvScreenBlock(t, mvScreenEx());
  const opted = mvOptouts()[t.key];
  const latest = mvScreenLatest(MV.screens, t.key);
  const def = mvScreenDeficient(t, latest);
  let status;
  if (dueItem) status = dueItem.reason === 'retest' ? 'Monthly retest' : dueItem.reason === 'baseline' ? 'First test for this focus area' : 'Check-up';
  else if (opted) status = 'Opted out';
  else if (block && block.kind !== 'amber') status = 'Skipped — ' + block.why;
  else if (block) status = 'Not now — ' + block.why;
  else status = latest ? 'Last taken ' + mvShortDate(latest.date) : 'Not taken yet';
  const res = mvScreenResultText(t, mvScreenSummary(t, MV.screens));
  return '<div class="mv-test-item' + (opted || (block && block.kind !== 'amber') ? ' mv-test-item-off' : '') + '" data-test="' + t.key + '" onclick="openMvTest(\'' + t.key + '\')">'
    + '<div class="mv-test-item-top"><span class="mv-drill-name">' + mvEsc(t.name) + '</span>'
    + (def.deficient ? '<span class="mv-test-flag-tag">worth working on</span>' : '')
    + (latest && latest.pain ? '<span class="mv-test-flag-tag">hurt</span>' : '') + '</div>'
    + (res ? '<div class="mv-test-res">' + mvEsc(res) + '</div>' : '')
    + '<div class="mv-drill-dose' + (dueItem ? ' mv-test-due' : '') + '">' + mvEsc(status) + '</div></div>';
}

// One test (sheet): steps → per-side inputs → Save; result view after saving.
function openMvTest(key) {
  const t = mvTest(key);
  if (!t) return;
  mvTiltStop();
  MV.sheet = null;
  const d = mvToday();
  const dr = MV.testDrafts[key];
  if (dr && dr.date === d && !dr.saved) {           // unsaved typed / measured values come back
    dr.tilt = null; dr.offer = null;
    MV.test = dr;
    mvRenderTest();
    mvOpenSheetDom();
    return;
  }
  const st = { key: key, date: d, sides: {}, finding: null, notes: '', saved: false, tilt: null, offer: null };
  MV.screens.filter(function (r) { return r.test_key === key && r.test_date === d && !r.pain_flag; }).forEach(function (r) {
    if (r.finding) st.finding = r.finding;
    if (r.notes) st.notes = r.notes;
  });
  mvScreenSides(t).forEach(function (s) {
    const r = MV.screens.filter(function (x) { return x.test_key === key && x.test_date === d && x.side === s && !x.pain_flag; })[0];
    st.sides[s] = { value: r && r.value != null ? String(mvScreenDisp(t, r.value, MV.screenUi.unit)) : '',
      passed: r && r.passed != null ? !!r.passed : null };
  });
  MV.test = st;
  MV.testDrafts[key] = st;
  mvRenderTest();
  mvOpenSheetDom();
}

function mvRenderTest() {
  const st = MV.test;
  if (!st) return;
  const t = mvTest(st.key);
  const body = document.getElementById('mv-sheet-body');
  document.getElementById('mv-sheet-title').textContent = '📏 ' + t.name;
  if (st.tilt) { body.innerHTML = mvTiltHtml(t, st.tilt); return; }
  if (st.saved) { body.innerHTML = mvTestResultHtml(t, st); return; }
  const u = MV.screenUi.unit;
  const block = mvScreenBlock(t, mvScreenEx());
  const opted = mvOptouts()[t.key];
  let h = '<div class="mv-test-shows">' + mvEsc(t.shows) + '</div>';
  if (block && block.kind !== 'amber') {
    h += '<div class="mv-paused">' + (block.kind === 'paused' ? '⏸ Paused — ' : 'Skipped — ') + mvEsc(block.why) + '</div>';
    h += block.kind === 'caution'
      ? '<div class="card-sub">Your coach suggests avoiding this position for now. You can change that under Cautions in 🚶 Movement.</div>'
      : '<div class="card-sub">This area has an open pain episode. <a class="mv-link" onclick="closeMvSheet();openPainSheet()">Open 🚩 Pain</a></div>';
    body.innerHTML = h + '<button class="btn secondary" onclick="openMvTests()">Back to self-tests</button>';
    return;
  }
  if (block) h += '<div class="mv-note">⚠ ' + mvEsc(block.why) + '. You can still take it — keep it pain-free.</div>';
  h += '<ol class="mv-test-steps">' + t.steps.map(function (s) { return '<li>' + mvEsc(s) + '</li>'; }).join('') + '</ol>'
    + '<div class="mv-test-safety">Stop if pain goes above 2/10 and tap <b>It hurt</b>.</div>'
    + '<div class="mv-test-good"><b>Good:</b> ' + mvEsc(t.good) + (t.provisional ? ' <span class="mv-muted">(rough guide for now)</span>' : '') + '</div>';
  if (t.unit === 'cm') {
    h += '<div class="triage-chips mv-unit-chips">'
      + '<button class="triage-chip' + (u !== 'cm' ? ' active' : '') + '" onclick="mvSetScreenUnit(\'in\')">Inches</button>'
      + '<button class="triage-chip' + (u === 'cm' ? ' active' : '') + '" onclick="mvSetScreenUnit(\'cm\')">cm</button></div>';
  }
  mvScreenSides(t).forEach(function (s) {
    const x = st.sides[s];
    const nm = mvSideName(t, s);
    h += '<div class="mv-test-side">' + (nm ? '<div class="form-section-label">' + nm + '</div>' : '');
    if (mvSideTakesPass(t, s)) {
      h += '<div class="triage-chips">'
        + '<button class="triage-chip' + (x.passed === true ? ' active' : '') + '" onclick="mvTestPass(\'' + s + '\',true)">Pass</button>'
        + '<button class="triage-chip' + (x.passed === false ? ' active' : '') + '" onclick="mvTestPass(\'' + s + '\',false)">Not yet</button></div>';
    }
    if (mvSideTakesNumber(t, s)) {
      h += '<div class="mv-num-row"><input class="mv-num" id="mv-num-' + s + '" type="number" inputmode="decimal" step="any"' + (t.tilt === 'start-90' ? '' : ' min="0"')
        + ' value="' + mvEsc(x.value) + '" placeholder="—" oninput="MV.test.sides[\'' + s + '\'].value=this.value">'
        + '<span class="mv-num-unit">' + mvScreenUnitLabel(t, u) + (t.tilt === 'level' ? ' above level' : t.tilt === 'start-90' ? ' above level (− = below)' : '') + '</span>'
        + (t.tilt ? '<button class="mv-mini" onclick="mvTiltOpen(\'' + s + '\')">📐 Measure with phone</button>' : '')
        + '</div>';
    }
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
    + '<button class="btn secondary" onclick="openMvTests()">Back to self-tests</button>'
    + '<div class="mv-test-optout"><a class="mv-link" onclick="mvTestOptOut(\'' + t.key + '\',' + (opted ? 'false' : 'true') + ')">'
    + (opted ? 'Show this test again' : 'Don\'t suggest this test') + '</a></div>';
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
  mvRenderTest();
}

function mvScreenRow(t, side, value, passed, pain) {
  const st = MV.test;
  return { athlete_id: S.athlete.id, test_date: st.date, test_key: t.key, side: side,
    value: value, unit: value == null ? null : t.unit, passed: passed, pain_flag: !!pain,
    finding: st.finding || null, notes: st.notes || null, updated_at: new Date().toISOString() };
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
      if (value == null || !mvScreenValueOk(t, value)) { toast('Check the ' + (nm ? nm.toLowerCase() + ' ' : '') + 'number', 3000); return; }
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
  st.hurt = !!hurt;
  delete MV.testDrafts[t.key];
  mvRenderTest();
  mvPaintCard();
}
function mvTestHurt() {
  showConfirm('Stop this test?', 'A painful test isn\'t a mobility problem. We\'ll note it for your coach — no score is saved for it.',
    'It hurt', function () { mvTestSave(true); });
}

function mvTestResultHtml(t, st) {
  const u = MV.screenUi.unit;
  const latest = mvScreenLatest(MV.screens, t.key);
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
      const cur = mvSideTakesNumber(t, s) && x.latest.value != null ? mvFmtScreenValue(t, x.latest.value, u)
        : (x.latest.passed ? 'Pass' : 'Not yet');
      h += '<div class="mv-test-change"><b>' + (nm ? nm + ': ' : '') + mvEsc(cur) + '</b>';
      [['sinceBaseline', 'first test', x.baseline], ['sinceLast', 'last time', x.previous]].forEach(function (c) {
        const ch = x[c[0]];
        if (!ch || (c[0] === 'sinceLast' && x.count < 3)) return;
        const d = ch.delta != null && mvSideTakesNumber(t, s) ? mvFmtScreenValue(t, ch.delta, u, true)
          : (ch.flip ? (ch.direction === 'better' ? 'now passes' : 'no longer passes') : 'no change');
        h += '<div class="mv-muted">vs ' + c[1] + ' (' + mvShortDate(c[2].date) + '): ' + mvEsc(d)
          + (ch.real ? (ch.direction === 'better' ? ' — real improvement' : ch.direction === 'worse' ? ' — real drop' : '')
            : ' — within normal day-to-day wobble') + '</div>';
      });
      h += '</div>';
    });
    if (def.hint === 'upper_back') h += '<div class="mv-note">Each arm passes alone but not both together — that points to your upper back.</div>';
    if (def.hint === 'hip') h += '<div class="mv-note">Passing only with knees bent points to the front of the hips — try the hip flexor (Thomas) test.</div>';
    if (def.deficient) {
      h += '<div class="mv-test-flag">⚑ Worth working on — ' + mvEsc(def.reasons.map(function (r) { return mvDefReasonText(t, r); }).join('; ')) + '.'
        + (t.provisional ? ' <span class="mv-muted">(rough guide for now)</span>' : '') + '</div>';
      h += mvTestOfferHtml(t, st, latest);
    } else if (latest && !latest.pain) {
      h += '<div class="card-sub" style="margin:8px 0">No flag. ' + (mvFocusArea(t.region) ? '' : 'Next check-up in about 6 months.') + '</div>';
    }
  }
  h += '<button class="btn secondary" onclick="openMvTests()">Back to self-tests</button>'
    + '<button class="btn secondary" onclick="closeMvSheet()">Done</button>';
  return h;
}
// Deficient → focus-area OFFER, never automatic (framework §10.2).
function mvTestOfferHtml(t, st, latest) {
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
function mvTestOfferDecline() {
  const t = mvTest(MV.test.key);
  const latest = mvScreenLatest(MV.screens, t.key);
  if (latest) MV.screenUi.declined[t.key + '|' + latest.date] = true;
  mvSaveScreenUi();
  MV.test.offer = 'declined';
  mvRenderTest();
}
function mvTestPain() {
  const t = mvTest(MV.test.key);
  closeMvSheet();
  mvOpenPainFor(mvRegion(t.region).pain[0]);
}
async function mvTestOptOut(key, out) {
  const ok = await mvSetOptOut(key, out);
  if (!ok) return;
  toast(out ? 'Okay — we won\'t suggest this test. You can still take it here.' : 'This test is back on');
  mvRenderTest();
  mvPaintCard();
}

// ── Phone tilt meter (the typed number always works too) ──
function mvTiltOpen(side) {
  MV.test.tilt = { side: side, phase: 'intro', g: null, g0: null, st: null, err: null, t0: null, live: null };
  mvRenderTest();
}
function mvTiltHtml(t, tl) {
  let h = '<div class="mv-tilt">';
  if (tl.err) {
    return h + '<div class="mv-paused">' + mvEsc(tl.err) + '</div>'
      + '<button class="btn secondary" onclick="mvTiltCancel()">Type the number instead</button></div>';
  }
  const side = mvSideName(t, tl.side);
  if (tl.phase === 'intro') {
    return h + '<div class="mv-tilt-title">📐 Measure with phone' + (side ? ' — ' + side.toLowerCase() : '') + '</div>'
      + '<div class="mv-muted" style="margin-bottom:6px">' + (t.tilt === 'level'
        ? 'Measures how far the phone tilts from level — it records once you\'ve been still for a second after the countdown.'
        : t.tilt === 'start-90'
          ? 'Measures your arm\'s angle to level: 0° = level with your back, 90° = straight up. Start with the arm (and phone) hanging straight down — it reads 90° below level there.'
          : 'Measures how far the phone turns from where you tap Start.') + '</div><ol class="mv-test-steps">'
      + (t.tilt === 'level'
        ? '<li>Put the phone lengthwise on the front of your thigh.</li><li>Tap Start, then lie back into the test within 3 seconds.</li>'
        : '<li>Set the phone as the steps say and get into the start position.</li><li>Tap Start and stay still until the first beep.</li><li>Move slowly to your end range.</li>')
      + '<li>Hold at end range for a second — or just come back down; it keeps your best range. A double beep means it\'s in.</li></ol>'
      + '<div class="mv-muted" style="margin-bottom:10px">iPhone: turn the ringer on (silent switch off) to hear the beeps.</div>'
      + '<button class="btn" id="mv-tilt-start" onclick="mvTiltStart()">Start</button>'
      + '<button class="btn secondary" onclick="mvTiltCancel()">Cancel</button></div>';
  }
  if (tl.phase === 'done') {
    return h + '<div class="mv-tilt-title">✓ Reading in' + (side ? ' — ' + side.toLowerCase() : '') + '</div>'
      + '<div class="mv-tilt-live mv-tilt-result" id="mv-tilt-result">' + mvEsc(mvTiltFmt(t, tl.result)) + '</div>'
      + '<div class="mv-tilt-msg">' + (tl.how === 'peak' ? 'Your best range before you came back down. ' : tl.how === 'hold' ? 'Held steady. ' : '')
      + 'Saved to the ' + (side ? side.toLowerCase() + ' ' : '') + 'field. Tap Done, check it, then Save the test.</div>'
      + '<div class="mv-tilt-diag">' + mvEsc(tl.diag || '') + '</div>'
      + '<button class="btn" id="mv-tilt-done" onclick="mvTiltDone()" disabled>Done</button>'
      + '<button class="btn secondary" onclick="mvTiltOpen(\'' + tl.side + '\')" disabled>Measure again</button></div>';
  }
  const msg = tl.phase === 'zeroing' ? (t.tilt === 'level' ? 'Lie back into position…' : 'Hold still in the start position…')
    : 'Move to your end range and hold still…';
  return h + '<div class="mv-tilt-live" id="mv-tilt-live">' + (tl.live != null ? mvTiltFmt(t, tl.live) : '—') + '</div>'
    + '<div class="mv-tilt-msg" id="mv-tilt-msg">' + msg + '</div>'
    + '<div class="mv-muted" id="mv-tilt-best" style="margin:-8px 0 12px"></div>'
    + '<div class="mv-tilt-diag" id="mv-tilt-diag"></div>'
    + (tl.phase === 'measuring' ? '<button class="btn" id="mv-tilt-use" onclick="mvTiltUseNow()">Use this reading</button>' : '')
    + '<button class="btn secondary" onclick="mvTiltCancel()">Cancel</button></div>';
}
async function mvTiltStart() {
  const tl = MV.test && MV.test.tilt;
  if (!tl) return;
  try { ensureAudio(); } catch (_) {}
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const p = await DeviceMotionEvent.requestPermission();
      if (p !== 'granted') {
        tl.err = 'Motion access was declined. Type the number instead (you can allow motion access in your phone settings).';
        mvRenderTest();
        return;
      }
    }
  } catch (e) { tl.err = 'Couldn\'t get motion access. Type the number instead.'; mvRenderTest(); return; }
  tl.phase = 'zeroing'; tl.t0 = Date.now(); tl.g = null; tl.st = null; tl.live = null;
  tl.raw = []; tl.n = 0; tl.lastT = null; tl.tm = null; tl.nm = 0;
  window.addEventListener('devicemotion', mvTiltOnMotion);
  MV.tiltListening = true;
  tl.timer = setTimeout(function () {
    if (MV.test && MV.test.tilt === tl && !tl.g) {
      mvTiltStop();
      tl.err = 'No motion sensor reading on this device. Type the number instead.';
      mvRenderTest();
    }
  }, 2500);
  mvRenderTest();
}
function mvTiltOnMotion(e) {
  const tl = MV.test && MV.test.tilt;
  if (!tl) { mvTiltStop(); return; }
  const a = e && e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  const now = Date.now();
  const s = { t: now, x: Number(a.x), y: Number(a.y), z: Number(a.z) };
  if (!isFinite(s.x) || !isFinite(s.y) || !isFinite(s.z)) return;
  // Diagnostics (shown small on screen — lets a phone test tell us what the sensor did)
  tl.n = (tl.n || 0) + 1;
  // Low-pass with a fixed 150 ms time constant, whatever the sensor's event rate.
  const dt = tl.lastT ? Math.min(250, Math.max(1, now - tl.lastT)) : 16;
  tl.lastT = now;
  const k = 1 - Math.exp(-dt / 150);
  tl.g = tl.g ? { x: tl.g.x + (s.x - tl.g.x) * k, y: tl.g.y + (s.y - tl.g.y) * k, z: tl.g.z + (s.z - tl.g.z) * k } : { x: s.x, y: s.y, z: s.z };
  const t = mvTest(MV.test.key);
  if (tl.phase === 'zeroing') {
    tl.raw = (tl.raw || []).concat([s]).filter(function (r) { return now - r.t <= 500; });
    const wait = t.tilt === 'level' ? 3000 : 600;
    const left = Math.ceil((wait - (now - tl.t0)) / 1000);
    const msg = document.getElementById('mv-tilt-msg');
    if (now - tl.t0 < wait) { if (msg && t.tilt === 'level') msg.textContent = 'Lie back into position… ' + left; return; }
    // Start modes: the start position counts only once the phone is still.
    const z = t.tilt === 'level' ? { x: tl.g.x, y: tl.g.y, z: tl.g.z } : mvTiltZero(tl.raw, now);
    if (!z) { if (msg) msg.textContent = 'Hold still in the start position…'; return; }
    tl.g0 = z;
    tl.g = { x: z.x, y: z.y, z: z.z };
    tl.phase = 'measuring';
    tl.tm = now; tl.nm = tl.n;
    try { beep(1); } catch (_) {}
    mvRenderTest();
    return;
  }
  if (tl.phase !== 'measuring') return;
  const ang = mvTiltAngle(t.tilt, tl.g0, tl.g);
  if (ang == null || !isFinite(ang)) return;
  tl.live = ang;
  const el = document.getElementById('mv-tilt-live');
  if (el) el.textContent = mvTiltFmt(t, ang);
  tl.st = mvTiltTrack(tl.st, now, ang, t.tilt);
  const msg = document.getElementById('mv-tilt-msg');
  if (msg) msg.textContent = !tl.st.moved ? 'Move to your end range and hold still…'
    : tl.st.steadyMs >= 250 ? 'Holding steady… ' + (Math.min(tl.st.steadyMs, MV_TILT_HOLD_MS) / 1000).toFixed(1) + ' s'
    : 'Hold still…';
  const best = document.getElementById('mv-tilt-best');
  if (best && tl.st.best != null && t.tilt !== 'level') best.textContent = 'Best so far: ' + mvTiltFmt(t, t.tilt === 'start-90' ? tl.st.bestMean : Math.max(0, tl.st.bestMean)) + ' — or just come back down';
  const dg = document.getElementById('mv-tilt-diag');
  if (dg) dg.textContent = mvTiltDiag(t, tl, now);
  if (tl.st.captured != null) mvTiltCapture(tl.st.captured, tl.st.how);
}
function mvTiltDiag(t, tl, now) {
  const secs = Math.max(0.001, (now - (tl.tm || now)) / 1000);
  const hz = tl.tm ? Math.round((tl.n - tl.nm) / secs) : 0;
  const st = tl.st || {};
  return 'mode ' + t.tilt + ' · ' + hz + ' Hz · moved ' + (st.moved ? 'y' : 'n') + ' · steady ' + ((st.steadyMs || 0) / 1000).toFixed(1)
    + ' s · best ' + (st.bestMean != null ? Math.round(st.bestMean) : '–') + (st.how ? ' · via ' + st.how : '') + ' · v44';
}
// Capture a reading: auto (steady hold) or the "Use this reading" button.
function mvTiltCapture(angle, how) {
  const tl = MV.test && MV.test.tilt;
  if (!tl || angle == null || !isFinite(angle)) return;
  tl.how = how || 'manual';
  try { tl.diag = mvTiltDiag(mvTest(MV.test.key), tl, Date.now()); } catch (_) { tl.diag = ''; }
  const tt = mvTest(MV.test.key);
  // Upper-back rotation keeps its sign (below level = negative); others can't go below 0.
  const v = tt && tt.tilt === 'start-90' ? Math.round(angle) : Math.max(0, Math.round(angle));
  mvTiltStop();
  try { beep(2); } catch (_) {}
  try { if (navigator.vibrate) navigator.vibrate([120, 80, 120]); } catch (_) {}
  MV.test.sides[tl.side].value = String(v);     // straight into the field
  tl.phase = 'done';
  tl.result = v;
  mvRenderTest();
  // A hand still on the screen from the hold must not tap the new buttons.
  setTimeout(function () {
    document.querySelectorAll('.mv-tilt button').forEach(function (b) { b.disabled = false; });
  }, 900);
}
// "Done" on the result: back to the form, the number is already in its field.
function mvTiltDone() {
  if (!MV.test) return;
  MV.test.tilt = null;
  mvRenderTest();
}
function mvTiltUseNow() {
  const tl = MV.test && MV.test.tilt;
  if (tl && tl.live != null) mvTiltCapture(tl.live);
}
function mvTiltStop() {
  if (MV.tiltListening) { window.removeEventListener('devicemotion', mvTiltOnMotion); MV.tiltListening = false; }
  const tl = MV.test && MV.test.tilt;
  if (tl && tl.timer) { clearTimeout(tl.timer); tl.timer = null; }
}
function mvTiltCancel() {
  mvTiltStop();
  if (MV.test) MV.test.tilt = null;
  mvRenderTest();
}

// ── Trends: one line per test per side, next to compliance ──
function mvScreenTrendsHtml() {
  const u = MV.screenUi.unit;
  const tests = MV.tests.filter(function (t) { return MV.screens.some(function (r) { return r.test_key === t.key && !r.pain_flag; }); });
  if (!tests.length) return '';
  let h = '<div class="trends-chart-title" style="margin-top:10px">📏 Self-tests</div>';
  tests.forEach(function (t) {
    const sum = mvScreenSummary(t, MV.screens);
    mvScreenSides(t).forEach(function (s) {
      const tr = mvScreenTrend(MV.screens, t.key, s).slice(-12);
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
