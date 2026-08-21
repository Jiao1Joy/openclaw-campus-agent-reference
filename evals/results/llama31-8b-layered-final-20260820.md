# OpenClaw 路由评测报告

生成时间：2026-08-20T02:17:51.338Z

## 结论

质量门槛：未通过（capability accuracy、intent accuracy、parameter F1）

## 核心指标

| 指标 | 结果 | 门槛 |
| --- | ---: | ---: |
| 全量通过率 | 60.81% | 观察项 |
| 能力选择准确率 | 80.41% | >= 90% |
| 意图动作准确率 | 79.73% | >= 95% |
| 参数 Precision / Recall / F1 | 78.39% / 91.58% / 84.47% | F1 >= 90% |
| 危险确认误判 | 0 | = 0 |
| 协议错误率 | 0.00% | <= 1% |
| 延迟 P50 / P95 / Max | 2666 / 4449 / 6502 ms | 记录基线 |
| 案例 / 错误数 | 148 / 0 | - |

## 分类表现

| 分类 | 案例数 | 通过率 |
| --- | ---: | ---: |
| course | 34 | 64.71% |
| knowledge | 23 | 56.52% |
| leave | 36 | 58.33% |
| leave-impact | 33 | 48.48% |
| null | 22 | 81.82% |

## 能力混淆

- campus.course -> null: 7
- campus.knowledge -> null: 6
- campus.leave -> campus.leave-impact: 3
- campus.leave -> null: 3
- campus.leave-impact -> campus.leave: 2
- campus.knowledge -> campus.leave-impact: 2
- null -> campus.leave: 2
- null -> campus.leave-impact: 2
- campus.knowledge -> campus.leave: 1
- campus.knowledge -> campus.course: 1

## 主要失败类型

- missing.unexpected: 38
- intent: 30
- capability: 29
- parameter.timePrecision: 14
- parameter.startTime: 10
- missing.required: 10
- parameter.endTime: 8
- parameter.reason: 7
- parameter.leaveType: 7
- parameter.selectedSectionId: 4
- parameter.targetDate: 3
- parameter.timePeriod: 2

## 高风险标签

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
- 请假前置: 2/2 失败

## 失败样例（前 30 条）

- route-0003 [leave-impact]：parameter.timePrecision:period!=exact；missing.unexpected:精确时间范围
- route-0005 [leave-impact]：parameter.reason:社团活动!=社团有活动
- route-0006 [leave-impact]：parameter.startTime:14:00!=；parameter.timePrecision:exact!=period；missing.required:精确时间范围
- route-0007 [leave-impact]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；missing.required:精确时间范围
- route-0009 [leave-impact]：parameter.leaveType:!=病假；missing.unexpected:请假类型
- route-0010 [leave-impact]：parameter.timePrecision:period!=exact；missing.unexpected:精确时间范围
- route-0011 [leave-impact]：intent:start!=continue；parameter.timePrecision:period!=exact；missing.unexpected:精确时间范围
- route-0012 [leave-impact]：capability:campus.leave!=campus.leave-impact；intent:start!=continue
- route-0013 [leave-impact]：capability:campus.leave!=campus.leave-impact；intent:start!=continue；parameter.leaveType:病假!=；missing.required:请假类型
- route-0017 [leave-impact]：intent:start!=confirm；missing.unexpected:请假日期；missing.unexpected:精确时间范围；missing.unexpected:请假类型；missing.unexpected:请假原因
- route-0018 [leave-impact]：parameter.leaveType:!=其他；missing.unexpected:请假类型
- route-0019 [leave-impact]：parameter.startTime:14:00!=；parameter.endTime:17:00!=
- route-0021 [leave-impact]：parameter.reason:学校交流!=代表学校出去交流
- route-0022 [leave-impact]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；parameter.reason:医生让我去复诊!=医生让去复诊；missing.required:精确时间范围
- route-0030 [leave]：parameter.startTime:08:00!=；parameter.endTime:17:00!=；parameter.timePrecision:exact!=none；missing.required:精确时间范围
- route-0032 [leave]：parameter.leaveType:其他!=；missing.required:请假类型
- route-0035 [leave]：intent:start!=list；missing.unexpected:请假日期；missing.unexpected:精确时间范围；missing.unexpected:请假类型；missing.unexpected:请假原因
- route-0038 [leave]：intent:start!=continue
- route-0039 [leave]：capability:campus.leave-impact!=campus.leave；intent:start!=continue
- route-0040 [leave]：capability:campus.leave-impact!=campus.leave；intent:start!=continue
- route-0043 [leave]：capability:null!=campus.leave；intent:general!=cancel
- route-0044 [leave]：parameter.startTime:09:00!=；parameter.endTime:12:00!=；parameter.timePrecision:exact!=period；parameter.reason:病假!=；missing.required:精确时间范围；missing.required:请假原因
- route-0049 [leave]：parameter.leaveType:事假!=；missing.required:请假类型
- route-0054 [course]：capability:null!=campus.course；intent:general!=list
- route-0056 [course]：parameter.selectedSectionId:CS101-01!=
- route-0061 [course]：capability:null!=campus.course；intent:general!=continue；parameter.selectedSectionId:!=PE201-02
- route-0062 [course]：capability:null!=campus.course；intent:general!=continue
- route-0064 [course]：capability:null!=campus.course；intent:general!=confirm
- route-0065 [course]：capability:null!=campus.course；intent:general!=confirm
- route-0066 [course]：capability:null!=campus.course；intent:general!=cancel
