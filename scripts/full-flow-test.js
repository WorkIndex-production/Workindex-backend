require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');

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
  let user = await User.findOne({ email: account.email }).select('+password');
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
    isRejected: false
  };

  if (!user) {
    user = await User.create({
      ...data,
      credits: account.role === 'expert' ? 500 : 50
    });
    ok(`Created ${account.role}: ${account.email}`);
    return user;
  }

  Object.assign(user, data);
  if (account.role === 'expert' && (user.credits || 0) < 200) {
    user.credits = 500;
  }
  await user.save();
  ok(`Reused ${account.role}: ${account.email}`);
  return user;
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

async function updateExpertProfile(token) {
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
      phone: accounts.expert.phone,
      whyChooseMe: 'Fast responses, clean documentation, and reliable compliance support.',
      profile
    }
  });

  await request('/users/me', {
    method: 'PUT',
    token,
    body: {
      name: accounts.expert.name,
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
  ok('Chat message history verified');
  return chatData.chat;
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
  return rating;
}

async function main() {
  step('Checking backend');
  await ensureBackend();

  step('Preparing test users');
  await mongoose.connect(process.env.MONGODB_URI);
  const client = await upsertUser(accounts.client);
  const expert = await upsertUser(accounts.expert);
  await mongoose.disconnect();

  step('Logging in');
  const clientLogin = await login(accounts.client);
  const expertLogin = await login(accounts.expert);
  const adminLogin = await loginAdmin();

  step('Updating expert profile');
  await updateExpertProfile(expertLogin.token);

  step('Creating customer post');
  const createdRequest = await createCustomerRequest(clientLogin.token);

  step('Expert approaching post');
  const approach = await approachRequest(expertLogin.token, createdRequest._id);

  step('Chat exchange');
  await exchangeChatMessages(expertLogin.token, clientLogin.token, createdRequest._id, approach);

  step('Customer accepting, completing, and rating');
  const rating = await acceptCompleteAndRate(
    clientLogin.token,
    createdRequest._id,
    approach._id,
    expert._id
  );

  step('Support tickets and admin decisions');
  const tickets = await createAndResolveTickets(expertLogin.token, adminLogin.token, approach);

  console.log('\n==============================');
  console.log('WORKINDEX FULL FLOW TEST PASSED');
  console.log('Request : ' + createdRequest._id);
  console.log('Approach: ' + approach._id);
  console.log('Rating  : ' + rating.rating._id);
  console.log('Ticket  : ' + tickets.regularTicket._id + ' resolved');
  console.log('Refund  : ' + tickets.refundTicket._id + ' rejected');
  console.log('Client  : ' + accounts.client.email);
  console.log('Expert  : ' + accounts.expert.email);
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
