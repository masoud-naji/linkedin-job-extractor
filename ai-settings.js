/**
 * AI Assistant Settings — all configuration for the "Open in AI Chat"
 * workflow lives here: the prompt template, whether to include the
 * active profile's context, saved chat destinations, and the preferred
 * provider for starting a brand-new chat. chrome.storage.local only,
 * same local-only model as every other storage module in this
 * extension — no server, no sync.
 *
 * Deliberately knows nothing about the LinkedIn job object or the
 * profile schema — settings.js (the Settings page) and popup.js compose
 * this with ai-context.js's pure formatting helpers and profile-storage.js's
 * active profile to build the actual clipboard payload.
 *
 * Exposed as window.LJEAISettings (browser) / module.exports (tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.LJEAISettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const USE_DEFAULT_PROMPT_KEY = "ljeUseDefaultPrompt";
  const CUSTOM_PROMPT_KEY = "ljeCustomPrompt";
  const INCLUDE_CONTEXT_KEY = "ljeIncludeProfileContext";
  const PREFERRED_PROVIDER_KEY = "ljePreferredAIProvider";
  const DESTINATIONS_KEY = "ljeAIDestinations";

  const DEFAULT_PROMPT =
    "Review this job based on my background. Tell me how well it matches my experience, " +
    "identify important gaps, and help me answer job-application questions accurately " +
    "without exaggerating my experience.";

  // Used only as a fallback when no destination is configured/default —
  // "Open in AI Chat" then opens a brand-new chat on this provider instead.
  // Opening a plain https URL needs no host_permissions; nothing is injected
  // into these pages, so listing them here doesn't require touching the
  // manifest.
  const AI_PROVIDERS = [
    { id: "chatgpt", label: "ChatGPT", newChatUrl: "https://chatgpt.com/" },
    { id: "gemini", label: "Gemini", newChatUrl: "https://gemini.google.com/app" },
    { id: "claude", label: "Claude", newChatUrl: "https://claude.ai/new" }
  ];
  const DEFAULT_PROVIDER_ID = "chatgpt";

  function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `dest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getStorageValue(key, fallback) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError || result?.[key] === undefined) {
          resolve(fallback);
          return;
        }
        resolve(result[key]);
      });
    });
  }

  function setStorageValue(key, value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  // --- Prompt template ------------------------------------------------

  /** @returns {Promise<boolean>} default true */
  function getUseDefaultPrompt() {
    return getStorageValue(USE_DEFAULT_PROMPT_KEY, true);
  }

  /** @param {boolean} value */
  function setUseDefaultPrompt(value) {
    return setStorageValue(USE_DEFAULT_PROMPT_KEY, Boolean(value));
  }

  /** @returns {Promise<string>} default "" */
  function getCustomPrompt() {
    return getStorageValue(CUSTOM_PROMPT_KEY, "");
  }

  /** @param {string} value */
  function setCustomPrompt(value) {
    return setStorageValue(CUSTOM_PROMPT_KEY, String(value || ""));
  }

  /**
   * The prompt "Open in AI Chat" actually uses: the default unless the
   * user turned it off AND saved non-empty custom text.
   * @returns {Promise<string>}
   */
  async function getEffectivePrompt() {
    const useDefault = await getUseDefaultPrompt();
    if (useDefault) {
      return DEFAULT_PROMPT;
    }
    const custom = await getCustomPrompt();
    return custom.trim() ? custom : DEFAULT_PROMPT;
  }

  // --- Include profile context -----------------------------------------

  /** @returns {Promise<boolean>} default true */
  function getIncludeProfileContext() {
    return getStorageValue(INCLUDE_CONTEXT_KEY, true);
  }

  /** @param {boolean} value */
  function setIncludeProfileContext(value) {
    return setStorageValue(INCLUDE_CONTEXT_KEY, Boolean(value));
  }

  // --- New Chat provider (fallback when no destination is configured) --

  /** @returns {Promise<string>} an AI_PROVIDERS id, default 'chatgpt' */
  function getPreferredAIProvider() {
    return getStorageValue(PREFERRED_PROVIDER_KEY, DEFAULT_PROVIDER_ID);
  }

  /** @param {string} providerId */
  function setPreferredAIProvider(providerId) {
    return setStorageValue(PREFERRED_PROVIDER_KEY, providerId);
  }

  /**
   * @param {string} providerId
   * @returns {{ id: string, label: string, newChatUrl: string }}
   */
  function getProvider(providerId) {
    return AI_PROVIDERS.find((provider) => provider.id === providerId) || AI_PROVIDERS[0];
  }

  // --- AI destinations (user-managed, named conversation URLs) ---------

  function readDestinationsState() {
    return getStorageValue(DESTINATIONS_KEY, { destinations: [], defaultDestinationId: null });
  }

  /**
   * @returns {Promise<{ id: string, name: string, url: string }[]>}
   */
  async function getDestinations() {
    const state = await readDestinationsState();
    return Array.isArray(state.destinations) ? state.destinations : [];
  }

  /**
   * @param {{ name: string, url: string }} fields
   * @returns {Promise<object>} the created destination
   */
  async function addDestination(fields) {
    const state = await readDestinationsState();
    const destination = {
      id: generateId(),
      name: String((fields && fields.name) || "").trim(),
      url: String((fields && fields.url) || "").trim()
    };
    const destinations = [...(state.destinations || []), destination];
    const defaultDestinationId = state.defaultDestinationId || destination.id;
    await setStorageValue(DESTINATIONS_KEY, { destinations, defaultDestinationId });
    return destination;
  }

  /**
   * @param {string} id
   * @param {{ name?: string, url?: string }} patch
   */
  async function updateDestination(id, patch) {
    const state = await readDestinationsState();
    const destinations = (state.destinations || []).map((destination) =>
      destination.id === id ? { ...destination, ...patch, id: destination.id } : destination
    );
    await setStorageValue(DESTINATIONS_KEY, { ...state, destinations });
  }

  /**
   * @param {string} id
   */
  async function deleteDestination(id) {
    const state = await readDestinationsState();
    const destinations = (state.destinations || []).filter((destination) => destination.id !== id);
    const defaultDestinationId = state.defaultDestinationId === id
      ? (destinations[0] ? destinations[0].id : null)
      : state.defaultDestinationId;
    await setStorageValue(DESTINATIONS_KEY, { destinations, defaultDestinationId });
  }

  /**
   * @param {string} id
   */
  async function setDefaultDestination(id) {
    const state = await readDestinationsState();
    await setStorageValue(DESTINATIONS_KEY, { ...state, defaultDestinationId: id });
  }

  /**
   * @returns {Promise<object|null>} the default destination, or null if
   *   none is configured — the caller (popup.js) falls back to opening a
   *   brand-new chat on the preferred provider in that case.
   */
  async function getDefaultDestination() {
    const state = await readDestinationsState();
    const destinations = state.destinations || [];
    return destinations.find((destination) => destination.id === state.defaultDestinationId) || null;
  }

  return {
    DEFAULT_PROMPT,
    AI_PROVIDERS,
    DEFAULT_PROVIDER_ID,
    getUseDefaultPrompt,
    setUseDefaultPrompt,
    getCustomPrompt,
    setCustomPrompt,
    getEffectivePrompt,
    getIncludeProfileContext,
    setIncludeProfileContext,
    getPreferredAIProvider,
    setPreferredAIProvider,
    getProvider,
    getDestinations,
    addDestination,
    updateDestination,
    deleteDestination,
    setDefaultDestination,
    getDefaultDestination
  };
});
