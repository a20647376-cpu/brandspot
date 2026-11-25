import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initAndSeedDatabase } from './database/seed.mjs';
import { verifyPassword, signToken, getAuthUser } from './services/auth.mjs';
import { refreshAllOfferRankings } from './services/ranking-engine.mjs';
import { calculateCommissionPkr } from './services/commission-engine.mjs';
import { verifyLedgerBalance } from './services/ledger-engine.mjs';
import { createMultiVendorOrder, transitionSellerOrder } from './services/order-engine.mjs';

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const WEB_DIR = path.join(ROOT_DIR, 'apps', 'web');
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON payload');
  }
}

export function createAppServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      // --- API ROUTES ---
      if (pathname === '/api/v1/health' && method === 'GET') {
        const balance = verifyLedgerBalance(db);
        return sendJson(res, 200, { ok: true, service: 'brandspot-api', currency: 'PKR', ledgerBalanced: balance.balanced });
      }

      if (pathname === '/api/v1/auth/login' && method === 'POST') {
        const { email, password } = await readBody(req);
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
        if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
          return sendJson(res, 401, { error: 'Invalid credentials' });
        }
        const token = signToken({ id: user.id, email: user.email, fullName: user.full_name, role: user.role, sellerId: user.seller_id });
        return sendJson(res, 200, {
          token,
          user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, sellerId: user.seller_id, city: user.city }
        }, {
          'Set-Cookie': `bs_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
        });
      }

      if (pathname === '/api/v1/auth/logout' && method === 'POST') {
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'bs_session=; Path=/; HttpOnly; Max-Age=0' });
      }

      if (pathname === '/api/v1/auth/me' && method === 'GET') {
        const u = getAuthUser(req);
        return sendJson(res, 200, { user: u });
      }

      if (pathname === '/api/v1/categories' && method === 'GET') {
        const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all();
        return sendJson(res, 200, { categories });
      }

      if (pathname === '/api/v1/brands' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const cat = url.searchParams.get('category') || '';
        const featured = url.searchParams.get('featured') === '1';

        let sql = `SELECT b.*, c.name AS category_name, c.slug AS category_slug
                   FROM brands b JOIN categories c ON c.id = b.primary_category_id WHERE 1=1`;
        const params = [];
        if (q) {
          sql += ' AND (LOWER(b.name) LIKE ? OR LOWER(b.description) LIKE ? OR LOWER(c.name) LIKE ?)';
          params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        if (cat) {
          sql += ' AND (c.slug = ? OR c.id = ?)';
          params.push(cat, cat);
        }
        if (featured) {
          sql += ' AND b.featured_order IS NOT NULL ORDER BY b.featured_order ASC';
        } else {
          sql += ' ORDER BY COALESCE(b.featured_order, 9999) ASC, b.name ASC';
        }
        const brands = db.prepare(sql).all(...params);
        return sendJson(res, 200, { brands });
      }

      if (pathname.startsWith('/api/v1/brands/') && method === 'GET') {
        const slug = decodeURIComponent(pathname.slice('/api/v1/brands/'.length));
        const brand = db.prepare(
          `SELECT b.*, c.name AS category_name FROM brands b JOIN categories c ON c.id = b.primary_category_id WHERE b.slug = ?`
        ).get(slug);
        if (!brand) return sendJson(res, 404, { error: 'Brand not found' });
        const products = db.prepare('SELECT * FROM products WHERE brand_id = ? ORDER BY created_at DESC').all(brand.id);
        const offers = db.prepare("SELECT * FROM offers WHERE brand_id = ? AND status = 'active' ORDER BY ranking_score DESC").all(brand.id);
        return sendJson(res, 200, { brand, products, offers });
      }

      if (pathname === '/api/v1/products' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const cat = url.searchParams.get('category') || '';
        const city = url.searchParams.get('city') || '';
        const direct = url.searchParams.get('direct') === '1';
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 60)));

        let sql = `SELECT p.*, b.name AS brand_name, b.slug AS brand_slug, b.badge AS brand_badge, c.name AS category_name, s.business_name AS seller_name
                   FROM products p
                   JOIN brands b ON b.id = p.brand_id
                   JOIN categories c ON c.id = p.category_id
                   LEFT JOIN sellers s ON s.id = p.seller_id
                   WHERE 1=1`;
        const params = [];
        if (q) {
          sql += ' AND (LOWER(p.title) LIKE ? OR LOWER(b.name) LIKE ? OR LOWER(c.name) LIKE ?)';
          params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        if (cat) {
          sql += ' AND (c.slug = ? OR c.id = ?)';
          params.push(cat, cat);
        }
        if (city && city !== 'All Cities') {
          sql += " AND (p.city_scope = 'Nationwide' OR p.city_scope = ?)";
          params.push(city);
        }
        if (direct) {
          sql += ' AND p.is_direct_buy = 1';
        }
        sql += ' ORDER BY p.is_direct_buy DESC, p.created_at DESC LIMIT ?';
        params.push(limit);
        const products = db.prepare(sql).all(...params);
        return sendJson(res, 200, { products });
      }

      if (pathname === '/api/v1/offers' && method === 'GET') {
        const organic = db.prepare(
          `SELECT o.*, b.name AS brand_name, b.slug AS brand_slug, c.name AS category_name
           FROM offers o JOIN brands b ON b.id = o.brand_id JOIN categories c ON c.id = o.category_id
           WHERE o.status = 'active' AND o.is_sponsored = 0
           ORDER BY o.ranking_score DESC`
        ).all();
        const sponsored = db.prepare(
          `SELECT o.*, b.name AS brand_name, b.slug AS brand_slug, c.name AS category_name
           FROM offers o JOIN brands b ON b.id = o.brand_id JOIN categories c ON c.id = o.category_id
           WHERE o.status = 'active' AND o.is_sponsored = 1
           ORDER BY o.created_at DESC`
        ).all();
        return sendJson(res, 200, { organic, sponsored });
      }

      if (pathname === '/api/v1/checkout' && method === 'POST') {
        const user = getAuthUser(req);
        const body = await readBody(req);
        const result = createMultiVendorOrder(db, {
          customerId: user ? user.id : null,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          city: body.city,
          address: body.address,
          paymentMethod: body.paymentMethod || 'cod_simulated',
          items: body.items,
          idempotencyKey: body.idempotencyKey || null
        });
        // Strip confidential commission fields from customer-facing response
        const safeSubOrders = result.sellerOrders.map(so => ({
          id: so.id,
          seller_id: so.seller_id,
          seller_name: so.seller_name,
          status: so.status,
          subtotal_pkr: so.subtotal_pkr,
          shipping_pkr: so.shipping_pkr
        }));
        return sendJson(res, 201, { parentOrder: result.parentOrder, sellerOrders: safeSubOrders, deduplicated: result.deduplicated });
      }

      if (pathname === '/api/v1/orders' && method === 'GET') {
        const user = getAuthUser(req);
        if (!user) return sendJson(res, 401, { error: 'Authentication required' });

        if (user.role === 'admin') {
          const parentOrders = db.prepare('SELECT * FROM parent_orders ORDER BY created_at DESC LIMIT 50').all();
          const sellerOrders = db.prepare(
            `SELECT so.*, s.business_name AS seller_name FROM seller_orders so JOIN sellers s ON s.id = so.seller_id ORDER BY so.created_at DESC LIMIT 100`
          ).all();
          return sendJson(res, 200, { parentOrders, sellerOrders });
        }

        if (user.role === 'seller') {
          // Strict tenant isolation: only this seller's sub-orders
          const sellerOrders = db.prepare(
            `SELECT so.*, po.customer_name, po.city, po.address, po.payment_method
             FROM seller_orders so JOIN parent_orders po ON po.id = so.parent_order_id
             WHERE so.seller_id = ? ORDER BY so.created_at DESC`
          ).all(user.sellerId);
          return sendJson(res, 200, { sellerOrders });
        }

        const parentOrders = db.prepare('SELECT * FROM parent_orders WHERE customer_id = ? ORDER BY created_at DESC').all(user.id);
        for (const po of parentOrders) {
          po.subOrders = db.prepare(
            `SELECT so.id, so.seller_id, s.business_name AS seller_name, so.status, so.subtotal_pkr, so.shipping_pkr, so.tracking_number
             FROM seller_orders so JOIN sellers s ON s.id = so.seller_id WHERE so.parent_order_id = ?`
          ).all(po.id);
        }
        return sendJson(res, 200, { parentOrders });
      }

      if (pathname.startsWith('/api/v1/seller/orders/') && pathname.endsWith('/transition') && method === 'POST') {
        const user = getAuthUser(req);
        if (!user || (user.role !== 'seller' && user.role !== 'admin')) {
          return sendJson(res, 403, { error: 'Seller or Admin access required' });
        }
        const sellerOrderId = pathname.split('/')[4];
        const body = await readBody(req);
        const updated = transitionSellerOrder(db, {
          sellerOrderId,
          nextStatus: body.nextStatus,
          actorRole: user.role,
          actorSellerId: user.sellerId || null,
          trackingNumber: body.trackingNumber || '',
          note: body.note || ''
        });
        return sendJson(res, 200, { sellerOrder: updated });
      }

      if (pathname === '/api/v1/seller/dashboard' && method === 'GET') {
        const user = getAuthUser(req);
        if (!user || user.role !== 'seller' || !user.sellerId) {
          return sendJson(res, 403, { error: 'Seller authentication required' });
        }
        const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(user.sellerId);
        const agreement = db.prepare("SELECT * FROM commission_agreements WHERE seller_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").get(user.sellerId);
        const products = db.prepare('SELECT * FROM products WHERE seller_id = ? ORDER BY created_at DESC').all(user.sellerId);
        const orders = db.prepare(
          `SELECT so.*, po.customer_name, po.city FROM seller_orders so JOIN parent_orders po ON po.id = so.parent_order_id WHERE so.seller_id = ? ORDER BY so.created_at DESC`
        ).all(user.sellerId);
        const settlements = db.prepare('SELECT * FROM settlements WHERE seller_id = ? ORDER BY created_at DESC').all(user.sellerId);
        const metrics = db.prepare(
          `SELECT COALESCE(SUM(subtotal_pkr),0) AS gross_sales_pkr, COALESCE(SUM(commission_pkr),0) AS total_commission_pkr, COALESCE(SUM(seller_net_pkr),0) AS net_proceeds_pkr
           FROM seller_orders WHERE seller_id = ? AND status NOT IN ('seller_rejected', 'cancelled', 'refunded')`
        ).get(user.sellerId);
        return sendJson(res, 200, { seller, agreement, products, orders, settlements, metrics });
      }

      if (pathname === '/api/v1/seller/products' && method === 'POST') {
        const user = getAuthUser(req);
        if (!user || user.role !== 'seller' || !user.sellerId) {
          return sendJson(res, 403, { error: 'Seller authentication required' });
        }
        const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(user.sellerId);
        const body = await readBody(req);
        const id = 'prd_' + crypto.randomUUID().slice(0, 8);
        const orig = Math.max(100, Math.round(Number(body.originalPricePkr || 2000)));
        const sale = Math.max(50, Math.min(orig, Math.round(Number(body.salePricePkr || orig))));
        const stock = Math.max(0, Math.round(Number(body.stockQty || 10)));
        const title = String(body.title || 'New Seller Product').trim();
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + id.slice(-4);
        const now = new Date().toISOString();
        const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(seller.brand_id);

        db.prepare(
          `INSERT INTO products (id, slug, seller_id, brand_id, category_id, sku, title, description, original_price_pkr, sale_price_pkr, stock_qty, shipping_pkr, delivery_estimate, city_scope, image_url, is_direct_buy, is_demo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 250, '2-4 business days', ?, '', 1, 1, ?)`
        ).run(id, slug, seller.id, brand.id, brand.primary_category_id, 'SKU-' + id.slice(-4).toUpperCase(), title, String(body.description || 'Added from Seller Dashboard (Demo)'), orig, sale, stock, seller.city, now);
        return sendJson(res, 201, { product: db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
      }

      if (pathname === '/api/v1/admin/overview' && method === 'GET') {
        const user = getAuthUser(req);
        if (!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Admin access required' });

        const counts = {
          brands: db.prepare('SELECT COUNT(*) AS c FROM brands').get().c,
          sellers: db.prepare("SELECT COUNT(*) AS c FROM sellers WHERE verification_status = 'verified'").get().c,
          products: db.prepare('SELECT COUNT(*) AS c FROM products').get().c,
          activeOffers: db.prepare("SELECT COUNT(*) AS c FROM offers WHERE status = 'active'").get().c,
          orders: db.prepare('SELECT COUNT(*) AS c FROM parent_orders').get().c
        };
        const financials = db.prepare(
          `SELECT COALESCE(SUM(subtotal_pkr),0) AS gmv_pkr,
                  COALESCE(SUM(CASE WHEN commission_status = 'estimated' OR commission_status = 'pending_delivery' THEN commission_pkr ELSE 0 END),0) AS estimated_commission_pkr,
                  COALESCE(SUM(CASE WHEN commission_status = 'confirmed' OR commission_status = 'payable' OR commission_status = 'settled' THEN commission_pkr ELSE 0 END),0) AS confirmed_commission_pkr
           FROM seller_orders`
        ).get();
        const affiliateRevenuePkr = db.prepare("SELECT COALESCE(SUM(commission_pkr),0) AS c FROM affiliate_events WHERE event_type = 'confirmed_conversion'").get().c;
        const sponsoredRevenuePkr = db.prepare("SELECT COALESCE(SUM(daily_rate_pkr),0) AS c FROM sponsored_campaigns WHERE status = 'active'").get().c;
        const ledger = verifyLedgerBalance(db);
        const sellers = db.prepare(
          `SELECT s.*, ca.rate_bps, ca.settlement_schedule FROM sellers s LEFT JOIN commission_agreements ca ON ca.seller_id = s.id AND ca.status = 'active'`
        ).all();
        const campaigns = db.prepare(
          `SELECT sc.*, b.name AS brand_name FROM sponsored_campaigns sc JOIN brands b ON b.id = sc.brand_id`
        ).all();

        return sendJson(res, 200, { counts, financials, affiliateRevenuePkr, sponsoredRevenuePkr, ledger, sellers, campaigns });
      }

      if (pathname === '/api/v1/admin/commission-calc' && method === 'POST') {
        const user = getAuthUser(req);
        if (!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Admin access required' });
        const body = await readBody(req);
        const amount = Math.max(0, Math.round(Number(body.amountPkr || 0)));
        const rateBps = Math.max(0, Math.min(10000, Math.round(Number(body.ratePercent || 10) * 100)));
        const fixed = Math.max(0, Math.round(Number(body.fixedPkr || 0)));
        return sendJson(res, 200, calculateCommissionPkr(amount, rateBps, fixed));
      }

      if (pathname === '/api/v1/admin/automations/refresh-rankings' && method === 'POST') {
        const user = getAuthUser(req);
        if (!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Admin access required' });
        const result = refreshAllOfferRankings(db);
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (pathname === '/api/v1/affiliates/click' && method === 'POST') {
        const body = await readBody(req);
        const id = 'aff_' + crypto.randomUUID().slice(0, 8);
        db.prepare("INSERT INTO affiliate_events (id, brand_id, referral_code, event_type, commission_pkr, created_at) VALUES (?, ?, ?, 'click', 0, ?)")
          .run(id, String(body.brandId || 'br_khaadi'), String(body.referralCode || 'BS-WEB'), new Date().toISOString());
        return sendJson(res, 201, { ok: true, eventId: id });
      }

      // --- STATIC FILES (apps/web) ---
      let filePath = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
      if (!filePath.startsWith(WEB_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(WEB_DIR, 'index.html');
      }
      const ext = path.extname(filePath);
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Bad Request' });
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const db = initAndSeedDatabase();
  const server = createAppServer(db);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`BrandSpot server listening on http://127.0.0.1:${PORT}`);
  });
}
