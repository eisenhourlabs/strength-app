// ══════════════ Kardia Nutrition — Today screen + logging + picker sheet ══════════════

const N_STATUS_LABEL = {
  as_planned: '✓ ate as planned', swapped: '⇄ swapped', skipped: 'skipped',
  ate_out: '🍴 ate out', added: '+ added',
};
const N_PORTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

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
    html += nBudgetHtml(dateStr);
  }

  const meals = inWeek ? nMyMeals(dateStr) : [];
  if (!meals.length && inWeek) {
    html += `<div class="n-panel">No meals planned for today${NS.planWeek ? '' : ' — the week hasn’t been pushed'}.</div>`;
  }
  for (const m of meals) html += nMealCardHtml(m);

  // Added (unplanned) items today
  const added = NS.addedLogs.filter(l => l.log_date === dateStr);
  if (added.length) {
    html += `<div class="n-sheet-section" style="margin-top:14px">Added today</div>`;
    for (const l of added) {
      html += `<div class="n-meal done"><div class="n-meal-top">
        <span class="n-meal-slot">extra</span>
        <span class="n-meal-kcal">${l.actual_kcal ?? '?'} kcal · ${l.actual_protein_g ?? '?'}P</span></div>
        <div class="n-meal-name">${nEsc(nLogName(l) || 'Added item')}</div></div>`;
    }
  }

  html += `<button class="n-act" style="width:100%;margin-top:10px" onclick="openNSheet('add', null)">+ Add food</button>`;
  body.innerHTML = html;
}

// ── Budget header ──
function nBudgetHtml(dateStr) {
  const t = NS.target;
  if (!t) return `<div class="n-panel">No targets pushed for this week yet.</div>`;
  const { kcal, protein, approx } = nDayTotals(dateStr);
  const pct = Math.min(100, Math.round(100 * kcal / t.kcal_target));
  const over = kcal > t.kcal_target;
  const remaining = t.kcal_target - kcal;
  const pRemain = Math.max(0, t.protein_g_low - protein);
  const tilde = approx ? '~' : '';
  let hint = '';
  if (over && remaining < -150)
    hint = `<div class="n-budget-hint">running ~${-remaining} over — go lighter on the next meal, then back to plan (no compensating)</div>`;
  return `<div class="n-budget">
    <div class="n-budget-kcal"><span>${tilde}${kcal.toLocaleString()} / ${t.kcal_target.toLocaleString()} kcal</span>
      <span>${NS.me.name}</span></div>
    <div class="n-budget-bar"><div class="n-budget-fill${over ? ' over' : ''}" style="width:${pct}%"></div></div>
    <div class="n-budget-sub"><span>Protein ${tilde}${protein} / ${t.protein_g_low}–${t.protein_g_high} g</span>
      <span>${nEsc(t.notes || '')}</span></div>
    <div class="n-budget-remaining">Remaining today: <b>${remaining > 0 ? '~' + remaining.toLocaleString() + ' kcal' : 'at target'}</b>
      ${pRemain > 0 ? ` · ~${pRemain} g protein to floor` : ' · protein floor met ✓'}</div>
    ${hint}</div>`;
}

// ── Prompt cards (weigh-in / measurements) ──
function nWeighInDueToday() {
  const days = NS.settings?.weigh_in_days || [];
  const short = nDayName(nToday(), true);   // e.g. "Mon"
  return days.includes(short) && NS.metricsToday.weight == null && !NS.dismissed.weight;
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
    const statusTxt = N_STATUS_LABEL[log.status] || log.status;
    const kcalTxt = log.actual_kcal != null ? `${log.actual_kcal} kcal · ${log.actual_protein_g}P` : 'not quantified';
    const showChips = log.status !== 'skipped';
    return `<div class="n-meal ${log.status === 'skipped' ? 'skipped' : 'done'}">
      <div class="n-meal-top"><span class="n-meal-slot">${slotLabel}</span>
        <span class="n-meal-kcal">${kcalTxt}</span></div>
      <div class="n-meal-name">${nEsc(name)}</div>
      ${ate && log.status !== 'as_planned' ? `<div class="n-meal-portion">→ ${nEsc(ate)}</div>` : ''}
      <div class="n-meal-badges"><span class="n-badge status">${statusTxt}${log.portion_modifier !== 1 ? ` · ${log.portion_modifier}×` : ''}</span>${badges}</div>
      ${showChips ? `<div class="n-portion-chips">${N_PORTIONS.map(p =>
        `<button class="n-chip${log.portion_modifier === p ? ' active' : ''}" onclick="pickPortion('${m.id}',${p})">${p}×</button>`).join('')}</div>` : ''}
      <div class="n-meal-actions" style="margin-top:8px">
        <button class="n-act small" onclick="reopenMeal('${m.id}')">Edit</button>
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
      <button class="n-act" onclick="openNSheet('ate_out','${m.id}')">Out</button>
    </div></div>`;
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
  renderToday();
}

// ── Picker sheet (swap / ate_out / add) ──
function openNSheet(mode, mealId) {
  NS.sheet = { mode, meal: mealId ? nFindMeal(mealId) : null };
  document.getElementById('n-sheet-title').textContent =
    mode === 'swap' ? 'Swap meal' : mode === 'ate_out' ? 'Ate out — what was it?' : 'Add food';
  document.getElementById('n-sheet-search').value = '';
  document.getElementById('n-custom-desc').value = '';
  document.getElementById('n-custom-kcal').value = '';
  document.getElementById('n-custom-protein').value = '';
  document.getElementById('n-sheet').style.display = 'flex';
  renderNSheetList();
}
function closeNSheet() {
  document.getElementById('n-sheet').style.display = 'none';
  NS.sheet = null;
}

function nDeltaHtml(kcal, protein) {
  const m = NS.sheet?.meal;
  if (!m) return '';
  const dk = Math.round(kcal - m.planned_kcal);
  const dp = Math.round(protein - m.planned_protein_g);
  return `<div class="n-opt-delta">${dk >= 0 ? '+' : ''}${dk} kcal · ${dp >= 0 ? '+' : ''}${dp}P vs planned</div>`;
}
function nOptHtml(arg, name, sub, kcal, protein) {
  return `<button class="n-opt" onclick='pickNOption(${JSON.stringify(arg)})'>
    <div class="n-opt-name">${nEsc(name)}</div>
    <div class="n-opt-sub">${nEsc(sub)}</div>
    ${nDeltaHtml(kcal, protein)}</button>`;
}

function renderNSheetList() {
  const q = document.getElementById('n-sheet-search').value.trim().toLowerCase();
  const { mode, meal } = NS.sheet || {};
  const slot = meal?.meal_slot;
  let html = '';

  // 1. Coach alternates (swap mode only)
  if (mode === 'swap' && meal && (NS.alternates[meal.id] || []).length) {
    html += `<div class="n-sheet-section">★ Coach alternates</div>`;
    for (const a of NS.alternates[meal.id]) {
      const name = a.recipe_id ? (NS.recipes.find(r => r.id === a.recipe_id)?.name || 'Recipe')
                               : (NS.foods.find(f => f.id === a.food_item_id)?.name || 'Food');
      if (q && !name.toLowerCase().includes(q)) continue;
      html += nOptHtml(
        { recipe_id: a.recipe_id, food_item_id: a.food_item_id, kcal: a.kcal, protein_g: a.protein_g, carbs_g: a.carbs_g, fat_g: a.fat_g },
        `★ ${name}`, `${Math.round(a.kcal)} kcal · ${Math.round(a.protein_g)}P${a.note ? ' — ' + a.note : ''}`,
        a.kcal, a.protein_g);
    }
  }

  // 2. Library (recipes + non-restaurant foods), slot-filtered unless searching
  if (mode !== 'ate_out') {
    html += `<div class="n-sheet-section">From the library</div>`;
    const recs = NS.recipes.filter(r =>
      (q ? r.name.toLowerCase().includes(q) : (!slot || (r.best_meal_slots || []).includes(slot))));
    const fds = NS.foods.filter(f => f.item_type !== 'restaurant' &&
      (q ? f.name.toLowerCase().includes(q) : (!slot || (f.default_meal_slots || []).includes(slot))));
    for (const r of recs.slice(0, 30))
      html += nOptHtml(
        { recipe_id: r.id, kcal: r.kcal_per_serving, protein_g: r.protein_g_per_serving, carbs_g: r.carbs_g_per_serving, fat_g: r.fat_g_per_serving },
        r.name, `${Math.round(r.kcal_per_serving)} kcal · ${Math.round(r.protein_g_per_serving)}P per serving`,
        r.kcal_per_serving, r.protein_g_per_serving);
    for (const f of fds.slice(0, 30))
      html += nOptHtml(
        { food_item_id: f.id, kcal: f.kcal, protein_g: f.protein_g, carbs_g: f.carbs_g, fat_g: f.fat_g },
        f.name, `${Math.round(f.kcal)} kcal · ${Math.round(f.protein_g)}P — ${f.serving_desc}`,
        f.kcal, f.protein_g);
  }

  // 3. Restaurants, grouped
  const rests = NS.foods.filter(f => f.item_type === 'restaurant' &&
    (!q || f.name.toLowerCase().includes(q) || (f.restaurant_name || '').toLowerCase().includes(q)));
  if (rests.length) {
    const groups = {};
    for (const f of rests) (groups[f.restaurant_name || 'Restaurants'] ||= []).push(f);
    for (const [rn, items] of Object.entries(groups)) {
      html += `<div class="n-sheet-section">🍴 ${nEsc(rn)}</div>`;
      for (const f of items) {
        const rec = (f.tags || []).includes('recommended');
        html += nOptHtml(
          { food_item_id: f.id, kcal: f.kcal, protein_g: f.protein_g, carbs_g: f.carbs_g, fat_g: f.fat_g },
          `${rec ? '✦ ' : ''}${f.name}`, `${Math.round(f.kcal)} kcal · ${Math.round(f.protein_g)}P — ${f.serving_desc}`,
          f.kcal, f.protein_g);
      }
    }
  }

  document.getElementById('n-sheet-list').innerHTML = html || '<div class="n-opt-sub" style="padding:12px">No matches.</div>';
}

async function pickNOption(src) {
  const { mode, meal } = NS.sheet || {};
  try {
    if (mode === 'add' || !meal) {
      await nLogAdded(nToday(), src);
    } else {
      const status = mode === 'ate_out' ? 'ate_out' : 'swapped';
      await nLogMeal(meal, status, src, 1.0);
    }
    closeNSheet(); toast('Logged ✓'); renderToday();
  } catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}

async function submitCustomFood() {
  const desc = document.getElementById('n-custom-desc').value.trim();
  if (!desc) { toast('Describe what you ate'); return; }
  const kcal = parseFloat(document.getElementById('n-custom-kcal').value) || null;
  const protein = parseFloat(document.getElementById('n-custom-protein').value) || null;
  const src = { desc, kcal, protein_g: protein, carbs_g: null, fat_g: null };
  const { mode, meal } = NS.sheet || {};
  try {
    if (mode === 'add' || !meal) await nLogAdded(nToday(), src);
    else await nLogMeal(meal, mode === 'swap' ? 'swapped' : 'ate_out', kcal != null ? src : { ...src, kcal: null }, 1.0);
    closeNSheet(); toast(kcal != null ? 'Logged ✓' : 'Logged (unquantified) — day totals show ~', 3000);
    renderToday();
  } catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}
