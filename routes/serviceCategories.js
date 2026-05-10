/**
 * routes/serviceCategories.js
 * Mounted at: /api/admin/service-categories
 *
 * Manages service categories + questionnaires.
 * On create/update/delete, regenerates services-config.js
 * and pushes it to GitHub so Vercel auto-deploys.
 *
 * FIX 1: Removed duplicate seed-common / seed-expert route definitions.
 *         The first definitions (which actually create DB records) now win.
 * FIX 2: generateServicesConfig() now reads _common and _expert docs from
 *         the DB instead of using hardcoded fallbacks.
 */

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const path     = require('path');
const Admin    = require('../models/Admin');
const ServiceCategory = require('../models/ServiceCategory');
const PlatformSettings = require('../models/PlatformSettings');
 
// ── Reuse admin protect middleware ──────────────────────────
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
 
// ── GitHub helpers ──────────────────────────────────────────
function githubApiGet(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path, method: 'GET',
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'WorkIndex-Admin',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    const req = require('https').request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data));
        else reject(new Error('GitHub GET ' + res.statusCode + ': ' + data.substring(0, 200)));
      });
    });
    req.on('error', reject);
    req.end();
  });
}
 
function githubApiPut(path, token, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path, method: 'PUT',
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'WorkIndex-Admin',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = require('https').request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201)
          resolve(JSON.parse(data));
        else
          reject(new Error('GitHub PUT ' + res.statusCode + ': ' + data.substring(0, 200)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
 
// ── Convert a stored question to services-config.js format ──
function buildQuestion(q) {
  const typeMap = { radio: 'single', checkbox: 'multi', text: 'text',
                    date: 'date', textarea: 'textarea', select: 'single',
                    address: 'address', slider: 'slider', pincode: 'pincode' };
  const out = {
    id:       q.id,
    key:      q.alias || q.id,
    type:     typeMap[q.type] || q.type,
    required: q.required !== false,
    title:    q.question,
  };
  if (q.subtitle)     out.subtitle = q.subtitle;
  if (q.placeholder)  out.placeholder = q.placeholder;
  if (q.minLength)    out.minLength = q.minLength;
  if (q.maxLength)    out.maxLength = q.maxLength;
  if (q.validation)   out.validation = q.validation;
  // Slider-specific
  if (q.type === 'slider') {
    out.type          = 'slider';
    out.min           = q.sliderMin    || 1000;
    out.max           = q.sliderMax    || 100000;
    out.step          = q.sliderStep   || 500;
    out.format        = q.sliderFormat || '₹{value}';
    out.defaultValue  = q.sliderDefault || 5000;
    delete out.placeholder;
  }
  // Address-specific
  if (q.type === 'address' || q.type === 'address-simple') {
    out.type = q.type;
    out.fields = q.addressFields || {};
    delete out.placeholder;
  }
  // Options for radio/checkbox/select
  if (q.options && q.options.length) {
    out.options = q.options.map(o => ({
      value: o.value, label: o.label,
      ...(o.icon ? { icon: o.icon } : {}),
      ...(o.desc ? { desc: o.desc } : {}),
    }));
  }
  // useServiceList flag (for expert services checkbox)
  if (q.useServiceList) out.useServiceList = true;
  return out;
}
 
// ── Build common section from DB _common doc ─────────────────
// Returns a JSON *string* of the common object (named-key map)
function buildCommonSection(commonCat) {
  if (!commonCat || !(commonCat.questions || []).length) {
    // Hardcoded fallback — only used if _common doc doesn't exist in DB
    return JSON.stringify({
      service_location_type: {
        id:'service_location_type', key:'service_location_type', type:'single', required:true,
        title:'Where do you need the service?',
        options:[
          {value:'online',              label:'Online / Remotely',        icon:'💻', desc:'Share documents digitally'},
          {value:'my-location',         label:'At my location',           icon:'🏠', desc:'Professional comes to me'},
          {value:'professional-office', label:"At professional's office", icon:'🏢', desc:'I visit their office'},
        ],
      },
      full_address: {
        id:'full_address', key:'full_address', type:'address', required:true,
        title:'Enter your address',
        fields:{
          building:{label:'Flat / Building / House No.',placeholder:'e.g. 4B, Sunrise Apartments',required:true},
          area:    {label:'Area / Street / Locality',   placeholder:'e.g. Koramangala 5th Block', required:true},
          pincode: {label:'Pincode',                    placeholder:'e.g. 560095',                required:true, autoFillTrigger:true},
          city:    {label:'City',                       placeholder:'e.g. Bengaluru',             required:true, autoFilled:true},
          state:   {label:'State',                      placeholder:'Select your state',           required:true, type:'select', autoFilled:true},
          landmark:{label:'Landmark (optional)',        placeholder:'e.g. Near Indiranagar metro', required:false},
        },
      },
      client_location: {
        id:'client_location', key:'client_location', type:'address', required:true,
        title:'Where are you based?',
        fields:{
          pincode:{label:'Pincode',placeholder:'e.g. 560095',   required:true, autoFillTrigger:true},
          city:   {label:'City',   placeholder:'e.g. Bengaluru',required:true, autoFilled:true},
          state:  {label:'State',  placeholder:'Select state',   required:true, type:'select', autoFilled:true},
        },
      },
      urgency: {
        id:'urgency', key:'urgency', type:'single', required:true,
        title:'When do you need this done?',
        options:[
          {value:'immediate',label:'Immediately (within 24 hours)',icon:'🔴'},
          {value:'2-3days',  label:'Within 2–3 days',              icon:'🟠'},
          {value:'week',     label:'Within a week',                 icon:'🟡'},
          {value:'month',    label:'Within a month',                icon:'🟢'},
          {value:'flexible', label:'Flexible / No rush',            icon:'🔵'},
        ],
      },
      budget: {
        id:'budget', key:'budget', type:'slider', required:false,
        title:'What is your budget?',
        subtitle:'Professionals will send quotes based on this',
        min:1000, max:100000, step:500, format:'₹{value}', defaultValue:5000,
      },
      description: {
        id:'description', key:'description', type:'textarea', required:true,
        title:'Describe your requirement',
        subtitle:'More detail helps professionals give accurate quotes',
        placeholder:'Please describe what you need in detail...',
        minLength:20, maxLength:1000, validation:'Minimum 20 characters required',
      },
      preferred_professional: {
        id:'preferred_professional', key:'preferred_professional', type:'single', required:false,
        title:'What type of professional do you prefer?',
        options:[
          {value:'individual_ca',label:'Individual CA / Freelancer',icon:'👤',desc:'Personal attention, often more affordable'},
          {value:'firm',         label:'CA Firm / Agency',          icon:'🏢',desc:'Team support, established firm'},
          {value:'no_preference',label:'No preference',             icon:'🤷',desc:'Best quote wins'},
        ],
      },
      contact_method: {
        id:'contact_method', key:'contact_method', type:'single', required:true,
        title:'How should professionals contact you?',
        options:[
          {value:'platform_chat',label:'Chat on WorkIndex',    icon:'💬',desc:'Professionals message you here'},
          {value:'phone',        label:'Phone call / WhatsApp',icon:'📞',desc:'They call or WhatsApp you directly'},
          {value:'email',        label:'Email',                 icon:'✉️',desc:'They email you'},
          {value:'any',          label:'Any method is fine',    icon:'✅'},
        ],
      },
    }, null, 4);
  }
 
  // FIX 2: Build from DB _common document questions
  const obj = {};
  (commonCat.questions || []).forEach(q => {
    const built = buildQuestion(q);
    // Always use the question's id as the key (snake_case) so frontend can find it
    // Hardcode correct addressFields based on ID — never trust what admin saves for address types
    if (q.id === 'full_address') {
      built.type = 'address';
      built.fields = {
        building: { label: 'Flat / Building / House No.', placeholder: 'e.g. 4B, Sunrise Apartments', required: true },
        area:     { label: 'Area / Locality',             placeholder: 'e.g. Koramangala 5th Block',  required: true },
        pincode:  { label: 'Pincode',                     placeholder: 'e.g. 560095',                 required: true, autoFillTrigger: true },
        city:     { label: 'City',                        placeholder: 'e.g. Bengaluru',              required: true, autoFilled: true },
        state:    { label: 'State',                       placeholder: 'Select your state',            required: true, type: 'select', autoFilled: true },
        landmark: { label: 'Landmark (optional)',         placeholder: 'e.g. Near Indiranagar metro',  required: false }
      };
    } else if (q.id === 'client_location') {
      built.type = 'address';
      built.key  = 'client_location';
      built.fields = {
        pincode: { label: 'Pincode', placeholder: 'e.g. 560095',    required: true, autoFillTrigger: true },
        city:    { label: 'City',    placeholder: 'e.g. Bengaluru', required: true, autoFilled: true },
        state:   { label: 'State',   placeholder: 'Select state',    required: true, type: 'select', autoFilled: true }
      };
    }
    obj[q.id] = built;
  });
  return JSON.stringify(obj, null, 4);
}
 
// ── Build expert section from DB _expert doc ─────────────────

// Returns a JSON *string* of an array
function buildExpertSection(expertCat) {
  if (!expertCat || !(expertCat.questions || []).length) {
    // Hardcoded fallback — only used if _expert doc doesn't exist in DB
    return JSON.stringify([
      { id:'expert_services', key:'servicesOffered', type:'multi', required:true,
        title:'What services do you offer?', subtitle:'Select all that apply', useServiceList:true },
      { id:'expert_specialization', key:'specialization', type:'single', required:true,
        title:'What is your primary specialization?',
        options:[
          {value:'Chartered Accountant',label:'Chartered Accountant (CA)',icon:'🎓'},
          {value:'Cost Accountant',     label:'Cost Accountant (CMA)',    icon:'🎓'},
          {value:'Company Secretary',   label:'Company Secretary (CS)',   icon:'🎓'},
          {value:'Tax Consultant',      label:'Tax Consultant',           icon:'📄'},
          {value:'GST Consultant',      label:'GST Consultant',           icon:'🧾'},
          {value:'Bookkeeper',          label:'Bookkeeper / Accountant',  icon:'📊'},
          {value:'Photographer',        label:'Photographer',             icon:'📷'},
          {value:'Web Developer',       label:'Web / App Developer',      icon:'💻'},
          {value:'Other',               label:'Other Professional',        icon:'🔧'},
        ]},
      { id:'expert_experience', key:'yearsOfExperience', type:'single', required:true,
        title:'How many years of experience do you have?',
        options:[
          {value:'0-1', label:'Less than 1 year',  icon:'🌱'},
          {value:'1-3', label:'1 – 3 years',       icon:'📈'},
          {value:'3-5', label:'3 – 5 years',       icon:'📈'},
          {value:'5-10',label:'5 – 10 years',      icon:'⭐'},
          {value:'10+', label:'More than 10 years',icon:'🏆'},
        ]},
      { id:'expert_location', key:'serviceLocationType', type:'single', required:true,
        title:'Where do you prefer to work?',
        options:[
          {value:'online',label:'Online / Remotely only',     icon:'💻',desc:'Work with clients anywhere in India'},
          {value:'local', label:'Local (in-person preferred)',icon:'📍',desc:'Prefer meeting clients face to face'},
          {value:'both',  label:'Both online and in-person', icon:'🌐',desc:'Flexible depending on the client'},
        ]},
      { id:'expert_location_details', key:'expert_location_details', type:'address', required:true,
        title:'Where are you based?', subtitle:'Enter your pincode — city and state will be filled automatically',
        fields:{
          pincode:{ label:'Pincode', placeholder:'e.g. 560095', required:true, autoFillTrigger:true },
          city:   { label:'City',    placeholder:'e.g. Bengaluru', required:true, autoFilled:true },
          state:  { label:'State',   placeholder:'Select state', required:true, type:'select', autoFilled:true },
        }
      },
      { id:'expert_bio',     key:'bio',     type:'textarea',required:true,  title:'Tell clients about yourself',    subtitle:'Your bio appears on your public profile', placeholder:'e.g. I am a Chartered Accountant with 8 years of experience...', minLength:50, maxLength:500, validation:'Minimum 50 characters required' },
    ], null, 4);
  }
 
  // FIX 2: Build from DB _expert document questions
return JSON.stringify(
  (expertCat.questions || []).map(q => {
    const built = buildQuestion(q);
    // Hardcode addressFields for expert_location_details
    // (same as buildCommonSection does for full_address / client_location)
    if (q.id === 'expert_location_details') {
      built.type   = 'address';
      built.fields = {
        pincode: { label: 'Pincode', placeholder: 'e.g. 560095',    required: true, autoFillTrigger: true },
        city:    { label: 'City',    placeholder: 'e.g. Bengaluru', required: true, autoFilled: true },
        state:   { label: 'State',   placeholder: 'Select state',    required: true, type: 'select', autoFilled: true }
      };
    }
    return built;
  }),
  null, 4
);
}
 
// ── Generate services-config.js content from DB ────────────
// FIX 2: Accepts all categories including _common and _expert
function generateServicesConfig(categories) {
  // Separate special docs from service categories
  const commonCat  = categories.find(c => c.value === '_common');
  const expertCat  = categories.find(c => c.value === '_expert');
  const serviceCategories = categories.filter(c => !c.value.startsWith('_'));
 
  // Build the list, labels, colors, icons (service categories only)
  const list = serviceCategories.map(c => ({
    value: c.value,
    label: c.label,
    icon:  c.icon,
    color: c.color
  }));
 
  // Build search aliases merged from all service categories
  const allAliases = {};
  serviceCategories.forEach(c => {
    (c.searchAliases || '').split(',').forEach(alias => {
      const a = alias.trim().toLowerCase();
      if (a) allAliases[a] = c.value;
    });
    allAliases[c.value] = c.value;
    allAliases[c.label.toLowerCase()] = c.value;
  });
 
  // Build creditCost and maxApproaches maps
  const creditCost = {}, maxApproaches = {};
  serviceCategories.forEach(c => {
    creditCost[c.value]    = c.creditCost    || 20;
    maxApproaches[c.value] = c.maxApproaches || 5;
  });
 
  // Build byService questionnaire from DB service categories
  const byService = {};
  serviceCategories.forEach(c => {
    byService[c.value] = (c.questions || []).map(q => buildQuestion(q));
  });
 
  // Build answerTagFormatters
  const formatterLines = [];
  serviceCategories.forEach(c => {
    (c.questions || []).forEach(q => {
      let fmt = null;
      if (q.id.includes('Income') || q.id.includes('Turnover'))
        fmt = `function(v){ return v.replace('above','> ').replace('below','< '); }`;
      else if (q.type === 'checkbox')
        fmt = `function(v){ return Array.isArray(v) ? v.join(', ') : v; }`;
      else if (q.id.includes('Type') || q.id.includes('taxpayer'))
        fmt = `function(v){ return v.charAt(0).toUpperCase() + v.slice(1); }`;
      else if (q.id.includes('Frequency') || q.id.includes('Duration') || q.id.includes('Timeline'))
        fmt = `function(v){ return v.replace(/-/g,' '); }`;
      else if (q.id.includes('audit'))
        fmt = `function(v){ return v.replace(/_/g,' ') + ' audit'; }`;
      else if (q.id.includes('Transactions'))
        fmt = `function(v){ return v + ' txns/mo'; }`;
      if (fmt) formatterLines.push(`    ${q.id}: ${fmt}`);
    });
  });
 
  // FIX 2: Build common and expert sections from DB
  const commonJson = buildCommonSection(commonCat);
  const expertJson = buildExpertSection(expertCat);
 
  const listJson = JSON.stringify(list, null, 4);
 
  return `/**
 * WorkIndex — Service Category & Questionnaire Configuration
 * ============================================================
 * AUTO-GENERATED by WorkIndex Admin CMS.
 * DO NOT edit manually — use the admin panel to modify.
 * Generated: ${new Date().toISOString()}
 */
 
const WI_SERVICES = {
 
  // ─── Master list of all service categories ──────────────
  list: ${listJson},
 
  // ─── Quick lookup maps (auto-generated from list) ───────
  get labels() {
    const m = {};
    this.list.forEach(s => m[s.value] = s.label);
    return m;
  },
  get colors() {
    const m = {};
    this.list.forEach(s => m[s.value] = s.color);
    return m;
  },
  get icons() {
    const m = {};
    this.list.forEach(s => m[s.value] = s.icon);
    return m;
  },
 
  // ─── Landing page search aliases ────────────────────────
  searchAliases: ${JSON.stringify(allAliases, null, 4)},
 
  // ─── Credit cost per service ─────────────────────────────
  creditCost: ${JSON.stringify(creditCost, null, 4)},
 
  // ─── Max approaches per request ──────────────────────────
  maxApproaches: ${JSON.stringify(maxApproaches, null, 4)},
 
  // ─── Questionnaire (nested structure) ────────────────────
  questionnaire: {
 
    serviceSelection: {
      id: 'service', key: 'service',
      type: 'service-picker',
      title: 'What service do you need?',
      subtitle: 'Select the category that best matches your requirement',
      required: true,
      useServiceList: true,
    },
 
    byService: ${JSON.stringify(byService, null, 6)},
 
    common: ${commonJson},
 
    expert: ${expertJson},
 
  },
 
  // ─── Answer tag formatters (for browse cards) ────────────
  answerTagFormatters: {
${formatterLines.join(',\n')}
  },
 
};
 
Object.freeze(WI_SERVICES);
`;
}
 
// ── Push services-config.js to GitHub ──────────────────────
async function pushServicesConfig(content) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = 'ravishhegde7/WorkIndex';
  const FILE_PATH    = 'services-config.js';
 
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set in Railway env vars');
 
  let sha = null;
  try {
    const existing = await githubApiGet(
      '/repos/' + GITHUB_REPO + '/contents/' + FILE_PATH,
      GITHUB_TOKEN
    );
    sha = existing.sha;
  } catch(e) { /* file doesn't exist yet */ }
 
  const body = JSON.stringify({
    message: 'Update services-config.js via Admin CMS',
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {})
  });
 
  return githubApiPut(
    '/repos/' + GITHUB_REPO + '/contents/' + FILE_PATH,
    GITHUB_TOKEN,
    body
  );
}
 
// ── Regenerate and push config ──────────────────────────────
async function syncToGitHub() {
  const categories = await ServiceCategory.find({}).sort({ sortOrder: 1, createdAt: 1 });
  const content = generateServicesConfig(categories);
  const localFrontendConfig = path.resolve(__dirname, '../../workindex-frontend/services-config.js');
  if (fs.existsSync(localFrontendConfig)) {
    fs.writeFileSync(localFrontendConfig, content, 'utf8');
  }
  await pushServicesConfig(content);
  return content;
}
 
// ===========================================================
// ROUTES
// ===========================================================
 
// GET all categories
router.get('/', protect, async (req, res) => {
  try {
    const categories = await ServiceCategory.find({}).sort({ sortOrder: 1, createdAt: 1 });
    res.json({ success: true, categories, total: categories.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
// PREVIEW generated config (without pushing to GitHub)
// NOTE: Must be before /:id to avoid route conflict
router.get('/preview/config', protect, async (req, res) => {
  try {
    const categories = await ServiceCategory.find({}).sort({ sortOrder: 1 });
    const content = generateServicesConfig(categories);
    res.json({ success: true, content });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET marketplace credit settings for the service category admin tab.
router.get('/settings/platform', protect, async (req, res) => {
  try {
    let settings = await PlatformSettings.findOne({ singleton: true });
    if (!settings) settings = await PlatformSettings.create({ singleton: true });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPDATE credit packs and default post credits used by request fallback pricing.
router.put('/settings/platform', protect, superOnly, async (req, res) => {
  try {
    const updates = {};
    if (req.body.defaultPostCredits !== undefined) {
      const defaultPostCredits = parseInt(req.body.defaultPostCredits, 10);
      if (!defaultPostCredits || defaultPostCredits < 1) {
        return res.status(400).json({ success: false, message: 'Default post credits must be at least 1' });
      }
      updates.defaultPostCredits = defaultPostCredits;
    }
    if (Array.isArray(req.body.creditPacks)) {
      updates.creditPacks = req.body.creditPacks
        .map(p => ({
          id: String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
          label: String(p.label || p.id || '').trim(),
          credits: parseInt(p.credits, 10) || 0,
          price: parseInt(p.price, 10) || 0,
          active: p.active !== false
        }))
        .filter(p => p.id && p.label && p.credits > 0 && p.price > 0);
      if (!updates.creditPacks.length) {
        return res.status(400).json({ success: false, message: 'At least one valid credit pack is required' });
      }
    }

    const settings = await PlatformSettings.findOneAndUpdate(
      { singleton: true },
      { $set: updates },
      { new: true, upsert: true, runValidators: true }
    );
    res.json({ success: true, message: 'Platform credit settings updated', settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
// FORCE PUSH current DB state to GitHub
// NOTE: Must be before /:id to avoid route conflict
router.post('/sync', protect, superOnly, async (req, res) => {
  try {
    await syncToGitHub();
    res.json({ success: true, message: 'services-config.js pushed to GitHub. Vercel deploys in ~60s.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'GitHub push failed: ' + err.message });
  }
});
 
// SEED default service categories
// NOTE: Must be before /:id to avoid route conflict
router.post('/seed', protect, superOnly, async (req, res) => {
  try {
    const existing = await ServiceCategory.countDocuments({ value: { $not: /^_/ } });
    if (existing > 0) {
      return res.status(400).json({
        success: false,
        message: existing + ' service categories already exist. Delete them first or use PUT to update.'
      });
    }
 
    const defaults = [
      {
        value: 'itr', label: 'ITR Filing', icon: '📄', color: '#8b5cf6',
        creditCost: 20, maxApproaches: 5, sortOrder: 1,
        searchAliases: 'itr filing,income tax,tax',
        questions: [
          { id: 'itrTaxpayerType', question: 'What is your taxpayer type?', type: 'radio', required: true, options: [
            { value: 'salaried',   label: '💼 Salaried Employee' },
            { value: 'business',   label: '🏢 Business Owner / Self-Employed' },
            { value: 'freelancer', label: '💻 Freelancer / Consultant' },
            { value: 'nri',        label: '🌍 NRI (Non-Resident Indian)' }
          ]},
          { id: 'itrAnnualIncome', question: 'What is your approximate annual income?', type: 'radio', required: true, options: [
            { value: 'below5L',  label: 'Below ₹5 Lakhs' },
            { value: '5L-10L',   label: '₹5 – ₹10 Lakhs' },
            { value: '10L-20L',  label: '₹10 – ₹20 Lakhs' },
            { value: '20L-50L',  label: '₹20 – ₹50 Lakhs' },
            { value: 'above50L', label: 'Above ₹50 Lakhs' }
          ]},
          { id: 'itrIncomeSources', question: 'Sources of income', type: 'checkbox', required: true, subtitle: 'Select all that apply', options: [
            { value: 'salary',   label: 'Salary' },
            { value: 'business', label: 'Business income' },
            { value: 'rental',   label: 'Rental income' },
            { value: 'capital',  label: 'Capital gains' },
            { value: 'foreign',  label: 'Foreign income' },
            { value: 'interest', label: 'Interest income' },
            { value: 'other',    label: 'Other' }
          ]},
          { id: 'itrFilingType', question: 'Filing requirement', type: 'radio', required: true, subtitle: 'What type of return do you need?', options: [
            { value: 'current',  label: 'Current year return' },
            { value: 'previous', label: 'Previous year return' },
            { value: 'revised',  label: 'Revised return' },
            { value: 'notice',   label: 'Tax notice handling' }
          ]},
          { id: 'itrTaxPlanning', question: 'Need tax planning advice?', type: 'radio', required: true, options: [
            { value: 'yes', label: '✅ Yes, I need tax planning advice' },
            { value: 'no',  label: '❌ No, just file my return' }
          ]}
        ]
      },
      {
        value: 'gst', label: 'GST Services', icon: '🧾', color: '#3b82f6',
        creditCost: 20, maxApproaches: 5, sortOrder: 2,
        searchAliases: 'gst,gst services',
        questions: [
          { id: 'gstServiceType', question: 'What GST service do you need?', type: 'radio', required: true, options: [
            { value: 'new_registration',   label: '📋 New GST Registration' },
            { value: 'monthly_filing',     label: '📊 Monthly GSTR Filing' },
            { value: 'annual_return',      label: '📁 Annual GST Return (GSTR-9)' },
            { value: 'notice_handling',    label: '⚠️ GST Notice / Scrutiny' },
            { value: 'itc_reconciliation', label: '🔁 ITC Reconciliation' }
          ]},
          { id: 'gstBusinessType', question: 'Business type', type: 'radio', required: true, subtitle: 'Select your business structure', options: [
            { value: 'proprietorship', label: 'Proprietorship' },
            { value: 'partnership',    label: 'Partnership' },
            { value: 'llp',            label: 'LLP' },
            { value: 'pvt_ltd',        label: 'Private Limited Company' },
            { value: 'opc',            label: 'OPC (One Person Company)' },
            { value: 'other',          label: 'Other' }
          ]},
          { id: 'gstTurnover', question: 'What is your monthly business turnover?', type: 'radio', required: true, options: [
            { value: 'below5L',  label: 'Below ₹5 Lakhs' },
            { value: '5L-20L',   label: '₹5 – ₹20 Lakhs' },
            { value: '20L-50L',  label: '₹20 – ₹50 Lakhs' },
            { value: 'above50L', label: 'Above ₹50 Lakhs' }
          ]},
          { id: 'gstExisting', question: 'Do you already have a GSTIN?', type: 'radio', required: true, options: [
            { value: 'yes', label: '✅ Yes, I have GSTIN' },
            { value: 'no',  label: '❌ No, need new registration' }
          ]}
        ]
      },
      {
        value: 'accounting', label: 'Accounting', icon: '📊', color: '#10b981',
        creditCost: 20, maxApproaches: 5, sortOrder: 3,
        searchAliases: 'accounting,bookkeeping',
        questions: [
          { id: 'accountingBusinessType', question: 'Business type', type: 'radio', required: true, subtitle: 'Select your business structure', options: [
            { value: 'proprietorship', label: 'Proprietorship' },
            { value: 'partnership',    label: 'Partnership' },
            { value: 'llp',            label: 'LLP' },
            { value: 'pvt_ltd',        label: 'Private Limited Company' },
            { value: 'opc',            label: 'OPC' },
            { value: 'other',          label: 'Other' }
          ]},
          { id: 'accountingServiceType', question: 'What accounting service do you need?', type: 'radio', required: true, options: [
            { value: 'bookkeeping',     label: '📚 Monthly Bookkeeping' },
            { value: 'payroll',         label: '👥 Payroll Processing' },
            { value: 'annual_accounts', label: '📋 Annual Accounts Preparation' },
            { value: 'tds_filing',      label: '📄 TDS Filing' }
          ]},
          { id: 'accountingFrequency', question: 'How often do you need accounting support?', type: 'radio', required: true, options: [
            { value: 'monthly',   label: '📅 Monthly (ongoing)' },
            { value: 'quarterly', label: '🗓️ Quarterly' },
            { value: 'annual',    label: '📆 One-time / Annual' }
          ]},
          { id: 'accountingSoftware', question: 'Accounting software used', type: 'radio', required: true, subtitle: 'Which software do you currently use?', options: [
            { value: 'tally',      label: 'Tally' },
            { value: 'zoho',       label: 'Zoho Books' },
            { value: 'quickbooks', label: 'QuickBooks' },
            { value: 'busy',       label: 'Busy' },
            { value: 'none',       label: 'None / Manual' },
            { value: 'other',      label: 'Other' }
          ]},
          { id: 'accountingTransactions', question: 'How many transactions per month approximately?', type: 'radio', required: true, options: [
            { value: 'below50',  label: 'Below 50' },
            { value: '50-200',   label: '50 – 200' },
            { value: '200-500',  label: '200 – 500' },
            { value: 'above500', label: 'Above 500' }
          ]}
        ]
      },
      {
        value: 'audit', label: 'Audit', icon: '🔍', color: '#f59e0b',
        creditCost: 20, maxApproaches: 5, sortOrder: 4,
        searchAliases: 'audit,statutory audit',
        questions: [
          { id: 'auditType', question: 'What type of audit do you need?', type: 'radio', required: true, options: [
            { value: 'statutory_audit', label: '📋 Statutory Audit' },
            { value: 'tax_audit',       label: '📄 Tax Audit (Section 44AB)' },
            { value: 'internal_audit',  label: '🔍 Internal Audit' },
            { value: 'gst_audit',       label: '🧾 GST Audit' }
          ]},
          { id: 'auditOrgType', question: 'Organization type', type: 'radio', required: true, subtitle: 'Select your business structure', options: [
            { value: 'proprietorship', label: 'Proprietorship' },
            { value: 'partnership',    label: 'Partnership' },
            { value: 'llp',            label: 'LLP' },
            { value: 'pvt_ltd',        label: 'Private Limited Company' },
            { value: 'public',         label: 'Public Limited Company' },
            { value: 'other',          label: 'Other' }
          ]},
          { id: 'auditTurnover', question: 'What is your annual business turnover?', type: 'radio', required: true, options: [
            { value: 'below1Cr',  label: 'Below ₹1 Crore' },
            { value: '1Cr-5Cr',   label: '₹1 – ₹5 Crore' },
            { value: '5Cr-20Cr',  label: '₹5 – ₹20 Crore' },
            { value: 'above20Cr', label: 'Above ₹20 Crore' }
          ]},
          { id: 'auditDeadline', question: 'Audit deadline', type: 'date', required: true, subtitle: 'When do you need the audit completed?' }
        ]
      },
      {
        value: 'photography', label: 'Photography', icon: '📷', color: '#ec4899',
        creditCost: 10, maxApproaches: 5, sortOrder: 5,
        searchAliases: 'photography,photo,photographer',
        questions: [
          { id: 'photographyType', question: 'What type of photography do you need?', type: 'radio', required: true, options: [
            { value: 'wedding',     label: '💍 Wedding Photography' },
            { value: 'portrait',    label: '🤳 Portrait / Headshots' },
            { value: 'product',     label: '📦 Product / E-Commerce' },
            { value: 'corporate',   label: '🏢 Corporate / Event' },
            { value: 'real_estate', label: '🏠 Real Estate / Architecture' }
          ]},
          { id: 'photographyEventDate', question: 'Event / shoot date', type: 'date', required: true, subtitle: 'When is your event or photoshoot?' },
          { id: 'photographyDuration', question: 'How long is the shoot?', type: 'radio', required: true, options: [
            { value: 'few-hours', label: 'Few hours' },
            { value: 'half-day',  label: 'Half day (3–5 hours)' },
            { value: 'full-day',  label: 'Full day' },
            { value: 'multiple',  label: 'Multiple days' }
          ]},
          { id: 'photographyVideography', question: 'Need videography also?', type: 'radio', required: true, options: [
            { value: 'yes', label: '🎥 Yes, include videography' },
            { value: 'no',  label: '📷 No, photography only' }
          ]}
        ]
      },
      {
        value: 'development', label: 'Development', icon: '💻', color: '#06b6d4',
        creditCost: 15, maxApproaches: 5, sortOrder: 6,
        searchAliases: 'development,dev,web,website,app',
        questions: [
          { id: 'devProjectType', question: 'What type of project do you need?', type: 'radio', required: true, options: [
            { value: 'website',     label: '🌐 Website (informational)' },
            { value: 'ecommerce',   label: '🛒 E-Commerce Store' },
            { value: 'webapp',      label: '💻 Web Application / SaaS' },
            { value: 'mobile-app',  label: '📱 Mobile App (Android / iOS)' },
            { value: 'api',         label: '🔌 API / Backend Development' },
            { value: 'redesign',    label: '🎨 Website Redesign / Revamp' },
            { value: 'maintenance', label: '🔧 Maintenance / Bug Fix' }
          ]},
          { id: 'devProjectStage', question: 'Project stage', type: 'radio', required: true, subtitle: 'What stage is your project at?', options: [
            { value: 'idea',         label: 'Idea stage' },
            { value: 'requirements', label: 'Requirements defined' },
            { value: 'design-ready', label: 'Design ready' },
            { value: 'partial',      label: 'Partially developed' },
            { value: 'upgrade',      label: 'Existing system upgrade' }
          ]},
          { id: 'devPlatform', question: 'Platform needed', type: 'checkbox', required: true, subtitle: 'Which platforms should it support?', options: [
            { value: 'android',        label: 'Android' },
            { value: 'ios',            label: 'iOS' },
            { value: 'web',            label: 'Web' },
            { value: 'cross-platform', label: 'Cross-platform' },
            { value: 'not-sure',       label: 'Not sure yet' }
          ]},
          { id: 'devTimeline', question: 'What is your project timeline?', type: 'radio', required: true, options: [
            { value: 'asap',      label: '🔴 ASAP (within 1 week)' },
            { value: '1-2months', label: '🟠 1–2 months' },
            { value: '3-6months', label: '🟡 3–6 months' },
            { value: 'flexible',  label: '🔵 Flexible' }
          ]},
          { id: 'devMaintenance', question: 'Need ongoing maintenance?', type: 'radio', required: true, options: [
            { value: 'yes', label: '✅ Yes, need maintenance support' },
            { value: 'no',  label: '❌ No, just build and handover' }
          ]}
        ]
      }
    ];
 
    const created = await ServiceCategory.insertMany(defaults);
    res.json({ success: true, message: 'Seeded ' + created.length + ' default categories', count: created.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
// ══════════════════════════════════════════════════════════════
// FIX 1: SEED COMMON STEPS — single route definition only.
// Mirrors the same pattern as /seed above: check if exists,
// create the DB record, then sync to GitHub.
// ══════════════════════════════════════════════════════════════
router.post('/seed-common', protect, superOnly, async (req, res) => {
  try {
    const existing = await ServiceCategory.findOne({ value: '_common' });
    if (existing) {
      return res.json({
        success: false,
        message: 'Common steps already exist. Use the Edit button to modify them.'
      });
    }
 
    const commonSteps = await ServiceCategory.create({
      value: '_common', label: 'Common Steps', icon: '🔗', color: '#6366f1',
      creditCost: 1, maxApproaches: 1, sortOrder: 100, isActive: true,
      questions: [
        {
          id: 'service_location_type', question: 'Where do you need the service?', type: 'radio', required: true,
          subtitle: 'Choose how you prefer to work with the professional',
          options: [
            { value: 'online',              label: 'Online / Remotely',        icon: '💻', desc: 'Share documents digitally, work via chat/call' },
            { value: 'my-location',         label: 'At my location',           icon: '🏠', desc: 'Professional comes to me' },
            { value: 'professional-office', label: "At professional's office", icon: '🏢', desc: 'I visit their office' },
          ]
        },
        {
          id: 'full_address', question: 'Enter your address', type: 'address', required: true,
          subtitle: 'So we can find professionals near you',
          addressFields: {
            building: { label: 'Flat / Building / House No.', placeholder: 'e.g. 4B, Sunrise Apartments', required: true },
            area:     { label: 'Area / Street / Locality',    placeholder: 'e.g. Koramangala 5th Block',  required: true },
            pincode:  { label: 'Pincode',                     placeholder: 'e.g. 560095',                 required: true, autoFillTrigger: true },
            city:     { label: 'City',                        placeholder: 'e.g. Bengaluru',              required: true, autoFilled: true },
            state:    { label: 'State',                       placeholder: 'Select your state',            required: true, type: 'select', autoFilled: true },
            landmark: { label: 'Landmark (optional)',         placeholder: 'e.g. Near Indiranagar metro',  required: false },
          }
        },
        {
          id: 'client_location', question: 'Where are you based?', type: 'address', required: true,
          subtitle: 'Helps match you with professionals in your region',
          addressFields: {
            pincode: { label: 'Pincode', placeholder: 'e.g. 560095',    required: true, autoFillTrigger: true },
            city:    { label: 'City',    placeholder: 'e.g. Bengaluru', required: true, autoFilled: true },
            state:   { label: 'State',   placeholder: 'Select state',    required: true, type: 'select', autoFilled: true },
          }
        },
        {
          id: 'urgency', question: 'When do you need this done?', type: 'radio', required: true,
          options: [
            { value: 'immediate', label: 'Immediately (within 24 hours)', icon: '🔴' },
            { value: '2-3days',   label: 'Within 2–3 days',               icon: '🟠' },
            { value: 'week',      label: 'Within a week',                  icon: '🟡' },
            { value: 'month',     label: 'Within a month',                 icon: '🟢' },
            { value: 'flexible',  label: 'Flexible / No rush',             icon: '🔵' },
          ]
        },
        {
          id: 'budget', question: 'What is your budget?', type: 'slider', required: false,
          subtitle: 'Professionals will send quotes based on this',
          sliderMin: 1000, sliderMax: 100000, sliderStep: 500,
          sliderFormat: '₹{value}', sliderDefault: 5000
        },
        {
          id: 'description', question: 'Describe your requirement', type: 'textarea', required: true,
          subtitle: 'More detail helps professionals give you accurate quotes',
          placeholder: 'Please describe what you need in detail...',
          minLength: 20, maxLength: 1000, validation: 'Minimum 20 characters required'
        },
        {
          id: 'preferred_professional', question: 'What type of professional do you prefer?', type: 'radio', required: false,
          options: [
            { value: 'individual_ca', label: 'Individual CA / Freelancer', icon: '👤', desc: 'Personal attention, often more affordable' },
            { value: 'firm',          label: 'CA Firm / Agency',           icon: '🏢', desc: 'Team support, established firm' },
            { value: 'no_preference', label: 'No preference',              icon: '🤷', desc: 'Best quote wins' },
          ]
        },
        {
          id: 'contact_method', question: 'How should professionals contact you?', type: 'radio', required: true,
          options: [
            { value: 'platform_chat', label: 'Chat on WorkIndex',     icon: '💬', desc: 'Professionals message you here' },
            { value: 'phone',         label: 'Phone call / WhatsApp', icon: '📞', desc: 'They call or WhatsApp you directly' },
            { value: 'email',         label: 'Email',                  icon: '✉️', desc: 'They email you' },
            { value: 'any',           label: 'Any method is fine',     icon: '✅' },
          ]
        },
      ]
    });
 
    // Push updated config to GitHub (same pattern as /seed)
    let githubPushed = false;
    try {
      await syncToGitHub();
      githubPushed = true;
    } catch(e) {
      console.error('GitHub push failed (non-fatal):', e.message);
    }
 
    res.json({
      success: true,
      message: 'Common steps seeded into DB' + (githubPushed ? ' and services-config.js pushed to GitHub (Vercel deploys in ~60s)' : ' — GitHub push failed, check GITHUB_TOKEN'),
      category: commonSteps,
      githubPushed
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
// ══════════════════════════════════════════════════════════════
// FIX 1: SEED EXPERT STEPS — single route definition only.
// ══════════════════════════════════════════════════════════════
// RESET expert steps — deletes existing and re-seeds with correct order
router.post('/reset-expert', protect, superOnly, async (req, res) => {
  try {
    await ServiceCategory.deleteOne({ value: '_expert' });
    res.json({ success: true, message: 'Expert steps deleted. Now click Seed Expert Steps to re-seed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/seed-expert', protect, superOnly, async (req, res) => {
  try {
    const existing = await ServiceCategory.findOne({ value: '_expert' });
    if (existing) {
      return res.json({
        success: false,
        message: 'Expert steps already exist. Use the Edit button to modify them.'
      });
    }
 
    const expertSteps = await ServiceCategory.create({
      value: '_expert', label: 'Expert Onboarding Steps', icon: '⭐', color: '#f59e0b',
      creditCost: 1, maxApproaches: 1, sortOrder: 101, isActive: true,
      questions: [
        {
          id: 'expert_services', question: 'What services do you offer?', type: 'checkbox', required: true,
          subtitle: 'Select all that apply', useServiceList: true, options: []
        },
        {
          id: 'expert_specialization', question: 'What is your primary specialization?', type: 'radio', required: true,
          options: [
            { value: 'Chartered Accountant', label: 'Chartered Accountant (CA)', icon: '🎓' },
            { value: 'Cost Accountant',      label: 'Cost Accountant (CMA)',      icon: '🎓' },
            { value: 'Company Secretary',    label: 'Company Secretary (CS)',     icon: '🎓' },
            { value: 'Tax Consultant',       label: 'Tax Consultant',             icon: '📄' },
            { value: 'GST Consultant',       label: 'GST Consultant',             icon: '🧾' },
            { value: 'Bookkeeper',           label: 'Bookkeeper / Accountant',   icon: '📊' },
            { value: 'Photographer',         label: 'Photographer',              icon: '📷' },
            { value: 'Web Developer',        label: 'Web / App Developer',       icon: '💻' },
            { value: 'Other',                label: 'Other Professional',         icon: '🔧' },
          ]
        },
        {
          id: 'expert_experience', question: 'How many years of experience do you have?', type: 'radio', required: true,
          options: [
            { value: '0-1',  label: 'Less than 1 year',   icon: '🌱' },
            { value: '1-3',  label: '1 – 3 years',        icon: '📈' },
            { value: '3-5',  label: '3 – 5 years',        icon: '📈' },
            { value: '5-10', label: '5 – 10 years',       icon: '⭐' },
            { value: '10+',  label: 'More than 10 years', icon: '🏆' },
          ]
        },
        {
          id: 'expert_location', question: 'Where do you prefer to work?', type: 'radio', required: true,
          options: [
            { value: 'online', label: 'Online / Remotely only',     icon: '💻', desc: 'Work with clients anywhere in India' },
            { value: 'local',  label: 'Local (in-person preferred)', icon: '📍', desc: 'Prefer meeting clients face to face' },
            { value: 'both',   label: 'Both online and in-person',  icon: '🌐', desc: 'Flexible depending on the client' },
          ]
        },
        {
          id: 'expert_location_details', question: 'Where are you based?', type: 'address', required: true,
          subtitle: 'Enter your pincode — city and state will be filled automatically',
          addressFields: {
            pincode: { label: 'Pincode', placeholder: 'e.g. 560095',    required: true, autoFillTrigger: true },
            city:    { label: 'City',    placeholder: 'e.g. Bengaluru', required: true, autoFilled: true },
            state:   { label: 'State',   placeholder: 'Select state',    required: true, type: 'select', autoFilled: true },
          }
        },
        {
          id: 'expert_bio', question: 'Tell clients about yourself', type: 'textarea', required: true,
          subtitle: 'Your bio appears on your public profile',
          placeholder: 'e.g. I am a Chartered Accountant with 8 years of experience...',
          minLength: 50, maxLength: 500, validation: 'Minimum 50 characters required'
        },
      ]
    });
 
    // Push updated config to GitHub (same pattern as /seed)
    let githubPushed = false;
    try {
      await syncToGitHub();
      githubPushed = true;
    } catch(e) {
      console.error('GitHub push failed (non-fatal):', e.message);
    }
 
    res.json({
      success: true,
      message: 'Expert steps seeded into DB' + (githubPushed ? ' and services-config.js pushed to GitHub (Vercel deploys in ~60s)' : ' — GitHub push failed, check GITHUB_TOKEN'),
      category: expertSteps,
      githubPushed
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
// GET single category
router.get('/:id', protect, async (req, res) => {
  try {
    const cat = await ServiceCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, category: cat });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
// CREATE category
router.post('/', protect, superOnly, async (req, res) => {
  try {
    const { value, label, icon, color, creditCost, maxApproaches,
            questions, searchAliases, sortOrder, landingPricing } = req.body;
 
    if (!value || !label) {
      return res.status(400).json({ success: false, message: 'value and label are required' });
    }
 
    const cleanValue = value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
 
    const exists = await ServiceCategory.findOne({ value: cleanValue });
    if (exists) return res.status(400).json({ success: false, message: 'Service value "' + cleanValue + '" already exists' });
 
    const cat = await ServiceCategory.create({
      value:          cleanValue,
      label,
      icon:           icon  || '🔧',
      color:          color || '#FC8019',
      creditCost:     creditCost  || 20,
      maxApproaches:  maxApproaches || 5,
      questions:      questions  || [],
      searchAliases:  searchAliases || '',
      sortOrder:      sortOrder  || 99,
      landingPricing: landingPricing || [],
      createdBy:      req.admin.adminId
    });
 
    let githubPushed = false;
    try {
      await syncToGitHub();
      githubPushed = true;
    } catch(e) {
      console.error('GitHub push failed (non-fatal):', e.message);
    }
 
    res.status(201).json({
      success: true,
      message: 'Category created' + (githubPushed ? ' and services-config.js updated on GitHub (Vercel deploys in ~60s)' : ' — GitHub push failed, check GITHUB_TOKEN'),
      category: cat,
      githubPushed
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
// UPDATE category
router.put('/:id', protect, superOnly, async (req, res) => {
  try {
    const cat = await ServiceCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: 'Not found' });
 
    const allowed = ['label','icon','color','creditCost','maxApproaches',
                     'questions','searchAliases','sortOrder','isActive','landingPricing'];
    allowed.forEach(field => {
      if (req.body[field] !== undefined) {
        cat[field] = req.body[field];
      }
    });
 
    if (req.body.questions)      cat.markModified('questions');
    if (req.body.landingPricing) cat.markModified('landingPricing');
 
    await cat.save();
 
    let githubPushed = false;
    try {
      await syncToGitHub();
      githubPushed = true;
    } catch(e) {
      console.error('GitHub push failed (non-fatal):', e.message);
    }
 
    res.json({
      success: true,
      message: 'Category updated' + (githubPushed ? ' and GitHub synced' : ' — GitHub push failed'),
      category: cat,
      githubPushed
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
// DELETE category
router.delete('/:id', protect, superOnly, async (req, res) => {
  try {
    const cat = await ServiceCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: 'Not found' });
 
    await ServiceCategory.findByIdAndDelete(req.params.id);
 
    let githubPushed = false;
    try {
      await syncToGitHub();
      githubPushed = true;
    } catch(e) {
      console.error('GitHub push failed (non-fatal):', e.message);
    }
 
    res.json({
      success: true,
      message: 'Category deleted' + (githubPushed ? ' and GitHub synced' : ' — GitHub push failed'),
      githubPushed
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
 
module.exports = router;
