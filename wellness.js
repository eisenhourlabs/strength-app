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

// ── Pain sheet ────────────────────────────────────────────────────────────────────────────
function openPainSheet() {
  document.getElementById('pain-overlay').classList.add('open');
  document.getElementById('pain-sheet').classList.add('open');
}

function closePainSheet() {
  document.getElementById('pain-overlay').classList.remove('open');
  document.getElementById('pain-sheet').classList.remove('open');
}

async function submitPain() {
  const region   = document.getElementById('pain-region').value;
  const score    = parseInt(document.getElementById('pain-score').value)  || null;
  const status   = document.getElementById('pain-status').value;
  const modified = document.getElementById('pain-modified').value === 'true';
  const trigger  = document.getElementById('pain-trigger').value.trim()   || null;
  const notes    = document.getElementById('pain-notes').value.trim()     || null;

  if (!region) { toast('Please select a body region.'); return; }

  if (isOffline) {
    await idbQueueWrite({ op: 'pain', payload: {
      athlete_id: S.athlete.id, log_date: today(),
      body_region: region, pain_score: score, status, modified_training: modified,
      trigger, notes,
    }});
    toast('Pain log saved offline ✓');
    closePainSheet();
    return;
  }
  try {
    await db.from('pain_injury_logs').insert({
      athlete_id:       S.athlete.id,
      log_date:         today(),
      body_region:      region,
      pain_score:       score,
      status:           status,
      modified_training:modified,
      trigger:          trigger,
      notes:            notes,
    });
    toast('Pain log saved ✓');
    closePainSheet();
  } catch (err) {
    console.error(err);
    toast('Error saving pain log. Try again.', 4000);
  }
}

