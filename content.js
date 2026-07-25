(() => {
  "use strict";

  const NOT_FOUND = "Not found";
  // Detailed extraction diagnostics are printed to the page console while this
  // is true. Set to false (or use localStorage "ljeDebug") to silence them.
  const DEBUG_LOGGING = false;
  const EXTRACTION_DEBOUNCE_MS = 400;
  const DESCRIPTION_EXPAND_WAIT_MS = 500;
  const EXPANDABLE_TEXT_BOX_SELECTOR = '[data-testid="expandable-text-box"]';
  const JOB_URL_PATTERNS = [
    /^https:\/\/www\.linkedin\.com\/jobs\/view\//i,
    /^https:\/\/www\.linkedin\.com\/jobs\/search\//i
  ];
  // A single compensation amount, e.g. "$123,000", "$123K/yr", "$215.2K/yr".
  const SALARY_AMOUNT_SOURCE = "(?:\\$|€|£|₹)\\s?\\d[\\d,.]*\\s?(?:k|K)?(?:\\s?(?:USD|CAD|EUR|GBP|AUD))?(?:\\s?(?:/yr|/hr|/hour|/mo|per\\s+year|per\\s+annum|per\\s+hour|per\\s+month|a\\s+year|a\\s+month|hourly|annually))?";
  // A single amount or a full range ("$123K/yr - $215.2K/yr"), preserving the
  // unit on each side and supporting decimal K values.
  const SALARY_REGEX = new RegExp(SALARY_AMOUNT_SOURCE + "(?:\\s*[–—-]\\s*" + SALARY_AMOUNT_SOURCE + ")?");
  // Visible applicant / click-to-apply counts shown in the job header metadata.
  const APPLICANT_REGEX = /(?:over\s+\d[\d,]*|\d[\d,]*\+?)\s+(?:people\s+clicked\s+apply|applicants?)|be\s+among\s+the\s+first\s+\d+\s+applicants?/i;
  // US state/territory postal abbreviations, used to recognize a "City, ST"
  // location pattern anywhere in the page text (description, header, etc.)
  // independent of any container/class name or render timing.
  const US_STATE_ABBREVIATIONS = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "GU", "HI", "ID", "IL", "IN",
    "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "PR", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
    "VA", "WA", "WV", "WI", "WY"
  ];
  // Matches "<Capitalized city/place words>, <state abbreviation>", e.g.
  // "Boston, MA" or "New York, NY". Requires a real word boundary after the
  // abbreviation so it can't match inside a longer word (e.g. "MASS").
  const STATE_LOCATION_REGEX = new RegExp(
    `\\b([A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+){0,3}),\\s*(${US_STATE_ABBREVIATIONS.join("|")})\\b`
  );
  const KNOWN_SKILLS = [
    "JavaScript", "TypeScript", "React", "React Native", "Angular", "Vue", "Node.js", "Next.js",
    "Express.js", "Redux", "Zustand", "tRPC", "TanStack Query", "React Query", "React Reanimated",
    "Framer Motion", "Tailwind CSS", "Expo", "Turborepo", "GraphQL", "REST", "JSON Schema",
    "HTML", "CSS", "Sass", "Python", "Java", "C#", "C++", "SQL", "PostgreSQL", "MySQL", "MongoDB",
    "AWS", "Azure", "GCP", "Docker", "Kubernetes", "GitHub Actions", "CI/CD", "Datadog", "Amplitude",
    "FullStory", "Vitest", "Jest", "Playwright", "Cypress", "Testing", "Accessibility", "Git",
    "Agile", "Scrum", "Figma", "Django", "Flask"
  ];
  const ABOUT_HEADINGS = ["About the job", "About this job", "Job description"];
  // Section headings that mark the start of company boilerplate (marketing,
  // benefits, legal/EEO). Description extraction stops before the first of
  // these so only candidate-relevant content is kept.
  const DESCRIPTION_STOP_HEADINGS = [
    "about us",
    "about the company",
    "about our company",
    "who we are",
    "life at",
    "why join",
    "why work",
    "our commitment",
    "our culture",
    "our values",
    "company information",
    "benefits",
    "benefits and perks",
    "perks and benefits",
    "what we offer",
    "compensation",
    "pay range",
    "salary range",
    "base pay range",
    "diversity",
    "inclusion",
    "legal notices",
    "legal notice",
    "learn more"
  ];
  // Headings that are boilerplate ONLY when the following text describes the
  // company rather than the role (e.g. an "About the team" section can be
  // role-relevant). Handled conditionally in isBoilerplateHeading.
  const SOFT_STOP_HEADINGS = ["about the team", "about our team"];

  let latestJobData = null;
  let latestError = null;
  let lastObservedUrl = window.location.href;
  let debounceTimer = 0;
  let descriptionExpandAttemptedForUrl = "";
  let domObserver = null;

  // Per-extraction diagnostics accumulator. Field extractors record how each
  // value was resolved (strategy, selector, raw value) as they run, and
  // logExtractionDiagnostics prints it. It never affects extraction or output.
  let fieldDiag = {};

  /**
   * Clears the diagnostics accumulator before a fresh extraction pass.
   * @returns {void}
   */
  function resetFieldDiag() {
    fieldDiag = {};
  }

  /**
   * Records diagnostic details for a single extracted field.
   * @param {string} field
   * @param {Record<string, unknown>} info
   * @returns {void}
   */
  function recordFieldDiag(field, info) {
    fieldDiag[field] = info;
  }

  /**
   * Returns whether debug logging is enabled. Enabled while DEBUG_LOGGING is
   * true, or at runtime via localStorage.setItem("ljeDebug", "1") or
   * window.__LJE_DEBUG__ = true.
   * @returns {boolean}
   */
  function isDebugEnabled() {
    try {
      return DEBUG_LOGGING ||
        window.__LJE_DEBUG__ === true ||
        window.localStorage?.getItem("ljeDebug") === "1";
    } catch (_error) {
      return DEBUG_LOGGING;
    }
  }

  /**
   * Logs a namespaced message only when debug mode is enabled.
   * @param {...unknown} args
   * @returns {void}
   */
  function debugLog(...args) {
    if (isDebugEnabled()) {
      console.log("[LinkedIn Job Extractor]", ...args);
    }
  }

  /**
   * Normalizes whitespace and removes invisible separators from text content.
   * @param {string | null | undefined} value
   * @returns {string}
   */
  function cleanText(value) {
    return String(value || "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Collapses redundant spacing while preserving paragraph and list breaks.
   * @param {string | null | undefined} value
   * @returns {string}
   */
  function normalizeFormattedText(value) {
    return String(value || "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/(^|\n)•[ \t]*(?=\n|$)/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Reads an element's text while preserving paragraph and list structure.
   * Converts <br>, block elements, and list items into readable line breaks
   * and skips interactive controls such as the "see more" toggle button.
   * @param {Element | null | undefined} element
   * @returns {string}
   */
  function getFormattedText(element) {
    if (!element || !(element instanceof Element)) {
      return "";
    }

    const skipTags = new Set(["script", "style", "noscript", "svg", "button", "template"]);
    const blockTags = new Set(["p", "div", "ul", "ol", "section", "article", "header", "footer",
      "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "dd", "dt", "blockquote"]);
    const parts = [];

    /** @param {Node} node */
    const walk = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = String(child.textContent || "").replace(/[ \t\r\n]+/g, " ");
          if (text) {
            parts.push(text);
          }
          return;
        }

        if (child.nodeType !== Node.ELEMENT_NODE) {
          return;
        }

        const tag = child.tagName.toLowerCase();
        if (skipTags.has(tag) ||
          child.getAttribute("aria-hidden") === "true" ||
          child.getAttribute("role") === "button") {
          return;
        }

        if (tag === "br") {
          parts.push("\n");
          return;
        }

        if (tag === "li") {
          parts.push("\n• ");
          walk(child);
          parts.push("\n");
          return;
        }

        const isBlock = blockTags.has(tag);
        if (isBlock) {
          parts.push("\n");
        }
        walk(child);
        if (isBlock) {
          parts.push("\n");
        }
      });
    };

    walk(element);
    return normalizeFormattedText(parts.join(""));
  }

  /**
   * Safely reads text from the first selector that returns useful content.
   * @param {string[]} selectors
   * @param {ParentNode} [root]
   * @returns {string}
   */
  function getText(selectors, root = document) {
    for (const selector of selectors) {
      const element = safeQuerySelector(selector, root);
      const text = cleanText(element?.textContent);
      if (text) {
        return text;
      }
    }
    return "";
  }

  /**
   * @param {string} selector
   * @param {ParentNode} root
   * @returns {Element | null}
   */
  function safeQuerySelector(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch (_error) {
      return null;
    }
  }

  /**
   * @param {string} selector
   * @param {ParentNode} root
   * @returns {Element[]}
   */
  function safeQuerySelectorAll(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  /**
   * Finds a visible element whose normalized text matches any option.
   * @param {string[]} textOptions
   * @param {ParentNode} [root]
   * @returns {Element | null}
   */
  function findElementByText(textOptions, root = document) {
    const normalizedOptions = textOptions.map((text) => text.toLowerCase());
    const candidates = safeQuerySelectorAll("h1, h2, h3, h4, h5, button, span, div, dt, p", root);

    return candidates.find((element) => {
      if (!isVisible(element)) {
        return false;
      }
      const text = cleanText(element.textContent).toLowerCase();
      return text && normalizedOptions.some((option) => text === option || text.includes(option));
    }) || null;
  }

  /**
   * Extracts text associated with a nearby section heading or definition label.
   * @param {string[]} headingTexts
   * @param {ParentNode} [root]
   * @returns {string}
   */
  function getTextByHeading(headingTexts, root = document) {
    const heading = findElementByText(headingTexts, root);
    if (!heading) {
      return "";
    }

    const definitionValue = findDefinitionValue(heading);
    if (definitionValue) {
      return definitionValue;
    }

    const section = heading.closest("section, article, li, div") || heading.parentElement;
    if (!section) {
      return "";
    }

    const text = cleanText(section.textContent);
    const headingText = cleanText(heading.textContent);
    return cleanText(text.replace(headingText, ""));
  }

  /**
   * @param {Element} labelElement
   * @returns {string}
   */
  function findDefinitionValue(labelElement) {
    const directNext = labelElement.nextElementSibling;
    const directText = cleanText(directNext?.textContent);
    if (directText && directText.length < 300) {
      return directText;
    }

    const parent = labelElement.closest("li, div, section, dl");
    if (!parent) {
      return "";
    }

    const labelText = cleanText(labelElement.textContent);
    const parentText = cleanText(parent.textContent);
    const withoutLabel = cleanText(parentText.replace(labelText, ""));
    return withoutLabel.length < 300 ? withoutLabel : "";
  }

  /**
   * @param {Element | null | undefined} element
   * @returns {boolean}
   */
  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  /**
   * Normalizes heading text for comparison: collapses whitespace, trims, and
   * lowercases so matching ignores case and spacing differences.
   * @param {string | null | undefined} value
   * @returns {string}
   */
  function normalizeHeading(value) {
    return String(value || "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /**
   * Finds the container that owns one of the given section headings.
   *
   * Searches visible heading-like elements (h1-h4, div, span, strong), matches
   * by normalized text (case-insensitive, whitespace-collapsed), then resolves
   * the nearest ancestor that scopes the heading's body content.
   *
   * Reusable for any titled section, e.g. "About the job", "Qualifications",
   * "Responsibilities", "Benefits", "Preferred Qualifications", "About the Team".
   *
   * @param {string[]} headings
   * @returns {{ section: Element, heading: Element, headingText: string } | null}
   */
  function getSectionByHeading(headings) {
    const targets = (headings || []).map(normalizeHeading).filter(Boolean);
    if (!targets.length) {
      return null;
    }

    const candidates = safeQuerySelectorAll("h1, h2, h3, h4, div, span, strong");
    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const text = normalizeHeading(candidate.textContent);
      if (!text || text.length > 60) {
        continue;
      }

      const isHeadingTag = /^h[1-4]$/.test(candidate.tagName.toLowerCase());
      const matched = targets.some((target) => text === target || (isHeadingTag && text.startsWith(target)));
      if (!matched) {
        continue;
      }

      const section = resolveHeadingSection(candidate);
      if (section) {
        debugLog(`Found heading: ${cleanText(candidate.textContent)}`);
        return { section, heading: candidate, headingText: cleanText(candidate.textContent) };
      }
    }

    return null;
  }

  /**
   * Walks up from a heading to the nearest container that also holds the
   * section's body content (the description box or meaningful extra text),
   * without climbing all the way up to <main> or <body>.
   * @param {Element} heading
   * @returns {Element | null}
   */
  function resolveHeadingSection(heading) {
    const headingLength = normalizeHeading(heading.textContent).length;
    let current = heading.parentElement;
    let depth = 0;

    while (current && depth < 6) {
      const tag = current.tagName.toLowerCase();
      if (tag === "body" || tag === "main") {
        break;
      }

      const hasExpandable = Boolean(current.querySelector(EXPANDABLE_TEXT_BOX_SELECTOR));
      const bodyLength = normalizeHeading(current.textContent).length;
      if (hasExpandable || bodyLength > headingLength + 40) {
        return current;
      }

      current = current.parentElement;
      depth += 1;
    }

    return heading.closest("section, article, div") || heading.parentElement;
  }

  /**
   * Returns the descendant that holds the bulk of a section's text, used as a
   * fallback for description extraction when no expandable-text-box is present.
   * @param {Element} section
   * @returns {Element}
   */
  function getLargestTextContainer(section) {
    const children = safeQuerySelectorAll(":scope > *", section);
    let best = null;
    let bestLength = 0;

    children.forEach((child) => {
      const length = cleanText(child.textContent).length;
      if (length > bestLength) {
        best = child;
        bestLength = length;
      }
    });

    return best && bestLength >= 40 ? best : section;
  }

  /**
   * @param {string} url
   * @returns {string}
   */
  function extractJobId(url) {
    const value = window.parsers?.extractJobIdFromUrl?.(url) || "";
    const results = [value, "", "", ""];
    recordFieldDiag("jobId", {
      url: String(url || ""),
      regex1: value || "(none)",
      regex2: "(none)",
      regex3: "(none)"
    });

    if (value) {
      return value;
    }

    const dataIdElement = safeQuerySelector("[data-job-id], [data-occludable-job-id], [data-entity-urn*='jobPosting']");
    const possibleValue = dataIdElement?.getAttribute("data-job-id") ||
      dataIdElement?.getAttribute("data-occludable-job-id") ||
      dataIdElement?.getAttribute("data-entity-urn") ||
      "";
    const pageMatch = possibleValue.match(/(\d{6,})/);
    return pageMatch?.[1] || "";
  }

  /**
   * @param {string} text
   * @returns {"Remote" | "Hybrid" | "On-site" | "Unknown"}
   */
  function detectWorkplaceType(text) {
    const normalized = cleanText(text).toLowerCase();
    if (/\bremote\b/.test(normalized)) {
      return "Remote";
    }
    if (/\bhybrid\b/.test(normalized)) {
      return "Hybrid";
    }
    if (/\bon[- ]?site\b|\bin office\b/.test(normalized)) {
      return "On-site";
    }
    return "Unknown";
  }

  /**
   * @param {string} text
   * @returns {"Full-time" | "Part-time" | "Contract" | "Temporary" | "Internship" | "Unknown"}
   */
  function detectEmploymentType(text) {
    const normalized = cleanText(text).toLowerCase();
    if (/\bfull[- ]?time\b/.test(normalized)) {
      return "Full-time";
    }
    if (/\bpart[- ]?time\b/.test(normalized)) {
      return "Part-time";
    }
    if (/\bcontract\b|\bcontractor\b/.test(normalized)) {
      return "Contract";
    }
    if (/\btemporary\b|\btemp\b/.test(normalized)) {
      return "Temporary";
    }
    if (/\binternship\b|\bintern\b/.test(normalized)) {
      return "Internship";
    }
    return "Unknown";
  }

  /**
   * Reads the short header badges/pills near the top of the job card
   * (workplace type, employment type, etc.) using semantic HTML, data-testid,
   * and aria attributes rather than generated class names.
   * @returns {string}
   */
  function getHeaderBadgeText() {
    const title = safeQuerySelector("main h1, article h1, h1");
    const topCard = title?.closest("section, article") ||
      safeQuerySelector("main, article") ||
      document.body;
    if (!topCard) {
      return "";
    }

    const badges = new Set();
    safeQuerySelectorAll("li, span, button, [data-testid], [aria-label]", topCard).forEach((node) => {
      const aria = cleanText(node.getAttribute?.("aria-label"));
      if (aria && aria.length <= 60) {
        badges.add(aria);
      }
      if (node.childElementCount === 0) {
        const text = cleanText(node.textContent);
        if (text && text.length <= 40) {
          badges.add(text);
        }
      }
    });

    return Array.from(badges).join(" · ");
  }

  /**
   * @param {string} value
   * @returns {"Remote" | "Hybrid" | "On-site" | "Unknown"}
   */
  function normalizeWorkplaceWord(value) {
    const normalized = cleanText(value).toLowerCase();
    if (/hybrid/.test(normalized)) {
      return "Hybrid";
    }
    if (/remote/.test(normalized)) {
      return "Remote";
    }
    if (/on[- ]?site|onsite/.test(normalized)) {
      return "On-site";
    }
    return "Unknown";
  }

  /**
   * Reads LinkedIn's accessible preference label, e.g. "Matches your job
   * preferences, workplace type is Hybrid." — the most reliable workplace signal.
   * @param {string} text
   * @returns {"Remote" | "Hybrid" | "On-site" | "Unknown"}
   */
  function detectWorkplaceFromPreference(text) {
    const match = String(text || "").match(/workplace type is\s+(on[- ]?site|onsite|hybrid|remote)/i);
    return match ? normalizeWorkplaceWord(match[1]) : "Unknown";
  }

  /**
   * Finds a standalone workplace pill (exact "Remote"/"Hybrid"/"On-site") in the
   * top card so a stray "remote" elsewhere cannot override the visible badge.
   * @returns {"Remote" | "Hybrid" | "On-site" | "Unknown"}
   */
  function findWorkplacePill() {
    const title = safeQuerySelector("main h1, article h1, h1");
    const topCard = title?.closest("section, article") ||
      safeQuerySelector("main, article") ||
      document.body;
    if (!topCard) {
      return "Unknown";
    }
    const nodes = safeQuerySelectorAll("li, span, button, div, p", topCard);
    for (const node of nodes) {
      if (node.childElementCount > 0) {
        continue;
      }
      const text = cleanText(node.textContent);
      if (/^(?:remote|hybrid|on[- ]?site|onsite)$/i.test(text)) {
        return normalizeWorkplaceWord(text);
      }
    }
    return "Unknown";
  }

  /**
   * Determines workplace type from the visible badges first (accessible
   * preference label, then an exact pill, then dedicated selectors), and only
   * infers from the description text as a last resort.
   * @param {string} description
   * @returns {string}
   */
  function extractWorkplaceType(description) {
    const fromHeading = getTextByHeading(["Workplace type"]);
    const explicit = detectWorkplaceType(fromHeading);
    if (explicit !== "Unknown") {
      recordFieldDiag("workplaceType", { strategy: "Primary: workplace-type section", raw: fromHeading || explicit });
      return explicit;
    }

    const badgeText = getHeaderBadgeText();
    const fromPreference = detectWorkplaceFromPreference(badgeText);
    if (fromPreference !== "Unknown") {
      recordFieldDiag("workplaceType", { strategy: "Primary: preference label badge", raw: fromPreference });
      return fromPreference;
    }

    const fromPill = findWorkplacePill();
    if (fromPill !== "Unknown") {
      recordFieldDiag("workplaceType", { strategy: "Fallback: workplace pill", raw: fromPill });
      return fromPill;
    }

    const selectorText = getText([
      ".jobs-unified-top-card__workplace-type",
      ".job-details-jobs-unified-top-card__workplace-type",
      "[class*='workplace-type' i]",
      "[data-testid*='workplace' i]"
    ]);
    const fromSelector = detectWorkplaceType(selectorText);
    if (fromSelector !== "Unknown") {
      recordFieldDiag("workplaceType", { strategy: "Fallback: workplace-type selector", raw: selectorText || fromSelector });
      return fromSelector;
    }

    const fromBadges = detectWorkplaceType(badgeText);
    if (fromBadges !== "Unknown") {
      recordFieldDiag("workplaceType", { strategy: "Fallback: header badges", raw: fromBadges });
      return fromBadges;
    }

    const fromDescription = detectWorkplaceType(description);
    recordFieldDiag("workplaceType", { strategy: fromDescription !== "Unknown" ? "Legacy: description inference" : "None matched", raw: fromDescription });
    return fromDescription;
  }

  /**
   * Determines employment type from explicit sections, inferring from the
   * header badges (and then the description) when it is missing elsewhere.
   * @param {string} description
   * @returns {string}
   */
  function extractEmploymentType(description) {
    const fromHeading = getTextByHeading(["Employment type", "Job type"]);
    const explicit = detectEmploymentType(fromHeading);
    if (explicit !== "Unknown") {
      recordFieldDiag("employmentType", { strategy: "Primary: employment-type section", raw: fromHeading || explicit });
      return explicit;
    }

    const badgeText = getHeaderBadgeText();
    const fromBadges = detectEmploymentType(badgeText);
    if (fromBadges !== "Unknown") {
      recordFieldDiag("employmentType", { strategy: "Fallback: header badges", raw: fromBadges });
      return fromBadges;
    }

    const fromDescription = detectEmploymentType(description);
    recordFieldDiag("employmentType", { strategy: fromDescription !== "Unknown" ? "Legacy: description inference" : "None matched", raw: fromDescription });
    return fromDescription;
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isSupportedLinkedInJobUrl(url) {
    return JOB_URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  /**
   * @returns {string}
   */
  function extractTitle() {
    const semanticTitle = getText([
      "main h1",
      "article h1",
      "section h1",
      "h1[aria-label]",
      "h1"
    ]);
    if (semanticTitle && !/linkedin/i.test(semanticTitle)) {
      return removeTrailingJobWords(semanticTitle);
    }

    const fallbackTitle = getText([
      "[data-testid*='job-title']",
      ".jobs-unified-top-card__job-title",
      ".job-details-jobs-unified-top-card__job-title"
    ]);
    if (fallbackTitle) {
      return removeTrailingJobWords(fallbackTitle);
    }

    const titleParts = cleanText(document.title).split(" | ")[0]?.split(" at ");
    return cleanText(titleParts?.[0] || "");
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function removeTrailingJobWords(value) {
    return cleanText(value.replace(/\s+job\s*$/i, ""));
  }

  /**
   * @returns {{ name: string, url: string }}
   */
  function extractCompany() {
    // Primary: the semantic company link in the top card (auth + guest views).
    const companyLinkSelector = "main a[href*='/company/'], article a[href*='/company/'], a[data-testid*='company'][href], a[href*='linkedin.com/company/'], a.topcard__org-name-link[href]";
    const companyLink = safeQuerySelector(companyLinkSelector);
    const nameFromLink = cleanText(companyLink?.textContent);
    const urlFromLink = normalizeLinkedInUrl(companyLink?.getAttribute("href") || "");

    if (nameFromLink) {
      recordFieldDiag("companyName", { strategy: "Primary: company link", selector: companyLinkSelector, found: true, raw: nameFromLink });
      recordFieldDiag("companyUrl", { strategy: "Primary: company link href", selector: companyLinkSelector, found: Boolean(urlFromLink), raw: urlFromLink });
      return { name: nameFromLink, url: urlFromLink };
    }

    // Fallback: authenticated and guest top-card company-name elements.
    const nameSelectors = [
      "[data-testid*='company-name']",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
      ".topcard__flavor a",
      ".topcard__flavor"
    ];
    const name = getText(nameSelectors);
    if (name) {
      recordFieldDiag("companyName", { strategy: "Fallback: top-card selectors", selector: nameSelectors.join(", "), found: true, raw: name });
      recordFieldDiag("companyUrl", { strategy: urlFromLink ? "Primary: company link href" : "None matched", selector: companyLinkSelector, found: Boolean(urlFromLink), raw: urlFromLink });
      return { name, url: urlFromLink };
    }

    // Fallback: any company anchor on the page (new layouts / relative hrefs
    // that fall outside <main>/<article>). Skips empty logo-only links.
    const anyCompanyLink = safeQuerySelectorAll("a[href*='/company/']")
      .find((link) => cleanText(link.textContent));
    if (anyCompanyLink) {
      const anyName = cleanText(anyCompanyLink.textContent);
      const anyUrl = urlFromLink || normalizeLinkedInUrl(anyCompanyLink.getAttribute("href") || "");
      recordFieldDiag("companyName", { strategy: "Fallback: page-wide company anchor", found: true, raw: anyName });
      recordFieldDiag("companyUrl", { strategy: anyUrl ? "Fallback: page-wide company anchor" : "None matched", found: Boolean(anyUrl), raw: anyUrl });
      return { name: anyName, url: anyUrl };
    }

    // Legacy: parse the "<title> at <Company> | LinkedIn" document title.
    const documentTitle = cleanText(document.title);
    const atMatch = documentTitle.match(/\bat\s+(.+?)(?:\s+\||$)/i);
    const legacyName = cleanText(atMatch?.[1] || "");
    recordFieldDiag("companyName", { strategy: "Legacy: document.title 'at' match", selector: "document.title", found: Boolean(legacyName), raw: legacyName });
    recordFieldDiag("companyUrl", { strategy: urlFromLink ? "Primary: company link href" : "None matched", selector: companyLinkSelector, found: Boolean(urlFromLink), raw: urlFromLink });
    return { name: legacyName, url: urlFromLink };
  }

  /**
   * Reads the LinkedIn job-header metadata line (location · date · applicants)
   * from the top card, preferring a row that actually contains separators or
   * recognizable metadata tokens.
   * @returns {string}
   */
  function getHeaderMetaText() {
    const selectors = [
      ".job-details-jobs-unified-top-card__primary-description-container",
      ".job-details-jobs-unified-top-card__tertiary-description-container",
      ".jobs-unified-top-card__primary-description",
      ".jobs-unified-top-card__subtitle-primary-grouping",
      ".topcard__flavor-row",
      ".top-card-layout__second-subline"
    ];
    for (const selector of selectors) {
      const text = getText([selector]);
      if (text && (/[·•|]/.test(text) || /clicked apply|applicant|ago|reposted/i.test(text))) {
        return text;
      }
    }
    return getHeaderMetaTextByScan();
  }

  /**
   * Class-name-independent fallback for LinkedIn layouts that render the
   * header metadata line (location · date · applicants) with fully hashed,
   * frequently-rotating CSS classes instead of the semantic class names the
   * selectors above target. Scans short paragraph-like elements near the top
   * of the page for one whose own text is "· "-separated and contains a
   * segment already recognizable as a date-ago or applicant-count phrase, and
   * returns the first such match in document order (the top-card metadata
   * reliably appears before any "similar jobs" rail, which uses the same
   * phrasing for other listings further down the page).
   * @returns {string}
   */
  function getHeaderMetaTextByScan() {
    const scope = safeQuerySelector("main") || safeQuerySelector("article") || document.body;
    if (!scope) {
      return "";
    }
    const candidates = scope.querySelectorAll("p");
    for (const el of candidates) {
      const text = cleanText(el.textContent || "");
      if (!text || text.length > 200 || !/[·•|]/.test(text)) {
        continue;
      }
      const segments = text.split(/[·•|]/).map(cleanText).filter(Boolean);
      if (segments.length < 2) {
        continue;
      }
      const hasDateOrApplicant = segments.some((segment) => isDateMetaSegment(segment) || APPLICANT_REGEX.test(segment));
      if (hasDateOrApplicant) {
        return text;
      }
    }
    return "";
  }

  /**
   * Splits the job-header metadata line into cleaned, non-empty segments.
   * @returns {string[]}
   */
  function getHeaderMetaSegments() {
    return getHeaderMetaText()
      .split(/[·•|]/)
      .map(cleanText)
      .filter(Boolean);
  }

  /**
   * @param {string} segment
   * @returns {boolean}
   */
  function isDateMetaSegment(segment) {
    return /\b(?:reposted|posted)\b/i.test(segment) ||
      /\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/i.test(segment);
  }

  /**
   * @param {string} segment
   * @returns {boolean}
   */
  function isWorkplaceOnlySegment(segment) {
    return /^(?:remote|hybrid|on[- ]?site|onsite)$/i.test(cleanText(segment));
  }

  /**
   * @param {string} [companyName]
   * @returns {string}
   */
  function extractLocation(companyName) {
    // Primary: the first job-header metadata segment that is a real location
    // (not the company name, a date, an applicant count, or a workplace pill).
    const normalizedCompany = normalizeHeading(companyName || "");
    const locationSegment = getHeaderMetaSegments().find((segment) => {
      if (isDateMetaSegment(segment) || APPLICANT_REGEX.test(segment) || isWorkplaceOnlySegment(segment)) {
        return false;
      }
      return normalizeHeading(segment) !== normalizedCompany;
    });
    if (locationSegment) {
      recordFieldDiag("location", { strategy: "Primary: header metadata segment", raw: locationSegment });
      return cleanText(locationSegment);
    }

    // Fallback: semantic location markers in the top card.
    const semanticSelectors = [
      "main [aria-label*='Location' i]",
      "main [data-testid*='location' i]",
      "article [aria-label*='Location' i]",
      "article [data-testid*='location' i]"
    ];
    const semanticText = getText(semanticSelectors);
    if (semanticText) {
      recordFieldDiag("location", { strategy: "Fallback: semantic location selectors", raw: semanticText });
      return semanticText;
    }

    // Fallback: the primary-description bullet strip (authenticated + guest).
    const fallbackSelectors = [
      ".jobs-unified-top-card__primary-description-container",
      ".job-details-jobs-unified-top-card__primary-description-container",
      ".jobs-unified-top-card__bullet",
      ".topcard__flavor--bullet",
      ".top-card-layout__second-subline"
    ];
    const fallback = getText(fallbackSelectors);
    const parts = fallback.split("·").map(cleanText).filter(Boolean);
    const likelyLocation = parts.find((part) => /,|remote|hybrid|on-site|united states|canada|india|kingdom|germany|france|city/i.test(part));
    if (likelyLocation) {
      recordFieldDiag("location", { strategy: "Fallback: top-card description bullets", raw: likelyLocation });
      return likelyLocation;
    }

    // Legacy: heading-based lookup.
    const byHeading = getTextByHeading(["Location", "Locations"]);
    if (byHeading) {
      recordFieldDiag("location", { strategy: "Legacy: heading-based", raw: byHeading });
      return byHeading;
    }

    const pageText = cleanText(document.body?.textContent || "");

    // Fallback: a "City, ST" pattern (US state/territory abbreviation)
    // anywhere in the page text - notably matches phrasing in the job
    // description itself (e.g. "based in the WHOOP office located in
    // Boston, MA"), independent of any container selector, class name, or
    // header-render timing. More specific than the remote-eligibility
    // last resort below, so it's tried first.
    const stateMatch = pageText.match(STATE_LOCATION_REGEX);
    if (stateMatch) {
      const cityState = `${cleanText(stateMatch[1])}, ${stateMatch[2]}`;
      recordFieldDiag("location", { strategy: "Fallback: city/state pattern in page text", raw: cityState });
      return cityState;
    }

    // Last resort: LinkedIn's remote-eligibility label names the country but
    // does not provide a city or state.
    if (/\bUS\s*[-\u2013\u2014]\s*Remote Eligible\b/i.test(pageText)) {
      recordFieldDiag("location", { strategy: "Fallback: US remote eligibility label", raw: "US - Remote Eligible" });
      return "United States";
    }

    recordFieldDiag("location", { strategy: "None matched", raw: "" });
    return "";
  }

  /**
   * Extracts the job description using a layered strategy so a single brittle
   * step can never blank the field:
   *   Primary  - the expandable-text-box (About section first, else page-wide)
   *   Fallback - well-known description containers anywhere on the page
   *   Legacy   - heading-based extraction across the page
   * Formatting (paragraphs/lists) is preserved via getFormattedText.
   * @param {Element | null} section
   * @returns {string}
   */
  function getDescriptionRootFromShowMore() {
    const preferredSelectors = [
      ".show-more-less-html__markup",
      ".show-more-less-html",
      "[class*='show-more-less-html']",
      "section.show-more-less-html"
    ];

    for (const selector of preferredSelectors) {
      const candidate = safeQuerySelector(selector);
      if (!candidate) {
        continue;
      }
      const text = removeDescriptionChrome(getFormattedText(candidate));
      if (text.length >= 80) {
        return candidate;
      }
    }

    const button = safeQuerySelectorAll("button, [role='button']").find((candidate) => {
      const text = cleanText(candidate.textContent);
      return /\b(show more|show less|see more|see less)\b/i.test(text);
    });
    if (!button) {
      return null;
    }

    const root = button.closest("section, article, div, main");
    if (!root) {
      return null;
    }

    const text = removeDescriptionChrome(getFormattedText(root));
    if (text.length < 80) {
      return null;
    }

    return root;
  }

  function extractDescription(section) {
    const aboutSectionFound = Boolean(section);

    // Primary: the expandable-text-box, scoped to the About section when it was
    // found, otherwise searched across the whole page.
    const expandable = (section && (section.querySelector(EXPANDABLE_TEXT_BOX_SELECTOR) ||
        section.querySelector('[data-testid*="expandable-text" i]'))) ||
      safeQuerySelector(EXPANDABLE_TEXT_BOX_SELECTOR) ||
      safeQuerySelector('[data-testid*="expandable-text" i]');
    const expandableFound = Boolean(expandable);
    if (expandable) {
      const candidates = [expandable];
      const nested = expandable.querySelectorAll("div, span, p, ul, li, section, article");
      nested.forEach((node) => candidates.push(node));
      const primary = removeDescriptionChrome(
        candidates
          .map((candidate) => getFormattedText(candidate))
          .filter((text) => text.length >= 20)
          .join("\n\n")
      );
      if (primary.length >= 40) {
        return finalizeDescription(primary, { aboutSectionFound, expandableFound: true, strategy: "Primary: expandable-text-box" });
      }
    }

    const showMoreRoot = getDescriptionRootFromShowMore();
    if (showMoreRoot) {
      const fromShowMore = removeDescriptionChrome(getFormattedText(showMoreRoot));
      if (fromShowMore.length >= 80) {
        return finalizeDescription(fromShowMore, { aboutSectionFound, expandableFound, strategy: "Fallback: show-more container" });
      }
    }

    // Fallback: well-known description containers anywhere on the page
    // (authenticated job view + classic + guest/public view).
    const containerSelectors = [
      ".show-more-less-html__markup",
      ".show-more-less-html",
      "[class*='show-more-less-html']",
      "#job-details",
      ".jobs-description__content",
      ".jobs-description-content__text",
      ".jobs-box__html-content",
      ".jobs-description",
      "[data-testid*='job-description' i]",
      "main section[aria-label*='job description' i]",
      "main section[aria-label*='about' i]",
      "article section[aria-label*='job description' i]",
      ".description__text"
    ];
    for (const selector of containerSelectors) {
      const element = safeQuerySelector(selector);
      const text = removeDescriptionChrome(getFormattedText(element));
      if (text.length >= 40) {
        return finalizeDescription(text, { aboutSectionFound, expandableFound, strategy: `Fallback: ${selector}` });
      }
    }

    // Fallback within the section: its largest text container.
    if (section) {
      const sectionText = removeDescriptionChrome(getFormattedText(getLargestTextContainer(section)));
      if (sectionText.length >= 40) {
        return finalizeDescription(sectionText, { aboutSectionFound, expandableFound, strategy: "Fallback: largest container in section" });
      }
    }

    // Legacy: heading-based extraction across the page.
    const byHeading = removeDescriptionChrome(getTextByHeading(ABOUT_HEADINGS));
    return finalizeDescription(byHeading, { aboutSectionFound, expandableFound, strategy: "Legacy: heading-based" });
  }

  /**
   * Records diagnostics and returns the description unchanged. The full About
   * the Job content is intentionally preserved (no boilerplate trimming).
   * @param {string} text
   * @param {{ aboutSectionFound: boolean, expandableFound: boolean, strategy: string }} meta
   * @returns {string}
   */
  function finalizeDescription(text, meta) {
    recordFieldDiag("description", {
      aboutSectionFound: meta.aboutSectionFound,
      expandableFound: meta.expandableFound,
      length: text.length,
      rawLength: text.length,
      boilerplateTrimmed: false,
      strategy: meta.strategy
    });
    return text;
  }

  /**
   * Removes company boilerplate (marketing, benefits, legal/EEO) that follows
   * the candidate-relevant description. Scans for the first boilerplate section
   * heading and keeps everything before it. Formatting and bullets are
   * preserved, and the intro is protected by a minimum-content guard so a stray
   * early match cannot truncate real responsibilities or qualifications.
   * @param {string} description
   * @returns {string}
   */
  function trimDescriptionAfterBoilerplate(description) {
    const text = String(description || "");
    if (!text) {
      return text;
    }

    const lines = text.split("\n");
    let consumed = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const following = lines.slice(i + 1, i + 8).join("\n");
      if (consumed >= 120 && isBoilerplateHeading(lines[i], following)) {
        const kept = normalizeFormattedText(lines.slice(0, i).join("\n"));
        return kept || text;
      }
      consumed += lines[i].trim().length;
    }

    return text;
  }

  /**
   * Decides whether a single line marks the start of company boilerplate.
   * Strong legal phrases (equal opportunity / know your rights) match even
   * inside a sentence; section headings match only on short, heading-like
   * lines so inline mentions (e.g. "...list of Amex benefits...") are ignored.
   * "About the team" is soft: only boilerplate when the following text
   * describes the company rather than the role.
   * @param {string} line
   * @param {string} [followingText]
   * @returns {boolean}
   */
  function isBoilerplateHeading(line, followingText) {
    const normalized = normalizeHeading(line).replace(/[\s:;.,\-\u2013\u2014\u2022]+$/g, "");
    if (!normalized) {
      return false;
    }

    // Strong legal / EEO phrases are always boilerplate, even mid-sentence.
    if (/\bequal (?:opportunity|employment)\b|\bknow your rights\b|\be-?verify\b|\breasonable accommodation\b/.test(normalized)) {
      return true;
    }

    const wordCount = normalized.split(" ").filter(Boolean).length;
    if (normalized.length > 48 || wordCount > 6) {
      return false;
    }

    // "About the team" is only boilerplate when what follows describes the
    // company rather than the role.
    if (isSoftStopHeading(normalized)) {
      return followingTextDescribesCompany(followingText);
    }

    return DESCRIPTION_STOP_HEADINGS.some((marker) => matchesHeadingMarker(normalized, marker));
  }

  /**
   * @param {string} normalized
   * @returns {boolean}
   */
  function isSoftStopHeading(normalized) {
    return SOFT_STOP_HEADINGS.some((marker) => matchesHeadingMarker(normalized, marker));
  }

  /**
   * Matches a normalized heading against a marker with a word boundary so
   * "about usage" does not match "about us".
   * @param {string} normalized
   * @param {string} marker
   * @returns {boolean}
   */
  function matchesHeadingMarker(normalized, marker) {
    if (normalized === marker) {
      return true;
    }
    if (!normalized.startsWith(marker)) {
      return false;
    }
    const nextChar = normalized.charAt(marker.length);
    return nextChar === "" || /[^a-z0-9]/.test(nextChar);
  }

  /**
   * Heuristic: does the text following an ambiguous heading (e.g. "About the
   * team") describe the company (boilerplate) rather than the role? When it is
   * role-relevant or ambiguous, the section is kept.
   * @param {string} followingText
   * @returns {boolean}
   */
  function followingTextDescribesCompany(followingText) {
    const text = String(followingText || "").toLowerCase();
    if (!text.trim()) {
      return false;
    }
    const roleSignals = /\byou'?ll\b|\byou will\b|\byour (?:role|responsibilities|team|day)\b|\bin this role\b|\bwe(?:'re| are) looking for\b|\bthe ideal candidate\b|\bresponsib|\bday[- ]to[- ]day\b/;
    if (roleSignals.test(text)) {
      return false;
    }
    const companySignals = /\bwe(?:'re| are) a\b|\bour mission\b|\bour company\b|\bfounded\b|\bheadquarter|\bemployees\b|\bour customers\b|\bworld[- ]?class\b|\bleading (?:provider|company)\b|\bour team is\b|\bwe build\b|\bwe help\b|\bmillions of\b|\bbillion\b|\bour platform\b/;
    return companySignals.test(text);
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  function removeDescriptionChrome(text) {
    let stripped = String(text || "").replace(/^\s+/, "");
    // Strip leading wrapper headings LinkedIn prepends so the description begins
    // directly with the role content: "About the job", "Job description", or a
    // standalone "Description" line.
    const wrapperHeading = /^[ \t]*(?:about (?:the|this) job|job description|description)[ \t]*(?:\r?\n|$)/i;
    while (wrapperHeading.test(stripped)) {
      stripped = stripped.replace(wrapperHeading, "").replace(/^\s+/, "");
    }
    // Handle a wrapper heading that runs inline with the first sentence.
    stripped = stripped
      .replace(/^[ \t]*About (?:the|this) job\s*/i, "")
      .replace(/^[ \t]*Job description\s*/i, "");
    // Remove trailing "show more / see less" control text.
    stripped = stripped.replace(/\n?[ \t]*(?:…|\.\.\.)?[ \t]*\b(?:show|see)\s+(?:more|less|full description)\b[ \t]*$/i, "");
    return normalizeFormattedText(stripped);
  }

  /**
   * Extracts salary/compensation, also parsing the canonical description text.
   * @param {string} pageText
   * @param {string} description
   * @returns {string}
   */
  function extractSalary(pageText, description) {
    // Primary: the salary pill shown directly in the job header.
    const pillText = getText([
      ".jobs-unified-top-card__salary-info",
      ".job-details-jobs-unified-top-card__salary-info",
      "[data-testid*='salary' i]",
      "[class*='salary' i]",
      ".compensation__salary"
    ]);
    const fromPill = firstSalaryMatch(pillText);
    if (isValidSalary(fromPill, pillText)) {
      recordFieldDiag("salary", { sourceText: pillText, normalized: fromPill, strategy: "Primary: header salary pill" });
      return fromPill;
    }

    // Fallback: an explicit compensation / pay-range section.
    const byHeading = getTextByHeading(["Base pay range", "Salary", "Compensation", "Pay range"]);
    if (looksLikeCompensation(byHeading)) {
      const headingValue = firstSalaryMatch(byHeading);
      if (isValidSalary(headingValue, byHeading)) {
        recordFieldDiag("salary", { sourceText: byHeading, normalized: headingValue, strategy: "Fallback: compensation section" });
        return headingValue;
      }
    }

    // Fallback: the first salary-looking match inside the description text.
    const fromDescription = firstSalaryMatch(description);
    if (isValidSalary(fromDescription, description)) {
      recordFieldDiag("salary", { sourceText: "description", normalized: fromDescription, strategy: "Fallback: description text" });
      return fromDescription;
    }

    // Legacy: scan the whole page text.
    const fromPage = firstSalaryMatch(pageText);
    if (isValidSalary(fromPage, pageText)) {
      recordFieldDiag("salary", { sourceText: "page text", normalized: fromPage, strategy: "Legacy: page-text scan" });
      return fromPage;
    }

    recordFieldDiag("salary", { sourceText: byHeading || "", normalized: "", strategy: "None matched" });
    return "";
  }

  /**
   * Rejects meaningless salary values such as "$0" unless the source text
   * explicitly contains that amount.
   * @param {string} value
   * @param {string} source
   * @returns {boolean}
   */
  function isValidSalary(value, source) {
    const cleaned = cleanText(value);
    if (!cleaned) {
      return false;
    }
    if (!isRealSalary(cleaned)) {
      return false;
    }
    const digits = cleaned.replace(/[^\d]/g, "");
    if (digits && Number(digits) === 0 && !/\$\s?0\b/.test(String(source || ""))) {
      return false;
    }
    return true;
  }

  /**
   * Accepts only real compensation formats and rejects stray small amounts such
   * as "$20" or "$5". A value qualifies when it has a K suffix (e.g. $120K), an
   * explicit period unit (e.g. /yr, per year, /hour), or a numeric magnitude of
   * at least 1000 (e.g. $85,000). Ranges like $120K-$150K qualify via the K
   * suffix or the magnitude of either endpoint.
   * @param {string} value
   * @returns {boolean}
   */
  function isRealSalary(value) {
    return window.parsers?.isRealSalary?.(value) ?? false;
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  function firstSalaryMatch(text) {
    const source = String(text || "");
    const regex = new RegExp(SALARY_REGEX.source, "gi");
    let match;
    while ((match = regex.exec(source)) !== null) {
      const candidate = cleanText(match[0]);
      if (candidate && isRealSalary(candidate)) {
        return candidate;
      }
      if (match.index === regex.lastIndex) {
        regex.lastIndex += 1;
      }
    }
    return "";
  }

  /**
   * @param {string} value
   * @returns {boolean}
   */
  function looksLikeCompensation(value) {
    return /(?:\$|€|£|₹|salary|compensation|pay|range|hour|year|annual)/i.test(value || "");
  }

  /**
   * @param {string} pageText
   * @returns {string}
   */
  function extractDatePosted(pageText) {
    const selectors = [
      "main time",
      "article time",
      "[datetime]",
      "[data-testid*='posted' i]"
    ];
    const text = getText(selectors);
    if (text) {
      return text;
    }
    return cleanText(pageText.match(/(?:\d+\s+(?:minute|hour|day|week|month)s?\s+ago|reposted\s+\d+\s+\w+\s+ago|posted\s+\d+\s+\w+\s+ago)/i)?.[0] || "");
  }

  /**
   * @param {string} pageText
   * @returns {string}
   */
  function extractApplicants(pageText) {
    // Primary: the applicant / click-to-apply segment in the header metadata.
    const metaSegment = getHeaderMetaSegments().find((segment) => APPLICANT_REGEX.test(segment));
    if (metaSegment) {
      recordFieldDiag("applicantCount", { strategy: "Primary: header metadata segment", raw: metaSegment });
      return cleanText(metaSegment);
    }

    // Fallback: dedicated applicant-count selectors.
    const selectors = [
      "[aria-label*='applicant' i]",
      "[data-testid*='applicant' i]",
      ".jobs-unified-top-card__applicant-count",
      ".jobs-unified-top-card__subtitle-secondary-grouping span"
    ];
    const selectorText = getText(selectors);
    const fromSelector = cleanText(selectorText.match(APPLICANT_REGEX)?.[0] || "");
    if (fromSelector) {
      recordFieldDiag("applicantCount", { strategy: "Fallback: header applicant selectors", raw: fromSelector });
      return fromSelector;
    }

    // Legacy: scan the whole page text.
    const fromText = cleanText(pageText.match(APPLICANT_REGEX)?.[0] || "");
    recordFieldDiag("applicantCount", { strategy: fromText ? "Legacy: page-text regex" : "None matched", raw: fromText });
    return fromText;
  }

  /**
   * Conservatively infers a seniority level from the job title when LinkedIn's
   * explicit metadata is unavailable.
   * @param {string} title
   * @returns {string}
   */
  function inferSeniorityFromTitle(title) {
    const normalized = normalizeHeading(title || "");
    if (!normalized) {
      return "";
    }
    if (/\b(?:intern|internship)\b/.test(normalized)) {
      return "Internship";
    }
    if (/\bprincipal\b/.test(normalized)) {
      return "Principal";
    }
    if (/\b(?:staff|distinguished|fellow)\b/.test(normalized)) {
      return "Staff";
    }
    if (/\b(?:vp|vice president|head of|chief|director)\b/.test(normalized)) {
      return "Director";
    }
    if (/\b(?:lead|manager)\b/.test(normalized)) {
      return "Lead";
    }
    if (/\b(?:senior|sr|snr)\b/.test(normalized)) {
      return "Senior";
    }
    if (/\b(?:junior|jr|entry|associate|graduate|new grad)\b/.test(normalized)) {
      return "Junior";
    }
    if (/\b(?:mid|intermediate)\b/.test(normalized)) {
      return "Mid-Senior level";
    }
    return "";
  }

  /**
   * @param {string} pageText
   * @param {string} [title]
   * @returns {string}
   */
  function extractSeniority(pageText, title) {
    const byHeading = getTextByHeading(["Seniority level", "Experience level"]);
    if (byHeading) {
      recordFieldDiag("seniorityLevel", { strategy: "Primary: seniority section", raw: byHeading });
      return byHeading;
    }
    const match = pageText.match(/Seniority level\s+([^\n·]{2,80})/i);
    const fromText = cleanText(match?.[1] || "");
    if (fromText) {
      recordFieldDiag("seniorityLevel", { strategy: "Fallback: page-text regex", raw: fromText });
      return fromText;
    }
    const fromTitle = inferSeniorityFromTitle(title);
    recordFieldDiag("seniorityLevel", { strategy: fromTitle ? "Fallback: title inference" : "None matched", raw: fromTitle });
    return fromTitle;
  }

  /**
   * Extracts skills from within the resolved About section, preferring bullet
   * lists, then dedicated skill areas, then known-skill keyword matching over
   * the section-derived description text.
   * @param {Element | null} section
   * @param {string} description
   * @returns {string[]}
   */
  function extractSkills(section, description) {
    const found = new Set();

    if (section) {
      collectBulletSkills(section).forEach((skill) => found.add(skill));
    }

    safeQuerySelectorAll("[data-testid*='skill' i] li, [aria-label*='skill' i] li").forEach((node) => {
      const text = cleanText(node.textContent);
      if (isLikelySkill(text)) {
        found.add(text);
      }
    });

    // Scope keyword matching to the role portion (Responsibilities, Qualifications,
    // technical stack) so company boilerplate cannot inject false positives.
    const source = cleanText(trimDescriptionAfterBoilerplate(description));
    for (const skill of KNOWN_SKILLS) {
      if (matchesKeyword(source, skill)) {
        found.add(skill);
      }
    }

    return Array.from(found).slice(0, 25);
  }

  /**
   * Collects short, skill-like entries from bullet lists within a container.
   * Bullets under a skills/requirements heading are included directly; other
   * bullets are included only when they mention a known skill keyword.
   * @param {Element} container
   * @returns {string[]}
   */
  function collectBulletSkills(container) {
    const skillHeadingPattern = /(skill|requirement|qualification|what you|you(?:'|\u2019)ll need|you have|technolog|tech stack|proficien|must have|nice to have|experience with)/i;
    const results = [];

    safeQuerySelectorAll("ul li, ol li", container).forEach((item) => {
      if (item.querySelector("ul, ol")) {
        return;
      }
      const text = cleanText(item.textContent);
      if (!isLikelySkill(text)) {
        return;
      }

      const list = item.closest("ul, ol");
      const headingText = cleanText(
        list?.previousElementSibling?.textContent ||
        list?.parentElement?.previousElementSibling?.textContent ||
        ""
      );

      const underSkillsHeading = skillHeadingPattern.test(headingText);
      const mentionsKnownSkill = KNOWN_SKILLS.some((skill) => matchesKeyword(text, skill));
      if (underSkillsHeading || mentionsKnownSkill) {
        results.push(text);
      }
    });

    return results;
  }

  /**
   * @param {string} text
   * @param {string} keyword
   * @returns {boolean}
   */
  function matchesKeyword(text, keyword) {
    const escaped = keyword
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "[\\s\\-]+");
    // Leading boundary keeps "." excluded so a keyword cannot match inside a
    // dotted token; the trailing boundary allows "." so a skill that ends a
    // sentence (e.g. "...Vitest.") is still recognized.
    return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#]|$)`, "i").test(String(text || ""));
  }

  /**
   * @param {string} text
   * @returns {boolean}
   */
  function isLikelySkill(text) {
    if (!text) {
      return false;
    }
    const wordCount = text.split(/\s+/).length;
    return text.length >= 2 && text.length <= 60 && wordCount <= 8 && !/[.!?]$/.test(text);
  }

  /**
   * @param {string} pageText
   * @returns {boolean}
   */
  function detectEasyApply(pageText) {
    const buttons = safeQuerySelectorAll("button, [role='button']");
    return buttons.some((button) => /\beasy apply\b/i.test(cleanText(button.textContent))) || /\beasy apply\b/i.test(pageText);
  }

  /**
   * Detects LinkedIn's "No longer accepting applications" notice.
   * @param {string} pageText
   * @returns {boolean}
   */
  function detectApplicationClosed(pageText) {
    // Primary: the accessible live-region notice - pairs an "Error"-labeled
    // icon with the exact text, inside an aria-live region. More precise than
    // a whole-page text search since it can't be confused by a "similar jobs"
    // card elsewhere on the page that happens to mention the same phrase for
    // a different listing; unlike a class-name selector, aria semantics don't
    // rotate with LinkedIn's class-hashed template variants.
    const liveRegions = safeQuerySelectorAll('[aria-live], [role="alert"]');
    const structural = liveRegions.some((region) => {
      const text = cleanText(region.textContent || "");
      return /no longer accepting applications/i.test(text) && Boolean(region.querySelector('[aria-label*="error" i]'));
    });
    if (structural) {
      return true;
    }

    // Fallback: plain text search, in case the aria structure changes.
    return /no longer accepting applications/i.test(pageText);
  }

  /**
   * @param {string} href
   * @returns {string}
   */
  function normalizeLinkedInUrl(href) {
    return window.parsers?.normalizeLinkedInUrl?.(href) || "";
  }

  /**
   * @param {string} url
   * @returns {string}
   */
  function normalizeJobUrl(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith("linkedin.com")) {
        return "";
      }
      // Preserve LinkedIn's canonical slugged path when one is available;
      // tracking parameters and fragments are not part of the canonical URL.
      parsed.hash = "";
      parsed.search = "";
      return parsed.href;
    } catch (_error) {
      return "";
    }
  }

  /**
   * Collects the top-of-page header fields (title, company, location).
   * @returns {{ jobTitle: string, companyName: string, companyUrl: string, location: string }}
   */
  function extractHeader() {
    const company = extractCompany();
    return {
      jobTitle: extractTitle(),
      companyName: company.name,
      companyUrl: company.url,
      location: extractLocation(company.name)
    };
  }

  /**
   * Collects the supporting metadata fields shown around the job card.
   * @param {string} pageText
   * @param {string} description
   * @param {string} [jobTitle]
   * @returns {{ seniorityLevel: string, salary: string, datePosted: string, applicantCount: string, easyApply: boolean, applicationClosed: boolean }}
   */
  function extractFooter(pageText, description, jobTitle) {
    return {
      seniorityLevel: extractSeniority(pageText, jobTitle),
      salary: extractSalary(pageText, description),
      datePosted: extractDatePosted(pageText),
      applicantCount: extractApplicants(pageText),
      easyApply: detectEasyApply(pageText),
      applicationClosed: detectApplicationClosed(pageText)
    };
  }

  /**
   * Finds the JobPosting node inside a parsed JSON-LD payload, walking arrays
   * and @graph collections.
   * @param {unknown} node
   * @returns {Record<string, any> | null}
   */
  function findJobPostingNode(node) {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findJobPostingNode(item);
        if (found) {
          return found;
        }
      }
      return null;
    }
    const type = node["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
      return node;
    }
    if (node["@graph"]) {
      return findJobPostingNode(node["@graph"]);
    }
    return null;
  }

  /**
   * Reads the embedded schema.org JobPosting structured data (server-rendered
   * for SEO) as a robust, layout-independent data source. Returns null when it
   * is absent or references a different job than the current URL.
   * @returns {Record<string, any> | null}
   */
  function getJobPostingLd() {
    const currentId = extractJobId(window.location.href);
    const scripts = safeQuerySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent || "");
      } catch (_error) {
        continue;
      }
      const posting = findJobPostingNode(parsed);
      if (!posting) {
        continue;
      }
      // Guard against stale SPA data: if the payload names a specific job id it
      // must match the job currently in the address bar.
      const serialized = JSON.stringify(posting);
      const referencesAJobId = /\/jobs\/view\/[^"'\\]*?\d{6,}/.test(serialized);
      if (currentId && referencesAJobId && !serialized.includes(currentId)) {
        continue;
      }
      return posting;
    }
    return null;
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function ldText(value) {
    return cleanText(typeof value === "string" ? value : "");
  }

  /**
   * @param {Record<string, any> | null} ld
   * @returns {{ name: string, url: string }}
   */
  function ldCompany(ld) {
    const org = ld?.hiringOrganization;
    if (!org || typeof org !== "object") {
      return { name: "", url: "" };
    }
    const name = ldText(org.name);
    const candidateUrl = [org.sameAs, org.url]
      .filter((value) => typeof value === "string")
      .find((value) => /linkedin\.com\/company\//i.test(value)) ||
      (typeof org.sameAs === "string" ? org.sameAs : "") ||
      (typeof org.url === "string" ? org.url : "");
    const url = normalizeLinkedInUrl(candidateUrl) || cleanText(candidateUrl);
    return { name, url };
  }

  /**
   * @param {Record<string, any> | null} ld
   * @returns {string}
   */
  function ldLocation(ld) {
    const raw = ld?.jobLocation;
    const location = Array.isArray(raw) ? raw[0] : raw;
    const address = location?.address;
    if (!address || typeof address !== "object") {
      return "";
    }
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map((value) => (typeof value === "string" ? cleanText(value) : ""))
      .filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}, ${parts[1]}`;
    }
    return parts[0] || "";
  }

  /**
   * Converts an HTML fragment to formatted plain text without executing scripts
   * or loading resources (DOMParser documents are inert).
   * @param {string} html
   * @returns {string}
   */
  function htmlToText(html) {
    try {
      const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
      return removeDescriptionChrome(getFormattedText(doc.body));
    } catch (_error) {
      return "";
    }
  }

  /**
   * @param {Record<string, any> | null} ld
   * @returns {string}
   */
  function ldDescription(ld) {
    const raw = typeof ld?.description === "string" ? ld.description : "";
    if (!raw) {
      return "";
    }
    // The JSON-LD description is usually HTML-encoded; decode then strip to text.
    return /<[a-z][\s\S]*>/i.test(raw) ? htmlToText(raw) : normalizeFormattedText(raw);
  }

  /**
   * @param {Record<string, any> | null} ld
   * @returns {string}
   */
  function ldSalary(ld) {
    const base = ld?.baseSalary;
    const value = base?.value;
    if (!value || typeof value !== "object") {
      return "";
    }
    const currency = cleanText(base.currency || value.currency || "").toUpperCase();
    const symbol = { USD: "$", CAD: "$", AUD: "$", EUR: "\u20ac", GBP: "\u00a3", INR: "\u20b9" }[currency] || "$";
    const unit = { YEAR: "/yr", MONTH: "/mo", WEEK: "/wk", DAY: "/day", HOUR: "/hr" }[cleanText(value.unitText).toUpperCase()] || "";
    const money = (amount) => `${symbol}${Number(amount).toLocaleString("en-US")}${unit}`;
    const min = value.minValue;
    const max = value.maxValue;
    if (min != null && max != null && !Number.isNaN(Number(min)) && !Number.isNaN(Number(max))) {
      return `${money(min)} - ${money(max)}`;
    }
    if (value.value != null && !Number.isNaN(Number(value.value))) {
      return money(value.value);
    }
    return "";
  }

  /**
   * @param {Record<string, any> | null} ld
   * @returns {string}
   */
  function ldEmploymentType(ld) {
    const raw = ld?.employmentType;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const key = cleanText(typeof value === "string" ? value : "").toUpperCase().replace(/[\s-]+/g, "_");
    const map = {
      FULL_TIME: "Full-time",
      PART_TIME: "Part-time",
      CONTRACTOR: "Contract",
      CONTRACT: "Contract",
      TEMPORARY: "Temporary",
      INTERN: "Internship",
      INTERNSHIP: "Internship",
      VOLUNTEER: "Volunteer",
      PER_DIEM: "Per diem",
      OTHER: "Other"
    };
    return map[key] || "";
  }

  /**
   * Extracts the current LinkedIn job from rendered page content only, using
   * section-aware discovery so the description comes from the About section.
   * The embedded JobPosting JSON-LD is used only to fill fields the DOM could
   * not resolve, so working values are never overridden.
   * @returns {object}
   */
  function extractJobData() {
    resetFieldDiag();
    const url = window.location.href;
    const pageText = cleanText(document.body?.textContent || "");
    const ld = getJobPostingLd();

    const header = extractHeader();

    const about = getSectionByHeading(ABOUT_HEADINGS);
    debugLog(`Section found: ${Boolean(about)}`);
    const aboutSection = about?.section || null;

    let description = extractDescription(aboutSection);
    if (description.length < 40) {
      const ldDesc = ldDescription(ld);
      if (ldDesc.length >= 40) {
        description = ldDesc;
        recordFieldDiag("description", { strategy: "Fallback: JSON-LD description", length: ldDesc.length, rawLength: ldDesc.length, boilerplateTrimmed: false });
      }
    }

    const skills = extractSkills(aboutSection, description);
    const footer = extractFooter(pageText, description, header.jobTitle);

    const ldOrg = ldCompany(ld);
    const jobData = {
      jobTitle: header.jobTitle || ldText(ld?.title),
      companyName: header.companyName || ldOrg.name,
      companyUrl: header.companyUrl || ldOrg.url,
      location: header.location || ldLocation(ld),
      workplaceType: extractWorkplaceType(description),
      employmentType: extractEmploymentType(description) || ldEmploymentType(ld),
      seniorityLevel: footer.seniorityLevel,
      salary: footer.salary || ldSalary(ld),
      datePosted: footer.datePosted || ldText(ld?.datePosted),
      applicantCount: footer.applicantCount,
      description,
      skills,
      easyApply: footer.easyApply,
      applicationClosed: footer.applicationClosed,
      jobUrl: normalizeJobUrl(url),
      jobId: extractJobId(url),
      extractedAt: new Date().toISOString()
    };

    const normalized = normalizeMissingFields(jobData);
    logExtractionDiagnostics(normalized, pageText);
    return normalized;
  }

  /**
   * @param {Record<string, unknown>} jobData
   * @returns {Record<string, unknown>}
   */
  function normalizeMissingFields(jobData) {
    const normalized = { ...jobData };
    for (const [key, value] of Object.entries(normalized)) {
      if (Array.isArray(value)) {
        normalized[key] = value.filter(Boolean);
      } else if (typeof value === "string") {
        const cleaned = key === "description" ? normalizeFormattedText(value) : cleanText(value);
        normalized[key] = cleaned || NOT_FOUND;
      }
    }
    return normalized;
  }

  /**
   * @param {boolean} value
   * @returns {string}
   */
  function yesNo(value) {
    return value ? "true" : "false";
  }

  /**
   * Prints a titled diagnostic block to the page console.
   * @param {string} title
   * @param {string[]} lines
   * @returns {void}
   */
  function printDiagnosticBlock(title, lines) {
    console.log(["", "=========================", title, "=========================", ...lines].join("\n"));
  }

  /**
   * Logs the startup context: current URL, document title, and pathname.
   * @returns {void}
   */
  function logStartupDiagnostics() {
    if (!isDebugEnabled()) {
      return;
    }
    printDiagnosticBlock("STARTUP", [
      `Current URL: ${window.location.href}`,
      `Document title: ${document.title}`,
      `Current pathname: ${window.location.pathname}`
    ]);
  }

  /**
   * Prints a Strategy / Raw value / Final value block for a simple field.
   * @param {string} field
   * @param {Record<string, unknown> | undefined} diag
   * @param {string} finalValue
   * @returns {void}
   */
  function printFieldStrategyBlock(field, diag, finalValue) {
    const info = diag || {};
    printDiagnosticBlock(`FIELD: ${field}`, [
      `Strategy: ${info.strategy || "(none)"}`,
      `Raw value: ${info.raw || "(empty)"}`,
      `Final value: ${finalValue}`
    ]);
  }

  /**
   * Collapses whitespace and truncates a value for single-line logging.
   * @param {string} value
   * @param {number} max
   * @returns {string}
   */
  function truncateForLog(value, max) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
  }

  /**
   * Prints per-field extraction diagnostics using the strategy details each
   * extractor recorded during the pass. Purely observational: it reads the
   * accumulator plus the final values and never changes extraction or output.
   * @param {Record<string, string>} finalData
   * @param {string} _pageText
   * @returns {void}
   */
  function logExtractionDiagnostics(finalData, _pageText) {
    if (!isDebugEnabled()) {
      return;
    }
    try {
      const company = fieldDiag.companyName || {};
      printDiagnosticBlock("FIELD: companyName", [
        `Strategy: ${company.strategy || "(none)"}`,
        `Selector: ${company.selector || "(none)"}`,
        `Found: ${yesNo(Boolean(company.found))}`,
        `Raw Value: ${company.raw || "(empty)"}`,
        `Final Value: ${finalData.companyName}`
      ]);

      const companyUrl = fieldDiag.companyUrl || {};
      printDiagnosticBlock("FIELD: companyUrl", [
        `Strategy: ${companyUrl.strategy || "(none)"}`,
        `Selector: ${companyUrl.selector || "(none)"}`,
        `Found: ${yesNo(Boolean(companyUrl.found))}`,
        `Raw Value: ${companyUrl.raw || "(empty)"}`,
        `Final Value: ${finalData.companyUrl}`
      ]);

      const description = fieldDiag.description || {};
      printDiagnosticBlock("FIELD: description", [
        `About section found: ${yesNo(Boolean(description.aboutSectionFound))}`,
        `expandable-text-box found: ${yesNo(Boolean(description.expandableFound))}`,
        `Description length: ${description.length || 0}`,
        `Raw length (pre-trim): ${description.rawLength || 0}`,
        `Boilerplate trimmed: ${yesNo(Boolean(description.boilerplateTrimmed))}`,
        `Strategy: ${description.strategy || "(none)"}`,
        `Final Value: ${truncateForLog(finalData.description, 160)}`
      ]);

      const salary = fieldDiag.salary || {};
      printDiagnosticBlock("FIELD: salary", [
        `Source text: ${truncateForLog(salary.sourceText, 120) || "(none)"}`,
        `Normalized value: ${salary.normalized || "(empty)"}`,
        `Final value: ${finalData.salary}`
      ]);

      printFieldStrategyBlock("location", fieldDiag.location, finalData.location);
      printFieldStrategyBlock("employmentType", fieldDiag.employmentType, finalData.employmentType);
      printFieldStrategyBlock("workplaceType", fieldDiag.workplaceType, finalData.workplaceType);
      printFieldStrategyBlock("seniorityLevel", fieldDiag.seniorityLevel, finalData.seniorityLevel);
      printFieldStrategyBlock("applicantCount", fieldDiag.applicantCount, finalData.applicantCount);

      const jobId = fieldDiag.jobId || {};
      printDiagnosticBlock("FIELD: jobId", [
        `Current URL: ${jobId.url || window.location.href}`,
        `Regex #1: ${jobId.regex1 || "(none)"}`,
        `Regex #2: ${jobId.regex2 || "(none)"}`,
        `Regex #3: ${jobId.regex3 || "(none)"}`,
        `Final value: ${finalData.jobId}`
      ]);
    } catch (error) {
      console.log("[LinkedIn Job Extractor] Diagnostics error:", error);
    }
  }

  /**
   * @returns {{ ok: boolean, status: string, message: string, jobData: object | null }}
   */
  function buildResponse() {
    if (!/\.linkedin\.com$/i.test(window.location.hostname)) {
      return {
        ok: false,
        status: "not_linkedin",
        message: "Open a LinkedIn job page to extract job details.",
        jobData: null
      };
    }

    if (!isSupportedLinkedInJobUrl(window.location.href)) {
      return {
        ok: false,
        status: "not_job_page",
        message: "Open a LinkedIn job page to extract job details.",
        jobData: null
      };
    }

    if (latestError) {
      return {
        ok: false,
        status: "extraction_failed",
        message: "Extraction failed unexpectedly. Click Refresh Job Data.",
        jobData: null
      };
    }

    if (!latestJobData || isMostlyEmpty(latestJobData)) {
      return {
        ok: false,
        status: "loading",
        message: "LinkedIn is still loading this job. Click Refresh Job Data.",
        jobData: latestJobData
      };
    }

    return {
      ok: true,
      status: "ready",
      message: missingImportantFields(latestJobData)
        ? "Some fields could not be found because LinkedIn may have changed its page structure."
        : "Job details extracted from the current page.",
      jobData: latestJobData
    };
  }

  /**
   * @param {Record<string, unknown>} jobData
   * @returns {boolean}
   */
  function isMostlyEmpty(jobData) {
    return [jobData.jobTitle, jobData.companyName, jobData.description].filter((value) => value && value !== NOT_FOUND).length === 0;
  }

  /**
   * @param {Record<string, unknown>} jobData
   * @returns {boolean}
   */
  function missingImportantFields(jobData) {
    return [jobData.jobTitle, jobData.companyName, jobData.location, jobData.description]
      .some((value) => !value || value === NOT_FOUND);
  }

  /**
   * Finds a likely job-description expansion control in the current section.
   * @param {Element | null} root
   * @returns {HTMLElement | null}
   */
  function findDescriptionExpansionButton(root) {
    if (!root) {
      return null;
    }

    const buttons = safeQuerySelectorAll("button, [role='button']", root);
    const expansionButton = buttons.find((button) => {
      const text = cleanText(button.textContent);
      const aria = cleanText(button.getAttribute("aria-label"));
      const title = cleanText(button.getAttribute("title"));
      const combined = `${text} ${aria} ${title}`;
      return /\b(show more|see more|show full description|more)\b/i.test(combined) &&
        !/\b(apply|easy apply|sign in|follow|save|share)\b/i.test(combined);
    });

    if (!expansionButton || !(expansionButton instanceof HTMLElement)) {
      return null;
    }

    return expansionButton;
  }

  /**
   * Clicks a likely job-description expansion control before extraction.
   * On some LinkedIn layouts the expandable box exists but its full content is
   * only revealed after the "more" control is clicked.
   * @returns {boolean}
   */
  function expandDescriptionIfPossible() {
    const currentUrl = window.location.href;
    if (descriptionExpandAttemptedForUrl === currentUrl) {
      return false;
    }

    const about = getSectionByHeading(ABOUT_HEADINGS);
    const aboutSection = about?.section || null;
    const descriptionRoot = aboutSection ||
      safeQuerySelector("#job-details, .jobs-description, .jobs-box__html-content, [data-testid*='job-description' i]") ||
      findElementByText(ABOUT_HEADINGS)?.closest("section, article, div");

    if (!descriptionRoot) {
      descriptionExpandAttemptedForUrl = currentUrl;
      return false;
    }

    const expansionButton = findDescriptionExpansionButton(descriptionRoot) ||
      (aboutSection ? findDescriptionExpansionButton(aboutSection.querySelector(EXPANDABLE_TEXT_BOX_SELECTOR)) : null);

    if (!expansionButton || !(expansionButton instanceof HTMLElement)) {
      descriptionExpandAttemptedForUrl = currentUrl;
      return false;
    }

    expansionButton.click();
    descriptionExpandAttemptedForUrl = currentUrl;
    return true;
  }

  function refreshExtraction() {
    try {
      latestError = null;
      latestJobData = extractJobData();
    } catch (error) {
      latestError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Reports whether this content script's extension context is still alive.
   * Reloading the unpacked extension while a LinkedIn tab stays open leaves the
   * old content script running with an invalidated context (chrome.runtime.id
   * becomes undefined); chrome.runtime API calls from that state throw.
   * @returns {boolean}
   */
  function isExtensionContextValid() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (_error) {
      return false;
    }
  }

  /**
   * Tears down the debounce timer and DOM observer once the extension context
   * is invalidated so an orphaned content script stops doing background work.
   * @returns {void}
   */
  function stopWatching() {
    window.clearTimeout(debounceTimer);
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
  }

  function scheduleExtraction() {
    if (!isExtensionContextValid()) {
      stopWatching();
      return;
    }
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(refreshExtraction, EXTRACTION_DEBOUNCE_MS);
  }

  function watchUrlChanges() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function pushStateWrapper(...args) {
      const result = originalPushState.apply(this, args);
      handleUrlMaybeChanged();
      return result;
    };

    history.replaceState = function replaceStateWrapper(...args) {
      const result = originalReplaceState.apply(this, args);
      handleUrlMaybeChanged();
      return result;
    };

    window.addEventListener("popstate", handleUrlMaybeChanged);
    window.addEventListener("hashchange", handleUrlMaybeChanged);
  }

  function handleUrlMaybeChanged() {
    if (window.location.href !== lastObservedUrl) {
      lastObservedUrl = window.location.href;
      descriptionExpandAttemptedForUrl = "";
      scheduleExtraction();
    }
  }

  function watchDomChanges() {
    domObserver = new MutationObserver((mutations) => {
      if (!isExtensionContextValid()) {
        stopWatching();
        return;
      }

      const relevant = mutations.some((mutation) => {
        if (mutation.type !== "childList") {
          return false;
        }
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return Boolean(target?.closest?.("main, article, section, [role='main'], .jobs-search__job-details"));
      });

      if (relevant) {
        scheduleExtraction();
      }
    });

    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }

    if (message.type === "GET_JOB_DATA") {
      const wantsFresh = Boolean(message.fresh);
      const clicked = expandDescriptionIfPossible();
      window.setTimeout(() => {
        refreshExtraction();
        try {
          sendResponse(buildResponse());
        } catch (_error) {
          // Extension context invalidated (e.g. reloaded) before the response
          // could be delivered; nothing left to respond to.
        }
      }, wantsFresh || clicked ? DESCRIPTION_EXPAND_WAIT_MS : 0);
      return true;
    }

    if (message.type === "EXPAND_AND_GET_JOB_DATA") {
      const clicked = expandDescriptionIfPossible();
      window.setTimeout(() => {
        refreshExtraction();
        try {
          sendResponse({ ...buildResponse(), expandedDescription: clicked });
        } catch (_error) {
          // Extension context invalidated (e.g. reloaded) before the response
          // could be delivered; nothing left to respond to.
        }
      }, clicked ? DESCRIPTION_EXPAND_WAIT_MS : 0);
      return true;
    }

    return false;
  });

  logStartupDiagnostics();
  refreshExtraction();
  watchUrlChanges();
  watchDomChanges();
})();
