/**
 * Page Content Capture — independent, on-demand module (not a content
 * script; injected via chrome.scripting.executeScript the same way
 * application-assistant.js is). Lets the context menu capture readable text
 * from ANY page the user is currently on, whether or not it's LinkedIn or a
 * recognized job page.
 *
 * Self-contained IIFE, guarded against double-injection via
 * window.__ljePageCaptureActive (same pattern as application-assistant.js /
 * application-history-tracker.js). Never mutates the page DOM except for a
 * temporary selection-mode overlay, which is always fully removed (on
 * selection, on ESC, or if the mode is re-entered).
 *
 * Exposes window.LJEPageCapture so background.js's chrome.scripting.executeScript
 * `func` callers can invoke it after injection. Deliberately has zero
 * dependency on content.js, application-assistant.js, or field-mapping-storage.js
 * (Job Extractor / Application Assistant / Smart Mapping), and none of those
 * depend on it either.
 */
(() => {
  "use strict";

  if (window.__ljePageCaptureActive) {
    // Already injected on this page (e.g. a second context-menu action in
    // the same tab) — reuse the existing instance instead of double-binding
    // listeners or leaking a second overlay.
    return;
  }
  window.__ljePageCaptureActive = true;

  const HIGHLIGHT_ID = "__ljePageCaptureHighlight";
  const NOTICE_ID = "__ljeContextMenuNotice";

  // Tags whose subtree is never useful readable content.
  const NOISE_TAGS = new Set([
    "script", "style", "noscript", "template", "svg", "iframe", "canvas",
    "link", "meta", "head"
  ]);

  // Landmark/role signals treated as page chrome rather than main content.
  // Only used to de-prioritize during whole-page capture — never fully
  // deleted, since misclassifying real content as "navigation" would lose it.
  const CHROME_SELECTOR = [
    "nav", "header > nav", "[role='navigation']", "[role='banner']",
    "[role='contentinfo']", "footer", "[aria-hidden='true']"
  ].join(", ");

  const COOKIE_BANNER_HINT = /cookie|consent|gdpr/i;

  // Preferred semantic container tags/roles for "Copy This Section" and the
  // hover highlight in "Select Section to Copy", most specific first.
  const SEMANTIC_CONTAINER_SELECTOR = [
    "article", "main", "[role='main']", "section", "form",
    "[role='region']", "[role='article']"
  ].join(", ");

  /**
   * @param {Element} el
   * @returns {boolean}
   */
  function isVisible(el) {
    if (!el || !(el instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * @param {Element} el
   * @returns {boolean}
   */
  function looksLikeCookieBanner(el) {
    const id = el.id || "";
    const cls = typeof el.className === "string" ? el.className : "";
    return COOKIE_BANNER_HINT.test(id) || COOKIE_BANNER_HINT.test(cls);
  }

  /**
   * Shared text-cleaning walk: reads visible human-readable text from a
   * subtree, preserving paragraph/heading/list line breaks, skipping
   * script/style/hidden/extension-owned nodes, and collapsing runs of
   * whitespace/blank lines. Used by every capture feature so there is one
   * extraction implementation, not three.
   * @param {Element} root
   * @param {{ skipChrome?: boolean }} [options]
   * @returns {string}
   */
  function extractReadableText(root, options = {}) {
    if (!root || !(root instanceof Element)) {
      return "";
    }
    const skipChrome = Boolean(options.skipChrome);
    const blockTags = new Set([
      "p", "div", "section", "article", "header", "footer", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "dd", "dt",
      "blockquote", "pre", "form", "fieldset"
    ]);

    const lines = [];
    let currentLine = "";

    const flushLine = () => {
      const trimmed = currentLine.replace(/[ \t]+/g, " ").trim();
      if (trimmed) {
        lines.push(trimmed);
      }
      currentLine = "";
    };

    const walk = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          currentLine += String(child.textContent || "");
          return;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) {
          return;
        }

        const el = /** @type {Element} */ (child);
        const tag = el.tagName.toLowerCase();

        if (NOISE_TAGS.has(tag)) {
          return;
        }
        if (el.id === HIGHLIGHT_ID || el.id === NOTICE_ID || el.closest?.(`#${HIGHLIGHT_ID}, #${NOTICE_ID}`)) {
          return;
        }
        if (!isVisible(el)) {
          return;
        }
        if (skipChrome && (el.matches?.(CHROME_SELECTOR) || looksLikeCookieBanner(el))) {
          return;
        }

        if (tag === "br") {
          flushLine();
          return;
        }

        const isBlock = blockTags.has(tag);
        if (isBlock) {
          flushLine();
        }
        walk(el);
        if (isBlock) {
          flushLine();
        }
      });
    };

    walk(root);
    flushLine();

    // Collapse consecutive duplicate lines (common in SPA layouts that
    // render the same label in both a visible and an sr-only/aria node).
    const deduped = [];
    lines.forEach((line) => {
      if (deduped[deduped.length - 1] !== line) {
        deduped.push(line);
      }
    });

    return deduped.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Resolves a reasonable semantic container around a starting element:
   * walks up the ancestor chain preferring article/main/section/form/region
   * landmarks, and otherwise the nearest ancestor whose own text is
   * meaningfully larger than the starting element's (so a small container
   * around a single line doesn't win over its real content block). Falls
   * back to document.body only when nothing better exists anywhere in the
   * chain.
   * @param {Element} start
   * @returns {Element}
   */
  function resolveContainer(start) {
    if (!start || !(start instanceof Element)) {
      return document.body;
    }

    let node = start;
    while (node && node !== document.body) {
      if (node.matches?.(SEMANTIC_CONTAINER_SELECTOR) && isVisible(node)) {
        const text = extractReadableText(node);
        if (text.length >= 40) {
          return node;
        }
      }
      node = node.parentElement;
    }

    // No landmark matched with enough content — climb until the container's
    // text is substantially larger than the starting element's own text, so
    // we land on "the block that holds this" rather than jumping to <body>.
    const startLength = extractReadableText(start).length;
    node = start.parentElement;
    let depth = 0;
    while (node && node !== document.body && depth < 8) {
      const text = extractReadableText(node);
      if (text.length >= Math.max(80, startLength + 60)) {
        return node;
      }
      node = node.parentElement;
      depth += 1;
    }

    return document.body;
  }

  /**
   * @returns {{ ok: boolean, text?: string, message?: string }}
   */
  function captureAllPageText() {
    const body = document.body;
    if (!body) {
      return { ok: false, message: "No readable content found." };
    }

    const content = extractReadableText(body, { skipChrome: true });
    if (!content) {
      // Retry without chrome-skipping in case the whole page was
      // misclassified as navigation/footer on an unusual layout.
      const fallback = extractReadableText(body, { skipChrome: false });
      if (!fallback) {
        return { ok: false, message: "No readable content found." };
      }
      return { ok: true, text: formatCapture("PAGE CONTENT", fallback) };
    }

    return { ok: true, text: formatCapture("PAGE CONTENT", content) };
  }

  /**
   * Finds the element the user most recently right-clicked. Chrome's
   * contextMenus API deliberately does not expose the clicked DOM element or
   * click coordinates (unlike Firefox's targetElementId) — see
   * https://developer.chrome.com/docs/extensions/reference/api/contextMenus.
   * Chromium does not clear CSS :hover state between the right-click and the
   * context-menu-item click, so the deepest currently-":hover"ed element is
   * a reliable stand-in for "what was right-clicked", without requiring any
   * additional permission beyond the activeTab grant this injection already
   * runs under.
   * @returns {Element}
   */
  function getRightClickedElement() {
    const hovered = document.querySelectorAll(":hover");
    return hovered.length ? hovered[hovered.length - 1] : document.body;
  }

  /**
   * @param {Element} el
   * @returns {{ ok: boolean, text?: string, message?: string }}
   */
  function captureSection(el) {
    const container = resolveContainer(el);
    const text = extractReadableText(container);
    if (!text) {
      return { ok: false, message: "No readable content found." };
    }
    return { ok: true, text: formatCapture("SELECTED SECTION", text) };
  }

  /**
   * @param {string} label
   * @param {string} body
   * @returns {string}
   */
  function formatCapture(label, body) {
    const title = document.title || "Untitled page";
    const url = window.location.href;
    return `Page Title: ${title}\nURL: ${url}\n\n--- ${label} ---\n\n${body}`;
  }

  /**
   * Reports the outcome of an interactive selection session back to the
   * service worker via chrome.runtime.sendMessage rather than by resolving a
   * long-lived promise inside a pending chrome.scripting.executeScript call.
   * A service worker cannot be relied on to stay alive for the arbitrarily
   * long time a user may take to move the mouse and click (or never click) —
   * MV3 service workers can be torn down well before that — so the injected
   * page script owns the whole wait and only messages once, at the end. It
   * also writes to the clipboard itself (already running in the page's own
   * context under the activeTab grant), rather than asking the service
   * worker to inject yet another one-off script for that.
   * @param {{ ok: boolean, text?: string, message?: string, cancelled?: boolean }} result
   * @returns {Promise<void>}
   */
  async function reportSelectionResult(result) {
    if (result.ok && result.text) {
      try {
        await navigator.clipboard.writeText(result.text);
      } catch (_error) {
        result = { ok: false, message: "Could not copy to the clipboard on this page." };
      }
    }
    try {
      chrome.runtime.sendMessage({ type: "LJE_PAGE_CAPTURE_SELECTION_RESULT", result });
    } catch (_error) {
      // Extension context invalidated (e.g. reloaded) before the result
      // could be delivered; nothing left to report to.
    }
  }

  /**
   * Interactive "Select Section to Copy" mode: highlights the logical
   * container under the cursor, lets Up/Down Arrow widen/narrow the
   * candidate, copies on click, and fully tears itself down on ESC or after
   * a selection. Never left running or leaking listeners/overlay nodes.
   * Fires reportSelectionResult when the session ends instead of resolving
   * a returned promise — see that function's doc comment for why.
   * @returns {void}
   */
  function startSelectionMode() {
    if (window.__ljePageCaptureSelectionActive) {
      // A previous selection session didn't get torn down (shouldn't
      // happen, but never stack two overlays/listener sets).
      reportSelectionResult({ ok: false, message: "Selection mode is already active." });
      return;
    }
    window.__ljePageCaptureSelectionActive = true;

    const overlay = document.createElement("div");
    overlay.id = HIGHLIGHT_ID;
    overlay.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;" +
      "border:2px solid #0a66c2;background:rgba(10,102,194,0.12);" +
      "border-radius:4px;transition:all 60ms ease-out;display:none;";
    document.documentElement.appendChild(overlay);

    let candidate = null;
    // Manual override chain: null = follow the mouse; once the user presses
    // Up/Down, manualChain holds the hovered element's ancestor chain and
    // manualIndex walks it instead of re-resolving from scratch.
    let manualChain = null;
    let manualIndex = -1;

    const buildChain = (start) => {
      const chain = [];
      let node = start;
      while (node && node !== document.documentElement) {
        chain.push(node);
        node = node.parentElement;
      }
      if (!chain.length) {
        chain.push(document.body);
      }
      return chain;
    };

    const positionOverlay = (el) => {
      if (!el || !isVisible(el)) {
        overlay.style.display = "none";
        return;
      }
      const rect = el.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.top = `${rect.top}px`;
      overlay.style.left = `${rect.left}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    };

    const setCandidate = (el) => {
      candidate = el;
      positionOverlay(el);
    };

    const onMouseMove = (event) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || target.id === HIGHLIGHT_ID) {
        return;
      }
      manualChain = null;
      manualIndex = -1;
      setCandidate(resolveContainer(target));
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        cleanup();
        reportSelectionResult({ ok: false, cancelled: true, message: "Selection cancelled." });
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (!candidate) {
          return;
        }
        event.preventDefault();
        if (!manualChain) {
          manualChain = buildChain(candidate);
          manualIndex = manualChain.indexOf(candidate);
          if (manualIndex === -1) {
            manualIndex = 0;
          }
        }
        if (event.key === "ArrowUp") {
          manualIndex = Math.min(manualIndex + 1, manualChain.length - 1);
        } else {
          manualIndex = Math.max(manualIndex - 1, 0);
        }
        setCandidate(manualChain[manualIndex]);
      }
    };

    const onClick = (event) => {
      if (!candidate) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const result = captureSection(candidate);
      cleanup();
      reportSelectionResult(result);
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      window.__ljePageCaptureSelectionActive = false;
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  /**
   * "Copy This Section" entry point: resolves the container from the
   * right-clicked element (see getRightClickedElement) and captures it.
   * @returns {{ ok: boolean, text?: string, message?: string }}
   */
  function captureSectionAtRightClick() {
    return captureSection(getRightClickedElement());
  }

  window.LJEPageCapture = {
    extractReadableText,
    resolveContainer,
    captureAllPageText,
    captureSection,
    captureSectionAtRightClick,
    getRightClickedElement,
    startSelectionMode
  };
})();
