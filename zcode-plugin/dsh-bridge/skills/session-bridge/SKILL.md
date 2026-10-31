---
name: session-bridge
description: 跨端会话桥接工作流。当用户要跨客户端迁移/导入/导出会话、拉取 DSH/Codex/Zcode/Claude Code/WorkBuddy 的历史上下文继续干活、把当前对话存回某个客户端、或查看各端会话列表与状态时使用。
---

# 会话桥接（dsh-bridge）

本技能把 DeepSeek Harness 插件「会话桥接」的 UI 功能（跨端转换对话框、导入/导出、上下文预算选择、客户端状态页）转换为模型可直接执行的工作流。底层是 dsh-bridge MCP 的 7 个工具；MCP 未加载时提示用户安装/启用 dsh-bridge 插件。

## 工具速查（DSH 插件功能 → MCP 工具）

| DSH 插件功能 | MCP 工具 | 说明 |
|---|---|---|
| 会话列表 | list_sessions | 按 client/query/cwd/limit 过滤，返回 Markdown 表格 |
| 上下文预览 + 预算选择 | get_context | 压缩成可用 Markdown；长度双维度：budget/model + maxTurns |
| 跨端转换对话框 | transfer_session | 传 budget/model/maxTurns/focus 任一即压缩导入（长度可自定义） |
| 导出对话框（存回） | push_context | 把当前对话写为目标端新会话 |
| 快速了解历史 | summarize_session | 只出大纲 + 摘要；支持 budget 字符串与 maxTurns |
| 设置页/客户端状态 | list_clients | 五端检测状态、能力矩阵、未检测原因 |
| 模型预算表 | list_models | 上下文长度预设（用于 get_context 的 model 参数） |

## 铁律

1. **会话 ID ≠ 标题**。list_sessions 表格里的「会话 ID」列才是要传的值（长字符串）。用户说「那个关于 XX 的会话」时：先 list_sessions 用 query 过滤标题，向用户确认后取 ID。
2. **长度自定义双维度**：①token——`budget`（数字或 '92k' / '1.2万' 字符串）或 `model`（按模型窗口自动定），优先级 budget > model > 默认 200k；②轮数——`maxTurns: N` 只保留最近 N 轮。用户说「只拉最近几轮」「压到 8k」时用对应参数。
3. **transfer_session 两种导入**：不传压缩参数=完整导入（保留对话结构）；传 budget/model/maxTurns/focus 任一=压缩导入（单轮上下文文档，超大源会话导小窗口目标端用）。压缩导入的统计要汇报给用户。
4. **transfer_session 返回的「已知损失」必须逐条转述给用户**（如加密内容占位、子代理降级），不能只报成功。
5. **push_context 的 messages 要结构化**：role 只能是 user/assistant/tool；代码块、命令、路径、报错逐字保留，不要改写压缩。
6. 所有报错都是中文，原文转述即可，不要自行猜测原因。

## 典型流程

### A.「把我在 XX 里的那个会话拉进来」
1. `list_sessions({ client, query })` 找到候选，给用户看标题 + 轮次 + 时间确认是哪一个
2. `get_context({ client, sessionId, model })` 拉取上下文
3. 直接基于返回内容继续用户当前任务；开头 HTML 注释含来源/预算/压缩统计，可简要汇报

### B.「把这个会话转到 YY」
1. 找到源会话 ID（同上确认）
2. `transfer_session({ from, fromId, to })`
3. 报告：目标会话 ID、写入位置、记录数、已知损失
4. 提醒：部分客户端需要重启/刷新后才显示新会话

### C.「把现在这段对话存到 ZZ」
1. 把对话整理成 messages 数组：每轮用户输入 `{role:"user"}`，关键回复 `{role:"assistant"}`，重要工具输出 `{role:"tool"}`；技术细节逐字保留
2. `push_context({ target, title, cwd, messages })`，cwd 用当前工作目录
3. 报告新会话 ID 与位置

### D.「我有哪些会话 / 各端什么状态」
- `list_sessions` / `list_clients`，把 Markdown 表格直接展示给用户

## 环境要求与排查

- Node ≥ 22.19 或 ≥ 24（依赖内置 node:sqlite）
- 某端显示未检测到：先确认该客户端已安装且至少使用过一次，再用 list_clients 看 reason 字段原文
- 同名 MCP 重复注册（如手动配置过 dsh-bridge）：保留一份即可，插件已内置 MCP，手动配置可删除
