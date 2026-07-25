# LinkedIn Job Extractor

A Chrome extension (Manifest V3) that extracts structured job details from the LinkedIn job posting page you're currently viewing.

## Features

- Extracts job title, company, company URL, location, workplace type, employment type, seniority level, salary, date posted, applicant count, full description, skills, Easy Apply status, job URL, and job ID.
- Works on individual job pages and LinkedIn's job search results.
- Bulk extraction mode for pulling data from multiple job listings at once.
- Reads only what's already rendered in your browser — no external API calls, no scraping services, no credentials handled.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.

## Usage

1. Navigate to a LinkedIn job page (`linkedin.com/jobs/view/...`) or a job search results page.
2. Click the extension icon in the toolbar.
3. View, copy, or export the extracted job data from the popup.

For extracting multiple jobs at once, use the bulk extraction page bundled with the extension.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `activeTab` | Read the currently active LinkedIn tab when you invoke the extension |
| `scripting` | Inject the extraction script into the LinkedIn job page |
| `storage` | Save extraction results and preferences locally |
| `tabs` | Identify and communicate with the active LinkedIn tab |

Host access is limited to `linkedin.com`. No data is sent to any server; everything stays in your browser.

## Development

There is no build step — this is plain JavaScript loaded unpacked by Chrome.

- Run parser regression tests: `node tests/parsers.test.js`
- Syntax-check the content script: `node --check content.js`

## Project structure

- `manifest.json` — extension definition
- `content.js` — extraction logic, run on LinkedIn job pages
- `parsers.js` — shared parsing helpers (URLs, salary, etc.)
- `popup.html` / `popup.js` / `popup.css` — extension popup UI
- `bulk.html` / `bulk.js` — bulk extraction UI
- `background.js` — service worker (badge setup)
- `tests/` — regression tests for parser helpers
- `icons/` — extension icons

## Privacy

The extension only reads content already loaded in the page you're viewing. It does not log in on your behalf, call private LinkedIn APIs, or transmit data anywhere outside your browser.
