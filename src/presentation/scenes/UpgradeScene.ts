/**
 * UpgradeScene — between-round persistent-upgrade purchasing. Vampire
 * Survivors-style two-pane layout: the left column lists every upgrade
 * (current level + next-cost badge), the right column expands the
 * selected upgrade with its full description and a [購買] button.
 *
 * Loaded from RoundSetupScene; clicking Back returns to it. Purchases
 * persist immediately via saveCampaign so a refresh mid-shopping won't
 * lose the spend.
 *
 * Region → tactical exchange (5:1) lives at the top as a one-shot
 * action button — it's a currency conversion, not a leveled upgrade.
 */
import Phaser from 'phaser';
import {
  buyUpgrade,
  exchangeRegionalForTactical,
  REGIONAL_TO_TACTICAL_RATE,
  type CampaignState,
} from '../../campaign/state';
import { loadCampaign, saveCampaign } from '../../campaign/persist';
import {
  UPGRADE_REGISTRY,
  upgradeMaxLevel,
  upgradeNextCost,
  type UpgradeCurrency,
} from '../../campaign/upgrades';

const CURRENCY_LABEL: Readonly<Record<UpgradeCurrency, string>> = {
  tactical: '作戰情報',
  regional: '區域情報',
  honor: '榮譽',
};

const CURRENCY_COLOR: Readonly<Record<UpgradeCurrency, string>> = {
  tactical: '#cfd1a1',
  regional: '#a1c1cf',
  honor: '#cfa1c1',
};

export class UpgradeScene extends Phaser.Scene {
  private rootEl!: HTMLElement;
  private campaign!: CampaignState;
  /** Currently highlighted upgrade in the right pane. */
  private selectedId: string | null = null;

  constructor() {
    super({ key: 'Upgrade' });
  }

  create(): void {
    hideBattleHud();
    const loaded = loadCampaign();
    if (!loaded) {
      // No campaign to upgrade against — bounce to title rather than crash.
      this.scene.start('Title');
      return;
    }
    this.campaign = loaded;
    if (this.selectedId === null) {
      this.selectedId = UPGRADE_REGISTRY[0]?.id ?? null;
    }
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private makeRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = this.renderHtml();
    document.body.appendChild(root);
    this.wireHandlers(root);
    return root;
  }

  private renderHtml(): string {
    const cur = this.campaign.currencies;
    const exchangeable = cur.regional >= REGIONAL_TO_TACTICAL_RATE;
    return `
      <h1>升級樹</h1>
      <div class="setup-body" style="max-width:980px;margin:0 auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(20,30,20,0.6);border:1px solid #3a5a3a;margin-bottom:14px;">
          <div style="display:flex;gap:18px;font-size:13px;">
            <span style="color:${CURRENCY_COLOR.tactical};">作戰 ${cur.tactical}</span>
            <span style="color:${CURRENCY_COLOR.regional};">區域 ${cur.regional}</span>
            <span style="color:${CURRENCY_COLOR.honor};">榮譽 ${cur.honor}</span>
          </div>
          <button data-action="exchange" ${exchangeable ? '' : 'disabled'}
            style="padding:6px 12px;font:inherit;font-size:12px;background:${exchangeable ? '#1a3a3a' : '#1a2a1a'};color:${exchangeable ? '#a1cfd1' : '#5a6a5a'};border:1px solid ${exchangeable ? '#4a8a8a' : '#2a3a2a'};cursor:${exchangeable ? 'pointer' : 'not-allowed'};">
            區域 ${REGIONAL_TO_TACTICAL_RATE} → 作戰 1
          </button>
        </div>
        <div style="display:grid;grid-template-columns:300px 1fr;gap:14px;align-items:start;">
          <div data-list style="display:flex;flex-direction:column;gap:6px;">
            ${this.renderList()}
          </div>
          <div data-detail style="padding:16px;background:rgba(20,30,20,0.5);border:1px solid #3a5a3a;min-height:280px;">
            ${this.renderDetail()}
          </div>
        </div>
      </div>
      <div class="setup-footer">
        <button data-action="back" style="padding:8px 18px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font:inherit;">← 回戰役回合</button>
      </div>
    `;
  }

  private renderList(): string {
    return UPGRADE_REGISTRY.map((def) => {
      const lvl = this.campaign.upgradeLevels[def.id] ?? 0;
      const max = upgradeMaxLevel(def);
      const next = upgradeNextCost(def, lvl);
      const wallet = this.campaign.currencies[def.currency];
      const affordable = next !== null && wallet >= next;
      const maxed = next === null;
      const selected = this.selectedId === def.id;
      const bg = selected ? 'rgba(40,60,40,0.8)' : 'rgba(20,30,20,0.6)';
      const border = selected ? '#7aa87a' : '#3a5a3a';
      const costLabel = maxed
        ? '<span style="color:#9af09a;">已滿級</span>'
        : `<span style="color:${affordable ? CURRENCY_COLOR[def.currency] : '#665a5a'};">${next} ${CURRENCY_LABEL[def.currency]}</span>`;
      return `
        <div data-row="${def.id}" style="cursor:pointer;padding:10px 12px;background:${bg};border:1px solid ${border};display:flex;justify-content:space-between;align-items:center;transition:background 0.1s;">
          <div style="display:flex;flex-direction:column;gap:2px;">
            <strong style="color:#cfe8cf;font-size:13px;">${def.displayName}</strong>
            <span style="color:#7a9a7a;font-size:10px;">Lv ${lvl}/${max}</span>
          </div>
          <span style="font-size:11px;">${costLabel}</span>
        </div>
      `;
    }).join('');
  }

  private renderDetail(): string {
    if (!this.selectedId) {
      return '<span style="color:#7a9a7a;">選一項升級查看詳細。</span>';
    }
    const def = UPGRADE_REGISTRY.find((u) => u.id === this.selectedId);
    if (!def) return '';
    const lvl = this.campaign.upgradeLevels[def.id] ?? 0;
    const max = upgradeMaxLevel(def);
    const next = upgradeNextCost(def, lvl);
    const wallet = this.campaign.currencies[def.currency];
    const affordable = next !== null && wallet >= next;
    const maxed = next === null;

    const tiersHtml = def.costPerLevel
      .map((cost, i) => {
        const reached = lvl > i;
        const isNext = lvl === i;
        const color = reached
          ? '#9af09a'
          : isNext
            ? CURRENCY_COLOR[def.currency]
            : '#5a6a5a';
        const marker = reached ? '✓' : isNext ? '►' : '·';
        return `<li style="color:${color};font-size:11px;padding:2px 0;">
          ${marker} Lv ${i + 1} — ${cost} ${CURRENCY_LABEL[def.currency]}
        </li>`;
      })
      .join('');

    const buyButton = maxed
      ? `<button disabled style="padding:10px 24px;font:inherit;background:#0a1a0a;color:#5a6a5a;border:1px solid #2a3a2a;cursor:not-allowed;">已滿級</button>`
      : `<button data-action="buy" ${affordable ? '' : 'disabled'} style="padding:10px 24px;font:inherit;background:${affordable ? '#1a3a2a' : '#2a1a1a'};color:${affordable ? '#cfe8cf' : '#8a6a6a'};border:1px solid ${affordable ? '#4a8a5a' : '#5a3a3a'};cursor:${affordable ? 'pointer' : 'not-allowed'};">
          購買 Lv ${lvl + 1} (${next} ${CURRENCY_LABEL[def.currency]})
        </button>`;

    return `
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
            <h2 style="font-size:18px;color:#cfe8cf;margin:0;">${def.displayName}</h2>
            <span style="color:#9aa89a;font-size:12px;">當前 Lv ${lvl}/${max}</span>
          </div>
          <div style="color:#${CURRENCY_COLOR[def.currency].slice(1)};font-size:12px;">
            幣別:${CURRENCY_LABEL[def.currency]}
          </div>
        </div>
        <div style="color:#cfe8cf;font-size:13px;line-height:1.7;white-space:pre-wrap;">${def.description}</div>
        <div>
          <div style="color:#7a9a7a;font-size:11px;margin-bottom:4px;">階級成本</div>
          <ul style="list-style:none;padding:0;margin:0;">
            ${tiersHtml}
          </ul>
        </div>
        <div style="display:flex;justify-content:flex-end;">
          ${buyButton}
        </div>
      </div>
    `;
  }

  private wireHandlers(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-row]').forEach((el) => {
      el.addEventListener('click', () => {
        this.selectedId = el.dataset.row ?? null;
        this.refresh();
      });
      el.addEventListener('mouseenter', () => {
        if (el.dataset.row !== this.selectedId) {
          el.style.background = 'rgba(30,45,30,0.7)';
        }
      });
      el.addEventListener('mouseleave', () => {
        if (el.dataset.row !== this.selectedId) {
          el.style.background = 'rgba(20,30,20,0.6)';
        }
      });
    });

    const buyBtn = root.querySelector<HTMLButtonElement>('[data-action="buy"]');
    if (buyBtn) {
      buyBtn.onclick = () => {
        if (!this.selectedId) return;
        const def = UPGRADE_REGISTRY.find((u) => u.id === this.selectedId);
        if (!def) return;
        const next = buyUpgrade(this.campaign, def);
        if (!next) return;
        this.campaign = next;
        saveCampaign(next);
        this.refresh();
      };
    }

    const exchangeBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="exchange"]',
    );
    if (exchangeBtn) {
      exchangeBtn.onclick = () => {
        const next = exchangeRegionalForTactical(this.campaign);
        if (!next) return;
        this.campaign = next;
        saveCampaign(next);
        this.refresh();
      };
    }

    root.querySelector<HTMLButtonElement>('[data-action="back"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('RoundSetup');
      };
  }

  private refresh(): void {
    if (!this.rootEl) return;
    this.rootEl.remove();
    this.rootEl = this.makeRoot();
  }
}

const hideBattleHud = (): void => {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  const frame = document.getElementById('hud-frame');
  if (frame) (frame as HTMLElement).style.display = 'none';
  const glow = document.getElementById('hud-frame-glow');
  if (glow) (glow as HTMLElement).style.display = 'none';
};
