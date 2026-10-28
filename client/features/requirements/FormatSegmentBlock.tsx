import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface SegmentItem {
  /** Display label, e.g. "As a", "Given" */
  label: string;
  /** Segment content (already trimmed). If absent, the row is skipped. */
  content?: string;
}

interface Props {
  /** Parsed segments to render top-to-bottom. */
  segments: SegmentItem[];
  /** Leftover text not captured by any segment (rendered as markdown below segments). */
  remainder?: string;
  /** Container styling variant. */
  variant?: "story" | "ac";
}

const variantStyles: Record<NonNullable<Props["variant"]>, { labelClass: string; rowClass: string }> = {
  story: {
    labelClass:
      "text-[10.5px] font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded",
    rowClass: "flex items-start gap-3",
  },
  ac: {
    labelClass:
      "text-[10.5px] font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded",
    rowClass: "flex items-start gap-3",
  },
};

export function FormatSegmentBlock({ segments, remainder, variant = "story" }: Props) {
  const visible = segments.filter((s) => s.content && s.content.trim().length > 0);
  const hasRemainder = remainder && remainder.trim().length > 0;
  const styles = variantStyles[variant];

  if (visible.length === 0 && !hasRemainder) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/30 px-4 py-3 text-sm text-slate-400 text-center italic">
        Empty — awaiting content
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/30 px-4 py-3 space-y-2 text-sm text-slate-700 leading-relaxed">
      {visible.map((seg, i) => (
        <div key={`${seg.label}-${i}`} className={styles.rowClass}>
          <span className={`mt-0.5 shrink-0 font-mono ${styles.labelClass}`} aria-label={seg.label}>
            {seg.label}
          </span>
          <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">
            {seg.content}
          </span>
        </div>
      ))}

      {hasRemainder && (
        <div className={`${visible.length > 0 ? "pt-2.5 mt-2.5 border-t border-slate-200" : ""} text-slate-600 [&_p]:mb-1.5 [&_p:last-child]:mb-0`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{remainder!}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
