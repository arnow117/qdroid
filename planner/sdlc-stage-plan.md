# qdroid MVP 执行导航

日期：2026-10-23。当前交付为设计、规划与仓库tracking；没有实现整个MVP，也没有Linux资格、设备/账号/模型API运行结果。

唯一当前有效方案、任务详细边界与验收位于 [FEAT-MVP-001工程上下文](../.sdlc-v1/context/FEAT-MVP-001.engineering.md)，产品意图位于 [REQ-MVP-001](../.sdlc-v1/context/REQ-MVP-001.product.md)。本文件只作导航；执行进度唯一来自 `.sdlc-v1/state.json`，GitHub Issues供协作，不复制状态。

协作入口：[仓库](https://github.com/arnow117/qdroid)、[Foundation #1](https://github.com/arnow117/qdroid/issues/1)、[MVP epic #2](https://github.com/arnow117/qdroid/issues/2)。任务已由主Agent登记并关联下表Issues；所有运行任务当前均未实施，状态查询lifecycle。

| Task | 增量 | 依赖 IDs | GitHub milestone | Issue |
|---|---|---|---|---|
| T001 | 最小契约、受监督身份与只读模拟器 | 无 | [M0](https://github.com/arnow117/qdroid/milestone/1)  [#3](https://github.com/arnow117/qdroid/issues/3) |
| T002 | Linux 最低隔离与允许/拒绝真实闭环 | T001 | [M0](https://github.com/arnow117/qdroid/milestone/1)  [#4](https://github.com/arnow117/qdroid/issues/4) |
| T003 | 原子 admission、取消与未知结果恢复 | T002 | [M0](https://github.com/arnow117/qdroid/milestone/1)  [#5](https://github.com/arnow117/qdroid/issues/5) |
| T004 | 完整 SandboxBackend 与隔离资格 | T003 | [M0](https://github.com/arnow117/qdroid/milestone/1)  [#6](https://github.com/arnow117/qdroid/issues/6) |
| T005 | 固定包、安全解包与无凭据构建安装 | T004 | [M1](https://github.com/arnow117/qdroid/milestone/2)  [#7](https://github.com/arnow117/qdroid/issues/7) |
| T006 | 条件激活、升级回滚与移除 | T005 | [M1](https://github.com/arnow117/qdroid/milestone/2)  [#8](https://github.com/arnow117/qdroid/issues/8) |
| T007 | 受限 AgentBackend 与本地 MCP 生命周期 | T006 | [M1](https://github.com/arnow117/qdroid/milestone/2)  [#9](https://github.com/arnow117/qdroid/issues/9) |
| T008 | Artifact、Scene 与受限视频呈现闭环 | T006 | [M2](https://github.com/arnow117/qdroid/milestone/3)  [#10](https://github.com/arnow117/qdroid/issues/10) |
| T009 | ConnectorBroker 与只读 Mock 业务闭环 | T007 | [M2](https://github.com/arnow117/qdroid/milestone/3)  [#11](https://github.com/arnow117/qdroid/issues/11) |
| T010 | T1 设备基线与受信适配器探测 | T001 | [M3](https://github.com/arnow117/qdroid/milestone/4)  [#12](https://github.com/arnow117/qdroid/issues/12) |
| T011 | T1 媒体导入、串行播放与本地恢复 | T008、T010 | [M3](https://github.com/arnow117/qdroid/milestone/4)  [#13](https://github.com/arnow117/qdroid/issues/13) |
| T012 | T1 语音触摸交互与资源预算集成 | T007、T009、T011 | [M3](https://github.com/arnow117/qdroid/milestone/4)  [#14](https://github.com/arnow117/qdroid/issues/14) |

最早真实结果点名为 **T001 + T002**：先证实所需最低Linux隔离profile，再让固定fixture plugin通过受监督身份调用SIM只读能力成功，同时拒绝一个未授予/伪造主体调用。核对SIM操作计数与审计；不等待包安装、pi、完整资格矩阵、显示或设备。后续T003/T004补预算/取消/崩溃竞争与完整隔离资格，不把首演示当全部AC已通过。

M0至M3是协作里程碑，不强制所有任务按组串行。T010可在T001后且设备到货、只读访问获授权时提前调查；它不阻塞Linux闭环。实际并行仍需主Agent确认接口、写范围、独立验收和隔离环境，不能从表格自行推导。

本轮不进入Build。后续从T001开始时另选实施授权与受控环境；实际依赖安装、模型、账号、设备部署/控制按对应任务前置处理。T1固定位置，不开放移动；Mock connector不证明真实Lark/官方CLI支持，未授权未测不声明兼容。

验证、评审、发布与产品观察记录引用工程上下文对应章节。缺环境、失败或未测项保留原事实；文档与Issue创建不等于运行任务完成。
