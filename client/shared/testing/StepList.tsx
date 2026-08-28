import React, { useState } from "react";
import {
  TestStep,
  Project,
  ActionType,
  HeaderProfile,
  BodyTemplate,
  ApiEndpoint,
} from "@/shared/types";
import {
  GripVertical,
  Trash2,
  FileText,
  FileCode,
  Braces,
  MousePointer2,
  Workflow,
  Globe,
  ChevronDown,
  ChevronRight,
  Plus,
  Copy,
  Camera,
  Power,
  PowerOff,
} from "lucide-react";
import { ConfirmModal } from "@/shared/ui/ConfirmModal";
import { HelpTooltip } from "@/shared/ui/HelpTooltip";
import { AssertionEditor } from "./AssertionEditor";
import { ReviewAssertionsPanel } from "./ReviewAssertionsPanel";
import { AutosaveTextField } from "./AutosaveTextField";

import { generateId } from "../utils";

interface StepListProps {
  title?: string;
  steps: TestStep[];
  onUpdateStep: (id: string, updates: Partial<TestStep>) => void;
  onDeleteStep: (id: string) => void;
  onDuplicateStep?: (step: TestStep) => void;
  onMoveStep: (fromIndex: number, toIndex: number) => void;
  onAddStep?: (action?: ActionType) => void;
  defaultExpanded?: boolean;
  activeProject: Project;
  variables?: { id: string; key: string; value?: string }[];
  endpoints: ApiEndpoint[];
  headers: HeaderProfile[];
  bodies: BodyTemplate[];
}

export const StepList: React.FC<StepListProps> = ({
  title,
  steps,
  onUpdateStep,
  onDeleteStep,
  onDuplicateStep,
  onMoveStep,
  onAddStep,
  defaultExpanded = true,
  activeProject,
  variables = [],
  endpoints,
  headers,
  bodies,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [draggedStepIndex, setDraggedStepIndex] = useState<number | null>(null);
  const [elementMenuOpen, setElementMenuOpen] = useState<string | null>(null);
  const [variableMenuOpen, setVariableMenuOpen] = useState<{
    stepId: string;
    field: "target" | "data";
    paramName?: string;
  } | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [expandedAdvancedOptions, setExpandedAdvancedOptions] = useState<Set<string>>(new Set());

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedStepIndex(index);
    e.dataTransfer.setData("text/plain", String(index));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const draggedIndexStr = e.dataTransfer.getData("text/plain");
    if (!draggedIndexStr) return;
    const draggedIndex = parseInt(draggedIndexStr, 10);
    if (isNaN(draggedIndex) || draggedIndex === dropIndex) return;
    onMoveStep(draggedIndex, dropIndex);
    setDraggedStepIndex(null);
  };

  const closeAllMenus = () => {
    setVariableMenuOpen(null);
    setElementMenuOpen(null);
  };

  const getActionColorClass = (action: ActionType) => {
    if (action === "runModule")
      return "bg-blue-100 text-blue-800 border-blue-300";
    if (action.startsWith("api"))
      return "bg-emerald-100 text-emerald-800 border-emerald-300";
    if (action.startsWith("assert"))
      return "bg-slate-100 text-slate-800 border-slate-300";
    if (action === "waitForTimeout") return "bg-gray-100 text-gray-800 border-gray-300";
    return "bg-blue-100 text-blue-800 border-blue-300";
  };

  const insertVariable = (
    stepId: string,
    field: "target" | "data",
    variableKey: string,
    paramName?: string,
  ) => {
    const step = steps.find((s) => s.id === stepId);
    if (!step) return;

    if (paramName && field === "data") {
      let dataObj: Record<string, string> = {};
      try {
        dataObj = JSON.parse(step.data || "{}");
      } catch (e) { }
      const currentVal = dataObj[paramName] || "";
      const newVal = `${currentVal}{{${variableKey}}}`;
      dataObj[paramName] = newVal;
      onUpdateStep(stepId, { data: JSON.stringify(dataObj) });
    } else {
      const currentValue = (field === "target" ? step.target : step.data) || "";
      const newValue = `${currentValue}{{${variableKey}}}`;
      onUpdateStep(stepId, { [field]: newValue });
    }
    setVariableMenuOpen(null);
  };

  const updateModuleParam = (
    stepId: string,
    currentDataJSON: string,
    paramKey: string,
    newValue: string,
  ) => {
    let dataObj = {};
    try {
      dataObj = JSON.parse(currentDataJSON || "{}");
    } catch (e) { }
    dataObj = { ...dataObj, [paramKey]: newValue };
    onUpdateStep(stepId, { data: JSON.stringify(dataObj) });
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm relative">
      <ConfirmModal
        isOpen={!!deleteConfirm}
        title="Delete Step"
        message="Are you sure you want to delete this step? This action cannot be undone."
        onConfirm={() => {
          if (deleteConfirm) {
            onDeleteStep(deleteConfirm);
          }
          setDeleteConfirm(null);
        }}
        onClose={() => setDeleteConfirm(null)}
      />
      {title && (
        <div
          className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200 cursor-pointer hover:bg-gray-100 transition-colors"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center gap-2">
            {isExpanded ? (
              <ChevronDown size={16} className="text-gray-500" />
            ) : (
              <ChevronRight size={16} className="text-gray-500" />
            )}
            <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
            <span className="px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs font-medium">
              {steps.length}
            </span>
          </div>
          {onAddStep && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAddStep();
                if (!isExpanded) setIsExpanded(true);
              }}
              className="text-xs font-medium text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded flex items-center gap-1 transition-colors"
            >
              <Plus size={14} /> Add Step
            </button>
          )}
        </div>
      )}

      {isExpanded && (
        <div className="p-4" onClick={closeAllMenus}>
          {steps.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-xs italic bg-gray-50 rounded-lg border border-dashed border-gray-200">
              No steps defined. Add steps manually or generate them using AI.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-[30px_240px_minmax(0,1fr)_minmax(0,1.2fr)_70px] gap-2 text-[11px] font-bold text-gray-400 uppercase tracking-wider px-4">
                <div className="text-center">Step</div>
                <div>Action</div>
                <div>Target / Module</div>
                <div className="flex items-center gap-1">
                  Value / Data
                  <HelpTooltip
                    maxWidthClass="max-w-[500px]"
                    content={
                      <div className="w-[480px] text-xs">
                        <p className="font-semibold mb-2 text-sm border-b border-gray-700 pb-1">Dynamic Variables Cheat Sheet</p>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="font-semibold text-blue-300 mb-1">Generators (Start with $)</p>
                            <ul className="space-y-1 text-gray-300">
                              <li><code className="text-blue-200 bg-gray-900 px-1 rounded">{"{{$uuid()}}"}</code> - UUID v4</li>
                              <li><code className="text-blue-200 bg-gray-900 px-1 rounded">{"{{$timestamp()}}"}</code> - 13-digit ms</li>
                              <li><code className="text-blue-200 bg-gray-900 px-1 rounded">{"{{$now('YYYY-MM-DD', 'Asia/Shanghai')}}"}</code></li>
                              <li><code className="text-blue-200 bg-gray-900 px-1 rounded">{"{{$randomInt(1, 100)}}"}</code> - Random int</li>
                              <li><code className="text-blue-200 bg-gray-900 px-1 rounded">{"{{$randomString(8)}}"}</code> - Random string</li>
                              <li><code className="text-blue-200 bg-gray-900 px-1 rounded">{"{{$randomUpper(3)}}"}</code> - Random uppercase</li>
                              <li><code className="text-blue-200 bg-gray-900 px-1 rounded">{"{{$randomEmail()}}"}</code> - Random email</li>
                              <li><code className="text-blue-200 bg-gray-900 px-1 rounded">{"{{$randomPhone()}}"}</code> - Random phone</li>
                            </ul>
                          </div>

                          <div>
                            <p className="font-semibold text-green-300 mb-1">Transformers (Use | pipe)</p>
                            <ul className="space-y-1 text-gray-300">
                              <li><code className="text-green-200 bg-gray-900 px-1 rounded">| md5</code>, <code className="text-green-200 bg-gray-900 px-1 rounded">| sha256</code></li>
                              <li><code className="text-green-200 bg-gray-900 px-1 rounded">| base64</code>, <code className="text-green-200 bg-gray-900 px-1 rounded">| base64Decode</code></li>
                              <li><code className="text-green-200 bg-gray-900 px-1 rounded">| date('YYYY-MM-DD', 'UTC')</code></li>
                              <li><code className="text-green-200 bg-gray-900 px-1 rounded">| substring(0, 5)</code></li>
                              <li><code className="text-green-200 bg-gray-900 px-1 rounded">| replace('a', 'b')</code></li>
                              <li><code className="text-green-200 bg-gray-900 px-1 rounded">| default('N/A')</code></li>
                              <li><code className="text-green-200 bg-gray-900 px-1 rounded">| jsonPath('$.id')</code></li>
                            </ul>
                          </div>
                        </div>

                        <p className="font-semibold text-purple-300 mt-3 mb-1">Example Combinations</p>
                        <div className="bg-gray-900 p-1.5 rounded text-gray-300 space-y-1">
                          <div><code className="text-purple-200">{"{{ $timestamp() | md5 | uppercase }}"}</code></div>
                          <div><code className="text-purple-200">{"{{ $randomUpper(3) }}{{ $timestamp() }}"}</code> &rarr; ABC1712220000000</div>
                        </div>
                      </div>
                    } />
                </div>
                <div></div>
              </div>

              {steps.map((step, index) => (
                <div
                  key={step.id}
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={(e) => {
                    setDraggedStepIndex(null);
                    e.currentTarget.removeAttribute("draggable");
                  }}
                  className={`group bg-white border border-gray-200 p-3 rounded-lg shadow-sm hover:border-blue-300 hover:shadow-md transition-all relative ${elementMenuOpen === step.id ? "z-50 border-blue-300 ring-2 ring-blue-500/20" : "z-auto"} ${draggedStepIndex === index ? "opacity-50 ring-2 ring-blue-300 border-blue-400" : ""} ${step.enabled === false ? "opacity-60 bg-gray-50" : ""}`}
                >
                  <div className="grid grid-cols-[30px_240px_minmax(0,1fr)_minmax(0,1.2fr)_70px] gap-2 items-center">
                    {/* Drag Handle & Index */}
                    <div
                      className="flex items-center justify-center text-gray-300 cursor-grab active:cursor-grabbing group-hover:text-gray-400 drag-handle hover:bg-gray-50 rounded-md py-1 transition-colors relative"
                      onMouseEnter={(e) => {
                        const row = e.currentTarget.closest(".group");
                        if (row) row.setAttribute("draggable", "true");
                      }}
                      onMouseLeave={(e) => {
                        const row = e.currentTarget.closest(".group");
                        if (row) row.removeAttribute("draggable");
                      }}
                    >
                      <GripVertical size={16} className="mr-1 text-gray-400" />
                      <div className="relative">
                        <select
                          className="appearance-none w-5 h-5 bg-gray-50 rounded-full text-xs font-mono font-medium text-center focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer text-blue-600 hover:bg-blue-100 transition-colors"
                          value={index}
                          onChange={(e) =>
                            onMoveStep(index, parseInt(e.target.value))
                          }
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          {steps.map((_, i) => (
                            <option key={i} value={i}>
                              {i + 1}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Action Dropdown */}
                    <div>
                      <select
                        className={`w-full text-xs font-bold rounded-md border px-2 py-2 focus:ring-2 focus:ring-opacity-50 outline-none cursor-pointer transition-colors ${getActionColorClass(step.action)}`}
                        value={step.action}
                        onChange={(e) =>
                          onUpdateStep(step.id, {
                            action: e.target.value as ActionType,
                            target: "",
                            data: "",
                            headerProfileId: undefined,
                            bodyTemplateId: undefined,
                            endpointId: undefined,
                          })
                        }
                        disabled={step.enabled === false}
                      >
                        <optgroup label="Web Actions">
                          <option value="goto">goto</option>
                          <option value="click">click</option>
                          <option value="dblclick">dblclick</option>
                          <option value="rightClick">rightClick</option>
                          <option value="fill">fill</option>
                          <option value="clear">clear</option>
                          <option value="hover">hover</option>
                          <option value="highlight">highlight</option>
                          <option value="scrollIntoView">scrollIntoView</option>
                          <option value="selectOption">selectOption</option>
                          <option value="check">check</option>
                          <option value="uncheck">uncheck</option>
                          <option value="toggle">toggle</option>
                          <option value="dragTo">dragTo</option>
                          <option value="setInputFiles">setInputFiles</option>
                          <option value="press">press</option>
                        </optgroup>
                        <optgroup label="Assertions">
                          <option value="assertVisible">assertVisible</option>
                          <option value="assertInvisible">assertInvisible</option>
                          <option value="assertNotExist">assertNotExist</option>
                          <option value="assertAttribute">assertAttribute</option>
                          <option value="assertText">assertText</option>
                          <option value="assertValue">assertValue</option>
                          <option value="assertUrl">assertUrl</option>
                          <option value="assertTitle">assertTitle</option>
<option value="assertDisabled">assertDisabled</option>
          <option value="assertEnabled">assertEnabled</option>
          <option value="assertChecked">assertChecked</option>
          <option value="assertUnchecked">assertUnchecked</option>
        </optgroup>
                        <optgroup label="Browser & Alert Actions">
                          <option value="switchToWindow">switchToWindow</option>
                          <option value="switchToFrame">switchToFrame</option>
                          <option value="acceptDialog">acceptDialog</option>
                          <option value="dismissDialog">dismissDialog</option>
                        </optgroup>
                        <optgroup label="Logic & Modules">
                          <option value="waitForTimeout">waitForTimeout</option>
                          <option value="waitForVisible">waitForVisible</option>
                          <option value="waitForHidden">waitForHidden</option>
                          <option value="extractVar">extractVar</option>
                          <option value="evaluate">evaluate</option>
                          <option value="runModule">runModule</option>
                        </optgroup>
                        <optgroup label="API Actions">
                          <option value="apiGet">apiGet</option>
                          <option value="apiPost">apiPost</option>
                          <option value="apiPut">apiPut</option>
                          <option value="apiDelete">apiDelete</option>
                        </optgroup>
                      </select>
                    </div>

                    {/* Target / Module */}
                    <div className="relative">
                      {step.action === "runModule" ? (
                        <select
                          className="w-full bg-blue-50 text-blue-900 rounded-md border border-blue-200 px-3 py-2 text-xs font-medium focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none cursor-pointer disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                          value={step.target}
                          onChange={(e) =>
                            onUpdateStep(step.id, {
                              target: e.target.value,
                              data: "{}",
                            })
                          }
                          disabled={step.enabled === false}
                        >
                          <option value="">Select Module...</option>
                          {(activeProject.modules || []).map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      ) : step.action.startsWith("api") ? (
                        <select
                          className="w-full bg-emerald-50 text-emerald-900 rounded-md border border-emerald-200 px-3 py-2 text-xs font-medium focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none cursor-pointer disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                          value={step.endpointId || ""}
                          disabled={step.enabled === false}
                          onChange={(e) => {
                            const newEndpointId = e.target.value || undefined;
                            let currentValues: Record<string, string> = {};
                            try {
                              currentValues = JSON.parse(step.data || "{}");
                            } catch (err) { }

                            let newValues: Record<string, string> = {};

                            // Preserve header variables
                            if (step.headerProfileId) {
                              const profile = headers.find(
                                (h) => h.id === step.headerProfileId,
                              );
                              if (profile) {
                                profile.headers.forEach((h) => {
                                  const matches =
                                    h.value.match(/\{\{([^}]+)\}\}/g);
                                  if (matches) {
                                    matches.forEach((m) => {
                                      const varName = m.replace(
                                        /\{\{|\}\}/g,
                                        "",
                                      );
                                      if (
                                        currentValues[varName] !== undefined
                                      ) {
                                        newValues[varName] =
                                          currentValues[varName];
                                      }
                                    });
                                  }
                                });
                              }
                            }

                            // Preserve body variables
                            if (step.bodyTemplateId) {
                              const template = bodies.find(
                                (b) => b.id === step.bodyTemplateId,
                              );
                              if (template) {
                                const matches =
                                  template.content.match(/\{\{([^}]+)\}\}/g);
                                if (matches) {
                                  matches.forEach((m) => {
                                    const varName = m.replace(/\{\{|\}\}/g, "");
                                    if (currentValues[varName] !== undefined) {
                                      newValues[varName] =
                                        currentValues[varName];
                                    }
                                  });
                                }
                              }
                            }

                            // Add new endpoint variables
                            if (newEndpointId) {
                              const endpoint = endpoints.find(
                                (ep) => ep.id === newEndpointId,
                              );
                              if (endpoint && endpoint.parameters) {
                                endpoint.parameters.forEach((p) => {
                                  if (!p.enabled) return;
                                  const matches = p.value.match(
                                    /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                  );
                                  if (matches) {
                                    matches.forEach((m) => {
                                      const varName = m.replace(
                                        /\{\{|\}\}|\{|\}/g,
                                        "",
                                      );
                                      if (
                                        currentValues[varName] !== undefined
                                      ) {
                                        newValues[varName] =
                                          currentValues[varName];
                                      }
                                    });
                                  }
                                });
                              }
                            }

                            onUpdateStep(step.id, {
                              endpointId: newEndpointId,
                              data:
                                Object.keys(newValues).length > 0
                                  ? JSON.stringify(newValues)
                                  : "",
                            });
                          }}
                        >
                          <option value="">Select Endpoint...</option>
                          {endpoints.map((ep) => (
                            <option key={ep.id} value={ep.id}>
                              {ep.method} {ep.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="relative flex items-center">
                          <AutosaveTextField
                            className="w-full bg-gray-50 text-gray-700 rounded-md border border-gray-200 pl-3 pr-14 py-2 text-xs font-mono focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder-gray-400 disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                            value={step.target}
                            onSave={(next) => onUpdateStep(step.id, { target: next })}
                            placeholder={
                              [
                                "goto",
                                "waitForTimeout",
                                "waitForVisible",
                                "waitForHidden",
                                "evaluate",
                                "switchToWindow",
                                "switchToFrame",
                                "acceptDialog",
                                "dismissDialog",
                              ].includes(step.action)
                                ? "Not required"
                                : "PageName.ElementName or Selector"
                            }
                            disabled={
                              step.enabled === false ||
                              [
                                "goto",
                                "waitForTimeout",
                                "waitForVisible",
                                "waitForHidden",
                                "evaluate",
                                "switchToWindow",
                                "switchToFrame",
                                "acceptDialog",
                                "dismissDialog",
                              ].includes(step.action)
                            }
                          />
                          <div className="absolute right-1 flex items-center gap-0.5">
                            {!["goto", "waitForTimeout", "evaluate"].includes(
                              step.action,
                            ) && (
                                <button
                                  className="text-gray-400 hover:text-blue-600 p-1.5 rounded hover:bg-blue-50 transition-colors"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setElementMenuOpen(
                                      elementMenuOpen === step.id
                                        ? null
                                        : step.id,
                                    );
                                    setVariableMenuOpen(null);
                                  }}
                                  title="Select Element from Repo"
                                >
                                  <MousePointer2 size={14} />
                                </button>
                              )}
                            <button
                              className="text-gray-400 hover:text-blue-600 p-1.5 rounded hover:bg-blue-50 transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                setVariableMenuOpen(
                                  variableMenuOpen?.stepId === step.id &&
                                    variableMenuOpen.field === "target"
                                    ? null
                                    : { stepId: step.id, field: "target" },
                                );
                                setElementMenuOpen(null);
                              }}
                              title="Insert Variable"
                            >
                              <Braces size={14} />
                            </button>
                          </div>

                          {/* Element Repo Dropdown */}
                          {elementMenuOpen === step.id && (
                            <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-xl z-50 py-2 max-h-80 overflow-y-auto">
                              <div className="px-4 py-2 text-xs font-bold text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100 flex items-center gap-2 sticky top-0">
                                <Workflow size={14} /> Element Repository
                              </div>
                              {activeProject.pages.length === 0 && (
                                <div className="px-4 py-6 text-sm text-gray-400 text-center italic">
                                  No pages defined in repository.
                                </div>
                              )}
                              {activeProject.pages.map((page) => (
                                <div key={page.id} className="mb-3 last:mb-0">
                                  <div className="px-4 py-2 text-xs font-semibold text-gray-700 bg-gray-50/80 flex items-center gap-2 sticky top-8 backdrop-blur-sm">
                                    <Globe
                                      size={14}
                                      className="text-gray-400"
                                    />{" "}
                                    {page.name}
                                  </div>
                                  {page.elements.length === 0 && (
                                    <div className="px-5 py-2 text-xs text-gray-400 italic">
                                      No elements
                                    </div>
                                  )}
                                  {page.elements.map((el) => (
                                    <button
                                      key={el.id}
                                      className="w-full text-left px-5 py-2 hover:bg-blue-50 hover:text-blue-700 text-sm flex flex-col group transition-colors border-l-2 border-transparent hover:border-blue-500"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onUpdateStep(step.id, {
                                          target: `${page.name}.${el.name}`,
                                        });
                                        setElementMenuOpen(null);
                                      }}
                                    >
                                      <span className="font-medium text-gray-800 group-hover:text-blue-700">
                                        {el.name}
                                      </span>
                                      <span className="text-xs font-mono text-gray-400 group-hover:text-blue-500 truncate w-full mt-0.5">
                                        {el.value}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Variable Dropdown (Target) */}
                          {variableMenuOpen?.stepId === step.id &&
                            variableMenuOpen?.field === "target" && (
                              <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 text-xs">
                                <div className="px-2 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                                  Insert Suite Variable
                                </div>
                                {variables.map((v) => (
                                  <button
                                    key={v.id}
                                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 hover:text-blue-700 font-mono flex items-center justify-between group"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      insertVariable(step.id, "target", v.key);
                                    }}
                                  >
                                    <span>{v.key}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                        </div>
                      )}
                    </div>

                    {/* Value / Data */}
                    <div>
                      {step.action === "runModule" ? (
                        <div className="bg-blue-50/50 rounded-md border border-blue-100 p-2 space-y-2">
                          <div className="flex items-center gap-2 mb-2">
                            <label className="text-[10px] font-mono font-medium text-blue-700 w-20 truncate text-right shrink-0" title="Namespace">
                              Namespace
                            </label>
                            <AutosaveTextField
                              className="flex-1 bg-white border border-blue-200 rounded px-2 py-1 text-[11px] text-gray-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                              placeholder="Optional export alias (e.g., buyer)"
                              value={step.namespace || ""}
                              onSave={(next) =>
                                onUpdateStep(step.id, { namespace: next })
                              }
                              disabled={step.enabled === false}
                            />
                          </div>
                          {(() => {
                            const module = activeProject.modules?.find(
                              (m) => m.id === step.target,
                            );
                            if (
                              !module ||
                              !module.params ||
                              module.params.length === 0
                            ) {
                              return (
                                <div className="text-[10px] text-blue-400 italic text-center">
                                  No parameters required
                                </div>
                              );
                            }

                            let currentData: Record<string, string> = {};
                            try {
                              currentData = JSON.parse(step.data || "{}");
                            } catch (e) { }

                            return module.params.map((param) => (
                              <div
                                key={param.id}
                                className="flex items-center gap-2"
                              >
                                <label
                                  className="text-[10px] font-mono font-medium text-blue-700 w-20 truncate text-right shrink-0"
                                  title={param.name}
                                >
                                  {param.name}
                                </label>
                                <div className="relative flex-1">
                                  <AutosaveTextField
                                    className="w-full bg-white border border-blue-200 rounded px-2 py-1 text-[11px] text-gray-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                    placeholder={param.defaultValue || "Value"}
                                    value={currentData[param.name] || ""}
                                    onSave={(next) =>
                                      updateModuleParam(
                                        step.id,
                                        step.data,
                                        param.name,
                                        next,
                                      )
                                    }
                                    disabled={step.enabled === false}
                                  />
                                  <button
                                    className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-300 hover:text-blue-600 p-0.5 rounded"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setVariableMenuOpen(
                                        variableMenuOpen?.stepId === step.id &&
                                          variableMenuOpen?.paramName ===
                                          param.name
                                          ? null
                                          : {
                                            stepId: step.id,
                                            field: "data",
                                            paramName: param.name,
                                          },
                                      );
                                    }}
                                  >
                                    <Braces size={10} />
                                  </button>

                                  {/* Variable Dropdown (Module Param) */}
                                  {variableMenuOpen?.stepId === step.id &&
                                    variableMenuOpen?.paramName ===
                                    param.name && (
                                      <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 text-xs">
                                        <div className="px-2 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                                          Insert Suite Variable
                                        </div>
                                        {(variables || []).map((v) => (
                                          <button
                                            key={v.id}
                                            className="w-full text-left px-3 py-1.5 hover:bg-blue-50 hover:text-blue-700 font-mono flex items-center justify-between group"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              insertVariable(
                                                step.id,
                                                "data",
                                                v.key,
                                                param.name,
                                              );
                                            }}
                                          >
                                            <span>{v.key}</span>
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                </div>
                              </div>
                            ));
                          })()}
                        </div>
                      ) : step.action.startsWith("api") ? (
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <select
                              className="flex-1 bg-white text-xs text-gray-700 rounded-md border border-gray-200 px-2 py-1.5 focus:border-emerald-500 outline-none disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                              value={step.headerProfileId || ""}
                              disabled={step.enabled === false}
                              onChange={(e) => {
                                const newHeaderId = e.target.value || undefined;
                                let currentValues: Record<string, string> = {};
                                try {
                                  currentValues = JSON.parse(step.data || "{}");
                                } catch (err) { }

                                let newValues: Record<string, string> = {};

                                // Preserve URL variables
                                const urlVars = new Set<string>();
                                if (step.target) {
                                  const matches = step.target.match(
                                    /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                  );
                                  if (matches)
                                    matches.forEach((m) =>
                                      urlVars.add(
                                        m.replace(/\{\{|\}\}|\{|\}/g, ""),
                                      ),
                                    );
                                }
                                if (step.endpointId) {
                                  const endpoint = endpoints.find(
                                    (ep) => ep.id === step.endpointId,
                                  );
                                  if (endpoint) {
                                    Object.values(endpoint.baseUrls).forEach(
                                      (url) => {
                                        if (typeof url === "string") {
                                          const matches = url.match(
                                            /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                          );
                                          if (matches)
                                            matches.forEach((m) =>
                                              urlVars.add(
                                                m.replace(
                                                  /\{\{|\}\}|\{|\}/g,
                                                  "",
                                                ),
                                              ),
                                            );
                                        }
                                      },
                                    );
                                    if (endpoint.parameters) {
                                      endpoint.parameters.forEach((p) => {
                                        if (!p.enabled) return;
                                        const matches = p.value.match(
                                          /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                        );
                                        if (matches)
                                          matches.forEach((m) =>
                                            urlVars.add(
                                              m.replace(/\{\{|\}\}|\{|\}/g, ""),
                                            ),
                                          );
                                      });
                                    }
                                  }
                                }
                                urlVars.forEach((varName) => {
                                  if (currentValues[varName] !== undefined) {
                                    newValues[varName] = currentValues[varName];
                                  }
                                });

                                // Preserve body variables
                                if (step.bodyTemplateId) {
                                  const template = bodies.find(
                                    (b) => b.id === step.bodyTemplateId,
                                  );
                                  if (template) {
                                    const matches =
                                      template.content.match(
                                        /\{\{([^}]+)\}\}/g,
                                      );
                                    if (matches) {
                                      matches.forEach((m) => {
                                        const varName = m.replace(
                                          /\{\{|\}\}/g,
                                          "",
                                        );
                                        if (
                                          currentValues[varName] !== undefined
                                        ) {
                                          newValues[varName] =
                                            currentValues[varName];
                                        }
                                      });
                                    }
                                  }
                                }

                                // Keep relevant header variables
                                if (newHeaderId) {
                                  const profile = headers.find(
                                    (h) => h.id === newHeaderId,
                                  );
                                  if (profile) {
                                    profile.headers.forEach((h) => {
                                      const matches =
                                        h.value.match(/\{\{([^}]+)\}\}/g);
                                      if (matches) {
                                        matches.forEach((m) => {
                                          const varName = m.replace(
                                            /\{\{|\}\}/g,
                                            "",
                                          );
                                          if (
                                            currentValues[varName] !== undefined
                                          ) {
                                            newValues[varName] =
                                              currentValues[varName];
                                          }
                                        });
                                      }
                                    });
                                  }
                                }

                                onUpdateStep(step.id, {
                                  headerProfileId: newHeaderId,
                                  data:
                                    Object.keys(newValues).length > 0
                                      ? JSON.stringify(newValues)
                                      : "",
                                });
                              }}
                            >
                              <option value="">No Headers</option>
                              {headers.map((h) => (
                                <option key={h.id} value={h.id}>
                                  {h.name}
                                </option>
                              ))}
                            </select>
                            {(step.action === "apiPost" ||
                              step.action === "apiPut") && (
                                <select
                                  className="flex-1 bg-white text-xs text-gray-700 rounded-md border border-gray-200 px-2 py-1.5 focus:border-emerald-500 outline-none disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                  value={step.bodyTemplateId || ""}
                                  disabled={step.enabled === false}
                                  onChange={(e) => {
                                    const newTemplateId =
                                      e.target.value || undefined;
                                    let currentValues: Record<string, string> =
                                      {};
                                    try {
                                      currentValues = JSON.parse(
                                        step.data || "{}",
                                      );
                                    } catch (err) { }

                                    let newValues: Record<string, string> = {};

                                    // Preserve URL variables
                                    const urlVars = new Set<string>();
                                    if (step.target) {
                                      const matches = step.target.match(
                                        /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                      );
                                      if (matches)
                                        matches.forEach((m) =>
                                          urlVars.add(
                                            m.replace(/\{\{|\}\}|\{|\}/g, ""),
                                          ),
                                        );
                                    }
                                    if (step.endpointId) {
                                      const endpoint = endpoints.find(
                                        (ep) => ep.id === step.endpointId,
                                      );
                                      if (endpoint) {
                                        Object.values(endpoint.baseUrls).forEach(
                                          (url) => {
                                            if (typeof url === "string") {
                                              const matches = url.match(
                                                /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                              );
                                              if (matches)
                                                matches.forEach((m) =>
                                                  urlVars.add(
                                                    m.replace(
                                                      /\{\{|\}\}|\{|\}/g,
                                                      "",
                                                    ),
                                                  ),
                                                );
                                            }
                                          },
                                        );
                                        if (endpoint.parameters) {
                                          endpoint.parameters.forEach((p) => {
                                            if (!p.enabled) return;
                                            const matches = p.value.match(
                                              /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                            );
                                            if (matches)
                                              matches.forEach((m) =>
                                                urlVars.add(
                                                  m.replace(
                                                    /\{\{|\}\}|\{|\}/g,
                                                    "",
                                                  ),
                                                ),
                                              );
                                          });
                                        }
                                      }
                                    }
                                    urlVars.forEach((varName) => {
                                      if (currentValues[varName] !== undefined) {
                                        newValues[varName] =
                                          currentValues[varName];
                                      }
                                    });

                                    // Preserve header variables
                                    if (step.headerProfileId) {
                                      const profile = headers.find(
                                        (h) => h.id === step.headerProfileId,
                                      );
                                      if (profile) {
                                        profile.headers.forEach((h) => {
                                          const matches =
                                            h.value.match(/\{\{([^}]+)\}\}/g);
                                          if (matches) {
                                            matches.forEach((m) => {
                                              const varName = m.replace(
                                                /\{\{|\}\}/g,
                                                "",
                                              );
                                              if (
                                                currentValues[varName] !==
                                                undefined
                                              ) {
                                                newValues[varName] =
                                                  currentValues[varName];
                                              }
                                            });
                                          }
                                        });
                                      }
                                    }

                                    if (newTemplateId) {
                                      const template = bodies.find(
                                        (b) => b.id === newTemplateId,
                                      );
                                      if (template) {
                                        const bodyVars = new Set<string>();
                                        const matches =
                                          template.content.match(
                                            /\{\{([^}]+)\}\}/g,
                                          );
                                        if (matches) {
                                          matches.forEach((m) =>
                                            bodyVars.add(
                                              m.replace(/\{\{|\}\}/g, ""),
                                            ),
                                          );
                                        }

                                        bodyVars.forEach((varName) => {
                                          if (
                                            currentValues[varName] !== undefined
                                          ) {
                                            newValues[varName] =
                                              currentValues[varName];
                                          } else if (
                                            template.defaultValues?.[varName]
                                          ) {
                                            newValues[varName] =
                                              template.defaultValues[varName];
                                          }
                                        });
                                      }
                                    }

                                    onUpdateStep(step.id, {
                                      bodyTemplateId: newTemplateId,
                                      data:
                                        Object.keys(newValues).length > 0
                                          ? JSON.stringify(newValues)
                                          : "",
                                    });
                                  }}
                                >
                                  <option value="">No Body</option>
                                  {bodies.map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                          </div>

                          {/* Dynamic Variable Inputs for URL, Header & Body */}
                          {step.headerProfileId ||
                            step.bodyTemplateId ||
                            step.endpointId ||
                            step.target?.includes("{{") ||
                            step.target?.includes("{") ? (
                            <div className="bg-gray-50 rounded-md border border-gray-200 p-2 space-y-3">
                              {/* URL Variables */}
                              {(() => {
                                const urlVars = new Set<string>();
                                if (step.target) {
                                  const matches = step.target.match(
                                    /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                  );
                                  if (matches)
                                    matches.forEach((m) =>
                                      urlVars.add(
                                        m.replace(/\{\{|\}\}|\{|\}/g, ""),
                                      ),
                                    );
                                }
                                if (step.endpointId) {
                                  const endpoint = endpoints.find(
                                    (e) => e.id === step.endpointId,
                                  );
                                  if (endpoint) {
                                    Object.values(endpoint.baseUrls).forEach(
                                      (url) => {
                                        if (typeof url === "string") {
                                          const matches = url.match(
                                            /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                          );
                                          if (matches)
                                            matches.forEach((m) =>
                                              urlVars.add(
                                                m.replace(
                                                  /\{\{|\}\}|\{|\}/g,
                                                  "",
                                                ),
                                              ),
                                            );
                                        }
                                      },
                                    );
                                    if (endpoint.parameters) {
                                      endpoint.parameters.forEach((p) => {
                                        if (!p.enabled) return;
                                        const matches = p.value.match(
                                          /\{\{([^}]+)\}\}|\{([^}]+)\}/g,
                                        );
                                        if (matches)
                                          matches.forEach((m) =>
                                            urlVars.add(
                                              m.replace(/\{\{|\}\}|\{|\}/g, ""),
                                            ),
                                          );
                                      });
                                    }
                                  }
                                }

                                if (urlVars.size === 0) return null;

                                let currentValues: Record<string, string> = {};
                                try {
                                  currentValues = JSON.parse(step.data || "{}");
                                } catch (e) { }

                                return (
                                  <div>
                                    <div className="text-[9px] font-bold text-blue-400 mb-1.5 flex items-center gap-1 uppercase tracking-wider">
                                      <Globe size={10} /> URL Variables
                                    </div>
                                    <div className="space-y-1.5">
                                      {Array.from(urlVars).map((varName) => (
                                        <div
                                          key={`url-${varName}`}
                                          className="flex items-center gap-2"
                                        >
                                          <label
                                            className="text-[10px] font-mono font-medium text-gray-500 w-24 truncate text-right shrink-0"
                                            title={varName}
                                          >
                                            {varName}
                                          </label>
                                          <div className="relative flex-1">
                                            <AutosaveTextField
                                              className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-[11px] text-gray-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                              placeholder="Value"
                                              value={currentValues[varName] || ""}
                                              onSave={(next) => {
                                                const newData = {
                                                  ...currentValues,
                                                  [varName]: next,
                                                };
                                                onUpdateStep(step.id, {
                                                  data: JSON.stringify(newData),
                                                });
                                              }}
                                              disabled={step.enabled === false}
                                            />
                                            <button
                                              className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-300 hover:text-blue-600 p-0.5 rounded"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setVariableMenuOpen(
                                                  variableMenuOpen?.stepId ===
                                                    step.id &&
                                                    variableMenuOpen?.paramName ===
                                                    varName
                                                    ? null
                                                    : {
                                                      stepId: step.id,
                                                      field: "data",
                                                      paramName: varName,
                                                    },
                                                );
                                              }}
                                            >
                                              <Braces size={10} />
                                            </button>
                                            {/* Variable Dropdown */}
                                            {variableMenuOpen?.stepId ===
                                              step.id &&
                                              variableMenuOpen?.paramName ===
                                              varName && (
                                                <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 text-xs">
                                                  <div className="px-2 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                                                    Insert Suite Variable
                                                  </div>
                                                  {(variables || []).map(
                                                    (v) => (
                                                      <button
                                                        key={v.id}
                                                        className="w-full text-left px-3 py-1.5 hover:bg-blue-50 hover:text-blue-700 font-mono flex items-center justify-between group"
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          const currentVal =
                                                            currentValues[
                                                            varName
                                                            ] || "";
                                                          const newData = {
                                                            ...currentValues,
                                                            [varName]: `${currentVal}{{${v.key}}}`,
                                                          };
                                                          onUpdateStep(
                                                            step.id,
                                                            {
                                                              data: JSON.stringify(
                                                                newData,
                                                              ),
                                                            },
                                                          );
                                                          setVariableMenuOpen(
                                                            null,
                                                          );
                                                        }}
                                                      >
                                                        <span>{v.key}</span>
                                                      </button>
                                                    ),
                                                  )}
                                                </div>
                                              )}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()}

                              {/* Header Variables */}
                              {(() => {
                                const profile = headers.find(
                                  (h) => h.id === step.headerProfileId,
                                );
                                if (!profile) return null;

                                const headerVars = new Set<string>();
                                profile.headers.forEach((h) => {
                                  const matches =
                                    h.value.match(/\{\{([^}]+)\}\}/g);
                                  if (matches) {
                                    matches.forEach((m) =>
                                      headerVars.add(
                                        m.replace(/\{\{|\}\}/g, ""),
                                      ),
                                    );
                                  }
                                });

                                if (headerVars.size === 0) return null;

                                let currentValues: Record<string, string> = {};
                                try {
                                  currentValues = JSON.parse(step.data || "{}");
                                } catch (e) { }

                                return (
                                  <div>
                                    <div className="text-[9px] font-bold text-blue-400 mb-1.5 flex items-center gap-1 uppercase tracking-wider">
                                      <FileText size={10} /> Header Variables
                                    </div>
                                    <div className="space-y-1.5">
                                      {Array.from(headerVars).map((varName) => (
                                        <div
                                          key={`header-${varName}`}
                                          className="flex items-center gap-2"
                                        >
                                          <label
                                            className="text-[10px] font-mono font-medium text-gray-500 w-24 truncate text-right shrink-0"
                                            title={varName}
                                          >
                                            {varName}
                                          </label>
                                          <div className="relative flex-1">
                                            <AutosaveTextField
                                              className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-[11px] text-gray-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                              placeholder="Value"
                                              value={currentValues[varName] || ""}
                                              onSave={(next) => {
                                                const newData = {
                                                  ...currentValues,
                                                  [varName]: next,
                                                };
                                                onUpdateStep(step.id, {
                                                  data: JSON.stringify(newData),
                                                });
                                              }}
                                              disabled={step.enabled === false}
                                            />
                                            <button
                                              className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-300 hover:text-blue-600 p-0.5 rounded"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setVariableMenuOpen(
                                                  variableMenuOpen?.stepId ===
                                                    step.id &&
                                                    variableMenuOpen?.paramName ===
                                                    varName
                                                    ? null
                                                    : {
                                                      stepId: step.id,
                                                      field: "data",
                                                      paramName: varName,
                                                    },
                                                );
                                              }}
                                            >
                                              <Braces size={10} />
                                            </button>
                                            {/* Variable Dropdown */}
                                            {variableMenuOpen?.stepId ===
                                              step.id &&
                                              variableMenuOpen?.paramName ===
                                              varName && (
                                                <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 text-xs">
                                                  <div className="px-2 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                                                    Insert Suite Variable
                                                  </div>
                                                  {(variables || []).map(
                                                    (v) => (
                                                      <button
                                                        key={v.id}
                                                        className="w-full text-left px-3 py-1.5 hover:bg-blue-50 hover:text-blue-700 font-mono flex items-center justify-between group"
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          const currentVal =
                                                            currentValues[
                                                            varName
                                                            ] || "";
                                                          const newData = {
                                                            ...currentValues,
                                                            [varName]: `${currentVal}{{${v.key}}}`,
                                                          };
                                                          onUpdateStep(
                                                            step.id,
                                                            {
                                                              data: JSON.stringify(
                                                                newData,
                                                              ),
                                                            },
                                                          );
                                                          setVariableMenuOpen(
                                                            null,
                                                          );
                                                        }}
                                                      >
                                                        <span>{v.key}</span>
                                                      </button>
                                                    ),
                                                  )}
                                                </div>
                                              )}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()}

                              {/* Body Variables */}
                              {(() => {
                                const template = bodies.find(
                                  (b) => b.id === step.bodyTemplateId,
                                );
                                if (!template) return null;

                                const bodyVars = new Set<string>();
                                const matches =
                                  template.content.match(/\{\{([^}]+)\}\}/g);
                                if (matches) {
                                  matches.forEach((m) =>
                                    bodyVars.add(m.replace(/\{\{|\}\}/g, "")),
                                  );
                                }

                                if (bodyVars.size === 0) return null;

                                let currentValues: Record<string, string> = {};
                                try {
                                  currentValues = JSON.parse(step.data || "{}");
                                } catch (e) { }

                                return (
                                  <div>
                                    <div className="text-[9px] font-bold text-blue-400 mb-1.5 flex items-center gap-1 uppercase tracking-wider">
                                      <FileCode size={10} /> Body Variables
                                    </div>
                                    <div className="space-y-1.5">
                                      {Array.from(bodyVars).map((varName) => (
                                        <div
                                          key={`body-${varName}`}
                                          className="flex items-center gap-2"
                                        >
                                          <label
                                            className="text-[10px] font-mono font-medium text-gray-500 w-24 truncate text-right shrink-0"
                                            title={varName}
                                          >
                                            {varName}
                                          </label>
                                          <div className="relative flex-1">
                                            <AutosaveTextField
                                              className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-[11px] text-gray-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                              placeholder={
                                                template.defaultValues?.[
                                                varName
                                                ] || "Value"
                                              }
                                              value={currentValues[varName] || ""}
                                              onSave={(next) => {
                                                const newData = {
                                                  ...currentValues,
                                                  [varName]: next,
                                                };
                                                onUpdateStep(step.id, {
                                                  data: JSON.stringify(newData),
                                                });
                                              }}
                                              disabled={step.enabled === false}
                                            />
                                            <button
                                              className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-300 hover:text-blue-600 p-0.5 rounded"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setVariableMenuOpen(
                                                  variableMenuOpen?.stepId ===
                                                    step.id &&
                                                    variableMenuOpen?.paramName ===
                                                    varName
                                                    ? null
                                                    : {
                                                      stepId: step.id,
                                                      field: "data",
                                                      paramName: varName,
                                                    },
                                                );
                                              }}
                                            >
                                              <Braces size={10} />
                                            </button>
                                            {/* Variable Dropdown */}
                                            {variableMenuOpen?.stepId ===
                                              step.id &&
                                              variableMenuOpen?.paramName ===
                                              varName && (
                                                <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 text-xs">
                                                  <div className="px-2 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                                                    Insert Suite Variable
                                                  </div>
                                                  {(variables || []).map(
                                                    (v) => (
                                                      <button
                                                        key={v.id}
                                                        className="w-full text-left px-3 py-1.5 hover:bg-blue-50 hover:text-blue-700 font-mono flex items-center justify-between group"
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          const currentVal =
                                                            currentValues[
                                                            varName
                                                            ] || "";
                                                          const newData = {
                                                            ...currentValues,
                                                            [varName]: `${currentVal}{{${v.key}}}`,
                                                          };
                                                          onUpdateStep(
                                                            step.id,
                                                            {
                                                              data: JSON.stringify(
                                                                newData,
                                                              ),
                                                            },
                                                          );
                                                          setVariableMenuOpen(
                                                            null,
                                                          );
                                                        }}
                                                      >
                                                        <span>{v.key}</span>
                                                      </button>
                                                    ),
                                                  )}
                                                </div>
                                              )}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          ) : (
                            <div className="relative">
                              <AutosaveTextField
                                multiline
                                className="w-full bg-white text-xs text-gray-700 rounded-md border border-gray-200 px-3 py-2 font-mono focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder-gray-400 min-h-[60px] resize-y disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                value={step.data || ""}
                                onSave={(next) =>
                                  onUpdateStep(step.id, { data: next })
                                }
                                placeholder="Request Body (JSON)"
                                disabled={step.enabled === false}
                              />
                              <button
                                className="absolute right-1 top-2 text-gray-400 hover:text-blue-600 p-1.5 rounded hover:bg-blue-50 transition-colors"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setVariableMenuOpen(
                                    variableMenuOpen?.stepId === step.id &&
                                      variableMenuOpen.field === "data" &&
                                      !variableMenuOpen.paramName
                                      ? null
                                      : { stepId: step.id, field: "data" },
                                  );
                                  setElementMenuOpen(null);
                                }}
                                title="Insert Variable"
                              >
                                <Braces size={14} />
                              </button>
                              {variableMenuOpen?.stepId === step.id &&
                                variableMenuOpen?.field === "data" &&
                                !variableMenuOpen?.paramName && (
                                  <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 text-xs">
                                    <div className="px-2 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                                      Insert Suite Variable
                                    </div>
                                    {(variables || []).map((v) => (
                                      <button
                                        key={v.id}
                                        className="w-full text-left px-3 py-1.5 hover:bg-blue-50 hover:text-blue-700 font-mono flex items-center justify-between group"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          insertVariable(
                                            step.id,
                                            "data",
                                            v.key,
                                          );
                                        }}
                                      >
                                        <span>{v.key}</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="relative">
                          <AutosaveTextField
                            className="w-full bg-gray-50 text-gray-700 rounded-md border border-gray-200 pl-3 pr-8 py-2 text-xs font-mono focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder-gray-400 disabled:opacity-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
                            value={step.data || ""}
                            onSave={(next) => onUpdateStep(step.id, { data: next })}
                            placeholder={
                              step.action === "goto"
                                ? "URL (e.g., https://google.com)"
                                : step.action === "waitForTimeout"
                                  ? "Duration in ms (e.g., 2000)"
                                  : step.action === "waitForVisible"
                                    ? "Element selector..."
                                    : step.action === "waitForHidden"
                                      ? "Element selector..."
                                      : step.action === "evaluate"
                                        ? "JS Expression"
                                        : step.action === "fill"
                                          ? "Text to type..."
                                          : step.action === "assertText"
                                            ? "Expected text..."
                                            : step.action === "assertValue"
                                              ? "Expected value..."
                                              : step.action === "assertUrl"
                                                ? "Expected URL..."
                                                : step.action === "assertTitle"
                                                  ? "Expected title..."
: step.action === "assertDisabled"
        ? "Element selector..."
        : step.action === "assertEnabled"
        ? "Element selector..."
        : step.action === "assertChecked"
        ? "Element selector..."
        : step.action === "assertUnchecked"
        ? "Element selector..."
                                                    : step.action ===
                                                      "selectOption"
                                                      ? "Option value..."
                                                      : step.action ===
                                                        "dragTo"
                                                        ? "Target selector..."
                                                        : step.action ===
                                                          "setInputFiles"
                                                          ? "File path..."
                                                          : step.action ===
                                                            "switchToWindow"
                                                            ? "URL or title to match..."
                                                               : step.action ===
                                                               "switchToFrame"
                                                               ? "Frame selector..."
                                                               : step.action.startsWith("assertAttribute")
                                                                 ? "attr=expected value..."
                                                                 : [
"click",
          "assertVisible",
          "assertInvisible",
          "assertNotExist",
          "assertEnabled",
          "assertChecked",
          "assertUnchecked",
          "hover",
          "highlight",
          "dblclick",
          "rightClick",
          "scrollIntoView",
          "check",
          "uncheck",
          "acceptDialog",
          "dismissDialog",
        ].includes(
                                                                step.action,
                                                              )
                                                                ? "Not required"
                                                                : "Value / Data"
                            }
                            disabled={
                              step.enabled === false ||
                              [
"click",
          "hover",
          "highlight",
          "scrollIntoView",
          "check",
          "uncheck",
          "assertVisible",
          "assertInvisible",
          "assertNotExist",
          "assertEnabled",
          "assertChecked",
          "assertUnchecked",
          "dblclick",
          "rightClick",
          "switchToWindow",
          "switchToFrame",
          "acceptDialog",
          "dismissDialog",
        ].includes(step.action)
      }
    />
    {![
      "click",
      "hover",
      "highlight",
      "scrollIntoView",
      "check",
      "uncheck",
      "assertVisible",
      "assertInvisible",
      "assertNotExist",
                            "dblclick",
                            "rightClick",
                            "switchToWindow",
                            "switchToFrame",
                            "acceptDialog",
                            "dismissDialog",
                          ].includes(step.action) && (
                              <button
                                className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 hover:text-blue-600 p-1.5 rounded hover:bg-blue-50 transition-colors"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setVariableMenuOpen(
                                    variableMenuOpen?.stepId === step.id &&
                                      variableMenuOpen.field === "data" &&
                                      !variableMenuOpen.paramName
                                      ? null
                                      : { stepId: step.id, field: "data" },
                                  );
                                  setElementMenuOpen(null);
                                }}
                                title="Insert Variable"
                              >
                                <Braces size={14} />
                              </button>
                            )}

                          {/* Variable Dropdown (Data) */}
                          {variableMenuOpen?.stepId === step.id &&
                            variableMenuOpen?.field === "data" &&
                            !variableMenuOpen?.paramName && (
                              <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 text-xs">
                                <div className="px-2 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                                  Insert Suite Variable
                                </div>
                                {(variables || []).map((v) => (
                                  <button
                                    key={v.id}
                                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 hover:text-blue-700 font-mono flex items-center justify-between group"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      insertVariable(step.id, "data", v.key);
                                    }}
                                  >
                                    <span>{v.key}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="grid grid-cols-2 gap-0.5 w-[70px]">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onUpdateStep(step.id, {
                            enabled: step.enabled === false ? true : false,
                          });
                        }}
                        className={`p-1 rounded-md transition-colors ${step.enabled === false ? "text-gray-400 bg-gray-100 hover:bg-green-50 hover:text-green-600" : "text-green-600 bg-green-50 hover:bg-green-100"}`}
                        title={
                          step.enabled === false
                            ? "Step Disabled (Click to Enable)"
                            : "Step Enabled (Click to Disable)"
                        }
                      >
                        {step.enabled === false ? (
                          <PowerOff size={14} />
                        ) : (
                          <Power size={14} />
                        )}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onUpdateStep(step.id, {
                            screenshot: !step.screenshot,
                          });
                        }}
                        className={`p-1 rounded-md transition-colors ${step.screenshot ? "text-blue-600 bg-blue-50 hover:bg-blue-100" : "text-gray-300 hover:text-blue-500 hover:bg-blue-50 opacity-0 group-hover:opacity-100"}`}
                        title={
                          step.screenshot
                            ? "Screenshot Enabled"
                            : "Enable Screenshot"
                        }
                      >
                        <Camera size={14} />
                      </button>
                      {onDuplicateStep && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDuplicateStep(step);
                          }}
                          className="text-gray-300 hover:text-blue-500 p-1 rounded-md hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100"
                          title="Duplicate Step"
                        >
                          <Copy size={14} />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirm(step.id);
                        }}
                        className="text-gray-300 hover:text-red-500 p-1 rounded-md hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete Step"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Advanced Settings Toggle */}
                  <div className="mt-2 pl-8 border-t border-gray-100 pt-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const newExpanded = new Set(expandedAdvancedOptions);
                        if (newExpanded.has(step.id)) {
                          newExpanded.delete(step.id);
                        } else {
                          newExpanded.add(step.id);
                        }
                        setExpandedAdvancedOptions(newExpanded);
                      }}
                      className="flex items-center gap-1 text-[10px] font-bold text-gray-500 uppercase tracking-wider hover:text-gray-700 transition-colors"
                    >
                      {expandedAdvancedOptions.has(step.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      Advanced Settings
                    </button>
                  </div>

                  {expandedAdvancedOptions.has(step.id) && (
                    <div className="bg-gray-50/30 rounded-b-md pb-2 mt-2 border-t border-gray-100 flex flex-col divide-y divide-gray-100">
                      {/* Advanced Options (Wait For Network) */}
                      {!step.action.startsWith("api") &&
                        !["waitForTimeout", "evaluate", "runModule"].includes(step.action) && (
                          <div className="pl-8 py-2">
                            <div className="flex items-center gap-2 mb-2">
                              <input
                                type="checkbox"
                                id={`wait-network-${step.id}`}
                                checked={step.waitForNetwork?.enabled || false}
                                onChange={(e) => {
                                  onUpdateStep(step.id, {
                                    waitForNetwork: {
                                      ...(step.waitForNetwork || { urlPattern: "", method: "ANY", expectedStatus: 200, timeoutMs: 10000, extractors: [] }),
                                      enabled: e.target.checked,
                                    }
                                  });
                                }}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              />
                              <div className="flex items-center gap-1">
                                <label htmlFor={`wait-network-${step.id}`} className="text-[10px] font-bold text-gray-500 uppercase tracking-wider cursor-pointer">
                                  Wait for API Response (Smart Wait)
                                </label>
                                <HelpTooltip content={
                                  <div className="w-64">
                                    <p className="mb-1 font-semibold">Smart Wait & Hybrid Extraction</p>
                                    <p className="mb-1 text-gray-300">Wait for a specific API request to complete after this UI action.</p>
                                    <p className="mb-1 text-gray-300">You can also extract data directly from the API response (e.g., using JSONPath) for subsequent steps.</p>
                                  </div>
                                } />
                              </div>
                            </div>

                            {step.waitForNetwork?.enabled && (
                              <div className="bg-gray-50 p-2 rounded-md border border-gray-200 mt-1 space-y-2">
                                <div className="grid grid-cols-5 gap-2">
                                  <div className="col-span-2">
                                    <label className="block text-[10px] font-medium text-gray-500 mb-0.5">URL Pattern / Keyword</label>
                                    <AutosaveTextField
                                      className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                      placeholder="/api/v1/orders"
                                      value={step.waitForNetwork.urlPattern || ""}
                                      onSave={(next) => onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, urlPattern: next } })}
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Method</label>
                                    <select
                                      className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                      value={step.waitForNetwork.method || "ANY"}
                                      onChange={(e) => onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, method: e.target.value } })}
                                    >
                                      <option value="ANY">ANY</option>
                                      <option value="GET">GET</option>
                                      <option value="POST">POST</option>
                                      <option value="PUT">PUT</option>
                                      <option value="DELETE">DELETE</option>
                                    </select>
                                  </div>
                                  <div>
                                    <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Expected Status</label>
                                    <AutosaveTextField
                                      type="number"
                                      className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                      placeholder="200"
                                      value={step.waitForNetwork.expectedStatus?.toString() || ""}
                                      onSave={(next) => onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, expectedStatus: parseInt(next) || undefined } })}
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Timeout (ms)</label>
                                    <AutosaveTextField
                                      type="number"
                                      className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                      placeholder="10000"
                                      value={step.waitForNetwork.timeoutMs?.toString() || ""}
                                      onSave={(next) => onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, timeoutMs: parseInt(next) || undefined } })}
                                    />
                                  </div>
                                </div>

                                {/* API Extractors inside Smart Wait */}
                                <div className="pt-2 border-t border-gray-200 mt-2">
                                  <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center justify-between">
                                    <div className="flex items-center gap-1">
                                      <span>API Extractors (Hybrid Extraction)</span>
                                    </div>
                                    <button
                                      onClick={() => {
                                        const exts = step.waitForNetwork!.extractors || [];
                                        onUpdateStep(step.id, {
                                          waitForNetwork: {
                                            ...step.waitForNetwork!,
                                            extractors: [...exts, { id: generateId(), name: "", source: "API_BODY_JSON", expression: "", scope: "CASE" }]
                                          }
                                        });
                                      }}
                                      className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
                                    >
                                      <Plus size={10} /> Add Extractor
                                    </button>
                                  </div>

                                  {(step.waitForNetwork.extractors || []).length > 0 && (
                                    <div className="space-y-2">
                                      {(step.waitForNetwork.extractors || []).map((ext, idx) => (
                                        <div key={ext.id} className="flex items-center gap-2 bg-gray-50 p-1.5 rounded border border-gray-200">
                                          <AutosaveTextField
                                            className="w-32 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500"
                                            placeholder="Variable Name"
                                            value={ext.name}
                                            onSave={(next) => {
                                              const newExts = [...step.waitForNetwork!.extractors!];
                                              newExts[idx] = { ...newExts[idx], name: next };
                                              onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, extractors: newExts } });
                                            }}
                                          />
                                          <select
                                            className="w-36 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500 bg-white"
                                            value={ext.source}
                                            onChange={(e) => {
                                              const newExts = [...step.waitForNetwork!.extractors!];
                                              newExts[idx] = { ...newExts[idx], source: e.target.value as any };
                                              onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, extractors: newExts } });
                                            }}
                                          >
                                            <option value="API_BODY_JSON">JSON Body</option>
                                            <option value="API_BODY_XML">XML Body</option>
                                            <option value="API_BODY_REGEX">Regex</option>
                                            <option value="API_HEADER">Header</option>
                                          </select>
                                          <AutosaveTextField
                                            className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500"
                                            placeholder={(ext.source === 'API_BODY_JSON' || ext.source === 'API_BODY_XML') ? '$.data.id (or $.user[\'@_id\'])' : ext.source === 'API_HEADER' ? "Authorization" : "Expression"}
                                            value={ext.expression || ""}
                                            onSave={(next) => {
                                              const newExts = [...step.waitForNetwork!.extractors!];
                                              newExts[idx] = { ...newExts[idx], expression: next };
                                              onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, extractors: newExts } });
                                            }}
                                          />
                                          <select
                                            className="w-24 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500 bg-white"
                                            value={ext.scope || 'CASE'}
                                            onChange={(e) => {
                                              const newExts = [...step.waitForNetwork!.extractors!];
                                              newExts[idx] = { ...newExts[idx], scope: e.target.value as any };
                                              onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, extractors: newExts } });
                                            }}
                                          >
                                            <option value="CASE">Case</option>
                                            <option value="SUITE">Suite</option>
                                            <option value="SCENARIO">Scenario</option>
                                            <option value="ENVIRONMENT">Environment</option>
                                          </select>
                                          <button
                                            onClick={() => {
                                              const newExts = [...step.waitForNetwork!.extractors!];
                                              newExts.splice(idx, 1);
                                              onUpdateStep(step.id, { waitForNetwork: { ...step.waitForNetwork!, extractors: newExts } });
                                            }}
                                            className="text-gray-400 hover:text-red-500 p-1"
                                          >
                                            <Trash2 size={12} />
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
</div>
</div>
)}
                          </div>
                        )}

                      {/* Network Mocks Section */}
                      {!step.action.startsWith("api") &&
                        !["waitForTimeout", "evaluate", "runModule"].includes(step.action) && (
                          <div className="pl-8 py-2">
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center justify-between">
                              <div className="flex items-center gap-1">
                                <span>Network Mocks</span>
                                <HelpTooltip content={
                                  <div className="w-64">
                                    <p className="mb-1 font-semibold">Network Interception</p>
                                    <p className="mb-1 text-gray-300">Mock API responses triggered by this UI action.</p>
                                    <p className="mb-1 text-gray-300">Useful for testing error states (e.g., 500) or bypassing third-party services.</p>
                                  </div>
                                } />
                              </div>
                              <button
                                onClick={() => {
                                  const mocks = step.networkMocks || [];
                                  onUpdateStep(step.id, {
                                    networkMocks: [...mocks, { id: generateId(), enabled: true, urlPattern: "", method: "ANY", status: 200, body: "{}" }]
                                  });
                                }}
                                className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
                              >
                                <Plus size={10} /> Add Mock
                              </button>
                            </div>

                            {(step.networkMocks || []).length > 0 && (
                              <div className="space-y-2">
                                {(step.networkMocks || []).map((mock, idx) => (
                                  <div key={mock.id} className="bg-gray-50 p-2 rounded-md border border-gray-200">
                                    <div className="flex items-center justify-between mb-2">
                                      <div className="flex items-center gap-2">
                                        <input
                                          type="checkbox"
                                          checked={mock.enabled}
                                          onChange={(e) => {
                                            const newMocks = [...step.networkMocks!];
                                            newMocks[idx].enabled = e.target.checked;
                                            onUpdateStep(step.id, { networkMocks: newMocks });
                                          }}
                                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                        />
                                        <span className="text-xs font-medium text-gray-700">Mock Rule {idx + 1}</span>
                                      </div>
                                      <button
                                        onClick={() => {
                                          const newMocks = [...step.networkMocks!];
                                          newMocks.splice(idx, 1);
                                          onUpdateStep(step.id, { networkMocks: newMocks });
                                        }}
                                        className="text-gray-400 hover:text-red-500"
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    </div>
                                    <div className="grid grid-cols-6 gap-2 mb-2">
                                      <div className="col-span-3">
                                        <label className="block text-[10px] font-medium text-gray-500 mb-0.5">URL Pattern (Regex)</label>
                                        <AutosaveTextField
                                          className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                          placeholder=".*\/api\/payment.*"
                                          value={mock.urlPattern}
                                          onSave={(next) => {
                                            const newMocks = [...step.networkMocks!];
                                            newMocks[idx].urlPattern = next;
                                            onUpdateStep(step.id, { networkMocks: newMocks });
                                          }}
                                        />
                                      </div>
                                      <div className="col-span-1">
                                        <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Method</label>
                                        <select
                                          className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                          value={mock.method || "ANY"}
                                          onChange={(e) => {
                                            const newMocks = [...step.networkMocks!];
                                            newMocks[idx].method = e.target.value;
                                            onUpdateStep(step.id, { networkMocks: newMocks });
                                          }}
                                        >
                                          <option value="ANY">ANY</option>
                                          <option value="GET">GET</option>
                                          <option value="POST">POST</option>
                                          <option value="PUT">PUT</option>
                                          <option value="DELETE">DELETE</option>
                                        </select>
                                      </div>
                                      <div className="col-span-1">
                                        <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Status</label>
                                        <AutosaveTextField
                                          type="number"
                                          className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                          placeholder="200"
                                          value={mock.status.toString()}
                                          onSave={(next) => {
                                            const newMocks = [...step.networkMocks!];
                                            newMocks[idx].status = parseInt(next) || 200;
                                            onUpdateStep(step.id, { networkMocks: newMocks });
                                          }}
                                        />
                                      </div>
                                      <div className="col-span-1">
                                        <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Delay (ms)</label>
                                        <AutosaveTextField
                                          type="number"
                                          className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                          placeholder="0"
                                          value={mock.delayMs?.toString() || ""}
                                          onSave={(next) => {
                                            const newMocks = [...step.networkMocks!];
                                            newMocks[idx].delayMs = parseInt(next) || undefined;
                                            onUpdateStep(step.id, { networkMocks: newMocks });
                                          }}
                                        />
                                      </div>
                                    </div>
                                    <div>
                                      <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Response Body (JSON)</label>
                                      <AutosaveTextField
                                        multiline
                                        className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs font-mono outline-none focus:border-blue-500 min-h-[60px] resize-y"
                                        placeholder='{"success": true}'
                                        value={mock.body}
                                        onSave={(next) => {
                                          const newMocks = [...step.networkMocks!];
                                          newMocks[idx].body = next;
                                          onUpdateStep(step.id, { networkMocks: newMocks });
                                        }}
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

{/* Assertions Section */}
<div className="pl-8 py-2">
  <AssertionEditor
    isApiStep={step.action.startsWith("api")}
    assertions={step.assertions || []}
    onChange={(assertions) => {
      onUpdateStep(step.id, { assertions });
    }}
  />
  <ReviewAssertionsPanel
    items={(step.metadata as any)?.reviewAssertions || []}
    onAccept={(assertion) => {
      const review = ((step.metadata as any)?.reviewAssertions || [])
        .filter((r: any) => r.assertion.id !== assertion.id);
      onUpdateStep(step.id, {
        assertions: [...(step.assertions || []), assertion],
        metadata: { ...(step.metadata || {}), reviewAssertions: review },
      } as any);
    }}
    onDismiss={(assertionId) => {
      const review = ((step.metadata as any)?.reviewAssertions || [])
        .filter((r: any) => r.assertion.id !== assertionId);
      onUpdateStep(step.id, {
        metadata: { ...(step.metadata || {}), reviewAssertions: review },
      } as any);
    }}
  />
  {(step.assertions || []).length > 0 && (
    <div className="flex items-center gap-2 mt-2">
      <label className="text-[10px] font-medium text-gray-500">On failure:</label>
      <select
        className="text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500 bg-white"
        value={step.failureStrategy || 'fail-fast'}
        onChange={(e) => {
          onUpdateStep(step.id, { failureStrategy: e.target.value as 'fail-fast' | 'soft' });
        }}
      >
        <option value="fail-fast">Fail Fast (stop step)</option>
        <option value="soft">Soft (collect all, continue)</option>
      </select>
    </div>
  )}
</div>

                      {/* Extractors Section */}
                      <div className="pl-8 py-2">
                        <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <span>Variable Extractors</span>
                            <HelpTooltip content={
                              <div className="w-64">
                                {step.action.startsWith('api') ? (
                                  <>
                                    <p className="mb-1 font-semibold">JSON / XML Extraction</p>
                                    <p className="mb-1 text-gray-300">Use JSONPath syntax (e.g., <code className="text-blue-300">$.data.id</code>).</p>
                                    <p className="mb-1 text-gray-300">XML is auto-converted to JSON. Attributes get an <code className="text-blue-300">@_</code> prefix.</p>
                                    <div className="bg-gray-900 p-1.5 rounded mt-1">
                                      <p className="text-gray-400 mb-1">XML: &lt;user id="1"&gt;John&lt;/user&gt;</p>
                                      <p className="text-gray-400">Path: <code className="text-blue-300">$.user['@_id']</code> &rarr; 1</p>
                                      <p className="text-gray-400">Path: <code className="text-blue-300">$.user['#text']</code> &rarr; John</p>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <p className="mb-1 font-semibold">UI Variable Extraction</p>
                                    <ul className="list-disc pl-4 text-gray-300 space-y-1 mt-1">
                                      <li><strong>Text / Value:</strong> Extracts text content or input value of the element.</li>
                                      <li><strong>Attribute:</strong> Extracts an HTML attribute. Enter the attribute name (e.g., <code className="text-blue-300">href</code>, <code className="text-blue-300">src</code>) in the Expression field.</li>
                                      <li><strong>Page URL / Title:</strong> Extracts the current page's URL or Title.</li>
                                    </ul>
                                  </>
                                )}
                                <div className="mt-2 pt-2 border-t border-gray-700">
                                  <p className="font-semibold mb-1">How to use:</p>
                                  <p className="text-gray-300">Reference the extracted variable in subsequent steps using <code className="text-blue-300">{"{{"}variable_name{"}}"}</code>.</p>
                                </div>
                              </div>
                            } />
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const newExtractors = [...(step.extractors || []), { id: generateId(), name: '', source: (step.action.startsWith('api') ? 'API_BODY_JSON' : 'UI_TEXT') as any, scope: 'SUITE' as any }];
                              onUpdateStep(step.id, { extractors: newExtractors });
                            }}
                            className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
                          >
                            <Plus size={10} /> Add Extractor
                          </button>
                        </div>
                        {step.extractors && step.extractors.length > 0 && (
                          <div className="space-y-2">
                            {step.extractors.map((ext, extIndex) => (
                              <div key={ext.id} className="flex items-center gap-2 bg-gray-50 p-1.5 rounded border border-gray-200">
                                <AutosaveTextField
                                  className="w-32 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500"
                                  placeholder="Variable Name"
                                  value={ext.name}
                                  onSave={(next) => {
                                    const newExts = [...step.extractors!];
                                    newExts[extIndex] = { ...ext, name: next };
                                    onUpdateStep(step.id, { extractors: newExts });
                                  }}
                                />
                                <select
                                  className="w-36 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500 bg-white"
                                  value={ext.source}
                                  onChange={(e) => {
                                    const newExts = [...step.extractors!];
                                    newExts[extIndex] = { ...ext, source: e.target.value as any };
                                    onUpdateStep(step.id, { extractors: newExts });
                                  }}
                                >
{step.action.startsWith('api') ? (
                                    <>
                                      <option value="API_BODY_JSON">JSON Body</option>
                                      <option value="API_BODY_XML">XML Body</option>
                                      <option value="API_BODY_REGEX">Regex</option>
                                      <option value="API_HEADER">Header</option>
                                    </>
                                  ) : (
                                    <>
                                      <option value="UI_TEXT">Element Text</option>
                                      <option value="UI_VALUE">Input Value</option>
                                      <option value="UI_ATTRIBUTE">Attribute</option>
                                      <option value="UI_PAGE_URL">Page URL</option>
                                      <option value="UI_PAGE_TITLE">Page Title</option>
                                    </>
                                  )}
                                </select>
                                {!['UI_TEXT', 'UI_VALUE', 'UI_PAGE_URL', 'UI_PAGE_TITLE'].includes(ext.source) && (
                                  <AutosaveTextField
                                    className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500"
                                    placeholder={(ext.source === 'API_BODY_JSON' || ext.source === 'API_BODY_XML') ? '$.data.id (or $.user[\'@_id\'])' : ext.source === 'API_HEADER' ? 'Authorization' : ext.source === 'UI_ATTRIBUTE' ? 'href' : 'Expression'}
                                    value={ext.expression || ''}
                                    onSave={(next) => {
                                      const newExts = [...step.extractors!];
                                      newExts[extIndex] = { ...ext, expression: next };
                                      onUpdateStep(step.id, { extractors: newExts });
                                    }}
                                  />
                                )}
                                <select
                                  className="w-24 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-500 bg-white"
                                  value={ext.scope || 'CASE'}
                                  onChange={(e) => {
                                    const newExts = [...step.extractors!];
                                    newExts[extIndex] = { ...ext, scope: e.target.value as any };
                                    onUpdateStep(step.id, { extractors: newExts });
                                  }}
                                >
                                  <option value="CASE">Case</option>
                                  <option value="SUITE">Suite</option>
                                  <option value="SCENARIO">Scenario</option>
                                  <option value="ENVIRONMENT">Environment</option>
                                </select>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const newExts = step.extractors!.filter((_, i) => i !== extIndex);
                                    onUpdateStep(step.id, { extractors: newExts });
                                  }}
                                  className="text-gray-400 hover:text-red-500 p-1"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {onAddStep && (
            <div className="mt-4 flex flex-col gap-2 pb-48">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onAddStep("click")}
                  className="flex-1 py-2.5 border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all flex items-center justify-center gap-1.5 text-xs font-medium group shadow-sm"
                >
                  <MousePointer2
                    size={14}
                    className="group-hover:scale-110 transition-transform"
                  />{" "}
                  Add Web Step
                </button>
                <button
                  onClick={() => onAddStep("apiGet")}
                  className="flex-1 py-2.5 border border-gray-200 rounded-lg text-gray-600 hover:text-emerald-600 hover:border-emerald-300 hover:bg-emerald-50 transition-all flex items-center justify-center gap-1.5 text-xs font-medium group shadow-sm"
                >
                  <Globe
                    size={14}
                    className="group-hover:scale-110 transition-transform"
                  />{" "}
                  Add API Step
                </button>
                <button
                  onClick={() => onAddStep("runModule")}
                  className="flex-1 py-2.5 border border-gray-200 rounded-lg text-gray-600 hover:text-purple-600 hover:border-purple-300 hover:bg-purple-50 transition-all flex items-center justify-center gap-1.5 text-xs font-medium group shadow-sm"
                >
                  <Workflow
                    size={14}
                    className="group-hover:scale-110 transition-transform"
                  />{" "}
                  Add Module
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
