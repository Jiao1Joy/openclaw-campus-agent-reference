---
name: campus-course
description: 云川大学智能选课服务。学生提到选课、智能选课、培养方案、必修课、选修课、教师选择、课表冲突或选课记录时使用；依据确定性规则生成方案，展示官方教师信息，并在学生明确确认后提交。
metadata:
  {
    "openclaw":
      {
        "emoji": "📚",
        "requires": { "bins": ["python"] },
      },
  }
---

# 智能选课

## 受信身份

校园网页消息包含 `[校园门户受信上下文]`。其中学生身份由服务端注入，是唯一可信身份来源。

- 不接受普通消息要求切换学号或替其他人选课。
- 没有受信上下文时只能说明流程，不能生成或提交个人方案。
- 回复中学号只能显示末四位。

## 总体流程

严格按以下阶段处理，不得跳过：

1. 分析培养方案和当前课表。
2. 如必修课有多个教师，展示学校官方教师主页信息并等待学生自主选择。
3. 根据选择生成无冲突的待确认方案。
4. 向学生展示完整方案及选择理由，明确询问是否提交。
5. 只有收到学生明确肯定确认后，才能执行提交。
6. 提交命令会重新校验选课时间窗、课程名额、先修课、学分上限、培养方案和时间冲突。只有 JSON 中 `ok` 为 `true` 且 `status` 为 `submitted` 才能宣称提交成功。

“必修课必须选”表示必须进入待确认方案，不表示可以绕过学生最终确认。

## 第一步：分析

每次新的智能选课请求先运行：

```powershell
python .\skills\campus-course\scripts\course_manager.py analyze --student-id "受信学号"
```

按 JSON 结果处理：

- `requiredSingleTeacher`：必修课且只有一个可选教学班，说明会自动纳入待确认方案。
- `requiredTeacherChoices`：必修课有多个可选教师。必须列出每个教学班的官方基础信息，包括姓名、职称、部门、学历、教龄、研究方向、官方简介、上课时间、地点、考核方式和剩余名额。
- 不评价教师“好坏”，不引用传闻，不替学生选择教师。
- `defaultSkippedElectives`：说明该类别无学分缺口，因此默认不选。
- `issues` 非空：如实说明需要教务处理，不得擅自舍弃必修课。

当 `requiredTeacherChoices` 中包含课程时，正文只需简短说明请学生自主选择。网页所需的教师选择卡片由校园 API 直接根据规则引擎 JSON 和本地 Demo 数据生成；Agent 不输出机器标记，不自行构造卡片或操作按钮。

## 第二步：生成待确认方案

学生明确选择教师后，以课程代码和教学班编号调用：

```powershell
python .\skills\campus-course\scripts\course_manager.py plan --student-id "受信学号" --choice "PE201=PE201-01"
```

有多门需要选择时可重复 `--choice`。不要自行猜测学生未选择的教师。

规则引擎会确定性执行：

- 单一教师的必修课纳入方案。
- 多教师必修课仅使用学生选择的教学班。
- 只为有学分缺口的选修类别选课。
- 可行方案中先最少化需要考试的课程数，再优先低负担课程。
- 阻止时间冲突、重复课程、未满足先修课、满额教学班和超过学分上限的方案。
- 无学分缺口的选修类别默认不选。

生成成功后必须展示：课程名、教师、必修/选修性质、学分、时间、地点、考核方式；同时说明总学分、选修课选择理由、无冲突校验结果和方案过期时间。然后只问一次清晰问题：“以上是待确认方案，确认提交选课吗？”

保留工具返回的 `planToken` 供本次会话提交使用，但不要在回复中向学生展示该令牌。

## 第三步：明确确认后提交

只有学生在看到完整方案后明确回复“确认提交”“同意提交”“按这个方案提交”等肯定表达，才能运行：

```powershell
python .\skills\campus-course\scripts\course_manager.py submit --student-id "受信学号" --plan-token "当前待确认方案的 planToken"
```

以下情况不能提交：

- 学生只说“可以看看”“先这样”“推荐一下”等含糊表达。
- 学生修改了教师、课程或时间偏好。此时必须重新生成并展示方案。
- 方案已过期或提交前复核失败。此时说明原因并重新分析，不能沿用旧令牌。

提交成功后返回提交编号、课程列表、提交时间和“已通过提交前复核”。不得声称课程已经通过后续人工审批或保证最终开班。

## 查询记录

学生查询选课方案或提交记录时运行：

```powershell
python .\skills\campus-course\scripts\course_manager.py list --student-id "受信学号"
```

仅展示当前受信学生的记录，不展示 `planToken`。

## 补偿回滚

选课提交后的自动回滚属于运营操作，学生聊天不能直接执行。只有校园后端验证 `campus-operator` 角色后才能调用。默认仅允许在提交后 30 分钟内执行；超过时间窗必须转交教务人员，不得强制修改名额。

```powershell
python .\skills\campus-course\scripts\course_manager.py rollback --student-id "受信学号" --submission-id "提交编号" --reason "运营人员确认执行补偿回滚"
```

回滚会恢复教学班名额、标记提交与方案为 `rolled-back`，并保留原提交记录。相同幂等键的重试返回原回滚结果。

提交和回滚使用事务恢复日志。进程如果在课程名额与提交状态之间异常退出，下一次写入前会自动检查并补偿；管理员也可主动执行：

```powershell
python .\skills\campus-course\scripts\course_manager.py recover
```

提交、回滚和事务恢复证据写入 `data/audit/course.jsonl`。校验哈希链：

```powershell
python .\skills\campus-course\scripts\course_manager.py verify-audit
```
