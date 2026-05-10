const express = require('express');
const router  = express.Router();
const Visit   = require('../models/Visit');
const jwt     = require('jsonwebtoken');

function normalizeTrafficSource(value, referrer) {
  const raw = String(value || '').trim().toLowerCase();
  const ref = String(referrer || '').trim().toLowerCase();
  const combined = raw || ref;
  if (!combined) return 'Direct';
  if (/instagram|ig/.test(combined)) return 'Instagram';
  if (/facebook|fb\.|meta/.test(combined)) return 'Facebook';
  if (/google/.test(combined)) return 'Google';
  if (/linkedin/.test(combined)) return 'LinkedIn';
  if (/whatsapp|wa\.me/.test(combined)) return 'WhatsApp';
  if (/twitter|x\.com|t\.co/.test(combined)) return 'Twitter/X';
  if (/youtube|youtu\.be/.test(combined)) return 'YouTube';
  if (/bing/.test(combined)) return 'Bing';
  return raw ? raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Other';
}

// ─── Admin auth — checks isAdmin: true (matches admin login JWT) ─────────────
function adminAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Admin JWT contains { id, isAdmin: true, role: ... }  (see admin login route)
    if (!decoded.isAdmin && decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// ═══════════════════════════════════════════════════════════
// POST /api/visits/track  — PUBLIC, no auth
// ═══════════════════════════════════════════════════════════
router.post('/track', async (req, res) => {
  try {
    const { page = '/', sessionId = '' } = req.body;
    const referrer = req.body.referrer || req.headers['referer'] || '';
    const source = normalizeTrafficSource(req.body.source || req.body.utm_source, referrer);
    const medium = req.body.medium || req.body.utm_medium || '';

    const ip =
      req.headers['cf-connecting-ip'] ||
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.headers['x-real-ip'] ||
      req.socket.remoteAddress ||
      'unknown';

    const isLocal = ['::1', '127.0.0.1', 'unknown'].includes(ip) ||
                    ip.startsWith('192.168') ||
                    ip.startsWith('10.');

    if (sessionId) {
      const existing = await Visit.findOne({ sessionId });
      if (existing) return res.json({ success: true, message: 'Already tracked' });
    }

    let state   = 'Unknown';
    let city    = 'Unknown';
    let country = 'India';

    if (!isLocal && ip !== 'unknown') {
      try {
        const geoRes  = await fetch(
          `http://ip-api.com/json/${ip}?fields=status,country,regionName,city`
        );
        const geoData = await geoRes.json();
        if (geoData.status === 'success') {
          country = geoData.country    || 'India';
          state   = geoData.regionName || 'Unknown';
          city    = geoData.city       || 'Unknown';
        }
      } catch (geoErr) {
        console.log('Geo lookup failed:', geoErr.message);
      }
    } else {
      state   = 'Karnataka';
      city    = 'Bengaluru';
      country = 'India';
    }

    await Visit.create({
      ip, country, state, city, page, sessionId,
      userAgent: req.headers['user-agent'] || '',
      referrer,
      source,
      medium
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Visit track error:', error);
    res.json({ success: false });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/visits/stats  — ADMIN ONLY
// ═══════════════════════════════════════════════════════════
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const week  = new Date(today); week.setDate(week.getDate() - 7);
    const month = new Date(today); month.setDate(month.getDate() - 30);

    const [total, todayCount, weekCount, monthCount, stateBreakdown, cityBreakdown, recentVisits, pageBreakdown, deviceBreakdown, uniqueVisitors, returningVisitors, browserBreakdown, referrerBreakdown, countryBreakdown, hourlyBreakdown] = await Promise.all([
      Visit.countDocuments(),
      Visit.countDocuments({ createdAt: { $gte: today } }),
      Visit.countDocuments({ createdAt: { $gte: week } }),
      Visit.countDocuments({ createdAt: { $gte: month } }),

      Visit.aggregate([
        { $match: { state: { $ne: 'Unknown' } } },
        { $group: { _id: '$state', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]),

      Visit.aggregate([
        { $match: { city: { $ne: 'Unknown' } } },
        { $group: { _id: '$city', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      Visit.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .select('state city page createdAt')
        .lean(),

      Visit.aggregate([
        { $group: { _id: '$page', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]),

      Visit.aggregate([
        {
          $addFields: {
            deviceType: {
              $cond: {
                if: { $regexMatch: { input: { $ifNull: ['$userAgent', ''] }, regex: /Mobile|Android|iPhone|iPad|tablet/i } },
                then: 'Mobile',
                else: 'Desktop'
              }
            }
          }
        },
        { $group: { _id: '$deviceType', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),

      // Unique visitors (distinct IPs)
      Visit.distinct('ip').then(ips => ips.filter(ip => ip && ip !== 'unknown').length),

      // Returning visitors (IPs that appear more than once)
      Visit.aggregate([
        { $match: { ip: { $ne: 'unknown' } } },
        { $group: { _id: '$ip', visits: { $sum: 1 } } },
        { $match: { visits: { $gt: 1 } } },
        { $count: 'returningCount' }
      ]).then(r => (r[0] && r[0].returningCount) || 0),

      // Browser breakdown from userAgent
      Visit.aggregate([
        {
          $addFields: {
            browser: {
              $switch: {
                branches: [
                  { case: { $regexMatch: { input: { $ifNull: ['$userAgent', ''] }, regex: /Edg\//i } }, then: 'Edge' },
                  { case: { $regexMatch: { input: { $ifNull: ['$userAgent', ''] }, regex: /OPR|Opera/i } }, then: 'Opera' },
                  { case: { $regexMatch: { input: { $ifNull: ['$userAgent', ''] }, regex: /Chrome/i } }, then: 'Chrome' },
                  { case: { $regexMatch: { input: { $ifNull: ['$userAgent', ''] }, regex: /Safari/i } }, then: 'Safari' },
                  { case: { $regexMatch: { input: { $ifNull: ['$userAgent', ''] }, regex: /Firefox/i } }, then: 'Firefox' }
                ],
                default: 'Other'
              }
            }
          }
        },
        { $group: { _id: '$browser', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),

      // Referrer / traffic source
      Visit.aggregate([
        {
          $addFields: {
            source: {
              $switch: {
                branches: [
                  { case: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /instagram/i } }, then: 'Instagram' },
                  { case: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /facebook/i } }, then: 'Facebook' },
                  { case: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /google/i } }, then: 'Google' },
                  { case: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /linkedin/i } }, then: 'LinkedIn' },
                  { case: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /whatsapp/i } }, then: 'WhatsApp' },
                  { case: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /twitter|x/i } }, then: 'Twitter/X' },
                  { case: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /youtube|youtu\.be/i } }, then: 'YouTube' },
                  { case: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /bing/i } }, then: 'Bing' },
                  { case: { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: /google/i } }, then: 'Google' },
                  { case: { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: /facebook|fb\./i } }, then: 'Facebook' },
                  { case: { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: /instagram/i } }, then: 'Instagram' },
                  { case: { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: /twitter|x\.com|t\.co/i } }, then: 'Twitter/X' },
                  { case: { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: /linkedin/i } }, then: 'LinkedIn' },
                  { case: { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: /whatsapp|wa\.me/i } }, then: 'WhatsApp' },
                  { case: { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: /youtube|youtu\.be/i } }, then: 'YouTube' },
                  { case: { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: /bing/i } }, then: 'Bing' },
                  { case: { $or: [{ $eq: ['$source', 'Direct'] }, { $eq: ['$referrer', ''] }, { $eq: ['$referrer', null] }] }, then: 'Direct' }
                ],
                default: {
                  $cond: [
                    { $and: [{ $ne: ['$source', ''] }, { $ne: ['$source', null] }] },
                    '$source',
                    'Other'
                  ]
                }
              }
            }
          }
        },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),

      // Country breakdown
      Visit.aggregate([
        { $match: { country: { $exists: true, $ne: null, $ne: '' } } },
        { $group: { _id: '$country', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 15 }
      ]),

      // Hourly breakdown (hour 0–23)
      Visit.aggregate([
        { $addFields: { hour: { $hour: { date: '$createdAt', timezone: 'Asia/Kolkata' } } } },
        { $group: { _id: '$hour', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ])
    ]);

    const dailyData = await Visit.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } } },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    const uniqueCount    = uniqueVisitors;
    const newVisitorCount = uniqueCount - returningVisitors;

    res.json({
      success: true,
      stats: {
        total,
        today:     todayCount,
        week:      weekCount,
        month:     monthCount,
        unique:    uniqueCount,
        returning: returningVisitors,
        newVisitors: Math.max(0, newVisitorCount),
        states:    stateBreakdown.map(s  => ({ state:   s._id || 'Unknown',  count: s.count })),
        cities:    cityBreakdown.map(c   => ({ city:    c._id || 'Unknown',  count: c.count })),
        daily:     dailyData.map(d       => ({ date: `${d._id.day}/${d._id.month}`, count: d.count })),
        pages:     pageBreakdown.map(p   => ({ page:    p._id || '/',        count: p.count })),
        devices:   deviceBreakdown.map(d => ({ device:  d._id || 'Desktop', count: d.count })),
        browsers:  browserBreakdown.map(b  => ({ browser:  b._id || 'Other',  count: b.count })),
        sources:   referrerBreakdown.map(r => ({ source:   r._id || 'Direct', count: r.count })),
        countries: countryBreakdown.map(c  => ({ country:  c._id || 'Unknown',count: c.count })),
        hourly:    hourlyBreakdown.map(h   => ({ hour: h._id, count: h.count })),
        recent:    recentVisits
      }
    });
    
  } catch (error) {
    console.error('Visit stats error:', error);
    res.status(500).json({ success: false, message: 'Error fetching visit stats' });
  }
});

module.exports = router;
