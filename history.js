// ── Export ────────────────────────────────────────────────────────────────────
function openExportSheet() {
  document.getElementById('export-overlay').classList.add('open');
  document.getElementById('export-sheet').classList.add('open');
}

function closeExportSheet() {
  document.getElementById('export-overlay').classList.remove('open');
  document.getElementById('export-sheet').classList.remove('open');
}

async function exportLog(range) {
  closeExportSheet();
  toast('Preparing export…', 4000);

  // Determine start date
  let startDate = null;
  if (range === 'week') {
    startDate = getWeekMonday(today());
  } else if (range === '30' || range === '90') {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(range));
    startDate = d.toISOString().slice(0, 10);
  }
  // range === 'all': no filter

  try {
    // Step 1: athlete's sessions in range (RLS ensures own data only)
    // day_label is on planned_sessions, not completed_sessions — join via FK
    let q = db.from('completed_sessions')
      .select('id, session_date, session_type, session_notes, overall_rpe, planned:planned_session_id(day_label)')
      .eq('athlete_id', S.athlete.id)
      .order('session_date');
    if (startDate) q = q.gte('session_date', startDate);

    const { data: sessions, error: sErr } = await q;
    if (sErr) throw sErr;
    if (!sessions || !sessions.length) { toast('No training data for this period.'); return; }

    const sessionIds  = sessions.map(function(s) { return s.id; });
    const sessMap     = {};
    sessions.forEach(function(s) {
      sessMap[s.id] = {
        date:         s.session_date,
        day:          (s.planned && s.planned.day_label) || '',
        type:         s.session_type  || '',
        sessionNotes: s.session_notes || '',
        overallRpe:   s.overall_rpe   != null ? s.overall_rpe : '',
      };
    });

    // Step 2: all sets for those sessions
    const { data: sets, error: stErr } = await db.from('completed_strength_sets')
      .select('completed_session_id, set_number, actual_load, actual_reps, actual_rpe, notes, measure_type, actual_value, is_skipped, exercise:exercise_id(name), planned_ex:planned_exercise_id(planned_adaptation,exercise_role)')
      .in('completed_session_id', sessionIds)
      .gt('set_number', 0)
      .order('completed_session_id')
      .order('set_number');
    if (stErr) throw stErr;
    if (!sets || !sets.length) { toast('No set data found for this period.'); return; }

    // Build CSV
    const esc = function(v) {
      if (v == null || v === '') return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const headers = ['date','day','session_type','session_rpe','session_notes',
      'exercise','planned_adaptation','exercise_role',
      'set_number','load_lb','reps','rpe','skipped','set_notes'];
    const rows = [headers.join(',')];

    sets.forEach(function(s) {
      const sess  = sessMap[s.completed_session_id] || {};
      const reps  = s.actual_reps != null ? s.actual_reps : (s.actual_value != null ? s.actual_value : '');
      rows.push([
        sess.date,
        esc(sess.day),
        esc(sess.type),
        sess.overallRpe,
        esc(sess.sessionNotes),
        esc(s.exercise ? s.exercise.name : ''),
        esc(s.planned_ex ? s.planned_ex.planned_adaptation  : ''),
        esc(s.planned_ex ? s.planned_ex.exercise_role       : ''),
        s.set_number,
        s.actual_load != null ? s.actual_load : '',
        reps,
        s.actual_rpe  != null ? s.actual_rpe  : '',
        s.is_skipped  ? 'yes' : 'no',
        esc(s.notes),
      ].join(','));
    });

    const csv      = rows.join('\n');
    const rangeLbl = startDate || 'all';
    const name     = (S.athlete.name || 'athlete').toLowerCase().replace(/\s+/g, '_');
    const filename = 'kardia_' + name + '_' + rangeLbl + '_to_' + today() + '.csv';
    await downloadCSV(csv, filename);

  } catch (err) {
    console.error('exportLog:', err);
    toast('Export failed — check connection.');
  }
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── History screen ────────────────────────────────────────────────────────────
async function openHistory() {
  document.getElementById('hist-screen-body').innerHTML = '<div class="spinner">Loading…</div>';
  showScreen('history');
  await loadHistory();
}

async function loadHistory() {
  const body = document.getElementById('hist-screen-body');
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 84);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // 1. Completed sessions in range
    const { data: sessions } = await db
      .from('completed_sessions')
      .select('*')
      .eq('athlete_id', S.athlete.id)
      .gte('session_date', cutoffStr)
      .order('session_date', { ascending: false });

    if (!sessions || sessions.length === 0) {
      body.innerHTML = '<div class="hist-empty">No sessions logged in the last 30 days.</div>';
      return;
    }

    const sessionIds = sessions.map(s => s.id);

    // 2. Strength sets with exercise names, planned order, and superset group
    const { data: sets } = await db
      .from('completed_strength_sets')
      .select('*, exercise:exercise_id(id, name), pe:planned_exercise_id(item_order, superset_group)')
      .in('completed_session_id', sessionIds)
      .eq('is_skipped', false)
      .order('created_at', { ascending: true })
      .order('set_number',  { ascending: true });

    // 3. Conditioning logs — multiple rows per session
    const { data: conds } = await db
      .from('completed_conditioning')
      .select('*')
      .in('completed_session_id', sessionIds)
      .order('created_at', { ascending: true });

    // 4. Readiness logs for the same date range
    const { data: readiness } = await db
      .from('readiness_logs')
      .select('*')
      .eq('athlete_id', S.athlete.id)
      .gte('log_date', cutoffStr);

    // Index data
    const setsBySession = {};
    (sets || []).forEach(s => {
      if (!setsBySession[s.completed_session_id]) setsBySession[s.completed_session_id] = [];
      setsBySession[s.completed_session_id].push(s);
    });

    // Array of cond rows per session (supports multi-modality)
    const condsBySession = {};
    (conds || []).forEach(c => {
      if (!condsBySession[c.completed_session_id]) condsBySession[c.completed_session_id] = [];
      condsBySession[c.completed_session_id].push(c);
    });

    const readinessByDate = {};
    (readiness || []).forEach(r => { readinessByDate[r.log_date] = r; });

    // Group sessions by week (Monday), then by date within each week
    S._histWeekIndex = {};
    const weekMap = {};
    sessions.forEach(s => {
      const wk = getWeekMonday(s.session_date);
      if (!weekMap[wk]) weekMap[wk] = {};
      if (!weekMap[wk][s.session_date]) weekMap[wk][s.session_date] = [];
      weekMap[wk][s.session_date].push(s);
    });
    const weekKeys = Object.keys(weekMap).sort((a, b) => b.localeCompare(a));

    // Sticky week chips
    const chipsHtml = weekKeys.map(wk => {
      const dt = new Date(wk + 'T00:00:00');
      const label = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<span class="hist-day-chip" onclick="histJumpToWeek('${wk}')">${label}</span>`;
    }).join('');

    // Build one session card (same layout as before, plus a copy button)
    const buildSessionCard = (sess) => {
      const rpeHtml = sess.overall_rpe
        ? `<span class="hist-sess-rpe">RPE ${sess.overall_rpe}</span>` : '';
      const safeType = (sess.session_type || 'Session').replace(/'/g, "\\'");
      const dayName  = new Date(sess.session_date + 'T00:00:00')
        .toLocaleDateString('en-US', { weekday: 'long' });
      const copyBtn  = `<button class="hist-ctrl-btn" title="Copy to this week"
        onclick="event.stopPropagation();histCopySession('${sess.id}','${sess.planned_session_id || ''}','${safeType}','${dayName}')">\u29c9</button>`;

      // Readiness strip
      let readinessHtml = '';
      const r = readinessByDate[sess.session_date];
      if (r) {
        const chips = [
          r.energy      != null ? `Energy <span>${r.energy}</span>`         : null,
          r.soreness    != null ? `Soreness <span>${r.soreness}</span>`     : null,
          r.stress      != null ? `Stress <span>${r.stress}</span>`         : null,
          r.motivation  != null ? `Motivation <span>${r.motivation}</span>` : null,
          r.sleep_hours != null ? `Sleep <span>${r.sleep_hours}h</span>`    : null,
        ].filter(Boolean);
        if (chips.length) readinessHtml = `
          <div class="hist-ready-strip">
            ${chips.map(c => `<span class="hist-ready-chip">${c}</span>`).join('')}
          </div>`;
      }

      // Exercise rows
      const sessSets = setsBySession[sess.id] || [];
      const exMap = {};
      sessSets.forEach(s => {
        if (!exMap[s.exercise_id]) exMap[s.exercise_id] = {
          id:             s.exercise_id,
          name:           s.exercise?.name || '—',
          itemOrder:      s.pe?.item_order  ?? null,
          supersetGroup:  s.pe?.superset_group || null,
          firstCreatedAt: s.created_at,
          sets:           [],
        };
        exMap[s.exercise_id].sets.push(s);
      });

      const sortedEx = Object.values(exMap).sort((a, b) => {
        if (a.itemOrder != null && b.itemOrder != null) return a.itemOrder - b.itemOrder;
        if (a.itemOrder != null) return -1;
        if (b.itemOrder != null) return 1;
        return (a.firstCreatedAt || '').localeCompare(b.firstCreatedAt || '');
      });

      let exHtml = '';
      let lastSupersetGroup = null;
      sortedEx.forEach(ex => {
        let topIdx = 0, topVal = 0;
        ex.sets.forEach((s, i) => {
          const mt = s.measure_type || 'reps';
          const v = (mt === 'reps' ? epley(s.actual_load, s.actual_reps) : null) || s.actual_load || 0;
          if (v > topVal) { topVal = v; topIdx = i; }
        });

        const setSpans = ex.sets.map((s, i) => {
          const mt    = s.measure_type || 'reps';
          const load  = s.actual_load  != null ? s.actual_load  : '—';
          const val   = mt === 'reps'
            ? (s.actual_reps  != null ? s.actual_reps  : '—')
            : (s.actual_value != null ? s.actual_value : '—');
          const unit  = mt === 'time' ? 's' : mt === 'dist' ? 'yds' : '';
          const txt   = unit ? `${load}lb × ${val}${unit}` : `${load}×${val}`;
          return i === topIdx
            ? `<span style="color:var(--accent);font-weight:700">${txt}</span>`
            : txt;
        }).join(' · ');

        const safeExName = ex.name.replace(/'/g, "\\'");

        if (ex.supersetGroup && ex.supersetGroup !== lastSupersetGroup) {
          exHtml += `<div class="ex-group" style="margin-top:6px">SUPERSET ${ex.supersetGroup.toUpperCase()}</div>`;
        }
        lastSupersetGroup = ex.supersetGroup || null;

        exHtml += `
          <div class="hist-ex-row">
            <span class="hist-ex-name" onclick="openExerciseHistory('${ex.id}','${safeExName}')">${ex.name}</span>
            <span class="hist-ex-sets">${setSpans}</span>
          </div>`;
      });

      // Conditioning rows — show all blocks
      const sessCondsArr = condsBySession[sess.id] || [];
      let condHtml = '';
      sessCondsArr.forEach(cond => {
        let parts;
        if (cond.modality === 'Circuit Training') {
          parts = [
            'Circuit',
            cond.notes ? cond.notes : null,
            cond.intervals_completed ? `${cond.intervals_completed} rounds` : null,
            cond.duration_minutes    ? `${cond.duration_minutes} min`        : null,
          ].filter(Boolean);
        } else {
          parts = [
            cond.modality,
            cond.workout_type && cond.workout_type !== cond.modality ? cond.workout_type : null,
            cond.duration_minutes  ? `${cond.duration_minutes} min`   : null,
            cond.avg_heart_rate    ? `${cond.avg_heart_rate} bpm avg` : null,
            cond.rpe               ? `RPE ${cond.rpe}`                : null,
          ].filter(Boolean);
        }
        condHtml += `<div class="hist-cond-row">🚴 ${parts.join(' · ')}</div>`;
      });

      const notesHtml = sess.session_notes
        ? `<div style="font-size:12px;color:var(--muted);font-style:italic;margin-top:8px">${sess.session_notes}</div>` : '';

      const emptyHtml = (!exHtml && !sessCondsArr.length)
        ? `<div style="font-size:13px;color:var(--muted)">No exercises logged</div>` : '';

      return `
        <div class="hist-sess-card collapsed" id="hist-card-${sess.id}">
          <div class="hist-sess-header" onclick="histToggle('${sess.id}')">
            <div>
              <div class="hist-sess-type">${sess.session_type || 'Session'}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              ${rpeHtml}
              ${copyBtn}
              <span class="hist-toggle-icon" style="color:var(--muted);font-size:18px">⌄</span>
            </div>
          </div>
          <div class="hist-sess-body">
            ${readinessHtml}
            ${exHtml}${emptyHtml}
            ${condHtml}
            ${notesHtml}
          </div>
        </div>`;
    };

    // Build collapsible week groups (most recent week open by default)
    let weeksHtml = '';
    weekKeys.forEach((wk, wi) => {
      const dateKeys = Object.keys(weekMap[wk]).sort((a, b) => b.localeCompare(a));
      const wkDt     = new Date(wk + 'T00:00:00');
      const wkLabel  = 'Week of ' + wkDt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      S._histWeekIndex[wk] = [];

      let sessCount = 0;
      let daysHtml  = '';
      dateKeys.forEach(d => {
        const dt = new Date(d + 'T00:00:00');
        const dayHeading = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        let sessCardsHtml = '';
        weekMap[wk][d].forEach(sess => {
          sessCount++;
          S._histWeekIndex[wk].push({
            completedId: sess.id,
            plannedId:   sess.planned_session_id || null,
            sessionType: sess.session_type || 'Session',
            dayName:     dt.toLocaleDateString('en-US', { weekday: 'long' }),
          });
          sessCardsHtml += buildSessionCard(sess);
        });
        daysHtml += `
          <div class="hist-day-group" id="hist-day-${d}">
            <div class="hist-day-header">${dayHeading}</div>
            ${sessCardsHtml}
          </div>`;
      });

      weeksHtml += `
        <div class="hist-week-group${wi === 0 ? '' : ' hw-collapsed'}" id="hist-week-${wk}">
          <div class="hist-week-header hist-week-toggle" onclick="histToggleWeek('${wk}')">
            <span>${wkLabel} · ${sessCount} session${sessCount !== 1 ? 's' : ''}</span>
            <span style="display:flex;align-items:center;gap:10px">
              <button class="hist-ctrl-btn" onclick="event.stopPropagation();histCopyWeek('${wk}')">\u29c9 Copy</button>
              <span class="hist-toggle-icon" style="color:var(--muted);font-size:18px">⌄</span>
            </span>
          </div>
          <div class="hist-week-body">${daysHtml}</div>
        </div>`;
    });

    const html = `
      <div class="hist-controls">
        <button class="hist-ctrl-btn" onclick="histExpandAll()">Expand All</button>
        <button class="hist-ctrl-btn" onclick="histCollapseAll()">Collapse All</button>
      </div>
      <div class="hist-day-index">
        ${chipsHtml}
      </div>
      ${weeksHtml}`;
    body.innerHTML = html;
  } catch (err) {
    console.error(err);
    body.innerHTML = '<div class="hist-empty" style="color:var(--danger)">Error loading history.</div>';
  }
}

function histToggle(sessId) {
  const card = document.getElementById('hist-card-' + sessId);
  if (card) card.classList.toggle('collapsed');
}

function histExpandAll() {
  document.querySelectorAll('.hist-week-group.hw-collapsed').forEach(g => g.classList.remove('hw-collapsed'));
  document.querySelectorAll('.hist-sess-card.collapsed').forEach(c => c.classList.remove('collapsed'));
}

function histCollapseAll() {
  document.querySelectorAll('.hist-sess-card:not(.collapsed)').forEach(c => c.classList.add('collapsed'));
  document.querySelectorAll('.hist-week-group:not(.hw-collapsed)').forEach(g => g.classList.add('hw-collapsed'));
}

function histToggleWeek(wk) {
  const group = document.getElementById('hist-week-' + wk);
  if (group) group.classList.toggle('hw-collapsed');
}

function histJumpToWeek(wk) {
  const group = document.getElementById('hist-week-' + wk);
  if (!group) return;
  group.classList.remove('hw-collapsed');
  group.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.hist-day-chip').forEach(chip => chip.classList.remove('active'));
  document.querySelectorAll('.hist-day-chip').forEach(chip => {
    if (chip.getAttribute('onclick') === `histJumpToWeek('${wk}')`) chip.classList.add('active');
  });
}

// ── Copy from history into the current week ──────────────────────────────────
async function histCopySession(completedId, plannedId, sessionType, dayName) {
  if (isOffline) { toast('Not available offline.'); return; }
  toast('Copying\u2026', 2000);
  try {
    const res = await cloneSessionIntoCurrentWeek({
      plannedSessionId:   plannedId || null,
      completedSessionId: completedId,
      sessionType:        sessionType,
      dayLabel:           dayName || null,
    });
    toast(`Copied to this week (${res.count} exercise${res.count !== 1 ? 's' : ''}) \u2713`);
    await loadProgram();   // land on the week screen showing the new session
  } catch (err) {
    console.error('histCopySession:', err);
    toast('Error copying session.', 4000);
  }
}

async function histCopyWeek(wk) {
  if (isOffline) { toast('Not available offline.'); return; }
  const items = (S._histWeekIndex || {})[wk] || [];
  if (!items.length) { toast('Nothing to copy in that week.'); return; }
  showConfirm('Copy this week?',
    `${items.length} session${items.length !== 1 ? 's' : ''} will be added to your current week.`,
    'Copy', () => _histCopyWeekConfirmed(wk));
}

async function _histCopyWeekConfirmed(wk) {
  const items = (S._histWeekIndex || {})[wk] || [];
  toast('Copying week\u2026', 3000);
  try {
    // Oldest first so the new week keeps the original day order
    for (const it of items.slice().reverse()) {
      await cloneSessionIntoCurrentWeek({
        plannedSessionId:   it.plannedId,
        completedSessionId: it.completedId,
        sessionType:        it.sessionType,
        dayLabel:           it.dayName,
      });
    }
    toast(`Copied ${items.length} session${items.length !== 1 ? 's' : ''} \u2713`);
    await loadProgram();
  } catch (err) {
    console.error('histCopyWeek:', err);
    toast('Error copying week.', 4000);
  }
}

// ── Re-edit saved exercise ────────────────────────────────────────────────────
async function reEditExercise(key) {
  const isPlanned = key.startsWith('p-');
  const id        = key.replace(/^[pa]-/, '');

  // Snapshot everything before wiping
  const prevSets     = S.savedExercises[id] || [];
  const prevNotes    = prevSets.find(s => s.notes)?.notes || '';
  const prevMeasure  = prevSets[0]?.measure_type || 'reps';

  try {
    if (isPlanned) {
      await db.from('completed_strength_sets')
        .delete()
        .eq('completed_session_id', S.activeCompletedSession.id)
        .eq('planned_exercise_id', id);
      delete S.savedExercises[id];
      const pe = S.plannedExercises.find(p => p.id === id);
      if (pe) S.exState[id] = {
        skipped:     false,
        swappedTo:   null,
        setCount:    prevSets.length || pe.target_sets || 3,
        measureType: prevMeasure,
      };
    } else {
      const saved = S.savedExercises[id];
      if (saved?.length) {
        await db.from('completed_strength_sets')
          .delete()
          .eq('completed_session_id', S.activeCompletedSession.id)
          .eq('exercise_id', saved[0].exercise_id)
          .eq('is_added', true);
      }
      delete S.savedExercises[id];
      // Restore set count + measure type on the added exercise record
      const ae = S.addedExercises.find(a => String(a.localId) === String(id));
      if (ae) { ae.setCount = prevSets.length || 1; ae.measureType = prevMeasure; }
    }

    // Re-render session (now async — must await so DOM is ready before populating)
    await renderSessionBody();

    // Expand the re-opened card (all cards start collapsed after re-render)
    const reEditCard = document.getElementById(`ex-card-${key}`);
    if (reEditCard) reEditCard.classList.remove('ex-collapsed');

    // Pre-populate inputs with previous values
    prevSets.forEach((s, i) => {
      const loadEl = document.getElementById(`load-${key}-${i}`);
      const repsEl = document.getElementById(`reps-${key}-${i}`);
      const rpeEl  = document.getElementById(`rpe-${key}-${i}`);
      if (loadEl && s.actual_load  != null) loadEl.value = s.actual_load;
      // actual_value holds sec/yds for time/distance; actual_reps holds count for reps
      const repVal = prevMeasure === 'reps' ? s.actual_reps : s.actual_value;
      if (repsEl && repVal != null) repsEl.value = repVal;
      if (rpeEl  && s.actual_rpe != null) rpeEl.value = s.actual_rpe;
    });
    const notesEl = document.getElementById(`notes-${key}`);
    if (notesEl && prevNotes) notesEl.value = prevNotes;

    // Scroll re-opened card into view
    document.getElementById(`ex-card-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    toast('Edit, then tap Save to update.');
  } catch (err) {
    console.error(err);
    toast('Error re-opening exercise.', 4000);
  }
}

