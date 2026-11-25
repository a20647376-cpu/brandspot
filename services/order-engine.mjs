import crypto from 'node:crypto';
import { calculateCommissionPkr, resolveSellerAgreement } from './commission-engine.mjs';
import { postJournalEntry } from './ledger-engine.mjs';

const VALID_TRANSITIONS = {
  order_created: ['awaiting_seller_acceptance', 'cancelled'],
  awaiting_seller_acceptance: ['seller_accepted', 'seller_rejected', 'cancelled'],
  seller_accepted: ['processing', 'cancelled'],
  processing: ['packed', 'cancelled'],
  packed: ['dispatched'],
  dispatched: ['delivered', 'return_requested'],
  delivered: ['completed', 'return_requested'],
  return_requested: ['refunded', 'completed'],
  seller_rejected: [],
  refunded: [],
  cancelled: [],
  completed: []
};

export function createMultiVendorOrder(db, {
  customerId = null,
  customerName,
  customerEmail,
  city,
  address,
  paymentMethod = 'cod_simulated',
  items = [],
  idempotencyKey = null
}) {
  if (!customerName || !customerEmail || !city || !address) {
    throw new Error('Missing customer delivery details');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty');
  }

  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM parent_orders WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      const subOrders = db.prepare('SELECT * FROM seller_orders WHERE parent_order_id = ?').all(existing.id);
      return { parentOrder: existing, sellerOrders: subOrders, deduplicated: true };
    }
  }

  const now = new Date().toISOString();
  const bySeller = new Map();
  let totalSubtotal = 0;
  let totalShipping = 0;

  // Validate products, stock, and group by authorized seller
  for (const item of items) {
    const qty = Number(item.qty || 1);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Invalid item quantity');

    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
    if (!prod || !prod.is_direct_buy || !prod.seller_id) {
      throw new Error(`Product ${item.productId} is not available for direct BrandSpot checkout`);
    }
    const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(prod.seller_id);
    if (!seller || seller.verification_status !== 'verified') {
      throw new Error(`Seller for ${prod.title} is not verified`);
    }
    if (prod.stock_qty < qty) {
      throw new Error(`Insufficient stock for ${prod.title} (available: ${prod.stock_qty})`);
    }

    const lineTotal = prod.sale_price_pkr * qty;
    totalSubtotal += lineTotal;

    if (!bySeller.has(seller.id)) {
      bySeller.set(seller.id, {
        seller,
        shippingPkr: prod.shipping_pkr,
        subtotalPkr: 0,
        items: []
      });
      totalShipping += prod.shipping_pkr;
    }
    const bucket = bySeller.get(seller.id);
    bucket.subtotalPkr += lineTotal;
    bucket.items.push({ prod, qty, lineTotal });
  }

  const parentId = 'BS-' + crypto.randomUUID().slice(0, 8).toUpperCase();
  const totalPkr = totalSubtotal + totalShipping;
  const paymentStatus = paymentMethod === 'cod_simulated' ? 'cod_pending' : 'simulated_paid';

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO parent_orders (id, customer_id, customer_name, customer_email, city, address, payment_method, payment_status, subtotal_pkr, shipping_pkr, total_pkr, idempotency_key, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(parentId, customerId, customerName, customerEmail, city, address, paymentMethod, paymentStatus, totalSubtotal, totalShipping, totalPkr, idempotencyKey, now);

    const sellerOrders = [];
    for (const [sellerId, bucket] of bySeller.entries()) {
      const firstCat = bucket.items[0]?.prod?.category_id || null;
      const agreement = resolveSellerAgreement(db, sellerId, firstCat);
      const { commissionPkr, sellerNetPkr } = calculateCommissionPkr(bucket.subtotalPkr, agreement.rate_bps, agreement.fixed_pkr);

      const subId = 'SUB-' + crypto.randomUUID().slice(0, 8).toUpperCase();
      db.prepare(
        `INSERT INTO seller_orders (id, parent_order_id, seller_id, status, subtotal_pkr, shipping_pkr, commission_rate_bps, commission_pkr, seller_net_pkr, commission_status, created_at, updated_at)
         VALUES (?, ?, ?, 'awaiting_seller_acceptance', ?, ?, ?, ?, ?, 'estimated', ?, ?)`
      ).run(subId, parentId, sellerId, bucket.subtotalPkr, bucket.shippingPkr, agreement.rate_bps, commissionPkr, sellerNetPkr, now, now);

      db.prepare(
        `INSERT INTO order_status_history (id, seller_order_id, from_status, to_status, actor_role, note, created_at)
         VALUES (?, ?, 'order_created', 'awaiting_seller_acceptance', 'system', 'Order routed to authorized seller', ?)`
      ).run('osh_' + crypto.randomUUID().slice(0, 10), subId, now);

      for (const bi of bucket.items) {
        db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?').run(bi.qty, bi.prod.id);
        db.prepare(
          `INSERT INTO order_items (id, seller_order_id, product_id, title, qty, unit_price_pkr, line_total_pkr)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run('oi_' + crypto.randomUUID().slice(0, 10), subId, bi.prod.id, bi.prod.title, bi.qty, bi.prod.sale_price_pkr, bi.lineTotal);
      }

      // Record estimated double-entry ledger recognition for Model A / B
      postJournalEntry(db, {
        referenceType: 'seller_order',
        referenceId: subId,
        description: `Order ${subId} routed to ${bucket.seller.business_name} (Estimated)`,
        postings: [
          { accountCode: '1200_COMMISSION_RECEIVABLE_EST', sellerId, debitPkr: commissionPkr, creditPkr: 0 },
          { accountCode: '4000_PLATFORM_COMMISSION_EST', sellerId, debitPkr: 0, creditPkr: commissionPkr }
        ]
      });

      sellerOrders.push({
        id: subId,
        parent_order_id: parentId,
        seller_id: sellerId,
        seller_name: bucket.seller.business_name,
        status: 'awaiting_seller_acceptance',
        subtotal_pkr: bucket.subtotalPkr,
        shipping_pkr: bucket.shippingPkr,
        commission_rate_bps: agreement.rate_bps,
        commission_pkr: commissionPkr,
        seller_net_pkr: sellerNetPkr
      });
    }

    db.exec('COMMIT');
    const parentOrder = db.prepare('SELECT * FROM parent_orders WHERE id = ?').get(parentId);
    return { parentOrder, sellerOrders, deduplicated: false };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function transitionSellerOrder(db, { sellerOrderId, nextStatus, actorRole, actorSellerId = null, trackingNumber = '', note = '' }) {
  const sub = db.prepare('SELECT * FROM seller_orders WHERE id = ?').get(sellerOrderId);
  if (!sub) throw new Error('Sub-order not found');
  if (actorRole === 'seller' && sub.seller_id !== actorSellerId) {
    throw new Error('Forbidden: cannot modify another seller order');
  }

  const allowed = VALID_TRANSITIONS[sub.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw new Error(`Invalid status transition from ${sub.status} to ${nextStatus}`);
  }

  const now = new Date().toISOString();
  let nextCommStatus = sub.commission_status;
  if (nextStatus === 'seller_accepted') nextCommStatus = 'pending_delivery';
  if (nextStatus === 'delivered' || nextStatus === 'completed') nextCommStatus = 'confirmed';
  if (nextStatus === 'seller_rejected' || nextStatus === 'cancelled' || nextStatus === 'refunded') nextCommStatus = 'reversed';

  db.prepare(
    `UPDATE seller_orders SET status = ?, commission_status = ?, tracking_number = COALESCE(NULLIF(?, ''), tracking_number), rejection_reason = CASE WHEN ? = 'seller_rejected' THEN ? ELSE rejection_reason END, updated_at = ? WHERE id = ?`
  ).run(nextStatus, nextCommStatus, trackingNumber, nextStatus, note, now, sellerOrderId);

  db.prepare(
    `INSERT INTO order_status_history (id, seller_order_id, from_status, to_status, actor_role, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('osh_' + crypto.randomUUID().slice(0, 10), sellerOrderId, sub.status, nextStatus, actorRole, note || '', now);

  if (nextStatus === 'delivered' || nextStatus === 'completed') {
    postJournalEntry(db, {
      referenceType: 'commission_confirmed',
      referenceId: sellerOrderId,
      description: `Confirmed commission for ${sellerOrderId}`,
      postings: [
        { accountCode: '1210_COMMISSION_RECEIVABLE_CONFIRMED', sellerId: sub.seller_id, debitPkr: sub.commission_pkr, creditPkr: 0 },
        { accountCode: '4100_PLATFORM_COMMISSION_CONFIRMED', sellerId: sub.seller_id, debitPkr: 0, creditPkr: sub.commission_pkr }
      ]
    });
  } else if (nextCommStatus === 'reversed' && sub.commission_pkr > 0) {
    postJournalEntry(db, {
      referenceType: 'commission_reversal',
      referenceId: sellerOrderId,
      description: `Commission reversed for ${sellerOrderId} (${nextStatus})`,
      postings: [
        { accountCode: '4000_PLATFORM_COMMISSION_EST', sellerId: sub.seller_id, debitPkr: sub.commission_pkr, creditPkr: 0 },
        { accountCode: '1200_COMMISSION_RECEIVABLE_EST', sellerId: sub.seller_id, debitPkr: 0, creditPkr: sub.commission_pkr }
      ]
    });
  }

  return db.prepare('SELECT * FROM seller_orders WHERE id = ?').get(sellerOrderId);
}
