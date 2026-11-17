# Ledger / 本地账本

[中文](#中文) | [English](#english)

## 中文

使用 TS++ 编写的本地人民币账本。浏览器提供界面，本机 Node.js 进程负责金额计算、业务校验和文件保存，无需账号、云服务或外部网络资源。

### 启动

按仓库说明安装依赖并构建编译器、插件与 `command-kit` 后，在仓库根目录执行：

```sh
pnpm --filter @tspp/ledger build
pnpm --filter @tspp/ledger start
```

在浏览器打开终端输出的地址，默认是 `http://127.0.0.1:4318`。程序仅监听本机回环地址。

```sh
pnpm --filter @tspp/ledger start --port 4320 --data ./my-ledger.json
pnpm --filter @tspp/ledger start --help
```

默认文件为用户主目录下的 `.tspp-ledger/ledger.json`；相对路径按启动时的工作目录解析。更换文件即可使用另一本账本。关闭程序后复制该文件可备份整本账。

### 功能与规则

- 创建账户并记录期初余额；支持收入、支出和账户间转账。余额允许为负，以记录信用卡和透支。
- 查询账户余额和流水，按账户、类型和关键词筛选。作废流水保留原记录，并从余额与收支统计中移除。
- 所有金额以整数分保存、以 `bigint` 计算；输入最多两位小数，交易金额必须大于零。转账不计入收入或支出，两个账户的合计余额保持不变。
- 均分时将余下的分依次分给前几人。例如 100 元分给三人，结果为 33.34、33.33、33.33 元。
- CSV 导出与导入保留账户、期初余额、交易 ID 及作废状态，用于本软件之间交换账本；CSV 金额为整数分，单次导入上限 1 MiB。导入整批校验成功后才保存，重复 ID 会报错。普通银行 CSV 需要先转换成此格式；完整备份使用 JSON 数据文件。

数据文件加载时会重新校验。文件损坏会停止启动并报告错误；请先保留原文件，再从备份恢复。程序通过独占锁阻止多个进程同时写同一本账，正常关闭时释放锁；进程异常退出后，确认没有其他账本进程使用该文件，再移除旁边的 `.lock` 文件。

### TS++ 的实际用途

金额和标识使用名义类型；交易业务用代数数据类型与穷尽模式匹配；核心金额算法附带编译期契约；存储通过代数效应交给文件或测试内存实现。转账契约证明两个余额之和守恒；分账契约证明商和余数的关系，循环不变式证明累计分配金额等于总额。返回数组的具体内容由行为测试验证，当前证明模型不跟踪数组元素。文件可靠性、HTTP 输入与数据导入另有运行时检查和行为测试。界面使用普通浏览器 JavaScript，业务规则在 `.tspp` 源码中实现。

### 开发

```sh
pnpm --filter @tspp/ledger check
pnpm --filter @tspp/ledger test
```

本软件只提供本机、单用户、单币种账本。没有汇率、银行同步或多人在线协作。

---

## English

A local CNY ledger written in TS++. The browser provides the interface; a local Node.js process validates entries, calculates money, and saves the ledger. No account, cloud service, or external web assets are required.

### Start

Install repository dependencies and build the compiler, plugins, and `command-kit` as described in the repository README, then run from the repository root:

```sh
pnpm --filter @tspp/ledger build
pnpm --filter @tspp/ledger start
```

Open the printed address, normally `http://127.0.0.1:4318`. The server listens on loopback only.

```sh
pnpm --filter @tspp/ledger start --port 4320 --data ./my-ledger.json
pnpm --filter @tspp/ledger start --help
```

The default file is `.tspp-ledger/ledger.json` in your home directory. Relative paths resolve from the process working directory. Select another file to use another ledger. Copy the data file while the application is stopped to back up the entire ledger.

### Features and rules

- Create accounts with opening balances, record income and expenses, and transfer between accounts. Negative balances support credit cards and overdrafts.
- Inspect balances and transactions; filter by account, kind, and search text. Voiding preserves the original entry while excluding it from balances and income/expense totals.
- Amounts are stored as integer cents and calculated with `bigint`. Input accepts at most two decimal places; transaction amounts must be positive. Transfers are excluded from income and expense totals and preserve the combined balance of both accounts.
- Equal splitting allocates remaining cents to the first participants. Splitting CNY 100 among three people produces 33.34, 33.33, and 33.33.
- CSV export/import preserves accounts, opening balances, transaction IDs, and voided status. CSV amounts are integer cents, and each import is limited to 1 MiB. Imports validate the entire batch before saving and reject duplicate IDs. This is the application's interchange format; bank CSV files require conversion. Use the JSON data file for full backups.

Data is validated again on load. Corrupt data stops startup with an error; preserve the original file before restoring a backup. An exclusive lock prevents multiple writers and is released during normal shutdown. After an abnormal exit, first confirm that no other process is using the ledger, then remove its adjacent `.lock` file.

### TS++ in the application

Nominal types distinguish money and identifiers; algebraic data types and exhaustive matching express transaction behavior; compile-time contracts specify core arithmetic properties. Algebraic effects connect storage to file and in-memory test implementations. Transfer contracts prove conservation of the two balances. Split contracts establish the quotient/remainder relationship, and a loop invariant proves that the allocation accumulator equals the total. Behavior tests verify the actual returned array; the current proof model does not track array elements. File handling, HTTP boundaries, and imports use runtime validation and behavior tests. The interface uses ordinary browser JavaScript; business rules live in `.tspp` sources.

### Development

```sh
pnpm --filter @tspp/ledger check
pnpm --filter @tspp/ledger test
```

This is a local, single-user, single-currency ledger. Exchange rates, bank synchronization, and online collaboration are outside its scope.
