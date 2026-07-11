// ══════════════ Kardia Nutrition — Today screen + logging + meal builder ══════════════

const N_STATUS_LABEL = {
  as_planned: '✓ ate as planned', swapped: '⇄ swapped', skipped: 'skipped',
  ate_out: '🍴 ate out', added: '+ added',
};
const N_STATUS_ICON = { as_planned: '✓', swapped: '⇄', skipped: '✕', ate_out: '🍴', added: '+' };
const N_PORTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
let N_OPEN = {};   // expanded logged-card ids (session only)

// ── Render ──
function renderToday() {
  const dateStr = nToday();
  document.getElementById('today-title').textContent = nFmtDate(dateStr);
  document.getElementById('today-sub').textContent =
    `${NS.me.name} · week of ${NS.weekOf}${NS.planWeek ? '' : ' — no plan pushed yet'}`;

  const body = document.getElementById('today-body');
  let html = '';
  html += nPromptCardsHtml();

  const inWeek = dateStr >= NS.weekOf && dateStr <= nAddDays(NS.weekOf, 6);
  if (!inWeek) {
    html += `<div class="n-panel"><div class="n-panel-title">Plan week of ${NS.weekOf}</div>
      Your plan ${dateStr < NS.weekOf ? 'starts ' + nFmtDate(NS.weekOf) : 'ended ' + nFmtDate(nAddDays(NS.weekOf, 6))}.
      Browse the full week, prep plan, and grocery list in the tabs below — meals appear here day by day once the week begins.</div>`;
  } else {
    html += `<div class="n-sticky">${nBudgetHtml(dateStr)}</div>`;
  }

  const meals = inWeek ? nMyMeals(dateStr) : [];
  if (!meals.length && inWeek) {
    html += `<div class="n-panel">No meals planned for today.</div>`;
  }
  for (const m of meals) html += nMealCardHtml(m);

  // Added (unplanned) items today
  const added = NS.addedLogs.filter(l => l.log_date === dateStr);
  if (added.length) {
    html += `<div class="n-sheet-section" style="margin-top:14px">Added today</div>`;
    for (const l of added) html += nAddedCardHtml(l);
  }

  html += nActivityCardHtml();
  html += `<button class="n-act" style="width:100%;margin-top:10px" onclick="openNSheet('add', null)">+ Add food</button>`;
  body.innerHTML = html;
}

// ── On-track math ──
// Color compares ACTUAL eaten vs PLANNED-SO-FAR (only meals already logged).
// One breakfast logged as planned = green, even early in the day.
function nExpectedSoFar(dateStr) {
  let expected = 0;
  for (const m of nMyMeals(dateStr)) if (NS.logs[m.id]) expected += m.planned_kcal;
  return expected;
}
function nTrackClass(actual, expected) {
  if (!expected && !actual) return 'idle';
  const diff = Math.abs(actual - expected);
  if (diff <= Math.max(100, 0.10 * expected)) return 'ok';
  if (diff <= Math.max(250, 0.20 * expected)) return 'warn';
  return 'bad';
}
function nWeekStats() {
  let actual = 0, expected = 0, approx = false;
  for (const m of NS.meals) {
    if (m.athlete_id !== NS.me.id) continue;
    const l = NS.logs[m.id];
    if (!l) continue;
    expected += m.planned_kcal;
    if (l.actual_kcal == null && l.status !== 'skipped') { approx = true; continue; }
    actual += l.actual_kcal || 0;
  }
  for (const l of NS.addedLogs) {
    if (l.actual_kcal == null) { approx = true; continue; }
    actual += l.actual_kcal || 0;
  }
  return { actual: Math.round(actual), expected: Math.round(expected), approx };
}

// ── Budget header (sticky, day + week bars) ──
function nBudgetHtml(dateStr) {
  const t = NS.target;
  if (!t) return `<div class="n-panel">No targets pushed for this week yet.</div>`;
  const { kcal, protein, approx } = nDayTotals(dateStr);
  const expected = nExpectedSoFar(dateStr);
  const dayCls = nTrackClass(kcal, expected);
  // The bar runs against what's PLANNED for the day; the target is context.
  // Planned days intentionally land within ~±100 kcal of target, not exactly on it.
  const plannedToday = Math.round(nMyMeals(dateStr).reduce((s, m) => s + m.planned_kcal, 0)) || t.kcal_target;
  const dayPct = Math.min(100, Math.round(100 * kcal / plannedToday));
  const remaining = plannedToday - kcal;
  const pRemain = Math.max(0, t.protein_g_low - protein);
  const tilde = approx ? '~' : '';

  const wk = nWeekStats();
  const wkPlanned = Math.round(NS.meals.filter(m => m.athlete_id === NS.me.id)
    .reduce((s, m) => s + m.planned_kcal, 0)) || t.kcal_target * 7;
  const wkCls = nTrackClass(wk.actual, wk.expected);
  const wkPct = Math.min(100, Math.round(100 * wk.actual / wkPlanned));
  const wkLeft = wkPlanned - wk.actual;

  let hint = '';
  const dayDiff = kcal - expected;
  if (dayCls === 'bad' && dayDiff > 0)
    hint = `<div class="n-budget-hint">~${dayDiff} over planned-so-far — go lighter on the next meal, then back to plan (no compensating)</div>`;
  else if (dayCls === 'bad' && expected > 0)
    hint = `<div class="n-budget-hint">~${-dayDiff} under planned-so-far — under-eating isn't a win in this phase; eat your meals</div>`;

  return `<div class="n-budget" style="margin-bottom:10px">
    <div class="n-budget-kcal"><span>Today ${tilde}${kcal.toLocaleString()} / ${plannedToday.toLocaleString()} planned</span>
      <span style="font-size:12px;font-weight:400;color:var(--n-muted)">P ${tilde}${protein} / ${t.protein_g_low}–${t.protein_g_high}g</span></div>
    <div class="n-budget-bar"><div class="n-budget-fill ${dayCls}" style="width:${dayPct}%"></div></div>
    <div class="n-budget-row2"><span>Week ${wk.approx ? '~' : ''}${wk.actual.toLocaleString()} / ${wkPlanned.toLocaleString()} planned</span>
      <span>${wkLeft > 0 ? '~' + wkLeft.toLocaleString() + ' left this week' : 'week plan complete'}</span></div>
    <div class="n-bar-slim"><div class="n-budget-fill ${wkCls}" style="width:${wkPct}%"></div></div>
    <div class="n-budget-remaining">Remaining today: <b>${remaining > 0 ? '~' + remaining.toLocaleString() + ' kcal' : 'plan complete ✓'}</b>
      · day target ${t.kcal_target.toLocaleString()}
      ${pRemain > 0 ? ` · ~${pRemain}g protein to floor` : ' · protein floor met ✓'}</div>
    ${hint}</div>`;
}

// ── Prompt cards ──
function nWeighInDueToday() {
  const days = NS.settings?.weigh_in_days || [];
  return days.includes(nDayName(nToday(), true)) && NS.metricsToday.weight == null && !NS.dismissed.weight;
}
function nMeasurementsDue() {
  const s = NS.settings;
  if (!s) return [];
  const intDays = (s.measurement_interval_weeks || 4) * 7;
  return (s.measurement_metrics || []).filter(metric => {
    if (NS.metricsToday[metric] != null || NS.dismissed[metric]) return false;
    const last = NS.lastMetricDates[metric];
    if (!last) return true;
    return (new Date(nToday()) - new Date(last)) / 86400000 >= intDays;
  });
}
function nPromptCardsHtml() {
  let html = '';
  const day = nDayName(nToday(), true);
  if (day === 'Sun' && !NS.checkin && !NS.dismissed.checkin) {
    html += `<div class="n-prompt"><div class="n-prompt-title">📝 Weekly check-in day</div>
      <div class="n-prompt-row">
        <button class="n-act small primary" onclick="openCheckin()">Open check-in (~1 min)</button>
        <button class="n-prompt-dismiss" onclick="NS.dismissed.checkin=1;renderToday()">later</button>
      </div></div>`;
  }
  if ((day === 'Sun' || day === 'Wed') && NS.planWeek?.prep_plan && !NS.dismissed.prep) {
    html += `<div class="n-prompt"><div class="n-prompt-title">🔪 Prep night
      <button class="n-prompt-dismiss" onclick="NS.dismissed.prep=1;renderToday()">done</button></div>
      <div style="font-size:13px;color:var(--n-text);white-space:pre-wrap">${nEsc(NS.planWeek.prep_plan)}</div></div>`;
  }
  if (nWeighInDueToday()) {
    html += `<div class="n-prompt"><div class="n-prompt-title">⚖️ Weigh-in day</div>
      <div class="n-prompt-row">
        <input type="number" inputmode="decimal" id="np-weight" placeholder="lbs">
        <button class="n-act small primary" onclick="submitWeighIn()">Save</button>
        <button class="n-prompt-dismiss" onclick="NS.dismissed.weight=1;renderToday()">later</button>
      </div></div>`;
  }
  const due = nMeasurementsDue();
  if (due.length) {
    const rows = due.map(metric => {
      const label = { waist: 'Waist (in)', hips: 'Hips (in)', caliper_mm_sum: 'Calipers mm-sum' }[metric] || metric;
      return `<div class="n-prompt-row" style="margin-bottom:6px"><label style="width:110px">${label}</label>
        <input type="number" inputmode="decimal" id="np-${metric}">
        <button class="n-act small primary" onclick="submitMeasurement('${metric}')">Save</button></div>`;
    }).join('');
    html += `<div class="n-prompt"><div class="n-prompt-title">📏 Measurement check (every ${NS.settings?.measurement_interval_weeks || 4} weeks)
      <button class="n-prompt-dismiss" onclick="${due.map(d => `NS.dismissed['${d}']=1`).join(';')};renderToday()">later</button></div>${rows}</div>`;
  }
  return html;
}
async function submitWeighIn() {
  const v = parseFloat(document.getElementById('np-weight').value);
  if (!v || v < 50 || v > 500) { toast('Enter a weight in lbs'); return; }
  if (await nSaveMetric('weight', v, 'lb')) { toast('Weight saved ✓'); renderToday(); }
}
async function submitMeasurement(metric) {
  const v = parseFloat(document.getElementById(`np-${metric}`).value);
  if (!v || v <= 0) { toast('Enter a value'); return; }
  const unit = metric === 'caliper_mm_sum' ? 'mm' : 'in';
  if (await nSaveMetric(metric, v, unit)) { toast('Saved ✓'); renderToday(); }
}

// ── Meal cards ──
function nToggleCard(id) { N_OPEN[id] = !N_OPEN[id]; renderToday(); }

function nMealCardHtml(m) {
  const log = NS.logs[m.id];
  const name = nMealName(m);
  const partner = nSharedPartner(m);
  const slotLabel = m.meal_slot === 'snack' ? `snack ${m.slot_order > 1 ? m.slot_order : ''}` : m.meal_slot;

  let badges = '';
  if (partner) badges += `<span class="n-badge shared">👥 with ${nEsc(partner.name)} (their portion: ${partner.servings}×)</span>`;
  if (m.is_leftover) badges += `<span class="n-badge leftover">leftover</span>`;

  if (log) {
    const ate = nLogName(log);
    const icon = N_STATUS_ICON[log.status] || '✓';
    const cls = log.status === 'skipped' ? 'skip' : (log.status === 'ate_out' ? 'off' : '');
    const kcalTxt = log.actual_kcal != null
      ? `${log.actual_kcal} · ${log.actual_protein_g}P${log.portion_modifier !== 1 ? ` · ${log.portion_modifier}×` : ''}`
      : 'not quantified';
    const label = log.status === 'swapped' && ate ? `${nEsc(name)} → ${nEsc(ate)}` : nEsc(name);

    if (!N_OPEN[m.id]) {
      return `<div class="n-meal done compact ${cls}" onclick="nToggleCard('${m.id}')">
        <div class="n-done-row"><span class="n-done-check">${icon}</span>
          <span class="n-done-name">${label}</span>
          <span class="n-done-kcal">${kcalTxt}</span></div></div>`;
    }
    const showChips = log.status !== 'skipped';
    return `<div class="n-meal done">
      <div class="n-meal-top" onclick="nToggleCard('${m.id}')" style="cursor:pointer">
        <span class="n-meal-slot">${slotLabel} ▾</span>
        <span class="n-meal-kcal">${kcalTxt}</span></div>
      <div class="n-meal-name">${label}</div>
      <div class="n-meal-badges"><span class="n-badge status">${N_STATUS_LABEL[log.status] || log.status}</span>${badges}</div>
      ${showChips ? `<div class="n-portion-chips">${N_PORTIONS.map(p =>
        `<button class="n-chip${log.portion_modifier === p ? ' active' : ''}" onclick="pickPortion('${m.id}',${p})">${p}×</button>`).join('')}</div>` : ''}
      <div class="n-meal-actions" style="margin-top:8px">
        <button class="n-act small" onclick="reopenMeal('${m.id}')">Re-log</button>
        <button class="n-act small" onclick="nToggleCard('${m.id}')">Collapse</button>
      </div></div>`;
  }

  return `<div class="n-meal">
    <div class="n-meal-top"><span class="n-meal-slot">${slotLabel}</span>
      <span class="n-meal-kcal">${Math.round(m.planned_kcal)} kcal · ${Math.round(m.planned_protein_g)}P · ${Math.round(m.planned_carbs_g)}C · ${Math.round(m.planned_fat_g)}F</span></div>
    <div class="n-meal-name">${nEsc(name)}</div>
    ${m.portion_note ? `<div class="n-meal-portion">${nEsc(m.portion_note)}</div>` : ''}
    ${badges ? `<div class="n-meal-badges">${badges}</div>` : ''}
    ${m.coach_note ? `<div class="n-meal-note">${nEsc(m.coach_note)}</div>` : ''}
    <div class="n-meal-actions">
      <button class="n-act primary" onclick="quickLog('${m.id}')">✓ Ate it</button>
      <button class="n-act" onclick="openNSheet('swap','${m.id}')">⇄ Swap</button>
      <button class="n-act" onclick="quickSkip('${m.id}')">Skip</button>
    </div></div>`;
}

// ── Added (unplanned) item cards: portion + delete ──
function nAddedCardHtml(l) {
  const name = nLogName(l) || 'Added item';
  const kcalTxt = l.actual_kcal != null
    ? `${l.actual_kcal} · ${l.actual_protein_g ?? 0}P${l.portion_modifier !== 1 ? ` · ${l.portion_modifier}×` : ''}`
    : 'not quantified';
  if (!N_OPEN[l.id]) {
    return `<div class="n-meal done compact" onclick="nToggleCard('${l.id}')">
      <div class="n-done-row"><span class="n-done-check">+</span>
        <span class="n-done-name">${nEsc(name)}</span>
        <span class="n-done-kcal">${kcalTxt}</span></div></div>`;
  }
  return `<div class="n-meal done">
    <div class="n-meal-top" onclick="nToggleCard('${l.id}')" style="cursor:pointer">
      <span class="n-meal-slot">extra ▾</span><span class="n-meal-kcal">${kcalTxt}</span></div>
    <div class="n-meal-name">${nEsc(name)}</div>
    ${l.actual_kcal != null ? `<div class="n-portion-chips">${N_PORTIONS.map(p =>
      `<button class="n-chip${l.portion_modifier === p ? ' active' : ''}" onclick="nAddedPortion('${l.id}',${p})">${p}×</button>`).join('')}</div>` : ''}
    <div class="n-meal-actions" style="margin-top:8px">
      <button class="n-act small" onclick="nRemoveAdded('${l.id}')">Remove</button>
      <button class="n-act small" onclick="nToggleCard('${l.id}')">Collapse</button>
    </div></div>`;
}
async function nAddedPortion(logId, p) {
  const l = NS.addedLogs.find(x => x.id === logId);
  if (!l) return;
  const prev = l.portion_modifier || 1.0;
  const scale = v => v == null ? null : nRound((v / prev) * p);
  const row = { portion_modifier: p, actual_kcal: scale(l.actual_kcal),
    actual_protein_g: scale(l.actual_protein_g), actual_carbs_g: scale(l.actual_carbs_g),
    actual_fat_g: scale(l.actual_fat_g) };
  try {
    const saved = await nWriteLog(row, l.id);
    NS.addedLogs = NS.addedLogs.map(x => x.id === logId ? saved : x);
    renderToday();
  } catch (e) { toast('Save failed', 3000); }
}
async function nRemoveAdded(logId) {
  const { error } = await ndb.from('meal_logs').delete().eq('id', logId);
  if (error) { toast('Remove failed: ' + error.message, 3500); return; }
  NS.addedLogs = NS.addedLogs.filter(x => x.id !== logId);
  toast('Removed');
  renderToday();
}

function nFindMeal(id) { return NS.meals.find(m => m.id === id); }

async function quickLog(mealId) {
  const m = nFindMeal(mealId);
  try { await nLogMeal(m, 'as_planned', null, 1.0); toast('Logged ✓'); renderToday(); }
  catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}
async function quickSkip(mealId) {
  const m = nFindMeal(mealId);
  try { await nLogMeal(m, 'skipped', null, 1.0); toast('Skipped — back to plan next meal'); renderToday(); }
  catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}
async function pickPortion(mealId, p) {
  const m = nFindMeal(mealId);
  try { await nSetPortion(m, p); renderToday(); }
  catch (e) { toast('Save failed', 3000); }
}
async function reopenMeal(mealId) {
  const m = nFindMeal(mealId);
  const l = NS.logs[m.id];
  if (!l) return;
  const { error } = await ndb.from('meal_logs').delete().eq('id', l.id);
  if (error) { toast('Could not re-open: ' + error.message, 3500); return; }
  delete NS.logs[m.id];
  delete N_OPEN[m.id];
  renderToday();
}

// ══════════════ Meal builder sheet (swap / ate-out / add) ══════════════
// Tap items to add to the basket, set quantities, log once.
// "6 eggs instead of steak & eggs" = Swap → Foods → Egg → qty 6 → Log.

function openNSheet(mode, mealId) {
  const meal = mealId ? nFindMeal(mealId) : null;
  NS.sheet = { mode, meal, basket: [], filter: 'all', mf: 'all' };
  document.getElementById('n-sheet-title').textContent =
    mode === 'swap' ? 'Swap / adjust meal' : 'Add food';
  document.getElementById('n-sheet-search').value = '';
  document.getElementById('n-custom-desc').value = '';
  document.getElementById('n-custom-kcal').value = '';
  document.getElementById('n-custom-protein').value = '';
  document.getElementById('n-custom-carbs').value = '';
  document.getElementById('n-custom-fat').value = '';
  document.getElementById('n-custom-serving').value = '';
  const srvRow = document.getElementById('n-custom-serving-row');
  if (srvRow) srvRow.style.display = 'none';
  else document.getElementById('n-custom-serving').style.display = 'none';
  document.getElementById('n-custom-save').classList.remove('active');
  document.getElementById('n-sheet').style.display = 'flex';
  renderNSheetList();
}
function closeNSheet() {
  document.getElementById('n-sheet').style.display = 'none';
  NS.sheet = null;
}
function nSetFilter(f) { NS.sheet.filter = f; renderNSheetList(); }

// ── Basket ──
function nBasketAdd(kind, id) {
  const b = NS.sheet.basket;
  const existing = b.find(x => x.srcKind === kind && x.srcId === id);
  if (existing) { existing.qty += 1; renderNSheetList(); return; }
  let item = null;
  if (kind === 'r') {
    const r = NS.recipes.find(x => x.id === id);
    if (r) item = { srcKind: 'r', srcId: id, kind: 'r', id, name: r.name, qty: 1,
      kcal: r.kcal_per_serving, protein_g: r.protein_g_per_serving,
      carbs_g: r.carbs_g_per_serving, fat_g: r.fat_g_per_serving, unit: 'serving' };
  } else if (kind === 'f') {
    const f = NS.foods.find(x => x.id === id);
    if (f) item = { srcKind: 'f', srcId: id, kind: 'f', id, name: f.name, qty: 1,
      kcal: f.kcal, protein_g: f.protein_g, carbs_g: f.carbs_g, fat_g: f.fat_g,
      unit: f.serving_desc, rest: f.item_type === 'restaurant' };
  } else if (kind === 'a') {
    const alts = NS.alternates[NS.sheet.meal?.id] || [];
    const a = alts.find(x => x.id === id);
    if (a) {
      const nm = a.recipe_id ? (NS.recipes.find(r => r.id === a.recipe_id)?.name || 'Recipe')
                             : (NS.foods.find(f => f.id === a.food_item_id)?.name || 'Food');
      item = { srcKind: 'a', srcId: id, kind: a.recipe_id ? 'r' : 'f',
        id: a.recipe_id || a.food_item_id, name: nm, qty: 1,
        kcal: a.kcal, protein_g: a.protein_g, carbs_g: a.carbs_g, fat_g: a.fat_g,
        unit: `${a.servings} srv (coach portion)` };
    }
  }
  if (item) { b.push(item); renderNSheetList(); }
}
function nBasketQty(idx, val) {
  const q = parseFloat(val);
  if (!q || q <= 0) return;
  NS.sheet.basket[idx].qty = q;
  renderNSheetList();
}
function nBasketRemove(idx) { NS.sheet.basket.splice(idx, 1); renderNSheetList(); }
function nBasketTotals() {
  const t = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const it of NS.sheet.basket) {
    t.kcal += it.kcal * it.qty; t.protein_g += it.protein_g * it.qty;
    t.carbs_g += it.carbs_g * it.qty; t.fat_g += it.fat_g * it.qty;
  }
  for (const k of Object.keys(t)) t[k] = Math.round(t[k]);
  return t;
}

async function submitBasket() {
  const { mode, meal, basket } = NS.sheet || {};
  if (!basket || !basket.length) return;
  const tot = nBasketTotals();
  const multi = basket.length > 1;
  const first = basket[0];
  const qtyDesc = basket.map(it => `${it.qty}× ${it.name}`).join('; ');
  const src = {
    recipe_id: (!multi && first.kind === 'r') ? first.id : null,
    food_item_id: (!multi && first.kind === 'f') ? first.id : null,
    desc: (multi || first.qty !== 1) ? qtyDesc : null,
    kcal: tot.kcal, protein_g: tot.protein_g, carbs_g: tot.carbs_g, fat_g: tot.fat_g,
  };
  try {
    const status = basket.every(it => it.rest) ? 'ate_out' : 'swapped';
    if (mode === 'add' || !meal) await nLogAdded(nToday(), src);
    else await nLogMeal(meal, status, src, 1.0);
    closeNSheet(); toast('Logged ✓'); renderToday();
  } catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}

// ── Sheet rendering ──
function nOptHtml(kind, id, star, name, sub) {
  return `<button class="n-opt" onclick="nBasketAdd('${kind}','${id}')">
    <div class="n-opt-name">${star ? '★ ' : ''}${nEsc(name)}</div>
    <div class="n-opt-sub">${nEsc(sub)} — tap to add</div></button>`;
}

function renderNSheetList() {
  const q = document.getElementById('n-sheet-search').value.trim().toLowerCase();
  const { mode, meal, filter, basket } = NS.sheet || {};
  const slot = meal?.meal_slot;
  let html = '';

  // Basket panel
  if (basket && basket.length) {
    const tot = nBasketTotals();
    const rows = basket.map((it, i) => `<div class="n-basket-row">
      <span class="n-basket-name">${nEsc(it.name)} <span style="color:var(--n-muted);font-size:11px">(${nEsc(String(it.unit))})</span></span>
      <input type="number" class="n-basket-qty" inputmode="decimal" step="0.25" min="0.25"
        value="${it.qty}" onchange="nBasketQty(${i}, this.value)">
      <button class="n-basket-x" onclick="nBasketRemove(${i})">✕</button></div>`).join('');
    let delta = '';
    if (meal) {
      const dk = Math.round(tot.kcal - meal.planned_kcal);
      const dp = Math.round(tot.protein_g - meal.planned_protein_g);
      delta = `<div class="n-basket-delta">${dk >= 0 ? '+' : ''}${dk} kcal · ${dp >= 0 ? '+' : ''}${dp}P vs planned meal</div>`;
    }
    html += `<div class="n-basket">${rows}
      <div class="n-basket-total">Total: ${tot.kcal} kcal · ${tot.protein_g}P · ${tot.carbs_g}C · ${tot.fat_g}F</div>
      ${delta}
      <button class="btn" style="margin-top:8px;width:100%" onclick="submitBasket()">Log ${basket.length > 1 ? basket.length + ' items' : 'it'}</button></div>`;
  }

  // Tweak: start the basket from the planned meal's own ingredients.
  // Works for recipe meals (itemized components) AND single-food meals (the food
  // itself, so quantity is adjustable). Custom meals have nothing to decompose.
  const comps = (mode === 'swap' && meal && meal.recipe_id) ? (NS.components || {})[meal.recipe_id] : null;
  const tweakable = (comps && comps.length) || (mode === 'swap' && meal && meal.food_item_id);
  if (tweakable && (!basket || !basket.length)) {
    html += `<button class="n-opt" style="border-color:#3f6a30" onclick="nTweakSeed()">
      <div class="n-opt-name">🔧 Tweak this meal</div>
      <div class="n-opt-sub">Start from what's planned — change amounts, drop or add items</div></button>`;
  }

  // Filter chips
  const hasAlts = mode === 'swap' && meal && (NS.alternates[meal.id] || []).length;
  const filters = [['all', 'All']];
  if (hasAlts) filters.push(['alts', '★ Coach picks']);
  filters.push(['recipes', 'Recipes'], ['foods', 'Foods'], ['restaurants', 'Restaurants']);
  html += `<div class="n-filter-row">${filters.map(([f, l]) =>
    `<button class="n-chip${filter === f ? ' active' : ''}" onclick="nSetFilter('${f}')">${l}</button>`).join('')}</div>`;

  const show = s => filter === 'all' || filter === s;

  // ★ Coach alternates
  if (hasAlts && show('alts')) {
    html += `<div class="n-sheet-section">★ Coach alternates</div>`;
    for (const a of NS.alternates[meal.id]) {
      const nm = a.recipe_id ? (NS.recipes.find(r => r.id === a.recipe_id)?.name || 'Recipe')
                             : (NS.foods.find(f => f.id === a.food_item_id)?.name || 'Food');
      if (q && !nm.toLowerCase().includes(q)) continue;
      html += nOptHtml('a', a.id, true, nm,
        `${Math.round(a.kcal)} kcal · ${Math.round(a.protein_g)}P${a.note ? ' — ' + a.note : ''}`);
    }
  }

  // Recipes
  if (show('recipes')) {
    const recs = NS.recipes.filter(r =>
      q ? r.name.toLowerCase().includes(q)
        : (filter === 'recipes' || !slot || (r.best_meal_slots || []).includes(slot)));
    if (recs.length) html += `<div class="n-sheet-section">Recipes</div>`;
    for (const r of recs.slice(0, 40))
      html += nOptHtml('r', r.id, false, r.name,
        `${Math.round(r.kcal_per_serving)} kcal · ${Math.round(r.protein_g_per_serving)}P per serving`);
  }

  // Foods (raw ingredients / packaged / simple meals)
  if (show('foods')) {
    let fds = NS.foods.filter(f => f.item_type !== 'restaurant' &&
      (q ? f.name.toLowerCase().includes(q)
         : (filter === 'foods' || !slot || (f.default_meal_slots || []).includes(slot))));
    if (filter === 'foods') {
      const mf = NS.sheet.mf || 'all';
      html += `<div class="n-filter-row" style="margin:2px 0 6px">${[['all', 'All'], ['protein', '🥩 Protein'], ['carbs', '🍚 Carbs'], ['fats', '🥑 Fats']].map(([f2, l]) =>
        `<button class="n-chip${mf === f2 ? ' active' : ''}" onclick="NS.sheet.mf='${f2}';renderNSheetList()">${l}</button>`).join('')}</div>`;
      if (mf !== 'all') fds = fds.filter(f => nMacroClass(f) === mf);
    }
    if (fds.length) html += `<div class="n-sheet-section">Foods & ingredients</div>`;
    for (const f of fds.slice(0, 50))
      html += nOptHtml('f', f.id, false, f.name,
        `${Math.round(f.kcal)} kcal · ${Math.round(f.protein_g)}P per ${f.serving_desc}` +
        (f.approval_status === 'pending' ? ' · ⏳ pending review' : ''));
  }

  // Restaurants, grouped
  if (show('restaurants')) {
    const rests = NS.foods.filter(f => f.item_type === 'restaurant' &&
      (!q || f.name.toLowerCase().includes(q) || (f.restaurant_name || '').toLowerCase().includes(q)));
    const groups = {};
    for (const f of rests) (groups[f.restaurant_name || 'Restaurants'] ||= []).push(f);
    for (const [rn, items] of Object.entries(groups)) {
      html += `<div class="n-sheet-section">🍴 ${nEsc(rn)}</div>`;
      for (const f of items)
        html += nOptHtml('f', f.id, (f.tags || []).includes('recommended'), f.name,
          `${Math.round(f.kcal)} kcal · ${Math.round(f.protein_g)}P — ${f.serving_desc}`);
    }
  }

  document.getElementById('n-sheet-list').innerHTML =
    html || '<div class="n-opt-sub" style="padding:12px">No matches.</div>';
}

function toggleCustomSave() {
  const btn = document.getElementById('n-custom-save');
  const on = btn.classList.toggle('active');
  // Defensive: works with either markup version (wrapper row or bare input)
  const row = document.getElementById('n-custom-serving-row');
  const inp = document.getElementById('n-custom-serving');
  if (row) row.style.display = on ? 'block' : 'none';
  else if (inp) inp.style.display = on ? 'block' : 'none';
  if (on && inp) inp.focus();
}

async function submitCustomFood() {
  const desc = document.getElementById('n-custom-desc').value.trim();
  if (!desc) { toast('Name what you ate'); return; }
  const kcal = parseFloat(document.getElementById('n-custom-kcal').value) || null;
  const protein = parseFloat(document.getElementById('n-custom-protein').value) || null;
  const carbs = parseFloat(document.getElementById('n-custom-carbs').value) || null;
  const fat = parseFloat(document.getElementById('n-custom-fat').value) || null;
  const saveIt = document.getElementById('n-custom-save').classList.contains('active');
  const { mode, meal } = NS.sheet || {};

  let src = { desc, kcal, protein_g: protein, carbs_g: carbs, fat_g: fat };

  // Save-for-reuse path: becomes a real, searchable food_item (tagged user_added;
  // the coach reviews these weekly and promotes keepers into the curated library)
  if (saveIt) {
    const serving = document.getElementById('n-custom-serving').value.trim();
    if (!serving || kcal == null || protein == null) {
      toast('Saving for reuse needs serving + kcal + protein'); return;
    }
    const { data: nf, error } = await ndb.from('food_items').insert({
      name: desc, serving_desc: serving, item_type: 'packaged',
      kcal, protein_g: protein, carbs_g: carbs ?? 0, fat_g: fat ?? 0,
      tags: ['user_added'], default_meal_slots: ['snack'],
      approval_status: 'pending',
    }).select().single();
    if (error) {
      toast(error.code === '23505' ? 'That name already exists — search for it instead' : 'Save failed: ' + error.message, 4000);
      return;
    }
    NS.foods.push(nf);
    src = { food_item_id: nf.id, kcal, protein_g: protein, carbs_g: carbs ?? 0, fat_g: fat ?? 0 };
  }

  try {
    if (mode === 'add' || !meal) await nLogAdded(nToday(), src);
    else await nLogMeal(meal, 'swapped', kcal != null ? src : { ...src, kcal: null }, 1.0);
    closeNSheet();
    toast(saveIt ? 'Saved to your foods + logged ✓' : (kcal != null ? 'Logged ✓' : 'Logged (unquantified) — day totals show ~'), 3000);
    renderToday();
  } catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}

// ── Activity (steps + non-system workouts) ──
// Stored in body_metrics: metric 'steps' (value = count) and 'workout_min'
// (value = minutes, notes = type). Context for TDEE — NOT added to it
// (the scale-based TDEE already contains all activity; adding would double-count).
const N_WORKOUT_KCAL_MIN = { Lift: 0.025, 'WOD/HIIT': 0.045, Cardio: 0.035, Other: 0.03 };
function nBw() { return NS.lastWeight || NS.metricsToday.weight || 165; }
function nStepsKcal(steps) { return Math.round(steps * nBw() * 0.00023); }
function nWorkoutKcal(min, type) { return Math.round(min * (N_WORKOUT_KCAL_MIN[type] || 0.03) * nBw()); }

function nActivityCardHtml() {
  const steps = NS.metricsToday.steps;
  const wMin = NS.metricsToday.workout_min;
  const wType = (NS.metricsTodayNotes || {}).workout_min || '';
  let summary = [];
  if (steps != null) summary.push(`👟 ${Number(steps).toLocaleString()} steps (~${nStepsKcal(steps)} kcal)`);
  if (wMin != null) summary.push(`💪 ${wMin} min ${nEsc(wType)} (~${nWorkoutKcal(wMin, wType)} kcal)`);
  const hint = NS.me.training_active
    ? 'Gym sessions from the strength app sync automatically — log only extra activity here.'
    : 'Log workouts here so they show in your trends.';

  return `<div class="n-panel" style="margin-top:14px"><div class="n-panel-title">⚡ Activity today</div>
    ${summary.length ? `<div style="font-size:13px;color:var(--n-text);margin-bottom:8px">${summary.join(' · ')}</div>` : ''}
    <div class="n-prompt-row" style="margin-bottom:8px">
      <input type="number" inputmode="numeric" id="na-steps" placeholder="steps" value="${steps ?? ''}">
      <button class="n-act small primary" onclick="submitSteps()">Save steps</button></div>
    <div class="n-prompt-row">
      <input type="number" inputmode="numeric" id="na-wmin" placeholder="min" style="width:64px" value="${wMin ?? ''}">
      ${Object.keys(N_WORKOUT_KCAL_MIN).map(k =>
        `<button class="n-chip${wType === k ? ' active' : ''}" onclick="submitWorkout('${k}')">${k}</button>`).join('')}
    </div>
    <div style="font-size:11px;color:var(--n-muted);margin-top:6px">${hint} Estimates are rough — they inform trends, not your calorie target.</div></div>`;
}
async function submitSteps() {
  const v = parseInt(document.getElementById('na-steps').value, 10);
  if (!v || v < 0 || v > 100000) { toast('Enter today\'s step count'); return; }
  if (await nSaveMetric('steps', v, 'steps')) { toast('Steps saved ✓'); renderToday(); }
}
async function submitWorkout(type) {
  const min = parseInt(document.getElementById('na-wmin').value, 10);
  if (!min || min <= 0 || min > 600) { toast('Enter workout minutes first'); return; }
  if (nOffline) { toast('Offline — reconnect to log.', 3000); return; }
  const { error } = await ndb.from('body_metrics').upsert({
    athlete_id: NS.me.id, log_date: nToday(), metric: 'workout_min',
    value: min, unit: 'min', notes: type,
  }, { onConflict: 'athlete_id,log_date,metric' });
  if (error) { toast('Save failed: ' + error.message, 4000); return; }
  NS.metricsToday.workout_min = min;
  (NS.metricsTodayNotes ||= {}).workout_min = type;
  toast(`${type} logged ✓`);
  renderToday();
}

// ── Tweak + macro classification helpers ──
function nTweakSeed() {
  const { meal } = NS.sheet || {};
  if (!meal) return;
  NS.sheet.basket = [];
  const comps = meal.recipe_id ? (NS.components || {})[meal.recipe_id] : null;
  if (comps && comps.length) {
    for (const c of comps) {
      const f = NS.foods.find(x => x.id === c.food_item_id);
      if (!f) continue;
      const qty = Math.round(c.qty * (meal.planned_servings || 1) * 100) / 100;
      NS.sheet.basket.push({ srcKind: 'f', srcId: f.id, kind: 'f', id: f.id, name: f.name,
        qty, kcal: f.kcal, protein_g: f.protein_g, carbs_g: f.carbs_g, fat_g: f.fat_g,
        unit: f.serving_desc, rest: false });
    }
  } else if (meal.food_item_id) {
    const f = NS.foods.find(x => x.id === meal.food_item_id);
    if (f) NS.sheet.basket.push({ srcKind: 'f', srcId: f.id, kind: 'f', id: f.id, name: f.name,
      qty: meal.planned_servings || 1, kcal: f.kcal, protein_g: f.protein_g,
      carbs_g: f.carbs_g, fat_g: f.fat_g, unit: f.serving_desc,
      rest: f.item_type === 'restaurant' });
  }
  renderNSheetList();
}
// Dominant calorie source: protein / carbs / fats (computed, nothing to maintain)
function nMacroClass(f) {
  const pk = 4 * (f.protein_g || 0), ck = 4 * (f.carbs_g || 0), fk = 9 * (f.fat_g || 0);
  if (pk >= ck && pk >= fk) return 'protein';
  if (ck >= fk) return 'carbs';
  return 'fats';
}
