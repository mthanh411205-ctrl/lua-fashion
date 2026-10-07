// API quản trị — mọi route ở đây yêu cầu đăng nhập với vai trò nhân viên (staff) hoặc admin.
// Route nào chỉ admin được dùng thì có thêm ADMIN_ONLY.
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pool, hashPassword, auth } = require('./db');

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
// Loại ảnh được nhận: đuôi file + "chữ ký" byte đầu file (chặn file giả mạo đổi đuôi)
const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png':  { ext: 'png', ok: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  'image/webp': { ext: 'webp', ok: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
  'image/gif':  { ext: 'gif', ok: (b) => b.subarray(0, 3).toString() === 'GIF' }
};

const STAFF = auth('staff', 'admin');
const ADMIN_ONLY = auth('admin');
const ORDER_STATUS = ['pending', 'confirmed', 'shipping', 'completed', 'cancelled', 'returned'];
const PAY_STATUS = ['unpaid', 'paid', 'refunded'];
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 255) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Nhật ký thao tác: ai làm gì, lúc nào
const log = (req, action, detail) => pool.query('INSERT INTO admin_logs (user_id, action, detail) VALUES (?, ?, ?)', [req.user.id, action, String(detail).slice(0, 255)]);
const STATUS_VI = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', shipping: 'Đang giao', completed: 'Hoàn tất', cancelled: 'Đã hủy', returned: 'Trả hàng' };
const PAY_VI = { unpaid: 'Chưa thanh toán', paid: 'Đã thanh toán', refunded: 'Đã hoàn tiền' };

module.exports = (loadCatalog, receiveTransfer) => {
  const r = express.Router();
  r.use(STAFF);

  /* ---------- Tổng quan ---------- */
  r.get('/stats', async (req, res) => {
    const [byStatus] = await pool.query('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    const [lowStock] = await pool.query('SELECT * FROM v_low_stock LIMIT 8');
    const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM contact_messages WHERE NOT is_handled');
    const out = { role: req.user.role, byStatus, lowStock, unread };
    if (req.user.role === 'admin') {                           // doanh thu chỉ admin xem
      [out.revenue] = await pool.query('SELECT * FROM v_revenue_by_month ORDER BY month DESC LIMIT 12');
      [out.byCategory] = await pool.query(`
        SELECT c.name, SUM(i.line_total) AS revenue
        FROM order_items i JOIN orders o ON o.id = i.order_id
        JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id JOIN categories c ON c.id = p.category_id
        WHERE o.status NOT IN ('cancelled', 'returned') GROUP BY c.id, c.name ORDER BY revenue DESC`);
      [out.topProducts] = await pool.query('SELECT name, sold_count FROM v_product_list ORDER BY sold_count DESC LIMIT 5');
      [[out.totals]] = await pool.query(`SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customers,
        (SELECT COUNT(*) FROM newsletter_subscribers) AS subscribers,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status NOT IN ('cancelled','returned')) AS revenue`);
    }
    res.json(out);
  });

  /* ---------- Đơn hàng (nhân viên + admin) ---------- */
  r.get('/orders', async (req, res) => {
    const status = ORDER_STATUS.includes(req.query.status) ? req.query.status : null;
    const q = str(req.query.q, 50);
    const [rows] = await pool.query(`
      SELECT o.id, o.order_code, o.full_name, o.phone, o.status, o.payment_method, o.payment_status, o.total, o.created_at,
             (o.note LIKE '[Khách báo đã chuyển khoản%') AS claimed_paid,   -- khách đã bấm "Tôi đã chuyển khoản xong"
             (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS item_count
      FROM orders o
      WHERE (? IS NULL OR o.status = ?) AND (? = '' OR o.order_code LIKE ? OR o.phone LIKE ? OR o.full_name LIKE ?)
      ORDER BY o.created_at DESC LIMIT 200`, [status, status, q, `%${q}%`, `%${q}%`, `%${q}%`]);
    res.json(rows);
  });

  r.get('/orders/:id', async (req, res) => {
    const [[order]] = await pool.query(`SELECT o.*, s.name AS region FROM orders o JOIN shipping_regions s ON s.code = o.region_code WHERE o.id = ?`, [req.params.id]);
    if (!order) return bad(res, 'Không tìm thấy đơn hàng.', 404);
    const [items] = await pool.query('SELECT product_name, size, color_name, unit_price, quantity, line_total FROM order_items WHERE order_id = ?', [order.id]);
    const [history] = await pool.query(`SELECT h.status, h.note, h.created_at, u.full_name AS by_name
      FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.order_id = ? ORDER BY h.id`, [order.id]);
    res.json({ ...order, items, history });
  });

  r.patch('/orders/:id', async (req, res) => {
    const { status, payment_status } = req.body || {};
    if (status && !ORDER_STATUS.includes(status)) return bad(res, 'Trạng thái không hợp lệ.');
    if (payment_status && !PAY_STATUS.includes(payment_status)) return bad(res, 'Trạng thái thanh toán không hợp lệ.');
    const [[o]] = await pool.query('SELECT status, payment_status, order_code FROM orders WHERE id = ?', [req.params.id]);
    if (!o) return bad(res, 'Không tìm thấy đơn hàng.', 404);
    if (['cancelled', 'returned'].includes(o.status)) return bad(res, 'Đơn đã hủy/trả hàng không thể thay đổi.');
    await pool.query('UPDATE orders SET status = COALESCE(?, status), payment_status = COALESCE(?, payment_status) WHERE id = ?',
      [status || null, payment_status || null, req.params.id]);   // hủy đơn -> trigger tự hoàn kho
    const changes = [status && status !== o.status && STATUS_VI[status], payment_status && payment_status !== o.payment_status && PAY_VI[payment_status]].filter(Boolean);
    if (changes.length) {
      await pool.query('INSERT INTO order_status_history (order_id, status, note, changed_by) VALUES (?, ?, ?, ?)',
        [req.params.id, status || o.status, changes.join(' · '), req.user.id]);
      await log(req, 'Cập nhật đơn', `${o.order_code}: ${changes.join(', ')}`);
    }
    res.json({ ok: true });
  });

  /* ---------- Sản phẩm & tồn kho ---------- */
  r.get('/products', async (req, res) => res.json(await loadCatalog({ all: true })));

  // Nhân viên được cập nhật tồn kho
  r.patch('/variants/:id', async (req, res) => {
    const stock = Number(req.body && req.body.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 99999) return bad(res, 'Tồn kho phải là số nguyên từ 0.');
    const [x] = await pool.query('UPDATE product_variants SET stock = ? WHERE id = ?', [stock, req.params.id]);
    if (!x.affectedRows) return bad(res, 'Không tìm thấy biến thể.', 404);
    const [[v]] = await pool.query('SELECT p.sku, v.size, co.name AS color FROM product_variants v JOIN products p ON p.id = v.product_id JOIN colors co ON co.id = v.color_id WHERE v.id = ?', [req.params.id]);
    await log(req, 'Sửa tồn kho', `${v.sku} ${v.size}/${v.color} = ${stock}`);
    res.json({ ok: true });
  });

  // Tải ảnh sản phẩm lên (admin). Trình duyệt gửi thẳng file ảnh, không cần thư viện multer.
  // ponytail: ảnh cũ không tự xóa khi đổi ảnh khác — dọn thư mục public/uploads bằng tay nếu cần.
  r.post('/uploads', ADMIN_ONLY, express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
    const t = IMAGE_TYPES[(req.headers['content-type'] || '').split(';')[0]];
    const buf = req.body;
    if (!t || !Buffer.isBuffer(buf) || buf.length < 12 || !t.ok(buf)) return bad(res, 'Chỉ nhận file ảnh JPG, PNG, WEBP hoặc GIF.');
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${t.ext}`;
    await fs.writeFile(path.join(UPLOAD_DIR, name), buf);
    res.status(201).json({ url: `/uploads/${name}` });
  });

  // Thêm / sửa / ngừng bán sản phẩm: chỉ admin
  async function saveProduct(req, res, id) {
    const b = req.body || {};
    const p = {
      sku: str(b.sku, 20).toUpperCase(), name: str(b.name, 150), cat: str(b.cat, 50),
      price: Number(b.price), old_price: b.oldPrice ? Number(b.oldPrice) : null,
      material: str(b.material, 150) || null, description: str(b.desc, 2000) || null, badge: str(b.badge, 30) || null,
      image_url: str(b.imageUrl, 255) || null, is_featured: !!b.featured, is_new: !!b.isNew,
      status: ['active', 'hidden', 'discontinued'].includes(b.status) ? b.status : 'active'
    };
    const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map((s) => str(s, 20)).filter(Boolean);
    const colors = (Array.isArray(b.colors) ? b.colors : []).map((c) => str(c, 20)).filter(Boolean);
    if (!p.sku || p.name.length < 2) return bad(res, 'Cần nhập mã SKU và tên sản phẩm.');
    if (!Number.isFinite(p.price) || p.price <= 0) return bad(res, 'Giá bán phải lớn hơn 0.');
    if (p.old_price !== null && !(p.old_price > p.price)) return bad(res, 'Giá gốc phải lớn hơn giá bán (hoặc để trống).');
    if (p.image_url && !/^https?:\/\//.test(p.image_url) && !p.image_url.startsWith('/')) return bad(res, 'Đường dẫn ảnh phải bắt đầu bằng http(s):// hoặc /');
    // Bộ ảnh: [{ url, color: tên màu admin gõ (hoặc để trống = ảnh chung), hex }]
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, 30)
      .map((i) => ({ url: str(i && i.url, 255), color: str(i && i.color, 50), hex: /^#[0-9a-f]{6}$/i.test(i && i.hex) ? i.hex : '#9c7b56' }))
      .filter((i) => i.url);
    if (images.some((i) => !/^https?:\/\//.test(i.url) && !i.url.startsWith('/'))) return bad(res, 'Đường dẫn ảnh phải bắt đầu bằng http(s):// hoặc /');
    if (images.length) p.image_url = images[0].url;       // ảnh đầu tiên = ảnh đại diện
    // Đổi tên màu -> mã màu; màu chưa có thì tạo mới. Màu gắn với ảnh tự được thêm vào danh sách màu của sản phẩm.
    for (const img of images) {
      if (!img.color) { img.code = null; continue; }
      const [[c]] = await pool.query('SELECT code FROM colors WHERE LOWER(name) = LOWER(?) OR code = ?', [img.color, img.color]);
      if (c) img.code = c.code;
      else {
        const slug = img.color.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14) || 'mau';
        img.code = `${slug}-${Date.now().toString(36).slice(-4)}`;
        await pool.query('INSERT INTO colors (code, name, hex) VALUES (?, ?, ?)', [img.code, img.color, img.hex]);
        colors.push(img.code);   // màu mới tạo từ ảnh -> tự thêm vào sản phẩm
      }
    }
    if (!sizes.length || !colors.length) return bad(res, 'Chọn ít nhất 1 size và 1 màu.');
    const [[cat]] = await pool.query('SELECT id FROM categories WHERE slug = ?', [p.cat]);
    if (!cat) return bad(res, 'Danh mục không hợp lệ.');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const vals = [p.sku, p.name, cat.id, p.price, p.old_price, p.material, p.description, p.badge, p.image_url, p.is_featured, p.is_new, p.status];
      if (id) {
        const [x] = await conn.query(`UPDATE products SET sku=?, name=?, category_id=?, price=?, old_price=?, material=?, description=?, badge=?, image_url=?, is_featured=?, is_new=?, status=? WHERE id=?`, [...vals, id]);
        if (!x.affectedRows) { await conn.rollback(); return bad(res, 'Không tìm thấy sản phẩm.', 404); }
      } else {
        const [x] = await conn.query(`INSERT INTO products (sku, name, category_id, price, old_price, material, description, badge, image_url, is_featured, is_new, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, vals);
        id = x.insertId;
      }
      if (Array.isArray(b.images)) {
        await conn.query('DELETE FROM product_images WHERE product_id = ?', [id]);
        for (const [n, img] of images.entries()) await conn.query('INSERT INTO product_images (product_id, url, color_code, sort_order) VALUES (?, ?, ?, ?)', [id, img.url, img.code, n]);
      }
      // Tạo biến thể còn thiếu (tồn kho 0). Không xóa biến thể cũ vì đơn hàng cũ còn tham chiếu.
      for (const s of sizes) for (const c of colors) {
        await conn.query(`INSERT IGNORE INTO product_variants (product_id, size, color_id, stock) SELECT ?, ?, id, 0 FROM colors WHERE code = ?`, [id, s, c]);
      }
      // Size/màu bị bỏ tick -> ẩn biến thể (không xóa vì đơn cũ còn tham chiếu). Tick lại -> hiện lại với tồn kho cũ.
      await conn.query(`UPDATE product_variants v JOIN colors co ON co.id = v.color_id
        SET v.is_active = (v.size IN (?) AND co.code IN (?)) WHERE v.product_id = ?`, [sizes, colors, id]);
      await conn.commit();
      await log(req, req.params.id ? 'Sửa sản phẩm' : 'Thêm sản phẩm', `${p.sku} — ${p.name}`);
      res.status(201).json({ id });
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') return bad(res, 'Mã SKU đã tồn tại.', 409);
      throw e;
    } finally { conn.release(); }
  }

  r.post('/products', ADMIN_ONLY, (req, res) => saveProduct(req, res, null));
  r.put('/products/:id', ADMIN_ONLY, (req, res) => saveProduct(req, res, Number(req.params.id)));
  // Không xóa hẳn vì đơn hàng cũ còn tham chiếu — chuyển sang "ngừng bán"
  r.delete('/products/:id', ADMIN_ONLY, async (req, res) => {
    await pool.query("UPDATE products SET status = 'discontinued' WHERE id = ?", [req.params.id]);
    await log(req, 'Ngừng bán sản phẩm', `#${req.params.id}`);
    res.json({ ok: true });
  });

  /* ---------- Tin nhắn liên hệ & đánh giá (nhân viên + admin) ---------- */
  r.get('/messages', async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM contact_messages ORDER BY is_handled, created_at DESC LIMIT 200');
    res.json(rows);
  });
  r.patch('/messages/:id', async (req, res) => {
    await pool.query('UPDATE contact_messages SET is_handled = ? WHERE id = ?', [!!(req.body && req.body.is_handled), req.params.id]);
    res.json({ ok: true });
  });

  r.get('/reviews', async (req, res) => {
    const [rows] = await pool.query(`
      SELECT r.id, r.rating, r.content, r.created_at, p.name AS product, COALESCE(u.full_name, 'Khách hàng') AS author
      FROM reviews r JOIN products p ON p.id = r.product_id LEFT JOIN users u ON u.id = r.user_id
      ORDER BY r.created_at DESC LIMIT 200`);
    res.json(rows);
  });
  r.delete('/reviews/:id', async (req, res) => {
    await pool.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  /* ---------- Mã giảm giá (admin) ---------- */
  r.get('/coupons', ADMIN_ONLY, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM coupons ORDER BY is_active DESC, code');
    res.json(rows);
  });
  r.post('/coupons', ADMIN_ONLY, async (req, res) => {
    const b = req.body || {};
    const code = str(b.code, 30).toUpperCase(), type = b.type, value = Number(b.value || 0), minOrder = Number(b.minOrder || 0);
    if (!/^[A-Z0-9]{3,30}$/.test(code)) return bad(res, 'Mã chỉ gồm chữ in hoa và số (3–30 ký tự).');
    if (!['percent', 'fixed', 'freeship'].includes(type)) return bad(res, 'Loại mã không hợp lệ.');
    if (type === 'percent' && !(value >= 1 && value <= 100)) return bad(res, 'Phần trăm giảm từ 1 đến 100.');
    if (type === 'fixed' && !(value > 0)) return bad(res, 'Số tiền giảm phải lớn hơn 0.');
    try {
      await pool.query('INSERT INTO coupons (code, type, value, min_order, description, ends_at, usage_limit) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [code, type, type === 'freeship' ? 0 : value, minOrder, str(b.description, 150) || null, b.endsAt || null, b.usageLimit ? Number(b.usageLimit) : null]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return bad(res, 'Mã này đã tồn tại.', 409);
      throw e;
    }
    await log(req, 'Tạo mã giảm giá', code);
    res.status(201).json({ ok: true });
  });
  r.patch('/coupons/:code', ADMIN_ONLY, async (req, res) => {
    const on = !!(req.body && req.body.is_active);
    await pool.query('UPDATE coupons SET is_active = ? WHERE code = ?', [on, req.params.code]);
    await log(req, on ? 'Bật mã giảm giá' : 'Tắt mã giảm giá', req.params.code);
    res.json({ ok: true });
  });

  /* ---------- Tài khoản (admin) ---------- */
  r.get('/users', ADMIN_ONLY, async (req, res) => {
    const [rows] = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.phone, u.role, u.is_active, u.created_at,
             (SELECT COUNT(*) FROM orders WHERE user_id = u.id) AS orders
      FROM users u ORDER BY FIELD(u.role, 'admin', 'staff', 'customer'), u.id`);
    res.json(rows);
  });
  r.post('/users', ADMIN_ONLY, async (req, res) => {
    const b = req.body || {};
    const fullName = str(b.fullName, 100), email = str(b.email, 150).toLowerCase(), role = b.role;
    const password = typeof b.password === 'string' ? b.password : '';
    if (fullName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return bad(res, 'Cần nhập họ tên và email hợp lệ.');
    if (!['customer', 'staff', 'admin'].includes(role)) return bad(res, 'Vai trò không hợp lệ.');
    if (password.length < 8) return bad(res, 'Mật khẩu tạm cần ít nhất 8 ký tự.');
    try {
      await pool.query('INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
        [fullName, email, str(b.phone, 15) || null, hashPassword(password), role]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return bad(res, 'Email đã tồn tại.', 409);
      throw e;
    }
    await log(req, 'Tạo tài khoản', `${email} (${role})`);
    res.status(201).json({ ok: true });
  });
  r.patch('/users/:id', ADMIN_ONLY, async (req, res) => {
    const id = Number(req.params.id);
    const { role, is_active } = req.body || {};
    if (id === req.user.id) return bad(res, 'Không thể tự đổi vai trò hoặc khóa chính tài khoản đang đăng nhập.');
    if (role !== undefined && !['customer', 'staff', 'admin'].includes(role)) return bad(res, 'Vai trò không hợp lệ.');
    await pool.query('UPDATE users SET role = COALESCE(?, role), is_active = COALESCE(?, is_active) WHERE id = ?',
      [role ?? null, is_active === undefined ? null : !!is_active, id]);
    const [[u]] = await pool.query('SELECT email FROM users WHERE id = ?', [id]);
    await log(req, 'Sửa tài khoản', `${u ? u.email : '#' + id}: ${role ? 'vai trò ' + role : ''}${is_active === undefined ? '' : is_active ? 'mở khóa' : 'khóa'}`);
    res.json({ ok: true });
  });

  /* ---------- Giao dịch ngân hàng (SePay) ---------- */
  r.get('/bank-transactions', async (req, res) => {
    const [rows] = await pool.query(`SELECT t.*, o.order_code FROM bank_transactions t LEFT JOIN orders o ON o.id = t.order_id ORDER BY t.id DESC LIMIT 200`);
    res.json({ rows, webhook: !!process.env.SEPAY_API_KEY });
  });
  // Mô phỏng "tiền về tài khoản" để demo khi chưa đưa web lên mạng (SePay chưa gọi tới được)
  r.post('/bank-simulate', ADMIN_ONLY, async (req, res) => {
    const amount = Math.round(Number(req.body && req.body.amount));
    const content = str(req.body && req.body.content, 255);
    if (!(amount > 0) || !content) return bad(res, 'Nhập số tiền và nội dung chuyển khoản.');
    const out = await receiveTransfer({ gateway: 'Mô phỏng (admin)', amount, content });
    await log(req, 'Mô phỏng tiền về', `${amount}₫ — ${content}${out.matched ? ` → ${out.matched}` : ''}`);
    res.json(out);
  });

  r.get('/logs', ADMIN_ONLY, async (req, res) => {
    const [rows] = await pool.query(`SELECT l.action, l.detail, l.created_at, COALESCE(u.full_name, '—') AS by_name, u.role
      FROM admin_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 300`);
    res.json(rows);
  });

  r.get('/newsletter', ADMIN_ONLY, async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM newsletter_subscribers ORDER BY created_at DESC');
    res.json(rows);
  });

  return r;
};