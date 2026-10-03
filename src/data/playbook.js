/**
 * Formations, route concepts and coverage shells.
 *
 * Field axes used everywhere in the engine:
 *   x  across the field, positive to the offense's right
 *   z  downfield, positive toward the defense's end zone
 * Alignments are yards relative to the ball, so a play is valid anywhere on
 * the field and gets mirrored by flipping the sign of z elsewhere.
 */

/** Route shapes are waypoints in yards, relative to where the man lines up. */
export const ROUTES = {
  go:        (side) => [[0, 8], [0.5 * side, 24], [0.5 * side, 44]],
  seam:      (side) => [[0, 10], [1.5 * side, 26], [1.5 * side, 42]],
  slant:     (side) => [[0, 2.5], [-5 * side, 8], [-11 * side, 14]],
  drag:      (side) => [[0, 2], [-9 * side, 5], [-20 * side, 7]],
  dig:       (side) => [[0, 11], [-7 * side, 13], [-17 * side, 14]],
  out:       (side) => [[0, 9], [4 * side, 11], [10 * side, 11.5]],
  curl:      (side) => [[0, 11], [-1 * side, 13], [-2 * side, 10]],
  comeback:  (side) => [[0, 14], [1 * side, 16], [4 * side, 12]],
  post:      (side) => [[0, 10], [-5 * side, 20], [-13 * side, 33]],
  corner:    (side) => [[0, 10], [5 * side, 20], [12 * side, 30]],
  flat:      (side) => [[0, 1], [6 * side, 3], [13 * side, 4]],
  wheel:     (side) => [[0, 1], [7 * side, 3], [8 * side, 16], [8 * side, 32]],
  swing:     (side) => [[0, -1], [7 * side, -1.5], [14 * side, 1]],
  screen:    (side) => [[0, -3], [6 * side, -3.5], [11 * side, -1]],
  checkdown: (side) => [[0, 3], [3 * side, 5], [6 * side, 6]],
  block:     () => [],
};

/**
 * Offensive formations. Each slot is [position, x, z] in yards from the ball,
 * listed so index 0 of every position group is the primary option.
 */
export const OFFENSIVE_FORMATIONS = {
  'Singleback Ace': {
    personnel: '11',
    slots: [
      ['QB', 0, -1.5], ['RB', 0, -6], ['C', 0, 0],
      ['LG', -1.8, 0], ['LT', -3.6, 0], ['RG', 1.8, 0], ['RT', 3.6, 0],
      ['TE', 5.4, 0], ['WR', -18, 0], ['WR', 18, 0], ['WR', 12, -1],
    ],
  },
  'Shotgun Spread': {
    personnel: '10',
    slots: [
      ['QB', 0, -5], ['RB', 2.5, -5], ['C', 0, 0],
      ['LG', -1.8, 0], ['LT', -3.6, 0], ['RG', 1.8, 0], ['RT', 3.6, 0],
      ['WR', -20, 0], ['WR', -11, -1], ['WR', 20, 0], ['WR', 11, -1],
    ],
  },
  'Shotgun Trips TE': {
    personnel: '11',
    slots: [
      ['QB', 0, -5], ['RB', -2.5, -5], ['C', 0, 0],
      ['LG', -1.8, 0], ['LT', -3.6, 0], ['RG', 1.8, 0], ['RT', 3.6, 0],
      ['TE', 5.4, 0], ['WR', 20, 0], ['WR', 15, -1], ['WR', -19, 0],
    ],
  },
  'Pistol Strong': {
    personnel: '21',
    slots: [
      ['QB', 0, -3.5], ['RB', 0, -7], ['FB', 2, -5.5], ['C', 0, 0],
      ['LG', -1.8, 0], ['LT', -3.6, 0], ['RG', 1.8, 0], ['RT', 3.6, 0],
      ['TE', 5.4, 0], ['WR', -19, 0], ['WR', 19, 0],
    ],
  },
  'I-Formation Normal': {
    personnel: '21',
    slots: [
      ['QB', 0, -1.5], ['FB', 0, -4.5], ['RB', 0, -7.5], ['C', 0, 0],
      ['LG', -1.8, 0], ['LT', -3.6, 0], ['RG', 1.8, 0], ['RT', 3.6, 0],
      ['TE', 5.4, 0], ['WR', -19, 0], ['WR', 19, 0],
    ],
  },
  'Goal Line 3TE': {
    personnel: '23',
    slots: [
      ['QB', 0, -1.5], ['FB', 0, -4], ['RB', 0, -6.5], ['C', 0, 0],
      ['LG', -1.8, 0], ['LT', -3.6, 0], ['RG', 1.8, 0], ['RT', 3.6, 0],
      ['TE', 5.4, 0], ['TE', -5.4, 0], ['TE', 7.2, -0.5],
    ],
  },
  'Wildcat': {
    personnel: '12',
    slots: [
      ['RB', 0, -5], ['QB', 9, -1], ['FB', -2.5, -5], ['C', 0, 0],
      ['LG', -1.8, 0], ['LT', -3.6, 0], ['RG', 1.8, 0], ['RT', 3.6, 0],
      ['TE', 5.4, 0], ['WR', -19, 0], ['WR', 19, 0],
    ],
  },
};

/**
 * Concepts assign a route to each eligible receiver, read left to right by
 * alignment. `run` concepts hand off instead of dropping back.
 */
export const CONCEPTS = {
  'Four Verticals': { type: 'pass', depth: 7, routes: ['go', 'seam', 'seam', 'go', 'checkdown'] },
  'Mesh':           { type: 'pass', depth: 5, routes: ['drag', 'drag', 'corner', 'curl', 'swing'] },
  'Drive':          { type: 'pass', depth: 5, routes: ['dig', 'drag', 'post', 'flat', 'checkdown'] },
  'Crossers':       { type: 'pass', depth: 7, routes: ['drag', 'dig', 'go', 'drag', 'checkdown'] },
  'Smash':          { type: 'pass', depth: 5, routes: ['curl', 'corner', 'out', 'go', 'flat'] },
  'Stick':          { type: 'pass', depth: 3, routes: ['out', 'curl', 'slant', 'flat', 'checkdown'] },
  'Slant Flat':     { type: 'pass', depth: 3, routes: ['slant', 'flat', 'slant', 'curl', 'checkdown'] },
  'PA Boot Flood':  { type: 'pass', depth: 6, playAction: true, routes: ['corner', 'out', 'flat', 'drag', 'comeback'] },
  'WR Screen':      { type: 'pass', depth: 2, routes: ['screen', 'block', 'block', 'go', 'swing'] },
  'Inside Zone':    { type: 'run', gap: 0, routes: ['block', 'block', 'block', 'block', 'block'] },
  'Outside Zone':   { type: 'run', gap: 6, routes: ['block', 'block', 'block', 'block', 'block'] },
  'Counter GY':     { type: 'run', gap: -5, routes: ['block', 'block', 'block', 'block', 'block'] },
  'HB Dive':        { type: 'run', gap: 1.5, routes: ['block', 'block', 'block', 'block', 'block'] },
  'QB Draw':        { type: 'run', gap: 0, qbKeep: true, routes: ['go', 'go', 'go', 'go', 'go'] },
};

/** Defensive fronts: [position, x, z] with z negative, i.e. behind the ball. */
export const DEFENSIVE_FORMATIONS = {
  '4-3 Over': {
    slots: [
      ['DE', -5, 1], ['DT', -1.8, 1], ['DT', 1.8, 1], ['DE', 5, 1],
      ['OLB', -7, 5], ['MLB', 0, 5.5], ['OLB', 7, 5],
      ['CB', -19, 7], ['CB', 19, 7], ['FS', -6, 14], ['SS', 7, 11],
    ],
  },
  '3-4 Odd': {
    slots: [
      ['DE', -4, 1], ['NT', 0, 1], ['DE', 4, 1],
      ['OLB', -7.5, 2], ['MLB', -2.5, 5.5], ['MLB', 2.5, 5.5], ['OLB', 7.5, 2],
      ['CB', -19, 7], ['CB', 19, 7], ['FS', -5, 14], ['SS', 6, 12],
    ],
  },
  'Nickel 2-4-5': {
    slots: [
      ['DE', -5, 1], ['DT', -1.8, 1], ['DT', 1.8, 1], ['DE', 5, 1],
      ['MLB', -2, 5.5], ['OLB', 3, 5.5],
      ['CB', -19, 7], ['CB', 19, 7], ['CB', 11, 6], ['FS', -6, 14], ['SS', 6, 13],
    ],
  },
  'Dime 1-4-6': {
    slots: [
      ['DE', -5, 1], ['DT', -1.5, 1], ['DE', 5, 1],
      ['OLB', 2, 5.5],
      ['CB', -20, 7], ['CB', 20, 7], ['CB', -11, 6], ['CB', 11, 6],
      ['FS', -6, 15], ['SS', 6, 15], ['MLB', 0, 6],
    ],
  },
  'Goal Line 5-3': {
    slots: [
      ['DE', -6, 1], ['DT', -3, 1], ['NT', 0, 1], ['DT', 3, 1], ['DE', 6, 1],
      ['MLB', -3, 4], ['MLB', 0, 4], ['OLB', 3, 4],
      ['CB', -14, 5], ['CB', 14, 5], ['SS', 0, 8],
    ],
  },
};

/**
 * Coverage shells. `man` assigns defenders to receivers; `zone` gives each a
 * landmark and a radius it is responsible for. `rush` counts pass rushers.
 */
export const COVERAGES = {
  'Cover 1 Hole':  { man: true, rush: 4, deepHelp: 1, hole: true },
  'Cover 2 Tampa': { man: false, rush: 4, zones: [[-13, 18], [13, 18], [0, 24], [-20, 7], [20, 7], [-6, 10], [6, 10]] },
  'Cover 3 Sky':   { man: false, rush: 4, zones: [[-17, 22], [0, 24], [17, 22], [-13, 7], [13, 7], [0, 9], [6, 8]] },
  'Cover 4':       { man: false, rush: 4, zones: [[-19, 20], [-6, 22], [6, 22], [19, 20], [-11, 7], [11, 7], [0, 8]] },
  'Cross Fire':    { man: true, rush: 6, deepHelp: 1, blitz: ['MLB', 'OLB'] },
  'Mid Blitz':     { man: true, rush: 5, deepHelp: 1, blitz: ['MLB'] },
  'Engage Eight':  { man: true, rush: 8, deepHelp: 0, blitz: ['MLB', 'OLB', 'SS'] },
  'Prevent':       { man: false, rush: 3, zones: [[-18, 30], [0, 34], [18, 30], [-10, 16], [10, 16], [0, 14], [0, 8]] },
};

/** Every formation crossed with every legal concept, as a callable list. */
export function buildPlaybook() {
  const plays = [];
  for (const [formationName, formation] of Object.entries(OFFENSIVE_FORMATIONS)) {
    const eligible = formation.slots.filter(([position]) =>
      ['WR', 'TE', 'RB', 'FB'].includes(position)).length;

    for (const [conceptName, concept] of Object.entries(CONCEPTS)) {
      // Heavy sets have nobody to run four verticals with; empty sets cannot
      // run lead concepts. Keep the pairing honest rather than listing junk.
      if (concept.type === 'pass' && eligible < 3 && conceptName !== 'WR Screen') continue;
      if (conceptName === 'Counter GY' && !formation.slots.some(([p]) => p === 'FB' || p === 'TE')) continue;

      plays.push({
        id: `${formationName}::${conceptName}`,
        formation: formationName,
        concept: conceptName,
        type: concept.type,
        label: `${formationName} — ${conceptName}`,
      });
    }
  }
  return plays;
}

export function buildDefensiveCalls() {
  const calls = [];
  for (const formation of Object.keys(DEFENSIVE_FORMATIONS)) {
    for (const coverage of Object.keys(COVERAGES)) {
      calls.push({ id: `${formation}::${coverage}`, formation, coverage, label: `${formation} — ${coverage}` });
    }
  }
  return calls;
}
