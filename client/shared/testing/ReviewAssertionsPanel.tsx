import React from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { StepAssertion } from '@/shared/types';

/**
 * AI 审核队列面板（转化管线阶段 E，docs/07 §4-E）
 *
 * 展示未通过确认运行的 AI 断言提议（step.metadata.reviewAssertions，不可执行），
 * 附各次确认运行的实际值证据。人审可"采纳"（提升为可执行断言）或"忽略"（移出队列）。
 */
export interface ReviewAssertionItem {
  assertion: StepAssertion;
  runs: Array<{ passed: boolean; actualValue?: string; message?: string }>;
  reason: string;
}

interface ReviewAssertionsPanelProps {
  items: ReviewAssertionItem[];
  onAccept?: (assertion: StepAssertion) => void;
  onDismiss?: (assertionId: string) => void;
}

export function ReviewAssertionsPanel({ items, onAccept, onDismiss }: ReviewAssertionsPanelProps) {
  if (!items || items.length === 0) return null;

  return (
    <div className="mt-2">
      <div className="text-[10px] font-bold text-amber-600 uppercase tracking-wider mb-1.5 flex items-center gap-1">
        <ShieldAlert size={11} />
        <span>AI Review Queue ({items.length})</span>
      </div>
      <div className="space-y-1.5">
        {items.map((item, idx) => (
          <div
            key={`${item.assertion.id}-${idx}`}
            className="bg-amber-50 border border-amber-200 rounded p-1.5"
          >
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-700 font-mono truncate">
                  [{item.assertion.source}] {item.assertion.operator}
                  {item.assertion.expectedValue !== undefined ? ` "${item.assertion.expectedValue}"` : ''}
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">
                  Not confirmed: {item.reason}
                </div>
                {item.runs.length > 0 && (
                  <div className="text-[10px] text-gray-500 mt-0.5 font-mono">
                    {item.runs.map((run, i) => (
                      <span key={i} className={run.passed ? 'text-green-600' : 'text-red-500'}>
                        run{i + 1}: {run.passed ? 'PASS' : 'FAIL'}
                        {run.actualValue !== undefined ? ` (actual: ${String(run.actualValue).slice(0, 40)})` : ''}
                        {i < item.runs.length - 1 ? ' · ' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-1">
                {onAccept && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onAccept(item.assertion); }}
                    className="p-1 text-green-600 hover:text-green-800 hover:bg-green-100 rounded"
                    title="Accept as executable assertion"
                  >
                    <Check size={13} />
                  </button>
                )}
                {onDismiss && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDismiss(item.assertion.id); }}
                    className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
                    title="Discard proposal"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
