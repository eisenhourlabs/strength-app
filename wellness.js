// ── Readiness ────────────────────────────────────────────────────────────────────────────────
function openReadiness() {
  document.getElementById('ready-date').textContent = today();
  document.getElementById('ready-body').innerHTML = `
    <div class="form-section-label">Recovery & Readiness (1–5)</div>
    <div class="form-grid">
      <div class="form-field"><label>Energy</label>
        <input type="number" min="1" max="5" inputmode="numeric" id="r-energy" placeholder="1–5"></div>
      <div class="form-field"><label>Soreness</label>
        <input type="number" min="1" max="5" inputmode="numeric" id="r-soreness" placeholder="1–5"></div>
      <div class="form-field"><label>Stress</label>
        <input type="number" min="1" max="5" inputmode="numeric" id="r-stress" placeholder="1–5"></div>
      <div class="form-field"><label>Motivation</label>
        <input type="number" min="1" max="5" inputmode="numeric" id="r-motivation" placeholder="1–5"></div>
    </div>
    <div class="form-section-label">Sleep</div>
    <div class="form-grid">
      <div class="form-field"><label>Sleep (hrs)</label>
        <input type="number" step="0.5" inputmode="decimal" id="r-sleep" placeholder="—"></div>
    </div>
    <div class="form-section-label">Notes</div>
    <div class="form-grid">
      <div class="form-field wide">
        <textarea id="r-notes" placeholder="Anything else worth noting…"></textarea>
      </div>
    </div>`;
  showScreen('readiness');
}

async function submitReadiness() {
  const energy     = parseInt(document.getElementById('r-energy').value)     || null;
  const soreness   = parseInt(document.getElementById('r-soreness').value)   || null;
  const stress     = parseInt(document.getElementById('r-stress').value)     || null;
  const motivation = parseInt(document.getElementById('r-motivation').value) || null;
  const sleep      = parseFloat(document.getElementById('r-sleep').value)    || null;
  const notes      = document.getElementById('r-notes').value.trim()         || null;

  if (isOffline) {
    await idbQueueWrite({ op: 'readiness', payload: {
      athlete_id: S.athlete.id, log_date: today(),
      energy, soreness, stress, motivation, sleep_hours: sleep, notes,
    }});
    toast('Readiness saved offline ✓');
    showScreen('week');
    return;
  }
  try {
    await db.from('readiness_logs').upsert({
      athlete_id:  S.athlete.id,
      log_date:    today(),
      energy, soreness, stress, motivation,
      sleep_hours: sleep,
      notes,
    }, { onConflict: 'athlete_id,log_date' });
    toast('Readiness logged ✓');
    showScreen('week');
  } catch (err) {
    console.error(err);
    toast('Error saving readiness. Try again.', 4000);
  }
}

// ── Pain / Injury sheet ──────────────────────────────────────────────────────
const PAIN_REGIONS = ['Hip','Elbow','Shoulder','Knee','Low Back','Upper Back','Wrist','Ankle','Neck','Other'];

// Group raw pain rows into open episodes (latest row per injury_id, not resolved).
function computeOpenInjuries(rows) {
  const byId = {};
  (rows || []).forEach(function(r) {
    const key = r.injury_id || ('region:' + r.body_region);
    (byId[key] = byId[key] || []).push(r);
  });
  const open = [];
  Object.values(byId).forEach(function(list) {
    list.sort(function(a, b) {
      return (a.log_date || '').localeCompare(b.log_date || '')
          || (a.created_at || '').localeCompare(b.created_at || '');
    });
    const latest = list[list.length - 1];
    if (latest.status === 'resolved') return;
    const exName = list.map(function(r){ return r.exercise_name; }).filter(Boolean).pop() || null;
    open.push({
      injury_id:     latest.injury_id || null,
      body_region:   latest.body_region,
      pain_score:    latest.pain_score,
      status:        latest.status,
      onset_date:    list[0].log_date,
      last_update:   latest.log_date,
      exercise_name: exName,
    });
  });
  open.sort(function(a, b){ return (b.pain_score || 0) - (a.pain_score || 0); });
  return open;
}

async function loadOpenInjuries() {
  if (!S.athlete) return;
  if (isOffline) {
    try { const c = await idbGet('openInjuriesCache'); if (c && c.athleteId === S.athlete.id) S.openInjuries = c.items || []; } catch (_) {}
    return;
  }
  try {
    const { data } = await db.from('pain_injury_logs')
      .select('*').eq('athlete_id', S.athlete.id).order('log_date');
    S.openInjuries = computeOpenInjuries(data);
    try { await idbSet('openInjuriesCache', { athleteId: S.athlete.id, items: S.openInjuries }); } catch (_) {}
  } catch (_) {}
}

function updatePainBadge() {
  const el = document.getElementById('pain-util-badge');
  if (!el) return;
  const n = (S.openInjuries || []).length;
  el.textContent = n || '';
  el.style.display = n ? '' : 'none';
}

function daysAgoLabel(dateStr) {
  if (!dateStr) return '';
  const d0 = new Date(dateStr + 'T00:00:00').setHours(0,0,0,0);
  const t0 = new Date().setHours(0,0,0,0);
  const diff = Math.round((t0 - d0) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return diff + 'd ago';
}

async function openPainSheet(opts) {
  opts = opts || {};
  // Refresh open injuries on open so the list always matches Watch Items / coach.
  if (!opts.newForm && !isOffline) {
    try { await loadOpenInjuries(); } catch (_) {}
    updatePainBadge();
  }
  if (opts.newForm || !(S.openInjuries || []).length) {
    renderPainForm({ exercise_name: opts.exerciseName || null });
  } else {
    renderPainList();
  }
  document.getElementById('pain-overlay').classList.add('open');
  document.getElementById('pain-sheet').classList.add('open');
}

function closePainSheet() {
  document.getElementById('pain-overlay').classList.remove('open');
  document.getElementById('pain-sheet').classList.remove('open');
}

function renderPainList() {
  document.getElementById('pain-sheet-title').textContent = 'Pain / Injury';
  const items = S.openInjuries || [];
  const cards = items.map(function(inj) {
    const meta = [
      inj.pain_score != null ? inj.pain_score + '/10' : null,
      inj.status ? inj.status.charAt(0).toUpperCase() + inj.status.slice(1) : null,
      'updated ' + daysAgoLabel(inj.last_update),
    ].filter(Boolean).join(' · ');
    const idAttr = inj.injury_id || '';
    return '<div class="inj-card">'
      + '<div class="inj-info"><div class="inj-region">' + inj.body_region + '</div>'
      + '<div class="inj-meta">' + meta + '</div></div>'
      + '<div class="inj-actions">'
      + '<button class="inj-btn" onclick="openInjuryUpdate(\'' + idAttr + '\')">Update</button>'
      + '<button class="inj-btn inj-btn-resolve" onclick="resolveInjury(\'' + idAttr + '\')">Resolve</button>'
      + '</div></div>';
  }).join('');
  document.getElementById('pain-sheet-body').innerHTML =
      '<div style="font-size:13px;color:var(--muted);margin-bottom:10px">'
    + 'Outstanding injuries — tap Update to change status, or Resolve to clear.</div>'
    + cards
    + '<button class="btn" style="margin-top:14px" onclick="renderPainForm({})">＋ Log new injury</button>'
    + '<button class="btn secondary" style="margin-top:8px" onclick="closePainSheet()">Close</button>';
}

function openInjuryUpdate(injuryId) {
  const inj = (S.openInjuries || []).find(function(i){ return (i.injury_id || '') === injuryId; });
  if (!inj) { toast('Could not find that injury.'); return; }
  renderPainForm({ update: true, injury_id: inj.injury_id, body_region: inj.body_region });
}

function renderPainForm(prefill) {
  prefill = prefill || {};
  const isUpdate = !!prefill.update;
  document.getElementById('pain-sheet-title').textContent =
    isUpdate ? ('Update — ' + prefill.body_region) : 'Log Pain / Injury';

  const regionField = isUpdate
    ? '<input type="hidden" id="pain-region" value="' + prefill.body_region + '">'
      + '<div class="form-field wide"><label>Body Region</label>'
      + '<div style="padding:8px 0;font-weight:600">' + prefill.body_region + '</div></div>'
    : '<div class="form-field"><label>Body Region</label><select id="pain-region">'
      + '<option value="">Select…</option>'
      + PAIN_REGIONS.map(function(r){ return '<option>' + r + '</option>'; }).join('')
      + '</select></div>';

  const statusDefault = isUpdate ? 'same' : 'new';
  const statusOpts = [['new','New'],['improving','Improving'],['same','Same'],['worse','Worse']]
    .map(function(o){ return '<option value="' + o[0] + '"' + (o[0]===statusDefault?' selected':'') + '>' + o[1] + '</option>'; }).join('');

  const exName  = prefill.exercise_name || '';
  const exField = exName
    ? '<div class="form-field wide"><label>Flagged during</label>'
      + '<div style="padding:8px 0;font-weight:600">' + exName + '</div></div>'
    : '';

  document.getElementById('pain-sheet-body').innerHTML =
      '<input type="hidden" id="pain-injury-id" value="' + (prefill.injury_id || '') + '">'
    + '<input type="hidden" id="pain-exercise-name" value="' + exName.replace(/"/g, '&quot;') + '">'
    + '<div class="form-grid">'
    + regionField
    + exField
    + '<div class="form-field"><label>Pain Score (0–10)</label>'
    + '<input type="number" id="pain-score" min="0" max="10" inputmode="numeric" placeholder="0–10"></div>'
    + '<div class="form-field"><label>Status</label><select id="pain-status">' + statusOpts + '</select></div>'
    + '<div class="form-field"><label>Modified Training?</label><select id="pain-modified">'
    + '<option value="false">No</option><option value="true">Yes</option></select></div>'
    + '<div class="form-field wide"><label>Trigger / Description</label>'
    + '<input type="text" id="pain-trigger" placeholder="What caused it or where it hurts"></div>'
    + '<div class="form-field wide"><label>Notes for coach</label>'
    + '<textarea id="pain-notes" placeholder="Any extra context…"></textarea></div>'
    + '</div>'
    + '<button class="btn" style="margin-top:8px" onclick="submitPain()">' + (isUpdate ? 'Save Update' : 'Save Pain Log') + '</button>'
    + ((S.openInjuries || []).length
        ? '<button class="btn secondary" style="margin-top:8px" onclick="renderPainList()">Back</button>'
        : '<button class="btn secondary" style="margin-top:8px" onclick="closePainSheet()">Cancel</button>');
}

async function submitPain() {
  const region   = document.getElementById('pain-region').value;
  const score    = parseInt(document.getElementById('pain-score').value) || null;
  const status   = document.getElementById('pain-status').value;
  const modified = document.getElementById('pain-modified').value === 'true';
  const trigger  = (document.getElementById('pain-trigger').value || '').trim() || null;
  const notes    = (document.getElementById('pain-notes').value || '').trim() || null;
  const existingId   = (document.getElementById('pain-injury-id').value || '').trim();
  const exerciseName = ((document.getElementById('pain-exercise-name') || {}).value || '').trim() || null;

  if (!region) { toast('Please select a body region.'); return; }
  const injuryId = existingId || (crypto.randomUUID ? crypto.randomUUID() : null);

  const payload = {
    athlete_id:        S.athlete.id,
    log_date:          today(),
    body_region:       region,
    injury_id:         injuryId,
    pain_score:        score,
    status:            status,
    modified_training: modified,
    trigger:           trigger,
    notes:             notes,
    exercise_name:     exerciseName,
  };

  if (isOffline) {
    await idbQueueWrite({ op: 'pain', payload: payload });
    applyPainLocally(payload);
    toast('Pain log saved offline ✓');
    afterPainSave();
    return;
  }
  try {
    await db.from('pain_injury_logs').insert(payload);
    toast(existingId ? 'Update saved ✓' : 'Pain log saved ✓');
    await loadOpenInjuries();
    afterPainSave();
  } catch (err) {
    console.error(err);
    toast('Error saving pain log. Try again.', 4000);
  }
}

async function resolveInjury(injuryId) {
  const inj = (S.openInjuries || []).find(function(i){ return (i.injury_id || '') === injuryId; });
  if (!inj) { toast('Could not find that injury.'); return; }
  showConfirm('Resolve injury?',
    'Mark ' + inj.body_region + ' as resolved. You can log it again if it comes back.',
    'Resolve', function() { _resolveInjuryConfirmed(injuryId); });
}

async function _resolveInjuryConfirmed(injuryId) {
  const inj = (S.openInjuries || []).find(function(i){ return (i.injury_id || '') === injuryId; });
  if (!inj) return;
  const payload = {
    athlete_id:        S.athlete.id,
    log_date:          today(),
    body_region:       inj.body_region,
    injury_id:         inj.injury_id,
    pain_score:        null,
    status:            'resolved',
    modified_training: false,
    trigger:           null,
    notes:             null,
  };
  if (isOffline) {
    await idbQueueWrite({ op: 'pain', payload: payload });
    S.openInjuries = (S.openInjuries || []).filter(function(i){ return (i.injury_id || '') !== injuryId; });
    toast('Marked resolved (offline) ✓');
    afterPainSave();
    return;
  }
  try {
    await db.from('pain_injury_logs').insert(payload);
    await loadOpenInjuries();
    toast('Marked resolved ✓');
    afterPainSave();
  } catch (err) {
    console.error(err);
    toast('Error updating injury. Try again.', 4000);
  }
}

// Optimistically reflect a new/updated pain row in the open-injury list (offline).
function applyPainLocally(p) {
  S.openInjuries = S.openInjuries || [];
  if (p.status === 'resolved') {
    S.openInjuries = S.openInjuries.filter(function(i){ return (i.injury_id || '') !== (p.injury_id || ''); });
    return;
  }
  const existing = S.openInjuries.find(function(i){ return (i.injury_id || '') === (p.injury_id || ''); });
  if (existing) {
    existing.pain_score = p.pain_score; existing.status = p.status; existing.last_update = p.log_date;
  } else {
    S.openInjuries.push({
      injury_id: p.injury_id, body_region: p.body_region, pain_score: p.pain_score,
      status: p.status, onset_date: p.log_date, last_update: p.log_date, exercise_name: p.exercise_name || null,
    });
  }
  S.openInjuries.sort(function(a, b){ return (b.pain_score || 0) - (a.pain_score || 0); });
}

function afterPainSave() {
  updatePainBadge();
  try { idbSet('openInjuriesCache', { athleteId: S.athlete.id, items: S.openInjuries }); } catch (_) {}
  if ((S.openInjuries || []).length) renderPainList();
  else closePainSheet();
}
