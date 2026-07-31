/**
 * Phase 4 — Application History (Foundation): on-demand, best-effort
 * detection of a successful job application submission, so a local
 * history record can be saved automatically.
 *
 * Injected the same way as the Application Assistant (on demand, via
 * chrome.scripting.executeScript under the activeTab grant, triggered by
 * "Fill Basic Fields on This Page") so it needs no new permissions and no
 * persistent content script on arbitrary sites. It is otherwise a fully
 * independent script: it does not read or modify anything in
 * application-assistant.js, profile-storage.js, or field-mapping-storage.js,
 * and none of those import anything from here either. Field detection,
 * the mapping engine, and autofill logic are untouched by this file.
 *
 * A form "submit" event or a click on a submit-looking control is NEVER
 * sufficient on its own — plenty of ATS forms still fire a native `submit`
 * event even when their own client-side validation goes on to block the
 * request (e.g. "Email is required"), which used to cause a history entry
 * to be recorded for an application that never actually went anywhere.
 *
 * The real flow:
 *   Submit/Finish clicked → wait briefly for confirmation →
 *     a success signal appears  → record one history entry
 *     a validation error appears → abandon, keep listening for a retry
 *     nothing happens before the window elapses → abandon, keep listening
 *
 * Confirmation signals, most to least reliable — only the first two
 * ever record by themselves outside of a pending confirmation window too,
 * since a purely client-side navigation can reach them with no `submit`
 * event at all:
 *   1. A success-looking message in the page text (e.g. "Thank you for
 *      applying").
 *   2. The URL changing to something that looks like a confirmation page.
 *   3. A click on a control whose text clearly reads as a final submit
 *      (not a generic "Apply" button, which usually just opens the form) —
 *      starts the wait, never records by itself.
 *   4. A native form "submit" event — same, starts the wait only.
 * Once a real success signal is confirmed, one record is saved and
 * tracking stops for the rest of this page's lifetime — this is a
 * one-shot detector, not a continuous monitor.
 *
 * Depends on application-history-storage.js (window.LJEApplicationHistory)
 * being injected first into the same tab.
 *
 * Phase 5 & 6 — Resume Used / Cover Letter Used: also watches file inputs
 * on the page for a resume or cover letter being selected (via
 * document-tracker.js, window.LJEDocumentTracker) and attaches whichever
 * one was most recently selected to the recorded application. Only
 * metadata (name/filename/uploadedAt) is ever kept — never file contents.
 * Depends on document-tracker.js being injected first into the same tab.
 */
(() => {
  "use strict";

  if (window.__ljeHistoryTrackerActive) {
    return;
  }
  window.__ljeHistoryTrackerActive = true;

  const store = window.LJEApplicationHistory;
  if (!store) {
    window.__ljeHistoryTrackerActive = false;
    return;
  }

  // Scoped to this page's session only: a fresh tracker per injection, so
  // a resume selected on a previous page/day is never carried forward.
  const documentTracker = window.LJEDocumentTracker ? window.LJEDocumentTracker.createTracker() : null;

  const BACKGROUND_POLL_INTERVAL_MS = 2000;
  const CONFIRM_CHECK_INTERVAL_MS = 500;
  const CONFIRM_WINDOW_MS = 4000;

  // Deliberately narrow: a bare "Apply" or "Apply Now" button on most ATS
  // pages just opens the application form rather than finalizing it, so
  // matching that broadly would over-report. "Finish"/"Complete
  // Application" are included because some ATS's final step button reads
  // that way instead of "Submit". A bare "Continue" is deliberately left
  // out — it's overwhelmingly used for "next step of the wizard," not
  // "finalize," and without step-tracking there's no reliable way to tell
  // the two apart; revisit only if a future phase adds step awareness.
  const SUBMIT_TEXT_PATTERNS = [
    /submit\s*(your\s*)?application/i,
    /send\s*(my\s*)?application/i,
    /^submit$/i,
    /complete\s*application/i,
    /finish\s*application/i,
    /^finish$/i
  ];

  const URL_SUCCESS_PATTERNS = [
    /thank[-_\s]?you/i,
    /confirmation/i,
    /application[-_\s]?(submitted|received|success|complete|finished)/i,
    /\bsuccess\b/i,
    /\bsubmitted\b/i
  ];

  const SUCCESS_TEXT_PATTERNS = [
    /thank(s| you) for (your interest|applying|your application)/i,
    /(your\s*)?application (has been |was )?(successfully )?(submitted|received)/i,
    /we('| ha)ve received your application/i,
    /application (complete|confirmation|finished)/i,
    /you'?re all set/i
  ];

  // Generic, text-only validation-error signal — deliberately not tied to
  // any ATS's error class names or DOM structure. Only treated as "a new
  // error appeared" if it wasn't already present before this submit
  // attempt, so a page's static "* required" hint text doesn't cause a
  // false abandon.
  const VALIDATION_ERROR_PATTERNS = [
    /this field is required/i,
    /\bis required\b/i,
    /required field/i,
    /please (enter|fill|complete|provide)/i,
    /invalid (email|phone|value|format)/i
  ];

  // Captured once, immediately, from the page the assistant was actually
  // invoked on — not re-read at submission time, since by then the page
  // may have already navigated to a generic "thank you" screen with a
  // different (or no) job title in its heading/title.
  const capturedContext = {
    company: extractCompany(),
    position: extractPosition(),
    jobUrl: location.href,
    domain: location.hostname
  };

  let recorded = false;
  let backgroundPollTimer = null;
  let confirmCheckTimer = null;
  let confirmTimeoutTimer = null;
  let hadValidationTextBeforeThisAttempt = false;
  let confirmationWindowActive = false;
  let lastHref = location.href;

  document.addEventListener("submit", handleFormSubmit, true);
  document.addEventListener("click", handleClick, true);
  // Delegated (not bound per-input) so file inputs added dynamically after
  // injection — common with React/Vue-based ATS forms — are still caught.
  document.addEventListener("change", handleFileInputChange, true);
  // Independent of any submit click — catches purely client-side
  // navigation to a confirmation view with no native submit event at all.
  backgroundPollTimer = window.setInterval(checkForSuccessSignal, BACKGROUND_POLL_INTERVAL_MS);
  // Some ATS's finalize a submission with a full page navigation (a real
  // HTTP redirect) rather than an in-place confirmation view. That tears
  // down this script's entire context — timers included — before either
  // checkForSuccessSignal or the background poll ever gets a chance to
  // see the confirmation. If we're mid-confirmation-window (a submit-
  // looking control was just clicked) and the page starts unloading with
  // no new validation error on screen, that's the strongest signal this
  // detector will ever get for that case — record right now, before the
  // context disappears. Both events are listened for since neither fires
  // reliably in every browser/navigation-type combination; recordSubmission
  // is idempotent (guarded by `recorded`), so a double-fire is harmless.
  window.addEventListener("pagehide", handlePageUnloadDuringConfirmation);
  window.addEventListener("beforeunload", handlePageUnloadDuringConfirmation);

  function handleFormSubmit() {
    beginConfirmationWindow();
  }

  /**
   * @param {Event} event
   */
  function handleFileInputChange(event) {
    if (!documentTracker) {
      return;
    }
    const input = event.target;
    if (!input || input.tagName !== "INPUT" || input.type !== "file" || !input.files) {
      return;
    }
    // If more than one file is selected in one go, later files win for
    // whichever type they classify as — same "keep the latest" rule as
    // separate selections.
    Array.from(input.files).forEach((file) => documentTracker.classifyAndTrack(file));
  }

  /**
   * @param {MouseEvent} event
   */
  function handleClick(event) {
    const control = event.target?.closest?.('button, input[type="submit"], [role="button"], a');
    if (!control) {
      return;
    }
    const text = (control.textContent || control.value || control.getAttribute("aria-label") || "").trim();
    if (text && SUBMIT_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
      beginConfirmationWindow();
    }
  }

  /**
   * Submit/Finish was clicked (or a form actually submitted) — this is
   * only ever a *starter*, never a reason to record by itself. Watches
   * more eagerly for a short window, then gives up quietly if nothing
   * confirms it, without tearing down the main listeners: the user may
   * fix a validation error and try again.
   */
  function beginConfirmationWindow() {
    if (recorded) {
      return;
    }
    hadValidationTextBeforeThisAttempt = checkForValidationError();
    confirmationWindowActive = true;

    if (confirmCheckTimer) {
      window.clearInterval(confirmCheckTimer);
    }
    if (confirmTimeoutTimer) {
      window.clearTimeout(confirmTimeoutTimer);
    }
    confirmCheckTimer = window.setInterval(runConfirmationCheck, CONFIRM_CHECK_INTERVAL_MS);
    confirmTimeoutTimer = window.setTimeout(abandonConfirmationWindow, CONFIRM_WINDOW_MS);
  }

  /**
   * Fires on "pagehide"/"beforeunload". Only actually records if a submit
   * confirmation window is currently open — i.e. this exact tab recently
   * saw a click on a control whose text read as a final submit — so an
   * unrelated navigation (following a link, closing the tab days later)
   * can never trigger it.
   */
  function handlePageUnloadDuringConfirmation() {
    if (recorded || !confirmationWindowActive) {
      return;
    }
    const hasValidationTextNow = checkForValidationError();
    if (hasValidationTextNow && !hadValidationTextBeforeThisAttempt) {
      // The site rejected the attempt client-side and is not, in fact,
      // navigating away because of it — don't record.
      return;
    }
    recordSubmission();
  }

  function runConfirmationCheck() {
    if (recorded) {
      return;
    }
    const hasValidationTextNow = checkForValidationError();
    if (hasValidationTextNow && !hadValidationTextBeforeThisAttempt) {
      // A validation error appeared that wasn't there before this attempt
      // — the site rejected it client-side. Stop waiting; don't record.
      abandonConfirmationWindow();
      return;
    }
    checkForSuccessSignal();
  }

  function abandonConfirmationWindow() {
    confirmationWindowActive = false;
    if (confirmCheckTimer) {
      window.clearInterval(confirmCheckTimer);
      confirmCheckTimer = null;
    }
    if (confirmTimeoutTimer) {
      window.clearTimeout(confirmTimeoutTimer);
      confirmTimeoutTimer = null;
    }
  }

  /**
   * @returns {boolean} true if a validation-error-looking phrase is
   *   currently present anywhere in the page text.
   */
  function checkForValidationError() {
    const bodyText = document.body ? document.body.textContent || "" : "";
    return Boolean(bodyText) && VALIDATION_ERROR_PATTERNS.some((pattern) => pattern.test(bodyText));
  }

  /**
   * The only two signals allowed to actually record an entry. Runs both
   * from the background poll (independent of any click) and, more
   * eagerly, during a post-submit confirmation window.
   * @returns {boolean} true if a match was found and recorded.
   */
  function checkForSuccessSignal() {
    if (recorded) {
      return false;
    }
    if (location.href !== lastHref) {
      const changedHref = location.href;
      lastHref = changedHref;
      if (URL_SUCCESS_PATTERNS.some((pattern) => pattern.test(changedHref))) {
        recordSubmission();
        return true;
      }
    }
    const bodyText = document.body ? document.body.textContent || "" : "";
    if (bodyText && SUCCESS_TEXT_PATTERNS.some((pattern) => pattern.test(bodyText))) {
      recordSubmission();
      return true;
    }
    return false;
  }

  function recordSubmission() {
    if (recorded) {
      return;
    }
    recorded = true;
    cleanup();

    store
      .recordApplication({
        company: capturedContext.company,
        position: capturedContext.position,
        jobUrl: capturedContext.jobUrl,
        domain: capturedContext.domain,
        source: "auto",
        resume: documentTracker ? documentTracker.getLatest("resume") : null,
        coverLetter: documentTracker ? documentTracker.getLatest("coverLetter") : null
      })
      .catch(() => {
        // Non-fatal: a missed history record shouldn't surface as an
        // error to the user on a page they've already applied on.
      });
  }

  function cleanup() {
    document.removeEventListener("submit", handleFormSubmit, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("change", handleFileInputChange, true);
    window.removeEventListener("pagehide", handlePageUnloadDuringConfirmation);
    window.removeEventListener("beforeunload", handlePageUnloadDuringConfirmation);
    abandonConfirmationWindow();
    if (backgroundPollTimer) {
      window.clearInterval(backgroundPollTimer);
      backgroundPollTimer = null;
    }
  }

  // Section headings that show up as the page's <h1> on a later step of a
  // multi-step application wizard (work history, EEO questions, review,
  // etc.) rather than the job title — capturing one of these as "position"
  // is what produced entries like "Work Summary" instead of the real job
  // title when the assistant was last invoked on that step.
  const GENERIC_HEADING_PATTERNS = [
    /^work (summary|experience|history)$/i,
    /^(personal|contact) (info|information)$/i,
    /^education$/i,
    /^experience$/i,
    /^review( (your )?application)?$/i,
    /^application$/i,
    /^apply( now)?$/i,
    /^submit( your)? application$/i,
    /^additional (info|information|questions)$/i,
    /^voluntary (self[- ]?identification|disclosures?)$/i,
    /^equal opportunity/i,
    /^resume\s*\/?\s*cv$/i,
    /^attachments?$/i,
    /^documents?$/i
  ];

  /**
   * @returns {string}
   */
  function extractPosition() {
    const heading = document.querySelector("h1");
    const headingText = heading && heading.textContent ? heading.textContent.trim() : "";
    if (headingText && !GENERIC_HEADING_PATTERNS.some((pattern) => pattern.test(headingText))) {
      return headingText;
    }
    const title = (document.title || "").trim();
    if (title) {
      return title;
    }
    return headingText;
  }

  /**
   * @returns {string}
   */
  function extractCompany() {
    const ogSite = document.querySelector('meta[property="og:site_name"]');
    const ogSiteContent = ogSite ? ogSite.getAttribute("content") || "" : "";
    if (ogSiteContent.trim() && !store.isGenericAtsBrandName(ogSiteContent)) {
      return ogSiteContent.trim();
    }

    const fromTitle = extractCompanyFromTitle(document.title || "");
    if (fromTitle && !store.isGenericAtsBrandName(fromTitle)) {
      return fromTitle;
    }

    // Some ATS platforms (e.g. Ashby) put no company signal at all in
    // og:site_name or <title> — the URL path is the only thing left.
    const fromUrl = store.guessCompanyFromUrl(location.href);
    if (fromUrl) {
      return fromUrl;
    }

    return humanizeHostname(location.hostname);
  }

  /**
   * Best-effort split of common "<Position> at <Company>" or
   * "<Position> - <Company>" document.title conventions. Heuristic, not
   * exhaustive — good enough for a first pass, per spec.
   *
   * The "@ Company" check runs before the dash/pipe split on purpose: a
   * title like "SDE - 3 (Senior Frontend Engineer) @ Certa" has a dash
   * inside the position part too, so splitting on dashes first grabs
   * everything after the *first* one ("3 (Senior Frontend Engineer) @
   * Certa") instead of just the company after "@".
   * @param {string} title
   * @returns {string | null}
   */
  function extractCompanyFromTitle(title) {
    const atSymbolMatch = title.match(/@\s*(.+)$/);
    if (atSymbolMatch && atSymbolMatch[1].trim()) {
      return atSymbolMatch[1].trim();
    }
    const atWordMatch = title.match(/\bat\s+(.+)$/i);
    if (atWordMatch && atWordMatch[1].trim()) {
      return atWordMatch[1].trim();
    }
    const segments = title
      .split(/\s*[-|]\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (segments.length > 1) {
      return segments[segments.length - 1];
    }
    return null;
  }

  /**
   * Last-resort fallback: turn a hostname like "jobs.jobvite.com" or
   * "harvey.ai" into a readable guess ("Jobvite", "Harvey").
   * @param {string} hostname
   * @returns {string}
   */
  function humanizeHostname(hostname) {
    const withoutCommonSubdomain = String(hostname || "").replace(/^(jobs|apply|careers|boards|job-boards)\./i, "");
    const withoutTld = withoutCommonSubdomain.replace(/\.[a-z]{2,}$/i, "");
    const mainSegment = withoutTld.split(".").pop() || withoutTld;
    if (!mainSegment) {
      return hostname || "";
    }
    return mainSegment.charAt(0).toUpperCase() + mainSegment.slice(1);
  }
})();
