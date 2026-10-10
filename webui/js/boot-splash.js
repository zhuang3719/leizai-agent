// boot-splash.js — 启动遮罩控制（雷影·美工 v6.39；v6.50 双门控；v6.51 长冷启动适配 · 雷影·程序员）
// window.__bootReady()：引擎 /api/health ok==true 且最短展示 ~700ms 后淡出。
//   v6.51：health 门控上限 8s→30s（30s 未就绪 → 显示「引擎启动中…」并继续等），总上限 90s；
//          并新增"网页已绘制"信号（bridge op splashPainted）→ 外壳据此撤原生遮罩（像素连续交接）。
//   CSS 6s 兜底经 animationDelay 延后，防早于门控。
(function () {
  'use strict';
  var MIN_SHOW = 700;         // 最短展示（防一闪而过）
  var HEALTH_POLL = 300;      // health 轮询间隔
  var HINT_AT = 30000;        // v6.51：30s 仍未就绪 → 显示「引擎启动中…」（继续等）
  var HARD_TIMEOUT = 90000;   // v6.51：90s 总上限（仍未 ok 才强制放行）
  var t0 = 0;
  var done = false;
  var splash = null;
  var hintShown = false;

  function hide() {
    if (done) return;
    done = true;
    if (!splash) splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.classList.add('boot-splash--done');
    splash.setAttribute('aria-hidden', 'true');
    window.setTimeout(function () {
      var el = document.getElementById('boot-splash');
      if (el && el.parentNode) el.parentNode.removeChild(el);
      splash = null;
    }, 420);   // 与 CSS transition(.35s) 对齐
  }

  function waitMinShow() {
    var wait = Math.max(0, MIN_SHOW - (Date.now() - t0));
    window.setTimeout(hide, wait);
  }

  function setEngineHint() {
    try {
      var el = document.querySelector('#boot-splash .boot-splash__title');
      if (el) el.textContent = '引擎启动中…';
    } catch (e) { }
  }

  function healthOk() {
    return fetch('/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!(j && j.ok === true); })
      .catch(function () { return false; });
  }

  // v6.51①：网页 splash 已绘制 → 通知外壳撤原生遮罩
  function notifyHostPainted() {
    try {
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(JSON.stringify({ op: 'splashPainted', id: 0 }));
      }
    } catch (e) { }
  }

  // 双门控：health ok && 最短展示；300ms 轮询；30s 显示提示、90s 上限强制放行
  function gateThenHide() {
    (function poll() {
      if (done) return;
      healthOk().then(function (ok) {
        if (done) return;
        if (ok) { waitMinShow(); return; }
        if (!hintShown && (Date.now() - t0) >= HINT_AT) { hintShown = true; setEngineHint(); }
        if ((Date.now() - t0) >= HARD_TIMEOUT) { setEngineHint(); waitMinShow(); return; }
        window.setTimeout(poll, HEALTH_POLL);
      });
    })();
  }

  function init() {
    splash = document.getElementById('boot-splash');
    if (!splash) return;
    t0 = Date.now();
    try { splash.style.animationDelay = '95s'; } catch (e) { }   // 防 CSS 6s 兜底早于 90s 门控
    window.setTimeout(hide, HARD_TIMEOUT);                       // JS 侧硬兜底
    if (window.requestAnimationFrame) window.requestAnimationFrame(function () { window.requestAnimationFrame(notifyHostPainted); });
    else notifyHostPainted();
  }

  window.__bootReady = function () {
    if (done) return;
    if (!splash) splash = document.getElementById('boot-splash');
    if (!splash) { done = true; return; }
    gateThenHide();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
