# 管理员 Agent 工具

管理员 Agent 只使用 `campus-auto-approval` Skill 声明的 CLI。学生端和外部
渠道均不能直接调用本 Agent。

- 服务实现：`..\..\campus-services\`
- 审批入口：`node ..\..\campus-services\src\bin\approvalAgentCli.ts`
- 数据库：与学生端共用 `data\campus-demo.sqlite3`
- 自动结果：`approved_auto` 或 `manual_review`
- 禁止结果：自动 `rejected_manual`
