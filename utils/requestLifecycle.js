const Request = require('../models/Request');
const User = require('../models/User');
const { logAudit } = require('./audit');
const { sendClientPostStaleReminder } = require('./notificationEmailService');

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function staleBaseDate(request) {
  return request.renewedAt || request.createdAt;
}

async function sendStaleReminder(request, now) {
  const client = await User.findById(request.client).select('name email').lean();
  if (!client || !client.email) return false;

  const deadline = addDays(now, 3);
  await sendClientPostStaleReminder({
    to: client.email,
    name: client.name || 'Customer',
    postTitle: request.title,
    service: request.service,
    deadline,
    userId: client._id
  });

  request.staleReminderSentAt = now;
  await request.save();

  await logAudit(
    { id: client._id, role: 'client', name: client.name || 'Customer' },
    'post_purge_mail_sent',
    { type: 'request', id: request._id, name: request.title },
    { deadline, service: request.service }
  );
  return true;
}

async function purgeRequest(request, now) {
  const client = await User.findById(request.client).select('name').lean();
  request.status = 'purged';
  request.purgedAt = now;
  request.purgeReason = 'No customer confirmation within 3 days after stale reminder';
  await request.save();

  await logAudit(
    { id: request.client, role: 'client', name: client ? client.name : 'Customer' },
    'post_purged',
    { type: 'request', id: request._id, name: request.title },
    { staleReminderSentAt: request.staleReminderSentAt, service: request.service }
  );
}

async function processStaleRequests(now = new Date()) {
  const activeRequests = await Request.find({
    status: { $in: ['pending', 'active'] },
    isCompleted: { $ne: true }
  });

  let remindersSent = 0;
  let purged = 0;

  for (const request of activeRequests) {
    if (request.staleReminderSentAt) {
      if (request.staleReminderSentAt.getTime() <= now.getTime() - (3 * DAY_MS)) {
        await purgeRequest(request, now);
        purged += 1;
      }
      continue;
    }

    const base = staleBaseDate(request);
    if (base && base.getTime() <= now.getTime() - (7 * DAY_MS)) {
      const sent = await sendStaleReminder(request, now);
      if (sent) remindersSent += 1;
    }
  }

  return { remindersSent, purged };
}

module.exports = {
  processStaleRequests
};
