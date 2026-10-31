---
description: 跨端转换历史会话（dsh-bridge）
argument-hint: <源端> <会话ID> <目标端> [新标题]
---

用 dsh-bridge MCP 的 transfer_session 做端到端会话转换。参数「$ARGUMENTS」按空格拆分：

- 第 1 段 → from，第 2 段 → fromId，第 3 段 → to，其余合并为覆盖标题 title
- fromId 若不像长 ID（像标题/关键字），先调 list_sessions 确认拿到真实「会话 ID」
- from 与 to 相同时不要调用，直接提示用户源端与目标端相同

调用后必须完整报告：目标会话 ID、写入位置、记录数，以及返回的「已知损失」逐条原文转述；再提醒部分客户端需重启/刷新后可见。
