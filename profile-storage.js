/**
 * Local-only CRUD storage for resume profiles.
 * Uses chrome.storage.local exclusively. No sync, no network, no parsing.
 * Exposed as window.LJEProfileStore so future phases (e.g. autofill) can reuse it.
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "ljeProfiles";
  const SCHEMA_VERSION = 1;

  function generateId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function emptyState() {
    return { version: SCHEMA_VERSION, activeProfileId: null, profiles: {} };
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
          activeProfileId: stored.activeProfileId || null,
          profiles: { ...(stored.profiles || {}) }
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
   * @param {object} [overrides]
   */
  function emptyProfile(overrides) {
    const now = new Date().toISOString();
    return {
      id: generateId(),
      name: "New Profile",
      fullName: "",
      email: "",
      phone: "",
      linkedinUrl: "",
      portfolioUrl: "",
      githubUrl: "",
      currentTitle: "",
      location: "",
      notes: "",
      resumeJson: "",
      resumePdf: null,
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
  }

  async function getAllProfiles() {
    const state = await readState();
    return Object.values(state.profiles).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getProfile(id) {
    const state = await readState();
    return state.profiles[id] || null;
  }

  async function getActiveProfileId() {
    const state = await readState();
    return state.activeProfileId;
  }

  async function getActiveProfile() {
    const state = await readState();
    if (!state.activeProfileId) {
      return null;
    }
    return state.profiles[state.activeProfileId] || null;
  }

  async function setActiveProfileId(id) {
    const state = await readState();
    if (id !== null && !state.profiles[id]) {
      throw new Error("Profile not found.");
    }
    state.activeProfileId = id;
    await writeState(state);
    return id;
  }

  /**
   * @param {object} [fields]
   */
  async function createProfile(fields) {
    const state = await readState();
    const profile = emptyProfile(fields);
    state.profiles[profile.id] = profile;
    if (!state.activeProfileId) {
      state.activeProfileId = profile.id;
    }
    await writeState(state);
    return profile;
  }

  /**
   * @param {string} id
   * @param {object} patch
   */
  async function updateProfile(id, patch) {
    const state = await readState();
    const existing = state.profiles[id];
    if (!existing) {
      throw new Error("Profile not found.");
    }
    const updated = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    };
    state.profiles[id] = updated;
    await writeState(state);
    return updated;
  }

  async function renameProfile(id, newName) {
    return updateProfile(id, { name: newName });
  }

  async function duplicateProfile(id, newName) {
    const state = await readState();
    const existing = state.profiles[id];
    if (!existing) {
      throw new Error("Profile not found.");
    }
    const now = new Date().toISOString();
    const copy = {
      ...existing,
      id: generateId(),
      name: newName || `${existing.name} copy`,
      createdAt: now,
      updatedAt: now
    };
    state.profiles[copy.id] = copy;
    await writeState(state);
    return copy;
  }

  async function deleteProfile(id) {
    const state = await readState();
    if (!state.profiles[id]) {
      return;
    }
    delete state.profiles[id];
    if (state.activeProfileId === id) {
      const remaining = Object.keys(state.profiles);
      state.activeProfileId = remaining.length ? remaining[0] : null;
    }
    await writeState(state);
  }

  /**
   * @param {object} profile
   * @returns {string}
   */
  function exportProfile(profile) {
    return JSON.stringify(profile, null, 2);
  }

  /**
   * @param {string} jsonText
   */
  async function importProfile(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_error) {
      throw new Error("Invalid JSON file.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid profile data.");
    }

    const now = new Date().toISOString();
    const profile = emptyProfile({
      ...parsed,
      id: generateId(),
      createdAt: now,
      updatedAt: now
    });

    const state = await readState();
    state.profiles[profile.id] = profile;
    if (!state.activeProfileId) {
      state.activeProfileId = profile.id;
    }
    await writeState(state);
    return profile;
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function asString(value) {
    return typeof value === "string" ? value : "";
  }

  /**
   * Maps one entry of a { profiles: [...] } bundle (personal/links/documents
   * nested shape) onto this extension's flat profile fields. Explicit key
   * lookup only, no parsing of the resume content itself.
   * @param {object} entry
   */
  function normalizeBundleEntry(entry) {
    const personal = entry.personal && typeof entry.personal === "object" ? entry.personal : {};
    const links = entry.links && typeof entry.links === "object" ? entry.links : {};
    const documents = entry.documents && typeof entry.documents === "object" ? entry.documents : {};

    return {
      name: asString(entry.name).trim() || "Imported Profile",
      fullName: asString(personal.fullName),
      email: asString(personal.email),
      phone: asString(personal.phone),
      location: asString(personal.location),
      currentTitle: asString(personal.currentTitle),
      linkedinUrl: asString(links.linkedin),
      portfolioUrl: asString(links.portfolio),
      githubUrl: asString(links.github),
      notes: asString(entry.notes),
      resumeJson: documents.resumeJson !== undefined ? JSON.stringify(documents.resumeJson, null, 2) : ""
    };
  }

  /**
   * Imports every entry from a { profiles: [...] } bundle as its own profile.
   * @param {string} jsonText
   * @returns {Promise<object[]>}
   */
  async function importProfilesBundle(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_error) {
      throw new Error("Invalid JSON file.");
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.profiles)) {
      throw new Error("This file does not contain a profiles list.");
    }

    const now = new Date().toISOString();
    const state = await readState();
    const created = [];

    parsed.profiles.forEach((entry) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const profile = emptyProfile({
        ...normalizeBundleEntry(entry),
        id: generateId(),
        createdAt: now,
        updatedAt: now
      });
      state.profiles[profile.id] = profile;
      created.push(profile);
    });

    if (!created.length) {
      throw new Error("No valid profiles found in file.");
    }

    if (!state.activeProfileId) {
      state.activeProfileId = created[0].id;
    }

    await writeState(state);
    return created;
  }

  global.LJEProfileStore = {
    getAllProfiles,
    getProfile,
    getActiveProfile,
    getActiveProfileId,
    setActiveProfileId,
    createProfile,
    updateProfile,
    renameProfile,
    duplicateProfile,
    deleteProfile,
    exportProfile,
    importProfile,
    importProfilesBundle,
    emptyProfile
  };
})(window);
