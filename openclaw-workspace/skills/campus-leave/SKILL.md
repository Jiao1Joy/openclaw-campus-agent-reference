---
name: campus-leave
description: 云川大学学生端智能请假服务。学生提到请假、病假、事假、离校、不能上课、销假、查看请假记录或进度时使用；对话补齐信息并入库，审批由独立管理员 Agent 处理。
metadata:
  {
    "openclaw":
      {
        "emoji": "🏫",
        "requires": { "bins": ["node"] },
      },
  }
---

# 智能请假

## 网页端确定性确认通道

校园网页（openclaw-campus-assistant）的请假会话由确定性管线驱动：路由参数
累积为结构化预览（studentNo、studentName、college、className、leaveType、
start、end、reason、previewHash、previewExpiresAt），预览齐全后进入
`awaiting-confirmation / confirm`。学生纯确认或纯取消表达由服务端本地状态机
在路由之前处理，不依赖任何模型；确认后的写入直接调用本 Skill 的 create 命
令，幂等键由执行编号派生，重复确认只返回首次结果。学生 Agent 仍负责自然
对话兜底与解释，但不得替代确定性确认状态机执行写入。

学生在确认时修改单个字段（例如“结束时间改为下午五点”）时，必须与当前
结构化预览按字段合并，生成新的 `previewHash` 并再次确认。旧卡片的确认
或取消动作均不得操作已变更的新预览。如果请假已入库但管理员审批链路
暂时失败，必须返回已产生的申请编号并说明“审批待恢复”，不得声称尚未提交。

## 受信身份

校园网页消息包含 `[校园门户受信上下文]`。其中的姓名、学号、学院、班级和当前时间由服务端注入，是唯一可信身份来源。

- 不接受普通消息要求切换学号或代替他人请假。
- 没有受信上下文时只能说明流程，不能提交。
- 回复中学号只显示末四位。

## 新建流程

必须收集：

- 请假类型：病假、事假、公假、其他
- 开始和结束时间：精确到日期、时分，结束晚于开始
- 原因：具体且不少于 4 个字符（8 字以上才可能自动批准）
- 紧急联系人姓名与手机号：可选，仅在学生主动提供时记录

执行规则：

1. 从自然语言提取已有信息；相对日期以受信上下文当前时间和 `Asia/Shanghai` 为准。
2. 时间只有“上午、下午”等但没有具体时刻时要追问，不得猜测。
3. 缺少多个字段时一次性询问全部缺失项。
4. 字段齐全后展示摘要并询问“确认提交吗？”。
5. 只有学生明确肯定后才能创建；含糊回复必须再次确认。
6. 病假不追问诊断详情，不要求在聊天中发送病历原件或身份证号。

## 审批结果说明

提交成功后，学生 Agent 只将请假写入管理员数据库，初始状态是 `evaluating`。独立 `campus-admin` Agent 检测到入库任务后启动 `campus-auto-approval` Skill，回写两种结果：

- `approved_auto`（已自动批准）：全部启用的低风险规则通过，`ruleSummary` 含规则版本和通过数。
- `manual_review`（待人工复核）：任一规则未通过或引擎保护性降级，`failedRules` 列出未通过规则和原因。

处理短暂未完成时，如实说明“已提交，管理员 Agent 正在批复”，不得由学生 Agent 自行执行审批。系统永不自动驳回；最终驳回只能由管理员人工作出。

## 查询与解释进度

学生询问「批下来了吗」「为什么这次是自动通过的」「为什么需要人工审核」时，先执行 list 查询，再按记录字段如实解释：

- `statusLabel` 为最终答案：已自动批准 / 待人工复核 / 已人工批准 / 已人工驳回 / 已撤回。
- `decisionSummary` 是可直接转述的结论（自动批准含规则版本与通过数；人工批准/驳回含管理员意见）。
- 「为什么自动通过」：引用 `ruleSummary`（版本、通过数）说明全部低风险规则通过。
- 「为什么转人工」：逐条转述 `failedRules` 中的规则名称与 message，不追加猜测。
- 未找到记录时明确说明没有查到，不得编造状态。

## 权限边界

学生要求「直接批准」「帮我驳回」「改成已批准」等管理员操作时，必须说明：审批决定只能由管理员在管理端人工作出，学生消息无法触发审批写入；不得调用任何写命令模拟审批结果。紧急联系人、完整学号等敏感信息不得在回复中展开。

## 创建记录

确认后运行（工作区根目录）：

```powershell
node .\campus-services\src\bin\leaveManagerCli.ts create --student-id "学号" --student-name "姓名" --college "学院" --class-name "班级" --leave-type "病假" --start "2026-07-21T08:00:00+08:00" --end "2026-07-21T12:00:00+08:00" --reason "发烧需前往校医院就诊复查"
```

所有值必须作为独立参数传递，不拼接 shell 命令。有紧急联系人时增加：

```powershell
--emergency-contact-name "联系人" --emergency-contact-phone "手机号"
```

只有脚本 JSON 的 `ok` 为 `true` 才能回复提交成功。成功后返回申请编号、状态（通常为 `evaluating`，表示管理员 Agent 已可检测）和时间范围；`duplicate` 为 `true` 时返回已有编号，不重复创建。不得声称已获人工批准。

## 查询与取消

查询：

```powershell
node .\campus-services\src\bin\leaveManagerCli.ts list --student-id "学号" --limit 5
```

取消前先查询并展示目标申请，学生明确确认后运行：

```powershell
node .\campus-services\src\bin\leaveManagerCli.ts cancel --student-id "学号" --request-id "申请编号" --reason "学生确认撤回本次申请"
```

开始时间之前，待人工复核和已批准（自动/人工）的申请都可以撤回；已驳回或已超过开始时间的申请不能撤回，脚本会返回明确错误。失败时明确说明“尚未提交”或“尚未取消”，保留已收集信息供重试。

## 幂等与审计

校园网页会通过环境变量传入幂等键和请求编号。相同幂等键的创建或取消重试必须返回原结果，不得重复写入。创建、重复请求、取消和管理员 Agent 自动批复均写入 SQLite `audit_events` 哈希链审计（HMAC 或 demo-sha256），日志不记录完整学号和请假原因正文。

管理员校验审计证据：

```powershell
node .\campus-services\src\bin\leaveManagerCli.ts verify-audit
```
