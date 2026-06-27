/* global self, ScraperUtils, __scraperDefine */
__scraperDefine('NetworkIntercept', () => {
  const SCOPE = 'network';
  const linkedinLeads = new Map();
  const mapsPlaces = new Map();
  let installed = false;

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function walkObject(obj, visitor, depth = 0) {
    if (!obj || depth > 12) return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => walkObject(item, visitor, depth + 1));
      return;
    }
    if (typeof obj === 'object') {
      visitor(obj);
      Object.values(obj).forEach((v) => walkObject(v, visitor, depth + 1));
    }
  }

  function pickLinkedInField(node, keys) {
    for (const key of keys) {
      const val = node[key];
      if (val != null && String(val).trim()) return String(val).trim();
    }
    return '';
  }

  function buildPublicProfileUrl(node) {
    const publicId = pickLinkedInField(node, [
      'publicIdentifier', 'vanityName', 'profileId'
    ]) || node.miniProfile?.publicIdentifier || node.profile?.publicIdentifier;

    if (publicId) {
      const slug = publicId.replace(/^\/in\//, '').split('?')[0];
      if (slug) return `https://www.linkedin.com/in/${slug}`;
    }

    const urlCandidates = [
      node.flagshipProfileUrl,
      node.publicProfileUrl,
      node.linkedinProfileUrl,
      node.profileUrl,
      node.navigationUrl,
      node.linkedinUrl,
      node.linkedInUrl
    ];

    for (const candidate of urlCandidates) {
      const href = String(candidate || '');
      if (!href.includes('/in/')) continue;
      try {
        const parsed = new URL(href, 'https://www.linkedin.com');
        const slug = parsed.pathname.match(/\/in\/([^/?#]+)/i)?.[1];
        if (slug) return `https://www.linkedin.com/in/${slug}`;
      } catch {
        const slug = href.match(/\/in\/([^/?#]+)/i)?.[1];
        if (slug) return `https://www.linkedin.com/in/${slug}`;
      }
    }

    return '';
  }

  function extractLinkedInEmail(node) {
    const direct = pickLinkedInField(node, ['email', 'emailAddress', 'primaryEmail']);
    if (direct) return direct;
    if (node.contactInfo?.emailAddress) return String(node.contactInfo.emailAddress).trim();
    if (Array.isArray(node.emails) && node.emails[0]?.email) return String(node.emails[0].email).trim();
    return '';
  }

  function extractLinkedInPhone(node) {
    const direct = pickLinkedInField(node, ['phone', 'phoneNumber', 'mobileNumber']);
    if (direct) return direct;
    const phones = node.phoneNumbers || node.contactInfo?.phoneNumbers;
    if (Array.isArray(phones) && phones.length) {
      const entry = phones[0];
      return String(entry?.number || entry?.phoneNumber || entry || '').trim();
    }
    return '';
  }

  function parseLinkedInPayload(data) {
    const leads = [];
    walkObject(data, (node) => {
      const name = node.fullName || node.firstName && node.lastName
        ? `${node.firstName} ${node.lastName}`.trim()
        : node.name || node.title?.text || '';
      const publicUrl = buildPublicProfileUrl(node);
      const fallbackUrl = node.profileUrl || node.navigationUrl || node.linkedinUrl ||
        (node.entityUrn && String(node.entityUrn).includes('fs_salesProfile')
          ? `https://www.linkedin.com/sales/lead/${encodeURIComponent(node.entityUrn)}`
          : '');
      const title = node.currentTitle || node.headline || node.title?.text || node.defaultPosition?.title || '';
      const company = node.companyName || node.currentCompanyName || node.defaultPosition?.companyName || '';
      const location = node.geoRegion || node.location || node.geoLocation?.defaultLocalizedName || '';
      const industry = node.industry || node.industryName || '';
      const email = extractLinkedInEmail(node);
      const phone = extractLinkedInPhone(node);

      let normalizedUrl = publicUrl;
      if (!normalizedUrl && fallbackUrl) {
        try {
          normalizedUrl = ScraperUtils.normalizeUrl(
            fallbackUrl.startsWith('http') ? fallbackUrl : new URL(fallbackUrl, 'https://www.linkedin.com').href
          );
        } catch {
          normalizedUrl = ScraperUtils.normalizeUrl(fallbackUrl);
        }
      }

      if (!(name || normalizedUrl)) return;
      if (!normalizedUrl.includes('/in/') && !normalizedUrl.includes('/sales/') && !name) return;

      leads.push({
        name: ScraperUtils.normalizeText(name),
        title: ScraperUtils.normalizeText(title),
        company: ScraperUtils.normalizeText(company),
        url: normalizedUrl,
        location: ScraperUtils.normalizeText(location),
        industry: ScraperUtils.normalizeText(industry),
        email: ScraperUtils.normalizeText(email),
        phone: ScraperUtils.normalizeText(phone),
        publicIdentifier: node.publicIdentifier || node.vanityName || '',
        source: 'api'
      });
    });
    return leads;
  }

  function parseMapsPayload(data) {
    const places = [];
    const text = typeof data === 'string' ? data : JSON.stringify(data);

    const placeBlocks = text.match(/\[\s*"0x[0-9a-f]+:0x[0-9a-f]+"[\s\S]*?\]/gi) || [];
    for (const block of placeBlocks.slice(0, 80)) {
      try {
        const parsed = JSON.parse(block);
        if (Array.isArray(parsed) && parsed.length > 10) {
          const name = parsed[11] || parsed[14] || '';
          if (name) {
            places.push({
              name: ScraperUtils.normalizeText(String(name)),
              address: ScraperUtils.normalizeText(String(parsed[18] || parsed[39] || parsed[2] || '')),
              phone: ScraperUtils.normalizeText(String(parsed[178] || parsed[7] || parsed[3] || '')),
              website: String(parsed[7] || parsed[126] || '').startsWith('http') ? String(parsed[7] || parsed[126]) : '',
              rating: String(parsed[4] || parsed[7] || ''),
              reviewCount: String(parsed[8] || ''),
              category: ScraperUtils.normalizeText(String(parsed[13] || '')),
              source: 'api'
            });
          }
        }
      } catch {
        // not valid JSON block
      }
    }

    walkObject(data, (node) => {
      if (Array.isArray(node) && node.length > 30) {
        const name = node[11] || node[14];
        if (typeof name === 'string' && name.length > 1) {
          const phone = node[178] || node[3];
          const address = node[18] || node[39];
          if (phone || address) {
            places.push({
              name: ScraperUtils.normalizeText(String(name)),
              address: ScraperUtils.normalizeText(String(address || '')),
              phone: ScraperUtils.normalizeText(String(phone || '')),
              rating: String(node[4] || ''),
              reviewCount: String(node[8] || ''),
              category: ScraperUtils.normalizeText(String(node[13] || '')),
              source: 'api-array'
            });
          }
        }
      }

      if (node.title && (node.address || node.formattedAddress || node.phone)) {
        places.push({
          name: ScraperUtils.normalizeText(node.title),
          address: ScraperUtils.normalizeText(node.address || node.formattedAddress || ''),
          phone: ScraperUtils.normalizeText(node.phone || node.internationalPhoneNumber || ''),
          website: node.website || node.url || '',
          rating: String(node.rating || node.averageRating || ''),
          reviewCount: String(node.reviewCount || node.userRatingCount || ''),
          latitude: String(node.lat || node.latitude || ''),
          longitude: String(node.lng || node.longitude || ''),
          source: 'api'
        });
      }
    });

    const phonePattern = /(\+?\d[\d\s().-]{8,}\d)/g;
    const phones = [...new Set((text.match(phonePattern) || []).map((p) => p.trim()))];
    for (const phone of phones.slice(0, 20)) {
      if (phone.replace(/\D/g, '').length >= 10) {
        places.push({ phone: ScraperUtils.normalizeText(phone), source: 'api-text' });
      }
    }

    return places;
  }

  function storeLinkedInLeads(leads) {
    for (const lead of leads) {
      const key = lead.url || lead.name;
      if (key && !linkedinLeads.has(key)) {
        linkedinLeads.set(key, lead);
      }
    }
  }

  function storeMapsPlaces(places) {
    for (const place of places) {
      const key = place.url || `${place.name}|${place.address || ''}`;
      if (key && !mapsPlaces.has(key)) {
        mapsPlaces.set(key, place);
      }
    }
  }

  function handleResponseText(url, text) {
    if (!text || text.length < 20) return;

    const isLinkedIn = /linkedin\.com/i.test(url) &&
      (/sales-api|voyager|graphql|salesApi/i.test(url));
    const isMaps = /google\.com\/maps|maps\.google|maps\.googleapis\.com/i.test(url);

    if (isLinkedIn) {
      const data = tryParseJson(text);
      if (data) {
        const leads = parseLinkedInPayload(data);
        if (leads.length) {
          storeLinkedInLeads(leads);
          ScraperUtils.log(SCOPE, `Captured ${leads.length} LinkedIn leads from API`);
        }
      }
    }

    if (isMaps) {
      const data = tryParseJson(text) || text;
      const places = parseMapsPayload(data);
      if (places.length) {
        storeMapsPlaces(places);
        ScraperUtils.log(SCOPE, `Captured ${places.length} Maps places from API`);
      }
    }
  }

  function patchFetch() {
    const original = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const response = await original(...args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const clone = response.clone();
        clone.text().then((text) => handleResponseText(url, text)).catch(() => {});
      } catch {
        // ignore
      }
      return response;
    };
  }

  function patchXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._interceptUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          if (this.responseText) {
            handleResponseText(this._interceptUrl || '', this.responseText);
          }
        } catch {
          // ignore
        }
      });
      return origSend.apply(this, args);
    };
  }

  function install() {
    if (installed) return;
    installed = true;
    patchFetch();
    patchXHR();
    ScraperUtils.log(SCOPE, 'Network intercept installed');
  }

  function getLinkedInLeads() {
    return Array.from(linkedinLeads.values());
  }

  function getMapsPlaces() {
    return Array.from(mapsPlaces.values());
  }

  function clear() {
    linkedinLeads.clear();
    mapsPlaces.clear();
  }

  function hasLinkedInData() {
    return linkedinLeads.size > 0;
  }

  function hasMapsData() {
    return mapsPlaces.size > 0;
  }

  return {
    install,
    getLinkedInLeads,
    getMapsPlaces,
    clear,
    hasLinkedInData,
    hasMapsData
  };
});
