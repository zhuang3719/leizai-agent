// A1 前端 · 媒体灯箱（全屏查看大图 / 播放视频）——单例，供缩略图 / 聊天气泡复用
// 用法：import { openImageLightbox, openVideoLightbox } from '../image-lightbox.js';
//   openImageLightbox(src) → 全屏看图；openVideoLightbox(src) → 全屏看/播视频（原生控制条）
let box = null;
let imgEl = null;
let vidEl = null;

function ensureBox() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'img-lightbox';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', '媒体查看');
  box.innerHTML =
    '<button type="button" class="img-lightbox__close" title="关闭（Esc）" aria-label="关闭">×</button>' +
    '<img class="img-lightbox__img" alt="查看图片">' +
    '<video class="img-lightbox__video" controls playsinline hidden></video>';
  imgEl = box.querySelector('.img-lightbox__img');
  vidEl = box.querySelector('.img-lightbox__video');

  // 点遮罩空白处关闭（点媒体本身不关，避免误触）
  box.addEventListener('click', (e) => {
    if (e.target === box) close();
  });
  box.querySelector('.img-lightbox__close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && box && !box.hidden) { e.preventDefault(); close(); }
  });
  document.body.appendChild(box);
  return box;
}

// 清空当前媒体（图片 src / 视频暂停并释放），供切换图/视频时复用单例
function resetMedia() {
  if (imgEl) { imgEl.hidden = true; imgEl.removeAttribute('src'); }
  if (vidEl) {
    try { vidEl.pause(); } catch { /* 无媒体时忽略 */ }
    vidEl.hidden = true;
    vidEl.removeAttribute('src');
    try { vidEl.load(); } catch { /* 释放资源，失败忽略 */ }
  }
}

function close() {
  if (!box) return;
  box.hidden = true;
  box.classList.remove('is-open');
  resetMedia();
}

export function openImageLightbox(src) {
  if (!src) return;
  const b = ensureBox();
  resetMedia();
  imgEl.hidden = false;
  imgEl.src = src;
  b.hidden = false;
  b.classList.add('is-open');
}

export function openVideoLightbox(src) {
  if (!src) return;
  const b = ensureBox();
  resetMedia();
  vidEl.hidden = false;
  vidEl.src = src;
  b.hidden = false;
  b.classList.add('is-open');
  try { const p = vidEl.play(); if (p && p.catch) p.catch(() => {}); } catch { /* 自动播放被拦则等用户点播放 */ }
}
