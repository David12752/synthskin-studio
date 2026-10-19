/*
  ==============================================================================

   SynthSkin Bridge — JUCE Module
   
   Add this module to your JUCE plugin project to enable live editing
   from SynthSkin Studio. The bridge communicates over TCP using a
   length-prefixed JSON protocol.

   Usage:
   1. Add synthskin-bridge to your CMakeLists.txt
   2. In PluginEditor constructor: SynthSkinBridge bridge(*this, processor);
   3. For release builds: #define SYNTHSKIN_BRIDGE_ENABLED 0

  ==============================================================================
*/

#pragma once

#ifndef SYNTHSKIN_BRIDGE_ENABLED
 #if defined(DEBUG) || defined(_DEBUG) || !defined(NDEBUG)
  #define SYNTHSKIN_BRIDGE_ENABLED 1
 #else
  #define SYNTHSKIN_BRIDGE_ENABLED 0
 #endif
#endif

#if SYNTHSKIN_BRIDGE_ENABLED

#include <juce_core/juce_core.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

namespace synthskin
{

//==============================================================================
/** Configuration for the bridge server */
struct BridgeConfig
{
    int port = 9876;
    juce::String pluginName = "Unknown Plugin";
    juce::String pluginVersion = "1.0.0";
    juce::String bridgeVersion = "1.0.0";
};

//==============================================================================
/** Listener for bridge events */
class BridgeListener
{
public:
    virtual ~BridgeListener() = default;
    
    virtual void bridgeConnected() {}
    virtual void bridgeDisconnected() {}
    virtual void designLoaded (const juce::String& xml) { juce::ignoreUnused (xml); }
    virtual void componentUpdated (const juce::String& componentId, 
                                   const juce::var& properties) 
    { juce::ignoreUnused (componentId, properties); }
    virtual void componentAdded (const juce::String& componentId,
                                 const juce::String& type,
                                 const juce::var& properties,
                                 const juce::String& parentId)
    { juce::ignoreUnused (componentId, type, properties, parentId); }
    virtual void componentRemoved (const juce::String& componentId) 
    { juce::ignoreUnused (componentId); }
    virtual void lightingUpdated (const juce::var& lighting) 
    { juce::ignoreUnused (lighting); }
    virtual void backgroundUpdated (const juce::var& background) 
    { juce::ignoreUnused (background); }
    virtual void parameterSetFromStudio (const juce::String& parameterId, float value) 
    { juce::ignoreUnused (parameterId, value); }
};

//==============================================================================
/** 
    TCP server that runs inside the plugin process.
    Accepts a single connection from SynthSkin Studio.
    
    Framing: 4-byte big-endian length prefix + JSON body.
*/
class BridgeServer : private juce::Thread,
                     private juce::Timer
{
public:
    BridgeServer (BridgeConfig config)
        : juce::Thread ("SynthSkin Bridge"),
          cfg (std::move (config))
    {
    }

    ~BridgeServer() override
    {
        stop();
    }

    void start()
    {
        if (isThreadRunning())
            return;

        shouldStop.store (false);
        startThread (juce::Thread::Priority::normal);
        startTimer (100); // check for incoming data
    }

    void stop()
    {
        shouldStop.store (true);
        stopTimer();

        if (clientSocket != nullptr)
            clientSocket->close();

        if (serverSocket != nullptr)
            serverSocket->close();

        stopThread (2000);
        clientSocket.reset();
        serverSocket.reset();
    }

    bool isConnected() const { return clientSocket != nullptr && clientSocket->isConnected(); }

    void addListener (BridgeListener* l) { listeners.add (l); }
    void removeListener (BridgeListener* l) { listeners.remove (l); }

    /** Send a JSON message to the connected Studio */
    void sendMessage (const juce::String& json)
    {
        if (clientSocket == nullptr || ! clientSocket->isConnected())
            return;

        auto body = json.toRawUTF8();
        auto bodyLen = (int) json.getNumBytesAsUTF8();

        // 4-byte BE length header
        uint8_t header[4];
        header[0] = (uint8_t) ((bodyLen >> 24) & 0xFF);
        header[1] = (uint8_t) ((bodyLen >> 16) & 0xFF);
        header[2] = (uint8_t) ((bodyLen >>  8) & 0xFF);
        header[3] = (uint8_t) ((bodyLen      ) & 0xFF);

        const juce::ScopedLock sl (sendLock);
        clientSocket->write (header, 4);
        clientSocket->write (body, bodyLen);
    }

    /** Send parameter change to Studio (called from audio-thread-safe context) */
    void notifyParameterChanged (const juce::String& parameterId, float value, 
                                  const juce::String& source = "user")
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty ("type", "parameter_changed");
        obj->setProperty ("parameterId", parameterId);
        obj->setProperty ("value", value);
        obj->setProperty ("source", source);
        sendMessage (juce::JSON::toString (juce::var (obj.get())));
    }

    int getPort() const { return cfg.port; }

private:
    void run() override
    {
        serverSocket = std::make_unique<juce::StreamingSocket>();

        if (! serverSocket->createListener (cfg.port, "127.0.0.1"))
        {
            DBG ("SynthSkin Bridge: Failed to listen on port " + juce::String (cfg.port));
            return;
        }

        DBG ("SynthSkin Bridge: Listening on 127.0.0.1:" + juce::String (cfg.port));

        while (! shouldStop.load() && ! threadShouldExit())
        {
            // Wait for a connection (blocking, 500ms timeout)
            auto* raw = serverSocket->waitForNextConnection();

            if (raw == nullptr)
                continue;

            clientSocket.reset (raw);
            DBG ("SynthSkin Bridge: Studio connected");

            // Send 'connected' handshake
            {
                juce::DynamicObject::Ptr obj = new juce::DynamicObject();
                obj->setProperty ("type", "connected");
                obj->setProperty ("pluginName", cfg.pluginName);
                obj->setProperty ("jucePluginVersion", cfg.pluginVersion);
                obj->setProperty ("bridgeVersion", cfg.bridgeVersion);
                sendMessage (juce::JSON::toString (juce::var (obj.get())));
            }

            listeners.call (&BridgeListener::bridgeConnected);

            // Read loop
            while (! shouldStop.load() && ! threadShouldExit() 
                   && clientSocket != nullptr && clientSocket->isConnected())
            {
                if (clientSocket->waitUntilReady (true, 200) == 1)
                {
                    readIncoming();
                }
            }

            listeners.call (&BridgeListener::bridgeDisconnected);
            clientSocket.reset();
            DBG ("SynthSkin Bridge: Studio disconnected");
        }
    }

    void readIncoming()
    {
        if (clientSocket == nullptr)
            return;

        // Read 4-byte length header
        uint8_t header[4];
        int headerRead = clientSocket->read (header, 4, true);
        if (headerRead != 4)
            return;

        int bodyLen = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
        
        // Sanity check: reject > 10MB
        if (bodyLen <= 0 || bodyLen > 10 * 1024 * 1024)
            return;

        juce::MemoryBlock body ((size_t) bodyLen);
        int bodyRead = clientSocket->read (body.getData(), bodyLen, true);
        if (bodyRead != bodyLen)
            return;

        juce::String json (juce::CharPointer_UTF8 ((const char*) body.getData()), (size_t) bodyLen);
        handleMessage (json);
    }

    void handleMessage (const juce::String& json)
    {
        auto parsed = juce::JSON::parse (json);
        if (parsed.isVoid())
            return;

        auto* obj = parsed.getDynamicObject();
        if (obj == nullptr)
            return;

        auto type = obj->getProperty ("type").toString();

        if (type == "ping")
        {
            // Reply with pong
            juce::DynamicObject::Ptr pong = new juce::DynamicObject();
            pong->setProperty ("type", "pong");
            pong->setProperty ("timestamp", obj->getProperty ("timestamp"));
            sendMessage (juce::JSON::toString (juce::var (pong.get())));
        }
        else if (type == "load_design")
        {
            auto xml = obj->getProperty ("xml").toString();
            juce::MessageManager::callAsync ([this, xml]() {
                listeners.call (&BridgeListener::designLoaded, xml);
            });
        }
        else if (type == "update_component")
        {
            auto compId = obj->getProperty ("componentId").toString();
            auto props = obj->getProperty ("properties");
            juce::MessageManager::callAsync ([this, compId, props]() {
                listeners.call (&BridgeListener::componentUpdated, compId, props);
            });
        }
        else if (type == "add_component")
        {
            auto compId = obj->getProperty ("componentId").toString();
            auto compType = obj->getProperty ("componentType").toString();
            auto props = obj->getProperty ("properties");
            auto parentId = obj->getProperty ("parentId").toString();
            juce::MessageManager::callAsync ([this, compId, compType, props, parentId]() {
                listeners.call (&BridgeListener::componentAdded, compId, compType, props, parentId);
            });
        }
        else if (type == "remove_component")
        {
            auto compId = obj->getProperty ("componentId").toString();
            juce::MessageManager::callAsync ([this, compId]() {
                listeners.call (&BridgeListener::componentRemoved, compId);
            });
        }
        else if (type == "update_lighting")
        {
            auto lighting = obj->getProperty ("lighting");
            juce::MessageManager::callAsync ([this, lighting]() {
                listeners.call (&BridgeListener::lightingUpdated, lighting);
            });
        }
        else if (type == "update_background")
        {
            auto background = obj->getProperty ("background");
            juce::MessageManager::callAsync ([this, background]() {
                listeners.call (&BridgeListener::backgroundUpdated, background);
            });
        }
        else if (type == "set_parameter")
        {
            auto paramId = obj->getProperty ("parameterId").toString();
            auto value = (float) obj->getProperty ("value");
            juce::MessageManager::callAsync ([this, paramId, value]() {
                listeners.call (&BridgeListener::parameterSetFromStudio, paramId, value);
            });
        }
        else if (type == "request_parameter_list")
        {
            // Subclass or user should respond with parameter list
            // This is handled in SynthSkinBridge
        }
        else if (type == "request_screenshot")
        {
            // TODO: capture and send screenshot
        }
    }

    void timerCallback() override
    {
        // Periodic checks can go here (e.g., connection health)
    }

    BridgeConfig cfg;
    std::atomic<bool> shouldStop { false };
    std::unique_ptr<juce::StreamingSocket> serverSocket;
    std::unique_ptr<juce::StreamingSocket> clientSocket;
    juce::CriticalSection sendLock;
    juce::ListenerList<BridgeListener> listeners;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (BridgeServer)
};

//==============================================================================
/**
    Main bridge class. Instantiate in your PluginEditor.
    
    Usage:
    @code
    class MyPluginEditor : public juce::AudioProcessorEditor
    {
    public:
        MyPluginEditor (MyPluginProcessor& p)
            : AudioProcessorEditor (p),
              bridge (*this, p)
        {
        }
    private:
        synthskin::SynthSkinBridge bridge;
    };
    @endcode
*/
class SynthSkinBridge : private BridgeListener,
                        private juce::AudioProcessorValueTreeState::Listener
{
public:
    SynthSkinBridge (juce::AudioProcessorEditor& editor, 
                     juce::AudioProcessor& processor,
                     BridgeConfig config = {})
        : editorRef (editor),
          processorRef (processor),
          server (std::move (config))
    {
        server.addListener (this);

        // If APVTS is available, listen to all parameters
        if (auto* apvts = getAPVTS())
        {
            for (auto* param : apvts->processor.getParameters())
            {
                if (auto* rpw = dynamic_cast<juce::RangedAudioParameter*> (param))
                    apvts->addParameterListener (rpw->paramID, this);
            }
        }

        server.start();
    }

    ~SynthSkinBridge() override
    {
        if (auto* apvts = getAPVTS())
        {
            for (auto* param : apvts->processor.getParameters())
            {
                if (auto* rpw = dynamic_cast<juce::RangedAudioParameter*> (param))
                    apvts->removeParameterListener (rpw->paramID, this);
            }
        }

        server.removeListener (this);
        server.stop();
    }

    BridgeServer& getServer() { return server; }
    bool isConnected() const { return server.isConnected(); }

private:
    // BridgeListener overrides
    void bridgeConnected() override
    {
        DBG ("SynthSkin: Studio connected — sending parameter list");
        sendParameterList();
    }

    void parameterSetFromStudio (const juce::String& parameterId, float value) override
    {
        if (auto* apvts = getAPVTS())
        {
            if (auto* param = apvts->getParameter (parameterId))
            {
                param->setValueNotifyingHost (param->convertTo0to1 (value));
            }
        }
    }

    // APVTS Listener — forward parameter changes to Studio
    void parameterChanged (const juce::String& parameterID, float newValue) override
    {
        server.notifyParameterChanged (parameterID, newValue, "user");
    }

    void sendParameterList()
    {
        auto* apvts = getAPVTS();
        if (apvts == nullptr)
            return;

        juce::Array<juce::var> paramArray;

        for (auto* param : apvts->processor.getParameters())
        {
            if (auto* rpw = dynamic_cast<juce::RangedAudioParameter*> (param))
            {
                juce::DynamicObject::Ptr info = new juce::DynamicObject();
                info->setProperty ("id", rpw->paramID);
                info->setProperty ("name", rpw->getName (128));
                info->setProperty ("displayName", rpw->getName (128));
                info->setProperty ("min", rpw->getNormalisableRange().start);
                info->setProperty ("max", rpw->getNormalisableRange().end);
                info->setProperty ("defaultValue", rpw->getDefaultValue());
                info->setProperty ("currentValue", rpw->getValue());
                info->setProperty ("automatable", rpw->isAutomatable());

                // Determine type
                if (dynamic_cast<juce::AudioParameterFloat*> (rpw))
                    info->setProperty ("type", "float");
                else if (dynamic_cast<juce::AudioParameterInt*> (rpw))
                    info->setProperty ("type", "int");
                else if (dynamic_cast<juce::AudioParameterChoice*> (rpw))
                {
                    info->setProperty ("type", "choice");
                    if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (rpw))
                    {
                        juce::Array<juce::var> choices;
                        for (auto& c : choice->choices)
                            choices.add (c);
                        info->setProperty ("choices", choices);
                    }
                }
                else if (dynamic_cast<juce::AudioParameterBool*> (rpw))
                    info->setProperty ("type", "bool");
                else
                    info->setProperty ("type", "float");

                paramArray.add (juce::var (info.get()));
            }
        }

        juce::DynamicObject::Ptr msg = new juce::DynamicObject();
        msg->setProperty ("type", "parameter_list");
        msg->setProperty ("parameters", paramArray);
        server.sendMessage (juce::JSON::toString (juce::var (msg.get())));
    }

    juce::AudioProcessorValueTreeState* getAPVTS() const
    {
        // Try to find APVTS by downcasting — users should ensure their processor
        // has a public apvts member or override this via a subclass
        return nullptr; // Users override this or we use reflection
    }

    juce::AudioProcessorEditor& editorRef;
    juce::AudioProcessor& processorRef;
    BridgeServer server;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SynthSkinBridge)
};

} // namespace synthskin

//==============================================================================
// ─── Component Registry ─────────────────────────────────────────────
// Maps Design XML component type names → JUCE component factories.
// Users register their own factories at startup; the bridge uses the
// registry when loading a design to instantiate the correct GUI parts.
//==============================================================================

namespace synthskin
{

/** Property bag passed to component factories when creating or updating. */
using ComponentProperties = juce::NamedValueSet;

/**
    Base class for factory-created components.
    Wraps a juce::Component and provides a standard update hook.
*/
class BridgeComponent : public juce::Component
{
public:
    ~BridgeComponent() override = default;

    /** Called when the Studio pushes updated properties for this component. */
    virtual void updateFromProperties (const ComponentProperties& props) = 0;

    /** Return the design component id. */
    const juce::String& getDesignId() const { return designId; }
    void setDesignId (const juce::String& id) { designId = id; }

private:
    juce::String designId;
};

/**
    Factory function signature.
    @param id         Component id from the design XML
    @param props      Key-value properties (x, y, width, height, preset, etc.)
    @returns          Owning pointer to the new BridgeComponent, or nullptr on failure.
*/
using ComponentFactory = std::function<std::unique_ptr<BridgeComponent> (
    const juce::String& id,
    const ComponentProperties& props)>;

/**
    Registry that maps component type names (knob, slider, button, etc.)
    to factory callables. Singleton per plugin process.

    @code
    auto& reg = synthskin::ComponentRegistry::getInstance();
    reg.registerType ("knob",   [](auto& id, auto& p) { return std::make_unique<MyKnob>(id, p); });
    reg.registerType ("slider", [](auto& id, auto& p) { return std::make_unique<MySlider>(id, p); });
    @endcode
*/
class ComponentRegistry
{
public:
    static ComponentRegistry& getInstance()
    {
        static ComponentRegistry instance;
        return instance;
    }

    /** Register a factory for a given type name. Replaces any existing factory. */
    void registerType (const juce::String& typeName, ComponentFactory factory)
    {
        factories[typeName] = std::move (factory);
    }

    /** Unregister a type. */
    void unregisterType (const juce::String& typeName)
    {
        factories.erase (typeName);
    }

    /** Check if a factory exists for the given type. */
    bool hasType (const juce::String& typeName) const
    {
        return factories.find (typeName) != factories.end();
    }

    /** Create a component from the registry. Returns nullptr if type is unknown. */
    std::unique_ptr<BridgeComponent> create (const juce::String& typeName,
                                              const juce::String& id,
                                              const ComponentProperties& props) const
    {
        auto it = factories.find (typeName);
        if (it == factories.end())
        {
            DBG ("SynthSkin ComponentRegistry: unknown type '" + typeName + "'");
            return nullptr;
        }
        auto comp = it->second (id, props);
        if (comp != nullptr)
            comp->setDesignId (id);
        return comp;
    }

    /** Return the list of registered type names. */
    juce::StringArray getRegisteredTypes() const
    {
        juce::StringArray types;
        for (auto& [name, _] : factories)
            types.add (name);
        return types;
    }

    void clearAll() { factories.clear(); }

private:
    ComponentRegistry() = default;
    std::map<juce::String, ComponentFactory> factories;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ComponentRegistry)
};

//==============================================================================
/**
    DesignLoader — parses Design XML and instantiates components via the registry.

    @code
    synthskin::DesignLoader loader;
    loader.loadFromXml (xmlString, parentComponent);
    // Later, when Studio sends an update:
    loader.updateComponent ("comp_123", newProperties);
    @endcode
*/
class DesignLoader
{
public:
    DesignLoader() = default;

    /**
        Parse a full Design XML string and create all components.
        Existing components are destroyed. New ones are added as children of parent.
    */
    bool loadFromXml (const juce::String& xmlString, juce::Component& parent)
    {
        auto xml = juce::XmlDocument::parse (xmlString);
        if (xml == nullptr || xml->getTagName() != "synthskin-design")
            return false;

        // Clear old components
        destroyAll (parent);

        auto& registry = ComponentRegistry::getInstance();

        // Parse sections
        if (auto* panelEl = xml->getChildByName ("panel"))
        {
            for (auto* child : panelEl->getChildIterator())
            {
                if (child->getTagName() == "section")
                    loadSection (*child, parent, registry);
                else if (child->getTagName() == "component")
                    loadComponent (*child, parent, registry);
                else if (child->getTagName() == "label")
                    loadLabel (*child, parent, registry);
            }
        }

        return true;
    }

    /** Update properties for an existing component by its design id. */
    void updateComponent (const juce::String& componentId, const ComponentProperties& props)
    {
        auto it = liveComponents.find (componentId);
        if (it != liveComponents.end() && it->second != nullptr)
        {
            it->second->updateFromProperties (props);

            // Apply common layout properties
            if (props.contains ("x") || props.contains ("y"))
            {
                int x = props.contains ("x") ? (int) props["x"] : it->second->getX();
                int y = props.contains ("y") ? (int) props["y"] : it->second->getY();
                it->second->setTopLeftPosition (x, y);
            }
            if (props.contains ("width") || props.contains ("height"))
            {
                int w = props.contains ("width")  ? (int) props["width"]  : it->second->getWidth();
                int h = props.contains ("height") ? (int) props["height"] : it->second->getHeight();
                it->second->setSize (w, h);
            }
        }
    }

    /** Add a new component dynamically (hot-add from Studio). */
    void addComponent (const juce::String& id, const juce::String& typeName,
                       const ComponentProperties& props, juce::Component& parent)
    {
        auto& registry = ComponentRegistry::getInstance();
        auto comp = registry.create (typeName, id, props);
        if (comp == nullptr)
            return;

        applyLayout (*comp, props);
        parent.addAndMakeVisible (comp.get());
        liveComponents[id] = comp.get();
        ownedComponents.push_back (std::move (comp));
    }

    /** Remove a component by design id. */
    void removeComponent (const juce::String& id)
    {
        auto it = liveComponents.find (id);
        if (it != liveComponents.end())
        {
            auto* raw = it->second;
            liveComponents.erase (it);

            // Remove from owned list (destroys the object)
            ownedComponents.erase (
                std::remove_if (ownedComponents.begin(), ownedComponents.end(),
                    [raw](const auto& p) { return p.get() == raw; }),
                ownedComponents.end());
        }
    }

    /** Get a live component by its design id, or nullptr. */
    BridgeComponent* getComponent (const juce::String& id) const
    {
        auto it = liveComponents.find (id);
        return it != liveComponents.end() ? it->second : nullptr;
    }

    void destroyAll (juce::Component& parent)
    {
        for (auto& [_, comp] : liveComponents)
            if (comp != nullptr)
                parent.removeChildComponent (comp);

        liveComponents.clear();
        ownedComponents.clear();
    }

private:
    void loadSection (const juce::XmlElement& secEl, juce::Component& parent,
                      const ComponentRegistry& registry)
    {
        for (auto* child : secEl.getChildIterator())
        {
            if (child->getTagName() == "component")
                loadComponent (*child, parent, registry);
            else if (child->getTagName() == "label")
                loadLabel (*child, parent, registry);
        }
    }

    void loadComponent (const juce::XmlElement& el, juce::Component& parent,
                        const ComponentRegistry& registry)
    {
        auto id   = el.getStringAttribute ("id");
        auto type = el.getStringAttribute ("type", "knob");

        ComponentProperties props;
        for (int i = 0; i < el.getNumAttributes(); ++i)
            props.set (juce::Identifier (el.getAttributeName (i)),
                       juce::var (el.getAttributeValue (i)));

        auto comp = registry.create (type, id, props);
        if (comp == nullptr)
            return;

        applyLayout (*comp, props);
        parent.addAndMakeVisible (comp.get());
        liveComponents[id] = comp.get();
        ownedComponents.push_back (std::move (comp));
    }

    void loadLabel (const juce::XmlElement& el, juce::Component& parent,
                    const ComponentRegistry& /*registry*/)
    {
        // Labels get a basic BridgeComponent wrapper
        // Plugin devs can register "label" in the registry for custom rendering;
        // fallback: create a juce::Label
        auto id = el.getStringAttribute ("id",
            "label_" + juce::String (juce::Random::getSystemRandom().nextInt()));

        ComponentProperties props;
        for (int i = 0; i < el.getNumAttributes(); ++i)
            props.set (juce::Identifier (el.getAttributeName (i)),
                       juce::var (el.getAttributeValue (i)));

        auto& registry = ComponentRegistry::getInstance();
        if (registry.hasType ("label"))
        {
            auto comp = registry.create ("label", id, props);
            if (comp != nullptr)
            {
                applyLayout (*comp, props);
                parent.addAndMakeVisible (comp.get());
                liveComponents[id] = comp.get();
                ownedComponents.push_back (std::move (comp));
            }
        }
    }

    static void applyLayout (juce::Component& comp, const ComponentProperties& props)
    {
        int x = props.contains ("x")      ? (int) props["x"]      : 0;
        int y = props.contains ("y")      ? (int) props["y"]      : 0;
        int w = props.contains ("width")  ? (int) props["width"]  : 64;
        int h = props.contains ("height") ? (int) props["height"] : 64;
        comp.setBounds (x, y, w, h);
    }

    std::map<juce::String, BridgeComponent*> liveComponents;
    std::vector<std::unique_ptr<BridgeComponent>> ownedComponents;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DesignLoader)
};

} // namespace synthskin

#else // SYNTHSKIN_BRIDGE_ENABLED == 0

// Stub class for release builds — zero overhead
namespace synthskin
{
    class SynthSkinBridge
    {
    public:
        SynthSkinBridge (juce::AudioProcessorEditor&, juce::AudioProcessor&) {}
        bool isConnected() const { return false; }
    };

    class BridgeComponent : public juce::Component
    {
    public:
        virtual void updateFromProperties (const juce::NamedValueSet&) {}
        const juce::String& getDesignId() const { static juce::String e; return e; }
        void setDesignId (const juce::String&) {}
    };

    class ComponentRegistry
    {
    public:
        static ComponentRegistry& getInstance() { static ComponentRegistry r; return r; }
        template <typename F> void registerType (const juce::String&, F&&) {}
        bool hasType (const juce::String&) const { return false; }
    };

    class DesignLoader
    {
    public:
        bool loadFromXml (const juce::String&, juce::Component&) { return false; }
        void updateComponent (const juce::String&, const juce::NamedValueSet&) {}
        void addComponent (const juce::String&, const juce::String&, const juce::NamedValueSet&, juce::Component&) {}
        void removeComponent (const juce::String&) {}
    };
}

#endif // SYNTHSKIN_BRIDGE_ENABLED
