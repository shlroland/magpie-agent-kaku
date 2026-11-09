# Kaku Assistant 的 Magpie Agent 插件

把 Kaku Assistant 接到本机 Magpie 网关，并把 Kaku 的 Simple、Deep、可选 Memory 三个角色分别绑到**已经存在**的 Magpie 分组或模型。插件不新建分组、不改路由规则、不转发请求，也不读取真实密钥去调用模型。

这是本地草稿包 `magpie-agent-kaku`（`private: true`）。不要发布到 npm，也不要把它送进上游仓库。

## 它实际做的两件事

Magpie 当前的 Agent 写入器只改 JSON、YAML 和 env，**还不能改 TOML**（[插件文档](https://usemagpie.ai/docs/plugins) 的 `format`，以及 Magpie `internal/agent/plugged_test.go` 对 `*.toml` 的拒绝）。Kaku 的助手配置是 TOML，而且有多个模型字段。因此这个包分成两半：

1. `agent.js` 在 Magpie 自己的 moejs 里运行。它不声明 `model`，Agents 页因此是**连接开关**，没有单个模型选择器（`internal/agent/plugged.go` 在 `model` 为空时把字段做成 provider 开关，并在没有 `model` 的情况下调用 `connect`）。`connect` 只把 `gateway.v1` 和 `gateway.key` 写进插件自己的 `~/.config/magpie-agent-kaku/bridge.json`。
2. `package.json` 的 `main`（`dist/index.js`）在 Magpie 的 Bun 插件宿主里运行。它监视这份 JSON，再按字段把 Kaku 的 `assistant.toml` 改到对应角色。重复同步如果没有差异，不会再写文件。

静态绑定和动态路由是两层：

| 层 | 谁做 | 做什么 |
| --- | --- | --- |
| 静态角色绑定 | 本插件 | 把 `model`、`chat_model`、可选的 `memory_curator_model` 写成你填的 id |
| 动态路由 | Magpie 里那个已经存在的分组 | 按分组自己的 fallback、资源策略和 intent 规则，在成员模型之间选择 |

插件不分类请求。网关的异步 hook 也不能改模型（改了会被回滚），所以这里没有用 hook 做分类。

## 安装

需要已经能运行的 Magpie。开发机另需 Bun 1.1 以上；Magpie 安装插件时会自己准备 Bun。依赖只有 `toml-eslint-parser`，没有 `install` / `postinstall`。`dist/` 已提交，安装时不必再构建。

在本目录：

```sh
magpie plugin add "$PWD"
```

macOS 上如果终端没有 `magpie`：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add "$PWD"
```

不要只导入 `agent.js`。没有 `main` 指向的 Bun 模块时，不会有人去改 Kaku 的 TOML。装完后如果改了源码，先 `bun run build`，再在 Magpie 里把插件关一次、开一次。

## 选项

Magpie 把插件选项作为 Bun 入口的第二个参数（`plugins.json` 里该插件的 `options`）。`package.json` 里的 `magpie.options` 只是编辑器的空白起点，**保存之前不会生效**。`simple` 和 `deep` 都为空时，插件拒绝写入。

```sh
magpie plugin options magpie-agent-kaku '{
  "simple": "group/kaku-simple",
  "deep": "group/kaku-deep",
  "memory": "",
  "configPath": ""
}'
```

| 字段 | 含义 |
| --- | --- |
| `simple` | 必填。写入顶层 `model`。填已有的 `group/<id>`，或 `供应商/模型` |
| `deep` | 必填。写入顶层 `chat_model` |
| `memory` | 可选。留空则不碰 `memory_curator_model`。填写后才写入；之后再清空，会按恢复规则把这个字段放回去 |
| `configPath` | 可选。必须指向名为 `assistant.toml` 的文件，支持 `~`。留空时跟 Kaku 一样：有 `XDG_CONFIG_HOME` 就用 `$XDG_CONFIG_HOME/kaku/assistant.toml`，否则 `~/.config/kaku/assistant.toml` |

`kaku-simple` / `kaku-deep` / `kaku-memory` 只是示例名字，Magpie 里没有这些内置分组。id 以 `magpie groups` 显示的为准，选择器里的写法是 `group/<id>`（见 [开始使用](https://usemagpie.ai/docs/start) 和参考文档里的 Routing groups）。不要加 `openai/` 前缀。

保存选项后打开 **Agents → Kaku** 的开关。桥接目录是 `~/.config/magpie-agent-kaku/`，权限 `0700`；`bridge.json` 和 `state.json` 是 `0600`。

## Kaku 会读到什么

依据 Kaku `cd238ef` 的 `kaku/src/assistant_config.rs`、`kaku-gui/src/ai_client/assistant_config.rs` 和 `kaku-gui/src/soul.rs`：

- 顶层 `model` 是 Simple（`#` 命令、命令修复、轻量对话）。旧的 `fast_model` 若还在，运行时会盖过 `model`。接入期间插件会删掉 `fast_model`，断开时再按原样放回。
- `chat_model` 是 Deep（`Cmd+L`、`k`、工具调用）。缺省时会继承 Simple；旧配置若同时有 `model` 和 `fast_model` 且没有 `chat_model`，原来的 `model` 会变成 Deep。插件总是同时写这两个字段，避免角色叠到一起。
- `memory_curator_model` 可选，缺省时记忆整理用 Deep。
- `auth_type` 必须是 `api_key`，否则 Kaku 忽略 `base_url` 和 `api_key`，改走 Codex。插件会写成 `api_key`，断开时恢复原值；原来没有这一键就删掉。
- `base_url` 写成网关的 `v1` 地址（`http://127.0.0.1:<端口>/v1`）。`api_key` 写成这个 Agent 自己的网关 key。
- `api_mode` 只有 `chat_completions`（默认）和 `responses`。Kaku 分别请求 `{base_url}/chat/completions` 和 `{base_url}/responses`，Magpie 网关这两条都有。插件**不写** `api_mode`。
- 不改 `enabled`、`web_search_api_key`、`web_search_provider`、`chat_model_choices`、`custom_headers` 以及其他不认识的键。`chat_model_choices` 若已填写，聊天浮层的切换列表仍只含那些项；真正发出的 Deep 请求仍用 `chat_model`。

Kaku 在打开聊天浮层时，以及每条内联 `#` / 修复任务开始时，读取 `assistant.toml`。已经打开的浮层不会跟着文件变。同步完成后重新打开浮层，或再发一条 `#` 命令。这次没有在 macOS 上跑过 Kaku 图形界面。

## 准备分组

先在 Magpie 里准备好分组，再把 id 填进选项。下面的命令来自当前文档，模型 id 要换成你已经有的：

```sh
magpie groups
magpie group add "Kaku simple" models=供应商/便宜模型,供应商/备用模型 routing=order
magpie group add "Kaku deep" models=供应商/强模型,供应商/备用模型 routing=smart
magpie group rule add kaku-deep use=供应商/强模型 intent="a multi-step coding task" classifier=供应商/小而快的模型
magpie group rule add kaku-deep use=供应商/便宜模型 intent="a quick question"
magpie group rule kaku-deep
```

`magpie group add "Kaku simple"` 生成的 id 是 `kaku-simple`，写进 Kaku 的值是 `group/kaku-simple`。`routing=` 可以用 `smart`、`order`、`fast`、`cheap`、`weight` 等文档中的策略。intent 只看**最新一条用户文本**，不看更早的对话、系统提示或工具定义；分类失败时这次 intent 不命中，分组仍按自己的顺序回答。工具结果回传期间，Magpie 会让这一轮留在刚选中的模型上。Kaku 自己的工具请求是不是这种形状，这里没有对着真实网关验证过，不能当成已经测过。

## 恢复

字段级恢复：某个键现在的值和上次写入的值一致，才放回接入前的原值；你后来改过的键会留下，并记为冲突。原来没有的键会被删掉。无效的 TOML 或写到一半的 bridge 会停住，不改 Kaku 的文件。

正常断开是关掉 Agents 页上 Kaku 这一行的开关。Magpie 会把 `bridge.json` 里它写过的键恢复；Bun 侧看到 key 消失后做上面的字段恢复。

只使用命令时，在插件仍启用的情况下：

```sh
magpie kaku default
bun ./bin/magpie-kaku.mjs status
```

`magpie kaku default` 是 Magpie 对插件 Agent 的通用断开命令（文档里的 `magpie <id> default`）。本环境没有安装 Magpie，所以没有实际跑过这条命令。

也可以直接恢复，并让仍在运行的宿主先不要写回去：

```sh
bun ./bin/magpie-kaku.mjs restore
bun ./bin/magpie-kaku.mjs sync    # 取消暂停并再次接管
```

`restore` 在桥还连着时会暂停自动写回，直到 bridge 文件变化或执行 `sync`。状态在 `~/.config/magpie-agent-kaku/state.json`，里面有接入前的 `api_key`，权限 `0600`。恢复完成前不要删它。

独立命令不会自动拿到 Magpie 界面里刚保存的选项。它会读 `MAGPIE_KAKU_OPTIONS`，否则读 `~/.config/magpie/plugins.json`（或 `$XDG_CONFIG_HOME/magpie/plugins.json`）里 spec 为 `magpie-agent-kaku` 或以这个目录名结尾的项。

## 安全与生命周期

- 网关 key 和原来的 `api_key` 只出现在 `bridge.json`、`assistant.toml` 和 `state.json`。日志和错误只说字段名，不打印这些值。
- 写文件先写临时文件、`fsync`，再改名。已有的 `assistant.toml` 保持原来的权限；新建的是 `0600`。符号链接会改它指向的文件，不会把链接本身换成普通文件。
- 监视的是配置文件和 bridge 的父目录，用来接住原子替换。写入是串行的；写之前会再读一次，文件如果已经变了就放弃这一轮。自己刚写出的内容不会再触发一次写入。
- 插件被关闭或删除时，Magpie 源码会先把 Agent 文件恢复，再重启宿主（`internal/agent/plugged_gone.go`，子系统文档 `agent-wiring.md`）。宿主在标准输入关闭且没有未完成调用时执行 `process.exit(0)`，这时退出处理会再同步一次。宿主若在约 2 秒后被杀掉，退出处理不会运行。因此**不能把卸载或禁用当成必定自动恢复**。强制结束后重新启用插件，或执行 `bun ./bin/magpie-kaku.mjs restore`。
- 恢复记录对不上当前文件时会停住，避免盖住别人正在写的配置。

## 开发

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # 23 项，临时目录，不读本机 Kaku/Magpie 配置
bun run build       # 重新生成 dist/，安装插件不依赖这一步
bun ./bin/magpie-kaku.mjs status --home /tmp/kaku-dev
```

TOML 用 `toml-eslint-parser` 的 range 做定点替换，再用 `Bun.TOML.parse` 校验。没有用整文件 stringify，也没有用正则改 TOML。`@decimalturn/toml-patch` 的 `patch()` 会删掉对象里没提到的键，不适合只改几个字段，所以没有用它。

删掉的键在恢复时会插回它原来的前一个顶层键后面（`fast_model` 紧跟 `chat_model`）。前一个键已经不在时，才插到第一张表之前。

### 这次已经跑过的检查

在 Bun 1.4.4 上：`tsc --noEmit` 通过，`bun run build` 通过，`bun test` 通过，`bun pm pack --dry-run` 含 `dist/index.js` 和 `agent.js`，且没有 install 脚本。单元测试覆盖注释保留、顶层键和表、引号键与点号键、可选 Memory、重复同步不写文件、非法 TOML / 半截 bridge、手工修改冲突、完整和部分恢复、写前再读、符号链接、恢复日志对不上时停住、目录监视，以及假宿主从 `connect()` 的 JSON 同步到断开恢复。

对照过的上游源码：Kaku `cd238ef`，Magpie `eef99e4`，社区插件示例 `ecab839`。文档页面抓取于 2026-11-08。

## Linux 上的真实 Magpie 集成

官方安装（终端构建，校验和由 usemagpie.ai 提供）：

```sh
curl -fsSL https://usemagpie.ai/install.sh | sh -s -- --tui
MAGPIE_BIN="$HOME/.local/bin/magpie" node scripts/integration-smoke.mjs
```

已在这台 Linux x86_64 虚拟机上跑通，Magpie **0.1.3304**（`magpie-cli-linux-amd64`）。脚本使用临时 `HOME`，不读本机已有的 Magpie 或 Kaku 配置。

| 组件 | 这次是什么 |
| --- | --- |
| Magpie CLI / `magpie serve` | 官方 0.1.3304 终端构建，真实进程 |
| 插件安装、选项、`magpie kaku` 开关、`magpie kaku default`、`magpie plugin off` | 真实 Magpie 命令 |
| 分组 `group/kaku-simple`、`group/kaku-deep`、`group/kaku-memory` | 真实 `magpie group add`，成员是本地供应商的模型 |
| 上游模型 | `scripts/mock-openai.mjs`，只听 `127.0.0.1`，固定回复，不花额度 |
| Kaku 程序和 macOS 图形界面 | **没有跑**。配置文件是夹具 `scripts/fixtures/assistant.toml`；PATH 上有一个假的 `kaku`，只为了让 Magpie 认为它已安装 |

脚本检查：Agents 行是 `provider` 开关而不是模型选择器；三个角色和 `base_url` / `api_key` / `auth_type` 写进 TOML 且注释还在；`fast_model` 在接入时消失、断开后回到原位；网关 `/v1/models` 列出三个分组；流式补全、工具调用和工具结果回传都打到对应成员，Deep 的两跳都停在 `deep-a`；`magpie kaku default` 和 `magpie plugin off` 都把夹具文件恢复成接入前的字节。

还没做、也不能用这次结果代替的部分：macOS 上的 Kaku.app、真实 `assistant.toml` 热加载、`#` 命令和 `Cmd+L` 对话、以及用户自己的供应商账号。用户的 Mac 当时不在线。
