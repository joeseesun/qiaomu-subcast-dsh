# Use a portable CPU backend for downloadable Apple Silicon builds.
# Keep Whisper's Metal backend enabled by the Cargo feature.
if(PROJECT_NAME STREQUAL "whisper.cpp" AND APPLE AND CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
    set(GGML_NATIVE OFF CACHE BOOL "Skip host-specific CPU feature detection" FORCE)
endif()
