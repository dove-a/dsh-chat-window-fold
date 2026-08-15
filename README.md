# dsh-chat-window-fold

[![npm version](https://img.shields.io/npm/v/dsh-chat-window-fold)](https://www.npmjs.com/package/dsh-chat-window-fold)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Release](https://github.com/dove-a/dsh-chat-window-fold/actions/workflows/release.yml/badge.svg)](https://github.com/dove-a/dsh-chat-window-fold/actions)

DSH Web GUI 插件：聊天窗口自动折叠/展开（对系统自带的分页窗口的增强）。

## 功能

- **自动折叠**：以「会话累计事件数」为钟（每 `foldCheckEvery` 个事件一个判定点，前两次跳过、自 N=75 起判定），当你滚动到底部且窗口已超过 `foldThreshold` 行时，把手眼神之外的早期消息悄然折叠，窗口始终保持在约 50 条（窗口峰值 <80，低配机器友好）。
- **贴顶展开**：滚动到最顶部时，逐批带回更早的消息（每次最多 50 条），**画面位置保持不动**；反复贴顶可一路追到最早的历史，直到 `hasMore` 为假自动停止。
- **折叠页优先回归**：折叠掉的页面会先恢复显示，再加载更新的一页，顺序不乱。
- **多会话隔离**：折叠/展开状态按会话独立，切换会话互不影响；宿主的历史数据只读、始终完好。
- **系统按钮隐藏**：激活后隐藏系统 "Load earlier" 按钮（滚动触发已替代手动翻页）。

## 安装

DSH 插件通过 `dsh plugin` 命令安装进 **profile**（`dsh web` 对应 `web` profile）。

### 方式一：从 npm 安装（推荐）

插件已发布到 npm，一条命令安装：

```sh
dsh plugin --profile web add dsh-chat-window-fold
```

装完重启 `dsh web` 即生效（`dsh plugin add` 自动完成依赖安装与 bundle 登记）。

### 方式二：从 GitHub 仓库安装（改代码调试）

仓库源码已随 npm 发布，此方式仅供开发调试（需要 Node.js 与 pnpm）：

```sh
git clone https://github.com/dove-a/dsh-chat-window-fold.git
cd dsh-chat-window-fold
pnpm install    # 插件目录安装依赖（含 schemastery，缺失会导致 DSH 启动失败）

dsh plugin --profile web add link:$(pwd)   # 以 link 依赖接入 web profile

# 重启 dsh web 生效；改代码后重启即生效（link 指向源码目录）
```

### 验证与卸载

重启 `dsh web` 后，在**长历史会话**（事件数 >75）里滚到底部即可看到早期消息被折叠；滚到顶部可逐批追回。也可用 `dsh --profile web --dump-config` 确认组合树出现 `chat-window-fold` 行。

卸载：`dsh plugin --profile web remove dsh-chat-window-fold`，然后重启 `dsh web`。

## 配置

阈值与判定周期经行 config 配置（无 UI 开关）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `foldThreshold` | 50 | 折叠后保留的最近行数 |
| `foldCheckEvery` | 25 | 判定周期（会话累计事件数；前两次 N=25/50 跳过，自 N=75 起判定） |

## 限制与说明

- 折叠为**显示层**实现（`display:none` 隐藏窗口外行；展开时恢复显示并从宿主拉取）。宿主与 runtime 的窗口数据按只读协议保持完好；**插件不写会话快照、不调用宿主 API、不卸载 DOM 行**（卸载会被 React 的键式列表重建，破坏折叠与系统锚定）——隐藏行只是退出布局/绘制/滚动高度计算，仍驻留浏览器内存。
- **真正的 token 压缩发生在宿主侧**（agent 会话 → 模型请求的上下文窗口组装），不在浏览器层；本插件刻意不触碰事件/持久化，以免破坏 loadOlder 的窗口语义。当前 runtime 未暴露窗口截断 API，隐藏行仍驻留浏览器内存（`display:none` 不参与布局）。
- 折叠时若判定正处于底部，视口自动重新锚定到新底部（视口内容不变——前后都显示尾部行）；否则后续判定点会因"不在底部"而停摆。
- 判定即「每 25 事件比较一次」，无常驻维护；窗口实际峰值约为 50+25=75 行，低配机器友好。
- 依赖 `ui-conversation` 的槽协议（`conversation.input.dock` 标准 props：`sessionId`/`useSession`）与 DOM 挂点（`[data-conversation-scroll]`、`[data-chat-flow]`、`[data-chat-anchor-key]`、`[data-composer-seat]`），请保持 DSH 为较新版本（`0.1.0-rc.*` 系列）。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。