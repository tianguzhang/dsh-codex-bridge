---
description: 列出各客户端的历史会话（dsh-bridge）
argument-hint: [关键字] [客户端: dsh|codex|zcode|claude-code|workbuddy]
---

用 dsh-bridge MCP 的 list_sessions 列出历史会话。参数「$ARGUMENTS」处理：

- 若某段是客户端名（dsh/codex/zcode/claude-code/workbuddy/doubao），作为 client 传入；否则不传，列六端
- 其余文本作为 query（匹配标题或工作目录，不区分大小写）
- limit 默认 20；用户要求更多时提高（上限 100）

返回表格后提示用户：可用 `/dsh-bridge:bridge-context` 拉取某个会话的上下文，或用 `/dsh-bridge:bridge-transfer` 转换到其他端。若出现「部分客户端读取失败」，把错误原文转述。
