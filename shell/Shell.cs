// LeiZai2 · 外壳公共层：后端发现/拉起、健康检查、端口、WebView2 可用性
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace LeiZai2 {
    public static class Shell {
        static int _port = -1;

        /// <summary>最近一次后端启动失败原因（供失败面板展示，不静默）。</summary>
        public static string LastBackendError;

        /// <summary>后端端口：优先读程序目录 config.json 的 port，缺省 3457。复用同一后端，不另起端口。</summary>
        public static int Port() {
            if (_port > 0) return _port;
            int p = 3457;
            try {
                string f = Paths.ConfigPath();
                if (File.Exists(f)) {
                    var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                    var d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(f));
                    object v;
                    if (d != null && d.TryGetValue("port", out v) && v != null) {
                        int.TryParse(Convert.ToString(v), out p);
                    }
                }
            } catch { }
            if (p <= 0) p = 3457;
            _port = p;
            return _port;
        }

        public static string BaseUrl() { return "http://127.0.0.1:" + Port(); }

        public static bool BackendHealthOk() {
            try {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(BaseUrl() + "/api/health");
                req.Method = "GET";
                req.Timeout = 3000;
                req.Proxy = null;
                req.KeepAlive = false;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    return resp.StatusCode == HttpStatusCode.OK;
            } catch { return false; }
        }

        static readonly object _lock = new object();

        /// <summary>确保后端可用（幂等 + 单飞）。未运行则静默拉起 node src/server.js --daemon。</summary>
        public static bool EnsureBackend(out Process nodeProc, out bool startedBackend) {
            nodeProc = null; startedBackend = false;
            lock (_lock) {
                try {
                    if (BackendHealthOk()) { Program.LogInfo("ENSURE: 已有健康后端，attach"); return true; }
                    int port = Port();
                    // 端口被僵尸占位（能连上但健康不过/正在退出）→ 先清掉再启动
                    int stale = FindPidOnPort(port);
                    Program.LogInfo("ENSURE: 端口 " + port + " 占用 pid=" + stale);
                    if (stale > 0) {
                        try { Process.GetProcessById(stale).Kill(); } catch { }
                        for (int i = 0; i < 10; i++) { Thread.Sleep(200); if (FindPidOnPort(port) == 0) break; }
                        if (BackendHealthOk()) return true;
                    }
                    for (int attempt = 0; attempt < 2; attempt++) {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = Paths.NodeExe();
                        psi.Arguments = "src\\server.js --daemon";
                        psi.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        psi.CreateNoWindow = true;
                        psi.UseShellExecute = false;   // 须为 false 才能注入环境变量
                        psi.RedirectStandardInput = true;   // 产品规则层：解密 key 经 stdin 一次性注入（不落 env/命令行）
                        psi.EnvironmentVariables["LEIZAI_DATA_DIR"] = Paths.Root();   // P1：数据根单点注入给 node
                        psi.EnvironmentVariables["LEIZAI_KEY_STDIN"] = "1";   // 令引擎从 stdin 首行读解密 key（见 src/prompt.js embedKey）
                        psi.EnvironmentVariables["AGENT_LY_ROOT"] = System.IO.Path.Combine(Paths.Root(), "雷影");   // P3（2026-10-08）：雷影根随数据根走，绝不落安装目录（防升级替换 current 删雷影）
                        // P3 加固（2026-10-08）：清除开发期环境变量，防 env 注入把产品版升格为 dev
                        // （LEIZAI_PRO_DEV=1 → gate.js _envDev → tier=pro），并防 LEIZAI_CONFIG_PATH /
                        // LEIZAI_CONFIG_COMMON_PATH 误指配置。LEIZAI_DATA_DIR 语义不变（上行为准）。
                        foreach (var _ev in new[] { "LEIZAI_PRO_DEV", "LEIZAI_CONFIG_PATH", "LEIZAI_CONFIG_COMMON_PATH" }) {
                            try { psi.EnvironmentVariables.Remove(_ev); } catch { }
                            psi.EnvironmentVariables[_ev] = "";   // 兜底：空值≠'1'，config 路径回退默认
                        }
#if RELEASE_BUILD
                        // 安全加固 A（2026-10-08）：发布构建在客户端注入 LEIZAI_RELEASE=1，使 env 成为权威——
                        //   即使 <install>\.release 被删除，gate.js 仍因 env 恒 enforce（堵"删标记即降级 dev"）。
                        //   开发构建不含 RELEASE_BUILD 定义 → 不注入，dev 行为不变（红线）。
                        psi.EnvironmentVariables["LEIZAI_RELEASE"] = "1";
#endif
                        Program.LogInfo("ENSURE: attempt=" + attempt + " 启动 node...");
                        try {
                            nodeProc = Process.Start(psi);
                            // 产品规则层：把编译入本 exe(IL) 的解密 key 经子进程 stdin 首行注入引擎（不落 env/命令行）。
                            try {
                                nodeProc.StandardInput.WriteLine(BaselineKey.K);
                                nodeProc.StandardInput.Flush();
                            } catch { }
                        } catch (Exception pse) {
                            bool fex = false; try { fex = File.Exists(psi.FileName); } catch { }
                            LastBackendError = "启动引擎失败：FileName=\"" + psi.FileName + "\"（File.Exists=" + fex
                                + "，工作目录=\"" + psi.WorkingDirectory + "\"）· " + pse.GetType().Name + " :: " + pse.Message
                                + " · NodeExe候选=" + (Paths.LastNodeExeCandidates ?? "-");
                            Program.LogInfo("ENSURE: Process.Start 失败 :: " + LastBackendError);
                            throw;
                        }
                        startedBackend = true;
                        for (int i = 0; i < 30; i++) {
                            Thread.Sleep(500);
                            if (BackendHealthOk()) { Program.LogInfo("ENSURE: node 健康 (wait " + (i * 0.5) + "s)"); return true; }
                            if (nodeProc.HasExited) { Program.LogInfo("ENSURE: node 提前退出 exit=" + nodeProc.ExitCode); break; }
                        }
                        if (attempt == 0) {
                            Thread.Sleep(800);
                            int pid2 = FindPidOnPort(port);
                            if (pid2 > 0) { try { Process.GetProcessById(pid2).Kill(); } catch { } Thread.Sleep(600); }
                        }
                    }
                    Program.LogInfo("ENSURE: 两轮均失败");
                } catch (Exception ex) {
                    Program.LogInfo("ENSURE: 异常 " + ex.GetType().Name + " :: " + ex.Message);
                }
                return false;
            }
        }

        /// <summary>WebView2 运行时可加载（Loader DLL 在程序目录 + 能建环境）。</summary>
        public static bool WebView2Available() {
            try {
                string loader = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "WebView2Loader.dll");
                if (!File.Exists(loader)) return false;
                var env = Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, UserDataFolder(), null).GetAwaiter().GetResult();
                return env != null;
            } catch { return false; }
        }

        /// <summary>WebView2 用户数据目录：程序目录下 webview2-data（避免权限问题）。</summary>
        public static string UserDataFolder() {
            string d = Paths.WebViewData();
            try { Directory.CreateDirectory(d); } catch { }
            return d;
        }

        public static int FindPidOnPort(int port) {
            try {
                var psi = new ProcessStartInfo();
                psi.FileName = "netstat";
                psi.Arguments = "-ano -p tcp";
                psi.RedirectStandardOutput = true;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (var p = Process.Start(psi)) {
                    string outp = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                    foreach (string line in outp.Split('\n')) {
                        string t = line.Trim();
                        if (t.Contains(":" + port) && t.Contains("LISTENING")) {
                            string[] parts = t.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                            if (parts.Length >= 5) {
                                int pid;
                                if (int.TryParse(parts[parts.Length - 1], out pid)) return pid;
                            }
                        }
                    }
                }
            } catch { }
            return 0;
        }
    }
}
