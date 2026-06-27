# LinkedIn Premium Tool

A Chrome extension (Manifest V3) for scraping business and lead data from **LinkedIn Sales Navigator** and **Google Maps**, with live progress tracking and export to CSV, Excel, and JSON.

**Version 2.1** adds production-grade reliability: network API interception, IndexedDB storage, pre-flight checks, auto-inject, watchdog recovery, hybrid Maps scraping, and selector tests.

## Features

### LinkedIn Sales Navigator

- **Dual extraction:** DOM cards + intercepted API responses (fetch/XHR)
- **Virtualized list support:** scroll-and-extract incrementally so off-screen rows aren't missed
- Fields: full name, job title, company, profile URL, location, industry (when visible)
- Optional multi-page collection with jittered delays (anti-rate-limit)
- Pre-flight check before scraping starts
- Failed-record queue with final retry pass
- 60s watchdog with automatic stall recovery 

### Google Maps

- **Hybrid two-phase scraping:**
  1. Extract name, rating, category, URL from search results list (fast, no navigation)
  2. Open detail pages **only** for businesses missing phone, website, hours, or address
- Network API interception for supplemental place data
- Scrolls results feed until all businesses load
- Fields: business name, category, rating, review count, address, phone, website, hours, email (if visible), URL, lat/lng
- Live progress, pause/resume/stop, auto-resume after tab reload
- Watchdog + failed-record retry pass

### Export

All scraped records can be exported as:

| Format | Extension | Notes |
|--------|-----------|-------|
| CSV    | `.csv`    | UTF-8, standard quoting |
| Excel  | `.xls`    | SpreadsheetML — opens in Excel, Google Sheets, LibreOffice |
| JSON   | `.json`   | Includes scraper type, count, and full record array |

---

## Installation

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder (`LinkedIn-Premium-Tool`).
5. Pin the extension from the toolbar for quick access.

After installing or updating the extension, **refresh any open LinkedIn or Google Maps tabs** (or click Start — the extension auto-injects scripts if needed).

---

## Reliability Features (v2.1)

| Feature | What it does |
|---------|----------------|
| **Pre-flight check** | Verifies results are detectable before scraping; shows a clear error if not |
| **Auto-inject** | Injects content scripts via `chrome.scripting` if the tab wasn't refreshed |
| **Network intercept** | Captures LinkedIn/Maps API JSON alongside DOM scraping |
| **IndexedDB storage** | Handles thousands of records without hitting `chrome.storage` limits |
| **Watchdog** | Detects 60s stalls, triggers recovery, notifies popup |
| **Retry queue** | Failed records get a final retry pass at end of run |
| **Jittered delays** | Randomized timing reduces rate-limit risk |
| **External selectors** | `shared/selectors.json` — update selectors without code changes |
| **Selector tests** | `npm test` validates selectors against HTML fixtures |

---

## Usage

The popup automatically detects which scraper to use based on the active tab URL.

### LinkedIn Sales Navigator

1. Log in to LinkedIn and open a **Sales Navigator people search results** page, for example:
   `https://www.linkedin.com/sales/search/people?...`
2. Refresh the tab if you just installed or updated the extension.
3. Click the extension icon to open the popup.
4. (Optional) Enable **Collect all pages** and adjust **Delay (ms)**.
5. Click **Start Scraping** — a pre-flight check runs first.
6. Watch the record count and progress update in the popup.
7. When finished, export via **CSV**, **Excel**, or **JSON**.

### Google Maps

1. Open [Google Maps](https://www.google.com/maps) and search for a business category and location, for example:
   `Plumbers in New York` or `Restaurants in Dubai`
2. Wait for search results to appear in the left panel.
3. Refresh the tab if you just installed or updated the extension.
4. Click the extension icon and confirm the badge shows **Google Maps**.
5. Click **Start Scraping**.
6. **Keep the tab open.** The extension will scroll results, then navigate through each business profile one by one.
7. Use **Pause**, **Resume**, or **Stop** as needed.
8. Export when scraping completes.

> **Note:** Google Maps scraping navigates the active tab through each profile. Do not close or switch away from the tab until the run finishes or you click Stop.

---

## Popup Controls

| Control | Description |
|---------|-------------|
| **Start Scraping** | Begin collection on the active tab |
| **Pause** | Temporarily halt scraping |
| **Resume** | Continue a paused run |
| **Stop** | Cancel scraping and clear the Maps queue |
| **CSV / Excel / JSON** | Download collected records |
| **Copy URLs** | Copy all profile URLs to clipboard |
| **Clear All** | Remove stored records and reset state |

---

## Extracted Fields

### LinkedIn Sales Navigator

| Field | Description |
|-------|-------------|
| Full Name | Person name from the result card |
| Job Title | Current title when shown |
| Company | Company name when shown |
| LinkedIn URL | Sales Navigator or profile link |
| Location | Geographic location when shown |
| Industry | Industry label when shown |
| Collected At | ISO timestamp of when the record was saved |

### Google Maps

| Field | Description |
|-------|-------------|
| Business Name | Place name |
| Category | Business type/category |
| Rating | Star rating |
| Total Reviews | Review count |
| Full Address | Street address |
| Phone Number | Contact phone |
| Website | Business website URL |
| Business Hours | Opening hours summary |
| Email | Only if visible on the Maps page or via a `mailto:` link |
| Google Maps URL | Canonical place URL |
| Latitude / Longitude | Parsed from the Maps URL when available |
| Collected At | ISO timestamp of when the record was saved |

---

## Debugging

Open **Developer Tools** on the target tab (LinkedIn or Google Maps) and filter the console by `[scraper]`.

Example log prefixes:

```
[scraper][linkedin]   — Sales Navigator scraper
[scraper][google-maps] — Google Maps scraper
[scraper][content-linkedin] — LinkedIn content script
[scraper][content-maps] — Maps content script
```

Common log messages:

- `Found N cards via selector: ...` — result detection is working
- `Extracted lead ...` — successful LinkedIn extraction
- `Extracted: {...}` — successful Maps place extraction
- `Skipping empty lead record` — a card had no usable data (skipped)
- `Duplicate URL, skipping` — deduplication working as expected

If scraping fails immediately, check for:

- Wrong page (popup shows **Unsupported page**)
- Content script not loaded → refresh the tab
- No search results visible on the page before starting

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Popup says "Unsupported page" | Navigate to LinkedIn Sales Navigator search results or Google Maps search results |
| "Content script not loaded" | Refresh the target tab, then reopen the popup |
| LinkedIn CSV is empty | Confirm you are on a people **search results** page, not a single profile; check DevTools for `[scraper][linkedin]` errors |
| Google Maps finds 0 businesses | Run a search first so the results feed is visible; try scrolling manually once, then start |
| Scraping stops on Maps mid-run | Reopen the tab on Google Maps — the queue auto-resumes if it was not stopped manually |
| Export has headers only | No records were collected; run scraping first and confirm the record count increases |
| Email field is empty | Email is only captured when shown on the Maps page; the extension does not visit external websites |

---

## Project Structure

```
LinkedIn-Premium-Tool/
├── manifest.json
├── background.js              # IndexedDB storage, progress, stall handling
├── popup.html / popup.js      # Auto-inject, pre-flight, export
├── content-linkedin.js
├── content-maps.js
├── shared/
│   ├── constants.js
│   ├── utils.js               # MutationObserver, jitter, pause/resume
│   ├── selectors.json         # External selector config (hot-swappable)
│   ├── selectors.js           # Loader (+ optional remote override)
│   ├── network-intercept.js   # fetch/XHR API capture
│   ├── preflight.js           # Pre-scrape health check
│   ├── watchdog.js            # Stall detection + recovery trigger
│   ├── retry-queue.js         # End-of-run failed record retries
│   ├── record-store.js        # IndexedDB wrapper
│   └── export.js              # Chunked CSV/Excel/JSON export
├── scrapers/
│   ├── linkedin-sales.js
│   └── google-maps.js
└── tests/
    ├── selectors.test.js
    └── fixtures/
```

### Running selector tests

```bash
npm test
```

Tests validate `selectors.json` structure and match selectors against saved HTML fixtures.

### Updating selectors

Edit `shared/selectors.json` and reload the extension. To enable remote updates, set `REMOTE_CONFIG_URL` in `shared/selectors.js` to your hosted JSON URL.

### Adding a New Scraper

1. Create a new file under `scrapers/` (e.g. `scrapers/example.js`).
2. Register a content script in `manifest.json` with the shared utilities loaded first.
3. Add a thin entry file (e.g. `content-example.js`) that handles `START_SCRAPING`, `PAUSE`, `RESUME`, and `STOP` messages.
4. Use `ScraperConstants.MSG.RECORD_COLLECTED` to save records via the background script.
5. Add export column definitions in `shared/export.js`.
6. Update `popup.js` to detect the new site URL and show relevant UI.

---

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Interact with the currently open tab when you click the extension |
| `scripting` | Inject scripts when needed |
| `storage` | Persist scraped records, settings, and scrape state |

Host permissions are limited to LinkedIn Sales Navigator and Google Maps domains.

---

## Limitations

- **Not 100% failure-proof:** LinkedIn and Google change markup, show CAPTCHAs, and may rate-limit aggressive scraping.
- **LinkedIn:** Requires Sales Navigator access. API interception supplements DOM but depends on LinkedIn's internal API shapes.
- **Google Maps:** Detail pages are only opened when list data is incomplete — email still only captured if visible on Maps.
- **IndexedDB:** Stored per browser profile; clearing site data may remove records.
- **Rate limiting:** Use delay settings and avoid very aggressive scraping.

---

## License

Use responsibly and in compliance with LinkedIn's and Google's terms of service and applicable data protection laws.
