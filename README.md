# dsh-go-context

把 [dsh-context](https://github.com/bowenliang123/dsh-context) 的上下文、团队活动和花费洞察带进 **dsh-go 手机 App 原生界面**。数据走引擎本机回环的 dsh-context 宿主 API，不依赖网页版渲染。

## npm 安装

```sh
dsh plugin --profile web add dsh-context
dsh plugin --profile web add dsh-go-context
dsh plugin --profile web add dsh-go-context-cost
dsh plugin --profile web add dsh-go-context-activity
```

安装后新对话即可看到胶囊；如果升级过插件代码，请在 App「引擎」页重启引擎。

## 三个 npm 包

| 包 | 原生能力 |
| --- | --- |
| [`dsh-go-context`](https://www.npmjs.com/package/dsh-go-context) | 上下文状态条、上下文洞察、用量总览、上下文演变、全部洞察、Markdown 上下文报告 |
| [`dsh-go-context-cost`](https://www.npmjs.com/package/dsh-go-context-cost) | 今日/近 7 天/累计/本会话花费、每日对比、会话 Top5、按模型 tokens |
| [`dsh-go-context-activity`](https://www.npmjs.com/package/dsh-go-context-activity) | Agent 网络、文件活动、命令执行、Markdown 活动报告 |

每个面板都有「刷新」和「复制摘要」。会话类面板在对话详情「插件」页签或「全部功能」中打开，全局面板也可从「全部功能」进入。

## 从源码安装

```sh
git clone https://github.com/JFHSHX/dsh-go-context
cd dsh-go-context
./install.sh
```

源码安装会把 `plugins/` 下的三个目录链接进 web profile，目录不能删除。

## 要求

- DSH `>=0.2.1-rc.2`（在 `0.2.2-rc.1` 实测）
- dsh-go 桥（手机本机引擎）
- dsh-context `>=0.84`

## 数据与隐私

插件只在引擎内向 `127.0.0.1` 的 dsh-context API 发请求。运行时从 `$DSH_HOME/.credentials.yaml` 读取会话密钥并 HMAC 签名 cookie；凭据不落盘、不外发、不写日志。命令面板只显示描述、状态和输出大小，不展示完整命令内容。

## 已知限制

- dsh-go App 鉴权层偶发拒绝合法会话 cookie，插件内置 4 次退避重试。
- 面板每 30–60 秒轮询；一轮失败会保留上次数据，下一轮自愈。
- 原生视图只保留最近列表项，不还原网页版的复杂图形编辑器。

## 开发

```sh
npm test
npm run check:syntax
npm run check:plugins   # 需要本机 dsh-go-plugin 技能检查器
```

单元测试不访问网络。GitHub Actions 会执行语法检查和全部单元测试。

## 致谢

[bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)（MIT）提供全部统计与计价。

## License

MIT
