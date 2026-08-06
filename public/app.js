import { $, api, money, state } from './core.js';
import { initStores, openStores, reloadSites } from './stores.js';

// --- rendering --------------------------------------------------------------

function card(product) {
  const li = document.createElement('li');
  li.className = 'card' + (state.selected.has(product.id) ? ' selected' : '');

  const label = document.createElement('label');
  label.innerHTML = `
    <span class="thumb">${
      product.image_url
        ? `<img src="${product.image_url}" alt="" loading="lazy" />`
        : '<span class="placeholder">No image</span>'
    }</span>
    <span class="card-body">
      <span class="badge ${product.available ? 'in' : 'out'}">${
        product.available ? 'In stock' : 'Not buyable yet'
      }</span>
      <span class="card-title"></span>
      <span class="card-meta">
        <span class="meta-text">
          <span class="vendor"></span>
          <span class="price">${money(product.price, product.currency)}</span>
        </span>
      </span>
    </span>
    <span class="check" aria-hidden="true">✓</span>`;

  // Set text via textContent so store-supplied strings can't inject markup.
  label.querySelector('.card-title').textContent = product.title;
  label.querySelector('.vendor').textContent =
    state.sites.length > 1
      ? [product.site_name, product.vendor].filter(Boolean).join(' · ')
      : (product.vendor ?? '');

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = state.selected.has(product.id);
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(product.id);
    else state.selected.delete(product.id);
    li.classList.toggle('selected', box.checked);
    renderTray();
  });
  label.prepend(box);

  // Lives inside the meta row rather than floating over it, so it can never
  // cover the price.
  const link = document.createElement('a');
  link.className = 'view';
  link.href = product.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'View ↗';
  // Without this the click would bubble to the label and toggle the checkbox.
  link.addEventListener('click', (e) => e.stopPropagation());
  label.querySelector('.card-meta').append(link);

  li.append(label);
  return li;
}

function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren(...state.products.map(card));

  // With no stores there is nothing to browse, filter, or explain.
  const noStores = state.sites.length === 0;
  $('#empty').hidden = !noStores;
  $('#status').hidden = noStores;
  $('.controls').hidden = noStores;
  $('.intro').hidden = noStores;

  const shown = state.products.length;
  $('#status').textContent = shown
    ? `${shown} product${shown === 1 ? '' : 's'}${state.q ? ` matching “${state.q}”` : ''}`
    : 'Nothing matches those filters.';
}

function renderTray() {
  const tray = $('#tray');
  const changed =
    state.selected.size !== state.saved.size ||
    [...state.selected].some((id) => !state.saved.has(id));

  tray.hidden = state.selected.size === 0 && !changed;
  $('#tray-count').textContent = `${state.selected.size} selected${
    changed ? ' · unsaved' : ' · saved'
  }`;
  $('#save-btn').disabled = !changed;
}

function renderAccount() {
  $('#account-btn').textContent = state.signedIn ? state.phone : 'Sign in';
}

function renderSiteFilter() {
  const select = $('#site-filter');
  const current = select.value;
  select.replaceChildren();

  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All stores';
  select.append(all);

  for (const site of state.sites) {
    const option = document.createElement('option');
    option.value = String(site.id);
    option.textContent = site.name;
    select.append(option);
  }

  select.value = state.sites.some((s) => String(s.id) === current) ? current : '';
  state.siteId = select.value;
  // Only worth showing once there's more than one store to choose between.
  select.hidden = state.sites.length < 2;

  const totals = state.sites.reduce(
    (acc, s) => ({
      products: acc.products + (s.productCount ?? 0),
      available: acc.available + (s.availableCount ?? 0),
    }),
    { products: 0, available: 0 },
  );
  $('#store-sub').textContent = state.sites.length
    ? `${state.sites.length} store${state.sites.length === 1 ? '' : 's'} · ` +
      `${totals.products} pre-orders tracked · ${totals.available} buyable now`
    : 'No stores added yet';
}

// --- data -------------------------------------------------------------------

let loadToken = 0;
async function loadProducts() {
  const mine = ++loadToken;

  if (!state.sites.length) {
    state.products = [];
    renderGrid();
    return;
  }

  const params = new URLSearchParams({ status: state.status, sort: state.sort, limit: '600' });
  if (state.q) params.set('q', state.q);
  if (state.siteId) params.set('siteId', state.siteId);

  $('#status').textContent = 'Loading…';
  try {
    const data = await api(`/api/products?${params}`);
    if (mine !== loadToken) return; // a newer request already won
    state.products = data.products;
    renderGrid();
  } catch (err) {
    if (mine === loadToken) $('#status').textContent = `Could not load products: ${err.message}`;
  }
}

async function loadMe() {
  const me = await api('/api/me');
  state.signedIn = Boolean(me.signedIn);
  state.phone = me.phone ?? null;
  state.feedToken = me.feedToken ?? null;
  if (me.watches) {
    state.saved = new Set(me.watches);
    state.selected = new Set(me.watches);
  }
  renderAccount();
  renderTray();
}

async function saveWatches() {
  const btn = $('#save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const data = await api('/api/watches', {
      method: 'PUT',
      body: { productIds: [...state.selected] },
    });
    state.saved = new Set(data.watches);
    state.selected = new Set(data.watches);
    renderGrid();
    renderTray();
    btn.textContent = 'Saved ✓';
    setTimeout(() => (btn.textContent = 'Save & get texts'), 1600);
  } catch (err) {
    btn.textContent = 'Save & get texts';
    if (err.status === 401) return openDialog('phone');
    alert(`Could not save: ${err.message}`);
  }
}

// --- account dialog ---------------------------------------------------------

const dialog = $('#dialog');

function openDialog(pane) {
  for (const id of ['phone', 'code', 'account']) {
    $(`#pane-${id}`).hidden = id !== pane;
  }
  if (pane === 'account') {
    $('#account-phone').textContent = state.phone ?? '';
    $('#feed-url').value = `${location.origin}/feed/${state.feedToken}.xml`;
  }
  $('#phone-error').hidden = true;
  $('#code-error').hidden = true;
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $(`#pane-${pane}`).querySelector('input')?.focus(), 40);
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

const ERRORS = {
  invalid_phone: "That doesn't look like a mobile number that can receive texts.",
  cooldown: 'A code was just sent. Give it a moment before requesting another.',
  sms_failed: 'We could not send the text. Check the number and try again.',
  expired: 'That code expired. Request a new one.',
  too_many: 'Too many wrong attempts. Request a new code.',
  mismatch: 'That code is not right.',
  no_code: 'Request a code first.',
  rate_limited: 'Too many attempts from this network. Try again shortly.',
};

function errorText(err) {
  return ERRORS[err.data?.error] ?? ERRORS[err.message] ?? err.message ?? 'Something went wrong.';
}

$('#send-code-btn').addEventListener('click', async () => {
  const btn = $('#send-code-btn');
  const phone = $('#phone').value.trim();
  $('#phone-error').hidden = true;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const data = await api('/api/verify/start', { method: 'POST', body: { phone } });
    state.phone = data.phone;
    $('#code-target').textContent = data.phone;
    openDialog('code');
  } catch (err) {
    const extra = err.data?.retryAfter ? ` (${err.data.retryAfter}s)` : '';
    showError('#phone-error', errorText(err) + extra);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send code';
  }
});

$('#check-code-btn').addEventListener('click', async () => {
  const btn = $('#check-code-btn');
  $('#code-error').hidden = true;
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    const data = await api('/api/verify/check', {
      method: 'POST',
      body: { phone: state.phone, code: $('#code').value.trim() },
    });
    state.signedIn = true;
    state.feedToken = data.feedToken;
    // Keep whatever the visitor ticked before signing in, plus anything already
    // on the server-side watchlist.
    const before = state.selected.size;
    for (const id of data.watches) state.selected.add(id);
    state.saved = new Set(data.watches);
    renderAccount();
    renderGrid();

    if (before) await saveWatches();
    openDialog('account');
  } catch (err) {
    const left = err.data?.attemptsLeft;
    showError(
      '#code-error',
      errorText(err) + (left != null ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''),
    );
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
});

$('#back-btn').addEventListener('click', () => openDialog('phone'));

$('#copy-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#feed-url').value).catch(() => {});
  $('#copy-btn').textContent = 'Copied';
  setTimeout(() => ($('#copy-btn').textContent = 'Copy'), 1500);
});

function resetToSignedOut() {
  state.signedIn = false;
  state.phone = null;
  state.feedToken = null;
  state.saved = new Set();
  state.selected = new Set();
  renderAccount();
  renderGrid();
  renderTray();
  dialog.close();
}

$('#signout-btn').addEventListener('click', async () => {
  await api('/api/signout', { method: 'POST' });
  resetToSignedOut();
});

$('#unsub-btn').addEventListener('click', async () => {
  if (!confirm('Stop all alerts and clear your watchlist?')) return;
  await api('/api/unsubscribe', { method: 'POST' });
  resetToSignedOut();
});

$('#account-btn').addEventListener('click', () => openDialog(state.signedIn ? 'account' : 'phone'));

// --- controls ---------------------------------------------------------------

$('#save-btn').addEventListener('click', () => {
  if (!state.signedIn) return openDialog('phone');
  saveWatches();
});

$('#clear-btn').addEventListener('click', () => {
  state.selected = new Set();
  renderGrid();
  renderTray();
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadProducts();
  }, 220);
});

$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  loadProducts();
});

$('#site-filter').addEventListener('change', (e) => {
  state.siteId = e.target.value;
  loadProducts();
});

for (const btn of document.querySelectorAll('.segmented button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.status = btn.dataset.status;
    loadProducts();
  });
}

// Enter submits whichever dialog pane is open.
for (const [inputId, buttonId] of [['#phone', '#send-code-btn'], ['#code', '#check-code-btn']]) {
  $(inputId).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $(buttonId).click();
    }
  });
}

// --- boot -------------------------------------------------------------------

state.onSitesChanged = async () => {
  renderSiteFilter();
  await loadProducts();
};

/** Hide the whole app behind an explanation when the database isn't up yet. */
function showSetup(message) {
  $('#setup-message').textContent = message;
  $('#setup').hidden = false;
  for (const sel of ['.intro', '.controls', '#status', '#grid', '#empty', '#tray']) {
    $(sel).hidden = true;
  }
}

async function boot() {
  try {
    await reloadSites();
  } catch (err) {
    if (err.status === 503) return showSetup(err.message);
    throw err;
  }

  $('#setup').hidden = true;
  renderSiteFilter();
  await loadMe();
  await loadProducts();

  // Nothing to browse yet — open the add-store flow rather than an empty grid.
  if (!state.sites.length) openStores();
}

$('#setup-retry').addEventListener('click', () => location.reload());

initStores();
await boot();

// A ?t=<feedToken> link (the one included in every alert text) opens the
// account pane directly.
const linkToken = new URLSearchParams(location.search).get('t');
if (linkToken && state.signedIn && linkToken === state.feedToken) {
  openDialog('account');
  history.replaceState({}, '', location.pathname);
}
