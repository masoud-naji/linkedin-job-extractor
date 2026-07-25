# LinkedIn Job Extractor

A Chrome extension (Manifest V3) with three parts:

1. **Job Extractor** — pulls structured job details from the LinkedIn job posting page you're currently viewing.
2. **Profile Manager** — stores multiple resume profiles (contact info, links, resume PDF, resume JSON) locally in your browser.
3. **Application Assistant** — recognizes common application-form fields on any page and offers to fill them from your active profile.

## Features

**Job Extractor**
- Extracts job title, company, company URL, location, workplace type, employment type, seniority level, salary, date posted, applicant count, full description, skills, Easy Apply status, whether the posting is closed ("No longer accepting applications"), job URL, and job ID.
- Works on individual job pages and LinkedIn's job search results.
- Bulk extraction mode for pulling data from multiple job listings at once.

**Profile Manager**
- Create, rename, duplicate, delete, and switch between multiple named profiles (e.g. "React", "AEM").
- Each profile stores: full name, email, phone, LinkedIn URL, portfolio URL, GitHub URL, current title, location, notes, a resume PDF, and a resume JSON blob.
- Import/export a single profile as JSON, or import a multi-profile bundle file in one go.
- An optional "Fill fields from Resume JSON" action maps common resume JSON shapes (JSON Resume's `basics.*`, or a flatter `personal`/`links` shape) onto the profile fields — explicit key lookup only, never AI, never automatic.
- The PDF is stored and retrievable as-is; its contents are never parsed or read.

**Application Assistant**
- On demand only — nothing runs automatically on any page.
- Detects common application fields (full/first/last name, email, phone, LinkedIn/portfolio/GitHub URL, current title, location) using standard HTML signals (`autocomplete`, `name`/`id`, `placeholder`, `aria-label`, associated `<label>` text).
- Shows a small ⚡ icon next to each recognized field; clicking it fills just that field from your active profile.
- One "Fill Basic Fields" action fills every recognized *empty* field at once — it never overwrites something you've already typed, and it never submits the form.
- Ignores anything it isn't confident about, including custom employer questions, EEO/demographic questions, and free-text essay fields.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.

## Usage

**Extracting a job:**
1. Navigate to a LinkedIn job page (`linkedin.com/jobs/view/...`) or a job search results page.
2. Click the extension icon in the toolbar.
3. View, copy, or export the extracted job data from the popup.

For extracting multiple jobs at once, use the bulk extraction page bundled with the extension.

**Setting up a profile:**
1. Click the extension icon, then **Profiles**.
2. Create a profile, fill in your details, and optionally attach a resume PDF and/or resume JSON.
3. Mark it as your active profile.

**Filling an application form:**
1. Navigate to any job application page.
2. Click the extension icon, pick the active profile from the dropdown if needed, and click **Fill Basic Fields on This Page**.
3. Review the ⚡-marked fields on the page — click individual icons or use the on-page "Fill Basic Fields" button. Nothing is submitted for you.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `activeTab` | Access the current tab only when you explicitly invoke the extension (extraction or the Application Assistant) |
| `scripting` | Inject the extraction script (LinkedIn) or the Application Assistant script (any site, on demand) |
| `storage` | Save extracted jobs and profiles locally |
| `tabs` | Identify and communicate with the active tab |
| `unlimitedStorage` | Resume PDFs are stored as base64 in `chrome.storage.local`, which can exceed the default quota across multiple profiles |

Host access (`host_permissions`) is limited to `linkedin.com` for the Job Extractor's always-on content script. The Application Assistant does **not** request `<all_urls>` or any broad host permission — it runs only when you click "Fill Basic Fields on This Page," under the temporary `activeTab` grant for that one tab.

Some employers embed their application form in a same-tab iframe hosted on the ATS provider's own domain (e.g. a Greenhouse-hosted form embedded on the company's careers page). `activeTab` doesn't extend into a *cross-origin* iframe like that, so filling those fields needs one extra, explicit step: if the popup detects a form inside a known ATS iframe host, it shows a "Grant access…" button. Clicking it opens a new tab where you can grant access to that one specific domain (currently `boards.greenhouse.io` / `job-boards.greenhouse.io` — declared under `optional_host_permissions`, granted nothing until you approve) via Chrome's own permission dialog; declining leaves everything unchanged. (This step opens a separate tab rather than prompting inside the popup, because Chrome's permission dialog doesn't display reliably from the popup itself.) Unrecognized iframe hosts are reported honestly rather than silently showing "0 fields."

No data is sent to any server; everything stays in `chrome.storage.local` in your browser.

## Development

There is no build step — this is plain JavaScript loaded unpacked by Chrome.

- Run parser regression tests: `node tests/parsers.test.js`
- Syntax-check any script: `node --check <file>.js`

## Project structure

- `manifest.json` — extension definition
- `content.js` — LinkedIn job extraction logic (always-on content script on LinkedIn job pages)
- `parsers.js` — shared parsing helpers (URLs, salary, etc.)
- `popup.html` / `popup.js` / `popup.css` — extension popup UI: job extraction view, plus the Application Assistant controls
- `bulk.html` / `bulk.js` — bulk job extraction UI
- `profile-storage.js` — CRUD storage module for profiles (`chrome.storage.local` only); shared by the Profiles page and the injected Application Assistant
- `profiles.html` / `profiles.js` — Profile Manager UI (create/rename/duplicate/delete profiles, import/export, resume PDF/JSON)
- `application-assistant.js` — Application Assistant, injected on demand into the active tab to detect and fill form fields
- `grant-access.html` / `grant-access.js` — one-off tab for granting access to a specific ATS iframe origin (e.g. Greenhouse) when a form is embedded cross-origin
- `background.js` — service worker (badge setup)
- `tests/` — regression tests for parser helpers
- `icons/` — extension icons

## Privacy

The extension only reads content already loaded in the page you're viewing. It does not log in on your behalf, call private LinkedIn APIs, or transmit data anywhere outside your browser. Profile data (including resume PDFs) is stored only in `chrome.storage.local` — never `chrome.storage.sync`, never an external server. The Application Assistant never submits a form and only fills fields it can confidently recognize.
