// Tests for gardenview-house.js in a simulated browser. Run: npm test
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
const src = fs.readFileSync(path.join(__dirname, "..", "gardenview-house.js"), "utf8");
w.eval(src);
w.eval(src); // loading twice as a classic script must not throw (no top-level name clashes)
const Card = w.customElements.get("gardenview-house");
const Editor = w.customElements.get("gardenview-house-editor");
assert(Card && Editor, "registered");

const MIN = 60000;
const at = (min) => new Date(Date.now() + min * MIN).toISOString();
const st = (state, attributes = {}) => ({ state: String(state), attributes, last_changed: at(0), last_updated: at(0) });

/* Bb's entities; o: cs (cover state), pos, sun, setIn (min to sunset), gust, unit, t, extra. */
const states = (o = {}) => ({
  "cover.sun_screen": st(o.cs || "open", o.pos === null ? { supported_features: 15 } : { current_position: o.pos ?? 100, supported_features: 15 }),
  "sun.sun": st(o.sun || "above_horizon", { elevation: 38.4, next_setting: at(o.setIn ?? 300) }),
  "sensor.outdoor_temperature": st(o.t ?? 21, { unit_of_measurement: "°C" }),
  "sensor.openweathermap_wind_gust_speed": st(o.gust ?? 12, { unit_of_measurement: o.unit || "km/h" }),
  ...(o.extra || {}),
});
const hass = (s) => ({ states: s, language: "en", locale: { language: "en" }, config: { time_zone: "UTC" } });

function render(s, config = {}) {
  const c = new Card();
  w.document.body.appendChild(c);
  c.setConfig(config);
  c.hass = hass(s);
  return c;
}
function read(c) {
  const e = c._el;
  return {
    big: e.big.textContent,
    line: e.line.textContent,
    warn: e.line.classList.contains("warn"),
    up: !e.up.disabled, stop: !e.stop.disabled, down: !e.down.disabled,
    hot: e.up.classList.contains("hot"),
    dark: e.card.classList.contains("dark"),
    windy: e.card.classList.contains("windy"),
    scene: e.scene.innerHTML,
  };
}
function actions(c) {
  const got = [];
  c.addEventListener("hass-action", (ev) => got.push(ev.detail));
  return got;
}
const clock = (iso) => new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(iso));

// Objects made inside jsdom's window come from another realm: compare as plain data.
const same = (a, b, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), msg);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("retracted: words, sun and temperature; up off, stop always on", () => {
  const r = read(render(states()));
  assert.strictEqual(r.big, "Retracted");
  assert.strictEqual(r.line, "Sun 38° · 21 °C");
  assert(!r.up && r.stop && r.down);
  assert(!/class="cloth/.test(r.scene), "no cloth when retracted");
});

test("out: position 40 reads 60 % out, auto retract time from next_setting minus 2 h", () => {
  const s = states({ pos: 40, setIn: 180 }); // sunset in 3 h, retract in 1 h (same UTC day unless near midnight)
  const r = read(render(s));
  assert.strictEqual(r.big, "60% out");
  const due = new Date(Date.parse(s["sun.sun"].attributes.next_setting) - 120 * MIN);
  const sameDay = due.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  assert.strictEqual(r.line, sameDay ? `Up at ${clock(due.toISOString())}` : "No auto up");
  assert(r.up && r.stop && r.down);
  assert(/class="cloth"/.test(r.scene));
  assert(/class="hem"/.test(r.scene));
});

test("out after the retract time has passed: No auto up", () => {
  assert.strictEqual(read(render(states({ pos: 70, setIn: 60 }))).line, "No auto up"); // sunset in 1 h: retract was 1 h ago
  assert.strictEqual(read(render(states({ pos: 70, setIn: 60 * 20, sun: "below_horizon" }))).line, "No auto up"); // tomorrow
});

test("retract_offset null hides the line; a custom offset is used", () => {
  assert.strictEqual(read(render(states({ pos: 50, setIn: 600 }), { retract_offset: null })).line, "");
  const s = states({ pos: 50, setIn: 600 });
  const r = read(render(s, { retract_offset: 590 }));
  const due = new Date(Date.parse(s["sun.sun"].attributes.next_setting) - 590 * MIN);
  const sameDay = due.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  assert.strictEqual(r.line, sameDay ? `Up at ${clock(due.toISOString())}` : "No auto up");
});

test("fully out: down off", () => {
  const r = read(render(states({ cs: "closed", pos: 0 })));
  assert.strictEqual(r.big, "100% out");
  assert(r.up && !r.down);
});

test("no current_position: state decides (closed = fully out)", () => {
  assert.strictEqual(read(render(states({ cs: "closed", pos: null }))).big, "100% out");
  assert.strictEqual(read(render(states({ cs: "open", pos: null }))).big, "Retracted");
});

test("opening/closing states (other integrations): Lowering and Raising", () => {
  let r = read(render(states({ cs: "closing", pos: 60 })));
  assert.strictEqual(r.big, "Lowering…");
  assert.strictEqual(r.line, "40 % out");
  assert(r.stop && r.up && r.down);
  r = read(render(states({ cs: "opening", pos: 60 })));
  assert.strictEqual(r.big, "Raising…");
});

/* A card on a fake clock: motion_blinds jumps to the target at once. */
function clocked(s, config) {
  const c = new Card();
  let now = 1e12;
  c._now = () => now;
  c.tick = (ms) => { now += ms; c._update(); };
  w.document.body.appendChild(c);
  c.setConfig(config || {});
  c.hass = hass(s);
  return c;
}

test("travel: a card command shows Lowering for travel_time, though the cover jumps to the target", () => {
  const c = clocked(states({ pos: 100 }));
  c._el.down.click();
  let r = read(c);
  assert.strictEqual(r.big, "Lowering…");
  assert.strictEqual(r.line, "0 → 100 % out");
  assert(/class="ghost"/.test(r.scene));
  assert(c._el.card.classList.contains("moving"));
  c.hass = hass(states({ cs: "closed", pos: 0 })); // the jump
  assert.strictEqual(read(c).big, "Lowering…", "still travelling after the jump");
  c.tick(7500); // half of 15 s
  r = read(c);
  assert.strictEqual(r.line, "50 → 100 % out");
  assert(r.up && r.down && r.stop, "up and down stay on while travelling");
  c.tick(8000);
  r = read(c);
  assert.strictEqual(r.big, "100% out");
  assert(!r.down && r.up && r.stop);
  assert(!/class="ghost"/.test(r.scene));
  c.hass = hass({ ...states({ cs: "closed", pos: 0 }), "sun.sun": st("above_horizon", { elevation: 30 }) });
  assert.strictEqual(read(c).big, "100% out", "a later update does not start a travel");
});

test("travel: duration follows the distance; set position from the drag", () => {
  const c = clocked(states({ pos: 100 }));
  const got = actions(c);
  c._setOut(25);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got[0].config.tap_action.data)), { position: 75 });
  c.hass = hass(states({ pos: 75 }));
  c.tick(2000);
  assert.strictEqual(read(c).big, "Lowering…", "25 % of 15 s is 3.75 s");
  c.tick(2000);
  assert.strictEqual(read(c).big, "25% out");
});

test("travel: a jump the card did not cause (automation, remote) also travels", () => {
  const c = clocked(states({ pos: 40 }));
  c.hass = hass(states({ pos: 100 })); // evening automation retracts
  const r = read(c);
  assert.strictEqual(r.big, "Raising…");
  assert.strictEqual(r.line, "60 → 0 % out");
  c.tick(10000);
  assert.strictEqual(read(c).big, "Retracted");
  c.tick(1000);
  c.hass = hass(states({ pos: 100, t: 22 }));
  assert.strictEqual(read(c).big, "Retracted");
});

test("travel: positions polled while the motor runs do not end the travel", () => {
  const c = clocked(states({ pos: 100 }));
  c._el.down.click(); // retracted -> 100 % out, 15 s
  c.hass = hass(states({ cs: "closed", pos: 0 })); // the jump to the target
  c.tick(2000);
  c.hass = hass(states({ pos: 100 })); // first poll: still reads the start (0 % out)
  let r = read(c);
  assert.strictEqual(r.big, "Lowering…", "not Retracted");
  assert.strictEqual(r.line, "0 → 100 % out");
  c.tick(6000);
  c.hass = hass(states({ pos: 55 })); // poll: 45 % out
  r = read(c);
  assert.strictEqual(r.big, "Lowering…");
  assert.strictEqual(r.line, "45 → 100 % out", "re-anchored on the real position");
  c.tick(4125); // half of the 55 % left (8.25 s)
  assert.strictEqual(read(c).line, "73 → 100 % out");
  c.hass = hass(states({ cs: "closed", pos: 0 })); // final position = target: still travelling
  assert.strictEqual(read(c).big, "Lowering…");
  c.tick(4200);
  assert.strictEqual(read(c).big, "100% out");
});

test("travel: raising, a stale poll does not jump to Retracted early", () => {
  const c = clocked(states({ cs: "closed", pos: 0 }));
  c._el.up.click(); // 100 % out -> retracted
  c.hass = hass(states({ pos: 100 })); // the jump to retracted
  c.tick(3000);
  c.hass = hass(states({ pos: 15 })); // poll: 85 % out
  const r = read(c);
  assert.strictEqual(r.big, "Raising…");
  assert.strictEqual(r.line, "85 → 0 % out");
  assert(!/>Retracted</.test(c._el.big.outerHTML));
});

test("travel: the motor stopped early (remote): the window ends on the last reported position", () => {
  const c = clocked(states({ pos: 100 }));
  c._el.down.click();
  c.hass = hass(states({ cs: "closed", pos: 0 }));
  c.tick(6000);
  c.hass = hass(states({ pos: 55 })); // stopped at 45 % out
  assert.strictEqual(read(c).big, "Lowering…", "the card cannot tell a stop from a poll yet");
  c.tick(9000); // 55 % of 15 s = 8.25 s
  const r = read(c);
  assert.strictEqual(r.big, "45% out");
  assert(!c._el.card.classList.contains("moving"));
});

test("stop: always on; holds the estimated position until the motor reports", () => {
  const c = clocked(states({ pos: 100 }));
  const got = actions(c);
  c._el.down.click();
  c.hass = hass(states({ cs: "closed", pos: 0 }));
  c.tick(6000); // 40 %
  c._el.stop.click();
  assert.strictEqual(got[got.length - 1].config.tap_action.perform_action, "cover.stop_cover");
  let r = read(c);
  assert.strictEqual(r.big, "40% out", "held, not the reported target");
  c.tick(1000);
  c.hass = hass(states({ pos: 62 })); // real position after the stop
  r = read(c);
  assert.strictEqual(r.big, "38% out");
  assert(!c._el.card.classList.contains("moving"), "not a new travel");
  const still = clocked(states({ pos: 70 }));
  assert(read(still).stop, "stop on while still");
});

test("unavailable: every button off, words", () => {
  const r = read(render(states({ cs: "unavailable" })));
  assert.strictEqual(r.big, "Unavailable");
  assert(!r.up && !r.stop && !r.down);
  assert(read(render({})).big === "Unavailable", "missing entity");
});

test("wind: gusts at the threshold warn, up highlighted only while out; m/s converted", () => {
  let r = read(render(states({ pos: 0, cs: "closed", gust: 52 })));
  assert.strictEqual(r.line, "Gusts 52 km/h");
  assert(r.warn && r.hot && r.windy);
  assert(/class="cloth flap"/.test(r.scene));
  r = read(render(states({ gust: 52 })));
  assert(r.windy && !r.hot, "retracted: no hot button");
  r = read(render(states({ pos: 50, gust: 39 })));
  assert(!r.windy);
  r = read(render(states({ pos: 50, gust: 12, unit: "m/s" }))); // 43 km/h
  assert.strictEqual(r.line, "Gusts 43 km/h");
  r = read(render(states({ pos: 50, gust: 60 }), { wind_warning: 70 }));
  assert(!r.windy, "custom threshold");
});

test("dark: sun below the horizon by default; a binary sensor or illuminance overrides", () => {
  assert(!read(render(states())).dark);
  let r = read(render(states({ sun: "below_horizon" })));
  assert(r.dark);
  assert.strictEqual(r.line, "21 °C", "no sun elevation in the dark");
  const bs = (v) => ({ "binary_sensor.dark": st(v) });
  assert(read(render(states({ extra: bs("on") }), { entities: { dark: "binary_sensor.dark" } })).dark);
  assert(!read(render(states({ sun: "below_horizon", extra: bs("off") }), { entities: { dark: "binary_sensor.dark" } })).dark);
  const lx = (v) => ({ "sensor.lux": st(v, { unit_of_measurement: "lx" }) });
  assert(read(render(states({ extra: lx(5) }), { entities: { dark: "sensor.lux" } })).dark);
  assert(!read(render(states({ extra: lx(20) }), { entities: { dark: "sensor.lux" } })).dark, "default threshold 10 lx");
  assert(!read(render(states({ extra: lx(800) }), { entities: { dark: "sensor.lux" } })).dark);
  assert(read(render(states({ extra: lx(20) }), { entities: { dark: "sensor.lux" }, dark_below: 50 })).dark, "custom threshold");
  r = read(render(states({ sun: "below_horizon", extra: lx("unavailable") }), { entities: { dark: "sensor.lux" } }));
  assert(r.dark, "unavailable sensor: falls back to the sun");
});

test("doors: open doors show a room; one sensor opens both garden leaves", () => {
  const ent = { garden_door: "binary_sensor.garden", kitchen_door: "binary_sensor.kitchen" };
  const s = (g, k) => states({ extra: { "binary_sensor.garden": st(g), "binary_sensor.kitchen": st(k) } });
  assert.strictEqual((read(render(s("off", "off"), { entities: ent })).scene.match(/<clipPath/g) || []).length, 0);
  assert.strictEqual((read(render(s("on", "off"), { entities: ent })).scene.match(/<clipPath/g) || []).length, 2);
  assert.strictEqual((read(render(s("off", "on"), { entities: ent })).scene.match(/<clipPath/g) || []).length, 1);
  const two = { ...ent, garden_door_2: "binary_sensor.garden2" };
  const s2 = states({ extra: { "binary_sensor.garden": st("on"), "binary_sensor.garden2": st("off"), "binary_sensor.kitchen": st("off") } });
  assert.strictEqual((read(render(s2, { entities: two })).scene.match(/<clipPath/g) || []).length, 1, "second leaf has its own sensor");
});

test("defaults: Bb's lantern and door sensors work with no config", () => {
  const s = states({ extra: {
    "light.rear_garden": st("on"),
    "binary_sensor.door_sensor_garden_doors_contact": st("on", { device_class: "window" }),
    "binary_sensor.door_sensor_kitchen_contact": st("on", { device_class: "window" }),
    "sensor.outdoor_sensor_illuminance": st(4, { unit_of_measurement: "lx" }),
  } });
  const r = read(render(s));
  assert.strictEqual((r.scene.match(/<clipPath/g) || []).length, 3, "both garden leaves and the kitchen door");
  assert(/fill="#ffd54f" class="pane"/.test(r.scene));
  assert(r.dark, "4 lx is below the default 10 lx");
});

test("indoor lights: in the dark a room glows only while its light is on", () => {
  const ent = { dining_light: "light.dining", kitchen_light: "light.kitchen", lantern: null };
  const amber = (r) => (r.scene.match(/fill="#ffb74d"/g) || []).length;
  const s = (d, k) => states({ sun: "below_horizon", extra: { "light.dining": st(d), "light.kitchen": st(k) } });
  const all = amber(read(render(s("on", "on"), { entities: ent })));
  const none = amber(read(render(s("off", "off"), { entities: ent })));
  const kOnly = amber(read(render(s("off", "on"), { entities: ent })));
  assert.strictEqual(none, 0, "all dark");
  assert(kOnly > 0 && kOnly < all, `kitchen only: ${kOnly} of ${all}`);
  // without light entities: lit whenever it is dark (as before)
  assert.strictEqual(amber(read(render(states({ sun: "below_horizon" }), { entities: { lantern: null } }))), all);
  // daytime: never amber, lights or not
  assert.strictEqual(amber(read(render(states({ extra: { "light.dining": st("on"), "light.kitchen": st("on") } }), { entities: ent }))), 0);
  // an open door onto an unlit room shows it dimmed
  const open = states({ sun: "below_horizon", extra: { "light.dining": st("off"), "light.kitchen": st("off"),
    "binary_sensor.door_sensor_garden_doors_contact": st("on") } });
  assert(/filter:brightness\(\.3\)/.test(read(render(open, { entities: ent })).scene));
});

test("lantern: pane lit while on; tap area hidden without an entity", () => {
  const ent = { lantern: "light.lantern" };
  const on = render(states({ extra: { "light.lantern": st("on") } }), { entities: ent });
  assert(/fill="#ffd54f" class="pane"/.test(read(on).scene));
  const off = render(states({ extra: { "light.lantern": st("off") } }), { entities: ent });
  assert(/fill="#555" class="pane"/.test(read(off).scene));
  assert.strictEqual(off._el.hit.style.display, "");
  assert.strictEqual(render(states(), { entities: { lantern: null } })._el.hit.style.display, "none");
});

test("buttons: open, close and stop through hass-action perform-action", () => {
  const c = render(states({ pos: 50 }));
  const got = actions(c);
  c._el.up.click();
  c._el.stop.click();
  c._el.down.click();
  same(got.map((d) => d.config.tap_action.perform_action), ["cover.open_cover", "cover.stop_cover", "cover.close_cover"]);
  same(got[0].config.tap_action.target, { entity_id: "cover.sun_screen" });
  const off = render(states());
  const none = actions(off);
  off._el.up.click(); // disabled: retracted
  assert.strictEqual(none.length, 0);
});

test("set position: % out turns into position, drag snaps to quarters", () => {
  const c = render(states());
  const got = actions(c);
  c._setOut(75);
  assert.strictEqual(got[0].config.tap_action.perform_action, "cover.set_cover_position");
  same(got[0].config.tap_action.data, { position: 25 });
  // drag: relative to where the screen is, 100 px for the whole range, snapping
  same([c._dragOut(0, 0), c._dragOut(0, 50), c._dragOut(0, 23), c._dragOut(0, 33), c._dragOut(60, -100), c._dragOut(60, 100)], [0, 50, 25, 35, 0, 100]);
});

test("tap and hold: picture and text open the screen, lantern toggles", () => {
  const c = render(states({ extra: { "light.lantern": st("off") } }), { entities: { lantern: "light.lantern" } });
  const got = actions(c);
  c._run(c._config.tap_action, "tap");
  c._run(c._config.lantern_tap_action, "tap", "light.lantern");
  assert.strictEqual(got[0].config.tap_action.action, "more-info");
  assert.strictEqual(got[0].config.entity, "cover.sun_screen");
  assert.strictEqual(got[1].config.tap_action.action, "toggle");
  assert.strictEqual(got[1].config.entity, "light.lantern");
  const kd = new w.KeyboardEvent("keydown", { key: "Enter" });
  c._el.txt.dispatchEvent(kd);
  assert.strictEqual(got[2].config.tap_action.action, "more-info");
});

test("picture is redrawn only when something in it changes", () => {
  const c = render(states({ pos: 50 }));
  const first = c._el.scene.firstChild;
  c.hass = hass({ ...states({ pos: 50 }), "sensor.outdoor_temperature": st(22, { unit_of_measurement: "°C" }) });
  assert.strictEqual(c._el.scene.firstChild, first, "temperature: text only");
  c.hass = hass(states({ pos: 40 }));
  assert.notStrictEqual(c._el.scene.firstChild, first);
});

test("config errors", () => {
  const bad = (cfg, re) => assert.throws(() => new Card().setConfig(cfg), re);
  bad({ colour: {} }, /Unknown option 'colour'/);
  bad({ entities: { screen: "cover.x" } }, /unknown role 'screen'/);
  bad({ entities: { cover: "Sun screen" } }, /not an entity id/);
  bad({ entities: { cover: null } }, /cover is required/);
  bad({ wind_warning: 0 }, /wind_warning/);
  bad({ dark_below: "x" }, /dark_below/);
  bad({ travel_time: 0 }, /travel_time/);
  bad({ tap_action: "toggle" }, /tap_action must be an action/);
  bad({ colors: ["orange"] }, /colors must be a map/);
  new Card().setConfig({ grid_options: { columns: 12, rows: 2 }, colors: { out: "red" } });
});

test("colours: keys set CSS variables", () => {
  const c = render(states(), { colors: { out: "red", wind: " #ff0 " } });
  assert.strictEqual(c.style.getPropertyValue("--gh-out"), "red");
  assert.strictEqual(c.style.getPropertyValue("--gh-wind"), "#ff0");
});

test("editor: defaults round trip to a bare config", () => {
  const data = Editor.toData({});
  assert.strictEqual(data.entities.cover, "cover.sun_screen");
  assert.strictEqual(data.entities.lantern, "light.rear_garden");
  assert.strictEqual(data.entities.dark, "sensor.outdoor_sensor_illuminance");
  assert.strictEqual(data.dark_below, 10);
  assert.strictEqual(data.travel_time, 15);
  assert.strictEqual(data.wind_warning, 40);
  same(Editor.toConfig(data, { type: "custom:gardenview-house" }), { type: "custom:gardenview-house" });
});

test("editor: only differences written, cleared default entity becomes null, unknown keys kept", () => {
  const prev = { type: "custom:gardenview-house", grid_options: { columns: 12, rows: 2 } };
  const data = Editor.toData(prev);
  data.entities.temperature = "";
  data.entities.lantern = "light.lantern";
  data.entities.cover = "";
  data.wind_warning = 50;
  data.name = "Zonnescherm";
  const cfg = Editor.toConfig(data, prev);
  same(cfg, {
    type: "custom:gardenview-house",
    grid_options: { columns: 12, rows: 2 },
    name: "Zonnescherm",
    entities: { temperature: null, lantern: "light.lantern" },
    wind_warning: 50,
  });
  new Card().setConfig(cfg); // accepted by the card
  same(Editor.toConfig(Editor.toData(cfg), cfg), cfg, "stable");
});

test("editor: retract_offset null survives, actions and colours written", () => {
  const prev = { type: "custom:gardenview-house", retract_offset: null };
  const data = Editor.toData(prev);
  data.lantern_tap_action = { action: "more-info" };
  data.colors = { out: "red", wind: "" };
  const cfg = Editor.toConfig(data, prev);
  assert.strictEqual(cfg.retract_offset, null);
  same(cfg.lantern_tap_action, { action: "more-info" });
  same(cfg.colors, { out: "red" });
  new Card().setConfig(cfg);
});

test("grid size and card picker", () => {
  const c = new Card();
  same(c.getGridOptions(), { columns: 12, rows: 2, min_columns: 6, min_rows: 2 });
  assert(w.customCards.some((x) => x.type === "gardenview-house"));
  assert.strictEqual(w.customCards.filter((x) => x.type === "gardenview-house").length, 1);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}\n     ${e.stack.split("\n").slice(0, 3).join("\n     ")}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
