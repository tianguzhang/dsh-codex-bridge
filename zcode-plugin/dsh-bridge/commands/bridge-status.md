---
description: 查看五端客户端状态与模型预算预设（dsh-bridge）
---

依次调用 dsh-bridge MCP 的 list_clients 和 list_models，把两个 Markdown 表格合并展示：客户端检测状态、能力矩阵、未检测原因 + 模型上下文预算预设。

对未检测到的端，把 reason 原文转述，并提示排查方向：该客户端需已安装且至少使用过一次；Node 需 ≥ 22.19 或 ≥ 24。
