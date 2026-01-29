# Releasing

## macOS：签名 + Notarization（让用户不再看到“Apple 无法验证”）

从 GitHub Releases 下载的未签名/未公证可执行文件，macOS 会触发 Gatekeeper 警告。要消除该提示，需要对二进制进行：

- Developer ID Application 签名（codesign）
- Notarization（notarytool）

本仓库已在 GitHub Actions 里内置了签名/公证流程：当你 push tag（`v*`）触发 release workflow 时，macOS 构建会自动对产物签名、打包成 zip 并提交 notarization。

## 你需要准备什么

- 一个 `Developer ID Application` 证书（包含私钥，可导出 `.p12`）
- 一个 Apple ID 的 App-Specific Password（notarytool 用）
- 你的 Apple Developer Team ID
- 把以上信息配置到 GitHub Actions Secrets

### 需要的 GitHub Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret 添加：

- `MACOS_CERT_P12_BASE64`：Developer ID Application 的 `.p12` 证书 base64
- `MACOS_CERT_PASSWORD`：`.p12` 的密码
- `APPLE_ID`：你的 Apple ID（邮箱）
- `APPLE_TEAM_ID`：Team ID
- `APPLE_APP_PASSWORD`：Apple ID 的 App-Specific Password（用于 notarization）

注意：这些值只用于 CI，别放进仓库文件。

## 第一步：创建/安装 Developer ID Application 证书（如果你还没有）

如果你打开钥匙串访问，在“我的证书（My Certificates）”里搜不到 `Developer ID Application`，说明你的电脑上还没有可用的签名身份，需要先创建。

### A) 用钥匙串访问生成 CSR

1. 打开「钥匙串访问（Keychain Access）」
2. 菜单栏：钥匙串访问 → 证书助理 → 从证书颁发机构请求证书…
3. 填写：
   - 用户电子邮件地址：你的 Apple ID 邮箱
   - 常用名称：例如 `llm-apikey-lb`（随意）
   - CA 电子邮件地址：留空
4. 选择：
   - “存储到磁盘”
   - “让我指定密钥对信息”（如果有）
5. 生成 `CertificateSigningRequest.certSigningRequest`

### B) 在 Apple Developer 创建证书

1. 打开 developer.apple.com → Account → Certificates, Identifiers & Profiles → Certificates
2. 点击 “+” 新建证书
3. 选择 `Developer ID Application`
4. 上传刚才生成的 CSR
5. 下载生成的证书（`.cer`），双击安装到钥匙串

安装完成后，回到「钥匙串访问 → 我的证书」应该能看到：
`Developer ID Application: <你的名称/公司>`，并且可展开看到“私钥”。

### 如何导出 `.p12`（Developer ID Application）

先确认你打开的是「钥匙串访问 Keychain Access」这个应用（不是系统设置里的“密码”/“Passwords”）。

打开方式（任选其一）：

- Spotlight 搜索：Keychain Access / 钥匙串访问
- Finder：前往文件夹：`/System/Library/CoreServices/Applications/Keychain Access.app`

导出步骤：

1. 在左侧分类选择「我的证书（My Certificates）」；钥匙串选「登录（login）」
2. 搜索 `Developer ID Application`（应当能看到 `Developer ID Application: <Your Name/Company>`）
3. 确认该证书条目左侧可展开，下面有一条“私钥”（没有私钥就无法导出 `.p12`）
4. 右键证书 → 导出… → 选择 `.p12`，并设置导出密码
5. 转 base64：

```bash
base64 -i ./DeveloperID.p12 | pbcopy
```

把粘贴板内容写入 `MACOS_CERT_P12_BASE64`，导出密码写入 `MACOS_CERT_PASSWORD`。

如果你在钥匙串里找不到 `Developer ID Application`：

- 可能还没创建/安装证书：去 Apple Developer → Certificates 创建 `Developer ID Application`，用 Keychain Access 生成 CSR 后下载并双击安装。
- 或用命令行快速检查本机是否有可用签名身份：

```bash
security find-identity -v -p codesigning
```

### 如何生成 App-Specific Password

1. 登录 Apple ID 账号页面
2. 安全 → App 专用密码 → 生成
3. 把生成的密码填入 `APPLE_APP_PASSWORD`

### 如何找到 Team ID

在 Apple Developer 账号里通常能在：

- developer.apple.com → Account → Membership（会显示 Team ID）

### 发布流程

1. 合并代码并 push 到 `main`
2. 打 tag 并 push（会触发 workflow）：

```bash
./release.sh "0.1.1"
```

### 验证（本地）

下载 release 的 macOS zip 后（或 CI 产物）：

```bash
codesign -dv --verbose=4 ./llm-apikey-lb-macos-arm64 2>&1 | head
spctl --assess --type execute --verbose=4 ./llm-apikey-lb-macos-arm64
```
