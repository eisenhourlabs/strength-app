// ── Conditioning-only session ─────────────────────────────────────────────────
const COND_MODALITIES = ['Echo Bike','SkiErg','Rower','Run','Ruck','Walk','Cycling','Sled','Jump Rope','Versaclimber','Swimming','Circuit Training','Other'];

// ── Conditioning taxonomy ────────────────────────────────────────────────────
// Three INDEPENDENT axes. workout_type above is a FORMAT vocabulary; coaching
// reasons in INTENSITY DOMAINS, and the two are not the same question. The case
// that broke the old single field: a run-walk held at Zone 2 is Intervals
// STRUCTURE at Z2 INTENSITY, and "Intervals" alone implied hard while "Steady
// State" alone implied continuous.
// MIRRORS 05_Scripts/conditioning_enums.json and the SQL CHECK constraints in
// 05_Scripts/sql/2026-09-14_conditioning_taxonomy.sql — change all three together.
const COND_INTENSITY = [
  ['Z1_Recovery',      'Z1 · Recovery — easy, restorative'],
  ['Z2_Aerobic_Base',  'Z2 · Aerobic base — conversational, under AeT'],
  ['Z3_Upper_Aerobic', 'Z3 · Upper aerobic — at or just over AeT'],
  ['Z4_Threshold',     'Z4 · Threshold — hard but sustainable'],
  ['Z5_VO2',           'Z5 · VO2 — hard, repeatable 3–8 min'],
  ['Z6_Anaerobic',     'Z6 · Anaerobic — short and maximal'],
];
const COND_STRUCTURE = [
  ['Continuous', 'Continuous — one unbroken effort'],
  ['Intervals',  'Intervals — timed work and rest'],
  ['Repeats',    'Repeats — the trip back is the recovery (hills, stairs, descents)'],
  ['Fartlek',    'Fartlek — surges inside a continuous session'],
  ['Circuit',    'Circuit — mixed-modal rounds'],
];
const COND_PURPOSE = [
  ['Aerobic_Development', 'Aerobic development'],
  ['Recovery',            'Recovery / flush'],
  ['Work_Capacity',       'Work capacity / GPP'],
  ['Event_Specific',      'Event specific'],
  ['Durability',          'Durability — tissue, judged on next-day response'],
  ['Benchmark',           'Benchmark / test — excluded from volume totals'],
  ['Rehab_Support',       'Rehab support'],
];
const COND_LEGACY_MAP = {
  'Steady State': ['Z2_Aerobic_Base', 'Continuous', 'Aerobic_Development'],
  'Tempo':        ['Z4_Threshold',    'Continuous', 'Aerobic_Development'],
  'Intervals':    ['Z5_VO2',          'Intervals',  'Work_Capacity'],
  'Circuit':      ['Z5_VO2',          'Circuit',    'Work_Capacity'],
};
const COND_IMPACT_BY_MODALITY = {
  'Run': 'High_Eccentric',
  'Ruck': 'Moderate', 'Sled': 'Moderate', 'Jump Rope': 'Moderate',
  'Circuit Training': 'Moderate',
};

function condDomainLabel(v) {
  const row = COND_INTENSITY.find(function(x) { return x[0] === v; });
  return row ? row[1].split(' — ')[0] : (v || '—');
}
function condShortLabel(list, v) {
  const row = list.find(function(x) { return x[0] === v; });
  return row ? row[1].split(' — ')[0] : (v || '—');
}

// Defaults for a block: the coach's prescription if there is one, else the same
// mechanical map the SQL backfill uses. Derived values are marked as such when
// saved — they are a guess from the format field, not an observation.
function condTaxonomyDefaults(workoutType, modality, pc) {
  const legacy = COND_LEGACY_MAP[workoutType] || [null, null, null];
  return {
    intensityDomain:  (pc && pc.intensity_domain)  || legacy[0] || '',
    sessionStructure: (pc && pc.session_structure) || legacy[1] || '',
    sessionPurpose:   (pc && pc.session_purpose)   || legacy[2] || '',
    impactLoad:       (pc && pc.impact_load)       || COND_IMPACT_BY_MODALITY[modality] || 'Low',
  };
}
const COND_LOAD_MODS  = ['Ruck','Sled'];
const COND_DIST_CONV  = { mi: 1609.34, km: 1000, m: 1, ft: 0.3048 };

function renderCondBlock(b, idx, total) {
  const modOpts = ['<option value="">Select modality…</option>']
    .concat(COND_MODALITIES.map(function(m) { return '<option value="' + m + '"' + (b.modality === m ? ' selected' : '') + '>' + m + '</option>'; }))
    .join('');
  const showLoad    = COND_LOAD_MODS.includes(b.modality);
  const isCircuit   = b.modality === 'Circuit Training';
  const isIntervals = !isCircuit && b.workoutType === 'Intervals';
  const removeBtn   = total > 1
    ? '<button class="sess-del-btn" onclick="removeCondBlock(' + b.id + ')" style="margin-left:auto" title="Remove">&#x2715;</button>'
    : '';

  // Workout type selector (hidden for circuit — auto Circuit)
  const wtOpts = ['Steady State','Intervals','Tempo'].map(function(t) {
    return '<option value="' + t + '"' + (b.workoutType === t ? ' selected' : '') + '>' + t + '</option>';
  }).join('');
  const wtField = isCircuit ? '' :
    '<div class="form-field"><label>Type</label>'
    + '<select id="cond-wt-' + b.id + '" onchange="updateCondBlockFields(' + b.id + ')">'
    + '<option value="">Select…</option>' + wtOpts + '</select></div>';

  // Interval-specific fields per block
  const intFields = '<div class="form-field" id="cond-int-work-row-' + b.id + '" style="' + (isIntervals ? '' : 'display:none') + '">'
    + '<label>Work (sec)</label>'
    + '<input type="number" inputmode="numeric" id="cond-int-work-' + b.id + '" placeholder="—" value="' + (b.intWork || '') + '"></div>'
    + '<div class="form-field" id="cond-int-rest-row-' + b.id + '" style="' + (isIntervals ? '' : 'display:none') + '">'
    + '<label>Rest (sec)</label>'
    + '<input type="number" inputmode="numeric" id="cond-int-rest-' + b.id + '" placeholder="—" value="' + (b.intRest || '') + '"></div>'
    + '<div class="form-field" id="cond-int-rounds-row-' + b.id + '" style="' + (isIntervals ? '' : 'display:none') + '">'
    + '<label>Rounds completed</label>'
    + '<input type="number" inputmode="numeric" id="cond-int-rounds-' + b.id + '" placeholder="—" value="' + (b.intRounds || '') + '"></div>'
    + '<div class="form-field" id="cond-int-maxhr-row-' + b.id + '" style="' + (isIntervals ? '' : 'display:none') + '">'
    + '<label>Max HR (bpm)</label>'
    + '<input type="number" inputmode="numeric" id="cond-int-maxhr-' + b.id + '" placeholder="—" value="' + (b.intMaxHR || '') + '"></div>';

  // Standard modality fields (hidden for circuit)
  const stdFields = '<div class="form-field' + (isCircuit ? ' cond-std-fields" style="display:none' : ' cond-std-fields') + '">'
    + '<label>Duration (min)</label>'
    + '<input type="number" inputmode="decimal" id="cond-dur-' + b.id + '" placeholder="—" value="' + (b.duration || '') + '"></div>'
    + '<div class="form-field cond-std-fields' + (isCircuit ? '" style="display:none' : '') + '">'
    + '<label>Distance</label>'
    + '<div class="dist-row">'
    + '<input type="number" inputmode="decimal" id="cond-dist-' + b.id + '" placeholder="—" value="' + (b.distance || '') + '">'
    + '<select id="cond-dunit-' + b.id + '">'
    + '<option value="mi"' + (b.distUnit === 'mi' ? ' selected' : '') + '>mi</option>'
    + '<option value="km"' + (b.distUnit === 'km' ? ' selected' : '') + '>km</option>'
    + '<option value="m"'  + (b.distUnit === 'm'  ? ' selected' : '') + '>m</option>'
    + '<option value="ft"' + (b.distUnit === 'ft' ? ' selected' : '') + '>ft</option>'
    + '</select></div></div>'
    + '<div class="form-field cond-std-fields" id="cond-load-row-' + b.id + '" style="' + (showLoad && !isCircuit ? '' : 'display:none') + '">'
    + '<label>Load (lb)</label>'
    + '<input type="number" inputmode="decimal" id="cond-load-' + b.id + '" placeholder="—" value="' + (b.load || '') + '"></div>';

  // Circuit-specific fields
  const circuitFields = '<div class="form-field wide cond-circuit-fields" style="' + (isCircuit ? '' : 'display:none') + '">'
    + '<label>Describe the circuit (exercises, reps, format…)</label>'
    + '<textarea class="circuit-desc" id="cond-circuit-desc-' + b.id + '" placeholder="e.g. AMRAP 20min: 10 pull-ups, 15 push-ups, 20 air squats…">' + (b.circuitDesc || '') + '</textarea></div>'
    + '<div class="form-field cond-circuit-fields" style="' + (isCircuit ? '' : 'display:none') + '">'
    + '<label>Rounds completed</label>'
    + '<input type="number" inputmode="numeric" id="cond-circuit-rounds-' + b.id + '" placeholder="—" value="' + (b.circuitRounds || '') + '"></div>'
    + '<div class="form-field cond-circuit-fields" style="' + (isCircuit ? '' : 'display:none') + '">'
    + '<label>Total time (min)</label>'
    + '<input type="number" inputmode="decimal" id="cond-circuit-dur-' + b.id + '" placeholder="—" value="' + (b.duration || '') + '"></div>';

  // Taxonomy: collapsed to a one-line summary so a session that matches the
  // prescription is still Log -> done. It only costs taps when you are deviating,
  // which is exactly when the detail is worth recording.
  const sel = function(id, list, cur) {
    return '<select id="' + id + '" onchange="markCondTaxonomyEdited(' + b.id + ')">'
      + list.map(function(o) {
          return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('')
      + '</select>';
  };
  const summary = condShortLabel(COND_INTENSITY, b.intensityDomain) + ' · '
                + condShortLabel(COND_STRUCTURE, b.sessionStructure) + ' · '
                + condShortLabel(COND_PURPOSE,   b.sessionPurpose);
  const taxFields = '<div class="form-field wide cond-tax-wrap">'
    + '<button type="button" class="cond-tax-toggle" id="cond-tax-btn-' + b.id + '"'
    + ' onclick="toggleCondTaxonomy(' + b.id + ')"'
    + ' style="width:100%;text-align:left;background:none;border:1px dashed var(--border,#ccc);'
    + 'border-radius:6px;padding:8px 10px;font-size:13px;color:var(--muted,#666)">'
    + '<span id="cond-tax-summary-' + b.id + '">' + summary + '</span>'
    + '<span style="float:right">▾</span></button>'
    + '<div id="cond-tax-body-' + b.id + '" style="display:none;margin-top:8px">'
    + '<div class="form-field"><label>Intensity</label>'   + sel('cond-dom-' + b.id, COND_INTENSITY, b.intensityDomain)  + '</div>'
    + '<div class="form-field"><label>Structure</label>'   + sel('cond-str-' + b.id, COND_STRUCTURE, b.sessionStructure) + '</div>'
    + '<div class="form-field"><label>Purpose</label>'     + sel('cond-pur-' + b.id, COND_PURPOSE,   b.sessionPurpose)   + '</div>'
    + '</div></div>';

  return '<div class="cond-block" id="cond-block-' + b.id + '">'
    + '<div class="cond-block-hdr"><span class="cond-block-num">Block ' + (idx + 1) + '</span>' + removeBtn + '</div>'
    + '<div class="form-grid">'
    + '<div class="form-field wide"><label>Modality</label>'
    + '<select id="cond-mod-' + b.id + '" onchange="updateCondBlockFields(' + b.id + ')">' + modOpts + '</select></div>'
    + wtField
    + stdFields
    + intFields
    + circuitFields
    + taxFields
    + '</div></div>';
}

function renderCondSessionFields(pc) {
  let planHtml = '';
  if (pc) {
    const hrRange = (pc.target_hr_low && pc.target_hr_high)
      ? pc.target_hr_low + '–' + pc.target_hr_high + ' bpm'
      : (pc.target_hr_high ? '≤ ' + pc.target_hr_high + ' bpm' : (pc.target_hr_low ? '≥ ' + pc.target_hr_low + ' bpm' : null));
    // Prescribed interval structure — previously invisible to the athlete, which is
    // why a prescribed ratio could only be contradicted in a free-text note.
    const structure = (pc.work_duration_sec && pc.rest_duration_sec)
      ? 'Prescribed: ' + pc.work_duration_sec + 's work / ' + pc.rest_duration_sec + 's rest'
        + (pc.target_rounds ? ' × ' + pc.target_rounds : '')
      : (pc.target_rounds ? 'Prescribed: ' + pc.target_rounds + ' rounds' : null);
    planHtml = '<div class="cond-plan">'
      + '<div class="cond-plan-label">Coach Plan</div>'
      + '<div class="cond-plan-val">' + (pc.modality || '—') + ' · ' + (pc.workout_type || '—') + '</div>'
      + '<div class="cond-plan-sub">' + (pc.target_duration_min ? pc.target_duration_min + ' min' : '') + (hrRange ? ' · HR ' + hrRange : '') + '</div>'
      + (structure ? '<div class="cond-plan-sub">' + structure + '</div>' : '')
      + (pc.coach_notes ? '<div class="cond-plan-sub" style="color:var(--accent);margin-top:6px">' + pc.coach_notes + '</div>' : '')
      + '</div>';
  }
  return planHtml
    + '<div class="form-section-label" style="margin-top:12px">Overall Feel</div>'
    + '<div class="form-grid">'
    + '<div class="form-field"><label>Avg HR (bpm)</label>'
    + '<input type="number" inputmode="numeric" id="cond-avg-hr" placeholder="—"></div>'
    + '<div class="form-field"><label>RPE (1–10)</label>'
    + '<input type="number" step="0.5" min="1" max="10" inputmode="decimal" id="cond-rpe" placeholder="—"></div>'
    + '<div class="form-field wide"><label>Notes</label>'
    + '<textarea id="cond-notes" placeholder="How it felt, any issues…"></textarea></div>'
    + '</div>';
}

function renderCondBlocksHtml() {
  return '<div class="form-section-label">Modalities</div>'
    + '<div id="cond-blocks-list">'
    + S.condBlocks.map(function(b, i) { return renderCondBlock(b, i, S.condBlocks.length); }).join('')
    + '</div>'
    + '<button class="btn secondary" onclick="addCondBlock()" style="margin-top:6px;font-size:13px">➕ Add Modality</button>'
    + '<div style="height:4px"></div>';
}

function renderCondFormHtml(pc) {
  return renderCondBlocksHtml() + renderCondSessionFields(pc);
}

function toggleCondTaxonomy(id) {
  const body = document.getElementById('cond-tax-body-' + id);
  if (body) body.style.display = (body.style.display === 'none') ? '' : 'none';
}

// Provenance matters: a value the athlete actually chose is evidence, a value
// carried over from the plan is the coach's intent, and a value derived from
// workout_type is neither. The pull report labels them differently.
function markCondTaxonomyEdited(id) {
  const b = S.condBlocks.find(function(x) { return x.id === id; });
  if (!b) return;
  b.taxonomyEdited = true;
  syncCondTaxonomyFromDOM(b);
  const sm = document.getElementById('cond-tax-summary-' + id);
  if (sm) sm.textContent = condShortLabel(COND_INTENSITY, b.intensityDomain) + ' · '
                         + condShortLabel(COND_STRUCTURE, b.sessionStructure) + ' · '
                         + condShortLabel(COND_PURPOSE,   b.sessionPurpose);
}

function syncCondTaxonomyFromDOM(b) {
  const d = document.getElementById('cond-dom-' + b.id);
  const s = document.getElementById('cond-str-' + b.id);
  const u = document.getElementById('cond-pur-' + b.id);
  if (d) b.intensityDomain  = d.value;
  if (s) b.sessionStructure = s.value;
  if (u) b.sessionPurpose   = u.value;
}

function updateCondBlockFields(id) {
  const modEl = document.getElementById('cond-mod-' + id);
  const wtEl  = document.getElementById('cond-wt-'  + id);
  const mod   = modEl ? modEl.value : '';
  const wt    = wtEl  ? wtEl.value  : '';
  const isCircuit   = mod === 'Circuit Training';
  const isIntervals = !isCircuit && wt === 'Intervals';
  // Toggle standard vs circuit field sets
  const block = document.getElementById('cond-block-' + id);
  if (block) {
    block.querySelectorAll('.cond-std-fields').forEach(function(el) {
      el.style.display = isCircuit ? 'none' : '';
    });
    block.querySelectorAll('.cond-circuit-fields').forEach(function(el) {
      el.style.display = isCircuit ? '' : 'none';
    });
    // Load row visibility within standard fields
    const loadRow = document.getElementById('cond-load-row-' + id);
    if (loadRow) loadRow.style.display = (!isCircuit && COND_LOAD_MODS.includes(mod)) ? '' : 'none';
    // Interval-specific rows per block
    ['cond-int-work-row-' + id, 'cond-int-rest-row-' + id,
     'cond-int-rounds-row-' + id, 'cond-int-maxhr-row-' + id].forEach(function(rid) {
      const el = document.getElementById(rid);
      if (el) el.style.display = isIntervals ? '' : 'none';
    });
  }
  const b = S.condBlocks.find(function(x) { return x.id === id; });
  if (b) {
    b.modality = mod; b.workoutType = wt;
    // Re-derive from the new format/modality — but never overwrite a choice the
    // athlete made by hand.
    if (!b.taxonomyEdited) {
      const d = condTaxonomyDefaults(isCircuit ? 'Circuit' : wt, mod, S.plannedConditioning);
      b.intensityDomain  = d.intensityDomain;
      b.sessionStructure = d.sessionStructure;
      b.sessionPurpose   = d.sessionPurpose;
      b.impactLoad       = d.impactLoad;
      const list = document.getElementById('cond-blocks-list');
      if (list) list.innerHTML = S.condBlocks.map(function(x, i) {
        return renderCondBlock(x, i, S.condBlocks.length);
      }).join('');
    }
  }
}

function syncCondBlocksFromDOM() {
  S.condBlocks.forEach(function(b) {
    const modEl        = document.getElementById('cond-mod-'            + b.id);
    const wtEl         = document.getElementById('cond-wt-'             + b.id);
    const durEl        = document.getElementById('cond-dur-'            + b.id);
    const distEl       = document.getElementById('cond-dist-'           + b.id);
    const dunitEl      = document.getElementById('cond-dunit-'          + b.id);
    const loadEl       = document.getElementById('cond-load-'           + b.id);
    const circDescEl   = document.getElementById('cond-circuit-desc-'   + b.id);
    const circRoundsEl = document.getElementById('cond-circuit-rounds-' + b.id);
    const intWorkEl    = document.getElementById('cond-int-work-'       + b.id);
    const intRestEl    = document.getElementById('cond-int-rest-'       + b.id);
    const intRoundsEl  = document.getElementById('cond-int-rounds-'     + b.id);
    const intMaxHREl   = document.getElementById('cond-int-maxhr-'      + b.id);
    if (modEl)        b.modality     = modEl.value;
    if (wtEl)         b.workoutType  = wtEl.value;
    const circDurEl = document.getElementById('cond-circuit-dur-' + b.id);
    const activeDur = (b.modality === 'Circuit Training' ? circDurEl : durEl);
    if (activeDur)    b.duration     = activeDur.value;
    if (!activeDur && durEl) b.duration = durEl.value;
    if (distEl)       b.distance     = distEl.value;
    if (dunitEl)      b.distUnit     = dunitEl.value;
    if (loadEl)       b.load         = loadEl.value;
    if (circDescEl)   b.circuitDesc   = circDescEl.value;
    if (circRoundsEl) b.circuitRounds = circRoundsEl.value;
    syncCondTaxonomyFromDOM(b);
    if (intWorkEl)    b.intWork       = intWorkEl.value;
    if (intRestEl)    b.intRest       = intRestEl.value;
    if (intRoundsEl)  b.intRounds     = intRoundsEl.value;
    if (intMaxHREl)   b.intMaxHR      = intMaxHREl.value;
  });
}

function addCondBlock() {
  syncCondBlocksFromDOM();
  S.condBlockCounter++;
  S.condBlocks.push(Object.assign({ id: S.condBlockCounter, modality: '', workoutType: '', duration: '',
    distance: '', distUnit: 'mi', load: '', circuitDesc: '', circuitRounds: '',
    intWork: '', intRest: '', intRounds: '', intMaxHR: '', taxonomyEdited: false },
    condTaxonomyDefaults('', '', null)));
  const list = document.getElementById('cond-blocks-list');
  if (list) list.innerHTML = S.condBlocks.map(function(b, i) { return renderCondBlock(b, i, S.condBlocks.length); }).join('');
}

function removeCondBlock(id) {
  if (S.condBlocks.length <= 1) return;
  syncCondBlocksFromDOM();
  S.condBlocks = S.condBlocks.filter(function(b) { return b.id !== id; });
  const list = document.getElementById('cond-blocks-list');
  if (list) list.innerHTML = S.condBlocks.map(function(b, i) { return renderCondBlock(b, i, S.condBlocks.length); }).join('');
}

function getCondBlockValues() {
  return S.condBlocks.map(function(b) {
    const mod          = (document.getElementById('cond-mod-'            + b.id) || {value:''}).value.trim();
    const wt           = (document.getElementById('cond-wt-'             + b.id) || {value:''}).value.trim() || b.workoutType || null;
    const isCircuit    = mod === 'Circuit Training';
    const isIntervals  = !isCircuit && wt === 'Intervals';
    const durId        = isCircuit ? 'cond-circuit-dur-' : 'cond-dur-';
    const dur          = parseFloat((document.getElementById(durId + b.id) || {value:''}).value) || null;
    const dv           = parseFloat((document.getElementById('cond-dist-'  + b.id) || {value:''}).value) || null;
    const du           = (document.getElementById('cond-dunit-' + b.id) || {value:'mi'}).value || 'mi';
    const load         = parseFloat((document.getElementById('cond-load-'  + b.id) || {value:''}).value) || null;
    const dm           = dv ? Math.round(dv * (COND_DIST_CONV[du] || 1)) : null;
    const circuitDesc  = isCircuit
      ? ((document.getElementById('cond-circuit-desc-'   + b.id) || {value:''}).value.trim() || null) : null;
    const circuitRounds = isCircuit
      ? (parseInt((document.getElementById('cond-circuit-rounds-' + b.id) || {value:''}).value) || null) : null;
    const intWork      = isIntervals
      ? (parseInt((document.getElementById('cond-int-work-' + b.id) || {value:''}).value) || null) : null;
    const intRest      = isIntervals
      ? (parseInt((document.getElementById('cond-int-rest-' + b.id) || {value:''}).value) || null) : null;
    const intRounds    = isIntervals
      ? (parseInt((document.getElementById('cond-int-rounds-' + b.id) || {value:''}).value) || null) : null;
    const intMaxHR     = isIntervals
      ? (parseInt((document.getElementById('cond-int-maxhr-' + b.id) || {value:''}).value) || null) : null;
    const domEl = document.getElementById('cond-dom-' + b.id);
    const strEl = document.getElementById('cond-str-' + b.id);
    const purEl = document.getElementById('cond-pur-' + b.id);
    return { modality: mod, workoutType: isCircuit ? 'Circuit' : (wt || null), duration: dur,
      distanceMeters: dm, load: load, circuitDesc, circuitRounds, intWork, intRest, intRounds, intMaxHR,
      intensityDomain:  domEl ? domEl.value : b.intensityDomain,
      sessionStructure: strEl ? strEl.value : b.sessionStructure,
      sessionPurpose:   purEl ? purEl.value : b.sessionPurpose,
      impactLoad:       b.impactLoad || COND_IMPACT_BY_MODALITY[mod] || 'Low',
      taxonomyEdited:   !!b.taxonomyEdited };
  }).filter(function(b) { return b.modality; });
}

function getCondSessionValues() {
  return {
    rpe:   parseFloat((document.getElementById('cond-rpe')    || {value:''}).value) || null,
    avgHR: parseInt(  (document.getElementById('cond-avg-hr') || {value:''}).value) || null,
    notes: ((document.getElementById('cond-notes') || {value:''}).value || '').trim() || null,
  };
}

function buildCondRows(csId, sv) {
  return getCondBlockValues().map(function(b) {
    const isCircuit   = b.modality === 'Circuit Training';
    const isIntervals = b.workoutType === 'Intervals';
    // For circuit: merge description into notes
    const notesVal = isCircuit
      ? [b.circuitDesc, sv.notes].filter(Boolean).join(' | ') || null
      : sv.notes;
    return {
      athlete_id:           S.athlete.id,
      completed_session_id: csId,
      conditioning_date:    today(),
      week_of:              (S.cycle && S.cycle.start_date) || today(),
      conditioning_system:  (S.cycle && S.cycle.conditioning_system) || null,
      conditioning_phase:   (S.cycle && S.cycle.conditioning_phase)  || null,
      modality:             b.modality,
      workout_type:         b.workoutType || null,
      is_planned:           !!S.plannedConditioning,
      duration_minutes:     b.duration,
      distance_meters:      isCircuit ? null : b.distanceMeters,
      load_lbs:             isCircuit ? null : b.load,
      intervals_completed:  isCircuit ? b.circuitRounds : (isIntervals ? b.intRounds : null),
      // These columns have existed on completed_conditioning since the schema was
      // written and nothing ever populated them, so a prescribed work:rest ratio
      // could only be contradicted in prose. Populating them is what lets the pull
      // report diff planned vs actual structure and raise the calibration flag.
      work_duration_sec:    isIntervals ? b.intWork : null,
      rest_duration_sec:    isIntervals ? b.intRest : null,
      max_heart_rate:       isIntervals ? b.intMaxHR : null,
      intensity_domain:     b.intensityDomain  || null,
      session_structure:    b.sessionStructure || null,
      session_purpose:      b.sessionPurpose   || null,
      impact_load:          b.impactLoad       || null,
      // Provenance, and it is deliberately not flattering: 'athlete' only when
      // they opened the panel and chose; 'coach' when it came from the
      // prescription untouched; 'backfill' when it is the same mechanical guess
      // from workout_type that the SQL backfill makes. The pull report labels
      // the last of those provisional rather than treating it as observed.
      taxonomy_source:      b.taxonomyEdited ? 'athlete'
                             : (S.plannedConditioning ? 'coach' : 'backfill'),
      rpe:                  sv.rpe,
      avg_heart_rate:       sv.avgHR,
      notes:                notesVal,
    };
  });
}

async function renderConditioningSessionBody() {
  const body = document.getElementById('session-body');
  const pc   = S.plannedConditioning;

  if (S.activeCompletedSession && S.activeCompletedSession.status === 'completed') {
    body.innerHTML = (S.activeSession && S.activeSession.session_notes
      ? '<div class="info-card">📋 ' + S.activeSession.session_notes + '</div>' : '')
      + '<div class="spinner">Loading…</div>';
    try {
      const { data: rows } = await db.from('completed_conditioning')
        .select('*').eq('completed_session_id', S.activeCompletedSession.id)
        .order('created_at');
      const noteHtml = S.activeSession && S.activeSession.session_notes
        ? '<div class="info-card">📋 ' + S.activeSession.session_notes + '</div>' : '';
      let summary = '<div class="cond-logged-summary">'
        + '<div class="cond-logged-header"><span>✓ Conditioning Logged</span>'
        + '<button class="cond-edit-btn" onclick="editConditioningSession()">Edit</button></div>';
      if (rows && rows.length) {
        rows.forEach(function(c) {
          const dist = c.distance_meters
            ? (c.distance_meters / 1609.34).toFixed(2) + ' mi' : null;
          const parts = [
            c.workout_type      ? c.workout_type                : null,
            c.duration_minutes  ? c.duration_minutes + ' min'  : null,
            dist,
            c.load_lbs          ? c.load_lbs + ' lb'           : null,
            c.overall_rpe       ? 'RPE ' + c.overall_rpe       : null,
            c.intervals_completed ? c.intervals_completed + ' rounds' : null,
            c.avg_heart_rate    ? c.avg_heart_rate + ' bpm avg': null,
          ].filter(Boolean).join(' · ');
          summary += '<div class="cond-logged-block">'
            + '<div class="cond-logged-modality">' + (c.modality || 'Unknown') + '</div>'
            + (parts ? '<div class="cond-logged-details">' + parts + '</div>' : '')
            + (c.notes ? '<div class="cond-logged-notes">' + c.notes + '</div>' : '')
            + '</div>';
        });
      } else {
        summary += '<div class="cond-logged-details" style="color:var(--muted)">No details available.</div>';
      }
      summary += '</div>';
      body.innerHTML = noteHtml + summary;
    } catch (_) {
      body.innerHTML = (S.activeSession && S.activeSession.session_notes
        ? '<div class="info-card">📋 ' + S.activeSession.session_notes + '</div>' : '')
        + '<div class="info-card" style="border-color:var(--success);color:var(--success)">✓ This session has been logged.</div>'
        + '<div style="margin-top:10px"><button class="btn secondary" onclick="editConditioningSession()">Edit Log</button></div>';
    }
    return;
  }

  S._editingConditioning = false;
  // Prefill from the planned block so a compliant session is still Log -> done,
  // and so a DEVIATION is a quick edit of a number rather than a sentence in a note.
  S.condBlocks = [{ id: 1,
    modality:      (pc && pc.modality) || '',
    workoutType:   (pc && pc.workout_type) || '',
    duration: '', distance: '', distUnit: 'mi', load: '', circuitDesc: '', circuitRounds: '',
    intWork:       (pc && pc.work_duration_sec != null) ? String(pc.work_duration_sec) : '',
    intRest:       (pc && pc.rest_duration_sec != null) ? String(pc.rest_duration_sec) : '',
    intRounds:     (pc && pc.target_rounds     != null) ? String(pc.target_rounds)     : '',
    intMaxHR: '',
    taxonomyEdited: false,
    ...condTaxonomyDefaults((pc && pc.workout_type) || '', (pc && pc.modality) || '', pc) }];
  S.condBlockCounter = 1;

  const readinessHtml = await resolveInlineReadinessCard();
  let html = readinessHtml;
  if (S.activeSession && S.activeSession.session_notes)
    html += '<div class="info-card">📋 ' + S.activeSession.session_notes + '</div>';
  html += renderCondFormHtml(pc);
  body.innerHTML = html;
}

async function editConditioningSession() {
  if (!S.activeCompletedSession) return;
  const body = document.getElementById('session-body');
  body.innerHTML = '<div class="spinner">Loading…</div>';
  try {
    const { data: rows } = await db.from('completed_conditioning')
      .select('*').eq('completed_session_id', S.activeCompletedSession.id)
      .order('created_at');
    if (rows && rows.length) {
      S.condBlocks = rows.map(function(r, i) {
        const isCircuit   = r.modality === 'Circuit Training';
        const isIntervals = r.workout_type === 'Intervals';
        return {
          id:            i + 1,
          modality:      r.modality || '',
          workoutType:   r.workout_type || '',
          duration:      r.duration_minutes != null ? String(r.duration_minutes) : '',
          distance:      r.distance_meters  != null ? String((r.distance_meters / 1609.34).toFixed(2)) : '',
          distUnit:      'mi',
          load:          r.load_lbs != null ? String(r.load_lbs) : '',
          circuitDesc:   isCircuit ? (r.notes || '') : '',
          circuitRounds: isCircuit && r.intervals_completed != null ? String(r.intervals_completed) : '',
          intWork:       isIntervals && r.work_duration_sec != null ? String(r.work_duration_sec) : '',
          intRest:       isIntervals && r.rest_duration_sec != null ? String(r.rest_duration_sec) : '',
          intRounds:     isIntervals && r.intervals_completed != null ? String(r.intervals_completed) : '',
          intMaxHR:      isIntervals && r.max_heart_rate     != null ? String(r.max_heart_rate) : '',
          intensityDomain:  r.intensity_domain  || '',
          sessionStructure: r.session_structure || '',
          sessionPurpose:   r.session_purpose   || '',
          impactLoad:       r.impact_load       || 'Low',
          taxonomyEdited:   r.taxonomy_source === 'athlete',
        };
      });
      S.condBlockCounter = rows.length;
    } else {
      S.condBlocks = [Object.assign({ id: 1, modality: '', workoutType: '', duration: '', distance: '',
        distUnit: 'mi', load: '', circuitDesc: '', circuitRounds: '',
        intWork: '', intRest: '', intRounds: '', intMaxHR: '', taxonomyEdited: false },
        condTaxonomyDefaults('', '', null))];
      S.condBlockCounter = 1;
    }
    S._editingConditioning = true;
    const noteHtml = S.activeSession && S.activeSession.session_notes
      ? '<div class="info-card">📋 ' + S.activeSession.session_notes + '</div>' : '';
    const editBanner = '<div class="info-card cond-editing-banner">✏️ Editing — save to overwrite previous log.</div>';
    body.innerHTML = noteHtml + editBanner + renderCondFormHtml(S.plannedConditioning);
    // Pre-fill session-level fields from first row
    const first = rows && rows[0];
    if (first) {
      const rpeEl = document.getElementById('cond-rpe');
      const hrEl  = document.getElementById('cond-avg-hr');
      if (rpeEl && first.overall_rpe)    rpeEl.value = first.overall_rpe;
      if (hrEl  && first.avg_heart_rate) hrEl.value  = first.avg_heart_rate;
      // Non-circuit session notes
      const nonCircNotes = (rows || []).filter(function(r) { return r.modality !== 'Circuit Training'; })
        .map(function(r) { return r.notes; }).filter(Boolean)[0];
      const notesEl = document.getElementById('cond-notes');
      if (notesEl && nonCircNotes) notesEl.value = nonCircNotes;
    }
    // Update finish button label
    const btn = document.getElementById('submit-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Update Conditioning'; }
  } catch (err) {
    console.error(err);
    toast('Error loading conditioning data.', 3000);
    renderConditioningSessionBody();
  }
}

function openStandaloneConditioning() {
  S.plannedConditioning = null;
  S.condBlocks = [{ id: 1, modality: '', workoutType: '', duration: '', distance: '', distUnit: 'mi', load: '', circuitDesc: '', circuitRounds: '', intRounds: '', intMaxHR: '' }];
  S.condBlockCounter = 1;
  document.getElementById('cond-sub').textContent = 'Standalone session';
  document.getElementById('cond-body').innerHTML  = renderCondFormHtml(null);
  const btn = document.getElementById('cond-submit-btn');
  btn.disabled = false; btn.textContent = 'Log Conditioning';
  showScreen('conditioning');
}

async function submitConditioningSession() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const sv     = getCondSessionValues();
  const blocks = getCondBlockValues();
  if (!blocks.length) {
    toast('Add at least one modality block.');
    btn.disabled = false; btn.textContent = S._editingConditioning ? 'Update Conditioning' : 'Log Conditioning';
    return;
  }

  // ── Edit/update path ─────────────────────────────────────────────────────
  if (S._editingConditioning && S.activeCompletedSession && !S.activeCompletedSession._isTemp) {
    try {
      const csId = S.activeCompletedSession.id;
      const { error: delErr } = await db.from('completed_conditioning')
        .delete().eq('completed_session_id', csId);
      if (delErr) throw delErr;
      const { error: insErr } = await db.from('completed_conditioning')
        .insert(buildCondRows(csId, sv));
      if (insErr) throw insErr;
      // Also update overall_rpe on completed_session
      await db.from('completed_sessions').update({ overall_rpe: sv.rpe })
        .eq('id', csId);
      S._editingConditioning = false;
      toast('Conditioning updated. ✓', 2500);
      renderConditioningSessionBody();
    } catch (err) {
      console.error(err);
      toast('Error updating. Try again.', 4000);
      btn.disabled = false; btn.textContent = 'Update Conditioning';
    }
    return;
  }

  // ── New log path ─────────────────────────────────────────────────────────
  try {
    if (isOffline) {
      const tid = crypto.randomUUID();
      await idbQueueWrite({ op: 'conditioning_session', payload: {
        session: { athlete_id: S.athlete.id, planned_session_id: S.activeSession.id,
          session_date: today(), week_of: (S.cycle && S.cycle.start_date) || today(),
          session_type: 'Conditioning Only', status: 'completed',
          overall_rpe: sv.rpe, avg_heart_rate: sv.avgHR },
        blocks: blocks, notes: sv.notes,
        isPlanned: !!S.plannedConditioning,
      }});
      S.completed[S.activeSession.id] = { id: tid, status: 'completed', _isTemp: true };
      showSuccess('Conditioning Logged', 'Saved offline — will sync when connected.');
      return;
    }

    // Reuse existing completed_sessions record if available (post-strength or prior partial save)
    let cs = (S.activeCompletedSession && !S.activeCompletedSession._isTemp) ? S.activeCompletedSession : null;
    let createdNewSession = false;
    if (!cs) {
      const { data: csData, error: csErr } = await db.from('completed_sessions').insert({
        athlete_id: S.athlete.id, planned_session_id: S.activeSession.id,
        session_date: today(), week_of: (S.cycle && S.cycle.start_date) || today(),
        session_type: S.activeSession.session_type || 'Conditioning Only', status: 'completed',
        overall_rpe: sv.rpe, avg_heart_rate: sv.avgHR,
      }).select().single();
      if (csErr) throw csErr;
      cs = csData;
      createdNewSession = true;
    } else {
      // Update rpe/hr on existing record
      await db.from('completed_sessions')
        .update({ overall_rpe: sv.rpe, avg_heart_rate: sv.avgHR })
        .eq('id', cs.id);
    }

    const { error: condErr } = await db.from('completed_conditioning').insert(buildCondRows(cs.id, sv));
    if (condErr) {
      // Roll back new session record if we created it (avoid orphan)
      if (createdNewSession) await db.from('completed_sessions').delete().eq('id', cs.id);
      throw condErr;
    }

    S.completed[S.activeSession.id] = cs;
    S.activeCompletedSession        = cs;
    S._conditioningLogged           = true;
    toast('Conditioning logged. ✓', 2000);
    renderConditioningSessionBody();
  } catch (err) {
    console.error(err);
    toast('Error saving. Try again.', 4000);
    btn.disabled = false; btn.textContent = 'Log Conditioning';
  }
}

async function submitConditioning() {
  const btn = document.getElementById('cond-submit-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const sv     = getCondSessionValues();
  const blocks = getCondBlockValues();
  if (!blocks.length) {
    toast('Add at least one modality block.');
    btn.disabled = false; btn.textContent = 'Log Conditioning';
    return;
  }

  try {
    if (isOffline) {
      await idbQueueWrite({ op: 'conditioning_standalone', payload: {
        athlete_id: S.athlete.id, conditioning_date: today(),
        week_of: (S.cycle && S.cycle.start_date) || today(), is_planned: false,
        avg_heart_rate: sv.avgHR, overall_rpe: sv.rpe,
        blocks: blocks, notes: sv.notes,
      }});
      showSuccess('Conditioning Logged', 'Saved offline — will sync when connected.');
      return;
    }

    const { data: cs, error: csErr } = await db.from('completed_sessions').insert({
      athlete_id: S.athlete.id, planned_session_id: null,
      session_date: today(), week_of: (S.cycle && S.cycle.start_date) || today(),
      session_type: 'Conditioning Only', status: 'completed',
      overall_rpe: sv.rpe, avg_heart_rate: sv.avgHR,
    }).select().single();
    if (csErr) throw csErr;

    const { error: condErr } = await db.from('completed_conditioning').insert(buildCondRows(cs.id, sv));
    if (condErr) throw condErr;

    showSuccess('Conditioning Logged', 'Session saved. Good work.');
  } catch (err) {
    console.error(err);
    toast('Error saving conditioning. Try again.', 4000);
    btn.disabled = false; btn.textContent = 'Log Conditioning';
  }
}

function skipConditioning() {
  showSuccess('Done', 'No conditioning logged.');
}


function showSuccess(title, sub) {
  if (typeof releaseWakeLock === 'function') releaseWakeLock();
  document.getElementById('success-title').textContent = title;
  document.getElementById('success-sub').textContent   = sub;
  const recapEl = document.getElementById('success-recap');
  if (recapEl) { recapEl.innerHTML = S._lastRecap || ''; S._lastRecap = null; }
  showScreen('success');
}

