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

  let cachedURL = null;

  // The model cache keeps each downloaded model in the origin private file
  // system, so a later visit loads it without the network.
  async function cacheName(url) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("") + ".gguf";
  }

  // cachedModel returns a blob URL for the model in the cache. It downloads
  // the model into the cache first if needed, and returns null on any failure.
  async function cachedModel(url) {
    let writable;
    try {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(await cacheName(url), { create: true });

      // createWritable only commits on close, so an empty file is a download that did not finish.
      const file = await handle.getFile();
      if (file.size > 0) {
        return URL.createObjectURL(file);
      }

      // Firefox aborts a model stream that it also writes to the HTTP cache.
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok || !response.body) return null;

      const encoded = response.headers.get("content-encoding");
      const total = parseInt(response.headers.get("content-length") || "0", 10);

      self.postMessage({ kind: "status", text: "downloading the model" });
      writable = await handle.createWritable();
      const reader = response.body.getReader();
      let done = 0;
      let shown = -1;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        await writable.write(chunk.value);
        done += chunk.value.length;
        const percent = total > 0 ? Math.floor((done * 100) / total) : -1;
        if (percent !== shown && percent >= 0) {
          shown = percent;
          self.postMessage({ kind: "progress", text: percent + "%" });
        }
      }
      if (total > 0 && !encoded && done !== total) {
        throw new Error("the model download ended early");
      }
      await writable.close();
      writable = null;

      return URL.createObjectURL(await handle.getFile());
    } catch (err) {
      if (writable) await writable.abort().catch(() => {});
      console.warn("model cache:", err);
      return null;
    }
  }

  self.onmessage = async (event) => {
    const message = event.data || {};

    try {
      await started;

      switch (message.kind) {
        case "decide-load": {
          const url = (await cachedModel(message.url)) || message.url;
          if (cachedURL) URL.revokeObjectURL(cachedURL);
          cachedURL = url.startsWith("blob:") ? url : null;
          self.yzmaDecideLoad(url, message.config, message.readout, message.manyMode || "", message.orders || "");
          break;
        }
        case "decide":
          self.yzmaDecide(message.state, message.question, message.category || "");
          break;
        case "decide-many":
          self.yzmaDecideMany(message.state, message.questions, message.category || "");
          break;
        case "answer":
          self.yzmaAnswer(message.request);
          break;
        default:
          self.postMessage({ kind: "error", text: "unknown message: " + message.kind });
      }
    } catch (err) {
      self.postMessage({ kind: "error", text: String(err) });
    }
  };
}
