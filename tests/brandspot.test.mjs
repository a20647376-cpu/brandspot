import test from 'node:test';
import assert from 'node:assert/strict';
import { initAndSeedDatabase } from '../database/seed.mjs';
import { calculateCommissionPkr, calculateCommissionReversal } from '../services/commission-engine.mjs';
import { computeOrganicScore } from '../services/ranking-engine.mjs';
import { createMultiVendorOrder, transitionSellerOrder } from '../services/order-engine.mjs';
import { verifyLedgerBalance } from '../services/ledger-engine.mjs';
import { createAppServer } from '../server.mjs';

test('Commission engine computes exact integer PKR and partial refund reversal', () => {
  const { commissionPkr, sellerNetPkr } = calculateCommissionPkr(10000, 1000);
  assert.equal(commissionPkr, 1000);
  assert.equal(sellerNetPkr, 9000);

  const rev = calculateCommissionReversal(10000, 2000, 1000);
  assert.equal(rev.remainingMerchPkr, 8000);
  assert.equal(rev.adjustedCommissionPkr, 800);
  assert.equal(rev.reversalPkr, 200);
});

test('Organic ranking prefers unconditional flat discount over conditional up-to discount and excludes expired', () => {
  const now = Date.now();
  const base = {
    status: 'active',
    is_verified: 1,
    starts_at: new Date(now - 3600000).toISOString(),
    expires_at: new Date(now + 86400000).toISOString(),
    city_scope: 'Nationwide',
    seller_id: 'sel_1',
    voucher_code: 'SPOT20',
    discount_value: 30
  };
  const flatScore = computeOrganicScore({ ...base, discount_type: 'flat_percent' }, now);
  const upToScore = computeOrganicScore({ ...base, discount_type: 'up_to_percent' }, now);
  const expiredScore = computeOrganicScore({ ...base, discount_type: 'flat_percent', expires_at: new Date(now - 1000).toISOString() }, now);

  assert.ok(flatScore > upToScore);
  assert.equal(expiredScore, 0);
});

test('Multi-vendor checkout splits orders by seller, enforces state machine, and keeps ledger balanced', () => {
  const db = initAndSeedDatabase({ dbPath: ':memory:' });
  const directProducts = db.prepare('SELECT id, seller_id FROM products WHERE is_direct_buy = 1 LIMIT 2').all();
  assert.equal(directProducts.length, 2);

  const res = createMultiVendorOrder(db, {
    customerName: 'Test Buyer',
    customerEmail: 'buyer@test.demo',
    city: 'Lahore',
    address: 'Gulberg III',
    paymentMethod: 'cod_simulated',
    items: directProducts.map(p => ({ productId: p.id, qty: 1 })),
    idempotencyKey: 'test-idem-1'
  });

  assert.equal(res.sellerOrders.length, 2);
  assert.equal(res.deduplicated, false);

  // Idempotent retry returns same order
  const retry = createMultiVendorOrder(db, {
    customerName: 'Test Buyer',
    customerEmail: 'buyer@test.demo',
    city: 'Lahore',
    address: 'Gulberg III',
    items: directProducts.map(p => ({ productId: p.id, qty: 1 })),
    idempotencyKey: 'test-idem-1'
  });
  assert.equal(retry.deduplicated, true);

  // Invalid state transition throws
  assert.throws(() => {
    transitionSellerOrder(db, {
      sellerOrderId: res.sellerOrders[0].id,
      nextStatus: 'delivered',
      actorRole: 'seller',
      actorSellerId: res.sellerOrders[0].seller_id
    });
  }, /Invalid status transition/);

  // Ledger must remain balanced
  const bal = verifyLedgerBalance(db);
  assert.equal(bal.balanced, true);
  assert.ok(bal.totalDebitsPkr > 0);
  db.close();
});

test('API enforces tenant isolation and admin authorization', async () => {
  const db = initAndSeedDatabase({ dbPath: ':memory:' });
  const server = createAppServer(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Unauthenticated admin overview is 403
    const unauth = await fetch(`${baseUrl}/api/v1/admin/overview`);
    assert.equal(unauth.status, 403);

    // Login as seller1
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'seller1@brandspot.pk', password: 'Seller@BrandSpot2026' })
    });
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json();

    const dashRes = await fetch(`${baseUrl}/api/v1/seller/dashboard`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(dashRes.status, 200);
    const dash = await dashRes.json();
    assert.equal(dash.seller.id, 'sel_lahore_looms');
    for (const o of dash.orders) {
      assert.equal(o.seller_id, 'sel_lahore_looms');
    }

    // Seller cannot access admin overview
    const admRes = await fetch(`${baseUrl}/api/v1/admin/overview`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(admRes.status, 403);
  } finally {
    server.close();
    db.close();
  }
});
