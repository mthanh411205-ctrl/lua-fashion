/* =========================================================
   LỤA — JavaScript dùng chung cho mọi trang
   - Gọi API (fetch) và nạp danh mục sản phẩm từ MySQL
   - Giỏ hàng, yêu thích, sản phẩm vừa xem (localStorage)
   - Thẻ sản phẩm, xem nhanh (quick view), khung chờ (skeleton), thông báo
   ========================================================= */

// Được điền sau khi gọi /api/catalog (xem LUA.ready)
let CATEGORIES = [], COLORS = {}, PRODUCTS = [], SHIPPING_REGIONS = {}, BANK = null;
const COD_LIMIT = 5000000;

// Chế độ sáng/tối người dùng đã chọn (nút trên header) — áp dụng sớm để không bị nháy màu
try { const t = localStorage.getItem('lua_theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* bỏ qua */ }

const LUA = (function () {
  'use strict';

  /* ---------- Lưu trữ an toàn ---------- */
  const memory = {};
  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
      catch (e) { return key in memory ? memory[key] : fallback; }
    },
    set(key, value) {
      memory[key] = value;
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* bỏ qua */ }
    },
    remove(key) {
      delete memory[key];
      try { localStorage.removeItem(key); } catch (e) { /* bỏ qua */ }
    }
  };

  /* ---------- Gọi API ---------- */
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Không kết nối được máy chủ.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Danh mục sản phẩm: nạp 1 lần cho mỗi trang
  const ready = api('/api/catalog').then((d) => {
    CATEGORIES = d.categories; COLORS = d.colors; PRODUCTS = d.products; SHIPPING_REGIONS = d.regions; BANK = d.bank;
    return d;
  });
  ready.catch((e) => toast(`Không tải được dữ liệu: ${escapeHTML(e.message)}`));

  // Người dùng đang đăng nhập (hoặc null)
  let mePromise;
  const me = (refresh) => {
    if (!mePromise || refresh) mePromise = api('/api/auth/me').then((r) => r.user).catch(() => null);
    return mePromise;
  };

  /* ---------- Tiện ích ---------- */
  const money = (n) => Math.round(n).toLocaleString('vi-VN') + '₫';
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const param = (name) => new URLSearchParams(location.search).get(name);
  // Bỏ dấu tiếng Việt để tìm "ao so mi" vẫn ra "Áo sơ mi"
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

  const getProduct = (id) => PRODUCTS.find((p) => p.id === Number(id));
  const categoryName = (id) => (CATEGORIES.find((c) => c.id === id) || {}).name || '';
  const discountPercent = (p) => (p.oldPrice ? Math.round((1 - p.price / p.oldPrice) * 100) : 0);
  const stockOf = (p, size, color) => (p.stock || {})[`${size}|${color}`] ?? 0;
  const colorName = (c) => (COLORS[c] ? COLORS[c].name : c);

  function isLight(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 170;
  }

  /* Hình dáng sản phẩm dạng nét vẽ — dùng khi sản phẩm chưa có ảnh (image_url) */
  const SILHOUETTES = {
    ao:      '<path d="M37 18 L24 23 L10 42 L20 50 L28 42 L28 112 L72 112 L72 42 L80 50 L90 42 L76 23 L63 18 Q50 30 37 18 Z"/><path d="M50 28 L50 112"/>',
    quan:    '<path d="M30 16 L70 16 L74 114 L56 114 L50 46 L44 114 L26 114 Z"/><path d="M30 26 L70 26"/>',
    vay:     '<path d="M41 14 L59 14 L57 42 L80 114 L20 114 L43 42 Z"/><path d="M43 42 L57 42"/><path d="M41 14 L38 4 M59 14 L62 4"/>',
    phukien: '<path d="M24 52 L76 52 L80 110 L20 110 Z"/><path d="M38 52 Q38 26 50 26 Q62 26 62 52"/><path d="M24 70 L76 70"/>',
    skirt:   '<path d="M36 30 L64 30 L80 108 L20 108 Z"/><path d="M36 38 L64 38"/><path d="M43 38 L36 108 M50 38 L50 108 M57 38 L64 108"/>',
    scarf:   '<path d="M50 20 L86 56 L50 92 L14 56 Z"/><path d="M50 92 L44 116 M50 92 L57 113"/><path d="M32 56 L50 38 L68 56"/>',
    belt:    '<rect x="8" y="56" width="84" height="16" rx="2"/><rect x="28" y="51" width="20" height="26" rx="2"/><path d="M38 64 L58 64"/><circle cx="70" cy="64" r="1.6"/><circle cx="78" cy="64" r="1.6"/>',
    earring: '<circle cx="36" cy="42" r="4"/><path d="M36 46 L36 58"/><circle cx="36" cy="70" r="11"/><circle cx="64" cy="42" r="4"/><path d="M64 46 L64 58"/><circle cx="64" cy="70" r="11"/>',
    hat:     '<ellipse cx="50" cy="80" rx="42" ry="11"/><path d="M29 78 Q29 44 50 44 Q71 44 71 78"/><path d="M30 68 Q50 75 70 68"/>'
  };
  const SHAPE_WORDS = [['chân váy', 'skirt'], ['khăn', 'scarf'], ['thắt lưng', 'belt'], ['bông tai', 'earring'], ['mũ', 'hat']];
  const shapeOf = (p) => (SHAPE_WORDS.find(([w]) => p.name.toLowerCase().includes(w)) || [0, p.cat])[1];

  function swatchHTML(p, colorKey, extraClass) {
    if (p.imageUrl) {
      return `<div class="swatch photo ${extraClass || ''}"><img src="${escapeHTML(p.imageUrl)}" alt="${escapeHTML(p.name)}" loading="lazy"></div>`;
    }
    const hex = (COLORS[colorKey || p.colors[0]] || { hex: '#9c7b56' }).hex;
    const stroke = isLight(hex) ? 'rgba(28,26,23,.45)' : 'rgba(255,255,255,.55)';
    return `<div class="swatch tone ${extraClass || ''}" style="--tone:${hex}">
      <svg class="silhouette" viewBox="0 0 100 130" aria-hidden="true" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round">${SILHOUETTES[shapeOf(p)] || SILHOUETTES.ao}</svg>
    </div>`;
  }

  // Thay một ô màu trang trí (.swatch) bằng ảnh thật của sản phẩm
  function fillPhoto(el, p) {
    if (!el || !p || !p.imageUrl) return;
    el.classList.add('photo');
    el.innerHTML = `<img src="${escapeHTML(p.imageUrl)}" alt="${escapeHTML(p.name)}" loading="lazy">`;
  }
  const withPhoto = (list) => list.filter((p) => p && p.imageUrl);

  function stars(rating, count) {
    if (!rating) return '';
    const full = Math.round(rating);
    return `<span class="stars" aria-label="${rating} trên 5 sao"><span aria-hidden="true">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>${count !== undefined ? ` <small>(${count})</small>` : ''}</span>`;
  }

  // Tên trạng thái đơn hàng — dùng chung cho trang Tài khoản và Quản trị
  const ORDER_STATUS = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', shipping: 'Đang giao', completed: 'Hoàn tất', cancelled: 'Đã hủy', returned: 'Trả hàng' };
  const PAY_STATUS = { unpaid: 'Chưa thanh toán', paid: 'Đã thanh toán', refunded: 'Đã hoàn tiền' };
  const statusPill = (s) => `<span class="pill st-${s}">${ORDER_STATUS[s] || s}</span>`;

  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';

  function productCard(p) {
    const off = discountPercent(p);
    const badge = off ? `<span class="badge badge-sale">-${off}%</span>` : (p.badge ? `<span class="badge">${escapeHTML(p.badge)}</span>` : '');
    // Chấm màu có ảnh riêng: rê chuột vào thì ảnh thẻ đổi sang màu đó
    const dots = p.colors.map((c) => {
      const img = (p.images || []).find((i) => i.color === c);
      return `<span class="dot${img ? ' has-img' : ''}" style="background:${(COLORS[c] || {}).hex}" title="${escapeHTML(colorName(c))}"${img ? ` data-img="${escapeHTML(img.url)}"` : ''}></span>`;
    }).join('');
    const soldOut = Object.values(p.stock || {}).every((n) => n === 0);
    return `<article class="product-card">
      <div class="pc-media">
        <a href="chitiet.html?id=${p.id}" aria-label="${escapeHTML(p.name)}">${swatchHTML(p)}</a>
        ${soldOut ? '<span class="badge badge-out">Hết hàng</span>' : badge}
        <button type="button" class="wish-btn" data-wish="${p.id}" aria-pressed="${isWished(p.id)}" aria-label="Yêu thích ${escapeHTML(p.name)}">${HEART}</button>
        <button type="button" class="quick-btn" data-quick="${p.id}">Xem nhanh</button>
      </div>
      <span class="pc-cat">${escapeHTML(categoryName(p.cat))}</span>
      <h3><a href="chitiet.html?id=${p.id}">${escapeHTML(p.name)}</a></h3>
      ${stars(p.rating, p.reviewCount)}
      <div class="product-meta">
        <span>${p.oldPrice ? `<span class="price-old">${money(p.oldPrice)}</span>` : ''}<span class="price">${money(p.price)}</span></span>
        <span class="dots">${dots}</span>
      </div>
    </article>`;
  }

  // Khung chờ trong lúc tải dữ liệu
  const skeletonCards = (n) => Array.from({ length: n }, () =>
    '<div class="product-card skeleton" aria-hidden="true"><div class="sk-media"></div><div class="sk-line short"></div><div class="sk-line"></div><div class="sk-line short"></div></div>').join('');

  /* ---------- Giỏ hàng ---------- */
  const KEY_CART = 'lua_cart', KEY_COUPON = 'lua_coupon2';
  const lineKey = (id, size, color) => `${id}|${size}|${color}`;
  const getCart = () => store.get(KEY_CART, []);
  function saveCart(cart) { store.set(KEY_CART, cart); updateBadges(); }

  function addToCart(id, size, color, qty) {
    const cart = getCart();
    const key = lineKey(id, size, color);
    const line = cart.find((l) => l.key === key);
    if (line) line.qty = Math.min(line.qty + qty, 10);
    else cart.push({ key, id: Number(id), size, color, qty: Math.min(qty, 10) });
    saveCart(cart);
  }

  function setQty(key, qty) {
    let cart = getCart();
    if (qty <= 0) cart = cart.filter((l) => l.key !== key);
    else cart.forEach((l) => { if (l.key === key) l.qty = Math.min(qty, 10); });
    saveCart(cart);
  }
  const removeLine = (key) => saveCart(getCart().filter((l) => l.key !== key));
  function clearCart() { saveCart([]); store.remove(KEY_COUPON); }

  // Ghép giỏ với dữ liệu sản phẩm mới nhất; bỏ dòng sản phẩm đã ngừng bán
  const cartLines = () => getCart()
    .map((l) => ({ ...l, product: getProduct(l.id) }))
    .filter((l) => l.product)
    .map((l) => ({ ...l, lineTotal: l.product.price * l.qty, stock: stockOf(l.product, l.size, l.color) }));
  const cartCount = () => getCart().reduce((s, l) => s + l.qty, 0);

  /* ---------- Mã giảm giá (kiểm tra với server, lưu điều kiện để tính trước) ---------- */
  const getCoupon = () => store.get(KEY_COUPON, null);
  async function applyCoupon(code) {
    const c = await api(`/api/coupons/${encodeURIComponent(code.trim())}`);
    store.set(KEY_COUPON, c);
    return c;
  }
  const removeCoupon = () => store.remove(KEY_COUPON);

  /* Tạm tính ở trình duyệt để hiển thị; số tiền cuối cùng do server tính lại khi đặt hàng.
     region: mã khu vực hoặc null (chưa chọn) */
  function totals(region) {
    const lines = cartLines();
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    let discount = 0, freeship = false, couponError = null;
    const c = getCoupon();
    if (c) {
      if (subtotal < c.minOrder) couponError = `Mã ${c.code} áp dụng cho đơn từ ${money(c.minOrder)}.`;
      else if (c.type === 'percent') discount = Math.round(subtotal * c.value / 100 / 1000) * 1000;
      else if (c.type === 'fixed') discount = Math.min(c.value, subtotal);
      else if (c.type === 'freeship') freeship = true;
    }
    let shipping = null;
    const r = region && SHIPPING_REGIONS[region];
    if (r) shipping = (freeship || (r.freeFrom !== null && subtotal >= r.freeFrom) || !subtotal) ? 0 : r.fee;
    return { lines, subtotal, discount, shipping, freeship, total: subtotal - discount + (shipping || 0), coupon: c, couponError };
  }

  /* ---------- Yêu thích & vừa xem ---------- */
  const getWish = () => store.get('lua_wish', []);
  const isWished = (id) => getWish().includes(Number(id));
  function toggleWish(id) {
    id = Number(id);
    const list = getWish();
    const on = !list.includes(id);
    store.set('lua_wish', on ? [id, ...list] : list.filter((x) => x !== id));
    updateBadges();
    return on;
  }
  const getRecent = () => store.get('lua_recent', []);
  const pushRecent = (id) => store.set('lua_recent', [Number(id), ...getRecent().filter((x) => x !== Number(id))].slice(0, 8));

  function updateBadges() {
    const set = (sel, n) => $$(sel).forEach((el) => { el.textContent = n; el.hidden = n === 0; });
    set('[data-cart-count]', cartCount());
    set('[data-wish-count]', getWish().length);
  }

  /* ---------- Thông báo ---------- */
  let toastTimer;
  function toast(html) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast'; el.className = 'toast';
      el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.innerHTML = html;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  /* ---------- Xem nhanh (dùng thẻ <dialog> có sẵn của trình duyệt) ---------- */
  let qv = null;   // { p, color, size } của sản phẩm đang xem nhanh

  function renderQuickView() {
    const { p, color, size } = qv;
    $('#quickView').innerHTML = `
      <button type="button" class="modal-close" data-close aria-label="Đóng">×</button>
      <div class="qv-grid">
        ${swatchHTML(p, color, 'qv-media')}
        <div>
          <span class="pc-cat">${escapeHTML(categoryName(p.cat))}</span>
          <h2>${escapeHTML(p.name)}</h2>
          ${stars(p.rating, p.reviewCount)}
          <p class="qv-price">${p.oldPrice ? `<span class="price-old">${money(p.oldPrice)}</span>` : ''}<span class="price">${money(p.price)}</span></p>
          <div class="option-label">Màu <span class="value">${escapeHTML(colorName(color))}</span></div>
          <div class="color-options">${p.colors.map((c) => `<button type="button" class="color-opt" data-c="${c}" role="radio" aria-checked="${c === color}" aria-label="${escapeHTML(colorName(c))}" style="background:${COLORS[c].hex}"></button>`).join('')}</div>
          <div class="option-label" style="margin-top:16px;">Kích cỡ</div>
          <div class="chips">${p.sizes.map((s) => `<button type="button" class="chip" data-s="${s}" role="radio" aria-checked="${s === size}" ${stockOf(p, s, color) ? '' : 'disabled'}>${s}</button>`).join('')}</div>
          <p class="pd-hint" id="qvHint" aria-live="polite"></p>
          <div class="qv-actions">
            <button type="button" class="btn btn-primary" data-add>Thêm vào giỏ</button>
            <a class="btn" href="chitiet.html?id=${p.id}">Xem chi tiết</a>
          </div>
        </div>
      </div>`;
  }

  function quickView(id) {
    const p = getProduct(id);
    if (!p) return;
    let dlg = $('#quickView');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'quickView'; dlg.className = 'modal qv';
      document.body.appendChild(dlg);
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
        const c = e.target.closest('[data-c]'), s = e.target.closest('[data-s]');
        if (c) { qv.color = c.dataset.c; if (qv.size && !stockOf(qv.p, qv.size, qv.color)) qv.size = null; renderQuickView(); }
        if (s) { qv.size = s.dataset.s; renderQuickView(); }
        if (e.target.closest('[data-add]')) {
          if (!qv.size) { $('#qvHint').textContent = 'Vui lòng chọn kích cỡ.'; return; }
          addToCart(qv.p.id, qv.size, qv.color, 1);
          dlg.close();
          toast(`Đã thêm <strong>${escapeHTML(qv.p.name)}</strong> vào giỏ.<a href="giohang.html">Xem giỏ hàng</a>`);
        }
      });
    }
    const color = p.colors.find((c) => p.sizes.some((s) => stockOf(p, s, c) > 0)) || p.colors[0];
    qv = { p, color, size: p.sizes.length === 1 && stockOf(p, p.sizes[0], color) ? p.sizes[0] : null };
    renderQuickView();
    dlg.showModal();
  }

  /* Nút yêu thích và xem nhanh trên mọi thẻ sản phẩm */
  document.addEventListener('mouseover', (e) => {
    const d = e.target.closest('.product-card .dot[data-img]');
    const img = d && d.closest('.product-card').querySelector('.pc-media img');
    if (!img) return;
    if (!img.dataset.orig) img.dataset.orig = img.src;
    img.src = d.dataset.img;
  });
  document.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.product-card');
    if (!card || card.contains(e.relatedTarget)) return;
    const img = card.querySelector('.pc-media img[data-orig]');
    if (img) img.src = img.dataset.orig;
  });

  document.addEventListener('click', (e) => {
    const w = e.target.closest('[data-wish]');
    if (w) {
      const on = toggleWish(w.dataset.wish);
      $$(`[data-wish="${w.dataset.wish}"]`).forEach((b) => b.setAttribute('aria-pressed', on));
      toast(on ? 'Đã thêm vào danh sách yêu thích.<a href="yeuthich.html">Xem</a>' : 'Đã bỏ khỏi danh sách yêu thích.');
    }
    const q = e.target.closest('[data-quick]');
    if (q) ready.then(() => quickView(q.dataset.quick));
  });

  window.addEventListener('storage', (e) => { if (['lua_cart', 'lua_wish'].includes(e.key)) updateBadges(); });

  return {
    store, api, ready, me, money, $, $$, escapeHTML, param, norm,
    getProduct, categoryName, colorName, discountPercent, stockOf, swatchHTML, fillPhoto, withPhoto, stars, productCard, skeletonCards, HEART,
    getCart, addToCart, setQty, removeLine, clearCart, cartLines, cartCount, updateBadges,
    getCoupon, applyCoupon, removeCoupon, totals,
    getWish, isWished, toggleWish, getRecent, pushRecent,
    toast, quickView, ORDER_STATUS, PAY_STATUS, statusPill
  };
})();