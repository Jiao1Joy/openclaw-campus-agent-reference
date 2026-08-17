# OpenClaw 路由评测报告

生成时间：2026-08-17T03:03:40.318Z

## 结论

质量门槛：未通过（intent accuracy、unsafe confirmations、protocol error rate）

## 核心指标

| 指标 | 结果 | 门槛 |
| --- | ---: | ---: |
| 全量通过率 | 23.08% | 观察项 |
| 能力选择准确率 | 94.03% | >= 90% |
| 意图动作准确率 | 70.90% | >= 95% |
| 参数 Precision / Recall / F1 | 92.50% / 94.39% / 93.44% | F1 >= 90% |
| 危险确认误判 | 5 | = 0 |
| 协议错误率 | 6.29% | <= 1% |
| 延迟 P50 / P95 / Max | 54427 / 61616 / 65135 ms | 记录基线 |
| 案例 / 错误数 | 143 / 9 | - |

## 分类表现

| 分类 | 案例数 | 通过率 |
| --- | ---: | ---: |
| course | 34 | 41.18% |
| knowledge | 23 | 0.00% |
| leave | 32 | 15.63% |
| leave-impact | 33 | 21.21% |
| null | 21 | 33.33% |

## 能力混淆

- null -> ERROR: 6
- campus.course -> campus.knowledge: 2
- campus.leave-impact -> ERROR: 1
- campus.course -> null: 1
- campus.knowledge -> ERROR: 1
- null -> campus.knowledge: 1
- campus.leave -> null: 1
- campus.leave-impact -> campus.leave: 1
- campus.leave -> ERROR: 1
- campus.leave -> campus.course: 1
- campus.course -> campus.leave-impact: 1

## 主要失败类型

- missing.required: 127
- missing.unexpected: 86
- intent: 39
- routing-error: 9
- capability: 8
- parameter.targetDate: 6
- unsafe-confirmation: 5
- parameter.timePeriod: 3
- parameter.timePrecision: 3
- parameter.reason: 3
- parameter.selectedSectionId: 3
- parameter.leaveType: 2

## 高风险标签

- 模糊时段: 10/10 失败
- 缺精确时间: 4/4 失败
- 省略: 10/10 失败
- 缺多参数: 8/8 失败
- 缺时间和原因: 3/3 失败
- 缺类型和原因: 1/1 失败
- 多轮补参数: 6/6 失败
- 省略主语: 1/1 失败
- 标点: 2/2 失败
- 感叹: 1/1 失败
- 缺时间: 5/5 失败
- 隐含意图: 2/2 失败

## 失败样例（前 30 条）

- route-0003 [leave-impact]：routing-error
- route-0006 [leave-impact]：missing.required:精确时间范围
- route-0007 [leave-impact]：missing.required:精确时间范围
- route-0008 [leave-impact]：intent:general!=start；missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因；missing.unexpected:targetDate
- route-0009 [leave-impact]：missing.required:精确时间范围；missing.required:请假原因；missing.unexpected:startTime；missing.unexpected:endTime
- route-0010 [leave-impact]：missing.required:请假类型；missing.required:请假原因；missing.unexpected:leaveType；missing.unexpected:reason
- route-0011 [leave-impact]：parameter.targetDate:!=2026-08-13；missing.required:请假类型；missing.required:请假原因；missing.unexpected:targetDate
- route-0012 [leave-impact]：missing.required:请假日期；missing.required:精确时间范围；missing.unexpected:targetDate；missing.unexpected:timePeriod
- route-0013 [leave-impact]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型
- route-0014 [leave-impact]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因
- route-0015 [leave-impact]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因
- route-0016 [leave-impact]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因
- route-0017 [leave-impact]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因
- route-0018 [leave-impact]：parameter.leaveType:!=其他；missing.required:精确时间范围；missing.required:请假原因；missing.unexpected:leaveType；missing.unexpected:reason
- route-0019 [leave-impact]：parameter.timePeriod:none!=afternoon；parameter.timePrecision:none!=period；parameter.reason:办私事!=去办点私事；missing.required:精确时间范围；missing.unexpected:startTime；missing.unexpected:endTime
- route-0020 [leave-impact]：missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因；missing.unexpected:leaveType；missing.unexpected:reason
- route-0021 [leave-impact]：missing.required:精确时间范围；missing.unexpected:startTime；missing.unexpected:endTime
- route-0022 [leave-impact]：parameter.reason:去医院复诊!=医生让去复诊；missing.required:精确时间范围；missing.unexpected:startTime；missing.unexpected:endTime
- route-0023 [leave-impact]：missing.required:精确时间范围
- route-0025 [leave-impact]：missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因；missing.unexpected:startTime；missing.unexpected:endTime；missing.unexpected:leaveType；missing.unexpected:reason
- route-0026 [leave-impact]：parameter.reason:发烧!=发烧了；missing.required:精确时间范围
- route-0030 [leave]：missing.required:精确时间范围
- route-0032 [leave]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因；missing.unexpected:targetDate；missing.unexpected:timePeriod；missing.unexpected:leaveType
- route-0033 [leave]：missing.required:精确时间范围；missing.required:请假原因；missing.unexpected:reason
- route-0034 [leave]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因；missing.unexpected:targetDate；missing.unexpected:leaveType；missing.unexpected:reason
- route-0035 [leave]：intent:continue!=list；missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因；missing.unexpected:targetDate
- route-0036 [leave]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因
- route-0037 [leave]：missing.required:请假日期；missing.required:精确时间范围；missing.required:请假类型；missing.required:请假原因
- route-0038 [leave]：missing.required:请假日期；missing.required:精确时间范围；missing.unexpected:targetDate；missing.unexpected:startTime；missing.unexpected:endTime
- route-0039 [leave]：missing.required:请假类型；missing.required:请假原因；missing.unexpected:leaveType；missing.unexpected:reason
