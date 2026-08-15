# dsh-chat-window-fold

[![npm version](https://img.shields.io/npm/v/dsh-chat-window-fold)](https://www.npmjs.com/package/dsh-chat-window-fold)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Release](https://github.com/dove-a/dsh-chat-window-fold/actions/workflows/release.yml/badge.svg)](https://github.com/dove-a/dsh-chat-window-fold/actions)

DSH web GUI 插件：聊天窗口自动折叠/展开（对系统自带的分页窗口的增强）。

## 行为（冻结规格）

- **判定点（checkpoint）**：以「会话累计事件数 N」为钟，每 `foldCheckEvery`（默认 25）个事件一个判定点；前两次（N=25、N=50）跳过，自 **N=75** 起判定。
- **折叠**：判定点到来时，若视口处于聊天滚动区**底部**（容差 ≤4px）且已加载窗口行数 **> `foldThreshold`（默认 50）**，则**隐藏最近 50 条以外的既有行**（幂等：无可隐藏则不动作）。折叠后不常驻维护，新消息自然累计，由下一个判定点处理。
- **展开**：用户滚动到**最顶部**（≤4px）且 `hasMore` 为真 → 经 `loadOlder` 追加前置 **≤50 条**，并**锚定视口**（画面位置不变化）。再次贴顶继续追加，直到 `hasMore=false` 停止。折叠掉的页面会先恢复显示，再加载更新的一页。
- **系统按钮**：插件激活时隐藏系统 "Load earlier" 按钮（滚动触发已替代手动翻页）。
- **多会话隔离**：全部状态按会话独立（组件挂在会话作用域槽位），不同 DSH 会话互不影响；宿主历史数据只读，始终完好。
- **无 UI 开关**；阈值与周期经**行 config** 可配：`foldThreshold`（默认 50）、`foldCheckEvery`（默认 25）。

## 安装

本地安装（`file:` 依赖）：

```bash
# 1) 把插件目录放进任意位置（如 D:\AI\DSH_work\plugins\dsh-chat-window-fold）
# 2) 在 web profile 中声明为 bundle 并安装依赖：
cd ~/.dsh/profiles/web
npm i D:\AI\DSH_work\plugins\dsh-chat-window-fold
# 3) 在 profiles/web/package.json 的 dsh.profile.bundles 中加入 "dsh-chat-window-fold"
# 4) 重启 DSH，验证：dsh web --dump-config 组合树中出现 chat-window-fold 行
```

其中 `cordis.patch.yml`（bundle patch）插入客户端插件行，浏览器半经 `dsh.client` 声明在
`/plugins/dsh-chat-window-fold/client.js` 加载。

## 卸载 / 恢复

1. 从 `profiles/web/package.json` 的 `dsh.profile.bundles` 移除 `"dsh-chat-window-fold"`；
2. `cd ~/.dsh/profiles/web && npm uninstall dsh-chat-window-fold`；
3. 若之前手动改过 `cordis.patch.yml`（行 config），删除对应行即可恢复系统按钮与原生分页。

## 验证

```bash
node --check lib/client.js && node --check lib/index.js   # 语法
node test/sandbox-load.test.cjs                            # 沙箱加载（mock loader+react，校验 exports 协议）
```

注：`lib/index.js` 依赖 schemastery——本地开发时需在插件目录 `pnpm install` 一次（host 半启动即解析该依赖，缺失会导致 DSH 启动失败）。

## 发布到 npm

```bash
cd D:\AI\DSH_work\plugins\dsh-chat-window-fold
npm publish --access public
# 之后远程安装（示例）：
npm i -S dsh-chat-window-fold   # 在 profiles/web 下执行
```

## 限制与说明

- 折叠为**显示层**实现（隐藏窗口外行；展开从宿主重拉/恢复显示）。宿主与 runtime 的窗口数据按
  只读协议保持完好，不影响模型上下文；runtime 未暴露窗口截断 API，因此隐藏行仍驻留浏览器内存
  （display:none 不参与布局）。若未来 `client-runtime` 提供 `replaceWindow` 类公开入口，可切换为真裁剪。
- 判定即「25 事件一次比较」，无常驻维护；窗口实际峰值约为 50+25=75 行 < 80，低配机器友好。
- 依赖本版本 uic-conversation 的槽协议（`conversation.input.dock` 标准 props：
  `sessionId`/`useSession`）与 DOM 挂点（`[data-conversation-scroll]`、`[data-chat-flow]`、
  `[data-chat-anchor-key]`、`[data-composer-seat]`）。