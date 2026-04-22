# FK521AI：一次性整段复制给 Codex 的主提示词（超详细版）

你现在不是在做“泛化修 bug”，你是在对 **FK521AI** 这个现有仓库做 **高风险隔离系统修复 + 前后端功能/兼容性治理 + 可验证交付**。

## 0. 你的角色与目标

你的角色是：
- **仓库结构分析师**：先读清楚当前目录、调用链、数据结构，再动手。
- **安全修复工程师**：先切断高危利用链，再做增强。
- **兼容性治理工程师**：把分散的浏览器兼容写法统一收口。
- **测试工程师**：每改一类问题，就补对应测试；最后要写攻击验证与回归验证。
- **交付工程师**：输出清晰的阶段成果、改动文件、风险关闭情况、剩余风险。

你的总目标不是“尽量修”，而是：
1. **保留现有源码结构**。
2. **不改数据库结构，不做 migration，不改历史数据**。
3. **先修隔离系统重大漏洞，再修功能/兼容/静默失败问题**。
4. **每一步都要可验证、可回滚、可验收**。
5. **最终必须给出攻击验证、自测结果、回归结果**。

---

## 1. 绝对不可违反的约束

### 1.1 结构约束
- 不允许大规模重构目录。
- 不允许把现有模块平铺重写。
- 不允许把后端服务拆成全新框架。
- 不允许把前端组件体系整体替换。
- 允许：
  - 在现有目录下新增少量 helper / test / spec / adapter 文件；
  - 在现有模块内部做 fail-closed 收敛；
  - 在现有 utils 里统一兼容封装；
  - 在现有 test 目录补测试。

### 1.2 数据约束
- **严禁修改 Mongo schema 结构**。
- **严禁新增迁移任务**。
- **严禁改历史数据格式**。
- **严禁要求用户清库**。
- 只能通过：
  - 路由校验；
  - controller/service 权限绑定；
  - helper 封装；
  - 运行时校验；
  - 默认配置收紧；
  - 测试补强；
  来修复问题。

### 1.3 交付约束
- 不要一次性改全仓库。
- 必须按阶段执行。
- 每阶段结束都要输出：
  - 改动文件清单；
  - 改动目的；
  - 新增/修改测试；
  - 已关闭风险；
  - 剩余风险；
  - 是否达到该阶段完成标准。

### 1.4 安全约束
- 若某功能当前无法在短期内安全保留：
  - **优先 fail-closed 禁用**；
  - 不允许“先保留危险实现，后面再看”。
- 不允许新增默认弱口令。
- 不允许新增硬编码 secret。
- 不允许为了“兼容旧逻辑”保留高危 bypass。

---

## 2. 先理解仓库：当前真实目录结构（必须按此结构工作）

### 2.1 顶层目录
```text
FK521AI/
  api/                         # Node/Express 后端
  client/                      # 主前端应用
  packages/                    # monorepo 内共享包
    agents/
    api/
    client/
    data-provider/
    data-schemas/
  config/                      # 管理脚本 / 运维脚本 / 部分迁移脚本
  e2e/                         # Playwright E2E
  runtime/admin/               # 运行时管理配置
  tests/                       # 顶层测试
  scripts/                     # 仓库校验与构建辅助
  uploads/                     # 文件上传目录
  docker-compose.yml
  docker-compose.security.override.yml
  fk521ai.yaml
  package.json
```

### 2.2 后端核心目录
```text
api/
  db/                          # 连接 DB / 索引同步
  models/                      # 启动时 seed / 角色等
  server/
    index.js                   # 后端入口
    routes/                    # 路由层
    controllers/               # 控制器层
    services/                  # 业务服务层
    middleware/                # 权限 / 校验 / 通用中间件
    utils/                     # 配置 / 加密 / project api 等工具
  app/
    clients/tools/util/        # 工具桥接、workspace tools、sandbox tools
```

### 2.3 前端核心目录
```text
client/src/
  components/                  # 业务组件
  hooks/                       # UI hooks / 数据与状态协调
  routes/                      # 页面入口
  store/                       # recoil / jotai 等状态
  utils/                       # 浏览器兼容 helper、滚动、剪贴板、textarea 等
  Providers/                   # React Context 提供层
  data-provider/               # 面向 UI 的查询/变更封装
```

### 2.4 共享包核心目录
```text
packages/data-schemas/src/
  schema/                      # Mongoose schema 定义
  models/                      # model 创建器
  methods/                     # DB 访问方法封装
  types/                       # TS 类型

packages/data-provider/src/
  config.ts                    # endpoint/capability/default config
  createPayload.ts             # payload 构造
  messages.ts                  # 消息/会话相关请求
  models.ts / types.ts         # 前端共享类型

packages/api/src/
  后端通用逻辑 / 环境与 API 适配层
```

---

## 3. 当前系统主调用链（你必须先按这个理解，不要盲改）

### 3.1 前端到后端主链路
```text
client/src components/hooks
  -> client/src/data-provider
  -> packages/data-provider
  -> /api/... 路由
  -> api/server/routes/*
  -> api/server/controllers/*
  -> api/server/services/*
  -> packages/data-schemas/src/methods/*
  -> MongoDB
```

### 3.2 隔离 / 工具 / 代码执行主链路
```text
前端 agent/assistant/tool 配置
  -> packages/data-provider/src/config.ts （默认 capability / endpoint config）
  -> api/server/services/ToolService.js （工具定义收集、注入、能力拼装）
  -> api/server/controllers/tools.js （调用入口）
  -> api/server/services/Sandbox/authorization.js （sandbox 动作授权）
  -> api/server/services/Sandbox/uploads.js （会话文件同步）
  -> api/app/clients/tools/util/localSandboxTools.js （本地 docker sandbox / PTC 桥接）
  -> api/app/clients/tools/util/workspaceTools.js （workspace tools 对外暴露）
  -> api/server/services/Sandbox/* （dockerExecutor / processList / runtimeContract / bridgeServer / workspaceFs / advancedWorkspaceTools）
```

### 3.3 文件下载链路
```text
/api/downloads/dl
  -> api/server/index.js
  -> api/server/services/DownloadLinks/index.js
  -> verifySignedToken
  -> streamSignedDownload
  -> file/sandbox kind 解析
  -> 文件流返回
```

---

## 4. 当前数据库/数据结构（只能理解和利用，不能改 schema）

以下是必须理解的几个核心集合关系。

### 4.1 Conversation
文件：`packages/data-schemas/src/schema/convo.ts`

关键字段：
- `conversationId: string`
- `user: string`
- `messages: ObjectId[]`
- `files: string[]`  （这里存 file_id）
- `tenantId: string`
- `agent_id: string`
- `tags: string[]`

关键索引：
- `{ conversationId, user, tenantId } unique`

### 4.2 Message
文件：`packages/data-schemas/src/schema/message.ts`

关键字段：
- `messageId: string`
- `conversationId: string`
- `user: string`
- `files: mixed[]`
- `attachments: mixed[]`
- `content: mixed[]`
- `tenantId: string`

关键索引：
- `{ messageId, user, tenantId } unique`

### 4.3 File
文件：`packages/data-schemas/src/schema/file.ts`

关键字段：
- `user: ObjectId`
- `conversationId: string`
- `messageId: string`
- `file_id: string`
- `filename: string`
- `filepath: string`
- `source: string`
- `context: string`
- `tenantId: string`

关键含义：
- `Conversation.files` 里挂的是 `file_id`
- `File.file_id` 才能解析到真正文件记录
- 文件归属必须同时考虑：`user / conversationId / tenantId / messageId`

### 4.4 与本次任务强相关但不能改 schema 的其他集合
- `agent`
- `assistant`
- `action`
- `toolCall`
- `accessRole`
- `aclEntry`
- `systemGrant`
- `config`
- `session`
- `token`
- `sharedLink`

要求：
- 不新增字段；
- 不改字段类型；
- 不改索引；
- 所有修复都从访问控制、校验和运行时约束做。

---

## 5. 你必须优先掌握的关键文件与职责（按优先级）

### 5.1 后端入口与路由
1. `api/server/index.js`
   - 服务启动
   - 公共路由挂载
   - `/api/downloads/dl` 公开下载入口
2. `api/server/routes/index.js`
   - 总路由映射
3. `api/server/routes/files/files.js`
   - 文件相关路由、sandbox capabilities 相关入口
4. `api/server/routes/agents/*`
   - agents chat/tools/openai/v1 路径
5. `api/server/routes/assistants/*`
   - assistants chat/tools/v1/v2 路径

### 5.2 工具/隔离执行主链
1. `api/server/controllers/tools.js`
   - 工具调用入口
   - `messageId`、`conversationId` 绑定问题重点
2. `api/server/services/ToolService.js`
   - workspace tools 自动追加
   - PTC 工具创建
   - capability 注入
3. `api/server/services/Sandbox/authorization.js`
   - `execute_code` 是否真的受控
4. `api/server/services/Sandbox/uploads.js`
   - conversation files -> sandbox uploads
5. `api/app/clients/tools/util/localSandboxTools.js`
   - PTC 白名单逻辑
   - host-gateway / bridge 网络
6. `api/app/clients/tools/util/workspaceTools.js`
   - 暴露给 agent 的 workspace 工具全集
7. `api/server/services/Sandbox/advancedWorkspaceTools.js`
   - `run_unit_tests`
   - PDF/DOCX/grep/search/binary/network 类 host-side 工具
8. `api/server/services/Sandbox/workspaceFs.js`
   - 工作区文件系统边界
9. `api/server/services/Sandbox/processList.js`
   - 进程可见性问题
10. `api/server/services/Sandbox/runtimeContract.js`
   - capability manifest / secret
11. `api/server/services/Sandbox/bridgeServer.js`
   - PTC bridge 绑定宿主问题
12. `api/server/services/DownloadLinks/index.js`
   - 签名下载与 owner/conversation 二次校验

### 5.3 配置与默认能力
1. `packages/data-provider/src/config.ts`
   - `defaultAgentCapabilities`
   - agents endpoint capability 默认值
2. `api/server/utils/difyConsoleConfig.js`
   - 本地 code executor / programmatic bridge 默认配置
3. `runtime/admin/project-apis.json`
   - 项目级 API 配置
4. `api/server/utils/projectApiConfig.js`
   - 项目 API 读写、加密、masked 返回
5. `api/models/index.js`
   - 默认管理员种子逻辑

### 5.4 前端兼容性与体验收口点
1. `client/src/utils/clipboard.ts`
2. `client/src/utils/structuredClone.ts`
3. `client/src/utils/resizeObserver.ts`
4. `client/src/utils/scroll.ts`
5. `client/src/utils/textarea.ts`

这些文件已经是“兼容 helper 雏形”，你要做的不是再散着改，而是：
- **统一收口**；
- **消灭绕过 helper 的直接调用**；
- **补测试**。

### 5.5 直接绕过兼容 helper 的重点位置
- `client/src/components/Chat/Messages/Content/Parts/Thinking.tsx`
- `packages/client/src/components/SecretInput.tsx`
- `client/src/hooks/useInfiniteScroll.ts`
- `client/src/hooks/Plugins/usePluginDialogHelpers.ts`
- `client/src/components/Messages/Content/Mermaid/useSvgProcessing.ts`
- `client/src/components/Chat/Messages/Content/Parts/OpenAIImageGen/OpenAIImageGen.tsx`
- `packages/client/src/components/DataTable/DataTable.tsx`
- `packages/client/src/components/DataTable/DataTable.hooks.ts`
- `packages/client/src/components/PixelCard.tsx`

要求：把这些直接调用统一迁移到 helper。

---

## 6. 你必须处理的安全问题（按利用链优先级）

> 这部分不是让你“看看”，而是必须按阶段修完并补测试。

### S1. execute_code 授权直接放行
重点文件：
- `api/server/services/Sandbox/authorization.js`
- `api/server/controllers/tools.js`
- `api/server/services/Sandbox/authorization.spec.js`

目标：
- `execute_code` 必须真正受 `RUN_CODE` / capability 控制。
- 默认拒绝，明确授权才放行。

### S2. defaultAgentCapabilities 默认包含 execute_code
重点文件：
- `packages/data-provider/src/config.ts`

目标：
- 默认 capability 改成安全最小集。
- 高危能力必须显式开启。

### S3. ToolService 自动把 workspace tools 全量追加
重点文件：
- `api/server/services/ToolService.js`

目标：
- 不再因为普通 tools 开启而自动追加整套 workspace tools。
- workspace 工具要按能力、按 endpoint、按授权显式暴露。

### S4. messageId 校验和 conversationId 使用脱钩
重点文件：
- `api/server/controllers/tools.js`
- `packages/data-schemas/src/methods/conversation.ts`
- `api/server/services/Sandbox/uploads.js`

目标：
- `messageId -> conversationId -> user/tenant` 绑定必须闭合。
- 不允许请求体自带任意 conversationId 越权驱动 sandbox 文件同步。

### S5. conversation files / file lookup 缺 owner 约束
重点文件：
- `packages/data-schemas/src/methods/conversation.ts`
- `packages/data-schemas/src/methods/file.ts`
- `api/server/services/Sandbox/uploads.js`

目标：
- conversation 取 files 时必须绑定 user + tenant。
- file_id 解析时必须再次校验 owner + tenant + conversation。

### S6. PTC 白名单逻辑反了，未显式声明时 fallback-to-all
重点文件：
- `api/app/clients/tools/util/localSandboxTools.js`

目标：
- 改成 default deny。
- 只有显式 `allowed_callers` 才能被 PTC 暴露。

### S7. allowProgrammaticToolBridge 配置未真正执法
重点文件：
- `api/server/utils/difyConsoleConfig.js`
- `api/server/services/ToolService.js`
- `api/app/clients/tools/util/localSandboxTools.js`

目标：
- 配置关闭时，后端必须拒绝创建 PTC。

### S8. bridge 把容器接回宿主
重点文件：
- `api/server/services/Sandbox/bridgeServer.js`
- `api/app/clients/tools/util/localSandboxTools.js`

目标：
- 去掉 `0.0.0.0 + host.docker.internal + host-gateway` 这种宿主暴露方式。
- 若短期不能安全保留，先关闭 PTC 网络桥接。

### S9. run_unit_tests 在宿主直接 spawn 用户项目
重点文件：
- `api/server/services/Sandbox/advancedWorkspaceTools.js`
- `api/app/clients/tools/util/workspaceTools.js`

目标：
- 立即 stop-the-bleeding。
- 若无法快速安全实现，先在工具层禁用该工具。
- 不允许再在宿主直接执行用户测试。

### S10. run_unit_tests 继承宿主 process.env
重点文件：
- `api/server/services/Sandbox/advancedWorkspaceTools.js`

目标：
- 即便临时保留最小能力，也绝不能透传完整 `process.env`。

### S11. run_unit_tests 允许 node/python/npx 等宿主解释器
重点文件：
- `api/server/services/Sandbox/advancedWorkspaceTools.js`

目标：
- 彻底去掉宿主任意解释器执行面。

### S12. realpath 边界未收紧，host-side 文件解析跟随 symlink 越界
重点文件：
- `api/server/services/Sandbox/advancedWorkspaceTools.js`
- `api/server/services/Sandbox/workspaceFs.js`

目标：
- 所有读文件、读目录、递归遍历、grep/search 都必须 realpath + base boundary check。
- 错误语义统一为：
  - `Error: 符号链接越界，禁止访问工作区外部文件`

### S13. process_list 泄露宿主进程树
重点文件：
- `api/server/services/Sandbox/processList.js`
- `api/app/clients/tools/util/workspaceTools.js`

目标：
- 默认对普通用户关闭。
- 若保留，仅返回安全最小元数据，且范围是真正 sandbox scoped。

### S14. host-side 网络工具绕过无网容器策略
重点文件：
- `api/server/services/Sandbox/advancedWorkspaceTools.js`

包括：
- `dnsResolve`
- `portCheck`
- `curlHeadOnly`
- `httpHeadersInspect`
- `cveLookup`

目标：
- 不允许普通 agent 借宿主工具获得越权外联能力。

### S15. 下载链接公开 + 弱 secret + claims 不重校验
重点文件：
- `api/server/index.js`
- `api/server/services/DownloadLinks/index.js`

目标：
- secret 必填，未配置即 fail-fast。
- file/sandbox 下载都要二次校验 owner/tenant/conversation。
- 不能只信 token claims。

### S16. runtimeContract secret 有默认值
重点文件：
- `api/server/services/Sandbox/runtimeContract.js`

目标：
- secret 必填，未配置启动失败。

### S17. 默认管理员弱口令 / seed 风险
重点文件：
- `api/models/index.js`
- `.env` / `.env.local`

目标：
- 去掉默认弱口令 fallback。
- 改成 bootstrap-required。

### S18. 项目级上游 API 密钥不能明文回显到前端
重点文件：
- `api/server/utils/projectApiConfig.js`
- `client/src/components/Admin/ProjectApiAdminPage.tsx`

目标：
- 只允许 masked 回显。
- 写入时可提交，读取时不返回明文。

### S19. 日志脱敏
重点文件：
- `api/server/middleware/*`
- `api/server/utils/*`
- 前端 action/editor 调试打印点

目标：
- request body/query、auth 表单、token、api key、oauth secret 必须统一脱敏。

### S20. cookie sameSite / auth 会话边界
重点文件：
- `api/server/controllers/auth/*`
- `api/server/socialLogins.js`
- 相关 cookie/set-session 逻辑

目标：
- 显式设置 sameSite 策略，避免部署时漂移。

---

## 7. 你必须处理的功能/前端质量问题

> 注意：以下问题里，有些仓库中可能“已经部分实现”，但可能只是半成品、局部实现、未接保存链路、未统一复用。你必须先核对是否真的闭环，而不是只看 UI 存不存在。

### F1-F20（逐项核对并定位源码）
1. 自定义滑块参数未真正进入请求 payload
2. 自定义下拉参数未真正进入请求 payload
3. 自定义端点配置页不支持完整端点定义
4. 自定义端点配置页不支持完整模型列表配置
5. 除 `baseURL/apiKey` 外的其他自定义端点字段被忽略
6. 预设为空时空状态不能直接创建预设
7. Assistants 动作 OpenAPI 编辑器示例模板/模板注入闭环检查
8. Assistants 动作 OpenAPI 编辑器格式化能力闭环检查
9. Agents 动作 OpenAPI 编辑器示例模板闭环检查
10. Agents 动作 OpenAPI 编辑器格式化能力闭环检查
11. `privacy_policy_url` 输入是否真正进入保存 payload、回显、详情页
12. 分节配置权限是否只是脚手架，未真正 section 生效
13. Assistants 初始模型过滤是否错误挡掉 GPT-5 系列
14. Agents 是否错误复用 OpenAI 模型集合而没有独立白名单
15. Google 生成配置对 legacy 字段是否缺兼容映射
16. Prompt 为空时是否静默失败
17. chat badges 是否空壳
18. 临时 Agent 附件菜单能力判断是否按 endpoint 配置
19. 临时 Agent 拖拽上传能力判断是否按 endpoint 配置
20. Action 保存流程里多处前置校验失败后直接 return、无提示

重点前端区域：
- `client/src/components/SidePanel/Builder/*`
- `client/src/components/SidePanel/Agents/*`
- `client/src/components/Chat/Input/*`
- `client/src/components/Endpoints/*`
- `client/src/hooks/Input/*`
- `client/src/hooks/Agents/*`
- `packages/data-provider/src/createPayload.ts`
- `packages/data-provider/src/parameterSettings.ts`
- `packages/data-provider/src/config.ts`

要求：
- 不只修 UI；
- 要打通 `表单状态 -> payload -> 请求 -> 服务端保存 -> 回显` 全链路；
- 所有静默失败必须有明确 toast 或字段级错误提示。

---

## 8. 你必须处理的兼容性问题（统一收口，不允许散改）

### C1. textarea / insert text
目标：
- 不再在业务组件里直接依赖过时写法。
- 统一走 `client/src/utils/textarea.ts`。
- 保留最小 fallback。
- 保证撤销栈、输入法、selection 行为可接受。

### C2. scrollIntoView 行为统一
目标：
- 统一走 `client/src/utils/scroll.ts`。
- 业务代码不要直接散落 `scrollIntoView(...)`。
- 不接受各组件自行处理非标准 behavior。

### C3. structuredClone 降级
目标：
- 统一走 `client/src/utils/structuredClone.ts`。
- server/package 侧若有直接调用，也要补兼容策略或集中封装。

### C4. clipboard.writeText 降级
目标：
- 所有复制操作统一走 `client/src/utils/clipboard.ts`。
- 消灭直接 `navigator.clipboard.writeText()` 的散点调用。

### C5. ResizeObserver 降级
目标：
- 统一走 `client/src/utils/resizeObserver.ts`。
- 消灭直接 `new ResizeObserver(...)` 的散点调用。
- 在旧浏览器/嵌入环境至少要 fail-soft，不要直接崩。

---

## 9. 分阶段执行计划（必须严格按阶段做）

## Phase 0：建图与测试锚点
先做：
1. 列出本次将修改的文件清单（按阶段）。
2. 列出现有相关测试清单。
3. 新增一个审计说明文档到仓库（例如 `docs/security-remediation-plan.md` 或现有合适目录，不要乱放），记录阶段与目标。
4. 补最小 smoke tests 框架，确保后续每阶段能跑。

完成标准：
- 你已经能明确回答：哪个问题在哪个文件、哪条链路、怎么测。

## Phase 1：切断授权和跨会话链路
只改：
- `packages/data-provider/src/config.ts`
- `api/server/controllers/tools.js`
- `api/server/services/Sandbox/authorization.js`
- `packages/data-schemas/src/methods/conversation.ts`
- `packages/data-schemas/src/methods/file.ts`（如需要）
- `api/server/services/Sandbox/uploads.js`
- 对应 spec/test

目标：
- execute_code 真正受控
- default capability 收紧
- conversation/message/file 归属绑定闭合
- 不允许跨会话同步文件到 sandbox

## Phase 2：切断 workspace tools/PTC 暴露面
只改：
- `api/server/services/ToolService.js`
- `api/app/clients/tools/util/localSandboxTools.js`
- `api/app/clients/tools/util/workspaceTools.js`
- `api/server/utils/difyConsoleConfig.js`
- 对应 spec/test

目标：
- 自动追加 workspace tools 关闭
- PTC 改为 default deny
- 配置开关真正生效

## Phase 3：切断宿主执行与宿主桥接
只改：
- `api/server/services/Sandbox/advancedWorkspaceTools.js`
- `api/server/services/Sandbox/bridgeServer.js`
- `api/server/services/Sandbox/processList.js`
- `api/server/services/Sandbox/workspaceFs.js`
- 对应 spec/test

目标：
- `run_unit_tests` 不再宿主执行
- `process.env` 不再泄露
- host-gateway/bridge 暴露关闭或 fail-closed
- symlink 越界彻底封死
- process_list 缩权
- host-side 网络工具缩权或关闭

## Phase 4：签名下载与 contract secret
只改：
- `api/server/services/DownloadLinks/index.js`
- `api/server/services/Sandbox/runtimeContract.js`
- `api/server/index.js`（如需）
- 对应 spec/test

目标：
- 下载 token 二次校验归属
- 默认 secret 移除
- 未配置 secret 时 fail-fast

## Phase 5：默认管理员、日志、项目 API 密钥治理
只改：
- `api/models/index.js`
- `api/server/utils/projectApiConfig.js`
- `client/src/components/Admin/ProjectApiAdminPage.tsx`
- 相关 auth/logging 文件
- 对应 spec/test

目标：
- 去掉弱口令 fallback
- API key 不再明文回显
- 日志统一脱敏

## Phase 6：功能闭环与静默失败治理
重点改：
- `client/src/components/SidePanel/Builder/*`
- `client/src/components/SidePanel/Agents/*`
- `client/src/components/Chat/Input/*`
- `client/src/hooks/*`
- `packages/data-provider/src/*`
- 必要的后端保存链路
- 对应 UI/unit/integration tests

目标：
- 20 个功能问题逐项闭环
- 所有直接 return 的静默失败改成显式提示

## Phase 7：兼容 helper 收口
重点改：
- `client/src/utils/clipboard.ts`
- `client/src/utils/structuredClone.ts`
- `client/src/utils/resizeObserver.ts`
- `client/src/utils/scroll.ts`
- `client/src/utils/textarea.ts`
- 所有绕过 helper 的调用点
- 对应 unit tests

目标：
- 兼容能力统一收口
- 散点直接调用全部迁移

## Phase 8：攻击验证 + 回归验证 + 交付收口
必须新增：
- 安全回归测试
- 攻击验证脚本/用例
- 兼容性回归测试
- 交付总结文档

---

## 10. 交付完成标准（Definition of Done）

以下同时满足，才算“交付完成”：

### 10.1 代码层完成
- 高危链路已被切断：
  - 普通用户不能直接拿 execute_code
  - 不能跨 conversation/file 越权同步文件
  - 不能通过 PTC fallback-to-all 获取全部工具
  - 不能通过 run_unit_tests 在宿主执行用户代码
  - 不能通过 symlink 越界读取宿主文件
  - 不能通过弱 secret 伪造下载/contract
- 兼容 helper 已统一收口。
- 功能问题中所有“只在 UI 层有影子、未真正闭环”的点已打通。

### 10.2 测试层完成
至少新增/通过：
- 单元测试
- 服务层测试
- 路由/控制器权限测试
- 至少 1 组攻击验证
- 至少 1 组兼容回归验证
- 至少 1 组静默失败提示验证

### 10.3 文档层完成
必须产出：
- 修复说明
- 改动文件清单
- 风险关闭说明
- 剩余风险说明
- 攻击验证结果
- 回归测试结果

---

## 11. 成功标准（Definition of Success）

只有“改完代码”不算成功。以下同时满足才算成功：

1. **高危利用链被实证关闭**。
2. **现有仓库结构未被打乱**。
3. **数据库结构完全未变**。
4. **前端体验没有因为安全修复而大面积损坏**。
5. **关键功能链路仍然能跑通**：
   - 聊天
   - 会话
   - 文件上传
   - agent/assistant 配置
   - action schema 编辑/保存
   - 下载
6. **兼容性 helper 已形成统一治理面**，不是修一处漏一片。
7. **Codex 自己提交了攻击验证证据和测试证据**。

---

## 12. 你必须自己写的攻击验证（至少这些）

### A1. execute_code 未授权调用攻击
验证目标：
- 无 `RUN_CODE` / 无对应 capability 时，调用失败。

### A2. messageId + conversationId 混搭攻击
验证目标：
- 自己的 messageId + 别人的 conversationId 不能同步别人的文件。

### A3. PTC fallback-to-all 攻击
验证目标：
- 未显式 allowed 的工具不会暴露给 sandbox/PTC。

### A4. run_unit_tests 宿主执行攻击
验证目标：
- 用户项目不能再触发宿主 node/python/npx 直接执行。

### A5. symlink 越界读取攻击
验证目标：
- 建立符号链接指向工作区外文件后，所有 host-side 读/遍历工具都报：
  - `Error: 符号链接越界，禁止访问工作区外部文件`

### A6. 伪造下载 token 攻击
验证目标：
- 即便 token claims 被构造，也无法越权下载非本人文件或非本人 sandbox 输出。

---

## 13. 你必须自己写的回归验证（至少这些）

### R1. 正常聊天与文件上传
- 普通文本消息正常
- 图片/文档上传正常
- endpoint 切换正常

### R2. agent/assistant/action 配置
- OpenAPI schema 编辑、模板插入、格式化、保存、回显正常
- `privacy_policy_url` 保存与回显正常

### R3. 兼容 helper 回归
- clipboard helper 在无 `navigator.clipboard` 场景不崩
- structuredClone helper 在无原生 `structuredClone` 场景不崩
- ResizeObserver helper 在无原生场景不崩
- scroll helper 行为一致
- textarea helper 在输入/插入文本时不崩

### R4. 静默失败治理
- prompt 为空保存时必须有提示
- action schema 非法时必须有提示
- URL 解析失败时必须有提示
- 前置校验失败不允许只 return 无反馈

---

## 14. 你的工作方式（必须严格遵守）

1. **先输出 Phase 0 的分析计划，不要直接改代码。**
2. 每次只做一个 Phase。
3. 每个 Phase 的输出格式固定为：
   - 本阶段目标
   - 变更文件
   - 关键改动点
   - 测试变更
   - 已关闭风险
   - 剩余风险
   - 下一阶段建议
4. 若发现我给的问题在当前仓库里已经“部分修复”，你要明确区分：
   - 已完全闭环；
   - 仅局部修复；
   - 只是 UI 存在，保存链路未接；
   - helper 已存在，但大量调用点没迁移；
   - 需要补测试才能算完成。
5. 不要泛泛而谈，要给出：
   - 具体文件路径；
   - 具体函数名；
   - 具体改法；
   - 具体测试名建议。

---

## 15. 你现在的第一步

现在先不要写最终总结，也不要一次性改全部。

你现在立即开始做下面 5 件事：

1. 读清第 2、3、4、5 节里列出的目录、调用链、数据结构、关键文件。
2. 输出 **Phase 0 分析结果**：
   - 本次涉及的精确文件清单
   - 每个文件的职责
   - 每个问题归属到哪个阶段
3. 明确列出：
   - 哪些问题已经部分实现但未闭环
   - 哪些问题必须先 fail-closed
4. 然后只开始 **Phase 1**。
5. Phase 1 完成后，按固定格式汇报，不要越阶段施工。

记住：
- **保持源码结构**
- **不改数据库结构**
- **所有修复都要能测试验证**
- **最后必须自写攻击验证证明你真的修好了**
