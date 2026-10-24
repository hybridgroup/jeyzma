// advisor.js asks a model how to fly the drone to a target and shows the
// advice as arrows on the sticks and at the drone.
import "./app.js";
import * as THREE from "three";
import { STATE } from "./sim.js";

const $ = (id) => document.getElementById(id);
const { sim, view, joystick } = window.tinyflight;

// The sim works in NED. three.js is Y up, as in view.js.
const ned = (x, y, z) => new THREE.Vector3(y, -z, -x);

const NEAR = 0.15;
const NEAR_HEIGHT = 0.1;
const HOLD_MS = 2000;
const PAUSE_MS = 250;
const ORANGE = 0xf48122;
const GREEN = 0x2fbf71;

const params = new URLSearchParams(location.search);
const query = new URLSearchParams();
for (const key of ["mode", "gpu"]) {
  if (params.get(key)) query.set(key, params.get(key));
}
const worker = new Worker("../../worker.js" + (query.size ? "?" + query : ""));

let ready = false;
let downloading = false;
let thinking = false;
let timer = null;
let reached = 0;
let nearSince = 0;

for (const [i, entry] of MODELS.entries()) {
  $("preset").add(new Option(entry.name, String(i)));
}

function status(text, bad) {
  $("advisor-status").textContent = text;
  $("advisor-status").className = bad ? "bad" : "";
}

function bar(percent) {
  $("bar").hidden = percent < 0;
  $("bar").value = percent < 0 ? 0 : percent;
}

// The target is a ring at the height to hold, on a pole down to the floor.
const target = { north: 0, east: 0, height: 0 };
const ringMaterial = new THREE.MeshBasicMaterial({ color: GREEN });
const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.006, 8, 48), ringMaterial);
ring.rotation.x = Math.PI / 2;
const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 8), ringMaterial);
view.scene.add(ring, pole);

function placeTarget() {
  const angle = Math.random() * 2 * Math.PI;
  const dist = 0.5 + Math.random();
  const s = sim.state;
  target.north = s[STATE.pos] + Math.cos(angle) * dist;
  target.east = s[STATE.pos + 1] + Math.sin(angle) * dist;
  // Keep it within 1.5 m of the start.
  const len = Math.hypot(target.north, target.east);
  if (len > 1.5) {
    target.north *= 1.5 / len;
    target.east *= 1.5 / len;
  }
  target.height = 0.4 + Math.random() * 0.8;
  ring.position.copy(ned(target.north, target.east, -target.height));
  pole.scale.y = target.height;
  pole.position.copy(ned(target.north, target.east, -target.height / 2));
}

// look finds the heading and the target and speed in body terms.
function look() {
  const s = sim.state;
  const [w, x, y, z] = s.subarray(STATE.quat, STATE.quat + 4);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const c = Math.cos(yaw);
  const n = Math.sin(yaw);
  const body = (north, east) => [north * c + east * n, -north * n + east * c];
  const height = -s[STATE.pos + 2];
  const [ahead, right] = body(target.north - s[STATE.pos], target.east - s[STATE.pos + 1]);
  const [forwardSpeed, rightSpeed] = body(s[STATE.vel], s[STATE.vel + 1]);
  return {
    yaw,
    height,
    ahead,
    right,
    climb: target.height - height,
    forwardSpeed,
    rightSpeed,
    upSpeed: -s[STATE.vel + 2],
    armed: s[STATE.armed] > 0,
  };
}

const m = (v) => Math.abs(v).toFixed(2) + " m";
const ms = (v) => Math.abs(v).toFixed(2) + " m/s";

// describe turns the drone and the target into the state and the questions.
function describe(d) {
  const state = {
    drone: d.height < 0.05 ? "armed, on the ground" : "flying",
    height: m(d.height),
    "target height": m(target.height),
    target: [
      `${m(d.ahead)} ${d.ahead >= 0 ? "ahead" : "behind"}`,
      `${m(d.right)} to the ${d.right >= 0 ? "right" : "left"}`,
      `${m(d.climb)} ${d.climb >= 0 ? "higher" : "lower"}`,
    ].join(", "),
    moving: [
      `${ms(d.forwardSpeed)} ${d.forwardSpeed >= 0 ? "forward" : "back"}`,
      `${ms(d.rightSpeed)} ${d.rightSpeed >= 0 ? "right" : "left"}`,
      `${ms(d.upSpeed)} ${d.upSpeed >= 0 ? "up" : "down"}`,
    ].join(", "),
  };
  const questions = [
    {
      question: "Which way should the drone go up or down to reach the target height and stop there?",
      options: { up: "climb", hold: "stay at this height", down: "descend" },
    },
    {
      question: "Which way should the drone move forward or back to reach the target and stop there?",
      options: { forward: "move toward the nose", hold: "stay put front to back", back: "move toward the tail" },
    },
    {
      question: "Which way should the drone move left or right to reach the target and stop there?",
      options: { left: "move to the left", hold: "stay put side to side", right: "move to the right" },
    },
  ];
  return { state, questions };
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

function pointStick(el, x, y, confidence) {
  if (x === 0 && y === 0) {
    el.style.opacity = 0;
    return;
  }
  el.style.transform = `rotate(${Math.atan2(x, y)}rad)`;
  el.style.opacity = 0.35 + 0.65 * confidence;
}

function clearAdvice() {
  stickArrows.left.style.opacity = 0;
  stickArrows.right.style.opacity = 0;
  sceneArrow.visible = false;
}

const SIGN = { up: 1, forward: 1, right: 1, down: -1, back: -1, left: -1, hold: 0 };

// show draws the three answers on the sticks, at the drone, and in the pane.
function show(results, d) {
  const [throttle, pitch, roll] = results.map((r) => SIGN[r.answer] ?? 0);
  const sure = (r) => r.confidence ?? Math.max(...r.probabilities);
  pointStick(stickArrows.left, 0, throttle, sure(results[0]));
  pointStick(stickArrows.right, roll, pitch, Math.min(sure(results[1]), sure(results[2])));

  const north = pitch * Math.cos(d.yaw) - roll * Math.sin(d.yaw);
  const east = pitch * Math.sin(d.yaw) + roll * Math.cos(d.yaw);
  const dir = ned(north, east, -throttle);
  sceneArrow.visible = dir.lengthSq() > 0;
  if (sceneArrow.visible) sceneArrow.setDirection(dir.normalize());

  $("advice").replaceChildren(
    ...results.map((r, i) => {
      const row = document.createElement("div");
      row.className = r.answer === "hold" ? "hold" : "";
      row.innerHTML = "<span></span><span></span>";
      row.children[0].textContent = ["Height", "Front", "Side"][i] + " " + r.answer;
      row.children[1].textContent = sure(r).toFixed(3);
      return row;
    }),
  );
}

function hint(text) {
  clearAdvice();
  $("advice").replaceChildren(Object.assign(document.createElement("p"), { textContent: text }));
}

function ask(delay) {
  clearTimeout(timer);
  timer = setTimeout(askNow, delay);
}

function askNow() {
  if (!ready || thinking) return;
  if (!$("advise").checked) {
    hint("Advice is off.");
    return;
  }
  const d = look();
  if (joystick.screen === "setup") {
    hint("Press Space to leave setup, then press it again to arm.");
    ask(500);
    return;
  }
  if (!d.armed) {
    hint("Press Space to arm the drone.");
    ask(500);
    return;
  }
  const { state, questions } = describe(d);
  thinking = { d };
  worker.postMessage({ kind: "decide-many", state: JSON.stringify(state), questions: JSON.stringify(questions) });
}

// watch moves the arrow with the drone and checks for a reached target.
function watch(now) {
  const s = sim.state;
  sceneArrow.position.copy(ned(s[STATE.pos], s[STATE.pos + 1], s[STATE.pos + 2]));
  const d = look();
  const across = Math.hypot(d.ahead, d.right);
  $("distance").textContent = Math.hypot(across, d.climb).toFixed(2) + " m";
  if (across < NEAR && Math.abs(d.climb) < NEAR_HEIGHT && d.armed) {
    nearSince ||= now;
    if (now - nearSince > HOLD_MS) {
      reached++;
      $("reached").textContent = reached;
      nearSince = 0;
      placeTarget();
    }
  } else {
    nearSince = 0;
  }
  requestAnimationFrame(watch);
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
      status("model loaded, " + text);
      ask(0);
      break;
    case "result": {
      const out = JSON.parse(text);
      const turn = thinking;
      thinking = false;
      if (turn && $("advise").checked) {
        show(Array.isArray(out.result) ? out.result : [out.result], turn.d);
        status(`advised in ${out.ms} ms`);
      }
      ask(PAUSE_MS);
      break;
    }
    case "error":
      downloading = false;
      thinking = false;
      bar(-1);
      $("load").disabled = false;
      status(text, true);
      break;
  }
};

$("load").onclick = () => {
  if (downloading) return;
  const entry = MODELS[$("preset").value];
  ready = false;
  downloading = true;
  bar(0);
  $("load").disabled = true;
  status("waiting for the worker");
  worker.postMessage({ kind: "decide-load", url: entry.url, config: entry.config, readout: entry.readout });
};

$("advise").onchange = () => ask(0);

const pane = $("advisor");
$("advisor-toggle").onclick = () => pane.classList.toggle("open");
$("advisor-close").onclick = () => pane.classList.remove("open");

// Keep Space for the joystick screen, as app.js does for the header.
for (const el of pane.querySelectorAll("button, select, input")) {
  el.addEventListener("click", () => el.blur());
  el.addEventListener("change", () => el.blur());
}

placeTarget();
requestAnimationFrame(watch);
