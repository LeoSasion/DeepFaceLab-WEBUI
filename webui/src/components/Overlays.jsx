import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconChecks,
  IconCode,
  IconLock,
  IconPlayerStop,
  IconPlus,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import { taskTypes } from "../data/dashboard.js";
import { useI18n } from "../i18n.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";

export function useDialogFocus(open, onClose) {
  const dialogRef = useRef(null);
  const initialFocusRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    initialFocusRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialog) return;

      const focusable = [...dialog.querySelectorAll(
        "button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )];
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, open]);

  return { dialogRef, initialFocusRef };
}

function preflightRecovery(error, command, t) {
  if (!error || !command) return null;
  if (["PARAMETER_INVALID", "PARAMETERS_INVALID", "PARAMETER_NOT_ALLOWED"].includes(error.code)) {
    return { target: "parameters", label: t("返回修改参数") };
  }
  if (error.code === "XSEG_LABELS_MISSING") {
    return { target: "xseg", label: t("打开 XSeg 标注") };
  }
  if (error.code === "RESOURCE_LOCKED") {
    return { target: "console", label: t("查看占用任务") };
  }
  if (["INPUT_MISSING", "INPUT_EMPTY", "OUTPUT_MISSING", "OUTPUT_EMPTY"].includes(error.code)) {
    const targetByStage = {
      material: ["workspace", "打开工作区导入素材"],
      frames: ["workspace", "打开工作区导入素材"],
      faces: ["frames", "先提取视频帧"],
      sort: ["faces", "检查 aligned 人脸"],
      mask: ["xseg", "打开 XSeg 标注"],
      train: ["faces", "检查 aligned 人脸"],
      training: ["faces", "检查 aligned 人脸"],
      merge: ["training", "检查训练模型"],
      encode: ["merge", "先完成模型合成"],
    };
    const [target, label] = targetByStage[command.stage] ?? ["workspace", "检查工作区素材"];
    return { target, label: t(label) };
  }
  return { target: "workspace", label: t("检查工作区状态") };
}

export function Toast({ message, tone = "success", onDismiss }) {
  const { t } = useI18n();
  if (!message) return null;
  return (
    <div className={`toast is-${tone}`} role="status">
      {tone === "warning" ? <IconAlertTriangle size={18} stroke={2} /> : <IconCheck size={18} stroke={2.2} />}
      <span>{message}</span>
      <button type="button" className="icon-button quiet" aria-label={t("关闭提示")} onClick={onDismiss}>
        <IconX size={16} />
      </button>
    </div>
  );
}

export function NewTaskDialog({
  open,
  taskType,
  workspacePath,
  serviceOnline,
  commands,
  onTaskType,
  onPreflight,
  onResolvePreflight,
  onClose,
  onCreate,
}) {
  const { t } = useI18n();
  const { dialogRef, initialFocusRef } = useDialogFocus(open, onClose);
  const [step, setStep] = useState(1);
  const [parameters, setParameters] = useState({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [preflight, setPreflight] = useState({ state: "idle", data: null, error: null });
  const [submitting, setSubmitting] = useState(false);
  const availableCommands = useMemo(
    () => commands?.length
      ? commands
      : taskTypes.map((task) => ({
        ...task,
        label: t(task.label),
        description: t("本地 DeepFaceLab 固定工作流"),
        parameters: [],
        locks: [],
      })),
    [commands, t],
  );
  const selectedCommand = useMemo(
    () => availableCommands.find((command) => command.id === taskType) ?? availableCommands[0],
    [availableCommands, taskType],
  );
  const parameterSchemas = selectedCommand?.parameters ?? [];
  const visibleParameters = parameterSchemas.filter(
    (parameter) => showAdvanced || !parameter.advanced,
  );

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setShowAdvanced(false);
    setPreflight({ state: "idle", data: null, error: null });
  }, [open]);

  useEffect(() => {
    setParameters(Object.fromEntries(
      parameterSchemas.map((parameter) => [parameter.id, parameter.default]),
    ));
    setPreflight({ state: "idle", data: null, error: null });
  }, [selectedCommand?.id]);

  useEffect(() => {
    if (!open || step !== 3 || !selectedCommand) return undefined;
    let cancelled = false;
    setPreflight({ state: "checking", data: null, error: null });
    void onPreflight(selectedCommand.id, {
      launchMode: "guided",
      parameters,
    }).then((data) => {
      if (!cancelled) setPreflight({ state: "ready", data, error: null });
    }).catch((error) => {
      if (!cancelled) setPreflight({ state: "failed", data: null, error });
    });
    return () => {
      cancelled = true;
    };
  }, [onPreflight, open, parameters, selectedCommand, step]);

  if (!open) return null;

  const setParameter = (schema, rawValue) => {
    let value = rawValue;
    if (schema.type === "boolean") value = Boolean(rawValue);
    if (schema.type === "select") {
      value = schema.options.find((option) => String(option.value) === String(rawValue))?.value
        ?? rawValue;
    }
    setParameters((current) => ({ ...current, [schema.id]: value }));
    setPreflight({ state: "idle", data: null, error: null });
  };

  const formatParameter = (schema) => {
    const value = parameters[schema.id];
    if (value === "" || value === undefined || value === null) return t("自动 / 终端询问");
    if (schema.type === "boolean") return value ? t("是") : t("否");
    if (schema.type === "select") {
      return schema.options.find((option) => String(option.value) === String(value))?.label ?? String(value);
    }
    return `${value}${schema.suffix ? ` ${schema.suffix}` : ""}`;
  };

  const recovery = preflight.state === "failed"
    ? preflightRecovery(preflight.error, selectedCommand, t)
    : null;
  const resourceAdvice = preflight.state === "ready" ? preflight.data?.resources : null;

  const resolvePreflight = () => {
    if (!recovery) return;
    if (recovery.target === "parameters") {
      setStep(2);
      return;
    }
    onResolvePreflight?.(recovery.target);
  };

  const launch = async (launchMode) => {
    setSubmitting(true);
    try {
      await onCreate({
        launchMode,
        parameters: launchMode === "guided" ? parameters : {},
      });
    } finally {
      setSubmitting(false);
    }
  };

  const stepLabels = ["选择任务", "配置参数", "确认执行"].map((label) => t(label));

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="modal-card task-wizard"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        aria-describedby="new-task-description"
      >
        <header>
          <div>
            <span className="modal-icon"><IconPlus size={20} stroke={2} /></span>
            <div>
              <h2 id="new-task-title">{t("新建任务")}</h2>
              <p id="new-task-description">{t("用表单处理常用参数；高级或意外问答仍在终端继续。")}</p>
            </div>
          </div>
          <button className="icon-button quiet" type="button" aria-label={t("关闭")} onClick={onClose}>
            <IconX size={19} />
          </button>
        </header>

        <div className="wizard-progress" aria-label={t("任务创建进度")}>
          {stepLabels.map((label, index) => {
            const number = index + 1;
            return (
              <div
                key={label}
                className={`wizard-progress-item ${number === step ? "is-current" : ""} ${number < step ? "is-done" : ""}`}
              >
                <span>{number < step ? <IconCheck size={14} /> : number}</span>
                <strong>{label}</strong>
              </div>
            );
          })}
        </div>
        {submitting ? (
          <LoadingProgress inline compact label={t("正在创建任务并连接终端…")} detail={t("窗口会在任务成功创建后关闭")} operationKey="task-create" />
        ) : preflight.state === "checking" ? (
          <LoadingProgress inline compact label={t("正在执行前置检查…")} detail={t("正在核对素材、运行时与资源锁")} operationKey="task-preflight" />
        ) : null}

        <div className="wizard-body">
          <section className="wizard-main">
            {step === 1 && (
              <div className="wizard-step-panel">
                <label className="wizard-field">
                  <span>{t("任务类型")}</span>
                  <select
                    ref={initialFocusRef}
                    value={selectedCommand?.id ?? ""}
                    onChange={(event) => onTaskType(event.target.value)}
                  >
                    {availableCommands.map((command) => (
                      <option key={command.id} value={command.id}>{command.label}</option>
                    ))}
                  </select>
                </label>
                <div className="command-profile">
                  <span className="command-profile-icon"><IconSettings size={20} /></span>
                  <div className="preflight-copy">
                    <strong>{selectedCommand?.label}</strong>
                    <p>{selectedCommand?.description}</p>
                    <div className="command-tags">
                      <span>{selectedCommand?.profile === "legacy" ? "DFL legacy" : "DFL current"}</span>
                      <span>{selectedCommand?.stage ?? "workflow"}</span>
                      <span>{selectedCommand?.side?.toUpperCase?.() ?? "LOCAL"}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="wizard-step-panel">
                <div className="wizard-section-heading">
                  <div>
                    <strong>{selectedCommand?.label}</strong>
                    <p>{t("只显示该固定命令允许的参数。")}</p>
                  </div>
                  {parameterSchemas.some((parameter) => parameter.advanced) && (
                    <button
                      className={`text-button ${showAdvanced ? "is-active" : ""}`}
                      type="button"
                      onClick={() => setShowAdvanced((current) => !current)}
                    >
                      {showAdvanced ? t("收起高级参数") : t("显示高级参数")}
                    </button>
                  )}
                </div>
                {visibleParameters.length ? (
                  <div className="wizard-form-grid">
                    {visibleParameters.map((schema) => (
                      schema.type === "boolean" ? (
                        <label className="wizard-toggle" key={schema.id}>
                          <input
                            type="checkbox"
                            checked={Boolean(parameters[schema.id])}
                            onChange={(event) => setParameter(schema, event.target.checked)}
                          />
                          <span>
                            <strong>{schema.label}</strong>
                            {schema.help && <small>{schema.help}</small>}
                          </span>
                        </label>
                      ) : (
                        <label className="wizard-field" key={schema.id}>
                          <span>{schema.label}</span>
                          {schema.type === "select" ? (
                            <select
                              value={parameters[schema.id] ?? ""}
                              onChange={(event) => setParameter(schema, event.target.value)}
                            >
                              {schema.options.map((option) => (
                                <option key={String(option.value)} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          ) : (
                            <div className="wizard-input-wrap">
                              <input
                                type={schema.type}
                                value={parameters[schema.id] ?? ""}
                                min={schema.min}
                                max={schema.max}
                                step={schema.integer ? 1 : undefined}
                                placeholder={schema.placeholder}
                                onChange={(event) => setParameter(schema, event.target.value)}
                              />
                              {schema.suffix && <span>{schema.suffix}</span>}
                            </div>
                          )}
                          {schema.help && <small>{schema.help}</small>}
                        </label>
                      )
                    ))}
                  </div>
                ) : (
                  <div className="wizard-empty">
                    <IconChecks size={24} />
                    <strong>{t("此任务无需额外参数")}</strong>
                    <p>{t("继续后会检查素材、模型与资源锁。")}</p>
                  </div>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="wizard-step-panel">
                <div className={`preflight-banner is-${preflight.state}`}>
                  {preflight.state === "checking" && <span className="status-pulse" />}
                  {preflight.state === "ready" && <IconCheck size={18} />}
                  {preflight.state === "failed" && <IconAlertTriangle size={18} />}
                  <div>
                    <strong>
                      {preflight.state === "checking" && t("正在执行前置检查")}
                      {preflight.state === "ready" && t("前置检查通过")}
                      {preflight.state === "failed" && t("前置检查未通过")}
                      {preflight.state === "idle" && t("等待前置检查")}
                    </strong>
                    <p>
                      {preflight.error?.message
                        ? t(preflight.error.message)
                        : (preflight.state === "ready"
                          ? t("素材、运行时和资源锁均可用于创建任务。")
                          : t("不会在检查期间启动 DFL 进程。"))}
                    </p>
                    {preflight.error?.code ? <code>{preflight.error.code}</code> : null}
                  </div>
                  {recovery ? (
                    <button className="button secondary preflight-recovery" type="button" onClick={resolvePreflight}>
                      {recovery.label}<IconArrowRight size={15} />
                    </button>
                  ) : null}
                </div>
                {resourceAdvice ? (
                  <section
                    className={`preflight-resource-advice is-${resourceAdvice.severity ?? "info"}`}
                    aria-label={t("训练资源建议")}
                  >
                    <IconSettings size={17} aria-hidden="true" />
                    <div>
                      <strong>{t("显存与安全起点")}</strong>
                      <p>{t(resourceAdvice.summary ?? "训练资源状态已检查")}</p>
                      <dl>
                        {resourceAdvice.gpu ? (
                          <div>
                            <dt>{t("GPU")}</dt>
                            <dd>{resourceAdvice.gpu.name ?? `GPU ${resourceAdvice.gpu.index ?? "—"}`} · {resourceAdvice.gpu.freeGiB ?? "—"} / {resourceAdvice.gpu.totalGiB ?? "—"} GB {t("可用")}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>{t("建议参数")}</dt>
                          <dd>{t("分辨率 {resolution} · Batch {batch}", {
                            resolution: resourceAdvice.recommendation?.resolution ?? "—",
                            batch: resourceAdvice.recommendation?.batchSize ?? "—",
                          })}</dd>
                        </div>
                      </dl>
                      <small>{t("这是保守的安全起点，不保证最终显存占用；以 DFL 实际训练为准。")}</small>
                    </div>
                  </section>
                ) : null}
                <dl className="wizard-review">
                  <div><dt>{t("任务")}</dt><dd>{selectedCommand?.label}</dd></div>
                  {parameterSchemas.map((schema) => (
                    <div key={schema.id}><dt>{schema.label}</dt><dd>{formatParameter(schema)}</dd></div>
                  ))}
                </dl>
              </div>
            )}
          </section>

          <aside className="wizard-summary">
            <h3>{t("执行摘要")}</h3>
            <dl>
              <div><dt>{t("运行时")}</dt><dd>{selectedCommand?.profile === "legacy" ? "DFL legacy" : "DFL current"}</dd></div>
              <div><dt>{t("工作区")}</dt><dd title={workspacePath}>{workspacePath}</dd></div>
              <div>
                <dt><IconLock size={13} />{t("资源锁")}</dt>
                <dd>{selectedCommand?.locks?.length ? t("{count} 项", { count: selectedCommand.locks.length }) : t("无")}</dd>
              </div>
              <div><dt>{t("终端")}</dt><dd>{t("可交互 ConPTY")}</dd></div>
            </dl>
            <div className="wizard-summary-note">
              <IconCode size={16} />
              <p>{t("表单只生成服务端白名单参数。DFL 出现额外问题时，终端会自动等待你的输入。")}</p>
            </div>
          </aside>
        </div>

        <footer>
          <div className="wizard-footer-start">
            <button className="button secondary" type="button" onClick={onClose}>{t("取消")}</button>
            {step > 1 && (
              <button className="button secondary" type="button" onClick={() => setStep((current) => current - 1)}>
                <IconArrowLeft size={16} />{t("上一步")}
              </button>
            )}
          </div>
          <div className="wizard-footer-end">
            {step >= 2 && (
              <button
                className="button cli-button"
                type="button"
                onClick={() => void launch("cli")}
                disabled={!serviceOnline || submitting}
              >
                <IconCode size={16} />{t("保留 CLI 问答")}
              </button>
            )}
            {step < 3 ? (
              <button
                className="button primary"
                type="button"
                onClick={() => setStep((current) => current + 1)}
                disabled={!selectedCommand}
              >
                {t("下一步")}<IconArrowRight size={16} />
              </button>
            ) : (
              <button
                className="button primary"
                type="button"
                onClick={() => void launch("guided")}
                disabled={!serviceOnline || preflight.state !== "ready" || submitting}
              >
                <IconPlus size={17} />{t("启动任务")}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

export function StopConfirmDialog({ open, onCancel, onConfirm }) {
  const { t } = useI18n();
  const { dialogRef, initialFocusRef } = useDialogFocus(open, onCancel);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal-card stop-dialog"
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="stop-title"
        aria-describedby="stop-description"
      >
        <span className="stop-icon"><IconPlayerStop size={22} stroke={2} /></span>
        <h2 id="stop-title">{t("安全停止训练？")}</h2>
        <p id="stop-description">{t("训练已开始时会先请求保存；若仍在模型名称等启动问答阶段，则直接结束。12 秒未响应时会自动终止，避免永久停留。")}</p>
        <footer>
          <button ref={initialFocusRef} className="button secondary" type="button" onClick={onCancel}>{t("继续训练")}</button>
          <button className="button danger" type="button" onClick={onConfirm}>{t("确认安全停止")}</button>
        </footer>
      </section>
    </div>
  );
}
