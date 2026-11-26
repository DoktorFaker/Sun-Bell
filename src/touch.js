// On-screen controls for phones and tablets (landscape).
// Left half: floating joystick (push to the edge to sprint). Right half: drag to look.
// Buttons: attack (hold = fire), roll (hold = up / brake), shield (hold = down),
// lock, use, heal, build, next, pause. Build slots in the build bar can be tapped.

export const isTouch = (() => {
  try {
    return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);
  } catch { return 'ontouchstart' in window; }
})();

const BUTTONS = [
  // id, label, class, action (tap), hold flag
  ['attack', '⚔', 'big', 'attack', 'fire'],
  ['roll', '⤼', 'mid', 'roll', 'up'],
  ['block', '🛡', 'mid', null, 'block'],
  ['lock', '◎', 'sm', 'lock', null],
  ['use', 'Use', 'sm txt', 'interact', null],
  ['heal', '✚', 'sm', 'heal', null],
  ['build', '⌂', 'sm', 'build', null],
  ['next', '⇆', 'sm', 'switchNext', null],
  ['gun', '⌖', 'sm', 'weapon', null],
];

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.move = { x: 0, y: 0, sprint: false };
    this.hold = { fire: false, up: false, block: false };
    this.lookSens = 0.0055;
    this.stick = null;   // { id, ox, oy }
    this.look = null;    // { id, x, y }

    const root = this.root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div class="zone"></div>
      <div class="stick hidden"><div class="knob"></div></div>
      <button class="tbtn pause" data-a="pause">❚❚</button>
      <div class="pad"></div>`;
    document.body.appendChild(root);
    this.stickEl = root.querySelector('.stick');
    this.knob = root.querySelector('.knob');
    const pad = root.querySelector('.pad');
    for (const [id, label, cls, action, hold] of BUTTONS) {
      const b = document.createElement('button');
      b.className = `tbtn ${cls} b-${id}`;
      b.textContent = label;
      if (action) b.dataset.a = action;
      if (hold) b.dataset.h = hold;
      pad.appendChild(b);
    }

    // Buttons: each tracks its own finger.
    for (const b of root.querySelectorAll('.tbtn')) {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { b.setPointerCapture(e.pointerId); } catch {}
        b.classList.add('on');
        input.lastDevice = 'touch';
        if (b.dataset.a) {
          input.pressed.add(b.dataset.a);
          if (b.dataset.a === 'interact') input.pressed.add('exitVehicle');
        }
        if (b.dataset.h) this.hold[b.dataset.h] = true;
        navigator.vibrate?.(8);
      });
      const up = () => { b.classList.remove('on'); if (b.dataset.h) this.hold[b.dataset.h] = false; };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // Stick + look on the background zone.
    const zone = root.querySelector('.zone');
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      input.lastDevice = 'touch';
      try { zone.setPointerCapture(e.pointerId); } catch {}
      if (e.clientX < innerWidth * 0.45 && !this.stick) {
        this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
        this.stickEl.style.left = `${e.clientX}px`; this.stickEl.style.top = `${e.clientY}px`;
        this.stickEl.classList.remove('hidden');
        this.knob.style.transform = 'translate(-50%,-50%)';
      } else if (!this.look) {
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
      }
    });
    zone.addEventListener('pointermove', (e) => {
      if (this.stick && e.pointerId === this.stick.id) {
        const R = this.radius();
        let dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
        const len = Math.hypot(dx, dy);
        // drag the origin along if the thumb travels far past the rim
        if (len > R * 1.6) {
          const k = (len - R * 1.6) / len;
          this.stick.ox += dx * k; this.stick.oy += dy * k;
          dx = e.clientX - this.stick.ox; dy = e.clientY - this.stick.oy;
          this.stickEl.style.left = `${this.stick.ox}px`; this.stickEl.style.top = `${this.stick.oy}px`;
        }
        const l = Math.hypot(dx, dy);
        const c = Math.min(1, l / R);
        const nx = l > 0 ? dx / l : 0, ny = l > 0 ? dy / l : 0;
        const dead = 0.12, m = c < dead ? 0 : (c - dead) / (1 - dead);
        this.move.x = nx * m; this.move.y = -ny * m;
        this.move.sprint = l > R * 1.15;
        this.stickEl.classList.toggle('sprint', this.move.sprint);
        this.knob.style.transform = `translate(calc(-50% + ${nx * c * R}px), calc(-50% + ${ny * c * R}px))`;
      } else if (this.look && e.pointerId === this.look.id) {
        const dx = e.clientX - this.look.x, dy = e.clientY - this.look.y;
        this.look.x = e.clientX; this.look.y = e.clientY;
        this.look.moved += Math.abs(dx) + Math.abs(dy);
        // poll() multiplies by input.sensitivity (slider), base 0.0022
        input.mouseDX += dx * this.lookSens / 0.0022;
        input.mouseDY += dy * this.lookSens / 0.0022;
      }
    });
    const end = (e) => {
      if (this.stick && e.pointerId === this.stick.id) {
        this.stick = null; this.move.x = this.move.y = 0; this.move.sprint = false;
        this.stickEl.classList.add('hidden'); this.stickEl.classList.remove('sprint');
      } else if (this.look && e.pointerId === this.look.id) {
        this.look = null;
      }
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    // Tap a slot in the build bar to choose it.
    document.querySelector('#buildbar')?.addEventListener('pointerdown', (e) => {
      const slot = e.target.closest('.slot');
      const key = slot?.querySelector('kbd')?.textContent?.trim();
      if (key) { e.preventDefault(); input.pressed.add(`slot${key}`); }
    });

    // Never let the page scroll, zoom or bounce.
    document.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
  }

  radius() { return Math.max(42, Math.min(70, innerHeight * 0.13)); }

  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
    if (!v) {
      this.stick = null; this.look = null; this.move.x = this.move.y = 0; this.move.sprint = false;
      this.hold.fire = this.hold.up = this.hold.block = false;
      this.stickEl.classList.add('hidden');
      for (const b of this.root.querySelectorAll('.tbtn.on')) b.classList.remove('on');
    }
  }

  apply(out) {
    out.moveX += this.move.x; out.moveY += this.move.y;
    if (this.move.sprint) out.sprint = true;
    if (this.hold.block) { out.block = true; out.down = true; }
    if (this.hold.fire) out.fire = true;
    if (this.hold.up) out.up = true;
  }
}

/** Fullscreen + landscape lock where the browser allows it (Android Chrome; not iPhone Safari). */
export function goFullscreenLandscape() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req || document.fullscreenElement) { screen.orientation?.lock?.('landscape').catch(() => {}); return; }
  try {
    const p = req.call(el, { navigationUI: 'hide' });
    const lock = () => screen.orientation?.lock?.('landscape').catch(() => {});
    if (p && p.then) p.then(lock).catch(() => {}); else lock();
  } catch {}
}
