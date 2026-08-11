const assert = require('assert');
const calendarExport = require('../calendar-export');

// RFC 5545 folding inserts "\r\n " mid-line at the 75-octet boundary;
// undo that before doing substring checks against logical field values,
// the same way a real ICS parser would unfold before reading content.
function unfold(content) {
  return content.replace(/\r\n /g, '');
}

// Builds an ISO timestamp from *local* date/time components (mirroring
// how Date.prototype.toISOString() is produced by application-history-
// storage.js's own `new Date().toISOString()`), so fixtures land on the
// intended calendar day regardless of which timezone the test runs in —
// a naive hardcoded UTC-midnight string would land on the *previous*
// local day west of UTC.
function localISO(year, month, day, hour) {
  return new Date(year, month - 1, day, hour == null ? 12 : hour).toISOString();
}

function run() {
  // Escaping: backslash, semicolon, comma, newline
  assert.strictEqual(
    calendarExport.escapeICSText('AT&T; R&D, Inc.\nLine two'),
    'AT&T\\; R&D\\, Inc.\\nLine two'
  );
  assert.strictEqual(calendarExport.escapeICSText(null), '');
  assert.strictEqual(calendarExport.escapeICSText(undefined), '');

  // All-day DTEND is the following calendar day, including month rollover.
  assert.strictEqual(calendarExport.addOneDay('20260809'), '20260810');
  assert.strictEqual(calendarExport.addOneDay('20260831'), '20260901');
  assert.strictEqual(calendarExport.addOneDay('20261231'), '20270101');

  // Filename sanitization
  assert.strictEqual(calendarExport.sanitizeFilename('Harvey, Inc. (Frontend)'), 'harvey-inc-frontend');
  assert.strictEqual(calendarExport.sanitizeFilename(''), 'application');
  assert.strictEqual(calendarExport.sanitizeFilename('  '), 'application');

  // 1. Single application with all metadata
  const full = {
    id: '1',
    company: 'Harvey',
    position: 'Senior Software Engineer, Frontend',
    jobUrl: 'https://jobs.example.com/harvey/123',
    appliedAt: localISO(2026, 8, 9, 15),
    resume: { name: 'Frontend Resume' },
    coverLetter: { name: 'Harvey Cover' }
  };
  const fullExport = calendarExport.buildApplicationExport(full);
  const fullUnfolded = unfold(fullExport.content);
  assert.ok(fullExport.filename.startsWith('applied-harvey-'));
  assert.ok(fullExport.filename.endsWith('.ics'));
  assert.ok(fullUnfolded.includes('SUMMARY:Applied — Harvey — Senior Software Engineer\\, Frontend'));
  assert.ok(fullUnfolded.includes('Company: Harvey'));
  assert.ok(fullUnfolded.includes('Job URL: https://jobs.example.com/harvey/123'));
  assert.ok(fullUnfolded.includes('Resume: Frontend Resume'));
  assert.ok(fullUnfolded.includes('Cover Letter: Harvey Cover'));
  assert.ok(fullUnfolded.includes('DTSTART;VALUE=DATE:'));
  assert.ok(fullUnfolded.includes('DTEND;VALUE=DATE:'));
  assert.ok(!/null|undefined/i.test(fullUnfolded));

  // 2. Application without resume
  const noResume = { ...full, resume: null };
  const noResumeUnfolded = unfold(calendarExport.buildApplicationExport(noResume).content);
  assert.ok(!noResumeUnfolded.includes('Resume:'));
  assert.ok(!/null|undefined/i.test(noResumeUnfolded));

  // 3. Application without cover letter
  const noCover = { ...full, coverLetter: null };
  const noCoverUnfolded = unfold(calendarExport.buildApplicationExport(noCover).content);
  assert.ok(!noCoverUnfolded.includes('Cover Letter:'));

  // 4. Application without job URL
  const noUrl = { ...full, jobUrl: '' };
  const noUrlUnfolded = unfold(calendarExport.buildApplicationExport(noUrl).content);
  assert.ok(!noUrlUnfolded.includes('Job URL:'));

  // DTSTART/DTEND correctness for a known date, no invented timezone
  assert.ok(fullUnfolded.includes('DTSTART;VALUE=DATE:20260809'));
  assert.ok(fullUnfolded.includes('DTEND;VALUE=DATE:20260810'));
  assert.ok(!fullUnfolded.includes('TZID'));

  // 5 & 6. Grouping same-day vs different-day applications
  const recA = { id: 'a', company: 'Harvey', position: 'Frontend', jobUrl: 'https://x/a', appliedAt: localISO(2026, 8, 9, 10) };
  const recB = { id: 'b', company: 'Databricks', position: 'Staff Frontend', jobUrl: 'https://x/b', appliedAt: localISO(2026, 8, 9, 9) };
  const recC = { id: 'c', company: 'Figma', position: 'Senior SWE', jobUrl: 'https://x/c', appliedAt: localISO(2026, 8, 8, 9) };
  const groups = calendarExport.groupByAppliedDate([recA, recB, recC]);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].records.length, 2);
  assert.strictEqual(groups[1].records.length, 1);

  // Multi-select export — one VEVENT per selected application (unlike
  // buildDailyExport's single bundled event), can span multiple dates.
  assert.strictEqual(calendarExport.buildSelectionExport([]), null);
  const selectionExport = calendarExport.buildSelectionExport([recA, recC]);
  const selectionUnfolded = unfold(selectionExport.content);
  assert.strictEqual((selectionExport.content.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.ok(selectionUnfolded.includes('SUMMARY:Applied — Harvey — Frontend'));
  assert.ok(selectionUnfolded.includes('SUMMARY:Applied — Figma — Senior SWE'));
  assert.strictEqual(selectionExport.filename, 'applications-selected-2.ics');

  // Daily summary event — one event, not one per application
  const dayExport = calendarExport.buildDailyExport(groups[0].dateKey, groups[0].records);
  const dayUnfolded = unfold(dayExport.content);
  assert.strictEqual((dayExport.content.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(dayUnfolded.includes('Applications: 2'));
  assert.ok(dayUnfolded.includes('1. Harvey'));
  assert.ok(dayUnfolded.includes('2. Databricks'));
  assert.ok(dayExport.filename.startsWith('job-applications-'));

  // 7. Special characters in company/title
  const special = {
    id: 's',
    company: "O'Brien & Sons, LLC",
    position: 'Frontend/Backend (Full-Stack)',
    jobUrl: 'https://example.com/x?y=1&z=2',
    appliedAt: localISO(2026, 8, 9, 10)
  };
  const specialUnfolded = unfold(calendarExport.buildApplicationExport(special).content);
  assert.ok(specialUnfolded.includes("O'Brien & Sons\\, LLC"));
  assert.ok(specialUnfolded.includes('Frontend/Backend (Full-Stack)'));
  assert.ok(calendarExport.buildApplicationExport(special).filename.startsWith('applied-o-brien-sons-llc-'));

  // 8. Existing older History record missing optional fields entirely
  const legacy = { id: 'legacy', company: 'OldCo', position: '', appliedAt: localISO(2020, 1, 1, 12) };
  const legacyUnfolded = unfold(calendarExport.buildApplicationExport(legacy).content);
  assert.ok(!/null|undefined/i.test(legacyUnfolded));
  assert.ok(legacyUnfolded.includes('DTSTART;VALUE=DATE:20200101'));
  assert.ok(legacyUnfolded.includes('DTEND;VALUE=DATE:20200102'));

  console.log('calendar-export tests passed');
}

run();
