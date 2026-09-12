importScripts("job-format.js");

const CONTEXT_MENU_PARENT_ID = "ljeJobAssistant";
const CONTEXT_MENU_COPY_TEXT_ID = "ljeCopyJobData";
const CONTEXT_MENU_COPY_JSON_ID = "ljeCopyAsJson";
const CONTEXT_MENU_SEPARATOR_ID = "ljePageCaptureSeparator";
const CONTEXT_MENU_COPY_SECTION_ID = "ljeCopyThisSection";
const CONTEXT_MENU_SELECT_SECTION_ID = "ljeSelectSectionToCopy";
const CONTEXT_MENU_COPY_ALL_TEXT_ID = "ljeCopyAllPageText";

// Job Extractor menu items only make sense on LinkedIn job pages, so they
// keep their original documentUrlPatterns scoping. Page Content Capture is
// deliberately available everywhere the extension can already act (any page,
// under the same per-click activeTab grant) — see page-content-capture.js.
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#0a66c2" });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PARENT_ID,
      title: "Job Assistant",
      contexts: ["page", "selection", "link", "image"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_COPY_TEXT_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Copy Job Data",
      contexts: ["page", "selection", "link", "image"],
      documentUrlPatterns: ["https://www.linkedin.com/jobs/*"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_COPY_JSON_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Copy as JSON",
      contexts: ["page", "selection", "link", "image"],
      documentUrlPatterns: ["https://www.linkedin.com/jobs/*"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_SEPARATOR_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      type: "separator",
      contexts: ["page", "selection", "link", "image"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_COPY_SECTION_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Copy This Section",
      contexts: ["page", "selection", "link", "image"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_SELECT_SECTION_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Select Section to Copy",
      contexts: ["page", "selection", "link", "image"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_COPY_ALL_TEXT_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Copy All Page Text",
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

/**
 * Injects page-content-capture.js (an on-demand module, not a registered
 * content script — see that file's header) into the tab under the activeTab
 * grant this context-menu click just provided, then calls one of its
 * exported capture functions in the page's own context and copies the
 * result via the same writeTextToPageClipboard helper the Job Extractor
 * menu items use. Fails gracefully with a page notification for every
 * failure mode (unsupported page, no readable content, clipboard denied)
 * instead of throwing.
 * @param {number} tabId
 * @param {"copySection" | "copyAllText"} action
 */
async function runPageCapture(tabId, action) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["page-content-capture.js"]
    });

    const [{ result: capture }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (which) => {
        if (!window.LJEPageCapture) {
          return { ok: false, message: "No readable content found." };
        }
        return which === "copySection"
          ? window.LJEPageCapture.captureSectionAtRightClick()
          : window.LJEPageCapture.captureAllPageText();
      },
      args: [action]
    });

    if (!capture?.ok || !capture.text) {
      notifyTab(tabId, capture?.message || "No readable content found.");
      return;
    }

    const [{ result: copied }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: writeTextToPageClipboard,
      args: [capture.text]
    });

    notifyTab(tabId, copied ? "Copied to clipboard." : "Could not copy to the clipboard on this page.");
  } catch (_error) {
    notifyTab(tabId, "No readable content found.");
  }
}

/**
 * Runs the interactive "Select Section to Copy" mode in the page (hover
 * highlight, click-to-select, ESC-to-cancel — see startSelectionMode in
 * page-content-capture.js). Deliberately does NOT await the interaction
 * itself: a user may take an arbitrarily long time (or never) to click or
 * press ESC, and an MV3 service worker cannot be relied on to stay alive
 * for that whole span even while awaiting a pending API call. Instead this
 * only awaits the (fast) injection call, and the page script reports its
 * own outcome later via chrome.runtime.sendMessage (handled below), already
 * having copied to the clipboard itself since it's already running in the
 * page's own context under the activeTab grant.
 * @param {number} tabId
 */
async function runSelectSectionMode(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["page-content-capture.js"]
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.LJEPageCapture) {
          window.LJEPageCapture.startSelectionMode();
        }
      }
    });
  } catch (_error) {
    notifyTab(tabId, "No readable content found.");
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "LJE_PAGE_CAPTURE_SELECTION_RESULT" || !sender.tab?.id) {
    return false;
  }
  const result = message.result;
  if (result?.cancelled) {
    return false;
  }
  if (!result?.ok) {
    notifyTab(sender.tab.id, result?.message || "No section could be identified.");
    return false;
  }
  notifyTab(sender.tab.id, "Copied selected section to clipboard.");
  return false;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) {
    return;
  }
  if (info.menuItemId === CONTEXT_MENU_COPY_TEXT_ID) {
    copyJobDataFromContextMenu(tab.id, "text");
  } else if (info.menuItemId === CONTEXT_MENU_COPY_JSON_ID) {
    copyJobDataFromContextMenu(tab.id, "json");
  } else if (info.menuItemId === CONTEXT_MENU_COPY_SECTION_ID) {
    runPageCapture(tab.id, "copySection");
  } else if (info.menuItemId === CONTEXT_MENU_COPY_ALL_TEXT_ID) {
    runPageCapture(tab.id, "copyAllText");
  } else if (info.menuItemId === CONTEXT_MENU_SELECT_SECTION_ID) {
    runSelectSectionMode(tab.id);
  }
});
