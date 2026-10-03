/**
 * One down, from alignment to whistle.
 *
 * Field frame: z runs 0..120 yards (both end zones included, goal lines at 10
 * and 110), x runs -26.65..26.65 across. The offense always attacks +z; the
 * caller flips possession by mirroring, so no play needs a reversed copy.
 */

import { Player, resolveTackle } from './Player.js';
import {
  OFFENSIVE_FORMATIONS, DEFENSIVE_FORMATIONS, CONCEPTS, COVERAGES, ROUTES,
} from '../data/playbook.js';
import { startersByPosition } from '../data/teams.js';

export const FIELD = {
  length: 120, width: 53.33, halfWidth: 26.665,
  goalLine: { offense: 110, defense: 10 },
};

// Arms-extended reach, not shoulder width: a receiver covers roughly this much
// ground for a ball in the air. The grab gets harder toward the edge of it.
const CATCH_RADIUS = 2.6;
const TACKLE_RADIUS = 1.15;
const RECEIVER_SLOTS = ['a', 'b', 'x', 'y', 'rb'];

export class PlaySim {
  constructor(offenseTeam, defenseTeam) {
    this.offenseTeam = offenseTeam;
    this.defenseTeam = defenseTeam;
    this.offense = [];
    this.defense = [];
    this.state = 'presnap';
    this.clock = 0;
    this.wind = { x: 0, z: 0 };
    this.result = null;
    this.events = [];
    this.qb = null;
    this.carrier = null;
    this.receivers = [];
    this.userDefender = null;
    this.targeted = null;
    this.throwMeter = 0;
  }

  /** Build both sides in their alignments for a called play. */
  setup({ playCall, defenseCall, lineOfScrimmage, ball, wind }) {
    this.offense = [];
    this.defense = [];
    this.events = [];
    this.result = null;
    this.state = 'presnap';
    this.clock = 0;
    this.releasedAt = null;
    this.los = lineOfScrimmage;
    this.ball = ball;
    this.wind = wind;
    this.playCall = playCall;
    this.defenseCall = defenseCall;
    this.concept = CONCEPTS[playCall.concept];
    this.coverage = COVERAGES[defenseCall.coverage];

    const formation = OFFENSIVE_FORMATIONS[playCall.formation];
    const front = DEFENSIVE_FORMATIONS[defenseCall.formation];

    const used = new Map();
    const pick = (team, position) => {
      const group = startersByPosition(team, position);
      const index = used.get(position) ?? 0;
      used.set(position, index + 1);
      return group[Math.min(index, group.length - 1)];
    };

    for (const [position, x, z] of formation.slots) {
      const player = new Player(pick(this.offenseTeam, position), this.offenseTeam, 'offense');
      player.position = { x, z: this.los + z };
      player.alignX = x;
      player.slotPosition = position;
      this.offense.push(player);
    }

    used.clear();
    for (const [position, x, z] of front.slots) {
      const player = new Player(pick(this.defenseTeam, position), this.defenseTeam, 'defense');
      player.position = { x, z: this.los + z };
      player.alignX = x;
      player.slotPosition = position;
      this.defense.push(player);
    }

    this.qb = this.offense.find((p) => p.slotPosition === 'QB');
    this.assignRoutes();
    this.assignCoverage();

    this.carrier = this.qb;
    this.ball.attachTo(this.qb);
    return this;
  }

  /** Eligible receivers get the concept's routes, left to right. */
  assignRoutes() {
    // Receivers take the concept's routes in order, but a concept lists its
    // downfield routes first, so split ends and tight ends are read before the
    // backs. Sorting purely by alignment hands a post to the running back.
    const rank = (p) => (p.slotPosition === 'RB' || p.slotPosition === 'FB' ? 1 : 0);
    const eligible = this.offense
      .filter((p) => ['WR', 'TE', 'RB', 'FB'].includes(p.slotPosition))
      .sort((a, b) => rank(a) - rank(b) || a.alignX - b.alignX);

    this.receivers = eligible.slice(0, RECEIVER_SLOTS.length);
    this.receivers.forEach((player, index) => {
      const routeName = this.concept.routes[index] ?? 'checkdown';
      const builder = ROUTES[routeName] ?? ROUTES.checkdown;
      const side = player.alignX >= 0 ? 1 : -1;
      player.routeName = routeName;
      player.icon = RECEIVER_SLOTS[index];
      player.role = routeName === 'block' ? 'block' : 'route';
      player.waypoint = 0;
      player.assignment = builder(side).map(([dx, dz]) => ({
        x: player.position.x + dx,
        z: player.position.z + dz,
      }));
    });

    for (const player of this.offense) {
      if (['LT', 'LG', 'C', 'RG', 'RT'].includes(player.slotPosition)) player.role = 'protect';
    }
    if (this.concept.type === 'run') {
      const back = this.offense.find((p) => p.slotPosition === 'RB') ?? this.qb;
      back.role = 'runner';
      back.assignment = { gap: this.concept.gap ?? 0 };
    }
  }

  /** Rushers, man assignments and zone landmarks for the called coverage. */
  assignCoverage() {
    const rushers = this.defense
      .filter((p) => ['DE', 'DT', 'NT'].includes(p.slotPosition))
      .slice(0, this.coverage.rush);

    const blitzers = this.defense.filter((p) =>
      (this.coverage.blitz ?? []).includes(p.slotPosition)).slice(0, Math.max(0, this.coverage.rush - rushers.length));

    for (const player of [...rushers, ...blitzers]) player.role = 'rush';

    const cover = this.defense.filter((p) => p.role !== 'rush');

    if (this.coverage.man) {
      const targets = [...this.receivers].sort((a, b) => a.alignX - b.alignX);
      const defenders = [...cover].sort((a, b) => a.alignX - b.alignX);
      defenders.forEach((defender, index) => {
        if (index < targets.length) {
          defender.role = 'man';
          defender.assignment = targets[index];
        } else {
          // Spare bodies play centre field rather than standing still.
          defender.role = 'zone';
          defender.assignment = { x: 0, z: this.los + 16, radius: 11 };
        }
      });
    } else {
      const zones = this.coverage.zones ?? [];
      cover.forEach((defender, index) => {
        const [x, depth] = zones[index % zones.length];
        defender.role = 'zone';
        defender.assignment = { x, z: this.los + depth, radius: 7.5 };
      });
    }
  }

  snap() {
    if (this.state !== 'presnap') return;
    this.state = 'live';
    this.clock = 0;
    this.events.push({ t: 0, type: 'snap' });
  }

  /** Receivers the user can throw to, with their icon letters. */
  get targets() {
    return this.receivers.filter((r) => r.role === 'route');
  }

  /** Yards to the nearest defender: how open a receiver actually is. */
  separation(receiver) {
    let best = Infinity;
    for (const defender of this.defense) {
      if (defender.role === 'rush') continue;
      const d = defender.distanceTo(receiver);
      if (d < best) best = d;
    }
    return best;
  }

  /** The read: most open man, with a nudge toward throws that gain ground. */
  bestTarget() {
    let pick = null;
    let bestScore = -Infinity;
    for (const receiver of this.targets) {
      const downfield = receiver.position.z - this.los;
      const score = this.separation(receiver) * 1.6 + downfield * 0.35;
      if (score > bestScore) { bestScore = score; pick = receiver; }
    }
    return pick;
  }

  update(dt, control) {
    if (this.state === 'dead') return;
    this.clock += dt;

    if (this.state === 'presnap') {
      for (const player of [...this.offense, ...this.defense]) player.brake(dt);
      this.ball.step(dt, this.wind);
      return;
    }

    this.updateRoutes(dt);
    this.updateProtection(dt);
    this.updateRush(dt);
    this.updateCoverage(dt);
    this.updateCarrier(dt, control);
    this.updateQb(dt, control);

    for (const player of [...this.offense, ...this.defense]) player.integrate(dt);
    this.clampToField();

    this.ball.step(dt, this.wind);
    this.checkCatch();
    this.checkTackle();
    this.checkBoundsAndScore();
  }

  updateRoutes(dt) {
    const landing = this.ball.live ? this.ball.predictLanding(this.wind) : null;

    for (const player of this.receivers) {
      if (player.role !== 'route' || player === this.carrier) continue;

      // Ball in the air to him: break off the route and go get it.
      if (landing && player === this.targeted) {
        player.seek(landing, dt, true);
        continue;
      }
      const path = player.assignment;
      if (!Array.isArray(path) || player.waypoint >= path.length) {
        // Route run out: keep working back toward the quarterback.
        player.seek({ x: player.position.x, z: player.position.z + 1.2 }, dt, true);
        continue;
      }
      const target = path[player.waypoint];
      const distance = player.seek(target, dt, true);
      if (distance < 1.4) player.waypoint += 1;
    }
  }

  updateProtection(dt) {
    const rushers = this.defense.filter((p) => p.role === 'rush' && !p.down);
    const linemen = this.offense.filter((p) => p.role === 'protect');

    for (const blocker of linemen) {
      let nearest = null;
      let best = Infinity;
      for (const rusher of rushers) {
        const d = blocker.distanceTo(rusher);
        if (d < best) { best = d; nearest = rusher; }
      }
      if (!nearest) { blocker.brake(dt); continue; }

      // Sit between the rusher and the quarterback rather than chasing him.
      const anchor = this.qb ? this.qb.position : { x: 0, z: this.los - 5 };
      const mid = {
        x: nearest.position.x * 0.78 + anchor.x * 0.22,
        z: nearest.position.z * 0.78 + anchor.z * 0.22,
      };
      blocker.seek(mid, dt, false);

      if (best < 1.9) {
        // Contest: pass block against block shedding, with strength as tiebreak.
        const win = (blocker.data.pbk + blocker.data.str * 0.4) /
          (blocker.data.pbk + blocker.data.str * 0.4 + nearest.data.bsh + nearest.data.str * 0.4);
        if (Math.random() < win) nearest.blocked = Math.max(nearest.blocked, 0.55);
      }
    }
  }

  updateRush(dt) {
    if (!this.qb) return;
    for (const rusher of this.defense) {
      if (rusher.role !== 'rush' || rusher.down) continue;
      const aim = this.carrier ? this.carrier.position : this.qb.position;
      rusher.seek(aim, dt, true);
    }
  }

  updateCoverage(dt) {
    for (const defender of this.defense) {
      if (defender.down || defender.role === 'rush') continue;

      // Ball in the air: everyone nearby breaks on it.
      if (this.ball.live) {
        // Recognition buys reaction time, it does not grant clairvoyance: a
        // defender cannot break on a ball before he has seen it thrown.
        const reaction = 0.42 - (defender.data.prc / 100) * 0.22;
        const sinceThrow = this.clock - (this.throwAt ?? this.clock);
        if (sinceThrow > reaction) {
          const landing = this.ball.predictLanding(this.wind);
          const d = Math.hypot(landing.x - defender.position.x, landing.z - defender.position.z);
          if (d < 8 + (defender.data.prc / 100) * 9) {
            defender.seek(landing, dt, true);
            continue;
          }
        }
      }

      if (this.carrier && this.carrier !== this.qb) {
        defender.seek(this.pursuitPoint(defender, this.carrier), dt, true);
        continue;
      }

      if (defender.role === 'man' && defender.assignment) {
        const target = defender.assignment;
        // Trail with inside leverage, depth based on man coverage rating.
        const cushion = 0.9 + (1 - defender.data.mcv / 100) * 1.8;
        defender.seek({
          x: target.position.x + Math.sign(target.position.x || 1) * -0.5,
          z: target.position.z - cushion,
        }, dt, true);
      } else if (defender.role === 'zone' && defender.assignment) {
        const spot = defender.assignment;
        // Drop to the landmark, then squeeze the nearest threat inside it.
        let threat = null;
        let best = spot.radius;
        for (const receiver of this.receivers) {
          if (receiver.role !== 'route') continue;
          const d = Math.hypot(receiver.position.x - spot.x, receiver.position.z - spot.z);
          if (d < best) { best = d; threat = receiver; }
        }
        const aim = threat
          ? { x: (threat.position.x + spot.x) / 2, z: (threat.position.z + spot.z) / 2 }
          : spot;
        defender.seek(aim, dt, Boolean(threat));
      }
    }
  }

  /** Lead the carrier by his own speed, which is what a pursuit angle is. */
  pursuitPoint(defender, carrier) {
    const gap = defender.distanceTo(carrier);
    const lead = Math.min(1.6, gap / Math.max(4, defender.maxSpeed)) * (defender.data.pur / 100);
    return {
      x: carrier.position.x + carrier.velocity.x * lead,
      z: carrier.position.z + carrier.velocity.z * lead,
    };
  }

  updateQb(dt, control) {
    if (!this.qb || this.carrier !== this.qb || this.qb.down) return;

    if (this.concept.type === 'run' && !this.concept.qbKeep) {
      const back = this.offense.find((p) => p.role === 'runner');
      if (back && this.clock > 0.55) {
        this.carrier = back;
        this.ball.attachTo(back);
        back.role = 'carrier';
        this.events.push({ t: this.clock, type: 'handoff' });
      }
      return;
    }

    const dropDepth = this.concept.depth ?? 5;
    const spot = this.los - dropDepth;
    if (this.qb.position.z > spot + 0.4 && !control.move) {
      this.qb.seek({ x: this.qb.position.x, z: spot }, dt, false);
    } else if (control.move) {
      this.qb.drive(control.moveX, control.moveZ, dt, control.sprint);
    } else {
      this.qb.brake(dt);
    }
  }

  updateCarrier(dt, control) {
    if (!this.carrier || this.carrier === this.qb || this.carrier.down) return;
    if (control.move) this.carrier.drive(control.moveX, control.moveZ, dt, control.sprint);
    else this.carrier.brake(dt);
  }

  /** Throw to an icon. `power` 0..1 from how long the button was held. */
  throwTo(icon, power, lead = { x: 0, z: 0 }) {
    if (this.state !== 'live' || this.carrier !== this.qb || this.ball.live) return null;
    const receiver = this.receivers.find((r) => r.icon === icon && r.role === 'route');
    if (!receiver) return null;

    // Lead the receiver by the flight time the ball will actually take. One
    // correction pass is enough: the time changes little once the aim moves.
    let flight = Math.max(0.45, this.qb.distanceTo(receiver) / 22);
    let aim = { x: receiver.position.x, z: receiver.position.z };
    for (let pass = 0; pass < 2; pass += 1) {
      aim = {
        x: receiver.position.x + receiver.velocity.x * flight + lead.x * 6,
        z: receiver.position.z + receiver.velocity.z * flight + lead.z * 6,
      };
      flight = Math.max(0.4, Math.hypot(aim.x - this.qb.position.x, aim.z - this.qb.position.z) / 22);
    }

    const accuracy = power > 0.75 ? this.qb.data.tad : power > 0.4 ? this.qb.data.tam : this.qb.data.tas;
    const onRun = this.qb.speed > 2.5 ? (this.qb.data.tor - 100) * 0.25 : 0;
    const info = this.ball.throwTo(this.qb.position, aim, power, Math.max(35, accuracy + onRun), this.wind);

    this.targeted = receiver;
    this.releasedAt = { x: this.qb.position.x, z: this.qb.position.z };
    this.throwAt = this.clock;
    this.carrier = null;
    this.events.push({ t: this.clock, type: 'pass', icon, power, distance: info.distance });
    return info;
  }

  checkCatch() {
    // An uncatchable ball still has to kill the down, or the play runs forever.
    if (!this.ball.live && this.ball.landed && !this.carrier && this.state === 'live') {
      this.events.push({ t: this.clock, type: 'incomplete' });
      this.end({ kind: 'incomplete', at: this.los });
      return;
    }
    if (!this.ball.live || this.ball.position.y > 4.5) return;

    // A throw leaves the hand below head height, so without this the nearest
    // lineman catches it on the release frame.
    if (this.releasedAt) {
      const travelled = Math.hypot(
        this.ball.position.x - this.releasedAt.x,
        this.ball.position.z - this.releasedAt.z,
      );
      if (travelled < 3.5) return;
    }

    const contenders = [...this.offense, ...this.defense].filter((p) => !p.down && p.role !== 'protect');
    let best = null;
    let bestDistance = CATCH_RADIUS;

    for (const player of contenders) {
      const d = Math.hypot(
        this.ball.position.x - player.position.x,
        this.ball.position.z - player.position.z,
      );
      if (d < bestDistance) { bestDistance = d; best = player; }
    }
    if (!best) return;

    const isTarget = best === this.targeted;
    const skill = best.side === 'offense' ? best.data.cth : (best.data.cth + best.data.zcv) / 2;

    // A defender in position usually knocks it down; picking it cleanly is the
    // exception, which is why real interception rates sit near 2-3%.
    if (best.side === 'defense' && Math.random() > 0.17) {
      this.ball.live = false;
      this.ball.landed = true;
      this.events.push({ t: this.clock, type: 'pass-defended', by: best.data.name });
      this.end({ kind: 'incomplete', at: this.los });
      return;
    }
    // A contested ball is harder; a defender picking one off is harder still.
    // A ball in the breadbasket is routine; one at full stretch is not.
    const stretch = 1 - (bestDistance / CATCH_RADIUS) * 0.45;
    const chance = (skill / 100) * (isTarget ? 0.97 : 0.58) *
      (best.side === 'offense' ? 1 : 0.85) * stretch;

    if (Math.random() < chance) {
      this.ball.attachTo(best);
      this.carrier = best;
      best.role = 'carrier';
      if (best.side === 'defense') {
        this.events.push({ t: this.clock, type: 'interception', by: best.data.name });
        this.end({ kind: 'interception', by: best, at: best.position.z });
      } else {
        this.events.push({ t: this.clock, type: 'catch', by: best.data.name });
      }
    } else if (bestDistance < 1.4) {
      this.ball.live = false;
      this.ball.landed = true;
      this.events.push({ t: this.clock, type: 'incomplete' });
      this.end({ kind: 'incomplete', at: this.los });
    }
  }

  checkTackle() {
    if (!this.carrier || this.carrier.down) return;
    for (const defender of this.defense) {
      if (defender.down || defender.blocked > 0) continue;
      if (defender.distanceTo(this.carrier) > TACKLE_RADIUS) continue;

      const outcome = resolveTackle(this.carrier, defender, defender.hitStick === true);
      if (outcome.tackled) {
        this.carrier.down = true;
        const sack = this.carrier === this.qb && this.concept.type === 'pass';
        this.events.push({ t: this.clock, type: sack ? 'sack' : 'tackle', by: defender.data.name });
        this.end({
          kind: outcome.fumble ? 'fumble' : sack ? 'sack' : 'tackle',
          at: this.carrier.position.z,
          by: defender,
        });
        return;
      }
      // Broken tackle: the defender is shed and out of the play for a beat.
      defender.blocked = 0.5;
    }
  }

  checkBoundsAndScore() {
    if (!this.carrier || this.state === 'dead') return;
    const { x, z } = this.carrier.position;

    if (Math.abs(x) > FIELD.halfWidth) {
      this.end({ kind: 'out-of-bounds', at: z });
    } else if (z >= FIELD.goalLine.offense) {
      this.events.push({ t: this.clock, type: 'touchdown' });
      this.end({ kind: 'touchdown', at: FIELD.goalLine.offense });
    } else if (z <= FIELD.goalLine.defense) {
      this.end({ kind: 'safety', at: z });
    }
  }

  clampToField() {
    for (const player of [...this.offense, ...this.defense]) {
      player.position.x = Math.max(-FIELD.halfWidth - 3, Math.min(FIELD.halfWidth + 3, player.position.x));
      player.position.z = Math.max(0, Math.min(FIELD.length, player.position.z));
    }
  }

  end(result) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.result = { ...result, elapsed: this.clock };
  }
}
