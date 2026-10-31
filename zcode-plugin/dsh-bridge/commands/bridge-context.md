---
description: 拉取某个客户端会话的上下文（dsh-bridge）
argument-hint: <客户端> <会话ID或标题关键字> [预算或模型]
---

用 dsh-bridge MCP 的 get_context 把历史会话变成可继续工作的上下文。参数「$ARGUMENTS」按空格拆分：

1. 第 1 段：client（dsh/codex/zcode/claude-code/workbuddy）
2. 第 2 段：sessionId。若不是长 ID 而是标题关键字，先调 list_sessions 过滤拿到真实「会话 ID」，多个候选时向用户确认
3. 第 3 段（可选）：纯数字 → budget；含字母 → model（如 glm-5、claude-sonnet-4-5）

然后调用 get_context。返回的 Markdown 直接作为工作上下文使用，不要整段复述给用户；开头 HTML 注释里有来源、预算、压缩统计，用一两句话汇报即可。
