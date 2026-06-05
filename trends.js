// ── Trends ─────────────────────────────────────────────────────────────────────

function getWeekMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function last12WeekKeys() {
  const keys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    keys.push(getWeekMonday(d.toISOString().slice(0, 10)));
  }
  return [...new Set(keys)].slice(-12);
}

function shortWeekLabel(wkKey) {
  const d = new Date(wkKey + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}

// SVG bar chart — values[], labels[], opts: { height, color, formatVal }
// Classify exercise by movement_pattern into Upper / Lower / Other
function classifyExerciseCategory(movementPattern) {
  if (!movementPattern) return 'Other';
  if (/push|pull|press|row|curl|fly|chest|shoulder|tricep|bicep|delt|lat|chin|dip/i.test(movementPattern)) return 'Upper';
  if (/squat|hinge|lunge|deadlift|leg|hip|glute|hamstring|quad|calf/i.test(movementPattern)) return 'Lower';
  return 'Other';
}

// SVG stacked bar chart — series: [{label, color, values[]}], weekLabels[], opts: { height }
function trendsStackedBarChart(series, weekLabels, opts) {
  opts = opts || {};
  const W = 320, H = opts.height || 130;
  const PAD_L = 32, PAD_R = 8, PAD_T = 10, PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const n = weekLabels.length;
  if (!n) return '';
  const totals = weekLabels.map(function(_, i) {
    return series.reduce(function(sum, s) { return sum + (s.values[i] || 0); }, 0);
  });
  const maxVal = Math.max.apply(null, totals.concat([1]));
  const barW = Math.max(4, Math.floor(chartW / n) - 3);
  const gap  = (chartW - barW * n) / (n + 1);
  const yTicks = [0, 0.5, 1].map(function(t) { return Math.round(maxVal * t); });
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;display:block">';
  yTicks.forEach(function(v) {
    const y = PAD_T + chartH - (v / maxVal) * chartH;
    svg += '<line x1="' + PAD_L + '" y1="' + y + '" x2="' + (W - PAD_R) + '" y2="' + y + '" stroke="#2d2d2d" stroke-width="1"/>';
    const lbl = v >= 1000 ? (v/1000).toFixed(0) + 'k' : v;
    svg += '<text x="' + (PAD_L - 3) + '" y="' + (y + 4) + '" text-anchor="end" fill="#666" font-size="9">' + lbl + '</text>';
  });
  for (var i = 0; i < n; i++) {
    const x = PAD_L + gap + i * (barW + gap);
    let yBase = PAD_T + chartH;
    series.forEach(function(s) {
      const val = s.values[i] || 0;
      if (!val) return;
      const bh = (val / maxVal) * chartH;
      yBase -= bh;
      svg += '<rect x="' + x + '" y="' + yBase + '" width="' + barW + '" height="' + bh + '" fill="' + s.color + '" rx="1"/>';
    });
    if (i % 2 === 0 || n <= 6) {
      svg += '<text x="' + (x + barW/2) + '" y="' + (H - 6) + '" text-anchor="middle" fill="#666" font-size="9">' + weekLabels[i] + '</text>';
    }
  }
  svg += '</svg>';
  return svg;
}

function trendsBarChart(values, labels, opts) {
  opts = opts || {};
  const W = 320, H = opts.height || 130;
  const pL = 4, pR = 4, pT = 18, pB = 24;
  const cW = W - pL - pR, cH = H - pT - pB;
  const n = values.length;
  if (!n) return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto"><text x="' + (W/2) + '" y="' + (H/2) + '" text-anchor="middle" font-size="11" fill="var(--muted)">No data yet</text></svg>';
  const max = Math.max(...values, 1);
  const slot = cW / n;
  const bW = Math.max(4, Math.floor(slot * 0.65));
  const color = opts.color || 'var(--accent)';
  let rects = '', xlbls = '';
  values.forEach(function(v, i) {
    const bH = v > 0 ? Math.max(2, (v / max) * cH) : 0;
    const x = (pL + i * slot + (slot - bW) / 2).toFixed(1);
    const y = (pT + cH - bH).toFixed(1);
    rects += '<rect x="' + x + '" y="' + y + '" width="' + bW + '" height="' + bH.toFixed(1) + '" fill="' + color + '" rx="2" opacity="0.85"/>';
    if (v > 0) {
      const lbl = opts.formatVal ? opts.formatVal(v) : v;
      rects += '<text x="' + (parseFloat(x) + bW/2).toFixed(1) + '" y="' + (parseFloat(y) - 3).toFixed(1) + '" text-anchor="middle" font-size="8" fill="var(--muted)">' + lbl + '</text>';
    }
    if (labels[i]) xlbls += '<text x="' + (pL + i * slot + slot/2).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="8" fill="var(--muted)">' + labels[i] + '</text>';
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto"><line x1="' + pL + '" y1="' + (pT + cH) + '" x2="' + (W - pR) + '" y2="' + (pT + cH) + '" stroke="var(--border)" stroke-width="1"/>' + rects + xlbls + '</svg>';
}

// SVG line chart — points (number|null)[], labels[], opts: { height, decimals }
function trendsLineChart(points, labels, opts) {
  opts = opts || {};
  const W = 320, H = opts.height || 110;
  const pL = 38, pR = 8, pT = 14, pB = 22;
  const cW = W - pL - pR, cH = H - pT - pB;
  const n = points.length;
  const valid = points.filter(function(v) { return v != null; });
  if (!valid.length) return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto"><text x="' + (W/2) + '" y="' + (H/2) + '" text-anchor="middle" font-size="11" fill="var(--muted)">No data yet</text></svg>';
  const minV = Math.min.apply(null, valid);
  const maxV = Math.max.apply(null, valid);
  const range = maxV - minV || 1;
  const dec = opts.decimals != null ? opts.decimals : 1;
  const toX = function(i) { return pL + (i / (n - 1 || 1)) * cW; };
  const toY = function(v) { return pT + cH - ((v - minV) / range) * cH; };
  const step = n > 10 ? 4 : n > 6 ? 2 : 1;
  let segs = '', dots = '', xlbls = '';
  let prevI = null;
  points.forEach(function(v, i) {
    if (v == null) { prevI = null; return; }
    if (prevI !== null && points[prevI] != null) {
      segs += '<line x1="' + toX(prevI).toFixed(1) + '" y1="' + toY(points[prevI]).toFixed(1) + '" x2="' + toX(i).toFixed(1) + '" y2="' + toY(v).toFixed(1) + '" stroke="var(--accent)" stroke-width="2"/>';
    }
    dots += '<circle cx="' + toX(i).toFixed(1) + '" cy="' + toY(v).toFixed(1) + '" r="3" fill="var(--accent)"/>';
    prevI = i;
  });
  labels.forEach(function(lbl, i) {
    if (i % step === 0 || i === n - 1) xlbls += '<text x="' + toX(i).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="8" fill="var(--muted)">' + lbl + '</text>';
  });
  const axes = '<line x1="' + pL + '" y1="' + pT + '" x2="' + pL + '" y2="' + (pT + cH) + '" stroke="var(--border)" stroke-width="1"/><line x1="' + pL + '" y1="' + (pT + cH) + '" x2="' + (pL + cW) + '" y2="' + (pT + cH) + '" stroke="var(--border)" stroke-width="1"/>';
  const yax = '<text x="' + (pL - 4) + '" y="' + (pT + 8) + '" text-anchor="end" font-size="8" fill="var(--muted)">' + maxV.toFixed(dec) + '</text><text x="' + (pL - 4) + '" y="' + (pT + cH) + '" text-anchor="end" font-size="8" fill="var(--muted)">' + minV.toFixed(dec) + '</text>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto">' + axes + yax + segs + dots + xlbls + '</svg>';
}

// Horizontal bar breakdown — items: [{label, value}], optional suffix (default ' sets')
function trendsHorizChart(items, color, suffix) {
  if (!items.length) return '<div style="color:var(--muted);font-size:12px;padding:6px 0">No data yet</div>';
  color  = color  || 'var(--accent)';
  suffix = suffix !== undefined ? suffix : ' sets';
  const maxV = Math.max.apply(null, items.map(function(x) { return x.value; }));
  return items.map(function(item) {
    const pct        = (item.value / maxV * 100).toFixed(1);
    const displayVal = Number.isInteger(item.value) ? item.value : item.value.toFixed(1);
    return '<div class="horiz-bar-row"><div class="horiz-bar-meta"><span style="color:var(--fg)">' + item.label + '</span><span style="color:var(--muted)">' + displayVal + suffix + '</span></div><div class="horiz-bar-track"><div class="horiz-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
  }).join('');
}

async function openTrends() {
  _tOpen = {}; // reset collapse state — always open collapsed
  document.getElementById('trends-body').innerHTML = '<div class="spinner">Loading…</div>';
  showScreen('trends');
  await loadTrends();
}

async function loadTrends() {
  const body = document.getElementById('trends-body');
  if (isOffline) {
    body.innerHTML = '<div style="color:var(--muted);padding:24px;text-align:center">Trends require an internet connection.</div>';
    return;
  }
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 84);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const { data: sessions } = await db.from('completed_sessions')
      .select('*').eq('athlete_id', S.athlete.id)
      .gte('session_date', cutoffStr).order('session_date');

    const sessionIds = (sessions || []).map(function(s) { return s.id; });

    // Fetch planned session count for the current program (for completion rate)
    const plannedCountRes = S.cycle && S.cycle.program_id
      ? await db.from('planned_sessions').select('id', { count: 'exact', head: true }).eq('program_id', S.cycle.program_id)
      : { count: 0 };
    const plannedPerWeek = plannedCountRes.count || 0;
    window._tPlannedPerWeek = plannedPerWeek;

    const [readyRes, painRes, condRes, setsRes] = await Promise.all([
      db.from('readiness_logs').select('*').eq('athlete_id', S.athlete.id).gte('log_date', cutoffStr).order('log_date'),
      db.from('pain_injury_logs').select('*').eq('athlete_id', S.athlete.id).neq('status', 'resolved').order('log_date', { ascending: false }),
      db.from('completed_conditioning').select('*').eq('athlete_id', S.athlete.id).gte('conditioning_date', cutoffStr).order('conditioning_date'),
      sessionIds.length
        ? db.from('completed_strength_sets')
            .select('*, exercise:exercise_id(id,name,movement_pattern,exercise_type), planned_ex:planned_exercise_id(planned_adaptation,exercise_role)')
            .in('completed_session_id', sessionIds).eq('is_skipped', false).gt('set_number', 0).order('created_at')
        : Promise.resolve({ data: [] }),
    ]);

    const allSessions  = sessions        || [];
    const readiness    = readyRes.data   || [];
    const painItems    = painRes.data    || [];
    const conditioning = condRes.data    || [];
    const sets         = setsRes.data    || [];

    // Fetch muscle map for all unique exercises in the sets
    const uniqueExIds = Array.from(new Set(sets.map(function(s) { return s.exercise_id; }).filter(Boolean)));
    // exercise_muscle_map is optional — muscle group chart shows empty if table doesn't exist yet.
    let mmRes = { data: [] };
    if (uniqueExIds.length) {
      try {
        mmRes = await db.from('exercise_muscle_map')
          .select('exercise_id,muscle_group,set_credit')
          .in('exercise_id', uniqueExIds);
      } catch (_) { /* table not yet created — muscle group chart will be empty */ }
    }
    const muscleMap = {};
    (mmRes.data || []).forEach(function(r) {
      if (!muscleMap[r.exercise_id]) muscleMap[r.exercise_id] = [];
      muscleMap[r.exercise_id].push({ muscle_group: r.muscle_group, set_credit: Number(r.set_credit) });
    });
    window._tMuscleMap = muscleMap;

    // Attach session_date to each set
    const sessDateMap = {};
    allSessions.forEach(function(s) { sessDateMap[s.id] = s.session_date; });
    sets.forEach(function(s) { s._sd = sessDateMap[s.completed_session_id] || null; });

    const weekKeys   = last12WeekKeys();
    const weekLabels = weekKeys.map(shortWeekLabel);

    // Store for dynamic exercise trend chart and period selector refresh
    window._tSets         = sets;
    window._tWkKeys       = weekKeys;
    window._tWkLbls       = weekLabels;
    window._tAllSessions  = allSessions;
    window._tReadiness    = readiness;
    window._tConditioning = conditioning;
    window._tPainItems    = painItems;

    renderTrendsBody(body, allSessions, readiness, sets, weekKeys, weekLabels, conditioning, painItems);

    // Auto-render first exercise trend chart
    const sel = document.getElementById('ex-trend-select');
    if (sel && sel.value) renderExTrend(sel.value);

  } catch (err) {
    console.error('loadTrends:', err);
    body.innerHTML = '<div style="color:var(--muted);padding:24px;text-align:center">Error loading trends. Check connection.</div>';
  }
}

// ── Trends collapsible helpers ────────────────────────────────────
var _tOpen = {}; // section open state: id -> bool (default true)

function trendSection(id, title, bodyHtml) {
  if (_tOpen[id] === undefined) _tOpen[id] = false;
  const open = _tOpen[id];
  return '<div class="trends-section" id="tsec-' + id + '">'
    + '<div class="trends-section-hdr" onclick="toggleTrendSection(\'' + id + '\')">'
    + '<span class="trends-section-title">' + title + '</span>'
    + '<span class="trends-section-chevron' + (open ? '' : ' collapsed') + '">›</span>'
    + '</div>'
    + '<div class="trends-section-body' + (open ? '' : ' collapsed') + '" id="tsec-body-' + id + '">'
    + bodyHtml
    + '</div></div>';
}

function toggleTrendSection(id) {
  _tOpen[id] = !_tOpen[id];
  const body    = document.getElementById('tsec-body-' + id);
  const chevron = document.querySelector('#tsec-' + id + ' .trends-section-chevron');
  if (body)    body.classList.toggle('collapsed', !_tOpen[id]);
  if (chevron) chevron.classList.toggle('collapsed', !_tOpen[id]);
}

function trendsExpandAll()   { Object.keys(_tOpen).forEach(function(k) { _tOpen[k] = true;  }); reRenderTrendsBody(); }
function trendsCollapseAll() { Object.keys(_tOpen).forEach(function(k) { _tOpen[k] = false; }); reRenderTrendsBody(); }

function reRenderTrendsBody() {
  const body = document.getElementById('trends-body');
  if (!body) return;
  renderTrendsBody(body, window._tAllSessions, window._tReadiness, window._tSets,
    window._tWkKeys, window._tWkLbls, window._tConditioning, window._tPainItems);
  const sel = document.getElementById('ex-trend-select');
  if (sel && sel.value) renderExTrend(sel.value);
}

function renderTrendsBody(body, allSessions, readiness, sets, weekKeys, weekLabels, conditioning, painItems) {
  const ctrlBar = '<div class="trends-ctrl-bar">'
    + '<button class="trends-ctrl-btn" onclick="trendsExpandAll()">Expand All</button>'
    + '<button class="trends-ctrl-btn" onclick="trendsCollapseAll()">Collapse All</button>'
    + '</div>';
  body.innerHTML = ctrlBar + [
    renderTrendsStrength(sets),
    renderTrendsVolume(sets, weekKeys, weekLabels),
    renderTrendsConsistency(allSessions, weekKeys, weekLabels, window._tPlannedPerWeek || 0),
    renderTrendsReadiness(readiness, weekKeys, weekLabels),
    renderTrendsConditioning(conditioning, weekKeys, weekLabels),
    renderTrendsPain(painItems),
  ].join('');
}

// ── Strength: PR board + per-exercise load trend ──────────────────
function renderTrendsStrength(sets) {
  // Count sessions per exercise for frequency sort
  const freqMap = {};
  const prMap   = {};
  const allExMap = {}; // all exercises for the dropdown

  sets.forEach(function(s) {
    if (!s.exercise) return;
    const key  = s.exercise.id;
    const name = s.exercise.name;
    const mt   = s.measure_type || 'reps';

    // Track all exercises (for dropdown)
    if (!allExMap[key]) allExMap[key] = { id: key, name: name, sessIds: new Set() };
    if (s._sd) allExMap[key].sessIds.add(getWeekMonday(s._sd));

    // e1RM eligibility: must be reps-based, have load, reps 1-12
    if (mt !== 'reps' || !s.actual_load || !s.actual_reps || s.actual_reps > 12) return;
    const e1rm = s.actual_reps === 1 ? s.actual_load : Math.round(s.actual_load * (1 + s.actual_reps / 30));
    if (!freqMap[key]) freqMap[key] = new Set();
    if (s._sd) freqMap[key].add(getWeekMonday(s._sd));
    if (!prMap[key] || e1rm > prMap[key].e1rm) {
      prMap[key] = { id: key, name: name, e1rm: e1rm, load: s.actual_load, reps: s.actual_reps, date: s._sd };
    }
  });

  // Sort by frequency descending, cap at 8 for default view
  const allPrs = Object.values(prMap).sort(function(a, b) {
    return (freqMap[b.id]?.size || 0) - (freqMap[a.id]?.size || 0);
  });
  const shown  = allPrs.slice(0, 8);
  const hidden = allPrs.slice(8);

  function prRowHtml(p) {
    const dateStr = p.date ? new Date(p.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return '<div class="pr-row"><div class="pr-name">' + p.name + '</div><div><span class="pr-val">' + p.e1rm + ' lb</span> <span class="pr-date">' + p.load + '×' + p.reps + ' · ' + dateStr + '</span></div></div>';
  }

  let prHtml;
  if (shown.length === 0) {
    prHtml = '<div style="color:var(--muted);font-size:13px;padding:8px 0">No strength data yet. Log sets with load + reps (1–12) to populate.</div>';
  } else {
    prHtml = shown.map(prRowHtml).join('');
    if (hidden.length > 0) {
      prHtml += '<div id="pr-extra" style="display:none">' + hidden.map(prRowHtml).join('') + '</div>';
      prHtml += '<button onclick="document.getElementById(\'pr-extra\').style.display=\'block\';this.style.display=\'none\'" style="font-size:12px;color:var(--accent);background:none;border:none;cursor:pointer;padding:6px 0">Show ' + hidden.length + ' more ▾</button>';
    }
  }

  // Build dropdown: Main Lifts group + All Exercises group
  const mainLiftIds  = new Set(Object.keys(prMap));
  const mainOptions  = Object.values(prMap)
    .sort(function(a,b) { return (freqMap[b.id]?.size||0) - (freqMap[a.id]?.size||0); })
    .map(function(p) { return '<option value="' + p.name.replace(/"/g,'&quot;') + '">' + p.name + '</option>'; }).join('');
  const otherOptions = Object.values(allExMap)
    .filter(function(e) { return !mainLiftIds.has(e.id); })
    .sort(function(a,b) { return b.sessIds.size - a.sessIds.size; })
    .map(function(e) { return '<option value="' + e.name.replace(/"/g,'&quot;') + '">' + e.name + '</option>'; }).join('');

  const exSelectHtml = (mainOptions || otherOptions)
    ? '<select class="ex-trend-select" id="ex-trend-select" onchange="renderExTrend(this.value)">'
        + (mainOptions  ? '<optgroup label="Main Lifts (e1RM)">' + mainOptions  + '</optgroup>' : '')
        + (otherOptions ? '<optgroup label="All Exercises">'      + otherOptions + '</optgroup>' : '')
      + '</select>'
    : '';

  const exTrendSection = exSelectHtml
    ? '<div class="trends-chart-title" style="margin-top:16px;margin-bottom:8px">e1RM Trend by Exercise</div>' + exSelectHtml + '<div class="trends-chart-box" style="margin-top:0" id="ex-trend-chart"></div>'
    : '';

  return trendSection('strength', 'Strength — Est. 1RM Board', prHtml + exTrendSection);
}

function renderExTrend(exName) {
  const sets     = window._tSets   || [];
  const weekKeys = window._tWkKeys || [];
  const weekLbls = window._tWkLbls || [];
  const e1rmByWk = {};
  sets.forEach(function(s) {
    if (!s.exercise || s.exercise.name !== exName || !s.actual_load || !s.actual_reps || !s._sd) return;
    if (s.actual_reps > 12) return; // outside e1RM reliable range
    const e1rm = s.actual_reps === 1 ? s.actual_load : Math.round(s.actual_load * (1 + s.actual_reps / 30));
    const wk = getWeekMonday(s._sd);
    if (!e1rmByWk[wk] || e1rm > e1rmByWk[wk]) e1rmByWk[wk] = e1rm;
  });
  const values = weekKeys.map(function(wk) { return e1rmByWk[wk] != null ? e1rmByWk[wk] : null; });
  const el = document.getElementById('ex-trend-chart');
  if (el) el.innerHTML = trendsLineChart(values, weekLbls, { decimals: 0 });
}

// ── Volume & Workload ─────────────────────────────────────────────
function renderTrendsVolume(sets, weekKeys, weekLabels) {
  // Upper / Lower / Other tonnage per week
  const catColors = { Upper: '#6e399e', Lower: '#ff2712', Other: '#4a4a4a' };
  const catByWk   = { Upper: {}, Lower: {}, Other: {} };
  weekKeys.forEach(function(k) { catByWk.Upper[k] = 0; catByWk.Lower[k] = 0; catByWk.Other[k] = 0; });
  sets.forEach(function(s) {
    if (!s._sd || !s.actual_load || !s.actual_reps) return;
    if (s.exercise && s.exercise.exercise_type === 'conditioning') return;
    const wk  = getWeekMonday(s._sd);
    if (catByWk.Upper[wk] === undefined) return;
    const cat = classifyExerciseCategory((s.exercise && s.exercise.movement_pattern) || '');
    catByWk[cat][wk] += s.actual_load * s.actual_reps;
  });

  const series = ['Upper', 'Lower', 'Other'].map(function(cat) {
    return {
      label:  cat,
      color:  catColors[cat],
      values: weekKeys.map(function(k) { return Math.round(catByWk[cat][k]); }),
    };
  });

  const stackedChart = trendsStackedBarChart(series, weekLabels);
  const legend = '<div style="display:flex;gap:14px;margin-bottom:10px;font-size:11px;color:var(--muted)">'
    + ['Upper', 'Lower', 'Other'].map(function(cat) {
        return '<div style="display:flex;align-items:center;gap:4px">'
          + '<div style="width:8px;height:8px;border-radius:2px;background:' + catColors[cat] + '"></div>' + cat + '</div>';
      }).join('')
    + '</div>';

  const period = (document.getElementById('vol-period-select') || {}).value || '4w';
  const breakdownHtml = buildVolumeBreakdown(sets, weekKeys, period);

  const periodSelect = '<select class="trends-period-select" id="vol-period-select" onchange="refreshVolumeBreakdown()">'
    + '<option value="1w"' + (period === '1w' ? ' selected' : '') + '>This Week</option>'
    + '<option value="2w"' + (period === '2w' ? ' selected' : '') + '>Last Week</option>'
    + '<option value="4w"' + (period === '4w' ? ' selected' : '') + '>Last 4 Weeks</option>'
    + '</select>';

  const body = '<div class="trends-chart-box"><div class="trends-chart-title">Weekly Tonnage by Category (lb × reps)</div>' + legend + stackedChart + '</div>'
    + periodSelect
    + '<div id="vol-breakdown">' + breakdownHtml + '</div>';

  return trendSection('volume', 'Volume &amp; Workload', body);
}

// ── Muscle group display groups ───────────────────────────────────────────────
// Multi-muscle groups are expandable in the Trends chart.
// Grip/Forearms, Calves, and Tibialis/Lower Leg are excluded from reporting.
const MG_GROUPS = [
  { id: 'chest',      label: 'Chest',       muscles: ['Chest'] },
  { id: 'shoulders',  label: 'Shoulders',   muscles: ['Front Delts', 'Side Delts', 'Rear Delts', 'Rotator Cuff/Shoulder Support'] },
  { id: 'back',       label: 'Back',        muscles: ['Lats', 'Upper Back', 'Traps'] },
  { id: 'triceps',    label: 'Triceps',     muscles: ['Triceps'] },
  { id: 'biceps',     label: 'Biceps',      muscles: ['Biceps'] },
  { id: 'quads',      label: 'Quads',       muscles: ['Quads'] },
  { id: 'hamstrings', label: 'Hamstrings',  muscles: ['Hamstrings'] },
  { id: 'glutes',     label: 'Glutes',      muscles: ['Glutes'] },
  { id: 'hips',       label: 'Hip Complex', muscles: ['Adductors', 'Hip Flexors', 'Lateral Hip'] },
  { id: 'core',       label: 'Core',        muscles: ['Anterior Core', 'Obliques'] },
  { id: 'lowback',    label: 'Low Back',    muscles: ['Low Back'] },
];

var _mgExpanded = {};  // group id → bool; default false (collapsed)

// ── Muscle group chart helpers ────────────────────────────────────────────────
function toggleMgGroup(id) {
  _mgExpanded[id] = !_mgExpanded[id];
  const detail  = document.getElementById('mg-detail-' + id);
  const chevron = document.getElementById('mg-chev-' + id);
  if (detail)  detail.style.display   = _mgExpanded[id] ? 'block' : 'none';
  if (chevron) chevron.style.transform = _mgExpanded[id] ? 'rotate(90deg)' : '';
}

function buildMgBarHtml(primary, indirect, total, maxVal) {
  const barPct = (total / maxVal * 100).toFixed(1);
  let segs = '';
  if (primary  > 0) segs += '<div style="width:' + (primary  / total * 100).toFixed(1) + '%;height:100%;background:#6e399e" title="Primary: '  + primary.toFixed(1)  + ' credited"></div>';
  if (indirect > 0) segs += '<div style="width:' + (indirect / total * 100).toFixed(1) + '%;height:100%;background:#b08fd0" title="Indirect: ' + indirect.toFixed(1) + ' credited"></div>';
  return '<div class="horiz-bar-track">'
    + '<div style="width:' + barPct + '%;height:100%;display:flex;overflow:hidden;border-radius:4px">'
    + segs + '</div></div>';
}

// Renders the expandable muscle group chart.
// mgSplitMap: { muscle_group → { primary: n, indirect: n } }
// maxVal: max group total (for bar width scaling)
function renderMuscleGroupChart(mgSplitMap, maxVal) {
  let html = '';
  MG_GROUPS.forEach(function(g) {
    let gPrimary = 0, gIndirect = 0;
    const detailRows = [];
    g.muscles.forEach(function(m) {
      const v = mgSplitMap[m];
      if (!v) return;
      gPrimary  += v.primary;
      gIndirect += v.indirect;
      detailRows.push({ label: m, primary: v.primary, indirect: v.indirect, total: v.primary + v.indirect });
    });
    const gTotal = gPrimary + gIndirect;
    if (gTotal === 0) return;

    const gPrimaryR  = Math.round(gPrimary  * 10) / 10;
    const gIndirectR = Math.round(gIndirect * 10) / 10;
    const gTotalR    = Math.round(gTotal    * 10) / 10;
    const displayTotal = Number.isInteger(gTotalR) ? gTotalR : gTotalR.toFixed(1);
    const barHtml      = buildMgBarHtml(gPrimaryR, gIndirectR, gTotalR, maxVal);
    const isExpandable = detailRows.length > 1;

    if (isExpandable) {
      const open = !!_mgExpanded[g.id];
      html += '<div id="mg-g-' + g.id + '" onclick="toggleMgGroup(\'' + g.id + '\')" style="cursor:pointer;margin-bottom:8px">'
        + '<div class="horiz-bar-meta">'
        + '<span style="color:var(--fg)">' + g.label
        + ' <span id="mg-chev-' + g.id + '" style="font-size:10px;color:var(--muted);display:inline-block;transition:transform .2s;transform:' + (open ? 'rotate(90deg)' : '') + '">›</span>'
        + '</span>'
        + '<span style="color:var(--muted)">' + displayTotal + ' credited</span>'
        + '</div>' + barHtml + '</div>';

      html += '<div id="mg-detail-' + g.id + '" style="display:' + (open ? 'block' : 'none') + ';margin-bottom:4px">';
      detailRows.sort(function(a, b) { return b.total - a.total; }).forEach(function(d) {
        const dp = Math.round(d.primary  * 10) / 10;
        const di = Math.round(d.indirect * 10) / 10;
        const dt = Math.round(d.total    * 10) / 10;
        const dDisplay = Number.isInteger(dt) ? dt : dt.toFixed(1);
        html += '<div style="padding-left:14px;margin-bottom:6px">'
          + '<div class="horiz-bar-meta">'
          + '<span style="color:var(--muted);font-size:11px">' + d.label + '</span>'
          + '<span style="color:var(--muted);font-size:11px">' + dDisplay + ' credited</span>'
          + '</div>' + buildMgBarHtml(dp, di, dt, maxVal) + '</div>';
      });
      html += '</div>';
    } else {
      html += '<div style="margin-bottom:8px">'
        + '<div class="horiz-bar-meta">'
        + '<span style="color:var(--fg)">' + g.label + '</span>'
        + '<span style="color:var(--muted)">' + displayTotal + ' credited</span>'
        + '</div>' + barHtml + '</div>';
    }
  });
  return html || '<div style="color:var(--muted);font-size:12px;padding:6px 0">No data yet</div>';
}

// ── Adaptation color palette ──────────────────────────────────────────────────
const ADAPT_COLORS = {
  'Power/Speed':        '#60a5fa',  // blue
  'Max Strength':       '#ef4444',  // red
  'Strength':           '#f59e0b',  // amber
  'Hypertrophy':        '#6e399e',  // purple (accent)
  'Muscular Endurance': '#14b8a6',  // teal
  'Rehab/Support':      '#6b7280',  // gray
  'Unclassified':       '#374151',  // dark gray
};
const ADAPT_ORDER = [
  'Power/Speed', 'Max Strength', 'Strength',
  'Hypertrophy', 'Muscular Endurance', 'Rehab/Support', 'Unclassified',
];

// Stacked horizontal bar chart
// rows: [{label, total, segments:[{color,value,title}], suffix?}]
// maxVal: max total across all rows (controls bar width relative to track)
// suffix: appended after the total value in the meta line
function renderStackedHorizChart(rows, maxVal, suffix) {
  suffix = suffix !== undefined ? suffix : ' sets';
  if (!rows.length) return '<div style="color:var(--muted);font-size:12px;padding:6px 0">No data yet</div>';
  return rows.map(function(row) {
    const barPct     = (row.total / maxVal * 100).toFixed(1);
    const displayVal = Number.isInteger(row.total) ? row.total : row.total.toFixed(1);
    const segs = row.segments.filter(function(s) { return s.value > 0; }).map(function(seg) {
      const segPct = (seg.value / row.total * 100).toFixed(1);
      return '<div style="width:' + segPct + '%;height:100%;background:' + seg.color + '" title="' + seg.title + '"></div>';
    }).join('');
    return '<div class="horiz-bar-row">'
      + '<div class="horiz-bar-meta">'
      + '<span style="color:var(--fg)">' + row.label + '</span>'
      + '<span style="color:var(--muted)">' + displayVal + suffix + '</span>'
      + '</div>'
      + '<div class="horiz-bar-track">'
      + '<div style="width:' + barPct + '%;height:100%;display:flex;overflow:hidden;border-radius:4px">'
      + segs
      + '</div>'
      + '</div>'
      + '</div>';
  }).join('');
}

// Legend for adaptation color key
function buildAdaptLegend(adaptationsPresent) {
  const items = ADAPT_ORDER.filter(function(a) { return adaptationsPresent.has(a); });
  if (!items.length) return '';
  return '<div class="adapt-legend">'
    + items.map(function(a) {
      return '<div class="adapt-legend-item">'
        + '<div class="adapt-dot" style="background:' + ADAPT_COLORS[a] + '"></div>'
        + a + '</div>';
    }).join('')
    + '</div>';
}

function buildVolumeBreakdown(sets, weekKeys, period) {
  var cutKeys;
  if (period === '1w') {
    const thisMonday = getWeekMonday(today());
    cutKeys = new Set([thisMonday]);
  } else if (period === '2w') {
    const thisMonday = getWeekMonday(today());
    const d = new Date(thisMonday + 'T00:00:00');
    d.setDate(d.getDate() - 7);
    cutKeys = new Set([d.toISOString().slice(0,10)]);
  } else {
    cutKeys = new Set(weekKeys.slice(-4));
  }
  const label = period === '1w' ? 'This Week' : period === '2w' ? 'Last Week' : 'Last 4 Weeks';

  // ── Chart 1: Movement Pattern × Adaptation (stacked) ─────────────────────
  const mpAdaptMap        = {};   // { movement_pattern → { adaptation → count } }
  const adaptationsPresent = new Set();

  sets.forEach(function(s) {
    if (!s._sd || !cutKeys.has(getWeekMonday(s._sd))) return;
    if (s.exercise && s.exercise.exercise_type === 'conditioning') return;
    const mp = (s.exercise && s.exercise.movement_pattern) || 'Unknown';
    const ac = (s.planned_ex && s.planned_ex.planned_adaptation) || 'Unclassified';
    if (!mpAdaptMap[mp]) mpAdaptMap[mp] = {};
    mpAdaptMap[mp][ac] = (mpAdaptMap[mp][ac] || 0) + 1;
    adaptationsPresent.add(ac);
  });

  const mpRows = Object.entries(mpAdaptMap).map(function(entry) {
    const mp          = entry[0];
    const adaptCounts = entry[1];
    const total       = Object.values(adaptCounts).reduce(function(a, b) { return a + b; }, 0);
    const segments    = ADAPT_ORDER.filter(function(a) { return adaptCounts[a]; }).map(function(a) {
      return { color: ADAPT_COLORS[a], value: adaptCounts[a], title: a + ': ' + adaptCounts[a] + ' sets' };
    });
    return { label: mp, total: total, segments: segments };
  }).sort(function(a, b) { return b.total - a.total; });

  const maxMp = mpRows.length ? Math.max.apply(null, mpRows.map(function(r) { return r.total; })) : 1;

  // ── Chart 2: Muscle Group — primary vs indirect credited sets ─────────────
  const mgSplitMap = {};   // { muscle_group → { primary: n, indirect: n } }

  sets.forEach(function(s) {
    if (!s._sd || !cutKeys.has(getWeekMonday(s._sd))) return;
    const mmEntries = (window._tMuscleMap || {})[s.exercise_id] || [];
    mmEntries.forEach(function(e) {
      if (!mgSplitMap[e.muscle_group]) mgSplitMap[e.muscle_group] = { primary: 0, indirect: 0 };
      if (e.set_credit >= 1.0)      mgSplitMap[e.muscle_group].primary  += e.set_credit;
      else if (e.set_credit > 0)    mgSplitMap[e.muscle_group].indirect += e.set_credit;
    });
  });

  // maxMg based on group totals (so bar widths are relative to the largest group)
  const maxMg = MG_GROUPS.reduce(function(mx, g) {
    const gTotal = g.muscles.reduce(function(s, m) {
      return s + (mgSplitMap[m] ? mgSplitMap[m].primary + mgSplitMap[m].indirect : 0);
    }, 0);
    return Math.max(mx, gTotal);
  }, 0) || 1;

  // ── Render ────────────────────────────────────────────────────────────────
  const hasMp  = mpRows.length > 0;
  const hasMg  = Object.keys(mgSplitMap).length > 0;
  const empty  = '<div style="color:var(--muted);font-size:13px;padding:8px 0">No data for this period.</div>';

  const mgLegend = '<div style="display:flex;gap:12px;margin-bottom:10px;font-size:10px;color:var(--muted)">'
    + '<div style="display:flex;align-items:center;gap:4px"><div style="width:8px;height:8px;border-radius:2px;background:#6e399e"></div>Primary (direct)</div>'
    + '<div style="display:flex;align-items:center;gap:4px"><div style="width:8px;height:8px;border-radius:2px;background:#b08fd0"></div>Indirect</div>'
    + '</div>';

  return (!hasMp && !hasMg ? empty : '')
    + (hasMp ? '<div class="trends-chart-box">'
        + '<div class="trends-chart-title">Movement Pattern by Adaptation — ' + label + '</div>'
        + buildAdaptLegend(adaptationsPresent)
        + renderStackedHorizChart(mpRows, maxMp)
        + '</div>' : '')
    + (hasMg ? '<div class="trends-chart-box">'
        + '<div class="trends-chart-title">Credited Sets by Muscle Group — ' + label + '</div>'
        + mgLegend
        + renderMuscleGroupChart(mgSplitMap, maxMg)
        + '</div>' : '');
}

function refreshVolumeBreakdown() {
  const sel = document.getElementById('vol-period-select');
  const el  = document.getElementById('vol-breakdown');
  if (sel && el) el.innerHTML = buildVolumeBreakdown(window._tSets || [], window._tWkKeys || [], sel.value);
}

// ── Consistency ───────────────────────────────────────────────────

function renderTrendsConsistency(sessions, weekKeys, weekLabels, plannedPerWeek) {
  const byWk = {};
  weekKeys.forEach(function(k) { byWk[k] = 0; });
  sessions.forEach(function(s) {
    const wk = getWeekMonday(s.session_date);
    if (byWk[wk] !== undefined) byWk[wk]++;
  });
  const values = weekKeys.map(function(k) { return byWk[k]; });
  const chart  = trendsBarChart(values, weekLabels, { height: 110 });

  const byMonth = {};
  sessions.forEach(function(s) {
    const m = s.session_date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  });
  const monthRows = Object.entries(byMonth).sort(function(a,b) { return b[0].localeCompare(a[0]); }).map(function(e) {
    const d   = new Date(e[0] + '-01T00:00:00');
    const lbl = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px"><span style="color:var(--fg)">' + lbl + '</span><span style="color:var(--accent);font-weight:600">' + e[1] + '</span></div>';
  }).join('');

  const ytd = sessions.filter(function(s) { return s.session_date.startsWith(new Date().getFullYear().toString()); }).length;

  // Completion rate — only shown when using AI coach (plannedPerWeek > 0)
  let completionHtml = '';
  if (plannedPerWeek > 0) {
    // Count weeks with data (exclude future weeks from denominator)
    const todayWk = getWeekMonday(today());
    const pastKeys = weekKeys.filter(function(k) { return k <= todayWk; });
    const totalPlanned  = pastKeys.length * plannedPerWeek;
    const totalPlannedCompleted = sessions.filter(function(s) { return s.planned_session_id; }).length;
    const pct = totalPlanned > 0 ? Math.round(totalPlannedCompleted / totalPlanned * 100) : 0;
    // This week: sessions completed vs planned
    const thisWkCompleted = sessions.filter(function(s) {
      return getWeekMonday(s.session_date) === todayWk && s.planned_session_id;
    }).length;
    completionHtml = '<div class="trends-stat-pill"><div class="trends-stat-num">' + pct + '%</div><div class="trends-stat-lbl">Completion Rate</div></div>'
      + '<div class="trends-stat-pill"><div class="trends-stat-num">' + thisWkCompleted + '/' + plannedPerWeek + '</div><div class="trends-stat-lbl">This Week</div></div>';
  }

  const statStrip = '<div class="trends-stat-strip"><div class="trends-stat-pill"><div class="trends-stat-num">' + ytd + '</div><div class="trends-stat-lbl">Sessions YTD</div></div><div class="trends-stat-pill"><div class="trends-stat-num">' + sessions.length + '</div><div class="trends-stat-lbl">Last 12 weeks</div></div>' + completionHtml + '</div>';

  return trendSection('consistency', 'Consistency', statStrip + '<div class="trends-chart-box"><div class="trends-chart-title">Sessions per Week</div>' + chart + '</div>' + monthRows);
}

// ── Readiness & Recovery ─────────────────────────────────────────
function renderTrendsReadiness(readiness, weekKeys, weekLabels) {
  if (!readiness.length) return trendSection('readiness', 'Readiness &amp; Recovery', '<div style="color:var(--muted);font-size:13px;padding:8px 0">No readiness data yet.</div>');

  // Compute composite readiness score per week (avg of energy + (5-soreness) + (5-stress) + motivation, scaled 1-5)
  const scoreByWk = {};
  readiness.forEach(function(r) {
    const wk = getWeekMonday(r.log_date);
    if (!scoreByWk[wk]) scoreByWk[wk] = [];
    const vals = [];
    if (r.energy     != null) vals.push(parseFloat(r.energy));
    if (r.soreness   != null) vals.push(6 - parseFloat(r.soreness)); // invert: low soreness = good
    if (r.stress     != null) vals.push(6 - parseFloat(r.stress));   // invert: low stress = good
    if (r.motivation != null) vals.push(parseFloat(r.motivation));
    if (vals.length) scoreByWk[wk].push(vals.reduce(function(a,b){return a+b;},0) / vals.length);
  });
  const scoreVals = weekKeys.map(function(k) {
    const arr = scoreByWk[k];
    return arr && arr.length ? parseFloat((arr.reduce(function(a,b){return a+b;},0)/arr.length).toFixed(1)) : null;
  });

  // Most recent log for the pill strip
  const latest = readiness.slice().sort(function(a,b){ return b.log_date.localeCompare(a.log_date); })[0];
  var pillHtml = '';
  if (latest) {
    const scoreNum = scoreVals.filter(function(v){return v!=null;}).slice(-1)[0];
    const scoreClass = scoreNum == null ? '' : scoreNum >= 4 ? 'good' : scoreNum >= 3 ? 'ok' : 'low';
    const scoreDisp  = scoreNum != null ? scoreNum.toFixed(1) : '—';
    pillHtml = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">'
      + '<div class="ready-score-pip ' + scoreClass + '">' + scoreDisp + '</div>'
      + '<div style="font-size:12px;color:var(--muted)">Latest score &nbsp;·&nbsp; ' + new Date(latest.log_date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) + '</div>'
      + '</div>'
      + '<div class="ready-last-row">'
      + (latest.energy     != null ? '<span class="ready-last-pill">⚡ Energy ' + latest.energy + '/5</span>' : '')
      + (latest.soreness   != null ? '<span class="ready-last-pill">💪 Soreness ' + latest.soreness + '/5</span>' : '')
      + (latest.stress     != null ? '<span class="ready-last-pill">🧠 Stress ' + latest.stress + '/5</span>' : '')
      + (latest.motivation != null ? '<span class="ready-last-pill">🔥 Motivation ' + latest.motivation + '/5</span>' : '')
      + (latest.sleep_hours!= null ? '<span class="ready-last-pill">😴 Sleep ' + latest.sleep_hours + 'h</span>' : '')
      + '</div>';
  }

  const chartHtml = '<div class="trends-chart-box"><div class="trends-chart-title">Readiness Score per Week (1–5)</div>'
    + trendsLineChart(scoreVals, weekLabels, { decimals: 1, min: 1, max: 5 }) + '</div>';

  return trendSection('readiness', 'Readiness &amp; Recovery', pillHtml + chartHtml);
}

function condAdaptation(workoutType, modality) {
  // Derive adaptation zone from workout_type / modality
  if (!workoutType && !modality) return 'Unknown';
  const wt = (workoutType || '').toLowerCase();
  const mo = (modality || '').toLowerCase();
  if (wt === 'intervals') return 'Anaerobic / Mixed';
  if (wt === 'circuit' || mo === 'circuit training') return 'Mixed / GPP';
  if (wt === 'tempo') return 'Threshold';
  if (wt === 'steady state' || mo === 'run' || mo === 'ruck' || mo === 'walk'
      || mo === 'rower' || mo === 'skierge' || mo === 'cycling'
      || mo === 'echo bike' || mo === 'swimming') return 'Aerobic Base';
  return 'Other';
}

function renderTrendsConditioning(conditioning, weekKeys, weekLabels) {
  if (!conditioning.length) return trendSection('conditioning', 'Conditioning', '<div style="color:var(--muted);font-size:13px;padding:8px 0">No conditioning data yet.</div>');

  // ── Minutes per week (12-week bar) ────────────────────────────────────────
  const byWk = {};
  weekKeys.forEach(function(k) { byWk[k] = 0; });
  conditioning.forEach(function(row) {
    const dateStr = row.conditioning_date || (row.created_at ? row.created_at.slice(0,10) : null);
    if (!dateStr) return;
    const wk = getWeekMonday(dateStr);
    if (byWk[wk] !== undefined && row.duration_minutes) byWk[wk] += row.duration_minutes;
  });
  const wkValues = weekKeys.map(function(k) { return Math.round(byWk[k]); });
  const minChart = trendsBarChart(wkValues, weekLabels, { height: 110, color: '#06b6d4' });

  // ── Last-30-day window ────────────────────────────────────────────────────
  const now30 = new Date(); now30.setDate(now30.getDate() - 30);
  const cutoff30 = now30.toISOString().slice(0,10);
  const recent = conditioning.filter(function(row) {
    const d = row.conditioning_date || (row.created_at ? row.created_at.slice(0,10) : null);
    return d && d >= cutoff30;
  });

  // ── Time by modality (30 days) ────────────────────────────────────────────
  const timeByMod = {};
  recent.forEach(function(row) {
    if (!row.modality) return;
    timeByMod[row.modality] = (timeByMod[row.modality] || 0) + (row.duration_minutes || 0);
  });
  const timeItems = Object.entries(timeByMod)
    .map(function(e) { return { label: e[0], value: Math.round(e[1]) }; })
    .sort(function(a,b) { return b.value - a.value; });

  // ── Distance by modality (30 days, metres -> miles) ───────────────────────
  const DIST_MODS = ['Run','Ruck','Walk','Rower','SkiErg','Cycling','Echo Bike','Swimming'];
  const distByMod = {};
  recent.forEach(function(row) {
    if (!row.modality || !row.distance_meters) return;
    if (!DIST_MODS.includes(row.modality)) return;
    distByMod[row.modality] = (distByMod[row.modality] || 0) + row.distance_meters;
  });
  const distItems = Object.entries(distByMod)
    .map(function(e) { return { label: e[0], value: parseFloat((e[1] / 1609.34).toFixed(1)) }; })
    .sort(function(a,b) { return b.value - a.value; });

  // ── Adaptation breakdown (30 days) ───────────────────────────────────────
  const adaptMap = {};
  recent.forEach(function(row) {
    const zone = condAdaptation(row.workout_type, row.modality);
    adaptMap[zone] = (adaptMap[zone] || 0) + (row.duration_minutes || 1);
  });
  const adaptColors = {
    'Aerobic Base': '#22c55e', 'Threshold': '#f59e0b',
    'Anaerobic / Mixed': '#ef4444', 'Mixed / GPP': '#8b5cf6', 'Other': '#94a3b8'
  };
  const adaptItems = Object.entries(adaptMap)
    .map(function(e) { return { label: e[0], value: Math.round(e[1]) }; })
    .sort(function(a,b) { return b.value - a.value; });

  // ── Workout type breakdown (30 days) ─────────────────────────────────────
  const wtMap = {};
  recent.forEach(function(row) {
    const wt = row.workout_type || 'Unspecified';
    wtMap[wt] = (wtMap[wt] || 0) + (row.duration_minutes || 1);
  });
  const wtItems = Object.entries(wtMap)
    .map(function(e) { return { label: e[0], value: Math.round(e[1]) }; })
    .sort(function(a,b) { return b.value - a.value; });

  // ── Build HTML ─────────────────────────────────────────────────────────────
  var body = '';

  body += '<div class="trends-chart-box"><div class="trends-chart-title">Minutes per Week</div>' + minChart + '</div>';

  if (adaptItems.length) {
    // Custom color horiz chart for adaptation
    const adaptTotal = adaptItems.reduce(function(s,i){return s+i.value;},0);
    var adaptRows = '';
    adaptItems.forEach(function(item) {
      const pct = adaptTotal ? Math.round(item.value / adaptTotal * 100) : 0;
      const col = adaptColors[item.label] || '#94a3b8';
      adaptRows += '<div class="horiz-bar-row">'
        + '<div class="horiz-bar-meta"><span>' + item.label + '</span><span>' + item.value + ' min (' + pct + '%)</span></div>'
        + '<div class="horiz-bar-track"><div class="horiz-bar-fill" style="width:' + pct + '%;background:' + col + '"></div></div>'
        + '</div>';
    });
    body += '<div class="trends-chart-box"><div class="trends-chart-title">By Adaptation Zone — last 30 days</div>' + adaptRows + '</div>';
  }

  if (wtItems.length) {
    body += '<div class="trends-chart-box"><div class="trends-chart-title">By Workout Type — last 30 days (min)</div>' + trendsHorizChart(wtItems, '#06b6d4') + '</div>';
  }

  if (timeItems.length) {
    body += '<div class="trends-chart-box"><div class="trends-chart-title">Time by Modality — last 30 days (min)</div>' + trendsHorizChart(timeItems, '#0891b2') + '</div>';
  }

  if (distItems.length) {
    body += '<div class="trends-chart-box"><div class="trends-chart-title">Distance by Modality — last 30 days (mi)</div>' + trendsHorizChart(distItems, '#0e7490') + '</div>';
  }

  return trendSection('conditioning', 'Conditioning', body);
}

function renderTrendsPain(painItems) {
  if (!painItems.length) return '<div class="trends-section"><div class="trends-section-title">Watch Items</div><div style="color:var(--muted);font-size:13px;padding:8px 0">No active pain or injury flags. ✓</div></div>';
  const scMap = { 'new': '#ef4444', 'worse': '#ef4444', 'same': '#f59e0b', 'improving': '#22c55e' };
  const html  = painItems.map(function(p) {
    const sc   = scMap[p.status] || '#94a3b8';
    const meta = [
      p.pain_score != null ? 'Pain: ' + p.pain_score + '/10' : null,
      p.status     ? p.status.charAt(0).toUpperCase() + p.status.slice(1) : null,
      p.log_date   ? new Date(p.log_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null,
      p.modified_training ? 'Training modified' : null,
    ].filter(Boolean).join(' · ');
    const notesHtml = p.notes ? '<div class="pain-meta" style="margin-top:4px;font-style:italic">' + p.notes + '</div>' : '';
    return '<div class="pain-flag" style="border-left-color:' + sc + '"><div class="pain-region">' + p.body_region + '</div><div class="pain-meta">' + meta + '</div>' + notesHtml + '</div>';
  }).join('');
  return '<div class="trends-section"><div class="trends-section-title">Watch Items</div>' + html + '</div>';
}


