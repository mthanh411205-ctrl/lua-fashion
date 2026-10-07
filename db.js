// Kết nối MySQL + mật khẩu + kiểm tra quyền — dùng chung cho server.js và admin-api.js
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lua_fashion',
  charset: 'utf8mb4',
  decimalNumbers: true,        // DECIMAL trả về number thay vì chuỗi
  dateStrings: true,
  connectionLimit: 10
});

// Mật khẩu: scrypt có sẵn trong Node, không cần thư viện ngoài
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [algo, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Middleware phân quyền.
   auth()                    -> phải đăng nhập (vai trò bất kỳ)
   auth('staff', 'admin')    -> chỉ nhân viên hoặc admin
   Đọc lại user từ CSDL mỗi lần để khóa tài khoản / đổi vai trò có hiệu lực ngay. */
function auth(...roles) {
  return async (req, res, next) => {
    const id = req.session.userId;
    if (!id) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
    const [[user]] = await pool.query('SELECT id, full_name, email, phone, role, is_active FROM users WHERE id = ?', [id]);
    if (!user || !user.is_active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Tài khoản không tồn tại hoặc đã bị khóa.' });
    }
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này.' });
    req.user = user;
    next();
  };
}

module.exports = { pool, hashPassword, verifyPassword, auth };
