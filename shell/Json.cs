// LeiZai2 · JSON 助手（自 app/Models.cs 移植，命名空间改为 LeiZai2）
using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace LeiZai2 {
    public static class J {
        public static string GetString(Dictionary<string, object> d, string k) {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return null;
            return v.ToString();
        }
        public static long GetLong(Dictionary<string, object> d, string k) {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return 0;
            try { return Convert.ToInt64(v); } catch { return 0; }
        }
        public static bool GetBool(Dictionary<string, object> d, string k) {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return false;
            try { return Convert.ToBoolean(v); } catch { return false; }
        }
    }

    public static class Json {
        static JavaScriptSerializer _s = new JavaScriptSerializer();
        static readonly object _lock = new object();
        // 默认 MaxJsonLength=2MB 太小：本地媒体经 readFile 回传 dataUrl(≤24MB 文件 → base64 ≈32MB) 时
        // 序列化会抛「字符串的长度超过了 maxJsonLength」→ reply 被丢弃（前端 30s 超时/播放器 0:00）。
        // 提到 64MB 以覆盖前端上限（MAX_MEDIA=24MB）；超大文件仍由 OpReadFile 的 maxBytes 门控只回 meta。
        static Json() {
            _s.MaxJsonLength = 64 * 1024 * 1024;
            _s.RecursionLimit = 200;
        }
        public static Dictionary<string, object> Parse(string s) {
            lock (_lock) { return _s.Deserialize<Dictionary<string, object>>(s); }
        }
        public static List<object> ParseArray(string s) {
            lock (_lock) { return _s.Deserialize<List<object>>(s); }
        }
        public static string Dump(object o) {
            lock (_lock) { return _s.Serialize(o); }
        }
    }
}
