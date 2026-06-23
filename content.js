// LinkedIn DOM is dynamic and selectors often change.
// This file uses multiple fallback selectors and includes heavy console logging.

const SETTINGS_STORAGE_KEY = 'settings';

const DEFAULT_DELAY_MS = 650;
const DEFAULT_MENU_WAIT_MS = 2500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

async function getSettings() {
  const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY]);
  const s = result[SETTINGS_STORAGE_KEY] || {};
  const delayMs = Number.isFinite(Number(s.delayMs)) ? Number(s.delayMs) : DEFAULT_DELAY_MS;
  const collectAllPages = Boolean(s.collectAllPages);
  return { delayMs, collectAllPages };
}

function getLeadRowCandidates() {
  // Fallback approach: Sales Nav search results rows usually contain a “...” overflow button.
  // We find rows by locating the overflow button and walking up.

  // Candidate overflow/3-dots buttons.
  const moreBtnSelectors = [
    'button[aria-label*="More actions" i]',
    'button[aria-label*="More" i]',
    'button[aria-haspopup="menu"]',
    'button[role="button"]'
  ];

  const buttons = [];
  for (const sel of moreBtnSelectors) {
    document.querySelectorAll(sel).forEach((b) => buttons.push(b));
  }

  // Deduplicate by element identity.
  const uniqueButtons = Array.from(new Set(buttons));

  // For each more button, climb a bit to find a row-like container.
  const rows = [];
  for (const btn of uniqueButtons) {
    const container = btn.closest('[role="row"], li, div') || btn.parentElement;
    if (!container) continue;
    rows.push(container);
  }

  // Deduplicate rows.
  return Array.from(new Set(rows));
}

function extractLeadNameFromRow(row) {
  // Name may be present as visible text inside the row.
  // This is heuristic: it strips common junk and tries to use the first prominent text.
  const txt = normalizeText(row.innerText);
  if (!txt) return '';

  // Remove typical UI noise.
  const cleaned = txt
    .replace(/\b(people|leads|search|filter|follow|message|connect|view profile|view\s+profile)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Try to return first chunk as name.
  const parts = cleaned.split('—').map((p) => normalizeText(p)).filter(Boolean);
  if (parts.length >= 1 && parts[0].length >= 2) return parts[0].slice(0, 120);

  // Otherwise take first sentence/chunk.
  return cleaned.split(' ').slice(0, 6).join(' ');
}

function findRowMoreButton(row) {
  const selCandidates = [
    'button[aria-label*="More actions" i]',
    'button[aria-label*="More" i]',
    'button[aria-haspopup="menu"]',
    'button[role="button"]'
  ];

  for (const sel of selCandidates) {
    const btn = row.querySelector(sel);
    if (btn) return btn;
  }

  // Common LinkedIn overflow patterns: three dots svg inside button.
  const allButtons = row.querySelectorAll('button');
  for (const b of allButtons) {
    const aria = normalizeText(b.getAttribute('aria-label'));
    if (/more/i.test(aria) || b.querySelector('svg')) return b;
  }
  return null;
}

function findCopyUrlMenuItem() {
  const menuTextCandidates = ['Copy LinkedIn.com URL', 'Copy LinkedIn URL', 'Copy URL'];

  // Menu item often is a button/div within a popup menu.
  const items = document.querySelectorAll(
    '[role="menu"], [role="menuitem"], div[role="presentation"], ul[role]'
  );

  // First try direct text match among typical menu item elements.
  const candidates = document.querySelectorAll('button, span, div[role="menuitem"], [role="menuitem"], a');
  for (const el of candidates) {
    const t = normalizeText(el.textContent);
    if (!t) continue;
    if (menuTextCandidates.some((c) => t.toLowerCase().includes(c.toLowerCase()))) {
      return el.closest('button, [role="menuitem"], div') || el;
    }
  }

  // Fallback: find any element whose text looks like copy url.
  for (const el of candidates) {
    const t = normalizeText(el.textContent);
    if (/copy/i.test(t) && /url/i.test(t)) {
      return el.closest('button, [role="menuitem"], div') || el;
    }
  }

  return null;
}

function findNextPageButton() {
  // Multiple fallbacks.
  const selectors = [
    'button[aria-label*="Next" i]',
    'button[aria-disabled="false"][aria-label*="Next" i]',
    'button[title*="Next" i]',
    'button:has(span[aria-label*="Next" i])',
    '[aria-label*="Next" i]'
  ];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const disabled = el.getAttribute('aria-disabled') === 'true' || el.disabled;
        if (!disabled) return el;
      }
    } catch {
      // :has may not be supported; ignore.
    }
  }

  // Try link/button with text.
  const btns = document.querySelectorAll('button, a');
  for (const b of btns) {
    const t = normalizeText(b.textContent);
    if (/^next$/i.test(t) || /next\s+page/i.test(t)) return b;
  }
  return null;
}

async function waitForMenuToRender(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Look for any visible menu.
    const anyMenu = document.querySelector('[role="menu"], .artdeco-dropdown__content, [data-test-id]');
    if (anyMenu) {
      // Also ensure we can find the item (best-effort).
      const item = findCopyUrlMenuItem();
      if (item) return true;
    }
    await sleep(150);
  }
  return false;
}

async function closeDropdownBestEffort() {
  // Try ESC first.
  try {
    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
    document.dispatchEvent(esc);
  } catch {}
  // click outside
  await sleep(100);
  document.body.click();
}

async function readClipboardTextWithFallback() {
  // Content scripts can often use navigator.clipboard with permissions.
  // As fallback, we just attempt the clipboard read; if it fails, return ''.
  try {
    if (navigator.clipboard?.readText) {
      const txt = await navigator.clipboard.readText();
      return normalizeText(txt);
    }
  } catch (e) {
    console.warn('[content] clipboard readText failed:', e);
  }
  return '';
}

async function collectLeadsFromCurrentPage({ delayMs, collectAllPages }) {
  const processedUrls = new Set();

  // Small delay for page stabilization
  await sleep(1200);

  let pageLoopGuard = 0;
  while (true) {
    pageLoopGuard++;
    console.log('[content] Collect loop iteration', pageLoopGuard);

    const leadRows = getLeadRowCandidates();
    console.log('[content] Lead row candidates:', leadRows.length);

    let idx = 0;
    for (const row of leadRows) {
      idx++;
      try {
        const name = extractLeadNameFromRow(row);
        const moreBtn = findRowMoreButton(row);

        if (!moreBtn) {
          console.log('[content] No more button for row', idx);
          continue;
        }

        console.log('[content] Processing row', idx, 'name=', name);

        // Open dropdown.
        moreBtn.click();
        await sleep(120);

        const menuReady = await waitForMenuToRender(DEFAULT_MENU_WAIT_MS);
        if (!menuReady) {
          console.log('[content] Menu not ready / copy option not found for', name);
          await closeDropdownBestEffort();
          continue;
        }

        const copyItem = findCopyUrlMenuItem();
        if (!copyItem) {
          console.log('[content] Copy menu item not found for', name);
          await closeDropdownBestEffort();
          continue;
        }

        console.log('[content] Clicking copy menu item for', name);
        copyItem.click();

        // Give clipboard & UI time to update.
        await sleep(350);

        const clipboardText = await readClipboardTextWithFallback();
        if (!clipboardText) {
          console.log('[content] Clipboard empty after click for', name);
          await closeDropdownBestEffort();
          continue;
        }

        // In many cases clipboard text is a URL. Keep best-effort URL extraction.
        const urlMatch = clipboardText.match(/https?:\/\/[^\s]+/i);
        const url = urlMatch ? urlMatch[0] : clipboardText;

        if (processedUrls.has(url)) {
          console.log('[content] Duplicate URL locally, skipping', url);
          await closeDropdownBestEffort();
          continue;
        }

        processedUrls.add(url);

        console.log('[content] Sending lead collected', { name, url });
        chrome.runtime.sendMessage({
          type: 'LEAD_URL_COLLECTED',
          name,
          url
        });

        await closeDropdownBestEffort();

        // Throttle between leads.
        await sleep(delayMs);
      } catch (err) {
        console.error('[content] error processing lead row:', err);
      }
    }

    if (!collectAllPages) {
      console.log('[content] collectAllPages=false, stopping after current page');
      break;
    }

    // Pagination: wait for next button and click.
    const nextBtn = findNextPageButton();
    if (!nextBtn) {
      console.log('[content] Next button not found; stopping');
      break;
    }

    const prevUrl = location.href;
    console.log('[content] Clicking Next page button');
    nextBtn.click();

    // Wait for results to change: observe DOM mutations with timeout.
    const start = Date.now();
    let changed = false;
    const marker = document.body;

    await new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        // Heuristic: URL changes or lead rows count changes.
        if (location.href !== prevUrl || document.querySelectorAll('a[href*="/sales/lead/"]').length > 0) {
          // not reliable; still proceed slowly
        }
        changed = true;
        obs.disconnect();
        resolve();
      });
      obs.observe(marker, { childList: true, subtree: true });

      setTimeout(() => {
        obs.disconnect();
        resolve();
      }, 2500);
    });

    console.log('[content] Pagination wait done. changed=', changed);

    // If no change after some time, stop.
    if (!changed && Date.now() - start > 2000) {
      console.log('[content] No visible DOM change after Next; stopping');
      break;
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'START_COLLECTING') return;

  (async () => {
    console.log('[content] START_COLLECTING received');

    const { delayMs, collectAllPages } = await getSettings();
    console.log('[content] settings', { delayMs, collectAllPages });

    try {
      await collectLeadsFromCurrentPage({ delayMs, collectAllPages });
      console.log('[content] Collection finished');
    } catch (err) {
      console.error('[content] Collection failed:', err);
    }
  })();
});

