/**
 * Phase 5 & 6 — Resume Used / Cover Letter Used.
 *
 * Generic, config-driven document classifier + per-page tracker. Not a
 * document manager: no file contents are ever read, stored, or uploaded —
 * only { id, name, filename, uploadedAt } metadata about which document
 * was most recently selected for a given type (resume, cover letter, ...).
 *
 * A single `trackDocument(type, metadata)` entry point backs both document
 * types instead of separate ResumeTracker/CoverLetterTracker
 * implementations, so a future document type (e.g. "portfolio") is just
 * another entry in DOCUMENT_TYPES plus a keyword list — no new tracker
 * class needed.
 *
 * Depended on by application-history-tracker.js. Exposed as
 * window.LJEDocumentTracker.
 */
(function (global) {
  "use strict";

  const FILE_EXTENSION_PATTERN = /\.(pdf|docx?)$/i;

  // Order matters: checked most-specific-first so a filename like
  // "AI_Cover_Letter.pdf" (which also contains the resume keyword "ai")
  // classifies as a cover letter rather than a resume.
  const DOCUMENT_TYPES = {
    coverLetter: {
      keywords: ["cover", "coverletter", "letter", "motivation"]
    },
    resume: {
      keywords: ["resume", "cv", "frontend", "react", "aem", "ai"]
    }
  };

  const CLASSIFICATION_ORDER = ["coverLetter", "resume"];

  /**
   * @param {string} filename
   * @returns {string | null} a known document type, or null if the file
   *   isn't a recognized document extension or matches no keyword —
   *   unknown documents are ignored, never guessed at.
   */
  function classifyFilename(filename) {
    const name = String(filename || "").trim();
    if (!name || !FILE_EXTENSION_PATTERN.test(name)) {
      return null;
    }
    const lower = name.toLowerCase();
    for (const type of CLASSIFICATION_ORDER) {
      if (DOCUMENT_TYPES[type].keywords.some((keyword) => lower.includes(keyword))) {
        return type;
      }
    }
    return null;
  }

  /**
   * @param {string} filename
   * @returns {string} filename minus extension, underscores/dashes turned
   *   into spaces — best-effort human-readable label only.
   */
  function deriveNameFromFilename(filename) {
    return String(filename || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .trim();
  }

  /**
   * @param {File} file
   * @returns {{ id: null, name: string, filename: string, uploadedAt: string }}
   */
  function buildMetadata(file) {
    return {
      id: null,
      name: deriveNameFromFilename(file.name) || file.name,
      filename: file.name,
      uploadedAt: new Date().toISOString()
    };
  }

  /**
   * Creates an isolated, per-page/session tracker. A fresh instance per
   * page load (the Application Assistant and its trackers are injected
   * on demand, never persisted across page loads) is what keeps this
   * scoped to "this page's session" — a resume detected on yesterday's
   * application can never leak into today's.
   */
  function createTracker() {
    const latest = {};

    /**
     * @param {string} type one of DOCUMENT_TYPES's keys
     * @param {object} metadata
     */
    function trackDocument(type, metadata) {
      if (!DOCUMENT_TYPES[type] || !metadata) {
        return;
      }
      latest[type] = metadata;
    }

    /**
     * Classifies a single selected File and, if recognized, tracks it as
     * the latest document of that type (replacing any earlier one).
     * @param {File} file
     * @returns {{ type: string, metadata: object } | null}
     */
    function classifyAndTrack(file) {
      const type = classifyFilename(file && file.name);
      if (!type) {
        return null;
      }
      const metadata = buildMetadata(file);
      trackDocument(type, metadata);
      return { type, metadata };
    }

    /**
     * @param {string} type
     * @returns {object | null}
     */
    function getLatest(type) {
      return latest[type] || null;
    }

    return { trackDocument, classifyAndTrack, getLatest };
  }

  global.LJEDocumentTracker = {
    classifyFilename,
    createTracker
  };
})(window);
