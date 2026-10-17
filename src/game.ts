/**
 * Paws on the Highway: an endless three-lane drive where kittens and dogs wander onto the road.
 * The scene is drawn with Canvas 2D (multiply light map for day/night), then a WebGL2 post pass
 * (motion blur, bloom, chromatic split, grade, vignette) composites it onto the SDK canvas with the HUD on top.
 * Without WebGL2 the same scene and HUD are composited with Canvas 2D and the post pass is skipped.
 */
import { Platform, type GameClient } from '@vibegames/sdk';

type RGB = [number, number, number];
type Pal = { fur: string; dark: string; light: string; spots?: boolean };
type Animal = {
  type: 'cat' | 'dog'; pal: Pal; x: number; y: number; vx: number; phase: number;
  passed: boolean; flee: { vx: number; vy: number; rot: number } | null;
};
type Floater = { x: number; y: number; text: string; life: number; color?: string };
type Prop = { side: number; y: number; kind: 'bush' | 'post'; s: number };
type Lamp = { side: number; y: number };
type PickupKind = 'tire' | 'boost' | 'shield' | 'double' | 'star' | 'jet';
type Pickup = { kind: PickupKind; x: number; y: number; phase: number; taken?: boolean };
type Pt = [number, number];
type Rect = { x: number; y: number; w: number; h: number };

export async function start(canvas: HTMLCanvasElement): Promise<GameClient> {
  const game = await Platform.start({ canvas });
  const hosted = game.mode !== 'standalone';

  // ---------- world ----------
  const VW = 360, VH = 640;            // logical world size
  const ROAD_L = 36, ROAD_R = 324, LANES = 3;
  const LANE_W = (ROAD_R - ROAD_L) / LANES;
  const laneX = (i: number) => ROAD_L + LANE_W * (i + 0.5);
  const CAR_Y = 540, CAR_W = 44, CAR_H = 78;
  const DISPLAY = 'Bungee, "Arial Black", system-ui, sans-serif';
  const BODY = 'Outfit, system-ui, -apple-system, "Segoe UI", sans-serif';

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // the release host's live #hud: the score is drawn on the canvas, so keep it for screen readers only
  const hud = document.getElementById('hud');
  if (hud) hud.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
  const announce = (s: string) => { const el = document.getElementById('score'); if (el) el.textContent = s; };
  announce('Paws on the Highway. Tap to drive.');

  // scene (world only), light map and UI layers; the output canvas only receives the composite
  const scene = document.createElement('canvas');
  const ctx = scene.getContext('2d')!;
  const lm = document.createElement('canvas');
  const lctx = lm.getContext('2d')!;
  const ui = document.createElement('canvas');
  const uctx = ui.getContext('2d')!;

  // frame: the 9:16 road column fitted into the window, in CSS px
  let W = 1, H = 1, dpr = 1, S = 1, fx = 0, fy = 0, fw = 1, fh = 1;
  function resize() {
    W = Math.max(1, innerWidth); H = Math.max(1, innerHeight);
    dpr = Math.min(2, devicePixelRatio || 1);
    fh = H; fw = fh * 9 / 16;
    if (fw > W) { fw = W; fh = fw * 16 / 9; }
    fx = (W - fw) / 2; fy = (H - fh) / 2; S = fw / VW;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    scene.width = lm.width = Math.round(fw * dpr); scene.height = lm.height = Math.round(fh * dpr);
    ui.width = canvas.width; ui.height = canvas.height;
    ctx.setTransform(scene.width / VW, 0, 0, scene.height / VH, 0, 0);
    lctx.setTransform(scene.width / VW, 0, 0, scene.height / VH, 0, 0);
  }
  addEventListener('resize', resize);
  // platform-owned bands at the top and bottom of the window, converted to world units inside the frame
  const safeTopW = () => Math.max(0, (game.viewport.safeTop || 0) - fy) / S;
  const safeBottomW = () => Math.max(0, (game.viewport.safeBottom || 0) - (H - fy - fh)) / S;

  // ---------- sound (the host owns the toggle; silent until the player turns it on) ----------
  function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.12, slideTo?: number) {
    if (!game.audio.unlocked()) return;
    const audio = game.audio.context();
    if (!audio) return;
    const t0 = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(audio.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // ---------- game state ----------
  const START_LIVES = 3, MAX_LIVES = 5;
  const BOOST_TIME = 3.5, DOUBLE_TIME = 10, GRACE_TIME = 2;
  let state: 'menu' | 'play' | 'crash' | 'over' = 'menu';
  let paused = false, exited = false;
  let lane = 1, carX = laneX(1), carTilt = 0;
  let speed = 0, cruise = 0, dist = 0, points = 0, scroll = 0;
  let animals: Animal[] = [], floaters: Floater[] = [], pickups: Pickup[] = [];
  const props: Prop[] = [];
  let rowGap = 0, pickupGap = 0, crashT = 0, culprit: Animal | null = null, shake = 0, t = 0;
  let lives = START_LIVES, invuln = 0, hitT = -1, hitPos: Pt = [0.5, 0.5];
  let boostT = 0, doubleT = 0, shieldOn = false;
  let best = 0, finalScore = 0, isBest = false, overMsg = '', overAt = 0;

  function score() { return Math.floor(points); }
  function mult() { return doubleT > 0 ? 2 : 1; }
  function addPoints(n: number, x?: number, y?: number, label?: string, color?: string) {
    const p = n * mult();
    points += p;
    if (label !== undefined && x !== undefined && y !== undefined) floaters.push({ x, y, text: label.replace('#', String(p)), life: 1, color });
  }

  function reset() {
    lane = 1; carX = laneX(1); carTilt = 0;
    speed = cruise = 240; dist = 0; points = 0;
    animals = []; floaters = []; pickups = [];
    rowGap = 300; pickupGap = 700; crashT = 0; culprit = null; shake = 0;
    lives = START_LIVES; invuln = 0; hitT = -1;
    boostT = 0; doubleT = 0; shieldOn = false;
    starT = 0; flyT = 0; lift = 0; lastGap = 300;
    dayClock = CYCLE * 0.05;
  }
  let lastGap = 300;

  // roadside props for speed sense
  for (let i = 0; i < 10; i++) props.push({ side: i % 2, y: i * 70, kind: Math.random() < .5 ? 'bush' : 'post', s: .8 + Math.random() * .5 });
  // streetlights every 320px on alternating sides
  const lamps: Lamp[] = [];
  for (let i = 0; i < 3; i++) lamps.push({ side: i % 2, y: i * 320 - 60 });

  // ---------- day / night ----------
  const CYCLE = 96;                     // seconds for one full in-game day
  let dayClock = CYCLE * 0.05;
  // ambient light over the day: phase 0 = 08:00
  const SKY: [number, RGB][] = [
    [0, [255, 255, 255]], [.34, [255, 252, 245]], [.42, [255, 190, 140]], [.47, [168, 112, 150]],
    [.53, [44, 52, 104]], [.82, [44, 52, 104]], [.88, [150, 118, 172]], [.94, [255, 210, 196]], [1, [255, 255, 255]],
  ];
  let ambient: RGB = [255, 255, 255], night = 0;
  function updateSky() {
    const ph = (dayClock / CYCLE) % 1;
    let i = 0; while (ph > SKY[i + 1]![0]) i++;
    const [p0, c0] = SKY[i]!, [p1, c1] = SKY[i + 1]!;
    const k = (ph - p0) / (p1 - p0);
    ambient = c0.map((v, j) => Math.round(v + (c1[j]! - v) * k)) as RGB;
    const avg = (ambient[0] + ambient[1] + ambient[2]) / 3;
    night = Math.max(0, Math.min(1, (235 - avg) / (235 - 67)));
  }
  function clockText() {
    const hrs = (8 + ((dayClock / CYCLE) % 1) * 24) % 24;
    const hh = Math.floor(hrs), mm = Math.floor((hrs - hh) * 60 / 5) * 5;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  const CAT_COLORS: Pal[] = [
    { fur: '#f29a4a', dark: '#c96f22', light: '#ffd6a8' },
    { fur: '#8d8a96', dark: '#5f5c68', light: '#d9d6e0' },
    { fur: '#2b2730', dark: '#18151c', light: '#fffaf2' },
    { fur: '#f3eadf', dark: '#c9b9a6', light: '#ffffff' },
  ];
  const DOG_COLORS: Pal[] = [
    { fur: '#b5784a', dark: '#7c4d2b', light: '#f2d2b0' },
    { fur: '#e7c27d', dark: '#b88f45', light: '#fff1d0' },
    { fur: '#3c3138', dark: '#221b20', light: '#d8b28f' },
    { fur: '#f5f0e8', dark: '#3a3036', light: '#ffffff', spots: true },
  ];

  // Pickups: what they look like and what they do
  const PICKUPS: Record<PickupKind, { color: string; label: string; weight: number }> = {
    tire:   { color: '#7ee08a', label: 'Spare tire', weight: 18 },
    boost:  { color: '#5ad7ff', label: 'Nitro',      weight: 20 },
    shield: { color: '#a98bff', label: 'Shield',     weight: 16 },
    double: { color: '#ffd84a', label: '2× points',  weight: 16 },
    star:   { color: '#ff8fd8', label: 'Star!',      weight: 12 },
    jet:    { color: '#ff9a3c', label: 'Jets!',      weight: 12 },
  };
  const STAR_TIME = 6, FLY_TIME = 5;
  let starT = 0, flyT = 0, lift = 0;

  function spawnPickup() {
    const pool = (Object.entries(PICKUPS) as [PickupKind, typeof PICKUPS.tire][]).filter(([k]) =>
      !(k === 'tire' && lives >= MAX_LIVES) && !(k === 'shield' && shieldOn) &&
      !(k === 'star' && starT > 0) && !(k === 'jet' && flyT > 0));
    let r = Math.random() * pool.reduce((s, [, p]) => s + p.weight, 0);
    let kind = pool[0]![0];
    for (const [k, p] of pool) { if ((r -= p.weight) < 0) { kind = k; break; } }
    pickups.push({ kind, x: laneX(Math.random() * LANES | 0), y: -40, phase: Math.random() * 6.28 });
  }

  function collect(p: Pickup) {
    const info = PICKUPS[p.kind];
    if (p.kind === 'tire') lives = Math.min(MAX_LIVES, lives + 1);
    if (p.kind === 'boost') boostT = BOOST_TIME;
    if (p.kind === 'shield') shieldOn = true;
    if (p.kind === 'double') doubleT = DOUBLE_TIME;
    if (p.kind === 'star') { starT = STAR_TIME; [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.1, 'square', 0.05), i * 70)); }
    if (p.kind === 'jet') { flyT = FLY_TIME; tone(180, 0.6, 'sawtooth', 0.05, 520); }
    floaters.push({ x: p.x, y: CAR_Y - 60, text: p.kind === 'tire' ? '+1 tire' : info.label, life: 1.2, color: info.color });
    addPoints(20);
    tone(660, 0.08, 'triangle', 0.08); setTimeout(() => tone(990, 0.12, 'triangle', 0.08), 70);
  }

  function spawnRow() {
    // gentle ramp: the road stays forgiving for the first few minutes
    const difficulty = Math.min(1, dist / 30000);
    const blockTwo = dist > 1500 && Math.random() < 0.12 + difficulty * 0.38;
    const lanes = [0, 1, 2].sort(() => Math.random() - .5).slice(0, blockTwo ? 2 : 1);
    const crossing = !blockTwo && dist > 6000 && Math.random() < 0.15 + difficulty * 0.2;
    for (const l of lanes) {
      const isCat = Math.random() < .5;
      const pal = isCat ? CAT_COLORS[Math.random() * CAT_COLORS.length | 0]! : DOG_COLORS[Math.random() * DOG_COLORS.length | 0]!;
      animals.push({
        type: isCat ? 'cat' : 'dog', pal,
        x: laneX(l), y: -50,
        vx: crossing ? (Math.random() < .5 ? -1 : 1) * (22 + difficulty * 22) : 0,
        phase: Math.random() * 6.28,
        passed: false, flee: null,
      });
    }
  }

  function moveLane(dir: number) {
    if (state !== 'play' || paused) return;
    const n = Math.max(0, Math.min(LANES - 1, lane + dir));
    if (n !== lane) { lane = n; tone(420 + lane * 90, 0.07, 'square', 0.05); }
  }

  function startRun() {
    reset();
    state = 'play';
    announce('Driving. 3 spare tires.');
    tone(520, 0.1, 'triangle'); setTimeout(() => tone(780, 0.14, 'triangle'), 90);
  }

  function spook(a: Animal, strong: boolean) {
    a.flee = { vx: (a.x < carX ? -1 : 1) * 160, vy: -260, rot: 0 };
    hitT = 0; hitPos = [a.x / VW, a.y / VH];
    if (strong) { culprit = a; shake = reduceMotion ? 0 : 8; }
    tone(a.type === 'cat' ? 900 : 380, 0.25, 'triangle', 0.08, a.type === 'cat' ? 600 : 260);
  }

  // Contact with an animal: star, nitro and shield save you, otherwise it costs a tire
  function hitAnimal(a: Animal) {
    if (starT > 0) {
      spook(a, false);
      addPoints(25, a.x, a.y - 20, 'Boing! +#', '#ff8fd8');
      return;
    }
    if (boostT > 0) {
      spook(a, false);
      addPoints(15, a.x, a.y - 20, 'Hop! +#', '#5ad7ff');
      return;
    }
    if (invuln > 0) return;
    if (shieldOn) {
      shieldOn = false; invuln = 1.2;
      spook(a, false);
      floaters.push({ x: carX, y: CAR_Y - 60, text: 'Shield saved you', life: 1.3, color: '#a98bff' });
      tone(520, 0.2, 'sine', 0.1, 260);
      return;
    }
    lives -= 1;
    spook(a, true);
    tone(300, 0.3, 'sawtooth', 0.07, 180);
    if (lives > 0) {
      invuln = GRACE_TIME;
      cruise = Math.max(240, cruise * 0.85);   // ease off after a hit
      speed = Math.min(speed, cruise);
      floaters.push({ x: carX, y: CAR_Y - 60, text: lives === 1 ? 'Last tire!' : '-1 tire', life: 1.3, color: '#ff6b5a' });
      return;
    }
    gameOver(a);
  }

  function gameOver(a: Animal) {
    state = 'crash'; crashT = 0; culprit = a;
    shake = reduceMotion ? 0 : 10;
    finalScore = score();
    isBest = finalScore > best && finalScore > 0;
    best = Math.max(best, finalScore);
    overMsg = (a.type === 'cat' ? 'You spooked a kitten.' : 'You spooked a pup.') + ' It ran off safe.';
    // let the spooked animal hop clear before the result panel and the host's sheet appear
    setTimeout(() => {
      state = 'over'; overAt = t;
      announce(`Out of tires! ${overMsg} Score ${finalScore.toLocaleString()}.`);
      game.scores.submit(finalScore);
      game.gameOver({ score: finalScore });
      void refreshBest();
    }, 900);
  }

  async function refreshBest() {
    const s = await game.scores.summary();
    if (s && typeof s.personalBest === 'number') best = Math.max(best, s.personalBest);
  }

  // ---------- update ----------
  function update(dt: number) {
    t += dt;
    if (state === 'play') {
      cruise = Math.min(600, cruise + dt * 6);
      const target = cruise * (boostT > 0 ? 1.5 : 1);
      speed += (target - speed) * Math.min(1, dt * 3);
      dist += speed * dt;
      addPoints(speed * dt / 12);
      rowGap -= speed * dt;
      pickupGap -= speed * dt;
      if (rowGap <= 0) { spawnRow(); lastGap = 230 + speed * 0.25 + Math.random() * 160; rowGap = lastGap; }
      // keep pickups clear of animal rows so they are always reachable
      if (pickupGap <= 0 && rowGap > 110 && lastGap - rowGap > 110) { spawnPickup(); pickupGap = 900 + Math.random() * 800; }
      const wasFlying = flyT > 0;
      boostT = Math.max(0, boostT - dt);
      doubleT = Math.max(0, doubleT - dt);
      starT = Math.max(0, starT - dt);
      flyT = Math.max(0, flyT - dt);
      invuln = Math.max(0, invuln - dt);
      if (wasFlying && flyT === 0) invuln = Math.max(invuln, 0.8);   // land safely
    } else if (state === 'crash' || state === 'over') {
      speed = Math.max(0, speed - dt * 900);
      boostT = starT = flyT = 0;
    } else {
      speed = 140; // idle cruise behind the menu
    }
    lift += ((flyT > 0 ? 1 : 0) - lift) * Math.min(1, dt * 5);

    const travel = speed * dt;
    scroll = (scroll + travel) % 80;
    for (const p of props) { p.y += travel; if (p.y > VH + 40) { p.y -= 10 * 70; p.kind = Math.random() < .5 ? 'bush' : 'post'; } }
    for (const l of lamps) { l.y += travel; if (l.y > VH + 140) l.y -= 3 * 320; }
    if (state !== 'over') dayClock += dt;
    updateSky();

    // car steering
    const tx = laneX(lane);
    const dx = tx - carX;
    carX += dx * Math.min(1, dt * 14);
    carTilt = Math.max(-.25, Math.min(.25, dx * 0.012));

    for (const p of pickups) {
      p.y += travel; p.phase += dt * 4;
      if (state === 'play' && !p.taken && Math.abs(p.x - carX) < CAR_W / 2 + 16 && Math.abs(p.y - CAR_Y) < CAR_H / 2 + 16) {
        p.taken = true; collect(p);
      }
    }
    pickups = pickups.filter(p => !p.taken && p.y < VH + 60);

    for (const a of animals) {
      if (a.flee) {
        a.x += a.flee.vx * dt; a.y += a.flee.vy * dt; a.flee.vy += 900 * dt; a.flee.rot += dt * 8 * Math.sign(a.flee.vx);
        continue;
      }
      a.y += travel;
      a.phase += dt * (a.vx ? 14 : 6);
      if (a.vx) {
        a.x += a.vx * dt;
        if (a.x < ROAD_L + 22 || a.x > ROAD_R - 22) { a.vx *= -1; a.x = Math.max(ROAD_L + 22, Math.min(ROAD_R - 22, a.x)); }
      }
      if (state !== 'play') continue;
      // forgiving hitbox: smaller than the drawn car and animal; jets fly right over
      const touching = Math.abs(a.x - carX) < CAR_W / 2 + 8 && Math.abs(a.y - CAR_Y) < CAR_H / 2 + 4;
      if (touching && lift < 0.5) {
        hitAnimal(a);
        if ((state as string) !== 'play') break;
        if (a.flee) continue;
      }
      if (!a.passed && a.y > CAR_Y + CAR_H / 2) {
        a.passed = true;
        const sameLane = Math.abs(a.x - carX) < LANE_W * 0.5;
        if (lift > 0.5 && sameLane) { addPoints(15, a.x, CAR_Y - 20, 'Fly-by +#', '#ff9a3c'); continue; }
        const close = Math.abs(a.x - carX) < LANE_W * 1.15;
        if (close) { addPoints(25, a.x, CAR_Y - 20, 'Close call +#'); tone(880, 0.12, 'triangle', 0.07); }
        else addPoints(10, a.x, CAR_Y - 20, '+#');
      }
    }
    animals = animals.filter(a => a.y < VH + 80 && a.y > -400);
    if (culprit && !animals.includes(culprit)) culprit = null;
    for (const f of floaters) { f.y -= dt * 50; f.life -= dt; }
    floaters = floaters.filter(f => f.life > 0);
    if (state === 'crash') crashT += dt;
    if (hitT >= 0) { hitT += dt / 0.9; if (hitT >= 1) hitT = -1; }
    shake = Math.max(0, shake - dt * 30);
  }

  // ---------- drawing helpers ----------
  function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    g.beginPath(); g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  function drawRoad() {
    // shoulders
    const g = ctx.createLinearGradient(0, 0, 0, VH);
    g.addColorStop(0, '#5b8048'); g.addColorStop(1, '#6b8f4e');
    ctx.fillStyle = g; ctx.fillRect(-20, -20, VW + 40, VH + 40);
    // grass stripes
    ctx.fillStyle = 'rgba(255,255,255,.03)';
    for (let y = -80 + scroll; y < VH; y += 80) { ctx.fillRect(0, y, ROAD_L, 40); ctx.fillRect(ROAD_R, y, VW - ROAD_R, 40); }

    // props
    for (const p of props) {
      const x = p.side ? ROAD_R + 18 : ROAD_L - 18;
      if (p.kind === 'bush') {
        ctx.fillStyle = '#3c5c2c';
        ctx.beginPath(); ctx.arc(x, p.y, 12 * p.s, 0, 7); ctx.arc(x + 8 * p.s, p.y + 6, 9 * p.s, 0, 7); ctx.arc(x - 7 * p.s, p.y + 7, 8 * p.s, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(190,230,140,.28)';
        ctx.beginPath(); ctx.arc(x - 3, p.y - 4, 5 * p.s, 0, 7); ctx.fill();
      } else {
        ctx.fillStyle = '#d9d4cc'; ctx.fillRect(x - 2, p.y - 10, 4, 20);
        ctx.fillStyle = p.side ? '#ff6b5a' : '#ffd84a'; ctx.fillRect(x - 2, p.y - 10, 4, 5);
      }
    }

    // asphalt
    const a = ctx.createLinearGradient(ROAD_L, 0, ROAD_R, 0);
    a.addColorStop(0, '#4b4952'); a.addColorStop(.5, '#57555f'); a.addColorStop(1, '#4b4952');
    ctx.fillStyle = a; ctx.fillRect(ROAD_L, -20, ROAD_R - ROAD_L, VH + 40);
    // texture specks
    ctx.fillStyle = 'rgba(255,255,255,.035)';
    for (let i = 0; i < 40; i++) { const y = (i * 53 + scroll) % VH; ctx.fillRect(ROAD_L + (i * 71) % (ROAD_R - ROAD_L), y, 2, 2); }
    // edge lines
    ctx.fillStyle = '#efe9dd';
    ctx.fillRect(ROAD_L + 4, -20, 4, VH + 40); ctx.fillRect(ROAD_R - 8, -20, 4, VH + 40);
    // dashed lane lines
    ctx.fillStyle = '#ffd84a';
    for (let l = 1; l < LANES; l++) {
      const x = ROAD_L + LANE_W * l - 2;
      for (let y = -80 + scroll; y < VH; y += 80) ctx.fillRect(x, y, 4, 40);
    }
  }

  // headlight geometry: two lamps on the car's nose, beams follow its steering tilt
  function lampsOfCar() {
    const cy = CAR_Y - lift * 12, s = 1 + lift * 0.22;
    const c = Math.cos(carTilt), sn = Math.sin(carTilt);
    const pt = (x: number, y: number): Pt => [carX + (x * c - y * sn) * s, cy + (x * sn + y * c) * s];
    return { L: pt(-14, -CAR_H / 2 + 3), R: pt(14, -CAR_H / 2 + 3), tl: pt(-14, CAR_H / 2 - 4), tr: pt(14, CAR_H / 2 - 4), dir: carTilt };
  }

  // one beam: a soft cone that widens with distance, brightest just ahead of the lamp
  function beam(g: CanvasRenderingContext2D, [x, y]: Pt, dir: number, reach: number, spread: number, alpha: number, rgb: string) {
    const tipX = x + Math.sin(dir) * reach, tipY = y - Math.cos(dir) * reach;
    const nx = Math.cos(dir), ny = Math.sin(dir);
    const grad = g.createRadialGradient(x, y, 2, x, y, reach);
    grad.addColorStop(0, `rgba(${rgb},${alpha})`);
    grad.addColorStop(.35, `rgba(${rgb},${alpha * .7})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x - nx * 3, y - ny * 3);
    g.lineTo(tipX - nx * spread, tipY - ny * spread);
    g.quadraticCurveTo(tipX + Math.sin(dir) * 30, tipY - Math.cos(dir) * 30, tipX + nx * spread, tipY + ny * spread);
    g.lineTo(x + nx * 3, y + ny * 3);
    g.closePath(); g.fill();
  }

  function glow(g: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, a: number) {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${rgb},${a})`); grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }

  function lampHead(l: Lamp): Pt { return [l.side ? ROAD_R - 30 : ROAD_L + 30, l.y]; }

  // how strongly a point sits inside the headlight beams (0..1)
  function inBeam(px: number, py: number, Hd: ReturnType<typeof lampsOfCar>) {
    let b = 0;
    for (const [x, y] of [Hd.L, Hd.R]) {
      const dy = y - py; if (dy <= 0 || dy > 340) continue;
      const cx = x + Math.sin(Hd.dir) * dy;
      const half = 6 + dy * 0.24;
      const v = Math.max(0, 1 - Math.abs(px - cx) / half) * (1 - dy / 340);
      b = Math.max(b, v);
    }
    return b;
  }

  function applyLighting(sx: number, sy: number) {
    const Hd = lampsOfCar();
    const on = night > 0.04;
    const [r, g, b] = ambient;
    if (!on && r > 250 && g > 250 && b > 245) return;   // full daylight: nothing to do
    // 1) build the light map
    lctx.save();
    lctx.translate(sx, sy);
    lctx.globalCompositeOperation = 'source-over';
    lctx.fillStyle = `rgb(${r},${g},${b})`;
    lctx.fillRect(-20, -20, VW + 40, VH + 40);
    lctx.globalCompositeOperation = 'lighter';
    if (on) {
      const n = night;
      // streetlight pools, warm sodium orange
      for (const l of lamps) { const [x, y] = lampHead(l); glow(lctx, x, y + 6, 110, '255,176,96', .62 * n); }
      // headlights: wide low beam plus a tighter, longer high beam per lamp
      for (const lamp of [Hd.L, Hd.R]) {
        beam(lctx, lamp, Hd.dir, 330, 78, .55 * n, '255,236,196');
        beam(lctx, lamp, Hd.dir, 400, 34, .38 * n, '255,248,225');
      }
      // hot spot on the asphalt ahead of the bumper
      glow(lctx, (Hd.L[0] + Hd.R[0]) / 2 + Math.sin(Hd.dir) * 110, (Hd.L[1] + Hd.R[1]) / 2 - 110, 90, '255,240,205', .45 * n);
      // soft light around the car and red taillight spill behind it
      glow(lctx, carX, CAR_Y - lift * 12, 70, '150,150,190', .25 * n);
      glow(lctx, (Hd.tl[0] + Hd.tr[0]) / 2, Hd.tl[1] + 18, 46, '255,40,60', .5 * n);
      // pickups light up their surroundings
      for (const p of pickups) glow(lctx, p.x, p.y, 42, '255,255,255', .35 * n);
      if (starT > 0) glow(lctx, carX, CAR_Y, 110, '255,180,240', .6 * n);
      if (lift > .05) for (const s of [-1, 1]) glow(lctx, carX + s * 34, CAR_Y + 30, 60, '255,150,60', .5 * n * lift);
      if (boostT > 0) glow(lctx, carX, CAR_Y + 60, 60, '90,215,255', .55 * n);
    }
    lctx.restore();

    // 2) multiply the light map over the scene
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(lm, 0, 0);
    ctx.restore();
    if (!on) return;

    // 3) additive glows: beam haze, lamp flares, streetlight heads, eyeshine
    const n = night;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.globalCompositeOperation = 'lighter';
    for (const lamp of [Hd.L, Hd.R]) beam(ctx, lamp, Hd.dir, 300, 60, .07 * n, '255,236,200');
    for (const [x, y] of [Hd.L, Hd.R]) { glow(ctx, x, y, 16, '255,250,225', .9 * n); glow(ctx, x, y - 4, 40, '255,240,200', .25 * n); }
    for (const [x, y] of [Hd.tl, Hd.tr]) glow(ctx, x, y, 12, '255,50,70', .8 * n);
    for (const l of lamps) { const [x, y] = lampHead(l); glow(ctx, x, y, 22, '255,200,130', .8 * n); }
    // eyeshine: animals' eyes reflect your headlights so you can spot them in the dark
    for (const a of animals) {
      if (a.flee) continue;
      const lit = inBeam(a.x, a.y + 18, Hd);
      const near = lamps.some(l => Math.abs(lampHead(l)[1] - a.y) < 90) ? .35 : 0;
      const k = n * Math.min(1, .25 + lit * 1.2 + near);
      const eyeY = a.y + (a.type === 'cat' ? 16 : 20);
      const rgb = a.type === 'cat' ? '150,255,150' : '255,210,110';
      for (const ex of [-5, 5]) { glow(ctx, a.x + ex, eyeY, 6, rgb, k); glow(ctx, a.x + ex, eyeY, 2.2, '255,255,255', k); }
    }
    ctx.restore();
  }

  function drawLampPosts() {
    for (const l of lamps) {
      const baseX = l.side ? ROAD_R + 12 : ROAD_L - 12;
      const [hx, hy] = lampHead(l);
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(baseX + 4, l.y + 8, 7, 4, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = '#8c8795'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(baseX, l.y); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = '#6d6876'; rr(ctx, hx - 7, hy - 4, 14, 8, 3); ctx.fill();
      ctx.fillStyle = night > .04 ? '#ffe2b0' : '#cfd6dd'; rr(ctx, hx - 5, hy - 2, 10, 4, 2); ctx.fill();
      ctx.fillStyle = '#9a95a3'; ctx.beginPath(); ctx.arc(baseX, l.y, 4, 0, 7); ctx.fill();
    }
  }

  function flame(x: number, y: number, w: number, len: number, color: string) {
    const g = ctx.createLinearGradient(x, y, x, y + len);
    g.addColorStop(0, '#fffbe8'); g.addColorStop(.35, color); g.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.quadraticCurveTo(x, y + len * 1.15, x + w / 2, y); ctx.closePath(); ctx.fill();
  }

  function drawCar() {
    const star = starT > 0;
    const hue = (t * 540) % 360;
    const blink = invuln > 0 && !star && Math.floor(t * 12) % 2 === 0;
    const s = 1 + lift * 0.22;
    // shadow stays on the road and drifts away as the car lifts off
    ctx.save();
    ctx.translate(carX + 3 + lift * 16, CAR_Y + 6 + lift * 22);
    ctx.rotate(carTilt);
    ctx.scale(1 - lift * .12, 1 - lift * .12);
    ctx.fillStyle = `rgba(0,0,0,${.35 - lift * .15})`; rr(ctx, -CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H, 12); ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(carX, CAR_Y - lift * 12);
    ctx.rotate(carTilt);
    ctx.scale(s, s);
    if (blink) ctx.globalAlpha = .4;
    // nitro: twin exhaust flames
    if (boostT > 0) { const f = 1 + Math.random() * .35; flame(-9, CAR_H / 2 - 2, 9, 30 * f, '#5ad7ff'); flame(9, CAR_H / 2 - 2, 9, 30 * f, '#5ad7ff'); }
    // jets: side wings and engines
    if (lift > 0.05) {
      ctx.globalAlpha *= Math.min(1, lift * 1.4);
      ctx.fillStyle = '#c9c3d6';
      ctx.beginPath(); ctx.moveTo(-CAR_W / 2 + 2, -6); ctx.lineTo(-CAR_W / 2 - 18, 10); ctx.lineTo(-CAR_W / 2 - 18, 18); ctx.lineTo(-CAR_W / 2 + 2, 14); ctx.fill();
      ctx.beginPath(); ctx.moveTo(CAR_W / 2 - 2, -6); ctx.lineTo(CAR_W / 2 + 18, 10); ctx.lineTo(CAR_W / 2 + 18, 18); ctx.lineTo(CAR_W / 2 - 2, 14); ctx.fill();
      for (const x of [-CAR_W / 2 - 12, CAR_W / 2 + 12]) {
        ctx.fillStyle = '#4a4458'; rr(ctx, x - 5, -2, 10, 24, 4); ctx.fill();
        ctx.fillStyle = '#ff9a3c'; rr(ctx, x - 5, -2, 10, 4, 2); ctx.fill();
        flame(x, 22, 9, 22 + Math.random() * 12, '#ff9a3c');
      }
      ctx.globalAlpha = blink ? .4 : 1;
    }
    // tires
    ctx.fillStyle = '#16131a';
    for (const [x, y] of [[-25, -24], [19, -24], [-25, 14], [19, 14]] as Pt[]) { rr(ctx, x, y, 6, 16, 2); ctx.fill(); }
    // body (rainbow while the star is active)
    ctx.fillStyle = star ? `hsl(${hue} 95% 62%)` : '#ff6b5a'; rr(ctx, -CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H, 12); ctx.fill();
    ctx.fillStyle = star ? `hsl(${(hue + 50) % 360} 90% 52%)` : '#e04f3f'; rr(ctx, -CAR_W / 2, -2, CAR_W, CAR_H / 2 + 2, 10); ctx.fill();
    // windshield + roof + rear window
    ctx.fillStyle = '#2a3550'; rr(ctx, -16, -24, 32, 14, 5); ctx.fill();
    ctx.fillStyle = star ? `hsl(${(hue + 120) % 360} 100% 76%)` : '#ff8a7a'; rr(ctx, -15, -9, 30, 22, 5); ctx.fill();
    ctx.fillStyle = '#2a3550'; rr(ctx, -14, 15, 28, 9, 4); ctx.fill();
    // racing stripe
    ctx.fillStyle = 'rgba(255,244,230,.85)'; ctx.fillRect(-3, -CAR_H / 2 + 2, 6, 12); ctx.fillRect(-3, 26, 6, 10);
    // headlights / taillights
    ctx.fillStyle = '#fff6c9'; rr(ctx, -19, -CAR_H / 2 + 2, 9, 5, 2); ctx.fill(); rr(ctx, 10, -CAR_H / 2 + 2, 9, 5, 2); ctx.fill();
    ctx.fillStyle = '#ff2e4d'; rr(ctx, -19, CAR_H / 2 - 6, 9, 4, 2); ctx.fill(); rr(ctx, 10, CAR_H / 2 - 6, 9, 4, 2); ctx.fill();
    ctx.restore();

    const cy = CAR_Y - lift * 12;
    // shield bubble
    if (shieldOn) {
      ctx.save();
      const r = 52 * s + Math.sin(t * 6) * 1.5;
      const g = ctx.createRadialGradient(carX, cy, r * .6, carX, cy, r);
      g.addColorStop(0, 'rgba(169,139,255,0)'); g.addColorStop(.85, 'rgba(169,139,255,.22)'); g.addColorStop(1, 'rgba(200,180,255,.55)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(carX, cy, r, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(220,205,255,.7)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
    }
    // star sparkles orbiting the car
    if (star) {
      for (let i = 0; i < 6; i++) {
        const a = t * 4 + i * 1.047;
        const x = carX + Math.cos(a) * 40, y = cy + Math.sin(a) * 52;
        drawStar(ctx, x, y, 5, 2.2, `hsl(${(hue + i * 60) % 360} 100% 75%)`);
      }
    }
  }

  function drawStar(g: CanvasRenderingContext2D, x: number, y: number, R: number, r: number, fill: string) {
    g.fillStyle = fill;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r : R;
      g.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    g.closePath(); g.fill();
  }

  function drawPickup(p: Pickup) {
    const info = PICKUPS[p.kind];
    const y = p.y + Math.sin(p.phase) * 3;
    const ring = 18 + Math.sin(p.phase * 2) * 1.5;
    ctx.save();
    ctx.translate(p.x, y);
    // glow and token
    const g = ctx.createRadialGradient(0, 0, 8, 0, 0, ring + 10);
    g.addColorStop(0, info.color); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = .55; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, ring + 10, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = info.color; ctx.beginPath(); ctx.arc(0, 0, ring, 0, 7); ctx.fill();
    ctx.fillStyle = '#1f1830'; ctx.beginPath(); ctx.arc(0, 0, ring - 3, 0, 7); ctx.fill();
    // icon
    if (p.kind === 'tire') {
      ctx.fillStyle = '#15121a'; ctx.beginPath(); ctx.arc(0, 0, 11, 0, 7); ctx.fill();
      ctx.strokeStyle = '#4a4458'; ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) { const a = i * .785 + p.phase * .3; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 7, Math.sin(a) * 7); ctx.lineTo(Math.cos(a) * 11, Math.sin(a) * 11); ctx.stroke(); }
      ctx.fillStyle = '#c9c3d6'; ctx.beginPath(); ctx.arc(0, 0, 4, 0, 7); ctx.fill();
    } else if (p.kind === 'boost') {
      ctx.fillStyle = info.color;
      ctx.beginPath(); ctx.moveTo(3, -12); ctx.lineTo(-7, 2); ctx.lineTo(-1, 2); ctx.lineTo(-3, 12); ctx.lineTo(7, -2); ctx.lineTo(1, -2); ctx.closePath(); ctx.fill();
    } else if (p.kind === 'shield') {
      ctx.fillStyle = info.color;
      ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(9, -7); ctx.quadraticCurveTo(9, 6, 0, 12); ctx.quadraticCurveTo(-9, 6, -9, -7); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1f1830'; ctx.fillRect(-1.5, -5, 3, 10); ctx.fillRect(-5, -1.5, 10, 3);
    } else if (p.kind === 'double') {
      ctx.fillStyle = info.color; ctx.font = `15px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('2×', 0, 1);
    } else if (p.kind === 'star') {
      drawStar(ctx, 0, 0, 12, 5.2, `hsl(${(t * 300) % 360} 100% 72%)`);
    } else if (p.kind === 'jet') {
      ctx.fillStyle = '#e8e2f2';
      ctx.beginPath(); ctx.moveTo(0, -12); ctx.quadraticCurveTo(6, -6, 5, 5); ctx.lineTo(-5, 5); ctx.quadraticCurveTo(-6, -6, 0, -12); ctx.fill();
      ctx.fillStyle = info.color;
      ctx.beginPath(); ctx.moveTo(-5, 1); ctx.lineTo(-10, 8); ctx.lineTo(-5, 6); ctx.fill();
      ctx.beginPath(); ctx.moveTo(5, 1); ctx.lineTo(10, 8); ctx.lineTo(5, 6); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-3, 6); ctx.quadraticCurveTo(0, 14 + Math.sin(p.phase * 4) * 2, 3, 6); ctx.fill();
    }
    ctx.restore();
  }

  function drawCat(a: Animal, pal: Pal) {
    const bob = Math.sin(a.phase) * (a.vx ? 2 : 1);
    // tail (behind, toward the top)
    ctx.strokeStyle = pal.fur; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.quadraticCurveTo(14 + Math.sin(a.phase) * 6, -22, 6, -34); ctx.stroke();
    // body
    ctx.fillStyle = pal.fur; ctx.beginPath(); ctx.ellipse(0, -2 + bob * .3, 14, 17, 0, 0, 7); ctx.fill();
    ctx.fillStyle = pal.dark;
    ctx.fillRect(-8, -12, 16, 3); ctx.fillRect(-9, -5, 18, 3);
    // paws
    ctx.fillStyle = pal.light;
    ctx.beginPath(); ctx.arc(-8, 13 + bob, 4, 0, 7); ctx.arc(8, 13 - bob, 4, 0, 7); ctx.fill();
    // head
    ctx.fillStyle = pal.fur;
    ctx.beginPath(); ctx.moveTo(-15, 14); ctx.lineTo(-11, 0); ctx.lineTo(-3, 9); ctx.fill();
    ctx.beginPath(); ctx.moveTo(15, 14); ctx.lineTo(11, 0); ctx.lineTo(3, 9); ctx.fill();
    ctx.fillStyle = '#ffb3b3';
    ctx.beginPath(); ctx.moveTo(-12, 11); ctx.lineTo(-10.5, 4); ctx.lineTo(-6, 9); ctx.fill();
    ctx.beginPath(); ctx.moveTo(12, 11); ctx.lineTo(10.5, 4); ctx.lineTo(6, 9); ctx.fill();
    ctx.fillStyle = pal.fur; ctx.beginPath(); ctx.arc(0, 18, 13, 0, 7); ctx.fill();
    ctx.fillStyle = pal.light; ctx.beginPath(); ctx.ellipse(0, 23, 7, 5, 0, 0, 7); ctx.fill();
    // eyes
    ctx.fillStyle = '#1b1720';
    ctx.beginPath(); ctx.ellipse(-5, 16, 2.4, 3.2, 0, 0, 7); ctx.ellipse(5, 16, 2.4, 3.2, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-4.2, 14.8, .9, 0, 7); ctx.arc(5.8, 14.8, .9, 0, 7); ctx.fill();
    // nose + whiskers
    ctx.fillStyle = '#ff8fa3'; ctx.beginPath(); ctx.moveTo(-2, 21); ctx.lineTo(2, 21); ctx.lineTo(0, 23.5); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = .8;
    ctx.beginPath(); ctx.moveTo(-4, 23); ctx.lineTo(-14, 21); ctx.moveTo(-4, 24); ctx.lineTo(-14, 25);
    ctx.moveTo(4, 23); ctx.lineTo(14, 21); ctx.moveTo(4, 24); ctx.lineTo(14, 25); ctx.stroke();
  }

  function drawDog(a: Animal, pal: Pal) {
    const bob = Math.sin(a.phase) * (a.vx ? 2 : 1);
    // tail wag
    ctx.strokeStyle = pal.fur; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(Math.sin(a.phase * 2) * 10, -30); ctx.stroke();
    // body
    ctx.fillStyle = pal.fur; ctx.beginPath(); ctx.ellipse(0, -3 + bob * .3, 15, 19, 0, 0, 7); ctx.fill();
    if (pal.spots) { ctx.fillStyle = pal.dark; ctx.beginPath(); ctx.arc(-6, -8, 4, 0, 7); ctx.arc(7, -2, 3, 0, 7); ctx.arc(-2, 4, 2.5, 0, 7); ctx.fill(); }
    // collar
    ctx.fillStyle = '#4aa3ff'; rr(ctx, -10, 9, 20, 4, 2); ctx.fill();
    ctx.fillStyle = '#ffd84a'; ctx.beginPath(); ctx.arc(0, 14, 2.2, 0, 7); ctx.fill();
    // paws
    ctx.fillStyle = pal.light;
    ctx.beginPath(); ctx.arc(-9, 14 + bob, 4.5, 0, 7); ctx.arc(9, 14 - bob, 4.5, 0, 7); ctx.fill();
    // head
    ctx.fillStyle = pal.fur; ctx.beginPath(); ctx.arc(0, 22, 13, 0, 7); ctx.fill();
    // floppy ears
    ctx.fillStyle = pal.dark;
    ctx.beginPath(); ctx.ellipse(-12, 22, 5, 9, .35 + Math.sin(a.phase) * .1, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(12, 22, 5, 9, -.35 - Math.sin(a.phase) * .1, 0, 7); ctx.fill();
    // muzzle
    ctx.fillStyle = pal.light; ctx.beginPath(); ctx.ellipse(0, 28, 8, 6, 0, 0, 7); ctx.fill();
    // eyes
    ctx.fillStyle = '#1b1720'; ctx.beginPath(); ctx.arc(-5, 20, 2.5, 0, 7); ctx.arc(5, 20, 2.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-4.2, 19.2, .9, 0, 7); ctx.arc(5.8, 19.2, .9, 0, 7); ctx.fill();
    // nose + tongue
    ctx.fillStyle = '#1b1720'; ctx.beginPath(); ctx.ellipse(0, 26, 3.2, 2.4, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#ff7b93'; rr(ctx, -2.5, 30, 5, 6 + Math.max(0, Math.sin(a.phase * 1.5)) * 2, 2.5); ctx.fill();
  }

  function drawAnimal(a: Animal) {
    ctx.save();
    ctx.translate(a.x, a.y);
    // ground shadow
    if (!a.flee) { ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(2, 8, 17, 22, 0, 0, 7); ctx.fill(); }
    if (a.flee) ctx.rotate(a.flee.rot * .25);
    if (a.vx) ctx.rotate(Math.sign(a.vx) * -.35);
    if (a.type === 'cat') drawCat(a, a.pal); else drawDog(a, a.pal);
    ctx.restore();
    // surprise bubble on the spooked one
    if (a === culprit) {
      ctx.save();
      ctx.translate(a.x + 18, a.y - 30);
      ctx.fillStyle = '#fff4e6'; rr(ctx, -10, -14, 20, 24, 8); ctx.fill();
      ctx.fillStyle = '#ff6b5a'; ctx.font = `18px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('!', 0, -1);
      ctx.restore();
    }
  }

  function drawFloaters() {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of floaters) {
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.5));
      ctx.font = (f.text.length > 4 ? '13px ' : '18px ') + DISPLAY;
      ctx.fillStyle = '#1f1830'; ctx.fillText(f.text, f.x + 1, f.y + 2);
      ctx.fillStyle = f.color || (f.text.length > 4 ? '#ffb347' : '#ffd84a'); ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawScene() {
    const sx = shake ? (Math.random() - .5) * shake : 0, sy = shake ? (Math.random() - .5) * shake : 0;
    ctx.save();
    ctx.translate(sx, sy);
    drawRoad();
    drawLampPosts();
    for (const a of animals) if (a !== culprit) drawAnimal(a);
    drawCar();
    if (culprit) drawAnimal(culprit);
    ctx.restore();
    applyLighting(sx, sy);
    // pickups and score pops glow on their own, so they stay readable at night
    ctx.save();
    ctx.translate(sx, sy);
    for (const p of pickups) drawPickup(p);
    drawFloaters();
    ctx.restore();
  }

  // ---------- HUD and panels (canvas UI layer, world units inside the frame) ----------
  const INK = '#fff4e6', MUTED = '#c9bdd9', LANE = '#ffd84a', ACCENT = '#ff6b5a', SUN = '#ffb347', CHIP = 'rgba(20,14,34,.72)';
  const NONE: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let fxBtn = NONE, steerL = NONE, steerR = NONE;
  let pressedL = 0, pressedR = 0;

  function chip(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 12) {
    g.fillStyle = CHIP; rr(g, x, y, w, h, r); g.fill();
  }
  function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'left', base: CanvasTextBaseline = 'alphabetic') {
    g.font = font; g.fillStyle = color; g.textAlign = align; g.textBaseline = base; g.fillText(s, x, y);
  }
  function wrap(g: CanvasRenderingContext2D, s: string, maxW: number, font: string) {
    g.font = font;
    const lines: string[] = []; let cur = '';
    for (const w of s.split(' ')) {
      const next = cur ? cur + ' ' + w : w;
      if (g.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function daypart(ct: string) {
    const hr = +ct.slice(0, 2);
    return hr >= 5 && hr < 8 ? 'Dawn' : hr < 12 ? 'Morning' : hr < 17 ? 'Day' : hr < 20 ? 'Sunset' : 'Night';
  }
  function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
    g.save(); g.shadowColor = c; g.shadowBlur = 8; g.fillStyle = c; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.restore();
  }
  function tireIcon(g: CanvasRenderingContext2D, x: number, y: number, full: boolean) {
    g.save();
    g.globalAlpha = full ? 1 : .22;
    const r = full ? 7.5 : 6;
    g.fillStyle = '#3a3442'; g.beginPath(); g.arc(x, y, r + 1.5, 0, 7); g.fill();
    g.fillStyle = '#15121a'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.fillStyle = '#2a2530'; g.beginPath(); g.arc(x, y, r * .4, 0, 7); g.fill();
    g.fillStyle = '#b9b3c4'; g.beginPath(); g.arc(x, y, r * .26, 0, 7); g.fill();
    g.restore();
  }
  function chevron(g: CanvasRenderingContext2D, cx: number, cy: number, dir: number) {
    g.strokeStyle = INK; g.lineWidth = 3.5; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(cx - dir * 3.5, cy - 8); g.lineTo(cx + dir * 4.5, cy); g.lineTo(cx - dir * 3.5, cy + 8); g.stroke();
  }
  function button(g: CanvasRenderingContext2D, label: string, cx: number, y: number) {
    g.font = `18px ${DISPLAY}`;
    const w = Math.max(120, g.measureText(label).width + 56), h = 50, x = cx - w / 2;
    g.fillStyle = '#b8402f'; rr(g, x, y + 5, w, h, 14); g.fill();
    g.fillStyle = ACCENT; rr(g, x, y, w, h, 14); g.fill();
    text(g, label, cx, y + h / 2 + 1, `18px ${DISPLAY}`, INK, 'center', 'middle');
  }
  function panelBg(g: CanvasRenderingContext2D) {
    const gr = g.createLinearGradient(0, 0, 0, VH);
    gr.addColorStop(0, 'rgba(31,24,48,.25)'); gr.addColorStop(.45, 'rgba(31,24,48,.82)'); gr.addColorStop(1, 'rgba(31,24,48,.9)');
    g.fillStyle = gr; g.fillRect(0, 0, VW, VH);
  }

  function drawHud(g: CanvasRenderingContext2D) {
    const top = safeTopW() + 10;
    // score + tires
    const slots = Math.max(START_LIVES, lives);
    chip(g, 12, top, Math.max(86, slots * 19 + 20), 62);
    text(g, 'SCORE', 22, top + 16, `600 10px ${BODY}`, MUTED);
    text(g, score().toLocaleString(), 22, top + 38, `22px ${DISPLAY}`, LANE);
    for (let i = 0; i < slots; i++) tireIcon(g, 29.5 + i * 19, top + 50, i < lives);
    // active powers
    const list: [string, string, string][] = [];
    if (starT > 0) list.push(['#ff8fd8', 'STAR', Math.ceil(starT) + 's']);
    if (flyT > 0) list.push(['#ff9a3c', 'JETS', Math.ceil(flyT) + 's']);
    if (boostT > 0) list.push(['#5ad7ff', 'NITRO', Math.ceil(boostT) + 's']);
    if (doubleT > 0) list.push(['#ffd84a', '2×', Math.ceil(doubleT) + 's']);
    if (shieldOn) list.push(['#a98bff', 'SHIELD', '']);
    let px = 12, py = top + 68;
    for (const [c, n, s] of list) {
      g.font = `800 11px ${BODY}`; const nw = g.measureText(n).width;
      g.font = `600 11px ${BODY}`; const sw = s ? g.measureText(' ' + s).width : 0;
      const w = 27 + nw + sw;
      if (px + w > 182) { px = 12; py += 27; }
      chip(g, px, py, w, 22, 10);
      dot(g, px + 10, py + 11, 4, c);
      text(g, n, px + 19, py + 11.5, `800 11px ${BODY}`, INK, 'left', 'middle');
      if (s) text(g, ' ' + s, px + 19 + nw, py + 11.5, `600 11px ${BODY}`, MUTED, 'left', 'middle');
      px += w + 5;
    }
    // right: speed, clock, FX toggle
    const fxW = gpu?.fx ? 40 : 0;
    const cw = 70, cx = VW - 12 - cw - (fxW ? fxW + 8 : 0);
    chip(g, cx, top, cw, 44);
    text(g, 'KM/H', cx + 10, top + 16, `600 10px ${BODY}`, MUTED);
    text(g, String(Math.round(speed * 0.18)), cx + 10, top + 36, `18px ${DISPLAY}`, INK);
    const ct = clockText();
    chip(g, cx, top + 50, cw, 44);
    text(g, daypart(ct).toUpperCase(), cx + 10, top + 66, `600 10px ${BODY}`, MUTED);
    text(g, ct, cx + 10, top + 86, `18px ${DISPLAY}`, INK);
    if (fxW) {
      fxBtn = { x: VW - 12 - fxW, y: top, w: fxW, h: 40 };
      chip(g, fxBtn.x, fxBtn.y, fxBtn.w, fxBtn.h);
      text(g, 'FX', fxBtn.x + fxW / 2, fxBtn.y + 21, `13px ${DISPLAY}`, fxOn ? LANE : MUTED, 'center', 'middle');
    } else fxBtn = NONE;
  }

  function drawSteer(g: CanvasRenderingContext2D) {
    const y = VH - 12 - 56 - safeBottomW();
    steerL = { x: 10, y, w: 64, h: 56 };
    steerR = { x: VW - 74, y, w: 64, h: 56 };
    for (const [r, dir, pr] of [[steerL, -1, pressedL], [steerR, 1, pressedR]] as [Rect, number, number][]) {
      const down = t < pr;
      g.save();
      g.translate(r.x + r.w / 2, r.y + r.h / 2);
      if (down) g.scale(.92, .92);
      g.fillStyle = down ? ACCENT : 'rgba(20,14,34,.62)'; rr(g, -r.w / 2, -r.h / 2, r.w, r.h, 16); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; rr(g, -r.w / 2 + .5, -r.h / 2 + .5, r.w - 1, r.h - 1, 15.5); g.stroke();
      chevron(g, 0, 0, dir);
      g.restore();
    }
  }

  function drawMenu(g: CanvasRenderingContext2D) {
    panelBg(g);
    const cx = VW / 2;
    let y = Math.max(150, safeTopW() + 60);
    for (const [line, color] of [['Paws on the', INK], ['Highway', LANE]] as [string, string][]) {
      text(g, line, cx, y + 3, `40px ${DISPLAY}`, ACCENT, 'center');
      text(g, line, cx, y, `40px ${DISPLAY}`, color, 'center');
      y += 40;
    }
    y += 12;
    for (const l of wrap(g, 'Kittens and dogs wandered onto the road. Swerve around them. You have 3 spare tires.', 230, `15px ${BODY}`)) {
      text(g, l, cx, y, `15px ${BODY}`, MUTED, 'center'); y += 22;
    }
    y += 12;
    const legend: [string, string][] = [
      ['#7ee08a', 'Tire: +1 life'], ['#5ad7ff', 'Nitro boost'], ['#a98bff', 'Shield'],
      ['#ffd84a', '2× points'], ['#ff8fd8', 'Star: invincible'], ['#ff9a3c', 'Jets: fly over'],
    ];
    legend.forEach(([c, s], i) => {
      const lx = cx - 124 + (i % 2) * 136, ly = y + Math.floor(i / 2) * 22;
      dot(g, lx + 5, ly, 5, c);
      text(g, s, lx + 16, ly + 1, `13px ${BODY}`, MUTED, 'left', 'middle');
    });
    y += 3 * 22 + 12;
    button(g, 'Drive', cx, y);
    y += 50 + 30;
    text(g, 'Tap either side, use the arrow buttons or ← →', cx, y, `12px ${BODY}`, MUTED, 'center');
    if (best) text(g, 'Best ' + best.toLocaleString(), cx, y + 20, `12px ${BODY}`, MUTED, 'center');
  }

  function drawOver(g: CanvasRenderingContext2D) {
    panelBg(g);
    const cx = VW / 2;
    let y = Math.max(220, safeTopW() + 80);
    text(g, 'Out of tires!', cx, y, `26px ${DISPLAY}`, INK, 'center'); y += 34;
    for (const l of wrap(g, overMsg, 230, `15px ${BODY}`)) { text(g, l, cx, y, `15px ${BODY}`, MUTED, 'center'); y += 22; }
    y += 44;
    text(g, finalScore.toLocaleString(), cx, y, `48px ${DISPLAY}`, LANE, 'center'); y += 28;
    if (isBest) { text(g, 'NEW BEST', cx, y, `800 12px ${BODY}`, SUN, 'center'); y += 22; }
    if (best) { text(g, 'Best ' + best.toLocaleString(), cx, y, `12px ${BODY}`, MUTED, 'center'); y += 22; }
    // in POW!BOX the host's sheet offers Play again (it sends resume); standalone needs its own button
    if (!hosted) button(g, 'Drive again', cx, y + 10);
  }

  function drawUi() {
    const g = uctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, ui.width, ui.height);
    g.setTransform(dpr * S, 0, 0, dpr * S, dpr * fx, dpr * fy);
    if (state === 'menu') drawMenu(g);
    else { drawHud(g); if (state === 'over') drawOver(g); else drawSteer(g); }
  }

  // ---------- input ----------
  const inside = (r: Rect, x: number, y: number) => r.w > 0 && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { moveLane(-1); pressedL = t + .12; e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { moveLane(1); pressedR = t + .12; e.preventDefault(); }
    else if ((e.key === ' ' || e.key === 'Enter') && (state === 'menu' || (state === 'over' && !hosted))) { startRun(); e.preventDefault(); }
  });
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left - fx) / S, y = (e.clientY - r.top - fy) / S;
    if (state !== 'menu' && inside(fxBtn, x, y)) { fxOn = !fxOn; return; }
    if (state === 'menu') { startRun(); return; }
    if (state === 'over') { if (!hosted && t - overAt > .4) startRun(); return; }
    if (state !== 'play') return;
    // the arrow buttons sit in the matching halves, so a tap anywhere on a side steers that way
    const dir = x < VW / 2 ? -1 : 1;
    if (dir < 0) pressedL = t + .12; else pressedR = t + .12;
    moveLane(dir);
  });

  // ---------- WebGL2 composite with the post-processing pass ----------
  const GLSL_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3. : -1., gl_VertexID == 2 ? 3. : -1.);
  gl_Position = vec4(p, 0., 1.);
  vUv = vec2((p.x + 1.) * .5, 1. - (p.y + 1.) * .5);
}`;
  const GLSL_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D tex;
uniform vec2 res; uniform float time, speed, crash, intensity, motion, night; uniform vec2 car, hit;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 S(vec2 uv) { return texture(tex, clamp(uv, 0., 1.)).rgb; }
void main() {
  vec2 uv = vUv;
  float t = time, sp = speed, m = motion, k = intensity;
  float aspect = res.x / res.y;
  if (crash > 0.) {
    vec2 d = (uv - hit) * vec2(aspect, 1.);
    float r = length(d);
    float ring = smoothstep(.07, 0., abs(r - crash * .9)) * (1. - crash);
    uv -= normalize(d + 1e-5) * ring * .04 * m;
  }
  uv.x += sin(uv.y * 42. + t * 7.) * .0008 * sp * m;
  vec2 rel = (uv - car) * vec2(aspect, 1.);
  float carMask = smoothstep(.05, .13, length(rel));
  vec2 dir = vec2((uv.x - .5) * .35, 1.);
  float blur = .016 * sp * sp * m * carMask;
  vec3 col = vec3(0.);
  for (int i = 0; i < 8; i++) col += S(uv - dir * blur * (float(i) / 7.));
  col /= 8.;
  float hitKick = crash > 0. ? (1. - crash) * .012 : 0.;
  vec2 off = (uv - .5) * (.0015 + .004 * sp + hitKick) * m * k;
  col.r = mix(col.r, S(uv + off).r, .75);
  col.b = mix(col.b, S(uv - off).b, .75);
  vec3 bloom = vec3(0.);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * .5236;
    for (int j = 1; j < 3; j++) {
      vec3 s = S(uv + vec2(cos(a), sin(a) * aspect) * (float(j) * .013));
      bloom += max(s - .6, 0.);
    }
  }
  col += bloom / 24. * 2.8 * k;
  float fwd = -rel.y, side = abs(rel.x);
  float beam = smoothstep(.03, 0., side - fwd * .3) * smoothstep(.45, .05, fwd) * step(.03, fwd);
  col += vec3(1., .9, .65) * beam * (.02 + .12 * night) * k;
  float colId = floor(uv.x * 90.);
  float h = hash(vec2(colId, 3.));
  float f = fract(uv.y * .8 - t * (1.2 + h * 1.6) * (.4 + sp) + h * 7.);
  float edge = smoothstep(.28, .48, abs(uv.x - .5));
  col += vec3(1., .86, .7) * smoothstep(.75, 1., f) * step(.88, h) * edge * sp * sp * .35 * m * k;
  float lum = dot(col, vec3(.299, .587, .114));
  col = mix(col, col * vec3(.9, .84, 1.15), smoothstep(.55, 0., lum) * .5 * k);
  col += vec3(.05, 0., .07) * (1. - lum) * k;
  col = mix(col, col * vec3(1.06, 1., .92), smoothstep(.5, 1., lum) * k);
  col += vec3(1., .4, .35) * (crash > 0. ? smoothstep(.35, 0., crash) : 0.) * .3 * k;
  vec2 q = (uv - .5) * vec2(1.1, .9);
  col *= 1. - dot(q, q) * .95 * k;
  col *= 1. - .035 * k * (.5 + .5 * sin(gl_FragCoord.y * 3.14159));
  col += (hash(gl_FragCoord.xy + vec2(t * 61., t * 17.)) - .5) * .03 * k;
  o = vec4(col, 1.);
}`;
  // plain textured copy: the scene when FX is off, and the premultiplied UI layer on top
  const COPY_FS = `#version 300 es
precision mediump float;
in vec2 vUv; out vec4 o;
uniform sampler2D tex;
void main() { o = texture(tex, vUv); }`;

  type Compositor = { fx: boolean; render(u: Float32Array): void };
  function initWebGL(): Compositor | null {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) return null;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const link = (fs: string) => {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, GLSL_VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
      return prog;
    };
    const copy = link(COPY_FS);
    let fxProg: WebGLProgram | null = null;
    try { fxProg = link(GLSL_FS); } catch (err) { game.error('shader', err instanceof Error ? err.message.slice(0, 200) : 'fx'); }
    gl.bindVertexArray(gl.createVertexArray());
    const mkTex = () => {
      const tx = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tx;
    };
    const sceneTex = mkTex(), uiTex = mkTex();
    const L = fxProg ? Object.fromEntries(['res', 'time', 'speed', 'car', 'crash', 'intensity', 'hit', 'motion', 'night']
      .map(n => [n, gl.getUniformLocation(fxProg!, n)])) as Record<string, WebGLUniformLocation | null> : null;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    return {
      fx: !!fxProg,
      render(u) {
        // backdrop around the 9:16 frame
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(31 / 255, 24 / 255, 48 / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        // scene into the frame rect (GL origin is bottom-left)
        gl.viewport(Math.round(fx * dpr), Math.round((H - fy - fh) * dpr), scene.width, scene.height);
        gl.bindTexture(gl.TEXTURE_2D, sceneTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);
        if (fxProg && L && fxOn) {
          gl.useProgram(fxProg);
          gl.uniform2f(L.res!, u[0]!, u[1]!); gl.uniform1f(L.time!, u[2]!); gl.uniform1f(L.speed!, u[3]!);
          gl.uniform2f(L.car!, u[4]!, u[5]!); gl.uniform1f(L.crash!, u[6]!); gl.uniform1f(L.intensity!, u[7]!);
          gl.uniform2f(L.hit!, u[8]!, u[9]!); gl.uniform1f(L.motion!, u[10]!); gl.uniform1f(L.night!, u[11]!);
        } else gl.useProgram(copy);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // UI layer over everything
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(copy);
        gl.bindTexture(gl.TEXTURE_2D, uiTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ui);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  }

  // Canvas 2D composite when WebGL2 is unavailable: same scene and HUD, no post pass
  function init2d(): Compositor | null {
    const out = canvas.getContext('2d');
    if (!out) return null;
    return {
      fx: false,
      render() {
        out.setTransform(1, 0, 0, 1, 0, 0);
        out.fillStyle = '#1f1830'; out.fillRect(0, 0, canvas.width, canvas.height);
        out.drawImage(scene, Math.round(fx * dpr), Math.round(fy * dpr));
        out.drawImage(ui, 0, 0);
      },
    };
  }

  let fxOn = true;
  resize();
  let gpu: Compositor | null = null;
  try { gpu = initWebGL(); } catch (err) { game.error('webgl', err instanceof Error ? err.message.slice(0, 200) : 'init'); }
  if (!gpu) gpu = init2d();
  const uni = new Float32Array(12);
  function render() {
    uni[0] = scene.width; uni[1] = scene.height; uni[2] = t;
    uni[3] = Math.max(0, Math.min(1.2, (speed - 140) / 560));
    uni[4] = carX / VW; uni[5] = (CAR_Y - lift * 12) / VH;
    uni[6] = hitT >= 0 ? Math.max(0.001, hitT) : 0;
    uni[7] = 1;
    uni[8] = hitPos[0]; uni[9] = hitPos[1];
    uni[10] = reduceMotion ? 0 : 1;
    uni[11] = night;
    gpu?.render(uni);
  }

  // ---------- lifecycle and loop ----------
  game.on('pause', () => { paused = true; game.lifecycle.pause(); });
  game.on('resume', () => {
    paused = false; game.lifecycle.resume();
    if (state === 'over') startRun();          // the host's Play again after game over
  });
  game.on('exit', () => { exited = true; });
  void refreshBest();

  let last = performance.now(), readySent = false;
  function frameLoop(now: number) {
    if (exited) return;
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    if (!paused) update(dt);
    drawScene();
    drawUi();
    render();
    if (!readySent) { readySent = true; game.ready(); }   // the first frame is on screen
    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);
  return game;
}

const canvasEl = document.getElementById('game') as HTMLCanvasElement | null;
if (canvasEl) void start(canvasEl);
