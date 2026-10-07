// app.js — Sri Sai Hospital website core.
// Reads LIVE from the same Supabase backend as the Android app. Anything
// changed in the admin app (medicines, doctors, settings, banners…) appears
// here automatically: catalog refreshes every 60s + on tab focus, the OPD
// queue widget every 30s while Home is visible.
//
// Layout: index.html holds five hash-routed screens (#home #pharmacy #book
// #token #orders) + overlay sheets; every renderer re-runs on 'langchange'.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { t, getLang, setLang, initLang, onLangChange } from './i18n.js';
import * as ui from './ui.js';

const { $, esc, inr } = ui;

const SUPABASE_URL = 'https://blpptbmezfzkdctzxafs.supabase.co';
const ANON_KEY = 'sb_publishable_P40MX5RdTrjKVFPtDzod4A_cXrgiIKf';
export const db = createClient(SUPABASE_URL, ANON_KEY);

// ---------------- persistence ----------------
const LS = {
  cart: 'srisai-web-cart',
  profile: 'srisai-web-profile',
  orders: 'srisai-web-orders',
  tokens: 'srisai-web-tokens',
  appts: 'srisai-web-appts',
  theme: 'srisai-theme',
};
const readLS = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
};
const writeLS = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ } };

// ---------------- state ----------------
export const state = {
  settings: null,
  categories: [],
  medicines: [],
  doctors: [],
  services: [],
  banners: [],
  session: null,
  loaded: false,          // first successful loadAll()
  loadError: false,       // last loadAll() had a failed read
  activeCat: null,
  query: '',
  payMethod: 'upi',
  coupon: null,           // { code, discount }
  placing: false,
  ordersFilter: 'all',
  route: { name: 'home', sub: null, params: new URLSearchParams() },
  cart: readLS(LS.cart, {}),           // { [medicineId]: qty }
  profile: readLS(LS.profile, {}),     // { name, phone, address, city, pincode }
  orders: readLS(LS.orders, []),       // Order[] newest first (max 30)
  tokens: readLS(LS.tokens, []),       // Token[] (max 10)
  appts: readLS(LS.appts, []),         // guest Appt[]
};
export const saveCart = () => writeLS(LS.cart, state.cart);
export const saveProfile = () => writeLS(LS.profile, state.profile);
export const saveOrders = () => writeLS(LS.orders, state.orders.slice(0, 30));
export const saveTokens = () => writeLS(LS.tokens, state.tokens.slice(0, 10));
export const saveAppts = () => writeLS(LS.appts, state.appts);

// Local calendar date YYYY-MM-DD (NOT toISOString — UTC shifts the day after 18:30 IST).
export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const telHref = (phone) => `tel:${String(phone ?? '').replace(/\s/g, '')}`;
const waHref = (text) => {
  const base = `https://wa.me/${digits(state.settings?.whatsapp)}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
};
const safeColor = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(String(c ?? '')) ? c : fallback);
const hospitalName = () => state.settings?.hospital_name ?? 'Sri Sai Hospital';

// UPI deep link — encodeURIComponent per field (URLSearchParams breaks UPI apps with '+').
export function upiUrl(amount, note) {
  const s = state.settings ?? {};
  const f = [
    ['pa', s.upi_vpa], ['pn', s.upi_name || s.hospital_name],
    ['am', Number(amount).toFixed(2)], ['cu', 'INR'], ['tn', String(note).slice(0, 70)],
  ];
  return 'upi://pay?' + f.map(([k, v]) => `${k}=${encodeURIComponent(v ?? '')}`).join('&');
}

// Staff-facing WhatsApp order message — same format the app sends (English on purpose).
export function waOrderMessage(o) {
  const L = [];
  L.push(`🛒 *New Medicine Order — ${hospitalName()}* (website)`);
  L.push(`Order No: *${o.orderNumber}*`);
  L.push('');
  o.items.forEach((it, i) => L.push(`${i + 1}. ${it.name} x${it.qty} — ${inr(it.price * it.qty)}`));
  L.push('');
  L.push(`*Total: ${inr(o.total)}*`);
  L.push(`Payment: ${o.payMethod === 'cod' ? 'Cash on Delivery' : String(o.payMethod).toUpperCase()}`);
  L.push('');
  L.push(`👤 ${o.name} · 📞 ${o.phone}`);
  L.push(`📍 ${o.address}, ${o.city} - ${o.pincode}`);
  return L.join('\n');
}

// ---------------- theme ----------------
const html = document.documentElement;
function isDark() {
  const saved = html.dataset.theme;
  if (saved) return saved === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function paintThemeIcons() {
  const ico = isDark() ? '☀️' : '🌙';
  document.querySelectorAll('[data-theme-toggle] .ico').forEach((el) => { el.textContent = ico; });
}
function initTheme() {
  const saved = localStorage.getItem(LS.theme);
  if (saved === 'light' || saved === 'dark') html.dataset.theme = saved;
  paintThemeIcons();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeIcons);
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    html.dataset.theme = next;
    localStorage.setItem(LS.theme, next);
    paintThemeIcons();
  }));
}

// ---------------- segmented controls ----------------
function moveThumb(seg) {
  const thumb = seg.querySelector('.seg-thumb');
  const on = seg.querySelector('.seg-btn[aria-checked="true"]');
  if (!thumb || !on || on.offsetWidth === 0) return;
  thumb.style.width = on.offsetWidth + 'px';
  thumb.style.transform = `translateX(${on.offsetLeft - 3}px)`;
}
const segObs = new ResizeObserver((entries) => entries.forEach((e) => moveThumb(e.target)));

// initSeg(seg, onPick): click + ←/→ keyboard; onPick(btn) decides state (call setSegValue to reflect).
export function initSeg(seg, onPick) {
  const btns = [...seg.querySelectorAll('.seg-btn')];
  btns.forEach((b, i) => {
    b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1;
    b.addEventListener('click', () => onPick(b));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
      n.focus();
      onPick(n);
    });
  });
  segObs.observe(seg);
  moveThumb(seg);
}
export function setSegValue(seg, attr, value) {
  seg.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset[attr] === value;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  moveThumb(seg);
}
function syncLangSegs() {
  document.querySelectorAll('.seg-lang').forEach((seg) => setSegValue(seg, 'lang', getLang()));
}
function initLangSegs() {
  document.querySelectorAll('.seg-lang').forEach((seg) => initSeg(seg, (b) => {
    if (b.dataset.lang === getLang()) return;
    setLang(b.dataset.lang);
    ui.toast(t('lang.changed'), 'info');
  }));
  syncLangSegs();
}

// ---------------- router ----------------
const SCREENS = ['home', 'pharmacy', 'book', 'token', 'orders'];
export function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const [path, qs] = raw.split('?');
  const [name, sub] = path.split('/');
  return { name: SCREENS.includes(name) ? name : 'home', sub: sub || null, params: new URLSearchParams(qs || '') };
}
const SCREEN_RENDER = {
  home: () => renderHome(),
  pharmacy: () => renderPharmacy(),
  book: () => renderBook(),
  token: () => renderToken(),
  orders: () => renderOrders(),
};
export function router() {
  const r = parseHash();
  const prev = state.route;
  state.route = r;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.dataset.screen === r.name));
  document.querySelectorAll('.hdr-nav a, .bottombar .bb-item[href]').forEach((a) => {
    if (a.getAttribute('href') === '#' + r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (ui.currentSheet() && ui.currentSheet() !== 'sheetConfirm') ui.closeSheet();
  if (r.name === 'home' && r.sub) {
    requestAnimationFrame(() => $(r.sub)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } else if (prev.name !== r.name || !r.sub) {
    window.scrollTo({ top: 0 });
  }
  SCREEN_RENDER[r.name]?.();
  if (r.name === 'home') startQueuePoll(); else stopQueuePoll();
}

// ---------------- data loading ----------------
const safe = (p) => p.then((r) => r, (e) => ({ data: null, error: e }));
let errorToasted = false;

export async function loadAll() {
  if (!state.loaded) renderSkeletons();
  const [st, cats, meds, docs, svcs, bans] = await Promise.all([
    safe(db.from('settings').select('*').eq('id', 1).maybeSingle()),
    safe(db.from('categories').select('*').eq('is_active', true).order('sort_order')),
    safe(db.from('medicines').select('*').eq('is_active', true).order('name').limit(500)),
    safe(db.from('doctors').select('*').eq('is_active', true).order('sort_order')),
    safe(db.from('services').select('*').eq('is_active', true).order('sort_order')),
    safe(db.from('banners').select('*').eq('is_active', true).order('sort_order')),
  ]);
  const failed = [st, cats, meds, docs, svcs, bans].some((r) => r.error);
  if (st.data) state.settings = st.data;
  if (!cats.error) state.categories = cats.data ?? [];
  if (!meds.error) state.medicines = meds.data ?? [];
  if (!docs.error) state.doctors = docs.data ?? [];
  if (!svcs.error) state.services = svcs.data ?? [];
  if (!bans.error) state.banners = bans.data ?? [];
  state.loadError = failed;
  if (failed && !errorToasted) { errorToasted = true; ui.toast(t('common.errorGeneric'), 'err'); }
  if (!failed || state.settings) state.loaded = true;
  renderAll();
}

function renderSkeletons() {
  $('docGrid').innerHTML = ui.skeleton('card', 3);
  $('svcGrid').innerHTML = ui.skeleton('card', 2);
  $('stats').innerHTML = `<div class="span-6">${ui.skeleton('line', 4)}</div>`;
  $('offers').hidden = false;
  $('carTrack').innerHTML = `<div class="car-slide" style="background:none;box-shadow:none;padding:0">${ui.skeleton('banner', 1)}</div>`;
  $('grid').innerHTML = ui.skeleton('card', 6);
}

// ---------------- render: everything ----------------
export function renderAll() {
  renderChrome();
  renderCartBadge();
  SCREEN_RENDER[state.route.name]?.();
  if (ui.currentSheet() === 'sheetCart') renderCart();
  if (ui.currentSheet() === 'sheetAccount') renderAccount();
}

// Title, brand, footer, FAB, quick-action links — anything outside a screen.
function renderChrome() {
  const s = state.settings;
  const name = hospitalName();
  document.title = `${name} — ${t('app.titleSuffix')}`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', `${name} — ${t('app.description')}`);
  $('brandName').textContent = name;
  $('footName').textContent = name;
  $('footTagline').textContent = s?.tagline ?? '';
  $('footRights').textContent = t('footer.rights', { year: new Date().getFullYear(), name });
  if (s) {
    const tel = telHref(s.phone);
    $('quickCall').href = tel;
    $('menuCall').href = tel;
    $('quickWa').href = waHref();
    $('menuWa').href = waHref();
    $('waFab').href = waHref(`Hello ${name} 🙏`);
  }
}

// ---------------- render: HOME ----------------
export function renderHome() {
  renderTicker();
  renderHero();
  renderBanners();
  renderStats();
  renderDoctors();
  renderServices();
  renderContact();
  renderQueue();
  ui.reveal();
}

function renderTicker() {
  const s = state.settings;
  const bar = $('ticker');
  const inner = $('tickerText');
  const text = (s?.announcement ?? '').trim();
  bar.hidden = !text;
  if (!text) return;
  inner.textContent = `📢 ${text}`;
  inner.classList.remove('marquee');
  requestAnimationFrame(() => inner.classList.toggle('marquee', inner.scrollWidth > bar.clientWidth));
}

function renderHero() {
  const s = state.settings;
  if (!s) return;
  $('recognition').textContent = s.recognition ?? '';
  $('tagline').textContent = s.tagline ?? '';
  $('subTagline').textContent = s.sub_tagline ?? '';
  $('patientsNote').textContent = s.patients_note ?? '';
  $('badges').innerHTML = (Array.isArray(s.badges) ? s.badges : []).map((b) => `<span>${esc(b)}</span>`).join('');
}

// --- banner carousel: scroll-snap track, dots, 5s auto-advance paused on hover/touch/hidden tab
let carTimer = null;
let carPaused = false;
let carIdx = 0;
function carSlides() { return [...$('carTrack').querySelectorAll('.car-slide')]; }
function carGo(i, smooth = true) {
  const slides = carSlides();
  if (!slides.length) return;
  carIdx = (i + slides.length) % slides.length;
  $('carTrack').scrollTo({ left: slides[carIdx].offsetLeft - $('carTrack').offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
  paintDots();
}
function paintDots() {
  $('carDots').querySelectorAll('button').forEach((d, i) => {
    if (i === carIdx) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current');
  });
}
function startCarousel() {
  clearInterval(carTimer);
  if (state.banners.length < 2) return;
  carTimer = setInterval(() => { if (!carPaused && !document.hidden) carGo(carIdx + 1); }, 5000);
}
function renderBanners() {
  const sec = $('offers');
  const track = $('carTrack');
  const list = state.banners;
  if (!state.loaded && !list.length) return; // skeleton stays until first load
  if (list.length === 0) { sec.hidden = true; clearInterval(carTimer); return; }
  sec.hidden = false;
  const keep = Math.min(carIdx, list.length - 1);
  track.innerHTML = list.map((b, i) => {
    const from = safeColor(b.color_from, '#0f4c75');
    const to = safeColor(b.color_to, '#3282b8');
    const cta = b.action === 'shop'
      ? `<a class="btn btn-gold sm" href="#pharmacy"><span class="lbl">${esc(t('home.shopNow'))}</span></a>`
      : b.action === 'book'
        ? `<a class="btn btn-gold sm" href="#book"><span class="lbl">${esc(t('home.bookNow'))}</span></a>`
        : '';
    return `<article class="car-slide" data-idx="${i}" style="background:linear-gradient(135deg,${from},${to})">
      <div class="car-media">${b.image_url ? `<img src="${esc(b.image_url)}" alt="" loading="lazy">` : `<span aria-hidden="true">${esc(b.emoji || '🌿')}</span>`}</div>
      <div class="car-text"><h3>${esc(b.title)}</h3><p>${esc(b.subtitle ?? '')}</p>${cta}</div>
    </article>`;
  }).join('');
  $('carDots').innerHTML = list.length > 1
    ? list.map((_, i) => `<button type="button" data-dot="${i}" aria-label="${esc(t('home.bannerDot', { n: i + 1 }))}"></button>`).join('')
    : '';
  $('carDots').querySelectorAll('[data-dot]').forEach((d) => d.addEventListener('click', () => carGo(Number(d.dataset.dot))));
  carIdx = keep;
  carGo(carIdx, false);
  startCarousel();
}
function initCarousel() {
  const track = $('carTrack');
  const car = $('carousel');
  let scrollT;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const slides = carSlides();
      if (!slides.length) return;
      const w = slides[0].offsetWidth + 16;
      const i = Math.round(track.scrollLeft / w);
      if (i !== carIdx && i >= 0 && i < slides.length) { carIdx = i; paintDots(); }
    }, 80);
  }, { passive: true });
  car.addEventListener('mouseenter', () => { carPaused = true; });
  car.addEventListener('mouseleave', () => { carPaused = false; });
  car.addEventListener('touchstart', () => { carPaused = true; }, { passive: true });
  car.addEventListener('touchend', () => { setTimeout(() => { carPaused = false; }, 1500); }, { passive: true });
  car.addEventListener('focusin', () => { carPaused = true; });
  car.addEventListener('focusout', () => { carPaused = false; });
}

// --- stats with count-up (once, when visible)
let statsAnimated = false;
function renderStats() {
  const s = state.settings;
  if (!s && !state.loaded) return;
  const stats = Array.isArray(s?.stats) ? s.stats : [];
  const sec = $('statsSec');
  sec.hidden = stats.length === 0;
  if (!stats.length) return;
  $('stats').innerHTML = stats.map((x) =>
    `<div class="card tile stat"><b data-target="${esc(x.value)}">${statsAnimated ? esc(x.value) : '0'}</b><span>${esc(x.label)}</span></div>`).join('');
  if (statsAnimated) return;
  const obs = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting) || statsAnimated) return;
    statsAnimated = true;
    obs.disconnect();
    $('stats').querySelectorAll('b').forEach((el) => ui.countUp(el, el.dataset.target));
  }, { threshold: 0.4 });
  obs.observe($('stats'));
}

// --- doctors
function renderDoctors() {
  if (!state.loaded) return;
  const list = state.doctors;
  const grid = $('docGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty span-6"><span class="empty-ico" aria-hidden="true">🧑‍⚕️</span><h3>${esc(t('home.noDoctors'))}</h3></div>`;
    return;
  }
  grid.innerHTML = list.map((d) => {
    const id = encodeURIComponent(d.id);
    const tags = (Array.isArray(d.expertise) ? d.expertise : []).slice(0, 4);
    return `<article class="card lift dcard">
      <div class="dhead">
        <div class="avatar">${d.image_url ? `<img src="${esc(d.image_url)}" alt="${esc(t('a11y.doctorPhoto'))}" loading="lazy">` : esc(d.emoji || '🧑‍⚕️')}</div>
        <div style="min-width:0">
          <h3>${esc(d.name)}</h3>
          <div class="dspec">${esc(d.specialty ?? '')}</div>
          <div class="dqual">${esc(d.qualifications ?? '')}</div>
        </div>
      </div>
      ${tags.length ? `<div class="tags">${tags.map((e) => `<span>${esc(e)}</span>`).join('')}</div>` : ''}
      ${d.bio ? `<div><p class="bio" data-bio>${esc(d.bio)}</p><button type="button" class="btn btn-link sm" data-more>${esc(t('common.readMore'))}</button></div>` : ''}
      <div class="btn-row">
        <a class="btn btn-teal sm" href="#book?doctor=${id}"><span class="ico" aria-hidden="true">📅</span><span class="lbl">${esc(t('home.bookWith'))}</span></a>
        <a class="btn btn-gold sm" href="#token?doctor=${id}"><span class="ico" aria-hidden="true">🎫</span><span class="lbl">${esc(t('home.tokenWith'))}</span></a>
        ${d.phone ? `<a class="btn btn-ghost sm" href="${esc(telHref(d.phone))}"><span class="ico" aria-hidden="true">📞</span><span class="lbl">${esc(t('common.call'))}</span></a>` : ''}
      </div>
    </article>`;
  }).join('');
  grid.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => {
    const bio = b.parentElement.querySelector('[data-bio]');
    const open = bio.classList.toggle('open');
    b.textContent = t(open ? 'common.readLess' : 'common.readMore');
  }));
}

// --- services
function renderServices() {
  if (!state.loaded) return;
  const list = state.services;
  const grid = $('svcGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><span class="empty-ico" aria-hidden="true">🩺</span><h3>${esc(t('home.noServices'))}</h3></div>`;
    return;
  }
  grid.innerHTML = list.map((s) => `
    <article class="card lift scard">
      <span class="ico" aria-hidden="true">${esc(s.emoji || '🩺')}</span>
      <h3>${esc(s.name)}</h3>
      <p>${esc(s.description ?? '')}</p>
    </article>`).join('');
}

// --- contact bento
function renderContact() {
  const s = state.settings;
  if (!s) return;
  const tiles = [];
  if (s.address) {
    tiles.push(`<div class="card tile span-3"><span class="ico" aria-hidden="true">📍</span><span class="lbl">${esc(t('home.address'))}</span><span class="val">${esc(s.address)}</span>
      <a class="btn btn-ghost sm" href="https://maps.google.com/?q=${encodeURIComponent(s.address)}" target="_blank" rel="noopener"><span class="ico" aria-hidden="true">🗺️</span><span class="lbl">${esc(t('home.directions'))}</span></a></div>`);
  }
  if (s.phone) {
    tiles.push(`<div class="card tile span-3"><span class="ico" aria-hidden="true">📞</span><span class="lbl">${esc(t('home.phone'))}</span><a class="val" href="${esc(telHref(s.phone))}">${esc(s.phone)}</a></div>`);
  }
  if (s.whatsapp) {
    tiles.push(`<div class="card tile span-3"><span class="ico" aria-hidden="true">💬</span><span class="lbl">${esc(t('home.whatsapp'))}</span><a class="val" href="${esc(waHref())}" target="_blank" rel="noopener">${esc(t('home.chat'))}</a></div>`);
  }
  if (s.email) {
    tiles.push(`<div class="card tile span-3"><span class="ico" aria-hidden="true">✉️</span><span class="lbl">${esc(t('home.email'))}</span><a class="val" href="mailto:${esc(s.email)}">${esc(s.email)}</a></div>`);
  }
  $('contactGrid').innerHTML = tiles.join('');
  $('contact').hidden = tiles.length === 0;
}

// --- live OPD queue widget (home) — queue_status per doctor, 30s while home + tab visible
let queueTimer = null;
let queueData = {}; // doctorId -> { serving_no, last_issued, waiting_count }
async function loadQueue() {
  if (!state.doctors.length || document.hidden || state.route.name !== 'home') return;
  const next = {};
  await Promise.all(state.doctors.map(async (d) => {
    try {
      const { data } = await db.rpc('queue_status', { p_doctor_id: d.id });
      if (data && data.last_issued != null) next[d.id] = data;
    } catch { /* keep hidden */ }
  }));
  queueData = next;
  renderQueue();
}
function renderQueue() {
  const sec = $('queueWidget');
  const cards = state.doctors.filter((d) => queueData[d.id]);
  sec.hidden = cards.length === 0;
  if (!cards.length) return;
  $('queueGrid').innerHTML = cards.map((d) => {
    const q = queueData[d.id];
    const serving = q.serving_no != null ? `#${esc(q.serving_no)}` : esc(t('home.notStarted'));
    return `<article class="card qcard">
      <h3>${esc(d.name)}</h3>
      <span class="dqual">${esc(t('home.nowServing'))}</span>
      <div class="qnow">${serving}</div>
      <div class="qmeta"><span>${esc(t('home.lastToken'))} #${esc(q.last_issued)}</span><span>${esc(t('home.waiting', { n: q.waiting_count ?? 0 }))}</span></div>
      <a class="btn btn-teal sm" href="#token?doctor=${encodeURIComponent(d.id)}" style="align-self:flex-start"><span class="ico" aria-hidden="true">🎫</span><span class="lbl">${esc(t('home.takeToken'))}</span></a>
    </article>`;
  }).join('');
}
function startQueuePoll() {
  stopQueuePoll();
  loadQueue();
  queueTimer = setInterval(loadQueue, 30_000);
}
function stopQueuePoll() { clearInterval(queueTimer); queueTimer = null; }

// ---------------- cart badge (cart logic lands in FEAT-002) ----------------
export function cartCount() {
  return Object.values(state.cart).reduce((a, b) => a + Number(b || 0), 0);
}
export function renderCartBadge(bumpIt = false) {
  const n = cartCount();
  ['cartCount', 'cartCountBar'].forEach((id) => {
    const el = $(id);
    el.hidden = n === 0;
    el.textContent = n;
    if (bumpIt && n > 0) ui.bump(el);
  });
  $('cartBtn').setAttribute('aria-label', n ? t('a11y.cartCount', { n }) : t('a11y.openCart'));
}

// ---------------- screen shells (filled by later FEATs) ----------------
const emptyState = (ico, title, sub = '', btn = '') =>
  `<div class="empty"><span class="empty-ico" aria-hidden="true">${ico}</span><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}${btn}</div>`;

// Pharmacy: category chips + delivery note now; product cards come in FEAT-002.
export function renderPharmacy() {
  const s = state.settings;
  $('deliveryNote').textContent = s
    ? `${t('shop.freeDeliveryAbove', { amount: inr(s.free_delivery_above ?? 0) })} · ${t('shop.rxNote')}`
    : '';
  const mk = (id, label, emoji) =>
    `<button type="button" class="chip ${state.activeCat === id ? 'on' : ''}" aria-pressed="${state.activeCat === id}" data-cat="${esc(id ?? '')}">${emoji ? `<span aria-hidden="true">${esc(emoji)}</span>` : ''}${esc(label)}</button>`;
  $('cats').innerHTML = mk(null, t('shop.all'), '') + state.categories.map((c) => mk(c.id, c.name, c.emoji)).join('');
  $('cats').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    state.activeCat = b.dataset.cat || null;
    renderPharmacy();
  }));
  const grid = $('grid');
  if (!state.loaded) { grid.innerHTML = ui.skeleton('card', 6); return; }
  if (state.loadError && !state.medicines.length) {
    grid.innerHTML = emptyState('⚠️', t('shop.loadError'), '', `<button type="button" class="btn btn-teal" data-retry><span class="lbl">${esc(t('common.retry'))}</span></button>`);
    grid.querySelector('[data-retry]')?.addEventListener('click', () => { grid.innerHTML = ui.skeleton('card', 6); loadAll(); });
    return;
  }
  if (!state.medicines.length) { grid.innerHTML = emptyState('💊', t('shop.emptyCatalog')); return; }
  grid.innerHTML = ''; // FEAT-002 renders .pcard list + search/filter here
}

// Cart sheet: FEAT-002 adds lines/stepper/checkout; today a read-only summary.
export function renderCart() {
  const body = $('cartBody');
  $('cartFoot').hidden = true;
  const lines = Object.entries(state.cart)
    .map(([id, qty]) => ({ m: state.medicines.find((x) => x.id === id), qty: Number(qty) }))
    .filter((l) => l.m && l.qty > 0);
  if (!lines.length) {
    body.innerHTML = emptyState('🛒', t('cart.empty'), t('cart.emptySub'),
      `<a class="btn btn-teal" href="#pharmacy" data-close-sheet><span class="lbl">${esc(t('cart.browse'))}</span></a>`);
    return;
  }
  body.innerHTML = `<ul style="list-style:none;margin:0;padding:0">${lines.map(({ m, qty }) =>
    `<li style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)"><span>${esc(m.name)} <span class="muted">× ${qty}</span></span><b>${inr(Number(m.price) * qty)}</b></li>`).join('')}</ul>
    <p class="muted" style="margin-top:12px;font-size:var(--fs-sm)">${esc(t('cart.estimate'))}</p>`;
}

// Book: "how it works" + my-appointments empty state; the form arrives in FEAT-005.
export function renderBook() {
  $('bookForm').innerHTML = '';
  $('bookHow').innerHTML = `<div class="card" style="padding:20px">
    <h3 style="font-family:var(--font-ui);font-size:var(--fs-md);margin-bottom:12px">${esc(t('book.howTitle'))}</h3>
    ${['📋', '💬', '🏥'].map((ico, i) => `<div style="display:flex;gap:12px;align-items:center;min-height:40px"><span class="ico" aria-hidden="true" style="font-size:22px">${ico}</span><span>${esc(t(`book.how${i + 1}`))}</span></div>`).join('')}
  </div>`;
  const appts = state.appts;
  $('myAppts').innerHTML = appts.length
    ? '' // FEAT-005 renders appointment cards
    : emptyState('📅', state.session ? t('book.empty') : t('book.signInToSee'), state.session ? t('book.emptySub') : '');
}

// Token: intro + note; form/live card arrive in FEAT-006.
export function renderToken() {
  $('tokenLive').innerHTML = '';
  $('tokenForm').innerHTML = emptyState('🎫', t('token.intro'), t('token.note'));
}

// Orders: filter seg + empty state; full cards/sync arrive in FEAT-004.
export function renderOrders() {
  const list = state.orders;
  $('ordersSync').textContent = '';
  const el = $('ordersList');
  if (!list.length) {
    el.innerHTML = emptyState('📦', t('orders.empty'), t('orders.emptySub'),
      `<a class="btn btn-teal" href="#pharmacy"><span class="lbl">${esc(t('cart.browse'))}</span></a>`);
    return;
  }
  const active = (o) => o.status !== 'delivered' && o.status !== 'cancelled';
  const shown = list.filter((o) => state.ordersFilter === 'all' ? true : state.ordersFilter === 'active' ? active(o) : !active(o));
  el.innerHTML = shown.map((o) => `<article class="card ocard" style="padding:16px;margin-bottom:12px;display:flex;justify-content:space-between;gap:12px;align-items:center">
      <div><b>${esc(o.orderNumber)}</b><div class="muted" style="font-size:var(--fs-sm)">${esc(t('orders.placedOn', { date: new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }))} · ${inr(o.total)}</div></div>
      <span class="pill pill-${esc(o.status)}">${esc(t(`orders.status.${o.status}`))}</span>
    </article>`).join('') || emptyState('📦', t('orders.empty'));
}

// Account sheet: FEAT-007 adds the sign-in flows; today shows session state only.
export function renderAccount() {
  const body = $('accountBody');
  const s = state.session;
  $('sheetAccountTitle').textContent = t(s ? 'account.title' : 'auth.title');
  if (s) {
    body.innerHTML = `<div class="card" style="padding:16px;text-align:center;margin-bottom:12px">
        <div style="font-size:30px" aria-hidden="true">🙏</div>
        <div class="muted" style="font-size:var(--fs-xs)">${esc(t('account.signedInAs'))}</div>
        <b>${esc(s.user.email ?? s.user.phone ?? '')}</b>
        <p class="muted" style="font-size:var(--fs-sm);margin-top:6px">${esc(t('account.sameApp'))}</p>
      </div>
      <a class="btn btn-ghost block" href="#orders"><span class="ico" aria-hidden="true">📦</span><span class="lbl">${esc(t('account.myOrders'))}</span></a>
      <button type="button" class="btn btn-link block" data-signout style="margin-top:8px">${esc(t('account.signOut'))}</button>`;
    body.querySelector('[data-signout]').addEventListener('click', async () => {
      await db.auth.signOut();
      ui.toast(t('account.signedOut'), 'ok');
      ui.closeSheet();
    });
    return;
  }
  body.innerHTML = emptyState('👤', t('auth.title'), t('auth.sub'));
}

// ---------------- auth state ----------------
function paintAuth() {
  $('accountDot').hidden = !state.session;
  if (ui.currentSheet() === 'sheetAccount') renderAccount();
}
db.auth.onAuthStateChange((_e, s) => { state.session = s; paintAuth(); renderBook(); });
db.auth.getSession().then(({ data }) => { state.session = data.session; paintAuth(); });

// ---------------- wiring ----------------
function initChrome() {
  $('skipLink').addEventListener('click', (e) => { e.preventDefault(); $('main').focus(); });
  const hdr = $('hdr');
  const onScroll = () => hdr.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  $('cartBtn').addEventListener('click', () => { renderCart(); ui.openSheet('sheetCart'); });
  $('cartBtnBar').addEventListener('click', () => { renderCart(); ui.openSheet('sheetCart'); });
  $('accountBtn').addEventListener('click', () => { renderAccount(); ui.openSheet('sheetAccount'); });
  $('menuAccount').addEventListener('click', () => { renderAccount(); ui.openSheet('sheetAccount'); });
  $('menuBtn').addEventListener('click', () => ui.openSheet('sheetMenu'));

  // links inside sheets that navigate: close the sheet first
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-close-sheet]');
    if (a) ui.closeSheet();
  });

  // orders filter seg (state only; FEAT-004 renders the list)
  const seg = $('ordersFilter');
  initSeg(seg, (b) => { state.ordersFilter = b.dataset.filter; setSegValue(seg, 'filter', b.dataset.filter); renderOrders(); });

  // search field shell (FEAT-002 wires filtering); keep the clear button honest
  const search = $('search');
  const clear = $('searchClear');
  search.addEventListener('input', () => { state.query = search.value.trim(); clear.hidden = !search.value; });
  clear.addEventListener('click', () => { search.value = ''; state.query = ''; clear.hidden = true; search.focus(); renderPharmacy(); });
}

// ---------------- boot ----------------
initLang();
initTheme();
initChrome();
initCarousel();
initLangSegs();
router();
loadAll();

onLangChange(() => {
  syncLangSegs();
  renderAll();
});
window.addEventListener('hashchange', router);
setInterval(loadAll, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { loadAll(); if (state.route.name === 'home') loadQueue(); }
});
