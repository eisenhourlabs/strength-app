// ══════════════ Kardia Nutrition — Recipe Book (list + detail with this-week batch) ══════════════
// A browsable book of every active recipe: the standard card (ingredients, prep, portions,
// storage) plus a "this week's batch" section that scales pull quantities to the number of
// servings the current plan actually cooks. Loaded before n-week.js (boot).

let N_REC_SEL = null;   // selected recipe id (detail view) or null (list)
let N_REC_Q = '';       // list search query

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

// "Pull / cook this much" list for the current week's batch of a recipe.
function nRecipeBatchHtml(r) {
  const { total, byDate } = nRecipeWeekServings(r.id);
  if (!total) {
    return `<div class="n-panel"><div class="n-panel-title">📦 This week's batch</div>
      <div style="font-size:13px;color:var(--n-muted)">Not on this week's plan.</div></div>`;
  }
  const comps = (NS.components || {})[r.id] || [];
  let pulls = '';
  for (const c of comps) {
    const f = nFoodById(c.food_item_id);
    if (!f) continue;
    const amount = nScaleServing(f.serving_desc, total * (Number(c.qty) || 0));
    pulls += `<div class="n-rec-pull"><span>${nEsc(f.name)}</span><span class="n-rec-pullqty">${nEsc(amount)}</span></div>`;
  }
  const dates = Object.keys(byDate).sort()
    .map(d => `${nDayName(d, true)} (${Math.round(byDate[d] * 100) / 100}×)`).join(' · ');
  return `<div class="n-panel"><div class="n-panel-title">📦 This week's batch</div>
    <div class="n-rec-batchline">Cooking <b>${Math.round(total * 100) / 100} servings</b> — ${nEsc(dates)}</div>
    ${pulls ? `<div class="n-rec-pulls">${pulls}</div>`
            : `<div style="font-size:12px;color:var(--n-muted)">Add a <code>Components:</code> line to this recipe for an exact pull list.</div>`}
    <div class="n-rec-pullnote">Scaled from the plan's servings — add any extras to freeze on top of this.</div></div>`;
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
  let recs = (NS.recipes || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (q) recs = recs.filter(r =>
    r.name.toLowerCase().includes(q) ||
    (r.tags || []).some(t => String(t).toLowerCase().includes(q)) ||
    (r.best_meal_slots || []).some(s => String(s).toLowerCase().includes(q)));
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
  return `<input type="text" class="n-search" placeholder="Search recipes…" value="${nEsc(N_REC_Q)}"
      oninput="N_REC_Q=this.value;nRecipeListRender()">
    <div id="n-rec-list">${nRecipeRowsHtml()}</div>`;
}

// Re-render only the list so the search box keeps focus between keystrokes.
function nRecipeListRender() {
  const list = document.getElementById('n-rec-list');
  if (list) list.innerHTML = nRecipeRowsHtml(); else renderRecipes();
}

function renderRecipes() {
  const body = document.getElementById('recipes-body');
  if (!body) return;
  const sub = document.getElementById('recipes-sub');
  if (sub) sub.textContent = N_REC_SEL ? 'recipe detail' : `${(NS.recipes || []).length} recipes`;
  if (N_REC_SEL) {
    const r = nRecById(N_REC_SEL);
    if (r) { body.innerHTML = nRecipeDetailHtml(r); return; }
    N_REC_SEL = null;
  }
  body.innerHTML = nRecipeListHtml();
}

// Deep-link helper: open a recipe by exact library name (used by prep links).
function nOpenRecipeByName(name) {
  const r = (NS.recipes || []).find(x => x.name === name);
  nShowTab('recipes');
  N_REC_SEL = r ? r.id : null;
  renderRecipes();
}
