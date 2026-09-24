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
      cautions: MV.cautions, recs: MV.recs, drillMap: MV.drillMap });
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
        }
      } catch (_) {}
    }
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
      + '<div class="mv-area-meta">' + Math.max(0, mvDaysBetween(a.started_on, t)) + ' days on this level</div></div></div>';
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
  if (!mvAnyOn() && !hasLogs) return '';
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
  return '<div class="mv-checkin-line">🚶 Movement this week — ' + parts.join(' · ') + '</div>';
}
