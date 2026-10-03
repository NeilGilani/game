/**
 * Broadcast overlay: scorebug, play-call sheet and receiver icons.
 *
 * Built as DOM on top of the canvas rather than drawn in WebGL, because text
 * stays crisp at any resolution and the browser handles layout for free.
 */

const CSS = `
.hud { position: fixed; inset: 0; pointer-events: none; font-family: Inter, system-ui, sans-serif; }

.scorebug {
  position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%);
  display: flex; align-items: stretch; border-radius: 8px; overflow: hidden;
  background: rgba(8,12,20,.9); box-shadow: 0 8px 30px rgba(0,0,0,.55);
  font-variant-numeric: tabular-nums; letter-spacing: .02em;
}
.scorebug .club { display: flex; align-items: center; gap: 8px; padding: 9px 14px; font-weight: 700; }
.scorebug .club .abbr { font-size: .86rem; letter-spacing: .12em; }
.scorebug .club .pts { font-size: 1.22rem; }
.scorebug .bar { width: 4px; }
.scorebug .mid {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 6px 18px; background: rgba(255,255,255,.06); min-width: 128px;
}
.scorebug .mid .clock { font-size: 1.1rem; font-weight: 700; }
.scorebug .mid .situation { font-size: .7rem; color: #9fb3d0; letter-spacing: .1em; text-transform: uppercase; }
.scorebug .poss { width: 7px; background: #ffc20e; }

.callsheet {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
  width: min(880px, 92vw); background: rgba(6,10,18,.95); border-radius: 12px;
  padding: 20px 22px; pointer-events: auto; box-shadow: 0 24px 60px rgba(0,0,0,.6);
}
.callsheet h2 { margin: 0 0 4px; font-size: 1rem; letter-spacing: .18em; text-transform: uppercase; }
.callsheet p.hint { margin: 0 0 14px; color: #8fa3c0; font-size: .78rem; }
.callsheet .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.callsheet button {
  pointer-events: auto; text-align: left; padding: 10px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.05); color: #fff;
  font: inherit; font-size: .82rem; line-height: 1.3;
}
.callsheet button.sel { border-color: #ffc20e; background: rgba(255,194,14,.14); }
.callsheet button small { display: block; color: #9fb3d0; font-size: .72rem; margin-top: 2px; }

.icons { position: absolute; left: 50%; bottom: 86px; transform: translateX(-50%); display: flex; gap: 10px; }
.icons .icon {
  width: 34px; height: 34px; border-radius: 50%; display: grid; place-content: center;
  font-weight: 800; font-size: .8rem; background: rgba(8,12,20,.82); border: 2px solid;
}

.toast {
  position: absolute; left: 50%; top: 14%; transform: translateX(-50%);
  background: rgba(8,12,20,.9); padding: 10px 20px; border-radius: 8px;
  font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: .95rem;
}
.controls {
  position: absolute; right: 16px; bottom: 16px; font-size: .68rem; color: #7d8fa8;
  line-height: 1.55; text-align: right;
}
`;

const ICON_COLORS = { a: '#44d07b', b: '#e5484d', x: '#4aa3f0', y: '#f5c518', rb: '#c58af9' };

export class HUD {
  constructor(root) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'hud';
    root.appendChild(this.root);

    this.scorebug = document.createElement('div');
    this.scorebug.className = 'scorebug';
    this.root.appendChild(this.scorebug);

    this.icons = document.createElement('div');
    this.icons.className = 'icons';
    this.root.appendChild(this.icons);

    this.toastEl = null;
    this.sheet = null;
  }

  renderScore(game) {
    const { home, away, state } = game;
    const minutes = Math.floor(state.clock / 60);
    const seconds = Math.floor(state.clock % 60).toString().padStart(2, '0');
    const spot = state.ballOn > 50 ? `OPP ${100 - Math.round(state.ballOn)}` : `OWN ${Math.round(state.ballOn)}`;
    const downs = ['1ST', '2ND', '3RD', '4TH'][state.down - 1] ?? '1ST';
    const toGo = state.distance >= state.ballOn ? 'GOAL' : Math.ceil(state.distance);

    this.scorebug.innerHTML = `
      <div class="bar" style="background:${away.colors.primary}"></div>
      <div class="club"><span class="abbr">${away.abbr}</span><span class="pts">${state.score.away}</span></div>
      <div class="poss" style="visibility:${state.possession === 'away' ? 'visible' : 'hidden'}"></div>
      <div class="mid">
        <span class="clock">${minutes}:${seconds}</span>
        <span class="situation">Q${state.quarter} · ${downs} &amp; ${toGo} · ${spot}</span>
      </div>
      <div class="poss" style="visibility:${state.possession === 'home' ? 'visible' : 'hidden'}"></div>
      <div class="club"><span class="pts">${state.score.home}</span><span class="abbr">${home.abbr}</span></div>
      <div class="bar" style="background:${home.colors.primary}"></div>`;
  }

  renderIcons(receivers) {
    this.icons.innerHTML = receivers.map((receiver) => {
      const color = ICON_COLORS[receiver.icon] ?? '#fff';
      const label = receiver.icon === 'rb' ? 'RB' : receiver.icon.toUpperCase();
      return `<div class="icon" style="border-color:${color};color:${color}"
        title="${receiver.data.name} · ${receiver.routeName}">${label}</div>`;
    }).join('');
  }

  clearIcons() { this.icons.innerHTML = ''; }

  /** Play-call sheet. Resolves with the chosen play. */
  chooseplay(plays, heading, hint) {
    return new Promise((resolve) => {
      const sheet = document.createElement('div');
      sheet.className = 'callsheet';
      sheet.innerHTML = `<h2>${heading}</h2><p class="hint">${hint}</p><div class="grid"></div>`;
      const grid = sheet.querySelector('.grid');

      plays.forEach((play, index) => {
        const button = document.createElement('button');
        button.innerHTML = `${play.concept ?? play.coverage}<small>${play.formation}</small>`;
        if (index === 0) button.classList.add('sel');
        button.addEventListener('click', () => { cleanup(); resolve(play); });
        grid.appendChild(button);
      });

      const buttons = [...grid.querySelectorAll('button')];
      let cursor = 0;
      const move = (delta) => {
        buttons[cursor].classList.remove('sel');
        cursor = (cursor + delta + buttons.length) % buttons.length;
        buttons[cursor].classList.add('sel');
      };
      const onKey = (event) => {
        if (['ArrowRight', 'KeyD'].includes(event.code)) move(1);
        else if (['ArrowLeft', 'KeyA'].includes(event.code)) move(-1);
        else if (['ArrowDown', 'KeyS'].includes(event.code)) move(3);
        else if (['ArrowUp', 'KeyW'].includes(event.code)) move(-3);
        else if (['Space', 'Enter', 'KeyJ'].includes(event.code)) { cleanup(); resolve(plays[cursor]); }
        else return;
        event.preventDefault();
      };

      const cleanup = () => {
        window.removeEventListener('keydown', onKey);
        sheet.remove();
        this.sheet = null;
      };

      window.addEventListener('keydown', onKey);
      this.root.appendChild(sheet);
      this.sheet = { cleanup, move, confirm: () => { cleanup(); resolve(plays[cursor]); } };
    });
  }

  toast(message, ms = 1800) {
    if (this.toastEl) this.toastEl.remove();
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';
    this.toastEl.textContent = message;
    this.root.appendChild(this.toastEl);
    const el = this.toastEl;
    setTimeout(() => { if (el.parentNode) el.remove(); if (this.toastEl === el) this.toastEl = null; }, ms);
  }

  showControls(hasPad) {
    const existing = this.root.querySelector('.controls');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'controls';
    el.innerHTML = hasPad
      ? 'Gamepad connected<br>A snap · hold A/B/X/Y to throw · RT sprint<br>Right stick: juke / truck'
      : 'Keyboard: WASD move · Space snap<br>Hold J / K / L / I to throw · Shift sprint<br>Arrows: play select · C camera';
    this.root.appendChild(el);
  }
}
