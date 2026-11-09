// Magpie runs this file inside moejs. It must stay free of imports and host APIs.
// package.json "main" is the companion that reads this JSON file and syncs Kaku.
export const agent = {
  id: "kaku",
  name: "Kaku",
  icon: "https://raw.githubusercontent.com/shlroland/magpie-agent-kaku/main/assets/icon.png",
  bin: "kaku",
  dir: "~/.config/kaku",
  config: "~/.config/magpie-agent-kaku/bridge.json",
  format: "json",
  notice:
    "This row is a connection switch. Set simple and deep in the plugin options, wait for the bridge, then reopen Kaku's chat. Disconnect here before removing the plugin. 这是连接开关。先在插件选项里填写 simple 和 deep，等桥接完成后再打开 Kaku 对话。移除插件前先断开。",
}

export function connect(input) {
  const gateway = input && input.gateway
  const baseURL = gateway && gateway.v1
  const apiKey = gateway && gateway.key
  if (typeof baseURL !== "string" || typeof apiKey !== "string" || !baseURL || !apiKey) {
    throw new Error("Magpie gateway is not ready")
  }
  return {
    baseURL: baseURL,
    apiKey: apiKey,
  }
}
