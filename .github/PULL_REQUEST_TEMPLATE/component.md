<!--
可执行组件投稿模板。技能包请使用通用模板。
自动检查只证明结构/完整性，不等于安全或隐私审批通过。
-->

### 组件身份与来源

- id / 名称：
- 作者、维护者与联系方式：
- origin（official / community）：
- license 与许可证文本/NOTICE 位置：
- 源码仓库与精确 source revision（commit SHA）：
- 本 PR 相对上述 revision 的改动：

### 版本与兼容

- version / minHost / apiVersion：
- 变更内容与 whatsNew：
- 依赖 id、用途及加载顺序：
- mode / entry（新组件必须 sandbox）：
- 是否改变同版已发布内容（若是，必须停止并升版本）：

### 权限、网络与数据申报

- requires / permissions 及逐项必要性：
- 实际网络域名、请求目的、发送的数据字段与保留期限：
- 文件系统读写路径；文库、笔记、设置、凭据访问范围：
- 是否调用 AI；是否外传全文、笔记、账号信息或其他用户数据：
- 删除、卸载、回滚时的数据行为：

### 第三方载荷与构建

- 第三方依赖/二进制/压缩资源：来源、版本、license、NOTICE：
- 完整文件清单与构建步骤：
- 是否存在远程下载后执行、混淆或原生二进制（须逐项解释）：

### 测试、风险与回滚

- [ ] 已运行 `python scripts/module-governance.py --map scripts/module-map.json`
- [ ] 已在临时/新版本目录运行 `python scripts/build-module.py --check`
- [ ] 已运行 `python scripts/publish-modules.py --verify`（有 zip 时）
- [ ] 已测试安装、升级、同版 noop、普通降级拒绝、卸载与本地 previous 回滚
- 测试环境、命令与结果（附证据）：
- 已知风险、隐私影响与限制：
- 回滚方案及数据迁移兼容性：

### 审批记录（维护者填写）

- 自动检查结果（不得写成“安全审批通过”）：
- 人工源码/权限/隐私/第三方载荷审核人、时间与结论：
- 审批的 id + version + source revision + zipSha256：
- 发布者、发布时间、Release tag/分组：
- 撤销或后续跟进事项：
