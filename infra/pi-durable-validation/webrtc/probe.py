"""Real SRTP decoding + SCTP input acceptance probe. Own local fixture only."""
import asyncio
import json
import sys

from aiohttp import ClientSession
from aiortc import RTCPeerConnection, RTCConfiguration, RTCSessionDescription


async def main():
    origin, browser_id, points_json = sys.argv[1:]
    points = json.loads(points_json)
    frames, acknowledgements = [], asyncio.Queue()
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    channel = pc.createDataChannel("point-input", ordered=True)
    pc.addTransceiver("video", direction="recvonly")
    opened = asyncio.Event()
    receiver = None
    peer_id = None
    sequence = 0

    @channel.on("open")
    def ready():
        opened.set()

    @channel.on("message")
    def message(value):
        acknowledgements.put_nowait(json.loads(value))

    @pc.on("track")
    def track_received(track):
        nonlocal receiver
        async def decode():
            while True:
                frame = await track.recv()
                rgb = frame.reformat(format="rgb24")
                plane = rgb.planes[0]
                x, y = int(points["marker"]["x"]), int(points["marker"]["y"])
                offset = y * plane.line_size + x * 3
                color = list(bytes(plane)[offset:offset+3])
                frames.append({"width": frame.width, "height": frame.height, "pts": frame.pts, "marker": color})
        receiver = asyncio.create_task(decode())

    async with ClientSession() as client:
        async def post(path, value):
            async with client.post(origin + path, json=value) as response:
                result = await response.json()
                assert response.status == 200, result
                return result

        async def send(value, allowed=True):
            nonlocal sequence
            sequence += 1
            channel.send(json.dumps({**value, "sequence": sequence}))
            ack = await asyncio.wait_for(acknowledgements.get(), 10)
            assert ack.get("sequence") == sequence, ack
            assert bool(ack.get("ok")) == allowed, ack
            return ack

        async def click(point):
            for event, buttons in (("mousePressed", 1), ("mouseReleased", 0)):
                await send({"type": "mouse", "event": event, **point, "button": "left", "buttons": buttons})

        try:
            await pc.setLocalDescription(await pc.createOffer())
            answer = await post("/browser/rtc/offer", {"browserId": browser_id, "sdp": pc.localDescription.sdp})
            peer_id = answer["peerId"]
            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
            await asyncio.wait_for(opened.wait(), 15)
            for _ in range(150):
                if len(frames) >= 5:
                    break
                await asyncio.sleep(0.1)
            assert len(frames) >= 5, "No decoded RTP video frames"
            assert any(f["marker"][0] > 180 and f["marker"][1] < 80 for f in frames), "Initial red marker missing from decoded video"
            denied = await send({"type": "text", "text": "must-be-denied"}, False)
            await post("/browser/handoff", {"browserId": browser_id})
            await click(points["note"])
            await send({"type": "text", "text": "WebRTC 数据通道"})
            for event in ("keyDown", "keyUp"):
                await send({"type": "key", "event": event, "key": " ", "code": "Space", "keyCode": 32})
            await send({"type": "text", "text": "OK"})
            await click(points["save"])
            for _ in range(40):
                observed = await post("/browser/observe", {"browserId": browser_id})
                if "Saved: WebRTC 数据通道 OK" in observed["text"]:
                    break
                await asyncio.sleep(0.1)
            assert "Saved: WebRTC 数据通道 OK" in observed["text"], observed["text"]
            # A successful DOM assertion alone misses a frozen/stale video. The
            # save callback paints exactly one final green update after fetch.
            for _ in range(80):
                if any(f["marker"][1] > 180 and f["marker"][0] < 80 for f in frames):
                    break
                await asyncio.sleep(0.1)
            assert any(f["marker"][1] > 180 and f["marker"][0] < 80 for f in frames), "Saved DOM state never reached the WebRTC video"
            await click(points["next"])
            for _ in range(100):
                if any(f["marker"][2] > 180 and f["marker"][0] < 80 and f["marker"][1] < 80 for f in frames):
                    break
                await asyncio.sleep(0.1)
            assert any(f["marker"][2] > 180 and f["marker"][0] < 80 and f["marker"][1] < 80 for f in frames), "Navigation never reached the WebRTC video"
            await post("/browser/resume", {"browserId": browser_id})
            await send({"type": "text", "text": "must-also-be-denied"}, False)
            print(json.dumps({"status": "passed", "decodedFrames": len(frames), "frame": frames[-1],
                              "dataChannel": channel.readyState, "readOnlyDenied": bool(denied.get("error")), "saved": "WebRTC 数据通道 OK", "videoShowsSavedState": True, "videoFollowsNavigation": True}), flush=True)
        finally:
            if receiver:
                receiver.cancel()
            await pc.close()
            if peer_id:
                await post("/browser/rtc/close", {"peerId": peer_id})


asyncio.run(main())
