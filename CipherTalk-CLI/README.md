# CipherTalk-CLI

`ciphertalk-cli` 提供 `miyu` 命令，用于在命令行、脚本和自动化任务中读取 CipherTalk 兼容的微信本地数据。

这是密语仓库内的独立 Node/TypeScript 子项目。它和桌面版共享同一个 Git 仓库，但拥有自己的 `package.json`、锁文件、依赖、测试、构建产物和发布工作流。CLI 不启动 Electron，配置文件存放在 `~/.miyu/config.json`。

桌面版和 CLI 在运行时互不依赖。需要同步数据层能力时，通过 `npm run sync:upstream` 做人工移植，不直接引用 Electron 模块。

## 开发

```bash
npm install
npm run dev -- status
npm run typecheck
npm test -- --run
```

从密语仓库根目录运行：

```bash
npm run cli -- status
npm run cli:typecheck
npm run cli:test
```

除非明确要做 CLI 发布构建，否则不要运行 `npm run build`。

## 交互模式

在终端中执行 `miyu status` 会先检查状态，然后进入交互式 CLI。进入后所有命令都使用 `/命令` 形式：

```bash
miyu status
miyu> /sessions --limit 20
miyu> /messages "张三" --limit 50
miyu> /exit
```

输入 `/` 会自动显示所有可用命令供选择；输入 `/help` 也可以再次查看命令列表。脚本或管道场景可以显式指定 `--format` 或 `--quiet`，此时 `status` 只输出结果，不进入交互模式：

```bash
miyu --format json status
miyu --quiet status
```

## 发布

CLI 的验证和发布由父仓库中的 `.github/workflows/ciphertalk-cli.yml` 单独处理。该工作流只监听 `CipherTalk-CLI/**` 相关改动，不参与桌面版打包。

发布目标是 npm 官方公开包仓库：`https://registry.npmjs.org`。手动触发工作流并启用 `publish` 后，会以公开 npm 包 `ciphertalk-cli` 发布，用户安装后使用 `miyu` 命令。国内用户可以等待 npmmirror 等镜像同步，或配置 npm 官方源安装。

## 命令

当前已注册的命令入口：

- `/status`：检查配置和数据库连接状态
- `/sessions`：列出会话
- `/messages <session>`：查询会话消息
- `/contacts`：列出联系人
- `/contact <contact>`：查看联系人详情
- `/key get|test|set`：密钥管理
- `/search`：全文搜索
- `/stats global|contacts|time|session|keywords|group`：统计分析
- `/export`：导出聊天数据
- `/moments`：朋友圈数据
- `/report`：年度报告数据
- `/mcp serve`：独立 MCP Server 模式
- `/help`：显示命令列表
- `/exit`：退出交互模式

部分高级命令目前只保留公开接口，会返回 `NOT_IMPLEMENTED`，等待对应服务完成移植。
