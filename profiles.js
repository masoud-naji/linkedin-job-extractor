(() => {
  "use strict";

  const store = window.LJEProfileStore;

  const state = {
    profiles: [],
    activeId: null,
    selectedId: null
  };

  const el = {
    list: document.getElementById("profileList"),
    newBtn: document.getElementById("newProfile"),
    duplicateBtn: document.getElementById("duplicateProfile"),
    renameBtn: document.getElementById("renameProfile"),
    deleteBtn: document.getElementById("deleteProfile"),
    importBtn: document.getElementById("importProfile"),
    importFile: document.getElementById("importFile"),
    emptyState: document.getElementById("emptyState"),
    form: document.getElementById("profileForm"),
    activeTag: document.getElementById("activeTag"),
    setActiveBtn: document.getElementById("setActive"),
    exportBtn: document.getElementById("exportProfile"),
    fFullName: document.getElementById("fFullName"),
    fEmail: document.getElementById("fEmail"),
    fPhone: document.getElementById("fPhone"),
    fTitle: document.getElementById("fTitle"),
    fLocation: document.getElementById("fLocation"),
    fLinkedin: document.getElementById("fLinkedin"),
    fPortfolio: document.getElementById("fPortfolio"),
    fGithub: document.getElementById("fGithub"),
    fNotes: document.getElementById("fNotes"),
    fResumeJson: document.getElementById("fResumeJson"),
    loadResumeJsonBtn: document.getElementById("loadResumeJson"),
    resumeJsonFile: document.getElementById("resumeJsonFile"),
    fillFromResumeJsonBtn: document.getElementById("fillFromResumeJson"),
    pdfStatus: document.getElementById("pdfStatus"),
    pdfInput: document.getElementById("pdfInput"),
    pdfDownload: document.getElementById("pdfDownload"),
    removePdfBtn: document.getElementById("removePdf"),
    saveStatus: document.getElementById("saveStatus")
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindEvents();
    await refresh();
  }

  function bindEvents() {
    el.newBtn.addEventListener("click", handleNewProfile);
    el.duplicateBtn.addEventListener("click", handleDuplicateProfile);
    el.renameBtn.addEventListener("click", handleRenameProfile);
    el.deleteBtn.addEventListener("click", handleDeleteProfile);
    el.importBtn.addEventListener("click", () => el.importFile.click());
    el.importFile.addEventListener("change", handleImportFile);
    el.setActiveBtn.addEventListener("click", handleSetActive);
    el.exportBtn.addEventListener("click", handleExport);
    el.pdfInput.addEventListener("change", handlePdfChange);
    el.removePdfBtn.addEventListener("click", handleRemovePdf);
    el.loadResumeJsonBtn.addEventListener("click", () => el.resumeJsonFile.click());
    el.resumeJsonFile.addEventListener("change", handleResumeJsonFile);
    el.fillFromResumeJsonBtn.addEventListener("click", handleFillFromResumeJson);
    el.form.addEventListener("submit", handleSaveForm);
  }

  /**
   * @param {string} [selectId]
   */
  async function refresh(selectId) {
    state.profiles = await store.getAllProfiles();
    state.activeId = await store.getActiveProfileId();

    const preferredId = selectId || state.selectedId;
    state.selectedId = state.profiles.some((profile) => profile.id === preferredId)
      ? preferredId
      : (state.profiles[0]?.id || null);

    renderList();
    renderDetail();
  }

  function renderList() {
    el.list.textContent = "";

    state.profiles.forEach((profile) => {
      const item = document.createElement("li");
      item.className = "profile-item" + (profile.id === state.selectedId ? " selected" : "");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-item-button";
      button.addEventListener("click", () => selectProfile(profile.id));

      const nameSpan = document.createElement("span");
      nameSpan.textContent = profile.name;
      button.appendChild(nameSpan);

      if (profile.id === state.activeId) {
        const badge = document.createElement("span");
        badge.className = "badge-active";
        badge.textContent = "Active";
        button.appendChild(badge);
      }

      item.appendChild(button);
      el.list.appendChild(item);
    });

    const hasSelection = Boolean(state.selectedId);
    el.duplicateBtn.disabled = !hasSelection;
    el.renameBtn.disabled = !hasSelection;
    el.deleteBtn.disabled = !hasSelection;
  }

  function getSelectedProfile() {
    return state.profiles.find((profile) => profile.id === state.selectedId) || null;
  }

  function selectProfile(id) {
    state.selectedId = id;
    renderList();
    renderDetail();
  }

  function renderDetail() {
    const profile = getSelectedProfile();
    if (!profile) {
      el.emptyState.classList.remove("hidden");
      el.form.classList.add("hidden");
      return;
    }

    el.emptyState.classList.add("hidden");
    el.form.classList.remove("hidden");

    el.activeTag.hidden = profile.id !== state.activeId;
    el.setActiveBtn.disabled = profile.id === state.activeId;

    el.fFullName.value = profile.fullName || "";
    el.fEmail.value = profile.email || "";
    el.fPhone.value = profile.phone || "";
    el.fTitle.value = profile.currentTitle || "";
    el.fLocation.value = profile.location || "";
    el.fLinkedin.value = profile.linkedinUrl || "";
    el.fPortfolio.value = profile.portfolioUrl || "";
    el.fGithub.value = profile.githubUrl || "";
    el.fNotes.value = profile.notes || "";
    el.fResumeJson.value = profile.resumeJson || "";

    renderPdfStatus(profile);
    el.saveStatus.textContent = "";
  }

  /**
   * @param {object} profile
   */
  function renderPdfStatus(profile) {
    if (profile.resumePdf && profile.resumePdf.dataUrl) {
      const sizeKb = Math.round((profile.resumePdf.size || 0) / 1024);
      el.pdfStatus.textContent = `${profile.resumePdf.fileName} (${sizeKb} KB)`;
      el.pdfDownload.href = profile.resumePdf.dataUrl;
      el.pdfDownload.download = profile.resumePdf.fileName || "resume.pdf";
      el.pdfDownload.classList.remove("hidden");
      el.removePdfBtn.classList.remove("hidden");
    } else {
      el.pdfStatus.textContent = "No PDF attached.";
      el.pdfDownload.classList.add("hidden");
      el.removePdfBtn.classList.add("hidden");
    }
  }

  async function handleNewProfile() {
    const name = window.prompt("Profile name (e.g. React, AEM, AI):", "New Profile");
    if (!name || !name.trim()) {
      return;
    }
    const profile = await store.createProfile({ name: name.trim() });
    await refresh(profile.id);
  }

  async function handleDuplicateProfile() {
    const profile = getSelectedProfile();
    if (!profile) {
      return;
    }
    const name = window.prompt("Name for the duplicated profile:", `${profile.name} copy`);
    if (!name || !name.trim()) {
      return;
    }
    const copy = await store.duplicateProfile(profile.id, name.trim());
    await refresh(copy.id);
  }

  async function handleRenameProfile() {
    const profile = getSelectedProfile();
    if (!profile) {
      return;
    }
    const name = window.prompt("New profile name:", profile.name);
    if (!name || !name.trim() || name.trim() === profile.name) {
      return;
    }
    await store.renameProfile(profile.id, name.trim());
    await refresh(profile.id);
  }

  async function handleDeleteProfile() {
    const profile = getSelectedProfile();
    if (!profile) {
      return;
    }
    const confirmed = window.confirm(`Delete profile "${profile.name}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    await store.deleteProfile(profile.id);
    await refresh();
  }

  async function handleSetActive() {
    const profile = getSelectedProfile();
    if (!profile) {
      return;
    }
    await store.setActiveProfileId(profile.id);
    await refresh(profile.id);
  }

  function handleExport() {
    const profile = getSelectedProfile();
    if (!profile) {
      return;
    }
    const json = store.exportProfile(profile);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(profile.name)}-profile.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * @param {Event} event
   */
  async function handleImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_error) {
        throw new Error("Invalid JSON file.");
      }

      if (parsed && typeof parsed === "object" && Array.isArray(parsed.profiles)) {
        const created = await store.importProfilesBundle(text);
        await refresh(created[created.length - 1].id);
        window.alert(`Imported ${created.length} profile(s): ${created.map((profile) => profile.name).join(", ")}.`);
      } else {
        const profile = await store.importProfile(text);
        await refresh(profile.id);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Import failed.");
    }
  }

  /**
   * @param {Event} event
   */
  async function handlePdfChange(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const profile = getSelectedProfile();
    if (!file || !profile) {
      return;
    }

    if (file.type !== "application/pdf") {
      window.alert("Please choose a PDF file.");
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      await store.updateProfile(profile.id, {
        resumePdf: { fileName: file.name, mimeType: file.type, size: file.size, dataUrl }
      });
      await refresh(profile.id);
    } catch (error) {
      window.alert(getStorageErrorMessage(error));
    }
  }

  /**
   * @param {Event} event
   */
  async function handleResumeJsonFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      el.fResumeJson.value = text;
      el.saveStatus.textContent = "Loaded from file. Click Save changes to keep it.";
    } catch (_error) {
      window.alert("Could not read that file.");
    }
  }

  /**
   * Explicit, non-AI key lookup for common resume JSON shapes (e.g. JSON Resume's
   * `basics` block, or a flatter custom shape). Only returns fields it actually found.
   * @param {unknown} parsed
   * @returns {object}
   */
  function mapResumeJsonToFields(parsed) {
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const basics = parsed.basics && typeof parsed.basics === "object" ? parsed.basics : null;
    const personal = parsed.personal && typeof parsed.personal === "object" ? parsed.personal : null;
    const links = parsed.links && typeof parsed.links === "object" ? parsed.links : null;
    const profiles = Array.isArray(basics?.profiles)
      ? basics.profiles
      : Array.isArray(parsed.profiles)
        ? parsed.profiles
        : [];

    const result = {};

    const fullName = firstNonEmptyString(basics?.name, personal?.fullName, parsed.fullName, parsed.name);
    if (fullName) result.fullName = fullName;

    const email = firstNonEmptyString(basics?.email, personal?.email, parsed.email);
    if (email) result.email = email;

    const phone = firstNonEmptyString(basics?.phone, personal?.phone, parsed.phone);
    if (phone) result.phone = phone;

    const currentTitle = firstNonEmptyString(
      basics?.label,
      personal?.currentTitle,
      parsed.currentTitle,
      parsed.title,
      parsed.position
    );
    if (currentTitle) result.currentTitle = currentTitle;

    const location = firstNonEmptyString(
      formatLocation(basics?.location),
      personal?.location,
      typeof parsed.location === "string" ? parsed.location : formatLocation(parsed.location)
    );
    if (location) result.location = location;

    const linkedinUrl = firstNonEmptyString(
      findProfileUrl(profiles, /linkedin/i),
      basics?.linkedin,
      links?.linkedin,
      parsed.linkedinUrl,
      parsed.linkedin
    );
    if (linkedinUrl) result.linkedinUrl = linkedinUrl;

    const githubUrl = firstNonEmptyString(
      findProfileUrl(profiles, /github/i),
      basics?.github,
      links?.github,
      parsed.githubUrl,
      parsed.github
    );
    if (githubUrl) result.githubUrl = githubUrl;

    const portfolioUrl = firstNonEmptyString(
      basics?.url,
      basics?.website,
      links?.portfolio,
      parsed.portfolioUrl,
      parsed.website,
      parsed.portfolio
    );
    if (portfolioUrl) result.portfolioUrl = portfolioUrl;

    return result;
  }

  /**
   * @param {...unknown} values
   * @returns {string}
   */
  function firstNonEmptyString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  }

  /**
   * @param {unknown} location
   * @returns {string}
   */
  function formatLocation(location) {
    if (!location || typeof location !== "object") {
      return "";
    }
    return [location.city, location.region, location.countryCode || location.country]
      .filter((part) => typeof part === "string" && part.trim())
      .join(", ");
  }

  /**
   * @param {unknown[]} profiles
   * @param {RegExp} networkPattern
   * @returns {string}
   */
  function findProfileUrl(profiles, networkPattern) {
    const match = profiles.find(
      (profile) => profile && typeof profile === "object" && networkPattern.test(String(profile.network || ""))
    );
    return match && typeof match.url === "string" ? match.url : "";
  }

  function handleFillFromResumeJson() {
    const raw = el.fResumeJson.value;
    if (!raw || !raw.trim()) {
      window.alert("Resume JSON is empty.");
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      window.alert("Resume JSON is not valid JSON, so fields can't be extracted from it.");
      return;
    }

    if (parsed && typeof parsed === "object" && Array.isArray(parsed.profiles)) {
      window.alert(
        "This looks like a multi-profile file (it has a top-level \"profiles\" list), not a single profile's data. " +
          "Use the \"Import JSON\" button in the sidebar instead — it creates one profile per entry."
      );
      return;
    }

    const mapped = mapResumeJsonToFields(parsed);
    const fieldInputs = {
      fullName: el.fFullName,
      email: el.fEmail,
      phone: el.fPhone,
      currentTitle: el.fTitle,
      location: el.fLocation,
      linkedinUrl: el.fLinkedin,
      portfolioUrl: el.fPortfolio,
      githubUrl: el.fGithub
    };

    const filled = [];
    const skipped = [];

    Object.entries(mapped).forEach(([key, value]) => {
      const input = fieldInputs[key];
      if (!input) {
        return;
      }
      if (input.value.trim()) {
        skipped.push(key);
      } else {
        input.value = value;
        filled.push(key);
      }
    });

    if (!filled.length && !skipped.length) {
      el.saveStatus.textContent = "No recognizable fields found in Resume JSON.";
      return;
    }

    const parts = [];
    if (filled.length) {
      parts.push(`Filled: ${filled.join(", ")}.`);
    }
    if (skipped.length) {
      parts.push(`Already set, left unchanged: ${skipped.join(", ")}.`);
    }
    parts.push("Click Save changes to keep it.");
    el.saveStatus.textContent = parts.join(" ");
  }

  async function handleRemovePdf() {
    const profile = getSelectedProfile();
    if (!profile) {
      return;
    }
    await store.updateProfile(profile.id, { resumePdf: null });
    await refresh(profile.id);
  }

  /**
   * @param {Event} event
   */
  async function handleSaveForm(event) {
    event.preventDefault();
    const profile = getSelectedProfile();
    if (!profile) {
      return;
    }

    try {
      await store.updateProfile(profile.id, {
        fullName: el.fFullName.value.trim(),
        email: el.fEmail.value.trim(),
        phone: el.fPhone.value.trim(),
        currentTitle: el.fTitle.value.trim(),
        location: el.fLocation.value.trim(),
        linkedinUrl: el.fLinkedin.value.trim(),
        portfolioUrl: el.fPortfolio.value.trim(),
        githubUrl: el.fGithub.value.trim(),
        notes: el.fNotes.value,
        resumeJson: el.fResumeJson.value
      });
      el.saveStatus.textContent = "Saved.";
      window.setTimeout(() => {
        el.saveStatus.textContent = "";
      }, 1500);
      await refresh(profile.id);
    } catch (error) {
      el.saveStatus.textContent = getStorageErrorMessage(error);
    }
  }

  /**
   * @param {File} file
   * @returns {Promise<string>}
   */
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read file."));
      reader.readAsDataURL(file);
    });
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function slugify(value) {
    return (
      String(value || "profile")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "profile"
    );
  }

  /**
   * @param {unknown} error
   * @returns {string}
   */
  function getStorageErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (/quota/i.test(message)) {
      return "Storage limit reached. Try a smaller PDF or remove another profile's file.";
    }
    return message || "Something went wrong.";
  }
})();
