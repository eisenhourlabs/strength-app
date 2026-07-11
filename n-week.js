// ══════════════ Kardia Nutrition — Week screen + boot (loads LAST) ══════════════

function nDayDot(dateStr) {
  const meals = nMyMeals(dateStr);
  if (!meals.length) return 'dot-gray';
  let logged = 0, offPlan = 0;
  for (const m of meals) {
    const l = NS.logs[m.id];
    if (!l) continue;
    logged++;
    if (l.status === 'skipped' || l.status === 'ate_out') offPlan++;
  }
  if (!logged) return 'dot-gray';
  if (logged === meals.length && !offPlan) return 'dot-green';
  return 'dot-amber';
}

function renderNWeek() {
  const body = document.getElementById('nweek-body');
  document.getElementById('nweek-sub').textContent =
    `week of ${NS.weekOf}` + (NS.target ? ` · ${NS.target.kcal_target} kcal · ${NS.target.protein_g_low}–${NS.target.protein_g_high}g protein` : '');
  if (!NS.selDay) NS.selDay = nToday();

  let html = '';

  // Day strip
  html += `<div class="n-daystrip">`;
  for (let i = 0; i < 7; i++) {
    const d = nAddDays(NS.weekOf, i);
    html += `<div class="n-daychip${d === NS.selDay ? ' sel' : ''}" onclick="NS.selDay='${d}';renderNWeek()">
      <div class="d-name">${nDayName(d, true)}</div>
      <div class="d-dot ${nDayDot(d)}">●</div></div>`;
  }
  html += `</div>`;

  // Selected day — my meals + shared portions view
  const meals = nMyMeals(NS.selDay);
  html += `<div class="n-panel"><div class="n-panel-title">${nFmtDate(NS.selDay)} — ${nEsc(NS.me.name)}</div>`;
  if (!meals.length) html += `<div>No meals planned.</div>`;
  for (const m of meals) {
    const l = NS.logs[m.id];
    const partner = nSharedPartner(m);
    const mark = l ? (l.status === 'as_planned' ? ' ✓' : ` · ${N_STATUS_LABEL[l.status] || l.status}`) : '';
    html += `<div class="n-wk-meal">
      <span class="n-wk-slot">${m.meal_slot}</span>
      <span class="n-wk-name">${nEsc(nMealName(m))}${m.portion_note ? ` — <i>${nEsc(m.portion_note)}</i>` : ''}${partner ? ` <span class="n-badge shared">👥 ${nEsc(partner.name)}: ${partner.servings}×</span>` : ''}${mark}</span>
      <span class="n-wk-kcal">${Math.round(m.planned_kcal)}</span></div>`;
  }
  const dayTotal = meals.reduce((s, m) => s + m.planned_kcal, 0);
  html += `<div class="n-wk-meal" style="border-top:1px solid var(--n-border)"><span class="n-wk-slot">planned</span>
    <span class="n-wk-name"></span><span class="n-wk-kcal"><b>${Math.round(dayTotal)} kcal</b></span></div></div>`;

  // Prep plan + notes (household)
  if (NS.planWeek?.prep_plan)
    html += `<div class="n-panel"><div class="n-panel-title">🔪 Prep plan</div><pre>${nEsc(NS.planWeek.prep_plan)}</pre></div>`;
  if (NS.planWeek?.week_notes)
    html += `<div class="n-panel"><div class="n-panel-title">📌 This week</div><pre>${nEsc(NS.planWeek.week_notes)}</pre></div>`;
  if (NS.planWeek?.coach_notes)
    html += `<div class="n-panel"><div class="n-panel-title">🧠 Coach notes</div><pre>${nEsc(NS.planWeek.coach_notes)}</pre></div>`;

  body.innerHTML = html;
}

// ── Boot ──
(async () => {
  nUpdateOffline();
  try {
    const { data: { session } } = await ndb.auth.getSession();
    if (session?.user) {
      await nInit(session.user);
    } else {
      nShowScreen('login');
    }
  } catch (e) {
    console.error('boot failed', e);
    nShowScreen('login');
  }
})();
