/**
 * RecorderConfigPanel — AI 录制启动配置（三栏布局）
 *
 * 左栏：NL Test Cases 列表（单选）
 * 中栏：选中用例的完整详情
 * 右栏：录制配置（model / headless / retries / timeout）+ 启动
 * 参考 TestGenConfigPanel 的三栏结构。
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Loader2, AlertCircle, ChevronDown, FileText, Settings2, Play } from 'lucide-react';
import type { StartConfig } from '@/shared/ai-driven-recorder-run';
import { findCaseStartUrl, normalizeExplicitStartUrl } from '../../../shared/recording/start-url';

interface RecorderConfigPanelProps {
  nlCases: any[];
  providerConfigs: any[];
  preselectNlCaseId?: string | null;
  onStart: (config: StartConfig, nlCaseSteps: Array<{ sequence: number; action: string; expected?: string }>) => void;
  disabled: boolean;
}

// Provider 认证矩阵（与 server/modules/ai-driven-recorder/provider-matrix.ts 对齐）
const PROVIDER_LABELS: Record<string, { level: 'certified' | 'experimental' | 'unverified'; canTrigger: boolean; label: string }> = {
  'azure-openai': { level: 'certified', canTrigger: true, label: 'Certified' },
  'openai-compatible': { level: 'unverified', canTrigger: false, label: 'Unverified' },
  anthropic: { level: 'experimental', canTrigger: true, label: 'Beta' },
  google: { level: 'experimental', canTrigger: true, label: 'Beta' },
};

const priorityDotColors: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-slate-400',
};

const priorityTextColors: Record<string, string> = {
  critical: 'text-red-600',
  high: 'text-orange-600',
  medium: 'text-yellow-600',
  low: 'text-slate-500',
};

const statusColors: Record<string, string> = {
  APPROVED: 'bg-blue-100 text-blue-700',
  DRAFT: 'bg-yellow-100 text-yellow-700',
  FINAL: 'bg-green-100 text-green-700',
};

const RECORDER_CONFIG_KEY = 'ai-recorder-config';

interface SavedRecorderConfig {
  model: string;
  modelName: string;
  providerConfigId: string;
  executionMode: 'agent' | 'local';
  startUrl: string;
  headless: boolean;
  maxRetries: number;
  timeoutPerStep: number;
  compilePipeline: boolean;
}

function loadRecorderConfig(): SavedRecorderConfig | null {
  try {
    const raw = localStorage.getItem(RECORDER_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveRecorderConfig(config: SavedRecorderConfig) {
  localStorage.setItem(RECORDER_CONFIG_KEY, JSON.stringify(config));
}

const defaultRecorderConfig: SavedRecorderConfig = {
  model: '',
  modelName: '',
  providerConfigId: '',
  executionMode: 'agent',
  startUrl: '',
  headless: false,
  maxRetries: 2,
  timeoutPerStep: 30,
  compilePipeline: false,
};

export function RecorderConfigPanel({
  nlCases,
  providerConfigs,
  preselectNlCaseId,
  onStart,
  disabled,
}: RecorderConfigPanelProps) {
  const savedConfig = useMemo(() => loadRecorderConfig(), []);
  const [nlCaseId, setNlCaseId] = useState<string>(preselectNlCaseId ?? '');
  const [providerConfigId, setProviderConfigId] = useState<string>(savedConfig?.providerConfigId ?? defaultRecorderConfig.providerConfigId);
  const [model, setModel] = useState<string>(savedConfig?.model ?? defaultRecorderConfig.model);
  const [modelName, setModelName] = useState<string>(savedConfig?.modelName ?? defaultRecorderConfig.modelName);
  const [headless, setHeadless] = useState(savedConfig?.headless ?? defaultRecorderConfig.headless);
  const [maxRetries, setMaxRetries] = useState(savedConfig?.maxRetries ?? defaultRecorderConfig.maxRetries);
  const [timeoutPerStep, setTimeoutPerStep] = useState(savedConfig?.timeoutPerStep ?? defaultRecorderConfig.timeoutPerStep);
  const [executionMode, setExecutionMode] = useState<'agent' | 'local'>(savedConfig?.executionMode ?? defaultRecorderConfig.executionMode);
  const [startUrl, setStartUrl] = useState<string>(savedConfig?.startUrl ?? defaultRecorderConfig.startUrl);
  const [compilePipeline, setCompilePipeline] = useState(savedConfig?.compilePipeline ?? defaultRecorderConfig.compilePipeline);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveRecorderConfig({
      model,
      modelName,
      providerConfigId,
      executionMode,
      startUrl,
      headless,
      maxRetries,
      timeoutPerStep,
      compilePipeline,
    });
  }, [model, modelName, providerConfigId, executionMode, startUrl, headless, maxRetries, timeoutPerStep, compilePipeline]);

  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelOpen]);

  // Build model groups from triggerable providers (same pattern as TestGenConfigPanel)
  const triggerableProviders = useMemo(
    () => providerConfigs.filter((p) => PROVIDER_LABELS[p.type]?.canTrigger),
    [providerConfigs],
  );
  const modelGroups = useMemo(() => {
    const groups: { providerName: string; providerConfigId: string; models: { model: string; providerName: string; providerConfigId: string }[] }[] = [];
    for (const p of triggerableProviders) {
      const models: string[] = p.models || [];
      if (models.length === 0) continue;
      groups.push({
        providerName: p.name,
        providerConfigId: p.id,
        models: models.map((m) => ({ model: m, providerName: p.name, providerConfigId: p.id })),
      });
    }
    return groups.sort((a, b) => a.providerName.localeCompare(b.providerName));
  }, [triggerableProviders]);
  const modelOptions = useMemo(() => modelGroups.flatMap((g) => g.models), [modelGroups]);
  // Auto-select first model
  useEffect(() => {
    if (modelOptions.length > 0 && !model) {
      const first = modelOptions[0];
      setModel(first.model);
      setModelName(`${first.model} (${first.providerName})`);
      setProviderConfigId(first.providerConfigId);
    } else if (modelOptions.length === 0) {
      setModel('');
      setModelName('');
    }
  }, [modelOptions, model]);

  const approvedCases = useMemo(
    () => nlCases.filter((c) => c.status === 'APPROVED'),
    [nlCases],
  );

  const selectedCase = useMemo(
    () => nlCases.find((c) => c.id === nlCaseId),
    [nlCases, nlCaseId],
  );

  const handleStart = useCallback(() => {
    setError(null);
    if (!nlCaseId) {
      setError('Please select an approved NL test case');
      return;
    }
    if (!providerConfigId) {
      setError('Please select a provider configuration');
      return;
    }
    if (!model) {
      setError('Please select a model');
      return;
    }
    // 起始 URL 校验：显式覆盖优先（规范化），否则要求用例可解析
    let normalizedStartUrl: string | undefined;
    const trimmedStartUrl = startUrl.trim();
    if (trimmedStartUrl) {
      try {
        normalizedStartUrl = normalizeExplicitStartUrl(trimmedStartUrl);
      } catch {
        setError('Invalid Start URL — expected an absolute URL like https://app.example.com/login');
        return;
      }
    } else if (selectedCase && !findCaseStartUrl(selectedCase as any)) {
      setError(
        'No start URL found in this case. Add a URL to its preconditions/testData, or enter Start URL above.',
      );
      return;
    }
    const config: StartConfig = {
      nlCaseId,
      providerConfigId,
      model,
      executionMode,
      ...(normalizedStartUrl ? { startUrl: normalizedStartUrl } : {}),
      options: {
        headless,
        maxRetriesPerStep: maxRetries,
        timeoutPerStep: timeoutPerStep * 1000,
        enableCompilePipeline: compilePipeline,
      },
    };
    const nlCaseSteps = (selectedCase?.steps ?? []).map((s: any) => ({
      sequence: s.sequence,
      action: s.action,
      expected: s.expected,
    }));
    onStart(config, nlCaseSteps);
  }, [nlCaseId, providerConfigId, model, executionMode, startUrl, headless, maxRetries, timeoutPerStep, compilePipeline, selectedCase, onStart]);

  // 即时警告：未填覆盖且选中用例解析不到起始 URL（不阻塞，仅提示）
  const startUrlWarning = useMemo(() => {
    if (startUrl.trim() || !selectedCase) return null;
    return findCaseStartUrl(selectedCase as any)
      ? null
      : 'This case has no resolvable start URL. Recording will fail unless you set Start URL below or add a URL to the case.';
  }, [startUrl, selectedCase]);

  return (
    <div className="h-full flex overflow-hidden bg-white">
      {/* Column 1: NL Test Cases */}
      <div className="w-80 shrink-0 flex flex-col overflow-hidden border-r border-slate-100">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2.5">
          <div className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-50">
            <FileText size={14} className="text-blue-600" />
          </div>
          <h3 className="text-[13px] font-semibold text-slate-700">NL Test Cases</h3>
          {approvedCases.length > 0 && (
            <span className="text-[11px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
              {approvedCases.length}
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {approvedCases.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-700 m-2">
              <AlertCircle size={14} className="shrink-0" />
              No approved NL test cases available. Approve cases in the NL Test Cases page first.
            </div>
          ) : (
            approvedCases.map((c) => {
              const isSelected = c.id === nlCaseId;
              return (
                <button
                  key={c.id}
                  onClick={() => setNlCaseId(c.id)}
                  disabled={disabled}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors ${
                    isSelected
                      ? 'bg-blue-50 border border-blue-200 shadow-sm'
                      : 'border border-transparent hover:bg-slate-100'
                  } disabled:opacity-50`}
                >
                  <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${priorityDotColors[c.priority] || 'bg-slate-400'}`} />
                  <span className={`flex-1 min-w-0 truncate text-sm ${isSelected ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'}`}>
                    {c.title}
                  </span>
                  <span className="text-[10px] font-medium text-slate-400 shrink-0">
                    {c.steps?.length ?? 0} steps
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Column 2: Case Detail */}
      <div className="flex-1 flex flex-col overflow-hidden border-r border-slate-100">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2.5">
          <div className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-50">
            <FileText size={14} className="text-blue-600" />
          </div>
          <h3 className="text-[13px] font-semibold text-slate-700 truncate">
            {selectedCase ? selectedCase.title : 'Detail'}
          </h3>
          {selectedCase?.status && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${statusColors[selectedCase.status] || 'bg-slate-100 text-slate-600'}`}>
              {selectedCase.status}
            </span>
          )}
          {selectedCase?.id && (
            <span className="text-[10px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">{selectedCase.id}</span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4">
          {selectedCase ? (
            <div className="space-y-5">
              {/* Metadata */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                <span>Priority: <span className={`font-medium ${priorityTextColors[selectedCase.priority] || 'text-slate-700'}`}>{selectedCase.priority}</span></span>
                {selectedCase.testLevel && (
                  <span>Test Level: <span className="font-medium text-slate-700">{selectedCase.testLevel}</span></span>
                )}
                {selectedCase.category && (
                  <span>Category: <span className="font-medium text-slate-700">{selectedCase.category}</span></span>
                )}
                {selectedCase.techniqueApplied && (
                  <span>Technique: <span className="font-medium text-slate-700">{selectedCase.techniqueApplied}</span></span>
                )}
              </div>

              {/* Preconditions */}
              {selectedCase.preconditions?.length > 0 && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Preconditions</label>
                  <ul className="space-y-1">
                    {selectedCase.preconditions.map((p: string, i: number) => (
                      <li key={i} className="flex gap-2 text-xs text-slate-600">
                        <span className="font-mono text-slate-400 shrink-0">{i + 1}.</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Steps */}
              {selectedCase.steps?.length > 0 && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">
                    Steps ({selectedCase.steps.length})
                  </label>
                  <ol className="space-y-2">
                    {selectedCase.steps.map((s: any, i: number) => (
                      <li key={i} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <div className="flex gap-2 text-xs text-slate-700">
                          <span className="font-mono text-slate-400 shrink-0">{s.sequence ?? i + 1}.</span>
                          <span>{s.action}</span>
                        </div>
                        {s.expected && (
                          <div className="mt-1 pl-6 text-[11px] text-slate-500">
                            <span className="font-medium text-slate-400 mr-1">Expected:</span>
                            {s.expected}
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Test Data */}
              {selectedCase.testData?.length > 0 && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Test Data</label>
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 text-left text-[10px] text-slate-400 uppercase tracking-wider">
                          <th className="px-3 py-1.5 font-semibold">Key</th>
                          <th className="px-3 py-1.5 font-semibold">Value</th>
                          <th className="px-3 py-1.5 font-semibold">Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedCase.testData.map((td: any, i: number) => (
                          <tr key={i} className="border-t border-slate-100">
                            <td className="px-3 py-1.5 font-mono text-slate-500">{td.key}</td>
                            <td className="px-3 py-1.5 text-slate-700">{td.value}</td>
                            <td className="px-3 py-1.5 text-slate-500">{td.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Postconditions */}
              {selectedCase.postconditions?.length > 0 && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Postconditions</label>
                  <ul className="space-y-1">
                    {selectedCase.postconditions.map((p: string, i: number) => (
                      <li key={i} className="flex gap-2 text-xs text-slate-600">
                        <span className="font-mono text-slate-400 shrink-0">{i + 1}.</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Tags */}
              {selectedCase.tags?.length > 0 && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Tags</label>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedCase.tags.map((t: string, i: number) => (
                      <span key={i} className="text-[10px] font-medium text-slate-600 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">{t}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <FileText size={28} className="mb-2 opacity-40" />
              <p className="text-xs">Select a test case to view details</p>
            </div>
          )}
        </div>
      </div>

      {/* Column 3: Settings */}
      <div className="w-96 flex flex-col bg-slate-50/50 shrink-0">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2.5">
          <div className="flex items-center justify-center w-6 h-6 rounded-md bg-slate-100">
            <Settings2 size={14} className="text-slate-600" />
          </div>
          <h3 className="text-[13px] font-semibold text-slate-700">Settings</h3>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Model */}
          <div className="relative" ref={modelDropdownRef}>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">Model</label>
            {modelOptions.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-700">
                <AlertCircle size={14} className="shrink-0" />
                Selected provider has no models configured. Add models in Settings.
              </div>
            ) : (
              <>
                <button
                  onClick={() => !disabled && setModelOpen(!modelOpen)}
                  disabled={disabled}
                  className="w-full flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white hover:border-slate-300 focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 transition-all disabled:opacity-50"
                >
                  <span className="text-slate-700">{model || 'Select a model'}</span>
                  <ChevronDown size={14} className={`text-slate-400 transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
                </button>
                {modelOpen && (
                  <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                    {modelGroups.map((group) => (
                      <div key={group.providerName}>
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider bg-slate-50">{group.providerName}</div>
                        {group.models.map((o, i) => (
                          <button
                            key={`${o.providerName}-${o.model}-${i}`}
                            onClick={() => { setModel(o.model); setModelName(`${o.model} (${o.providerName})`); setProviderConfigId(o.providerConfigId); setModelOpen(false); }}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 transition-colors ${
                              model === o.model ? 'text-blue-600 font-medium bg-blue-50/50' : 'text-slate-700'
                            }`}
                          >
                            {o.model}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Options */}
          <div className="space-y-3">
            <div className="p-3 rounded-lg border border-slate-100 bg-white">
              <label htmlFor="recorder-execution-mode" className="block text-sm font-medium text-slate-700">
                Execution Position
              </label>
              <div className="text-[11px] text-slate-400 mt-0.5 mb-2">Agent process or this server directly (no fallback)</div>
              <select
                id="recorder-execution-mode"
                value={executionMode}
                onChange={(e) => setExecutionMode(e.target.value as 'agent' | 'local')}
                disabled={disabled}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white text-slate-700 hover:border-slate-300 focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 transition-all disabled:opacity-50"
              >
                <option value="agent">Agent</option>
                <option value="local">Local server</option>
              </select>
            </div>
            <div className="p-3 rounded-lg border border-slate-100 bg-white">
              <label htmlFor="recorder-start-url" className="block text-sm font-medium text-slate-700">
                Start URL <span className="text-[11px] font-normal text-slate-400">(optional override)</span>
              </label>
              <div className="text-[11px] text-slate-400 mt-0.5 mb-2">
                Leave empty to resolve from the case's preconditions / testData
              </div>
              <input
                id="recorder-start-url"
                type="text"
                value={startUrl}
                onChange={(e) => setStartUrl(e.target.value)}
                placeholder="https://app.example.com/login"
                disabled={disabled}
                className={`w-full border rounded-lg px-3 py-2 text-xs bg-white focus:outline-none focus:ring-2 transition-all disabled:opacity-50 ${
                  startUrlWarning
                    ? 'border-amber-300 focus:border-amber-300 focus:ring-amber-500/10'
                    : 'border-slate-200 hover:border-slate-300 focus:border-blue-300 focus:ring-blue-500/10'
                }`}
              />
            </div>
            {startUrlWarning && (
              <div data-testid="start-url-warning" className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-700">
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                {startUrlWarning}
              </div>
            )}
            <div className="flex items-center justify-between p-3 rounded-lg border border-slate-100 bg-white">
              <div>
                <div className="text-sm font-medium text-slate-700">Headless Mode</div>
                <div className="text-[11px] text-slate-400">Run browser without UI (faster, no takeover)</div>
              </div>
              <button
                onClick={() => !disabled && setHeadless(!headless)}
                disabled={disabled}
                className={`relative w-10 h-5 rounded-full transition-colors ${headless ? 'bg-blue-500' : 'bg-slate-300'} disabled:opacity-50`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${headless ? 'translate-x-5' : ''}`} />
              </button>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg border border-slate-100 bg-white">
              <div>
                <div className="text-sm font-medium text-slate-700">Assertion Compiler</div>
                <div className="text-[11px] text-slate-400">
                  Rules + AI compile assertions, then headless replay confirms them (docs/07)
                </div>
              </div>
              <button
                onClick={() => !disabled && setCompilePipeline(!compilePipeline)}
                disabled={disabled}
                data-testid="compile-pipeline-toggle"
                className={`relative w-10 h-5 rounded-full transition-colors ${compilePipeline ? 'bg-blue-500' : 'bg-slate-300'} disabled:opacity-50`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${compilePipeline ? 'translate-x-5' : ''}`} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Max Retries / Step</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                  disabled={disabled}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Timeout / Step (s)</label>
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={timeoutPerStep}
                  onChange={(e) => setTimeoutPerStep(Number(e.target.value))}
                  disabled={disabled}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">
              <AlertCircle size={14} className="shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Start button */}
        <div className="p-4 border-t border-slate-100">
          <button
            onClick={handleStart}
            disabled={disabled || !nlCaseId || !providerConfigId}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow disabled:shadow-none"
          >
            {disabled ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} fill="currentColor" />}
            {disabled ? 'Starting...' : 'Start AI Recording'}
          </button>
          {!disabled && !nlCaseId && (
            <p className="text-[11px] text-slate-400 mt-1.5 text-center">Select a test case to continue</p>
          )}
          {!disabled && nlCaseId && !providerConfigId && (
            <p className="text-[11px] text-amber-600 mt-1.5 text-center">Select a model to continue</p>
          )}
        </div>
      </div>
    </div>
  );
}
