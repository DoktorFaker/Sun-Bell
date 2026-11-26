// Keyboard + mouse (pointer lock) + gamepad + touch input, merged into one action state.
import { isTouch, TouchControls } from './touch.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();      // actions pressed this frame
    this.mouseDX = 0; this.mouseDY = 0;
    this.mouseButtons = new Set();
    this.locked = false;
    this.enabled = false;
    this.sensitivity = 0.0022;
    this.pad = null;
    this.padPrev = [];
    this.lastDevice = isTouch ? 'touch' : 'kbm';
    this.touch = isTouch ? new TouchControls(this) : null;
    if (this.touch) { this.locked = true; this.touch.setVisible(false); }

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.lastDevice = 'kbm';
      const map = {
        Space: 'roll', KeyQ: 'lock', KeyE: 'interact', KeyX: 'exitVehicle', KeyB: 'build', Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5', KeyR: 'heal', Tab: 'switch',
        Escape: 'pause', KeyP: 'pause', F3: 'fps', KeyF: 'attack',
      };
      if (map[e.code]) { this.pressed.add(map[e.code]); }
      if (e.code === 'KeyE') this.pressed.add('exitVehicle');
      if (e.code === 'Tab' || e.code === 'Space' || e.code === 'F3') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouseButtons.clear(); });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.mouseButtons.add(e.button);
      this.lastDevice = 'kbm';
      if (e.button === 0) this.pressed.add('attack');
      if (e.button === 1) { this.pressed.add('lock'); e.preventDefault(); }
    });
    addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    canvas.addEventListener('wheel', (e) => {
      if (this.locked) this.pressed.add(e.deltaY > 0 ? 'switchNext' : 'switchPrev');
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.mouseButtons.clear(); this.keys.clear(); }
      this.onLockChange?.(this.locked);
    });
    addEventListener('gamepadconnected', (e) => { this.lastDevice = 'pad'; this.onToast?.(`Controller connected`); });
  }

  requestLock() {
    if (this.touch) { this.locked = true; return; }
    try {
      const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { const q = this.canvas.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch (e) { /* needs a click */ } });
    } catch (e) { /* needs a click */ }
  }

  // Called once per frame before game update.
  poll() {
    const out = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      sprint: false, block: false,
      pressed: this.pressed,
    };
    // keyboard
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) out.moveY += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) out.moveY -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) out.moveX += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) out.moveX -= 1;
    out.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    out.block = this.mouseButtons.has(2) || k.has('ControlLeft') || k.has('KeyC');
    out.up = k.has('Space');
    out.down = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyC') || k.has('ControlLeft');
    out.fire = this.mouseButtons.has(0) || k.has('KeyF');
    out.lookX = this.mouseDX * this.sensitivity;
    out.lookY = this.mouseDY * this.sensitivity;
    this.mouseDX = 0; this.mouseDY = 0;

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && [...pads].find((p) => p && p.connected);
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0);
      const rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
      const b = gp.buttons.map((x) => x.pressed);
      const prev = this.padPrev;
      const down = (i) => b[i] && !prev[i];
      if (lx || ly || rx || ry || b.some(Boolean)) this.lastDevice = 'pad';
      out.moveX += lx; out.moveY -= ly;
      out.lookX += rx * 0.045; out.lookY += ry * 0.035;
      // B: tap to roll, hold to sprint
      if (!b[1] && prev[1] && this.padRollTime < 0.3) out.pressed.add('roll');
      this.padRollTime = b[1] ? (this.padRollTime || 0) + 1 / 60 : 0;
      if (b[1] && this.padRollTime > 0.3) out.sprint = true;
      if (b[4] || b[6]) out.block = true;
      if (down(5) || down(7)) out.pressed.add('attack');
      if (down(11)) out.pressed.add('lock');
      if (down(0)) out.pressed.add('interact');
      if (down(3)) out.pressed.add('exitVehicle');
      if (down(8)) out.pressed.add('build');
      if (b[5] || b[7]) out.fire = true;
      if (b[0]) out.up = true;
      if (b[4] || b[6]) out.down = true;
      if (down(2)) out.pressed.add('heal');
      if (down(9)) out.pressed.add('pause');
      if (down(15)) out.pressed.add('switchNext');
      if (down(14)) out.pressed.add('switchPrev');
      this.padPrev = b;
    }
    if (this.touch) this.touch.apply(out);
    const len = Math.hypot(out.moveX, out.moveY);
    if (len > 1) { out.moveX /= len; out.moveY /= len; }
    return out;
  }

  endFrame() { this.pressed = new Set(); }
}
