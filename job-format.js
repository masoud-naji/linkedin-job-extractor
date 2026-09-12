(() => {
  "use strict";

  const NOT_FOUND = "Not found";

  /**
   * @param {string | boolean | null | undefined} value
   * @returns {string}
   */
  function valueOrFallback(value) {
    if (typeof value === "boolean") {
      return value ? "Yes" : "No";
    }
    const text = String(value || "").trim();
    return text || NOT_FOUND;
  }

  /**
   * Same plain-text layout as the popup's "Copy Job Data" button.
   * @param {object | null} job
   * @returns {string}
   */
  function formatPlainText(job) {
    if (!job) {
      return "";
    }

    const lines = [
      `Job Title: ${valueOrFallback(job.jobTitle)}`,
      `Company: ${valueOrFallback(job.companyName)}`,
      `Company URL: ${valueOrFallback(job.companyUrl)}`,
      `Location: ${valueOrFallback(job.location)}`,
      `Workplace Type: ${valueOrFallback(job.workplaceType)}`,
      `Employment Type: ${valueOrFallback(job.employmentType)}`,
      `Seniority: ${valueOrFallback(job.seniorityLevel)}`,
      `Salary: ${valueOrFallback(job.salary)}`,
      `Date Posted: ${valueOrFallback(job.datePosted)}`,
      `Applicants: ${valueOrFallback(job.applicantCount)}`,
      `Easy Apply: ${job.easyApply === true ? "Yes" : "No"}`,
      `Application Closed: ${job.applicationClosed === true ? "Yes" : "No"}`,
      `Job URL: ${valueOrFallback(job.jobUrl)}`,
      `LinkedIn Job ID: ${valueOrFallback(job.jobId)}`,
      `Extracted At: ${valueOrFallback(job.extractedAt)}`,
      "",
      "Skills:",
      Array.isArray(job.skills) && job.skills.length ? job.skills.join(", ") : NOT_FOUND,
      "",
      "About the Job:",
      valueOrFallback(job.description)
    ];

    return lines.join("\n");
  }

  /**
   * Same JSON layout as the popup's "Copy as JSON" button.
   * @param {object | null} job
   * @returns {string}
   */
  function formatJson(job) {
    return JSON.stringify(job || {}, null, 2);
  }

  const api = { NOT_FOUND, valueOrFallback, formatPlainText, formatJson };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    self.LJEJobFormat = api;
  }
})();
