# 恢复检查点：FEAT-MVP-001

## 定位

- Feature：FEAT-MVP-001；Requirement：REQ-MVP-001；当前 Task：T005，in_progress。
- 接续分支：`codex/t005-wip-20261030`；此文件随 WIP 快照提交，具体 commit 用 `git log -1` 核对。
- 已验收基线 HEAD：`a3973e56d442e75361946eb26fc2e3b8b494882b`；workspace 为当前 clone 的实际 Git 根目录。
- 本次用户仅授权未验收进度备份并推送；远端默认 `codex/project-foundation` 保持已验收版本。

## 已确认

- T001–T004 已接受；T005 未完成，T006–T009 仍 todo；T006/T008 文件仅为规划草稿。
- Graph package-runtime 单元在 host/Mock 范围接受：冻结输入格式/类型/构建通过，214 pass、0 fail、16 Linux skip；不是当前整树或生产 Graph 验收。
- v125b 两项共享命令终结回归：固定 Node24.16/npm11.13，实际 Linux2/2、独立增量评审无 P1/P2；真实 guardian＋受控假 Docker，不是完整 daemon 恢复。
- 上述历史冻结输入、命令、hash 和证据适用范围在工程上下文；原始私有产物不随 clone 提供。
- 私有产物、运行数据、依赖目录和编译输出均未纳入此次代码备份；旧 Agent 已停止，不能沿用旧进程或对象句柄。

## 未完成

- managed network dependent-probe 生命周期仍未实现：configure → keeper durable ack → ResourceOps journal binding → 单次 create 授权 → 原 execution/terminal/group proof → release；当前明确拒绝执行。
- 网络实现连续两次返回没有源码改动或新因果证据，已按根 AGENTS/stage protocol 停止；所有诊断额度已用，不得因新会话/分支/实现者重置。
- 网络六项残余评审/fault matrix 待收敛；v121 只为 cached-read/dispose 提供候选修正证据。完整 boundary held/create/inspect/SIGKILL/IPC 矩阵仍未完成。
- provider-root/legacy fixture 原持有者恢复、managed T004 handoff、实际 OCI graph copy/commit/verify、有限镜像/存储控制仍需完整实现和验收。
- 一套统一当前源码的 host/Linux 安装、取消、崩溃恢复、双进程串行、共享镜像/Graph、unknown 负例、USE-003 CLI 和整 Task 独立评审均未完成。
- 原专用 Linux 环境、镜像和私有运行证据不会由 clone 重建；缺少证据或环境变化时必须重新取得相应证据，不能引用组件通过代替整体验收。

## 下一步

- 先核对 branch/HEAD、state 与工程上下文；读取本 clone 及父目录适用的 AGENTS 和需要的 SDLC skill。Node24.16.x/npm11.13.x 为已选版本。
- 源码准备使用 `npm ci --ignore-scripts --no-audit --no-fund`；此命令不构造 VM、gVisor、镜像或安全资格。
- 原网络段保持停止；继续该段前由主 Agent 取得明确执行方向并安排新的 Terra 实现上下文，保留全部历史、失败证据和用完的额度。保存 WIP 的授权不是额外诊断授权。
- 原 T004–T009 本地/simulator/Mock/专用 VM 实施授权保留；真实机器人、真实账号/模型、付费远程资源及正式发布仍需对应授权。
- 主 Agent先确定边界再派实现；reviewer 只读。第三方工作负载不获宿主执行、Docker socket、设备/账号凭据；unknown 不重放；不放宽沙箱，不清理未知资源。
- provider-root keeper 或新增 fresh cleanup authority 先提交原所有权与证明组合设计，由主 Agent 定案。生产 `supportsGraphMaterialV1` 保持未声明直到实际全路径完成。

## 必要引用

- [state](../state.json)、[产品上下文](../context/REQ-MVP-001.product.md)、[工程上下文](../context/FEAT-MVP-001.engineering.md)。
- [当前 T005 方案](../../planner/t005-build-serialization.md)、[boundary](../../planner/t005-boundary-control.md)、[network](../../planner/t005-network-controls.md)、[Graph](../../planner/t005-executable-graph-unit.md)。
- [usage](../../docs/USAGE.md)、[安全边界](../../docs/specs/sandbox-permissions.md)、[tracking](../../docs/TRACKING.md)、[公开最新记录](https://github.com/arnow117/qdroid/issues/7#issuecomment-6489220633)。
