# Gridiron Engine

A browser American football game: procedural stadium and players, a deterministic
fixed-step simulation, route concepts and coverage AI, and native Gamepad API control.

```sh
npm install
npm run dev     # http://127.0.0.1:5174
```

Keyboard: `WASD` move, `Space` snap, hold `J`/`K`/`L`/`I` to throw (hold length picks
lob / touch / bullet), `Shift` sprint, `C` camera, arrows to pick a play. Plug in an
Xbox or DualSense pad and it switches over automatically.

## How it works

- **Fixed 120 Hz simulation**, decoupled from rendering, with interpolation. Physics is
  frame-rate independent and reproducible.
- **Momentum-based locomotion** driven by player attributes: a 94 SPD corner really does
  run down an 82 SPD tight end, and a hard cut costs speed.
- **Aerodynamic ball flight** with quadratic drag, Magnus lift from the spiral, wind
  drift and an oval bounce model.
- **Coverage AI**: man with leverage and cushion, zone with landmarks and threat
  recognition, pursuit angles that lead the carrier by his own velocity.
- **Procedural everything** — no authored art. The stadium, crowd, turf markings and
  player figures are generated from team colours.

## A note on the teams

The 32 clubs are fictional. Real league nicknames and marks are licensed, and inventing
attribute lines for real players would be making up facts about them. The data schema in
`src/data/teams.js` is the one the engine wants, so another source drops straight in.

## Layout

```
src/core/Input.js        gamepad + keyboard, polled per frame
src/sim/Player.js        locomotion, tackling, fatigue
src/sim/Ball.js          flight, bounce, carry
src/sim/Play.js          one down: formation, routes, coverage, rush, whistle
src/data/playbook.js     7 formations, 14 concepts, 5 fronts, 8 coverages
src/graphics/            stadium, procedural player meshes
```
