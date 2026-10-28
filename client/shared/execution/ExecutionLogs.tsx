import React, { useState, useMemo } from "react";
import { ExecutionLog } from "@/shared/types";
import { X, ChevronRight, ChevronDown, Info, AlertTriangle, XCircle, CheckCircle, Copy, Check } from "lucide-react";

interface ExecutionLogsProps {
  logs: ExecutionLog[];
}

const LogLevelIcon = ({ level }: { level?: string }) => {
  switch (level) {
    case 'error': return <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
    case 'warn': return <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />;
    case 'success': return <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />;
    case 'info': return <Info className="w-4 h-4 text-blue-400 shrink-0" />;
    case 'debug': return <Info className="w-4 h-4 text-slate-500 shrink-0" />;
    default: return <Info className="w-4 h-4 text-slate-400 shrink-0 opacity-0" />; // Placeholder for alignment
  }
};

const LogLevelColor = (level?: string, status?: string) => {
  if (status === 'FAIL') return 'text-red-400';
  switch (level) {
    case 'error': return 'text-red-400';
    case 'warn': return 'text-yellow-400';
    case 'success': return 'text-emerald-400';
    case 'info': return 'text-slate-300';
    case 'debug': return 'text-slate-500';
    default: return 'text-slate-400';
  }
};

const JsonViewer = ({ data }: { data: any }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const formattedData = useMemo(() => {
    const tryParseJson = (value: any) => {
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
          }
        } catch (e) {
          // Not JSON
        }
      }
      return value;
    };

    const formatObj = (obj: any): any => {
      if (Array.isArray(obj)) {
        return obj.map(formatObj);
      } else if (typeof obj === 'object' && obj !== null) {
        const newObj: any = {};
        for (const key in obj) {
          newObj[key] = formatObj(tryParseJson(obj[key]));
        }
        return newObj;
      }
      return obj;
    };

    return formatObj(data);
  }, [data]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = JSON.stringify(formattedData, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (!data) return null;

  return (
    <div className="mt-1 text-xs font-mono bg-slate-900/50 rounded border border-slate-800 overflow-hidden">
      <div className="flex items-center justify-between hover:bg-slate-800/50 transition-colors pr-2">
        <button 
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 px-2 py-1 flex-1 text-left text-slate-400"
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span>Metadata {expanded ? '' : '{...}'}</span>
        </button>
        <button
          onClick={handleCopy}
          className="p-1 hover:bg-slate-700 rounded text-slate-500 hover:text-slate-300 transition-all"
          title="Copy metadata to clipboard"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
      {expanded && (
        <div className="p-2 overflow-x-auto">
          <pre className="text-slate-300 m-0 whitespace-pre-wrap break-all">
            {JSON.stringify(formattedData, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

export const ExecutionLogs: React.FC<ExecutionLogsProps> = ({ logs }) => {
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string>('info');
  const [autoScroll, setAutoScroll] = useState(true);

  const filteredLogs = useMemo(() => {
    if (filterLevel === 'all') return logs;
    
    const levelSeverity: Record<string, number> = {
      debug: 0,
      info: 1,
      success: 2,
      warn: 3,
      error: 4,
    };

    const filterSeverity = levelSeverity[filterLevel] ?? 1;

    return logs.filter(log => {
      const level = log.level || 'info';
      const logSeverity = levelSeverity[level] ?? 1;
      
      return logSeverity >= filterSeverity;
    });
  }, [logs, filterLevel]);

  return (
    <div className="flex flex-col h-full bg-slate-950 rounded-md border border-slate-800 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-400">Filter:</span>
          <select 
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value)}
            className="bg-slate-800 text-xs text-slate-300 border border-slate-700 rounded px-2 py-1 outline-none focus:border-blue-500"
          >
            <option value="all">All Levels</option>
            <option value="debug">Debug & Above</option>
            <option value="info">Info & Above</option>
            <option value="success">Success & Above</option>
            <option value="warn">Warning & Above</option>
            <option value="error">Error Only</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
            <input 
              type="checkbox" 
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded bg-slate-800 border-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900"
            />
            Auto-scroll
          </label>
        </div>
      </div>

      {/* Logs Container - Standard rendering for now to support dynamic heights easily, 
          can upgrade to VariableSizeList if performance becomes an issue with 10k+ logs */}
      <div 
        className="flex-1 overflow-y-auto p-4 space-y-3"
        onScroll={(e) => {
          const target = e.target as HTMLDivElement;
          const isAtBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 50;
          if (!isAtBottom && autoScroll) {
            setAutoScroll(false);
          } else if (isAtBottom && !autoScroll) {
            setAutoScroll(true);
          }
        }}
      >
        {filteredLogs.length === 0 ? (
          <div className="text-center text-slate-500 text-sm py-8">No logs match the current filter.</div>
        ) : (
          filteredLogs.map((log, idx) => (
            <div key={idx} className="flex gap-3 text-xs leading-relaxed items-start animate-in fade-in duration-200">
              <span className="text-slate-600 shrink-0 select-none w-16 pt-0.5">
                [{new Date(log.timestamp).toLocaleTimeString().split(" ")[0]}]
              </span>
              <LogLevelIcon level={log.level} />
              <div className={`flex-1 min-w-0 break-words ${LogLevelColor(log.level, log.status)}`}>
                <span className={
                  log.message.includes("🚀") || log.message.includes("🎬") ? "text-blue-400 font-bold" :
                  log.message.includes("✅") || log.message.includes("Completed Successfully") ? "text-emerald-400" :
                  log.message.includes("📦") ? "text-purple-400" :
                  log.message.includes("🌐") ? "text-cyan-400" :
                  log.message.includes("📊") ? "text-yellow-400" : ""
                }>
                  {log.message}
                </span>
                
                {log.metadata && Object.keys(log.metadata).length > 0 && (
                  <JsonViewer data={log.metadata} />
                )}

                {log.screenshot && (
                  <div className="mt-2">
                    <img
                      src={log.screenshot}
                      alt="Step screenshot"
                      className="rounded border border-slate-700 shadow-lg object-contain max-h-48 bg-slate-800 cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => setEnlargedImage(log.screenshot || null)}
                    />
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={(el) => {
          if (el && autoScroll) {
            el.scrollIntoView({ behavior: 'smooth' });
          }
        }} />
      </div>

      {/* Image Enlargement Modal */}
      {enlargedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setEnlargedImage(null)}
        >
          <div className="relative max-w-7xl max-h-full">
            <img
              src={enlargedImage}
              alt="Enlarged screenshot"
              className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              onClick={() => setEnlargedImage(null)}
              className="absolute -top-4 -right-4 bg-slate-800 text-slate-200 rounded-full p-2 hover:bg-slate-700 transition-colors shadow-lg border border-slate-700"
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
