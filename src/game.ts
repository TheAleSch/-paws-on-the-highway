/**
 * Template game. Edit this file, game.json and assets/ only.
 * Rules: docs/spec/agent-instructions.md
 */
import * as pc from 'playcanvas';
import { Platform, type GameClient } from '@vibegames/sdk';

export async function start(canvas: HTMLCanvasElement): Promise<GameClient> {
  const game = await Platform.start({ canvas });     // 1. handshake
  const app = await game.createApp(pc);              // 2. WebGL2 app, portrait fill mode

  const camera = new pc.Entity('camera');
  camera.addComponent('camera', { clearColor: new pc.Color(0.05, 0.08, 0.14), projection: pc.PROJECTION_ORTHOGRAPHIC, orthoHeight: 8 });
  camera.setPosition(0, 0, 10);
  app.root.addChild(camera);

  const mat = new pc.StandardMaterial(); mat.diffuse.set(0, 0, 0); mat.emissive.set(1, 0.82, 0.4); mat.useLighting = false; mat.update();
  const thing = new pc.Entity('thing');
  thing.addComponent('render', { type: 'box', material: mat });
  app.root.addChild(thing);

  let score = 0;
  const scoreEl = document.getElementById('score');
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    score += 1; if (scoreEl) scoreEl.textContent = String(score);
    thing.setLocalEulerAngles(0, 0, score * 15);
    if (score >= 10) { game.scores.submit(score); game.gameOver({ score }); score = 0; }
  });
  game.on('resume', () => { /* play again after game over */ });

  // 3. load only game.json.criticalAssets here, then:
  app.once('postrender', () => game.ready());      // 4. exactly once
  return game;
}

const canvasEl = document.getElementById('game') as HTMLCanvasElement | null;
if (canvasEl) void start(canvasEl);
