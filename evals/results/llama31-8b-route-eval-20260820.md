# OpenClaw 路由评测报告

生成时间：2026-08-20T01:49:43.543Z

## 结论

质量门槛：未通过（capability accuracy、intent accuracy、parameter F1）

## 核心指标

| 指标 | 结果 | 门槛 |
| --- | ---: | ---: |
| 全量通过率 | 56.08% | 观察项 |
| 能力选择准确率 | 84.46% | >= 90% |
| 意图动作准确率 | 80.41% | >= 95% |
| 参数 Precision / Recall / F1 | 70.82% / 81.68% / 75.86% | F1 >= 90% |
| 危险确认误判 | 0 | = 0 |
| 协议错误率 | 0.00% | <= 1% |
| 延迟 P50 / P95 / Max | 1836 / 3971 / 6859 ms | 记录基线 |
| 案例 / 错误数 | 148 / 0 | - |

## 分类表现

| 分类 | 案例数 | 通过率 |
| --- | ---: | ---: |
| course | 34 | 73.53% |
| knowledge | 23 | 39.13% |
| leave | 36 | 47.22% |
| leave-impact | 33 | 36.36% |
| null | 22 | 90.91% |

## 能力混淆

- campus.knowledge -> null: 10
- campus.leave -> campus.leave-impact: 3
- campus.knowledge -> campus.leave-impact: 2
- campus.leave -> null: 2
- campus.leave-impact -> campus.leave: 1
- campus.course -> null: 1
- campus.knowledge -> campus.leave: 1
- campus.knowledge -> campus.course: 1
- null -> campus.leave: 1
- null -> campus.leave-impact: 1

## 主要失败类型

- missing.unexpected: 36
- intent: 29
- capability: 23
- parameter.targetDate: 22
- parameter.timePrecision: 14
- parameter.startTime: 10
- missing.required: 9
- parameter.reason: 8
- parameter.endTime: 8
- parameter.leaveType: 6
- parameter.selectedSectionId: 4
- parameter.timePeriod: 2

## 高风险标签

- evening: 2/2 失败
- 缺精确时间: 4/4 失败
- 缺类型和原因: 1/1 失败
- 多轮补参数: 6/6 失败
- 省略主语: 1/1 失败
- 感叹: 1/1 失败
- 销假: 1/1 失败
- 缺原因: 1/1 失败
- 余量: 2/2 失败
- 教师: 1/1 失败
- 教师ID: 1/1 失败
- 任务中途改意图: 1/1 失败

## 失败样例（前 30 条）

- route-0003 [leave-impact]：parameter.targetDate:2026-08-15!=2026-08-14；parameter.timePrecision:period!=exact；missing.unexpected:精确时间范围
- route-0004 [leave-impact]：parameter.targetDate:2026-08-15!=2026-08-17
- route-0005 [leave-impact]：parameter.targetDate:2026-08-19!=2026-08-14；parameter.reason:社团活动!=社团有活动
- route-0006 [leave-impact]：parameter.startTime:14:00!=；parameter.timePrecision:exact!=period；missing.required:精确时间范围
- route-0007 [leave-impact]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；missing.required:精确时间范围
- route-0009 [leave-impact]：parameter.leaveType:!=病假；missing.unexpected:请假类型
- route-0010 [leave-impact]：parameter.timePrecision:period!=exact；missing.unexpected:精确时间范围
- route-0011 [leave-impact]：intent:start!=continue；parameter.targetDate:!=2026-08-13；parameter.timePrecision:period!=exact；missing.unexpected:请假日期；missing.unexpected:精确时间范围
- route-0012 [leave-impact]：capability:campus.leave!=campus.leave-impact；intent:start!=continue
- route-0013 [leave-impact]：intent:start!=continue；parameter.reason:!=肚子疼；missing.unexpected:请假原因
- route-0017 [leave-impact]：intent:start!=confirm；missing.unexpected:请假日期；missing.unexpected:精确时间范围；missing.unexpected:请假类型；missing.unexpected:请假原因
- route-0018 [leave-impact]：parameter.leaveType:!=其他；missing.unexpected:请假类型
- route-0019 [leave-impact]：parameter.targetDate:2026-08-19!=2026-08-14；parameter.startTime:14:00!=；parameter.endTime:17:00!=
- route-0021 [leave-impact]：parameter.targetDate:2026-08-15!=2026-08-17；parameter.reason:学校交流!=代表学校出去交流
- route-0022 [leave-impact]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；parameter.reason:医生让我去复诊!=医生让去复诊；missing.required:精确时间范围
- route-0024 [leave-impact]：parameter.targetDate:2026-08-18!=2026-08-13
- route-0026 [leave-impact]：parameter.targetDate:2026-08-19!=2026-08-14
- route-0030 [leave]：parameter.targetDate:2026-08-15!=2026-08-17；parameter.startTime:08:00!=；parameter.endTime:17:00!=；parameter.timePrecision:exact!=none；missing.required:精确时间范围
- route-0032 [leave]：parameter.leaveType:其他!=；missing.required:请假类型
- route-0035 [leave]：intent:start!=list；missing.unexpected:请假日期；missing.unexpected:精确时间范围；missing.unexpected:请假类型；missing.unexpected:请假原因
- route-0038 [leave]：intent:start!=continue
- route-0039 [leave]：capability:campus.leave-impact!=campus.leave；intent:start!=continue
- route-0040 [leave]：capability:campus.leave-impact!=campus.leave；intent:start!=continue
- route-0043 [leave]：intent:start!=cancel；missing.unexpected:请假日期；missing.unexpected:精确时间范围；missing.unexpected:请假类型；missing.unexpected:请假原因
- route-0044 [leave]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；parameter.reason:病假!=；missing.required:精确时间范围；missing.required:请假原因
- route-0045 [leave]：parameter.targetDate:2026-08-19!=2026-08-14
- route-0047 [leave]：parameter.targetDate:2026-08-15!=2026-08-17
- route-0049 [leave]：parameter.leaveType:事假!=；missing.required:请假类型
- route-0054 [course]：capability:null!=campus.course；intent:general!=list
- route-0056 [course]：parameter.selectedSectionId:CS101-01!=
