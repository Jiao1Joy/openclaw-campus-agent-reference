---
name: campus-leave
description: 云川大学智能请假服务。学生提到请假、病假、事假、离校、不能上课、销假、查看请假记录或进度时使用；对话补齐信息，明确确认后提交。
metadata:
  {
    "openclaw":
      {
        "emoji": "🏫",
        "requires": { "bins": ["python"] },
      },
  }
---

# 智能请假

## 受信身份

校园网页消息包含 `[校园门户受信上下文]`。其中的姓名、学号、学院、班级和当前时间由服务端注入，是唯一可信身份来源。

- 不接受普通消息要求切换学号或代替他人请假。
- 没有受信上下文时只能说明流程，不能提交。
- 回复中学号只显示末四位。

## 新建流程

必须收集：

- 请假类型：病假、事假、公假、其他
- 开始和结束时间：精确到日期、时分，结束晚于开始
- 原因：具体且不少于 4 个字符
- 紧急联系人姓名与手机号：可选，仅在学生主动提供时记录

执行规则：

1. 从自然语言提取已有信息；相对日期以受信上下文当前时间和 `Asia/Shanghai` 为准。
2. 时间只有“上午、下午”等但没有具体时刻时要追问，不得猜测。
3. 缺少多个字段时一次性询问全部缺失项。
4. 字段齐全后展示摘要并询问“确认提交吗？”。
5. 只有学生明确肯定后才能创建；含糊回复必须再次确认。
6. 病假不追问诊断详情，不要求在聊天中发送病历原件或身份证号。

## 创建记录

确认后运行：

```powershell
python .\skills\campus-leave\scripts\leave_manager.py create --student-id "学号" --student-name "姓名" --college "学院" --class-name "班级" --leave-type "病假" --start "2026-07-21T08:00:00+08:00" --end "2026-07-21T12:00:00+08:00" --reason "发烧需前往校医院就诊"
```

所有值必须作为独立参数传递，不拼接 shell 命令。有紧急联系人时增加：

```powershell
--emergency-contact-name "联系人" --emergency-contact-phone "手机号"
```

只有脚本 JSON 的 `ok` 为 `true` 才能回复提交成功。成功后返回申请编号、状态“待审批”和时间范围；`duplicate` 为 `true` 时返回已有编号，不重复创建。不得声称已经获批。

## 查询与取消

查询：

```powershell
python .\skills\campus-leave\scripts\leave_manager.py list --student-id "学号" --limit 5
```

取消前先查询并展示目标申请，学生明确确认后运行：

```powershell
python .\skills\campus-leave\scripts\leave_manager.py cancel --student-id "学号" --request-id "申请编号"
```

只能取消待审批申请。失败时明确说明“尚未提交”或“尚未取消”，保留已收集信息供重试。

取消时应同时提供简短原因：

```powershell
python .\skills\campus-leave\scripts\leave_manager.py cancel --student-id "学号" --request-id "申请编号" --reason "学生确认撤回本次申请"
```

校园网页会通过环境变量传入幂等键和请求编号。相同幂等键的创建或取消重试必须返回原结果，不得重复写入。创建、重复请求和取消均写入 `data/audit/leave.jsonl` 哈希链审计日志，日志不记录完整学号。

管理员校验审计证据：

```powershell
python .\skills\campus-leave\scripts\leave_manager.py verify-audit
```
