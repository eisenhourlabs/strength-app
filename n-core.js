// ══════════════ Kardia Nutrition — core (loads first) ══════════════
// Foundation: Supabase client, state, auth, data loading, day math.
// Deliberately self-contained — shares NOTHING with the strength app's JS.

const N_SUPABASE_URL = 'https://mfqtlgtllocxenrekorg.supabase.co';
const N_SUPABASE_KEY = 'sb_publishable_GtJwb3uRDBuXt-qJOlfqKA_A-QSIOtt';
const ndb = window.supabase.createClient(N_SUPABASE_URL, N_SUPABASE_KEY, {
  auth: { detectSessionInUrl: false, flowType: 'implicit' },
});

let nOffline = !navigator.onLine;

// ── State ──
let NS = {
  user: null,
  me: null,            // my athletes row
  household: [],       // all athletes rows in my household (incl. me)
  weekOf: null,        // Monday of current week (YYYY-MM-DD)
  target: null,        // my nutrition_targets row for this week
  planWeek: null,      // meal_plan_weeks row
  meals: [],           // planned_meals, whole household, whole week
  alternates: {},      // planned_meal_id -> [alternate rows]
  logs: {},            // planned_meal_id -> my meal_log row
  addedLogs: [],       // my meal_logs with no planned_meal_id, this week
  settings: null,      // my nutrition_settings
  recipes: [],         // active recipes
  foods: [],           // active food_items
  grocery: { list: null, items: [] },
  freezerPulls: [],   // household-shared thaw nudges (n-freezer.js)
  metricsToday: {},    // metric -> value logged today (me)
  lastMetricDates: {}, // metric -> last log date (me)
  dismissed: {},       // prompt-card session dismissals
  sheet: null,         // picker sheet context {mode, meal}
  selDay: null,        // week screen selected day
};

// ── Date helpers — LOCAL time throughout (toISOString is UTC and rolls the
//    date forward in the evening for US timezones; see 2026-07-10 bug) ──
function nYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nToday() { return nYMD(new Date()); }
function nMonday(dstr) {
  const d = new Date(dstr + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return nYMD(d);
}
function nAddDays(dstr, n) {
  const d = new Date(dstr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return nYMD(d);
}
function nDayName(dstr, short) {
  const d = new Date(dstr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: short ? 'short' : 'long' });
}
function nFmtDate(dstr) {
  const d = new Date(dstr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

// ── UI helpers ──
function nShowScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  document.getElementById('n-tabbar').style.display = name === 'login' ? 'none' : 'flex';
}
function nShowTab(name) {
  nShowScreen(name);
  document.querySelectorAll('.n-tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById(`tab-${name}`);
  if (tab) tab.classList.add('active');
  if (name === 'today') renderToday();
  if (name === 'nweek') renderNWeek();
  if (name === 'grocery') renderGrocery();
  if (name === 'ntrends') renderNTrends();
}
function toast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}
function nEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nRound(x) { return x == null ? null : Math.round(x); }

// ── Auth ──
async function nDoLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  const btn   = document.getElementById('login-btn');
  const err   = document.getElementById('login-error');
  err.textContent = '';
  btn.textContent = 'Signing in…'; btn.disabled = true;
  const { data, error } = await ndb.auth.signInWithPassword({ email, password: pass });
  if (error) {
    err.textContent = error.message;
    btn.textContent = 'Log In'; btn.disabled = false;
    return;
  }
  await nInit(data.user);
}

async function nDoLogout() {
  await ndb.auth.signOut();
  window.location.reload();
}

// ── Boot / init ──
async function nInit(user) {
  NS.user = user;
  try {
    const { data: me, error } = await ndb.from('athletes')
      .select('id,name,email,household_id,training_active,nutrition_active')
      .eq('email', user.email).single();
    if (error || !me) throw (error || new Error('no athlete'));
    if (!me.nutrition_active) {
      toast('Nutrition is not enabled for this account.', 4000);
      window.location.href = 'index.html';
      return;
    }
    NS.me = me;
    const tl = document.getElementById('training-link');
    if (tl) tl.style.display = me.training_active ? 'inline-block' : 'none';

    if (me.household_id) {
      const { data: hh } = await ndb.from('athletes')
        .select('id,name').eq('household_id', me.household_id);
      NS.household = hh || [me];
    } else NS.household = [me];

    // Use the household's active plan week if one exists (plans are pushed
    // for upcoming weeks); fall back to the calendar week.
    NS.weekOf = nMonday(nToday());
    try {
      const { data: aw } = await ndb.from('meal_plan_weeks').select('week_of')
        .eq('status', 'active').order('week_of');
      if (aw && aw.length) {
        const t = nToday();
        const containing = aw.find(w => t >= w.week_of && t <= nAddDays(w.week_of, 6));
        const upcoming   = aw.find(w => w.week_of > t);
        NS.weekOf = (containing || upcoming || aw[aw.length - 1]).week_of;
      }
    } catch (_) {}
    await nLoadAll();
    nShowTab('today');
  } catch (e) {
    console.error('nInit failed', e);
    const btn = document.getElementById('login-btn');
    if (btn) { btn.textContent = 'Log In'; btn.disabled = false; }
    toast('Could not load your profile — check connection and retry.', 4000);
    nShowScreen('login');
  }
}

// ── Data loading ──
async function nLoadAll() {
  const wk = NS.weekOf, end = nAddDays(wk, 6), meId = NS.me.id;

  const [targetQ, weekQ, mealsQ, settingsQ, recipesQ, foodsQ] = await Promise.all([
    ndb.from('nutrition_targets').select('*').eq('athlete_id', meId).eq('week_of', wk).maybeSingle(),
    ndb.from('meal_plan_weeks').select('*').eq('week_of', wk).maybeSingle(),
    ndb.from('planned_meals').select('*').gte('meal_date', wk).lte('meal_date', end)
      .order('meal_date').order('slot_order'),
    ndb.from('nutrition_settings').select('*').eq('athlete_id', meId).maybeSingle(),
    ndb.from('recipes').select('id,name,kcal_per_serving,protein_g_per_serving,carbs_g_per_serving,fat_g_per_serving,best_meal_slots,tags,portion_notes')
      .eq('is_active', true).order('name'),
    ndb.from('food_items').select('id,name,item_type,restaurant_name,serving_desc,kcal,protein_g,carbs_g,fat_g,default_meal_slots,tags,approval_status')
      .eq('is_active', true).order('name'),
  ]);
  NS.target   = targetQ.data || null;
  NS.planWeek = weekQ.data || null;
  NS.meals    = mealsQ.data || [];
  NS.settings = settingsQ.data || null;
  NS.recipes  = recipesQ.data || [];
  NS.foods    = foodsQ.data || [];

  // Alternates for this week's meals
  const ids = NS.meals.map(m => m.id);
  NS.alternates = {};
  if (ids.length) {
    const { data: alts } = await ndb.from('planned_meal_alternates').select('*').in('planned_meal_id', ids);
    for (const a of (alts || [])) (NS.alternates[a.planned_meal_id] ||= []).push(a);
  }

  // My logs this week (planned-linked and added)
  const { data: logs } = await ndb.from('meal_logs').select('*')
    .eq('athlete_id', meId).gte('log_date', wk).lte('log_date', end);
  NS.logs = {}; NS.addedLogs = [];
  for (const l of (logs || [])) {
    if (l.planned_meal_id) NS.logs[l.planned_meal_id] = l;
    else NS.addedLogs.push(l);
  }

  // Recipe components (per-ingredient Tweak feature) — tolerate missing table
  NS.components = {};
  try {
    const { data: comps } = await ndb.from('recipe_components').select('recipe_id,food_item_id,qty');
    for (const c of (comps || [])) (NS.components[c.recipe_id] ||= []).push(c);
  } catch (_) {}

  // My check-in for this plan week (drives the Sunday prompt card)
  const { data: ci } = await ndb.from('nutrition_checkins').select('*')
    .eq('athlete_id', meId).eq('week_of', wk).maybeSingle();
  NS.checkin = ci || null;

  // Grocery
  NS.grocery = { list: null, items: [] };
  // Grocery always shows the LATEST list — you shop for the upcoming week
  const { data: gls } = await ndb.from('grocery_lists').select('*')
    .eq('status', 'active').order('week_of', { ascending: false }).limit(1);
  const gl = gls && gls.length ? gls[0] : null;
  if (gl) {
    NS.grocery.list = gl;
    const { data: gi } = await ndb.from('grocery_items').select('*')
      .eq('list_id', gl.id).order('category').order('sort_order');
    NS.grocery.items = gi || [];
  }

  // Freezer pulls: household-shared thaw nudges. Tolerate a missing table so the
  // app still runs before the 2026-07-11_freezer_pulls migration is applied.
  NS.freezerPulls = [];
  try {
    const { data: fps } = await ndb.from('freezer_pulls').select('*')
      .eq('household_id', NS.me.household_id).eq('is_checked', false).order('prep_date');
    NS.freezerPulls = fps || [];
  } catch (_) {}

  // Body metrics: today's entries + last date per metric (for prompts)
  NS.metricsToday = {}; NS.lastMetricDates = {};
  const { data: bmToday } = await ndb.from('body_metrics').select('metric,value,notes')
    .eq('athlete_id', meId).eq('log_date', nToday());
  NS.metricsTodayNotes = {};
  for (const r of (bmToday || [])) {
    NS.metricsToday[r.metric] = r.value;
    NS.metricsTodayNotes[r.metric] = r.notes;
  }

  // Today's sleep (canonical: readiness_logs.sleep_hours). Troy writes it via the
  // strength readiness form; nutrition-only users write it in the Activity panel.
  NS.sleepToday = null;
  const { data: slpRows } = await ndb.from('readiness_logs').select('sleep_hours')
    .eq('athlete_id', meId).eq('log_date', nToday()).limit(1);
  if (slpRows && slpRows.length && slpRows[0].sleep_hours != null) NS.sleepToday = slpRows[0].sleep_hours;
  const { data: lastW } = await ndb.from('body_metrics').select('value')
    .eq('athlete_id', meId).eq('metric', 'weight')
    .order('log_date', { ascending: false }).limit(1);
  NS.lastWeight = lastW && lastW.length ? parseFloat(lastW[0].value) : null;
  const watch = ['weight', ...(NS.settings?.measurement_metrics || [])];
  for (const metric of watch) {
    const { data: last } = await ndb.from('body_metrics').select('log_date')
      .eq('athlete_id', meId).eq('metric', metric)
      .order('log_date', { ascending: false }).limit(1);
    if (last && last.length) NS.lastMetricDates[metric] = last[0].log_date;
  }
}

// ── Meal helpers ──
const N_SLOT_ORDER = { breakfast: 0, lunch: 20, dinner: 40 };
function nMealSortKey(m) {
  if (m.meal_slot === 'snack') return [10, 30, 50][(m.slot_order || 1) - 1] ?? 50;
  return N_SLOT_ORDER[m.meal_slot] ?? 60;
}
function nMyMeals(dateStr) {
  return NS.meals.filter(m => m.athlete_id === NS.me.id && m.meal_date === dateStr)
    .sort((a, b) => nMealSortKey(a) - nMealSortKey(b));
}
function nMealName(m) {
  if (m.custom_name) return m.custom_name;
  if (m.recipe_id) return NS.recipes.find(r => r.id === m.recipe_id)?.name || 'Recipe';
  if (m.food_item_id) return NS.foods.find(f => f.id === m.food_item_id)?.name || 'Food';
  return 'Meal';
}
function nSharedPartner(m) {
  if (!m.shared_group_id) return null;
  const other = NS.meals.find(x => x.shared_group_id === m.shared_group_id && x.athlete_id !== m.athlete_id);
  if (!other) return null;
  const who = NS.household.find(a => a.id === other.athlete_id);
  return { name: who?.name || 'Partner', servings: other.planned_servings };
}
function nLogName(l) {
  if (l.custom_desc) return l.custom_desc;
  if (l.swap_recipe_id) return NS.recipes.find(r => r.id === l.swap_recipe_id)?.name || 'Recipe';
  if (l.swap_food_item_id) return NS.foods.find(f => f.id === l.swap_food_item_id)?.name || 'Food';
  return null;
}

// ── Day math (the self-correction feature) ──
function nDayTotals(dateStr) {
  let kcal = 0, protein = 0, approx = false;
  const seen = new Set();
  for (const m of nMyMeals(dateStr)) {
    const l = NS.logs[m.id];
    if (!l) continue;
    seen.add(l.id);
    if (l.actual_kcal == null && l.status !== 'skipped') { approx = true; continue; }
    kcal += l.actual_kcal || 0;
    protein += l.actual_protein_g || 0;
  }
  for (const l of NS.addedLogs) {
    if (l.log_date !== dateStr || seen.has(l.id)) continue;
    if (l.actual_kcal == null) { approx = true; continue; }
    kcal += l.actual_kcal || 0;
    protein += l.actual_protein_g || 0;
  }
  return { kcal: Math.round(kcal), protein: Math.round(protein), approx };
}

// ── Log writes ──
async function nWriteLog(row, existingId) {
  if (nOffline) { toast('Offline — reconnect to log.', 3000); throw new Error('offline'); }
  if (existingId) {
    const { data, error } = await ndb.from('meal_logs').update(row).eq('id', existingId).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await ndb.from('meal_logs').insert(row).select().single();
  if (error) throw error;
  return data;
}

// Log a planned meal with a status. src: null=planned meal itself, or
// {recipe_id|food_item_id, kcal, protein_g, carbs_g, fat_g, desc} for swaps/ate-out.
async function nLogMeal(meal, status, src, modifier) {
  const mod = modifier ?? 1.0;
  let row = {
    athlete_id: NS.me.id,
    planned_meal_id: meal.id,
    log_date: meal.meal_date,
    meal_slot: meal.meal_slot,
    status,
    portion_modifier: mod,
    swap_recipe_id: src?.recipe_id || null,
    swap_food_item_id: src?.food_item_id || null,
    custom_desc: src?.desc || null,
  };
  if (status === 'skipped') {
    row.actual_kcal = 0; row.actual_protein_g = 0; row.actual_carbs_g = 0; row.actual_fat_g = 0;
  } else if (status === 'as_planned') {
    row.actual_kcal = nRound(meal.planned_kcal * mod);
    row.actual_protein_g = nRound(meal.planned_protein_g * mod);
    row.actual_carbs_g = nRound(meal.planned_carbs_g * mod);
    row.actual_fat_g = nRound(meal.planned_fat_g * mod);
  } else if (src && src.kcal != null) {
    row.actual_kcal = nRound(src.kcal * mod);
    row.actual_protein_g = nRound((src.protein_g || 0) * mod);
    row.actual_carbs_g = nRound((src.carbs_g || 0) * mod);
    row.actual_fat_g = nRound((src.fat_g || 0) * mod);
  } else {
    row.actual_kcal = null; row.actual_protein_g = null;
    row.actual_carbs_g = null; row.actual_fat_g = null;
  }
  const existing = NS.logs[meal.id];
  const saved = await nWriteLog(row, existing?.id);
  NS.logs[meal.id] = saved;
  return saved;
}

// Re-apply a portion modifier to an existing log (rescale from its per-1.0 source)
async function nSetPortion(meal, modifier) {
  const l = NS.logs[meal.id];
  if (!l) return;
  const prev = l.portion_modifier || 1.0;
  const scale = (v) => v == null ? null : nRound((v / prev) * modifier);
  const row = {
    portion_modifier: modifier,
    actual_kcal: scale(l.actual_kcal),
    actual_protein_g: scale(l.actual_protein_g),
    actual_carbs_g: scale(l.actual_carbs_g),
    actual_fat_g: scale(l.actual_fat_g),
  };
  const saved = await nWriteLog(row, l.id);
  NS.logs[meal.id] = saved;
}

// Ad-hoc added food (no planned meal)
async function nLogAdded(dateStr, src) {
  const row = {
    athlete_id: NS.me.id,
    planned_meal_id: null,
    log_date: dateStr,
    meal_slot: 'snack',
    status: 'added',
    portion_modifier: 1.0,
    swap_recipe_id: src.recipe_id || null,
    swap_food_item_id: src.food_item_id || null,
    custom_desc: src.desc || null,
    actual_kcal: src.kcal != null ? nRound(src.kcal) : null,
    actual_protein_g: src.protein_g != null ? nRound(src.protein_g) : null,
    actual_carbs_g: src.carbs_g != null ? nRound(src.carbs_g) : null,
    actual_fat_g: src.fat_g != null ? nRound(src.fat_g) : null,
  };
  const saved = await nWriteLog(row, null);
  NS.addedLogs.push(saved);
  return saved;
}

// ── Body metrics ──
async function nSaveMetric(metric, value, unit) {
  if (nOffline) { toast('Offline — reconnect to log.', 3000); return false; }
  const { error } = await ndb.from('body_metrics').upsert({
    athlete_id: NS.me.id, log_date: nToday(), metric, value, unit,
  }, { onConflict: 'athlete_id,log_date,metric' });
  if (error) { toast('Save failed: ' + error.message, 4000); return false; }
  NS.metricsToday[metric] = value;
  NS.lastMetricDates[metric] = nToday();
  return true;
}

// ── Offline banner ──
function nUpdateOffline() {
  const el = document.getElementById('offline-banner');
  if (el) el.style.display = nOffline ? 'block' : 'none';
}
window.addEventListener('offline', () => { nOffline = true; nUpdateOffline(); });
window.addEventListener('online',  () => { nOffline = false; nUpdateOffline(); });
