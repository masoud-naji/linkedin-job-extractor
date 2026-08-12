(() => {
  "use strict";

  const STORAGE_KEY = "theme";
  const CACHE_KEY = "lje-theme";
  const THEMES = ["light", "dark", "system"];
  const DEFAULT_THEME = "system";

  const media = window.matchMedia("(prefers-color-scheme: dark)");

  /**
   * @param {string} mode
   * @returns {"light"|"dark"}
   */
  function resolve(mode) {
    if (mode === "light" || mode === "dark") {
      return mode;
    }
    return media.matches ? "dark" : "light";
  }

  /**
   * @param {string} mode
   */
  function apply(mode) {
    document.documentElement.setAttribute("data-theme", resolve(mode));
  }

  function readCache() {
    try {
      const cached = window.localStorage.getItem(CACHE_KEY);
      return THEMES.includes(cached) ? cached : DEFAULT_THEME;
    } catch (err) {
      return DEFAULT_THEME;
    }
  }

  /**
   * @param {string} mode
   */
  function writeCache(mode) {
    try {
      window.localStorage.setItem(CACHE_KEY, mode);
    } catch (err) {
      // localStorage unavailable; storage.local remains source of truth.
    }
  }

  let currentMode = readCache();
  apply(currentMode);

  chrome.storage.local.get(STORAGE_KEY, (result) => {
    const stored = result && THEMES.includes(result[STORAGE_KEY]) ? result[STORAGE_KEY] : DEFAULT_THEME;
    if (stored !== currentMode) {
      currentMode = stored;
      writeCache(stored);
      apply(stored);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      currentMode = THEMES.includes(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : DEFAULT_THEME;
      writeCache(currentMode);
      apply(currentMode);
    }
  });

  media.addEventListener("change", () => {
    if (currentMode === "system") {
      apply(currentMode);
    }
  });

  window.LJETheme = {
    THEMES,
    DEFAULT_THEME,
    get: () => new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        resolve(result && THEMES.includes(result[STORAGE_KEY]) ? result[STORAGE_KEY] : DEFAULT_THEME);
      });
    }),
    set: (mode) => {
      const next = THEMES.includes(mode) ? mode : DEFAULT_THEME;
      currentMode = next;
      writeCache(next);
      apply(next);
      return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: next }, resolve);
      });
    }
  };
})();
