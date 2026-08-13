---
name: campus-skill-template
description: OpenClaw 智能校园助手的新能力开发模板。复制并改名后，用于实现需要能力注册、JSON-stdio 工具调用、明确确认、幂等、审计、状态机和安全结果卡片的校园 Demo Skill；本模板本身不作为用户能力启用。
---

# 校园 Skill 模板

## 开发流程

1. 复制整个目录到 `workspace-campus/skills/<skill-name>`。
2. 将目录、`SKILL.md` 的 `name`、`capability.json` 的 `skill` 保持一致，全部使用小写连字符。
3. 在 `capability.json` 中设置唯一的 `campus.<capability-id>`、路由、角色、operations 和允许的卡片类型。
4. 按 `references/contract.md` 实现 JSON-stdio 输入输出；每次调用只读取一个 JSON 对象、只输出一个 JSON 对象。
5. 对有副作用的 operation 要求 `authorization.confirmed=true` 和幂等键。未经确认不得执行写入。
6. 只返回协议白名单卡片；不得输出 HTML、脚本、任意 URL、工具命令或自定义前端组件。
7. 将 `enabled` 改为 `true` 前，运行项目的 `npm run validate:skills` 和 `npm test`。

## 执行约束

- 只信任信封中的 `actor`、`session`、`authorization` 和 `arguments`。
- 不从普通参数覆盖受信身份。
- 工具失败时返回 `ok=false`，不得声称业务已完成。
- `message` 只用于用户可读说明；结构化状态、证据和卡片必须使用对应字段。
- 不写长期记忆，不读取其他 Agent 工作区，不访问未声明的外部工具。

## 模板操作

- `preview`：只读，返回待确认预览。
- `execute`：示范写操作，必须明确确认并提供幂等键。

模板入口为 `scripts/skill.py`。实现真实 Skill 时替换其中的演示逻辑，保留信封解析和错误边界。
