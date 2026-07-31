/**
 * On-demand Application Assistant.
 *
 * Injected into the active tab only when the user clicks "Fill Basic
 * Fields on This Page" in the popup (via chrome.scripting.executeScript,
 * under the activeTab grant). Never runs automatically, never submits
 * anything, and only touches fields it can confidently recognize.
 *
 * Depends on profile-storage.js (window.LJEProfileStore) and
 * field-mapping-storage.js (window.LJEFieldMapping) being injected first
 * into the same tab.
 *
 * Smart Mapping (Phase 3): once a field is confidently recognized, or the
 * user confirms an ambiguous one, its domain + field identifier is saved
 * via LJEFieldMapping so this exact field is never re-detected or
 * re-asked-about on this domain again.
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

  const registry = []; // { input, badge, key, value, pending? }
  let overlayContainer = null;
  let toolbarEl = null;
  let statusEl = null;
  let observer = null;
  let repositionScheduled = false;
  let activeChooserPanel = null;
  let activeChooserCleanup = null;

  main();

  async function main() {
    const store = window.LJEProfileStore;
    const mappingStore = window.LJEFieldMapping;
    if (!store || !mappingStore) {
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

    const domain = mappingStore.getDomain();
    let domainMappings = {};
    try {
      domainMappings = await mappingStore.getDomainMappings(domain);
    } catch (_error) {
      domainMappings = {};
    }

    scanAndAnnotate(document, profile, domain, domainMappings);
    createToolbar(profile);
    observeMutations(profile, domain, domainMappings);
    window.addEventListener("scroll", scheduleReposition, true);
    window.addEventListener("resize", scheduleReposition);
  }

  /**
   * @param {ParentNode} root
   * @param {object} profile
   * @param {string} domain
   * @param {Record<string, object>} domainMappings mutable in-memory cache,
   *   kept in sync with storage as mappings are learned/confirmed.
   */
  function scanAndAnnotate(root, profile, domain, domainMappings) {
    const candidates = root.querySelectorAll(FILLABLE_SELECTOR);
    candidates.forEach((input) => {
      if (input.dataset.ljeAssisted === "1" || input.dataset.ljePending === "1" || input.dataset.ljeManual === "1") {
        return;
      }
      if (input.disabled || input.readOnly || !isVisible(input)) {
        return;
      }

      const signals = getSignals(input);
      const identifier = window.LJEFieldMapping.buildFieldIdentifier(signals);
      const existingMapping = identifier ? domainMappings[identifier] : null;

      if (existingMapping) {
        if (existingMapping.disabled || existingMapping.type === "skip") {
          // Explicit prior "skip"/"disable" decisions stay hands-off — no
          // manual fallback badge either, or it would undermine the choice.
          input.dataset.ljeAssisted = "1";
          return;
        }
        const value = resolveMappingValue(existingMapping, profile);
        if (!value) {
          attachManualBadge(input, identifier, signals.labelText, domain, domainMappings, profile);
          return;
        }
        input.dataset.ljeAssisted = "1";
        attachBadge(input, existingMapping.type, value);
        return;
      }

      const detection = scoreFieldSignals(signals);
      if (!detection) {
        // Never entered the detection pipeline at all — the manual
        // fallback ("+") is the only way to offer profile values here.
        attachManualBadge(input, identifier, signals.labelText, domain, domainMappings, profile);
        return;
      }

      const value = getProfileValue(profile, detection.key);
      if (!value) {
        // Detected, but the guessed profile field is empty — same "no
        // badge today" outcome, same manual fallback.
        attachManualBadge(input, identifier, signals.labelText, domain, domainMappings, profile);
        return;
      }

      if (detection.highConfidence || !identifier) {
        input.dataset.ljeAssisted = "1";
        attachBadge(input, detection.key, value);
        if (identifier && domain) {
          const learned = {
            type: "profile",
            profileField: detection.key,
            label: signals.labelText || identifier,
            disabled: false,
            source: "auto",
            updatedAt: new Date().toISOString()
          };
          domainMappings[identifier] = learned;
          window.LJEFieldMapping.saveMapping(domain, identifier, learned).catch(() => {});
        }
        return;
      }

      // Ambiguous: ask once, then remember whatever the user picks.
      input.dataset.ljePending = "1";
      attachAmbiguousBadge(input, detection.key, value, identifier, signals.labelText, domain, domainMappings, profile);
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

  // Roles/attributes that mark a control as dropdown/combobox-style rather
  // than a plain text field. role="combobox" covers native ARIA comboboxes
  // and React Select (which sets it directly on its underlying <input>);
  // aria-haspopup="listbox" and aria-autocomplete="list" catch widgets that
  // expose the same behavior without that exact role; the class-name
  // pattern is a fallback for ATS widgets/libraries that skip ARIA
  // attributes but follow a recognizable naming convention (react-select,
  // select2, etc.). Best-effort by nature — see isDropdownLikeControl.
  const DROPDOWN_ROLE_VALUES = new Set(["combobox", "listbox"]);
  const DROPDOWN_CLASS_PATTERN = /(?:^|[-_ ])(?:react-select|select2|combobox|listbox)(?:[-_ ]|$)/i;

  /**
   * Manual "+" fallback scope guard (temporary, deliberately narrow): that
   * fallback works by typing a plain value straight into the control, which
   * doesn't hold for dropdown/combobox-style widgets — picking a value
   * there means opening a popup and clicking an option, an interaction the
   * "+" flow doesn't support. Rather than show a badge that looks like it
   * should work but doesn't, dropdown-like controls are skipped entirely
   * until manual mapping for them gets its own design. Checks the control
   * itself and a few ancestor levels, since combobox roles/classes are as
   * often set on a wrapping container as on the input.
   * @param {HTMLElement} input
   * @returns {boolean}
   */
  function isDropdownLikeControl(input) {
    if (input.tagName === "SELECT") {
      return true;
    }
    let el = input;
    for (let depth = 0; el instanceof Element && depth < 4; depth += 1) {
      const role = (el.getAttribute("role") || "").toLowerCase();
      if (DROPDOWN_ROLE_VALUES.has(role)) {
        return true;
      }
      if ((el.getAttribute("aria-haspopup") || "").toLowerCase() === "listbox") {
        return true;
      }
      if ((el.getAttribute("aria-autocomplete") || "").toLowerCase() === "list") {
        return true;
      }
      if (typeof el.className === "string" && DROPDOWN_CLASS_PATTERN.test(el.className)) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  /**
   * Scores pre-computed signals against FIELD_RULES.
   * @param {object} signals from getSignals()
   * @returns {{ key: string, highConfidence: boolean } | null}
   */
  function scoreFieldSignals(signals) {
    let bestKey = null;
    let bestScore = 0;
    let bestHighConfidence = false;

    FIELD_RULES.forEach((rule) => {
      let score = 0;
      let highConfidence = false;
      if (rule.autocomplete && rule.autocomplete.includes(signals.autocomplete)) {
        score += 5;
        highConfidence = true;
      }
      if (rule.inputTypes && rule.inputTypes.includes(signals.type)) {
        score += 2;
      }
      if (rule.patterns.some((pattern) => pattern.test(signals.textBlob))) {
        score += 3;
      }
      if (rule.exactMatches && signals.exactCandidates.some((candidate) => rule.exactMatches.includes(candidate))) {
        score += 4;
        highConfidence = true;
      }
      if (score > bestScore) {
        bestScore = score;
        bestKey = rule.key;
        bestHighConfidence = highConfidence;
      }
    });

    if (bestScore < MIN_SCORE) {
      return null;
    }
    // A match built only from loose substring patterns (no autocomplete, no
    // exact label match) can still be ambiguous — e.g. "Professional
    // Website" could mean portfolio, LinkedIn, or something else entirely.
    // Smart Mapping asks the user once for these instead of guessing.
    return { key: bestKey, highConfidence: bestHighConfidence };
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
      name,
      id,
      placeholder,
      ariaLabel,
      labelText,
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
   * Resolves a stored mapping entry (of whatever type) to a fill value.
   * Unknown/future types (e.g. "ai", "prompt") resolve to "" — left alone
   * rather than guessed, until a future phase teaches this how to handle
   * them.
   * @param {object} mapping
   * @param {object} profile
   * @returns {string}
   */
  function resolveMappingValue(mapping, profile) {
    if (mapping.type === "profile") {
      return getProfileValue(profile, mapping.profileField);
    }
    if (mapping.type === "static") {
      return mapping.value || "";
    }
    return "";
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

  const BADGE_SIZE = 20;
  // Gap kept between a field's right edge and its badge, so the badge
  // never touches — let alone overlaps — the field's border.
  const BADGE_GAP = 8;

  /**
   * Shared visual base for every badge type (⚡ fill / ? ambiguous / +
   * manual). Only color, border, and symbol vary between them — size,
   * shape, and positioning are identical so they read as one consistent
   * system regardless of field type.
   * @param {string} symbol
   * @param {string} title
   * @param {Record<string, string>} colorStyles
   * @returns {HTMLButtonElement}
   */
  function createBadgeElement(symbol, title, colorStyles) {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.textContent = symbol;
    badge.title = title;
    applyStyles(badge, {
      position: "absolute",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: `${BADGE_SIZE}px`,
      height: `${BADGE_SIZE}px`,
      padding: "0",
      margin: "0",
      borderRadius: "50%",
      fontSize: "12px",
      fontWeight: "700",
      fontFamily: "Arial, sans-serif",
      cursor: "pointer",
      boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
      textAlign: "center",
      ...colorStyles
    });
    return badge;
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement} input
   * @param {string} key
   * @param {string} value
   */
  function attachBadge(input, key, value) {
    const container = ensureOverlayContainer();

    const badge = createBadgeElement("⚡", "Fill from active profile", {
      border: "1px solid #0a66c2",
      background: "#ffffff",
      color: "#0a66c2"
    });
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      fillField(input, value);
    });

    container.appendChild(badge);

    const entry = { input, badge, key, value };
    registry.push(entry);
    positionBadge(entry);
  }

  /**
   * Single reusable positioning rule shared by every badge type: always
   * outside the field's right edge, never inside it or on its left, and
   * vertically centered on it — regardless of the field's own height
   * (input, textarea, select, or a container wrapping a custom dropdown /
   * radio group / checkbox group).
   * @param {HTMLElement} badge
   * @param {HTMLElement} field
   */
  function positionBadgeOutsideRight(badge, field) {
    if (!field.isConnected) {
      badge.style.display = "none";
      return;
    }
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      badge.style.display = "none";
      return;
    }
    badge.style.display = "flex";
    const centerY = rect.top + window.scrollY + rect.height / 2;
    const left = rect.right + window.scrollX + BADGE_GAP;
    badge.style.top = `${Math.max(0, centerY - BADGE_SIZE / 2)}px`;
    badge.style.left = `${Math.max(0, left)}px`;
  }

  /**
   * @param {{ input: HTMLElement, badge: HTMLElement }} entry
   */
  function positionBadge(entry) {
    if (entry.manual && isDropdownLikeControl(entry.input)) {
      // A framework can hydrate a plain input into a combobox/dropdown
      // widget after the initial scan already attached a manual badge to
      // it (ARIA role/class added post-mount). Tear it down here rather
      // than reposition it — this runs on every scroll/resize/mutation
      // recheck, so it catches that case even though attachManualBadge's
      // own guard only sees the field's state at attach time.
      removeManualBadge(entry);
      return;
    }
    positionBadgeOutsideRight(entry.badge, entry.input);
  }

  /**
   * @param {{ input: HTMLElement, badge: HTMLElement }} entry
   */
  function removeManualBadge(entry) {
    entry.badge.remove();
    const index = registry.indexOf(entry);
    if (index !== -1) {
      registry.splice(index, 1);
    }
  }

  /**
   * Reusable secondary/primary confirm row for the small in-page prompts
   * (e.g. "Always use X for this field on this domain?"). Flexbox only —
   * no absolute positioning. Each button is `flex: 1 1 auto` with a
   * minimum width, so the row wraps the primary button onto its own line
   * once the panel is too narrow to fit both, instead of letting them
   * overlap or clip a long/translated label.
   * @param {{ secondaryLabel: string, primaryLabel: string, onSecondary: () => void, onPrimary: () => void }} options
   * @returns {HTMLElement}
   */
  function createConfirmActions({ secondaryLabel, primaryLabel, onSecondary, onPrimary }) {
    const actions = document.createElement("div");
    applyStyles(actions, {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "stretch",
      justifyContent: "center",
      gap: "12px",
      width: "100%"
    });

    const baseButtonStyle = {
      flex: "1 1 auto",
      minWidth: "112px",
      boxSizing: "border-box",
      padding: "8px 14px",
      borderRadius: "8px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px",
      fontWeight: "700",
      lineHeight: "1.3",
      whiteSpace: "normal",
      overflowWrap: "anywhere",
      textAlign: "center"
    };

    const secondaryBtn = document.createElement("button");
    secondaryBtn.type = "button";
    secondaryBtn.textContent = secondaryLabel;
    applyStyles(secondaryBtn, {
      ...baseButtonStyle,
      background: "#ffffff",
      color: "#0a66c2",
      border: "1px solid #0a66c2"
    });
    secondaryBtn.addEventListener("click", onSecondary);
    actions.appendChild(secondaryBtn);

    const primaryBtn = document.createElement("button");
    primaryBtn.type = "button";
    primaryBtn.textContent = primaryLabel;
    applyStyles(primaryBtn, {
      ...baseButtonStyle,
      background: "#0a66c2",
      color: "#ffffff",
      border: "1px solid #0a66c2"
    });
    primaryBtn.addEventListener("click", onPrimary);
    actions.appendChild(primaryBtn);

    return actions;
  }

  /**
   * Badge shown for a field the generic detector matched only loosely
   * (e.g. a bare pattern hit, no autocomplete/exact-label signal) — good
   * enough to guess, not good enough to fill silently. Clicking it opens
   * a small picker; whatever the user chooses is remembered for this
   * domain so the same field is never asked about again.
   * @param {HTMLInputElement | HTMLTextAreaElement} input
   * @param {string} guessKey
   * @param {string} guessValue
   * @param {string | null} identifier
   * @param {string} rawLabel
   * @param {string} domain
   * @param {Record<string, object>} domainMappings
   * @param {object} profile
   */
  function attachAmbiguousBadge(input, guessKey, guessValue, identifier, rawLabel, domain, domainMappings, profile) {
    const container = ensureOverlayContainer();

    const badge = createBadgeElement("?", "Click to confirm which profile field this is", {
      border: "1px solid #c77700",
      background: "#fff8ec",
      color: "#c77700"
    });

    const entry = { input, badge, key: guessKey, value: guessValue, pending: true };
    registry.push(entry);

    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openChooser(entry, { guessKey, identifier, rawLabel, domain, domainMappings, profile });
    });

    container.appendChild(badge);
    positionBadge(entry);
    return entry;
  }

  /**
   * @param {{ input: HTMLElement, badge: HTMLElement }} entry
   * @param {{ guessKey: string, identifier: string | null, rawLabel: string, domain: string, domainMappings: Record<string, object>, profile: object }} ctx
   */
  function openChooser(entry, ctx) {
    closeChooser();
    const container = ensureOverlayContainer();

    const panel = document.createElement("div");
    applyStyles(panel, {
      position: "absolute",
      minWidth: "230px",
      maxWidth: "270px",
      background: "#ffffff",
      border: "1px solid #d8dee6",
      borderRadius: "8px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      padding: "10px",
      fontFamily: "Arial, sans-serif",
      fontSize: "12px",
      color: "#19212a"
    });

    container.appendChild(panel);
    positionPanelNearInput(panel, entry.input);
    activeChooserPanel = panel;
    renderChoiceView(panel, entry, ctx);

    const outsideClickHandler = (event) => {
      if (!panel.contains(event.target) && event.target !== entry.badge) {
        closeChooser();
      }
    };
    window.setTimeout(() => document.addEventListener("click", outsideClickHandler, true), 0);
    activeChooserCleanup = () => document.removeEventListener("click", outsideClickHandler, true);
  }

  /**
   * Default chooser view: pick a profile field, skip, or switch to the
   * custom-value view.
   * @param {HTMLElement} panel
   * @param {object} entry
   * @param {object} ctx
   */
  function renderChoiceView(panel, entry, ctx) {
    panel.textContent = "";

    const title = document.createElement("p");
    title.textContent = `This field looks like "${ctx.rawLabel || ctx.identifier || "an unlabeled field"}". Which value should be used?`;
    applyStyles(title, { margin: "0 0 8px", lineHeight: "1.4" });
    panel.appendChild(title);

    const select = document.createElement("select");
    applyStyles(select, { width: "100%", padding: "6px", borderRadius: "6px", border: "1px solid #d8dee6", font: "inherit" });

    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = "Choose a profile field…";
    placeholderOption.selected = true;
    select.appendChild(placeholderOption);

    window.LJEFieldMapping.PROFILE_FIELDS.forEach(({ key, label }) => {
      const option = document.createElement("option");
      option.value = key;
      // Deliberately not pre-selected, even for the detector's best guess:
      // a native <select> fires no "change" event when the user picks the
      // option that's already selected, which made confirming the (usually
      // correct) guess look like a dead click. Show it as a hint instead
      // and require an explicit choice, which always fires a real change.
      option.textContent = key === ctx.guessKey ? `${label} (suggested)` : label;
      select.appendChild(option);
    });

    const skipOption = document.createElement("option");
    skipOption.value = "__skip__";
    skipOption.textContent = "Skip — never fill this field";
    select.appendChild(skipOption);

    const customOption = document.createElement("option");
    customOption.value = "__custom__";
    customOption.textContent = "+ Create Custom Value…";
    select.appendChild(customOption);

    panel.appendChild(select);

    select.addEventListener("change", () => {
      const chosen = select.value;
      if (!chosen) {
        return;
      }
      if (chosen === "__custom__") {
        renderCustomValueView(panel, entry, ctx);
        return;
      }
      if (chosen === "__skip__") {
        resolveAndSave(entry, ctx, { type: "skip", label: ctx.rawLabel || ctx.identifier });
        return;
      }
      resolveAndSave(entry, ctx, { type: "profile", profileField: chosen, label: ctx.rawLabel || ctx.identifier });
    });
  }

  /**
   * Custom-value view: a reusable, fixed answer for this field that isn't
   * part of the profile at all (e.g. "How did you hear about us?"). Shared
   * by both the ambiguous "?" picker and the manual "+" fallback picker —
   * `backView` decides which picker "Back" returns to.
   * @param {HTMLElement} panel
   * @param {object} entry
   * @param {object} ctx
   * @param {{ backView?: (panel: HTMLElement, entry: object, ctx: object) => void }} [options]
   */
  function renderCustomValueView(panel, entry, ctx, options) {
    const backView = options?.backView || renderChoiceView;
    panel.textContent = "";

    const title = document.createElement("p");
    title.textContent = "Create a custom value for this field.";
    applyStyles(title, { margin: "0 0 8px", lineHeight: "1.4", fontWeight: "700" });
    panel.appendChild(title);

    const fieldStyle = {
      width: "100%",
      padding: "6px",
      marginTop: "4px",
      marginBottom: "8px",
      borderRadius: "6px",
      border: "1px solid #d8dee6",
      font: "inherit",
      boxSizing: "border-box"
    };

    const nameLabel = document.createElement("label");
    applyStyles(nameLabel, { display: "block", marginBottom: "2px" });
    nameLabel.textContent = "Custom value name";
    panel.appendChild(nameLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = ctx.rawLabel || ctx.identifier || "";
    applyStyles(nameInput, fieldStyle);
    panel.appendChild(nameInput);

    const valueLabel = document.createElement("label");
    applyStyles(valueLabel, { display: "block", marginBottom: "2px" });
    valueLabel.textContent = "Value";
    panel.appendChild(valueLabel);

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.placeholder = "e.g. LinkedIn";
    applyStyles(valueInput, fieldStyle);
    panel.appendChild(valueInput);

    const rememberLabel = document.createElement("label");
    applyStyles(rememberLabel, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px", fontWeight: "400" });
    const rememberCheckbox = document.createElement("input");
    rememberCheckbox.type = "checkbox";
    rememberCheckbox.checked = true;
    rememberLabel.appendChild(rememberCheckbox);
    const rememberText = document.createElement("span");
    rememberText.textContent = "Always use this value on this domain";
    rememberLabel.appendChild(rememberText);
    panel.appendChild(rememberLabel);

    const actions = document.createElement("div");
    applyStyles(actions, { display: "flex", gap: "8px" });

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.textContent = "Back";
    applyStyles(backBtn, {
      background: "#ffffff",
      color: "#0a66c2",
      border: "1px solid #0a66c2",
      borderRadius: "6px",
      padding: "6px 10px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px"
    });
    backBtn.addEventListener("click", () => backView(panel, entry, ctx));
    actions.appendChild(backBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    applyStyles(saveBtn, {
      background: "#0a66c2",
      color: "#ffffff",
      border: "1px solid #0a66c2",
      borderRadius: "6px",
      padding: "6px 10px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px"
    });
    saveBtn.addEventListener("click", () => {
      const value = valueInput.value.trim();
      if (!value) {
        valueInput.focus();
        return;
      }
      const label = nameInput.value.trim() || ctx.rawLabel || ctx.identifier;
      resolveAndSave(entry, ctx, { type: "static", value, label }, { persist: rememberCheckbox.checked });
    });
    actions.appendChild(saveBtn);

    panel.appendChild(actions);
    valueInput.focus();
  }

  /**
   * Applies the chosen mapping to the field right now, and — unless the
   * caller opts out (the custom-value "always use this on this domain"
   * checkbox) — remembers it for this domain + field identifier so it's
   * never asked about again.
   * @param {object} entry
   * @param {object} ctx
   * @param {{ type: "profile" | "static" | "skip", profileField?: string, value?: string, label: string }} mapping
   * @param {{ persist?: boolean }} [options]
   */
  async function resolveAndSave(entry, ctx, mapping, options) {
    const persist = options?.persist !== false;

    delete entry.input.dataset.ljePending;
    delete entry.input.dataset.ljeManual;
    entry.input.dataset.ljeAssisted = "1";
    entry.badge.remove();
    const index = registry.indexOf(entry);
    if (index !== -1) {
      registry.splice(index, 1);
    }

    if (ctx.identifier && ctx.domain && persist) {
      const saved = {
        type: mapping.type,
        profileField: mapping.profileField,
        value: mapping.value,
        label: mapping.label,
        disabled: false,
        source: "user",
        updatedAt: new Date().toISOString()
      };
      ctx.domainMappings[ctx.identifier] = saved;
      try {
        await window.LJEFieldMapping.saveMapping(ctx.domain, ctx.identifier, {
          type: mapping.type,
          profileField: mapping.profileField,
          value: mapping.value,
          label: mapping.label,
          source: "user"
        });
      } catch (_error) {
        // Non-fatal: the field still gets filled this time even if persistence fails.
      }
    }

    const fillValue = resolveMappingValue(mapping, ctx.profile);
    if (fillValue) {
      fillField(entry.input, fillValue);
      attachBadge(entry.input, mapping.type, fillValue);
    }

    closeChooser();

    // Without this, picking a profile field that's blank in the active
    // profile (or, defensively, an empty static value) looks like the
    // click did nothing at all — the mapping is still saved (so it won't
    // ask again), but nothing visibly happens. Say so explicitly instead
    // of silently no-oping.
    if (!fillValue && mapping.type !== "skip" && statusEl) {
      const reason =
        mapping.type === "profile"
          ? `your active profile has no value for "${window.LJEFieldMapping.PROFILE_FIELD_LABELS[mapping.profileField] || mapping.profileField}"`
          : "the custom value was empty";
      const savedPrefix = persist && ctx.identifier && ctx.domain ? "Mapping saved, but nothing" : "Nothing";
      statusEl.textContent = `${savedPrefix} was filled — ${reason}.`;
    } else {
      updateToolbarStatus();
    }
  }

  /**
   * Phase 3.5 — Manual Fallback: for a field that never entered the
   * detection pipeline at all (or did, but resolved to nothing), this is
   * the only way to offer profile values there. Deliberately separate
   * from FIELD_RULES/scoreFieldSignals/confidence scoring — it runs only
   * after that pipeline has already given up on a field, and reuses the
   * exact same fill + Smart Mapping save logic (resolveAndSave) as the
   * ambiguous "?" picker. No detection, no guessing: this only ever shows
   * up when nothing else recognized the field.
   * @param {HTMLInputElement | HTMLTextAreaElement} input
   * @param {string | null} identifier
   * @param {string} rawLabel
   * @param {string} domain
   * @param {Record<string, object>} domainMappings
   * @param {object} profile
   */
  function attachManualBadge(input, identifier, rawLabel, domain, domainMappings, profile) {
    if (isDropdownLikeControl(input)) {
      // Out of scope for now — see isDropdownLikeControl. No badge, no
      // dataset marker: leaving ljeManual unset means a later rescan (the
      // field's role/class can still be added post-hydration) checks this
      // guard again instead of assuming the earlier "skip" still holds.
      return;
    }
    input.dataset.ljeManual = "1";
    const container = ensureOverlayContainer();

    const badge = createBadgeElement("+", "Not recognized — click to fill manually from your profile", {
      border: "1px solid #9aa5b1",
      background: "#f3f5f8",
      color: "#5b6673"
    });

    const entry = { input, badge, key: null, value: "", pending: true, manual: true };
    registry.push(entry);

    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openManualChooser(entry, { identifier, rawLabel, domain, domainMappings, profile });
    });

    container.appendChild(badge);
    positionBadge(entry);
    return entry;
  }

  /**
   * @param {object} entry
   * @param {{ identifier: string | null, rawLabel: string, domain: string, domainMappings: Record<string, object>, profile: object }} ctx
   */
  function openManualChooser(entry, ctx) {
    closeChooser();
    const container = ensureOverlayContainer();

    const panel = document.createElement("div");
    applyStyles(panel, {
      position: "absolute",
      boxSizing: "border-box",
      minWidth: "240px",
      maxWidth: "300px",
      background: "#ffffff",
      border: "1px solid #d8dee6",
      borderRadius: "8px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      padding: "10px",
      fontFamily: "Arial, sans-serif",
      fontSize: "12px",
      color: "#19212a"
    });

    container.appendChild(panel);
    positionPanelNearInput(panel, entry.input);
    activeChooserPanel = panel;
    renderManualPickView(panel, entry, ctx);

    const outsideClickHandler = (event) => {
      if (!panel.contains(event.target) && event.target !== entry.badge) {
        closeChooser();
      }
    };
    window.setTimeout(() => document.addEventListener("click", outsideClickHandler, true), 0);
    activeChooserCleanup = () => document.removeEventListener("click", outsideClickHandler, true);
  }

  /**
   * @param {HTMLElement} panel
   * @param {object} entry
   * @param {object} ctx
   */
  function renderManualPickView(panel, entry, ctx) {
    panel.textContent = "";

    const title = document.createElement("p");
    title.textContent = "This field wasn't recognized. Fill it from your profile:";
    applyStyles(title, { margin: "0 0 8px", lineHeight: "1.4" });
    panel.appendChild(title);

    const select = document.createElement("select");
    applyStyles(select, { width: "100%", padding: "6px", borderRadius: "6px", border: "1px solid #d8dee6", font: "inherit" });

    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = "Fill from…";
    placeholderOption.selected = true;
    select.appendChild(placeholderOption);

    window.LJEFieldMapping.PROFILE_FIELDS.forEach(({ key, label }) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      select.appendChild(option);
    });

    const customOption = document.createElement("option");
    customOption.value = "__custom__";
    customOption.textContent = "+ Create Custom Value…";
    select.appendChild(customOption);

    panel.appendChild(select);

    select.addEventListener("change", () => {
      const chosen = select.value;
      if (!chosen) {
        return;
      }
      if (chosen === "__custom__") {
        renderCustomValueView(panel, entry, ctx, { backView: renderManualPickView });
        return;
      }
      if (!ctx.identifier) {
        // Nothing stable to remember this field by — fill once, don't
        // pretend a "remember?" question would do anything.
        resolveManualPick(entry, ctx, chosen, { persist: false });
        return;
      }
      renderManualConfirmView(panel, entry, ctx, chosen);
    });
  }

  /**
   * @param {HTMLElement} panel
   * @param {object} entry
   * @param {object} ctx
   * @param {string} profileField
   */
  function renderManualConfirmView(panel, entry, ctx, profileField) {
    panel.textContent = "";
    const fieldLabel = window.LJEFieldMapping.PROFILE_FIELD_LABELS[profileField] || profileField;

    const title = document.createElement("p");
    title.textContent = `Always use ${fieldLabel} for this field on this domain?`;
    applyStyles(title, { margin: "0 0 12px", lineHeight: "1.4", overflowWrap: "anywhere" });
    panel.appendChild(title);

    panel.appendChild(
      createConfirmActions({
        secondaryLabel: "Just Once",
        primaryLabel: "Always Remember",
        onSecondary: () => resolveManualPick(entry, ctx, profileField, { persist: false }),
        onPrimary: () => resolveManualPick(entry, ctx, profileField, { persist: true })
      })
    );
  }

  /**
   * @param {object} entry
   * @param {object} ctx
   * @param {string} profileField
   * @param {{ persist: boolean }} options
   */
  function resolveManualPick(entry, ctx, profileField, options) {
    return resolveAndSave(
      entry,
      ctx,
      { type: "profile", profileField, label: ctx.rawLabel || ctx.identifier || "Manually filled field" },
      options
    );
  }

  function closeChooser() {
    if (activeChooserPanel) {
      activeChooserPanel.remove();
      activeChooserPanel = null;
    }
    if (activeChooserCleanup) {
      activeChooserCleanup();
      activeChooserCleanup = null;
    }
  }

  /**
   * @param {HTMLElement} panel
   * @param {HTMLElement} input
   */
  function positionPanelNearInput(panel, input) {
    const rect = input.getBoundingClientRect();
    const top = rect.bottom + window.scrollY + 6;
    const left = Math.max(0, rect.left + window.scrollX);
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
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
   * @param {HTMLElement} element
   */
  function focusPreservingScroll(element) {
    try {
      element.focus({ preventScroll: true });
    } catch (_error) {
      element.focus();
    }
  }

  /**
   * Single shared fill primitive — every successful fill in this file
   * (badge click, "Fill Basic Fields", Smart Mapping resolution) goes
   * through this, so every field type and every ATS gets the same
   * treatment with no per-site patches.
   *
   * Setting `element.value` directly is invisible to React/Vue/Angular:
   * those frameworks track their own bound state rather than reading the
   * DOM property, so a plain assignment leaves them thinking the field is
   * still empty — value visibly changes, but validation keeps saying
   * "required" until the user clicks into the field and back out.
   *
   * Fixes that by:
   *   1. Writing through the native value setter (bypasses any
   *      framework-installed accessor on the element instance, the same
   *      trick already used here since Phase 2).
   *   2. Dispatching bubbling "input" then "change" so bound listeners
   *      update their state exactly like a real keystroke would.
   *   3. Cycling focus/blur afterward — some validation (Angular reactive
   *      forms' touched/dirty state, React Hook Form's `mode: 'onBlur'`,
   *      etc.) only re-evaluates "required"/invalid display on blur; this
   *      reproduces the focus+blur a manual click would have caused,
   *      which is exactly the workaround this replaces.
   *   4. Restoring focus afterward if the field already had it, so a
   *      field the user was actively typing in isn't left focus-shifted.
   * @param {HTMLInputElement | HTMLTextAreaElement} element
   * @param {string} value
   */
  function fillField(element, value) {
    const hadFocus = document.activeElement === element;

    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));

    // blur() is a no-op on an element that isn't focused, so briefly
    // focus it first when needed to guarantee a real blur event fires.
    if (!hadFocus) {
      focusPreservingScroll(element);
    }
    element.blur();
    if (hadFocus) {
      focusPreservingScroll(element);
    }
  }

  function fillAllBasicFields() {
    let filledCount = 0;
    registry.forEach(({ input, value, pending }) => {
      if (pending) {
        return;
      }
      if (!input.isConnected) {
        return;
      }
      if (input.value && input.value.trim() !== "") {
        return;
      }
      fillField(input, value);
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

    const manualCount = registry.filter((entry) => entry.manual).length;
    const pendingCount = registry.filter((entry) => entry.pending && !entry.manual).length;
    const resolvedCount = registry.length - pendingCount - manualCount;
    let text = `${resolvedCount} field${resolvedCount === 1 ? "" : "s"} recognized`;
    const extras = [];
    if (pendingCount > 0) {
      extras.push(`${pendingCount} need${pendingCount === 1 ? "s" : ""} confirmation`);
    }
    if (manualCount > 0) {
      extras.push(`${manualCount} unrecognized (click + to fill manually)`);
    }
    if (extras.length) {
      text += `, ${extras.join(", ")}`;
    }
    statusEl.textContent = text;
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
   * @param {string} domain
   * @param {Record<string, object>} domainMappings
   */
  function observeMutations(profile, domain, domainMappings) {
    let debounceTimer = null;
    observer = new MutationObserver(() => {
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(() => {
        scanAndAnnotate(document, profile, domain, domainMappings);
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
    closeChooser();

    registry.forEach((entry) => {
      delete entry.input.dataset.ljeAssisted;
      delete entry.input.dataset.ljePending;
      delete entry.input.dataset.ljeManual;
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
