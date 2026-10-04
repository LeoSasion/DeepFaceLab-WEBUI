import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dataset browser keeps a height-derived inspector, fluid thumbnails, real overlays, and a shared recovery workspace", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/components/OperationsView.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  const annotationCanvasSource = source.slice(
    source.indexOf("function AnnotationCanvas"),
    source.indexOf("function InspectorLayerButton"),
  );
  const assetInspectorSource = source.slice(
    source.indexOf("function AssetInspector"),
    source.indexOf("export function DatasetView"),
  );
  const assetActionRailSource = assetInspectorSource.slice(
    assetInspectorSource.indexOf('className="asset-preview-actions"'),
  );

  assert.match(source, /thumbnailMinWidths = \[72, 88, 108, 132\]/);
  assert.match(source, /t\("aligned 人脸（数量：\{count\}）", \{ count: activeCollection\?\.total \?\? 0 \}\)/);
  assert.match(source, /t\("恢复区人脸（数量：\{count\}）", \{ count: activeCollection\?\.total \?\? 0 \}\)/);
  assert.doesNotMatch(source, /<span>\{assets\?\.total \?\? 0\}<\/span>/);
  assert.match(source, /aria-label=\{t\("减少每行数量，放大缩略图"\)\}/);
  assert.match(source, /aria-label=\{t\("增加每行数量，缩小缩略图"\)\}/);
  assert.match(source, /--asset-thumbnail-min/);
  assert.match(source, /function AssetInspector\(/);
  assert.match(source, /runtimeApi\.quarantinedAnnotation\(side, selected\.token, selected\.name\)/);
  assert.match(source, /runtimeApi\.alignedAnnotation\(side, selected\.name\)/);
  assert.match(source, /datasetMode === "recovery" \? quarantine : assets/);
  assert.match(source, /activeItems\.map\(\(item\) =>/);
  assert.match(source, /const datasetPageSize = 200/);
  assert.match(source, /refreshRequestRef\.current/);
  assert.match(source, /sideRef\.current !== side/);
  assert.match(source, /activeCollection\?\.side !== side/);
  assert.match(source, /onClick=\{\(\) => changePage\(-1\)\}/);
  assert.match(source, /onClick=\{\(\) => changePage\(1\)\}/);
  assert.match(source, /collectionRevision/);
  assert.match(source, /workspaceOffset \+ activeItems\.length < \(assets\?\.total \?\? 0\)/);
  assert.match(source, /offset: workspaceOffset - 1,[\s\S]*?limit: 1/);
  assert.match(source, /className="dataset-command-context"/);
  assert.match(source, /aria-controls="dataset-browser-panel"/);
  assert.match(source, /datasetMode === "workspace" \? t\("恢复区"\) : t\("工作区"\)/);
  assert.doesNotMatch(source, /className="quarantine-section"/);
  assert.match(source, /annotation\?\.sourceRectAligned/);
  assert.match(source, /mask=\{`url\(#\$\{maskId\}\)`\}/);
  assert.match(source, /aria-pressed=\{layerVisible\}/);
  assert.match(source, /className="annotation-toolbar" role="toolbar" aria-label=\{t\("遮罩编辑工具"\)\}/);
  assert.match(annotationCanvasSource, /className="annotation-actions" role="toolbar" aria-label=\{t\("遮罩编辑操作"\)\}/);
  assert.ok(annotationCanvasSource.indexOf('className="annotation-actions"') > annotationCanvasSource.indexOf('className="annotation-canvas-wrap"'));
  assert.doesNotMatch(assetInspectorSource, /className="annotation-actions"/);
  assert.match(source, /className="annotation-help-popover"/);
  assert.match(source, /aria-pressed=\{appliedMaskVisible\}/);
  assert.doesNotMatch(source, /className="annotation-help"/);
  assert.doesNotMatch(source, /aria-describedby=\{detailId\}/);
  assert.doesNotMatch(source, /className="asset-detail-heading"/);
  assert.doesNotMatch(source, /className="asset-layer-heading"/);
  assert.match(source, /preserveAspectRatio=\{annotation \? "none" : "xMidYMin meet"\}/);
  assert.doesNotMatch(source, /className="asset-inspector">\s*<img[\s\S]*?<dl>/);
  assert.match(assetInspectorSource, /className="asset-preview-actions" role="toolbar" aria-label=\{t\("素材操作"\)\}/);
  assert.ok(assetInspectorSource.indexOf('className="asset-preview-actions"') > assetInspectorSource.indexOf('className="asset-preview-stage"'));
  assert.equal([...assetActionRailSource.matchAll(/<button\b/g)].length, 4);
  assert.match(assetActionRailSource, /onOpenXSeg\?\.\(side, item\)/);
  assert.match(assetActionRailSource, /onOpenTool\?\.\("clarity", side, item\)/);
  assert.match(assetActionRailSource, /onOpenTool\?\.\("single-frame", side, item\)/);
  assert.match(assetActionRailSource, /onOpenTool\?\.\("ai-edit", side, item\)/);
  assert.match(
    styles,
    /\.dataset-layout\.is-browser,\s*\.dataset-layout\.is-mask-editor\s*\{[\s\S]*?--dataset-detail-top:\s*40px;[\s\S]*?--dataset-detail-bottom:\s*38px;[\s\S]*?--dataset-detail-chrome-height:\s*calc\(var\(--dataset-detail-top\) \+ var\(--dataset-detail-bottom\)\);/,
  );
  assert.doesNotMatch(styles, /calc\(594px \* var\(--desktop-ui-inverse, 1\)\)/);
  assert.match(styles, /@media \(min-width: 1021px\)[\s\S]*?\.dataset-layout\.is-browser,\s*\.dataset-layout\.is-mask-editor\s*\{[\s\S]*?grid-template-columns:\s*minmax\(320px, 1fr\) auto;[\s\S]*?container-type:\s*size;/);
  assert.match(styles, /\.dataset-layout\.is-browser \.asset-detail,\s*\.dataset-layout\.is-mask-editor \.asset-detail\s*\{[\s\S]*?width:\s*min\(calc\(100cqh - var\(--dataset-detail-chrome-height\)\), calc\(100cqw - 330px\)\);/);
  assert.doesNotMatch(styles, /\.dataset-layout\.is-browser\s*\{[^}]*grid-template-columns:[^;}]*560px/s);
  assert.match(styles, /repeat\(auto-fill, minmax\(var\(--asset-thumbnail-min, 88px\), 1fr\)\)/);
  assert.match(styles, /@media \(min-width: 1021px\)[\s\S]*?\.dataset-view\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.dataset-view \.dataset-layout[\s\S]*?height:\s*auto;[\s\S]*?flex:\s*1 1 auto;/);
  assert.match(styles, /\.dataset-command-context\s*\{[\s\S]*?margin-left:\s*auto;[\s\S]*?border-left:/);
  assert.match(styles, /@media \(max-width: 1020px\)[\s\S]*?\.dataset-view\s*\{[\s\S]*?container-type:\s*inline-size;[\s\S]*?\.dataset-layout\.is-browser,\s*\.dataset-layout\.is-mask-editor\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?grid-template-rows:\s*520px calc\(min\(100cqw, 602px\) \+ var\(--dataset-detail-chrome-height\)\);[\s\S]*?justify-items:\s*center;/);
  assert.doesNotMatch(styles, /has-quarantine|quarantine-section|quarantine-rows/);
  assert.match(styles, /\.asset-layer-buttons\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.asset-inspector\s*\{[\s\S]*?grid-template-rows:\s*var\(--dataset-detail-top\) minmax\(0, 1fr\) var\(--dataset-detail-bottom\);/);
  assert.match(styles, /\.asset-preview-stage\s*\{[\s\S]*?place-items:\s*start center;[\s\S]*?container-type:\s*size;/);
  assert.match(styles, /\.asset-preview-canvas\s*\{[\s\S]*?width:\s*min\(100cqw, 100cqh\);[\s\S]*?height:\s*min\(100cqw, 100cqh\);[\s\S]*?aspect-ratio:\s*1;/);
  assert.match(styles, /\.asset-preview-actions\s*\{[\s\S]*?height:\s*var\(--dataset-detail-bottom\);[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.asset-inspector-progress\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*var\(--dataset-detail-top\);/);
  assert.match(styles, /\.asset-layer-error\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*var\(--dataset-detail-top\);/);
  assert.match(styles, /\.annotation-editor\s*\{[\s\S]*?grid-template-rows:\s*var\(--annotation-toolbar-top\) minmax\(0, 1fr\) var\(--annotation-toolbar-bottom\);[\s\S]*?container-type:\s*size;/);
  assert.match(styles, /\.annotation-toolbar\s*\{[\s\S]*?height:\s*var\(--annotation-toolbar-top\);[\s\S]*?grid-template-columns:\s*128px minmax\(0, 1fr\) 86px 96px;[\s\S]*?grid-template-rows:\s*34px;/);
  assert.match(styles, /\.annotation-actions\s*\{[\s\S]*?height:\s*var\(--annotation-toolbar-bottom\);[\s\S]*?grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.annotation-canvas-wrap\s*\{[\s\S]*?height:\s*100%;[\s\S]*?container-type:\s*size;/);
  assert.match(styles, /\.annotation-canvas\s*\{[\s\S]*?width:\s*min\(100cqw, 100cqh\);[\s\S]*?height:\s*min\(100cqw, 100cqh\);[\s\S]*?aspect-ratio:\s*1;/);
});

test("dataset actions preserve sample context when opening image tools", async () => {
  const [operationsSource, appSource, toolLabSource] = await Promise.all([
    readFile(new URL("../src/components/OperationsView.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ToolLabView.jsx", import.meta.url), "utf8"),
  ]);
  const assetInspectorSource = operationsSource.slice(
    operationsSource.indexOf("function AssetInspector"),
    operationsSource.indexOf("export function DatasetView"),
  );

  assert.match(assetInspectorSource, /disabled=\{isQuarantined \|\| !onOpenXSeg\}/);
  assert.match(appSource, /setXsegFocus\(\{ side, sample, nonce: Date\.now\(\) \}\)/);
  assert.match(appSource, /setToolFocus\(\{ toolId, side, sample, nonce: Date\.now\(\) \}\)/);
  assert.match(appSource, /focusItem=\{xsegFocus\?\.side === xsegSide \? xsegFocus\.sample : null\}/);
  assert.match(appSource, /toolFocus=\{toolFocus\}/);

  assert.match(toolLabSource, /toolFocus=\{toolFocus\}/);
  // The previously planned tool is now operational. Provider consent and
  // submission behavior are covered by isolated image-service manager tests.
});

test("XSeg unsaved annotations guard refresh, app navigation, and page unload", async () => {
  const [operationsSource, appSource, translationsSource] = await Promise.all([
    readFile(new URL("../src/components/OperationsView.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/i18n.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(operationsSource, /onMaskDirtyChange/);
  assert.match(
    operationsSource,
    /const refreshDataset = async \(\) => \{[\s\S]*?if \(!confirmDiscardMask\(\)\) return;[\s\S]*?const result = await refresh\(\);[\s\S]*?if \(result\) setMaskDirty\(false\);/,
  );
  assert.match(operationsSource, /onClick=\{\(\) => void refreshDataset\(\)\}/);
  assert.match(appSource, /const \[xsegDirty, setXsegDirty\] = useState\(false\)/);
  assert.match(appSource, /window\.addEventListener\("beforeunload", handleBeforeUnload\)/);
  assert.match(appSource, /event\.returnValue = ""/);
  assert.match(appSource, /if \(id !== activeNav && !confirmDiscardXSeg\(\)\) return/);
  assert.match(appSource, /destination\.nav !== activeNav && !confirmDiscardXSeg\(\)/);
  assert.match(appSource, /onMaskDirtyChange=\{setXsegDirty\}/);

  const xsegTranslationKeys = [
    "{count} 点待闭合",
    "有未保存修改",
    "遮罩编辑工具",
    "遮罩工具",
    "保留",
    "保留区（Q）",
    "排除",
    "排除区（W）",
    "操作说明",
    "绘制与导航",
    "点击图片添加点；闭合后拖动顶点微调。排除区会从保留区中扣除。",
    "切换图片",
    "遮罩编辑操作",
    "继承",
    "继承上一张",
    "上一张没有可继承的多边形标注",
    "请先闭合当前多边形再保存",
    "复制",
    "粘贴",
    "显示应用遮罩",
    "隐藏应用遮罩",
    "导入遮罩轮廓（G）",
    "撤销",
    "撤销最后一个点",
    "闭合当前多边形",
    "移除",
    "移除最后一个多边形",
    "人脸图层预览",
    "{name} 素材预览",
    "现有分析结果保持可见",
    "当前 XSeg 标注尚未保存，确定放弃修改并继续吗？",
  ];
  for (const key of xsegTranslationKeys) {
    assert.ok(translationsSource.includes(`"${key}":`), `missing English translation for ${key}`);
  }
  assert.match(
    translationsSource,
    /"当前 XSeg 标注尚未保存，确定放弃修改并继续吗？": "The current XSeg annotation has unsaved changes\. Discard them and continue\?"/,
  );
});

test("XSeg save guards drafts, freezes mutations, and ignores the active side toggle", async () => {
  const source = await readFile(
    new URL("../src/components/OperationsView.jsx", import.meta.url),
    "utf8",
  );
  const annotationCanvasSource = source.slice(
    source.indexOf("function AnnotationCanvas"),
    source.indexOf("function InspectorLayerButton"),
  );

  assert.match(annotationCanvasSource, /const editorBusy = locked \|\| saving \|\| loadingPrevious/);
  assert.match(annotationCanvasSource, /const saveInFlightRef = useRef\(false\)/);
  assert.match(
    annotationCanvasSource,
    /const save = async \(\) => \{[\s\S]*?if \(editorBusy \|\| saveInFlightRef\.current\) return;[\s\S]*?if \(draft\.length > 0\)[\s\S]*?请先闭合当前多边形再保存/,
  );
  assert.match(annotationCanvasSource, /const submittedPolygons = structuredClone\(polygons\)/);
  assert.match(annotationCanvasSource, /saveAlignedAnnotation\(side, item\.name, submittedPolygons\)/);
  assert.match(annotationCanvasSource, /if \(editorBusy \|\| dragging \|\| event\.button !== 0\) return/);
  assert.match(annotationCanvasSource, /if \(editorBusy \|\| !dragging \|\| !svgRef\.current\) return/);
  assert.match(annotationCanvasSource, /disabled=\{editorBusy \|\| draft\.length > 0\}/);
  assert.match(source, /locked=\{loading\}/);
  assert.match(
    source,
    /onClick=\{\(\) => \{\s*if \(value === side \|\| !confirmDiscardMask\(\)\) return;/,
  );
});
