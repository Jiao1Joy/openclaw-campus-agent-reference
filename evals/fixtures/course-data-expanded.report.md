# 扩充 Demo 课程数据报告 · `course-data-expanded.candidate.json`

- 生成模型：GLM-5.2
- 数据来源：读取并保留原 Demo `openclaw-workspace/data/course-data.json` 的全部字段与已有 ID（**未覆盖原文件**）。
- 输出文件：`evals/fixtures/course-data-expanded.candidate.json`（候选，仅供评测）。
- 生成方式：结构化脚本生成，所有教师引用、先修课引用、容量、时间均经内部一致性断言。
- 自检结果：**PASS（0 错误）**，详见末节。

## 1. 总量

| 指标 | 原 Demo | 扩充候选 | 任务要求 |
| --- | --- | --- | --- |
| 教学班 sections | 14 | **48** | 45–70 ✅ |
| 教师 teachers | 13 | **27** | ≥25 ✅ |
| 课程码 courseCodes | 14 | **42** | — |
| 学生档案 studentProfiles | 1（保留） | 1（保留） | 保留 ✅ |

> 原 14 个教学班记录、13 名教师记录、`version`、`term`、`selectionWindow`、`studentProfiles` 全部原样保留（自检逐字段比对一致）。

## 2. 类别分布（`requirementCategory`）

| requirementCategory | 数量 | 说明 |
| --- | --- | --- |
| required（必修） | 19 | 含 CS101/CS102/MATH101/MATH201/MATH202/CS202/CS203/CS204/CS205/CS301/CS401 + PE201×3 + PE301×2 + PE302 + PE303 |
| major-elective（专业选修） | 13 | CSE301/CSE302×2/CSE303/CSE304/CSE305/CSE306/CSE307/CSE308/CSE401/CSE402/CSE403/CSE404 |
| general-elective（通识选修） | 13 | GE201–GE212（含 GE203 双校区） |
| free-elective（自由选修） | 3 | FE101/FE102/FE103 |
| **合计** | **48** | |

按 `nature`：required = 19，elective = 29（与原 schema 的 nature∈{required,elective} 一致；细分由 `requirementCategory` 承担）。

体育（PE）覆盖 4 个项目、7 个教学班：篮球 PE201-01/02/03、羽毛球 PE301-01/02、乒乓球 PE302-01、健美操 PE303-01。

## 3. 星期分布（`schedule.day`，1=周一 … 6=周六）

| 星期 | 教学班数 |
| --- | --- |
| 周一（1） | 8 |
| 周二（2） | 10 |
| 周三（3） | 7 |
| 周四（4） | 10 |
| 周五（5） | 11 |
| 周六（6） | 2（分校区） |
| 周日（7） | 0 |

- 周一至周五均有课 ✅
- 时段覆盖：上午（08:00–11:50）、下午（14:00–17:30）、晚间（18:30–20:00）均有课 ✅

## 4. 校区分布

| campus | 数量 |
| --- | --- |
| 主校区 | 44 |
| 分校区 | 4（GE211-01、CSE308-01、PE303-01、GE203-02） |

## 5. 刻意设计的冲突组（同一时间槽 ≥2 个教学班）

> 这些冲突是评测用例的“鱼饵”：学生可能在智能选课时同时想选，系统应能检测并提示。教师无任何双排（自检通过 0 例 teacher double-booking）。

代表性冲突组：

| 时间槽 | 教学班 | 类型 |
| --- | --- | --- |
| 周一 14:00–15:40 | CS202-01、CS401-01、CSE401-01 | **三方冲突**（必修 × 必修 × 专业选修，均有 CS202 先修背景） |
| 周四 14:00–15:40 | CS301-01、CSE303-01 | 必修 × 专业选修 |
| 周二 10:10–11:50 | CSE301-01、CSE402-01、CSE403-01 | 专业选修三方冲突 |
| 周五 16:00–17:30 | PE201-03、GE201-01、CSE306-01、GE208-01、PE302-01 | 体育 × 通识 × 专业选修 × 通识（满额）× 体育 |
| 周四 16:00–17:30 | PE201-02、GE202-01、GE205-01、PE301-02 | 含满额 GE205-01 |
| 周三 16:00–17:30 | PE201-01、CSE307-01、GE207-01 | 体育 × 专业选修（近满）× 通识 |

完整同槽冲突共 14 组；另有部分时段重叠的冲突对由自检脚本单独列出。

## 6. 满额组（enrolled == capacity）

| sectionId | 课程 | 容量/已选 |
| --- | --- | --- |
| CSE305-01 | 算法设计与分析 | 60/60 |
| GE205-01 | 通识写作 | 40/40 |
| GE208-01 | 日语入门 | 35/35 |

## 7. 余量极少组（capacity − enrolled ≤ 2）

| sectionId | 课程 | 剩余余量 |
| --- | --- | --- |
| CS102-01 | 数据结构 | 1 |
| CSE304-01 | Web 前端工程实践 | 1 |
| CSE307-01 | 网络安全实践 | 1 |
| CS101-01 | 程序设计基础 | 2 |
| MATH101-01 | 高等数学（上） | 2 |
| CSE306-01 | 大数据分析实践 | 2 |
| PE301-02 | 羽毛球 | 2 |

## 8. 先修课链（prerequisites 引用，链长 ≥3 的代表）

| 链 | 深度 |
| --- | --- |
| CS101 → CS102 → CS202 → CS401 | 4 |
| CS101 → CS102 → CS202 → CSE401 | 4 |
| CS101 → CS102 → CS301 → CS401 | 4 |
| CS101 → CS102 → CSE303 → CSE402 | 4 |
| CS101 → CS102 → CSE303 → CSE306 | 4 |
| MATH101 → CSE302 → CSE403 | 3 |
| MATH101 → MATH201 → CSE404 | 3 |
| CS101 → CS102 → CS204 / CS205 / CSE305 | 3 |

> 先修课全部引用到候选内存在的 courseCode（自检通过）。`studentProfiles[0].completedCourseCodes`（CS101/CS102/MATH101/GE-HIST101）使其具备多数先修条件，可用于课程影响与选课资格查询演示；`existingSectionIds`（CS202-01、CS203-01）与 `requiredCourseCodes`（CS301、PE201）均能在候选内定位。

## 9. 多教师同课 / 多教学班

| courseCode | 教师 | 教学班数 |
| --- | --- | --- |
| PE201（篮球） | T-LI-PE、T-WANG-PE、T-CHEN-PE | 3 |
| CSE302（机器学习导论） | T-ZHOU、T-LIN | 2 |
| MATH101（高等数学上） | T-MA | 2 |
| GE203（天文学导论） | T-XU | 2（主校区 + 分校区） |
| PE301（羽毛球） | T-DENG-PE | 2 |

## 10. 自检结果

自检脚本（`zcode-tasks/_check_course_data.cjs`）执行以下校验，全部通过：

1. 候选 JSON 语法合法；顶层保留 `version/term/selectionWindow/studentProfiles/teachers/sections`。
2. 原 13 名教师 id 与记录逐字段一致；原 14 个教学班 id 与记录逐字段一致。
3. 教师 id 全局唯一；教学班 sectionId 全局唯一。
4. 每个教学班的 `teacherId` 在 `teachers` 中存在（**0 例悬空引用**）。
5. 每个 `prerequisites` 中的 courseCode 在候选内存在（**0 例悬空先修**）。
6. `capacity > 0`、`enrolled ≥ 0` 且 `enrolled ≤ capacity`（**0 例超员**）。
7. `schedule` 每个 slot：`day ∈ 1..7`、`start < end`、`HH:MM` 格式、`weeks` 非空。
8. `nature` / `requirementCategory` / `workload` / `campus` / `assessment.type` 枚举合法；`assessment.examRequired` 为布尔。
9. `studentProfiles` 的 `existingSectionIds` / `requiredCourseCodes` 在候选内可定位。
10. 阈值：sections=48∈[45,70]、teachers=27≥25；类别含 required / major-elective / general-elective / 体育；周一至周五均有课；上午与晚间均有课。
11. **教师无同一时间双排**（0 例 teacher double-booking）。

**结论：PASS（0 错误）。** 未覆盖原 `course-data.json`，未修改任何 TypeScript / Python / OpenClaw 配置 / Skill / 现有课程数据。
