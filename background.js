const LEADS_STORAGE_KEY = 'leads';

function nowTs() {
  return Date.now();
}

function normalizeUrl(url) {
  if (!url) return '';
  return String(url).trim();
}

async function getLeads() {
  const result = await chrome.storage.local.get([LEADS_STORAGE_KEY]);
  return result[LEADS_STORAGE_KEY] || [];
}

async function setLeads(leads) {
  await chrome.storage.local.set({ [LEADS_STORAGE_KEY]: leads });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'LEAD_URL_COLLECTED') {
        const { name, url } = message;
        const cleanUrl = normalizeUrl(url);
        if (!cleanUrl) {
          return;
        }

        const leads = await getLeads();
        const exists = leads.some((l) => l.url === cleanUrl);
        if (!exists) {
          leads.push({
            name: String(name || '').trim(),
            url: cleanUrl,
            timestamp: nowTs()
          });
          await setLeads(leads);
        }

        // Optional: return updated count.
        sendResponse?.({ ok: true, count: (await getLeads()).length });
        return;
      }

      if (message.type === 'GET_LEADS') {
        const leads = await getLeads();
        sendResponse?.({ ok: true, leads });
        return;
      }

      if (message.type === 'CLEAR_LEADS') {
        await setLeads([]);
        sendResponse?.({ ok: true });
        return;
      }

      // Popup start settings: ensure content script can read them via storage.
      if (message.type === 'PING') {
        sendResponse?.({ ok: true });
      }
    } catch (err) {
      console.error('[background] error:', err);
      sendResponse?.({ ok: false, error: String(err?.message || err) });
    }
  })();

  // Keep the message channel open for async.
  return true;
});

