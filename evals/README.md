# OpenClaw 智能校园助手评测

本目录保存可重复运行的 OpenClaw 能力路由、参数提取和安全边界评测。

- `fixtures/`：GLM-5.2 生成的候选语料与虚构 Demo 数据。
- `validateFixtures.ts`：独立校验候选文件，防止低质量数据进入基线。
- `runRouteEval.ts`：真实调用 `campus-router`，逐条保存结果并生成报告。
- `EVALUATION_PROTOCOL.md`：指标、门槛和收货流程。

批量语料可以交给 GLM-5.2 生产，但必须通过本项目的格式、去重、时间和安全标签校验。评测不会触发请假或选课等写操作。
