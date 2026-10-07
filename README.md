# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例

## 运行

```bash
npm install
npm run build
npm run smoke
npm test
```

批量分装（`AliquotService.createMany`）在单个 Store 事务内原子提交：全部校验（条码冲突、容量、单位、隔离状态、归属范围）通过后才一次性写入子样、扣减父容器容量和操作记录；失败整体回滚，不残留子样也不扣量。重复操作以 `tenantId|projectId|operationId` 为幂等键：相同请求（0.25 L 与 250 mL 视为同一请求）返回既有结果，同 operationId 提交不同内容返回 `aliquot.operation_replay_conflict`，旧版非原子实现遗留的半成品返回 `aliquot.operation_recovery_required`。并发分装由可重入互斥锁串行化。

当前源码是**干净基线**，没有为了出题主动埋入 Bug。后续应先在这份基线上补充测试和复现证据，再从真实缺陷中生成 Bug 题目。
