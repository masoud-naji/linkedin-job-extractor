/**
 * Phase 4 — Application History (Foundation).
 *
 * A local-only record of job applications the user has submitted, so
 * future phases (status tracking, resume/cover-letter attribution, CSV or
 * Google Sheets export) have a stable data model to build on.
 *
 * Completely independent of the Profile Manager, Smart Mapping, and
 * Application Assistant: this module knows nothing about profiles, field
 * mappings, or autofill, and none of those modules read or write this
 * one either.
 *
 * chrome.storage.local only, key `ljeApplicationHistory` (does not
 * collide with `ljeProfiles`, `savedJobs`, or `ljeFieldMappings`).
 * Exposed as window.LJEApplicationHistory.
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "ljeApplicationHistory";

  function generateId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `app-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function readState() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const stored = result?.[STORAGE_KEY];
        resolve(Array.isArray(stored) ? stored : []);
      });
    });
  }

  function writeState(records) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: records }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Every field the data model is meant to support eventually is present
   * from day one (as null/empty) — the Phase 4 spec's "Future
   * Compatibility" requirement. Later phases fill these in without ever
   * needing to change the storage shape.
   * @param {object} [overrides]
   */
  function emptyRecord(overrides) {
    const now = new Date().toISOString();
    return {
      id: generateId(),
      company: "",
      position: "",
      jobUrl: "",
      domain: "",
      appliedAt: now,
      lastSeen: now,
      status: "Applied",
      notes: "",
      resume: null,
      coverLetter: null,
      interviewStatus: null,
      salary: null,
      location: null,
      workType: null,
      companyLogo: null,
      jobDescriptionSnapshot: null,
      source: "auto",
      ...overrides
    };
  }

  // ATS platform brand names that show up in og:site_name/<title> on some
  // job boards instead of the actual employer — trusting these verbatim is
  // what produced e.g. "Ashbyhq" as the "company" for every single Ashby-
  // hosted posting. Normalized (lowercased, non-alphanumerics stripped)
  // before comparison so "Ashby", "Ashby HQ", "ashbyhq.com" all match.
  const GENERIC_ATS_BRAND_NAMES = new Set([
    "ashby", "ashbyhq", "greenhouse", "lever", "smartrecruiters", "workable",
    "workday", "myworkday", "icims", "taleo", "bamboohr", "jazzhr", "breezy",
    "recruitee", "personio", "jobvite", "successfactors", "paylocity",
    "ultipro", "ukg", "dayforce", "oraclecloud", "brassring"
  ]);

  /**
   * @param {string} name
   * @returns {boolean} true if `name` is just an ATS platform's own brand,
   *   not a real employer name.
   */
  function isGenericAtsBrandName(name) {
    const normalized = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return GENERIC_ATS_BRAND_NAMES.has(normalized);
  }

  // Hosts where the employer's slug is embedded in the URL path itself
  // (e.g. jobs.ashbyhq.com/<company>/<job-id>) — used as a last-resort
  // company guess when the page gives no other signal at all.
  const ATS_COMPANY_PATH_HOSTS = [
    /(^|\.)ashbyhq\.com$/i,
    /(^|\.)greenhouse\.io$/i,
    /(^|\.)lever\.co$/i,
    /(^|\.)smartrecruiters\.com$/i,
    /(^|\.)workable\.com$/i
  ];

  const ATS_PATH_SKIP_SEGMENTS = new Set([
    "embed", "jobs", "job", "apply", "careers", "company", "en", "posting", "position"
  ]);

  /**
   * @param {string} slug
   * @returns {string}
   */
  function humanizeSlug(slug) {
    return String(slug || "")
      .replace(/[-_]+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  /**
   * Best-effort company guess from a known ATS's URL path convention.
   * Only used as a last resort, when the page itself gave no usable
   * signal — a URL slug is a worse guess than real page text, just not as
   * bad as the platform's own brand name.
   * @param {string} jobUrl
   * @returns {string | null}
   */
  function guessCompanyFromUrl(jobUrl) {
    try {
      const parsed = new URL(jobUrl);
      if (!ATS_COMPANY_PATH_HOSTS.some((pattern) => pattern.test(parsed.hostname))) {
        return null;
      }
      const segments = parsed.pathname.split("/").filter(Boolean);
      for (const segment of segments) {
        if (ATS_PATH_SKIP_SEGMENTS.has(segment.toLowerCase())) {
          continue;
        }
        return humanizeSlug(decodeURIComponent(segment));
      }
      return null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Strips the query string/hash and any trailing slash so trivially
   * different tracking-param URLs for the same posting still count as
   * "the same job" for de-duplication. Falls back to the raw trimmed
   * string if it isn't a parseable URL.
   * @param {string} jobUrl
   * @returns {string}
   */
  function normalizeJobUrl(jobUrl) {
    try {
      const parsed = new URL(jobUrl);
      return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
    } catch (_error) {
      return String(jobUrl || "").trim();
    }
  }

  /**
   * @returns {Promise<object[]>} newest-first by appliedAt
   */
  async function getAllApplications() {
    const records = await readState();
    return [...records].sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime());
  }

  /**
   * @param {string} id
   */
  async function getApplication(id) {
    const records = await readState();
    return records.find((record) => record.id === id) || null;
  }

  /**
   * @param {string} jobUrl
   */
  async function findByJobUrl(jobUrl) {
    const target = normalizeJobUrl(jobUrl);
    const records = await readState();
    return records.find((record) => normalizeJobUrl(record.jobUrl) === target) || null;
  }

  /**
   * Upserts one application record by job URL. If a record already
   * exists for this job, no duplicate is created — only `lastSeen` (and
   * `status`, `resume`, `coverLetter`, if provided) are updated. Otherwise
   * a new record is appended with the given fields plus empty placeholders
   * for not-yet-implemented data (salary, interviewStatus, etc.).
   *
   * `resume`/`coverLetter`, if given, are only ever *metadata* —
   * { id, name, filename, uploadedAt } — never file contents. Omitting
   * either (or passing null, e.g. nothing was detected on the page this
   * time) leaves an existing record's value as-is rather than clearing it.
   * @param {{ company: string, position: string, jobUrl: string, domain: string, status?: string, source?: string, resume?: object|null, coverLetter?: object|null }} fields
   */
  async function recordApplication(fields) {
    if (!fields || !fields.jobUrl) {
      throw new Error("jobUrl is required to record an application.");
    }
    const records = await readState();
    const target = normalizeJobUrl(fields.jobUrl);
    const now = new Date().toISOString();
    const existingIndex = records.findIndex((record) => normalizeJobUrl(record.jobUrl) === target);

    if (existingIndex !== -1) {
      records[existingIndex] = {
        ...records[existingIndex],
        lastSeen: now,
        status: fields.status || records[existingIndex].status,
        resume: fields.resume || records[existingIndex].resume,
        coverLetter: fields.coverLetter || records[existingIndex].coverLetter
      };
      await writeState(records);
      return records[existingIndex];
    }

    const record = emptyRecord({
      company: fields.company || "",
      position: fields.position || "",
      jobUrl: fields.jobUrl,
      domain: fields.domain || "",
      status: fields.status || "Applied",
      source: fields.source || "auto",
      resume: fields.resume || null,
      coverLetter: fields.coverLetter || null,
      appliedAt: now,
      lastSeen: now
    });
    records.push(record);
    await writeState(records);
    return record;
  }

  /**
   * @param {string} id
   * @param {object} patch
   */
  async function updateApplication(id, patch) {
    const records = await readState();
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) {
      throw new Error("Application record not found.");
    }
    records[index] = { ...records[index], ...patch, id: records[index].id };
    await writeState(records);
    return records[index];
  }

  /**
   * @param {string} id
   */
  async function deleteApplication(id) {
    const records = await readState();
    await writeState(records.filter((record) => record.id !== id));
  }

  async function resetAll() {
    await writeState([]);
  }

  global.LJEApplicationHistory = {
    getAllApplications,
    getApplication,
    findByJobUrl,
    recordApplication,
    updateApplication,
    deleteApplication,
    resetAll,
    normalizeJobUrl,
    isGenericAtsBrandName,
    guessCompanyFromUrl
  };
})(window);
