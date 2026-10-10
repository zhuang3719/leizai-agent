// A1 前端 · 消息气泡（T-C4）——对齐美工契约类名 .bubble/.bubble-ai/.bubble-user/.bubble__meta
import { defineComponent, computed } from 'vue';
import { renderMarkdown, renderUserContent } from '../markdown.js';
import { openImageLightbox } from '../image-lightbox.js';
import { store } from '../store.js';

export function textOf(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && p.type === 'text' ? p.text : (p && p.type === 'image_url' ? '[图片]' : ''))).join('');
  return String(c == null ? '' : c);
}

// v6.23：只取文本段（数组 content 中 type==='text'）——用户气泡用它，
// 避免 image_url 被 textOf 渲染成 [图片] 文本、与 img 元素重复
export const TIME_LINE_RE = /\n*【当前时间】\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 周[日一二三四五六]\s*$/;   // v3.2（2026-10-06）：引擎注入的尾部【当前时间】行（严格匹配时间戳格式，防误伤正文）
// v3.2（2026-10-06）：剥离**尾部**「【当前时间】…」行——仅展示层隐藏，不改存储/模型上下文；仅在行尾匹配，不误伤正文。
export function stripInjectedTime(t) {
  const s = String(t == null ? '' : t);
  try { return s.replace(TIME_LINE_RE, ''); } catch { return s; }
}
export function textOnly(m) {
  if (!m) return '';
  const c = m.content;
  let t;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) t = c.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
  else t = String(c == null ? '' : c);
  return stripInjectedTime(t);
}

// —— Pro 升级引导（雷影·美工）：识别后端 gate 的「Lite/Pro 限额」纯文本，用于内联升级按钮 ——
//   匹配示例：「…属 Pro 能力（当前 lite 档｜reason）」「Lite 档技能上限 20 条（当前 20），升级 Pro 后不限」
const PRO_LIMIT_RE = /属 ?Pro ?能力|升级 ?Pro ?后(?:可用|不限)|Lite ?档[^。]{0,24}上限/;
export function isProLimitText(t) { try { return PRO_LIMIT_RE.test(String(t || '')); } catch { return false; } }

export const Bubble = defineComponent({
  name: 'Bubble',
  props: { msg: { type: Object, required: true } },
  setup(props) {
    const isUser = computed(() => (props.msg.role || 'assistant') === 'user');
    const isDivider = computed(() => !!props.msg._divider);
    const isCompaction = computed(() => !!props.msg._compaction);
    const streaming = computed(() => !!props.msg._streaming);
    const isEngine = computed(() => !!props.msg.engine || !!(props.msg && props.msg._inbound));   // 引擎/系统消息（伪 user）→ 系统样式，勿冒充用户；refs=sys-marker 双保险：engine 标记 ∨ 入站锚点 _inbound
    const html = computed(() => (isUser.value ? '' : renderMarkdown(textOf(props.msg))));
    const userHtml = computed(() => (isUser.value ? renderUserContent(textOnly(props.msg)) : ''));
    const meta = computed(() => (isEngine.value ? '系统' : (isUser.value ? '主人' : '雷仔 · 主我')));   // v6.45：去掉 emoji 闪电符号，改由模板插 logo 图形
    // v6.23：从 content 数组提取图片（image_url）——文本走文本、图片走 img 元素
    const images = computed(() => {
      const c = props.msg && props.msg.content;
      if (!Array.isArray(c)) return [];
      return c.filter((p) => p && p.type === 'image_url' && p.image_url && p.image_url.url)
        .map((p) => p.image_url.url);
    });
    function open(u) { openImageLightbox(u); }
    // Pro 升级引导：非用户消息若命中限额文案 → 内联升级按钮
    const proLimit = computed(() => {
      if (isUser.value) return false;
      const tier = (store.pro && store.pro.effective && store.pro.effective.tier) || 'lite';
      if (tier !== 'lite') return false;   // dev/pro/激活态一律不显（口径同触点②core.js，同源读 store.pro）
      return isProLimitText(textOf(props.msg));
    });
    const proExpired = computed(() => /过期|expired/i.test(textOf(props.msg)));
    function openPro() { if (window.__leizaiOpenPro) window.__leizaiOpenPro(); }
    return { isUser, isDivider, isCompaction, streaming, html, userHtml, meta, images, open, isEngine, proLimit, proExpired, openPro };
  },
  template: `
    <div v-if="isDivider" class="gen-divider" :data-gen="msg._gen || ''"><img class="gen-divider__logo" src="./assets/logo.svg" alt="" aria-hidden="true">{{ msg.content }}</div>
    <div v-else :class="['bubble', (isUser && !isEngine) ? 'bubble-user' : 'bubble-ai', { 'bubble--streaming': streaming, 'bubble--engine': isEngine }]"
         :data-role="isEngine ? 'engine' : (isUser ? 'user' : 'main')">
      <div class="bubble__meta"><img v-if="!isUser && !isEngine" class="bubble__logo" src="./assets/logo.svg" alt="" aria-hidden="true">{{ meta }}<span v-if="isCompaction" class="chip chip--acc" style="margin-left:6px;">交接文档</span><span v-if="isEngine" class="chip" style="margin-left:6px;">引擎</span></div>
      <div v-if="isUser && userHtml" class="md" v-html="userHtml"></div>
      <div v-if="images.length" class="bubble__imgs">
        <img v-for="(u, i) in images" :key="i" class="bubble__img" :src="u" alt="图片" draggable="false" @click="open(u)">
      </div>
      <div v-if="!isUser" class="md" v-html="html"></div>
      <div v-if="proLimit" class="pro-cta-row">
        <button type="button" class="pro-cta" @click="openPro"><span class="pro-cta__i" aria-hidden="true">⚡</span>{{ proExpired ? '续费 Pro' : '升级并激活 Pro' }}</button>
        <button type="button" class="pro-cta-ghost" @click="openPro">了解更多</button>
      </div>
    </div>
  `,
});
