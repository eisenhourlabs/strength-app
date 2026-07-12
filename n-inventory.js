// ══════════════ Kardia Nutrition — Freezer Inventory (per-person backup dinners) ══════════════
// Cooked single-meal portions set aside on prep nights (target ~12 per person).
// Shared list — both see both people's stock; each person "Use"s their OWN portion,
// which logs it as today's dinner and decrements the count. On prep nights the coach's
// planned freezes appear as confirm cards ("how many did you set aside?").
// Distinct from n-freezer.js (raw-meat thaw nudges). Loaded before n-week.js (boot).

const N_INV_TARGET = 12;

function nInvRows() { return (NS.freezerInventory || []).filter(r => (r.portions || 0) > 0); }
function nInvForAthlete(aid) {
  return nInvRows().filter(r => r.athlete_id === aid)
    .sort((a, b) => String(a.frozen_on || '').localeCompare(String(b.frozen_on || '')));
}
function nInvCount(aid) { return nInvForAthlete(aid).reduce((s, r) => s + (r.portions || 0), 0); }

// The inventory panel. interactive=true shows "Use" on the current user's own rows.
function nInvPanelHtml(interactive) {
  const anyRows = nInvRows().length;
  if (!anyRows) {
    if (!interactive) return '';
    const summary = (NS.household || []).map(a => `${nEsc(a.name)} ${nInvCount(a.id)}/${N_INV_TARGET}`).join(' · ');
    return `<div class="n-panel"><div class="n-panel-title">🧊 Freezer inventory</div>
      <div class="n-inv-empty">Building up backup dinners — target ${N_INV_TARGET} each. ${summary}</div></div>`;
  }
  let body = '';
  for (const a of (NS.household || [])) {
    const mine = a.id === NS.me.id;
    const items = nInvForAthlete(a.id);
    body += `<div class="n-inv-person"><b>${nEsc(a.name)}</b> <span class="n-inv-count">${nInvCount(a.id)}/${N_INV_TARGET}</span></div>`;
    if (!items.length) { body += `<div class="n-inv-empty">— empty —</div>`; continue; }
    for (const r of items) {
      const macro = r.kcal != null ? `· ${Math.round(r.kcal)} kcal` : '';
      const use = (interactive && mine)
        ? `<button class="n-act small primary" onclick="nInvUse('${r.id}')">Use</button>` : '';
      body += `<div class="n-inv-item">
        <span class="n-inv-qty">${r.portions}×</span>
        <span class="n-inv-name">${nEsc(r.recipe_name)}<span class="n-inv-sub"> · ${nEsc(nDayName(r.frozen_on, true))} ${macro}</span></span>
        ${use}</div>`;
    }
  }
  return `<div class="n-panel"><div class="n-panel-title">🧊 Freezer inventory</div>${body}</div>`;
}
function nInvWeekHtml() { return nInvPanelHtml(false); }

// Use one of MY frozen portions: log it as today's dinner and decrement the count.
async function nInvUse(id) {
  if (nOffline) { toast('Offline — reconnect to use freezer stock.', 3000); return; }
  const row = (NS.freezerInventory || []).find(x => x.id === id);
  if (!row) return;
  const today = nToday();
  const src = {
    recipe_id: row.recipe_id || null,
    kcal: row.kcal, protein_g: row.protein_g, carbs_g: row.carbs_g, fat_g: row.fat_g,
    desc: row.recipe_id ? null : `Freezer: ${row.recipe_name}`,
  };
  try {
    const dinners = nMyMeals(today).filter(m => m.meal_slot === 'dinner' && !NS.logs[m.id]);
    if (dinners.length) await nLogMeal(dinners[0], 'swapped', src);
    else await nLogAdded(today, { ...src, desc: src.desc || `Freezer: ${row.recipe_name}` });
  } catch (e) { toast('Could not log — try again.', 3000); return; }

  const left = (row.portions || 1) - 1;
  if (left <= 0) {
    const { error } = await ndb.from('freezer_inventory').delete().eq('id', id);
    if (error) toast('Logged, but inventory update failed', 3000);
    NS.freezerInventory = (NS.freezerInventory || []).filter(x => x.id !== id);
  } else {
    const { error } = await ndb.from('freezer_inventory').update({ portions: left }).eq('id', id);
    if (error) toast('Logged, but inventory update failed', 3000); else row.portions = left;
  }
  if (typeof renderToday === 'function') renderToday();
  toast('Logged from freezer ✓');
}

// ── Prep-night "set aside to freeze" confirm cards ──
// Reads the coach's freezer_stock plan for today's block; hides entries already
// stocked this plan week so it doesn't nag after you've confirmed.
function nAthleteIdByName(name) {
  const a = (NS.household || []).find(x => (x.name || '').toLowerCase() === String(name || '').toLowerCase());
  return a ? a.id : null;
}
function nStockAlreadyDone(entry, aid) {
  return (NS.freezerInventory || []).some(r =>
    r.plan_week_id === (NS.planWeek && NS.planWeek.id) &&
    r.athlete_id === aid && r.recipe_name === entry.recipe);
}
function nFreezerStockDue() {
  const day = nDayName(nToday(), true);
  const block = day === 'Wed' ? 'wed' : day === 'Sun' ? 'sun' : null;
  if (!block || !NS.planWeek) return [];
  const stock = Array.isArray(NS.planWeek.freezer_stock) ? NS.planWeek.freezer_stock : [];
  return stock.filter(e => e.block === block)
    .map(e => ({ ...e, _aid: nAthleteIdByName(e.athlete) }))
    .filter(e => e._aid && !nStockAlreadyDone(e, e._aid));
}
function nFreezerStockCardsHtml() {
  const due = nFreezerStockDue();
  NS._stockDue = due;
  if (!due.length) return '';
  let cards = '';
  for (let i = 0; i < due.length; i++) {
    const e = due[i];
    const n = Number(e.portions) || 1;
    cards += `<div class="n-prompt">
      <div class="n-prompt-title">🧊 Set aside to freeze — ${nEsc(e.athlete)}: ${nEsc(e.recipe)}</div>
      <div style="font-size:13px;color:var(--n-text);margin:2px 0 8px">Plan: freeze <b>${n}</b> single-meal portion${n === 1 ? '' : 's'}${e.portion_note ? ' — ' + nEsc(e.portion_note) : ''}.</div>
      <div class="n-prompt-row">
        <label>Froze</label>
        <input type="number" inputmode="numeric" id="nstk-${i}" value="${n}" min="0" style="width:64px">
        <button class="n-act small primary" onclick="nStockConfirm(${i})">Add to freezer ✓</button>
      </div></div>`;
  }
  return cards;
}
async function nStockConfirm(i) {
  if (nOffline) { toast('Offline — reconnect to update the freezer.', 3000); return; }
  const e = (NS._stockDue || [])[i];
  if (!e) return;
  const inp = document.getElementById(`nstk-${i}`);
  const n = Math.max(0, parseInt(inp && inp.value, 10) || 0);
  if (!n) { toast('Enter how many you froze (or skip).', 2500); return; }
  const rec = (NS.recipes || []).find(r => r.name === e.recipe);
  const { data, error } = await ndb.from('freezer_inventory').insert({
    household_id: NS.me.household_id,
    athlete_id: e._aid,
    recipe_id: rec ? rec.id : null,
    recipe_name: e.recipe,
    portions: n,
    portion_note: e.portion_note || null,
    kcal: e.kcal != null ? e.kcal : null, protein_g: e.protein_g != null ? e.protein_g : null,
    carbs_g: e.carbs_g != null ? e.carbs_g : null, fat_g: e.fat_g != null ? e.fat_g : null,
    frozen_on: nToday(),
    plan_week_id: NS.planWeek ? NS.planWeek.id : null,
  }).select().single();
  if (error) { toast('Add failed: ' + error.message, 3500); return; }
  (NS.freezerInventory = NS.freezerInventory || []).push(data);
  if (typeof renderToday === 'function') renderToday();
  toast(`Added ${n} to ${e.athlete}'s freezer ✓`);
}
