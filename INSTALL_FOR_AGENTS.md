# Installing magpie-agent-kaku (instructions for AI coding agents)

You are an AI coding agent (Grok Build, Codex, Claude Code, or similar) running on the user's computer. Follow these steps to install the Kaku plugin for Magpie and connect Kaku Assistant to the Magpie gateway. Run each command yourself, check its output, and stop and tell the user if a step fails.

Never print API keys or the contents of `api_key` lines. When you show `assistant.toml`, hide the value of `api_key`.

## 1. Check the prerequisites

1. Find the Magpie CLI. Use `magpie` if it is on `PATH`; on macOS it is usually `/Applications/Magpie.app/Contents/MacOS/magpie`. Call it `$MAGPIE` below. If neither exists, stop and tell the user to install Magpie from https://usemagpie.ai first.
2. Make sure Magpie's gateway is running: `curl -s http://127.0.0.1:3425/` should return JSON with `"name":"magpie"`. If not, ask the user to open the Magpie app.
3. Find Kaku's config: `$XDG_CONFIG_HOME/kaku/assistant.toml`, otherwise `~/.config/kaku/assistant.toml`. If it doesn't exist, stop and tell the user to open Kaku and run `kaku ai` once.
4. Back up the config before changing anything:

   ```sh
   cp -p ~/.config/kaku/assistant.toml ~/.config/kaku/assistant.toml.bak-magpie-$(date +%Y%m%d-%H%M%S)
   ```

## 2. Install the plugin

```sh
git clone https://github.com/shlroland/magpie-agent-kaku.git ~/magpie-agent-kaku
$MAGPIE plugin add ~/magpie-agent-kaku
$MAGPIE plugin list
```

The list should show `~/magpie-agent-kaku` as `on`. Magpie brings its own Bun runtime; you don't need to install Bun. Don't run `bun install` or a build, because `dist/` is already committed.

## 3. Choose a routing group for each Kaku role

Kaku has two required roles:

- **Simple** (`model`): `#` commands, command fixes, light chat. Should be fast and cheap.
- **Deep** (`chat_model`): the `Cmd+L` overlay, `k` chat, tool calls. Should be strong.
- **Memory** (`memory_curator_model`) is optional and uses Deep when unset.

Run `$MAGPIE groups` and `$MAGPIE models` and show the user what they have. Then ask the user which models they prefer for Simple and Deep. If they have no preference, suggest:

- Simple: a fast model first, cheaper ones as fallbacks.
- Deep: the strongest model first, then other strong models.

Create the two groups with the user's chosen models, in their order of preference:

```sh
$MAGPIE group add "Kaku simple" models=<fast-model>,<fallback-model> routing=order
$MAGPIE group add "Kaku deep"   models=<strong-model>,<fallback-model> routing=order
$MAGPIE group kaku-simple
$MAGPIE group kaku-deep
```

Model ids look like `provider/model`, exactly as `$MAGPIE models` prints them. A suffix such as `:high` fixes the reasoning effort for that member (for example `grok/grok-4.7:high`). If `group add` prints a different id than `kaku-simple` / `kaku-deep`, rename it with `$MAGPIE group set <printed-id> id=kaku-simple` (or `kaku-deep`).

If the user already has groups they want to use, skip creating them and use those ids.

## 4. Set the plugin options

```sh
$MAGPIE plugin options ~/magpie-agent-kaku '{"simple":"group/kaku-simple","deep":"group/kaku-deep","memory":"","configPath":""}'
```

Use the full path of the plugin folder as the plugin name. Leave `memory` empty unless the user asked for a Memory group.

## 5. Connect Kaku

```sh
$MAGPIE kaku magpie
sleep 3
grep -E '^(model|chat_model|base_url|auth_type) ' ~/.config/kaku/assistant.toml
```

Expect:

```toml
model = "group/kaku-simple"
chat_model = "group/kaku-deep"
base_url = "http://127.0.0.1:3425/v1"
auth_type = "api_key"
```

If `$MAGPIE kaku magpie` says `(unchanged)` because Kaku was already connected with other options, reconnect so the new options apply: `$MAGPIE kaku default`, then `$MAGPIE kaku magpie`.

## 6. Verify

Send one request to each group with the key Kaku now has, without printing the key:

```sh
KEY=$(sed -nE 's/^api_key[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' ~/.config/kaku/assistant.toml)
for m in group/kaku-simple group/kaku-deep; do
  curl -s -D - -o /dev/null http://127.0.0.1:3425/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}]}" | grep -iE '^(HTTP|x-magpie-model)'
done
```

Each should return `HTTP/1.1 200` and an `X-Magpie-Model` header naming the model that answered. If the first member of a group was skipped, run `$MAGPIE accounts` to see whether its provider needs the user to sign in again, and tell the user.

On macOS you can also run Kaku's own one-shot chat: `/Applications/Kaku.app/Contents/MacOS/k -n "Reply with OK"`.

## 7. Tell the user

Report:

- the groups and their models, in order;
- the verification results, including which model answered each request;
- that they should reopen Kaku's `Cmd+L` overlay (an open overlay keeps the old settings);
- how to disconnect: `$MAGPIE kaku default`, or the Kaku switch on Magpie's Agents page, which restores `assistant.toml` exactly;
- where the backup is.

Don't remove the backup, don't edit `assistant.toml` by hand, and always disconnect before removing the plugin.
