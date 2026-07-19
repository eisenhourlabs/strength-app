// ══════════════ Kardia Nutrition — Weekly check-in sheet (v2) ══════════════
// Only asks what the logged data CANNOT tell the coach:
//   1. unlogged eating (honesty signal — calibrates intake data + TDEE)
//   2. subjective state (hunger/cravings/energy/digestion)
//   3. meals to not repeat (the "why" behind swaps/skips)
//   4. notes + next week's logistics
// Compliance %, intake vs plan, and restaurant counts are computed from logs.

let NCI = null;

const NCI_UNLOGGED = [
  ['none', 'Nothing', 'everything I ate is in the app'],
  ['some', 'A little', 'bites, tastes, a splash of oil — maybe 100–200 kcal/day'],
  ['lots', 'A fair amount', 'meals or snacks went unlogged — treat my numbers as low'],
];

function openCheckin() {
  const c = NS.checkin || {};
  NCI = {
    unlogged_eating: c.unlogged_eating ?? null,
    hunger: c.hunger ?? null, cravings: c.cravings ?? null,
    energy: c.energy ?? null, digestion: c.digestion ?? null,
    water_retention_context: c.water_retention_context ?? null,
    meals_to_change: new Set((c.meals_to_change || '').split(';').map(s => s.trim()).filter(Boolean)),
    general_notes: c.general_notes ?? '', next_week_notes: c.next_week_notes ?? '',
  };
  let ov = document.getElementById('nci-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'nci-overlay';
    ov.className = 'n-sheet-overlay';
    ov.onclick = (e) => { if (e.target === ov) closeCheckin(); };
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  nBackPush('checkin', nCheckinHide);
  renderCheckinSheet();
}
function nCheckinHide() {
  const ov = document.getElementById('nci-overlay');
  if (ov) ov.style.display = 'none';
}
function closeCheckin() { nCheckinHide(); nBackConsume('checkin'); }

function nciChips(field, max) {
  let h = '<div class="n-portion-chips">';
  for (let v = 1; v <= max; v++)
    h += `<button class="n-chip${NCI[field] === v ? ' active' : ''}" onclick="nciSet('${field}',${v})">${v}</button>`;
  return h + '</div>';
}
function nciSet(field, v) { NCI[field] = (NCI[field] === v ? null : v); renderCheckinSheet(); }
function nciSetUnlogged(v) { NCI.unlogged_eating = v; renderCheckinSheet(); }
function nciSetWater(v) { NCI.water_retention_context = (NCI.water_retention_context === v ? null : v); renderCheckinSheet(); }
function nciToggleMeal(name) {
  if (NCI.meals_to_change.has(name)) NCI.meals_to_change.delete(name);
  else NCI.meals_to_change.add(name);
  renderCheckinSheet();
}

function nciWeekMealNames() {
  const names = new Set();
  for (const m of NS.meals) {
    if (m.athlete_id !== NS.me.id || m.custom_name) continue;
    names.add(nMealName(m));
  }
  return [...names].sort();
}

function renderCheckinSheet() {
  const ov = document.getElementById('nci-overlay');
  const mealNames = nciWeekMealNames();
  ov.innerHTML = `<div class="n-sheet" onclick="event.stopPropagation()">
    <div class="n-sheet-head">
      <div class="n-sheet-title">Weekly check-in — week of ${NS.weekOf}</div>
      <button class="n-sheet-close" onclick="closeCheckin()">✕</button>
    </div>
    <div class="n-sheet-list">
      <div class="n-sheet-section">Anything eaten that didn't get logged?</div>
      ${NCI_UNLOGGED.map(([v, l, sub]) =>
        `<button class="n-opt${NCI.unlogged_eating === v ? '' : ''}" style="${NCI.unlogged_eating === v ? 'border-color:#ff2712' : ''}"
          onclick="nciSetUnlogged('${v}')">
          <div class="n-opt-name">${NCI.unlogged_eating === v ? '● ' : ''}${l}</div>
          <div class="n-opt-sub">${sub}</div></button>`).join('')}
      <div class="n-sheet-section">How did you feel? (1 = great · 5 = rough — optional, tap to unset)</div>
      <div class="n-opt-sub">Hunger</div>${nciChips('hunger', 5)}
      <div class="n-opt-sub">Cravings</div>${nciChips('cravings', 5)}
      <div class="n-opt-sub">Energy (1 = high)</div>${nciChips('energy', 5)}
      <div class="n-opt-sub">Digestion</div>${nciChips('digestion', 5)}
      ${NS.settings?.track_cycle_context ? `
      <div class="n-sheet-section">Anything that might make the scale read high this week? (optional — helps the coach read your weight trend, never shared beyond it)</div>
      <div class="n-portion-chips">${[['none', 'No'], ['cycle', 'Cycle-related'], ['other', 'Sodium / travel / poor sleep'], ['unsure', 'Not sure']].map(([v, l]) =>
        `<button class="n-chip${NCI.water_retention_context === v ? ' active' : ''}" onclick="nciSetWater('${v}')">${l}</button>`).join('')}</div>` : ''}
      ${mealNames.length ? `<div class="n-sheet-section">Any meals you DON'T want again? (tap to flag)</div>
      <div class="n-portion-chips">${mealNames.map(n =>
        `<button class="n-chip${NCI.meals_to_change.has(n) ? ' active' : ''}"
          onclick="nciToggleMeal('${n.replace(/'/g, "\\'")}')">${nEsc(n)}</button>`).join('')}</div>` : ''}
      <div class="n-sheet-section">Notes (why a meal didn't work, hunger patterns, anything)</div>
      <textarea id="nci-notes" class="n-search" rows="3" style="resize:vertical">${nEsc(NCI.general_notes)}</textarea>
      <div class="n-sheet-section">Next week (travel, events, schedule, requests)</div>
      <textarea id="nci-next" class="n-search" rows="2" style="resize:vertical">${nEsc(NCI.next_week_notes)}</textarea>
      <button class="btn" style="margin:12px 0" onclick="submitNCheckin()">
        ${NS.checkin ? 'Update check-in' : 'Submit check-in'}</button>
    </div></div>`;
}

async function submitNCheckin() {
  if (nOffline) { toast('Offline — reconnect to submit.', 3000); return; }
  if (!NCI.unlogged_eating) { toast('Answer the unlogged-eating question — it calibrates everything else'); return; }
  const row = {
    athlete_id: NS.me.id,
    week_of: NS.weekOf,
    unlogged_eating: NCI.unlogged_eating,
    hunger: NCI.hunger, cravings: NCI.cravings,
    energy: NCI.energy, digestion: NCI.digestion,
    water_retention_context: NCI.water_retention_context,
    meals_to_change: [...NCI.meals_to_change].join('; ') || null,
    general_notes: document.getElementById('nci-notes').value.trim() || null,
    next_week_notes: document.getElementById('nci-next').value.trim() || null,
    resubmitted: !!NS.checkin,
    submitted_at: new Date().toISOString(),
  };
  const { data, error } = await ndb.from('nutrition_checkins')
    .upsert(row, { onConflict: 'athlete_id,week_of' }).select().single();
  if (error) { toast('Submit failed: ' + error.message, 4000); return; }
  NS.checkin = data;
  closeCheckin();
  toast('Check-in submitted ✓ — the coach reads it before planning next week', 3500);
  try { renderToday(); } catch (_) {}
}
