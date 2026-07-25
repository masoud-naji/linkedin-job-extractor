/**
 * On-demand Application Assistant.
 *
 * Injected into the active tab only when the user clicks "Fill Basic
 * Fields on This Page" in the popup (via chrome.scripting.executeScript,
 * under the activeTab grant). Never runs automatically, never submits
 * anything, and only touches fields it can confidently recognize.
 *
 * Depends on profile-storage.js (window.LJEProfileStore) being injected
 * first into the same tab.
 */
(() => {
  "use strict";

  if (window.__ljeAssistantActive) {
    return;
  }
  window.__ljeAssistantActive = true;

  const FILLABLE_SELECTOR =
    'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="search"], textarea';

  const MIN_SCORE = 3;

  const FIELD_RULES = [
    {
      key: "email",
      autocomplete: ["email"],
      inputTypes: ["email"],
      patterns: [/e-?mail/i]
    },
    {
      key: "phone",
      autocomplete: ["tel", "tel-national", "tel-local", "tel-country-code"],
      inputTypes: ["tel"],
      patterns: [/phone|mobile|cell|telephone/i, /contact\s*number/i]
    },
    {
      key: "firstName",
      autocomplete: ["given-name"],
      patterns: [/first[\s_-]?name/i, /\bfname\b/i],
      exactMatches: ["first name", "given name"]
    },
    {
      key: "lastName",
      autocomplete: ["family-name"],
      patterns: [/last[\s_-]?name/i, /\blname\b/i, /surname/i],
      exactMatches: ["last name", "family name"]
    },
    {
      key: "fullName",
      autocomplete: ["name"],
      patterns: [/full[\s_-]?name/i, /your[\s_-]?name/i, /applicant[\s_-]?name/i],
      exactMatches: ["name", "full name", "your name", "applicant name"]
    },
    {
      key: "linkedinUrl",
      inputTypes: ["url"],
      patterns: [/linkedin/i]
    },
    {
      key: "githubUrl",
      patterns: [/github/i]
    },
    {
      key: "portfolioUrl",
      patterns: [/portfolio/i, /personal\s*website/i, /\bwebsite\b/i]
    },
    {
      key: "currentTitle",
      autocomplete: ["organization-title"],
      patterns: [/current\s*(job\s*)?title/i, /job\s*title/i, /\btitle\b/i, /\bposition\b/i]
    },
    {
      key: "location",
      autocomplete: ["address-level2"],
      patterns: [/\blocation\b/i, /\bcity\b/i, /\bbased\b/i, /\blocated\b/i]
    }
  ];

  const registry = []; // { input, badge, key, value }
  let overlayContainer = null;
  let toolbarEl = null;
  let statusEl = null;
  let observer = null;
  let repositionScheduled = false;

  main();

  async function main() {
    const store = window.LJEProfileStore;
    if (!store) {
      window.__ljeAssistantActive = false;
      return;
    }

    let profile;
    try {
      profile = await store.getActiveProfile();
    } catch (_error) {
      window.__ljeAssistantActive = false;
      return;
    }

    if (!profile) {
      window.alert(
        "LinkedIn Job Extractor: no active profile is set. Open the extension popup, go to Profiles, create one, and set it active."
      );
      window.__ljeAssistantActive = false;
      return;
    }

    scanAndAnnotate(document, profile);
    createToolbar(profile);
    observeMutations(profile);
    window.addEventListener("scroll", scheduleReposition, true);
    window.addEventListener("resize", scheduleReposition);
  }

  /**
   * @param {ParentNode} root
   * @param {object} profile
   */
  function scanAndAnnotate(root, profile) {
    const candidates = root.querySelectorAll(FILLABLE_SELECTOR);
    candidates.forEach((input) => {
      if (input.dataset.ljeAssisted === "1") {
        return;
      }
      if (input.disabled || input.readOnly || !isVisible(input)) {
        return;
      }

      const key = detectFieldKey(input);
      if (!key) {
        return;
      }

      const value = getProfileValue(profile, key);
      if (!value) {
        return;
      }

      input.dataset.ljeAssisted = "1";
      attachBadge(input, key, value);
    });
    updateToolbarStatus();
  }

  /**
   * @param {HTMLElement} el
   * @returns {boolean}
   */
  function isVisible(el) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement} input
   * @returns {string | null}
   */
  function detectFieldKey(input) {
    const signals = getSignals(input);
    let bestKey = null;
    let bestScore = 0;

    FIELD_RULES.forEach((rule) => {
      let score = 0;
      if (rule.autocomplete && rule.autocomplete.includes(signals.autocomplete)) {
        score += 5;
      }
      if (rule.inputTypes && rule.inputTypes.includes(signals.type)) {
        score += 2;
      }
      if (rule.patterns.some((pattern) => pattern.test(signals.textBlob))) {
        score += 3;
      }
      if (rule.exactMatches && signals.exactCandidates.some((candidate) => rule.exactMatches.includes(candidate))) {
        score += 4;
      }
      if (score > bestScore) {
        bestScore = score;
        bestKey = rule.key;
      }
    });

    return bestScore >= MIN_SCORE ? bestKey : null;
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement} input
   */
  function getSignals(input) {
    const name = input.getAttribute("name") || "";
    const id = input.getAttribute("id") || "";
    const placeholder = input.getAttribute("placeholder") || "";
    const ariaLabel = input.getAttribute("aria-label") || "";
    const labelText = getAssociatedLabelText(input);

    return {
      autocomplete: (input.getAttribute("autocomplete") || "").trim().toLowerCase(),
      type: (input.getAttribute("type") || "text").trim().toLowerCase(),
      textBlob: [name, id, placeholder, ariaLabel, labelText].filter(Boolean).join(" ").toLowerCase(),
      // Checked in isolation (not the merged blob above) so a bare label like
      // "Name" can be matched exactly without "Company Name" or "File Name"
      // false-positiving on a loose substring match.
      exactCandidates: [name, id, ariaLabel, labelText].map(normalizeForExactMatch).filter(Boolean)
    };
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function normalizeForExactMatch(value) {
    return String(value || "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement} input
   * @returns {string}
   */
  function getAssociatedLabelText(input) {
    if (input.id) {
      try {
        const escaped =
          window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape(input.id) : input.id.replace(/([^\w-])/g, "\\$1");
        const label = document.querySelector(`label[for="${escaped}"]`);
        if (label) {
          return label.textContent || "";
        }
      } catch (_error) {
        // Malformed id for a CSS selector; ignore and fall through.
      }
    }

    const wrappingLabel = input.closest("label");
    if (wrappingLabel) {
      return wrappingLabel.textContent || "";
    }

    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const texts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .filter(Boolean);
      if (texts.length) {
        return texts.join(" ");
      }
    }

    return "";
  }

  /**
   * @param {object} profile
   * @param {string} key
   * @returns {string}
   */
  function getProfileValue(profile, key) {
    switch (key) {
      case "fullName":
        return profile.fullName || "";
      case "firstName":
        return splitName(profile.fullName).first;
      case "lastName":
        return splitName(profile.fullName).last;
      case "email":
        return profile.email || "";
      case "phone":
        return profile.phone || "";
      case "linkedinUrl":
        return profile.linkedinUrl || "";
      case "portfolioUrl":
        return profile.portfolioUrl || "";
      case "githubUrl":
        return profile.githubUrl || "";
      case "currentTitle":
        return profile.currentTitle || "";
      case "location":
        return profile.location || "";
      default:
        return "";
    }
  }

  /**
   * @param {string} fullName
   */
  function splitName(fullName) {
    const parts = String(fullName || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) {
      return { first: "", last: "" };
    }
    if (parts.length === 1) {
      return { first: parts[0], last: "" };
    }
    return { first: parts[0], last: parts.slice(1).join(" ") };
  }

  /**
   * @param {HTMLElement} element
   * @param {Record<string, string>} styles
   */
  function applyStyles(element, styles) {
    Object.keys(styles).forEach((key) => {
      element.style[key] = styles[key];
    });
  }

  function ensureOverlayContainer() {
    if (overlayContainer && document.body.contains(overlayContainer)) {
      return overlayContainer;
    }
    overlayContainer = document.createElement("div");
    overlayContainer.id = "lje-assistant-overlay";
    applyStyles(overlayContainer, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      overflow: "visible",
      zIndex: "2147483647"
    });
    document.body.appendChild(overlayContainer);
    return overlayContainer;
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement} input
   * @param {string} key
   * @param {string} value
   */
  function attachBadge(input, key, value) {
    const container = ensureOverlayContainer();

    const badge = document.createElement("button");
    badge.type = "button";
    badge.textContent = "⚡";
    badge.title = "Fill from active profile";
    applyStyles(badge, {
      position: "absolute",
      width: "20px",
      height: "20px",
      lineHeight: "18px",
      padding: "0",
      margin: "0",
      border: "1px solid #0a66c2",
      borderRadius: "50%",
      background: "#ffffff",
      color: "#0a66c2",
      fontSize: "12px",
      fontFamily: "Arial, sans-serif",
      cursor: "pointer",
      boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
      textAlign: "center"
    });
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setNativeValue(input, value);
    });

    container.appendChild(badge);

    const entry = { input, badge, key, value };
    registry.push(entry);
    positionBadge(entry);
  }

  /**
   * @param {{ input: HTMLElement, badge: HTMLElement }} entry
   */
  function positionBadge(entry) {
    if (!entry.input.isConnected) {
      entry.badge.style.display = "none";
      return;
    }
    const rect = entry.input.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      entry.badge.style.display = "none";
      return;
    }
    entry.badge.style.display = "block";
    const top = rect.top + window.scrollY + rect.height / 2 - 10;
    const left = rect.left + window.scrollX + rect.width - 26;
    entry.badge.style.top = `${Math.max(0, top)}px`;
    entry.badge.style.left = `${Math.max(0, left)}px`;
  }

  function repositionAllBadges() {
    registry.forEach(positionBadge);
  }

  function scheduleReposition() {
    if (repositionScheduled) {
      return;
    }
    repositionScheduled = true;
    window.requestAnimationFrame(() => {
      repositionScheduled = false;
      repositionAllBadges();
    });
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement} element
   * @param {string} value
   */
  function setNativeValue(element, value) {
    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillAllBasicFields() {
    let filledCount = 0;
    registry.forEach(({ input, value }) => {
      if (!input.isConnected) {
        return;
      }
      if (input.value && input.value.trim() !== "") {
        return;
      }
      setNativeValue(input, value);
      filledCount += 1;
    });
    if (statusEl) {
      statusEl.textContent = `Filled ${filledCount} empty field${filledCount === 1 ? "" : "s"}`;
    }
  }

  /**
   * @param {object} profile
   */
  function createToolbar(profile) {
    const bar = document.createElement("div");
    bar.id = "lje-assistant-toolbar";
    applyStyles(bar, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      background: "#19212a",
      color: "#ffffff",
      borderRadius: "10px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      padding: "10px 12px",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      fontFamily: "Arial, sans-serif",
      fontSize: "13px"
    });

    const label = document.createElement("span");
    label.textContent = `LJE Assistant • ${profile.name}`;
    applyStyles(label, { whiteSpace: "nowrap" });

    statusEl = document.createElement("span");
    applyStyles(statusEl, { color: "#9fb3c8", whiteSpace: "nowrap" });

    const fillBtn = document.createElement("button");
    fillBtn.type = "button";
    fillBtn.textContent = "Fill Basic Fields";
    applyStyles(fillBtn, {
      border: "1px solid #0a66c2",
      borderRadius: "6px",
      background: "#0a66c2",
      color: "#ffffff",
      padding: "6px 10px",
      cursor: "pointer",
      fontSize: "13px",
      fontFamily: "Arial, sans-serif"
    });
    fillBtn.addEventListener("click", fillAllBasicFields);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.title = "Dismiss";
    applyStyles(closeBtn, {
      border: "none",
      background: "transparent",
      color: "#ffffff",
      cursor: "pointer",
      fontSize: "16px",
      lineHeight: "1",
      padding: "2px 4px"
    });
    closeBtn.addEventListener("click", dismiss);

    bar.appendChild(label);
    bar.appendChild(statusEl);
    bar.appendChild(fillBtn);
    bar.appendChild(closeBtn);
    document.body.appendChild(bar);
    toolbarEl = bar;
  }

  function updateToolbarStatus() {
    if (!statusEl) {
      return;
    }

    if (registry.length === 0) {
      const inaccessibleHost = findInaccessibleIframeHost();
      if (inaccessibleHost) {
        statusEl.textContent = `0 fields here — the form looks like it's inside an iframe (${inaccessibleHost}) this extension can't access.`;
        return;
      }
    }

    statusEl.textContent = `${registry.length} field${registry.length === 1 ? "" : "s"} recognized`;
  }

  /**
   * Cross-origin iframe *contents* are blocked by the same-origin policy, but the
   * <iframe> element itself (and its src) is always visible from the parent
   * document. Used only to give an honest status message when we can't reach a
   * frame, never to attempt to bypass the restriction.
   * @returns {string | null}
   */
  function findInaccessibleIframeHost() {
    if (window !== window.top) {
      return null;
    }

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
          return frame.src || "an embedded frame";
        }
      }
    }
    return null;
  }

  /**
   * @param {object} profile
   */
  function observeMutations(profile) {
    let debounceTimer = null;
    observer = new MutationObserver(() => {
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(() => {
        scanAndAnnotate(document, profile);
        repositionAllBadges();
      }, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function dismiss() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    window.removeEventListener("scroll", scheduleReposition, true);
    window.removeEventListener("resize", scheduleReposition);

    registry.forEach((entry) => {
      delete entry.input.dataset.ljeAssisted;
    });
    registry.length = 0;

    if (overlayContainer) {
      overlayContainer.remove();
      overlayContainer = null;
    }
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
    statusEl = null;

    window.__ljeAssistantActive = false;
  }
})();
