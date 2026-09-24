// ══════════════ Kardia Nutrition — Trends screen ══════════════
// Three-layer architecture per Trends_Redesign_Analysis_2026-07-18 §5:
//   Card 1 Overview     — the 10-second answer (verdict + coach focus + one banner)
//   Card 2 Weight       — EWMA trend + raw dots + phase shading + target ticks
//   Card 3 Adherence    — N09 §3.3-3.6 (calories / protein floor / compliance / logging)
//   Card 4 Measurements — waist, hips, calipers (per-site, mm-sum derived)
//   Card 5 Activity     — steps/workouts + training context (context only, never in TDEE)
//   Card 6 History      — stored weekly coach reports, phase timeline, program changes
//
// ALL metric math lives in n-metrics.js (N09 calc_version 1) — this file only
// fetches and draws. Never inline a formula here: the coach's pull computes the
// same numbers from nutrition_metrics.py and the two must not drift.
// Weekly bucketing is Wednesday-anchored throughout (N09 §1) — nWednesday, not nMonday.

const NT_RANGES = { '30d': 30, '3m': 91, '6m': 183, '1y': 365, 'all': 3650 };
let NT = { range: '3m', showMacros: false, openReport: null, energyTable: false };

function nTrendWindowDays() {
  // N09 §3.2: Troy 14 d, Amanda 21 d. Amanda's longer window is deliberate —
  // her expected weekly delta is smaller than her scale noise on 14 d.
  // track_cycle_context is the athlete-level flag that distinguishes them
  // (N05 opts in, N04 does not); no separate column exists for this yet.
  return NS.settings?.track_cycle_context ? 21 : 14;
}

async function renderNTrends() {
  const body = document.getElementById('ntrends-body');
  const days = NT_RANGES[NT.range] || 91;
  const label = { '30d': 'last 30 days', '3m': 'last 3 months', '6m': 'last 6 months',
    '1y': 'last year', 'all': 'all time' }[NT.range];
  document.getElementById('ntrends-sub').textContent = `${NS.me.name} · ${label}`;
  body.innerHTML = '<div class="spinner">Loading…</div>';

  const meId = NS.me.id;
  const since = nAddDays(nToday(), -days);
  // 4 full weeks back, not 3: the N09 §3.7 TDEE window is a trailing 28 days and
  // needs exact per-meal tiering across all of it. The adherence card still
  // renders the last 4 week buckets (it slices), so nothing else changes.
  const since4w = nAddDays(nWednesday(nToday()), -7 * 4);

  let wq, sq, tq, mq, pq, lq, phq, aq, rq, dvq, nkq, csq, ccq;
  try {
    [wq, sq, tq, mq, pq, lq, phq, aq, rq, dvq, nkq] = await Promise.all([
      // Weight: flags included — excluded/suspect points are skipped by the engine.
      ndb.from('body_metrics').select('log_date,value,flag,flag_reason').eq('athlete_id', meId)
        .eq('metric', 'weight').gte('log_date', since).order('log_date'),
      ndb.from('nutrition_week_summary_view').select('*').eq('athlete_id', meId)
        .gte('week_of', since).order('week_of'),
      ndb.from('nutrition_targets').select('week_of,kcal_target,protein_g_low,protein_g_high')
        .eq('athlete_id', meId).gte('week_of', nAddDays(since, -14)).order('week_of'),
      ndb.from('body_metrics').select('log_date,metric,value,unit,flag').eq('athlete_id', meId)
        .not('metric', 'in', '(weight,steps,workout_min,event)').order('log_date').limit(120),
      ndb.from('planned_meals').select('id,meal_date,planned_kcal,planned_protein_g')
        .eq('athlete_id', meId).gte('meal_date', since4w).order('meal_date'),
      ndb.from('meal_logs').select('planned_meal_id,log_date,status,actual_kcal,actual_protein_g,actual_carbs_g,actual_fat_g')
        .eq('athlete_id', meId).gte('log_date', since4w),
      // FULL phase history (not just the active row) — drives chart shading + timeline.
      ndb.from('nutrition_phases').select('*').eq('athlete_id', meId).order('start_date'),
      // Activity spans the whole chart range now: it is a column in the energy
      // table, and its job is to explain WHY measured TDEE is drifting before
      // the lagging 28-day window catches up.
      ndb.from('body_metrics').select('log_date,metric,value,notes').eq('athlete_id', meId)
        .in('metric', ['steps', 'workout_min']).gte('log_date', since).order('log_date'),
      ndb.from('coach_reports').select('*').eq('athlete_id', meId)
        .order('week_of', { ascending: false }).order('calc_version', { ascending: false }).limit(20),
      // Energy panel needs per-day intake over the FULL selected range. Reading
      // planned_meals/meal_logs that far back would be ~7 rows per day — over a
      // year that silently blows past Supabase's default 1000-row cap, and a
      // truncated intake series produces a wrong TDEE with no error anywhere.
      // nutrition_day_view is one row per day, so 'all' is ~365 rows.
      ndb.from('nutrition_day_view')
        .select('day,week_of,meals_planned,meals_logged,n_added,actual_kcal,actual_protein_g')
        .eq('athlete_id', meId).gte('day', since).lte('day', nToday())
        .order('day').limit(800),
      // The day view can't see null-kcal logs (sum() skips nulls), and N09 §4
      // rule 9 excludes those days from TDEE. This probe returns only the
      // offending days, so it stays tiny. `.or` rather than `.neq` because a
      // null status would be dropped by .neq — see the measurement daily-nag bug.
      ndb.from('meal_logs').select('log_date').eq('athlete_id', meId)
        .is('actual_kcal', null).or('status.is.null,status.neq.skipped')
        .gte('log_date', since).limit(500),
    ]);
    if (NS.me.training_active) {
      [csq, ccq] = await Promise.all([
        ndb.from('completed_sessions').select('session_date,session_type,status')
          .eq('athlete_id', meId).gte('session_date', since4w),
        ndb.from('completed_conditioning').select('conditioning_date,duration_minutes')
          .eq('athlete_id', meId).gte('conditioning_date', since4w),
      ]);
    }
  } catch (e) {
    body.innerHTML = `<div class="n-panel">Trends failed to load: ${nEsc(e.message || e)}</div>`;
    return;
  }
  for (const q of [wq, sq, tq, mq, pq, lq, phq, aq, dvq, nkq]) {
    if (q && q.error) { body.innerHTML = `<div class="n-panel">Trends query failed: ${nEsc(q.error.message)}</div>`; return; }
  }
  // coach_reports may not exist yet on an un-migrated database — degrade quietly.
  const reports = (rq && !rq.error && rq.data) ? rq.data : [];

  const ACT0 = nActivityAgg(aq.data || [], { trend: nmTrendWeight(wq.data || []) });
  const D = nTrendsDerive(wq.data || [], sq.data || [], pq.data || [], lq.data || [],
                          phq.data || [], tq.data || [], dvq.data || [], nkq.data || [], ACT0);

  let html = '';
  html += nOverviewHtml(D, reports);
  html += nWeightEnergyCardHtml(D);
  html += nAdherenceHtml(D);
  html += nMeasurementsHtml(mq.data || []);
  // Training context stays its own card. It is strength-side context, not part
  // of the calories-in-vs-out story, and folding it into the combined view
  // would make that card do three unrelated jobs.
  if (NS.me.training_active && csq && !csq.error)
    html += nTrainingWeekHtml(csq.data || [], (ccq && ccq.data) || []);
  html += nHistoryHtml(D, reports);
  body.innerHTML = html;
}

function nSetRange(r) { NT.range = r; renderNTrends(); }
function nToggleMacros() { NT.showMacros = !NT.showMacros; renderNTrends(); }
function nToggleReport(id) { NT.openReport = (NT.openReport === id) ? null : id; renderNTrends(); }
function nToggleEnergyTable() { NT.energyTable = !NT.energyTable; renderNTrends(); }

// ── Shared derivations (fetch -> N09 engine) ──
function nTrendsDerive(weights, summary, planned, logs, phases, targets, dayView, nullKcal, ACT) {
  const trend = nmTrendWeight(weights);
  const windowDays = nTrendWindowDays();
  const rate = nmTrendRate(trend, windowDays);

  const activePhase = phases.find(p => p.status === 'active') || null;
  const rateGoal = activePhase ? nParseRateGoal(activePhase.rate_goal) : null;
  const pace = nmPaceVerdict(rate, rateGoal, activePhase && activePhase.phase_type);

  // Per-day planned/actual over the adherence window, shaped for the N09 engine.
  const logByPm = {}, days = {};
  for (const l of logs) if (l.planned_meal_id) logByPm[l.planned_meal_id] = l;
  const blank = () => ({ meals_planned: 0, meals_logged: 0, has_null_kcal: false,
    actual_kcal: null, actual_protein_g: null, planned_kcal: 0,
    carbs: 0, fat: 0, as_planned: 0, swapped: 0, skipped: 0, ate_out: 0, added: 0 });
  // Only shape days that have actually HAPPENED. Planned meals exist for the
  // whole Wed->Tue week the moment the plan is pushed, so counting future days
  // here would score them as unlogged and deflate compliance / logging tier for
  // the rest of the week (mid-week a perfect 4-of-7 days reads 57%, not 100%,
  // which is below the N02 3 interpretability gate). Mirrors the data_end cap
  // in 05_Scripts/pull_nutrition.py so the app and the coach pull can never
  // quote different adherence for the same week.
  const nmToday = nToday();
  for (const m of planned) {
    if (m.meal_date > nmToday) continue;
    const d = (days[m.meal_date] ||= blank());
    d.meals_planned++;
    d.planned_kcal += m.planned_kcal || 0;
    const l = logByPm[m.id];
    if (!l) continue;
    d.meals_logged++;
    if (l.status) d[l.status] = (d[l.status] || 0) + 1;
    if (l.actual_kcal == null && l.status !== 'skipped') { d.has_null_kcal = true; continue; }
    d.actual_kcal = (d.actual_kcal || 0) + (l.actual_kcal || 0);
    d.actual_protein_g = (d.actual_protein_g || 0) + (l.actual_protein_g || 0);
    d.carbs += l.actual_carbs_g || 0;
    d.fat += l.actual_fat_g || 0;
  }
  for (const l of logs) {
    if (l.planned_meal_id) continue;            // ad-hoc added items
    if (l.log_date > nmToday) continue;
    const d = (days[l.log_date] ||= blank());
    d.added++;
    if (l.actual_kcal == null) { d.has_null_kcal = true; continue; }
    d.actual_kcal = (d.actual_kcal || 0) + (l.actual_kcal || 0);
    d.actual_protein_g = (d.actual_protein_g || 0) + (l.actual_protein_g || 0);
    d.carbs += l.actual_carbs_g || 0;
    d.fat += l.actual_fat_g || 0;
  }

  // Weekly rollups on the Wednesday anchor (N09 §1).
  const byWeek = {};
  for (const [dt, d] of Object.entries(days)) (byWeek[nWednesday(dt)] ||= []).push({ ...d, day: dt });
  const tByWeek = {};
  for (const t of targets) tByWeek[t.week_of] = t;
  const weighInsByWeek = {};
  for (const r of weights) {
    if (r.flag === 'excluded') continue;
    weighInsByWeek[nWednesday(r.log_date)] = (weighInsByWeek[nWednesday(r.log_date)] || 0) + 1;
  }

  const thisWeek = nWednesday(nToday());
  const weekDays = byWeek[thisWeek] || [];
  const wkTarget = tByWeek[thisWeek] || NS.target || null;
  const unlogged = NS.checkin?.unlogged_eating || null;
  const logging = nmWeeklyLogging(weekDays, unlogged);
  const calories = nmCalorieAdherence(weekDays, wkTarget && wkTarget.kcal_target);
  const protein = nmProteinHitRate(weekDays, wkTarget && wkTarget.protein_g_low);
  const counts = weekDays.reduce((a, d) => ({
    meals_planned: a.meals_planned + d.meals_planned,
    as_planned: a.as_planned + d.as_planned, swapped: a.swapped + d.swapped,
  }), { meals_planned: 0, as_planned: 0, swapped: 0 });
  const compliance = nmCompliance(counts);
  const flaggedCount = weights.filter(r => r.flag === 'suspect' || r.flag === 'excluded').length;
  const confidence = nmConfidence({
    weighInsThisWeek: weighInsByWeek[thisWeek] || 0,
    loggingTier: logging.tier, unloggedEating: unlogged, flaggedCount,
  });

  // Goal: phase target first (this block's milestone), else the long-term range.
  const goalLow = activePhase?.goal_weight_low ?? NS.settings?.goal_weight_low ?? null;
  const goalHigh = activePhase?.goal_weight_high ?? NS.settings?.goal_weight_high ?? null;
  const goal = nmGoalProgress({
    trendWeight: trend.current, goalLow, goalHigh,
    startWeight: activePhase?.start_trend_weight ?? null,
  });

  // Target-change ticks: |Δ kcal| > 75 between consecutive weekly target rows.
  const ticks = [];
  for (let i = 1; i < targets.length; i++) {
    const d = targets[i].kcal_target - targets[i - 1].kcal_target;
    if (Math.abs(d) > 75) ticks.push({ week_of: targets[i].week_of, delta: d });
  }

  // ── Energy balance (N09 §3.7 / §3.8) ──
  // Day records for the whole chart range, from nutrition_day_view plus the
  // null-kcal probe. meals_logged excludes `added` rows so the tier matches the
  // per-meal path above: an ad-hoc snack is intake, not evidence that a planned
  // meal got logged.
  const nullKcalDays = {};
  for (const r of (nullKcal || [])) nullKcalDays[r.log_date] = true;
  const energyDays = (dayView || [])
    .filter(r => r.day <= nmToday)
    .map(r => ({
      day: r.day,
      meals_planned: Number(r.meals_planned) || 0,
      meals_logged: Math.max(0, (Number(r.meals_logged) || 0) - (Number(r.n_added) || 0)),
      has_null_kcal: !!nullKcalDays[r.day],
      actual_kcal: r.actual_kcal == null ? null : Number(r.actual_kcal),
      actual_protein_g: r.actual_protein_g == null ? null : Number(r.actual_protein_g),
    }));

  // One bucket per Wednesday week that has weight or intake data.
  const weekSet = {};
  for (const d of energyDays) weekSet[nWednesday(d.day)] = true;
  for (const pt of trend.points) weekSet[nWednesday(pt.date)] = true;
  const weekList = Object.keys(weekSet).sort();
  const weekEnds = weekList.map(w => { const e = nAddDays(w, 6); return e > nmToday ? nmToday : e; });

  const daysByWeek = {};
  for (const d of energyDays) (daysByWeek[nWednesday(d.day)] ||= []).push(d);

  // Confidence is per week: it gates whether that week's TDEE is shown at all
  // and how wide its band is (N09 §3.10). The check-in honesty answer only
  // exists for the current week, so history is judged on logging + weigh-ins.
  const confByWeek = {}, confReasonByWeek = {};
  for (let i = 0; i < weekList.length; i++) {
    const w = weekList[i];
    const isThis = w === thisWeek;
    const lg = nmWeeklyLogging(daysByWeek[w] || [], isThis ? unlogged : null);
    const c = nmConfidence({ weighInsThisWeek: weighInsByWeek[w] || 0, loggingTier: lg.tier,
      unloggedEating: isThis ? unlogged : null, flaggedCount: 0 });
    confByWeek[weekEnds[i]] = c.level;
    confReasonByWeek[weekEnds[i]] = c.reason;
  }

  // The current bucket is a PARTIAL week, and judging it like a finished one
  // makes the maintenance range vanish every Wednesday and reappear on
  // Saturday: nmConfidence drops to 'low' below 2 weigh-ins, which a week that
  // is two days old always is. Judge the live week on a rolling trailing 7 days
  // instead — which is what N09 §3.0 says the measurement window is anyway, so
  // this narrows the app/pull divergence that section flags rather than widening
  // it. Finished weeks keep their calendar-week confidence.
  if (weekList.length) {
    const last7 = nAddDays(nmToday, -6);
    const lg7 = nmWeeklyLogging(energyDays.filter(d => d.day >= last7), unlogged);
    const c7 = nmConfidence({
      weighInsThisWeek: trend.points.filter(pt => pt.date >= last7).length,
      loggingTier: lg7.tier, unloggedEating: unlogged, flaggedCount: flaggedCount,
    });
    const lastEnd = weekEnds[weekEnds.length - 1];
    confByWeek[lastEnd] = c7.level;
    confReasonByWeek[lastEnd] = c7.reason;
  }

  const tdeeSeries = nmTdeeSeries({ days: energyDays, trendPoints: trend.points,
    weekEnds, confidenceByWeek: confByWeek, confidenceReasonByWeek: confReasonByWeek });
  const tdeeNow = tdeeSeries.length ? tdeeSeries[tdeeSeries.length - 1]
    : nmTdee({ days: energyDays, trendPoints: trend.points, asOf: nmToday,
               confidence: confidence.level, confidenceReason: confidence.reason });

  const actByWeek = {};
  for (const a of ((ACT && ACT.weeks) || [])) actByWeek[a.week] = a;

  const energyWeeks = weekList.map((w, i) => {
    const wdays = daysByWeek[w] || [];
    // Same day filter TDEE uses, so the red line and the band are read off the
    // same evidence — a week whose average came from 2 days is not comparable
    // to one built from 7, and the day count travels with it into the table.
    const ok = wdays.filter(nmTdeeDayEligible);
    const lg = nmWeeklyLogging(wdays, w === thisWeek ? unlogged : null);
    const inWeek = trend.points.filter(pt => nWednesday(pt.date) === w);
    return { week_of: w, weekEnd: weekEnds[i],
      actualAvg: ok.length ? Math.round(ok.reduce((a, d) => a + d.actual_kcal, 0) / ok.length) : null,
      actualDays: ok.length,
      target: tByWeek[w] ? tByWeek[w].kcal_target : null,
      loggingTier: lg.tier, weighIns: weighInsByWeek[w] || 0,
      tdee: tdeeSeries[i] || null, activity: actByWeek[w] || null,
      trendAt: inWeek.length ? inWeek[inWeek.length - 1].trend : null };
  });

  // Projections (§3.8). Both aim at the same rate bounds; only the destination
  // differs — phase end is the actionable horizon, the goal range is the
  // destination, and for Amanda right now those are ~7 weeks and ~2 years apart.
  const seg = trend.segment || [];
  const weeksOfTrend = seg.length >= 2 ? nmDayDiff(seg[seg.length - 1].date, seg[0].date) / 7 : 0;
  let weeksBelowMostly = 0;
  for (let i = weekList.length - 1; i >= 0; i--) {
    const lg = nmWeeklyLogging(daysByWeek[weekList[i]] || [], null);
    if (lg.tier === 'full' || lg.tier === 'mostly') break;
    weeksBelowMostly++;
  }
  const pEnd = nmPhaseEnd(activePhase);
  const projBase = { trendWeight: trend.current, rate, phaseType: activePhase && activePhase.phase_type,
    weeksOfTrend, weeksLoggingBelowMostly: weeksBelowMostly, asOf: nmToday };
  const forecast = nmPhaseForecast({ ...projBase, phaseEnd: pEnd.date, phaseEndSource: pEnd.source });
  const goalEta = nmGoalEta({ ...projBase,
    targetWeight: (goalLow != null && goalHigh != null) ? (goalLow + goalHigh) / 2 : null });

  return { trend, rate, windowDays, pace, rateGoal, phases, activePhase, days, byWeek,
    tByWeek, weighInsByWeek, thisWeek, wkTarget, logging, calories, protein, compliance,
    confidence, goal, goalLow, goalHigh, ticks, weights, flaggedCount, summary,
    energyDays, energyWeeks, tdeeSeries, tdeeNow, phaseEnd: pEnd, forecast, goalEta,
    weeksOfTrend, weeksBelowMostly, today: nmToday };
}

// "0.75-1.0 lb/wk" / "~1 lb per week" -> 0.875 (midpoint of a range, else the value)
function nParseRateGoal(txt) {
  if (!txt) return null;
  const nums = String(txt).match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const v = nums.slice(0, 2).map(parseFloat);
  return v.length > 1 ? (v[0] + v[1]) / 2 : v[0];
}

// ─────────────────────────────── Card 1 — Overview ───────────────────────────
function nOverviewHtml(D, reports) {
  const ph = D.activePhase;
  const chip = ph
    ? `${nEsc(nPhaseLabel(ph.phase_type))}${ph.start_date ? ` · wk ${Math.floor(nmDayDiff(nToday(), ph.start_date) / 7) + 1}` : ''}`
    : 'No active phase';

  // Line 2 — trend verdict.
  let verdict;
  if (!D.trend.displayable) {
    verdict = `<span style="color:var(--n-muted)">Trend not established yet — ${nEsc(D.trend.reason || 'keep weighing in')}.</span>`;
  } else if (D.rate == null) {
    verdict = `<span style="color:var(--n-muted)">Trend weight ${D.trend.current.toFixed(1)} lb — not enough span yet for a rate.</span>`;
  } else if (D.pace.holding) {
    verdict = `Holding <b>${D.trend.current.toFixed(1)} lb</b> ${D.pace.status === 'on' ? '✓' : '— drifting'}`;
  } else {
    const word = { on: '✓', ahead: '— faster than planned', behind: '— slower than planned',
      unknown: '' }[D.pace.status] || '';
    const goalTxt = ph && ph.rate_goal ? ` (goal ${nEsc(ph.rate_goal)})` : '';
    verdict = `Trending <b>${D.rate > 0 ? '+' : ''}${D.rate.toFixed(1)} lb/wk</b>${goalTxt} ${word}`;
  }

  // Line 3 — adherence headline.
  const adh = [];
  if (D.logging.totalDays) adh.push(`logging ${Math.round(D.logging.share * 100)}%`);
  if (D.calories.status !== 'unknown') adh.push(`calories ${D.calories.status}`);
  if (D.protein.total) adh.push(`protein ${D.protein.hit}/${D.protein.total} days`);
  const adhLine = adh.length
    ? `<div style="font-size:13px;color:var(--n-text);margin-top:3px">${adh.join(' · ')}</div>` : '';

  // Line 4 — the coach's focus from the latest stored report.
  const latest = reports && reports.length ? reports[0] : null;
  const focus = latest && latest.focus
    ? `<div style="font-size:13px;color:var(--n-text);margin-top:6px;padding-left:8px;border-left:3px solid var(--n-accent,#ff2712)">
         <b>This week's focus:</b> ${nEsc(latest.focus)}</div>` : '';

  // Goal progress (1.2) — suppressed until there's a trend to measure from.
  let goalLine = '';
  if (D.goal && D.trend.displayable) {
    if (D.goal.inRange) {
      goalLine = `<div style="font-size:12px;color:var(--n-muted);margin-top:4px">🎯 In your goal range (${D.goalLow}–${D.goalHigh} lb).</div>`;
    } else if (D.goal.pct != null) {
      goalLine = `<div style="margin-top:6px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--n-muted)">
          <span>🎯 ${D.goal.done} of ~${D.goal.total} lb</span><span>${D.goal.toGo} lb to go</span></div>
        <div class="n-budget-bar" style="margin-top:3px"><div class="n-budget-fill ok" style="width:${Math.min(100, D.goal.pct)}%"></div></div></div>`;
    } else {
      goalLine = `<div style="font-size:12px;color:var(--n-muted);margin-top:4px">🎯 ${D.goal.toGo} lb to your goal range (${D.goalLow}–${D.goalHigh} lb).</div>`;
    }
  }

  // Warning strip — ONE banner max, highest severity wins (N09 §4).
  const banner = nOverviewBanner(D);

  // Empty state: nothing logged at all yet.
  if (!D.trend.points.length && !D.logging.totalDays) {
    return `<div class="n-panel"><div class="n-panel-title">📊 Overview</div>
      <div style="font-size:13px;color:var(--n-text)">Nothing logged yet. Weigh in and log meals on the
      Today tab — your trend line appears after 5 weigh-ins, and your first coach report arrives
      after your first full week.</div></div>`;
  }

  return `<div class="n-panel"><div class="n-panel-title">📊 ${nEsc(chip)}</div>
    ${banner}
    <div style="font-size:15px;color:var(--n-text)">${verdict}</div>
    ${adhLine}${goalLine}${focus}
    ${latest && latest.progress_summary
      ? `<div style="font-size:12px;color:var(--n-muted);margin-top:6px">${nEsc(latest.progress_summary)}</div>` : ''}
  </div>`;
}

function nPhaseLabel(t) {
  return { fat_loss: 'Fat loss', maintenance: 'Maintenance', diet_break: 'Diet break',
    lean_gain: 'Lean gain', recomp: 'Recomp', baseline: 'Baseline' }[t] || (t || 'Phase');
}

// Highest-severity single banner. Order matters — this is the "one banner max" rule.
function nOverviewBanner(D) {
  const wi = D.weighInsByWeek[D.thisWeek] || 0;
  let msg = null;
  if (D.logging.interpretable === false)
    msg = 'Check-in reported a lot of unlogged eating — this week can\'t drive a calorie decision. That\'s information, not a failure.';
  else if (wi < 2 && D.trend.points.length)
    msg = `Only ${wi} weigh-in${wi === 1 ? '' : 's'} this week — the trend is paused until there are 2+.`;
  else if (D.flaggedCount > 0)
    msg = `${D.flaggedCount} weigh-in${D.flaggedCount === 1 ? ' is' : 's are'} flagged and excluded from the trend.`;
  else if (D.confidence.level === 'low' && D.confidence.reason)
    msg = `Data is thin this week — ${D.confidence.reason}.`;
  if (!msg) return '';
  return `<div style="background:#fff6e5;border-left:3px solid #e8940a;padding:7px 9px;border-radius:5px;
    font-size:12px;color:#7a5200;margin-bottom:8px">${nEsc(msg)}</div>`;
}

// ────────────────── Card 2 — Weight + Energy balance (combined) ───────────────
// Two panels, one shared x scale, one shared set of phase bands. They are drawn
// as two <svg> elements rather than one so each panel can carry its own header,
// legend and axis the way a chart normally does — alignment is guaranteed
// instead by both using the identical viewBox width, PADL/PADR and X() below,
// and both rendering at width:100%. Same geometry in, same pixels out.
//
// Weight (lb) and energy (kcal) NEVER share a y-axis — different units, and a
// dual axis invites a slope comparison that means nothing.
//
// Colour vocabulary, deliberately small:
//   red    #ff2712  the weight trend (the app's existing brand accent — unchanged)
//   orange #c2410c  calories actually eaten
//   blue   #2a6fb0  the plan (target line, target-change ticks)
//   gray   #dcdcd7  uncertainty (the maintenance band)
//   pale tints      phase identity, labelled in-band in BOTH panels
// Deficit/surplus gets no background wash: the phase tints already own flat pale
// colour here, a wash restates what the line-vs-band geometry shows, and it has
// no honest state for a week landing INSIDE a ±100–200 kcal band. Baseline
// glyph instead, absent when the answer is "too close to call".
const NT_RED = '#ff2712', NT_ORANGE = '#c2410c', NT_BLUE = '#2a6fb0', NT_GRAY = '#dcdcd7';
const NT_W = 340, NT_PADL = 32, NT_PADR = 12;

// Round, human y-axis values — 1/2/5×10ⁿ steps, the standard nice-number rule.
function nNiceTicks(lo, hi, want) {
  if (!(hi > lo)) return [];
  const raw = (hi - lo) / Math.max(1, want);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
const NT_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function nMonthDay(ymd) { const d = nmDate(ymd); return `${NT_MON[d.getMonth()]} ${d.getDate()}`; }

// Phase bands, resolved once and drawn identically in both panels.
function nPhaseBands(D, d0, d1, X) {
  const fill = { fat_loss: '#eaf4ea', maintenance: '#eef1f6', diet_break: '#fdf3e6',
    lean_gain: '#f2ecf8', recomp: '#eaf2f6', baseline: '#f4f4f2' };
  const bands = [];
  for (const ph of D.phases || []) {
    if (!ph.start_date) continue;
    const s = ph.start_date > d0 ? ph.start_date : d0;
    const e = ph.end_date && ph.end_date < d1 ? ph.end_date : d1;
    if (s > e) continue;
    const x1 = X(s), x2 = X(e);
    if (x2 - x1 < 1) continue;
    bands.push({ x1, x2, type: ph.phase_type, boundary: ph.start_date > d0 ? x1 : null,
      fill: fill[ph.phase_type] || '#f4f4f2', active: ph.status === 'active' });
  }
  return bands;
}

// In-band phase labels. This card renders at 340px on a phone, so a year view
// with six phases cannot fit "MAINTENANCE" six times — narrow bands get the
// abbreviation and very narrow ones get nothing rather than overlapping text.
const NT_PHASE_SHORT = { fat_loss: 'FAT LOSS', maintenance: 'MAINT', diet_break: 'BREAK',
  lean_gain: 'GAIN', recomp: 'RECOMP', baseline: 'BASE' };
function nBandLabels(bands, y) {
  let out = '';
  for (const b of bands) {
    const w = b.x2 - b.x1;
    const full = nPhaseLabel(b.type).toUpperCase();
    const label = w >= full.length * 5.2 + 8 ? full
      : w >= (NT_PHASE_SHORT[b.type] || '').length * 5.2 + 8 ? (NT_PHASE_SHORT[b.type] || '')
      : null;
    if (!label) continue;
    out += `<text x="${(b.x1 + 4).toFixed(1)}" y="${y}" font-size="7" fill="#8a8a84"
      letter-spacing="0.6">${label}</text>`;
  }
  return out;
}

function nBandRects(bands, top, bot) {
  let out = '';
  for (const b of bands) {
    out += `<rect x="${b.x1.toFixed(1)}" y="${top}" width="${(b.x2 - b.x1).toFixed(1)}"
      height="${bot - top}" fill="${b.fill}"/>`;
    if (b.boundary != null)
      out += `<line x1="${b.boundary.toFixed(1)}" y1="${top}" x2="${b.boundary.toFixed(1)}" y2="${bot}"
        stroke="#c9c9c4" stroke-width="1" stroke-dasharray="2,3"/>`;
  }
  return out;
}

function nLegend(items) {
  return `<div style="display:flex;flex-wrap:wrap;gap:9px;justify-content:flex-end;
    font-size:10px;color:var(--n-muted);align-items:center">${items.map(i => {
    const sw = i.kind === 'dot'
      ? `<span style="width:7px;height:7px;border-radius:50%;background:${i.color};display:inline-block"></span>`
      : i.kind === 'band'
      ? `<span style="width:12px;height:8px;background:${i.color};border:1px solid #b9b9b3;display:inline-block"></span>`
      : i.kind === 'dash'
      ? `<span style="width:14px;height:0;border-top:2px dashed ${i.color};display:inline-block"></span>`
      : `<span style="width:14px;height:0;border-top:2px solid ${i.color};display:inline-block"></span>`;
    return `<span style="display:inline-flex;align-items:center;gap:4px">${sw}${nEsc(i.label)}</span>`;
  }).join('')}</div>`;
}

function nPanelHead(title, sub, legendItems) {
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
      <div><div style="font-size:13px;font-weight:600;color:var(--n-text)">${nEsc(title)}</div>
        <div style="font-size:11px;color:var(--n-muted);margin-top:1px">${sub}</div></div>
      ${nLegend(legendItems)}</div>`;
}

function nWeightEnergyCardHtml(D) {
  const ranges = Object.keys(NT_RANGES).map(r =>
    `<button class="n-chip${NT.range === r ? ' active' : ''}" onclick="nSetRange('${r}')">${r}</button>`).join('');

  const pts = D.trend.points;
  const EW = D.energyWeeks || [];
  const haveEnergy = EW.some(w => w.actualAvg != null || w.target != null);
  const head = `<div class="n-panel-title">⚖️ Weight &amp; energy balance</div>
    <div class="n-prompt-row" style="gap:4px;margin-bottom:4px">${ranges}</div>
    <div style="font-size:11px;color:var(--n-muted);margin-bottom:10px">${
      D.goalLow != null ? `Long-term goal <b style="color:var(--n-text)">${D.goalLow}–${D.goalHigh} lb</b> · ` : ''
    }trend window ${D.windowDays}-day</div>`;

  if (!pts.length && !haveEnergy)
    return `<div class="n-panel">${head}<div style="font-size:13px;color:var(--n-text)">
      No weigh-ins or logged meals in this range. Weigh in and log on the Today tab — same scale,
      on waking, after the bathroom, before food or water.</div></div>`;

  // ── ONE shared x scale, used by both panels ──
  const fc = D.forecast && !D.forecast.suppressed ? D.forecast : null;
  const dataDates = pts.map(p => p.date)
    .concat(EW.filter(w => w.actualAvg != null || w.target != null).map(w => w.week_of));
  const d0 = dataDates.length ? dataDates.slice().sort()[0] : nAddDays(D.today, -30);
  const dEnd = D.today;
  const d1 = fc && fc.phaseEnd > dEnd ? fc.phaseEnd : dEnd;
  const span = Math.max(1, nmDayDiff(d1, d0));
  const X = d => NT_PADL + (NT_W - NT_PADL - NT_PADR) * (Math.max(0, Math.min(span, nmDayDiff(d, d0))) / span);
  const bands = nPhaseBands(D, d0, d1, X);
  const todayX = X(dEnd);

  // Shared x-axis ticks — five evenly spaced dates, same positions in both panels.
  const xTicks = [];
  for (let i = 0; i <= 4; i++) xTicks.push(nAddDays(d0, Math.round(span * i / 4)));
  const xAxis = y => xTicks.map((t, i) => {
    const x = X(t);
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
    return `<text x="${x.toFixed(1)}" y="${y}" font-size="8" fill="#8a8a84" text-anchor="${anchor}">${nMonthDay(t)}</text>`;
  }).join('');
  const todayMark = (top, bot, labelY) =>
    todayX > NT_PADL + 6 && todayX < NT_W - NT_PADR - 6
      ? `<line x1="${todayX.toFixed(1)}" y1="${top}" x2="${todayX.toFixed(1)}" y2="${bot}"
           stroke="#8a8a84" stroke-width="1" stroke-dasharray="2,2"/>
         <text x="${todayX.toFixed(1)}" y="${labelY}" font-size="7" fill="#8a8a84"
           text-anchor="middle" letter-spacing="0.5">TODAY</text>` : '';

  // ═══════════════ Panel 1 — Scale weight ═══════════════
  const H1 = 196, T1 = 26, B1 = 158;          // label row above plot, axis below
  const wVals = pts.map(p => p.raw).concat(pts.map(p => p.trend));
  if (D.goalLow != null && D.trend.displayable) { wVals.push(D.goalLow); wVals.push(D.goalHigh); }
  if (fc) { wVals.push(fc.low); wVals.push(fc.high); }
  let wLo = 0, wHi = 1;
  if (wVals.length) {
    wLo = Math.min(...wVals) - 1; wHi = Math.max(...wVals) + 1;
    if (wHi - wLo < 4) { const m = (wHi + wLo) / 2; wLo = m - 2; wHi = m + 2; }
  }
  const YW = v => T1 + (B1 - T1) * (1 - (v - wLo) / (wHi - wLo));
  const wTicks = nNiceTicks(wLo, wHi, 4);
  const wGrid = wTicks.map(v =>
    `<line x1="${NT_PADL}" y1="${YW(v).toFixed(1)}" x2="${NT_W - NT_PADR}" y2="${YW(v).toFixed(1)}"
       stroke="#e6e6e1" stroke-width="0.75"/>
     <text x="${NT_PADL - 4}" y="${(YW(v) + 3).toFixed(1)}" font-size="8" fill="#8a8a84"
       text-anchor="end">${v.toFixed(v % 1 ? 1 : 0)}</text>`).join('');

  let goalBand = '';
  if (D.activePhase && D.rateGoal && D.activePhase.phase_type === 'fat_loss'
      && D.activePhase.start_date && D.trend.displayable) {
    const st = D.activePhase.start_date > d0 ? D.activePhase.start_date : d0;
    const seed = pts.find(p => p.date >= st);
    if (seed) {
      const wks = nmDayDiff(dEnd, seed.date) / 7;
      goalBand = `<polygon points="${X(seed.date).toFixed(1)},${YW(seed.trend).toFixed(1)}
        ${todayX.toFixed(1)},${YW(seed.trend - D.rateGoal * 0.6 * wks).toFixed(1)}
        ${todayX.toFixed(1)},${YW(seed.trend - D.rateGoal * 1.4 * wks).toFixed(1)}"
        fill="#4caf50" opacity="0.13"/>`;
    }
  }

  let cone = '';
  if (fc) {
    const x1c = X(fc.phaseEnd), y0 = YW(D.trend.current);
    cone = `<polygon points="${todayX.toFixed(1)},${y0.toFixed(1)} ${x1c.toFixed(1)},${YW(fc.high).toFixed(1)}
        ${x1c.toFixed(1)},${YW(fc.low).toFixed(1)}" fill="${NT_RED}" opacity="0.10"/>
      <line x1="${todayX.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1c.toFixed(1)}" y2="${YW(fc.high).toFixed(1)}"
        stroke="${NT_RED}" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>
      <line x1="${todayX.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1c.toFixed(1)}" y2="${YW(fc.low).toFixed(1)}"
        stroke="${NT_RED}" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>
      <text x="${(x1c - 2).toFixed(1)}" y="${T1 - 14}" font-size="7" fill="#8a8a84"
        text-anchor="end" letter-spacing="0.5">PHASE END</text>`;
  }

  const dots = pts.map(p =>
    `<circle cx="${X(p.date).toFixed(1)}" cy="${YW(p.raw).toFixed(1)}" r="2" fill="#9a9a94"
      ><title>${p.date}: ${p.raw.toFixed(1)} lb</title></circle>`).join('');

  let trendPath = '';
  if (pts.length >= 2) {
    let seg = [];
    for (const p of pts) { if (p.restarted && seg.length) { trendPath += nPathFrom(seg, X, YW); seg = []; } seg.push(p); }
    if (seg.length) trendPath += nPathFrom(seg, X, YW);
  }

  // "Fat loss · wk 3 of 7" — the block position, using the same phase-end the
  // forecast aims at, so the two can never tell different stories.
  const ph = D.activePhase;
  let phaseTxt = 'No active phase';
  if (ph) {
    const n = ph.start_date ? Math.floor(nmDayDiff(D.today, ph.start_date) / 7) + 1 : null;
    const tot = D.phaseEnd && D.phaseEnd.date && ph.start_date
      ? Math.round(nmDayDiff(D.phaseEnd.date, ph.start_date) / 7) : null;
    // A phase that has run past its block shows that plainly rather than
    // rendering "wk 9 of 3". Overdue is information, not a formatting problem.
    let wk = '';
    if (n && tot && n <= tot) wk = ` · wk ${n} of ${tot}`;
    else if (n && tot) wk = ` · wk ${n}, past a typical ${tot}-wk block`;
    else if (n) wk = ` · wk ${n}`;
    phaseTxt = nPhaseLabel(ph.phase_type) + wk;
  }
  const wSub = D.trend.displayable
    ? `Trend <b style="color:var(--n-text)">${D.trend.current.toFixed(1)} lb</b>${
        D.rate != null ? ` · ${D.rate > 0 ? '+' : ''}${D.rate.toFixed(1)} lb/wk` : ''} · ${nEsc(phaseTxt)}`
    : `${nEsc(D.trend.reason || 'Trend not established yet')} · ${nEsc(phaseTxt)}`;

  const wLegend = [{ kind: 'dot', color: '#9a9a94', label: 'Weigh-in' },
    { kind: 'line', color: NT_RED, label: 'Trend (EWMA)' }];
  if (goalBand) wLegend.push({ kind: 'band', color: '#bfe0c0', label: 'Goal corridor' });
  if (cone) wLegend.push({ kind: 'dash', color: NT_RED, label: 'Forecast' });

  const panel1 = `<div class="n-zoomable" onclick="nChartZoomOpen(this)">${nPanelHead('Scale weight', wSub, wLegend)}
    <svg viewBox="0 0 ${NT_W} ${H1}" style="width:100%;margin-top:2px">
      ${nBandRects(bands, T1, B1)}${nBandLabels(bands, T1 - 5)}${wGrid}${goalBand}${cone}
      ${todayMark(T1, B1, T1 - 14)}${dots}
      ${D.trend.displayable ? `<path d="${trendPath}" fill="none" stroke="${NT_RED}" stroke-width="2.5" stroke-linejoin="round"/>` : ''}
      <line x1="${NT_PADL}" y1="${B1}" x2="${NT_W - NT_PADR}" y2="${B1}" stroke="#c9c9c4" stroke-width="1"/>
      ${xAxis(B1 + 13)}
    </svg>${nZoomHint()}</div>`;

  // ═══════════════ Panel 2 — Energy balance ═══════════════
  const H2 = 186, T2 = 26, B2 = 132, CY = 148;
  const eVals = [];
  for (const w of EW) {
    if (w.actualAvg != null) eVals.push(w.actualAvg);
    if (w.target != null) eVals.push(w.target);
    if (w.tdee && w.tdee.shown != null) { eVals.push(w.tdee.shownLow); eVals.push(w.tdee.shownHigh); }
  }
  let eLo = 0, eHi = 1;
  if (eVals.length) {
    eLo = Math.min(...eVals); eHi = Math.max(...eVals);
    const pad = Math.max(150, (eHi - eLo) * 0.18);
    eLo -= pad; eHi += pad;
  }
  const YE = v => T2 + (B2 - T2) * (1 - (v - eLo) / (eHi - eLo));
  const eTicks = eVals.length ? nNiceTicks(eLo, eHi, 4) : [];
  const eGrid = eTicks.map(v =>
    `<line x1="${NT_PADL}" y1="${YE(v).toFixed(1)}" x2="${NT_W - NT_PADR}" y2="${YE(v).toFixed(1)}"
       stroke="#e6e6e1" stroke-width="0.75"/>
     <text x="${NT_PADL - 4}" y="${(YE(v) + 3).toFixed(1)}" font-size="8" fill="#8a8a84"
       text-anchor="end">${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)}</text>`).join('');

  const wx = w => { const e = nAddDays(w.week_of, 6); return { x1: X(w.week_of), x2: X(e > D.today ? D.today : e) }; };
  const wmid = w => { const s = wx(w); return (s.x1 + s.x2) / 2; };

  let tdeeBand = '', run = [];
  const flushBand = () => {
    if (run.length) {
      const top = [], bot = [];
      for (const w of run) {
        const s = wx(w);
        top.push(`${s.x1.toFixed(1)},${YE(w.tdee.shownHigh).toFixed(1)}`, `${s.x2.toFixed(1)},${YE(w.tdee.shownHigh).toFixed(1)}`);
        bot.push(`${s.x2.toFixed(1)},${YE(w.tdee.shownLow).toFixed(1)}`, `${s.x1.toFixed(1)},${YE(w.tdee.shownLow).toFixed(1)}`);
      }
      tdeeBand += `<polygon points="${top.concat(bot.reverse()).join(' ')}" fill="${NT_GRAY}"
        opacity="0.9" stroke="#b9b9b3" stroke-width="0.75"/>`;
    }
    run = [];
  };
  for (const w of EW) { if (w.tdee && w.tdee.shown != null) run.push(w); else flushBand(); }
  flushBand();

  let planLine = '', planRun = [];
  const flushPlan = () => {
    if (planRun.length) planLine += `<path d="${planRun.map(w => { const s = wx(w), y = YE(w.target).toFixed(1);
      return `M${s.x1.toFixed(1)},${y} L${s.x2.toFixed(1)},${y}`; }).join(' ')}"
      fill="none" stroke="${NT_BLUE}" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.9"/>`;
    planRun = [];
  };
  for (const w of EW) { if (w.target != null) planRun.push(w); else flushPlan(); }
  flushPlan();

  let actLine = '', actDots = '', actRun = [];
  const flushAct = () => {
    if (actRun.length >= 2) actLine += `<path d="${actRun.map((w, i) =>
      `${i ? 'L' : 'M'}${wmid(w).toFixed(1)},${YE(w.actualAvg).toFixed(1)}`).join(' ')}"
      fill="none" stroke="${NT_ORANGE}" stroke-width="2" stroke-linejoin="round"/>`;
    actRun = [];
  };
  for (const w of EW) { if (w.actualAvg != null) actRun.push(w); else flushAct(); }
  flushAct();
  for (const w of EW) {
    if (w.actualAvg == null) continue;
    actDots += `<circle cx="${wmid(w).toFixed(1)}" cy="${YE(w.actualAvg).toFixed(1)}" r="2" fill="${NT_ORANGE}"
      ><title>wk ${w.week_of}: ${w.actualAvg.toLocaleString()} kcal/day over ${w.actualDays} day${w.actualDays === 1 ? '' : 's'}</title></circle>`;
  }

  let carets = '';
  for (const w of EW) {
    if (w.actualAvg == null || !w.tdee || w.tdee.shown == null) continue;
    const x = wmid(w);
    if (w.actualAvg < w.tdee.shownLow)
      carets += `<polygon points="${(x - 3).toFixed(1)},${CY - 4} ${(x + 3).toFixed(1)},${CY - 4} ${x.toFixed(1)},${CY + 1}"
        fill="#6b6b66"><title>wk ${w.week_of}: ~${(w.tdee.shown - w.actualAvg).toLocaleString()} kcal/day under maintenance</title></polygon>`;
    else if (w.actualAvg > w.tdee.shownHigh)
      carets += `<polygon points="${(x - 3).toFixed(1)},${CY + 1} ${(x + 3).toFixed(1)},${CY + 1} ${x.toFixed(1)},${CY - 4}"
        fill="#6b6b66"><title>wk ${w.week_of}: ~${(w.actualAvg - w.tdee.shown).toLocaleString()} kcal/day over maintenance</title></polygon>`;
  }

  const T = D.tdeeNow;
  const eSub = T && T.sufficient
    ? `Maintenance <b style="color:var(--n-text)">${T.low.toLocaleString()}–${T.high.toLocaleString()} kcal</b> · confidence ${T.confidence}${
        T.recalibrating ? ' · <span style="color:#7a5200">recalibrating</span>' : ''}`
    : `Maintenance not available yet — ${nEsc((T && T.reason) || 'not enough data')}${
        ph && ph.maintenance_estimate_kcal ? ` · coach's estimate ~${ph.maintenance_estimate_kcal.toLocaleString()}` : ''}`;

  const eLegend = [];
  if (tdeeBand) eLegend.push({ kind: 'band', color: NT_GRAY, label: 'Maintenance' });
  eLegend.push({ kind: 'line', color: NT_ORANGE, label: 'Calories actual' },
    { kind: 'dash', color: NT_BLUE, label: 'Calories planned' });

  const panel2 = `<div style="margin-top:14px;border-top:1px solid var(--n-line,#e6e6e1);padding-top:10px">
    <div class="n-zoomable" onclick="nChartZoomOpen(this)">${nPanelHead('Energy balance', eSub, eLegend)}
    <svg viewBox="0 0 ${NT_W} ${H2}" style="width:100%;margin-top:2px">
      ${nBandRects(bands, T2, B2)}${nBandLabels(bands, T2 - 5)}${eGrid}${tdeeBand}
      ${todayMark(T2, B2, T2 - 14)}${planLine}${actLine}${actDots}${carets}
      <line x1="${NT_PADL}" y1="${B2}" x2="${NT_W - NT_PADR}" y2="${B2}" stroke="#c9c9c4" stroke-width="1"/>
      ${D.ticks.map(tk => (tk.week_of < d0 || tk.week_of > d1) ? '' :
        `<line x1="${X(tk.week_of).toFixed(1)}" y1="${B2}" x2="${X(tk.week_of).toFixed(1)}" y2="${B2 + 5}"
           stroke="${NT_BLUE}" stroke-width="2"><title>Target ${tk.delta > 0 ? '+' : ''}${tk.delta} kcal on ${tk.week_of}</title></line>`).join('')}
      ${xAxis(B2 + 30)}
      ${carets ? `<text x="${NT_PADL - 4}" y="${CY + 2}" font-size="7" fill="#8a8a84" text-anchor="end">bal</text>` : ''}
    </svg>${nZoomHint()}</div></div>`;

  // ── projection sub-lines ──
  const F = D.forecast || {};
  let fcLine;
  if (fc) {
    // nmPhaseEnd already returns the block length it assumed — don't recompute it.
    const src = fc.source === 'default' && D.phaseEnd && D.phaseEnd.weeks
      ? ` <span style="color:var(--n-muted)">(assumed ${D.phaseEnd.weeks}-week block — no end date set)</span>` : '';
    fcLine = `<b>${fc.low.toFixed(1)}–${fc.high.toFixed(1)} lb</b> by ${fc.phaseEnd} at this rate${src}`;
  } else if (F.holding) {
    fcLine = `<span style="color:var(--n-muted)">Holding, not heading somewhere — no projection during a ${
      nEsc(nPhaseLabel(ph && ph.phase_type).toLowerCase())}.</span>`;
  } else {
    fcLine = `<span style="color:var(--n-muted)">No projection yet — ${nEsc(F.reason || 'not enough data')}.</span>`;
  }
  const GE = D.goalEta || {};
  const goalLine = (!GE.suppressed && GE.label)
    ? `<div style="font-size:11px;color:var(--n-muted);margin-top:2px">Goal range around
        <b style="color:var(--n-text)">${nEsc(GE.label)}</b> if this rate holds.</div>` : '';
  const reEst = D.trend.restarts.length && !D.trend.displayable
    ? `<div style="font-size:11px;color:#7a5200;margin-top:3px">Trend re-establishing after a gap in weigh-ins.</div>` : '';

  return `<div class="n-panel">${head}${panel1}${panel2}
    <div style="font-size:12px;color:var(--n-text);margin-top:9px">${fcLine}</div>${goalLine}${reEst}
    ${nEnergyTableHtml(D)}
    <div style="font-size:11px;color:var(--n-muted);margin-top:8px">Sodium, carbs, cycle, and digestion
    move the scale 2–5 lb day to day. The line is the signal; the dots are noise. Activity is context
    only — it is already inside the scale-based maintenance range, so adding it would double-count.</div></div>`;
}
// ── The weekly numbers behind both panels ──
// Default collapsed. This exists so that NOTHING in the chart is reachable only
// by hovering: this app is used on a phone, where hover does not exist. It is
// also why there is no crosshair — the table is the read-the-numbers affordance,
// and a crosshair would be a desktop-only duplicate of it.
//
// The activity column is the point of the whole card. Measured TDEE moves on a
// lagging 28-day window, so a real activity change (illness, travel, a lighter
// block) will not bend the gray band for a couple of weeks. Seeing steps and
// workout minutes plainly, per week, is what explains a drift before the lag
// catches up — and it stays a NUMBER here rather than a line on the chart,
// because plotting it next to the band would imply it belongs in the estimate.
function nEnergyTableHtml(D) {
  const EW = (D.energyWeeks || []).slice().reverse();     // newest first
  if (!EW.length) return '';
  const open = NT.energyTable;
  const head = `<div onclick="nToggleEnergyTable()" role="button" tabindex="0" style="cursor:pointer;
      display:flex;align-items:center;gap:7px;margin-top:10px;padding:8px 10px;
      border:1px solid var(--n-border,#dcdcd7);border-radius:6px;background:var(--n-bg,#f4f4f1)">
      <span style="font-size:12px;color:var(--n-muted);transform:rotate(${open ? 90 : 0}deg);
        display:inline-block;transition:transform .15s">▶</span>
      <span style="font-size:12px;font-weight:600;color:var(--n-text)">${open ? 'Hide' : 'View'} weekly numbers</span>
      <span style="font-size:11px;color:var(--n-muted)">(${EW.length} week${EW.length === 1 ? '' : 's'})</span>
    </div>`;
  if (!NT.energyTable) return head;

  const tierColor = { full: '#2e9e3e', mostly: '#7aa32e', partial: '#e8940a', none: '#b9b9b3' };
  const kc = v => v == null ? '—' : v.toLocaleString();

  let rows = '';
  for (const w of EW) {
    const T = w.tdee;
    let tdeeTxt;
    if (T && T.shown != null) {
      tdeeTxt = `${T.shownLow.toLocaleString()}–${T.shownHigh.toLocaleString()}`;
      // The reconstructed series is honest about being reconstructed: only the
      // most recent week was ever computed live. Everything older is this same
      // math re-run over a past window (see N09 §3.7.1), which is a different
      // object from "the number we stood behind at the time".
      if (T.recalibrating) tdeeTxt += ' <span style="color:#7a5200">·recal</span>';
      if (T.confidence === 'medium') tdeeTxt += ' <span style="color:var(--n-muted)">·med</span>';
    } else {
      tdeeTxt = '<span style="color:var(--n-muted)">—</span>';
    }

    let balance = '—';
    if (w.actualAvg != null && T && T.shown != null) {
      if (w.actualAvg < T.shownLow) balance = `▼ ${(T.shown - w.actualAvg).toLocaleString()}`;
      else if (w.actualAvg > T.shownHigh) balance = `▲ ${(w.actualAvg - T.shown).toLocaleString()}`;
      else balance = '<span style="color:var(--n-muted)">in band</span>';
    }

    const a = w.activity;
    const actTxt = a
      ? [a.avgSteps != null ? `${a.avgSteps.toLocaleString()} st` : null,
         a.wMin ? `${a.wMin}m` : null].filter(Boolean).join(' · ') || '—'
      : '—';

    rows += `<tr>
      <td style="padding:3px 4px 3px 0;white-space:nowrap">${w.week_of.slice(5)}</td>
      <td style="padding:3px 4px;text-align:right">${kc(w.target)}</td>
      <td style="padding:3px 4px;text-align:right">${kc(w.actualAvg)}${
        w.actualAvg != null ? `<span style="color:var(--n-muted);font-size:10px"> /${w.actualDays}d</span>` : ''}</td>
      <td style="padding:3px 4px;text-align:right;white-space:nowrap">${tdeeTxt}</td>
      <td style="padding:3px 4px;text-align:right;white-space:nowrap">${balance}</td>
      <td style="padding:3px 4px;text-align:right;white-space:nowrap;color:var(--n-muted)">${actTxt}</td>
      <td style="padding:3px 0 3px 4px;text-align:right;white-space:nowrap">${
        w.trendAt != null ? w.trendAt.toFixed(1) : '—'}<span style="color:${
        tierColor[w.loggingTier] || '#b9b9b3'};font-size:10px"> ●</span></td>
    </tr>`;
  }

  const anyTdee = EW.some(w => w.tdee && w.tdee.shown != null);
  const note = anyTdee
    ? `Maintenance for past weeks is recomputed from your logs now, not what the app showed at the time — the
       100 kcal/week movement cap only governs the live estimate.`
    : `Maintenance stays blank until a 28-day window holds 14 fully-logged days and 6 weigh-ins. A number built
       on partial logging is worse than no number.`;

  return `${head}
    <div style="overflow-x:auto;margin-top:6px">
    <table style="width:100%;border-collapse:collapse;font-size:11px;color:var(--n-text)">
      <thead><tr style="color:var(--n-muted);text-align:right">
        <th style="text-align:left;padding:0 4px 4px 0;font-weight:500">wk</th>
        <th style="padding:0 4px 4px;font-weight:500">plan</th>
        <th style="padding:0 4px 4px;font-weight:500">actual</th>
        <th style="padding:0 4px 4px;font-weight:500">maint.</th>
        <th style="padding:0 4px 4px;font-weight:500">balance</th>
        <th style="padding:0 4px 4px;font-weight:500">activity</th>
        <th style="padding:0 0 4px 4px;font-weight:500">trend</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    <div style="font-size:10px;color:var(--n-muted);margin-top:5px">${note}
      Dot colour on the trend column is that week's logging tier.</div>`;
}

function nPathFrom(seg, X, Y) {
  if (seg.length < 2) return '';
  return seg.map((p, i) => `${i ? 'L' : 'M'}${X(p.date).toFixed(1)},${Y(p.trend).toFixed(1)}`).join(' ') + ' ';
}

// ─────────────────────── Card 3 — Nutrition adherence ────────────────────────
function nAdherenceHtml(D) {
  const title = `<div class="n-panel-title">📋 Adherence — last 4 weeks</div>`;
  const weeks = Object.keys(D.byWeek).sort().slice(-4);
  if (!weeks.length)
    return `<div class="n-panel">${title}<div style="font-size:13px;color:var(--n-text)">
      No logged meals yet. Logging is what makes every other number here trustworthy.</div></div>`;

  const strip = nGreenDaysStrip(D);

  let rows = '';
  for (const w of weeks) {
    const days = D.byWeek[w];
    const t = D.tByWeek[w];
    const isThis = w === D.thisWeek;
    const unlogged = isThis ? (NS.checkin?.unlogged_eating || null) : null;
    const lg = nmWeeklyLogging(days, unlogged);
    const cal = nmCalorieAdherence(days, t && t.kcal_target);
    const pro = nmProteinHitRate(days, t && t.protein_g_low);
    const counts = days.reduce((a, d) => ({
      meals_planned: a.meals_planned + d.meals_planned,
      as_planned: a.as_planned + d.as_planned, swapped: a.swapped + d.swapped,
    }), { meals_planned: 0, as_planned: 0, swapped: 0 });
    const comp = nmCompliance(counts);

    const calTxt = cal.status === 'unknown' ? 'no interpretable days'
      : `${cal.avg.toLocaleString()} kcal/day vs ${cal.target.toLocaleString()} — <b>${cal.status}</b>`;
    const tierColor = { full: '#2e9e3e', mostly: '#7aa32e', partial: '#e8940a', none: '#b9b9b3' }[lg.tier];
    rows += `<div style="margin-bottom:11px">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--n-text)">
        <span>wk ${w}${isThis ? ' (current)' : ''}</span>
        <span>${comp == null ? '—' : comp + '% on plan'}</span></div>
      <div class="n-budget-bar" style="margin:4px 0"><div class="n-budget-fill ok" style="width:${Math.min(100, comp || 0)}%"></div></div>
      <div style="font-size:12px;color:var(--n-muted)">${calTxt}</div>
      <div style="font-size:12px;color:var(--n-muted)">protein floor ${pro.total ? `${pro.hit}/${pro.total} days` : '—'}
        · logging <span style="color:${tierColor}">${lg.tier}</span> (${lg.goodDays}/${lg.totalDays} days)</div>
      ${lg.note ? `<div style="font-size:11px;color:#7a5200">${nEsc(lg.note)}</div>` : ''}</div>`;
  }

  const macros = NT.showMacros ? nMacroSplitHtml(D) : '';
  return `<div class="n-panel">${title}${strip}${rows}
    <button class="n-act small" onclick="nToggleMacros()">${NT.showMacros ? 'Hide' : 'Show'} macro split</button>
    ${macros}
    <div style="font-size:11px;color:var(--n-muted);margin-top:6px">Swaps count as on-plan — an equivalent
    substitution isn't a miss. Unlogged days are left out of the averages, never counted as zero.</div></div>`;
}

// Last-14-day dot strip + streak (kept from the previous Trends tab).
function nGreenDaysStrip(D) {
  const today = nToday();
  const cells = [];
  for (let i = 13; i >= 0; i--) {
    const dt = nAddDays(today, -i);
    const tier = nmDayTier(D.days[dt]);
    cells.push({ dt, tier });
  }
  let streak = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (c.tier === 'none' && c.dt === today) continue;   // today isn't a miss yet
    if (c.tier === 'none') break;
    streak++;
  }
  const color = { full: '#2e9e3e', mostly: '#7aa32e', partial: '#e8940a', none: '#dcdcd7' };
  const dots = cells.map(c =>
    `<div title="${c.dt}: ${c.tier}" style="flex:1;height:16px;border-radius:4px;background:${color[c.tier]}"></div>`).join('');
  const full = cells.filter(c => c.tier === 'full').length;
  return `<div style="display:flex;gap:3px;margin-bottom:8px">${dots}</div>
    <div style="font-size:12px;color:var(--n-muted);margin-bottom:10px">${full} fully-logged day${full !== 1 ? 's' : ''}
      in 14 · logging streak <b style="color:var(--n-text)">${streak} day${streak !== 1 ? 's' : ''}</b></div>`;
}

// Macro split — demoted to a drill-down (interesting, not actionable).
function nMacroSplitHtml(D) {
  const wkTotals = {};
  for (const [dt, d] of Object.entries(D.days)) {
    if (!d.actual_kcal) continue;
    const t = (wkTotals[nWednesday(dt)] ||= { p: 0, c: 0, f: 0 });
    t.p += d.actual_protein_g || 0; t.c += d.carbs; t.f += d.fat;
  }
  const wks = Object.keys(wkTotals).sort();
  if (!wks.length) return '';
  let rows = '';
  for (const w of wks) {
    const t = wkTotals[w];
    const kc = 4 * t.p + 4 * t.c + 9 * t.f;
    if (kc <= 0) continue;
    const pp = Math.round(400 * t.p / kc), pc = Math.round(400 * t.c / kc), pf = 100 - pp - pc;
    rows += `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--n-text)">
        <span>wk ${w}</span><span>${pp}P / ${pc}C / ${pf}F %</span></div>
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:3px">
        <div style="width:${pp}%;background:#2e9e3e"></div>
        <div style="width:${pc}%;background:#2a6fb0"></div>
        <div style="width:${pf}%;background:#e8940a"></div></div></div>`;
  }
  return `<div style="margin-top:10px">${rows}</div>`;
}

// ─────────────────────────── Card 4 — Measurements ───────────────────────────
function nMeasurementsHtml(rows) {
  const title = `<div class="n-panel-title">📏 Measurements</div>`;
  if (!rows.length)
    return `<div class="n-panel">${title}<div style="font-size:13px;color:var(--n-text)">
      None logged yet — the app prompts every ${NS.settings?.measurement_interval_weeks || 4} weeks.
      Waist beats the scale on ties: weight flat + waist down means it's working.</div></div>`;

  const byMetric = {};
  for (const r of rows) {
    if (r.flag === 'excluded') continue;
    (byMetric[r.metric] ||= []).push(r);        // ascending by date
  }
  // bodyfat_pct is retired (N09 §2). Calipers are per-site; mm-sum is derived below.
  const label = { waist: 'Waist', hips: 'Hips', caliper_chest_mm: 'Chest',
    caliper_abdomen_mm: 'Abdomen', caliper_thigh_mm: 'Thigh' };
  const CAL = ['caliper_chest_mm', 'caliper_abdomen_mm', 'caliper_thigh_mm'];

  const card = (name, list, unit) => {
    const latest = list[list.length - 1];
    const prev = list.length > 1 ? list[list.length - 2] : null;
    const delta = prev ? (parseFloat(latest.value) - parseFloat(prev.value)) : null;
    // N09 §3.9: direction needs 3 points over 8+ weeks; a single delta never headlines.
    let dir = '';
    if (list.length >= 3) {
      const span = nmDayDiff(latest.log_date, list[list.length - 3].log_date);
      if (span >= 56) {
        const change = parseFloat(latest.value) - parseFloat(list[list.length - 3].value);
        dir = Math.abs(change) < 0.2 ? ' · holding'
          : ` · ${change < 0 ? 'down' : 'up'} ${Math.abs(change).toFixed(1)} over ${Math.round(span / 7)} wks`;
      }
    }
    let spark = '';
    if (list.length >= 3) {
      const vals = list.map(r => parseFloat(r.value));
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const Y = v => hi === lo ? 8 : 2 + 12 * (1 - (v - lo) / (hi - lo));
      const X = i => 2 + 76 * (i / (vals.length - 1));
      spark = `<svg viewBox="0 0 80 16" style="width:80px;height:16px;flex:0 0 auto">
        <path d="${vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"
          fill="none" stroke="#1f5e93" stroke-width="1.5"/></svg>`;
    }
    const flagged = latest.flag === 'suspect'
      ? ` <span title="flagged at entry — treated as low confidence" style="color:#e8940a">⚑</span>` : '';
    return `<div class="n-wk-meal" style="align-items:center;gap:8px">
      <span class="n-wk-name">${nEsc(name)}</span>${spark}
      <span class="n-wk-kcal">${latest.value} ${unit || latest.unit} · ${latest.log_date}${flagged}
        ${delta != null ? ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})` : ''}${dir}</span></div>`;
  };

  let main = '';
  for (const metric of ['waist', 'hips']) {
    if (byMetric[metric]) main += card(label[metric], byMetric[metric]);
  }

  // Calipers behind an "advanced" expander; mm-sum derived from the per-site rows.
  let cal = '';
  const haveCal = CAL.filter(m => byMetric[m]);
  if (haveCal.length) {
    const dates = {};
    for (const m of haveCal) for (const r of byMetric[m]) (dates[r.log_date] ||= {})[m] = parseFloat(r.value);
    const sums = Object.entries(dates)
      .filter(([, v]) => CAL.every(m => v[m] != null))
      .map(([d, v]) => ({ log_date: d, value: CAL.reduce((a, m) => a + v[m], 0), unit: 'mm' }))
      .sort((a, b) => a.log_date.localeCompare(b.log_date));
    let inner = sums.length ? card('mm-sum (derived)', sums, 'mm') : '';
    for (const m of haveCal) inner += card(label[m], byMetric[m], 'mm');
    cal = `<details style="margin-top:6px"><summary style="font-size:12px;color:var(--n-muted);cursor:pointer">
      Calipers (advanced)</summary>${inner}
      <div style="font-size:11px;color:var(--n-muted);margin-top:4px">Direction over several readings is the
      signal — skinfolds carry ±3–4% method error, so no body-fat percentage is shown.</div></details>`;
  }

  return `<div class="n-panel">${title}${main || '<div style="font-size:13px;color:var(--n-muted)">No tape measurements yet.</div>'}${cal}</div>`;
}

// ─────────── Activity rollup (table column) + training-context card ──────────
function nActivityAgg(rows, D) {
  const lb = D.trend.current || (D.trend.points.length ? D.trend.points[D.trend.points.length - 1].raw : 165);
  const wk = {};
  for (const r of rows) {
    const w = nWednesday(r.log_date);
    const o = (wk[w] ||= { stepDays: 0, steps: 0, wMin: 0, types: {} });
    if (r.metric === 'steps') { o.stepDays++; o.steps += parseFloat(r.value); }
    else { o.wMin += parseFloat(r.value); if (r.notes) o.types[r.notes] = (o.types[r.notes] || 0) + 1; }
  }
  const weeks = Object.keys(wk).sort().map(w => {
    const o = wk[w];
    return { week: w, avgSteps: o.stepDays ? Math.round(o.steps / o.stepDays) : null,
      stepDays: o.stepDays, wMin: Math.round(o.wMin),
      types: Object.keys(o.types).join('/'),
      estKcal: Math.round(o.steps * lb * 0.00023 + o.wMin * 0.035 * lb) };
  });
  return { weeks, last: weeks.length ? weeks[weeks.length - 1] : null };
}

// nActivityCardsHtml is retired. Its three panels were doing unrelated jobs:
// the weekly activity rollup is now a column in the combined card's data table
// (context, never a plotted series — N09 §3.7), the maintenance panel became a
// sub-line on that same card now that the app computes its own §3.7 estimate,
// and the training-week panel kept its own card because strength context is not
// part of the calories-in-vs-out story. nActivityAgg still feeds the table.

function nTrainingWeekHtml(sessions, conditioning) {
  const wk = {};
  for (const s of sessions) {
    const t = (wk[nWednesday(s.session_date)] ||= { lifts: 0, condMin: 0 });
    if (s.status !== 'skipped') t.lifts++;
  }
  for (const c of conditioning) {
    const t = (wk[nWednesday(c.conditioning_date)] ||= { lifts: 0, condMin: 0 });
    t.condMin += parseFloat(c.duration_minutes || 0);
  }
  const wks = Object.keys(wk).sort();
  if (!wks.length)
    return `<div class="n-panel"><div class="n-panel-title">🏋 Training context</div>
      <div style="font-size:13px;color:var(--n-muted)">No sessions logged recently.</div></div>`;
  const rows = wks.map(w => `<div class="n-wk-meal"><span class="n-wk-name">wk ${w}</span>
    <span class="n-wk-kcal">${wk[w].lifts} session${wk[w].lifts !== 1 ? 's' : ''} · ${Math.round(wk[w].condMin)} min conditioning</span></div>`).join('');
  return `<div class="n-panel"><div class="n-panel-title">🏋 Training context (from the strength app)</div>${rows}
    <div style="font-size:11px;color:var(--n-muted);margin-top:4px">Strength holding up in a deficit is the
    signal that the rate is sustainable — the coach watches this alongside your trend.</div></div>`;
}

// ──────────────────── Card 6 — History: reports, phases, changes ─────────────
function nHistoryHtml(D, reports) {
  const title = `<div class="n-panel-title">📚 History & coach reports</div>`;
  let out = '';

  if (!reports.length) {
    out += `<div style="font-size:13px;color:var(--n-text)">Your first weekly report arrives after your
      first full week of logging. Each one records what the coach saw and why nothing changed — or did.</div>`;
  } else {
    for (const r of reports) {
      const open = NT.openReport === r.id;
      const dq = r.data_quality && r.data_quality !== 'high'
        ? `<span style="color:#e8940a"> · ${nEsc(String(r.data_quality).split(/[ —-]/)[0])} confidence</span>` : '';
      out += `<div style="border-bottom:1px solid var(--n-line,#e6e6e1);padding:7px 0">
        <div onclick="nToggleReport('${r.id}')" style="cursor:pointer;display:flex;justify-content:space-between;gap:8px">
          <span style="font-size:13px;color:var(--n-text)">wk ${r.week_of}${dq}</span>
          <span style="font-size:11px;color:var(--n-muted)">${open ? '▾' : '▸'}</span></div>
        <div style="font-size:12px;color:var(--n-muted);margin-top:2px">${nEsc(r.progress_summary || '')}</div>
        ${open ? nReportBodyHtml(r) : ''}</div>`;
    }
  }

  // Phase timeline — compact, most recent first.
  if (D.phases.length) {
    const items = D.phases.slice().reverse().map(p => {
      const range = `${p.start_date || '?'} → ${p.end_date || (p.status === 'active' ? 'now' : '?')}`;
      return `<div class="n-wk-meal"><span class="n-wk-name">${nEsc(nPhaseLabel(p.phase_type))}${p.status === 'active' ? ' (active)' : ''}</span>
        <span class="n-wk-kcal">${range}${p.kcal_target ? ` · ${p.kcal_target.toLocaleString()} kcal` : ''}</span></div>`;
    }).join('');
    out += `<details style="margin-top:8px"><summary style="font-size:12px;color:var(--n-muted);cursor:pointer">Phase timeline</summary>${items}</details>`;
  }

  // Program changes from target deltas.
  if (D.ticks.length) {
    const items = D.ticks.slice().reverse().map(t =>
      `<div class="n-wk-meal"><span class="n-wk-name">wk ${t.week_of}</span>
        <span class="n-wk-kcal">calorie target ${t.delta > 0 ? '+' : ''}${t.delta} kcal</span></div>`).join('');
    out += `<details style="margin-top:6px"><summary style="font-size:12px;color:var(--n-muted);cursor:pointer">Program changes</summary>${items}</details>`;
  }

  return `<div class="n-panel">${title}${out}
    <div style="font-size:10px;color:var(--n-muted);margin-top:8px">metrics v${typeof NM_CALC_VERSION !== 'undefined' ? NM_CALC_VERSION : 1}</div></div>`;
}

// internal_rationale is stored but deliberately NOT rendered (spec §7).
function nReportBodyHtml(r) {
  const e = r.evidence || {};
  const ev = [
    e.trend_rate_lb_wk != null ? `trend ${e.trend_rate_lb_wk > 0 ? '+' : ''}${e.trend_rate_lb_wk} lb/wk` : null,
    e.goal_rate ? `goal ${e.goal_rate}` : null,
    e.kcal_avg != null ? `${Number(e.kcal_avg).toLocaleString()} kcal avg` : null,
    e.kcal_target != null ? `target ${Number(e.kcal_target).toLocaleString()}` : null,
    e.protein_days ? `protein ${e.protein_days}` : null,
    e.compliance_pct != null ? `${e.compliance_pct}% on plan` : null,
    e.logging_tier ? `logging ${e.logging_tier}` : null,
    e.weigh_ins != null ? `${e.weigh_ins} weigh-ins` : null,
  ].filter(Boolean).join(' · ');
  return `<div style="margin-top:6px;font-size:12px;color:var(--n-text)">
    ${r.interpretation ? `<div style="margin-bottom:5px">${nEsc(r.interpretation)}</div>` : ''}
    ${r.focus ? `<div style="margin-bottom:5px"><b>Focus:</b> ${nEsc(r.focus)}</div>` : ''}
    ${r.proposed_change ? `<div style="margin-bottom:5px"><b>Change:</b> ${nEsc(r.proposed_change)}</div>` : ''}
    ${ev ? `<div style="font-size:11px;color:var(--n-muted)">${nEsc(ev)}</div>` : ''}
    ${r.data_quality && r.data_quality !== 'high'
      ? `<div style="font-size:11px;color:#7a5200;margin-top:3px">Data quality: ${nEsc(r.data_quality)}</div>` : ''}
  </div>`;
}

// ─────────────── Full-screen chart viewer (tap a chart to enlarge) ───────────────
// The Weight and Energy panels are 340 viewBox units wide — fine as a glance on a
// phone, too small to read closely. Tapping either one opens THAT panel alone in
// a full-screen layer, turned 90° into landscape when the phone is held upright
// (no rotation if the browser is already landscape), with pinch-zoom, drag-to-pan,
// double-tap zoom, and tap-a-point to read the value its <title> carries (hover
// doesn't exist on a phone, so this is the only way to reach those numbers
// in-chart).
//
// Zoom is done by resizing the SVG's box, not with a CSS scale(), so the vector
// re-lays out and text/lines stay sharp at every zoom level. The page viewport
// is user-scalable=no, so these gestures don't fight native browser zoom.
// No DOM is touched at load time — test_trends_render.js runs this file in a
// bare vm sandbox.
const NZ = { open: false, rotate: false, s: 1, tx: 0, ty: 0, ptrs: new Map(), g: null,
  lastTap: 0, tipTimer: null, el: null };
const NZ_MAX = 6;

function nZoomHint() {
  return `<div style="text-align:right;font-size:10px;color:var(--n-muted);margin-top:1px">⤢ Tap chart to expand</div>`;
}

function nChartZoomOpen(src) {
  if (NZ.open || !src) return;
  const svg = src.querySelector('svg');
  if (!svg) return;
  let root = document.getElementById('n-zoom');
  if (!root) {
    root = document.createElement('div');
    root.id = 'n-zoom';
    root.className = 'n-zoom';
    root.innerHTML = `<div class="n-zoom-frame">
        <div class="n-zoom-bar">
          <div class="n-zoom-head"></div>
          <div class="n-zoom-btns">
            <button class="n-zoom-btn" onclick="nChartZoomReset()">Reset</button>
            <button class="n-zoom-btn n-zoom-x" onclick="nChartZoomClose()" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="n-zoom-stage"><div class="n-zoom-content"></div></div>
        <div class="n-zoom-foot">Pinch to zoom · drag to move · double-tap to zoom in/out · tap a point for its value</div>
        <div class="n-zoom-tip"></div>
      </div>`;
    document.body.appendChild(root);
    const stage = root.querySelector('.n-zoom-stage');
    stage.addEventListener('pointerdown', nZoomDown);
    stage.addEventListener('pointermove', nZoomMove);
    stage.addEventListener('pointerup', nZoomUp);
    stage.addEventListener('pointercancel', nZoomUp);
    stage.addEventListener('wheel', nZoomWheel, { passive: false });
    window.addEventListener('resize', () => { if (NZ.open) nZoomLayout(); });
  }
  NZ.el = {
    root, frame: root.querySelector('.n-zoom-frame'), stage: root.querySelector('.n-zoom-stage'),
    content: root.querySelector('.n-zoom-content'), tip: root.querySelector('.n-zoom-tip'),
  };
  const head = src.firstElementChild && src.firstElementChild.tagName !== 'svg'
    ? src.firstElementChild.cloneNode(true) : null;
  const hb = root.querySelector('.n-zoom-head');
  hb.innerHTML = '';
  if (head) hb.appendChild(head);
  const clone = svg.cloneNode(true);
  clone.removeAttribute('style');
  clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  clone.style.cssText = 'width:100%;height:100%;display:block';
  NZ.el.content.innerHTML = '';
  NZ.el.content.appendChild(clone);
  NZ.el.tip.style.display = 'none';
  NZ.open = true;
  root.style.display = 'block';
  document.body.style.overflow = 'hidden';
  nZoomLayout();
  if (typeof nBackPush === 'function') nBackPush('zoom', nChartZoomHide);
}

function nChartZoomHide() {
  if (!NZ.open) return;
  NZ.open = false;
  NZ.ptrs.clear(); NZ.g = null;
  if (NZ.el) { NZ.el.root.style.display = 'none'; NZ.el.content.innerHTML = ''; }
  document.body.style.overflow = '';
}
function nChartZoomClose() {
  const wasOpen = NZ.open;
  nChartZoomHide();
  if (wasOpen && typeof nBackConsume === 'function') nBackConsume('zoom');
}
function nChartZoomReset() { NZ.s = 1; NZ.tx = 0; NZ.ty = 0; nZoomApply(); }

// Size the frame to the viewport. Portrait → frame is viewport-with-sides-swapped,
// centred, rotated 90° clockwise (the chart's top edge faces the phone's right
// edge, so turning the phone a quarter-turn counter-clockwise reads it upright).
function nZoomLayout() {
  const W = window.innerWidth, H = window.innerHeight, f = NZ.el.frame;
  NZ.rotate = H > W;
  if (NZ.rotate) {
    f.style.width = H + 'px'; f.style.height = W + 'px';
    f.style.left = ((W - H) / 2) + 'px'; f.style.top = ((H - W) / 2) + 'px';
    f.style.transform = 'rotate(90deg)';
  } else {
    f.style.width = W + 'px'; f.style.height = H + 'px';
    f.style.left = '0px'; f.style.top = '0px';
    f.style.transform = 'none';
  }
  nChartZoomReset();
}

// Screen (client) point → stage-local point, undoing the frame rotation.
function nZoomLocal(cx, cy) {
  const W = window.innerWidth, H = window.innerHeight, st = NZ.el.stage;
  let lx, ly;
  if (NZ.rotate) {
    const vx = cx - W / 2, vy = cy - H / 2;
    lx = vy + H / 2; ly = -vx + W / 2;            // inverse of rotate(90deg) about the centre
  } else { lx = cx; ly = cy; }
  return { x: lx - st.offsetLeft, y: ly - st.offsetTop };
}

function nZoomClamp() {
  const sw = NZ.el.stage.clientWidth, sh = NZ.el.stage.clientHeight;
  NZ.s = Math.max(1, Math.min(NZ_MAX, NZ.s));
  NZ.tx = Math.min(0, Math.max(sw - sw * NZ.s, NZ.tx));
  NZ.ty = Math.min(0, Math.max(sh - sh * NZ.s, NZ.ty));
}
function nZoomApply() {
  if (!NZ.el) return;
  nZoomClamp();
  const c = NZ.el.content, sw = NZ.el.stage.clientWidth, sh = NZ.el.stage.clientHeight;
  c.style.width = (sw * NZ.s) + 'px';
  c.style.height = (sh * NZ.s) + 'px';
  c.style.transform = `translate(${NZ.tx}px,${NZ.ty}px)`;
}
// Zoom to scale s keeping stage-local point p fixed on screen.
function nZoomAt(p, s) {
  const cx = (p.x - NZ.tx) / NZ.s, cy = (p.y - NZ.ty) / NZ.s;
  NZ.s = Math.max(1, Math.min(NZ_MAX, s));
  NZ.tx = p.x - cx * NZ.s; NZ.ty = p.y - cy * NZ.s;
  nZoomApply();
}

function nZoomGestureStart() {
  const ps = [...NZ.ptrs.values()];
  if (!ps.length) { NZ.g = null; return; }
  const a = ps[0], b = ps[1];
  const mid = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: a.x, y: a.y };
  NZ.g = { n: ps.length, mid: nZoomLocal(mid.x, mid.y), d: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
    s: NZ.s, tx: NZ.tx, ty: NZ.ty, moved: NZ.g ? NZ.g.moved : false,
    t0: NZ.g ? NZ.g.t0 : Date.now(), x0: NZ.g ? NZ.g.x0 : a.x, y0: NZ.g ? NZ.g.y0 : a.y };
}
function nZoomDown(e) {
  e.preventDefault();
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  if (!NZ.ptrs.size) NZ.g = null;
  NZ.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  nZoomGestureStart();
}
function nZoomMove(e) {
  if (!NZ.ptrs.has(e.pointerId) || !NZ.g) return;
  e.preventDefault();
  NZ.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = NZ.g, ps = [...NZ.ptrs.values()];
  if (Math.hypot(ps[0].x - g.x0, ps[0].y - g.y0) > 8 || ps.length > 1) g.moved = true;
  if (ps.length >= 2 && g.d > 0) {
    const a = ps[0], b = ps[1];
    const m = nZoomLocal((a.x + b.x) / 2, (a.y + b.y) / 2);
    const s = Math.max(1, Math.min(NZ_MAX, g.s * Math.hypot(a.x - b.x, a.y - b.y) / g.d));
    const cx = (g.mid.x - g.tx) / g.s, cy = (g.mid.y - g.ty) / g.s;
    NZ.s = s; NZ.tx = m.x - cx * s; NZ.ty = m.y - cy * s;
  } else {
    const p = nZoomLocal(ps[0].x, ps[0].y);
    NZ.tx = g.tx + (p.x - g.mid.x); NZ.ty = g.ty + (p.y - g.mid.y);
  }
  nZoomApply();
}
function nZoomUp(e) {
  if (!NZ.ptrs.has(e.pointerId)) return;
  const g = NZ.g;
  NZ.ptrs.delete(e.pointerId);
  if (NZ.ptrs.size) { nZoomGestureStart(); return; }
  NZ.g = null;
  if (!g || g.moved || Date.now() - g.t0 > 400 || e.type === 'pointercancel') return;
  // A tap. Two within 300 ms = double-tap zoom; otherwise show the nearest point's value.
  const now = Date.now();
  if (now - NZ.lastTap < 300) {
    NZ.lastTap = 0;
    nZoomAt(nZoomLocal(e.clientX, e.clientY), NZ.s > 1.05 ? 1 : 2.5);
    NZ.el.tip.style.display = 'none';
  } else {
    NZ.lastTap = now;
    nZoomTip(e.clientX, e.clientY);
  }
}
function nZoomWheel(e) {           // desktop convenience (trackpad pinch arrives as ctrl+wheel)
  e.preventDefault();
  nZoomAt(nZoomLocal(e.clientX, e.clientY), NZ.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
}

// Nearest element carrying a <title> within ~22 px of the tap, in screen space
// (getBoundingClientRect already accounts for the rotation and zoom).
function nZoomTip(cx, cy) {
  const tip = NZ.el.tip;
  let best = null, bd = 22;
  NZ.el.content.querySelectorAll('title').forEach(t => {
    const el = t.parentNode;
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - cx, 0, cx - r.right), dy = Math.max(r.top - cy, 0, cy - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < bd) { bd = d; best = t.textContent; }
  });
  clearTimeout(NZ.tipTimer);
  if (!best) { tip.style.display = 'none'; return; }
  tip.textContent = best;
  tip.style.display = 'block';
  NZ.tipTimer = setTimeout(() => { tip.style.display = 'none'; }, 4000);
}
