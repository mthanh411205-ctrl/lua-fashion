// LỤA — máy chủ web: phục vụ giao diện (thư mục public/) và API đọc/ghi MySQL
const express = require('express');
const session = require('express-session');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { pool, hashPassword, verifyPassword, auth } = require('./db');
const { sendMail } = require('./mailer');

const app = express();
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

if (!process.env.SESSION_SECRET) console.warn('⚠  Chưa đặt SESSION_SECRET trong file .env — đang dùng chuỗi tạm.');

if (process.env.TRUST_PROXY) app.set('trust proxy', 1);   // chạy sau proxy của host (Render, Railway…) để lấy đúng IP khách

// Header bảo mật: chống clickjacking, chặn script lạ (CSP), chống đoán kiểu file…
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'", 'https://cdn.jsdelivr.net'],                 // Chart.js ở trang quản trị
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https:'],                             // ảnh QR VietQR, ảnh sản phẩm dán link
      'upgrade-insecure-requests': null                                     // cho phép chạy http://localhost
    }
  }
}));

app.use(express.json({ limit: '100kb' }));

// Phiên đăng nhập lưu trong bảng sessions của MySQL — khởi động lại server không bị đăng xuất.
// Tự viết (vài dòng) thay cho thư viện express-mysql-session để không kéo theo thư viện cũ có lỗ hổng.
class MySQLSessionStore extends session.Store {
  get(sid, cb) {
    pool.query('SELECT data FROM sessions WHERE session_id = ? AND expires > UNIX_TIMESTAMP()', [sid])
      .then(([[r]]) => cb(null, r ? JSON.parse(String(r.data)) : null), cb);
  }
  set(sid, sess, cb = () => {}) {
    const expires = Math.floor(new Date(sess.cookie.expires || Date.now() + 864e5).getTime() / 1000);
    pool.query('INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)',
      [sid, expires, JSON.stringify(sess)]).then(() => cb(), cb);
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb = () => {}) { pool.query('DELETE FROM sessions WHERE session_id = ?', [sid]).then(() => cb(), cb); }
}
// Dọn phiên hết hạn mỗi giờ
setInterval(() => pool.query('DELETE FROM sessions WHERE expires < UNIX_TIMESTAMP()').catch(() => {}), 3600 * 1000).unref();

app.use(session({
  secret: process.env.SESSION_SECRET || 'lua-dev-secret',
  store: new MySQLSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 7 * 24 * 3600 * 1000 }
}));

/* ---------- Tài khoản nhận chuyển khoản (đọc từ .env, hiển thị mã VietQR ở trang thanh toán) ---------- */
const BANK = process.env.BANK_ACCOUNT ? {
  bin: process.env.BANK_BIN || '970436',                         // mã ngân hàng (BIN), mặc định Vietcombank
  label: process.env.BANK_LABEL || 'Vietcombank',
  account: process.env.BANK_ACCOUNT,
  owner: (process.env.BANK_OWNER || 'LUA STUDIO').toUpperCase()
} : null;

/* ---------- Tiện ích ---------- */
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 255) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const PHONE_RE = /^(0|\+84)(3|5|7|8|9)\d{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SIZE_ORDER = ['S', 'M', 'L', 'XL', 'Free size'];
const PAID_CLAIM = '[Khách báo đã chuyển khoản, nội dung:';   // tiền tố ghi chú — admin-api.js dùng để gắn nhãn
const publicUser = (u) => u && { id: u.id, fullName: u.full_name, email: u.email, phone: u.phone, role: u.role, address: u.address || '', regionCode: u.region_code || '' };
const weakPassword = (p) => p.length < 8 || !/\d/.test(p) || !/[A-Za-z]/.test(p);
const money = (n) => `${Number(n).toLocaleString('vi-VN')}₫`;

// Giới hạn số lần thử — chống dò mật khẩu / spam email
const limiter = (limit, minutes, msg, extra) => rateLimit({
  windowMs: minutes * 60 * 1000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: msg }), ...extra
});
const loginLimit = limiter(5, 15, 'Bạn nhập sai quá 5 lần. Vui lòng thử lại sau 15 phút.', { skipSuccessfulRequests: true });
const registerLimit = limiter(10, 60, 'Quá nhiều lượt đăng ký từ máy này. Vui lòng thử lại sau.');
const resetLimit = limiter(5, 15, 'Quá nhiều yêu cầu. Vui lòng thử lại sau 15 phút.');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Danh mục sản phẩm (dùng cho mọi trang) ---------- */
async function loadCatalog({ all = false, ids = null } = {}) {
  if (ids && !ids.length) return { products: [] };
  const [categories] = await pool.query('SELECT slug AS id, name FROM categories ORDER BY sort_order');
  const [colors] = await pool.query('SELECT code, name, hex FROM colors ORDER BY id');
  const [regions] = await pool.query('SELECT code, name, fee, free_from AS freeFrom, eta FROM shipping_regions');
  const [rows] = await pool.query(`
    SELECT p.*, c.slug AS cat,
           (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE product_id = p.id) AS rating,
           (SELECT COUNT(*) FROM reviews WHERE product_id = p.id) AS review_count
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE ${all ? '1' : "p.status = 'active'"} ${ids ? 'AND p.id IN (?)' : ''}
    ORDER BY p.id`, [ids]);
  const [variants] = await pool.query(`
    SELECT v.id, v.product_id, v.size, co.code AS color, v.stock
    FROM product_variants v JOIN colors co ON co.id = v.color_id WHERE v.is_active ${ids ? 'AND v.product_id IN (?)' : ''} ORDER BY v.id`, [ids]);
  const [images] = await pool.query(`SELECT product_id, url, color_code AS color FROM product_images ${ids ? 'WHERE product_id IN (?)' : ''} ORDER BY product_id, sort_order, id`, [ids]);

  const products = rows.map((p) => {
    const vs = variants.filter((v) => v.product_id === p.id);
    return {
      id: p.id, sku: p.sku, name: p.name, cat: p.cat, price: p.price, oldPrice: p.old_price,
      badge: p.badge, imageUrl: p.image_url, material: p.material, desc: p.description,
      featured: !!p.is_featured, isNew: !!p.is_new, sold: p.sold_count, status: p.status,
      rating: p.rating === null ? null : Number(p.rating), reviewCount: p.review_count, createdAt: p.created_at,
      sizes: [...new Set(vs.map((v) => v.size))].sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b)),
      colors: [...new Set(vs.map((v) => v.color))],
      stock: Object.fromEntries(vs.map((v) => [`${v.size}|${v.color}`, v.stock])),
      // Bộ ảnh: mỗi ảnh gắn 1 màu (hoặc null = ảnh chung). Sản phẩm cũ chỉ có image_url -> 1 ảnh chung.
      images: (() => { const im = images.filter((i) => i.product_id === p.id).map(({ url, color }) => ({ url, color })); return im.length ? im : p.image_url ? [{ url: p.image_url, color: null }] : []; })(),
      variants: all ? vs.map(({ id, size, color, stock }) => ({ id, size, color, stock })) : undefined
    };
  });

  return {
    categories,
    colors: Object.fromEntries(colors.map((c) => [c.code, { name: c.name, hex: c.hex }])),
    regions: Object.fromEntries(regions.map((r) => [r.code, r])),
    products,
    bank: BANK
  };
}

// ponytail: trả về toàn bộ sản phẩm, lọc ở trình duyệt — ổn tới vài trăm sản phẩm; nhiều hơn thì chuyển lọc/phân trang sang SQL.
app.get('/api/catalog', async (req, res) => res.json(await loadCatalog()));

/* ---------- Tìm kiếm + lọc + phân trang ở server (trang Sản phẩm) ---------- */
const SORTS = { macdinh: 'p.is_featured DESC, p.id', moinhat: 'p.is_new DESC, p.id DESC', banchay: 'p.sold_count DESC', giatang: 'p.price', giagiam: 'p.price DESC' };
app.get('/api/products', async (req, res) => {
  const q = req.query, w = ["p.status = 'active'"], args = [];
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
  if (q.cat) { w.push('c.slug = ?'); args.push(String(q.cat)); }
  const [min, max] = String(q.price || '').split('-').map(Number);
  if (q.price && Number.isFinite(min) && Number.isFinite(max)) { w.push('p.price >= ? AND p.price < ?'); args.push(min, max); }
  const sizes = list(q.sizes), colors = list(q.colors);
  if (sizes.length) { w.push('EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active AND v.size IN (?))'); args.push(sizes); }
  if (colors.length) { w.push('EXISTS (SELECT 1 FROM product_variants v JOIN colors co ON co.id = v.color_id WHERE v.product_id = p.id AND v.is_active AND co.code IN (?))'); args.push(colors); }
  if (q.sale === '1') w.push('p.old_price IS NOT NULL');
  if (q.new === '1') w.push('p.is_new');
  // Collation utf8mb4_unicode_ci đã bỏ qua dấu (ao = áo); riêng "đ" đổi thành "d" để gõ "dam" vẫn ra "Đầm"
  const kw = str(q.q, 100).toLowerCase().replace(/đ/g, 'd').replace(/[\\%_]/g, '\\$&');
  if (kw) { w.push(`REPLACE(LOWER(CONCAT_WS(' ', p.name, p.material, c.name)), 'đ', 'd') LIKE ?`); args.push(`%${kw}%`); }
  const size = Math.min(48, Math.max(1, Number(q.limit) || 12));
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const from = `FROM products p JOIN categories c ON c.id = p.category_id WHERE ${w.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from}`, args);
  const [rows] = await pool.query(`SELECT p.id ${from} ORDER BY ${SORTS[q.sort] || SORTS.macdinh}, p.id LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]);
  const { products } = await loadCatalog({ ids: rows.map((r) => r.id) });
  const byId = new Map(products.map((p) => [p.id, p]));
  res.json({ total, page, pages: Math.max(1, Math.ceil(total / size)), items: rows.map((r) => byId.get(r.id)) });
});

/* ---------- Đánh giá ---------- */
app.get('/api/products/:id/reviews', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT r.id, r.rating, r.content, r.created_at, r.user_id,
           COALESCE(u.full_name, 'Khách hàng') AS name,
           EXISTS (SELECT 1 FROM orders o
                   JOIN order_items i ON i.order_id = o.id
                   JOIN product_variants v ON v.id = i.variant_id
                   WHERE o.user_id = r.user_id AND v.product_id = r.product_id AND o.status = 'completed') AS verified
    FROM reviews r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ? ORDER BY r.created_at DESC`, [req.params.id]);
  const mine = req.session.userId ? rows.some((r) => r.user_id === req.session.userId) : false;
  res.json({ reviews: rows.map(({ user_id, ...r }) => ({ ...r, verified: !!r.verified })), reviewedByMe: mine });
});

app.post('/api/products/:id/reviews', auth('customer'), async (req, res) => {
  const rating = Number(req.body.rating);
  const content = str(req.body.content, 1000);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return bad(res, 'Vui lòng chọn từ 1 đến 5 sao.');
  if (content.length < 10) return bad(res, 'Nội dung đánh giá cần ít nhất 10 ký tự.');
  try {
    await pool.query('INSERT INTO reviews (product_id, user_id, rating, content) VALUES (?, ?, ?, ?)', [req.params.id, req.user.id, rating, content]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return bad(res, 'Bạn đã đánh giá sản phẩm này rồi.', 409);
    if (e.code === 'ER_NO_REFERENCED_ROW_2') return bad(res, 'Sản phẩm không tồn tại.', 404);
    throw e;
  }
  res.status(201).json({ ok: true });
});

/* ---------- Mã giảm giá ---------- */
async function findCoupon(db, code) {
  const [[c]] = await db.query(`
    SELECT code, type, value, min_order AS minOrder, description AS label FROM coupons
    WHERE code = ? AND is_active
      AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at >= NOW())
      AND (usage_limit IS NULL OR used_count < usage_limit)`, [str(code, 30).toUpperCase()]);
  return c || null;
}

app.get('/api/coupons/:code', async (req, res) => {
  const c = await findCoupon(pool, req.params.code);
  c ? res.json(c) : bad(res, 'Mã giảm giá không tồn tại hoặc đã hết hạn.', 404);
});

/* ---------- Đặt hàng: giá, giảm giá, phí ship đều tính lại ở server ---------- */
app.post('/api/orders', async (req, res) => {
  const b = req.body || {};
  const f = {
    fullName: str(b.fullName, 100), phone: str(b.phone, 20).replace(/[\s.\-]/g, ''), email: str(b.email, 150) || null,
    region: str(b.region, 20), address: str(b.address), note: str(b.note, 500) || null, payment: b.payment === 'bank' ? 'bank' : 'cod'
  };
  const items = Array.isArray(b.items) ? b.items : [];
  if (f.fullName.length < 2) return bad(res, 'Vui lòng nhập họ và tên.');
  if (!PHONE_RE.test(f.phone)) return bad(res, 'Số điện thoại không hợp lệ.');
  if (f.email && !EMAIL_RE.test(f.email)) return bad(res, 'Email không hợp lệ.');
  if (f.address.length < 10) return bad(res, 'Vui lòng nhập địa chỉ đầy đủ.');
  if (!items.length || items.length > 30) return bad(res, 'Giỏ hàng trống hoặc quá nhiều sản phẩm.');
  if (items.some((i) => !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 10)) return bad(res, 'Số lượng mỗi sản phẩm từ 1 đến 10.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[region]] = await conn.query('SELECT * FROM shipping_regions WHERE code = ?', [f.region]);
    if (!region) { await conn.rollback(); return bad(res, 'Vui lòng chọn khu vực giao hàng.'); }

    const lines = [];
    for (const it of items) {
      const [[v]] = await conn.query(`
        SELECT v.id, v.stock, p.name, p.price, co.name AS color_name
        FROM product_variants v JOIN products p ON p.id = v.product_id JOIN colors co ON co.id = v.color_id
        WHERE p.id = ? AND v.size = ? AND co.code = ? AND p.status = 'active' AND v.is_active FOR UPDATE`, [it.id, str(it.size, 20), str(it.color, 20)]);
      if (!v) { await conn.rollback(); return bad(res, 'Có sản phẩm trong giỏ không còn bán. Vui lòng xóa và thêm lại.'); }
      if (v.stock < it.qty) { await conn.rollback(); return bad(res, `"${v.name}" (${it.size}, ${v.color_name}) chỉ còn ${v.stock} sản phẩm.`, 409); }
      lines.push({ ...v, size: str(it.size, 20), qty: it.qty });
    }

    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    let discount = 0, freeship = false, couponCode = null;
    if (b.couponCode) {
      const c = await findCoupon(conn, b.couponCode);
      if (c && subtotal >= c.minOrder) {
        couponCode = c.code;
        if (c.type === 'percent') discount = Math.round(subtotal * c.value / 100 / 1000) * 1000;
        if (c.type === 'fixed') discount = Math.min(c.value, subtotal);
        if (c.type === 'freeship') freeship = true;
      }
    }
    const shipping = freeship || (region.free_from !== null && subtotal >= region.free_from) ? 0 : region.fee;
    const total = subtotal - discount + shipping;
    if (f.payment === 'cod' && total >= 5000000) { await conn.rollback(); return bad(res, 'Đơn từ 5.000.000₫ cần thanh toán chuyển khoản.'); }
    // Khách bấm "Tôi đã chuyển khoản xong": ghi lại vào ghi chú để nhân viên đối chiếu (chưa đánh dấu "đã thanh toán"
    // cho tới khi nhân viên kiểm tra tài khoản ngân hàng)
    const transferInfo = f.payment === 'bank' ? (str(b.transferInfo, 60) || `LUA ${f.phone}`) : null;
    if (f.payment === 'bank' && b.paidConfirmed) {
      f.note = `${PAID_CLAIM} ${transferInfo}]${f.note ? ' ' + f.note : ''}`.slice(0, 500);
    }

    const d = new Date();
    const code = `LUA${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${Math.floor(100000 + Math.random() * 900000)}`;
    const [r] = await conn.query(`
      INSERT INTO orders (order_code, user_id, full_name, phone, email, region_code, address, note, payment_method, coupon_code, subtotal, discount, shipping_fee, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, req.session.userId || null, f.fullName, f.phone, f.email, f.region, f.address, f.note, f.payment, couponCode, subtotal, discount, shipping, total]);
    await conn.query('INSERT INTO order_status_history (order_id, status, note, changed_by) VALUES (?, ?, ?, ?)',
      [r.insertId, 'pending', f.payment === 'bank' && b.paidConfirmed ? 'Đặt hàng — khách báo đã chuyển khoản' : 'Đặt hàng', req.session.userId || null]);
    for (const l of lines) {
      await conn.query('INSERT INTO order_items (order_id, variant_id, product_name, size, color_name, unit_price, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [r.insertId, l.id, l.name, l.size, l.color_name, l.price, l.qty]);
    }
    if (couponCode) await conn.query('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', [couponCode]);
    // Khách đã đăng nhập: nhớ địa chỉ vừa dùng (và số điện thoại nếu tài khoản chưa có) để lần sau tự điền
    if (req.session.userId) {
      await conn.query('UPDATE users SET address = ?, region_code = ?, phone = COALESCE(phone, ?) WHERE id = ?',
        [f.address, f.region, f.phone, req.session.userId]);
    }
    await conn.commit();
    const paidNow = f.payment === 'bank' && await claimEarlyTransfer(r.insertId, f.phone, total);
    if (f.email) sendMail(f.email, `Xác nhận đơn hàng ${code} — LỤA`, orderEmail({ code, f, lines, subtotal, discount, shipping, total, region: region.name }));
    res.status(201).json({
      orderCode: code, subtotal, discount, shipping, total, payment: f.payment, region: region.name, transferInfo, paid: !!paidNow,
      fullName: f.fullName, phone: f.phone, address: f.address,
      items: lines.map((l) => ({ name: l.name, size: l.size, color: l.color_name, qty: l.qty }))
    });
  } catch (e) {
    await conn.rollback();
    if (e.errno === 1644) return bad(res, 'Một sản phẩm vừa hết hàng. Vui lòng kiểm tra lại giỏ.', 409); // lỗi từ trigger tồn kho
    throw e;
  } finally {
    conn.release();
  }
});

function orderEmail({ code, f, lines, subtotal, discount, shipping, total, region }) {
  const row = (a, b) => `<tr><td style="padding:6px 0">${a}</td><td style="padding:6px 0;text-align:right">${b}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1c1a17">
    <h2 style="color:#6b2737">Cảm ơn ${esc(f.fullName)} đã đặt hàng tại LỤA!</h2>
    <p>Mã đơn: <b>${code}</b> · Thanh toán: ${f.payment === 'bank' ? 'Chuyển khoản' : 'Khi nhận hàng (COD)'}</p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #c9bfa9">
      ${lines.map((l) => row(`${esc(l.name)} (${esc(l.size)}, ${esc(l.color_name)}) × ${l.qty}`, money(l.price * l.qty))).join('')}
      ${row('Tạm tính', money(subtotal))}${discount ? row('Giảm giá', '−' + money(discount)) : ''}${row(`Phí giao hàng (${esc(region)})`, money(shipping))}
      ${row('<b>Tổng cộng</b>', `<b>${money(total)}</b>`)}
    </table>
    <p>Giao đến: ${esc(f.address)} — ${esc(f.phone)}</p>
    <p>Nhân viên sẽ gọi xác nhận đơn trong vòng 24 giờ. Bạn có thể theo dõi đơn trong trang Tài khoản.</p>
  </div>`;
}

/* ---------- Tự xác nhận chuyển khoản (SePay) ----------
   Mọi giao dịch tiền vào được lưu vào bảng bank_transactions rồi ghép với đơn theo nội dung "LUA <số điện thoại>" + số tiền.
   - Tiền về SAU khi khách bấm đặt hàng: webhook ghép ngay.
   - Tiền về TRƯỚC (khách chuyển xong mới bấm): lúc tạo đơn, server tìm giao dịch chưa dùng trong 24 giờ để ghép. */
const phoneFromContent = (content) => {
  const m = String(content || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/LUA(0\d{9}|84\d{9})/);
  return m ? (m[1].startsWith('84') ? '0' + m[1].slice(2) : m[1]) : null;
};

async function markPaid(orderId, txId, amount, gateway) {
  const [r] = await pool.query("UPDATE orders SET payment_status = 'paid' WHERE id = ? AND payment_status = 'unpaid'", [orderId]);
  if (!r.affectedRows) return false;
  await pool.query('UPDATE bank_transactions SET order_id = ? WHERE id = ?', [orderId, txId]);
  await pool.query("INSERT INTO order_status_history (order_id, status, note) SELECT id, status, ? FROM orders WHERE id = ?",
    [`Đã nhận chuyển khoản ${money(amount)} (tự động — ${gateway})`, orderId]);
  return true;
}

// Ghi nhận 1 giao dịch tiền vào và thử ghép với đơn đang chờ thanh toán
async function receiveTransfer({ sepayId = null, gateway, amount, content }) {
  const phone = phoneFromContent(content);
  const [ins] = await pool.query('INSERT IGNORE INTO bank_transactions (sepay_id, gateway, amount, content, phone) VALUES (?, ?, ?, ?, ?)',
    [sepayId, str(gateway, 50) || 'SePay', amount, str(content, 255), phone]);
  if (!ins.affectedRows) return { duplicate: true };                       // SePay gửi lại cùng giao dịch
  if (!phone) return { matched: false };
  const [[o]] = await pool.query(`
    SELECT id, order_code FROM orders
    WHERE payment_method = 'bank' AND payment_status = 'unpaid' AND status NOT IN ('cancelled', 'returned')
      AND REPLACE(phone, '+84', '0') = ? AND total <= ?
    ORDER BY created_at DESC LIMIT 1`, [phone, amount]);
  return o && await markPaid(o.id, ins.insertId, amount, str(gateway, 50) || 'SePay') ? { matched: o.order_code } : { matched: false };
}

// Đơn chuyển khoản vừa tạo: có sẵn giao dịch khớp (khách chuyển trước) thì ghép luôn
async function claimEarlyTransfer(orderId, phone, total) {
  const [[t]] = await pool.query(`
    SELECT id, amount, gateway FROM bank_transactions
    WHERE order_id IS NULL AND phone = ? AND amount >= ? AND created_at > NOW() - INTERVAL 1 DAY
    ORDER BY id LIMIT 1`, [phone.replace(/^\+84/, '0'), total]);
  return t ? markPaid(orderId, t.id, t.amount, t.gateway) : false;
}

// Cấu hình webhook trên my.sepay.vn: URL https://<website>/api/webhooks/sepay, chứng thực "API Key" = SEPAY_API_KEY trong .env
app.post('/api/webhooks/sepay', async (req, res) => {
  const key = process.env.SEPAY_API_KEY;
  if (!key || req.headers.authorization !== `Apikey ${key}`) return bad(res, 'Unauthorized', 401);
  const b = req.body || {};
  if (b.transferType !== 'in') return res.json({ success: true });
  const amount = Math.round(Number(b.transferAmount) || 0);
  if (amount <= 0) return res.json({ success: true });
  const out = await receiveTransfer({ sepayId: Number(b.id) || null, gateway: b.gateway ? `SePay · ${b.gateway}` : 'SePay', amount, content: b.content });
  res.json({ success: true, ...out });
});

// Trang "Đặt hàng thành công" hỏi định kỳ xem tiền đã về chưa (phải kèm đúng số điện thoại của đơn)
app.get('/api/orders/:code/payment', async (req, res) => {
  const phone = str(req.query.phone, 20).replace(/[\s.\-]/g, '');
  const [[o]] = await pool.query('SELECT payment_status FROM orders WHERE order_code = ? AND phone = ?', [req.params.code, phone]);
  o ? res.json({ paymentStatus: o.payment_status }) : bad(res, 'Không tìm thấy đơn hàng.', 404);
});

/* ---------- Liên hệ & nhận tin ---------- */
app.post('/api/contact', async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 100), phone = str(b.phone, 20).replace(/[\s.\-]/g, ''), email = str(b.email, 150) || null, message = str(b.message, 2000);
  if (name.length < 2 || !PHONE_RE.test(phone) || message.length < 10 || (email && !EMAIL_RE.test(email))) return bad(res, 'Thông tin chưa hợp lệ.');
  await pool.query('INSERT INTO contact_messages (full_name, phone, email, message) VALUES (?, ?, ?, ?)', [name, phone, email, message]);
  res.status(201).json({ ok: true });
});

app.post('/api/newsletter', async (req, res) => {
  const email = str(req.body && req.body.email, 150).toLowerCase();
  if (!EMAIL_RE.test(email)) return bad(res, 'Email không hợp lệ.');
  await pool.query('INSERT IGNORE INTO newsletter_subscribers (email) VALUES (?)', [email]);
  res.status(201).json({ ok: true });
});

/* ---------- Đăng ký / đăng nhập ---------- */
function startSession(req, user) {
  return new Promise((ok, fail) => req.session.regenerate((err) => {   // đổi mã phiên sau đăng nhập, chống chiếm phiên
    if (err) return fail(err);
    req.session.userId = user.id;
    ok();
  }));
}

app.post('/api/auth/register', registerLimit, async (req, res) => {
  const b = req.body || {};
  const fullName = str(b.fullName, 100), email = str(b.email, 150).toLowerCase(), phone = str(b.phone, 20).replace(/[\s.\-]/g, '');
  const password = typeof b.password === 'string' ? b.password : '';
  if (fullName.length < 2) return bad(res, 'Vui lòng nhập họ và tên.');
  if (!EMAIL_RE.test(email)) return bad(res, 'Email không hợp lệ.');
  if (!PHONE_RE.test(phone)) return bad(res, 'Số điện thoại không hợp lệ.');
  if (weakPassword(password)) return bad(res, 'Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.');
  try {
    const [r] = await pool.query("INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'customer')",
      [fullName, email, phone, hashPassword(password)]);
    const user = { id: r.insertId, full_name: fullName, email, phone, role: 'customer' };
    await startSession(req, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return bad(res, 'Email này đã được đăng ký.', 409);
    throw e;
  }
});

app.post('/api/auth/login', loginLimit, async (req, res) => {
  const email = str(req.body && req.body.email, 150).toLowerCase();
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const [[user]] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !verifyPassword(password, user.password_hash)) return bad(res, 'Email hoặc mật khẩu không đúng.', 401);
  if (!user.is_active) return bad(res, 'Tài khoản đã bị khóa. Vui lòng liên hệ cửa hàng.', 403);
  await startSession(req, user);
  res.json({ user: publicUser(user) });
});

/* ---------- Quên mật khẩu: gửi mã 6 số qua email, hết hạn sau 15 phút ---------- */
app.post('/api/auth/forgot', resetLimit, async (req, res) => {
  const email = str(req.body && req.body.email, 150).toLowerCase();
  if (!EMAIL_RE.test(email)) return bad(res, 'Email không hợp lệ.');
  const [[u]] = await pool.query('SELECT id, full_name FROM users WHERE email = ? AND is_active', [email]);
  if (u) {
    const code = String(crypto.randomInt(100000, 1000000));
    await pool.query('DELETE FROM password_resets WHERE user_id = ?', [u.id]);
    await pool.query('INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL 15 MINUTE)', [u.id, hashPassword(code)]);
    sendMail(email, 'Mã đặt lại mật khẩu LỤA', `<div style="font-family:Arial,sans-serif">
      <p>Xin chào ${esc(u.full_name)},</p><p>Mã đặt lại mật khẩu của bạn là:</p>
      <p style="font-size:28px;letter-spacing:6px;font-weight:bold;color:#6b2737">${code}</p>
      <p>Mã có hiệu lực trong 15 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p></div>`);
  }
  res.json({ ok: true });   // luôn trả lời giống nhau — không để lộ email nào đã đăng ký
});

app.post('/api/auth/reset', resetLimit, async (req, res) => {
  const b = req.body || {};
  const email = str(b.email, 150).toLowerCase(), code = str(b.code, 6);
  const password = typeof b.password === 'string' ? b.password : '';
  const [[r]] = await pool.query(`SELECT pr.id, pr.code_hash, pr.attempts, pr.user_id FROM password_resets pr JOIN users u ON u.id = pr.user_id
    WHERE u.email = ? AND pr.expires_at > NOW()`, [email]);
  if (!r || r.attempts >= 5 || !verifyPassword(code, r.code_hash)) {
    if (r) await pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?', [r.id]);
    return bad(res, 'Mã không đúng hoặc đã hết hạn.');
  }
  if (weakPassword(password)) return bad(res, 'Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.');
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), r.user_id]);
  await pool.query('DELETE FROM password_resets WHERE user_id = ?', [r.user_id]);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const [[u]] = await pool.query('SELECT * FROM users WHERE id = ? AND is_active', [req.session.userId]);
  res.json({ user: publicUser(u) || null });
});

/* ---------- Khách hàng: đơn hàng của tôi ---------- */
app.get('/api/me/orders', auth(), async (req, res) => {
  const [orders] = await pool.query(`
    SELECT o.id, o.order_code, o.status, o.payment_method, o.payment_status, o.total, o.discount, o.shipping_fee, o.created_at, o.address, r.name AS region,
           (o.note LIKE '[Khách báo đã chuyển khoản%') AS claimed_paid
    FROM orders o JOIN shipping_regions r ON r.code = o.region_code
    WHERE o.user_id = ? ORDER BY o.created_at DESC`, [req.user.id]);
  const [items] = orders.length
    ? await pool.query(`SELECT i.order_id, i.product_name, i.size, i.color_name, i.quantity, i.line_total, v.product_id
                        FROM order_items i JOIN product_variants v ON v.id = i.variant_id WHERE i.order_id IN (?)`, [orders.map((o) => o.id)])
    : [[]];
  const [history] = orders.length
    ? await pool.query('SELECT order_id, status, note, created_at FROM order_status_history WHERE order_id IN (?) ORDER BY id', [orders.map((o) => o.id)])
    : [[]];
  res.json({
    user: publicUser(req.user),
    orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id), history: history.filter((h) => h.order_id === o.id) }))
  });
});

app.post('/api/me/orders/:code/cancel', auth(), async (req, res) => {
  const [r] = await pool.query("UPDATE orders SET status = 'cancelled' WHERE order_code = ? AND user_id = ? AND status = 'pending'", [req.params.code, req.user.id]);
  if (!r.affectedRows) return bad(res, 'Chỉ hủy được đơn đang chờ xác nhận.');
  await pool.query("INSERT INTO order_status_history (order_id, status, note, changed_by) SELECT id, 'cancelled', 'Khách tự hủy đơn', ? FROM orders WHERE order_code = ?", [req.user.id, req.params.code]);
  res.json({ ok: true });
});

/* ---------- Khách hàng: sửa thông tin & đổi mật khẩu ---------- */
app.put('/api/me', auth(), async (req, res) => {
  const b = req.body || {};
  const fullName = str(b.fullName, 100), phone = str(b.phone, 20).replace(/[\s.\-]/g, ''), address = str(b.address), region = str(b.regionCode, 20);
  if (fullName.length < 2) return bad(res, 'Vui lòng nhập họ và tên.');
  if (phone && !PHONE_RE.test(phone)) return bad(res, 'Số điện thoại không hợp lệ.');
  if (address && address.length < 10) return bad(res, 'Địa chỉ cần ít nhất 10 ký tự.');
  if (region && !(await pool.query('SELECT 1 FROM shipping_regions WHERE code = ?', [region]))[0].length) return bad(res, 'Khu vực không hợp lệ.');
  await pool.query('UPDATE users SET full_name = ?, phone = ?, address = ?, region_code = ? WHERE id = ?',
    [fullName, phone || null, address || null, region || null, req.user.id]);
  const [[u]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ user: publicUser(u) });
});

app.post('/api/me/password', auth(), loginLimit, async (req, res) => {
  const b = req.body || {};
  const current = typeof b.current === 'string' ? b.current : '', next = typeof b.password === 'string' ? b.password : '';
  const [[u]] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(current, u.password_hash)) return bad(res, 'Mật khẩu hiện tại không đúng.', 401);
  if (weakPassword(next)) return bad(res, 'Mật khẩu mới cần ít nhất 8 ký tự, gồm cả chữ và số.');
  if (current === next) return bad(res, 'Mật khẩu mới phải khác mật khẩu hiện tại.');
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(next), req.user.id]);
  res.json({ ok: true });
});

/* ---------- Quản trị (nhân viên + admin) ---------- */
app.use('/api/admin', require('./admin-api')(loadCatalog, receiveTransfer));

/* ---------- Chặn trang quản trị với người không đủ quyền ---------- */
app.get('/admin.html', async (req, res, next) => {
  const [[u]] = req.session.userId ? await pool.query('SELECT role, is_active FROM users WHERE id = ?', [req.session.userId]) : [[]];
  if (!u || !u.is_active || !['staff', 'admin'].includes(u.role)) return res.redirect('/dangnhap.html?next=admin.html');
  next();
});

/* ---------- Trang HTML: điền địa chỉ website vào thẻ OG; trang chi tiết thêm OG + JSON-LD theo sản phẩm ---------- */
async function productMeta(html, req, origin) {
  const [[p]] = await pool.query(`
    SELECT p.id, p.sku, p.name, p.description, p.price, p.image_url,
           (SELECT COALESCE(SUM(stock), 0) FROM product_variants WHERE product_id = p.id AND is_active) AS stock,
           (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE product_id = p.id) AS rating,
           (SELECT COUNT(*) FROM reviews WHERE product_id = p.id) AS reviews
    FROM products p WHERE p.id = ? AND p.status = 'active'`, [Number(req.query.id) || 0]);
  if (!p) return html;
  const url = `${origin}${req.originalUrl}`;
  const img = p.image_url ? (p.image_url.startsWith('/') ? origin + p.image_url : p.image_url) : `${origin}/og-image.png`;
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.sku, description: p.description, image: img,
    brand: { '@type': 'Brand', name: 'LỤA' },
    offers: { '@type': 'Offer', price: p.price, priceCurrency: 'VND', url, availability: `https://schema.org/${p.stock > 0 ? 'InStock' : 'OutOfStock'}` },
    ...(p.reviews ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(p.rating), reviewCount: p.reviews } } : {})
  };
  return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(p.name)} — LỤA</title>
<meta name="description" content="${esc(p.description || '')}">
<meta property="og:site_name" content="LỤA">
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(p.name)} — LỤA">
<meta property="og:description" content="${esc(p.description || '')}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(img)}">
<meta property="product:price:amount" content="${p.price}">
<meta property="product:price:currency" content="VND">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`);
}

app.get(/^\/([a-z0-9_-]+\.html)?$/i, async (req, res, next) => {
  const page = req.params[0] || 'index.html';
  let html;
  try { html = await fs.readFile(path.join(PUBLIC, page), 'utf8'); } catch { return next(); }
  const origin = `${req.protocol}://${req.get('host')}`;
  html = html.replaceAll('%ORIGIN%', origin);
  if (page === 'chitiet.html') html = await productMeta(html, req, origin);
  res.type('html').send(html);
});

app.use(express.static(PUBLIC));

app.use('/api', (req, res) => bad(res, 'Không tìm thấy API.', 404));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return bad(res, 'File quá lớn. Ảnh tối đa 5MB.', 413);
  // Chạy lại database.sql (bản cũ) trong lúc server đang chạy làm mất bảng mới -> tự tạo lại, không cần khởi động lại
  if (err.code === 'ER_NO_SUCH_TABLE') {
    console.error(`⚠  Thiếu bảng: ${err.sqlMessage} — có vẻ database.sql vừa được chạy lại. Đang tự tạo lại các bảng còn thiếu…`);
    migrate().catch((e) => console.error(e));
    return bad(res, 'Máy chủ vừa cập nhật cơ sở dữ liệu. Vui lòng bấm lại lần nữa.', 503);
  }
  console.error(err);
  bad(res, 'Lỗi máy chủ. Vui lòng thử lại sau.', 500);
});

/* ---------- Khởi động: kiểm tra kết nối CSDL trước ---------- */
// Tự thêm cột mới vào CSDL cũ (không cần chạy lại database.sql)
async function migrate() {
  const [cols] = await pool.query("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'");
  const has = (name) => cols.some((x) => x.c === name);
  if (!has('address')) await pool.query('ALTER TABLE users ADD COLUMN address VARCHAR(255) NULL AFTER phone');
  if (!has('region_code')) await pool.query('ALTER TABLE users ADD COLUMN region_code VARCHAR(20) NULL AFTER address');
  const [vcols] = await pool.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_variants' AND COLUMN_NAME = 'is_active'");
  if (!vcols.length) await pool.query('ALTER TABLE product_variants ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1');
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    expires INT UNSIGNED NOT NULL,
    data MEDIUMTEXT COLLATE utf8mb4_bin
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bank_transactions (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sepay_id BIGINT UNSIGNED NULL UNIQUE,
    gateway VARCHAR(50) NOT NULL,
    amount DECIMAL(12,0) NOT NULL,
    content VARCHAR(255) NULL,
    phone VARCHAR(15) NULL,
    order_id INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_tx_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS password_resets (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    CONSTRAINT fk_resets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS order_status_history (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id INT UNSIGNED NOT NULL,
    status VARCHAR(20) NOT NULL,
    note VARCHAR(255) NULL,
    changed_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_history_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    CONSTRAINT fk_history_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_logs (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NULL,
    action VARCHAR(50) NOT NULL,
    detail VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS product_images (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id INT UNSIGNED NOT NULL,
    url VARCHAR(255) NOT NULL,
    color_code VARCHAR(20) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    CONSTRAINT fk_images_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

migrate()
  .then(() => pool.query('SELECT COUNT(*) AS n FROM products'))
  .then(([[r]]) => {
    // Báo thư mục giao diện đang dùng + file bị thiếu (hay gặp khi chép sai chỗ thư mục js/)
    console.log(`📁 Thư mục giao diện: ${PUBLIC}`);
    const missing = ['index.html', 'style.css', 'js/app.js', 'js/layout.js'].filter((f) => !require('fs').existsSync(path.join(PUBLIC, f)));
    if (missing.length) console.warn(`⚠  Thiếu file trong thư mục trên: ${missing.join(', ')} — trang web sẽ bị mất giao diện.`);
    app.listen(PORT, () => console.log(`✔ Đã kết nối MySQL (${r.n} sản phẩm). Mở trình duyệt: http://localhost:${PORT}/index.html`));
  })
  .catch((e) => {
    const hints = {
      ECONNREFUSED: 'MySQL chưa chạy, hoặc sai DB_HOST/DB_PORT trong .env.',
      ER_ACCESS_DENIED_ERROR: 'Sai DB_USER hoặc DB_PASSWORD trong .env.',
      ER_BAD_DB_ERROR: 'Chưa có database lua_fashion — hãy chạy database.sql trong MySQL Workbench.',
      ER_NO_SUCH_TABLE: 'Thiếu bảng — hãy chạy lại toàn bộ database.sql trong MySQL Workbench.'
    };
    console.error(`✘ Không kết nối được MySQL: ${e.code || e.message}\n  → ${hints[e.code] || e.message}`);
    process.exit(1);
  });