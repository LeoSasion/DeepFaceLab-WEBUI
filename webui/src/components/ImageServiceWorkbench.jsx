import { useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconArrowDown, IconArrowUp, IconDownload, IconExternalLink, IconPhoto, IconPlayerPlay, IconRefresh, IconX } from "@tabler/icons-react";
import { useI18n } from "../i18n.jsx";
import { runtimeApi } from "../runtime/api.js";
import { withRequestDeadline } from "../runtime/request-deadline.js";
import { useDialogFocus } from "./Overlays.jsx";
import { IMAGE_SERVICE, IMAGE_SIZES, IMAGE_RESOLUTIONS } from "../../shared/image-service-contract.mjs";

const PROVIDER_URL = IMAGE_SERVICE.baseUrl;
const REGISTRATION_URL = IMAGE_SERVICE.registrationUrl;
const MODEL = IMAGE_SERVICE.defaultModel;
const MAX_IMAGES = IMAGE_SERVICE.maxImages;
const MAX_IMAGE_BYTES = IMAGE_SERVICE.maxImageBytes;
const RATIOS = IMAGE_SIZES;
const projectDrafts = new Map();

function rememberProjectDraft(key, draft) {
  projectDrafts.delete(key);
  projectDrafts.set(key, draft);
  if (projectDrafts.size > 12) projectDrafts.delete(projectDrafts.keys().next().value);
}
const STATUS_COPY = {
  queued: "等待开始", uploading: "上传已确认的素材", submitting: "正在提交生成请求",
  unconfirmed: "提交结果未确认", pending: "平台处理中", downloading: "保存结果到本机",
  completed: "已完成", failed: "未完成", paused: "等待继续查询",
};
export const IMAGE_TOOL_MODES = [
  { id: "generate", label: "文生图", description: "用提示词生成新图片，也可添加参考图。", prompt: "A red ceramic teapot on a white table" },
  { id: "clarity", label: "清晰度增强", description: "通过图像 API 增强细节；生成结果需要人工复核，原图保留。", prompt: "提高图片清晰度，减轻模糊，保留人物身份、构图、色彩和自然纹理，不增添不存在的细节。" },
  { id: "single-frame", label: "参考图合成", description: "按参考图顺序与提示词生成单张合成图；此功能不调用本地 DFL 换脸模型。", prompt: "根据输入参考图生成一张自然的合成图片，保留主要主体特征、合理光照和一致构图。" },
  { id: "ai-edit", label: "AI 图像编辑", description: "用提示词编辑图片，支持多图参考；当前接口不提供遮罩局部重绘。", prompt: "保留图片主体和构图，按我的要求编辑：" },
];

function byteLabel(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MB`;
}

function safeLocalUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/api/")) return undefined;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}` : undefined;
  } catch { return undefined; }
}

function taskErrorMessage(error) {
  return typeof error === "string" ? error : error?.message;
}

function orderedTasks(tasks) {
  return [...tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function SubmissionConfirm({ draft, busy, onClose, onConfirm }) {
  const { t } = useI18n();
  const { dialogRef, initialFocusRef } = useDialogFocus(Boolean(draft), () => { if (!busy) onClose(); });
  if (!draft) return null;
  return <div className="modal-backdrop"><section className="modal-card image-service-confirm" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="image-service-confirm-title">
    <header><h2 id="image-service-confirm-title">{t("确认图像服务与素材范围")}</h2></header>
    <div className="image-service-confirm-body">
      <dl>
        <div><dt>{t("图像服务")}</dt><dd>{t("奇智 API")} · {PROVIDER_URL}</dd></div>
        <div><dt>{t("模式")}</dt><dd>{t(IMAGE_TOOL_MODES.find(mode => mode.id === draft.mode)?.label)}</dd></div>
        <div><dt>{t("模型")}</dt><dd>{draft.model}</dd></div>
        <div><dt>{t("输出")}</dt><dd>{draft.size} · {draft.resolution} · {t("1 张")}</dd></div>
        <div><dt>{t("内容安全检查")}</dt><dd>{draft.nsfwCheck ? t("启用") : t("关闭")}</dd></div>
      </dl>
      <strong>{t("提示词")}</strong><p className="image-service-confirm-prompt">{draft.prompt}</p>
      <strong>{t("本次素材：{count} 张，按以下顺序", { count: draft.inputs.length + draft.imageUrls.length })}</strong>
      {draft.inputs.length || draft.imageUrls.length ? <ol className="image-service-confirm-inputs">
        {draft.inputs.map(input => <li key={input.inputId}>{input.name} <small>{byteLabel(input.size)}</small></li>)}
        {draft.imageUrls.map((url, index) => <li key={`${url}-${index}`}><code>{url}</code></li>)}
      </ol> : <p>{t("本次只发送提示词，不发送图片。")}</p>}
      <div className="image-service-note is-warning"><IconAlertTriangle size={16} /><p>{t("确认后会将以上素材发送至奇智并执行付费生成。暂无费用预估；仅在平台最终结算后显示实际扣费。结果会下载到当前项目，原图不覆盖。")}</p></div>
    </div>
    <footer><button ref={initialFocusRef} className="button secondary" disabled={busy} type="button" onClick={onClose}>{t("返回修改")}</button><button className="button primary" disabled={busy} type="button" onClick={onConfirm}>{busy ? t("正在提交…") : t("确认并生成")}</button></footer>
  </section></div>;
}

export function ImageServiceWorkbench(props) {
  return <ImageServiceSession key={props.workspaceKey} {...props} />;
}

function ImageServiceSession({ activeTool, onToolChange, side, toolFocus, workspaceKey, onError, onNotice }) {
  const { t } = useI18n();
  const initialDraft = useRef(projectDrafts.get(workspaceKey) ?? {});
  const tool = IMAGE_TOOL_MODES.find(mode => mode.id === activeTool) ?? IMAGE_TOOL_MODES[0];
  const [settings, setSettings] = useState(null);
  const [model, setModel] = useState(MODEL);
  const [apiKey, setApiKey] = useState("");
  const [settingsError, setSettingsError] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [inputs, setInputs] = useState(initialDraft.current.inputs ?? []);
  const [imageUrls, setImageUrls] = useState(initialDraft.current.imageUrls ?? []);
  const [urlDraft, setUrlDraft] = useState("");
  const [prompts, setPrompts] = useState(initialDraft.current.prompts ?? {});
  const [size, setSize] = useState(initialDraft.current.size ?? "auto");
  const [resolution, setResolution] = useState(initialDraft.current.resolution ?? "1k");
  const [nsfwCheck, setNsfwCheck] = useState(initialDraft.current.nsfwCheck ?? false);
  const [selectedTaskId, setSelectedTaskId] = useState(initialDraft.current.selectedTaskId ?? null);
  const [selectedInputId, setSelectedInputId] = useState(initialDraft.current.selectedInputId ?? null);
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);
  const [confirmation, setConfirmation] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [uncertainRequest, setUncertainRequest] = useState(initialDraft.current.uncertainRequest ?? null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const actionRef = useRef(null);
  const generationRef = useRef(0);
  const fileRef = useRef(null);
  const callbacksRef = useRef({ onError, onNotice, t });
  callbacksRef.current = { onError, onNotice, t };
  const uncertainRequestRef = useRef(null);
  uncertainRequestRef.current = uncertainRequest;
  const observedTasksRef = useRef(new Map());
  const prompt = prompts[tool.id] ?? t(tool.prompt);
  const sample = toolFocus?.sample;
  const sampleSide = String(toolFocus?.side ?? side ?? "src").toLowerCase();
  const selectedTask = tasks?.find(task => task.id === selectedTaskId) ?? null;
  const selectedInput = inputs.find(input => input.inputId === selectedInputId) ?? inputs[0];
  const providerProgress = Number.isFinite(selectedTask?.progress) ? Math.min(100, Math.max(0, selectedTask.progress)) : null;
  const selectedResult = selectedTask?.results?.find(result => result.index === selectedResultIndex) ?? selectedTask?.results?.[0];
  const previewUrl = safeLocalUrl(selectedTask ? selectedResult?.imageUrl : selectedInput?.imageUrl);
  const imageCount = inputs.length + imageUrls.length;
  const ready = Boolean(settings?.hasKey && !settingsError && !busy && !uncertainRequest && prompt.trim() && prompt.length <= 5000 && (tool.id === "generate" || imageCount));

  useEffect(() => {
    rememberProjectDraft(workspaceKey, { inputs, imageUrls, prompts, size, resolution, nsfwCheck, selectedInputId, selectedTaskId, uncertainRequest });
  }, [workspaceKey, inputs, imageUrls, prompts, size, resolution, nsfwCheck, selectedInputId, selectedTaskId, uncertainRequest]);

  useEffect(() => {
    const epoch = ++generationRef.current;
    const controller = new AbortController();
    let timer;
    const read = (action) => withRequestDeadline(signal => action({ signal }), { signal: controller.signal, timeoutMs: 12_000 });
    const acceptTasks = next => {
      if (controller.signal.aborted || epoch !== generationRef.current) return;
      setTasks(orderedTasks(next));
      setHistoryError(null);
      for (const task of next) {
        const previous = observedTasksRef.current.get(task.id);
        if (previous && previous !== task.status && ["completed", "failed"].includes(task.status)) {
          const { onNotice: notice, t: translate } = callbacksRef.current;
          notice?.(translate(task.status === "completed" ? "图像结果已保存到当前项目。" : "图像任务未完成，请查看任务说明。"), task.status === "completed" ? "success" : "warning");
        }
        if (previous) observedTasksRef.current.set(task.id, task.status);
      }
      const pendingRequest = uncertainRequestRef.current;
      const matchingTask = pendingRequest ? next.find(item => item.requestId === pendingRequest) : null;
      if (matchingTask) {
        const task = matchingTask;
        setSelectedTaskId(task.id);
        observedTasksRef.current.set(task.id, task.status);
        uncertainRequestRef.current = null;
        setUncertainRequest(null);
      }
    };
    const poll = async () => {
      try { acceptTasks(await read(runtimeApi.imageServiceTasks)); }
      catch (error) { if (!controller.signal.aborted) setHistoryError(error); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    };
    void Promise.allSettled([read(runtimeApi.imageServiceSettings), read(runtimeApi.imageServiceTasks)]).then(results => {
      if (controller.signal.aborted || epoch !== generationRef.current) return;
      if (results[0].status === "fulfilled") {
        setSettings(results[0].value);
        setModel(results[0].value.model ?? MODEL);
        setSettingsError(results[0].value.settingsError
          ? new Error(taskErrorMessage(results[0].value.settingsError) ?? t("本机配置无法读取，请保留原配置文件并检查。")) : null);
      } else setSettingsError(results[0].reason);
      if (results[1].status === "fulfilled") acceptTasks(results[1].value);
      else setHistoryError(results[1].reason);
      timer = setTimeout(poll, 3000);
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      actionRef.current?.controller.abort();
      actionRef.current = null;
    };
  }, [workspaceKey, refreshVersion]);

  const runAction = async (kind, action, accept, timeoutMs = 20_000) => {
    if (actionRef.current) return;
    const controller = new AbortController();
    const epoch = generationRef.current;
    const request = { controller, kind };
    actionRef.current = request;
    setBusy(kind);
    setActionError(null);
    try {
      const result = await withRequestDeadline(signal => action({ signal }), { signal: controller.signal, timeoutMs });
      if (!controller.signal.aborted && epoch === generationRef.current) accept(result);
    } catch (error) {
      if (!controller.signal.aborted && epoch === generationRef.current) {
        setActionError(error);
        callbacksRef.current.onError?.(error);
      }
      throw error;
    } finally {
      if (actionRef.current === request) {
        actionRef.current = null;
        setBusy(null);
      }
    }
  };

  const saveSettings = async (clearKey = false) => {
    const body = { model: model.trim(), ...(clearKey ? { clearKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
    try {
      await runAction("settings", options => runtimeApi.saveImageServiceSettings(body, options), result => {
        setSettings(result); setModel(result.model ?? MODEL); setApiKey(""); setSettingsError(result.settingsError ? new Error(taskErrorMessage(result.settingsError)) : null);
        onNotice?.(t(clearKey ? "本机 API Key 已删除。" : "图像服务配置已保存在本机。"));
      });
    } catch (error) {
      // A lost settings response must be resolved by reading the server again.
      setApiKey("");
      if (error?.name !== "AbortError" && (!error.status || error.status >= 500 || error.status === 408)) {
        setSettingsError(new Error(t("配置保存结果未确认，请重新读取配置。")));
      }
    }
  };

  const stageFiles = async fileList => {
    const files = [...fileList];
    if (!files.length) return;
    if (files.length + imageCount > MAX_IMAGES) { setActionError(new Error(t("参考图最多 15 张。"))); return; }
    if (files.some(file => file.size > MAX_IMAGE_BYTES || !/\.(jpe?g|png|webp)$/i.test(file.name))) {
      setActionError(new Error(t("请选择 JPG、PNG 或 WEBP，每张不超过 50 MB。"))); return;
    }
    try {
      await runAction("staging", async options => {
        const staged = [];
        for (const file of files) {
          const input = await runtimeApi.stageImageInput(file, options);
          if (options.signal.aborted) break;
          staged.push(input);
          setInputs(current => [...current, input]);
        }
        return staged;
      }, staged => {
        if (staged[0]) setSelectedInputId(staged[0].inputId);
        setSelectedTaskId(null);
        onNotice?.(t("素材仅暂存于本机，尚未发送到图像平台。"));
      }, 60_000);
    } catch { /* The successfully staged files remain visible. */ }
  };

  const stageSample = async () => {
    if (!sample?.name || imageCount >= MAX_IMAGES) return;
    try {
      await runAction("staging", options => runtimeApi.stageAlignedImageInput(sampleSide, sample.name, options), input => {
        setInputs(current => [...current, input]); setSelectedInputId(input.inputId); setSelectedTaskId(null);
        onNotice?.(t("素材仅暂存于本机，尚未发送到图像平台。"));
      });
    } catch { /* Local errors are presented inline. */ }
  };

  const addUrls = () => {
    const urls = urlDraft.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
    if (!urls.length) return;
    if (imageCount + urls.length > MAX_IMAGES) { setActionError(new Error(t("参考图最多 15 张。"))); return; }
    try {
      for (const url of urls) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
      }
    } catch { setActionError(new Error(t("图片链接需为不含账号密码的 HTTPS 地址。"))); return; }
    setImageUrls(current => [...current, ...urls]); setUrlDraft(""); setActionError(null);
  };

  const moveInput = (index, delta) => {
    setInputs(current => {
      const next = [...current];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  };
  const moveUrl = (index, delta) => {
    setImageUrls(current => {
      const next = [...current];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  };
  const review = () => {
    if (!ready) return;
    setConfirmation({ requestId: crypto.randomUUID(), mode: tool.id, prompt: prompt.trim(), model: settings.model, size, resolution, nsfwCheck, inputs: inputs.map(input => ({ ...input })), imageUrls: [...imageUrls] });
  };

  const submit = async () => {
    if (!confirmation || actionRef.current) return;
    const draft = confirmation;
    const inputIds = draft.inputs.map(input => input.inputId);
    // Preserve submission identity synchronously before any network work or navigation.
    uncertainRequestRef.current = draft.requestId;
    setUncertainRequest(draft.requestId);
    rememberProjectDraft(workspaceKey, { inputs, imageUrls, prompts, size, resolution, nsfwCheck, selectedInputId, selectedTaskId, uncertainRequest: draft.requestId });
    let accepted = false;
    try {
      await runAction("submitting", options => runtimeApi.createImageServiceTask({
        requestId: draft.requestId, mode: draft.mode, model: draft.model, prompt: draft.prompt, size: draft.size, resolution: draft.resolution,
        nsfwCheck: draft.nsfwCheck, inputs: inputIds, imageUrls: draft.imageUrls,
        consent: { provider: "qizhi", inputIds, imageUrls: draft.imageUrls },
      }, options), task => {
        accepted = true;
        setTasks(current => orderedTasks([task, ...(current ?? []).filter(item => item.id !== task.id)]));
        setSelectedTaskId(task.id); setSelectedResultIndex(0);
        uncertainRequestRef.current = null;
        setUncertainRequest(null);
        rememberProjectDraft(workspaceKey, { inputs, imageUrls, prompts, size, resolution, nsfwCheck, selectedInputId, selectedTaskId: task.id, uncertainRequest: null });
        observedTasksRef.current.set(task.id, task.status);
        setConfirmation(null);
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      setConfirmation(null);
      // Any ambiguous submission is checked by request ID; never automatically submit again.
      if (!accepted && (!error?.status || error.status >= 500 || error.status === 408)) {
        uncertainRequestRef.current = draft.requestId;
        setUncertainRequest(draft.requestId);
      } else {
        uncertainRequestRef.current = null;
        setUncertainRequest(null);
        rememberProjectDraft(workspaceKey, { inputs, imageUrls, prompts, size, resolution, nsfwCheck, selectedInputId, selectedTaskId, uncertainRequest: null });
      }
    }
  };

  const checkTask = async task => {
    try {
      await runAction("checking", options => runtimeApi.checkImageServiceTask(task.id, options), result => {
        setTasks(current => orderedTasks([result, ...(current ?? []).filter(item => item.id !== result.id)]));
        setSelectedTaskId(result.id);
        observedTasksRef.current.set(result.id, result.status);
      }, 60_000);
    } catch { /* Checking never creates another paid generation. */ }
  };

  return <section className="image-service-workbench" aria-labelledby="image-service-title">
    <header className="image-tools-heading"><div><span className="image-tools-kicker">{t("图像服务")}</span><h2 id="image-service-title">{t(tool.label)}</h2><p>{t(tool.description)}</p></div><a className="button secondary" href={REGISTRATION_URL} target="_blank" rel="noopener noreferrer"><IconExternalLink size={15} />{t("申请 API")}</a></header>
    <div className="image-tools-mode-switch image-service-modes" role="group" aria-label={t("图像工具模式")}>{IMAGE_TOOL_MODES.map(mode => <button aria-pressed={mode.id === tool.id} className={mode.id === tool.id ? "is-active" : ""} key={mode.id} type="button" disabled={Boolean(busy)} onClick={() => onToolChange(mode.id)}><IconPhoto size={15} />{t(mode.label)}</button>)}</div>
    <div className="image-service-body">
      <div className="image-service-main">
        <div className="image-service-preview">
          {previewUrl ? <img src={previewUrl} alt={selectedResult?.name ?? selectedInput?.name ?? t("图像预览")} decoding="async" /> : <div className="image-tools-empty"><IconPhoto size={32} /><strong>{t(selectedTask ? "结果尚未保存到本机" : "尚未选择素材")}</strong><p>{t("预览仅读取本机图片，外部链接不会自动加载。")}</p></div>}
          {selectedResult ? <a className="button secondary image-service-download" href={runtimeApi.imageResultUrl(selectedTask.id, selectedResult.index, { download: true })} download={selectedResult.name}><IconDownload size={15} />{t("下载结果")}</a> : null}
        </div>
        {selectedTask?.results?.length > 1 ? <div className="image-service-result-picker">{selectedTask.results.map(result => <button type="button" key={result.index} className={result.index === selectedResultIndex ? "is-active" : ""} onClick={() => setSelectedResultIndex(result.index)}>{result.name}</button>)}</div> : null}
        <section className="image-service-inputs" aria-label={t("本次素材范围")}>
          <header><strong>{t("参考素材")} <small>{imageCount} / {MAX_IMAGES}</small></strong><div><input ref={fileRef} hidden type="file" multiple accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={event => { const files = [...event.target.files]; event.target.value = ""; void stageFiles(files); }} /><button className="button secondary" type="button" disabled={Boolean(busy) || imageCount >= MAX_IMAGES} onClick={() => fileRef.current?.click()}>{busy === "staging" ? t("正在暂存…") : t("选择本机图片")}</button>{sample?.name ? <button className="button secondary" type="button" disabled={Boolean(busy) || imageCount >= MAX_IMAGES} onClick={() => void stageSample()}>{t("加入当前 aligned 图片")}</button> : null}</div></header>
          {sample?.name ? <p className="image-service-muted">{sampleSide.toUpperCase()} · {sample.name}</p> : null}
          <p className="image-service-muted">{t("选图只暂存于本机；确认素材范围后才会上传。最多 15 张，每张 50 MB。")}</p>
          {inputs.length ? <ol className="image-service-input-list">{inputs.map((input, index) => <li key={input.inputId}><button className="image-service-input-select" aria-pressed={!selectedTaskId && input.inputId === selectedInput?.inputId} type="button" onClick={() => { setSelectedInputId(input.inputId); setSelectedTaskId(null); }}><span>{index + 1}</span>{safeLocalUrl(input.imageUrl) ? <img src={safeLocalUrl(input.imageUrl)} alt="" loading="lazy" /> : <IconPhoto size={23} />}<strong>{input.name}</strong><small>{byteLabel(input.size)}</small></button><button className="icon-button quiet" type="button" disabled={Boolean(busy) || index === 0} aria-label={t("上移 {name}", { name: input.name })} onClick={() => moveInput(index, -1)}><IconArrowUp size={14} /></button><button className="icon-button quiet" type="button" disabled={Boolean(busy) || index === inputs.length - 1} aria-label={t("下移 {name}", { name: input.name })} onClick={() => moveInput(index, 1)}><IconArrowDown size={14} /></button><button className="icon-button quiet" type="button" disabled={Boolean(busy)} aria-label={t("移除 {name}", { name: input.name })} onClick={() => setInputs(current => current.filter(item => item.inputId !== input.inputId))}><IconX size={14} /></button></li>)}</ol> : null}
          <details className="image-service-links"><summary>{t("添加已有图片链接")}</summary><p>{t("平台将在确认后读取这些 HTTPS 图片链接；链接在本机素材之后按顺序提交。")}</p><label><span>{t("每行一个图片链接")}</span><textarea rows={2} value={urlDraft} disabled={Boolean(busy)} onChange={event => setUrlDraft(event.target.value)} /></label><button className="button secondary" type="button" disabled={Boolean(busy) || !urlDraft.trim()} onClick={addUrls}>{t("添加链接")}</button>{imageUrls.length ? <ol start={inputs.length + 1}>{imageUrls.map((url, index) => <li key={`${url}-${index}`}><code>{url}</code><button className="icon-button quiet" type="button" disabled={Boolean(busy) || index === 0} aria-label={t("上移链接 {number}", { number: index + 1 })} onClick={() => moveUrl(index, -1)}><IconArrowUp size={14} /></button><button className="icon-button quiet" type="button" disabled={Boolean(busy) || index === imageUrls.length - 1} aria-label={t("下移链接 {number}", { number: index + 1 })} onClick={() => moveUrl(index, 1)}><IconArrowDown size={14} /></button><button className="icon-button quiet" type="button" disabled={Boolean(busy)} aria-label={t("移除链接 {number}", { number: index + 1 })} onClick={() => setImageUrls(current => current.filter((_, i) => i !== index))}><IconX size={14} /></button></li>)}</ol> : null}</details>
        </section>
        <section className="image-service-history" aria-labelledby="image-service-history-title"><header><strong id="image-service-history-title">{t("当前项目的图像记录")}</strong><button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => setRefreshVersion(version => version + 1)}><IconRefresh size={14} />{t("重新读取")}</button></header>
          {historyError ? <p className="workspace-read-error" role="alert">{t("记录读取失败，保留上次结果；当前状态未知。")}</p> : null}
          {tasks === null ? <p className="image-service-muted">{t("正在读取图像记录…")}</p> : tasks.length ? <div className="image-service-task-list">{tasks.map(task => <button type="button" key={task.id} className={selectedTaskId === task.id ? "is-active" : ""} onClick={() => { setSelectedTaskId(task.id); setSelectedResultIndex(0); }}><span className={`image-service-state is-${task.status}`}>{t(STATUS_COPY[task.status] ?? task.status)}</span><strong>{task.prompt}</strong><small>{task.usage ? `${task.usage.amount} ${task.usage.currency}` : t("费用未返回")}</small><time>{new Date(task.createdAt).toLocaleString()}</time></button>)}</div> : <p className="image-service-muted">{t("当前项目还没有图像生成记录。")}</p>}
          {selectedTaskId && !selectedTask && tasks !== null ? <p className="workspace-read-error" role="alert">{t("此前选择的任务未出现在本次记录中，状态未知。")}</p> : null}{selectedTask ? <div className="image-service-task-detail"><dl><div><dt>{t("平台任务")}</dt><dd>{selectedTask.providerTaskId ?? t("尚未确认")}</dd></div><div><dt>{t("状态")}</dt><dd>{t(STATUS_COPY[selectedTask.status] ?? selectedTask.status)}{selectedTask.providerStatus ? ` · ${selectedTask.providerStatus}` : ""}</dd></div>{providerProgress !== null ? <div><dt>{t("平台进度")}</dt><dd className="image-service-progress"><progress max={100} value={providerProgress} aria-label={t("平台进度")} /><span>{providerProgress}%</span></dd></div> : null}<div><dt>{t("最终实扣")}</dt><dd>{selectedTask.usage ? `${selectedTask.usage.amount} ${selectedTask.usage.currency}` : t("待平台返回最终结算")}</dd></div><div><dt>{t("输出")}</dt><dd>{selectedTask.size} · {selectedTask.resolution}</dd></div></dl><details className="image-service-links"><summary>{t("查看生成参数与素材范围")}</summary><p className="image-service-history-prompt">{selectedTask.prompt}</p><p>{t("模型")}: {selectedTask.model} · {t(IMAGE_TOOL_MODES.find(mode => mode.id === selectedTask.mode)?.label ?? selectedTask.mode)}</p>{selectedTask.inputs?.length || selectedTask.imageUrls?.length ? <ol>{selectedTask.inputs?.map(input => <li key={input.inputId}>{input.name}</li>)}{selectedTask.imageUrls?.map((url, index) => <li key={`${url}-${index}`}><code>{url}</code></li>)}</ol> : <p>{t("本次只发送提示词，不发送图片。")}</p>}</details>{selectedTask.error ? <p className="workspace-read-error" role="alert">{t(taskErrorMessage(selectedTask.error) ?? "图像任务未完成，请查看任务说明。")}</p> : null}{selectedTask.status === "unconfirmed" ? <p className="image-service-muted">{t("平台可能已接收请求，不能盲目重新生成，请先在平台核对任务。")}</p> : null}{selectedTask.canCheck ? <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void checkTask(selectedTask)}><IconRefresh size={14} />{t("继续查询并保存结果")}</button> : null}</div> : null}
        </section>
      </div>
      <aside className="image-service-settings">
        <section className="image-service-credentials"><header><strong>{t("奇智 API")}</strong><code>{PROVIDER_URL}</code></header><label><span>{t("模型 ID")}</span><input type="text" value={model} maxLength={200} disabled={Boolean(busy)} onChange={event => setModel(event.target.value)} /></label><label><span>{t("本机 API Key")}</span><input type="password" value={apiKey} autoComplete="new-password" spellCheck={false} disabled={Boolean(busy)} placeholder={t(settings?.hasKey ? "已设置；留空保持原 Key" : "填写你的 API Key")} onChange={event => setApiKey(event.target.value)} /></label><p className="image-service-muted">{settings?.keyPersistence === "session-only" ? t("当前 Key 仅保存在服务内存，重启后需要重新填写。") : t("Key 由本机服务加密保存，不在浏览器中保存或回显。")}</p><div className="image-service-config-actions"><button className="button secondary" type="button" disabled={Boolean(busy) || !model.trim()} onClick={() => void saveSettings()}>{t("保存本机配置")}</button><button className="button secondary" type="button" disabled={Boolean(busy) || !settings?.hasKey} onClick={() => void saveSettings(true)}>{t("删除 Key")}</button></div>{settings?.keyError ? <p className="workspace-read-error" role="alert">{t(taskErrorMessage(settings.keyError) ?? "本机 Key 无法解密，请重新填写。")}</p> : null}{settingsError ? <div className="workspace-read-error" role="alert"><p>{t(settingsError.message)}</p><button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => setRefreshVersion(version => version + 1)}>{t("重新读取配置")}</button></div> : settings === null ? <p className="image-service-muted">{t("正在读取本机配置…")}</p> : null}</section>
        <section className="image-service-generation"><label className="image-tools-prompt"><span>{t("提示词")} <small>{prompt.length} / 5000</small></span><textarea rows={6} maxLength={5000} value={prompt} disabled={Boolean(busy)} onChange={event => setPrompts(current => ({ ...current, [tool.id]: event.target.value }))} /></label><div className="image-service-output-options"><label><span>{t("宽高比")}</span><select value={size} disabled={Boolean(busy)} onChange={event => setSize(event.target.value)}>{RATIOS.map(ratio => <option key={ratio} value={ratio}>{ratio === "auto" ? t("自动") : ratio}</option>)}</select></label><label><span>{t("输出分辨率")}</span><select value={resolution} disabled={Boolean(busy)} onChange={event => setResolution(event.target.value)}>{IMAGE_RESOLUTIONS.map(value => <option key={value} value={value}>{value}</option>)}</select></label></div><label className="image-service-checkbox"><input type="checkbox" checked={nsfwCheck} disabled={Boolean(busy)} onChange={event => setNsfwCheck(event.target.checked)} /><span>{t("生成前执行内容安全检查")}</span></label><p className="image-service-muted">{t("每次生成 1 张，结果保存在当前项目。平台结果链接约 24 小时失效，本地已保存结果可继续使用。")}</p><div className="image-service-note"><IconAlertTriangle size={16} /><p>{t("图片编辑结果由提示词与参考图决定。接口不支持遮罩局部重绘，也不保证人物特征或细节完全不变。")}</p></div>
          {actionError ? <p className="workspace-read-error" role="alert">{t(actionError.message)}</p> : null}
          {uncertainRequest ? <div className="workspace-read-error" role="alert"><p>{t("提交响应丢失，可能已经开始生成。保留请求标识，正在查询本机记录，不会重复提交。")}</p><code>{uncertainRequest}</code><button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => setRefreshVersion(version => version + 1)}>{t("只检查提交结果")}</button></div> : null}
          {!settings?.hasKey ? <p className="image-service-muted">{t("请先填写并保存本机 API Key。")}</p> : tool.id !== "generate" && !imageCount ? <p className="image-service-muted">{t("当前模式至少需要 1 张参考图。")}</p> : null}
          <button className="button primary image-tools-submit" type="button" disabled={!ready} onClick={review}><IconPlayerPlay size={16} />{t("核对素材并生成")}</button>
        </section>
      </aside>
    </div>
    <SubmissionConfirm draft={confirmation} busy={busy === "submitting"} onClose={() => setConfirmation(null)} onConfirm={() => void submit()} />
  </section>;
}
