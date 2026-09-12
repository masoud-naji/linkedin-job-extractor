importScripts("job-format.js");

const CONTEXT_MENU_PARENT_ID = "ljeJobAssistant";
const CONTEXT_MENU_COPY_TEXT_ID = "ljeCopyJobData";
const CONTEXT_MENU_COPY_JSON_ID = "ljeCopyAsJson";

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#0a66c2" });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PARENT_ID,
      title: "Job Assistant",
      contexts: ["page", "selection", "link", "image"],
      documentUrlPatterns: ["https://www.linkedin.com/jobs/*"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_COPY_TEXT_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Copy Job Data",
      contexts: ["page", "selection", "link", "image"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_COPY_JSON_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Copy as JSON",
      contexts: ["page", "selection", "link", "image"]
    });
  });
});

/**
 * Writes text to the clipboard from the page's own context. Self-contained
 * on purpose: chrome.scripting.executeScript's `func` option serializes this
 * function and runs it in the target page, so it cannot reference anything
 * from background.js's outer scope.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
function writeTextToPageClipboard(text) {
  return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
}

/**
 * Asks the existing content script (already registered for LinkedIn job
 * pages in manifest.json) for the currently extracted job data, reusing the
 * same extraction pipeline the popup relies on.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, message?: string, jobData?: object|null}>}
 */
function requestJobDataFromTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_JOB_DATA" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve({ ok: false, message: "Job data could not be found on this page." });
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Shows a lightweight, self-dismissing status message on the page so
 * failures (unsupported page, extraction miss, clipboard denial) are never
 * silent or an uncaught error. Self-contained for the same reason as
 * writeTextToPageClipboard above.
 * @param {string} text
 */
function showPageNotification(text) {
  try {
    const existing = document.getElementById("__ljeContextMenuNotice");
    if (existing) {
      existing.remove();
    }
    const el = document.createElement("div");
    el.id = "__ljeContextMenuNotice";
    el.textContent = text;
    el.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:2147483647;" +
      "background:#0a66c2;color:#fff;padding:10px 14px;border-radius:6px;" +
      "font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);" +
      "max-width:320px;";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  } catch (_error) {
    // Best-effort notification only; never let this throw into the caller.
  }
}

/**
 * @param {number} tabId
 * @param {string} text
 */
function notifyTab(tabId, text) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: showPageNotification,
    args: [text]
  }).catch(() => {
    // Nothing left to notify (e.g. tab closed) — fail silently.
  });
}

/**
 * Shared handler for both context-menu items: fetch job data via the
 * existing content-script/message-passing architecture, format it with the
 * same logic the popup's Copy Job Data / Copy as JSON buttons use, then
 * copy it in the page's context. Fails gracefully with a page notification
 * whenever the page isn't supported or extraction comes back empty.
 * @param {number} tabId
 * @param {"text" | "json"} format
 */
async function copyJobDataFromContextMenu(tabId, format) {
  const response = await requestJobDataFromTab(tabId);

  if (!response.ok || !response.jobData) {
    notifyTab(tabId, "Job data could not be found on this page.");
    return;
  }

  const payload = format === "json"
    ? LJEJobFormat.formatJson(response.jobData)
    : LJEJobFormat.formatPlainText(response.jobData);

  if (!payload) {
    notifyTab(tabId, "Job data could not be found on this page.");
    return;
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: writeTextToPageClipboard,
      args: [payload]
    });

    if (result?.result) {
      notifyTab(tabId, format === "json" ? "Copied job JSON to clipboard." : "Copied job data to clipboard.");
    } else {
      notifyTab(tabId, "Could not copy to the clipboard on this page.");
    }
  } catch (_error) {
    notifyTab(tabId, "Job data could not be found on this page.");
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) {
    return;
  }
  if (info.menuItemId === CONTEXT_MENU_COPY_TEXT_ID) {
    copyJobDataFromContextMenu(tab.id, "text");
  } else if (info.menuItemId === CONTEXT_MENU_COPY_JSON_ID) {
    copyJobDataFromContextMenu(tab.id, "json");
  }
});
