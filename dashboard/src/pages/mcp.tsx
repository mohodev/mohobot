import { useMemo, useState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck, Workflow } from 'lucide-react';
import { api, ApiError, body, confirmedRequest } from '../lib/api';
import type { McpAuditEntry, McpCallResult, McpRule, McpServer, McpTool, PageProps } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatDateTime, parseJsonObject, prettyJson } from '../lib/format';
import {
  Button,
  Collapsible,
  DataState,
  Field,
  Notice,
  PageTitle,
  Panel,
  Pill,
  Select,
  Table,
  TextArea,
} from '../components/ui';

interface McpData {
  rules: McpRule[];
  servers: McpServer[];
  tools: McpTool[];
  entries: McpAuditEntry[];
  /** Per-section failure messages; a failed GET never blocks the other panels. */
  errors: { policy?: string; tools?: string; audit?: string };
}

function errorMessage(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : '未知错误';
}

/** Configuration gaps (MCP disabled) degrade to a warning, hard failures to danger. */
function errorTone(message: string): 'warning' | 'danger' {
  return /未配置|未启用|unavailable|409/i.test(message) ? 'warning' : 'danger';
}

function outcomeTone(outcome: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const value = outcome.toLowerCase();
  if (value === 'allowed') return 'success';
  if (value === 'denied') return 'warning';
  if (value === 'error') return 'danger';
  return 'neutral';
}

/** Number of named properties in a tool's JSON input schema. */
function schemaFieldCount(schema?: Record<string, unknown>): number {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return 0;
  return Object.keys(properties).length;
}

/** Flattens an MCP tool result into readable text, falling back to pretty JSON. */
function renderResult(result: McpCallResult): string {
  const text = (result.content ?? [])
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : prettyJson(part)))
    .join('\n');
  return text || prettyJson(result);
}

async function loadMcp(): Promise<McpData> {
  const [policyResult, toolsResult, auditResult] = await Promise.allSettled([
    api<{ rules?: McpRule[] }>('/mcp/policy'),
    api<{ servers?: McpServer[]; tools?: McpTool[] }>('/mcp/tools'),
    api<{ entries?: McpAuditEntry[] }>('/mcp/audit'),
  ]);

  const errors: McpData['errors'] = {};
  let rules: McpRule[] = [];
  if (policyResult.status === 'fulfilled') {
    rules = Array.isArray(policyResult.value.rules) ? policyResult.value.rules : [];
  } else {
    errors.policy = errorMessage(policyResult.reason);
  }

  let servers: McpServer[] = [];
  let tools: McpTool[] = [];
  if (toolsResult.status === 'fulfilled') {
    servers = Array.isArray(toolsResult.value.servers) ? toolsResult.value.servers : [];
    tools = Array.isArray(toolsResult.value.tools) ? toolsResult.value.tools : [];
  } else {
    errors.tools = errorMessage(toolsResult.reason);
  }

  let entries: McpAuditEntry[] = [];
  if (auditResult.status === 'fulfilled') {
    entries = Array.isArray(auditResult.value.entries) ? auditResult.value.entries : [];
  } else {
    errors.audit = errorMessage(auditResult.reason);
  }

  return { rules, servers, tools, entries, errors };
}

export function Mcp({ permissions }: PageProps) {
  const state = useAsync(loadMcp, [], '读取 MCP 信息失败');
  const data = state.data;

  const rules = data?.rules ?? [];
  const servers = data?.servers ?? [];
  const tools = data?.tools ?? [];
  const entries = data?.entries ?? [];
  const errors = data?.errors ?? {};

  const canCall = permissions.includes('mcp.call');

  const initializedServers = useMemo(() => servers.filter((server) => server.initialized), [servers]);

  // The form keeps the user's raw choice; the *effective* value falls back to the
  // first available option whenever the current choice disappears after a reload.
  const [serverChoice, setServerChoice] = useState('');
  const [toolChoice, setToolChoice] = useState('');
  const [argumentsText, setArgumentsText] = useState('{}');
  const [callError, setCallError] = useState('');
  const [callResult, setCallResult] = useState<McpCallResult | null>(null);
  const [calling, setCalling] = useState(false);

  const effectiveServer = initializedServers.some((server) => server.id === serverChoice)
    ? serverChoice
    : (initializedServers[0]?.id ?? '');
  const availableTools = useMemo(
    () => tools.filter((tool) => tool.server === effectiveServer),
    [tools, effectiveServer],
  );
  const effectiveTool = availableTools.some((tool) => tool.name === toolChoice)
    ? toolChoice
    : (availableTools[0]?.name ?? '');
  const selectedTool = availableTools.find((tool) => tool.name === effectiveTool);

  function onServerChange(server: string) {
    setServerChoice(server);
    setToolChoice('');
    setCallResult(null);
  }

  function onToolChange(tool: string) {
    setToolChoice(tool);
    setCallResult(null);
  }

  async function submitCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCallError('');
    setCallResult(null);

    if (!effectiveServer || !effectiveTool) {
      setCallError('请先选择已就绪的 MCP Server 和工具。');
      return;
    }
    const parsed = parseJsonObject(argumentsText);
    if (!parsed.ok) {
      setCallError(parsed.error);
      return;
    }

    const payload = { server: effectiveServer, tool: effectiveTool, arguments: parsed.value };
    setCalling(true);
    try {
      const response = await confirmedRequest<{ result?: McpCallResult }>(
        '/mcp/call',
        { method: 'POST', body: body(payload) },
        payload,
        `调用 MCP 工具 ${effectiveServer}/${effectiveTool}`,
      );
      setCallResult(response.result ?? (response as McpCallResult));
      state.reload();
    } catch (cause) {
      // statusCode 0 means the operator cancelled the confirmation prompt.
      if (!(cause instanceof ApiError) || cause.statusCode !== 0) setCallError(errorMessage(cause));
    } finally {
      setCalling(false);
    }
  }

  const sectionErrors: Array<[string, string]> = [];
  if (errors.policy) sectionErrors.push(['策略', errors.policy]);
  if (errors.tools) sectionErrors.push(['Server/工具清单', errors.tools]);
  if (errors.audit) sectionErrors.push(['调用审计', errors.audit]);

  return (
    <>
      <PageTitle
        eyebrow="MODEL CONTEXT PROTOCOL"
        title="MCP 工具"
        description="查看工具权限策略、Server 连接状态和脱敏调用审计；模型侧调用固定使用 viewer 最小权限。"
        actions={<Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Notice tone="info" icon={<ShieldCheck size={17} />}>
        模型发起的 MCP 调用固定使用低权限 <code>viewer</code> 角色，并必须通过
        MCP 权限策略、审计与服务端校验；工具参数无法绕过服务端策略。
      </Notice>

      {sectionErrors.map(([label, message]) => (
        <Notice key={label} tone={errorTone(message)} icon={<Workflow size={16} />}>
          {label}：{message}
        </Notice>
      ))}

      <DataState loading={state.loading && !data} error={state.error} onRetry={state.reload}>
        <Panel title="工具权限策略" description={`${rules.length} 条默认策略规则；未匹配任何规则的调用默认拒绝。`}>
          <DataState empty={rules.length === 0} emptyTitle="没有可显示的策略" emptyDetail="未获取到 MCP 权限规则。">
            <Table minWidth={480}>
              <thead><tr><th>工具匹配模式</th><th>最低角色</th></tr></thead>
              <tbody>
                {rules.map((rule, index) => (
                  <tr key={`${rule.pattern}:${index}`}>
                    <td><code className="mono">{rule.pattern}</code></td>
                    <td><Pill tone={rule.minRole === 'viewer' ? 'info' : 'neutral'}>{rule.minRole}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>

        <Panel title="MCP Server" description={`${servers.length} 个已配置 Server，其中 ${initializedServers.length} 个已就绪。`}>
          <DataState empty={servers.length === 0} emptyTitle="没有已配置的 MCP Server" emptyDetail="在配置中启用 mcp 并添加 server 后，这里会显示连接状态。">
            <Table minWidth={640}>
              <thead><tr><th>Server</th><th>传输方式</th><th>初始化</th><th>工具数</th><th>错误</th></tr></thead>
              <tbody>
                {servers.map((server) => (
                  <tr key={server.id}>
                    <td className="table-primary mono">{server.id}</td>
                    <td>{server.transport || '—'}</td>
                    <td><Pill tone={server.initialized ? 'success' : 'warning'}>{server.initialized ? '已就绪' : '未就绪'}</Pill></td>
                    <td>{server.toolCount}</td>
                    <td className="truncate-cell">{server.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>

        <Panel title="可用工具" description={`${tools.length} 个已发布工具。`}>
          <DataState empty={tools.length === 0} emptyTitle="暂时没有可调用工具" emptyDetail="Server 未就绪、MCP 未启用或尚未发布工具。">
            <Table minWidth={720}>
              <thead><tr><th>Server</th><th>工具</th><th>说明</th><th>参数 Schema</th></tr></thead>
              <tbody>
                {tools.map((tool) => (
                  <tr key={`${tool.server}:${tool.name}`}>
                    <td className="mono">{tool.server}</td>
                    <td className="table-primary mono">{tool.name}</td>
                    <td className="truncate-cell">{tool.description || '—'}</td>
                    <td className="nowrap">{schemaFieldCount(tool.inputSchema)} 个字段</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>

        <Panel title="受控调用" description="选择一个已就绪 Server 的已发布工具，提供 JSON 对象参数。危险操作需要在弹窗中再次确认。">
          {canCall ? (
            <>
              <form onSubmit={(event) => void submitCall(event)}>
                <div className="form-grid">
                  <Field label="Server" hint="仅列出已初始化的 Server">
                    <Select value={effectiveServer} onChange={(event) => onServerChange(event.target.value)} disabled={initializedServers.length === 0}>
                      {initializedServers.length === 0 && <option value="">没有已就绪的 Server</option>}
                      {initializedServers.map((server) => (
                        <option key={server.id} value={server.id}>{server.id}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="工具" hint="按所选 Server 过滤">
                    <Select value={effectiveTool} onChange={(event) => onToolChange(event.target.value)} disabled={availableTools.length === 0}>
                      {availableTools.length === 0 && <option value="">没有可用工具</option>}
                      {availableTools.map((tool) => (
                        <option key={tool.name} value={tool.name}>{tool.name}</option>
                      ))}
                    </Select>
                  </Field>
                </div>

                {selectedTool?.inputSchema && (
                  <Collapsible
                    title="工具参数 Schema"
                    meta={<span className="muted-text">{schemaFieldCount(selectedTool.inputSchema)} 个字段</span>}
                  >
                    <pre className="json-view">{prettyJson(selectedTool.inputSchema)}</pre>
                  </Collapsible>
                )}

                <Field label="参数（JSON 对象）" hint="留空按空对象 {} 调用">
                  <TextArea
                    value={argumentsText}
                    onChange={(event) => setArgumentsText(event.target.value)}
                    rows={6}
                    spellCheck={false}
                    placeholder='{ "q": "hello" }'
                  />
                </Field>

                {callError && <div className="inline-error">{callError}</div>}

                <div className="row mt-2">
                  <Button type="submit" variant="danger" busy={calling} disabled={!effectiveServer || !effectiveTool || calling}>
                    调用工具并记录审计
                  </Button>
                </div>
              </form>

              {callResult && (
                <div className="mt-2">
                  <div className="row-between">
                    <strong>工具执行结果</strong>
                    <Pill tone={callResult.isError ? 'danger' : 'success'}>{callResult.isError ? '工具返回错误' : '已执行'}</Pill>
                  </div>
                  <pre className="json-view">{renderResult(callResult)}</pre>
                </div>
              )}
            </>
          ) : (
            <p className="muted-text">只读：当前账号缺少 <code className="mono">mcp.call</code> 权限，无法发起受控调用。</p>
          )}
        </Panel>

        <Panel title="最近调用审计" description={`${entries.length} 条记录；参数在服务端写入审计前已脱敏并限制长度。`}>
          <DataState empty={entries.length === 0} emptyTitle="暂无 MCP 调用记录" emptyDetail="后续调用会以时间倒序显示在这里。">
            <Table minWidth={860}>
              <thead><tr><th>时间</th><th>工具</th><th>调用者</th><th>结果</th><th>参数（脱敏）</th><th>详情</th></tr></thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="nowrap">{formatDateTime(entry.at)}</td>
                    <td className="table-primary mono">{entry.tool}</td>
                    <td className="mono">{entry.caller}</td>
                    <td><Pill tone={outcomeTone(entry.outcome)}>{entry.outcome}</Pill></td>
                    <td className="truncate-cell"><code className="mono">{entry.argsRedacted || '—'}</code></td>
                    <td className="truncate-cell">{entry.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>
      </DataState>
    </>
  );
}
