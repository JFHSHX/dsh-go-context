# dsh-go-context

dsh-context 的 dsh-go 原生上下文、花费与团队活动套件。**0.3.0 起为三合一入口**，安装本包会自动加载 cost / activity 两个依赖，保留全部 8 个原生面板。

```sh
dsh plugin --profile web add dsh-go-context
```

包含：
- 上下文状态条、上下文洞察、用量总览、上下文演变、全部洞察
- 今日 / 近 7 天 / 累计 / 本会话花费，会话 Top5、按模型 tokens
- Agent 网络、文件活动、命令执行
- 对话信息页「复制上下文报告」「复制活动报告」

要求：DSH >=0.2.1-rc.2、dsh-go 桥，以及宿主安装 dsh-context >=0.84。

[源码与完整文档](https://github.com/JFHSHX/dsh-go-context) · MIT
