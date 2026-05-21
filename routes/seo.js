const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const { submitUrlsToSearchEngines } = require('../utils/searchIndexing');

const ADSENSE_SNIPPET = '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2627739469695660" crossorigin="anonymous"></script>';
const ADSENSE_META_TAG = '<meta name="google-adsense-account" content="ca-pub-2627739469695660">';

// Reuse admin protect middleware
const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, message: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ success: false });
    req.admin = await Admin.findById(decoded.id);
    if (!req.admin || !req.admin.isActive) return res.status(403).json({ success: false });
    next();
  } catch (e) { res.status(401).json({ success: false }); }
};

function superOnly(req, res, next) {
  if (req.admin.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super admin only' });
  }
  next();
}

function sanitizeSeoSlug(input) {
  var raw = String(input || '').trim().toLowerCase().replace(/\\/g, '/');
  raw = raw.replace(/^\/+/, '').replace(/\.html$/i, '');
  if (!raw.startsWith('seo-pages/')) raw = 'seo-pages/' + raw;
  var parts = raw.split('/')
    .filter(Boolean)
    .map(function(part) {
      return part.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    })
    .filter(Boolean);
  if (parts[0] !== 'seo-pages') parts.unshift('seo-pages');
  return parts.join('/');
}

// ── Generate HTML from template ──
function generateSeoPage(data) {
  var {
    slug, title, metaDescription, metaKeywords,
    heroEyebrow, heroH1, heroH1Span, heroP,
    statsLabel, statsPrice, service,
    step1Title, step1P, step2Title, step2P, step3Title, step3P, step4Title, step4P,
    price1Label, price1Range, price1Desc,
    price2Label, price2Range, price2Desc,
    price3Label, price3Range, price3Desc,
    price4Label, price4Range, price4Desc,
    faq1Q, faq1A, faq2Q, faq2A, faq3Q, faq3A, faq4Q, faq4A, faq5Q, faq5A,
    ctaH2, ctaP,
    footerLinks, city, state
  } = data;

  var canonical = 'https://workindex.co.in/' + slug + '.html';

  var footerLinksHtml = (footerLinks || []).map(function(l) {
    return '<a href="' + l.href + '">' + l.label + '</a>';
  }).join('\n    ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
${ADSENSE_META_TAG}
<title>${title}</title>
<meta name="description" content="${metaDescription}"/>
<meta name="keywords" content="${metaKeywords}"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:title" content="${title}"/>
<meta property="og:description" content="${metaDescription}"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:type" content="website"/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<link rel="stylesheet" href="/lp-styles.css"/>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Service",
  "name": "${heroH1} ${heroH1Span}",
  "provider": { "@type": "Organization", "name": "WorkIndex", "url": "https://workindex.co.in" },
  "description": "${metaDescription}",
  "areaServed": { "@type": "${city ? 'City' : 'State'}", "name": "${city || state}" },
  "serviceType": "${service}",
  "offers": { "@type": "AggregateOffer", "priceCurrency": "INR", "lowPrice": "${statsPrice.replace(/[^0-9]/g,'')}", "offerCount": "20+" }
}
<\/script>
${ADSENSE_SNIPPET}
</head>
<body>

<nav class="lp-nav">
  <a href="/" class="lp-nav-logo">
    <div class="lp-nav-logo-icon">W</div>
    <span class="lp-nav-logo-text">WorkIndex</span>
  </a>
  <a href="https://workindex.co.in/?signup=true" class="lp-nav-cta">Post for Free →</a>
</nav>

<div class="lp-breadcrumb">
  <a href="/">WorkIndex</a><span>›</span>
  <a href="#">Services</a><span>›</span>
  ${city || state}
</div>

<section class="lp-hero">
  <div class="lp-hero-eyebrow">
    <div class="lp-hero-eyebrow-dot"></div>
    ${heroEyebrow}
  </div>
  <h1>${heroH1}<br><span>${heroH1Span}</span></h1>
  <p>${heroP}</p>
  <a href="https://workindex.co.in/?signup=true" class="lp-hero-cta">Post Your Requirement — It's Free →</a>
  <div class="lp-hero-trust">
    <div class="lp-trust-item">✅ Verified Experts</div>
    <div class="lp-trust-item">⚡ Quotes in 24 hours</div>
    <div class="lp-trust-item">🔒 No spam calls</div>
    <div class="lp-trust-item">💯 Free to post</div>
  </div>
</section>

<div class="lp-stats">
  <div class="lp-stat"><div class="lp-stat-value">Find</div><div class="lp-stat-label">${statsLabel}</div></div>
  <div class="lp-stat"><div class="lp-stat-value">${statsPrice}</div><div class="lp-stat-label">Starting Price</div></div>
  <div class="lp-stat"><div class="lp-stat-value">24 hrs</div><div class="lp-stat-label">Avg Response Time</div></div>
</div>

<section class="lp-section">
  <div class="lp-section-eyebrow">How It Works</div>
  <h2 class="lp-section-title">Get started in 3 simple steps</h2>
  <p class="lp-section-sub">Post your requirement and let verified professionals come to you.</p>
  <div class="lp-steps">
    <div class="lp-step"><div class="lp-step-num">1</div><h3>${step1Title}</h3><p>${step1P}</p></div>
    <div class="lp-step"><div class="lp-step-num">2</div><h3>${step2Title}</h3><p>${step2P}</p></div>
    <div class="lp-step"><div class="lp-step-num">3</div><h3>${step3Title}</h3><p>${step3P}</p></div>
    <div class="lp-step"><div class="lp-step-num">4</div><h3>${step4Title}</h3><p>${step4P}</p></div>
  </div>
</section>

<div class="lp-pricing-section">
  <div class="lp-pricing-inner">
    <div class="lp-section-eyebrow">Pricing Guide</div>
    <h2 class="lp-section-title">Typical Costs</h2>
    <p class="lp-section-sub">Market rates. Compare quotes to find the best price.</p>
    <div class="lp-price-grid">
      <div class="lp-price-card"><div class="lp-price-card-label">${price1Label}</div><div class="lp-price-card-range">${price1Range}</div><div class="lp-price-card-desc">${price1Desc}</div></div>
      <div class="lp-price-card"><div class="lp-price-card-label">${price2Label}</div><div class="lp-price-card-range">${price2Range}</div><div class="lp-price-card-desc">${price2Desc}</div></div>
      <div class="lp-price-card"><div class="lp-price-card-label">${price3Label}</div><div class="lp-price-card-range">${price3Range}</div><div class="lp-price-card-desc">${price3Desc}</div></div>
      <div class="lp-price-card"><div class="lp-price-card-label">${price4Label}</div><div class="lp-price-card-range">${price4Range}</div><div class="lp-price-card-desc">${price4Desc}</div></div>
    </div>
  </div>
</div>

<section class="lp-faq">
  <div class="lp-faq-inner">
    <div class="lp-section-eyebrow">FAQ</div>
    <h2 class="lp-section-title" style="margin-bottom:32px">Frequently Asked Questions</h2>
    <div class="lp-faq-item"><div class="lp-faq-q" onclick="this.parentElement.classList.toggle('open')">${faq1Q} <span class="arrow">▾</span></div><div class="lp-faq-a">${faq1A}</div></div>
    <div class="lp-faq-item"><div class="lp-faq-q" onclick="this.parentElement.classList.toggle('open')">${faq2Q} <span class="arrow">▾</span></div><div class="lp-faq-a">${faq2A}</div></div>
    <div class="lp-faq-item"><div class="lp-faq-q" onclick="this.parentElement.classList.toggle('open')">${faq3Q} <span class="arrow">▾</span></div><div class="lp-faq-a">${faq3A}</div></div>
    <div class="lp-faq-item"><div class="lp-faq-q" onclick="this.parentElement.classList.toggle('open')">${faq4Q} <span class="arrow">▾</span></div><div class="lp-faq-a">${faq4A}</div></div>
    <div class="lp-faq-item"><div class="lp-faq-q" onclick="this.parentElement.classList.toggle('open')">${faq5Q} <span class="arrow">▾</span></div><div class="lp-faq-a">${faq5A}</div></div>
  </div>
</section>

<div class="lp-cta-banner">
  <h2>${ctaH2}</h2>
  <p>${ctaP}</p>
  <a href="https://workindex.co.in/?signup=true" class="lp-cta-white">Post for Free — Takes 2 Minutes →</a>
</div>

<footer class="lp-footer">
  <div class="lp-footer-links">
    <a href="/">Home</a>
    ${footerLinksHtml}
    <a href="/contact.html">Contact</a>
    <a href="/terms.html">Terms</a>
  </div>
  <p>© 2026 WorkIndex. Find verified professionals across India. | <a href="/">workindex.co.in</a></p>
</footer>

</body>
</html>`;
}

// ── Push file to GitHub ──
async function pushToGitHub(filename, content) {
  var https = require('https');
  var GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  var GITHUB_REPO = 'ravishhegde7/WorkIndex'; // your frontend repo
  var path = filename; // e.g. "itr-filing-belgaum.html"

  // Check if file already exists to get its SHA (needed for updates)
  var sha = null;
  try {
    var existing = await githubApiGet('/repos/' + GITHUB_REPO + '/contents/' + path, GITHUB_TOKEN);
    sha = existing.sha;
  } catch(e) { /* file doesn't exist yet — that's fine */ }

  var body = JSON.stringify({
    message: 'Add SEO page: ' + filename,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {})
  });

  return await githubApiPut('/repos/' + GITHUB_REPO + '/contents/' + path, GITHUB_TOKEN, body);
}

async function updateSitemap(slug) {
  try {
    var current = await githubApiGet(
      '/repos/ravishhegde7/WorkIndex/contents/sitemap.xml',
      process.env.GITHUB_TOKEN
    );
    var content = Buffer.from(current.content, 'base64').toString('utf8');
    var today = new Date().toISOString().split('T')[0];
    var newEntry = '\n  <url><loc>https://workindex.co.in/' + slug + '.html</loc><priority>0.7</priority><changefreq>monthly</changefreq><lastmod>' + today + '</lastmod></url>';

    if (content.includes(slug + '.html')) return;

    var updated = content.replace('</urlset>', newEntry + '\n</urlset>');

    var body = JSON.stringify({
      message: 'Add ' + slug + '.html to sitemap',
      content: Buffer.from(updated).toString('base64'),
      sha: current.sha
    });

    await githubApiPut(
      '/repos/ravishhegde7/WorkIndex/contents/sitemap.xml',
      process.env.GITHUB_TOKEN,
      body
    );
    console.log('✅ Sitemap updated with', slug);
  } catch(e) {
    console.error('Sitemap update failed (non-fatal):', e.message);
  }
}

function githubApiGet(path, token) {
  return new Promise((resolve, reject) => {
    var options = {
      hostname: 'api.github.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'WorkIndex-Admin',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    var req = require('https').request(options, (res) => {
      var data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data));
        else reject(new Error('GitHub GET failed: ' + res.statusCode));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function githubApiPut(path, token, body) {
  return new Promise((resolve, reject) => {
    var options = {
      hostname: 'api.github.com',
      path: path,
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'WorkIndex-Admin',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var req = require('https').request(options, (res) => {
      var data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) resolve(JSON.parse(data));
        else reject(new Error('GitHub PUT failed: ' + res.statusCode + ' ' + data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GET all SEO pages ──
router.get('/pages', protect, superOnly, async (req, res) => {
  try {
    var SeoPage = require('../models/SeoPage');
    var pages = await SeoPage.find({}).sort({ createdAt: -1 });
    res.json({ success: true, pages });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── CREATE SEO page ──
router.post('/pages', protect, superOnly, async (req, res) => {
  try {
    var SeoPage = require('../models/SeoPage');
    var data = req.body;

    if (!data.slug || !data.title || !data.metaDescription) {
      return res.status(400).json({ success: false, message: 'slug, title, and metaDescription are required' });
    }

    data.slug = sanitizeSeoSlug(data.slug);

    // Generate HTML
    var html = generateSeoPage(data);

    // Push to GitHub
    if (!process.env.GITHUB_TOKEN) {
      return res.status(500).json({ success: false, message: 'GITHUB_TOKEN not set in Railway env vars' });
    }
    await pushToGitHub(data.slug + '.html', html);
    var publishedUrl = 'https://workindex.co.in/' + data.slug + '.html';
     await updateSitemap(data.slug); // ← auto-updates sitemap.xml

    // Save record in MongoDB
    var indexing = await submitUrlsToSearchEngines([publishedUrl]);

    var existing = await SeoPage.findOne({ slug: data.slug });
    if (existing) {
      await SeoPage.findByIdAndUpdate(existing._id, { ...data, updatedAt: new Date() });
    } else {
      await SeoPage.create({ ...data, createdBy: req.admin.adminId });
    }

    res.json({
      success: true,
      message: 'Page created and pushed to GitHub. Netlify will deploy in ~30 seconds.',
      url: publishedUrl,
      indexing
    });
  } catch(err) {
    console.error('SEO page create error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE SEO page record (doesn't delete from GitHub — do manually if needed) ──
router.delete('/pages/:id', protect, superOnly, async (req, res) => {
  try {
    var SeoPage = require('../models/SeoPage');
    await SeoPage.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Page record deleted. Remove the file from GitHub manually if needed.' });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PREVIEW — returns generated HTML without pushing ──
router.post('/pages/preview', protect, superOnly, async (req, res) => {
  try {
    var html = generateSeoPage(req.body);
    res.json({ success: true, html });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
