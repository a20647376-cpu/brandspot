// BrandSpot Commission Calculation Engine
// Uses exact integer PKR arithmetic (basis points: 1000 bps = 10.00%).
// Never uses floating-point arithmetic for financial persistence.

export function calculateCommissionPkr(eligibleMerchandisePkr, rateBps, fixedPkr = 0) {
  if (!Number.isInteger(eligibleMerchandisePkr) || eligibleMerchandisePkr < 0) {
    throw new Error('eligibleMerchandisePkr must be a non-negative integer');
  }
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new Error('rateBps must be an integer between 0 and 10000');
  }
  const pctPart = Math.round((eligibleMerchandisePkr * rateBps) / 10000);
  const commissionPkr = Math.min(eligibleMerchandisePkr, pctPart + fixedPkr);
  const sellerNetPkr = eligibleMerchandisePkr - commissionPkr;
  return { commissionPkr, sellerNetPkr };
}

export function resolveSellerAgreement(db, sellerId, categoryId = null) {
  // Precedence: active seller+category agreement > active seller-wide agreement > default 8% (800 bps)
  if (categoryId) {
    const catMatch = db.prepare(
      "SELECT * FROM commission_agreements WHERE seller_id = ? AND category_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1"
    ).get(sellerId, categoryId);
    if (catMatch) return catMatch;
  }
  const sellerMatch = db.prepare(
    "SELECT * FROM commission_agreements WHERE seller_id = ? AND category_id IS NULL AND status = 'active' ORDER BY version DESC LIMIT 1"
  ).get(sellerId);
  if (sellerMatch) return sellerMatch;

  return { id: 'default', seller_id: sellerId, category_id: null, rate_bps: 800, fixed_pkr: 0, settlement_schedule: 'biweekly' };
}

export function calculateCommissionReversal(originalMerchPkr, returnedMerchPkr, rateBps) {
  const remainingMerchPkr = Math.max(0, originalMerchPkr - returnedMerchPkr);
  const orig = calculateCommissionPkr(originalMerchPkr, rateBps);
  const adjusted = calculateCommissionPkr(remainingMerchPkr, rateBps);
  return {
    remainingMerchPkr,
    originalCommissionPkr: orig.commissionPkr,
    adjustedCommissionPkr: adjusted.commissionPkr,
    reversalPkr: orig.commissionPkr - adjusted.commissionPkr
  };
}
