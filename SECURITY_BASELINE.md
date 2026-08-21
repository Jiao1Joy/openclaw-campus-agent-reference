# OpenClaw 校园助手权限与证据基线

> OpenClaw 运行 Trace 补充：`data/traces/campus-traces.jsonl` 只保存字段白名单内的路由、工具阶段、耗时和结果状态。普通用户按身份哈希隔离查询，审计角色可跨身份查询；禁止写入消息正文、完整学号、访问令牌、请假原因、幂等键和方案令牌。

> UI 卡片补充：服务端只返回统一 `cards[]` 白名单协议。模型文本不能声明组件；交互动作仅允许 `send-message`，来源 URL 仅允许 HTTPS，卡片数量和字段长度均受限。教师和知识卡片只能由确定性工具结果生成。

> 更新日期：2026-08-12
> 适用范围：当前本地 Demo 与后续测试环境
> 状态：已实现并通过隔离自动化测试

## 1. 目标

本基线用于约束校园助手中的敏感业务操作，重点解决：

- 谁可以执行操作；
- 请求超时后如何避免重复写入；
- 如何证明一次操作经过确认并真实执行；
- 写入中断后如何恢复；
- 已提交操作如何进行受控补偿回滚。

当前实现仍使用本地 JSON 数据，不等同于真实校园系统的最终安全方案。

## 2. 身份与权限

### 身份模式

服务端支持三种身份模式：

- `demo`：默认模式，仅用于本机演示，固定映射到演示学生；
- `token`：验证本项目 HMAC 签名的 Bearer Token，仅用于封闭测试；
- `oidc`：使用学校 OIDC/JWKS 公钥验证标准 RS256 JWT，推荐用于共享测试和生产环境。

生产或共享测试环境应设置：

```text
CAMPUS_AUTH_MODE=oidc
CAMPUS_OIDC_ISSUER=<学校 OIDC Issuer>
CAMPUS_OIDC_AUDIENCE=<校园 API Audience>
CAMPUS_OIDC_JWKS_URI=<学校 JWKS HTTPS 地址>
```

OIDC 只接受 `RS256`，严格校验 `kid`、签发方、受众、过期时间和生效时间。JWKS 请求超时为 5 秒，并根据响应缓存和本地上限缓存；找不到 `kid` 时会强制刷新一次以支持密钥轮换。除明确测试配置外，JWKS 必须使用 HTTPS。

令牌必须包含：

- `sub`：学生或操作人员 ID；
- `name`：姓名；
- `college`：学院；
- `className`：班级；
- `roles`：角色数组；
- `exp`：Unix 过期时间。

客户端消息中的姓名和学号不能覆盖令牌身份。选课会话使用“可信身份 + 会话 ID”联合隔离。

### 角色权限

| 操作 | student | campus-operator | campus-auditor |
| --- | --- | --- | --- |
| 校园助手聊天 | 允许 | 允许 | 禁止 |
| 查询本人请假记录 | 允许 | 允许 | 禁止 |
| 取消本人待审批请假 | 允许 | 允许 | 禁止 |
| 选课补偿回滚 | 禁止 | 允许 | 禁止 |
| 校验 API 审计链 | 禁止 | 允许 | 允许 |

选课回滚不会通过普通学生聊天开放。

## 3. 请求超时

| 环节 | 默认超时 | 配置项 |
| --- | ---: | --- |
| 请求体读取 | 10 秒 | 代码固定上限 |
| 本地请假/选课规则引擎 | 20 秒 | `CAMPUS_ENGINE_TIMEOUT_MS` |
| OpenClaw Agent | 120 秒 | `CAMPUS_OPENCLAW_TIMEOUT_MS` |

配置值会被限制在安全范围内。上游超时返回 `504` 和请求编号；客户端必须使用原幂等键重试，不能创建一个新的写入请求。

## 4. 幂等控制

所有可能触发业务写入的 POST 请求必须包含：

```http
Idempotency-Key: <8 到 128 字符>
X-Request-Id: <可选；缺少时由服务端生成>
```

行为规则：

- 相同身份、接口、幂等键和请求内容：返回第一次响应；
- 相同幂等键但请求内容不同：返回 `409 IDEMPOTENCY_CONFLICT`；
- 并发发送相同幂等键：只执行一次，其余请求等待并重放结果；
- 服务重启后，在保留期内仍可重放；
- 幂等存储默认保留 24 小时，可用 `CAMPUS_IDEMPOTENCY_TTL_MS` 调整，最大 7 天。

API 幂等状态默认保存在：

```text
workspace-campus/data/idempotency/campus-api.json
```

请假和选课引擎还会在业务记录中保存幂等键哈希，因此即使 API 在写入后、保存响应前异常退出，使用原幂等键重试也不会重复写入。

## 5. 审计证据

系统使用追加式 JSONL 审计日志，每条事件包含：

- 时间；
- 请求编号；
- 脱敏身份和不可逆身份引用；
- 操作、资源、结果和耗时；
- 请求摘要和幂等键摘要；
- 前一条事件哈希；
- 当前事件哈希或 HMAC。

日志不保存完整学号、聊天原文、请假原因和联系人信息。

审计文件：

```text
workspace-campus/data/audit/campus-api.jsonl
workspace-campus/data/audit/leave.jsonl
workspace-campus/data/audit/course.jsonl
```

本机未配置审计密钥时使用 `demo-sha256`，只能检测普通篡改。共享测试或生产环境必须配置独立密钥：

```text
CAMPUS_AUDIT_SECRET=<独立的高强度随机密钥>
```

API 审计校验接口：

```http
GET /api/campus-assistant/audit/verify
```

该接口仅允许 `campus-operator` 或 `campus-auditor`。

业务引擎校验：

```powershell
python .\skills\campus-leave\scripts\leave_manager.py verify-audit
python .\skills\campus-course\scripts\course_manager.py verify-audit
```

## 6. 回滚与恢复

### 请假回滚

接口：

```http
POST /api/campus-assistant/leave-requests/{requestId}/rollback
```

请求体：

```json
{
  "reason": "学生确认撤回本次申请"
}
```

规则：

- 只能操作当前身份自己的记录；
- 只能取消 `pending` 申请；
- 不删除原记录，而是标记为 `cancelled`；
- 保存原状态、取消原因、时间和幂等摘要；
- 重复回滚返回原结果。

### 选课补偿回滚

接口：

```http
POST /api/campus-assistant/course-submissions/{submissionId}/rollback
```

规则：

- 仅允许 `campus-operator`；
- 默认仅允许提交后 30 分钟内执行；
- 恢复教学班名额；
- 提交和方案标记为 `rolled-back`，原记录保留；
- 名额数据不一致时停止并要求人工核对；
- 超过时间窗后转交教务，不执行强制修改。

时间窗可用 `CAMPUS_COURSE_ROLLBACK_WINDOW_MINUTES` 配置，允许范围为 1–1440 分钟。

### 跨文件事务恢复

选课提交和回滚需要同时更新课程名额与提交状态。写入前会建立事务恢复日志：

```text
workspace-campus/data/course-selection-state-transaction.json
```

正常完成后日志自动清理。若进程在两次原子写入之间退出，下一次写入前会：

1. 检查提交状态是否已经完成；
2. 已完成则核销事务日志；
3. 未完成则将课程名额恢复为写入前数值；
4. 名额已被其他操作改变时停止自动恢复，要求人工核对；
5. 将恢复动作写入审计链。

管理员可主动执行：

```powershell
python .\skills\campus-course\scripts\course_manager.py recover
```

## 7. 关键配置

| 配置项 | 用途 |
| --- | --- |
| `CAMPUS_AUTH_MODE` | `demo` 或 `token` |
| `CAMPUS_AUTH_SECRET` | 身份令牌签名密钥 |
| `CAMPUS_OIDC_ISSUER` | 学校 OIDC Issuer |
| `CAMPUS_OIDC_AUDIENCE` | 校园 API Audience |
| `CAMPUS_OIDC_JWKS_URI` | OIDC 公钥集合地址，生产必须 HTTPS |
| `CAMPUS_OIDC_*_CLAIM` | 身份字段映射，支持点号路径 |
| `CAMPUS_OIDC_CLOCK_TOLERANCE_SECONDS` | 时钟偏差容忍，默认 30 秒 |
| `CAMPUS_OIDC_JWKS_CACHE_SECONDS` | JWKS 缓存上限，默认 300 秒 |
| `CAMPUS_AUDIT_SECRET` | 审计 HMAC 密钥 |
| `CAMPUS_WORKSPACE` | 校园 Agent 工作区位置 |
| `CAMPUS_OPENCLAW_TIMEOUT_MS` | OpenClaw 超时 |
| `CAMPUS_ENGINE_TIMEOUT_MS` | 本地规则引擎超时 |
| `CAMPUS_IDEMPOTENCY_TTL_MS` | API 幂等结果保留时间 |
| `CAMPUS_API_AUDIT_FILE` | API 审计文件位置 |
| `CAMPUS_IDEMPOTENCY_FILE` | API 幂等状态文件位置 |
| `CAMPUS_COURSE_ROLLBACK_WINDOW_MINUTES` | 选课自动回滚时间窗 |
| `CAMPUS_COURSE_JOURNAL_FILE` | 选课事务恢复日志位置 |

任何密钥都不能提交到代码仓库或写入前端构建产物。

## 8. 验证

项目测试：

```powershell
npm test
python -m unittest discover -s openclaw-workspace/tests -v
```

当前自动化覆盖：

- 签名令牌有效、篡改和过期检查；
- 幂等重放、内容冲突和并发持久化；
- API 强制幂等键；
- 请假记录隐私脱敏；
- 学生无权执行选课回滚或查看审计；
- API、请假和选课审计哈希链校验；
- 请假创建与取消幂等；
- 选课提交与回滚幂等；
- 选课跨文件部分写入后的自动补偿恢复。

## 9. 尚未替代的生产能力

本基线提高了本地 Demo 的安全性，但正式上线前仍需要：

- 接入学校统一身份认证和服务端会话；
- 使用数据库事务替换多文件 JSON 写入；
- 将审计证据异地发送到只追加或 WORM 存储；
- 配置集中密钥管理和密钥轮换；
- 建立管理员审批、双人复核和异常告警；
- 对回滚权限、时间窗和教务规则进行正式业务确认；
- 完成渗透测试、数据合规评审和灾难恢复演练。
