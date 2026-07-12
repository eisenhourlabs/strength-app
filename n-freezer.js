// ══════════════ Kardia Nutrition — Freezer-pull nudges (household-shared) ══════════════
// A dated "pull meat from the freezer to thaw" reminder, one card per prep block.
// Shared like the grocery check-off: either person taps "Pulled ✓" and it clears
// for both. No push infra — the card simply appears on the Today screen from its
// show_date through its prep_date. Loaded in nLoadAll (n-core.js), rendered at the
// top of the Today card stack (n-today.js) and read-only on the Week screen.

const N_FP_BLOCK_LABEL = { wed: 'Wednesday prep', sun: 'Sunday prep', salmon_tue: 'Tuesday salmon', salmon_fri: 'Friday salmon', salmon_sat: 'Saturday salmon' };

// Rows to surface today: not yet checked, and today is within [show_date, prep_date].
function nFreezerDue() {
  const t = nToday();
  return (NS.freezerPulls || [])
    .filter(fp => !fp.is_checked && fp.show_date <= t && t <= fp.prep_date)
    .sort((a, b) => a.prep_date.localeCompare(b.prep_date));
}

function nFreezerItemsText(fp) {
  const items = Array.isArray(fp.items) ? fp.items : [];
  return items
    .map(it => `${it.qty ? nEsc(it.qty) + ' ' : ''}${nEsc(it.item || '')}`.trim())
    .filter(Boolean)
    .join(' · ');
}

// Today-screen prompt card(s). Returns '' when nothing is due.
function nFreezerCardsHtml() {
  let html = '';
  for (const fp of nFreezerDue()) {
    const label = N_FP_BLOCK_LABEL[fp.block] || 'Prep';
    const when = nDayName(fp.prep_date, false);
    html += `<div class="n-prompt">
      <div class="n-prompt-title">🧊 Pull from freezer — for ${nEsc(when)}'s ${nEsc(label)}</div>
      <div style="font-size:13px;color:var(--n-text);margin:4px 0 8px">${nFreezerItemsText(fp) || 'items in prep plan'}</div>
      <div class="n-prompt-row">
        <button class="n-act small primary" onclick="nFreezerPulled('${fp.id}')">Pulled ✓</button>
        <span class="n-opt-sub" style="align-self:center">already thawed? tap Pulled ✓</span>
      </div></div>`;
  }
  return html;
}

// Shared check-off: mark done for the whole household (mirrors toggleGrocery).
async function nFreezerPulled(id) {
  if (nOffline) { toast('Offline — reconnect to update.', 3000); return; }
  const fp = (NS.freezerPulls || []).find(x => x.id === id);
  if (!fp) return;
  fp.is_checked = true;                     // optimistic
  fp.checked_by = NS.me.id;
  if (typeof renderToday === 'function') renderToday();
  const { error } = await ndb.from('freezer_pulls')
    .update({ is_checked: true, checked_by: NS.me.id, checked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    fp.is_checked = false; fp.checked_by = null;
    if (typeof renderToday === 'function') renderToday();
    toast('Update failed', 3000);
    return;
  }
  toast('Pulled ✓');
}

// Read-only summary for the Week screen prep panel (upcoming, unchecked pulls).
function nFreezerWeekHtml() {
  const upcoming = (NS.freezerPulls || [])
    .filter(fp => !fp.is_checked && fp.prep_date >= nToday())
    .sort((a, b) => a.prep_date.localeCompare(b.prep_date));
  if (!upcoming.length) return '';
  let rows = '';
  for (const fp of upcoming) {
    const label = N_FP_BLOCK_LABEL[fp.block] || 'Prep';
    rows += `<div style="font-size:13px;margin:2px 0"><b>${nEsc(nDayName(fp.prep_date, true))} · ${nEsc(label)}:</b> ${nFreezerItemsText(fp) || '—'}</div>`;
  }
  return `<div class="n-panel"><div class="n-panel-title">🧊 Freezer pulls</div>${rows}</div>`;
}
