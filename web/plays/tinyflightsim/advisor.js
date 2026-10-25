// advisor.js turns a typed instruction into flight steps with a model, then
// shows the way to each step as arrows on the sticks and at the drone.
import "./app.js";
import * as THREE from "three";
import { STATE } from "./sim.js";

const $ = (id) => document.getElementById(id);
const { sim, view, joystick } = window.tinyflight;

// The sim works in NED. three.js is Y up, as in view.js.
const ned = (x, y, z) => new THREE.Vector3(y, -z, -x);

const NEAR = 0.15;
const NEAR_HEIGHT = 0.1;
const HOLD_MS = 1000;
const HOME_HEIGHT = 0.4;
const LOW = 0.12;
const ORANGE = 0xf48122;
const RINGS = { red: 0xd8413a, blue: 0x2f6fd8, yellow: 0xe8c020, green: 0x2fbf71 };

const params = new URLSearchParams(location.search);
const query = new URLSearchParams();
for (const key of ["mode", "gpu"]) {
  if (params.get(key)) query.set(key, params.get(key));
}
const worker = new Worker("../../worker.js" + (query.size ? "?" + query : ""));

let ready = false;
let downloading = false;
let pending = null;
let plan = [];
let current = 0;
let nearSince = 0;
let disarming = false;

for (const [i, entry] of MODELS.entries()) {
  $("preset").add(new Option(entry.name, String(i)));
}
// Laya planned best in our tests.
$("preset").value = String(Math.max(0, MODELS.findIndex((e) => e.name.startsWith("Laya"))));

function status(text, bad) {
  $("advisor-status").textContent = text;
  $("advisor-status").className = bad ? "bad" : "";
}

function bar(percent) {
  $("bar").hidden = percent < 0;
  $("bar").value = percent < 0 ? 0 : percent;
}

// layout places the rings about a quarter turn apart, each at its own height and distance.
function layout() {
  const shuffle = (list) => list.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(([, v]) => v);
  const heights = shuffle([0.35, 0.6, 0.85, 1.1]);
  const dists = shuffle([0.9, 1.3, 1.7, 2.1]);
  const turn = Math.random() * 2 * Math.PI;
  const jitter = (size) => (Math.random() - 0.5) * size;
  const rings = {};
  Object.keys(RINGS).forEach((name, i) => {
    const angle = turn + (i * Math.PI) / 2 + jitter(0.6);
    const d = dists[i] + jitter(0.1);
    rings[name] = { north: Math.cos(angle) * d, east: Math.sin(angle) * d, height: heights[i] + jitter(0.08) };
  });
  return rings;
}

const rings = layout();
for (const [name, r] of Object.entries(rings)) {
  const material = new THREE.MeshBasicMaterial({ color: RINGS[name] });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.006, 8, 48), material);
  ring.rotation.x = Math.PI / 2;
  ring.position.copy(ned(r.north, r.east, -r.height));
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, r.height, 8), material);
  pole.position.copy(ned(r.north, r.east, -r.height / 2));
  view.scene.add(ring, pole);
}
const pad = new THREE.Mesh(new THREE.CircleGeometry(0.12, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
pad.rotation.x = -Math.PI / 2;
pad.position.y = 0.003;
view.scene.add(pad);

// look finds the heading, and a point's offset and the speed in body terms.
function look(north = 0, east = 0, height = 0) {
  const s = sim.state;
  const [w, x, y, z] = s.subarray(STATE.quat, STATE.quat + 4);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const c = Math.cos(yaw);
  const n = Math.sin(yaw);
  const body = (dn, de) => [dn * c + de * n, -dn * n + de * c];
  const [ahead, right] = body(north - s[STATE.pos], east - s[STATE.pos + 1]);
  const [forwardSpeed, rightSpeed] = body(s[STATE.vel], s[STATE.vel + 1]);
  return {
    yaw,
    ahead,
    right,
    climb: height + s[STATE.pos + 2],
    forwardSpeed,
    rightSpeed,
    upSpeed: -s[STATE.vel + 2],
    height: -s[STATE.pos + 2],
    armed: s[STATE.armed] > 0,
  };
}

const m = (v) => Math.abs(v).toFixed(1) + " m";

// ringOptions describes each ring from where the drone is now, standout facts first.
function ringOptions() {
  const seen = Object.fromEntries(Object.entries(rings).map(([name, r]) => [name, { ...look(r.north, r.east), height: r.height }]));
  const far = (o) => Math.hypot(o.ahead, o.right);
  const names = Object.keys(seen);
  const best = (f) => names.reduce((a, b) => (f(seen[b]) > f(seen[a]) ? b : a));
  const tags = { highest: best((o) => o.height), lowest: best((o) => -o.height), closest: best((o) => -far(o)), farthest: best(far) };
  const options = {};
  for (const name of names) {
    const o = seen[name];
    const mine = Object.keys(tags).filter((k) => tags[k] === name);
    const lead = mine.length ? `the ${mine.join(" and ")} ring, ${name}` : `the ${name} ring`;
    options[name] = `to ${lead}, ${o.ahead >= 0 ? "ahead" : "behind"} on the ${o.right >= 0 ? "right" : "left"}, ${m(o.height)} high, ${m(far(o))} away`;
  }
  options.home = "come back home to the pad where it took off";
  options.land = "down to the ground, to land and stop";
  return options;
}

// split cuts an instruction into parts, so the model reads one part at a time.
function split(text) {
  return text
    .split(/\s*,?\s*\b(?:and then|then|and)\b\s*|\s*[,.;]\s*/i)
    .map((c) => c.trim())
    .filter((c) => c && !/^first$/i.test(c));
}

function decide(state, question) {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    worker.postMessage({ kind: "decide", state: JSON.stringify(state), question: JSON.stringify(question) });
  });
}

async function makePlan() {
  const text = $("instruction").value.trim();
  if (!ready || pending || !text) return;
  $("plan").disabled = true;
  const options = ringOptions();
  const steps = [];
  try {
    for (const part of split(text)) {
      status(`reading "${part}"`);
      const out = await decide({ instruction: part }, { question: "Where does this instruction send the drone?", options });
      steps.push({ part, ...out.result });
    }
    status("planned, press Space twice to arm and fly");
  } catch (err) {
    status(String(err), true);
  }
  plan = steps;
  current = 0;
  nearSince = 0;
  disarming = false;
  $("plan").disabled = false;
  showPlan();
}

const STEP_TEXT = { home: "Fly home", land: "Land" };

function showPlan() {
  $("steps").replaceChildren(
    ...plan.map((step, i) => {
      const li = document.createElement("li");
      li.className = i < current ? "done" : i === current ? "now" : "";
      li.innerHTML = "<span></span><small></small>";
      const sure = step.confidence ?? Math.max(...step.probabilities);
      li.children[0].textContent = STEP_TEXT[step.answer] || `Fly to the ${step.answer} ring`;
      li.children[1].textContent = `"${step.part}" ${sure.toFixed(2)}`;
      return li;
    }),
  );
  if (plan.length && current >= plan.length) {
    const li = document.createElement("li");
    li.className = "done";
    li.textContent = "All done";
    $("steps").appendChild(li);
  }
}

// target is where the current step wants the drone.
function target() {
  const step = plan[current];
  if (!step) return null;
  if (rings[step.answer]) return rings[step.answer];
  const s = sim.state;
  if (step.answer === "land") return { north: s[STATE.pos], east: s[STATE.pos + 1], height: 0, land: true };
  return { north: 0, east: 0, height: HOME_HEIGHT };
}

// The stick arrows point up, and turn toward the advice.
const ARROW_SVG =
  '<svg viewBox="-50 -50 100 100"><path d="M0 -46 L20 -20 L7 -20 L7 0 L-7 0 L-7 -20 L-20 -20 Z" fill="#f48122" stroke="#fff" stroke-width="3"/></svg>';
const stickArrows = {};
for (const side of ["left", "right"]) {
  const el = document.createElement("div");
  el.className = "advice-arrow";
  el.innerHTML = ARROW_SVG;
  document.querySelector(`#joystick [data-stick=${side}]`).appendChild(el);
  stickArrows[side] = el;
}

const sceneArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.12, ORANGE, 0.04, 0.025);
sceneArrow.visible = false;
view.scene.add(sceneArrow);

function pointStick(el, x, y) {
  const size = Math.min(1, Math.hypot(x, y));
  el.style.opacity = size < 0.15 ? 0 : 0.4 + 0.6 * size;
  el.style.transform = `rotate(${Math.atan2(x, y)}rad)`;
}

// push turns an offset into a stick amount. It looks ahead by the speed so the drone slows near the target.
const push = (offset, speed) => Math.max(-1, Math.min(1, (offset - speed * 0.8) / 0.4));

// autopilot moves the sticks like a touch would, so the drone follows the advice itself.
function autopilot(on, throttle, pitch, roll) {
  for (const side of ["left", "right"]) {
    if (!on && joystick.touch[side]?.id === "autopilot") joystick.touch[side] = null;
  }
  if (!on) return;
  joystick.touch.left = { id: "autopilot", x: 0, y: throttle * 0.8 };
  joystick.touch.right = { id: "autopilot", x: roll * 0.3, y: pitch * 0.3 };
}

// showStage highlights the section the user works on next.
function showStage() {
  const stage = !ready ? "model" : current >= plan.length ? "instruction" : "fly";
  for (const el of document.querySelectorAll("#advisor .stage")) {
    el.classList.toggle("active", el.dataset.stage === stage);
  }
}

// fly works out the advice for the current step and moves the plan on when it is reached.
function fly(now) {
  const t = target();
  const d = t && look(t.north, t.east, t.height);
  let hint = "";
  if (!t) {
    hint = plan.length ? "" : "Type an instruction and press Plan.";
  } else if (joystick.screen === "setup") {
    hint = "Press Space to leave setup, then press it again to arm.";
  } else if (!d.armed) {
    hint = t.land ? "" : "Press Space to arm the drone.";
  } else if (t.land && d.height < LOW) {
    hint = "Press Space to disarm.";
    // The firmware has no land command, so the autopilot disarms near the ground.
    if ($("autopilot").checked && !disarming) {
      disarming = true;
      joystick.pressScreen();
    }
  }
  $("hint").textContent = hint;
  showStage();

  const active = t && d.armed;
  const advise = active && $("advise").checked;
  const throttle = active ? push(d.climb, d.upSpeed) : 0;
  const pitch = active && !t.land ? push(d.ahead, d.forwardSpeed) : 0;
  const roll = active && !t.land ? push(d.right, d.rightSpeed) : 0;
  pointStick(stickArrows.left, 0, advise ? throttle : 0);
  pointStick(stickArrows.right, advise ? roll : 0, advise ? pitch : 0);
  autopilot(active && $("autopilot").checked, throttle, pitch, roll);

  const s = sim.state;
  sceneArrow.position.copy(ned(s[STATE.pos], s[STATE.pos + 1], s[STATE.pos + 2]));
  const dir = advise ? ned(pitch * Math.cos(d.yaw) - roll * Math.sin(d.yaw), pitch * Math.sin(d.yaw) + roll * Math.cos(d.yaw), -throttle) : null;
  sceneArrow.visible = !!dir && dir.lengthSq() > 0.02;
  if (sceneArrow.visible) sceneArrow.setDirection(dir.normalize());

  if (t) {
    $("distance").textContent = Math.hypot(d.ahead, d.right, d.climb).toFixed(2) + " m";
    const there = t.land ? !d.armed : d.armed && Math.hypot(d.ahead, d.right) < NEAR && Math.abs(d.climb) < NEAR_HEIGHT;
    if (there) {
      nearSince ||= now;
      if (now - nearSince > HOLD_MS) {
        current++;
        nearSince = 0;
        disarming = false;
        showPlan();
      }
    } else {
      nearSince = 0;
    }
  } else {
    $("distance").textContent = "-";
  }
  requestAnimationFrame(fly);
}

worker.onmessage = (event) => {
  const { kind, text } = event.data || {};
  switch (kind) {
    case "ready":
      $("backend").textContent = text;
      status("ready, load a model");
      break;
    case "status":
      status(text);
      break;
    case "progress":
      bar(parseInt(text, 10));
      status("downloading the model " + text);
      break;
    case "loaded":
      ready = true;
      downloading = false;
      bar(-1);
      $("load").disabled = false;
      $("preset").disabled = false;
      $("plan").disabled = false;
      status("model loaded, " + text + ". Type an instruction and press Plan.");
      break;
    case "result": {
      const p = pending;
      pending = null;
      p?.resolve(JSON.parse(text));
      break;
    }
    case "error": {
      downloading = false;
      bar(-1);
      $("load").disabled = false;
      $("preset").disabled = false;
      const p = pending;
      pending = null;
      if (p) p.reject(text);
      else status(text, true);
      break;
    }
  }
};

$("load").onclick = () => {
  if (downloading) return;
  const entry = MODELS[$("preset").value];
  ready = false;
  downloading = true;
  bar(0);
  $("load").disabled = true;
  $("preset").disabled = true;
  $("plan").disabled = true;
  status("waiting for the worker");
  worker.postMessage({ kind: "decide-load", url: entry.url, config: entry.config, readout: entry.readout });
};

$("plan").onclick = () => makePlan();
$("instruction").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("instruction").blur();
    makePlan();
  }
});
for (const el of document.querySelectorAll("[data-example]")) {
  el.onclick = () => {
    $("instruction").value = el.textContent;
  };
}

const pane = $("advisor");
$("advisor-toggle").onclick = () => pane.classList.toggle("open");
$("advisor-close").onclick = () => pane.classList.remove("open");

// Keep Space for the joystick screen, as app.js does for the header.
for (const el of pane.querySelectorAll("button, select, input[type=checkbox]")) {
  el.addEventListener("click", () => el.blur());
  el.addEventListener("change", () => el.blur());
}

if (innerWidth > 700) pane.classList.add("open");
requestAnimationFrame(fly);
