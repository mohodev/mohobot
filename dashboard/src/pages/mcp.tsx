import { useMemo, useState, type FormEvent } from 'react';
import {
  ListChecks,
  RefreshCw,
  ScrollText,
  Server as ServerIcon,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { api, ApiError, body, confirmedRequest, hasPermission } from '../lib/api';
import type { McpAuditEntry, McpCallResult, McpRule, McpServer, McpTool, PageProps } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatDateTime, formatNumber, parseJsonObject, prettyJson } from '../lib/format';
import {
  Button,
  Collapsible,
  CopyButton,
  DataState,
  EmptyState,
  ErrorState,
  Field,
  Notice,
  PageTitle,
  Panel,
  Pill,
  Select,
  StatCard,
  Table,
  TextArea,
} from '../components/ui';

/**
 * MCP 工具（MODEL CONTEXT PROTOCOL）。
 *
 * 一次加载三个只读端点，任一失败都不阻塞其余分区：
 *  - GET /api/mcp/policy  默认权限策略（静态，始终可用）
 *  - GET /api/mcp/tools   Server 连接状态 + 已发布工具
 *  - GET /api/mcp/audit   脱敏调用审计
 *
 * MCP 默认关闭：未启用时 /tools 与 /audit 返回 HTTP 409 `mcp unavailable`。
 * 这里把它识别为「未启用」状态而不是错误崩溃，也不会退化成误导性的
 * 「没有已配置的 Server」空态。
 *
 * 唯一写操作是受控调用 POST /api/mcp/call（risk=impact，服务端 nonce 确认），
 * 必须走 confirmedRequest。
 */

interface McpData {
  rules: McpRule[];
  servers: McpServer[];
  tools: McpTool[];
  entries: McpAuditEntry[];
  /** 服务端报告 MCP 未启用（HTTP 409）：Server/工具/审计整体不可用。 */
  disabled: boolean;
  /** 仅审计端点报告未启用（防御性：正常同为单一特性开关，会与 disabled 一致）。 */
  auditDisabled: boolean;
  /** 分区级失败信息；一个 GET 失败不会阻塞其他面板。 */
  errors: { policy?: string; tools?: string; audit?: string };
}

function errorMessage(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : '未知错误';
}

/** MCP 是单一特性开关：关闭时 /tools、/audit 一致返回 409 `mcp unavailable`。 */
function isMcpUnavailable(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return false;
  return cause.statusCode === 409 || /unavailable|未启用|未配置/i.test(cause.message);
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

  // MCP 未启用时 /tools 与 /audit 一起 409。折叠成单一的「未启用」状态，
  // 避免一堆错误横幅旁边还显示「没有已配置的 Server」这种自相矛盾的空态。
  const disabled = toolsResult.status === 'rejected' && isMcpUnavailable(toolsResult.reason);
  const auditDisabled = auditResult.status === 'rejected' && isMcpUnavailable(auditResult.reason);
  if (disabled || auditDisabled) {
    if (disabled) delete errors.tools;
    delete errors.audit;
  }

  return { rules, servers, tools, entries, disabled, auditDisabled, errors };
}

export function Mcp({ permissions }: PageProps) {
  const state = useAsync(loadMcp, [], '读取 MCP 信息失败');
  const data = state.data;

  const rules = data?.rules ?? [];
  const servers = data?.servers ?? [];
  const tools = data?.tools ?? [];
  const entries = data?.entries ?? [];
  const errors = data?.errors ?? {};
  const disabled = data?.disabled ?? false;
  const auditDisabled = data?.auditDisabled ?? false;

  const canCall = hasPermission(permissions, 'mcp.call');

  const initializedServers = useMemo(() => servers.filter((server) => server.initialized), [servers]);
  const serversReady = servers.length > 0 && initializedServers.length === servers.length;

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

  /* ---- 派生视图：工具按 Server 过滤，审计与策略各自成表 ---- */
  const auditStats = useMemo(() => {
    let denied = 0;
    let errored = 0;
    for (const entry of entries) {
      const outcome = entry.outcome.toLowerCase();
      if (outcome === 'denied') denied += 1;
      else if (outcome === 'error') errored += 1;
    }
    return { denied, errored };
  }, [entries]);

  const toolServers = useMemo(() => Array.from(new Set(tools.map((tool) => tool.server))).sort(), [tools]);
  const [toolServerFilter, setToolServerFilter] = useState('');
  const activeToolFilter = toolServers.includes(toolServerFilter) ? toolServerFilter : '';
  const visibleTools = useMemo(
    () => (activeToolFilter ? tools.filter((tool) => tool.server === activeToolFilter) : tools),
    [tools, activeToolFilter],
  );

  const hasContent = servers.length > 0 || tools.length > 0 || rules.length > 0 || entries.length > 0;

  /* ---- 策略面板：默认权限策略（独立于 MCP 是否启用） ---- */
  const policyPanel = (
    <Panel
      title="工具权限策略"
      description={`${formatNumber(rules.length)} 条默认规则；未匹配任何规则的调用默认拒绝，模型侧调用固定使用 viewer 角色。`}
      action={<Pill tone="neutral">未匹配默认拒绝</Pill>}
      flush
    >
      <DataState
        error={errors.policy ? `策略：${errors.policy}` : undefined}
        onRetry={state.reload}
        empty={!errors.policy && rules.length === 0}
        emptyTitle="没有可显示的策略"
        emptyDetail="未获取到 MCP 权限规则。"
      >
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
  );

  return (
    <>
      <PageTitle
        eyebrow="MODEL CONTEXT PROTOCOL"
        title="MCP 工具"
        description="查看工具权限策略、Server 连接状态、已发布工具与脱敏调用审计；受控调用固定使用 viewer 最小权限并记录审计。"
        actions={<Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Notice tone="info" icon={<ShieldCheck size={17} />}>
        模型发起的 MCP 调用固定使用低权限 <code>viewer</code> 角色，并必须通过
        MCP 权限策略、审计与服务端校验；工具参数无法绕过服务端策略。
      </Notice>

      <DataState loading={state.loading && !data} error={state.error} onRetry={state.reload}>
        {disabled && (
          <Notice tone="warning" icon={<TriangleAlert size={17} />}>
            当前部署未启用 MCP（服务端返回 409 <code className="mono">mcp unavailable</code>）。
            Server 状态、工具清单与调用审计均不可用；在配置中启用 mcp 后会自动刷新。
          </Notice>
        )}

        {!disabled && hasContent && (
          <div className="stat-grid">
            <StatCard
              label="MCP Server"
              value={`${formatNumber(initializedServers.length)} / ${formatNumber(servers.length)}`}
              note={servers.length === 0
                ? '未配置 Server'
                : serversReady ? '全部已就绪' : `${formatNumber(servers.length - initializedServers.length)} 个未就绪`}
              icon={<ServerIcon size={17} />}
              tone={servers.length === 0 ? undefined : serversReady ? 'success' : 'warning'}
            />
            <StatCard
              label="可用工具"
              value={formatNumber(tools.length)}
              note={toolServers.length > 0 ? `来自 ${formatNumber(toolServers.length)} 个 Server` : '尚未发布工具'}
              icon={<Wrench size={17} />}
            />
            <StatCard
              label="权限规则"
              value={formatNumber(rules.length)}
              note="未匹配任何规则的调用默认拒绝"
              icon={<ListChecks size={17} />}
            />
            <StatCard
              label="调用审计"
              value={formatNumber(entries.length)}
              note={`${formatNumber(auditStats.denied)} 拒绝 · ${formatNumber(auditStats.errored)} 错误`}
              icon={<ScrollText size={17} />}
              tone={auditStats.denied + auditStats.errored > 0 ? 'warning' : undefined}
            />
          </div>
        )}

        {disabled ? (
          <Panel
            title="MCP Server 与工具"
            description="MCP 处于关闭状态，没有可读取的 Server、工具或调用审计。"
          >
            <EmptyState
              title="MCP 未启用"
              detail="在配置中启用 mcp 并添加至少一个 server 后，这里会显示连接状态、已发布工具与受控调用入口。"
            />
          </Panel>
        ) : errors.tools ? (
          <Panel title="MCP Server 与工具" description="同一请求同时返回 Server 连接状态与已发布工具。">
            <ErrorState message={`Server/工具清单：${errors.tools}`} retry={state.reload} />
          </Panel>
        ) : (
          <>
            <Panel
              title="MCP Server"
              description={`${formatNumber(servers.length)} 个已配置 Server，其中 ${formatNumber(initializedServers.length)} 个已就绪。`}
              action={servers.length > 0
                ? <Pill tone={serversReady ? 'success' : 'warning'}>{initializedServers.length}/{servers.length} 已就绪</Pill>
                : undefined}
              flush
            >
              <DataState
                empty={servers.length === 0}
                emptyTitle="没有已配置的 MCP Server"
                emptyDetail="在配置中启用 mcp 并添加 server 后，这里会显示连接状态。"
              >
                <Table minWidth={720}>
                  <thead><tr><th>Server</th><th>传输方式</th><th>初始化</th><th>工具数</th><th>错误</th></tr></thead>
                  <tbody>
                    {servers.map((server) => (
                      <tr key={server.id}>
                        <td className="table-primary mono">{server.id}</td>
                        <td>{server.transport || '—'}</td>
                        <td><Pill tone={server.initialized ? 'success' : 'warning'}>{server.initialized ? '已就绪' : '未就绪'}</Pill></td>
                        <td>{formatNumber(server.toolCount)}</td>
                        <td className="truncate-cell">{server.error || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </DataState>
            </Panel>

            <Panel
              title="可用工具"
              description={`${formatNumber(tools.length)} 个已发布工具${toolServers.length > 0 ? `，来自 ${formatNumber(toolServers.length)} 个 Server` : ''}。`}
            >
              <DataState
                empty={tools.length === 0}
                emptyTitle="暂时没有可调用工具"
                emptyDetail="Server 未就绪、MCP 未启用或尚未发布工具。"
              >
                {toolServers.length > 1 && (
                  <div className="filter-row">
                    <span className="muted-text">按 Server 过滤</span>
                    <Select
                      aria-label="按 Server 过滤工具"
                      value={activeToolFilter}
                      onChange={(event) => setToolServerFilter(event.target.value)}
                    >
                      <option value="">全部 Server</option>
                      {toolServers.map((server) => <option key={server} value={server}>{server}</option>)}
                    </Select>
                  </div>
                )}
                {visibleTools.length === 0 ? (
                  <EmptyState title="没有匹配的工具" detail="当前 Server 筛选下没有已发布工具。" />
                ) : (
                  <Table minWidth={760}>
                    <thead><tr><th>Server</th><th>工具</th><th>说明</th><th>参数 Schema</th></tr></thead>
                    <tbody>
                      {visibleTools.map((tool) => (
                        <tr key={`${tool.server}:${tool.name}`}>
                          <td className="mono">{tool.server}</td>
                          <td className="table-primary mono">{tool.name}</td>
                          <td className="truncate-cell" title={tool.description ?? ''}>{tool.description || '—'}</td>
                          <td className="nowrap">{schemaFieldCount(tool.inputSchema)} 个字段</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </DataState>
            </Panel>

            <Panel
              title="受控调用"
              description={`选择一个已就绪 Server 的已发布工具，提供 JSON 对象参数；提交需在弹窗中再次确认。${selectedTool ? ` 当前：${selectedTool.server}/${selectedTool.name}` : ''}`}
              action={<Pill tone={canCall ? 'info' : 'neutral'}>{canCall ? 'viewer 最小权限' : '只读'}</Pill>}
            >
              {canCall ? (
                initializedServers.length === 0 ? (
                  <EmptyState
                    title="没有可调用的工具"
                    detail="需要至少一个已就绪的 Server，且该 Server 已发布工具后才能发起受控调用。"
                  />
                ) : (
                  <>
                    <form className="mcp-call-form" onSubmit={(event) => void submitCall(event)}>
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
                          <Wrench size={14} /> 调用工具并记录审计
                        </Button>
                      </div>
                    </form>

                    {callResult && (
                      <div className="mcp-result">
                        <div className="row-between">
                          <strong>工具执行结果</strong>
                          <div className="row gap-sm">
                            <CopyButton value={renderResult(callResult)} label="复制结果" />
                            <Pill tone={callResult.isError ? 'danger' : 'success'}>{callResult.isError ? '工具返回错误' : '已执行'}</Pill>
                          </div>
                        </div>
                        <pre className="json-view">{renderResult(callResult)}</pre>
                      </div>
                    )}
                  </>
                )
              ) : (
                <p className="muted-text">
                  只读：当前账号缺少 <code className="mono">mcp.call</code> 权限，无法发起受控调用。
                </p>
              )}
            </Panel>
          </>
        )}

        {!disabled && (
          <Panel
            title="最近调用审计"
            description={`${formatNumber(entries.length)} 条记录；参数在服务端写入审计前已脱敏并限制长度。`}
            action={entries.length > 0
              ? <Pill tone={auditStats.denied + auditStats.errored > 0 ? 'warning' : 'success'}>
                {formatNumber(auditStats.denied)} 拒绝 · {formatNumber(auditStats.errored)} 错误
              </Pill>
              : undefined}
            flush
          >
            <DataState
              error={errors.audit ? `调用审计：${errors.audit}` : undefined}
              onRetry={state.reload}
              empty={!errors.audit && entries.length === 0}
              emptyTitle={auditDisabled ? 'MCP 未启用' : '暂无 MCP 调用记录'}
              emptyDetail={auditDisabled
                ? '审计端点因 MCP 未启用而不可用；启用 mcp 后此处会显示脱敏调用记录。'
                : '后续调用会以时间倒序显示在这里。'}
            >
              <Table minWidth={880}>
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
        )}

        {policyPanel}
      </DataState>
    </>
  );
}
