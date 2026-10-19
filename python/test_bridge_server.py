"""
Simple mock JUCE plugin bridge for testing the SynthSkin Studio connection.

Listens on a TCP port, sends a 'connected' handshake when Studio connects,
echoes back received messages, and responds to pings with pongs.

Usage:
    python test_bridge_server.py [port]
    
Default port: 9876
"""

import socket
import struct
import json
import sys
import threading
import time


def encode_frame(data: dict) -> bytes:
    body = json.dumps(data).encode('utf-8')
    header = struct.pack('>I', len(body))
    return header + body


def decode_frames(buffer: bytes) -> tuple[list[dict], bytes]:
    frames = []
    while len(buffer) >= 4:
        length = struct.unpack('>I', buffer[:4])[0]
        if length > 10 * 1024 * 1024:
            buffer = b''
            break
        if len(buffer) < 4 + length:
            break
        body = buffer[4:4 + length].decode('utf-8')
        try:
            frames.append(json.loads(body))
        except json.JSONDecodeError:
            pass
        buffer = buffer[4 + length:]
    return frames, buffer


def handle_client(conn: socket.socket, addr):
    print(f"[Bridge] Studio connected from {addr}")

    # Send handshake
    handshake = {
        "type": "connected",
        "pluginName": "TestSynth (Mock)",
        "jucePluginVersion": "7.0.0",
        "bridgeVersion": "1.0.0"
    }
    conn.sendall(encode_frame(handshake))
    print(f"[Bridge] Sent handshake: {handshake['pluginName']}")

    buffer = b''
    try:
        while True:
            data = conn.recv(4096)
            if not data:
                break
            buffer += data
            frames, buffer = decode_frames(buffer)

            for msg in frames:
                msg_type = msg.get('type', '?')
                print(f"[Bridge] Received: {msg_type}")

                if msg_type == 'ping':
                    pong = {"type": "pong", "timestamp": msg.get("timestamp", 0)}
                    conn.sendall(encode_frame(pong))
                    print(f"[Bridge] Sent pong")

                elif msg_type == 'request_parameter_list':
                    params = {
                        "type": "parameter_list",
                        "parameters": [
                            {
                                "id": "osc1Pitch",
                                "name": "Osc 1 Pitch",
                                "displayName": "Osc 1 Pitch",
                                "type": "float",
                                "min": -24.0,
                                "max": 24.0,
                                "defaultValue": 0.0,
                                "currentValue": 0.0,
                                "unit": "semi",
                                "skew": 1.0,
                                "automatable": True,
                            },
                            {
                                "id": "osc1Wave",
                                "name": "Osc 1 Wave",
                                "displayName": "Osc 1 Wave",
                                "type": "choice",
                                "min": 0,
                                "max": 3,
                                "defaultValue": 0,
                                "currentValue": 0,
                                "unit": "",
                                "skew": 1.0,
                                "choices": ["Saw", "Square", "Triangle", "Sine"],
                                "automatable": True,
                            },
                            {
                                "id": "filterCutoff",
                                "name": "Filter Cutoff",
                                "displayName": "Filter Cutoff",
                                "type": "float",
                                "min": 20.0,
                                "max": 20000.0,
                                "defaultValue": 1000.0,
                                "currentValue": 1000.0,
                                "unit": "Hz",
                                "skew": 0.3,
                                "automatable": True,
                            },
                            {
                                "id": "filterRes",
                                "name": "Filter Resonance",
                                "displayName": "Filter Resonance",
                                "type": "float",
                                "min": 0.0,
                                "max": 1.0,
                                "defaultValue": 0.0,
                                "currentValue": 0.0,
                                "unit": "",
                                "skew": 1.0,
                                "automatable": True,
                            },
                            {
                                "id": "masterVolume",
                                "name": "Master Volume",
                                "displayName": "Master Volume",
                                "type": "float",
                                "min": -60.0,
                                "max": 6.0,
                                "defaultValue": -6.0,
                                "currentValue": -6.0,
                                "unit": "dB",
                                "skew": 2.0,
                                "automatable": True,
                            },
                        ]
                    }
                    conn.sendall(encode_frame(params))
                    print(f"[Bridge] Sent parameter list ({len(params['parameters'])} params)")

                elif msg_type == 'load_design':
                    result = {
                        "type": "design_loaded",
                        "success": True,
                        "warnings": []
                    }
                    conn.sendall(encode_frame(result))
                    print(f"[Bridge] Design loaded OK")

                elif msg_type == 'update_component':
                    comp_id = msg.get('componentId', '?')
                    print(f"[Bridge] Component updated: {comp_id} -> {json.dumps(msg.get('properties', {}))[:80]}")

                elif msg_type == 'set_parameter':
                    param_id = msg.get('parameterId', '?')
                    value = msg.get('value', 0)
                    print(f"[Bridge] Parameter set: {param_id} = {value}")
                    # Echo back as parameter_changed
                    echo = {
                        "type": "parameter_changed",
                        "parameterId": param_id,
                        "value": value,
                        "source": "studio"
                    }
                    conn.sendall(encode_frame(echo))

                else:
                    print(f"[Bridge] Unhandled message type: {msg_type}")

    except (ConnectionError, OSError) as e:
        print(f"[Bridge] Connection error: {e}")
    finally:
        conn.close()
        print(f"[Bridge] Studio disconnected")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9876

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', port))
    server.listen(1)
    print(f"[Bridge] Mock JUCE plugin listening on 127.0.0.1:{port}")
    print(f"[Bridge] Waiting for SynthSkin Studio to connect...")

    try:
        while True:
            conn, addr = server.accept()
            t = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
            t.start()
    except KeyboardInterrupt:
        print("\n[Bridge] Shutting down")
    finally:
        server.close()


if __name__ == '__main__':
    main()
