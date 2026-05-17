require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');
const Request = require('../models/Request');
const Approach = require('../models/Approach');
const Notification = require('../models/Notification');
const Rating = require('../models/Rating');
const Chat = require('../models/Chat');
const ServiceCategory = require('../models/ServiceCategory');
const SeoPage = require('../models/SeoPage');
const AuditLog = require('../models/AuditLog');
const CreditTransaction = require('../models/CreditTransaction');
const Transaction = require('../models/Transaction');
const { ensureRatingIndexes } = require('../utils/databaseIndexes');
require('../models/Admin');

const API_BASE = process.env.FLOW_TEST_API_BASE || 'http://127.0.0.1:5000/api';

const accounts = {
  admin: { adminId: 'admin_workindextest', password: 'workindextest_pw1' },
  client: {
    name: 'WI Audit Client',
    email: 'wi.audit.client@workindex.test',
    phone: '9876500101',
    password: 'workindextest_audit_client1',
    role: 'client'
  },
  expert: {
    name: 'WI Audit Expert',
    email: 'wi.audit.expert@workindex.test',
    phone: '9876500102',
    password: 'workindextest_audit_expert1',
    role: 'expert'
  },
  client2: {
    name: 'WI Audit Client Two',
    email: 'wi.audit.client2@workindex.test',
    phone: '9876500104',
    password: 'workindextest_audit_client2',
    role: 'client'
  },
  client3: {
    name: 'WI Audit Client Three',
    email: 'wi.audit.client3@workindex.test',
    phone: '9876500105',
    password: 'workindextest_audit_client3',
    role: 'client'
  },
  expert2: {
    name: 'WI Audit Expert Two',
    email: 'wi.audit.expert2@workindex.test',
    phone: '9876500106',
    password: 'workindextest_audit_expert2',
    role: 'expert'
  },
  expert3: {
    name: 'WI Audit Expert Three',
    email: 'wi.audit.expert3@workindex.test',
    phone: '9876500107',
    password: 'workindextest_audit_expert3',
    role: 'expert'
  },
  banned: {
    name: 'WI Audit Banned Client',
    email: 'wi.audit.banned@workindex.test',
    phone: '9876500103',
    password: 'workindextest_audit_banned1',
    role: 'client'
  }
};

const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

function log(message) {
  console.log('[AUDIT] ' + message);
}

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok || data.success === false) {
    throw new Error(`${options.method || 'GET'} ${path} failed (${res.status}): ${data.code || data.message || data.raw || res.statusText}`);
  }
  return data;
}

async function expectApiFailure(path, options = {}, expectedCode) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success !== false) {
    throw new Error(`${options.method || 'GET'} ${path} unexpectedly succeeded`);
  }
  if (expectedCode && data.code !== expectedCode) {
    throw new Error(`${options.method || 'GET'} ${path} expected ${expectedCode}, got ${data.code || data.message || res.status}`);
  }
  return data;
}

async function ensureBackend() {
  const res = await fetch(API_BASE.replace(/\/api$/, '') + '/health');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.mongodb !== 'connected') {
    throw new Error('Backend is not healthy or MongoDB is not connected');
  }
  log('Backend healthy');
}

async function upsertUser(account) {
  let user = await User.findOne({ $or: [{ email: account.email }, { phone: account.phone }] }).select('+password');
  const base = {
    name: account.name,
    email: account.email,
    phone: account.phone,
    password: account.password,
    role: account.role,
    emailVerified: true,
    phoneVerified: true,
    isActive: true,
    isBanned: false,
    isFlagged: false,
    isRestricted: false,
    isApproved: account.role === 'expert',
    isRejected: false,
    credits: account.role === 'expert' ? 120 : 50,
    questionnaireCompleted: account.role === 'expert',
    location: {
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'India',
      address: 'Audit Street, Bengaluru'
    },
    profile: account.role === 'expert' ? {
      servicesOffered: ['GST Services', 'ITR Filing'],
      expert_services: ['gst', 'itr'],
      experience: '5-10 years',
      expert_location: 'Bengaluru',
      expert_location_details: {
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        address: 'Audit Street'
      },
      professional_address: 'Audit Street, Bengaluru',
      education: 'B.Com, CA Inter',
      gstNumber: '29ABCDE1234F1Z5',
      licenseNumber: 'AUDIT-LIC-001',
      business_type: 'proprietor',
      team_size: '2_4',
      bio: 'Audit-only test expert profile with enough completeness for approach checks.'
    } : {}
  };

  if (!user) {
    user = await User.create(base);
  } else {
    Object.assign(user, base);
    await user.save();
  }
  return user;
}

async function login(email, password) {
  const data = await api('/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  return data.token;
}

async function loginAdmin() {
  const data = await api('/admin/login', {
    method: 'POST',
    body: accounts.admin
  });
  log('Admin login works');
  return data.token;
}

async function createAuditRequest(clientToken) {
  const data = await api('/requests', {
    method: 'POST',
    token: clientToken,
    body: {
      service: 'gst',
      title: `WI Audit Edge Request ${runId}`,
      description: 'Temporary request for uncovered edge-case audit.',
      timeline: 'week',
      budget: '5000',
      location: 'Indiranagar, Bengaluru, Karnataka 560038',
      answers: {
        service: 'gst',
        service_location_type: 'my-location',
        gstTurnover: '5-20',
        urgency: 'week',
        budget: 5000,
        full_address: {
          area: 'Indiranagar',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560038'
        }
      }
    }
  });
  return data.request;
}

async function createDirectInvite(clientToken, expertId) {
  const data = await api('/users/expert-invites', {
    method: 'POST',
    token: clientToken,
    body: {
      expertId,
      service: 'gst',
      title: `WI Audit Direct Invite ${runId}`,
      description: 'Temporary direct invite for restricted unlock audit.',
      timeline: 'week',
      budget: 5000,
      location: 'Bengaluru, Karnataka',
      answers: {
        service: 'gst',
        gstTurnover: '5-20',
        urgency: 'week',
        budget: 5000
      }
    }
  });
  return data.invite;
}

async function assertRestrictedClient(clientToken, expertId) {
  await User.updateOne({ email: accounts.client.email }, { $set: { isRestricted: true } });

  await expectApiFailure('/requests', {
    method: 'POST',
    token: clientToken,
    body: {
      service: 'gst',
      title: `Blocked request ${runId}`,
      description: 'This should not be created.',
      timeline: 'week',
      budget: '5000',
      location: 'Bengaluru',
      answers: { service: 'gst', budget: 5000 }
    }
  }, 'ACCOUNT_RESTRICTED');

  await expectApiFailure(`/users/${expertId}/interest`, {
    method: 'POST',
    token: clientToken,
    body: { type: 'shortlist' }
  }, 'ACCOUNT_RESTRICTED');

  await expectApiFailure('/users/expert-invites', {
    method: 'POST',
    token: clientToken,
    body: {
      expertId,
      service: 'gst',
      title: 'Blocked direct invite',
      description: 'This should not be sent.',
      budget: 5000,
      answers: { service: 'gst', budget: 5000 }
    }
  }, 'ACCOUNT_RESTRICTED');

  await User.updateOne({ email: accounts.client.email }, { $set: { isRestricted: false } });
  log('Restricted client cannot post, shortlist, or send direct invites');
}

async function assertRestrictedExpert(expertToken, requestId, inviteId, clientId, expertId) {
  await User.updateOne({ email: accounts.expert.email }, { $set: { isRestricted: true } });

  await expectApiFailure('/approaches', {
    method: 'POST',
    token: expertToken,
    body: {
      request: requestId,
      quote: 4500,
      message: 'This restricted approach should be blocked.'
    }
  }, 'ACCOUNT_RESTRICTED');

  await expectApiFailure(`/users/unlock-interest/${inviteId}`, {
    method: 'POST',
    token: expertToken
  }, 'ACCOUNT_RESTRICTED');

  await expectApiFailure('/chats/direct', {
    method: 'POST',
    token: expertToken,
    body: { expertId, clientId }
  }, 'ACCOUNT_RESTRICTED');

  await expectApiFailure('/credits/add', {
    method: 'POST',
    token: expertToken,
    body: { credits: 1 }
  }, 'ACCOUNT_RESTRICTED');

  await User.updateOne({ email: accounts.expert.email }, { $set: { isRestricted: false } });
  log('Restricted expert cannot approach, unlock invites, start chat, or mutate credits');
}

async function assertBannedTokenBlocked() {
  const token = await login(accounts.banned.email, accounts.banned.password);
  await User.updateOne({ email: accounts.banned.email }, { $set: { isBanned: true } });
  await expectApiFailure('/users/me', { token }, 'ACCOUNT_BANNED');
  await expectApiFailure('/auth/login', {
    method: 'POST',
    body: { email: accounts.banned.email, password: accounts.banned.password }
  });
  await User.updateOne({ email: accounts.banned.email }, { $set: { isBanned: false } });
  log('Banned accounts are blocked for old tokens and new login');
}

async function assertProfilePartialSaveDoesNotWipe(expertToken) {
  await api('/users/profile', {
    method: 'PUT',
    token: expertToken,
    body: {
      bio: 'Audit profile bio with enough detail to keep the expert above profile strength checks.',
      specialization: 'GST and ITR compliance',
      portfolio: 'Audit sample portfolio for WorkIndex test coverage.',
      gstNumber: '29ABCDE1234F1Z5',
      professionalAddress: 'Audit Street, Bengaluru',
      expert_business_type: 'proprietor',
      expert_team_size: '2_4'
    }
  });
  await api('/users/profile', {
    method: 'PUT',
    token: expertToken,
    body: { whyChooseMe: 'Audit why choose me only update' }
  });
  const data = await api('/users/me', { token: expertToken });
  const profile = data.user.profile || {};
  if (!profile.gstNumber || !profile.professionalAddress || data.user.whyChooseMe !== 'Audit why choose me only update') {
    throw new Error('Partial profile save wiped nested profile fields');
  }
  log('Partial expert profile save preserves existing details');
}

async function assertAdminReadSurfaces(adminToken, clientId, expertId, requestId) {
  const checks = [
    '/admin/stats',
    '/admin/users?limit=5',
    `/admin/users/${expertId}`,
    '/admin/expert-boosts',
    '/admin/approaches',
    '/admin/chats',
    '/admin/credits',
    `/admin/credits/expert/${expertId}`,
    '/admin/tickets',
    '/admin/ratings',
    '/admin/requests',
    `/admin/requests/${requestId}`,
    '/admin/payments',
    '/admin/payments/failed',
    '/admin/kyc-requests',
    '/admin/interests',
    '/admin/reports',
    '/admin/suspended-requests',
    '/admin/email-settings',
    '/admin/email-logs',
    '/admin/revenue',
    '/admin/audit',
    `/admin/audit/user/${clientId}`,
    '/admin/admins',
    '/admin/admins/templates',
    '/admin/service-categories',
    '/admin/service-categories/preview/config',
    '/admin/service-categories/settings/platform',
    '/admin/seo/pages'
  ];

  for (const path of checks) {
    await api(path, { token: adminToken });
  }

  const boosts = await api('/admin/expert-boosts', { token: adminToken });
  if (!Array.isArray(boosts.experts || boosts.users || [])) {
    throw new Error('Admin expert boost endpoint returned an unexpected shape');
  }
  log(`Admin read surfaces responded (${checks.length} endpoints)`);
}

async function assertRevenueDashboard(adminToken, users, requestId) {
  const expert = await User.findById(users.expert._id).lean();
  await CreditTransaction.create({
    user: users.expert._id,
    type: 'purchase',
    amount: 25,
    balanceBefore: expert.credits || 0,
    balanceAfter: (expert.credits || 0) + 25,
    description: `WI Audit revenue purchase ${runId}`,
    purchaseDetails: {
      packageSize: 25,
      amountPaid: 750,
      paymentMethod: 'manual',
      transactionId: `wi-audit-${runId}`
    }
  });
  await Transaction.create({
    user: users.expert._id,
    type: 'credit_purchase',
    amount: 750,
    credits: 25,
    paymentStatus: 'success',
    paymentMethod: 'manual',
    description: `WI Audit revenue payment ${runId}`
  });
  await CreditTransaction.create({
    user: users.expert._id,
    type: 'spent',
    amount: -5,
    balanceBefore: expert.credits || 0,
    balanceAfter: (expert.credits || 0) - 5,
    relatedRequest: requestId,
    relatedClient: users.client._id,
    description: `WI Audit revenue spent ${runId}`,
    approachDetails: {
      requestService: 'gst',
      creditsSpent: 5
    }
  });

  const revenue = await api('/admin/revenue?period=month&svcPeriod=all', { token: adminToken });
  const requiredSummary = ['amountReceived', 'purchased', 'spent', 'paidExperts', 'avgOrderValue', 'netCredits', 'totalRequests', 'totalApproaches'];
  for (const key of requiredSummary) {
    if (typeof revenue.summary[key] === 'undefined') throw new Error(`Revenue summary missing ${key}`);
  }
  for (const key of ['byPeriod', 'byService', 'creditMix', 'paymentStatus', 'recentTransactions', 'topExpertsBySpend', 'funnel']) {
    if (!Array.isArray(revenue[key])) throw new Error(`Revenue dashboard ${key} is not an array`);
  }
  const gst = (revenue.byService || []).find(row => row._id === 'gst');
  if (!gst || typeof gst.totalCredits === 'undefined' || typeof gst.approachCount === 'undefined') {
    throw new Error('Revenue service economics missing GST credits/approach data');
  }
  if (!(revenue.creditMix || []).some(row => row.label === 'Purchased')) {
    throw new Error('Revenue credit mix missing purchase slice');
  }
  log('Revenue dashboard returns KPIs, charts, service economics, transactions, and spenders');
}

async function assertAdminSafeWrites(adminToken, expertId) {
  const user = await User.findById(expertId).lean();
  await api(`/admin/experts/${expertId}/boost`, {
    method: 'PUT',
    token: adminToken,
    body: {
      adminBoost: user.adminBoost || 0,
      adminRank: user.adminRank || null
    }
  });

  const settings = await api('/admin/email-settings', { token: adminToken });
  await api('/admin/email-settings', {
    method: 'PUT',
    token: adminToken,
    body: settings.settings || {}
  });
  log('Admin safe write controls respond without corrupting values');
}

async function assertRequestFilteringAndComparison(expertToken, gstRequestId) {
  const itr = await Request.create({
    client: (await User.findOne({ email: accounts.client.email }))._id,
    service: 'itr',
    title: `WI Audit ITR Filter Request ${runId}`,
    description: 'Temporary ITR request for filter audit.',
    timeline: 'week',
    budget: '5000',
    location: 'Bengaluru',
    credits: 15,
    answers: { service: 'itr', budget: 5000 },
    status: 'pending'
  });

  const gstOnly = await api('/requests/available?service=gst', { token: expertToken });
  const itrOnly = await api('/requests/available?service=itr', { token: expertToken });
  if (!(gstOnly.requests || []).some(r => String(r._id) === String(gstRequestId))) {
    throw new Error('GST request missing from GST filter');
  }
  if ((gstOnly.requests || []).some(r => String(r._id) === String(itr._id))) {
    throw new Error('ITR request leaked into GST filter');
  }
  if (!(itrOnly.requests || []).some(r => String(r._id) === String(itr._id))) {
    throw new Error('ITR request missing from ITR filter');
  }

  const search = await api(`/requests/available?search=${encodeURIComponent('ITR Filter')}`, { token: expertToken });
  if (!(search.requests || []).some(r => String(r._id) === String(itr._id))) {
    throw new Error('Available request search did not find matching post');
  }
  log('Expert post filters by service and search behave correctly');
}

async function assertDeepLoopholeGuards(tokens, users, request, invite) {
  const expertView = await api(`/requests/${request._id}`, { token: tokens.expert });
  if (expertView.request.client && (expertView.request.client.email || expertView.request.client.phone)) {
    throw new Error('Request detail leaked client contact to expert before approach/contact unlock');
  }

  await expectApiFailure(`/requests/${request._id}`, { token: tokens.client2 });
  await expectApiFailure(`/requests/${request._id}/status`, {
    method: 'PUT',
    token: tokens.client,
    body: { status: 'hacked' }
  });
  await expectApiFailure(`/requests/${request._id}/complete`, {
    method: 'POST',
    token: tokens.client,
    body: { expertId: users.expert2._id }
  });

  const closedRequest = await Request.create({
    client: users.client._id,
    service: 'gst',
    title: `WI Audit Closed Request ${runId}`,
    description: 'Closed request should not accept approaches.',
    timeline: 'week',
    budget: '5000',
    location: 'Bengaluru',
    credits: 12,
    answers: { service: 'gst', budget: 5000 },
    status: 'completed',
    completedAt: new Date()
  });
  const creditsBeforeClosedApproach = (await User.findById(users.expert._id).lean()).credits || 0;
  await expectApiFailure('/approaches', {
    method: 'POST',
    token: tokens.expert,
    body: {
      request: closedRequest._id,
      quote: 4500,
      message: 'uncovered edge-case audit closed approach should be blocked'
    }
  });
  const creditsAfterClosedApproach = (await User.findById(users.expert._id).lean()).credits || 0;
  if (creditsAfterClosedApproach !== creditsBeforeClosedApproach) {
    throw new Error('Blocked closed-request approach still changed expert credits');
  }

  const approachData = await api('/approaches', {
    method: 'POST',
    token: tokens.expert,
    body: {
      request: request._id,
      quote: 4500,
      message: 'uncovered edge-case audit valid approach'
    }
  });
  await expectApiFailure(`/approaches/${approachData.approach._id}/status`, {
    method: 'PUT',
    token: tokens.client,
    body: { status: 'hacked' }
  });

  await expectApiFailure('/ratings', {
    method: 'POST',
    token: tokens.client2,
    body: {
      expertId: users.expert._id,
      rating: 5,
      review: 'This arbitrary review should be blocked.'
    }
  });

  await api(`/requests/${request._id}/complete`, {
    method: 'POST',
    token: tokens.client,
    body: { expertId: users.expert._id }
  });

  await api('/ratings', {
    method: 'POST',
    token: tokens.client,
    body: {
      expertId: users.expert._id,
      requestId: request._id,
      rating: 5,
      review: 'Audit completed service review.'
    }
  });
  await expectApiFailure('/ratings', {
    method: 'POST',
    token: tokens.client,
    body: {
      expertId: users.expert._id,
      requestId: request._id,
      rating: 5,
      review: 'Duplicate audit review should be blocked.'
    }
  });

  await expectApiFailure('/chats/direct', {
    method: 'POST',
    token: tokens.client2,
    body: { expertId: users.expert._id, clientId: users.client._id }
  });

  const directChat = await api('/chats/direct', {
    method: 'POST',
    token: tokens.client,
    body: { expertId: users.expert._id, clientId: users.client._id }
  });
  await api(`/chats/${directChat.chat._id}/messages`, {
    method: 'POST',
    token: tokens.client,
    body: { text: 'Audit direct chat message.' }
  });
  await api(`/chats/${directChat.chat._id}/read`, {
    method: 'POST',
    token: tokens.client
  });
  await expectApiFailure(`/chats/${directChat.chat._id}/messages`, { token: tokens.client2 });
  await expectApiFailure(`/chats/${directChat.chat._id}/read`, { method: 'POST', token: tokens.client2 });
  await expectApiFailure('/chats/start', {
    method: 'POST',
    token: tokens.client2,
    body: { requestId: request._id, expertId: users.expert._id, clientId: users.client._id }
  });

  const cancelledInvite = await createDirectInvite(tokens.client, users.expert2._id);
  await api(`/users/expert-invites/${cancelledInvite._id}/cancel`, {
    method: 'POST',
    token: tokens.client
  });
  await expectApiFailure(`/users/unlock-interest/${cancelledInvite._id}`, {
    method: 'POST',
    token: tokens.expert2
  });

  const completedInvite = await createDirectInvite(tokens.client, users.expert3._id);
  await api(`/users/unlock-interest/${completedInvite._id}`, {
    method: 'POST',
    token: tokens.expert3
  });
  await api(`/users/invite-complete/${completedInvite._id}`, {
    method: 'POST',
    token: tokens.client
  });
  await api('/ratings', {
    method: 'POST',
    token: tokens.client,
    body: {
      expertId: users.expert3._id,
      rating: 5,
      review: 'Audit direct invite completed review.'
    }
  });
  await expectApiFailure('/ratings', {
    method: 'POST',
    token: tokens.client,
    body: {
      expertId: users.expert3._id,
      rating: 5,
      review: 'Duplicate audit direct invite review should be blocked.'
    }
  });

  log('Deep loophole guards block contact leaks, arbitrary chats, fake ratings, invalid statuses, closed-request approaches, cancelled invite unlocks, and duplicate invite ratings');
}

async function assertReportingAndWarnings(tokens, users) {
  await User.updateOne({ _id: users.expert._id }, { $set: { warnings: 0, isRestricted: false, reports: [], reportCount: 0, blockedExperts: [] } });
  for (const token of [tokens.client, tokens.client2, tokens.client3]) {
    await api(`/users/${users.expert._id}/block`, {
      method: 'POST',
      token,
      body: { report: true, reason: 'Audit report test' }
    });
  }
  const reportedExpert = await User.findById(users.expert._id).lean();
  if (!reportedExpert.isRestricted || (reportedExpert.warnings || 0) < 3 || (reportedExpert.reports || []).length < 3) {
    throw new Error('Three client reports did not restrict expert');
  }

  await api(`/admin/users/${users.expert._id}/action`, {
    method: 'POST',
    token: tokens.admin,
    body: { action: 'unrestrict', reason: 'Audit restore after report test' }
  });
  const restoredExpert = await User.findById(users.expert._id).lean();
  if (restoredExpert.isRestricted || restoredExpert.warnings !== 0) {
    throw new Error('Admin unrestrict did not reset expert warnings/restriction');
  }

  const reportedRequest = await createAuditRequest(tokens.client);
  for (const token of [tokens.expert, tokens.expert2, tokens.expert3]) {
    await api(`/requests/${reportedRequest._id}/report`, {
      method: 'POST',
      token,
      body: { reason: 'Suspicious request', note: 'Audit report test' }
    });
  }
  const afterReports = await Request.findById(reportedRequest._id).lean();
  const reportedClient = await User.findById(users.client._id).lean();
  if (!afterReports.isSuspended || !reportedClient.isRestricted || (afterReports.reports || []).length < 3) {
    throw new Error('Three expert reports did not suspend request and restrict client');
  }
  const reports = await api('/admin/reports', { token: tokens.admin });
  if (!(reports.reports || []).some(r => String(r.reportedUserId) === String(users.client._id))) {
    throw new Error('Admin reports did not include reported customer post');
  }

  await api(`/admin/suspended-requests/${reportedRequest._id}/action`, {
    method: 'POST',
    token: tokens.admin,
    body: { action: 'restore' }
  });
  const restoredRequest = await Request.findById(reportedRequest._id).lean();
  if (restoredRequest.isSuspended) throw new Error('Admin restore did not reinstate suspended request');

  const deleteRequest = await createAuditRequest(tokens.client);
  await Request.findByIdAndUpdate(deleteRequest._id, {
    isSuspended: true,
    suspendedAt: new Date(),
    suspendReason: 'Audit delete test',
    reports: [{ by: users.expert._id, reason: 'Audit', note: 'Audit', date: new Date() }]
  });
  await api(`/admin/suspended-requests/${deleteRequest._id}/action`, {
    method: 'POST',
    token: tokens.admin,
    body: { action: 'delete' }
  });
  if (await Request.findById(deleteRequest._id).lean()) throw new Error('Admin suspended request delete did not remove request');
  await User.updateOne({ _id: users.client._id }, { $set: { isRestricted: false, warnings: 0 } });
  log('Client/expert reporting, warnings, restriction, restore, and delete flows work');
}

async function assertTicketsAndAdminActions(tokens, users) {
  const ticket = await api('/users/tickets', {
    method: 'POST',
    token: tokens.expert,
    body: {
      issueType: 'general',
      subject: `WI Audit Ticket ${runId}`,
      description: 'Audit support ticket.',
      priority: 'medium'
    }
  });
  await api(`/admin/tickets/${ticket.ticket._id}/resolve`, {
    method: 'POST',
    token: tokens.admin,
    body: { note: 'Resolved by audit' }
  });

  const behalf = await api('/admin/tickets/create-for-user', {
    method: 'POST',
    token: tokens.admin,
    body: {
      userId: users.client._id,
      subject: `WI Audit Behalf Ticket ${runId}`,
      description: 'Created by admin audit.',
      priority: 'low'
    }
  });
  if (!behalf.ticket || String(behalf.ticket.user) !== String(users.client._id)) {
    throw new Error('Admin create-ticket-on-behalf did not link to user');
  }

  await api(`/admin/users/${users.client2._id}/action`, { method: 'POST', token: tokens.admin, body: { action: 'warn', reason: 'Audit warning' } });
  await api(`/admin/users/${users.client2._id}/action`, { method: 'POST', token: tokens.admin, body: { action: 'flag', reason: 'Audit flag' } });
  await api(`/admin/users/${users.client2._id}/action`, { method: 'POST', token: tokens.admin, body: { action: 'ban', reason: 'Audit ban' } });
  let acted = await User.findById(users.client2._id).lean();
  if (!acted.isBanned || !acted.isFlagged || (acted.warnings || 0) < 1) throw new Error('Admin warn/flag/ban did not persist');
  await api(`/admin/users/${users.client2._id}/action`, { method: 'POST', token: tokens.admin, body: { action: 'unban', reason: 'Audit unban' } });
  await api(`/admin/users/${users.client2._id}/action`, { method: 'POST', token: tokens.admin, body: { action: 'unflag', reason: 'Audit unflag' } });
  acted = await User.findById(users.client2._id).lean();
  if (acted.isBanned || acted.isFlagged) throw new Error('Admin unban/unflag did not persist');

  await api(`/admin/users/${users.expert2._id}/dm`, {
    method: 'POST',
    token: tokens.admin,
    body: { message: `WI audit admin DM ${runId}` }
  });
  await api(`/admin/users/${users.expert2._id}/reset-password`, {
    method: 'POST',
    token: tokens.admin,
    body: { newPassword: accounts.expert2.password }
  });
  await login(accounts.expert2.email, accounts.expert2.password);
  log('Tickets, admin user actions, DM, and reset password work');
}

async function assertAdminPostReviewApproachCreditControls(tokens, users) {
  const disposableRequest = await createAuditRequest(tokens.client);
  await api(`/admin/requests/${disposableRequest._id}`, {
    method: 'PUT',
    token: tokens.admin,
    body: {
      title: `${disposableRequest.title} Edited`,
      description: 'Edited by uncovered audit.',
      status: 'active',
      budget: '6000',
      location: 'Bengaluru'
    }
  });
  const edited = await Request.findById(disposableRequest._id).lean();
  if (edited.title.indexOf('Edited') === -1 || edited.status !== 'active' || edited.budget !== '6000') {
    throw new Error('Admin request edit did not persist');
  }

  const approach = await Approach.create({
    request: disposableRequest._id,
    expert: users.expert2._id,
    client: users.client._id,
    message: 'Audit admin approach control test',
    quote: 4000,
    creditsSpent: 7,
    status: 'pending',
    contactUnlocked: true
  });
  await api(`/admin/approaches/${approach._id}`, {
    method: 'PUT',
    token: tokens.admin,
    body: { status: 'accepted' }
  });
  const updatedApproach = await Approach.findById(approach._id).lean();
  if (updatedApproach.status !== 'accepted') throw new Error('Admin approach status update failed');
  const beforeRefund = (await User.findById(users.expert2._id).lean()).credits || 0;
  await api(`/admin/approaches/${approach._id}`, { method: 'DELETE', token: tokens.admin });
  const afterRefund = (await User.findById(users.expert2._id).lean()).credits || 0;
  if (afterRefund < beforeRefund + 7) throw new Error('Admin approach delete did not refund credits');

  const rating = await Rating.create({
    expert: users.expert2._id,
    client: users.client._id,
    request: disposableRequest._id,
    rating: 4,
    review: 'Audit review to be deleted by admin.'
  });
  await api(`/admin/ratings/${rating._id}`, { method: 'DELETE', token: tokens.admin });
  if (await Rating.findById(rating._id).lean()) throw new Error('Admin review delete failed');

  const creditBefore = (await User.findById(users.expert2._id).lean()).credits || 0;
  await api(`/admin/users/${users.expert2._id}/credits`, {
    method: 'POST',
    token: tokens.admin,
    body: { action: 'add', amount: 3, reason: 'Audit credit add' }
  });
  await api(`/admin/users/${users.expert2._id}/credits`, {
    method: 'POST',
    token: tokens.admin,
    body: { action: 'deduct', amount: 2, reason: 'Audit credit deduct' }
  });
  const creditAfter = (await User.findById(users.expert2._id).lean()).credits || 0;
  if (creditAfter !== creditBefore + 1) {
    throw new Error(`Admin credit adjustment unexpected balance. Expected ${creditBefore + 1}, got ${creditAfter}`);
  }

  await api(`/admin/requests/${disposableRequest._id}`, { method: 'DELETE', token: tokens.admin });
  if (await Request.findById(disposableRequest._id).lean()) throw new Error('Admin request delete failed');
  log('Admin edit/delete requests, delete reviews, update/delete approaches, and adjust credits work');
}

async function assertServiceCategoryAndSeoAdmin(tokens) {
  const preview = await api('/admin/seo/pages/preview', {
    method: 'POST',
    token: tokens.admin,
    body: {
      slug: `wi-audit-preview-${runId}`,
      title: 'WI Audit SEO Preview',
      metaDescription: 'Audit preview page for WorkIndex SEO admin.',
      metaKeywords: 'audit, workindex',
      heroH1: 'WI Audit SEO',
      heroH1Span: 'Preview',
      heroP: 'Preview only.',
      statsPrice: 'Rs. 1,000',
      statsLabel: 'Audit',
      service: 'Audit',
      state: 'Karnataka'
    }
  });
  if (!preview.html || !preview.html.includes('WI Audit SEO')) throw new Error('SEO preview did not generate HTML');

  const catValue = `wi_audit_${runId.toLowerCase()}`;
  const created = await api('/admin/service-categories', {
    method: 'POST',
    token: tokens.admin,
    body: {
      value: catValue,
      label: 'WI Audit Service',
      icon: 'A',
      color: '#FC8019',
      creditCost: 11,
      maxApproaches: 4,
      questions: [{
        id: 'audit_need',
        question: 'What do you need?',
        type: 'radio',
        required: true,
        options: [{ value: 'test', label: 'Test' }]
      }],
      searchAliases: 'wi audit',
      sortOrder: 999
    }
  });
  await api(`/admin/service-categories/${created.category._id}`, {
    method: 'PUT',
    token: tokens.admin,
    body: { label: 'WI Audit Service Updated', creditCost: 12 }
  });
  const fetched = await api(`/admin/service-categories/${created.category._id}`, { token: tokens.admin });
  if (fetched.category.label !== 'WI Audit Service Updated' || fetched.category.creditCost !== 12) {
    throw new Error('Service category update did not persist');
  }
  await api(`/admin/service-categories/${created.category._id}`, { method: 'DELETE', token: tokens.admin });
  if (await ServiceCategory.findById(created.category._id).lean()) throw new Error('Service category delete failed');

  if (process.env.RUN_SEO_GITHUB_AUDIT === '1') {
    const slug = `wi-audit-github-${runId}`;
    const createdPage = await api('/admin/seo/pages', {
      method: 'POST',
      token: tokens.admin,
      body: {
        slug,
        title: 'WI Audit GitHub SEO Page',
        metaDescription: 'Audit page created to verify GitHub and sitemap SEO publishing.',
        metaKeywords: 'workindex audit seo',
        heroEyebrow: 'Audit',
        heroH1: 'WI Audit',
        heroH1Span: 'SEO Publish',
        heroP: 'Temporary audit page.',
        statsLabel: 'Audit',
        statsPrice: 'Rs. 1,000',
        service: 'Audit',
        state: 'Karnataka',
        step1Title: 'Post', step1P: 'Post requirement.',
        step2Title: 'Match', step2P: 'Find expert.',
        step3Title: 'Compare', step3P: 'Compare quotes.',
        step4Title: 'Hire', step4P: 'Hire expert.',
        price1Label: 'Basic', price1Range: 'Rs. 1,000 - Rs. 2,000', price1Desc: 'Basic audit.',
        price2Label: 'Standard', price2Range: 'Rs. 2,000 - Rs. 5,000', price2Desc: 'Standard audit.',
        price3Label: 'Advanced', price3Range: 'Rs. 5,000 - Rs. 10,000', price3Desc: 'Advanced audit.',
        price4Label: 'Custom', price4Range: 'Quote based', price4Desc: 'Custom audit.',
        faq1Q: 'Is this an audit test?', faq1A: 'Yes.',
        faq2Q: 'Is it indexed?', faq2A: 'Sitemap submission is attempted.',
        faq3Q: 'Where is it created?', faq3A: 'Under seo-pages.',
        faq4Q: 'Is this permanent?', faq4A: 'It is an audit artifact.',
        faq5Q: 'Who created it?', faq5A: 'WorkIndex audit.',
        ctaH2: 'Find an expert', ctaP: 'Post your requirement.'
      }
    });
    if (!createdPage.url || !createdPage.url.includes('/seo-pages/')) {
      throw new Error('SEO GitHub publish did not return seo-pages URL');
    }
    const githubFile = await githubGetJson(`/repos/ravishhegde7/WorkIndex/contents/seo-pages/${slug}.html`);
    if (!githubFile || !githubFile.sha) throw new Error('SEO GitHub publish did not create the seo-pages file');
    const sitemap = await githubGetJson('/repos/ravishhegde7/WorkIndex/contents/sitemap.xml');
    const sitemapXml = Buffer.from(sitemap.content || '', 'base64').toString('utf8');
    if (!sitemapXml.includes(`https://workindex.co.in/seo-pages/${slug}.html`)) {
      throw new Error('SEO GitHub publish did not update sitemap.xml with the new page');
    }
    const saved = await SeoPage.findOne({ slug: `seo-pages/${slug}` }).lean();
    if (!saved) throw new Error('SEO GitHub publish did not save page record');
    log('SEO GitHub publish created seo-pages file and updated sitemap.xml');
  } else {
    log('SEO preview passed; live GitHub publish skipped because RUN_SEO_GITHUB_AUDIT is not 1');
  }

  log('Service category admin create/update/delete and SEO preview work');
}

function githubGetJson(path) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN is required for live SEO GitHub audit'));
    const req = require('https').request({
      hostname: 'api.github.com',
      path,
      method: 'GET',
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'WorkIndex-Audit',
        Accept: 'application/vnd.github.v3+json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve(JSON.parse(body));
        }
        reject(new Error(`GitHub GET ${path} failed: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function cleanup() {
  await User.updateMany(
    { email: { $in: Object.values(accounts).map(a => a.email).filter(Boolean) } },
    { $set: { isRestricted: false, isBanned: false, isFlagged: false } }
  );
  await Request.deleteMany({ title: /WI Audit/i });
  await Notification.deleteMany({ 'data.title': new RegExp(`WI Audit .*${runId}`) });
  await Approach.deleteMany({ message: /restricted approach should be blocked|uncovered edge-case audit/i });
  await Rating.deleteMany({ review: /Audit/i });
  await Chat.deleteMany({ $or: [
    { expert: { $in: (await User.find({ email: { $in: [accounts.expert.email, accounts.expert2.email, accounts.expert3.email] } }).select('_id')).map(u => u._id) } },
    { client: { $in: (await User.find({ email: { $in: [accounts.client.email, accounts.client2.email, accounts.client3.email] } }).select('_id')).map(u => u._id) } }
  ] });
  await CreditTransaction.deleteMany({ description: new RegExp(`WI Audit revenue .*${runId}`) });
  await Transaction.deleteMany({ description: new RegExp(`WI Audit revenue .*${runId}`) });
  await ServiceCategory.deleteMany({ value: new RegExp(`^wi_audit_${runId.toLowerCase()}`) });
  await SeoPage.deleteMany({ slug: new RegExp(`wi-audit-(preview|github)-${runId}`) });
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await ensureRatingIndexes();
  await ensureBackend();

  const client = await upsertUser(accounts.client);
  const expert = await upsertUser(accounts.expert);
  const client2 = await upsertUser(accounts.client2);
  const client3 = await upsertUser(accounts.client3);
  const expert2 = await upsertUser(accounts.expert2);
  const expert3 = await upsertUser(accounts.expert3);
  await upsertUser(accounts.banned);

  const clientToken = await login(accounts.client.email, accounts.client.password);
  const expertToken = await login(accounts.expert.email, accounts.expert.password);
  const client2Token = await login(accounts.client2.email, accounts.client2.password);
  const client3Token = await login(accounts.client3.email, accounts.client3.password);
  const expert2Token = await login(accounts.expert2.email, accounts.expert2.password);
  const expert3Token = await login(accounts.expert3.email, accounts.expert3.password);
  const adminToken = await loginAdmin();
  const tokens = {
    admin: adminToken,
    client: clientToken,
    client2: client2Token,
    client3: client3Token,
    expert: expertToken,
    expert2: expert2Token,
    expert3: expert3Token
  };
  const users = { client, client2, client3, expert, expert2, expert3 };

  await assertProfilePartialSaveDoesNotWipe(expertToken);
  const request = await createAuditRequest(clientToken);
  const invite = await createDirectInvite(clientToken, expert._id);

  await assertRequestFilteringAndComparison(expertToken, request._id);
  await assertDeepLoopholeGuards(tokens, users, request, invite);
  await assertRestrictedClient(clientToken, expert._id);
  await assertRestrictedExpert(expertToken, request._id, invite._id, client._id, expert._id);
  await assertBannedTokenBlocked();
  await assertAdminReadSurfaces(adminToken, client._id, expert._id, request._id);
  await assertRevenueDashboard(adminToken, users, request._id);
  await assertAdminSafeWrites(adminToken, expert._id);
  await assertReportingAndWarnings(tokens, users);
  await assertTicketsAndAdminActions(tokens, users);
  await assertAdminPostReviewApproachCreditControls(tokens, users);
  await assertServiceCategoryAndSeoAdmin(tokens);

  await cleanup();
  log('Uncovered audit test completed');
}

main()
  .catch(async (error) => {
    console.error('\n[AUDIT] FAILED:', error.message);
    try { await cleanup(); } catch (_) {}
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
