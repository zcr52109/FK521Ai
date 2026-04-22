# FK521AI 安全与兼容修复计划（分阶段）

> 目标：在**不改数据库 schema / 不迁移历史数据 / 不打乱目录结构**前提下，完成高风险链路切断、功能闭环与兼容治理。

## Phase 0：建图与测试锚点

- 梳理核心调用链：
  - 前端请求 -> data-provider -> API routes -> controller -> service -> data-schemas methods。
  - 工具链路重点：`tools controller -> sandbox authorization -> uploads -> docker sandbox`。
- 明确高危点和阶段归属（见下方“风险分配”）。
- 增加最小 smoke test 入口，确保后续阶段可持续回归。

## 风险分配（概要）

### Phase 1（授权与跨会话）

- S1 execute_code 授权放行。
- S2 默认 capability 过宽（默认含 execute_code）。
- S4 messageId / conversationId 绑定不闭合。
- S5 conversation files / file lookup 归属校验不足。

### Phase 2（工具暴露面）

- S3 ToolService 自动追加 workspace tools。
- S6 PTC caller 白名单默认放开。
- S7 allowProgrammaticToolBridge 未真正执法。

### Phase 3（宿主执行与边界）

- S8 bridge 宿主暴露。
- S9/S10/S11 run_unit_tests 宿主执行面与 env 泄露。
- S12 symlink 越界。
- S13 process_list 缩权。
- S14 host-side 网络工具缩权。

### Phase 4（下载与密钥）

- S15 下载 token 二次校验与 secret 强制。
- S16 runtimeContract secret 默认值移除。

### Phase 5（默认口令/日志/API 密钥）

- S17 默认管理员弱口令。
- S18 项目 API 密钥回显治理。
- S19 日志脱敏统一。
- S20 cookie sameSite 会话边界。

### Phase 6（功能闭环）

- F1-F20 表单状态 -> payload -> 保存 -> 回显全链路核对与修复。

### Phase 7（兼容 helper 收口）

- C1-C5 统一 helper 收口，移除散点调用。

### Phase 8（攻击验证与回归）

- A1-A6 攻击验证用例。
- R1-R4 回归验证用例。

## 验收标准

- 高危链路 fail-closed。
- 关键功能链路仍可运行。
- 每阶段均有测试证据与剩余风险说明。
