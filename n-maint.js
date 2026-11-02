// ══════════════ Kardia Nutrition — Trends: maintenance, macros, drawers ══════════════
// Spec: 08_Nutrition/Trends_Maintenance_Transparency_Build_Spec_2026-11-01.md
//
//   Card 3 Maintenance & target — N09 §3.7 (calc_version 2: 4 completed plan weeks),
//                                 §3.7.2 automatic week check, §3.14 base + activity
//   Card 5 Macros               — grams/day + % of kcal per plan week
//   Drawers                     — Activity / Adherence / History collapsed, with a
//                                 one-line summary in each header
//
// Math stays in n-metrics.js. This file derives display rows from the engine and
// draws them. Weeks are plan weeks (Wed–Tue) throughout.

const NM_GOAL_ROUND = 25;
const NM_AUTOCHECK_AMBER = 50;          // §3.7.2: highlight when |delta| >= 50 kcal

// Per-viewer UI state (drawers, disclosures). localStorage is a convenience
// only: it can be empty or throw (private mode), so every access is guarded.
const NTM = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('ntm_ui') || '{}') || {}; } catch (e) { saved = {}; }
  return Object.assign({ why: false, table: false, infoUnl: false, infoAct: false,
    drawers: { activity: false, adherence: false, history: false } }, saved);
})();
function nmSaveUi() { try { localStorage.setItem('ntm_ui', JSON.stringify(NTM)); } catch (e) { /* ignore */ } }
function nmToggleUi(k) { NTM[k] = !NTM[k]; nmSaveUi(); renderNTrends(); }
function nmToggleDrawer(k) { NTM.drawers[k] = !NTM.drawers[k]; nmSaveUi(); renderNTrends(); }

function nmFmt(n) { return n == null ? '—' : Math.round(n).toLocaleString('en-US'); }
function nmSigned(n, d) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d == null ? 0 : d); }
function nmRateRange(txt) {
  const nums = String(txt || '').match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  const v = nums.slice(0, 2).map(parseFloat);
  return v.length > 1 ? { lo: Math.min(v[0], v[1]), hi: Math.max(v[0], v[1]) } : { lo: v[0], hi: v[0] };
}

// ─────────────────────────── derivation ───────────────────────────
// o: { checkins: [{week_of, unlogged_eating, water_retention_context}], ACT }
function nMaintDerive(D, o) {
  o = o || {};
  const today = D.today;
  const yest = nmAddDays(today, -1);
  const mEnd = nmLastCompletedPlanWeekEnd(yest);
  const mStart = nmAddDays(mEnd, -27);
  const curWeek = nmWeekOf(today);
  const pts = D.trend.points || [];
  const days = D.energyDays || [];

  const ci = {};
  for (const r of (o.checkins || [])) ci[r.week_of] = r;
  const actByWeek = {};
  for (const a of ((o.ACT && o.ACT.weeks) || [])) actByWeek[a.week] = a;

  const trendAt = d => { let v = null; for (const p of pts) { if (p.date <= d) v = p.trend; else break; } return v; };
  const daysIn = (a, b) => days.filter(d => d.day >= a && d.day <= b);

  // Plan weeks from the first data week (fixed origin: the fetch lookback, never
  // the chart range — N09 §3.7 cap origin) through the current week.
  const firstDay = [days.length ? days[0].day : null, pts.length ? pts[0].date : null]
    .filter(Boolean).sort()[0];
  const weeks = [];
  if (firstDay) for (let w = nmWeekOf(firstDay); w <= curWeek; w = nmAddDays(w, 7)) weeks.push(w);

  // Confidence per completed week, now with that week's own check-in answer.
  const confFor = w => {
    const wd = daysIn(w, nmAddDays(w, 6));
    const unl = ci[w] ? ci[w].unlogged_eating : null;
    const lg = nmWeeklyLogging(wd, unl);
    const wi = pts.filter(p => p.date >= w && p.date <= nmAddDays(w, 6)).length;
    return nmConfidence({ weighInsThisWeek: wi, loggingTier: lg.tier, unloggedEating: unl, flaggedCount: 0 });
  };
  // Cap origin: the movement cap runs from the first window that lies wholly
  // inside the current trend segment. A window that straddles the EWMA seed or
  // a restart is not a fair starting point for a capped sequence.
  const seg = D.trend.segment || [];
  const segStart = seg.length ? seg[0].date : (pts.length ? pts[0].date : null);
  const firstFullEnd = segStart ? nmAddDays(segStart, 27) : null;
  const doneWeeks = weeks.filter(w => nmAddDays(w, 6) <= mEnd && (!firstFullEnd || nmAddDays(w, 6) >= firstFullEnd));
  const weekEnds = doneWeeks.map(w => nmAddDays(w, 6));
  const confByWeek = {}, confReasonByWeek = {};
  for (const w of doneWeeks) { const c = confFor(w); confByWeek[nmAddDays(w, 6)] = c.level; confReasonByWeek[nmAddDays(w, 6)] = c.reason; }
  const series = nmTdeeSeries({ days, trendPoints: pts, weekEnds, confidenceByWeek: confByWeek,
    confidenceReasonByWeek: confReasonByWeek });
  const now = series.find(r => r.weekEnd === mEnd)
    || nmTdee({ days, trendPoints: pts, asOf: mEnd, confidence: confByWeek[mEnd] || 'medium' });

  // Body-stores component of the headline, for the "how it's figured" line.
  const stores = now && now.sufficient ? Math.round(-NM_KCAL_PER_LB * now.deltaTrend / now.spanDays) : null;
  const shown = now && now.sufficient ? (now.shown != null ? now.shown : now.mid) : null;
  const band = now && now.sufficient ? now.band : null;

  // §3.14 base + activity over the SAME window.
  const baseM = (now && now.sufficient && o.ACT && o.ACT.items)
    ? nmBaseMaintenance({ tdee: now, items: o.ACT.items, stepsMode: nStepsMode() }) : null;

  // Weekly rows (newest first): current week, then completed weeks.
  const ph = D.phases || [];
  const phaseStarting = w => ph.filter(p => p.start_date && p.start_date >= w && p.start_date <= nmAddDays(w, 6));
  const rows = weeks.slice().reverse().map(w => {
    const isCur = w === curWeek;
    const wEnd = isCur ? yest : nmAddDays(w, 6);
    const wd = daysIn(w, wEnd);
    const ok = wd.filter(nmTdeeDayEligible);
    const logged = ok.length ? ok.reduce((a, d) => a + d.actual_kcal, 0) / ok.length : null;
    const t0 = trendAt(nmAddDays(w, -1)), t1 = trendAt(wEnd);
    const n = Math.max(1, nmDayDiff(wEnd, nmAddDays(w, -1)));
    const dlb = (t0 != null && t1 != null) ? t1 - t0 : null;
    const st = dlb != null ? Math.round(-dlb * NM_KCAL_PER_LB / n) : null;
    const implied = (logged != null && st != null) ? Math.round(logged + st) : null;
    const unl = ci[w] ? ci[w].unlogged_eating : null;
    const wr = ci[w] ? ci[w].water_retention_context : null;
    const tier = nmWeeklyLogging(wd, unl).tier;
    const tgt = D.tByWeek && D.tByWeek[w] ? D.tByWeek[w].kcal_target : null;
    const flags = [];
    if (isCur) flags.push('In progress · not counted yet');
    for (const p of phaseStarting(w)) {
      const priorCut = ph.some(q => q !== p && q.phase_type === 'fat_loss' && q.start_date && q.start_date < p.start_date);
      flags.push(p.phase_type === 'fat_loss'
        ? (priorCut ? `Fat loss resumes ${nDayName(p.start_date, true)}` : 'First week of cut · water')
        : `${nPhaseLabel(p.phase_type)} from ${nDayName(p.start_date, true)}`);
    }
    if (unl === 'lots') flags.push('"Lots" unlogged');
    if (wr === 'cycle') flags.push('Cycle');
    else if (wr === 'other') flags.push('Water-retention flag');
    if (!isCur && (tier === 'partial' || tier === 'none')) flags.push(`Logging ${tier}`);
    const group = isCur ? 'now' : (w >= mStart && nmAddDays(w, 6) <= mEnd) ? 'win' : 'old';
    return { week_of: w, group, isCur, days: ok.length, logged, t0, t1, dlb, stores: st, implied,
      unl, wr, tier, target: tgt, act: actByWeek[w] ? actByWeek[w].kcalPerDay : null, flags };
  });

  // §3.7.2 automatic week check — report only.
  const checks = [];
  if (now && now.sufficient) {
    for (const r of rows) {
      if (r.group !== 'win') continue;
      const why = [];
      if (r.unl === 'lots') why.push('"a lot" of unlogged eating');
      if (r.tier === 'partial' || r.tier === 'none') why.push(`${r.tier} logging`);
      if (!why.length) continue;
      const eff = nmTdeeWeekEffect({ days, trendPoints: pts, asOf: mEnd,
        confidence: now.confidence, excludeStart: r.week_of, excludeEnd: nmAddDays(r.week_of, 6) });
      checks.push({ week_of: r.week_of, why, eff });
    }
  }

  // Estimate history: last 5 completed weeks (shown = capped, mid = raw).
  const hist = series.slice(-5).map(s => ({ weekEnd: s.weekEnd, shown: s.shown, mid: s.sufficient ? s.mid : null,
    recal: s.recalibrating, reason: s.sufficient ? null : s.reason }));

  // Goal line by phase type (spec §4).
  const ap = D.activePhase;
  const pt = ap && ap.phase_type;
  const rr = ap ? nmRateRange(ap.rate_goal) : null;
  let goal = null;
  if (now && now.sufficient) {
    const E = now.exact;
    const r25 = v => Math.round(v / NM_GOAL_ROUND) * NM_GOAL_ROUND;
    if (pt === 'fat_loss' && rr) goal = { kind: 'cut', lo: r25(E - 500 * rr.hi), hi: r25(E - 500 * rr.lo), rate: rr };
    else if (pt === 'lean_gain' && rr) goal = { kind: 'gain', lo: r25(E + 500 * rr.lo), hi: r25(E + 500 * rr.hi), rate: rr };
    else if (pt === 'maintenance' || pt === 'diet_break') goal = { kind: 'hold', at: shown };
    else if (pt === 'baseline') goal = { kind: 'baseline' };
  }
  const target = D.wkTarget ? D.wkTarget.kcal_target : null;

  return { mEnd, mStart, curWeek, now, shown, band, stores, baseM, rows, checks, hist, goal, target,
    phaseType: pt, rate: D.rate, pace: D.pace, anchor: ap ? ap.maintenance_estimate_kcal : null };
}

// ─────────────────────────── Card 3 — Maintenance & target ───────────────────────────
function nMaintenanceHtml(D) {
  const M = D.maint;
  const title = `<div class="n-panel-title">⚖️ Maintenance &amp; target</div>`;
  if (!M) return '';
  const T = M.now;
  const ok = T && T.sufficient;
  const md = d => nMonthDay(d);

  // ── tiles ──
  const pt = M.phaseType;
  const tile = (cls, label, big, small) => `<div class="nm-tile ${cls}"><div class="nm-tile-l">${label}</div>
    <div class="nm-tile-v">${big}</div><div class="nm-tile-s">${small}</div></div>`;
  const mTile = ok
    ? tile('', 'Maintenance', '~' + nmFmt(M.shown),
        `${nmFmt(M.shown - M.band)}–${nmFmt(M.shown + M.band)}${T.recalibrating ? ' · <span class="nm-warn">recalibrating</span>' : ''}`)
    : tile('', 'Maintenance', '—', M.anchor ? `coach's estimate ~${nmFmt(M.anchor)}` : 'not measured yet');
  const gap = (ok && M.target != null) ? M.target - M.shown : null;
  const tTile = tile('nm-blue', 'Your target', M.target != null ? nmFmt(M.target) : '—',
    gap == null ? '&nbsp;' : Math.abs(gap) < 50 ? 'at maintenance' : `~${nmFmt(Math.abs(gap))} ${gap < 0 ? 'below' : 'above'}`);
  let pTile;
  if (pt === 'baseline') pTile = tile('nm-green', 'Phase', 'Measuring', 'baseline');
  else if (M.rate == null) pTile = tile('nm-green', 'Pace', '—', 'trend not ready');
  else if (pt === 'maintenance' || pt === 'diet_break')
    pTile = tile('nm-green', 'Holding', nmSigned(M.rate, 2), `lb/wk drift${M.pace && M.pace.status === 'on' ? ' · steady' : ''}`);
  else {
    const word = { on: 'on goal', ahead: 'faster than goal', behind: 'slower than goal' }[M.pace && M.pace.status] || '';
    pTile = tile('nm-green', 'Pace', nmSigned(M.rate, 2), `lb/wk${word ? ' · ' + word : ''}`);
  }

  // ── always-visible text ──
  let how;
  if (ok) {
    how = `<b>How it's figured:</b> you logged <b>${nmFmt(T.meanIntake)}</b>/day ${M.stores >= 0 ? '+' : '−'} <b>${nmFmt(Math.abs(M.stores))}</b>/day
      ${M.stores >= 0 ? 'came from body stores' : 'was stored as weight'} (trend ${nmSigned(T.deltaTrend, 2)} lb in ${T.spanDays} days)
      = <b>${nmFmt(T.exact)}</b>, shown as ~${nmFmt(T.mid)}. Based on the 4 full plan weeks ${md(M.mStart)}–${md(M.mEnd)}.`;
    if (T.recalibrating) how += ` <span class="nm-warn">The new figure moved more than 100 kcal, so ~${nmFmt(M.shown)} stays on screen while the coach reviews it.</span>`;
  } else {
    how = `<b>Maintenance not measured yet</b> — ${nEsc((T && T.reason) || 'not enough data')}. It needs 14 fully-logged days and 6 weigh-ins inside 4 complete plan weeks.`;
  }
  let goalTxt = '';
  const G = M.goal;
  if (G && G.kind === 'cut')
    goalTxt = `For ${G.rate.lo}–${G.rate.hi} lb/wk, eat about <b>${nmFmt(G.lo)}–${nmFmt(G.hi)}</b> logged.${
      M.target != null ? (M.target >= G.lo && M.target <= G.hi ? ` Your ${nmFmt(M.target)} target is inside it.` : ` Your target is ${nmFmt(M.target)}.`) : ''}`;
  else if (G && G.kind === 'gain')
    goalTxt = `For +${G.rate.lo}–${G.rate.hi} lb/wk, eat about <b>${nmFmt(G.lo)}–${nmFmt(G.hi)}</b> logged.`;
  else if (G && G.kind === 'hold')
    goalTxt = `${nPhaseLabel(pt)}: eat about <b>${nmFmt(G.at)}</b> to hold${M.target != null ? ` · target ${nmFmt(M.target)}` : ''}.`;
  else if (G && G.kind === 'baseline')
    goalTxt = `Baseline: this period is measuring your maintenance. No goal intake yet.`;

  const PB = D.planBasis;
  const fcLine = PB ? `<div class="nm-line">${nEsc(PB.label)}: planned activity ~${nmFmt(PB.activity)}/day${
      PB.outlook && PB.outlook !== 'normal' ? ` (${nEsc(PB.outlook)})` : ''} → maintenance ~${nmFmt(PB.forecast)}${
      PB.target != null ? ` · target ${nmFmt(PB.target)}` : ''}</div>` : '';

  const stepsLabel = nStepsMode() === 'extra' ? 'steps outside workouts' : 'steps';
  const info = `<div class="nm-links">
      <button class="nm-link" onclick="nmToggleUi('infoUnl')">Why isn't unlogged eating added?</button>
      <button class="nm-link" onclick="nmToggleUi('infoAct')">Why isn't exercise added?</button></div>
    ${NTM.infoUnl ? `<div class="nm-note">Maintenance is measured from what you log, so your usual unlogged
      bites are already inside it. Adding an estimate would count them twice. It only matters when a week is
      unusual, and the app checks those weeks for you under "Why this number?".</div>` : ''}
    ${NTM.infoAct ? `<div class="nm-note">The scale already reflects all your training and ${stepsLabel}.${
      M.baseM && M.baseM.base != null ? ` Of the ~${nmFmt(M.shown)}, about <b>${nmFmt(M.baseM.base)}</b> is your body and
      daily life and <b>~${nmFmt(M.baseM.activityWindow)}</b> is activity (training + ${stepsLabel}).` : ''}
      The split lets your target change the week your training does, instead of a month later.</div>` : ''}`;

  const caret = open => `<span class="nm-caret${open ? ' open' : ''}">▶</span>`;
  let why = `<button class="nm-disclose" onclick="nmToggleUi('why')">${caret(NTM.why)}Why this number? · week by week</button>`;
  if (NTM.why) why += nMaintWhyHtml(D);

  return `<div class="n-panel">${title}
    <div class="nm-tiles">${mTile}${tTile}${pTile}</div>
    ${fcLine}
    <div class="nm-how">${how}</div>
    ${goalTxt ? `<div class="nm-how">${goalTxt}</div>` : ''}
    ${info}${why}</div>`;
}

function nMaintWhyHtml(D) {
  const M = D.maint, T = M.now, ok = T && T.sufficient;
  const maxV = Math.max(2400, ...M.rows.map(r => (r.implied || 0) + 100), ...M.rows.map(r => (r.logged || 0) + 100));
  const SC = Math.ceil(maxV / 600) * 600;          // round axis: 0 / ¼ / ½ / ¾ / max read cleanly
  const pct = v => (Math.max(0, v) / SC * 100).toFixed(2) + '%';

  // §3.7.2 notes
  let notes = '';
  for (const c of M.checks) {
    const e = c.eff;
    const amber = e && e.delta != null && Math.abs(e.delta) >= NM_AUTOCHECK_AMBER;
    const body = e && e.delta != null
      ? `Leaving it out changes the estimate by <b>${nmSigned(e.delta)} kcal</b>${amber ? ' — the coach will review it' : ', so it stays in'}.`
      : `The estimate can't be computed without it, so it stays in.`;
    notes += `<div class="nm-check${amber ? ' amber' : ''}"><b>Checked automatically:</b> the week of
      ${nMonthDay(c.week_of)} had ${nEsc(c.why.join(' and '))}. ${body}</div>`;
  }
  if (ok && !M.checks.length) notes = `<div class="nm-check">Checked automatically: no week in the window had heavy
    unlogged eating or partial logging.</div>`;

  const legend = `<div class="nm-legend"><span><i style="background:#c2410c"></i>Logged</span>
    <span><i style="background:#2f7a3e"></i>From body stores</span>
    <span><i class="nm-stripe"></i>Stored as weight</span>
    ${ok ? `<span><i style="width:2px;background:#1c1c1c"></i>Estimate ${nmFmt(T.exact)}</span>` : ''}</div>`;

  const heads = { now: 'This week · in progress', win: `In the estimate · ${nMonthDay(M.mStart)}–${nMonthDay(M.mEnd)}`,
    old: 'Earlier · aged out' };
  let bars = '', last = null, nOld = 0;
  for (const r of M.rows) {
    if (r.group === 'old' && ++nOld > 3) break;
    if (r.group !== last) { bars += `<div class="nm-group ${r.group}">${heads[r.group]}</div>`; last = r.group; }
    let track = '';
    if (r.logged != null) {
      const st = r.stores || 0;
      const inV = st >= 0 ? r.logged : (r.implied != null ? r.implied : r.logged);
      if (ok && r.group !== 'old') track += `<div class="nm-band" style="left:${pct(M.shown - M.band)};width:${pct(2 * M.band)}"></div>`;
      track += `<div style="width:${pct(inV)};background:#c2410c"></div>`;
      if (st > 0) track += `<div style="width:${pct(st)};background:#2f7a3e"></div>`;
      if (st < 0) track += `<div class="nm-stripe" style="width:${pct(-st)}"></div>`;
      if (ok && r.group !== 'old') track += `<div class="nm-est" style="left:${pct(T.exact)}"></div>`;
    }
    bars += `<div class="nm-row ${r.group}">
      <div class="nm-row-h"><span>wk of ${nMonthDay(r.week_of)}</span><b>${r.implied != null ? nmFmt(r.implied) : '—'}</b></div>
      <div class="nm-track">${track}</div>
      <div class="nm-row-f"><span>${r.logged != null ? `ate ${nmFmt(r.logged)}` : 'no fully-logged days'}${
        r.dlb != null ? ` · trend ${nmSigned(r.dlb, 2)} lb` : ''}</span><span class="nm-flag">${nEsc(r.flags.join(' · '))}</span></div></div>`;
  }
  const axis = `<div class="nm-axis">${[0, 0.25, 0.5, 0.75, 1].map(f => `<span>${nmFmt(SC * f)}</span>`).join('')}</div>`;

  let hist = '';
  if (M.hist.length) {
    hist = `<div class="nm-sub">How the estimate has moved</div><div class="nm-hist">${M.hist.map((h, i) => `
      <div class="${i === M.hist.length - 1 ? 'cur' : ''}"><span>${nMonthDay(h.weekEnd)}</span>
        <b>${h.shown != null ? nmFmt(h.shown) : '—'}</b>${
        h.recal ? `<em>held · raw ${nmFmt(h.mid)}</em>` : (h.shown == null && h.reason ? `<em>${/unlogged/.test(h.reason) ? 'heavy unlogged wk' : 'not enough data'}</em>` : '')}</div>`).join('')}</div>
      <div class="nm-foot">Each Wednesday the estimate updates from the 4 plan weeks just finished. It never moves
      more than 100 kcal in a week on screen; "held" shows the raw figure when the cap applied.</div>`;
  }

  let table = `<button class="nm-disclose" onclick="nmToggleUi('table')"><span class="nm-caret${NTM.table ? ' open' : ''}">▶</span>Weekly numbers</button>`;
  if (NTM.table) table += nMaintTableHtml(D);

  return `<div class="nm-why">${notes}${legend}${bars}${axis}${hist}${table}</div>`;
}

function nMaintTableHtml(D) {
  const M = D.maint, T = M.now, ok = T && T.sufficient;
  const rows = M.rows.slice(0, 8).map(r => `<tr class="${r.group}">
    <td class="l">${nMonthDay(r.week_of)}${r.isCur ? ' <span class="nm-mut">now</span>' : ''}</td>
    <td>${nmFmt(r.target)}</td>
    <td>${nmFmt(r.logged)} <span class="nm-mut">/${r.days}d</span></td>
    <td>${r.unl ? nEsc(r.unl) : '—'}</td>
    <td class="nm-mut">${r.act != null ? '~' + nmFmt(r.act) : '—'}</td>
    <td>${r.t0 != null && r.t1 != null ? `${r.t0.toFixed(1)}→${r.t1.toFixed(1)}` : '—'}</td>
    <td>${r.dlb != null ? nmSigned(r.dlb, 2) : '—'}</td>
    <td>${r.stores != null ? nmSigned(r.stores) : '—'}</td>
    <td class="b">${nmFmt(r.implied)}</td></tr>`).join('');
  const nFlag = M.checks.length;
  const total = ok ? `<tr class="tot"><td class="l">4 wks</td><td>—</td>
    <td>${nmFmt(T.meanIntake)} <span class="nm-mut">/${T.nDays}d</span></td><td>${nFlag ? nFlag + ' flag' + (nFlag > 1 ? 's' : '') : '—'}</td>
    <td class="nm-mut">${M.baseM && M.baseM.activityWindow != null ? '~' + nmFmt(M.baseM.activityWindow) : '—'}</td>
    <td>${T.spanDays} d</td><td>${nmSigned(T.deltaTrend, 2)}</td><td>${nmSigned(M.stores)}</td>
    <td class="b">${nmFmt(T.exact)} → ~${nmFmt(T.mid)}</td></tr>` : '';
  const G = M.goal;
  const goalRow = (G && (G.kind === 'cut' || G.kind === 'gain')) ? `<tr class="goal"><td class="l">Goal</td>
    <td colspan="7">${G.kind === 'cut' ? '' : '+'}${G.rate.lo}–${G.rate.hi} lb/wk → ${nmFmt(500 * G.rate.lo)}–${nmFmt(500 * G.rate.hi)} kcal/day ${G.kind === 'cut' ? 'below' : 'above'} maintenance</td>
    <td class="b">${nmFmt(G.lo)}–${nmFmt(G.hi)}</td></tr>` : '';
  return `<div class="nm-table"><table>
    <thead><tr><th class="l">Wk of</th><th>Plan</th><th>Logged</th><th>Unlogged</th><th>Activity</th>
      <th>Trend</th><th>Δ lb</th><th>Stores</th><th class="b">Maint.</th></tr></thead>
    <tbody>${rows}${total}${goalRow}</tbody></table></div>
    <div class="nm-foot">Plan weeks run Wed–Tue. <b>Logged</b>: fully-logged days only. <b>Trend</b>: smoothed weight
    at the week's start and end. <b>Stores</b> = −Δ lb × 3,500 ÷ days. <b>Maint.</b> = Logged + Stores. The 4-week row
    runs first-to-last weigh-in in the window, so it differs slightly from averaging the weeks. Unlogged and activity
    are context only and are never added in.</div>`;
}

// ─────────────────────────── Card 5 — Macros ───────────────────────────
function nMacrosHtml(D) {
  const title = `<div class="n-panel-title">🥗 Macros <span style="text-transform:none;letter-spacing:0;font-weight:400">· avg per fully-logged day</span></div>`;
  const wk = {};
  for (const [day, d] of Object.entries(D.days || {})) {
    if (!nmTdeeDayEligible({ ...d, day })) continue;
    const w = nmWeekOf(day);
    const t = (wk[w] ||= { n: 0, p: 0, c: 0, f: 0, k: 0 });
    t.n++; t.p += d.actual_protein_g || 0; t.c += d.carbs || 0; t.f += d.fat || 0; t.k += d.actual_kcal || 0;
  }
  const weeks = Object.keys(wk).sort().reverse().slice(0, 4);
  if (!weeks.length) return `<div class="n-panel">${title}<div style="font-size:13px;color:var(--n-muted)">
    No fully-logged days yet. Macros appear once a day is fully logged.</div></div>`;
  const avg = w => { const t = wk[w]; const p = t.p / t.n, c = t.c / t.n, f = t.f / t.n;
    const kc = 4 * p + 4 * c + 9 * f;
    const pp = kc > 0 ? Math.round(400 * p / kc) : 0, pc = kc > 0 ? Math.round(400 * c / kc) : 0;
    return { n: t.n, p, c, f, pp, pc, pf: kc > 0 ? 100 - pp - pc : 0 }; };
  const cur = weeks[0], A = avg(cur);
  const tg = D.tByWeek && D.tByWeek[cur];
  const pLo = tg ? tg.protein_g_low : null, pHi = tg ? tg.protein_g_high : null;
  const pOk = pLo == null || A.p >= pLo;
  const tile = (cls, label, g, sub) => `<div class="nm-tile ${cls}"><div class="nm-tile-l">${label}</div>
    <div class="nm-tile-v">${Math.round(g)} g</div><div class="nm-tile-s">${sub}</div></div>`;
  const tiles = `<div class="nm-tiles">
    ${tile(pOk ? 'nm-green' : 'nm-amber', 'Protein', A.p, pLo != null ? `${A.pp}% · target ${pLo}${pHi ? '–' + pHi : '+'}${pOk ? ' ✓' : ''}` : `${A.pp}% of kcal`)}
    ${tile('nm-blue', 'Carbs', A.c, `${A.pc}% of kcal`)}
    ${tile('nm-amber-soft', 'Fat', A.f, `${A.pf}% of kcal`)}</div>
    <div class="nm-foot">${cur === nmWeekOf(D.today) ? 'This plan week' : 'Plan week of ' + nMonthDay(cur)}, ${A.n} fully-logged day${A.n === 1 ? '' : 's'}.</div>`;
  const rows = weeks.map(w => { const a = avg(w); return `<div class="nm-mrow">
      <div class="nm-row-h"><span>wk of ${nMonthDay(w)}</span><span><b>${Math.round(a.p)} P</b> · ${Math.round(a.c)} C · ${Math.round(a.f)} F g
        <span class="nm-mut">(${a.pp}/${a.pc}/${a.pf}%)</span></span></div>
      <div class="nm-mbar"><div style="width:${a.pp}%;background:#2f7a3e"></div><div style="width:${a.pc}%;background:#2a6fb0"></div><div style="width:${a.pf}%;background:#e8940a"></div></div></div>`; }).join('');
  return `<div class="n-panel">${title}${tiles}<div class="nm-mrows">${rows}</div></div>`;
}

// ─────────────────────────── Drawers ───────────────────────────
function nDrawerHtml(key, title, summary, bodyHtml) {
  const open = !!NTM.drawers[key];
  return `<div class="n-panel nm-drawer">
    <button class="nm-drawer-h" onclick="nmToggleDrawer('${key}')" aria-expanded="${open}">
      <span class="nm-caret${open ? ' open' : ''}">▶</span>
      <span class="nm-drawer-t"><b>${title}</b><span>${summary}</span></span></button>
    ${open ? `<div class="nm-drawer-b">${bodyHtml()}</div>` : ''}</div>`;
}
function nActivitySummary(ACT) {
  const weeks = ((ACT && ACT.weeks) || []).slice().reverse();
  const thisWeek = nmWeekOf(nToday());
  const cur = weeks.find(w => w.week === thisWeek);
  const done = weeks.filter(w => w.week !== thisWeek).slice(0, 4);
  const avg4 = done.length ? Math.round(done.reduce((a, w) => a + w.kcalPerDay, 0) / done.length) : null;
  const bits = [];
  bits.push(cur ? `~${nmFmt(cur.kcalPerDay)} kcal/day this plan week` : 'nothing logged this plan week');
  if (avg4 != null) bits.push(`${done.length}-wk avg ~${nmFmt(avg4)}`);
  if (cur && cur.avgSteps != null) bits.push(`${nmFmt(cur.avgSteps)} steps/day`);
  return bits.join(' · ');
}
function nAdherenceSummary(D) {
  const bits = [];
  if (D.logging && D.logging.totalDays) bits.push(`logging ${D.logging.goodDays}/${D.logging.totalDays}`);
  if (D.calories && D.calories.status !== 'unknown') bits.push(`calories ${D.calories.status}`);
  if (D.protein && D.protein.total) bits.push(`protein ${D.protein.hit}/${D.protein.total}`);
  return bits.length ? 'This plan week: ' + bits.join(' · ') : 'Nothing logged this plan week yet';
}
function nHistorySummary(D, reports) {
  const r = reports && reports[0];
  const ph = D.activePhase;
  const bits = [];
  if (r) bits.push(`Latest report: wk of ${nMonthDay(r.week_of)}`);
  if (ph) bits.push(`${nPhaseLabel(ph.phase_type)}${ph.start_date ? ' since ' + nMonthDay(ph.start_date) : ''}`);
  return bits.join(' · ') || 'No reports yet';
}

// Overview: one tape line when waist or hips moved ≥0.5 in within the last 6 weeks.
function nOverviewTapeLine(rows) {
  const by = {};
  for (const r of (rows || [])) if (r.flag !== 'excluded' && (r.metric === 'waist' || r.metric === 'hips')) (by[r.metric] ||= []).push(r);
  const today = nToday(), bits = [];
  for (const m of ['waist', 'hips']) {
    const L = (by[m] || []).slice().sort((a, b) => a.log_date < b.log_date ? -1 : 1);
    if (L.length < 2) continue;
    const a = L[L.length - 2], b = L[L.length - 1];
    if (nmDayDiff(today, b.log_date) > 42) continue;
    const d = parseFloat(b.value) - parseFloat(a.value);
    const name = m === 'waist' ? 'Waist' : 'Hips';
    if (Math.abs(d) >= 0.5) bits.push(`${name} ${d < 0 ? 'down' : 'up'} <b>${Math.abs(d).toFixed(1)} in</b> since ${nMonthDay(a.log_date)}`);
    else if (bits.length) bits.push(`${name.toLowerCase()} holding`);
  }
  return bits.length ? `<div style="font-size:13px;color:var(--n-text);margin-top:3px">${bits.join(' · ')}</div>` : '';
}
