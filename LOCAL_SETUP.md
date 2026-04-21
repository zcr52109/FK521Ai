# 本地可编译/可校验说明

当前仓库快照可直接在本地完成以下闭环：

1. 安装依赖
2. 语法检查
3. 运行 workspace tools 回归测试

## 一键执行

```bash
npm run bootstrap
npm run verify
```

## 说明

- `bootstrap` 会同时安装根目录和 `FK521AI/api` 子项目依赖。
- `verify` 会先执行 `npm run check`（Node 语法检查），再执行 `npm test`（workspace tools 测试）。
- 若你仅想单独运行 workspace 回归，可执行：

```bash
npm run start:workspace-harness
```
