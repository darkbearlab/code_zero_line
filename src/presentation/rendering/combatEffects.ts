import Phaser from 'phaser';
import type { Vec2 } from '../../core/geometry/types';

/**
 * Procedural combat visual effects — muzzle flash, tracer, blood mist,
 * floating hit text, damage-state escalate flash, death corpse marker.
 *
 * All draws live in `layer` so they sit above unit graphics and below HUD.
 * Each effect is fire-and-forget: it owns its own GameObjects + tween and
 * destroys them on completion. No state retained between calls.
 *
 * Effects are pure cosmetics — no GameState reads, no rules logic.
 */
export class CombatEffects {
  constructor(
    private readonly scene: Phaser.Scene,
    private readonly layer: Phaser.GameObjects.Container,
  ) {}

  /** Bright additive burst at the chevron tip. */
  muzzleFlash(at: Vec2, facing: number, tipOffset: number, delayMs: number = 0): void {
    const x = at.x + Math.cos(facing) * tipOffset;
    const y = at.y + Math.sin(facing) * tipOffset;
    const flash = this.scene.add.graphics();
    flash.fillStyle(0xfff7a0, 1);
    flash.fillCircle(0, 0, 4.5);
    flash.x = x;
    flash.y = y;
    flash.setBlendMode(Phaser.BlendModes.ADD);
    this.layer.add(flash);
    this.scene.tweens.add({
      targets: flash,
      alpha: 0,
      scale: 2.6,
      duration: 140,
      delay: delayMs,
      onComplete: () => flash.destroy(),
    });
  }

  /**
   * Tracer line shooter → target. Hit count drives visual weight.
   * Hot tracer (hits > 0) = bright yellow, thicker, additive.
   * Miss tracer (hits == 0) = thin grey, semi-transparent.
   */
  tracer(from: Vec2, to: Vec2, hits: number, delayMs: number = 0): void {
    const line = this.scene.add.graphics();
    if (hits > 0) {
      line.lineStyle(2.5, 0xfff084, 1);
      line.setBlendMode(Phaser.BlendModes.ADD);
    } else {
      line.lineStyle(1.5, 0x8a8a8a, 0.55);
    }
    line.beginPath();
    line.moveTo(from.x, from.y);
    line.lineTo(to.x, to.y);
    line.strokePath();
    line.setAlpha(0);
    this.layer.add(line);
    // Quick fade in then fade out — feels like a tracer streak.
    this.scene.tweens.add({
      targets: line,
      alpha: 1,
      duration: 50,
      delay: delayMs,
    });
    this.scene.tweens.add({
      targets: line,
      alpha: 0,
      duration: 220,
      delay: delayMs + 60,
      onComplete: () => line.destroy(),
    });
  }

  /** Particle burst at target — count scales with hits. No-op on miss. */
  bloodMist(at: Vec2, hits: number, delayMs: number = 0): void {
    if (hits <= 0) return;
    const count = Math.min(10, 4 + hits * 2);
    for (let i = 0; i < count; i++) {
      const dot = this.scene.add.graphics();
      dot.fillStyle(0xc0322e, 0.85);
      dot.fillCircle(0, 0, 1.6 + Math.random() * 1.8);
      dot.x = at.x;
      dot.y = at.y;
      this.layer.add(dot);
      const angle = Math.random() * Math.PI * 2;
      const dist = 6 + Math.random() * 16;
      this.scene.tweens.add({
        targets: dot,
        x: at.x + Math.cos(angle) * dist,
        y: at.y + Math.sin(angle) * dist,
        alpha: 0,
        scale: 0.3,
        duration: 360 + Math.random() * 120,
        delay: delayMs,
        ease: 'Cubic.Out',
        onComplete: () => dot.destroy(),
      });
    }
  }

  /** Floating combat text above the target — `+2 HITS`, `MISS`, `KILL`, ... */
  hitFloater(at: Vec2, text: string, color: string, delayMs: number = 0): void {
    const t = this.scene.add.text(at.x, at.y - 8, text, {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '13px',
      color,
      stroke: '#000000',
      strokeThickness: 3,
      fontStyle: 'bold',
    });
    t.setOrigin(0.5);
    t.setAlpha(0);
    this.layer.add(t);
    this.scene.tweens.add({
      targets: t,
      alpha: 1,
      duration: 90,
      delay: delayMs,
    });
    this.scene.tweens.add({
      targets: t,
      y: at.y - 38,
      alpha: 0,
      duration: 760,
      delay: delayMs + 90,
      ease: 'Cubic.Out',
      onComplete: () => t.destroy(),
    });
  }

  /** Expanding red ring — fires when damage state escalates. */
  escalateFlash(at: Vec2, radius: number, delayMs: number = 0): void {
    const ring = this.scene.add.graphics();
    ring.lineStyle(3, 0xff5050, 1);
    ring.strokeCircle(0, 0, radius);
    ring.x = at.x;
    ring.y = at.y;
    ring.setBlendMode(Phaser.BlendModes.ADD);
    this.layer.add(ring);
    this.scene.tweens.add({
      targets: ring,
      scaleX: 2.4,
      scaleY: 2.4,
      alpha: 0,
      duration: 460,
      delay: delayMs,
      ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
    });
  }

  /**
   * Drop a small corpse marker at the unit's last position. Lingers so the
   * player can see who died and where. The unit's container is destroyed
   * separately by renderUnits.
   */
  deathMarker(at: Vec2, radius: number, delayMs: number = 0): void {
    const corpse = this.scene.add.graphics();
    corpse.lineStyle(2, 0x553030, 0.8);
    const r = radius * 0.55;
    corpse.lineBetween(-r, -r, r, r);
    corpse.lineBetween(-r, r, r, -r);
    corpse.x = at.x;
    corpse.y = at.y;
    corpse.setAlpha(0);
    this.layer.add(corpse);
    this.scene.tweens.add({
      targets: corpse,
      alpha: 0.75,
      duration: 280,
      delay: delayMs,
    });
  }
}
