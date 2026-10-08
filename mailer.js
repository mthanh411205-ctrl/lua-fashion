// Gửi email (xác nhận đơn, mã quên mật khẩu) qua SMTP — cấu hình SMTP_* trong .env.
// Chưa cấu hình SMTP: in nội dung email ra cửa sổ chạy server để vẫn demo được.
const nodemailer = require('nodemailer');

const transport = process.env.SMTP_HOST && process.env.SMTP_USER ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

async function sendMail(to, subject, html) {
  if (!to) return;
  if (!transport) {
    console.log(`✉  [Chưa cấu hình SMTP — email không được gửi thật]\n   Đến: ${to}\n   Tiêu đề: ${subject}\n   ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)}`);
    return;
  }
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html });
  } catch (e) {
    console.error(`✘ Gửi email tới ${to} thất bại: ${e.message}`);   // lỗi email không làm hỏng đơn hàng
  }
}

module.exports = { sendMail };