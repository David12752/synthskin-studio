"""
Quick test client to verify the bridge protocol works.
Connects to the mock server, receives handshake, sends a few messages.
"""
import socket
import struct
import json
import sys
import time


def encode_frame(data: dict) -> bytes:
    body = json.dumps(data).encode('utf-8')
    header = struct.pack('>I', len(body))
    return header + body


def read_frame(sock: socket.socket) -> dict | None:
    header = b''
    while len(header) < 4:
        chunk = sock.recv(4 - len(header))
        if not chunk:
            return None
        header += chunk
    
    length = struct.unpack('>I', header)[0]
    body = b''
    while len(body) < length:
        chunk = sock.recv(length - len(body))
        if not chunk:
            return None
        body += chunk
    
    return json.loads(body.decode('utf-8'))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9876
    
    print(f"[Test] Connecting to 127.0.0.1:{port}...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(('127.0.0.1', port))
    print(f"[Test] Connected!")
    
    # 1. Receive handshake
    msg = read_frame(sock)
    assert msg is not None, "No handshake received"
    assert msg['type'] == 'connected', f"Expected 'connected', got '{msg['type']}'"
    print(f"[Test] OK: Received handshake from '{msg['pluginName']}'")
    
    # 2. Send ping, receive pong
    sock.sendall(encode_frame({"type": "ping", "timestamp": 12345}))
    msg = read_frame(sock)
    assert msg is not None and msg['type'] == 'pong', "No pong received"
    assert msg['timestamp'] == 12345, f"Timestamp mismatch: {msg['timestamp']}"
    print(f"[Test] OK: Ping/pong works (timestamp preserved)")
    
    # 3. Request parameter list
    sock.sendall(encode_frame({"type": "request_parameter_list"}))
    msg = read_frame(sock)
    assert msg is not None and msg['type'] == 'parameter_list', "No parameter list"
    param_count = len(msg['parameters'])
    print(f"[Test] OK: Received {param_count} parameters")
    for p in msg['parameters']:
        print(f"         - {p['id']}: {p['displayName']} ({p['type']}, {p['min']}-{p['max']})")
    
    # 4. Send load_design
    sock.sendall(encode_frame({
        "type": "load_design",
        "xml": "<synthskin-design version='1.0'><panel width='800' height='500'/></synthskin-design>"
    }))
    msg = read_frame(sock)
    assert msg is not None and msg['type'] == 'design_loaded', "No design_loaded response"
    assert msg['success'] is True, "Design load failed"
    print(f"[Test] OK: Design loaded successfully")
    
    # 5. Send update_component
    sock.sendall(encode_frame({
        "type": "update_component",
        "componentId": "osc1_pitch",
        "properties": {"diameter": 64, "material": "brushedAluminum"}
    }))
    time.sleep(0.1)  # Give server time to log
    print(f"[Test] OK: Sent component update")
    
    # 6. Send set_parameter
    sock.sendall(encode_frame({
        "type": "set_parameter",
        "parameterId": "filterCutoff",
        "value": 5000.0
    }))
    msg = read_frame(sock)
    assert msg is not None and msg['type'] == 'parameter_changed', "No parameter echo"
    assert msg['parameterId'] == 'filterCutoff', "Wrong parameter ID"
    assert msg['value'] == 5000.0, "Wrong value"
    print(f"[Test] OK: Parameter set/echo works")
    
    print(f"\n[Test] ALL TESTS PASSED")
    sock.close()


if __name__ == '__main__':
    main()
