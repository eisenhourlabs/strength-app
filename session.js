// ── Open session ──────────────────────────────────────────────────────────────
// ── Reconstruct S.addedExercises from is_added=true rows (re-enter session) ───
// set_number === 0 rows are placeholders (exercise added but not yet saved).
// set_number  >  0 rows are real saved data.
function reconstructAddedExercises(allRows) {
  const addedRows = (allRows || []).filter(s => s.is_added && s.exercise_id);
  const byExId = {};
  addedRows.forEach(s => {
    const eid = String(s.exercise_id);
    if (!byExId[eid]) byExId[eid] = [];
    byExId[eid].push(s);
  });
  Object.entries(byExId).forEach(([exId, rows]) => {
    const lib      = S.exerciseLib.find(e => String(e.id) === exId);
    const exName   = lib ? lib.name : 'Added Exercise';
    const localId  = ++S.addedCounter;
    const realRows = rows.filter(r => (r.set_number || 0) > 0);
    if (realRows.length > 0) {
      // Exercise has real saved data — render as a saved (read-only) card
      S.addedExercises.push({ localId, exId, exName, setCount: realRows.length, measureType: 'reps' });
      S.savedExercises[localId] = realRows;
    } else {
      // Only placeholder — exercise was added but not yet filled in
      S.addedExercises.push({ localId, exId, exName, setCount: 1, measureType: 'reps' });
      // Do NOT populate S.savedExercises[localId] → renders as empty editable tile
    }
  });
}

async function openSession(sessionId) {
  // Stop any running rest timers from a previous session
  Object.values(S.restTimers || {}).forEach(function(t) {
    if (t && t.intervalId) clearInterval(t.intervalId);
  });

  S.activeSession          = S.sessions.find(s => s.id === sessionId);
  S.exState                = {};
  S.addedExercises         = [];
  S.addedCounter           = 0;
  S.activeCompletedSession = null;
  S.savedExercises         = {};
  S.checkedSets            = {};
  S.restTimers             = {};
  S._conditioningLogged    = false;
  startSessionTimer();

  document.getElementById('session-title').textContent = S.activeSession.day_label;
  document.getElementById('session-sub').textContent   = S.activeSession.session_type || '';
  document.getElementById('session-body').innerHTML    = '<div class="spinner">Loading…</div>';

  const isCondOnly = S.activeSession.session_type === 'Conditioning Only';
  const btn = document.getElementById('submit-btn');
  btn.disabled    = false;
  btn.className   = 'btn';
  btn.textContent = isCondOnly ? 'Log Conditioning' : 'Finish Session';
  showScreen('session');

  // ── Offline path for openSession ─────────────────────────────────────────
  if (isOffline || !(await checkOnline())) {
    isOffline = true;
    updateOfflineBanner();
    const sdCache = await idbGet('sessionDetailCache');
    const detail  = sdCache?.[sessionId];
    if (!detail) {
      toast('Session data not cached. Open the app while connected first.', 4000);
      showScreen('week');
      return;
    }
    S.plannedExercises    = detail.exercises    || [];
    S.plannedConditioning = detail.conditioning || null;
    if (detail.completedSession) {
      S.activeCompletedSession = detail.completedSession;
      (detail.savedSets || []).forEach(s => {
        const peId = s.planned_exercise_id;
        if (peId) {
          if (!S.savedExercises[peId]) S.savedExercises[peId] = [];
          S.savedExercises[peId].push(s);
        }
      });
      reconstructAddedExercises(detail.savedSets);
      if (S.activeCompletedSession.status === 'completed') {
        btn.textContent = isCondOnly ? '✓ Logged' : '✓ Session Complete';
        btn.disabled    = true;
        btn.className   = 'btn success-state';
      }
    }

    // ── Restore any sets saved offline this session (in the write queue) ────
    // Without this, exiting and re-entering a session offline shows stale state.
    const offlineQueue = await idbGetAllQueue();

    // Case A: brand-new session — find the pending create_session for this planned session
    if (!S.activeCompletedSession) {
      const createOp = offlineQueue.find(q =>
        q.op === 'create_session' && q.payload?.planned_session_id === sessionId);
      if (createOp) {
        S.activeCompletedSession = { id: createOp.tempSessionId, _isTemp: true, ...createOp.payload };
        S.completed[sessionId]   = S.activeCompletedSession;
      }
    }

    // Case A & B: rebuild savedExercises from any queued insert_sets for this session
    const csId = S.activeCompletedSession?.id;
    if (csId) {
      offlineQueue
        .filter(q => q.op === 'insert_sets')
        .forEach(q => {
          const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
          rows.forEach(row => {
            if (row.completed_session_id === csId && row.planned_exercise_id) {
              const peId = row.planned_exercise_id;
              if (!S.savedExercises[peId]) S.savedExercises[peId] = [];
              S.savedExercises[peId].push(row);
            }
          });
        });

      // Rebuild S.addedExercises from any queued is_added sets for this session
      const queuedAddedRows = [];
      offlineQueue.filter(q => q.op === 'insert_sets').forEach(q => {
        const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
        rows.forEach(row => {
          if (row.completed_session_id === csId && row.is_added && row.exercise_id) {
            queuedAddedRows.push(row);
          }
        });
      });
      if (queuedAddedRows.length) reconstructAddedExercises(queuedAddedRows);

      // Check if session was already finished offline
      const finishOp = offlineQueue.find(q =>
        (q.op === 'finish_session_update' && (q.tempSessionId === csId || q.sessionId === csId)) ||
        (q.op === 'finish_session_insert' && q.payload?.planned_session_id === sessionId));
      if (finishOp) {
        btn.textContent = isCondOnly ? '✓ Logged' : '✓ Session Complete';
        btn.disabled    = true;
        btn.className   = 'btn success-state';
      }
    }

    const exCount = S.plannedExercises.length;
    toast(`Offline — ${exCount} exercise${exCount !== 1 ? 's' : ''} loaded from cache`, 2500);
    S.plannedExercises.forEach(pe => {
      if (!S.savedExercises[pe.id]) {
        const count = pe.target_sets && pe.target_sets > 0 ? pe.target_sets : 1;
        S.exState[pe.id] = { skipped: false, swappedTo: null, setCount: count, measureType: 'reps' };
      }
    });
    const shouldUseCondForm2 = isCondOnly || (!!S.plannedConditioning && S.plannedExercises.length === 0);
    if (shouldUseCondForm2) { renderConditioningSessionBody(); } else { renderSessionBody(); await restoreDraft(sessionId); initExerciseSort(sessionId); }
    return;
  }

  // Load planned exercises and conditioning block
  try {
    const [exRes, condRes] = await Promise.all([
      db.from('planned_exercises')
        .select('*, exercise:exercise_library(id,name,movement_pattern,equipment)')
        .eq('session_id', sessionId)
        .order('item_order'),
      db.from('planned_conditioning_blocks')
        .select('*').eq('session_id', sessionId).limit(1),
    ]);
    S.plannedExercises   = exRes.data   || [];
    S.plannedConditioning = (condRes.data && condRes.data.length) ? condRes.data[0] : null;

    // Check for existing completed_sessions record
    const { data: csRows } = await db.from('completed_sessions')
      .select('*')
      .eq('athlete_id', S.athlete.id)
      .eq('planned_session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (csRows && csRows.length > 0) {
      S.activeCompletedSession = csRows[0];

      // Load already-saved sets so we can render them as locked
      const { data: savedSets } = await db.from('completed_strength_sets')
        .select('set_number,actual_load,actual_reps,actual_rpe,notes,is_skipped,planned_exercise_id,is_added,exercise_id')
        .eq('completed_session_id', S.activeCompletedSession.id)
        .order('set_number');

      (savedSets || []).forEach(s => {
        const peId = s.planned_exercise_id;
        if (peId) {
          if (!S.savedExercises[peId]) S.savedExercises[peId] = [];
          S.savedExercises[peId].push(s);
        }
      });
      reconstructAddedExercises(savedSets);

      // If session is already completed, disable Finish button
      if (S.activeCompletedSession.status === 'completed') {
        btn.textContent = isCondOnly ? '✓ Logged' : '✓ Session Complete';
        btn.disabled    = true;
        btn.className   = 'btn success-state';
      }
    }
  } catch (_) {
    // Network failed mid-session-load — fall back to session cache
    isOffline = true;
    updateOfflineBanner();
    const sdCache = await idbGet('sessionDetailCache');
    const detail  = sdCache?.[sessionId];
    if (!detail) {
      toast('Session data not cached. Open the app while connected first.', 4000);
      showScreen('week');
      return;
    }
    S.plannedExercises    = detail.exercises    || [];
    S.plannedConditioning = detail.conditioning || null;
    if (detail.completedSession) {
      S.activeCompletedSession = detail.completedSession;
      (detail.savedSets || []).forEach(s => {
        const peId = s.planned_exercise_id;
        if (peId) {
          if (!S.savedExercises[peId]) S.savedExercises[peId] = [];
          S.savedExercises[peId].push(s);
        }
      });
      reconstructAddedExercises(detail.savedSets);
      if (S.activeCompletedSession.status === 'completed') {
        btn.textContent = isCondOnly ? '✓ Logged' : '✓ Session Complete';
        btn.disabled    = true;
        btn.className   = 'btn success-state';
      }
    }
  }

  // Init exercise UI state for unsaved exercises
  S.plannedExercises.forEach(pe => {
    if (!S.savedExercises[pe.id]) {
      const count = pe.target_sets && pe.target_sets > 0 ? pe.target_sets : 1;
      S.exState[pe.id] = { skipped: false, swappedTo: null, setCount: count };
    }
  });

  // Treat as conditioning if session_type matches OR planned conditioning exists with no strength exercises
  const shouldUseCondForm = isCondOnly || (!!S.plannedConditioning && S.plannedExercises.length === 0);
  if (shouldUseCondForm) {
    renderConditioningSessionBody();
  } else {
    renderSessionBody();
    await restoreDraft(sessionId);
    initExerciseSort(sessionId);
  }
}

// ── Render session body ───────────────────────────────────────────────────────
// ── Inline readiness widget ───────────────────────────────────────────────────
function buildReadinessSavedHtml(r, readOnly) {
  const fields = [
    { k: 'energy',     l: 'Energy'     },
    { k: 'soreness',   l: 'Soreness'   },
    { k: 'stress',     l: 'Stress'     },
    { k: 'motivation', l: 'Motivation' },
    { k: 'sleep_hours',l: 'Sleep'      },
  ];
  const chips = fields
    .filter(f => r[f.k] != null)
    .map(f => `<span class="hist-ready-chip">${f.l} <span>${r[f.k]}${f.k==='sleep_hours'?'h':''}</span></span>`)
    .join('');
  const editBtn = readOnly ? '' : '<button onclick="resetInlineReadiness()" style="float:right;font-size:10px;background:none;border:none;color:var(--muted);cursor:pointer">Edit</button>';
  return `<div class="sess-ready-card" id="sess-ready-card" style="border-color:var(--success)">
    <div class="sess-ready-title" style="color:var(--success);margin-bottom:6px">Readiness ✓ ${editBtn}</div>
    <div class="hist-ready-strip" style="flex-wrap:wrap">${chips}</div>
  </div>`;
}

function buildInlineReadinessForm() {
  const fields = [
    { id: 'energy',     label: 'Energy' },
    { id: 'soreness',   label: 'Soreness' },
    { id: 'stress',     label: 'Stress' },
    { id: 'motivation', label: 'Motivation' },
  ];
  const rowsHtml = fields.map(f => `
    <div class="sess-ready-row">
      <span class="sess-ready-label">${f.label}</span>
      <div class="sess-ready-pips" id="srp-${f.id}">
        ${[1,2,3,4,5].map(n => `<button class="sess-ready-pip" onclick="sessReadyPip('${f.id}',${n})">${n}</button>`).join('')}
      </div>
    </div>`).join('');
  return `
    <div class="sess-ready-card" id="sess-ready-card">
      <div class="sess-ready-title">How are you feeling today?</div>
      <div class="sess-ready-rows">
        ${rowsHtml}
        <div class="sess-ready-row">
          <span class="sess-ready-label">Sleep (hrs)</span>
          <input class="sess-ready-sleep" type="number" step="0.5" inputmode="decimal"
            id="sr-sleep" placeholder="—">
        </div>
      </div>
      <button class="sess-ready-btn" onclick="submitInlineReadiness()">Save Readiness</button>
    </div>`;
}

async function resolveInlineReadinessCard() {
  // For completed sessions from a previous day, show that day's readiness (read-only)
  const cs = S.activeCompletedSession;
  const sessionDate = cs?.session_date || today();
  const isHistorical = cs?.status === 'completed' && sessionDate !== today();

  if (isHistorical) {
    if (!isOffline) {
      try {
        const { data } = await db.from('readiness_logs')
          .select('*').eq('athlete_id', S.athlete.id).eq('log_date', sessionDate).maybeSingle();
        if (data) return buildReadinessSavedHtml(data, true);
      } catch {}
    }
    // No readiness found for that day — show a quiet note, not the logging form
    return '<div class="sess-ready-card" id="sess-ready-card" style="border-color:var(--border);color:var(--muted);font-size:13px">No readiness logged for this session.</div>';
  }

  // Current session — show today's readiness or the logging form
  if (S._todayReadiness && S._todayReadiness.log_date !== today()) S._todayReadiness = null;
  if (S._todayReadiness) return buildReadinessSavedHtml(S._todayReadiness);
  if (!isOffline) {
    try {
      const { data } = await db.from('readiness_logs')
        .select('*').eq('athlete_id', S.athlete.id).eq('log_date', today()).maybeSingle();
      if (data) { S._todayReadiness = data; return buildReadinessSavedHtml(data); }
    } catch {}
  }
  return buildInlineReadinessForm();
}

function resetInlineReadiness() {
  S._todayReadiness = null;
  S._readiness = {};
  const card = document.getElementById('sess-ready-card');
  if (card) card.outerHTML = buildInlineReadinessForm();
}

function sessReadyPip(field, val) {
  S._readiness = S._readiness || {};
  S._readiness[field] = val;
  const wrap = document.getElementById(`srp-${field}`);
  if (!wrap) return;
  wrap.querySelectorAll('.sess-ready-pip').forEach((btn, i) => {
    btn.classList.toggle('selected', i + 1 === val);
  });
}

async function submitInlineReadiness() {
  const r = S._readiness || {};
  const sleep = parseFloat(document.getElementById('sr-sleep')?.value) || null;
  if (!r.energy && !r.soreness && !r.stress && !r.motivation && !sleep) {
    toast('Tap at least one value to save readiness.'); return;
  }
  const payload = {
    athlete_id:  S.athlete.id,
    log_date:    today(),
    energy:      r.energy     || null,
    soreness:    r.soreness   || null,
    stress:      r.stress     || null,
    motivation:  r.motivation || null,
    sleep_hours: sleep,
  };
  try {
    if (isOffline) {
      await idbQueueWrite({ op: 'readiness', payload });
    } else {
      await db.from('readiness_logs').upsert(payload, { onConflict: 'athlete_id,log_date' });
    }
    // Cache and show saved state
    S._todayReadiness = { ...payload, sleep_hours: sleep };
    S._readiness = {};
    const card = document.getElementById('sess-ready-card');
    if (card) card.outerHTML = buildReadinessSavedHtml(S._todayReadiness);
  } catch(err) {
    console.error(err);
    toast('Error saving readiness.', 3000);
  }
}

// ── Session timer ─────────────────────────────────────────────────────────────
var _sessionTimerInterval = null;

function startSessionTimer() {
  S.sessionStartTime = Date.now();
  stopSessionTimer();
  _sessionTimerInterval = setInterval(updateSessionTimer, 1000);
  updateSessionTimer();
}

function stopSessionTimer() {
  if (_sessionTimerInterval) { clearInterval(_sessionTimerInterval); _sessionTimerInterval = null; }
}

function updateSessionTimer() {
  const el = document.getElementById('session-timer');
  if (!el || !S.sessionStartTime) return;
  const elapsed = Math.floor((Date.now() - S.sessionStartTime) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  el.textContent = h > 0
    ? h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0')
    : m + ':' + String(s).padStart(2,'0');
}

// ── Set completion checkbox ───────────────────────────────────────────────────
function toggleSetCheck(key, idx) {
  if (!S.checkedSets[key]) S.checkedSets[key] = {};
  S.checkedSets[key][idx] = !S.checkedSets[key][idx];
  const checked = !!S.checkedSets[key][idx];

  const row = document.getElementById('setrow-' + key + '-' + idx);
  const cb  = document.getElementById('cb-'     + key + '-' + idx);
  if (row) row.classList.toggle('set-checked', checked);
  if (cb)  { cb.classList.toggle('checked', checked); cb.textContent = checked ? '✓' : ''; }

  if (checked) startRestTimer(key);
}

// ── Rest timer ────────────────────────────────────────────────────────────────
function startRestTimer(key) {
  // Determine target rest seconds from planned exercise data
  let targetSeconds = 120; // fallback 2 min
  if (key.startsWith('p-')) {
    const pe = S.plannedExercises.find(function(e) { return e.id === key.slice(2); });
    if (pe && pe.rest_seconds_min != null && pe.rest_seconds_max != null) {
      targetSeconds = Math.round((pe.rest_seconds_min + pe.rest_seconds_max) / 2);
    }
  }

  // Clear any existing timer for this exercise
  if (S.restTimers[key] && S.restTimers[key].intervalId) {
    clearInterval(S.restTimers[key].intervalId);
  }

  S.restTimers[key] = { remaining: targetSeconds, targetSeconds: targetSeconds, intervalId: null };
  updateRestDisplay(key);

  S.restTimers[key].intervalId = setInterval(function() {
    const t = S.restTimers[key];
    if (!t) return;
    if (t.remaining <= 0) {
      clearInterval(t.intervalId);
      t.intervalId = null;
      updateRestDisplay(key);
      if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
      return;
    }
    t.remaining--;
    updateRestDisplay(key);
  }, 1000);
}

function updateRestDisplay(key) {
  const el = document.getElementById('rest-timer-' + key);
  if (!el) return;
  const t = S.restTimers[key];
  if (!t) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  el.className     = 'rest-timer-display';

  if (t.remaining <= 0) {
    el.textContent = '✓  Rest complete — go!';
    el.classList.add('done');
  } else {
    const m = Math.floor(t.remaining / 60);
    const s = t.remaining % 60;
    const timeStr = m + ':' + String(s).padStart(2, '0');
    if (t.remaining <= 10) {
      el.innerHTML  = '⏱  Rest: <strong>' + timeStr + '</strong>';
      el.classList.add('urgent');
    } else {
      el.textContent = '⏱  Rest: ' + timeStr;
    }
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtRestRange(minS, maxS) {
  if (minS == null || maxS == null) return null;
  if (minS >= 60 && maxS >= 60) {
    const lo = minS / 60, hi = maxS / 60;
    return lo === hi ? `Rest ${lo} min` : `Rest ${lo}–${hi} min`;
  }
  return `Rest ${minS}–${maxS}s`;
}

const ROLE_LABELS = {
  main:         'Main Lift',
  supplemental: 'Supplemental',
  accessory:    'Accessory',
  primer:       'Primer',
  remediation:  'Support / Rehab',
  finisher:     'Finisher',
};

async function renderSessionBody() {
  const body = document.getElementById('session-body');
  let html   = '';

  // Inline readiness widget — shows saved state if already logged today
  html += await resolveInlineReadinessCard();

  if (S.activeSession.session_notes) {
    html += `<div class="info-card">📋 ${S.activeSession.session_notes}</div>`;
  }

  if (S.plannedExercises.length === 0) {
    html += `<div class="info-card" style="border-color:var(--border);color:var(--muted)">
      No exercises planned. Add exercises below, then tap Save on each before finishing.
    </div>`;
  }

  html += '<div id="exercise-list">';
  // Planned exercises
  S.plannedExercises.forEach(pe => {
    // Skip conditioning-type exercises — they are logged via the conditioning form, not as strength sets
    if (pe.exercise && pe.exercise.exercise_type === 'conditioning') return;
    const savedSets = S.savedExercises[pe.id];
    if (savedSets) {
      // Already saved — render read-only card
      html += buildSavedExCard(`p-${pe.id}`, pe.exercise.name, pe.exercise.id, savedSets, pe.superset_group);
    } else {
      // Editable card
      const st     = S.exState[pe.id];
      const ex     = pe.exercise;
      const exName = st.swappedTo ? st.swappedTo.name : ex.name;
      const exId   = st.swappedTo ? st.swappedTo.id  : ex.id;

      // Column header reps label matches current measure type
      const repsColLbl  = (st.measureType || 'reps') === 'time' ? 'SECS' : (st.measureType || 'reps') === 'dist' ? 'YDS' : 'REPS';
      const colHdrHtml  = `
        <div class="set-col-header" id="colhdr-p-${pe.id}">
          <span class="set-col-num">SET</span>
          <div class="set-col-fields">
            <span class="set-col-field">LB</span>
            <span class="set-col-field" id="col-reps-lbl-p-${pe.id}">${repsColLbl}</span>
            <span class="set-col-field">RPE</span>
          </div>
          <span class="set-col-check">✓</span>
          <span class="set-col-del"></span>
        </div>`;

      // Role label (e.g. "Main Lift", "Supplemental")
      const roleLabel   = pe.exercise_role ? ROLE_LABELS[pe.exercise_role] || pe.exercise_role : null;
      const groupParts  = [];
      if (pe.superset_group) groupParts.push(`SUPERSET ${pe.superset_group.toUpperCase()}`);
      if (roleLabel)         groupParts.push(roleLabel.toUpperCase());
      const groupHtml   = groupParts.length
        ? `<div class="ex-role">${groupParts.join('  ·  ')}</div>` : '';

      const swapNoteHtml = st.swappedTo
        ? `<div class="ex-swap-note">↕ swapped from ${ex.name}</div>` : '';

      let targetParts = [];
      if (pe.target_load)  targetParts.push(`${pe.target_load} lb`);
      if (pe.reps_display) targetParts.push(pe.reps_display);
      else if (pe.reps_low) targetParts.push(
        pe.reps_high && pe.reps_high !== pe.reps_low
          ? `${pe.reps_low}–${pe.reps_high} reps` : `${pe.reps_low} reps`);
      if (pe.target_sets)  targetParts.push(`${pe.target_sets} sets`);
      if (pe.rpe_low)      targetParts.push(
        pe.rpe_high && pe.rpe_high !== pe.rpe_low
          ? `RPE ${pe.rpe_low}–${pe.rpe_high}` : `RPE ${pe.rpe_low}`);
      if (pe.tempo)        targetParts.push(`Tempo ${pe.tempo}`);
      let targetHtml = targetParts.join(' · ');
      if (pe.coach_notes)  targetHtml += (targetHtml ? '<br>' : '') + `<em>${pe.coach_notes}</em>`;

      // Rest range — from min/max if available, fall back to single rest_seconds
      const restRange = fmtRestRange(pe.rest_seconds_min, pe.rest_seconds_max)
        || (pe.rest_seconds ? `Rest ${pe.rest_seconds}s` : null);
      const restHtml = restRange ? `<br><span class="ex-rest">⏱ ${restRange}</span>` : '';

      const pmt         = st.measureType || 'reps';
      const setRowsHtml = buildSetRows(`p-${pe.id}`, st.setCount, st.skipped);
      const safeExName  = exName.replace(/'/g, "\\'");
      const measureRowHtml = st.skipped ? '' : `
          <div class="measure-chip-wrap">
            <select class="measure-chip${pmt!=='reps'?' non-reps':''}" onchange="changeMeasureType('p-${pe.id}',this.value)" id="mchip-p-${pe.id}">
              <option value="reps"${pmt==='reps'?' selected':''}>Reps</option>
              <option value="time"${pmt==='time'?' selected':''}>Time (sec)</option>
              <option value="dist"${pmt==='dist'?' selected':''}>Distance (yds)</option>
            </select>
          </div>`;

      html += `
        <div class="ex-card ex-collapsed ${st.skipped ? 'skipped' : ''}" id="ex-card-p-${pe.id}">
          ${groupHtml}
          <div class="ex-header">
            <span class="drag-handle">≡</span>
            <span class="ex-name" onclick="openExerciseHistory('${exId}','${safeExName}')">${exName}</span>
            <div class="ex-header-right">
              <span class="ex-swap" onclick="openSwap('${pe.id}')">&#8644; swap</span>
              <button class="ex-collapse-btn" onclick="toggleExCard('p-${pe.id}')">&#9660;</button>
            </div>
          </div>
          <div class="ex-body">
          ${swapNoteHtml}
          ${measureRowHtml}
          ${(targetHtml || restHtml) ? `<div class="ex-target">${targetHtml}${restHtml}</div>` : ''}
          <div class="rest-timer-display" id="rest-timer-p-${pe.id}"></div>
          ${colHdrHtml}
          <div class="sets-wrap" id="sets-p-${pe.id}">${setRowsHtml}</div>
          <button class="add-set-btn" id="addbtn-p-${pe.id}"
            onclick="addSet('p-${pe.id}','${pe.id}',false)"
            ${st.skipped ? 'disabled style="opacity:.3"' : ''}>＋ Add Set</button>
          <textarea class="notes-input" id="notes-p-${pe.id}"
            placeholder="Notes for coach…"
            ${st.skipped ? 'disabled' : ''}></textarea>
          <div class="ex-footer">
            <button class="skip-btn ${st.skipped ? 'skipped' : ''}"
              onclick="toggleSkip('${pe.id}')">
              ${st.skipped ? 'Skipped ✓' : 'Skip'}
            </button>
            <button class="pain-flag-btn" id="pflag-p-${pe.id}"
              onclick="togglePainFlag('p-${pe.id}','${exName.replace(/'/g,"\\'")}')">🚩 Pain</button>
            <button class="save-ex-btn" id="save-p-${pe.id}"
              onclick="saveExercise('${pe.id}')">Save</button>
          </div>
          </div>
        </div>`;
    }
  });

  // Added exercises — saved card if real data exists, editable tile otherwise
  S.addedExercises.forEach(ae => {
    const key       = `a-${ae.localId}`;
    const savedSets = S.savedExercises[ae.localId];
    if (savedSets && savedSets.length > 0) {
      html += buildSavedExCard(key, ae.exName, ae.exId, savedSets, null);
    } else {
      const mt = ae.measureType || 'reps';
      html += `
      <div class="ex-card added-card ex-collapsed" id="ex-card-${key}">
        <div class="ex-header">
          <span class="drag-handle">≡</span>
          <span class="ex-name">${ae.exName}</span>
          <div class="ex-header-right">
            <span class="ex-swap" onclick="openAddedSwap('${ae.localId}')">⇄ swap</span>
            <button class="ex-collapse-btn" onclick="toggleExCard('${key}')">&#9660;</button>
          </div>
        </div>
        <div class="ex-body">
        ${ae.swappedFrom ? `<div class="ex-swap-note">↕ swapped from ${ae.swappedFrom}</div>` : ''}
        <div class="measure-chip-wrap">
          <select class="measure-chip${mt!=='reps'?' non-reps':''}" onchange="changeMeasureType('${key}',this.value)" id="mchip-${key}">
            <option value="reps"${mt==='reps'?' selected':''}>Reps</option>
            <option value="time"${mt==='time'?' selected':''}>Time (sec)</option>
            <option value="dist"${mt==='dist'?' selected':''}>Distance (yds)</option>
          </select>
        </div>
        <div class="set-col-header">
          <span class="set-col-num">SET</span>
          <div class="set-col-fields">
            <span class="set-col-field">LB</span>
            <span class="set-col-field" id="col-reps-lbl-${key}">${mt === 'time' ? 'SECS' : mt === 'dist' ? 'YDS' : 'REPS'}</span>
            <span class="set-col-field">RPE</span>
          </div>
          <span class="set-col-check">✓</span>
          <span class="set-col-del"></span>
        </div>
        <div class="sets-wrap" id="sets-${key}">${buildSetRows(key, ae.setCount, false)}</div>
        <button class="add-set-btn" onclick="addSet('${key}','${ae.localId}',true)">＋ Add Set</button>
        <textarea class="notes-input" id="notes-${key}" placeholder="Notes…"></textarea>
        <div class="ex-footer">
          <button class="remove-btn" onclick="removeAdded('${ae.localId}')">Remove</button>
          <button class="pain-flag-btn" id="pflag-${key}"
            onclick="togglePainFlag('${key}','${ae.exName.replace(/'/g,"\\'")}')">🚩 Pain</button>
          <button class="save-ex-btn" id="save-${key}"
            onclick="saveAddedExercise('${ae.localId}')">Save</button>
        </div>
        </div>
      </div>`;
    }
  });

  html += '</div>'; // end #exercise-list
  html += `<button class="add-ex-btn" id="session-add-ex-btn" onclick="openAddExSheet()">＋  Add Exercise</button>`;

  // Session summary footer
  const isCompleted = S.activeCompletedSession?.status === 'completed';
  const rpeVal      = S.activeCompletedSession?.overall_rpe || '';
  const notesVal    = S.activeCompletedSession?.session_notes || '';
  html += `
    <div class="divider"></div>
    <div class="form-section-label">Session Summary (optional)</div>
    <div class="session-meta-row">
      <div class="sf">
        <label style="display:block;font-size:10px;color:var(--muted);text-align:center;margin-bottom:3px">Overall RPE</label>
        <input type="number" step="0.5" min="1" max="10" inputmode="decimal"
          id="overall-rpe" placeholder="—" value="${rpeVal}"
          ${isCompleted ? 'disabled' : ''}
          style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:16px;text-align:center;padding:9px 2px">
      </div>
      <div class="notes-wrap">
        <label>Session notes</label>
        <textarea class="notes-input" id="session-notes" style="height:40px"
          placeholder="How'd it feel?…"
          ${isCompleted ? 'disabled' : ''}>${notesVal}</textarea>
      </div>
    </div>`;

  body.innerHTML = html;

  // Restore checkbox states and rest timer displays after re-render
  Object.entries(S.checkedSets || {}).forEach(function([exKey, sets]) {
    Object.entries(sets).forEach(function([idx, checked]) {
      if (!checked) return;
      const row = document.getElementById('setrow-' + exKey + '-' + idx);
      const cb  = document.getElementById('cb-' + exKey + '-' + idx);
      if (row) row.classList.add('set-checked');
      if (cb)  { cb.classList.add('checked'); cb.textContent = '✓'; }
    });
  });
  Object.keys(S.restTimers || {}).forEach(function(key) { updateRestDisplay(key); });

  // Pre-fill planned load and reps into editable set rows.
  // restoreDraft() runs after this and will overwrite with any values the
  // athlete already entered, so planned values are only the initial default.
  S.plannedExercises.forEach(pe => {
    if (S.savedExercises[pe.id]) return;  // already saved — read-only card
    const st = S.exState[pe.id];
    if (!st || st.skipped) return;
    const key      = `p-${pe.id}`;
    const count    = st.setCount || 0;
    const fillLoad = pe.target_load != null ? pe.target_load : null;
    const fillReps = pe.reps_low   != null ? pe.reps_low    : null;
    for (let i = 0; i < count; i++) {
      if (fillLoad != null) {
        const el = document.getElementById(`load-${key}-${i}`);
        if (el) el.value = fillLoad;
      }
      if (fillReps != null && (st.measureType || 'reps') === 'reps') {
        const el = document.getElementById(`reps-${key}-${i}`);
        if (el) el.value = fillReps;
      }
    }
  });
}

// ── Build saved (read-only) exercise card ─────────────────────────────────────
function buildSavedExCard(key, exName, exId, sets, supersetGroup) {
  const groupHtml  = supersetGroup
    ? `<div class="ex-group">SUPERSET ${supersetGroup.toUpperCase()}</div>` : '';
  const safeExName = exName.replace(/'/g, "\\'");

  const isSkipped = sets.length === 1 && sets[0].is_skipped;
  let setsHtml;

  if (isSkipped) {
    setsHtml = `<div style="color:var(--muted);font-size:13px;padding:8px 0;font-style:italic">Skipped</div>`;
  } else {
    setsHtml = `<div class="sets-wrap" style="margin-bottom:4px">` +
      sets.map(s => {
        const mt        = s.measure_type || 'reps';
        const load      = s.actual_load  != null ? s.actual_load  : '—';
        const repsVal   = mt === 'reps'
          ? (s.actual_reps  != null ? s.actual_reps  : '—')
          : (s.actual_value != null ? s.actual_value : '—');
        const repsLabel = mt === 'time' ? 'sec' : mt === 'dist' ? 'yds' : 'reps';
        const rpe       = s.actual_rpe  != null ? s.actual_rpe  : '—';
        return `
          <div class="set-row-saved">
            <span class="set-num">S${s.set_number}</span>
            <div class="set-vals">
              <div class="set-val">
                <span class="set-val-label">lb</span>
                <span class="set-val-num">${load}</span>
              </div>
              <div class="set-val">
                <span class="set-val-label">${repsLabel}</span>
                <span class="set-val-num">${repsVal}</span>
              </div>
              <div class="set-val">
                <span class="set-val-label">RPE</span>
                <span class="set-val-num">${rpe}</span>
              </div>
            </div>
          </div>`;
      }).join('') + `</div>`;
  }

  const noteText = sets[0]?.notes;
  const noteHtml = noteText
    ? `<div style="font-size:12px;color:var(--muted);margin-top:6px;font-style:italic">${noteText}</div>` : '';

  return `
    <div class="ex-card saved-card ex-collapsed" id="ex-card-${key}">
      ${groupHtml}
      <div class="ex-header">
        <span class="drag-handle">≡</span>
        <span class="ex-name" onclick="openExerciseHistory('${exId}','${safeExName}')">${exName}</span>
        <div class="ex-header-right">
          <div style="display:flex;align-items:center;gap:4px">
          <button class="re-edit-btn" onclick="reEditExercise('${key}')" title="Re-open to edit">✎</button>
          <span class="saved-badge">✓ Saved</span>
        </div>
          <button class="ex-collapse-btn" onclick="toggleExCard('${key}')">&#9660;</button>
        </div>
      </div>
      <div class="ex-body">
        ${setsHtml}${noteHtml}
      </div>
    </div>`;
}

// ── Save exercise (per-exercise submit) ───────────────────────────────────────
async function saveExercise(peId) {
  const btn = document.getElementById(`save-p-${peId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const st  = S.exState[peId];
  const pe  = S.plannedExercises.find(p => p.id === peId);
  if (!pe || !st) { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } return; }

  const key   = `p-${peId}`;
  const exId  = st.swappedTo ? st.swappedTo.id : pe.exercise.id;
  const mt    = st.measureType || 'reps';
  const rawNotes = (document.getElementById(`notes-${key}`)?.value || '').trim();
  const notes = rawNotes || null;
  const rows  = [];

  if (st.skipped) {
    rows.push({
      planned_exercise_id:  peId,
      exercise_id:          exId,
      is_swap:              !!st.swappedTo,
      original_exercise_id: st.swappedTo ? pe.exercise.id : null,
      is_skipped:           true,
      set_number:           1,
      measure_type:         mt,
      notes,
    });
  } else {
    const setCount = document.getElementById(`sets-${key}`)?.querySelectorAll('.set-row').length || 1;
    let hasData = false;
    for (let i = 0; i < setCount; i++) {
      const load     = parseFloat(document.getElementById(`load-${key}-${i}`)?.value) || null;
      const repsRaw  = parseFloat(document.getElementById(`reps-${key}-${i}`)?.value) || null;
      const rpe      = parseFloat(document.getElementById(`rpe-${key}-${i}`)?.value)  || null;
      if (load || repsRaw || rpe) hasData = true;
      const isReps = mt === 'reps';
      rows.push({
        planned_exercise_id:  peId,
        exercise_id:          exId,
        is_swap:              !!st.swappedTo,
        original_exercise_id: st.swappedTo ? pe.exercise.id : null,
        is_skipped:           false,
        set_number:           i + 1,
        measure_type:         mt,
        actual_load:          load,
        actual_reps:          isReps ? (repsRaw != null ? Math.round(repsRaw) : null) : null,
        actual_value:         !isReps ? repsRaw : null,
        actual_rpe:           rpe,
        notes:                i === 0 ? notes : null,
      });
    }
    if (!hasData && !notes) {
      toast('Enter at least one set before saving.');
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      return;
    }
  }

  try {
    if (isOffline) {
      if (!S.activeCompletedSession) {
        const tid = crypto.randomUUID();
        const sp  = { athlete_id: S.athlete.id, planned_session_id: S.activeSession.id,
          session_date: today(), week_of: S.cycle.start_date,
          session_type: S.activeSession.session_type, status: 'in_progress' };
        await idbQueueWrite({ op: 'create_session', tempSessionId: tid, payload: sp });
        S.activeCompletedSession        = { id: tid, _isTemp: true, ...sp };
        S.completed[S.activeSession.id] = S.activeCompletedSession;
      }
      const qRows = rows.map(r => ({ ...r, completed_session_id: S.activeCompletedSession.id }));
      await idbQueueWrite({ op: 'insert_sets', payload: qRows });
      S.savedExercises[peId] = rows;
      clearExerciseDraft(S.activeSession.id, key);
      const offCard = document.getElementById(`ex-card-${key}`);
      if (offCard) {
        const exName    = st.swappedTo ? st.swappedTo.name : pe.exercise.name;
        const exIdSaved = st.swappedTo ? st.swappedTo.id   : pe.exercise.id;
        offCard.outerHTML = buildSavedExCard(key, exName, exIdSaved, rows.map((r, i) => ({
          set_number: i+1, actual_load: r.actual_load, actual_reps: r.actual_reps,
          actual_rpe: r.actual_rpe, notes: r.notes, is_skipped: r.is_skipped,
        })), pe.superset_group);
      }
      toast('Saved offline ✓');
      return;
    }
    // Lazy-create completed_session if this is the first save
    if (!S.activeCompletedSession) {
      const { data: cs, error: csErr } = await db.from('completed_sessions').insert({
        athlete_id:         S.athlete.id,
        planned_session_id: S.activeSession.id,
        session_date:       today(),
        week_of:            S.cycle.start_date,
        session_type:       S.activeSession.session_type,
        status:             'in_progress',
      }).select().single();
      if (csErr) throw csErr;
      S.activeCompletedSession         = cs;
      S.completed[S.activeSession.id]  = cs;
    }

    // Attach session id to all rows
    const insertRows = rows.map(r => ({ ...r, completed_session_id: S.activeCompletedSession.id }));
    const { error: rowsErr } = await db.from('completed_strength_sets').insert(insertRows);
    if (rowsErr) throw rowsErr;

    // Mark locally as saved and lock the card
    S.savedExercises[peId] = rows;
    clearExerciseDraft(S.activeSession.id, key);
    const card = document.getElementById(`ex-card-${key}`);
    if (card) {
      const exName = st.swappedTo ? st.swappedTo.name : pe.exercise.name;
      const exIdSaved = st.swappedTo ? st.swappedTo.id : pe.exercise.id;
      card.outerHTML = buildSavedExCard(key, exName, exIdSaved, rows.map((r,i) => ({
        set_number:  i + 1,
        actual_load: r.actual_load,
        actual_reps: r.actual_reps,
        actual_rpe:  r.actual_rpe,
        notes:       r.notes,
        is_skipped:  r.is_skipped,
      })), pe.superset_group);
    }
    toast('Saved ✓');
  } catch (err) {
    console.error(err);
    toast('Error saving. Check connection and try again.', 4000);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

// ── Save added exercise ───────────────────────────────────────────────────────
async function saveAddedExercise(localId) {
  const key = `a-${localId}`;
  const btn = document.getElementById(`save-${key}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const ae    = S.addedExercises.find(a => String(a.localId) === String(localId));
  if (!ae) { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } return; }

  const amt       = ae.measureType || 'reps';
  const rawNotes2 = (document.getElementById(`notes-${key}`)?.value || '').trim();
  const notes     = rawNotes2 || null;
  const setsWrap  = document.getElementById(`sets-${key}`);
  const setRows   = setsWrap ? Array.from(setsWrap.querySelectorAll('.set-row')) : [];
  const setCount  = setRows.length || 1;
  const rows      = [];
  let   hasData   = false;

  for (let i = 0; i < setCount; i++) {
    // Support both named inputs and positional fallback
    const loadEl  = document.getElementById(`load-${key}-${i}`) ||
                    (setRows[i] ? setRows[i].querySelector('input[id^="load-"]') : null);
    const repsEl  = document.getElementById(`reps-${key}-${i}`) ||
                    (setRows[i] ? setRows[i].querySelector('input[id^="reps-"]') : null);
    const rpeEl   = document.getElementById(`rpe-${key}-${i}`) ||
                    (setRows[i] ? setRows[i].querySelector('input[id^="rpe-"]')  : null);
    const load    = parseFloat(loadEl?.value) || null;
    const repsRaw = parseFloat(repsEl?.value) || null;
    const rpe     = parseFloat(rpeEl?.value)  || null;
    if (load || repsRaw || rpe) hasData = true;
    const isReps  = amt === 'reps';
    rows.push({
      exercise_id:  ae.exId,
      is_added:     true,
      is_skipped:   false,
      set_number:   i + 1,
      measure_type: amt,
      actual_load:  load,
      actual_reps:  isReps ? (repsRaw != null ? Math.round(repsRaw) : null) : null,
      actual_value: !isReps ? repsRaw : null,
      actual_rpe:   rpe,
      notes:        i === 0 ? notes : null,
    });
  }

  if (!hasData && !notes) {
    toast('Enter at least one set before saving.');
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    return;
  }

  try {
    if (isOffline) {
      if (!S.activeCompletedSession) {
        const tid = crypto.randomUUID();
        const sp  = { athlete_id: S.athlete.id, planned_session_id: S.activeSession.id,
          session_date: today(), week_of: S.cycle.start_date,
          session_type: S.activeSession.session_type, status: 'in_progress' };
        await idbQueueWrite({ op: 'create_session', tempSessionId: tid, payload: sp });
        S.activeCompletedSession        = { id: tid, _isTemp: true, ...sp };
        S.completed[S.activeSession.id] = S.activeCompletedSession;
      }
      const qRows = rows.map(r => ({ ...r, completed_session_id: S.activeCompletedSession.id }));
      await idbQueueWrite({ op: 'insert_sets', payload: qRows });
      S.savedExercises[localId] = rows;
      clearExerciseDraft(S.activeSession.id, `a-${ae.exId}`);
      const offCard = document.getElementById(`ex-card-${key}`);
      if (offCard) {
        offCard.outerHTML = buildSavedExCard(key, ae.exName, ae.exId, rows.map((r, i) => ({
          set_number: i+1, actual_load: r.actual_load, actual_reps: r.actual_reps,
          actual_rpe: r.actual_rpe, notes: r.notes, is_skipped: false,
        })), null);
      }
      toast('Saved offline ✓');
      return;
    }
    if (!S.activeCompletedSession) {
      const { data: cs, error: csErr } = await db.from('completed_sessions').insert({
        athlete_id:         S.athlete.id,
        planned_session_id: S.activeSession.id,
        session_date:       today(),
        week_of:            S.cycle.start_date,
        session_type:       S.activeSession.session_type,
        status:             'in_progress',
      }).select().single();
      if (csErr) throw csErr;
      S.activeCompletedSession        = cs;
      S.completed[S.activeSession.id] = cs;
    }

    const insertRows = rows.map(r => ({ ...r, completed_session_id: S.activeCompletedSession.id }));
    // Remove placeholder row (set_number=0) before inserting real data
    await db.from('completed_strength_sets').delete()
      .eq('completed_session_id', S.activeCompletedSession.id)
      .eq('exercise_id', ae.exId).eq('is_added', true).eq('set_number', 0);
    const { error: rowsErr } = await db.from('completed_strength_sets').insert(insertRows);
    if (rowsErr) throw rowsErr;

    S.savedExercises[localId] = rows;
    clearExerciseDraft(S.activeSession.id, `a-${ae.exId}`);
    const card = document.getElementById(`ex-card-${key}`);
    if (card) {
      card.outerHTML = buildSavedExCard(key, ae.exName, ae.exId, rows.map((r,i) => ({
        set_number:  i + 1,
        actual_load: r.actual_load,
        actual_reps: r.actual_reps,
        actual_rpe:  r.actual_rpe,
        notes:       r.notes,
        is_skipped:  false,
      })), null);
    }
    toast('Saved ✓');
  } catch (err) {
    console.error(err);
    toast('Error saving. Check connection and try again.', 4000);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

// ── Exercise history panel ────────────────────────────────────────────────────
function epley(load, reps) {
  if (!load || !reps || reps < 1 || reps > 12) return null;
  return Math.round(load * (1 + reps / 30));
}

async function openExerciseHistory(exId, exName) {
  document.getElementById('hist-title').textContent = exName;
  document.getElementById('hist-body').innerHTML =
    '<div style="padding:32px;text-align:center;color:var(--muted);font-size:14px">Loading…</div>';
  document.getElementById('hist-overlay').classList.add('open');
  document.getElementById('hist-sheet').classList.add('open');
  await loadExerciseHistory(exId);
}

function closeHistorySheet() {
  document.getElementById('hist-overlay').classList.remove('open');
  document.getElementById('hist-sheet').classList.remove('open');
}

async function loadExerciseHistory(exId) {
  const body = document.getElementById('hist-body');
  try {
    // Step 1: get the athlete's recent completed sessions (last 20)
    const { data: recentSessions } = await db.from('completed_sessions')
      .select('id,session_date,session_type')
      .eq('athlete_id', S.athlete.id)
      .eq('status', 'completed')
      .order('session_date', { ascending: false })
      .limit(20);

    if (!recentSessions || recentSessions.length === 0) {
      body.innerHTML = '<div class="hist-empty">No sessions logged yet.</div>';
      return;
    }

    const sessionIds  = recentSessions.map(s => s.id);
    const sessionMap  = {};
    recentSessions.forEach(s => { sessionMap[s.id] = s; });

    // Step 2: get all non-skipped sets for this exercise from those sessions
    const { data: sets } = await db.from('completed_strength_sets')
      .select('completed_session_id,set_number,actual_load,actual_reps,actual_rpe,notes')
      .eq('exercise_id', exId)
      .eq('is_skipped', false)
      .in('completed_session_id', sessionIds)
      .order('set_number');

    if (!sets || sets.length === 0) {
      body.innerHTML = '<div class="hist-empty">No history found for this exercise.</div>';
      return;
    }

    // Group by session, take 3 most recent
    const groups = {};
    sets.forEach(s => {
      if (!groups[s.completed_session_id]) groups[s.completed_session_id] = [];
      groups[s.completed_session_id].push(s);
    });

    const history = Object.keys(groups)
      .map(csId => ({ ...sessionMap[csId], sets: groups[csId] }))
      .filter(s => s.session_date)
      .sort((a, b) => b.session_date.localeCompare(a.session_date))
      .slice(0, 3);

    if (history.length === 0) {
      body.innerHTML = '<div class="hist-empty">No history found for this exercise.</div>';
      return;
    }

    let html = '';
    history.forEach(sess => {
      const d = new Date(sess.session_date + 'T00:00:00');
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      // Find top set by e1RM (or highest load if reps > 12)
      let topIdx  = 0;
      let topE1RM = 0;
      sess.sets.forEach((s, i) => {
        const e = epley(s.actual_load, s.actual_reps);
        if (e && e > topE1RM) { topE1RM = e; topIdx = i; }
        else if (!e && s.actual_load && s.actual_load > topE1RM) { topE1RM = s.actual_load; topIdx = i; }
      });

      html += `<div class="hist-session">
        <div class="hist-session-header">${dateStr}  ·  ${sess.session_type || 'Session'}</div>`;

      sess.sets.forEach((s, i) => {
        const load   = s.actual_load != null ? `${s.actual_load} lb` : '—';
        const reps   = s.actual_reps != null ? `${s.actual_reps} reps` : '—';
        const rpe    = s.actual_rpe  != null ? ` · RPE ${s.actual_rpe}` : '';
        const e1rm   = epley(s.actual_load, s.actual_reps);
        const isTop  = i === topIdx;
        const e1rmHtml = e1rm
          ? `<span class="hist-e1rm">e1RM ${e1rm}</span>` : '';
        html += `
          <div class="hist-set-row ${isTop ? 'top-set' : ''}">
            <span class="set-num">S${s.set_number}</span>
            <span>${load} · ${reps}${rpe}</span>
            ${e1rmHtml}
          </div>`;
      });

      // Notes saved once per exercise — grab from first set that has them
      const sessExNotes = sess.sets.map(s => s.notes).find(n => n);
      if (sessExNotes) html += `<div class="hist-notes">📝 ${sessExNotes}</div>`;

      html += `</div>`;
    });

    body.innerHTML = html;
  } catch (err) {
    console.error(err);
    body.innerHTML = '<div class="hist-empty" style="color:var(--danger)">Error loading history.</div>';
  }
}

// ── Finish session (finalizes completed_sessions record) ──────────────────────
// ── Exercise pain flag ────────────────────────────────────────────────────────
function togglePainFlag(key, exName) {
  S.painFlags = S.painFlags || {};
  if (S.painFlags[key]) {
    delete S.painFlags[key];
  } else {
    S.painFlags[key] = exName;
  }
  const btn = document.getElementById(`pflag-${key}`);
  if (btn) btn.classList.toggle('flagged', !!S.painFlags[key]);
}

function showConditioningPrompt(onYes, onNo) {
  const pc   = S.plannedConditioning;
  const desc = pc
    ? (pc.modality || 'Conditioning')
        + (pc.workout_type     ? ' · ' + pc.workout_type     : '')
        + (pc.target_duration_min ? ' · ' + pc.target_duration_min + ' min' : '')
    : 'Conditioning block';
  const overlay = document.createElement('div');
  overlay.className = 'pain-prompt-overlay';
  overlay.innerHTML = `
    <div class="pain-prompt-box">
      <div class="pain-prompt-title">Log conditioning?</div>
      <div class="pain-prompt-sub">You had a conditioning block planned:<br><strong>${desc}</strong><br>Log it now?</div>
      <div class="pain-prompt-btns">
        <button class="pain-prompt-yes" id="cpYes">Log it</button>
        <button class="pain-prompt-no"  id="cpNo">Skip</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('cpYes').onclick = () => { overlay.remove(); onYes(); };
  document.getElementById('cpNo').onclick  = () => { overlay.remove(); onNo();  };
}

function checkAndPromptConditioning(successTitle, successMsg) {
  if (S.plannedConditioning && !S._conditioningLogged) {
    showConditioningPrompt(
      () => {
        // Keep user on the session screen and switch to conditioning logging
        const btn = document.getElementById('submit-btn');
        btn.disabled    = false;
        btn.className   = 'btn';
        btn.textContent = 'Log Conditioning';
        renderConditioningSessionBody();
        showScreen('session');
      },
      () => showSuccess(successTitle, successMsg)
    );
  } else {
    showSuccess(successTitle, successMsg);
  }
}

function showPainPrompt(onYes, onNo) {
  const flaggedNames = Object.values(S.painFlags || {});
  if (!flaggedNames.length) { onNo(); return; }
  const nameList = flaggedNames.map(n => `<strong>${n}</strong>`).join(', ');
  const overlay = document.createElement('div');
  overlay.className = 'pain-prompt-overlay';
  overlay.innerHTML = `
    <div class="pain-prompt-box">
      <div class="pain-prompt-title">Pain flagged</div>
      <div class="pain-prompt-sub">You flagged discomfort on ${nameList}. Would you like to add more detail to your pain log?</div>
      <div class="pain-prompt-btns">
        <button class="pain-prompt-yes" id="ppYes">Yes, log it</button>
        <button class="pain-prompt-no"  id="ppNo">Skip</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('ppYes').onclick = () => { overlay.remove(); onYes(); };
  document.getElementById('ppNo').onclick  = () => { overlay.remove(); onNo();  };
}

async function finishSession() {
  const btn          = document.getElementById('submit-btn');
  const overallRpe   = parseFloat(document.getElementById('overall-rpe')?.value)    || null;
  const sessionNotes = (document.getElementById('session-notes')?.value || '').trim() || null;

  btn.disabled    = true;
  btn.textContent = 'Finishing…';

  if (isOffline) {
    if (S.activeCompletedSession) {
      await idbQueueWrite({ op: 'finish_session_update',
        tempSessionId: S.activeCompletedSession.id,
        sessionId: S.activeCompletedSession._isTemp ? null : S.activeCompletedSession.id,
        payload: { status: 'completed', overall_rpe: overallRpe, session_notes: sessionNotes } });
      S.completed[S.activeSession.id] = { ...S.activeCompletedSession, status: 'completed' };
    } else {
      const tid = crypto.randomUUID();
      const sp  = { athlete_id: S.athlete.id, planned_session_id: S.activeSession.id,
        session_date: today(), week_of: S.cycle.start_date,
        session_type: S.activeSession.session_type,
        status: 'completed', overall_rpe: overallRpe, session_notes: sessionNotes };
      await idbQueueWrite({ op: 'finish_session_insert', payload: sp });
      S.activeCompletedSession        = { id: tid, _isTemp: true, ...sp };
      S.completed[S.activeSession.id] = S.activeCompletedSession;
    }
    const flaggedEx = Object.values(S.painFlags || {}).join(', ');
    showPainPrompt(
      () => { openPainSheet({newForm:true, exerciseName: flaggedEx}); showSuccess('Session Complete', 'Saved offline — will sync when connected.'); },
      () => { showSuccess('Session Complete', 'Saved offline — will sync when connected.'); }
    );
    S.painFlags = {};
    return;
  }

  try {
    if (S.activeCompletedSession) {
      // Update existing in_progress record to completed
      await db.from('completed_sessions').update({
        status:        'completed',
        overall_rpe:   overallRpe,
        session_notes: sessionNotes,
      }).eq('id', S.activeCompletedSession.id);
      S.completed[S.activeSession.id] = {
        ...S.activeCompletedSession, status: 'completed', overall_rpe: overallRpe, session_notes: sessionNotes,
      };
    } else {
      // Nothing was saved — create a bare completed record
      const { data: cs, error } = await db.from('completed_sessions').insert({
        athlete_id:         S.athlete.id,
        planned_session_id: S.activeSession.id,
        session_date:       today(),
        week_of:            S.cycle.start_date,
        session_type:       S.activeSession.session_type,
        status:             'completed',
        overall_rpe:        overallRpe,
        session_notes:      sessionNotes,
      }).select().single();
      if (error) throw error;
      S.activeCompletedSession        = cs;
      S.completed[S.activeSession.id] = cs;
    }
    const flaggedEx = Object.values(S.painFlags || {}).join(', ');
    showPainPrompt(
      () => { openPainSheet({newForm:true, exerciseName: flaggedEx}); checkAndPromptConditioning('Session Complete', 'All work saved. Great effort.'); },
      () => { checkAndPromptConditioning('Session Complete', 'All work saved. Great effort.'); }
    );
    S.painFlags = {};
  } catch (err) {
    console.error(err);
    toast('Error finishing session. Try again.', 4000);
    btn.disabled    = false;
    btn.textContent = 'Finish Session';
  }
}

// ── Submit router ─────────────────────────────────────────────────────────────
function handleSubmit() {
  if (S.activeSession?.session_type === 'Conditioning Only') {
    submitConditioningSession();
  } else {
    finishSession();
  }
}

// ── Session draft — persist pre-filled (unsaved) input values across re-entries ──
// Draft is stored in IDB under sessionDraftCache.
// Keys: "p-{peId}" for planned, "a-{exId}" for added (exId is stable; localId is not).

async function captureDraft() {
  if (!S.activeSession) return;
  const sessionId = S.activeSession.id;
  const draft = {};

  // Planned exercises — only capture unsaved (no entry in S.savedExercises)
  S.plannedExercises.forEach(pe => {
    if (S.savedExercises[pe.id]) return;
    const key  = `p-${pe.id}`;
    const wrap = document.getElementById(`sets-${key}`);
    const st   = S.exState[pe.id];
    if (!wrap) return;
    const rowCount = wrap.querySelectorAll('.set-row').length;
    const sets = [];
    for (let i = 0; i < rowCount; i++) {
      sets.push({
        load: document.getElementById(`load-${key}-${i}`)?.value || '',
        reps: document.getElementById(`reps-${key}-${i}`)?.value || '',
        rpe:  document.getElementById(`rpe-${key}-${i}`)?.value  || '',
      });
    }
    const notes      = document.getElementById(`notes-${key}`)?.value || '';
    const swappedTo  = st?.swappedTo || null;
    const hasData    = sets.some(s => s.load || s.reps || s.rpe) || notes;
    if (hasData || swappedTo) draft[key] = { sets, notes, swappedTo };
  });

  // Added exercises — only capture unsaved
  S.addedExercises.forEach(ae => {
    if (S.savedExercises[ae.localId]) return;
    const key  = `a-${ae.localId}`;
    const wrap = document.getElementById(`sets-${key}`);
    if (!wrap) return;
    const rowCount = wrap.querySelectorAll('.set-row').length;
    const sets = [];
    for (let i = 0; i < rowCount; i++) {
      sets.push({
        load: document.getElementById(`load-${key}-${i}`)?.value || '',
        reps: document.getElementById(`reps-${key}-${i}`)?.value || '',
        rpe:  document.getElementById(`rpe-${key}-${i}`)?.value  || '',
      });
    }
    const notes    = document.getElementById(`notes-${key}`)?.value || '';
    const hasData  = sets.some(s => s.load || s.reps || s.rpe) || notes;
    if (hasData) draft[`a-${ae.exId}`] = { sets, notes }; // key by exId, not localId
  });

  // Capture exercise order from DOM
  const exList = document.getElementById('exercise-list');
  if (exList) {
    const orderKeys = [];
    exList.querySelectorAll('.ex-card').forEach(card => {
      const rawKey = card.id.replace('ex-card-', '');
      if (rawKey.startsWith('p-')) {
        orderKeys.push(rawKey);
      } else if (rawKey.startsWith('a-')) {
        const localId = rawKey.slice(2);
        const ae = S.addedExercises.find(a => String(a.localId) === localId);
        if (ae) orderKeys.push(`a-${ae.exId}`);
      }
    });
    if (orderKeys.length > 1) draft['__order'] = orderKeys;
  }

  try {
    const allDrafts = (await idbGet('sessionDraftCache')) || {};
    if (Object.keys(draft).length > 0) {
      allDrafts[sessionId] = draft;
    } else {
      delete allDrafts[sessionId];
    }
    await idbSet('sessionDraftCache', allDrafts);
  } catch (err) {
    console.error('draft capture failed:', err);
  }
}

async function restoreDraft(sessionId) {
  try {
    const allDrafts = (await idbGet('sessionDraftCache')) || {};
    const draft = allDrafts[sessionId];
    if (!draft) return;

    // Planned exercises
    S.plannedExercises.forEach(pe => {
      if (S.savedExercises[pe.id]) return;
      const key = `p-${pe.id}`;
      const d   = draft[key];
      if (!d) return;
      // Add extra set rows if draft has more than the default
      const wrap = document.getElementById(`sets-${key}`);
      if (!wrap) return;
      const existing = wrap.querySelectorAll('.set-row').length;
      for (let i = existing; i < d.sets.length; i++) addSet(key, pe.id, false);
      // Fill in values
      d.sets.forEach((s, i) => {
        const loadEl = document.getElementById(`load-${key}-${i}`);
        const repsEl = document.getElementById(`reps-${key}-${i}`);
        const rpeEl  = document.getElementById(`rpe-${key}-${i}`);
        if (loadEl) loadEl.value = s.load;
        if (repsEl) repsEl.value = s.reps;
        if (rpeEl)  rpeEl.value  = s.rpe;
      });
      const notesEl = document.getElementById(`notes-${key}`);
      if (notesEl) notesEl.value = d.notes || '';
    });

    // Added exercises — match by exId
    S.addedExercises.forEach(ae => {
      if (S.savedExercises[ae.localId]) return;
      const d   = draft[`a-${ae.exId}`];
      if (!d) return;
      const key  = `a-${ae.localId}`;
      const wrap = document.getElementById(`sets-${key}`);
      if (!wrap) return;
      const existing = wrap.querySelectorAll('.set-row').length;
      for (let i = existing; i < d.sets.length; i++) addSet(key, ae.localId, true);
      d.sets.forEach((s, i) => {
        const loadEl = document.getElementById(`load-${key}-${i}`);
        const repsEl = document.getElementById(`reps-${key}-${i}`);
        const rpeEl  = document.getElementById(`rpe-${key}-${i}`);
        if (loadEl) loadEl.value = s.load;
        if (repsEl) repsEl.value = s.reps;
        if (rpeEl)  rpeEl.value  = s.rpe;
      });
      const notesEl = document.getElementById(`notes-${key}`);
      if (notesEl) notesEl.value = d.notes || '';
    });
    // Restore swaps for planned exercises — apply to state and DOM
    S.plannedExercises.forEach(pe => {
      if (S.savedExercises[pe.id]) return;
      const key = `p-${pe.id}`;
      const d   = draft[key];
      if (!d?.swappedTo) return;
      const st = S.exState[pe.id];
      if (st) st.swappedTo = d.swappedTo;
      // Update DOM: exercise name and swap note
      const card = document.getElementById(`ex-card-${key}`);
      if (!card) return;
      const nameEl = card.querySelector('.ex-name');
      if (nameEl) nameEl.textContent = d.swappedTo.name;
      if (!card.querySelector('.ex-swap-note')) {
        const origName = pe.exercise?.name || '';
        if (origName) {
          const exBody = card.querySelector('.ex-body');
          if (exBody) exBody.insertAdjacentHTML('afterbegin',
            `<div class="ex-swap-note">⇕ swapped from ${origName}</div>`);
        }
      }
    });

    // Reorder exercise tiles to match saved order
    if (draft.__order) {
      const container = document.getElementById('exercise-list');
      if (container) {
        draft.__order.forEach(key => {
          let cardEl;
          if (key.startsWith('p-')) {
            cardEl = document.getElementById(`ex-card-${key}`);
          } else if (key.startsWith('a-')) {
            const ae = S.addedExercises.find(a => String(a.exId) === key.slice(2));
            if (ae) cardEl = document.getElementById(`ex-card-a-${ae.localId}`);
          }
          if (cardEl) container.appendChild(cardEl);
        });
      }
    }
  } catch (err) {
    console.error('draft restore failed:', err);
  }
}

async function clearExerciseDraft(sessionId, draftKey) {
  try {
    const allDrafts = (await idbGet('sessionDraftCache')) || {};
    if (allDrafts[sessionId]) {
      delete allDrafts[sessionId][draftKey];
      if (Object.keys(allDrafts[sessionId]).length === 0) delete allDrafts[sessionId];
      await idbSet('sessionDraftCache', allDrafts);
    }
  } catch (_) {}
}

// ── Exercise card collapse / expand ───────────────────────────────────────────
function toggleExCard(key) {
  const card = document.getElementById(`ex-card-${key}`);
  if (!card) return;
  card.classList.toggle('ex-collapsed');
}

function initExerciseSort(sessionId) {
  const container = document.getElementById('exercise-list');
  if (!container || typeof Sortable === 'undefined') return;
  if (container._sortable) container._sortable.destroy();
  container._sortable = Sortable.create(container, {
    handle:            '.drag-handle',
    animation:         150,
    forceFallback:     true,
    fallbackTolerance: 3,
    delay:             150,
    delayOnTouchOnly:  true,
    supportPointer:    false,
    ghostClass:        'sortable-ghost',
    chosenClass:       'sortable-chosen',
    onEnd: function() {
      // Rebuild S arrays to match new DOM order
      const newPlanned = [];
      const newAdded   = [];
      container.querySelectorAll('.ex-card').forEach(card => {
        const key = card.id.replace('ex-card-', '');
        if (key.startsWith('p-')) {
          const pe = S.plannedExercises.find(p => p.id === key.slice(2));
          if (pe) newPlanned.push(pe);
        } else if (key.startsWith('a-')) {
          const ae = S.addedExercises.find(a => String(a.localId) === key.slice(2));
          if (ae) newAdded.push(ae);
        }
      });
      if (newPlanned.length || newAdded.length) {
        S.plannedExercises = newPlanned;
        S.addedExercises   = newAdded;
      }
    },
  });
}

// Back button for session screen — capture draft before leaving
async function leaveSession() {
  stopSessionTimer();
  Object.values(S.restTimers || {}).forEach(function(t) {
    if (t && t.intervalId) clearInterval(t.intervalId);
  });
  await captureDraft();
  loadProgram();
}

// ── Set row helpers ───────────────────────────────────────────────────────────
function getMeasureType(key) {
  if (key.startsWith('p-')) {
    const peId = key.slice(2);
    return (S.exState[peId] && S.exState[peId].measureType) || 'reps';
  } else if (key.startsWith('a-')) {
    const localId = key.slice(2);
    const ae = S.addedExercises.find(a => String(a.localId) === String(localId));
    return (ae && ae.measureType) || 'reps';
  }
  return 'reps';
}

function buildSetRows(key, count, disabled) {
  const mt = getMeasureType(key);
  let html = '';
  for (let i = 0; i < count; i++) html += buildOneSetRow(key, i, disabled, mt);
  return html;
}

function buildOneSetRow(key, idx, disabled, measureType) {
  if (!measureType) measureType = getMeasureType(key);
  const dis     = disabled ? 'disabled' : '';
  const checked = !disabled && (S.checkedSets[key] || {})[idx];
  const rowCls  = 'set-row' + (checked ? ' set-checked' : '');
  const cbCls   = 'set-check' + (checked ? ' checked' : '');
  return `
    <div class="${rowCls}" id="setrow-${key}-${idx}">
      <span class="set-num" style="font-size:13px;min-width:28px">${idx+1}</span>
      <div class="set-fields">
        <div class="sf">
          <input type="number" inputmode="decimal" id="load-${key}-${idx}" placeholder="—" ${dis}
            style="font-size:17px;padding:10px 2px"></div>
        <div class="sf">
          <input type="number" inputmode="numeric" id="reps-${key}-${idx}" placeholder="—" ${dis}
            style="font-size:17px;padding:10px 2px"></div>
        <div class="sf">
          <input type="number" inputmode="decimal" step="0.5" min="1" max="10"
            id="rpe-${key}-${idx}" placeholder="—" ${dis}
            style="font-size:17px;padding:10px 2px"></div>
      </div>
      <button class="${cbCls}" id="cb-${key}-${idx}"
        onclick="toggleSetCheck('${key}',${idx})" ${dis}>${checked ? '✓' : ''}</button>
      <button class="set-del" onclick="removeSet('${key}',${idx})" ${dis}>×</button>
    </div>`;
}

function changeMeasureType(key, type) {
  // Update state
  if (key.startsWith('p-')) {
    const peId = key.slice(2);
    if (S.exState[peId]) S.exState[peId].measureType = type;
  } else if (key.startsWith('a-')) {
    const localId = key.slice(2);
    const ae = S.addedExercises.find(a => String(a.localId) === String(localId));
    if (ae) ae.measureType = type;
  }
  // Update chip styling
  const chip = document.getElementById(`mchip-${key}`);
  if (chip) chip.classList.toggle('non-reps', type !== 'reps');
  // Rebuild set rows preserving current values
  const wrap = document.getElementById(`sets-${key}`);
  if (!wrap) return;
  const rows = Array.from(wrap.querySelectorAll('.set-row'));
  const saved = rows.map((_, i) => ({
    load: document.getElementById(`load-${key}-${i}`)?.value || '',
    reps: document.getElementById(`reps-${key}-${i}`)?.value || '',
    rpe:  document.getElementById(`rpe-${key}-${i}`)?.value  || '',
  }));
  wrap.innerHTML = saved.map((_, i) => buildOneSetRow(key, i, false, type)).join('');
  saved.forEach((s, i) => {
    const lEl = document.getElementById(`load-${key}-${i}`);
    const rEl = document.getElementById(`reps-${key}-${i}`);
    const pEl = document.getElementById(`rpe-${key}-${i}`);
    if (lEl) lEl.value = s.load;
    if (rEl) rEl.value = s.reps;
    if (pEl) pEl.value = s.rpe;
  });
  // Update column header reps label
  const repsLbl = document.getElementById('col-reps-lbl-' + key);
  if (repsLbl) repsLbl.textContent = type === 'time' ? 'SECS' : type === 'dist' ? 'YDS' : 'REPS';
}

// ── Add / remove sets ─────────────────────────────────────────────────────────
function addSet(key, entityId, isAdded) {
  const wrap        = document.getElementById(`sets-${key}`);
  const currentRows = wrap.querySelectorAll('.set-row').length;
  if (isAdded) {
    const ae = S.addedExercises.find(a => String(a.localId) === String(entityId));
    if (ae) ae.setCount = currentRows + 1;
  } else {
    if (S.exState[entityId]) S.exState[entityId].setCount = currentRows + 1;
  }
  wrap.insertAdjacentHTML('beforeend', buildOneSetRow(key, currentRows, false));

  // Copy load / reps / RPE from the previous row into the new one
  if (currentRows > 0) {
    const prevIdx = currentRows - 1;
    const newIdx  = currentRows;
    const prevLoad = document.getElementById(`load-${key}-${prevIdx}`)?.value;
    const prevReps = document.getElementById(`reps-${key}-${prevIdx}`)?.value;
    const prevRpe  = document.getElementById(`rpe-${key}-${prevIdx}`)?.value;
    if (prevLoad) { const el = document.getElementById(`load-${key}-${newIdx}`); if (el) el.value = prevLoad; }
    if (prevReps) { const el = document.getElementById(`reps-${key}-${newIdx}`); if (el) el.value = prevReps; }
    if (prevRpe)  { const el = document.getElementById(`rpe-${key}-${newIdx}`);  if (el) el.value = prevRpe;  }
  }
}

function removeSet(key, idx) {
  const wrap = document.getElementById(`sets-${key}`);
  if (!wrap) return;
  const rows = wrap.querySelectorAll('.set-row');
  if (rows.length <= 1) { toast('Need at least one set row — use Skip instead.'); return; }

  const data = [];
  rows.forEach((row, i) => {
    if (i === idx) return;
    data.push({
      load: document.getElementById(`load-${key}-${i}`)?.value || '',
      reps: document.getElementById(`reps-${key}-${i}`)?.value || '',
      rpe:  document.getElementById(`rpe-${key}-${i}`)?.value  || '',
    });
  });

  let html = '';
  data.forEach((d, i) => { html += buildOneSetRow(key, i, false); });
  wrap.innerHTML = html;
  data.forEach((d, i) => {
    const lEl = document.getElementById(`load-${key}-${i}`);
    const rEl = document.getElementById(`reps-${key}-${i}`);
    const pEl = document.getElementById(`rpe-${key}-${i}`);
    if (lEl) lEl.value = d.load;
    if (rEl) rEl.value = d.reps;
    if (pEl) pEl.value = d.rpe;
  });
}

// ── Skip / unskip exercise ────────────────────────────────────────────────────
function toggleSkip(peId) {
  const st = S.exState[peId];
  if (!st) return;
  st.skipped = !st.skipped;

  const key    = `p-${peId}`;
  const card   = document.getElementById(`ex-card-${key}`);
  const btn    = card.querySelector('.skip-btn');
  const addBtn = document.getElementById(`addbtn-${key}`);
  const notes  = document.getElementById(`notes-${key}`);

  card.querySelectorAll(`#sets-${key} input, #sets-${key} button`).forEach(el => {
    el.disabled = st.skipped;
  });
  if (addBtn) { addBtn.disabled = st.skipped; addBtn.style.opacity = st.skipped ? '.3' : '1'; }
  if (notes)  { notes.disabled = st.skipped; }
  card.classList.toggle('skipped', st.skipped);
  btn.classList.toggle('skipped', st.skipped);
  btn.textContent = st.skipped ? 'Skipped ✓' : 'Skip';
}

