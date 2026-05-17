require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════

const configuredFrontendOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (configuredFrontendOrigins.includes(origin)) return callback(null, true);
    if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true
}));

// ⭐ Raw body needed ONLY for Razorpay webhook — must come before express.json
app.use('/api/credits/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

// ⭐ Serve static files (for uploaded images and documents)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'WorkIndex API Server',
    version: '2.0.0',
    endpoints: {
      health: '/health',
      auth: '/api/auth/*',
      users: '/api/users/*',
      requests: '/api/requests/*',
      approaches: '/api/approaches/*',
      credits: '/api/credits/*',
      documents: '/api/documents/*',
      accessRequests: '/api/access-requests/*',
      ratings: '/api/ratings/*'
    }
  });
});

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// Import route files
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const requestRoutes = require('./routes/requests');
const approachRoutes = require('./routes/approaches');
const creditRoutes = require('./routes/credits');
const documentRoutes = require('./routes/documents');
const accessRequestRoutes = require('./routes/accessRequests');
const ratingRoutes = require('./routes/ratings');
require('./models/CommunicationLog');
require('./models/FailedPayment');
require('./models/Notification');
require('./models/SupportTicket');
require('./models/EmailSettings');
require('./models/EmailLog');
require('./models/AuditLog');

// Register routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/approaches', approachRoutes);
app.use('/api/credits', creditRoutes);
app.use('/api/payment', require('./routes/payments'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/documents', documentRoutes);
app.use('/api/access-requests', accessRequestRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/chats', require('./routes/chats'));
const adminRoutes = require('./routes/admin');
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/visits', require('./routes/visits'));
app.use('/api/admin/seo', require('./routes/seo'));
app.use('/api/admin/service-categories', require('./routes/serviceCategories'));
app.use('/api/auth', require('./routes/google-auth'));

// Removed /create-admin route — use MongoDB directly or Manage Admins UI

// ═══════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Route not found',
    path: req.path
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ═══════════════════════════════════════════════════════════
// DATABASE CONNECTION & SERVER START
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log('✅ MongoDB connected successfully');
  console.log(`📊 Database: ${mongoose.connection.name}`);
  require('./utils/databaseIndexes').ensureRatingIndexes()
    .then(() => console.log('✅ Rating indexes verified'))
    .catch(err => console.error('⚠️ Rating index verification failed:', err.message));
  
  app.listen(PORT, () => {
    // ─── CRON: Daily ticket digest at 9:30 PM IST ───
    const cron = require('node-cron');
    const { sendAdminDailyTicketDigest } = require('./utils/notificationEmailService');
    const { processStaleRequests } = require('./utils/requestLifecycle');
    cron.schedule('30 3 * * *', async () => {
      console.log('Running stale request lifecycle cron...');
      const result = await processStaleRequests();
      console.log('Stale request lifecycle result:', result);
    }, { timezone: 'Asia/Kolkata' });
    cron.schedule('0 16 * * *', async () => {
      console.log('⏰ Running daily ticket digest cron...');
      await sendAdminDailyTicketDigest();
    }, { timezone: 'Asia/Kolkata' });
    console.log('✅ Daily ticket digest cron scheduled');
    
    console.log('🚀 ═══════════════════════════════════════════════════');
    console.log(`🚀 WorkIndex Server running on port ${PORT}`);
    console.log(`🚀 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🚀 API URL: http://localhost:${PORT}`);
    console.log('🚀 ═══════════════════════════════════════════════════');
  });
})
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  // Close server & exit process
  process.exit(1);
});
module.exports = app;
