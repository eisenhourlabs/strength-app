// ── Program loading ───────────────────────────────────────────────────────────
async function renderWeek() {
  // Apply any saved display order before rendering
  const savedOrder = await idbGet('sessionOrderCache');
  if (savedOrder?.cycleId === S.cycle?.id && savedOrder?.order?.length) {
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

  const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const totalSess = S.sessions.length;
  const doneSess  = S.sessions.filter(s => S.completed[s.id]?.status === 'completed').length;
  const skipSess  = S.sessions.filter(s => S.completed[s.id]?.status === 'skipped').length;
  const planSess  = totalSess - skipSess;   // skipped sessions drop out of the target
  const skipNote  = skipSess ? ` · ${skipSess} skipped` : '';
  const progressHtml = (S.cycle && totalSess > 0) ? `
    <div class="week-progress">
      <div class="week-progress-label">${doneSess} of ${planSess} session${planSess !== 1 ? 's' : ''} complete${(planSess > 0 && doneSess === planSess) ? ' — week done! 🎉' : ''}${skipNote}</div>
      <div class="week-progress-track"><div class="week-progress-fill" style="width:${planSess > 0 ? Math.round(doneSess / planSess * 100) : 100}%"></div></div>
    </div>` : '';

  const emptyStateHtml =
      '<div class="card"><div class="card-title">No sessions this week</div>'
    + '<div class="card-sub" style="margin:6px 0 12px">Repeat last week\'s plan, copy sessions from History, or build one with \u2795 New Session below.'
    + (S.cycle ? '' : ' If you have a coach, their next program will appear here automatically.')
    + '</div>'
    + '<button class="btn" style="font-size:14px;padding:12px" onclick="repeatLastWeek()">\u27f3\u00a0 Repeat Last Week</button></div>';
  const sessHtml = (!S.cycle || S.sessions.length === 0)
    ? emptyStateHtml
    : S.sessions.map(s => {
    const comp       = S.completed[s.id];
    const isCondOnly = s.session_type === 'Conditioning Only';
    const icon       = isCondOnly ? '🚴 ' : '';
    const dayLabel   = s.day_label || '';
    const isSkipped = !!(comp && comp.status === 'skipped');
    let statusBadge;
    if (!comp) {
      statusBadge = `<span class="badge badge-pending">Pending</span>`;
    } else if (isSkipped) {
      statusBadge = `<span class="badge badge-skipped">⨯ Skipped</span>`;
    } else if (comp.status === 'in_progress') {
      statusBadge = `<span class="badge badge-progress">▶ In Progress</span>`;
    } else {
      statusBadge = `<span class="badge badge-done">✓ Logged</span>`;
    }
    const skipReason = isSkipped
      ? `<div class="card-sub sess-skip-reason">${(comp.session_notes || 'Skipped')}</div>` : '';
    const skipBtnHtml = isSkipped
      ? `<button class="sess-skip-btn skipped" onclick="event.stopPropagation();unskipSession('${s.id}')" title="Un-skip session">↩</button>`
      : `<button class="sess-skip-btn" onclick="event.stopPropagation();openSkipSessionSheet('${s.id}')" title="Skip session">⨯</button>`;
    const isToday = dayLabel === todayName && !isSkipped && !(comp && comp.status === 'completed');
    return `
      <div class="card tap${isToday ? ' today-card' : ''}${isSkipped ? ' sess-skipped' : ''}" data-sid="${s.id}" onclick="openSession('${s.id}')">
        <div class="session-row">
          <span class="drag-handle" onclick="event.stopPropagation()" style="margin-right:10px;flex-shrink:0">≡</span>
          <div style="flex:1">
            <div class="card-label sess-day-chip" onclick="event.stopPropagation();editDayLabel('${s.id}')">${dayLabel || '<span style="opacity:.45">+ day</span>'} <span class="day-edit-icon">&#9998;</span>${isToday ? ' <span class="today-chip">TODAY</span>' : ''}</div>
            <div class="card-title">${icon}${s.session_type || 'Session'}</div>
            <div class="session-meta">${statusBadge}</div>
            ${skipReason}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${skipBtnHtml}
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
      <div class="util-btn" onclick="openMovement()" style="position:relative">
        <span class="mv-dot" id="mv-util-dot" style="display:none"></span>
        <span class="util-icon">🚶</span>Movement
      </div>
    </div>
    <button class="add-ex-btn" onclick="openNewSessionSheet()" style="margin-top:10px">
      ➕  New Session
    </button>
    <button class="btn secondary" onclick="startNewWeek()" style="margin-top:8px;font-size:13px;padding:10px">
      🗓  Start New Week
    </button>`;

  // Daily Movement Today card (movement.js) — renders nothing while both habits are off.
  body.innerHTML = '<div id="mv-card-slot"></div>' + progressHtml + `<div id="session-list">${sessHtml}</div>` + checkinCardHtml + utilHtml;
  if (typeof renderMovementCard === 'function') { try { renderMovementCard(); } catch (e) { console.error('renderMovementCard:', e); } }
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
      .select('id,planned_session_id,status,session_notes')
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
  showConfirm('Delete session?',
    'This deletes the session and all its logged data. It cannot be undone.',
    'Delete', () => _deleteSessionConfirmed(sessionId), true);
}

async function _deleteSessionConfirmed(sessionId) {
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

// ── Skip a whole session ─────────────────────────────────────────────────────
// Writes completed_sessions.status = 'skipped' with a reason in session_notes.
// The coach-side pull (pull_logs.py) already counts this status.
const SKIP_REASONS = [
  ['🤒', 'Sick'],
  ['✈️', 'Travel'],
  ['⏱',  'No time'],
  ['😴', 'Too beat up'],
  ['🩹', 'Pain / injury'],
  ['⋯',  'Other'],
];

let _skipSessionId = null;

function openSkipSessionSheet(sessionId) {
  _skipSessionId = sessionId;
  const sess  = (S.sessions || []).find(s => s.id === sessionId);
  const label = sess
    ? (sess.day_label ? sess.day_label + ' · ' : '') + (sess.session_type || 'Session')
    : 'this session';
  const chips = SKIP_REASONS.map(r =>
    `<button class="skip-reason-chip" onclick="chooseSkipReason('${r[1].replace(/'/g, "\\'")}')">${r[0]}  ${r[1]}</button>`
  ).join('');
  const overlay = document.createElement('div');
  overlay.className = 'pain-prompt-overlay';
  overlay.id        = 'skip-sess-overlay';
  overlay.innerHTML = `
    <div class="pain-prompt-box">
      <div class="pain-prompt-title">Skip this session?</div>
      <div class="pain-prompt-sub">${label}<br>Why? Your coach sees this.</div>
      <div class="skip-reason-wrap">${chips}</div>
      <div class="pain-prompt-btns">
        <button class="pain-prompt-no" onclick="closeSkipSessionSheet()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function closeSkipSessionSheet() {
  const o = document.getElementById('skip-sess-overlay');
  if (o) o.remove();
  _skipSessionId = null;
}

function chooseSkipReason(reason) {
  const sessionId = _skipSessionId;
  closeSkipSessionSheet();
  if (!sessionId) return;
  const cs = S.completed[sessionId];
  if (cs && cs.status !== 'skipped') {
    showConfirm('This session already has logged work',
      'The sets you logged stay saved, but the session reports to your coach as skipped. Continue?',
      'Mark skipped', () => _applySkipSession(sessionId, reason), true);
    return;
  }
  _applySkipSession(sessionId, reason);
}

function _skipNote(existingNotes, reason) {
  const tag = 'Skipped — ' + reason;
  const prior = (existingNotes || '').replace(/\s*\|?\s*Skipped — [^|]*/g, '').trim();
  return prior ? prior + ' | ' + tag : tag;
}

async function _applySkipSession(sessionId, reason) {
  const sess = (S.sessions || []).find(s => s.id === sessionId);
  const cs   = S.completed[sessionId];
  const note = _skipNote(cs && cs.session_notes, reason);
  try {
    if (isOffline) {
      if (cs) {
        await idbQueueWrite({ op: 'finish_session_update',
          tempSessionId: cs.id,
          sessionId:     cs._isTemp ? null : cs.id,
          payload:       { status: 'skipped', session_notes: note } });
        S.completed[sessionId] = { ...cs, status: 'skipped', session_notes: note };
      } else {
        const sp = { athlete_id: S.athlete.id, planned_session_id: sessionId,
          session_date: today(), week_of: S.cycle ? S.cycle.start_date : null,
          session_type: sess ? sess.session_type : null,
          status: 'skipped', session_notes: note };
        await idbQueueWrite({ op: 'finish_session_insert', payload: sp });
        S.completed[sessionId] = { id: crypto.randomUUID(), _isTemp: true, ...sp };
      }
      toast('Session skipped — will sync when connected.');
      showScreen('week');
      renderWeek();
      return;
    }

    if (cs) {
      const { error } = await db.from('completed_sessions')
        .update({ status: 'skipped', session_notes: note }).eq('id', cs.id);
      if (error) throw error;
    } else {
      const { error } = await db.from('completed_sessions').insert({
        athlete_id:         S.athlete.id,
        planned_session_id: sessionId,
        session_date:       today(),
        week_of:            S.cycle ? S.cycle.start_date : null,
        session_type:       sess ? sess.session_type : null,
        status:             'skipped',
        session_notes:      note,
      });
      if (error) throw error;
    }
    toast('Session skipped');
    loadProgram();
  } catch (err) {
    console.error('_applySkipSession:', err);
    toast('Could not skip session — check connection.', 4000);
  }
}

async function unskipSession(sessionId) {
  const cs = S.completed[sessionId];
  if (!cs) { showScreen('week'); renderWeek(); return; }
  if (isOffline) { toast('Un-skipping needs a connection.', 3000); return; }
  try {
    // If nothing was ever logged against it, drop the record so it reads Pending again.
    const { data: sets } = await db.from('completed_strength_sets')
      .select('id').eq('completed_session_id', cs.id).limit(1);
    const { data: cond } = await db.from('completed_conditioning')
      .select('id').eq('completed_session_id', cs.id).limit(1);
    const hasWork = (sets && sets.length) || (cond && cond.length);
    if (hasWork) {
      const notes = (cs.session_notes || '').replace(/\s*\|?\s*Skipped — [^|]*/g, '').trim() || null;
      const { error } = await db.from('completed_sessions')
        .update({ status: 'in_progress', session_notes: notes }).eq('id', cs.id);
      if (error) throw error;
    } else {
      const { error } = await db.from('completed_sessions').delete().eq('id', cs.id);
      if (error) throw error;
    }
    toast('Session restored');
    loadProgram();
  } catch (err) {
    console.error('unskipSession:', err);
    toast('Could not restore session.', 4000);
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
  try { await ensureActiveCycle(); } catch (e) { toast('Could not start a week — check connection.', 4000); return; }
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

// Copy a previous completed session into a brand-new session in this week.
// Exercises, their order, set count, per-set weights and per-set reps all carry
// over exactly; RPE never does.
async function copyPreviousSession(completedSessionId, sessionType, plannedSessionId) {
  if (isOffline) { toast('Cannot create sessions offline.'); return; }
  try { await ensureActiveCycle(); } catch (e) { toast('Could not start a week — check connection.', 4000); return; }
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
    const res = await cloneSessionIntoCurrentWeek({
      plannedSessionId:     plannedSessionId || null,
      completedSessionId:   completedSessionId,
      sessionType:          sessionType,
      dayLabel:             sessionType,
      includesConditioning: sessionType === 'Conditioning Only',
    });
    S.sessions.push(res.ps);
    toast(`Copied ${res.count} exercise${res.count !== 1 ? 's' : ''} ✓`, 1500);
    await openSession(res.ps.id);
  } catch (err) {
    console.error(err);
    toast('Error copying session.', 4000);
    loadProgram();
  }
}

// Start a new training week
async function startNewWeek() {
  if (isOffline) { toast('Cannot start new week offline.'); return; }
  showConfirm('Start a new week?',
    'The current week will be archived and the session list will clear.',
    'Start New Week', _startNewWeekConfirmed);
}

async function _startNewWeekConfirmed() {
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

// ── Self-programming: cycle bootstrap, session cloning, repeat last week ─────

// Create an active cycle if none exists (pure self-programmed athletes).
async function ensureActiveCycle() {
  if (S.cycle && S.cycle.id) return S.cycle;
  const todayStr = today();
  const { data: newCycle, error } = await db.from('training_cycles').insert({
    athlete_id: S.athlete.id,
    name:       'Week of ' + todayStr,
    start_date: todayStr,
    status:     'active',
  }).select().single();
  if (error) throw error;
  S.cycle = newCycle;
  S.sessions = S.sessions || [];
  S.completed = S.completed || {};
  return newCycle;
}

// Insert planned_exercises rows. If the database has not had the set_detail
// column added yet, retry without it rather than losing the whole copy.
async function insertPlannedExercises(rows) {
  if (!rows.length) return;
  const { error } = await db.from('planned_exercises').insert(rows);
  if (!error) return;
  if (!rows.some(function (r) { return r.set_detail != null; })) throw error;
  console.warn('planned_exercises insert failed — retrying without set_detail:', error);
  const { error: err2 } = await db.from('planned_exercises').insert(rows.map(function (r) {
    const c = Object.assign({}, r); delete c.set_detail; return c;
  }));
  if (err2) throw err2;
}

// Clone a session into the current week as an exact copy.
//
// Every exercise from the source comes across in the same order, with the same
// number of sets, and each set pre-filled with the weight and reps that were
// actually logged for THAT set. Exercises the athlete added by hand mid-session
// are included, as are exercises that were skipped (they come across empty).
// RPE is deliberately never carried over — target RPE is cleared and the RPE
// inputs stay blank. Returns { ps, count }.
async function cloneSessionIntoCurrentWeek(opts) {
  await ensureActiveCycle();
  const { data: ps, error: psErr } = await db.from('planned_sessions').insert({
    athlete_id:            S.athlete.id,
    cycle_id:              S.cycle.id,
    week_of:               S.cycle.start_date || today(),
    day_label:             opts.dayLabel || null,
    session_order:         opts.sessionOrder != null ? opts.sessionOrder : null,
    session_type:          opts.sessionType || 'Session',
    includes_conditioning: !!opts.includesConditioning,
    session_notes:         opts.sessionNotes || null,
  }).select().single();
  if (psErr) throw psErr;

  // ── Source structure: the prescription, and what was actually logged ──────
  let srcPEs = [];
  if (opts.plannedSessionId) {
    const { data } = await db.from('planned_exercises')
      .select('*').eq('session_id', opts.plannedSessionId).order('item_order');
    srcPEs = data || [];
  }

  let srcSets = [];
  if (opts.completedSessionId) {
    const { data } = await db.from('completed_strength_sets')
      .select('*')
      .eq('completed_session_id', opts.completedSessionId)
      .order('created_at', { ascending: true })
      .order('set_number',  { ascending: true });
    srcSets = data || [];
  }

  // Bucket the logged sets: prescribed exercises by planned_exercise_id,
  // hand-added ones by exercise_id.
  const byPlanned = {};
  const byAdded   = {};
  srcSets.forEach(function (s) {
    if (s.planned_exercise_id) {
      if (!byPlanned[s.planned_exercise_id]) byPlanned[s.planned_exercise_id] = [];
      byPlanned[s.planned_exercise_id].push(s);
    } else if (s.exercise_id) {
      const k = String(s.exercise_id);
      if (!byAdded[k]) byAdded[k] = [];
      byAdded[k].push(s);
    }
  });

  // Ordered exercise list — prescribed items by item_order, then hand-added
  // ones in the order they were added. Same rule the History screen uses, so a
  // copy shows up in exactly the order the source session did.
  const items = [];
  srcPEs.forEach(function (pe) {
    items.push({ planned: pe, logged: byPlanned[pe.id] || [], order: pe.item_order, at: '' });
  });
  Object.keys(byAdded).forEach(function (exId) {
    const rows = byAdded[exId];
    items.push({ planned: null, exerciseId: rows[0].exercise_id, logged: rows,
                 order: null, at: rows[0].created_at || '' });
  });
  items.sort(function (a, b) {
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return String(a.at).localeCompare(String(b.at));
  });

  const rows = [];
  items.forEach(function (it) {
    const base = it.planned ? Object.assign({}, it.planned) : {};
    delete base.id; delete base.created_at; delete base.exercise;
    base.session_id  = ps.id;
    base.exercise_id = it.planned ? it.planned.exercise_id : it.exerciseId;
    base.item_order  = rows.length + 1;
    base.rpe_low     = null;    // RPE never carries over
    base.rpe_high    = null;

    const real = it.logged.filter(function (s) {
      return (s.set_number || 0) > 0 && !s.is_skipped;
    });

    if (real.length) {
      base.set_detail = real.map(function (s) {
        return {
          load:  s.actual_load  != null ? s.actual_load  : null,
          reps:  s.actual_reps  != null ? s.actual_reps  : null,
          value: s.actual_value != null ? s.actual_value : null,
          mt:    s.measure_type || 'reps',
        };
      });
      base.target_sets  = real.length;
      // If the athlete swapped this lift for another, copy what they actually did.
      if (real[0].exercise_id) base.exercise_id = real[0].exercise_id;
      // Single-value fallbacks, for anywhere that still reads the old fields.
      base.target_load  = real[0].actual_load != null ? real[0].actual_load : null;
      base.reps_low     = real[0].actual_reps != null ? real[0].actual_reps : null;
      base.reps_high    = base.reps_low;
      base.reps_display = null;
    } else if (!it.planned) {
      // Added exercise with nothing logged — carry it across as an empty tile.
      base.target_sets = 1;
    }
    rows.push(base);
  });

  await insertPlannedExercises(rows);
  const count = rows.length;

  if (opts.plannedSessionId) {
    const { data: srcCB } = await db.from('planned_conditioning_blocks')
      .select('*').eq('session_id', opts.plannedSessionId);
    if (srcCB && srcCB.length) {
      const cbRows = srcCB.map(function (c) {
        const r = Object.assign({}, c);
        delete r.id; delete r.created_at;
        r.session_id = ps.id;
        return r;
      });
      try { await db.from('planned_conditioning_blocks').insert(cbRows); }
      catch (e) { console.error('conditioning clone failed (RLS policy missing?):', e); }
    }
  }

  return { ps: ps, count: count };
}

// One-tap: clone every planned session from the most recent archived week.
async function repeatLastWeek() {
  if (isOffline) { toast('Not available offline.'); return; }
  toast('Copying last week\u2026', 3000);
  try {
    const { data: prevCycles } = await db.from('training_cycles')
      .select('id, start_date, name')
      .eq('athlete_id', S.athlete.id)
      .neq('status', 'active')
      .order('start_date', { ascending: false })
      .limit(1);
    const prev = prevCycles && prevCycles[0];
    if (!prev) { toast('No previous week found to copy.', 3500); return; }
    const { data: srcSessions } = await db.from('planned_sessions')
      .select('*').eq('cycle_id', prev.id).order('session_order');
    if (!srcSessions || !srcSessions.length) { toast('Previous week has no sessions.', 3500); return; }

    // Pair each planned session with what was actually logged against it, so the
    // copy carries real per-set weights and reps rather than just the plan.
    const { data: prevCompleted } = await db.from('completed_sessions')
      .select('id, planned_session_id, created_at')
      .eq('athlete_id', S.athlete.id)
      .in('planned_session_id', srcSessions.map(function (s) { return s.id; }))
      .order('created_at', { ascending: true });
    const completedByPlanned = {};
    (prevCompleted || []).forEach(function (c) {
      if (c.planned_session_id) completedByPlanned[c.planned_session_id] = c.id;
    });

    for (const s of srcSessions) {
      await cloneSessionIntoCurrentWeek({
        plannedSessionId:     s.id,
        completedSessionId:   completedByPlanned[s.id] || null,
        sessionType:          s.session_type,
        dayLabel:             s.day_label,
        sessionOrder:         s.session_order,
        includesConditioning: s.includes_conditioning,
        sessionNotes:         s.session_notes,
      });
    }
    toast('Copied ' + srcSessions.length + ' session' + (srcSessions.length !== 1 ? 's' : '') + ' \u2713');
    await loadProgram();
  } catch (err) {
    console.error('repeatLastWeek:', err);
    toast('Error copying last week.', 4000);
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
  } else if (AUTH_LINK.type === 'recovery' || AUTH_LINK.type === 'invite') {
    // Email-link flow (invite accept or password recovery) takes priority over
    // any existing session — route straight to the set-password screen.
    await enterPasswordSetup(AUTH_LINK.type);
  } else if (AUTH_LINK.error) {
    // Link was invalid or expired (Supabase put an error in the URL hash).
    showScreen('login');
    toast(AUTH_LINK.error, 5000);
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
