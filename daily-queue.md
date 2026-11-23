# MohoBot 每日一件任务队列

每天做一件，做完在对应行打勾并写上日期和提交 SHA，再提交推送。
顺序按下面来，做完 5 件就停，等 Billy 给新任务。

- [x] 1. 平台页（Platforms）：把 AstrBot 的 PlatformPage 接到 MohoBot 的平台/网关接口上，验证构建和类型检查，提交并推送。—— 2026-11-23，e9aa3a0
- [ ] 2. 人设页（Persona）：把 AstrBot 的 PersonaPage 接到 MohoBot 的角色接口上，验证构建和类型检查，提交并推送。
- [ ] 3. 知识库页（Knowledge-base）：把 AstrBot 的知识库页接到 MohoBot 的知识库接口上，验证构建和类型检查，提交并推送。
- [ ] 4. 配置发布（Config publishing）：把 AstrBot 的配置页接到 MohoBot 的配置发布接口上，验证构建和类型检查，提交并推送。
- [ ] 5. MCP 写操作（MCP write side）：给控制台补上 MCP 添加服务器等写操作（后端目前只有读和调用接口，缺什么先记下来，不要自造接口），验证构建和类型检查，提交并推送。

## 规则

- 每次只做队列里第一个未打勾的任务，不要多做。
- 开工前先查免费额度（`subscription-status status`）：周额度用了 80% 或以上就停手，只汇报，不做事。
- 工作目录 ~/workspace/mohobot，git 身份 repo-local：carefreesongs712 <carefreesongs@163.com>，不签名（commit.gpgsign=false）。
- 改完跑 dashboard 构建和类型检查，通过了才提交推送（`git push origin master`，gh 已登录 thepiationesl）。
- 不要碰 `~/MEMORY.md`，进展写进 `~/memory/YYYY-MM-DD.md` 当日日志。
- 全部 5 件做完后，在汇报里说队列已空，等 Billy 给新任务。
