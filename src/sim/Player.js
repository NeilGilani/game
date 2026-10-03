/**
 * A player on the field.
 *
 * Locomotion is momentum-based rather than position-based: a defender carries
 * his speed through a cut, which is what makes separation and pursuit angles
 * mean anything. Attributes feed the limits directly, so a 94 SPD corner really
 * does run down a 82 SPD tight end.
 */

/** 40 SPD jogs at 6.4 yd/s, 99 SPD runs 10.6 — about 21.7 mph. */
function topSpeed(spd) {
  return 6.4 + (spd - 40) * (4.2 / 59);
}

/** Time to reach top speed, 1.9s for a plodder down to 0.75s for a burner. */
function accelRate(acc) {
  return topSpeed(99) / (1.9 - (acc - 40) * (1.15 / 59));
}

/** Radians per second of heading change available at speed. */
function turnRate(agi) {
  return 3.4 + (agi - 40) * (4.6 / 59);
}

export class Player {
  constructor(data, team, side) {
    this.data = data;
    this.team = team;
    this.side = side;              // 'offense' | 'defense'
    this.position = { x: 0, z: 0 };
    this.velocity = { x: 0, z: 0 };
    this.facing = side === 'offense' ? 1 : -1;
    this.heading = side === 'offense' ? Math.PI / 2 : -Math.PI / 2;

    this.role = 'idle';
    this.assignment = null;        // route waypoints, coverage target, gap
    this.waypoint = 0;
    this.engagedWith = null;
    this.blocked = 0;              // seconds left held up by a block
    this.stamina = 100;
    this.down = false;             // tackled / play over for him
    this.celebration = 0;

    this.maxSpeed = topSpeed(data.spd);
    this.accel = accelRate(data.acc);
    this.turn = turnRate(data.agi);
  }

  get isCarrier() { return this.role === 'carrier'; }

  /** Current speed cap, cut by fatigue and by being held up in a block. */
  effectiveSpeed(sprinting) {
    const fatigue = 0.78 + 0.22 * (this.stamina / 100);
    const burst = sprinting ? 1 : 0.86;
    const held = this.blocked > 0 ? 0.25 : 1;
    return this.maxSpeed * fatigue * burst * held;
  }

  /** Steer toward a point, respecting turn rate and acceleration. */
  seek(target, dt, sprinting = false) {
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.05) { this.brake(dt); return distance; }

    const desired = Math.atan2(dz, dx);
    let delta = desired - this.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    // A hard cut costs speed; the sharper the turn the more it costs.
    const maxTurn = this.turn * dt;
    const applied = Math.max(-maxTurn, Math.min(maxTurn, delta));
    this.heading += applied;

    const cutPenalty = 1 - Math.min(0.55, Math.abs(delta) / Math.PI);
    const cap = this.effectiveSpeed(sprinting) * cutPenalty;

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const next = Math.min(cap, speed + this.accel * dt);
    this.velocity.x = Math.cos(this.heading) * next;
    this.velocity.z = Math.sin(this.heading) * next;

    this.drainStamina(dt, sprinting);
    return distance;
  }

  /** Move under a direct stick vector instead of toward a point. */
  drive(dirX, dirZ, dt, sprinting = false) {
    const magnitude = Math.hypot(dirX, dirZ);
    if (magnitude < 0.01) { this.brake(dt); return; }
    // Under direct control the stick is an intent, so give it a sharper turn
    // than a scripted route gets and a close aim point for a quick response.
    const boost = this.turn;
    this.turn *= 1.9;
    this.seek(
      { x: this.position.x + (dirX / magnitude) * 2.2, z: this.position.z + (dirZ / magnitude) * 2.2 },
      dt,
      sprinting,
    );
    this.turn = boost;
  }

  brake(dt) {
    const decay = Math.max(0, 1 - 7 * dt);
    this.velocity.x *= decay;
    this.velocity.z *= decay;
    this.drainStamina(dt, false);
  }

  drainStamina(dt, sprinting) {
    const cost = sprinting ? 7.5 : 2.6;
    const recovery = 4.2 * (this.data.sta / 100);
    const moving = Math.hypot(this.velocity.x, this.velocity.z) > 1.5;
    this.stamina = Math.max(0, Math.min(100,
      this.stamina + (moving ? -cost * dt * (1 - this.data.sta / 240) : recovery * dt)));
  }

  integrate(dt) {
    if (this.down) { this.brake(dt); return; }
    if (this.blocked > 0) this.blocked -= dt;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.facing = Math.cos(this.heading) >= 0 ? 1 : -1;
  }

  distanceTo(other) {
    return Math.hypot(other.position.x - this.position.x, other.position.z - this.position.z);
  }

  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }
}

/**
 * Resolve a tackle attempt. Momentum decides it: mass times closing speed,
 * weighted by the tackler's power and the carrier's ability to shrug it off.
 */
export function resolveTackle(carrier, tackler, hitStick) {
  const closing = Math.hypot(
    carrier.velocity.x - tackler.velocity.x,
    carrier.velocity.z - tackler.velocity.z,
  );

  const force = (tackler.data.weight / 200) * (1 + closing / 9) *
    (tackler.data.tak / 100) * (hitStick ? 1.22 : 1);
  const resist = (carrier.data.weight / 200) * (1 + carrier.speed / 11) *
    ((carrier.data.btk + carrier.data.trk) / 200);

  const chance = force / (force + resist);
  const broke = Math.random() > chance;

  // A big hit on a carrier with poor carrying is how the ball comes loose.
  const fumbleRisk = hitStick
    ? 0.05 + (tackler.data.pow / 100) * 0.07 - (carrier.data.car / 100) * 0.08
    : 0.012 + (tackler.data.pow / 100) * 0.03 - (carrier.data.car / 100) * 0.03;

  return {
    tackled: !broke,
    broke,
    fumble: !broke && Math.random() < Math.max(0, fumbleRisk),
    force: closing,
  };
}
