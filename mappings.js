(() => {
  "use strict";

  const state = {
    domains: {},
    selectedDomain: null,
    searchQuery: ""
  };

  const elements = {
    searchInput: document.getElementById("searchInput"),
    exportAll: document.getElementById("exportAll"),
    importAll: document.getElementById("importAll"),
    importFile: document.getElementById("importFile"),
    resetAll: document.getElementById("resetAll"),
    statusMessage: document.getElementById("statusMessage"),
    domainList: document.getElementById("domainList"),
    domainHeader: document.getElementById("domainHeader"),
    domainTitle: document.getElementById("domainTitle"),
    resetDomain: document.getElementById("resetDomain"),
    emptyState: document.getElementById("emptyState"),
    mappingTable: document.getElementById("mappingTable"),
    mappingTableBody: document.getElementById("mappingTableBody")
  };

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    load();
  });

  function bindEvents() {
    elements.searchInput.addEventListener("input", () => {
      state.searchQuery = elements.searchInput.value.trim().toLowerCase();
      renderTable();
    });
    elements.exportAll.addEventListener("click", handleExportAll);
    elements.importAll.addEventListener("click", () => elements.importFile.click());
    elements.importFile.addEventListener("change", handleImportFile);
    elements.resetAll.addEventListener("click", handleResetAll);
    elements.resetDomain.addEventListener("click", handleResetDomain);
  }

  async function load() {
    try {
      state.domains = await window.LJEFieldMapping.getAllMappings();
    } catch (_error) {
      state.domains = {};
      showStatus("Could not load field mappings.");
    }
    if (state.selectedDomain && !state.domains[state.selectedDomain]) {
      state.selectedDomain = null;
    }
    renderDomainList();
    renderTable();
  }

  function renderDomainList() {
    elements.domainList.textContent = "";

    const domains = Object.keys(state.domains).sort((a, b) => a.localeCompare(b));

    const allItem = document.createElement("li");
    allItem.className = `domain-item${state.selectedDomain === null ? " selected" : ""}`;
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = "domain-item-button";
    const totalCount = domains.reduce((sum, domain) => sum + Object.keys(state.domains[domain]).length, 0);
    allButton.innerHTML = "";
    const allLabel = document.createElement("span");
    allLabel.textContent = "All domains";
    const allPill = document.createElement("span");
    allPill.className = "count-pill";
    allPill.textContent = String(totalCount);
    allButton.appendChild(allLabel);
    allButton.appendChild(allPill);
    allButton.addEventListener("click", () => {
      state.selectedDomain = null;
      renderDomainList();
      renderTable();
    });
    allItem.appendChild(allButton);
    elements.domainList.appendChild(allItem);

    domains.forEach((domain) => {
      const item = document.createElement("li");
      item.className = `domain-item${state.selectedDomain === domain ? " selected" : ""}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "domain-item-button";
      const label = document.createElement("span");
      label.textContent = domain;
      const pill = document.createElement("span");
      pill.className = "count-pill";
      pill.textContent = String(Object.keys(state.domains[domain]).length);
      button.appendChild(label);
      button.appendChild(pill);
      button.addEventListener("click", () => {
        state.selectedDomain = domain;
        renderDomainList();
        renderTable();
      });
      item.appendChild(button);
      elements.domainList.appendChild(item);
    });
  }

  /**
   * @param {object} mapping
   * @returns {string}
   */
  function describeMappingTarget(mapping) {
    if (mapping.type === "static") {
      return mapping.value || "";
    }
    if (mapping.type === "profile") {
      return window.LJEFieldMapping.PROFILE_FIELD_LABELS[mapping.profileField] || mapping.profileField || "";
    }
    return "skip";
  }

  /**
   * @returns {Array<{ domain: string, identifier: string, mapping: object }>}
   */
  function getFilteredRows() {
    const rows = [];
    const domains = state.selectedDomain ? [state.selectedDomain] : Object.keys(state.domains);

    domains.forEach((domain) => {
      const identifiers = state.domains[domain] || {};
      Object.keys(identifiers).forEach((identifier) => {
        rows.push({ domain, identifier, mapping: identifiers[identifier] });
      });
    });

    if (!state.searchQuery) {
      return rows;
    }

    return rows.filter(({ domain, identifier, mapping }) => {
      const targetLabel = describeMappingTarget(mapping);
      const haystack = [domain, identifier, mapping.label, targetLabel, mapping.source, mapping.type].join(" ").toLowerCase();
      return haystack.includes(state.searchQuery);
    });
  }

  function renderTable() {
    elements.domainHeader.classList.toggle("hidden", !state.selectedDomain);
    if (state.selectedDomain) {
      elements.domainTitle.textContent = state.selectedDomain;
    }

    const rows = getFilteredRows();
    elements.mappingTableBody.textContent = "";

    if (rows.length === 0) {
      elements.mappingTable.classList.add("hidden");
      elements.emptyState.classList.remove("hidden");
      elements.emptyState.textContent = Object.keys(state.domains).length
        ? "No mappings match your search or filter."
        : "No field mappings yet. Mappings are created automatically as the Application Assistant recognizes fields, or when you confirm an ambiguous one.";
      return;
    }

    elements.mappingTable.classList.remove("hidden");
    elements.emptyState.classList.add("hidden");

    rows
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.identifier.localeCompare(b.identifier))
      .forEach((row) => elements.mappingTableBody.appendChild(buildRow(row)));
  }

  /**
   * @param {{ domain: string, identifier: string, mapping: object }} row
   */
  function buildRow(row) {
    const { domain, identifier, mapping } = row;
    const tr = document.createElement("tr");

    const domainCell = document.createElement("td");
    domainCell.className = "domain-cell";
    domainCell.textContent = domain;
    tr.appendChild(domainCell);

    const fieldCell = document.createElement("td");
    fieldCell.className = "field-cell";
    const strong = document.createElement("strong");
    strong.textContent = mapping.label || identifier;
    fieldCell.appendChild(strong);
    if (mapping.label && mapping.label.toLowerCase() !== identifier) {
      const small = document.createElement("span");
      small.className = "domain-cell";
      small.textContent = identifier;
      fieldCell.appendChild(small);
    }
    tr.appendChild(fieldCell);

    const mapsToCell = document.createElement("td");
    const select = document.createElement("select");
    const skipOption = document.createElement("option");
    skipOption.value = "__skip__";
    skipOption.textContent = "Skip — never fill this field";
    select.appendChild(skipOption);
    window.LJEFieldMapping.PROFILE_FIELDS.forEach(({ key, label }) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      select.appendChild(option);
    });
    const staticOption = document.createElement("option");
    staticOption.value = "__static__";
    staticOption.textContent = "Custom value…";
    select.appendChild(staticOption);

    select.value = mapping.type === "static" ? "__static__" : mapping.type === "profile" ? mapping.profileField : "__skip__";

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.className = "mapsto-value";
    valueInput.placeholder = "Custom value";
    valueInput.value = mapping.type === "static" ? mapping.value || "" : "";
    valueInput.classList.toggle("hidden", mapping.type !== "static");

    select.addEventListener("change", () => {
      const val = select.value;
      if (val === "__static__") {
        valueInput.classList.remove("hidden");
        valueInput.focus();
        return;
      }
      valueInput.classList.add("hidden");
      const type = val === "__skip__" ? "skip" : "profile";
      const profileField = type === "profile" ? val : undefined;
      handleChangeMapping(domain, identifier, { type, profileField });
    });

    valueInput.addEventListener("change", () => {
      handleChangeMapping(domain, identifier, { type: "static", value: valueInput.value });
    });

    mapsToCell.appendChild(select);
    mapsToCell.appendChild(valueInput);
    tr.appendChild(mapsToCell);

    const sourceCell = document.createElement("td");
    const sourcePill = document.createElement("span");
    sourcePill.className = `pill source-${mapping.source === "auto" ? "auto" : "user"}`;
    sourcePill.textContent = mapping.source === "auto" ? "Auto" : "Manual";
    sourceCell.appendChild(sourcePill);
    tr.appendChild(sourceCell);

    const statusCell = document.createElement("td");
    const statusPill = document.createElement("span");
    statusPill.className = `pill status-${mapping.disabled ? "disabled" : "enabled"}`;
    statusPill.textContent = mapping.disabled ? "Disabled" : "Enabled";
    statusCell.appendChild(statusPill);
    tr.appendChild(statusCell);

    const actionsCell = document.createElement("td");
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "row-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "secondary";
    toggleBtn.textContent = mapping.disabled ? "Enable" : "Disable";
    toggleBtn.addEventListener("click", () => handleToggleDisabled(domain, identifier, !mapping.disabled));
    actionsWrap.appendChild(toggleBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => handleDeleteMapping(domain, identifier));
    actionsWrap.appendChild(deleteBtn);

    actionsCell.appendChild(actionsWrap);
    tr.appendChild(actionsCell);

    return tr;
  }

  /**
   * @param {string} domain
   * @param {string} identifier
   * @param {{ type: "profile" | "static" | "skip", profileField?: string, value?: string }} fields
   */
  async function handleChangeMapping(domain, identifier, fields) {
    try {
      await window.LJEFieldMapping.saveMapping(domain, identifier, { ...fields, source: "user" });
      showStatus(`Updated mapping for "${state.domains[domain][identifier].label || identifier}".`);
      await load();
    } catch (_error) {
      showStatus("Could not update this mapping.");
    }
  }

  /**
   * @param {string} domain
   * @param {string} identifier
   * @param {boolean} disabled
   */
  async function handleToggleDisabled(domain, identifier, disabled) {
    try {
      await window.LJEFieldMapping.setMappingDisabled(domain, identifier, disabled);
      showStatus(disabled ? "Mapping disabled." : "Mapping enabled.");
      await load();
    } catch (_error) {
      showStatus("Could not change this mapping's status.");
    }
  }

  /**
   * @param {string} domain
   * @param {string} identifier
   */
  async function handleDeleteMapping(domain, identifier) {
    if (!window.confirm("Delete this field mapping? You'll be asked again next time this field is seen.")) {
      return;
    }
    try {
      await window.LJEFieldMapping.deleteMapping(domain, identifier);
      showStatus("Mapping deleted.");
      await load();
    } catch (_error) {
      showStatus("Could not delete this mapping.");
    }
  }

  async function handleResetDomain() {
    if (!state.selectedDomain) {
      return;
    }
    if (!window.confirm(`Reset all field mappings for ${state.selectedDomain}? This can't be undone.`)) {
      return;
    }
    try {
      await window.LJEFieldMapping.resetDomain(state.selectedDomain);
      showStatus(`Reset mappings for ${state.selectedDomain}.`);
      state.selectedDomain = null;
      await load();
    } catch (_error) {
      showStatus("Could not reset this domain.");
    }
  }

  async function handleResetAll() {
    if (!window.confirm("Reset ALL field mappings across every domain? This can't be undone.")) {
      return;
    }
    try {
      await window.LJEFieldMapping.resetAll();
      showStatus("All field mappings reset.");
      state.selectedDomain = null;
      await load();
    } catch (_error) {
      showStatus("Could not reset field mappings.");
    }
  }

  async function handleExportAll() {
    try {
      const json = await window.LJEFieldMapping.exportMappings();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "lje-field-mappings.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showStatus("Exported field mappings.");
    } catch (_error) {
      showStatus("Could not export field mappings.");
    }
  }

  function handleImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await window.LJEFieldMapping.importMappings(String(reader.result || ""), { merge: true });
        showStatus("Imported field mappings.");
        await load();
      } catch (error) {
        showStatus(error instanceof Error ? error.message : "Could not import this file.");
      }
    };
    reader.onerror = () => showStatus("Could not read this file.");
    reader.readAsText(file);
  }

  /**
   * @param {string} message
   */
  function showStatus(message) {
    elements.statusMessage.textContent = message;
  }
})();
