import { useCallback, useState } from 'react';
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

export function Settings({ permissions }: PageProps) {
  const canPublish = permissions.includes('config.publish');

  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionOk, setActionOk] = useState('');
  const [lastResult, setLastResult] = useState<unknown>(undefined);

  const [publishText, setPublishText] = useState('');
  const [ackText, setAckText] = useState('');
  const [rollbackText, setRollbackText] = useState('');
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

  const runConfirmed = useCallback(
    async (kind: string, path: string, text: string, description: string) => {
      const parsed = parseJsonObject(text);
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
        const returned = asRecord(result.publication) ?? asRecord(result.receipt);
        const returnedRevision = returned?.revision;
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

  return (
    <>
      <PageTitle
        eyebrow="CONFIG PUBLICATION"
        title="配置发布"
        description="查看配置发布的修订、状态、发布人与激活回执，并执行发布、节点确认与回滚。"
        actions={<Button onClick={reloadPublication} busy={publicationState.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Notice tone="danger" icon={<ShieldAlert size={17} />}>
        发布与回滚属于危险操作：服务端要求二次确认（输入“确认”口令）后才会执行，且全部变更都会写入审计日志，无法撤销。
      </Notice>

      {(actionError || actionOk) && (
        <Notice tone={actionError ? 'danger' : 'info'}>{actionError || actionOk}</Notice>
      )}

      <DataState
        loading={publicationState.loading && !publicationState.data}
        error={publicationState.error}
        empty={!publication}
        emptyTitle="尚无发布记录"
        emptyDetail="服务端还没有该作用域的配置发布状态，可在下方发布控制台提交首个修订。"
        onRetry={reloadPublication}
      >
        <div className="stat-grid">
          <StatCard label="当前修订" value={revision === undefined ? '—' : formatNumber(revision)} note="activeRevision" />
          <StatCard label="发布阶段" value={<Pill tone={phaseTone(phase)}>{phaseLabel(phase)}</Pill>} note={String(pubScope ?? 'global')} />
          <StatCard
            label="实际生效"
            value={isEffective === undefined ? '未知' : isEffective ? '已生效' : '未生效'}
            note="运行时激活回执"
            tone={isEffective === undefined ? undefined : isEffective ? 'success' : 'warning'}
          />
          <StatCard label="发布记录" value={formatNumber(history.length)} note="history" />
        </div>

        <Panel title="发布状态" description="来自配置发布状态机的当前快照。">
          <Descriptions
            columns={2}
            items={[
              { label: '作用域', value: String(pubScope ?? '—') },
              { label: '发布阶段', value: phaseLabel(phase) },
              { label: '当前生效修订', value: revision === undefined ? '—' : String(revision) },
              { label: '期望修订', value: desiredRevision === undefined ? '—' : String(desiredRevision) },
              { label: '待确认修订', value: pendingRevision === undefined ? '—' : String(pendingRevision) },
              { label: '上一生效修订', value: previousRevision === undefined ? '—' : String(previousRevision) },
              { label: '发布人', value: publishedBy === undefined ? '—' : String(publishedBy) },
              { label: '发布时间', value: publishedAt === undefined ? '—' : `${formatDateTime(publishedAt)}（${formatRelative(publishedAt)}）` },
              { label: '确认节点数', value: formatNumber(ackCount) },
              { label: '回滚截止', value: deadlineAt === undefined ? '—' : formatDateTime(deadlineAt) },
              { label: '实际生效', value: isEffective === undefined ? '未知' : isEffective ? '已生效' : '未生效' },
            ]}
          />
        </Panel>

        <Panel title="完整发布状态" description="服务端返回的原始发布对象，便于排查。">
          <Collapsible title="发布对象 (JSON)" meta={<CopyButton value={prettyJson(publication)} />}>
            <pre className="json-view prewrap mono">{prettyJson(publication)}</pre>
          </Collapsible>
        </Panel>

        <Panel title="发布历史" description={`${history.length} 个历史修订，最近优先。`}>
          <DataState empty={history.length === 0} emptyTitle="暂无发布历史" emptyDetail="还没有发布过配置修订。">
            <Table minWidth={640}>
              <thead><tr><th>修订</th><th>摘要</th><th>发布人</th><th>发布时间</th><th>来源修订</th></tr></thead>
              <tbody>
                {history.map((record, index) => (
                  <tr key={`${String(record.revision ?? index)}`}>
                    <td className="table-primary">{record.revision === undefined ? '—' : String(record.revision)}</td>
                    <td className="mono truncate-cell">{record.digest === undefined ? '—' : truncateMiddle(record.digest)}</td>
                    <td>{record.publishedBy === undefined ? '—' : String(record.publishedBy)}</td>
                    <td>{formatDateTime(record.publishedAt)}</td>
                    <td>{record.sourceRevision === undefined ? '—' : String(record.sourceRevision)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>

        <Panel title="状态迁移" description={`${transitions.length} 条迁移记录，最近优先。`}>
          <DataState empty={transitions.length === 0} emptyTitle="暂无状态迁移" emptyDetail="发布状态机还没有产生迁移事件。">
            <Table minWidth={640}>
              <thead><tr><th>时间</th><th>类型</th><th>修订</th><th>操作者</th><th>详情</th></tr></thead>
              <tbody>
                {transitions.map((record, index) => (
                  <tr key={`${String(record.id ?? index)}`}>
                    <td>{formatDateTime(record.at)}</td>
                    <td><Pill tone="info">{String(record.kind ?? '—')}</Pill></td>
                    <td>{record.revision === undefined ? '—' : String(record.revision)}</td>
                    <td>{record.actor === undefined ? '—' : String(record.actor)}</td>
                    <td className="truncate-cell">{record.detail === undefined ? '—' : String(record.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>
      </DataState>

      {lastResult !== undefined && (
        <Panel title="最近一次操作结果" description="服务端返回的原始结果对象。">
          <Collapsible title="操作结果 (JSON)" defaultOpen meta={<CopyButton value={prettyJson(lastResult)} />}>
            <pre className="json-view prewrap mono">{prettyJson(lastResult)}</pre>
          </Collapsible>
        </Panel>
      )}

      {!canPublish ? (
        <Notice tone="warning">只读：当前账号缺少 config.publish 权限，无法发布、确认或回滚配置。</Notice>
      ) : (
        <div className="grid-3">
          <Panel title="发布新修订" description="请求体需包含 expectedRevision 与 payload；提交后需要二次确认。">
            <Field label="变更载荷 (JSON)" hint="POST /api/config/publish 的请求体。">
              <TextArea
                rows={8}
                value={publishText}
                onChange={(event) => setPublishText(event.target.value)}
                placeholder={'{\n  "expectedRevision": 0,\n  "payload": { "feature": { "enabled": true } }\n}'}
              />
            </Field>
            <div className="row">
              <Button variant="primary" busy={busy === 'publish'} onClick={() => { void runConfirmed('publish', '/config/publish', publishText, '发布配置'); }}>
                <CloudUpload size={15} /> 发布配置
              </Button>
            </div>
          </Panel>

          <Panel title="节点确认 (ACK)" description="为待生效修订提交 ACK/NACK，达到 rollout 目标后该修订才生效。">
            <Field label="ACK 载荷 (JSON)" hint="POST /api/config/ack 的请求体，需包含 revision、nodeId、digest、outcome。">
              <TextArea
                rows={8}
                value={ackText}
                onChange={(event) => setAckText(event.target.value)}
                placeholder={'{\n  "revision": 1,\n  "nodeId": "node-1",\n  "digest": "<sha256>",\n  "outcome": "ack"\n}'}
              />
            </Field>
            <div className="row">
              <Button variant="secondary" busy={busy === 'ack'} onClick={() => { void runConfirmed('ack', '/config/ack', ackText, '确认配置修订'); }}>
                确认节点
              </Button>
            </div>
          </Panel>

          <Panel title="回滚修订" description="回滚会把当前生效修订替换为上一修订（或请求体中的 toRevision），立即生效且不可撤销。">
            <Field label="回滚载荷 (JSON)" hint="POST /api/config/rollback 的请求体，需包含 expectedStateVersion。">
              <TextArea
                rows={8}
                value={rollbackText}
                onChange={(event) => setRollbackText(event.target.value)}
                placeholder={'{\n  "expectedStateVersion": 0\n}'}
              />
            </Field>
            <div className="row">
              <Button variant="danger" busy={busy === 'rollback'} onClick={() => { void runConfirmed('rollback', '/config/rollback', rollbackText, '回滚配置'); }}>
                <RotateCcw size={15} /> 回滚配置
              </Button>
            </div>
          </Panel>
        </div>
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
          empty={receiptItems.length === 0}
          emptyTitle="暂无激活回执"
          emptyDetail="该作用域还没有运行时上报的激活回执。"
          onRetry={reloadReceipts}
        >
          <Table minWidth={640}>
            <thead><tr><th>作用域</th><th>修订</th><th>摘要</th><th>激活人</th><th>激活时间</th><th>详情</th></tr></thead>
            <tbody>
              {receiptItems.map((receipt, index) => (
                <tr key={`${String(receipt.scope ?? '')}:${String(receipt.revision ?? index)}:${index}`}>
                  <td className="table-primary">{receipt.scope === undefined ? '—' : String(receipt.scope)}</td>
                  <td>{receipt.revision === undefined ? '—' : String(receipt.revision)}</td>
                  <td className="mono truncate-cell">{receipt.digest === undefined ? '—' : truncateMiddle(receipt.digest)}</td>
                  <td>{receipt.actor === undefined ? '—' : String(receipt.actor)}</td>
                  <td>{formatDateTime(receipt.activatedAt ?? receipt.acknowledgedAt)}</td>
                  <td className="truncate-cell">{receipt.detail === undefined ? '—' : String(receipt.detail)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </DataState>
      </Panel>

      {canPublish && (
        <Panel title="记录激活回执" description="为当前生效修订写入一条激活回执，标明运行时已实际应用该修订。">
          <Field label="回执载荷 (JSON)" hint="POST /api/config/activation-receipt 的请求体，可包含 scope 与 detail。">
            <TextArea
              rows={6}
              value={receiptText}
              onChange={(event) => setReceiptText(event.target.value)}
              placeholder={'{\n  "scope": "global",\n  "detail": "runtime boot activation"\n}'}
            />
          </Field>
          <div className="row">
            <Button variant="secondary" busy={busy === 'receipt'} onClick={() => { void runConfirmed('receipt', '/config/activation-receipt', receiptText, '记录激活回执'); }}>
              记录激活回执
            </Button>
          </div>
        </Panel>
      )}
    </>
  );
}
