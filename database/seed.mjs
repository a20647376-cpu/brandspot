import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../services/auth.mjs';
import { refreshAllOfferRankings } from '../services/ranking-engine.mjs';
import { createMultiVendorOrder, transitionSellerOrder } from '../services/order-engine.mjs';

const DB_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_PATH = path.join(DB_DIR, 'brandspot.db');
const SCHEMA_PATH = path.join(DB_DIR, 'schema.sql');

const CATEGORIES = [
  { id: 'cat_fashion', slug: 'fashion-clothing', name: 'Fashion & Clothing', description: 'Lawn, pret, unstitched, formal, eastern & western wear across Pakistan.', sort_order: 1 },
  { id: 'cat_footwear', slug: 'footwear-bags-accessories', name: 'Footwear, Bags & Accessories', description: 'Shoes, sneakers, sandals, handbags, watches & accessories.', sort_order: 2 },
  { id: 'cat_electronics', slug: 'electronics-appliances', name: 'Electronics & Appliances', description: 'Televisions, refrigerators, ACs, washing machines & kitchen appliances.', sort_order: 3 },
  { id: 'cat_mobiles', slug: 'mobiles-computers', name: 'Mobiles & Computers', description: 'Smartphones, laptops, tablets, audio & gaming accessories.', sort_order: 4 },
  { id: 'cat_beauty', slug: 'beauty-cosmetics', name: 'Beauty & Cosmetics', description: 'Makeup, foundations, lipsticks, brushes & gift sets.', sort_order: 5 },
  { id: 'cat_skincare', slug: 'skincare-personal-care', name: 'Skincare & Personal Care', description: 'Cleansers, serums, haircare, grooming & daily hygiene.', sort_order: 6 },
  { id: 'cat_perfumes', slug: 'perfumes-fragrances', name: 'Perfumes & Fragrances', description: 'Men, women & unisex fragrances, attars & body sprays.', sort_order: 7 },
  { id: 'cat_supermarkets', slug: 'supermarkets-cash-carry', name: 'Supermarkets & Cash & Carry', description: 'Nationwide & city-specific grocery, household & weekly catalogs.', sort_order: 8 },
  { id: 'cat_health', slug: 'health-wellness', name: 'Health & Wellness', description: 'Authorized multivitamins, nutrition & general wellness.', sort_order: 9 },
  { id: 'cat_home', slug: 'home-lifestyle', name: 'Home & Lifestyle', description: 'Furniture, bedding, decor, mattresses & kitchenware.', sort_order: 10 }
];

const BRAND_GROUPS = [
  ['cat_fashion', [
    'Khaadi', 'Sapphire', 'Gul Ahmed', 'Alkaram Studio', 'Limelight', 'Maria B', 'Sana Safinaz',
    'Nishat Linen', 'Bonanza Satrangi', 'Ethnic', 'Beechtree', 'J.', 'Outfitters', 'Generation',
    'Ideas', 'Cross Stitch', 'Asim Jofa', 'Bareeze', 'Zellbury', 'Edenrobe', 'So Kamal',
    'Republic Womenswear', 'Baroque', 'Mushq', 'Rang Rasiya', 'Sobia Nazir', 'Charizma'
  ]],
  ['cat_footwear', [
    'Stylo', 'ECS', 'Borjan', 'Servis', 'Bata', 'Ndure', 'Insignia', 'Unze London',
    'Hush Puppies', 'Nike', 'Adidas', 'Skechers'
  ]],
  ['cat_electronics', [
    'Haier', 'Dawlance', 'PEL', 'Gree', 'TCL', 'Orient', 'Kenwood', 'Panasonic',
    'Philips', 'Sony', 'LG'
  ]],
  ['cat_mobiles', [
    'Samsung', 'Apple', 'Xiaomi', 'Oppo', 'Vivo', 'Realme', 'Infinix', 'Tecno',
    'HP', 'Dell', 'Lenovo', 'ASUS', 'Acer', 'PriceOye'
  ]],
  ['cat_beauty', [
    'Christine', 'Rivaj UK', 'Medora', 'Luscious Cosmetics', 'Masarrat Misbah',
    'Maybelline', "L'Oréal", 'Huda Beauty', 'MAC', 'NYX'
  ]],
  ['cat_skincare', [
    'Dove', 'Pantene', 'Sunsilk', 'TRESemmé', 'Garnier', 'Nivea', 'Vaseline',
    'Head & Shoulders', 'Conatural', 'Saeed Ghani', 'Hemani'
  ]],
  ['cat_perfumes', [
    'J. Fragrances', 'Scents N Stories', 'WB by Hemani', 'Bonanza Satrangi Fragrances'
  ]],
  ['cat_supermarkets', [
    'METRO Pakistan', 'Imtiaz', 'Carrefour Pakistan', 'Chase Up', 'Chase Value',
    'Al-Fatah', 'Green Valley', 'Naheed', 'Jalal Sons'
  ]],
  ['cat_health', [
    'Nutrifactor', 'Herbiotics', 'HealthAid', 'Centrum', 'GNC', "Nature's Bounty", 'Vitabiotics'
  ]],
  ['cat_home', [
    'Interwood', 'Habitt', 'ChenOne', 'Ideas Home', 'Master MoltyFoam', 'Diamond Supreme Foam'
  ]]
];

const CITIES = ['Nationwide', 'Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan'];

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function makePlaceholderSvgDataUri(title, subtitle, accent = '#2c2926') {
  const safeT = String(title).replace(/[<>&"]/g, '');
  const safeS = String(subtitle).replace(/[<>&"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">
    <defs>
      <radialGradient id="g" cx="50%" cy="42%" r="65%">
        <stop offset="0%" stop-color="${accent}"/>
        <stop offset="55%" stop-color="#11100f"/>
        <stop offset="100%" stop-color="#050505"/>
      </radialGradient>
    </defs>
    <rect width="900" height="600" fill="url(#g)"/>
    <rect x="28" y="28" width="844" height="544" fill="none" stroke="rgba(244,242,239,0.16)" stroke-width="1"/>
    <text x="450" y="290" text-anchor="middle" fill="#f4f2ef" font-family="Georgia, serif" font-size="44" letter-spacing="1">${safeT}</text>
    <text x="450" y="340" text-anchor="middle" fill="#8c8783" font-family="Arial, sans-serif" font-size="16" letter-spacing="4">${safeS.toUpperCase()}</text>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function initAndSeedDatabase({ reset = false, dbPath = DB_PATH } = {}) {
  if (reset && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  const alreadyExists = dbPath !== ':memory:' && fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  const countRow = db.prepare('SELECT COUNT(*) AS c FROM brands').get();
  if (alreadyExists && countRow.c > 0 && !reset) {
    return db;
  }

  const now = new Date().toISOString();
  const future30 = new Date(Date.now() + 30 * 86400000).toISOString();
  const future7 = new Date(Date.now() + 7 * 86400000).toISOString();

  // 1. Categories
  const catStmt = db.prepare('INSERT INTO categories (id, slug, name, description, sort_order) VALUES (?, ?, ?, ?, ?)');
  for (const c of CATEGORIES) {
    catStmt.run(c.id, c.slug, c.name, c.description, c.sort_order);
  }

  // 2. ~100 Deduplicated Brands
  const brandStmt = db.prepare(
    `INSERT INTO brands (id, slug, name, primary_category_id, partnership_mode, badge, description, city_coverage, official_url, link_status, featured_order, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'pending_verification', ?, 1, ?)`
  );
  const bcStmt = db.prepare('INSERT OR IGNORE INTO brand_categories (brand_id, category_id) VALUES (?, ?)');

  const brandRows = [];
  let idx = 0;
  for (const [catId, names] of BRAND_GROUPS) {
    for (const name of names) {
      idx++;
      const id = 'br_' + slugify(name);
      const slug = slugify(name);
      const mode = idx <= 10 ? 'marketplace_seller' : idx <= 16 ? 'affiliate_partner' : idx <= 21 ? 'sponsored_advertiser' : 'directory_only';
      const badge = mode === 'marketplace_seller' ? 'Simulated Seller Partner'
        : mode === 'affiliate_partner' ? 'Affiliate Listing (Demo)'
        : mode === 'sponsored_advertiser' ? 'Sponsored (Demo)'
        : 'Directory Listing';
      const featuredOrder = idx <= 21 ? idx : null;
      const cityCoverage = catId === 'cat_supermarkets' ? CITIES[idx % CITIES.length] : 'Nationwide';
      const desc = `${name} — ${CATEGORIES.find(c => c.id === catId).name}. Listed in the BrandSpot Pakistan directory; official URLs remain pending verification until confirmed.`;

      brandStmt.run(id, slug, name, catId, mode, badge, desc, cityCoverage, featuredOrder, now);
      bcStmt.run(id, catId);
      brandRows.push({ id, slug, name, catId, mode, badge });
    }
  }

  // 3. 5 Fictional Simulated Sellers
  const sellers = [
    { id: 'sel_lahore_looms', name: 'Lahore Looms Studio (Demo Seller)', brand_id: 'br_khaadi', email: 'orders@lahorelooms.demo', city: 'Lahore', integration: 'dashboard', payModel: 'seller_collected', bps: 1000 },
    { id: 'sel_karachi_tech', name: 'Karachi Tech Hub (Demo Seller)', brand_id: 'br_samsung', email: 'orders@karachitech.demo', city: 'Karachi', integration: 'rest_api', payModel: 'seller_collected', bps: 300 },
    { id: 'sel_isb_glow', name: 'Islamabad Glow Collective (Demo Seller)', brand_id: 'br_masarrat-misbah', email: 'orders@isbglow.demo', city: 'Islamabad', integration: 'shopify', payModel: 'provider_collected', bps: 1200 },
    { id: 'sel_pindi_mart', name: 'Pindi Everyday Mart (Demo Seller)', brand_id: 'br_imtiaz', email: 'orders@pindimart.demo', city: 'Rawalpindi', integration: 'woocommerce', payModel: 'seller_collected', bps: 250 },
    { id: 'sel_multan_home', name: 'Multan Heritage Home (Demo Seller)', brand_id: 'br_chenone', email: 'orders@multanhome.demo', city: 'Multan', integration: 'dashboard', payModel: 'seller_collected', bps: 800 }
  ];

  const selStmt = db.prepare(
    `INSERT INTO sellers (id, business_name, brand_id, contact_email, city, verification_status, integration_mode, payment_model, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, 'verified', ?, ?, 1, ?)`
  );
  const agrStmt = db.prepare(
    `INSERT INTO commission_agreements (id, seller_id, category_id, rate_bps, fixed_pkr, settlement_schedule, status, version, valid_from, valid_to, created_at)
     VALUES (?, ?, NULL, ?, 0, 'biweekly', 'active', 1, ?, NULL, ?)`
  );

  for (const s of sellers) {
    selStmt.run(s.id, s.name, s.brand_id, s.email, s.city, s.integration, s.payModel, now);
    agrStmt.run('agr_' + s.id, s.id, s.bps, now, now);
  }

  // 4. Users (Admin, Seller 1, Seller 2, Customer)
  const userStmt = db.prepare(
    'INSERT INTO users (id, email, password_hash, full_name, role, seller_id, city, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  userStmt.run('usr_admin', 'admin@brandspot.pk', hashPassword('Admin@BrandSpot2026'), 'Platform Owner', 'admin', null, 'Islamabad', now);
  userStmt.run('usr_seller1', 'seller1@brandspot.pk', hashPassword('Seller@BrandSpot2026'), 'Tariq Mahmood (Lahore Looms)', 'seller', 'sel_lahore_looms', 'Lahore', now);
  userStmt.run('usr_seller2', 'seller2@brandspot.pk', hashPassword('Seller@BrandSpot2026'), 'Ayesha Siddiqui (Karachi Tech)', 'seller', 'sel_karachi_tech', 'Karachi', now);
  userStmt.run('usr_customer', 'customer@brandspot.pk', hashPassword('Customer@BrandSpot2026'), 'Zainab Ali', 'customer', null, 'Islamabad', now);

  // 5. 105 Demo Products across the brands
  const prodStmt = db.prepare(
    `INSERT INTO products (id, slug, seller_id, brand_id, category_id, sku, title, description, original_price_pkr, sale_price_pkr, stock_qty, shipping_pkr, delivery_estimate, city_scope, image_url, is_direct_buy, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );

  const CAT_IMAGES = {
    cat_fashion: ['/assets/fashion.jpg', '/assets/fashion2.jpg'],
    cat_footwear: ['/assets/footwear.jpg'],
    cat_electronics: ['/assets/electronics.jpg', '/assets/audio.jpg'],
    cat_mobiles: ['/assets/mobiles.jpg', '/assets/audio.jpg'],
    cat_beauty: ['/assets/fashion2.jpg', '/assets/fashion.jpg'],
    cat_skincare: ['/assets/fashion.jpg', '/assets/home.jpg'],
    cat_perfumes: ['/assets/footwear.jpg', '/assets/fashion2.jpg'],
    cat_supermarkets: ['/assets/supermarkets.jpg'],
    cat_health: ['/assets/supermarkets.jpg', '/assets/home.jpg'],
    cat_home: ['/assets/home.jpg', '/assets/electronics.jpg']
  };
  const directProductIds = [];
  for (let i = 0; i < 105; i++) {
    const b = brandRows[i % brandRows.length];
    const isDirect = i < 35; // first 35 products belong to the 5 simulated authorized sellers
    const seller = isDirect ? sellers[i % sellers.length] : null;
    const origPkr = b.catId === 'cat_mobiles' ? 68000 + (i % 6) * 15000
      : b.catId === 'cat_electronics' ? 92000 + (i % 5) * 20000
      : b.catId === 'cat_supermarkets' ? 1200 + (i % 8) * 450
      : 3500 + (i % 10) * 1400;
    const discountPct = [15, 20, 25, 30, 35, 40][i % 6];
    const salePkr = Math.round((origPkr * (100 - discountPct)) / 100);
    const id = 'prd_' + (i + 1);
    const title = `${b.name} ${i < 21 ? 'Signature' : 'Seasonal'} Edition #${i + 1}`;
    const slug = `${b.slug}-edition-${i + 1}`;
    const pool = CAT_IMAGES[b.catId] || ['/assets/fashion.jpg'];
    const imgUrl = pool[i % pool.length];

    prodStmt.run(
      id, slug, seller ? seller.id : null, b.id, b.catId,
      `BS-${1000 + i}`, title,
      `Simulated demonstration product for ${b.name}. ${isDirect ? 'Available for simulated multi-vendor checkout via ' + seller.name + '.' : 'Directory showcase item.'}`,
      origPkr, salePkr, isDirect ? 25 : 0, isDirect ? 250 : 0,
      '2-4 business days', b.catId === 'cat_supermarkets' ? 'Rawalpindi' : 'Nationwide',
      imgUrl, isDirect ? 1 : 0, now
    );
    if (isDirect) directProductIds.push(id);
  }

  // 6. 32 Demo Offers
  const offerStmt = db.prepare(
    `INSERT INTO offers (id, brand_id, seller_id, category_id, title, description, discount_type, discount_value, voucher_code, city_scope, is_sponsored, is_verified, status, starts_at, expires_at, ranking_score, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, 0, 1, ?)`
  );
  for (let i = 0; i < 32; i++) {
    const b = brandRows[i % brandRows.length];
    const seller = i < 15 ? sellers[i % sellers.length] : null;
    const isUpTo = i % 3 === 2;
    const isSponsored = i === 1 || i === 4 || i === 9 ? 1 : 0;
    const val = [40, 35, 30, 25, 20, 15][i % 6];
    const startsAt = new Date(Date.now() - (i % 5) * 86400000).toISOString();
    const expiresAt = i % 4 === 0 ? future7 : future30;
    offerStmt.run(
      'off_' + (i + 1), b.id, seller ? seller.id : null, b.catId,
      `${b.name} — ${isUpTo ? 'Up to ' : 'Flat '}${val}% Off (Demo)`,
      `Demonstration promotional campaign for ${b.name}. Clearly labelled as simulated data.`,
      isUpTo ? 'up_to_percent' : 'flat_percent', val,
      i % 2 === 0 ? `SPOT${val}` : '',
      CITIES[i % CITIES.length], isSponsored, startsAt, expiresAt, now
    );
  }
  refreshAllOfferRankings(db, now);

  // 7. Sample Sponsored Campaigns & Affiliate Events
  const campStmt = db.prepare(
    `INSERT INTO sponsored_campaigns (id, brand_id, slot, package_name, daily_rate_pkr, impressions, clicks, status, starts_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  );
  campStmt.run('cmp_1', 'br_khaadi', 'homepage_hero', 'Homepage Spotlight (Demo)', 25000, 14200, 680, now, future30);
  campStmt.run('cmp_2', 'br_samsung', 'category_hero', 'Category Leader (Demo)', 18000, 9400, 410, now, future30);

  const affStmt = db.prepare(
    `INSERT INTO affiliate_events (id, brand_id, referral_code, event_type, commission_pkr, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  affStmt.run('aff_1', 'br_gul-ahmed', 'BS-REF-GA01', 'click', 0, now);
  affStmt.run('aff_2', 'br_gul-ahmed', 'BS-REF-GA01', 'confirmed_conversion', 1450, now);

  // 8. Sample Multi-Vendor Order & Confirmed Sub-Order
  const { sellerOrders } = createMultiVendorOrder(db, {
    customerId: 'usr_customer',
    customerName: 'Zainab Ali',
    customerEmail: 'customer@brandspot.pk',
    city: 'Islamabad',
    address: 'House 14, Street 8, F-7/2, Islamabad',
    paymentMethod: 'cod_simulated',
    items: [
      { productId: directProductIds[0], qty: 1 },
      { productId: directProductIds[1], qty: 2 }
    ],
    idempotencyKey: 'seed-demo-order-1'
  });

  if (sellerOrders[0]) {
    transitionSellerOrder(db, { sellerOrderId: sellerOrders[0].id, nextStatus: 'seller_accepted', actorRole: 'seller', actorSellerId: sellerOrders[0].seller_id, note: 'Accepted by demo seller' });
    transitionSellerOrder(db, { sellerOrderId: sellerOrders[0].id, nextStatus: 'processing', actorRole: 'seller', actorSellerId: sellerOrders[0].seller_id });
    transitionSellerOrder(db, { sellerOrderId: sellerOrders[0].id, nextStatus: 'packed', actorRole: 'seller', actorSellerId: sellerOrders[0].seller_id });
    transitionSellerOrder(db, { sellerOrderId: sellerOrders[0].id, nextStatus: 'dispatched', actorRole: 'seller', actorSellerId: sellerOrders[0].seller_id, trackingNumber: 'TCS-DEMO-90812' });
    transitionSellerOrder(db, { sellerOrderId: sellerOrders[0].id, nextStatus: 'delivered', actorRole: 'admin', note: 'Demo delivery confirmed' });
  }

  return db;
}

if (process.argv[1] && process.argv[1].endsWith('seed.mjs')) {
  const reset = process.argv.includes('--reset');
  const db = initAndSeedDatabase({ reset });
  const counts = {
    categories: db.prepare('SELECT COUNT(*) AS c FROM categories').get().c,
    brands: db.prepare('SELECT COUNT(*) AS c FROM brands').get().c,
    sellers: db.prepare('SELECT COUNT(*) AS c FROM sellers').get().c,
    products: db.prepare('SELECT COUNT(*) AS c FROM products').get().c,
    offers: db.prepare('SELECT COUNT(*) AS c FROM offers').get().c
  };
  console.log('BrandSpot DB seeded:', counts);
}
