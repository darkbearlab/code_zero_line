import Phaser from 'phaser';
import { BattleScene } from './presentation/scenes/BattleScene';
import { DeployScene } from './presentation/scenes/DeployScene';
import { HubScene } from './presentation/scenes/HubScene';
import { InitiativeRollScene } from './presentation/scenes/InitiativeRollScene';
import { ReplayScene } from './presentation/scenes/ReplayScene';
import { ResultScene } from './presentation/scenes/ResultScene';
import { RosterScene } from './presentation/scenes/RosterScene';
import { RunResultScene } from './presentation/scenes/RunResultScene';
import { RunSetupScene } from './presentation/scenes/RunSetupScene';
import { TitleScene } from './presentation/scenes/TitleScene';

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
  scene: [
    TitleScene,
    RunSetupScene,
    HubScene,
    RunResultScene,
    RosterScene,
    InitiativeRollScene,
    DeployScene,
    BattleScene,
    ReplayScene,
    ResultScene,
  ],
};

new Phaser.Game(config);
