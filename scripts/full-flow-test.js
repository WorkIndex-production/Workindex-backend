require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');
const ExpertInvite = require('../models/ExpertInvite');
const EmailLog = require('../models/EmailLog');
const EmailSettings = require('../models/EmailSettings');
const Request = require('../models/Request');
const AuditLog = require('../models/AuditLog');
const { processStaleRequests } = require('../utils/requestLifecycle');

const API_BASE = process.env.FLOW_TEST_API_BASE || 'http://127.0.0.1:5000/api';

const accounts = {
  admin: {
    adminId: 'admin_workindextest',
    password: 'workindextest_pw1'
  },
  client: {
    name: 'WI Test Customer',
    email: 'wi.test.customer@workindex.test',
    phone: '9876500001',
    password: 'workindextest_client1',
    role: 'client'
  },
  expert: {
    name: 'WI Test Expert',
    email: 'wi.test.expert@workindex.test',
    phone: '9876500002',
    password: 'workindextest_expert1',
    role: 'expert'
  },
  invitedExpert: {
    name: 'WI Invited Test Expert',
    email: 'wi.invited.expert@workindex.test',
    phone: '9876500003',
    password: 'workindextest_invited1',
    role: 'expert'
  }
};

const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

function step(message) {
  console.log('\n[FLOW] ' + message);
}

function ok(message) {
  console.log('  OK  ' + message);
}

async function request(path, options = {}) {
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
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { raw: text };
  }

  if (!res.ok || data.success === false) {
    const message = data.message || data.raw || res.statusText;
    throw new Error(`${options.method || 'GET'} ${path} failed (${res.status}): ${message}`);
  }

  return data;
}

async function expectRequestFailure(path, options = {}, expectedCode) {
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
    throw new Error(`${options.method || 'GET'} ${path} was expected to fail`);
  }
  if (expectedCode && data.code !== expectedCode) {
    throw new Error(`${path} failed with unexpected code: ${data.code || data.message || res.status}`);
  }
  return data;
}

async function ensureBackend() {
  const healthUrl = API_BASE.replace(/\/api$/, '') + '/health';
  const res = await fetch(healthUrl);
  const data = await res.json();
  if (!res.ok || data.mongodb !== 'connected') {
    throw new Error('Backend is not healthy or MongoDB is not connected');
  }
  ok('Backend healthy, MongoDB connected');
}

async function upsertUser(account) {
  let user = await User.findOne({
    $or: [
      { email: account.email },
      { phone: account.phone }
    ]
  }).select('+password');
  const data = {
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
    preferences: {
      notifications: {
        email: true,
        newPosts: true
      }
    }
  };

  if (!user) {
    user = await User.create({
      ...data,
      credits: 50
    });
    ok(`Created ${account.role}: ${account.email}`);
    return user;
  }

  Object.assign(user, data);
  if (account.role === 'expert' && (user.credits || 0) !== 50) {
    user.credits = 50;
  }
  await user.save();
  ok(`Reused ${account.role}: ${account.email}`);
  return user;
}

async function createInviteLink(inviter, invited) {
  inviter.credits = 50;
  if (!inviter.inviteCode) {
    inviter.inviteCode = 'WITEST' + Math.random().toString(36).slice(2, 7).toUpperCase();
  }
  await inviter.save();

  invited.referredBy = inviter._id;
  invited.questionnaireCompleted = false;
  invited.profile = {};
  invited.credits = 50;
  await invited.save();

  await ExpertInvite.findOneAndUpdate(
    { inviter: inviter._id, invitedUser: invited._id },
    {
      inviter: inviter._id,
      invitedUser: invited._id,
      invitedEmail: invited.email,
      inviteCode: inviter.inviteCode,
      status: 'approach_pending',
      creditsAwarded: 0
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  ok('Prepared expert invite link and pending invite history');
}

async function login(account) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: {
      email: account.email,
      password: account.password,
      role: account.role
    }
  });
  ok(`Logged in as ${account.role}`);
  return data;
}

async function loginAdmin() {
  const data = await request('/admin/login', {
    method: 'POST',
    body: {
      adminId: accounts.admin.adminId,
      password: accounts.admin.password
    }
  });
  ok('Logged in as admin');
  return data;
}

async function updateExpertProfile(token, account = accounts.expert) {
  const profile = {
    expert_business_type: 'Company',
    expert_team_size: '2-5',
    expert_experience: '7',
    expert_specialization: 'GST Registration and Monthly Compliance',
    expert_bio: 'Automated test expert profile used for WorkIndex full-flow smoke testing.',
    expert_city: 'Bangalore',
    expert_state: 'Karnataka',
    expert_pincode: '560001',
    expert_location_details: {
      area: 'MG Road',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001'
    },
    city: 'Bangalore',
    state: 'Karnataka',
    pincode: '560001',
    gstNumber: '29ABCDE1234F1Z5',
    certificationNumber: 'WI-TEST-CERT-001',
    education: 'B.Com, CA Inter',
    portfolio: 'Handled GST filings and compliance checks for automated test businesses.',
    professionalAddress: 'MG Road, Bangalore, Karnataka 560001',
    servicesOffered: ['gst', 'accounting', 'itr']
  };

  await request('/users/profile', {
    method: 'PUT',
    token,
    body: {
      phone: account.phone,
      whyChooseMe: 'Fast responses, clean documentation, and reliable compliance support.',
      profile
    }
  });

  await request('/users/me', {
    method: 'PUT',
    token,
    body: {
      name: account.name,
      specialization: 'GST Consultant',
      bio: profile.expert_bio,
      companyName: 'WorkIndex Test Advisory',
      companySize: '2-5',
      hasWebsite: true,
      websiteUrl: 'https://www.workindex.co.in',
      yearsOfExperience: '7',
      servicesOffered: ['gst', 'accounting', 'itr'],
      certifications: ['GST Practitioner Test Certificate'],
      whyChooseMe: 'Fast responses, clean documentation, and reliable compliance support.',
      location: {
        city: 'Bangalore',
        state: 'Karnataka',
        country: 'India',
        address: 'MG Road, Bangalore'
      }
    }
  });

  await request('/users/availability', {
    method: 'PUT',
    token,
    body: { availability: 'available' }
  });

  ok('Updated expert profile fields');
}

async function assertQuestionnaireCompletion(token) {
  const data = await request('/users/me', { token });
  if (!data.user || data.user.questionnaireCompleted !== true) {
    throw new Error('Expert questionnaire completion did not persist');
  }
  ok('Expert questionnaire completion persisted');
}

async function assertProfileViewIncrements(clientToken, expertId) {
  const beforeUser = await User.findById(expertId).select('profileViews').lean();
  await request(`/users/expert/${expertId}`, { token: clientToken });
  const afterUser = await User.findById(expertId).select('profileViews').lean();
  if ((afterUser.profileViews || 0) !== (beforeUser.profileViews || 0) + 1) {
    throw new Error('Expert profile view count did not increase by 1');
  }
  ok('Customer profile view increments expert profile view count');
}

async function assertMinimumBudgetValidation(clientToken) {
  await expectRequestFailure('/requests', {
    method: 'POST',
    token: clientToken,
    body: {
      service: 'gst',
      title: `WI Invalid Budget Test ${runId}`,
      description: 'Automated test should reject this low budget request.',
      timeline: 'week',
      budget: '0',
      location: 'Bangalore',
      answers: { budget: 0 }
    }
  }, 'MIN_BUDGET_REQUIRED');
  ok('Customer post with ₹0 budget is rejected');
}

async function createCustomerRequest(token) {
  const title = `WI Automated GST Test ${runId}`;
  const data = await request('/requests', {
    method: 'POST',
    token,
    body: {
      service: 'gst',
      title,
      description: 'Automated full-flow test request. Safe to delete after testing.',
      timeline: 'week',
      budget: '5000',
      location: 'Indiranagar, Bangalore, Karnataka 560038',
      answers: {
        service_location_type: 'my-location',
        full_address: {
          area: 'Indiranagar',
          city: 'Bangalore',
          state: 'Karnataka',
          pincode: '560038'
        },
        gstTurnover: '5-20',
        urgency: 'week',
        budget: '5000'
      }
    }
  });
  ok('Created customer request: ' + data.request._id);
  return data.request;
}

async function approachRequest(token, requestId) {
  const available = await request('/requests/available?service=gst', { token });
  const visible = (available.requests || []).some((r) => String(r._id) === String(requestId));
  if (!visible) throw new Error('Created request was not visible in expert available requests');
  ok('Expert can see the created request');

  const data = await request('/approaches', {
    method: 'POST',
    token,
    body: {
      request: requestId,
      quote: 4500,
      message: 'Automated test approach: I can complete this GST compliance request within the selected timeline.'
    }
  });
  ok('Expert approached request: ' + data.approach._id);
  return data.approach;
}

async function exchangeChatMessages(expertToken, clientToken, requestId, approach) {
  const chatData = await request('/chats/start', {
    method: 'POST',
    token: expertToken,
    body: {
      requestId,
      expertId: String(approach.expert),
      clientId: String(approach.client)
    }
  });

  const chatId = chatData.chat._id;
  ok('Started chat: ' + chatId);

  await request(`/chats/${chatId}/messages`, {
    method: 'POST',
    token: expertToken,
    body: { text: 'Hi, I can help with this request.' }
  });
  ok('Expert sent chat message');

  const expertOwnRead = await request(`/chats/${chatId}/messages`, { token: expertToken });
  const expertMessageBeforeCustomerRead = expertOwnRead.messages[expertOwnRead.messages.length - 1];
  if (expertMessageBeforeCustomerRead.readAt) {
    throw new Error('Expert message was marked seen before customer opened chat');
  }
  ok('New expert message remains Sent before customer reads it');

  await request(`/chats/${chatId}/messages`, {
    method: 'POST',
    token: clientToken,
    body: { text: 'Hi, thanks. Please go ahead.' }
  });
  ok('Customer replied in chat');

  const messages = await request(`/chats/${chatId}/messages`, { token: clientToken });
  if (!messages.messages || messages.messages.length < 2) {
    throw new Error('Chat did not contain both test messages');
  }
  const expertAfterCustomerRead = await request(`/chats/${chatId}/messages`, { token: expertToken });
  const expertMessageAfterCustomerRead = expertAfterCustomerRead.messages.find((m) => String(m.sender._id || m.sender) === String(approach.expert));
  if (!expertMessageAfterCustomerRead || !expertMessageAfterCustomerRead.readAt) {
    throw new Error('Expert message did not change to Seen after customer opened chat');
  }
  ok('Chat message history verified');
  return chatData.chat;
}

async function assertInviteReward(inviterId, invitedId) {
  const invite = await ExpertInvite.findOne({ inviter: inviterId, invitedUser: invitedId }).lean();
  if (!invite || invite.status !== 'completed' || invite.creditsAwarded !== 10) {
    throw new Error('Invite reward history was not completed');
  }
  ok('Invite reward credited and invite history completed');
}

async function ensureEmailSettingsEnabled() {
  await EmailSettings.findOneAndUpdate(
    { singleton: true },
    { $set: { expert_new_post: true, expert_invite_received: true, client_post_stale_reminder: true } },
    { upsert: true, new: true }
  );
  ok('Email notification settings enabled for new posts, expert invites, and stale request reminders');
}

async function assertEmailLog(type, to, reasonContains) {
  const query = { type, to };
  let log = null;
  for (let i = 0; i < 20; i++) {
    log = await EmailLog.findOne(query).sort({ createdAt: -1 }).lean();
    if (log) break;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  if (!log) throw new Error(`Missing email log for ${type} to ${to}`);
  if (reasonContains && !String(log.reason || '').toLowerCase().includes(reasonContains.toLowerCase())) {
    throw new Error(`Email log ${type} reason did not include ${reasonContains}`);
  }
  if (!['sent', 'failed'].includes(log.status)) {
    throw new Error(`Email log ${type} had invalid status ${log.status}`);
  }
  ok(`Email log recorded for ${type}: ${log.status}`);
  return log;
}

async function assertAuditLog(action, targetId) {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
  let log = null;
  for (let i = 0; i < 10; i++) {
    const query = { action };
    if (targetId) query.targetId = targetId;
    log = await AuditLog.findOne(query).sort({ createdAt: -1 }).lean();
    if (log) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!log) throw new Error(`Missing audit log for ${action}`);
  ok(`Audit log recorded: ${action}`);
  return log;
}

async function assertDirectExpertInviteFlow(clientToken, expertToken, expertId) {
  const inviteTitle = `WI Direct Invite ITR ${runId}`;
  const invite = await request('/users/expert-invites', {
    method: 'POST',
    token: clientToken,
    body: {
      expertId,
      service: 'itr',
      title: inviteTitle,
      description: 'Automated direct expert invite created from Explore questionnaire.',
      answers: {
        service: 'itr',
        itrTaxpayerType: 'salaried',
        itrAnnualIncome: '10-15',
        itrIncomeSources: ['salary'],
        urgency: 'week',
        budget: 2500,
        description: 'Automated direct expert invite created from Explore questionnaire.'
      },
      timeline: 'week',
      budget: 2500,
      location: 'Bengaluru, Karnataka'
    }
  });
  if (!invite.invite || !invite.invite.data || !invite.invite.data.answers.itrTaxpayerType) {
    throw new Error('Direct expert invite did not save questionnaire answers');
  }
  ok('Customer created direct expert invite with questionnaire answers');

  const clientInvites = await request('/users/my-invites', { token: clientToken });
  if (!(clientInvites.invites || []).some((i) => String(i._id) === String(invite.invite._id))) {
    throw new Error('Client invite history did not include direct expert invite');
  }
  ok('Client can see direct expert invite history');

  const expertNotifications = await request('/notifications', { token: expertToken });
  const expertInviteNotif = (expertNotifications.notifications || []).find((n) => String(n._id) === String(invite.invite._id));
  if (!expertInviteNotif || !expertInviteNotif.data || !expertInviteNotif.data.answers.itrAnnualIncome) {
    throw new Error('Expert notification missing direct invite questionnaire data');
  }
  ok('Expert can see direct invite notification data before unlock');

  await request(`/users/expert-invites/${invite.invite._id}`, {
    method: 'PUT',
    token: clientToken,
    body: {
      budget: 3000,
      description: 'Updated automated direct invite details.',
      location: 'Hubli, Karnataka'
    }
  });
  ok('Customer can edit direct expert invite');

  const unlock = await request(`/users/unlock-interest/${invite.invite._id}`, {
    method: 'POST',
    token: expertToken
  });
  if (!unlock.client || !unlock.client.email) throw new Error('Direct expert invite unlock did not return client contact');
  ok('Expert can unlock direct invite contact using calculated credits');

  await request(`/users/invite-complete/${invite.invite._id}`, {
    method: 'POST',
    token: clientToken
  });
  ok('Customer can mark direct expert invite completed');

  const cancelInvite = await request('/users/expert-invites', {
    method: 'POST',
    token: clientToken,
    body: {
      expertId,
      service: 'itr',
      title: `${inviteTitle} Cancel`,
      description: 'Automated direct invite cancellation test.',
      answers: { service: 'itr', itrTaxpayerType: 'salaried', urgency: 'week', budget: 2500 },
      timeline: 'week',
      budget: 2500,
      location: 'Mysuru, Karnataka'
    }
  });
  await request(`/users/expert-invites/${cancelInvite.invite._id}/cancel`, {
    method: 'POST',
    token: clientToken
  });
  await expectRequestFailure(`/users/unlock-interest/${cancelInvite.invite._id}`, {
    method: 'POST',
    token: expertToken
  });
  ok('Cancelled direct expert invite cannot be unlocked');

  return invite.invite;
}

async function assertAdminRank(adminToken, expertId) {
  await request(`/admin/experts/${expertId}/boost`, {
    method: 'PUT',
    token: adminToken,
    body: { adminBoost: 20, adminRank: 1 }
  });
  const experts = await request('/users/experts?limit=5');
  if (!experts.experts || String(experts.experts[0]._id) !== String(expertId)) {
    throw new Error('Admin rank did not move expert to the top of public search results');
  }
  ok('Admin rank controls expert search ordering');
}

async function createAndResolveTickets(expertToken, adminToken, approach) {
  const regularTicket = await request('/users/tickets', {
    method: 'POST',
    token: expertToken,
    body: {
      subject: 'Automated test support ticket',
      issueType: 'general_support',
      description: 'Automated flow test asks admin to resolve this ticket.',
      priority: 'medium'
    }
  });
  ok('Expert raised support ticket: ' + regularTicket.ticket._id);

  await request(`/admin/tickets/${regularTicket.ticket._id}/resolve`, {
    method: 'POST',
    token: adminToken,
    body: { note: 'Resolved by automated full-flow test.' }
  });
  ok('Admin resolved support ticket');

  const refundTicket = await request('/users/tickets', {
    method: 'POST',
    token: expertToken,
    body: {
      subject: 'Automated test refund ticket',
      issueType: 'credit_refund',
      description: 'Automated flow test refund request for a previous approach.',
      priority: 'medium',
      relatedApproachId: approach._id,
      eligibleCredits: approach.creditsSpent || 0,
      isExpertRefund: true
    }
  });
  ok('Expert raised refund ticket: ' + refundTicket.ticket._id);

  await request(`/admin/tickets/${refundTicket.ticket._id}/reject`, {
    method: 'POST',
    token: adminToken,
    body: { note: 'Rejected by automated full-flow test.' }
  });
  ok('Admin rejected refund ticket');

  return { regularTicket: regularTicket.ticket, refundTicket: refundTicket.ticket };
}

async function acceptCompleteAndRate(clientToken, requestId, approachId, expertId) {
  const approaches = await request(`/requests/${requestId}/approaches`, { token: clientToken });
  if (!(approaches.approaches || []).some((a) => String(a._id) === String(approachId))) {
    throw new Error('Client could not see the expert approach');
  }
  ok('Customer can see expert approach');

  await request(`/approaches/${approachId}/status`, {
    method: 'PUT',
    token: clientToken,
    body: { status: 'accepted' }
  });
  ok('Customer accepted approach');

  await request(`/requests/${requestId}/complete`, {
    method: 'POST',
    token: clientToken,
    body: { expertId }
  });
  ok('Customer completed request');

  const pendingRating = await request('/ratings/pending/next', { token: clientToken });
  if (!pendingRating.pendingRating || String(pendingRating.pendingRating.approachId) !== String(approachId)) {
    throw new Error('Completed request did not appear in mandatory pending rating gate');
  }
  ok('Skipped rating is detected before dashboard access');

  const rating = await request('/ratings', {
    method: 'POST',
    token: clientToken,
    body: {
      expertId,
      requestId,
      approachId,
      rating: 5,
      review: 'Automated smoke test rating after successful full-flow completion.',
      categories: {
        communication: 5,
        quality: 5,
        timeliness: 5,
        value: 5
      },
      wouldRecommend: true
    }
  });
  ok('Customer submitted rating: ' + rating.rating._id);
  await assertAuditLog('rating_completed', rating.rating._id);
  return rating;
}

async function assertStaleRequestLifecycle(clientToken, expertToken, clientId) {
  const stale = await createCustomerRequest(clientToken);
  await Request.findByIdAndUpdate(stale._id, {
    $set: {
      status: 'active',
      staleReminderSentAt: null,
      renewedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    }
  });

  await processStaleRequests(new Date());
  const reminded = await Request.findById(stale._id).lean();
  if (!reminded.staleReminderSentAt || reminded.status === 'purged') {
    throw new Error('Stale request reminder was not recorded correctly');
  }
  await assertEmailLog('client_post_stale_reminder', accounts.client.email, 'confirmation required');
  await assertAuditLog('post_purge_mail_sent', stale._id);
  ok('7-day stale request reminder sent and logged');

  await request(`/requests/${stale._id}/renew`, { method: 'POST', token: clientToken });
  const renewed = await Request.findById(stale._id).lean();
  if (renewed.staleReminderSentAt || !renewed.renewedAt || renewed.renewalCount < 1) {
    throw new Error('Customer stale request renewal did not clear reminder and extend request');
  }
  await assertAuditLog('post_renewed', stale._id);
  ok('Customer can renew stale request for another 7 days');

  await Request.findByIdAndUpdate(stale._id, {
    $set: {
      status: 'active',
      staleReminderSentAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      renewedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    }
  });
  await processStaleRequests(new Date());
  const purged = await Request.findById(stale._id).lean();
  if (purged.status !== 'purged' || !purged.purgedAt) {
    throw new Error('Unconfirmed stale request was not purged');
  }
  await assertAuditLog('post_purged', stale._id);

  const available = await request('/requests/available?service=gst', { token: expertToken });
  if ((available.requests || []).some((r) => String(r._id) === String(stale._id))) {
    throw new Error('Purged request is still visible to experts');
  }
  ok('Unconfirmed stale request is purged and hidden from experts');
}

async function main() {
  step('Checking backend');
  await ensureBackend();

  step('Preparing test users');
  await mongoose.connect(process.env.MONGODB_URI);
  const client = await upsertUser(accounts.client);
  const expert = await upsertUser(accounts.expert);
  const invitedExpert = await upsertUser(accounts.invitedExpert);
  await createInviteLink(expert, invitedExpert);
  await ensureEmailSettingsEnabled();
  await EmailLog.deleteMany({
    type: { $in: ['expert_new_post', 'expert_invite_received', 'client_post_stale_reminder'] },
    to: { $in: [accounts.expert.email, accounts.invitedExpert.email, accounts.client.email] }
  });
  await mongoose.disconnect();

  step('Logging in');
  const clientLogin = await login(accounts.client);
  const expertLogin = await login(accounts.expert);
  const invitedExpertLogin = await login(accounts.invitedExpert);
  const adminLogin = await loginAdmin();

  step('Updating expert profile');
  await updateExpertProfile(expertLogin.token, accounts.expert);
  await updateExpertProfile(invitedExpertLogin.token, accounts.invitedExpert);
  await assertQuestionnaireCompletion(invitedExpertLogin.token);

  step('Minimum customer post budget validation');
  await assertMinimumBudgetValidation(clientLogin.token);

  step('Creating customer post');
  const createdRequest = await createCustomerRequest(clientLogin.token);
  await mongoose.connect(process.env.MONGODB_URI);
  await assertEmailLog('expert_new_post', accounts.invitedExpert.email, 'new client request');
  await mongoose.disconnect();

  step('Direct expert invite from Explore');
  const directInvite = await assertDirectExpertInviteFlow(clientLogin.token, expertLogin.token, expert._id);
  await mongoose.connect(process.env.MONGODB_URI);
  await assertEmailLog('expert_invite_received', accounts.expert.email, 'direct expert invite');
  await mongoose.disconnect();

  step('Expert profile view count');
  await mongoose.connect(process.env.MONGODB_URI);
  await assertProfileViewIncrements(clientLogin.token, invitedExpert._id);
  await mongoose.disconnect();

  step('Invited expert approaching post');
  const approach = await approachRequest(invitedExpertLogin.token, createdRequest._id);

  step('Invite reward');
  await mongoose.connect(process.env.MONGODB_URI);
  await assertInviteReward(expert._id, invitedExpert._id);
  await mongoose.disconnect();

  step('Chat exchange');
  await exchangeChatMessages(invitedExpertLogin.token, clientLogin.token, createdRequest._id, approach);

  step('Customer accepting, completing, and rating');
  const rating = await acceptCompleteAndRate(
    clientLogin.token,
    createdRequest._id,
    approach._id,
    invitedExpert._id
  );

  step('Stale request reminder, renewal, and purge');
  await mongoose.connect(process.env.MONGODB_URI);
  await assertStaleRequestLifecycle(clientLogin.token, invitedExpertLogin.token);
  await mongoose.disconnect();

  step('Admin rank and boost ordering');
  await assertAdminRank(adminLogin.token, invitedExpert._id);

  step('Support tickets and admin decisions');
  const tickets = await createAndResolveTickets(invitedExpertLogin.token, adminLogin.token, approach);

  console.log('\n==============================');
  console.log('WORKINDEX FULL FLOW TEST PASSED');
  console.log('Request : ' + createdRequest._id);
  console.log('Direct  : ' + directInvite._id + ' invite tested');
  console.log('Approach: ' + approach._id);
  console.log('Rating  : ' + rating.rating._id);
  console.log('Ticket  : ' + tickets.regularTicket._id + ' resolved');
  console.log('Refund  : ' + tickets.refundTicket._id + ' rejected');
  console.log('Client  : ' + accounts.client.email);
  console.log('Expert  : ' + accounts.invitedExpert.email);
  console.log('Inviter : ' + accounts.expert.email + ' (+10 credits verified)');
  console.log('==============================\n');
}

main().catch(async (err) => {
  try {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  } catch (_) {}
  console.error('\nWORKINDEX FULL FLOW TEST FAILED');
  console.error(err.message);
  process.exit(1);
});
