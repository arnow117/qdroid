# 项目上下文：qdroid

更新：2026-10-23。当前为设计与仓库基础；尚无产品运行代码、依赖锁、构建产物或设备验证。

## 项目概览与事实边界

qdroid 面向 Linux 机器人主控的 Agent 应用运行时，首个适配为 T1 Pro。核心接口、插件包、沙箱/权限、显示和凭证服务通过 ports/adapters 分离。用户已授权本次设计/规范/MVP规划、独立仓库发布及 GitHub tracking；没有要求在本轮完成整个 MVP 或接入账号/设备。

事实来源为根 AGENTS.md、README.md、docs/specs 与 docs/architecture。当前独立 Git 分支是 `codex/project-foundation`；初始化尚未产生产品实现 commit。不能把本文未来技术选择称为实际已安装的技术栈。

## 仓库结构与入口

| 区域 | 路径 | 当前事实 |
|---|---|---|
| 应用/库/CLI | none | 尚未实现；代码边界由工程计划定义 |
| 公共契约 | docs/specs/ | 提案，核心、包、安全与T1规范 |
| 架构 | docs/architecture/overview.md | 依赖方向、服务职责与信任边界 |
| 产品/工程上下文 | .sdlc-v1/context/ | 当前Requirement与Feature正文 |
| 生命周期 | .sdlc-v1/state.json | 仅由生命周期CLI修改 |
| 计划/跟踪 | planner/、docs/TRACKING.md | 实施依赖、GitHub协作映射 |
| 测试/fixture/运行产物 | none | 未来任务创建，不伪报已有套件 |
| 仓库配置 | .github/、.gitignore | Issue/PR模板与私有产物忽略 |

## 技术栈与选择状态

| 领域 | 提案 | 当前安装/验证状态 |
|---|---|---|
| Core/SDK | TypeScript，固定受支持Node版本 | none；待实现时锁定依赖 |
| 设备provider | 语言无关进程协议；T1可用Python/rclpy或C++ | none；未安装厂家SDK |
| Agent引擎 | pi为首候选，保留可替换接口 | none；未运行模型调用 |
| 存储 | 本地SQLite；按服务分离journal/registry，授权预算/取消/dispatch admission在同一可信事务所有者内 | 尚未实现或选择驱动/持久性参数，禁止工作负载挂载 |
| 软件运行 | 目标平台固定digest的OCI产物，gVisor为首隔离候选 | none；未通过Linux资格验证 |
| 显示 | Scene/状态与backend分离，T1首期HTML→MP4 | none；桌面研究实验不在本仓库冒充设备验证 |
| 外部业务 | Mock connector先验证；只读Lark适配后续真实验收 | none；未调用个人账号API |

## 入口与配置

产品启动命令、API监听地址、运行时配置文件、凭据变量：none，尚未实现。

安装包manifest示例与未来接口方法位于规范中，明确标为提案。真实凭据由可信connector/model服务管理；应用只能使用当前授予的受限通道。

## 常用命令

```yaml
commands:
  unit: none
  coverage: none
  e2e: none
  typecheck: none
  lint: none
  build: none
```

现阶段仅可进行Markdown链接/示例语法、Git差异及lifecycle状态校验。未来任务建立真实命令后由对应阶段刷新本索引。不得把规范中的未来命令记录为已运行。

## 验证资源与准备

| 项目 | 当前事实/缺口 |
|---|---|
| 验证方式 | 当前文档一致性检查；未来correctness，涉及真实Web显示时补e2e:Web，接口旅程按需补e2e:OpenAPI |
| 工具/测试资产 | none；未来契约、负向安全和Linux隔离资格套件待建 |
| 目标环境 | 实际Linux验证host和T1未登记；不存私人设备地址 |
| 测试身份 | none；模拟秘密和Mock API优先；真实账号需单独授权 |
| 运行产物 | runtime-data/、artifacts/private/等已ignore；公共非敏感证据在docs中记录 |
| CI | none；模板不等于构建/测试工作流 |
| 准备缺口 | 运行代码、依赖锁、Linux环境、实际限额、设备与外部集成 |

## 变更面映射

当前无产品代码；下面只覆盖现有文档/配置。新增源码时必须更新该表。

```yaml
surfaces:
  - name: architecture-and-contracts
    globs: ["docs/architecture/**", "docs/specs/**"]
    roles: [architect, security, qa]
    modes: [correctness]
  - name: product-and-planning
    globs: [".sdlc-v1/context/**", "planner/**", "docs/TRACKING.md"]
    roles: [product-owner, architect, qa]
    modes: [correctness]
  - name: repository-foundation
    globs: ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "SECURITY.md", ".github/**", ".gitignore", "LICENSE", "NOTICE", "docs/research/**"]
    roles: [ai-readiness, security]
    modes: [correctness]
```

## 工程约定与限制

核心只依赖公共contracts，不import厂商SDK；应用、工具/MCP、构建、渲染与可信设备/凭证服务分开。包申请不等于grant；执行端校验实时权限/epoch/lease；未知结果不盲重试。缺少必要隔离则拒绝任务，不回退宿主shell。

公开文档不包含个人主目录、凭据、私有设备地址或未许可厂家软件。本机Agent入口与模型配置通过本地Git exclude保存，不是项目可移植运行依赖。

## 已知风险与未确认事实

设备固件/接口、屏幕归属/编码/排序/恢复、host内核/隔离/限额、原厂共存与资源预算均待实际验证。gVisor/OpenShell/平台标签不能代替资格证据；模拟器不能代替T1，桌面媒体不能代替Linux沙箱验证。见产品上下文的未知项与各规范验收场景。

## 部署与运行环境

```yaml
target: none
config_paths: []
environments:
  dev: none
  staging: none
  canary: none
  full: none
health_check: none
```

预期部署目标为合格Linux机器人主控，但尚无可部署产品。

## 仓库上下文来源

```yaml
root_guidance: AGENTS.md
scoped_guidance: []
canonical_documents:
  - docs/architecture/overview.md
  - docs/specs/core-interfaces.md
  - docs/specs/plugin-package.md
  - docs/specs/sandbox-permissions.md
  - docs/specs/scene-rendering.md
  - docs/specs/t1-adapter.md
repo_context:
  status: none
  analyzed_commit: none
```

这些是工作树内已存在的导航文档，不声称有绑定实现commit的repo-context证据。

## 维护与AI可读性

新增真实运行入口、依赖、测试和部署配置后刷新本文；规范语义变化由当前工程上下文记录并重新评审。Feature计划与进度不在本文重复维护。规范/模板/状态的职责已在AGENTS中明确，当前最大缺口是尚无实现与运行证据。
