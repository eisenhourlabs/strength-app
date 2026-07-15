// ══════════════ Kardia Nutrition — Shopping: Check at Home + Buy list (household-shared) ══════════════

const N_GCATS = ['protein', 'produce', 'starch', 'dairy', 'pantry', 'frozen', 'treat'];
const N_GLOCS = ['freezer', 'fridge', 'pantry'];
const N_GLOC_ICONS = { freezer: '🧊', fridge: '🥶', pantry: '🥫' };

function renderGrocery() {
  const body = document.getElementById('grocery-body');
  const { list, items } = NS.grocery;
  document.getElementById('grocery-sub').textContent = `week of ${NS.grocery.list ? NS.grocery.list.week_of : NS.weekOf} · shared list`;
  if (!list) {
    body.innerHTML = `<div class="n-panel">No grocery list for this week yet.</div>`;
    return;
  }
  const stock = items.filter(i => i.section === 'stock');
  const buys  = items.filter(i => i.section !== 'stock' || i.stock_status === 'need');
  let html = '';

  // ── Check at Home ──
  if (stock.length) {
    const verified = stock.filter(i => i.stock_status !== 'pending').length;
    html += `<div class="n-gsection">CHECK AT HOME <span class="n-gprog">${verified} / ${stock.length} verified</span></div>`;
    html += `<div class="n-ghint">Before shopping: Have it ✓, or Need → sends it to the buy list. Tap a decided item to undo.</div>`;
    for (const loc of N_GLOCS) {
      const rows = stock.filter(i => (i.location || 'pantry') === loc);
      if (!rows.length) continue;
      html += `<div class="n-gcat">${N_GLOC_ICONS[loc]} ${loc}</div>`;
      for (const it of rows) {
        const st = it.stock_status || 'pending';
        if (st === 'pending') {
          html += `<div class="n-gitem n-gstock">
            <span class="n-gname">${nEsc(it.item_name)}
              <span class="n-guse">${nEsc(it.quantity_desc || '')}${it.use_note ? ' · ' + nEsc(it.use_note) : ''}</span></span>
            <button class="n-gbtn have" onclick="setStockStatus('${it.id}','have')">Have ✓</button>
            <button class="n-gbtn need" onclick="setStockStatus('${it.id}','need')">Need →</button></div>`;
        } else {
          html += `<div class="n-gitem n-gstock decided ${st}" onclick="setStockStatus('${it.id}','pending')">
            <span class="n-gcheck">${st === 'have' ? '✅' : '🛒'}</span>
            <span class="n-gname">${nEsc(it.item_name)}
              <span class="n-guse">${st === 'have' ? nEsc(it.quantity_desc || '') : 'moved to buy list'}</span></span></div>`;
        }
      }
    }
  }

  // ── Buy list ──
  const bought = buys.filter(i => i.is_checked).length;
  html += `<div class="n-gsection">BUY <span class="n-gprog">${bought} / ${buys.length} in cart</span></div>`;
  if (!buys.length) html += `<div class="n-ghint">Nothing to buy yet.</div>`;
  for (const cat of N_GCATS) {
    const rows = buys.filter(i => i.category === cat);
    if (!rows.length) continue;
    html += `<div class="n-gcat">${cat}</div>`;
    for (const it of rows) {
      html += `<div class="n-gitem${it.is_checked ? ' checked' : ''}" onclick="toggleGrocery('${it.id}')">
        <span class="n-gcheck">${it.is_checked ? '✅' : '⬜'}</span>
        <span class="n-gname">${nEsc(it.item_name)}${it.source === 'user' ? ' <span class="n-badge" style="font-size:10px">added</span>' : ''}${it.section === 'stock' ? ' <span class="n-badge" style="font-size:10px">from check</span>' : ''}</span>
        <span class="n-gqty">${nEsc(it.quantity_desc || '')}</span></div>`;
    }
  }
  html += `<div class="n-gadd">
    <input type="text" id="g-new-item" placeholder="Add an item…">
    <select id="g-new-cat">${N_GCATS.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
    <button class="n-act small primary" onclick="addGroceryItem()">Add</button></div>`;
  body.innerHTML = html;
}

async function setStockStatus(id, status) {
  if (nOffline) { toast('Offline — reconnect to update the list.', 3000); return; }
  const it = NS.grocery.items.find(i => i.id === id);
  if (!it) return;
  const prev = it.stock_status;
  it.stock_status = status;                          // optimistic
  if (status !== 'need') it.is_checked = false;      // un-buy if pulled back
  renderGrocery();
  const upd = { stock_status: status };
  if (status !== 'need') { upd.is_checked = false; upd.checked_by = null; }
  const { error } = await ndb.from('grocery_items').update(upd).eq('id', id);
  if (error) { it.stock_status = prev; renderGrocery(); toast('Update failed', 3000); }
}

async function toggleGrocery(id) {
  if (nOffline) { toast('Offline — reconnect to update the list.', 3000); return; }
  const it = NS.grocery.items.find(i => i.id === id);
  if (!it) return;
  const newVal = !it.is_checked;
  it.is_checked = newVal;                 // optimistic
  it.checked_by = newVal ? NS.me.id : null;
  renderGrocery();
  const { error } = await ndb.from('grocery_items')
    .update({ is_checked: newVal, checked_by: newVal ? NS.me.id : null }).eq('id', id);
  if (error) { it.is_checked = !newVal; renderGrocery(); toast('Update failed', 3000); }
}

async function addGroceryItem() {
  const name = document.getElementById('g-new-item').value.trim();
  const cat  = document.getElementById('g-new-cat').value;
  if (!name) return;
  if (nOffline) { toast('Offline — reconnect to update the list.', 3000); return; }
  if (!NS.grocery.list) { toast('No list this week'); return; }
  const { data, error } = await ndb.from('grocery_items').insert({
    list_id: NS.grocery.list.id, category: cat, item_name: name,
    source: 'user', sort_order: 999,
  }).select().single();
  if (error) { toast('Add failed: ' + error.message, 3500); return; }
  NS.grocery.items.push(data);
  renderGrocery();
}

async function groceryResetChecks() {
  if (!NS.grocery.list || nOffline) return;
  const listId = NS.grocery.list.id;
  const { error } = await ndb.from('grocery_items')
    .update({ is_checked: false, checked_by: null }).eq('list_id', listId);
  if (error) { toast('Reset failed', 3000); return; }
  const { error: e2 } = await ndb.from('grocery_items')
    .update({ stock_status: 'pending' }).eq('list_id', listId).eq('section', 'stock');
  if (e2) { toast('Stock reset failed', 3000); return; }
  NS.grocery.items.forEach(i => {
    i.is_checked = false; i.checked_by = null;
    if (i.section === 'stock') i.stock_status = 'pending';
  });
  renderGrocery();
}
