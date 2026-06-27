/* global ScraperConstants, ScraperUtils, SelectorConfig, NetworkIntercept, RetryQueue, Watchdog, PreflightCheck, __scraperDefine */
__scraperDefine('LinkedInSalesScraper', () => {
  const SCOPE = 'linkedin';

  const TIMING = {
    scrollSettle: 200,
    panelPollMs: 100,
    panelTimeoutMs: 12000,
    panelSettle: 200,
    closePanel: 200,
    retryGap: 350,
    batchScroll: 250,
    startup: 400
  };

  let sel = {};
  let attemptedCardKeys = new Set();
  let savedRecordKeys = new Set();
  let linkedinSettings = {
    linkedinMaxResults: 25,
    delayMs: 400,
    collectAllPages: false,
    fetchContactFromPanel: true
  };
  let progress = {
    total: 0, processed: 0, success: 0, failed: 0, skipped: 0, startTime: 0, elapsedMs: 0
  };

  function keysForRecord(record) {
    const keys = new Set();
    if (record.salesLeadId) keys.add(`sales:${record.salesLeadId}`);
    const slug = record.url?.match(/\/in\/([^/?#]+)/i)?.[1];
    if (slug) {
      keys.add(`in:${slug.toLowerCase()}`);
      keys.add(`https://www.linkedin.com/in/${slug.toLowerCase()}`);
    }
    if (record.recordKey) keys.add(record.recordKey);
    const name = ScraperUtils.normalizeText(record.name).toLowerCase();
    const company = ScraperUtils.normalizeText(record.company).toLowerCase();
    if (name) keys.add(`name:${name}|${company}`);
    return keys;
  }

  function rememberRecordKeys(record) {
    for (const key of keysForRecord(record)) savedRecordKeys.add(key);
  }

  function isKnownLead(record) {
    for (const key of keysForRecord(record)) {
      if (savedRecordKeys.has(key)) return true;
    }
    return false;
  }
  async function loadExistingRecordKeys() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: ScraperConstants.MSG.GET_RECORDS,
        scraperType: ScraperConstants.SCRAPER_LINKEDIN
      });
      const records = response?.records || [];
      for (const record of records) rememberRecordKeys(record);
      if (records.length) {
        ScraperUtils.log(SCOPE, `${records.length} leads already in store — will skip and keep collecting new ones`);
      }
    } catch (err) {
      ScraperUtils.warn(SCOPE, 'Could not load existing records:', err);
    }
  }

  function scrollResultsToTop() {
    const container = queryFirst(document, sel.feedContainer);
    if (container) container.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  async function loadSettings() {
    const settings = await ScraperUtils.getSettings();
    linkedinSettings = {
      linkedinMaxResults: Math.min(
        500,
        Math.max(1, Number(settings.linkedinMaxResults) || ScraperConstants.LINKEDIN_DEFAULT_MAX_RESULTS)
      ),
      delayMs: Math.max(0, Number.isFinite(Number(settings.delayMs)) ? Number(settings.delayMs) : 400),
      collectAllPages: Boolean(settings.collectAllPages),
      fetchContactFromPanel: settings.fetchContactFromPanel !== false
    };
  }

  function isVanitySlug(slug) {
    return slug && !/^AC[a-zA-Z0-9_-]{10,}$/.test(slug);
  }

  function buildInUrlFromSlug(slug) {
    if (!slug) return '';
    const clean = String(slug).replace(/^\/in\//, '').split('?')[0];
    return clean ? `https://www.linkedin.com/in/${decodeURIComponent(clean)}` : '';
  }

  function buildInUrlFromSalesLeadId(salesLeadId) {
    if (!salesLeadId) return '';
    const clean = String(salesLeadId).split(',')[0].trim();
    if (!clean || clean.length < 8) return '';
    return `https://www.linkedin.com/in/${clean}`;
  }

  function scanPageForPublicIdentifier(salesLeadId, expectedName) {
    if (!salesLeadId) return '';

    const html = document.documentElement.innerHTML || '';
    let fallback = '';

    let idx = html.indexOf(salesLeadId);
    while (idx >= 0) {
      const chunk = html.slice(Math.max(0, idx - 1200), idx + 15000);
      for (const m of chunk.matchAll(/"publicIdentifier"\s*:\s*"([^"\\]+)"/g)) {
        const slug = m[1];
        if (!slug) continue;
        if (isVanitySlug(slug)) return slug;
        if (!fallback) fallback = slug;
      }
      for (const m of chunk.matchAll(/"linkedinUrl"\s*:\s*"https:\\\/\\\/(?:www\.)?linkedin\.com\\\/in\\\/([^"\\]+)"/g)) {
        const slug = m[1];
        if (isVanitySlug(slug)) return slug;
        if (!fallback) fallback = slug;
      }
      idx = html.indexOf(salesLeadId, idx + 1);
    }

    if (fallback) return fallback;

    if (expectedName) {
      const nameKey = expectedName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
      if (nameKey) {
        for (const m of html.matchAll(/"firstName"\s*:\s*"([^"\\]*)"\s*,\s*"lastName"\s*:\s*"([^"\\]*)"\s*,[\s\S]{0,800}?"publicIdentifier"\s*:\s*"([^"\\]+)"/g)) {
          const combined = `${m[1]}${m[2]}`.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (combined.includes(nameKey) || nameKey.includes(combined.slice(0, 10))) return m[3];
        }
      }
    }

    return '';
  }

  function resolveInUrl(record, salesLeadId) {
    const fromUrl = normalizeInUrl(record?.url);
    if (fromUrl) return fromUrl;

    if (record?.publicIdentifier) {
      const built = buildInUrlFromSlug(record.publicIdentifier);
      if (built) return built;
    }

    const fromPage = scanPageForPublicIdentifier(salesLeadId, record?.name);
    if (fromPage) return buildInUrlFromSlug(fromPage);

    return buildInUrlFromSalesLeadId(salesLeadId);
  }

  function finalizeRecord(record, salesLeadId) {
    const sid = salesLeadId || record?.salesLeadId || '';
    const url = resolveInUrl(record, sid);
    return {
      ...record,
      salesLeadId: sid,
      url,
      email: ScraperUtils.normalizeText(record?.email || ''),
      phone: ScraperUtils.normalizeText(record?.phone || '')
    };
  }

  async function loadSelectors() {
    await SelectorConfig.load();
    sel = await SelectorConfig.get('linkedin');
  }

  function queryFirst(root, selectors) {
    for (const selector of selectors || []) {
      try {
        const el = (root || document).querySelector(selector);
        if (el) return el;
      } catch {
        // ignore
      }
    }
    return null;
  }

  function queryText(root, selectors) {
    const el = queryFirst(root, selectors);
    return el ? ScraperUtils.normalizeText(el.textContent) : '';
  }

  function normalizeInUrl(href) {
    if (!href || href.includes('/sales/')) return '';
    try {
      const parsed = new URL(href, 'https://www.linkedin.com');
      const slug = parsed.pathname.match(/\/in\/([^/?#]+)/i)?.[1];
      if (!slug) return '';
      return `https://www.linkedin.com/in/${decodeURIComponent(slug)}`;
    } catch {
      const slug = String(href).match(/\/in\/([^/?#]+)/i)?.[1];
      return slug ? `https://www.linkedin.com/in/${decodeURIComponent(slug)}` : '';
    }
  }

  function extractSalesLeadId(cardOrUrl) {
    if (typeof cardOrUrl === 'string') {
      return cardOrUrl.match(/\/sales\/lead\/([^,/?#]+)/i)?.[1] || '';
    }
    if (!cardOrUrl) return '';

    for (const link of cardOrUrl.querySelectorAll('a[href*="/sales/lead/"], a[href*="sales/lead"]')) {
      const id = link.getAttribute('href')?.match(/\/sales\/lead\/([^,/?#]+)/i)?.[1];
      if (id) return id;
    }

    for (const el of cardOrUrl.querySelectorAll('[data-urn*="fs_salesProfile"], [href*="fs_salesProfile"]')) {
      const urn = el.getAttribute('data-urn') || el.getAttribute('href') || '';
      const fromUrn = urn.match(/fs_salesProfile:([^,)]+)/)?.[1] ||
        urn.match(/\/sales\/lead\/([^,/?#]+)/i)?.[1];
      if (fromUrn) return fromUrn;
    }

    const html = cardOrUrl.innerHTML || '';
    const htmlMatch = html.match(/\/sales\/lead\/(AC[a-zA-Z0-9_-]+)/);
    if (htmlMatch) return htmlMatch[1];

    return '';
  }

  function namesMatch(a, b) {
    if (!a || !b) return false;
    const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    const n = Math.min(8, na.length, nb.length);
    return n > 0 && (na.slice(0, n) === nb.slice(0, n) || na.includes(nb.slice(0, n)) || nb.includes(na.slice(0, n)));
  }

  function cardKey(card, preview) {
    const salesId = preview?.salesLeadId || extractSalesLeadId(card);
    if (salesId) return `sales:${salesId}`;
    const inUrl = normalizeInUrl(preview?.url || extractUrlFromCard(card));
    if (inUrl) return `in:${inUrl.split('/in/')[1]?.toLowerCase()}`;
    const name = ScraperUtils.normalizeText(preview?.name || queryText(card, sel.name)).toLowerCase();
    const company = ScraperUtils.normalizeText(preview?.company || queryText(card, sel.company)).toLowerCase();
    if (name) return `name:${name}|${company}`;
    return '';
  }

  function leadIdentityKey(preview) {
    if (preview?.salesLeadId) return `sales:${preview.salesLeadId}`;
    const inUrl = normalizeInUrl(preview?.url);
    if (inUrl) return `in:${inUrl.split('/in/')[1]?.toLowerCase()}`;
    const name = ScraperUtils.normalizeText(preview?.name).toLowerCase();
    const company = ScraperUtils.normalizeText(preview?.company).toLowerCase();
    if (name) return `name:${name}|${company}`;
    return '';
  }

  function findCardBySalesLeadId(salesLeadId) {
    if (!salesLeadId) return null;
    for (const card of findResultCards()) {
      if (extractSalesLeadId(card) === salesLeadId) return card;
    }
    const link = document.querySelector(`a[href*="/sales/lead/${salesLeadId}"]`);
    if (link) {
      return link.closest('li, [role="listitem"], [data-view-name="search-results-entity"], div[class*="result"]');
    }
    return null;
  }

  function extractUrlFromCard(card) {
    for (const link of card.querySelectorAll('a[href*="/in/"]')) {
      const url = normalizeInUrl(link.getAttribute('href'));
      if (url) return url;
    }
    return '';
  }

  function preferPublicUrl(a, b) {
    return normalizeInUrl(a) || normalizeInUrl(b) || '';
  }

  function mergeLeadRecords(base, incoming) {
    if (!base) return incoming;
    if (!incoming) return base;
    const url = preferPublicUrl(incoming.url, base.url) ||
      (incoming.publicIdentifier ? `https://www.linkedin.com/in/${incoming.publicIdentifier}` : '') ||
      (base.publicIdentifier ? `https://www.linkedin.com/in/${base.publicIdentifier}` : '');

    return {
      ...base,
      ...incoming,
      name: incoming.name || base.name,
      title: incoming.title || base.title,
      company: incoming.company || base.company,
      location: incoming.location || base.location,
      industry: incoming.industry || base.industry,
      email: incoming.email || base.email || '',
      phone: incoming.phone || base.phone || '',
      publicIdentifier: incoming.publicIdentifier || base.publicIdentifier || '',
      url: normalizeInUrl(url),
      source: incoming.source || base.source
    };
  }

  function normalizeLeadRecord(lead, salesLeadId) {
    return finalizeRecord(lead, salesLeadId || lead?.salesLeadId);
  }

  function isLeadCard(card) {
    if (!card) return false;
    if (card.querySelector('a[href*="/sales/lead/"], a[href*="/in/"]')) return true;
    return Boolean(queryFirst(card, sel.name));
  }

  function findResultCards() {
    for (const selector of sel.card || []) {
      const items = document.querySelectorAll(selector);
      if (!items.length) continue;
      const cards = Array.from(items).filter(isLeadCard);
      if (cards.length) return cards;
    }

    const linkCards = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/sales/lead/"], a[href*="/in/"]').forEach((link) => {
      const container = link.closest('li, [role="listitem"], [data-view-name="search-results-entity"], div[class*="result"]');
      if (container && !seen.has(container)) {
        seen.add(container);
        linkCards.push(container);
      }
    });
    return linkCards;
  }

  function extractLeadFromCard(card) {
    let name = queryText(card, sel.name);
    if (!name) {
      const link = queryFirst(card, sel.name) || card.querySelector('a[href*="/sales/lead/"]');
      if (link) name = ScraperUtils.normalizeText(link.textContent);
    }
    return {
      name,
      title: queryText(card, sel.title),
      company: queryText(card, sel.company),
      url: extractUrlFromCard(card),
      location: queryText(card, sel.location),
      industry: queryText(card, sel.industry),
      email: '',
      phone: '',
      salesLeadId: extractSalesLeadId(card),
      source: 'list'
    };
  }

  function findClickTarget(card) {
    return (
      card.querySelector('a[data-anonymize="person-name"]') ||
      card.querySelector('a[href*="/sales/lead/"]') ||
      queryFirst(card, sel.name) ||
      queryFirst(card, sel.url)
    );
  }

  function findLeadPanel() {
    for (const selector of sel.leadPanel || []) {
      try {
        const el = document.querySelector(selector);
        if (el && el.querySelector('a[href*="/sales/lead/"], a[href*="/in/"], [data-anonymize="person-name"]')) {
          return el;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  function panelMatchesLead(panel, preview) {
    if (!panel || !preview) return false;
    const salesLeadId = preview.salesLeadId;
    if (salesLeadId) {
      const blob = panel.innerHTML || '';
      if (blob.includes(salesLeadId)) return true;
      if (panel.querySelector(`a[href*="${salesLeadId}"]`)) return true;
    }
    const panelName =
      queryText(panel, sel.name) ||
      ScraperUtils.normalizeText(panel.querySelector('[data-anonymize="person-name"]')?.textContent);
    if (panelName && preview.name && namesMatch(panelName, preview.name)) return true;

    const previewFirst = preview.name?.split(/\s+/)[0]?.toLowerCase();
    const panelFirst = panelName?.split(/\s+/)[0]?.toLowerCase();
    if (previewFirst && panelFirst && previewFirst.length > 2 && previewFirst === panelFirst) return true;

    return false;
  }

  function panelReferencesLead(panel, preview) {
    if (!panel || !preview?.salesLeadId) return false;
    const sid = preview.salesLeadId;
    const blob = panel.innerHTML || '';
    return blob.includes(sid) || Boolean(panel.querySelector(`a[href*="${sid}"]`));
  }

  function extractPanelContactSafe(panel, preview) {
    if (!panel) return extractContactFromRoot(null, preview);

    const contact = extractContactFromRoot(panel, preview);
    if (panelMatchesLead(panel, preview) || panelReferencesLead(panel, preview)) {
      return contact;
    }

    return {
      url: '',
      email: contact.email || '',
      phone: contact.phone || '',
      name: preview.name || '',
      title: preview.title || contact.title || '',
      company: preview.company || contact.company || '',
      location: preview.location || contact.location || '',
      industry: preview.industry || contact.industry || '',
      source: 'panel-partial'
    };
  }

  function isPanelReady(preview) {
    const panel = findLeadPanel();
    if (!panel) return false;

    if (panelMatchesLead(panel, preview)) return true;

    const salesLeadId = preview.salesLeadId;
    if (salesLeadId) {
      const apiLead = NetworkIntercept.getLinkedInLeadBySalesId(salesLeadId);
      if (apiLead?.url?.includes('/in/') || apiLead?.publicIdentifier || apiLead?.email || apiLead?.phone) {
        return true;
      }
    }

    const contact = extractContactFromRoot(panel, preview);
    if ((contact.email || contact.phone) && panelReferencesLead(panel, preview)) return true;

    if (
      panel.querySelector('[data-anonymize="person-name"]') ||
      queryText(panel, sel.name) ||
      panel.querySelector('a[href*="/in/"]')
    ) {
      return true;
    }

    return false;
  }

  async function waitForLeadPanel(preview, timeoutMs = TIMING.panelTimeoutMs) {
    const matched = await ScraperUtils.waitForCondition(
      () => isPanelReady(preview),
      { timeoutMs, pollMs: TIMING.panelPollMs }
    );

    if (!matched) {
      ScraperUtils.log(SCOPE, 'Panel still loading for:', preview.name || preview.salesLeadId, '— using list/API fallbacks');
    }

    await ScraperUtils.sleep(TIMING.panelSettle);
    return findLeadPanel();
  }

  function enrichFromApi(preview) {
    return finalizeRecord(mergeApiMatches({ ...preview }, preview.salesLeadId), preview.salesLeadId);
  }

  function canSkipPanel(record) {
    if (!record.url?.includes('/in/')) return false;
    if (!linkedinSettings.fetchContactFromPanel) return true;
    return Boolean(record.email || record.phone);
  }

  function extractContactFromRoot(root, preview) {
    if (!root) {
      return {
        url: '',
        email: '',
        phone: '',
        name: preview?.name || '',
        title: preview?.title || '',
        company: preview?.company || '',
        location: preview?.location || '',
        industry: preview?.industry || '',
        source: 'panel'
      };
    }

    let email = '';
    let phone = '';
    let url = '';

    root.querySelectorAll('a[href*="/in/"]').forEach((a) => {
      if (!url) url = normalizeInUrl(a.getAttribute('href'));
    });

    const viewProfile = root.querySelector(
      'a[aria-label*="View LinkedIn profile" i], a[aria-label*="LinkedIn profile" i], a[data-control-name*="view" i][href*="/in/"]'
    );
    if (viewProfile && !url) url = normalizeInUrl(viewProfile.getAttribute('href'));

    for (const selector of sel.publicProfileLink || ['a[href*="/in/"]']) {
      root.querySelectorAll(selector).forEach((a) => {
        if (!url) url = normalizeInUrl(a.getAttribute('href'));
      });
    }

    root.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
      if (!email) email = a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0];
    });

    root.querySelectorAll('a[href^="tel:"]').forEach((a) => {
      if (!phone) phone = a.getAttribute('href').replace(/^tel:/i, '').trim();
    });

    for (const selector of sel.contactEmail || ['[data-anonymize="email"]']) {
      root.querySelectorAll(selector).forEach((el) => {
        if (!email) email = ScraperUtils.normalizeText(el.textContent);
      });
    }

    for (const selector of sel.contactPhone || ['[data-anonymize="phone"]']) {
      root.querySelectorAll(selector).forEach((el) => {
        if (!phone) phone = ScraperUtils.normalizeText(el.textContent);
      });
    }

    const text = root.innerText || root.textContent || '';
    if (!email) {
      const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (match) email = match[0];
    }
    if (!phone) {
      const match = text.match(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      if (match) phone = match[0].trim();
    }

    return {
      url,
      email: ScraperUtils.normalizeText(email),
      phone: ScraperUtils.normalizeText(phone),
      name: queryText(root, sel.name) || preview?.name || '',
      title: queryText(root, sel.title) || preview?.title || '',
      company: queryText(root, sel.company) || preview?.company || '',
      location: queryText(root, sel.location) || preview?.location || '',
      industry: queryText(root, sel.industry) || preview?.industry || '',
      source: 'panel'
    };
  }

  function mergeApiMatches(preview, salesLeadId) {
    let merged = { ...preview };
    const apiLeads = NetworkIntercept.getLinkedInLeads();

    for (const api of apiLeads) {
      const matchBySales = salesLeadId && api.salesLeadId === salesLeadId;
      const matchByName = namesMatch(api.name, preview.name);
      const matchById = salesLeadId && api.url?.includes(salesLeadId);
      if (matchBySales || matchByName || matchById) {
        merged = mergeLeadRecords(merged, api);
      }
    }

    if (salesLeadId) {
      const bySales = NetworkIntercept.getLinkedInLeadBySalesId(salesLeadId);
      if (bySales) merged = mergeLeadRecords(merged, bySales);
    }

    return merged;
  }

  async function closeLeadPanel() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    const closeBtn = document.querySelector(
      'button[aria-label*="Dismiss" i], button[aria-label*="Close" i], button[aria-label*="Back" i]'
    );
    closeBtn?.click();
    await ScraperUtils.sleep(TIMING.closePanel);
  }

  async function clickLeadAndEnrich(preview, prefilled) {
    const salesLeadId = preview.salesLeadId;
    if (!salesLeadId) throw new Error('Missing sales lead id');

    let card = findCardBySalesLeadId(salesLeadId);
    if (!card) throw new Error(`Lead card not found for ${salesLeadId}`);

    const clickTarget = findClickTarget(card);
    if (!clickTarget) throw new Error('Could not find lead click target');

    try {
      card.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch {
      card.scrollIntoView(true);
    }
    await ScraperUtils.sleep(TIMING.scrollSettle);

    ScraperUtils.log(SCOPE, 'Opening lead panel for:', preview.name || salesLeadId);
    clickTarget.click();

    const panel = await waitForLeadPanel(preview);

    let record = mergeLeadRecords(prefilled || preview, extractPanelContactSafe(panel, preview));
    record = mergeApiMatches(record, salesLeadId);
    record = finalizeRecord(record, salesLeadId);

    if (!record.url?.includes('/in/')) {
      await ScraperUtils.sleep(TIMING.retryGap);
      const retryPanel = findLeadPanel();
      record = finalizeRecord(
        mergeApiMatches(
          mergeLeadRecords(record, extractPanelContactSafe(retryPanel, preview)),
          salesLeadId
        ),
        salesLeadId
      );
    }

    await closeLeadPanel();
    return record;
  }

  async function sendProgress() {
    Watchdog.touch();
    const target = linkedinSettings.linkedinMaxResults || progress.total;
    const remaining = Math.max(0, target - progress.success);
    const avgMs = progress.processed > 0 ? progress.elapsedMs / progress.processed : 2000;
    await chrome.runtime.sendMessage({
      type: ScraperConstants.MSG.PROGRESS_UPDATE,
      scraperType: ScraperConstants.SCRAPER_LINKEDIN,
      progress: {
        total: linkedinSettings.linkedinMaxResults || progress.total,
        processed: progress.processed,
        remaining,
        success: progress.success,
        failed: progress.failed,
        skipped: progress.skipped,
        etaSeconds: Math.round((remaining * avgMs) / 1000)
      }
    }).catch(() => {});
  }

  function recordKey(record) {
    if (record.salesLeadId) return `sales:${record.salesLeadId}`;
    const slug = record.url?.match(/\/in\/([^/?#]+)/i)?.[1];
    if (slug) return `in:${slug.toLowerCase()}`;
    const name = ScraperUtils.normalizeText(record.name).toLowerCase();
    const company = ScraperUtils.normalizeText(record.company).toLowerCase();
    if (name) return `name:${name}|${company}`;
    return '';
  }

  async function collectRecord(lead, salesLeadId) {
    const record = finalizeRecord(lead, salesLeadId || lead?.salesLeadId);

    if (!record.url?.includes('/in/')) {
      ScraperUtils.warn(SCOPE, 'No /in/ URL for:', record.name || 'unknown');
      return false;
    }

    if (progress.success >= linkedinSettings.linkedinMaxResults) return true;

    const key = recordKey(record);
    if (savedRecordKeys.has(key)) return true;

    for (let attempt = 0; attempt < ScraperConstants.MAX_RETRIES; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: ScraperConstants.MSG.RECORD_COLLECTED,
          scraperType: ScraperConstants.SCRAPER_LINKEDIN,
          record
        });
        rememberRecordKeys(record);
        if (response?.duplicate) {
          progress.skipped++;
          ScraperUtils.log(SCOPE, 'Already saved, skipping:', record.name, key);
          return true;
        }
        progress.success++;
        return true;
      } catch (err) {
        ScraperUtils.error(SCOPE, `Save attempt ${attempt + 1} failed:`, err);
        await ScraperUtils.sleepJitter(400 * (attempt + 1));
      }
    }

    progress.failed++;
    RetryQueue.add(record, 'save failed');
    return false;
  }

  async function collectUniqueLeadsFromVisibleCards() {
    const leads = [];
    const seen = new Set();

    for (const card of findResultCards()) {
      const preview = extractLeadFromCard(card);
      if (!preview.salesLeadId) preview.salesLeadId = extractSalesLeadId(card);
      if (!preview.salesLeadId || isKnownLead(preview)) continue;
      const key = leadIdentityKey(preview);
      if (!key || seen.has(key) || attemptedCardKeys.has(key)) continue;
      seen.add(key);
      leads.push(preview);
    }

    return leads;
  }

  function collectLeadsFromApi(limit) {
    const leads = [];
    const seen = new Set();

    for (const api of NetworkIntercept.getLinkedInLeads()) {
      if (leads.length >= limit) break;
      const preview = {
        name: api.name || '',
        title: api.title || '',
        company: api.company || '',
        url: api.url || '',
        location: api.location || '',
        industry: api.industry || '',
        email: api.email || '',
        phone: api.phone || '',
        salesLeadId: api.salesLeadId || '',
        source: 'api'
      };
      if (!preview.salesLeadId || isKnownLead(preview)) continue;
      const key = leadIdentityKey(preview);
      if (!key || seen.has(key) || attemptedCardKeys.has(key)) continue;
      seen.add(key);
      leads.push(preview);
    }

    return leads;
  }

  async function getNextLeadBatch(limit) {
    const batch = [];
    const seen = new Set();

    for (const preview of collectLeadsFromApi(limit)) {
      const key = leadIdentityKey(preview);
      seen.add(key);
      batch.push(preview);
      if (batch.length >= limit) return batch;
    }

    const container = queryFirst(document, sel.feedContainer);
    let stable = 0;

    while (batch.length < limit && stable < 45) {
      const sizeBefore = batch.length;

      for (const preview of await collectUniqueLeadsFromVisibleCards()) {
        const key = leadIdentityKey(preview);
        if (!key || seen.has(key) || attemptedCardKeys.has(key)) continue;
        seen.add(key);
        batch.push(preview);
        if (batch.length >= limit) return batch;
      }

      if (batch.length >= limit) return batch;

      if (container) {
        const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
        container.scrollTop = atBottom ? 0 : Math.min(container.scrollTop + 480, container.scrollHeight);
      } else {
        window.scrollBy(0, 480);
      }
      await ScraperUtils.sleep(TIMING.batchScroll);

      if (batch.length === sizeBefore) stable++;
      else stable = 0;
    }

    return batch;
  }

  function findNextPageButton() {
    for (const selector of sel.nextPage || []) {
      try {
        const el = document.querySelector(selector);
        if (el && el.getAttribute('aria-disabled') !== 'true' && !el.disabled) return el;
      } catch {
        // ignore
      }
    }
    for (const btn of document.querySelectorAll('button, a')) {
      const text = ScraperUtils.normalizeText(btn.textContent);
      const label = ScraperUtils.normalizeText(btn.getAttribute('aria-label'));
      if ((/^next$/i.test(text) || /next/i.test(label)) && btn.getAttribute('aria-disabled') !== 'true') {
        return btn;
      }
    }
    return null;
  }

  async function waitForPageChange(prevUrl, prevCount) {
    await ScraperUtils.waitForCondition(() => {
      if (location.href !== prevUrl) return true;
      return findResultCards().length !== prevCount && findResultCards().length > 0;
    }, { timeoutMs: 10000 });
    await ScraperUtils.sleepJitter(1000);
  }

  async function processLeads(leads, delayMs) {
    await sendProgress();

    for (const preview of leads) {
      if (!(await ScraperUtils.waitWhilePaused())) return false;
      if (progress.success >= linkedinSettings.linkedinMaxResults) return true;

      const key = leadIdentityKey(preview);
      if (!key || attemptedCardKeys.has(key) || isKnownLead(preview)) continue;

      attemptedCardKeys.add(key);
      progress.processed++;
      progress.elapsedMs = Date.now() - progress.startTime;

      let record = preview;
      let usedPanel = false;
      try {
        const apiRecord = enrichFromApi(preview);
        if (canSkipPanel(apiRecord)) {
          record = apiRecord;
          ScraperUtils.log(SCOPE, 'Fast collect:', record.name, record.url);
        } else {
          record = await clickLeadAndEnrich(preview, apiRecord);
          usedPanel = true;
        }
      } catch (err) {
        ScraperUtils.warn(SCOPE, 'Enrich failed, using fallbacks for:', preview.name, err.message || err);
        record = finalizeRecord(preview, preview.salesLeadId);
      }

      record = finalizeRecord(record, preview.salesLeadId);
      const saveKey = recordKey(record);

      if (isKnownLead(record) || (saveKey && savedRecordKeys.has(saveKey))) {
        progress.skipped++;
        ScraperUtils.log(SCOPE, 'Skipping known lead:', record.name, saveKey || leadIdentityKey(record));
        await sendProgress();
        continue;
      }

      if (record.url?.includes('/in/')) {
        ScraperUtils.log(SCOPE, 'Saved lead:', record.name, record.url, record.email || '', record.phone || '');
        await collectRecord(record, preview.salesLeadId);
      } else {
        progress.failed++;
        ScraperUtils.warn(SCOPE, 'Could not resolve /in/ URL for:', preview.name);
      }

      await sendProgress();
      if (progress.success >= linkedinSettings.linkedinMaxResults) return true;
      if (usedPanel && delayMs > 0) await ScraperUtils.sleepJitter(delayMs);
    }

    return true;
  }

  async function stallRecovery() {
    if (progress.success >= linkedinSettings.linkedinMaxResults) return;
    ScraperUtils.warn(SCOPE, 'Stall recovery — skip (no re-processing)');
  }

  async function run() {
    NetworkIntercept.install();
    RetryQueue.clear();
    attemptedCardKeys = new Set();
    savedRecordKeys = new Set();
    progress = {
      total: 0, processed: 0, success: 0, failed: 0, skipped: 0,
      startTime: Date.now(), elapsedMs: 0
    };

    await ScraperUtils.waitForDomReady();
    await loadSelectors();
    await loadSettings();
    await loadExistingRecordKeys();

    progress.total = linkedinSettings.linkedinMaxResults;

    const preflight = await PreflightCheck.run(ScraperConstants.SCRAPER_LINKEDIN);
    if (!preflight.ok) throw new Error(preflight.message);

    Watchdog.start(ScraperConstants.SCRAPER_LINKEDIN, stallRecovery);

    const delayMs = linkedinSettings.delayMs;
    const maxResults = linkedinSettings.linkedinMaxResults;

    await ScraperUtils.waitForElement(sel.card || sel.url, { timeoutMs: 12000 });
    await ScraperUtils.sleepJitter(TIMING.startup);
    if (!linkedinSettings.fetchContactFromPanel) {
      await ScraperUtils.sleep(600);
    }

    let pageNum = 1;

    while (progress.success < maxResults) {
      if (!(await ScraperUtils.waitWhilePaused())) break;

      const needed = maxResults - progress.success;
      const batch = await getNextLeadBatch(needed);
      if (batch.length) {
        ScraperUtils.log(
          SCOPE,
          `Page ${pageNum}: processing ${batch.length} new leads (${progress.success}/${maxResults} saved, ${progress.skipped} skipped)`
        );
        await processLeads(batch, delayMs);
        if (progress.success >= maxResults) break;
        continue;
      }

      const nextBtn = findNextPageButton();
      if (!nextBtn) {
        ScraperUtils.log(
          SCOPE,
          `No more search pages (${progress.success}/${maxResults} new leads saved, ${progress.skipped} already in store)`
        );
        break;
      }

      ScraperUtils.log(
        SCOPE,
        `Page ${pageNum} has no new leads — opening next page (${progress.success}/${maxResults} saved so far)`
      );
      const prevUrl = location.href;
      const prevCount = findResultCards().length;
      nextBtn.click();
      await waitForPageChange(prevUrl, prevCount);
      scrollResultsToTop();
      pageNum++;
      await ScraperUtils.sleepJitter(TIMING.startup);
    }

    if (progress.success < maxResults) {
      await RetryQueue.processAll(
        (lead) => {
          if (progress.success >= maxResults) return true;
          return collectRecord(lead, lead.salesLeadId);
        },
        { delayMs: 600 }
      );
    }
    Watchdog.stop();

    await chrome.runtime.sendMessage({
      type: ScraperConstants.MSG.SCRAPING_COMPLETE,
      scraperType: ScraperConstants.SCRAPER_LINKEDIN,
      progress
    }).catch(() => {});

    ScraperUtils.log(SCOPE, 'Complete', progress);
  }

  function verifySelectors() {
    const cards = findResultCards();
    const sample = cards.length ? extractLeadFromCard(cards[0]) : {};
    return {
      cardsFound: cards.length,
      apiLeads: NetworkIntercept.getLinkedInLeads().length,
      sampleExtracted: sample,
      selectorsOk: Boolean(cards.length)
    };
  }

  return { run, verifySelectors, findResultCards, extractLeadFromCard };
});
