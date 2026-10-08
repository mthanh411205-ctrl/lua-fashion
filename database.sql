-- =========================================================
--  LỤA — Cơ sở dữ liệu website bán hàng thời trang nữ
--  Hệ quản trị: MySQL 8.0+ (tương thích MariaDB 10.6+)
--  Cách dùng:  MySQL Workbench > File > Open SQL Script > chọn file này > bấm ⚡ (Execute)
--              hoặc dòng lệnh: mysql -u root -p < database.sql
--  Nội dung:
--    1. Tạo database
--    2. Tạo bảng (18 bảng)
--    3. Trigger kiểm tra & trừ tồn kho khi đặt hàng
--    4. View báo cáo
--    5. Dữ liệu mẫu (đồng bộ với js/data.js)
--    6. Một số câu truy vấn mẫu
-- =========================================================

--DROP DATABASE IF EXISTS lua_fashion;
--CREATE DATABASE lua_fashion
--  CHARACTER SET utf8mb4
--  COLLATE utf8mb4_unicode_ci;
-- USE lua_fashion;

-- ---------------------------------------------------------
-- 2. BẢNG
-- ---------------------------------------------------------

-- Danh mục sản phẩm: Áo, Quần, Váy & Đầm, Phụ kiện
CREATE TABLE categories (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug        VARCHAR(50)  NOT NULL UNIQUE,          -- 'ao', 'quan', 'vay', 'phukien'
  name        VARCHAR(100) NOT NULL,
  sort_order  TINYINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- Bảng màu dùng chung
CREATE TABLE colors (
  id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code  VARCHAR(20) NOT NULL UNIQUE,                  -- 'ruou', 'kem', ...
  name  VARCHAR(50) NOT NULL,
  hex   CHAR(7)     NOT NULL
) ENGINE=InnoDB;

-- Sản phẩm
CREATE TABLE products (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sku          VARCHAR(20)  NOT NULL UNIQUE,
  name         VARCHAR(150) NOT NULL,
  category_id  INT UNSIGNED NOT NULL,
  price        DECIMAL(12,0) NOT NULL,                -- giá bán (VNĐ)
  old_price    DECIMAL(12,0) NULL,                    -- giá gốc khi đang giảm giá
  material     VARCHAR(150) NULL,
  description  TEXT NULL,
  badge        VARCHAR(30)  NULL,                     -- 'Bán chạy', 'Mới', ...
  image_url    VARCHAR(255) NULL,                     -- ảnh sản phẩm (để trống = dùng ô màu vải)
  is_featured  BOOLEAN NOT NULL DEFAULT FALSE,
  is_new       BOOLEAN NOT NULL DEFAULT FALSE,
  sold_count   INT UNSIGNED NOT NULL DEFAULT 0,
  status       ENUM('active','hidden','discontinued') NOT NULL DEFAULT 'active',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT chk_products_price CHECK (price > 0),
  CONSTRAINT chk_products_old_price CHECK (old_price IS NULL OR old_price > price),
  INDEX idx_products_category (category_id),
  INDEX idx_products_price (price)
) ENGINE=InnoDB;

-- Biến thể: mỗi tổ hợp (sản phẩm, size, màu) có tồn kho riêng
CREATE TABLE product_variants (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id  INT UNSIGNED NOT NULL,
  size        VARCHAR(20)  NOT NULL,                  -- S, M, L, XL, Free size
  color_id    INT UNSIGNED NOT NULL,
  stock       INT UNSIGNED NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,          -- 0 = size/màu đã bỏ khỏi sản phẩm (giữ lại cho đơn cũ)
  CONSTRAINT fk_variants_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_variants_color   FOREIGN KEY (color_id)   REFERENCES colors(id),
  CONSTRAINT uq_variant UNIQUE (product_id, size, color_id)
) ENGINE=InnoDB;

-- Bộ ảnh sản phẩm: mỗi ảnh có thể gắn với 1 màu (color_code = colors.code, NULL = ảnh chung)
CREATE TABLE product_images (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id  INT UNSIGNED NOT NULL,
  url         VARCHAR(255) NOT NULL,
  color_code  VARCHAR(20)  NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_images_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Tài khoản đăng nhập — một bảng cho cả 3 vai trò
--   customer : khách hàng (tự đăng ký trên web)
--   staff    : nhân viên (admin tạo)
--   admin    : quản trị viên
CREATE TABLE users (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name      VARCHAR(100) NOT NULL,
  email          VARCHAR(150) NOT NULL UNIQUE,
  phone          VARCHAR(15)  NULL,
  address        VARCHAR(255) NULL,                   -- địa chỉ giao hàng gần nhất (tự điền khi đặt hàng)
  region_code    VARCHAR(20)  NULL,                   -- khu vực giao hàng gần nhất
  password_hash  VARCHAR(255) NOT NULL,               -- dạng scrypt$salt$hash, không lưu mật khẩu gốc
  role           ENUM('customer','staff','admin') NOT NULL DEFAULT 'customer',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,       -- FALSE = khóa tài khoản
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- Mã giảm giá
CREATE TABLE coupons (
  code         VARCHAR(30) PRIMARY KEY,
  type         ENUM('percent','fixed','freeship') NOT NULL,
  value        DECIMAL(12,0) NOT NULL DEFAULT 0,      -- % hoặc số tiền
  min_order    DECIMAL(12,0) NOT NULL DEFAULT 0,
  description  VARCHAR(150) NULL,
  starts_at    DATETIME NULL,
  ends_at      DATETIME NULL,
  usage_limit  INT UNSIGNED NULL,                     -- NULL = không giới hạn
  used_count   INT UNSIGNED NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT chk_coupon_percent CHECK (type <> 'percent' OR value BETWEEN 1 AND 100)
) ENGINE=InnoDB;

-- Khu vực giao hàng & phí ship (theo trang Chính sách mua hàng)
CREATE TABLE shipping_regions (
  code       VARCHAR(20) PRIMARY KEY,                 -- 'local', 'big', 'other'
  name       VARCHAR(100) NOT NULL,
  fee        DECIMAL(12,0) NOT NULL,
  free_from  DECIMAL(12,0) NULL,                      -- miễn phí khi đơn >= mức này
  eta        VARCHAR(30) NULL
) ENGINE=InnoDB;

-- Đơn hàng
CREATE TABLE orders (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_code      VARCHAR(20)  NOT NULL UNIQUE,       -- ví dụ LUA260924-1234
  user_id         INT UNSIGNED NULL,                  -- NULL = khách không đăng nhập
  full_name       VARCHAR(100) NOT NULL,
  phone           VARCHAR(15)  NOT NULL,
  email           VARCHAR(150) NULL,
  region_code     VARCHAR(20)  NOT NULL,
  address         VARCHAR(255) NOT NULL,
  note            VARCHAR(500) NULL,
  payment_method  ENUM('cod','bank') NOT NULL,
  payment_status  ENUM('unpaid','paid','refunded') NOT NULL DEFAULT 'unpaid',
  status          ENUM('pending','confirmed','shipping','completed','cancelled','returned') NOT NULL DEFAULT 'pending',
  coupon_code     VARCHAR(30)  NULL,
  subtotal        DECIMAL(12,0) NOT NULL DEFAULT 0,
  discount        DECIMAL(12,0) NOT NULL DEFAULT 0,
  shipping_fee    DECIMAL(12,0) NOT NULL DEFAULT 0,
  total           DECIMAL(12,0) NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_orders_region   FOREIGN KEY (region_code) REFERENCES shipping_regions(code),
  CONSTRAINT fk_orders_coupon   FOREIGN KEY (coupon_code) REFERENCES coupons(code),
  CONSTRAINT chk_orders_cod CHECK (payment_method <> 'cod' OR total < 5000000),   -- COD chỉ cho đơn < 5 triệu
  INDEX idx_orders_status (status),
  INDEX idx_orders_created (created_at)
) ENGINE=InnoDB;

-- Chi tiết đơn hàng (lưu lại tên, giá tại thời điểm mua)
CREATE TABLE order_items (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id      INT UNSIGNED NOT NULL,
  variant_id    INT UNSIGNED NOT NULL,
  product_name  VARCHAR(150) NOT NULL,
  size          VARCHAR(20)  NOT NULL,
  color_name    VARCHAR(50)  NOT NULL,
  unit_price    DECIMAL(12,0) NOT NULL,
  quantity      SMALLINT UNSIGNED NOT NULL,
  line_total    DECIMAL(12,0) AS (unit_price * quantity) STORED,
  CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_items_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id),
  CONSTRAINT chk_items_qty CHECK (quantity BETWEEN 1 AND 10)
) ENGINE=InnoDB;

-- Đánh giá sản phẩm
CREATE TABLE reviews (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id   INT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED NULL,
  rating       TINYINT UNSIGNED NOT NULL,
  content      VARCHAR(1000) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reviews_product  FOREIGN KEY (product_id)  REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT uq_review_once UNIQUE (product_id, user_id),          -- mỗi người đánh giá 1 lần / sản phẩm
  CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB;

-- Tin nhắn từ form Liên hệ
CREATE TABLE contact_messages (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name   VARCHAR(100) NOT NULL,
  phone       VARCHAR(15)  NOT NULL,
  email       VARCHAR(150) NULL,
  message     TEXT NOT NULL,
  is_handled  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Email đăng ký nhận tin (popup newsletter + footer)
CREATE TABLE newsletter_subscribers (
  email       VARCHAR(150) PRIMARY KEY,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Mã đặt lại mật khẩu (quên mật khẩu): lưu dạng băm, hết hạn sau 15 phút, tối đa 5 lần nhập sai
CREATE TABLE password_resets (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  code_hash   VARCHAR(255) NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  CONSTRAINT fk_resets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Lịch sử trạng thái đơn hàng (hiện dạng dòng thời gian cho khách & nhân viên)
CREATE TABLE order_status_history (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id    INT UNSIGNED NOT NULL,
  status      VARCHAR(20)  NOT NULL,
  note        VARCHAR(255) NULL,
  changed_by  INT UNSIGNED NULL,                        -- NULL = khách vãng lai / hệ thống (SePay)
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_history_order FOREIGN KEY (order_id)   REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_history_user  FOREIGN KEY (changed_by) REFERENCES users(id)  ON DELETE SET NULL
) ENGINE=InnoDB;

-- Giao dịch tiền vào tài khoản ngân hàng (SePay báo về hoặc admin mô phỏng) — ghép tự động với đơn chuyển khoản
CREATE TABLE bank_transactions (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sepay_id    BIGINT UNSIGNED NULL UNIQUE,              -- mã giao dịch của SePay, chống ghi trùng khi SePay gửi lại
  gateway     VARCHAR(50)  NOT NULL,                    -- ngân hàng / nguồn
  amount      DECIMAL(12,0) NOT NULL,
  content     VARCHAR(255) NULL,                        -- nội dung chuyển khoản, vd "LUA 0901234567"
  phone       VARCHAR(15)  NULL,                        -- số điện thoại đọc được từ nội dung
  order_id    INT UNSIGNED NULL,                        -- đơn đã ghép (NULL = chưa khớp đơn nào)
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tx_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Nhật ký thao tác của nhân viên/admin (ai sửa gì, lúc nào)
CREATE TABLE admin_logs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NULL,
  action      VARCHAR(50)  NOT NULL,
  detail      VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;
-- Phiên đăng nhập (server.js đọc/ghi) — khởi động lại server không bị đăng xuất
CREATE TABLE sessions (
  session_id  VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  expires     INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT COLLATE utf8mb4_bin
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- 3. TRIGGER: kiểm tra tồn kho, trừ kho, cộng lượt bán
-- ---------------------------------------------------------
DELIMITER //

CREATE TRIGGER trg_order_items_before_insert
BEFORE INSERT ON order_items
FOR EACH ROW
BEGIN
  DECLARE v_stock INT;
  SELECT stock INTO v_stock FROM product_variants WHERE id = NEW.variant_id FOR UPDATE;
  IF v_stock IS NULL OR v_stock < NEW.quantity THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Không đủ hàng tồn kho cho sản phẩm này';
  END IF;
END//

CREATE TRIGGER trg_order_items_after_insert
AFTER INSERT ON order_items
FOR EACH ROW
BEGIN
  UPDATE product_variants SET stock = stock - NEW.quantity WHERE id = NEW.variant_id;
  UPDATE products p
    JOIN product_variants v ON v.product_id = p.id
     SET p.sold_count = p.sold_count + NEW.quantity
   WHERE v.id = NEW.variant_id;
END//

-- Khi đơn bị hủy: hoàn lại tồn kho
CREATE TRIGGER trg_orders_after_cancel
AFTER UPDATE ON orders
FOR EACH ROW
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE product_variants v
      JOIN order_items i ON i.variant_id = v.id
       SET v.stock = v.stock + i.quantity
     WHERE i.order_id = NEW.id;
  END IF;
END//

DELIMITER ;

-- ---------------------------------------------------------
-- 4. VIEW
-- ---------------------------------------------------------

-- Danh sách sản phẩm hiển thị trên trang Sản phẩm
CREATE VIEW v_product_list AS
SELECT p.id, p.sku, p.name, c.slug AS category, c.name AS category_name,
       p.price, p.old_price,
       CASE WHEN p.old_price IS NULL THEN 0
            ELSE ROUND((1 - p.price / p.old_price) * 100) END AS discount_percent,
       p.badge, p.is_featured, p.is_new, p.sold_count,
       COALESCE(SUM(v.stock), 0) AS total_stock
FROM products p
JOIN categories c ON c.id = p.category_id
LEFT JOIN product_variants v ON v.product_id = p.id
WHERE p.status = 'active'
GROUP BY p.id, p.sku, p.name, c.slug, c.name, p.price, p.old_price, p.badge, p.is_featured, p.is_new, p.sold_count;

-- Doanh thu theo tháng (không tính đơn hủy/trả)
CREATE VIEW v_revenue_by_month AS
SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       COUNT(*)      AS order_count,
       SUM(total)    AS revenue,
       ROUND(AVG(total)) AS avg_order_value
FROM orders
WHERE status NOT IN ('cancelled','returned')
GROUP BY DATE_FORMAT(created_at, '%Y-%m');

-- Biến thể sắp hết hàng (tồn <= 3)
CREATE VIEW v_low_stock AS
SELECT p.sku, p.name, v.size, co.name AS color, v.stock
FROM product_variants v
JOIN products p ON p.id = v.product_id
JOIN colors co  ON co.id = v.color_id
WHERE v.stock <= 3
ORDER BY v.stock, p.sku;
-- ---------------------------------------------------------
-- 5. DỮ LIỆU MẪU (sinh tự động từ js/data.js)
-- ---------------------------------------------------------

INSERT INTO categories (slug, name, sort_order) VALUES
  ('ao', 'Áo', 1),
  ('quan', 'Quần', 2),
  ('vay', 'Váy & Đầm', 3),
  ('phukien', 'Phụ kiện', 4);

INSERT INTO colors (code, name, hex) VALUES
  ('ruou', 'Đỏ rượu', '#6b2737'),
  ('kem', 'Kem', '#e8dcc4'),
  ('den', 'Đen', '#1c1a17'),
  ('reu', 'Xanh rêu', '#43533f'),
  ('than', 'Xanh than', '#33454f'),
  ('nghe', 'Vàng nghệ', '#c99a4b'),
  ('nau', 'Nâu bò', '#9c7b56'),
  ('gach', 'Đỏ gạch', '#8a3b3b'),
  ('trang', 'Trắng ngà', '#f4efe4');

INSERT INTO products (id, sku, name, category_id, price, old_price, material, description, badge, is_featured, is_new, sold_count, created_at) VALUES
  (1, 'LUA-A001', 'Áo sơ mi lụa tay bồng', 1, 890000, NULL, '100% lụa tơ tằm Bảo Lộc', 'Sơ mi lụa mềm rủ với tay bồng nhẹ và cổ đức nhỏ. Mặc sơ vin với quần âu đi làm hoặc thả dáng cùng chân váy cho buổi hẹn cuối tuần.', 'Bán chạy', TRUE, FALSE, 312, '2026-04-15 09:00:00'),
  (2, 'LUA-V001', 'Chân váy midi xếp ly', 3, 720000, NULL, 'Voan lụa hai lớp, lót satin', 'Chân váy xếp ly dập máy dài qua gối, cạp chun sau giúp dễ mặc. Ly giữ nếp tốt sau nhiều lần giặt.', NULL, TRUE, FALSE, 205, '2026-05-15 09:00:00'),
  (3, 'LUA-A002', 'Blazer len caro', 1, 1450000, NULL, 'Len pha 70% wool, lót lụa', 'Blazer dáng suông, vai đệm mỏng, họa tiết caro trầm. Một món đầu tư mặc được suốt mùa thu đông.', 'Hết size S', TRUE, FALSE, 118, '2026-06-15 09:00:00'),
  (4, 'LUA-Q001', 'Quần âu ống suông', 2, 650000, NULL, 'Tuyết mưa co giãn nhẹ', 'Quần âu cạp cao, ống suông dài chạm gót giúp tôn dáng. Có túi chéo hai bên và đỉa đeo thắt lưng.', NULL, TRUE, FALSE, 274, '2026-07-15 09:00:00'),
  (5, 'LUA-V002', 'Đầm hai dây linen', 3, 780000, NULL, '100% linen Hà Lan', 'Đầm hai dây dáng suông, dây điều chỉnh được, xẻ nhẹ tà sau. Linen thoáng mát, càng giặt càng mềm.', 'Mới', FALSE, TRUE, 41, '2026-09-10 09:00:00'),
  (6, 'LUA-A003', 'Áo khoác dạ ngắn', 1, 1690000, NULL, 'Dạ tweed 80% wool', 'Áo khoác dạ dáng lửng, cổ tròn, cài cúc kim loại mạ đồng. Phối cùng quần âu hoặc đầm liền đều đẹp.', 'Mới', FALSE, TRUE, 22, '2026-09-10 09:00:00'),
  (7, 'LUA-A004', 'Áo len cổ lọ', 1, 560000, NULL, 'Len cashmere pha 30%', 'Áo len mỏng cổ lọ ôm vừa người, mặc riêng hoặc làm lớp lót trong blazer, áo khoác dạ.', 'Mới', FALSE, TRUE, 64, '2026-09-10 09:00:00'),
  (8, 'LUA-P001', 'Túi da đeo chéo', 4, 1250000, NULL, 'Da bò thật thuộc thực vật', 'Túi hộp nhỏ đủ để điện thoại, ví và son. Quai da tháo rời, điều chỉnh được độ dài.', 'Mới', FALSE, TRUE, 37, '2026-09-10 09:00:00'),
  (9, 'LUA-P002', 'Khăn lụa họa tiết', 4, 420000, NULL, 'Lụa Hà Đông, in lụa thủ công', 'Khăn vuông 70×70cm, viền cuộn tay. Buộc cổ, buộc tóc hay thắt quai túi đều hợp.', 'Mới', FALSE, TRUE, 58, '2026-09-10 09:00:00'),
  (10, 'LUA-A005', 'Áo thun cotton cổ tròn', 1, 350000, NULL, '100% cotton Supima', 'Áo thun trơn dáng regular, cổ bo dày không bai. Món cơ bản nên có nhiều màu trong tủ.', NULL, FALSE, FALSE, 430, '2026-03-15 09:00:00'),
  (11, 'LUA-Q002', 'Quần jeans ống rộng', 2, 590000, NULL, 'Denim cotton 12oz', 'Jeans cạp cao, ống rộng thẳng, màu wash vừa. Gấu để thô, dễ cắt theo chiều cao.', NULL, FALSE, FALSE, 196, '2026-04-15 09:00:00'),
  (12, 'LUA-Q003', 'Quần short linen', 2, 420000, 560000, '100% linen', 'Quần short cạp chun bản to, dài giữa đùi, có túi hai bên. Hợp đi biển, đi phố mùa hè.', NULL, FALSE, FALSE, 88, '2026-05-15 09:00:00'),
  (13, 'LUA-V003', 'Đầm maxi hoa nhí', 3, 720000, 1200000, 'Lụa lạnh in hoa', 'Đầm maxi cổ V, tay lỡ, chân váy xòe tầng. Họa tiết hoa nhí nhỏ, dễ mặc cho nhiều dáng người.', NULL, TRUE, FALSE, 167, '2026-06-15 09:00:00'),
  (14, 'LUA-V004', 'Đầm suông cổ vuông', 3, 850000, NULL, 'Tafta lụa', 'Đầm suông dài qua gối, cổ vuông, tay phồng nhẹ. Đi làm hay dự tiệc đều ổn.', NULL, FALSE, FALSE, 102, '2026-07-15 09:00:00'),
  (15, 'LUA-V005', 'Chân váy chữ A da lộn', 3, 483000, 690000, 'Da lộn nhân tạo mềm', 'Chân váy chữ A ngắn trên gối, khóa kéo sau. Phối cùng áo len cổ lọ và boots cho mùa lạnh.', NULL, FALSE, FALSE, 76, '2026-03-15 09:00:00'),
  (16, 'LUA-A006', 'Áo croptop len dệt kim', 1, 336000, 480000, 'Len dệt kim cotton', 'Áo len lửng tay ngắn, dệt vặn thừng. Mặc cùng quần cạp cao hoặc chân váy midi.', NULL, FALSE, FALSE, 139, '2026-04-15 09:00:00'),
  (17, 'LUA-Q004', 'Quần culottes lụa', 2, 620000, NULL, 'Lụa satin dày', 'Quần ống rộng dài qua bắp chân, bóng nhẹ, rủ mềm. Thanh lịch khi mặc cùng sơ mi.', NULL, FALSE, FALSE, 93, '2026-05-15 09:00:00'),
  (18, 'LUA-P003', 'Thắt lưng da bản nhỏ', 4, 234000, 390000, 'Da bò, khóa hợp kim', 'Thắt lưng bản 2cm, khóa tròn tối giản. Dùng thắt eo đầm suông hoặc đi cùng quần âu.', NULL, FALSE, FALSE, 151, '2026-06-15 09:00:00'),
  (19, 'LUA-P004', 'Bông tai ngọc trai', 4, 290000, NULL, 'Ngọc trai nước ngọt, chốt bạc 925', 'Bông tai ngọc trai nhỏ 8mm, chốt bạc không gây kích ứng. Hộp quà đi kèm.', NULL, FALSE, FALSE, 244, '2026-07-15 09:00:00'),
  (20, 'LUA-P005', 'Mũ cói vành rộng', 4, 320000, NULL, 'Cói tự nhiên đan tay', 'Mũ cói vành 10cm, quai ruy băng buộc nơ. Gập gọn được khi đi du lịch.', NULL, FALSE, FALSE, 67, '2026-03-15 09:00:00');

INSERT INTO product_variants (id, product_id, size, color_id, stock) VALUES
  (1, 1, 'S', 1, 9),
  (2, 1, 'S', 2, 12),
  (3, 1, 'M', 1, 14),
  (4, 1, 'M', 2, 3),
  (5, 1, 'L', 1, 5),
  (6, 1, 'L', 2, 8),
  (7, 2, 'S', 4, 2),
  (8, 2, 'S', 3, 5),
  (9, 2, 'S', 2, 8),
  (10, 2, 'M', 4, 7),
  (11, 2, 'M', 3, 10),
  (12, 2, 'M', 2, 13),
  (13, 2, 'L', 4, 12),
  (14, 2, 'L', 3, 15),
  (15, 2, 'L', 2, 4),
  (16, 3, 'M', 7, 2),
  (17, 3, 'M', 5, 2),
  (18, 3, 'L', 7, 14),
  (19, 3, 'L', 5, 3),
  (20, 3, 'XL', 7, 5),
  (21, 3, 'XL', 5, 8),
  (22, 4, 'S', 5, 2),
  (23, 4, 'S', 3, 5),
  (24, 4, 'S', 2, 8),
  (25, 4, 'M', 5, 7),
  (26, 4, 'M', 3, 10),
  (27, 4, 'M', 2, 13),
  (28, 4, 'L', 5, 12),
  (29, 4, 'L', 3, 15),
  (30, 4, 'L', 2, 4),
  (31, 4, 'XL', 5, 3),
  (32, 4, 'XL', 3, 6),
  (33, 4, 'XL', 2, 9),
  (34, 5, 'S', 6, 9),
  (35, 5, 'S', 2, 12),
  (36, 5, 'M', 6, 14),
  (37, 5, 'M', 2, 3),
  (38, 5, 'L', 6, 5),
  (39, 5, 'L', 2, 8),
  (40, 6, 'S', 8, 2),
  (41, 6, 'S', 3, 5),
  (42, 6, 'M', 8, 7),
  (43, 6, 'M', 3, 10),
  (44, 6, 'L', 8, 12),
  (45, 6, 'L', 3, 15),
  (46, 7, 'S', 2, 9),
  (47, 7, 'S', 7, 12),
  (48, 7, 'S', 3, 15),
  (49, 7, 'M', 2, 14),
  (50, 7, 'M', 7, 3),
  (51, 7, 'M', 3, 6),
  (52, 7, 'L', 2, 5),
  (53, 7, 'L', 7, 8),
  (54, 7, 'L', 3, 11),
  (55, 8, 'Free size', 7, 2),
  (56, 8, 'Free size', 3, 5),
  (57, 9, 'Free size', 1, 9),
  (58, 9, 'Free size', 4, 12),
  (59, 10, 'S', 9, 2),
  (60, 10, 'S', 3, 5),
  (61, 10, 'S', 4, 8),
  (62, 10, 'M', 9, 7),
  (63, 10, 'M', 3, 10),
  (64, 10, 'M', 4, 13),
  (65, 10, 'L', 9, 12),
  (66, 10, 'L', 3, 15),
  (67, 10, 'L', 4, 4),
  (68, 10, 'XL', 9, 3),
  (69, 10, 'XL', 3, 6),
  (70, 10, 'XL', 4, 9),
  (71, 11, 'S', 5, 9),
  (72, 11, 'M', 5, 14),
  (73, 11, 'L', 5, 5),
  (74, 12, 'S', 2, 2),
  (75, 12, 'S', 4, 5),
  (76, 12, 'M', 2, 7),
  (77, 12, 'M', 4, 10),
  (78, 12, 'L', 2, 12),
  (79, 12, 'L', 4, 15),
  (80, 13, 'S', 1, 9),
  (81, 13, 'S', 4, 12),
  (82, 13, 'M', 1, 14),
  (83, 13, 'M', 4, 3),
  (84, 13, 'L', 1, 5),
  (85, 13, 'L', 4, 8),
  (86, 14, 'S', 3, 2),
  (87, 14, 'S', 5, 5),
  (88, 14, 'M', 3, 7),
  (89, 14, 'M', 5, 10),
  (90, 14, 'L', 3, 12),
  (91, 14, 'L', 5, 15),
  (92, 14, 'XL', 3, 3),
  (93, 14, 'XL', 5, 6),
  (94, 15, 'S', 7, 9),
  (95, 15, 'S', 8, 12),
  (96, 15, 'M', 7, 14),
  (97, 15, 'M', 8, 3),
  (98, 15, 'L', 7, 5),
  (99, 15, 'L', 8, 8),
  (100, 16, 'S', 2, 2),
  (101, 16, 'S', 6, 5),
  (102, 16, 'M', 2, 7),
  (103, 16, 'M', 6, 10),
  (104, 17, 'S', 1, 9),
  (105, 17, 'S', 3, 12),
  (106, 17, 'M', 1, 14),
  (107, 17, 'M', 3, 3),
  (108, 17, 'L', 1, 5),
  (109, 17, 'L', 3, 8),
  (110, 18, 'Free size', 3, 2),
  (111, 18, 'Free size', 7, 5),
  (112, 19, 'Free size', 9, 9),
  (113, 20, 'Free size', 6, 2);

INSERT INTO shipping_regions (code, name, fee, free_from, eta) VALUES
  ('local', 'Nội thành Hội An / Đà Nẵng', 30000, 500000, '1–2 ngày'),
  ('big', 'TP.HCM & Hà Nội', 30000, NULL, '2–4 ngày'),
  ('other', 'Các tỉnh thành khác', 35000, NULL, '3–6 ngày');

INSERT INTO coupons (code, type, value, min_order, description, starts_at, ends_at, usage_limit) VALUES
  ('LUA10', 'percent', 10, 500000, 'Giảm 10% cho đơn từ 500.000₫', '2026-09-01 00:00:00', '2026-12-31 23:59:59', NULL),
  ('CHAOTHU', 'fixed', 50000, 800000, 'Giảm 50.000₫ cho đơn từ 800.000₫', '2026-09-01 00:00:00', '2026-12-31 23:59:59', NULL),
  ('FREESHIP', 'freeship', 0, 0, 'Miễn phí vận chuyển', '2026-09-01 00:00:00', '2026-12-31 23:59:59', 500);

-- Tài khoản mẫu (mật khẩu gốc ghi bên cạnh — ĐỔI trước khi dùng thật)
INSERT INTO users (id, full_name, email, phone, password_hash, role, created_at) VALUES
  (1, 'Quản trị LỤA', 'admin@lua.vn', '0901234567', 'scrypt$0fd478b4da9654259aa3b34785f2094f$f1369265be2dcdaceb0eba309009ad630063f2bb7c189cc9b9af21dafaef4b9b7a31fd04343864c2db1e4aa6b0c4da3269da445a535c6a99887211ea6ca60235', 'admin', '2026-01-05 08:00:00'),
  (2, 'Lê Thị Mai', 'nhanvien@lua.vn', '0905556677', 'scrypt$024b93702722c610dcc6aa7e30d07883$1fedaf93ee80528d4452c4a66a10326cc1a2d2329f7613f8ee1bd7519e3d13f96796e658daf5f87424b2e01d35cf08f132092bb1c7ada6965eae4750d263417b', 'staff', '2026-02-10 08:00:00'),
  (3, 'Nguyễn Thị Hoa', 'hoa.nguyen@example.com', '0901112233', 'scrypt$32c878ddb9cc4a83eac7294af4fcdb21$aa6237884ccdcc9a3d5a33140eca8ccf624271091d8d19afeea7d6cd523f76b46f74f3c6dfd691e138c92a0bf88d053c315e50e423497b183fd4c180f2d21c4c', 'customer', '2026-06-02 10:15:00'),
  (4, 'Trần Minh Anh', 'minhanh.tran@example.com', '0987654321', 'scrypt$56edfe5ee1bd0f3806a2bcee9bd2dabb$ed4724abd80be723f554305be7f84a2b6331300c34e20650c0d3370f8f4e2869f35c6d108497d411a29ef06e08e7999761bb5e3696eb1ed2d852d9aa9c804d83', 'customer', '2026-07-19 20:40:00');
UPDATE users SET address = '25 Lê Lợi, Phường Minh An, Hội An, Quảng Nam', region_code = 'local' WHERE id = 3;
UPDATE users SET address = '88 Nguyễn Thị Minh Khai, Phường Đa Kao, Quận 1, TP.HCM', region_code = 'big' WHERE id = 4;

INSERT INTO orders (id, order_code, user_id, full_name, phone, email, region_code, address, payment_method, payment_status, status, coupon_code, subtotal, discount, shipping_fee, total, created_at) VALUES
  (1, 'LUA260812-4821', 3, 'Nguyễn Thị Hoa', '0901112233', 'hoa.nguyen@example.com', 'local', '25 Lê Lợi, Phường Minh An, Hội An, Quảng Nam', 'cod', 'paid', 'completed', NULL, 1610000, 0, 0, 1610000, '2026-08-12 14:22:00');
INSERT INTO order_items (order_id, variant_id, product_name, size, color_name, unit_price, quantity) VALUES
  (1, 3, 'Áo sơ mi lụa tay bồng', 'M', 'Đỏ rượu', 890000, 1),
  (1, 10, 'Chân váy midi xếp ly', 'M', 'Xanh rêu', 720000, 1);

INSERT INTO orders (id, order_code, user_id, full_name, phone, email, region_code, address, payment_method, payment_status, status, coupon_code, subtotal, discount, shipping_fee, total, created_at) VALUES
  (2, 'LUA260903-1177', 4, 'Trần Minh Anh', '0987654321', 'minhanh.tran@example.com', 'big', '88 Nguyễn Thị Minh Khai, Phường Đa Kao, Quận 1, TP.HCM', 'bank', 'paid', 'shipping', 'LUA10', 2010000, 201000, 30000, 1839000, '2026-09-03 09:05:00');
INSERT INTO order_items (order_id, variant_id, product_name, size, color_name, unit_price, quantity) VALUES
  (2, 16, 'Blazer len caro', 'M', 'Nâu bò', 1450000, 1),
  (2, 49, 'Áo len cổ lọ', 'M', 'Kem', 560000, 1);

INSERT INTO orders (id, order_code, user_id, full_name, phone, email, region_code, address, payment_method, payment_status, status, coupon_code, subtotal, discount, shipping_fee, total, created_at) VALUES
  (3, 'LUA260920-3350', NULL, 'Lê Thu Trang', '0356789012', NULL, 'other', '12 Trần Hưng Đạo, Phường Lê Lợi, TP. Quy Nhơn, Bình Định', 'cod', 'unpaid', 'pending', NULL, 1300000, 0, 35000, 1335000, '2026-09-20 19:48:00');
INSERT INTO order_items (order_id, variant_id, product_name, size, color_name, unit_price, quantity) VALUES
  (3, 81, 'Đầm maxi hoa nhí', 'S', 'Xanh rêu', 720000, 1),
  (3, 112, 'Bông tai ngọc trai', 'Free size', 'Trắng ngà', 290000, 2);

UPDATE coupons SET used_count = 1 WHERE code = 'LUA10';

-- Lịch sử trạng thái cho các đơn mẫu
INSERT INTO order_status_history (order_id, status, note, created_at)
  SELECT id, 'pending', 'Đặt hàng', created_at FROM orders;
INSERT INTO order_status_history (order_id, status, note, created_at)
  SELECT id, status, 'Cập nhật trạng thái', created_at + INTERVAL 1 DAY FROM orders WHERE status <> 'pending';
INSERT INTO newsletter_subscribers (email) VALUES ('hoa.nguyen@example.com');

INSERT INTO reviews (product_id, user_id, rating, content, created_at) VALUES
  (1, 3, 5, 'Lụa mềm, mặc mát, form tay bồng rất xinh. Size M vừa với mình 50kg.', '2026-08-20 21:10:00'),
  (1, 4, 4, 'Màu kem ngoài đời hơi ngả vàng hơn ảnh nhưng vẫn đẹp, đường may kỹ.', '2026-09-05 19:00:00'),
  (1, NULL, 5, 'Mua tặng mẹ, mẹ rất thích. Đóng gói cẩn thận.', '2026-07-11 09:30:00'),
  (2, 3, 4, 'Ly giữ nếp tốt sau khi giặt, màu rêu ngoài đời đẹp hơn ảnh.', '2026-08-21 08:30:00'),
  (3, 4, 5, 'Blazer đứng dáng, lót lụa sờ rất thích. Đáng tiền.', '2026-09-12 12:00:00'),
  (4, NULL, 4, 'Quần dài chạm gót với người cao 1m60, cạp cao tôn dáng.', '2026-06-28 14:20:00'),
  (7, 4, 4, 'Len mỏng, mặc trong blazer vừa đẹp. Hơi xù nhẹ sau vài lần giặt.', '2026-09-15 22:00:00'),
  (10, 4, 5, 'Áo thun dày dặn, cổ không bai. Đã mua thêm màu đen.', '2026-08-02 10:00:00'),
  (13, 3, 5, 'Đầm xòe đẹp, vải lụa lạnh mát, giá sale quá hời.', '2026-09-01 20:45:00'),
  (19, 3, 5, 'Ngọc trai nhỏ xinh, đeo đi làm hằng ngày rất hợp.', '2026-08-25 18:10:00');

INSERT INTO contact_messages (full_name, phone, email, message) VALUES
  ('Phạm Ngọc Lan', '0912345678', 'lan.pham@example.com', 'Mình cao 1m58, nặng 47kg thì nên mặc size S hay M của áo sơ mi lụa tay bồng?');

-- ---------------------------------------------------------
-- 6. TRUY VẤN MẪU (tương ứng với các chức năng trên website)
-- ---------------------------------------------------------

-- 6.1 Đặt hàng trong một TRANSACTION (trang Thanh toán)
--     Nếu một sản phẩm hết hàng, trigger báo lỗi và toàn bộ đơn được ROLLBACK.
START TRANSACTION;
  INSERT INTO orders (order_code, full_name, phone, region_code, address, payment_method, shipping_fee)
  VALUES ('LUA260924-0001', 'Võ Hải Yến', '0773456789', 'big', '15 Hàng Bông, Phường Hàng Gai, Quận Hoàn Kiếm, Hà Nội', 'cod', 30000);
  SET @order_id = LAST_INSERT_ID();

  -- Lấy biến thể trước (không INSERT ... SELECT trực tiếp từ product_variants
  -- vì trigger cũng cập nhật bảng này), rồi thêm từng dòng chi tiết đơn.
  -- Quần âu ống suông, size M, xanh than
  SELECT v.id, p.name, co.name, p.price INTO @vid, @pname, @cname, @price
  FROM product_variants v JOIN products p ON p.id = v.product_id JOIN colors co ON co.id = v.color_id
  WHERE p.sku = 'LUA-Q001' AND v.size = 'M' AND co.code = 'than';
  INSERT INTO order_items (order_id, variant_id, product_name, size, color_name, unit_price, quantity)
  VALUES (@order_id, @vid, @pname, 'M', @cname, @price, 1);

  -- Áo thun cotton cổ tròn, size S, trắng ngà
  SELECT v.id, p.name, co.name, p.price INTO @vid, @pname, @cname, @price
  FROM product_variants v JOIN products p ON p.id = v.product_id JOIN colors co ON co.id = v.color_id
  WHERE p.sku = 'LUA-A005' AND v.size = 'S' AND co.code = 'trang';
  INSERT INTO order_items (order_id, variant_id, product_name, size, color_name, unit_price, quantity)
  VALUES (@order_id, @vid, @pname, 'S', @cname, @price, 1);

  -- Tính tổng tiền từ chi tiết đơn
  UPDATE orders
     SET subtotal = (SELECT SUM(line_total) FROM order_items WHERE order_id = @order_id),
         total    = (SELECT SUM(line_total) FROM order_items WHERE order_id = @order_id) + shipping_fee - discount
   WHERE id = @order_id;
COMMIT;

-- 6.2 Trang Sản phẩm: lọc danh mục "Váy & Đầm", giá 500.000–1.000.000₫, sắp xếp giá tăng dần
SELECT id, name, price, old_price, discount_percent
FROM v_product_list
WHERE category = 'vay' AND price >= 500000 AND price < 1000000
ORDER BY price ASC;

-- 6.3 Tìm kiếm theo tên (ô tìm kiếm) — collation utf8mb4_unicode_ci không phân biệt hoa/thường
SELECT id, name, price FROM v_product_list WHERE name LIKE '%lụa%';

-- 6.4 Lọc theo size còn hàng: sản phẩm có size M còn tồn kho
SELECT DISTINCT p.id, p.name, p.price
FROM products p
JOIN product_variants v ON v.product_id = p.id
WHERE v.size = 'M' AND v.stock > 0 AND p.status = 'active'
ORDER BY p.id;

-- 6.5 Trang Chi tiết: size & màu còn hàng của sản phẩm id = 1
SELECT v.size, co.name AS color, co.hex, v.stock
FROM product_variants v JOIN colors co ON co.id = v.color_id
WHERE v.product_id = 1
ORDER BY FIELD(v.size, 'S','M','L','XL','Free size'), co.name;

-- 6.6 Điểm đánh giá trung bình theo sản phẩm
SELECT p.name, ROUND(AVG(r.rating), 1) AS avg_rating, COUNT(r.id) AS review_count
FROM products p JOIN reviews r ON r.product_id = p.id
GROUP BY p.id, p.name
ORDER BY avg_rating DESC;

-- 6.7 Top 5 sản phẩm bán chạy
SELECT name, category_name, sold_count FROM v_product_list ORDER BY sold_count DESC LIMIT 5;

-- 6.8 Xem chi tiết một đơn hàng
SELECT o.order_code, o.full_name, o.status, i.product_name, i.size, i.color_name, i.quantity, i.line_total, o.total
FROM orders o JOIN order_items i ON i.order_id = o.id
WHERE o.order_code = 'LUA260903-1177';

-- 6.9 Doanh thu theo tháng & sản phẩm sắp hết hàng
SELECT * FROM v_revenue_by_month ORDER BY month;
SELECT * FROM v_low_stock LIMIT 10;

-- 6.10 Tồn kho theo danh mục
SELECT c.name AS category, SUM(v.stock) AS total_stock, COUNT(DISTINCT p.id) AS products
FROM categories c
JOIN products p ON p.category_id = c.id
JOIN product_variants v ON v.product_id = p.id
GROUP BY c.id, c.name
ORDER BY c.sort_order;