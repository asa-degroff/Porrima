import { useState, useEffect, useCallback, useMemo } from "react";
import { Dropdown } from "./ui/Dropdown";
import { ToggleSwitch } from "./ui/ToggleSwitch";
import { useDropdown } from "../hooks/useDropdown";
import type { InferenceModel, Settings, AutomationTask } from "../types";
import type { AvailableLlamaModel, LlamaServerId, LlamaServerStatus, RuntimeModelApplyId } from "../api/client";
import {
  ModelsDirConflictError,
  applyLlamaSlotModel,
  fetchAutomations,
  getLlamaServers,
  listAvailableLlamaModels,
  updateAutomation,
  updateLlamaServerSettings,
} from "../api/client";
import { updatePersona } from "../api/persona";
import { updateUserDocument } from "../api/user";
import { getDefaultLlamaServerUrl } from "../utils/llamaPorts";

type SetupStep = "welcome" | "identity" | "system" | "models" | "automations" | "review";
type NoticeType = "ok" | "warn" | "err";

interface Props {
  settings: Settings;
  models: InferenceModel[];
  refreshModels: () => void;
  onSave: (settings: Settings) => void | Promise<void>;
  onClose: () => void;
}

type ModelOption = {
  id: string;
  name: string;
  source?: AvailableLlamaModel["source"] | "server";
  parameterSize?: string;
  sizeBytes?: number;
  kind?: AvailableLlamaModel["kind"] | string;
  scanDir?: string;
};

type SlotModelMap = Record<RuntimeModelApplyId, AvailableLlamaModel[]>;
type SlotStringMap = Record<RuntimeModelApplyId, string>;

const SETUP_SLOTS: RuntimeModelApplyId[] = ["inference", "extraction", "reranker", "embedding", "title-generation"];
const REQUIRED_SETUP_SLOTS = new Set<RuntimeModelApplyId>(SETUP_SLOTS);

const SLOT_LABELS: Record<RuntimeModelApplyId, string> = {
  inference: "Chat inference",
  extraction: "Memory extraction",
  reranker: "Reranker",
  embedding: "Embedding",
  "title-generation": "Title generation",
};

const STEPS: Array<{ id: SetupStep; label: string; description: string }> = [
  { id: "welcome", label: "Welcome", description: "Introduction" },
  { id: "identity", label: "Identity", description: "Name & persona" },
  { id: "system", label: "System", description: "Server readiness" },
  { id: "models", label: "Models", description: "Model selection" },
  { id: "automations", label: "Automations", description: "Synthesis & wake" },
  { id: "review", label: "Review", description: "Confirm & finish" },
];

const DEFAULT_USER_DOC = `# About Me

**Name:** (your name)

**Technical background:** (your background)

**Preferences:** (what you value)
`;

function emptySlotModels(): SlotModelMap {
  return {
    inference: [],
    extraction: [],
    reranker: [],
    embedding: [],
    "title-generation": [],
  };
}

function emptySlotStrings(): SlotStringMap {
  return {
    inference: "",
    extraction: "",
    reranker: "",
    embedding: "",
    "title-generation": "",
  };
}

function formatAutomationSchedule(schedule: { type: "interval" | "daily"; everyMinutes?: number; timeOfDay?: string }): string {
  if (schedule.type === "daily") {
    const time = schedule.timeOfDay || "09:00";
    return `Daily at ${time}`;
  }
  const minutes = schedule.everyMinutes || 1440;
  if (minutes % (24 * 60) === 0) return `Every ${minutes / (24 * 60)} day(s)`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hour(s)`;
  return `Every ${minutes} minutes`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return "";
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

function modelOptionKey(m: Pick<ModelOption, "id" | "scanDir" | "source">): string {
  return `${m.id}::${m.scanDir || m.source || "unknown"}`;
}

function modelOptionLabel(m: Pick<ModelOption, "name" | "scanDir" | "source">): string {
  const suffix = m.scanDir ? m.scanDir.replace(/^\/home\/[^/]+/, "~") : m.source && m.source !== "disk" ? m.source : "";
  return suffix ? `${m.name} (${suffix})` : m.name;
}

function serverReady(server: LlamaServerStatus | undefined): boolean {
  return Boolean(
    server &&
    server.systemd.loadState === "loaded" &&
    server.systemd.activeState === "active" &&
    server.http.status === "ok"
  );
}

function modelVerified(server: LlamaServerStatus | undefined, modelId: string): boolean {
  if (!server || !modelId || server.http.status !== "ok") return false;
  if (server.http.routerMode) return server.http.loadedModelId === modelId;
  return (
    server.http.loadedModelId === modelId ||
    server.http.modelIds.includes(modelId)
  );
}

function modelKnownToServer(server: LlamaServerStatus | undefined, modelId: string): boolean {
  if (!server || !modelId || server.http.status !== "ok") return false;
  return server.http.loadedModelId === modelId || server.http.modelIds.includes(modelId);
}

function verificationLabel(server: LlamaServerStatus | undefined, modelId: string): string {
  if (!modelId) return "No model";
  if (!server || server.http.status !== "ok") return "Unknown";
  if (modelVerified(server, modelId)) return "Verified";
  if (modelKnownToServer(server, modelId)) return "Available";
  return "Not found";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusBadgeClass(type: NoticeType): string {
  if (type === "ok") return "border-emerald-400/30 bg-emerald-500/15 text-emerald-200";
  if (type === "warn") return "border-amber-400/30 bg-amber-500/15 text-amber-200";
  return "border-red-400/30 bg-red-500/15 text-red-200";
}

function noticeClass(type: NoticeType): string {
  if (type === "ok") return "border-emerald-400/20 bg-emerald-500/10 text-emerald-200/90";
  if (type === "warn") return "border-amber-400/20 bg-amber-500/10 text-amber-200/90";
  return "border-red-400/20 bg-red-500/10 text-red-300/90";
}

function slotStatus(server: LlamaServerStatus | undefined): { type: NoticeType; label: string } {
  if (!server) return { type: "err", label: "Missing" };
  if (serverReady(server)) return { type: "ok", label: "Ready" };
  if (server.systemd.loadState !== "loaded") return { type: "err", label: "Not installed" };
  if (server.systemd.activeState !== "active") return { type: "err", label: server.systemd.activeState };
  if (server.http.status !== "ok") return { type: "err", label: "HTTP down" };
  return { type: "warn", label: "Check" };
}

export function SetupModal({ settings, models, refreshModels, onSave, onClose }: Props) {
  const [currentStep, setCurrentStep] = useState<SetupStep>("welcome");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: NoticeType; text: string } | null>(null);

  const [agentName, setAgentName] = useState(settings.agentName || "");
  const [personaContent, setPersonaContent] = useState("");
  const [userDocContent, setUserDocContent] = useState("");
  const [personaLoading, setPersonaLoading] = useState(true);
  const [userDocLoading, setUserDocLoading] = useState(true);

  const [llamaServers, setLlamaServers] = useState<LlamaServerStatus[]>([]);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupRefreshMessage, setSetupRefreshMessage] = useState<string | null>(null);
  const [applyingModels, setApplyingModels] = useState(false);
  const [slotModels, setSlotModels] = useState<SlotModelMap>(() => emptySlotModels());
  const [slotModelsLoading, setSlotModelsLoading] = useState(false);
  const [selectedScanDirs, setSelectedScanDirs] = useState<SlotStringMap>(() => emptySlotStrings());

  const [selectedModelId, setSelectedModelId] = useState(settings.defaultModelId || "");
  const [extractionModelId, setExtractionModelId] = useState(settings.extractionModelId || settings.defaultModelId || "");
  const [rerankerModel, setRerankerModel] = useState(settings.rerankerModelId || "");
  const [embeddingModel, setEmbeddingModel] = useState(settings.embeddingModel || "");
  const [titleModel, setTitleModel] = useState(settings.titleGenerationModelId || "");

  const modelDd = useDropdown();
  const extractionDd = useDropdown();
  const rerankerDd = useDropdown();
  const embeddingDd = useDropdown();
  const titleDd = useDropdown();

  const [automations, setAutomations] = useState<AutomationTask[]>([]);
  const [automationsLoading, setAutomationsLoading] = useState(true);
  const [synthesisSchedule, setSynthesisSchedule] = useState<{ type: "interval" | "daily"; everyMinutes?: number; timeOfDay?: string }>({ type: "interval", everyMinutes: 24 * 60 });
  const [wakeEnabled, setWakeEnabled] = useState(settings.wakeCycleEnabled ?? false);
  const [wakeInterval, setWakeInterval] = useState(settings.wakeCycleIntervalHours ?? 6);
  const [sleepThreshold, setSleepThreshold] = useState(settings.sleepCycleThresholdMinutes ?? 60);

  const serverById = useMemo(() => {
    const map = new Map<LlamaServerId, LlamaServerStatus>();
    for (const server of llamaServers) map.set(server.id, server);
    return map;
  }, [llamaServers]);

  const modelOptionsBySlot = useMemo<Record<RuntimeModelApplyId, ModelOption[]>>(() => {
    const mapped = Object.fromEntries(
      SETUP_SLOTS.map((slot) => [
        slot,
        slotModels[slot].map((m) => ({
          id: m.id,
          name: m.name,
          source: m.source,
          sizeBytes: m.sizeBytes,
          kind: m.kind,
          scanDir: m.scanDir,
        })),
      ])
    ) as Record<RuntimeModelApplyId, ModelOption[]>;

    if (mapped.inference.length === 0 && models.length > 0) {
      mapped.inference = models.map((m) => ({
        id: m.id,
        name: m.name,
        source: "server",
        parameterSize: m.parameterSize,
      }));
    }

    return mapped;
  }, [models, slotModels]);

  const effectiveModelIds = useMemo<Record<RuntimeModelApplyId, string>>(() => ({
    inference: selectedModelId || modelOptionsBySlot.inference[0]?.id || "",
    extraction: extractionModelId || selectedModelId || modelOptionsBySlot.extraction[0]?.id || "",
    reranker: rerankerModel || modelOptionsBySlot.reranker[0]?.id || "",
    embedding: embeddingModel || modelOptionsBySlot.embedding[0]?.id || "",
    "title-generation": titleModel || modelOptionsBySlot["title-generation"][0]?.id || "",
  }), [embeddingModel, extractionModelId, modelOptionsBySlot, rerankerModel, selectedModelId, titleModel]);

  const selectedModel = modelOptionsBySlot.inference.find((m) => m.id === effectiveModelIds.inference);

  const findSelectedOption = useCallback((slot: RuntimeModelApplyId, modelId: string): ModelOption | undefined => {
    const scanDir = selectedScanDirs[slot];
    const options = modelOptionsBySlot[slot];
    return options.find((m) => m.id === modelId && (!scanDir || m.scanDir === scanDir)) || options.find((m) => m.id === modelId);
  }, [modelOptionsBySlot, selectedScanDirs]);

  const selectSlotModel = useCallback((slot: RuntimeModelApplyId, model: ModelOption) => {
    if (slot === "inference") setSelectedModelId(model.id);
    if (slot === "extraction") setExtractionModelId(model.id);
    if (slot === "reranker") setRerankerModel(model.id);
    if (slot === "embedding") setEmbeddingModel(model.id);
    if (slot === "title-generation") setTitleModel(model.id);
    setSelectedScanDirs((current) => ({ ...current, [slot]: model.scanDir || "" }));
  }, []);

  const readiness = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const slot of SETUP_SLOTS) {
      const label = SLOT_LABELS[slot];
      const server = serverById.get(slot);
      const modelId = effectiveModelIds[slot];
      const ready = serverReady(server);
      const modelOption = modelId ? findSelectedOption(slot, modelId) : undefined;
      const serverKnowsModel = modelKnownToServer(server, modelId);

      if (REQUIRED_SETUP_SLOTS.has(slot)) {
        if (!modelId) {
          errors.push(`${label} has no model selected or discovered.`);
        } else if (!modelOption && !serverKnowsModel) {
          errors.push(`${label} model ${modelId} was not found in configured scan paths or reported by the server.`);
        }
        if (!ready) errors.push(`${label} server is not ready.`);
      }

      // Only enforce model-name verification for router mode, where multiple models
      // compete and you need to confirm the right one is loaded. Dedicated servers
      // (reranker, embedding, etc.) load their model at startup via config — if the
      // server is healthy, the model is functioning regardless of name matching.
      if (modelId && ready && server?.http.routerMode && !modelVerified(server, modelId)) {
        warnings.push(`${label} is ready, but ${modelId} is not the active verified model yet. Apply the selection to finish verification.`);
      }
    }

    return { errors, warnings };
  }, [effectiveModelIds, findSelectedOption, serverById]);

  const hasSetupFailures = !setupLoading && readiness.errors.length > 0;

  const refreshSetupState = useCallback(async (showSpinner = false) => {
    if (showSpinner) setSetupLoading(true);
    setSlotModelsLoading(true);
    setSetupRefreshMessage(null);
    try {
      const [servers, ...modelResults] = await Promise.all([
        getLlamaServers(),
        ...SETUP_SLOTS.map((slot) => listAvailableLlamaModels(slot)),
      ]);

      const nextModels = emptySlotModels();
      SETUP_SLOTS.forEach((slot, index) => {
        nextModels[slot] = modelResults[index].models;
      });

      setLlamaServers(servers.servers);
      setSlotModels(nextModels);

      setSelectedModelId((current) => current || settings.defaultModelId || nextModels.inference[0]?.id || "");
      setExtractionModelId((current) => current || settings.extractionModelId || settings.defaultModelId || nextModels.extraction[0]?.id || nextModels.inference[0]?.id || "");
      setRerankerModel((current) => current || settings.rerankerModelId || nextModels.reranker[0]?.id || "");
      setEmbeddingModel((current) => current || settings.embeddingModel || nextModels.embedding[0]?.id || "");
      setTitleModel((current) => current || settings.titleGenerationModelId || nextModels["title-generation"][0]?.id || "");
    } catch (err: any) {
      setSetupRefreshMessage(err?.message || "Failed to load llama.cpp setup status");
    } finally {
      setSlotModelsLoading(false);
      if (showSpinner) setSetupLoading(false);
    }
  }, [settings.defaultModelId, settings.embeddingModel, settings.extractionModelId, settings.rerankerModelId, settings.titleGenerationModelId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import("../api/persona").then((m) => m.getPersona()),
      import("../api/user").then((m) => m.getUserDocument()),
    ]).then(([persona, userDoc]) => {
      if (cancelled) return;
      if (persona) setPersonaContent(persona.content);
      setUserDocContent(userDoc?.content || DEFAULT_USER_DOC);
    }).catch(() => {}).finally(() => {
      if (!cancelled) {
        setPersonaLoading(false);
        setUserDocLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAutomations().then((autos) => {
      if (cancelled) return;
      const tasks = autos.tasks || [];
      setAutomations(tasks);
      const synth = tasks.find((a: AutomationTask) => a.id === "builtin:synthesis");
      const wake = tasks.find((a: AutomationTask) => a.id === "builtin:wake");
      if (synth) setSynthesisSchedule(synth.schedule);
      if (wake) {
        setWakeEnabled(wake.enabled);
        if (wake.schedule.type === "interval") setWakeInterval((wake.schedule.everyMinutes || 6 * 60) / 60);
      }
    }).catch(() => {}).finally(() => {
      if (!cancelled) setAutomationsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    refreshSetupState(true);
  }, [refreshSetupState]);

  const waitForModelVerification = useCallback(async (): Promise<LlamaServerStatus[]> => {
    const deadline = Date.now() + 180_000;
    let lastFailures: string[] = [];

    while (true) {
      const result = await getLlamaServers();
      const servers = result.servers;
      const nextById = new Map<LlamaServerId, LlamaServerStatus>();
      for (const server of servers) nextById.set(server.id, server);
      setLlamaServers(servers);

      lastFailures = SETUP_SLOTS.flatMap((slot) => {
        const label = SLOT_LABELS[slot];
        const modelId = effectiveModelIds[slot];
        const server = nextById.get(slot);

        if (!modelId) return [`${label} has no model selected.`];
        if (!serverReady(server)) return [`${label} server is not ready after applying the model.`];
        // Only enforce model-name verification for router mode.
        if (server?.http.routerMode && !modelVerified(server, modelId)) {
          const reported = server?.http.loadedModelId || server?.http.modelIds.join(", ") || "none";
          return [`${label} did not verify ${modelId} as active; reported ${reported}.`];
        }
        return [];
      });

      if (lastFailures.length === 0) return servers;
      if (Date.now() >= deadline) {
        throw new Error(lastFailures.join(" "));
      }
      await delay(1500);
    }
  }, [effectiveModelIds]);

  const handleNext = useCallback(() => {
    const idx = STEPS.findIndex((s) => s.id === currentStep);
    if (idx < STEPS.length - 1) setCurrentStep(STEPS[idx + 1].id);
  }, [currentStep]);

  const handleBack = useCallback(() => {
    const idx = STEPS.findIndex((s) => s.id === currentStep);
    if (idx > 0) setCurrentStep(STEPS[idx - 1].id);
  }, [currentStep]);

  const applyModelSelections = useCallback(async () => {
    setApplyingModels(true);
    setMessage(null);
    const warnings: string[] = [];
    const nextServers = new Map<LlamaServerId, LlamaServerStatus>(serverById);

    try {
      for (const slot of SETUP_SLOTS) {
        const modelId = effectiveModelIds[slot];
        const label = SLOT_LABELS[slot];
        const server = nextServers.get(slot);

        if (!modelId) {
          const text = `${label} has no model selected.`;
          if (REQUIRED_SETUP_SLOTS.has(slot)) throw new Error(text);
          warnings.push(text);
          continue;
        }

        if (!serverReady(server)) {
          const text = `${label} server is not ready.`;
          if (REQUIRED_SETUP_SLOTS.has(slot)) throw new Error(text);
          warnings.push(text);
          continue;
        }

        if (modelVerified(server, modelId)) continue;

        const option = findSelectedOption(slot, modelId);
        let updated: LlamaServerStatus;

        try {
          if ((slot === "embedding" || slot === "reranker") && option?.source !== "disk") {
            const result = await updateLlamaServerSettings(slot, slot === "embedding"
              ? { provider: "llamacpp", modelId }
              : { modelId });
            updated = result.server;
          } else {
            if (!option && slot !== "embedding" && slot !== "reranker") {
              throw new Error(`${label} model ${modelId} was not found in configured model scan paths.`);
            }
            const result = await applyLlamaSlotModel(slot, modelId, { scanDir: option?.scanDir });
            updated = result.server;
          }
        } catch (err: any) {
          const text = err instanceof ModelsDirConflictError
            ? `${label} model ${err.conflict.modelId} is in ${err.conflict.modelScanDir}, but the service reads ${err.conflict.currentModelsDir}. Reconfigure that service models directory in Settings, then rerun setup.`
            : err?.message || `Failed to apply ${label} model.`;
          if (REQUIRED_SETUP_SLOTS.has(slot)) throw new Error(text);
          warnings.push(text);
          continue;
        }

        nextServers.set(slot, updated);
        setLlamaServers((current) => current.map((serverItem) => serverItem.id === slot ? updated : serverItem));
      }

      await waitForModelVerification();
      await refreshSetupState();
      refreshModels();
      setMessage({
        type: warnings.length ? "warn" : "ok",
        text: warnings.length ? `Required models verified. ${warnings.join(" ")}` : "Selected models verified.",
      });
    } catch (err: any) {
      throw err;
    } finally {
      setApplyingModels(false);
    }
  }, [effectiveModelIds, findSelectedOption, refreshModels, refreshSetupState, serverById, waitForModelVerification]);

  const handleApplyModels = useCallback(async () => {
    try {
      await applyModelSelections();
    } catch (err: any) {
      setMessage({ type: "err", text: err?.message || "Failed to apply selected models" });
    }
  }, [applyModelSelections]);

  const handleFinish = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      if (readiness.errors.length > 0) {
        throw new Error(readiness.errors.join(" "));
      }

      await applyModelSelections();

      const newSettings: Settings = {
        ...settings,
        setupCompleted: true,
        agentName: agentName.trim(),
        defaultModelId: effectiveModelIds.inference,
        extractionModelId: effectiveModelIds.extraction || effectiveModelIds.inference || undefined,
        extractionModelUrl: settings.extractionModelUrl || getDefaultLlamaServerUrl("extraction"),
        rerankerEnabled: true,
        rerankerUrl: settings.rerankerUrl || getDefaultLlamaServerUrl("reranker"),
        rerankerModelId: effectiveModelIds.reranker || undefined,
        embeddingProvider: "llamacpp",
        embeddingUrl: settings.embeddingUrl || getDefaultLlamaServerUrl("embedding"),
        embeddingModel: effectiveModelIds.embedding || undefined,
        titleGenerationEnabled: true,
        titleGenerationUrl: settings.titleGenerationUrl || getDefaultLlamaServerUrl("title-generation"),
        titleGenerationModelId: effectiveModelIds["title-generation"] || undefined,
        llamacppEnabled: true,
        llamacppUrl: settings.llamacppUrl || getDefaultLlamaServerUrl("inference"),
        wakeCycleEnabled: wakeEnabled,
        wakeCycleIntervalHours: wakeEnabled ? wakeInterval : settings.wakeCycleIntervalHours,
        sleepCycleThresholdMinutes: sleepThreshold,
      };

      const results: Promise<unknown>[] = [
        updatePersona(personaContent, "Setup wizard").catch(() => {}),
        updateUserDocument(userDocContent).catch(() => {}),
        Promise.resolve(onSave(newSettings)),
      ];

      const synth = automations.find((a) => a.id === "builtin:synthesis");
      if (synth) results.push(updateAutomation(synth.id, { schedule: synthesisSchedule }).catch(() => {}));

      const wake = automations.find((a) => a.id === "builtin:wake");
      if (wake) {
        const wakeMinutes = (wakeEnabled ? wakeInterval : settings.wakeCycleIntervalHours ?? 6) * 60;
        results.push(updateAutomation(wake.id, {
          enabled: wakeEnabled,
          schedule: { type: "interval", everyMinutes: wakeMinutes },
        }).catch(() => {}));
      }

      await Promise.all(results);
      onClose();
    } catch (err: any) {
      setMessage({ type: "err", text: err?.message || "Failed to save setup" });
    } finally {
      setLoading(false);
    }
  }, [agentName, applyModelSelections, automations, effectiveModelIds, onClose, onSave, personaContent, readiness.errors, settings, sleepThreshold, synthesisSchedule, userDocContent, wakeEnabled, wakeInterval]);

  const handleSkip = useCallback(async () => {
    try {
      await onSave({ ...settings, setupCompleted: true });
    } finally {
      onClose();
    }
  }, [onClose, onSave, settings]);

  const stepIndex = STEPS.findIndex((s) => s.id === currentStep);

  const renderModelDropdown = (
    slot: RuntimeModelApplyId,
    dropdown: ReturnType<typeof useDropdown>,
    value: string,
    placeholder: string,
  ) => {
    const options = modelOptionsBySlot[slot];
    const selected = value ? findSelectedOption(slot, value) : undefined;
    return (
      <Dropdown
        state={dropdown}
        trigger={<span className="truncate flex-1 text-left">{selected ? modelOptionLabel(selected) : value || placeholder}</span>}
      >
        {slotModelsLoading && <div className="px-3 py-2 text-xs text-white/35">Scanning models...</div>}
        {options.length === 0 && !slotModelsLoading && (
          <div className="px-3 py-2 text-xs text-white/35">No models found for this role</div>
        )}
        {options.map((m) => {
          const active = m.id === value && (!selectedScanDirs[slot] || selectedScanDirs[slot] === (m.scanDir || ""));
          return (
            <button
              key={modelOptionKey(m)}
              onClick={() => { selectSlotModel(slot, m); dropdown.close(); }}
              className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center gap-2 ${
                active ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
              }`}
              style={{ backgroundColor: active ? `rgba(var(--theme-secondary), 0.15)` : "transparent" }}
            >
              <span className="truncate flex-1">{modelOptionLabel(m)}</span>
              <span className="text-[10px] text-white/30 shrink-0">{m.parameterSize || formatBytes(m.sizeBytes)}</span>
            </button>
          );
        })}
      </Dropdown>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && currentStep === "welcome") handleSkip();
      }}
    >
      <div className="w-full max-w-3xl mx-4 backdrop-blur-xl bg-white/[0.08] border border-white/15 rounded-2xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white/90">Setup</h2>
            <p className="text-xs text-white/40 mt-0.5">{STEPS[stepIndex]?.description}</p>
          </div>
          <button
            onClick={handleSkip}
            className="text-white/40 hover:text-white/70 transition-colors pressable"
            title="Skip setup"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-3 border-b border-white/5 shrink-0 overflow-x-auto">
          <div className="flex items-center gap-1 min-w-max">
            {STEPS.map((step, i) => (
              <div key={step.id} className="flex items-center gap-1">
                <div
                  className={`w-6 h-6 rounded-full text-[10px] font-medium flex items-center justify-center transition-all ${
                    i === stepIndex
                      ? "bg-purple-500/30 text-purple-200 border border-purple-400/40"
                      : i < stepIndex
                        ? "bg-purple-500/15 text-purple-300/70 border border-purple-400/20"
                        : "bg-white/5 text-white/30 border border-white/10"
                  }`}
                  title={step.label}
                >
                  {i < stepIndex ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`w-4 h-px transition-all ${i < stepIndex ? "bg-purple-400/40" : "bg-white/10"}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 min-h-0">
          {currentStep === "welcome" && (
            <div className="space-y-5 text-center py-4">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-purple-500/15 border border-purple-400/25 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-purple-300">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div>
                <h3 className="text-xl font-semibold text-white/90 mb-2">Welcome to Porrima</h3>
                <p className="text-sm text-white/50 max-w-md mx-auto leading-relaxed">
                  This will verify the host install, choose local models, and tune the first-run defaults.
                </p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-lg mx-auto text-left">
                {[
                  { title: "Identity", desc: "Name, persona, and user info" },
                  { title: "System", desc: "llama.cpp services and models" },
                  { title: "Models", desc: "Apply model choices" },
                  { title: "Automations", desc: "Synthesis and wake schedules" },
                  { title: "Review", desc: "Confirm everything" },
                ].map((item) => (
                  <div key={item.title} className="rounded-lg border border-white/10 bg-white/5 p-3">
                    <div className="text-xs font-medium text-white/70">{item.title}</div>
                    <div className="text-[10px] text-white/35 mt-0.5">{item.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {currentStep === "identity" && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-white/60 mb-1">Agent Name</label>
                <input
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all"
                />
                <p className="text-[10px] text-white/30 mt-1">Shown in the sidebar and throughout the UI</p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-white/60">Persona</label>
                  {personaLoading && <span className="text-[10px] text-white/30">Loading...</span>}
                </div>
                <textarea
                  value={personaContent}
                  onChange={(e) => setPersonaContent(e.target.value)}
                  rows={8}
                  placeholder="Your agent's personality and behavior..."
                  className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-xs text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all font-mono resize-y"
                />
                <p className="text-[10px] text-white/30 mt-1">This defines how your agent thinks and communicates. Edit freely.</p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-white/60">About You</label>
                  {userDocLoading && <span className="text-[10px] text-white/30">Loading...</span>}
                </div>
                <textarea
                  value={userDocContent}
                  onChange={(e) => setUserDocContent(e.target.value)}
                  rows={5}
                  placeholder="# About Me\n\nYour background, preferences..."
                  className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-xs text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all font-mono resize-y"
                />
                <p className="text-[10px] text-white/30 mt-1">Anything you want to provide about yourself.</p>
              </div>
            </div>
          )}

          {currentStep === "system" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-white/90">System check</h3>
                  <p className="text-xs text-white/40 mt-1">Core setup expects systemd user services and local GGUF models.</p>
                </div>
                <button
                  type="button"
                  onClick={() => refreshSetupState(true)}
                  disabled={setupLoading}
                  className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs text-white/60 hover:bg-white/10 hover:text-white/80 disabled:opacity-40 transition-all pressable"
                >
                  {setupLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              {setupRefreshMessage && (
                <div className={`text-xs p-3 rounded-lg border ${noticeClass("err")}`}>{setupRefreshMessage}</div>
              )}

              <div className="space-y-2">
                {SETUP_SLOTS.map((slot) => {
                  const server = serverById.get(slot);
                  const status = slotStatus(server);
                  const modelId = effectiveModelIds[slot];
                  const verified = modelVerified(server, modelId);
                  return (
                    <div key={slot} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white/70">{SLOT_LABELS[slot]}</span>
                            {REQUIRED_SETUP_SLOTS.has(slot) && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded border border-purple-400/25 bg-purple-500/10 text-purple-200/80">required</span>
                            )}
                          </div>
                          <div className="text-[10px] text-white/35 mt-1 truncate">{server?.unitName || "service missing"} · {server?.url || getDefaultLlamaServerUrl(slot)}</div>
                        </div>
                        <span className={`text-[10px] px-2 py-1 rounded border shrink-0 ${statusBadgeClass(status.type)}`}>{status.label}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] mt-3">
                        <span className="text-white/35">Selected model</span>
                        <span className="text-white/65 text-right truncate">{modelId || "None"}</span>
                        <span className="text-white/35">Active model</span>
                        <span className={`text-right ${verified ? "text-emerald-300/80" : "text-amber-200/80"}`}>{verificationLabel(server, modelId)}</span>
                        <span className="text-white/35">Discovered choices</span>
                        <span className="text-white/65 text-right">{modelOptionsBySlot[slot].length}</span>
                      </div>
                      {server?.http.error && <div className="text-[10px] text-red-300/70 mt-2">{server.http.error}</div>}
                    </div>
                  );
                })}
              </div>

              {(readiness.errors.length > 0 || readiness.warnings.length > 0) && (
                <div className={`text-xs p-3 rounded-lg border ${noticeClass(readiness.errors.length ? "err" : "warn")}`}>
                  {[...readiness.errors, ...readiness.warnings].slice(0, 6).map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {currentStep === "models" && (
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-white/90">Models</h3>
                  <p className="text-xs text-white/40 mt-1">Selections are applied to the managed llama.cpp slots.</p>
                </div>
                <button
                  type="button"
                  onClick={handleApplyModels}
                  disabled={applyingModels || setupLoading}
                  className="px-3 py-2 rounded-lg border border-purple-400/30 bg-purple-500/20 text-xs text-purple-100 hover:bg-purple-500/30 disabled:opacity-40 transition-all pressable"
                >
                  {applyingModels ? "Applying..." : "Apply & verify"}
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-white/60 mb-1">Main Chat Model</label>
                {renderModelDropdown("inference", modelDd, effectiveModelIds.inference, "Select a chat model")}
                <p className="text-[10px] text-white/30 mt-1">The default model used for new agent chats.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-white/60 mb-1">Memory Extraction Model</label>
                {renderModelDropdown("extraction", extractionDd, effectiveModelIds.extraction, "Select an extraction model")}
                <p className="text-[10px] text-white/30 mt-1">A CPU-oriented chat model used to extract memories from conversations.</p>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-4">
                <div className="flex items-center gap-2 text-purple-300/80">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  </svg>
                  <span className="text-xs font-medium">Background servers</span>
                </div>

                <div>
                  <label className="block text-xs font-medium text-white/50 mb-1">Reranker model</label>
                  {renderModelDropdown("reranker", rerankerDd, effectiveModelIds.reranker, "Select a reranker model")}
                  <p className="text-[10px] text-white/25 mt-0.5">Cross-encoder reranking for memory retrieval.</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-white/50 mb-1">Embedding model</label>
                  {renderModelDropdown("embedding", embeddingDd, effectiveModelIds.embedding, "Select an embedding model")}
                  <p className="text-[10px] text-white/25 mt-0.5">Generates memory vectors. This is required for core memory search.</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-white/50 mb-1">Title generation model</label>
                  {renderModelDropdown("title-generation", titleDd, effectiveModelIds["title-generation"], "Select a title model")}
                  <p className="text-[10px] text-white/25 mt-0.5">Generates short chat titles and notification summaries.</p>
                </div>
              </div>
            </div>
          )}

          {currentStep === "automations" && (
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-white/60">Daily Synthesis</label>
                    <p className="text-xs text-white/30 mt-0.5">Your agent reviews and consolidates memories</p>
                  </div>
                  <span className="text-[10px] text-white/30 font-mono">{automationsLoading ? "Loading..." : formatAutomationSchedule(synthesisSchedule)}</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: "Daily", desc: "Every 24 hours", schedule: { type: "interval" as const, everyMinutes: 24 * 60 } },
                    { label: "Twice daily", desc: "Every 12 hours", schedule: { type: "interval" as const, everyMinutes: 12 * 60 } },
                    { label: "At 9:00 AM", desc: "Same time daily", schedule: { type: "daily" as const, timeOfDay: "09:00" } },
                    { label: "At 10:00 PM", desc: "Same time daily", schedule: { type: "daily" as const, timeOfDay: "22:00" } },
                  ].map((opt) => {
                    const active = synthesisSchedule.type === opt.schedule.type &&
                      ("everyMinutes" in opt.schedule ? synthesisSchedule.everyMinutes === opt.schedule.everyMinutes : synthesisSchedule.timeOfDay === opt.schedule.timeOfDay);
                    return (
                      <button
                        type="button"
                        key={opt.label}
                        onClick={() => setSynthesisSchedule(opt.schedule)}
                        className={`text-left rounded-lg border px-3 py-2.5 transition-all pressable ${
                          active ? "border-purple-400/40 bg-purple-400/15 text-white" : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10"
                        }`}
                      >
                        <div className="text-xs font-medium">{opt.label}</div>
                        <div className="text-[10px] text-white/35 mt-0.5">{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-white/60">Wake Cycle</label>
                    <p className="text-xs text-white/30 mt-0.5">Periodic exploration while you're away</p>
                  </div>
                  <ToggleSwitch checked={wakeEnabled} onChange={() => setWakeEnabled(!wakeEnabled)} accentColor="purple" />
                </div>

                {wakeEnabled && (
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { hours: 12, label: "Every 12h" },
                      { hours: 24, label: "Every 24h" },
                    ].map((opt) => (
                      <button
                        type="button"
                        key={opt.hours}
                        onClick={() => setWakeInterval(opt.hours)}
                        className={`text-left rounded-lg border px-3 py-2.5 transition-all pressable ${
                          wakeInterval === opt.hours ? "border-purple-400/40 bg-purple-400/15 text-white" : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10"
                        }`}
                      >
                        <div className="text-xs font-medium">{opt.label}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-white/60">Sleep Threshold</label>
                  <p className="text-xs text-white/30 mt-0.5">How long before the agent goes into sleep mode</p>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { mins: 30, label: "30 min" },
                    { mins: 60, label: "1 hour" },
                    { mins: 120, label: "2 hours" },
                    { mins: 240, label: "4 hours" },
                  ].map((opt) => (
                    <button
                      type="button"
                      key={opt.mins}
                      onClick={() => setSleepThreshold(opt.mins)}
                      className={`text-left rounded-lg border px-3 py-2.5 transition-all pressable ${
                        sleepThreshold === opt.mins ? "border-purple-400/40 bg-purple-400/15 text-white" : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10"
                      }`}
                    >
                      <div className="text-xs font-medium">{opt.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                <div className="flex items-start gap-3">
                  <div className="text-white/30 mt-0.5">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  </div>
                  <div className="text-xs text-white/40 space-y-1">
                    <p className="font-medium text-white/50">How it works</p>
                    <p>Synthesis and wake cycles only run during sleep mode when you're inactive past the threshold above.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {currentStep === "review" && (
            <div className="space-y-4">
              <div className="text-center mb-4">
                <h3 className="text-lg font-semibold text-white/90">Ready to go</h3>
                <p className="text-xs text-white/40 mt-1">Confirm the selected setup</p>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
                <div className="flex items-center gap-2 text-purple-300/80">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  <span className="text-xs font-medium">Identity</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <span className="text-white/40">Agent name</span>
                  <span className="text-white/70 text-right truncate">{agentName.trim() || "(unset)"}</span>
                  <span className="text-white/40">Persona</span>
                  <span className="text-white/70 text-right">{personaContent.trim() ? (personaContent.trim().length > 60 ? personaContent.trim().slice(0, 60) + "..." : personaContent.trim()) : "(default)"}</span>
                  <span className="text-white/40">About you</span>
                  <span className="text-white/70 text-right">{userDocContent.trim() ? (userDocContent.trim().length > 60 ? userDocContent.trim().slice(0, 60) + "..." : userDocContent.trim()) : "(default)"}</span>
                </div>
                <button onClick={() => setCurrentStep("identity")} className="text-[10px] text-purple-300/60 hover:text-purple-200 transition-colors pressable">
                  Edit identity
                </button>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
                <div className="flex items-center gap-2 text-purple-300/80">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  </svg>
                  <span className="text-xs font-medium">Models</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  {SETUP_SLOTS.map((slot) => (
                    <div key={slot} className="contents">
                      <span className="text-white/40">{SLOT_LABELS[slot]}</span>
                      <span className="text-white/70 text-right truncate">{effectiveModelIds[slot] || "None"}</span>
                    </div>
                  ))}
                </div>
                <button onClick={() => setCurrentStep("models")} className="text-[10px] text-purple-300/60 hover:text-purple-200 transition-colors pressable">
                  Edit models
                </button>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
                <div className="flex items-center gap-2 text-purple-300/80">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                  <span className="text-xs font-medium">Automations</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <span className="text-white/40">Synthesis</span>
                  <span className="text-white/70 text-right">{formatAutomationSchedule(synthesisSchedule)}</span>
                  <span className="text-white/40">Wake cycle</span>
                  <span className="text-white/70 text-right">{wakeEnabled ? `Every ${wakeInterval}h` : "Disabled"}</span>
                  <span className="text-white/40">Sleep after</span>
                  <span className="text-white/70 text-right">{sleepThreshold >= 60 ? `${sleepThreshold / 60}h` : `${sleepThreshold}m`}</span>
                </div>
                <button onClick={() => setCurrentStep("automations")} className="text-[10px] text-purple-300/60 hover:text-purple-200 transition-colors pressable">
                  Edit automations
                </button>
              </div>

              {(readiness.errors.length > 0 || readiness.warnings.length > 0) && (
                <div className={`text-xs p-3 rounded-lg border ${noticeClass(readiness.errors.length ? "err" : "warn")}`}>
                  {[...readiness.errors, ...readiness.warnings].slice(0, 6).map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              )}

              {message && (
                <div className={`text-xs p-3 rounded-lg border ${noticeClass(message.type)}`}>
                  {message.text}
                </div>
              )}
            </div>
          )}

          {message && currentStep !== "review" && (
            <div className={`text-xs p-3 rounded-lg border mt-4 ${noticeClass(message.type)}`}>
              {message.text}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10 shrink-0">
          <div>
            {currentStep !== "welcome" && (
              <button
                onClick={handleBack}
                className="px-4 py-2 rounded-lg text-xs font-medium text-white/50 hover:text-white/80 hover:bg-white/10 transition-all pressable"
              >
                Back
              </button>
            )}
          </div>
          <div>
            {currentStep !== "review" ? (
              <button
                onClick={handleNext}
                className="px-5 py-2 rounded-lg text-xs font-medium bg-purple-500/25 border border-purple-400/30 text-purple-200 hover:bg-purple-500/35 transition-all pressable"
              >
                {currentStep === "welcome" ? "Get started" : "Continue"}
              </button>
            ) : (
              <button
                onClick={handleFinish}
                disabled={loading || applyingModels || hasSetupFailures}
                className="px-5 py-2 rounded-lg text-xs font-medium bg-purple-500/25 border border-purple-400/30 text-purple-200 hover:bg-purple-500/35 transition-all pressable disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                title={hasSetupFailures ? readiness.errors.join(" ") : undefined}
              >
                {(loading || applyingModels) && (
                  <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                )}
                {loading || applyingModels ? "Saving..." : "Finish setup"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
