'use strict';
// 示例插件：演示自我升级热加载通道。注册一个能返回当前时间的自定义工具。
module.exports = {
  tool: {
    name: 'ping_time',
    description: '【示例插件】返回当前本地时间，演示插件热加载通道（自我升级不中断对话）。',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const now = new Date();
      return `当前时间: ${now.toISOString()}（本地 ${now.toString()}）—— 这是通过插件热加载新增的示例工具，证明自我升级无需重启引擎即可生效。`;
    },
  },
};
