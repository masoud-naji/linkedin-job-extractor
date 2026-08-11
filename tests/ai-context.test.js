const assert = require('assert');
const aiContext = require('../ai-context');

function run() {
  // Empty fields omitted, not emitted as "" — profile-storage.js's
  // emptyProfile() always has every field present, even unset ones.
  const minimal = aiContext.buildProfileContext({
    id: 'p1',
    name: 'General Frontend',
    fullName: 'Jane Doe',
    email: '',
    phone: '',
    linkedinUrl: '',
    portfolioUrl: '',
    githubUrl: '',
    currentTitle: '',
    location: '',
    notes: '',
    resumeJson: '',
    resumePdf: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.deepStrictEqual(minimal, { profileName: 'General Frontend', fullName: 'Jane Doe' });
  assert.ok(!('email' in minimal));
  assert.ok(!('id' in minimal));
  assert.ok(!('createdAt' in minimal));
  assert.ok(!('updatedAt' in minimal));
  assert.ok(!('resumePdf' in minimal));

  // Populated profile: internal metadata excluded, resumeJson parsed
  // into a real nested object (not left as a doubly-escaped string).
  const full = aiContext.buildProfileContext({
    id: 'p2',
    name: 'React / Next.js',
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    phone: '555-1234',
    currentTitle: 'Senior Frontend Engineer',
    location: 'Remote',
    linkedinUrl: 'https://linkedin.com/in/jane',
    portfolioUrl: 'https://jane.dev',
    githubUrl: 'https://github.com/jane',
    notes: 'Prefers remote roles.',
    resumeJson: JSON.stringify({ yearsExperience: 10, skills: ['React', 'Next.js'] }),
    resumePdf: { fileName: 'resume.pdf', dataUrl: 'data:application/pdf;base64,AAAA' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z'
  });
  assert.strictEqual(full.profileName, 'React / Next.js');
  assert.strictEqual(full.email, 'jane@example.com');
  assert.deepStrictEqual(full.resume, { yearsExperience: 10, skills: ['React', 'Next.js'] });
  assert.ok(!('id' in full));
  assert.ok(!('resumePdf' in full));
  assert.ok(!JSON.stringify(full).includes('base64'));

  // Non-JSON resumeJson text is kept, not dropped or summarized.
  const plainTextResume = aiContext.buildProfileContext({
    name: 'AEM',
    fullName: 'Jane Doe',
    resumeJson: 'Just some plain notes, not JSON.'
  });
  assert.strictEqual(plainTextResume.resume, 'Just some plain notes, not JSON.');

  // buildJobChatPayload: prompt, then the CURRENT job verbatim (same shape
  // "Copy as JSON" already serializes), with profile context only when given.
  const job = {
    jobTitle: 'Senior Frontend Engineer',
    companyName: 'Harvey',
    location: 'Remote',
    workplaceType: 'Remote',
    salary: '$180K/yr',
    description: 'Build things.',
    skills: ['React', 'TypeScript'],
    jobUrl: 'https://www.linkedin.com/jobs/view/123456',
    jobId: '123456'
  };

  const payloadNoContext = aiContext.buildJobChatPayload({ prompt: 'Review this job.', job, profileContext: null });
  assert.ok(payloadNoContext.startsWith('[USER PROMPT]\n\nReview this job.'));
  assert.ok(payloadNoContext.includes('[CURRENT JOB]'));
  assert.ok(payloadNoContext.includes('"jobTitle": "Senior Frontend Engineer"'));
  assert.ok(payloadNoContext.includes('"jobUrl": "https://www.linkedin.com/jobs/view/123456"'));
  assert.ok(!payloadNoContext.includes('[PROFILE CONTEXT]'));

  const payloadWithContext = aiContext.buildJobChatPayload({
    prompt: 'Review this job.',
    job,
    profileContext: full
  });
  assert.ok(payloadWithContext.includes('[PROFILE CONTEXT]'));
  assert.ok(payloadWithContext.includes('"profileName": "React / Next.js"'));
  // Order matters per spec: prompt, then job, then profile context.
  const promptIndex = payloadWithContext.indexOf('[USER PROMPT]');
  const jobIndex = payloadWithContext.indexOf('[CURRENT JOB]');
  const contextIndex = payloadWithContext.indexOf('[PROFILE CONTEXT]');
  assert.ok(promptIndex < jobIndex);
  assert.ok(jobIndex < contextIndex);

  // Empty profile context object (e.g. include-context on but no active
  // profile fields set) is omitted, not emitted as "{}".
  const payloadEmptyContext = aiContext.buildJobChatPayload({ prompt: 'x', job, profileContext: {} });
  assert.ok(!payloadEmptyContext.includes('[PROFILE CONTEXT]'));

  console.log('ai-context tests passed');
}

run();
