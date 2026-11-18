# SubCast · 声渡 for DeepSeek Harness

本机日用 DSH 已安装声渡，在桌面窗口的侧栏点击 **SubCast · 声渡** 即可打开。

在 DSH 侧栏收听播客和 YouTube，跟读双语字幕，向当前单集提问。声渡默认用 DSH 已登录的 DeepSeek 账号回答问题和生成导读。账号模型不可用时，使用 DSH 当前的默认模型。在问答输入框旁或声渡的模型设置里，可以搜索并单独选择模型。模型设置依次显示 DSH、API 模型和本机 AI。

![DSH 中的声渡播放器与时间轴字幕](docs/dsh-playback.png)

## 安装和使用

本次本地包包含 macOS Apple Silicon 引擎，验证宿主为 DeepSeek Harness 0.2.2-rc.3。安装包自带界面和引擎。使用本机桌面附带的 CLI，将本地包加入指定 profile。以下命令适用于已存在的 desktop profile。

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "$PWD/qiaomu-subcast-dsh-0.1.3-darwin-arm64.tgz"
```

重启对应的 DSH，在侧栏点 **SubCast · 声渡**。在顶部粘贴节目链接或 RSS 并按回车，点开单集。字幕准备好后切换到「问答」，回答中的时间戳可以跳回播放位置。原版四种界面语言可在声渡设置中切换。插件升级由 DSH 的包管理负责。

## 功能与数据

| 功能 | 插件中的位置与实现 |
| --- | --- |
| 订阅、发现、导入 | 首页搜索、发现页、导入面板。保留 RSS、Apple Podcasts、小宇宙、YouTube 和乔木精读解析，支持订阅导出 OPML。 |
| 播放、队列、收藏、历史 | 单集播放器、迷你播放器、收听统计。保留视频嵌入、直连回退、倍速、进度和离线下载。 |
| 字幕、翻译、识别 | 原始字幕、共享字幕、Whisper、Qwen3-ASR、云端识别、分批翻译、语言轨和任务取消。 |
| 单集问答、导读、选段 | 带时间戳文稿、已有对话和选段按原有交互传入模型。保留流式回答、导读缓存、朗读、海报。|
| 本机资源 | DSH Host 按需启动 Rust 引擎，承接 SQLite、网络、钥匙串、本地 CLI 和 ASR 工作进程。插件停用时关闭服务，macOS 上同时终止该引擎的进程组。 |

默认数据目录为 `$DSH_HOME/plugin-data/qiaomu-subcast-dsh`，未设置 DSH_HOME 时位于 `~/.dsh` 下。DSH profile 可以用插件行的 `config.dataDir` 指定其他目录。媒体面板使用回环地址，仅面向本机 DSH。独立填写的服务商 Key 保存在插件专用系统钥匙串项中。

**迁入已有收藏、字幕、对话、离线文件和模型**时，先关闭源程序和目标插件，选择一个尚不存在的目标目录。下面是首次使用默认目录前的示例。脚本使用 SQLite backup API，包括已提交到 WAL 的数据，校验完整性后复制下载与模型，再将准备好的目录移入目标位置。

```sh
python3 scripts/import-library.py \
  "$HOME/Library/Application Support/ai.qiaomu.subcast" \
  "${DSH_HOME:-$HOME/.dsh}/plugin-data/qiaomu-subcast-dsh"
```

已有插件资料库时，导入到新目录后设置 `config.dataDir`，可通过切回原目录恢复。模型文件可能较大。浏览器内的栏宽和音量在新面板中单独保存。独立版服务商 Key 需要在插件设置中重新填写，使用 DSH 默认模型时省略此步骤。

## 开发和验证

源版本为 [SubCast](https://github.com/joeseesun/subcast/tree/ca578c5ed201e5e18bab63afd4d72dcf515532cb) 0.2.8。技术栈为 React、TypeScript、Vite、Node 和 Rust。Host 注册面板连接入口，Client 注册侧栏和主面板。音视频 UI 使用单独的回环源，RPC 校验来源和会话凭据，长任务通过事件流报告进度。问答经 DSH 的 llm 服务或选定的原版服务商调用。共享字幕服务源码位于 server，插件沿用原有服务地址。

```sh
npm ci
npm run build
npm test
npm run i18n -- --strict
cargo test --release --locked --manifest-path native/Cargo.toml
npm --prefix server test
npm pack
```

构建需要 Rust、C/C++ 工具链、CMake 和 libclang。打包时编译当前平台的原生引擎。Windows 构建可用 SUBCAST_VCRT_DIR 指定 CrispASR 的 Visual C++ 运行库目录。Windows 和 Linux 尚未实机验收。

## English

SubCast brings podcast and YouTube subscriptions, offline playback, bilingual transcripts and episode Q&A to the DeepSeek Harness sidebar. Install the local package into a web-enabled profile and open **SubCast**. Select DeepSeek in Harness to use your existing host configuration. The plugin also supports separate providers and local AI agents. Its library lives under DSH_HOME and can be populated with the SQLite migration command above. The supplied binary targets Apple Silicon macOS. See LICENSE for AGPL-3.0-only terms.

## 本机验收

在 Apple Silicon Mac 上，从安装包加载 DSH 侧栏和主面板后，实际完成订阅、字幕加载、离线下载和播放。用同一段英文音频分别运行 Whisper base 与 Qwen3-ASR，两者均返回了带时间的英文转写。真实资料库复制到临时目录后，核验了七张表的行数、下载和模型文件大小，以及目标目录覆盖保护。

下图是宿主 DeepSeek 根据测试单集第二句字幕返回的回答。关闭浏览器后再次打开该单集，对话仍在；点击引用的 0:03，已下载音频从第 3 秒开始播放。远程音频能否直接跳转也取决于源服务器是否支持范围请求。

![单集问答与真实 DeepSeek 回答](docs/dsh-qa.png)

其他实测包括 YouTube、Apple Podcasts、小宇宙、RSS 订阅解析，模型流式事件、错误返回、重开资料库，以及离线媒体范围读取。付费云端 ASR、TTS、各家模型服务、浏览器账号导入、YouTube 视频直连和 Windows/Linux 尚未逐项实测。
