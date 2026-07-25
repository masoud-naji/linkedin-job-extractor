# LinkedIn Job Extractor: AI Handoff

## Purpose

Manifest V3 Chrome extension that extracts the job currently rendered on a LinkedIn job page and shows the result in a popup. It reads page content already available to the user; it does not call LinkedIn APIs, automate login, send data to a server, or store credentials.

The extractor is intentionally defensive because LinkedIn frequently changes authenticated and guest DOM layouts. Fields are resolved through ordered DOM, text, and structured-data fallbacks.

## What We Did

- Added parser support for relative LinkedIn URLs such as `/jobs/view/123456`.
- Added regression coverage for URL parsing in shared parser helpers.
- Reduced extension-side console noise by turning debug logging off by default.
- Guarded description-expansion attempts so the same page does not repeatedly retrigger the same behavior.

## Current Issue

The LinkedIn page can still emit noisy browser console messages from third-party scripts and embedded tracking/analytics layers, including requests to `/li/track` and sandboxed-frame `localStorage` errors. These messages are not caused by the extension extraction logic, but they can still appear in the page console while the extension is running.

A related noisy pattern seen during development: repeated `GET chrome-extension://invalid/ net::ERR_FAILED` errors wrapped in a stack of LinkedIn's own Ember run-loop frames (`_scheduleAutorun`, `flush`, Ember Data `findRecord`/`ajax`). This happens when the unpacked extension is reloaded via `chrome://extensions` while a LinkedIn tab stays open: that tab's old content script context is invalidated (`chrome.runtime.id` becomes undefined), LinkedIn's own app hits the now-dead extension origin, and its framework retries on the failure. The retry loop itself runs in LinkedIn's bundled code, not ours, so it cannot be silenced from the extension. Refreshing the LinkedIn tab after reloading the extension gives it a fresh context and stops it. `content.js` guards its own side of this: `isExtensionContextValid()` checks `chrome.runtime?.id` before scheduling extraction or continuing DOM observation, and `stopWatching()` disconnects the `MutationObserver` and clears the debounce timer once the context is gone, so an orphaned content script does not keep doing background work or throw on `sendResponse`.

For this project, the extension currently avoids adding its own extra logging noise by default and keeps the debug flag opt-in. If a new console issue is observed, capture the exact message and the URL or selector context before changing extraction logic.

## Repository Map

- `manifest.json`: MV3 extension definition. Runs `content.js` at `document_idle` on LinkedIn job pages and opens the popup UI.
- `content.js`: main extraction flow, DOM selectors, fallback strategies, diagnostics, SPA observers, and messaging with the popup.
- `parsers.js`: small shared parser helpers used by `content.js` for URL parsing and salary validation.
- `popup.js`: requests job data from the active tab and renders/copies the extracted result.
- `popup.html` / `popup.css`: fixed popup UI. Keep the styling and layout stable unless an explicit redesign is requested.
- `background.js`: sets the extension badge color on installation.
- `tests/parsers.test.js`: regression tests for parser helpers.
- `icons/`: extension icons.

There is no build step or package manager. The extension is loaded unpacked in Chrome.

## Output Contract: Do Not Change

The output shape and field names are fixed:

```text
jobTitle, companyName, companyUrl, location, workplaceType, employmentType,
seniorityLevel, salary, datePosted, applicantCount, description, skills,
easyApply, jobUrl, jobId, extractedAt
```

Strings that cannot be resolved become `Not found` in `normalizeMissingFields`; `skills` stays an array. Do not rename, remove, or add output fields without an explicit request.

## Current Extraction Flow

`extractJobData()` performs this sequence:

1. Reset field diagnostics and read `window.location.href` plus `document.body.textContent`.
2. Read embedded schema.org `JobPosting` JSON-LD via `getJobPostingLd()`.
3. Extract DOM-first header fields: title, company, company URL, and location.
4. Find the About section and extract its full description.
5. If the DOM description is absent or too short, use JSON-LD description; then extract skills from the resulting description.
6. Extract footer fields: seniority, salary, date posted, applicant count, and Easy Apply.
7. Assemble the fixed JSON. JSON-LD fills only empty DOM-derived values; it never overrides a successfully extracted page value.
8. Normalize missing values, cache the result, and log diagnostics when debug is enabled.

The content script observes DOM and URL changes, debounces re-extraction, and responds to popup requests. The popup can click the description expansion control before requesting fresh extraction.

## Implemented Behavior

- Job ID: URL-first extraction supports both `/jobs/view/<id>` and slug URLs ending in `-<id>`; DOM is fallback only.
- Job URL: preserves the LinkedIn path, including a canonical slug when available; removes only query parameters and fragments.
- Company: DOM company anchors/selectors, then any non-empty `/company/` anchor, then document title; JSON-LD `hiringOrganization` fills empty name and URL.
- Location: header metadata is preferred and split on `·`, `•`, or `|`; date, applicant, workplace-only, and company segments are ignored. Semantic selectors, header bullets, heading text, and JSON-LD `jobLocation` are fallbacks.
- Description: preserves the full About the Job content. It does not trim company, benefits, or legal sections from output.
- Workplace type: explicit section, accessible preference label, exact badge/pill, dedicated selector, aggregate header badges, then description inference.
- Employment type: explicit section, header badge, description, then JSON-LD values such as `FULL_TIME` -> `Full-time`.
- Salary: header salary pill, compensation heading, description, page text, then JSON-LD `baseSalary`. Supports ranges and decimal K values such as `$123K/yr - $215.2K/yr` and rejects stray small currency amounts.
- Applicants: supports visible phrases such as `Over 100 people clicked apply`, `43 people clicked apply`, `100+ applicants`, and `Be among the first 10 applicants`.
- Seniority: explicit LinkedIn metadata, page text, then conservative title inference (`Staff`, `Senior`, `Principal`, `Director`, etc.).
- Skills: bullet/tag extraction plus a maintained skill list; matching is bounded to avoid false positives like `American Express`.

## Selector And Fallback Guidance

When extending extraction, add a higher-priority tier rather than replacing an older working one.

| Area | Important DOM sources | Non-DOM fallback |
| --- | --- | --- |
| Title | `main h1`, `article h1`, `section h1`, job-title `data-testid` / LinkedIn top-card classes | `document.title` |
| Company | `a[href*='/company/']`, `data-testid*='company'`, unified top-card company classes | page-wide company anchor, `document.title`, JSON-LD |
| Location / applicants | top-card metadata, subtitle/flavor rows | heading, page text, JSON-LD location |
| Description | `[data-testid='expandable-text-box']`, `#job-details`, `.jobs-description*`, `.jobs-box__html-content`, `data-testid*='job-description'`, About heading section | JSON-LD description |
| Workplace | `Workplace type` heading, accessible header label, exact leaf pill, `class/data-testid*='workplace'` | description inference |
| Salary | `.jobs-unified-top-card__salary-info`, `.job-details...__salary-info`, salary `data-testid` / class, compensation headings | description, page text, JSON-LD salary |
| Employment / seniority | labeled sections, header badges | description / page text / title inference / JSON-LD employment |

`getJobPostingLd()` walks JSON-LD arrays and `@graph`. It rejects a structured-data payload that names a different LinkedIn job ID from the current URL to avoid stale SPA data. `DOMParser` converts JSON-LD description HTML to text in an inert document; it does not execute scripts or load resources.

## Diagnostics And Validation

Debug logging is off by default in `content.js`, but runtime flags can still enable it if needed:

- `window.__LJE_DEBUG__ = true`
- `localStorage.setItem('ljeDebug', '1')`

Verified locally with:

- `node --check content.js`
- `node tests/parsers.test.js`

These checks cover the parser regression for relative LinkedIn URLs and ensure the extension script remains syntactically valid.

## Known Limitations

- Live LinkedIn content is auth-gated in non-browser fetch tools, so selectors cannot be fully verified outside a logged-in Chrome session.
- LinkedIn may omit JSON-LD or change labels/classes; fallback coverage reduces but cannot eliminate selector maintenance.
- Skills are a curated list plus bullet/tag extraction, capped at 25; it is not a full NLP skill classifier.
- Salary output is normalized when read from JSON-LD, while DOM-derived salary preserves visible formatting. A page can legitimately omit salary.
- Location intentionally does not infer city/state from the description or company text when header location is available.
- The remote-eligibility fallback is intentionally narrow: only `US - Remote Eligible` maps to `United States`; generic `Remote` is not a location.
- No automated browser/e2e test suite exists. Validate selector changes on real logged-in LinkedIn pages and use diagnostics for failures.

## Problems Found And Fixes

- Description became empty after section-aware extraction; the description strategy now preserves page-wide fallback tiers and JSON-LD remains a final fallback.
- Company, description, salary, and skills were missing on some authenticated layouts; JSON-LD now fills empty DOM values and the description feeds downstream extraction.
- Salary ranges stopped at the first number; the regex now supports full range parsing with independent units on each endpoint.
- Slug job IDs were not extracted; URL parsing now supports trailing IDs after a slug.
- `American Express` previously produced `Express` as a skill; matching is now bounded and uses `Express.js` to avoid false positives.
- Workplace values could report `Remote` when the visible badge said `Hybrid`; accessible preference labels and exact pills now take precedence.
- Location and applicant count could be lost in combined header metadata; the metadata is now segmented and classified more conservatively.

## Non-Negotiable Design Decisions

- Preserve the complete About the Job description; do not truncate or strip boilerplate from the output unless the change is explicitly scoped to keyword matching.
- Page DOM data wins. JSON-LD and URL parsing are fallbacks only; never overwrite successfully extracted page data with either.
- For `jobId`, URL parsing is the primary source because it is canonical and reliable; DOM is fallback.
- Preserve the original slugged LinkedIn job path in `jobUrl`; strip only query/hash tracking data.
- Do not change the output JSON structure or redesign the popup unless explicitly requested.
- Keep changes narrow and additive. LinkedIn layouts are variable; retain older working fallback tiers when adding a new one.
- Do not use private LinkedIn APIs, credentials, tokens, or external scraping services.

## AI-Agent Guidance

If you are working on this repository, follow these rules:

1. Keep changes narrow and additive. LinkedIn layouts are variable; retain older working fallback tiers when adding a new one.
2. Preserve the complete About the Job description; do not truncate or strip boilerplate from the output unless the change is explicitly scoped to keyword matching.
3. Page DOM data wins. JSON-LD and URL parsing are fallbacks only; never overwrite successfully extracted page data with either.
4. For `jobId`, URL parsing is the primary source because it is canonical and reliable; DOM is fallback.
5. Do not redesign the popup or change the output JSON contract unless explicitly requested.
6. Do not use private LinkedIn APIs, credentials, tokens, or external scraping services.
7. Prefer adding or extending tests when changing parser behavior.

## Remaining TODO

1. Add more fixture-based unit tests for salary, applicant, URL, JSON-LD, and skill parsing.
2. Capture representative logged-in DOM fixtures for major LinkedIn layouts, subject to privacy policy and without committing personal job data.
3. Add selector tiers only when diagnostics identify a concrete live-layout gap.
