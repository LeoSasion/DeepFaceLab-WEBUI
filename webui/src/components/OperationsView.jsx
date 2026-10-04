import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowLeft,
  IconArrowRight,
  IconBoxModel2,
  IconCheck,
  IconClipboard,
  IconCopy,
  IconDeviceFloppy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconHelpCircle,
  IconMinus,
  IconPhoto,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconRotateClockwise,
  IconShieldCheck,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { runtimeApi } from "../runtime/api.js";
import { useI18n } from "../i18n.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";

const categoryLabels = {
  dataset: "数据集工具",
  encode: "视频封装",
  extract: "提取",
  mask: "XSeg 遮罩",
  merge: "模型应用",
  model: "模型导出",
  sort: "排序清洗",
  training: "模型训练",
  video: "视频处理",
};

const terminalStates = new Set(["succeeded", "failed", "cancelled", "orphaned"]);
const thumbnailMinWidths = [72, 88, 108, 132];
const datasetPageSize = 200;
const emptyDatasetCollection = (side) => ({ side, total: 0, offset: 0, limit: datasetPageSize, items: [] });
const datasetAssetKey = (item) => (item?.token ? `${item.token}:${item.name}` : item?.name ?? "");
const landmarkSegments = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  [17, 18, 19, 20, 21],
  [22, 23, 24, 25, 26],
  [27, 28, 29, 30],
  [30, 31, 32, 33, 34, 35],
  [36, 37, 38, 39, 40, 41, 36],
  [42, 43, 44, 45, 46, 47, 42],
  [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 48],
  [60, 61, 62, 63, 64, 65, 66, 67, 60],
];

function profileLabel(profile) {
  return profile === "legacy" ? "DFL legacy" : "DFL current";
}

export function CommandRows({ commands, onOpenCommand }) {
  const { t } = useI18n();
  const groups = useMemo(() => {
    const result = new Map();
    for (const command of commands) {
      const key = command.category ?? "other";
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(command);
    }
    return [...result.entries()];
  }, [commands]);

  if (!commands.length) {
    return <div className="operation-empty">{t("当前分区没有可运行的源码命令。")}</div>;
  }

  return (
    <div className="command-groups">
      {groups.map(([category, items]) => (
        <section className="command-group" key={category}>
          <header>
            <h3>{t(categoryLabels[category] ?? category)}</h3>
            <span>{t("{count} 项", { count: items.length })}</span>
          </header>
          <div className="command-rows">
            {items.map((command) => (
              <button
                className="command-row"
                key={command.id}
                type="button"
                onClick={() => onOpenCommand(command.id)}
              >
                <span className="command-row-state"><IconPlayerPlay size={15} /></span>
                <span className="command-row-copy">
                  <strong>{command.label}</strong>
                  <small>{command.description}</small>
                </span>
                <span className="command-row-meta">
                  <span>{profileLabel(command.profile)}</span>
                  <span>{t("{count} 个参数", { count: command.parameters?.length ?? 0 })}</span>
                </span>
                <IconArrowRight size={17} />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function CommandCenterView({
  title,
  description,
  commands,
  filter,
  onOpenCommand,
  aside,
}) {
  const { t } = useI18n();
  const visibleCommands = useMemo(
    () => commands.filter(filter),
    [commands, filter],
  );
  return (
    <section className="operation-view">
      <header className="operation-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="operation-count">{t("{count} 个已接入功能", { count: visibleCommands.length })}</span>
      </header>
      <div className={`operation-layout ${aside ? "has-aside" : ""}`}>
        <CommandRows commands={visibleCommands} onOpenCommand={onOpenCommand} />
        {aside}
      </div>
    </section>
  );
}

function imagePoint(svg, event, width, height) {
  const rect = svg.getBoundingClientRect();
  return [
    Math.max(0, Math.min(width, ((event.clientX - rect.left) / rect.width) * width)),
    Math.max(0, Math.min(height, ((event.clientY - rect.top) / rect.height) * height)),
  ];
}

function AnnotationCanvas({
  side,
  item,
  annotation,
  clipboard,
  locked = false,
  onClipboardChange,
  onNavigate,
  onLoadPrevious,
  onDirtyChange,
  onSaved,
  onError,
}) {
  const { t } = useI18n();
  const svgRef = useRef(null);
  const pointInstructionsId = useId();
  const [polygons, setPolygons] = useState([]);
  const [draft, setDraft] = useState([]);
  const [polygonType, setPolygonType] = useState("include");
  const [saving, setSaving] = useState(false);
  const [loadingPrevious, setLoadingPrevious] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [pointAnnouncement, setPointAnnouncement] = useState("");
  const [showAppliedMask, setShowAppliedMask] = useState(true);
  const baselineRef = useRef("[]");
  const saveInFlightRef = useRef(false);
  const editorBusy = locked || saving || loadingPrevious;
  const hasUnsavedChanges = JSON.stringify(polygons) !== baselineRef.current || draft.length > 0;

  useEffect(() => {
    const nextPolygons = annotation?.polygons ?? [];
    setPolygons(nextPolygons);
    baselineRef.current = JSON.stringify(nextPolygons);
    onDirtyChange(false);
    setDraft([]);
    setDragging(null);
    setSelectedPoint(null);
  }, [annotation, onDirtyChange]);

  useEffect(() => {
    onDirtyChange(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!annotation) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      const key = event.key.toLocaleLowerCase();
      if (event.ctrlKey && key === "s") { event.preventDefault(); void save(); return; }
      if (event.ctrlKey && key === "c") { event.preventDefault(); copyPolygons(); return; }
      if (editorBusy) return;
      if (event.ctrlKey && key === "v") { event.preventDefault(); pastePolygons(); return; }
      if (key === "q") setPolygonType("include");
      else if (key === "w") setPolygonType("exclude");
      else if (key === "g") importSuggested();
      else if (event.key === "ArrowLeft") onNavigate(-1);
      else if (event.key === "ArrowRight") onNavigate(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  if (!annotation) {
    return (
      <div className="asset-detail-loading">
        <LoadingProgress
          tone="violet"
          label={t("正在读取 DFL 标注元数据…")}
          detail={t("正在加载多边形、应用遮罩与建议轮廓")}
        />
      </div>
    );
  }

  const addPoint = (event) => {
    if (editorBusy || dragging || event.button !== 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    setDraft((current) => [
      ...current,
      imagePoint(svg, event, annotation.width, annotation.height),
    ]);
  };

  const finishPolygon = () => {
    if (editorBusy) return;
    if (draft.length < 3) {
      onError(new Error(t("至少需要 3 个点才能闭合多边形")));
      return;
    }
    setPolygons((current) => [...current, { type: polygonType, points: draft }]);
    setDraft([]);
  };

  const movePoint = (event) => {
    if (editorBusy || !dragging || !svgRef.current) return;
    const point = imagePoint(svgRef.current, event, annotation.width, annotation.height);
    setPolygons((current) => current.map((polygon, polygonIndex) => (
      polygonIndex !== dragging.polygonIndex
        ? polygon
        : {
          ...polygon,
          points: polygon.points.map((candidate, pointIndex) => (
            pointIndex === dragging.pointIndex ? point : candidate
          )),
        }
    )));
  };

  const save = async () => {
    if (editorBusy || saveInFlightRef.current) return;
    if (draft.length > 0) {
      onError(new Error(t("请先闭合当前多边形再保存")));
      return;
    }
    const submittedPolygons = structuredClone(polygons);
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const result = await runtimeApi.saveAlignedAnnotation(side, item.name, submittedPolygons);
      baselineRef.current = JSON.stringify(submittedPolygons);
      onDirtyChange(false);
      onSaved(result);
    } catch (error) {
      onError(error);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const copyPolygons = () => {
    onClipboardChange(structuredClone(polygons));
  };

  const pastePolygons = () => {
    if (!editorBusy && Array.isArray(clipboard) && clipboard.length) setPolygons(structuredClone(clipboard));
  };

  const inheritPrevious = async () => {
    if (editorBusy) return;
    setLoadingPrevious(true);
    try {
      const previous = await onLoadPrevious();
      if (previous?.polygons?.length) setPolygons(structuredClone(previous.polygons));
      else onError(new Error(t("上一张没有可继承的多边形标注")));
    } catch (error) {
      onError(error);
    } finally {
      setLoadingPrevious(false);
    }
  };

  const importSuggested = () => {
    if (editorBusy || !annotation.suggestedPolygons?.length) return;
    setPolygons(structuredClone(annotation.suggestedPolygons));
  };

  const colors = {
    include: { stroke: "#42d89a", fill: "rgba(52, 211, 153, 0.22)" },
    exclude: { stroke: "#ff7a7a", fill: "rgba(255, 92, 92, 0.18)" },
  };

  const pointName = (selection) => selection?.kind === "draft"
    ? t("待闭合点 {point}", { point: selection.pointIndex + 1 })
    : t("多边形 {polygon} 的点 {point}", {
      polygon: selection.polygonIndex + 1,
      point: selection.pointIndex + 1,
    });

  const selectPoint = (selection) => {
    setSelectedPoint(selection);
    setPointAnnouncement(t("已选择 {name}；方向键微调，Delete 删除", { name: pointName(selection) }));
  };

  const nudgePoint = (selection, dx, dy) => {
    if (editorBusy || !selection) return;
    const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
    if (selection.kind === "draft") {
      const current = draft[selection.pointIndex];
      if (!current) return;
      const next = [clamp(current[0] + dx, annotation.width), clamp(current[1] + dy, annotation.height)];
      setDraft((points) => points.map((point, index) => index === selection.pointIndex ? next : point));
      setPointAnnouncement(t("{name} 已移动到 X {x}，Y {y}", {
        name: pointName(selection), x: Math.round(next[0]), y: Math.round(next[1]),
      }));
      return;
    }
    const current = polygons[selection.polygonIndex]?.points?.[selection.pointIndex];
    if (!current) return;
    const next = [clamp(current[0] + dx, annotation.width), clamp(current[1] + dy, annotation.height)];
    setPolygons((items) => items.map((polygon, polygonIndex) => (
      polygonIndex === selection.polygonIndex
        ? { ...polygon, points: polygon.points.map((point, pointIndex) => pointIndex === selection.pointIndex ? next : point) }
        : polygon
    )));
    setPointAnnouncement(t("{name} 已移动到 X {x}，Y {y}", {
      name: pointName(selection), x: Math.round(next[0]), y: Math.round(next[1]),
    }));
  };

  const removePoint = (selection) => {
    if (editorBusy || !selection) return;
    if (selection.kind === "draft") {
      setDraft((points) => points.filter((_, index) => index !== selection.pointIndex));
    } else {
      setPolygons((items) => items.flatMap((polygon, polygonIndex) => {
        if (polygonIndex !== selection.polygonIndex) return [polygon];
        if (polygon.points.length <= 3) return [];
        return [{ ...polygon, points: polygon.points.filter((_, pointIndex) => pointIndex !== selection.pointIndex) }];
      }));
    }
    setSelectedPoint(null);
    setPointAnnouncement(t("已删除 {name}", { name: pointName(selection) }));
  };

  const handlePointKeyDown = (event, selection) => {
    const distance = event.shiftKey ? 5 : 1;
    const movement = {
      ArrowUp: [0, -distance],
      ArrowDown: [0, distance],
      ArrowLeft: [-distance, 0],
      ArrowRight: [distance, 0],
    }[event.key];
    if (movement) {
      event.preventDefault();
      event.stopPropagation();
      setSelectedPoint(selection);
      nudgePoint(selection, movement[0], movement[1]);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      removePoint(selection);
    }
  };
  const appliedMaskVisible = showAppliedMask && Boolean(annotation.appliedMaskDataUrl);
  const AppliedMaskVisibilityIcon = appliedMaskVisible ? IconEye : IconEyeOff;
  const editorStatus = draft.length
    ? t("{count} 点待闭合", { count: draft.length })
    : hasUnsavedChanges
      ? t("有未保存修改")
      : t("{count} 个标注", { count: polygons.length });

  return (
    <div className={`annotation-editor${editorBusy ? " is-busy" : ""}`} aria-busy={editorBusy}>
      <div className="annotation-toolbar" role="toolbar" aria-label={t("遮罩编辑工具")}>
        <div className="annotation-tool-summary">
          <strong>{t("遮罩工具")}</strong>
          <span className={hasUnsavedChanges ? "is-dirty" : ""} aria-live="polite">{editorStatus}</span>
        </div>
        <div className="seg-type-switch" aria-label={t("多边形类型")}>
          <button
            className={polygonType === "include" ? "is-active" : ""}
            type="button"
            aria-pressed={polygonType === "include"}
            title={t("保留区（Q）")}
            disabled={editorBusy}
            onClick={() => setPolygonType("include")}
          >
            <span className="seg-swatch include" />{t("保留区")}
          </button>
          <button
            className={polygonType === "exclude" ? "is-active" : ""}
            type="button"
            aria-pressed={polygonType === "exclude"}
            title={t("排除区（W）")}
            disabled={editorBusy}
            onClick={() => setPolygonType("exclude")}
          >
            <span className="seg-swatch exclude" />{t("排除区")}
          </button>
        </div>
        <details className="annotation-help-popover">
          <summary>
            <IconHelpCircle size={15} aria-hidden="true" />
            <span>{t("操作说明")}</span>
          </summary>
          <div>
            <strong>{t("绘制与导航")}</strong>
            <p>{t("点击图片添加点；闭合后拖动顶点微调。排除区会从保留区中扣除。")}</p>
            <span className="annotation-shortcuts">
              <kbd>Q</kbd>{t("保留")}
              <kbd>W</kbd>{t("排除")}
              <kbd>G</kbd>{t("导入")}
              <kbd>Ctrl S</kbd>{t("保存")}
              <kbd>← →</kbd>{t("切换图片")}
            </span>
          </div>
        </details>
        <button
          className="button primary annotation-save-button"
          type="button"
          onClick={() => void save()}
          disabled={editorBusy || draft.length > 0}
          title="Ctrl+S"
        >
          <IconDeviceFloppy size={16} />
          <span>{saving ? t("保存中") : t("写入 JPG")}</span>
        </button>
      </div>
      {saving || loadingPrevious ? (
        <LoadingProgress
          compact
          tone="violet"
          className="annotation-progress"
          label={saving ? t("正在保存 XSeg 标注…") : t("正在读取上一张标注…")}
          detail={saving ? t("正在原子写回 DFL JPG 元数据") : t("当前编辑内容保持不变")}
        />
      ) : null}
      <div className="annotation-canvas-wrap">
        <p className="visually-hidden" id={pointInstructionsId}>
          {t("Tab 选择多边形顶点；方向键移动 1 像素，Shift 加方向键移动 5 像素，Delete 删除。")}
        </p>
        <span className="visually-hidden" role="status" aria-live="polite">{pointAnnouncement}</span>
        <svg
          ref={svgRef}
          className="annotation-canvas"
          viewBox={`0 0 ${annotation.width} ${annotation.height}`}
          role="group"
          aria-label={t("{name} XSeg 多边形编辑器", { name: item.name })}
          aria-describedby={pointInstructionsId}
          aria-disabled={editorBusy}
          onPointerDown={addPoint}
          onPointerMove={movePoint}
          onPointerUp={() => setDragging(null)}
          onPointerCancel={() => setDragging(null)}
        >
          <image
            href={item.imageUrl}
            x="0"
            y="0"
            width={annotation.width}
            height={annotation.height}
            preserveAspectRatio="none"
          />
          {showAppliedMask && annotation.appliedMaskDataUrl ? (
            <image
              className="annotation-mask-overlay"
              href={annotation.appliedMaskDataUrl}
              x="0"
              y="0"
              width={annotation.width}
              height={annotation.height}
              opacity="0.42"
              preserveAspectRatio="none"
              pointerEvents="none"
            />
          ) : null}
          {polygons.map((polygon, polygonIndex) => (
            <g key={`${polygon.type}-${polygonIndex}`}>
              <polygon
                points={polygon.points.map((point) => point.join(",")).join(" ")}
                stroke={colors[polygon.type].stroke}
                fill={colors[polygon.type].fill}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              {polygon.points.map((point, pointIndex) => (
                <circle
                  key={`${polygonIndex}-${pointIndex}`}
                  className="annotation-handle"
                  cx={point[0]}
                  cy={point[1]}
                  r="4"
                  fill={colors[polygon.type].stroke}
                  stroke="#07110e"
                  strokeWidth="1.5"
                  tabIndex={editorBusy ? -1 : 0}
                  role="button"
                  aria-pressed={selectedPoint?.kind === "polygon" && selectedPoint.polygonIndex === polygonIndex && selectedPoint.pointIndex === pointIndex}
                  aria-label={pointName({ kind: "polygon", polygonIndex, pointIndex })}
                  onFocus={() => selectPoint({ kind: "polygon", polygonIndex, pointIndex })}
                  onKeyDown={(event) => handlePointKeyDown(event, { kind: "polygon", polygonIndex, pointIndex })}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging({ polygonIndex, pointIndex });
                    setSelectedPoint({ kind: "polygon", polygonIndex, pointIndex });
                  }}
                />
              ))}
            </g>
          ))}
          {draft.length > 0 && (
            <g>
              <polyline
                points={draft.map((point) => point.join(",")).join(" ")}
                stroke={colors[polygonType].stroke}
                fill="none"
                strokeWidth="2"
                strokeDasharray="7 5"
                vectorEffect="non-scaling-stroke"
              />
              {draft.map((point, index) => (
                <circle
                  key={`draft-${index}`}
                  cx={point[0]}
                  cy={point[1]}
                  r="4"
                  fill={colors[polygonType].stroke}
                  tabIndex={editorBusy ? -1 : 0}
                  role="button"
                  aria-pressed={selectedPoint?.kind === "draft" && selectedPoint.pointIndex === index}
                  aria-label={pointName({ kind: "draft", pointIndex: index })}
                  onFocus={() => selectPoint({ kind: "draft", pointIndex: index })}
                  onKeyDown={(event) => handlePointKeyDown(event, { kind: "draft", pointIndex: index })}
                />
              ))}
            </g>
          )}
        </svg>
      </div>
      <div className="annotation-actions" role="toolbar" aria-label={t("遮罩编辑操作")}>
        <button className="button secondary" type="button" onClick={() => void inheritPrevious()} disabled={editorBusy} title={t("继承上一张")}>
          <IconRestore size={15} />{t("继承")}
        </button>
        <button className="button secondary" type="button" onClick={copyPolygons} disabled={!polygons.length} title="Ctrl+C">
          <IconCopy size={15} />{t("复制")}
        </button>
        <button className="button secondary" type="button" onClick={pastePolygons} disabled={editorBusy || !clipboard?.length} title="Ctrl+V">
          <IconClipboard size={15} />{t("粘贴")}
        </button>
        <button
          className={`button secondary annotation-mask-toggle ${appliedMaskVisible ? "is-active" : ""}`}
          type="button"
          aria-pressed={appliedMaskVisible}
          aria-label={t(appliedMaskVisible ? "隐藏应用遮罩" : "显示应用遮罩")}
          title={t(appliedMaskVisible ? "隐藏应用遮罩" : "显示应用遮罩")}
          onClick={() => setShowAppliedMask((value) => !value)}
          disabled={!annotation.appliedMaskDataUrl}
        >
          <AppliedMaskVisibilityIcon className="annotation-action-state" size={15} aria-hidden="true" />
          <span>{t("遮罩")}</span>
        </button>
        <button className="button secondary" type="button" onClick={importSuggested} disabled={editorBusy || !annotation.suggestedPolygons?.length} title={t("导入遮罩轮廓（G）")}>
          <IconSparkles size={15} />{t("导入")}
        </button>
        <button className="button secondary" type="button" onClick={() => setDraft((value) => value.slice(0, -1))} disabled={editorBusy || !draft.length} title={t("撤销最后一个点")}>
          <IconRotateClockwise size={15} />{t("撤销")}
        </button>
        <button className="button secondary" type="button" onClick={finishPolygon} disabled={editorBusy || draft.length < 3} title={t("闭合当前多边形")}>
          <IconCheck size={15} />{t("闭合")}
        </button>
        <button className="button secondary" type="button" onClick={() => setPolygons((value) => value.slice(0, -1))} disabled={editorBusy || !polygons.length} title={t("移除最后一个多边形")}>
          <IconTrash size={15} />{t("移除")}
        </button>
      </div>
    </div>
  );
}

function InspectorLayerButton({
  active,
  available,
  detail,
  label,
  loading,
  onToggle,
  tone,
}) {
  const { t } = useI18n();
  const layerVisible = active && available;
  const VisibilityIcon = layerVisible ? IconEye : IconEyeOff;
  const actionLabel = t(layerVisible ? "隐藏图层：{label}" : "显示图层：{label}", { label });
  return (
    <button
      className={`asset-layer-button is-${tone}${layerVisible ? " is-active" : ""}`}
      type="button"
      aria-pressed={layerVisible}
      aria-label={`${actionLabel} · ${detail}`}
      title={`${actionLabel} · ${detail}`}
      disabled={loading || !available}
      onClick={onToggle}
    >
      <strong>{label}</strong>
      <VisibilityIcon className="asset-layer-visibility" size={14} stroke={1.8} aria-hidden="true" />
    </button>
  );
}

function AssetInspector({
  annotation,
  annotationError,
  annotationLoading,
  item,
  onOpenTool,
  onOpenXSeg,
  side,
}) {
  const { t } = useI18n();
  const maskId = `asset-mask-${useId().replaceAll(":", "")}`;
  const [visibleLayers, setVisibleLayers] = useState({
    dfl: false,
    mask: false,
    points: false,
    polygons: false,
  });
  const toggleLayer = useCallback((layer) => {
    setVisibleLayers((current) => ({ ...current, [layer]: !current[layer] }));
  }, []);

  const landmarks = annotation?.landmarks ?? [];
  const polygons = annotation?.polygons ?? [];
  const sourceRect = annotation?.sourceRectAligned ?? [];
  const polygonPointCount = polygons.reduce((total, polygon) => total + polygon.points.length, 0);
  const dflAvailable = landmarks.length > 0 || sourceRect.length === 4;
  const polygonsAvailable = polygons.length > 0;
  const pointsAvailable = polygonPointCount > 0;
  const maskAvailable = Boolean(annotation?.appliedMaskDataUrl);
  const width = annotation?.width || 1;
  const height = annotation?.height || 1;
  const pointRadius = Math.max(width, height) * 0.006;
  const dflDetail = annotation
    ? t("{type} · {count} 点", { type: annotation.faceType ?? "DFL", count: landmarks.length })
    : item.hasDflMetadata ? t("读取中…") : t("元数据无效");
  const polygonDetail = t("{count} 个 · {points} 点", {
    count: annotation ? polygons.length : item.polygonCount,
    points: annotation ? polygonPointCount : item.pointCount,
  });
  const pointDetail = t("{count} 点", {
    count: annotation ? polygonPointCount : item.pointCount,
  });
  const maskDetail = item.hasAppliedMask
    ? maskAvailable ? t("已写入 · 可预览") : annotation ? t("已写入 · 无法预览") : t("读取中…")
    : t("未写入");
  const isQuarantined = Boolean(item.token);
  const xsegTitle = isQuarantined ? t("请先恢复图片，再编辑 XSeg") : t("XSeg 编辑");

  return (
    <div className="asset-inspector">
      <div className="asset-layer-toolbar">
        <div className="asset-layer-buttons" role="group" aria-label={t("图层预览")}>
          <InspectorLayerButton
            active={visibleLayers.dfl}
            available={dflAvailable}
            detail={dflDetail}
            label={t("DFL 定位")}
            loading={annotationLoading}
            onToggle={() => toggleLayer("dfl")}
            tone="dfl"
          />
          <InspectorLayerButton
            active={visibleLayers.polygons}
            available={polygonsAvailable}
            detail={polygonDetail}
            label={t("手绘多边形")}
            loading={annotationLoading}
            onToggle={() => toggleLayer("polygons")}
            tone="polygon"
          />
          <InspectorLayerButton
            active={visibleLayers.points}
            available={pointsAvailable}
            detail={pointDetail}
            label={t("标注点")}
            loading={annotationLoading}
            onToggle={() => toggleLayer("points")}
            tone="points"
          />
          <InspectorLayerButton
            active={visibleLayers.mask}
            available={maskAvailable}
            detail={maskDetail}
            label={t("应用遮罩")}
            loading={annotationLoading}
            onToggle={() => toggleLayer("mask")}
            tone="mask"
          />
        </div>
      </div>
      {annotationLoading ? (
        <LoadingProgress
          compact
          className="asset-inspector-progress"
          label={t("正在读取图层…")}
          detail={t("正在解析当前 JPG 内的真实 DFL 元数据")}
          operationKey={`aligned-annotation:${item.name}`}
        />
      ) : null}
      {annotationError ? (
        <div className="asset-layer-error" role="alert">
          <IconAlertTriangle size={15} />
          <span>{t("无法读取图层：{message}", { message: annotationError.message })}</span>
        </div>
      ) : null}
      <div className="asset-preview-stage">
        <svg
          className="asset-preview-canvas"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMin meet"
          role="img"
          aria-label={t("{name} 图层预览", { name: item.name })}
        >
          <title>{t("{name} 图层预览", { name: item.name })}</title>
          <image
            href={item.imageUrl}
            x="0"
            y="0"
            width={width}
            height={height}
            preserveAspectRatio={annotation ? "none" : "xMidYMin meet"}
          />
          {maskAvailable ? (
            <defs>
              <mask
                id={maskId}
                x="0"
                y="0"
                width={width}
                height={height}
                maskUnits="userSpaceOnUse"
                style={{ maskType: "luminance" }}
              >
                <image
                  href={annotation.appliedMaskDataUrl}
                  x="0"
                  y="0"
                  width={width}
                  height={height}
                  preserveAspectRatio="none"
                />
              </mask>
            </defs>
          ) : null}
          {visibleLayers.mask && maskAvailable ? (
            <rect className="asset-mask-layer" x="0" y="0" width={width} height={height} mask={`url(#${maskId})`} />
          ) : null}
          {visibleLayers.polygons ? polygons.map((polygon, polygonIndex) => (
            <polygon
              className={`asset-polygon-layer is-${polygon.type}`}
              key={`${polygon.type}-${polygonIndex}`}
              points={polygon.points.map((point) => point.join(",")).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          )) : null}
          {visibleLayers.points ? polygons.flatMap((polygon, polygonIndex) => (
            polygon.points.map(([x, y], pointIndex) => (
              <circle
                className={`asset-polygon-point is-${polygon.type}`}
                key={`${polygonIndex}-${pointIndex}`}
                cx={x}
                cy={y}
                r={pointRadius}
                vectorEffect="non-scaling-stroke"
              />
            ))
          )) : null}
          {visibleLayers.dfl && sourceRect.length === 4 ? (
            <polygon
              className="asset-source-rect-layer"
              points={sourceRect.map((point) => point.join(",")).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {visibleLayers.dfl ? landmarkSegments.map((segment, segmentIndex) => (
            <polyline
              className="asset-landmark-line"
              key={segmentIndex}
              points={segment.map((pointIndex) => landmarks[pointIndex]).filter(Boolean).map((point) => point.join(",")).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          )) : null}
          {visibleLayers.dfl ? landmarks.map(([x, y], pointIndex) => (
            <circle
              className="asset-landmark-point"
              key={pointIndex}
              cx={x}
              cy={y}
              r={pointRadius}
              vectorEffect="non-scaling-stroke"
            />
          )) : null}
        </svg>
      </div>
      <div className="asset-preview-actions" role="toolbar" aria-label={t("素材操作")}>
        <button
          className="button secondary is-xseg"
          type="button"
          disabled={isQuarantined || !onOpenXSeg}
          title={xsegTitle}
          aria-label={xsegTitle}
          onClick={() => onOpenXSeg?.(side, item)}
        >
          <IconPhoto size={15} />{t("XSeg 编辑")}
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!onOpenTool}
          onClick={() => onOpenTool?.("clarity", side, item)}
        >
          <IconSparkles size={15} />{t("清晰增强")}
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!onOpenTool}
          onClick={() => onOpenTool?.("single-frame", side, item)}
        >
          <IconPlayerPlay size={15} />{t("参考图合成")}
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!onOpenTool}
          onClick={() => onOpenTool?.("ai-edit", side, item)}
        >
          <IconSparkles size={15} />{t("AI 图像编辑")}
        </button>
      </div>
    </div>
  );
}

export function DatasetView({
  side,
  commands,
  focusItem,
  focusNonce,
  onFocusConsumed,
  onOpenCommand,
  onOpenTool,
  onOpenXSeg,
  onError,
  onNotice,
  editMasks = false,
  onSideChange,
  onMaskDirtyChange,
}) {
  const { t } = useI18n();
  const [assets, setAssets] = useState(null);
  const [quarantine, setQuarantine] = useState(null);
  const [datasetMode, setDatasetMode] = useState("workspace");
  const [workspaceSelectedName, setWorkspaceSelectedName] = useState(null);
  const [recoverySelectedKey, setRecoverySelectedKey] = useState(null);
  const [workspaceOffset, setWorkspaceOffset] = useState(0);
  const [recoveryOffset, setRecoveryOffset] = useState(0);
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [annotation, setAnnotation] = useState(null);
  const [annotationError, setAnnotationError] = useState(null);
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [datasetAction, setDatasetAction] = useState(null);
  const [maskClipboard, setMaskClipboard] = useState([]);
  const [maskDirty, setMaskDirty] = useState(false);
  const [thumbnailSizeIndex, setThumbnailSizeIndex] = useState(1);
  const sideRef = useRef(side);
  const collectionOffsetsRef = useRef({ workspace: 0, recovery: 0 });
  const refreshRequestRef = useRef(0);
  const annotationRequestRef = useRef(0);
  sideRef.current = side;
  const handleMaskDirty = useCallback((value) => setMaskDirty(value), []);

  useEffect(() => {
    if (editMasks) onMaskDirtyChange?.(maskDirty);
  }, [editMasks, maskDirty, onMaskDirtyChange]);

  useEffect(() => () => {
    if (editMasks) onMaskDirtyChange?.(false);
  }, [editMasks, onMaskDirtyChange]);

  const resetAnnotation = useCallback(() => {
    annotationRequestRef.current += 1;
    setAnnotation(null);
    setAnnotationError(null);
    setAnnotationLoading(false);
  }, []);

  const refresh = useCallback(async ({
    workspaceOffset: requestedWorkspaceOffset = collectionOffsetsRef.current.workspace,
    recoveryOffset: requestedRecoveryOffset = collectionOffsetsRef.current.recovery,
  } = {}) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    setLoading(true);
    try {
      let [nextAssets, nextQuarantine] = await Promise.all([
        runtimeApi.alignedAssets(side, { offset: requestedWorkspaceOffset, limit: datasetPageSize }),
        editMasks
          ? Promise.resolve(emptyDatasetCollection(side))
          : runtimeApi.alignedQuarantine(side, { offset: requestedRecoveryOffset, limit: datasetPageSize }),
      ]);
      if (nextAssets.total > 0 && nextAssets.items.length === 0 && nextAssets.offset > 0) {
        const fallbackOffset = Math.floor((nextAssets.total - 1) / datasetPageSize) * datasetPageSize;
        nextAssets = await runtimeApi.alignedAssets(side, { offset: fallbackOffset, limit: datasetPageSize });
      }
      if (nextQuarantine.total > 0 && nextQuarantine.items.length === 0 && nextQuarantine.offset > 0) {
        const fallbackOffset = Math.floor((nextQuarantine.total - 1) / datasetPageSize) * datasetPageSize;
        nextQuarantine = await runtimeApi.alignedQuarantine(side, { offset: fallbackOffset, limit: datasetPageSize });
      }
      if (requestId !== refreshRequestRef.current || sideRef.current !== side) return false;
      resetAnnotation();
      setAssets(nextAssets);
      setQuarantine(nextQuarantine);
      collectionOffsetsRef.current = {
        workspace: nextAssets.offset,
        recovery: nextQuarantine.offset,
      };
      setWorkspaceOffset(nextAssets.offset);
      setRecoveryOffset(nextQuarantine.offset);
      setCollectionRevision((current) => current + 1);
      setWorkspaceSelectedName((current) => (
        current && nextAssets.items.some((item) => item.name === current)
          ? current
          : nextAssets.items[0]?.name ?? null
      ));
      setRecoverySelectedKey((current) => (
        current && nextQuarantine.items.some((item) => datasetAssetKey(item) === current)
          ? current
          : datasetAssetKey(nextQuarantine.items[0]) || null
      ));
      return { assets: nextAssets, quarantine: nextQuarantine };
    } catch (error) {
      if (requestId === refreshRequestRef.current && sideRef.current === side) onError(error);
      return false;
    } finally {
      if (requestId === refreshRequestRef.current && sideRef.current === side) setLoading(false);
    }
  }, [editMasks, onError, resetAnnotation, side]);

  useEffect(() => {
    refreshRequestRef.current += 1;
    collectionOffsetsRef.current = { workspace: 0, recovery: 0 };
    setAssets(null);
    setQuarantine(null);
    setDatasetMode("workspace");
    setWorkspaceSelectedName(null);
    setRecoverySelectedKey(null);
    setWorkspaceOffset(0);
    setRecoveryOffset(0);
    resetAnnotation();
    void refresh({ workspaceOffset: 0, recoveryOffset: 0 });
    return () => {
      refreshRequestRef.current += 1;
      annotationRequestRef.current += 1;
    };
  }, [refresh, resetAnnotation]);

  useEffect(() => {
    if (!focusItem || !focusNonce || !assets || assets.side !== side) return;
    setAssets((current) => {
      if (!current || current.items.some((item) => item.name === focusItem.name)) return current;
      return { ...current, items: [focusItem, ...current.items] };
    });
    setDatasetMode("workspace");
    setWorkspaceSelectedName(focusItem.name);
    resetAnnotation();
    onFocusConsumed?.();
  }, [assets, focusItem, focusNonce, onFocusConsumed, resetAnnotation, side]);

  const activeCollection = datasetMode === "recovery" ? quarantine : assets;
  const activeItems = activeCollection?.items ?? [];
  const activeOffset = datasetMode === "recovery" ? recoveryOffset : workspaceOffset;
  const selectedKey = datasetMode === "recovery" ? recoverySelectedKey : workspaceSelectedName;
  const selected = activeItems.find((item) => datasetAssetKey(item) === selectedKey) ?? null;
  const selectedIndex = selected ? activeItems.findIndex((item) => datasetAssetKey(item) === selectedKey) : -1;

  useEffect(() => {
    if (
      !selected
      || activeCollection?.side !== side
      || !selected.hasDflMetadata
    ) {
      setAnnotation(null);
      setAnnotationError(null);
      setAnnotationLoading(false);
      return;
    }
    let cancelled = false;
    const requestId = annotationRequestRef.current + 1;
    annotationRequestRef.current = requestId;
    setAnnotation(null);
    setAnnotationError(null);
    setAnnotationLoading(true);
    const request = selected.token
      ? runtimeApi.quarantinedAnnotation(side, selected.token, selected.name)
      : runtimeApi.alignedAnnotation(side, selected.name);
    void request
      .then((value) => {
        if (!cancelled && requestId === annotationRequestRef.current) setAnnotation(value);
      })
      .catch((error) => {
        if (cancelled || requestId !== annotationRequestRef.current) return;
        setAnnotationError(error);
        onError(error);
      })
      .finally(() => {
        if (!cancelled && requestId === annotationRequestRef.current) setAnnotationLoading(false);
      });
    return () => {
      cancelled = true;
      if (annotationRequestRef.current === requestId) annotationRequestRef.current += 1;
    };
  }, [activeCollection?.side, collectionRevision, datasetMode, onError, selected?.hasDflMetadata, selected?.name, selected?.token, side]);

  const confirmDiscardMask = () => !maskDirty || window.confirm(t("当前 XSeg 标注尚未保存，确定放弃修改并继续吗？"));
  const refreshDataset = async () => {
    if (!confirmDiscardMask()) return;
    const result = await refresh();
    if (result) setMaskDirty(false);
  };
  const selectAsset = (item) => {
    if (!confirmDiscardMask()) return;
    resetAnnotation();
    if (datasetMode === "recovery") {
      setRecoverySelectedKey(datasetAssetKey(item));
    } else {
      setWorkspaceSelectedName(item.name);
    }
    setMaskDirty(false);
  };
  const navigateAsset = async (direction) => {
    if (loading || !activeItems.length || selectedIndex < 0 || !confirmDiscardMask()) return;
    const nextIndex = selectedIndex + direction;
    if (nextIndex < 0 || nextIndex >= activeItems.length) {
      if (datasetMode !== "workspace") return;
      const hasAdjacentPage = direction < 0
        ? workspaceOffset > 0
        : workspaceOffset + activeItems.length < (assets?.total ?? 0);
      if (!hasAdjacentPage) return;
      const nextOffset = direction < 0
        ? Math.max(0, workspaceOffset - datasetPageSize)
        : workspaceOffset + datasetPageSize;
      resetAnnotation();
      setMaskDirty(false);
      const result = await refresh({ workspaceOffset: nextOffset });
      const nextItem = direction < 0 ? result?.assets?.items.at(-1) : result?.assets?.items[0];
      if (nextItem && sideRef.current === side) setWorkspaceSelectedName(nextItem.name);
      return;
    }
    resetAnnotation();
    if (datasetMode === "recovery") {
      setRecoverySelectedKey(datasetAssetKey(activeItems[nextIndex]));
    } else {
      setWorkspaceSelectedName(activeItems[nextIndex].name);
    }
    setMaskDirty(false);
  };
  const loadPreviousAnnotation = async () => {
    if (!assets?.items.length || selectedIndex < 0) return null;
    if (selectedIndex > 0) {
      return runtimeApi.alignedAnnotation(side, assets.items[selectedIndex - 1].name);
    }
    if (workspaceOffset <= 0) return null;
    const previousPage = await runtimeApi.alignedAssets(side, {
      offset: workspaceOffset - 1,
      limit: 1,
    });
    const previousItem = previousPage.items[0];
    if (!previousItem?.hasDflMetadata) return null;
    return runtimeApi.alignedAnnotation(side, previousItem.name);
  };
  const sideCommands = commands.filter((command) => (
    command.side === side
    && (command.category === "dataset" || command.category === "extract" || command.category === "sort")
  ));

  const switchDatasetMode = (nextMode) => {
    if (nextMode === datasetMode || !confirmDiscardMask()) return;
    resetAnnotation();
    setDatasetMode(nextMode);
    if (nextMode === "recovery" && !recoverySelectedKey) {
      setRecoverySelectedKey(datasetAssetKey(quarantine?.items[0]) || null);
    }
    if (nextMode === "workspace" && !workspaceSelectedName) {
      setWorkspaceSelectedName(assets?.items[0]?.name ?? null);
    }
    setMaskDirty(false);
  };

  const changePage = (direction) => {
    if (loading || !confirmDiscardMask()) return;
    const nextOffset = Math.max(0, activeOffset + (direction * datasetPageSize));
    if (nextOffset === activeOffset) return;
    resetAnnotation();
    setMaskDirty(false);
    if (datasetMode === "recovery") {
      setRecoverySelectedKey(null);
      void refresh({ recoveryOffset: nextOffset });
    } else {
      setWorkspaceSelectedName(null);
      void refresh({ workspaceOffset: nextOffset });
    }
  };

  const quarantineSelected = async () => {
    if (
      datasetMode !== "workspace"
      || activeCollection?.side !== side
      || !selected
      || !window.confirm(t("把 {name} 移入可恢复隔离区吗？", { name: selected.name }))
    ) return;
    const actionSide = side;
    const item = selected;
    const nextWorkspaceOffset = activeItems.length === 1 && workspaceOffset > 0
      ? Math.max(0, workspaceOffset - datasetPageSize)
      : workspaceOffset;
    setDatasetAction("quarantine");
    try {
      await runtimeApi.quarantineAligned(actionSide, item.name);
      onNotice(t("{name} 已移入隔离区，可随时恢复", { name: item.name }));
      if (sideRef.current === actionSide) {
        await refresh({ workspaceOffset: nextWorkspaceOffset, recoveryOffset: 0 });
      }
    } catch (error) {
      onError(error);
    } finally {
      setDatasetAction(null);
    }
  };

  const restoreSelected = async () => {
    if (datasetMode !== "recovery" || activeCollection?.side !== side || !selected?.token) return;
    const actionSide = side;
    const item = selected;
    const nextRecoveryOffset = activeItems.length === 1 && recoveryOffset > 0
      ? Math.max(0, recoveryOffset - datasetPageSize)
      : recoveryOffset;
    setDatasetAction(`restore:${item.token}`);
    try {
      await runtimeApi.restoreAligned(actionSide, item.token, item.name);
      onNotice(t("{name} 已恢复到 {side} aligned", { name: item.name, side: actionSide.toUpperCase() }));
      if (sideRef.current === actionSide) {
        await refresh({ workspaceOffset, recoveryOffset: nextRecoveryOffset });
      }
    } catch (error) {
      onError(error);
    } finally {
      setDatasetAction(null);
    }
  };

  return (
    <section className={`dataset-view ${editMasks ? "is-mask-editor-view" : "is-browser-view"}`}>
      <header className="operation-header dataset-header">
        <div>
          <h2>{editMasks ? t("XSeg Web 遮罩编辑器") : t("{side} 数据集", { side: side.toUpperCase() })}</h2>
          <p>
            {editMasks
              ? t("在浏览器中直接读写 DFL aligned JPG 的 include / exclude 多边形。")
              : t("浏览 aligned 人脸、检查元数据，并通过可恢复隔离完成素材清洗。")}
          </p>
        </div>
        <div className="dataset-header-actions">
          {editMasks && (
            <div className="side-switch">
              {["src", "dst"].map((value) => (
                <button
                  className={side === value ? "is-active" : ""}
                  key={value}
                  type="button"
                  onClick={() => {
                    if (value === side || !confirmDiscardMask()) return;
                    setMaskDirty(false);
                    onSideChange(value);
                  }}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <button className="button secondary" type="button" onClick={() => void refreshDataset()} disabled={loading}>
            <IconRefresh size={15} />{loading ? t("扫描中") : t("刷新")}
          </button>
        </div>
      </header>
      {datasetAction ? (
        <LoadingProgress
          compact
          tone={editMasks ? "violet" : "green"}
          label={datasetAction === "quarantine" ? t("正在隔离样本…") : t("正在恢复样本…")}
          detail={t("完成后会重新扫描当前数据集")}
          operationKey={`dataset:${side}:${datasetMode}:${datasetAction}`}
        />
      ) : loading ? (
        <LoadingProgress
          compact
          tone={editMasks ? "violet" : "green"}
          label={assets ? t("正在刷新 aligned 数据集…") : t("正在扫描 aligned 数据集…")}
          detail={t("正在读取样本与可恢复隔离区")}
          operationKey={`dataset:${side}:${datasetMode}:scan`}
        />
      ) : null}

      {!editMasks && (
        <div className="dataset-command-strip" role="toolbar" aria-label={t("数据集操作")}>
          <div className="dataset-command-primary">
            {datasetMode === "workspace" ? (
              <>
                {sideCommands.slice(0, 6).map((command) => (
                  <button type="button" key={command.id} onClick={() => onOpenCommand(command.id)}>
                    <IconPlayerPlay size={14} />{command.shortLabel}
                  </button>
                ))}
                <span>{t("{count} 个数据集命令已接入", { count: sideCommands.length })}</span>
              </>
            ) : (
              <div className="dataset-recovery-summary">
                <IconShieldCheck size={17} />
                <span>
                  <strong>{t("恢复区")}</strong>
                  <small>{t("隔离样本不会参与训练、合成或导出")}</small>
                </span>
              </div>
            )}
          </div>
          <div className="dataset-command-context">
            <button
              className={`dataset-mode-toggle${datasetMode === "recovery" ? " is-recovery-active" : ""}`}
              type="button"
              aria-controls="dataset-browser-panel"
              aria-label={datasetMode === "workspace" ? t("切换到恢复区") : t("切换到工作区")}
              onClick={() => switchDatasetMode(datasetMode === "workspace" ? "recovery" : "workspace")}
            >
              {datasetMode === "workspace" ? <IconShieldCheck size={15} /> : <IconPhoto size={15} />}
              {datasetMode === "workspace" ? t("恢复区") : t("工作区")}
              {datasetMode === "workspace" && <span className="dataset-mode-count">{quarantine?.total ?? 0}</span>}
            </button>
            <button
              className={datasetMode === "workspace" ? "dataset-context-action is-danger" : "dataset-context-action is-restore"}
              type="button"
              onClick={() => void (datasetMode === "workspace" ? quarantineSelected() : restoreSelected())}
              disabled={!selected || activeCollection?.side !== side || Boolean(datasetAction)}
            >
              {datasetMode === "workspace" ? <IconArchive size={15} /> : <IconRestore size={15} />}
              {datasetMode === "workspace" ? t("隔离") : t("恢复")}
            </button>
          </div>
        </div>
      )}

      <div id="dataset-browser-panel" className={`dataset-layout ${editMasks ? "is-mask-editor" : "is-browser"}`}>
        <aside className="asset-browser">
          <div className="asset-browser-heading">
            <div>
              {datasetMode === "recovery" ? <IconShieldCheck size={18} /> : <IconPhoto size={18} />}
              <strong>
                {datasetMode === "recovery"
                  ? t("恢复区人脸（数量：{count}）", { count: activeCollection?.total ?? 0 })
                  : t("aligned 人脸（数量：{count}）", { count: activeCollection?.total ?? 0 })}
              </strong>
            </div>
            <div className="asset-browser-heading-tools">
              <div className="asset-thumbnail-density" role="group" aria-label={t("缩略图密度")}>
                <button
                  type="button"
                  aria-label={t("减少每行数量，放大缩略图")}
                  title={t("减少每行数量，放大缩略图")}
                  disabled={thumbnailSizeIndex >= thumbnailMinWidths.length - 1}
                  onClick={() => setThumbnailSizeIndex((current) => Math.min(current + 1, thumbnailMinWidths.length - 1))}
                >
                  <IconMinus size={14} stroke={2} />
                </button>
                <button
                  type="button"
                  aria-label={t("增加每行数量，缩小缩略图")}
                  title={t("增加每行数量，缩小缩略图")}
                  disabled={thumbnailSizeIndex <= 0}
                  onClick={() => setThumbnailSizeIndex((current) => Math.max(current - 1, 0))}
                >
                  <IconPlus size={14} stroke={2} />
                </button>
              </div>
            </div>
          </div>
          <div
            className="asset-thumbnails"
            style={{ "--asset-thumbnail-min": `${thumbnailMinWidths[thumbnailSizeIndex]}px` }}
          >
            {activeItems.map((item) => (
              <button
                className={`asset-thumbnail ${selectedKey === datasetAssetKey(item) ? "is-active" : ""}`}
                key={datasetAssetKey(item)}
                type="button"
                onClick={() => selectAsset(item)}
                title={item.sourceFilename ?? item.name}
              >
                <img src={item.imageUrl} alt="" loading="lazy" decoding="async" />
                <span>{item.name}</span>
                <small>
                  {item.polygonCount
                    ? t("{count} 个标注", { count: item.polygonCount })
                    : item.hasAppliedMask ? t("已有应用遮罩") : t("未标注")}
                </small>
              </button>
            ))}
            {!loading && !activeItems.length && (
              <div className="asset-browser-empty">
                {datasetMode === "recovery" ? t("恢复区暂无图片。") : t("尚未生成 aligned JPG。")}
              </div>
            )}
          </div>
          <div className="asset-browser-pager" role="navigation" aria-label={t("素材分页") }>
            <button
              type="button"
              aria-label={t("上一页素材")}
              disabled={loading || activeOffset <= 0}
              onClick={() => changePage(-1)}
            >
              <IconArrowLeft size={15} />{t("上一页")}
            </button>
            <span>
              {activeCollection?.total
                ? `${activeOffset + 1}–${activeOffset + activeItems.length} / ${activeCollection.total}`
                : "0 / 0"}
            </span>
            <button
              type="button"
              aria-label={t("下一页素材")}
              disabled={loading || activeOffset + activeItems.length >= (activeCollection?.total ?? 0)}
              onClick={() => changePage(1)}
            >
              {t("下一页")}<IconArrowRight size={15} />
            </button>
          </div>
        </aside>

        <section
          className="asset-detail"
          aria-label={selected ? t("{name} 图层预览", { name: selected.name }) : t("人脸图层预览")}
        >
          {selected ? (
            <>
              {editMasks ? (
                !selected.hasDflMetadata || annotationError ? (
                  <div className="asset-detail-loading is-error" role="alert">
                    <IconAlertTriangle size={24} />
                    <strong>{t("无法读取 DFL 图层数据")}</strong>
                    <span>{annotationError?.message ?? t("元数据无效")}</span>
                  </div>
                ) : (
                  <AnnotationCanvas
                    side={side}
                  item={selected}
                  annotation={annotation}
                  clipboard={maskClipboard}
                  locked={loading}
                  onClipboardChange={setMaskClipboard}
                    onNavigate={navigateAsset}
                    onLoadPrevious={loadPreviousAnnotation}
                    onDirtyChange={handleMaskDirty}
                    onError={onError}
                    onSaved={(result) => {
                      onNotice(t("已写入 {count} 个多边形标注", { count: result.polygonCount }));
                      void refresh();
                    }}
                  />
                )
              ) : (
                <AssetInspector
                  annotation={annotation}
                  annotationError={annotationError}
                  annotationLoading={annotationLoading}
                  item={selected}
                  onOpenTool={onOpenTool}
                  onOpenXSeg={onOpenXSeg}
                  side={side}
                />
              )}
            </>
          ) : (
            <div className="asset-detail-empty">
              {datasetMode === "recovery" ? <IconShieldCheck size={28} /> : <IconPhoto size={28} />}
              {datasetMode === "recovery" ? t("选择恢复区中的图片查看。") : t("选择一张 aligned 人脸查看。")}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

export function ModelSummaryAside({ workspace }) {
  const { t } = useI18n();
  if (!workspace) {
    return (
      <aside className="model-summary-aside">
        <LoadingProgress compact label={t("正在读取模型目录…")} detail={t("正在核对模型家族与文件状态")} />
      </aside>
    );
  }
  return (
    <aside className="model-summary-aside">
      <div className="model-summary-heading">
        <IconBoxModel2 size={19} />
        <h3>{t("已检测模型")}</h3>
      </div>
      {workspace?.models?.length ? workspace.models.map((model) => (
        <div className="model-summary-row" key={`${model.type}-${model.name}`}>
          <span>{model.type}</span>
          <div>
            <strong>{model.name}</strong>
            <small>{t("{count} 个文件", { count: model.fileCount })}</small>
          </div>
        </div>
      )) : (
        <div className="model-empty-guide">
          <strong>{t("还没有可用模型")}</strong>
          <span>{t("首次使用可从“训练 SAEHD”开始。")}</span>
          <small>{t("训练生成的模型文件会自动出现在这里。")}</small>
        </div>
      )}
    </aside>
  );
}

export function SettingsView({ health, jobs, onRetry, onError, onNotice }) {
  const { language, t } = useI18n();
  const [projects, setProjects] = useState(null);
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectBusy, setProjectBusy] = useState(null);
  const [retryBusy, setRetryBusy] = useState(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticMeta, setDiagnosticMeta] = useState(null);
  useEffect(() => {
    let cancelled = false;
    void runtimeApi.projects().then((value) => { if (!cancelled) setProjects(value); }).catch(onError);
    return () => { cancelled = true; };
  }, [onError]);
  const recoverable = jobs.filter((job) => terminalStates.has(job.state));
  const activeJobCount = jobs.filter((job) => ["queued", "starting", "running", "waiting_input", "stopping"].includes(job.state)).length;
  const createProject = async () => {
    setProjectBusy("create");
    try {
      await runtimeApi.createProject({ name: projectName, id: projectId });
      setProjects(await runtimeApi.projects());
      setProjectName("");
      setProjectId("");
      onNotice(t("新项目已创建；可在任务停止后切换。"));
    } catch (error) { onError(error); } finally { setProjectBusy(null); }
  };
  const activateProject = async (id, name) => {
    if (!window.confirm(t("切换到项目“{name}”吗？本地服务会重启，当前页面随后自动刷新。", { name }))) return;
    setProjectBusy("activate");
    try {
      const result = await runtimeApi.activateProject(id);
      if (!result.restartRequired) {
        setProjectBusy(null);
        return;
      }
      onNotice(t("正在切换项目并重启本地服务…"));
      window.setTimeout(() => window.location.reload(), 1600);
    } catch (error) { setProjectBusy(null); onError(error); }
  };
  const exportDiagnostics = async () => {
    setDiagnosticBusy(true);
    try {
      const snapshot = await runtimeApi.diagnostics();
      const generatedAt = snapshot.generatedAt ?? new Date().toISOString();
      const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `deepfacelabsn-diagnostics-${generatedAt.replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDiagnosticMeta({
        version: snapshot.product?.version ?? health?.version ?? "—",
        sampledAt: generatedAt,
      });
      onNotice(t("诊断摘要已导出到本机下载目录。"));
    } catch (error) {
      onError(error);
    } finally {
      setDiagnosticBusy(false);
    }
  };
  return (
    <section className="operation-view settings-view">
      <header className="operation-header">
        <div>
          <h2>{t("运行时与恢复")}</h2>
          <p>{t("检查固定执行环境，并从已结束或服务重启后失联的任务重新创建安全副本。")}</p>
        </div>
        <span className="operation-count">{health?.loopbackOnly ? t("仅本机访问") : t("状态未知")}</span>
      </header>
      {!projects ? (
        <LoadingProgress compact label={t("正在读取受管项目…")} detail={t("正在确认当前工作区与切换安全性")} operationKey="settings-projects-load" />
      ) : projectBusy ? (
        <LoadingProgress
          compact
          tone={projectBusy === "activate" ? "amber" : "green"}
          label={projectBusy === "activate" ? t("正在切换项目并重启本地服务…") : t("正在创建受管项目…")}
          detail={projectBusy === "activate" ? t("当前页面会在服务恢复后自动刷新") : t("新项目只会写入受管工作区目录")}
          operationKey={`settings-project:${projectBusy}`}
        />
      ) : retryBusy ? (
        <LoadingProgress compact label={t("正在从历史记录创建安全副本…")} detail={retryBusy} operationKey="settings-job-retry" />
      ) : null}
      <div className="settings-runtime">
        {["current", "legacy"].map((profile) => (
          <section key={profile}>
            <span>{profileLabel(profile)}</span>
            <strong>{health?.runtime?.[profile]?.dflRoot ?? t("未检测")}</strong>
            <code>{health?.runtime?.[profile]?.python ?? t("Python 未检测")}</code>
          </section>
        ))}
        <section>
          <span>{t("安全边界")}</span>
          <strong>{t("固定命令注册表 + ConPTY")}</strong>
          <code>{t("不执行、不解析 BAT；写操作需要本机会话")}</code>
        </section>
      </div>
      <section className="diagnostic-export-strip">
        <span className="diagnostic-export-icon"><IconShieldCheck size={18} /></span>
        <div>
          <strong>{t("诊断摘要")}</strong>
          <p>{t("仅导出运行状态摘要，不含绝对路径、命令参数或终端内容。")}</p>
          <small aria-live="polite">
            {t("产品版本 {version} · 最近采样 {sampledAt}", {
              version: diagnosticMeta?.version ?? health?.version ?? "—",
              sampledAt: diagnosticMeta?.sampledAt
                ? new Date(diagnosticMeta.sampledAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")
                : t("尚未采样"),
            })}
          </small>
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={() => void exportDiagnostics()}
          disabled={diagnosticBusy}
        >
          <IconDownload size={15} />{diagnosticBusy ? t("正在生成…") : t("导出诊断摘要")}
        </button>
      </section>
      <section className="project-manager-section">
        <header>
          <div><IconBoxModel2 size={19} /><div><h3>{t("受管项目工作区")}</h3><p>{t("每个项目独立保存素材、模型、任务日志、诊断与恢复记录。")}</p></div></div>
          <span className={activeJobCount ? "is-warning" : "is-ok"}>{activeJobCount ? t("{count} 个任务阻止切换", { count: activeJobCount }) : t("可以安全切换")}</span>
        </header>
        <div className="project-manager-grid">
          <div className="project-list">
            {projects?.projects.map((project) => (
              <article className={project.active ? "is-active" : ""} key={project.id}>
                <span>{project.active ? <IconCheck size={15} /> : <IconBoxModel2 size={15} />}</span>
                <div><strong>{project.name}</strong><small>{project.id} · {project.managed ? t("受管目录") : t("兼容默认工作区")}</small></div>
                <button className="button secondary" type="button" disabled={project.active || activeJobCount > 0 || projectBusy} onClick={() => void activateProject(project.id, project.name)}>{project.active ? t("当前") : t("切换")}</button>
              </article>
            ))}
            {!projects ? <div className="operation-empty">{t("项目清单准备中")}</div> : null}
          </div>
          <form className="project-create-form" onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
            <strong>{t("新建项目")}</strong>
            <label><span>{t("项目名称")}</span><input value={projectName} maxLength={64} onChange={(event) => setProjectName(event.target.value)} placeholder={t("例如：访谈片 A")}/></label>
            <label><span>{t("项目标识")}</span><input value={projectId} maxLength={48} onChange={(event) => setProjectId(event.target.value)} placeholder="interview-a" /></label>
            <small>{t("仅在仓库的 workspaces 目录中创建，不接受任意磁盘路径。创建不会自动切换。")}</small>
            <button className="button primary" type="submit" disabled={!projectName.trim() || !projectId.trim() || projectBusy}>{projectBusy ? t("处理中…") : t("创建受管项目")}</button>
          </form>
        </div>
      </section>
      <section className="recovery-section">
        <header>
          <div>
            <IconRestore size={19} />
            <h3>{t("任务恢复")}</h3>
          </div>
          <span>{t("{count} 个可重试记录", { count: recoverable.length })}</span>
        </header>
        <div className="recovery-rows">
          {recoverable.slice(0, 20).map((job) => (
            <div key={job.id}>
              <span className={`recovery-state is-${job.state}`}>
                {job.state === "orphaned" ? <IconAlertTriangle size={15} /> : <IconCheck size={15} />}
              </span>
              <div>
                <strong>{job.label}</strong>
                <small>{job.id} · {job.state}</small>
              </div>
              <button
                className="button secondary"
                type="button"
                onClick={async () => {
                  setRetryBusy(job.id);
                  try {
                    const next = await onRetry(job.id);
                    onNotice(t("已从 {source} 创建新任务 {target}", { source: job.id, target: next.id }));
                  } catch (error) {
                    onError(error);
                  } finally {
                    setRetryBusy(null);
                  }
                }}
                disabled={Boolean(retryBusy) || Boolean(projectBusy)}
              >
                <IconRefresh size={15} />{t("重试")}
              </button>
            </div>
          ))}
          {!recoverable.length && <div className="operation-empty">{t("没有可恢复的历史任务。")}</div>}
        </div>
      </section>
      <section className="deferred-section">
        <IconX size={18} />
        <div>
          <strong>{t("本轮明确不接入")}</strong>
          <p>{t("独立闭源 EXE、EBSynth 与第三方角度工具保持外部运行；不会在 Web 中伪造控制或状态。")}</p>
        </div>
      </section>
    </section>
  );
}
