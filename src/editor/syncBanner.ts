/**
 * Sync-status banner. Mounted once at editor boot. Listens to the
 * pending-queue from `serverSync.ts` and renders one of three states:
 *
 *   - hidden (queue empty: every recent save is on disk).
 *   - working (transient flash while a write is in flight).
 *   - error (queue non-empty after attempts: shows count + retry + export).
 *
 * Designed to be impossible to miss — solid red bar across the top of the
 * editor, with both Retry and "Export errors" buttons immediately available.
 */
import { downloadJson, timestampForFilename } from './io';
import {
  exportErrorReport,
  retryAll,
  subscribeSyncStatus,
  type PendingEntry,
} from './serverSync';

const banner = document.createElement('div');
banner.id = 'sync-banner';
Object.assign(banner.style, {
  position: 'sticky',
  top: '0',
  zIndex: '100',
  display: 'none',
  alignItems: 'center',
  gap: '12px',
  padding: '8px 16px',
  fontSize: '13px',
  fontFamily: 'ui-monospace, monospace',
  borderBottom: '2px solid #6a1414',
  background: '#3a0f0f',
  color: '#ffd6d6',
});

const message = document.createElement('span');
message.style.flex = '1';
banner.appendChild(message);

const detailsBtn = document.createElement('button');
detailsBtn.textContent = '▾ Detail';
styleAsButton(detailsBtn);
banner.appendChild(detailsBtn);

const retryBtn = document.createElement('button');
retryBtn.textContent = 'Retry now';
styleAsButton(retryBtn);
banner.appendChild(retryBtn);

const exportBtn = document.createElement('button');
exportBtn.textContent = '⤓ Export error log';
styleAsButton(exportBtn);
banner.appendChild(exportBtn);

const detailPanel = document.createElement('pre');
Object.assign(detailPanel.style, {
  display: 'none',
  position: 'sticky',
  top: '40px',
  zIndex: '99',
  margin: '0',
  padding: '8px 16px',
  background: '#1a0808',
  color: '#ffaaaa',
  fontSize: '11px',
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'pre-wrap',
  maxHeight: '200px',
  overflowY: 'auto',
  borderBottom: '1px solid #6a1414',
});

function styleAsButton(b: HTMLButtonElement): void {
  Object.assign(b.style, {
    background: '#1a0808',
    color: '#ffd6d6',
    border: '1px solid #6a1414',
    padding: '4px 10px',
    fontSize: '12px',
    fontFamily: 'ui-monospace, monospace',
    cursor: 'pointer',
    borderRadius: '3px',
  });
}

const renderDetail = (pending: ReadonlyArray<PendingEntry>): string => {
  if (pending.length === 0) return '(queue empty)';
  return pending
    .map(
      (p) =>
        `[${p.op}] ${p.type}/${p.id}  attempts=${p.attempts}\n` +
        `  enqueued: ${p.enqueuedAt}\n` +
        `  lastError: ${p.lastError ?? '(in flight)'}`,
    )
    .join('\n\n');
};

let lastPending: ReadonlyArray<PendingEntry> = [];

const render = (pending: ReadonlyArray<PendingEntry>): void => {
  lastPending = pending;
  if (pending.length === 0) {
    banner.style.display = 'none';
    detailPanel.style.display = 'none';
    return;
  }
  // 至少一筆已嘗試過 = 真的失敗；全部 attempts=0 = 還在飛
  const inFlight = pending.every((p) => p.attempts === 0 && !p.lastError);
  banner.style.display = 'flex';
  if (inFlight) {
    banner.style.background = '#3a2a0f';
    banner.style.borderBottomColor = '#8a6a14';
    banner.style.color = '#ffe4b5';
    message.textContent = `儲存中… ${pending.length} 筆等待寫入磁碟`;
  } else {
    banner.style.background = '#3a0f0f';
    banner.style.borderBottomColor = '#6a1414';
    banner.style.color = '#ffd6d6';
    message.textContent =
      `⚠ 有 ${pending.length} 筆編輯沒寫進專案 — 目前只在 localStorage（瀏覽器清掉就消失）。` +
      ` 開發 server 可能沒在跑或 endpoint 失敗。`;
  }
  if (detailPanel.style.display !== 'none') {
    detailPanel.textContent = renderDetail(pending);
  }
};

detailsBtn.onclick = (): void => {
  if (detailPanel.style.display === 'none') {
    detailPanel.style.display = 'block';
    detailPanel.textContent = renderDetail(lastPending);
    detailsBtn.textContent = '▴ Detail';
  } else {
    detailPanel.style.display = 'none';
    detailsBtn.textContent = '▾ Detail';
  }
};

retryBtn.onclick = async (): Promise<void> => {
  retryBtn.disabled = true;
  retryBtn.textContent = 'Retrying…';
  const r = await retryAll();
  retryBtn.disabled = false;
  retryBtn.textContent = 'Retry now';
  if (r.failed === 0 && r.succeeded > 0) {
    // small toast — reuse alert for simplicity
    alert(`全部 ${r.succeeded} 筆同步成功。`);
  } else if (r.failed > 0) {
    alert(`重試完成：成功 ${r.succeeded}，仍失敗 ${r.failed}。可按 ⤓ 匯出錯誤紀錄。`);
  }
};

exportBtn.onclick = (): void => {
  const report = exportErrorReport();
  downloadJson(`czl-sync-errors-${timestampForFilename()}.json`, report);
};

export const mountSyncBanner = (): void => {
  const body = document.body;
  if (!body) return;
  if (!banner.isConnected) body.insertBefore(banner, body.firstChild);
  if (!detailPanel.isConnected) body.insertBefore(detailPanel, banner.nextSibling);
  subscribeSyncStatus(render);
};
