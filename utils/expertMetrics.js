function calculateProfileCompleteness(user) {
  const profile = user.profile || {};
  let total = 0;
  const loc = profile.expert_location_details && typeof profile.expert_location_details === 'object'
    ? profile.expert_location_details
    : {};
  const pick = (...values) => values.find(v => {
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') return Object.keys(v).length > 0;
    return v !== undefined && v !== null && String(v).trim() !== '';
  }) || '';
  const bio = pick(profile.bio, profile.expert_bio, user.bio);
  const specialization = pick(profile.specialization, profile.expert_specialization, user.specialization);
  const city = pick(profile.city, profile.expert_city, loc.city, user.location?.city);
  const pincode = pick(profile.pincode, profile.expert_pincode, loc.pincode, user.location?.pincode);
  const experience = pick(profile.experience, profile.expert_experience, user.yearsOfExperience);
  const professionalAddress = pick(profile.professionalAddress, profile.expert_professional_address, profile.professional_address, profile.address);

  if (user.profilePhoto) total += 10;
  if (bio && bio.length >= 30) total += 10;
  if (specialization) total += 10;
  if (city && pincode) total += 10;

  const credentials = pick(profile.gstNumber, profile.expert_gst_number, profile.gst_number, profile.licenseNumber, profile.expert_license_number, profile.license_number, profile.certificationNumber, profile.expert_certification_number, profile.certification_number);
  if (credentials) total += 8;
  if (pick(profile.education, profile.expert_education, user.education)) total += 8;
  if (pick(profile.portfolio, profile.expert_portfolio, user.portfolio)) total += 8;
  if (experience) total += 8;
  if (professionalAddress) total += 8;

  if ((user.reviewCount || 0) >= 1) total += 5;
  if ((user.totalApproaches || 0) >= 1) total += 5;
  const responseRate = user.responseRate || 0;
  if (responseRate >= 80) total += 10;
  else if (responseRate >= 50) total += 5;

  return Math.max(0, Math.min(100, total));
}

function calculateSearchScore(user) {
  const rating = Number(user.rating || 0);
  const reviewCount = Number(user.reviewCount || 0);
  const approaches = Number(user.totalApproaches || 0);
  const profileCompleteness = calculateProfileCompleteness(user);
  const adminBoost = Number(user.adminBoost || 0);

  const ratingScore = Math.min(50, rating * 10);
  const reviewScore = Math.min(15, reviewCount * 1.5);
  const approachScore = Math.min(20, approaches * 2);
  const profileScore = Math.min(15, profileCompleteness * 0.15);

  return Math.round((ratingScore + reviewScore + approachScore + profileScore + adminBoost) * 100) / 100;
}

function attachExpertScores(expert) {
  const output = expert.toObject ? expert.toObject() : Object.assign({}, expert);
  output.profileCompleteness = calculateProfileCompleteness(output);
  output.searchScore = calculateSearchScore(output);
  output.adminBoost = Number(output.adminBoost || 0);
  output.adminRank = output.adminRank === null || output.adminRank === undefined ? null : Number(output.adminRank);
  return output;
}

module.exports = {
  calculateProfileCompleteness,
  calculateSearchScore,
  attachExpertScores
};
