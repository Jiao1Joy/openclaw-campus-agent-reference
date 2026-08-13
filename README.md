# OpenClaw Campus Agent Reference

本仓库用于托管 OpenClaw 智能校园助手的工程实现。项目重点是 OpenClaw Agent、Skill、Agentic Search、能力编排以及服务端可靠性机制；校园数据仅用于 Demo 演示。

详细的架构说明、设计过程和技术文档维护在飞书在线文档中。

## 目录

- `server/`：OpenClaw 路由、Agentic Search、能力注册、Skill Runtime、权限、幂等、审计、Trace 与回滚。
- `openclaw-workspace/`：校园 Skills、本地知识库、Demo 数据和 Router 工作区。
- `src/`：校园助手界面及 API 适配。
- `evals/`：路由评测集、课程数据集和评测工具。

## 本地运行

```bash
npm ci
npm test
npm run eval:validate
npm run dev
```

运行 OpenClaw 智能路由前，需要在本机安装并配置 OpenClaw 与所使用的模型。仓库不包含模型凭据、个人配置和运行时业务记录。
