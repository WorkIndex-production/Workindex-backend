require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');
const Request = require('../models/Request');
const EmailLog = require('../models/EmailLog');
const EmailSettings = require('../models/EmailSettings');
const AuditLog = require('../models/AuditLog');
const { processStaleRequests } = require('../utils/requestLifecycle');
const {
  sendClientWelcome,
  sendClientPostSuspended,
  sendClientRestricted,
  sendClientBanned,
  sendExpertWelcome,
  sendExpertCreditsPurchased,
  sendExpertCreditsRefunded,
  sendExpertRestricted,
  sendExpertBanned
} = require('../utils/notificationEmailService');

const API_BASE = process.env.FLOW_TEST_API_BASE || 'http://127.0.0.1:5000/api';
const startedAt = new Date();
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

const accounts = {
  client: {
    name: 'Ravish Mail Flow Customer',
    email: 'ravishhegde6@gmail.com',
    phone: '7890000606',
    password: 'WorkIndex@Test123',
    role: 'client'
  },
  expert: {
    name: 'Ravish Mail Flow Expert',
    email: 'ravishhegde3@gmail.com',
    phone: '7890000303',
    password: 'WorkIndex@Test123',
    role: 'expert'
  }
};

function step(message) {
  console.log('\n[MAIL-FLOW] ' + message);
}

function ok(message) {
  console.log('  OK  ' + message);
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
    throw new Error(`${options.method || 'GET'} ${path} failed (${res.status}): ${data.message || data.raw || res.statusText}`);
  }
  return data;
}

async function ensureBackend() {
  const res = await fetch(API_BASE.replace(/\/api$/, '') + '/health');
  const data = await res.json();
  if (!res.ok || data.mongodb !== 'connected') throw new Error('Backend is not healthy');
  ok('Backend healthy');
}

async function upsertUser(account) {
  let user = await User.findOne({ email: account.email }).select('+password');
  const data = {
    name: account.name,
    email: account.email,
    phone: account.phone,
    password: account.password,
    role: account.role,
    credits: 250,
    emailVerified: true,
    phoneVerified: true,
    isActive: true,
    isBanned: false,
    isFlagged: false,
    isRestricted: false,
    isApproved: account.role === 'expert',
    isRejected: false,
    questionnaireCompleted: account.role === 'expert',
    warnings: 0,
    preferences: { notifications: { email: true, newPosts: true, sms: false } }
  };

  if (!user) user = new User(data);
  else Object.assign(user, data);

  if (account.role === 'expert') {
    user.specialization = 'Tax and GST Consultant';
    user.bio = 'Real inbox email-flow test expert profile for WorkIndex.';
    user.profilePhoto = '/uploads/test-profile.png';
    user.yearsOfExperience = '7';
    user.servicesOffered = ['gst', 'itr', 'accounting'];
    user.profile = {
      expert_business_type: 'proprietor',
      expert_team_size: 'solo',
      expert_experience: '7',
      expert_specialization: 'GST and ITR filing',
      expert_bio: 'Real inbox email-flow test expert profile for WorkIndex.',
      expert_city: 'Bangalore',
      expert_state: 'Karnataka',
      expert_pincode: '560001',
      gstNumber: '29ABCDE1234F1Z5',
      certificationNumber: 'WI-MAIL-FLOW-CERT',
      education: 'B.Com, CA Inter',
      portfolio: 'GST, ITR, and accounting compliance portfolio for mail-flow testing.',
      servicesOffered: ['gst', 'itr', 'accounting']
    };
    user.location = { city: 'Bangalore', state: 'Karnataka', country: 'India', address: 'Bangalore', pincode: '560001' };
    user.certifications = ['GST Practitioner Test'];
    user.whyChooseMe = 'Fast documentation and clean compliance support.';
  }

  await user.save();
  ok(`Prepared ${account.role}: ${account.email}`);
  return user;
}

async function login(account) {
  const data = await api('/auth/login', {
    method: 'POST',
    body: { email: account.email, password: account.password, role: account.role }
  });
  ok(`Logged in as ${account.role}`);
  return data.token;
}

async function enableAllEmailSettings() {
  const keys = [
    'client_welcome', 'client_post_created', 'client_expert_approached', 'client_post_suspended',
    'client_post_stale_reminder', 'client_restricted', 'client_banned',
    'expert_welcome', 'expert_credits_purchased', 'expert_credits_refunded', 'expert_approach_sent',
    'expert_new_post', 'expert_invite_received', 'expert_restricted', 'expert_banned',
    'admin_post_suspended', 'admin_user_restricted', 'admin_ticket_escalated', 'admin_daily_tickets'
  ];
  const set = { singleton: true };
  keys.forEach((key) => { set[key] = true; });
  await EmailSettings.findOneAndUpdate({ singleton: true }, { $set: set }, { upsert: true, new: true });
  ok('Enabled all email notification settings for this test');
}

async function createRequest(clientToken) {
  const data = await api('/requests', {
    method: 'POST',
    token: clientToken,
    body: {
      service: 'gst',
      title: `Real Mail Flow GST Request ${runId}`,
      description: 'Real inbox email-flow request generated by WorkIndex test.',
      timeline: 'week',
      budget: '5000',
      location: 'Bangalore, Karnataka',
      answers: {
        service_location_type: 'my-location',
        full_address: { area: 'Jayanagar', city: 'Bangalore', state: 'Karnataka', pincode: '560011' },
        gstTurnover: '5-20',
        urgency: 'week',
        budget: '5000'
      }
    }
  });
  ok('Created request that sends client_post_created and expert_new_post');
  return data.request;
}

async function approachAndComplete(clientToken, expertToken, request, expertId) {
  const approachData = await api('/approaches', {
    method: 'POST',
    token: expertToken,
    body: {
      request: request._id,
      quote: 4500,
      message: 'Real inbox flow test approach for GST service.'
    }
  });
  ok('Expert approached request; sends expert_approach_sent and client_expert_approached');

  await api(`/approaches/${approachData.approach._id}/status`, {
    method: 'PUT',
    token: clientToken,
    body: { status: 'accepted' }
  });
  ok('Client accepted approach');

  await api(`/requests/${request._id}/complete`, {
    method: 'POST',
    token: clientToken,
    body: { expertId }
  });
  ok('Client completed request');

  await api('/ratings', {
    method: 'POST',
    token: clientToken,
    body: {
      expertId,
      requestId: request._id,
      approachId: approachData.approach._id,
      rating: 5,
      review: 'Real inbox email-flow rating after completion.',
      wouldRecommend: true
    }
  });
  ok('Client submitted rating; audit log should capture rating_completed');
  return approachData.approach;
}

async function directInvite(clientToken, expertId) {
  await api('/users/expert-invites', {
    method: 'POST',
    token: clientToken,
    body: {
      expertId,
      service: 'itr',
      title: `Real Mail Flow Direct Invite ${runId}`,
      description: 'Direct expert invite generated by real inbox mail-flow test.',
      answers: {
        service: 'itr',
        itrTaxpayerType: 'salaried',
        itrAnnualIncome: '10-15',
        itrIncomeSources: ['salary'],
        urgency: 'week',
        budget: 3000
      },
      timeline: 'week',
      budget: 3000,
      location: 'Bangalore, Karnataka'
    }
  });
  ok('Customer direct invite sent; sends expert_invite_received');
}

async function staleLifecycle(clientToken) {
  const stale = await createRequest(clientToken);
  await Request.findByIdAndUpdate(stale._id, {
    $set: {
      status: 'active',
      staleReminderSentAt: null,
      renewedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    }
  });
  await processStaleRequests(new Date());
  ok('Stale reminder sent; sends client_post_stale_reminder');

  await api(`/requests/${stale._id}/renew`, { method: 'POST', token: clientToken });
  ok('Customer renewed stale request; audit log should capture post_renewed');

  await Request.findByIdAndUpdate(stale._id, {
    $set: {
      status: 'active',
      staleReminderSentAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      renewedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    }
  });
  await processStaleRequests(new Date());
  ok('Unconfirmed stale request purged; audit log should capture post_purged');
}

async function sendDirectScenarioEmails(client, expert) {
  await sendClientWelcome({ to: client.email, name: client.name });
  await sendExpertWelcome({ to: expert.email, name: expert.name });
  await sendExpertCreditsPurchased({
    to: expert.email,
    name: expert.name,
    creditsPurchased: 40,
    amountPaid: 250,
    newBalance: expert.credits + 40,
    userId: expert._id
  });
  await sendExpertCreditsRefunded({
    to: expert.email,
    name: expert.name,
    creditsRefunded: 15,
    newBalance: expert.credits + 15,
    adminNote: 'Real inbox email-flow refund notification test.',
    userId: expert._id
  });
  await sendClientPostSuspended({
    to: client.email,
    name: client.name,
    postTitle: `Real Mail Flow Suspended Post ${runId}`,
    reportCount: 3,
    userId: client._id
  });
  await sendClientRestricted({
    to: client.email,
    name: client.name,
    reason: 'Real inbox email-flow restriction notification test',
    warningCount: 3,
    userId: client._id
  });
  await sendClientBanned({
    to: client.email,
    name: client.name,
    reason: 'Real inbox email-flow ban notification test',
    userId: client._id
  });
  await sendExpertRestricted({
    to: expert.email,
    name: expert.name,
    reason: 'Real inbox email-flow restriction notification test',
    warningCount: 3,
    userId: expert._id
  });
  await sendExpertBanned({
    to: expert.email,
    name: expert.name,
    reason: 'Real inbox email-flow ban notification test',
    userId: expert._id
  });
  ok('Sent direct scenario emails for welcome, credits, suspended, restricted, and banned cases');
}

async function assertEmailLogs(typesByEmail) {
  for (const [email, types] of Object.entries(typesByEmail)) {
    for (const type of types) {
      const log = await EmailLog.findOne({ to: email, type, createdAt: { $gte: startedAt } }).sort('-createdAt').lean();
      if (!log) throw new Error(`Missing EmailLog for ${type} to ${email}`);
      if (!['sent', 'failed'].includes(log.status)) throw new Error(`Unexpected EmailLog status ${log.status} for ${type}`);
      ok(`EmailLog ${type} -> ${email}: ${log.status}`);
    }
  }
}

async function assertAuditLogs(actions) {
  for (const action of actions) {
    const log = await AuditLog.findOne({ action, createdAt: { $gte: startedAt } }).sort('-createdAt').lean();
    if (!log) throw new Error(`Missing AuditLog for ${action}`);
    ok(`AuditLog ${action} recorded`);
  }
}

async function main() {
  step('Checking backend and preparing accounts');
  await ensureBackend();
  await mongoose.connect(process.env.MONGODB_URI);
  await enableAllEmailSettings();
  const client = await upsertUser(accounts.client);
  const expert = await upsertUser(accounts.expert);
  await mongoose.disconnect();

  step('Logging in');
  const clientToken = await login(accounts.client);
  const expertToken = await login(accounts.expert);

  step('Running product email flows');
  await mongoose.connect(process.env.MONGODB_URI);
  const freshClient = await User.findById(client._id);
  const freshExpert = await User.findById(expert._id);
  await sendDirectScenarioEmails(freshClient, freshExpert);
  await mongoose.disconnect();

  const request = await createRequest(clientToken);
  await approachAndComplete(clientToken, expertToken, request, expert._id);
  await directInvite(clientToken, expert._id);

  step('Running stale request lifecycle');
  await mongoose.connect(process.env.MONGODB_URI);
  await staleLifecycle(clientToken);

  step('Verifying EmailLog and AuditLog');
  await assertEmailLogs({
    [accounts.client.email]: [
      'client_welcome',
      'client_post_created',
      'client_expert_approached',
      'client_post_suspended',
      'client_post_stale_reminder',
      'client_restricted',
      'client_banned'
    ],
    [accounts.expert.email]: [
      'expert_welcome',
      'expert_credits_purchased',
      'expert_credits_refunded',
      'expert_approach_sent',
      'expert_new_post',
      'expert_invite_received',
      'expert_restricted',
      'expert_banned'
    ]
  });
  await assertAuditLogs([
    'request_created',
    'approach_submitted',
    'approach_accepted',
    'service_completed',
    'service_received',
    'rating_completed',
    'post_purge_mail_sent',
    'post_renewed',
    'post_purged'
  ]);
  await mongoose.disconnect();

  console.log('\n======================================');
  console.log('REAL EMAIL FLOW TEST PASSED');
  console.log('Customer: ' + accounts.client.email);
  console.log('Expert  : ' + accounts.expert.email);
  console.log('Password for both: ' + accounts.client.password);
  console.log('Check inbox/spam/promotions for the messages.');
  console.log('======================================\n');
}

main().catch(async (err) => {
  try { if (mongoose.connection.readyState) await mongoose.disconnect(); } catch (_) {}
  console.error('\nREAL EMAIL FLOW TEST FAILED');
  console.error(err.message);
  process.exit(1);
});
