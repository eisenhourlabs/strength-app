// ══════════════ Kardia Nutrition — Split-the-bowl calculator (Troy, 2026-11-20) ══════════════
// Calculator only: nothing is logged or written to Supabase. Enter the scale reading, say
// whether it includes the container, pick the container, and it gives the scale number to
// scoop down to for Amanda's share (what's left on the scale is Troy's).
// Opened from the batch card's "Split ⚖" button (pre-filled with that cook's split %) and
// from the Today header ("⚖ Split"; default 60/40). Container list: the four household
// defaults below, edits/additions saved on this device (localStorage).

const N_SPLIT_DEFAULT_CONTAINERS = [
  { name: 'Purple glass bowl', oz: 35.25 },
  { name: 'Large mixing bowl', oz: 18.6 },
  { name: 'Small mixing bowl', oz: 11.2 },
  { name: 'Large cooking pot', oz: 42.85 },
];
const N_SPLIT_LS_CONT = 'n_split_containers';
const N_SPLIT_LS_LAST = 'n_split_last';

const NSPLIT = { reading: '', withCont: true, cont: 0, amandaPct: 40, title: '', manage: false };

function nSplitLsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function nSplitLsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

function nSplitContainers() {
  try {
    const v = JSON.parse(nSplitLsGet(N_SPLIT_LS_CONT) || 'null');
    if (Array.isArray(v) && v.length) return v.filter(c => c && c.name && Number(c.oz) > 0);
  } catch (e) { /* fall through */ }
  return N_SPLIT_DEFAULT_CONTAINERS.map(c => ({ ...c }));
}
function nSplitSaveContainers(list) { nSplitLsSet(N_SPLIT_LS_CONT, JSON.stringify(list)); }

function nSplitFmt(x) { return (Math.round(x * 100) / 100).toFixed(2).replace(/\.?0+$/, ''); }

function nSplitEnsureSheet() {
  if (document.getElementById('n-split')) return;
  const d = document.createElement('div');
  d.className = 'n-sheet-overlay'; d.id = 'n-split'; d.style.display = 'none';
  d.onclick = e => { if (e.target === d) nSplitClose(); };
  d.innerHTML = `<div class="n-sheet" style="max-height:85vh">
    <div class="n-sheet-head"><div class="n-sheet-title" id="n-split-title">⚖ Split the bowl</div>
      <button class="n-sheet-close" onclick="nSplitClose()">✕</button></div>
    <div class="n-sheet-list" id="n-split-body"></div></div>`;
  document.body.appendChild(d);
}

// amandaPct: optional (batch card passes that cook's share). title: optional recipe name.
function nOpenSplit(amandaPct, title) {
  nSplitEnsureSheet();
  const list = nSplitContainers();
  const last = nSplitLsGet(N_SPLIT_LS_LAST);
  const li = list.findIndex(c => c.name === last);
  Object.assign(NSPLIT, {
    reading: '', withCont: true, cont: li >= 0 ? li : 0, manage: false,
    amandaPct: Number(amandaPct) > 0 && Number(amandaPct) < 100 ? Math.round(Number(amandaPct)) : 40,
    title: title || '',
  });
  nSplitRender();
  document.getElementById('n-split').style.display = 'flex';
  setTimeout(() => { const i = document.getElementById('n-split-reading'); if (i) i.focus(); }, 50);
}
function nSplitClose() { const s = document.getElementById('n-split'); if (s) s.style.display = 'none'; }

function nSplitResultHtml() {
  const list = nSplitContainers();
  const R = parseFloat(NSPLIT.reading);
  if (!(R > 0)) return `<div class="n-opt-sub" style="margin-top:10px">Enter the scale reading.</div>`;
  const c = NSPLIT.withCont ? list[NSPLIT.cont] : null;
  const C = c ? Number(c.oz) : 0;
  const F = R - C;
  if (!(F > 0)) return `<div class="n-split-warn">The reading (${nSplitFmt(R)} oz) isn't more than the ${nEsc(c ? c.name.toLowerCase() : 'container')} (${nSplitFmt(C)} oz). Check the reading or the container.</div>`;
  const A = F * NSPLIT.amandaPct / 100, T = F - A;
  const target = C + T;
  return `<div class="n-split-result">
    <div class="n-split-row"><span>Food weight</span><b>${nSplitFmt(F)} oz</b></div>
    <div class="n-split-row"><span>Amanda (${NSPLIT.amandaPct}%)</span><b>${nSplitFmt(A)} oz</b></div>
    <div class="n-split-row"><span>Troy (${100 - NSPLIT.amandaPct}%)</span><b>${nSplitFmt(T)} oz</b></div>
    <div class="n-split-big">Amanda: scoop out until the scale reads<div class="n-split-num">${nSplitFmt(target)} oz</div>What's left is Troy's.</div>
  </div>`;
}

function nSplitManageHtml() {
  const list = nSplitContainers();
  return `<div class="n-split-manage">
    ${list.map((c, i) => `<div class="n-split-mrow">
      <span style="flex:1">${nEsc(c.name)}</span>
      <input type="number" inputmode="decimal" step="0.01" value="${nSplitFmt(Number(c.oz))}" onchange="nSplitEditOz(${i}, this.value)"> oz
      <button class="n-chip" onclick="nSplitRemove(${i})" aria-label="Remove">✕</button></div>`).join('')}
    <div class="n-split-mrow">
      <input type="text" id="n-split-newname" placeholder="New container" style="flex:1;width:auto">
      <input type="number" inputmode="decimal" step="0.01" id="n-split-newoz" placeholder="oz">
      <button class="n-chip" onclick="nSplitAdd()">Add</button></div>
    <div class="n-opt-sub">Saved on this phone. <a href="#" onclick="nSplitResetContainers();return false">Reset to the 4 defaults</a></div>
  </div>`;
}

function nSplitRender() {
  const body = document.getElementById('n-split-body');
  if (!body) return;
  document.getElementById('n-split-title').textContent = '⚖ Split the bowl' + (NSPLIT.title ? ' — ' + NSPLIT.title : '');
  const list = nSplitContainers();
  if (NSPLIT.cont >= list.length) NSPLIT.cont = 0;
  body.innerHTML = `
    <div class="n-split-label">Scale reading</div>
    <input type="number" inputmode="decimal" step="0.05" id="n-split-reading" class="n-split-input" placeholder="oz"
      value="${nEsc(NSPLIT.reading)}" oninput="NSPLIT.reading=this.value;nSplitUpdate()">
    <div class="n-split-label">What's on the scale?</div>
    <div class="n-split-chips">
      <button class="n-chip ${NSPLIT.withCont ? 'active' : ''}" onclick="nSplitSet('withCont',true)">Food + container</button>
      <button class="n-chip ${NSPLIT.withCont ? '' : 'active'}" onclick="nSplitSet('withCont',false)">Food only</button>
    </div>
    ${NSPLIT.withCont ? `<div class="n-split-label">Container <a href="#" style="float:right;font-weight:400" onclick="nSplitSet('manage',!NSPLIT.manage);return false">${NSPLIT.manage ? 'Done' : 'Edit'}</a></div>
    ${NSPLIT.manage ? nSplitManageHtml() : `<div class="n-split-chips">${list.map((c, i) =>
      `<button class="n-chip ${i === NSPLIT.cont ? 'active' : ''}" onclick="nSplitPick(${i})">${nEsc(c.name)} · ${nSplitFmt(Number(c.oz))}</button>`).join('')}</div>`}` : ''}
    <div class="n-split-label">Split</div>
    <div class="n-split-chips" style="align-items:center">
      <button class="n-chip" onclick="nSplitPct(-5)">−5</button>
      <span style="font-size:14px">Troy <b>${100 - NSPLIT.amandaPct}%</b> / Amanda <b>${NSPLIT.amandaPct}%</b></span>
      <button class="n-chip" onclick="nSplitPct(5)">+5</button>
    </div>
    <div id="n-split-result">${nSplitResultHtml()}</div>`;
}
function nSplitUpdate() { const r = document.getElementById('n-split-result'); if (r) r.innerHTML = nSplitResultHtml(); }
function nSplitSet(k, v) { NSPLIT[k] = v; nSplitRender(); }
function nSplitPick(i) {
  NSPLIT.cont = i;
  const c = nSplitContainers()[i]; if (c) nSplitLsSet(N_SPLIT_LS_LAST, c.name);
  nSplitRender();
}
function nSplitPct(d) { NSPLIT.amandaPct = Math.min(95, Math.max(5, NSPLIT.amandaPct + d)); nSplitRender(); }
function nSplitEditOz(i, v) {
  const list = nSplitContainers(); const n = parseFloat(v);
  if (list[i] && n > 0) { list[i].oz = n; nSplitSaveContainers(list); }
  nSplitRender();
}
function nSplitRemove(i) {
  const list = nSplitContainers();
  if (list.length <= 1) return;
  list.splice(i, 1); nSplitSaveContainers(list); NSPLIT.cont = 0; nSplitRender();
}
function nSplitAdd() {
  const name = (document.getElementById('n-split-newname').value || '').trim();
  const oz = parseFloat(document.getElementById('n-split-newoz').value);
  if (!name || !(oz > 0)) return;
  const list = nSplitContainers(); list.push({ name, oz }); nSplitSaveContainers(list); nSplitRender();
}
function nSplitResetContainers() { try { localStorage.removeItem(N_SPLIT_LS_CONT); } catch (e) {} NSPLIT.cont = 0; nSplitRender(); }
