// LeiZai2 · WebView2 postMessage 原生能力桥（T-B3）
// 协议：web → host：JSON {op, id, ...args}；host → web：window.chrome.webview.postMessage(JSON {id, ok, data|error})
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace LeiZai2 {
    public class Bridge {
        readonly MainForm _form;
        static string _lastOp = "";   // 诊断：记录最近一次 op，序列化失败时随日志输出
        public Bridge(MainForm form) { _form = form; }

        /// <summary>启动时向 Web 注入运行环境信息：env = {apiBase, version, platform, theme}</summary>
        public void InjectEnv(CoreWebView2 core) {
            try {
                var env = new Dictionary<string, object>();
                env["apiBase"] = "";                         // 同源：静态页与 /api 同端口，空串即可
                env["version"] = "A1-P0";
                env["platform"] = "webview2";
                env["port"] = Shell.Port();
                string json = Json.Dump(env);
                core.ExecuteScriptAsync("window.__LEIZAI_ENV__ = " + json + ";");
            } catch (Exception ex) { Program.LogInfo("BRIDGE env 注入失败: " + ex.Message); }
        }

        /// <summary>处理来自 Web 的 postMessage。</summary>
        public void OnWebMessage(string raw) {
            long id = 0;
            try {
                Dictionary<string, object> msg = Json.Parse(raw);
                if (msg == null) return;
                object oid; if (msg.TryGetValue("id", out oid) && oid != null) long.TryParse(Convert.ToString(oid), out id);
                string op = J.GetString(msg, "op");
                _lastOp = op;
                switch (op) {
                    case "openPath": OpOpenPath(msg, id); return;
                    case "openFile": OpOpenFile(msg, id); return;
                    case "revealPath": OpRevealPath(msg, id); return;
                    case "openExternal": OpOpenExternal(msg, id); return;
                    case "readFile": OpReadFile(msg, id); return;
                    case "pickImage": OpPickImage(msg, id); return;
                    case "notify": OpNotify(msg, id); return;
                    case "window": OpWindow(msg, id); return;
                    case "backend": OpBackend(msg, id); return;
                    case "devtools": _form.OpenDevTools(); Reply(id, true, null, null); return;
                    case "splashPainted": _form.HideNativeSplash("网页已绘制(信号)"); Reply(id, true, null, null); return;   // v6.51①：网页 splash 首帧信号
                    case "splashFrame": _form.OnSplashFrame(msg); return;   // v6.55：本地 splash 视频首帧埋点（无需 reply）
                    case "splashSkip": _form.OnSplashSkip(); return;        // v6.55：本地 splash 用户跳过
                    case "splashError": _form.OnSplashError(msg); return;   // v6.55：本地 splash 视频失败（静默）
                    case "splashAudio": _form.OnSplashAudio(msg); return;   // v6.56：本地 splash 音频状态埋点
                    case "splashStop": _form.OnSplashStop(); return;              // v6.57：splash 层停声确认
                    case "uiPainted": _form.OnUiPainted(msg); return;       // v6.55：主界面首帧 → 撤 splash 层
                    case "checkUpdate": OpCheckUpdate(id); return;          // v0.1.16：手动检查更新（合并自 build 仓）
                    case "updateStatus": OpUpdateStatus(id); return;        // v0.1.16：更新状态查询（左栏「有新版本」）
                    default: Reply(id, false, null, "未知 op: " + op); return;
                }
            } catch (Exception ex) {
                Reply(id, false, null, ex.Message);
            }
        }

        /// <summary>手动检查更新：交给 shell 的 UpdateNotice（有/无更新均由客户端弹窗反馈）。合并自 build 仓。</summary>
        void OpCheckUpdate(long id) {
            try { UpdateNotice.CheckNow(_form); Reply(id, true, null, null); }
            catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        /// <summary>查询更新状态（供左栏版本号显示「有新版本」）。合并自 build 仓。</summary>
        void OpUpdateStatus(long id) {
            try {
                var d = new Dictionary<string, object>();
                d["available"] = UpdateNotice.HasUpdate;
                d["latest"] = UpdateNotice.LatestVersion;
                Reply(id, true, d, null);
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        void OpOpenPath(Dictionary<string, object> msg, long id) {
            string path = J.GetString(msg, "path");
            if (string.IsNullOrEmpty(path)) { Reply(id, false, null, "缺 path"); return; }
            try {
                if (Directory.Exists(path)) Process.Start("explorer.exe", "\"" + path + "\"");
                else if (File.Exists(path)) Process.Start("explorer.exe", "/select,\"" + path + "\"");
                else { Reply(id, false, null, "路径不存在: " + path); return; }
                Reply(id, true, null, null);
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        /// <summary>用**系统默认程序打开文件**（ShellExecute）。与 openPath 区分：openPath=目录打开/文件定位，本 op 专用于"打开文件本身"。</summary>
        void OpOpenFile(Dictionary<string, object> msg, long id) {
            string path = J.GetString(msg, "path");
            if (string.IsNullOrEmpty(path)) { Reply(id, false, null, "缺 path"); return; }
            try {
                if (Directory.Exists(path)) { Reply(id, false, null, "不是文件（目录）: " + path); return; }
                if (!File.Exists(path)) { Reply(id, false, null, "文件不存在: " + path); return; }
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
                Reply(id, true, null, null);
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        /// <summary>在资源管理器中**定位**路径（explorer /select）：文件→父目录中选中该文件；目录→父目录中选中该目录。</summary>
        void OpRevealPath(Dictionary<string, object> msg, long id) {
            string path = J.GetString(msg, "path");
            if (string.IsNullOrEmpty(path)) { Reply(id, false, null, "缺 path"); return; }
            try {
                if (!Directory.Exists(path) && !File.Exists(path)) { Reply(id, false, null, "路径不存在: " + path); return; }
                Process.Start("explorer.exe", "/select,\"" + path + "\"");
                Reply(id, true, null, null);
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        /// <summary>读取本地文件 → {path,name,ext,size,mime,dataUrl}。超过 maxBytes（默认 8MB）不返回 dataUrl（仅 meta），避免大文件阻塞 postMessage。</summary>
        void OpReadFile(Dictionary<string, object> msg, long id) {
            string path = J.GetString(msg, "path");
            if (string.IsNullOrEmpty(path)) { Reply(id, false, null, "缺 path"); return; }
            try {
                if (Directory.Exists(path)) { Reply(id, false, null, "不是文件（目录）: " + path); return; }
                if (!File.Exists(path)) { Reply(id, false, null, "文件不存在: " + path); return; }
                var fi = new FileInfo(path);
                long maxBytes = 8L * 1024 * 1024;
                object mb; if (msg.TryGetValue("maxBytes", out mb) && mb != null) {
                    long v; if (long.TryParse(Convert.ToString(mb), out v) && v > 0) maxBytes = v;
                }
                if (maxBytes > 48L * 1024 * 1024) maxBytes = 48L * 1024 * 1024;   // 硬上限：防超大文件撑爆 postMessage（留 64MB MaxJsonLength 余量）
                string ext = (fi.Extension ?? "").ToLowerInvariant();
                var data = new Dictionary<string, object>();
                data["path"] = path;
                data["name"] = fi.Name;
                data["ext"] = ext;
                data["size"] = fi.Length;
                data["mime"] = MimeOf(ext);
                if (fi.Length > maxBytes) {
                    data["tooLarge"] = true;
                    data["maxBytes"] = maxBytes;
                } else {
                    byte[] bytes = File.ReadAllBytes(path);
                    data["dataUrl"] = "data:" + MimeOf(ext) + ";base64," + Convert.ToBase64String(bytes);
                }
                Reply(id, true, data, null);
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        void OpOpenExternal(Dictionary<string, object> msg, long id) {
            string url = J.GetString(msg, "url");
            if (string.IsNullOrEmpty(url)) { Reply(id, false, null, "缺 url"); return; }
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); Reply(id, true, null, null); }
            catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        void OpPickImage(Dictionary<string, object> msg, long id) {
            try {
                using (var dlg = new OpenFileDialog()) {
                    dlg.Title = "选择图片";
                    dlg.Filter = "图片|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp|所有文件|*.*";
                    dlg.Multiselect = false;
                    if (dlg.ShowDialog(_form) != DialogResult.OK) { Reply(id, true, null, null); return; }
                    string p = dlg.FileName;
                    var data = new Dictionary<string, object>();
                    data["path"] = p;
                    data["name"] = Path.GetFileName(p);
                    data["ext"] = Path.GetExtension(p).ToLowerInvariant();
                    try {
                        byte[] bytes = File.ReadAllBytes(p);
                        if (bytes.Length <= 6 * 1024 * 1024) {
                            data["mime"] = MimeOf(data["ext"] as string);
                            data["dataUrl"] = "data:" + data["mime"] + ";base64," + Convert.ToBase64String(bytes);
                        }
                    } catch { }
                    Reply(id, true, data, null);
                }
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        void OpNotify(Dictionary<string, object> msg, long id) {
            try {
                string title = J.GetString(msg, "title"); if (string.IsNullOrEmpty(title)) title = "⚡ 雷仔";
                string body = J.GetString(msg, "body"); if (body == null) body = "";
                _form.ShowTrayBalloon(title, body);
                Reply(id, true, null, null);
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        void OpWindow(Dictionary<string, object> msg, long id) {
            try {
                string action = J.GetString(msg, "action");
                _form.RunWindowAction(action);
                Reply(id, true, null, null);
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        void OpBackend(Dictionary<string, object> msg, long id) {
            try {
                string action = J.GetString(msg, "action");
                var data = new Dictionary<string, object>();
                if (action == "status") {
                    data["ok"] = Shell.BackendHealthOk();
                    data["port"] = Shell.Port();
                    data["pid"] = Shell.FindPidOnPort(Shell.Port());
                } else if (action == "start") {
                    Process np; bool sb;
                    data["ok"] = Shell.EnsureBackend(out np, out sb);
                    data["started"] = sb;
                } else if (action == "stop") {
                    int pid = Shell.FindPidOnPort(Shell.Port());
                    if (pid > 0) { try { Process.GetProcessById(pid).Kill(); } catch { } }
                    data["ok"] = true; data["stopped"] = pid;
                } else { Reply(id, false, null, "未知 backend action: " + action); return; }
                Reply(id, true, data, null);
            } catch (Exception ex) { Reply(id, false, null, ex.Message); }
        }

        void Reply(long id, bool ok, Dictionary<string, object> data, string error) {
            var resp = new Dictionary<string, object>();
            resp["id"] = id;
            resp["ok"] = ok;
            if (data != null) resp["data"] = data;
            if (error != null) resp["error"] = error;
            string json = null;
            try { json = Json.Dump(resp); }
            catch (Exception ex) {
                // 序列化超限（如 dataUrl 过大）：降级剔除 dataUrl 后重试，仍给前端一个应答，
                // 避免前端 30s 超时并反复重试（即"每 30s 一次 BRIDGE reply 失败"的来源）。
                try {
                    var slim = new Dictionary<string, object>(resp);
                    var d = slim.ContainsKey("data") ? slim["data"] as Dictionary<string, object> : null;
                    if (d != null) {
                        var d2 = new Dictionary<string, object>(d);
                        d2.Remove("dataUrl");
                        d2["tooLarge"] = true;
                        slim["data"] = d2;
                    }
                    slim["ok"] = false;
                    slim["error"] = "reply too large: " + ex.Message;
                    json = Json.Dump(slim);
                } catch { }
                Program.LogInfo("BRIDGE reply 失败(op=" + _lastOp + "): " + ex.Message + (json != null ? " → 已降级发送(仅 meta)" : ""));
            }
            if (json != null) { try { _form.PostToWeb(json); } catch (Exception ex) { Program.LogInfo("PostToWeb 失败: " + ex.Message); } }
        }

        static string MimeOf(string ext) {
            switch (ext) {
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".webp": return "image/webp";
                case ".bmp": return "image/bmp";
                case ".svg": return "image/svg+xml";
                case ".ico": return "image/x-icon";
                case ".mp4": case ".m4v": return "video/mp4";
                case ".webm": return "video/webm";
                case ".mov": return "video/quicktime";
                case ".mp3": return "audio/mpeg";
                case ".wav": return "audio/wav";
                case ".ogg": return "audio/ogg";
                case ".pdf": return "application/pdf";
                case ".json": return "application/json";
                case ".md": case ".txt": case ".log": case ".js": case ".css": case ".html": case ".cs": case ".py": return "text/plain; charset=utf-8";
                default: return "application/octet-stream";
            }
        }
    }
}
