# OpenClaw 智能校园 Skill 开发约定

## 目标

新增校园 Demo 能力时，不再修改能力注册数组或重新实现权限、确认、幂等、状态、Trace 和卡片安全逻辑。每个 Skill 自带能力清单，通过统一 JSON-stdio 契约接入。

## 最短接入流程

1. 复制模板目录：

   ```text
   openclaw-workspace/skill-development/templates/campus-skill-template
   ```

   到：

   ```text
   openclaw-workspace/skills/<新-skill-名称>
   ```

2. 同步修改：

   - 目录名；
   - `SKILL.md` frontmatter 的 `name`；
   - `capability.json` 的 `id`、`skill`、版本、路由、权限、operations 和入口；
   - `scripts/skill.py` 的业务逻辑。

3. 保持 `enabled=false` 开发和测试；通过全部校验后再改为 `true`。

4. 运行：

   ```powershell
   npm run validate:skills
   npm test
   npm run build
   ```

启用后，注册表会自动扫描 `workspace-campus/skills/*/capability.json`，无需修改 TypeScript 数组。

## Manifest 硬约束

- 能力 ID 使用 `campus.<kebab-case>`；
- Skill 名称和目录名一致；
- 入口必须位于当前 Skill 目录中；
- 写能力必须设置 `explicit-before-write`；
- 有副作用的 operation 必须要求明确确认；
- 幂等写操作执行时必须提供幂等键；
- 只声明实际需要的角色、卡片类型和 operations；
- `displayOrder` 用于稳定门户中的能力顺序；
- 编排 Skill 使用 `orchestration.dependencies` 声明已启用的子能力，目前只允许 `sequential`；
- 当前正式运行时仅允许受控 Python 入口。

## JSON-stdio 信封

输入契约：`campus-skill-input@1`。运行时提供：

- 调用编号、请求编号、能力和 operation；
- 脱敏 actor subject 与验证后的角色；
- 会话、当前时间和明确确认状态；
- 结构化 arguments；
- 写操作幂等键。

输出契约：`campus-skill-output@1`。Skill 必须返回：

- 与输入一致的调用编号和 operation；
- `ok`、结构化状态、用户可读消息和数据；
- 可选的白名单卡片与证据引用；
- 失败时的错误码、说明和是否可重试。

标准输入最大 32KB，标准输出最大 64KB。标准输出只能包含一个 JSON 对象，诊断日志写入标准错误。

## 安全执行顺序

```text
发现 manifest
→ 校验路径、角色、operation、确认与幂等要求
→ 启动受控 Skill 进程
→ 发送 JSON 输入信封
→ 校验 JSON 输出信封和允许的卡片类型
→ 写入状态、Trace、审计与幂等结果
→ 返回门户
```

不得让模型直接指定脚本路径、操作系统命令、完整身份、任意卡片或外部 URL。

## 编排 Skill 约定

编排能力本身应保持只读：负责调用子能力、组合预览、列出缺失参数和进入等待确认，不直接绕过子能力执行写入。确认后应创建对应写能力的独立执行记录，并沿用写能力的权限、幂等、审计和失败状态。

首个参考实现位于：

```text
openclaw-workspace/skills/campus-leave-impact
```

其 `capability.json` 声明依赖 `campus.course` 与 `campus.leave`，输出 `orchestration-summary` 卡片。

## 兼容现有 Skill

请假、选课和知识问答目前使用 `legacy-cli-adapter`，但已经拥有同一格式的 `capability.json` 并通过注册、权限和 operation 校验。新增 Skill 默认使用 `json-stdio`；后续再逐步迁移旧脚本，不阻塞当前 Demo。
