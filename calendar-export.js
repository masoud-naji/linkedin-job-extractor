/**
 * Phase 8 — Calendar Export (.ics)
 *
 * Turns existing Application History records into standard iCalendar
 * (.ics) files the user can import into Google Calendar, Outlook, Apple
 * Calendar, etc. No network requests, no calendar APIs, no OAuth — this
 * module only formats text and triggers a local file download.
 *
 * Read-only with respect to history: it never writes back to
 * application-history-storage.js, it only reads the fields it needs off
 * the records it's given.
 *
 * Low-level pieces (escapeICSText, createAllDayEvent, buildCalendar,
 * downloadICS) are exported separately from the Phase-8-specific builders
 * (buildApplicationExport, buildDailyExport) so a later phase can compose
 * new all-day events (e.g. "Follow up in 7 days") without duplicating the
 * ICS formatting logic.
 *
 * Exposed as window.LJECalendarExport (browser) / module.exports (tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.LJECalendarExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /**
   * Escapes text per RFC 5545 §3.3.11 for use in an ICS content value
   * (SUMMARY, DESCRIPTION, ...). Order matters: backslashes first, so the
   * escapes added for the other characters don't get double-escaped.
   * @param {*} value
   * @returns {string}
   */
  function escapeICSText(value) {
    return String(value == null ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");
  }

  /**
   * RFC 5545 §3.1: content lines longer than 75 octets must be folded —
   * split with a CRLF followed by a single leading space, which the
   * reader is required to strip back out. Applied per-line right before
   * the calendar is serialized.
   * @param {string} line
   * @returns {string}
   */
  function foldICSLine(line) {
    const LIMIT = 75;
    if (line.length <= LIMIT) {
      return line;
    }
    const parts = [line.slice(0, LIMIT)];
    let index = LIMIT;
    while (index < line.length) {
      parts.push(" " + line.slice(index, index + LIMIT - 1));
      index += LIMIT - 1;
    }
    return parts.join("\r\n");
  }

  function generateUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${crypto.randomUUID()}@linkedin-job-extractor`;
    }
    return `cal-${Date.now()}-${Math.random().toString(16).slice(2)}@linkedin-job-extractor`;
  }

  /**
   * DTSTAMP per RFC 5545: the UTC instant the entry was generated, not the
   * event's own (all-day, timezone-less) date.
   * @param {Date} date
   * @returns {string}
   */
  function formatUTCStamp(date) {
    return (
      `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
      `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
    );
  }

  function formatDateParts(year, month, day) {
    return `${year}${pad2(month)}${pad2(day)}`;
  }

  /**
   * The user's application date is what matters here (e.g. "August 9"),
   * not the instant in UTC it happened to be saved at — so this reads the
   * ISO timestamp's *local* date components, the same way the History
   * list's own date column already does.
   * @param {string} isoValue
   * @returns {string|null} 'YYYYMMDD', or null if isoValue isn't a valid date
   */
  function getLocalDateKey(isoValue) {
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  function dateKeyToLocalDate(dateKey) {
    const year = Number(dateKey.slice(0, 4));
    const month = Number(dateKey.slice(4, 6));
    const day = Number(dateKey.slice(6, 8));
    return new Date(year, month - 1, day);
  }

  /**
   * DTEND for an all-day VEVENT is exclusive per RFC 5545, so a
   * single-day event must end on the calendar day *after* it starts.
   * @param {string} dateKey 'YYYYMMDD'
   * @returns {string} 'YYYYMMDD', one calendar day later
   */
  function addOneDay(dateKey) {
    const local = dateKeyToLocalDate(dateKey);
    local.setDate(local.getDate() + 1);
    return formatDateParts(local.getFullYear(), local.getMonth() + 1, local.getDate());
  }

  function formatDateKeyISO(dateKey) {
    return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
  }

  function formatDateKeyLong(dateKey) {
    return dateKeyToLocalDate(dateKey).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric"
    });
  }

  function formatDateKeyShort(dateKey) {
    return dateKeyToLocalDate(dateKey).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
    });
  }

  /**
   * Filesystem-safe slug: lowercase, non-alphanumeric runs collapsed to a
   * single hyphen, leading/trailing hyphens trimmed. Falls back to a
   * generic label rather than producing an empty filename.
   * @param {string} text
   * @returns {string}
   */
  function sanitizeFilename(text) {
    const slug = String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "application";
  }

  /**
   * Builds the ICS lines for one all-day VEVENT. Deliberately generic —
   * not application-specific — so future all-day events (follow-up
   * reminders, interview dates) can reuse it directly.
   * @param {{ summary: string, description: string, dateStart: string, uid?: string }} params
   *   dateStart is 'YYYYMMDD', local to the user.
   * @returns {string[]} lines, unfolded (folding happens in buildCalendar)
   */
  function createAllDayEvent({ summary, description, dateStart, uid }) {
    return [
      "BEGIN:VEVENT",
      `UID:${uid || generateUID()}`,
      `DTSTAMP:${formatUTCStamp(new Date())}`,
      `DTSTART;VALUE=DATE:${dateStart}`,
      `DTEND;VALUE=DATE:${addOneDay(dateStart)}`,
      `SUMMARY:${escapeICSText(summary)}`,
      `DESCRIPTION:${escapeICSText(description)}`,
      "END:VEVENT"
    ];
  }

  /**
   * Wraps one or more VEVENT line blocks in a VCALENDAR, folding every
   * content line to RFC 5545 width and joining with the required CRLF.
   * @param {string[]} eventLines
   * @returns {string}
   */
  function buildCalendar(eventLines) {
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//LinkedIn Job Extractor//Calendar Export//EN",
      "CALSCALE:GREGORIAN",
      ...eventLines,
      "END:VCALENDAR"
    ];
    return lines.map(foldICSLine).join("\r\n") + "\r\n";
  }

  /**
   * @param {{ name?: string, filename?: string }|null|undefined} doc
   * @returns {string|null}
   */
  function docLabel(doc) {
    return (doc && (doc.name || doc.filename)) || null;
  }

  /**
   * Groups already newest-first-sorted records into same-local-day runs,
   * for the History UI's date grouping. Records with an unreadable
   * appliedAt fall into their own 'unknown' bucket rather than being
   * dropped. UI-only — does not touch storage.
   * @param {object[]} records
   * @returns {{ dateKey: string, records: object[] }[]}
   */
  function groupByAppliedDate(records) {
    const groups = [];
    records.forEach((record) => {
      const dateKey = getLocalDateKey(record.appliedAt) || "unknown";
      const last = groups[groups.length - 1];
      if (last && last.dateKey === dateKey) {
        last.records.push(record);
      } else {
        groups.push({ dateKey, records: [record] });
      }
    });
    return groups;
  }

  /**
   * The summary/description/date for one application's event — shared by
   * buildApplicationExport (single download) and buildSelectionExport
   * (several of these bundled into one file), so the two stay identical
   * in wording instead of drifting apart.
   * @param {object} record an Application History record
   * @returns {{ dateKey: string, company: string, summary: string, description: string }}
   */
  function buildApplicationEventFields(record) {
    const dateKey = getLocalDateKey(record.appliedAt) || getLocalDateKey(new Date().toISOString());
    const company = String(record.company || "").trim();
    const position = String(record.position || "").trim();

    const titleParts = ["Applied"];
    if (company) titleParts.push(company);
    if (position) titleParts.push(position);

    const descLines = [];
    if (company) descLines.push(`Company: ${company}`);
    if (position) descLines.push(`Position: ${position}`);
    descLines.push(`Applied: ${formatDateKeyLong(dateKey)}`);
    if (record.jobUrl) descLines.push(`Job URL: ${record.jobUrl}`);
    const resumeName = docLabel(record.resume);
    if (resumeName) descLines.push(`Resume: ${resumeName}`);
    const coverLetterName = docLabel(record.coverLetter);
    if (coverLetterName) descLines.push(`Cover Letter: ${coverLetterName}`);

    return {
      dateKey,
      company,
      summary: titleParts.join(" — "),
      description: descLines.join("\n")
    };
  }

  /**
   * Part 1 — one application, one all-day event on its appliedAt date.
   * @param {object} record an Application History record
   * @returns {{ filename: string, content: string }}
   */
  function buildApplicationExport(record) {
    const fields = buildApplicationEventFields(record);
    const content = buildCalendar(
      createAllDayEvent({
        summary: fields.summary,
        description: fields.description,
        dateStart: fields.dateKey
      })
    );
    const filename = `applied-${sanitizeFilename(fields.company || "application")}-${formatDateKeyISO(fields.dateKey)}.ics`;
    return { filename, content };
  }

  /**
   * User-driven multi-select export — bundles several individually-chosen
   * applications (which may span any mix of dates, unlike buildDailyExport)
   * into a single .ics file as one all-day VEVENT per application, so
   * importing it adds them all to the calendar in one step.
   * @param {object[]} records selected Application History records, in
   *   the order they should appear (whatever order the caller passes)
   * @returns {{ filename: string, content: string }|null} null if records is empty
   */
  function buildSelectionExport(records) {
    if (!records || !records.length) {
      return null;
    }
    const eventLines = records.flatMap((record) => {
      const fields = buildApplicationEventFields(record);
      return createAllDayEvent({
        summary: fields.summary,
        description: fields.description,
        dateStart: fields.dateKey
      });
    });
    const content = buildCalendar(eventLines);
    const filename = `applications-selected-${records.length}.ics`;
    return { filename, content };
  }

  /**
   * Part 2 — every application from one local calendar day, as a single
   * all-day summary event (not one event per application).
   * @param {string} dateKey 'YYYYMMDD'
   * @param {object[]} records applications applied to on that date
   * @returns {{ filename: string, content: string }}
   */
  function buildDailyExport(dateKey, records) {
    const count = records.length;
    const summary = `Job Applications — ${formatDateKeyShort(dateKey)} — ${count} application${count === 1 ? "" : "s"}`;

    const descLines = [`Applications: ${count}`, ""];
    records.forEach((record, index) => {
      const company = String(record.company || "").trim() || "Unknown company";
      const position = String(record.position || "").trim();
      descLines.push(`${index + 1}. ${company}`);
      if (position) descLines.push(`   ${position}`);
      if (record.jobUrl) descLines.push(`   ${record.jobUrl}`);
      descLines.push("");
    });
    while (descLines.length && descLines[descLines.length - 1] === "") {
      descLines.pop();
    }

    const content = buildCalendar(
      createAllDayEvent({
        summary,
        description: descLines.join("\n"),
        dateStart: dateKey
      })
    );
    const filename = `job-applications-${formatDateKeyISO(dateKey)}.ics`;
    return { filename, content };
  }

  /**
   * Triggers a browser download of the generated .ics content. Uses a
   * throwaway object URL + anchor click — the same mechanism any web page
   * can use — so no `downloads` permission is needed in the manifest.
   * @param {string} filename
   * @param {string} content
   */
  function downloadICS(filename, content) {
    const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    // Low-level / reusable building blocks
    escapeICSText,
    createAllDayEvent,
    buildCalendar,
    downloadICS,
    sanitizeFilename,
    getLocalDateKey,
    formatDateKeyISO,
    formatDateKeyLong,
    formatDateKeyShort,
    addOneDay,
    groupByAppliedDate,

    // Phase 8 builders
    buildApplicationExport,
    buildDailyExport,
    buildSelectionExport
  };
});
