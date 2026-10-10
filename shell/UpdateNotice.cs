// LeiZai2 · 更新提示（P2 体验项 · 2026-10-01）
// 职责：安装态启动后【后台】检查新版本；若有更新，弹窗显示**版本说明(release notes)**。
// 原则：非阻塞（独立线程）、全程 try/catch——任何异常都不影响正常使用；
//       便携/开发态(UpdateManager.IsInstalled=false) 自动跳过，不打扰。
using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Velopack;
using Velopack.Sources;

namespace LeiZai2 {
    public static class UpdateNotice {
        const string REPO = "https://github.com/zhuang3719/leizai-releases";
        const string MIRROR = "https://dl.leizai.cc/";   // CF 镜像：SimpleWebSource 取 {base}/releases.{channel}.json（channel 默认 win）
        const string RELEASES_PAGE = "https://dl.leizai.cc/";   // 新通道：公开发布/镜像入口（旧源码仓已私有，原 github releases 链接会 404）

        /// <summary>最近一次检查结果：有更新 + 新版本号（供 Bridge 查询 / 推送给前端左栏）。合并自 build 仓。</summary>
        public static volatile bool HasUpdate;
        public static volatile string LatestVersion;

        // ── 视觉令牌（按既定视觉规范）──
        static readonly System.Drawing.Color C_BG     = System.Drawing.Color.FromArgb(0x05, 0x05, 0x07); // #050507 窗体底
        static readonly System.Drawing.Color C_PANEL  = System.Drawing.Color.FromArgb(0x0E, 0x0E, 0x15); // #0E0E15 卡片底
        static readonly System.Drawing.Color C_TRACK  = System.Drawing.Color.FromArgb(0x19, 0x19, 0x24); // #191924 进度轨
        static readonly System.Drawing.Color C_BORDER = System.Drawing.Color.FromArgb(0x2E, 0x2E, 0x40); // #2E2E40 描边
        static readonly System.Drawing.Color C_TEXT   = System.Drawing.Color.FromArgb(0xEE, 0xF0, 0xF6); // #EEF0F6 主文字
        static readonly System.Drawing.Color C_DIM    = System.Drawing.Color.FromArgb(0x8F, 0x8F, 0xA3); // #8F8FA3 次级文字
        static readonly System.Drawing.Color C_BODY   = System.Drawing.Color.FromArgb(0xC9, 0xCB, 0xD6); // #C9CBD6 正文
        static readonly System.Drawing.Color BRAND_ACC  = System.Drawing.Color.FromArgb(0x00, 0xE5, 0xFF); // #00E5FF 闪电青(主色)
        static readonly System.Drawing.Color BRAND_ACC2 = System.Drawing.Color.FromArgb(0x4D, 0xF3, 0xFF); // #4DF3FF 亮青
        static readonly System.Drawing.Color BRAND_VIO  = System.Drawing.Color.FromArgb(0x9E, 0x7B, 0xFF); // #9E7BFF 品牌紫
        static readonly System.Drawing.Color C_OK  = System.Drawing.Color.FromArgb(0x2B, 0xE0, 0x88);     // #2BE088 完成
        static readonly System.Drawing.Color C_ERR = System.Drawing.Color.FromArgb(0xFF, 0x4D, 0x6D);     // #FF4D6D 失败

        /// <summary>加载品牌闪电 logo（28×28）：嵌入式 splash-bolt.png → 磁盘备选。</summary>
        static System.Drawing.Image LoadBrandLogo() {
            try {
                System.Drawing.Image src = null;
                try {
                    var asm = System.Reflection.Assembly.GetExecutingAssembly();
                    using (var st = asm.GetManifestResourceStream("splash-bolt.png")) {
                        if (st != null) { var ms = new MemoryStream(); st.CopyTo(ms); ms.Position = 0; src = System.Drawing.Image.FromStream(ms); }
                    }
                } catch { }
                if (src == null) {
                    string[] cand = new string[] {
                        Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "splash-bolt.png"),
                        @"<项目根>\项目文件\图标设计\用户logo\雷仔Logo_定稿包_20261001\PNG\logo_256.png"
                    };
                    for (int i = 0; i < cand.Length; i++) { try { if (File.Exists(cand[i])) { src = System.Drawing.Image.FromFile(cand[i]); break; } } catch { } }
                }
                if (src == null) return null;
                var bmp = new System.Drawing.Bitmap(28, 28);
                using (var g = System.Drawing.Graphics.FromImage(bmp)) {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    g.DrawImage(src, new System.Drawing.Rectangle(0, 0, 28, 28));
                }
                return bmp;
            } catch { return null; }
        }
        static string SkipFile() { return Path.Combine(Paths.Root(), "update-skip.txt"); }

        /// <summary>运行期周期检查间隔（小时）——命名常量，便于测试时临时调小实测触发。</summary>
        const int CheckIntervalHours = 6;
        static readonly TimeSpan CheckInterval = TimeSpan.FromHours(CheckIntervalHours);

        /// <summary>入口：启动时从 UI 线程调用，内部起后台任务检查一次，立即返回。</summary>
        public static void StartAsync(Form owner) {
            try { Task.Run(async delegate { await CheckAndPrompt(owner); }); } catch { }
        }

        /// <summary>手动检查更新（用户主动触发，设置页「关于」）：无论有无更新都给出反馈；跳过"已提示/已稍后"去重门槛。合并自 build 仓。</summary>
        public static void CheckNow(Form owner) {
            if (owner == null) return;
            try { Task.Run(async delegate { await CheckAndPrompt(owner, true); }); } catch { }
        }

        /// <summary>运行期周期检查：每 CheckIntervalHours 小时查一次（首查由启动时 StartAsync 完成）。</summary>
        public static void StartPeriodic(Form owner) {
            try {
                Task.Run(async delegate {
                    while (true) {
                        try {
                            await Task.Delay(CheckInterval);
                            if (owner != null && owner.IsDisposed) return;   // 窗口已关闭 → 停止
                            await CheckAndPrompt(owner);
                        } catch (Exception ex) { try { Program.LogInfo("UPDATE 周期检查异常: " + ex.Message); } catch { } }
                    }
                });
            } catch { }
        }

        static async Task CheckAndPrompt(Form owner, bool manual = false) {
            try {
                UpdateManager mgr = null; UpdateInfo info = null; bool mirror = true;
                // 主源：CF 镜像（SimpleWebSource）；检查失败 → 回落 GitHub（GithubSource）
                Program.LogInfo("UPDATE 开始检查（源=镜像/GitHub）");
                try {
                    mgr = new UpdateManager(new SimpleWebSource(MIRROR));
                    if (!mgr.IsInstalled) return;               // 便携/绿色态不做更新检查
                    info = await mgr.CheckForUpdatesAsync();
                } catch (Exception ex) { Program.LogInfo("UPDATE 镜像检查失败: " + ex.Message); }
                if (info == null) {
                    try {
                        mgr = new UpdateManager(new GithubSource(REPO, null, false));
                        mirror = false;
                        if (!mgr.IsInstalled) return;
                        info = await mgr.CheckForUpdatesAsync();
                    } catch (Exception ex) { Program.LogInfo("UPDATE GitHub 检查失败: " + ex.Message); }
                }
                Program.LogInfo("UPDATE 检查结果: " + (info != null && info.TargetFullRelease != null && info.TargetFullRelease.Version != null ? info.TargetFullRelease.Version.ToString() : "null"));
                if (info == null) {                           // 已是最新
                    HasUpdate = false; LatestVersion = null;
                    if (manual) {
                        try { MessageBox.Show(owner, "当前已是最新版本（" + AppVersion() + "）", "⚡ 雷仔 · 检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information); } catch { }
                    }
                    return;
                }
                string ver = info.TargetFullRelease != null && info.TargetFullRelease.Version != null
                    ? info.TargetFullRelease.Version.ToString() : "?";
                LatestVersion = ver; HasUpdate = true;         // 供 Bridge/左栏「有新版本」提示（手动检查也刷新）
                if (!manual) {                                 // 手动检查跳过两个去重门槛（用户主动要结果）
                    if (Declined(ver)) return;                 // 用户已"稍后"过该版本 → 不再打扰
                    if (AlreadyPrompted(ver)) return;          // 同一版本已提示过（含运行期周期检查）→ 不重复弹
                }
                string notes = info.TargetFullRelease != null ? info.TargetFullRelease.NotesHTML : null;
                if (string.IsNullOrEmpty(notes)) notes = info.TargetFullRelease != null ? info.TargetFullRelease.NotesMarkdown : null;
                MarkPrompted(ver);                            // 记录"已提示过该版本"（持久化），同版本不再重复弹
                owner.BeginInvoke((MethodInvoker)delegate { ShowDialog(owner, mgr, info, ver, notes, mirror); });
            } catch (Exception ex) { Program.LogInfo("UPDATE 主检查最外层异常: " + ex.Message); }
        }

        static string PromptedFile() { return Path.Combine(Paths.Root(), "update-prompted.json"); }
        /// <summary>该版本是否已提示过（持久化于 &lt;dataDir&gt;\update-prompted.json）→ 同版本不重复弹。</summary>
        static bool AlreadyPrompted(string ver) {
            try {
                if (!File.Exists(PromptedFile())) return false;
                var list = Json.ParseArray(File.ReadAllText(PromptedFile()));
                if (list == null) return false;
                foreach (object o in list) if (o != null && o.ToString() == ver) return true;
                return false;
            } catch { return false; }
        }
        static void MarkPrompted(string ver) {
            try {
                var list = new System.Collections.Generic.List<object>();
                try { var old = Json.ParseArray(File.ReadAllText(PromptedFile())); if (old != null) list.AddRange(old); } catch { }
                foreach (object o in list) if (o != null && o.ToString() == ver) return;
                list.Add(ver);
                File.WriteAllText(PromptedFile(), Json.Dump(list));
            } catch { }
        }

        /// <summary>当前应用版本：优先读安装目录 sq.version（Velopack），回退程序集版本。</summary>
        public static string AppVersion() {
            try {
                string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "sq.version");
                if (File.Exists(p)) {
                    var m = Regex.Match(File.ReadAllText(p), "<version>([^<]+)</version>");
                    if (m.Success) return m.Groups[1].Value.Trim();
                }
            } catch { }
            try { return System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(); } catch { }
            return "";
        }

        static bool Declined(string ver) {
            try { return File.Exists(SkipFile()) && File.ReadAllText(SkipFile()).Trim() == ver; } catch { return false; }
        }
        static void MarkDeclined(string ver) {
            try { File.WriteAllText(SkipFile(), ver); } catch { }
        }

        static string HtmlToText(string html) {
            if (string.IsNullOrEmpty(html)) return "";
            string t = Regex.Replace(html, "<\\s*br\\s*/?>", "\n", RegexOptions.IgnoreCase);
            t = Regex.Replace(t, "</\\s*(p|div|li|h[1-6])\\s*>", "\n", RegexOptions.IgnoreCase);
            t = Regex.Replace(t, "<li\\s*>", "· ", RegexOptions.IgnoreCase);
            t = Regex.Replace(t, "<[^>]+>", "");
            t = System.Net.WebUtility.HtmlDecode(t);
            t = Regex.Replace(t, "\n{3,}", "\n\n").Trim();
            return t;
        }

        static void ShowDialog(Form owner, UpdateManager mgr, UpdateInfo info, string ver, string notesRaw, bool mirror) {
            try {
                string notes = HtmlToText(notesRaw);
                if (string.IsNullOrEmpty(notes)) notes = "（本版本未附带版本说明）";

                var f = new Form();
                f.Text = "⚡ 雷仔 · 发现新版本 v" + ver;
                f.StartPosition = FormStartPosition.CenterParent;
                f.ClientSize = new System.Drawing.Size(520, 380);
                f.MinimizeBox = false; f.MaximizeBox = false;
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.BackColor = C_BG;
                f.ForeColor = C_TEXT;
                f.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f);

                // 1) 闪电 logo 28×28 @(28,26)
                var picLogo = new PictureBox();
                picLogo.SizeMode = PictureBoxSizeMode.Zoom;
                picLogo.BackColor = System.Drawing.Color.Transparent;
                picLogo.SetBounds(28, 26, 28, 28);
                try { picLogo.Image = LoadBrandLogo(); } catch { }
                f.Controls.Add(picLogo);

                // 2) 标题 14pt Bold @(68,22)
                var lbl = new Label();
                lbl.Text = "发现新版本 v" + ver;
                lbl.Font = new System.Drawing.Font("Microsoft YaHei UI", 14f, System.Drawing.FontStyle.Bold);
                lbl.ForeColor = C_TEXT;
                lbl.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
                lbl.SetBounds(68, 22, 340, 26);
                f.Controls.Add(lbl);

                // 3) 副标题 9pt @(68,49)
                var lblSub = new Label();
                lblSub.Text = "当前 v" + (mgr.CurrentVersion != null ? mgr.CurrentVersion.ToString() : "?") + " → 最新 v" + ver;
                lblSub.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f);
                lblSub.ForeColor = C_DIM;
                lblSub.SetBounds(68, 49, 340, 18);
                f.Controls.Add(lblSub);

                // 4) 版本说明卡片 464×196 @(28,80)（底 #0E0E15 · 1px 描边 #2E2E40；圆角留子单2）
                var card = new RoundedPanel();
                card.FillColor = C_PANEL; card.BorderColor = C_BORDER; card.Radius = 12;
                card.SetBounds(28, 80, 464, 196);
                f.Controls.Add(card);

                // 5) 版本说明正文 9pt（卡片内）
                var box = new TextBox();
                box.Multiline = true; box.ReadOnly = true; box.ScrollBars = ScrollBars.Vertical;
                box.BackColor = C_PANEL;
                box.ForeColor = C_BODY;
                box.BorderStyle = BorderStyle.None;
                box.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f);
                box.Text = notes;
                box.SetBounds(14, 14, 436, 168);
                card.Controls.Add(box);

                // 6) 状态文字（左）9pt @(28,288)
                var lblStat = new Label();
                lblStat.Text = "已发现新版本，点击「立即更新并重启」开始下载";
                lblStat.ForeColor = C_DIM;
                lblStat.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f);
                lblStat.SetBounds(28, 288, 320, 18);
                f.Controls.Add(lblStat);

                // 7) 百分比（右）9pt Bold @(356,288)
                var lblPct = new Label();
                lblPct.Text = ""; lblPct.ForeColor = BRAND_ACC;
                lblPct.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f, System.Drawing.FontStyle.Bold);
                lblPct.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
                lblPct.SetBounds(356, 288, 136, 18);
                f.Controls.Add(lblPct);

                // 8) 进度条占位 @(28,312)（自绘胶囊留子单2，本单沿用系统控件）
                var bar = new CapsuleBar();
                bar.SetBounds(28, 312, 464, 8);
                bar.Visible = false;
                f.Controls.Add(bar);

                // 9) 按钮组（右对齐至 x=492；样式留子单2）
                var btnNow = new GradButton(); btnNow.Kind = GradButton.S.Primary; btnNow.Text = "立即更新并重启";
                btnNow.Font = new System.Drawing.Font("Microsoft YaHei UI", 10f, System.Drawing.FontStyle.Bold);
                btnNow.SetBounds(360, 340, 132, 34);
                var btnPage = new GradButton(); btnPage.Kind = GradButton.S.Outline; btnPage.Text = "打开发布页";
                btnPage.Font = new System.Drawing.Font("Microsoft YaHei UI", 9.5f);
                btnPage.SetBounds(256, 340, 96, 34);
                var btnLater = new GradButton(); btnLater.Kind = GradButton.S.Ghost; btnLater.Text = "稍后";
                btnLater.Font = new System.Drawing.Font("Microsoft YaHei UI", 9.5f);
                btnLater.SetBounds(180, 340, 68, 34);
                f.Controls.Add(btnNow); f.Controls.Add(btnPage); f.Controls.Add(btnLater);
                f.AcceptButton = btnNow; f.CancelButton = btnLater;

                btnPage.Click += delegate {
                    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(RELEASES_PAGE) { UseShellExecute = true }); } catch { }
                };
                btnLater.Click += delegate { MarkDeclined(ver); try { f.Close(); } catch { } };
                btnNow.Click += async delegate {
                    bool failed = false; string failMsg = null;
                    try {
                        btnNow.Enabled = false; btnPage.Enabled = false; btnLater.Enabled = false;
                        btnNow.Text = "下载中…";
                        bar.Visible = true; bar.Value = 0; bar.Done = false; bar.Error = false;
                        lblPct.ForeColor = BRAND_ACC; lblPct.Text = "0%";
                        lblStat.ForeColor = BRAND_ACC;
                        lblStat.Text = "下载中… 0%（共约 " + (info.TargetFullRelease != null && info.TargetFullRelease.Size > 0
                            ? (info.TargetFullRelease.Size / 1048576.0).ToString("0.0") + " MB" : "若干") + "）";
                        Program.LogInfo("UPDATE 点击更新：开始下载 " + ver);
                        Action<int> prog = delegate(int p) {
                            try {
                                f.BeginInvoke((MethodInvoker)delegate {
                                    try {
                                        int v = p < 0 ? 0 : (p > 100 ? 100 : p);
                                        bar.Value = v;
                                        lblPct.Text = v + "%";
                                        lblStat.Text = "下载中… " + v + "%";
                                    } catch { }
                                });
                            } catch { }
                        };
                        await mgr.DownloadUpdatesAsync(info, prog, System.Threading.CancellationToken.None);
                        try { bar.Value = 100; bar.Done = true; } catch { }
                        lblPct.Text = "100%"; lblPct.ForeColor = C_OK;
                        lblStat.ForeColor = C_OK;
                        lblStat.Text = "下载完成，正在重启应用…";
                        btnNow.Text = "正在重启…";
                        Program.LogInfo("UPDATE 下载完成，应用并重启");
                        mgr.ApplyUpdatesAndRestart(info.TargetFullRelease, null);
                    } catch (Exception ex) { failed = true; failMsg = ex.Message; }
                    if (failed) {
                        Program.LogInfo("UPDATE 应用失败: " + failMsg);
                        bool ok = false;
                        if (mirror) {
                            try {
                                var gmgr = new UpdateManager(new GithubSource(REPO, null, false));
                                var ginfo = await gmgr.CheckForUpdatesAsync();
                                if (ginfo != null) {
                                    await gmgr.DownloadUpdatesAsync(ginfo, null, System.Threading.CancellationToken.None);
                                    gmgr.ApplyUpdatesAndRestart(ginfo.TargetFullRelease, null);
                                    ok = true;
                                }
                            } catch (Exception ex2) { Program.LogInfo("UPDATE GitHub 回落失败: " + ex2.Message); }
                        }
                        if (!ok) { try { bar.Error = true; lblPct.Text = ""; lblStat.ForeColor = C_ERR; lblStat.Text = "更新失败：" + (failMsg != null ? failMsg : "未知原因") + "（可点「打开发布页」手动下载）"; btnNow.Text = "更新失败，请到发布页下载"; btnPage.Enabled = true; btnLater.Enabled = true; } catch { } }
                    }
                };

                try { f.ShowDialog(owner != null && owner.Visible ? owner : null); } catch { f.ShowDialog(); }
            } catch (Exception ex) { Program.LogInfo("UPDATE 最外层异常: " + ex.Message); }
        }
        /// <summary>自绘胶囊进度条（规范 §3）：圆角4 · 轨 #191924 · 填 青→亮青渐变。</summary>
        internal class CapsuleBar : Control {
            int _val; bool _done, _err;
            internal CapsuleBar() {
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
                BackColor = System.Drawing.Color.Transparent;
            }
            internal int Value { get { return _val; } set { _val = value < 0 ? 0 : (value > 100 ? 100 : value); Invalidate(); } }
            internal bool Done { get { return _done; } set { _done = value; Invalidate(); } }
            internal bool Error { get { return _err; } set { _err = value; Invalidate(); } }
            internal static System.Drawing.Drawing2D.GraphicsPath RR(System.Drawing.Rectangle r, int rad) {
                var p = new System.Drawing.Drawing2D.GraphicsPath(); int d = rad * 2;
                if (d > r.Width) d = r.Width; if (d > r.Height) d = r.Height;
                p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                p.CloseFigure(); return p;
            }
            protected override void OnPaint(PaintEventArgs e) {
                var g = e.Graphics; g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (var bg = new System.Drawing.SolidBrush(Parent != null ? Parent.BackColor : C_BG)) g.FillRectangle(bg, ClientRectangle);
                var rt = new System.Drawing.Rectangle(0, 0, Width - 1, Height - 1);
                using (var tp = RR(rt, 4)) {
                    using (var tb = new System.Drawing.SolidBrush(_err ? System.Drawing.Color.FromArgb(0x3A, 0x1D, 0x26) : C_TRACK)) g.FillPath(tb, tp);
                    if (_err) return;
                    int w = (int)System.Math.Round((Width - 1) * (_val / 100.0));
                    if (_val > 0 && w < Height) w = Height;
                    if (w > 0) {
                        var fr = new System.Drawing.Rectangle(0, 0, w, Height - 1);
                        using (var fp = RR(fr, 4)) {
                            var c1 = _done ? C_OK : BRAND_ACC; var c2 = _done ? BRAND_ACC : BRAND_ACC2;
                            using (var lb = new System.Drawing.Drawing2D.LinearGradientBrush(fr, c1, c2, System.Drawing.Drawing2D.LinearGradientMode.Horizontal)) g.FillPath(lb, fp);
                        }
                    }
                }
            }
        }

        /// <summary>自绘圆角面板（规范 §2/§6）：填色 + 1px 描边 + 圆角半径。</summary>
        internal class RoundedPanel : Panel {
            internal System.Drawing.Color FillColor = C_PANEL;
            internal System.Drawing.Color BorderColor = C_BORDER;
            internal int Radius = 12;
            internal RoundedPanel() {
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
                BackColor = C_BG;
            }
            protected override void OnPaint(PaintEventArgs e) {
                var g = e.Graphics; g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (var bg = new System.Drawing.SolidBrush(BackColor)) g.FillRectangle(bg, ClientRectangle);
                var r = new System.Drawing.Rectangle(0, 0, Width - 1, Height - 1);
                using (var path = CapsuleBar.RR(r, Radius)) {
                    using (var b = new System.Drawing.SolidBrush(FillColor)) g.FillPath(b, path);
                    using (var pen = new System.Drawing.Pen(BorderColor, 1f)) g.DrawPath(pen, path);
                }
            }
        }

        /// <summary>自绘按钮（规范 §4）：主=青→紫渐变/深字 Bold；次=1px 描边；缓=幽灵。</summary>
        internal class GradButton : Button {
            internal enum S { Primary, Outline, Ghost }
            internal S Kind = S.Primary;
            bool _hover;
            internal GradButton() {
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
                FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; UseVisualStyleBackColor = false;
                BackColor = System.Drawing.Color.Transparent;
            }
            protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
            protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
            protected override void OnPaint(PaintEventArgs e) {
                var g = e.Graphics; g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (var bg = new System.Drawing.SolidBrush(Parent != null ? Parent.BackColor : C_BG)) g.FillRectangle(bg, ClientRectangle);
                var r = new System.Drawing.Rectangle(0, 0, Width - 1, Height - 1);
                bool dis = !Enabled;
                if (Kind == S.Primary) {
                    var c1 = dis ? System.Drawing.Color.FromArgb(0x23, 0x23, 0x2F) : (_hover ? BRAND_ACC2 : BRAND_ACC);
                    var c2 = dis ? System.Drawing.Color.FromArgb(0x23, 0x23, 0x2F) : (_hover ? System.Drawing.Color.FromArgb(0x8A, 0x78, 0xFF) : BRAND_VIO);
                    using (var path = CapsuleBar.RR(r, 8))
                    using (var lb = new System.Drawing.Drawing2D.LinearGradientBrush(r, c1, c2, System.Drawing.Drawing2D.LinearGradientMode.Horizontal)) g.FillPath(lb, path);
                } else if (Kind == S.Outline) {
                    var bc = dis ? C_BORDER : (_hover ? BRAND_ACC : C_BORDER);
                    using (var path = CapsuleBar.RR(r, 8))
                    using (var pen = new System.Drawing.Pen(bc, 1f)) g.DrawPath(pen, path);
                }
                System.Drawing.Color tc;
                if (Kind == S.Primary) tc = dis ? C_DIM : C_BG;
                else if (Kind == S.Outline) tc = dis ? System.Drawing.Color.FromArgb(0x5A, 0x5A, 0x6E) : (_hover ? BRAND_ACC : C_BODY);
                else tc = dis ? System.Drawing.Color.FromArgb(0x5A, 0x5A, 0x6E) : (_hover ? C_TEXT : C_DIM);
                TextRenderer.DrawText(g, Text, Font, r, tc, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            }
        }

    }
}
