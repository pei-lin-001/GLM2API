# GLM2API

这是一个从原仓库中**抽离出来的 Z.ai 反向代理独立项目**，目标是把 `https://chat.z.ai` 封装成 **OpenAI Compatible** 接口，并且满足：

- **纯 HTTP 运行**，不依赖浏览器常驻
- **支持无头 Linux 服务器部署**
- **支持动态拉取真实模型列表**
- **支持 OpenAI 风格 tools / function calling**
- **支持一条命令部署和后台常驻运行**
- **支持多轮压测**

---

## 目录结构

```text
.
├── README.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── .env.example
└── scripts
    ├── zai-openai-compatible.ts
    ├── zai-stress-test.ts
    └── deploy-zai-linux.sh
```

---

## 核心能力

### 1. OpenAI Compatible 接口

服务启动后提供以下接口：

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

其中：

- `/v1/models` 会动态拉取上游真实模型列表
- `/v1/chat/completions` 会把请求转发到 Z.ai 上游，再转换成 OpenAI 风格响应
- 当上游开启 thinking 时，代理会把 `phase=thinking` 转成 `reasoning_content`
- `tools` / `tool_choice` / `parallel_tool_calls` 已做兼容适配

### 1.1 reasoning / 思维链流式输出

当请求体中使用：

```json
{ "stream": true }
```

并且上游返回 thinking 阶段时，代理会实时输出：

- `choices[0].delta.reasoning_content`：思维链增量
- `choices[0].delta.content`：客户端可见文本增量（默认会先镜像思维链，随后再输出最终答案）

也就是说，客户端会先收到 reasoning，再收到最终 answer，而不是等上游完整结束后一次性下发。

另外，为了兼容一些**只读取 `delta.content`** 的通用 OpenAI 客户端，代理默认还会把 thinking 增量镜像到 `delta.content`。这样即使客户端不认识 `reasoning_content` 字段，仍然能看到思考链在实时输出。

### 2. 纯 HTTP，无需浏览器常驻

这个项目的服务端实现是**纯 HTTP 请求链路**。
也就是说，运行代理服务时不需要 Playwright、Puppeteer 或浏览器窗口常驻，因此更适合考试机、无头 Linux、容器和长期后台部署。

### 3. Linux 一条命令部署

直接执行：

```bash
bash scripts/deploy-zai-linux.sh
```

脚本会自动完成：

1. 检查 Linux 环境
2. 检查 Node / npm
3. 如果系统 Node 版本不足，则本地免 root 下载 Node
4. 安装和 `package.json` 对齐版本的 pnpm
5. 执行 `pnpm install --frozen-lockfile`
6. 自动生成运行环境文件
7. 后台启动服务
8. 自动健康检查

---

## 运行环境要求

- Linux x86_64 / arm64 优先
- Node.js >= 20（脚本会尽量自动处理）
- 机器能访问：
  - `https://chat.z.ai`
  - `https://nodejs.org`（当系统 Node 不满足要求时）
  - npm registry（安装 pnpm 和 tsx 时）

---

## 快速开始

### 方式一：本地直接启动

先安装依赖：

```bash
pnpm install
```

直接启动代理：

```bash
pnpm run zai:openai
```

默认监听：

```bash
http://127.0.0.1:8788
```

### 方式二：Linux 一条命令部署（推荐交付给测评组）

```bash
bash scripts/deploy-zai-linux.sh
```

部署完成后可用下面命令查看状态：

```bash
bash scripts/deploy-zai-linux.sh status
bash scripts/deploy-zai-linux.sh logs
bash scripts/deploy-zai-linux.sh restart
bash scripts/deploy-zai-linux.sh stop
```

---

## 接口验证

### 1）健康检查

```bash
curl http://127.0.0.1:8788/health
```

### 2）拉取模型列表

```bash
curl http://127.0.0.1:8788/v1/models
```

### 3）普通聊天

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "glm-5",
    "stream": false,
    "messages": [
      { "role": "user", "content": "Reply with exactly OK" }
    ]
  }'
```

### 3.1）验证 reasoning_content 流式输出

```bash
curl -N http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "glm-5",
    "stream": true,
    "messages": [
      { "role": "user", "content": "请先简短思考，再只回答 1+1 的结果。" }
    ]
  }'
```

预期现象：

1. 先出现 `reasoning_content`
2. 后出现 `content`
3. 最后出现 `finish_reason=stop` 和 `[DONE]`

### 4）工具调用（首轮）

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "glm-5",
    "stream": false,
    "messages": [
      { "role": "user", "content": "请使用 get_weather 工具查询北京天气，不要直接回答。" }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "查询某个城市的天气",
          "parameters": {
            "type": "object",
            "properties": {
              "city": { "type": "string", "description": "城市名" }
            },
            "required": ["city"]
          }
        }
      }
    ],
    "tool_choice": "required"
  }'
```

预期：返回 `finish_reason=tool_calls`，并带 `tool_calls` 字段。

### 5）工具调用（二轮带 tool result）

把首轮返回的 `tool_calls[0]` 带回去，再追加 tool 消息。
代理会尽量输出最终自然语言答案，而不是继续卡在函数调用阶段。

---

## 压测

运行：

```bash
pnpm run zai:stress
```

压测会覆盖这些阶段：

- `models`：多轮拉模型
- `basic`：多轮普通聊天
- `stream_reasoning`：验证 `reasoning_content` 是否真实流式到达
- `tool_cycle`：多轮工具调用往返
- `basic_burst`：并发 basic 请求

脚本会输出 JSON 汇总，包含：

- 成功率
- 平均延迟
- p50 / p90 延迟
- 失败样本

---

## 环境变量说明

常用变量如下：

| 变量名 | 作用 | 默认值 |
| --- | --- | --- |
| `ZAI_OPENAI_HOST` | 服务监听地址 | `127.0.0.1` |
| `ZAI_OPENAI_PORT` | 服务监听端口 | `8788` |
| `ZAI_OPENAI_API_KEY` | 代理层 API Key，可留空 | 空 |
| `ZAI_UPSTREAM_BASE_URL` | 上游入口 | `https://chat.z.ai` |
| `ZAI_DEFAULT_MODEL` | 默认模型 | `glm-5` |
| `ZAI_TIMEZONE` | 时区 | `Asia/Shanghai` |
| `ZAI_BROWSER_NAME` | 客户端指纹字段 | `Chrome` |
| `ZAI_OS_NAME` | 客户端指纹字段 | `Linux` |
| `ZAI_REQUEST_TIMEOUT_MS` | 请求超时 | `180000` |

完整模板见：

```bash
.env.example
```

Linux 一键部署脚本首次运行时还会自动生成：

```bash
.zai-linux/zai-openai.env
```

后续改配置后执行：

```bash
bash scripts/deploy-zai-linux.sh restart
```

---

## 文件说明

### `scripts/zai-openai-compatible.ts`

主服务文件，负责：

- 获取匿名 guest token
- 动态拉取模型列表
- 创建会话
- 调用上游聊天完成接口
- 把 Z.ai 的 SSE / 文本结构转成 OpenAI 响应
- 支持 tools / function calling 适配
- 支持部分 tool-call 格式兜底解析

### `scripts/zai-stress-test.ts`

压测脚本，负责：

- 自动拉起本地代理（或使用已有代理）
- 轮询 `/health`
- 分阶段测试 `models / basic / tool_cycle / basic_burst`
- 输出结构化压测报告

### `scripts/deploy-zai-linux.sh`

Linux 部署脚本，负责：

- 自动准备运行时依赖
- 自动生成 env
- 后台启动
- 健康检查
- stop / restart / logs / status

---

## 适合测评组直接执行的命令

### 一条命令部署

```bash
bash scripts/deploy-zai-linux.sh
```

### 健康检查

```bash
curl http://127.0.0.1:8788/health
```

### 模型列表

```bash
curl http://127.0.0.1:8788/v1/models
```

### 停止服务

```bash
bash scripts/deploy-zai-linux.sh stop
```

### 查看日志

```bash
bash scripts/deploy-zai-linux.sh logs
```

---

## 注意事项

1. 该项目当前实现的是**客户端侧特征最小化**，不是“服务端绝对不记录日志”的保证。
2. 如果考试机系统 Node 版本过低，部署脚本会优先尝试本地免 root 安装 Node。
3. 如果你只想本地直接跑，不想后台常驻，可以直接用：

```bash
pnpm run zai:openai
```

4. 如果你需要改部署目录，可以这样：

```bash
ZAI_DEPLOY_APP_DIR=/opt/zai-proxy bash scripts/deploy-zai-linux.sh
```

5. 如果部署脚本提示端口已占用，说明当前 `ZAI_OPENAI_PORT` 已被别的进程监听。此时请先释放端口，或者换一个端口重新部署，例如：

```bash
ZAI_OPENAI_PORT=18788 bash scripts/deploy-zai-linux.sh
```

---

## 交付说明

这个仓库已经把原项目中**和 Z.ai 反代直接相关的代码**抽离出来了，适合作为独立交付物给测评组或考官：

- 代理主程序
- 压测脚本
- Linux 一条命令部署脚本
- 启动说明
- 接口验证命令
- 环境变量模板

如果你需要，我还可以继续补：

- `Dockerfile`
- `systemd` 服务模板
- GitHub Actions 自测流程
