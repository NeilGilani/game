/**
 * Football flight.
 *
 * Units are yards and seconds throughout the engine, so gravity is 10.73 yd/s²
 * rather than 9.81. Drag and Magnus are folded into tuned coefficients: the
 * true values depend on the ball's attitude relative to its velocity, which is
 * not tracked, and a spiral holds attitude well enough that a constant is
 * closer than a wrong-by-construction derivation.
 */

const GRAVITY = 10.73;
const DRAG = 0.0094;      // quadratic drag, tuned so a 40-yard throw hangs ~1.9s
const MAGNUS = 0.0021;    // spiral lift, keeps a tight throw flatter than a wobbler
const GROUND_FRICTION = 2.6;
const RESTITUTION = 0.38; // a prolate ball keeps little of its vertical energy

export class Ball {
  constructor() {
    this.position = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.spin = 0;           // rev/s, drives Magnus and the visual roll
    this.live = false;       // in flight, so it can be caught or picked
    this.carrier = null;     // player entity holding it, when not in flight
    this.landed = false;
    this.lastThrow = null;
  }

  attachTo(player) {
    this.carrier = player;
    this.live = false;
    this.landed = false;
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
  }

  /**
   * Launch toward a target. `power` 0..1 picks the trajectory: a lob arcs over
   * the coverage, a bullet is driven flat.
   */
  throwTo(from, target, power, accuracy, wind) {
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const distance = Math.hypot(dx, dz) || 0.0001;

    // Launch angle falls as the throw gets harder: 38° on a touch lob down to
    // 14° on a bullet, which is roughly what the real envelope looks like.
    const angle = (38 - 24 * power) * (Math.PI / 180);
    // Solve the no-drag range equation for speed, then pad for the drag losses.
    const speed = Math.sqrt((distance * GRAVITY) / Math.sin(2 * angle)) * 1.08;

    // Accuracy scatters the aim point; a 99 is nearly on the nose, a 60 sprays.
    const spread = (1 - accuracy / 100) * 0.085;
    const yaw = Math.atan2(dz, dx) + (Math.random() - 0.5) * spread;
    const horizontal = Math.cos(angle) * speed;

    this.carrier = null;
    this.live = true;
    this.landed = false;
    this.position = { x: from.x, y: 1.9, z: from.z };
    this.velocity = {
      x: Math.cos(yaw) * horizontal + wind.x * 0.35,
      y: Math.sin(angle) * speed,
      z: Math.sin(yaw) * horizontal + wind.z * 0.35,
    };
    this.spin = 8 + power * 6;
    this.lastThrow = { distance, power, hangTime: (2 * this.velocity.y) / GRAVITY };
    return this.lastThrow;
  }

  punt(from, direction, power, wind) {
    const angle = (50 - 10 * power) * (Math.PI / 180);
    const speed = 22 + power * 14;
    this.carrier = null;
    this.live = true;
    this.landed = false;
    this.position = { x: from.x, y: 2.2, z: from.z };
    this.velocity = {
      x: direction.x * Math.cos(angle) * speed + wind.x * 0.6,
      y: Math.sin(angle) * speed,
      z: direction.z * Math.cos(angle) * speed + wind.z * 0.6,
    };
    this.spin = 6;
    return { hangTime: (2 * this.velocity.y) / GRAVITY };
  }

  /**
   * Where this ball will come down, by integrating the same forces forward.
   * Receivers and defenders both play the catch point rather than the ball's
   * current position, which is what makes a thrown ball catchable at all.
   */
  predictLanding(wind, horizon = 4) {
    if (!this.live) return { x: this.position.x, z: this.position.z, time: 0 };
    const p = { ...this.position };
    const v = { ...this.velocity };
    const step = 1 / 60;
    let t = 0;
    while (p.y > 1.2 && t < horizon) {
      const rel = { x: v.x - wind.x, y: v.y, z: v.z - wind.z };
      const speed = Math.hypot(rel.x, rel.y, rel.z) || 0.0001;
      const drag = DRAG * speed;
      const lift = MAGNUS * this.spin * speed;
      v.x += -drag * rel.x * step;
      v.z += -drag * rel.z * step;
      v.y += (-GRAVITY - drag * rel.y + lift) * step;
      p.x += v.x * step; p.y += v.y * step; p.z += v.z * step;
      t += step;
    }
    return { x: p.x, z: p.z, time: t };
  }

  step(dt, wind) {
    if (this.carrier) {
      // Carried: ride at hip height just ahead of the runner.
      this.position.x = this.carrier.position.x;
      this.position.z = this.carrier.position.z;
      this.position.y = 1.5;
      return;
    }
    if (!this.live && this.landed) return;

    const relative = {
      x: this.velocity.x - wind.x,
      y: this.velocity.y,
      z: this.velocity.z - wind.z,
    };
    const speed = Math.hypot(relative.x, relative.y, relative.z) || 0.0001;

    // Drag opposes motion through the air and scales with speed squared.
    const drag = DRAG * speed;
    // Magnus acts perpendicular to travel; for a spiral that is mostly lift.
    const lift = MAGNUS * this.spin * speed;

    this.velocity.x += -drag * relative.x * dt;
    this.velocity.z += -drag * relative.z * dt;
    this.velocity.y += (-GRAVITY - drag * relative.y + lift) * dt;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    this.spin = Math.max(0, this.spin - dt * 1.4);

    if (this.position.y <= 0.35) {
      this.position.y = 0.35;
      this.live = false;
      if (Math.abs(this.velocity.y) > 2.2) {
        // Oval bounce: unpredictable sideways kick, which is why loose balls
        // on the turf are worth chasing.
        this.velocity.y = -this.velocity.y * RESTITUTION;
        this.velocity.x = this.velocity.x * 0.6 + (Math.random() - 0.5) * 4;
        this.velocity.z = this.velocity.z * 0.6 + (Math.random() - 0.5) * 4;
      } else {
        this.velocity.y = 0;
        const decay = Math.max(0, 1 - GROUND_FRICTION * dt);
        this.velocity.x *= decay;
        this.velocity.z *= decay;
        if (Math.hypot(this.velocity.x, this.velocity.z) < 0.4) {
          this.velocity.x = this.velocity.z = 0;
          this.landed = true;
        }
      }
    }
  }
}
