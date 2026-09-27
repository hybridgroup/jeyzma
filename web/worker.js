// worker.js runs llama.cpp and the Go program in a Web Worker.
// Every call into llama.cpp is synchronous, so this work would stop the page.

// The multithreaded build runs this script again for each thread. Those
// workers are named "em-pthread" and must only load llama.cpp.
const isThread = globalThis.name === "em-pthread";

self.yzmaBase = ".";

// The page picks the backend with ?mode=auto, webgpu, or cpu and the GPU with
// ?gpu=high-performance or low-power on this worker URL.
const workerQuery = new URLSearchParams((self.location.search || "").slice(1));
if (workerQuery.get("mode")) {
  self.yzmaMode = workerQuery.get("mode");
}
if (workerQuery.get("gpu")) {
  self.yzmaPowerPreference = workerQuery.get("gpu");
}

// Threads always use the CPU. This avoids asking the browser about the GPU
// once per thread, which is slow.
if (isThread) {
  self.yzmaMode = "cpu";
}

importScripts("./yzma-loader.js");

if (!isThread) {
  // Send uncaught errors to the page.
  self.onerror = (event) => {
    self.postMessage({ kind: "error", text: String((event && event.message) || event) });
  };
  self.onunhandledrejection = (event) => {
    self.postMessage({ kind: "error", text: String((event && event.reason) || event) });
  };

  importScripts("./wasm_exec.js");

  // The Go program sends a "ready" message once its functions are set.
  // Starting the backend takes much longer with WebGPU.
  let programIsReady;
  const programReady = new Promise((resolve) => {
    programIsReady = resolve;
  });

  const sendToPage = self.postMessage.bind(self);
  self.postMessage = (message) => {
    if (message && (message.kind === "ready" || message.kind === "error")) {
      programIsReady();
    }
    sendToPage(message);
  };

  const started = (async () => {
    // llama.cpp must be ready before the Go program calls Load.
    await self.yzmaReady;

    const go = new Go();
    const result = await WebAssembly.instantiateStreaming(fetch("./yzma.wasm"), go.importObject);

    // The Go program blocks at the end of main, so do not wait for this.
    go.run(result.instance);

    await programReady;

    if (typeof self.yzmaDecideLoad !== "function") {
      throw new Error("the Go program did not set its functions");
    }
  })();

  self.onmessage = async (event) => {
    const message = event.data || {};

    try {
      await started;

      switch (message.kind) {
        case "decide-load":
          self.yzmaDecideLoad(message.url, message.config, message.readout, message.manyMode || "");
          break;
        case "decide":
          self.yzmaDecide(message.state, message.question, message.category || "");
          break;
        case "decide-many":
          self.yzmaDecideMany(message.state, message.questions, message.category || "");
          break;
        default:
          self.postMessage({ kind: "error", text: "unknown message: " + message.kind });
      }
    } catch (err) {
      self.postMessage({ kind: "error", text: String(err) });
    }
  };
}
