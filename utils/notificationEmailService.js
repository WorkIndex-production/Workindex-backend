// utils/notificationEmailService.js
// All transactional / notification emails for WorkIndex
// Uses same Brevo HTTPS pattern as emailService.js

const https = require('https');

const ADMIN_EMAIL = 'workindex318@gmail.com';
const ADMIN_NAME  = 'WorkIndex Admin';

// ─── BREVO SEND HELPER ────────────────────────────────────
async function sendViaBrevo({ to, toName, subject, htmlContent }) {
  const payload = JSON.stringify({
    sender:      { name: 'WorkIndex', email: process.env.BREVO_SMTP_USER },
    to:          [{ email: to, name: toName || to }],
    subject,
    htmlContent
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'api-key':        process.env.BREVO_API_KEY
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 201) {
          console.log(`✅ Email [${subject}] sent to ${to}`);
          resolve({ success: true });
        } else {
          console.error(`❌ Brevo error ${res.statusCode}:`, data);
          resolve({ success: false, error: data });
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ Brevo request error:', err.message);
      resolve({ success: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// ─── EMAIL LOG HELPER ─────────────────────────────────────
async function logEmail({ to, toName, subject, type, category, reason, status, error, userId }) {
  try {
    const EmailLog = require('../models/EmailLog');
    await EmailLog.create({ to, toName, subject, type, category, reason, status: status || 'sent', error: error || '', userId: userId || null });
  } catch (e) {
    console.error('EmailLog save error:', e.message);
  }
}

// ─── PER-USER EMAIL PREFERENCE CHECK ─────────────────────
async function isEmailEnabledForUser(userId) {
  try {
    if (!userId) return true;
    const mongoose = require('mongoose');
    const User = mongoose.model('User');
    const user = await User.findById(userId).select('preferences').lean();
    if (!user) return true;
    const notifPrefs = user.preferences && user.preferences.notifications;
        console.log('📧 Email pref check for', userId, ':', JSON.stringify(notifPrefs)); // ← ADD THIS
    if (notifPrefs && notifPrefs.email === false) return false;
    return true;
  } catch(e) {
    return true; // fail open — better to send than miss
  }
}

async function isNewPostEmailEnabledForUser(userId) {
  try {
    if (!userId) return true;
    const mongoose = require('mongoose');
    const User = mongoose.model('User');
    const user = await User.findById(userId).select('preferences').lean();
    if (!user) return true;
    const notifPrefs = user.preferences && user.preferences.notifications;
    if (notifPrefs && notifPrefs.email === false) return false;
    if (notifPrefs && notifPrefs.newPosts === false) return false;
    return true;
  } catch(e) {
    return true;
  }
}
// ─── SETTINGS CHECK ───────────────────────────────────────
async function isEnabled(type) {
  try {
    const EmailSettings = require('../models/EmailSettings');
    let settings = await EmailSettings.findOne({ singleton: true });
    if (!settings) {
      settings = await EmailSettings.create({ singleton: true });
    }
    return settings[type] !== false;
  } catch (e) {
    return true; // default ON if settings unavailable
  }
}

// ─── SHARED LAYOUT ────────────────────────────────────────
function layout(title, bodyHTML) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0"
        style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#FC8019;padding:28px 40px;text-align:center;">
            <div style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">WorkIndex</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-top:4px;">Find Verified Professionals</div>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <h2 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 16px;">${title}</h2>
            ${bodyHTML}
          </td>
        </tr>
        <tr>
          <td style="background:#f8f8f8;padding:18px 40px;text-align:center;border-top:1px solid #eeeeee;">
            <p style="font-size:12px;color:#bbbbbb;margin:0;">
              © ${new Date().getFullYear()} WorkIndex &nbsp;·&nbsp; All rights reserved<br>
              <span style="font-size:11px;">If you have questions, reply to this email or visit workindex.in</span>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function infoBox(html) {
  return `<div style="background:#fff8f3;border-left:4px solid #FC8019;border-radius:8px;padding:16px 20px;margin:20px 0;font-size:14px;color:#333;line-height:1.7;">${html}</div>`;
}

function warningBox(html) {
  return `<div style="background:#fff3cd;border-left:4px solid #f59e0b;border-radius:8px;padding:16px 20px;margin:20px 0;font-size:14px;color:#333;line-height:1.7;">${html}</div>`;
}

function dangerBox(html) {
  return `<div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;padding:16px 20px;margin:20px 0;font-size:14px;color:#333;line-height:1.7;">${html}</div>`;
}

function ctaButton(text, url) {
  return `<div style="text-align:center;margin:28px 0;">
    <a href="${url}" style="display:inline-block;background:#FC8019;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;">${text}</a>
  </div>`;
}

function para(text) {
  return `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 14px;">${text}</p>`;
}

// ═══════════════════════════════════════════════════════════
//  CLIENT EMAILS
// ═══════════════════════════════════════════════════════════

// 1. Client Welcome
async function sendClientWelcome({ to, name }) {
  const type = 'client_welcome';
  if (!await isEnabled(type)) return;

  const html = layout('Welcome to WorkIndex! 🎉', `
    ${para(`Hi <strong>${name}</strong>, welcome aboard!`)}
    ${para(`You're now part of a growing community of clients who connect with verified professionals for financial, legal, creative, and technical services — all in one place.`)}
    ${infoBox(`<strong>Here's what you can do:</strong><br>
      ✅ Post a service request in minutes<br>
      ✅ Receive tailored approaches from verified experts<br>
      ✅ Chat, compare, and hire the best fit<br>
      ✅ Review and rate your experience`)}
    ${para(`Ready to get started? Post your first request today and get responses within hours.`)}
    ${ctaButton('Post a Request', 'https://workindex-frontend.vercel.app')}
    ${para(`If you have any questions, our support team is always here to help.`)}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: 'Welcome to WorkIndex — Find Professionals You Can Trust', htmlContent: html });
  await logEmail({ to, toName: name, subject: 'Welcome to WorkIndex', type, category: 'client', reason: 'New client registered' , status: result.success ? 'sent' : 'failed', error: result.error || '' });
}

// 2. Client: Post Created
async function sendClientPostCreated({ to, name, postTitle, service, userId }) {
  const type = 'client_post_created';
  if (!await isEnabled(type)) return;
  if (!await isEmailEnabledForUser(userId)) return;

  const html = layout('Your request has been posted ✅', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${para(`Your service request has been successfully posted on WorkIndex and is now visible to verified professionals.`)}
    ${infoBox(`<strong>Request Details:</strong><br>
      📋 <strong>Title:</strong> ${postTitle}<br>
      🔧 <strong>Service:</strong> ${service}`)}
    ${para(`Qualified experts will review your request and send their approach proposals. You'll be notified as soon as you receive responses.`)}
    ${para(`<strong>What happens next?</strong><br>
      Experts will submit their approach with proposed timelines and details. You can review each one, chat with them, and hire the best fit.`)}
    ${ctaButton('View My Requests', 'https://workindex-frontend.vercel.app')}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: `Your request "${postTitle}" is now live on WorkIndex`, htmlContent: html });
  await logEmail({ to, toName: name, subject: `Request posted: ${postTitle}`, type, category: 'client', reason: 'Client posted a new request', status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// 3. Client: Expert Approached
async function sendClientExpertApproached({ to, name, postTitle, expertName, userId }) {
  const type = 'client_expert_approached';
  if (!await isEnabled(type)) return;
  if (!await isEmailEnabledForUser(userId)) return;

  const html = layout('A professional has responded to your request 📬', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${para(`Great news! A verified professional has submitted a proposal for your request.`)}
    ${infoBox(`<strong>${expertName}</strong> has approached your request:<br>
      📋 <strong>"${postTitle}"</strong>`)}
    ${para(`Log in to your dashboard to review their proposal, check their profile, ratings, and experience — then start a conversation if you're interested.`)}
    ${para(`You may receive multiple proposals. Take your time to compare and choose the best professional for your needs.`)}
    ${ctaButton('Review Proposals', 'https://workindex-frontend.vercel.app')}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: `${expertName} has responded to your WorkIndex request`, htmlContent: html });
  await logEmail({ to, toName: name, subject: `Expert approached: ${postTitle}`, type, category: 'client', reason: `Expert ${expertName} approached client's request`, status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// 4. Client: Post Suspended
async function sendClientPostSuspended({ to, name, postTitle, reportCount, userId }) {
  const type = 'client_post_suspended';
  if (!await isEnabled(type)) return;
if (!await isEmailEnabledForUser(userId)) return;
  
  const html = layout('Your request has been suspended ⚠️', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${warningBox(`Your request <strong>"${postTitle}"</strong> has been flagged and suspended after being reported by ${reportCount} professionals on the platform.`)}
    ${para(`Your request is currently under admin review. During this period, it will not be visible to professionals.`)}
    ${para(`<strong>Why does this happen?</strong><br>
      Our platform relies on reports from verified professionals to maintain quality. When multiple experts flag a request as suspicious or in violation of guidelines, it is automatically suspended pending review.`)}
    ${para(`<strong>What can you do?</strong><br>
      If you believe this is an error, please raise a support ticket and our admin team will review your case within 24–48 hours.`)}
    ${ctaButton('Raise a Support Ticket', 'https://workindex-frontend.vercel.app')}
    ${para(`We take platform safety seriously and appreciate your understanding.`)}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: `Your WorkIndex request "${postTitle}" has been suspended`, htmlContent: html });
  await logEmail({ to, toName: name, subject: `Post suspended: ${postTitle}`, type, category: 'client', reason: `Post suspended after ${reportCount} reports`, status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

async function sendClientPostStaleReminder({ to, name, postTitle, service, deadline, userId }) {
  const type = 'client_post_stale_reminder';
  if (!await isEnabled(type)) return;
  if (!await isEmailEnabledForUser(userId)) return;

  const deadlineText = deadline
    ? new Date(deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'within 3 days';
  const html = layout('Confirm if you still need this service', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${para(`Your WorkIndex request <strong>"${postTitle}"</strong> has been open for 7 days.`)}
    ${warningBox(`Please log in and confirm by <strong>${deadlineText}</strong> if you still want professionals to approach this request. If we do not hear back, the request will be removed from expert listings so professionals do not spend time on old requirements.`)}
    ${infoBox(`<strong>Service:</strong> ${service || 'Service request'}<br><strong>Action needed:</strong> Confirm that you still need this service`)}
    ${ctaButton('Confirm Request', 'https://workindex.co.in')}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: `Please confirm your WorkIndex request: ${postTitle}`, htmlContent: html });
  await logEmail({ to, toName: name, subject: `Stale request reminder: ${postTitle}`, type, category: 'client', reason: 'Request open for 7 days; confirmation required', status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// 5. Client: Account Restricted
async function sendClientRestricted({ to, name, reason, warningCount, userId }) {
  const type = 'client_restricted';
  if (!await isEnabled(type)) return;
  if (!await isEmailEnabledForUser(userId)) return;

  const html = layout('Your account has been restricted 🚫', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${dangerBox(`Your WorkIndex account has been <strong>restricted</strong> due to repeated violations of our platform guidelines.<br><br>
      <strong>Reason:</strong> ${reason || 'Multiple reports from verified professionals'}<br>
      <strong>Warnings issued:</strong> ${warningCount}/3`)}
    ${para(`While restricted, you <strong>cannot post new requests, contact professionals, or use platform features</strong>. You can still log in and view existing content.`)}
    ${para(`<strong>How to resolve this:</strong>`)}
    ${infoBox(`1. Log in to your WorkIndex account<br>
      2. Go to the <strong>Support Tickets</strong> section<br>
      3. Raise a ticket describing your situation<br>
      4. Our admin team will review and respond within 24–48 hours<br>
      5. If the restriction is lifted, your account will be fully restored`)}
    ${ctaButton('Raise a Support Ticket', 'https://workindex-frontend.vercel.app')}
    ${para(`If you believe this restriction was applied in error, please explain your case clearly in your support ticket.`)}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: 'Important: Your WorkIndex account has been restricted', htmlContent: html });
  await logEmail({ to, toName: name, subject: 'Account restricted', type, category: 'client', reason: reason || 'Auto-restricted after 3 reports', status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// 6. Client: Account Banned
async function sendClientBanned({ to, name, reason, userId }) {
  const type = 'client_banned';
  if (!await isEnabled(type)) return;
if (!await isEmailEnabledForUser(userId)) return;
  
  const html = layout('Your account has been suspended 🚫', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${dangerBox(`Your WorkIndex account has been <strong>permanently suspended</strong> due to serious violations of our Terms of Service.<br><br>
      <strong>Reason:</strong> ${reason || 'Repeated or severe platform violations'}`)}
    ${para(`You are no longer able to access WorkIndex services with this account.`)}
    ${para(`<strong>If you believe this was a mistake:</strong>`)}
    ${infoBox(`1. Send an email to <strong>workindex318@gmail.com</strong><br>
      2. Include your registered email address and the reason you believe this is an error<br>
      3. Our team will review serious appeals within 5–7 business days`)}
    ${para(`We take the safety and trust of our platform community seriously. Thank you for your understanding.`)}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: 'Important: Your WorkIndex account has been suspended', htmlContent: html });
  await logEmail({ to, toName: name, subject: 'Account banned', type, category: 'client', reason: reason || 'Banned by admin', status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// ═══════════════════════════════════════════════════════════
//  EXPERT EMAILS
// ═══════════════════════════════════════════════════════════

// 7. Expert Welcome
async function sendExpertWelcome({ to, name }) {
  const type = 'expert_welcome';
  if (!await isEnabled(type)) return;

  const html = layout('Welcome to WorkIndex, Professional! 🎉', `
    ${para(`Hi <strong>${name}</strong>, welcome to the WorkIndex professional network!`)}
    ${para(`You've joined a platform where verified clients post real service requests and professionals like you submit tailored proposals to win quality work.`)}
    ${infoBox(`<strong>How it works for you:</strong><br>
      ✅ Browse available client requests in your dashboard<br>
      ✅ Submit your approach with timeline and details<br>
      ✅ Spend credits to approach clients<br>
      ✅ Get hired, deliver great work, earn top reviews<br>
      ✅ Build your reputation and grow your client base`)}
    ${para(`<strong>Your starter credits:</strong> You've been given <strong>50 free credits</strong> to get started. Use them to approach clients and win your first projects.`)}
    ${para(`Complete your profile to stand out — add your specialization, bio, and why clients should choose you.`)}
    ${ctaButton('Complete My Profile', 'https://workindex-frontend.vercel.app')}
    ${para(`Have questions? Reply to this email or raise a support ticket from your dashboard.`)}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: 'Welcome to WorkIndex — Start Winning Clients Today', htmlContent: html });
  await logEmail({ to, toName: name, subject: 'Welcome to WorkIndex (Expert)', type, category: 'expert', reason: 'New expert registered', status: result.success ? 'sent' : 'failed', error: result.error || '' });
}

// 8. Expert: Credits Purchased
async function sendExpertCreditsPurchased({ to, name, creditsPurchased, amountPaid, newBalance, userId }) {
  const type = 'expert_credits_purchased';
  if (!await isEnabled(type)) return;
if (!await isEmailEnabledForUser(userId)) return;
  
  const html = layout('Credits added to your account ✅', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${para(`Your credit purchase was successful. Your account has been topped up and you're ready to approach more clients.`)}
    ${infoBox(`<strong>Transaction Summary:</strong><br>
      💳 <strong>Credits Purchased:</strong> ${creditsPurchased} credits<br>
      💰 <strong>Amount Paid:</strong> ₹${amountPaid}<br>
      📊 <strong>New Balance:</strong> ${newBalance} credits`)}
    ${para(`Use your credits to approach client requests in your dashboard. Each service category has a fixed credit cost.`)}
    ${ctaButton('Browse Client Requests', 'https://workindex-frontend.vercel.app')}
    ${para(`Need a receipt or invoice? You can generate one from the billing section in your profile settings.`)}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: `${creditsPurchased} credits added to your WorkIndex account`, htmlContent: html });
  await logEmail({ to, toName: name, subject: `Credits purchased: ${creditsPurchased}`, type, category: 'expert', reason: `Purchased ${creditsPurchased} credits for ₹${amountPaid}`, status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// 9. Expert: Credits Refunded by Admin
async function sendExpertCreditsRefunded({ to, name, creditsRefunded, newBalance, adminNote, userId }) {
  const type = 'expert_credits_refunded';
  if (!await isEnabled(type)) return;
if (!await isEmailEnabledForUser(userId)) return;
  
  const html = layout('Credit refund processed ✅', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${para(`A credit refund has been processed to your WorkIndex account by the admin team.`)}
    ${infoBox(`<strong>Refund Details:</strong><br>
      💰 <strong>Credits Refunded:</strong> +${creditsRefunded} credits<br>
      📊 <strong>New Balance:</strong> ${newBalance} credits<br>
      ${adminNote ? `📝 <strong>Note:</strong> ${adminNote}` : ''}`)}
    ${para(`Your credits are now available to use. If you have any questions about this refund, please raise a support ticket from your dashboard.`)}
    ${ctaButton('View My Account', 'https://workindex-frontend.vercel.app')}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: `${creditsRefunded} credits have been refunded to your WorkIndex account`, htmlContent: html });
  await logEmail({ to, toName: name, subject: `Credits refunded: ${creditsRefunded}`, type, category: 'expert', reason: `Admin refunded ${creditsRefunded} credits`, status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// 10. Expert: Approach Submitted
async function sendExpertApproachSubmitted({ to, name, postTitle, clientName, creditsSpent, remainingCredits, userId }) {
  const type = 'expert_approach_sent';
  if (!await isEnabled(type)) return;
  if (!await isEmailEnabledForUser(userId)) return;

  const html = layout('Your approach has been submitted ✅', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${para(`Your proposal has been successfully submitted. The client will be notified and can now review your approach.`)}
    ${infoBox(`<strong>Approach Summary:</strong><br>
      📋 <strong>Request:</strong> ${postTitle}<br>
      👤 <strong>Client:</strong> ${clientName || 'Client'}<br>
      💳 <strong>Credits Spent:</strong> ${creditsSpent} credits<br>
      📊 <strong>Remaining Balance:</strong> ${remainingCredits} credits`)}
    ${para(`<strong>What happens next?</strong><br>
      The client will review all proposals received. If they're interested in yours, they will initiate a chat with you directly. Make sure to check your dashboard regularly.`)}
    ${para(`<strong>Tips to improve your chances:</strong><br>
      ✅ Ensure your profile is complete with a clear bio<br>
      ✅ Add your relevant experience and certifications<br>
      ✅ Respond quickly when clients reach out`)}
    ${ctaButton('View My Approaches', 'https://workindex-frontend.vercel.app')}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: `Your approach for "${postTitle}" has been submitted`, htmlContent: html });
  await logEmail({ to, toName: name, subject: `Approach submitted: ${postTitle}`, type, category: 'expert', reason: `Expert approached request "${postTitle}"`, status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// 10b. Expert: New matching client request posted
async function sendExpertNewPost({ to, name, postTitle, service, credits, location, userId }) {
  const type = 'expert_new_post';
  if (!await isEnabled(type)) return;
  if (!await isNewPostEmailEnabledForUser(userId)) return;

  const html = layout('New client request matching your services', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${para(`A new client request has been posted on WorkIndex that matches your preferred services.`)}
    ${infoBox(`<strong>Request Details:</strong><br>
      <strong>Title:</strong> ${postTitle}<br>
      <strong>Service:</strong> ${service}<br>
      <strong>Location:</strong> ${location || 'Not specified'}<br>
      <strong>Credits to approach:</strong> ${credits || 20}`)}
    ${para(`Log in to review the full requirement and send your approach if it is a good fit.`)}
    ${ctaButton('View New Requests', 'https://workindex-frontend.vercel.app')}
  `);

  const result = await sendViaBrevo({
    to,
    toName: name,
    subject: `New WorkIndex request: ${postTitle}`,
    htmlContent: html
  });
  await logEmail({
    to,
    toName: name,
    subject: `New post: ${postTitle}`,
    type,
    category: 'expert',
    reason: `New client request posted for ${service}`,
    status: result.success ? 'sent' : 'failed',
    error: result.error || '',
    userId
  });
}

// 10c. Expert: Direct invite received from customer Explore
async function sendExpertInviteReceived({ to, name, clientName, postTitle, service, credits, location, budget, userId }) {
  const type = 'expert_invite_received';
  if (!await isEnabled(type)) return;
  if (!await isEmailEnabledForUser(userId)) return;

  const html = layout('You received a direct expert invite', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${para(`A customer has selected your profile from Explore and sent you a direct service invite on WorkIndex.`)}
    ${infoBox(`<strong>Invite Summary:</strong><br>
      <strong>Customer:</strong> ${clientName || 'Customer'}<br>
      <strong>Requirement:</strong> ${postTitle || 'Expert invite'}<br>
      <strong>Service:</strong> ${service || 'Service'}<br>
      <strong>Budget:</strong> ${budget || 'Not specified'}<br>
      <strong>Location:</strong> ${location || 'Not specified'}<br>
      <strong>Credits to unlock contact:</strong> ${credits || 20}`)}
    ${para(`Review the questionnaire details in your Expert Invites section. If it looks like a good fit, unlock the customer's contact details using credits.`)}
    ${ctaButton('View Expert Invites', 'https://workindex-frontend.vercel.app')}
  `);

  const result = await sendViaBrevo({
    to,
    toName: name,
    subject: `New WorkIndex expert invite: ${postTitle || service || 'Service request'}`,
    htmlContent: html
  });
  await logEmail({
    to,
    toName: name,
    subject: `Expert invite received: ${postTitle || service || 'Service request'}`,
    type,
    category: 'expert',
    reason: `Customer ${clientName || 'Customer'} sent a direct expert invite`,
    status: result.success ? 'sent' : 'failed',
    error: result.error || '',
    userId
  });
}

// 11. Expert: Account Restricted
async function sendExpertRestricted({ to, name, reason, warningCount, userId }) {
  const type = 'expert_restricted';
  if (!await isEnabled(type)) return;
  if (!await isEmailEnabledForUser(userId)) return;

  const html = layout('Your account has been restricted 🚫', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${dangerBox(`Your WorkIndex professional account has been <strong>restricted</strong> due to repeated reports or violations of our platform guidelines.<br><br>
      <strong>Reason:</strong> ${reason || 'Multiple client reports'}<br>
      <strong>Warnings issued:</strong> ${warningCount}/3`)}
    ${para(`While restricted, you <strong>cannot submit new approaches, start chats, or contact clients</strong>. You can still log in and view your existing work.`)}
    ${para(`<strong>How to resolve this:</strong>`)}
    ${infoBox(`1. Log in to your WorkIndex account<br>
      2. Go to the <strong>Support Tickets</strong> section<br>
      3. Raise a ticket explaining your situation<br>
      4. Our admin team will review and respond within 24–48 hours<br>
      5. If resolved, your account will be fully restored`)}
    ${ctaButton('Raise a Support Ticket', 'https://workindex-frontend.vercel.app')}
    ${para(`If you believe this restriction was applied in error, please explain clearly in your support ticket.`)}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: 'Important: Your WorkIndex professional account has been restricted', htmlContent: html });
  await logEmail({ to, toName: name, subject: 'Expert account restricted', type, category: 'expert', reason: reason || 'Restricted after warnings', status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// 12. Expert: Account Banned
async function sendExpertBanned({ to, name, reason, userId }) {
  const type = 'expert_banned';
  if (!await isEnabled(type)) return;
  if (!await isEmailEnabledForUser(userId)) return;

  const html = layout('Your professional account has been suspended 🚫', `
    ${para(`Hi <strong>${name}</strong>,`)}
    ${dangerBox(`Your WorkIndex professional account has been <strong>permanently suspended</strong> due to serious or repeated violations of our Terms of Service.<br><br>
      <strong>Reason:</strong> ${reason || 'Serious platform violations'}`)}
    ${para(`You are no longer able to access WorkIndex professional services with this account.`)}
    ${para(`<strong>If you believe this was a mistake:</strong>`)}
    ${infoBox(`1. Send an email to <strong>workindex318@gmail.com</strong><br>
      2. Include your registered email address and registered phone number<br>
      3. Explain clearly why you believe this suspension is in error<br>
      4. Our team will review serious appeals within 5–7 business days`)}
    ${para(`We take the safety and trust of our platform and its clients very seriously.`)}
  `);

  const result = await sendViaBrevo({ to, toName: name, subject: 'Important: Your WorkIndex professional account has been suspended', htmlContent: html });
  await logEmail({ to, toName: name, subject: 'Expert account banned', type, category: 'expert', reason: reason || 'Banned by admin', status: result.success ? 'sent' : 'failed', error: result.error || '', userId });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN EMAILS
// ═══════════════════════════════════════════════════════════

// 13. Admin: Post Suspended
async function sendAdminPostSuspended({ postTitle, postId, clientName, clientEmail, reportCount, reports }) {
  const type = 'admin_post_suspended';
  if (!await isEnabled(type)) return;

  const reportRows = (reports || []).map((r, i) =>
    `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:8px 12px;font-size:13px;">${i + 1}</td>
      <td style="padding:8px 12px;font-size:13px;">${r.reason || 'Suspicious request'}</td>
      <td style="padding:8px 12px;font-size:13px;color:#666;">${r.note || '—'}</td>
    </tr>`
  ).join('');

  const html = layout('Post Suspended — Admin Review Required 🚩', `
    ${dangerBox(`A client request has been <strong>automatically suspended</strong> after receiving ${reportCount} reports from verified professionals.`)}
    ${infoBox(`<strong>Post Details:</strong><br>
      📋 <strong>Title:</strong> ${postTitle}<br>
      🆔 <strong>Post ID:</strong> ${postId}<br>
      👤 <strong>Client:</strong> ${clientName}<br>
      📧 <strong>Client Email:</strong> ${clientEmail}<br>
      🚩 <strong>Total Reports:</strong> ${reportCount}`)}
    <div style="margin:20px 0;">
      <strong style="font-size:14px;">Report Details:</strong>
      <table width="100%" style="border-collapse:collapse;margin-top:10px;font-size:13px;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:8px 12px;text-align:left;">#</th>
            <th style="padding:8px 12px;text-align:left;">Reason</th>
            <th style="padding:8px 12px;text-align:left;">Note</th>
          </tr>
        </thead>
        <tbody>${reportRows}</tbody>
      </table>
    </div>
    ${para(`The client's account has also been <strong>automatically restricted</strong>. Please review this case in the admin panel.`)}
    ${ctaButton('Review in Admin Panel', 'https://workindex-frontend.vercel.app/admin.html')}
  `);

  const result = await sendViaBrevo({ to: ADMIN_EMAIL, toName: ADMIN_NAME, subject: `🚩 Post Suspended: "${postTitle}" — ${reportCount} reports`, htmlContent: html });
  await logEmail({ to: ADMIN_EMAIL, toName: ADMIN_NAME, subject: `Post suspended: ${postTitle}`, type, category: 'admin', reason: `Post suspended after ${reportCount} reports`, status: result.success ? 'sent' : 'failed', error: result.error || '' });
}

// 14. Admin: User Restricted
async function sendAdminUserRestricted({ userName, userEmail, userRole, reason, warningCount, restrictedBy }) {
  const type = 'admin_user_restricted';
  if (!await isEnabled(type)) return;

  const html = layout('User Account Restricted — FYI 🔒', `
    ${warningBox(`A user account has been <strong>restricted</strong> on WorkIndex.`)}
    ${infoBox(`<strong>User Details:</strong><br>
      👤 <strong>Name:</strong> ${userName}<br>
      📧 <strong>Email:</strong> ${userEmail}<br>
      🏷️ <strong>Role:</strong> ${userRole}<br>
      ⚠️ <strong>Warnings:</strong> ${warningCount}/3<br>
      📝 <strong>Reason:</strong> ${reason || 'Auto-restricted after 3 warnings'}<br>
      🔧 <strong>Restricted By:</strong> ${restrictedBy || 'System (auto)'}`)}
    ${para(`This restriction was applied automatically by the system. The user has been notified by email with steps to raise a support ticket.`)}
    ${para(`If this restriction requires admin review or manual action, please log in to the admin panel.`)}
    ${ctaButton('Open Admin Panel', 'https://workindex-frontend.vercel.app/admin.html')}
  `);

  const result = await sendViaBrevo({ to: ADMIN_EMAIL, toName: ADMIN_NAME, subject: `🔒 User Restricted: ${userName} (${userRole})`, htmlContent: html });
  await logEmail({ to: ADMIN_EMAIL, toName: ADMIN_NAME, subject: `User restricted: ${userName}`, type, category: 'admin', reason: reason || 'Auto-restricted', status: result.success ? 'sent' : 'failed', error: result.error || '' });
}

// 15. Admin: Daily Ticket Digest (called by cron)
async function sendAdminDailyTicketDigest() {
  const type = 'admin_daily_tickets';
  if (!await isEnabled(type)) return;

  try {
    const mongoose = require('mongoose');
    const Ticket = mongoose.models['SupportTicket'];
    if (!Ticket) return;

    // Tickets created today (IST) that are still open/pending
    const now = new Date();
    const ISToffset = 5.5 * 60 * 60 * 1000;
    const todayIST = new Date(now.getTime() + ISToffset);
    todayIST.setHours(0, 0, 0, 0);
    const todayUTC = new Date(todayIST.getTime() - ISToffset);

    const tickets = await Ticket.find({
      createdAt: { $gte: todayUTC },
      status: { $in: ['open', 'pending_review'] }
    }).populate('user', 'name email role').sort({ priority: -1, createdAt: -1 }).lean();

    if (!tickets.length) {
      console.log('📭 No open tickets today — skipping digest email');
      return;
    }

    const priorityColor = { urgent: '#ef4444', high: '#f59e0b', medium: '#3b82f6', low: '#6b7280' };
    const priorityLabel = { urgent: '🚨 Urgent', high: '🔴 High', medium: '🟡 Medium', low: '⚪ Low' };

    const rows = tickets.map((t, i) => {
      const u = t.user || {};
      const pc = priorityColor[t.priority] || '#6b7280';
      const pl = priorityLabel[t.priority] || t.priority;
      const date = new Date(t.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:10px 12px;font-size:13px;">${i + 1}</td>
        <td style="padding:10px 12px;font-size:13px;font-weight:600;">${t.issueType || t.subject || 'Support'}</td>
        <td style="padding:10px 12px;font-size:13px;">${u.name || '—'}<br><span style="color:#999;font-size:11px;">${u.email || ''} · ${u.role || ''}</span></td>
        <td style="padding:10px 12px;font-size:13px;"><span style="color:${pc};font-weight:700;">${pl}</span></td>
        <td style="padding:10px 12px;font-size:12px;color:#666;">${date}</td>
        <td style="padding:10px 12px;font-size:12px;color:#666;">${(t.description || '').substring(0, 60)}${(t.description || '').length > 60 ? '...' : ''}</td>
      </tr>`;
    }).join('');

    const html = layout(`Daily Ticket Digest — ${tickets.length} open ticket${tickets.length !== 1 ? 's' : ''} today`, `
      ${infoBox(`<strong>Date:</strong> ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}<br>
        <strong>Total open/pending tickets today:</strong> ${tickets.length}`)}
      <table width="100%" style="border-collapse:collapse;font-size:13px;margin-top:16px;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:10px 12px;text-align:left;">#</th>
            <th style="padding:10px 12px;text-align:left;">Issue</th>
            <th style="padding:10px 12px;text-align:left;">User</th>
            <th style="padding:10px 12px;text-align:left;">Priority</th>
            <th style="padding:10px 12px;text-align:left;">Time</th>
            <th style="padding:10px 12px;text-align:left;">Description</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${ctaButton('Resolve Tickets in Admin Panel', 'https://workindex-frontend.vercel.app/admin.html')}
    `);

    const result = await sendViaBrevo({ to: ADMIN_EMAIL, toName: ADMIN_NAME, subject: `📋 Daily Ticket Digest — ${tickets.length} open ticket${tickets.length !== 1 ? 's' : ''} (${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })})`, htmlContent: html });
    await logEmail({ to: ADMIN_EMAIL, toName: ADMIN_NAME, subject: `Daily ticket digest: ${tickets.length} tickets`, type, category: 'admin', reason: `Scheduled daily digest — ${tickets.length} tickets`, status: result.success ? 'sent' : 'failed', error: result.error || '' });
    console.log(`📋 Daily ticket digest sent — ${tickets.length} tickets`);
  } catch (err) {
    console.error('❌ Daily ticket digest error:', err.message);
  }
}
// 16. Admin: Ticket Escalated
async function sendAdminTicketEscalated({ userName, userEmail, ticketId, subject, followUpCount }) {
  const type = 'admin_ticket_escalated';
  if (!await isEnabled(type)) return;

  const html = layout(`Ticket Escalated — Follow Up #${followUpCount} ⚠️`, `
    ${dangerBox(`User <strong>${userName}</strong> has sent follow-up #${followUpCount} on their support ticket. This ticket is now <strong>escalated</strong> and requires prompt attention.`)}
    ${infoBox(`<strong>Ticket Details:</strong><br>
      🆔 <strong>Ticket ID:</strong> #${ticketId.slice(-6).toUpperCase()}<br>
      👤 <strong>User:</strong> ${userName}<br>
      📧 <strong>Email:</strong> ${userEmail}<br>
      📋 <strong>Subject:</strong> ${subject}<br>
      🔔 <strong>Follow Up Count:</strong> ${followUpCount}`)}
    ${para(`Please review and respond to this ticket as soon as possible to avoid further escalation.`)}
    ${ctaButton('Open Ticket in Admin Panel', 'https://workindex-frontend.vercel.app/admin.html')}
  `);

  const result = await sendViaBrevo({
    to: ADMIN_EMAIL,
    toName: ADMIN_NAME,
    subject: `⚠️ Escalated Ticket #${ticketId.slice(-6).toUpperCase()} — ${subject} (Follow Up #${followUpCount})`,
    htmlContent: html
  });
  await logEmail({
    to: ADMIN_EMAIL,
    toName: ADMIN_NAME,
    subject: `Ticket escalated: ${subject}`,
    type,
    category: 'admin',
    reason: `User ${userName} sent follow-up #${followUpCount}`,
    status: result.success ? 'sent' : 'failed',
    error: result.error || ''
  });
}

module.exports = {
  sendClientWelcome,
  sendClientPostCreated,
  sendClientExpertApproached,
  sendClientPostSuspended,
  sendClientPostStaleReminder,
  sendClientRestricted,
  sendClientBanned,
  sendExpertWelcome,
  sendExpertCreditsPurchased,
  sendExpertCreditsRefunded,
  sendExpertApproachSubmitted,
  sendExpertNewPost,
  sendExpertInviteReceived,
  sendExpertRestricted,
  sendExpertBanned,
  sendAdminPostSuspended,
  sendAdminUserRestricted,
  sendAdminDailyTicketDigest,
    sendAdminTicketEscalated

};
