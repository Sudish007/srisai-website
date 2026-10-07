// ui.js — DOM primitives shared by every screen: esc/inr helpers, toasts,
// the single sheet component (bottom sheet <720px, dialog >=720px),
// confirm dialog, skeletons, count-up, scroll reveal.
import { t } from './i18n.js';

export const $ = (id) => document.getElementById(id);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export const debounce = (fn, ms = 300) => {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
};

// ---------------- toasts ----------------
const TOAST_ICON = { ok: '✅', err: '⚠️', info: 'ℹ️' };

export function toast(message, type = 'info', ms = 3500) {
  const host = $('toasts');
  if (!host) return;
  while (host.children.length >= 2) host.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="ico" aria-hidden="true">${TOAST_ICON[type] ?? TOAST_ICON.info}</span><span class="toast-msg">${esc(message)}</span>`;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  let startX = null;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  const timer = setTimeout(dismiss, ms);
  el.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
  el.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) > 60) { clearTimeout(timer); dismiss(); }
  }, { passive: true });
}

// ---------------- sheet (one open at a time) ----------------
let openId = null;
let onCloseCb = null;
let lastFocus = null;
let dragStartY = null;
let dragging = false;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function trapFocus(e) {
  if (e.key !== 'Tab' || !openId) return;
  const sheet = $(openId);
  const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (items.length === 0) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function onKey(e) {
  if (e.key === 'Escape' && openId) { e.preventDefault(); closeSheet(); }
  else trapFocus(e);
}

function onDragStart(e) {
  const sheet = $(openId);
  if (!sheet || window.innerWidth >= 720) return;
  const body = sheet.querySelector('.sheet-body');
  const fromHandle = e.target.closest('.sheet-handle, .sheet-head');
  // allow drag from the handle/head, or from the body when scrolled to top
  if (!fromHandle && body && body.scrollTop > 0) return;
  dragStartY = e.touches[0].clientY;
  dragging = true;
  sheet.style.transition = 'none';
}

function onDragMove(e) {
  if (!dragging) return;
  const dy = e.touches[0].clientY - dragStartY;
  if (dy <= 0) return;
  $(openId).style.transform = `translateY(${dy}px)`;
}

function onDragEnd(e) {
  if (!dragging) return;
  const sheet = $(openId);
  const dy = e.changedTouches[0].clientY - dragStartY;
  dragging = false;
  sheet.style.transition = '';
  sheet.style.transform = '';
  if (dy > 80) closeSheet();
}

export function openSheet(id, { onClose } = {}) {
  if (openId && openId !== id) closeSheet({ silent: true });
  const sheet = $(id);
  const overlay = $('overlay');
  if (!sheet || !overlay) return;
  if (openId !== id) lastFocus = document.activeElement;
  openId = id;
  onCloseCb = onClose ?? null;
  overlay.hidden = false;
  sheet.hidden = false;
  document.body.classList.add('scroll-lock');
  requestAnimationFrame(() => { overlay.classList.add('in'); sheet.classList.add('in'); });
  document.addEventListener('keydown', onKey);
  sheet.addEventListener('touchstart', onDragStart, { passive: true });
  sheet.addEventListener('touchmove', onDragMove, { passive: true });
  sheet.addEventListener('touchend', onDragEnd, { passive: true });
  const focusTarget = sheet.querySelector('[data-autofocus]') || sheet.querySelector('.sheet-close') || sheet;
  setTimeout(() => focusTarget.focus?.({ preventScroll: true }), 50);
}

export function closeSheet({ silent = false } = {}) {
  if (!openId) return;
  const id = openId;
  const sheet = $(id);
  const overlay = $('overlay');
  const cb = onCloseCb;
  openId = null;
  onCloseCb = null;
  document.removeEventListener('keydown', onKey);
  sheet.removeEventListener('touchstart', onDragStart);
  sheet.removeEventListener('touchmove', onDragMove);
  sheet.removeEventListener('touchend', onDragEnd);
  sheet.classList.remove('in');
  if (!silent) overlay.classList.remove('in');
  document.body.classList.remove('scroll-lock');
  setTimeout(() => {
    sheet.hidden = true;
    if (!openId) overlay.hidden = true;
  }, 300);
  if (!silent && lastFocus && lastFocus.focus) { lastFocus.focus({ preventScroll: true }); lastFocus = null; }
  if (cb) cb();
}

export const currentSheet = () => openId;

// Overlay click + sheet-close buttons are wired once.
document.addEventListener('click', (e) => {
  if (e.target.id === 'overlay') closeSheet();
  else if (e.target.closest('.sheet-close')) closeSheet();
});

// ---------------- confirm dialog ----------------
export function confirm({ title = '', body = '', ok, cancel, danger = false } = {}) {
  return new Promise((resolve) => {
    const sheet = $('sheetConfirm');
    if (!sheet) { resolve(false); return; }
    sheet.querySelector('.confirm-title').textContent = title;
    sheet.querySelector('.confirm-body').textContent = body;
    const okBtn = sheet.querySelector('.confirm-ok');
    const cancelBtn = sheet.querySelector('.confirm-cancel');
    okBtn.textContent = ok ?? t('common.confirm');
    cancelBtn.textContent = cancel ?? t('common.cancel');
    okBtn.classList.toggle('btn-danger', danger);
    okBtn.classList.toggle('btn-teal', !danger);
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      resolve(v);
    };
    okBtn.onclick = () => { finish(true); closeSheet(); };
    cancelBtn.onclick = () => { finish(false); closeSheet(); };
    openSheet('sheetConfirm', { onClose: () => finish(false) });
  });
}

// ---------------- skeletons ----------------
export function skeleton(kind = 'card', n = 1) {
  const cls = { card: 'sk sk-card', line: 'sk sk-line', banner: 'sk sk-banner', circle: 'sk sk-circle' }[kind] ?? 'sk sk-card';
  return Array.from({ length: n }, () => `<div class="${cls}" aria-hidden="true"></div>`).join('');
}

// ---------------- count-up (port of old countUpWhenVisible, per element) ----------------
export function countUp(el, target, { duration = 1400 } = {}) {
  const str = String(target ?? '');
  const num = parseInt(str.replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(num) || num <= 0) { el.textContent = str; return; }
  const prefix = str.match(/^[^0-9]*/)[0];
  const suffix = str.replace(/^[^0-9]*[0-9,]+/, '');
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = prefix + Math.round(num * eased).toLocaleString('en-IN') + suffix;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = str;
  };
  requestAnimationFrame(tick);
}

// ---------------- scroll reveal ----------------
let revealObs = null;
export function reveal(root = document) {
  if (!revealObs) {
    revealObs = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); revealObs.unobserve(e.target); }
      }),
      { threshold: 0.12 },
    );
  }
  root.querySelectorAll('.reveal:not(.in)').forEach((el) => revealObs.observe(el));
}

// ---------------- misc ----------------
export function bump(el) {
  if (!el) return;
  el.classList.remove('bump');
  // force reflow so the animation restarts
  void el.offsetWidth;
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 300);
}

export function openExternal(url) {
  window.open(url, '_blank', 'noopener');
}
