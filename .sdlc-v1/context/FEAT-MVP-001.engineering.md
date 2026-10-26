# 工程上下文：FEAT-MVP-001 — 受限机器人应用运行时 MVP

## 当前有效方案

### 架构设计

**关联产品上下文**：[REQ-MVP-001](REQ-MVP-001.product.md)

**工程上下文**：`.sdlc-v1/context/FEAT-MVP-001.engineering.md`

**已确认需求**：产品 C-01 至 C-08、REQ-001 至 REQ-008；EA-* 为工程候选，O-* 为待测事实。

**创建日期**：2026-10-23。**状态**：Plan 已验收，Build 已获授权；T001 已接受，T002 正在实施。精确进度以 lifecycle state 为准。

#### 背景

服务一个结果：受限应用先在 Linux + reference simulator 验证允许/拒绝，再在 T1 本体完成原屏动态内容与语音/机身触摸切页。T001 已建立最小可信驱动、契约、权限持久化与测试；当前实际范围见下方实现和验证记录，不能据此推断完整 MVP 或设备支持。

长期方向的已提交验证基线为 `none`；产品确认来源见产品 SRC-01 至 SRC-07。本方案引用 [架构](../../docs/architecture/overview.md)、[核心接口](../../docs/specs/core-interfaces.md)、[插件包](../../docs/specs/plugin-package.md)、[权限/沙箱](../../docs/specs/sandbox-permissions.md)、[Scene 渲染](../../docs/specs/scene-rendering.md)、[T1](../../docs/specs/t1-adapter.md)，不复制完整规范。

当前用户已授权实施 T001/T002、必要依赖与专用本地 Linux/Docker 环境准备、提交推送和更新 GitHub tracking；不据此启动其余任务、真实账号/模型 API、设备或远程 benchmark。真实外部/物理操作仍需对应授权。移动、第二台真实机器人、fleet 和任意市场不在本 Feature。

复用评估按现有代码→依赖→官方方案进行：源码/依赖搜索为空；可复用资产为规范、研究来源与合成场景设计。[研究基线](../../docs/research/2026-10-22-findings.md) 是有日期的工程输入，不是当前版本/兼容性的实测证据。

| 需求与候选（每域最多三项） | 复用决定与扩展方式 | 未采用项/成本、风险及复核点 |
|---|---|---|
| Agent loop：pi / DeepSeek Harness / 自写完整 loop | 引入 pi 为首候选，包装 AgentBackend；工具只接受信代理 | DSH 的 preview/隔离限制增加成本；不自写模型循环。T007 固定版本并查维护、许可证及 API；不直接加载第三方模块到可信 core |
| Linux 执行：OCI + gVisor / 普通 rootless OCI / OpenShell | 引入 OCI 管理与 gVisor 首候选，扩展 SandboxBackend 资格/限额检查 | 普通容器共享内核不自动满足要求；OpenShell 依赖实际 host 特性。T002/T004 验证；不兼容即拒绝，不静默选弱后端 |
| Scene：Chromium + FFmpeg / HyperFrames | 优先复用固定 Chromium/捕帧与 FFmpeg，自己实现很薄的 Scene/Artifact 流水线 | HyperFrames 为后备复用候选；首期无需完整视频制作平台。T008 固定字体/codec/版本，核对 FFmpeg 构建分发义务和 ARM64 兼容 |
| 业务 connector：官方 authsidecar / 固定语义 shim | 复用官方 transport 为 Lark 首候选；先自研最小 Mock + 可信语义 broker | 官方 demo 缺操作/资源授权、刷新、重放/预算；不能直接投入生产。T009 只验证 Mock；真实 CLI/账号兼容另需授权与证据 |
| 持久化：SQLite | 引入成熟本地事务依赖，按服务拥有数据库；admission 只有一个可信事务所有者 | 不引入分布式数据库。T001/T003 固定驱动/事务/持久性参数并做崩溃/竞争验证；没有跨网络文件共享 |
| qdroid 身份/权限/版本/设备语义 | 自研小型领域服务，复用通用 schema/协议/DB 库 | 现有 harness、MCP、OCI 都不拥有 qdroid 的 grant、epoch、显示证据与设备仲裁，不能代替这些规则 |

现有离线显示 POC 仅可借用 state/time、帧 hash 与资源冻结思路，不复制个人路径/产物或沿用桌面通过结论；没有新 UI 原型要实现。版本、许可、SBOM、source/image digest 与目标 ABI 在各任务实际选择后锁定；依赖下载/安装仅限当前已授权任务；不在该范围内的候选保持未验证。

#### 架构与组件

下列为逻辑目录，不要求分别发布包。core/contracts 不 import adapter；可信服务可受控共同部署，但不与不可信代码共享地址空间、凭据或可写数据。参数和配置以 schema/profile 为准，不在模型文本中提供授权。

##### 受信核心、授权与监督

- **职责**：`packages/core/` 路由与 Task 投影；`packages/policy/` 独立操作者授权及 admission；`packages/supervisor/` 绑定安装/实例/通道；`apps/cli/` 为受限使用/管理员入口。
- **接口**：版本化 JSON-RPC、受监督 stdio；可信私有 IPC 与管理端分开认证。主体由通道解析，参数中的 principal/grant/ticket 不能作为证明。
- **覆盖**：REQ-001、004、008；Task T001、T003、T007。

##### 运行与包管理

- **职责**：`packages/runtime-oci/` + 受信 SandboxManager 选择锁定镜像/profile、隔离/限额/清理；`packages/package-runtime/` 安全暂存、解析、构建、registry 与条件激活。
- **接口**：SandboxBackend 的 qualify/create/execute/stop 与安装生命周期；公开插件不能提供任意 mounts/devices/flags/image。安装许可不创建 grant。
- **覆盖**：REQ-002、003；T002、T004、T005、T006。

##### 应用与扩展适配

- **职责**：`packages/agent-pi/` 复用循环；`packages/mcp-host/` 监督沙箱 MCP；业务 reducer 在应用沙箱；工具描述与返回文本无授权权力。
- **接口**：AgentBackend 的受限工具目录和事件；MCP 初始化/schema/namespace 固定，输出/超时/子孙受控。首期用确定性模型 fixture，provider 连接默认关闭。
- **覆盖**：REQ-001、002、003、007；T007、T009。

##### 产物、Scene 与显示

- **职责**：`packages/artifact-store/` 不可变对象/ACL；`packages/scene-runtime/` 状态/action；`packages/renderer-html-video/` 无凭据渲染；`packages/display/` 协调单一呈现者与 revision。
- **接口**：SceneRef + frozen state/time/seed → RenderResult/ArtifactRef → 授权导入/提交/观察；语音/触摸先变更应用 state，MP4 不保留 DOM 交互。
- **覆盖**：REQ-005、006；T008、T011、T012；渲染细节以 Scene 规范为准。

##### Connector 与设备 provider

- **职责**：`packages/connector-broker/` 拥有凭据/业务策略/刷新，Mock 先行；`adapters/reference-simulator/` 提供可计数故障点；`adapters/primebot-t1/` 隔离 SDK/ROS2/原厂显示与输入。
- **接口**：能力 describe/probe/invoke/observe/cancel/reconcile；robotd 本地资源/lease；T1 player-agent 独立恢复。设备探测只由已授权的可信操作触发。
- **覆盖**：REQ-004、006、007；T001、T003、T009 至 T012。

#### 关键设计决定

##### 决定 1：一个 admission 事务决定是否可以执行

- **背景**：前置检查不能阻止排队期间撤权、预算竞争或取消。
- **决定**：PolicyAuthority 的本地 SQLite admission ledger 同时拥有 live grant/generation、预算/审批消耗、取消标记、幂等映射和 dispatch 意图；broker 在最终发送边界调用 `commitDispatch`，core Task 是投影。
- **替代项/取舍**：拒绝 core 读预算后另行扣减、跨库写两份授权事实。SQLite 不是与厂家/API 的分布式事务；commit 后崩溃可能 unknown，不盲发、不自动退款。
- **覆盖**：REQ-001、004；T003；一次预算并发、取消先后与崩溃子场景。

##### 决定 2：安装的条件切换独立于权限

- **背景**：多个候选/删除/迟到失败会覆盖较新版本。
- **决定**：同 installation 的激活、回滚、移除串行化，使用 `installationGeneration + expectedActiveDigest` 条件提交；暂存内容不可变，运行任务持有版本引用。
- **替代项/取舍**：不用“失败就写回旧指针”；清理尊重引用，回滚不恢复 grant，移除不冒充撤销外部 OAuth。
- **覆盖**：REQ-003；T005、T006；AC-08 的 A/B/移除交错。

##### 决定 3：按真实后端能力发布显示保证

- **背景**：宿主 revision 无法取消已进入厂家服务的旧 RPC。
- **决定**：一个可信 player sender 串行提交；分别保存 rendered/imported/submitted/observed-visible。播放器节点监督 lease 并执行实测的 fallback；无证据的强顺序/敏感显示模式保持禁用。
- **替代项/取舍**：不以 clip 时长当清屏，不关闭 Chromium sandbox，不借降低隔离解决渲染失败。初版无音轨/精准音画同步，软件编码为候选。
- **覆盖**：REQ-005、006；T008、T011、T012。

#### 数据模型 / 关键实体

| 实体/可信所有者 | 最小事实与约束 | 覆盖 |
|---|---|---|
| PolicyAuthority store | grant、issuer、subject、operation/resource、use budget、revocation generation；只有独立管理入口能改变 | REQ-001 |
| Admission ledger，同一 PolicyAuthority DB | admission/task ID、request digest、epoch、cancel marker、use/approval debit、dispatch ticket、状态；事务与唯一键约束幂等/预算 | REQ-001、004 |
| Core Task journal | admission ID、stateVersion、观察证据与 scoped result；不反向覆盖 admission 权威 | REQ-004 |
| Execution journal，robotd/broker | provider/boot epoch、实际提交/观察/停止/unknown证据；本地单调 lease；不共享跨板时钟 | REQ-004、006 |
| Installation registry，supervisor | 内容/平台/profile digest、generation、active digest、attempt、运行引用；条件切换和崩溃恢复 | REQ-003 |
| Artifact metadata/store | owner/task、digest/size/type、可信producer/provenance、validation、expiry/refcount；不信调用者自证来源 | REQ-005、007 |
| Scene/presentation，display/player | state/revision、stream/epoch、队列、lease、提交/可见状态；节点本地恢复责任 | REQ-005、006 |

每个服务的数据库只在所属节点本地打开，权限最小化；不挂到工作负载、不放网络共享文件系统。驱动、busy/commit失败处理及持久性设置须固定并故障验证，失败不允许 dispatch。schema 演进先版本化并备份/验证恢复；禁止以代码回退覆盖仍需对账的 admission 历史。

#### API / 接口契约

- 对外仅开放规范中的初始化、发现/调用、Task/事件、Artifact 与 display 方法；无公开 grant/approval 创建、宿主 exec、raw SDK 或通用凭据代理。对象 ACL 按真实实例/资源验证。
- 协商 protocol/capability/manifest 主版本与必需特性；拒绝不兼容、未知授权/运行时字段和重复 key；兼容可选字段只按 schema 处理。语义变化必须升级版本并重做受影响资格。
- 每次调用锁定 provider/schema/image/profile，不中途切换。超时、取消与期限分别建模；无观察支持不得生成 running/完成/停止。唯一 key 对不同 canonical input 冲突。
- 服务间 ticket 绑定 broker、subject/task、能力/资源、epoch/lease/generation，不能转交任意服务。跨板链路按 DeploymentProfile 认证/授权；同机 sidecar HTTP 不是通用跨节点协议。
- 失败码、错误净化、输出/事件背压沿用核心规范。查询可按明确重试策略执行；可能已提交的副作用只权威对账，不自动换 key 重试。外部写与物理移动均不在本 MVP。

#### 时序与数据流

```mermaid
sequenceDiagram
  participant W as Bound workload
  participant C as Core task projection
  participant B as Trusted execution broker
  participant P as PolicyAuthority admission
  participant V as Simulator or qualified provider
  W->>C: invoke validated input
  C->>B: queue resolved request
  B->>P: commitDispatch at final boundary
  alt canceled, revoked, stale or budget exhausted
    P-->>B: deny with durable reason
    B-->>C: rejected or pre-dispatch canceled
  else admission committed
    P-->>B: bound internal execution ticket
    B->>V: submit once under real contract
    V-->>B: receipt and observation if available
    B-->>C: evidence or unknown
  end
```

图只解释 AC-06/12/13 的权威顺序，未渲染预览；等价流程是绑定身份→可信前检→执行方 commit→厂家调用→观察/unknown。取消与撤权先于 commit 则拒绝；后到不抹去 in-flight。commit 与厂家调用之间崩溃也不自动重发；同 admission 贯穿重启和状态投影。

#### 横切质量设计

- 隔离按确切 kernel/runtime/image/profile/suite 组合保存证据；改任一相关输入重验。首 profile 只承载固定只读 fixture，不借最小增量扩大为通用市场代码资格。
- CPU/memory/PID/disk/IO/output/time、出网、私有 scratch 与子孙清理由宿主边界落实；单 render/单前台应用为工程默认，数值待主控测量，不承诺 T1 SLA。
- 隐私：合成秘密/日程优先；真实凭据不进 workload/日志，数据读取不自动允许模型外传；cache ACL、expiry、移除清理；未证实播放器恢复前仅公开/合成画面。
- 可观测：关联 instance/grant/admission/task/provider/scene revision，净化输入摘要/错误，不收集秘密正文；可核对 dispatch 与观察证据，未知保持可见。

#### 风险与取舍

| 风险 | 影响 | 缓解措施/回滚 |
|---|---|---|
| Linux/T1 不满足隔离或 Chromium 组合 | 不能运行对应不可信包 | T002 早验最小真实组合，T004完整资格；不改内核/关闭隔离；保留失败与未支持能力 |
| SQLite锁/崩溃或两份授权事实 | 超预算或重复副作用 | T003 单权威事务、故障注入；停新dispatch并对账，不退款/删除journal冒充回滚 |
| 安装竞争/GC删除运行内容 | 旧候选覆盖新版本或任务损坏 | T006 条件切换/引用保留；回退仅匹配自己的generation，不恢复权限 |
| 厂家缺排序/clear/取消证据 | 最新画面或停止无法保证 | T011/T012 独立实测；受限模式与unknown，不宣称强保证，敏感Scene禁用 |
| 第三方版本/许可/ARM64依赖变化 | 构建或分发不可用 | 每次实际选型固定版本/provenance；不分发未许可SDK，替换后重验，不沿用候选名称结论 |

#### 需求覆盖

| 产品规格 | 设计覆盖 |
|---|---|
| REQ-001 | 受信核心/PolicyAuthority、决定1、身份/ACL/默认拒绝 |
| REQ-002、003 | runtime/package/supervisor、决定2、固定版本与资格 |
| REQ-004 | admission/Task/execution三种事实、决定1、取消/恢复 |
| REQ-005、006 | Scene/Artifact/display/T1、决定3、输入与本地恢复 |
| REQ-007、008 | Broker/Agent边界、合成fixture、最早增量及当前授权边界 |

### 实施计划

**关联产品上下文**：REQ-MVP-001；**关联设计**：本文架构设计；**创建日期**：2026-10-23；**状态**：已接受并开始实施；Task 状态由 lifecycle CLI 维护。

#### 背景

实现从空代码库开始，任务输出为未来可运行增量；当前先交付已获授权的 T001/T002，后续任务保留计划状态。`planner/sdlc-stage-plan.md` 只导航本文件，不成为第二套方案/状态。

#### 目标 / 非目标

- 目标：先获得真实 Linux 最小边界证据，再完成固定包运行、状态驱动显示、Mock业务与T1固定位置交互；覆盖 AC-01 至 AC-20 的适用环境。
- 非目标：未授权的后续任务、运动、真实账号写入、自动远端执行、任意网站捕获、精确音画同步、强行统一不同设备语义和第二真机支持。
- 真 Lark 只读 CLI、真实模型和实际设备操作均按各自授权选择；Mock完成不允许宣称它们支持。

#### 技术栈

- TypeScript/Node 用于 core/SDK；T001 已锁定实际版本与 workspace 工具，命令及验证范围见 docs/USAGE.md 和实际记录。
- SQLite 本地服务自有存储；驱动、schema migration、事务/持久性设置由 T001/T003 验证后记录。
- OCI + gVisor 为首隔离候选；Chromium/FFmpeg 为渲染候选；pi、authsidecar候选不改变权限边界。T1 provider 语言按SDK实际情况选Python/C++等，不要求core安装ROS2。

#### 实施层决定

##### 决定 1：首增量只依赖 T001 与 T002

候选为“先齐备所有框架”与“固定fixture纵向闭环”；选择后者。T001仅建立足够的契约、监督身份、最小可信grant/admission与SIM只读调用；T002在真实Linux验证所需最低profile后运行固定fixture。复现必须观察一个允许调用成功和一个未授予/伪造主体调用被拒绝、SIM操作计数不增加。

这是首个可独立展示的真实增量；无需包安装、完整pi/MCP、全部AC-02变体、显示、Lark或设备。最低隔离每项真实验证，不能用“后面再做资格”跳过；后续 T003/T004 完成竞争/崩溃和完整资格矩阵。覆盖 REQ-001、002、008；设计：受信核心/运行。

##### 决定 2：每个任务拥有实现及必要验证

默认测试先行覆盖行为/失败，不拆测试工单。实现者负责本任务代码、测试和usage更新；公共schema变更先协调依赖。当前12项默认串行交付，不能因无依赖或不同目录直接并行；主Agent另行确认稳定接口、独立验收、写范围及环境隔离后才能并行。

所有未来命令均须在创建实现入口后实际运行，再写入project/usage。下文以复现方法和目标测试路径定义验收，不捏造当前不存在的CLI flags或通过结果。覆盖全部REQ；设计：上述逻辑组件。

#### 风险 / 取舍

受控Linux环境、T1到货与SDK权限当前未知，工期不按日历承诺。当前 T001/T002 所需本地依赖和专用 Docker 环境已获授权；不包含租用远程资源或刷机。T010可在T001后且设备/只读访问获授权时提前调查，milestone不是技术依赖。具体风险与回滚引用架构风险表，不以关闭隔离换进度。

#### 实施阶段

| 阶段 / GitHub milestone | 增量与任务 | 覆盖 / 设计 |
|---|---|---|
| M0 — Linux sandbox and first capability（1） | T001→T002先展示；T003原子admission恢复；T004完整资格 | REQ-001、002、004、008；核心/运行 |
| M1 — Portable package runtime（2） | T005安全安装→T006生命周期→T007受限Agent/MCP | REQ-001至004；包/扩展 |
| M2 — Interactive scenes and connector（3） | T008 Scene/Artifact呈现；T009 Mock业务闭环 | REQ-005、007；显示/Broker |
| M3 — T1 hardware acceptance（4） | T010设备基线；T011播放器/恢复；T012语音触摸集成与资源预算 | REQ-004至006；设备/显示 |

#### 需求覆盖

| 当前 AC | Task | 计划验证 / 契约 |
|---|---|---|
| AC-01 | T001、T002 | 固定fixture在真实Linux沙箱访问SIM只读结果；核心/安全 |
| AC-02 | T002、T003、T007、T008 | 首次未授予/伪造主体拒绝；完整grant/admin/Task/Artifact ACL变体 |
| AC-03 | T004、T008、T009 | Linux canary、可信store/进程/网络矩阵；renderer/connector隔离 |
| AC-04 | T002、T004 | 缺特性/profile指纹变更拒绝，无host fallback |
| AC-05 | T002、T004、T007、T008 | 实际CPU/memory/PID/disk/IO/output/deadline超额和全部子孙清理 |
| AC-06 | T003、T006 | 排队撤权/lease/代际；一次预算两请求仅一个commit；同幂等不二次扣；unknown不退款 |
| AC-07 | T005 | schema/引用/digest/platform/解包逃逸/竞态/炸弹负例 |
| AC-08 | T005、T006 | 构建失败/中断/重复安装；A迟到失败不能覆盖B，升级/移除条件切换 |
| AC-09 | T006 | 固定任务版本、增权不继承、回滚不恢复grant、移除/GC/外部OAuth分离 |
| AC-10 | T007、T008 | 受限MCP与renderer，文本/action不改权限；schema/事件/输出背压 |
| AC-11 | T001、T007、T008 | 版本/未知必需字段；video/web模拟profile同应用、缺能力拒绝；无第二真机声明 |
| AC-12 | T003、T011 | accepted-only/完成取消交错；取消先commit不得发送，后commit保留真实结果；显示证据分层 |
| AC-13 | T003、T006、T011 | admission/厂家调用/结果前后崩溃；旧epoch/迟到/重复；恢复不盲发 |
| AC-14 | T008 | 固定state/time/seed帧hash、时间变化、完整Artifact/ACL、乱序与输入状态 |
| AC-15 | T009 | 合成凭据Mock操作/资源/重放/刷新/空态/离线/外传拒绝 |
| AC-16 | T010、T011 | T1真实基线/导入解码/原屏播放与退出恢复 |
| AC-17 | T010、T012 | T1真实ASR/触摸、焦点/去重/过期/gap、最终可见页 |
| AC-18 | T011、T012 | T1旧RPC、半文件、协调器/播放器重启、链路丢失、lease本地恢复/残留画面 |
| AC-19 | T010、T012 | 原厂告警/人工接管优先，不误杀原厂，不开放运动 |
| AC-20 | T004、T008、T012 | Linux与T1分别测冷/热延迟/资源；T1温度功耗/共存；预算有证据 |

验证方法是 correctness + 边界/恢复/集成；内部stdio不是HTTP OpenAPI，不虚构API URL。T008的HTML Scene属于固定viewport的Web视觉旅程，准备已提交的 tester-army/e2e Web engine用例，确定性操作不需模型，模型预算为0；选定版本/真实命令由Build核实。完整浏览器套件/截图可补充但不替代适用的正式检查。T1按真实物理步骤/观察取证，不伪装为移动App或桌面浏览器通过。

### 工程任务

**输入**：以上设计/计划与产品AC。每个标题对应一个后续Issue，依赖仅用Task ID；状态唯一由lifecycle state管理。所有代码路径均为未来写范围，不是已存在产物。

#### 路径约定

逻辑目录采用 `packages/`、`apps/`、`adapters/`、`profiles/`、`tests/`、`fixtures/`、`deploy/`；不预先要求独立发布。每项仅改列明区域及受影响根依赖锁；公共契约变更先由主Agent确认。未来全局操作说明只维护 `docs/USAGE.md`，README只索引；故事 USE-001至005映射产品US与AC，参数引用版本schema/profile，不写secret。现阶段它尚不存在，不提供可执行使用承诺。

#### T001 — 最小契约、受监督身份与只读模拟器

- **故事 / milestone**：US-01/02，M0；**依赖**：无。**覆盖**：REQ-001、004、008；AC-01/02/11的基础子场景。
- **代码写范围**：根workspace/锁/formatter/test配置，`packages/contracts/`、`packages/core/`、`packages/policy/`、`packages/supervisor/`最小切片，`apps/cli/`、`adapters/reference-simulator/`、`fixtures/readonly-sim/`、`tests/contracts/`、`docs/USAGE.md`。
- **交付**：只实现初始化、只读SIM调用、实际通道身份、最小operator fixture grant/admission与净化审计；无第三方安装、动态插件加载或真实模型。固定测试代码只作受信驱动，不在host执行不可信插件。
- **完成条件**：同schema可得正常SIM结果与未授予/伪造主体拒绝；版本/必需字段错误在调用前拒绝；SIM计数、instance/admission/task可关联。锁定实际工具版本/许可证，格式/类型/最小构建与行为测试通过。
- **验证环境 / 方法**：本地受控开发环境，契约fixture输入→受信driver→SIM；测试不是Linux隔离证明。创建且实际运行真实测试/CLI入口后记录命令，不以本任务声称沙箱可用。
- **授权 / 设备前置**：另一次Build授权及本地依赖操作许可；不需设备/账号/API。**usage**：USE-001说明当前受信fixture范围、schema参数与失败反馈。

#### T002 — Linux 最低隔离与允许/拒绝真实闭环

- **故事 / milestone**：US-01/02，M0；**依赖**：T001。**覆盖**：REQ-001、002、008；AC-01、02最小子场景，AC-04/05最低profile部分。
- **代码写范围**：`packages/runtime-oci/`、`packages/supervisor/`运行装配、`profiles/hosts/`最小资格、`fixtures/readonly-sim/`镜像、`tests/linux/first-call/`、`docs/USAGE.md`。
- **交付**：选定并固定Linux/backend/image/profile，真实受限fixture通过绑定通道访问只读SIM；容器管理权限留可信manager，不向workload传host资源或凭据。
- **完成条件**：先实测该fixture要求的所有最低属性：只读root、私有scratch/身份、canary/秘密不可读、默认拒绝出网、CPU/memory/PID/disk/output/time有界与子孙清理；随后允许调用成功、未授权/伪造主体被拒且SIM计数不增加。缺任何必要属性即拒绝，无host fallback。
- **验证环境 / 方法**：实际Linux受控host，固定digest镜像与合成canary；运行检查→启动fixture→检查两调用及清理，输出版本/设置/原始退出码与证据。只声明此最低profile范围，不冒充T004完整资格。
- **授权 / 设备前置**：Linux访问、所需运行时配置/下载/安装须另获授权；无T1/账号/模型。**usage**：USE-001按实际入口复现，参数由host/installation schema提供。这是T001+T002的首个真实增量。

##### T002 当前执行方案（已获授权）

- **环境与镜像**：专用本地 ARM64 Linux VM，Ubuntu 24.04 / host kernel 6.8；应用镜像使用固定 Ubuntu 22.04 digest，参考 T1 SDK 的 Ubuntu 22.04 基线，不为 SIM 安装 ROS2。Node 固定 24.16.0，broker 与 workload 都在 Linux 运行；不挂载 host 工作目录。当前实测 Docker 29.2.1，gVisor release-20261019.0（完整 sidecars）+ systrap；这是开发资格环境，不是 T1 host 资格。
- **固定最低 profile**：trusted manager 使用 Docker argv API、固定 runtime/image/entrypoint；network none、readonly root、uid/gid 65532、cap-drop ALL、no-new-privileges，512 MiB memory/swap、0.5 CPU、host pids 256、guest nproc 32、core 0、16 MiB noexec/nosuid/nodev 私有 tmpfs。缺任一必要特性拒绝，不选择 runc/host fallback。探针可使用同一镜像内受信测试入口；真实应用不能选择 command/flags/mounts/devices。
- **通道与权限**：supervisor 创建实例和私有 stdio 绑定，增量解析有界 JSON-RPC frames、拒绝重复 key/未知字段；stderr、总输出、期限有界。Policy DB/grant 和 Docker socket 不进入 workload；可信 broker 独立验证 provider 操作计数，不信客户端自报身份、权限或计数。
- **实测资格**：在最终镜像/profile 上运行 root/scratch 写入、nonroot/caps/no-new-privileges、既有 host canary 与另一实例 scratch、秘密/socket/store 不可读、实际可达控制目标的 TCP/UDP/DNS/IPv6 默认出网拒绝，CPU 节流、memory OOM、guest/host PID、scratch ENOSPC、output/deadline 与全部子孙清理。控制目标使用合成数据；T004 完整代理/重定向/rebinding 矩阵仍未完成。
- **证据与拒绝**：资格绑定实际 host kernel/arch/boot、Docker/runtime 版本及二进制/config、image ID/digest、profile/suite；改变相关输入就失效。不能通过外部 JSON 的 passed=true 取得授权。受信内存 handle 或同等可信资格拥有者控制执行，缺失/不匹配时 fail closed。
- **首闭环**：allow 实例真实 stdio 只读调用成功，host simulator count=1；none/deny 实例拒绝且 count=0；active deny 优先，伪造 authority/重复 key/不支持方法拒绝，count 不增加。停止必须确认实际容器与子孙结束及任务附件移除，不能只杀 Docker CLI。
- **验证范围**：只资格化这个固定 ARM64 fixture；不声称 AMD64、任意第三方包、T1 内核或其他后端支持。完整 admission 竞争/恢复仍由 T003 承担。构建、测试、复现及失败反馈同步到唯一 docs/USAGE.md；公共记录不包含私人路径、proxy 配置或凭据。

##### T002 有效修正方案（2026-10-26；替代本次失败后的环境归因）

独立只读复核发现了具体的资格探针缺陷：secret/store 参数未传入却把 TypeError 视为不可读；host `/tmp` canary 的同名 sandbox 私有文件写入被误判为 host 修改；I/O 在读操作前采样后使用旧 statistics；Docker Unix socket 用文件读取而非连接验证；create 失败在清理范围外。基于这些源码证据修正同一 T002，不先归因为 gVisor 环境限制，不调整权限或最低验收条件。

- 对所有合成路径校验实参，以可读文件/可连接合成 socket 的正向控制证明实际使用目标；参数和未知探针错误不能计作隔离通过。host canary 的修改结果以 broker 复查 host 内容为准，保留实际写入尝试与私有 scratch 行为。
- I/O 使用有界、确实发生在读操作之后/期间的同设备 cgroup 计数证据，并记录隔离读操作的实际耗时；不能用启动时旧值、整个 suite 时长、配置存在或空计数证明限速。不得增加无关 sleep、全局清 cache、切 runc 或放宽控制。
- 容器名的管理责任覆盖 create 的非零退出/超时等不确定结果，清理已知名称并保留无法确认时的失败；正常 fixture 接收响应后自行退出，正常场景区分 completed 与 deadline。
- 同一实现者批量修正、增加比例适当回归并更新 usage，然后冻结源码重建镜像，保存原始日志/逐文件摘要并运行一次完整 Linux 资格和 first-call。失败时按实际新增证据判断，不连续盲改/重跑；此前诊断 allowance 和非收敛历史不重置。主 Agent 复核修正和集成后才可接受、提交及更新完成状态。

##### I/O 资格方法补充（2026-10-26）

固定 [gVisor release 源码](https://github.com/google/gvisor/blob/release-20261019.0/pkg/sentry/fsimpl/gofer/inode_impl.go#L114-L137) 显示 guest 的 `O_DIRECT` 没有传给 host 文件打开参数，故 image-layer 上的 guest direct-read 不能保证冷的 host I/O。主 Agent 只读检查确认专用 VM 的 `/mnt/lima-colima-qdroid-t002` 与 Docker 数据目录均属于 `/dev/vdb1`，后者是该盘 `/docker` 子目录的挂载；当前 broker UID 为 501，现有挂载点归 root 所有。这是方法修正的依据，不是限速通过证据。

资格测试采用 manager 拥有的合成文件，位于该专用盘预建的 `qdroid-t002-io` 目录。目录限当前可信 broker，随机任务文件为非稀疏、已同步、无秘密的数据；核对实际文件所在设备、路径归属与无 symlink 后，按 [GNU dd 的文件级 nocache 方法](https://www.gnu.org/s/coreutils/manual/html_node/dd-invocation.html) 仅请求丢弃此文件的缓存并检查退出结果。只在 I/O 资格 probe 的固定路径添加这一项只读、私有传播的合成文件挂载，逐项核对 inspect；普通 workload/profile 不获得 mount 参数或 host 路径入口。

I/O probe 仍使用相同最终镜像、runtime、cgroup 设备/限额、非 root 和其余限制。实际读耗时不包含初始化或采证等待；同一 live cgroup 必须记录真实设备读字节及既定限速，不能因缓存清理命令成功就视作通过。资格后有界删除 probe 容器和合成文件。host/runtime/profile 或 probe 方法相关输入改变时重验。禁止全局 drop_caches、raw block-device passthrough、真实 host 数据挂载、runc/host fallback 或任何 app 自选 mount；本补充不增加应用权限，也不扩展 T004 的通用资格范围。该专用开发盘准备及合成文件测试属于现有 T002 本地环境授权。

##### I/O probe 正常退出修正（2026-10-26；额外定向诊断后的有效方案）

唯一额外诊断于 UTC 04:06:46 前完成，主 Agent 已读取原始结果：合法 read 已送达，dd 的 exit/close 均为 0，read-complete 已发出，guest 读耗时 16004.819112 ms，2 秒采证等待已结束；随后仍由 deadline 终止（exit 143），stdin 未 destroyed/ended，容器清理确认。失败已定位到完成读取后的 probe 生命周期，不将读取或 cgroup 配置认定为失败原因。此定位不代表全部资格已通过，尤其读字节增量与最终 first-call 仍须重验。

同一实现者在 probe 完成唯一输入命令后显式释放该输入流，并覆盖结束/错误路径；保持读量、采证窗口、profile、25 秒 probe deadline、普通 workload 的 5 秒预算及权限不变。增加进程级回归：父端发送合法命令但保持 stdin 打开时，probe 的对应生命周期仍应自然完成退出 0；不能用父端 EOF、强制 process.exit 或调高 deadline 使测试通过。源代码和镜像重新固定后运行适用 contract/static 检查与完整 Linux 验收，再由主 Agent 集成与复核接受。此为已有定位证据支持的修正，不新增诊断轮次；此前失败和两次诊断授权均保留。

##### 根目录写入与子进程观察修正（2026-10-26）

I/O 生命周期修正后的完整验收已得到 16777216 字节的实际读增量、16038.43642 ms 的读取耗时；原输入未关闭也由父端保持 writable 的失败先行回归复现并修正。新的资格汇总显示 rootMountReadOnly=true、readOnlyRoot=false、descendantCleanupConfirmed=true、descendantsObserved=false；不是重复旧 I/O 失败。

主 Agent 复查当前源码：根目录写入选在 `/etc`，固定非 root UID 本就缺少该目录写权限，无法排除 DAC 抢先拒绝；子进程观察无论实际任务期限多长，只观察启动后的 400 ms。修正方法为：镜像内预建无秘密、目录权限明确允许 guest 写入的 root-filesystem 控制路径，检查其权限前置，再实际写入并要求 EROFS，同时继续要求 root mount 为 ro；不接受普通 EACCES 作为只读证明。子进程观察覆盖原有任务 deadline 内的剩余时间，仍必须通过真实进程表发现 child，并确认停止和容器移除；不依靠 self-report、不延长任务 deadline、不去掉观察断言。加入控制路径和延迟出现子进程的必要回归、保留有限失败字段后，固定新镜像重跑完整资格和 first-call。若仍失败按实际证据报告，不盲改或追加诊断；失败史和次数不重置。

##### gVisor 子进程观察接口修正（2026-10-26）

上一修正后的汇总已确认根目录 EROFS、I/O 和其他探针通过，但原 2 秒内 `docker top` 的 27 次成功采样都只见一个 host 进程。固定版本 [gVisor 资源模型](https://github.com/google/gvisor/blob/release-20261019.0/g3doc/architecture_guide/resources.md#processes) 明确说明 guest 进程不表现为 host 进程，进程级交互需进入 sandbox；[runsc ps](https://github.com/google/gvisor/blob/release-20261019.0/runsc/cmd/ps.go) 读取的是 guest Processes。故 host `docker top` 不能作为 guest child 的观察接口，这是接口语义错误，不能靠延长采样或去掉 child 要求解决。

当前 Docker 固定 fixture 改用可信 manager 执行固定的 guest `/proc` 观察器（Docker exec），不接受 workload 提供的命令、PID 或进程报告。观察器不再派生子进程，返回自身 PID 以及有界的 guest PID/PPID 记录；必须排除 observer 自身，明确找到 workload init（PID 1）的另一个真实 child，不能用包含 observer 的总行数判断。观察仍受原 2 秒期限及命令/输出上限约束，停止和移除断言保留。对只有 init+observer、延迟真实 child、异常输出/早退加必要回归。命令/脚本固定在可信源码和最终镜像中，普通应用无 exec 或管理接口权限。保留实际 guest 观察证据并在新镜像上重验完整资格与 first-call；这是依赖语义与已有观测支持的实现修正，不再追加诊断轮次或改变隔离预算。

##### 合成网络目标逐协议正控制修正（2026-10-26）

最新 guest observer 快照的 Linux suite 已退出 0，但主 Agent 静态复核确认网络正控制只连接 TCP/IPv4；UDP、DNS 和 IPv6 只 bind/listen，不能证明负向探针确实指向可达目标。此外 DNS query 把六字节 `qdroid` 标签长度编码为 7，需修为有效的合成 `qdroid.invalid` 数据报。这是具体源码缺口，前一成功 run 保留为当时事实，不能直接作为最终接受证据。

同一实现者补齐四个现有合成目标的 broker 正向访问，逐一确认对应 listener 收到预期控制连接/数据报，有界失败并清理全部已打开目标；正向完成后清零，再执行原 sandbox 负向尝试。reachable 必须由各协议真实控制结果得出，不能常量 true 或只用聚合 count>=1。保持 network none、原 runtime/profile、期限、地址范围及全部权限不变；不加入真实 DNS/互联网、代理、重定向或 T004 范围。加入比例适当的缺单项拒绝、清零/cleanup 与 DNS wire encoding 回归，重新固定 manifest 和镜像，执行适用静态/契约检查及一次完整 Linux suite。主 Agent 随后按唯一 usage 做 CLI 集成并由同一独立 reviewer 复核增量，再决定 T002 done/提交/推送。此为已有观察支持的修正，不新增诊断授权或重置失败史。

##### TCP 正控制超时取消修正（2026-10-26；最终独立复核）

四协议正控制补齐后的 Linux suite 与主 Agent CLI 集成均成功，但最终独立复核定位到 `connectTcp` 的失败清理只执行 `socket.end()`；未完成连接需要销毁该 manager 自有 socket，避免继续等待系统 TCP 握手超时。正常连接、四项 receipt 和负向计数证据不因此被否定，最终 T002 仍须接受这个失败分支的修正。

同一实现者仅修正超时/失败时对该自有连接的强制取消，并用可控、未完成连接回归证明有界释放和保留原始失败；不改变正常控制目标、应用权限、profile、500ms 等待或底层运行时。不以真实外网 blackhole 作为测试依赖。执行必要 contract/static 检查、更新源码 manifest 并同步 VM，运行一次完整 Linux suite 确认最终 broker 与既有镜像仍一致通过；fixture 镜像源未变时复用其 immutable image，不为 broker-only 修正另建镜像。独立 reviewer 复核这个局部差异，主 Agent 核对后接受。保持失败史和已使用诊断授权；这是具体审查发现的清理修正，无新增诊断轮次。

#### T003 — 原子 admission、取消与未知结果恢复

- **故事 / milestone**：US-01/05，M0；**依赖**：T002。**覆盖**：REQ-001、004；AC-02完整策略部分、AC-06、12、13及其预算/取消子场景。
- **代码写范围**：`packages/policy/`事务与管理入口、`packages/core/`Task投影、`adapters/reference-simulator/`故障provider、`tests/admission/`、`tests/recovery/`、`docs/USAGE.md`。
- **交付**：本地SQLite的单一admission权威、grant策略交集/拒绝、use/approval/cancel/dispatch记录、幂等对账；Task/执行journal引用同admission，管理端不可由workload调用。
- **完成条件**：一次预算并发两请求仅一条commit，同幂等不二次扣/无约束重发，unknown不自动退款；撤权/过期/排队取消先commit则无副作用，commit先则依provider证据；accepted-only不伪造完成；同key不同digest拒绝。
- **验证环境 / 方法**：受控Linux + 可计数合成provider；逐个在commit/调用/结果持久化前后崩溃，重启/旧epoch/迟到/重复均能核对预算、cancel、次数和历史。SQLite contention/commit失败必须拒绝新发送；不操作真机或真实写API。
- **授权 / 设备前置**：后续Build与测试host许可，无真实外部效果。**usage**：USE-002说明Task/取消/unknown查询与恢复决策；不能提供“一键重试未知动作”。

#### T004 — 完整 SandboxBackend 与隔离资格

- **故事 / milestone**：US-01/05，M0；**依赖**：T003。**覆盖**：REQ-002、004；AC-03至06、20的Linux部分。
- **代码写范围**：`packages/runtime-oci/`、`packages/supervisor/`清理/限额、`profiles/hosts/`、`tests/qualification/`、`fixtures/host-boundary/`、`docs/USAGE.md`。
- **交付**：tool/build/render所需可配置但不可由插件放宽的合格profile、特性/配置指纹与失效规则、全子孙清理、实际限额/网络约束；不足的profile禁用。
- **完成条件**：真实负例覆盖host/跨app/可信store/进程秘密、控制设备/网络、管理socket、IPv4/6直连/DNS/UDP/private/link-local/redirect/适用rebind；实际触发CPU/memory/PID/disk/IO/output/deadline；取消/超额只影响所属任务，其他探针继续服务。
- **验证环境 / 方法**：固定Linux kernel/runtime/image/profile/suite，在隔离测试网络和合成秘密下逐项攻击/超额并核对拒绝、资源与清理；更换profile/缺特性/关闭必要控制必须拒绝。输出Linux基线，不作为T1资格。
- **授权 / 设备前置**：后续受控Linux实验与runtime配置许可；不能对在线机器人/个人账号做破坏性资格测试。**usage**：USE-001/002的qualification要求及拒绝恢复。

#### T005 — 固定包、安全解包与无凭据构建安装

- **故事 / milestone**：US-05，M1；**依赖**：T004。**覆盖**：REQ-002、003；AC-07、08的暂存/构建/重复安装部分。
- **代码写范围**：`packages/package-runtime/`fetch/stage/schema/lock/build/disabled-registry，`packages/contracts/`包schema，`fixtures/packages/`、`tests/packages/install/`、`docs/USAGE.md`。
- **交付**：按明确平台/source/digest解析固定内容，安全暂存/冻结与依赖构建，注册installed-disabled；不自动grant/启动。fetch/build使用受限服务和已批准registry，许可/provenance随产物记录。
- **完成条件**：遍历/链接/可变路径竞态/设备文件/模式/重复路径/炸弹、缺引用/重复key/未知runtime字段、digest/platform/version错均拒绝；build无账号/模型/robot秘密，不在可信host执行hook；重复digest不重复注册实例/grant，失败不动当前版本。
- **验证环境 / 方法**：真实Linux build profile + 本地/隔离registry fixture；对恶意archive、构建窃密/出网、中断各跑固定用例，核对包根外canary、registry、临时资源和旧版本。
- **授权 / 设备前置**：后续Build/registry访问许可，无设备/真实账号。**usage**：USE-003的manifest请求、lock来源、installed-disabled与失败处理。

#### T006 — 条件激活、升级回滚与移除

- **故事 / milestone**：US-05，M1；**依赖**：T005。**覆盖**：REQ-001、003、004；AC-06、08、09、13的安装生命周期部分。
- **代码写范围**：`packages/package-runtime/`activation/registry/GC、`packages/supervisor/`版本实例引用、`packages/policy/`撤权集成，`tests/packages/lifecycle/`、`docs/USAGE.md`。
- **交付**：串行化单installation的激活/回滚/移除；generation+expectedActiveDigest条件切换与持久attempt；运行任务保持内容引用；权限变化独立于包指针。
- **完成条件**：A候选迟到失败不覆盖B成功，升级/删除竞态不复活已移除包；崩溃恢复只有正确活动选择，GC不删运行引用；新增权限不继承，回滚不复权；移除失效代理/清理私有scratch/cache且保留非秘密审计，外部OAuth明确独立。
- **验证环境 / 方法**：Linux安装fixture + 两候选/移除同步屏障，逐步崩溃与重启；核对active generation/digest、运行内容、grants/keys与GC引用，不以单次顺序成功代替竞争测试。
- **授权 / 设备前置**：后续Build授权，无设备/账号操作。**usage**：USE-003的权限差异、回滚和移除恢复；不能承诺回滚撤回副作用。

#### T007 — 受限 AgentBackend 与本地 MCP 生命周期

- **故事 / milestone**：US-01/02/05，M1；**依赖**：T006。**覆盖**：REQ-001至004、007；AC-02、05、10、11。
- **代码写范围**：`packages/agent-pi/`、`packages/mcp-host/`、`packages/contracts/`适配schema、`fixtures/agent/`/`fixtures/mcp/`、`tests/agent-mcp/`、`docs/USAGE.md`。
- **交付**：固定pi候选版本的受限工具目录/事件适配、确定性模型transport fixture、本地stdio MCP在各自沙箱启动；不把市场npx/第三方模块载入可信core。
- **完成条件**：正常工具调用走admission；描述/返回prompt注入无增权，MCP工具列表变化不能自动加权；初始化/调用超时、stdout协议、stderr/输出长度、schema/事件ACL/backpressure与子孙取消受控；task查询与管理端越权拒绝。
- **验证环境 / 方法**：Linux已合格profile + malicious MCP/agent fixtures，正常、空输出、超时/断连、洪泛、旧epoch/版本不兼容与隐藏私有发现用例；模型调用数为0。若pi不兼容先返回证据更新方案，不绕过可信校验。
- **授权 / 设备前置**：后续依赖/Build许可；无模型API、账号/设备。**usage**：USE-001/002的受限Agent/MCP入口和unsupported状态。

#### T008 — Artifact、Scene 与受限视频呈现闭环

- **故事 / milestone**：US-04，M2；**依赖**：T006。**覆盖**：REQ-002、005；AC-02/03/05/10的render/Artifact部分、AC-11、14、20的Linux部分。
- **代码写范围**：`packages/artifact-store/`、`packages/scene-runtime/`、`packages/renderer-html-video/`、`packages/display/`，`adapters/reference-simulator/`显示实现、`apps/examples/calendar-card/`、`tests/scenes/`/`tests/e2e/`、`docs/USAGE.md`。
- **交付**：两页公开/合成日程Scene + next/back/close，冻结state/time/seed逐帧渲染、bounded FFmpeg/验证/Artifact发布/模拟导入呈现；video/web模拟profile复用相同state/action。
- **完成条件**：遵守Scene规范、保留Chromium sandbox、无音轨；重复帧hash一致且时间改变目标像素，MP4 byte identity另测不混淆；外部资产/host scheme/无效action/超额timeline拒绝；半文件/错digest/跨app产物不发布，旧未发revision丢弃，四类显示证据分开。
- **验证环境 / 方法**：真实Linux render profile + 固定浏览器/fonts/codec，成功/忙/空/失败和乱序/取消/encoder OOM用例；准备并运行已提交tester-army/e2e Web engine固定viewport测试与确定性结果断言，截图/帧/trace仅证据。无模型调用、无真实WebView支持声明。
- **授权 / 设备前置**：后续依赖/Build/Linux许可，无设备/账号。**usage**：USE-004解释state驱动切页、frame/profile参数来源、私有cache规则及SIM证据范围。

#### T009 — ConnectorBroker 与只读 Mock 业务闭环

- **故事 / milestone**：US-06，M2；**依赖**：T007。**覆盖**：REQ-001、007；AC-03的凭据部分、AC-15。
- **代码写范围**：`packages/connector-broker/`、`fixtures/connectors/`Mock API/secret/refresh、`tests/connectors/`、`docs/USAGE.md`；仅接口/目录预留Lark映射，不启用真实路由。
- **交付**：受限只读日程语义操作、账户/范围映射、实例代理、刷新单飞/重放与响应过滤；分开读授权与模型披露策略。评估固定authsidecar适配所需差异并记录候选，不把demo当权限服务。
- **完成条件**：允许/空数据结果、离线/刷新失败可辨；method/path/query/body/资源/身份修改、重放/过期key、伪造合法代理签名越权均拒绝；合成凭据不入workload/log；未授权外传在模拟route拒绝。
- **验证环境 / 方法**：Linux connector profile + 合成秘密/隔离Mock API/刷新并发，绕过CLI直接构造请求验证broker；记录实际操作计数和秘密canary扫描。这里不验收真实Lark OAuth或官方CLI兼容。
- **授权 / 设备前置**：后续Build许可；真实只读Lark CLI/账号接入需明确授权、scope/凭据策略和独立实际证据，未满足保持未支持；不作为Mock验收前置。**usage**：USE-005区分Mock与live。

#### T010 — T1 设备基线与受信适配器探测

- **故事 / milestone**：US-03/04，M3；**依赖**：T001。**覆盖**：REQ-003、006；AC-16/17/19的前置事实、AC-20设备基线。
- **代码写范围**：`adapters/primebot-t1/`只读probe/descriptor/status，`profiles/robots/`/`profiles/hosts/`/`profiles/deployments/`发现值，`tests/t1/probe/`、`docs/USAGE.md`。
- **交付**：实际board/OS/kernel/ABI/SDK/firmware、权限/资源/屏幕节点与恢复路径记录；只读探测真实ASR/touch schema、事件与原厂控制来源；能力默认unverified/disabled。合法用户自取SDK，不分发无许可材料。
- **完成条件**：公开profile仅含可公开版本/能力事实，私人地址/日志留私有；识别实际输入finality/duplicates、屏幕导入节点、vendor优先级/接管限制，未知项清楚；core/Skill无ROS/vendor依赖。
- **验证环境 / 方法**：到货T1上的有限只读清单与服务观察，保留实际命令/退出结果；host安全feature只探测不冒充T004资格。无设备则Task不可标完成，可先产出probe代码但明确未验收。
- **授权 / 设备前置**：合法设备访问与只读探测授权；不刷机、不升级内核、不发运动/显示控制。**usage**：USE-004设备前置和实际支持范围，不公开连接凭据。

#### T011 — T1 媒体导入、串行播放与本地恢复

- **故事 / milestone**：US-03/05，M3；**依赖**：T008、T010。**覆盖**：REQ-004至006；AC-12/13的显示部分、AC-16、18。
- **代码写范围**：`adapters/primebot-t1/`media/player-agent、`packages/display/`设备装配、`profiles/hosts/`实际资格配置、`deploy/t1/`受限服务模板、`tests/t1/display/`、`docs/USAGE.md`。
- **交付**：可信Artifact导入实际player节点，验证完整性/原子选择、单sender与lease；player节点独立supervisor恢复预生成安全/原厂画面，按实测能力发布限制。
- **完成条件**：公开/合成媒体实际原屏播放/退出恢复；半传输/错digest拒绝；旧RPC/epoch、timeout未知、协调器/播放器重启、心跳/板间链路丢失/有限clip结束逐项有观察；无恢复上界则敏感模式禁用，无法保证的latest-visible不声明。
- **验证环境 / 方法**：T1实际解码/尺寸/格式、原厂显示与告警共存，受控故障矩阵记录提交与可见证据、残留帧/恢复耗时；不终止共享vendor服务，不以宿主日志代替屏幕观察。
- **授权 / 设备前置**：设备部署/显示控制/有限故障实验单独授权；T1所选runtime组合亦须对应资格，不能搬用开发Linux报告。**usage**：USE-004的import/profile/lease、退出和unknown恢复。

#### T012 — T1 语音触摸交互与资源预算集成

- **故事 / milestone**：US-03/05/06，M3；**依赖**：T007、T009、T011。**覆盖**：REQ-004至007；AC-17、18、19、20及全链路相关AC。
- **代码写范围**：`adapters/primebot-t1/`input/session-mode，`profiles/robots/`绑定与预算、`apps/examples/calendar-card/`状态/反馈集成、`deploy/t1/`最小装配、`tests/t1/journeys/`、`docs/USAGE.md`。
- **交付**：固定位置应用接收实测ASR/机身触摸并改变state，显示动态卡片；会话/原厂模式有lease与崩溃恢复；用合成或Mock日程完成整体旅程，测量并落实T1预算。
- **完成条件**：两种输入分别next/back/close正确；焦点、重复/过期/gap、快速翻页最终实际可见符合声明模式；人工接管/告警优先、崩溃不争抢；冷/热与缓存延迟分布、CPU/峰值内存/磁盘/功耗温度和原厂共存有证据，超预算拒绝/缩小已验证规格。
- **验证环境 / 方法**：T1真实观察/屏幕证据与原始调用记录，按usage走正常/空/失败/离线/取消/恢复；Linux回归与设备结果分列。必要AC未测不以代码/桌面视频补通过；不开放运动，不要求真实账号或模型。
- **授权 / 设备前置**：真实输入/显示/会话及有限故障测试授权；原厂人工接管可用。**usage**：USE-004/005完整旅程与参数来源。Task实现含必要集成验证，之后仍需正式Validate/Review，不替代阶段验收。

#### 依赖与执行顺序

依赖为 T001→T002→T003→T004→T005→T006；T006→T007→T009，T006→T008；T001→T010；T008+T010→T011；T007+T009+T011→T012。无环；第一个代码任务是 T001。T010仅在设备到货/授权后可提前开始，不阻塞Linux首增量。

#### 执行策略

先演示T001+T002的有限真实结果，保留未覆盖AC；然后逐项交付本任务的实现/必要测试。每次证据记录commit、依赖锁、环境/profile、身份/权限引用、命令/结果和范围；实际结果只进下方记录。公共代码/配置变更后重验相关证据；schema/持久格式/跨板协议偏离规范先由主Agent更新当前有效方案，不由worker临时扩大。

后续Build按既有Sol决策/Terra实现路由，单一implementer完成有界任务及修正。非收敛停止与有限诊断遵循项目AGENTS及stage-agent-protocol；不能靠换Task名、换worker、反复重跑清除失败历史。当前用户已授权完成 T002 修正、专用本地 Linux/Docker 验收、通过后提交推送与 GitHub tracking；仅继续 T002，不启动后续任务或真实设备/账号/模型 API。

## 实现记录（实际）

- **T001（主 Agent 已接受）**：建立 npm workspace、锁文件、TypeScript/Prettier 与 Node 原生测试入口。实际测试解释器为本机已有的 Node `v24.16.0` / npm `11.13.0`，而非未验证下载的较新 Node 24 补丁版本；该 Node 的 `node:sqlite` 已实际创建、写入并读取 SQLite 表。固定开发工具为 TypeScript `5.9.3`、Prettier `3.6.2`、`@types/node` `24.10.0`，完整解析版本、完整性值和许可证见 `package-lock.json` 与 [第三方声明](../../THIRD_PARTY_NOTICES.md)。
- **最小实现**：`packages/contracts/` 定义严格、版本化 JSON-RPC DTO 和唯一允许的 `sim.status.read/v1` schema；`packages/supervisor/` 只向 Core 传入其创建的 installation/instance/boot/epoch/channel binding。调用参数中出现 `principal`、`grantId`、`ticket` 或 `instanceId` 会在 admission 前以验证错误拒绝。
- **可信路径**：`packages/policy/` 使用本地 SQLite 的 `WAL` 与 `synchronous=FULL`，在调用 provider 前持久化 request digest、input scope、policy generation、grant、admission 和 task；审计只保存关联的 opaque ID、digest 和 outcome。同一主体/能力的任一 active `deny` 优先于所有 active `allow`，不因后续 allow 隐式停用旧 deny。`packages/core/` 只依赖 contracts 中的 `ReadonlyCapabilityProvider` port；`adapters/reference-simulator/` 由受信 fixture 注入，独立维护实际操作计数。provider 调用或结果 journal 出错后，admission/task 保留为 `unknown` 并返回净化的不可盲重试错误；admission 写入失败则在调用 provider 前返回可安全重试的服务不可用。T003 仍拥有并发、取消、崩溃恢复与完整状态矩阵，不能从本实现推断已完成。
- **使用入口**：[docs/USAGE.md](../../docs/USAGE.md) 是 USE-001 的唯一操作说明。它明确这是 host trusted-driver fixture，不是 Linux sandbox、真机、账号或模型结果；Supervisor 的 channel handler 保持 transport-neutral，供 T002 以 supervisor-owned stdio 连接实际 Docker workload。

## 验证记录（实际）

- **额外定向诊断授权（2026-10-26）**：用户明确允许在既有一次诊断之外，再做一轮、最多 20 分钟的定向诊断；此前失败史和次数不重置。本轮窗口从 UTC 04:01:28 至 04:21:28，只增加有界状态记录并运行一次既定 Linux 套件，固定镜像、profile、限额及文件级 I/O 方法均不变。可证伪假设为：通用 I/O 失败来自读尚未完成时的 deadline、读已完成后的进程存活，或非零退出之一；使用已有 stopReason、exitCode、cleanup、ready/read-complete 状态、读耗时与有限 stderr 区分。无明确因果证据则结束该诊断并保留现场；有证据后由主 Agent 确认方案，再修正并重验。诊断不代表资格通过，也不启用后续 Task、真实设备/账号/模型。
- **T002 恢复验收基线（2026-10-26）**：基础提交为 `ef847bf`，T002 为未提交工作树，lifecycle 仍为 in_progress。历史较早草稿在专用 ARM64 Linux VM 上 TAP 2/2，允许调用计数 1，none/deny/伪造主体/重复 key 计数 0；其后源码、镜像与资格探针均有变化，旧通过不能作为当前验收证据。一次通道故障已定位为 Docker create 未启用 stdin，并已修正；另一次资格失败后的有界单次诊断复跑通过但未定位瞬态原因，该诊断 allowance 已使用，保留失败历史，不因恢复、换实现者或新版本重置。后续如再次满足连续两次无验收进展/无新因果证据条件，停止该段并报告，不再追加诊断。
- **T002 最终检查方法**：先核对现有早退事件与 EPIPE 修正，用真实子进程 fixture 验证 early exit、spawn error、stdin error、stop failure 的有限返回和清理；再用最终源码构建固定 Ubuntu 22.04/Node 24.16.0 镜像，Linux broker 与 workload 均在专用 VM 中执行现有 `tests/linux/first-call/`。资格必须覆盖既定最低属性及真实 allow/deny 计数；缺条件即拒绝，不降低隔离。最终证据记录源码摘要、image ID/profile/suite、实际命令与退出结果及清理状态。此处是执行方法，不是通过记录。
- **T002 Linux 资格失败（2026-10-26）**：专用 ARM64 Linux VM 以最终固定镜像 `qdroid-t002:t002-27hko4`（image ID `sha256:79d8dd1cdeda3df15a8c1069dc7bbcce35c354a925c86ce8d8b9a96b73b71e18`）运行 `npm run test:linux`。先修正 Docker 29.2.1 将 `no-new-privileges` 规范化的 inspect 值，并增加 stop 返回非零或成功但 attach 持续运行时的有限返回/`docker rm --force` 回归；本地与 VM 的 15 个契约测试均通过。随后 Linux 资格在 I/O 探针失败：同一固定 profile 的 live cgroup `io.max` 有 `253:16 rbps=1048576 wbps=1048576`，而 `io.stat` 仅有空的 `253:16` 条目，无 `rbytes`。当次没有独立保存 direct-read 的耗时，suite 总时长不能替代该证据；后续静态复核又确认 statistics 采样过早，故不能据此认定 gVisor 的 I/O 归因失效。当前证据不能作为 AC-05 的实际 I/O 限额证据；没有使用 runc、host fallback 或 global drop_caches。资格 fail closed，真实 allow/deny first-call 尚未运行；任务专用 profile/I/O 诊断容器均已强制移除。T002 仍为 in_progress，按上方有效修正方案处理已定位的探针缺陷，保留环境是否满足要求的未决结论。
- **T002 修正批次暂停（2026-10-26）**：本地失败先行测试已覆盖路径缺参拒绝、可读路径正控制、create 非零后已知名称的强制清理，以及 workload 收到响应后的正常退出；修正后的 `format:check`、`lint`、17 个 contract tests 与 `git diff --check` 都退出 `0`。新源码逐文件 SHA-256 manifest（34 个编译、镜像、lock、profile 与测试输入，manifest `a58d31fe385175e5b4c853776546b229e4aa80c99c9b28ecd6375ce72fcfbeab`）已同步到专用 VM 并逐项校验；VM 的 `npm ci` 与 17 个 contract tests 退出 `0`，固定 ARM64 image 构建为 `sha256:c01a46aeb4d8c5f9d4b08bd5ad30dcf00383deb7c275edbc13ef28bd7913f94f`。但最终 `test:linux` 未执行：gVisor `release-20261019.0` 的 gofer open path 不把 guest `O_DIRECT` 传给 host，故 workload 的 `dd iflag=direct` 不能证明 host page cache 已绕过或 `io.stat` 的真实读限速。只增加 read 后等待不能补足该证据；固定 readonly root/私有 tmpfs scratch 也没有已验证的 block-backed 写路径。未使用全局 drop_caches、runc、host fallback、额外挂载或 runtime/profile 语义变更。除非另有明确、有限且目标文件级的真实 I/O 方法，T002 的 AC-05 资格保持 fail closed；原始日志位于 `artifacts/private/t002-20261026/` 和 VM `/tmp/qdroid-t002-20261026.z2Dt4i/artifacts/private/t002-20261026/`。
- **T002 最终修正快照仍未通过（2026-10-26）**：本轮修复合法 `read` 握手在 `close` 同步触发时抢先 rejection 的控制流，给资格合成文件使用 broker 所有、mode `0644` 的非秘密文件以允许固定 guest UID 读取，并使固定 client 校验最终响应的 JSON-RPC version、ID 与 `result`/`error` 形状后才写入 mode-specific confirmation。Linux 测试扩展为 seven scenarios 都需 `completed`、exit `0` 与最终响应确认，allow 还必须没有 error；本地和专用 VM 的 `format:check`、`lint`、`npm test` 均退出 `0`（20 tests）。最终编译/镜像/profile/test 输入逐文件 SHA-256 manifest 为 36 个文件，manifest `8e59b8dbd3d66e9718bd894cd851aa63937eb686de9f39d75c3c6257698c32b8`，专用 VM 清洁快照逐项匹配。固定 ARM64 镜像 ID 为 `sha256:e97991401288b08c8f7fdc307f17a0ccd09903d36e1d2026e646b5e02a7bd9fb`。一次完整 `QDROID_T002_IMAGE=sha256:e979…a7bd9fb npm run test:linux` 实际运行约 31.9 秒后，在 qualification 的 I/O probe 处以 `The fixed-profile I/O probe did not complete successfully.` 失败；所以 first-call seven-scenario assertions 没有执行，不能声称 allow/deny 最终通过。套件失败后未再修改源码、调整 profile/runtime 或重跑；VM 中 `io.qdroid.sandbox` task containers 和 qualification I/O files 都为空，I/O root 仍为 uid 501/gid 1000/mode 700。原始本次合格快照日志位于 VM `/tmp/qdroid-t002-20261026-final-clean.L9xbHx/artifacts/private/t002-20261026/`；此前第一次传输仅因 macOS AppleDouble `._*` 文件和缺少 formatter 输入而在 format check 前失败，原始日志保留在 `/tmp/qdroid-t002-20261026-final.Mt16PE/artifacts/private/t002-20261026/`。这个传输失败未运行 Linux suite。因套件只给出泛化 I/O 错误，且既有诊断 allowance 已使用，未把静态猜测写成环境/运行时因果结论，也未追加诊断或盲目重跑。
- **T002 gVisor guest 子进程观测修正与本轮 Linux 证据（2026-10-26）**：gVisor 的 host `docker top` 只显示 sandbox task，不可作为 guest child 证据；manager 改为固定、非 root 的 `docker exec --user 65532:65532 <task> /usr/local/bin/node /opt/qdroid/probe.mjs process-table`。该 guest `/proc` observer 有 `64` 条目和 JSON 输出上限，显式排除自己的 PID，只有 PID 1 的另一 child 才通过；无 child、非法 JSON 和超限输出均拒绝。契约回归还覆盖 observer-only 不能通过、超过旧 `400ms` 但在原 deadline 内出现的 child、early exit、EPIPE、create/stop failure 与强制 cleanup。逐文件 SHA-256 manifest（36 个编译、镜像、lock、profile 和测试输入）为 `87efcd1952d36e8843af1738dcec988634669e0b8ae3941770a8f3ccd8987ca8`，专用 VM `/tmp/qdroid-t002-20261026-final-clean.L9xbHx` 逐项匹配且无 AppleDouble；本机与 VM 的 format/lint/23 个 contract tests 均退出 `0`。该 VM 从对应源构建 ARM64 immutable image `sha256:71d53d60207d95d2401f7eebe672f271329c91c8a74277bedfc2aee9d2961cc3`。一次完整 `QDROID_T002_IMAGE=sha256:71d53d60207d95d2401f7eebe672f271329c91c8a74277bedfc2aee9d2961cc3 npm run test:linux` 退出 `0`（TAP 2/2）：qualification I/O cgroup read delta `16777216` bytes、elapsed `15970.166718ms`、固定 `1048576` B/s；allow count `1` 且无 error，activeDeny/deny/duplicateKey/forgedAuthority/none/unsupported 各为 `0` 并得到预期 code，seven scenarios 都 completed、exit `0` 且消费最终 response。资格路径通过 root readonly、真实 guest child cleanup/observer、资源/现有负向网络/stdio 断言。suite 后按 `io.qdroid.sandbox` label 的容器和 I/O root 的任务文件均为空。**此 run 后源码复核发现 `SyntheticNetworkTarget.create` 只实际 TCP v4 正控制，UDP/DNS/IPv6 listener 虽 bind/listen 却未逐一收到 broker 控制包；故四协议正控制仍未验证，T002 不能因本条记录接受或请求 done。** 原始日志在 VM `artifacts/private/t002-20261026/{vm-guest-observer-contract-validation.log,linux-image-guest-observer-build.log,linux-suite-guest-observer-final.log,post-guest-observer-final-cleanup.log}`；本机 manifest 在同名 `artifacts/private/t002-20261026/`。此为实现验证证据，不改变 T002 lifecycle/state，也不替代后续独立 review/正式 Validate。
- **T002 合成网络目标逐协议正控制最终证据（2026-10-26）**：前一条记录保留当时只验证 TCP/IPv4 的缺口；按有效修正方案，broker 在 sandbox 负向探针前对现有 TCP/IPv4、UDP/IPv4、DNS UDP、TCP/IPv6 listener 各做一次有界本地控制访问，并仅在对应 listener receipt 都为 true 后清零负向计数。DNS 合成数据报已改为有效的 `qdroid.invalid` wire label encoding；缺任一 receipt 的 contract regression 拒绝，fixture regression 验证 DNS label。新 37 文件 SHA-256 manifest 为 `79c3a23cafa8c428dad4e3f0fc6428cab7fb771081eae2d3d61f164862aab6c6`，同一专用 VM `/tmp/qdroid-t002-20261026-final-clean.L9xbHx` 逐项匹配；本机和 VM format/lint/25 contract tests 均退出 `0`。从该源构建 ARM64 immutable image `sha256:91a138aa70d02bc0cc94b3293cd8f7d76763bcd542ea679f677dd00957125252`。一次完整 `QDROID_T002_IMAGE=sha256:91a138aa70d02bc0cc94b3293cd8f7d76763bcd542ea679f677dd00957125252 npm run test:linux` 退出 `0`（TAP 2/2）：network report 的 `tcpIpv4`、`udpIpv4`、`dnsUdp`、`ipv6Tcp` 都为 true，清零后 sandbox 负向 packet count 为 0；I/O read delta `16777216` bytes、elapsed `15972.180234ms`、限额 `1048576` B/s；allow count 1/no error，其他六种场景 count 0/预期 code，seven scenarios completed/exit 0/final response consumed。suite 后按 `io.qdroid.sandbox` label 的 container 和 qualification I/O root 的任务文件均为空。原始 VM 日志为 `artifacts/private/t002-20261026/{vm-network-controls-contract-validation.log,linux-image-network-controls-build.log,linux-suite-network-controls-final.log,post-network-controls-final-cleanup.log}`，source manifest 同名目录。此条替代前一条的网络未验证结论；T002 lifecycle/state 仍由主 Agent 及后续独立 review/CLI 集成决定。
- **T002 TCP 正控制超时取消最终证据（2026-10-26）**：最终独立复核定位到 manager 自有 TCP 正控制连接在 500ms deadline 或连接错误后仅 `end()`，不能取消未完成的 SYN。失败先行的本机 `lint` 以缺少 `connectTcp` export 退出 `1`；实现后可控未连接 socket contract 证明 deadline 调用 `destroy()` 而不调用 `end()`，成功连接仍只 `end()`，且 cleanup 自身抛错不会遮蔽原始 deadline error。本机 `format`、`format:check`、`lint`、`npm test`（28 contract tests）和 `git diff --check` 均退出 `0`。新的 37 文件 SHA-256 manifest 为 `499cec3f8dc20db1bb68d85be2e8408de39fae70e80de1ddb530217bb1f7a76b`；同一专用 VM `/tmp/qdroid-t002-20261026-final-clean.L9xbHx` 逐项匹配。VM 首次 formatter 只因早期同步遗留的 38 个 macOS `._*` metadata 副本失败，原始 log 保留；删除这些非清单、非源码副本后，VM `format:check`、`lint`、`npm test`（28 tests）退出 `0`。fixture/image 输入未变，故复用 immutable ARM64 image `sha256:91a138aa70d02bc0cc94b3293cd8f7d76763bcd542ea679f677dd00957125252`，一次完整 `QDROID_T002_IMAGE=sha256:91a138aa70d02bc0cc94b3293cd8f7d76763bcd542ea679f677dd00957125252 npm run test:linux` 退出 `0`（TAP 2/2）：I/O read delta `16777216` bytes、elapsed `15957.337871ms`、limit `1048576 B/s`；四项 network control receipt 都为 true、清零后负向计数为 0；allow count 1/no error，其余六场景 count 0/预期 code，seven scenarios completed/exit 0/final response consumed。suite 后 label `io.qdroid.sandbox` containers 和 qualification I/O root 任务文件均为空。原始 VM 日志为 `artifacts/private/t002-20261026/{vm-tcp-cancellation-contract-validation.log,vm-tcp-cancellation-contract-validation-after-appledouble-cleanup.log,linux-suite-tcp-cancellation-final.log,post-tcp-cancellation-final-cleanup.log}`，本机 manifest/同步 log 在同名目录。TCP 失败分支修正不改 fixture image 或正常 CLI 路径；主 Agent 已有同 image 的 CLI 证据可重用，最终独立 reviewer 复核此差异确认原 P2 已解决且无新增可操作项。T002 lifecycle/state 仍由主 Agent 决定。
- **T001（主 Agent 已接受）环境**：本地 macOS arm64 host，Node `v24.16.0` / npm `11.13.0`。这不是 Linux sandbox qualification、Docker/gVisor result、T1 evidence、账号 connector 或模型 API evidence。T002 必须在其专用 Linux 环境独立复跑协议路径并验证隔离。
- **工具与依赖**：`export PATH="/opt/homebrew/Cellar/node@24/24.16.0/bin:$PATH"; node --version; npm --version; node -e "const { DatabaseSync } = require('node:sqlite'); /* create, insert, select */"; npm install --ignore-scripts --no-audit --no-fund` 退出 `0`，输出 `v24.16.0`、`11.13.0` 和 `node24-sqlite-ok`；无 package scripts 在安装时执行。`npm run check:runtime` 在默认 Node `v25.9.0` 下按预期退出 `1`，拒绝版本漂移；build/lint/test/demo 都调用该检查。
- **TDD / 行为**：初始实现前 `PATH="/opt/homebrew/Cellar/node@24/24.16.0/bin:$PATH" npm test` 退出 `1`，原因是预先写入的 contract test 引用尚未实现的 trusted fixture driver。实现后首次 `npm test` 退出 `0`，覆盖允许只读调用、none/deny、伪造身份字段、跨 instance binding、无效 schema/version/required feature 及零次 simulator side effect；成功路径还重开 SQLite 验证 scope 内的 sanitized audit 持久化。2026-10-23 的复核反馈新增失败先行测试，`npm test` 先因 `applyTrustedGrant`、provider injection 和 unknown error data 尚未实现而退出 `1`；修正后同命令退出 `0`，共 8 个 tests，新增覆盖两种 grant 交错顺序均为 deny、provider 在 admission 后抛错、result journal 失败后 unknown/audit/task 关联，以及 admission 持久化失败时 provider 操作计数为 0。
- **静态与格式检查**：`npm run format`、`npm run format:check`、`npm run lint` 和 `git diff --check` 均退出 `0`。Prettier 范围只包含 T001 新增的 workspace 配置、源码、测试、fixture 与 usage 文档，未格式化 product/state 或既有规范。
- **CLI 实测**：`npm run demo -- --fixture allow` 退出 `0`，返回 read-only SIM 结果、`simulatorOperationCount: 1` 和 admitted/succeeded audit correlation；`npm run demo -- --fixture deny` 退出 `0`，返回 `QD_PERMISSION_DENIED` 和 `simulatorOperationCount: 0`；`npm run demo -- --fixture unknown` 退出 `1` 并显示用法。完整参数、范围和 failure feedback 在 `docs/USAGE.md`。
- **T001 覆盖与当时缺口（历史）**：T001 仅覆盖 AC-01/02/11 的 host-driver 基础子场景，未标记任何产品 AC 通过。Linux profile/限定运行时、真实 stdio workload、host canary/network/resource/child cleanup、并发/revoke/cancel/crash recovery、安装、真机和外部账号均未覆盖。
- **仓库基础检查（历史）**：2026-10-23 主 Agent 的 `python3` 文档/JSON/lifecycle映射检查退出0：24个公开文件、3个JSON示例、本地链接、20项AC与12项Issue映射通过；未发现检查规则覆盖的私人路径/凭据标记。当时 Feature 为planned、Task为todo；当前进度以 `state.json` 为准。这是文档检查，不是运行安全测试。

- **T002 主 Agent CLI 集成（2026-10-26）**：在同一专用 Linux VM 先对最终 `source-manifest-network-controls.sha256` 的 37 个输入执行 `sha256sum -c`，再实际运行 `npm run linux:demo -- --image sha256:91a138aa70d02bc0cc94b3293cd8f7d76763bcd542ea679f677dd00957125252`，退出 0。主 Agent 独立读取并解析 CLI JSON：四项网络正控制均 true、负向送达 0；I/O 真实读增量 16777216 bytes / 16024.256527 ms / 1048576 B/s；guest observer 明确排除自身 PID 15，并观察到 PID 1 的另一 child PID 8，随后停止/移除确认。allow count=1 且无 error；其余六场景 count=0、分别得到 permission/validation/unsupported 预期 code，全部 completed/exit 0/最终 response 已消费。suite 的两项测试与 25 项 VM contract checks 原始日志均已核对，fail/skipped 均为 0；任务 label 容器列表与合成 I/O 目录均为空。最终 manifest 37 个本地输入 SHA-256 全部匹配；私有原始 suite、contract、CLI stdout/stderr、manifest 与 cleanup 日志在 `artifacts/private/t002-20261026/`，不发布进 Git。公开操作步骤补充到唯一 `docs/USAGE.md`。此为 T002 集成证据；其他 Task 和正式 Feature Validate/Review/Release 不因此完成。

- **T002 主 Agent 最终接受（2026-10-26）**：最终 37 输入 manifest `499cec3f8dc20db1bb68d85be2e8408de39fae70e80de1ddb530217bb1f7a76b` 已与本地/VM 及独立复核的源码逐项匹配；原始 VM contract 28/28、Linux 2/2、四协议 receipts/负向计数、七场景 side effect counts 与清理日志已实际读取核对。最终 Linux I/O 为 16777216 bytes / 15957.337871 ms / 1048576 B/s。此前主 Agent CLI 使用相同 image、fixture、profile 与正常控制路径；其后只改 TCP 失败取消及其 tests，独立 reviewer 确认正常连接行为不变，故保留对应 CLI 证据而不重复同一演示。接受 T002 固定 ARM64 simulator 最低 profile；T003—T012、T004 完整资格矩阵、T1、账号和模型仍未完成。提交保存相同运行输入，前后仅交付文档和 lifecycle 状态收尾不影响这些运行证据。

## 评审记录（实际）

- **T002 最终独立差异复核（2026-10-26）**：恢复差异快照（63 文件，manifest `aaca743119da2d0da323b5e94751a050fb3289229d79f5b0f51514fe3f1dbf43`）复核 I/O 输入释放/有限诊断、EROFS 写入控制及 guest 进程观察器，未发现 P1/P2 或权限/可读性阻塞。网络差异快照（64 文件，`e336a2b7d570df7784852ff284ff80c31ed1c7957ed3653c60e8061e4a5282da`）确认逐协议正控制与 reset 正确，另发现 TCP timeout 只 end 未取消 pending socket 的 P2；同一实现者修正并补回归。最终 TCP 修正快照（64 文件，`ed6d5bfe22ef07051aa1e4a0c8c2d80d5ace80ad1bd1d072eef1ce77d29dc62a`）独立复核确认原 P2 已解决、无新增可操作发现。最终 runtime 源 SHA-256 `7d145ae0fd330f3a6c51253ab6ac02a071582de15b9154406eb91e4bf5f0043f` 与 network test `345ff6cf339c7118d8c30249b19caf02d403e3d2bdefe66c30a83c56cae8fbf2` 均匹配最终测试 manifest；connector 注入仅为可信模块测试接口，不是 workload API。独立 review 全程只读，没有运行测试/VM/Git 或改 state。非阻塞 P3：held-stdin 测试可补自身 close 等待期限，避免未来回归时挂住；当前运行与产品隔离证据不受此测试健壮性建议影响。主 Agent 已合并实际 Linux/CLI 证据接受本 Task；正式 Feature Validate/Review/Release 保持 pending。

- **T002 独立源码复核与主 Agent 证据核对（2026-10-26）**：最终固定快照共 63 文件，review manifest `0613083faffbd4729e6371c38ea1e18f44c32daa8ac64521c96d3371a5ccb68c`，独立 reviewer 逐项匹配；只读复核确认路径漏参、canary 判定、socket 连接检查、create 失败清理、I/O 采样和正常 fixture 最终响应确认均已在源码层修正，未发现新的权限边界阻塞。仍有 P3：I/O 通用错误丢弃已有的 stopReason、exitCode 和有限 stderr；这不是当前失败的因果定位，不能据此盲改重跑。主 Agent 核对了失败原始日志、20 项契约测试日志和清理日志，并实际计算 36 个输入 SHA-256 全部匹配 manifest `8e59b8db…c32b8`。资格仍失败、first-call 未运行，T002 不接受、不请求 done，未提交推送；Feature 正式 Validate/Review/Release 均不因此通过。相关私有日志已留存在本地 `artifacts/private/t002-20261026/`，等待明确下一步诊断方向。
- **状态**：2026-10-23 已完成独立设计复审与主 Agent 接受；Feature 的正式实现 Review 仍为 pending。T001 的独立代码 reviewer 两次因模型容量不可用，未执行代码评审；主 Agent 已完成串行只读代码检查与集成验收，不能标为独立代码评审。
- **T001 实现验收**：主 Agent 实际定位并复现 active deny 被较新 allow 覆盖、provider 失败被误记为输入错误两项问题；同一实现者修正并增加行为/持久化故障测试。最终 format:check、lint、npm test（8/8）和 git diff --check 通过，范围为当前 T001 工作树；后续 commit 保存该实现。
- **范围、发现与处理**：初次风险分析发现预算原子扣减、安装条件回滚、取消与 dispatch 竞争三项 P2 设计缺口，均已写入规范和 T003/T006 验收。后续独立复审覆盖架构、五份规范、产品、工程计划与导航，共九份文档，未发现阻止作为实现输入的剩余 P1/P2。该结论仅为文档一致性；未来 Review 仍须只读已验证 commit，核对真实行为与证据。

## 发布与观察记录（实际）

- **产品观察计划引用**：[产品上下文发布后观察计划](REQ-MVP-001.product.md#发布后观察计划sdlc-补充)，产品指标/窗口/负责人不在此重复。
- **技术发布准备、实际结果、反馈证据与缺口**：产品发布尚未执行。未来逐版本记录合格host/profile、包/服务/设备兼容、最小权限配置、备份/回退与smoke。包回滚不撤回副作用/复权；数据库保留对账历史；设备仅恢复已验证安全显示/模式。
- GitHub [Foundation #1](https://github.com/arnow117/qdroid/issues/1) 与 [MVP epic #2](https://github.com/arnow117/qdroid/issues/2) 是协作入口；milestone不是阶段通过证据。运行时版本仅在全部适用验收、正式验证/评审及发布授权满足后发布。
