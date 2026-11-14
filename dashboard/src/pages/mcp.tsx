import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck, Workflow } from 'lucide-react';
import { api, ApiError, body, confirmedRequest } from '../lib/api';
import { Button, EmptyState, Loading, PageTitle, Panel, Pill, Table } from '../components/ui';

interface McpRule { pattern: string; minRole: string; }
interface McpServer { id: string; transport: string; initialized: boolean; toolCount: number; error?: string; }
interface McpTool { server: string; name: string; description?: string; inputSchema?: Record<string, unknown>; }
interface McpAuditEntry {
  id: string;
  at: string;
  tool: string;
  caller: string;
  outcome: string;
  detail: string;
  argsRedacted: string;
}
interface McpCallResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

function errorMessage(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : '未知错误';
}

function errorTone(message: string): 'warning' | 'danger' {
  return /未配置|未启用|unavailable/i.test(message) ? 'warning' : 'danger';
}

function renderResult(result: McpCallResult): string {
  const text = (result.content ?? []).map((part) => {
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    return JSON.stringify(part);
  }).join('\n');
  return text || JSON.stringify(result, null, 2);
}

export function Mcp({ permissions }: { permissions: string[] }) {
  const [rules, setRules] = useState<McpRule[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [entries, setEntries] = useState<McpAuditEntry[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [selectedServer, setSelectedServer] = useState('');
  const [selectedTool, setSelectedTool] = useState('');
  const [argumentsText, setArgumentsText] = useState('{}');
  const [callError, setCallError] = useState('');
  const [callResult, setCallResult] = useState<McpCallResult | null>(null);
  const [calling, setCalling] = useState(false);

  const canCall = permissions.includes('mcp.call');
  const availableTools = useMemo(
    () => tools.filter((tool) => tool.server === selectedServer),
    [tools, selectedServer],
  );
  const selected = availableTools.find((tool) => tool.name === selectedTool);

  const load = useCallback(async () => {
    setLoading(true);
    setErrors({});
    const [policyResult, toolsResult, auditResult] = await Promise.allSettled([
      api<{ rules?: McpRule[] }>('/mcp/policy'),
      api<{ servers?: McpServer[]; tools?: McpTool[] }>('/mcp/tools'),
      api<{ entries?: McpAuditEntry[] }>('/mcp/audit'),
    ]);

    if (policyResult.status === 'fulfilled') {
      setRules(Array.isArray(policyResult.value.rules) ? policyResult.value.rules : []);
    } else {
      setErrors((current) => ({ ...current, policy: errorMessage(policyResult.reason) }));
    }
    if (toolsResult.status === 'fulfilled') {
      const nextServers = Array.isArray(toolsResult.value.servers) ? toolsResult.value.servers : [];
      const nextTools = Array.isArray(toolsResult.value.tools) ? toolsResult.value.tools : [];
      setServers(nextServers);
      setTools(nextTools);
      const readyServerId = nextServers.find((server) => server.initialized)?.id ?? '';
      const serverTools = nextTools.filter((tool) => tool.server === readyServerId);
      setSelectedServer(readyServerId);
      setSelectedTool(serverTools[0]?.name ?? '');
    } else {
      setErrors((current) => ({ ...current, tools: errorMessage(toolsResult.reason) }));
      setServers([]);
      setTools([]);
      setSelectedServer('');
      setSelectedTool('');
    }
    if (auditResult.status === 'fulfilled') {
      setEntries(Array.isArray(auditResult.value.entries) ? auditResult.value.entries : []);
    } else {
      setErrors((current) => ({ ...current, audit: errorMessage(auditResult.reason) }));
      setEntries([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function onServerChange(server: string) {
    setSelectedServer(server);
    setSelectedTool(tools.find((tool) => tool.server === server)?.name ?? '');
    setCallResult(null);
  }

  async function submitCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCallError('');
    setCallResult(null);
    if (!selectedServer || !selectedTool) {
      setCallError('请先选择已就绪服务器和工具。');
      return;
    }

    let args: unknown;
    try {
      args = JSON.parse(argumentsText || '{}');
    } catch {
      setCallError('参数必须是有效 JSON。');
      return;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      setCallError('参数必须是 JSON 对象。');
      return;
    }

    const payload = { server: selectedServer, tool: selectedTool, arguments: args as Record<string, unknown> };
    setCalling(true);
    try {
      const response = await confirmedRequest<{ result?: McpCallResult }>(
        '/mcp/call',
        { method: 'POST', body: body(payload) },
        payload,
        `调用 MCP 工具 ${selectedServer}/${selectedTool}`,
      );
      const result = response.result ?? response as McpCallResult;
      setCallResult(result);
      await load();
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.statusCode !== 0) setCallError(errorMessage(cause));
    } finally {
      setCalling(false);
    }
  }

  return (
    <>
      <PageTitle
        eyebrow="MODEL CONTEXT PROTOCOL"
        title="MCP 工具"
        description="查看工具权限策略、Server 连接状态和脱敏调用审计。模型侧调用仍固定使用 viewer 最小权限。"
        actions={<Button onClick={load}><RefreshCw size={15} /> 刷新</Button>}
      />
      {loading ? <Loading /> : (
        <>
          <div className="notice-line"><ShieldCheck size={17} /><span>手动调用仍受 MCP 工具策略、当前管理员权限和服务端审计约束；工具参数不会绕过服务端校验。</span></div>
          {Object.entries(errors).map(([kind, message]) => (
            <div className={`notice-line notice-${errorTone(message)}`} key={kind}>
              <Workflow size={16} /><span>{kind === 'policy' ? '策略' : kind === 'tools' ? 'Server/工具清单' : '调用审计'}：{message}</span>
            </div>
          ))}
          <Panel title="工具权限策略" description={`${rules.length} 条默认策略规则`}>
            {rules.length === 0 ? <EmptyState title="没有可显示的策略" detail="未获取到 MCP 权限规则。" /> : (
              <Table>
                <thead><tr><th>工具匹配模式</th><th>最低角色</th></tr></thead>
                <tbody>{rules.map((rule, index) => <tr key={`${rule.pattern}:${index}`}><td><code>{rule.pattern}</code></td><td>{rule.minRole}</td></tr>)}</tbody>
              </Table>
            )}
          </Panel>
          <Panel title="MCP Server" description={`${servers.length} 个已配置 Server`}>
            {servers.length === 0 ? <EmptyState title="没有已配置的 MCP Server" detail="在配置文件中启用 mcp 并添加 server 后，这里会显示连接状态。" /> : (
              <Table>
                <thead><tr><th>Server</th><th>传输方式</th><th>初始化</th><th>工具数</th><th>错误</th></tr></thead>
                <tbody>{servers.map((server) => <tr key={server.id}>
                  <td className="table-primary">{server.id}</td><td>{server.transport}</td>
                  <td><Pill tone={server.initialized ? 'success' : 'warning'}>{server.initialized ? '已就绪' : '未就绪'}</Pill></td>
                  <td>{server.toolCount}</td><td>{server.error || '—'}</td>
                </tr>)}</tbody>
              </Table>
            )}
          </Panel>
          <Panel title="可用工具" description={`${tools.length} 个工具`}>
            {tools.length === 0 ? <EmptyState title="暂时没有可调用工具" detail="Server 未就绪、MCP 未启用或尚未发布工具。" /> : (
              <Table>
                <thead><tr><th>Server</th><th>工具</th><th>说明</th><th>参数 Schema</th></tr></thead>
                <tbody>{tools.map((tool) => (
                  <tr key={`${tool.server}:${tool.name}`}>
                    <td>{tool.server}</td><td className="table-primary">{tool.name}</td><td>{tool.description || '—'}</td>
                    <td><code>{Object.keys(tool.inputSchema?.properties as object ?? {}).length} 个字段</code></td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Panel>
          {canCall && (
            <Panel title="受控调用" description="选择一个已发布工具，提供 JSON 对象参数。危险操作需要在弹窗中再次确认。">
              <form className="mcp-call-form" onSubmit={(event) => void submitCall(event)}>
                <div className="form-grid">
                  <label>Server
                    <select value={selectedServer} onChange={(event) => onServerChange(event.target.value)} required>
                      <option value="">选择 MCP Server</option>
                      {servers.filter((server) => server.initialized).map((server) => <option key={server.id} value={server.id}>{server.id}</option>)}
                    </select>
                  </label>
                  <label>工具
                    <select value={selectedTool} onChange={(event) => { setSelectedTool(event.target.value); setCallResult(null); }} required>
                      <option value="">选择工具</option>
                      {availableTools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
                    </select>
                  </label>
                </div>
                {selected?.inputSchema && <details className="schema-details"><summary>查看工具参数 Schema</summary><pre className="json-view">{JSON.stringify(selected.inputSchema, null, 2)}</pre></details>}
                <label>参数（JSON 对象）
                  <textarea value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} rows={6} spellCheck={false} />
                </label>
                {callError && <div className="inline-error">{callError}</div>}
                <Button type="submit" variant="danger" busy={calling} disabled={!selected || calling}>调用工具并记录审计</Button>
              </form>
              {callResult && <div className="mcp-result"><div className="panel-heading"><h2>工具执行结果</h2><Pill tone={callResult.isError ? 'danger' : 'success'}>{callResult.isError ? '工具返回错误' : '已执行'}</Pill></div><pre className="json-view">{renderResult(callResult)}</pre></div>}
            </Panel>
          )}
          <Panel title="最近调用审计" description="参数在服务端写入审计前会做脱敏和长度限制。">
            {entries.length === 0 ? <EmptyState title="暂无 MCP 调用记录" detail="后续调用会以时间倒序显示在这里。" /> : (
              <Table>
                <thead><tr><th>时间</th><th>工具</th><th>调用者</th><th>结果</th><th>参数（脱敏）</th><th>详情</th></tr></thead>
                <tbody>{entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="nowrap">{new Date(entry.at).toLocaleString()}</td><td className="table-primary">{entry.tool}</td><td>{entry.caller}</td>
                    <td><Pill tone={entry.outcome === 'allowed' ? 'success' : entry.outcome === 'denied' ? 'warning' : 'danger'}>{entry.outcome}</Pill></td>
                    <td><code>{entry.argsRedacted || '—'}</code></td><td>{entry.detail || '—'}</td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
