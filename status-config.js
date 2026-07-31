/**
 * Phase 7 — Application Status Tracking: single source of truth for
 * available statuses, their display order, and their badge colors.
 *
 * The History page's status dropdown reads from this module instead of
 * hardcoding the status list or colors itself — a later phase adding a
 * status (or restyling the badges) only ever touches this one file.
 *
 * Not needed by application-history-storage.js or the injected tracker:
 * storage stores whatever string it's given, and status changes are
 * purely manual (via the History page), so only history.html/history.js
 * load this. Exposed as window.LJEStatusConfig.
 */
(function (global) {
  "use strict";

  const STATUSES = [
    "Wishlist",
    "Applied",
    "Online Assessment (OA)",
    "Recruiter Screen",
    "Phone Screen",
    "Hiring Manager Interview",
    "Onsite Interview",
    "Final Interview",
    "Offer",
    "Accepted",
    "Rejected",
    "Withdrawn",
    "Ghosted"
  ];

  const DEFAULT_STATUS = "Applied";

  // { background, color } per status — light, readable badge fills. Statuses
  // that sit at the same stage of the pipeline intentionally share a color
  // (the two interview-round statuses are both "Indigo," the two final-round
  // statuses are both "Orange," per spec) rather than each getting a unique
  // hue.
  const STATUS_COLORS = {
    "Wishlist": { background: "#eceff1", color: "#4b5563" },
    "Applied": { background: "#e3edfd", color: "#1a56db" },
    "Online Assessment (OA)": { background: "#f2e8fd", color: "#7c3aed" },
    "Recruiter Screen": { background: "#dff5f7", color: "#0e7490" },
    "Phone Screen": { background: "#e6e8f9", color: "#3730a3" },
    "Hiring Manager Interview": { background: "#e6e8f9", color: "#3730a3" },
    "Onsite Interview": { background: "#feead6", color: "#c2410c" },
    "Final Interview": { background: "#feead6", color: "#c2410c" },
    "Offer": { background: "#e2f5e6", color: "#137333" },
    "Accepted": { background: "#cdedd4", color: "#0b5e21" },
    "Rejected": { background: "#fbe3e1", color: "#b3261e" },
    "Withdrawn": { background: "#eceff1", color: "#4b5563" },
    "Ghosted": { background: "#e2e4e8", color: "#1f2937" }
  };

  /**
   * @param {string} value
   * @returns {boolean}
   */
  function isValidStatus(value) {
    return STATUSES.includes(value);
  }

  /**
   * @param {string} value
   * @returns {{ background: string, color: string }}
   */
  function getStatusColors(value) {
    return STATUS_COLORS[value] || STATUS_COLORS[DEFAULT_STATUS];
  }

  global.LJEStatusConfig = {
    STATUSES,
    DEFAULT_STATUS,
    isValidStatus,
    getStatusColors
  };
})(window);
