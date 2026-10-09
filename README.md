# Magpie Haiku 5.5 Thinking

为 Claude Haiku 5.5 修正思考参数的 Magpie **网关中间件插件**。零依赖，无需构建，支持直接从 GitHub 安装。只匹配 Haiku 5.5，包括 OpenDesign 实际使用的 `claude-haiku-5.5`、标准名称 `claude-haiku-5-5` 以及带 provider 前缀的名称。

**当前尚未完成 OpenDesign 的“保留思考、自动转换”修复。** 入口规范化已实现，但独立直连 OpenDesign 的三种接口开启思考仍返回 400；关闭思考的兼容测试不能作为此目标的验收。详见 [独立复现及阻塞说明](./OPENDESIGN-THINKING-BLOCKER.md)。

## 你的 OpenDesign 报错：安装方法

```text
"thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

**安装在 OpenDesign 所在的远端 Magpie。** 如果错误前面有 `Remote magpie:`，只安装在客户端不能保证远端转换后的参数正确。

```sh
magpie plugin add github:ezdemo/magpie-haiku55-thinking
```

2026-10-09 的实测发现：OpenDesign 的 `claude-haiku-5.5` 接口即使收到原生 `thinking: {"type":"adaptive"}` 和 `output_config.effort`，仍可能返回相同的 `enabled` 错误；Chat 的 `reasoning_effort` 还出现了 502。因此，本插件提供两种模式：

| 模式 | 用途 | 限制 |
| --- | --- | --- |
| `adaptive`（默认） | 按 Anthropic 规范修正入口参数，保留思考强度选择 | 无法修复 OpenDesign 服务端再次生成 `enabled` 的行为 |
| `disabled` | OpenDesign 当前可用的临时兼容模式；移除 OpenAI 思考控制，原生请求显式关闭思考 | **不提供可调思考强度**；省略参数时，最终模型是否思考取决于上游默认行为 |

**仅在愿意暂时放弃思考控制时，可启用兼容模式；它不满足保留思考的要求：**

```sh
magpie plugin options magpie-haiku55-thinking '{"mode":"disabled"}'
```

如果终端对 JSON 引号的处理不同，也可以打开远端 Magpie 的「Plugins → Installed → 本插件 → Options」，保存：

```json
{"mode":"disabled"}
```

这个模式已通过真实 Magpie v0.1.1137 的协议转换测试。2026-10-09 使用同一份打包中间件，经 Anthropic Messages、Chat Completions、Responses 三种入口调用真实 OpenDesign Chat 上游，**全部返回 HTTP 200 和可见回复**，且上游不再收到触发旧转换的 `reasoning_effort`。完整验证结果见 [VALIDATION.md](./VALIDATION.md)。

待 OpenDesign 修复服务端转换后，恢复标准模式：

```sh
magpie plugin options magpie-haiku55-thinking '{"mode":"adaptive"}'
```

## 标准 adaptive 模式

Anthropic 请求修正示例：

```json
{
  "model": "opendesign/claude-haiku-5.5",
  "thinking": {"type":"enabled", "budget_tokens":16000}
}
```

变为：

```json
{
  "model": "opendesign/claude-haiku-5.5",
  "thinking": {"type":"adaptive"},
  "output_config": {"effort":"medium"}
}
```

- 支持 `low`、`medium`、`high`、`xhigh`、`max`，默认 `medium`。
- 将客户端的 `minimal` 映射为 `low`，`ultra` 映射为 `max`。这是兼容策略，不是 Anthropic 官方强度名称。
- 保留显式关闭思考的请求；`disabled` 配合 `xhigh/max` 时降到允许的 `high`。
- 删除旧的 `thinking.budget_tokens`。固定 token 预算与 effort 没有精确对应关系，不根据预算猜测强度。
- 默认移除 Haiku 5.5 不支持的 `temperature`、`top_p`、`top_k`。
- 不改模型路由、`max_tokens`、工具、消息历史、签名、流式事件或响应。不会记录请求内容或读取登录凭据。

中间件拿到的是**客户端协议的请求**。Anthropic 使用 `output_config.effort`，Chat 使用 `reasoning_effort`，Responses 使用 `reasoning.effort`。Chat 另外带上原生 `thinking` / `output_config` 扩展，以兼容支持透传的 relay。

**协议转换限制：** Magpie 的 Responses → Chat 转换会丢弃额外的原生 `thinking` / `output_config` 字段。纯入口中间件不能在转换后拦截或修正供应商请求；不要把入口单元测试通过当作 OpenDesign 的 adaptive 思考已恢复。`disabled` 模式会删除 Responses 的整个 `reasoning` 对象，包括摘要设置，因为空对象也可能触发 Magpie 再生成思考配置。OpenDesign 的完整 adaptive 支持仍需要其服务端正确处理 Haiku 5.5。

## Options

无需保存 Options 即可使用默认值；`package.json` 的建议值并不会自动成为运行时配置。

```json
{
  "mode": "adaptive",
  "defaultEffort": "medium",
  "removeSampling": true,
  "models": []
}
```

| 字段 | 说明 |
| --- | --- |
| `mode` | `adaptive` 或 `disabled` |
| `effort` | 可选，强制覆盖客户端强度；支持五个原生档位，以及 `minimal` / `ultra` / `none` / `off` |
| `defaultEffort` | 客户端未指定有效强度时的默认值；默认 `medium`，不接受关闭值 |
| `removeSampling` | 默认 `true`；设为 `false` 保留采样字段 |
| `models` | 额外匹配的**完整模型 ID**；用于明确指向 Haiku 5.5 的自定义别名 |

优先级：`mode: disabled` 强制临时兼容策略；否则 `effort` 配置 → 客户端本协议的 effort → 兼容字段中的 effort → `defaultEffort`。显式 `thinking.type: disabled` 保持关闭。非法插件 Options 会返回明确的 400。

通过自动路由组选择模型时，中间件只看得到请求中的组名，无法预知最终选中的模型。不要把包含其他模型的路由组加入 `models`。配合 model-map 使用时，把本插件放在模型重命名中间件之后。

## 本地开发与测试

```sh
npm run check
npm test
npm pack --dry-run
```

没有需要安装的依赖。37 项测试覆盖模型匹配、五档强度、关闭值、配置覆盖、结构化输出、工具调用、签名、幂等性以及无关模型保持不变。

用真实 Magpie CLI 测试 moejs 加载、流式返回、热更新及协议转换；测试创建独立的 `XDG_CONFIG_HOME` / `XDG_CACHE_HOME`，使用本地模拟服务和假 key，不修改日常 Magpie 配置：

```powershell
$env:MAGPIE_BIN = 'C:\path\to\magpie-cli.exe'
npm run test:gateway
```

可选的真实 OpenDesign 验证（会发送三个很短的请求，使用少量额度）：

```powershell
node scripts/test-gateway.mjs --live
```

仅显式传入 `--live` 才读取本机 `~/.amr/config.json` 的 `profiles.prod.runtimeKey`。key 只在测试进程内存中用于调用官方 `https://amr-link.open-design.ai`，不进入测试 Magpie 的配置、参数或日志。真实测试验证的是 **disabled 临时兼容模式**，并不声称 adaptive 的上游问题已经修复。

## 参考

- [Magpie 中间件文档](https://usemagpie.ai/docs/zh/plugins#middleware)
- [Anthropic Haiku 5.5 迁移说明](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- [Anthropic 思考配置故障排查](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)

MIT License。非官方社区插件。
