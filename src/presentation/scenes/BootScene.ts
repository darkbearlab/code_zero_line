import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'Boot' });
  }

  create(): void {
    const { width, height } = this.scale;

    this.cameras.main.setBackgroundColor('#13261a');

    this.add
      .text(width / 2, height / 2 - 30, 'CODE: ZERO LINE', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '52px',
        color: '#cfe8cf',
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height / 2 + 28, 'v0.1 — boot', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#6a8a6a',
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height - 40, '代號：零號前線 — 規則骨架原型', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#4a6a4a',
      })
      .setOrigin(0.5);
  }
}
