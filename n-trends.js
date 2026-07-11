// ══════════════ Kardia Nutrition — Trends screen ══════════════
// Sections: weight (+goal pace), energy balance / est. TDEE (quality-gated),
// green days + streak, macro split, weekly compliance (+protein hit-rate),
// training week (dual-athletes only), measurements with sparklines.

async function renderNTrends() {
  const body = document.getElementById('ntrends-body');
  document.getElementById('ntrends-sub').textContent = `${NS.me.name} · last 12 weeks`;
  body.innerHTML = '<div class="spinner">Loading…</div>';
  const meId = NS.me.id;
  const since = nAddDays(nMonday(nToday()), -7 * 11);
  const since8 = nAddDays(nMonday(nToday()), -7 * 7);

  let wq, sq, tq, mq, pq, lq, phq, aq, csq, ccq;
  try {
    [wq, sq, tq, mq, pq, lq, phq, aq] = await Promise.all([
      ndb.from('body_metrics').select('log_date,value').eq('athlete_id', meId)
        .eq('metric', 'weight').gte('log_date', since).order('log_date'),
      ndb.from('nutrition_week_summary_view').select('*').eq('athlete_id', meId)
        .gte('week_of', since).order('week_of'),
      ndb.from('nutrition_targets').select('week_of,kcal_target,protein_g_low,protein_g_high')
        .eq('athlete_id', meId).gte('week_of', since),
      ndb.from('body_metrics').select('log_date,metric,value,unit').eq('athlete_id', meId)
        .not('metric', 'in', '(weight,steps,workout_min)').order('log_date').limit(80),
      ndb.from('planned_meals').select('id,meal_date,planned_kcal,planned_protein_g')
        .eq('athlete_id', meId).gte('meal_date', since8).order('meal_date'),
      ndb.from('meal_logs').select('planned_meal_id,log_date,status,actual_kcal,actual_protein_g,actual_carbs_g,actual_fat_g')
        .eq('athlete_id', meId).gte('log_date', since8),
      ndb.from('nutrition_phases').select('*').eq('athlete_id', meId).eq('status', 'active').maybeSingle(),
      ndb.from('body_metrics').select('log_date,metric,value,notes').eq('athlete_id', meId)
        .in('metric', ['steps', 'workout_min']).gte('log_date', since8).order('log_date'),
    ]);
    if (NS.me.training_active) {
      [csq, ccq] = await Promise.all([
        ndb.from('completed_sessions').select('session_date,session_type,status')
          .eq('athlete_id', meId).gte('session_date', since8),
        ndb.from('completed_conditioning').select('conditioning_date,duration_minutes')
          .eq('athlete_id', meId).gte('conditioning_date', since8),
      ]);
    }
  } catch (e) {
    body.innerHTML = `<div class="n-panel">Trends failed to load: ${nEsc(e.message || e)}</div>`;
    return;
  }
  for (const q of [wq, sq, tq, mq, pq, lq, phq, aq]) {
    if (q && q.error) { body.innerHTML = `<div class="n-panel">Trends query failed: ${nEsc(q.error.message)}</div>`; return; }
  }

  const D = nTrendsDerive(wq.data || [], sq.data || [], pq.data || [], lq.data || [], phq ? phq.data : null);

  const ACT = nActivityAgg(aq.data || [], D);

  let html = '';
  html += nWeightChartHtml(wq.data || [], D);
  html += nEnergyBalanceHtml(D, ACT);
  html += nActivityWeekHtml(ACT);
  html += nGreenDaysHtml(D);
  html += nMacroSplitHtml(D);
  html += nWeekSummaryHtml(sq.data || [], tq.data || [], D);
  if (NS.me.training_active && csq && !csq.error)
    html += nTrainingWeekHtml(csq.data || [], (ccq && ccq.data) || []);
  html += nMeasurementsHtml(mq.data || []);
  body.innerHTML = html || '<div class="n-panel">No data yet.</div>';
}

// ── Shared derivations ──
function nTrendsDerive(weights, summary, planned, logs, phase) {
  // weekly weight averages + reading counts
  const wByWk = {};
  for (const r of weights) (wByWk[nMonday(r.log_date)] ||= []).push(parseFloat(r.value));
  const wAvg = {}, wCount = {};
  for (const [w, vals] of Object.entries(wByWk)) {
    wAvg[w] = vals.reduce((a, b) => a + b, 0) / vals.length;
    wCount[w] = vals.length;
  }

  // per-day planned/actual (8 wks)
  const logByPm = {};
  const days = {};   // date -> {planned, actual, protein, meals, logged, offPlan, approx}
  for (const l of logs) if (l.planned_meal_id) logByPm[l.planned_meal_id] = l;
  for (const m of planned) {
    const d = (days[m.meal_date] ||= { planned: 0, actual: 0, protein: 0, carbs: 0, fat: 0,
      meals: 0, logged: 0, offPlan: 0, approx: false });
    d.meals++;
    const l = logByPm[m.id];
    if (!l) continue;
    d.logged++;
    d.planned += m.planned_kcal;
    if (l.status === 'skipped' || l.status === 'ate_out') d.offPlan++;
    if (l.actual_kcal == null && l.status !== 'skipped') { d.approx = true; continue; }
    d.actual += l.actual_kcal || 0;
    d.protein += l.actual_protein_g || 0;
    d.carbs += l.actual_carbs_g || 0;
    d.fat += l.actual_fat_g || 0;
  }
  for (const l of logs) {
    if (l.planned_meal_id) continue;   // added items
    const d = (days[l.log_date] ||= { planned: 0, actual: 0, protein: 0, carbs: 0, fat: 0,
      meals: 0, logged: 0, offPlan: 0, approx: false });
    if (l.actual_kcal == null) { d.approx = true; continue; }
    d.actual += l.actual_kcal || 0;
    d.protein += l.actual_protein_g || 0;
    d.carbs += l.actual_carbs_g || 0;
    d.fat += l.actual_fat_g || 0;
  }

  // day quality color
  function dayClass(dt) {
    const d = days[dt];
    if (!d || !d.meals) return 'gray';
    if (d.logged < d.meals) return d.logged ? 'amber' : 'gray';
    const diff = Math.abs(d.actual - d.planned);
    if (d.approx || diff > Math.max(250, 0.20 * d.planned)) return 'amber';
    if (diff <= Math.max(150, 0.10 * d.planned)) return 'green';
    return 'amber';
  }

  // weekly quality + intake (from summary view)
  const sByWk = {};
  for (const r of summary) sByWk[r.week_of] = r;
  const quality = w => {
    const s = sByWk[w];
    return s && s.meals_planned > 0 && (s.meals_logged / s.meals_planned) >= 0.6 &&
           (wCount[w] || 0) >= 2 && s.avg_daily_kcal != null;
  };

  // TDEE estimates from adjacent qualifying weeks
  const wks = Object.keys(sByWk).sort();
  const tdees = [];
  for (let i = 0; i < wks.length - 1; i++) {
    const w = wks[i], n = wks[i + 1];
    if (!quality(w) || wAvg[w] == null || wAvg[n] == null) continue;
    tdees.push({ week: w,
      tdee: sByWk[w].avg_daily_kcal - ((wAvg[n] - wAvg[w]) * 3500) / 7 });
  }
  const recent = tdees.slice(-3);
  const tdeeNow = recent.length
    ? Math.round(recent.reduce((a, b) => a + b.tdee, 0) / recent.length) : null;

  // phase math
  let phaseInfo = null;
  if (phase) {
    const rateM = /([\d.]+)\s*lb/.exec(phase.rate_goal || '');
    phaseInfo = { ...phase, rate: rateM ? parseFloat(rateM[1]) : null };
    const phaseWks = wks.filter(w => phase.start_date && w >= nMonday(phase.start_date) && quality(w));
    if (tdeeNow && phaseWks.length) {
      let cum = 0;
      for (const w of phaseWks) cum += (sByWk[w].avg_daily_kcal - tdeeNow) * 7;
      phaseInfo.cumKcal = Math.round(cum);
      phaseInfo.predictedLb = cum / 3500;
      const firstW = phaseWks[0], lastW = phaseWks[phaseWks.length - 1];
      if (wAvg[firstW] != null && wAvg[lastW] != null && firstW !== lastW)
        phaseInfo.actualLb = wAvg[lastW] - wAvg[firstW];
    }
  }

  return { wAvg, wCount, days, dayClass, sByWk, quality, tdeeNow, nEst: tdees.length, phaseInfo };
}

// ── Weight chart (+ goal pace when a rate goal exists) ──
function nWeightChartHtml(rows, D) {
  if (rows.length < 2)
    return `<div class="n-panel"><div class="n-panel-title">⚖️ Weight</div>Not enough readings yet — weigh-ins build this chart.</div>`;
  const pts = rows.map(r => ({ d: r.log_date, v: parseFloat(r.value) }));
  const byWeek = {};
  for (const p of pts) (byWeek[nMonday(p.d)] ||= []).push(p.v);
  const weeks = Object.keys(byWeek).sort();
  const avgs = weeks.map(w => ({ w, v: byWeek[w].reduce((a, b) => a + b, 0) / byWeek[w].length }));

  const W = 320, H = 150;
  const PAD = 26;
  const d0 = new Date(pts[0].d), d1 = new Date(pts[pts.length - 1].d);
  const span = Math.max(1, d1 - d0);
  const vals = pts.map(p => p.v);
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  const X = d => PAD + (W - PAD - 6) * ((new Date(d) - d0) / span);
  const Y = v => 8 + (H - 30) * (1 - (v - lo) / (hi - lo));

  let pace = '';
  const ph = D.phaseInfo;
  if (ph && ph.rate && ph.phase_type === 'fat_loss' && ph.start_date && avgs.length) {
    const startW = nMonday(ph.start_date);
    const startAvg = D.wAvg[startW] ?? avgs[0].v;
    const x1 = X(nAddDays(startW, 3)), y1 = Y(startAvg);
    const endDate = pts[pts.length - 1].d;
    const wksElapsed = (new Date(endDate) - new Date(startW)) / (7 * 86400000);
    const x2 = X(endDate), y2 = Y(startAvg - ph.rate * wksElapsed);
    pace = `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
      stroke="#4caf50" stroke-width="1.5" stroke-dasharray="5,4"/>`;
  }

  const dots = pts.map(p => `<circle cx="${X(p.d).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.5" fill="#666"/>`).join('');
  const line = avgs.map((a, i) => `${i ? 'L' : 'M'}${X(nAddDays(a.w, 3)).toFixed(1)},${Y(a.v).toFixed(1)}`).join(' ');
  const avgDots = avgs.map(a => `<circle cx="${X(nAddDays(a.w, 3)).toFixed(1)}" cy="${Y(a.v).toFixed(1)}" r="3.5" fill="#ff2712"/>`).join('');
  const latest = avgs[avgs.length - 1], prev = avgs.length > 1 ? avgs[avgs.length - 2] : null;
  const delta = prev ? (latest.v - prev.v) : null;

  return `<div class="n-panel"><div class="n-panel-title">⚖️ Weight — weekly average is the signal${pace ? ' · dashed = goal pace' : ''}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%">
      <text x="2" y="${Y(hi - 1) + 4}" font-size="9" fill="#777">${(hi - 1).toFixed(0)}</text>
      <text x="2" y="${Y(lo + 1) + 4}" font-size="9" fill="#777">${(lo + 1).toFixed(0)}</text>
      ${pace}${dots}
      <path d="${line}" fill="none" stroke="#ff2712" stroke-width="2.5"/>
      ${avgDots}
    </svg>
    <div style="font-size:13px;color:#ccc">This week's avg: <b>${latest.v.toFixed(1)} lb</b> (${byWeek[latest.w].length} readings)
    ${delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} lb vs last week` : ''}</div></div>`;
}

// ── Energy balance / estimated TDEE ──
// Weekly activity aggregation (steps + manual workouts)
function nActivityAgg(rows, D) {
  const lb = (() => {
    const ws = Object.keys(D.wAvg).sort();
    return ws.length ? D.wAvg[ws[ws.length - 1]] : 165;
  })();
  const wk = {};
  for (const r of rows) {
    const w = nMonday(r.log_date);
    const o = (wk[w] ||= { stepDays: 0, steps: 0, wMin: 0, types: {} });
    if (r.metric === 'steps') { o.stepDays++; o.steps += parseFloat(r.value); }
    else { o.wMin += parseFloat(r.value); if (r.notes) o.types[r.notes] = (o.types[r.notes] || 0) + 1; }
  }
  const weeks = Object.keys(wk).sort().map(w => {
    const o = wk[w];
    const estKcal = Math.round(o.steps * lb * 0.00023 +
      o.wMin * 0.035 * lb);
    return { week: w, avgSteps: o.stepDays ? Math.round(o.steps / o.stepDays) : null,
      stepDays: o.stepDays, wMin: Math.round(o.wMin),
      types: Object.keys(o.types).join('/'), estKcal };
  });
  return { weeks, last: weeks.length ? weeks[weeks.length - 1] : null };
}

function nActivityWeekHtml(ACT) {
  if (!ACT.weeks.length)
    return `<div class="n-panel"><div class="n-panel-title">⚡ Activity</div>
      Log steps and workouts on the Today tab — they build this trend and give the coach context.</div>`;
  let rows = '';
  for (const a of ACT.weeks) {
    const bits = [];
    if (a.avgSteps != null) bits.push(`${a.avgSteps.toLocaleString()} steps/day (${a.stepDays}d)`);
    if (a.wMin) bits.push(`${a.wMin} min ${a.types || 'workouts'}`);
    bits.push(`~${a.estKcal.toLocaleString()} kcal est.`);
    rows += `<div class="n-wk-meal"><span class="n-wk-name">wk ${a.week}</span>
      <span class="n-wk-kcal">${bits.join(' · ')}</span></div>`;
  }
  return `<div class="n-panel"><div class="n-panel-title">⚡ Activity (manual logs)</div>${rows}
    <div style="font-size:11px;color:var(--muted,#888);margin-top:4px">Context only — activity is already
    baked into the scale-based TDEE above, so it isn't added again (that would double-count).</div></div>`;
}

function nEnergyBalanceHtml(D, ACT) {
  const title = `<div class="n-panel-title">🔥 Energy balance (estimated)</div>`;
  if (!D.tdeeNow) {
    return `<div class="n-panel">${title}Needs ~2–3 weeks of consistent logging (≥60% of meals) plus
      2+ weigh-ins per week. Keep logging — this becomes the most useful number in the app:
      your real-world maintenance calories, computed from your own food and scale data.</div>`;
  }
  const ph = D.phaseInfo;
  let phaseRows = '';
  if (ph) {
    const est = ph.maintenance_estimate_kcal
      ? `<div style="font-size:12px;color:var(--muted,#888)">Coach's working estimate: ${ph.maintenance_estimate_kcal.toLocaleString()} kcal —
         ${Math.abs(D.tdeeNow - ph.maintenance_estimate_kcal) <= 100 ? 'matching well' : 'the coach reconciles these at phase review'}</div>` : '';
    let cum = '';
    if (ph.cumKcal != null) {
      const pred = ph.predictedLb;
      const act = ph.actualLb;
      cum = `<div style="font-size:13px;color:#ccc;margin-top:6px">This phase: est. balance
        <b>${ph.cumKcal >= 0 ? '+' : ''}${ph.cumKcal.toLocaleString()} kcal</b>
        ≈ ${pred >= 0 ? '+' : ''}${pred.toFixed(1)} lb predicted${act != null ? ` · scale says ${act >= 0 ? '+' : ''}${act.toFixed(1)} lb` : ''}</div>
        <div style="font-size:11px;color:var(--muted,#888)">These two rarely match exactly — water, sodium, and logging estimates all wiggle. Direction agreement is what matters.</div>`;
    }
    phaseRows = est + cum;
  }
  let actLine = '';
  if (ACT && ACT.last && (ACT.last.avgSteps != null || ACT.last.wMin)) {
    const bits = [];
    if (ACT.last.avgSteps != null) bits.push(`~${ACT.last.avgSteps.toLocaleString()} steps/day`);
    if (ACT.last.wMin) bits.push(`${ACT.last.wMin} min workouts`);
    actLine = `<div style="font-size:12px;color:var(--muted,#888);margin-top:4px">Activity context last wk: ${bits.join(' + ')}
      (≈${ACT.last.estKcal.toLocaleString()} kcal) — already reflected in this TDEE. A quieter activity week usually means a lower true TDEE that week.</div>`;
  }
  return `<div class="n-panel">${title}
    <div style="font-size:15px;color:#fff">Est. TDEE: <b>~${D.tdeeNow.toLocaleString()} kcal/day</b>
      <span style="font-size:11px;color:var(--muted,#888)">(from ${D.nEst} week-pair${D.nEst > 1 ? 's' : ''} of your logs + scale)</span></div>
    ${phaseRows}${actLine}</div>`;
}

// ── Green days + streak (last 14 days) ──
function nGreenDaysHtml(D) {
  const today = nToday();
  const cells = [];
  let streak = 0, counting = true;
  for (let i = 13; i >= 0; i--) {
    const dt = nAddDays(today, -i);
    const cls = D.dayClass(dt);
    cells.push({ dt, cls });
  }
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (c.cls === 'gray' && c.dt === today) continue;   // today unlogged doesn't break streak yet
    if (c.cls === 'green' || c.cls === 'amber') { if (counting) streak++; }
    else counting = false;
    if (!counting) break;
  }
  const color = { green: '#4caf50', amber: '#ffaa00', gray: '#333' };
  const dots = cells.map(c => `<div title="${c.dt}" style="flex:1;height:16px;border-radius:4px;background:${color[c.cls]}"></div>`).join('');
  const greens = cells.filter(c => c.cls === 'green').length;
  return `<div class="n-panel"><div class="n-panel-title">🟩 Last 14 days — green = logged &amp; on plan</div>
    <div style="display:flex;gap:3px">${dots}</div>
    <div style="font-size:12px;color:var(--muted,#888);margin-top:6px">${greens} green day${greens !== 1 ? 's' : ''} ·
      logging streak: <b style="color:#ccc">${streak} day${streak !== 1 ? 's' : ''}</b></div></div>`;
}

// ── Macro split by week ──
function nMacroSplitHtml(D) {
  const wkTotals = {};
  for (const [dt, d] of Object.entries(D.days)) {
    if (!d.actual) continue;
    const w = nMonday(dt);
    const t = (wkTotals[w] ||= { p: 0, c: 0, f: 0 });
    t.p += d.protein; t.c += d.carbs; t.f += d.fat;
  }
  const wks = Object.keys(wkTotals).sort();
  if (!wks.length)
    return `<div class="n-panel"><div class="n-panel-title">🥩 Macro split</div>No intake data yet.</div>`;
  let rows = '';
  for (const w of wks) {
    const t = wkTotals[w];
    const kc = 4 * t.p + 4 * t.c + 9 * t.f;
    if (kc <= 0) continue;
    const pp = Math.round(400 * t.p / kc), pc = Math.round(400 * t.c / kc), pf = 100 - pp - pc;
    rows += `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#ddd">
        <span>wk ${w}</span><span>${pp}P / ${pc}C / ${pf}F %</span></div>
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:3px">
        <div style="width:${pp}%;background:#4caf50"></div>
        <div style="width:${pc}%;background:#4a90d9"></div>
        <div style="width:${pf}%;background:#ffaa00"></div></div></div>`;
  }
  return `<div class="n-panel"><div class="n-panel-title">🥩 Macro split — % of calories
    (<span style="color:#4caf50">protein</span> / <span style="color:#4a90d9">carbs</span> / <span style="color:#ffaa00">fat</span>)</div>${rows}</div>`;
}

// ── Weekly compliance + intake + protein hit-rate ──
function nWeekSummaryHtml(rows, targets, D) {
  if (!rows.length)
    return `<div class="n-panel"><div class="n-panel-title">📋 Weekly compliance</div>No logged weeks yet.</div>`;
  const tmap = {};
  for (const t of targets) tmap[t.week_of] = t;
  let items = '';
  for (const r of rows) {
    const t = tmap[r.week_of];
    const comp = r.compliance_pct != null ? `${r.compliance_pct}%` : '—';
    const kcal = r.avg_daily_kcal != null ? Math.round(r.avg_daily_kcal) : null;
    const kTxt = kcal != null
      ? `${kcal.toLocaleString()} kcal/day${t ? ` vs ${t.kcal_target.toLocaleString()}` : ''}` : 'no intake data';
    let pHit = '';
    if (t && D) {
      let hit = 0, tot = 0;
      for (let i = 0; i < 7; i++) {
        const d = D.days[nAddDays(r.week_of, i)];
        if (!d || !d.logged) continue;
        tot++;
        if (d.protein >= t.protein_g_low) hit++;
      }
      if (tot) pHit = ` · protein floor hit ${hit}/${tot} days`;
    }
    const pct = Math.min(100, r.compliance_pct || 0);
    items += `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:#ddd">
        <span>wk ${r.week_of}</span><span>${comp} on plan</span></div>
      <div class="n-budget-bar" style="margin:4px 0"><div class="n-budget-fill ok" style="width:${pct}%"></div></div>
      <div style="font-size:12px;color:var(--muted,#888)">${kTxt}${pHit}
        · ${r.swapped || 0} swaps · ${r.skipped || 0} skips · ${r.ate_out || 0} out</div></div>`;
  }
  return `<div class="n-panel"><div class="n-panel-title">📋 Weekly compliance & intake</div>${items}</div>`;
}

// ── Training week (dual-system athletes only) ──
function nTrainingWeekHtml(sessions, conditioning) {
  const wk = {};
  for (const s of sessions) {
    const w = nMonday(s.session_date);
    const t = (wk[w] ||= { lifts: 0, condMin: 0 });
    if (s.status !== 'skipped') t.lifts++;
  }
  for (const c of conditioning) {
    const w = nMonday(c.conditioning_date);
    const t = (wk[w] ||= { lifts: 0, condMin: 0 });
    t.condMin += parseFloat(c.duration_minutes || 0);
  }
  const wks = Object.keys(wk).sort();
  if (!wks.length)
    return `<div class="n-panel"><div class="n-panel-title">🏋 Training context</div>No sessions logged recently.</div>`;
  let rows = '';
  for (const w of wks) {
    rows += `<div class="n-wk-meal"><span class="n-wk-name">wk ${w}</span>
      <span class="n-wk-kcal">${wk[w].lifts} session${wk[w].lifts !== 1 ? 's' : ''} · ${Math.round(wk[w].condMin)} min conditioning</span></div>`;
  }
  return `<div class="n-panel"><div class="n-panel-title">🏋 Training context (from the strength app)</div>${rows}
    <div style="font-size:11px;color:var(--muted,#888);margin-top:4px">Higher training weeks justify the higher end of your calorie target — the coach factors this in weekly.</div></div>`;
}

// ── Measurements: latest + delta + sparkline when 3+ points ──
function nMeasurementsHtml(rows) {
  if (!rows.length)
    return `<div class="n-panel"><div class="n-panel-title">📏 Measurements</div>None logged yet — the app prompts every few weeks.</div>`;
  const byMetric = {};
  for (const r of rows) (byMetric[r.metric] ||= []).push(r);   // ascending by date
  const label = { waist: 'Waist', hips: 'Hips', caliper_mm_sum: 'Calipers (mm sum)', bodyfat_pct: 'Body fat %' };
  let html = '';
  for (const [metric, list] of Object.entries(byMetric)) {
    const latest = list[list.length - 1], prev = list.length > 1 ? list[list.length - 2] : null;
    const delta = prev ? (parseFloat(latest.value) - parseFloat(prev.value)) : null;
    let spark = '';
    if (list.length >= 3) {
      const vals = list.map(r => parseFloat(r.value));
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const Y = v => hi === lo ? 8 : 2 + 12 * (1 - (v - lo) / (hi - lo));
      const X = i => 2 + 76 * (i / (vals.length - 1));
      const path = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
      spark = `<svg viewBox="0 0 80 16" style="width:80px;height:16px;flex:0 0 auto">
        <path d="${path}" fill="none" stroke="#7db8e8" stroke-width="1.5"/></svg>`;
    }
    html += `<div class="n-wk-meal" style="align-items:center;gap:8px">
      <span class="n-wk-name">${label[metric] || metric}</span>${spark}
      <span class="n-wk-kcal">${latest.value} ${latest.unit} · ${latest.log_date}
      ${delta != null ? ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})` : ''}</span></div>`;
  }
  return `<div class="n-panel"><div class="n-panel-title">📏 Measurements</div>${html}</div>`;
}
