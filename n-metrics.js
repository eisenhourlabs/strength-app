// ══════════════ Kardia Nutrition — metric engine (N09, calc_version 1) ══════════════
// Pure functions implementing 08_Nutrition/N09_Metric_Definitions.md §3 and §4.
// NO DOM, NO Supabase, NO globals beyond the exports at the bottom — this file is
// loaded by the app AND required by node for the golden-file calc tests, and it is
// mirrored formula-for-formula by 05_Scripts/nutrition_metrics.py (the coach side).
// If you change a formula here, change it there, bump NM_CALC_VERSION, and update N09.

const NM_CALC_VERSION = 1;
const NM_ALPHA = 0.25;               // N09 §3.1
const NM_TREND_MIN_POINTS = 5;       // display gate
const NM_TREND_MIN_SPAN_DAYS = 14;   // display gate
const NM_TREND_GAP_RESTART_DAYS = 14;
const NM_ON_PACE_BAND = 0.40;        // N09 §3.2 / N02 §3
const NM_PROTEIN_TOLERANCE_G = 5;    // N09 §3.4

// ── date helpers (local noon parsing — never toISOString; see n-core.js) ──
function nmDate(s) { return new Date(s + 'T12:00:00'); }
function nmDayDiff(a, b) { return Math.round((nmDate(a) - nmDate(b)) / 86400000); }
function nmYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nmAddDays(s, n) { const d = nmDate(s); d.setDate(d.getDate() + n); return nmYMD(d); }
// Nutrition week anchor = most recent Wednesday on/before s (N09 §1).
function nmWeekOf(s) { const d = nmDate(s); d.setDate(d.getDate() - ((d.getDay() + 4) % 7)); return nmYMD(d); }

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 Trend weight (EWMA)
// rows: [{log_date, value, flag}] in any order. Returns points in date order.
// `excluded` and `suspect` rows are SKIPPED entirely (N09 §3.1) — not substituted.
// ─────────────────────────────────────────────────────────────────────────────
function nmTrendWeight(rows) {
  const admissible = (rows || [])
    .filter(r => r && r.value != null && r.flag !== 'excluded' && r.flag !== 'suspect')
    .map(r => ({ date: r.log_date, raw: parseFloat(r.value) }))
    .filter(r => !isNaN(r.raw))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const points = [];
  let trend = null, prevDate = null, segStart = null;
  const restarts = [];
  for (const p of admissible) {
    let restarted = false;
    if (trend === null) {
      trend = p.raw; segStart = p.date;
    } else if (nmDayDiff(p.date, prevDate) > NM_TREND_GAP_RESTART_DAYS) {
      trend = p.raw; segStart = p.date; restarted = true;
      restarts.push(p.date);
    } else {
      trend = trend + NM_ALPHA * (p.raw - trend);
    }
    prevDate = p.date;
    points.push({ date: p.date, raw: p.raw, trend: trend, segStart: segStart, restarted });
  }

  // Display gate applies to the CURRENT segment (after a >14d gap the trend is
  // re-establishing and must earn the gate again).
  const seg = points.filter(p => p.segStart === segStart);
  const span = seg.length ? nmDayDiff(seg[seg.length - 1].date, seg[0].date) : 0;
  const enough = seg.length >= NM_TREND_MIN_POINTS && span >= NM_TREND_MIN_SPAN_DAYS;
  let reason = null;
  if (!enough) {
    const need = Math.max(0, NM_TREND_MIN_POINTS - seg.length);
    reason = need > 0
      ? `${need} more weigh-in${need !== 1 ? 's' : ''} until your trend appears`
      : `${NM_TREND_MIN_SPAN_DAYS - span} more day${NM_TREND_MIN_SPAN_DAYS - span !== 1 ? 's' : ''} until your trend appears`;
  }
  return {
    points,
    segment: seg,
    current: enough && seg.length ? seg[seg.length - 1].trend : null,
    displayable: enough,
    reason,
    reEstablishing: restarts.length > 0 && !enough,
    restarts,
    nAdmissible: admissible.length,
    nSkipped: (rows || []).length - admissible.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.2 Weight-change rate — least-squares slope of the TREND over a trailing
// window, in lb/week. windowDays: 14 (Troy) / 21 (Amanda).
// ─────────────────────────────────────────────────────────────────────────────
function nmTrendRate(trendResult, windowDays, asOf) {
  const seg = (trendResult && trendResult.segment) || [];
  if (!trendResult || !trendResult.displayable || seg.length < 2) return null;
  const end = asOf || seg[seg.length - 1].date;
  const start = nmAddDays(end, -windowDays);
  const win = seg.filter(p => p.date >= start && p.date <= end);
  if (win.length < 2) return null;
  const x0 = win[0].date;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of win) {
    const x = nmDayDiff(p.date, x0), y = p.trend;
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slopePerDay = (n * sxy - sx * sy) / denom;
  return Math.round(slopePerDay * 7 * 100) / 100;   // lb/wk, 2dp internally
}

// "On pace" = within ±40% of the phase rate goal (N09 §3.2). goalRate is the
// magnitude of intended change per week; sign is taken from the phase direction.
function nmPaceVerdict(rate, goalRate, phaseType) {
  if (rate == null) return { status: 'unknown', reason: 'no trend yet' };
  if (phaseType === 'maintenance' || phaseType === 'diet_break') {
    return { status: Math.abs(rate) <= 0.3 ? 'on' : 'off', holding: true };
  }
  if (!goalRate) return { status: 'unknown', reason: 'no rate goal on phase' };
  const dir = (phaseType === 'fat_loss') ? -1 : 1;
  const goal = dir * Math.abs(goalRate);
  const lo = goal * (1 - NM_ON_PACE_BAND), hi = goal * (1 + NM_ON_PACE_BAND);
  const min = Math.min(lo, hi), max = Math.max(lo, hi);
  if (rate >= min && rate <= max) return { status: 'on', goal };
  // "ahead" = more change than intended in the intended direction
  const ahead = dir < 0 ? rate < min : rate > max;
  return { status: ahead ? 'ahead' : 'behind', goal };
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.6 Logging completeness — per-day tier.
// day: {meals_planned, meals_logged, has_null_kcal}
// ─────────────────────────────────────────────────────────────────────────────
function nmDayTier(day) {
  if (!day || !day.meals_planned) {
    return (day && day.meals_logged) ? 'partial' : 'none';
  }
  const logged = day.meals_logged || 0;
  if (!logged) return 'none';
  if (logged >= day.meals_planned && !day.has_null_kcal) return 'full';
  const share = logged / day.meals_planned;
  if (share >= 0.75) return 'mostly';
  return 'partial';
}
function nmInterpretable(tier) { return tier === 'full' || tier === 'mostly'; }

// Weekly tier = share of full+mostly days, shaded by the check-in honesty answer.
function nmWeeklyLogging(days, unloggedEating) {
  const tiers = (days || []).map(nmDayTier);
  const withData = tiers.filter(t => t !== 'none').length;
  const good = tiers.filter(nmInterpretable).length;
  const share = tiers.length ? good / tiers.length : 0;
  let tier = 'none';
  if (share >= 0.85) tier = 'full';
  else if (share >= 0.6) tier = 'mostly';
  else if (withData) tier = 'partial';
  let intakeAdjust = 0, interpretable = true, note = null;
  if (unloggedEating === 'some') {
    intakeAdjust = 150;
    note = 'check-in reported some unlogged eating — read intake ~100–200 kcal/day higher';
  } else if (unloggedEating === 'lots') {
    interpretable = false;
    note = 'check-in reported a lot of unlogged eating — week is uninterpretable for calorie decisions';
  }
  return { tier, share, goodDays: good, totalDays: tiers.length, intakeAdjust, interpretable, note, tiers };
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.3 Calorie adherence — interpretable days only; unlogged days are EXCLUDED,
// never counted as zero.
// ─────────────────────────────────────────────────────────────────────────────
function nmCalorieAdherence(days, target) {
  const good = (days || []).filter(d => nmInterpretable(nmDayTier(d)) && d.actual_kcal != null);
  if (!good.length || !target) return { status: 'unknown', avg: null, days: 0, reason: 'no interpretable days' };
  const avg = good.reduce((a, d) => a + d.actual_kcal, 0) / good.length;
  const off = Math.abs(avg - target) / target;
  const status = off <= 0.05 ? 'on target' : off <= 0.10 ? 'close' : 'off';
  return { status, avg: Math.round(avg), target, offPct: Math.round(off * 1000) / 10, days: good.length };
}

// §3.4 Protein floor hit-rate over interpretable days.
function nmProteinHitRate(days, proteinLow) {
  const good = (days || []).filter(d => nmInterpretable(nmDayTier(d)) && d.actual_protein_g != null);
  if (!good.length || proteinLow == null) return { hit: 0, total: 0, avg: null };
  const floor = proteinLow - NM_PROTEIN_TOLERANCE_G;
  const hit = good.filter(d => d.actual_protein_g >= floor).length;
  const avg = good.reduce((a, d) => a + d.actual_protein_g, 0) / good.length;
  return { hit, total: good.length, avg: Math.round(avg), floor };
}

// §3.5 Food-program adherence. Swaps count as compliant; `added` is neutral.
function nmCompliance(counts) {
  const planned = (counts && counts.meals_planned) || 0;
  if (!planned) return null;
  const ok = ((counts.as_planned || 0) + (counts.swapped || 0));
  return Math.round(100 * ok / planned);
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.10 Confidence level
// ─────────────────────────────────────────────────────────────────────────────
function nmConfidence(o) {
  const weighIns = (o && o.weighInsThisWeek) || 0;
  const tier = (o && o.loggingTier) || 'none';
  const unlogged = o && o.unloggedEating;
  const flagged = (o && o.flaggedCount) || 0;
  if (unlogged === 'lots' || weighIns < 2 || tier === 'none' || tier === 'partial')
    return { level: 'low', reason: unlogged === 'lots' ? 'a lot of unlogged eating reported'
      : weighIns < 2 ? (weighIns === 0 ? 'no recent weigh-ins' : 'only 1 recent weigh-in')
      : 'logging below the interpretable threshold' };
  if (tier === 'mostly' || unlogged === 'some' || flagged > 0 || weighIns < 3)
    return { level: 'medium', reason: flagged > 0 ? 'flagged data point in the window'
      : unlogged === 'some' ? 'some unlogged eating reported'
      : tier === 'mostly' ? 'partial logging on some days' : 'fewer weigh-ins than usual' };
  return { level: 'high', reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.11 Plateau — ALL four conditions required.
// ─────────────────────────────────────────────────────────────────────────────
function nmPlateau(o) {
  if (!o) return false;
  return !!(o.phaseType === 'fat_loss' &&
    o.rate != null && Math.abs(o.rate) <= 0.15 &&
    o.flatDays >= 21 &&
    o.compliancePct >= 85 &&
    nmInterpretable(o.loggingTier));
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 Abnormality detection — ENTRY-TIME rules only (1–5, 14). Everything else is
// passive and lives in the pull. These return null when nothing fires.
// ─────────────────────────────────────────────────────────────────────────────

// Rules 1 + 2 — weight. Rule 2 (unit/typo) is checked first: it is the more
// specific diagnosis and carries a pre-filled suggestion.
function nmCheckWeight(value, trendWeight) {
  if (value == null || trendWeight == null) return null;
  const v = parseFloat(value);
  if (isNaN(v)) return null;
  const ratio = v / trendWeight;
  if (ratio < 0.6 || ratio > 1.4) {
    return {
      rule: 2, key: 'rule2_unit_typo', severity: 'high',
      delta: v - trendWeight,
      suggested: nmSuggestTypoFix(v, trendWeight),
      message: `${v.toFixed(1)} lb is a long way from your trend of ${trendWeight.toFixed(1)} lb.`,
    };
  }
  const deviation = Math.abs(v - trendWeight) / trendWeight;
  if (deviation > 0.03) {
    // N09's rule-2 band (<0.6x / >1.4x) does not cover every transposition —
    // 129 for 192 is 0.67x and lands here. Thresholds stay exactly as N09 froze
    // them; we just offer the same "or fix?" suggestion when one is plausible.
    return {
      rule: 1, key: 'rule1_trend_deviation', severity: 'high',
      delta: v - trendWeight, suggested: nmSuggestTypoFix(v, trendWeight),
      message: `That's ${Math.abs(v - trendWeight).toFixed(1)} lb from your trend of ${trendWeight.toFixed(1)} lb.`,
    };
  }
  return null;
}

// Best-guess intended value for a mistyped weight: a dropped/transposed digit
// (129 for 192) or a kg entry. Returns null when no candidate is close.
function nmSuggestTypoFix(v, trend) {
  const cands = [];
  cands.push({ v: v * 2.20462, why: 'kg entered instead of lb' });
  const s = String(Math.round(v));
  for (let i = 0; i < s.length - 1; i++) {          // digit transpositions
    const a = s.split('');
    [a[i], a[i + 1]] = [a[i + 1], a[i]];
    cands.push({ v: parseFloat(a.join('')), why: 'transposed digits' });
  }
  const near = cands.filter(c => c.v > 0 && Math.abs(c.v - trend) / trend <= 0.05);
  if (!near.length) return null;
  near.sort((a, b) => Math.abs(a.v - trend) - Math.abs(b.v - trend));
  return { value: Math.round(near[0].v * 10) / 10, why: near[0].why };
}

// Rule 3 — waist/hips jump >1.5 in vs previous.
function nmCheckTape(value, prevValue) {
  if (value == null || prevValue == null) return null;
  const d = Math.abs(parseFloat(value) - parseFloat(prevValue));
  if (d <= 1.5) return null;
  return {
    rule: 3, key: 'rule3_tape_jump', severity: 'med', delta: parseFloat(value) - parseFloat(prevValue),
    message: `That's ${d.toFixed(1)} in from your last measurement — worth re-measuring to confirm.`,
  };
}

// Rule 4 — caliper mm-sum >15% vs previous.
function nmCheckCaliper(sumNew, sumPrev) {
  if (!sumNew || !sumPrev) return null;
  const pct = Math.abs(sumNew - sumPrev) / sumPrev;
  if (pct <= 0.15) return null;
  return {
    rule: 4, key: 'rule4_caliper_jump', severity: 'med', delta: sumNew - sumPrev,
    message: `Your mm-sum moved ${Math.round(pct * 100)}% (${sumPrev} → ${sumNew} mm). Re-pinch each site to confirm — same fold, same side, 2 passes.`,
  };
}

// Rule 5 — duplicate `added` log in the same day+slot.
function nmCheckDuplicate(existingLogs, candidate) {
  if (!candidate || !existingLogs) return null;
  const dup = existingLogs.find(l =>
    l.status === 'added' && l.log_date === candidate.log_date &&
    l.meal_slot === candidate.meal_slot &&
    ((l.swap_recipe_id && l.swap_recipe_id === candidate.swap_recipe_id) ||
     (l.swap_food_item_id && l.swap_food_item_id === candidate.swap_food_item_id) ||
     (l.custom_desc && l.custom_desc === candidate.custom_desc)));
  if (!dup) return null;
  return { rule: 5, key: 'rule5_duplicate', severity: 'low', existing: dup,
    message: 'You already logged this today. Add it again, or was that a double entry?' };
}

// Rule 14 — duplicated activity: steps >2× the 28-day mean, or a manual workout
// logged on a day that already has a completed strength session.
function nmCheckActivity(o) {
  if (!o) return null;
  if (o.kind === 'steps' && o.mean28 && o.value > 2 * o.mean28) {
    return { rule: 14, key: 'rule14_activity_spike', severity: 'low',
      message: `${Number(o.value).toLocaleString()} steps is more than double your usual ${Math.round(o.mean28).toLocaleString()}. Keep it?` };
  }
  if (o.kind === 'workout' && o.hasStrengthSession) {
    return { rule: 14, key: 'rule14_duplicate_workout', severity: 'low',
      message: 'Your gym session for today already synced from the strength app. Log this only if it was extra activity on top of that.' };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.8 Goal progress (Phase 1: progress only — no ETA; that lands in Phase 2)
// ─────────────────────────────────────────────────────────────────────────────
function nmGoalProgress(o) {
  if (!o || o.trendWeight == null || o.goalLow == null || o.goalHigh == null) return null;
  const mid = (o.goalLow + o.goalHigh) / 2;
  const start = o.startWeight;
  const inRange = o.trendWeight >= o.goalLow && o.trendWeight <= o.goalHigh;
  const toGo = inRange ? 0 : (o.trendWeight > o.goalHigh ? o.trendWeight - o.goalHigh : o.goalLow - o.trendWeight);
  let done = null, total = null, pct = null;
  if (start != null && Math.abs(start - mid) > 0.5) {
    total = Math.abs(start - mid);
    done = Math.max(0, Math.min(total, total - Math.abs(o.trendWeight - mid)));
    pct = Math.round(100 * done / total);
  }
  return { mid, inRange, toGo: Math.round(toGo * 10) / 10,
    done: done == null ? null : Math.round(done * 10) / 10,
    total: total == null ? null : Math.round(total * 10) / 10, pct };
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.7 TDEE (maintenance estimate)
//
// TDEE = mean(intake over interpretable days) − 3500 × Δtrend_weight / days
//
// "days" is the span the weigh-ins actually cover inside the window, not a
// nominal 28 — dividing a 12-day Δtrend by 28 would understate the rate and
// quietly bias the estimate toward intake. Gates are N09's, unchanged.
// Activity is NEVER added here: it is already inside the scale-based Δtrend,
// and adding it would double-count (N09 §3.7, spec §9 rejected list).
// ─────────────────────────────────────────────────────────────────────────────
const NM_TDEE_WINDOW_DAYS = 28;
const NM_TDEE_MIN_DAYS = 14;        // interpretable days in the window
const NM_TDEE_MIN_WEIGH_INS = 6;    // admissible weigh-ins spanning the window
const NM_TDEE_MAX_STEP_KCAL = 100;  // §3.7 update cap / §4 rule 13
const NM_KCAL_PER_LB = 3500;

function nmPlural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

// A day feeds TDEE only if it is interpretable AND carries a complete kcal
// figure. N09 §4 rule 9: a day with a null-kcal log is excluded from TDEE and
// calorie averages even though its logging tier may still read full/mostly.
function nmTdeeDayEligible(d) {
  return !!d && d.actual_kcal != null && !d.has_null_kcal && nmInterpretable(nmDayTier(d));
}

function nmTdeeBand(confidence) { return confidence === 'high' ? 100 : 200; }

function nmTdee(o) {
  o = o || {};
  const end = o.asOf;
  if (!end) return { sufficient: false, reason: 'no window end date' };
  const start = nmAddDays(end, -(NM_TDEE_WINDOW_DAYS - 1));
  const conf = o.confidence || 'high';

  const days = (o.days || []).filter(d => d && d.day >= start && d.day <= end);
  const eligible = days.filter(nmTdeeDayEligible);
  const wp = (o.trendPoints || []).filter(p => p.date >= start && p.date <= end);
  const base = { sufficient: false, window: [start, end],
    nDays: eligible.length, nWeighIns: wp.length };

  // Low confidence suppresses the number outright (N09 §3.10: Low = raw dots
  // only). Stating the confidence reason is the whole point — a hidden metric
  // must say why it is hidden (N09 §1 "suppression over guessing").
  if (conf === 'low')
    return { ...base, reason: o.confidenceReason
      ? `data quality is low (${o.confidenceReason})` : 'data quality is low' };
  if (eligible.length < NM_TDEE_MIN_DAYS)
    return { ...base, reason: `${nmPlural(NM_TDEE_MIN_DAYS - eligible.length, 'more fully-logged day')} needed in the last ${NM_TDEE_WINDOW_DAYS}` };
  if (wp.length < NM_TDEE_MIN_WEIGH_INS)
    return { ...base, reason: `${nmPlural(NM_TDEE_MIN_WEIGH_INS - wp.length, 'more weigh-in')} needed in the last ${NM_TDEE_WINDOW_DAYS} days` };

  const span = nmDayDiff(wp[wp.length - 1].date, wp[0].date);
  if (span <= 0) return { ...base, reason: 'weigh-ins do not span enough days yet' };

  const meanIntake = eligible.reduce((a, d) => a + d.actual_kcal, 0) / eligible.length;
  const dTrend = wp[wp.length - 1].trend - wp[0].trend;
  const mid = Math.round((meanIntake - NM_KCAL_PER_LB * (dTrend / span)) / 50) * 50;
  const band = nmTdeeBand(conf);
  return { sufficient: true, window: [start, end], mid, low: mid - band, high: mid + band,
    band, confidence: conf, meanIntake: Math.round(meanIntake),
    deltaTrend: Math.round(dTrend * 100) / 100, spanDays: span,
    nDays: eligible.length, nWeighIns: wp.length, reason: null };
}

// Weekly walk-forward used by the chart and the data table.
//
// The §3.7 "never moves more than 100 kcal/week" rule is a property of a
// SEQUENCE, not of a point, which is why it lives here and not in nmTdee. Each
// row therefore carries both numbers and the consumer chooses:
//   .mid    — what the data says for that window, computed independently
//   .shown  — the same series with the movement cap applied, forward from the
//             first sufficient week; `recalibrating` marks a week where the cap
//             bit and the previous range was held on screen (§4 rule 13).
// A back-filled historical line should draw .mid: the cap governs how a LIVE
// estimate is allowed to move on screen, and says nothing about what the logs
// for a past window actually contained. The current headline uses .shown.
function nmTdeeSeries(o) {
  o = o || {};
  const out = [];
  let prevShown = null;
  for (const end of (o.weekEnds || [])) {
    const conf = (o.confidenceByWeek && o.confidenceByWeek[end]) || o.confidence || 'high';
    const reason = (o.confidenceReasonByWeek && o.confidenceReasonByWeek[end]) || o.confidenceReason;
    const r = nmTdee({ days: o.days, trendPoints: o.trendPoints, asOf: end,
      confidence: conf, confidenceReason: reason });
    let shown = null, recalibrating = false;
    if (r.sufficient) {
      if (prevShown == null) shown = r.mid;
      else if (Math.abs(r.mid - prevShown) > NM_TDEE_MAX_STEP_KCAL) { shown = prevShown; recalibrating = true; }
      else shown = r.mid;
      prevShown = shown;
    }
    out.push({ ...r, weekEnd: end, shown, recalibrating,
      shownLow: shown == null ? null : shown - r.band,
      shownHigh: shown == null ? null : shown + r.band });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.8 Projection — shared suppression gate for both the goal ETA and the
// phase-end forecast. Same rules, same rate bounds (×0.6 slow / ×1.4 fast);
// only the destination differs.
// ─────────────────────────────────────────────────────────────────────────────
const NM_ETA_FAST = 1.4;
const NM_ETA_SLOW = 0.6;
const NM_ETA_MIN_TREND_WEEKS = 3;
const NM_ETA_FLAT_RATE = 0.1;

function nmProjectionSuppression(o) {
  if (!o) return 'no data yet';
  // Maintenance and diet breaks are not going anywhere on purpose — projecting
  // a destination from them misreads the phase (N09 §3.8).
  if (o.phaseType === 'maintenance' || o.phaseType === 'diet_break') return 'holding';
  if (o.rate == null) return 'no trend rate yet';
  if (o.weeksOfTrend != null && o.weeksOfTrend < NM_ETA_MIN_TREND_WEEKS)
    return `needs about ${NM_ETA_MIN_TREND_WEEKS} weeks of trend data`;
  if (Math.abs(o.rate) <= NM_ETA_FLAT_RATE) return 'the trend is too flat to project from';
  if ((o.weeksLoggingBelowMostly || 0) >= 2) return 'logging has been below "mostly" for 2+ weeks';
  return null;
}

const NM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// N09 §3.8: date ranges are rounded to half-months. Never a single date.
// The year is appended only when the date is NOT in the reference year — a
// slow rate over a long distance can project 18 months out, and "late May –
// late Apr" without years reads as a range running backwards.
function nmHalfMonth(ymd, refYmd) {
  const d = nmDate(ymd);
  const label = `${d.getDate() <= 15 ? 'early' : 'late'} ${NM_MONTHS[d.getMonth()]}`;
  if (!refYmd) return label;
  return d.getFullYear() === nmDate(refYmd).getFullYear() ? label : `${label} ${d.getFullYear()}`;
}
function nmHalfMonthRange(a, b, refYmd) {
  const x = nmHalfMonth(a, refYmd), y = nmHalfMonth(b, refYmd);
  return x === y ? x : `${x} – ${y}`;
}

// Goal ETA — "when do I reach this weight?" Secondary to the phase forecast in
// the UI, because a goal range is often several phases away.
function nmGoalEta(o) {
  o = o || {};
  const sup = nmProjectionSuppression(o);
  if (sup) return { suppressed: true, reason: sup, holding: sup === 'holding' };
  if (o.trendWeight == null || o.targetWeight == null)
    return { suppressed: true, reason: 'no goal weight set' };
  const dist = o.trendWeight - o.targetWeight;
  if (Math.abs(dist) < 0.5) return { suppressed: true, reason: 'already at this target', atTarget: true };
  // The trend has to be pointed at the target for a date to mean anything.
  if ((dist > 0) !== (o.rate < 0))
    return { suppressed: true, reason: 'the trend is moving away from this target', divergent: true };
  const wFast = Math.abs(dist) / (Math.abs(o.rate) * NM_ETA_FAST);
  const wSlow = Math.abs(dist) / (Math.abs(o.rate) * NM_ETA_SLOW);
  const dateFast = nmAddDays(o.asOf, Math.round(wFast * 7));
  const dateSlow = nmAddDays(o.asOf, Math.round(wSlow * 7));
  return { suppressed: false, targetWeight: o.targetWeight,
    weeksFast: Math.round(wFast * 10) / 10, weeksSlow: Math.round(wSlow * 10) / 10,
    dateFast, dateSlow, label: nmHalfMonthRange(dateFast, dateSlow, o.asOf) };
}

// ── Phase-end forecast ──
// Default block lengths are the midpoints of the durations N06_Phase_Definitions
// publishes for each archetype (fat_loss "6–8 week blocks", diet_break "1–2
// weeks", baseline "2–3 weeks", lean_gain "8–12 weeks"). They are NOT inferred
// from phase history: the history is a handful of rows broken up by travel gaps,
// which is not a sample you can fit a default to. maintenance is open-ended by
// definition, so it gets no forecast — "holding" language instead.
function nmPhaseDefaultWeeks(phaseType) {
  const w = { baseline: 3, fat_loss: 7, diet_break: 2, lean_gain: 10,
    maintenance: null, recomp: null }[phaseType];
  return w === undefined ? null : w;
}

function nmPhaseEnd(phase) {
  if (!phase || !phase.start_date) return { date: null, source: null };
  if (phase.end_date) return { date: phase.end_date, source: 'explicit' };
  const w = nmPhaseDefaultWeeks(phase.phase_type);
  if (w == null) return { date: null, source: null };
  return { date: nmAddDays(phase.start_date, w * 7), source: 'default', weeks: w };
}

// "Where does the trend land by the end of this block?" — the §3.8 rate bounds
// aimed at a date instead of a weight.
function nmPhaseForecast(o) {
  o = o || {};
  const sup = nmProjectionSuppression(o);
  if (sup) return { suppressed: true, reason: sup, holding: sup === 'holding' };
  if (!o.phaseEnd) return { suppressed: true, reason: 'no phase end date to forecast to' };
  if (o.trendWeight == null) return { suppressed: true, reason: 'no trend weight yet' };
  const weeks = nmDayDiff(o.phaseEnd, o.asOf) / 7;
  if (weeks <= 0) return { suppressed: true, reason: 'this phase is already past its planned end' };
  const a = o.trendWeight + o.rate * NM_ETA_FAST * weeks;
  const b = o.trendWeight + o.rate * NM_ETA_SLOW * weeks;
  return { suppressed: false, phaseEnd: o.phaseEnd, source: o.phaseEndSource || null,
    weeks: Math.round(weeks * 10) / 10,
    low: Math.round(Math.min(a, b) * 10) / 10,
    high: Math.round(Math.max(a, b) * 10) / 10 };
}

// ── exports: browser global + node (tests) ──
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NM_CALC_VERSION, NM_ALPHA,
    nmTrendWeight, nmTrendRate, nmPaceVerdict,
    nmDayTier, nmInterpretable, nmWeeklyLogging,
    nmCalorieAdherence, nmProteinHitRate, nmCompliance,
    nmConfidence, nmPlateau,
    nmCheckWeight, nmSuggestTypoFix, nmCheckTape, nmCheckCaliper,
    nmCheckDuplicate, nmCheckActivity, nmGoalProgress,
    nmTdee, nmTdeeSeries, nmTdeeDayEligible, nmTdeeBand,
    nmGoalEta, nmPhaseForecast, nmPhaseEnd, nmPhaseDefaultWeeks,
    nmProjectionSuppression, nmHalfMonth, nmHalfMonthRange,
    nmWeekOf, nmAddDays, nmDayDiff,
  };
}
