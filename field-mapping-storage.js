/**
 * Smart Mapping engine (Phase 3): per-domain memory of how a job site's
 * form fields should be filled, so the same field is never asked about
 * twice on the same domain.
 *
 * A mapping entry is one of several *types*, discriminated by `type`:
 *   - "profile": fill from the active profile ({ profileField })
 *   - "static":  fill with a fixed, user-defined value ({ value }) — for
 *     answers that aren't part of a profile at all (e.g. "How did you hear
 *     about us?" -> "LinkedIn").
 *   - "skip":    never fill this field, never ask again.
 * Future types (e.g. "ai", "prompt") can be added later by teaching the
 * resolver in application-assistant.js what to do with them — this
 * storage shape does not need to change to support that.
 *
 * Local-only, chrome.storage.local exclusively. No AI, no network, no
 * per-site/ATS-specific logic — mappings are learned generically from
 * whatever domain + field signals are seen at fill time.
 *
 * Self-contained on purpose (does not depend on application-assistant.js
 * or profile-storage.js internals) so future phases/pages can reuse it,
 * per the Phase 3 architecture requirement. Exposed as window.LJEFieldMapping.
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "ljeFieldMappings";
  const SCHEMA_VERSION = 1;

  // The profile fields the Application Assistant already knows how to fill
  // (application-assistant.js's getProfileValue). Kept here too so the
  // Mapping Manager UI and the ask-once picker share one source of truth.
  const PROFILE_FIELDS = [
    { key: "fullName", label: "Full Name" },
    { key: "firstName", label: "First Name" },
    { key: "lastName", label: "Last Name" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "linkedinUrl", label: "LinkedIn" },
    { key: "githubUrl", label: "GitHub" },
    { key: "portfolioUrl", label: "Portfolio / Website" },
    { key: "currentTitle", label: "Current Title" },
    { key: "location", label: "Location" }
  ];

  const PROFILE_FIELD_LABELS = PROFILE_FIELDS.reduce((acc, field) => {
    acc[field.key] = field.label;
    return acc;
  }, {});

  function emptyState() {
    return { version: SCHEMA_VERSION, domains: {} };
  }

  function readState() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const stored = result?.[STORAGE_KEY];
        if (!stored || typeof stored !== "object") {
          resolve(emptyState());
          return;
        }
        resolve({
          version: stored.version || SCHEMA_VERSION,
          domains: { ...(stored.domains || {}) }
        });
      });
    });
  }

  function writeState(state) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: state }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function normalizeText(value) {
    return String(value || "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /**
   * Builds a stable field identifier from ordered signal candidates
   * (label text is preferred since it's what the site itself shows the
   * user, and is the most stable thing across page reloads/rebuilds).
   * Deliberately avoids DOM position/selectors, which are fragile.
   * @param {{ labelText?: string, ariaLabel?: string, placeholder?: string, name?: string, id?: string }} signals
   * @returns {string | null}
   */
  function buildFieldIdentifier(signals) {
    const candidates = [
      signals?.labelText,
      signals?.ariaLabel,
      signals?.placeholder,
      signals?.name,
      signals?.id
    ];
    for (const candidate of candidates) {
      const normalized = normalizeText(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  /**
   * @returns {string}
   */
  function getDomain() {
    try {
      return global.location.hostname || "";
    } catch (_error) {
      return "";
    }
  }

  /**
   * Backfills `type` on mappings saved before typed mappings existed, so
   * old data keeps working without a migration step. A legacy entry only
   * ever had `profileField` (string, or null for "skip").
   * @param {object | null} entry
   * @returns {object | null}
   */
  function normalizeMappingEntry(entry) {
    if (!entry) {
      return entry;
    }
    if (entry.type) {
      return entry;
    }
    if (entry.profileField === null || entry.profileField === undefined) {
      return { ...entry, type: "skip" };
    }
    return { ...entry, type: "profile" };
  }

  /**
   * @param {Record<string, object>} domainMap
   * @returns {Record<string, object>}
   */
  function normalizeDomainMap(domainMap) {
    const result = {};
    Object.keys(domainMap || {}).forEach((identifier) => {
      result[identifier] = normalizeMappingEntry(domainMap[identifier]);
    });
    return result;
  }

  async function getAllMappings() {
    const state = await readState();
    const result = {};
    Object.keys(state.domains).forEach((domain) => {
      result[domain] = normalizeDomainMap(state.domains[domain]);
    });
    return result;
  }

  /**
   * @param {string} domain
   */
  async function getDomainMappings(domain) {
    const state = await readState();
    return normalizeDomainMap(state.domains[domain]);
  }

  /**
   * @param {string} domain
   * @param {string} identifier
   */
  async function getMapping(domain, identifier) {
    const state = await readState();
    return normalizeMappingEntry(state.domains[domain]?.[identifier] || null);
  }

  /**
   * Creates or updates one mapping entry. `type` determines which other
   * fields apply:
   *   - "profile": expects `profileField` (a PROFILE_FIELDS key)
   *   - "static":  expects `value` (the fixed text to fill)
   *   - "skip":    no extra payload
   * If `type` is omitted, it's inferred from legacy-shaped `fields` (just
   * `profileField`) so existing call sites keep working.
   * @param {string} domain
   * @param {string} identifier
   * @param {{ type?: "profile" | "static" | "skip", profileField?: string | null, value?: string, label?: string, disabled?: boolean, source?: "auto" | "user" }} fields
   */
  async function saveMapping(domain, identifier, fields) {
    if (!domain || !identifier) {
      throw new Error("Domain and field identifier are required.");
    }
    const state = await readState();
    const now = new Date().toISOString();
    const existing = normalizeMappingEntry(state.domains[domain]?.[identifier]);

    const type =
      fields.type ||
      existing?.type ||
      (fields.profileField !== undefined ? (fields.profileField === null ? "skip" : "profile") : "skip");

    const entry = {
      type,
      label: fields.label || existing?.label || identifier,
      disabled: fields.disabled === undefined ? existing?.disabled || false : Boolean(fields.disabled),
      source: fields.source || existing?.source || "user",
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    if (type === "profile") {
      entry.profileField = fields.profileField !== undefined ? fields.profileField : existing?.profileField || null;
    } else if (type === "static") {
      entry.value = fields.value !== undefined ? fields.value : existing?.value || "";
    }
    // "skip" carries no extra payload. A future type (e.g. "ai", "prompt")
    // would attach its own fields here without changing this shape.

    if (!state.domains[domain]) {
      state.domains[domain] = {};
    }
    state.domains[domain][identifier] = entry;
    await writeState(state);
    return entry;
  }

  /**
   * @param {string} domain
   * @param {string} identifier
   * @param {boolean} disabled
   */
  async function setMappingDisabled(domain, identifier, disabled) {
    const state = await readState();
    const existing = state.domains[domain]?.[identifier];
    if (!existing) {
      throw new Error("Mapping not found.");
    }
    existing.disabled = Boolean(disabled);
    existing.updatedAt = new Date().toISOString();
    await writeState(state);
    return existing;
  }

  /**
   * @param {string} domain
   * @param {string} identifier
   */
  async function deleteMapping(domain, identifier) {
    const state = await readState();
    if (state.domains[domain]) {
      delete state.domains[domain][identifier];
      if (Object.keys(state.domains[domain]).length === 0) {
        delete state.domains[domain];
      }
    }
    await writeState(state);
  }

  /**
   * @param {string} domain
   */
  async function resetDomain(domain) {
    const state = await readState();
    delete state.domains[domain];
    await writeState(state);
  }

  async function resetAll() {
    await writeState(emptyState());
  }

  async function exportMappings() {
    const state = await readState();
    return JSON.stringify(state, null, 2);
  }

  /**
   * @param {string} jsonText
   * @param {{ merge?: boolean }} [options] merge defaults to true (adds/overwrites
   *   entries without touching domains not present in the imported file).
   */
  async function importMappings(jsonText, options) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_error) {
      throw new Error("Invalid JSON file.");
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.domains !== "object" || parsed.domains === null) {
      throw new Error("This file does not contain field mappings.");
    }

    const merge = options?.merge !== false;
    if (!merge) {
      await writeState({ version: SCHEMA_VERSION, domains: parsed.domains });
      return;
    }

    const state = await readState();
    Object.keys(parsed.domains).forEach((domain) => {
      state.domains[domain] = { ...(state.domains[domain] || {}), ...(parsed.domains[domain] || {}) };
    });
    await writeState(state);
  }

  global.LJEFieldMapping = {
    PROFILE_FIELDS,
    PROFILE_FIELD_LABELS,
    normalizeText,
    buildFieldIdentifier,
    getDomain,
    getAllMappings,
    getDomainMappings,
    getMapping,
    saveMapping,
    setMappingDisabled,
    deleteMapping,
    resetDomain,
    resetAll,
    exportMappings,
    importMappings
  };
})(window);
