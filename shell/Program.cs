// LeiZai2 · A1 新客户端外壳 - 入口（单实例 + 自检模式 + 崩溃日志）
// v6.50：灰度结束，程序名自 LeiZai2.exe 改回 LeiZai.exe；单实例锁名同步收回 LeiZai_Desktop_SingleInstance。
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace LeiZai2 {
    static class Program {
        // 灰度期锁名（钉死）：旧客户端为 LeiZai_Desktop_SingleInstance_NewBody3458，必须不同。
        // 旧版退役后改回 LeiZai_Desktop_SingleInstance。
        public const string MUTEX_NAME = "LeiZai_Desktop_SingleInstance";

        // 任务栏图标/分组：显式设置进程 AppUserModelID，与 Velopack 快捷方式 AUMID 一致
        // （nuspec shortcutAumid=velopack.LeiZai）→ 任务栏显示雷仔图标并与快捷方式同组。
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

        [STAThread]
        static void Main(string[] args) {
            try { SetCurrentProcessExplicitAppUserModelID("velopack.LeiZai"); } catch { }
            // P1：Velopack 引导（安装态处理更新参数/重启；未安装态自动 no-op）。绝不因之崩溃。
            try { Velopack.VelopackApp.Build().Run(); } catch (Exception vex) { try { LogInfo("VELOPACK boot error: " + vex.Message); } catch { } }
            try { Paths.EnsureSeeded(); } catch { }   // P1：首启播种（幂等，失败不阻塞启动）
            bool selfTest = false;
            for (int i = 0; i < args.Length; i++) {
                if (args[i] == "--selftest") selfTest = true;
            }

            if (selfTest) {
                StringBuilder sb = new StringBuilder();
                try {
                    sb.AppendLine("selftest start " + DateTime.Now);
                    sb.AppendLine("webview2: " + (Shell.WebView2Available() ? "OK" : "MISSING"));
                    sb.AppendLine("backend: " + (Shell.BackendHealthOk() ? "OK" : "DOWN"));
                } catch (Exception ex) { sb.AppendLine("error: " + ex.Message); }
                try {
                    string dir = Paths.Logs();
                    Directory.CreateDirectory(dir);
                    File.WriteAllText(Path.Combine(dir, "leizai-selftest.log"), sb.ToString(), Encoding.UTF8);
                } catch { }
                return;
            }

            bool createdNew;
            Mutex mutex = new Mutex(true, MUTEX_NAME, out createdNew);
            if (!createdNew) {
                MessageBox.Show("雷仔 A1 已在运行，请查看任务栏。", "⚡ 雷仔",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e) {
                LogCrash("AppDomain: " + (e.ExceptionObject != null ? e.ExceptionObject.ToString() : "unknown"));
            };
            Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs e) {
                LogCrash("Thread: " + (e.Exception != null ? e.Exception.ToString() : "unknown"));
            };

            try {
                Application.Run(new MainForm());
            } catch (Exception ex) {
                LogCrash("Run: " + ex.ToString());
                MessageBox.Show("发生未处理异常: " + ex.Message, "⚡ 雷仔", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            GC.KeepAlive(mutex);
        }

        public static void LogCrash(string text) {
            try {
                Directory.CreateDirectory(Paths.Logs());
                File.AppendAllText(LogPath(),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " CRASH\n" + text + "\n\n", Encoding.UTF8);
            } catch { }
        }
        public static void LogInfo(string text) { LogLine("INFO", text); }

        static readonly object _logLock = new object();
        static void LogLine(string level, string text) {
            try {
                lock (_logLock) {
                    string dir = Paths.Logs();
                    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);   // v0.1.16：日志目录不存在时不再静默丢日志
                    File.AppendAllText(LogPath(), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + level + " " + text + "\n", Encoding.UTF8);
                }
            } catch { }
        }
        static string LogPath() { return Path.Combine(Paths.Logs(), "shell.log"); }
    }
}
