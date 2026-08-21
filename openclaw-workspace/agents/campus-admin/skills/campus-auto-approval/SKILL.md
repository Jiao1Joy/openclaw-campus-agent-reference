---
name: campus-auto-approval
description: 管理员数据库检测到新请假申请后使用。领取指定审批任务，运行确定性九条规则，将申请自动批准或转入人工复核；永不自动驳回。
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "bins": ["node"] },
      },
  }
---

# 管理员自动批复

## 处理指定申请

服务端消息会提供唯一申请编号。只对这个编号运行：

```powershell
node ..\..\campus-services\src\bin\approvalAgentCli.ts process --request-id "申请编号"
```

工具是唯一审批决定来源。不得根据自然语言自行判断是否批准，不得更改工具返回
的状态。成功后转述：申请编号、`statusLabel`、`decisionSummary`、规则版本和未通过
规则。

## 检测待处理任务

管理员询问新申请或服务端要求扫描时运行：

```powershell
node ..\..\campus-services\src\bin\approvalAgentCli.ts next --limit 10
```

对返回的每个 `leaveRequestId` 逐一执行 `process`，最多处理 10 条，不并行处理同一
申请。任务和数据库写入均有唯一约束，重复执行会幂等返回原结果。

## 查询任务状态

```powershell
node ..\..\campus-services\src\bin\approvalAgentCli.ts status --request-id "申请编号"
```

## 强制边界

- 只可能产生 `approved_auto` 或 `manual_review`；
- 任何异常都必须保护性转人工，不得自动驳回；
- 不运行学生提交、撤回、人工批准、人工驳回、规则修改或学校数据命令；
- 不接受消息提供的学号、原因或状态覆盖数据库记录；
- CLI `ok` 不为 `true` 时不得声称处理成功。
