# Changelog

本文件记录 dsh-chat-window-fold 的版本变更。

## [0.1.2] - 2026-08-15（待发布）

### 修复

- **事件源修正（运行时根因）**：折叠判定原先从会话快照的 `s.events` 读取累计事件数，实测发现会话快照并未暴露该字段（窗口数据只存在于 `s.chat = { order, nodes, timeline }`）——原实现下折叠可能从未触发。现改为读取 `s.chat.order`（窗口已加载的路由行序列，随消息/步骤完成与分页加载单调增长），折叠判定恢复实际生效。
- **计数语义对齐**：判定时钟由「最后事件 seq」改为「窗口已加载行数 `order.length`」，与「已加载窗口行数 > foldThreshold 才折叠」的规格门直接一致；`nextCheckpoint` 数学不变（前两次 25/50 跳过，自 75 起判）。
- **折叠门简化**：`maybeFold` 移除冗余的窗口级长度检查（窗口行数即渲染行数，DOM 行数判断已覆盖），保留幂等保护（已隐藏行跳过）。

### 测试

- 新增 `apply(ctx, config)` 契约回归：config 以**第二参数**到达（`dsh-cordis-client-runner` 协议）、显式 config 透传至注入的 owner props、缺省 config 回退默认值（50/25）、`sessions` 缺失时 apply 静默 no-op 不抛错。

## [0.1.1] - 2026-08-15

- 元数据：`repository`/`homepage`/`bugs` 指向 GitHub（dove-a/dsh-chat-window-fold）。
- 描述精简；README 改为使用者视角（安装/验证/卸载/配置/许可证），移除本地路径与发布小节。

## [0.1.0] - 2026-08-15

- 首版：聊天窗口自动折叠/展开（判定点折叠 + 贴顶锚定翻页 + 折叠页优先回归 + 多会话隔离 + 隐藏系统 Load earlier 按钮）。
- 支持行 config：`foldThreshold`（默认 50）、`foldCheckEvery`（默认 25）。
- 发布链路：GitHub Actions（`v*` 标签 → 验证 → npm publish → GitHub Release）。