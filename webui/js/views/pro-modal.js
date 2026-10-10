// A1 前端 · Pro 激活 / 续费弹窗（雷影·美工 · 2026-10-02）
// 触发：window.__leizaiOpenPro()（气泡/工具卡内联按钮、顶栏徽章、composer 限额条）
// 硬红线：fail-safe —— 接口异常/超时/脏数据只以 toast/内联文案呈现，绝不 throw、不阻断聊天，弹窗可关。
import { defineComponent, ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { store, toast } from '../store.js';

const BUY_URL = 'https://leizai.cc/pricing.html';
const TIMEOUT_MS = 6000;

// 超时包装：不管底层 promise 结果如何，超时即以 reject 结束（fail-safe，不悬挂）
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
function fmtDate(exp) {
  const e = Number(exp) || 0;
  if (!e) return '';
  try {
    const d = new Date(e);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  } catch { return ''; }
}

export const ProUpsellModal = defineComponent({
  name: 'ProUpsellModal',
  setup() {
    const st = ref(null);          // /api/pro/status 结果（activated/tier/reason/exp…）
    const failed = ref(false);     // 状态获取失败 → 视作「未知态」
    const loaded = ref(false);
    const key = ref('');
    const activating = ref(false);
    const activeErr = ref('');

    const expired = computed(() => !!(st.value && st.value.reason === 'token-expired'));
    const activated = computed(() => !!(st.value && st.value.activated === true));
    const expText = computed(() => fmtDate(st.value && st.value.exp));

    async function load() {
      failed.value = false;
      try {
        const r = await withTimeout(api.get('/api/pro/status'), TIMEOUT_MS);
        st.value = (r && typeof r === 'object') ? r : { tier: 'lite' };
      } catch (e) {
        failed.value = true; st.value = null;   // 不 rethrow
      } finally { loaded.value = true; }
    }
    onMounted(load);

    async function doActivate() {
      const k = String(key.value || '').trim();
      if (!k) { toast('请输入激活码', 'err'); return; }
      if (activating.value) return;
      activating.value = true; activeErr.value = '';
      try {
        const r = await withTimeout(api.post('/api/pro/activate', { licenseKey: k }), TIMEOUT_MS);
        if (r && r.ok) {
          toast('激活成功 · 档位 ' + (r.tier || 'pro'), 'ok');
          key.value = '';
          await load();
        } else {
          const m = (r && r.error) || '激活失败';
          activeErr.value = m; toast('激活失败：' + m, 'err');
        }
      } catch (e) {
        const m = (e && e.message === 'timeout') ? '激活超时，请重试' : '激活失败，请检查网络后重试';
        activeErr.value = m; toast(m, 'err');
      } finally { activating.value = false; }
    }
    function buy() {
      try { window.open(BUY_URL, '_blank', 'noopener'); }
      catch { try { window.open(BUY_URL, '_blank'); } catch { toast('无法打开购买页，请访问 ' + BUY_URL, 'info'); } }
    }
    function close() { store.modal = null; }

    return { st, failed, loaded, key, activating, activeErr, expired, activated, expText, doActivate, buy, close };
  },
  template: `
    <div class="pro-modal">
      <div class="pmod__hero">
        <div :class="['pmod__glyph', { 'is-exp': expired }]">{{ expired ? '⏳' : '⚡' }}</div>
        <div>
          <div class="pmod__ht">{{ expired ? 'Pro 已过期' : (activated ? 'Pro 已激活' : '解锁 Pro 全部能力') }}</div>
          <div class="pmod__hd">{{ expired ? '续费后立即恢复全部能力' : (activated ? '感谢支持 · 完整体验已开启' : '一次激活，畅享完整体验') }}</div>
        </div>
      </div>

      <div v-if="activated" class="pmod__ok"><span>✓</span>当前 Pro 有效<span v-if="expText"> · 到期 {{ expText }}</span></div>
      <div v-else-if="expired" class="pmod__exp"><span>⚠</span>你的 Pro 已于 <b>{{ expText || '—' }}</b> 到期，自我进化 / 无限记忆已停用。</div>
      <div v-else-if="failed" class="pmod__exp pmod__exp--soft"><span>⚠</span>未能获取 Pro 状态（不影响使用），可尝试直接激活。</div>

      <div v-if="!activated" class="pmod__feats">
        <div class="pmod__feats-title">解锁 Pro 全部能力</div>
        <div class="pmod__benefit"><span class="pmod__benefit-ico">🌱</span><div class="pmod__benefit-tx"><b>自我进化</b><span>自动反思，沉淀记忆与技能</span></div></div>
        <div class="pmod__benefit"><span class="pmod__benefit-ico">🧠</span><div class="pmod__benefit-tx"><b>无限记忆 / 技能</b><span>不再受条数上限</span></div></div>
        <div class="pmod__benefit"><span class="pmod__benefit-ico">🧩</span><div class="pmod__benefit-tx"><b>多雷影协同</b><span>创建独立智能体分身</span></div></div>
        <div class="pmod__benefit"><span class="pmod__benefit-ico">🤖</span><div class="pmod__benefit-tx"><b>子智能体 · 定时心跳</b><span>自治目标与长任务</span></div></div>
        <div class="pmod__benefit"><span class="pmod__benefit-ico">🔓</span><div class="pmod__benefit-tx"><b>Pro 专属模型 &amp; 更高配额</b></div></div>
        <div class="pmod__feats-sub">激活后立即生效 · 续费沿用老用户价</div>
      </div>

      <div class="pmod__sec">
        <div class="pmod__sech"><span class="n">1</span>{{ expired ? '添加激活码（续费码 / 新激活码）' : '添加激活码' }}</div>
        <div class="pmod__row">
          <input class="pmod__input" v-model="key" placeholder="XXXX-XXXX-XXXX-XXXX"
                 autocomplete="off" spellcheck="false" @keydown.enter.prevent="doActivate" />
          <button class="pmod__btn" :disabled="activating" @click="doActivate">
            {{ activating ? '激活中…' : (expired ? '重新激活' : '激活') }}
          </button>
        </div>
        <div v-if="activeErr" class="pmod__hint is-err">{{ activeErr }}</div>
        <div v-else-if="failed" class="pmod__hint">状态获取失败，可尝试直接激活。</div>
        <div v-else class="pmod__hint">收到激活码？粘贴到上方即可解锁。</div>
      </div>

      <div class="pmod__sec">
        <div class="pmod__sech"><span class="n">2</span>{{ expired ? '购买 / 续费' : '购买激活码' }}</div>
        <div class="pmod__buy">
          <span class="pmod__price">{{ expired ? '续费享老用户价' : '前往官网选购 Pro 授权' }}</span>
          <button class="pmod__btn pmod__btn--buy" @click="buy">{{ expired ? '前往续费 →' : '购买激活码 →' }}</button>
        </div>
      </div>

      <div class="modal__foot"><button class="btn" @click="close">关闭</button></div>
    </div>
  `,
});
