// ══════════════ Kardia Nutrition — Trends screen ══════════════
// Weight (raw dots + bold weekly-average line — the average is the signal),
// weekly compliance and intake vs target, slow-cadence measurements.

async function renderNTrends() {
  const body = document.getElementById('ntrends-body');
  document.getElementById('ntrends-sub').textContent = `${NS.me.name} · last 12 weeks`;
  body.innerHTML = '<div class="spinner">Loading…</div>';
  const meId = NS.me.id;
  const since = nAddDays(nMonday(nToday()), -7 * 11);

  let wq, sq, tq, mq;
  try {
  [wq, sq, tq, mq] = await Promise.all([
    ndb.from('body_metrics').select('log_date,value').eq('athlete_id', meId)
      .eq('metric', 'weight').gte('log_date', since).order('log_date'),
    ndb.from('nutrition_week_summary_view').select('*').eq('athlete_id', meId)
      .gte('week_of', since).order('week_of'),
    ndb.from('nutrition_targets').select('week_of,kcal_target,protein_g_low,protein_g_high')
      .eq('athlete_id', meId).gte('week_of', since),
    ndb.from('body_metrics').select('log_date,metric,value,unit').eq('athlete_id', meId)
      .neq('metric', 'weight').order('log_date', { ascending: false }).limit(24),
  ]);

  } catch (e) {
    body.innerHTML = `<div class="n-panel">Trends failed to load: ${nEsc(e.message || e)}</div>`;
    return;
  }
  for (const [label, q] of [['weight', wq], ['weekly summary', sq], ['targets', tq], ['measurements', mq]]) {
    if (q.error) { body.innerHTML = `<div class="n-panel">Trends query failed (${label}): ${nEsc(q.error.message)}</div>`; return; }
  }

  let html = '';
  html += nWeightChartHtml(wq.data || []);
  html += nWeekSummaryHtml(sq.data || [], tq.data || []);
  html += nMeasurementsHtml(mq.data || []);
  body.innerHTML = html || '<div class="n-panel">No data yet.</div>';
}

// ── Weight chart (SVG: faint dots per reading, bold weekly-average line) ──
function nWeightChartHtml(rows) {
  if (rows.length < 2)
    return `<div class="n-panel"><div class="n-panel-title">⚖️ Weight</div>Not enough readings yet — weigh-ins build this chart.</div>`;
  const pts = rows.map(r => ({ d: r.log_date, v: parseFloat(r.value) }));
  const byWeek = {};
  for (const p of pts) (byWeek[nMonday(p.d)] ||= []).push(p.v);
  const weeks = Object.keys(byWeek).sort();
  const avgs = weeks.map(w => ({ w, v: byWeek[w].reduce((a, b) => a + b, 0) / byWeek[w].length }));

  const W = 320, H = 150, PAD = 26;
  const d0 = new Date(pts[0].d), d1 = new Date(pts[pts.length - 1].d);
  const span = Math.max(1, d1 - d0);
  const vals = pts.map(p => p.v);
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  const X = d => PAD + (W - PAD - 6) * ((new Date(d) - d0) / span);
  const Y = v => 8 + (H - 30) * (1 - (v - lo) / (hi - lo));

  const dots = pts.map(p => `<circle cx="${X(p.d).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.5" fill="#666"/>`).join('');
  const line = avgs.map((a, i) => `${i ? 'L' : 'M'}${X(nAddDays(a.w, 3)).toFixed(1)},${Y(a.v).toFixed(1)}`).join(' ');
  const avgDots = avgs.map(a => `<circle cx="${X(nAddDays(a.w, 3)).toFixed(1)}" cy="${Y(a.v).toFixed(1)}" r="3.5" fill="#ff2712"/>`).join('');
  const latest = avgs[avgs.length - 1], prev = avgs.length > 1 ? avgs[avgs.length - 2] : null;
  const delta = prev ? (latest.v - prev.v) : null;

  return `<div class="n-panel"><div class="n-panel-title">⚖️ Weight — weekly average is the signal</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%">
      <text x="2" y="${Y(hi - 1) + 4}" font-size="9" fill="#777">${(hi - 1).toFixed(0)}</text>
      <text x="2" y="${Y(lo + 1) + 4}" font-size="9" fill="#777">${(lo + 1).toFixed(0)}</text>
      ${dots}
      <path d="${line}" fill="none" stroke="#ff2712" stroke-width="2.5"/>
      ${avgDots}
    </svg>
    <div style="font-size:13px;color:#ccc">This week's avg: <b>${latest.v.toFixed(1)} lb</b> (${byWeek[latest.w].length} readings)
    ${delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} lb vs last week` : ''}</div></div>`;
}

// ── Weekly compliance + intake vs target ──
function nWeekSummaryHtml(rows, targets) {
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
    const pTxt = r.avg_daily_protein_g != null
      ? ` · ${Math.round(r.avg_daily_protein_g)}g P${t ? ` (range ${t.protein_g_low}–${t.protein_g_high})` : ''}` : '';
    const pct = Math.min(100, r.compliance_pct || 0);
    items += `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:#ddd">
        <span>wk ${r.week_of}</span><span>${comp} on plan</span></div>
      <div class="n-budget-bar" style="margin:4px 0"><div class="n-budget-fill" style="width:${pct}%"></div></div>
      <div style="font-size:12px;color:var(--muted,#888)">${kTxt}${pTxt}
        · ${r.swapped || 0} swaps · ${r.skipped || 0} skips · ${r.ate_out || 0} out</div></div>`;
  }
  return `<div class="n-panel"><div class="n-panel-title">📋 Weekly compliance & intake</div>${items}</div>`;
}

// ── Measurements ──
function nMeasurementsHtml(rows) {
  if (!rows.length)
    return `<div class="n-panel"><div class="n-panel-title">📏 Measurements</div>None logged yet — the app prompts every few weeks.</div>`;
  const byMetric = {};
  for (const r of rows) (byMetric[r.metric] ||= []).push(r);
  const label = { waist: 'Waist', hips: 'Hips', caliper_mm_sum: 'Calipers (mm sum)', bodyfat_pct: 'Body fat %' };
  let html = '';
  for (const [metric, list] of Object.entries(byMetric)) {
    const latest = list[0], prev = list[1];
    const delta = prev ? (parseFloat(latest.value) - parseFloat(prev.value)) : null;
    html += `<div class="n-wk-meal">
      <span class="n-wk-name">${label[metric] || metric}</span>
      <span class="n-wk-kcal">${latest.value} ${latest.unit} · ${latest.log_date}
      ${delta != null ? ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs prior)` : ''}</span></div>`;
  }
  return `<div class="n-panel"><div class="n-panel-title">📏 Measurements</div>${html}</div>`;
}
