# -*- coding: utf-8 -*-
# 雷仔 Python REPL 宿主（RLM 内核的持久解释器）
# 协议：stdin 读入一行 JSON {"id":N,"code":"..."}；执行后 stdout 写一行 @LEIZAI@ + JSON
#      {"id":N,"ok":bool,"stdout":str,"stderr":str,"error":str}
# 命名空间跨请求持久：变量/导入/状态在多次调用之间保留，等价于一个永久 REPL。
import sys
import json
import io
import pickle
import traceback
import importlib

HOST_FILE = __file__  # 用于把宿主帧从 traceback 中抹掉（避免内部路径噪音）

NS = {"__name__": "__leizai_repl__", "__builtins__": __builtins__}

# 常用库直接注入命名空间（失败不阻塞，用户代码仍可自行 import）
for _name in ("os", "sys", "json", "re", "math", "time", "datetime", "subprocess", "shutil", "pathlib", "itertools", "collections", "functools", "random", "hashlib", "urllib", "http", "csv", "sqlite3"):
    try:
        __import__(_name)
        NS[_name] = sys.modules[_name]
    except Exception:
        pass


def _emit(resp):
    # 用 UTF-8 字节写 stdout：避免 Windows 控制台 GBK 编码导致的
    # UnicodeEncodeError（如技能输出含 ✅/emoji 时崩溃）与乱码。
    line = "@LEIZAI@" + json.dumps(resp, ensure_ascii=False)
    sys.stdout.buffer.write((line + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def _exec(code):
    out, err = io.StringIO(), io.StringIO()
    old = (sys.stdout, sys.stderr)
    sys.stdout, sys.stderr = out, err
    ok = True
    err_text = ""
    try:
        exec(compile(code, "<leizai-repl>", "exec"), NS)
    except BaseException:
        lines = traceback.format_exc().splitlines()
        # 抹掉宿主帧与内部路径，只留用户代码相关错误信息
        err_text = "\n".join(
            l for l in lines
            if "repl_host.py" not in l and HOST_FILE not in l
        )
        ok = False
    finally:
        sys.stdout, sys.stderr = old
    return ok, out.getvalue(), err.getvalue(), err_text


def _snapshot(req):
    """把命名空间里可 pickle 的变量 + 已注入的模块名落到一个文件（跨重启恢复用）。"""
    path = req.get("path", "")
    data, modules, skipped = {}, {}, []
    for k, v in list(NS.items()):
        if k in ("__name__", "__builtins__"):
            continue
        if isinstance(v, type(sys)):  # 模块对象：记录名字，恢复时重新 import
            modules[k] = getattr(v, "__name__", "")
            continue
        try:
            pickle.dumps(v)
            data[k] = v
        except Exception:
            skipped.append(k)
    payload = {"vars": data, "modules": modules, "skipped": skipped[:20]}
    try:
        with open(path, "wb") as f:
            pickle.dump(payload, f)
        _emit({"id": req.get("id", 0), "ok": True, "stdout": "", "stderr": "",
               "error": "", "snapshot": len(data), "modules": len(modules), "skipped": skipped[:20]})
    except Exception as e:
        _emit({"id": req.get("id", 0), "ok": False, "stdout": "", "stderr": "", "error": "快照失败: " + str(e)})


def _restore(req):
    """从快照恢复命名空间（可 pickle 的变量 + 重新 import 模块）。"""
    path = req.get("path", "")
    try:
        with open(path, "rb") as f:
            payload = pickle.load(f)
    except Exception as e:
        _emit({"id": req.get("id", 0), "ok": False, "stdout": "", "stderr": "", "error": "恢复失败: " + str(e)})
        return
    restored = 0
    for name, mname in (payload.get("modules") or {}).items():
        try:
            NS[name] = importlib.import_module(mname)
        except Exception:
            pass
    for k, v in (payload.get("vars") or {}).items():
        NS[k] = v
        restored += 1
    _emit({"id": req.get("id", 0), "ok": True, "stdout": "", "stderr": "", "error": "", "restored": restored})


while True:
    line = sys.stdin.buffer.readline()
    if not line:
        break
    try:
        req = json.loads(line.decode("utf-8", "replace"))
    except Exception:
        continue
    if not isinstance(req, dict):
        continue
    cmd = req.get("cmd")
    if cmd == "snapshot":
        _snapshot(req)
        continue
    if cmd == "restore":
        _restore(req)
        continue
    code = req.get("code", "")
    ok, so, se, err = _exec(code)
    _emit({"id": req.get("id", 0), "ok": ok, "stdout": so, "stderr": se, "error": err})
