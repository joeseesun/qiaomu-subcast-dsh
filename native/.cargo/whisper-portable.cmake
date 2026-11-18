# The downloadable engine must use a baseline supported by the target OS.
# Metal stays enabled on macOS through the Cargo feature.
if(PROJECT_NAME STREQUAL "whisper.cpp")
    set(GGML_NATIVE OFF CACHE BOOL "Skip host-specific CPU feature detection" FORCE)
    set(GGML_AVX OFF CACHE BOOL "Use the x64 baseline" FORCE)
    set(GGML_AVX2 OFF CACHE BOOL "Use the x64 baseline" FORCE)
    set(GGML_FMA OFF CACHE BOOL "Use the x64 baseline" FORCE)
    set(GGML_F16C OFF CACHE BOOL "Use the x64 baseline" FORCE)
endif()
