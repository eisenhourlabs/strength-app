// ── Weekly Check-In ───────────────────────────────────────────────────────────

/** Returns the ISO date string for the next upcoming Monday (always future). */
function nextMonday() {
  const d   = new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon, …
  const add = day === 1 ? 7 : (8 - day) % 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

/** Friendly label for the upcoming week start date. */
function nextMondayLabel() {
  const d = new Date(nextMonday() + 'T00:00:00');
  return 'Week of ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

let _ciInjuryUpdates = {};

// Build the interactive open-injury review shown inside the Weekly Check-In.
function renderCheckinInjuries(injuries) {
  if (!injuries.length) {
    return '<div style="font-size:13px;color:var(--muted);margin:8px 0 4px">No open injuries. \u2713</div>';
  }
  const states = [['same','Same'],['improving','Better'],['worse','Worse'],['resolved','Resolved']];
  const cards = injuries.map(function(inj) {
    const id  = inj.injury_id || '';
    const sub = [
      inj.pain_score != null ? inj.pain_score + '/10' : null,
      inj.status ? inj.status.charAt(0).toUpperCase() + inj.status.slice(1) : null,
      'updated ' + daysAgoLabel(inj.last_update),
    ].filter(Boolean).join(' \u00b7 ');
    const btns = states.map(function(s) {
      return '<button type="button" class="ci-inj-btn" data-inj="' + id + '" data-state="' + s[0] + '"'
        + ' onclick="setInjuryUpdate(\'' + id + '\',\'' + s[0] + '\',this)">' + s[1] + '</button>';
    }).join('');
    return '<div class="ci-inj"><div class="ci-inj-head"><span class="ci-inj-region">' + inj.body_region + '</span>'
      + '<span class="ci-inj-sub">' + sub + '</span></div>'
      + '<div class="ci-inj-btns">' + btns + '</div></div>';
  }).join('');
  return '<div class="ci-inj-wrap"><div style="font-size:12px;color:var(--muted);margin:6px 0 8px">'
    + 'Injury check \u2014 update any that changed (leave blank if no change):</div>' + cards + '</div>';
}

function setInjuryUpdate(injuryId, state, btn) {
  if (_ciInjuryUpdates[injuryId] === state) delete _ciInjuryUpdates[injuryId];
  else _ciInjuryUpdates[injuryId] = state;
  document.querySelectorAll('.ci-inj-btn[data-inj="' + injuryId + '"]').forEach(function(b) {
    b.classList.toggle('active', b.dataset.state === _ciInjuryUpdates[injuryId]);
  });
}

// On check-in submit, write a pain_injury_logs row for each injury the athlete
// updated. Untouched injuries are intentionally left alone (carry forward).
async function applyCheckinInjuryUpdates() {
  const ids = Object.keys(_ciInjuryUpdates || {});
  if (!ids.length) return;
  for (const id of ids) {
    const inj = (S.openInjuries || []).find(function(i) { return (i.injury_id || '') === id; });
    if (!inj) continue;
    const state = _ciInjuryUpdates[id];
    const payload = {
      athlete_id:        S.athlete.id,
      log_date:          today(),
      body_region:       inj.body_region,
      injury_id:         inj.injury_id,
      pain_score:        state === 'resolved' ? null : inj.pain_score,
      status:            state,
      modified_training: false,
      trigger:           null,
      notes:             'Weekly check-in update',
    };
    try {
      if (isOffline) await idbQueueWrite({ op: 'pain', payload: payload });
      else           await db.from('pain_injury_logs').insert(payload);
      applyPainLocally(payload);
    } catch (err) { console.error('checkin injury update:', err); }
  }
  _ciInjuryUpdates = {};
  updatePainBadge();
  try { await idbSet('openInjuriesCache', { athleteId: S.athlete.id, items: S.openInjuries }); } catch (_) {}
}

async function openCheckin() {
  document.getElementById('checkin-week-label').textContent = nextMondayLabel();
  document.getElementById('checkin-overlay').classList.add('open');
  document.getElementById('checkin-sheet').classList.add('open');

  const body = document.getElementById('checkin-body');
  body.innerHTML = '<div style="color:var(--muted);padding:20px 0;text-align:center">Loading…</div>';

  // Pre-fill from existing submission if any
  const ci = S.checkin || {};

  // Refresh open injuries for the interactive review below.
  _ciInjuryUpdates = {};
  try { await loadOpenInjuries(); } catch (_) {}

  // Fetch health summary (this week's avg readiness)
  let summaryHtml = '<div class="summary-tile"><strong>This week from your logs:</strong><br>';
  try {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStr = weekAgo.toISOString().slice(0, 10);
    const rRes = await db.from('readiness_logs')
      .select('readiness_score').eq('athlete_id', S.athlete.id).gte('log_date', weekStr);
    const scores = (rRes.data || []).map(r => r.readiness_score).filter(Boolean);
    const avgR   = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;
    summaryHtml += avgR ? `Avg readiness: <strong>${avgR}/5</strong>` : 'No readiness logs yet';
  } catch (_) {
    summaryHtml += 'Could not load summary — check connection';
  }
  summaryHtml += '</div>';

  // Days — pre-color from athlete's available_days profile field.
  // Green (.avail)   = normal training day, tappable to mark as skipping this week.
  // Strikethrough red (.skipping) = normal training day being skipped this week.
  // Grey (default)  = normal off day, not interactive.
  // Falls back to all-grey when available_days is not set on the athlete record.
  const DAYS      = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const trainSet  = new Set(S.athlete.available_days || []);  // normal training days
  const skipSet   = new Set(ci.unavailable_days || []);       // days skipped this week
  const hasProfile = trainSet.size > 0;

  const dayChips = DAYS.map(d => {
    if (!hasProfile) {
      // No profile data yet — legacy grey chips, tappable
      return `<button class="day-chip${skipSet.has(d) ? ' unavail' : ''}" onclick="toggleDay(this,'${d}')">${d.slice(0,3)}</button>`;
    }
    if (trainSet.has(d)) {
      const cls = skipSet.has(d) ? 'skipping' : 'avail';
      return `<button class="day-chip ${cls}" onclick="toggleDay(this,'${d}')">${d.slice(0,3)}</button>`;
    }
    // Normal off day — grey, not interactive
    return `<button class="day-chip" style="opacity:.4;cursor:default" disabled>${d.slice(0,3)}</button>`;
  }).join('');

  // Travel sub-option visibility
  const isTraveling    = ci.is_traveling    === true;
  const plansTrain     = ci.travel_plans_to_train === true;
  const equipVal       = ci.travel_equipment_access || '';
  const trainSubVis    = isTraveling  ? 'visible' : '';
  const equipSubVis    = plansTrain   ? 'visible' : '';

  const equipOptions = [
    ['full_commercial_gym',   'Full commercial gym'],
    ['home_gym_well_equipped','Home gym / well-equipped setup'],
    ['hotel_gym',             'Hotel gym / basic fitness center'],
    ['bodyweight_only',       'Bodyweight only'],
    ['not_sure',              'Not sure'],
  ].map(([val, lbl]) =>
    `<option value="${val}"${equipVal === val ? ' selected' : ''}>${lbl}</option>`
  ).join('');

  // Coach follow-up question (optional, set by the weekly program push)
  const _esc = function(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  const coachQ = (S.cycle && S.cycle.coach_question) ? _esc(S.cycle.coach_question) : null;
  const coachQHtml = coachQ ? `
    <div class="checkin-section" style="border-left:3px solid var(--accent);padding-left:12px">
      <div class="checkin-section-title">From your coach</div>
      <div class="ci-coachq-text">“${coachQ}”</div>
      <textarea id="ci-coach-answer" placeholder="Your answer…"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;
               color:var(--text);font-size:14px;padding:10px 12px;resize:none;min-height:60px"
      >${_esc(ci.coach_question_answer || '')}</textarea>
    </div>` : '';

  body.innerHTML = `
    ${coachQHtml}
    <div class="checkin-section">
      <div class="checkin-section-title">Next Week Schedule</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:4px">Any training days you'll miss?</div>
      <div class="day-chips" id="ci-day-chips">${dayChips}</div>

      <div style="margin-top:14px">
        <div class="toggle-row">
          <div><div class="toggle-label">Traveling?</div></div>
          <label class="toggle-switch">
            <input type="checkbox" id="ci-traveling" ${isTraveling ? 'checked' : ''}
              onchange="toggleTravelFields()">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="travel-sub ${trainSubVis}" id="ci-travel-sub">
          <div class="toggle-row" style="padding:0 0 10px">
            <div><div class="toggle-label" style="font-size:13px">Planning to train while away?</div></div>
            <label class="toggle-switch">
              <input type="checkbox" id="ci-train-away" ${plansTrain ? 'checked' : ''}
                onchange="toggleEquipField()">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="travel-sub ${equipSubVis}" id="ci-equip-sub" style="margin-top:0;padding:10px 0 0">
            <label>What will you have access to?</label>
            <select id="ci-equip">${equipOptions}</select>
          </div>
        </div>
      </div>
    </div>

    <div class="checkin-section">
      <div class="checkin-section-title">Health &amp; Recovery</div>
      ${summaryHtml}
      ${renderCheckinInjuries(S.openInjuries || [])}
      <div class="form-field wide" style="margin-top:0">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">
          Anything your logs don't show?
        </label>
        <textarea id="ci-health" placeholder="E.g., sick this week, poor sleep, high stress, injury update…"
          style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;
                 color:var(--text);font-size:14px;padding:10px 12px;resize:none;min-height:72px"
        >${ci.health_recovery_notes || ''}</textarea>
      </div>
    </div>

    <div class="checkin-section">
      <div class="checkin-section-title">Notes for Coach <span style="font-weight:400;text-transform:none;font-size:11px;color:var(--muted)">(all optional)</span></div>
      <div class="form-field wide" style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Anything you want more or less of?</label>
        <textarea id="ci-more-less" placeholder="E.g., more upper body work, less conditioning this week…"
          style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;
                 color:var(--text);font-size:14px;padding:10px 12px;resize:none;min-height:60px"
        >${ci.more_less_notes || ''}</textarea>
      </div>
      <div class="form-field wide" style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Schedule preferences or changes?</label>
        <textarea id="ci-schedule" placeholder="E.g., prefer not to lift on Tuesdays anymore…"
          style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;
                 color:var(--text);font-size:14px;padding:10px 12px;resize:none;min-height:60px"
        >${ci.schedule_preference_notes || ''}</textarea>
      </div>
      <div class="form-field wide" style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Anything else for the coach?</label>
        <textarea id="ci-general" placeholder="Questions, updates, general notes…"
          style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;
                 color:var(--text);font-size:14px;padding:10px 12px;resize:none;min-height:60px"
        >${ci.general_notes || ''}</textarea>
      </div>
      <div class="form-field wide">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Anything coming up in the next few weeks?</label>
        <textarea id="ci-future" placeholder="E.g., traveling June 14–21, no gym access…"
          style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;
                 color:var(--text);font-size:14px;padding:10px 12px;resize:none;min-height:60px"
        >${ci.future_notes || ''}</textarea>
      </div>
    </div>

    <button class="btn" onclick="submitCheckin()" style="margin-top:4px">
      ${ci.submitted_at ? 'Update Check-In' : 'Submit Check-In'}
    </button>
    <button class="btn secondary" onclick="closeCheckin()" style="margin-top:8px">Cancel</button>
  `;
}

function closeCheckin() {
  document.getElementById('checkin-overlay').classList.remove('open');
  document.getElementById('checkin-sheet').classList.remove('open');
}

function toggleDay(el, day) {
  if (el.disabled) return;
  const trainSet = new Set(S.athlete.available_days || []);
  if (trainSet.size > 0) {
    // Profile-aware: toggle between avail and skipping
    if (el.classList.contains('avail')) {
      el.classList.remove('avail');
      el.classList.add('skipping');
    } else if (el.classList.contains('skipping')) {
      el.classList.remove('skipping');
      el.classList.add('avail');
    }
  } else {
    // Legacy fallback: no profile data, toggle unavail
    el.classList.toggle('unavail');
  }
}

function toggleTravelFields() {
  const traveling = document.getElementById('ci-traveling').checked;
  const sub = document.getElementById('ci-travel-sub');
  if (traveling) { sub.classList.add('visible'); }
  else {
    sub.classList.remove('visible');
    // Clear the nested sub-field too
    const trainAway = document.getElementById('ci-train-away');
    if (trainAway) trainAway.checked = false;
    const equipSub = document.getElementById('ci-equip-sub');
    if (equipSub) equipSub.classList.remove('visible');
  }
}

function toggleEquipField() {
  const trainAway = document.getElementById('ci-train-away').checked;
  const equipSub  = document.getElementById('ci-equip-sub');
  if (trainAway) { equipSub.classList.add('visible'); }
  else           { equipSub.classList.remove('visible'); }
}

async function submitCheckin() {
  // Gather skipped training days from chip state.
  // With profile: collect .skipping chips (training days being skipped this week).
  // Legacy fallback: collect .unavail chips.
  const DAY_EXPAND = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday',
                       Fri:'Friday', Sat:'Saturday', Sun:'Sunday' };
  const trainSet = new Set(S.athlete.available_days || []);
  const skipSelector = trainSet.size > 0 ? '#ci-day-chips .day-chip.skipping'
                                         : '#ci-day-chips .day-chip.unavail';
  const skipChips   = document.querySelectorAll(skipSelector);
  const unavailFull = Array.from(skipChips).map(c => DAY_EXPAND[c.textContent.trim()] || c.textContent.trim());

  const traveling       = document.getElementById('ci-traveling')?.checked  ?? false;
  const trainAway       = document.getElementById('ci-train-away')?.checked ?? null;
  const equipVal        = document.getElementById('ci-equip')?.value         || null;
  const healthNotes     = document.getElementById('ci-health')?.value.trim()    || null;
  const moreNotes       = document.getElementById('ci-more-less')?.value.trim() || null;
  const schedNotes      = document.getElementById('ci-schedule')?.value.trim()  || null;
  const generalNotes    = document.getElementById('ci-general')?.value.trim()   || null;
  const futureNotes     = document.getElementById('ci-future')?.value.trim()    || null;

  const isResubmit = !!S.checkin;
  const payload = {
    athlete_id:                S.athlete.id,
    week_start_date:           nextMonday(),
    submitted_at:              new Date().toISOString(),
    unavailable_days:          unavailFull.length ? unavailFull : null,
    is_traveling:              traveling || null,
    travel_plans_to_train:     traveling ? (trainAway ?? null) : null,
    travel_equipment_access:   traveling && trainAway ? (equipVal || null) : null,
    health_recovery_notes:     healthNotes,
    more_less_notes:           moreNotes,
    schedule_preference_notes: schedNotes,
    general_notes:             generalNotes,
    future_notes:              futureNotes,
    coach_question_answer:     document.getElementById('ci-coach-answer')?.value.trim() || null,
    resubmitted:               isResubmit,
  };

  try {
    const { data, error } = await db.from('athlete_weekly_checkin')
      .upsert(payload, { onConflict: 'athlete_id,week_start_date' })
      .select().single();
    if (error) throw error;
    S.checkin = data;
    await applyCheckinInjuryUpdates();
    toast(isResubmit ? 'Check-in updated ✓' : 'Check-in submitted ✓');
    closeCheckin();
    renderWeek(); // refresh card badge
  } catch (err) {
    console.error('Check-in save error:', err);
    toast('Error saving check-in. Try again.', 4000);
  }
}

