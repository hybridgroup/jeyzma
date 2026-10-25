# Build the page into build/, then serve it.
# The first build downloads about 13 MB of llama.cpp and caches it.

BUILD_DIR ?= build
PORT ?= 8080

# The llama.cpp release from llama-cpp-builder. v0.7.0 is the release that
# yzma v1.30.0 installs. d1 needs it.
LLAMA_VERSION ?= v0.7.0

# The tinyflight commit for the flight sim page.
TINYFLIGHT_VERSION ?= dd9195e1e028287e9a3fa7f6c003729f4a808ba9
TINYFLIGHT_DIR ?= .cache/tinyflight
SIM_DIR = $(BUILD_DIR)/plays/tinyflightsim

# Use yzma-loader.js from the module that go.mod pins, not a local copy
# that can drift.
YZMA_DIR = $(shell go list -m -f "{{.Dir}}" github.com/hybridgroup/yzma)

# The yzma command must match the version that go.mod pins, because the two
# change together.
YZMA_VERSION = $(shell go list -m -f "{{.Version}}" github.com/hybridgroup/yzma)
# GOBIN if set, otherwise GOPATH/bin.
YZMA_BIN = $(firstword $(shell go env GOBIN) $(shell go env GOPATH)/bin)
YZMA = $(YZMA_BIN)/yzma

.PHONY: all build llama.cpp program tinyflightsim assets serve check test clean

all: build

build: llama.cpp program tinyflightsim assets

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

# This builds the tinyflight firmware and copies the sim page, which assets
# then replaces with ours.
tinyflightsim:
	test -d $(TINYFLIGHT_DIR) || git clone -q https://github.com/hybridgroup/tinyflight $(TINYFLIGHT_DIR)
	git -C $(TINYFLIGHT_DIR) fetch -q origin $(TINYFLIGHT_VERSION)
	git -C $(TINYFLIGHT_DIR) checkout -q $(TINYFLIGHT_VERSION)
	mkdir -p $(SIM_DIR)/api
	cd $(TINYFLIGHT_DIR) && tinygo build -target=wasip1 -tags=tinyflightsim -no-debug -o $(abspath $(SIM_DIR))/api/firmware.wasm ./firmware/stampfly
	cp -r $(TINYFLIGHT_DIR)/tools/tinyflightsim/web/* $(SIM_DIR)/
	cp $(TINYFLIGHT_DIR)/LICENSE $(SIM_DIR)/LICENSE

# assets copies the page, and the README screenshots for the plays page.
assets:
	mkdir -p $(BUILD_DIR)
	cp -f $(YZMA_DIR)/wasm/yzma-loader.js $(BUILD_DIR)/
	cp -r web/* $(BUILD_DIR)/
	cp images/jeyzma-plays-pacman.png $(BUILD_DIR)/plays/pacman.png
	cp images/jeyzma-plays-tinyflightsim.png $(BUILD_DIR)/plays/tinyflightsim.png

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
	rm -rf $(BUILD_DIR) .cache
