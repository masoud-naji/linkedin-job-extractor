const assert = require('assert');
const { extractJobIdFromUrl, normalizeLinkedInUrl, isRealSalary } = require('../parsers');

function run() {
  assert.strictEqual(extractJobIdFromUrl('https://www.linkedin.com/jobs/view/senior-engineer-at-acme-123456'), '123456');
  assert.strictEqual(extractJobIdFromUrl('https://www.linkedin.com/jobs/view/123456'), '123456');
  assert.strictEqual(extractJobIdFromUrl('https://www.linkedin.com/jobs/view/123456?refId=abc'), '123456');
  assert.strictEqual(extractJobIdFromUrl('/jobs/view/123456'), '123456');
  assert.strictEqual(extractJobIdFromUrl('https://example.com/jobs/view/123456'), '');

  assert.strictEqual(
    normalizeLinkedInUrl('https://www.linkedin.com/company/acme?utm=1#section'),
    'https://www.linkedin.com/company/acme'
  );
  assert.strictEqual(normalizeLinkedInUrl('https://example.com/company/acme'), '');

  assert.strictEqual(isRealSalary('$20'), false);
  assert.strictEqual(isRealSalary('$123K/yr'), true);
  assert.strictEqual(isRealSalary('$123K/yr - $215.2K/yr'), true);
  assert.strictEqual(isRealSalary('$85,000'), true);
  assert.strictEqual(isRealSalary('$0'), false);

  console.log('parser tests passed');
}

run();
