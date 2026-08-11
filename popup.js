(() => {
  "use strict";

  const NOT_FOUND = "Not found";

  // Known ATS platforms that embed their application form in a same-tab,
  // cross-origin iframe. Chrome's activeTab grant only covers the top-level
  // frame's origin, so filling fields inside one of these requires the user
  // to explicitly grant an optional host permission for that specific origin.
  // Extend this list only when a new concrete case is confirmed (same policy
  // as adding LinkedIn selector fallback tiers) — never widen it to <all_urls>.
  const KNOWN_ATS_IFRAME_HOSTS = [
    { host: "boards.greenhouse.io", pattern: "*://boards.greenhouse.io/*" },
    { host: "job-boards.greenhouse.io", pattern: "*://job-boards.greenhouse.io/*" }
  ];

  const state = {
    currentJob: null,
    expanded: false,
    busy: false,
    pendingIframePattern: null,
    pendingIframeHost: null,
    searchResultLinks: []
  };

  const elements = {
    jobTabButton: document.getElementById("jobTabButton"),
    toolsTabButton: document.getElementById("toolsTabButton"),
    jobTabPanel: document.getElementById("jobTabPanel"),
    toolsTabPanel: document.getElementById("toolsTabPanel"),
    jobTitle: document.getElementById("jobTitle"),
    statusDot: document.getElementById("statusDot"),
    messageBox: document.getElementById("messageBox"),
    summaryPanel: document.getElementById("summaryPanel"),
    fullPanel: document.getElementById("fullPanel"),
    companyName: document.getElementById("companyName"),
    companyUrl: document.getElementById("companyUrl"),
    location: document.getElementById("location"),
    badgeRow: document.getElementById("badgeRow"),
    datePosted: document.getElementById("datePosted"),
    salary: document.getElementById("salary"),
    seniorityLevel: document.getElementById("seniorityLevel"),
    applicantCount: document.getElementById("applicantCount"),
    jobUrl: document.getElementById("jobUrl"),
    description: document.getElementById("description"),
    skillsList: document.getElementById("skillsList"),
    workplaceTypeFull: document.getElementById("workplaceTypeFull"),
    employmentTypeFull: document.getElementById("employmentTypeFull"),
    easyApply: document.getElementById("easyApply"),
    jobId: document.getElementById("jobId"),
    extractedAt: document.getElementById("extractedAt"),
    toggleDetails: document.getElementById("toggleDetails"),
    copyText: document.getElementById("copyText"),
    copyJson: document.getElementById("copyJson"),
    refreshData: document.getElementById("refreshData"),
    openAIChat: document.getElementById("openAIChat"),
    bulkImportTab: document.getElementById("bulkImportTab"),
    manageProfiles: document.getElementById("manageProfiles"),
    manageMappings: document.getElementById("manageMappings"),
    viewHistory: document.getElementById("viewHistory"),
    openSettings: document.getElementById("openSettings"),
    assistantProfileSelect: document.getElementById("assistantProfileSelect"),
    fillPageBtn: document.getElementById("fillPageBtn"),
    assistantStatus: document.getElementById("assistantStatus"),
    iframePermissionRow: document.getElementById("iframePermissionRow"),
    iframePermissionText: document.getElementById("iframePermissionText"),
    grantIframeAccess: document.getElementById("grantIframeAccess"),
    searchResultsPanel: document.getElementById("searchResultsPanel"),
    searchResultsCount: document.getElementById("searchResultsCount"),
    collectSearchLinks: document.getElementById("collectSearchLinks"),
    searchResultsStatus: document.getElementById("searchResultsStatus"),
    searchResultsActions: document.getElementById("searchResultsActions"),
    sendToBulkImport: document.getElementById("sendToBulkImport"),
    manageProfileLink: document.getElementById("manageProfileLink")
  };

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    loadJobData({ fresh: false });
    loadAssistantProfiles();
    initSearchResultsPanel();
  });

  function bindEvents() {
    elements.jobTabButton.addEventListener("click", () => switchTab("job"));
    elements.toolsTabButton.addEventListener("click", () => switchTab("tools"));
    elements.toggleDetails.addEventListener("click", handleToggleDetails);
    elements.copyText.addEventListener("click", () => copyToClipboard(formatPlainText(state.currentJob), "Copied job data.", elements.copyText));
    elements.copyJson.addEventListener("click", () => copyToClipboard(JSON.stringify(state.currentJob || {}, null, 2), "Copied JSON.", elements.copyJson));
    elements.refreshData.addEventListener("click", () => loadJobData({ fresh: true }));
    elements.openAIChat.addEventListener("click", handleOpenInAIChat);
    elements.bulkImportTab.addEventListener("click", handleOpenBulkImportTab);
    elements.manageProfiles.addEventListener("click", handleOpenProfilesTab);
    elements.manageMappings.addEventListener("click", handleOpenMappingsTab);
    elements.viewHistory.addEventListener("click", handleOpenHistoryTab);
    elements.openSettings.addEventListener("click", handleOpenSettingsTab);
    elements.assistantProfileSelect.addEventListener("change", handleAssistantProfileChange);
    elements.fillPageBtn.addEventListener("click", handleFillPageClick);
    elements.grantIframeAccess.addEventListener("click", handleGrantIframeAccess);
    elements.collectSearchLinks.addEventListener("click", handleCollectSearchLinks);
    elements.sendToBulkImport.addEventListener("click", handleSendToBulkImport);
    elements.manageProfileLink.addEventListener("click", handleOpenProfilesTab);
  }

  /**
   * @param {"job" | "tools"} tab
   */
  function switchTab(tab) {
    const isJob = tab === "job";
    elements.jobTabButton.classList.toggle("active", isJob);
    elements.jobTabButton.setAttribute("aria-selected", String(isJob));
    elements.toolsTabButton.classList.toggle("active", !isJob);
    elements.toolsTabButton.setAttribute("aria-selected", String(!isJob));
    elements.jobTabPanel.classList.toggle("hidden", !isJob);
    elements.toolsTabPanel.classList.toggle("hidden", isJob);
  }

  async function loadAssistantProfiles() {
    try {
      const [profiles, activeId] = await Promise.all([
        window.LJEProfileStore.getAllProfiles(),
        window.LJEProfileStore.getActiveProfileId()
      ]);

      elements.assistantProfileSelect.textContent = "";

      if (!profiles.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No profiles yet";
        elements.assistantProfileSelect.appendChild(option);
        elements.assistantProfileSelect.disabled = true;
        elements.fillPageBtn.disabled = true;
        elements.assistantStatus.textContent = "Create a profile first (Profiles button below).";
        return;
      }

      profiles.forEach((profile) => {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.name;
        elements.assistantProfileSelect.appendChild(option);
      });

      elements.assistantProfileSelect.disabled = false;
      elements.fillPageBtn.disabled = false;
      elements.assistantProfileSelect.value = activeId || profiles[0].id;
    } catch (_error) {
      elements.assistantStatus.textContent = "Could not load profiles.";
    }
  }

  async function handleAssistantProfileChange() {
    const id = elements.assistantProfileSelect.value;
    if (!id) {
      return;
    }
    try {
      await window.LJEProfileStore.setActiveProfileId(id);
      elements.assistantStatus.textContent = "Active profile updated.";
    } catch (_error) {
      elements.assistantStatus.textContent = "Could not switch the active profile.";
    }
  }

  async function handleFillPageClick() {
    elements.assistantStatus.textContent = "";
    hideIframePermissionRow();

    const tab = await getActiveTab();
    if (!tab?.id) {
      elements.assistantStatus.textContent = "Could not access the current tab.";
      return;
    }
    if (!/^https?:\/\//i.test(tab.url || "")) {
      elements.assistantStatus.textContent = "This only works on regular web pages (http/https).";
      return;
    }

    try {
      await new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id, allFrames: true },
            files: [
              "profile-storage.js",
              "field-mapping-storage.js",
              "application-assistant.js",
              "application-history-storage.js",
              "document-tracker.js",
              "application-history-tracker.js"
            ]
          },
          () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve();
          }
        );
      });
      elements.assistantStatus.textContent = "Scan complete — look for the ⚡ icons and the toolbar on the page.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      elements.assistantStatus.textContent = `Could not run on this page (${message || "unknown error"}).`;
      return;
    }

    await checkForBlockedIframe(tab.id);
  }

  /**
   * Self-contained on purpose: chrome.scripting.executeScript's `func` option
   * serializes this function and runs it in the target page, so it cannot
   * reference anything from popup.js's outer scope.
   * @returns {string | null}
   */
  function detectBlockedIframeHostInPage() {
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const frame of iframes) {
      let accessible = true;
      try {
        accessible = Boolean(frame.contentDocument);
      } catch (_error) {
        accessible = false;
      }
      if (!accessible) {
        try {
          return new URL(frame.src, window.location.href).hostname;
        } catch (_error) {
          return frame.src || null;
        }
      }
    }
    return null;
  }

  /**
   * @param {number} tabId
   */
  async function checkForBlockedIframe(tabId) {
    let host = null;
    try {
      const results = await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({ target: { tabId }, func: detectBlockedIframeHostInPage }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(res);
        });
      });
      host = results?.[0]?.result || null;
    } catch (_error) {
      host = null;
    }

    if (!host) {
      hideIframePermissionRow();
      return;
    }

    const match = KNOWN_ATS_IFRAME_HOSTS.find((entry) => entry.host === host);
    if (!match) {
      elements.assistantStatus.textContent = `This page's form looks like it's inside an iframe (${host}) we don't have a way to request access to yet.`;
      hideIframePermissionRow();
      return;
    }

    const alreadyGranted = await new Promise((resolve) => {
      chrome.permissions.contains({ origins: [match.pattern] }, (result) => resolve(Boolean(result)));
    });
    if (alreadyGranted) {
      hideIframePermissionRow();
      return;
    }

    showIframePermissionRow(match);
  }

  /**
   * @param {{ host: string, pattern: string }} match
   */
  function showIframePermissionRow(match) {
    state.pendingIframePattern = match.pattern;
    state.pendingIframeHost = match.host;
    elements.iframePermissionText.textContent = `Form is inside ${match.host}.`;
    elements.iframePermissionRow.classList.remove("hidden");
  }

  function hideIframePermissionRow() {
    state.pendingIframePattern = null;
    state.pendingIframeHost = null;
    elements.iframePermissionRow.classList.add("hidden");
  }

  /**
   * Opens a persistent tab to request the permission, rather than calling
   * chrome.permissions.request() here directly: the browser action popup is
   * ephemeral and loses its context right as the native permission dialog
   * would appear, which silently reports the request as declined without
   * ever showing it to the user. A normal tab doesn't have that problem.
   */
  function handleGrantIframeAccess() {
    const pattern = state.pendingIframePattern;
    if (!pattern) {
      return;
    }

    const url = chrome.runtime.getURL(
      `grant-access.html?host=${encodeURIComponent(state.pendingIframeHost || "")}&pattern=${encodeURIComponent(pattern)}`
    );
    chrome.tabs.create({ url, active: true });
    elements.assistantStatus.textContent = 'Opened a new tab — click "Grant access" there, then come back and retry.';
  }

  /**
   * Shows the Search Results collector only on a LinkedIn Jobs search page,
   * since it reads the left-side results list and has nothing to act on
   * anywhere else (including a standalone `/jobs/view/{id}` page).
   */
  async function initSearchResultsPanel() {
    const tab = await getActiveTab();
    const isSearchPage = isLinkedInSearchResultsUrl(tab?.url || "");
    elements.searchResultsPanel.classList.toggle("hidden", !isSearchPage);
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isLinkedInSearchResultsUrl(url) {
    return /^https:\/\/www\.linkedin\.com\/jobs\/(search|search-results)\//i.test(url || "");
  }

  async function handleCollectSearchLinks() {
    elements.searchResultsActions.classList.add("hidden");
    state.searchResultLinks = [];
    elements.collectSearchLinks.disabled = true;
    elements.searchResultsStatus.textContent = "Collecting job links...";

    try {
      const tab = await getActiveTab();
      if (!tab?.id || !isLinkedInSearchResultsUrl(tab.url || "")) {
        elements.searchResultsStatus.textContent = "Open a LinkedIn Jobs search page first.";
        return;
      }

      const rawLimit = elements.searchResultsCount.value;
      const limit = rawLimit === "all" ? null : Number(rawLimit);
      const response = await requestSearchResultLinks(tab.id, limit);

      if (!response?.ok) {
        elements.searchResultsStatus.textContent = response?.message || "Could not collect job links.";
        return;
      }

      state.searchResultLinks = Array.isArray(response.links) ? response.links : [];
      if (!state.searchResultLinks.length) {
        elements.searchResultsStatus.textContent = "No job links found in the results list.";
        return;
      }

      const count = state.searchResultLinks.length;
      elements.searchResultsStatus.textContent = `✓ ${count} unique job${count === 1 ? "" : "s"} found.`;
      elements.sendToBulkImport.textContent = `Send ${count} Job${count === 1 ? "" : "s"} to Bulk Import`;
      elements.searchResultsActions.classList.remove("hidden");
    } catch (error) {
      elements.searchResultsStatus.textContent = getFriendlyError(error);
    } finally {
      elements.collectSearchLinks.disabled = false;
    }
  }

  /**
   * @param {number} tabId
   * @param {number | null} limit
   * @returns {Promise<object>}
   */
  async function requestSearchResultLinks(tabId, limit) {
    try {
      return await sendTabMessage(tabId, { type: "COLLECT_SEARCH_RESULT_LINKS", limit });
    } catch (firstError) {
      await injectContentScript(tabId);
      try {
        return await sendTabMessage(tabId, { type: "COLLECT_SEARCH_RESULT_LINKS", limit });
      } catch (_secondError) {
        throw firstError;
      }
    }
  }

  /**
   * Hands the collected links off to the existing Bulk Import tab by
   * pre-filling its textarea. Import itself stays a separate, explicit step
   * the user takes there — this only opens/populates the page.
   */
  async function handleSendToBulkImport() {
    if (!state.searchResultLinks.length) {
      return;
    }
    try {
      await chrome.storage.local.set({ pendingBulkImportLinks: state.searchResultLinks });
      chrome.tabs.create({ url: chrome.runtime.getURL("bulk.html"), active: true });
    } catch (_error) {
      elements.searchResultsStatus.textContent = "Could not open Bulk Import.";
    }
  }

  /**
   * @param {{ fresh: boolean }} options
   */
  async function loadJobData(options) {
    setBusy(true);
    showMessage("Reading the current tab...", "loading");

    try {
      const tab = await getActiveTab();
      if (!tab?.id || !isLinkedInUrl(tab.url || "")) {
        renderUnavailable("Open a LinkedIn job page to extract job details.", "not_linkedin");
        return;
      }

      if (!isLinkedInJobUrl(tab.url || "")) {
        renderUnavailable("Open a LinkedIn job page to extract job details.", "not_job_page");
        return;
      }

      const response = await requestJobData(tab.id, options.fresh);
      renderResponse(response);
    } catch (error) {
      renderUnavailable(getFriendlyError(error), "error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * @returns {Promise<chrome.tabs.Tab | null>}
   */
  function getActiveTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(tabs?.[0] || null);
        });
      } catch (_error) {
        resolve(null);
      }
    });
  }

  /**
   * @param {number} tabId
   * @param {boolean} fresh
   * @returns {Promise<object>}
   */
  async function requestJobData(tabId, fresh) {
    try {
      return await sendTabMessage(tabId, { type: "GET_JOB_DATA", fresh });
    } catch (firstError) {
      await injectContentScript(tabId);
      try {
        return await sendTabMessage(tabId, { type: "GET_JOB_DATA", fresh: true });
      } catch (_secondError) {
        throw firstError;
      }
    }
  }

  /**
   * @param {number} tabId
   * @param {object} message
   * @returns {Promise<object>}
   */
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

  /**
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  function injectContentScript(tabId) {
    return new Promise((resolve, reject) => {
      try {
        chrome.scripting.executeScript({
          target: { tabId },
          // Must match manifest.json's content_scripts file list and order:
          // content.js calls window.parsers.* (normalizeLinkedInUrl,
          // isRealSalary, extractJobIdFromUrl) without checking it's
          // defined, so injecting content.js alone here — as this fallback
          // used to — left those calls silently degrading (empty
          // string / false) whenever this path ran, e.g. after the
          // extension reloads while a LinkedIn tab stays open and the
          // declarative content_scripts injection never re-ran for it.
          files: ["parsers.js", "content.js"]
        }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * @param {object} response
   */
  function renderResponse(response) {
    if (!response?.ok) {
      state.currentJob = response?.jobData || null;
      if (state.currentJob) {
        renderJob(state.currentJob, response.message || "LinkedIn is still loading this job. Click Refresh Job Data.", response.status);
        return;
      }
      renderUnavailable(response?.message || "Extraction failed unexpectedly. Click Refresh Job Data.", response?.status || "error");
      return;
    }

    state.currentJob = response.jobData;
    renderJob(response.jobData, response.message, response.status);
  }

  /**
   * @param {object} job
   * @param {string} message
   * @param {string} status
   */
  function renderJob(job, message, status) {
    elements.summaryPanel.classList.remove("hidden");
    elements.fullPanel.classList.toggle("hidden", !state.expanded);
    elements.jobTitle.textContent = valueOrFallback(job.jobTitle);
    elements.companyName.textContent = valueOrFallback(job.companyName);
    elements.location.textContent = valueOrFallback(job.location);
    elements.datePosted.textContent = valueOrFallback(job.datePosted);
    elements.salary.textContent = valueOrFallback(job.salary);
    elements.seniorityLevel.textContent = valueOrFallback(job.seniorityLevel);
    elements.applicantCount.textContent = valueOrFallback(job.applicantCount);
    elements.description.textContent = valueOrFallback(job.description);
    elements.workplaceTypeFull.textContent = valueOrFallback(job.workplaceType);
    elements.employmentTypeFull.textContent = valueOrFallback(job.employmentType);
    elements.easyApply.textContent = job.easyApply === true ? "Yes" : "No";
    elements.jobId.textContent = valueOrFallback(job.jobId);
    elements.extractedAt.textContent = formatDate(job.extractedAt);

    setSafeLink(elements.companyUrl, job.companyUrl, "Company profile");
    setSafeLink(elements.jobUrl, job.jobUrl, valueOrFallback(job.jobUrl));
    renderBadges(job);
    renderSkills(Array.isArray(job.skills) ? job.skills : []);
    showMessage(message || "Job details extracted from the current page.", status === "ready" ? "ready" : "warning");
    setCopyEnabled(Boolean(job));
  }

  /**
   * @param {string} message
   * @param {string} status
   */
  function renderUnavailable(message, status) {
    state.currentJob = null;
    elements.summaryPanel.classList.add("hidden");
    elements.fullPanel.classList.add("hidden");
    elements.jobTitle.textContent = "Open a LinkedIn job";
    elements.badgeRow.textContent = "";
    showMessage(message, status === "error" ? "error" : "warning");
    setCopyEnabled(false);
  }

  /**
   * @param {object} job
   */
  function renderBadges(job) {
    elements.badgeRow.textContent = "";
    const values = [job.workplaceType, job.employmentType];
    if (job.easyApply === true) {
      values.push("Easy Apply");
    }
    if (job.applicationClosed === true) {
      values.push("Closed");
    }

    values
      .filter((value) => value && value !== NOT_FOUND && value !== "Unknown")
      .forEach((value) => {
        const badge = document.createElement("span");
        badge.className = value === "Easy Apply" ? "badge easy" : value === "Closed" ? "badge closed" : "badge";
        badge.textContent = value;
        elements.badgeRow.appendChild(badge);
      });
  }

  /**
   * @param {string[]} skills
   */
  function renderSkills(skills) {
    elements.skillsList.textContent = "";
    if (!skills.length) {
      const item = document.createElement("li");
      item.textContent = NOT_FOUND;
      elements.skillsList.appendChild(item);
      return;
    }

    skills.forEach((skill) => {
      const item = document.createElement("li");
      item.textContent = skill;
      elements.skillsList.appendChild(item);
    });
  }

  async function handleToggleDetails() {
    if (!state.expanded) {
      await expandAndRefreshDescription();
      state.expanded = true;
    } else {
      state.expanded = false;
    }

    elements.fullPanel.classList.toggle("hidden", !state.expanded);
    elements.toggleDetails.textContent = state.expanded ? "Hide Full Job Details" : "Show Full Job Details";
  }

  async function expandAndRefreshDescription() {
    setBusy(true);
    try {
      const tab = await getActiveTab();
      if (!tab?.id) {
        return;
      }
      const response = await sendTabMessage(tab.id, { type: "EXPAND_AND_GET_JOB_DATA" });
      if (response?.jobData) {
        state.currentJob = response.jobData;
        renderJob(response.jobData, response.message || "Job details extracted from the current page.", response.status || "ready");
      }
    } catch (_error) {
      showMessage("Could not expand the job description. The visible details are still available.", "warning");
    } finally {
      setBusy(false);
    }
  }

  function handleOpenBulkImportTab() {
    chrome.tabs.create({ url: chrome.runtime.getURL("bulk.html"), active: true });
  }

  function handleOpenProfilesTab() {
    chrome.tabs.create({ url: chrome.runtime.getURL("profiles.html"), active: true });
  }

  function handleOpenMappingsTab() {
    chrome.tabs.create({ url: chrome.runtime.getURL("mappings.html"), active: true });
  }

  function handleOpenHistoryTab() {
    chrome.tabs.create({ url: chrome.runtime.getURL("history.html"), active: true });
  }

  function handleOpenSettingsTab() {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html"), active: true });
  }

  /**
   * "Open in AI Chat" — combines the AI Assistant Settings (prompt,
   * include-context preference, destination/provider) with the CURRENTLY
   * EXTRACTED job (state.currentJob, the same object Copy as JSON already
   * serializes — no second extraction) and, optionally, the active
   * Profile's context. Copies the result and opens the configured
   * destination; falls back to a brand-new chat on the preferred provider
   * when no default destination is set, so the button always does
   * something useful even before Settings has been touched.
   */
  async function handleOpenInAIChat() {
    if (!state.currentJob) {
      showMessage("No job data is available yet.", "warning");
      return;
    }
    const aiSettings = window.LJEAISettings;
    const aiContext = window.LJEAIContext;
    if (!aiSettings || !aiContext) {
      showMessage("AI Assistant is unavailable.", "error");
      return;
    }

    try {
      const [prompt, includeContext] = await Promise.all([
        aiSettings.getEffectivePrompt(),
        aiSettings.getIncludeProfileContext()
      ]);

      let profileContext = null;
      if (includeContext && window.LJEProfileStore) {
        const activeProfile = await window.LJEProfileStore.getActiveProfile();
        if (activeProfile) {
          profileContext = aiContext.buildProfileContext(activeProfile);
        }
      }

      const payload = aiContext.buildJobChatPayload({ prompt, job: state.currentJob, profileContext });
      await navigator.clipboard.writeText(payload);

      const destination = await aiSettings.getDefaultDestination();
      const destinationUrl = destination
        ? destination.url
        : aiSettings.getProvider(await aiSettings.getPreferredAIProvider()).newChatUrl;
      chrome.tabs.create({ url: destinationUrl, active: true });

      showMessage("Prompt and job data copied. Paste it into the chat.", "ready");
    } catch (_error) {
      showMessage("Copy failed. Chrome may require focus or clipboard permission for this action.", "error");
    }
  }

  /**
   * @param {string} value
   * @param {string} successMessage
   * @param {HTMLButtonElement} button
   */
  async function copyToClipboard(value, successMessage, button) {
    if (!state.currentJob || !value) {
      showMessage("No job data is available to copy.", "warning");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      const originalText = button.textContent;
      button.textContent = "Copied";
      showMessage(successMessage, "ready");
      window.setTimeout(() => {
        button.textContent = originalText;
      }, 1100);
    } catch (_error) {
      showMessage("Copy failed. Chrome may require focus or clipboard permission for this action.", "error");
    }
  }

  /**
   * @param {object | null} job
   * @returns {string}
   */
  function formatPlainText(job) {
    if (!job) {
      return "";
    }

    const lines = [
      `Job Title: ${valueOrFallback(job.jobTitle)}`,
      `Company: ${valueOrFallback(job.companyName)}`,
      `Company URL: ${valueOrFallback(job.companyUrl)}`,
      `Location: ${valueOrFallback(job.location)}`,
      `Workplace Type: ${valueOrFallback(job.workplaceType)}`,
      `Employment Type: ${valueOrFallback(job.employmentType)}`,
      `Seniority: ${valueOrFallback(job.seniorityLevel)}`,
      `Salary: ${valueOrFallback(job.salary)}`,
      `Date Posted: ${valueOrFallback(job.datePosted)}`,
      `Applicants: ${valueOrFallback(job.applicantCount)}`,
      `Easy Apply: ${job.easyApply === true ? "Yes" : "No"}`,
      `Application Closed: ${job.applicationClosed === true ? "Yes" : "No"}`,
      `Job URL: ${valueOrFallback(job.jobUrl)}`,
      `LinkedIn Job ID: ${valueOrFallback(job.jobId)}`,
      `Extracted At: ${valueOrFallback(job.extractedAt)}`,
      "",
      "Skills:",
      Array.isArray(job.skills) && job.skills.length ? job.skills.join(", ") : NOT_FOUND,
      "",
      "About the Job:",
      valueOrFallback(job.description)
    ];

    return lines.join("\n");
  }

  /**
   * @param {HTMLAnchorElement} link
   * @param {string} url
   * @param {string} label
   */
  function setSafeLink(link, url, label) {
    if (!isSafeLinkedInUrl(url)) {
      link.removeAttribute("href");
      link.textContent = NOT_FOUND;
      link.classList.toggle("hidden", link.id === "companyUrl");
      return;
    }

    link.href = url;
    link.textContent = label || url;
    link.classList.remove("hidden");
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isSafeLinkedInUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && parsed.hostname.endsWith("linkedin.com");
    } catch (_error) {
      return false;
    }
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isLinkedInUrl(url) {
    return isSafeLinkedInUrl(url);
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isLinkedInJobUrl(url) {
    // Matches both the standalone `/jobs/view/{id}` page and the multi-column
    // `/jobs/search/` or `/jobs/search-results/` layout. Whether a job is
    // actually selected in search mode (currentJobId present, detail pane
    // rendered) is decided by the content script's response, not here.
    return /^https:\/\/www\.linkedin\.com\/jobs\/(view|search-results|search)\//i.test(url || "");
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function valueOrFallback(value) {
    if (typeof value === "boolean") {
      return value ? "Yes" : "No";
    }
    const text = String(value || "").trim();
    return text || NOT_FOUND;
  }

  /**
   * @param {string} isoValue
   * @returns {string}
   */
  function formatDate(isoValue) {
    if (!isoValue || isoValue === NOT_FOUND) {
      return NOT_FOUND;
    }
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) {
      return valueOrFallback(isoValue);
    }
    return date.toLocaleString();
  }

  /**
   * @param {string} message
   * @param {"ready" | "warning" | "error" | "loading"} tone
   */
  function showMessage(message, tone) {
    elements.messageBox.textContent = message;
    elements.messageBox.classList.remove("hidden");
    elements.statusDot.classList.remove("ready", "error");

    if (tone === "ready") {
      elements.statusDot.classList.add("ready");
    } else if (tone === "error") {
      elements.statusDot.classList.add("error");
    }
  }

  /**
   * @param {boolean} busy
   */
  function setBusy(busy) {
    state.busy = busy;
    elements.refreshData.disabled = busy;
    elements.toggleDetails.disabled = busy || !state.currentJob;
  }

  /**
   * @param {boolean} enabled
   */
  function setCopyEnabled(enabled) {
    elements.copyText.disabled = !enabled;
    elements.copyJson.disabled = !enabled;
    elements.openAIChat.disabled = !enabled;
    elements.toggleDetails.disabled = !enabled || state.busy;
  }

  /**
   * @param {unknown} error
   * @returns {string}
   */
  function getFriendlyError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (/receiving end does not exist|cannot access|missing host permission|chrome:\/\//i.test(message)) {
      return "The content script is unavailable. Open or refresh a LinkedIn job page, then click Refresh Job Data.";
    }
    return "Extraction failed unexpectedly. Click Refresh Job Data.";
  }
})();
