# dsh-bridge（Zcode 插件）

[dsh-codex-bridge](https://github.com/tianguzhang/dsh-codex-bridge) 的 Zcode 插件层：把 DeepSeek Harness 插件「会话桥接」的全部能力搬到 Zcode——MCP 同功能 + UI 功能转技能/命令。

## 组件

| 组件 | 内容 |
|---|---|
| MCP（7 工具） | `server/mcp-stdio.js`（自包含产物，仅依赖 Node 内置模块），由 `.mcp.json` 声明，安装即用 |
| 技能 `session-bridge` | DSH 插件 UI 功能的完整工作流映射（转换对话框/导入导出/预算选择/状态页 → 工具调用规则） |
| 命令 ×5 | `/dsh-bridge:bridge-sessions`、`bridge-context`、`bridge-transfer`、`bridge-save`、`bridge-status` |

功能对照（DSH 插件 → 本插件）：

| DSH UI | 这里 |
|---|---|
| 跨端转换对话框 | `transfer_session` 工具 + `/dsh-bridge:bridge-transfer` |
| 导入/导出对话框 | `push_context` / `transfer_session` + `/dsh-bridge:bridge-save` |
| 上下文预览 + 预算选择 | `get_context`（budget > model > 默认 200k）+ `/dsh-bridge:bridge-context` |
| 客户端状态/设置页 | `list_clients` / `list_models` + `/dsh-bridge:bridge-status` |

## 环境要求

- Node ≥ 22.19 或 ≥ 24（依赖内置 `node:sqlite`）
- 六端客户端（DSH/Codex/Zcode/Claude Code/WorkBuddy/豆包）按需：被读取/写入的那一端要安装过且至少使用过一次；豆包只读（云端会话，可导出不可写入）

## 安装（本地开发市场）

1. Zcode → Plugin Marketplace → Add → Add Plugin Marketplace，粘贴本仓库的 `zcode-plugin/` 目录
2. 在市场「dev-dsh-codex-bridge」里安装 **会话桥接（dsh-bridge）**
3. 重启 Zcode 后 MCP 工具以 `mcp__dsh-bridge__*` 出现，技能/命令以 `dsh-bridge:` 前缀出现

> 如果你之前手动配置过名为 `dsh-bridge` 的 MCP server（如 `~/.zcode/cli/config.json`），装本插件后请删除手动配置，避免同名重复注册。

## 维护

产物同步规则：`plugin/lib/mcp-stdio.js` 是唯一来源，`server/mcp-stdio.js` 是它的副本（安装后整目录拷贝进 Zcode 缓存，因此必须自包含）。

```bash
# 手动同步（仓库根目录）
node scripts/sync-zcode.mjs

# 或随 DSH 插件构建自动同步
cd plugin && npm run build   # build 链已接入 sync-zcode
```
