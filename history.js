(() => {
  "use strict";

  const store = window.LJEApplicationHistory;

  const elements = {
    emptyState: document.getElementById("emptyState"),
    historyList: document.getElementById("historyList")
  };

  document.addEventListener("DOMContentLoaded", load);

  async function load() {
    let records = [];
    try {
      records = await store.getAllApplications();
      records = await repairLegacyCompanyNames(records);
    } catch (_error) {
      records = [];
    }
    render(records);
  }

  /**
   * One-time, best-effort self-heal for records saved before the company-
   * name extraction bug fix: entries whose "company" is actually just an
   * ATS platform's own brand (e.g. "Ashbyhq" from jobs.ashbyhq.com, saved
   * for every employer on that platform) get re-guessed from the stored
   * jobUrl. Persisted so the fix sticks across reloads, not just this view.
   * @param {object[]} records
   * @returns {Promise<object[]>}
   */
  async function repairLegacyCompanyNames(records) {
    const fixes = [];
    const repaired = records.map((record) => {
      if (!store.isGenericAtsBrandName(record.company)) {
        return record;
      }
      const guess = store.guessCompanyFromUrl(record.jobUrl);
      if (!guess || guess === record.company) {
        return record;
      }
      fixes.push({ id: record.id, company: guess });
      return { ...record, company: guess };
    });

    await Promise.all(
      fixes.map((fix) => store.updateApplication(fix.id, { company: fix.company }).catch(() => {}))
    );

    return repaired;
  }

  /**
   * @param {object[]} records
   */
  function render(records) {
    elements.historyList.textContent = "";

    if (!records.length) {
      elements.emptyState.classList.remove("hidden");
      return;
    }

    elements.emptyState.classList.add("hidden");
    records.forEach((record) => elements.historyList.appendChild(buildItem(record)));
  }

  /**
   * @param {object} record
   * @returns {HTMLLIElement}
   */
  function buildItem(record) {
    const li = document.createElement("li");
    li.className = "history-item";

    const main = document.createElement("div");
    main.className = "history-main";

    const company = document.createElement("div");
    company.className = "history-company";
    company.textContent = record.company || "Unknown company";
    main.appendChild(company);

    const position = document.createElement("div");
    position.className = "history-position";
    position.textContent = record.position || "Unknown position";
    main.appendChild(position);

    const docs = document.createElement("div");
    docs.className = "history-docs";
    docs.appendChild(buildDocField("Resume", record.resume));
    docs.appendChild(buildDocField("Cover Letter", record.coverLetter));
    main.appendChild(docs);

    const meta = document.createElement("div");
    meta.className = "history-meta";

    const status = document.createElement("span");
    status.className = "history-status";
    status.textContent = record.status || "Applied";
    meta.appendChild(status);

    const date = document.createElement("div");
    date.className = "history-date";
    date.textContent = formatDate(record.appliedAt);
    meta.appendChild(date);

    const actions = document.createElement("div");
    actions.className = "history-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "history-action-btn";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => handleEdit(record));
    actions.appendChild(editButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "history-action-btn history-action-btn-danger";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => handleDelete(record));
    actions.appendChild(deleteButton);

    meta.appendChild(actions);

    li.appendChild(main);
    li.appendChild(meta);
    return li;
  }

  /**
   * Simple prompt-based fix-up for a record's company/position — the
   * fastest way to correct a heuristic miss (e.g. "Work Summary" captured
   * instead of the real job title) that can't be re-derived automatically
   * once the original page is gone.
   * @param {object} record
   */
  async function handleEdit(record) {
    const company = window.prompt("Company", record.company || "");
    if (company === null) {
      return;
    }
    const position = window.prompt("Position", record.position || "");
    if (position === null) {
      return;
    }
    try {
      await store.updateApplication(record.id, { company: company.trim(), position: position.trim() });
      await load();
    } catch (_error) {
      // Non-fatal — the list just won't reflect the edit.
    }
  }

  /**
   * @param {object} record
   */
  async function handleDelete(record) {
    const label = [record.company, record.position].filter(Boolean).join(" — ") || "this entry";
    if (!window.confirm(`Delete ${label} from your application history?`)) {
      return;
    }
    try {
      await store.deleteApplication(record.id);
      await load();
    } catch (_error) {
      // Non-fatal — the list just won't reflect the deletion.
    }
  }

  /**
   * @param {string} label "Resume" or "Cover Letter"
   * @param {{ name?: string, filename?: string } | null} doc
   * @returns {HTMLDivElement}
   */
  function buildDocField(label, doc) {
    const wrapper = document.createElement("div");
    wrapper.className = "history-doc";

    const labelEl = document.createElement("div");
    labelEl.className = "history-doc-label";
    labelEl.textContent = label;
    wrapper.appendChild(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "history-doc-value";
    valueEl.textContent = (doc && (doc.name || doc.filename)) || "—";
    wrapper.appendChild(valueEl);

    return wrapper;
  }

  /**
   * @param {string} isoValue
   * @returns {string}
   */
  function formatDate(isoValue) {
    if (!isoValue) {
      return "";
    }
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
})();
