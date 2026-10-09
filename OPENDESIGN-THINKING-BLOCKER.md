# 保留思考的修复：当前阻塞及独立复现

验收要求是 **保留思考，自动将旧配置转换成 adaptive + effort**。关闭思考、删除所有 reasoning 参数，或者只得到 HTTP 200，都不能算完成此要求。

## 2026-10-09 的独立实测

直接请求官方 `https://amr-link.open-design.ai`，不经过任何 Magpie、第三方 provider 插件或本仓库中间件：

| 接口 | 发送的思考设置 | 结果 |
| --- | --- | --- |
| `/v1/messages` | `thinking: {"type":"adaptive","display":"summarized"}`，`output_config.effort: low` | HTTP 400，仍报 `thinking.type.enabled` 不受支持 |
| `/v1/chat/completions` | `reasoning_effort: low` | HTTP 400，同样错误 |
| `/v1/responses` | `reasoning: {"effort":"low","summary":"auto"}` | HTTP 400，同样错误 |

三种请求均使用 `stream: true`、模型目录实际返回的 `claude-haiku-5.5` 和 4096 输出上限。原生 Messages 请求体没有 `enabled`，没有 `budget_tokens`。该错误因此可以在完全绕过 Magpie 时复现。

另一个诊断结果：Chat 接口中只添加 `thinking` / `output_config` 或 `provider_options.anthropic`，不发送 OpenAI reasoning 控制，可以返回 200，但没有观察到思考内容；不能把这些未验证是否生效的扩展参数当作保留思考的修复。

这些结果定位了阻塞发生在 **OpenDesign 的官方接口路径或其下游**。目前没有该服务端的源码和请求追踪，不能进一步声称已经找到其内部哪行代码生成了 `enabled`。

## 独立复现脚本

```sh
node scripts/test-thinking-live.mjs --live
```

或者 `npm run test:thinking:live`。它仅在显式运行时读取本机 `~/.amr/config.json` 的 prod runtime key，向官方接口发送三个短测试请求；不修改账号、模型、Magpie 配置。key 不写入文件或输出。

脚本用 high effort 和一个需要推理的问题复核。验收同时要求 HTTP 成功及思考事件/思考 token 的证据；没有证据则不算通过。adaptive 可能选择不思考，因此 HTTP 成功但无思考证据只能视为未证实，不等价于服务故障。

## 完成修复所需的条件

需要在实际生成 Anthropic 出站请求的 OpenDesign 服务端修正模型适配：

1. 识别目录里的 `claude-haiku-5.5`，对应支持 adaptive thinking 的 Haiku 5.5。
2. 将客户端 effort 传为 `output_config.effort`，思考开启时发送 `thinking.type: adaptive`，不生成 `enabled` / `budget_tokens`。
3. 让原生 Messages 的 adaptive 配置保留到最终出站请求。
4. 用上述独立脚本及真实思考响应验证，再验证 Magpie 三协议转换路径。

若已有可保留原生参数的官方接口或已修复的服务端版本，需要它的准确地址/版本信息才能验证并接入插件。本仓库的入口中间件没有出站 hook，不能修改它无法接触的服务端请求。

## 官方规范

- [Haiku 5.5 迁移说明](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- [Magpie 中间件接口](https://usemagpie.ai/docs/plugins#middleware)

此文件是可提交给 OpenDesign 维护者的复现说明；尚未向维护者发送或发布 issue。
