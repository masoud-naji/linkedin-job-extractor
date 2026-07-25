(() => {
  "use strict";

  const state = { savedJobs: [] };
  const elements = {
    bulkInput: document.getElementById("bulkInput"),
    bulkImport: document.getElementById("bulkImport"),
    bulkCopy: document.getElementById("bulkCopy"),
    bulkClear: document.getElementById("bulkClear"),
    bulkStatus: document.getElementById("bulkStatus"),
    resultsSection: document.getElementById("resultsSection"),
    resultsBody: document.getElementById("resultsBody"),
    jsonView: document.getElementById("jsonView")
  };

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    loadSavedJobs();
  });

  function bindEvents() {
    elements.bulkImport.addEventListener("click", handleBulkImport);
    elements.bulkCopy.addEventListener("click", handleCopySavedJobs);
    elements.bulkClear.addEventListener("click", handleClearSavedJobs);
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
      const result = await chrome.storage.local.get(["savedJobs"]);
      state.savedJobs = Array.isArray(result?.savedJobs) ? result.savedJobs : [];
      updateStatus();
    } catch (_error) {
      state.savedJobs = [];
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
    renderResults();
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
   * Requests job data from the tab, retrying until the description actually
   * resolves. The content script can report status "ready" as soon as any one
   * of jobTitle/companyName/description is found, which happens well before
   * the async-loaded About section renders, so a single request is not
   * enough for a freshly opened tab.
   * @param {number} tabId
   * @param {{ maxAttempts?: number, intervalMs?: number }} [options]
   * @returns {Promise<object>}
   */
  async function requestJobData(tabId, { maxAttempts = 10, intervalMs = 700 } = {}) {
    let lastResponse = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      lastResponse = await sendTabMessage(tabId, { type: "GET_JOB_DATA", fresh: true });
      const description = lastResponse?.jobData?.description;
      const hasDescription = Boolean(description) && description !== "Not found";
      const isTerminal = ["extraction_failed", "not_linkedin", "not_job_page"].includes(lastResponse?.status);
      if (hasDescription || isTerminal) {
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
