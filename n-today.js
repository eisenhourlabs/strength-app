// ══════════════ Kardia Nutrition — Today screen + logging + meal builder ══════════════

const N_STATUS_LABEL = {
  as_planned: '✓ ate as planned', swapped: '⇄ swapped', skipped: 'skipped',
  ate_out: '🍴 ate out', added: '+ added',
};
const N_STATUS_ICON = { as_planned: '✓', swapped: '⇄', skipped: '✕', ate_out: '🍴', added: '+' };
const N_PORTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const N_PENDING = {};   // pre-log portion selection, keyed by planned-meal id
let N_OPEN = {};   // expanded logged-card ids (session only)
const N_ADJ = {};          // meal ids with the inline Adjust panel open
const N_ADJ_BASKET = {};   // meal id -> editable component items (sheet-basket shape)

// ── Weekly quiet encouragement (Amanda only) ──
// Source of truth: 08_Nutrition/Amanda_Encouragement_Messages.md
// Regenerate the array below with: python 05_Scripts/build_encouragement.py
// ENCOURAGEMENT:START
const N_ENCOURAGEMENT = [
  {"type": "wife", "text": "You are exactly the partner I'd choose again, on purpose, every time."},
  {"type": "wife", "text": "The steadiness you bring to this house is easy to take for granted and impossible to replace."},
  {"type": "wife", "text": "You've got a way of making people feel like they matter — I got the best version of that, every day."},
  {"type": "wife", "text": "Being loved by you has made me better at being a person."},
  {"type": "mother", "text": "You don't get enough credit for the invisible labor of just keeping everyone okay. I see it."},
  {"type": "person", "text": "Whatever you're carrying today, you don't have to carry all of it alone."},
  {"type": "person", "text": "You've built a life full of people who love you because of who you consistently choose to be."},
  {"type": "person", "text": "Whatever version of \"enough\" you're measuring yourself against today, you're clearing it."},
  {"type": "person", "text": "You are allowed to rest. The world keeps turning even when you're not holding it up for one afternoon."},
  {"type": "verse", "text": "\"She is clothed with strength and dignity, and she laughs without fear of the future.\" — Proverbs 31:25"},
  {"type": "verse", "text": "\"Her children rise up and call her blessed.\" — Proverbs 31:28"},
  {"type": "verse", "text": "\"Those who hope in the Lord will renew their strength. They will soar on wings like eagles.\" — Isaiah 40:31"},
  {"type": "verse", "text": "\"The Lord your God is with you, the Mighty Warrior who saves. He will take great delight in you; he will rejoice over you with singing.\" — Zephaniah 3:17"},
  {"type": "verse", "text": "\"Love is patient, love is kind... it always protects, always trusts, always hopes, always perseveres.\" — 1 Corinthians 13:4,7"},
  {"type": "verse", "text": "\"The joy of the Lord is your strength.\" — Nehemiah 8:10"},
  {"type": "verse", "text": "\"His mercies are new every morning; great is his faithfulness.\" — Lamentations 3:22-23"},
  {"type": "playful", "text": "If \"keeping the entire family calendar in her head\" were an Olympic event, you'd have a room full of gold medals."},
  {"type": "playful", "text": "The dog likes you best. Everyone knows it. It's fine. It's totally fine."},
  {"type": "playful", "text": "You could run this household with one hand tied behind your back, and some weeks you basically do."},
  {"type": "playful", "text": "Reminder: you are, statistically, the most competent person in this house before 6 a.m. Everyone else is just guessing."},
  {"type": "wife", "text": "Still think I got the better end of this deal every single day."},
  {"type": "wife", "text": "You're allowed to have an off day. I'll still think you're the best part of mine."},
  {"type": "wife", "text": "Whatever kind of day you're having, I'd still rather be having it with you than anyone else."},
  {"type": "wife", "text": "Honestly, you're better at this whole marriage thing than I probably deserve."},
  {"type": "mother", "text": "You raised boys who actually call their mother back. That's not nothing."},
  {"type": "mother", "text": "The house is quieter now, but the impact you had on those boys isn't going anywhere."},
  {"type": "mother", "text": "Pretty sure your sons don't know yet how much of who they are came from watching you."},
  {"type": "person", "text": "You don't have to have it all figured out today. Nobody does."},
  {"type": "verse", "text": "\"Let all that you do be done in love.\" — 1 Corinthians 16:14"},
  {"type": "verse", "text": "\"Cast all your anxiety on him because he cares for you.\" — 1 Peter 5:7"},
  {"type": "mother", "text": "You don't have to keep proving you're a good mom. That case closed a long time ago."},
  {"type": "person", "text": "You show up for people without keeping score. Not everyone does that."},
  {"type": "verse", "text": "\"She sets about her work vigorously; her arms are strong for her tasks.\" — Proverbs 31:17"},
  {"type": "wife", "text": "I don't say it enough, but I notice everything you do around here."},
  {"type": "wife", "text": "I'm still trying to figure out how I got this lucky."},
  {"type": "wife", "text": "I'd rather have a bad day with you than a good one without you."},
  {"type": "verse", "text": "\"She speaks with wisdom, and faithful instruction is on her tongue.\" — Proverbs 31:26"},
  {"type": "verse", "text": "\"The Lord is my strength and my shield; my heart trusts in him, and he helps me.\" — Psalm 28:7"},
  {"type": "verse", "text": "\"Many waters cannot quench love; rivers cannot sweep it away.\" — Song of Songs 8:7"},
];
// ENCOURAGEMENT:END

function nWeekHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function nSeededShuffle(n, seed) {
  let a = seed >>> 0;
  function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Picks ONE day this week to show a line, for Amanda only. Both the day
// and the message are deterministic per athlete+week (so it doesn't shift
// around on reload), but only render on the chosen day — the other six
// days show nothing. Cycles through every message once before any repeat,
// then reshuffles for the next cycle.
function nWeeklyQuietLine(dateStr) {
  if (!NS.me || NS.me.name !== 'Amanda' || !N_ENCOURAGEMENT.length) return '';
  const dayOffset = nWeekHash('enc:day:' + NS.me.id + ':' + NS.weekOf) % 7;
  const chosenDay = nAddDays(NS.weekOf, dayOffset);
  if (dateStr !== chosenDay) return '';

  const n = N_ENCOURAGEMENT.length;
  const weekNum = Math.floor(Date.parse(NS.weekOf + 'T00:00:00Z') / 86400000 / 7);
  const cycle = Math.floor(weekNum / n);
  const posInCycle = ((weekNum % n) + n) % n;
  const order = nSeededShuffle(n, nWeekHash('enc:' + NS.me.id + ':' + cycle));
  const msg = N_ENCOURAGEMENT[order[posInCycle]];
  return msg ? `<div class="n-quiet-note">${nEsc(msg.text)}</div>` : '';
}

// ── Render ──
function renderToday() {
  const dateStr = nViewDate();
  const today = nToday();
  const isBack = dateStr !== today;
  const ctx = nWeekCtx(dateStr);
  document.getElementById('today-title').textContent = nFmtDateShort(dateStr);
  document.getElementById('today-sub').textContent =
    `${NS.me.name} · week of ${ctx.weekOf}${(isBack || NS.planWeek) ? '' : ' — no plan pushed yet'}`;
  // Day nav: back up to N_BACKLOG_DAYS, never past today (hidden, not removed, so the title doesn't shift)
  const prev = document.getElementById('today-prev'), next = document.getElementById('today-next');
  if (prev) prev.style.visibility = dateStr > nAddDays(today, -N_BACKLOG_DAYS) ? 'visible' : 'hidden';
  if (next) next.style.visibility = isBack ? 'visible' : 'hidden';

  const body = document.getElementById('today-body');
  const blocks = [];
  if (isBack) {
    // Past day: banner makes the target date unmissable; "now" prompts stay on today.
    blocks.push(`<div class="n-backday"><span>Viewing <b>${nEsc(nFmtDate(dateStr))}</b> — logs save to this day</span>
      <button onclick="nViewToday()">Back to today</button></div>`);
  } else {
    blocks.push(nPromptCardsHtml());
  }

  const inWeek = isBack
    ? (dateStr >= NS.weekOf || nMyMeals(dateStr).length > 0 || !!ctx.target)
    : (dateStr >= NS.weekOf && dateStr <= nAddDays(NS.weekOf, 6));
  if (!inWeek) {
    blocks.push(`<div class="n-panel"><div class="n-panel-title">Plan week of ${NS.weekOf}</div>
      Your plan ${dateStr < NS.weekOf ? 'starts ' + nFmtDate(NS.weekOf) : 'ended ' + nFmtDate(nAddDays(NS.weekOf, 6))}.
      Browse the full week, prep plan, and grocery list in the tabs below — meals appear here day by day once the week begins.</div>`);
  } else {
    blocks.push(`<div class="n-sticky">${nBudgetHtml(dateStr)}</div>`);
  }

  const meals = inWeek ? nMyMeals(dateStr) : [];
  if (!meals.length && inWeek) {
    blocks.push(`<div class="n-panel">No meals planned for ${isBack ? 'this day' : 'today'}.</div>`);
  }
  for (const m of meals) blocks.push(nMealCardHtml(m));

  // Added (unplanned) items today
  const added = NS.addedLogs.filter(l => l.log_date === dateStr);
  if (added.length) {
    blocks.push(`<div class="n-sheet-section" style="margin-top:14px">Added${isBack ? '' : ' today'}</div>`);
    for (const l of added) blocks.push(nAddedCardHtml(l));
  }

  blocks.push(nActivityCardHtml());
  blocks.push(`<button class="n-act" style="width:100%;margin-top:10px" onclick="openNSheet('add', null)">+ Add food${isBack ? ' to ' + nDayName(dateStr, true) : ''}</button>`);

  // Weekly quiet line (Amanda only) — dropped into a random gap between
  // cards so it doesn't always land in the same place, but never inside
  // an existing card's markup.
  const quiet = isBack ? '' : nWeeklyQuietLine(dateStr);
  if (quiet) {
    const pos = nWeekHash('enc:slot:' + NS.me.id + ':' + NS.weekOf) % (blocks.length + 1);
    blocks.splice(pos, 0, quiet);
  }

  body.innerHTML = blocks.join('');
}

// ── Back-logging day navigation ──
function nFmtDateShort(dstr) {
  const d = new Date(dstr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function nViewShift(n) {
  const t = nToday();
  const d = nAddDays(nViewDate(), n);
  if (d > t || d < nAddDays(t, -N_BACKLOG_DAYS)) return;
  NS.viewDate = d === t ? null : d;
  renderToday();
  const b = document.getElementById('today-body'); if (b) b.scrollTop = 0;
}
function nViewToday() { NS.viewDate = null; renderToday(); }
// Week tab → open a day (within the window) on the Today screen.
function nOpenDayInToday(d) {
  NS.viewDate = d === nToday() ? null : d;
  nShowTab('today');
}
// Which plan week a date belongs to: the current one, or (for back-logged days
// before it) the previous plan week loaded into NS.prevMeals / NS.prevTarget.
function nWeekCtx(dateStr) {
  if (dateStr < NS.weekOf && NS.prevWeekOf) {
    const wo = NS.prevWeekOf, end = [nAddDays(wo, 6), nAddDays(NS.weekOf, -1)].sort()[0];
    return { weekOf: wo, end, target: NS.prevTarget,
      meals: (NS.prevMeals || []).filter(m => m.meal_date >= wo && m.meal_date <= end) };
  }
  return { weekOf: NS.weekOf, end: nAddDays(NS.weekOf, 6), target: NS.target, meals: NS.meals };
}

// ── On-track math ──
// Color compares ACTUAL eaten vs PLANNED-SO-FAR (only meals already logged).
// One breakfast logged as planned = green, even early in the day.
function nExpectedSoFar(dateStr) {
  let expected = 0;
  for (const m of nMyMeals(dateStr)) if (NS.logs[m.id]) expected += m.planned_kcal;
  return expected;
}
function nTrackClass(actual, expected) {
  if (!expected && !actual) return 'idle';
  const diff = Math.abs(actual - expected);
  if (diff <= Math.max(100, 0.10 * expected)) return 'ok';
  if (diff <= Math.max(250, 0.20 * expected)) return 'warn';
  return 'bad';
}
function nWeekStats(ctx) {
  ctx = ctx || nWeekCtx(nViewDate());
  let actual = 0, expected = 0, approx = false;
  for (const m of ctx.meals) {
    if (m.athlete_id !== NS.me.id) continue;
    const l = NS.logs[m.id];
    if (!l) continue;
    expected += m.planned_kcal;
    if (l.actual_kcal == null && l.status !== 'skipped') { approx = true; continue; }
    actual += l.actual_kcal || 0;
  }
  for (const l of NS.addedLogs) {
    if (l.log_date < ctx.weekOf || l.log_date > ctx.end) continue;  // back-log window loads other weeks too
    if (l.actual_kcal == null) { approx = true; continue; }
    actual += l.actual_kcal || 0;
  }
  return { actual: Math.round(actual), expected: Math.round(expected), approx };
}

// ── Budget header (sticky, day + week bars) ──
function nBudgetHtml(dateStr) {
  const ctx = nWeekCtx(dateStr);
  const isBack = dateStr !== nToday();
  const dayLbl = isBack ? nDayName(dateStr, true) : 'Today';
  const t = ctx.target;
  if (!t) return `<div class="n-panel">No targets pushed for this week yet.</div>`;
  const { kcal, protein, approx } = nDayTotals(dateStr);
  const expected = nExpectedSoFar(dateStr);
  const dayCls = nTrackClass(kcal, expected);
  // The bar runs against what's PLANNED for the day; the target is context.
  // Planned days intentionally land within ~±100 kcal of target, not exactly on it.
  const plannedToday = Math.round(nMyMeals(dateStr).reduce((s, m) => s + m.planned_kcal, 0)) || t.kcal_target;
  const dayPct = Math.min(100, Math.round(100 * kcal / plannedToday));
  const remaining = plannedToday - kcal;
  const pRemain = Math.max(0, t.protein_g_low - protein);
  const tilde = approx ? '~' : '';

  const wk = nWeekStats(ctx);
  const wkPlanned = Math.round(ctx.meals.filter(m => m.athlete_id === NS.me.id)
    .reduce((s, m) => s + m.planned_kcal, 0)) || t.kcal_target * 7;
  const wkCls = nTrackClass(wk.actual, wk.expected);
  const wkPct = Math.min(100, Math.round(100 * wk.actual / wkPlanned));
  const wkLeft = wkPlanned - wk.actual;

  let hint = '';
  const dayDiff = kcal - expected;
  if (isBack) { /* next-meal coaching doesn't apply to a past day */ }
  else if (dayCls === 'bad' && dayDiff > 0)
    hint = `<div class="n-budget-hint">~${dayDiff} over planned-so-far — go lighter on the next meal, then back to plan (no compensating)</div>`;
  else if (dayCls === 'bad' && expected > 0)
    hint = `<div class="n-budget-hint">~${-dayDiff} under planned-so-far — under-eating isn't a win in this phase; eat your meals</div>`;

  return `<div class="n-budget" style="margin-bottom:10px">
    <div class="n-budget-kcal"><span>${dayLbl} ${tilde}${kcal.toLocaleString()} / ${plannedToday.toLocaleString()} planned</span>
      <span style="font-size:12px;font-weight:400;color:var(--n-muted)">P ${tilde}${protein} / ${t.protein_g_low}–${t.protein_g_high}g</span></div>
    <div class="n-budget-bar"><div class="n-budget-fill ${dayCls}" style="width:${dayPct}%"></div></div>
    <div class="n-budget-row2"><span>Week ${wk.approx ? '~' : ''}${wk.actual.toLocaleString()} / ${wkPlanned.toLocaleString()} planned</span>
      <span>${wkLeft > 0 ? '~' + wkLeft.toLocaleString() + ' left this week' : 'week plan complete'}</span></div>
    <div class="n-bar-slim"><div class="n-budget-fill ${wkCls}" style="width:${wkPct}%"></div></div>
    <div class="n-budget-remaining">Remaining${isBack ? '' : ' today'}: <b>${remaining > 0 ? '~' + remaining.toLocaleString() + ' kcal' : 'plan complete ✓'}</b>
      · day target ${t.kcal_target.toLocaleString()}
      ${pRemain > 0 ? ` · ~${pRemain}g protein to floor` : ' · protein floor met ✓'}</div>
    ${hint}</div>`;
}

// ── Prompt cards ──
function nWeighInDueToday() {
  const days = NS.settings?.weigh_in_days || [];
  return days.includes(nDayName(nToday(), true)) && NS.metricsToday.weight == null && !NS.dismissed.weight;
}
// Evening-before heads-up: we weigh first thing, so a same-morning card is too
// late. Show after 5pm the day before a weigh-in day; dismissal keyed to that
// date so 'got it' sticks for the rest of the evening.
function nWeighInTomorrow() {
  const days = NS.settings?.weigh_in_days || [];
  const tmrw = nDayName(nAddDays(nToday(), 1), true);
  return days.includes(tmrw) && new Date().getHours() >= 17;
}
function nMeasurementsDue() {
  const s = NS.settings;
  if (!s) return [];
  const intDays = (s.measurement_interval_weeks || 4) * 7;
  return (s.measurement_metrics || []).filter(metric => {
    if (NS.metricsToday[metric] != null || NS.dismissed[metric]) return false;
    const last = NS.lastMetricDates[metric];
    if (!last) return true;
    return (new Date(nToday()) - new Date(last)) / 86400000 >= intDays;
  });
}
function nPromptCardsHtml() {
  let html = '';
  html += nFreezerCardsHtml();   // 🧊 freezer pulls first — most time-sensitive
  html += nFreezerStockCardsHtml();  // 🧊 prep-night 'set aside to freeze' confirms
  const day = nDayName(nToday(), true);
  if (day === 'Sun' && !NS.checkin && !NS.dismissed.checkin) {
    html += `<div class="n-prompt"><div class="n-prompt-title">📝 Weekly check-in day</div>
      <div class="n-prompt-row">
        <button class="n-act small primary" onclick="openCheckin()">Open check-in (~1 min)</button>
        <button class="n-prompt-dismiss" onclick="NS.dismissed.checkin=1;renderToday()">later</button>
      </div></div>`;
  }
  // Prep cards: full checklist on the prep day, thaw heads-up the evening before.
  // Dates come from the prep_plan block headers (nPrepBlocks); dismissals persist.
  {
    const { dated: prepBlocks, notes: prepNotes } = nPrepBlocks();
    const todayBlk = prepBlocks.find(b => b.date === nToday());
    const tmrwBlk = prepBlocks.find(b => b.date === nAddDays(nToday(), 1));
    if (todayBlk && !nDismissedLS('prep_' + todayBlk.date)) {
      // Compact reminder only — the full checklist already lives on the Week tab.
      html += `<div class="n-prompt"><div class="n-prompt-title">🔪 Prep day
        <button class="n-prompt-dismiss" onclick="nDismissLS('prep_${todayBlk.date}');renderToday()">done</button></div>
        <div style="font-size:13px;color:var(--n-text);margin:2px 0 8px">It's a prep day — the full checklist is on the Week tab.</div>
        <div class="n-prompt-row"><button class="n-act small primary" onclick="nShowTab('nweek')">Open Week tab</button></div></div>`;
    } else if (tmrwBlk && !nDismissedLS('prephu_' + tmrwBlk.date)) {
      html += `<div class="n-prompt"><div class="n-prompt-title">🔪 Prep tomorrow
        <button class="n-prompt-dismiss" onclick="nDismissLS('prephu_${tmrwBlk.date}');renderToday()">got it</button></div>
        <div class="n-prep-head">${nEsc(tmrwBlk.head)}</div>
        ${tmrwBlk.steps.length ? nPrepStepHtml(tmrwBlk.steps[0]) : ''}</div>`;
    } else if (!prepBlocks.length && (day === 'Sun' || day === 'Wed') && NS.planWeek?.prep_plan && !NS.dismissed.prep) {
      // Legacy fallback: prep_plan text without parseable dated blocks.
      html += `<div class="n-prompt"><div class="n-prompt-title">🔪 Prep night
        <button class="n-prompt-dismiss" onclick="NS.dismissed.prep=1;renderToday()">done</button></div>
        <div style="font-size:13px;color:var(--n-text);white-space:pre-wrap">${nEsc(NS.planWeek.prep_plan)}</div>
        <div class="n-prompt-row" style="margin-top:8px"><button class="n-act small" onclick="nShowTab('recipes')">📖 Open Recipe Book</button></div></div>`;
    }
  }
  {
    const wTmrw = nAddDays(nToday(), 1);
    if (nWeighInTomorrow() && !nDismissedLS('weighhu_' + wTmrw)) {
      html += `<div class="n-prompt"><div class="n-prompt-title">⚖️ Weigh-in tomorrow
        <button class="n-prompt-dismiss" onclick="nDismissLS('weighhu_${wTmrw}');renderToday()">got it</button></div>
        <div style="font-size:13px;color:var(--n-text)">Heads up — weigh in first thing tomorrow morning, before eating or drinking.</div></div>`;
    }
  }
  if (nWeighInDueToday()) {
    html += `<div class="n-prompt"><div class="n-prompt-title">⚖️ Weigh-in day</div>
      <div class="n-prompt-row">
        <input type="number" inputmode="decimal" id="np-weight" placeholder="lbs">
        <button class="n-act small primary" onclick="submitWeighIn()">Save</button>
        <button class="n-prompt-dismiss" onclick="NS.dismissed.weight=1;renderToday()">later</button>
      </div></div>`;
  }
  // Measurements ride the weekly check-in cadence: only surface on the Sunday
  // check-in, and only once 4 wks have elapsed (nMeasurementsDue). Dismissing
  // snoozes for the whole plan week (nDismissLS is week-scoped), so it never
  // nags daily — if missed, it returns next Sunday, still overdue.
  const due = nMeasurementsDue();
  if (due.length && day === 'Sun' && !nDismissedLS('measure')) {
    // Labels + entry-time protocol reminders (N09 §2 / N04 / N05).
    // Calipers are entered PER SITE; mm-sum is derived. bodyfat_pct is retired.
    const label = {
      waist: 'Waist (in)', hips: 'Hips (in)',
      caliper_chest_mm: 'Chest (mm)', caliper_abdomen_mm: 'Abdomen (mm)', caliper_thigh_mm: 'Thigh (mm)',
      caliper_mm_sum: 'Calipers mm-sum'
    };
    const siteHint = {
      waist: 'At the navel, tape horizontal, end of a normal exhale. 2 measurements — re-measure if they differ >0.25 in, record the average.',
      hips: 'Widest point of the hips/glutes, feet together, tape horizontal.',
      caliper_chest_mm: 'Right side. Diagonal fold, midway between the anterior axillary line and the nipple. 2 passes, re-pinch if >1 mm apart.',
      caliper_abdomen_mm: 'Right side. Vertical fold, ~1 in right of the navel. 2 passes, re-pinch if >1 mm apart.',
      caliper_thigh_mm: 'Right side. Vertical fold, front of thigh, midway between the inguinal crease and the top of the patella. 2 passes.',
      caliper_mm_sum: 'Sum of chest + abdomen + thigh.'
    };
    const rows = due.map(metric => {
      const lab = label[metric] || metric;
      const hint = siteHint[metric] ? `<div class="n-hint" style="width:100%;font-size:11px;opacity:.7;margin:2px 0 6px 0">${siteHint[metric]}</div>` : '';
      return `<div class="n-prompt-row" style="margin-bottom:6px;flex-wrap:wrap"><label style="width:110px">${lab}</label>
        <input type="number" inputmode="decimal" id="np-${metric}">
        <button class="n-act small primary" onclick="submitMeasurement('${metric}')">Save</button>${hint}</div>`;
    }).join('');
    html += `<div class="n-prompt"><div class="n-prompt-title">📏 Measurement check (every ${NS.settings?.measurement_interval_weeks || 4} weeks)
      <button class="n-prompt-dismiss" onclick="nDismissLS('measure');renderToday()">later</button></div>${rows}</div>`;
  }
  return html;
}
// ══════════════ Entry-time confirm sheets (N09 §4 rules 1-5, 14) ══════════════
// Design stance: catch entry ERRORS at entry time; leave biology to the coach.
// These sheets never lecture about normal fluctuation and never delete data —
// every branch either writes a corrected value or writes the original with a flag.
// Only rules 1-5 and 14 get a sheet; everything else in §4 is passive.

let N_CONFIRM = null;   // {actions: [{label, kind, run}]}

function nConfirmOpen(title, bodyHtml, actions) {
  N_CONFIRM = { actions };
  document.getElementById('n-confirm-title').textContent = title;
  document.getElementById('n-confirm-body').innerHTML = bodyHtml;
  document.getElementById('n-confirm-actions').innerHTML = actions.map((a, i) =>
    `<button class="n-act${a.kind === 'primary' ? ' primary' : ''}" onclick="nConfirmRun(${i})"
      style="width:100%;padding:11px">${nEsc(a.label)}</button>`).join('');
  document.getElementById('n-confirm').style.display = 'flex';
  nBackPush('confirm', nConfirmHide);
}
function nConfirmHide() {
  document.getElementById('n-confirm').style.display = 'none';
  N_CONFIRM = null;
}
function nConfirmClose() { nConfirmHide(); nBackConsume('confirm'); }
async function nConfirmRun(i) {
  const a = N_CONFIRM && N_CONFIRM.actions[i];
  nConfirmClose();
  if (a && a.run) await a.run();
}

async function submitWeighIn() {
  const v = parseFloat(document.getElementById('np-weight').value);
  if (!v || v < 50 || v > 500) { toast('Enter a weight in lbs'); return; }

  // Rules 1 and 2 — implausible vs trend, or a likely unit/typo error.
  const ref = nWeightReference();
  const hit = nmCheckWeight(v, ref);
  if (!hit) return nSaveWeigh(v, null, null);

  const actions = [];
  if (hit.suggested) {
    actions.push({
      label: `Use ${hit.suggested.value} lb instead`, kind: 'primary',
      run: () => nSaveWeigh(hit.suggested.value, null, null),
    });
  }
  actions.push({
    label: `Keep ${v} lb — that's real`,
    // Retained + flagged. The trend engine skips 'suspect' points (N09 §3.1) so one
    // odd reading can't drag the line, but the number stays in the record.
    run: () => nSaveWeigh(v, 'suspect', hit.key),
  });
  actions.push({ label: 'Cancel — let me re-weigh', run: null });

  const why = hit.suggested
    ? `<div style="font-size:12px;color:var(--n-muted);margin-top:6px">Looks like ${nEsc(hit.suggested.why)}.</div>`
    : '';
  nConfirmOpen('Check that weigh-in',
    `<div>${nEsc(hit.message)}</div>${why}
     <div style="font-size:12px;color:var(--n-muted);margin-top:8px">Nothing is deleted either way —
     if you keep it, it's saved but left out of your trend line.</div>`, actions);
}

async function nSaveWeigh(v, flag, reason) {
  if (await nSaveMetric('weight', v, 'lb', flag, reason)) {
    toast(flag ? 'Saved and flagged ✓' : 'Weight saved ✓');
    renderToday();
  }
}

async function submitMeasurement(metric) {
  const v = parseFloat(document.getElementById(`np-${metric}`).value);
  if (!v || v <= 0) { toast('Enter a value'); return; }
  const unit = metric.startsWith('caliper_') ? 'mm' : 'in';
  const prev = (NS.lastMetricValues || {})[metric];

  // Rule 3 — waist/hips jump >1.5 in. Rule 4 — caliper mm-sum >15%; checked on the
  // DERIVED sum once all three sites are in, which is why it fires on the last site.
  let hit = null;
  if (metric === 'waist' || metric === 'hips') {
    hit = nmCheckTape(v, prev);
  } else if (metric.startsWith('caliper_')) {
    const sums = nCaliperSums(metric, v);
    if (sums) hit = nmCheckCaliper(sums.now, sums.prev);
  }
  if (!hit) return nSaveMeasure(metric, v, unit, null, null);

  nConfirmOpen('Re-measure to confirm?',
    `<div>${nEsc(hit.message)}</div>
     <div style="font-size:12px;color:var(--n-muted);margin-top:8px">Tape and caliper readings drift with
     technique more than with body change — a second pass settles it.</div>`,
    [
      { label: 'I re-measured — it\'s correct', kind: 'primary',
        run: () => nSaveMeasure(metric, v, unit, 'confirmed', hit.key) },
      { label: 'Save it, but flag as unsure',
        run: () => nSaveMeasure(metric, v, unit, 'suspect', hit.key) },
      { label: 'Cancel — let me re-measure', run: null },
    ]);
}

async function nSaveMeasure(metric, v, unit, flag, reason) {
  if (await nSaveMetric(metric, v, unit, flag, reason)) {
    toast(flag === 'suspect' ? 'Saved and flagged ✓' : 'Saved ✓');
    renderToday();
  }
}

// Current vs previous caliper mm-sum. Returns null until all three sites exist
// for today AND a previous sum is known — rule 4 compares sums, not single sites.
function nCaliperSums(metric, v) {
  const SITES = ['caliper_chest_mm', 'caliper_abdomen_mm', 'caliper_thigh_mm'];
  const today = { ...(NS.metricsToday || {}), [metric]: v };
  if (!SITES.every(s => today[s] != null)) return null;
  const prevVals = NS.lastMetricValues || {};
  if (!SITES.every(s => prevVals[s] != null)) return null;
  return {
    now: SITES.reduce((a, s) => a + parseFloat(today[s]), 0),
    prev: SITES.reduce((a, s) => a + parseFloat(prevVals[s]), 0),
  };
}

// ── Meal cards ──
function nToggleCard(id) { N_OPEN[id] = !N_OPEN[id]; renderToday(); }

function nMealCardHtml(m) {
  const log = NS.logs[m.id];
  const pend = N_PENDING[m.id] || 1;
  const name = nMealName(m);
  const partner = nSharedPartner(m);
  const slotLabel = m.meal_slot === 'snack' ? `snack ${m.slot_order > 1 ? m.slot_order : ''}` : m.meal_slot;

  let badges = '';
  if (partner) badges += `<span class="n-badge shared">👥 with ${nEsc(partner.name)} (their portion: ${partner.servings}×)</span>`;
  if (m.is_leftover) badges += `<span class="n-badge leftover">leftover</span>`;

  if (log) {
    const ate = nLogName(log);
    const icon = N_STATUS_ICON[log.status] || '✓';
    const cls = log.status === 'skipped' ? 'skip' : (log.status === 'ate_out' ? 'off' : '');
    const kcalTxt = log.actual_kcal != null
      ? `${log.actual_kcal} · ${log.actual_protein_g}P${log.portion_modifier !== 1 ? ` · ${log.portion_modifier}×` : ''}`
      : 'not quantified';
    const label = log.status === 'swapped' && ate ? `${nEsc(name)} → ${nEsc(ate)}` : nEsc(name);

    if (!N_OPEN[m.id]) {
      return `<div class="n-meal done compact ${cls}" onclick="nToggleCard('${m.id}')">
        <div class="n-done-row"><span class="n-done-check">${icon}</span>
          <span class="n-done-name">${label}</span>
          <span class="n-done-kcal">${kcalTxt}</span></div></div>`;
    }
    const showChips = log.status !== 'skipped';
    return `<div class="n-meal done">
      <div class="n-meal-top" onclick="nToggleCard('${m.id}')" style="cursor:pointer">
        <span class="n-meal-slot">${slotLabel} ▾</span>
        <span class="n-meal-kcal">${kcalTxt}</span></div>
      <div class="n-meal-name">${label}</div>
      <div class="n-meal-badges"><span class="n-badge status">${N_STATUS_LABEL[log.status] || log.status}</span>${badges}</div>
      ${showChips ? `<div class="n-portion-chips">${N_PORTIONS.map(p =>
        `<button class="n-chip${log.portion_modifier === p ? ' active' : ''}" onclick="pickPortion('${m.id}',${p})">${p}×</button>`).join('')}</div>` : ''}
      <div class="n-meal-actions" style="margin-top:8px">
        <button class="n-act small" onclick="reopenMeal('${m.id}')">Re-log</button>
        <button class="n-act small" onclick="nToggleCard('${m.id}')">Collapse</button>
      </div></div>`;
  }

  const seedItems = nMealSeedItems(m);
  const canAdjust = seedItems.length > 0 && !m.custom_name;
  const isAsm = typeof nIsAssemblyRecipe === 'function' && nIsAssemblyRecipe(m.recipe_id);
  const nameHtml = (m.recipe_id && !isAsm)
    ? `<span class="n-rec-linkable" onclick="event.stopPropagation();nOpenRecipe('${m.recipe_id}')">${nEsc(name)} <span class="n-rec-linkicon">📖</span></span>`
    : nEsc(name);
  const itemsLine = (m.recipe_id && seedItems.length)
    ? seedItems.map(it => `${nEsc(it.name)} <span class="n-item-qty">${nEsc(nItemQtyBadge(it))}</span>`).join(' · ')
    : '';
  const adjOpen = !!N_ADJ[m.id];
  return `<div class="n-meal">
    <div class="n-meal-top"><span class="n-meal-slot">${slotLabel}</span>
      <span class="n-meal-kcal">${Math.round(m.planned_kcal)} kcal · ${Math.round(m.planned_protein_g)}P · ${Math.round(m.planned_carbs_g)}C · ${Math.round(m.planned_fat_g)}F</span></div>
    <div class="n-meal-name">${nameHtml}</div>
    ${itemsLine ? `<div class="n-meal-items">${itemsLine}</div>` : (m.portion_note ? `<div class="n-meal-portion">${nEsc(m.portion_note)}</div>` : '')}
    ${badges ? `<div class="n-meal-badges">${badges}</div>` : ''}
    ${m.coach_note ? `<div class="n-meal-note">${nEsc(m.coach_note)}</div>` : ''}
    ${adjOpen ? nAdjustPanelHtml(m) : ''}
    <div class="n-meal-actions">
      <button class="n-act primary" onclick="quickLog('${m.id}')">✓ Ate it</button>
      ${canAdjust ? `<button class="n-act${adjOpen ? ' active' : ''}" onclick="nToggleAdjust('${m.id}')">Adjust ${adjOpen ? '▴' : '▾'}</button>` : ''}
      <button class="n-act" onclick="openNSheet('swap','${m.id}')">⇄ Swap</button>
      <button class="n-act" onclick="quickSkip('${m.id}')">Skip</button>
    </div></div>`;
}

// ── Added (unplanned) item cards: portion + delete ──
function nAddedCardHtml(l) {
  const name = nLogName(l) || 'Added item';
  const kcalTxt = l.actual_kcal != null
    ? `${l.actual_kcal} · ${l.actual_protein_g ?? 0}P${l.portion_modifier !== 1 ? ` · ${l.portion_modifier}×` : ''}`
    : 'not quantified';
  if (!N_OPEN[l.id]) {
    return `<div class="n-meal done compact" onclick="nToggleCard('${l.id}')">
      <div class="n-done-row"><span class="n-done-check">+</span>
        <span class="n-done-name">${nEsc(name)}</span>
        <span class="n-done-kcal">${kcalTxt}</span></div></div>`;
  }
  return `<div class="n-meal done">
    <div class="n-meal-top" onclick="nToggleCard('${l.id}')" style="cursor:pointer">
      <span class="n-meal-slot">extra ▾</span><span class="n-meal-kcal">${kcalTxt}</span></div>
    <div class="n-meal-name">${nEsc(name)}</div>
    ${l.actual_kcal != null ? `<div class="n-portion-chips">${N_PORTIONS.map(p =>
      `<button class="n-chip${l.portion_modifier === p ? ' active' : ''}" onclick="nAddedPortion('${l.id}',${p})">${p}×</button>`).join('')}</div>` : ''}
    <div class="n-meal-actions" style="margin-top:8px">
      <button class="n-act small" onclick="nRemoveAdded('${l.id}')">Remove</button>
      <button class="n-act small" onclick="nToggleCard('${l.id}')">Collapse</button>
    </div></div>`;
}
async function nAddedPortion(logId, p) {
  const l = NS.addedLogs.find(x => x.id === logId);
  if (!l) return;
  const prev = l.portion_modifier || 1.0;
  const scale = v => v == null ? null : nRound((v / prev) * p);
  const row = { portion_modifier: p, actual_kcal: scale(l.actual_kcal),
    actual_protein_g: scale(l.actual_protein_g), actual_carbs_g: scale(l.actual_carbs_g),
    actual_fat_g: scale(l.actual_fat_g) };
  try {
    const saved = await nWriteLog(row, l.id);
    NS.addedLogs = NS.addedLogs.map(x => x.id === logId ? saved : x);
    renderToday();
  } catch (e) { toast('Save failed', 3000); }
}
async function nRemoveAdded(logId) {
  const { error } = await ndb.from('meal_logs').delete().eq('id', logId);
  if (error) { toast('Remove failed: ' + error.message, 3500); return; }
  NS.addedLogs = NS.addedLogs.filter(x => x.id !== logId);
  toast('Removed');
  renderToday();
}

function nFindMeal(id) { return NS.meals.find(m => m.id === id) || (NS.prevMeals || []).find(m => m.id === id); }
function nPickPending(mealId, p) { N_PENDING[mealId] = p; renderToday(); }
// Kitchen-unit label for a Tweak basket item: qty x serving_desc -> "6 oz cooked" (no bare multiplier shown).
// When the food carries grams_per_serving, appends the scaled gram/oz reading so the
// quantity-adjust panel shows exactly how much that qty is in household terms
// (e.g. "2 medium (~260g / 9.2oz)") without text-scaling the household_desc string.
function nKitchenAmt(it) {
  const d = String(it.unit || 'serving');
  const bw = it.basis ? ` ${it.basis}` : '';
  // Oz-entry items: the input box already reads in ounces, so the label only needs
  // the serving equivalence for count-based servings ("0.8 large") — plus the basis word,
  // so a cooked-basis food never gets a raw weight typed into it.
  if (it.ozPer) {
    if (/^\d+(?:\.\d+)?\s*oz\b/i.test(d)) return bw ? `${it.basis} weight` : '';
    const eq = '≈ ' + ((typeof nScaleServing === 'function') ? nScaleServing(d, it.qty) : `${it.qty}x ${d}`);
    return bw ? `${eq}, ${it.basis} weight` : eq;
  }
  const base = (typeof nScaleServing === 'function') ? nScaleServing(d, it.qty) : `${it.qty}x ${d}`;
  const gps = Number(it.grams);
  if (gps > 0) {
    const g = Math.round(gps * it.qty);
    const oz = Math.round((g / 28.3495) * 10) / 10;
    return `${base} (~${g}g / ${oz}oz)`;
  }
  return base;
}

// ══════════════ Inline component editing (Adjust panel on the meal card) ══════════════
// Build a sheet-basket-shaped item from a food row (so these items are compatible
// with nBasketTotals / nKitchenAmt and can be handed to the builder sheet).
function nMakeItem(f, qty) {
  return { srcKind: 'f', srcId: f.id, kind: 'f', id: f.id, name: f.name, qty,
    kcal: f.kcal, protein_g: f.protein_g, carbs_g: f.carbs_g, fat_g: f.fat_g,
    unit: f.serving_desc, grams: f.grams_per_serving, ozPer: nOzPerServing(f),
    basis: (typeof nBasisWord === 'function') ? nBasisWord(f) : '',
    rest: f.item_type === 'restaurant' };
}
// The planned meal's items at planned servings: recipe components, else the single food.
function nMealSeedItems(m) {
  const out = [];
  const comps = m.recipe_id ? (NS.components || {})[m.recipe_id] : null;
  if (comps && comps.length) {
    for (const c of comps) {
      const f = NS.foods.find(x => x.id === c.food_item_id);
      if (!f) continue;
      const it = nMakeItem(f, Math.round(c.qty * (m.planned_servings || 1) * 100) / 100);
      it.seedQty = it.qty; out.push(it);
    }
  } else if (m.food_item_id) {
    const f = NS.foods.find(x => x.id === m.food_item_id);
    if (f) { const it = nMakeItem(f, m.planned_servings || 1); it.seedQty = it.qty; out.push(it); }
  }
  return out;
}
// Compact per-item badge for the collapsed card: measured units show the amount
// ("1 tbsp", "6 oz"); count-like units show a multiplier ("×3").
function nItemQtyBadge(it) {
  if (it.ozPer) return `${Math.round(it.qty * it.ozPer * 10) / 10} oz`;
  const d = String(it.unit || 'serving').trim();
  const mm = d.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
  const unitWord = (mm ? mm[2] : d).toLowerCase();
  if (/^(tbsp|tsp|oz|cup|gram|g\b|ml)/.test(unitWord)) return nScaleServing(d, it.qty);
  const q = Math.round(it.qty * 100) / 100;
  return '×' + q;
}
function nToggleAdjust(id) {
  if (N_ADJ[id]) { delete N_ADJ[id]; }
  else { N_ADJ_BASKET[id] = nMealSeedItems(nFindMeal(id)); N_ADJ[id] = true; }
  renderToday();
}
function nAdjTotals(id) {
  const t = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const it of (N_ADJ_BASKET[id] || [])) {
    t.kcal += it.kcal * it.qty; t.protein_g += it.protein_g * it.qty;
    t.carbs_g += it.carbs_g * it.qty; t.fat_g += it.fat_g * it.qty;
  }
  for (const k of Object.keys(t)) t[k] = Math.round(t[k]);
  return t;
}
function nAdjQty(id, idx, val) {
  let q = parseFloat(val);
  if (isNaN(q) || q < 0) return;
  const it = N_ADJ_BASKET[id] && N_ADJ_BASKET[id][idx];
  if (!it) return;
  if (it.ozPer) q = q / it.ozPer;   // box reads ounces -> store servings
  it.qty = q;
  renderToday();
}
function nAdjDrop(id, idx) { if (N_ADJ_BASKET[id]) { N_ADJ_BASKET[id].splice(idx, 1); renderToday(); } }
function nAdjScaleAll(id, f) {
  for (const it of (N_ADJ_BASKET[id] || []))
    it.qty = Math.round((it.seedQty != null ? it.seedQty : it.qty) * f * 100) / 100;
  renderToday();
}
// Promote the inline edits into the full builder sheet to add or swap items.
function nAdjAddItem(id) {
  const items = N_ADJ_BASKET[id] || [];
  openNSheet('swap', id);
  NS.sheet.basket = items;
  delete N_ADJ[id];
  renderNSheetList();
}
async function nAdjLog(id) {
  const m = nFindMeal(id);
  const basket = N_ADJ_BASKET[id] || [];
  if (!basket.length) { toast('Add an item or Swap the meal'); return; }
  const seed = nMealSeedItems(m);
  const unchanged = seed.length === basket.length
    && basket.every(b => { const s = seed.find(x => x.id === b.id); return s && Math.abs((s.qty || 0) - (b.qty || 0)) < 0.001; });
  try {
    if (unchanged) {
      await nLogMeal(m, 'as_planned', null, 1.0);
    } else {
      const tot = nAdjTotals(id);
      const desc = basket.map(it => it.ozPer
        ? `${Math.round(it.qty * it.ozPer * 10) / 10}oz ${it.name}`
        : `${it.qty}× ${it.name}`).join('; ');
      await nLogMeal(m, 'swapped', { recipe_id: null, food_item_id: null, desc,
        kcal: tot.kcal, protein_g: tot.protein_g, carbs_g: tot.carbs_g, fat_g: tot.fat_g }, 1.0);
    }
    delete N_ADJ[id]; delete N_ADJ_BASKET[id];
    toast('Logged ✓'); renderToday();
  } catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}
function nAdjustPanelHtml(m) {
  const basket = N_ADJ_BASKET[m.id] || [];
  const tot = nAdjTotals(m.id);
  const dk = Math.round(tot.kcal - m.planned_kcal);
  const rows = basket.map((it, i) => `<div class="n-adjust-row">
      <span class="n-adjust-name">${nEsc(it.name)}<span class="n-adjust-amt">${nEsc(nKitchenAmt(it))}</span></span>
      <input type="number" class="n-adjust-qty" inputmode="decimal" step="${it.ozPer ? 0.1 : 0.25}" min="0"
        value="${it.ozPer ? Math.round(it.qty * it.ozPer * 10) / 10 : it.qty}" onchange="nAdjQty('${m.id}',${i},this.value)"><span class="n-unit">${it.ozPer ? 'oz' : '×'}</span>
      <button class="n-adjust-x" onclick="nAdjDrop('${m.id}',${i})">✕</button></div>`).join('');
  return `<div class="n-adjust">
    <div class="n-adjust-scale"><span class="n-adjust-lbl">scale all</span>${N_PORTIONS.map(p =>
      `<button class="n-chip" onclick="nAdjScaleAll('${m.id}',${p})">${p}×</button>`).join('')}</div>
    <div class="n-adjust-items">${rows || '<div class="n-adjust-empty">No items — add one below or Swap.</div>'}</div>
    <button class="n-adjust-add" onclick="nAdjAddItem('${m.id}')">＋ add / swap an item</button>
    <div class="n-adjust-total">${tot.kcal} kcal · ${tot.protein_g}P · ${tot.carbs_g}C · ${tot.fat_g}F
      <span class="n-adjust-delta">(${dk >= 0 ? '+' : ''}${dk} vs planned)</span></div>
    <button class="n-act primary n-adjust-log" onclick="nAdjLog('${m.id}')">✓ Log this</button>
  </div>`;
}

async function quickLog(mealId) {
  const m = nFindMeal(mealId);
  const p = N_PENDING[mealId] || 1.0;
  try { await nLogMeal(m, 'as_planned', null, p); delete N_PENDING[mealId]; toast('Logged ✓'); renderToday(); }
  catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}
async function quickSkip(mealId) {
  const m = nFindMeal(mealId);
  try { await nLogMeal(m, 'skipped', null, 1.0); toast('Skipped — back to plan next meal'); renderToday(); }
  catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}
async function pickPortion(mealId, p) {
  const m = nFindMeal(mealId);
  try { await nSetPortion(m, p); renderToday(); }
  catch (e) { toast('Save failed', 3000); }
}
async function reopenMeal(mealId) {
  const m = nFindMeal(mealId);
  const l = NS.logs[m.id];
  if (!l) return;
  const { error } = await ndb.from('meal_logs').delete().eq('id', l.id);
  if (error) { toast('Could not re-open: ' + error.message, 3500); return; }
  delete NS.logs[m.id];
  delete N_OPEN[m.id];
  renderToday();
}

// ══════════════ Meal builder sheet (swap / ate-out / add) ══════════════
// Tap items to add to the basket, set quantities, log once.
// "6 eggs instead of steak & eggs" = Swap → Foods → Egg → qty 6 → Log.

function openNSheet(mode, mealId) {
  const meal = mealId ? nFindMeal(mealId) : null;
  NS.sheet = { mode, meal, basket: [], filter: 'all', mf: 'all' };
  document.getElementById('n-sheet-title').textContent =
    (mode === 'swap' ? 'Swap / adjust meal' : 'Add food') +
    (nViewDate() !== nToday() ? ` — ${nDayName(nViewDate(), true)}` : '');
  document.getElementById('n-sheet-search').value = '';
  document.getElementById('n-custom-desc').value = '';
  document.getElementById('n-custom-kcal').value = '';
  document.getElementById('n-custom-protein').value = '';
  document.getElementById('n-custom-carbs').value = '';
  document.getElementById('n-custom-fat').value = '';
  document.getElementById('n-custom-serving').value = '';
  const srvRow = document.getElementById('n-custom-serving-row');
  if (srvRow) srvRow.style.display = 'none';
  else document.getElementById('n-custom-serving').style.display = 'none';
  document.getElementById('n-custom-save').classList.remove('active');
  const cp = document.getElementById('n-custom-panel');
  if (cp) cp.style.display = 'none';   // custom entry hidden until asked for
  document.getElementById('n-sheet').style.display = 'flex';
  nBackPush('sheet', nSheetHide);
  renderNSheetList();
}
function nSheetHide() {
  document.getElementById('n-sheet').style.display = 'none';
  NS.sheet = null;
}
function closeNSheet() { nSheetHide(); nBackConsume('sheet'); }
function nSetFilter(f) { NS.sheet.filter = f; renderNSheetList(); }

// ── Basket ──
function nBasketAdd(kind, id) {
  const b = NS.sheet.basket;
  const existing = b.find(x => x.srcKind === kind && x.srcId === id);
  if (existing) {
    existing.qty += 1;
    if (existing.srcKind === 'z' && existing.maxPortions) existing.qty = Math.min(existing.qty, existing.maxPortions);
    renderNSheetList(); return;
  }
  let item = null;
  if (kind === 'r') {
    const r = NS.recipes.find(x => x.id === id);
    if (r) item = { srcKind: 'r', srcId: id, kind: 'r', id, name: r.name, qty: 1,
      kcal: r.kcal_per_serving, protein_g: r.protein_g_per_serving,
      carbs_g: r.carbs_g_per_serving, fat_g: r.fat_g_per_serving, unit: 'serving' };
  } else if (kind === 'f') {
    const f = NS.foods.find(x => x.id === id);
    if (f) item = nMakeItem(f, 1);
  } else if (kind === 'z') {
    // Freezer portion: a cooked single-meal container from MY freezer inventory.
    // Logging the basket decrements the count (submitBasket -> nConsumeZ).
    const r = (NS.freezerInventory || []).find(x => x.id === id);
    if (r) item = { srcKind: 'z', srcId: id, kind: 'z', id, name: `🧊 ${r.recipe_name}`,
      qty: 1, kcal: r.kcal || 0, protein_g: r.protein_g || 0,
      carbs_g: r.carbs_g || 0, fat_g: r.fat_g || 0,
      unit: 'portion', maxPortions: r.portions || 1, invRecipeId: r.recipe_id || null };
  }
  if (item) { b.push(item); renderNSheetList(); }
}
function nBasketQty(idx, val) {
  const it = NS.sheet.basket[idx];
  let q = parseFloat(val);
  if (!it || !q || q <= 0) return;
  if (it.ozPer) q = q / it.ozPer;            // box reads ounces -> store servings
  if (it.srcKind === 'z') q = Math.min(Math.max(Math.round(q), 1), it.maxPortions || 1);
  it.qty = q;
  renderNSheetList();
}
function nBasketRemove(idx) { NS.sheet.basket.splice(idx, 1); renderNSheetList(); }
function nBasketTotals() {
  const t = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const it of NS.sheet.basket) {
    t.kcal += it.kcal * it.qty; t.protein_g += it.protein_g * it.qty;
    t.carbs_g += it.carbs_g * it.qty; t.fat_g += it.fat_g * it.qty;
  }
  for (const k of Object.keys(t)) t[k] = Math.round(t[k]);
  return t;
}

// Decrement freezer inventory for any logged freezer portions.
async function nConsumeZ(zItems) {
  for (const it of (zItems || [])) await nInvConsume(it.srcId, Math.round(it.qty));
  if (zItems && zItems.length && typeof nInvPanelHtml === 'function')
    nInfoRefresh('freezer', nInvPanelHtml(true));
}

async function submitBasket() {
  const { mode, meal, basket } = NS.sheet || {};
  if (!basket || !basket.length) return;
  const tot = nBasketTotals();
  const multi = basket.length > 1;
  const first = basket[0];
  const qtyDesc = basket.map(it => it.ozPer
    ? `${Math.round(it.qty * it.ozPer * 10) / 10}oz ${it.name}`
    : `${it.qty}× ${it.name}`).join('; ');
  const src = {
    recipe_id: (!multi && first.kind === 'r') ? first.id
             : (!multi && first.kind === 'z') ? first.invRecipeId : null,
    food_item_id: (!multi && first.kind === 'f') ? first.id : null,
    desc: (multi || first.qty !== 1 || (first.kind === 'z' && !first.invRecipeId)) ? qtyDesc : null,
    kcal: tot.kcal, protein_g: tot.protein_g, carbs_g: tot.carbs_g, fat_g: tot.fat_g,
  };
  const zItems = basket.filter(it => it.srcKind === 'z');
  try {
    const status = basket.every(it => it.rest) ? 'ate_out' : 'swapped';
    if (mode === 'add' || !meal) {
      // Rule 5 — the unique index only covers planned-linked logs, so ad-hoc
      // additions can silently double up. Ask before creating the second one.
      const dup = nmCheckDuplicate(NS.addedLogs, {
        log_date: nViewDate(), meal_slot: 'snack', status: 'added',
        swap_recipe_id: src.recipe_id, swap_food_item_id: src.food_item_id,
        custom_desc: src.desc,
      });
      if (dup) {
        closeNSheet();
        return nConfirmOpen('Log this twice?', `<div>${nEsc(dup.message)}</div>`, [
          { label: 'Yes, I had it again', kind: 'primary',
            run: async () => { await nLogAdded(nViewDate(), src); await nConsumeZ(zItems); toast('Logged ✓'); renderToday(); } },
          { label: 'No — that was a double entry', run: () => renderToday() },
        ]);
      }
      await nLogAdded(nViewDate(), src);
      await nConsumeZ(zItems);
    } else { await nLogMeal(meal, status, src, 1.0); await nConsumeZ(zItems); }
    closeNSheet(); toast('Logged ✓'); renderToday();
  } catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}

// ── Sheet rendering ──
function nOptHtml(kind, id, star, name, sub) {
  return `<button class="n-opt" onclick="nBasketAdd('${kind}','${id}')">
    <div class="n-opt-name">${star ? '★ ' : ''}${nEsc(name)}</div>
    <div class="n-opt-sub">${nEsc(sub)} — tap to add</div></button>`;
}

function renderNSheetList() {
  const q = document.getElementById('n-sheet-search').value.trim().toLowerCase();
  const { mode, meal, filter, basket } = NS.sheet || {};
  const slot = meal?.meal_slot;
  let html = '';

  // Basket panel
  if (basket && basket.length) {
    const tot = nBasketTotals();
    const rows = basket.map((it, i) => `<div class="n-basket-row">
      <span class="n-basket-name">${nEsc(it.name)} <span style="color:var(--n-muted);font-size:11px">${nEsc(nKitchenAmt(it))}</span></span>
      <input type="number" class="n-basket-qty" inputmode="decimal"
        step="${it.srcKind === 'z' ? 1 : it.ozPer ? 0.1 : 0.25}" min="${it.srcKind === 'z' ? 1 : it.ozPer ? 0.1 : 0.25}"
        ${it.srcKind === 'z' && it.maxPortions ? `max="${it.maxPortions}"` : ''}
        value="${it.ozPer ? Math.round(it.qty * it.ozPer * 10) / 10 : it.qty}" onchange="nBasketQty(${i}, this.value)"><span class="n-unit">${it.srcKind === 'z' ? '×' : it.ozPer ? 'oz' : '×'}</span>
      <button class="n-basket-x" onclick="nBasketRemove(${i})">✕</button></div>`).join('');
    let delta = '';
    if (meal) {
      const dk = Math.round(tot.kcal - meal.planned_kcal);
      const dp = Math.round(tot.protein_g - meal.planned_protein_g);
      delta = `<div class="n-basket-delta">${dk >= 0 ? '+' : ''}${dk} kcal · ${dp >= 0 ? '+' : ''}${dp}P vs planned meal</div>`;
    }
    html += `<div class="n-basket">${rows}
      <div class="n-basket-total">Total: ${tot.kcal} kcal · ${tot.protein_g}P · ${tot.carbs_g}C · ${tot.fat_g}F</div>
      ${delta}
      <button class="btn" style="margin-top:8px;width:100%" onclick="submitBasket()">Log ${basket.length > 1 ? basket.length + ' items' : 'it'}</button></div>`;
  }

  // Tweak: start the basket from the planned meal's own ingredients.
  // Works for recipe meals (itemized components) AND single-food meals (the food
  // itself, so quantity is adjustable). Custom meals have nothing to decompose.
  const comps = (mode === 'swap' && meal && meal.recipe_id) ? (NS.components || {})[meal.recipe_id] : null;
  const tweakable = (comps && comps.length) || (mode === 'swap' && meal && meal.food_item_id);
  if (tweakable && (!basket || !basket.length)) {
    html += `<button class="n-opt" style="border-color:#3f6a30" onclick="nTweakSeed()">
      <div class="n-opt-name">🔧 Tweak this meal</div>
      <div class="n-opt-sub">Start from what's planned — change amounts, drop or add items</div></button>`;
  }

  // Filter chips
  const myFrozen = (typeof nInvForAthlete === 'function') ? nInvForAthlete(NS.me.id) : [];
  const filters = [['all', 'All']];
  filters.push(['recipes', 'Recipes'], ['foods', 'Foods'], ['restaurants', 'Restaurants']);
  if (myFrozen.length) filters.push(['freezer', '🧊 Freezer']);
  html += `<div class="n-filter-row">${filters.map(([f, l]) =>
    `<button class="n-chip${filter === f ? ' active' : ''}" onclick="nSetFilter('${f}')">${l}</button>`).join('')}
    <button class="n-chip${NS.sheet && NS.sheet.customOpen ? ' active' : ''}" onclick="nToggleCustomPanel()">＋ Custom</button></div>`;

  const show = s => filter === 'all' || filter === s;

  // 🧊 My freezer portions — ready to eat; logging one decrements the inventory
  if (myFrozen.length && show('freezer')) {
    const rows = myFrozen.filter(r => !q || (r.recipe_name || '').toLowerCase().includes(q));
    if (rows.length) html += `<div class="n-sheet-section">🧊 My freezer — ready to eat</div>`;
    for (const r of rows)
      html += `<button class="n-opt" onclick="nBasketAdd('z','${r.id}')">
        <div class="n-opt-name">🧊 ${nEsc(r.recipe_name)}</div>
        <div class="n-opt-sub">${r.portions} in freezer${r.kcal != null ? ` · ${Math.round(r.kcal)} kcal · ${Math.round(r.protein_g || 0)}P per portion` : ''} — tap to add</div></button>`;
  }

  // Recipes
  if (show('recipes')) {
    const recs = NS.recipes.filter(r =>
      q ? r.name.toLowerCase().includes(q)
        : (filter === 'recipes' || !slot || (r.best_meal_slots || []).includes(slot)));
    if (recs.length) html += `<div class="n-sheet-section">Recipes</div>`;
    for (const r of recs.slice(0, 40))
      html += nOptHtml('r', r.id, false, r.name,
        `${Math.round(r.kcal_per_serving)} kcal · ${Math.round(r.protein_g_per_serving)}P per serving`);
  }

  // Foods (raw ingredients / packaged / simple meals)
  if (show('foods')) {
    let fds = NS.foods.filter(f => f.item_type !== 'restaurant' &&
      (q ? f.name.toLowerCase().includes(q)
         : (filter === 'foods' || !slot || (f.default_meal_slots || []).includes(slot))));
    if (filter === 'foods') {
      const mf = NS.sheet.mf || 'all';
      html += `<div class="n-filter-row" style="margin:2px 0 6px">${[['all', 'All'], ['protein', '🥩 Protein'], ['carbs', '🍚 Carbs'], ['fats', '🥑 Fats']].map(([f2, l]) =>
        `<button class="n-chip${mf === f2 ? ' active' : ''}" onclick="NS.sheet.mf='${f2}';renderNSheetList()">${l}</button>`).join('')}</div>`;
      if (mf !== 'all') fds = fds.filter(f => nMacroClass(f) === mf);
    }
    if (fds.length) html += `<div class="n-sheet-section">Foods & ingredients</div>`;
    for (const f of fds.slice(0, 50)) {
      const oz = nOzPerServing(f);
      // Cooked-basis foods say so right where the amount is shown, so "6 oz" is never
      // mistaken for 6 oz raw (Troy, 2026-09-12).
      const bw = (typeof nBasisWord === 'function') ? nBasisWord(f) : '';
      const per = (oz && !/^\d+(?:\.\d+)?\s*oz\b/i.test(String(f.serving_desc || '')))
        ? `${oz} oz${bw ? ' ' + bw : ''} (${f.serving_desc})`
        : `${f.serving_desc}${bw ? ' ' + bw : ''}`;
      html += nOptHtml('f', f.id, false, f.name,
        `${Math.round(f.kcal)} kcal · ${Math.round(f.protein_g)}P per ${per}` +
        (f.approval_status === 'pending' ? ' · ⏳ pending review' : ''));
    }
  }

  // Restaurants, grouped
  if (show('restaurants')) {
    const rests = NS.foods.filter(f => f.item_type === 'restaurant' &&
      (!q || f.name.toLowerCase().includes(q) || (f.restaurant_name || '').toLowerCase().includes(q)));
    const groups = {};
    for (const f of rests) (groups[f.restaurant_name || 'Restaurants'] ||= []).push(f);
    for (const [rn, items] of Object.entries(groups)) {
      html += `<div class="n-sheet-section">🍴 ${nEsc(rn)}</div>`;
      for (const f of items)
        html += nOptHtml('f', f.id, (f.tags || []).includes('recommended'), f.name,
          `${Math.round(f.kcal)} kcal · ${Math.round(f.protein_g)}P — ${f.serving_desc}`);
    }
  }

  if (!html) {
    html = '<div class="n-opt-sub" style="padding:12px">No matches.</div>';
    if (q) html += `<button class="n-opt" onclick="nCustomFromSearch()">
      <div class="n-opt-name">＋ Add it as a custom food</div>
      <div class="n-opt-sub">Not in the database — enter it once, optionally save for reuse</div></button>`;
  }
  document.getElementById('n-sheet-list').innerHTML = html;
}

// ── Custom-food panel show/hide (hidden by default — it's the rare path) ──
function nToggleCustomPanel() {
  const open = !(NS.sheet && NS.sheet.customOpen);
  if (NS.sheet) NS.sheet.customOpen = open;
  const cp = document.getElementById('n-custom-panel');
  if (cp) cp.style.display = open ? 'block' : 'none';
  renderNSheetList();
  if (open) document.getElementById('n-custom-desc').focus();
}
function nCustomFromSearch() {
  const q = document.getElementById('n-sheet-search').value.trim();
  if (!(NS.sheet && NS.sheet.customOpen)) nToggleCustomPanel();
  const inp = document.getElementById('n-custom-desc');
  if (q && !inp.value) inp.value = q;
  inp.focus();
}

function toggleCustomSave() {
  const btn = document.getElementById('n-custom-save');
  const on = btn.classList.toggle('active');
  // Defensive: works with either markup version (wrapper row or bare input)
  const row = document.getElementById('n-custom-serving-row');
  const inp = document.getElementById('n-custom-serving');
  if (row) row.style.display = on ? 'block' : 'none';
  else if (inp) inp.style.display = on ? 'block' : 'none';
  if (on && inp) inp.focus();
}

async function submitCustomFood() {
  const desc = document.getElementById('n-custom-desc').value.trim();
  if (!desc) { toast('Name what you ate'); return; }
  const kcal = parseFloat(document.getElementById('n-custom-kcal').value) || null;
  const protein = parseFloat(document.getElementById('n-custom-protein').value) || null;
  const carbs = parseFloat(document.getElementById('n-custom-carbs').value) || null;
  const fat = parseFloat(document.getElementById('n-custom-fat').value) || null;
  const saveIt = document.getElementById('n-custom-save').classList.contains('active');
  const { mode, meal } = NS.sheet || {};

  let src = { desc, kcal, protein_g: protein, carbs_g: carbs, fat_g: fat };

  // Save-for-reuse path: becomes a real, searchable food_item (tagged user_added;
  // the coach reviews these weekly and promotes keepers into the curated library)
  if (saveIt) {
    const serving = document.getElementById('n-custom-serving').value.trim();
    if (!serving || kcal == null || protein == null) {
      toast('Saving for reuse needs serving + kcal + protein'); return;
    }
    const { data: nf, error } = await ndb.from('food_items').insert({
      name: desc, serving_desc: serving, item_type: 'packaged',
      kcal, protein_g: protein, carbs_g: carbs ?? 0, fat_g: fat ?? 0,
      tags: ['user_added'], default_meal_slots: ['snack'],
      approval_status: 'pending',
    }).select().single();
    if (error) {
      toast(error.code === '23505' ? 'That name already exists — search for it instead' : 'Save failed: ' + error.message, 4000);
      return;
    }
    NS.foods.push(nf);
    src = { food_item_id: nf.id, kcal, protein_g: protein, carbs_g: carbs ?? 0, fat_g: fat ?? 0 };
  }

  try {
    if (mode === 'add' || !meal) await nLogAdded(nViewDate(), src);
    else await nLogMeal(meal, 'swapped', kcal != null ? src : { ...src, kcal: null }, 1.0);
    closeNSheet();
    toast(saveIt ? 'Saved to your foods + logged ✓' : (kcal != null ? 'Logged ✓' : 'Logged (unquantified) — day totals show ~'), 3000);
    renderToday();
  } catch (e) { if (e.message !== 'offline') toast('Save failed: ' + e.message, 4000); }
}

// ── Activity (steps + non-system workouts + synced strength-app sessions) ──
// Stored in body_metrics: metric 'steps' (value = count) and 'workout_min'
// (value = minutes, notes = type). Context for TDEE — NOT added to it
// (the scale-based TDEE already contains all activity; adding would double-count).
// kcal labels are the N09 §3.13 estimate (net, above resting) from n-metrics.js —
// the same numbers the Trends Activity card sums.
const N_WORKOUT_TYPES = Object.keys(NM_ACT_MANUAL_TYPES);     // Lift, WOD/HIIT, Cardio, Other
function nBw() { return NS.lastWeight || NS.metricsToday.weight || 165; }
function nActKcal(o) {
  return Math.round(nmActivityItems({ stepsMode: nStepsMode(), weightLb: nBw(), ...o })
    .reduce((a, it) => a + it.kcal, 0));
}
function nStepsKcal(steps) { return nActKcal({ manual: [{ log_date: 'x', metric: 'steps', value: steps }] }); }
function nWorkoutKcal(min, type) { return nActKcal({ manual: [{ log_date: 'x', metric: 'workout_min', value: min, notes: type }] }); }
// Read-only rows for what synced from the strength app on day d.
function nSyncedRowsHtml(d) {
  const S = NS.syncedAct || { sessions: [], conditioning: [] };
  const items = nmActivityItems({ weightLb: nBw(),
    sessions: S.sessions.filter(s => s.session_date === d),
    conditioning: S.conditioning.filter(c => c.conditioning_date === d) });
  if (!items.length)
    return `<div style="font-size:12px;color:var(--n-muted);margin-bottom:8px">No strength-app session synced for this day yet.</div>`;
  return items.map(it => `<div class="n-meal done compact" style="margin-bottom:6px;cursor:default">
      <div class="n-done-row"><span class="n-done-check">⇄</span>
        <span class="n-done-name">${nActItemIcon(it)}
          ${nEsc(it.label)} · ${Math.round(it.minutes)} min <span style="font-size:10px;color:var(--n-muted)">synced</span></span>
        <span class="n-done-kcal">~${Math.round(it.kcal)} kcal</span></div></div>`).join('');
}

// Collapsed/logged rows reuse the .n-meal.done.compact treatment (green left
// border, checkmark) from meal cards. Tap a logged row to re-expand it for editing;
// N_OPEN keys 'act-steps' / 'act-workout' track that, same mechanism as nToggleCard.
// Activity values for a date: today reads the live today-state, past days read
// NS.actBack (loaded for the back-log window in nLoadAll).
function nActFor(d) {
  if (d === nToday()) return {
    steps: NS.metricsToday.steps, wMin: NS.metricsToday.workout_min,
    wType: (NS.metricsTodayNotes || {}).workout_min || '', sleep: NS.sleepToday,
    strength: NS.hasStrengthSessionToday };
  const a = (NS.actBack || {})[d] || {};
  return { steps: a.steps, wMin: a.workout_min, wType: a.workout_type || '', sleep: a.sleep, strength: !!a.strength };
}
function nActSet(d, fields) {
  if (d === nToday()) {
    if ('steps' in fields) NS.metricsToday.steps = fields.steps;
    if ('wMin' in fields) { NS.metricsToday.workout_min = fields.wMin; (NS.metricsTodayNotes ||= {}).workout_min = fields.wType; }
    if ('sleep' in fields) NS.sleepToday = fields.sleep;
    return;
  }
  const a = ((NS.actBack ||= {})[d] ||= {});
  if ('steps' in fields) a.steps = fields.steps;
  if ('wMin' in fields) { a.workout_min = fields.wMin; a.workout_type = fields.wType; }
  if ('sleep' in fields) a.sleep = fields.sleep;
}

function nActivityCardHtml() {
  const d = nViewDate();
  const isBack = d !== nToday();
  const { steps, wMin, wType, sleep } = nActFor(d);
  const kS = 'act-steps-' + d, kW = 'act-workout-' + d;
  const extra = nStepsMode() === 'extra';
  const hint = NS.me.training_active
    ? 'Sessions from the strength app sync automatically (⇄ rows, lifting counted as 60 min). Log steps outside those workouts, and only extra activity below.'
    : 'Log total steps for the day and your workouts so they show in your trends.';
  const stepWord = extra ? 'steps outside workouts' : 'steps';

  const stepsRow = (steps != null && !N_OPEN[kS])
    ? `<div class="n-meal done compact" style="margin-bottom:8px" onclick="nToggleCard('${kS}')">
        <div class="n-done-row"><span class="n-done-check">✓</span>
          <span class="n-done-name">👟 ${Number(steps).toLocaleString()} ${stepWord} logged</span>
          <span class="n-done-kcal">~${nStepsKcal(steps)} kcal</span></div></div>`
    : `<div class="n-prompt-row" style="margin-bottom:8px">
        <input type="number" inputmode="numeric" id="na-steps" placeholder="${extra ? 'steps outside logged workouts' : 'total steps today'}" value="${steps ?? ''}">
        <button class="n-act small primary" onclick="submitSteps()">Save steps</button></div>`;

  const workoutRow = (wMin != null && !N_OPEN[kW])
    ? `<div class="n-meal done compact" onclick="nToggleCard('${kW}')">
        <div class="n-done-row"><span class="n-done-check">✓</span>
          <span class="n-done-name">💪 ${wMin} min ${nEsc(wType)} logged</span>
          <span class="n-done-kcal">~${nWorkoutKcal(wMin, wType)} kcal</span></div></div>`
    : `<div class="n-prompt-row">
        <input type="number" inputmode="numeric" id="na-wmin" placeholder="min" style="width:64px" value="${wMin ?? ''}">
        ${N_WORKOUT_TYPES.map(k =>
          `<button class="n-chip${wType === k ? ' active' : ''}" onclick="submitWorkout('${k}')">${k}</button>`).join('')}
      </div>`;

  return `<div class="n-panel" style="margin-top:14px"><div class="n-panel-title">⚡ Activity ${isBack ? '— ' + nDayName(d, true) : 'today'}</div>
    ${!NS.me.training_active ? `<div class="n-prompt-row" style="margin-bottom:8px">
      <input type="number" step="0.5" inputmode="decimal" id="na-sleep" placeholder="sleep ${isBack ? 'the night before' : 'last night'} (hrs)" value="${sleep ?? ''}">
      <button class="n-act small primary" onclick="submitSleep()">Save sleep</button></div>` : ''}
    ${NS.me.training_active ? nSyncedRowsHtml(d) : ''}
    ${stepsRow}
    ${workoutRow}
    <div style="font-size:11px;color:var(--n-muted);margin-top:6px">${hint} kcal are rough estimates of burn above resting — they inform trends, never your calorie target.</div></div>`;
}
async function submitSteps() {
  const v = parseInt(document.getElementById('na-steps').value, 10);
  if (!v || v < 0 || v > 100000) { toast('Enter the step count'); return; }
  // Rule 14 — soft confirm only. Steps are context, never in the TDEE, so a wrong
  // value costs nothing but a confusing chart; one tap is the right amount of friction.
  const hit = nmCheckActivity({ kind: 'steps', value: v, mean28: NS.steps28Mean });
  if (hit) {
    return nConfirmOpen('That\'s a big step day', `<div>${nEsc(hit.message)}</div>`, [
      { label: 'Yes, keep it', kind: 'primary', run: () => nSaveSteps(v) },
      { label: 'Cancel — let me fix it', run: null },
    ]);
  }
  return nSaveSteps(v);
}
async function nSaveSteps(v) {
  const d = nViewDate();
  if (d === nToday()) {
    if (!(await nSaveMetric('steps', v, 'steps'))) return;
  } else {
    if (nOffline) { toast('Offline — reconnect to log.', 3000); return; }
    const { error } = await ndb.from('body_metrics').upsert({
      athlete_id: NS.me.id, log_date: d, metric: 'steps', value: v, unit: 'steps',
      flag: null, flag_reason: null,
    }, { onConflict: 'athlete_id,log_date,metric' });
    if (error) { toast('Save failed: ' + error.message, 4000); return; }
    nActSet(d, { steps: v });
  }
  N_OPEN['act-steps-' + d] = false; toast('Steps saved ✓'); renderToday();
}
async function submitWorkout(type) {
  const min = parseInt(document.getElementById('na-wmin').value, 10);
  if (!min || min <= 0 || min > 600) { toast('Enter workout minutes first'); return; }
  if (nOffline) { toast('Offline — reconnect to log.', 3000); return; }
  // Rule 14 — a manual workout on a day whose gym session already synced.
  const d = nViewDate();
  const hit = nmCheckActivity({ kind: 'workout', hasStrengthSession: nActFor(d).strength });
  if (hit) {
    return nConfirmOpen(d === nToday() ? 'Already have today\'s session' : 'Already have a session that day',
      `<div>${nEsc(d === nToday() ? hit.message : hit.message.replace('for today', 'for that day'))}</div>`, [
      { label: 'This was extra — log it', kind: 'primary', run: () => nWriteWorkout(type, min) },
      { label: 'Cancel', run: null },
    ]);
  }
  return nWriteWorkout(type, min);
}
async function nWriteWorkout(type, min) {
  const d = nViewDate();
  const { error } = await ndb.from('body_metrics').upsert({
    athlete_id: NS.me.id, log_date: d, metric: 'workout_min',
    value: min, unit: 'min', notes: type,
  }, { onConflict: 'athlete_id,log_date,metric' });
  if (error) { toast('Save failed: ' + error.message, 4000); return; }
  nActSet(d, { wMin: min, wType: type });
  N_OPEN['act-workout-' + d] = false;
  toast(`${type} logged ✓`);
  renderToday();
}

async function submitSleep() {
  const v = parseFloat(document.getElementById('na-sleep').value);
  if (!v || v < 1 || v > 14) { toast('Enter hours slept (1–14)'); return; }
  if (nOffline) { toast('Offline — reconnect to log.', 3000); return; }
  const d = nViewDate();
  const { error } = await ndb.from('readiness_logs').upsert({
    athlete_id: NS.me.id, log_date: d, sleep_hours: v,
  }, { onConflict: 'athlete_id,log_date' });
  if (error) { toast('Save failed: ' + error.message, 4000); return; }
  nActSet(d, { sleep: v });
  toast('Sleep saved ✓');
  renderToday();
}

// ── Tweak + macro classification helpers ──
function nTweakSeed() {
  const { meal } = NS.sheet || {};
  if (!meal) return;
  NS.sheet.basket = [];
  const comps = meal.recipe_id ? (NS.components || {})[meal.recipe_id] : null;
  if (comps && comps.length) {
    for (const c of comps) {
      const f = NS.foods.find(x => x.id === c.food_item_id);
      if (!f) continue;
      NS.sheet.basket.push(nMakeItem(f, Math.round(c.qty * (meal.planned_servings || 1) * 100) / 100));
    }
  } else if (meal.food_item_id) {
    const f = NS.foods.find(x => x.id === meal.food_item_id);
    if (f) NS.sheet.basket.push(nMakeItem(f, meal.planned_servings || 1));
  }
  renderNSheetList();
}
// Dominant calorie source: protein / carbs / fats (computed, nothing to maintain)
function nMacroClass(f) {
  const pk = 4 * (f.protein_g || 0), ck = 4 * (f.carbs_g || 0), fk = 9 * (f.fat_g || 0);
  if (pk >= ck && pk >= fk) return 'protein';
  if (ck >= fk) return 'carbs';
  return 'fats';
}
