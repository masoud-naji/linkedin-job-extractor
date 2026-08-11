/**
 * AI Context — pure, deterministic formatting helpers for the "Open in AI
 * Chat" workflow (popup.js). No storage, no chrome.* APIs, no LLM calls:
 * this module only reshapes data it's handed into the text/JSON the
 * clipboard payload is made of.
 *
 * Two things live here:
 *  - buildProfileContext(profile): the ACTIVE Profile (profile-storage.js's
 *    flat schema) reduced to a clean, provider-independent object — no
 *    internal metadata (id, createdAt, resumePdf, ...), no summarization.
 *  - buildJobChatPayload(...): combines a prompt, the CURRENTLY EXTRACTED
 *    LinkedIn job (the same object "Copy as JSON" already uses — never a
 *    second extraction), and that optional profile context into the
 *    final clipboard text.
 *
 * Deliberately has no opinion on prompt text, destinations, or providers
 * — that configuration lives in ai-settings.js. This module only knows
 * how to shape whatever it's given.
 *
 * Exposed as window.LJEAIContext (browser) / module.exports (tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.LJEAIContext = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function asTrimmedString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  /**
   * Best-effort parse of the profile's raw Resume JSON text into a real
   * object, so the context payload nests actual data instead of a
   * doubly-escaped string. Falls back to the raw text untouched if it
   * isn't valid JSON — never dropped, never rewritten.
   * @param {string} resumeJsonText
   * @returns {*}
   */
  function parseResumeJson(resumeJsonText) {
    try {
      return JSON.parse(resumeJsonText);
    } catch (_error) {
      return resumeJsonText;
    }
  }

  /**
   * Deterministic reshape of a saved Profile (profile-storage.js's flat
   * schema) into a clean object meant for an AI conversation, not a
   * profile backup. Internal/storage metadata (id, createdAt, updatedAt,
   * resumePdf binary) is left out; every other populated field is kept
   * as-is, unsummarized. Empty fields are simply omitted, not emitted as
   * "" / null.
   * @param {object} profile a record from LJEProfileStore
   * @returns {object}
   */
  function buildProfileContext(profile) {
    const context = {};
    const profileName = asTrimmedString(profile && profile.name);
    if (profileName) context.profileName = profileName;

    const stringFields = [
      "fullName",
      "email",
      "phone",
      "currentTitle",
      "location",
      "linkedinUrl",
      "portfolioUrl",
      "githubUrl",
      "notes"
    ];
    stringFields.forEach((field) => {
      const value = asTrimmedString(profile && profile[field]);
      if (value) context[field] = value;
    });

    const resumeJsonText = asTrimmedString(profile && profile.resumeJson);
    if (resumeJsonText) context.resume = parseResumeJson(resumeJsonText);

    return context;
  }

  /**
   * Assembles the clipboard payload for "Open in AI Chat": the saved
   * prompt, then the current LinkedIn job (verbatim — whatever object
   * popup.js's "Copy as JSON" already serializes), then the optional
   * profile context section.
   * @param {{ prompt: string, job: object, profileContext?: object|null }} params
   * @returns {string}
   */
  function buildJobChatPayload({ prompt, job, profileContext }) {
    const sections = [
      `[USER PROMPT]\n\n${asTrimmedString(prompt)}`,
      `[CURRENT JOB]\n\n${JSON.stringify(job || {}, null, 2)}`
    ];
    if (profileContext && Object.keys(profileContext).length) {
      sections.push(`[PROFILE CONTEXT]\n\n${JSON.stringify(profileContext, null, 2)}`);
    }
    return sections.join("\n\n");
  }

  return {
    buildProfileContext,
    buildJobChatPayload
  };
});
