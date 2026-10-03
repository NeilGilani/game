/**
 * Procedural player figures.
 *
 * No rigged art and no motion capture, so the figure is built from primitives
 * and the gait is driven: stride frequency and amplitude come from how fast the
 * entity is actually moving, which is why a player decelerating into a cut
 * shortens his steps on his own.
 */

import * as THREE from 'three';

const SKIN_TONES = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0x6b4226, 0x3b2219];

function numberTexture(jersey, jerseyColor, numberColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = jerseyColor;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = numberColor;
  ctx.font = 'bold 74px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(jersey), 64, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class PlayerMesh {
  constructor(entity, uniform) {
    this.entity = entity;
    this.group = new THREE.Group();
    this.stride = Math.random() * Math.PI * 2;

    const jersey = new THREE.MeshStandardMaterial({
      map: numberTexture(entity.data.jersey, uniform.jersey, uniform.stripe),
      roughness: 0.72,
    });
    const pants = new THREE.MeshStandardMaterial({ color: uniform.pants, roughness: 0.78 });
    const skin = new THREE.MeshStandardMaterial({
      color: SKIN_TONES[entity.data.jersey % SKIN_TONES.length], roughness: 0.68,
    });
    // Helmets are lacquered, so they take a hard specular off the floodlights.
    const helmet = new THREE.MeshStandardMaterial({
      color: uniform.helmet, metalness: 0.42, roughness: 0.18,
    });

    // Proportions scale off the listed height, so a 5'9" back is visibly
    // shorter than a 6'6" tackle.
    const height = entity.data.height / 72;
    const bulk = 0.85 + (entity.data.weight - 180) / 420;

    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32 * bulk, 0.62 * height, 4, 10), jersey);
    this.torso.position.y = 1.18 * height;
    this.torso.castShadow = true;
    this.group.add(this.torso);

    const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.98 * bulk, 0.26, 0.42 * bulk), jersey);
    shoulders.position.y = 1.5 * height;
    shoulders.castShadow = true;
    this.group.add(shoulders);

    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 14, 12), helmet);
    this.head.position.y = 1.78 * height;
    this.head.castShadow = true;
    this.group.add(this.head);

    const mask = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 6, 12, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.7, roughness: 0.35 }));
    mask.position.set(0.14, 1.74 * height, 0);
    mask.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    this.group.add(mask);

    this.limbs = [];
    for (const side of [-1, 1]) {
      // Limbs spread laterally on X; the stride swings them along Z.
      const armX = side * 0.4 * bulk;
      const legX = side * 0.16 * bulk;

      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.52 * height, 3, 7), skin);
      arm.position.set(armX, 1.2 * height, 0);
      arm.castShadow = true;
      this.group.add(arm);

      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.14 * bulk, 0.74 * height, 3, 7), pants);
      leg.position.set(legX, 0.52 * height, 0);
      leg.castShadow = true;
      this.group.add(leg);

      this.limbs.push({ arm, leg, side, armX, legX, armY: 1.2 * height, legY: 0.52 * height });
    }

    this.height = height;
  }

  update(dt, zOffset = 0) {
    const entity = this.entity;
    // Render from the interpolated transform so motion stays smooth even though
    // the simulation runs on a fixed tick.
    const x = entity.renderX ?? entity.position.x;
    const z = entity.renderZ ?? entity.position.z;
    this.group.position.set(x, 0, z + zOffset);

    const speed = entity.speed;
    this.group.rotation.y = -entity.heading + Math.PI / 2;

    if (entity.down) {
      // Dropped: pitch the whole figure over rather than keep him upright.
      this.group.rotation.x = Math.min(Math.PI / 2.1, (this.group.rotation.x || 0) + dt * 6);
      this.group.position.y = -0.35 * this.height;
      return;
    }
    this.group.rotation.x = 0;
    this.group.position.y = 0;

    // Stride frequency rises with speed; amplitude with it, so a walk is a
    // short shuffle and a sprint is a full drive.
    this.stride += dt * (2.2 + speed * 1.45);
    const amplitude = Math.min(0.62, 0.1 + speed * 0.07);
    const lean = Math.min(0.22, speed * 0.022);

    for (const limb of this.limbs) {
      const phase = Math.sin(this.stride + (limb.side > 0 ? 0 : Math.PI));
      // Legs drive fore and aft along Z; arms counter-swing against them.
      limb.leg.position.z = phase * amplitude * 0.8;
      limb.leg.position.y = limb.legY - Math.abs(phase) * amplitude * 0.16;
      limb.leg.rotation.x = phase * amplitude * 0.95;
      limb.arm.position.z = -phase * amplitude * 0.66;
      limb.arm.rotation.x = -phase * amplitude * 0.8;
    }
    // Lean into the run, which is a forward pitch about X.
    this.torso.rotation.x = lean;
    this.head.position.z = lean * 0.45;
  }
}
