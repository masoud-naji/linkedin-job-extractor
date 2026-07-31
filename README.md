# LinkedIn Job Extractor

A Chrome extension (Manifest V3) with five parts:

1. **Job Extractor** — pulls structured job details from the LinkedIn job posting page you're currently viewing.
2. **Profile Manager** — stores multiple resume profiles (contact info, links, resume PDF, resume JSON) locally in your browser.
3. **Application Assistant** — recognizes common application-form fields on any page and offers to fill them from your active profile.
4. **Smart Mapping** — remembers, per website, how a field was resolved last time, so you only ever answer for a given field once per site. Includes a manual fallback ("+") for fields it never recognized at all.
5. **Application History** — a local, automatic record of jobs you've submitted applications for, including which resume/cover letter you used and a status you update yourself, viewable and editable in a simple history list.

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
- Every fill (badge click, "Fill Basic Fields," or a Smart Mapping/manual-fallback pick) goes through one shared fill routine that writes the value, fires the same events a real keystroke would, and briefly cycles focus so React/Vue/Angular-based forms (Ashby, Greenhouse, Lever, Workday, etc.) register the change immediately instead of still showing "required" until you click into the field yourself.
- Ignores anything it isn't confident about, including custom employer questions, EEO/demographic questions, and free-text essay fields.

**Smart Mapping**
- Learns, per website (by domain), how each of its fields should be filled — no repeated guesswork on later visits to the same site.
- Confidently recognized fields (e.g. a field with `autocomplete="email"`) are filled and remembered automatically, with no interruption.
- Ambiguous fields (e.g. a field just labeled "Website," which could mean portfolio, LinkedIn, or something else) show a small "?" icon; click it once, pick the right profile value (or "Skip"), and that choice is remembered for that site from then on. The dropdown's best guess is marked "(suggested)" but starts unselected — you always have to actively pick an option, even the suggested one, so the choice reliably registers.
- **Custom values**: many ATS questions aren't part of your profile at all — "How did you hear about us?", "Work Authorization", "Desired Salary", "Current Employer". Pick "+ Create Custom Value…" in the picker (or "Custom value…" in the Mapping Manager), type the answer once, and it's replayed on every future visit to that site. Nothing is guessed or AI-generated — it's exactly what you typed.
- If a mapping resolves to nothing (e.g. you pick "LinkedIn" but your active profile's LinkedIn field is blank), the on-page toolbar says so explicitly instead of silently doing nothing — the mapping is still saved, so fill in the missing profile field or edit the mapping in Field Mappings.
- A **Field Mappings** manager page lets you view, search, edit (including custom values), disable, or delete any learned mapping, reset a single site, reset everything, or export/import your mappings as JSON.
- Mappings are keyed by domain, not by job posting — e.g. every company hosted on `jobs.jobvite.com` or `job-boards.greenhouse.io` shares one set of learned mappings, so the "answer once" benefit applies across every posting on that platform, not just the one you were on.
- **Manual fallback ("+")**: some fields (unusual `<textarea>`s, custom widgets, anything the detector genuinely has no signal for) never get a ⚡ or a "?" at all. A small gray "+" now appears on those instead — click it, pick which profile value to use (or "+ Create Custom Value…", same as the "?" picker), and choose whether to always use it for that field on that domain (or just this once). It's a plain picker over the same profile fields and custom-value option as everywhere else — no detection, no guessing, nothing added to what the assistant tries to recognize on its own.
- Everything stays local (`chrome.storage.local`); no AI is involved in resolving ambiguous fields, custom values, or manual fills — only your own one-time choice.

**Application History**
- After you use "Fill Basic Fields on This Page," the extension quietly watches for signs you've actually submitted the application. Clicking "Submit Application"/"Finish" (or a real form submit) never records anything by itself — it only starts a brief wait (a few seconds) for real confirmation: a "thank you"/"application received" message, or the page navigating to something that looks like a confirmation screen. If a validation error shows up instead (e.g. "Email is required"), or nothing happens before the wait ends, nothing is recorded — you can fix the form and submit again, and it'll watch again.
- The first confirmed success saves one local history record — company, position, job URL, domain, and the date — then tracking stops for that page. This is heuristic and best-effort by design, not guaranteed to catch every ATS's exact submission flow, and only runs on pages where you've used the Application Assistant at least once (it needs no new permissions, so it can't watch pages the extension was never invoked on).
- Company and position names are guessed from the page's `<h1>`, `og:site_name` meta tag, and `document.title` — usually right, occasionally off on unusual title formats. Nothing is fetched from a server to verify or improve these. Company-name detection ignores `og:site_name`/`<title>` when they're just an ATS platform's own brand (e.g. "Ashby", "Greenhouse") rather than the employer, falling back to guessing the employer from the job URL's path (e.g. `jobs.ashbyhq.com/<company>/...`) before finally falling back to the hostname; opening the History page also silently re-checks and fixes any already-saved record whose company was one of those platform-brand names.
- The same job (by URL, ignoring tracking query parameters) is never recorded twice — revisiting or reapplying just updates when it was last seen.
- **Resume Used / Cover Letter Used**: while you're filling out a form, the tracker also watches for `.pdf`/`.doc`/`.docx` files selected in any file input on the page and guesses whether each one is a resume or cover letter from its filename (e.g. "resume", "cv" vs. "cover", "letter", "motivation" — case-insensitive). Only the filename metadata is kept, never the file's contents — this extension is not a document manager, so nothing is uploaded, parsed, or read. A file it can't confidently classify is silently ignored rather than guessed at. If you select more than one resume (or cover letter) before submitting, only the most recent selection is kept, and it's scoped to that page's session — reopening the extension on a different application starts fresh, so an old resume never carries over.
- **Status**: every application has a status, changed manually via a dropdown right on its History entry — picking a value saves immediately, no Save button. Available statuses (in order): Wishlist, Applied, Online Assessment (OA), Recruiter Screen, Phone Screen, Hiring Manager Interview, Onsite Interview, Final Interview, Offer, Accepted, Rejected, Withdrawn, Ghosted — defined once in `status-config.js`, along with each one's badge color, so the dropdown never hardcodes the list. New applications always start as "Applied." Nothing about status detection is automatic — no email parsing, no LinkedIn integration, no AI; you're always the one who moves an application forward. Sorting stays by application date; status never affects the order.
  - Stored as `{ current, updatedAt }`, not a plain string, so a future phase can add full status *history* without another storage migration. Changing status only ever touches `status.current`/`status.updatedAt` — every other field on the record is untouched. Records saved before this feature (with a plain-string status) are migrated to this shape transparently the first time they're read.
- View everything in **Application History**: a newest-first list of company, position, resume/cover letter used, status, and date. Each entry has **Edit** (fix a misdetected company/position) and **Delete**. No filters, search, or export yet.
- Local only (`chrome.storage.local`), independent of the Profile Manager, Smart Mapping, and Application Assistant — no AI, no analytics, no export yet.

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
4. If an amber **?** icon appears on a field, click it and choose which profile value it should use, "Skip," or "+ Create Custom Value…" to type a fixed answer of your own. You won't be asked again for that field on that site.
5. If a small gray **+** icon appears on a field, the assistant didn't recognize it at all — click it, pick a profile value (or "+ Create Custom Value…") to fill it with, and say whether to remember that choice for this site or just use it this once.

**Reviewing what's been learned:**
1. Click the extension icon, then **Field Mappings**.
2. Browse by domain, search, edit a mapping's target, disable/delete one, or reset a whole domain.

**Reviewing your application history:**
1. Click the extension icon, then **Application History**.
2. See every application the extension has automatically recorded, newest first — including the resume/cover letter it detected and the current status.
3. Update the status dropdown on any entry as your application progresses (it saves immediately); use **Edit** to correct a misdetected company/position, or **Delete** to remove an entry.

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
- `field-mapping-storage.js` — Smart Mapping storage module (`chrome.storage.local` only); shared by the Field Mappings page and the injected Application Assistant
- `mappings.html` / `mappings.js` — Field Mappings manager UI (view/search/edit/disable/delete mappings, reset a domain or everything, export/import)
- `application-history-storage.js` — Application History storage module (`chrome.storage.local` only, independent of profiles/mappings/autofill); shared by the History page and the injected tracker
- `document-tracker.js` — generic, config-driven file-input watcher/classifier (resume vs. cover letter, by filename keyword); a single `trackDocument(type, metadata)` module reused for both document types, extensible to future document types
- `application-history-tracker.js` — on-demand, best-effort detector for a successful application submission, injected alongside the Application Assistant; also attaches the most recently selected resume/cover letter metadata (via document-tracker.js) to the recorded application
- `status-config.js` — single source of truth for available application statuses, their order, and their badge colors; read by the History page's status dropdown
- `history.html` / `history.js` — Application History UI (newest-first list with resume/cover letter used, an editable status dropdown, and per-entry Edit/Delete; foundation for future search/export features)
- `grant-access.html` / `grant-access.js` — one-off tab for granting access to a specific ATS iframe origin (e.g. Greenhouse) when a form is embedded cross-origin
- `background.js` — service worker (badge setup)
- `tests/` — regression tests for parser helpers
- `icons/` — extension icons

## Privacy

The extension only reads content already loaded in the page you're viewing. It does not log in on your behalf, call private LinkedIn APIs, or transmit data anywhere outside your browser. Profile data (including resume PDFs) is stored only in `chrome.storage.local` — never `chrome.storage.sync`, never an external server. The Application Assistant never submits a form and only fills fields it can confidently recognize.
