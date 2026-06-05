// ── Tests ─────────────────────────────────────────────────────────────────────

function openTests() {
  document.getElementById('tests-screen-body').innerHTML = '<div class="spinner">Loading…</div>';
  showScreen('tests');
  loadTests();
}

async function loadTests() {
  const body = document.getElementById('tests-screen-body');
  try {
    const { data: tests } = await db.from('strength_tests')
      .select('*, exercise:exercise_id(id,name)')
      .eq('athlete_id', S.athlete.id)
      .order('test_date', { ascending: false });

    if (!tests || tests.length === 0) {
      body.innerHTML = `
        <p style="color:var(--muted);font-size:14px;text-align:center;margin:32px 0 16px">
          No tests logged yet.<br>Record your first result below.
        </p>
        <button class="btn" onclick="openTestLogSheet()">+ Log Test</button>`;
      return;
    }

    // Group by exercise
    const exMap = {};
    tests.forEach(t => {
      const id = t.exercise?.id;
      if (!id) return;
      if (!exMap[id]) exMap[id] = { id, name: t.exercise.name, tests: [] };
      exMap[id].tests.push(t);
    });

    let html = `<button class="btn" style="margin-bottom:16px" onclick="openTestLogSheet()">+ Log Test</button>`;
    Object.values(exMap)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(ex => {
        const sorted  = [...ex.tests].sort((a, b) => b.test_date.localeCompare(a.test_date));
        const bestVal = Math.max(...ex.tests.map(t => t.true_1rm || t.e1rm || 0));
        const bestTest = ex.tests.find(t => (t.true_1rm || t.e1rm || 0) >= bestVal);
        const bestLabel = bestTest?.true_1rm ? 'True 1RM' : 'e1RM';
        const lastDate = new Date(sorted[0].test_date + 'T00:00:00')
          .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const cnt = ex.tests.length;
        const safeName = ex.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        html += `
          <div class="test-ex-row" onclick="openTestHistSheet('${ex.id}','${safeName}')">
            <div>
              <div class="test-ex-name">${ex.name}</div>
              <div class="test-ex-meta">Last: ${lastDate}  ·  ${cnt} test${cnt > 1 ? 's' : ''}</div>
            </div>
            <div>
              ${bestVal ? `<div class="test-ex-best">${bestVal} lb</div><div class="test-ex-best-sub">${bestLabel}</div>` : '<div class="test-ex-best-sub" style="text-align:right">—</div>'}
            </div>
          </div>`;
      });
    body.innerHTML = html;
  } catch (err) {
    console.error(err);
    body.innerHTML = '<div style="color:var(--danger);padding:32px;text-align:center">Error loading tests.</div>';
  }
}

function openTestLogSheet(exId = null, exName = null) {
  testSelectedExId   = exId;
  testSelectedExName = exName;
  const btn = document.getElementById('test-ex-btn');
  if (exId && exName) {
    btn.textContent = exName;
    btn.classList.add('selected');
  } else {
    btn.textContent = 'Select exercise…';
    btn.classList.remove('selected');
  }
  document.getElementById('test-date').value    = today();
  document.getElementById('test-load').value    = '';
  document.getElementById('test-reps').value    = '';
  document.getElementById('test-true1rm').value = '';
  document.getElementById('test-rpe').value     = '';
  document.getElementById('test-notes').value   = '';
  document.getElementById('test-e1rm-display').textContent = '—';
  document.getElementById('test-log-overlay').classList.add('open');
  document.getElementById('test-log-sheet').classList.add('open');
}

function closeTestLogSheet() {
  document.getElementById('test-log-overlay').classList.remove('open');
  document.getElementById('test-log-sheet').classList.remove('open');
}

function openTestExSelect() {
  // Close test log sheet first so ex-sheet renders on top (same z-index)
  document.getElementById('test-log-overlay').classList.remove('open');
  document.getElementById('test-log-sheet').classList.remove('open');
  S.sheetMode = 'test-ex-select';
  document.getElementById('ex-sheet-title').textContent = 'Select Exercise';
  openExSheet(null);
}

function updateTestE1rm() {
  const load = parseFloat(document.getElementById('test-load').value);
  const reps = parseInt(document.getElementById('test-reps').value);
  const disp = document.getElementById('test-e1rm-display');
  const e = epley(load, reps);
  disp.textContent = e ? `${e} lb` : '—';
}

async function submitTest() {
  if (!testSelectedExId) { toast('Please select an exercise.'); return; }
  const testDate = document.getElementById('test-date').value || today();
  const load     = parseFloat(document.getElementById('test-load').value)    || null;
  const reps     = parseInt(document.getElementById('test-reps').value)      || null;
  const true1rm  = parseFloat(document.getElementById('test-true1rm').value) || null;
  const rpe      = parseFloat(document.getElementById('test-rpe').value)     || null;
  const notes    = document.getElementById('test-notes').value.trim()        || null;
  const e1rm     = (load && reps) ? epley(load, reps) : null;
  if (!load && !true1rm) { toast('Enter load & reps, or a direct 1RM.'); return; }
  if (isOffline) {
    await idbQueueWrite({ op: 'test', payload: {
      athlete_id: S.athlete.id, exercise_id: testSelectedExId,
      test_date: testDate, actual_load: load, actual_reps: reps,
      true_1rm: true1rm, e1rm, rpe, notes,
    }});
    toast('Test saved offline ✓');
    closeTestLogSheet();
    return;
  }
  try {
    await db.from('strength_tests').insert({
      athlete_id:  S.athlete.id,
      exercise_id: testSelectedExId,
      test_date:   testDate,
      actual_load: load,
      actual_reps: reps,
      true_1rm:    true1rm,
      e1rm:        e1rm,
      rpe,
      notes,
    });
    toast('Test saved ✓');
    closeTestLogSheet();
    loadTests();
  } catch (err) {
    console.error(err);
    toast('Error saving test. Try again.', 4000);
  }
}

async function openTestHistSheet(exId, exName) {
  document.getElementById('test-hist-title').textContent = exName;
  document.getElementById('test-hist-body').innerHTML =
    '<div style="padding:32px;text-align:center;color:var(--muted)">Loading…</div>';
  document.getElementById('test-hist-overlay').classList.add('open');
  document.getElementById('test-hist-sheet').classList.add('open');
  try {
    const { data: tests } = await db.from('strength_tests')
      .select('*')
      .eq('athlete_id', S.athlete.id)
      .eq('exercise_id', exId)
      .order('test_date', { ascending: false });
    if (!tests || !tests.length) {
      document.getElementById('test-hist-body').innerHTML =
        '<div class="hist-empty">No test history.</div>';
      return;
    }
    const bestVal = Math.max(...tests.map(t => t.true_1rm || t.e1rm || 0));
    const safeName = exName.replace(/'/g, "\\'");
    let html = `
      <div style="padding:0 16px 12px">
        <button class="btn" onclick="closeTestHistSheet();openTestLogSheet('${exId}','${safeName}')">+ Log Another Test</button>
      </div>`;
    tests.forEach(t => {
      const d       = new Date(t.test_date + 'T00:00:00');
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const val     = t.true_1rm || t.e1rm;
      const isPR    = val && val >= bestVal;
      const typeStr = t.true_1rm
        ? 'True 1RM'
        : (t.e1rm ? `e1RM  (${t.actual_load} × ${t.actual_reps})` : '');
      const rpeStr  = t.rpe ? `  ·  RPE ${t.rpe}` : '';
      html += `
        <div class="test-hist-row">
          <div class="test-hist-date">
            ${dateStr}${rpeStr}${isPR ? '<span class="test-pr-badge">PR</span>' : ''}
          </div>
          <div class="test-hist-vals">
            <span class="test-hist-main">${val ? val + ' lb' : '—'}</span>
            <span class="test-hist-sub">${typeStr}</span>
          </div>
          ${t.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${t.notes}</div>` : ''}
        </div>`;
    });
    document.getElementById('test-hist-body').innerHTML = html;
  } catch (err) {
    console.error(err);
    document.getElementById('test-hist-body').innerHTML =
      '<div class="hist-empty" style="color:var(--danger)">Error loading history.</div>';
  }
}

function closeTestHistSheet() {
  document.getElementById('test-hist-overlay').classList.remove('open');
  document.getElementById('test-hist-sheet').classList.remove('open');
}

// ── Boot ──────────────────────────────────────────────────────────────────────────────────────

