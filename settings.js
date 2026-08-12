(() => {
  "use strict";

  const settings = window.LJEAISettings;
  const theme = window.LJETheme;

  const el = {
    themeSelect: document.getElementById("themeSelect"),
    useDefaultPromptToggle: document.getElementById("useDefaultPromptToggle"),
    promptTextarea: document.getElementById("promptTextarea"),
    savePromptBtn: document.getElementById("savePromptBtn"),
    promptStatus: document.getElementById("promptStatus"),
    includeContextToggle: document.getElementById("includeContextToggle"),
    destinationsEmptyState: document.getElementById("destinationsEmptyState"),
    destinationList: document.getElementById("destinationList"),
    destNameInput: document.getElementById("destNameInput"),
    destUrlInput: document.getElementById("destUrlInput"),
    addDestinationBtn: document.getElementById("addDestinationBtn"),
    newChatProviderSelect: document.getElementById("newChatProviderSelect")
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    populateProviderSelect();
    bindEvents();
    await Promise.all([loadThemeSection(), loadPromptSection(), loadIncludeContextSection(), loadProviderSection(), loadDestinations()]);
  }

  async function loadThemeSection() {
    el.themeSelect.value = await theme.get();
  }

  async function handleThemeChange() {
    await theme.set(el.themeSelect.value);
  }

  function bindEvents() {
    el.themeSelect.addEventListener("change", handleThemeChange);
    el.useDefaultPromptToggle.addEventListener("change", handleToggleUseDefaultPrompt);
    el.savePromptBtn.addEventListener("click", handleSavePrompt);
    el.includeContextToggle.addEventListener("change", handleToggleIncludeContext);
    el.newChatProviderSelect.addEventListener("change", handleProviderChange);
    el.addDestinationBtn.addEventListener("click", handleAddDestination);
  }

  function populateProviderSelect() {
    el.newChatProviderSelect.textContent = "";
    settings.AI_PROVIDERS.forEach((provider) => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      el.newChatProviderSelect.appendChild(option);
    });
  }

  async function loadPromptSection() {
    const useDefault = await settings.getUseDefaultPrompt();
    const customPrompt = await settings.getCustomPrompt();
    el.useDefaultPromptToggle.checked = useDefault;
    el.promptTextarea.value = useDefault ? settings.DEFAULT_PROMPT : (customPrompt || settings.DEFAULT_PROMPT);
    setPromptEditable(!useDefault);
  }

  /**
   * @param {boolean} editable
   */
  function setPromptEditable(editable) {
    el.promptTextarea.disabled = !editable;
    el.savePromptBtn.disabled = !editable;
  }

  async function handleToggleUseDefaultPrompt() {
    const useDefault = el.useDefaultPromptToggle.checked;
    await settings.setUseDefaultPrompt(useDefault);
    if (useDefault) {
      el.promptTextarea.value = settings.DEFAULT_PROMPT;
      setPromptEditable(false);
    } else {
      const customPrompt = await settings.getCustomPrompt();
      el.promptTextarea.value = customPrompt || settings.DEFAULT_PROMPT;
      setPromptEditable(true);
    }
    setPromptStatus("");
  }

  async function handleSavePrompt() {
    await settings.setCustomPrompt(el.promptTextarea.value);
    setPromptStatus("Saved.");
  }

  /**
   * @param {string} message
   */
  function setPromptStatus(message) {
    el.promptStatus.textContent = message;
    if (message) {
      window.setTimeout(() => {
        if (el.promptStatus.textContent === message) {
          el.promptStatus.textContent = "";
        }
      }, 1500);
    }
  }

  async function loadIncludeContextSection() {
    el.includeContextToggle.checked = await settings.getIncludeProfileContext();
  }

  async function handleToggleIncludeContext() {
    await settings.setIncludeProfileContext(el.includeContextToggle.checked);
  }

  async function loadProviderSection() {
    el.newChatProviderSelect.value = await settings.getPreferredAIProvider();
  }

  async function handleProviderChange() {
    await settings.setPreferredAIProvider(el.newChatProviderSelect.value);
  }

  async function loadDestinations() {
    const [destinations, defaultDestination] = await Promise.all([
      settings.getDestinations(),
      settings.getDefaultDestination()
    ]);
    renderDestinations(destinations, defaultDestination ? defaultDestination.id : null);
  }

  /**
   * @param {object[]} destinations
   * @param {string|null} defaultId
   */
  function renderDestinations(destinations, defaultId) {
    el.destinationList.textContent = "";

    if (!destinations.length) {
      el.destinationsEmptyState.classList.remove("hidden");
      return;
    }
    el.destinationsEmptyState.classList.add("hidden");

    destinations.forEach((destination) => {
      el.destinationList.appendChild(buildDestinationItem(destination, destination.id === defaultId));
    });
  }

  /**
   * @param {{ id: string, name: string, url: string }} destination
   * @param {boolean} isDefault
   * @returns {HTMLLIElement}
   */
  function buildDestinationItem(destination, isDefault) {
    const li = document.createElement("li");
    li.className = "destination-item";

    const info = document.createElement("div");
    info.className = "destination-info";

    const name = document.createElement("div");
    name.className = "destination-name";
    name.textContent = destination.name || "Untitled";
    if (isDefault) {
      const badge = document.createElement("span");
      badge.className = "badge-default";
      badge.textContent = "Default";
      name.appendChild(badge);
    }
    info.appendChild(name);

    const url = document.createElement("div");
    url.className = "destination-url";
    url.textContent = destination.url;
    url.title = destination.url;
    info.appendChild(url);

    const actions = document.createElement("div");
    actions.className = "destination-actions";

    if (!isDefault) {
      const setDefaultBtn = document.createElement("button");
      setDefaultBtn.type = "button";
      setDefaultBtn.className = "secondary";
      setDefaultBtn.textContent = "Set Default";
      setDefaultBtn.addEventListener("click", () => handleSetDefaultDestination(destination.id));
      actions.appendChild(setDefaultBtn);
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => handleEditDestination(destination));
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => handleDeleteDestination(destination));
    actions.appendChild(deleteBtn);

    li.appendChild(info);
    li.appendChild(actions);
    return li;
  }

  async function handleAddDestination() {
    const name = el.destNameInput.value.trim();
    const url = el.destUrlInput.value.trim();
    if (!name || !url) {
      window.alert("Both a name and a URL are required.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      window.alert("The destination URL must start with http:// or https://.");
      return;
    }
    await settings.addDestination({ name, url });
    el.destNameInput.value = "";
    el.destUrlInput.value = "";
    await loadDestinations();
  }

  /**
   * @param {{ id: string, name: string, url: string }} destination
   */
  async function handleEditDestination(destination) {
    const name = window.prompt("Destination name:", destination.name);
    if (name === null || !name.trim()) {
      return;
    }
    const url = window.prompt("Destination URL:", destination.url);
    if (url === null || !url.trim()) {
      return;
    }
    await settings.updateDestination(destination.id, { name: name.trim(), url: url.trim() });
    await loadDestinations();
  }

  /**
   * @param {{ id: string, name: string }} destination
   */
  async function handleDeleteDestination(destination) {
    if (!window.confirm(`Delete destination "${destination.name}"?`)) {
      return;
    }
    await settings.deleteDestination(destination.id);
    await loadDestinations();
  }

  /**
   * @param {string} id
   */
  async function handleSetDefaultDestination(id) {
    await settings.setDefaultDestination(id);
    await loadDestinations();
  }
})();
