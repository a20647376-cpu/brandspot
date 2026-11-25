// Intelligent Organic Deal Ranking Engine
// Weights: 60% Verified Discount Strength, 25% Offer Freshness, 15% Quality & Relevance
// Paid sponsorship NEVER influences organic ranking scores.

export function computeOrganicScore(offer, nowMs = Date.now()) {
  if (!offer || offer.status !== 'active' || !offer.is_verified) return 0;
  const expiresMs = new Date(offer.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return 0;

  // 1. Verified discount strength (0..100)
  let discountStrength = 0;
  if (offer.discount_type === 'flat_percent') {
    discountStrength = Math.min(100, offer.discount_value * 1.4);
  } else if (offer.discount_type === 'up_to_percent') {
    // Conditional maximum discounts are weighted lower than equivalent unconditional flat discounts
    discountStrength = Math.min(82, offer.discount_value * 0.95);
  } else if (offer.discount_type === 'fixed_pkr') {
    discountStrength = Math.min(90, Math.round(offer.discount_value / 150));
  } else if (offer.discount_type === 'bogo') {
    discountStrength = 70;
  } else if (offer.discount_type === 'bundle') {
    discountStrength = 55;
  } else if (offer.discount_type === 'free_shipping') {
    discountStrength = 30;
  }

  // 2. Offer freshness (0..100)
  const startsMs = new Date(offer.starts_at).getTime();
  const ageDays = Math.max(0, (nowMs - startsMs) / 86400000);
  const freshness = Math.max(0, 100 - ageDays * 8);

  // 3. Quality & relevance (0..100)
  let quality = 60;
  if (offer.seller_id) quality += 20;
  if (offer.city_scope === 'Nationwide') quality += 10;
  if (offer.voucher_code) quality += 10;

  const score = (discountStrength * 0.60) + (freshness * 0.25) + (Math.min(100, quality) * 0.15);
  return Math.round(score * 100) / 100;
}

export function refreshAllOfferRankings(db, nowIso = new Date().toISOString()) {
  const nowMs = new Date(nowIso).getTime();
  const offers = db.prepare('SELECT * FROM offers').all();
  const expireStmt = db.prepare("UPDATE offers SET status = 'expired', ranking_score = 0 WHERE id = ?");
  const updateStmt = db.prepare('UPDATE offers SET ranking_score = ? WHERE id = ?');

  let updated = 0;
  let expired = 0;
  for (const o of offers) {
    if (o.status === 'active' && new Date(o.expires_at).getTime() <= nowMs) {
      expireStmt.run(o.id);
      expired++;
      continue;
    }
    const score = computeOrganicScore(o, nowMs);
    updateStmt.run(score, o.id);
    updated++;
  }
  return { updated, expired };
}
