/**
 * Gamepad and keyboard input.
 *
 * Polled once per animation frame rather than driven by events, because the
 * Gamepad API hands out a snapshot object per poll and stale snapshots are the
 * usual cause of dropped inputs. Every control is exposed as a named action so
 * gameplay code never touches a button index.
 */

const STICK_DEADZONE = 0.18;
const TRIGGER_THRESHOLD = 0.12;

/** Standard mapping indices, which Chrome and Safari both report for XInput and DualSense. */
const BUTTON = {
  a: 0, b: 1, x: 2, y: 3,
  lb: 4, rb: 5, lt: 6, rt: 7,
  back: 8, start: 9, l3: 10, r3: 11,
  up: 12, down: 13, left: 14, right: 15,
};

const KEY_TO_BUTTON = {
  Space: 'a', KeyJ: 'a',
  KeyK: 'b', KeyL: 'x', KeyI: 'y',
  KeyQ: 'lb', KeyE: 'rb',
  ShiftLeft: 'rt', KeyZ: 'lt',
  Enter: 'start', Escape: 'back',
};

/** Radial deadzone, so a stick on the diagonal is not clipped per-axis. */
function applyDeadzone(x, y) {
  const magnitude = Math.hypot(x, y);
  if (magnitude < STICK_DEADZONE) return { x: 0, y: 0, magnitude: 0 };
  const scaled = (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  const clamped = Math.min(1, scaled);
  return { x: (x / magnitude) * clamped, y: (y / magnitude) * clamped, magnitude: clamped };
}

export class Input {
  constructor() {
    this.pad = null;
    this.padId = '';
    this.keys = new Set();

    this.left = { x: 0, y: 0, magnitude: 0 };
    this.right = { x: 0, y: 0, magnitude: 0 };
    this.triggers = { lt: 0, rt: 0 };

    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.heldFor = new Map();

    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      this.keys.add(event.code);
      if (KEY_TO_BUTTON[event.code] || event.code.startsWith('Arrow')) event.preventDefault();
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('gamepadconnected', (event) => {
      this.padId = event.gamepad.id;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.pad = null;
      this.padId = '';
    });
  }

  get hasPad() {
    return this.pad !== null;
  }

  /** Call once per frame, before gameplay reads anything. */
  poll(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    this.pad = null;
    for (const pad of pads) {
      if (pad && pad.connected) { this.pad = pad; this.padId = pad.id; break; }
    }

    const nextDown = new Set();

    if (this.pad) {
      const [lx = 0, ly = 0, rx = 0, ry = 0] = this.pad.axes;
      this.left = applyDeadzone(lx, ly);
      this.right = applyDeadzone(rx, ry);

      for (const [name, index] of Object.entries(BUTTON)) {
        const button = this.pad.buttons[index];
        if (!button) continue;
        const value = typeof button === 'object' ? button.value : button;
        if (name === 'lt') this.triggers.lt = value;
        if (name === 'rt') this.triggers.rt = value;
        const isDown = name === 'lt' || name === 'rt' ? value > TRIGGER_THRESHOLD : button.pressed;
        if (isDown) nextDown.add(name);
      }
    } else {
      // Keyboard stand-in, so the game is playable and testable without a pad.
      const axis = (negative, positive) =>
        (this.keys.has(negative) ? -1 : 0) + (this.keys.has(positive) ? 1 : 0);
      this.left = applyDeadzone(axis('KeyA', 'KeyD'), axis('KeyW', 'KeyS'));
      this.right = applyDeadzone(axis('ArrowLeft', 'ArrowRight'), axis('ArrowUp', 'ArrowDown'));
      this.triggers.lt = this.keys.has('KeyZ') ? 1 : 0;
      this.triggers.rt = this.keys.has('ShiftLeft') ? 1 : 0;
      for (const [code, name] of Object.entries(KEY_TO_BUTTON)) {
        if (this.keys.has(code)) nextDown.add(name);
      }
    }

    this.pressed.clear();
    this.released.clear();
    for (const name of nextDown) if (!this.down.has(name)) this.pressed.add(name);
    for (const name of this.down) if (!nextDown.has(name)) this.released.add(name);

    for (const name of nextDown) this.heldFor.set(name, (this.heldFor.get(name) ?? 0) + dt);
    for (const name of this.released) this.heldFor.set(name, 0);

    this.down = nextDown;
  }

  isDown(name) { return this.down.has(name); }
  wasPressed(name) { return this.pressed.has(name); }
  wasReleased(name) { return this.released.has(name); }
  holdTime(name) { return this.heldFor.get(name) ?? 0; }

  /**
   * How long a receiver icon was held, which is what separates a lob from a
   * bullet. Returns seconds held at the moment of release.
   */
  releaseHold(name) {
    const held = this.heldFor.get(name) ?? 0;
    this.heldFor.set(name, 0);
    return held;
  }

  rumble(strength = 0.5, duration = 160) {
    const actuator = this.pad?.vibrationActuator;
    if (!actuator?.playEffect) return;
    actuator.playEffect('dual-rumble', {
      startDelay: 0,
      duration,
      weakMagnitude: Math.min(1, strength),
      strongMagnitude: Math.min(1, strength * 0.85),
    }).catch(() => {});
  }
}
