// sound.js plays a motor hum that follows the four motor commands.
import "./app.js";
import { STATE } from "./sim.js";

const $ = (id) => document.getElementById(id);
const { sim } = window.tinyflight;

let audio = null;
let motors = [];
let on = true;

// start makes the sound on the first touch or key, since browsers block audio before that.
function start() {
  if (audio) return;
  audio = new AudioContext();
  const out = audio.createGain();
  out.gain.value = 0.2;
  out.connect(audio.destination);
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1800;
  filter.connect(out);
  motors = [0, 1, 2, 3].map(() => {
    const osc = audio.createOscillator();
    osc.type = "sawtooth";
    const gain = audio.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(filter);
    osc.start();
    return { osc, gain };
  });
}

function update() {
  if (audio) {
    const s = sim.state;
    const running = on && sim.ctrl[0] > 0;
    const t = audio.currentTime;
    motors.forEach(({ osc, gain }, i) => {
      const cmd = running ? Math.max(0, Math.min(1, s[STATE.motors + i])) : 0;
      // A small offset per motor gives the beat of four props.
      osc.frequency.setTargetAtTime(120 + cmd * 520 + i * 2, t, 0.04);
      gain.gain.setTargetAtTime(cmd > 0.01 ? 0.1 + cmd * 0.15 : 0, t, 0.04);
    });
  }
  requestAnimationFrame(update);
}

addEventListener("pointerdown", start);
addEventListener("keydown", start);
document.addEventListener("visibilitychange", () => {
  if (audio) document.hidden ? audio.suspend() : audio.resume();
});

$("sound").onclick = () => {
  on = !on;
  $("sound").textContent = on ? "Sound off" : "Sound on";
};

requestAnimationFrame(update);
