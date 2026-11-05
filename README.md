# 哔哩下载台 · BiliShelf

用于保存有权下载的哔哩哔哩投稿视频。扩展在浏览器内把独立的音轨和视频轨合并成 MP4，保留原编码和色彩信息。

- 支持单条投稿视频、分 P、合集、系列、收藏夹和稍后再看。可勾选条目后顺序下载。若列表接口只返回视频编号，列表中的条目对应第一个分 P，可直接解析该视频链接来下载其余分 P。
- 可选择最高可用画质、4K SDR、4K HDR 或 1080P SDR。清晰度由源视频和当前浏览器的 B 站账号权限决定。4K HDR 要求 B 站实际提供 4K 分辨率的 HDR 流。杜比视界与 HDR10/HDR Vivid 分开识别。指定画质缺失时，该任务提示原因，队列继续处理后续条目。
- 支持队列进度和取消。请在任务完成前保留下载台标签页。已保存的文件在浏览器的下载目录中，默认子目录为 `BiliShelf`。
- 当前版本面向投稿视频及其列表。番剧、电影、直播和需要 DRM 的视频不在支持范围内。HDR 播放效果还取决于播放器、系统和显示器。

## 构建与预览

需要 Node.js 20 或更高版本以及命令行 `zip`。项目没有运行时依赖。

```sh
npm test
npm run build
npm run preview
```

预览服务运行在 `http://127.0.0.1:4173/`。点击「从本窗口带入链接」即可加载示例链接，再试用解析、勾选与模拟下载。浏览器扩展包使用 B 站真实数据。

| 目标 | 本地调试 | 上传文件 |
| --- | --- | --- |
| Chrome 120+ | 在 `chrome://extensions` 打开开发者模式，选择「加载已解压的扩展程序」，指向 `dist/chrome` | `dist/bilishelf-chrome-0.1.0.zip` |
| Firefox 142+（桌面） | 在 `about:debugging#/runtime/this-firefox` 选择「临时载入附加组件」，打开 `dist/firefox/manifest.json` | `dist/bilishelf-firefox-0.1.0.zip` |

安装后打开 B 站视频，点击工具栏的哔哩下载台图标即可带入链接。也可直接粘贴链接或 BV 号，点击「解析链接」后选择清晰度并下载。4K 选项不可用时，可先在 B 站原页面检查播放器画质，再在同一浏览器重新解析。

## 用自己的账号提交

1. **Chrome Web Store**。登录自己的 Chrome Web Store 开发者后台，创建项目并上传 Chrome ZIP。填写商品详情、截图、隐私披露和测试说明，然后提交审核。
2. **Firefox Add-ons（AMO）**。登录自己的 Mozilla 开发者后台，提交 Firefox ZIP 并选择桌面分发。构建包保留可读源文件。审核表单如要求独立源代码，提供本项目源码与上面的构建命令。首次提交前可在 `scripts/build.mjs` 修改 Gecko 扩展 ID，后续版本使用同一个 ID。
3. **隐私政策**。项目内的 `src/privacy.html` 和 `src/privacy.css` 是可直接托管的版本。发布前用自己的站点托管并填写开发者联系方式，再把公开 HTTPS 地址填入商店表单。站点权限限于 B 站相关域名。扩展向 B 站发送用户选定的视频或列表标识，浏览器按站点 Cookie 设置附带登录会话。下载文件由浏览器保存在本机。
4. **更新版本**。更新 `package.json` 的版本号，重新构建并上传对应的新 ZIP。商店页面使用自己的发布者信息，注明这是独立扩展，并说明只保存用户有权下载的内容。

[Chrome 官方提交说明](https://developer.chrome.com/docs/webstore/publish) · [Firefox 官方提交说明](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/) · [Firefox 数据权限说明](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)

## 源码结构

| 路径 | 功能 |
| --- | --- |
| `src/dashboard.*` | 中文工作台、画质选择、队列 |
| `src/lib/bilibili.js` | B 站链接与列表解析、WBI 签名和播放流读取 |
| `src/lib/download.js`、`src/lib/mp4.js` | 媒体流下载、分片 MP4 合并、浏览器保存 |
| `src/lib/sites.js` | 站点范围和仅作用于扩展自身请求的来源规则 |
| `scripts/build.mjs` | 生成两个浏览器的 Manifest V3 和 ZIP |

## 许可证

本项目源码使用 [MIT 许可证](LICENSE)。
