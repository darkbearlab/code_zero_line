import Phaser from 'phaser';
import { BattleScene } from './presentation/scenes/BattleScene';
import { ReplayScene } from './presentation/scenes/ReplayScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0d0f0d',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  render: {
    antialias: true,
    pixelArt: false,
    roundPixels: false,
  },
  scene: [BattleScene, ReplayScene],
};

new Phaser.Game(config);
