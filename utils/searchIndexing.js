const https = require('https');
const { JWT } = require('google-auth-library');

function postJson(urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, data });
        } else {
          reject(new Error(`${url.hostname} ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function submitIndexNow(urls) {
  const key = process.env.INDEXNOW_KEY || process.env.BING_INDEXNOW_KEY;
  if (!key) return { skipped: true, reason: 'INDEXNOW_KEY not set' };

  const host = process.env.INDEXNOW_HOST || 'workindex.co.in';
  const keyLocation = process.env.INDEXNOW_KEY_LOCATION || `https://${host}/${key}.txt`;
  await postJson('https://api.indexnow.org/indexnow', {
    host,
    key,
    keyLocation,
    urlList: urls
  });
  return { submitted: true, count: urls.length };
}

async function submitGoogleIndexing(urls) {
  const clientEmail = process.env.GOOGLE_INDEXING_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_INDEXING_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    return { skipped: true, reason: 'Google indexing service account env not set' };
  }

  const client = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/indexing']
  });
  const token = await client.authorize();
  for (const url of urls) {
    await postJson(
      'https://indexing.googleapis.com/v3/urlNotifications:publish',
      { url, type: 'URL_UPDATED' },
      { Authorization: `Bearer ${token.access_token}` }
    );
  }
  return { submitted: true, count: urls.length };
}

async function submitGoogleSitemap() {
  const clientEmail = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL || process.env.GOOGLE_INDEXING_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY || process.env.GOOGLE_INDEXING_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const siteUrl = process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL || 'https://workindex.co.in/';
  const sitemapUrl = process.env.GOOGLE_SITEMAP_URL || 'https://workindex.co.in/sitemap.xml';
  if (!clientEmail || !privateKey) {
    return { skipped: true, reason: 'Google Search Console service account env not set' };
  }

  const client = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/webmasters']
  });
  const token = await client.authorize();
  const path = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path,
      method: 'PUT',
      headers: { Authorization: `Bearer ${token.access_token}` }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, data });
        else reject(new Error(`Google Search Console ${res.statusCode}: ${data.substring(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
  return { submitted: true, sitemapUrl };
}

async function submitUrlsToSearchEngines(urls) {
  const uniqueUrls = [...new Set((urls || []).filter(Boolean))];
  if (!uniqueUrls.length) return { indexNow: { skipped: true }, google: { skipped: true } };

  const result = {};
  try {
    result.indexNow = await submitIndexNow(uniqueUrls);
  } catch (err) {
    result.indexNow = { submitted: false, error: err.message };
  }
  try {
    result.google = await submitGoogleIndexing(uniqueUrls);
  } catch (err) {
    result.google = { submitted: false, error: err.message };
  }
  try {
    result.googleSitemap = await submitGoogleSitemap();
  } catch (err) {
    result.googleSitemap = { submitted: false, error: err.message };
  }
  return result;
}

module.exports = { submitUrlsToSearchEngines };
