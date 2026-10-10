// A1 前端 · 本代交接文档卡（T-C5②，O-4）——对齐美工契约 .handoff-card__*
// 数据源：会话第 1 条 _compaction:true 消息（[上下文摘要] ...）。可折叠展开。
import { defineComponent, ref, computed } from 'vue';
import { renderMarkdown } from '../markdown.js';

// 将交接文档拆成小节（原始目标 / 项目骨架 / 本代未完成 / 本代增量 / 归档索引）
function splitSections(text) {
  if (!text) return [];
  const clean = String(text).replace(/^\s*\[上下文摘要\]\s*/, '');
  const lines = clean.split('\n');
  const secs = [];
  let cur = { title: '', body: [] };
  const isHead = (l) => /^\s*(#{1,4}\s*)?(\*\*)?\s*(原始目标|项目骨架|本代未完成|本代增量|归档索引|待办|未完成|关键决定|规则)/.test(l);
  for (const l of lines) {
    if (isHead(l)) {
      if (cur.title || cur.body.length) secs.push(cur);
      cur = { title: l.replace(/^[#\s*]+|[#\s*：:]+$/g, '').trim(), body: [] };
    } else cur.body.push(l);
  }
  if (cur.title || cur.body.length) secs.push(cur);
  if (!secs.length) secs.push({ title: '', body: lines });
  return secs.map((s) => ({ title: s.title, body: s.body.join('\n').trim() }));
}

export const HandoffCard = defineComponent({
  name: 'HandoffCard',
  props: { text: { type: String, default: '' }, gen: { type: [Number, String], default: '' } },
  setup(props) {
    const open = ref(true);
    const secs = computed(() => splitSections(props.text));
    return { open, secs, renderMarkdown };
  },
  template: `
    <div :class="['handoff-card', { 'is-open': open }]" data-kind="handoff">
      <div class="handoff-card__head" @click="open = !open">
        <span class="icon icon--sm" style="--i:url(/assets/ui-archive.svg)"></span>
        📋 本代交接文档<span v-if="gen"> · 第 {{ gen }} 代</span>
        <span class="dim" style="font-weight:400;font-size:12px;margin-left:auto;">自动交接 · 系统继续工作</span>
      </div>
      <div v-if="open" class="handoff-card__body">
        <div v-for="(s, i) in secs" :key="i" class="handoff-card__sec">
          <h4 v-if="s.title">{{ s.title }}</h4>
          <div class="dim md" v-html="renderMarkdown(s.body || '（无）')"></div>
        </div>
      </div>
    </div>
  `,
});
