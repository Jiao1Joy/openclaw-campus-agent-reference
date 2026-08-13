# Campus Skill JSON-stdio 契约

入口从标准输入读取一个 `campus-skill-input@1` JSON 对象，并向标准输出写入一个 `campus-skill-output@1` JSON 对象。禁止在标准输出打印诊断日志；诊断仅写标准错误。

## 输入字段

- `invocationId`、`requestId`：调用关联编号；
- `capabilityId`、`operation`：必须与 `capability.json` 声明一致；
- `actor.subject`：受信身份的不可逆标识，不是完整学号；
- `actor.roles`：运行时验证后的角色；
- `session.id`、`session.now`：会话与当前时间；
- `authorization.confirmed`：是否已取得明确确认；
- `arguments`：本 operation 的业务参数；
- `idempotencyKey`：声明为幂等的写 operation 必填。

## 输出字段

- `invocationId`、`operation` 必须原样关联输入；
- `ok` 表示工具是否成功，不表示后续人工审批完成；
- `state` 仅允许 `collecting`、`awaiting-input`、`awaiting-confirmation`、`completed`、`cancelled`、`failed`；
- `message` 为用户可读文本；
- `data` 为结构化 JSON；
- `cards` 可选，必须符合统一白名单卡片协议；
- `evidence` 可选，只返回结果引用或审计引用；
- `error` 在 `ok=false` 时必填，包含 `code`、`message`、`retryable`。

输入最大 32KB，输出最大 64KB。不得返回访问令牌、完整身份、方案令牌、任意 HTML、脚本或未经允许的 URL。
