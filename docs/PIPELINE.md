# Message Pipeline module boundaries

核对日期：2026-11-14。本文描述当前 src/pipeline/ 实际代码边界；业务行为仍由现有集成测试定义。

## Orchestration

pipeline.ts 是消息生命周期编排器：平台事件进入、权限/隐私门、优先级和社交决策、任务取消、模型调用与最终持久化。它应协调模块，不再吸收独立的状态机、格式化器和客户端协议循环。

## Extracted modules

| Module | Responsibility | Must not own |
|---|---|---|
| bridges.ts | Runtime 对 Usage/Song/Broadcast/Emotion/Persona-A/B 服务的窄接口 | 具体 Service 生命周期、平台 SDK |
| conversation-context.ts | 持久化当前 user turn、构建 session window、注入 world/memory/media/emotion/song/persona、标注不可信来源、调用 beforeAI hook | 是否回复、社交决策、Provider 请求 |
| chat-with-tools.ts | 无工具时原样走 Provider；有工具时执行有界 tool loop、allowlist、记录 tool-call trace | 决定是否向用户回复、直接发送消息 |
| reply-delivery.ts | ReplyPlan 分段/延迟/过滤、单条消息投递、delivery 状态/日志/trace 对账 | 模型生成、上下文构建 |
| streaming-delivery.ts | 缓冲 provider deltas，按句子/长度边界顺序投递 | 模型协议解析、会话存储 |
| rate-limiter.ts | 每 key 滑动窗口限流 | 用户/频道决策策略 |
| context-prompts.ts | 时间锚点和历史摘要 system block 格式化 | Session 的读写 |
| command-tokens.ts | 中文管理命令别名与 A/B 投票 token 规范化 | 管理命令权限、实际执行 |
| reply-plan.ts | ReplyPlan 解码、展示文本和 delivery segments | 平台实际投递 |

## Required invariants

1. 入站消息应先 append 到 Session，再 buildContext；不能把当前消息漏掉，也不能改变历史顺序。
2. persona system message 是第一个 system block；时间锚点、world、jargon/history/memory/media/emotion/song blocks 按既有顺序注入。
3. 用户输入和 recalled memory 必须作为 untrusted data 包装，不能仅靠 system prompt 文字声明信任边界。
4. 插件 beforeAI 在上下文构建之后运行，afterAI 在生成之后运行。
5. 没启用工具或没有通过 allowlist 的工具时，应走原 Provider 单次调用路径；有工具时强制非流式并受 maxRounds 限制。
6. 回复仍然只能以 ReplyPlan 协议进入 delivery；mass mention 保护、分段、typing/pause、失败状态与日志必须保持。
7. 不确定投递必须保留 unknown 状态，不能将“请求已发出”误报为“已送达”。

## Verification

当前重构门禁：

- Context builder、streaming delivery、rate limiter、context prompt、command token 有独立单元测试。
- pipeline.test.ts、pipeline-tools.test.ts、pipeline-history-summary、Discord chat-log、ReplyPlan/filter、Console acceptance tests 覆盖端到端行为。
- 根 npm test 同时执行 Runtime 和 React Dashboard 测试。

将来继续拆分 Pipeline 时，优先通过依赖注入和 characterization tests 搬迁逻辑；不得同时改变优先级、隐私、记忆 scope、工具授权或 delivery 语义。
