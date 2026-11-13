/*
 * Gardenview House
 * A Lovelace card for the sun screen on the back of the owner's house: a line
 * drawing of the garden facade (in the style of the Tesla Model 3 Card) that
 * shows the screen at its real position, the garden and kitchen doors open or
 * shut, the lantern on or off, sun or moon, wind, and dims when it is dark.
 *
 * Position direction (motion_blinds): 100 = open = screen retracted, 0 = fully
 * out. The card speaks from the user's side: "60 % out" is position 40.
 *
 * Every action, the cover controls included, goes through Home Assistant's own
 * action handler (hass-action, perform-action); nothing calls hass directly.
 *
 * https://github.com/BarBaar44/gardenview-house  (MIT)
 */

// Everything sits in one block so the top-level names cannot clash with the
// sister cards when the files are loaded as classic scripts.
{
const VERSION = "0.1.1";

const GH_HOLD_MS = 500;
const GH_MOVE_PX = 8;
const GH_DRAG_PX = 100; // finger travel for 0 to 100 % out
const GH_TICK_MS = 60000; // "Up at" / "No auto up" follow the clock
const GH_TRAVEL_TICK_MS = 250; // redraw rate while the screen travels
const GH_MIN_TRAVEL_MS = 2000;
const GH_LATE_MS = 5000; // a final position report this long after a travel ends is not a new move

const GH_DEFAULTS = {
  name: "Sun screen",
  wind_warning: 40, // km/h gusts: warn while the screen is out
  dark_below: 10, // lx, only when `dark` is an illuminance sensor (10 lx, as the Garden Lights automation)
  retract_offset: 120, // minutes before sunset the automation retracts the screen; null hides it
  travel_time: 15, // seconds for the whole range (motion_blinds reports the target at once, the real position when the motor stops)
  entities: {
    cover: "cover.sun_screen",
    sun: "sun.sun",
    temperature: "sensor.outdoor_temperature",
    wind_gust: "sensor.openweathermap_wind_gust_speed",
    dark: "sensor.outdoor_sensor_illuminance", // binary_sensor / input_boolean (on = dark) or an illuminance sensor; null: sun below the horizon
    lantern: "light.rear_garden", // light or switch of the garden lantern
    garden_door: "binary_sensor.door_sensor_garden_doors_contact", // French doors (one sensor opens both leaves)
    garden_door_2: null, // optional second leaf of the French doors
    kitchen_door: "binary_sensor.door_sensor_kitchen_contact",
  },
};

/* colors key -> CSS variable and default. */
const GH_COLORS = {
  out: ["--gh-out", "var(--orange-color, #ff9800)"],
  wind: ["--gh-wind", "var(--amber-color, #ffc107)"],
};

const GH_BAD = ["unknown", "unavailable", "none", ""];
const ghNum = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));
const ghKey = (v) => String(v == null ? "" : v).trim().toLowerCase();

/* ------------------------------------------------------------------------ */
/* The drawing: a small perspective camera on the garden facade              */
/* ------------------------------------------------------------------------ */

/*
 * World in metres: the facade is the plane z = 0, x along the wall (0 to 5.4),
 * y up, z out into the garden; inside the house is z < 0. The camera stands in
 * the garden at eye height, about 25 degrees off straight on from the left
 * (65 degrees to the wall), so the open doors show the room behind them.
 */
const GH = (() => {
  const deg = Math.PI / 180;
  const W = 5.4;
  const tgt = [2.7, 1.6, 0.8];
  const D = 14;
  const ang = 65 * deg;
  const cam = [tgt[0] - D * Math.cos(ang), 1.6, D * Math.sin(ang)];
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const f = norm(sub(tgt, cam));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const proj = (p) => { const d = sub(p, cam); const z = dot(d, f); return [dot(d, r) / z * 165, -dot(d, u) / z * 165]; };
  // Screen: cassette under the balcony band, cloth out at 30 degrees below horizontal.
  const CAS_Y = 2.78;
  const CAS_Z = 0.22;
  const LMAX = 2.6;
  const PITCH = 30 * deg;
  const front = (out) => { const s = LMAX * out / 100; return { y: CAS_Y - 0.06 - s * Math.sin(PITCH), z: CAS_Z + s * Math.cos(PITCH) }; };
  // Fixed viewBox (screen fully out included) so the picture never jumps.
  const ext = [[0, 0, 0], [W, 0, 0], [W, 3.3, 0], [0, 3.3, 0], [W + 0.3, 0, 2.6], [-0.3, 0, 2.6], [0, 0, 2.6], [W, 0, 2.6]].map(proj);
  const xs = ext.map((p) => p[0]);
  const ys = ext.map((p) => p[1]);
  const x0 = Math.min(...xs) - 4;
  const y0 = Math.min(...ys) - 2;
  const vb = [x0, y0, Math.max(...xs) + 4 - x0, Math.max(...ys) + 2 - y0];
  const lantern = proj([3.44, 1.67, 0.12]);
  return { deg, W, proj, front, CAS_Y, CAS_Z, vb, lantern };
})();

const ghF = (n) => n.toFixed(2);

/*
 * The whole picture as SVG markup for one state:
 * { out, target, moving, windy, dark, sunUp, lamp, doors: { g1, g2, k }, uid }
 */
function ghScene(o) {
  const { W, proj, front, CAS_Y, CAS_Z, deg } = GH;
  const pts = (a) => a.map((p) => proj(p).map(ghF).join(",")).join(" ");
  const poly = (a, fill, extra = "") => `<polygon points="${pts(a)}" fill="${fill}" ${extra}/>`;
  const line = (a, b, extra = "") => { const p = proj(a); const q = proj(b); return `<line x1="${ghF(p[0])}" y1="${ghF(p[1])}" x2="${ghF(q[0])}" y2="${ghF(q[1])}" ${extra}/>`; };
  const rect = (x0, x1, y0, y1, z = 0) => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  const K = "#111";
  const S = 'stroke="#111" stroke-width="1.3" stroke-linejoin="round"';
  const T = 'stroke="#111" stroke-width=".8"';
  const dark = !!o.dark;
  // In the dark the house goes grey so the lights stand out.
  const X = (c) => (!dark ? c : ({ "#fff": "#8e8e8e", "#f2f2f2": "#7a7a7a", "#555": "#3a3a3a", "#6a6a6a": "#454545" }[c] || c));
  const glass = dark ? "#ffb74d" : K;
  const gOp = dark ? ".85" : "1";
  const doors = o.doors || {};
  let s = "";

  // ground, and the screen's shadow on the patio while the sun is up
  s += poly([[-0.3, 0, 0], [W + 0.3, 0, 0], [W + 0.3, 0, 2.6], [-0.3, 0, 2.6]], "#262626");
  if (o.out > 0 && !dark && o.sunUp) {
    const fr = front(o.out);
    const sh = fr.z + fr.y * 0.55;
    s += poly([[0.35, 0, 0.15], [W - 0.35, 0, 0.15], [W + 0.05, 0, sh], [0.75, 0, sh]], "#000", 'opacity=".35"');
  }
  // wall
  s += poly(rect(0, W, 0, 2.95), X("#f2f2f2"), S);

  // A door or window unit: thick white frame, black glass, lower panel.
  const unit = (x0, x1, gy0) => {
    let g = poly(rect(x0, x1, 0, 2.03), X("#fff"), S);
    g += poly(rect(x0 + 0.11, x1 - 0.11, gy0, 1.93), glass, `opacity="${gOp}"`);
    if (gy0 < 0.8) g += poly(rect(x0 + 0.13, x1 - 0.13, 0.13, 0.5), X("#fff"), T);
    return g;
  };
  // An open leaf: hinge at hx, width w, swung outward by th degrees (dir +1: free edge to the right).
  const leaf = (hx, w, dir, th) => {
    const t = th * deg;
    const P = (uu, y) => [hx + dir * uu * Math.cos(t), y, uu * Math.sin(t)];
    const R = (u0, u1, y0, y1) => [P(u0, y0), P(u1, y0), P(u1, y1), P(u0, y1)];
    let g = poly(R(0, w, 0, 2.03), X("#fff"), S) + poly(R(0.11, w - 0.11, 0.62, 1.93), glass, `opacity="${gOp}"`) + poly(R(0.13, w - 0.13, 0.13, 0.5), X("#fff"), T);
    g += line(P(w - 0.15, 1.0), P(w - 0.15, 1.18), 'stroke="#111" stroke-width="1.6" stroke-linecap="round"');
    return g;
  };

  // ---- the rooms behind the doors (z < 0), lit warm in the dark ----
  const C = dark
    ? { wall: "#f3e2c0", back: "#ead6b0", ceil: "#d9c39a", floor: "#b98a52" }
    : { wall: "#d8d4cc", back: "#cfcac0", ceil: "#bdb8ae", floor: "#8f6b45" };
  const box = (x0, x1, y0, y1, z0, z1, top, face, side) =>
    poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], top, T)
    + poly([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], face, T)
    + poly([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], side, T);
  const boxL = (x0, x1, y0, y1, z0, z1, top, face, end) =>
    poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], top, T)
    + poly([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], end, T)
    + poly([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], face, T);
  const room = (x0, x1, d, H) => {
    let g = poly([[x0, H, 0], [x1, H, 0], [x1, H, -d], [x0, H, -d]], C.ceil);
    g += poly([[x0, 0, -d], [x1, 0, -d], [x1, H, -d], [x0, H, -d]], C.back, T);
    g += poly([[x1, 0, 0], [x1, 0, -d], [x1, H, -d], [x1, H, 0]], C.wall, T);
    g += poly([[x0, 0, 0], [x0, 0, -d], [x0, H, -d], [x0, H, 0]], C.wall, T);
    g += poly([[x0, 0, 0], [x1, 0, 0], [x1, 0, -d], [x0, 0, -d]], C.floor, T);
    for (let i = -6; i < 12; i++) { const xa = x0 + i * 0.35; g += line([xa, 0, 0], [xa + 1.2, 0, -d], 'stroke="#000" stroke-opacity=".12" stroke-width=".6"'); }
    return g;
  };
  const dining = () => {
    let g = room(-0.6, 6.2, 4.2, 2.7);
    g += box(4.2, 5.6, 0, 2.15, -3.75, -4.2, "#eee", "#f6f6f6", "#dcdcdc"); // display cabinet
    const pane = dark ? "#7a6040" : "#555";
    g += poly(rect(4.32, 4.86, 1.0, 2.0, -3.75), pane) + poly(rect(4.94, 5.48, 1.0, 2.0, -3.75), pane);
    g += line([4.3, 0.95, -3.74], [5.5, 0.95, -3.74], T);
    const tc = [3.3, 0.76, -2.0];
    const tr = 0.62;
    const ring = [...Array(28)].map((_, i) => [tc[0] + tr * Math.cos(i / 28 * 2 * Math.PI), tc[1], tc[2] + tr * Math.sin(i / 28 * 2 * Math.PI)]);
    g += box(3.55, 3.95, 0.45, 0.95, -1.3, -1.7, "#2a2a2a", "#333", "#222"); // chair in front
    g += line([tc[0] - 0.35, 0, tc[2] + 0.3], [tc[0], 0.74, tc[2]], 'stroke="#111" stroke-width="2"') + line([tc[0] + 0.35, 0, tc[2] - 0.3], [tc[0], 0.74, tc[2]], 'stroke="#111" stroke-width="2"');
    g += poly(ring, "#f2efe8", S); // round table
    g += box(2.5, 2.9, 0.45, 1.0, -2.0, -2.4, "#2a2a2a", "#333", "#222"); // chair beside
    for (const px of [3.05, 3.55]) { // pendant lamps
      const c = proj([px, 1.85, -2.0]);
      const k = proj([px, 2.7, -2.0]);
      g += `<line x1="${ghF(k[0])}" y1="${ghF(k[1])}" x2="${ghF(c[0])}" y2="${ghF(c[1])}" stroke="#111" stroke-width=".7"/>`;
      if (dark) g += `<circle cx="${ghF(c[0])}" cy="${ghF(c[1] + 2)}" r="7" fill="#ffd54f" opacity=".4"/>`;
      g += poly([[px - 0.18, 1.66, -2.0], [px + 0.18, 1.66, -2.0], [px, 1.9, -2.0]], "#2a2a2a", T);
    }
    g += poly([[0.9, 0.01, -0.08], [2.55, 0.01, -0.08], [2.55, 0.01, -0.42], [0.9, 0.01, -0.42]], "#2b2118", T); // floor grille
    for (let x = 1.0; x < 2.55; x += 0.12) g += line([x, 0.012, -0.1], [x, 0.012, -0.4], 'stroke="#b98a52" stroke-width=".5"');
    return g;
  };
  const kitchen = () => {
    let g = room(3.6, 6.6, 3.4, 2.6);
    g += poly([[6.59, 0.92, -0.2], [6.59, 0.92, -3.4], [6.59, 1.5, -3.4], [6.59, 1.5, -0.2]], "#8fd3c7", T); // mint tiles
    g += boxL(6.0, 6.6, 0, 0.86, -0.2, -3.4, "#f6f6f6", "#f6f6f6", "#e6e6e6"); // base units
    g += boxL(5.96, 6.6, 0.86, 0.93, -0.2, -3.4, "#141414", "#141414", "#141414"); // black worktop
    g += boxL(6.25, 6.6, 1.55, 2.3, -0.2, -3.4, "#f6f6f6", "#f6f6f6", "#e6e6e6"); // wall units
    for (let z = -0.8; z > -3.3; z -= 0.6) g += line([6.0, 0.1, z], [6.0, 0.8, z], T) + line([6.25, 1.6, z], [6.25, 2.25, z], T);
    g += boxL(6.1, 6.35, 0.93, 1.12, -1.5, -1.75, "#1565c0", "#1976d2", "#0d47a1"); // kettle
    return g;
  };
  let clip = 0;
  const door = (x0, x1, isOpen, inner) => {
    if (!isOpen) return unit(x0, x1, 0.62);
    const id = `${o.uid || "gh"}-c${clip++}`;
    return `<clipPath id="${id}"><polygon points="${pts(rect(x0, x1, 0, 2.03))}"/></clipPath>`
      + `<g clip-path="url(#${id})">${inner()}</g>` + poly(rect(x0, x1, 0, 2.03), "none", S);
  };
  const g1 = !!doors.g1;
  const g2 = !!doors.g2;
  const k = !!doors.k;
  s += unit(0.45, 0.9, 0.62) + unit(2.55, 3.0, 0.62); // side lights of the French doors
  s += door(0.9, 1.725, g1, dining);
  s += door(1.725, 2.55, g2, dining);
  s += door(3.85, 4.6, k, kitchen);
  // open leaves after the doorways, so they sit in front of them
  if (g1) s += leaf(0.9, 0.825, 1, 95);
  if (g2) s += leaf(2.55, 0.825, -1, 95);
  if (k) s += leaf(4.6, 0.75, -1, 95); // kitchen door: hinge on the right
  // kitchen side window, transoms, handles of the closed doors
  s += poly(rect(4.6, 5.05, 0.88, 2.03), X("#fff"), S) + poly(rect(4.69, 4.96, 0.98, 1.93), glass, `opacity="${gOp}"`);
  for (const [a, b] of [[0.45, 0.9], [0.9, 2.55], [2.55, 3.0], [3.85, 4.6], [4.6, 5.05]]) {
    s += poly(rect(a, b, 2.03, 2.55), X("#fff"), S) + poly(rect(a + 0.09, b - 0.09, 2.12, 2.46), glass, `opacity="${gOp}"`);
  }
  for (const x of [g1 ? null : 1.6, g2 ? null : 1.85, k ? null : 3.98]) {
    if (x !== null) s += line([x, 1.0, 0.02], [x, 1.18, 0.02], 'stroke="#111" stroke-width="1.6" stroke-linecap="round"');
  }

  // brick pier between the French doors and the kitchen door, white frame (kozijn) strips on both sides
  {
    s += poly(rect(3.0, 3.85, 0, 2.95), dark ? "#5e3328" : "#a4513b", S);
    for (let y = 0.17; y < 2.95; y += 0.17) s += line([3.0, y, 0], [3.85, y, 0], `stroke="${dark ? "#7a4a3c" : "#c98b7a"}" stroke-width=".5"`);
    s += poly(rect(3.0, 3.07, 0, 2.55), X("#fff"), T) + poly(rect(3.78, 3.85, 0, 2.55), X("#fff"), T);
  }
  // lantern: black housing, cap and bracket; the pane glows while it is on
  {
    const lx0 = 3.34; const lx1 = 3.54; const ly0 = 1.52; const ly1 = 1.82; const lz = 0.12;
    if (o.lamp) s += `<circle class="glow" cx="${ghF(GH.lantern[0])}" cy="${ghF(GH.lantern[1])}" r="7" fill="#ffd54f" opacity=".22"/>`;
    s += line([3.44, 1.86, 0], [3.44, 1.86, lz], 'stroke="#111" stroke-width="1.6"');
    s += poly([[lx0 - 0.03, ly1, lz], [lx1 + 0.03, ly1, lz], [3.44, 1.92, lz]], "#111", S);
    s += poly(rect(lx0, lx1, ly0, ly1, lz), "#111", S);
    s += poly(rect(lx0 + 0.04, lx1 - 0.04, ly0 + 0.04, ly1 - 0.04, lz), o.lamp ? "#ffd54f" : "#555", 'class="pane"');
    s += poly([[lx0 + 0.02, ly0, lz], [lx1 - 0.02, ly0, lz], [3.44, ly0 - 0.07, lz]], "#111");
  }
  // balcony band, flush with the wall above the cassette
  s += poly(rect(0, W, 2.95, 3.3), X("#fff"), S);

  // the screen: arms, solid grey cloth with light stripes, front bar, coloured hem
  if (o.out > 0) {
    const fr = front(o.out);
    const a = [0.3, CAS_Y - 0.08, CAS_Z]; const b = [W - 0.3, CAS_Y - 0.08, CAS_Z];
    const c = [W - 0.3, fr.y, fr.z]; const d = [0.3, fr.y, fr.z];
    let g = line([0.4, CAS_Y - 0.35, 0], [0.4, fr.y, fr.z], 'stroke="#111" stroke-width="2"')
      + line([W - 0.4, CAS_Y - 0.35, 0], [W - 0.4, fr.y, fr.z], 'stroke="#111" stroke-width="2"');
    g += poly([a, b, c, d], dark ? "#5e5e5e" : "#8d8d8d", S);
    for (let x = 0.75; x < W - 0.3; x += 0.45) g += line([x, CAS_Y - 0.08, CAS_Z], [x, fr.y, fr.z], `stroke="${dark ? "#8a8a8a" : "#cfcfcf"}" stroke-width="2.2"`);
    const vy = fr.y - 0.2;
    g += poly([d, c, [W - 0.3, vy, fr.z], [0.3, vy, fr.z]], dark ? "#4a4a4a" : "#6e6e6e", S);
    g += line([0.3, vy, fr.z], [W - 0.3, vy, fr.z], 'class="hem" stroke-width="1.1" stroke-linecap="round"');
    const top = proj([W / 2, CAS_Y, CAS_Z]);
    s += `<g class="cloth${o.windy ? " flap" : ""}" style="transform-origin:${ghF(top[0])}px ${ghF(top[1])}px">${g}</g>`;
  }
  if (o.target !== null && o.target !== undefined) {
    const fr = front(o.target);
    s += line([0.3, fr.y, fr.z], [W - 0.3, fr.y, fr.z], 'class="ghost" stroke-width="1.4" stroke-dasharray="3 2"');
  }
  // cassette
  s += poly([[0.25, CAS_Y, 0], [W - 0.25, CAS_Y, 0], [W - 0.25, CAS_Y, CAS_Z], [0.25, CAS_Y, CAS_Z]], X("#555"), S);
  s += poly([[0.25, CAS_Y - 0.16, CAS_Z], [W - 0.25, CAS_Y - 0.16, CAS_Z], [W - 0.25, CAS_Y, CAS_Z], [0.25, CAS_Y, CAS_Z]], X("#6a6a6a"), S);

  // sky: sun or moon, top right; wind lines at the front edge
  const [x0, y0, w, h] = GH.vb;
  if (!dark && o.sunUp) {
    const sx = x0 + w * 0.88; const sy = y0 + h * 0.2;
    s += `<circle cx="${ghF(sx)}" cy="${ghF(sy)}" r="9" fill="#ffd54f" opacity=".25"/><circle cx="${ghF(sx)}" cy="${ghF(sy)}" r="5" fill="#ffd54f" stroke="#111" stroke-width="1"/>`;
  } else if (dark || o.sunUp === false) {
    const sx = x0 + w * 0.85; const sy = y0 + h * 0.12;
    s += `<path d="M${ghF(sx)} ${ghF(sy)}m-4 -5a6 6 0 1 0 8 8a5 5 0 1 1 -8 -8z" fill="#cfd8dc"/>`;
  }
  if (o.windy) {
    const wx = x0 + w - 22; const wy = y0 + h * 0.48;
    s += `<g class="wind" stroke-width="2" stroke-linecap="round" fill="none"><path d="M${ghF(wx)} ${ghF(wy)}h12a3.5 3.5 0 1 0 -3.5 -3.5"/><path d="M${ghF(wx - 1)} ${ghF(wy + 7)}h16"/><path d="M${ghF(wx)} ${ghF(wy + 14)}h10a3.5 3.5 0 1 1 -3.5 3.5"/></g>`;
  }
  return s;
}

/* ------------------------------------------------------------------------ */
/* The card                                                                 */
/* ------------------------------------------------------------------------ */

const GH_STYLE = `
  :host {
${Object.values(GH_COLORS).map(([v, d]) => `    ${v}: ${d};`).join("\n")}
  }
  ha-card {
    height: 100%; box-sizing: border-box; padding: 4px 12px 4px 6px; overflow: hidden;
    display: flex; align-items: center; gap: 10px;
    transition: background-color .4s;
    user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
  }
  ha-card.dark { background: color-mix(in srgb, var(--ha-card-background, var(--card-background-color, #1c1c1c)) 80%, #000); }
  .pic { flex: none; height: 100%; max-height: 112px; aspect-ratio: ${ghF(GH.vb[2] / GH.vb[3])}; cursor: pointer; touch-action: pan-y; position: relative; }
  .pic svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .pic.dragging { cursor: ns-resize; touch-action: none; }
  .hit { fill: transparent; cursor: pointer; }
  .hem { stroke: var(--gh-out); }
  .windy .hem, .wind { stroke: var(--gh-wind); }
  .ghost { stroke: var(--gh-out); }
  .moving .hem { animation: gh-pulse 1s ease-in-out infinite; }
  .flap { animation: gh-flap 1.6s ease-in-out infinite; }
  @keyframes gh-pulse { 50% { stroke-opacity: .3; } }
  @keyframes gh-flap { 0%, 100% { transform: skewX(0); } 50% { transform: skewX(-1.5deg); } }

  .txt { flex: 1; min-width: 0; container-type: inline-size; display: flex; flex-direction: column; gap: 2px; cursor: pointer; transition: opacity .4s; }
  .name { font-size: 12px; line-height: 16px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .big { font-size: 28px; font-weight: 500; letter-spacing: -.5px; line-height: 32px; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .big small { font-size: 14px; font-weight: 400; letter-spacing: 0; color: var(--secondary-text-color); margin-left: 3px; }
  .big.word { font-size: 21px; }
  @container (max-width: 112px) { .big.word { font-size: 18px; } .big { font-size: 26px; } }
  .line { font-size: 12px; line-height: 16px; min-height: 16px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .line.warn { color: var(--gh-wind); }

  .btns { display: flex; flex-direction: column; gap: 4px; flex: none; transition: opacity .4s; }
  button {
    width: 32px; height: 32px; padding: 0; border: none; border-radius: 10px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    background: var(--secondary-background-color, rgba(127,127,127,.15)); color: var(--primary-text-color);
  }
  button ha-icon { --mdc-icon-size: 18px; width: 18px; height: 18px; display: flex; }
  button:disabled { opacity: .28; cursor: default; }
  button.hot { background: color-mix(in srgb, var(--gh-wind) 25%, transparent); color: var(--gh-wind); }
  button:focus-visible { outline: 2px solid var(--primary-color); }
  ha-card.dark .txt, ha-card.dark .btns { opacity: .7; }
  ha-card.unavailable .pic { filter: grayscale(1); opacity: .45; }
  ha-card.unavailable .txt { opacity: .45; }

  @media (prefers-reduced-motion: reduce) {
    .moving .hem, .flap { animation: none !important; }
    ha-card, .txt, .btns { transition: none !important; }
  }
`;

class GardenviewHouse extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._seen = Object.create(null);
    this._ids = [];
    this._tick = null;
    this._travel = null; // { from, to, start, until }: % out while the screen travels (see _onPosChange)
    this._hold = null; // { out, until }: position shown after stop, until the motor reports the real one
    this._quietUntil = 0;
    this._lastPos = undefined;
    this._fast = null;
    this._drag = null; // % out under the finger while dragging
    this._uid = `gh${Math.random().toString(36).slice(2, 7)}`;
  }

  static getConfigElement() {
    return document.createElement("gardenview-house-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    const c = config || {};
    const known = ["type", "name", "entities", "wind_warning", "dark_below", "retract_offset",
      "travel_time", "tap_action", "hold_action", "lantern_tap_action", "lantern_hold_action", "colors",
      "grid_options", "layout_options", "view_layout", "visibility", "card_mod"];
    for (const k of Object.keys(c)) {
      if (!known.includes(k)) throw new Error(`Unknown option '${k}'. Known: ${known.slice(1, 12).join(", ")}`);
    }
    const ent = c.entities == null ? {} : c.entities;
    if (typeof ent !== "object" || Array.isArray(ent)) throw new Error("entities must be a map, e.g. cover: cover.my_screen");
    for (const [k, v] of Object.entries(ent)) {
      if (!(k in GH_DEFAULTS.entities)) {
        throw new Error(`entities: unknown role '${k}'. Known: ${Object.keys(GH_DEFAULTS.entities).join(", ")}`);
      }
      if (v !== null && (typeof v !== "string" || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(v))) {
        throw new Error(`entities.${k}: '${v}' is not an entity id (null switches it off)`);
      }
    }
    const entities = { ...GH_DEFAULTS.entities, ...ent };
    if (!entities.cover) throw new Error("entities.cover is required");

    const number = (k, min, max) => {
      if (c[k] === null && k === "retract_offset") return null; // null hides the auto-retract time
      const v = c[k] === undefined || c[k] === null ? GH_DEFAULTS[k] : ghNum(c[k]);
      if (v === null || v < min || v > max) throw new Error(`${k} must be a number from ${min} to ${max}`);
      return v;
    };
    if (c.colors != null && (typeof c.colors !== "object" || Array.isArray(c.colors))) {
      throw new Error("colors must be a map, e.g. out: orange");
    }
    for (const k of ["tap_action", "hold_action", "lantern_tap_action", "lantern_hold_action"]) {
      if (c[k] != null && (typeof c[k] !== "object" || Array.isArray(c[k]) || !c[k].action)) {
        throw new Error(`${k} must be an action, e.g. action: more-info`);
      }
    }

    this._config = {
      name: c.name == null ? GH_DEFAULTS.name : String(c.name),
      entities,
      wind: number("wind_warning", 1, 300),
      darkBelow: number("dark_below", 0, 100000),
      offset: number("retract_offset", 0, 720),
      travelMs: number("travel_time", 1, 300) * 1000,
      tap_action: c.tap_action || { action: "more-info" },
      hold_action: c.hold_action || { action: "more-info" },
      lantern_tap_action: c.lantern_tap_action || { action: "toggle" },
      lantern_hold_action: c.lantern_hold_action || { action: "more-info" },
      colors: c.colors || {},
    };
    this._applyColors(this._config.colors);
    this._ids = Object.values(entities).filter(Boolean);
    this._seen = Object.create(null);
    this._travel = null;
    this._hold = null;
    this._quietUntil = 0;
    this._lastPos = undefined;
    this._drag = null;
    this._build();
    if (this._hass) this._update();
  }

  _applyColors(colors) {
    Object.keys(colors).forEach((k) => {
      if (!GH_COLORS[k]) console.warn(`gardenview-house: unknown colors key "${k}". Known: ${Object.keys(GH_COLORS).join(", ")}`);
    });
    Object.entries(GH_COLORS).forEach(([k, [v]]) => {
      const val = typeof colors[k] === "string" && colors[k].trim() ? colors[k].trim() : null;
      if (val) this.style.setProperty(v, val);
      else this.style.removeProperty(v);
    });
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    let changed = first;
    for (const id of this._ids) {
      const s = hass.states[id];
      if (s !== this._seen[id]) {
        this._seen[id] = s;
        changed = true;
        if (id === this._config.entities.cover) this._watchCover(s);
      }
    }
    if (changed) this._update();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    clearInterval(this._tick);
    this._tick = setInterval(() => this._update(), GH_TICK_MS);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    this._tick = null;
    clearInterval(this._fast);
    this._fast = null;
  }

  _now() {
    return Date.now();
  }

  /* ---- travel ------------------------------------------------------------- */

  /*
   * motion_blinds never reports opening or closing: on a command it jumps to the
   * target position at once and reports the real position when the motor stops
   * (about 15 s for the whole range). So the card treats the screen as moving
   * for travel_time × distance after its own command, or after a position jump
   * it did not cause, and draws it travelling from the old to the new position.
   */
  _posOf(s) {
    if (!s || GH_BAD.includes(ghKey(s.state))) return null;
    let pos = ghNum(s.attributes && s.attributes.current_position);
    if (pos === null) pos = ghKey(s.state) === "closed" ? 0 : 100;
    return Math.max(0, Math.min(100, pos));
  }

  _watchCover(s) {
    const pos = this._posOf(s);
    if (pos === null) { this._travel = null; this._hold = null; this._lastPos = undefined; return; }
    if (this._lastPos !== undefined && pos !== this._lastPos) this._onPosChange(Math.round(100 - this._lastPos), Math.round(100 - pos));
    this._lastPos = pos;
  }

  _onPosChange(prevOut, newOut) {
    const now = this._now();
    this._hold = null;
    const t = this._travel && now < this._travel.until ? this._travel : null;
    if (t) {
      if (newOut === t.to) return; // the jump to the target the card asked for
      this._travel = null; // the real position when the motor stopped early
      this._quietUntil = now + GH_LATE_MS;
      return;
    }
    if (now < this._quietUntil) return; // the final report after a travel or a stop
    this._startTravel(prevOut, newOut); // a move the card did not cause (automation, remote)
  }

  _startTravel(from, to) {
    if (from === to) return;
    const now = this._now();
    const ms = Math.max(GH_MIN_TRAVEL_MS, this._config.travelMs * Math.abs(to - from) / 100);
    this._travel = { from, to, start: now, until: now + ms };
    this._hold = null;
  }

  /* % out to show now: estimated while travelling, held after stop, else as reported. */
  _shownOut(reported, now) {
    const t = this._travel;
    if (t) {
      const f = Math.min(1, (now - t.start) / (t.until - t.start));
      return Math.round(t.from + (t.to - t.from) * f);
    }
    if (this._hold && now < this._hold.until) return this._hold.out;
    return reported;
  }

  _cmd(to, service, data) {
    const now = this._now();
    const st = this._state(now);
    this._startTravel(st.out, to);
    this._run({ action: "perform-action", perform_action: service, target: { entity_id: this._config.entities.cover }, ...(data ? { data } : {}) }, "tap");
    this._update();
  }

  _stop() {
    const now = this._now();
    const st = this._state(now);
    this._travel = null;
    this._hold = { out: st.out, until: now + this._config.travelMs };
    this._quietUntil = now + this._config.travelMs;
    this._run({ action: "perform-action", perform_action: "cover.stop_cover", target: { entity_id: this._config.entities.cover } }, "tap");
    this._update();
  }

  getCardSize() {
    return 2;
  }

  getGridOptions() {
    return { columns: 12, rows: 2, min_columns: 6, min_rows: 2 };
  }

  /* ---- DOM, built once per config ---------------------------------------- */

  _build() {
    const [x0, y0, w, h] = GH.vb;
    this.shadowRoot.innerHTML = `
      <style>${GH_STYLE}</style>
      <ha-card>
        <div class="pic" role="img">
          <svg viewBox="${[x0, y0, w, h].map(ghF).join(" ")}" xmlns="http://www.w3.org/2000/svg"><g class="scene"></g><circle class="hit" r="9"/></svg>
        </div>
        <div class="txt" role="button" tabindex="0">
          <div class="name"></div>
          <div class="big"></div>
          <div class="line"></div>
        </div>
        <div class="btns">
          <button class="up" aria-label="Retract"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="stop" aria-label="Stop"><ha-icon icon="mdi:stop"></ha-icon></button>
          <button class="down" aria-label="Lower"><ha-icon icon="mdi:arrow-down"></ha-icon></button>
        </div>
      </ha-card>`;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._el = {
      card: $("ha-card"), pic: $(".pic"), svg: $("svg"), scene: $(".scene"), hit: $(".hit"),
      txt: $(".txt"), name: $(".name"), big: $(".big"), line: $(".line"),
      up: $(".up"), stop: $(".stop"), down: $(".down"),
    };
    this._el.name.textContent = this._config.name;
    this._el.hit.setAttribute("cx", ghF(GH.lantern[0]));
    this._el.hit.setAttribute("cy", ghF(GH.lantern[1]));
    this._sceneKey = null;

    const button = (el, fn) => {
      el.addEventListener("click", (e) => { e.stopPropagation(); if (!el.disabled) fn(); });
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
    };
    button(this._el.up, () => this._cmd(0, "cover.open_cover"));
    button(this._el.down, () => this._cmd(100, "cover.close_cover"));
    button(this._el.stop, () => this._stop());
    this._bindPress(this._el.txt, this._config.entities.cover, "tap_action", "hold_action");
    this._bindPicture();
  }

  /* ---- actions ------------------------------------------------------------ */

  /* Tap and hold on an element, both through HA's action handler. */
  _bindPress(el, entity, tapKey, holdKey) {
    let timer = null;
    let start = null;
    let held = false;
    const cancel = () => { clearTimeout(timer); timer = null; start = null; };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      held = false;
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => { timer = null; held = true; this._run(this._config[holdKey], "hold", entity); }, GH_HOLD_MS);
    });
    el.addEventListener("pointermove", (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > GH_MOVE_PX) cancel();
    });
    el.addEventListener("pointerup", () => {
      if (!start) return;
      const wasHeld = held;
      cancel();
      if (!wasHeld) this._run(this._config[tapKey], "tap", entity);
    });
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      this._run(this._config[tapKey], "tap", entity);
    });
  }

  /*
   * The picture: tap opens the screen's details, the lantern toggles the light,
   * and a vertical drag sets the position: down is further out, the whole range
   * over GH_DRAG_PX of travel, starting from where the screen is now (snaps to
   * 5 %, and to 0/25/50/75/100 within 4 %). The ghost line shows the target.
   */
  _bindPicture() {
    const pic = this._el.pic;
    let start = null;
    let timer = null;
    let held = false;
    let mode = null; // "lantern" | "screen" | "drag"
    const cancel = () => {
      clearTimeout(timer); timer = null; start = null; mode = null;
      pic.classList.remove("dragging");
      if (this._drag !== null) { this._drag = null; this._update(); }
    };
    pic.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      held = false;
      start = { x: e.clientX, y: e.clientY };
      mode = e.target === this._el.hit && this._config.entities.lantern ? "lantern" : "screen";
      const holdKey = mode === "lantern" ? "lantern_hold_action" : "hold_action";
      const entity = mode === "lantern" ? this._config.entities.lantern : this._config.entities.cover;
      timer = setTimeout(() => { timer = null; held = true; this._run(this._config[holdKey], "hold", entity); }, GH_HOLD_MS);
    });
    pic.addEventListener("pointermove", (e) => {
      if (!start) return;
      if (mode === "screen" && Math.abs(e.clientY - start.y) > GH_MOVE_PX && this._canSet()) {
        clearTimeout(timer); timer = null;
        mode = "drag";
        start.out = this._state(this._now()).out;
        pic.classList.add("dragging");
        try { pic.setPointerCapture(e.pointerId); } catch (_) { /* not supported */ }
      }
      if (mode === "drag") {
        e.preventDefault();
        const out = this._dragOut(start.out, e.clientY - start.y);
        if (out !== this._drag) { this._drag = out; this._update(); }
      } else if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > GH_MOVE_PX) {
        cancel();
      }
    });
    pic.addEventListener("pointerup", () => {
      if (!start) return;
      const wasHeld = held;
      const m = mode;
      const out = this._drag;
      clearTimeout(timer); timer = null; start = null; mode = null;
      pic.classList.remove("dragging");
      this._drag = null;
      if (m === "drag" && out !== null) {
        this._setOut(out);
      } else if (!wasHeld && m === "lantern") {
        this._run(this._config.lantern_tap_action, "tap", this._config.entities.lantern);
      } else if (!wasHeld && m === "screen") {
        this._run(this._config.tap_action, "tap", this._config.entities.cover);
      }
      this._update();
    });
    pic.addEventListener("pointercancel", cancel);
    pic.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /* % out for a drag of dy pixels from base % out. */
  _dragOut(base, dy) {
    const raw = Math.max(0, Math.min(100, base + dy / GH_DRAG_PX * 100));
    for (const q of [0, 25, 50, 75, 100]) if (Math.abs(raw - q) <= 4) return q;
    return Math.round(raw / 5) * 5;
  }

  _canSet() {
    const s = this._s("cover");
    if (!s || GH_BAD.includes(ghKey(s.state))) return false;
    const f = ghNum(s.attributes && s.attributes.supported_features);
    return f === null || (f & 4) === 4;
  }

  _setOut(out) {
    this._cmd(out, "cover.set_cover_position", { position: 100 - out });
  }

  /* Hands an action to Home Assistant's own handler, like built-in cards do. */
  _run(conf, kind, entity) {
    if (!conf || conf.action === "none") return;
    window.dispatchEvent(new CustomEvent("haptic", { detail: kind === "hold" ? "medium" : "light" }));
    const config = { entity: entity || this._config.entities.cover };
    config[kind === "hold" ? "hold_action" : "tap_action"] = conf;
    this.dispatchEvent(new CustomEvent("hass-action", {
      bubbles: true, composed: true, detail: { config, action: kind },
    }));
  }

  /* ---- state -------------------------------------------------------------- */

  _s(role) {
    const id = this._config.entities[role];
    return id && this._hass ? this._hass.states[id] : undefined;
  }

  _on(role) {
    const s = this._s(role);
    return !!s && ["on", "open", "true"].includes(ghKey(s.state));
  }

  _lang() {
    const h = this._hass;
    return (h && h.locale && h.locale.language) || (h && h.language) || "en";
  }

  _clock(ms) {
    const tz = this._hass && this._hass.config && this._hass.config.time_zone;
    const opts = { hour: "2-digit", minute: "2-digit", hour12: false };
    try {
      return new Intl.DateTimeFormat(this._lang(), tz ? { ...opts, timeZone: tz } : opts).format(new Date(ms));
    } catch (_) {
      return new Intl.DateTimeFormat("en-GB", opts).format(new Date(ms));
    }
  }

  _day(ms) {
    const tz = this._hass && this._hass.config && this._hass.config.time_zone;
    try {
      return new Intl.DateTimeFormat("en-CA", tz ? { timeZone: tz } : {}).format(new Date(ms));
    } catch (_) {
      return new Date(ms).toDateString();
    }
  }

  /* Everything the card shows, worked out from the entities. */
  _state(now) {
    const cv = this._s("cover");
    const cs = cv ? ghKey(cv.state) : "unavailable";
    const unavailable = !cv || GH_BAD.includes(cs);
    const pos = this._posOf(cv);
    if (this._travel && (unavailable || now >= this._travel.until)) {
      this._quietUntil = Math.max(this._quietUntil, this._travel.until + GH_LATE_MS);
      this._travel = null;
    }
    if (unavailable) this._hold = null;
    const reported = unavailable || pos === null ? 0 : Math.round(100 - pos);
    const out = unavailable ? 0 : this._shownOut(reported, now);
    const t = this._travel;
    const moving = t ? (t.to > t.from ? "down" : "up") : cs === "opening" ? "up" : cs === "closing" ? "down" : null;
    const target = t ? t.to : null;

    const sun = this._s("sun");
    const sunUp = sun ? ghKey(sun.state) === "above_horizon" : null;
    const elevation = sun ? ghNum(sun.attributes && sun.attributes.elevation) : null;

    // Dark: a dark switch/binary sensor, an illuminance sensor below dark_below, or the sun below the horizon.
    let dark = sunUp === false;
    const ds = this._s("dark");
    if (ds && !GH_BAD.includes(ghKey(ds.state))) {
      const v = ghNum(ds.state);
      dark = v !== null && !["on", "off"].includes(ghKey(ds.state)) ? v < this._config.darkBelow : ghKey(ds.state) === "on";
    }

    // Wind: gusts in km/h (m/s converted).
    let gust = null;
    const gs = this._s("wind_gust");
    if (gs && !GH_BAD.includes(ghKey(gs.state))) {
      gust = ghNum(gs.state);
      const unit = ghKey(gs.attributes && gs.attributes.unit_of_measurement);
      if (gust !== null && unit === "m/s") gust *= 3.6;
      if (gust !== null && unit === "mph") gust *= 1.609;
    }
    const windy = gust !== null && gust >= this._config.wind;

    const ts = this._s("temperature");
    const temp = ts && !GH_BAD.includes(ghKey(ts.state)) && ghNum(ts.state) !== null
      ? `${Math.round(ghNum(ts.state) * 10) / 10} ${(ts.attributes && ts.attributes.unit_of_measurement) || "°C"}` : null;

    // The evening automation retracts the screen retract_offset minutes before sunset.
    let retract = null;
    if (this._config.offset !== null && sun) {
      const set = Date.parse(sun.attributes && sun.attributes.next_setting);
      if (!isNaN(set)) {
        const at = set - this._config.offset * 60000;
        retract = at > now && this._day(at) === this._day(now) ? { at } : { none: true };
      }
    }

    const doorsKnown = { g1: this._on("garden_door"), g2: this._config.entities.garden_door_2 ? this._on("garden_door_2") : this._on("garden_door"), k: this._on("kitchen_door") };
    return {
      unavailable, out, moving, target, travelling: !!t, sunUp, elevation, dark, gust, windy, temp, retract,
      lamp: this._on("lantern"), doors: doorsKnown,
    };
  }

  _update() {
    if (!this._hass || !this._el) return;
    const e = this._el;
    const st = this._state(this._now());
    const target = this._drag !== null ? this._drag : st.target;
    // redraw a few times a second while the screen travels
    if (st.travelling && !this._fast) this._fast = setInterval(() => this._update(), GH_TRAVEL_TICK_MS);
    if (!st.travelling && this._fast) { clearInterval(this._fast); this._fast = null; }

    // Picture: only redrawn when something in it changes.
    const scene = {
      out: st.out, target, windy: st.windy, dark: st.dark, sunUp: st.sunUp, lamp: st.lamp, doors: st.doors, uid: this._uid,
    };
    const key = JSON.stringify(scene);
    if (key !== this._sceneKey) {
      this._sceneKey = key;
      e.scene.innerHTML = ghScene(scene);
    }
    e.card.classList.toggle("dark", st.dark);
    e.card.classList.toggle("windy", st.windy);
    e.card.classList.toggle("moving", !!st.moving);
    e.card.classList.toggle("unavailable", st.unavailable);
    e.hit.style.display = this._config.entities.lantern ? "" : "none";

    // Text
    let big;
    let word = true;
    let line = "";
    let warn = false;
    if (st.unavailable) {
      big = "Unavailable";
    } else if (this._drag !== null) {
      big = this._drag === 0 ? "Retract" : `${this._drag}`;
      word = this._drag === 0;
      line = "Release to set";
    } else if (st.moving) {
      big = st.moving === "down" ? "Lowering…" : "Raising…";
      line = st.target !== null ? `${st.out} → ${st.target} % out` : `${st.out} % out`;
    } else if (st.out <= 0) {
      big = "Retracted";
      if (st.windy) { line = `Gusts ${Math.round(st.gust)} km/h`; warn = true; }
      else {
        const parts = [];
        if (st.sunUp && st.elevation !== null && !st.dark) parts.push(`Sun ${Math.round(st.elevation)}°`);
        if (st.temp) parts.push(st.temp);
        line = parts.join(" · ");
      }
    } else {
      big = `${st.out}`;
      word = false;
      if (st.windy) { line = `Gusts ${Math.round(st.gust)} km/h`; warn = true; }
      else if (st.retract && st.retract.at) line = `Up at ${this._clock(st.retract.at)}`;
      else if (st.retract && st.retract.none) line = "No auto up";
    }
    const bigKey = `${word}|${big}`;
    if (e.big._shown !== bigKey) {
      e.big._shown = bigKey;
      e.big.classList.toggle("word", word);
      if (word) e.big.textContent = big;
      else { e.big.textContent = big; const sm = document.createElement("small"); sm.textContent = "% out"; e.big.appendChild(sm); }
    }
    e.line.textContent = line;
    e.line.classList.toggle("warn", warn);

    // Buttons: only what applies now.
    // While travelling the reported position is the target, not where the screen is: up and down stay on.
    // Stop is always on (stop_cover on a still screen is harmless).
    e.up.disabled = st.unavailable || (!st.travelling && st.out <= 0);
    e.down.disabled = st.unavailable || (!st.travelling && st.out >= 100);
    e.stop.disabled = st.unavailable;
    e.up.classList.toggle("hot", st.windy && st.out > 0 && !st.unavailable);

    const label = st.unavailable ? "unavailable" : st.out <= 0 ? "retracted" : `${st.out} % out`;
    e.pic.setAttribute("aria-label", `${this._config.name}: ${label}`);
  }
}

/* ------------------------------------------------------------------------ */
/* Visual editor                                                            */
/* ------------------------------------------------------------------------ */

/*
 * Built on HA's own <ha-form>. Every field shows the value in use, defaults
 * included; only values that differ from the defaults are written to the
 * YAML. Clearing an optional entity switches that part off (null); clearing
 * the cover or a number goes back to its default. Options the editor does not
 * show (grid_options, ...) are kept.
 */

const GH_ENTITY_FIELDS = [
  ["cover", "Sun screen (required)", ["cover"]],
  ["sun", "Sun", ["sun"]],
  ["temperature", "Outdoor temperature", ["sensor"]],
  ["wind_gust", "Wind gusts", ["sensor"]],
  ["dark", "Dark (on = dark, or an illuminance sensor)", ["binary_sensor", "input_boolean", "switch", "sensor"]],
  ["lantern", "Garden lantern", ["light", "switch"]],
  ["garden_door", "Garden doors", ["binary_sensor"]],
  ["garden_door_2", "Garden doors, second leaf (optional)", ["binary_sensor"]],
  ["kitchen_door", "Kitchen door", ["binary_sensor"]],
];
const GH_REQUIRED = ["cover"];

const GH_NUMBER_FIELDS = [
  ["wind_warning", "Wind warning from gusts of", 1, 300, "km/h"],
  ["dark_below", "Dark below (illuminance sensor)", 0, 100000, "lx"],
  ["retract_offset", "Automation retracts before sunset", 0, 720, "min"],
  ["travel_time", "Travel time, whole range", 1, 300, "s"],
];

const GH_EDITOR_SCHEMA = [
  { name: "name", selector: { text: {} } },
  {
    type: "expandable",
    name: "entities",
    title: "Entities",
    icon: "mdi:home-outline",
    expanded: true,
    schema: GH_ENTITY_FIELDS.map(([role, , domains]) => ({
      name: role,
      selector: { entity: { filter: { domain: domains } } },
    })),
  },
  {
    type: "expandable",
    name: "",
    title: "Thresholds",
    icon: "mdi:weather-windy",
    schema: [{
      type: "grid",
      name: "",
      schema: GH_NUMBER_FIELDS.map(([k, , min, max, unit]) => ({
        name: k,
        selector: { number: { min, max, step: 1, mode: "box", unit_of_measurement: unit } },
      })),
    }],
  },
  {
    type: "expandable",
    name: "",
    title: "Actions",
    icon: "mdi:gesture-tap",
    schema: [
      { name: "tap_action", selector: { ui_action: { default_action: "more-info" } } },
      { name: "hold_action", selector: { ui_action: { default_action: "more-info" } } },
      { name: "lantern_tap_action", selector: { ui_action: { default_action: "toggle" } } },
      { name: "lantern_hold_action", selector: { ui_action: { default_action: "more-info" } } },
    ],
  },
  {
    type: "expandable",
    name: "colors",
    title: "Colours",
    icon: "mdi:palette",
    schema: [{
      type: "grid",
      name: "",
      schema: Object.keys(GH_COLORS).map((k) => ({ name: k, selector: { text: {} } })),
    }],
  },
];

const GH_EDITOR_LABELS = {
  name: "Name",
  tap_action: "Tap action (picture and text)",
  hold_action: "Hold action",
  lantern_tap_action: "Lantern tap action",
  lantern_hold_action: "Lantern hold action",
  out: "screen out (hem)",
  wind: "wind warning",
  ...Object.fromEntries(GH_ENTITY_FIELDS.map(([k, label]) => [k, label])),
  ...Object.fromEntries(GH_NUMBER_FIELDS.map(([k, label]) => [k, label])),
};

const GH_ACTION_KEYS = ["tap_action", "hold_action", "lantern_tap_action", "lantern_hold_action"];

class GardenviewHouseEditor extends HTMLElement {
  /* config -> form data: defaults filled in, null shown as empty. */
  static toData(config) {
    const ent = config.entities || {};
    const entities = {};
    for (const role of Object.keys(GH_DEFAULTS.entities)) {
      const v = role in ent ? ent[role] : GH_DEFAULTS.entities[role];
      entities[role] = v || "";
    }
    const data = {
      name: config.name == null ? GH_DEFAULTS.name : config.name,
      entities,
      colors: { ...(config.colors || {}) },
    };
    for (const k of GH_ACTION_KEYS) data[k] = config[k];
    for (const [k] of GH_NUMBER_FIELDS) {
      const v = ghNum(config[k]);
      data[k] = v == null ? GH_DEFAULTS[k] : v;
    }
    return data;
  }

  /* form data -> config: only what differs from the defaults. */
  static toConfig(data, previous) {
    const config = { type: "custom:gardenview-house" };
    const handled = ["type", "name", "entities", "colors", ...GH_ACTION_KEYS, ...GH_NUMBER_FIELDS.map(([k]) => k)];
    for (const [k, v] of Object.entries(previous || {})) {
      if (!handled.includes(k)) config[k] = v;
    }
    if (data.name != null && data.name !== GH_DEFAULTS.name) config.name = data.name;
    const entities = {};
    for (const [role, def] of Object.entries(GH_DEFAULTS.entities)) {
      const v = (data.entities || {})[role];
      if (!v) {
        if (def && !GH_REQUIRED.includes(role)) entities[role] = null;
      } else if (v !== def) entities[role] = v;
    }
    if (Object.keys(entities).length) config.entities = entities;
    for (const [k] of GH_NUMBER_FIELDS) {
      const v = ghNum(data[k]);
      if (v != null && v !== GH_DEFAULTS[k]) config[k] = v;
    }
    // retract_offset: null (hidden) is not shown in the form; keep it when it was set
    if (previous && previous.retract_offset === null && ghNum(data.retract_offset) === GH_DEFAULTS.retract_offset) config.retract_offset = null;
    for (const k of GH_ACTION_KEYS) if (data[k] && Object.keys(data[k]).length) config[k] = data[k];
    const colors = {};
    for (const [k, v] of Object.entries(data.colors || {})) {
      if (typeof v === "string" && v.trim()) colors[k] = v.trim();
    }
    if (Object.keys(colors).length) config.colors = colors;
    return config;
  }

  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  connectedCallback() {
    this._loadForm().then(() => this._render());
  }

  /* ha-form is lazy loaded by HA; load it through a built-in card's editor. */
  async _loadForm() {
    if (customElements.get("ha-form")) return;
    try {
      const helpers = await window.loadCardHelpers();
      const card = await helpers.createCardElement({ type: "entities", entities: [] });
      if (card.constructor.getConfigElement) await card.constructor.getConfigElement();
    } catch (_) {
      /* rendered as soon as HA has loaded it */
    }
    await customElements.whenDefined("ha-form");
  }

  _render() {
    if (!this._config || !customElements.get("ha-form")) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.schema = GH_EDITOR_SCHEMA;
      this._form.computeLabel = (s) => GH_EDITOR_LABELS[s.name] || s.name.replace(/_/g, " ");
      this._form.addEventListener("value-changed", (e) => {
        e.stopPropagation();
        const config = GardenviewHouseEditor.toConfig(e.detail.value, this._config);
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = GardenviewHouseEditor.toData(this._config);
  }
}

if (!customElements.get("gardenview-house")) {
  customElements.define("gardenview-house", GardenviewHouse);
}
if (!customElements.get("gardenview-house-editor")) {
  customElements.define("gardenview-house-editor", GardenviewHouseEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "gardenview-house")) {
  window.customCards.push({
    type: "gardenview-house",
    name: "Gardenview House",
    description: "The garden facade as a line drawing: sun screen at its real position, doors, lantern, wind and dark.",
    preview: true,
    documentationURL: "https://github.com/BarBaar44/gardenview-house",
  });
}

console.info(`%c GARDENVIEW-HOUSE %c ${VERSION} `, "background:#5d4037;color:#fff", "");
}
