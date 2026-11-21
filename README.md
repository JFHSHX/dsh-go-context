# dsh-go-context

把 [dsh-context](https://github.com/bowenliang123/dsh-context) 的上下文与花费洞察带进 [dsh-go](https://github.com/) 手机 App 的**原生界面**——全部数据走引擎本机回环的 dsh-context 宿主 API，不依赖网页版渲染。

## 功能

**local-context**（上下文洞察）

| 入口 | 内容 |
| --- | --- |
| 状态条 | 输入框上方常显当前会话上下文用量（如 `上下文 171k/1M · 17%`），30 秒自刷新 |
| 胶囊「上下文」 | 打开「上下文洞察」面板 |
| 上下文洞察 | 已用/窗口、六项构成（系统/技能/注入/用户/助手/工具）、缓存命中率、输出速度、回合步骤、成本 |
| 用量总览 | 今日 tokens、活跃会话、近 7 天用量、最近会话 Top5 |
| 上下文演变 | 逐请求上下文增长（delta/缓存命中/时间）+ 最近 20 条上下文事件流 |
| 全部洞察 | 跨会话 KPI（79.6M tokens 级聚合）、8 项构成、高频工具 Top8、近 7 天 |

**local-context-cost**（花费统计）

| 入口 | 内容 |
| --- | --- |
| 胶囊「花费」 | 打开「花费统计」面板 |
| 花费统计 | 今日 / 近 7 天 / 累计 / 本会话花费，每日花费条形对比，会话花费 Top5，按模型计费 tokens |

所有面板均带「刷新」与「复制摘要」。

## 要求

- DSH `>=0.2.1-rc.2`（在 `0.2.2-rc.1` 实测），dsh-go 桥（手机本机引擎）
- 宿主已安装 [dsh-context](https://www.npmjs.com/package/dsh-context) `>=0.84`：`dsh plugin --profile web add dsh-context`

## 安装

```sh
git clone https://github.com/JFHSHX/dsh-go-context
mkdir -p ~/.dsh/dsh-go/plugins
cp -r dsh-go-context/plugins/* ~/.dsh/dsh-go/plugins/
dsh plugin --profile web add ~/.dsh/dsh-go/plugins/local-context
dsh plugin --profile web add ~/.dsh/dsh-go/plugins/local-context-cost
```

安装的是指向目录的链接，目录不能删。改了 `lib/` 代码要在 App「引擎」页重启引擎生效。

## 数据与隐私

插件在引擎内运行，仅向 `127.0.0.1` 的 dsh-context API 发请求；运行时从本机 `$DSH_HOME/.credentials.yaml` 读取会话密钥 HMAC 签名 cookie，凭据不落盘、不外发、不写日志。

## 已知限制

- dsh-go App 鉴权层会偶发拒绝合法会话 cookie（约 50%），插件已内置 4 次退避重试兜底
- 面板数据 30–60 秒轮询；某轮失败会保留上次数据，下一轮自愈

## 致谢

- [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)（MIT）——所有统计与计价均来自其宿主端计算

## License

MIT
