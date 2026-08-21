# TOOLS.md - OpenClaw 智能校园助手本地工具

以下工具均为 OpenClaw 能力演示适配器。数据只需支持完整演示和自动化测试，不继续向真实学校业务模型扩张。

## Agent 工具权限

学生 `campus` Agent 与管理员 `campus-admin` Agent 分开注册、分开工作区和会话。学生 Agent 只执行学生 Skill；管理员 Agent 只执行 `agents/campus-admin/skills/campus-auto-approval` 中声明的审批命令。

## 智能请假

- 技能：`skills/campus-leave/SKILL.md`
- 命令入口：`node .\skills\campus-leave\scripts\leave_manager.mts`（子命令 `create/list/cancel/verify-audit`，与旧 Python CLI 参数兼容）
- 实现位置：`campus-services/`（TypeScript，`node:sqlite`）
- 数据库：`data/campus-demo.sqlite3`（学生提交写入 `evaluating` 与 `leave_approval_jobs`；管理员 Agent 回写规则证据和最终状态）
- 审计证据：SQLite `audit_events` 哈希链（可用 `verify-audit` 校验；旧 `data/audit/leave.jsonl` 由迁移脚本作为链前缀导入并备份）
- 管理员 Agent Skill：`node .\campus-services\src\bin\approvalAgentCli.ts <next|process|status|fail>`
- 自动审批：全部启用的低风险规则通过即 `approved_auto`；任一规则未通过或 Agent 异常转 `manual_review`；永不自动驳回

## 智能选课

- 技能：`skills/campus-course/SKILL.md`
- 命令入口：`python .\skills\campus-course\scripts\course_manager.py`
- 课程与教师官方演示数据：`data/course-data.json`
- 待确认方案、提交记录与审计记录：`data/course-selection-state.json`
- 事务恢复日志：`data/course-selection-state-transaction.json`（正常提交完成后自动清理）
- 审计证据：`data/audit/course.jsonl`（哈希链，可用 `verify-audit` 校验）

## 校园知识问答

- 技能：`skills/campus-knowledge/SKILL.md`
- 命令入口：`python .\skills\campus-knowledge\scripts\knowledge_manager.py`
- 子命令：`search` / `get` / `list` / `validate` / `record-unanswered`
- 知识数据目录：`knowledge/`（按 `policies`、`services`、`courses`、`departments`、`faq` 分类，每个 JSON 文件可含单条或数组）
- 待补充问题记录：`data/knowledge-unanswered.json`
- 知识问答不写入业务记录，仅 `record-unanswered` 写入“待补充问题”。

当前实现均使用本地 Demo 存储。真实学校系统适配暂缓；后续优先将这些工具接入统一的 OpenClaw 能力注册、执行状态和运行追踪协议。

## 新 Skill 开发

- 模板：`skill-development/templates/campus-skill-template/`
- Manifest：每个已启用 Skill 必须包含 `capability.json`
- 新 Skill 默认使用 `campus-skill-input@1` / `campus-skill-output@1` JSON-stdio 契约
- 模板默认 `enabled=false`，复制、改名并通过项目校验后才可启用
