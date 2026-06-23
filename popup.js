const LEADS_STORAGE_KEY = 'leads';
const SETTINGS_STORAGE_KEY = 'settings';

function $(id) {
  return document.getElementById(id);
}

function escapeCsvCell(s) {
  const str = String(s ?? '');
  if (/[\n\r",]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function getLeads() {
  const result = await chrome.storage.local.get([LEADS_STORAGE_KEY]);
  return result[LEADS_STORAGE_KEY] || [];
}

async function setSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

async function loadSettingsIntoUI() {
  const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY]);
  const s = result[SETTINGS_STORAGE_KEY] || {};
  $('collectAll').checked = Boolean(s.collectAllPages);
  const delay = Number.isFinite(Number(s.delayMs)) ? Number(s.delayMs) : 650;
  $('delay').value = String(delay);
}

function renderLeads(leads) {
  const tbody = $('tbody');
  tbody.innerHTML = '';

  $('count').textContent = String(leads.length);

  // Keep UI light: show up to e.g. 250 rows.
  const maxRows = 250;
  const visible = leads.slice(0, maxRows);

  for (const lead of visible) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = lead.name || '';

    const tdUrl = document.createElement('td');
    tdUrl.className = 'url';

    const a = document.createElement('a');
    a.href = lead.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = lead.url;
    a.className = 'mutedLink';

    tdUrl.appendChild(a);

    tr.appendChild(tdName);
    tr.appendChild(tdUrl);
    tbody.appendChild(tr);
  }

  if (leads.length > maxRows) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.className = 'small';
    td.textContent = `Showing first ${maxRows} of ${leads.length} leads in popup.`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function refresh() {
  const leads = await getLeads();
  renderLeads(leads);
}

$('start').addEventListener('click', async () => {
  $('sub').textContent = 'Starting…';
  const delayMs = Math.max(0, Number($('delay').value || 0));
  const collectAllPages = $('collectAll').checked;

  await setSettings({ delayMs, collectAllPages });

  // Let content.js read storage settings; then trigger collection.
  await chrome.runtime.sendMessage({ type: 'PING' }).catch(() => {});
  await chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) throw new Error('No active tab');

    chrome.tabs.sendMessage(tab.id, {
      type: 'START_COLLECTING'
    });
  });

  $('sub').textContent = 'Collecting on page… (check count update)';
  // Poll refresh for a short time.
  const start = Date.now();
  const poll = async () => {
    await refresh();
    if (Date.now() - start < 60000) setTimeout(poll, 1500);
  };
  setTimeout(poll, 1000);
});

$('export').addEventListener('click', async () => {
  const leads = await getLeads();
  const header = ['Name', 'LinkedIn URL', 'Collected At'].map(escapeCsvCell).join(',');
  const rows = leads.map((l) => [l.name, l.url, new Date(l.timestamp || Date.now()).toISOString()]
    .map(escapeCsvCell)
    .join(',')
  );

  const csv = [header, ...rows].join('\n');
  const filename = `linkedin-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  downloadText(filename, csv);
  $('sub').textContent = 'CSV downloaded.';
});

$('copy').addEventListener('click', async () => {
  const leads = await getLeads();
  const urls = leads.map((l) => l.url).filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(urls);
    $('sub').textContent = `Copied ${leads.length} URLs.`;
  } catch (e) {
    $('sub').textContent = 'Clipboard copy failed (browser permission).';
    console.error(e);
  }
});

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ [LEADS_STORAGE_KEY]: [] });
  $('sub').textContent = 'Cleared.';
  await refresh();
});

// Initialize
(async () => {
  await loadSettingsIntoUI();
  await refresh();
  $('sub').textContent = 'Ready';
})();

