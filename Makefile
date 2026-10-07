# Build the page into build/, then serve it.
# The first build downloads about 13 MB of llama.cpp and caches it.

BUILD_DIR ?= build
PORT ?= 8080

# The llama.cpp release from llama-cpp-builder. v0.6.0 is the release that
# yzma v1.29.0 installs. Laya and Julia-1 need it.
LLAMA_VERSION ?= v0.6.0

# Use yzma-loader.js from the module that go.mod pins, not a local copy
# that can drift.
YZMA_DIR = $(shell go list -m -f "{{.Dir}}" github.com/hybridgroup/yzma)

# The yzma command must match the version that go.mod pins, because the two
# change together.
YZMA_VERSION = $(shell go list -m -f "{{.Version}}" github.com/hybridgroup/yzma)
# GOBIN if set, otherwise GOPATH/bin.
YZMA_BIN = $(firstword $(shell go env GOBIN) $(shell go env GOPATH)/bin)
YZMA = $(YZMA_BIN)/yzma

.PHONY: all build llama.cpp program assets serve check test clean

all: build

build: llama.cpp program assets

# This downloads all three WebAssembly builds. yzma-loader.js picks the
# best one at run time.
llama.cpp:
	go install github.com/hybridgroup/yzma@$(YZMA_VERSION)
	mkdir -p $(BUILD_DIR)
	$(YZMA) install -lib $(BUILD_DIR) -os wasm -version $(LLAMA_VERSION)

program:
	mkdir -p $(BUILD_DIR)
	tinygo build -target wasm -o $(BUILD_DIR)/yzma.wasm .
	cp "$(shell tinygo env TINYGOROOT)/targets/wasm_exec.js" $(BUILD_DIR)/

assets:
	mkdir -p $(BUILD_DIR)
	cp -f $(YZMA_DIR)/wasm/yzma-loader.js $(BUILD_DIR)/
	cp web/* $(BUILD_DIR)/

# This server sets the same headers as the service worker, so either one is
# enough on localhost.
serve:
	go run github.com/hybridgroup/yzma/wasm/serve -dir $(BUILD_DIR) -port $(PORT)

# check builds with the standard toolchain, which is faster than TinyGo.
check:
	GOOS=js GOARCH=wasm go build -o /dev/null .
	GOOS=js GOARCH=wasm go vet ./...

# test asks three questions in Node. DecideMany must match Decide.
#   make test MODEL=~/models/Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf CONFIG=~/models/readout_config.json
MODEL ?=
CONFIG ?=
READOUT ?= jev
test:
	@test -n "$(MODEL)" || { echo "give a model: make test MODEL=/path/to/model.gguf CONFIG=/path/to/config.json"; exit 2; }
	node test/decide.js --dir $(BUILD_DIR) --model $(MODEL) $(if $(CONFIG),--config $(CONFIG)) --readout $(READOUT) --mt $(TEST_FLAGS)

clean:
	rm -rf $(BUILD_DIR)
