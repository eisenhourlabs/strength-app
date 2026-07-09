// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://mfqtlgtllocxenrekorg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_GtJwb3uRDBuXt-qJOlfqKA_A-QSIOtt';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { detectSessionInUrl: false, flowType: 'implicit' },
});

// Capture email-link auth params synchronously, before anything can clear the URL
// hash. Invite-accept and password-recovery links use Supabase's implicit flow and
// arrive as #access_token=…&refresh_token=…&type=invite|recovery. Parsing intent
// here lets the boot logic route to the set-password screen deterministically,
// rather than depending on which onAuthStateChange event Supabase emits (invite
// fires SIGNED_IN, recovery fires PASSWORD_RECOVERY — they are NOT identical).
const AUTH_LINK = (() => {
  const p = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  return {
    type:          p.get('type'),           // 'invite' | 'recovery' | 'magiclink' | 'signup' | null
    access_token:  p.get('access_token'),
    refresh_token: p.get('refresh_token'),
    error:         p.get('error_description') || p.get('error') || null,
  };
})();

// Reliable connectivity probe — navigator.onLine lies on mobile (especially iOS)
async function checkOnline() {
  if (!navigator.onLine) return false;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 1500);
    await fetch(SUPABASE_URL + '/rest/v1/', {
      method: 'HEAD',
      headers: { apikey: SUPABASE_KEY },
      signal: ctrl.signal,
      cache:  'no-store',
    });
    clearTimeout(tid);
    return true;
  } catch { return false; }
}

// ── State ─────────────────────────────────────────────────────────────────────
let S = {
  user:         null,
  athlete:      null,
  cycle:        null,
  sessions:     [],
  completed:    {},   // planned_session_id → completed_session record

  // Active session
  activeSession:          null,
  plannedExercises:       [],
  plannedConditioning:    null,
  activeCompletedSession: null,  // CS record (created lazily on first save)

  // savedExercises: peId (string) → array of set objects from DB
  //                 or localId (number) → array of set objects for added exercises
  savedExercises: {},

  // Per-exercise UI state (keyed by planned_exercise_id)
  exState: {},  // { skipped: bool, swappedTo: {id,name}|null, setCount: int }

  // Added exercises: [{localId, exId, exName, setCount}]
  addedExercises: [],
  addedCounter:   0,

  condBlocks:       [],
  condBlockCounter: 0,

  exerciseLib: [],
  sheetMode:   null,
  swapExKey:   null,

  // Set completion + timers
  checkedSets:      {},   // { exerciseKey → { idx → bool } }
  restTimers:       {},   // { exerciseKey → { remaining, targetSeconds, intervalId } }
  sessionStartTime: null,

  // Weekly check-in (most recent submission for the upcoming week)
  checkin: null,
};

function today() { return new Date().toISOString().split('T')[0]; }

// ── Pattern filter state ──────────────────────────────────────────────────────
let isOffline = !navigator.onLine;


// ── Screen navigation ─────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ── Styled confirm dialog (replaces native confirm()) ─────────────────────────
function showConfirm(title, sub, yesLabel, onYes, yesDanger) {
  const overlay = document.createElement('div');
  overlay.className = 'pain-prompt-overlay';
  overlay.innerHTML = `
    <div class="pain-prompt-box">
      <div class="pain-prompt-title">${title}</div>
      <div class="pain-prompt-sub">${sub}</div>
      <div class="pain-prompt-btns">
        <button class="pain-prompt-yes${yesDanger ? ' danger' : ''}" id="cfYes">${yesLabel || 'Confirm'}</button>
        <button class="pain-prompt-no" id="cfNo">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('cfYes').onclick = () => { overlay.remove(); onYes(); };
  document.getElementById('cfNo').onclick  = () => overlay.remove();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  const btn   = document.getElementById('login-btn');
  const err   = document.getElementById('login-error');
  err.textContent = '';
  btn.textContent = 'Signing in…';
  btn.disabled = true;
  const { data, error } = await db.auth.signInWithPassword({ email, password: pass });
  if (error) {
    err.textContent = error.message;
    btn.textContent = 'Log In';
    btn.disabled = false;
    return;
  }
  await onLogin(data.user);
}

async function onLogin(user) {
  S.user = user;

  // Try network; use checkOnline() as ground truth (navigator.onLine lies on iOS)
  try {
    if (isOffline || !(await checkOnline())) throw new Error('offline');
    const { data: athlete, error: aErr } = await db.from('athletes')
      .select('id,name,email,available_days').eq('email', user.email).single();
    if (aErr) throw aErr;
    if (!athlete) { toast('Athlete record not found. Contact your coach.'); doLogout(); return; }
    S.athlete = athlete;

    const { data: lib } = await db.from('exercise_library')
      .select('id,name,movement_pattern,exercise_type,equipment,skill_level').order('name');
    S.exerciseLib = lib || [];

    try { await idbSet('athleteCache', { email: user.email, athlete, exerciseLib: S.exerciseLib }); } catch {}

    await loadProgram();
  } catch (_) {
    // Network unavailable — fall back to cached athlete data
    isOffline = true;
    updateOfflineBanner();
    const cached = await idbGet('athleteCache');
    if (cached && cached.email === user.email) {
      S.athlete     = cached.athlete;
      S.exerciseLib = cached.exerciseLib || [];
      toast('Offline — loading from cache…', 2000);
      await loadProgram();
    } else {
      // Reset login button so user can retry
      const loginBtn = document.getElementById('login-btn');
      if (loginBtn) { loginBtn.textContent = 'Log In'; loginBtn.disabled = false; }
      toast('Connection error — check your network and try again.', 5000);
    }
  }
}

async function doLogout() {
  await db.auth.signOut();
  S = { user:null, athlete:null, cycle:null, sessions:[], completed:{},
    activeSession:null, plannedExercises:[], plannedConditioning:null,
    activeCompletedSession:null, savedExercises:{},
    exState:{}, addedExercises:[], addedCounter:0, condBlocks:[], condBlockCounter:0,
    exerciseLib:[], sheetMode:null, swapExKey:null, painFlags:{}, checkin:null };
  showScreen('login');
}

// ── Password setup / reset (invite accept + forgot password) ──────────────────
// Email links use Supabase's implicit flow: tokens arrive in the URL hash and were
// captured into AUTH_LINK at load. We establish a session from those tokens, then
// let the user set a password via updateUser() (which requires an active session).
// This one screen serves BOTH the invite-accept flow and the forgot-password flow;
// only the on-screen wording differs.
async function enterPasswordSetup(mode) {
  if (AUTH_LINK.access_token && AUTH_LINK.refresh_token) {
    try {
      await db.auth.setSession({
        access_token:  AUTH_LINK.access_token,
        refresh_token: AUTH_LINK.refresh_token,
      });
    } catch (_) {}
  }
  // Strip the tokens out of the address bar so they aren't left in browser history.
  try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) {}

  const h = document.getElementById('setpw-heading');
  const s = document.getElementById('setpw-sub');
  if (h) h.textContent = mode === 'invite' ? 'Welcome — set your password' : 'Set a new password';
  if (s) s.textContent = mode === 'invite'
    ? 'Create a password to finish setting up your account.'
    : 'Choose a new password to get back into your account.';
  const errEl = document.getElementById('setpw-error');
  if (errEl) errEl.textContent = '';
  showScreen('setpw');
}

async function submitNewPassword() {
  const p1  = document.getElementById('setpw-password').value;
  const p2  = document.getElementById('setpw-password2').value;
  const btn = document.getElementById('setpw-btn');
  const err = document.getElementById('setpw-error');
  err.textContent = '';
  if (p1.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
  if (p1 !== p2)     { err.textContent = 'Passwords do not match.'; return; }

  btn.textContent = 'Saving…';
  btn.disabled = true;

  // updateUser needs an active session — established above in enterPasswordSetup.
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    err.textContent = 'This link has expired. Go back to the login screen and tap Forgot password to get a new one.';
    btn.textContent = 'Save Password';
    btn.disabled = false;
    return;
  }

  const { data, error } = await db.auth.updateUser({ password: p1 });
  if (error) {
    err.textContent = error.message;
    btn.textContent = 'Save Password';
    btn.disabled = false;
    return;
  }

  toast('Password saved ✓');
  await onLogin(data.user);
}

async function sendPasswordReset() {
  const email = document.getElementById('login-email').value.trim();
  const err   = document.getElementById('login-error');
  err.textContent = '';
  if (!email) {
    err.textContent = 'Enter your email above first, then tap Forgot password.';
    return;
  }
  const link = document.getElementById('forgot-link');
  const prev = link ? link.textContent : '';
  if (link) link.textContent = 'Sending…';
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (link) link.textContent = prev;
  if (error) { err.textContent = error.message; return; }
  toast('Check your email for a password reset link.', 4000);
}


// ── Test exercise selection state (shared between exercises.js and tests.js) ──
let testSelectedExId   = null;
let testSelectedExName = null;

// ── IndexedDB module ──────────────────────────────────────────────────────────
const IDB_NAME = 'strength-app-v1';
const IDB_VER  = 1;

function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('kv'))
        d.createObjectStore('kv', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('write_queue'))
        d.createObjectStore('write_queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function idbSet(key, value) {
  const d = await idbOpen();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    const req = tx.objectStore('kv').put({ k: key, v: value });
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}
async function idbGet(key) {
  const d = await idbOpen();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = e => res(e.target.result?.v);
    req.onerror   = e => rej(e.target.error);
  });
}
async function idbQueueWrite(item) {
  const d = await idbOpen();
  return new Promise((res, rej) => {
    const tx = d.transaction('write_queue', 'readwrite');
    const req = tx.objectStore('write_queue').add({ ...item, createdAt: Date.now() });
    req.onsuccess = () => { res(); try { updateOfflineBanner(); } catch (_) {} };
    req.onerror   = e => rej(e.target.error);
  });
}
async function idbGetAllQueue() {
  const d = await idbOpen();
  return new Promise((res, rej) => {
    const tx = d.transaction('write_queue', 'readonly');
    const req = tx.objectStore('write_queue').getAll();
    req.onsuccess = e => res(e.target.result || []);
    req.onerror   = e => rej(e.target.error);
  });
}
async function idbDeleteQueueItem(id) {
  const d = await idbOpen();
  return new Promise((res, rej) => {
    const tx = d.transaction('write_queue', 'readwrite');
    const req = tx.objectStore('write_queue').delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Offline banner ────────────────────────────────────────────────────────────
function updateOfflineBanner() {
  const el = document.getElementById('offline-banner');
  if (!el) return;
  el.style.display = isOffline ? 'block' : 'none';
  if (isOffline) {
    idbGetAllQueue().then(items => {
      if (!isOffline || !el) return;
      el.textContent = items.length
        ? `⚡ Offline — ${items.length} item${items.length !== 1 ? 's' : ''} saved locally, will sync when connected`
        : '⚡ Offline — data will sync when connected';
    }).catch(() => {});
  }
}

window.addEventListener('offline', () => {
  isOffline = true;
  updateOfflineBanner();
});

window.addEventListener('online', async () => {
  isOffline = false;
  updateOfflineBanner();
  // Refresh auth token before syncing — it may have expired while offline
  await db.auth.getSession();
  await syncQueue();
});

// ── Sync engine ───────────────────────────────────────────────────────────────
function resolveIds(payload, idMap) {
  if (Array.isArray(payload)) return payload.map(i => resolveIds(i, idMap));
  if (payload && typeof payload === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(payload))
      out[k] = (k === 'completed_session_id' && idMap[v]) ? idMap[v] : v;
    return out;
  }
  return payload;
}

async function syncQueue() {
  const items = await idbGetAllQueue();
  if (!items.length) return;
  toast(`Syncing ${items.length} item${items.length !== 1 ? 's' : ''}…`, 1500);

  const idMap = {};
  let synced = 0, failed = 0, lastSyncErr = '';

  for (const item of items) {
    try {
      const p = resolveIds(item.payload, idMap);
      switch (item.op) {
        case 'create_session': {
          const { data: cs, error } = await db.from('completed_sessions').insert(p).select().single();
          if (error) throw error;
          idMap[item.tempSessionId] = cs.id;
          break;
        }
        case 'insert_sets': {
          // If syncing real added-exercise rows, delete any set_number=0 placeholder first
          const realAddedRows = Array.isArray(p)
            ? p.filter(r => r.is_added && (r.set_number || 0) > 0) : [];
          for (const r of realAddedRows) {
            await db.from('completed_strength_sets').delete()
              .eq('completed_session_id', r.completed_session_id)
              .eq('exercise_id', r.exercise_id).eq('is_added', true).eq('set_number', 0);
          }
          const { error: e2 } = await db.from('completed_strength_sets').insert(p);
          if (e2) throw e2;
          break;
        }
        case 'finish_session_update': {
          const realId = idMap[item.tempSessionId] || item.sessionId;
          if (realId) {
            const { error: e3 } = await db.from('completed_sessions').update(p).eq('id', realId);
            if (e3) throw e3;
          }
          break;
        }
        case 'finish_session_insert': {
          const { error: e4 } = await db.from('completed_sessions').insert(p);
          if (e4) throw e4;
          break;
        }
        case 'conditioning_session': {
          const { data: cs2, error: cse } = await db.from('completed_sessions').insert(p.session).select().single();
          if (cse) throw cse;
          const condRows2 = (p.blocks || []).filter(b => b.modality).map(b => {
            const isCircuit2   = b.modality === 'Circuit Training';
            const isIntervals2 = !isCircuit2 && b.workoutType === 'Intervals';
            const notesVal2    = isCircuit2 ? [b.circuitDesc, p.notes].filter(Boolean).join(' | ') || null : p.notes || null;
            return {
              athlete_id:           p.session.athlete_id,
              completed_session_id: cs2.id,
              conditioning_date:    p.session.session_date,
              week_of:              p.session.week_of,
              conditioning_system:  p.session.conditioning_system || null,
              conditioning_phase:   p.session.conditioning_phase  || null,
              modality:             b.modality,
              workout_type:         isCircuit2 ? 'Circuit' : (b.workoutType || null),
              is_planned:           !!p.isPlanned,
              duration_minutes:     b.duration       || null,
              distance_meters:      isCircuit2 ? null : (b.distanceMeters || null),
              load_lbs:             isCircuit2 ? null : (b.load || null),
              intervals_completed:  isCircuit2 ? (b.circuitRounds || null) : (isIntervals2 ? (b.intRounds || null) : null),
              max_heart_rate:       isIntervals2 ? (b.intMaxHR || null) : null,
              avg_heart_rate:       p.session.avg_heart_rate || null,
              rpe:                  p.session.overall_rpe    || null,
              notes:                notesVal2,
            };
          });
          if (condRows2.length) { const { error: cce } = await db.from('completed_conditioning').insert(condRows2); if (cce) throw cce; }
          break;
        }
        case 'conditioning_standalone': {
          const { data: cs3, error: cse3 } = await db.from('completed_sessions').insert({
            athlete_id: p.athlete_id, planned_session_id: null,
            session_date: p.conditioning_date, week_of: p.week_of,
            session_type: 'Conditioning Only', status: 'completed',
            overall_rpe: p.overall_rpe || null,
            avg_heart_rate: p.avg_heart_rate || null,
          }).select().single();
          if (cse3) throw cse3;
          const condRows3 = (p.blocks || []).filter(b => b.modality).map(b => {
            const isCircuit3   = b.modality === 'Circuit Training';
            const isIntervals3 = !isCircuit3 && b.workoutType === 'Intervals';
            const notesVal3    = isCircuit3 ? [b.circuitDesc, p.notes].filter(Boolean).join(' | ') || null : p.notes || null;
            return {
              athlete_id:           p.athlete_id,
              completed_session_id: cs3.id,
              conditioning_date:    p.conditioning_date,
              week_of:              p.week_of,
              modality:             b.modality,
              workout_type:         isCircuit3 ? 'Circuit' : (b.workoutType || null),
              is_planned:           false,
              duration_minutes:     b.duration       || null,
              distance_meters:      isCircuit3 ? null : (b.distanceMeters || null),
              load_lbs:             isCircuit3 ? null : (b.load || null),
              intervals_completed:  isCircuit3 ? (b.circuitRounds || null) : (isIntervals3 ? (b.intRounds || null) : null),
              max_heart_rate:       isIntervals3 ? (b.intMaxHR || null) : null,
              avg_heart_rate:       p.avg_heart_rate || null,
              rpe:                  p.overall_rpe    || null,
              notes:                notesVal3,
            };
          });
          if (condRows3.length) { const { error: e5 } = await db.from('completed_conditioning').insert(condRows3); if (e5) throw e5; }
          break;
        }
        case 'readiness': {
          const { error: e6 } = await db.from('readiness_logs').insert(p);
          if (e6) throw e6;
          break;
        }
        case 'pain': {
          const { error: e7 } = await db.from('pain_injury_logs').insert(p);
          if (e7) throw e7;
          break;
        }
        case 'test': {
          const { error: e8 } = await db.from('strength_tests').insert(p);
          if (e8) throw e8;
          break;
        }
      }
      await idbDeleteQueueItem(item.id);
      synced++;
    } catch (err) {
      console.error('Sync failed:', item.op, err);
      console.error('Sync error detail:', JSON.stringify(err));
      failed++;
      lastSyncErr = err?.message || err?.code || 'unknown';
    }
  }

  if (synced > 0) {
    toast(`Synced ${synced} item${synced > 1 ? 's' : ''} ✓`);
    await loadProgram();
  }
  if (failed > 0) {
    toast(`${failed} item${failed > 1 ? 's' : ''} failed to sync — ${lastSyncErr}`, 5000);
  }
}


