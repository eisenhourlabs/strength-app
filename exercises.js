// ── Exercise filter state ───────────────────────────────────────────────────
let activePatternFilter  = null;
let activeSkillFilter    = null;
let _exSheetVVHandler    = null;   // visualViewport resize handler ref for cleanup

// Adjust exercise sheet height/position when keyboard appears (iOS)
function _adjustExSheetForKeyboard() {
  if (!window.visualViewport) return;
  const sheet = document.getElementById('ex-sheet');
  if (!sheet || !sheet.classList.contains('open')) return;
  const vvHeight  = window.visualViewport.height;
  const keyboardH = window.innerHeight - vvHeight - (window.visualViewport.offsetTop || 0);
  sheet.style.maxHeight = Math.max(vvHeight - 60, 200) + 'px';
  sheet.style.bottom    = keyboardH > 0 ? keyboardH + 'px' : '';
}

// ── Exercise sheet ────────────────────────────────────────────────────────────
function openSwap(peId) {
  S.sheetMode = 'swap';
  S.swapExKey = peId;
  document.getElementById('ex-sheet-title').textContent = 'Swap Exercise';
  // Pre-filter to the current exercise's movement pattern
  const pe        = S.plannedExercises.find(p => p.id === peId);
  const st        = S.exState[peId];
  const curExId   = st?.swappedTo?.id || pe?.exercise?.id;
  const curEx     = S.exerciseLib.find(e => e.id === curExId);
  openExSheet(curEx?.movement_pattern || null);
}

function openAddedSwap(localId) {
  S.sheetMode = 'swap-added';
  S.swapExKey = localId;
  document.getElementById('ex-sheet-title').textContent = 'Swap Exercise';
  // Pre-filter to current exercise's movement pattern if possible
  const ae    = S.addedExercises.find(a => String(a.localId) === String(localId));
  const curEx = ae ? S.exerciseLib.find(e => e.id === ae.exId) : null;
  openExSheet(curEx?.movement_pattern || null);
}

function openAddExSheet() {
  S.sheetMode = 'add';
  S.swapExKey = null;
  document.getElementById('ex-sheet-title').textContent = 'Add Exercise';
  openExSheet();
}

function openExSheet(defaultPattern = null) {
  activePatternFilter = defaultPattern;
  activeSkillFilter   = null;
  document.getElementById('ex-search').value = '';
  renderSkillChips();
  renderChips();
  renderExList(getFilteredExercises());
  // Scroll active chip into view
  setTimeout(() => {
    const active = document.querySelector('#pattern-chips .chip-active');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, 50);
  document.getElementById('ex-overlay').classList.add('open');
  document.getElementById('ex-sheet').classList.add('open');
  setTimeout(() => document.getElementById('ex-search').focus(), 300);

  // Attach keyboard-appears listener (iOS: keyboard shrinks visualViewport)
  if (window.visualViewport && !_exSheetVVHandler) {
    _exSheetVVHandler = _adjustExSheetForKeyboard;
    window.visualViewport.addEventListener('resize', _exSheetVVHandler);
  }
}

function closeExSheet() {
  document.getElementById('ex-overlay').classList.remove('open');
  document.getElementById('ex-sheet').classList.remove('open');
  // Remove keyboard listener and reset any inline sheet sizing
  if (_exSheetVVHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', _exSheetVVHandler);
    _exSheetVVHandler = null;
  }
  const sheet = document.getElementById('ex-sheet');
  if (sheet) { sheet.style.maxHeight = ''; sheet.style.bottom = ''; }
}

// ── Skill level filter ───────────────────────────────────────────────────────
const SKILL_LEVELS = ['beginner', 'novice', 'intermediate', 'advanced'];
function skillRank(level) {
  const idx = SKILL_LEVELS.indexOf((level || '').toLowerCase());
  return idx === -1 ? 99 : idx;
}

function renderSkillChips() {
  const el = document.getElementById('skill-chips');
  if (!el) return;
  // Only show levels that exist in the loaded library
  const presentLevels = [...new Set(
    (S.exerciseLib || []).map(e => (e.skill_level || '').toLowerCase()).filter(Boolean)
  )].sort((a, b) => skillRank(a) - skillRank(b));
  if (presentLevels.length < 2) { el.innerHTML = ''; return; }
  const chips = [{ label: 'All Levels', value: null },
    ...presentLevels.map(l => ({ label: l.charAt(0).toUpperCase() + l.slice(1), value: l }))];
  el.innerHTML = chips.map(ch => {
    const val    = ch.value === null ? 'null' : `'${ch.value}'`;
    const active = activeSkillFilter === ch.value ? ' chip-active' : '';
    return `<button class="chip${active}" onclick="setSkillFilter(${val})">${ch.label}</button>`;
  }).join('');
}

function setSkillFilter(level) {
  activeSkillFilter = level;
  renderSkillChips();
  renderChips();
  renderExList(getFilteredExercises());
}

function renderChips() {
  const patterns = [...new Set(
    S.exerciseLib.map(e => e.movement_pattern).filter(Boolean)
  )].sort();
  const chips = [{ label: 'All', value: null }, ...patterns.map(p => ({ label: p, value: p }))];
  document.getElementById('pattern-chips').innerHTML = chips.map(ch => {
    const val    = ch.value === null ? 'null' : `'${ch.value}'`;
    const active = activePatternFilter === ch.value ? ' chip-active' : '';
    return `<button class="chip${active}" onclick="setPatternFilter(${val})">${ch.label}</button>`;
  }).join('');
}

function setPatternFilter(pattern) {
  activePatternFilter = pattern;
  renderChips();
  renderExList(getFilteredExercises());
}

function getFilteredExercises() {
  const q = (document.getElementById('ex-search')?.value || '').toLowerCase().trim();
  const isTestMode = S.sheetMode === 'test-ex-select';
  return S.exerciseLib.filter(ex => {
    const matchesPat   = !activePatternFilter || ex.movement_pattern === activePatternFilter;
    const matchesTxt   = !q || ex.name.toLowerCase().includes(q);
    // Cumulative skill filter: selecting 'intermediate' shows beginner, novice, and intermediate
    const matchesSkill = !activeSkillFilter || skillRank(ex.skill_level) <= skillRank(activeSkillFilter);
    // In test mode with no active search, restrict to strength exercises only
    const matchesType = !isTestMode || q || ex.exercise_type !== 'conditioning';
    // Exclude conditioning exercises from swap/add lists in strength sessions
    const isCondOnlySession = S.activeSession?.session_type === 'Conditioning Only'
      || (S.activeSession?.includes_conditioning && !(S.plannedExercises || []).some(p => p.exercise?.exercise_type !== 'conditioning'));
    const notCondExercise = isCondOnlySession || ex.exercise_type !== 'conditioning';
    return matchesPat && matchesTxt && matchesType && notCondExercise && matchesSkill;
  });
}

function filterExercises() {
  renderExList(getFilteredExercises());
}

function renderExList(list) {
  document.getElementById('ex-list').innerHTML = list.map(ex => `
    <div class="sheet-item"
      onclick="selectExercise('${ex.id}','${ex.name.replace(/'/g,"\\'").replace(/"/g,"&quot;")}')">
      <div class="sheet-item-name">${ex.name}</div>
      <div class="sheet-item-meta">${ex.movement_pattern||''}</div>
    </div>`).join('');
}

// ── Persist "intent to do this exercise" immediately so it survives re-entry ──
// Saves a set_number=0 placeholder row. On re-enter the session, reconstructAddedExercises
// detects this and restores the empty editable tile. Real saves delete the placeholder first.
async function persistAddedExercisePlaceholder(localId, exId) {
  try {
    const placeholderRow = {
      exercise_id: exId, is_added: true, is_skipped: false,
      set_number: 0, actual_load: null, actual_reps: null, actual_rpe: null,
    };
    if (isOffline || !(await checkOnline())) {
      isOffline = true; updateOfflineBanner();
      if (!S.activeCompletedSession) {
        const tid = crypto.randomUUID();
        const sp  = { athlete_id: S.athlete.id, planned_session_id: S.activeSession.id,
          session_date: today(), week_of: S.cycle?.start_date,
          session_type: S.activeSession.session_type, status: 'in_progress' };
        await idbQueueWrite({ op: 'create_session', tempSessionId: tid, payload: sp });
        S.activeCompletedSession        = { id: tid, _isTemp: true, ...sp };
        S.completed[S.activeSession.id] = S.activeCompletedSession;
      }
      await idbQueueWrite({ op: 'insert_sets',
        payload: [{ ...placeholderRow, completed_session_id: S.activeCompletedSession.id }] });
    } else {
      if (!S.activeCompletedSession) {
        const { data: cs, error: csErr } = await db.from('completed_sessions').insert({
          athlete_id: S.athlete.id, planned_session_id: S.activeSession.id,
          session_date: today(), week_of: S.cycle?.start_date,
          session_type: S.activeSession.session_type, status: 'in_progress',
        }).select().single();
        if (csErr) throw csErr;
        S.activeCompletedSession        = cs;
        S.completed[S.activeSession.id] = cs;
      }
      await db.from('completed_strength_sets').insert({
        ...placeholderRow, completed_session_id: S.activeCompletedSession.id,
      });
    }
  } catch (err) {
    console.error('placeholder save failed:', err);
    // Non-blocking — tile is visible; just won't persist if app is fully restarted
  }
}

function selectExercise(exId, exName) {
  closeExSheet();
  if (S.sheetMode === 'swap' && S.swapExKey) {
    const st = S.exState[S.swapExKey];
    if (st) st.swappedTo = { id: exId, name: exName };
    const key  = `p-${S.swapExKey}`;
    const card = document.getElementById(`ex-card-${key}`);
    if (card) {
      card.querySelector('.ex-name').textContent = exName;
      let swapNote = card.querySelector('.ex-swap-note');
      const origName = S.plannedExercises.find(pe => pe.id === S.swapExKey)?.exercise?.name || '';
      if (!swapNote) {
        const exBody = card.querySelector('.ex-body');
        const insertTarget = exBody || card.querySelector('.ex-header');
        if (insertTarget) insertTarget.insertAdjacentHTML(
          exBody ? 'afterbegin' : 'afterend',
          `<div class="ex-swap-note">⇕ swapped from ${origName}</div>`);
      }
    }
    // Immediately persist swap to draft so it survives re-entry without an explicit Save
    ;(async () => {
      try {
        const sessionId = S.activeSession?.id;
        if (!sessionId) return;
        const allDrafts = (await idbGet('sessionDraftCache')) || {};
        const draft = allDrafts[sessionId] || {};
        draft[key] = { ...(draft[key] || { sets: [], notes: '' }), swappedTo: { id: exId, name: exName } };
        allDrafts[sessionId] = draft;
        await idbSet('sessionDraftCache', allDrafts);
      } catch (_) {}
    })();
  } else if (S.sheetMode === 'test-ex-select') {
    testSelectedExId   = exId;
    testSelectedExName = exName;
    const btn = document.getElementById('test-ex-btn');
    btn.textContent = exName;
    btn.classList.add('selected');
    // Re-open the test log sheet now that ex-sheet has closed
    document.getElementById('test-log-overlay').classList.add('open');
    document.getElementById('test-log-sheet').classList.add('open');
  } else if (S.sheetMode === 'add') {
    const localId = ++S.addedCounter;
    S.addedExercises.push({ localId, exId, exName, setCount: 1, measureType: 'reps' });
    persistAddedExercisePlaceholder(localId, exId);   // fire-and-forget DB write
    const key        = `a-${localId}`;
    const exList     = document.getElementById('exercise-list');
    const newCardHtml = `
      <div class="ex-card added-card" id="ex-card-${key}">
        <div class="ex-header">
          <span class="drag-handle">≡</span>
          <span class="ex-name">${exName}</span>
          <div class="ex-header-right">
            <span class="ex-swap" onclick="openAddedSwap('${localId}')">&#8644; swap</span>
            <button class="ex-collapse-btn" onclick="toggleExCard('${key}')">&#9660;</button>
          </div>
        </div>
        <div class="ex-body">
          <div class="measure-chip-wrap">
            <select class="measure-chip" onchange="changeMeasureType('${key}',this.value)" id="mchip-${key}">
              <option value="reps" selected>Reps</option>
              <option value="time">Time (sec)</option>
              <option value="dist">Distance (yds)</option>
            </select>
          </div>
          <div class="sets-wrap" id="sets-${key}">${buildOneSetRow(key, 0, false, 'reps')}</div>
          <button class="add-set-btn" onclick="addSet('${key}','${localId}',true)">＋ Add Set</button>
          <textarea class="notes-input" id="notes-${key}" placeholder="Notes…"></textarea>
          <div class="ex-footer">
            <button class="remove-btn" onclick="removeAdded('${localId}')">Remove</button>
            <button class="pain-flag-btn" id="pflag-${key}"
              onclick="togglePainFlag('${key}','${exName.replace(/'/g,"\\'")}')">🩹 Pain</button>
            <button class="save-ex-btn" id="save-${key}"
              onclick="saveAddedExercise('${localId}')">Save</button>
          </div>

        </div>
      </div>`
    if (exList) exList.insertAdjacentHTML('beforeend', newCardHtml);
  } else if (S.sheetMode === 'swap-added' && S.swapExKey != null) {
    // Swap an added exercise
    const localId = String(S.swapExKey);
    const ae = S.addedExercises.find(a => String(a.localId) === localId);
    if (ae) {
      const oldName  = ae.exName;
      ae.swappedFrom = oldName;
      ae.exId        = exId;
      ae.exName      = exName;
      const key  = `a-${ae.localId}`;
      const card = document.getElementById(`ex-card-${key}`);
      if (card) {
        card.querySelector('.ex-name').textContent = exName;
        let swapNote = card.querySelector('.ex-swap-note');
        if (!swapNote) {
          card.querySelector('.ex-header').insertAdjacentHTML(
            'afterend', `<div class="ex-swap-note">↕ swapped from ${oldName}</div>`);
        } else {
          swapNote.textContent = `↕ swapped from ${oldName}`;
        }
      }
    }
    S.swapExKey = null;
  }
}

async function removeAdded(localId) {
  const ae = S.addedExercises.find(a => String(a.localId) === String(localId));
  S.addedExercises = S.addedExercises.filter(a => String(a.localId) !== String(localId));
  delete S.savedExercises[localId];
  const card = document.getElementById(`ex-card-a-${localId}`);
  if (card) card.remove();
  // Clean up placeholder row from DB (fire-and-forget)
  if (ae && S.activeCompletedSession && !S.activeCompletedSession._isTemp) {
    try {
      await db.from('completed_strength_sets').delete()
        .eq('completed_session_id', S.activeCompletedSession.id)
        .eq('exercise_id', ae.exId).eq('is_added', true).eq('set_number', 0);
    } catch (_) {}
  }
}

