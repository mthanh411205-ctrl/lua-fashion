# LỤA — Website bán thời trang nữ (bản động)

Giao diện: **HTML, CSS, JavaScript** · Máy chủ: **Node.js + Express** · Cơ sở dữ liệu: **MySQL**

Mọi dữ liệu (sản phẩm, tồn kho, đơn hàng, đánh giá, tài khoản) được đọc/ghi trực tiếp từ MySQL. Admin sửa giá hoặc thêm sản phẩm thì trang web đổi ngay, không cần sửa file HTML.

---

## 1. Cấu trúc dự án

```
lua/
├── server.js          Máy chủ: API công khai, đăng nhập, đặt hàng, chèn SEO cho trang chi tiết
├── admin-api.js       API quản trị (nhân viên + admin), có kiểm tra quyền từng thao tác
├── db.js              Kết nối MySQL, băm mật khẩu, middleware phân quyền auth()
├── database.sql       Tạo database lua_fashion: 12 bảng, trigger, view, dữ liệu mẫu
├── package.json       Danh sách thư viện (express, express-session, mysql2)
├── .env.example       Mẫu cấu hình kết nối MySQL → sao chép thành .env
└── public/            Mọi thứ trình duyệt tải về
    ├── *.html         14 trang (chỉ chứa phần nội dung chính)
    ├── style.css
    ├── og-image.png   Ảnh hiện khi chia sẻ link lên Facebook/Zalo
    └── js/
        ├── app.js       Dùng chung: gọi API, giỏ hàng, yêu thích, vừa xem, xem nhanh, skeleton
        ├── layout.js    Header + mega menu, tìm kiếm toàn màn hình, footer, liên hệ nổi, popup nhận tin
        ├── home.js  shop.js  product.js  cart.js  checkout.js  contact.js
        ├── auth.js      Đăng nhập / đăng ký
        ├── account.js   Tài khoản khách hàng
        ├── wishlist.js  Trang yêu thích + lookbook
        └── admin.js     Trang quản trị
```

> Menu và footer nằm trong **`public/js/layout.js`**. Muốn đổi menu thì sửa file này, mọi trang sẽ đổi theo.

---

## 2. Hướng dẫn kết nối (VS Code + MySQL Workbench)

### Bước 1 — Cài phần mềm (làm 1 lần)

| Phần mềm | Tải ở đâu | Ghi chú |
|---|---|---|
| **Node.js 20 LTS trở lên** | nodejs.org → nút "LTS" | Cài xong mở terminal gõ `node -v`, thấy `v20...` hoặc cao hơn là được |
| **MySQL Server 8** | dev.mysql.com/downloads/installer | Khi cài, **ghi nhớ mật khẩu tài khoản `root`** |
| **MySQL Workbench** | Thường cài kèm MySQL Installer | |
| **VS Code** | code.visualstudio.com | |

### Bước 2 — Tạo cơ sở dữ liệu bằng MySQL Workbench

1. Mở **MySQL Workbench**, bấm vào kết nối **Local instance MySQL80**, rồi nhập mật khẩu root.
2. Vào menu **File → Open SQL Script…** và chọn file **`database.sql`** trong thư mục dự án.
3. Bấm nút **⚡ (Execute)** trên thanh công cụ (hoặc `Ctrl + Shift + Enter`).
4. Ở khung **Navigator** bên trái (tab *Schemas*), bấm biểu tượng 🔄 để tải lại. Bạn sẽ thấy database **`lua_fashion`** có 12 bảng.
5. Kiểm tra: mở tab query mới, gõ `SELECT * FROM lua_fashion.products;` rồi chạy. Kết quả phải ra 20 sản phẩm.

> ⚠ Chạy lại `database.sql` sẽ **xóa toàn bộ dữ liệu cũ** và tạo lại từ đầu (dòng `DROP DATABASE`). Chỉ chạy lại khi muốn reset dữ liệu mẫu.

### Bước 3 — Mở dự án trong VS Code

1. **File → Open Folder…**, rồi chọn thư mục `lua`.
2. Mở terminal trong VS Code: menu **Terminal → New Terminal** (hoặc ``Ctrl + ` ``).
3. Cài thư viện (chỉ cần làm 1 lần, cần có mạng):
   ```bash
   npm install
   ```
   Lệnh này tạo thư mục `node_modules/`. Không cần mở hay sửa thư mục đó.

### Bước 4 — Khai báo kết nối MySQL (file `.env`)

1. Trong VS Code, nhấp chuột phải vào **`.env.example`**, chọn **Copy**, rồi **Paste** và đổi tên bản sao thành **`.env`** (dấu chấm ở đầu, không có đuôi).
2. Mở `.env` rồi sửa dòng mật khẩu cho đúng mật khẩu root bạn đặt ở Bước 1:
   ```
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=mat_khau_root_cua_ban
   DB_NAME=lua_fashion
   SESSION_SECRET=go-mot-chuoi-ngau-nhien-dai-bat-ky
   PORT=3000
   ```
3. Lưu file (`Ctrl + S`).

> File `.env` chứa mật khẩu nên **không được gửi lên GitHub**. File `.gitignore` đã chặn sẵn.

### Bước 5 — Chạy website

```bash
npm run dev
```

Nếu thấy dòng này là đã kết nối thành công:

```
✔ Đã kết nối MySQL (20 sản phẩm). Mở trình duyệt: http://localhost:3000
```

Mở trình duyệt và vào **http://localhost:3000**.

- `npm run dev` tự khởi động lại server khi bạn sửa file `.js` ở thư mục gốc. Sửa HTML/CSS trong `public/` thì chỉ cần tải lại trang (F5).
- Dừng server: bấm `Ctrl + C` trong terminal.
- **Không mở file HTML trực tiếp** (nhấp đúp hoặc dùng Live Server). Trang cần server Node để lấy dữ liệu, nên luôn vào qua `http://localhost:3000`.

### Bước 6 — Xem dữ liệu thay đổi trong Workbench

Đặt thử một đơn hàng trên web, rồi chạy trong Workbench:

```sql
USE lua_fashion;
SELECT * FROM orders ORDER BY id DESC;                  -- đơn mới nhất ở trên
SELECT * FROM order_items WHERE order_id = 5;           -- chi tiết đơn
SELECT * FROM v_low_stock;                              -- tồn kho đã bị trừ tự động
SELECT * FROM contact_messages;                         -- tin nhắn từ trang Liên hệ
```

### Gặp lỗi khi chạy `npm run dev`

| Thông báo | Cách sửa |
|---|---|
| `ECONNREFUSED` | MySQL chưa chạy. Mở Windows **Services**, tìm **MySQL80** rồi bấm **Start**. Hoặc kiểm tra lại `DB_PORT`. |
| `ER_ACCESS_DENIED_ERROR` | Sai `DB_USER` hoặc `DB_PASSWORD` trong `.env`. |
| `ER_BAD_DB_ERROR` | Chưa chạy `database.sql` (xem Bước 2). |
| `node: bad option: --env-file` | Node quá cũ. Cài Node 20 LTS trở lên. |
| `EADDRINUSE :::3000` | Cổng 3000 đang bị chương trình khác dùng. Đổi `PORT=3001` trong `.env`. |
| `'npm' is not recognized` | Cài Node.js xong cần **đóng và mở lại VS Code**. |

---

## 3. Tài khoản mẫu

| Vai trò | Email | Mật khẩu |
|---|---|---|
| Quản trị viên | admin@lua.vn | Admin@123 |
| Nhân viên | nhanvien@lua.vn | Staff@123 |
| Khách hàng | hoa.nguyen@example.com | Khach@123 |

Trang đăng nhập có khối "Tài khoản mẫu" để bấm điền nhanh. **Xóa khối đó trong `public/dangnhap.html` và đổi mật khẩu các tài khoản trên trước khi đưa web lên mạng.**

---

## 4. Phân quyền

| Chức năng | Khách vãng lai | Khách hàng | Nhân viên | Admin |
|---|:-:|:-:|:-:|:-:|
| Xem sản phẩm, giỏ hàng, đặt hàng | ✔ | ✔ | ✔ | ✔ |
| Xem & hủy đơn *của mình* (khi còn "Chờ xác nhận") | | ✔ | | |
| Viết đánh giá (1 lần / sản phẩm) | | ✔ | | |
| Vào trang Quản trị | | | ✔ | ✔ |
| Xử lý đơn hàng (đổi trạng thái, thanh toán) | | | ✔ | ✔ |
| Cập nhật tồn kho | | | ✔ | ✔ |
| Đọc tin nhắn liên hệ, xóa đánh giá xấu | | | ✔ | ✔ |
| Xem doanh thu | | | | ✔ |
| Thêm / sửa / ngừng bán sản phẩm, đổi giá | | | | ✔ |
| Tạo & tắt mã giảm giá | | | | ✔ |
| Tạo tài khoản nhân viên, đổi vai trò, khóa tài khoản | | | | ✔ |
| Xem danh sách đăng ký nhận tin | | | | ✔ |

**Quyền được kiểm tra ở server, không chỉ ẩn nút trên giao diện.** Middleware `auth('staff', 'admin')` trong `db.js` đọc lại tài khoản từ MySQL ở mỗi yêu cầu. Nhờ vậy khi admin khóa tài khoản hoặc đổi vai trò, thay đổi có hiệu lực ngay. Trang `admin.html` cũng bị chặn ở server: người không đủ quyền bị chuyển về trang đăng nhập.

**Các biện pháp bảo mật khác:**
- Mật khẩu được băm bằng `scrypt` (có sẵn trong Node), không lưu mật khẩu gốc.
- Mọi câu SQL dùng tham số `?` để chống SQL injection.
- Giá, mã giảm giá và phí ship do **server tính lại** khi đặt hàng. Người dùng sửa giá trong trình duyệt cũng không có tác dụng.
- Đặt hàng chạy trong transaction, và trigger MySQL chặn việc bán quá số tồn kho.

---

## 5. Tính năng

| Tính năng | Ở đâu |
|---|---|
| Đăng nhập / đăng ký, 3 vai trò | `dangnhap.html`, `taikhoan.html`, `admin.html` |
| Danh sách yêu thích | Nút ♥ trên mọi sản phẩm, trang `yeuthich.html` |
| Xem nhanh (quick view) | Rê chuột lên ảnh sản phẩm, bấm "Xem nhanh" |
| Đánh giá sản phẩm (lấy từ bảng `reviews`) | Trang chi tiết: điểm trung bình, biểu đồ số sao, nhãn "Đã mua hàng" |
| Sản phẩm vừa xem | Trang chủ và trang chi tiết |
| Lookbook / editorial | `lookbook.html`, khối giới thiệu trên trang chủ |
| Popup nhận tin (sau 15 giây, hiện 1 lần) + form ở footer | Lưu vào bảng `newsletter_subscribers` |
| Khối Instagram | Trang chủ (ảnh minh họa, xem ghi chú bên dưới) |
| Thanh "Thêm vào giỏ" dính dưới màn hình | Trang chi tiết trên điện thoại |
| Mega menu, tìm kiếm toàn màn hình, nút liên hệ nổi | `layout.js`, có trên mọi trang |
| OG tags + JSON-LD | Mọi trang. Trang chi tiết được server chèn giá, tồn kho, điểm đánh giá theo từng sản phẩm |
| Skeleton loading | Khung xám nhấp nháy trong lúc chờ dữ liệu |
| Size tự khóa khi hết hàng, cảnh báo "Chỉ còn N sản phẩm" | Trang chi tiết, xem nhanh, giỏ hàng |

---

## 6. Ảnh sản phẩm

**Cách 1: tải ảnh lên trong trang Quản trị** (chỉ tài khoản admin)
1. Đăng nhập admin, vào **Quản trị → Sản phẩm & kho**, bấm **Sửa** ở một sản phẩm (hoặc **+ Thêm sản phẩm**).
2. Ở mục **Ảnh sản phẩm**, bấm **Choose File** và chọn ảnh trong máy. Ảnh được tải lên ngay và hiện ở khung xem trước.
3. Bấm **Lưu thay đổi**.

- Nhận ảnh JPG, PNG, WEBP, GIF, tối đa **5MB**. Đẹp nhất là ảnh **dọc tỉ lệ 3:4** (ví dụ 900×1200).
- Ảnh được lưu vào thư mục `public/uploads/`. Khi chép dự án sang máy khác, nhớ chép cả thư mục này.
- Server kiểm tra nội dung file, nên file không phải ảnh thật (dù đổi đuôi `.jpg`) sẽ bị từ chối.

**Cách 2: tự chép ảnh vào dự án**

Chép ảnh vào `public/images/`, rồi trong form sản phẩm dán đường dẫn `/images/ten-anh.jpg` vào ô **"Hoặc dán đường dẫn ảnh"**. Ô này cũng nhận link ảnh trên mạng (`https://…`).

**Ảnh xuất hiện ở đâu:** thẻ sản phẩm, trang chi tiết, xem nhanh, giỏ hàng, tìm kiếm, khối Instagram, ảnh chia sẻ Facebook/Zalo (og:image). Ngoài ra, **thẻ danh mục, banner trang chủ và ảnh lớn trong lookbook** cũng tự lấy ảnh của sản phẩm (ưu tiên sản phẩm nổi bật, bán chạy). Sản phẩm chưa có ảnh vẫn hiện ô màu vải như cũ.

> Đổi ảnh khác thì ảnh cũ vẫn nằm trong `public/uploads/`. Muốn dọn dung lượng, xóa bớt bằng tay.

## 7. Thanh toán chuyển khoản bằng mã QR

Khi khách chọn **Chuyển khoản ngân hàng** ở trang Thanh toán, trang hiện **mã QR chuẩn VietQR**. Khách mở app ngân hàng bất kỳ và quét mã, số tiền cùng nội dung chuyển khoản đã được điền sẵn.

- **Trước khi đặt hàng:** nội dung chuyển khoản là `LUA <số điện thoại>`. Mã QR chỉ hiện sau khi khách chọn khu vực giao hàng, để số tiền đã gồm phí ship.
- **Sau khi bấm Đặt hàng:** trang thành công hiện lại mã QR, lần này nội dung là **mã đơn hàng** (ví dụ `LUA260926-338702`).
- **Nút "Sao chép":** có cho số tài khoản, số tiền và nội dung, dành cho khách không quét được mã.
- **Xác nhận thanh toán:** nhân viên kiểm tra tài khoản ngân hàng, sau đó vào **Quản trị → Đơn hàng** và đổi mục Thanh toán sang **Đã thanh toán**.

**Đổi sang tài khoản thật của bạn:** sửa trong file `.env`, rồi khởi động lại server.

```
BANK_BIN=970436          # mã ngân hàng: Vietcombank 970436 · Techcombank 970407 · MB 970422
                         #   ACB 970416 · BIDV 970418 · VietinBank 970415 · TPBank 970423 · Agribank 970405
BANK_LABEL=Vietcombank   # tên ngân hàng hiện cho khách
BANK_ACCOUNT=0123456789  # số tài khoản
BANK_OWNER=LUA STUDIO    # tên chủ tài khoản (viết không dấu)
```

> Ảnh QR được tạo bởi dịch vụ miễn phí **img.vietqr.io**, nên máy khách cần có Internet. Nếu không tải được ảnh, trang sẽ báo khách chuyển khoản theo thông tin in bên cạnh. Website **không tự biết** khách đã chuyển tiền hay chưa. Muốn tự động xác nhận, cần đăng ký dịch vụ của bên thứ ba (payOS, Casso, SePay…).

## 8. Việc cần làm khi có thêm tài nguyên

- **Instagram thật:** cần token Instagram Graph API của Meta. Hiện khối Instagram hiển thị ảnh minh họa, bấm vào sẽ mở trang @luastudio.vn.
- **Đưa lên mạng:**
  - Phiên đăng nhập đang lưu trong RAM, nên mỗi lần khởi động lại server mọi người phải đăng nhập lại. Khi triển khai thật, dùng `express-mysql-session` để lưu phiên vào MySQL.
  - Cần thêm giới hạn số lần đăng nhập sai (`express-rate-limit`).
- **Email xác nhận đơn / quên mật khẩu:** chưa có. Cần dịch vụ gửi mail (ví dụ `nodemailer` + Gmail SMTP).
