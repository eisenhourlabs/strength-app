// ══════════════ Kardia Nutrition — Recipe Book (list + detail with this-week batch) ══════════════
// A browsable book of every active recipe: the standard card (ingredients, prep, portions,
// storage) plus a "this week's batch" section that scales pull quantities to the number of
// servings the current plan actually cooks. Loaded before n-week.js (boot).

let N_REC_SEL = null;   // selected recipe id (detail view) or null (list)
let N_REC_Q = '';       // list search query
let N_REC_FILTER = ''; // '', breakfast, lunch, dinner, keeper

function nRecById(id) { return (NS.recipes || []).find(r => r.id === id) || null; }
function nFoodById(id) { return (NS.foods || []).find(f => f.id === id) || null; }

// Total planned servings of a recipe across this plan week (both people), grouped by date.
function nRecipeWeekServings(id) {
  let total = 0; const byDate = {};
  for (const m of (NS.meals || [])) {
    if (m.recipe_id !== id) continue;
    const s = Number(m.planned_servings) || 0;
    total += s;
    byDate[m.meal_date] = (byDate[m.meal_date] || 0) + s;
  }
  return { total, byDate };
}

// Scale a food's serving_desc by a factor. "4 oz" -> "10 oz"; "1 medium" -> "3 medium";
// non-numeric like "1 slice (0.75 oz)" -> "3× 1 slice (0.75 oz)".
function nScaleServing(desc, factor) {
  const d = String(desc || '').trim();
  const m = d.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
  const f = Math.round(factor * 100) / 100;
  if (!m) return `${f}× ${d || 'serving'}`;
  const q = Math.round(parseFloat(m[1]) * factor * 100) / 100;
  const unit = m[2] || '';
  return `${q}${unit ? ' ' + unit : ''}`.trim();
}

// This week's batch: how many servings to cook + the per-ingredient amounts.
// Yield-aware: when a food carries a yield_factor (Phase 3), the pull list shows the RAW
// quantity to buy/thaw (cooked / yield) with the cooked amount for reference; until yield
// data exists the amount is the COOKED total, labelled as such — a cooked quantity is never
// silently presented as a raw "pull this much" (fixes F2). Includes freeze extras (A2).
function nRecipeBatchHtml(r) {
  const { total, byDate } = nRecipeWeekServings(r.id);
  // Freeze extras planned for this recipe this week, expressed in recipe-servings
  // via each portion's kcal / the recipe's per-serving kcal (honest for 60/40 sizes).
  const stock = Array.isArray(NS.planWeek && NS.planWeek.freezer_stock) ? NS.planWeek.freezer_stock : [];
  const perServ = Number(r.kcal_per_serving) || 0;
  let freezePortions = 0, freezeServings = 0;
  for (const e of stock) {
    if (e.recipe !== r.name) continue;
    const n = Number(e.portions) || 0;
    freezePortions += n;
    freezeServings += perServ ? n * ((Number(e.kcal) || perServ) / perServ) : n;
  }
  const grand = total + freezeServings;
  if (!grand) {
    return `<div class="n-panel"><div class="n-panel-title">📦 This week's batch</div>
      <div style="font-size:13px;color:var(--n-muted)">Not on this week's plan.</div></div>`;
  }
  const comps = (NS.components || {})[r.id] || [];
  let pulls = '', anyRaw = false, anyCookedOnly = false;
  for (const c of comps) {
    const f = nFoodById(c.food_item_id);
    if (!f) continue;
    const cookedFactor = grand * (Number(c.qty) || 0);
    const cooked = nScaleServing(f.serving_desc, cookedFactor);
    const yf = Number(f.yield_factor) || 0;
    let qtyHtml;
    if (yf > 0) {
      anyRaw = true;
      const raw = nScaleServing(f.serving_desc, cookedFactor / yf);
      qtyHtml = `<span class="n-rec-pullqty">${nEsc(raw)} raw</span>`
              + `<span style="margin-left:8px;color:var(--n-muted);font-size:11px">${nEsc(cooked)} cooked</span>`;
    } else {
      anyCookedOnly = true;
      qtyHtml = `<span class="n-rec-pullqty">${nEsc(cooked)} cooked</span>`;
    }
    pulls += `<div class="n-rec-pull"><span>${nEsc(f.name)}</span>${qtyHtml}</div>`;
  }
  const dates = Object.keys(byDate).sort()
    .map(d => `${nDayName(d, true)} (${Math.round(byDate[d] * 100) / 100}×)`).join(' · ');
  const breakdown = freezePortions
    ? `${Math.round(total * 100) / 100} for dinners${dates ? ' (' + dates + ')' : ''} + ${freezePortions} to freeze`
    : (dates || 'this week');
  const pullTitle = anyRaw ? 'Pull / buy (raw)' : 'Cook this much';
  const note = anyCookedOnly
    ? 'Amounts are COOKED totals — raw pull/purchase quantities appear once yield data is added (Phase 3).'
    : 'Raw amounts to pull/buy (cooked / yield); includes the portions you are freezing this block.';
  return `<div class="n-panel"><div class="n-panel-title">📦 This week's batch</div>
    <div class="n-rec-batchline">Cooking <b>${Math.round(grand * 100) / 100} servings</b> — ${nEsc(breakdown)}</div>
    ${pulls ? `<div style="font-size:11px;color:var(--n-muted);margin:4px 0 2px;text-transform:uppercase;letter-spacing:.04em">${pullTitle}</div><div class="n-rec-pulls">${pulls}</div>`
            : `<div style="font-size:12px;color:var(--n-muted)">Add a <code>Components:</code> line to this recipe for an exact pull list.</div>`}
    <div class="n-rec-pullnote">${note}</div></div>`;
}

function nRecipeDetailHtml(r) {
  const slots = (r.best_meal_slots || []).join(', ');
  const macro = `${Math.round(r.kcal_per_serving)} kcal · ${Math.round(r.protein_g_per_serving)}P · ${Math.round(r.carbs_g_per_serving)}C · ${Math.round(r.fat_g_per_serving)}F per serving`;
  const sec = (title, txt) => txt ? `<div class="n-panel"><div class="n-panel-title">${title}</div><pre>${nEsc(txt)}</pre></div>` : '';
  return `<button class="n-act small" onclick="N_REC_SEL=null;renderRecipes()">‹ All recipes</button>
    <div class="n-rec-detailhead">
      <div class="n-rec-title">${nEsc(r.name)}${r.is_keeper ? ' <span class="n-badge status">keeper</span>' : ''}</div>
      <div class="n-rec-macro">${macro}${r.servings_default ? ` · makes ${r.servings_default}` : ''}</div>
      ${slots ? `<div class="n-rec-slots">${nEsc(slots)}</div>` : ''}
    </div>
    ${r.description ? `<div class="n-rec-desc">${nEsc(r.description)}</div>` : ''}
    ${nRecipeBatchHtml(r)}
    ${sec('Ingredients', r.ingredients_text)}
    ${sec('Prep', r.prep_notes)}
    ${sec('Portions', r.portion_notes)}
    ${sec('Storage / freezing', r.storage_notes)}
    ${sec('Person fit', r.person_fit_notes)}`;
}

function nRecipeRowsHtml() {
  const q = N_REC_Q.toLowerCase();
  let recs = (NS.recipes || []).filter(r => r.kind !== 'assembly').slice().sort((a, b) => a.name.localeCompare(b.name));
  if (q) recs = recs.filter(r =>
    r.name.toLowerCase().includes(q) ||
    (r.tags || []).some(t => String(t).toLowerCase().includes(q)) ||
    (r.best_meal_slots || []).some(s => String(s).toLowerCase().includes(q)));
  if (N_REC_FILTER === 'keeper') recs = recs.filter(r => r.is_keeper);
  else if (N_REC_FILTER) recs = recs.filter(r => (r.best_meal_slots || []).includes(N_REC_FILTER));
  if (!recs.length) return `<div class="n-panel">No recipes match “${nEsc(N_REC_Q)}”.</div>`;
  return recs.map(r => {
    const slots = (r.best_meal_slots || []).join(', ');
    return `<div class="n-rec-row" onclick="N_REC_SEL='${r.id}';renderRecipes()">
      <div class="n-rec-rowmain">
        <div class="n-rec-rowname">${nEsc(r.name)}${r.is_keeper ? ' <span class="n-badge status">keeper</span>' : ''}</div>
        <div class="n-rec-rowsub">${nEsc(slots)}${slots ? ' · ' : ''}${Math.round(r.kcal_per_serving)} kcal · ${Math.round(r.protein_g_per_serving)}P</div>
      </div><span class="n-rec-chev">›</span></div>`;
  }).join('');
}

function nRecipeListHtml() {
  const chips = [['', 'All'], ['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['keeper', 'Keepers']]
    .map(([v, l]) => `<button class="n-chip${N_REC_FILTER === v ? ' active' : ''}" onclick="nRecipeSetFilter('${v}')">${l}</button>`).join('');
  return `<input type="text" class="n-search" placeholder="Search recipes…" value="${nEsc(N_REC_Q)}"
      oninput="N_REC_Q=this.value;nRecipeListRender()">
    <div class="n-rec-chips">${chips}</div>
    <div id="n-rec-list">${nRecipeRowsHtml()}</div>`;
}
function nRecipeSetFilter(v) { N_REC_FILTER = v; renderRecipes(); }

// Re-render only the list so the search box keeps focus between keystrokes.
function nRecipeListRender() {
  const list = document.getElementById('n-rec-list');
  if (list) list.innerHTML = nRecipeRowsHtml(); else renderRecipes();
}

function renderRecipes() {
  const body = document.getElementById('recipes-body');
  if (!body) return;
  const sub = document.getElementById('recipes-sub');
  if (sub) sub.textContent = N_REC_SEL ? 'recipe detail' : `${(NS.recipes || []).filter(r => r.kind !== 'assembly').length} recipes`;
  if (N_REC_SEL) {
    const r = nRecById(N_REC_SEL);
    if (r) { body.innerHTML = nRecipeDetailHtml(r); return; }
    N_REC_SEL = null;
  }
  body.innerHTML = nRecipeListHtml();
}

// Deep-link helper: open a recipe by id (used by tappable meal names).
function nOpenRecipe(id) {
  if (typeof nIsAssemblyRecipe === 'function' && nIsAssemblyRecipe(id)) return;
  nShowTab('recipes');
  N_REC_SEL = id;
  renderRecipes();
}

// Deep-link helper: open a recipe by exact library name (used by prep links).
function nOpenRecipeByName(name) {
  const r = (NS.recipes || []).find(x => x.name === name);
  nShowTab('recipes');
  N_REC_SEL = r ? r.id : null;
  renderRecipes();
}
