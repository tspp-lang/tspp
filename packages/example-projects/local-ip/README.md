# local-ip

[中文](#中文) | [English](#english)

## 中文

`local-ip` 是一个基于 `@tspp/command-kit` 开发的实用命令行工具，用于**查看本机网卡的 IPv4 / IPv6 地址**。

适合这些场景：
- 快速查看本机在局域网或 VPN 下的 IP 地址
- 确认本地开发服务器应该监听哪个地址
- 以 JSON 格式导出本机地址列表，供其他脚本处理

> **说明**：`local-ip` 只读取操作系统本地的网卡信息，**不会发送任何网络请求**。它不会查询公网出口 IP，也不会猜测哪张网卡是默认网卡；结果中可能包含 VPN 和虚拟网卡。

### 1. 构建与运行

运行环境需要 **Node.js 22** 和 **pnpm 12.4.2**。

**首次使用（从仓库根目录完整构建）：**

```sh
pnpm install
pnpm build:plugin-sdk
pnpm build:plugins
pnpm build:compiler
pnpm build:example-projects
pnpm --filter @tspp/local-ip run cli
```

**日常使用（工具链已构建时）：**

先构建 `@tspp/command-kit` 和 `@tspp/local-ip` 两个项目后即可运行，也可以直接执行构建产物：

```sh
node packages/example-projects/local-ip/dist/cli.js
```

> 本包注册的可执行入口名为 `local-ip`。

### 2. 常用命令示例

```text
local-ip [interface] [options]
```

以下命令均在仓库根目录执行（默认列出所有网卡的外部/非回环地址）：

```sh
# 列出所有网卡的常用地址（先跑这条可以查看本机有哪些网卡名）
pnpm --filter @tspp/local-ip run cli

# 只看 IPv4 地址
pnpm --filter @tspp/local-ip run cli --family ipv4

# 包含回环等内部地址，并输出 JSON
pnpm --filter @tspp/local-ip run cli --internal --json

# 按完整网卡名称筛选（区分大小写，带空格需加引号；请替换为本机实际网卡名）
pnpm --filter @tspp/local-ip run cli "Wi-Fi" --family ipv6

# 查看帮助
pnpm --filter @tspp/local-ip run cli --help
```

### 3. 参数与选项

| 参数 / 选项 | 说明 |
| --- | --- |
| `interface` | 可选位置参数，按**完整网卡名称**筛选（区分大小写） |
| `-f, --family <all\|ipv4\|ipv6>` | 按地址族筛选，默认为 `all` |
| `-i, --internal` | 包含内部地址（如 `127.0.0.1`、`::1`）；默认排除 |
| `-j, --json` | 以 JSON 数组格式输出 |
| `-h, --help` | 显示帮助信息 |
| `-V, --version` | 显示版本号 |

### 4. 输出格式与退出码

- **排序规则**：结果按 `网卡名称` → `地址族（IPv4 在前）` → `地址字符串` 排序。
- **文本输出**：每行输出一条记录，字段依次为 `网卡名称`、`地址族`、`地址`、`internal` / `external` 标记（以制表符分隔）。如果没有匹配的地址，输出 `No matching addresses.`。
- **JSON 输出**（`--json`）：返回记录数组；没有匹配的地址时输出 `[]`。示例结构如下（实际内容随机器而异）：

```json
[
  {
    "interface": "Ethernet",
    "family": "IPv4",
    "address": "192.168.1.20",
    "internal": false
  }
]
```

**退出码说明：**

| 退出码 | 含义 |
| --- | --- |
| `0` | 查询成功（含无匹配结果），或查看帮助/版本成功 |
| `1` | 指定的网卡不存在，或无法读取系统网卡信息 |
| `2` | 命令行参数无效 |

### 5. 开发与测试

```sh
pnpm --filter @tspp/local-ip check
pnpm --filter @tspp/local-ip test
```

单元测试直接向筛选与格式化函数传入模拟网卡数据，确保不依赖运行机器的网络环境；CLI 层使用 `@tspp/command-kit` 处理参数解析、帮助生成与退出码。

---

## English

`local-ip` is a CLI utility built with `@tspp/command-kit` that **lists IPv4 and IPv6 addresses assigned to local network interfaces**.

Common use cases:
- Quickly inspect your machine's LAN or VPN IP addresses
- Check which address a local development server should bind to
- Export interface addresses as JSON for downstream scripts

> **Note**: `local-ip` reads interface data from the operating system without making any network requests. It does not look up a public outbound IP or guess a default interface, and results may include VPN or virtual interfaces.

### 1. Build and Run

Requires **Node.js 22** and **pnpm 12.4.2**.

**First-time setup (from the repository root):**

```sh
pnpm install
pnpm build:plugin-sdk
pnpm build:plugins
pnpm build:compiler
pnpm build:example-projects
pnpm --filter @tspp/local-ip run cli
```

**Daily use (when the toolchain is already built):**

Build `@tspp/command-kit` and `@tspp/local-ip`, then run via pnpm or directly with Node:

```sh
node packages/example-projects/local-ip/dist/cli.js
```

> The package's executable entry is named `local-ip`.

### 2. Usage Examples

```text
local-ip [interface] [options]
```

Run from the repository root (lists non-internal addresses from all interfaces by default):

```sh
# List non-internal addresses on all interfaces (useful to discover exact interface names)
pnpm --filter @tspp/local-ip run cli

# Show IPv4 addresses only
pnpm --filter @tspp/local-ip run cli --family ipv4

# Include internal/loopback addresses and output JSON
pnpm --filter @tspp/local-ip run cli --internal --json

# Filter by exact interface name (case-sensitive; quote names with spaces and replace with an actual name)
pnpm --filter @tspp/local-ip run cli "Wi-Fi" --family ipv6

# Show help
pnpm --filter @tspp/local-ip run cli --help
```

### 3. Arguments and Options

| Argument / Option | Purpose |
| --- | --- |
| `interface` | Optional positional argument to filter by **exact interface name** (case-sensitive) |
| `-f, --family <all\|ipv4\|ipv6>` | Filter by address family; defaults to `all` |
| `-i, --internal` | Include internal addresses (such as loopback); excluded by default |
| `-j, --json` | Output a JSON array |
| `-h, --help` | Show help |
| `-V, --version` | Show version |

### 4. Output Format and Exit Codes

- **Sorting**: Results are sorted by `interface name`, then `family` (IPv4 first), then `address`.
- **Text output**: One record per line, tab-separated: `interface`, `family`, `address`, and `internal` / `external`. Prints `No matching addresses.` when empty.
- **JSON output** (`--json`): Outputs a JSON array (`[]` when empty). Actual names and addresses vary by machine:

```json
[
  {
    "interface": "Ethernet",
    "family": "IPv4",
    "address": "192.168.1.20",
    "internal": false
  }
]
```

**Exit codes:**

| Exit code | Meaning |
| --- | --- |
| `0` | Successful query (including empty results), or help/version request |
| `1` | Interface not found or OS interface lookup failed |
| `2` | Invalid command arguments |

### 5. Development

```sh
pnpm --filter @tspp/local-ip check
pnpm --filter @tspp/local-ip test
```

Tests pass interface data directly into the filtering and formatting functions for deterministic verification; the CLI layer uses `@tspp/command-kit` for argument parsing, help output, and exit codes.
