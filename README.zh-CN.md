# magpie-agent-kaku

[English](./README.md) | 简体中文

这是给 [Kaku](https://github.com/tw93/Kaku) Assistant 用的 [Magpie](https://usemagpie.ai) 插件，做两件事：

1. **把 Kaku 接到 Magpie 网关**：把网关的 `base_url` 和 API key 写进 Kaku 的 `~/.config/kaku/assistant.toml`。
2. **给 Kaku 的每个角色配一个 Magpie 路由组**：Kaku 不同的活用不同的模型。插件把每个角色绑到一个组，组里具体用哪个模型由 Magpie 决定。

断开时，Kaku 原来的配置会逐字节恢复。

## 路由是怎么做的

路由分两层。

**第一层：插件把 Kaku 的角色绑到组。**

| Kaku 角色 | 用在哪里 | `assistant.toml` 字段 | 插件选项 |
| --- | --- | --- | --- |
| Simple | `#` 命令、命令修复、轻量对话 | `model` | `simple`（必填） |
| Deep | `Cmd+L` 浮层、`k` 对话、工具调用 | `chat_model` | `deep`（必填） |
| Memory | 记忆整理，不填就用 Deep | `memory_curator_model` | `memory`（可选） |

**第二层：Magpie 在组里挑模型。**

一个组由若干成员模型和一个路由策略组成，策略有 `smart`、`order`、`cheap`、`fast`、`weight` 等。每个请求进来，Magpie 按策略选一个成员；某个模型额度用完或挂了，就换下一个。还可以加 intent 规则，比如“多步编码任务”用强模型，“简单问题”用便宜模型。intent 只看最新一条用户消息。工具调用来回的过程中，Magpie 会让这一轮一直留在已经选中的模型上。

插件自己从不判断请求该给谁。选模型的逻辑全在 Magpie 的组里，所以要改路由，用 `magpie group` 命令就行，不用动插件。

## 让 AI agent 帮你安装

把下面这段 Prompt 贴给你电脑上的 Grok Build、Codex、Claude Code 或其他编码 agent：

```text
在这台电脑上为 Magpie 安装 Kaku 插件。阅读 https://raw.githubusercontent.com/shlroland/magpie-agent-kaku/main/INSTALL_FOR_AGENTS.md 并按步骤执行。创建路由组之前，先问我 Kaku 的 Simple 和 Deep 角色想用哪些模型；不要输出任何 API key。
```

agent 会先备份你的 Kaku 配置，安装插件，和你一起配好路由组，接入 Kaku，再确认实际是哪个模型在回答。想手动安装，按下面的步骤来。

## 环境要求

- macOS 或 Linux，Magpie 在运行。Magpie 自带 Bun，不用另装。
- 已安装 Kaku，并且有 `~/.config/kaku/assistant.toml`。

macOS 上 `magpie` 命令在 App 包里，通常不在 `PATH` 上：

```sh
alias magpie=/Applications/Magpie.app/Contents/MacOS/magpie
```

下面的命令都默认用了这个别名。

## 用法

### 1. 安装插件

```sh
git clone https://github.com/shlroland/magpie-agent-kaku.git ~/magpie-agent-kaku
magpie plugin add ~/magpie-agent-kaku
```

`dist/` 已经提交在仓库里，不用构建。

### 2. 选组或新建组

看看已有的组：

```sh
magpie groups
```

每行显示组 id、策略和成员。用 `magpie group <id>` 查看单个组。

给 Kaku 单独建组（把模型 id 换成你有的，`magpie models` 能列出来）：

```sh
magpie group add "Kaku simple" models=供应商/便宜模型,供应商/备用模型 routing=order
magpie group add "Kaku deep"   models=供应商/强模型,供应商/备用模型 routing=smart

# 可选：按问题内容路由
magpie group rule add kaku-deep use=供应商/强模型 intent="a multi-step coding task" classifier=供应商/小而快的模型
magpie group rule add kaku-deep use=供应商/便宜模型 intent="a quick question"
```

名为 `"Kaku simple"` 的组，id 是 `kaku-simple`，引用时写 `group/kaku-simple`。某个角色不想路由，也可以直接写 `供应商/模型`。

### 3. 设置插件选项

```sh
magpie plugin options ~/magpie-agent-kaku '{
  "simple": "group/kaku-simple",
  "deep":   "group/kaku-deep",
  "memory": ""
}'
```

| 选项 | 含义 |
| --- | --- |
| `simple` | 必填，写入 `model`。 |
| `deep` | 必填，写入 `chat_model`。 |
| `memory` | 可选。留空就不碰 `memory_curator_model`。 |
| `configPath` | 可选，指向别的 `assistant.toml`。默认是 `$XDG_CONFIG_HOME/kaku/assistant.toml` 或 `~/.config/kaku/assistant.toml`。 |

`simple` 或 `deep` 为空时，插件不会写任何东西。

### 4. 接入

在 Magpie 的 Agents 页打开 **Kaku** 的开关，或者运行：

```sh
magpie kaku magpie
```

然后**重新打开** Kaku 的 `Cmd+L` 浮层，或者新发一条 `#` 命令。Kaku 只在打开浮层和每次 `#` 任务开始时读配置，已经开着的浮层还用旧设置。

接入后 `assistant.toml` 大致是这样，注释和其他键都保留：

```toml
model = "group/kaku-simple"
chat_model = "group/kaku-deep"
base_url = "http://127.0.0.1:3425/v1"
api_key = "<这个 Agent 的 Magpie 网关 key>"
auth_type = "api_key"
```

### 5. 查看实际是哪个模型回答的

- **组的配置**：`magpie groups` 和 `magpie group <id>` 显示成员、策略和规则。
- **每次请求**：Magpie 的用量记录（网关上的 `GET /v1/magpie/usage/requests`）列出 Kaku 的每个请求，写着请求的组和实际服务的模型。
- **直接看响应**：网关的响应头里有 `X-Magpie-Model` 和 `X-Magpie-Provider`。

### 6. 修改路由

- 想改某个角色能用哪些模型，用 `magpie group set <id> ...` 改组或加规则。不用动插件，下一个请求就生效。
- 想让某个角色换一个组，改插件选项，然后把 Kaku 开关关一次再开一次。

### 7. 断开

关掉 Kaku 开关，或者运行：

```sh
magpie kaku default
```

插件改过的字段都会恢复原值，原来没有的键会被删掉。如果接入期间你手动改过其中某个字段，会保留你的修改，并记为冲突。

移除插件前一定先断开。如果 Magpie 在接入状态下被强制退出，重新启用插件，或在插件目录运行 `bun ./bin/magpie-kaku.mjs restore`。

## 插件会改什么

接入期间写入 `base_url`、`api_key`、`auth_type`、`model`、`chat_model`，以及 `memory_curator_model`（只在填了 `memory` 时）。它会删掉旧的 `fast_model` 键，否则这个键会盖过 Simple，断开时再放回去。

`enabled`、`api_mode`、`web_search_provider`、`web_search_api_key`、`chat_model_choices`、`custom_headers` 和其他键一概不碰。

原来的值，包括你之前的 `api_key`，在断开前都保存在 `~/.config/magpie-agent-kaku/state.json`，权限 `0600`。日志不会打印任何 key。

## 排查问题

| 现象 | 检查 |
| --- | --- |
| Kaku 还在用旧模型 | 重新打开 `Cmd+L` 浮层，开着的浮层不会重新读配置。 |
| `assistant.toml` 没变化 | `magpie kaku` 应该显示 `provider magpie`，且 `simple`、`deep` 都要填。 |
| 组里某个成员从来没被用到 | `magpie groups` 会标出不能用的成员，比如它的供应商被关掉了。 |

## 实现原理

`agent.js` 在 Magpie 里作为 Agent 定义运行。它没有 model 字段，所以 Agents 页显示为连接开关。接入时，它把网关地址和 key 写到 `~/.config/magpie-agent-kaku/bridge.json`。

`dist/index.js` 在 Magpie 的 Bun 插件宿主里运行。它监视这个桥接文件，只改 `assistant.toml` 里需要的那几个键，注释和排版都保留。之所以拆成两半，是因为 Magpie 的 Agent 写入器不能改 TOML。

## 开发

```sh
bun install
bun run typecheck
bun test
bun run build                                # 重新生成 dist/
MAGPIE_BIN=$(which magpie) node scripts/integration-smoke.mjs   # 用假上游跑端到端测试
```

## 许可

MIT
