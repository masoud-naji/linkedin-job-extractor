const assert = require('assert');
const aiSettings = require('../ai-settings');

function run() {
  // Provider lookup — pure, no chrome.storage involved.
  assert.strictEqual(aiSettings.getProvider('gemini').label, 'Gemini');
  assert.strictEqual(aiSettings.getProvider('claude').label, 'Claude');
  assert.strictEqual(aiSettings.getProvider('not-a-real-provider').id, aiSettings.DEFAULT_PROVIDER_ID);
  assert.strictEqual(aiSettings.AI_PROVIDERS.length, 3);
  assert.strictEqual(aiSettings.DEFAULT_PROVIDER_ID, 'chatgpt');

  // Default prompt is non-empty, sensible text — sanity check only, not
  // pinning exact wording so copy changes don't break the test suite.
  assert.ok(typeof aiSettings.DEFAULT_PROMPT === 'string' && aiSettings.DEFAULT_PROMPT.length > 20);

  console.log('ai-settings tests passed');
}

run();
