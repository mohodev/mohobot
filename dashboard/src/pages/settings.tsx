import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CloudUpload, RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';
import { ApiError, api, body, confirmedRequest } from '../lib/api';
import type { ActivationReceipt, ConfigPublication, PageProps } from '../lib/types';
import { useAsync, useDebouncedValue } from '../lib/hooks';
import { formatDateTime, formatNumber, formatRelative, parseJsonObject, prettyJson, truncateMiddle } from '../lib/format';
import {
  Button,
  Collapsible,
  CopyButton,
  DataState,
  Descriptions,
  Field,
  Notice,
  PageTitle,
  Panel,
  Pill,
  StatCard,
  Table,
  Tabs,
  TextArea,
  TextInput,
} from '../components/ui';

/* ------------------------------------------------------------------ *
 * Response shapes (server truth: src/admin/api-routes/config-users.ts *
 * and src/config/publication-*.ts)                                    *
 *   GET  /api/config/publication           -> { publication: {...}|null }
 *   POST /api/config/publish               -> { publication }
 *   POST /api/config/ack                   -> { publication }
 *   POST /api/config/rollback              -> { publication }
 *   GET  /api/config/activation-receipts   -> { receipts: { items, effective? } }
 *   POST /api/config/activation-receipt    -> { receipt: { receipt, snapshot } }
 * ------------------------------------------------------------------ */

interface PublicationResponse { publication?: ConfigPublication | null }
interface ReceiptsResponse { receipts?: unknown }

const PHASE_LABEL: Record<string, string> = { empty: '空', active: '已生效', pending: '等待确认' };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pick(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function phaseLabel(value: unknown): string {
  const key = String(value ?? '');
  return PHASE_LABEL[key] ?? (key || '未知');
}

function phaseTone(value: unknown): 'success' | 'warning' | 'neutral' {
  const key = String(value ?? '');
  if (key === 'active') return 'success';
  if (key === 'pending') return 'warning';
  return 'neutral';
}

function recordsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((item) => item !== null && typeof item === 'object') as Array<Record<string, unknown>>) : [];
}

function receiptItemsOf(value: unknown): ActivationReceipt[] {
  if (Array.isArray(value)) return value as ActivationReceipt[];
  const items = asRecord(value)?.items;
  return Array.isArray(items) ? (items as ActivationReceipt[]) : [];
}

/* ------------------------------------------------------------------ *
 * Command console                                                        *
 *                                                                        *
 * Every mutating action is a "parse JSON body -> confirm -> POST" flow,  *
 * so they are described once and rendered from the same table-driven     *
 * layout instead of four near-identical panels.                          *
 * ------------------------------------------------------------------ */

type CommandKey = 'publish' | 'ack' | 'rollback';

interface CommandSpec {
  key: CommandKey;
  tab: string;
  title: string;
  summary: string;
  fieldLabel: string;
  hint: string;
  placeholder: string;
  action: string;
  variant: 'primary' | 'secondary' | 'danger';
  icon: ReactNode;
}

const COMMANDS: CommandSpec[] = [
  {
    key: 'publish',
    tab: '发布修订',
    title: '发布新修订',
    summary: '提交一个新的配置修订。请求体需包含 expectedRevision 与 payload；未带 rollout 时立即生效。',
    fieldLabel: '变更载荷 (JSON)',
    hint: 'POST /api/config/publish 的请求体。expectedRevision 必须等于服务端当前 desiredRevision，否则返回冲突。',
    placeholder: '{\n  "expectedRevision": 0,\n  "payload": { "feature": { "enabled": true } }\n}',
    action: '发布配置',
    variant: 'primary',
    icon: <CloudUpload size={15} />,
  },
  {
    key: 'ack',
    tab: '节点确认',
    title: '节点确认 (ACK)',
    summary: '为等待确认的修订提交 ACK/NACK。达到 rollout 目标（quorum 或全部 targetNodes）后该修订才生效。',
    fieldLabel: 'ACK 载荷 (JSON)',
    hint: 'POST /api/config/ack 的请求体，需包含 revision、nodeId、digest、outcome（ack 或 nack）。',
    placeholder: '{\n  "revision": 1,\n  "nodeId": "node-1",\n  "digest": "<sha256>",\n  "outcome": "ack"\n}',
    action: '确认节点',
    variant: 'secondary',
    icon: null,
  },
  {
    key: 'rollback',
    tab: '回滚修订',
    title: '回滚修订',
    summary: '把当前生效修订替换为上一生效修订（或请求体中的 toRevision）。立即生效且不可撤销。',
    fieldLabel: '回滚载荷 (JSON)',
    hint: 'POST /api/config/rollback 的请求体，需包含 expectedStateVersion；可选 toRevision 与 reason。',
    placeholder: '{\n  "expectedStateVersion": 0\n}',
    action: '回滚配置',
    variant: 'danger',
    icon: <RotateCcw size={15} />,
  },
];

export function Settings({ permissions }: PageProps) {
  const canPublish = permissions.includes('config.publish');

  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionOk, setActionOk] = useState('');
  const [lastResult, setLastResult] = useState<unknown>(undefined);

  const [commandText, setCommandText] = useState<Record<CommandKey, string>>({ publish: '', ack: '', rollback: '' });
  const [commandTab, setCommandTab] = useState<CommandKey>('publish');
  const [ledgerTab, setLedgerTab] = useState<'history' | 'transitions'>('history');
  const [receiptText, setReceiptText] = useState('');
  const [scope, setScope] = useState('');
  const debouncedScope = useDebouncedValue(scope, 300);

  const publicationState = useAsync<PublicationResponse>(
    () => api<PublicationResponse>('/config/publication'),
    [],
    '读取配置发布状态失败',
  );
  const receiptsState = useAsync<ReceiptsResponse>(
    () => api<ReceiptsResponse>(`/config/activation-receipts${debouncedScope ? `?scope=${encodeURIComponent(debouncedScope)}` : ''}`),
    [debouncedScope],
    '读取激活回执失败',
  );

  const { reload: reloadPublication } = publicationState;
  const { reload: reloadReceipts } = receiptsState;

  const publication = publicationState.data?.publication ?? null;
  const snapshot = asRecord(publication?.snapshot);
  const pubState = asRecord(snapshot?.state);
  const active = asRecord(snapshot?.active);
  const effective = asRecord(publication?.effective);

  const revision = pick(publication?.revision, pubState?.activeRevision, active?.revision);
  const phase = pick(publication?.status, pubState?.phase);
  const publishedBy = pick(publication?.publishedBy, active?.publishedBy);
  const publishedAt = pick(publication?.publishedAt, active?.publishedAt);
  const pubScope = pick(pubState?.scope, active?.scope, publication?.scope);
  const activeDigest = active?.digest ?? pick(publication?.digest);
  const desiredRevision = pubState?.desiredRevision;
  const pendingRevision = pubState?.pendingRevision;
  const previousRevision = pubState?.previousActiveRevision;
  const deadlineAt = pubState?.deadlineAt;
  const ackCount = Array.isArray(snapshot?.acknowledgements) ? snapshot.acknowledgements.length : 0;
  const isEffective = typeof effective?.effective === 'boolean' ? effective.effective : undefined;
  const history = recordsOf(publication?.history);
  const transitions = recordsOf(publication?.transitions);

  const receiptsRaw = receiptsState.data?.receipts;
  const receiptItems = receiptItemsOf(receiptsRaw);
  const receiptsEffective = asRecord(asRecord(receiptsRaw)?.effective);
  const receiptsEffectiveFlag = typeof receiptsEffective?.effective === 'boolean' ? receiptsEffective.effective : undefined;

  const activeCommand = COMMANDS.find((command) => command.key === commandTab) ?? COMMANDS[0]!;
  const activeCommandText = commandText[activeCommand.key];
  const activeCommandParsed = useMemo(() => parseJsonObject(activeCommandText), [activeCommandText]);
  const receiptParsed = useMemo(() => parseJsonObject(receiptText), [receiptText]);

  const runConfirmed = useCallback(
    async (kind: string, path: string, parsed: { ok: true; value: Record<string, unknown> } | { ok: false; error: string }, description: string) => {
      if (!parsed.ok) {
        setActionError(parsed.error);
        setActionOk('');
        return;
      }
      setBusy(kind);
      setActionError('');
      setActionOk('');
      try {
        const result = await confirmedRequest<Record<string, unknown>>(
          path,
          { method: 'POST', body: body(parsed.value) },
          parsed.value,
          description,
        );
        setLastResult(result);
        // publish/ack/rollback return a mutation envelope; the receipt endpoint
        // nests the record under `receipt`, so both shapes are probed.
        const returned = asRecord(result.publication) ?? asRecord(result.receipt);
        const returnedRevision = pick(
          returned?.revision,
          asRecord(returned?.receipt)?.revision,
          asRecord(asRecord(returned?.snapshot)?.state)?.activeRevision,
        );
        setActionOk(`${description}：服务端已处理${returnedRevision === undefined ? '' : `，修订 ${String(returnedRevision)}`}。`);
        reloadPublication();
        if (kind === 'receipt') reloadReceipts();
      } catch (cause) {
        // A cancelled confirmation prompt reports statusCode 0 — stay quiet.
        if (cause instanceof ApiError && cause.statusCode === 0) return;
        setActionError(cause instanceof Error ? cause.message : '操作失败');
      } finally {
        setBusy('');
      }
    },
    [reloadPublication, reloadReceipts],
  );

  const scopeLabel = String(pubScope ?? 'global');
  const feedback = actionError || actionOk;

  return (
    <>
      <PageTitle
        eyebrow="CONFIG PUBLICATION"
        title="配置发布"
        description="发布配置修订、跟踪发布状态机、核对运行时激活回执，并在需要时回滚。"
        actions={<Button onClick={reloadPublication} busy={publicationState.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Notice tone="danger" icon={<ShieldAlert size={17} />}>
        发布与回滚属于危险操作：服务端要求二次确认（输入“确认”口令）后才会执行，且全部变更都会写入审计日志，无法撤销。
      </Notice>

      {feedback && <Notice tone={actionError ? 'danger' : 'info'}>{feedback}</Notice>}
      {!canPublish && (
        <Notice tone="warning">只读：当前账号缺少 config.publish 权限，无法发布、确认或回滚配置。</Notice>
      )}

      <DataState
        loading={publicationState.loading && !publicationState.data}
        error={publicationState.error}
        empty={!publicationState.loading && !publicationState.error && !publication}
        emptyTitle="尚无发布记录"
        emptyDetail="服务端还没有该作用域的配置发布状态，可在下方发布操作台提交首个修订。"
        onRetry={reloadPublication}
      >
        <div className="stat-grid">
          <StatCard label="当前修订" value={revision === undefined ? '—' : formatNumber(revision)} note="当前生效的修订号" />
          <StatCard
            label="发布阶段"
            value={<Pill tone={phaseTone(phase)}>{phaseLabel(phase)}</Pill>}
            note={`作用域 ${scopeLabel}`}
          />
          <StatCard
            label="实际生效"
            value={isEffective === undefined ? '未知' : isEffective ? '已生效' : '未生效'}
            note="是否存在匹配的运行时激活回执"
            tone={isEffective === undefined ? undefined : isEffective ? 'success' : 'warning'}
          />
          <StatCard label="发布记录" value={formatNumber(history.length)} note="历史修订条数（最近优先）" />
        </div>

        <Panel title="发布状态" description="来自配置发布状态机的当前快照。">
          <Descriptions
            columns={2}
            items={[
              { label: '作用域', value: scopeLabel },
              { label: '发布阶段', value: <Pill tone={phaseTone(phase)}>{phaseLabel(phase)}</Pill> },
              { label: '当前生效修订', value: revision === undefined ? '—' : String(revision) },
              { label: '期望修订', value: desiredRevision === undefined ? '—' : String(desiredRevision) },
              { label: '待确认修订', value: pendingRevision === undefined ? '—' : String(pendingRevision) },
              { label: '上一生效修订', value: previousRevision === undefined ? '—' : String(previousRevision) },
              { label: '发布人', value: publishedBy === undefined ? '—' : String(publishedBy) },
              { label: '发布时间', value: publishedAt === undefined ? '—' : `${formatDateTime(publishedAt)}（${formatRelative(publishedAt)}）` },
              { label: '生效摘要', value: activeDigest === undefined ? '—' : <span className="mono">{truncateMiddle(activeDigest)}</span> },
              { label: '确认节点数', value: formatNumber(ackCount) },
              {
                label: '回滚截止',
                value: deadlineAt === undefined
                  ? '—'
                  : `${formatDateTime(deadlineAt)}（${formatRelative(deadlineAt)}）`,
              },
              { label: '实际生效', value: isEffective === undefined ? '未知' : isEffective ? '已生效' : '未生效' },
            ]}
          />
        </Panel>

        <Panel
          title="发布台账"
          description="修订历史与状态机迁移，最近优先。"
        >
          <Tabs
            value={ledgerTab}
            options={[
              { value: 'history', label: '发布历史', count: history.length },
              { value: 'transitions', label: '状态迁移', count: transitions.length },
            ]}
            onChange={setLedgerTab}
            ariaLabel="发布台账视图"
          />

          {ledgerTab === 'history' ? (
            <DataState empty={history.length === 0} emptyTitle="暂无发布历史" emptyDetail="还没有发布过配置修订。">
              <Table minWidth={640}>
                <thead><tr><th>修订</th><th>摘要</th><th>发布人</th><th>发布时间</th><th>来源修订</th></tr></thead>
                <tbody>
                  {history.map((record, index) => (
                    <tr key={`${String(record.revision ?? index)}`}>
                      <td className="table-primary">{record.revision === undefined ? '—' : String(record.revision)}</td>
                      <td className="mono truncate-cell">{record.digest === undefined ? '—' : truncateMiddle(record.digest)}</td>
                      <td>{record.publishedBy === undefined ? '—' : String(record.publishedBy)}</td>
                      <td className="nowrap">{formatDateTime(record.publishedAt)}</td>
                      <td>{record.sourceRevision === undefined ? '—' : String(record.sourceRevision)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </DataState>
          ) : (
            <DataState empty={transitions.length === 0} emptyTitle="暂无状态迁移" emptyDetail="发布状态机还没有产生迁移事件。">
              <Table minWidth={640}>
                <thead><tr><th>时间</th><th>类型</th><th>修订</th><th>操作者</th><th>详情</th></tr></thead>
                <tbody>
                  {transitions.map((record, index) => (
                    <tr key={`${String(record.id ?? index)}`}>
                      <td className="nowrap">{formatDateTime(record.at)}</td>
                      <td><Pill tone="info">{String(record.kind ?? '—')}</Pill></td>
                      <td>{record.revision === undefined ? '—' : String(record.revision)}</td>
                      <td>{record.actor === undefined ? '—' : String(record.actor)}</td>
                      <td className="truncate-cell">{record.detail === undefined ? '—' : String(record.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </DataState>
          )}
        </Panel>
      </DataState>

      {canPublish && (
        <Panel
          title="发布操作台"
          description="每次写操作都需要输入“确认”口令，并且会写入审计日志。"
        >
          <Tabs
            value={commandTab}
            options={COMMANDS.map((command) => ({ value: command.key, label: command.tab }))}
            onChange={setCommandTab}
            ariaLabel="配置发布操作"
          />
          <p className="muted-text mb-0">{activeCommand.summary}</p>
          <Field
            label={activeCommand.fieldLabel}
            hint={activeCommand.hint}
            error={activeCommandParsed.ok ? undefined : activeCommandParsed.error}
          >
            <TextArea
              rows={9}
              value={activeCommandText}
              onChange={(event) => setCommandText((current) => ({ ...current, [activeCommand.key]: event.target.value }))}
              placeholder={activeCommand.placeholder}
            />
          </Field>
          <div className="row row-between">
            <span className="muted-text">{activeCommandParsed.ok ? 'JSON 解析通过，提交前仍会要求二次确认。' : '修正 JSON 后才能提交。'}</span>
            <Button
              variant={activeCommand.variant}
              busy={busy === activeCommand.key}
              disabled={!activeCommandParsed.ok}
              onClick={() => { void runConfirmed(activeCommand.key, `/config/${activeCommand.key}`, activeCommandParsed, activeCommand.title); }}
            >
              {activeCommand.icon} {activeCommand.action}
            </Button>
          </div>
        </Panel>
      )}

      <Panel
        title="激活回执"
        description={`${receiptItems.length} 条回执记录，用于区分“已发布”与“实际生效”。`}
        action={
          <div className="row">
            <TextInput
              aria-label="作用域筛选"
              placeholder="作用域筛选，如 global"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            />
            <Button onClick={reloadReceipts} busy={receiptsState.loading}><RefreshCw size={15} /> 查询</Button>
          </div>
        }
      >
        {receiptsEffectiveFlag !== undefined && (
          <Notice tone={receiptsEffectiveFlag ? 'info' : 'warning'}>
            作用域 {String(receiptsEffective?.scope ?? scope)} 的当前修订{receiptsEffectiveFlag ? '已有匹配激活回执（实际生效）' : '尚无匹配激活回执（未确认生效）'}。
          </Notice>
        )}
        <DataState
          loading={receiptsState.loading && !receiptsState.data}
          error={receiptsState.error}
          empty={!receiptsState.loading && !receiptsState.error && receiptItems.length === 0}
          emptyTitle="暂无激活回执"
          emptyDetail={scope.trim() ? '该作用域还没有运行时上报的激活回执。' : '还没有任何运行时上报的激活回执。'}
          onRetry={reloadReceipts}
        >
          <Table minWidth={720}>
            <thead><tr><th>作用域</th><th>修订</th><th>摘要</th><th>激活人</th><th>激活时间</th><th>详情</th></tr></thead>
            <tbody>
              {receiptItems.map((receipt, index) => (
                <tr key={`${String(receipt.scope ?? '')}:${String(receipt.revision ?? index)}:${index}`}>
                  <td className="table-primary">{receipt.scope === undefined ? '—' : String(receipt.scope)}</td>
                  <td>{receipt.revision === undefined ? '—' : String(receipt.revision)}</td>
                  <td className="mono truncate-cell">{receipt.digest === undefined ? '—' : truncateMiddle(receipt.digest)}</td>
                  <td>{receipt.actor === undefined ? '—' : String(receipt.actor)}</td>
                  <td className="nowrap">{formatDateTime(receipt.activatedAt ?? receipt.acknowledgedAt)}</td>
                  <td className="truncate-cell">{receipt.detail === undefined ? '—' : String(receipt.detail)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </DataState>

        {canPublish && (
          <Collapsible title="记录激活回执" meta={<span className="muted-text">运行时已实际应用该修订</span>}>
            <Field
              label="回执载荷 (JSON)"
              hint="POST /api/config/activation-receipt 的请求体，可包含 scope 与 detail。"
              error={receiptParsed.ok ? undefined : receiptParsed.error}
            >
              <TextArea
                rows={5}
                value={receiptText}
                onChange={(event) => setReceiptText(event.target.value)}
                placeholder={'{\n  "scope": "global",\n  "detail": "runtime boot activation"\n}'}
              />
            </Field>
            <div className="row">
              <Button
                variant="secondary"
                busy={busy === 'receipt'}
                disabled={!receiptParsed.ok}
                onClick={() => { void runConfirmed('receipt', '/config/activation-receipt', receiptParsed, '记录激活回执'); }}
              >
                记录激活回执
              </Button>
            </div>
          </Collapsible>
        )}
      </Panel>

      {(publication || lastResult !== undefined) && (
        <Panel title="诊断数据" description="服务端原始响应，仅在排查问题时展开。">
          {publication && (
            <Collapsible title="发布对象 (JSON)" meta={<CopyButton value={prettyJson(publication)} />}>
              <pre className="json-view prewrap mono">{prettyJson(publication)}</pre>
            </Collapsible>
          )}
          {lastResult !== undefined && (
            <Collapsible title="最近一次操作结果 (JSON)" defaultOpen meta={<CopyButton value={prettyJson(lastResult)} />}>
              <pre className="json-view prewrap mono">{prettyJson(lastResult)}</pre>
            </Collapsible>
          )}
        </Panel>
      )}
    </>
  );
}
