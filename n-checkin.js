// ══════════════ Kardia Nutrition — Weekly check-in sheet (v2) ══════════════
// Only asks what the logged data CANNOT tell the coach:
//   1. unlogged eating (honesty signal — calibrates intake data + TDEE)
//   2. subjective state (hunger/cravings/energy/digestion)
//   3. meals to not repeat (the "why" behind swaps/skips)
//   4. notes + next week's logistics
// Compliance %, intake vs plan, and restaurant counts are computed from logs.

let NCI = null;
let NCI_RESTORED = false;   // true when the sheet was opened from an unsent draft

// ── Unsent-draft autosave (2026-10-18) ──
// Every answer and every keystroke is saved on the phone as it happens, keyed by
// athlete + plan week, so the check-in survives a re-render, the sheet being
// closed, the phone sleeping, or the PWA being killed in the background. The
// draft is cleared only after a successful submit (or an explicit discard), and
// is ignored if a newer submission exists (e.g. submitted from another device).
function nciDraftKey() { return `n_ci_draft_${NS.me.id}_${NS.weekOf}`; }
function nciSaveDraft() {
  if (!NCI) return;
  try {
    localStorage.setItem(nciDraftKey(), JSON.stringify(Object.assign({}, NCI,
      { meals_to_change: [...NCI.meals_to_change], saved_at: Date.now() })));
  } catch (e) { /* storage blocked — in-memory state still holds */ }
}
function nciLoadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(nciDraftKey()) || 'null');
    if (!d || typeof d !== 'object') return null;
    const sub = NS.checkin && NS.checkin.submitted_at ? Date.parse(NS.checkin.submitted_at) : 0;
    if (sub && (d.saved_at || 0) <= sub) { nciClearDraft(); return null; }
    return d;
  } catch (e) { return null; }
}
function nciClearDraft() { try { localStorage.removeItem(nciDraftKey()); } catch (e) {} }
function nciChanged() { nciSaveDraft(); renderCheckinSheet(); }
// Typing never re-renders (that would move the cursor) — it just updates state + draft.
function nciText(field, v) { NCI[field] = v; nciSaveDraft(); }
function nciHasTyping() {
  return !!(NCI && ((NCI.general_notes || '').trim() || (NCI.next_week_notes || '').trim()));
}
function nciFrom(c) {
  c = c || {};
  return {
    unlogged_eating: c.unlogged_eating ?? null,
    hunger: c.hunger ?? null, cravings: c.cravings ?? null,
    energy: c.energy ?? null, digestion: c.digestion ?? null,
    water_retention_context: c.water_retention_context ?? null,
    meals_to_change: new Set(Array.isArray(c.meals_to_change) ? c.meals_to_change
      : (c.meals_to_change || '').split(';').map(s => s.trim()).filter(Boolean)),
    general_notes: c.general_notes ?? '', next_week_notes: c.next_week_notes ?? '',
    activity_outlook: c.activity_outlook ?? null,
  };
}
function nciDiscardDraft() {
  nciClearDraft();
  NCI = nciFrom(NS.checkin);
  NCI_RESTORED = false;
  renderCheckinSheet();
  toast('Unsent changes discarded');
}

const NCI_UNLOGGED = [
  ['none', 'Nothing', 'everything I ate is in the app'],
  ['some', 'A little', 'bites, tastes, a splash of oil — maybe 100–200 kcal/day'],
  ['lots', 'A fair amount', 'meals or snacks went unlogged — treat my numbers as low'],
];

function openCheckin() {
  const draft = nciLoadDraft();
  NCI = nciFrom(draft || NS.checkin);
  NCI_RESTORED = !!draft;
  if (draft) toast('Restored your unsent check-in', 2500);
  let ov = document.getElementById('nci-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'nci-overlay';
    ov.className = 'n-sheet-overlay';
    // A stray tap on the dimmed background must not close a sheet with typing in it.
    ov.onclick = (e) => {
      if (e.target !== ov) return;
      if (nciHasTyping()) { toast('Tap ✕ to close — your answers are saved', 2500); return; }
      closeCheckin();
    };
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
function nciSet(field, v) { NCI[field] = (NCI[field] === v ? null : v); nciChanged(); }
function nciSetUnlogged(v) { NCI.unlogged_eating = v; nciChanged(); }
// Next week's activity (N09 §3.14): scales the TRAINING part of the coach's
// activity forecast — normal ×1, less ×0.5, more ×1.25, off ×0 (and the target
// holds at maintenance). Steps keep their recent level either way.
const NCI_OUTLOOK = [['normal', 'Normal'], ['less', 'Less'], ['more', 'More'], ['off', 'Off / traveling']];
function nciSetOutlook(v) { NCI.activity_outlook = (NCI.activity_outlook === v ? null : v); nciChanged(); }
function nciSetWater(v) { NCI.water_retention_context = (NCI.water_retention_context === v ? null : v); nciChanged(); }
function nciToggleMeal(name) {
  if (NCI.meals_to_change.has(name)) NCI.meals_to_change.delete(name);
  else NCI.meals_to_change.add(name);
  nciChanged();
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
      <textarea id="nci-notes" class="n-search" rows="3" style="resize:vertical"
        oninput="nciText('general_notes', this.value)">${nEsc(NCI.general_notes)}</textarea>
      <div class="n-sheet-section">Next week's workouts and activity, compared with usual?</div>
      <div class="n-portion-chips">${NCI_OUTLOOK.map(([v, l]) =>
        `<button class="n-chip${NCI.activity_outlook === v ? ' active' : ''}" onclick="nciSetOutlook('${v}')">${l}</button>`).join('')}</div>
      <div class="n-opt-sub">The coach adjusts next week's calories to match — less training, a little less food; a bigger block, more.</div>
      <div class="n-sheet-section">Next week (travel, events, schedule, requests)</div>
      <textarea id="nci-next" class="n-search" rows="2" style="resize:vertical"
        oninput="nciText('next_week_notes', this.value)">${nEsc(NCI.next_week_notes)}</textarea>
      <button class="btn" style="margin:12px 0" onclick="submitNCheckin()">
        ${NS.checkin ? 'Update check-in' : 'Submit check-in'}</button>
      <div class="n-opt-sub" style="text-align:center;margin-bottom:6px">Your answers save on this phone as you go — nothing is lost if you close this or the phone sleeps.</div>
      ${NCI_RESTORED ? `<button class="n-prompt-dismiss" style="display:block;margin:0 auto 12px" onclick="nciDiscardDraft()">Discard unsent changes</button>` : ''}
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
    general_notes: (NCI.general_notes || '').trim() || null,
    next_week_notes: (NCI.next_week_notes || '').trim() || null,
    activity_outlook: NCI.activity_outlook,
    resubmitted: !!NS.checkin,
    submitted_at: new Date().toISOString(),
  };
  let { data, error } = await ndb.from('nutrition_checkins')
    .upsert(row, { onConflict: 'athlete_id,week_of' }).select().single();
  // Before the 2026-09-24d migration runs, the column does not exist: submit
  // without it rather than lose the whole check-in.
  if (error && /activity_outlook/.test(error.message || '')) {
    delete row.activity_outlook;
    ({ data, error } = await ndb.from('nutrition_checkins')
      .upsert(row, { onConflict: 'athlete_id,week_of' }).select().single());
  }
  if (error) { toast('Submit failed: ' + error.message, 4000); return; }
  NS.checkin = data;
  nciClearDraft();
  NCI_RESTORED = false;
  closeCheckin();
  toast('Check-in submitted ✓ — the coach reads it before planning next week', 3500);
  try { renderToday(); } catch (_) {}
}
