(() => {
  "use strict";

  // `lastBulkImport` is deliberately a single object (not a history list): we
  // only need to know when/how the MOST RECENT completed import run went, so
  // the "Saved jobs" table can be labeled either as that latest run's result
  // or, when the textarea no longer matches what was last imported, clearly
  // marked as leftovers from before. `savedJobs` itself stays the same flat,
  // cross-run-deduped array it always was — nothing about its shape changes.
  //
  // `hasPendingInputChanges` tracks whether the textarea has been touched
  // (typed, pasted, edited, or programmatically filled from Search Results)
  // since the last completed import. The saved-jobs table can only be
  // labeled "current" when this is false AND a completed import exists — any
  // textarea change immediately invalidates that, even before the user
  // clicks Import jobs.
  const state = { savedJobs: [], lastBulkImport: null, hasPendingInputChanges: false };
  const elements = {
    bulkInput: document.getElementById("bulkInput"),
    bulkImport: document.getElementById("bulkImport"),
    bulkCopy: document.getElementById("bulkCopy"),
    bulkClear: document.getElementById("bulkClear"),
    bulkStatus: document.getElementById("bulkStatus"),
    resultsSection: document.getElementById("resultsSection"),
    resultsHeading: document.getElementById("resultsHeading"),
    resultsMeta: document.getElementById("resultsMeta"),
    resultsSummary: document.getElementById("resultsSummary"),
    resultsBody: document.getElementById("resultsBody"),
    jsonView: document.getElementById("jsonView")
  };

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    // Sequenced (not parallel) so a pending hand-off's status message always
    // wins over loadSavedJobs' "N saved jobs" summary, since it reflects the
    // action the user just took.
    await loadSavedJobs();
    await loadPendingSearchResultLinks();
  });

  /**
   * Picks up links handed off from the popup's Search Results collector
   * (Send to Bulk Import). Only pre-fills the textarea — importing stays a
   * separate, explicit step the user takes with the existing Import jobs
   * button below.
   */
  async function loadPendingSearchResultLinks() {
    try {
      const result = await chrome.storage.local.get(["pendingBulkImportLinks"]);
      const links = Array.isArray(result?.pendingBulkImportLinks) ? result.pendingBulkImportLinks : [];
      if (!links.length) {
        return;
      }
      await chrome.storage.local.remove("pendingBulkImportLinks");
      // Setting .value programmatically does not fire an "input" event, so
      // this path must mark the input as pending itself (handleBulkInputChanged
      // covers manual typing/pasting/editing).
      elements.bulkInput.value = links.join("\n");
      state.hasPendingInputChanges = true;
      showResults();
      setStatus(`Loaded ${links.length} link${links.length === 1 ? "" : "s"} from Search Results. Review, then click Import jobs.`);
    } catch (_error) {
      // Ignore; textarea just stays empty and the user can paste manually.
    }
  }

  function bindEvents() {
    elements.bulkImport.addEventListener("click", handleBulkImport);
    elements.bulkCopy.addEventListener("click", handleCopySavedJobs);
    elements.bulkClear.addEventListener("click", handleClearSavedJobs);
    elements.bulkInput.addEventListener("input", handleBulkInputChanged);
  }

  /**
   * Any manual edit to the textarea (typing, pasting, deleting, replacing)
   * means the saved-jobs table below no longer corresponds to the current
   * input, so it can no longer be labeled "current" until a new import
   * completes for this input.
   */
  function handleBulkInputChanged() {
    if (state.hasPendingInputChanges) {
      return;
    }
    state.hasPendingInputChanges = true;
    renderResultsHeading();
  }

  async function handleBulkImport() {
    const links = extractLinks(elements.bulkInput.value);
    if (!links.length) {
      setStatus("Paste at least one LinkedIn job link to import.");
      return;
    }

    setStatus(`Importing ${links.length} job${links.length === 1 ? "" : "s"}...`);

    const openedTabIds = [];
    try {
      const importedJobs = [];
      for (const link of links) {
        const tab = await createAndWaitForTab(link);
        openedTabIds.push(tab.id);
        try {
          const response = await requestJobData(tab.id);
          const jobData = response?.jobData && typeof response.jobData === "object" ? response.jobData : null;
          if (jobData) {
            importedJobs.push({ ...jobData, sourceUrl: link });
          }
        } finally {
          await closeImportTab(tab.id);
        }
      }

      const deduped = dedupeJobs([...state.savedJobs, ...importedJobs]);
      state.savedJobs = deduped;
      await saveJobsToStorage(deduped);
      state.lastBulkImport = await saveLastImportMeta({
        processedCount: links.length,
        savedCount: importedJobs.length,
        failedCount: links.length - importedJobs.length
      });
      // The import that just completed is for the input that was in the
      // textarea when it finished — this is the ONLY place the table becomes
      // "current" again.
      state.hasPendingInputChanges = false;
      elements.bulkInput.value = "";
      showResults();
      setStatus(`Imported ${importedJobs.length} job${importedJobs.length === 1 ? "" : "s"} and saved them locally.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      // Safety net: force-close any import tab that didn't close after its
      // own job finished.
      await Promise.all(openedTabIds.map((id) => closeImportTab(id)));
    }
  }

  /**
   * Closes an import tab, logging (not swallowing) failures so a
   * persistently-open tab can be diagnosed instead of silently ignored.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function closeImportTab(tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      console.error("[LinkedIn Job Extractor] Failed to close import tab", tabId, error);
    }
  }

  async function handleCopySavedJobs() {
    if (!state.savedJobs.length) {
      setStatus("No saved jobs to copy yet.");
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(state.savedJobs, null, 2));
      setStatus("Saved jobs JSON copied to your clipboard.");
    } catch (_error) {
      setStatus("Copy failed. Please allow clipboard access.");
    }
  }

  async function handleClearSavedJobs() {
    state.savedJobs = [];
    await saveJobsToStorage([]);
    showResults();
    setStatus("Saved jobs cleared.");
  }

  async function loadSavedJobs() {
    try {
      const result = await chrome.storage.local.get(["savedJobs", "lastBulkImport"]);
      state.savedJobs = Array.isArray(result?.savedJobs) ? result.savedJobs : [];
      state.lastBulkImport = result?.lastBulkImport && typeof result.lastBulkImport === "object" ? result.lastBulkImport : null;
      updateStatus();
    } catch (_error) {
      state.savedJobs = [];
      state.lastBulkImport = null;
      updateStatus();
    }
  }

  async function saveJobsToStorage(jobs) {
    try {
      await chrome.storage.local.set({ savedJobs: jobs });
    } catch (_error) {
      // Ignore storage errors.
    }
  }

  /**
   * Persists metadata for the MOST RECENT completed import run only (a
   * single object, not a growing history list) so the results table can be
   * labeled "Current Saved Jobs" with a timestamp/summary instead of silently
   * looking like it belongs to whatever links currently sit in the textarea.
   * @param {{ processedCount: number, savedCount: number, failedCount: number }} counts
   * @returns {Promise<object>}
   */
  async function saveLastImportMeta(counts) {
    const meta = { completedAt: new Date().toISOString(), ...counts };
    try {
      await chrome.storage.local.set({ lastBulkImport: meta });
    } catch (_error) {
      // Ignore storage errors; the in-memory value still drives this
      // session's UI even if it didn't persist for next time.
    }
    return meta;
  }

  function updateStatus() {
    if (!state.savedJobs.length) {
      elements.resultsSection.hidden = true;
      setStatus("No jobs saved yet.");
      return;
    }
    showResults();
    setStatus(`${state.savedJobs.length} saved job${state.savedJobs.length === 1 ? "" : "s"}.`);
  }

  function showResults() {
    if (!state.savedJobs.length) {
      elements.resultsSection.hidden = true;
      elements.resultsBody.innerHTML = "";
      elements.jsonView.textContent = "";
      return;
    }
    elements.resultsSection.hidden = false;
    renderResultsHeading();
    renderResults();
  }

  /**
   * Labels the results table so it's never mistaken for the outcome of
   * whatever is currently in the textarea. Only two states:
   * - "Current Saved Jobs": a completed import is on record AND the
   *   textarea hasn't changed since it finished. Shows that import's
   *   timestamp and, when available, a processed/saved/failed breakdown.
   * - "Previous Saved Jobs": everything else — legacy data saved before this
   *   metadata existed, a completed import whose input has since been
   *   edited/replaced, or Search Results links sitting unimported. Shows
   *   "Last import: <timestamp>" only when a completed import is on record;
   *   never fabricates a date for legacy data.
   */
  function renderResultsHeading() {
    const isCurrent = Boolean(state.lastBulkImport) && !state.hasPendingInputChanges;

    if (isCurrent) {
      elements.resultsHeading.textContent = "Current Saved Jobs";
      elements.resultsMeta.textContent = formatTimestamp(state.lastBulkImport.completedAt);
      elements.resultsMeta.hidden = false;
      const summary = formatImportSummary(state.lastBulkImport);
      elements.resultsSummary.textContent = summary;
      elements.resultsSummary.hidden = !summary;
      return;
    }

    elements.resultsHeading.textContent = "Previous Saved Jobs";
    if (state.lastBulkImport) {
      elements.resultsMeta.textContent = `Last import: ${formatTimestamp(state.lastBulkImport.completedAt)}`;
      elements.resultsMeta.hidden = false;
    } else {
      elements.resultsMeta.hidden = true;
    }
    elements.resultsSummary.hidden = true;
  }

  /**
   * @param {{ processedCount?: number, savedCount?: number, failedCount?: number }} meta
   * @returns {string}
   */
  function formatImportSummary(meta) {
    const { processedCount, savedCount, failedCount } = meta || {};
    if (typeof failedCount === "number" && failedCount > 0 && typeof processedCount === "number") {
      return `${processedCount} job${processedCount === 1 ? "" : "s"} processed · ${savedCount} saved · ${failedCount} failed`;
    }
    if (typeof savedCount === "number") {
      return `${savedCount} job${savedCount === 1 ? "" : "s"} saved`;
    }
    return "";
  }

  /**
   * @param {string} isoValue
   * @returns {string}
   */
  function formatTimestamp(isoValue) {
    const date = new Date(isoValue || "");
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function setStatus(message) {
    elements.bulkStatus.textContent = message;
  }

  function renderResults() {
    elements.resultsBody.innerHTML = "";
    elements.jsonView.textContent = JSON.stringify(state.savedJobs, null, 2);

    state.savedJobs.forEach((job) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHtml(job.jobTitle || "Not found")}</td>
        <td>${escapeHtml(job.companyName || "Not found")}</td>
        <td>${escapeHtml(job.location || "Not found")}</td>
        <td>${escapeHtml(job.salary || "Not found")}</td>
        <td>${job.applicationClosed === true ? "Closed" : "Open"}</td>
      `;
      elements.resultsBody.appendChild(row);
    });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function extractLinks(text) {
    const matches = String(text || "").match(/https?:\/\/[^\s<>"')]+/gi) || [];
    return matches
      .map((value) => value.replace(/[),.;]+$/, ""))
      .filter((value, index, array) => array.indexOf(value) === index);
  }

  /**
   * Opens the job URL as a new tab in the current window. LinkedIn's
   * rendering (including the async-loaded description) runs on
   * requestAnimationFrame, which Chrome does not fire for a hidden/background
   * tab, so the tab is opened active rather than in the background.
   * @param {string} url
   * @returns {Promise<chrome.tabs.Tab>}
   */
  async function createAndWaitForTab(url) {
    const tab = await chrome.tabs.create({ url, active: true });
    await waitForTabReady(tab.id);
    return tab;
  }

  async function waitForTabReady(tabId) {
    for (let index = 0; index < 60; index += 1) {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === "complete") {
        return tab;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    return chrome.tabs.get(tabId);
  }

  /**
   * Requests job data from the tab, retrying until both the description and
   * the header location actually resolve. The content script can report
   * status "ready" as soon as any one of jobTitle/companyName/description is
   * found, which happens well before the async-loaded About section and
   * header metadata (location included) finish rendering, so a single
   * request is not enough for a freshly opened tab. Description alone isn't
   * a reliable "fully loaded" signal either: on some layouts the header
   * location renders slightly after the description resolves, which used to
   * make bulk import cut the poll short and save "Not found" for location on
   * jobs that do have one (confirmed by comparing against the individual
   * popup extraction, which naturally allows more time before requesting).
   * @param {number} tabId
   * @param {{ maxAttempts?: number, intervalMs?: number }} [options]
   * @returns {Promise<object>}
   */
  async function requestJobData(tabId, { maxAttempts = 10, intervalMs = 700 } = {}) {
    let lastResponse = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      lastResponse = await sendTabMessage(tabId, { type: "GET_JOB_DATA", fresh: true });
      const description = lastResponse?.jobData?.description;
      const location = lastResponse?.jobData?.location;
      const hasDescription = Boolean(description) && description !== "Not found";
      const hasLocation = Boolean(location) && location !== "Not found";
      const isTerminal = ["extraction_failed", "not_linkedin", "not_job_page"].includes(lastResponse?.status);
      if ((hasDescription && hasLocation) || isTerminal) {
        return lastResponse;
      }
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    }
    return lastResponse;
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response || {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function dedupeJobs(jobs) {
    const seen = new Set();
    return jobs.filter((job) => {
      const key = job?.jobId || job?.sourceUrl || job?.jobUrl || JSON.stringify(job);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
})();
