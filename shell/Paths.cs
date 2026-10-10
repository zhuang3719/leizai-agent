// LeiZai · 数据路径唯一权威（P1 布局方案A）
// Root() 优先级：env LEIZAI_DATA_DIR > portable.flag(安装根) > 指针文件(%LOCALAPPDATA%\LeiZaiDataDir.txt) > %LOCALAPPDATA%\LeiZaiData > exe 目录
// ⚠ Velopack 安装目录 = %LocalAppData%\{packId} = %LocalAppData%\LeiZai（卸载会整目录删除）→
//   数据根绝不能落在该目录内，故安装版默认用「同级但不同名」的 %LocalAppData%\LeiZaiData（P2 · 2026-10-01）。
// shell 单点计算 Root() 并注入 env 给 node 子进程；node 侧 src/paths.js 纯派生。
using System;
using System.IO;

namespace LeiZai2 {
    public static class Paths {
        const string FLAG = "portable.flag";
        static string _root;

        /// <summary>代码目录（exe 所在，只读二进制）。</summary>
        public static string CodeDir() {
            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        }

        /// <summary>随包 node 运行时（v0.1.16 候选链）：逐级探测，命中即返回**绝对路径**：
        /// 1) &lt;BaseDirectory&gt;\runtime\node.exe（当前发布布局）
        /// 2) &lt;BaseDirectory&gt;\..\runtime\node.exe（runtime 置于安装根时/旧布局）
        /// 3) &lt;BaseDirectory&gt;\..\..\runtime\node.exe
        /// 三级全落空 → 写 shell.log（不静默）+ 记录候选串 → 最后才回退裸 "node"（PATH 兜底）。</summary>
        public static string NodeExe() {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var cands = new System.Collections.Generic.List<string>();
            try {
                string b = baseDir.TrimEnd('\\', '/');
                cands.Add(Path.Combine(b, "runtime", "node.exe"));
                string up1 = Path.GetFullPath(Path.Combine(b, ".."));
                cands.Add(Path.Combine(up1, "runtime", "node.exe"));
                string up2 = Path.GetFullPath(Path.Combine(up1, ".."));
                cands.Add(Path.Combine(up2, "runtime", "node.exe"));
            } catch { }
            foreach (string p in cands) {
                try { if (File.Exists(p)) return Path.GetFullPath(p); } catch { }
            }
            LastNodeExeCandidates = string.Join(" | ", cands);
            try {
                Program.LogInfo("NODEEXE: 随包 node.exe 未命中，候选=" + LastNodeExeCandidates
                    + " → 回退裸 \"node\"（依赖系统 PATH，可能启动失败)");
            } catch { }
            return "node";
        }

        /// <summary>最近一次 NodeExe() 的候选路径串（供失败面板/诊断展示）。</summary>
        public static string LastNodeExeCandidates;

        /// <summary>从 startDir 起（含自身）上溯最多 2 层找 portable.flag；找到返回其目录（=安装根/绿色目录）。</summary>
        static string FindPortableFlag(string startDir) {
            try {
                string d = Path.GetFullPath(startDir);
                for (int i = 0; i < 3; i++) {
                    if (File.Exists(Path.Combine(d, FLAG))) return d;
                    string up = Path.GetDirectoryName(d);
                    if (string.IsNullOrEmpty(up) || up == d) break;
                    d = up;
                }
            } catch { }
            return null;
        }

        /// <summary>可变数据根（config.json/data/workspace/projects/logs/webview2-data）。单例缓存。</summary>
        public static string Root() {
            if (_root != null) return _root;
            // ① env 优先（C# 注入 / 测试隔离 / 运维覆盖）
            string env = Environment.GetEnvironmentVariable("LEIZAI_DATA_DIR");
            if (!string.IsNullOrEmpty(env)) { _root = env; return _root; }
            // ② portable.flag（安装根 / 绿色目录；现役 <项目根> 走此分支，数据位置不变）
            string f = FindPortableFlag(CodeDir());
            if (f != null) { _root = f; return _root; }
            // ③ 用户自定义数据目录指针 %LOCALAPPDATA%\LeiZaiDataDir.txt（UI「更改数据目录」写入；跨重装保留）
            try {
                string lad0 = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (!string.IsNullOrEmpty(lad0)) {
                    string pf = Path.Combine(lad0, "LeiZaiDataDir.txt");
                    if (File.Exists(pf)) {
                        string custom = File.ReadAllText(pf).Trim();
                        if (!string.IsNullOrEmpty(custom)) { _root = Path.GetFullPath(custom); return _root; }
                    }
                }
            } catch { }
            // ④ %LOCALAPPDATA%\LeiZaiData（安装版默认）
            //   ⚠ 不可用 %LOCALAPPDATA%\LeiZai：那是 Velopack 的 {packId} 安装目录，卸载会整目录删除（数据丢失）。
            try {
                string lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (!string.IsNullOrEmpty(lad)) { _root = Path.Combine(lad, "LeiZaiData"); return _root; }
            } catch { }
            // ⑤ 兜底：exe 目录
            _root = CodeDir();
            return _root;
        }

        public static string ConfigPath() { return Path.Combine(Root(), "config.json"); }
        public static string CommonPath() { return Path.Combine(Root(), "config.common.json"); }
        public static string DataDir()    { return Path.Combine(Root(), "data"); }
        public static string Logs()       { return Path.Combine(Root(), "logs"); }
        public static string WebViewData(){ return Path.Combine(Root(), "webview2-data"); }

        /// <summary>首启播种（幂等）：仅当 数据根≠代码目录、无 .seeded 标记、且代码目录有旧数据时触发；
        /// 委托 node scripts/seed-data.mjs 执行（只 copy 不 move / 原子 rename / 失败不丢数据 / 可重跑）。</summary>
        public static void EnsureSeeded() {
            try {
                string root = Root();
                if (string.Equals(Path.GetFullPath(root), Path.GetFullPath(CodeDir()), StringComparison.OrdinalIgnoreCase)) return;
                MigrateLegacyIfNeeded(root);   // P2：旧数据根(%LOCALAPPDATA%\LeiZai) → 新根(%LOCALAPPDATA%\LeiZaiData)
                MigrateLyRootIfNeeded(root);   // P3：雷影根从安装目录(旧) → 数据根(新)，防升级/重装/卸载删雷影
                if (File.Exists(Path.Combine(root, ".seeded"))) return;
                string script = Path.Combine(CodeDir(), "scripts", "seed-data.mjs");
                if (!File.Exists(script)) return;
                var psi = new System.Diagnostics.ProcessStartInfo();
                psi.FileName = NodeExe();
                psi.Arguments = "\"" + script + "\" --from \"" + CodeDir() + "\" --to \"" + root + "\"";
                psi.WorkingDirectory = CodeDir();
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden;
                using (var p = System.Diagnostics.Process.Start(psi)) { p.WaitForExit(120000); }
            } catch { }
        }

        /// <summary>P3（2026-10-08）：把雷影根从安装目录（CodeDir()\雷影，Velopack 更新会替换 current 而删除）
        /// 迁到数据根（root\雷影）。仅当「新位置不存在 且 旧位置存在」时执行；**只 copy 不 move**（旧数据保留）。
        /// 注：若旧位置已被某次更新删除，则无法救回——出包说明附"升级前手工备份 &lt;安装目录&gt;\雷影"提示。</summary>
        static void MigrateLyRootIfNeeded(string root) {
            try {
                string src = Path.Combine(CodeDir(), "雷影");
                string dst = Path.Combine(root, "雷影");
                if (string.Equals(Path.GetFullPath(src), Path.GetFullPath(dst), StringComparison.OrdinalIgnoreCase)) return;
                if (!Directory.Exists(src)) return;      // 旧位置不存在 → 无需迁移
                if (Directory.Exists(dst)) return;       // 新位置已有 → 绝不覆盖
                CopyDir(src, dst);
            } catch { }
        }

        /// <summary>P2（2026-10-01）：把旧数据根（%LOCALAPPDATA%\LeiZai，落在 Velopack 安装目录内、
        /// 卸载会被整目录删除）迁移到新根（%LOCALAPPDATA%\LeiZaiData）。
        /// 仅在「新根无 config.json 且旧根有 config.json」时执行；**只 copy 不 move**（旧数据始终保留，失败可重跑）。</summary>
        static void MigrateLegacyIfNeeded(string root) {
            try {
                string lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrEmpty(lad)) return;
                string legacy = Path.Combine(lad, "LeiZai");
                if (string.Equals(Path.GetFullPath(legacy), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)) return;
                if (!File.Exists(Path.Combine(legacy, "config.json"))) return;   // 旧根无数据 → 无需迁移
                if (File.Exists(Path.Combine(root, "config.json"))) return;      // 新根已有 → 绝不覆盖
                foreach (string item in new[] { "config.json", "config.common.json", "data", "workspace", "projects", "logs" }) {
                    string s = Path.Combine(legacy, item), d = Path.Combine(root, item);
                    try {
                        if (File.Exists(s)) { Directory.CreateDirectory(root); File.Copy(s, d, false); }
                        else if (Directory.Exists(s)) CopyDir(s, d);
                    } catch { }
                }
            } catch { }
        }

        /// <summary>递归拷贝目录（best-effort，单项失败不中断）。</summary>
        static void CopyDir(string src, string dst) {
            Directory.CreateDirectory(dst);
            foreach (var f in Directory.GetFiles(src)) { try { File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), false); } catch { } }
            foreach (var sub in Directory.GetDirectories(src)) { try { CopyDir(sub, Path.Combine(dst, Path.GetFileName(sub))); } catch { } }
        }
    }
}
