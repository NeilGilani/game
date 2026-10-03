/**
 * Team and roster data.
 *
 * The 32 clubs here are fictional: real league nicknames, marks and player
 * ratings are licensed, and inventing attribute lines for real people would be
 * making up facts about them. The schema is the one the engine wants, so
 * dropping in another source is a change to this file and nothing else.
 */

const DIVISIONS = [
  ['AFC', 'East'], ['AFC', 'North'], ['AFC', 'South'], ['AFC', 'West'],
  ['NFC', 'East'], ['NFC', 'North'], ['NFC', 'South'], ['NFC', 'West'],
];

/** city, nickname, primary, secondary, tertiary, venue, roof, surface */
const CLUBS = [
  ['Boston', 'Minutemen', '#0b2545', '#c8102e', '#b0b7bc', 'Harbor Field', 'open', 'grass'],
  ['Buffalo', 'Blizzard', '#00338d', '#c60c30', '#ffffff', 'Lakeshore Park', 'open', 'turf'],
  ['Miami', 'Barracuda', '#008e97', '#f26a24', '#005778', 'Coral Dome', 'retractable', 'grass'],
  ['Newark', 'Ironworks', '#1c1f24', '#8c9196', '#d4a017', 'Foundry Stadium', 'open', 'turf'],

  ['Cleveland', 'Forge', '#311d00', '#ff3c00', '#ffffff', 'Shoreline Bowl', 'open', 'grass'],
  ['Pittsburgh', 'Ironmen', '#101820', '#ffb612', '#c60c30', 'Three Points Field', 'open', 'grass'],
  ['Cincinnati', 'Riverkings', '#fb4f14', '#101820', '#ffffff', 'Riverbend Park', 'open', 'turf'],
  ['Baltimore', 'Harbormen', '#241773', '#9e7c0c', '#000000', 'Inner Harbor Field', 'open', 'grass'],

  ['Houston', 'Wildcatters', '#03202f', '#a71930', '#ffffff', 'Gulf Dome', 'dome', 'turf'],
  ['Nashville', 'Ramblers', '#4b92db', '#002a5c', '#c8102e', 'Cumberland Field', 'open', 'grass'],
  ['Indianapolis', 'Pacesetters', '#002c5f', '#a2aaad', '#ffffff', 'Circle Dome', 'retractable', 'turf'],
  ['Jacksonville', 'Tidewater', '#006778', '#d7a22a', '#101820', 'Atlantic Bowl', 'open', 'grass'],

  ['Kansas City', 'Stampede', '#e31837', '#ffb81c', '#ffffff', 'Prairie Field', 'open', 'grass'],
  ['Denver', 'Summit', '#fb4f14', '#002244', '#ffffff', 'Mile High Park', 'open', 'grass'],
  ['Las Vegas', 'Outlaws', '#101820', '#a5acaf', '#d4a017', 'Desert Dome', 'dome', 'turf'],
  ['San Diego', 'Current', '#0080c6', '#ffc20e', '#002a5e', 'Pacific Field', 'open', 'grass'],

  ['Philadelphia', 'Liberty', '#004c54', '#a5acaf', '#000000', 'Independence Field', 'open', 'grass'],
  ['Dallas', 'Drovers', '#041e42', '#869397', '#ffffff', 'Lone Star Dome', 'retractable', 'turf'],
  ['Washington', 'Sentinels', '#5a1414', '#ffb612', '#ffffff', 'Capitol Field', 'open', 'grass'],
  ['New York', 'Skyline', '#0b2265', '#a71930', '#a5acaf', 'Meadow Park', 'open', 'turf'],

  ['Green Bay', 'Northmen', '#203731', '#ffb612', '#ffffff', 'Frozen Field', 'open', 'grass'],
  ['Chicago', 'Union', '#0b162a', '#c83803', '#ffffff', 'Lakefront Bowl', 'open', 'grass'],
  ['Detroit', 'Motors', '#0076b6', '#b0b7bc', '#000000', 'Assembly Dome', 'dome', 'turf'],
  ['Minneapolis', 'Voyageurs', '#4f2683', '#ffc62f', '#ffffff', 'North Star Dome', 'dome', 'turf'],

  ['Atlanta', 'Peachtree', '#a71930', '#101820', '#a5acaf', 'Southern Dome', 'retractable', 'turf'],
  ['New Orleans', 'Brass', '#d3bc8d', '#101820', '#ffffff', 'Crescent Dome', 'dome', 'turf'],
  ['Tampa', 'Buccaneers Bay', '#d50a0a', '#34302b', '#ff7900', 'Bayshore Field', 'open', 'grass'],
  ['Charlotte', 'Carolinas', '#0085ca', '#101820', '#bfc0bf', 'Queen City Park', 'open', 'grass'],

  ['San Francisco', 'Prospectors', '#aa0000', '#b3995d', '#ffffff', 'Bayview Field', 'open', 'grass'],
  ['Seattle', 'Mariners Point', '#002244', '#69be28', '#a5acaf', 'Sound Field', 'open', 'turf'],
  ['Los Angeles', 'Centurions', '#003594', '#ffd100', '#ffffff', 'Sunset Dome', 'dome', 'turf'],
  ['Phoenix', 'Scorpions', '#97233f', '#000000', '#ffb612', 'Valley Dome', 'retractable', 'grass'],
];

/** Depth chart the engine fills for every club. */
export const DEPTH_CHART = [
  ['QB', 3], ['RB', 4], ['FB', 1], ['WR', 5], ['TE', 3],
  ['LT', 2], ['LG', 2], ['C', 2], ['RG', 2], ['RT', 2],
  ['DE', 4], ['DT', 4], ['NT', 1], ['MLB', 2], ['OLB', 5],
  ['CB', 5], ['FS', 2], ['SS', 2], ['K', 1], ['P', 1],
];

export const ATTRIBUTES = [
  'ovr', 'spd', 'acc', 'str', 'agi', 'awr', 'sta', 'inj',
  'thp', 'tas', 'tam', 'tad', 'tor', 'pac', 'car', 'btk', 'trk', 'elu',
  'spn', 'jke', 'sfa', 'cth', 'rte', 'pbk', 'rbk',
  'tak', 'pow', 'bsh', 'pur', 'prc', 'mcv', 'zcv', 'prs',
];

/**
 * Per-position attribute centres. Anything unlisted falls back to a low
 * baseline, so a tackle does not quietly carry a cornerback's coverage.
 */
const POSITION_PROFILE = {
  QB:  { spd: 76, acc: 78, str: 68, agi: 78, thp: 88, tas: 86, tam: 82, tad: 78, tor: 76, pac: 78, car: 60 },
  RB:  { spd: 91, acc: 92, str: 70, agi: 90, car: 86, btk: 80, trk: 74, elu: 84, spn: 82, jke: 85, sfa: 74, cth: 68, pbk: 52 },
  FB:  { spd: 78, acc: 80, str: 84, agi: 70, car: 78, btk: 76, trk: 84, rbk: 78, cth: 62 },
  WR:  { spd: 93, acc: 93, str: 58, agi: 92, cth: 86, rte: 86, elu: 80, jke: 82, car: 72 },
  TE:  { spd: 82, acc: 83, str: 76, agi: 76, cth: 80, rte: 74, rbk: 70, pbk: 62, btk: 70 },
  LT:  { spd: 62, acc: 64, str: 90, agi: 62, pbk: 88, rbk: 82 },
  LG:  { spd: 60, acc: 62, str: 92, agi: 58, pbk: 82, rbk: 86 },
  C:   { spd: 60, acc: 62, str: 88, agi: 60, pbk: 82, rbk: 82, awr: 82 },
  RG:  { spd: 60, acc: 62, str: 92, agi: 58, pbk: 82, rbk: 86 },
  RT:  { spd: 62, acc: 64, str: 90, agi: 62, pbk: 86, rbk: 82 },
  DE:  { spd: 82, acc: 85, str: 86, agi: 80, tak: 80, pow: 82, bsh: 84, pur: 82 },
  DT:  { spd: 68, acc: 72, str: 94, agi: 64, tak: 80, pow: 84, bsh: 86, pur: 68 },
  NT:  { spd: 62, acc: 66, str: 96, agi: 58, tak: 78, pow: 82, bsh: 88, pur: 62 },
  MLB: { spd: 84, acc: 86, str: 80, agi: 82, tak: 88, pow: 84, pur: 86, prc: 84, zcv: 70, mcv: 62 },
  OLB: { spd: 86, acc: 87, str: 78, agi: 84, tak: 84, pow: 82, bsh: 76, pur: 86, zcv: 68, mcv: 64 },
  CB:  { spd: 94, acc: 94, str: 56, agi: 92, mcv: 86, zcv: 80, prs: 82, tak: 62, pur: 80, cth: 62 },
  FS:  { spd: 90, acc: 90, str: 62, agi: 86, zcv: 86, mcv: 76, prc: 84, pur: 86, tak: 72, cth: 64 },
  SS:  { spd: 88, acc: 88, str: 74, agi: 82, zcv: 80, mcv: 72, tak: 84, pow: 86, pur: 86, prc: 80 },
  K:   { spd: 58, acc: 60, str: 58, agi: 60, thp: 70 },
  P:   { spd: 58, acc: 60, str: 58, agi: 60, thp: 72 },
};

const BASELINE = 45;

/** Deterministic hash-based RNG, so a given seed always rebuilds the league. */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Marcus', 'Deion', 'Tyrell', 'Jalen', 'Cooper', 'Isaiah', 'Rashad', 'Brody', 'Xavier', 'Dominic',
  'Trent', 'Malik', 'Grant', 'Elias', 'Devonte', 'Kai', 'Beau', 'Amari', 'Silas', 'Rowan',
  'Jaxon', 'Terrence', 'Caleb', 'Nico', 'Darnell', 'Emmett', 'Quinn', 'Zane', 'Hollis', 'Ruben'];
const LAST = ['Whitfield', 'Barrow', 'Castellan', 'Mercer', 'Okafor', 'Delgado', 'Vance', 'Prather', 'Ironside',
  'Marchetti', 'Holloway', 'Sandoval', 'Kessler', 'Abara', 'Fontaine', 'Dunbar', 'Royce', 'Mihailov',
  'Teague', 'Nakamura', 'Ellery', 'Boone', 'Cavanaugh', 'Ruiz', 'Lindqvist', 'Asante', 'Pike', 'Garrity'];

/** Bell-ish draw so a roster has stars and scrubs rather than a flat line. */
function around(rng, centre, spread) {
  const roll = (rng() + rng() + rng()) / 3 - 0.5;
  return Math.max(35, Math.min(99, Math.round(centre + roll * spread * 2)));
}

function makePlayer(rng, position, depth, jersey) {
  const profile = POSITION_PROFILE[position] ?? {};
  // Backups sit below the starter, which is what makes a depth chart mean
  // something to the substitution and fatigue code.
  const penalty = depth * 7;
  const player = {
    name: `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`,
    position,
    depth,
    jersey,
    height: 68 + Math.round(rng() * 14),
    weight: 180 + Math.round(rng() * 150),
  };

  for (const key of ATTRIBUTES) {
    if (key === 'ovr') continue;
    const centre = (profile[key] ?? BASELINE) - penalty;
    player[key] = around(rng, centre, key === 'inj' ? 9 : 7);
  }

  player.sta = around(rng, 88 - penalty, 6);
  player.awr = around(rng, (profile.awr ?? 70) - penalty, 8);
  player.inj = around(rng, 82, 10);

  // Overall is the mean of the attributes the position is actually graded on.
  const graded = Object.keys(profile).length ? Object.keys(profile) : ['spd', 'str', 'agi'];
  player.ovr = Math.round(graded.reduce((sum, key) => sum + player[key], 0) / graded.length);
  return player;
}

function buildRoster(rng) {
  const roster = [];
  const taken = new Set();
  const jersey = () => {
    let number;
    do { number = 1 + Math.floor(rng() * 98); } while (taken.has(number));
    taken.add(number);
    return number;
  };

  for (const [position, count] of DEPTH_CHART) {
    for (let depth = 0; depth < count; depth += 1) {
      roster.push(makePlayer(rng, position, depth, jersey()));
    }
  }
  return roster;
}

export const TEAMS = CLUBS.map((club, index) => {
  const [city, nickname, primary, secondary, tertiary, venue, roof, surface] = club;
  const [conference, division] = DIVISIONS[Math.floor(index / 4)];
  const rng = makeRng(0x9e3779b9 ^ (index * 2654435761));
  const roster = buildRoster(rng);

  return {
    id: `${city}-${nickname}`.toLowerCase().replace(/[^a-z]+/g, '-'),
    city,
    nickname,
    abbr: (nickname.slice(0, 3)).toUpperCase(),
    conference,
    division,
    colors: { primary, secondary, tertiary },
    uniforms: {
      home: { jersey: primary, pants: tertiary, helmet: primary, stripe: secondary },
      away: { jersey: '#f2f4f8', pants: tertiary, helmet: primary, stripe: secondary },
      alternate: { jersey: secondary, pants: primary, helmet: secondary, stripe: tertiary },
    },
    stadium: { name: venue, roof, surface, capacity: 62000 + ((index * 1373) % 22000) },
    roster,
    rating: Math.round(
      roster.filter((p) => p.depth === 0).reduce((sum, p) => sum + p.ovr, 0) /
      roster.filter((p) => p.depth === 0).length,
    ),
  };
});

export function teamById(id) {
  return TEAMS.find((team) => team.id === id) ?? TEAMS[0];
}

/** Starters in depth-chart order, which is what the formation code indexes. */
export function startersByPosition(team, position) {
  return team.roster.filter((player) => player.position === position).sort((a, b) => a.depth - b.depth);
}
