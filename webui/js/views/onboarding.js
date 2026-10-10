// A1 前端 · 新用户首启引导（雷影·美工）
// 载体：自定义组件 modal（store.modal = { kind:'component', component: OnboardingWizard, hideHead:true, hideFoot:true, modalClass:'modal--onboarding' }）
// 入口：app.js showOnboarding()（首次自动弹一次，localStorage: leizai.onboarded）+ window.__leizaiShowOnboarding 复用
// 文案：雷影·文案《首启文案稿》A 多步版（去术语）
// 红线：只走前端；第②屏保存复用既有 PUT /api/config（provider=deepseek + apiKeys），不新造端点；Key 只进不出、不回显。
import { defineComponent, ref, onMounted } from 'vue';
import { api } from '../api.js';
import { store, toast } from '../store.js';

const TOTAL = 5;

export const OnboardingWizard = defineComponent({
  name: 'OnboardingWizard',
  setup() {
    const step = ref(0);
    const key = ref('');            // 仅存"本次输入"，保存后立即清空，永不回填
    const connecting = ref(false);
    const connected = ref(false);   // DeepSeek 是否已连接（仅读取"是否存在"，不读明文）
    const connErr = ref('');
    let ds = null;                  // deepseek provider 定义（baseURL / models）

    const pct = () => `${Math.round(((step.value + 1) / TOTAL) * 100)}%`;
    // 副标题（用函数返回，避免模板里写深层嵌套三元——Vue 模板编译器会报错）
    function sub() {
      return [
        '你的 AI 团队，就住在你这台电脑里',
        '上手 3 步 · 第一步：接上模型',
        '上手 3 步 · 第二步：开一个会话',
        '上手 3 步 · 第三步：直接说要什么',
        '一切就绪',
      ][step.value] || '';
    }

    function done(mark) {
      if (mark) { try { localStorage.setItem('leizai.onboarded', '1'); } catch { } }
      store.modal = null;
    }
    function next() { if (step.value < TOTAL - 1) step.value++; }
    function prev() { if (step.value > 0) step.value--; }
    function skip() { done(true); }
    function finish() { done(true); setTimeout(() => { try { if (window.__leizaiNewSession) window.__leizaiNewSession(); } catch { } }, 60); }

    // 只读检测：是否已配 DeepSeek Key（apiKeys 为"掩码/是否存在"语义，绝不回填明文）
    async function detect() {
      try {
        const ps = await api.providers();
        ds = (Array.isArray(ps) ? ps : []).find((p) => p && p.key === 'deepseek') || null;
      } catch { }
      try {
        const cfg = await api.config();
        const ak = cfg && cfg.apiKeys;
        connected.value = !!(ak && ak.deepseek);
      } catch { }
    }
    onMounted(detect);

    // 保存：复用设置页同一接口与字段（对齐 console.js saveProvider 的 patch 形状）
    async function connectKey() {
      const v = String(key.value || '').trim();
      connErr.value = '';
      if (!v || v.includes('*')) { connErr.value = '请输入有效的 API Key'; return; }
      connecting.value = true;
      try {
        const cfg = await api.config();
        const patch = {
          provider: 'deepseek',
          model: (cfg && cfg.model) || (ds && ds.models && ds.models[0]) || '',
          baseURL: (ds && ds.baseURL) || (cfg && cfg.baseURL) || '',
          workdir: (cfg && cfg.workdir) || '',
          pythonPath: (cfg && cfg.pythonPath) || '',
          apiKeys: { deepseek: v },     // 只进不出：仅提交新填 key
        };
        await api.saveConfig(patch);
        key.value = '';                 // 立即清掉明文
        connected.value = true;
        toast('DeepSeek 已连接', 'ok');
        // 让设置页 keyPresence 立即刷新 →「首次配置建议」提示随之隐藏
        try { if (window.__leizaiSettingsReload) window.__leizaiSettingsReload(); } catch { }
      } catch (e) {
        connErr.value = '连接失败：' + ((e && e.message) || e);
      } finally { connecting.value = false; }
    }

    return { step, TOTAL, key, connecting, connected, connErr, pct, sub, next, prev, skip, finish, connectKey, done };
  },
  template: `
  <div class="ob">
    <div class="ob__head">
      <span class="ob__brand"><img class="ob__brand-img" src="/assets/logo.svg" alt="" width="20" height="20" /></span>
      <div>
        <div class="ob__title">欢迎使用雷仔 ⚡</div>
        <div class="ob__sub">{{ sub() }}</div>
      </div>
      <button class="ob__close" @click="done(true)" title="关闭" aria-label="关闭">×</button>
    </div>

    <div class="ob__prog">
      <div class="ob__bar"><i :style="{ width: pct() }"></i></div>
      <div class="ob__dots"><i v-for="n in TOTAL" :key="n" :class="{ on: n === step + 1 }"></i></div>
    </div>

    <div class="ob__body" :key="step">
      <!-- ① 欢迎 -->
      <div v-if="step === 0" class="ob-anim">
        <div class="hero">
          <div class="hero__logo"><img class="hero__logo-img" src="/assets/logo.svg" alt="雷仔" /></div>
          <h2>你好，我是 <em>雷仔</em></h2>
          <p>你的 AI 团队，就住在你这台电脑里。它能写代码、做设计、写文案、跑测试——你只要说清楚要什么。</p>
          <div class="hero__tags"><span class="ob-tag">⚡ 本地运行</span><span class="ob-tag">🔒 数据不外传</span><span class="ob-tag">🧠 记得住</span></div>
        </div>
      </div>

      <!-- ② 第一步：接上模型（可交互：只配 DeepSeek） -->
      <div v-else-if="step === 1" class="ob-anim">
        <div class="stepwrap">
          <div class="stepwrap__num"><b>1</b><span>接上模型</span></div>
          <div class="stepwrap__txt">
            <h3>第一步：接上模型</h3>
            <p>填一次你的 <b>DeepSeek API Key</b>，就接上了。只需一次，以后不用再管。</p>
          </div>
        </div>

        <div class="ob-mock">
          <div class="ob-mock__lbl">模型连接</div>
          <div class="ob-mock__row"><span class="ob-mock__k">提供商</span><span class="ob-mock__v">DeepSeek（官方）</span></div>
        </div>

        <template v-if="connected">
          <div class="ob-conn">
            <span class="ob-conn__ic">✓</span>
            <div><div class="ob-conn__t">已连接 ✓</div><div class="ob-conn__d">DeepSeek 已配置好，可以开始对话了。</div></div>
          </div>
        </template>
        <template v-else>
          <div class="ob-key">
            <input class="input" type="password" autocomplete="new-password" v-model="key"
                   placeholder="粘贴 DeepSeek API Key（sk-…）" @keydown.enter.prevent="connectKey" />
            <button class="btn btn--primary" :disabled="connecting" @click="connectKey">{{ connecting ? '连接中…' : '连接' }}</button>
          </div>
          <div class="ob-key__err" v-if="connErr">{{ connErr }}</div>
          <div class="ob-note">🔒 Key <b>只提交、不回显</b>，仅保存在你自己电脑上。其它服务商请到「设置 → 大模型配置」配置。</div>
        </template>
      </div>

      <!-- ③ 第二步：开一个会话 -->
      <div v-else-if="step === 2" class="ob-anim">
        <div class="stepwrap">
          <div class="stepwrap__num"><b>2</b><span>开会话</span></div>
          <div class="stepwrap__txt">
            <h3>第二步：开一个会话</h3>
            <p>一个会话，就是一个长期项目。给项目起个名，之后聊到什么程度、做到哪一步，都留在这一条里，不用换。</p>
          </div>
        </div>
        <div class="ob-mock">
          <div class="ob-mock__lbl">会话列表</div>
          <div class="ob-mock__row"><span class="ob-mock__v">📁 产品官网</span><span class="ob-ok">刚刚</span></div>
          <div class="ob-mock__row"><span class="ob-mock__v">📁 装修方案</span><span class="ob-mock__k" style="text-align:right">昨天</span></div>
        </div>
      </div>

      <!-- ④ 第三步：直接说要什么 -->
      <div v-else-if="step === 3" class="ob-anim">
        <div class="stepwrap">
          <div class="stepwrap__num"><b>3</b><span>说需求</span></div>
          <div class="stepwrap__txt">
            <h3>第三步：直接说要什么</h3>
            <p>不用背提示词，像交代同事一样说人话就行——它会自己拆活、分给不同的人去做。</p>
          </div>
        </div>
        <div class="ob-mock">
          <div class="ob-mock__lbl">对话</div>
          <div class="ob-mock__row"><span class="ob-mock__v">"帮我做个产品官网，能下载、能下单"</span></div>
          <div class="ob-mock__row"><span class="ob-mock__k">雷仔</span><span class="ob-mock__v">好的，我先拆解需求，再分派给对应的雷影执行 →</span></div>
        </div>
      </div>

      <!-- ⑤ 安心 + 出发 -->
      <div v-else class="ob-anim">
        <div class="ob-ready">
          <div class="ob-ready__ck"><img class="ob-ready__logo" src="/assets/logo.svg" alt="雷仔" /><span class="ob-ready__badge">✓</span></div>
          <h3>它就住在这里，一直记得你</h3>
          <p>你的文件、聊天、成果，全都存在你自己电脑上，上不上传由你说。聊多久它都不会忘事——几个月前的话，也翻得回来。</p>
          <div class="ob-safe"><span>🔒 存在本机</span><span>🙅 不外传</span><span>🕘 不会忘事</span></div>
        </div>
      </div>
    </div>

    <div class="ob__foot">
      <button v-if="step === 0" class="btn btn--ghost" @click="skip">跳过</button>
      <button v-else-if="step === 1" class="btn btn--ghost" @click="next">稍后配置</button>
      <button v-else-if="step === TOTAL - 1" class="btn btn--ghost" @click="done(true)">先随便逛逛</button>
      <button v-else class="btn btn--ghost" @click="prev">← 上一步</button>
      <span class="sp"></span>
      <button v-if="step === TOTAL - 1" class="btn btn--primary" @click="finish">开始第一个会话</button>
      <button v-else class="btn btn--primary" @click="next">下一步 →</button>
    </div>
  </div>
  `,
});
