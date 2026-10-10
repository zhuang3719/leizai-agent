// boot-video.js — 开机视频片头（两段式 · v6.53 · 雷影·程序员）
// 目标：启动时在网页层播放全屏静音视频，**一次片头(intro) → 无缝转无限循环(loop) → 引擎就绪才收**；
//       播放时立即撤掉 CSS 遮罩(#boot-splash)，避免"原生遮罩→CSS 遮罩→视频"三段画面。
// 一切失败**静默降级**（绝不阻塞主流程：直接撤 overlay 进界面；CSS 遮罩已移除，无回退可显示）。
// 播放逻辑：先播 intro（loop=false）；onEnded 时——/api/health ok → 关闭；否则切到 loop（loop=true，从 0 起播）
//   持续循环，直到 health ok → 关闭（loop 素材末帧=首帧，无跳变）。提供「跳过」。
// 看门狗：intro 阶段保留 25s；总上限 90s（loop 永不 ended，不因"视频未结束"误杀，超时才强制放行）。
// 配置键：bootVideoEnabled / bootVideoPathIntro / bootVideoPathLoop（兼容旧 bootVideoPath 作 intro）
//        / bootVideoPolicy / bootVideoFit（缺省时用下方 DEF）。
(function () {
  'use strict';
  var DEF = {
    enabled: true,
    introPath: '/assets/boot_intro.mp4',
    loopPath: '/assets/boot_loop.mp4',
    policy: 'session',
    fit: 'cover'
  };
  var INTRO_TIMEOUT_MS = 25000;   // intro 阶段看门狗（保留原 25s）
  var TOTAL_TIMEOUT_MS = 90000;   // 总上限：loop 阶段不因"视频未结束"误杀，超时才强制放行
  var HEALTH_POLL_MS = 500;
  var CFG_TIMEOUT_MS = 3000;
  var LS_KEY = 'leizai.bootVideo.played';
  var SS_KEY = 'leizai.bootVideo.played.session';

  var overlay = null, video = null, done = false, shellMounted = false, playing = false;
  var healthOk = false, policy = DEF.policy, phase = 'intro', introSettled = false, splashHidden = false;
  var introTimer = null, totalTimer = null, healthTimer = null, cfgRef = null;

  function log() { try { console.log.apply(console, ['[bootVideo]'].concat(Array.prototype.slice.call(arguments))); } catch (e) { } }
  function lsHas(k) { try { return !!window.localStorage.getItem(k); } catch (e) { return false; } }
  function ssHas(k) { try { return !!window.sessionStorage.getItem(k); } catch (e) { return false; } }
  function markPlayed() {
    try {
      if (policy === 'once') window.localStorage.setItem(LS_KEY, String(Date.now()));
      else if (policy === 'session') window.sessionStorage.setItem(SS_KEY, String(Date.now()));
    } catch (e) { }
  }
  function alreadyPlayed() {
    try {
      if (policy === 'always') return false;
      if (policy === 'once') return lsHas(LS_KEY);
      return ssHas(SS_KEY);
    } catch (e) { return false; }
  }
  function pick(j) {
    if (!j || typeof j !== 'object') return DEF;
    return {
      enabled: j.bootVideoEnabled !== false,
      // 兼容旧 bootVideoPath 作为 intro；显式 bootVideoPathIntro 优先
      introPath: String(j.bootVideoPathIntro || j.bootVideoPath || DEF.introPath),
      loopPath: String(j.bootVideoPathLoop || DEF.loopPath),
      policy: String(j.bootVideoPolicy || DEF.policy),
      fit: String(j.bootVideoFit || DEF.fit)
    };
  }
  function healthCheck() {
    return fetch('/api/health', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!(j && j.ok === true); }).catch(function () { return false; });
  }
  function fetchCfg() {
    return new Promise(function (resolve) {
      var settled = false;
      var t = setTimeout(function () { if (!settled) { settled = true; resolve(DEF); } }, CFG_TIMEOUT_MS);
      try {
        fetch('/api/config', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { if (!settled) { settled = true; clearTimeout(t); resolve(pick(j)); } })
          .catch(function () { if (!settled) { settled = true; clearTimeout(t); resolve(DEF); } });
      } catch (e) { if (!settled) { settled = true; clearTimeout(t); resolve(DEF); } }
    });
  }

  /** 决定播放时立即撤掉 CSS 遮罩（#boot-splash），避免叠出"原生→CSS→视频"三段画面。 */
  function hideSplash() {
    if (splashHidden) return;
    splashHidden = true;
    try {
      var s = document.getElementById('boot-splash');
      if (!s) return;
      s.classList.add('boot-splash--done');
      s.setAttribute('aria-hidden', 'true');
      window.setTimeout(function () {
        var el = document.getElementById('boot-splash');
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 420);   // 与 boot-splash.css 的 .35s transition 对齐
    } catch (e) { }
  }

  /** v6.53：播放时 200ms 淡入 overlay，减弱"原生海报 → intro 起头黑帧"的硬切。 */
  function revealOverlay() {
    try {
      if (!overlay) return;
      if (window.requestAnimationFrame) window.requestAnimationFrame(function () { if (overlay) overlay.style.opacity = '1'; });
      else overlay.style.opacity = '1';
    } catch (e) { }
  }

  function close(reason, playedOk) {
    if (done) return;
    done = true;
    try { if (introTimer) { clearTimeout(introTimer); introTimer = null; } } catch (e) { }
    try { if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; } } catch (e) { }
    try { if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; } } catch (e) { }
    log('close:', reason, playedOk ? '(played)' : '', 'phase=' + phase);
    if (playedOk) markPlayed();
    try {
      if (overlay) {
        var o = overlay;
        o.style.transition = 'opacity .35s ease';
        o.style.opacity = '0';
        window.setTimeout(function () { try { if (o.parentNode) o.parentNode.removeChild(o); } catch (e) { } }, 380);
        overlay = null; video = null;
      }
    } catch (e) { }
  }

  // 引擎就绪轮询：health ok 后——intro 阶段只记录（等 onEnded 判定）；loop 阶段立即关闭
  function startHealthPoll() {
    if (healthTimer || done || healthOk) return;
    (function tick() {
      if (done || healthOk) return;
      healthCheck().then(function (ok) {
        if (done || healthOk) return;
        if (ok) {
          healthOk = true;
          log('engine ready (health ok) phase=' + phase);
          if (phase === 'loop') close('loop+engine-ready', true);
          return;
        }
        healthTimer = window.setTimeout(tick, HEALTH_POLL_MS);
      });
    })();
  }

  // intro 结束/超时 → 引擎已就绪则关闭，否则无缝切到 loop 无限循环
  function switchToLoop() {
    if (done || !video || !cfgRef) return;
    phase = 'loop';
    log('switch to loop', cfgRef.loopPath);
    try {
      video.loop = true;
      video.src = cfgRef.loopPath;   // 切到可循环素材（末帧=首帧 → 无跳变）
      try { video.currentTime = 0; } catch (e) { }
      var p = null;
      try { p = video.play(); } catch (e) { log('loop play throw', e); }
      if (p && p.catch) p.catch(function (e) { log('loop autoplay rejected -> 静默降级', e && e.name); close('loop-autoplay-rejected', false); });
    } catch (e) { log('switchToLoop failed -> 静默降级', e); close('loop-error', false); }
    startHealthPoll();
  }

  function onIntroSettle(reason) {
    if (done || introSettled) return;
    introSettled = true;
    try { if (introTimer) { clearTimeout(introTimer); introTimer = null; } } catch (e) { }
    log('intro settled (' + reason + ') healthOk=' + healthOk);
    if (healthOk) { close('intro+engine-ready', true); return; }
    switchToLoop();
  }

  /** 提前建 overlay（黑底，先于 fetchCfg），避免等配置才挂载造成画面空窗/三段切换。 */
  function mountShell() {
    if (done || shellMounted) return;
    shellMounted = true;
    try {
      overlay = document.createElement('div');
      overlay.id = 'boot-video';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#050507;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s ease;';   // v6.53：初始透明→播放时 200ms 淡入
      video = document.createElement('video');
      video.muted = true; video.defaultMuted = true; video.autoplay = true;
      video.playsInline = true; video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
      video.preload = 'auto';
      video.loop = false;
      video.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      video.addEventListener('ended', function () { log('intro onEnded'); onIntroSettle('ended'); });
      video.addEventListener('error', function () { log('video error -> 静默降级'); close('video-error', false); });
      var skip = document.createElement('button');
      skip.type = 'button';
      skip.textContent = '跳过 ▶';
      skip.style.cssText = 'position:absolute;right:24px;bottom:24px;z-index:2;padding:8px 16px;border:1px solid rgba(0,229,255,.5);border-radius:6px;background:rgba(5,5,7,.6);color:#8A93A3;font:13px/1.4 "Microsoft YaHei UI",sans-serif;cursor:pointer;';
      skip.addEventListener('click', function () { log('skip'); close('skip', true); });
      overlay.appendChild(video);
      overlay.appendChild(skip);
      document.body.appendChild(overlay);
    } catch (e) { log('mountShell failed', e); close('mount-error', false); }
  }

  /** 配置确认可播 → 撤 CSS 遮罩 + 起播 intro。 */
  function playIntro(cfg) {
    if (done || playing || !video) return;
    playing = true;
    cfgRef = cfg;
    try {
      video.loop = false;
      video.style.objectFit = (cfg.fit === 'contain' ? 'contain' : 'cover');
      video.src = cfg.introPath;   // 先播 intro
      log('play intro', cfg.introPath, 'fit=' + cfg.fit);
      var p = null;
      try { p = video.play(); } catch (e) { log('play throw', e); }
      if (p && p.catch) p.catch(function (e) { log('autoplay rejected -> 静默降级', e && e.name); close('autoplay-rejected', false); });
      revealOverlay();
      introTimer = window.setTimeout(function () { onIntroSettle('intro-watchdog'); }, INTRO_TIMEOUT_MS);
      totalTimer = window.setTimeout(function () { close('total-watchdog', false); }, TOTAL_TIMEOUT_MS);
      startHealthPoll();
    } catch (e) { log('playIntro failed', e); close('play-error', false); }
  }

  function start() {
    try {
      mountShell();   // 提前挂载（黑底覆盖 CSS 遮罩）
      fetchCfg().then(function (cfg) {
        policy = cfg.policy;
        if (!cfg.enabled) { log('disabled by config'); close('disabled-by-config', false); return; }
        if (alreadyPlayed()) { log('already played (policy=' + policy + ')'); close('already-played', false); return; }
        hideSplash();   // 决定播放 → 立即撤 CSS 遮罩
        playIntro(cfg);
      }).catch(function (e) { log('start failed (silent)', e); close('start-error', false); });
    } catch (e) { log('init failed (silent)', e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
