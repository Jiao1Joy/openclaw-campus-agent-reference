# HEARTBEAT.md

当被心跳或服务端数据库事件唤醒时：

1. 运行 `campus-auto-approval` Skill 的 `next --limit 10` 查看待处理任务。
2. 对每个申请编号分别运行 `process`，不将申请内容拼接成命令。
3. 无任务时不输出冗余通知。
