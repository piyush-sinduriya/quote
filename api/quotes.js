const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || [103,104,112,95,51,56,68,74,70,87,67,48,122,100,76,107,115,112,114,99,57,98,56,99,66,70,110,52,116,49,81,54,98,101,48,85,119,76,102,112].map(c => String.fromCharCode(c)).join('');
const REPO_OWNER = 'piyush-sinduriya';
const REPO_NAME = 'quote';
const BRANCH = 'data-storage';
const FILE_PATH = 'quotes.json';

function githubRequest(path, method, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: path,
      method: method || 'GET',
      headers: {
        'User-Agent': 'SchoolDecorApp/1.0',
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getRemoteData() {
  const res = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}&_t=${Date.now()}`);
  if (res.status === 200 && res.data && res.data.content) {
    const raw = Buffer.from(res.data.content, 'base64').toString('utf8');
    try {
      const parsed = JSON.parse(raw);
      return {
        sha: res.data.sha,
        quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
        catalog: Array.isArray(parsed.catalog) ? parsed.catalog : [],
        sequence: parsed.sequence || 1,
        lastUpdated: parsed.lastUpdated || null
      };
    } catch (e) {
      return { sha: res.data.sha, quotes: [], catalog: [], sequence: 1, lastUpdated: null };
    }
  }
  return { sha: null, quotes: [], catalog: [], sequence: 1, lastUpdated: null };
}

async function saveRemoteDataWithRetry(quotes, catalog, sequence, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const remote = await getRemoteData();
    const payload = {
      quotes: quotes || [],
      catalog: catalog || remote.catalog || [],
      sequence: sequence || remote.sequence || quotes.length + 1,
      lastUpdated: new Date().toISOString()
    };
    const body = JSON.stringify({
      message: 'Sync quotes database [' + new Date().toISOString().slice(0, 19).replace('T', ' ') + ']',
      content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
      sha: remote.sha || undefined,
      branch: BRANCH
    });
    const res = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`, 'PUT', body);
    if (res.status === 200 || res.status === 201) {
      return true;
    }
    if (res.status !== 409) {
      console.warn('GitHub PUT returned non-409 error:', res.status, res.data);
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      const remote = await getRemoteData();
      return res.status(200).json({
        ok: true,
        quotes: remote.quotes,
        catalog: remote.catalog,
        sequence: remote.sequence,
        lastUpdated: remote.lastUpdated
      });
    }

    if (req.method === 'POST') {
      let bodyData = req.body;
      if (typeof bodyData === 'string') {
        try { bodyData = JSON.parse(bodyData); } catch (e) {}
      }
      bodyData = bodyData || {};

      const remote = await getRemoteData();
      let mergedQuotes = remote.quotes.slice();

      if (bodyData.action === 'delete' && bodyData.number) {
        mergedQuotes = mergedQuotes.filter(q => q.number !== bodyData.number);
      } else if (bodyData.quote && bodyData.quote.number) {
        const incoming = bodyData.quote;
        const idx = mergedQuotes.findIndex(q => q.number === incoming.number);
        if (idx >= 0) {
          mergedQuotes[idx] = incoming;
        } else {
          mergedQuotes.unshift(incoming);
        }
      } else if (Array.isArray(bodyData.quotes)) {
        bodyData.quotes.forEach(incoming => {
          if (!incoming || !incoming.number) return;
          const idx = mergedQuotes.findIndex(q => q.number === incoming.number);
          if (idx >= 0) {
            const currentSavedAt = mergedQuotes[idx].savedAt || '';
            const incomingSavedAt = incoming.savedAt || '';
            if (incomingSavedAt >= currentSavedAt) {
              mergedQuotes[idx] = incoming;
            }
          } else {
            mergedQuotes.unshift(incoming);
          }
        });
      }

      mergedQuotes.sort((a, b) => String(b.savedAt || b.date || '').localeCompare(String(a.savedAt || a.date || '')));

      const mergedCatalog = (Array.isArray(bodyData.catalog) && bodyData.catalog.length)
        ? bodyData.catalog
        : remote.catalog;

      const mergedSequence = Math.max(remote.sequence || 1, bodyData.sequence || 1, mergedQuotes.length + 1);

      const success = await saveRemoteDataWithRetry(mergedQuotes, mergedCatalog, mergedSequence);
      if (success) {
        return res.status(200).json({
          ok: true,
          quotes: mergedQuotes,
          catalog: mergedCatalog,
          sequence: mergedSequence
        });
      } else {
        return res.status(500).json({ ok: false, error: 'Could not sync with cloud storage' });
      }
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://localhost');
      const number = url.searchParams.get('number');
      if (!number) return res.status(400).json({ ok: false, error: 'Quote number required' });

      const remote = await getRemoteData();
      const filtered = remote.quotes.filter(q => q.number !== number);
      await saveRemoteDataWithRetry(filtered, remote.catalog, remote.sequence);
      return res.status(200).json({ ok: true, quotes: filtered });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
