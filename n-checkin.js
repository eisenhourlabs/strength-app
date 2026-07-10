// ══════════════ Kardia Nutrition — Weekly check-in sheet ══════════════
// Sunday prompt on Today; also opens from the Trends header. Upserts
// nutrition_checkins on (athlete_id, week_of). Under 60 seconds to complete.

let NCI = null;   // working copy of the form state

const NCI_ADHERENCE_HELP = {
  5: 'excellent — followed very closely', 4: 'good — minor deviations',
  3: 'mixed — several deviations', 2: 'poor — frequently off plan',
  1: "very poor — don't judge the target by this week",
};

function openCheckin() {
  const c = NS.checkin || {};
  NCI = {
    adherence_score: c.adherence_score ?? null,
    intake_modifier: c.intake_modifier ?? null,
    hunger: c.hunger ?? null, cravings: c.cravings ?? null,
    energy: c.energy ?? null, digestion: c.digestion ?? null,
    restaurant_meals_count: c.restaurant_meals_count ?? null,
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
  renderCheckinSheet();
}
function closeCheckin() {
  const ov = document.getElementById('nci-overlay');
  if (ov) ov.style.display = 'none';
}

function nciChips(field, max, labels) {
  let h = '<div class="n-portion-chips">';
  for (let v = 1; v <= max; v++)
    h += `<button class="n-chip${NCI[field] === v ? ' active' : ''}" onclick="nciSet('${field}',${v})">${v}</button>`;
  h += '</div>';
  if (labels && NCI[field]) h += `<div class="n-opt-sub" style="margin-top:3px">${labels[NCI[field]] || ''}</div>`;
  return h;
}
function nciSet(field, v) { NCI[field] = (NCI[field] === v ? null : v); renderCheckinSheet(); }
function nciSetMod(v) { NCI.intake_modifier = v; renderCheckinSheet(); }

function renderCheckinSheet() {
  const ov = document.getElementById('nci-overlay');
  const wk = NS.weekOf;
  const mods = [['about_right', 'About right'], ['ate_more', 'Ate more'], ['ate_less', 'Ate less']];
  ov.innerHTML = `<div class="n-sheet" onclick="event.stopPropagation()">
    <div class="n-sheet-head">
      <div class="n-sheet-title">Weekly check-in — week of ${wk}</div>
      <button class="n-sheet-close" onclick="closeCheckin()">✕</button>
    </div>
    <div class="n-sheet-list">
      <div class="n-sheet-section">How closely did you follow the plan? (1–5)</div>
      ${nciChips('adherence_score', 5, NCI_ADHERENCE_HELP)}
      <div class="n-sheet-section">Overall intake vs plan</div>
      <div class="n-portion-chips">${mods.map(([v, l]) =>
        `<button class="n-chip${NCI.intake_modifier === v ? ' active' : ''}" onclick="nciSetMod('${v}')">${l}</button>`).join('')}</div>
      <div class="n-sheet-section">Optional (1–5, tap to skip/unset)</div>
      <div class="n-opt-sub">Hunger</div>${nciChips('hunger', 5)}
      <div class="n-opt-sub">Cravings</div>${nciChips('cravings', 5)}
      <div class="n-opt-sub">Energy</div>${nciChips('energy', 5)}
      <div class="n-opt-sub">Digestion</div>${nciChips('digestion', 5)}
      <div class="n-sheet-section">Restaurant meals this week</div>
      <input type="number" inputmode="numeric" id="nci-rest" class="n-search" style="width:90px"
        value="${NCI.restaurant_meals_count ?? ''}" placeholder="#">
      <div class="n-sheet-section">Notes (meals that didn't work, hunger patterns, anything)</div>
      <textarea id="nci-notes" class="n-search" rows="3" style="resize:vertical">${nEsc(NCI.general_notes)}</textarea>
      <div class="n-sheet-section">Next week (travel, events, schedule, requests)</div>
      <textarea id="nci-next" class="n-search" rows="2" style="resize:vertical">${nEsc(NCI.next_week_notes)}</textarea>
      <button class="btn" style="margin:12px 0" onclick="submitNCheckin()">
        ${NS.checkin ? 'Update check-in' : 'Submit check-in'}</button>
    </div></div>`;
}

async function submitNCheckin() {
  if (nOffline) { toast('Offline — reconnect to submit.', 3000); return; }
  if (!NCI.adherence_score) { toast('Pick an adherence score (1–5)'); return; }
  if (!NCI.intake_modifier) { toast('Pick an intake option'); return; }
  const restEl = document.getElementById('nci-rest');
  const row = {
    athlete_id: NS.me.id,
    week_of: NS.weekOf,
    adherence_score: NCI.adherence_score,
    intake_modifier: NCI.intake_modifier,
    hunger: NCI.hunger, cravings: NCI.cravings,
    energy: NCI.energy, digestion: NCI.digestion,
    restaurant_meals_count: restEl.value === '' ? null : parseInt(restEl.value, 10),
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
