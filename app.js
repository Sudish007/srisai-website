// app.js — Sri Sai Hospital website core.
// Reads LIVE from the same Supabase backend as the Android app. Anything
// changed in the admin app (medicines, doctors, settings, banners…) appears
// here automatically: catalog refreshes every 60s + on tab focus, the OPD
// queue widget every 30s while Home is visible.
//
// Layout: index.html holds five hash-routed screens (#home #pharmacy #book
// #token #orders) + overlay sheets; every renderer re-runs on 'langchange'.

import { t, getLang, setLang, initLang, onLangChange } from './i18n.js';
import { tc } from './content-i18n.js';
import * as ui from './ui.js';

const { $, esc, inr } = ui;

const SUPABASE_URL = 'https://blpptbmezfzkdctzxafs.supabase.co';
const ANON_KEY = 'sb_publishable_P40MX5RdTrjKVFPtDzod4A_cXrgiIKf';
// supabase-js (~94 KB gz, 3 round-trips from esm.sh) is loaded lazily with a dynamic
// import() so the static shell + cached data paint first; every call goes through safe().
let dbPromise = null;
export function getDb() {
  dbPromise ??= import('https://esm.sh/@supabase/supabase-js@2').then(({ createClient }) => createClient(SUPABASE_URL, ANON_KEY));
  return dbPromise;
}
const safe = (fn) => getDb().then(fn).then((r) => r, (e) => ({ data: null, error: e }));

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
  coupon: null,           // { code, discount, message }
  couponMsg: null,        // { text, ok } inline message under the coupon field
  placing: false,
  productId: null,        // medicine shown in #sheetProduct
  reviews: { id: null, rows: null, error: false },  // cache for the open product
  reviewDraft: { rating: 0, body: '' },
  successOrder: null,     // Order shown in the cart sheet's success view (null = normal cart)
  ordersFilter: 'all',
  route: { name: 'home', sub: null, params: new Map() },
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

// ---------------- images ----------------
// Supabase Storage can serve resized variants via /render/image/ — but only on paid plans
// (returns 403 otherwise). One HEAD probe per week decides; until it says yes we ship originals.
const IMG_PROBE_KEY = 'srisai-img-probe';
const IMG_PROBE_TTL = 7 * 24 * 3600 * 1000;
let imgTransformOk = (() => { const p = readLS(IMG_PROBE_KEY, null); return (p && Date.now() - p.ts < IMG_PROBE_TTL) ? !!p.ok : null; })();
const renderUrl = (url, w) => url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + (url.includes('?') ? '&' : '?') + `width=${w}&quality=70`;
const imgSrc = (url, w) => (imgTransformOk === true && /\/storage\/v1\/object\/public\//.test(url)) ? renderUrl(url, w) : url;
let imgProbing = false;
function probeImgTransform(sampleUrl) {
  if (imgTransformOk !== null || imgProbing || !sampleUrl || !/\/storage\/v1\/object\/public\//.test(sampleUrl)) return;
  imgProbing = true;
  fetch(renderUrl(sampleUrl, 64), { method: 'HEAD' })
    .then((r) => { imgTransformOk = r.ok; }, () => { imgTransformOk = false; })
    .then(() => { writeLS(IMG_PROBE_KEY, { ok: imgTransformOk, ts: Date.now() }); }); // next render picks it up; never forces one
}

// UPI deep link — encodeURIComponent per field (a form-encoded '+' breaks UPI apps).
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
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  // Always mirror the effective theme onto <html> so the `[data-theme="dark"]`
  // component overrides apply under system dark mode too, not only after a manual toggle.
  const apply = () => {
    const saved = localStorage.getItem(LS.theme);
    html.dataset.theme = (saved === 'light' || saved === 'dark') ? saved : (mq.matches ? 'dark' : 'light');
    paintThemeIcons();
  };
  apply();
  mq.addEventListener('change', apply);
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => {
    localStorage.setItem(LS.theme, isDark() ? 'light' : 'dark');
    apply();
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
// '#book?doctor=abc&x=1' → Map { doctor → 'abc', x → '1' } (use params.get(key)).
function parseQuery(qs) {
  const m = new Map();
  String(qs ?? '').split('&').filter(Boolean).forEach((pair) => {
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? '' : pair.slice(i + 1);
    try { m.set(decodeURIComponent(k), decodeURIComponent(v)); } catch { m.set(k, v); }
  });
  return m;
}
export function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const [path, qs] = raw.split('?');
  const [name, sub] = path.split('/');
  return { name: SCREENS.includes(name) ? name : 'home', sub: sub || null, params: parseQuery(qs) };
}
// force=true (langchange) re-renders even while the user is typing in a form.
const SCREEN_RENDER = {
  home: () => renderHome(),
  pharmacy: () => renderPharmacy(),
  book: (force) => renderBook(force),
  token: (force) => renderToken(force),
  orders: (force) => renderOrders(force),
};
export function router() {
  const r = parseHash();
  const prev = state.route;
  state.route = r;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.dataset.screen === r.name));
  document.documentElement.classList.remove('deep'); // head script hid the static home screen on deep links
  document.querySelectorAll('.hdr-nav a, .bottombar .bb-item[href]').forEach((a) => {
    if (a.getAttribute('href') === '#' + r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (ui.currentSheet() && ui.currentSheet() !== 'sheetConfirm') ui.closeSheet();
  // '#home/<id>' and '#book/my' scroll to a section after showing the screen.
  const anchor = r.name === 'home' ? r.sub : r.name === 'book' && r.sub === 'my' ? 'myApptsSec' : null;
  if (anchor) {
    requestAnimationFrame(() => $(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } else if (prev.name !== r.name || !r.sub) {
    window.scrollTo({ top: 0 });
  }
  // '#book?doctor=<id>' / '#token?doctor=<id>' preselect the doctor (once per navigation).
  const doc = r.params.get('doctor');
  if (doc && r.name === 'book') { bk.doctorId = doc; bk.success = false; delete bk.errors.doctor; }
  if (doc && r.name === 'token') { tk.doctorId = doc; delete tk.errors.doctor; }
  SCREEN_RENDER[r.name]?.();
  if (r.name === 'home') startQueuePoll(); else stopQueuePoll();
  if (r.name === 'orders') syncOrders();
}

// ---------------- data loading ----------------
// Stale-while-revalidate: the six public tables are mirrored into localStorage so a
// repeat visit paints real content before supabase-js has even been downloaded.
const CACHE_KEY = 'srisai-cache-v1';
const CACHE_TTL = 7 * 24 * 3600 * 1000;
const PUBLIC_TABLES = ['settings', 'categories', 'medicines', 'doctors', 'services', 'banners'];
let hadCache = false;
let errorToasted = false;

function hydrateFromCache() {
  const c = readLS(CACHE_KEY, null);
  if (!(c && typeof c.ts === 'number' && Date.now() - c.ts < CACHE_TTL && c.settings)) return false;
  for (const k of PUBLIC_TABLES) state[k] = c[k] ?? (k === 'settings' ? null : []);
  state.loaded = true;
  hadCache = true;
  return true;
}

export async function loadAll() {
  if (!state.loaded) renderSkeletons();
  const [st, cats, meds, docs, svcs, bans] = await Promise.all([
    safe((db) => db.from('settings').select('*').eq('id', 1).maybeSingle()),
    safe((db) => db.from('categories').select('*').eq('is_active', true).order('sort_order')),
    safe((db) => db.from('medicines').select('*').eq('is_active', true).order('name').limit(500)),
    safe((db) => db.from('doctors').select('*').eq('is_active', true).order('sort_order')),
    safe((db) => db.from('services').select('*').eq('is_active', true).order('sort_order')),
    safe((db) => db.from('banners').select('*').eq('is_active', true).order('sort_order')),
  ]);
  const results = { settings: st, categories: cats, medicines: meds, doctors: docs, services: svcs, banners: bans };
  const failed = Object.values(results).some((r) => r.error);
  let changed = false;
  let anyOk = false;
  for (const k of PUBLIC_TABLES) {
    const r = results[k];
    if (r.error || (k === 'settings' && !r.data)) continue;
    anyOk = true;
    const data = k === 'settings' ? r.data : (r.data ?? []);
    if (JSON.stringify(state[k]) !== JSON.stringify(data)) { state[k] = data; changed = true; }
  }
  if (anyOk) {
    const snap = { ts: Date.now() };
    for (const k of PUBLIC_TABLES) snap[k] = state[k];
    writeLS(CACHE_KEY, snap);
  }
  state.loadError = failed;
  if (failed && !errorToasted) {
    errorToasted = true;
    if (hadCache) ui.toast(t('common.offline'), 'info'); else ui.toast(t('common.errorGeneric'), 'err');
  }
  const first = !state.loaded;
  if (!failed || state.settings) state.loaded = true;
  if (first || changed) renderAll(); // the 60 s refresh no longer rebuilds the DOM when nothing changed
  if (!queueFetched) loadQueue(); // first boot: doctors arrive after router() already tried the widget
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
// langSwitch=true re-renders everything (incl. the order-success view); the periodic
// refresh leaves the success view alone and never yanks the caret out of a field.
export function renderAll(langSwitch = false) {
  renderChrome();
  renderCartBadge();
  renderCartBar();
  SCREEN_RENDER[state.route.name]?.(langSwitch);
  const typing = (id) => { const a = document.activeElement; return a && $(id)?.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName); };
  if (ui.currentSheet() === 'sheetCart' && !typing('sheetCart') && (langSwitch || !state.successOrder)) renderCart();
  if (ui.currentSheet() === 'sheetProduct' && !typing('sheetProduct')) renderProduct();
  if (ui.currentSheet() === 'sheetAccount' && (langSwitch || !typing('sheetAccount'))) renderAccount();
}

// Title, brand, footer, FAB, quick-action links — anything outside a screen.
function renderChrome() {
  const s = state.settings;
  const name = hospitalName();
  document.title = `${name} — ${t('app.titleSuffix')}`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', `${name} — ${t('app.description')}`);
  $('brandName').textContent = name;
  $('footName').textContent = name;
  $('footTagline').textContent = tc(s?.tagline ?? '');
  $('footRights').textContent = t('footer.rights', { year: new Date().getFullYear(), name });
  if (s) {
    const tel = telHref(s.phone);
    $('quickCall').href = tel;
    $('menuCall').href = tel;
    // target=_blank only once the href is a real wa.me link (until then a tap stays in-page at #contact)
    for (const [id, href] of [['quickWa', waHref()], ['menuWa', waHref()], ['waFab', waHref(t('home.waGreeting', { name }))]]) {
      const el = $(id);
      el.href = href;
      el.target = '_blank';
    }
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
  $('recognition').textContent = tc(s.recognition ?? '');
  $('tagline').textContent = tc(s.tagline ?? '');
  $('subTagline').textContent = tc(s.sub_tagline ?? '');
  $('patientsNote').textContent = tc(s.patients_note ?? '');
  $('badges').innerHTML = (Array.isArray(s.badges) ? s.badges : []).map((b) => `<span>${esc(tc(b))}</span>`).join('');
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
      <div class="car-media">${b.image_url ? `<img src="${esc(imgSrc(b.image_url, 192))}" alt="" width="96" height="96" loading="lazy" decoding="async">` : `<span aria-hidden="true">${esc(b.emoji || '🌿')}</span>`}</div>
      <div class="car-text"><h3>${esc(tc(b.title))}</h3><p>${esc(tc(b.subtitle ?? ''))}</p>${cta}</div>
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
    `<div class="card tile stat"><b data-target="${esc(x.value)}">${statsAnimated ? esc(x.value) : '0'}</b><span>${esc(tc(x.label))}</span></div>`).join('');
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
const bioOpen = new Set(); // doctor ids with "Read more" expanded — survives 60 s refresh + langchange
function renderDoctors() {
  if (!state.loaded) return;
  const list = state.doctors;
  const grid = $('docGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty span-6"><span class="empty-ico" aria-hidden="true">🧑‍⚕️</span><h3>${esc(t('home.noDoctors'))}</h3></div>`;
    return;
  }
  probeImgTransform(list.find((d) => d.image_url)?.image_url);
  grid.innerHTML = list.map((d) => {
    const id = encodeURIComponent(d.id);
    const tags = (Array.isArray(d.expertise) ? d.expertise : []).slice(0, 4);
    const open = bioOpen.has(String(d.id));
    return `<article class="card lift dcard" data-doc="${esc(d.id)}">
      <div class="dhead">
        <div class="avatar">${d.image_url ? `<img src="${esc(imgSrc(d.image_url, 128))}" alt="${esc(t('a11y.doctorPhoto'))}" width="64" height="64" loading="lazy" decoding="async">` : esc(d.emoji || '🧑‍⚕️')}</div>
        <div style="min-width:0">
          <h3>${esc(d.name)}</h3>
          <div class="dspec">${esc(tc(d.specialty ?? ''))}</div>
          <div class="dqual">${esc(tc(d.qualifications ?? ''))}</div>
        </div>
      </div>
      ${tags.length ? `<div class="tags">${tags.map((e) => `<span>${esc(tc(e))}</span>`).join('')}</div>` : ''}
      ${d.bio ? `<div><p class="bio ${open ? 'open' : ''}" data-bio>${esc(tc(d.bio))}</p><button type="button" class="btn btn-link sm" data-more aria-expanded="${open}">${esc(t(open ? 'common.readLess' : 'common.readMore'))}</button></div>` : ''}
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
    const id = b.closest('[data-doc]').dataset.doc;
    if (open) bioOpen.add(id); else bioOpen.delete(id);
    b.setAttribute('aria-expanded', String(open));
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
      <h3>${esc(tc(s.name))}</h3>
      <p>${esc(tc(s.description ?? ''))}</p>
    </article>`).join('');
}

// --- contact bento
function renderContact() {
  const s = state.settings;
  if (!s) return;
  const tiles = [];
  if (s.address) {
    tiles.push(`<div class="card tile span-3"><span class="ico" aria-hidden="true">📍</span><span class="lbl">${esc(t('home.address'))}</span><span class="val">${esc(tc(s.address))}</span>
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
let queueFetched = false; // at least one successful pass (doctors were known)
async function loadQueue() {
  if (!state.doctors.length || document.hidden || state.route.name !== 'home') return;
  queueFetched = true;
  const next = {};
  await Promise.all(state.doctors.map(async (d) => {
    const { data } = await safe((db) => db.rpc('queue_status', { p_doctor_id: d.id }));
    if (data && data.last_issued != null) next[d.id] = data;
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

// ---------------- cart badge (header + bottom bar) ----------------
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

// =====================================================================
// PHARMACY — search, category chips, product grid, mini cart bar
// =====================================================================
const medById = (id) => state.medicines.find((x) => String(x.id) === String(id));
const stockOf = (m) => Math.max(0, Number(m?.stock ?? 0));
const offPct = (m) => (Number(m.mrp) > Number(m.price) ? Math.round((Number(m.mrp) - Number(m.price)) / Number(m.mrp) * 100) : 0);
const qtyOf = (id) => Number(state.cart[id] || 0);

// Media box shared by cards, cart lines and the product sheet (image lazy-loaded, else emoji).
const mediaHtml = (m, cls = 'pmedia') =>
  `<span class="${cls}" aria-hidden="true">${m.image_url
    ? `<img src="${esc(imgSrc(m.image_url, 400))}" alt="" width="400" height="400" loading="lazy" decoding="async">`
    : `<span class="pemoji">${esc(m.emoji || '💊')}</span>`}</span>`;

const priceHtml = (m) =>
  `<span class="pprice"><b>${esc(inr(m.price))}</b>${offPct(m) ? `<s>${esc(inr(m.mrp))}</s>` : ''}</span>`;

// Stock line: In stock / Only N left / Out of stock ('' when plenty & compact).
function stockHtml(m, compact) {
  const st = stockOf(m);
  if (st <= 0) return `<span class="pstock out">${esc(t('shop.outOfStock'))}</span>`;
  if (st <= 5) return `<span class="pstock low">${esc(t('shop.onlyLeft', { n: st }))}</span>`;
  return compact ? '' : `<span class="pstock ok">${esc(t('shop.inStock'))}</span>`;
}

// ADD button or stepper for one medicine. Containers carry data-pact=<id> so a
// qty change re-paints every copy (grid card + product sheet) without a full re-render.
function actionHtml(m, { block = false } = {}) {
  const st = stockOf(m);
  const q = qtyOf(m.id);
  const cls = block ? 'btn btn-teal block' : 'btn btn-teal sm block';
  if (st <= 0) return `<button type="button" class="${block ? 'btn btn-ghost block' : 'btn btn-ghost sm block'}" disabled><span class="lbl">${esc(t('shop.outOfStock'))}</span></button>`;
  if (q <= 0) return `<button type="button" class="${cls}" data-add="${esc(m.id)}" aria-label="${esc(t('shop.addToCart'))}"><span class="ico" aria-hidden="true">＋</span><span class="lbl">${esc(t('shop.add'))}</span></button>`;
  return `<div class="stepper${block ? ' block' : ''}">
    <button type="button" class="step-dec" data-dec="${esc(m.id)}" aria-label="${esc(t('shop.decrease'))}">−</button>
    <b class="step-qty" aria-live="polite">${q}</b>
    <button type="button" class="step-inc" data-inc="${esc(m.id)}" aria-label="${esc(t('shop.increase'))}" ${q >= st ? 'disabled' : ''}>+</button>
  </div>`;
}
function bindActions(root) {
  root.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setQty(b.dataset.add, 1); }));
  root.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setQty(b.dataset.inc, qtyOf(b.dataset.inc) + 1); }));
  root.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setQty(b.dataset.dec, qtyOf(b.dataset.dec) - 1); }));
}
function repaintActions(id) {
  const m = medById(id);
  if (!m) return;
  document.querySelectorAll(`[data-pact="${CSS.escape(String(id))}"]`).forEach((el) => {
    el.innerHTML = actionHtml(m, { block: el.dataset.block === '1' });
    bindActions(el);
  });
}

function filteredMedicines() {
  const q = state.query.trim().toLowerCase();
  return state.medicines.filter((m) => {
    if (state.activeCat && String(m.category_id) !== String(state.activeCat)) return false;
    if (!q) return true;
    return `${m.name ?? ''} ${m.brand ?? ''} ${m.composition ?? ''}`.toLowerCase().includes(q);
  });
}

function pcardHtml(m) {
  const pct = offPct(m);
  return `<article class="card lift pcard" data-id="${esc(m.id)}">
    <button type="button" class="pbody" data-open="${esc(m.id)}">
      ${mediaHtml(m)}
      <span class="pbadges">${pct ? `<span class="pb off">${esc(t('shop.off', { pct }))}</span>` : ''}${m.requires_rx ? `<span class="pb rx">${esc(t('shop.rx'))}</span>` : ''}</span>
      <span class="pname">${esc(m.name)}</span>
      <span class="ppack">${esc(m.pack_size ?? m.brand ?? '')}</span>
      ${priceHtml(m)}
      <span class="pstockline">${stockHtml(m, true)}</span>
    </button>
    <div class="pact" data-pact="${esc(m.id)}">${actionHtml(m)}</div>
  </article>`;
}

export function renderPharmacy() {
  const s = state.settings;
  $('deliveryNote').textContent = s
    ? `${t('shop.freeDeliveryAbove', { amount: inr(s.free_delivery_above ?? 0) })} · ${t('shop.rxNote')}`
    : '';
  const mk = (id, label, emoji) =>
    `<button type="button" class="chip ${state.activeCat === id ? 'on' : ''}" aria-pressed="${state.activeCat === id}" data-cat="${esc(id ?? '')}">${emoji ? `<span aria-hidden="true">${esc(emoji)}</span>` : ''}${esc(label)}</button>`;
  const cats = [...state.categories].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
  $('cats').innerHTML = mk(null, t('shop.all'), '') + cats.map((c) => mk(String(c.id), tc(c.name), c.emoji)).join('');
  $('cats').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    state.activeCat = b.dataset.cat || null;
    renderPharmacy();
  }));
  // never rewrite the search box while the user is typing in it (60 s refresh / langchange)
  if (document.activeElement !== $('search') && $('search').value.trim() !== state.query) $('search').value = state.query;
  $('searchClear').hidden = !state.query;
  renderGrid();
  renderCartBar();
}

function renderGrid() {
  const grid = $('grid');
  const count = $('results');
  count.textContent = '';
  if (!state.loaded) { grid.innerHTML = ui.skeleton('card', 6); return; }
  if (state.loadError && !state.medicines.length) {
    grid.innerHTML = emptyState('⚠️', t('shop.loadError'), '', `<button type="button" class="btn btn-teal" data-retry><span class="lbl">${esc(t('common.retry'))}</span></button>`);
    grid.querySelector('[data-retry]')?.addEventListener('click', () => { grid.innerHTML = ui.skeleton('card', 6); loadAll(); });
    return;
  }
  if (!state.medicines.length) { grid.innerHTML = emptyState('💊', t('shop.emptyCatalog')); return; }
  const list = filteredMedicines();
  if (!list.length) { grid.innerHTML = emptyState('🔍', t('shop.empty'), t('shop.emptySub')); return; }
  count.textContent = t('shop.results', { n: list.length });
  grid.innerHTML = list.map(pcardHtml).join('');
  grid.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openProduct(b.dataset.open)));
  bindActions(grid);
}
const renderGridDebounced = ui.debounce(renderGrid, 300);

// Sticky mini cart bar on the pharmacy screen (CSS hides it ≥720px).
export function renderCartBar() {
  const bar = $('cartbar');
  const d = cartDetail();
  if (!d.count || state.route.name !== 'pharmacy') { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = `<span class="cb-txt"><span class="ico" aria-hidden="true">🛒</span> ${esc(t('common.items', { n: d.count }))} · ${esc(inr(d.total))}</span>
    <button type="button" class="btn btn-gold sm" data-open-cart><span class="lbl">${esc(t('shop.viewCart'))}</span></button>`;
  bar.querySelector('[data-open-cart]').addEventListener('click', openCart);
}

// =====================================================================
// CART STATE
// =====================================================================
// setQty: clamp to 0..stock, persist, bump badges, toast on add/remove, repaint.
export function setQty(id, qty) {
  const m = medById(id);
  if (!m) return;
  const st = stockOf(m);
  const before = qtyOf(id);
  let next = Math.max(0, Math.floor(Number(qty) || 0));
  if (next > st) { next = st; if (before >= st) ui.toast(t('shop.maxStock', { n: st }), 'info'); }
  if (next === before) { repaintActions(id); return; }
  if (next <= 0) delete state.cart[id]; else state.cart[id] = next;
  saveCart();
  renderCartBadge(next > before);
  if (before === 0 && next > 0) ui.toast(t('shop.added'), 'ok', 1800);
  else if (before > 0 && next === 0) ui.toast(t('shop.removed'), 'info', 1800);
  repaintActions(id);
  renderCartBar();
  if (ui.currentSheet() === 'sheetCart' && !state.successOrder) renderCart();
}

// Lines in the cart whose medicine still exists in the live catalog.
export function cartLines() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ m: medById(id), qty: Number(qty) }))
    .filter((l) => l.m && l.qty > 0);
}

// Client-side ESTIMATE of the bill. After place_order the server numbers win.
export function cartDetail() {
  const s = state.settings ?? {};
  const lines = cartLines();
  const subtotal = lines.reduce((a, { m, qty }) => a + Number(m.price) * qty, 0);
  const savings = lines.reduce((a, { m, qty }) => a + Math.max(0, Number(m.mrp ?? 0) - Number(m.price)) * qty, 0);
  const freeAbove = Number(s.free_delivery_above ?? 0);
  const feeBase = Number(s.delivery_fee ?? 0);
  const deliveryFee = lines.length && subtotal < freeAbove ? feeBase : 0;
  const discount = Math.min(subtotal, Math.max(0, Number(state.coupon?.discount ?? 0)));
  const total = Math.max(0, subtotal + deliveryFee - discount);
  const needsRx = lines.some(({ m }) => m.requires_rx);
  const count = lines.reduce((a, l) => a + l.qty, 0);
  return { lines, count, subtotal, savings, freeAbove, deliveryFee, discount, total, needsRx, moreForFree: Math.max(0, freeAbove - subtotal) };
}

export function openCart() {
  state.successOrder = null;
  renderCart();
  ui.openSheet('sheetCart', { onClose: () => { state.successOrder = null; } });
}

// =====================================================================
// PRODUCT SHEET (#sheetProduct) + reviews
// =====================================================================
export function openProduct(id) {
  const m = medById(id);
  if (!m) return;
  state.productId = String(m.id);
  if (state.reviews.id !== state.productId) {
    state.reviews = { id: state.productId, rows: null, error: false };
    state.reviewDraft = { rating: 0, body: '' };
    loadReviews(state.productId);
  }
  renderProduct();
  ui.openSheet('sheetProduct');
  $('productBody').scrollTop = 0;
}

async function loadReviews(id) {
  const { data, error } = await safe((db) => db.from('reviews').select('*').eq('medicine_id', id).eq('is_visible', true).order('created_at', { ascending: false }).limit(20));
  if (state.reviews.id !== String(id)) return; // user moved on
  state.reviews = { id: String(id), rows: error ? [] : (data ?? []), error: !!error };
  if (ui.currentSheet() === 'sheetProduct') renderReviews();
}

const starsHtml = (n) => {
  const k = Math.min(5, Math.max(0, Math.round(Number(n) || 0)));
  return `<span class="stars" aria-label="${esc(t('a11y.stars', { n: k }))}">${'★'.repeat(k)}${'☆'.repeat(5 - k)}</span>`;
};
const listHtml = (arr) => (Array.isArray(arr) ? arr : String(arr ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean);

export function renderProduct() {
  const m = medById(state.productId);
  const body = $('productBody');
  const foot = $('productFoot');
  if (!m) {
    body.innerHTML = emptyState('💊', t('shop.emptyCatalog'));
    foot.hidden = true;
    return;
  }
  const pct = offPct(m);
  const benefits = listHtml(m.benefits);
  const sec = (title, inner) => `<section class="psec"><h4>${esc(title)}</h4>${inner}</section>`;
  const keepScroll = body.scrollTop;
  body.innerHTML = `
    <div class="phero">
      ${mediaHtml(m, 'pmedia big')}
      <div class="pinfo">
        <span class="pbadges static">${pct ? `<span class="pb off">${esc(t('shop.off', { pct }))}</span>` : ''}${m.requires_rx ? `<span class="pb rx">${esc(t('shop.rx'))}</span>` : ''}</span>
        <h3>${esc(m.name)}</h3>
        <div class="pmeta">${m.brand ? `<span>${esc(t('product.brand'))}: <b>${esc(m.brand)}</b></span>` : ''}${m.pack_size ? `<span>${esc(t('product.pack'))}: <b>${esc(m.pack_size)}</b></span>` : ''}</div>
        <div class="pprice lg"><b>${esc(inr(m.price))}</b>${pct ? `<s>${esc(t('shop.mrp'))} ${esc(inr(m.mrp))}</s>` : ''}</div>
        ${stockHtml(m, false)}
      </div>
    </div>
    ${sec(t('product.about'), `<p>${esc(m.description?.trim() || t('product.noDescription'))}</p>`)}
    ${benefits.length ? sec(t('product.benefits'), `<ul class="plist">${benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`) : ''}
    ${m.dosage ? sec(t('product.dosage'), `<p>${esc(m.dosage)}</p>`) : ''}
    ${m.composition ? sec(t('product.ingredients'), `<p>${esc(m.composition)}</p>`) : ''}
    <section class="psec" id="reviewsSec"></section>`;
  renderReviews();
  body.scrollTop = keepScroll;
  foot.hidden = false;
  foot.innerHTML = `<div class="pfoot"><div class="pprice"><b>${esc(inr(m.price))}</b>${pct ? `<s>${esc(inr(m.mrp))}</s>` : ''}</div><div class="pact" data-pact="${esc(m.id)}" data-block="1">${actionHtml(m, { block: true })}</div></div>`;
  bindActions(foot);
}

function renderReviews() {
  const host = $('reviewsSec');
  const m = medById(state.productId);
  if (!host || !m) return;
  const r = state.reviews;
  const rows = r.rows ?? [];
  const avg = rows.length ? rows.reduce((a, x) => a + Number(x.rating || 0), 0) / rows.length : 0;
  const head = `<div class="rhead"><h4>${esc(t('product.reviews'))}</h4>${rows.length ? `<span class="ravg">${starsHtml(avg)} <b>${esc(avg.toFixed(1))}</b> <span class="muted">· ${esc(t('product.reviewCount', { n: rows.length }))}</span></span>` : ''}</div>`;
  let list;
  if (r.rows === null) list = ui.skeleton('line', 3);
  else if (!rows.length) list = `<div class="empty compact"><span class="empty-ico" aria-hidden="true">💬</span><h3>${esc(t('product.noReviews'))}</h3></div>`;
  else {
    list = `<ul class="rlist">${rows.map((x) => `<li class="review">
      <div class="rtop"><b>${esc(x.user_name || t('product.customer'))}</b>${starsHtml(Number(x.rating || 0))}</div>
      ${x.body ? `<p>${esc(x.body)}</p>` : ''}
      <time class="muted" datetime="${esc(x.created_at ?? '')}">${esc(x.created_at ? new Date(x.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')}</time>
    </li>`).join('')}</ul>`;
  }
  const d = state.reviewDraft;
  const write = state.session
    ? `<div class="rwrite">
        <h4>${esc(t('product.writeReview'))}</h4>
        <div class="rstars" role="radiogroup" aria-label="${esc(t('product.yourRating'))}">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star ${n <= d.rating ? 'on' : ''}" role="radio" aria-checked="${n === d.rating}" data-star="${n}" aria-label="${esc(t('a11y.stars', { n }))}">${n <= d.rating ? '★' : '☆'}</button>`).join('')}
        </div>
        <div class="field"><textarea id="reviewBody" maxlength="600" rows="3" placeholder="${esc(t('product.reviewPlaceholder'))}" aria-label="${esc(t('product.writeReview'))}">${esc(d.body)}</textarea><div class="field-err" role="alert" id="reviewErr"></div></div>
        <button type="button" class="btn btn-teal" data-submit-review><span class="lbl">${esc(t('product.submitReview'))}</span></button>
      </div>`
    : `<button type="button" class="btn btn-ghost block" data-signin-review><span class="ico" aria-hidden="true">👤</span><span class="lbl">${esc(t('product.signInToReview'))}</span></button>`;
  host.innerHTML = head + list + write;
  host.querySelectorAll('[data-star]').forEach((b) => b.addEventListener('click', () => {
    state.reviewDraft.rating = Number(b.dataset.star);
    state.reviewDraft.body = $('reviewBody')?.value ?? state.reviewDraft.body;
    renderReviews();
    host.querySelector(`[data-star="${state.reviewDraft.rating}"]`)?.focus();
  }));
  $('reviewBody')?.addEventListener('input', (e) => { state.reviewDraft.body = e.target.value; });
  host.querySelector('[data-submit-review]')?.addEventListener('click', submitReview);
  host.querySelector('[data-signin-review]')?.addEventListener('click', openAccount);
}

async function submitReview() {
  const m = medById(state.productId);
  const s = state.session;
  const btn = $('reviewsSec')?.querySelector('[data-submit-review]');
  const err = $('reviewErr');
  if (!m || !s || !btn) return;
  const rating = state.reviewDraft.rating;
  const body = ($('reviewBody')?.value ?? '').trim().slice(0, 600);
  if (!rating) { err.textContent = t('product.ratingRequired'); return; }
  err.textContent = '';
  btn.setAttribute('aria-busy', 'true');
  const { error } = await safe((db) => db.from('reviews').upsert({
    medicine_id: m.id,
    user_id: s.user.id,
    user_name: (s.user.user_metadata?.full_name || s.user.email || 'Customer').slice(0, 60),
    rating,
    body,
    is_visible: true,
  }, { onConflict: 'medicine_id,user_id' }));
  btn.removeAttribute('aria-busy');
  if (error) { ui.toast(error.message || t('product.reviewFailed'), 'err'); return; }
  ui.toast(t('product.reviewSaved'), 'ok');
  state.reviewDraft = { rating: 0, body: '' };
  state.reviews = { id: String(m.id), rows: null, error: false };
  renderReviews();
  loadReviews(m.id);
}

// =====================================================================
// CART SHEET (#sheetCart): lines → bill → coupon → delivery form → payment → CTA
// =====================================================================
// Form draft survives re-renders (qty change, 60s refresh, language switch).
let draft = null;
const FIELDS = ['name', 'phone', 'address', 'city', 'pincode'];
function ensureDraft() {
  if (!draft) {
    draft = { couponInput: state.coupon?.code ?? '', errors: {} };
    FIELDS.forEach((k) => { draft[k] = state.profile?.[k] ?? ''; });
  }
  return draft;
}
function readForm() {
  const d = ensureDraft();
  FIELDS.forEach((k) => { const el = $(`f_${k}`); if (el) d[k] = el.value; });
  const c = $('couponInput');
  if (c) d.couponInput = c.value;
  return d;
}
const payMethods = () => {
  const list = [
    { id: 'upi', ico: '📱', title: t('checkout.upi'), sub: t('checkout.upiSub') },
  ];
  if (state.settings?.razorpay_key_id) list.push({ id: 'razorpay', ico: '💳', title: t('checkout.card'), sub: t('checkout.cardSub') });
  list.push({ id: 'cod', ico: '💵', title: t('checkout.cod'), sub: t('checkout.codSub') });
  return list;
};

export function renderCart() {
  const body = $('cartBody');
  const foot = $('cartFoot');
  if (state.successOrder) { renderSuccess(state.successOrder); return; }
  const d = cartDetail();
  if (!d.lines.length) {
    foot.hidden = true;
    body.innerHTML = emptyState('🛒', t('cart.empty'), t('cart.emptySub'),
      `<a class="btn btn-teal" href="#pharmacy" data-close-sheet><span class="lbl">${esc(t('cart.browse'))}</span></a>`);
    return;
  }
  if (!payMethods().some((p) => p.id === state.payMethod)) state.payMethod = 'upi';
  const f = $('checkoutForm') ? readForm() : ensureDraft(); // keep what the user typed
  const field = (k, label, placeholder, extra = '') => `<div class="field ${f.errors[k] ? 'invalid' : ''}">
      <label for="f_${k}">${esc(label)}</label>
      <input id="f_${k}" name="${k}" value="${esc(f[k])}" placeholder="${esc(placeholder)}" ${extra}>
      <div class="field-err" role="alert">${esc(f.errors[k] ? t(f.errors[k]) : '')}</div>
    </div>`;
  const freeDone = d.deliveryFee === 0;
  const freePct = freeDone || d.freeAbove <= 0 ? 100 : Math.min(100, Math.round(d.subtotal / d.freeAbove * 100));
  body.innerHTML = `
    <ul class="clines">${d.lines.map(({ m, qty }) => `<li class="cline" data-id="${esc(m.id)}">
        ${mediaHtml(m, 'pmedia sm')}
        <div class="cinfo">
          <b class="cname">${esc(m.name)}</b>
          <span class="muted cpack">${esc(m.pack_size ?? '')}${m.requires_rx ? ` · <span class="pb rx">${esc(t('shop.rx'))}</span>` : ''}</span>
          <span class="cprice">${esc(inr(m.price))} × ${qty} = <b>${esc(inr(Number(m.price) * qty))}</b></span>
        </div>
        <div class="cact">
          <div class="pact" data-pact="${esc(m.id)}">${actionHtml(m)}</div>
          <button type="button" class="btn btn-link sm" data-remove="${esc(m.id)}">${esc(t('common.remove'))}</button>
        </div>
      </li>`).join('')}</ul>

    ${d.freeAbove > 0 ? `<div class="freebar ${freeDone ? 'done' : ''}">
      <span>${freeDone ? '🎉 ' + esc(t('cart.freeUnlocked')) : '🚚 ' + esc(t('cart.moreForFree', { amount: inr(d.moreForFree) }))}</span>
      <div class="pbar ${freeDone ? 'done' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${freePct}"><div class="pbar-fill" style="--p:${freePct}%"></div></div>
    </div>` : ''}

    ${d.needsRx ? `<p class="note rx"><span class="ico" aria-hidden="true">📋</span> ${esc(t('cart.rxNote'))}</p>` : ''}

    <div class="coupon">
      <label class="sr-only" for="couponInput">${esc(t('cart.coupon'))}</label>
      <input id="couponInput" value="${esc(f.couponInput)}" placeholder="${esc(t('cart.couponPlaceholder'))}" autocapitalize="characters" autocomplete="off" ${state.coupon ? 'readonly' : ''}>
      ${state.coupon
        ? `<button type="button" class="btn btn-ghost" data-coupon-remove><span class="lbl">${esc(t('common.remove'))}</span></button>`
        : `<button type="button" class="btn btn-ghost" data-coupon-apply><span class="lbl">${esc(t('cart.apply'))}</span></button>`}
    </div>
    <div class="coupon-msg ${state.couponMsg ? (state.couponMsg.ok ? 'ok' : 'err') : ''}" role="status">${esc(state.couponMsg?.text ?? '')}</div>

    <dl class="bill">
      <div><dt>${esc(t('cart.itemsTotal'))}</dt><dd>${esc(inr(d.subtotal))}</dd></div>
      <div><dt>${esc(t('cart.delivery'))}</dt><dd>${d.deliveryFee ? esc(inr(d.deliveryFee)) : `<span class="free">${esc(t('common.free'))}</span>`}</dd></div>
      ${d.discount ? `<div class="disc"><dt>${esc(t('cart.discount'))} <span class="muted">(${esc(state.coupon?.code ?? '')})</span></dt><dd>− ${esc(inr(d.discount))}</dd></div>` : ''}
      ${d.savings + d.discount > 0 ? `<div class="save"><dt>${esc(t('cart.youSave'))}</dt><dd>${esc(inr(d.savings + d.discount))}</dd></div>` : ''}
      <div class="total"><dt>${esc(t('cart.toPay'))}</dt><dd>${esc(inr(d.total))}</dd></div>
    </dl>
    <p class="muted hint">${esc(t('cart.estimate'))}</p>

    <h3 class="csec">${esc(t('checkout.title'))}</h3>
    <form id="checkoutForm" novalidate autocomplete="on">
      ${field('name', t('checkout.name'), t('checkout.namePlaceholder'), 'autocomplete="name"')}
      ${field('phone', t('checkout.phone'), t('checkout.phonePlaceholder'), 'inputmode="numeric" autocomplete="tel-national" maxlength="14"')}
      ${field('address', t('checkout.address'), t('checkout.addressPlaceholder'), 'autocomplete="street-address"')}
      <div class="field-row">
        ${field('city', t('checkout.city'), t('checkout.city'), 'autocomplete="address-level2"')}
        ${field('pincode', t('checkout.pincode'), '000000', 'inputmode="numeric" maxlength="6" autocomplete="postal-code"')}
      </div>
    </form>

    <h3 class="csec">${esc(t('checkout.payment'))}</h3>
    <div class="payopts" role="radiogroup" aria-label="${esc(t('checkout.payment'))}">
      ${payMethods().map((p) => `<label class="payopt ${state.payMethod === p.id ? 'on' : ''}">
        <input type="radio" name="pay" value="${p.id}" ${state.payMethod === p.id ? 'checked' : ''}>
        <span class="ico" aria-hidden="true">${p.ico}</span>
        <span class="ptxt"><b>${esc(p.title)}</b><small>${esc(p.sub)}</small></span>
        <span class="pcheck" aria-hidden="true"></span>
      </label>`).join('')}
    </div>
    <p class="muted hint">${esc(t('checkout.serverNote'))}</p>
    ${state.session ? '' : `<button type="button" class="btn btn-link block nudge" data-signin><span class="ico" aria-hidden="true">👤</span><span class="lbl">${esc(t('checkout.signInNudge'))}</span></button>`}
  `;
  foot.hidden = false;
  foot.innerHTML = `<button type="button" class="btn btn-gold block" id="placeBtn" ${state.placing ? 'aria-busy="true"' : ''} ${d.lines.length ? '' : 'disabled'}><span class="lbl">${esc(state.placing ? t('checkout.placing') : t('checkout.placeOrder', { amount: inr(d.total) }))}</span></button>`;

  // wiring
  bindActions(body);
  body.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => setQty(b.dataset.remove, 0)));
  body.querySelectorAll('.payopt input').forEach((r) => r.addEventListener('change', () => {
    state.payMethod = r.value;
    body.querySelectorAll('.payopt').forEach((l) => l.classList.toggle('on', l.querySelector('input').value === r.value));
  }));
  FIELDS.forEach((k) => $(`f_${k}`)?.addEventListener('input', (e) => {
    f[k] = e.target.value;
    if (f.errors[k]) { delete f.errors[k]; e.target.closest('.field').classList.remove('invalid'); e.target.closest('.field').querySelector('.field-err').textContent = ''; }
  }));
  $('checkoutForm').addEventListener('submit', (e) => { e.preventDefault(); placeOrder(); }); // Enter key = place order, never a page reload
  $('couponInput')?.addEventListener('input', (e) => { f.couponInput = e.target.value; });
  $('couponInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); } });
  body.querySelector('[data-coupon-apply]')?.addEventListener('click', applyCoupon);
  body.querySelector('[data-coupon-remove]')?.addEventListener('click', () => {
    state.coupon = null; state.couponMsg = null;
    $('couponInput').value = '';
    ui.toast(t('cart.couponRemoved'), 'info');
    renderCart();
  });
  body.querySelector('[data-signin]')?.addEventListener('click', () => { readForm(); openAccount(); });
  $('placeBtn').addEventListener('click', placeOrder);
}

async function applyCoupon() {
  const f = readForm();
  const code = f.couponInput.trim().toUpperCase();
  const btn = $('cartBody').querySelector('[data-coupon-apply]');
  if (!code || !btn) return;
  btn.setAttribute('aria-busy', 'true');
  const { data, error } = await safe((db) => db.rpc('check_coupon', { p_code: code, p_subtotal: cartDetail().subtotal }));
  btn.removeAttribute('aria-busy');
  if (error) {
    state.coupon = null;
    state.couponMsg = { text: error.message || t('cart.couponError'), ok: false };
    ui.toast(t('cart.couponError'), 'err');
  } else {
    const r = Array.isArray(data) ? data[0] : data;
    const valid = !!r?.valid;
    state.coupon = valid ? { code, discount: Number(r.discount ?? 0), message: r.message ?? '' } : null;
    state.couponMsg = { text: r?.message || t(valid ? 'cart.couponApplied' : 'cart.couponInvalid'), ok: valid };
    ui.toast(t(valid ? 'cart.couponApplied' : 'cart.couponInvalid'), valid ? 'ok' : 'err');
  }
  if (ui.currentSheet() === 'sheetCart') renderCart();
}

// =====================================================================
// PLACE ORDER → success view
// =====================================================================
function validateForm(f) {
  const errors = {};
  const phone = digits(f.phone);
  if (f.name.trim().length < 2) errors.name = 'checkout.errName';
  if (!/^\d{10}$/.test(phone)) errors.phone = 'checkout.errPhone';
  if (!f.address.trim()) errors.address = 'checkout.errAddress';
  if (!f.city.trim()) errors.city = 'checkout.errCity';
  if (!/^\d{6}$/.test(f.pincode.trim())) errors.pincode = 'checkout.errPincode';
  return { errors, phone };
}

export async function placeOrder() {
  if (state.placing) return;
  const d = cartDetail();
  if (!d.lines.length) return;
  const f = readForm();
  const { errors, phone } = validateForm(f);
  f.errors = errors;
  if (Object.keys(errors).length) {
    renderCart();
    $(`f_${Object.keys(errors)[0]}`)?.focus();
    return;
  }
  state.placing = true;
  renderCart();
  const method = state.payMethod;
  const orderNumber = 'SS-' + Date.now().toString(36).toUpperCase();
  const name = f.name.trim();
  const address = f.address.trim();
  const city = f.city.trim();
  const pincode = f.pincode.trim();
  const { data, error } = await safe((db) => db.rpc('place_order', {
    p_order_number: orderNumber,
    p_items: d.lines.map((l) => ({ medicine_id: l.m.id, qty: l.qty })),
    p_customer_name: name,
    p_phone: phone,
    p_address: address,
    p_city: city,
    p_pincode: pincode,
    p_payment_method: method,
    p_prescription_url: null,
    p_coupon_code: state.coupon?.code ?? null,
  }));
  state.placing = false;
  const r = Array.isArray(data) ? data[0] : data;
  if (error || !r) {
    ui.toast(error?.message || t('checkout.failed'), 'err', 5000);
    if (ui.currentSheet() === 'sheetCart') renderCart();
    return;
  }
  // Server totals are authoritative from here on.
  const order = {
    id: r.id ?? null,
    orderNumber: r.order_number ?? orderNumber,
    name, phone, address, city, pincode,
    payMethod: method,
    subtotal: Number(r.subtotal ?? 0),
    deliveryFee: Number(r.delivery_fee ?? 0),
    discount: Number(r.discount ?? 0),
    couponCode: state.coupon?.code ?? null,
    total: Number(r.total ?? 0),
    needsRx: !!r.needs_rx,
    status: 'placed',
    payStatus: 'pending',
    claimed: false,
    claimedRef: null,
    createdAt: new Date().toISOString(),
    items: d.lines.map(({ m, qty }) => ({ medicineId: m.id, name: m.name, packSize: m.pack_size ?? '', price: Number(m.price), qty })),
  };
  state.orders.unshift(order);
  state.orders = state.orders.slice(0, 30);
  saveOrders();
  state.profile = { name, phone, address, city, pincode };
  saveProfile();
  state.cart = {};
  saveCart();
  state.coupon = null;
  state.couponMsg = null;
  draft = null;
  renderCartBadge();
  renderCartBar();
  state.successOrder = order;
  if (ui.currentSheet() === 'sheetCart') renderSuccess(order);
  else { renderCart(); ui.openSheet('sheetCart', { onClose: () => { state.successOrder = null; } }); }
  loadAll(); // fresh stock
}

// ---------------- payment helpers (shared with My orders in FEAT-004) ----------------
// UPI: navigate to the deep link; if the tab never left (desktop, no handler) hint after 1.5s.
export function payUpi(order) {
  let left = false;
  const onVis = () => { if (document.hidden) left = true; };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', () => { left = true; }, { once: true });
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onVis);
    if (!left) ui.toast(t('pay.noUpiApp'), 'info', 5000);
  }, 1500);
  location.href = upiUrl(order.total, 'Order ' + order.orderNumber);
}

export async function openRazorpay(order, btn) {
  // Open the tab synchronously inside the click's user activation (popup blockers drop
  // window.open after an await), then point it at the payment link once we have it.
  const win = window.open('about:blank', '_blank');
  if (win) win.opener = null;
  btn?.setAttribute('aria-busy', 'true');
  ui.toast(t('pay.opening'), 'info', 2000);
  const { data, error } = await safe((db) => db.functions.invoke('create-payment-link', {
    body: { orderNumber: order.orderNumber, customerName: order.name, phone: order.phone },
  }));
  btn?.removeAttribute('aria-busy');
  if (error || !data?.url) { win?.close(); ui.toast(t('pay.razorpayFailed'), 'err'); return; }
  if (win) win.location.href = data.url; else location.href = data.url;
}

export function sendOrderWhatsApp(order, extra = '') {
  ui.openExternal(waHref(waOrderMessage(order) + (extra ? `\n\n${extra}` : '')));
}

function renderSuccess(o) {
  const body = $('cartBody');
  const foot = $('cartFoot');
  const total = inr(o.total);
  const pay = o.payMethod === 'upi'
    ? `<button type="button" class="btn btn-gold block" data-pay-upi><span class="ico" aria-hidden="true">📱</span><span class="lbl">${esc(t('success.payUpi', { amount: total }))}</span></button>
       <p class="muted hint">${esc(t('success.payLater'))}</p>`
    : o.payMethod === 'razorpay'
      ? `<button type="button" class="btn btn-gold block" data-pay-card><span class="ico" aria-hidden="true">💳</span><span class="lbl">${esc(t('success.payCard', { amount: total }))}</span></button>
         <p class="muted hint">${esc(t('success.payLater'))}</p>`
      : `<p class="note cod"><span class="ico" aria-hidden="true">💵</span> ${esc(t('success.codNote', { amount: total }))}</p>`;
  body.innerHTML = `<div class="success">
    <div class="tick" aria-hidden="true"><svg viewBox="0 0 52 52"><circle class="tick-c" cx="26" cy="26" r="24"/><path class="tick-p" d="M14 27l8 8 16-16"/></svg></div>
    <h3>${esc(t('success.title'))}</h3>
    <p class="onum"><b>${esc(o.orderNumber)}</b> · ${esc(total)}</p>
    <p class="muted">${esc(t('success.sub'))}</p>
    <dl class="bill compact">
      <div><dt>${esc(t('cart.itemsTotal'))}</dt><dd>${esc(inr(o.subtotal))}</dd></div>
      <div><dt>${esc(t('cart.delivery'))}</dt><dd>${o.deliveryFee ? esc(inr(o.deliveryFee)) : `<span class="free">${esc(t('common.free'))}</span>`}</dd></div>
      ${o.discount ? `<div class="disc"><dt>${esc(t('cart.discount'))}${o.couponCode ? ` <span class="muted">(${esc(o.couponCode)})</span>` : ''}</dt><dd>− ${esc(inr(o.discount))}</dd></div>` : ''}
      <div class="total"><dt>${esc(t('cart.toPay'))}</dt><dd>${esc(total)}</dd></div>
    </dl>
    <div class="sactions">
      ${pay}
      ${o.needsRx ? `<button type="button" class="btn btn-wa block" data-rx><span class="ico" aria-hidden="true">📋</span><span class="lbl">${esc(t('success.rxNeeded'))}</span></button>` : ''}
      ${state.settings?.whatsapp ? `<button type="button" class="btn ${o.needsRx ? 'btn-ghost' : 'btn-wa'} block" data-wa><span class="ico" aria-hidden="true">💬</span><span class="lbl">${esc(t('success.sendWhatsApp'))}</span></button>` : ''}
      <div class="btn-row two">
        <button type="button" class="btn btn-ghost" data-track><span class="ico" aria-hidden="true">📦</span><span class="lbl">${esc(t('success.track'))}</span></button>
        <button type="button" class="btn btn-ghost" data-continue><span class="ico" aria-hidden="true">🛍️</span><span class="lbl">${esc(t('success.continue'))}</span></button>
      </div>
      ${state.session ? `<p class="muted hint">${esc(t('checkout.guestNote'))}</p>` : `<button type="button" class="btn btn-link block nudge" data-signin><span class="ico" aria-hidden="true">👤</span><span class="lbl">${esc(t('checkout.signInNudge'))}</span></button>`}
    </div>
  </div>`;
  foot.hidden = true;
  body.scrollTop = 0;
  body.querySelector('[data-pay-upi]')?.addEventListener('click', () => payUpi(o));
  body.querySelector('[data-pay-card]')?.addEventListener('click', (e) => openRazorpay(o, e.currentTarget));
  body.querySelector('[data-rx]')?.addEventListener('click', () => sendOrderWhatsApp(o, `📎 Prescription for Order No ${o.orderNumber} attached below.`));
  body.querySelector('[data-wa]')?.addEventListener('click', () => sendOrderWhatsApp(o));
  body.querySelector('[data-track]')?.addEventListener('click', () => {
    state.successOrder = null;
    ui.closeSheet();
    if (state.route.name === 'orders') { renderOrders(true); syncOrders(); } // already there: no hashchange → refresh by hand
    else location.hash = '#orders';
  });
  body.querySelector('[data-continue]')?.addEventListener('click', () => { state.successOrder = null; ui.closeSheet(); if (state.route.name !== 'pharmacy') location.hash = '#pharmacy'; });
  body.querySelector('[data-signin]')?.addEventListener('click', openAccount);
}

// =====================================================================
// SHARED: doctor radio list (book + token), date helpers
// =====================================================================
const docById = (id) => state.doctors.find((d) => String(d.id) === String(id));
const typingInEl = (id) => { const a = document.activeElement; return !!a && !!$(id)?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
// 'Mon, 3 Jun' style for appointment dates (local parse — 'YYYY-MM-DD' alone would be UTC).
const fmtDay = (iso, weekday = true) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  return d.toLocaleDateString('en-IN', { ...(weekday ? { weekday: 'short' } : {}), day: 'numeric', month: 'short' });
};
const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
};
const fee = (type) => Number((type === 'online' ? state.settings?.fee_online : state.settings?.fee_offline) ?? 0);

// Radio cards for doctor choice. `group` names the radio set; data-doc-pick on labels.
function doctorRadiosHtml(group, selectedId, errKey) {
  if (!state.loaded) return ui.skeleton('line', 3);
  if (!state.doctors.length) return emptyState('🧑‍⚕️', t('home.noDoctors'));
  return `<div class="dpick" role="radiogroup">${state.doctors.map((d) => {
    const on = String(d.id) === String(selectedId ?? '');
    return `<label class="card dradio ${on ? 'on' : ''}">
      <input type="radio" name="${group}" value="${esc(d.id)}" ${on ? 'checked' : ''}>
      <span class="avatar sm" aria-hidden="true">${d.image_url ? `<img src="${esc(imgSrc(d.image_url, 96))}" alt="" width="48" height="48" loading="lazy" decoding="async">` : esc(d.emoji || '🧑‍⚕️')}</span>
      <span class="dtxt"><b>${esc(d.name)}</b><small>${esc(tc(d.specialty ?? ''))}</small></span>
      <span class="pcheck" aria-hidden="true"></span>
    </label>`;
  }).join('')}</div>
  <div class="field-err" role="alert">${esc(errKey ? t(errKey) : '')}</div>`;
}

// =====================================================================
// BOOK — 3-step appointment form, success card, My Appointments
// =====================================================================
// Draft survives re-renders (60 s refresh, langchange). name/phone null = untouched → profile prefill.
const bk = { doctorId: null, service: null, type: 'offline', date: '', time: '', name: null, phone: null, notes: '', errors: {}, busy: false, success: false };
const bkName = () => (bk.name ?? state.profile.name ?? '');
const bkPhone = () => (bk.phone ?? state.profile.phone ?? '');
const bkService = () => bk.service ?? t('book.generalConsult');

// Server rows for the signed-in user, cached per uid.
const myAppts = { uid: null, rows: null, loading: false, error: false };
async function loadMyAppts(force = false) {
  const uid = state.session?.user?.id;
  if (!uid) { myAppts.uid = null; myAppts.rows = null; return; }
  if (!force && myAppts.uid === uid && (myAppts.rows || myAppts.loading)) return;
  myAppts.uid = uid;
  myAppts.loading = true;
  myAppts.error = false;
  renderMyAppts();
  const { data, error } = await safe((db) => db.from('appointments').select('*').eq('user_id', uid).order('appointment_date', { ascending: false }).limit(50));
  myAppts.loading = false;
  if (myAppts.uid !== uid) return; // signed out / switched meanwhile
  if (error) { myAppts.error = true; myAppts.rows = myAppts.rows ?? []; }
  else myAppts.rows = data ?? [];
  if (state.route.name === 'book') renderMyAppts();
}

// Staff-facing WhatsApp appointment request (English on purpose — same format as the old site/app).
function buildAppointmentMessage(a) {
  const L = [];
  L.push(`🩺 *Appointment Request — ${hospitalName()}* (website)`);
  L.push('');
  L.push(`Doctor: *${a.doctorName}*`);
  L.push(`Service: ${a.service}`);
  L.push(`Type: ${a.consultType === 'online' ? 'Online (video)' : 'In-person visit'}`);
  L.push(`Date: ${a.date}`);
  L.push(`Time: ${a.time}`);
  L.push(`Fee: ${inr(a.fee)}`);
  if (a.notes) L.push(`Notes: ${a.notes}`);
  L.push('');
  L.push(`👤 Patient: ${a.patientName}`);
  L.push(`📞 ${a.phone}`);
  return L.join('\n');
}

export function renderBook(force = false) {
  if (force || !typingInEl('bookForm')) renderBookForm();
  renderBookHow();
  loadMyAppts();
  renderMyAppts();
}

function renderBookHow() {
  const s = state.settings;
  const row = (ico, txt) => `<div class="hrow"><span class="ico" aria-hidden="true">${ico}</span><span>${esc(txt)}</span></div>`;
  $('bookHow').innerHTML = `<div class="bhow">
    <div class="card hcard">
      <h3>${esc(t('book.howTitle'))}</h3>
      ${row('📋', t('book.how1'))}${row('💬', t('book.how2'))}${row('🏥', t('book.how3'))}
    </div>
    <div class="card hcard">
      <h3>${esc(t('book.fees'))}</h3>
      <dl class="bill compact">
        <div><dt>${esc(t('book.inPerson'))}</dt><dd>${esc(inr(fee('offline')))}</dd></div>
        <div><dt>${esc(t('book.online'))}</dt><dd>${esc(inr(fee('online')))}</dd></div>
      </dl>
      ${s?.phone ? `<a class="btn btn-ghost sm" href="${esc(telHref(s.phone))}"><span class="ico" aria-hidden="true">📞</span><span class="lbl">${esc(t('book.callInstead'))}</span></a>` : ''}
    </div>
  </div>`;
}

function renderBookForm() {
  const el = $('bookForm');
  if (bk.success) {
    el.innerHTML = `<div class="card success bsuccess">
      <div class="tick" aria-hidden="true"><svg viewBox="0 0 52 52"><circle class="tick-c" cx="26" cy="26" r="24"/><path class="tick-p" d="M14 27l8 8 16-16"/></svg></div>
      <h3>${esc(t('book.success'))}</h3>
      <p class="muted">${esc(t('book.successSub'))}</p>
      <div class="btn-row two">
        <a class="btn btn-teal" href="#book/my" data-book-my><span class="ico" aria-hidden="true">📅</span><span class="lbl">${esc(t('book.my'))}</span></a>
        <button type="button" class="btn btn-ghost" data-book-again><span class="ico" aria-hidden="true">＋</span><span class="lbl">${esc(t('book.submit'))}</span></button>
      </div>
    </div>`;
    const again = () => { bk.success = false; bk.date = ''; bk.time = ''; bk.notes = ''; renderBookForm(); };
    el.querySelector('[data-book-my]').addEventListener('click', again);
    el.querySelector('[data-book-again]').addEventListener('click', () => { again(); window.scrollTo({ top: 0 }); });
    return;
  }
  const e = bk.errors;
  const step = (n, key) => `<div class="bstep"><span class="bnum" aria-label="${esc(t('a11y.step', { n }))}">${n}</span><h2>${esc(t(key))}</h2></div>`;
  const chip = (label, on, attr) => `<button type="button" class="chip ${on ? 'on' : ''}" aria-pressed="${on}" ${attr}>${esc(label)}</button>`;
  const slots = Array.isArray(state.settings?.time_slots) ? state.settings.time_slots : [];
  const services = [t('book.generalConsult'), ...state.services.map((s) => s.name)];
  const svc = bkService();
  const signed = !!state.session;
  const field = (k, id, label, value, extra = '') => `<div class="field ${e[k] ? 'invalid' : ''}">
      <label for="${id}">${esc(label)}</label>
      <input id="${id}" name="${k}" value="${esc(value)}" ${extra}>
      <div class="field-err" role="alert">${esc(e[k] ? t(e[k]) : '')}</div>
    </div>`;
  el.innerHTML = `<form class="bform card" id="bform" novalidate>
    ${step(1, 'book.step1')}
    <div class="bsec">
      <div class="blbl">${esc(t('book.chooseDoctor'))}</div>
      ${doctorRadiosHtml('bdoc', bk.doctorId, e.doctor)}
      <div class="blbl">${esc(t('book.service'))}</div>
      <div class="chips">${services.map((s) => chip(tc(s), s === svc, `data-svc="${esc(s)}"`)).join('')}</div>
    </div>
    ${step(2, 'book.step2')}
    <div class="bsec">
      <div class="blbl">${esc(t('book.type'))}</div>
      <div class="typerow">
        <div class="seg seg-block" role="radiogroup" id="bkType">
          <span class="seg-thumb" aria-hidden="true"></span>
          <button type="button" class="seg-btn" role="radio" aria-checked="${bk.type === 'offline'}" data-type="offline">🏥 ${esc(t('book.inPerson'))}</button>
          <button type="button" class="seg-btn" role="radio" aria-checked="${bk.type === 'online'}" data-type="online">📹 ${esc(t('book.online'))}</button>
        </div>
        <div class="feebox" aria-live="polite"><span class="muted">${esc(t('book.fee'))}</span><b id="bkFee">${esc(inr(fee(bk.type)))}</b></div>
      </div>
      <div class="field-row">
        ${field('date', 'bkDate', t('book.date'), bk.date, `type="date" min="${todayISO()}"`)}
        <div class="field ${e.time ? 'invalid' : ''}">
          <label id="bkTimeLbl">${esc(t('book.time'))}</label>
          ${slots.length
            ? `<div class="chips tslots" role="group" aria-labelledby="bkTimeLbl">${slots.map((s) => chip(s, s === bk.time, `data-slot="${esc(s)}"`)).join('')}</div>`
            : `<p class="muted noslots">${esc(t('book.noSlots'))}</p>`}
          <div class="field-err" role="alert">${esc(e.time ? t(e.time) : '')}</div>
        </div>
      </div>
    </div>
    ${step(3, 'book.step3')}
    <div class="bsec">
      <div class="field-row">
        ${field('name', 'bkName', t('book.patientName'), bkName(), 'autocomplete="name" maxlength="80"')}
        ${field('phone', 'bkPhone', t('book.phone'), bkPhone(), 'inputmode="numeric" autocomplete="tel-national" maxlength="14"')}
      </div>
      <div class="field">
        <label for="bkNotes">${esc(t('book.notes'))}</label>
        <textarea id="bkNotes" name="notes" rows="2" maxlength="400" placeholder="${esc(t('book.notesPlaceholder'))}">${esc(bk.notes)}</textarea>
        <div class="field-err"></div>
      </div>
      <button type="submit" class="btn ${signed ? 'btn-teal' : 'btn-wa'} block" ${bk.busy ? 'aria-busy="true"' : ''}>
        <span class="ico" aria-hidden="true">${signed ? '📅' : '💬'}</span>
        <span class="lbl">${esc(bk.busy ? t('book.submitting') : t(signed ? 'book.submit' : 'book.submitGuest'))}</span>
      </button>
      ${signed ? '' : `<p class="muted hint">${esc(t('book.sub'))}</p>`}
    </div>
  </form>`;
  // bindings
  el.querySelectorAll('input[name="bdoc"]').forEach((r) => r.addEventListener('change', () => {
    bk.doctorId = r.value;
    delete bk.errors.doctor;
    el.querySelectorAll('.dradio').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
    el.querySelector('.dpick + .field-err').textContent = '';
  }));
  el.querySelectorAll('[data-svc]').forEach((b) => b.addEventListener('click', () => {
    bk.service = b.dataset.svc === t('book.generalConsult') ? null : b.dataset.svc;
    el.querySelectorAll('[data-svc]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
  }));
  const seg = $('bkType');
  initSeg(seg, (b) => {
    bk.type = b.dataset.type;
    setSegValue(seg, 'type', bk.type);
    $('bkFee').textContent = inr(fee(bk.type));
  });
  $('bkDate').addEventListener('input', (ev) => { bk.date = ev.target.value; });
  el.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
    bk.time = b.dataset.slot;
    delete bk.errors.time;
    el.querySelectorAll('[data-slot]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
    b.closest('.field').classList.remove('invalid');
    b.closest('.field').querySelector('.field-err').textContent = '';
  }));
  $('bkName').addEventListener('input', (ev) => { bk.name = ev.target.value; });
  $('bkPhone').addEventListener('input', (ev) => { bk.phone = ev.target.value; });
  $('bkNotes').addEventListener('input', (ev) => { bk.notes = ev.target.value; });
  $('bform').addEventListener('submit', (ev) => { ev.preventDefault(); submitBooking(); });
}

function validateBooking() {
  const errors = {};
  const phone = digits(bkPhone());
  if (!docById(bk.doctorId)) errors.doctor = 'book.errDoctor';
  if (!bk.date || bk.date < todayISO()) errors.date = 'book.errDate';
  if (!bk.time) errors.time = 'book.errTime';
  if (bkName().trim().length < 2) errors.name = 'book.errName';
  if (!/^\d{10}$/.test(phone)) errors.phone = 'checkout.errPhone';
  return { errors, phone };
}

async function submitBooking() {
  if (bk.busy) return;
  const { errors, phone } = validateBooking();
  bk.errors = errors;
  if (Object.keys(errors).length) {
    renderBookForm();
    const first = Object.keys(errors)[0];
    const target = first === 'doctor' ? $('bform').querySelector('input[name="bdoc"]') : first === 'time' ? $('bform').querySelector('[data-slot]') : $(`bk${first[0].toUpperCase()}${first.slice(1)}`);
    target?.focus();
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    return;
  }
  const doc = docById(bk.doctorId);
  const a = {
    doctorId: doc.id, doctorName: doc.name, service: bkService(), consultType: bk.type,
    date: bk.date, time: bk.time, patientName: bkName().trim(), phone, notes: bk.notes.trim(), fee: fee(bk.type),
  };
  // remember patient details for next time (only fill gaps — the account holder may book for family)
  if (!state.profile.name) state.profile.name = a.patientName;
  if (!state.profile.phone) state.profile.phone = phone;
  saveProfile();

  if (!state.session) {
    // Guest: WhatsApp request + local record (synchronous open — popup-safe).
    ui.openExternal(waHref(buildAppointmentMessage(a)));
    state.appts.unshift({ local: true, id: 'L-' + Date.now(), ...a, status: 'whatsapp', createdAt: new Date().toISOString() });
    saveAppts();
    ui.toast(t('book.sentWhatsApp'), 'ok');
    bk.date = ''; bk.time = ''; bk.notes = ''; bk.errors = {};
    renderBookForm();
    renderMyAppts();
    $('myApptsSec')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  bk.busy = true;
  renderBookForm();
  const { error } = await safe((db) => db.from('appointments').insert({
    user_id: state.session.user.id,
    doctor_id: a.doctorId,
    doctor_name: a.doctorName,
    patient_name: a.patientName,
    phone: a.phone,
    consult_type: a.consultType,
    service: a.service,
    appointment_date: a.date,
    appointment_time: a.time,
    notes: a.notes || null,
    fee: a.fee,
    status: 'pending',
  }).select('id').single());
  bk.busy = false;
  if (error) {
    ui.toast(`${t('book.failed')}${error.message ? ` — ${error.message}` : ''}`, 'err', 5000);
    renderBookForm();
    return;
  }
  bk.success = true;
  bk.errors = {};
  renderBookForm();
  loadMyAppts(true);
}

// --- My appointments: server rows (signed in) + local guest rows, newest date first
function apptView(r) {
  if (r.local) return { id: r.id, local: true, doctorName: r.doctorName, service: r.service, date: r.date, time: r.time, type: r.consultType, fee: r.fee, status: r.status || 'whatsapp', phone: r.phone };
  return { id: r.id, local: false, doctorName: r.doctor_name, service: r.service, date: r.appointment_date, time: r.appointment_time, type: r.consult_type, fee: r.fee, status: r.status || 'pending', phone: r.phone };
}
const APPT_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'whatsapp'];

function renderMyAppts() {
  const el = $('myAppts');
  const signed = !!state.session;
  const rows = [...(signed ? myAppts.rows ?? [] : []), ...state.appts].map(apptView)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.time).localeCompare(String(a.time)));
  if (signed && myAppts.loading && !rows.length) { el.innerHTML = ui.skeleton('line', 3); return; }
  if (!rows.length) {
    el.innerHTML = signed
      ? emptyState('📅', t('book.empty'), t('book.emptySub'))
      : emptyState('🔒', t('book.signInToSee'), '', `<button type="button" class="btn btn-teal" data-signin><span class="ico" aria-hidden="true">👤</span><span class="lbl">${esc(t('auth.signIn'))}</span></button>`);
    el.querySelector('[data-signin]')?.addEventListener('click', openAccount);
    return;
  }
  el.innerHTML = `${signed && myAppts.error ? `<p class="muted hint left">${esc(t('common.offline'))}</p>` : ''}
  <div class="alist">${rows.map((a) => {
    const st = APPT_STATUSES.includes(a.status) ? a.status : 'pending';
    const canCancelAppt = !a.local && (st === 'pending' || st === 'confirmed');
    return `<article class="card acard" data-appt="${esc(a.id)}">
      <div class="adate" aria-hidden="true"><b>${esc(fmtDay(a.date, false))}</b><small>${esc(a.time ?? '')}</small></div>
      <div class="abody">
        <div class="ahead"><b>${esc(a.doctorName ?? '')}</b><span class="pill pill-${esc(st)}">${esc(t(`book.status.${st}`))}</span></div>
        <div class="ameta">${esc(tc(a.service ?? ''))} · ${esc(t(a.type === 'online' ? 'book.online' : 'book.inPerson'))} · ${esc(inr(a.fee ?? 0))}</div>
        <div class="ameta muted">${esc(fmtDay(a.date))}${a.time ? ` · ${esc(a.time)}` : ''}</div>
        ${canCancelAppt ? `<div class="oactions"><button type="button" class="btn btn-ghost danger sm" data-cancel-appt><span class="ico" aria-hidden="true">✕</span><span class="lbl">${esc(t('book.cancel'))}</span></button></div>` : ''}
      </div>
    </article>`;
  }).join('')}</div>`;
  el.querySelectorAll('[data-cancel-appt]').forEach((b) => b.addEventListener('click', () => {
    const id = b.closest('[data-appt]').dataset.appt;
    const row = (myAppts.rows ?? []).find((r) => String(r.id) === id);
    if (row) cancelAppointment(row, b);
  }));
}

async function cancelAppointment(row, btn) {
  const ok = await ui.confirm({ title: t('book.cancel'), body: t('book.cancelConfirm'), ok: t('book.cancel'), cancel: t('common.keep'), danger: true });
  if (!ok) return;
  btn?.setAttribute('aria-busy', 'true');
  const { error } = await safe((db) => db.rpc('cancel_my_appointment', { p_id: row.id, p_phone: row.phone }));
  btn?.removeAttribute('aria-busy');
  if (error) { ui.toast(error.message || t('book.cancelFailed'), 'err', 5000); return; }
  row.status = 'cancelled';
  ui.toast(t('book.cancelled'), 'ok');
  renderMyAppts();
}

// =====================================================================
// TOKEN — take_token form, live .tcard with 12 s queue_status polling, share/print/cancel
// =====================================================================
const tk = { doctorId: null, name: null, phone: null, errors: {}, busy: false, live: null, bannerHidden: null };
const tkName = () => (tk.name ?? state.profile.name ?? '');
const tkPhone = () => (tk.phone ?? state.profile.phone ?? '');
const TOKEN_OPEN = ['waiting', 'serving'];
const TOKEN_CLOSED = ['done', 'skipped', 'cancelled'];
const POLL_MS = 12_000;
const MIN_PER_PATIENT = 10;
// Today's live token (waiting/serving), if any.
const activeToken = () => state.tokens.find((x) => TOKEN_OPEN.includes(x.status) && x.day === todayISO());
// Today's finished token (done/skipped) for the closed banner.
const closedToken = () => state.tokens.find((x) => (x.status === 'done' || x.status === 'skipped') && x.day === todayISO());

export function renderToken(force = false) {
  const tok = activeToken();
  if (tok) {
    $('tokenForm').innerHTML = '';
    renderTokenCard(tok);
    startTokenPoll();
    return;
  }
  $('tokenLive').innerHTML = '';
  if (force || !typingInEl('tokenForm')) renderTokenForm();
}

function renderTokenForm() {
  const el = $('tokenForm');
  const e = tk.errors;
  const closed = closedToken();
  const banner = closed && tk.bannerHidden !== closed.id
    ? `<div class="card tbanner ${esc(closed.status)}" role="status">
        <span class="ico" aria-hidden="true">${closed.status === 'done' ? '✅' : '⏭️'}</span>
        <span class="txt">${esc(t(closed.status === 'done' ? 'token.doneNote' : 'token.skippedNote', { n: closed.tokenNo }))}</span>
        <button type="button" class="btn btn-ghost sm" data-new-token><span class="lbl">${esc(t('token.newToken'))}</span></button>
      </div>`
    : '';
  const field = (k, id, label, value, extra = '') => `<div class="field ${e[k] ? 'invalid' : ''}">
      <label for="${id}">${esc(label)}</label>
      <input id="${id}" name="${k}" value="${esc(value)}" ${extra}>
      <div class="field-err" role="alert">${esc(e[k] ? t(e[k]) : '')}</div>
    </div>`;
  el.innerHTML = `${banner}
  <div class="card tintro"><span class="ico" aria-hidden="true">🎫</span><p>${esc(t('token.intro'))}</p></div>
  <form class="bform card" id="tkform" novalidate>
    <div class="blbl">${esc(t('token.chooseDoctor'))}</div>
    ${doctorRadiosHtml('tkdoc', tk.doctorId, e.doctor)}
    <div class="field-row">
      ${field('name', 'tkName', t('token.patientName'), tkName(), 'autocomplete="name" maxlength="80"')}
      ${field('phone', 'tkPhone', t('token.phone'), tkPhone(), 'inputmode="numeric" autocomplete="tel-national" maxlength="14"')}
    </div>
    <button type="submit" class="btn btn-gold block" ${tk.busy ? 'aria-busy="true"' : ''}>
      <span class="ico" aria-hidden="true">🎫</span>
      <span class="lbl">${esc(tk.busy ? t('token.getting') : t('token.get'))}</span>
    </button>
    <p class="muted hint">${esc(t('token.note'))}</p>
  </form>`;
  el.querySelector('[data-new-token]')?.addEventListener('click', () => {
    tk.bannerHidden = closed.id;
    renderTokenForm();
    $('tkform').querySelector('input[name="tkdoc"]')?.focus();
  });
  el.querySelectorAll('input[name="tkdoc"]').forEach((r) => r.addEventListener('change', () => {
    tk.doctorId = r.value;
    delete tk.errors.doctor;
    el.querySelectorAll('.dradio').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
    el.querySelector('.dpick + .field-err').textContent = '';
  }));
  $('tkName').addEventListener('input', (ev) => { tk.name = ev.target.value; });
  $('tkPhone').addEventListener('input', (ev) => { tk.phone = ev.target.value; });
  $('tkform').addEventListener('submit', (ev) => { ev.preventDefault(); takeToken(); });
}

async function takeToken() {
  if (tk.busy) return;
  const errors = {};
  const phone = digits(tkPhone());
  const doc = docById(tk.doctorId);
  if (!doc) errors.doctor = 'token.errDoctor';
  if (tkName().trim().length < 2) errors.name = 'token.errName';
  if (!/^\d{10}$/.test(phone)) errors.phone = 'token.errPhone';
  tk.errors = errors;
  if (Object.keys(errors).length) {
    renderTokenForm();
    const first = Object.keys(errors)[0];
    (first === 'doctor' ? $('tkform').querySelector('input[name="tkdoc"]') : $(first === 'name' ? 'tkName' : 'tkPhone'))?.focus();
    return;
  }
  const patientName = tkName().trim();
  tk.busy = true;
  renderTokenForm();
  const { data, error } = await safe((db) => db.rpc('take_token', { p_doctor_id: doc.id, p_patient_name: patientName, p_phone: phone }));
  tk.busy = false;
  if (error || !data) {
    // Server messages (phone limit, doctor unavailable, already has a token) shown verbatim.
    ui.toast(error?.message || t('token.failed'), 'err', 5000);
    renderTokenForm();
    return;
  }
  if (!state.profile.name) state.profile.name = patientName;
  if (!state.profile.phone) state.profile.phone = phone;
  saveProfile();
  state.tokens.unshift({
    id: data.id, tokenNo: Number(data.token_no), day: String(data.day), doctorId: doc.id,
    doctorName: data.doctor_name || doc.name, patientName, phone, status: 'waiting', createdAt: new Date().toISOString(),
  });
  state.tokens = state.tokens.slice(0, 10);
  saveTokens();
  tk.live = { serving_no: data.serving_no ?? null, ahead: data.ahead ?? null, my_status: 'waiting' };
  renderToken(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- live card
function renderTokenCard(tok) {
  const q = tk.live;
  const serving = tok.status === 'serving';
  const started = q?.serving_no != null && Number(q.serving_no) > 0;
  // ahead comes from the server only (null until the first queue_status reply) — never guessed.
  const ahead = q ? (serving ? 0 : Math.max(0, Number(q.ahead ?? 0))) : null;
  const stat = (label, value) => `<div class="tstat"><span class="lbl">${esc(label)}</span><b>${value}</b></div>`;
  const abtn = (attr, cls, ico, label) => `<button type="button" class="btn ${cls} sm" ${attr}><span class="ico" aria-hidden="true">${ico}</span><span class="lbl">${esc(label)}</span></button>`;
  $('tokenLive').innerHTML = `<div class="tlive">
    <article class="card tcard ${serving ? 'turn' : ''}" aria-live="polite">
      <div class="thead"><span class="thosp">${esc(hospitalName())}</span><span class="pill pill-live">${esc(t('token.liveUpdating'))}</span></div>
      <div class="tlabel">${esc(t('token.label'))}</div>
      <div class="tno" id="tokenNo">#${esc(tok.tokenNo)}</div>
      <div class="tdoc">${esc(tok.doctorName)}</div>
      <div class="tmeta">${esc(fmtDay(tok.day))} · ${esc(tok.patientName)}</div>
      ${serving
        ? `<div class="tturn" role="status">🔔 ${esc(t('token.yourTurn'))}</div>`
        : `<span class="pill pill-${esc(tok.status)} tpill">${esc(t(`token.status.${tok.status}`))}</span>`}
    </article>
    <div class="card tstats" aria-live="polite">
      ${stat(t('token.nowServing'), started ? `#${esc(q.serving_no)}` : `<span class="muted">${esc(t('token.notStarted'))}</span>`)}
      ${stat(t('token.ahead'), ahead == null ? '—' : esc(ahead))}
      ${stat(t('token.estWait'), serving ? esc(t('token.pleaseWait')) : ahead == null ? '—' : esc(t('common.approxMin', { n: ahead * MIN_PER_PATIENT })))}
    </div>
    <p class="muted hint">${esc(t('token.waitingHint'))}</p>
    <div class="oactions tactions">
      ${abtn('data-share', 'btn-teal', '📤', t('token.share'))}
      ${abtn('data-print', 'btn-ghost', '🖨️', t('token.print'))}
      ${tok.status === 'waiting' ? abtn('data-cancel', 'btn-ghost danger', '✕', t('token.cancel')) : ''}
    </div>
  </div>`;
  const root = $('tokenLive');
  root.querySelector('[data-share]').addEventListener('click', (ev) => shareToken(tok, ev.currentTarget));
  root.querySelector('[data-print]').addEventListener('click', () => printToken(tok));
  root.querySelector('[data-cancel]')?.addEventListener('click', (ev) => cancelToken(tok, ev.currentTarget));
}

// --- polling: every 12 s while today's token is waiting/serving and the tab is visible
let tokenTimer = null;
async function pollToken() {
  const tok = activeToken();
  if (!tok) { stopTokenPoll(); return; }
  if (document.hidden) return;
  const { data, error } = await safe((db) => db.rpc('queue_status', { p_doctor_id: tok.doctorId, p_token_no: tok.tokenNo }));
  if (error || !data) return;
  tk.live = data;
  const st = data.my_status;
  if (st && st !== tok.status && [...TOKEN_OPEN, ...TOKEN_CLOSED].includes(st)) {
    tok.status = st;
    saveTokens();
    if (st === 'serving') ui.toast(t('token.yourTurn'), 'ok', 6000);
  }
  if (TOKEN_CLOSED.includes(tok.status)) stopTokenPoll();
  if (state.route.name === 'token') renderToken(true);
}
function startTokenPoll() {
  if (tokenTimer) return;
  pollToken();
  tokenTimer = setInterval(pollToken, POLL_MS);
}
function stopTokenPoll() { clearInterval(tokenTimer); tokenTimer = null; }

// --- cancel: RPC then re-check the queue (the RPC returns void)
async function cancelToken(tok, btn) {
  const ok = await ui.confirm({ title: t('token.cancel'), body: t('token.cancelConfirm', { n: tok.tokenNo }), ok: t('token.cancel'), cancel: t('common.keep'), danger: true });
  if (!ok) return;
  btn?.setAttribute('aria-busy', 'true');
  const { error } = await safe((db) => db.rpc('cancel_token', { p_token_id: tok.id }));
  const re = await safe((db) => db.rpc('queue_status', { p_doctor_id: tok.doctorId, p_token_no: tok.tokenNo }));
  btn?.removeAttribute('aria-busy');
  const st = re.data?.my_status;
  if (!st || st === 'waiting') {
    ui.toast(error?.message || t('token.cancelFailed'), 'err', 5000);
    return;
  }
  tok.status = st;
  saveTokens();
  tk.live = re.data;
  if (st === 'cancelled') { ui.toast(t('token.cancelled'), 'ok'); stopTokenPoll(); }
  renderToken(true);
}

// --- share: draw the card on a canvas → Web Share (files) or PNG download
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function drawTokenCanvas(tok) {
  const W = 720; const H = 900;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const serving = tok.status === 'serving';
  const grad = g.createLinearGradient(0, 0, W, H);
  if (serving) { grad.addColorStop(0, '#92400e'); grad.addColorStop(1, '#d97706'); }
  else { grad.addColorStop(0, '#0a1628'); grad.addColorStop(0.55, '#0f4c75'); grad.addColorStop(1, '#205295'); }
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = grad;
  roundRect(g, 24, 24, W - 48, H - 48, 40);
  g.fill();
  // soft blob
  g.fillStyle = 'rgba(0,206,201,.22)';
  g.beginPath(); g.arc(W - 80, 110, 190, 0, Math.PI * 2); g.fill();
  const F = '"DM Sans", "Noto Sans Devanagari", "Segoe UI", system-ui, sans-serif';
  const D = '"Playfair Display", "Noto Sans Devanagari", Georgia, serif';
  g.textAlign = 'center';
  g.fillStyle = '#ffffff';
  g.font = `700 34px ${F}`;
  g.fillText(hospitalName(), W / 2, 120, W - 120);
  g.fillStyle = 'rgba(255,255,255,.72)';
  g.font = `700 22px ${F}`;
  g.fillText(t('token.label').toUpperCase(), W / 2, 215, W - 120);
  g.fillStyle = '#ffffff';
  g.font = `800 230px ${D}`;
  g.fillText(`#${tok.tokenNo}`, W / 2, 470, W - 120);
  g.font = `700 38px ${F}`;
  g.fillText(tok.doctorName, W / 2, 560, W - 120);
  g.fillStyle = 'rgba(255,255,255,.85)';
  g.font = `500 28px ${F}`;
  g.fillText(`${fmtDay(tok.day)} · ${tok.patientName}`, W / 2, 615, W - 120);
  if (serving) {
    g.fillStyle = '#ffffff';
    g.font = `700 30px ${F}`;
    g.fillText(t('token.yourTurn'), W / 2, 690, W - 120);
  }
  g.fillStyle = 'rgba(255,255,255,.7)';
  g.font = `500 24px ${F}`;
  g.fillText(t('token.issuedAt', { time: fmtTime(tok.createdAt) }), W / 2, 790, W - 120);
  g.font = `500 20px ${F}`;
  g.fillText(location.origin + location.pathname, W / 2, 835, W - 120);
  return c;
}
async function shareToken(tok, btn) {
  btn?.setAttribute('aria-busy', 'true');
  try {
    const canvas = drawTokenCanvas(tok);
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
    const file = new File([blob], `token-${tok.tokenNo}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: `${hospitalName()} · ${t('token.label')} #${tok.tokenNo}` });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      ui.toast(t('token.saved'), 'ok');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') ui.toast(t('token.shareFailed'), 'err');
  } finally {
    btn?.removeAttribute('aria-busy');
  }
}

// --- print slip via #printArea
function printToken(tok) {
  const s = state.settings ?? {};
  $('printArea').innerHTML = `<div class="pbill pslip">
    <div class="pb-head">
      <h1>${esc(hospitalName())}</h1>
      <p>${esc([s.address, s.phone].filter(Boolean).join(' · '))}</p>
    </div>
    <h2>${esc(t('token.slipTitle'))}</h2>
    <div class="big">#${esc(tok.tokenNo)}</div>
    <div class="meta">
      <div><b>${esc(t('token.doctor'))}</b><br>${esc(tok.doctorName)}</div>
      <div><b>${esc(t('token.patient'))}</b><br>${esc(tok.patientName)}<br>${esc(tok.phone)}</div>
      <div><b>${esc(t('token.day'))}</b><br>${esc(fmtDay(tok.day))}</div>
      <div><b>${esc(t('token.status.waiting'))}</b><br>${esc(t('token.issuedAt', { time: fmtTime(tok.createdAt) }))}</div>
    </div>
    <p class="thanks">${esc(t('token.waitingHint'))}</p>
  </div>`;
  window.print();
}

// =====================================================================
// MY ORDERS — sync via my_orders_status, status timeline, payments, bill
// =====================================================================
const ORDER_STEPS = ['placed', 'verified', 'packed', 'shipped', 'delivered'];
const STEP_ICON = { placed: '🧾', verified: '✅', packed: '📦', shipped: '🛵', delivered: '🏠' };
export const isActiveOrder = (o) => o.status !== 'delivered' && o.status !== 'cancelled';
export const orderByNumber = (n) => state.orders.find((o) => o.orderNumber === n);
const fmtDate = (iso, year = false) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });
};
const orderQty = (o) => (o.items ?? []).reduce((a, it) => a + Number(it.qty || 0), 0);
// Payment pill: paid/refunded from the server; cod when unpaid by cash; 'verifying'
// only while the local "I have paid" claim is set and the server still says pending.
function payState(o) {
  if (o.payStatus === 'paid') return 'paid';
  if (o.payStatus === 'refunded') return 'refunded';
  if (o.payMethod === 'cod') return 'cod';
  return o.claimed ? 'verifying' : 'pending';
}
const canPayAgain = (o) => o.payStatus === 'pending' && o.status !== 'cancelled' && o.payMethod !== 'cod';
const canSwitchCod = (o) => o.payStatus === 'pending' && o.payMethod !== 'cod' && o.status !== 'delivered' && o.status !== 'cancelled';
const canCancel = (o) => o.status === 'placed' || o.status === 'verified';

// --- sync: on #orders show, on visibilitychange→visible and window focus (debounced 2 s)
let syncing = false;
let syncState = '';   // '' | 'syncing' | 'synced' | 'offline'
function paintSync() {
  const el = $('ordersSync');
  el.textContent = syncState === 'syncing' ? t('orders.syncing') : syncState === 'synced' ? t('orders.synced') : syncState === 'offline' ? t('common.offline') : '';
}
export async function syncOrders() {
  const active = state.orders.filter(isActiveOrder);
  if (!active.length) { syncState = ''; paintSync(); return; }
  if (syncing) return;
  syncing = true;
  syncState = 'syncing';
  paintSync();
  const { data, error } = await safe((db) => db.rpc('my_orders_status', {
    p_keys: active.slice(0, 50).map((o) => ({ order_number: o.orderNumber, phone: o.phone })),
  }));
  syncing = false;
  if (error) { syncState = 'offline'; paintSync(); return; }
  for (const r of Array.isArray(data) ? data : []) {
    const o = orderByNumber(r.order_number);
    if (!o) continue;
    if (r.status) o.status = r.status;
    if (r.payment_status) o.payStatus = r.payment_status;
    if (r.payment_method) o.payMethod = r.payment_method;
    if (r.subtotal != null) o.subtotal = Number(r.subtotal);
    if (r.delivery_fee != null) o.deliveryFee = Number(r.delivery_fee);
    if (r.discount != null) o.discount = Number(r.discount);
    if (r.coupon_code !== undefined) o.couponCode = r.coupon_code ?? null;
    if (r.total != null) o.total = Number(r.total);
    if (Array.isArray(r.items) && r.items.length) {
      o.items = r.items.map((it) => ({ medicineId: it.medicine_id, name: it.name, packSize: it.pack_size ?? '', price: Number(it.price), qty: Number(it.qty) }));
    }
    if (o.payStatus !== 'pending') { o.claimed = false; }
  }
  saveOrders();
  syncState = 'synced';
  paintSync();
  if (state.route.name === 'orders') renderOrders();
}
const syncOrdersDebounced = ui.debounce(() => { if (state.route.name === 'orders') syncOrders(); }, 2000);

// --- per-card UI state that must survive re-renders
const expanded = new Set();     // order numbers with details open
const claimOpen = new Set();    // order numbers with the "I have paid" ref box open
const claimDraft = {};          // orderNumber → typed ref
const typingIn = (id) => { const a = document.activeElement; return !!a && !!$(id)?.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName); };

function timelineHtml(o) {
  if (o.status === 'cancelled') return `<div class="timeline cancelled"><div class="tl-cancel">⛔ ${esc(t('orders.cancelledBanner'))}</div></div>`;
  const cur = Math.max(0, ORDER_STEPS.indexOf(o.status));
  return `<div class="timeline" role="list">${ORDER_STEPS.map((s, i) => {
    const done = i <= cur;
    const now = i === cur && o.status !== 'delivered';
    return `<div class="tl-step ${done ? 'done' : ''} ${now ? 'now' : ''}" role="listitem" ${now ? 'aria-current="step"' : ''}>
      <span class="tl-dot" aria-hidden="true">${done && !now ? '✓' : STEP_ICON[s]}</span>
      <span class="tl-lbl">${esc(t(`orders.status.${s}`))}</span>
    </div>`;
  }).join('')}</div>`;
}

function billHtml(o, cls = '') {
  return `<dl class="bill ${cls}">
    <div><dt>${esc(t('cart.itemsTotal'))}</dt><dd>${esc(inr(o.subtotal))}</dd></div>
    <div><dt>${esc(t('cart.delivery'))}</dt><dd>${o.deliveryFee ? esc(inr(o.deliveryFee)) : `<span class="free">${esc(t('common.free'))}</span>`}</dd></div>
    ${o.discount ? `<div class="disc"><dt>${esc(t('cart.discount'))}${o.couponCode ? ` <span class="muted">(${esc(o.couponCode)})</span>` : ''}</dt><dd>− ${esc(inr(o.discount))}</dd></div>` : ''}
    <div class="total"><dt>${esc(t('cart.toPay'))}</dt><dd>${esc(inr(o.total))}</dd></div>
  </dl>`;
}
const methodLabel = (m) => t(['upi', 'razorpay', 'cod'].includes(m) ? `orders.method.${m}` : 'orders.method.upi');
const addressLine = (o) => [o.address, o.city, o.pincode].filter(Boolean).join(', ');

function ocardHtml(o) {
  const n = o.orderNumber;
  const pay = payState(o);
  const open = expanded.has(n);
  const btn = (attr, cls, ico, label) => `<button type="button" class="btn ${cls} sm" ${attr}><span class="ico" aria-hidden="true">${ico}</span><span class="lbl">${esc(label)}</span></button>`;
  const actions = [];
  if (canPayAgain(o)) {
    actions.push(btn('data-pay', 'btn-gold', o.payMethod === 'razorpay' ? '💳' : '📱', t('orders.payAgain', { amount: inr(o.total) })));
    if (!o.claimed) actions.push(btn('data-claim', 'btn-ghost', '🧾', t('orders.iHavePaid')));
  }
  if (canSwitchCod(o)) actions.push(btn('data-cod', 'btn-ghost', '💵', t('orders.switchCod')));
  if (state.settings?.whatsapp) actions.push(`<a class="btn btn-wa sm" href="${esc(waHref(t('orders.whatsappMsg', { order: n })))}" target="_blank" rel="noopener"><span class="ico" aria-hidden="true">💬</span><span class="lbl">${esc(t('orders.whatsapp'))}</span></a>`);
  actions.push(btn('data-print', 'btn-ghost', '🖨️', t('orders.printBill')));
  if ((o.items ?? []).some((it) => medById(it.medicineId))) actions.push(btn('data-reorder', 'btn-ghost', '🔁', t('orders.reorder')));
  if (canCancel(o)) actions.push(btn('data-cancel', 'btn-ghost danger', '✕', t('orders.cancel')));
  const claim = claimOpen.has(n) ? `<form class="claim" data-claim-form novalidate>
      <label class="sr-only" for="ref-${esc(n)}">${esc(t('orders.refPlaceholder'))}</label>
      <input id="ref-${esc(n)}" value="${esc(claimDraft[n] ?? '')}" placeholder="${esc(t('orders.refPlaceholder'))}" maxlength="60" autocomplete="off" data-autofocus>
      <button type="submit" class="btn btn-teal sm"><span class="lbl">${esc(t('common.confirm'))}</span></button>
      <button type="button" class="btn btn-ghost sm" data-claim-cancel><span class="lbl">${esc(t('common.cancel'))}</span></button>
    </form>` : '';
  return `<article class="card ocard" data-order="${esc(n)}">
    <header class="ohead">
      <div>
        <div class="onum">${esc(n)}</div>
        <div class="ometa"><span>${esc(t('orders.placedOn', { date: fmtDate(o.createdAt) }))}</span><span>·</span><span>${esc(t(orderQty(o) === 1 ? 'common.item' : 'common.items', { n: orderQty(o) }))}</span></div>
      </div>
      <div class="ototal">${esc(inr(o.total))}</div>
    </header>
    <div class="opills">
      <span class="pill pill-${esc(o.status)}">${esc(t(ORDER_STEPS.includes(o.status) || o.status === 'cancelled' ? `orders.status.${o.status}` : 'orders.status.placed'))}</span>
      <span class="pill pill-${pay}">${esc(t(`orders.pay.${pay}`))}</span>
    </div>
    ${timelineHtml(o)}
    ${canPayAgain(o) && !o.claimed ? `<p class="muted hint left">${esc(t('orders.notPaidYet'))}</p>` : ''}
    <div class="oactions">${actions.join('')}</div>
    ${claim}
    <button type="button" class="btn btn-link sm otoggle" data-toggle aria-expanded="${open}" aria-controls="od-${esc(n)}">${esc(t(open ? 'orders.hide' : 'orders.details'))} ${open ? '▴' : '▾'}</button>
    <div class="odetails" id="od-${esc(n)}" ${open ? '' : 'hidden'}>
      <div>
        <div class="osub">${esc(t('orders.items'))}</div>
        <ul class="oitems">${(o.items ?? []).map((it) => `<li><span><b>${esc(it.name)}</b>${it.packSize ? ` <span class="muted">· ${esc(it.packSize)}</span>` : ''}<br><span class="muted">${esc(inr(it.price))} × ${esc(it.qty)}</span></span><b>${esc(inr(Number(it.price) * Number(it.qty)))}</b></li>`).join('')}</ul>
      </div>
      <div><div class="osub">${esc(t('orders.bill'))}</div>${billHtml(o)}</div>
      <div><div class="osub">${esc(t('orders.paymentLabel'))}</div><div class="oaddr">${esc(methodLabel(o.payMethod))} · ${esc(t(`orders.pay.${pay}`))}</div></div>
      <div><div class="osub">${esc(t('orders.deliverTo'))}</div><div class="oaddr"><b>${esc(o.name)}</b> · ${esc(o.phone)}<br>${esc(addressLine(o))}</div></div>
    </div>
  </article>`;
}

export function renderOrders(force = false) {
  paintSync();
  const seg = $('ordersFilter');
  setSegValue(seg, 'filter', state.ordersFilter);
  const el = $('ordersList');
  if (!force && typingIn('ordersList')) return; // keep the caret in the "I have paid" ref box
  const list = state.orders;
  if (!list.length) {
    seg.hidden = true;
    el.innerHTML = emptyState('📦', t('orders.empty'), t('orders.emptySub'),
      `<a class="btn btn-teal" href="#pharmacy"><span class="lbl">${esc(t('cart.browse'))}</span></a>`);
    return;
  }
  seg.hidden = false;
  const shown = list.filter((o) => (state.ordersFilter === 'all' ? true : state.ordersFilter === 'active' ? isActiveOrder(o) : !isActiveOrder(o)));
  if (!shown.length) { el.innerHTML = emptyState('📦', t('orders.empty')); return; }
  el.innerHTML = `<div class="olist">${shown.map(ocardHtml).join('')}</div>`;
  el.querySelectorAll('.ocard').forEach((card) => {
    const o = orderByNumber(card.dataset.order);
    if (!o) return;
    card.querySelector('[data-toggle]').addEventListener('click', () => {
      if (expanded.has(o.orderNumber)) expanded.delete(o.orderNumber); else expanded.add(o.orderNumber);
      renderOrders();
    });
    card.querySelector('[data-pay]')?.addEventListener('click', (e) => payOrder(o, e.currentTarget));
    card.querySelector('[data-claim]')?.addEventListener('click', () => { claimOpen.add(o.orderNumber); renderOrders(); $(`ref-${o.orderNumber}`)?.focus(); });
    card.querySelector('[data-claim-cancel]')?.addEventListener('click', () => { claimOpen.delete(o.orderNumber); renderOrders(); });
    card.querySelector(`#ref-${CSS.escape(o.orderNumber)}`)?.addEventListener('input', (e) => { claimDraft[o.orderNumber] = e.target.value; });
    card.querySelector('[data-claim-form]')?.addEventListener('submit', (e) => { e.preventDefault(); claimPaid(o, e.currentTarget.querySelector('[type="submit"]')); });
    card.querySelector('[data-cod]')?.addEventListener('click', (e) => switchToCod(o, e.currentTarget));
    card.querySelector('[data-cancel]')?.addEventListener('click', (e) => cancelOrder(o, e.currentTarget));
    card.querySelector('[data-print]')?.addEventListener('click', () => printBill(o));
    card.querySelector('[data-reorder]')?.addEventListener('click', () => reorder(o));
  });
}

// --- actions
function payOrder(o, btn) {
  if (o.payMethod === 'razorpay') { openRazorpay(o, btn); return; }
  ui.toast(t('pay.opening'), 'info', 2000);
  payUpi(o);
}

async function claimPaid(o, btn) {
  const ref = (claimDraft[o.orderNumber] ?? '').trim().slice(0, 60);
  btn?.setAttribute('aria-busy', 'true');
  const { error } = await safe((db) => db.rpc('claim_order_paid', { p_order_number: o.orderNumber, p_phone: o.phone, p_ref: ref || null }));
  btn?.removeAttribute('aria-busy');
  if (error) { ui.toast(error.message || t('orders.claimFailed'), 'err'); return; }
  o.claimed = true;
  o.claimedRef = ref || null;
  saveOrders();
  claimOpen.delete(o.orderNumber);
  delete claimDraft[o.orderNumber];
  ui.toast(t('orders.claimSent'), 'ok');
  renderOrders(true);
}

async function switchToCod(o, btn) {
  const ok = await ui.confirm({ title: t('orders.switchCod'), body: t('orders.switchCodConfirm', { amount: inr(o.total) }), ok: t('common.yes'), cancel: t('common.no') });
  if (!ok) return;
  btn?.setAttribute('aria-busy', 'true');
  const { error } = await safe((db) => db.rpc('set_my_payment_method', { p_order_number: o.orderNumber, p_phone: o.phone, p_method: 'cod' }));
  btn?.removeAttribute('aria-busy');
  if (error) { ui.toast(error.message || t('orders.switchFailed'), 'err'); return; }
  o.payMethod = 'cod';
  o.claimed = false;
  saveOrders();
  ui.toast(t('orders.switchedCod'), 'ok');
  renderOrders();
  if (state.settings?.whatsapp) {
    // Optional: let the hospital know on WhatsApp.
    const tell = await ui.confirm({ title: t('orders.switchedCod'), body: t('orders.codMsg', { order: o.orderNumber }), ok: t('common.whatsapp'), cancel: t('common.close') });
    if (tell) ui.openExternal(waHref(t('orders.codMsg', { order: o.orderNumber })));
  }
}

async function cancelOrder(o, btn) {
  const ok = await ui.confirm({ title: t('orders.cancel'), body: t('orders.cancelConfirm', { order: o.orderNumber }), ok: t('orders.cancel'), cancel: t('common.keep'), danger: true });
  if (!ok) return;
  btn?.setAttribute('aria-busy', 'true');
  const { error } = await safe((db) => db.rpc('cancel_my_order', { p_order_number: o.orderNumber, p_phone: o.phone }));
  btn?.removeAttribute('aria-busy');
  if (error) { ui.toast(error.message || t('orders.cancelFailed'), 'err', 5000); return; }
  o.status = 'cancelled';
  saveOrders();
  ui.toast(t('orders.cancelled'), 'ok');
  renderOrders();
}

// Printable bill: fill #printArea (print CSS hides everything else) and print.
export function printBill(o) {
  const s = state.settings ?? {};
  const pay = payState(o);
  $('printArea').innerHTML = `<div class="pbill">
    <div class="pb-head">
      <h1>${esc(hospitalName())}</h1>
      <p>${esc([s.address, s.phone].filter(Boolean).join(' · '))}</p>
    </div>
    <h2>${esc(t('orders.bill'))}</h2>
    <div class="meta">
      <div><b>${esc(t('orders.orderNo'))}</b><br>${esc(o.orderNumber)}</div>
      <div><b>${esc(t('orders.date'))}</b><br>${esc(fmtDate(o.createdAt, true))}</div>
      <div><b>${esc(t('orders.customer'))}</b><br>${esc(o.name)}<br>${esc(o.phone)}<br>${esc(addressLine(o))}</div>
      <div><b>${esc(t('orders.paymentLabel'))}</b><br>${esc(methodLabel(o.payMethod))}<br>${esc(t(`orders.pay.${pay}`))}</div>
    </div>
    <table>
      <thead><tr><th>${esc(t('orders.items'))}</th><th class="num">${esc(t('cart.qty'))}</th><th class="num">₹</th><th class="num">${esc(t('cart.total'))}</th></tr></thead>
      <tbody>${(o.items ?? []).map((it) => `<tr><td>${esc(it.name)}${it.packSize ? `<br><small>${esc(it.packSize)}</small>` : ''}</td><td class="num">${esc(it.qty)}</td><td class="num">${esc(inr(it.price))}</td><td class="num">${esc(inr(Number(it.price) * Number(it.qty)))}</td></tr>`).join('')}</tbody>
    </table>
    <div class="tot">
      <div>${esc(t('cart.itemsTotal'))}: ${esc(inr(o.subtotal))}</div>
      <div>${esc(t('cart.delivery'))}: ${o.deliveryFee ? esc(inr(o.deliveryFee)) : esc(t('common.free'))}</div>
      ${o.discount ? `<div>${esc(t('cart.discount'))}${o.couponCode ? ` (${esc(o.couponCode)})` : ''}: − ${esc(inr(o.discount))}</div>` : ''}
      <div><b>${esc(t('cart.toPay'))}: ${esc(inr(o.total))}</b></div>
    </div>
    <p class="thanks">${esc(t('orders.thankYou'))} 🙏</p>
  </div>`;
  window.print();
}

// Reorder: add each item to the cart, clamped to the current stock, then open the cart.
function reorder(o) {
  let added = 0;
  for (const it of o.items ?? []) {
    const m = medById(it.medicineId);
    if (!m) continue;
    const next = Math.min(stockOf(m), qtyOf(m.id) + Number(it.qty || 0));
    if (next <= 0) continue;
    if (next !== qtyOf(m.id)) { state.cart[m.id] = next; added++; }
    repaintActions(m.id);
  }
  if (!added) { ui.toast(t('shop.outOfStock'), 'err'); return; }
  saveCart();
  renderCartBadge(true);
  renderCartBar();
  ui.toast(t('orders.reordered'), 'ok');
  openCart();
}

// =====================================================================
// ACCOUNT SHEET (#sheetAccount) — Google / email code / password; signed-in panel
// =====================================================================
// Form draft survives re-renders (60s refresh, langchange); reset on sign-in/out.
const auth = { mode: 'code', step: 'email', email: '', code: '', password: '', newPassword: '', errors: {}, busy: false };
const resetAuth = () => { Object.assign(auth, { step: 'email', code: '', password: '', newPassword: '', errors: {}, busy: false }); };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function openAccount() {
  renderAccount();
  ui.openSheet('sheetAccount');
}

export function renderAccount() {
  const body = $('accountBody');
  const s = state.session;
  $('sheetAccountTitle').textContent = t(s ? 'account.title' : 'auth.title');
  if (s) { renderSignedIn(body, s); return; }
  const err = (k) => (auth.errors[k] ? `<div class="field-err" role="alert">${esc(t(auth.errors[k]))}</div>` : '<div class="field-err"></div>');
  const field = (k, id, label, type, extra = '') => `<div class="field ${auth.errors[k] ? 'invalid' : ''}">
      <label for="${id}">${esc(label)}</label>
      <input id="${id}" type="${type}" value="${esc(auth[k])}" ${extra}>
      ${err(k)}
    </div>`;
  const busy = auth.busy ? 'aria-busy="true"' : '';
  let form;
  if (auth.step === 'code') {
    form = `
      <p class="sent"><span class="ico" aria-hidden="true">📨</span> ${esc(t('auth.codeSent', { email: auth.email }))}</p>
      <p class="muted hint">${esc(t('auth.codeHint'))}</p>
      ${field('code', 'authCode', t('auth.code'), 'text', `class="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••••" data-autofocus`)}
      <button type="submit" class="btn btn-teal block" ${busy}><span class="lbl">${esc(t(auth.busy ? 'auth.verifying' : 'auth.verify'))}</span></button>
      <div class="btn-row two">
        <button type="button" class="btn btn-ghost" data-resend><span class="lbl">${esc(t('auth.resend'))}</span></button>
        <button type="button" class="btn btn-ghost" data-change-email><span class="lbl">${esc(t('auth.changeEmail'))}</span></button>
      </div>`;
  } else {
    form = `
      ${field('email', 'authEmail', t('auth.email'), 'email', `placeholder="${esc(t('auth.emailPlaceholder'))}" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false"`)}
      <div class="seg seg-block" id="authMode" role="radiogroup" aria-label="${esc(t('auth.title'))}">
        <span class="seg-thumb" aria-hidden="true"></span>
        <button type="button" class="seg-btn" role="radio" aria-checked="${auth.mode === 'code'}" data-mode="code">${esc(t('auth.modeCode'))}</button>
        <button type="button" class="seg-btn" role="radio" aria-checked="${auth.mode === 'password'}" data-mode="password">${esc(t('auth.modePassword'))}</button>
      </div>
      ${auth.mode === 'password'
        ? `${field('password', 'authPassword', t('auth.password'), 'password', 'autocomplete="current-password" minlength="6"')}
           <button type="submit" class="btn btn-teal block" ${busy}><span class="lbl">${esc(t('auth.signInBtn'))}</span></button>`
        : `<button type="submit" class="btn btn-teal block" ${busy}><span class="lbl">${esc(t(auth.busy ? 'auth.sending' : 'auth.sendCode'))}</span></button>`}
      <p class="muted hint">${esc(t('auth.newHere'))}</p>`;
  }
  body.innerHTML = `<div class="auth">
    <p class="sub">${esc(t('auth.sub'))}</p>
    <button type="button" class="btn btn-ghost block btn-google" data-google>
      <svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.8 6.1C12.4 13.4 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>
      <span class="lbl">${esc(t('auth.google'))}</span>
    </button>
    <div class="or"><span>${esc(t('auth.orEmail'))}</span></div>
    <form id="authForm" novalidate>${form}</form>
  </div>`;

  // wiring
  body.querySelector('[data-google]').addEventListener('click', signInGoogle);
  $('authEmail')?.addEventListener('input', (e) => { auth.email = e.target.value; clearAuthErr('email', e.target); });
  $('authPassword')?.addEventListener('input', (e) => { auth.password = e.target.value; clearAuthErr('password', e.target); });
  $('authCode')?.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); auth.code = e.target.value; clearAuthErr('code', e.target); });
  const seg = $('authMode');
  if (seg) initSeg(seg, (b) => { auth.mode = b.dataset.mode; auth.errors = {}; renderAccount(); $('authEmail')?.focus(); });
  $('authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (auth.step === 'code') verifyCode();
    else if (auth.mode === 'password') signInPassword();
    else sendCode();
  });
  body.querySelector('[data-resend]')?.addEventListener('click', sendCode);
  body.querySelector('[data-change-email]')?.addEventListener('click', () => { auth.step = 'email'; auth.code = ''; auth.errors = {}; renderAccount(); $('authEmail')?.focus(); });
}
function clearAuthErr(k, input) {
  if (!auth.errors[k]) return;
  delete auth.errors[k];
  const f = input.closest('.field');
  f?.classList.remove('invalid');
  const e = f?.querySelector('.field-err');
  if (e) e.textContent = '';
}
function setAuthBusy(v) { auth.busy = v; if (ui.currentSheet() === 'sheetAccount') renderAccount(); }

async function signInGoogle() {
  const { error } = await safe((db) => db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }));
  if (error) ui.toast(t('auth.googleFailed'), 'err');
}
async function sendCode() {
  if (auth.busy) return;
  const email = auth.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) { auth.errors.email = 'auth.errEmail'; renderAccount(); $('authEmail')?.focus(); return; }
  auth.email = email;
  setAuthBusy(true);
  const { error } = await safe((db) => db.auth.signInWithOtp({ email, options: { shouldCreateUser: true } }));
  auth.busy = false;
  if (error) { ui.toast(error.message || t('auth.failed'), 'err', 5000); renderAccount(); return; }
  auth.step = 'code';
  auth.code = '';
  auth.errors = {};
  renderAccount();
  ui.toast(t('auth.codeSent', { email }), 'ok');
  $('authCode')?.focus();
}
async function verifyCode() {
  if (auth.busy) return;
  const token = auth.code.trim();
  if (!/^\d{6}$/.test(token)) { auth.errors.code = 'auth.errCode'; renderAccount(); $('authCode')?.focus(); return; }
  setAuthBusy(true);
  const { error } = await safe((db) => db.auth.verifyOtp({ email: auth.email, token, type: 'email' }));
  auth.busy = false;
  if (error) { ui.toast(error.message || t('auth.failed'), 'err', 5000); renderAccount(); $('authCode')?.focus(); return; }
  ui.toast(t('auth.welcome'), 'ok');
  resetAuth(); // onAuthStateChange → paintAuth re-renders the signed-in panel
}
async function signInPassword() {
  if (auth.busy) return;
  const email = auth.email.trim().toLowerCase();
  auth.errors = {};
  if (!EMAIL_RE.test(email)) auth.errors.email = 'auth.errEmail';
  if (auth.password.length < 6) auth.errors.password = 'auth.errPassword';
  if (Object.keys(auth.errors).length) { renderAccount(); $(auth.errors.email ? 'authEmail' : 'authPassword')?.focus(); return; }
  auth.email = email;
  setAuthBusy(true);
  const { error } = await safe((db) => db.auth.signInWithPassword({ email, password: auth.password }));
  auth.busy = false;
  if (error) { ui.toast(error.message || t('auth.failed'), 'err', 5000); renderAccount(); return; }
  ui.toast(t('auth.welcome'), 'ok');
  resetAuth();
}

function renderSignedIn(body, s) {
  const who = s.user.email ?? s.user.phone ?? '';
  body.innerHTML = `<div class="auth">
    <div class="acct-head">
      <span class="ico" aria-hidden="true">🙏</span>
      <span class="muted">${esc(t('account.signedInAs'))}</span>
      <b>${esc(who)}</b>
      <p class="muted hint">${esc(t('account.sameApp'))}</p>
    </div>
    <div class="menu-list">
      <a class="menu-item" href="#orders" data-close-sheet><span class="ico" aria-hidden="true">📦</span><span>${esc(t('account.myOrders'))}</span><span class="chev" aria-hidden="true">›</span></a>
      <a class="menu-item" href="#book/my" data-close-sheet><span class="ico" aria-hidden="true">📅</span><span>${esc(t('account.myAppointments'))}</span><span class="chev" aria-hidden="true">›</span></a>
    </div>
    <div class="divider"></div>
    <form id="pwForm" novalidate>
      <div class="field ${auth.errors.newPassword ? 'invalid' : ''}">
        <label for="newPassword">${esc(t('account.setPassword'))}</label>
        <input id="newPassword" type="password" value="${esc(auth.newPassword)}" placeholder="${esc(t('account.newPassword'))}" autocomplete="new-password" minlength="6">
        <div class="field-err" role="alert">${esc(auth.errors.newPassword ? t(auth.errors.newPassword) : '')}</div>
      </div>
      <button type="submit" class="btn btn-ghost block" ${auth.busy ? 'aria-busy="true"' : ''}><span class="ico" aria-hidden="true">🔑</span><span class="lbl">${esc(t('account.savePassword'))}</span></button>
    </form>
    <button type="button" class="btn btn-link block" data-signout><span class="lbl">${esc(t('account.signOut'))}</span></button>
  </div>`;
  $('newPassword').addEventListener('input', (e) => { auth.newPassword = e.target.value; clearAuthErr('newPassword', e.target); });
  $('pwForm').addEventListener('submit', (e) => { e.preventDefault(); savePassword(); });
  body.querySelector('[data-signout]').addEventListener('click', async () => {
    await safe((db) => db.auth.signOut());
    resetAuth();
    ui.toast(t('account.signedOut'), 'ok');
    ui.closeSheet();
  });
}
async function savePassword() {
  if (auth.busy) return;
  if (auth.newPassword.length < 6) { auth.errors.newPassword = 'auth.errPassword'; renderAccount(); $('newPassword')?.focus(); return; }
  setAuthBusy(true);
  const { error } = await safe((db) => db.auth.updateUser({ password: auth.newPassword }));
  auth.busy = false;
  if (error) { ui.toast(error.message || t('account.passwordFailed'), 'err', 5000); renderAccount(); return; }
  auth.newPassword = '';
  ui.toast(t('account.passwordSaved'), 'ok');
  renderAccount();
}

// ---------------- auth state ----------------
function paintAuth() {
  $('accountDot').hidden = !state.session;
  if (ui.currentSheet() === 'sheetAccount') renderAccount();
  if (ui.currentSheet() === 'sheetProduct') renderReviews();   // write-review block depends on session
  if (ui.currentSheet() === 'sheetCart') renderCart();         // sign-in nudge
}
getDb().then((db) => {
  db.auth.onAuthStateChange((e, s) => {
    state.session = s;
    if (e === 'SIGNED_IN' || e === 'SIGNED_OUT') resetAuth();
    paintAuth();
    renderBook();
  });
  db.auth.getSession().then(({ data }) => { state.session = data.session; paintAuth(); });
});

// ---------------- wiring ----------------
function initChrome() {
  $('skipLink').addEventListener('click', (e) => { e.preventDefault(); $('main').focus(); });
  const hdr = $('hdr');
  const onScroll = () => hdr.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  $('cartBtn').addEventListener('click', openCart);
  $('cartBtnBar').addEventListener('click', openCart);
  $('accountBtn').addEventListener('click', openAccount);
  $('menuAccount').addEventListener('click', openAccount);
  $('menuBtn').addEventListener('click', () => ui.openSheet('sheetMenu'));

  // links inside sheets that navigate: close the sheet first
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-close-sheet]');
    if (a) ui.closeSheet();
  });

  // orders filter seg (All · Active · Past)
  const seg = $('ordersFilter');
  initSeg(seg, (b) => { state.ordersFilter = b.dataset.filter; setSegValue(seg, 'filter', b.dataset.filter); renderOrders(); });

  // pharmacy search: filter the grid 300ms after the last keystroke; clear = instant
  const search = $('search');
  const clear = $('searchClear');
  search.addEventListener('input', () => { state.query = search.value.trim(); clear.hidden = !search.value; renderGridDebounced(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); renderGrid(); } });
  clear.addEventListener('click', () => { search.value = ''; state.query = ''; clear.hidden = true; search.focus(); renderGrid(); });
}

// ---------------- boot ----------------
initLang();
initTheme();
initChrome();
initCarousel();
initLangSegs();
hydrateFromCache(); // repeat visit: paint saved content before supabase-js is even fetched
document.documentElement.classList.add('js'); // enables the scroll-reveal animation (.js .reveal) — skeletons stay visible until here
router();
// router() only draws the active screen; with cached settings the chrome (Call/WhatsApp links,
// footer, cart badge) must be drawn now too — loadAll() skips renderAll() when nothing changed.
if (hadCache) { renderChrome(); renderCartBadge(); renderCartBar(); }
loadAll();
if (activeToken()) startTokenPoll(); // keep today's token status fresh even off the token screen

onLangChange(() => {
  syncLangSegs();
  renderAll(true);
});
window.addEventListener('hashchange', router);
setInterval(loadAll, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadAll();
    if (state.route.name === 'home') loadQueue();
    if (activeToken()) pollToken();
    syncOrdersDebounced();
  }
});
window.addEventListener('focus', syncOrdersDebounced);

// Service worker: relative 'sw.js' so the GitHub Pages subpath scope is correct.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
  const reg = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg, { once: true });
}
