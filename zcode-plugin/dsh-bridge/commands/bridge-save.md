---
description: 把当前对话写回目标客户端存为新会话（dsh-bridge）
argument-hint: <目标端> [标题]
---

用 dsh-bridge MCP 的 push_context 把本会话当前进展写为目标端（$ARGUMENTS 第 1 段，dsh/codex/zcode/claude-code/workbuddy；豆包为云端会话不支持作为写入目标）的新会话，其余参数作为标题。

步骤：

1. 把对话整理成 messages 数组：每轮用户输入一条 `{role:"user"}`，你的关键回复一条 `{role:"assistant"}`，重要工具输出用 `{role:"tool"}`；代码块、命令、文件路径、报错逐字保留，不要改写
2. cwd 用当前工作目录，title 缺省时按对话主题拟一个简短中文标题
3. 调 push_context，报告新会话 ID 与写入位置；失败时把中文错误原文转述
