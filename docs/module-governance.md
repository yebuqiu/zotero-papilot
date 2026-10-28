# 组件投稿、审批与发布治理

本文是组件商店的长期操作规范。当前采用**方案 A：主仓 PR 投稿 + 维护者人工审批 + 授权发布者构建/签名/上传/patrol**。仓库没有作者在线上传后台，也没有自动安全审批服务。

## 1. 信任边界与角色

- **作者**：提交源码、`scripts/module-map.json` 条目和 `.github/PULL_REQUEST_TEMPLATE/component.md` 全部材料；不得自行填写生成物 hash 代替构建。
- **审核维护者**：审源码 diff、许可、权限必要性、真实网络/数据行为、第三方载荷、生命周期和回滚。自动检查通过**不等于安全审批通过**。
- **授权发布者**：在干净、已审批 revision 上构建，验证 zip hash，签名、stage、上传并巡检。签名私钥只在仓外由授权者保管，任何工具不得把私钥读入日志或 PR。
- 新作者首投、维护者变更、权限扩大、第三方载荷或构建链变化必须重新人工审批。`community-packs/` 是声明式技能包体系，不能替代可执行组件审核。

## 2. 作者上传（PR）清单

1. 稳定 id、名称、作者/维护者、`origin`、明确 license、源码仓库和精确 source revision；社区不得使用 Papilot 官方身份。
2. 独立 `version`、`minHost`、`apiVersion`、changelog、`mode/entry/provides/depends`；新代码组件必须显式 `sandbox`。官方遗产项的 9+1 scope 白名单冻结，不得新增例外。
3. 显式源文件清单和可复现构建步骤；LICENSE、XHTML、JSON 等非 JS 资源是合法载荷，但 ZIP 不得含未声明文件。
4. requires/permissions 及必要性；实际域名、数据字段、文件与文库访问、AI 与外传、保留/删除行为；第三方依赖及 license/NOTICE。
5. 安装/升级/卸载/回滚测试、风险与限制；维护者审批最终绑定 `id+version+source revision+zipSha256`。

离线结构自查：

```bash
python scripts/module-governance.py --map scripts/module-map.json
python scripts/module-governance.py --manifest modules/<id>/module.json --zip dist/modules/<id>-<version>.zip
python scripts/module-governance.py --catalog papilot-modules-index.json
```

## 3. 确定性与兼容规则

- id 为 2–64 位小写字母/数字/连字符且唯一；文件归属、ZIP entry、provides/依赖声明不得重复。
- 版本只支持 1–4 段数字点分；数字段比较、短版本补零，`1.0` 与 `1.0.0` 比较相等。**prerelease 不在当前比较器支持内**，不得直接引入 SemVer 后缀。
- 官方 9 组件可继续 `auto` 跟主包；社区组件必须显式独立版本。合集成员必须同版本，发布按各自 `v<version>` tag 分组，不能用第一个组件代表全部。
- manifest 每项文件必须有 sha256 和非负整数 size；entry 必须在 files 内；ZIP 与清单精确同集合，拒绝穿越、绝对路径、反斜杠和重复 entry。
- depends 必须存在，禁止自依赖和环；合集禁止嵌套。能力与权限必须属于宿主 v1 词表。
- 新治理字段保持可选读取以兼容旧目录/旧宿主；官方 9+1 遗产项从 map 的显式默认继承作者/license/repo，社区没有官方默认。
- `(id,version)` 发布后内容不可变：同版不同 zip hash 一律硬失败，任何源码、manifest、依赖、权限或安全语义变化都升版本。普通降级拒绝；内部 force 只能排障且必须仍是同 hash，不能用来同版换内容。用户回滚只使用本地已验证 previous，并注意数据迁移。

## 4. 发布硬门槛

以下命令由发布者在**已审批的新版本**上执行；禁止重写已发布 0.74.1：

```bash
python scripts/preflight.py --strict
python scripts/build-module.py --check
python scripts/build-module.py --all
python scripts/publish-modules.py --verify
python scripts/publish-modules.py --stage
python scripts/upload-module-assets.py --version <version> --dry-run
python scripts/upload-module-assets.py --version <version>
python scripts/patrol-modules.py
```

- `build --check` 与 `publish --verify` 是每次发布前硬门槛；preflight 的离线 map 检查不依赖私钥或 gitignored zip，也不把已知历史生成物漂移变成所有 PR 的默认阻断。
- 签名命令非零、缺私钥、签名缺失或异常均使构建/stage 失败。stage 将新目录与现有公开目录比较，同版 hash 不同即拒绝。
- 同名 Release 附件必须下载比对 sha256；相同才幂等跳过，不同即冲突并停止。网络错误不得记为成功。
- 多版本按脚本输出的 tag 分组上传；不得把全部 zip 塞进第一个组件的 Release。目录 `hostMin` 只是全目录最低基线，每条目的 `minHost` 才是安装约束。
- 发布后巡检双端目录治理字段、签名、zip hash。同步延迟可重试，但不能忽略最终差异。

**当前已知漂移**：调查时主包源码为 0.77.0，9 个组件生成物仍为 0.74.1；`build-module.py --check` 报 15 处不一致（9 个版本、ai 5 个源文件、notes 1 个 size），而旧 `publish --verify` 只证明 0.74.1 manifest/zip 自洽。不得为让检查变绿覆盖旧版；后续发布必须使用新版本。

## 5. 审批与审计字段

发布记录至少保存：投稿 PR、作者/维护者、source revision、自动检查命令与结果、审核人/时间/结论、签名 zipSha256、发布者/时间/通道/Release tag、patrol 结果。撤销另记操作人/时间/原因/影响版本/替代版本。公开目录不放私人联系方式或密钥。

目录签名当前仍是 payload v1。下载 URL、权限、撤销等更多字段纳入签名需要版本化 v2、双读迁移与旧宿主测试；本轮不无迁移替换 v1。只有明确缺少 WebCrypto API 的老宿主可按原策略降级；畸形 key/signature 或验签异常必须拒绝，无公钥的旧宿主过渡策略保留。

## 6. 软下架与安全撤销 playbook

### 软下架

1. 记录 id/version、原因、时间和替代版本，维护者审批目录变更。
2. 从当前 fresh 目录撤下条目（保留审计记录；签名 tombstone 属后续 schema 工作），重新签名、发布并 patrol。
3. 已安装条目仍须显示、可卸载/回滚；向用户说明缓存和离线实例可能继续看到/使用旧版。

### 安全撤销（高危/恶意）

1. 立即停止该版本后续发布，保存证据、hash 和影响范围，发布修复版本并通知用户手动卸载/更新。
2. fresh 目录阻止新装只是第一步；真正的 signed revoked 列表、已装实例禁用、缓存防回放和启动策略需要 loader/store/UI 配套实现与测试，不能靠删除目录条目冒充完成。
3. 静态目录 + 12h/过期缓存无法承诺即时触达离线用户。不得声称“远程即时禁用”；需明确缓存最长期限和下次联网收敛过程。紧急事件按审计字段记录实际触达与残余风险。

回滚发布不得复用旧 `(id,version)` 改内容；应发布更高修复版本。本地 previous 回滚与安全撤销不同，不得用回滚绕过高危版本禁用策略（该策略实现前也不得虚假承诺）。
