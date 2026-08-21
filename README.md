# OpenClaw 智能校园助手（校园场景 Demo）

本项目用于拓展和演示 OpenClaw 在智能校园场景中的 Agent 能力。校园门户是演示外壳，请假、选课和知识问答是本地 Demo Skill；项目重点是技能编排、工具执行、确认、权限、证据、恢复和可观测性，而不是建设真实学校业务系统。

“云川大学”仅为演示租户。学生、课程、教师、制度和办理记录均为 Demo 数据，不代表真实学校。

当前公开快照由三个内部工程仓库的统一 `v1.0.0-demo` 标签脱敏合并而成，包含学生端、管理端、学生 Agent、管理员 Agent、Router Agent、确定性审批服务、演示数据和评测证据。仓库不包含模型凭据、管理员密码、本机 OpenClaw 配置、SQLite 运行库、会话、memory、日志或审计运行记录。

## 公开仓库结构

- `src/`：校园门户、学生助手和管理端界面；
- `server/`：校园 API、Router、任务状态、确认快速通道、管理员 Agent 桥接、权限、幂等、审计和 Trace；
- `openclaw-workspace/`：学生 Agent、管理员 Agent、Skills、本地知识、Demo 数据和确定性 `campus-services`；
- `openclaw-workspace/router-workspace/`：独立 Router Agent 工作区；
- `evals/`：148 条路由评测集、评测器以及 Qwen/Llama 3.1 8B 的脱敏评测证据；
- `docs/`：自动请假审批的开发方案与阶段文档。

当前提供两种运行方式：

- Vite 一体化开发模式：前端和 API 使用同一开发服务器；
- 独立部署模式：静态前端位于 `dist/`，独立 API 位于 `dist-server/`。

## 环境要求

- Node.js 22 或更高版本；
- Python 3.11 或更高版本；
- 已安装并配置 OpenClaw；
- `CAMPUS_WORKSPACE` 指向校园 Agent 工作区。

## 开发运行

```powershell
npm install
npm run dev
```

开发模式继续使用 Vite 校园助手插件，默认地址为 `http://127.0.0.1:5173`。

## 管理端（/admin）与请假自动审批

学生端与 `/admin` 管理端共用 Web/API 服务，但 OpenClaw Agent 完全分离：学生 `campus` Agent 只收集并写入请假；独立 `campus-admin` Agent 通过专属 `campus-auto-approval` 确定性 Skill 处理审批任务。低风险申请自动批准，其余转人工复核，系统永不自动驳回。

管理员登录后可访问 `/admin/assistant`。该页视觉与学生校园助手保持一致，但会话固定发送给 `campus-admin`，不复用学生 Agent 上下文。

数据库监听器默认直接调用管理员 Agent 专属 Skill（`CAMPUS_ADMIN_APPROVAL_MODE=skill-direct`），避免将审批可用性绑定到模型延迟。如需演示 OpenClaw 模型回合后再调用 Skill，可设为 `openclaw`；审批结论仍只以 Skill 回写数据库的结果为准。

首次运行前初始化演示数据库（写入 `openclaw-workspace/data/campus-demo.sqlite3`，幂等可重复执行）：

```powershell
node %CAMPUS_WORKSPACE%\campus-services\src\bin\initDemoDb.ts
```

如需完整演示数据（1 所学校、6 学院、24 班级、480 学生、600 条请假），先在 `openclaw-workspace` 生成种子，再通过管理端「Demo 工具 → 导入演示数据」导入：

```powershell
cd %CAMPUS_WORKSPACE%\campus-services
node src\bin\generateSeed.ts
```

管理端登录使用 `.env` 中的账号（仓库不包含默认密码）：

```text
CAMPUS_DEMO_ADMIN_USERNAME=campus-admin
CAMPUS_DEMO_ADMIN_PASSWORD=<本地演示密码>
CAMPUS_DEMO_ADMIN_TOKEN_SECRET=<至少32字节，未设置时回落 CAMPUS_AUTH_SECRET>
```

访问 `http://127.0.0.1:5173/admin` 登录。访问令牌仅保存在页面内存中，刷新后需重新登录；管理操作全部写审计并受幂等键保护。

## 独立构建和运行

构建前端和后端：

```powershell
npm run build
```

构建产物：

```text
dist/                    静态前端
dist-server/standalone.js  独立校园 API
```

复制 `.env.example` 中的配置到实际运行环境。共享演示环境应设置高强度身份和审计密钥，不能继续使用 `demo` 身份模式。

启动独立 API：

```powershell
npm run start:server
```

默认监听 `127.0.0.1:8787`。健康检查：

```text
GET http://127.0.0.1:8787/api/campus-assistant/health
```

读取当前身份可用的 OpenClaw 能力清单：

```text
GET http://127.0.0.1:8787/api/campus-assistant/capabilities
```

能力清单统一声明 Skill 版本、读写属性、角色、确认要求、幂等、审计、回滚和结果卡片。门户中的能力入口由该接口动态生成，不再硬编码三项 Demo 名称。

每轮聊天现在先调用独立的 OpenClaw `campus-router` Agent，由 Qwen 27B LLM 根据能力清单、当前未完成执行和用户自然语言，返回受约束的能力选择、动作与结构化参数。正则清单不再作为生产主路由；服务端只接受已授权能力 ID 和协议内字段，低置信度结果进入通用对话。写入前的明确确认、权限、幂等和审计仍由服务端二次检查，不能被模型绕过。

读取某个会话当前的通用执行状态：

```text
GET /api/campus-assistant/executions/current?sessionId=<会话编号>
```

执行状态覆盖收集信息、等待选择、等待确认、执行中、成功、取消、失败和过期。状态保存在 `openclaw-workspace/data/executions/campus-executions.json`，服务重启后可恢复；对外响应不会返回用户标识哈希或方案令牌等内部上下文。

查询本轮或整个执行任务的脱敏运行过程：

```text
GET /api/campus-assistant/traces/<requestId>
GET /api/campus-assistant/executions/<executionId>/traces
```

Trace 记录 `openclaw-router` 的 LLM 意图理解、能力选择、OpenClaw/确定性工具阶段、分层耗时、执行状态、错误位置和幂等重放。它不记录对话正文、完整学号、访问令牌、请假原因、幂等键或方案令牌。普通用户只能读取自己的 Trace；`campus-auditor` 可以按审计权限跨身份查询。门户中的“本次助手如何完成”面板会显示这些安全事件。

## 统一结果卡片协议

聊天接口使用 `cards[]` 返回结构化结果，目前允许四种卡片：

- `teacher-choice`：由选课规则引擎结果和本地 Demo 数据生成；
- `knowledge-source`：由确定性知识检索引擎的 `answerable=true` 结果生成；
- `action-result`：由通用执行状态生成。
- `orchestration-summary`：展示多个 Skill 的步骤、课程影响、缺失参数和 Demo 边界。

卡片只允许协议白名单字段和 `send-message` 动作，知识来源链接只允许空值或 HTTPS，并限制文本、数组和卡片数量。卡片不能由模型文本直接创建；旧的 `[[TEACHER_CHOICES]]`、`[[KNOWLEDGE]]` 标记以及专用响应字段已经移除。

## Skill 开发标准

能力注册表 2.0 从 `openclaw-workspace/skills/*/capability.json` 自动发现已启用 Skill。Manifest 统一声明路由、角色、确认、幂等、审计、回滚、入口、operations、卡片类型和输入输出契约。新增 Skill 使用 `campus-skill-input@1` / `campus-skill-output@1` JSON-stdio 信封；运行时会在进程启动前拦截越权、未确认写入和缺少幂等键，并在返回后校验输出与卡片。

模板、复制流程和约束见 [`SKILL_DEVELOPMENT.md`](./SKILL_DEVELOPMENT.md)。`npm run validate:skills` 已接入生产构建。

## 多 Skill 编排 Demo

`campus-leave-impact` 是首个正式 JSON-stdio 编排 Skill。用户可以询问“请假会错过哪些课”，系统会按顺序调用课程查询和请假预览，生成统一编排卡片；此阶段只读，不产生申请。日期、请假类型、原因和精确起止时间齐全后进入等待确认，只有用户发送明确的“确认提交”等确认语句，才移交 `campus.leave` 执行写入。

“上午/下午”可以缩小只读课程查询范围，但不能替代写入所需的精确时间。编排失败会把执行状态落为失败；确认提交仍受权限、幂等、审计、超时和请假引擎证据约束。完整说明见 [`MULTI_SKILL_ORCHESTRATION.md`](./MULTI_SKILL_ORCHESTRATION.md)。

## 前后端分离配置

前端构建时设置：

```text
VITE_CAMPUS_API_BASE_URL=https://campus-api.example.edu
```

后端设置允许访问的前端来源，多个来源使用逗号分隔：

```text
CAMPUS_ALLOWED_ORIGINS=https://campus.example.edu,https://campus-test.example.edu
```

未配置允许来源时，独立 API 只接受与请求 Host 相同的浏览器 Origin；没有 Origin 的服务端请求仍可访问，但必须通过身份验证。

## 可选身份适配

OIDC/JWKS 已作为 OpenClaw 受信上下文的可选适配能力实现。当前 Demo 不要求接入真实学校 SSO；未来需要对接时，后端只读取 OIDC 公钥，不需要身份系统的私钥：

```text
CAMPUS_AUTH_MODE=oidc
CAMPUS_OIDC_ISSUER=https://sso.example.edu
CAMPUS_OIDC_AUDIENCE=campus-api
CAMPUS_OIDC_JWKS_URI=https://sso.example.edu/.well-known/jwks.json
```

OIDC 令牌要求使用 `RS256`，并校验签发方、受众、过期时间、生效时间和 `kid`。学校字段名称不一致时可配置：

```text
CAMPUS_OIDC_STUDENT_ID_CLAIM=sub
CAMPUS_OIDC_NAME_CLAIM=name
CAMPUS_OIDC_COLLEGE_CLAIM=college
CAMPUS_OIDC_CLASS_NAME_CLAIM=className
CAMPUS_OIDC_ROLES_CLAIM=roles
```

字段路径支持点号，例如 `student.id` 或 `realm.roles`。

前端统一通过 `src/services/campusApi.ts` 请求 API，学校 SSO 适配器获得短期访问令牌后调用：

```ts
setCampusAccessToken(shortLivedToken);
```

令牌仅保存在页面内存中，不写入 `localStorage`。退出登录时调用 `clearCampusAccessToken()`。

前端可调用 `getCampusSession()` 检查当前登录状态；服务端仅返回学号末四位、姓名、院系、班级和角色。

`token` 自签名模式仅保留给封闭测试环境。未来接入真实身份系统时，正式令牌应由身份服务签发，前端不能持有任何签名密钥。

## 演示入口

- 校园助手聊天是请假和选课的真实 Demo 写入入口；
- 请假弹窗只负责整理信息，然后转入校园助手完成摘要确认；
- 选课弹窗只记录浏览意向，然后转入确定性选课引擎；
- 页面不再通过本地延迟或数组修改声称请假、选课已经提交。

## Agent 工具边界

`campus` Agent 使用 OpenClaw `minimal` 工具配置，只额外允许 `read` 和 `exec`，用于读取当前隔离工作区的 Skill 文档并执行 Skill 中声明的本地脚本。飞书、网络搜索、消息发送和其他外部工具未向该 Agent 开放。

## 测试

```powershell
npm test
python -m unittest discover -s openclaw-workspace/tests -v
```

测试使用临时目录，不修改真实请假和课程记录。

## 安全与运维

权限、超时、幂等、审计、回滚和事务恢复说明见：

- [`SECURITY_BASELINE.md`](./SECURITY_BASELINE.md)
- [`NEXT_STEPS.md`](./NEXT_STEPS.md)

当前是 OpenClaw 能力演示版。真实学校身份、数据和业务系统接入均不在当前阶段范围内；后续开发路线以 OpenClaw 能力拓展为主。
