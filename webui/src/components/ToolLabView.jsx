import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowRight,
  IconCheck,
  IconCode,
  IconFileAnalytics,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
  IconRoute,
  IconTool,
} from "@tabler/icons-react";
import { runtimeApi } from "../runtime/api.js";
import { useI18n } from "../i18n.jsx";
import { buildPoseComparison } from "../domain/pose-comparison.js";
import { CommandRows } from "./OperationsView.jsx";
import {
  ExportPreflightPanel,
  MergeReviewPanel,
  MetadataPackPanel,
} from "./ToolWorkbenchPanels.jsx";
import {
  AlignmentRepairPanel,
  DatasetCleaningPanel,
  SegmentTimelinePanel,
} from "./AdvancedWorkbenchPanels.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";
import { ImageServiceWorkbench, IMAGE_TOOL_MODES } from "./ImageServiceWorkbench.jsx";

const QUALITY_LABELS = ["< 0.2", "0.2 – 0.4", "0.4 – 0.6", "0.6 – 0.8", "> 0.8"];
const SIDE_AWARE_TABS = new Set(["audit", "extract", "video", "metadata"]);

const MIGRATION_GROUPS = [
  {
    id: "shipped",
    label: "已 Web 化",
    rows: [
      {
        id: "xseg",
        name: "XSeg 多边形编辑器",
        source: "_internal/DeepFaceLab/XSegEditor/XSegEditor.py",
        interaction: "Canvas 多边形、顶点拖拽、include / exclude 与 JPG 原位保存",
        status: "已上线",
        priority: "完成",
        detail: "已直接读写 SegIEPolys，不依赖 PyQt 窗口，也保留可恢复的素材隔离路径。",
      },
      {
        id: "trainer",
        name: "Trainer 预览与控制",
        source: "_internal/DeepFaceLab_old/mainscripts/Trainer.py",
        interaction: "实时预览、损失曲线、保存、备份、刷新与安全停止",
        status: "已上线",
        priority: "完成",
        detail: "通过文件控制桥与真实训练进程通信，不模拟键盘输入或抓取外部窗口。",
      },
      {
        id: "facegrid",
        name: "FaceGrid 人脸姿态图谱",
        source: "_internal/facesets/UI/controls/facegrid.py",
        interaction: "Yaw × Pitch 分布、清晰度审查、样本回看与可恢复隔离",
        status: "本次新增",
        priority: "完成",
        detail: "复用原工具的 landmarks 姿态估计，将密集 PyQt 网格升级为可筛选、可审查的 Web 技术画布。",
      },
    ],
  },
  {
    id: "native-ui",
    label: "Web 复核 + 原工具接力",
    rows: [
      {
        id: "manual-extractor",
        name: "Manual Extractor",
        source: "_internal/DeepFaceLab/mainscripts/Extractor.py",
        interaction: "源帧覆盖、source_rect / landmarks、遗漏/多人脸筛选与逐帧步进",
        status: "复核已上线",
        priority: "桥接",
        detail: "Web 已可核对真实提取覆盖并定位遗漏；需要画框精修时由固定提取命令选择 manual 检测器，保留原快捷键窗口。",
      },
      {
        id: "interactive-merger",
        name: "Interactive Merger",
        source: "_internal/DeepFaceLab/merger/InteractiveMergerSubprocessor.py",
        interaction: "DST / merged / mask 三联帧同步步进、缺失检查与引导式合成接力",
        status: "复核已上线",
        priority: "桥接",
        detail: "Web 已完成真实产物逐帧验收；依赖模型常驻的逐参数实时重算仍由原交互合成器或引导式固定任务执行。",
      },
      {
        id: "faceset-preview",
        name: "Faceset 姿态格预览",
        source: "_internal/facesets/UI/Ui_previewUI.py",
        interaction: "姿态格样本对照、SRC/DST 数量差与清晰度分布",
        status: "已并入图谱",
        priority: "P1",
        detail: "原弹窗能力已被本次右侧检查器吸收；后续只需补充多选姿态的精确打包。",
      },
    ],
  },
  {
    id: "planned",
    label: "本次新增原生工具",
    rows: [
      {
        id: "sorter",
        name: "Sorter 清洗工作台",
        source: "_internal/DeepFaceLab/mainscripts/Sorter.py",
        interaction: "质量/曝光/姿态/元数据排序筛选、样本检查与可恢复隔离",
        status: "已上线",
        priority: "完成",
        detail: "Python 先生成非破坏式质量清单；Web 显示排序依据，确认后只进入现有可恢复隔离区，不执行原 Sorter 的批量重命名。",
      },
      {
        id: "videoed",
        name: "VideoEd 视频工具",
        source: "_internal/DeepFaceLab/mainscripts/VideoEd.py",
        interaction: "浏览器视频流、时长/分辨率/帧率检查与裁剪/抽帧/降噪接力",
        status: "已上线",
        priority: "完成",
        detail: "素材可直接在 Web 播放和预检；实际 VideoEd 与 ffmpeg 操作继续走固定参数任务。",
      },
      {
        id: "metadata-pack",
        name: "Metadata / PackedFaceset",
        source: "_internal/DeepFaceLab/mainscripts/Util.py · samplelib/PackedFaceset.py",
        interaction: "元数据覆盖/重复来源、PAK/ZIP 包头、样本数、摘要与异常",
        status: "已上线",
        priority: "完成",
        detail: "检查接口保持零写入；保存/恢复/打包/解包仍通过固定命令，执行前可看清当前状态。",
      },
      {
        id: "image-service",
        name: "图像生成与编辑",
        source: "webui/server/image-service-manager.mjs",
        interaction: "本机 Key、素材确认、异步生成与项目结果归档",
        status: "已接入",
        priority: "完成",
        detail: "共用奇智图像接口完成文生图、增强、参考图合成和提示词编辑；不支持遮罩局部重绘，也不调用本地 DFL 换脸模型。",
      },
      {
        id: "dfm-export",
        name: "模型导出预检",
        source: "_internal/DeepFaceLab/mainscripts/ExportDFM.py",
        interaction: "模型家族、data.dat、权重组件、已有 DFM 与阻塞项",
        status: "已上线",
        priority: "完成",
        detail: "先按实际模型文件完成就绪度检查，再开放与模型类型匹配的固定 DFM 导出命令。",
      },
    ],
  },
];

function formatAngle(value) {
  if (value === 0) return "0°";
  return `${value > 0 ? "+" : ""}${value}°`;
}

function emptyAtlas(side) {
  return {
    side,
    total: 0,
    validCount: 0,
    invalidCount: 0,
    lowQualityCount: 0,
    meanSharpness: 0,
    coverage: 0,
    lowQualityThreshold: 0.24,
    cells: [],
    yawTicks: [],
    pitchTicks: [],
  };
}

const COMPARISON_STATUS_COPY = {
  "missing-src": ["SRC 缺口", "DST 已有这个姿态，SRC 尚未覆盖；训练前优先补采。"],
  "src-deficit": ["SRC 偏少", "SRC 在该姿态的占比低于 DST，可能影响目标角度稳定性。"],
  balanced: ["分布接近", "两边在该姿态的占比接近。"],
  "src-surplus": ["SRC 余量", "SRC 覆盖高于 DST，通常不是阻塞项。"],
  "src-only": ["仅 SRC", "该姿态暂未出现在 DST，可作为覆盖余量保留。"],
  empty: ["无样本", "两边都没有这个姿态的样本。"],
};

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function fullestCell(cells, countOf) {
  let best = null;
  let bestCount = 0;
  for (const cell of cells) {
    const count = countOf(cell);
    if (count > bestCount) {
      best = cell;
      bestCount = count;
    }
  }
  return bestCount ? best : null;
}

function comparisonFocusCell(cells) {
  const actionable = cells.filter((cell) => (
    cell.status === "missing-src" || cell.status === "src-deficit"
  ));
  return fullestCell(actionable, (cell) => cell.dstCount)
    ?? fullestCell(cells, (cell) => cell.srcCount + cell.dstCount);
}

function PoseAtlas({ refreshVersion, focusCellId, focusNonce, onError, onNotice, onNavigateDataset, onOpenCommand }) {
  const { t } = useI18n();
  const [atlases, setAtlases] = useState(() => ({
    src: emptyAtlas("src"),
    dst: emptyAtlas("dst"),
  }));
  const [selectedId, setSelectedId] = useState(null);
  const [viewMode, setViewMode] = useState("compare");
  const [metric, setMetric] = useState("count");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [quarantineProgress, setQuarantineProgress] = useState(null);
  const requestVersion = useRef(0);
  const translationRef = useRef(t);

  useEffect(() => {
    translationRef.current = t;
  }, [t]);

  useEffect(() => () => {
    requestVersion.current += 1;
  }, []);

  const loadAtlas = useCallback(async () => {
    const request = requestVersion.current + 1;
    requestVersion.current = request;
    setLoading(true);
    setLoadError(null);
    const results = await Promise.allSettled([
      runtimeApi.alignedPoseAtlas("src"),
      runtimeApi.alignedPoseAtlas("dst"),
    ]);
    if (request !== requestVersion.current) return;

    const next = {
      src: results[0].status === "fulfilled" ? results[0].value : emptyAtlas("src"),
      dst: results[1].status === "fulfilled" ? results[1].value : emptyAtlas("dst"),
    };
    const failedSides = results.flatMap((result, index) => (
      result.status === "rejected" ? [index === 0 ? "SRC" : "DST"] : []
    ));
    const firstFailure = results.find((result) => result.status === "rejected");
    if (failedSides.length) {
      const error = new Error(translationRef.current("{sides} 姿态分析失败，已保留可用数据。", {
        sides: failedSides.join(" / "),
      }));
      error.cause = firstFailure?.reason;
      setLoadError(error);
      onError(error);
    }
    setAtlases(next);
    const nextComparison = buildPoseComparison(next.src, next.dst);
    setSelectedId((current) => {
      if (current && nextComparison.cells.some((cell) => (
        cell.id === current && (cell.srcCount || cell.dstCount)
      ))) return current;
      return comparisonFocusCell(nextComparison.cells)?.id ?? null;
    });
    setLoading(false);
  }, [onError]);

  useEffect(() => {
    void loadAtlas();
  }, [loadAtlas, localRefresh, refreshVersion]);

  const comparison = useMemo(
    () => buildPoseComparison(atlases.src, atlases.dst),
    [atlases.dst, atlases.src],
  );
  useEffect(() => {
    if (!focusCellId || !focusNonce) return;
    if (comparison.cells.some((cell) => cell.id === focusCellId)) {
      setSelectedId(focusCellId);
      setViewMode("compare");
    }
  }, [comparison.cells, focusCellId, focusNonce]);
  const activeSide = viewMode === "dst" ? "dst" : "src";
  const atlas = atlases[activeSide];
  const selected = atlas.cells.find((cell) => cell.id === selectedId) ?? null;
  const selectedComparison = comparison.cells.find((cell) => cell.id === selectedId) ?? null;
  const maxCount = useMemo(
    () => Math.max(1, ...atlas.cells.map((cell) => cell.count)),
    [atlas.cells],
  );
  const visibleLowQuality = selected?.samples.filter(
    (sample) => sample.sharpness < atlas.lowQualityThreshold,
  ) ?? [];

  const quarantineVisible = async () => {
    if (!visibleLowQuality.length) return;
    const confirmed = window.confirm(t(
      "将当前姿态格中的 {count} 张低清晰度样本移入可恢复隔离区吗？",
      { count: visibleLowQuality.length },
    ));
    if (!confirmed) return;
    setQuarantineProgress({ completed: 0, total: visibleLowQuality.length });
    try {
      for (const [index, sample] of visibleLowQuality.entries()) {
        await runtimeApi.quarantineAligned(activeSide, sample.name);
        setQuarantineProgress({ completed: index + 1, total: visibleLowQuality.length });
      }
      onNotice(t("已隔离 {count} 张低清晰度样本，可在数据集页面恢复", {
        count: visibleLowQuality.length,
      }));
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      onError(error);
    } finally {
      setQuarantineProgress(null);
    }
  };

  const changeViewMode = (nextMode) => {
    setViewMode(nextMode);
    const nextCells = nextMode === "compare" ? comparison.cells : atlases[nextMode].cells;
    const countOf = nextMode === "compare"
      ? (cell) => cell.srcCount + cell.dstCount
      : (cell) => cell.count;
    setSelectedId((current) => {
      if (current && nextCells.some((cell) => cell.id === current && countOf(cell))) return current;
      return (nextMode === "compare"
        ? comparisonFocusCell(nextCells)
        : fullestCell(nextCells, countOf))?.id ?? null;
    });
  };

  if (loading && !atlases.src.cells.length && !atlases.dst.cells.length) {
    return (
      <div className="pose-atlas-state">
        <LoadingProgress
          inline
          label={t("正在并行分析 SRC / DST aligned landmarks…")}
          detail={t("两边姿态与清晰度都在本地 Python 运行时计算")}
        />
      </div>
    );
  }

  if (loadError && !atlases.src.cells.length && !atlases.dst.cells.length) {
    return (
      <div className="pose-atlas-state is-error">
        <IconAlertTriangle size={28} />
        <strong>{t("姿态分析未完成")}</strong>
        <span>{t(loadError.message)}</span>
        <button className="button secondary" type="button" onClick={() => setLocalRefresh((value) => value + 1)}>
          <IconRefresh size={15} />{t("重试分析")}
        </button>
      </div>
    );
  }

  if (!comparison.srcTotal && !comparison.dstTotal) {
    return (
      <div className="pose-atlas-state">
        <IconPhoto size={28} />
        <strong>{t("还没有可比较的 aligned 人脸")}</strong>
        <span>{t("先完成 SRC 与 DST 人脸提取，再回到这里检查姿态匹配。")}</span>
        <button className="button primary" type="button" onClick={() => onOpenCommand("src.extract_faces")}>
          <IconPlayerPlay size={15} />{t("打开 SRC 人脸提取")}
        </button>
      </div>
    );
  }

  const selectedStatus = selectedComparison
    ? COMPARISON_STATUS_COPY[selectedComparison.status]
    : COMPARISON_STATUS_COPY.empty;
  const partialSide = !comparison.srcTotal ? "SRC" : !comparison.dstTotal ? "DST" : null;

  return (
    <div className="pose-atlas-layout">
      {quarantineProgress ? (
        <LoadingProgress
          compact
          tone="amber"
          label={t("正在隔离低清晰度样本…")}
          detail={t("已处理 {completed} / {total} 张", quarantineProgress)}
          value={(quarantineProgress.completed / quarantineProgress.total) * 100}
          current={quarantineProgress.completed}
          total={quarantineProgress.total}
          operationKey="pose-atlas-quarantine"
        />
      ) : loading ? (
        <LoadingProgress inline compact label={t("正在刷新姿态地图…")} detail={t("现有分析结果保持可见")} operationKey="pose-atlas-refresh" />
      ) : null}
      <section className="pose-atlas-main" aria-label={t("人脸姿态分布") }>
        <div className="pose-metrics">
          {viewMode === "compare" ? (
            <>
              <div><span>{t("SRC 人脸")}</span><strong>{comparison.srcTotal.toLocaleString()}</strong></div>
              <div><span>{t("DST 人脸")}</span><strong>{comparison.dstTotal.toLocaleString()}</strong></div>
              <div className={comparison.matchScore < 0.8 ? "is-warning" : ""}>
                <span>{t("姿态匹配")}</span><strong>{percent(comparison.matchScore)}</strong>
              </div>
              <div className={comparison.gapCount ? "is-warning" : ""}>
                <span>{t("关键缺口")}</span><strong>{comparison.gapCount}</strong>
              </div>
            </>
          ) : (
            <>
              <div><span>{t("有效人脸")}</span><strong>{atlas.validCount.toLocaleString()}</strong></div>
              <div><span>{t("姿态覆盖")}</span><strong>{percent(atlas.coverage)}</strong></div>
              <div className={atlas.lowQualityCount ? "is-warning" : ""}>
                <span>{t("待审素材")}</span><strong>{atlas.lowQualityCount.toLocaleString()}</strong>
              </div>
              <div><span>{t("平均清晰度")}</span><strong>{atlas.meanSharpness.toFixed(3)}</strong></div>
            </>
          )}
          <div className="pose-toolbar-controls">
            <div className="pose-view-toggle" role="group" aria-label={t("姿态图谱视图") }>
              {[
                ["compare", t("对比")],
                ["src", "SRC"],
                ["dst", "DST"],
              ].map(([value, label]) => (
                <button
                  className={viewMode === value ? "is-active" : ""}
                  key={value}
                  type="button"
                  aria-pressed={viewMode === value}
                  onClick={() => changeViewMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {viewMode !== "compare" ? (
              <div className="pose-metric-toggle" role="group" aria-label={t("图谱指标") }>
                <button className={metric === "count" ? "is-active" : ""} type="button" aria-pressed={metric === "count"} onClick={() => setMetric("count")}>{t("数量")}</button>
                <button className={metric === "quality" ? "is-active" : ""} type="button" aria-pressed={metric === "quality"} onClick={() => setMetric("quality")}>{t("清晰度")}</button>
              </div>
            ) : null}
          </div>
        </div>

        {partialSide ? (
          <div className="pose-compare-callout" role="status">
            <IconAlertTriangle size={15} />
            <span>{t("{side} 尚无 aligned 人脸，当前只能查看单侧分布。", { side: partialSide })}</span>
            <button type="button" onClick={() => onOpenCommand(`${partialSide.toLowerCase()}.extract_faces`)}>{t("打开提取")}</button>
          </div>
        ) : null}
        {loadError ? (
          <div className="pose-compare-callout" role="status">
            <IconAlertTriangle size={15} />
            <span>{loadError.message}</span>
            <button type="button" onClick={() => setLocalRefresh((value) => value + 1)}>{t("重试分析")}</button>
          </div>
        ) : null}

        <div className="pose-chart-heading">
          <span>{viewMode === "compare" ? t("SRC / DST 姿态占比差") : `${viewMode.toUpperCase()} · ${t("左右角 Yaw")}`}</span>
          <small>{viewMode === "compare" ? t("点击格子查看两边样本与占比") : t("点击格子检查该姿态的低清晰度样本")}</small>
        </div>
        <div className="pose-matrix">
          <div className="pose-pitch-title">{t("俯仰角 Pitch")}</div>
          <div className="pose-matrix-content">
            <div className="pose-yaw-labels" style={{ gridTemplateColumns: `repeat(${atlases.src.yawTicks.length || atlases.dst.yawTicks.length}, minmax(34px, 1fr))` }}>
              {(atlases.src.yawTicks.length ? atlases.src.yawTicks : atlases.dst.yawTicks).map((yaw) => <span key={yaw}>{formatAngle(yaw)}</span>)}
            </div>
            <div className="pose-matrix-body">
              <div className="pose-pitch-labels" style={{ gridTemplateRows: `repeat(${atlases.src.pitchTicks.length || atlases.dst.pitchTicks.length}, minmax(31px, 1fr))` }}>
                {(atlases.src.pitchTicks.length ? atlases.src.pitchTicks : atlases.dst.pitchTicks).map((pitch) => <span key={pitch}>{formatAngle(pitch)}</span>)}
              </div>
              <div
                className="pose-cells"
                style={{
                  gridTemplateColumns: `repeat(${atlases.src.yawTicks.length || atlases.dst.yawTicks.length}, minmax(34px, 1fr))`,
                  gridTemplateRows: `repeat(${atlases.src.pitchTicks.length || atlases.dst.pitchTicks.length}, minmax(31px, 1fr))`,
                }}
              >
                {(viewMode === "compare" ? comparison.cells : atlas.cells).map((cell) => {
                  if (viewMode === "compare") {
                    const statusCopy = COMPARISON_STATUS_COPY[cell.status];
                    return (
                      <button
                        className={`pose-cell is-comparison is-${cell.status} ${selectedId === cell.id ? "is-selected" : ""}`}
                        key={cell.id}
                        type="button"
                        aria-label={t("Yaw {yaw}，Pitch {pitch}，SRC {src} 张，DST {dst} 张，{status}", {
                          yaw: formatAngle(cell.yaw),
                          pitch: formatAngle(cell.pitch),
                          src: cell.srcCount,
                          dst: cell.dstCount,
                          status: t(statusCopy[0]),
                        })}
                        aria-pressed={selectedId === cell.id}
                        disabled={!cell.srcCount && !cell.dstCount}
                        onClick={() => setSelectedId(cell.id)}
                        style={{ "--pose-level": cell.level.toFixed(3) }}
                      >
                        <span>{cell.srcCount}</span><i>/</i><span>{cell.dstCount}</span>
                      </button>
                    );
                  }
                  const level = metric === "quality"
                    ? cell.meanSharpness
                    : Math.log1p(cell.count) / Math.log1p(maxCount);
                  const isRelevantGap = !cell.count && Math.abs(cell.yaw) <= 60 && Math.abs(cell.pitch) <= 45;
                  return (
                    <button
                      className={`pose-cell ${selectedId === cell.id ? "is-selected" : ""} ${isRelevantGap ? "is-gap" : ""} ${cell.lowQualityCount ? "has-low-quality" : ""}`}
                      key={cell.id}
                      type="button"
                      aria-label={t("Yaw {yaw}，Pitch {pitch}，{count} 张", {
                        yaw: formatAngle(cell.yaw),
                        pitch: formatAngle(cell.pitch),
                        count: cell.count,
                      })}
                      aria-pressed={selectedId === cell.id}
                      disabled={!cell.count}
                      onClick={() => setSelectedId(cell.id)}
                      style={{ "--pose-level": level.toFixed(3) }}
                    >
                      {metric === "quality" && cell.count
                        ? `${Math.round(cell.meanSharpness * 100)}%`
                        : cell.count.toLocaleString()}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="pose-legend">
          {viewMode === "compare" ? (
            <>
              <span className="is-deficit"><i />{t("SRC 缺口 / 偏少")}</span>
              <span className="is-balanced"><i />{t("分布接近")}</span>
              <span className="is-surplus"><i />{t("SRC 余量")}</span>
              <small>{t("按各自数据集的姿态占比比较，格内为 SRC / DST 原始数量")}</small>
            </>
          ) : (
            <>
              <span><i style={{ "--legend-level": 0.18 }} />{t("稀少")}</span>
              <span><i style={{ "--legend-level": 0.48 }} />{t("适中")}</span>
              <span><i style={{ "--legend-level": 0.9 }} />{t("密集")}</span>
              <span className="is-gap"><i />{t("覆盖缺口")}</span>
              <small>{t("分析基于 DFL landmarks；清晰度为 Laplacian 方差归一化结果")}</small>
            </>
          )}
        </div>
      </section>

      <aside className="pose-inspector" aria-label={t("已选姿态检查器") }>
        <header>
          <div>
            <span>{t("已选姿态")}</span>
            <strong>{selectedComparison ? `Yaw ${formatAngle(selectedComparison.yaw)} · Pitch ${formatAngle(selectedComparison.pitch)}` : t("未选择")}</strong>
          </div>
          <span>{viewMode === "compare" && selectedComparison ? t(selectedStatus[0]) : selected?.count ?? 0}</span>
        </header>

        {viewMode === "compare" && selectedComparison ? (
          <>
            <div className="pose-compare-summary" aria-label={t("SRC / DST 姿态占比") }>
              {[
                ["SRC", selectedComparison.srcCount, selectedComparison.srcShare],
                ["DST", selectedComparison.dstCount, selectedComparison.dstShare],
              ].map(([label, count, share]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{count.toLocaleString()}</strong>
                  <small>{percent(share)}</small>
                  <i><b style={{ width: percent(Math.min(1, share * 8)) }} /></i>
                </div>
              ))}
            </div>
            <p className={`pose-compare-note is-${selectedComparison.status}`}>{t(selectedStatus[1])}</p>
            <section className="pose-compare-samples">
              {[
                ["src", selectedComparison.src],
                ["dst", selectedComparison.dst],
              ].map(([sampleSide, cell]) => (
                <div key={sampleSide}>
                  <header><h3>{sampleSide.toUpperCase()} {t("样本")}</h3><span>{cell?.count ?? 0}</span></header>
                  <div>
                    {cell?.samples?.length ? cell.samples.slice(0, 3).map((sample) => (
                      <button key={sample.name} type="button" title={sample.sourceFilename ?? sample.name} onClick={() => onNavigateDataset(sampleSide, sample)}>
                        <img src={sample.imageUrl} alt="" loading="lazy" decoding="async" />
                        <span>{sample.sharpness.toFixed(2)}</span>
                      </button>
                    )) : <span className="pose-sample-empty">{t("该姿态暂无样本")}</span>}
                  </div>
                </div>
              ))}
            </section>
            <div className="pose-inspector-actions">
              <button type="button" onClick={() => onNavigateDataset("src", selectedComparison.src?.samples?.[0])}>
                <IconPhoto size={15} /><span>{t("检查 SRC 数据集")}</span><IconArrowRight size={14} />
              </button>
              <button type="button" onClick={() => onNavigateDataset("dst", selectedComparison.dst?.samples?.[0])}>
                <IconPhoto size={15} /><span>{t("检查 DST 数据集")}</span><IconArrowRight size={14} />
              </button>
            </div>
          </>
        ) : selected ? (
          <>
            <div className="pose-inspector-summary">
              <div><span>{t("平均清晰度")}</span><strong>{selected.meanSharpness.toFixed(3)}</strong></div>
              <div><span>{t("平均亮度")}</span><strong>{selected.meanBrightness.toFixed(3)}</strong></div>
            </div>
            <section className="pose-samples">
              <h3>{t("低清晰度优先样本")}</h3>
              <div>
                {selected.samples.slice(0, 6).map((sample) => (
                  <button key={sample.name} type="button" title={sample.sourceFilename ?? sample.name} onClick={() => onNavigateDataset(activeSide, sample)}>
                    <img src={sample.imageUrl} alt="" loading="lazy" decoding="async" />
                    <span>{sample.sharpness.toFixed(2)}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="quality-distribution">
              <h3>{t("清晰度分布")}</h3>
              {selected.qualityBands.map((count, index) => (
                <div key={QUALITY_LABELS[index]}>
                  <span>{QUALITY_LABELS[index]}</span>
                  <i><b style={{ width: `${selected.count ? (count / selected.count) * 100 : 0}%` }} /></i>
                  <small>{count}</small>
                </div>
              ))}
            </section>
            <div className="pose-inspector-actions">
              <button type="button" onClick={() => onNavigateDataset(activeSide, selected.samples[0])} disabled={!selected.samples.length}>
                <IconPhoto size={15} /><span>{t("在数据集浏览器中查看")}</span><IconArrowRight size={14} />
              </button>
              <button className="is-warning" type="button" onClick={() => void quarantineVisible()} disabled={!visibleLowQuality.length || Boolean(quarantineProgress)}>
                <IconArchive size={15} /><span>{t("隔离可见低质样本")}</span><small>{visibleLowQuality.length}</small>
              </button>
              <button type="button" onClick={() => onOpenCommand(`${activeSide}.faces_pack`)}>
                <IconCode size={15} /><span>{t("打开整库打包命令")}</span><IconArrowRight size={14} />
              </button>
            </div>
          </>
        ) : (
          <div className="pose-inspector-empty"><IconRoute size={26} />{t("选择一个有素材的姿态格")}</div>
        )}
      </aside>
    </div>
  );
}

function MigrationMap() {
  const { t } = useI18n();
  const allRows = MIGRATION_GROUPS.flatMap((group) => group.rows);
  const [selectedId, setSelectedId] = useState("manual-extractor");
  const selected = allRows.find((row) => row.id === selectedId) ?? allRows[0];
  return (
    <div className="migration-layout">
      <section className="migration-table-wrap">
        {MIGRATION_GROUPS.map((group) => (
          <section className="migration-group" key={group.id}>
            <header><h3>{t(group.label)}</h3><span>{group.rows.length}</span></header>
            <div className="migration-table" role="table" aria-label={t(group.label)}>
              {group.rows.map((row) => (
                <button
                  className={selectedId === row.id ? "is-selected" : ""}
                  key={row.id}
                  type="button"
                  role="row"
                  onClick={() => setSelectedId(row.id)}
                >
                  <span className="migration-name" role="cell"><strong>{t(row.name)}</strong><small>{row.source}</small></span>
                  <span className="migration-interaction" role="cell">{t(row.interaction)}</span>
                  <span className={`migration-status is-${group.id}`} role="cell">{t(row.status)}</span>
                  <span className="migration-priority" role="cell">{row.priority}</span>
                  <IconArrowRight size={15} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </section>
      <aside className="migration-detail">
        <IconTool size={22} />
        <h3>{t(selected.name)}</h3>
        <p>{t(selected.detail)}</p>
        <dl>
          <div><dt>{t("Python 来源")}</dt><dd>{selected.source}</dd></div>
          <div><dt>{t("Web 交互")}</dt><dd>{t(selected.interaction)}</dd></div>
          <div><dt>{t("优先级")}</dt><dd>{selected.priority}</dd></div>
        </dl>
        <div className="migration-principle">
          <IconCheck size={16} />
          <span>{t("所有执行仍通过固定命令或专用本地 API，不开放任意 Shell。")}</span>
        </div>
      </aside>
    </div>
  );
}

function normalizeImageToolId(toolId) {
  if (toolId === "enhance") return "clarity";
  if (toolId === "single-merge") return "single-frame";
  return IMAGE_TOOL_MODES.some((tool) => tool.id === toolId) ? toolId : "clarity";
}

export function ToolLabView({ commands, workspaceKey, onOpenCommand, onError, onNotice, onNavigateDataset, poseFocus, toolFocus }) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState("audit");
  const [activeImageTool, setActiveImageTool] = useState("clarity");
  const [side, setSide] = useState("src");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const toolCommands = commands.filter((command) => (
    ["video", "dataset", "sort", "mask"].includes(command.category)
  ));

  useEffect(() => {
    if (poseFocus?.cellId) setActiveTab("atlas");
  }, [poseFocus?.cellId, poseFocus?.nonce]);

  useEffect(() => {
    if (!toolFocus?.toolId) return;
    setActiveTab("image-tools");
    setActiveImageTool(normalizeImageToolId(toolFocus.toolId));
    if (["src", "dst"].includes(toolFocus.side)) setSide(toolFocus.side);
  }, [toolFocus?.nonce, toolFocus?.side, toolFocus?.toolId]);

  return (
    <section className="tool-lab-view">
      <nav className="tool-lab-tabs" aria-label={t("工具实验室视图") }>
        <button className={activeTab === "audit" ? "is-active" : ""} type="button" onClick={() => setActiveTab("audit")}>
          <IconFileAnalytics size={16} />{t("数据审计")}
        </button>
        <button className={activeTab === "extract" ? "is-active" : ""} type="button" onClick={() => setActiveTab("extract")}>
          <IconPhoto size={16} />{t("提取复核")}
        </button>
        <button className={activeTab === "merge" ? "is-active" : ""} type="button" onClick={() => setActiveTab("merge")}>
          <IconRoute size={16} />{t("合成复核")}
        </button>
        <button className={activeTab === "video" ? "is-active" : ""} type="button" onClick={() => setActiveTab("video")}>
          <IconPlayerPlay size={16} />{t("视频时间线")}
        </button>
        <button className={activeTab === "metadata" ? "is-active" : ""} type="button" onClick={() => setActiveTab("metadata")}>
          <IconArchive size={16} />{t("元数据与打包")}
        </button>
        <button className={activeTab === "export" ? "is-active" : ""} type="button" onClick={() => setActiveTab("export")}>
          <IconCode size={16} />{t("模型导出")}
        </button>
        <button className={activeTab === "atlas" ? "is-active" : ""} type="button" onClick={() => setActiveTab("atlas")}>
          <IconTool size={16} />{t("姿态图谱")}
        </button>
        <button className={activeTab === "image-tools" ? "is-active" : ""} type="button" onClick={() => setActiveTab("image-tools")}>
          <IconPhoto size={16} />{t("图像工具")}
        </button>
        <button className={activeTab === "migration" ? "is-active" : ""} type="button" onClick={() => setActiveTab("migration")}>
          <IconCheck size={16} />{t("覆盖清单")}
        </button>
        <button className={activeTab === "commands" ? "is-active" : ""} type="button" onClick={() => setActiveTab("commands")}>
          <IconCode size={16} />{t("命令目录")}
        </button>
        {!["commands", "migration", "image-tools"].includes(activeTab) && (
          <div className="tool-lab-actions">
            {SIDE_AWARE_TABS.has(activeTab) && (
              <div className="side-switch" role="group" aria-label={t("数据集") }>
                {["src", "dst"].map((value) => (
                  <button className={side === value ? "is-active" : ""} key={value} type="button" onClick={() => setSide(value)}>
                    {value.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            <button className="button primary" type="button" onClick={() => setRefreshVersion((value) => value + 1)}>
              <IconRefresh size={15} />{t("刷新分析")}
            </button>
          </div>
        )}
      </nav>

      <div className="tool-lab-content">
        {activeTab === "audit" ? (
          <DatasetCleaningPanel
            side={side}
            refreshVersion={refreshVersion}
            onError={onError}
            onNotice={onNotice}
            onNavigateDataset={onNavigateDataset}
            onOpenCommand={onOpenCommand}
          />
        ) : activeTab === "extract" ? (
          <AlignmentRepairPanel side={side} refreshVersion={refreshVersion} onError={onError} onNotice={onNotice} onOpenCommand={onOpenCommand} />
        ) : activeTab === "merge" ? (
          <MergeReviewPanel refreshVersion={refreshVersion} onError={onError} onOpenCommand={onOpenCommand} />
        ) : activeTab === "video" ? (
          <SegmentTimelinePanel side={side} refreshVersion={refreshVersion} onError={onError} onNotice={onNotice} onOpenCommand={onOpenCommand} />
        ) : activeTab === "metadata" ? (
          <MetadataPackPanel side={side} refreshVersion={refreshVersion} onError={onError} onOpenCommand={onOpenCommand} />
        ) : activeTab === "export" ? (
          <ExportPreflightPanel refreshVersion={refreshVersion} onError={onError} onOpenCommand={onOpenCommand} />
        ) : activeTab === "atlas" ? (
          <PoseAtlas
            refreshVersion={refreshVersion}
            focusCellId={poseFocus?.cellId}
            focusNonce={poseFocus?.nonce}
            onError={onError}
            onNotice={onNotice}
            onNavigateDataset={onNavigateDataset}
            onOpenCommand={onOpenCommand}
          />
        ) : activeTab === "image-tools" ? (
          <ImageServiceWorkbench
            key={workspaceKey}
            workspaceKey={workspaceKey}
            onError={onError}
            onNotice={onNotice}
            activeTool={activeImageTool}
            onToolChange={setActiveImageTool}
            side={side}
            toolFocus={toolFocus}
          />
        ) : activeTab === "migration" ? (
          <MigrationMap />
        ) : (
          <div className="tool-command-catalog">
            <header>
              <div><h3>{t("固定白名单工具")}</h3><p>{t("运行时不会读取 BAT；每个入口都由服务端固定 executable 与参数边界。")}</p></div>
              <span>{t("{count} 个命令", { count: toolCommands.length })}</span>
            </header>
            <CommandRows commands={toolCommands} onOpenCommand={onOpenCommand} />
          </div>
        )}
      </div>
    </section>
  );
}
