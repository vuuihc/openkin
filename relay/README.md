# Kin Relay — Cloudflare Worker

## 部署

```bash
# 1. 安装 wrangler（如果没有）
npm install -g wrangler

# 2. 登录 Cloudflare
wrangler login

# 3. 部署
wrangler deploy

# 4. （可选）绑定自定义域名
wrangler route --domain relay.your-domain.com
```

部署后得到 `https://kin-relay.xxx.workers.dev`。

## 在 daemon 中使用

```bash
./kin serve --relay wss://kin-relay.xxx.workers.dev
```

## 在 iOS 中使用

手动输入 `https://kin-relay.xxx.workers.dev`。

## 房间机制

每个 daemon 使用主机名作为 room ID，多个 daemon 共用同一个 worker URL 但不同 room。iOS app 通过在连接 URL 后加 `?room=xxx` 指定目标设备。