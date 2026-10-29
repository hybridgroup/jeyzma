// System One models. The gguf ones hold their own readout, and the
// others need a config file.
const MODELS = [
  {
    name: "Julia-1 (170 MB, no config)",
    url: "https://huggingface.co/ggml-org/Julia-1-GGUF/resolve/main/Julia-1-Q8_0.gguf",
    config: "",
    readout: "gguf",
  },
  {
    name: "Laya (450 MB, no config)",
    url: "https://huggingface.co/ggml-org/Laya-GGUF/resolve/main/Laya-Q8_0.gguf",
    config: "",
    readout: "gguf",
  },
  {
    name: "d1 3B (1.7 GB, no config)",
    url: "https://huggingface.co/LiquidAI/d1-3B-GGUF/resolve/main/d1-3B-Q4_K_M.gguf",
    config: "",
    readout: "gguf",
  },
  {
    name: "Jev-Style 0.8B Decision v3 (530 MB)",
    url: "https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF/resolve/main/Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf",
    config: "https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF/resolve/main/readout_config.json",
    readout: "jev",
  },
  {
    name: "JevK5 2B v0.2 (2.0 GB)",
    url: "https://huggingface.co/alibiserikbay/JevK5-GGUF/resolve/main/jevk5-2b-v0.2-Q8_0.gguf",
    config: "https://huggingface.co/alibiserikbay/JevK5-2B/resolve/main/jevk5_config.json",
    readout: "jevk5",
  },
  {
    name: "decider 0.8B (530 MB)",
    url: "https://huggingface.co/mradermacher/decider-0.8b-GGUF/resolve/main/decider-0.8b.Q4_K_M.gguf",
    config: "https://huggingface.co/Mapika/decider-0.8b/resolve/main/decider_config.json",
    readout: "decider",
  },
];

// clearModelCache removes the models that worker.js keeps in the origin
// private file system. It returns the number of bytes it freed.
async function clearModelCache() {
  const dir = await navigator.storage.getDirectory();
  let freed = 0;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".gguf")) continue;
    freed += (await handle.getFile()).size;
    await dir.removeEntry(name);
  }
  return freed;
}

// cacheClearedText describes how much clearModelCache freed.
function cacheClearedText(bytes) {
  if (bytes === 0) return "the model cache is empty";
  return "cleared " + Math.round(bytes / 1e6) + " MB of cached models";
}
