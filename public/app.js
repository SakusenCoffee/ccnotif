import { $, api, convertedMoney, money, state } from './core.js';

// Which of the two views the page is showing: the pre-order grid, or Updates.
let showingFeed = false;
import { initStores, openStores, reloadSites } from './stores.js';

// --- rendering --------------------------------------------------------------

/**
 * `available` alone is ambiguous: for a pre-order it means "you can place one
 * now", not "it is on a shelf". Combining it with is_preorder gives four states
 * that actually mean different things to a buyer.
 */
function statusOf(product) {
  if (product.is_preorder) {
    return product.available
      ? { label: 'Pre-order open', cls: 'pre' }
      : { label: 'Pre-order not open', cls: 'out' };
  }
  return product.available
    ? { label: 'In stock', cls: 'in' }
    : { label: 'Sold out', cls: 'out' };
}

function card(product) {
  const li = document.createElement('li');
  li.className = 'card' + (state.selected.has(product.id) ? ' selected' : '');

  const status = statusOf(product);
  const approx = convertedMoney(product.price, product.currency);

  const label = document.createElement('label');
  label.innerHTML = `
    <span class="thumb">${
      product.image_url
        ? `<img src="${product.image_url}" alt="" loading="lazy" />`
        : '<span class="placeholder">No image</span>'
    }</span>
    <span class="card-body">
      <span class="badge ${status.cls}">${status.label}</span>
      <span class="card-title"></span>
      <span class="card-meta">
        <span class="meta-text">
          <span class="vendor"></span>
          <span class="price">${money(product.price, product.currency)}</span>
          ${approx ? `<span class="price-alt">≈ ${approx}</span>` : ''}
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

  // In the Watched view each card carries its own texting switch, because that
  // is the decision this view exists to let you make. It is per product: you
  // can follow a dozen things and be woken by one.
  if (state.watchedOnly) {
    const bell = document.createElement('button');
    bell.type = 'button';
    // Named after what actually happens on this deployment: with SMS off these
    // are push notifications, and calling them texts is simply untrue.
    const on = state.notify[product.id];
    const noun = state.smsEnabled ? 'text' : 'alert';
    bell.className = 'notify-toggle' + (on ? ' on' : '');
    bell.textContent = on ? `${noun === 'text' ? 'Texting' : 'Alerting'} on` : `${noun === 'text' ? 'Text' : 'Alert'} me`;
    bell.title = on
      ? `You get a${noun === 'alert' ? 'n' : ''} ${noun} when this changes`
      : `Get a${noun === 'alert' ? 'n' : ''} ${noun} when this changes`;

    bell.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const next = !state.notify[product.id];
      bell.disabled = true;
      try {
        await api(`/api/watches/${product.id}/notify`, {
          method: 'PUT',
          body: { notify: next },
        });
        state.notify[product.id] = next;
        renderGrid();
      } catch (err) {
        // The one place a phone number is genuinely needed. Ask for it here
        // rather than up front, so watching never demanded one.
        if (err.data?.error === 'no_channel') openDialog('account');
        else showError('#store-error', err.message);
        bell.disabled = false;
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-watch';
    remove.textContent = 'Remove';
    remove.title = 'Stop watching this';

    remove.addEventListener('click', async (e) => {
      // The label around the card toggles selection; this must not do that too.
      e.stopPropagation();
      e.preventDefault();
      remove.disabled = true;
      try {
        const next = [...state.saved].filter((id) => id !== product.id);
        await api('/api/watches', { method: 'PUT', body: { productIds: next } });
        state.saved = new Set(next);
        state.selected = new Set(next);
        delete state.notify[product.id];
        // Reload rather than splicing the card out: the Watched view is a
        // server-side filter, so the grid it should now show is the server's
        // answer, not a guess at it.
        await loadProducts();
        renderTray();
      } catch (err) {
        showError('#store-error', err.data?.message ?? err.message);
        remove.disabled = false;
      }
    });

    const actions = document.createElement('span');
    actions.className = 'watch-actions';
    actions.append(bell, remove);
    label.querySelector('.card-body').append(actions);
  }

  li.append(label);
  return li;
}

/**
 * Which of the two views is on screen. Both the grid render and the Updates
 * toggle route through here, so neither can quietly undo the other's hiding.
 */
function applyView() {
  // With no stores there is nothing to browse, filter, or explain.
  const noStores = state.sites.length === 0;
  const feed = showingFeed;

  $('#feed-view').hidden = !feed;
  $('#grid').hidden = feed;
  $('.intro').hidden = noStores || feed;
  $('.controls').hidden = noStores || feed;
  $('#status').hidden = noStores || feed;
  $('#empty').hidden = !noStores || feed;
  $('#feed-btn').classList.toggle('active', feed);
  $('#watched-btn').classList.toggle('active', state.watchedOnly && !feed);
}

function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren(...state.products.map(card));

  applyView();
  renderHeader();

  const shown = state.products.length;
  const scope = state.watchedOnly ? ' you watch' : '';
  $('#status').textContent = shown
    ? `${shown} product${shown === 1 ? '' : 's'}${scope}${state.q ? ` matching “${state.q}”` : ''}`
    : state.watchedOnly
      ? 'Nothing on your watchlist matches those filters.'
      : 'Nothing matches those filters.';
}

function renderTray() {
  const tray = $('#tray');
  const changed =
    state.selected.size !== state.saved.size ||
    [...state.selected].some((id) => !state.saved.has(id));

  // Only when there is something to save.
  //
  // It used to appear whenever anything was selected — but the selection starts
  // as a copy of what you already watch, so the bar sat there permanently
  // offering to save a change nobody had made. And it has no purpose at all in
  // the Watched view, where the list *is* the saved state and each row carries
  // its own Remove.
  tray.hidden = !changed || state.watchedOnly;

  const added = [...state.selected].filter((id) => !state.saved.has(id)).length;
  const removed = [...state.saved].filter((id) => !state.selected.has(id)).length;
  const parts = [];
  if (added) parts.push(`${added} to add`);
  if (removed) parts.push(`${removed} to remove`);
  $('#tray-count').textContent = parts.join(' · ') || `${state.selected.size} selected`;
  $('#save-btn').disabled = !changed;
}

function renderAccount() {
  $('#account-btn').textContent = state.username ?? (state.signedIn ? state.phone : 'Sign in');
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

  renderHeader();
}

function renderHeader() {
  if (!state.sites.length) {
    $('#store-sub').textContent = 'No stores added yet';
    return;
  }
  const stores = `${state.sites.length} store${state.sites.length === 1 ? '' : 's'}`;
  const t = state.totals;
  $('#store-sub').textContent = t
    ? `${stores} · ${t.total} tracked · ${t.preorders_open} pre-orders open · ${t.in_stock} in stock`
    : `${stores} · loading…`;
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

  const params = new URLSearchParams({
    status: state.status,
    sort: state.sort,
    type: state.type,
    limit: '600',
  });
  if (state.q) params.set('q', state.q);
  if (state.siteId) params.set('siteId', state.siteId);
  if (state.watchedOnly) params.set('watched', '1');

  $('#status').textContent = 'Loading…';
  try {
    const data = await api(`/api/products?${params}`);
    if (mine !== loadToken) return; // a newer request already won
    state.products = data.products;
    state.fx = data.fx ?? null;
    state.totals = data.totals;
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
  state.notify = me.notify ?? {};
  state.username = me.username ?? null;
  state.hasAccount = Boolean(me.hasAccount);
  state.push = me.push ?? { enabled: false, topic: null, url: null };
  state.smsEnabled = Boolean(me.smsEnabled);
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
    if (err.status === 401) return openDialog('account');
    alert(`Could not save: ${err.message}`);
  }
}

// --- account dialog ---------------------------------------------------------

const dialog = $('#dialog');

function openDialog(pane) {
  for (const id of ['login', 'password', 'phone', 'code', 'account']) {
    $(`#pane-${id}`).hidden = id !== pane;
  }
  if (pane === 'account') {
    renderPush();
    // Nothing here should offer texting when the deployment cannot send one.
    $('#to-phone-btn').hidden = !state.smsEnabled;
    $('#add-phone-row').hidden = !state.smsEnabled;
    $('#change-pass-btn').hidden = !state.hasAccount;
  }
  for (const id of ['#phone-error', '#code-error', '#login-error', '#pass-error']) {
    $(id).hidden = true;
  }
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
  expired: 'That code expired. Request a new one.',
  too_many: 'Too many wrong attempts. Request a new code.',
  mismatch: 'That code is not right.',
  no_code: 'Request a code first.',
  rate_limited: 'Too many attempts from this network. Try again shortly.',
  database_unavailable: 'The server is not connected to its database yet.',
};

function errorText(err) {
  // The server explains SMS failures precisely (which Twilio code, what to do
  // about it). Prefer that over any generic text mapped here.
  if (err.data?.message) return err.data.message;
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
    state.notify = data.notify ?? {};
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
  state.alerts = [];
  state.watchedOnly = false;
  state.notify = {};
  state.username = null;
  state.hasAccount = false;
  state.saved = new Set();
  state.selected = new Set();
  renderAccount();
  renderGrid();
  renderTray();
  dialog.close();
}

// --- Updates view -----------------------------------------------------------
//
// Shown in the page, not a modal. The alert box sits above the results because
// it is the thing you came here to set; the list below is what it will match on.

const FEED_LABEL = {
  restock: 'Now in stock',
  new: 'New pre-order listed',
  sold_out: 'Sold out',
};

function renderFeedItems(events) {
  const list = $('#feed-list');
  list.replaceChildren();

  if (!events.length) {
    const li = document.createElement('li');
    li.className = 'feed-empty';
    li.innerHTML =
      '<strong>Nothing has changed yet.</strong>' +
      '<span>Updates appear here the moment a pre-order flips to buyable, or a new ' +
      'one is listed. The first read of a store is deliberately silent — otherwise ' +
      'adding a shop would post its whole catalogue at once.</span>';
    list.append(li);
    return;
  }

  for (const event of events) {
    const li = document.createElement('li');
    li.className = 'feed-item';

    if (event.image_url) {
      const img = document.createElement('img');
      img.className = 'feed-thumb';
      img.src = event.image_url;
      img.alt = '';
      img.loading = 'lazy';
      li.append(img);
    }

    const body = document.createElement('div');

    const badge = document.createElement('span');
    badge.className = `badge ${
      { restock: 'in', new: 'pre', sold_out: 'out' }[event.type] ?? 'pre'
    }`;
    badge.textContent = FEED_LABEL[event.type] ?? event.type;

    const title = document.createElement('a');
    title.className = 'feed-title';
    title.href = event.url;
    title.target = '_blank';
    title.rel = 'noopener';
    title.textContent = event.title;

    const meta = document.createElement('span');
    meta.className = 'feed-meta';
    const price = money(event.price, event.currency) ?? 'Price TBA';
    meta.textContent =
      `${price} · ${event.site_name} · ${new Date(event.created_at).toLocaleString()}`;

    body.append(badge, title, meta);
    li.append(body);
    list.append(li);
  }
}

// Which feed address the box is offering. "Everything" is the default because
// it is what the address is usually wanted for — the watchlist feed is the
// narrower, opt-in case, and offering it first made the whole feed look scoped
// to a handful of ticked products when it never was.
let feedScope = 'all';

function syncFeedControls() {
  const canScope = state.signedIn && state.feedToken;
  if (!canScope) feedScope = 'all';

  const mine = feedScope === 'mine';
  $('#feed-url').value = mine
    ? `${location.origin}/feed/${state.feedToken}.xml`
    : `${location.origin}/feed.xml?type=all`;
  $('#feed-url-note').textContent = mine
    ? 'Only the products on your watchlist. Treat it as private — anyone with the link can read it.'
    : 'Every restock, new listing and sell-out across every watched store.';

  for (const button of $('#feed-scope').querySelectorAll('button')) {
    button.classList.toggle('active', (button.dataset.scope === 'mine') === mine);
    button.disabled = button.dataset.scope === 'mine' && !canScope;
  }

  // Always typable. Reaching this page at all means being signed in, and the
  // alert is worth saving before a delivery channel is set up — gating the box
  // on having one made it look broken to anyone using push.
  // Loose on words, exact on codes: "one piece" also finds OnePiece and OP,
  // while "OP-17" finds only OP-17 and OP17 — never OP-18.
  $('#keyword-hint').textContent = hasChannel()
    ? 'One term at a time. “one piece” also finds OnePiece and OP; “OP-17” matches only that set.'
    : 'Add terms now, but nothing can reach you yet — turn on push notifications under Account.';
  loadAlerts();
}

async function loadFeed() {
  $('#feed-status').textContent = 'Loading updates…';
  try {
    const data = await api('/api/events?type=all');
    const events = data.events ?? [];
    $('#feed-status').textContent = events.length
      ? `${events.length} update${events.length === 1 ? '' : 's'}`
      : '';
    renderFeedItems(events);
  } catch (err) {
    $('#feed-status').textContent = err.data?.message ?? err.message;
    $('#feed-list').replaceChildren();
  }
}

/** Swap between the pre-order grid and the updates list. */
function showFeed(on) {
  showingFeed = on;
  applyView();
  if (on) {
    syncFeedControls();
    loadFeed();
  }
}

// The watchlist as a view over the same grid, so the store dropdown, search
// and sort keep working — a separate screen would have had to grow its own.
$('#watched-btn').addEventListener('click', async () => {
  state.watchedOnly = !state.watchedOnly;
  if (showingFeed) showFeed(false);
  applyView();
  await loadProducts();
});

$('#feed-scope').addEventListener('click', (e) => {
  const scope = e.target.closest('button')?.dataset.scope;
  if (!scope) return;
  feedScope = scope;
  syncFeedControls();
});

$('#feed-btn').addEventListener('click', () => showFeed(!showingFeed));
$('#feed-back-btn').addEventListener('click', () => showFeed(false));

// --- standing alerts --------------------------------------------------------
//
// One term at a time, each row carrying its own two switches. A single
// comma-separated field could not express them: it had no way to say that
// "pokemon" should only tell you while "OP-17" should also arm the buyer.

function renderAlerts() {
  const list = $('#alert-list');
  list.replaceChildren();

  if (!state.alerts.length) {
    const li = document.createElement('li');
    li.className = 'alert-empty';
    li.textContent = 'No alerts yet. Add a title, a series, or an exact set code like OP-17.';
    list.append(li);
    return;
  }

  for (const alert of state.alerts) {
    const li = document.createElement('li');
    li.className = 'alert-row';

    const term = document.createElement('span');
    term.className = 'alert-term';
    term.textContent = alert.term;

    const switches = document.createElement('span');
    switches.className = 'alert-switches';

    const make = (field, label, title, extraClass = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `alert-switch ${extraClass} ${alert[field] ? 'on' : ''}`.trim();
      button.textContent = label;
      button.title = title;
      button.addEventListener('click', async () => {
        button.disabled = true;
        $('#alert-error').hidden = true;
        try {
          const data = await api(`/api/alerts/${alert.id}`, {
            method: 'PATCH',
            body: { [field]: !alert[field] },
          });
          Object.assign(alert, data.alert);
          renderAlerts();
        } catch (err) {
          showError('#alert-error', err.data?.message ?? err.message);
          button.disabled = false;
        }
      });
      return button;
    };

    switches.append(
      make('notify', 'Notify', 'Send a notification when this matches'),
      make('autobuy', 'Auto-buy', 'Hand the match to the buyer script, which opens the product', 'buy'),
    );

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'alert-remove';
    remove.textContent = '×';
    remove.title = `Delete "${alert.term}"`;
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api(`/api/alerts/${alert.id}`, { method: 'DELETE' });
        state.alerts = state.alerts.filter((a) => a.id !== alert.id);
        renderAlerts();
      } catch (err) {
        showError('#alert-error', err.data?.message ?? err.message);
        remove.disabled = false;
      }
    });

    li.append(term, switches, remove);
    list.append(li);
  }
}

async function loadAlerts() {
  try {
    const data = await api('/api/alerts');
    state.alerts = data.alerts ?? [];
  } catch {
    state.alerts = [];
  }
  renderAlerts();
}

async function addAlertTerm() {
  const input = $('#keyword');
  const button = $('#keyword-save-btn');
  const term = input.value.trim();
  if (!term) return;

  button.disabled = true;
  button.textContent = 'Adding';
  $('#alert-error').hidden = true;
  try {
    const data = await api('/api/alerts', { method: 'POST', body: { term } });
    state.alerts = [...state.alerts, data.alert].sort((a, b) =>
      a.term.localeCompare(b.term),
    );
    input.value = '';
    renderAlerts();
    input.focus();
  } catch (err) {
    showError('#alert-error', err.data?.message ?? err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Add';
  }
}

$('#keyword-save-btn').addEventListener('click', addAlertTerm);
$('#keyword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addAlertTerm();
  }
});

$('#signout-btn').addEventListener('click', async () => {
  await api('/api/signout', { method: 'POST' });
  resetToSignedOut();
});

$('#unsub-btn').addEventListener('click', async () => {
  if (!confirm('Stop all alerts and clear your watchlist?')) return;
  await api('/api/unsubscribe', { method: 'POST' });
  resetToSignedOut();
});

$('#account-btn').addEventListener('click', () =>
  openDialog(state.signedIn || state.username ? 'account' : 'login'),
);

// --- accounts ---------------------------------------------------------------

/** Adopt whatever the server just told us about who we are. */
function adoptSession(data) {
  state.signedIn = Boolean(data.phone);
  state.phone = data.phone ?? null;
  state.username = data.username ?? null;
  state.hasAccount = true;
  state.feedToken = data.feedToken ?? state.feedToken;
  state.notify = data.notify ?? {};
  state.saved = new Set(data.watches ?? []);
  state.selected = new Set(state.saved);
}

$('#to-phone-btn').addEventListener('click', () => openDialog('phone'));
$('#add-phone-btn').addEventListener('click', () => openDialog('phone'));
$('#pass-back-btn').addEventListener('click', () => openDialog('account'));
$('#change-pass-btn').addEventListener('click', () => openDialog('password'));

/** Whether anything can actually reach this person right now. */
function hasChannel() {
  return Boolean(state.push?.enabled || (state.smsEnabled && state.signedIn));
}

/** The one-line summary of who you are and where alerts go. */
function renderIdentity() {
  const bits = [];
  if (state.username) bits.push(`Signed in as ${state.username}`);
  if (state.phone && state.smsEnabled) bits.push(`texts go to ${state.phone}`);
  if (state.push?.enabled) bits.push('alerts go to your ntfy app');
  $('#account-identity').textContent = bits.length
    ? `${bits.join(' · ')}.`
    : 'No alert channel yet — turn on push notifications below.';
}

/** Reflect the current push state into the account pane. */
function renderPush() {
  renderIdentity();
  const { enabled, topic, url } = state.push ?? {};
  $('#push-state').textContent = enabled
    ? 'On. Alerts arrive in the ntfy app.'
    : 'Free, and no phone number needed.';
  $('#push-toggle').textContent = enabled ? 'Turn off' : 'Turn on';
  $('#push-toggle').classList.toggle('on', Boolean(enabled));
  $('#push-setup').hidden = !enabled || !topic;
  if (topic) {
    $('#push-topic').value = topic;
    $('#push-link').href = url ?? '#';
  }
}

$('#push-toggle').addEventListener('click', async () => {
  const button = $('#push-toggle');
  const next = !state.push?.enabled;
  button.disabled = true;
  $('#push-error').hidden = true;
  try {
    const data = await api('/api/push', { method: 'PUT', body: { enabled: next } });
    state.push = { enabled: data.enabled, topic: data.topic, url: data.url };
    renderPush();
  } catch (err) {
    // A failure here usually means the topic was never subscribed to, so say
    // what to do rather than only what broke.
    showError('#push-error', err.data?.message ?? err.message);
    if (err.data?.topic) {
      state.push = { enabled: false, topic: err.data.topic, url: err.data.url };
      renderPush();
    }
  } finally {
    button.disabled = false;
  }
});

$('#push-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#push-topic').value).catch(() => {});
  $('#push-copy').textContent = 'Copied';
  setTimeout(() => ($('#push-copy').textContent = 'Copy'), 1500);
});

$('#push-rotate').addEventListener('click', async () => {
  if (!confirm('Issue a new topic? The old one stops working and you must resubscribe.')) return;
  try {
    const data = await api('/api/push/rotate', { method: 'POST' });
    state.push = { enabled: data.enabled, topic: data.topic, url: data.url };
    renderPush();
  } catch (err) {
    showError('#push-error', err.data?.message ?? err.message);
  }
});

$('#login-btn').addEventListener('click', async () => {
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: { username: $('#login-user').value, password: $('#login-pass').value },
    });
    // Never leave a password sitting in the DOM once it has been used.
    $('#login-pass').value = '';
    adoptSession(data);
    renderAccount();
    renderGrid();
    renderTray();
    dialog.close();
  } catch (err) {
    showError('#login-error', err.data?.message ?? err.message);
  }
});

$('#password-btn').addEventListener('click', async () => {
  try {
    await api('/api/password', {
      method: 'PUT',
      body: { currentPassword: $('#cur-pass').value, newPassword: $('#new-pass').value },
    });
    $('#cur-pass').value = '';
    $('#new-pass').value = '';
    openDialog('account');
  } catch (err) {
    showError('#pass-error', err.data?.message ?? err.message);
  }
});

// Enter submits whichever form you are in.
for (const [field, button] of [
  ['#login-pass', '#login-btn'],
  ['#login-user', '#login-btn'],
  ['#new-pass', '#password-btn'],
]) {
  $(field).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $(button).click();
    }
  });
}

// --- controls ---------------------------------------------------------------

// Watching is open to anyone: the server issues a session on demand, so there
// is nothing to sign into. A phone is only needed to be texted, and that is
// asked for on the toggle that actually needs it.
$('#save-btn').addEventListener('click', () => saveWatches());

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

$('#type-filter').addEventListener('change', (e) => {
  state.type = e.target.value;
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
    // 401 has already sent us to the login page; stop rather than throwing an
    // error nobody will ever see against a page that is being navigated away.
    if (err.status === 401) return;
    $('#status').textContent = `Could not start: ${err.message}`;
    return;
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

// A failure here used to leave the page reading "Loading…" forever, which is
// indistinguishable from a server that never answered. Whatever goes wrong,
// say so on the page rather than only in a console nobody has open.
await boot().catch((err) => {
  console.error('[boot]', err);
  $('#status').hidden = false;
  $('#status').textContent = `Could not start: ${err.message}`;
});

// A ?t=<feedToken> link (the one included in every alert text) opens the
// account pane directly.
const linkToken = new URLSearchParams(location.search).get('t');
if (linkToken && state.signedIn && linkToken === state.feedToken) {
  openDialog('account');
  history.replaceState({}, '', location.pathname);
}
