// Sri Sai Hospital website — reads LIVE from the same Supabase backend as
// the apps. Anything changed in the admin app (medicines, prices, stock,
// doctors, services, settings, announcement) appears here automatically:
// data refreshes every 60s, whenever the tab regains focus, and the OPD
// queue refreshes every 30s.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://blpptbmezfzkdctzxafs.supabase.co';
const ANON_KEY = 'sb_publishable_P40MX5RdTrjKVFPtDzod4A_cXrgiIKf';
const db = createClient(SUPABASE_URL, ANON_KEY);

const $ = (id) => document.getElementById(id);
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------- state ----------------
let settings = null;
let medicines = [];
let categories = [];
let doctors = [];
let services = [];
let banners = [];
let activeCat = null;
let bannerIdx = 0;
let bannerTimer = null;
let cart = JSON.parse(localStorage.getItem('srisai-web-cart') || '{}'); // {medicineId: qty}
// Same-as-app ordering & login state
let session = null;
let payMethod = 'upi';
let coupon = null; // { code, discount }
let placing = false;
let myOrders = JSON.parse(localStorage.getItem('srisai-web-orders') || '[]');
let profile = JSON.parse(localStorage.getItem('srisai-web-profile') || '{}');

const saveOrders = () => localStorage.setItem('srisai-web-orders', JSON.stringify(myOrders.slice(0, 30)));
const saveProfile = () => localStorage.setItem('srisai-web-profile', JSON.stringify(profile));

// ---------------- data loading ----------------
async function loadAll() {
  const [st, cats, meds, docs, svcs, bans] = await Promise.all([
    db.from('settings').select('*').eq('id', 1).maybeSingle(),
    db.from('categories').select('*').eq('is_active', true).order('sort_order'),
    db.from('medicines').select('*').eq('is_active', true).order('name'),
    db.from('doctors').select('*').eq('is_active', true).order('sort_order'),
    db.from('services').select('*').eq('is_active', true).order('sort_order'),
    db.from('banners').select('*').eq('is_active', true).order('sort_order'),
  ]);
  if (st.data) settings = st.data;
  categories = cats.data ?? [];
  medicines = meds.data ?? [];
  doctors = docs.data ?? [];
  services = svcs.data ?? [];
  banners = bans.data ?? [];
  renderAll();
}

// ---------------- rendering ----------------
function renderAll() {
  if (!settings) return;
  renderHeader();
  renderStats();
  renderBanners();
  renderCats();
  renderGrid();
  renderDoctors();
  renderServices();
  renderBooking();
  renderContact();
  renderCartBadge();
  loadQueue();
}

function renderHeader() {
  document.title = `${settings.hospital_name} — Ayurvedic Care & Pharmacy`;
  $('brandName').textContent = settings.hospital_name;
  $('footName').textContent = settings.hospital_name;
  $('footTagline').textContent = settings.tagline ?? '';
  $('recognition').textContent = settings.recognition ?? '';
  $('tagline').textContent = settings.tagline ?? '';
  $('subTagline').textContent = settings.sub_tagline ?? '';
  $('patientsNote').textContent = settings.patients_note ?? '';
  $('badges').innerHTML = (settings.badges ?? [])
    .map((b) => `<span class="badge">${esc(b)}</span>`).join('');
  const ann = $('announceBar');
  if (settings.announcement) {
    ann.hidden = false;
    ann.textContent = `📢 ${settings.announcement}`;
  } else ann.hidden = true;
  $('deliveryNote').textContent =
    `Free delivery above ${inr(settings.free_delivery_above)} · Prescription medicines need a valid Rx`;
}

let statsAnimated = false;
function renderStats() {
  const stats = Array.isArray(settings.stats) ? settings.stats : [];
  $('stats').innerHTML = stats
    .map((s) => `<div class="stat"><b data-target="${esc(s.value)}">${statsAnimated ? esc(s.value) : '0'}</b><span>${esc(s.label)}</span></div>`)
    .join('');
  if (!statsAnimated) countUpWhenVisible();
}

// Count-up animation for the stat numbers (like the original site)
function countUpWhenVisible() {
  const obs = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting) || statsAnimated) return;
    statsAnimated = true;
    obs.disconnect();
    document.querySelectorAll('#stats b').forEach((el) => {
      const target = el.dataset.target ?? '';
      const num = parseInt(target.replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(num) || num <= 0) { el.textContent = target; return; }
      const prefix = target.match(/^[^0-9]*/)[0];
      const suffix = target.replace(/^[^0-9]*[0-9,]+/, '');
      const t0 = performance.now();
      const dur = 1400;
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = prefix + Math.round(num * eased).toLocaleString('en-IN') + suffix;
        if (p < 1) requestAnimationFrame(tick);
        else el.textContent = target;
      };
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.4 });
  const stats = $('stats');
  if (stats) obs.observe(stats);
}

function renderCats() {
  const mk = (id, label, emoji) =>
    `<button class="cat ${activeCat === id ? 'active' : ''}" data-cat="${id ?? ''}">${emoji ? emoji + ' ' : ''}${esc(label)}</button>`;
  $('cats').innerHTML =
    mk(null, 'All', '') + categories.map((c) => mk(c.id, c.name, c.emoji)).join('');
  $('cats').querySelectorAll('.cat').forEach((b) =>
    b.addEventListener('click', () => {
      activeCat = b.dataset.cat || null;
      renderCats();
      renderGrid();
    }));
}

// ---------------- banner carousel (admin-managed) ----------------
function renderBanners() {
  const wrap = $('bannerWrap');
  if (banners.length === 0) { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (bannerIdx >= banners.length) bannerIdx = 0;

  $('bannerTrack').innerHTML = banners.map((b, i) => `
    <div class="bannerSlide ${i === bannerIdx ? 'on' : ''}"
         style="background:linear-gradient(135deg, ${esc(b.color_from || '#065F46')}, ${esc(b.color_to || '#059669')})">
      ${b.image_url ? `<img class="bImg" src="${esc(b.image_url)}" alt="">` : `<span class="bEmoji">${esc(b.emoji || '🌿')}</span>`}
      <div>
        <h3>${esc(b.title)}</h3>
        <p>${esc(b.subtitle ?? '')}</p>
      </div>
    </div>`).join('');

  $('bannerDots').innerHTML = banners.length > 1
    ? banners.map((_, i) =>
        `<button class="${i === bannerIdx ? 'on' : ''}" data-dot="${i}" aria-label="Banner ${i + 1}"></button>`).join('')
    : '';
  $('bannerDots').querySelectorAll('[data-dot]').forEach((d) =>
    d.addEventListener('click', () => { bannerIdx = Number(d.dataset.dot); renderBanners(); }));

  clearInterval(bannerTimer);
  if (banners.length > 1) {
    bannerTimer = setInterval(() => {
      bannerIdx = (bannerIdx + 1) % banners.length;
      renderBanners();
    }, 5000);
  }
}

function pct(mrp, price) {
  if (!mrp || mrp <= price) return 0;
  return Math.round(((mrp - price) / mrp) * 100);
}

function renderGrid() {
  const q = ($('search').value || '').trim().toLowerCase();
  const list = medicines
    .filter((m) => (activeCat ? m.category_id === activeCat : true))
    .filter((m) =>
      q
        ? (m.name + ' ' + (m.brand ?? '') + ' ' + (m.composition ?? '')).toLowerCase().includes(q)
        : true);

  $('grid').innerHTML = list.length === 0
    ? `<p style="color:var(--muted)">Nothing found — try another search or category.</p>`
    : list.map((m) => {
        const off = pct(Number(m.mrp), Number(m.price));
        const qty = cart[m.id] ?? 0;
        const out = (m.stock ?? 0) <= 0;
        const img = m.image_url
          ? `<img src="${esc(m.image_url)}" alt="" loading="lazy">`
          : esc(m.emoji || '💊');
        const action = out
          ? `<button class="addBtn" disabled>Out of stock</button>`
          : qty > 0
            ? `<div class="stepper">
                 <button data-dec="${m.id}" aria-label="Decrease">−</button>
                 <b>${qty}</b>
                 <button data-inc="${m.id}" aria-label="Increase" ${qty >= m.stock ? 'disabled' : ''}>+</button>
               </div>`
            : `<button class="addBtn" data-add="${m.id}">+ Add</button>`;
        return `<div class="card">
          <div class="tile">${img}
            ${off > 0 ? `<span class="off">${off}% OFF</span>` : ''}
            ${m.requires_rx ? `<span class="rx">Rx</span>` : ''}
          </div>
          <div class="pname">${esc(m.name)}</div>
          <div class="ppack">${esc(m.pack_size ?? '')}</div>
          <div class="prow">
            <span class="price">${inr(m.price)}</span>
            ${Number(m.mrp) > Number(m.price) ? `<span class="mrp">${inr(m.mrp)}</span>` : ''}
          </div>
          ${!out && m.stock <= 5 ? `<div class="stockLow">Only ${m.stock} left!</div>` : ''}
          ${action}
        </div>`;
      }).join('');

  $('grid').querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => setQty(b.dataset.add, 1)));
  $('grid').querySelectorAll('[data-inc]').forEach((b) =>
    b.addEventListener('click', () => setQty(b.dataset.inc, (cart[b.dataset.inc] ?? 0) + 1)));
  $('grid').querySelectorAll('[data-dec]').forEach((b) =>
    b.addEventListener('click', () => setQty(b.dataset.dec, (cart[b.dataset.dec] ?? 0) - 1)));
}

function renderDoctors() {
  $('docGrid').innerHTML = doctors.map((d) => `
    <div class="doc">
      <div class="docHead">
        <div class="docAvatar">${d.image_url ? `<img src="${esc(d.image_url)}" alt="" loading="lazy">` : esc(d.emoji || '🧑‍⚕️')}</div>
        <div>
          <h3>${esc(d.name)}</h3>
          <div class="docSpec">${esc(d.specialty ?? '')}</div>
          <div class="docQual">${esc(d.qualifications ?? '')}</div>
        </div>
      </div>
      ${d.bio ? `<p class="docBio">${esc(d.bio)}</p>` : ''}
      <div class="docTags">${(d.expertise ?? []).slice(0, 4).map((e) => `<span class="docTag">${esc(e)}</span>`).join('')}</div>
    </div>`).join('');
}

function renderServices() {
  $('svcGrid').innerHTML = services.map((s) => `
    <div class="svc">
      <div class="svcEmoji">${esc(s.emoji || '🩺')}</div>
      <h3>${esc(s.name)}</h3>
      <p>${esc(s.description ?? '')}</p>
    </div>`).join('');
}

// ---------------- live queue ----------------
async function loadQueue() {
  if (doctors.length === 0) return;
  const cards = await Promise.all(doctors.map(async (d) => {
    try {
      const { data } = await db.rpc('queue_status', { p_doctor_id: d.id });
      if (!data || data.last_issued == null) return ''; // no tokens today
      const serving = data.serving_no != null ? `#${data.serving_no}` : '—';
      return `<div class="queueCard">
        <h4>${esc(d.name)}</h4>
        <div class="queueNow">${serving}</div>
        <div class="queueMeta">Now serving · ${data.waiting_count ?? 0} waiting · last token #${data.last_issued}</div>
      </div>`;
    } catch { return ''; }
  }));
  const html = cards.filter(Boolean).join('');
  $('queueSection').hidden = html === '';
  $('queueGrid').innerHTML = html;
}

// ---------------- cart ----------------
function setQty(id, qty) {
  const med = medicines.find((m) => m.id === id);
  const max = med?.stock ?? 99;
  if (qty <= 0) delete cart[id];
  else cart[id] = Math.min(qty, max);
  localStorage.setItem('srisai-web-cart', JSON.stringify(cart));
  renderGrid();
  renderCartBadge();
  renderDrawer();
}

function cartDetail() {
  const lines = Object.entries(cart)
    .map(([id, qty]) => {
      const m = medicines.find((x) => x.id === id);
      return m ? { m, qty: Math.min(qty, m.stock) } : null;
    })
    .filter(Boolean);
  const subtotal = lines.reduce((s, l) => s + Number(l.m.price) * l.qty, 0);
  const free = Number(settings?.free_delivery_above ?? 499);
  const fee = subtotal === 0 || subtotal >= free ? 0 : Number(settings?.delivery_fee ?? 40);
  const savings = lines.reduce(
    (s, l) => s + Math.max(0, Number(l.m.mrp) - Number(l.m.price)) * l.qty, 0);
  const discount = Math.min(coupon?.discount ?? 0, subtotal);
  return {
    lines, subtotal, fee, discount, free,
    total: Math.max(0, subtotal + fee - discount),
    savings: savings + discount,
  };
}

function renderCartBadge() {
  const count = Object.values(cart).reduce((a, b) => a + b, 0);
  $('cartCount').hidden = count === 0;
  $('cartCount').textContent = count;
  $('mCartCount').hidden = count === 0;
  $('mCartCount').textContent = count;
}

function renderDrawer() {
  const d = cartDetail();
  $('cartLines').innerHTML = d.lines.length === 0
    ? `<p style="color:var(--muted);text-align:center;padding:20px 0">Your cart is empty 🛒</p>`
    : d.lines.map(({ m, qty }) => `
      <div class="cline">
        <span class="em">${m.image_url ? `<img src="${esc(m.image_url)}" alt="" style="width:34px;height:34px;border-radius:8px;object-fit:cover">` : esc(m.emoji || '💊')}</span>
        <span class="nm">${esc(m.name)}<br><small style="color:var(--muted)">${inr(m.price)} × ${qty}</small></span>
        <span class="qty">
          <button data-ddec="${m.id}" aria-label="Decrease">−</button>
          <b>${qty}</b>
          <button data-dinc="${m.id}" aria-label="Increase" ${qty >= m.stock ? 'disabled' : ''}>+</button>
        </span>
      </div>`).join('');

  const bar = $('freeBar');
  if (d.lines.length === 0) bar.hidden = true;
  else if (d.subtotal >= d.free) {
    bar.hidden = false; bar.className = 'freeBar done';
    bar.textContent = '🎉 You get FREE delivery on this order';
  } else {
    bar.hidden = false; bar.className = 'freeBar';
    bar.textContent = `+ ${inr(d.free - d.subtotal)} more for FREE delivery 🚚`;
  }

  $('cartBill').innerHTML = d.lines.length === 0 ? '' : `
    <div class="rowb"><span>Items total</span><b>${inr(d.subtotal)}</b></div>
    <div class="rowb"><span>Delivery</span><b>${d.fee === 0 ? 'FREE' : inr(d.fee)}</b></div>
    ${d.discount > 0 ? `<div class="rowb save"><span>Coupon (${esc(coupon.code)})</span><b>− ${inr(d.discount)}</b></div>` : ''}
    ${d.savings > 0 ? `<div class="rowb save"><span>You save</span><b>${inr(d.savings)}</b></div>` : ''}
    <div class="rowb tot"><span>To pay</span><span>${inr(d.total)}</span></div>`;

  const hasItems = d.lines.length > 0;
  $('orderForm').style.display = hasItems ? 'grid' : 'none';
  $('couponBox').hidden = !hasItems;
  $('orderDone').hidden = true;
  if (hasItems) {
    // prefill from the last order / profile (like the app)
    if (!$('oName').value && profile.name) $('oName').value = profile.name;
    if (!$('oPhone').value && profile.phone) $('oPhone').value = profile.phone;
    if (!$('oAddress').value && profile.address) $('oAddress').value = profile.address;
    if (!$('oCity').value && profile.city) $('oCity').value = profile.city;
    if (!$('oPincode').value && profile.pincode) $('oPincode').value = profile.pincode;
    renderPayOpts();
    $('placeBtn').textContent = `Place Order · ${inr(d.total)}`;
  }

  $('cartLines').querySelectorAll('[data-dinc]').forEach((b) =>
    b.addEventListener('click', () => setQty(b.dataset.dinc, (cart[b.dataset.dinc] ?? 0) + 1)));
  $('cartLines').querySelectorAll('[data-ddec]').forEach((b) =>
    b.addEventListener('click', () => setQty(b.dataset.ddec, (cart[b.dataset.ddec] ?? 0) - 1)));
}

// ---------------- payment options (same trio as the app) ----------------
function renderPayOpts() {
  const opts = [
    { key: 'upi', t: 'UPI — any app', s: `GPay, PhonePe, Paytm… pays to ${settings?.upi_vpa ?? ''}` },
    ...(settings?.razorpay_key_id
      ? [{ key: 'razorpay', t: 'Card / Netbanking', s: 'Secure Razorpay payment page' }]
      : []),
    { key: 'cod', t: 'Cash on Delivery', s: 'Pay when your medicines arrive' },
  ];
  if (!opts.some((o) => o.key === payMethod)) payMethod = 'upi';
  $('payOpts').innerHTML = opts.map((o) => `
    <label class="payOpt ${payMethod === o.key ? 'on' : ''}" data-pay="${o.key}">
      <span class="radio"></span>
      <span><b>${o.t}</b><small>${esc(o.s)}</small></span>
    </label>`).join('');
  $('payOpts').querySelectorAll('[data-pay]').forEach((el) =>
    el.addEventListener('click', () => { payMethod = el.dataset.pay; renderPayOpts(); }));
}

function upiUrl(amount, note) {
  const f = [
    ['pa', settings.upi_vpa], ['pn', settings.upi_name || settings.hospital_name],
    ['am', Number(amount).toFixed(2)], ['cu', 'INR'], ['tn', String(note).slice(0, 70)],
  ];
  return 'upi://pay?' + f.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

// WhatsApp confirmation — same format the app sends, so staff see one style.
function waOrderMessage(o) {
  const L = [];
  L.push(`🛒 *New Medicine Order — ${settings.hospital_name}* (website)`);
  L.push(`Order No: *${o.orderNumber}*`);
  L.push('');
  o.items.forEach((it, i) => L.push(`${i + 1}. ${it.name} x${it.qty} — ${inr(it.price * it.qty)}`));
  L.push('');
  L.push(`*Total: ${inr(o.total)}*`);
  L.push(`Payment: ${o.payMethod === 'cod' ? 'Cash on Delivery' : o.payMethod.toUpperCase()}`);
  L.push('');
  L.push(`👤 ${o.name} · 📞 ${o.phone}`);
  L.push(`📍 ${o.address}, ${o.city} - ${o.pincode}`);
  return L.join('\n');
}

// ---------------- place order (REAL — same place_order RPC as the app) ----------------
async function placeOrder() {
  const d = cartDetail();
  if (d.lines.length === 0 || placing) return;
  const name = $('oName').value.trim();
  const phone = $('oPhone').value.replace(/\D/g, '').slice(-10);
  const address = $('oAddress').value.trim();
  const city = $('oCity').value.trim();
  const pincode = $('oPincode').value.trim();
  if (name.length < 2) return alert('Please enter your name.');
  if (phone.length !== 10) return alert('Please enter a valid 10-digit mobile number.');
  if (!address) return alert('Please enter your delivery address.');
  if (!city) return alert('Please enter your city.');
  if (!/^\d{6}$/.test(pincode)) return alert('Pincode should be 6 digits.');

  placing = true;
  $('placeBtn').disabled = true;
  $('placeBtn').textContent = 'Placing order…';
  try {
    const orderNumber = 'SS-' + Date.now().toString(36).toUpperCase();
    const { data, error } = await db.rpc('place_order', {
      p_order_number: orderNumber,
      p_items: d.lines.map(({ m, qty }) => ({ medicine_id: m.id, qty })),
      p_customer_name: name,
      p_phone: phone,
      p_address: address,
      p_city: city,
      p_pincode: pincode,
      p_payment_method: payMethod,
      p_prescription_url: null,
      p_coupon_code: coupon?.code ?? null,
    });
    if (error) throw new Error(error.message);

    const order = {
      orderNumber: data.order_number, name, phone, address, city, pincode,
      payMethod, total: Number(data.total), discount: Number(data.discount ?? 0),
      status: 'placed', payStatus: 'pending', createdAt: Date.now(),
      items: d.lines.map(({ m, qty }) => ({ name: m.name, qty, price: Number(m.price) })),
    };
    myOrders.unshift(order);
    saveOrders();
    profile = { name, phone, address, city, pincode };
    saveProfile();
    cart = {};
    localStorage.setItem('srisai-web-cart', '{}');
    coupon = null;
    renderCartBadge();
    renderGrid();
    showOrderDone(order);
    loadAll(); // refresh live stock
  } catch (e) {
    alert(e.message || 'Could not place the order. Please try again.');
  } finally {
    placing = false;
    $('placeBtn').disabled = false;
    renderDrawer();
  }
}

async function openRazorpay(o) {
  try {
    const { data, error } = await db.functions.invoke('create-payment-link', {
      body: { orderNumber: o.orderNumber, customerName: o.name, phone: o.phone },
    });
    if (error || !data?.url) throw new Error(data?.error ?? 'Payment link failed');
    window.open(data.url, '_blank');
  } catch (e) {
    alert(e.message || 'Razorpay unavailable — you can pay via UPI instead.');
  }
}

function showOrderDone(o) {
  $('cartLines').innerHTML = '';
  $('cartBill').innerHTML = '';
  $('couponBox').hidden = true;
  $('couponMsg').hidden = true;
  $('freeBar').hidden = true;
  $('orderForm').style.display = 'none';
  const done = $('orderDone');
  done.hidden = false;
  done.innerHTML = `
    <div class="bigTick">✓</div>
    <h4>Order placed!</h4>
    <p class="onum">${esc(o.orderNumber)} · ${inr(o.total)}</p>
    ${o.payMethod === 'upi' ? `<button class="btn btnGold big" id="dPay">⚡ Pay ${inr(o.total)} via UPI</button>` : ''}
    ${o.payMethod === 'razorpay' ? `<button class="btn btnGold big" id="dRzp">💳 Pay ${inr(o.total)} — Card / Netbanking</button>` : ''}
    ${o.payMethod === 'cod' ? `<p class="authNote">💵 Keep ${inr(o.total)} ready — pay on delivery.</p>` : ''}
    <button class="btn big gBtn" id="dWa" style="margin-top:8px">💬 Send order on WhatsApp</button>
    <button class="linkBtn" id="dTrack">Track in My Orders →</button>`;
  const pay = $('dPay'); if (pay) pay.addEventListener('click', () => { location.href = upiUrl(o.total, `Order ${o.orderNumber}`); });
  const rzp = $('dRzp'); if (rzp) rzp.addEventListener('click', () => openRazorpay(o));
  $('dWa').addEventListener('click', () =>
    window.open(`https://wa.me/${settings.whatsapp}?text=${encodeURIComponent(waOrderMessage(o))}`, '_blank'));
  $('dTrack').addEventListener('click', () => { closeDrawer(); openOrders(); });
}

// ---------------- my orders (synced via my_orders_status, guests included) ----------------
async function syncMyOrders() {
  const active = myOrders.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
  if (active.length === 0) return;
  try {
    const { data } = await db.rpc('my_orders_status', {
      p_keys: active.slice(0, 50).map((o) => ({ order_number: o.orderNumber, phone: o.phone })),
    });
    for (const r of Array.isArray(data) ? data : []) {
      const o = myOrders.find((x) => x.orderNumber === r.order_number);
      if (!o) continue;
      o.status = r.status;
      o.payStatus = r.payment_status;
      o.total = Number(r.total);
      if (r.payment_method) o.payMethod = r.payment_method;
    }
    saveOrders();
  } catch { /* offline — keep local */ }
}

const STATUS_LABEL = {
  placed: 'Order Placed', verified: 'Verified', packed: 'Packed',
  shipped: 'Out for Delivery', delivered: 'Delivered', cancelled: 'Cancelled',
};

function renderOrders() {
  const body = $('ordersBody');
  if (myOrders.length === 0) {
    body.innerHTML = `<p class="emptyOrders">No orders yet on this device.<br>Your medicine orders will appear here with live status.</p>`;
    return;
  }
  body.innerHTML = myOrders.map((o, i) => `
    <div class="oCard">
      <div class="oTop">
        <div>
          <div class="oNum">${esc(o.orderNumber)}</div>
          <div class="oMeta">${new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ·
            ${o.items.reduce((n, it) => n + it.qty, 0)} items · ${inr(o.total)} ·
            ${o.payStatus === 'paid' ? '✅ Paid' : o.payStatus === 'refunded' ? '💸 Refunded' : '⏳ Payment pending'}</div>
        </div>
        <span class="pill ${o.status}">${STATUS_LABEL[o.status] ?? o.status}</span>
      </div>
      <div class="oActions">
        ${o.payStatus === 'pending' && o.status !== 'cancelled' && o.payMethod !== 'cod'
          ? `<button class="oBtn gold" data-opay="${i}">⚡ Pay ${inr(o.total)}</button>` : ''}
        ${(o.status === 'placed' || o.status === 'verified')
          ? `<button class="oBtn" data-ocancel="${i}">Cancel</button>` : ''}
        <button class="oBtn" data-owa="${i}">WhatsApp</button>
      </div>
    </div>`).join('');

  body.querySelectorAll('[data-opay]').forEach((b) =>
    b.addEventListener('click', () => {
      const o = myOrders[Number(b.dataset.opay)];
      if (o.payMethod === 'razorpay') openRazorpay(o);
      else location.href = upiUrl(o.total, `Order ${o.orderNumber}`);
    }));
  body.querySelectorAll('[data-ocancel]').forEach((b) =>
    b.addEventListener('click', async () => {
      const o = myOrders[Number(b.dataset.ocancel)];
      if (!confirm(`Cancel order ${o.orderNumber}? This cannot be undone.`)) return;
      try {
        const { error } = await db.rpc('cancel_my_order', {
          p_order_number: o.orderNumber, p_phone: o.phone,
        });
        if (error) throw new Error(error.message);
        o.status = 'cancelled';
        saveOrders();
        renderOrders();
      } catch (e) { alert(e.message || 'Could not cancel — contact the hospital.'); }
    }));
  body.querySelectorAll('[data-owa]').forEach((b) =>
    b.addEventListener('click', () => {
      const o = myOrders[Number(b.dataset.owa)];
      window.open(`https://wa.me/${settings.whatsapp}?text=${encodeURIComponent(`Hello, regarding my order *${o.orderNumber}* 🙏`)}`, '_blank');
    }));
}

async function openOrders() {
  $('ordersOverlay').hidden = false;
  $('ordersModal').hidden = false;
  renderOrders();
  await syncMyOrders();
  renderOrders();
}

// ---------------- booking ----------------
function renderBooking() {
  $('bDoctor').innerHTML = doctors
    .map((d) => `<option value="${d.id}">${esc(d.name)} — ${esc(d.specialty ?? '')}</option>`).join('');
  $('bService').innerHTML =
    `<option value="General Consultation">General Consultation</option>` +
    services.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  $('bTime').innerHTML = (settings.time_slots ?? [])
    .map((t) => `<option>${esc(t)}</option>`).join('');
  $('bDate').min = new Date().toISOString().slice(0, 10);
  updateFee();
}

function updateFee() {
  const online = $('bType').value === 'online';
  $('bFee').value = inr(online ? settings.fee_online ?? 200 : settings.fee_offline ?? 300);
}

function renderContact() {
  $('cAddress').textContent = settings.address ?? '';
  $('cPhone').textContent = settings.phone ?? '';
  $('cPhone').href = `tel:${(settings.phone ?? '').replace(/\s/g, '')}`;
  $('cWa').href = `https://wa.me/${settings.whatsapp}`;
  $('cEmail').textContent = settings.email ?? '';
  $('cEmail').href = `mailto:${settings.email ?? ''}`;
  $('waFab').href = `https://wa.me/${settings.whatsapp}?text=${encodeURIComponent(`Hello ${settings.hospital_name} 🙏`)}`;
  // booking aside: live fees + call shortcut
  $('aFeeOff').textContent = inr(settings.fee_offline ?? 300);
  $('aFeeOn').textContent = inr(settings.fee_online ?? 200);
  $('aPhone').textContent = `📞 ${settings.phone ?? ''}`;
  $('aPhone').href = `tel:${(settings.phone ?? '').replace(/\s/g, '')}`;
  $('mCall').href = `tel:${(settings.phone ?? '').replace(/\s/g, '')}`;
}

// ---------------- events ----------------
$('search').addEventListener('input', renderGrid);
$('bType').addEventListener('change', updateFee);

const openDrawer = () => {
  renderDrawer();
  $('drawer').hidden = false;
  $('overlay').hidden = false;
};
const closeDrawer = () => { $('drawer').hidden = true; $('overlay').hidden = true; };
$('cartBtn').addEventListener('click', openDrawer);
$('mCart').addEventListener('click', openDrawer);
$('closeDrawer').addEventListener('click', closeDrawer);
$('overlay').addEventListener('click', closeDrawer);

// mobile hamburger menu
$('menuBtn').addEventListener('click', () => {
  $('mobileMenu').hidden = !$('mobileMenu').hidden;
});
$('mobileMenu').querySelectorAll('a').forEach((a) =>
  a.addEventListener('click', () => { $('mobileMenu').hidden = true; }));

$('orderForm').addEventListener('submit', (e) => {
  e.preventDefault();
  placeOrder();
});

// coupon — same check_coupon RPC as the app
$('couponApply').addEventListener('click', async () => {
  const code = $('couponInput').value.trim().toUpperCase();
  const msgEl = $('couponMsg');
  if (!code) return;
  $('couponApply').disabled = true;
  try {
    const { data, error } = await db.rpc('check_coupon', {
      p_code: code, p_subtotal: cartDetail().subtotal,
    });
    if (error) throw new Error(error.message);
    msgEl.hidden = false;
    if (data.valid) {
      coupon = { code, discount: Number(data.discount) };
      msgEl.className = 'couponMsg ok';
    } else {
      coupon = null;
      msgEl.className = 'couponMsg bad';
    }
    msgEl.textContent = data.message;
  } catch (e) {
    coupon = null;
    msgEl.hidden = false;
    msgEl.className = 'couponMsg bad';
    msgEl.textContent = e.message || 'Could not check the coupon';
  } finally {
    $('couponApply').disabled = false;
    renderDrawer();
    $('couponMsg').hidden = false;
  }
});

// ---------------- auth (same providers as the app) ----------------
let authMode = 'email'; // email | password | code
let authEmail = '';

function openAuth() { $('authOverlay').hidden = false; $('authModal').hidden = false; renderAuth(); }
function closeAuth() { $('authOverlay').hidden = true; $('authModal').hidden = true; }
$('authBtn').addEventListener('click', openAuth);
$('authClose').addEventListener('click', closeAuth);
$('authOverlay').addEventListener('click', closeAuth);
$('ordersBtn').addEventListener('click', openOrders);
$('ordersClose').addEventListener('click', () => { $('ordersOverlay').hidden = true; $('ordersModal').hidden = true; });
$('ordersOverlay').addEventListener('click', () => { $('ordersOverlay').hidden = true; $('ordersModal').hidden = true; });

function renderAuth() {
  const body = $('authBody');
  if (session) {
    $('authTitle').textContent = 'My Account';
    body.innerHTML = `
      <div class="signedCard">
        <div style="font-size:30px">🙏</div>
        <b>${esc(session.user.email ?? session.user.phone ?? 'Signed in')}</b>
        <p class="tiny" style="margin-top:4px">Same account works in the Sri Sai Hospital app.</p>
      </div>
      <button class="btn btnGold big" id="auOrders" style="margin-top:12px">📦 My Orders</button>
      <button class="linkBtn" id="auOut">Sign out</button>`;
    $('auOrders').addEventListener('click', () => { closeAuth(); openOrders(); });
    $('auOut').addEventListener('click', async () => { await db.auth.signOut(); renderAuth(); });
    return;
  }

  $('authTitle').textContent = 'Sign in';
  if (authMode === 'code') {
    body.innerHTML = `
      <p class="authNote">Enter the 6-digit code sent to<br><b>${esc(authEmail)}</b> — check spam too.</p>
      <input id="auCode" class="authField codeInput" inputmode="numeric" maxlength="6" placeholder="••••••">
      <button class="btn btnGold big" id="auVerify" style="margin-top:12px">Verify & Continue</button>
      <button class="linkBtn" id="auBack">Change email</button>`;
    $('auCode').focus();
    $('auVerify').addEventListener('click', async () => {
      const token = $('auCode').value.trim();
      if (token.length < 6) return alert('Enter the 6-digit code.');
      const { error } = await db.auth.verifyOtp({ email: authEmail, token, type: 'email' });
      if (error) return alert(error.message);
      closeAuth();
    });
    $('auBack').addEventListener('click', () => { authMode = 'email'; renderAuth(); });
    return;
  }

  body.innerHTML = `
    <button class="gBtn" id="auGoogle"><span class="gIcon">G</span> Continue with Google</button>
    <div class="orLine">or use your email</div>
    <input id="auEmail" class="authField" type="email" placeholder="you@example.com" value="${esc(authEmail)}">
    ${authMode === 'password' ? `<input id="auPass" class="authField" type="password" placeholder="Password">` : ''}
    <button class="btn btnGold big" id="auGo" style="margin-top:12px">${authMode === 'password' ? 'Sign In' : 'Continue'}</button>
    ${authMode === 'email'
      ? `<p class="authNote">We'll email you a 6-digit code. New here? Your account is created automatically.</p>
         <button class="linkBtn" id="auTogglePw">Sign in with password instead</button>`
      : `<button class="linkBtn" id="auTogglePw">Email me a code instead</button>`}`;

  $('auGoogle').addEventListener('click', async () => {
    const { error } = await db.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) alert(error.message);
  });
  $('auTogglePw').addEventListener('click', () => {
    authMode = authMode === 'password' ? 'email' : 'password';
    authEmail = $('auEmail').value.trim().toLowerCase();
    renderAuth();
  });
  $('auGo').addEventListener('click', async () => {
    authEmail = $('auEmail').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(authEmail)) return alert('Enter a valid email address.');
    if (authMode === 'password') {
      const pw = $('auPass').value;
      if (pw.length < 6) return alert('Password is at least 6 characters.');
      const { error } = await db.auth.signInWithPassword({ email: authEmail, password: pw });
      if (error) return alert(error.message);
      closeAuth();
    } else {
      const { error } = await db.auth.signInWithOtp({
        email: authEmail, options: { shouldCreateUser: true },
      });
      if (error) return alert(error.message);
      authMode = 'code';
      renderAuth();
    }
  });
}

db.auth.onAuthStateChange((_event, s) => {
  session = s;
  $('authBtn').textContent = s ? '✅' : '👤';
  if (!$('authModal').hidden) renderAuth();
});
db.auth.getSession().then(({ data }) => {
  session = data.session;
  $('authBtn').textContent = session ? '✅' : '👤';
});

$('bookForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const doc = doctors.find((d) => d.id === $('bDoctor').value);
  const phone = $('bPhone').value.replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) { alert('Please enter a valid 10-digit mobile number.'); return; }
  const L = [];
  L.push(`🩺 *Appointment Request — ${settings.hospital_name}* (website)`);
  L.push('');
  L.push(`Doctor: *${doc?.name ?? ''}*`);
  L.push(`Service: ${$('bService').value}`);
  L.push(`Type: ${$('bType').value === 'online' ? 'Online (video)' : 'In-person visit'}`);
  L.push(`Date: ${$('bDate').value}`);
  L.push(`Time: ${$('bTime').value}`);
  L.push(`Fee: ${$('bFee').value}`);
  if ($('bNotes').value.trim()) L.push(`Notes: ${$('bNotes').value.trim()}`);
  L.push('');
  L.push(`👤 Patient: ${$('bName').value.trim()}`);
  L.push(`📞 ${phone}`);
  window.open(`https://wa.me/${settings.whatsapp}?text=${encodeURIComponent(L.join('\n'))}`, '_blank');
});

// ---------------- scroll reveal ----------------
const revealObs = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
  { threshold: 0.12 },
);
document.querySelectorAll('.reveal').forEach((el) => revealObs.observe(el));

// ---------------- live refresh ----------------
loadAll();
syncMyOrders();
setInterval(loadAll, 60_000);          // full refresh every minute
setInterval(loadQueue, 30_000);        // queue every 30s
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadAll();
});
