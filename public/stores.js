// Store management: add a store by URL, let the server search its catalogue,
// then confirm which collections to watch.
import { $, api, state } from './core.js';

const dialog = () => $('#stores-dialog');

let discovered = null; // last scan result
let showingAll = false;

function showPane(pane) {
  for (const id of ['stores', 'add', 'choose']) {
    $(`#pane-${id}`).hidden = id !== pane;
  }
  $('#store-error').hidden = true;
  $('#choose-error').hidden = true;
  if (!dialog().open) dialog().showModal();
}

export function openStores() {
  renderStoreList();
  showPane(state.sites.length ? 'stores' : 'add');
  if (!state.sites.length) setTimeout(() => $('#store-url').focus(), 40);
}

function busy(button, label) {
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${label}`;
  return (restore) => {
    button.disabled = false;
    button.textContent = restore;
  };
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

// --- store list -------------------------------------------------------------

function renderStoreList() {
  const list = $('#store-list');
  list.replaceChildren();

  if (!state.sites.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="store-info"><span class="store-meta">No stores added yet.</span></span>';
    list.append(li);
    return;
  }

  for (const site of state.sites) {
    const li = document.createElement('li');

    const info = document.createElement('span');
    info.className = 'store-info';

    const name = document.createElement('span');
    name.className = 'store-name';
    name.textContent = site.name;
    if (!site.enabled) {
      const pill = document.createElement('span');
      pill.className = 'pill warn';
      pill.textContent = 'paused';
      name.append(pill);
    }

    const meta = document.createElement('span');
    if (site.lastError) {
      meta.className = 'store-meta bad';
      meta.textContent = site.lastError;
    } else {
      meta.className = 'store-meta';
      const count = site.productCount ?? 0;
      const sections = site.collections.length;
      const noun = site.sectionNoun ?? 'collection';
      meta.textContent =
        `${count} product${count === 1 ? '' : 's'} · ${site.availableCount ?? 0} buyable · ` +
        `${sections} ${noun}${sections === 1 ? '' : 's'}`;
    }

    info.append(name, meta);

    const actions = document.createElement('span');
    actions.className = 'store-actions';

    const refresh = document.createElement('button');
    refresh.className = 'ghost';
    refresh.textContent = 'Refresh';
    refresh.addEventListener('click', async () => {
      const restore = busy(refresh, 'Polling');
      try {
        await api(`/api/sites/${site.id}/poll`, { method: 'POST' });
        await reloadSites();
        renderStoreList();
        state.onSitesChanged?.();
      } catch (err) {
        showError('#store-error', err.message);
      } finally {
        restore('Refresh');
      }
    });

    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${site.name}? Its products and any watches on them are deleted.`)) return;
      const restore = busy(remove, 'Removing');
      try {
        await api(`/api/sites/${site.id}`, { method: 'DELETE' });
        await reloadSites();
        renderStoreList();
        state.onSitesChanged?.();
      } catch (err) {
        showError('#store-error', err.message);
        restore('Remove');
      }
    });

    actions.append(refresh, remove);
    li.append(info, actions);
    list.append(li);
  }
}

export async function reloadSites() {
  const data = await api('/api/sites');
  state.sites = data.sites;
  state.adminRequired = data.adminRequired;
  return state.sites;
}

// --- scanning ---------------------------------------------------------------

function renderCollections() {
  const list = $('#collection-list');
  list.replaceChildren();

  const rows = showingAll
    ? [...discovered.suggested, ...discovered.others]
    : discovered.suggested;

  if (!rows.length) {
    const li = document.createElement('li');
    li.innerHTML =
      '<label><span class="coll-text"><span class="coll-title">Nothing looked like a pre-order section.</span>' +
      '<span class="coll-sub">Use “Show all” to pick sections by hand.</span></span></label>';
    list.append(li);
    return;
  }

  for (const coll of rows) {
    const li = document.createElement('li');
    const label = document.createElement('label');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = coll.handle;
    // Pre-tick the ones that clearly are pre-order sections.
    box.checked = (coll.score ?? 0) >= 70;

    const text = document.createElement('span');
    text.className = 'coll-text';
    const title = document.createElement('span');
    title.className = 'coll-title';
    title.textContent = coll.title;
    const sub = document.createElement('span');
    sub.className = 'coll-sub';
    sub.textContent = coll.why ? `${coll.handle} · matched ${coll.why}` : coll.handle;
    text.append(title, sub);

    const count = document.createElement('span');
    count.className = 'coll-count';
    count.textContent = coll.productCount != null ? `${coll.productCount}` : '';

    label.append(box, text, count);
    li.append(label);
    list.append(li);
  }
}

function selectedHandles() {
  return [...$('#collection-list').querySelectorAll('input:checked')].map((b) => b.value);
}

async function scanStore() {
  const button = $('#scan-btn');
  const restore = busy(button, 'Scanning');
  $('#store-error').hidden = true;

  try {
    discovered = await api('/api/sites/discover', {
      method: 'POST',
      body: { url: $('#store-url').value },
    });
    showingAll = false;

    const noun = discovered.sectionNoun ?? 'collection';
    const plural = `${noun}s`;

    $('#found-name').textContent = discovered.name;
    $('#found-summary').textContent =
      `${discovered.origin} · ${discovered.platformLabel} · ` +
      `${discovered.totalCollections} ${plural} found · prices in ${discovered.currency}`;
    $('#toggle-all-btn').textContent = `Show all ${discovered.totalCollections}`;
    $('#collection-label').textContent = discovered.suggested.length
      ? `${discovered.suggested.length} look like pre-order sections`
      : `${plural[0].toUpperCase()}${plural.slice(1)} to watch`;

    renderCollections();
    showPane('choose');
  } catch (err) {
    showError('#store-error', err.data?.message ?? err.message);
  } finally {
    restore('Scan store');
  }
}

async function saveStore() {
  const handles = selectedHandles();
  if (!handles.length) {
    return showError('#choose-error', 'Pick at least one section to watch.');
  }

  const button = $('#save-store-btn');
  const restore = busy(button, 'Adding');
  $('#choose-error').hidden = true;

  try {
    await api('/api/sites', {
      method: 'POST',
      body: { url: discovered.origin, name: discovered.name, collections: handles },
    });
    await reloadSites();
    renderStoreList();
    showPane('stores');
    state.onSitesChanged?.();
  } catch (err) {
    showError('#choose-error', err.data?.message ?? err.message);
  } finally {
    restore('Add store');
  }
}

// --- wiring -----------------------------------------------------------------

export function initStores() {
  $('#stores-btn').addEventListener('click', openStores);
  $('#empty-add-btn').addEventListener('click', () => {
    showPane('add');
    setTimeout(() => $('#store-url').focus(), 40);
  });
  $('#add-store-btn').addEventListener('click', () => {
    showPane('add');
    setTimeout(() => $('#store-url').focus(), 40);
  });
  $('#stores-back-btn').addEventListener('click', () => showPane('stores'));
  $('#choose-back-btn').addEventListener('click', () => showPane('add'));
  $('#scan-btn').addEventListener('click', scanStore);
  $('#save-store-btn').addEventListener('click', saveStore);

  $('#toggle-all-btn').addEventListener('click', () => {
    // Keep whatever is already ticked when expanding the list.
    const keep = new Set(selectedHandles());
    showingAll = !showingAll;
    renderCollections();
    for (const box of $('#collection-list').querySelectorAll('input')) {
      if (keep.has(box.value)) box.checked = true;
    }
    $('#toggle-all-btn').textContent = showingAll
      ? 'Show suggested only'
      : `Show all ${discovered.totalCollections}`;
  });

  $('#store-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      scanStore();
    }
  });
}
