# 项目上下文：qdroid

更新：2026-10-29。当前已有最小 trusted host-driver 与固定 Linux OCI 路径的源码、依赖锁和契约测试；Linux 沙箱资格与设备支持分别取证，不能从代码存在推断通过。专用VM的Docker Engine/CLI已固定更新为29.9.2，containerd2.2.1及gVisor保持原配置；T002/T003历史验收使用29.2.1；T004已在29.9.2的新指纹上完成三种离线profile资格及累计验收。

## 项目概览与事实边界

qdroid 面向 Linux 机器人主控的 Agent 应用运行时，首个适配为 T1 Pro。核心接口、插件包、沙箱/权限、显示和凭证服务通过 ports/adapters 分离。仓库基础已发布；用户已授权连续实施 T004—T009，包含项目及现有专用 Linux VM 内必要依赖、镜像、运行时和受控测试环境；测试、独立评审和验收后提交推送并更新 GitHub tracking。T001—T004 已完成；真实机器人操作、真实账号/模型调用、付费远程资源和正式发布仍需对应授权。

事实来源为根 AGENTS.md、README.md、docs/specs、docs/architecture 及代码/锁文件。当前独立 Git 分支是 `codex/project-foundation`；实现版本和验收证据见工程上下文，不把未来候选称为已安装或已通过。

## 仓库结构与入口

| 区域                  | 路径                                                                                             | 当前事实                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 应用/库/CLI           | packages/、apps/cli/、adapters/reference-simulator/、fixtures/readonly-sim/、fixtures/admission/ | 版本化RPC、受信fixture授权、SQLite admission与SIM；代码边界及实际验收见工程上下文 |
| 公共契约              | docs/specs/                                                                                      | 提案，核心、包、安全与T1规范                                                      |
| 架构                  | docs/architecture/overview.md                                                                    | 依赖方向、服务职责与信任边界                                                      |
| 产品/工程上下文       | .sdlc-v1/context/                                                                                | 当前Requirement与Feature正文                                                      |
| 生命周期              | .sdlc-v1/state.json                                                                              | 仅由生命周期CLI修改                                                               |
| 计划/跟踪             | planner/、docs/TRACKING.md                                                                       | 实施依赖、GitHub协作映射                                                          |
| 测试/fixture/运行产物 | tests/contracts/、tests/admission/、tests/recovery/、tests/linux/、fixtures/、dist/              | 契约、事务竞争、崩溃恢复与固定Linux stdio fixture；dist为忽略的本地编译产物       |
| 固定Linux运行         | packages/runtime-oci/、profiles/hosts/                                                           | 可信Docker管理、固定镜像/profile和有界通道；profile JSON是说明而非授权入口        |
| 仓库配置              | .github/、.gitignore                                                                             | Issue/PR模板与私有产物忽略                                                        |

## 技术栈与选择状态

| 领域         | 提案                                                                                                      | 当前安装/验证状态                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core/SDK     | TypeScript 5.9.3、Node 24.16.x、npm 11.13.x                                                               | package-lock已固定；实际host解释器24.16.0/npm11.13.0；版本检查拒绝未验证Node主/次版本                                                                                         |
| 设备provider | 语言无关进程协议；T1可用Python/rclpy或C++                                                                 | none；未安装厂家SDK                                                                                                                                                           |
| Agent引擎    | pi为首候选，保留可替换接口                                                                                | none；未运行模型调用                                                                                                                                                          |
| 存储         | node:sqlite、WAL/FULL；实际 SQLite 为本机 3.53.1 / Linux VM 3.53.0；PolicyAuthority 自有 admission 与审计 | 已实现固定counter的版本化迁移、原子预算/approval/取消、unknown对账；实际崩溃与竞争证据见工程上下文，禁止工作负载挂载                                                          |
| 软件运行     | 目标平台固定digest的OCI产物，gVisor为首隔离候选                                                           | 专用ARM64 Ubuntu24.04/Linux6.8开发VM，Docker29.9.2、containerd2.2.1、gVisor release-20261019.0/systrap；workload固定Ubuntu22.04/Node24.16.0。最终资格见工程证据，不等于T1支持 |
| 显示         | Scene/状态与backend分离，T1首期HTML→MP4                                                                   | none；桌面研究实验不在本仓库冒充设备验证                                                                                                                                      |
| 外部业务     | Mock connector先验证；只读Lark适配后续真实验收                                                            | none；未调用个人账号API                                                                                                                                                       |

## 入口与配置

可信host driver使用 `npm run demo -- --fixture allow|deny|none`；唯一操作指南为 `docs/USAGE.md`。固定Linux路径另由runtime-oci管理，必须先取得同一manager拥有的当前资格handle再运行，不能用外部JSON授权。协议参数由contracts拥有，fixture授权由受信driver持有；没有公开grant管理、宿主exec、HTTP服务或模型/账号凭据入口。可信host driver本身不启动不可信工作负载。

T003 的可信入口为编译后的 `node dist/apps/cli/src/index.js admission-demo --fixture allow|cancel-first|forged|recovery|ungranted`，五种模式均已实跑。新能力须显式协商 `qdroid.admission/v1`；公开Task接口只查询或请求取消，dispatch/reconcile仍为可信接口。USE-002维护完整参数与unknown恢复说明。

安装包manifest示例与未来接口方法位于规范中，明确标为提案。真实凭据由可信connector/model服务管理；应用只能使用当前授予的受限通道。

## 常用命令

```yaml
commands:
  unit: npm test
  coverage: none
  e2e: none
  typecheck: npm run lint
  lint: npm run lint
  build: npm run build
```

以上命令先执行版本检查；`lint`当前为TypeScript no-emit检查，格式检查是`npm run format:check`。没有coverage/e2e命令。`npm test`累计执行contracts、admission和recovery测试。当前累计 Linux 集成入口为 `QDROID_T002_IMAGE=<retained-fixture-image-id> QDROID_T004_IMAGE=<offline-profile-image-id> npm run test:linux`；两个值均为可信本地 immutable image ID，缺任一值会在运行前拒绝。该入口在专用 VM 的最终 T004 输入上实际通过31/31，无skip/cancel；不能省略新增变量沿用历史 T002-only 命令。`npm run sandbox:demo -- --image <offline-profile-image-id>` 已实际通过三个离线profile的公开管理演示。已接受的 T002/T003 公开 CLI 为 `npm run linux:demo -- --image <retained-fixture-image-id>`；它验证固定 host/runtime/image/profile，再执行七种受监督调用和四种 admission 调用。相关环境和准备步骤由唯一 usage 入口维护。

## 验证资源与准备

| 项目          | 当前事实/缺口                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 验证方式      | correctness契约/权限测试；未来真实Web显示再补相应模式；当前内部RPC不虚构OpenAPI入口                                                                                        |
| 工具/测试资产 | Node test runner、TypeScript、Prettier；tests/contracts/、tests/admission/、tests/recovery/及tests/linux/已有资产；实际通过范围见工程上下文，固定ARM64三种离线profile已接受；其他host/image仍须各自资格 |
| 目标环境      | macOS可信host driver与任务专用ARM64 Linux VM；T1未接入，不存私人设备地址                                                                                                   |
| 测试身份      | none；模拟秘密和Mock API优先；真实账号需单独授权                                                                                                                           |
| 运行产物      | runtime-data/、artifacts/private/等已ignore；公共非敏感证据在docs中记录                                                                                                    |
| CI            | none；模板不等于构建/测试工作流                                                                                                                                            |
| 准备缺口      | 其他架构、可配置/完整 Linux 资格矩阵、设备与外部集成；当前固定 ARM64 fixture 的实际资源和清理证据见工程上下文                                                              |

## 变更面映射

下面区分已存在最小实现、规范和计划；新增运行入口时更新相关范围与命令。

```yaml
surfaces:
  - name: core-fixture-runtime
    globs:
      [
        'packages/**',
        'apps/**',
        'adapters/reference-simulator/**',
        'fixtures/**',
        'tests/contracts/**',
        'tests/admission/**',
        'tests/recovery/**',
        'tests/linux/**',
        'profiles/hosts/**',
        'scripts/**',
        'package*.json',
        'tsconfig.json',
        '.prettierrc.json',
        'docs/USAGE.md',
        'THIRD_PARTY_NOTICES.md',
      ]
    roles: [architect, security, server-dev, qa]
    modes: [correctness]
  - name: architecture-and-contracts
    globs: ['docs/architecture/**', 'docs/specs/**']
    roles: [architect, security, qa]
    modes: [correctness]
  - name: product-and-planning
    globs: ['.sdlc-v1/context/**', 'planner/**', 'docs/TRACKING.md']
    roles: [product-owner, architect, qa]
    modes: [correctness]
  - name: repository-foundation
    globs:
      [
        'AGENTS.md',
        'CLAUDE.md',
        'README.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        '.github/**',
        '.gitignore',
        'LICENSE',
        'NOTICE',
        'docs/research/**',
      ]
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
  dev: trusted-host-driver and dedicated Linux VM; qualification scope recorded in engineering context
  staging: none
  canary: none
  full: none
health_check: none
```

预期部署目标为合格Linux机器人主控。当前开发环境与公开产品发布分开，尚未声明T1或完整MVP支持。

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

新增真实运行入口、依赖、测试和部署配置后刷新本文；规范语义变化由当前工程上下文记录并重新评审。Feature计划与进度不在本文重复维护。当前主要缺口是安装/生命周期组合、其他host/image的资格，以及设备与业务集成证据。
