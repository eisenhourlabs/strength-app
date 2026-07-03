// ── Program loading ───────────────────────────────────────────────────────────
async function renderWeek() {
  // Apply any saved display order before rendering
  const savedOrder = await idbGet('sessionOrderCache');
  if (savedOrder?.cycleId === S.cycle?.id && savedOrder.order?.length) {
    const orderMap = {};
    savedOrder.order.forEach((id, i) => { orderMap[id] = i; });
    S.sessions = [...S.sessions].sort((a, b) =>
      (orderMap[a.id] ?? 9999) - (orderMap[b.id] ?? 9999));
  }

  const body = document.getElementById('week-body');
  document.getElementById('week-name').textContent = S.athlete.name;
  if (S.cycle) {
    const weekDate = new Date(S.cycle.start_date + 'T00:00:00');
    const weekStr  = weekDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    document.getElementById('week-block').textContent = `${S.cycle.name}  ·  ${weekStr}`;
  } else {
    document.getElementById('week-block').textContent = '';
  }

  const sessHtml = !S.cycle
    ? '<div class="card"><div class="card-title">No active program</div>' +
      '<div class="card-sub">Your coach hasn\'t pushed a program yet.</div></div>'
    : S.sessions.map(s => {
    const comp       = S.completed[s.id];
    const isCondOnly = s.session_type === 'Conditioning Only';
    const icon       = isCondOnly ? '🚴 ' : '';
    const dayLabel   = s.day_label || '';
    let statusBadge;
    if (!comp) {
      statusBadge = `<span class="badge badge-pending">Pending</span>`;
    } else if (comp.status === 'in_progress') {
      statusBadge = `<span class="badge badge-progress">▶ In Progress</span>`;
    } else {
      statusBadge = `<span class="badge badge-done">✓ Logged</span>`;
    }
    return `
      <div class="card tap" data-sid="${s.id}" onclick="openSession('${s.id}')">
        <div class="session-row">
          <span class="drag-handle" onclick="event.stopPropagation()" style="margin-right:10px;flex-shrink:0">≡</span>
          <div style="flex:1">
            <div class="card-label sess-day-chip" onclick="event.stopPropagation();editDayLabel('${s.id}')">${dayLabel || '<span style="opacity:.45">+ day</span>'} <span class="day-edit-icon">&#9998;</span></div>
            <div class="card-title">${icon}${s.session_type || 'Session'}</div>
            <div class="session-meta">${statusBadge}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <button class="sess-del-btn" onclick="event.stopPropagation();deleteSession('${s.id}')" title="Delete session">🗑</button>
            <div class="arrow">›</div>
          </div>
        </div>
      </div>`;
  }).join('');

  // ── Check-In card ──────────────────────────────────────────────────────────
  const ci = S.checkin;
  let ciBadge, ciSub;
  if (ci) {
    const submittedDate = new Date(ci.submitted_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    ciBadge = `<span class="badge badge-checkin-done">✓ Submitted</span>`;
    ciSub   = `<div class="card-sub" style="margin-top:4px;font-size:12px">${submittedDate}${ci.resubmitted ? ' · updated' : ''}</div>`;
  } else {
    ciBadge = `<span class="badge badge-checkin-due">Due this week</span>`;
    ciSub   = `<div class="card-sub" style="margin-top:4px;font-size:12px;color:var(--muted)">Let your coach know about next week</div>`;
  }
  const checkinCardHtml = `
    <div class="card tap checkin-card" onclick="openCheckin()" style="margin-top:4px">
      <div class="session-row">
        <div style="flex:1">
          <div class="card-label">Weekly Check-In</div>
          <div class="card-title" style="font-size:16px">✍️  Notes for Coach</div>
          <div class="session-meta">${ciBadge}</div>
          ${ciSub}
        </div>
        <div class="arrow">›</div>
      </div>
    </div>`;

  const injCount = (S.openInjuries || []).length;
  const utilHtml = `
    <div class="divider"></div>
    <div class="util-grid">
      <div class="util-btn" onclick="openReadiness()">
        <span class="util-icon">📊</span>Readiness
      </div>
      <div class="util-btn" onclick="openPainSheet()" style="position:relative">
        <span class="util-count" id="pain-util-badge" style="${injCount ? '' : 'display:none'}">${injCount || ''}</span>
        <span class="util-icon">🚩</span>Pain
      </div>
      <div class="util-btn" onclick="openHistory()">
        <span class="util-icon">📋</span>History
      </div>
      <div class="util-btn" onclick="openTests()">
        <span class="util-icon">🏆</span>Tests
      </div>
      <div class="util-btn" onclick="openTrends()">
        <span class="util-icon">📈</span>Trends
      </div>
      <div class="util-btn" onclick="openExportSheet()">
        <span class="util-icon">📥</span>Export
      </div>
    </div>
    <button class="add-ex-btn" onclick="openNewSessionSheet()" style="margin-top:10px">
      ➕  New Session
    </button>
    <button class="btn secondary" onclick="startNewWeek()" style="margin-top:8px;font-size:13px;padding:10px">
      🗓  Start New Week
    </button>`;

  body.innerHTML = `<div id="session-list">${sessHtml}</div>` + checkinCardHtml + utilHtml;
  initSessionSort();
  showScreen('week');
}

async function loadProgram() {
  const body = document.getElementById('week-body');

  // Shared offline cache restore
  async function loadFromCache() {
    const cached = await idbGet('programCache');
    if (cached && cached.athleteId === S.athlete?.id) {
      S.cycle = cached.cycle; S.sessions = cached.sessions || []; S.completed = cached.completed || {};
      try { const oi = await idbGet('openInjuriesCache'); if (oi && oi.athleteId === S.athlete?.id) S.openInjuries = oi.items || []; } catch (_) {}
      renderWeek();
    } else {
      body.innerHTML = '<div class="card"><div class="card-title" style="color:var(--muted)">Offline</div>' +
        '<div class="card-sub">Connect once to cache your program for offline use.</div></div>';
      document.getElementById('week-name').textContent  = S.athlete?.name || '';
      document.getElementById('week-block').textContent = '';
      showScreen('week');
    }
  }

  // Re-check connectivity here too (state may have changed since onLogin)
  if (isOffline || !(await checkOnline())) {
    isOffline = true;
    updateOfflineBanner();
    await loadFromCache();
    return;
  }

  try {
    const { data: cycle } = await db.from('training_cycles')
      .select('*').eq('athlete_id', S.athlete.id).eq('status', 'active').single();

    if (!cycle) {
      S.cycle = null; S.sessions = []; S.completed = {};
      renderWeek();
      return;
    }
    S.cycle = cycle;

    const { data: sessions } = await db.from('planned_sessions')
      .select('*').eq('cycle_id', cycle.id).order('session_order');
    S.sessions = sessions || [];

    const psIds = S.sessions.map(s => s.id);
    const { data: compList } = await db.from('completed_sessions')
      .select('id,planned_session_id,status')
      .eq('athlete_id', S.athlete.id)
      .in('planned_session_id', psIds);
    S.completed = {};
    (compList || []).forEach(c => { S.completed[c.planned_session_id] = c; });

    // Prefetch all session detail data so sessions work offline
    const [exAllRes, condAllRes] = await Promise.all([
      psIds.length ? db.from('planned_exercises')
        .select('*, exercise:exercise_library(id,name,movement_pattern,equipment)')
        .in('session_id', psIds).order('item_order') : { data: [] },
      psIds.length ? db.from('planned_conditioning_blocks')
        .select('*').in('session_id', psIds) : { data: [] },
    ]);
    const compIds = Object.values(S.completed).map(c => c.id).filter(Boolean);
    const [compFullRes, setsRes] = await Promise.all([
      compIds.length ? db.from('completed_sessions').select('*').in('id', compIds) : { data: [] },
      compIds.length ? db.from('completed_strength_sets')
        .select('set_number,actual_load,actual_reps,actual_rpe,notes,is_skipped,planned_exercise_id,is_added,exercise_id,completed_session_id')
        .in('completed_session_id', compIds) : { data: [] },
    ]);
    const sessionDetailCache = {};
    for (const sess of S.sessions) {
      const comp = S.completed[sess.id];
      sessionDetailCache[sess.id] = {
        exercises:        (exAllRes.data   || []).filter(e => e.session_id === sess.id),
        conditioning:     (condAllRes.data || []).find(c2 => c2.session_id === sess.id) || null,
        completedSession: comp ? (compFullRes.data || []).find(c2 => c2.id === comp.id) || null : null,
        savedSets:        comp ? (setsRes.data     || []).filter(s => s.completed_session_id === comp.id) : [],
      };
    }
    try { await idbSet('sessionDetailCache', sessionDetailCache); } catch {}
    try { await idbSet('programCache', { athleteId: S.athlete.id, cycle: S.cycle, sessions: S.sessions, completed: S.completed }); } catch {}

    // Load most recent check-in for the upcoming week (non-blocking)
    try {
      const { data: ci } = await db.from('athlete_weekly_checkin')
        .select('*')
        .eq('athlete_id', S.athlete.id)
        .eq('week_start_date', nextMonday())
        .maybeSingle();
      S.checkin = ci || null;
    } catch (_) { S.checkin = null; }

    await loadOpenInjuries();

    renderWeek();
  } catch (_) {
    // Network failed — auto-detect offline and restore from cache
    isOffline = true;
    updateOfflineBanner();
    await loadFromCache();
  }
}

// ── Delete ad-hoc session ─────────────────────────────────────────────────────
async function deleteSession(sessionId) {
  if (!confirm('Delete this session and all its data?')) return;
  try {
    const cs = S.completed[sessionId];
    if (cs) {
      await db.from('completed_conditioning').delete().eq('completed_session_id', cs.id);
      await db.from('completed_sessions').delete().eq('id', cs.id);
    }
    await db.from('planned_sessions').delete().eq('id', sessionId);
    S.sessions = S.sessions.filter(s => s.id !== sessionId);
    delete S.completed[sessionId];
    toast('Session deleted');
    loadProgram();
  } catch (err) {
    console.error(err);
    toast('Error deleting session.', 4000);
  }
}

// ── Day label editor ────────────────────────────────────────────────────────
let _dayLabelSessionId = null;

function editDayLabel(sessionId) {
  _dayLabelSessionId = sessionId;
  const days    = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const current = (S.sessions.find(s => s.id === sessionId) || {}).day_label || '';
  const opts    = [
    ...days.map(d =>
      `<div class="sheet-item${d === current ? ' sheet-item-active' : ''}" onclick="saveDayLabel('${d}')">${d}</div>`
    ),
    `<div class="sheet-item${!current ? ' sheet-item-active' : ''}" onclick="saveDayLabel('')" style="color:var(--muted)">No label</div>`,
  ].join('');
  document.getElementById('day-label-options').innerHTML = opts;
  document.getElementById('day-label-overlay').classList.add('open');
  document.getElementById('day-label-sheet').classList.add('open');
}

function closeDayLabelPicker() {
  document.getElementById('day-label-overlay').classList.remove('open');
  document.getElementById('day-label-sheet').classList.remove('open');
}

async function saveDayLabel(newLabel) {
  closeDayLabelPicker();
  const sessionId = _dayLabelSessionId;
  if (!sessionId) return;
  const sess = S.sessions.find(s => s.id === sessionId);
  if (sess) { sess.day_label = newLabel || null; renderWeek(); }
  if (!isOffline) {
    try {
      await db.from('planned_sessions').update({ day_label: newLabel || null }).eq('id', sessionId);
    } catch (err) {
      console.error('saveDayLabel:', err);
      toast('Could not save — check connection.', 3000);
    }
  }
}

// ── New session sheet ─────────────────────────────────────────────────────────
const DAY_ORDER = { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6, Sunday:7 };

function openNewSessionSheet() {
  document.getElementById('new-sess-overlay').classList.add('open');
  document.getElementById('new-sess-sheet').classList.add('open');

  // Load recent sessions for copy section (non-blocking)
  loadRecentSessionsForCopy();
}

function closeNewSessionSheet() {
  document.getElementById('new-sess-overlay').classList.remove('open');
  document.getElementById('new-sess-sheet').classList.remove('open');
}

async function loadRecentSessionsForCopy() {
  const list = document.getElementById('copy-sess-list');
  if (!list) return;
  if (isOffline) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Not available offline.</div>';
    return;
  }
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 28);
    const { data: sessions } = await db.from('completed_sessions')
      .select('id, planned_session_id, session_type, session_date')
      .eq('athlete_id', S.athlete.id)
      .eq('status', 'completed')
      .gte('session_date', cutoff.toISOString().slice(0, 10))
      .order('session_date', { ascending: false })
      .limit(6);

    if (!sessions || sessions.length === 0) {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">No completed sessions in the last 4 weeks.</div>';
      return;
    }
    list.innerHTML = sessions.map(s => {
      const d       = new Date(s.session_date + 'T00:00:00');
      const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const safe    = (s.session_type || 'Session').replace(/'/g, "\'");
      return `<div class="sheet-item" onclick="copyPreviousSession('${s.id}','${safe}','${s.planned_session_id||''}')">
        <div class="sheet-item-name">${s.session_type || 'Session'}</div>
        <div class="sheet-item-meta">${dateStr}</div>
      </div>`;
    }).join('');
  } catch (_) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Could not load sessions.</div>';
  }
}

// Create a blank user-built session with the selected day/type
async function createUserSession() {
  if (isOffline) { toast('Cannot create sessions offline.'); return; }
  if (!S.cycle) { toast('No active program — ask your coach to push a program first.', 4000); return; }
  const sessionType = document.getElementById('new-sess-type').value;
  closeNewSessionSheet();

  document.getElementById('session-title').textContent = sessionType;
  document.getElementById('session-sub').textContent   = '';
  document.getElementById('session-body').innerHTML    = '<div class="spinner">Creating…</div>';
  const btn = document.getElementById('submit-btn');
  btn.disabled    = false;
  btn.className   = 'btn';
  btn.textContent = sessionType === 'Conditioning Only' ? 'Log Conditioning' : 'Finish Session';
  showScreen('session');

  try {
    const { data: ps, error: psErr } = await db.from('planned_sessions').insert({
      athlete_id:            S.athlete.id,
      cycle_id:              S.cycle?.id,
      week_of:               S.cycle?.start_date || today(),
      day_label:             sessionType,
      session_order:         null,
      session_type:          sessionType,
      includes_conditioning: sessionType === 'Conditioning Only',
      session_notes:         null,
    }).select().single();
    if (psErr) throw psErr;

    S.sessions.push(ps);
    await openSession(ps.id);
  } catch (err) {
    console.error('createUserSession error:', err);
    const msg = err?.message || err?.details || 'Check connection.';
    toast('Error creating session: ' + msg, 5000);
    loadProgram();
  }
}

// Copy a previous completed session's exercises into a new session
async function copyPreviousSession(completedSessionId, sessionType, plannedSessionId) {
  if (isOffline) { toast('Cannot create sessions offline.'); return; }
  closeNewSessionSheet();

  document.getElementById('session-title').textContent = sessionType;
  document.getElementById('session-sub').textContent   = '';
  document.getElementById('session-body').innerHTML    = '<div class="spinner">Copying session…</div>';
  const btn = document.getElementById('submit-btn');
  btn.disabled    = false;
  btn.className   = 'btn';
  btn.textContent = sessionType === 'Conditioning Only' ? 'Log Conditioning' : 'Finish Session';
  showScreen('session');

  try {
    // Create the new planned session
    const { data: ps, error: psErr } = await db.from('planned_sessions').insert({
      athlete_id:            S.athlete.id,
      cycle_id:              S.cycle?.id,
      week_of:               S.cycle?.start_date || today(),
      day_label:             sessionType,
      session_order:         null,
      session_type:          sessionType,
      includes_conditioning: sessionType === 'Conditioning Only',
      session_notes:         null,
    }).select().single();
    if (psErr) throw psErr;

    // Load the source session's completed sets (real data only, not placeholders)
    const { data: sets } = await db.from('completed_strength_sets')
      .select('exercise_id, set_number, actual_load, actual_reps')
      .eq('completed_session_id', completedSessionId)
      .gt('set_number', 0)
      .eq('is_skipped', false)
      .order('set_number');

    let copiedCount = 0;

    if (sets && sets.length > 0) {
      // Build from completed sets — use actual loads as targets
      const seen = new Set();
      const uniqueExes = [];
      sets.forEach(s => {
        if (s.exercise_id && !seen.has(s.exercise_id)) {
          seen.add(s.exercise_id);
          const exSets    = sets.filter(r => r.exercise_id === s.exercise_id);
          const topLoad   = Math.max(...exSets.map(r => r.actual_load || 0)) || null;
          const firstReps = exSets[0]?.actual_reps || null;
          uniqueExes.push({ exercise_id: s.exercise_id, topLoad, firstReps, setCount: exSets.length });
        }
      });
      const peRows = uniqueExes.map((ex, i) => ({
        session_id:  ps.id,
        exercise_id: ex.exercise_id,
        item_order:  i + 1,
        target_load: ex.topLoad,
        target_sets: ex.setCount,
        reps_low:    ex.firstReps,
      }));
      await db.from('planned_exercises').insert(peRows);
      copiedCount = uniqueExes.length;

    } else if (plannedSessionId) {
      // Fallback: copy directly from planned_exercises of the source session
      const { data: srcPEs } = await db.from('planned_exercises')
        .select('exercise_id, target_load, target_sets, reps_low, item_order')
        .eq('session_id', plannedSessionId)
        .order('item_order');
      if (srcPEs && srcPEs.length > 0) {
        const peRows = srcPEs.map((ex, i) => ({
          session_id:  ps.id,
          exercise_id: ex.exercise_id,
          item_order:  i + 1,
          target_load: ex.target_load,
          target_sets: ex.target_sets,
          reps_low:    ex.reps_low,
        }));
        await db.from('planned_exercises').insert(peRows);
        copiedCount = srcPEs.length;
      }
    }

    S.sessions.push(ps);
    toast(`Copied ${copiedCount} exercise${copiedCount !== 1 ? 's' : ''} ✓`, 1500);
    await openSession(ps.id);
  } catch (err) {
    console.error(err);
    toast('Error copying session.', 4000);
    loadProgram();
  }
}

// Start a new training week
async function startNewWeek() {
  if (isOffline) { toast('Cannot start new week offline.'); return; }
  if (!confirm('Start a new week? The current week will be archived and the session list will clear.')) return;

  try {
    // Archive the current cycle
    if (S.cycle?.id) {
      await db.from('training_cycles').update({ status: 'completed' }).eq('id', S.cycle.id);
    }

    // Create the new cycle
    const todayStr = today();
    const { data: newCycle, error: cycleErr } = await db.from('training_cycles').insert({
      athlete_id:  S.athlete.id,
      name:        `Week of ${todayStr}`,
      start_date:  todayStr,
      status:      'active',
    }).select().single();
    if (cycleErr) throw cycleErr;

    S.cycle    = newCycle;
    S.sessions = [];
    S.completed = {};
    toast('New week started ✓');
    await renderWeek();
  } catch (err) {
    console.error(err);
    toast('Error starting new week.', 4000);
  }
}

// ── Sortable drag-to-reorder ─────────────────────────────────────────────────

function initSessionSort() {
  const list = document.getElementById('session-list');
  if (!list || typeof Sortable === 'undefined') return;
  if (list._sortable) list._sortable.destroy();
  list._sortable = Sortable.create(list, {
    handle:            '.drag-handle',
    animation:         150,
    forceFallback:     true,
    fallbackTolerance: 3,
    supportPointer:    false,
    ghostClass:        'sortable-ghost',
    chosenClass:       'sortable-chosen',
    onEnd: async function() {
      const newOrder = Array.from(list.querySelectorAll('.card[data-sid]'))
        .map(c => c.dataset.sid);
      S.sessions = newOrder
        .map(id => S.sessions.find(s => s.id === id))
        .filter(Boolean);
      try {
        await idbSet('sessionOrderCache', { cycleId: S.cycle?.id, order: newOrder });
      } catch (_) {}
      // Persist order to DB so it survives across devices and reinstalls
      if (!isOffline) {
        try {
          await Promise.all(newOrder.map((id, i) =>
            db.from('planned_sessions').update({ session_order: i + 1 }).eq('id', id)));
        } catch (err) { console.error('session order save failed:', err); }
      }
    },
  });
}

(async () => {
  // Probe connectivity FIRST — before any Supabase auth calls.
  // Supabase tries a token refresh if the JWT is expired, which hangs/fails offline
  // and returns session:null, preventing onLogin from ever being called.
  const online = await checkOnline();

  if (!online) {
    // Offline: skip auth entirely, load directly from IDB cache
    isOffline = true;
    updateOfflineBanner();
    const cached = await idbGet('athleteCache');
    if (cached) {
      S.user        = { email: cached.email };
      S.athlete     = cached.athlete;
      S.exerciseLib = cached.exerciseLib || [];
      toast('Offline — loading from cache…', 2000);
      await loadProgram();
    } else {
      toast('Offline — open the app while connected first to enable offline use.', 5000);
      showScreen('login');
    }
  } else {
    // Online: normal Supabase auth flow
    const { data: { session } } = await db.auth.getSession();
    if (session?.user) await onLogin(session.user);
  }

  // Always register auth state change listener
  db.auth.onAuthStateChange(async (event) => {
    if (event === 'SIGNED_OUT') showScreen('login');
  });
})();
