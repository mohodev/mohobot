# MohoBot 代码审计（2026-08-13）

## 已验证基线

- `npm run typecheck`：通过
- `npm test`：153/153 通过
- `npm run build`：通过

## 本轮已修复

### Critical

- 从当前工作树移除 `config/global.yaml` 中疑似真实 Kilo Token。
  - **外部动作仍需人工完成：** 在 Kilo 后台吊销/轮换；普通 Git 删除无法清除历史。

### High

- 插件 ID 拒绝 `..`、绝对/嵌套路径。
- 插件 `main` 入口限制在插件目录内，并检查符号链接真实路径。
- 修复 `plugin.json.config` 被解析后丢弃的问题。
- 插件 `onLoad` 失败时回收 staged 命令和四类 Registry 注册，避免幽灵扩展泄漏。
- `devtools` 默认关闭；其 AI 压测、注入和跨频道发言能力不应直接暴露给普通用户。

### Correctness / reliability

- 同一会话消息按到达顺序串行执行，防止 AI 回复乱序写入历史。
- 会话持久化写入串行化，防止较慢旧快照覆盖新快照。
- Discord/Console 入站聊天日志统一在 Gateway 写入，消除 Discord 双写。
- Discord 只记录通过 blocked/allowlist/mention/DM 过滤并进入管线的消息。
- 未知 Provider 不再在 credential 检查阶段抛错，而是按文档回退。
- Provider 单次调用的 timeout override 会显示正确超时值。
- 修复 Provider 配置优先级：`global.yaml` 覆盖 `data/provider.yaml`。
- `data/provider.yaml` 变更可被热重载识别。
- NPM 包恢复 `private: true`，避免误发布。

## 仍需处理

### High

- 对管理类插件命令实现统一权限模型（管理员用户/角色 allowlist、频道限制、命令级限流）。仅默认关闭 devtools 不是最终权限方案。
- 清理 Git 历史、CI Artifact、镜像和备份中的泄露 Token，并加入 secret scanning。

### Medium

- 插件 Promise 超时只能停止等待，无法强制终止 JS 任务；需要 `AbortSignal` 与副作用生命周期令牌。
- `chat_log` 需要配置化保留周期、容量上限、用户删除与查询权限。
- Runtime 热重载只重启已存在 Bot；新增/删除 Bot 仍要求进程重启。
- 全局配置（存储、日志级别、Supervisor、监听路径）改变后未动态重建相关组件。
- 管理 WebUI、角色、世界模拟、行为引擎、MCP、真实长期记忆仍未实现，不能继续标记为完成。

## 安全原则

- 密钥只进入环境变量或专用 secret manager，不进入 YAML、注释、日志、截图或测试 fixture。
- 管理能力默认关闭；启用时最小权限、显式 allowlist、完整审计。
- 插件视为进程内受信代码，不是安全沙箱；安装插件等同执行代码。
