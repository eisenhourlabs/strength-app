// ══════════════ Kardia Nutrition — Grocery checklist (household-shared) ══════════════

const N_GCATS = ['protein', 'produce', 'starch', 'dairy', 'pantry', 'frozen', 'treat'];

function renderGrocery() {
  const body = document.getElementById('grocery-body');
  const { list, items } = NS.grocery;
  document.getElementById('grocery-sub').textContent = `week of ${NS.weekOf} · shared list`;
  if (!list) {
    body.innerHTML = `<div class="n-panel">No grocery list for this week yet.</div>`;
    return;
  }
  const checked = items.filter(i => i.is_checked).length;
  let html = `<div class="n-panel" style="text-align:center">${checked} / ${items.length} checked</div>`;
  for (const cat of N_GCATS) {
    const rows = items.filter(i => i.category === cat);
    if (!rows.length) continue;
    html += `<div class="n-gcat">${cat}</div>`;
    for (const it of rows) {
      html += `<div class="n-gitem${it.is_checked ? ' checked' : ''}" onclick="toggleGrocery('${it.id}')">
        <span class="n-gcheck">${it.is_checked ? '✅' : '⬜'}</span>
        <span class="n-gname">${nEsc(it.item_name)}${it.source === 'user' ? ' <span class="n-badge" style="font-size:10px">added</span>' : ''}</span>
        <span class="n-gqty">${nEsc(it.quantity_desc || '')}</span></div>`;
    }
  }
  html += `<div class="n-gadd">
    <input type="text" id="g-new-item" placeholder="Add an item…">
    <select id="g-new-cat">${N_GCATS.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
    <button class="n-act small primary" onclick="addGroceryItem()">Add</button></div>`;
  body.innerHTML = html;
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
  const { error } = await ndb.from('grocery_items')
    .update({ is_checked: false, checked_by: null }).eq('list_id', NS.grocery.list.id);
  if (error) { toast('Reset failed', 3000); return; }
  NS.grocery.items.forEach(i => { i.is_checked = false; i.checked_by = null; });
  renderGrocery();
}
