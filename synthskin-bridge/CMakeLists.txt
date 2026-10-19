cmake_minimum_required(VERSION 3.22)
project(SynthSkinBridge VERSION 1.0.0)

# This is a header-only JUCE module.
# To use it in your plugin project, add this directory to your include paths
# and link against juce::juce_core, juce::juce_audio_processors, juce::juce_gui_basics.

# Example usage in your plugin's CMakeLists.txt:
#
#   target_include_directories(MyPlugin PRIVATE path/to/synthskin-bridge)
#   target_compile_definitions(MyPlugin PRIVATE SYNTHSKIN_BRIDGE_ENABLED=1)  # Debug
#   # or SYNTHSKIN_BRIDGE_ENABLED=0 for release

add_library(synthskin-bridge INTERFACE)
target_include_directories(synthskin-bridge INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
