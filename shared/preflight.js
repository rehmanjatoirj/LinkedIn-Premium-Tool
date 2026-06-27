/* global self, ScraperUtils, ScraperConstants, SelectorConfig, NetworkIntercept, __scraperDefine */
__scraperDefine('PreflightCheck', () => {
  const SCOPE = 'preflight';

  function queryFirst(root, selectors) {
    for (const selector of selectors || []) {
      try {
        const el = root.querySelector(selector);
        if (el) return el;
      } catch {
        // invalid selector
      }
    }
    return null;
  }

  async function checkLinkedIn() {
    await SelectorConfig.load();
    const sel = await SelectorConfig.get('linkedin');

    const cards = [];
    for (const selector of sel.card || []) {
      document.querySelectorAll(selector).forEach((el) => cards.push(el));
      if (cards.length) break;
    }

    const linkFallback = document.querySelectorAll((sel.url || []).join(','));
    const apiLeads = NetworkIntercept.getLinkedInLeads();

    let sample = null;
    if (cards.length) {
      const card = cards[0];
      const nameEl = queryFirst(card, sel.name);
      const urlEl = queryFirst(card, sel.url);
      sample = {
        name: nameEl ? ScraperUtils.normalizeText(nameEl.textContent) : '',
        url: urlEl ? (urlEl.getAttribute('href') || '') : ''
      };
    } else if (apiLeads.length) {
      sample = apiLeads[0];
    } else if (linkFallback.length) {
      sample = {
        name: ScraperUtils.normalizeText(linkFallback[0].textContent),
        url: linkFallback[0].getAttribute('href') || ''
      };
    }

    const ok = Boolean(
      (cards.length > 0 || linkFallback.length > 0 || apiLeads.length > 0) &&
      sample && (sample.name || sample.url)
    );

    return {
      ok,
      scraperType: ScraperConstants.SCRAPER_LINKEDIN,
      cardsFound: cards.length || linkFallback.length,
      apiLeadsFound: apiLeads.length,
      sample,
      message: ok
        ? `Ready — detected ${Math.max(cards.length, linkFallback.length, apiLeads.length)} potential results`
        : 'No Sales Navigator search results detected. Open a people search results page and refresh the tab.'
    };
  }

  async function checkMaps() {
    await SelectorConfig.load();
    const sel = await SelectorConfig.get('googleMaps');

    const feed = queryFirst(document, sel.feed);
    const links = [];
    for (const selector of sel.resultLink || []) {
      document.querySelectorAll(selector).forEach((el) => links.push(el));
    }

    const apiPlaces = NetworkIntercept.getMapsPlaces();
    const isSearch = location.pathname.includes('/search') || feed || links.length >= 2;
    const isPlace = location.pathname.includes('/place/');

    let sample = null;
    if (links.length) {
      sample = {
        name: ScraperUtils.normalizeText(links[0].getAttribute('aria-label') || links[0].textContent),
        url: links[0].getAttribute('href') || ''
      };
    } else if (apiPlaces.length) {
      sample = apiPlaces[0];
    }

    const ok = isSearch || isPlace || links.length > 0 || apiPlaces.length > 0;

    return {
      ok,
      scraperType: ScraperConstants.SCRAPER_MAPS,
      feedFound: Boolean(feed),
      linksFound: links.length,
      apiPlacesFound: apiPlaces.length,
      sample,
      message: ok
        ? `Ready — ${links.length || apiPlaces.length} businesses detected`
        : 'No Google Maps search results found. Run a business search first, then refresh the tab.'
    };
  }

  async function run(scraperType) {
    NetworkIntercept.install();
    await ScraperUtils.sleep(300);

    const result = scraperType === ScraperConstants.SCRAPER_MAPS
      ? await checkMaps()
      : await checkLinkedIn();

    ScraperUtils.log(SCOPE, 'Result:', result);
    return result;
  }

  return { run, checkLinkedIn, checkMaps };
});
