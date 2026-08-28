import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, Loader2, Clock, FileText, User, Bot, Wrench, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { api } from '@/shared/services/api';

interface AgentPromptsPanelProps {
  projectId: string;
}

const AGENTS = [
  { name: 'test_analyst', label: 'Test Analyst', desc: 'Derives test conditions' },
  { name: 'test_designer', label: 'Test Designer', desc: 'Designs test cases' },
  { name: 'quality_manager', label: 'Quality Reviewer', desc: 'Reviews final quality' },
] as const;

type AgentName = typeof AGENTS[number]['name'];

const PROMPT_TABS = [
  { key: 'system', label: 'System', icon: Bot },
  { key: 'user', label: 'User', icon: User },
] as const;

type PromptTabKey = typeof PROMPT_TABS[number]['key'];

const AGENT_TOOLS: Record<AgentName, string[]> = {
  test_analyst: ['requirement_detail_query', 'requirement_graph_query', 'flow_detail_query', 'istqb_equivalence_partitioning', 'istqb_boundary_value_analysis', 'istqb_decision_table', 'istqb_state_transition', 'istqb_use_case_testing', 'knowledge_base', 'html_knowledge_query'],
  test_designer: ['requirement_detail_query', 'requirement_graph_query', 'flow_detail_query', 'istqb_equivalence_partitioning', 'istqb_boundary_value_analysis', 'istqb_decision_table', 'istqb_state_transition', 'istqb_use_case_testing', 'knowledge_base', 'html_knowledge_query'],
  quality_manager: ['requirement_detail_query', 'knowledge_base', 'html_knowledge_query'],
};

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export function AgentPromptsPanel({ projectId }: AgentPromptsPanelProps) {
  const [activeAgent, setActiveAgent] = useState<AgentName>('test_analyst');
  const [activePromptTab, setActivePromptTab] = useState<PromptTabKey>('system');
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [copied, setCopied] = useState(false);
  const tools = AGENT_TOOLS[activeAgent];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.testGen.getLatestRunPrompts(projectId)
      .then(data => {
        if (cancelled) return;
        setLogs(data || []);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load prompts');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  const agentLogs = logs.filter(log =>
    log.agent_name === activeAgent && log.status === 'COMPLETED'
  );
  const latestLog = agentLogs.length > 0 ? agentLogs[agentLogs.length - 1] : null;
  const messages: ChatMessage[] = latestLog?.input_prompt ?? [];
  const systemMessage = messages.find(m => m.role === 'system');
  const userMessage = messages.find(m => m.role === 'user');

  const runDate = latestLog?.created_at
    ? new Date(latestLog.created_at.replace('Z', '') + 'Z').toLocaleString()
    : '';
  const batch = latestLog?.batch ?? 0;
  const currentMessage = activePromptTab === 'system' ? systemMessage : userMessage;

  const hasAnyData = logs.some(log =>
    log.status === 'COMPLETED' && log.input_prompt && log.input_prompt.length > 0
  );

  const formatJsonContent = (content: string): string | null => {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return null;
    }
  };

  // user message 是 JSON.stringify(..., null, 2) 的输出，按前缀判断（与 details 一致），
  // 包进 json code block 让 SyntaxHighlighter 语法高亮并保留缩进
  const isJson = currentMessage
    ? (() => {
        const trimmed = currentMessage.content.trim();
        return trimmed.startsWith('{') || trimmed.startsWith('[');
      })()
    : false;
  const renderedContent = currentMessage
    ? (formatJsonContent(currentMessage.content) ?? currentMessage.content)
    : '';
  const markdownSource = currentMessage
    ? (isJson ? `\`\`\`json\n${renderedContent}\n\`\`\`` : renderedContent)
    : '';

  const handleCopy = useCallback(async () => {
    if (!currentMessage?.content) return;
    try {
      await navigator.clipboard.writeText(currentMessage.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [currentMessage]);

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-400">
        <Loader2 size={24} className="animate-spin" />
        <span className="text-sm">Loading prompts...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-red-500">
        <AlertCircle size={24} />
        <span className="text-sm">{error}</span>
      </div>
    );
  }

  if (!hasAnyData) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-400">
        <FileText size={32} strokeWidth={1.5} />
        <span className="text-sm">No successful runs yet</span>
        <span className="text-xs text-slate-400/80 max-w-sm text-center">
          Run an AI Test Gen pipeline to completion, then the actual prompts used for each agent will appear here.
        </span>
      </div>
    );
  }

  const activeAgentMeta = AGENTS.find(a => a.name === activeAgent)!;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white">
      {/* Header: Agent selector */}
      <div className="px-4 pt-3 pb-2 border-b border-slate-200 shrink-0 bg-white">
        <div className="flex items-center gap-2 overflow-x-auto">
          {AGENTS.map(agent => {
            const hasLog = logs.some(log => log.agent_name === agent.name && log.status === 'COMPLETED' && log.input_prompt?.length);
            return (
              <button
                key={agent.name}
                onClick={() => setActiveAgent(agent.name)}
                className={`shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                  activeAgent === agent.name
                    ? 'bg-blue-50 border-blue-200 text-blue-700 shadow-sm'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${hasLog ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                {agent.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Sub-bar: prompt tabs + run meta */}
      <div className="flex items-center justify-between px-4 border-b border-slate-200 bg-slate-50/60 shrink-0">
        <div className="flex">
          {PROMPT_TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActivePromptTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors border-b-2 ${
                  activePromptTab === tab.key
                    ? 'text-blue-600 border-blue-600'
                    : 'text-slate-500 border-transparent hover:text-slate-700'
                }`}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-400 shrink-0">
          {batch > 0 && <span className="px-1.5 py-0.5 bg-slate-100 rounded">Batch {batch}</span>}
          {runDate && (
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {runDate}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-4 space-y-4">
          {/* Header row: agent desc + char count + copy */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-400">{activeAgentMeta.desc}</div>
            </div>
            {currentMessage && (
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
              >
                {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>

          {/* Prompt content */}
          {currentMessage ? (
            <div className="rounded-lg border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-400">
                <span className="flex items-center gap-1.5 font-medium uppercase tracking-wide">
                  {activePromptTab === 'system' ? 'System Prompt' : 'User Prompt'}
                  {isJson && (
                    <span className="px-1 py-0.5 text-[10px] uppercase bg-blue-100 text-blue-700 rounded">JSON</span>
                  )}
                </span>
                <span>{renderedContent.length.toLocaleString()} chars</span>
              </div>
              <div className="px-4 py-3 text-[12.5px] leading-relaxed text-slate-700 bg-white markdown-body max-h-[calc(100vh-320px)] overflow-y-auto">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || '');
                      const codeStr = String(children).replace(/\n$/, '');
                      if (match) {
                        return (
                          <SyntaxHighlighter
                            style={vscDarkPlus}
                            language={match[1]}
                            PreTag="div"
                            customStyle={{ fontSize: '11px', borderRadius: '6px', margin: '6px 0', padding: '10px 12px' }}
                          >
                            {codeStr}
                          </SyntaxHighlighter>
                        );
                      }
                      return <code className="bg-slate-100 px-1 py-0.5 rounded text-[11px] font-mono text-slate-800 border border-slate-200/60" {...props}>{children}</code>;
                    },
                    pre({ children }) { return <div className="my-1.5">{children}</div>; },
                    p({ children }) { return <p className="mb-1.5 last:mb-0">{children}</p>; },
                    ul({ children }) { return <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>; },
                    ol({ children }) { return <ol className="list-decimal pl-4 mb-1.5 space-y-0.5">{children}</ol>; },
                    li({ children }) { return <li className="mb-0.5">{children}</li>; },
                    blockquote({ children }) { return <blockquote className="border-l-2 border-slate-300 pl-2 my-1 text-slate-500 italic">{children}</blockquote>; },
                    h1({ children }) { return <h1 className="text-[15px] font-bold mb-1.5 mt-2 text-slate-800">{children}</h1>; },
                    h2({ children }) { return <h2 className="text-[14px] font-bold mb-1.5 mt-2 text-slate-800">{children}</h2>; },
                    h3({ children }) { return <h3 className="text-[13px] font-semibold mb-1 mt-2 text-slate-800">{children}</h3>; },
                    table({ children }) { return <table className="w-full border-collapse text-[11px] my-1.5">{children}</table>; },
                    th({ children }) { return <th className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-medium text-slate-600">{children}</th>; },
                    td({ children }) { return <td className="border border-slate-200 px-2 py-1 text-slate-600">{children}</td>; },
                    a({ href, children }) { return <a href={href} className="text-blue-600 underline" target="_blank" rel="noreferrer">{children}</a>; },
                  }}
                >
                  {markdownSource}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-slate-400">
              <AlertCircle size={20} />
              <span className="text-xs">
                No {activePromptTab === 'system' ? 'system' : 'user'} prompt recorded for this agent in the latest run
              </span>
            </div>
          )}

          {/* Available Tools */}
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <button
              onClick={() => setShowTools(!showTools)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Wrench size={13} />
                Available Tools
                <span className="ml-0.5 px-1.5 py-0.5 text-[10px] bg-slate-100 rounded-full text-slate-500">{tools.length}</span>
              </span>
              {showTools ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {showTools && (
              <div className="px-3 pb-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-2">
                {tools.map(tool => (
                  <span key={tool} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-slate-50 text-slate-600 border border-slate-200">
                    {tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
