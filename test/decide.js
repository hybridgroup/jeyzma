// decide.js runs Jeyzma in Node without a browser.
// DecideMany must match Decide in the exact mode, and --expect lists the answers.

const fs = require("node:fs");
const path = require("node:path");

function option(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const dir = path.resolve(option("dir", "build"));
const modelFile = option("model", "");
const configFile = option("config", "");
const readout = option("readout", "jev");
const manyMode = option("mode", "exact");
const state = option("state", '{"ticket": "I was charged twice for my subscription and want a refund."}');
const questions = option(
  "questions",
  JSON.stringify([
    { question: "Which team handles this?", options: { billing: "payments, invoices", technical: "bugs" } },
    { question: "The customer wants money back." },
    { type: "score", question: "How urgent is this?", options: ["low", "medium", "high"] },
  ]),
);
const category = option("category", "");
const expect = option("expect", "");
const mt = process.argv.includes("--mt");
const orders = process.argv.includes("--both") ? "both" : "";
const request = process.argv.includes("--request");

if (!modelFile || (!configFile && readout !== "gguf")) {
  console.error("give a model with --model and its config with --config, or use --readout gguf");
  process.exit(2);
}

// toRequest turns the state and the questions into a TypeSafe /v1/systemone request.
// The page has the same function.
function toRequest(state, questions) {
  let st = state;
  try {
    st = JSON.parse(state);
  } catch {}
  const out = {};
  questions.forEach((q, i) => {
    let type = q.type || (q.options ? "choice" : "noul");
    let criteria = q.options;
    if (type === "choice" && Array.isArray(criteria)) {
      criteria = Object.fromEntries(criteria.map((name) => [name, ""]));
    }
    out["q" + (i + 1)] = criteria === undefined ? { type, instructions: q.question } : { type, instructions: q.question, criteria };
  });
  return { state: st, questions: out };
}

let programIsReady;
const programReady = new Promise((resolve) => {
  programIsReady = resolve;
});

let onResult = () => {};
globalThis.yzmaOnMessage = (message) => {
  if (message.kind === "ready" || message.kind === "error") {
    programIsReady();
  }
  if (["loaded", "result", "answer", "error"].includes(message.kind)) {
    onResult(message);
  }
  if (message.kind !== "result" && message.kind !== "answer") {
    console.log("[" + message.kind + "] " + message.text);
  }
};

// next waits for the next loaded, result or error message.
function next() {
  return new Promise((resolve) => {
    onResult = (message) => {
      onResult = () => {};
      if (message.kind === "error") {
        console.error("error: " + message.text);
        process.exit(1);
      }
      resolve(message);
    };
  });
}

async function main() {
  // This harness replaces yzma-loader.js and uses a CPU build.
  const moduleName = mt ? "yzma_wasm_mt.js" : "yzma_wasm.js";
  globalThis.crossOriginIsolated = mt;
  globalThis.yzmaBase = dir;

  const factory = require(path.join(dir, moduleName));
  const threads = mt ? Math.max(1, Math.min(require("node:os").cpus().length, 16)) : 1;

  const llamaModule = await factory({
    locateFile: (file) => path.join(dir, file),
    print: () => {},
    printErr: () => {},
    pthreadPoolSize: threads,
  });

  globalThis.yzmaModule = llamaModule;
  globalThis.yzmaReady = Promise.resolve(llamaModule);
  globalThis.yzmaThreaded = mt;
  globalThis.yzmaThreads = threads;
  globalThis.yzmaBackend = mt ? "cpu-threads" : "cpu";

  llamaModule.FS.mkdirTree("/models");
  llamaModule.FS.writeFile("/models/decide.gguf", fs.readFileSync(modelFile));

  require(path.join(dir, "wasm_exec.js"));

  const go = new Go();
  const binary = fs.readFileSync(path.join(dir, "yzma.wasm"));
  const result = await WebAssembly.instantiate(binary, go.importObject);
  go.run(result.instance);
  await programReady;

  const loaded = next();
  const config = configFile ? fs.readFileSync(configFile, "utf8") : "";
  globalThis.yzmaDecideOpen("/models/decide.gguf", config, readout, manyMode, orders);
  await loaded;

  const many = next();
  globalThis.yzmaDecideMany(state, questions, category);
  const manyOut = JSON.parse((await many).text);

  const oneOut = [];
  for (const q of JSON.parse(questions)) {
    const one = next();
    globalThis.yzmaDecide(state, JSON.stringify(q), category);
    oneOut.push(JSON.parse((await one).text));
  }

  // A second call reuses the state, and the first one also warms up the module.
  const again = next();
  globalThis.yzmaDecideMany(state, questions, category);
  const againOut = JSON.parse((await again).text);

  console.log(JSON.stringify({ many: manyOut, one: oneOut, again: { ms: againOut.ms } }, null, 2));

  let failed = false;
  manyOut.result.forEach((r, i) => {
    const alone = oneOut[i].result;
    const same = r.probabilities.every((p, k) => p === alone.probabilities[k]);
    if (manyMode === "exact" && !same) {
      console.error("question " + i + ": DecideMany and Decide differ in the exact mode");
      failed = true;
    }
  });
  if (request) {
    const asked = JSON.parse(questions);
    const ans = next();
    globalThis.yzmaAnswer(JSON.stringify(toRequest(state, asked)));
    const out = JSON.parse((await ans).text);
    console.log(JSON.stringify(out, null, 2));

    // Answer uses DecideMany with no category, so it must agree with it.
    asked.forEach((q, i) => {
      const a = out.response.answers["q" + (i + 1)];
      const r = manyOut.result[i];
      const ok = !a ? false : a.type === "noul" ? category !== "" || a.noul === r.probabilities[r.options.indexOf("true")] : a.type === "choice" ? a.choice === r.answer : a.score === r.expected;
      if (!ok) {
        console.error("question " + i + ": the /v1/systemone answer differs from DecideMany");
        failed = true;
      }
    });
  }
  if (expect) {
    const want = expect.split(",");
    manyOut.result.forEach((r, i) => {
      if (want[i] !== undefined && r.answer !== want[i]) {
        console.error("question " + i + ": answer " + r.answer + ", want " + want[i]);
        failed = true;
      }
    });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
