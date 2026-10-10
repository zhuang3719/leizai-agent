// A1 前端 · 覆盖层（挂载 #toast-host / #modal-host / #tooltip）——多根渲染 + 操作 host 类
import { defineComponent, computed, ref, watch } from 'vue';
import { store } from '../store.js';
import { renderMarkdown } from '../markdown.js';

export const ToastHost = defineComponent({
  name: 'ToastHost',
  setup() {
    const list = ref([]);
    watch(() => store.toast, (t) => {
      if (!t) return;
      const item = Object.assign({}, t, { _id: Math.random() });
      list.value.push(item);
      setTimeout(() => { list.value = list.value.filter((x) => x._id !== item._id); }, 3200);
    });
    return { list };
  },
  template: `
    <div v-for="t in list" :key="t._id" :class="['toast', t.kind === 'ok' ? 'toast--ok' : t.kind === 'err' ? 'toast--err' : '']">{{ t.msg }}</div>
  `,
});

export const ModalHost = defineComponent({
  name: 'ModalHost',
  setup() {
    const m = computed(() => store.modal);
    const val = ref('');
    function host() { return document.getElementById('modal-host'); }
    watch(m, (v) => {
      const h = host(); if (h) { h.classList.toggle('is-open', !!v); h.classList.toggle('modal-mask--over', !!(v && v.elevated)); }
      if (v && v.kind === 'prompt') {
        val.value = (v.input && v.input.value) || '';
        setTimeout(() => { const el = document.getElementById('modal-input'); if (el) { el.focus(); try { el.select(); } catch { } } }, 0);
      }
    }, { immediate: true });
    function ok() { const mm = m.value; store.modal = null; if (mm && typeof mm.onOk === 'function') mm.onOk(val.value); }
    function cancel() { const mm = m.value; store.modal = null; if (mm && typeof mm.onCancel === 'function') mm.onCancel(); }
    function infoOk() { const mm = m.value; store.modal = null; if (mm && typeof mm.onOk === 'function') mm.onOk(); }
    function closeModal() { store.modal = null; }
    if (typeof document !== 'undefined') {
      // 遮罩点击 + ESC 关闭（补足"至少两种关闭方式"；点击遮罩自身而非面板内才关）
      document.addEventListener('click', (e) => { const h = host(); if (h && e.target === h && store.modal) closeModal(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && store.modal) closeModal(); });
    }
    const html = computed(() => (m.value && m.value.html ? renderMarkdown(m.value.html) : ''));
    // v6.46：prompt 弹窗「富态」增强——可选 icon/desc/hint；不传则完全保持原样（向后兼容，其它 prompt 弹窗也受益）
    const rich = computed(() => { const v = m.value; return !!(v && (v.icon || v.desc || v.hint)); });
    function icBolt(v) { return v === 'bolt' || v === '⚡'; }
    return { m, close, html, val, ok, cancel, infoOk, rich, icBolt };
  },
  template: `
    <div class="modal" v-if="m" :class="[m.size ? ('modal--' + m.size) : '', { 'modal--wide': m.wide, 'modal--rich': rich }, m.modalClass]">
      <div class="modal__head" v-if="!m.hideHead && rich">
        <span class="modal__ic"><i v-if="icBolt(m.icon)"></i><b v-else>{{ m.icon }}</b></span>
        <span class="modal__title"><span v-if="m.badge" class="modal__badge">{{ m.badge }}</span>{{ m.title }}</span>
        <button type="button" class="modal__x" title="关闭" aria-label="关闭" @click="cancel">×</button>
      </div>
      <div class="card__head" v-else-if="!m.hideHead"><span class="card__title"><span v-if="m.badge" class="modal__badge">{{ m.badge }}</span>{{ m.title }}</span></div>
      <div class="modal__body" :class="{ 'modal__body--scroll': m.scroll }">
        <template v-if="m.kind==='prompt'">
          <p v-if="rich && m.desc" class="modal__desc">{{ m.desc }}</p>
          <div class="modal-field">
            <span class="modal-field__i"><i></i></span>
            <input id="modal-input" class="input modal__input" v-model="val"
                 :placeholder="(m.input && m.input.placeholder) || ''"
                   @keydown.enter.prevent="ok" @keydown.esc.prevent="cancel" />
          </div>
          <p v-if="rich && m.hint" class="modal__hint">{{ m.hint }}</p>
        </template>
        <template v-else-if="m.kind==='component'">
          <div class="pane-tree"><component :is="m.component" v-if="m.component"></component></div>
        </template>
        <div v-else class="md" v-html="html"></div>
      </div>
      <div class="modal__foot" v-if="!m.hideFoot">
        <template v-if="m.kind==='prompt'">
          <button class="btn" @click="cancel">取消</button>
          <button class="btn btn--primary" @click="ok">{{ m.okText || '确认' }}</button>
        </template>
        <template v-else>
          <button class="btn" @click="infoOk">{{ m.okText || '关闭' }}</button>
        </template>
      </div>
    </div>
  `,
});

export const TooltipHost = defineComponent({
  name: 'TooltipHost',
  setup() {
    const text = ref('');
    let _cur = null;                                       // v6.43：当前显示中的元素（hide 时用于还原 title）
    function host() { return document.getElementById('tooltip'); }
    function hide() {
      const h = host(); if (h) h.classList.remove('is-open');
      // v6.43：还原被临时挪走的 title（抑制原生 title 气泡），保留无障碍/原生提示
      if (_cur && _cur.dataset && _cur.dataset.tipRestore) {
        if (_cur.hasAttribute('data-tip')) { _cur.setAttribute('title', _cur.getAttribute('data-tip')); _cur.removeAttribute('data-tip'); }
        delete _cur.dataset.tipRestore;
      }
      _cur = null;
    }
    function show(el) {
      const h = host(); if (!h) return;
      const tip = el.getAttribute('data-tip') || el.getAttribute('title') || '';
      if (!tip) { hide(); return; }
      // v6.43：仅有原生 title 的元素，临时移到 data-tip 并移除 title（对齐 topbar.js 约定：自定义气泡为准，避免双提示）
      if (!el.getAttribute('data-tip') && el.hasAttribute('title')) {
        el.setAttribute('data-tip', el.getAttribute('title'));
        el.removeAttribute('title');
        el.dataset.tipRestore = '1';
      }
      _cur = el;
      text.value = tip;
      const r = el.getBoundingClientRect();
      h.style.left = r.left + 'px'; h.style.top = (r.bottom + 6) + 'px';
      h.classList.add('is-open');
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('mouseover', (e) => { const t = e.target.closest('[title],[data-tip]'); if (t) show(t); });
      document.addEventListener('mouseout', (e) => {
        const from = e.target.closest('[title],[data-tip]'); if (!from) return;
        // v6.43：仅在真正离开该元素时隐藏（子元素间移动不隐藏），避免气泡忽隐忽现
        const to = (e.relatedTarget && e.relatedTarget.closest) ? e.relatedTarget.closest('[title],[data-tip]') : null;
        if (to === from) return;
        hide();
      });
    }
    return { text };
  },
  // v6.43：根元素原为 <template>——HTML 惰性元素 display:none，文字被吞 → "空气泡"；改普通 span 才真实渲染
  template: `<span class="tooltip__text">{{ text }}</span>`,
});
