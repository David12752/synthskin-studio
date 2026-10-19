# SynthSkin Bridge — JUCE Module

A header-only C++ module that enables live editing of your JUCE plugin's GUI from SynthSkin Studio. Design panels, tweak materials, bind parameters — all while your plugin runs in a DAW, with no recompilation.

## Quick Start

### 1. Add to your CMakeLists.txt

```cmake
add_subdirectory(path/to/synthskin-bridge)
target_link_libraries(MyPlugin PRIVATE synthskin-bridge)

target_compile_definitions(MyPlugin PRIVATE
    $<$<CONFIG:Debug>:SYNTHSKIN_BRIDGE_ENABLED=1>
    $<$<CONFIG:Release>:SYNTHSKIN_BRIDGE_ENABLED=0>
)
```

### 2. Add to your PluginEditor

```cpp
#include "synthskin_bridge.h"

class MyPluginEditor : public juce::AudioProcessorEditor
{
public:
    MyPluginEditor (MyPluginProcessor& p)
        : AudioProcessorEditor (p),
          bridge (*this, p, { .port = 9876, .pluginName = "My Plugin" })
    {
    }

private:
    synthskin::SynthSkinBridge bridge;
};
```

### 3. Register your component types

```cpp
// In your PluginEditor constructor, after creating the bridge:
auto& reg = synthskin::ComponentRegistry::getInstance();

reg.registerType ("knob", [](const juce::String& id, const auto& props) {
    auto knob = std::make_unique<MyKnobComponent>();
    knob->setDesignId (id);
    // Apply properties (material, preset, indicatorColor, etc.)
    return knob;
});

reg.registerType ("slider", [](const juce::String& id, const auto& props) {
    return std::make_unique<MySliderComponent>();
});
```

### 4. Connect and design live

1. Build your plugin in **Debug** configuration and load in a DAW
2. Open SynthSkin Studio → switch to **Design** workspace
3. The Connection Manager appears in the right panel
4. Click **Scan for Plugins** → click **Connect** on your plugin
5. Design your panel — every change appears live in the DAW

### 5. Bake for release

When you're happy with the design:
1. Switch to the **Export** workspace
2. Click **Generate Baked Files** in the right panel
3. Save the 3 generated files into your plugin's Source directory:
   - `design.xml` — the full design
   - `SynthSkinDesign.h` — C++ header with embedded XML
   - `SynthSkinDesign.cpp` — loader that parses into a `juce::ValueTree`
4. In your PluginEditor:

```cpp
#if !SYNTHSKIN_BRIDGE_ENABLED
    auto design = SynthSkinDesign::loadDesign();
    // Use the ValueTree to build your UI, or use DesignLoader:
    designLoader.loadFromXml (
        juce::String::fromUTF8 (SynthSkinDesign::designXml,
                                 SynthSkinDesign::designXmlSize),
        *this);
#else
    // Live mode handled by bridge
#endif
```

5. Build with `SYNTHSKIN_BRIDGE_ENABLED=0` — zero bridge code in the binary

## Architecture

### Classes

| Class | Purpose |
|-------|---------|
| `BridgeServer` | TCP server thread, length-prefixed JSON framing, port listener |
| `SynthSkinBridge` | Main entry point — ties server + APVTS parameter forwarding |
| `BridgeListener` | Virtual interface for reacting to bridge events |
| `ComponentRegistry` | Singleton factory — maps type names to component creators |
| `BridgeComponent` | Base class for registry-created components with `updateFromProperties()` |
| `DesignLoader` | Parses Design XML, creates/updates/removes components via registry |

### Design XML Format

```xml
<synthskin-design version="1.0">
  <metadata>...</metadata>
  <stylesheet/>
  <lighting>
    <key azimuth="225" elevation="45" intensity="1" color="#fff5e6" softness="0.4"/>
    <fill intensity="0.25" color="#3a4055"/>
    <ambient intensity="0.15" color="#2a2825"/>
    <environment preset="studio"/>
  </lighting>
  <panel width="800" height="500" backgroundType="solid" backgroundColor="#1a1816">
    <section id="osc1" name="Oscillator 1" ...>
      <component id="c1" type="knob" x="40" y="60" width="48" height="48" preset="..." parameterId="osc1Pitch"/>
      <label text="PITCH" x="40" y="120" font="Eurostile" size="11" effect="engraved"/>
    </section>
  </panel>
  <bindings>
    <binding componentId="c1" parameterId="osc1Pitch" min="-24" max="24" default="0" units="semi" skew="1.0"/>
  </bindings>
</synthskin-design>
```

## Wire Protocol

Communication uses length-prefixed JSON over TCP:
- **Header**: 4 bytes, big-endian uint32 — length of the JSON body
- **Body**: UTF-8 JSON message

**Studio → Plugin**: `load_design`, `update_component`, `add_component`, `remove_component`, `reorder_components`, `update_lighting`, `update_background`, `request_screenshot`, `request_parameter_list`, `set_parameter`, `ping`

**Plugin → Studio**: `connected`, `parameter_list`, `parameter_changed`, `screenshot`, `design_loaded`, `error`, `pong`

Default port: `9876` (configurable, Studio scans ports 9876–9886). Heartbeat every 2s, timeout at 5s. Updates throttled to 16ms batches.

## Security

The bridge only listens on `127.0.0.1` (localhost). It is not accessible from the network. It should only be enabled in debug/development builds. Release builds define `SYNTHSKIN_BRIDGE_ENABLED=0` which compiles out all bridge code via preprocessor stubs — zero overhead.
