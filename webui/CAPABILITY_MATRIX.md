# WebUI 能力矩阵

更新日期：2026-10-05（补充图像服务，其他能力维持原审计范围）

## Web 原生界面

| 能力 | 状态 | 实现 |
| --- | --- | --- |
| SRC/DST aligned 浏览 | 已完成 | 浏览真实 JPG、源文件名、DFL 元数据、多边形和已应用遮罩状态 |
| aligned 清洗 | 已完成 | 移入 `workspace/.webui/quarantine`，支持列表与恢复 |
| XSeg 多边形标注 | 已完成 | Web 中编辑 include/exclude，直接读写 DFL `SegIEPolys` |
| 奇智图像生成与编辑 | 已接入 | 本机加密 Key、明确素材确认、文生图/增强/参考合成/提示词编辑、任务查询、项目内结果归档及最终实扣；不调用本地 DFL 模型，不支持遮罩局部重绘 |
| SAEHD Trainer 预览与控制 | 已完成 | 5:2 实时预览；保存、备份、刷新和安全停止走源码桥 |
| 引导合成 | 已完成 | Web 表单控制 Merger 参数，不打开 Merger 窗口 |
| 终端监视器 | 已完成 | 多会话 ConPTY、CLI 输入、提示、持久日志和断线恢复 |
| 工作区管理 | 已完成 | 视频导入/归档、素材/模型/输出检查、结果播放 |
| GPU 与训练监控 | 已完成 | 利用率、显存、温度、功耗、速度和 ETA |
| 任务恢复 | 已完成 | 失败/失联任务按原命令、模式和参数重试 |
| 数据质量审计 | 已完成 | 有界扫描最多 500 张 aligned；显示清晰度、曝光、元数据、重复来源和姿态，并支持可恢复隔离；姿态图谱按各自占比比较 SRC / DST，标记训练关键缺口 |
| 提取覆盖复核 | 已完成 | 源帧叠加真实 `source_rect` 与 landmarks，列出对应 aligned 人脸，并标记漏提与多人脸帧 |
| 合成三联画复核 | 已完成 | 固定只读槽位展示 DST 原帧、merged 与 merged_mask，支持逐帧验收 |
| 视频时间线 | 已完成 | 浏览器播放工作区视频、显示媒体元数据，并接力固定裁切/抽帧/降噪命令 |
| 元数据与 PackedFaceset 预检 | 已完成 | 只读统计 DFL 字典覆盖和包头/样本/校验摘要；写操作仍走固定命令 |
| DFM 导出预检 | 已完成 | 识别受支持模型组、权重完整性、现有 DFM 与阻塞项，再接力对应固定导出命令 |

## 固定命令注册表

| 分组 | 命令 ID |
| --- | --- |
| 提取 | `src.extract_frames`、`src.extract_faces`、`dst.extract_frames`、`dst.extract_faces` |
| 排序 | `src.sort_faces`、`dst.sort_faces` |
| 数据集 | `src.landmarks_debug`、`src.faces_resize`、`src.faces_enhance`、`src.faces_pack`、`src.faces_unpack`、`src.recover_names`、`src.metadata_save`、`src.metadata_restore`；DST 对应 8 条 |
| XSeg | `xseg.train`、`xseg.apply_src`、`xseg.apply_dst`、`xseg.src_apply_builtin`、`xseg.src_remove_labels`、`xseg.src_remove_mask`、`xseg.src_fetch_labels`；DST 对应内置应用/移除标签/移除遮罩/获取标签 |
| 训练 | `train.saehd`、`train.me`、`train.q384`、`train.q512` |
| 合成 | `merge.saehd`、`merge.amp`、`merge.me`、`merge.q384`、`merge.q512` |
| DFM 导出 | `export.dfm_saehd`、`export.dfm_me`、`export.dfm_q384`、`export.dfm_q512` |
| 视频工具 | `video.cut_src`、`video.cut_dst`、`dst.denoise_frames` |
| 封装 | `encode.mp4`、`encode.mp4_lossless`、`encode.avi`、`encode.mov_lossless` |

注册表合计 53 条；XSeg 训练同时计入 XSeg 与训练语义，但只计一个命令 ID。

## Web 原生与安全接力边界

- Manual Extractor 的覆盖检查、检测框、landmarks 与候选人脸已经 Web 可视化；需要重新人工落点/重提时，仍由固定 Extractor 命令进入 DFL 原源码交互。
- Interactive Merger 的原帧/结果/遮罩验收和引导参数已经 Web 可视化；逐帧 GPU 参数实时重算仍由固定 Merger 路径承担。
- 不常用或版本特有的高级问答可以切换到 CLI 模式，在 Web 终端完成。
- 这些路径仍由固定 Python 入口启动，不会变成任意 Shell。

## 明确暂缓

- EBSynth、第三方 aligned 浏览器/角度工具及其他独立闭源 EXE。
- 外部窗口捕获、嵌入和自动操控。
- TensorFlow 到 PyTorch 的模型迁移。

暂缓项不会出现在可执行命令注册表中。`ExternalWindowAdapter` 只保留禁用接口，方便未来逐项整合。
