// LeiZai2 · 主窗口：WebView2 宿主 + 托盘 + 后端拉起（T-B1/T-B2）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LeiZai2 {
    public class MainForm : Form {
        WebView2 _web;
        Panel _titleBar;
        Label _title;
        FlatBtn _bmin, _bmax, _bclose;
        NotifyIcon _tray;
        Bridge _bridge;
        Process _nodeProc;
        bool _startedBackend;
        bool _ready;
        volatile bool _backendOk;      // v6.51：后端健康（WV2 导航门控）
        volatile bool _wv2Ready;       // v6.51：WV2 环境就绪
        volatile bool _navigated;      // v6.51：已导航（防重复）
        FlatBtn _breload;
        FileSystemWatcher _watcher;
        System.Windows.Forms.Timer _hotTimer;
        readonly object _hotLock = new object();
        bool _hotPending;
        bool _hotDeferred;   // v6.12：本轮待重载曾因"忙"被延后过（决定是否走错峰静默窗口）
        bool _hotSettling;   // v6.12：正处于"转空闲后的错峰静默窗口"
        System.Windows.Forms.Timer _hotSettleTimer;   // v6.12：错峰静默计时器（2.5s）
        Panel _splash;                                // v6.50①：原生首帧遮罩
        System.Windows.Forms.Timer _splashTimer;      // v6.50①：首帧兜底计时
        string _splashHint;                           // v6.50③：null=品牌底；非空=失败提示
        string _splashSub;
        Image _boltImg;                              // v6.50①：预渲 ⚡ PNG
        Image _posterImg;                            // v6.53：原生遮罩品牌海报（loop 首帧，替代自绘 ⚡）
        bool _posterTried;
        bool _boltTried;
        // ---- v6.55：外壳本地 splash 层（file://，零引擎依赖）----
        WebView2 _webSplash;                          // 本地 splash 层（叠在主界面 WV2 之上）
        Bridge _bridgeSplash;                         // splash 层消息桥（首帧/跳过/失败埋点）
        volatile bool _mainPainted;                   // 主界面首帧已绘制（bridge op uiPainted）
        bool _splashHidden;                           // splash 层已撤
        // ---- v6.60：splash 硬超时兜底（引擎起不来绝不永久卡）----
        const int SPLASH_HARD_TIMEOUT_MS = 35000;     // 硬超时（毫秒，splash 显示起算）
        System.Windows.Forms.Timer _splashHardTimer;  // 硬超时计时器
        Panel _failPanel;                             // 启动超时失败态（可见文案）
        long _t0Ms;                                    // 启动计时起点（度量用）

        // ---- 无边框窗口：八向边缘缩放（WM_NCHITTEST）----
        const int HT_LEFT = 10, HT_RIGHT = 11, HT_TOP = 12, HT_TOPLEFT = 13, HT_TOPRIGHT = 14, HT_BOTTOM = 15, HT_BOTTOMLEFT = 16, HT_BOTTOMRIGHT = 17;
        const int RESIZE_BORDER = 7;   // 边缘命中宽度（px）。同时作为 WebView2 的内缩量——见 LayoutShell()

        public MainForm() {
            Text = "⚡ 雷仔";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(960, 640);
            // 恢复上次窗口大小/位置/最大化（本地 window.json；无记录 → 默认 1360x860 居中）
            ApplySavedWindowState();
            BackColor = Color.FromArgb(5, 5, 7);   // v6.50①：#050507（与网页 splash 底色对齐）
            _t0Ms = (long)Environment.TickCount;   // v6.55：启动计时起点（度量）
            Icon = LoadIcon();
            KeyPreview = true;   // 手动刷新：F5 / Ctrl+R（ProcessCmdKey 拦截）
            BuildShell();
            StartSplashHardTimeout();   // v6.60：启动硬超时兜底（引擎起不来时到点强制撤层 + 失败态）
            try { Application.AddMessageFilter(new HotKeyFilter(this)); } catch { }   // 焦点在 WebView2 时也能捕获 F5/Ctrl+R

            Shown += delegate { Task.Run(delegate { InitAsync(); }); };
            Resize += delegate {
                if (_bmax != null) _bmax.Text = (WindowState == FormWindowState.Maximized) ? "❐" : "□";
                LayoutShell();   // 尺寸变化 → 重排 WebView2（保持 7px 边缘外露，供边缘命中缩放）
            };
            FormClosing += delegate {
                try { WindowStateStore.Save(this); } catch { }   // 记录窗口状态（大小/位置/最大化）
                try { if (_tray != null) _tray.Visible = false; } catch { }
                DisposeHotReload();
            };
            FormClosed += delegate { Application.Exit(); };
        }

        void BuildShell() {
            // v6.9：无边框窗口改由网页顶栏承载整行（左态势 / 右窗口按钮）——
            // 去掉原生标题栏，WebView2 铺满整窗；拖动/双击最大化/按钮均经 bridge 回原生
            // （见 Bridge.OpWindow → RunWindowAction）。
            _web = new WebView2();
            _web.Dock = DockStyle.None;                    // 手动定位：四周留 RESIZE_BORDER 给窗体（缩放命中）
            _web.DefaultBackgroundColor = Color.FromArgb(5, 5, 7);   // v6.50①：#050507
            Controls.Add(_web);
            // v6.55：本地 splash 层（file://）叠在主界面 WV2 之上，进程一开即动画（不依赖引擎）
            _webSplash = new WebView2();
            _webSplash.Dock = DockStyle.None;
            _webSplash.DefaultBackgroundColor = Color.FromArgb(5, 5, 7);
            Controls.Add(_webSplash);
            try { _webSplash.BringToFront(); } catch { }
            LayoutShell();
        }

        // ──────────────────────────────────────────────────────────────
        // v6.50① 原生首帧：WebView2 首帧前用 WinForms 自绘品牌底（#050507 + 居中 ⚡ 雷仔 + 微光晕）。
        // v6.51：撤除由网页信号(bridge op splashPainted)优先触发，NavigationCompleted 兜底，25s 硬兜底。
        // ──────────────────────────────────────────────────────────────
        void BuildNativeSplash() {
            // v6.54：主人定案——启动只保留视频动画。原生遮罩不再构建/显示（_splash 保持 null，HideNativeSplash/派生提示均按 null 安全跳过）。
            // 窗口 BackColor 已是 #050507（与片头首帧同色），冷启动期直接露底色，视觉连贯；splashPainted 信号链路保留但无遮罩可撤。
            Program.LogInfo("SPLASH: 原生遮罩已停用（仅保留视频动画）");
        }

        void SplashPaint(object sender, PaintEventArgs e) {
            try {
                var g = e.Graphics;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                int w = _splash.ClientSize.Width, h = _splash.ClientSize.Height;
                if (w <= 0 || h <= 0) return;
                // v6.53：品牌海报（boot_loop_first_frame.png）优先——冷启动显示"有 ⚡ + 标题"的稳态帧，不空白。
                if (!_posterTried) { _posterTried = true; _posterImg = LoadPoster(); }
                if (_posterImg != null && string.IsNullOrEmpty(_splashHint)) {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    double sc = Math.Min((double)w / _posterImg.Width, (double)h / _posterImg.Height);
                    float dw = (float)(_posterImg.Width * sc), dh = (float)(_posterImg.Height * sc);
                    g.DrawImage(_posterImg, (w - dw) / 2f, (h - dh) / 2f, dw, dh);
                    return;   // 海报已含 ⚡/标题，无需再绘自绘内容
                }
                double mn = Math.Min(w, h);
                // v6.50① 两层径向光晕（与 boot-splash.css 的 radial-gradient 分层一致，像素连续）
                DrawGlow(g, w / 2f, h / 2f, (float)(mn * 0.72), Color.FromArgb(11, 0, 229, 255));       // 外：rgba(0,229,255,.045)
                DrawGlow(g, w / 2f, (float)(h * 0.44), (float)(mn * 0.46), Color.FromArgb(26, 0, 229, 255)); // 内：rgba(0,229,255,.10)
                // 主图形 ⚡：布局盒 220x220 居中（预渲 PNG，冷启动零计算）
                if (!_boltTried) { _boltTried = true; _boltImg = LoadBolt(); }
                float boxY = h / 2f - 27f;   // 与网页 stage 整体居中的近似对齐
                if (_boltImg != null) {
                    g.DrawImage(_boltImg, w / 2f - 110f, boxY - 110f, 220f, 220f);
                } else {
                    using (var f0 = new Font("Microsoft YaHei UI", 40F, FontStyle.Bold))
                    using (var sf0 = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    using (var br0 = new SolidBrush(Color.FromArgb(0, 229, 255)))
                        g.DrawString("\u26a1", f0, br0, new RectangleF(0, boxY - 60, w, 120), sf0);
                }
                // 主标题 / 副文案（与网页 splash 文案/色值对齐）
                string title = string.IsNullOrEmpty(_splashHint) ? "\u96f7\u4ed4 \u00b7 \u96f7\u6c60\u4e2d\u67a2" : _splashHint;
                using (var f1 = new Font("Microsoft YaHei UI", 14F, FontStyle.Regular))
                using (var sf1 = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                using (var br1 = new SolidBrush(_splashHint == null ? Color.FromArgb(138, 147, 163) : Color.FromArgb(230, 200, 120)))
                    g.DrawString(title, f1, br1, new RectangleF(0, boxY + 130, w, 24), sf1);
                using (var f2 = new Font("Microsoft YaHei UI", 12F, FontStyle.Regular))
                using (var sf2 = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                using (var br2 = new SolidBrush(Color.FromArgb(94, 102, 117)))
                    g.DrawString(string.IsNullOrEmpty(_splashSub) ? "\u542f\u52a8\u4e2d\u2026" : _splashSub, f2, br2, new RectangleF(0, boxY + 158, w, 20), sf2);
            } catch { }
        }

        static void DrawGlow(Graphics g, float cx, float cy, float r, Color c) {
            try {
                if (r <= 0) return;
                var rect = new RectangleF(cx - r, cy - r, r * 2, r * 2);
                using (var path = new System.Drawing.Drawing2D.GraphicsPath()) {
                    path.AddEllipse(rect);
                    using (var pgb = new System.Drawing.Drawing2D.PathGradientBrush(path)) {
                        pgb.CenterColor = c;
                        pgb.SurroundColors = new Color[] { Color.FromArgb(0, 5, 5, 7) };
                        g.FillEllipse(pgb, rect);
                    }
                }
            } catch { }
        }

        Image LoadBolt() {
            try {
                var asm = System.Reflection.Assembly.GetExecutingAssembly();
                var st = asm.GetManifestResourceStream("splash-bolt.png");
                if (st != null) { using (st) { var ms = new MemoryStream(); st.CopyTo(ms); ms.Position = 0; return Image.FromStream(ms); } }
            } catch { }
            try {
                string f = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "splash-bolt.png");
                if (File.Exists(f)) { byte[] buf = File.ReadAllBytes(f); return Image.FromStream(new MemoryStream(buf)); }
            } catch { }
            return null;
        }

        /// <summary>加载原生遮罩品牌海报（loop 首帧）：内嵌资源 → 同目录 → boot_masks 子目录 → null（回退自绘 ⚡）。</summary>
        Image LoadPoster() {
            const string RES = "boot_loop_first_frame.png";
            try {
                var asm = System.Reflection.Assembly.GetExecutingAssembly();
                var st = asm.GetManifestResourceStream(RES);
                if (st != null) { using (st) { var ms = new MemoryStream(); st.CopyTo(ms); ms.Position = 0; return Image.FromStream(ms); } }
            } catch { }
            try {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                foreach (var cand in new string[] {
                    Path.Combine(baseDir, RES),
                    Path.Combine(Path.Combine(baseDir, "boot_masks"), RES)
                }) {
                    if (File.Exists(cand)) { byte[] buf = File.ReadAllBytes(cand); return Image.FromStream(new MemoryStream(buf)); }
                }
            } catch { }
            return null;
        }

        public void HideNativeSplash(string reason) {
            try {
                if (_splash == null || !_splash.Visible) return;
                _splash.Visible = false;
                Program.LogInfo("SPLASH: 隐藏（" + reason + "）");
            } catch { }
        }

        // ─────────── v6.55 本地 splash 层：路径 / 撤层 / 埋点 ───────────
        long Ms() { return _t0Ms > 0 ? ((long)Environment.TickCount - _t0Ms) : 0; }

        string SplashPageUrl() {
            string f = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "boot_splash", "index.html");
            return new Uri(f).AbsoluteUri;   // file:///.../boot_splash/index.html
        }

        /// <summary>撤 splash 层：隐藏本地页 WV2，露出已绘制的主界面（不销毁，便于热重载/回退）。</summary>
        void HideSplashLayer(string reason) {
            if (_splashHidden) return;
            _splashHidden = true;
            Program.LogInfo("SWITCH: 撤 splash 层（" + reason + "） t=" + Ms() + "ms");
            try { if (_webSplash != null) _webSplash.Visible = false; } catch { }
            // v6.57：同步停声——注入脚本让页面 pause/mute/卸 src（隐藏≠停声，video 仍会循环出声）
            try {
                if (_webSplash != null && _webSplash.CoreWebView2 != null) {
                    _webSplash.CoreWebView2.ExecuteScriptAsync("window.__splashStop && window.__splashStop();");
                    Program.LogInfo("SWITCH: 已向 splash 注入停声 t=" + Ms() + "ms");
                }
            } catch (Exception exs) { Program.LogInfo("SWITCH: 停声注入失败(将靠 Dispose 兜底) " + exs.Message); }
            // 兜底：1s 后彻底 Dispose splash 层，释放音频/CPU，确保无残留
            try {
                var dt = new System.Windows.Forms.Timer();
                dt.Interval = 1000;
                dt.Tick += delegate {
                    dt.Stop(); dt.Dispose();
                    try { if (_webSplash != null) { _webSplash.Dispose(); _webSplash = null; Program.LogInfo("SWITCH: splash 层已 Dispose t=" + Ms() + "ms"); } } catch (Exception exd) { Program.LogInfo("SWITCH: splash Dispose 失败 " + exd.Message); }
                };
                dt.Start();
            } catch { }
            try { if (_web != null) { _web.BringToFront(); _web.Focus(); } } catch { }
        }

        // ─────────── v6.60：splash 硬超时兜底（引擎起不来时绝不永久卡）───────────
        /// <summary>启动硬超时：splash 显示起 N 秒仍未撤层 → 强制撤层 + 进入可见失败态。
        /// 背景：撤层三条路（主界面 uiPainted / 主 WV2 NavigationCompleted+2s / 用户跳过）全部依赖
        /// 主界面导航，而导航需 _backendOk；引擎起不来时原实现会永久卡在 splash（注释所称 25s 硬兜底未实现）。</summary>
        void StartSplashHardTimeout() {
            try {
                _splashHardTimer = new System.Windows.Forms.Timer();
                _splashHardTimer.Interval = SPLASH_HARD_TIMEOUT_MS;
                _splashHardTimer.Tick += delegate {
                    try { _splashHardTimer.Stop(); _splashHardTimer.Dispose(); } catch { }
                    _splashHardTimer = null;
                    if (_splashHidden) return;                       // 正常路径已撤层 → 兜底不动作
                    Program.LogInfo("SPLASH: 硬超时 " + (SPLASH_HARD_TIMEOUT_MS / 1000) + "s 未撤层 → 强制撤层 + 失败态 t=" + Ms() + "ms");
                    HideSplashLayer("硬超时兜底");
                    ShowStartupTimeoutUi();
                };
                _splashHardTimer.Start();
                Program.LogInfo("SPLASH: 已启动硬超时兜底 " + (SPLASH_HARD_TIMEOUT_MS / 1000) + "s");
            } catch (Exception ex) { Program.LogInfo("SPLASH: 硬超时启动失败 " + ex.Message); }
        }

        /// <summary>启动超时失败态：撤层后显示明确文案（绝不黑屏/只停动画），并写 shell.log。</summary>
        void ShowStartupTimeoutUi() {
            try {
                if (InvokeRequired) { BeginInvoke(new MethodInvoker(ShowStartupTimeoutUi)); return; }
                if (_failPanel != null) { _failPanel.Visible = true; _failPanel.BringToFront(); return; }
                string logPath = "-";
                try { logPath = Path.Combine(Paths.Logs(), "shell.log"); } catch { }
                string msg = "⚠ 启动超时：后端未就绪\r\n\r\n"
                    + "引擎（node src\\server.js）在 " + (SPLASH_HARD_TIMEOUT_MS / 1000) + " 秒内未能启动，已停止等待。\r\n\r\n"
                    + "排查建议：\r\n"
                    + "· 查看日志：" + logPath + "\r\n"
                    + "· 确认程序目录下 runtime\\node.exe 存在（缺失 = 安装包不完整）\r\n"
                    + "· 重新安装最新正式版（v0.1.15 或更高）\r\n"
                    + "· 关闭安全软件后重试，或重启电脑后再试"
                    + (Shell.LastBackendError != null ? ("\r\n\r\n【诊断】" + Shell.LastBackendError) : "");
                _failPanel = new Panel();
                _failPanel.BackColor = Color.FromArgb(5, 5, 7);
                _failPanel.Dock = DockStyle.Fill;
                var lbl = new Label();
                lbl.Dock = DockStyle.Fill;
                lbl.TextAlign = ContentAlignment.MiddleCenter;
                lbl.ForeColor = Color.FromArgb(230, 200, 120);
                lbl.BackColor = Color.Transparent;
                try { lbl.Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Regular); } catch { }
                lbl.Text = msg;
                _failPanel.Controls.Add(lbl);
                Controls.Add(_failPanel);
                _failPanel.BringToFront();
                Program.LogInfo("SPLASH: 已显示启动超时失败态（文案含日志路径与排查指引）");
            } catch (Exception ex) { Program.LogInfo("SPLASH: 失败态显示异常 " + ex.Message); }
        }

        /// <summary>主界面首帧信号（bridge op uiPainted）→ 撤 splash 层。</summary>
        public void OnUiPainted(Dictionary<string, object> msg) {
            if (_mainPainted) return;
            _mainPainted = true;
            Program.LogInfo("MAIN: uiPainted t=" + Ms() + "ms");
            try { BeginInvoke(new MethodInvoker(delegate { HideSplashLayer("主界面已绘制"); })); } catch { }
        }
        public void OnSplashFrame(Dictionary<string, object> msg) {
            Program.LogInfo("SPLASH: 视频首帧 phase=" + J.GetString(msg, "phase") + " since=" + J.GetLong(msg, "since") + "ms  t=" + Ms() + "ms");
        }
        public void OnSplashError(Dictionary<string, object> msg) {
            Program.LogInfo("SPLASH: 视频失败(静默，不卡死) " + J.GetString(msg, "name") + " t=" + Ms() + "ms");
        }
        public void OnSplashAudio(Dictionary<string, object> msg) {
            Program.LogInfo("SPLASH: 音频状态 state=" + J.GetString(msg, "state") + " t=" + Ms() + "ms");
        }
        public void OnSplashStop() {
            Program.LogInfo("SPLASH: 收到停声确认 splashStop t=" + Ms() + "ms");
        }
        public void OnSplashSkip() {
            Program.LogInfo("SPLASH: 用户跳过 t=" + Ms() + "ms");
            if (_mainPainted) { try { BeginInvoke(new MethodInvoker(delegate { HideSplashLayer("用户跳过"); })); } catch { } }
        }

        // v6.50③ 后端未就绪：不静默 Navigate（页面本由该后端提供）→ 明确提示 + 后台自动重试
        void ShowBackendFailUi() {
            try {
                if (_splash == null) return;
                _splashHint = "⚠ 引擎未就绪";
                _splashSub = Shell.LastBackendError != null
                    ? ("启动失败：" + Shell.LastBackendError)
                    : "正在自动重试启动（请确认 node 可用）…";
                _splash.Visible = true;
                _splash.BringToFront();
                _splash.Invalidate();
                Program.LogInfo("SPLASH: 显示后端失败提示");
            } catch { }
        }

        void StartBackendRetry() {
            Task.Run(delegate {
                for (int i = 0; i < 30; i++) {   // 最多 30×2s = 60s
                    Thread.Sleep(2000);
                    bool ok = false;
                    try { ok = Shell.EnsureBackend(out _nodeProc, out _startedBackend); } catch { }
                    if (ok) {
                        Program.LogInfo("INIT: 后端重试成功（第 " + (i + 1) + " 次）");
                        _backendOk = true;
                        try { BeginInvoke(new MethodInvoker(delegate { _splashHint = null; _splashSub = null; TryNavigateWhenReady(); })); } catch { }
                        return;
                    }
                }
                Program.LogInfo("INIT: 后端重试 60s 仍失败");
            });
        }

        /// <summary>窗口内控件重排：WebView2 四周内缩 RESIZE_BORDER 像素，露出窗体边缘（窗体背景色，视觉无缝）。
        /// 关键：WebView2 是子窗口，若 100% 覆盖客户区，边缘 WM_NCHITTEST 会全被子窗口吃掉，
        /// 窗体的边缘缩放手柄永远触发不到（"拖边缘缩放无效"的根因）——内缩后边缘回到窗体，
        /// 命中测试才能落到窗体。与旧客户端 app/MainForm.cs 同款解法。</summary>
        void LayoutShell() {
            try {
                int b = RESIZE_BORDER;
                int w = Math.Max(ClientSize.Width - b * 2, 1);
                int h = Math.Max(ClientSize.Height - b * 2, 1);
                if (_web != null) _web.SetBounds(b, b, w, h);
                if (_webSplash != null) _webSplash.SetBounds(b, b, w, h);   // v6.55：两层同位
            } catch { }
        }

        /// <summary>无边框窗口八向边缘缩放：把窗体边缘映射为系统缩放手柄，即可按住边缘拖拽改大小。
        /// 最大化时跳过（最大化不可缩放）。</summary>
        protected override void WndProc(ref Message m) {
            if (m.Msg == 0x84 && WindowState != FormWindowState.Maximized) {   // WM_NCHITTEST
                base.WndProc(ref m);
                if ((long)m.Result == 1) {   // HTCLIENT：默认命中客户区 → 再查是否落在边缘
                    try {
                        int px = (short)((int)m.LParam & 0xFFFF);
                        int py = (short)(((int)m.LParam >> 16) & 0xFFFF);
                        Point p = PointToClient(new Point(px, py));
                        bool l = p.X <= RESIZE_BORDER, r = p.X >= ClientSize.Width - RESIZE_BORDER;
                        bool t = p.Y <= RESIZE_BORDER, b = p.Y >= ClientSize.Height - RESIZE_BORDER;
                        int code = 1;
                        if (t && l) code = HT_TOPLEFT; else if (t && r) code = HT_TOPRIGHT;
                        else if (b && l) code = HT_BOTTOMLEFT; else if (b && r) code = HT_BOTTOMRIGHT;
                        else if (t) code = HT_TOP; else if (b) code = HT_BOTTOM;
                        else if (l) code = HT_LEFT; else if (r) code = HT_RIGHT;
                        if (code != 1) m.Result = (IntPtr)code;
                    } catch { }
                }
                return;
            }
            base.WndProc(ref m);
        }

        /// <summary>应用上次保存的窗口状态（尺寸/位置/最大化）；无记录用默认 1360x860 居中。
        /// 位置做屏幕边界校验（换显示器/改分辨率后若不在屏幕内则回退居中），尺寸不小于 MinimumSize。</summary>
        void ApplySavedWindowState() {
            WindowStateStore.State st = WindowStateStore.Load();
            if (st == null || !st.HasSaved || st.W < 100 || st.H < 100) {
                ClientSize = new Size(1360, 860);
                return;
            }
            int w = Math.Max(st.W, MinimumSize.Width);
            int h = Math.Max(st.H, MinimumSize.Height);
            bool onScreen = false;
            try {
                Rectangle r = new Rectangle(st.X, st.Y, w, h);
                foreach (Screen s in Screen.AllScreens) {
                    if (s.WorkingArea.IntersectsWith(r)) { onScreen = true; break; }
                }
            } catch { onScreen = false; }
            if (onScreen) {
                StartPosition = FormStartPosition.Manual;
                SetBounds(st.X, st.Y, w, h);
                if (st.Maximized) WindowState = FormWindowState.Maximized;
            } else {
                ClientSize = new Size(w, h);   // 位置无效：保持居中（StartPosition.CenterScreen），只恢复尺寸
            }
        }

        FlatBtn MkBtn(string text, EventHandler onClick) {
            FlatBtn b = new FlatBtn();
            b.Text = text;
            b.Width = 46;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.BackColor = Color.FromArgb(16, 16, 22);
            b.ForeColor = Color.FromArgb(200, 200, 214);
            b.Font = new Font("Segoe UI", 10f);
            b.Click += onClick;
            return b;
        }

        void TitleDrag(object sender, MouseEventArgs e) {
            if (e.Button == MouseButtons.Left) {
                try { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero); } catch { }
            }
        }
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool ReleaseCapture();
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);

        void ToggleMax() {
            WindowState = (WindowState == FormWindowState.Maximized) ? FormWindowState.Normal : FormWindowState.Maximized;
        }

        Icon LoadIcon() {
            try {
                string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "⚡雷仔.ico");
                if (File.Exists(p)) return new Icon(p);
                p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "雷仔.ico");
                if (File.Exists(p)) return new Icon(p);
                // 兜底：用 exe 自身图标资源（csc /win32icon）→ 即使 .ico 未随包，任务栏/托盘也不空白
                try {
                    string exe = Application.ExecutablePath;
                    if (!string.IsNullOrEmpty(exe) && File.Exists(exe)) {
                        Icon ic = Icon.ExtractAssociatedIcon(exe);
                        if (ic != null) return ic;
                    }
                } catch { }
            } catch { }
            return null;
        }

        void InitTray() {
            try {
                _tray = new NotifyIcon();
                _tray.Icon = Icon != null ? Icon : SystemIcons.Application;
                _tray.Text = "⚡ 雷仔";
                _tray.Visible = true;
                var menu = new ContextMenuStrip();
                menu.Items.Add("显示窗口", null, delegate { ShowWindow(); });
                menu.Items.Add("最小化到托盘", null, delegate { WindowState = FormWindowState.Minimized; Hide(); });
                menu.Items.Add("开发者工具 (F12)", null, delegate { OpenDevTools(); });
                menu.Items.Add("重新加载页面 (F5)", null, delegate { DoReload("手动刷新(托盘)"); });
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("退出", null, delegate { Close(); });
                _tray.ContextMenuStrip = menu;
                _tray.DoubleClick += delegate { ShowWindow(); };
            } catch (Exception ex) { Program.LogInfo("TRAY 初始化失败: " + ex.Message); }
        }

        void ShowWindow() {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        /// <summary>打开 WebView2 开发者工具（F12 调试开关，托盘菜单/bridge 触发）。</summary>
        public void OpenDevTools() {
            try { if (_ready && _web.CoreWebView2 != null) _web.CoreWebView2.OpenDevToolsWindow(); }
            catch (Exception ex) { Program.LogInfo("DevTools: " + ex.Message); }
        }

        public void ShowTrayBalloon(string title, string body) {
            try {
                if (_tray == null) return;
                _tray.BalloonTipTitle = title;
                _tray.BalloonTipText = body;
                _tray.ShowBalloonTip(4000);
            } catch { }
        }

        void InitAsync() {
            // v6.51②：WV2 初始化**不再**被 EnsureBackend 串行阻塞 —— 先启动 WV2 环境，同时后台确保后端，
            //          两者都就绪才 Navigate（见 TryNavigateWhenReady），消除"等后端 16s + WV2 冷启动"串行叠加。
            try { BeginInvoke(new MethodInvoker(delegate { InitTray(); })); } catch { }
            try {
                InitWebView();
            } catch (Exception ex) {
                Program.LogInfo("INIT WebView2: " + ex.Message);
                try {
                    BeginInvoke(new MethodInvoker(delegate {
                        MessageBox.Show("WebView2 初始化失败：\n" + ex.Message + "\n\n请确认已安装 WebView2 运行时，且 WebView2Loader.dll 与 exe 同目录。",
                            "⚡ 雷仔", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                } catch { }
            }
            Task.Run(delegate {
                bool ok = false;
                try { ok = Shell.EnsureBackend(out _nodeProc, out _startedBackend); }
                catch (Exception ex) { Program.LogInfo("INIT 后端: " + ex.Message); }
                if (!ok) {
                    Program.LogInfo("INIT: 后端未就绪 → 显示提示并后台重试（v6.50③，不静默 Navigate）");
                    try { BeginInvoke(new MethodInvoker(delegate { ShowBackendFailUi(); })); } catch { }
                    StartBackendRetry();
                    return;
                }
                _backendOk = true;
                Program.LogInfo("INIT: 后端健康 → 尝试导航（与 WV2 并行）");
                try { BeginInvoke(new MethodInvoker(delegate { TryNavigateWhenReady(); })); } catch { }
            });
            UpdateNotice.StartAsync(this);    // P2：启动时后台检查更新并显示版本说明（非阻塞；便携/开发态自动跳过）
            UpdateNotice.StartPeriodic(this); // P2：运行期每 CheckIntervalHours 小时再查一次（同版本不重复提示）
        }

        void InitWebView() {
            // 编组到 UI 线程执行；actual 初始化改用 async/await（见 InitWebViewOnUi），
            // 避免 ContinueWith 回调落到线程池线程导致 Navigate 抛 RPC_E_WRONG_THREAD 被吞。
            try { _web.Invoke(new MethodInvoker(delegate { InitWebViewOnUi(); })); }
            catch (Exception ex) { Program.LogInfo("INIT WebView2(Invoke): " + ex.Message); }
        }

        // 在 UI 线程以 async/await 初始化 WebView2：await 的续体回到 UI 线程（SynchronizationContext），
        // Navigate 满足"必须在 UI 线程调用"的 COM 要求。
        async void InitWebViewOnUi() {
            try {
                Program.LogInfo("WV2: 初始化开始");
                // v6.52：放行无用户手势自动播放（开机视频片头 muted autoplay 需要）
                var _wvOpts = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
                var env = await CoreWebView2Environment.CreateAsync(null, Shell.UserDataFolder(), _wvOpts);
                // v6.55：splash 层优先 —— WV2 就绪即导航本地 splash 页（file://，零引擎依赖），不再等引擎
                try {
                    await _webSplash.EnsureCoreWebView2Async(env);
                    if (_webSplash.CoreWebView2 != null) {
                        _webSplash.CoreWebView2.Settings.AreDevToolsEnabled = false;
                        _webSplash.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                        _webSplash.CoreWebView2.Settings.IsStatusBarEnabled = false;
                        _bridgeSplash = new Bridge(this);
                        var bsp = _bridgeSplash;
                        _webSplash.CoreWebView2.WebMessageReceived += delegate(object s0, CoreWebView2WebMessageReceivedEventArgs e0) {
                            try { bsp.OnWebMessage(e0.TryGetWebMessageAsString()); } catch { }
                        };
                        string splashUrl = SplashPageUrl();
                        _webSplash.CoreWebView2.Navigate(splashUrl);
                        Program.LogInfo("SPLASH: 已导航本地页 " + splashUrl + " t=" + Ms() + "ms");
                    }
                } catch (Exception exs) { Program.LogInfo("SPLASH: 本地页初始化失败（静默，仍进主界面）: " + exs.Message); }
                await _web.EnsureCoreWebView2Async(env);
                if (_web.CoreWebView2 == null) { Program.LogInfo("WV2: CoreWebView2 为空，放弃"); return; }
                _ready = true;
                var s = _web.CoreWebView2.Settings;
                s.AreDevToolsEnabled = true;                       // F12 调试开关（开发期）
                s.AreDefaultContextMenusEnabled = true;
                s.IsStatusBarEnabled = false;
                _bridge = new Bridge(this);
                _web.CoreWebView2.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
                    _bridge.OnWebMessage(e.TryGetWebMessageAsString());
                };
                // F12 调试：WebView2 的 AcceleratorKeyPressed 在 CoreWebView2Controller 上（WinForms 控件不暴露），
                // 改由 托盘菜单「开发者工具」+ 前端 bridge op「devtools」触发（开发期调试开关）。
                _bridge.InjectEnv(_web.CoreWebView2);
                // v6.51①：遮罩撤除优先由**网页信号**（bridge op splashPainted，见 boot-splash.js）触发；
                //          NavigationCompleted 仅作兜底（不再唯一依赖），另有 25s 硬兜底。
                bool[] splashOffFlag = new bool[1];
                _web.CoreWebView2.NavigationCompleted += delegate(object s2, CoreWebView2NavigationCompletedEventArgs e2) {
                    if (splashOffFlag[0]) return;
                    splashOffFlag[0] = true;
                    try { if (_splashTimer != null) _splashTimer.Stop(); } catch { }
                    Program.LogInfo("SPLASH: NavigationCompleted 兜底 ok=" + e2.IsSuccess);
                    HideNativeSplash("导航完成兜底");
                    // v6.55：主界面导航完成 → 2s 内若未收到 uiPainted 信号则兜底撤 splash 层
                    try {
                        var ft = new System.Windows.Forms.Timer();
                        ft.Interval = 2000;
                        ft.Tick += delegate { ft.Stop(); ft.Dispose(); if (!_mainPainted) { _mainPainted = true; Program.LogInfo("MAIN: NavigationCompleted 兜底撤 splash t=" + Ms() + "ms"); HideSplashLayer("导航完成兜底"); } };
                        ft.Start();
                    } catch { }
                };
                try {
                    string av = UpdateNotice.AppVersion();   // B：把当前版本注入页面，供「控制台·关于」显示
                    if (!string.IsNullOrEmpty(av))
                        await _web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                            "window.__LEIZAI_APP_VER__ = '" + av.Replace("'", "") + "';");
                } catch (Exception ex) { Program.LogInfo("INIT 版本注入失败: " + ex.Message); }
                _wv2Ready = true;
                TryNavigateWhenReady();                               // v6.51②：与 EnsureBackend 并行，两者就绪才导航
                StartHotReload();                                     // 前端产物变更自动重载
            } catch (Exception ex) {
                Program.LogInfo("INIT WebView2: " + ex.GetType().Name + " :: " + ex.Message);
            }
        }

        // v6.51②：WV2 与 EnsureBackend 并行 —— 两者都就绪才 Navigate（页面由后端提供）
        void TryNavigateWhenReady() {
            try {
                if (_navigated || !_wv2Ready || !_backendOk) return;
                if (_web == null || _web.CoreWebView2 == null) return;
                _navigated = true;
                _web.CoreWebView2.Navigate(Shell.BaseUrl());
                Program.LogInfo("WV2: 已导航 " + Shell.BaseUrl() + "（WV2+后端并行就绪）");
            } catch (Exception ex) { Program.LogInfo("WV2 导航失败: " + ex.Message); }
        }

        // ──────────────────────────────────────────────────────────────
        // 前端热重载：监听 <Base>\webui（递归），只响应 dist\ 下的前端产物变更 → Reload()
        // build-webui.ps1 会整体删重建 dist，直接监听 dist 会因目录被删而失效，故监听父目录 webui。
        // ──────────────────────────────────────────────────────────────
        void StartHotReload() {
            try {
                if (_watcher != null) return;   // 幂等
                string watchDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "webui");
                if (!Directory.Exists(watchDir)) { Program.LogInfo("HOTRELOAD: 目录不存在，跳过 " + watchDir); return; }
                _watcher = new FileSystemWatcher();
                _watcher.Path = watchDir;
                _watcher.IncludeSubdirectories = true;
                _watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.DirectoryName;
                _watcher.Changed += OnHotFsEvent;
                _watcher.Created += OnHotFsEvent;
                _watcher.Deleted += OnHotFsEvent;
                _watcher.Renamed += OnHotFsEvent;
                _watcher.Error += OnHotWatcherError;
                _watcher.EnableRaisingEvents = true;

                if (_hotSettleTimer == null) {
                    _hotSettleTimer = new System.Windows.Forms.Timer();
                    _hotSettleTimer.Interval = 2500;   // v6.12 错峰：延后过的重载在转空闲后再等 2.5s
                    _hotSettleTimer.Tick += delegate { OnHotSettleTick(); };
                }
                if (_hotTimer == null) {
                    _hotTimer = new System.Windows.Forms.Timer();
                    _hotTimer.Interval = 1500;   // v6.10 去抖：重建会触发大量文件事件，1.5s 合并为一次 Reload
                    _hotTimer.Tick += delegate {
                        _hotTimer.Stop();
                        bool pending;
                        lock (_hotLock) { pending = _hotPending; _hotPending = false; }
                        if (pending) TryHotReload();   // v6.10：先查前端忙态，忙则延后
                    };
                }
                Program.LogInfo("HOTRELOAD: 已监听 " + watchDir + " (仅 dist\\ 下 .html/.js/.css/.svg)");
            } catch (Exception ex) { Program.LogInfo("HOTRELOAD 初始化失败: " + ex.Message); }
        }

        /// <summary>是否前端产物：路径含 \dist\ 且扩展名 ∈ {.html,.js,.css,.svg}。</summary>
        static bool IsFrontendArtifact(string full) {
            if (string.IsNullOrEmpty(full)) return false;
            string p = full.ToLowerInvariant();
            if (p.IndexOf("\\dist\\") < 0) return false;
            string ext = Path.GetExtension(p);
            return ext == ".html" || ext == ".js" || ext == ".css" || ext == ".svg";
        }

        void OnHotFsEvent(object sender, FileSystemEventArgs e) {
            try {
                if (!IsFrontendArtifact(e.FullPath)) return;
                lock (_hotLock) { _hotPending = true; }
                // 编组到 UI 线程重启去抖计时器（WinForms Timer 必须在 UI 线程操作）
                try { BeginInvoke(new MethodInvoker(delegate { if (_hotTimer != null) { _hotTimer.Stop(); _hotTimer.Start(); } })); } catch { }
            } catch { }
        }

        void OnHotWatcherError(object sender, ErrorEventArgs e) {
            string msg = (e != null && e.GetException() != null) ? e.GetException().Message : "?";
            Program.LogInfo("HOTRELOAD watcher 错误: " + msg + "，尝试重建");
            try {
                if (_watcher != null) { try { _watcher.EnableRaisingEvents = false; _watcher.Dispose(); } catch { } _watcher = null; }
                StartHotReload();
            } catch (Exception ex) { Program.LogInfo("HOTRELOAD 重建失败: " + ex.Message); }
        }

        /// <summary>重载页面（UI 线程安全）。</summary>
        public void DoReload(string why) {
            try {
                if (IsHandleCreated) {
                    if (InvokeRequired) { BeginInvoke(new MethodInvoker(delegate { DoReload(why); })); return; }
                }
                if (_ready && _web != null && _web.CoreWebView2 != null) {
                    _web.CoreWebView2.Reload();
                    _hotDeferred = false; _hotSettling = false;   // v6.12：重载完成即清除错峰状态
                    try { if (_hotSettleTimer != null) _hotSettleTimer.Stop(); } catch { }
                    Program.LogInfo("HOTRELOAD: " + why + "，已重载");
                }
            } catch (Exception ex) { Program.LogInfo("HOTRELOAD 重载失败: " + ex.Message); }
        }

        /// <summary>v6.10 热重载·去抖触发点：先查前端是否正在流式回复，忙则暂缓（保留待办并重启计时器，等回合结束再 Reload），空闲才重载。
        /// 手动刷新（F5/Ctrl+R/托盘/网页按钮）走 DoReload，不受此延后影响。</summary>
        async void TryHotReload() {
            try {
                // v6.12：若正处于错峰静默窗口，重来一次判定（新文件变更到来会重置节奏）
                StopSettleTimer();
                if (await IsFrontBusyAsync()) {
                    _hotDeferred = true;                       // 记下"曾因忙延后"
                    lock (_hotLock) { _hotPending = true; }   // 保留待办
                    try { if (_hotTimer != null) { _hotTimer.Stop(); _hotTimer.Start(); } } catch { }   // 1.5s 后再查，直到空闲
                    Program.LogInfo("HOTRELOAD: 前端正在流式回复，延后重载");
                    return;
                }
                // v6.12 错峰：曾因忙延后的，转空闲后不立即刷，先进 2.5s 静默窗口，到期再确认一次空闲才刷。
                // 未忙过的（正常热更新）保持原行为：直接重载（约 1.5s 内生效）。
                if (_hotDeferred) {
                    _hotSettling = true;
                    try { if (_hotSettleTimer != null) { _hotSettleTimer.Stop(); _hotSettleTimer.Start(); } } catch { }
                    Program.LogInfo("HOTRELOAD: 已转空闲，进入 2.5s 错峰静默窗口");
                    return;
                }
                DoReload("前端变更");
            } catch (Exception ex) {
                Program.LogInfo("HOTRELOAD 延后判定失败: " + ex.Message + "，直接重载");
                DoReload("前端变更");
            }
        }

        /// <summary>v6.12 错峰静默窗口到期：再确认一次前端空闲——忙则回到延后循环，空闲才真正重载。
        /// 目的：让"因忙延后"的重载避开"回合刚结束"的那几秒，不打扰正在看收尾的主人。</summary>
        async void OnHotSettleTick() {
            StopSettleTimer();
            try {
                if (await IsFrontBusyAsync()) {
                    _hotDeferred = true;
                    lock (_hotLock) { _hotPending = true; }
                    try { if (_hotTimer != null) { _hotTimer.Stop(); _hotTimer.Start(); } } catch { }
                    Program.LogInfo("HOTRELOAD: 错峰窗口内又进入回复，继续延后");
                    return;
                }
                _hotDeferred = false;
                DoReload("前端变更(错峰)");
            } catch (Exception ex) {
                Program.LogInfo("HOTRELOAD 错峰判定失败: " + ex.Message + "，直接重载");
                _hotDeferred = false;
                DoReload("前端变更(错峰)");
            }
        }

        /// <summary>v6.12 停掉错峰静默计时器（幂等）。</summary>
        void StopSettleTimer() {
            try { if (_hotSettleTimer != null) _hotSettleTimer.Stop(); } catch { }
            _hotSettling = false;
        }

        /// <summary>查前端"是否正在流式回复/后台回合进行中"：注入 JS 查询 window.__leizaiFrontBusy()（app.js 暴露）。
        /// 页面未就绪或查询失败均按"空闲"处理（宁可热更新，不误延后）。</summary>
        async Task<bool> IsFrontBusyAsync() {
            try {
                if (!_ready || _web == null || _web.CoreWebView2 == null) return false;
                string r = await _web.CoreWebView2.ExecuteScriptAsync(
                    "(typeof window.__leizaiFrontBusy==='function')?!!window.__leizaiFrontBusy():false");
                if (string.IsNullOrEmpty(r)) return false;
                return r.Trim().Trim('"').ToLowerInvariant() == "true";
            } catch { return false; }
        }

        void DisposeHotReload() {
            try { if (_watcher != null) { _watcher.EnableRaisingEvents = false; _watcher.Dispose(); _watcher = null; } } catch { }
            try { if (_hotTimer != null) { _hotTimer.Stop(); _hotTimer.Dispose(); _hotTimer = null; } } catch { }
            try { if (_hotSettleTimer != null) { _hotSettleTimer.Stop(); _hotSettleTimer.Dispose(); _hotSettleTimer = null; } } catch { }
        }

        // 手动刷新快捷键：F5 / Ctrl+R
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData) {
            if (keyData == Keys.F5 || keyData == (Keys.Control | Keys.R)) { DoReload("快捷键刷新"); return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        public void PostToWeb(string json) {            try {
                if (_ready && _web.CoreWebView2 != null) _web.CoreWebView2.PostWebMessageAsString(json);
            } catch (Exception ex) { Program.LogInfo("PostToWeb 失败: " + ex.Message); }
        }

        public void RunWindowAction(string action) {
            BeginInvoke(new MethodInvoker(delegate {
                switch (action) {
                    case "minimize": WindowState = FormWindowState.Minimized; break;
                    case "maximize": ToggleMax(); break;
                    case "close": Close(); break;
                    case "hide": WindowState = FormWindowState.Minimized; Hide(); break;
                    case "show": ShowWindow(); break;
                    case "reload": DoReload("手动刷新(网页)"); break;
                    case "drag": TitleDrag(this, new MouseEventArgs(MouseButtons.Left, 1, 0, 0, 0)); break;
                }
            }));
        }
    }

    /// <summary>窗口状态持久化（大小/位置/最大化；本地 window.json，不依赖后端）。
    /// 多实例隔离：进程名含 -preview 用 window-preview.json，正式版用 window.json。
    /// 写文件必须 UTF-8 无 BOM（.NET Encoding.UTF8 带 BOM → JSON 解析失败）。</summary>
    static class WindowStateStore {
        static string FilePath {
            get {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string pname = "";
                try { pname = System.Diagnostics.Process.GetCurrentProcess().ProcessName; } catch { }
                bool preview = pname.IndexOf("-preview", StringComparison.OrdinalIgnoreCase) >= 0;
                return Path.Combine(baseDir, preview ? "window-preview.json" : "window.json");
            }
        }

        public class State {
            public int W, H, X, Y;      // 正常态（非最大化）的尺寸 + 屏幕位置
            public bool Maximized;
            public bool HasSaved;
        }

        /// <summary>读取上次窗口状态；无记录 / 解析失败返回 null（调用方用默认值）。</summary>
        public static State Load() {
            try {
                if (!File.Exists(FilePath)) return null;
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                var d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(FilePath));
                if (d == null) return null;
                return new State {
                    W = SafeInt(d, "W"), H = SafeInt(d, "H"), X = SafeInt(d, "X"), Y = SafeInt(d, "Y"),
                    Maximized = SafeBool(d, "Maximized"), HasSaved = true,
                };
            } catch { return null; }
        }

        /// <summary>保存当前窗口状态（关窗时调用）。失败静默（无害）。</summary>
        public static void Save(MainForm f) {
            try {
                // 最大化时记录"还原态"的尺寸/位置，下次启动先恢复该尺寸
                bool max = f.WindowState == FormWindowState.Maximized;
                int w = max ? f.RestoreBounds.Width : f.ClientSize.Width;
                int h = max ? f.RestoreBounds.Height : f.ClientSize.Height;
                int x = max ? f.RestoreBounds.X : f.Left;
                int y = max ? f.RestoreBounds.Y : f.Top;
                string json = "{\"W\":" + w + ",\"H\":" + h + ",\"X\":" + x + ",\"Y\":" + y +
                              ",\"Maximized\":" + (max ? "true" : "false") + "}";
                File.WriteAllText(FilePath, json, new UTF8Encoding(false));   // 无 BOM
            } catch { }
        }

        static int SafeInt(Dictionary<string, object> d, string k) {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return 0;
            int n; return int.TryParse(v.ToString(), out n) ? n : 0;
        }
        static bool SafeBool(Dictionary<string, object> d, string k) {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return false;
            bool b; return bool.TryParse(v.ToString(), out b) && b;
        }
    }

    /// <summary>无边框按钮（自绘悬停）。</summary>
    public class FlatBtn : Button {        bool _hover;
        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnPaint(PaintEventArgs pevent) {
            Color bg = _hover ? Color.FromArgb(60, 60, 74) : Color.FromArgb(16, 16, 22);
            using (var b = new SolidBrush(bg)) pevent.Graphics.FillRectangle(b, ClientRectangle);
            TextRenderer.DrawText(pevent.Graphics, Text, Font, ClientRectangle, ForeColor,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
        protected override void OnClick(EventArgs e) {
            if (Text == "✕") { /* 关闭按钮悬停可加红色 */ }
            base.OnClick(e);
        }
    }

    /// <summary>全局消息过滤器：即使焦点在 WebView2 子窗口，也能捕获 F5 / Ctrl+R 触发手动刷新。</summary>
    public class HotKeyFilter : IMessageFilter {
        const int WM_KEYDOWN = 0x0100;
        const int VK_F5 = 0x74;
        const int VK_R = 0x52;
        readonly MainForm _form;
        public HotKeyFilter(MainForm form) { _form = form; }
        public bool PreFilterMessage(ref Message m) {
            try {
                if (m.Msg == WM_KEYDOWN) {
                    int k = (int)m.WParam;
                    if (k == VK_F5) { _form.DoReload("快捷键刷新(F5)"); return true; }
                    if (k == VK_R && (Control.ModifierKeys & Keys.Control) == Keys.Control) { _form.DoReload("快捷键刷新(Ctrl+R)"); return true; }
                }
            } catch { }
            return false;
        }
    }
}
