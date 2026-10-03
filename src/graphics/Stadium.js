/**
 * Procedural stadium: field, markings, bowl, crowd, lights and sky.
 *
 * World axes match the simulation exactly, and that matters more than it
 * sounds: world X is across the field (53.3 yards), world Z is downfield (120
 * yards). Building the turf the other way round leaves the players running
 * perpendicular to the pitch.
 *
 * World Z is centred on midfield, so simulation z (0..120) renders at z - 60.
 */

import * as THREE from 'three';
import { FIELD } from '../sim/Play.js';

/** Canvas is drawn with the field running top-to-bottom, matching world Z. */
function makeFieldTexture(primary, secondary) {
  const height = 2048;
  const width = Math.round(height * (FIELD.width / FIELD.length));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const pxPerYard = height / FIELD.length;

  for (let yard = 0; yard < FIELD.length; yard += 5) {
    ctx.fillStyle = (yard / 5) % 2 === 0 ? '#20713a' : '#1a5f30';
    ctx.fillRect(0, yard * pxPerYard, width, 5 * pxPerYard);
  }

  ctx.fillStyle = primary;
  ctx.fillRect(0, 0, width, 10 * pxPerYard);
  ctx.fillRect(0, (FIELD.length - 10) * pxPerYard, width, 10 * pxPerYard);

  ctx.strokeStyle = 'rgba(255,255,255,0.94)';
  ctx.fillStyle = 'rgba(255,255,255,0.94)';

  for (let yard = 10; yard <= FIELD.length - 10; yard += 1) {
    const y = yard * pxPerYard;
    if ((yard - 10) % 5 === 0) {
      ctx.lineWidth = (yard - 10) % 10 === 0 ? 6 : 3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    } else {
      for (const fraction of [0.36, 0.64]) ctx.fillRect(width * fraction - 7, y - 1.5, 14, 3);
      ctx.fillRect(4, y - 1.5, 14, 3);
      ctx.fillRect(width - 18, y - 1.5, 14, 3);
    }
  }

  ctx.font = `bold ${Math.round(pxPerYard * 3.6)}px Inter, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let yard = 20; yard <= FIELD.length - 20; yard += 10) {
    const marker = yard - 10 <= 50 ? yard - 10 : 100 - (yard - 10);
    if (marker === 0) continue;
    const y = yard * pxPerYard;
    for (const [x, rotation] of [[width * 0.17, 0], [width * 0.83, Math.PI]]) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.fillText(String(marker), 0, 0);
      ctx.restore();
    }
  }

  // Midfield mark: an outlined ring, not a filled disc.
  ctx.strokeStyle = secondary;
  ctx.lineWidth = pxPerYard * 0.55;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, pxPerYard * 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = secondary;
  ctx.fill();
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** halfX is across the field, halfZ is downfield. */
function ringShape(halfX, halfZ) {
  const shape = new THREE.Shape();
  shape.moveTo(-halfX, -halfZ);
  shape.lineTo(halfX, -halfZ);
  shape.lineTo(halfX, halfZ);
  shape.lineTo(-halfX, halfZ);
  shape.closePath();
  return shape;
}

function buildBowl(scene, team) {
  const group = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x272c36, roughness: 0.96 });
  const halfWidth = FIELD.width / 2;
  const halfLength = FIELD.length / 2;

  for (const deck of [
    { inset: 10, rise: 9, depth: 30, y: 0 },
    { inset: 40, rise: 15, depth: 28, y: 10 },
  ]) {
    const outerX = halfWidth + deck.inset + deck.depth;
    const outerZ = halfLength + deck.inset + deck.depth;
    const shape = ringShape(outerX, outerZ);
    const hole = new THREE.Path();
    hole.moveTo(-(halfWidth + deck.inset), -(halfLength + deck.inset));
    hole.lineTo(halfWidth + deck.inset, -(halfLength + deck.inset));
    hole.lineTo(halfWidth + deck.inset, halfLength + deck.inset);
    hole.lineTo(-(halfWidth + deck.inset), halfLength + deck.inset);
    hole.closePath();
    shape.holes.push(hole);

    const mesh = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: deck.rise, bevelEnabled: false }),
      concrete,
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = deck.y + deck.rise;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const suite = new THREE.Mesh(
    new THREE.BoxGeometry(FIELD.width + 88, 3.6, FIELD.length + 88),
    new THREE.MeshStandardMaterial({
      color: 0x0c1017, emissive: 0x24314a, emissiveIntensity: 0.65, roughness: 0.4,
    }),
  );
  suite.position.y = 13;
  group.add(suite);

  const board = new THREE.Group();
  const screen = new THREE.Mesh(
    new THREE.BoxGeometry(22, 11, 0.6),
    new THREE.MeshStandardMaterial({
      color: 0x05070c, emissive: new THREE.Color(team.colors.primary), emissiveIntensity: 0.5,
    }),
  );
  board.add(screen);
  const back = screen.clone();
  back.position.z = -0.8;
  back.rotation.y = Math.PI;
  board.add(back);
  board.position.set(0, 36, 0);
  group.add(board);

  scene.add(group);
  return group;
}

function buildCrowd(scene) {
  const geometry = new THREE.BoxGeometry(0.85, 1.6, 0.85);
  const material = new THREE.MeshStandardMaterial({ roughness: 1, vertexColors: true });
  const capacity = 11000;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const colors = new Float32Array(capacity * 3);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const seats = [];
  let index = 0;

  for (const ring of [
    { inset: 11, rows: 14, y: 2.5, step: 1.75 },
    { inset: 42, rows: 16, y: 13, step: 1.85 },
  ]) {
    for (let row = 0; row < ring.rows && index < capacity; row += 1) {
      const halfX = FIELD.width / 2 + ring.inset + row * ring.step;
      const halfZ = FIELD.length / 2 + ring.inset + row * ring.step;
      const y = ring.y + row * 1.2;
      const count = Math.min(Math.floor((halfX + halfZ) * 4 / 2.1), capacity - index);

      for (let i = 0; i < count && index < capacity; i += 1) {
        const t = (i / count) * 4;
        let x; let z;
        if (t < 1) { x = -halfX + t * halfX * 2; z = -halfZ; }
        else if (t < 2) { x = halfX; z = -halfZ + (t - 1) * halfZ * 2; }
        else if (t < 3) { x = halfX - (t - 2) * halfX * 2; z = halfZ; }
        else { x = -halfX; z = halfZ - (t - 3) * halfZ * 2; }

        dummy.position.set(x, y, z);
        dummy.rotation.y = Math.atan2(-x, -z);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        // Mostly dark coats with occasional team colour, not a bag of sweets.
        const pop = Math.random() < 0.18;
        color.setHSL(Math.random(), pop ? 0.5 : 0.12, pop ? 0.42 : 0.12 + Math.random() * 0.16);
        color.toArray(colors, index * 3);
        seats.push({ x, y, z, phase: Math.random() * Math.PI * 2 });
        index += 1;
      }
    }
  }

  geometry.setAttribute('color', new THREE.InstancedBufferAttribute(colors, 3));
  mesh.count = index;
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  return { mesh, seats, dummy };
}

function buildGoalPosts(scene) {
  const material = new THREE.MeshStandardMaterial({ color: 0xffc20e, metalness: 0.6, roughness: 0.35 });
  const group = new THREE.Group();

  for (const end of [-1, 1]) {
    const post = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 10, 12), material);
    base.position.y = 5;
    post.add(base);

    const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 6.2, 12), material);
    cross.rotation.z = Math.PI / 2;
    cross.position.y = 10;
    post.add(cross);

    // Uprights spread across the field, which is the X axis here.
    for (const side of [-1, 1]) {
      const upright = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 11, 12), material);
      upright.position.set(side * 3.1, 15.5, 0);
      post.add(upright);
    }
    post.position.set(0, 0, end * (FIELD.length / 2 - 10));
    group.add(post);
  }

  scene.add(group);
  return group;
}

export class Stadium {
  constructor(scene, homeTeam) {
    this.scene = scene;
    this.team = homeTeam;

    this.turf = new THREE.Mesh(
      // width across X, length along Z: the same way round as the simulation.
      new THREE.PlaneGeometry(FIELD.width, FIELD.length),
      new THREE.MeshStandardMaterial({
        map: makeFieldTexture(homeTeam.colors.primary, homeTeam.colors.secondary),
        roughness: 0.9,
      }),
    );
    this.turf.rotation.x = -Math.PI / 2;
    this.turf.receiveShadow = true;
    scene.add(this.turf);

    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD.width + 30, FIELD.length + 34),
      new THREE.MeshStandardMaterial({ color: 0x14301d, roughness: 1 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.03;
    scene.add(apron);

    this.bowl = buildBowl(scene, homeTeam);
    this.crowd = buildCrowd(scene);
    this.posts = buildGoalPosts(scene);

    this.lights = [];
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const light = new THREE.SpotLight(0xfff6e8, 1100, 300, Math.PI / 4.4, 0.5, 1.5);
      light.position.set(x * 52, 68, z * 86);
      light.target.position.set(0, 0, 0);
      light.castShadow = x > 0 && z > 0;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.camera.far = 220;
      scene.add(light, light.target);
      this.lights.push(light);
    }

    // Night sky dome. Without it the world above the rim is pure black, which
    // reads as a hole rather than a stadium at night.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(400, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          horizon: { value: new THREE.Color(0x1d2c4a) },
          zenith: { value: new THREE.Color(0x05070f) },
        },
        vertexShader: `
          varying vec3 vPos;
          void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 horizon;
          uniform vec3 zenith;
          varying vec3 vPos;
          void main() {
            float h = clamp(normalize(vPos).y * 1.6 + 0.12, 0.0, 1.0);
            gl_FragColor = vec4(mix(horizon, zenith, h), 1.0);
          }`,
      }),
    );
    scene.add(sky);

    // Haze above the rim, so the floodlights have something to bite on.
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(190, 150, 90, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2b4d80, transparent: true, opacity: 0.1, side: THREE.BackSide, depthWrite: false,
      }),
    );
    glow.position.y = 45;
    scene.add(glow);

    scene.add(new THREE.HemisphereLight(0x9ec4ff, 0x1d3020, 0.6));
    scene.add(new THREE.AmbientLight(0xffffff, 0.22));
    scene.fog = new THREE.FogExp2(0x0a1222, 0.0018);
  }

  update(time, excitement) {
    const { mesh, seats, dummy } = this.crowd;
    const step = 6;
    const offset = Math.floor(time * 60) % step;
    for (let i = offset; i < seats.length; i += step) {
      const seat = seats[i];
      const bounce = Math.sin(time * (2.2 + excitement * 5) + seat.phase) * (0.08 + excitement * 0.6);
      dummy.position.set(seat.x, seat.y + Math.max(0, bounce), seat.z);
      dummy.rotation.y = Math.atan2(-seat.x, -seat.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}
