/**
 * Entry point: scene, fixed-step simulation, camera work and game flow.
 *
 * The simulation runs on a fixed 120 Hz tick and the renderer interpolates
 * between the last two ticks, so physics stays deterministic and frame-rate
 * independent while motion still looks smooth on a 60 or 144 Hz display.
 */

import * as THREE from 'three';
import { TEAMS } from './data/teams.js';
import { buildPlaybook, buildDefensiveCalls } from './data/playbook.js';
import { PlaySim, FIELD } from './sim/Play.js';
import { Ball } from './sim/Ball.js';
import { Input } from './core/Input.js';
import { Stadium } from './graphics/Stadium.js';
import { PlayerMesh } from './graphics/PlayerMesh.js';
import { HUD } from './ui/HUD.js';

const TICK = 1 / 120;
const CAMERAS = ['broadcast', 'endzone', 'lock'];

class Game {
  constructor() {
    this.home = TEAMS[12];
    this.away = TEAMS[17];
    this.playbook = buildPlaybook();
    this.defensiveCalls = buildDefensiveCalls();

    this.state = {
      quarter: 1,
      clock: 15 * 60,
      down: 1,
      distance: 10,
      ballOn: 25,          // yards from the possessing team's own goal line
      possession: 'away',
      score: { home: 0, away: 0 },
    };

    this.wind = { x: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 };
    this.ball = new Ball();
    this.sim = null;
    this.excitement = 0;
  }

  get offenseTeam() { return this.state.possession === 'home' ? this.home : this.away; }
  get defenseTeam() { return this.state.possession === 'home' ? this.away : this.home; }

  /** Line of scrimmage in world z. The offense always attacks +z. */
  get lineOfScrimmage() { return 10 + this.state.ballOn; }

  startPlay(playCall) {
    const defenseCall = this.chooseDefense();
    this.sim = new PlaySim(this.offenseTeam, this.defenseTeam);
    this.sim.setup({
      playCall,
      defenseCall,
      lineOfScrimmage: this.lineOfScrimmage,
      ball: this.ball,
      wind: this.wind,
    });
    return this.sim;
  }

  /** Defensive AI: call against the situation, not at random. */
  chooseDefense() {
    const { down, distance, ballOn } = this.state;
    const longYardage = distance >= 8;
    const goalLine = ballOn > 92;
    const lateAndDesperate = this.state.quarter >= 4 && this.state.clock < 120;

    let formation = 'Nickel 2-4-5';
    let coverage = 'Cover 3 Sky';

    if (goalLine) { formation = 'Goal Line 5-3'; coverage = 'Cover 1 Hole'; }
    else if (down >= 3 && longYardage) {
      formation = Math.random() < 0.4 ? 'Dime 1-4-6' : 'Nickel 2-4-5';
      coverage = Math.random() < 0.35 ? 'Mid Blitz' : 'Cover 2 Tampa';
    } else if (down <= 2 && distance <= 4) {
      formation = '4-3 Over';
      coverage = Math.random() < 0.5 ? 'Cover 1 Hole' : 'Cover 4';
    } else if (lateAndDesperate && this.trailing()) {
      coverage = 'Cross Fire';
    }

    return this.defensiveCalls.find((call) =>
      call.formation === formation && call.coverage === coverage) ?? this.defensiveCalls[0];
  }

  trailing() {
    const mine = this.state.possession === 'home' ? this.state.score.home : this.state.score.away;
    const theirs = this.state.possession === 'home' ? this.state.score.away : this.state.score.home;
    return mine < theirs;
  }

  /** Apply the outcome of a down: spot the ball, move the chains, score. */
  applyResult(result) {
    const state = this.state;
    state.clock = Math.max(0, state.clock - (result.elapsed + 6));

    const endedAt = Math.max(0, Math.min(100, (result.at ?? this.lineOfScrimmage) - 10));
    const gained = endedAt - state.ballOn;
    let message = '';

    if (result.kind === 'touchdown') {
      state.score[state.possession] += 7;
      message = 'Touchdown';
      this.excitement = 1;
      this.turnover(25, true);
      return message;
    }

    if (result.kind === 'interception') {
      message = 'Intercepted';
      this.excitement = 0.85;
      this.turnover(Math.max(5, Math.min(95, 100 - endedAt)), true);
      return message;
    }

    if (result.kind === 'safety') {
      state.score[state.possession === 'home' ? 'away' : 'home'] += 2;
      message = 'Safety';
      this.turnover(25, true);
      return message;
    }

    if (result.kind === 'fumble') {
      message = 'Fumble, recovered by the defense';
      this.excitement = 0.8;
      this.turnover(Math.max(5, Math.min(95, 100 - endedAt)), true);
      return message;
    }

    state.ballOn = Math.max(1, Math.min(99, endedAt));
    state.distance -= gained;

    if (state.distance <= 0) {
      state.down = 1;
      state.distance = Math.min(10, 100 - state.ballOn);
      message = `First down, ${gained >= 0 ? '+' : ''}${Math.round(gained)}`;
      this.excitement = Math.max(this.excitement, 0.45);
    } else {
      state.down += 1;
      if (state.down > 4) {
        message = 'Turnover on downs';
        this.turnover(Math.max(5, Math.min(95, 100 - state.ballOn)), true);
        return message;
      }
      const label = { incomplete: 'Incomplete', sack: 'Sack', 'out-of-bounds': 'Out of bounds' }[result.kind];
      message = label ?? `${gained >= 0 ? 'Gain of' : 'Loss of'} ${Math.abs(Math.round(gained))}`;
    }

    if (state.clock <= 0) this.advanceQuarter();
    return message;
  }

  turnover(spot, flip) {
    const state = this.state;
    if (flip) state.possession = state.possession === 'home' ? 'away' : 'home';
    state.ballOn = spot;
    state.down = 1;
    state.distance = 10;
    if (state.clock <= 0) this.advanceQuarter();
  }

  advanceQuarter() {
    if (this.state.quarter >= 4) { this.state.quarter = 4; this.state.clock = 0; return; }
    this.state.quarter += 1;
    this.state.clock = 15 * 60;
  }
}

class Renderer {
  constructor(game) {
    this.game = game;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070d18);

    this.camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 900);
    this.camera.position.set(0, 32, -46);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    document.body.appendChild(this.renderer.domElement);

    this.stadium = new Stadium(this.scene, game.home);

    this.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0x6b3410, roughness: 0.6 }),
    );
    this.ballMesh.scale.set(1.5, 1, 1);
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);

    const ringGeometry = new THREE.RingGeometry(0.75, 1.05, 24);
    this.selection = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
    );
    this.selection.rotation.x = -Math.PI / 2;
    this.selection.position.y = 0.06;
    this.selection.visible = false;
    this.scene.add(this.selection);

    this.meshes = new Map();
    this.cameraMode = 0;
    this.lookAt = new THREE.Vector3(0, 1, 0);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /** Rebuild figures when a new play lines up. */
  syncRoster(sim) {
    for (const mesh of this.meshes.values()) this.scene.remove(mesh.group);
    this.meshes.clear();
    if (!sim) return;

    const home = this.game.home;
    for (const entity of [...sim.offense, ...sim.defense]) {
      const isHome = entity.team === home;
      const uniform = isHome ? entity.team.uniforms.home : entity.team.uniforms.away;
      const mesh = new PlayerMesh(entity, uniform);
      this.scene.add(mesh.group);
      this.meshes.set(entity, mesh);
    }
  }

  cycleCamera() {
    this.cameraMode = (this.cameraMode + 1) % CAMERAS.length;
    return CAMERAS[this.cameraMode];
  }

  updateCamera(sim, dt) {
    const focus = sim?.carrier ?? sim?.qb;
    const target = focus
      ? new THREE.Vector3(focus.renderX ?? focus.position.x, 1.4, focus.renderZ ?? focus.position.z)
      : new THREE.Vector3(0, 1.4, this.game.lineOfScrimmage - FIELD.length / 2);

    // The simulation keeps z in 0..120; the world is centred on midfield.
    target.z -= FIELD.length / 2;

    let desired;
    const mode = CAMERAS[this.cameraMode];
    if (mode === 'broadcast') {
      // Low and close enough that a player reads as a player, and angled so
      // "up" on the stick is unambiguously downfield.
      desired = new THREE.Vector3(target.x * 0.55, 11, target.z - 19);
    } else if (mode === 'endzone') {
      desired = new THREE.Vector3(target.x * 0.25, 7, target.z - 22);
    } else {
      desired = new THREE.Vector3(target.x - 1.2, 4, target.z - 6.5);
    }

    // Critically damped follow, so the camera never snaps or overshoots.
    const smoothing = 1 - Math.exp(-dt * 4.5);
    this.camera.position.lerp(desired, smoothing);
    // Aim slightly ahead of the play so you can see what you are running into.
    // Bias the look point downfield so your man sits low in frame with the
    // play ahead of him, rather than centred with nothing to read.
    target.z += 11;
    this.lookAt.lerp(target, 1 - Math.exp(-dt * 7));
    this.camera.lookAt(this.lookAt);
  }

  draw(sim, dt, time) {
    for (const [entity, mesh] of this.meshes) {
      mesh.update(dt, -FIELD.length / 2);
    }

    const controlled = sim?.carrier ?? sim?.qb;
    if (controlled && !controlled.down) {
      this.selection.visible = true;
      this.selection.position.set(
        controlled.renderX ?? controlled.position.x,
        0.06,
        (controlled.renderZ ?? controlled.position.z) - FIELD.length / 2,
      );
    } else {
      this.selection.visible = false;
    }

    const ball = this.game.ball;
    this.ballMesh.position.set(ball.position.x, ball.position.y, ball.position.z - FIELD.length / 2);
    this.ballMesh.rotation.z += dt * ball.spin * 0.9;
    this.ballMesh.rotation.y = Math.atan2(ball.velocity.z, ball.velocity.x);

    this.stadium.update(time, this.game.excitement);
    this.renderer.render(this.scene, this.camera);
  }
}

async function boot() {
  const game = new Game();
  const view = new Renderer(game);
  const input = new Input();
  const hud = new HUD(document.getElementById('overlay'));
  document.getElementById('boot')?.remove();

  hud.showControls(false);
  hud.renderScore(game);

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  let accumulator = 0;
  let last = performance.now();
  let phase = 'calling';
  let throwArmed = false;

  const callNextPlay = async () => {
    phase = 'calling';
    hud.clearIcons();
    const options = game.playbook
      .filter((play) => play.type === (game.state.distance > 6 ? 'pass' : Math.random() < 0.5 ? 'run' : 'pass'))
      .sort(() => Math.random() - 0.5)
      .slice(0, 6);

    const choice = await hud.chooseplay(
      options,
      `${['1st', '2nd', '3rd', '4th'][game.state.down - 1]} & ${Math.ceil(game.state.distance)}`,
      'Arrows or stick to move, Space or A to confirm.',
    );

    const sim = game.startPlay(choice);
    view.syncRoster(sim);
    hud.renderIcons(sim.targets);
    phase = 'presnap';
    throwArmed = false;
  };

  // Exposed for headless inspection; harmless in a browser.
  window.__game = game;

  await callNextPlay();

  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    input.poll(dt);

    const sim = game.sim;

    // Map the stick through the camera's basis. Driving in field coordinates
    // means "right" stops meaning right the moment the camera is not square to
    // the field, which is what makes a player feel like he is fighting you.
    view.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.set(forward.z, 0, -forward.x);

    const stickX = input.left.x;
    const stickZ = -input.left.y;
    const control = {
      move: input.left.magnitude > 0.05,
      moveX: right.x * stickX + forward.x * stickZ,
      moveZ: right.z * stickX + forward.z * stickZ,
      sprint: input.triggers.rt > 0.45,
      aimX: stickX,
      aimZ: stickZ,
    };

    if (input.wasPressed('back')) hud.toast(`Camera: ${view.cycleCamera()}`, 900);
    if (input.keys?.has?.('KeyC')) { /* handled by keydown below */ }

    if (phase === 'presnap' && sim) {
      if (input.wasPressed('a')) { sim.snap(); phase = 'live'; throwArmed = true; }
    }

    if (phase === 'live' && sim) {
      // Hold a receiver icon to load the throw, release to let it go. Hold time
      // picks lob / touch / bullet.
      if (throwArmed && sim.carrier === sim.qb && !game.ball.live) {
        for (const icon of ['a', 'b', 'x', 'y', 'rb']) {
          if (input.wasReleased(icon)) {
            const held = input.releaseHold(icon);
            const power = Math.max(0.15, Math.min(1, held / 0.45));
            const info = sim.throwTo(icon, power, { x: control.aimX, z: control.aimZ });
            if (info) { input.rumble(0.25 + power * 0.4, 120); throwArmed = false; }
          }
        }
      }

      // Hit stick: flick the right stick while on defense contact.
      for (const defender of sim.defense) defender.hitStick = input.right.magnitude > 0.6;
    }

    accumulator += dt;
    let steps = 0;
    while (accumulator >= TICK && steps < 8) {
      if (sim && (phase === 'live' || phase === 'presnap')) {
        for (const entity of [...sim.offense, ...sim.defense]) {
          entity.prevX = entity.position.x;
          entity.prevZ = entity.position.z;
        }
        sim.update(TICK, control);
      }
      accumulator -= TICK;
      steps += 1;
    }

    const alpha = accumulator / TICK;
    if (sim) {
      for (const entity of [...sim.offense, ...sim.defense]) {
        entity.renderX = (entity.prevX ?? entity.position.x) * (1 - alpha) + entity.position.x * alpha;
        entity.renderZ = (entity.prevZ ?? entity.position.z) * (1 - alpha) + entity.position.z * alpha;
      }
    }

    if (sim && sim.state === 'dead' && phase === 'live') {
      phase = 'resolving';
      const message = game.applyResult(sim.result);
      hud.toast(message);
      hud.renderScore(game);
      if (sim.result.kind === 'touchdown') input.rumble(0.9, 420);
      setTimeout(() => { callNextPlay().then(() => hud.renderScore(game)); }, 1700);
    }

    game.excitement = Math.max(0, game.excitement - dt * 0.35);
    view.updateCamera(sim, dt);
    view.draw(sim, dt, now / 1000);
    hud.showControls(input.hasPad);

    requestAnimationFrame(frame);
  };

  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyC') hud.toast(`Camera: ${view.cycleCamera()}`, 900);
  });

  requestAnimationFrame(frame);
}

boot().catch((error) => {
  console.error(error);
  const boot = document.getElementById('boot');
  if (boot) boot.innerHTML = `<h1>Failed to start</h1><p>${error.message}</p>`;
});
