// ══════════════ Kardia Nutrition — Recipe Book (list + detail with this-week batch) ══════════════
// A browsable book of every active recipe: the standard card (ingredients, prep, portions,
// storage) plus a "this batch" card PER COOK that scales pull quantities to the servings that
// one cook actually makes (a recipe cooked twice in a week gets two cards). Loaded before
// n-week.js (boot).

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
  const fm = d.match(/^(\d+)\/(\d+)\s*(.*)$/);   // "1/4 cup" -> 0.25 cup
  if (fm) {
    const q = Math.round((parseInt(fm[1], 10) / parseInt(fm[2], 10)) * factor * 100) / 100;
    return `${q}${fm[3] ? ' ' + fm[3] : ''}`.trim();
  }
  const m = d.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
  const f = Math.round(factor * 100) / 100;
  if (!m) return `${f}× ${d || 'serving'}`;
  const q = Math.round(parseFloat(m[1]) * factor * 100) / 100;
  const unit = m[2] || '';
  return `${q}${unit ? ' ' + unit : ''}`.trim();
}

// This batch — speaks in CONTAINERS and BATCH MULTIPLES, not raw serving math.
// A recipe is calibrated as one standard batch (Servings: 7.5 = 3 Troy + 3 Amanda containers,
// Troy container = 1.5 servings). One planned meal row = one container. Freezer portions add
// to what gets cooked. The pull list scales each ingredient to the total cook (raw where yield
// data exists) so the user knows exactly what to buy; the Ingredients panel stays one batch.
function nNiceServing(desc, factor) {
  const d = String(desc || '').trim();
  let m = d.match(/^(\d+)\/(\d+)\s*(.*)$/), val, unit;
  if (m) { val = parseInt(m[1], 10) / parseInt(m[2], 10); unit = m[3] || ''; }
  else {
    m = d.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
    if (!m) return `${Math.round(factor * 100) / 100}\u00d7 ${d || 'serving'}`;
    val = parseFloat(m[1]); unit = m[2] || '';
  }
  let q = val * factor;
  q = q >= 10 ? Math.round(q) : q >= 3 ? Math.round(q * 2) / 2 : Math.round(q * 4) / 4;
  let s = `${q}${unit ? ' ' + unit : ''}`.trim();
  if (/^oz\b/.test(unit) && q >= 16) s += ` (${Math.round(q / 16 * 10) / 10} lb)`;
  return s;
}

// Ounce readout for foods the household puts on the kitchen scale — the `entry_oz`
// foods (potatoes, sweet potatoes, rice) whose library serving is a COUNT ("1 medium").
// Nobody cooks "4 medium potatoes"; they weigh out 24 oz. Foods whose serving is already
// oz-denominated ("4 oz") need nothing, and counted foods (eggs, scoops, tortillas,
// patties) are deliberately excluded — nOzPerServing returns null for those.
// "45 oz (2.8 lb)" — ounces are the kitchen-scale unit; pounds appear once it's shop-sized.
function nOzLbl(g) {
  const oz = g / 28.3495;
  const shown = oz >= 10 ? Math.round(oz) : Math.round(oz * 10) / 10;
  return `${shown} oz` + (oz >= 16 ? ` (${Math.round(oz / 16 * 10) / 10} lb)` : '');
}

function nBatchOzNote(f, factor) {
  if (typeof nOzPerServing !== 'function') return '';
  const ozPer = nOzPerServing(f);
  if (!ozPer) return '';
  if (/^\d+(?:\.\d+)?\s*oz\b/i.test(String(f.serving_desc || ''))) return '';
  const oz = ozPer * factor;
  if (!(oz > 0)) return '';
  let s = `${oz >= 10 ? Math.round(oz) : Math.round(oz * 10) / 10} oz`;
  if (oz >= 16) s += ` / ${Math.round(oz / 16 * 10) / 10} lb`;
  return s;
}

// ── Cooks (Troy, 2026-09-20) ──
// The batch card must say what to cook in ONE cook, not the week's total. Most recipes are
// cooked once a week, so one cook = the whole week and nothing looks different. But salmon
// night is cooked fresh twice (Sat and Tue), and a card that pooled both told you to cook
// double on each night. A "cook" is a date the recipe is actually cooked:
//   1. any dated prep block whose text names the recipe (same exact-name match as
//      nPrepRecipeLinks / nPrepBatchCardsHtml),
//   2. any date it is eaten FRESH (planned meal with is_leftover = false — a fresh-cooked
//      dinner IS a cook, even when no prep block names it),
//   3. the weekday a freezer_stock entry for it belongs to (block 'wed' / 'sun' / 'salmon_sat').
// Each planned meal then belongs to the latest cook on or before its date, so a batch
// cooked Wed and eaten Wed-Fri stays ONE cook, while Sat and Tue salmon are two. Leftover
// meals that pre-date every cook this week come from an earlier week's batch and are not
// part of any cook here. Freezer portions ride on the cook that makes them.
// If nothing dates a cook (no block names it, nothing eaten fresh) the whole week is treated
// as one cook — the pre-2026-09-20 behaviour — flagged `assumed` so the card omits a date.
function nCookWhen(d) { return `${nDayName(d, true)} ${+d.slice(5, 7)}/${+d.slice(8, 10)}`; }

function nRecipeCooks(r) {
  const meals = (NS.meals || []).filter(m => m.recipe_id === r.id);
  const stock = (Array.isArray(NS.planWeek && NS.planWeek.freezer_stock) ? NS.planWeek.freezer_stock : [])
    .filter(e => e.recipe === r.name && (Number(e.portions) || 0) > 0);
  const weekDates = [];
  for (let i = 0; i < 7; i++) weekDates.push(nAddDays(NS.weekOf, i));
  const abbr = d => nDayName(d, true).toLowerCase();
  const stockDate = e => {
    const k = String(e.block || '').toLowerCase();
    return weekDates.find(d => k === abbr(d) || k.endsWith('_' + abbr(d))) || null;
  };
  const dates = new Set();
  const nm = String(r.name || '').toLowerCase();
  if (nm && typeof nPrepBlocks === 'function') {
    for (const b of nPrepBlocks().dated)
      if ((b.head + '\n' + b.steps.join('\n')).toLowerCase().includes(nm)) dates.add(b.date);
  }
  for (const m of meals) if (!m.is_leftover) dates.add(m.meal_date);
  for (const e of stock) { const d = stockDate(e); if (d) dates.add(d); }
  let assumed = false;
  if (!dates.size && (meals.length || stock.length)) {
    assumed = true;
    dates.add(meals.map(m => m.meal_date).sort()[0] || NS.weekOf);
  }
  const cooks = [...dates].sort().map(d => ({ date: d, assumed, meals: [], stock: [] }));
  for (const m of meals) {
    let hit = null;
    for (const c of cooks) if (c.date <= m.meal_date) hit = c;
    if (hit) hit.meals.push(m);
  }
  for (const e of stock) {
    const d = stockDate(e);
    (cooks.find(c => c.date === d) || cooks[0]).stock.push(e);
  }
  return cooks;
}

// One cook's card. `idx`/`count` say which of the recipe's cooks this is (for the title).
function nCookCardHtml(r, labelName, cook, idx, count) {
  const title = '📦 ' + (count > 1 ? `Batch ${idx + 1} of ${count}` : 'This batch')
    + (labelName ? ` — ${nEsc(labelName)}` : '')
    + (cook.assumed ? '' : ` · cook ${nCookWhen(cook.date)}`);
  // Planned servings and containers for THIS cook only. One planned meal row = one container.
  let total = 0; const byDate = {}; const perAth = {};
  for (const m of cook.meals) {
    const s = Number(m.planned_servings) || 0;
    total += s;
    byDate[m.meal_date] = (byDate[m.meal_date] || 0) + s;
    const a = (NS.household || []).find(h => h.id === m.athlete_id);
    const nm = (a && a.name) || 'planned';
    perAth[nm] = (perAth[nm] || 0) + 1;
  }
  // Freezer portions this cook makes.
  const perServ = Number(r.kcal_per_serving) || 0;
  let freezeServings = 0; const freezeParts = [];
  for (const e of cook.stock) {
    const n = Number(e.portions) || 0;
    if (!n) continue;
    freezeParts.push(`${n} ${e.athlete || ''}`.trim());
    freezeServings += perServ ? n * ((Number(e.kcal) || perServ) / perServ) : n;
  }
  const grand = total + freezeServings;
  if (!grand) {
    return `<div class="n-panel"><div class="n-panel-title">${title}</div>
      <div style="font-size:13px;color:var(--n-muted)">No servings planned from this cook.</div></div>`;
  }
  const days = Object.keys(byDate).sort().map(d => nDayName(d, true)).join(' · ');
  const dinnerBits = Object.entries(perAth).map(([nm, c]) => `${c} ${nm}`).join(' + ');
  let makes = dinnerBits ? `${dinnerBits} dinner containers${days ? ' (' + days + ')' : ''}` : '';
  if (freezeParts.length) makes += `${makes ? ' + ' : ''}${freezeParts.join(' + ')} freezer portion${freezeServings > 1 ? 's' : ''}`;
  const batches = Number(r.servings_default) ? grand / Number(r.servings_default) : 1;
  const cookLine = Math.abs(batches - 1) <= 0.05
    ? `<b>one standard batch</b> — the Ingredients list below is exactly what to buy`
    : `<b>≈${Math.round(batches * 20) / 20}× the standard batch</b> — buy the amounts below (the Ingredients list covers a single batch)`;
  // Every quantity here is what you BUY AND COOK WITH — raw weight (or dry, for rice and
  // other goods that gain weight cooking). Troy, 2026-09-12: the batch card and the prep
  // plan always speak raw; only the food picker speaks cooked. Library macros are stated on
  // the cooked basis, so raw = cooked ÷ yield_factor; a food with no yield_factor is eaten
  // as purchased and needs no conversion.
  const comps = (NS.components || {})[r.id] || [];
  let pulls = '', anyConv = false;
  for (const c of comps) {
    const f = nFoodById(c.food_item_id);
    if (!f) continue;
    const cookedFactor = grand * (Number(c.qty) || 0);
    const yf = Number(f.yield_factor) || 0;
    const grams = Number(f.grams_per_serving) || 0;
    const countUnit = !/^\d+(?:\.\d+)?\s*oz\b/i.test(String(f.serving_desc || ''));
    let primary, secondary = '';
    if (yf > 0 && Math.abs(yf - 1) > 0.01) {
      anyConv = true;
      const word = yf > 1 ? 'dry' : 'raw';   // yield > 1 = absorbs water (rice, pasta, oats)
      if (grams) {
        primary = `${nOzLbl(cookedFactor * grams / yf)} ${word}`;
        const bits = [];
        if (countUnit) bits.push('≈' + nNiceServing(f.serving_desc, cookedFactor));
        bits.push(`${nOzLbl(cookedFactor * grams)} cooked`);
        secondary = bits.join(' · ');
      } else {
        primary = `${nNiceServing(f.serving_desc, cookedFactor / yf)} ${word}`;
        secondary = `≈${nNiceServing(f.serving_desc, cookedFactor)} cooked`;
      }
    } else {
      // Eaten as purchased — the amount IS the buy amount. Add ounces for anything the
      // household weighs rather than counts.
      primary = nNiceServing(f.serving_desc, cookedFactor);
      const ozNote = nBatchOzNote(f, cookedFactor);
      if (ozNote) secondary = `= ${ozNote}`;
    }
    pulls += `<div class="n-rec-pull"><span>${nEsc(f.name)}</span>`
           + `<span class="n-rec-pullqty">${nEsc(primary)}</span>`
           + (secondary ? `<span style="margin-left:8px;color:var(--n-muted);font-size:11px">${nEsc(secondary)}</span>` : '')
           + `</div>`;
  }
  const note = 'Buy / pull amounts — raw weight (dry for rice), the way you shop and cook. '
    + (anyConv ? 'Cooked weight in grey; the food picker logs cooked. ' : '')
    + 'Includes any freezer portions.'
    + (count > 1 ? ` This recipe is cooked ${count} separate times this week \u2014 this card is the ${nCookWhen(cook.date)} cook only.` : '');
  return `<div class="n-panel"><div class="n-panel-title">${title}</div>
    <div class="n-rec-batchline"><b>Makes:</b> ${nEsc(makes)}</div>
    <div class="n-rec-batchline"><b>Cook:</b> ${cookLine}</div>
    ${pulls ? `<div style="font-size:11px;color:var(--n-muted);margin:4px 0 2px;text-transform:uppercase;letter-spacing:.04em">Buy / pull for this cook</div><div class="n-rec-pulls">${pulls}</div>`
            : `<div style="font-size:12px;color:var(--n-muted)">Add a <code>Components:</code> line to this recipe for an exact pull list.</div>`}
    <div class="n-rec-pullnote">${note}</div></div>`;
}

// Batch card(s) for a recipe. With `atDate` (a prep block's date) it renders just the cook on
// that date; without it (recipe detail page) it renders one card per cook this week, in
// date order — so a recipe cooked twice shows two separate cards.
function nRecipeBatchHtml(r, labelName, atDate) {
  const cooks = nRecipeCooks(r);
  if (!cooks.length) {
    const title = '📦 This batch' + (labelName ? ` — ${nEsc(labelName)}` : '');
    return `<div class="n-panel"><div class="n-panel-title">${title}</div>
      <div style="font-size:13px;color:var(--n-muted)">Not on this week's plan.</div></div>`;
  }
  let pick = cooks.map((c, i) => [c, i]);
  if (atDate) {
    const m = pick.filter(([c]) => c.date === atDate);
    if (m.length) pick = m;
  }
  return pick.map(([c, i]) => nCookCardHtml(r, labelName, c, i, cooks.length)).join('');
}

// Batch cards for one day of the Week tab, rendered ABOVE the prep plan (Troy, 2026-09-12).
// The batch card owns "what this cook makes / what to pull"; the prep block is then free to be
// nothing but steps (see N07 §1b). Each card is the recipe's cook ON THAT DATE only (2026-09-20).
// Recipes come from two places: (1) exact library names appearing in the day's prep block —
// same matching as nPrepRecipeLinks — and (2) any recipe eaten FRESH that day, even when no
// prep block names it (salmon night is cooked fresh on Sat and Tue with no prep block, and
// still has to say how much to cook). `blk` may be null on a day with no prep block.
function nPrepBatchCardsHtml(blk, date) {
  if (typeof nRecipeBatchHtml !== 'function') return '';
  const day = date || (blk && blk.date);
  const seen = {}; const hits = [];
  if (blk) {
    const txt = (blk.head + '\n' + blk.steps.join('\n')).toLowerCase();
    for (const r of (NS.recipes || [])) {
      if (!r.name || r.kind === 'assembly' || seen[r.id]) continue;
      if (!txt.includes(r.name.toLowerCase())) continue;
      seen[r.id] = true; hits.push(r);
    }
  }
  if (day) {
    for (const r of (NS.recipes || [])) {
      if (!r.name || r.kind === 'assembly' || seen[r.id]) continue;
      if (!(NS.meals || []).some(m => m.recipe_id === r.id && m.meal_date === day && !m.is_leftover)) continue;
      seen[r.id] = true; hits.push(r);
    }
  }
  return hits.map(r => nRecipeBatchHtml(r, r.name, day)).join('');
}

// Prep is authored as one line of numbered steps ("1) ... 2) ..."); break each step onto its own line.
function nPrepSteps(txt) { return String(txt || '').replace(/\s+(?=\d+\))/g, '\n'); }

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
    ${sec('Ingredients (one standard batch)', r.ingredients_text)}
    ${sec('Prep', nPrepSteps(r.prep_notes))}
    ${sec('Portions', r.portion_notes)}
    ${sec('Storage / freezing', r.storage_notes)}`;
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
