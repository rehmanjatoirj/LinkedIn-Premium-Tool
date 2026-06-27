const { MSG, SCRAPER_LINKEDIN, SCRAPER_MAPS, SETTINGS_STORAGE_KEY } = ScraperConstants;

const CONTENT_SCRIPTS = {
  [SCRAPER_LINKEDIN]: [
    'shared/module-loader.js',
    'shared/constants.js',
    'shared/utils.js',
    'shared/selectors.js',
    'shared/network-intercept.js',
    'shared/retry-queue.js',
    'shared/watchdog.js',
    'shared/preflight.js',
    'scrapers/linkedin-sales.js',
    'content-linkedin.js'
  ],
  [SCRAPER_MAPS]: [
    'shared/module-loader.js',
    'shared/constants.js',
    'shared/utils.js',
    'shared/selectors.js',
    'shared/network-intercept.js',
    'shared/retry-queue.js',
    'shared/watchdog.js',
    'shared/preflight.js',
    'scrapers/google-maps.js',
    'content-maps.js'
  ]
};

function $(id) {
  return document.getElementById(id);
}

let currentScraperType = null;
let pollTimer = null;

function detectScraperType(url) {
  if (!url) return null;
  if (/linkedin\.com\/sales/i.test(url)) return SCRAPER_LINKEDIN;
  if (/google\.com\/maps|maps\.google\.com/i.test(url)) return SCRAPER_MAPS;
  return null;
}

function scraperLabel(type) {
  if (type === SCRAPER_LINKEDIN) return 'LinkedIn';
  if (type === SCRAPER_MAPS) return 'Google Maps';
  return 'Unsupported';
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${seconds % 60}s`;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function getRecords() {
  let scraperType = currentScraperType;
  if (!scraperType) {
    const state = await getState();
    scraperType = state.scraperType;
  }
  const response = await chrome.runtime.sendMessage({
    type: MSG.GET_RECORDS,
    scraperType
  });
  return response?.records || [];
}

async function getState() {
  const response = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
  return response?.state || { status: 'idle' };
}

async function setSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

async function loadSettingsIntoUI() {
  const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY]);
  const s = result[SETTINGS_STORAGE_KEY] || {};
  $('collectAll').checked = Boolean(s.collectAllPages);
  $('delay').value = String(Number.isFinite(Number(s.delayMs)) ? Number(s.delayMs) : 650);
  const mapsMax = Number.isFinite(Number(s.mapsMaxResults)) ? Number(s.mapsMaxResults) : 20;
  $('mapsMax').value = String(Math.min(100, Math.max(1, mapsMax)));
}

function setBadge(type, isError) {
  const badge = $('scraperBadge');
  badge.textContent = scraperLabel(type);
  badge.className = 'badge' + (isError ? ' error' : type === SCRAPER_MAPS ? ' maps' : ' linkedin');
}

function setScraperModeUI(type) {
  const isMaps = type === SCRAPER_MAPS;
  const isLinkedIn = type === SCRAPER_LINKEDIN;

  $('mapsSettings').classList.toggle('hidden', !isMaps);
  $('linkedinSettings').classList.toggle('hidden', !isLinkedIn);

  const startBtn = $('start');
  startBtn.classList.toggle('maps-mode', isMaps);
  startBtn.textContent = isMaps ? 'Start Collecting Businesses' : 'Start Scraping Leads';

  $('countLabel').textContent = isMaps ? 'Businesses collected' : 'Leads collected';
  $('recordsTitle').textContent = isMaps ? 'Businesses' : 'Recent Leads';
  $('brandSub').textContent = isMaps ? 'Full contact details from Maps' : isLinkedIn ? 'Sales Navigator leads' : 'Sales & local leads';
  $('copy').textContent = isMaps ? 'Copy Leads (name · phone · email · address)' : 'Copy Leads (name · email · phone · profile url)';

  const fill = $('progressFill');
  fill.classList.toggle('maps', isMaps);
}

function setStatusPill(status, stalled) {
  const pill = $('statusPill');
  const label = $('statusLabel');
  const labels = {
    idle: 'Idle',
    running: 'Running',
    paused: 'Paused',
    complete: 'Complete',
    stopped: 'Stopped',
    error: 'Error'
  };

  let cls = status || 'idle';
  if (stalled && status === 'running') cls = 'error';

  pill.className = 'status-pill ' + cls;
  label.textContent = stalled && status === 'running' ? 'Recovering…' : (labels[cls] || cls);
}

function setStatusMessage(text, type) {
  const el = $('sub');
  el.textContent = text;
  el.className = 'status-msg' + (type ? ' ' + type : '');
}

function updateProgressUI(state) {
  const progress = state?.progress;
  const panel = $('progressPanel');
  const running = state?.status === 'running' || state?.status === 'paused';

  if (!progress || !running) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  const target = progress.total ?? 0;
  const saved = progress.success ?? 0;
  const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;

  $('progressFill').style.width = pct + '%';
  $('progTotal').textContent = target;
  $('progProcessed').textContent = progress.processed ?? 0;
  $('progRemaining').textContent = progress.remaining ?? Math.max(0, target - saved);
  $('progSuccess').textContent = saved;
  $('progSkipped').textContent = progress.skipped ?? 0;
  $('progEta').textContent = formatEta(progress.etaSeconds);
}

function updateControlButtons(state) {
  const status = state?.status || 'idle';
  $('start').disabled = status === 'running';
  $('pause').disabled = status !== 'running';
  $('resume').disabled = status !== 'paused';
  $('stop').disabled = status !== 'running' && status !== 'paused';
}

function renderRecords(records) {
  const container = $('recordsContainer');
  const empty = $('emptyState');
  container.innerHTML = '';

  $('count').textContent = String(records.length);
  $('recordsCountLabel').textContent = records.length ? `${records.length} total` : '';

  if (!records.length) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  const maxRows = 50;
  const visible = records.slice(-maxRows).reverse();

  for (const record of visible) {
    const item = document.createElement('div');
    item.className = 'record-item';

    const name = document.createElement('div');
    name.className = 'record-name';
    name.textContent = record.name || 'Unknown';
    name.title = record.name || '';
    item.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'record-meta';

    if (currentScraperType === SCRAPER_MAPS) {
      const parts = [];
      if (record.phone) parts.push('📞 ' + record.phone);
      if (record.email) parts.push('✉ ' + record.email);
      if (record.address) parts.push(record.address);
      if (record.website) parts.push('🌐 ' + record.website.replace(/^https?:\/\//, ''));
      if (record.category) parts.push(record.category);
      meta.textContent = parts.join(' · ') || 'No contact info yet';
      item.appendChild(meta);
    } else {
      const parts = [];
      if (record.email) parts.push('✉ ' + record.email);
      if (record.phone) parts.push('📞 ' + record.phone);
      if (record.title) parts.push(record.title);
      if (record.company) parts.push(record.company);
      if (record.location) parts.push(record.location);
      if (record.url) {
        const a = document.createElement('a');
        a.href = record.url;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.textContent = parts.length ? parts.join(' · ') : record.url;
        meta.appendChild(a);
      } else {
        meta.textContent = parts.join(' · ') || '—';
      }
      item.appendChild(meta);
    }

    container.appendChild(item);
  }

  if (records.length > maxRows) {
    const more = document.createElement('div');
    more.className = 'empty-state';
    more.style.padding = '12px';
    more.innerHTML = `<p>Showing latest ${maxRows} of ${records.length} leads.<br>Export to see all.</p>`;
    container.appendChild(more);
  }
}

async function refresh() {
  const records = await getRecords();
  renderRecords(records);
  const state = await getState();

  updateProgressUI(state);
  updateControlButtons(state);
  setStatusPill(state.status, state.stalled);

  if (state.status === 'complete') {
    const n = state.progress?.success ?? records.length;
    setStatusMessage(
      currentScraperType === SCRAPER_MAPS
        ? `Done — ${n} business${n === 1 ? '' : 'es'} saved with full details.`
        : `Done — ${n} lead${n === 1 ? '' : 's'} saved.`,
      ''
    );
    stopPolling();
  } else if (state.status === 'error') {
    setStatusMessage(state.error || 'Something went wrong.', 'error');
    stopPolling();
  } else if (state.stalled && state.stallMessage) {
    setStatusMessage(state.stallMessage, 'warn');
  } else if (state.status === 'running') {
    setStatusMessage(
      currentScraperType === SCRAPER_MAPS
        ? 'Clicking each result — loading full detail panel for phone & address…'
        : 'Scraping in progress…',
      ''
    );
  } else if (state.status === 'paused') {
    setStatusMessage('Paused — click Resume to continue.', 'warn');
  } else if (state.status === 'stopped') {
    setStatusMessage(`Stopped — ${records.length} lead${records.length === 1 ? '' : 's'} kept.`, 'warn');
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, 1200);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function isContentScriptReady(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: MSG.CONTENT_SCRIPT_PING
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function ensureContentScript(tab) {
  currentScraperType = detectScraperType(tab.url);
  if (!currentScraperType) {
    throw new Error('Open LinkedIn Sales Navigator or Google Maps in the active tab.');
  }

  if (await isContentScriptReady(tab.id)) {
    return currentScraperType;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: CONTENT_SCRIPTS[currentScraperType]
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  return currentScraperType;
}

async function sendToContentScript(messageType) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab found.');

  if (!(await isContentScriptReady(tab.id))) {
    await ensureContentScript(tab);
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: messageType });
    if (response?.ok === false) throw new Error(response.error || 'Content script error.');
    return response;
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection')) {
      await ensureContentScript(tab);
      const response = await chrome.tabs.sendMessage(tab.id, { type: messageType });
      if (response?.ok === false) throw new Error(response.error || 'Content script error.');
      return response;
    }
    throw err;
  }
}

$('start').addEventListener('click', async () => {
  try {
    setStatusMessage('Running pre-flight check…', '');

    const tab = await getActiveTab();
    currentScraperType = detectScraperType(tab?.url);

    if (!currentScraperType) {
      setStatusMessage('Open LinkedIn Sales Navigator or Google Maps search results, then try again.', 'warn');
      return;
    }

    setBadge(currentScraperType);
    setScraperModeUI(currentScraperType);

    const preflight = await sendToContentScript(MSG.PREFLIGHT_CHECK);
    if (!preflight?.ok) {
      setStatusMessage(preflight?.message || preflight?.error || 'Pre-flight check failed.', 'warn');
      return;
    }

    setStatusMessage(preflight.message || 'Starting…', '');

    if (currentScraperType === SCRAPER_LINKEDIN) {
      await setSettings({
        delayMs: Math.max(0, Number($('delay').value || 0)),
        collectAllPages: $('collectAll').checked
      });
    } else {
      await setSettings({
        mapsMaxResults: Math.min(100, Math.max(1, Number($('mapsMax').value || 20)))
      });
    }

    await chrome.runtime.sendMessage({ type: MSG.PING }).catch(() => {});

    const response = await sendToContentScript(MSG.START_SCRAPING);
    if (response?.error) throw new Error(response.error);

    setStatusMessage(
      currentScraperType === SCRAPER_MAPS
        ? `Clicking up to ${$('mapsMax').value || 20} results — extracting full contact details…`
        : 'Extracting leads…',
      ''
    );

    setStatusPill('running');
    updateControlButtons({ status: 'running' });
    startPolling();
  } catch (err) {
    console.error('[popup] start failed:', err);
    setStatusMessage(err.message || 'Failed to start.', 'error');
    setStatusPill('error');
  }
});

$('pause').addEventListener('click', async () => {
  try {
    await sendToContentScript(MSG.PAUSE_SCRAPING);
    setStatusPill('paused');
    await refresh();
  } catch (err) {
    setStatusMessage(err.message, 'error');
  }
});

$('resume').addEventListener('click', async () => {
  try {
    await sendToContentScript(MSG.RESUME_SCRAPING);
    setStatusPill('running');
    startPolling();
    await refresh();
  } catch (err) {
    setStatusMessage(err.message, 'error');
  }
});

$('stop').addEventListener('click', async () => {
  try {
    await sendToContentScript(MSG.STOP_SCRAPING);
    setStatusMessage('Stopping…', 'warn');
    stopPolling();
    await refresh();
  } catch (err) {
    setStatusMessage(err.message, 'error');
  }
});

function bindExport(buttonId, format) {
  $(buttonId).addEventListener('click', async () => {
    const state = await getState();
    const exportType = currentScraperType || state.scraperType || SCRAPER_LINKEDIN;
    const records = await getRecords();
    if (!records.length) {
      setStatusMessage('No records to export — run a scrape first.', 'warn');
      return;
    }
    ScraperExport.exportRecords(records, exportType, format);
    setStatusMessage(`${format.toUpperCase()} downloaded (${records.length} records).`, '');
  });
}

bindExport('exportCsv', 'csv');
bindExport('exportExcel', 'excel');
bindExport('exportJson', 'json');

$('copy').addEventListener('click', async () => {
  const records = await getRecords();
  if (!records.length) {
    setStatusMessage('Nothing to copy yet.', 'warn');
    return;
  }

  const text = currentScraperType === SCRAPER_MAPS
    ? records.map((r) => [r.name, r.phone, r.email, r.address, r.website, r.url].filter(Boolean).join(' | ')).join('\n')
    : records.map((r) => [r.name, r.email, r.phone, r.title, r.company, r.url].filter(Boolean).join(' | ')).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    setStatusMessage(`Copied ${records.length} lead${records.length === 1 ? '' : 's'} to clipboard.`, '');
  } catch {
    setStatusMessage('Clipboard access denied.', 'error');
  }
});

$('clear').addEventListener('click', async () => {
  const records = await getRecords();
  if (!records.length) {
    setStatusMessage('Nothing to clear.', 'warn');
    return;
  }
  if (!confirm(`Clear all ${records.length} record${records.length === 1 ? '' : 's'}?`)) return;

  await chrome.runtime.sendMessage({ type: MSG.CLEAR_RECORDS });
  setStatusMessage('All records cleared.', '');
  setStatusPill('idle');
  stopPolling();
  await refresh();
});

(async () => {
  const tab = await getActiveTab();
  currentScraperType = detectScraperType(tab?.url);
  setBadge(currentScraperType, !currentScraperType);

  if (!currentScraperType) {
    setStatusMessage('Navigate to LinkedIn Sales Navigator or Google Maps, then reopen this popup.', 'warn');
    setStatusPill('idle');
    $('start').disabled = true;
    $('mapsSettings').classList.add('hidden');
    $('linkedinSettings').classList.add('hidden');
  } else {
    setScraperModeUI(currentScraperType);
    setStatusMessage('Ready — click Start when search results are visible.', '');
    setStatusPill('idle');
  }

  await loadSettingsIntoUI();
  await refresh();

  const state = await getState();
  if (state.status === 'running' || state.status === 'paused') {
    startPolling();
  }
})();
