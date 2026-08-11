(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.parsers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function extractJobIdFromUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ''), 'https://www.linkedin.com');
    } catch (_error) {
      return '';
    }

    if (!parsed.hostname.endsWith('linkedin.com')) {
      return '';
    }

    const text = parsed.href;
    const patterns = [
      /\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})/i,
      /currentJobId=(\d+)/i,
      /jobId=(\d+)/i,
      /jobs-apply.*?(\d{6,})/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return '';
  }

  function normalizeLinkedInUrl(href) {
    if (!href) {
      return '';
    }
    try {
      const url = new URL(href, 'https://www.linkedin.com');
      if (!url.hostname.endsWith('linkedin.com')) {
        return '';
      }
      url.search = '';
      url.hash = '';
      return url.href;
    } catch (_error) {
      return '';
    }
  }

  function buildJobViewUrl(jobId) {
    const id = String(jobId || '').trim();
    if (!/^\d+$/.test(id)) {
      return '';
    }
    return `https://www.linkedin.com/jobs/view/${id}/`;
  }

  function isRealSalary(value) {
    const v = String(value || '');
    if (!/[\$€£₹]/.test(v)) {
      return false;
    }
    const hasK = /\d\s?[kK]\b/.test(v);
    const hasUnit = /(?:\/yr|\/hr|\/hour|\/mo|per\s+(?:year|annum|hour|month)|a\s+(?:year|hour|month)|hourly|annually)/i.test(v);
    const amounts = (v.match(/\d[\d,.]*/g) || [])
      .map((n) => parseFloat(n.replace(/,/g, '')))
      .filter((n) => !Number.isNaN(n));
    const maxAmount = amounts.length ? Math.max(...amounts) : 0;
    return hasK || hasUnit || maxAmount >= 1000;
  }

  return {
    extractJobIdFromUrl,
    normalizeLinkedInUrl,
    buildJobViewUrl,
    isRealSalary
  };
});
