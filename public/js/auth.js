/* Trang Đăng nhập / Đăng ký */
(function () {
  const { $, $$ } = LUA;
  const next = LUA.param('next');
  // Chỉ cho quay về trang trong website (chặn chuyển hướng sang trang lạ)
  const safeNext = next && /^[a-z0-9_\-]+\.html([?#].*)?$/i.test(next) ? next : null;
  const home = (u) => safeNext || (u.role === 'customer' ? 'taikhoan.html' : 'admin.html');

  LUA.me().then((u) => {
    if (!u) return;
    // Khách hàng bị đẩy về đây từ trang quản trị: báo không đủ quyền thay vì chuyển trang (tránh vòng lặp)
    if (u.role === 'customer' && safeNext && safeNext.startsWith('admin.html')) {
      const note = $('#loginForm .form-note');
      note.innerHTML = `Bạn đang đăng nhập bằng tài khoản khách hàng <strong>${LUA.escapeHTML(u.email)}</strong>, không có quyền vào trang quản trị. Hãy đăng nhập bằng tài khoản nhân viên hoặc quản trị. <a href="taikhoan.html">Về tài khoản của tôi</a>`;
      note.hidden = false;
      return;
    }
    location.replace(home(u));
  });

  // Chuyển tab
  function show(tab) {
    $$('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === tab));
    $('#loginForm').hidden = tab !== 'login';
    $('#registerForm').hidden = tab !== 'register';
  }
  $$('[role="tab"]').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  if (location.hash === '#dang-ky') show('register');

  async function submit(form, url, body) {
    const err = form.querySelector('.form-note');
    const btn = form.querySelector('button[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    try {
      const { user } = await LUA.api(url, { method: 'POST', body });
      location.href = home(user);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  }

  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    submit(f, '/api/auth/login', { email: f.email.value, password: f.password.value });
  });

  $('#registerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const err = f.querySelector('.form-note');
    if (f.password.value !== f.confirm.value) {
      err.textContent = 'Mật khẩu nhập lại không khớp.';
      err.hidden = false;
      f.confirm.focus();
      return;
    }
    submit(f, '/api/auth/register', { fullName: f.fullName.value, email: f.email.value, phone: f.phone.value, password: f.password.value });
  });

  // Bấm tài khoản mẫu để điền nhanh (xóa khối này khi đưa web lên mạng thật)
  $$('[data-demo]').forEach((b) => b.addEventListener('click', () => {
    const [email, pw] = b.dataset.demo.split('|');
    show('login');
    $('#loginEmail').value = email;
    $('#loginPassword').value = pw;
    $('#loginForm button[type="submit"]').focus();
  }));
})();
