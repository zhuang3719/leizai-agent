# 雷仔 · 插件（自定义工具扩展）

放在本目录的每个 `*.js` 文件会被自动加载为一个可被模型调用**自定义工具**，追加在工具表末尾（内置工具前缀保持稳定，符合缓存纪律）。

## 写法

```js
// src/plugins/my-tool.js
module.exports = {
  tool: {
    name: 'my_tool',
    description: '一句话说明这个工具做什么',
    parameters: { type: 'object', properties: { /* ... */ }, required: [] },
    async execute(args, ctx) {
      // args = 模型传入的参数对象；ctx = { workdir, cfg, sessionId }
      const runtime = require('../runtime');
      return '工具结果字符串';
    },
  },
};
```

- **name**：全小写下划线，唯一，不能与内置工具冲突。
- **parameters**：OpenAI 工具 schema（可选，缺省为无参数）。
- **execute(args, ctx)**：返回字符串即工具结果；抛错会被捕获为 `[工具错误] ...`。

## 生效

- 在 `src/plugins/` 里放好 `*.js` 后，**重启后端**即可加载（也可由运行时调用 `tools.reloadPlugins()` 热加载）。
- 工具名与描述会进入系统提示词的稳定前缀 → 一旦新增/变更插件，前缀变化一次，之后继续命中缓存。
- 加载失败的插件会打印 `[plugin] <文件> 加载失败: <原因>` 并跳过，不影响其它工具。

## 注意

- 插件工具与内置工具同权限（fullAccess 决定文件/命令边界）；请像内置工具一样遵守安全约束。
- 若要移除某插件，删除对应 `*.js` 后调用 `reloadPlugins()` 或重启。
