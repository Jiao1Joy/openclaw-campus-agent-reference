# OpenClaw 路由评测报告

生成时间：2026-08-20T03:01:46.982Z

## 结论

质量门槛：通过

## 核心指标

| 指标 | 结果 | 门槛 |
| --- | ---: | ---: |
| 全量通过率 | 68.92% | 观察项 |
| 能力选择准确率 | 95.95% | >= 95% |
| 意图动作准确率 | 90.54% | 观察项 |
| 参数 Precision / Recall / F1 | 78.39% / 91.58% / 84.47% | 观察项 |
| 日期时间提取准确率 | 96.10% | >= 95% |
| 危险确认误判 | 0 | = 0 |
| 协议错误率 | 0.00% | <= 1% |
| 延迟 P50 / P95 / Max | 1776 / 3954 / 4602 ms | P95 <= 10000 ms |
| 案例 / 错误数 | 148 / 0 | - |

## 分类表现

| 分类 | 案例数 | 通过率 |
| --- | ---: | ---: |
| course | 34 | 70.59% |
| knowledge | 23 | 91.30% |
| leave | 36 | 66.67% |
| leave-impact | 33 | 45.45% |
| null | 22 | 81.82% |

## 能力混淆

- campus.leave-impact -> campus.leave: 4
- null -> campus.leave-impact: 1
- null -> campus.leave: 1

## 主要失败类型

- missing.unexpected: 31
- intent: 14
- parameter.endTime: 11
- parameter.timePrecision: 11
- parameter.startTime: 10
- missing.required: 10
- parameter.reason: 7
- parameter.leaveType: 7
- capability: 6
- parameter.selectedSectionId: 4
- parameter.targetDate: 3
- parameter.timePeriod: 2

## 高风险标签

- 缺精确时间: 4/4 失败
- 缺类型和原因: 1/1 失败
- 感叹: 1/1 失败
- 缺时间和类型原因: 1/1 失败
- 销假: 1/1 失败
- 缺原因: 1/1 失败
- 余量: 2/2 失败
- 教师: 1/1 失败
- 教师ID: 1/1 失败
- 任务中途改意图: 1/1 失败
- 缺精确时间和原因: 1/1 失败
- 确认意图但不满足显式确认: 1/1 失败

## 失败样例（前 30 条）

- route-0004 [leave-impact]：parameter.endTime:09:00!=09:40
- route-0005 [leave-impact]：parameter.reason:社团活动!=社团有活动
- route-0006 [leave-impact]：parameter.startTime:14:00!=；parameter.timePrecision:exact!=period；missing.required:精确时间范围
- route-0007 [leave-impact]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；missing.required:精确时间范围
- route-0009 [leave-impact]：parameter.leaveType:!=病假；missing.unexpected:请假类型
- route-0010 [leave-impact]：parameter.timePrecision:period!=exact；missing.unexpected:精确时间范围
- route-0013 [leave-impact]：parameter.leaveType:病假!=；missing.required:请假类型
- route-0017 [leave-impact]：intent:continue!=confirm；missing.unexpected:请假日期；missing.unexpected:精确时间范围；missing.unexpected:请假类型；missing.unexpected:请假原因
- route-0018 [leave-impact]：parameter.leaveType:!=其他；missing.unexpected:请假类型
- route-0019 [leave-impact]：capability:campus.leave!=campus.leave-impact；parameter.startTime:14:00!=；parameter.endTime:17:00!=
- route-0021 [leave-impact]：parameter.reason:学校交流!=代表学校出去交流
- route-0022 [leave-impact]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；parameter.reason:医生让我去复诊!=医生让去复诊；missing.required:精确时间范围
- route-0024 [leave-impact]：capability:campus.leave!=campus.leave-impact
- route-0025 [leave-impact]：capability:campus.leave!=campus.leave-impact
- route-0026 [leave-impact]：capability:campus.leave!=campus.leave-impact
- route-0030 [leave]：parameter.startTime:08:00!=；parameter.endTime:17:00!=；parameter.timePrecision:exact!=none；missing.required:精确时间范围
- route-0031 [leave]：parameter.endTime:15:00!=15:40
- route-0032 [leave]：parameter.leaveType:其他!=；missing.required:请假类型
- route-0035 [leave]：intent:start!=list；missing.unexpected:请假日期；missing.unexpected:精确时间范围；missing.unexpected:请假类型；missing.unexpected:请假原因
- route-0043 [leave]：intent:continue!=cancel；missing.unexpected:请假日期；missing.unexpected:精确时间范围；missing.unexpected:请假类型；missing.unexpected:请假原因
- route-0044 [leave]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；parameter.reason:病假!=；missing.required:精确时间范围；missing.required:请假原因
- route-0049 [leave]：parameter.leaveType:事假!=；missing.required:请假类型
- route-0054 [course]：intent:start!=list
- route-0056 [course]：parameter.selectedSectionId:CS101-01!=
- route-0061 [course]：parameter.selectedSectionId:!=PE201-02
- route-0064 [course]：intent:continue!=confirm
- route-0065 [course]：intent:continue!=confirm
- route-0066 [course]：intent:continue!=cancel
- route-0069 [course]：parameter.selectedSectionId:!=CSE303-01
- route-0070 [course]：parameter.selectedSectionId:GE201-01 现代书法鉴赏!=GE201-01
