"""Loopback-only WebRTC media bridge, supervised by the Durable Node process.

Steel remains the browser owner. One CDP screencast per page feeds a shared
VideoStreamTrack; each viewer receives negotiated VP8/SRTP, never JPEG over a
data channel. Input goes through the parent's conversation/control checks.
"""
import asyncio
import base64
import fractions
import json
import os
import signal
import sys
import time
import uuid

import av
from aiohttp import ClientSession, WSMsgType, web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCRtpSender, RTCSessionDescription, VideoStreamTrack
from aiortc.contrib.media import MediaRelay
from aiortc.mediastreams import MediaStreamError


def emit(value):
    print(json.dumps(value), flush=True)


class PageVideo(VideoStreamTrack):
    def __init__(self, owner, source):
        super().__init__()
        self.owner, self.source = owner, source
        self.pending, self.seq, self.latest = {}, 0, None
        self.ready = asyncio.Event()
        self.decoder = av.CodecContext.create("mjpeg", "r")
        self.relay, self.users = MediaRelay(), set()
        self.client = self.ws = self.reader = self.session_id = None
        self.clock = self.last_tick = None
        self.closed = False
        self.frame_count = 0
        self.frame_at = None
        self.restart_task = None
        self.metadata = None

    async def call(self, method, params=None, attached=True):
        self.seq += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.seq] = future
        message = {"id": self.seq, "method": method, "params": params or {}}
        if attached and self.session_id:
            message["sessionId"] = self.session_id
        try:
            await self.ws.send_json(message)
            return await asyncio.wait_for(future, 10)
        finally:
            self.pending.pop(message["id"], None)

    def frame(self, data):
        frames = self.decoder.decode(av.Packet(base64.b64decode(data)))
        if frames:
            self.latest = frames[-1]
            self.frame_count += 1
            self.frame_at = time.monotonic()
            self.ready.set()

    async def read(self):
        try:
            async for message in self.ws:
                if message.type != WSMsgType.TEXT:
                    break
                value = json.loads(message.data)
                if "id" in value:
                    future = self.pending.get(value["id"])
                    if future and not future.done():
                        if "error" in value:
                            future.set_exception(RuntimeError("Steel CDP command failed"))
                        else:
                            future.set_result(value.get("result", {}))
                elif value.get("method") == "Page.screencastFrame" and value.get("sessionId") == self.session_id:
                    event = value["params"]
                    self.metadata = event.get("metadata")
                    # ACK without waiting in the same reader that handles responses.
                    self.seq += 1
                    await self.ws.send_json({"id": self.seq, "sessionId": self.session_id,
                                             "method": "Page.screencastFrameAck", "params": {"sessionId": event["sessionId"]}})
                    self.frame(event["data"])
                elif value.get("method") == "Page.frameNavigated" and value.get("sessionId") == self.session_id:
                    if not value["params"]["frame"].get("parentId") and (not self.restart_task or self.restart_task.done()):
                        self.restart_task = asyncio.create_task(self.restart_capture())
        finally:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(RuntimeError("Steel CDP connection closed"))
            self.ready.set()
            if not self.closed:
                asyncio.create_task(self.owner.source_lost(self))

    async def start(self):
        self.client = ClientSession()
        self.ws = await self.client.ws_connect(self.source["endpoint"], heartbeat=15, max_msg_size=16 * 1024 * 1024)
        self.reader = asyncio.create_task(self.read())
        result = await self.call("Target.attachToTarget", {"targetId": self.source["pageId"], "flatten": True}, False)
        self.session_id = result["sessionId"]
        await self.call("Page.enable")
        await self.call("Page.bringToFront")
        # Never drop the last compositor update of a static page. The video
        # track paces output independently; capture every dirty frame here.
        await self.call("Page.startScreencast", {"format": "jpeg", "quality": 65, "maxWidth": 1280, "maxHeight": 800, "everyNthFrame": 1})
        # Loading pages may take time to paint. A captureScreenshot fallback
        # changes compositor/emulation state and can hang before the first
        # surface exists; wait for the screencast instead.

    async def restart_capture(self):
        try:
            await self.call("Page.stopScreencast")
            await self.call("Page.startScreencast", {"format": "jpeg", "quality": 65, "maxWidth": 1280, "maxHeight": 800, "everyNthFrame": 1})
        except Exception:
            if not self.closed:
                asyncio.create_task(self.owner.source_lost(self))

    async def recv(self):
        await self.ready.wait()
        if self.closed or self.latest is None:
            raise MediaStreamError
        now = time.monotonic()
        if self.last_tick is not None:
            await asyncio.sleep(max(0, self.last_tick + 1 / 15 - now))
        now = time.monotonic()
        self.clock = self.clock or now
        self.last_tick = now
        # Own frame metadata: relay consumers must not mutate the decoded source.
        frame = self.latest.reformat(format="yuv420p")
        frame.pts = int((now - self.clock) * 90000)
        frame.time_base = fractions.Fraction(1, 90000)
        return frame

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.restart_task:
            self.restart_task.cancel()
        self.ready.set()
        self.stop()
        if self.ws and not self.ws.closed:
            try:
                await self.call("Page.stopScreencast")
                await self.call("Target.detachFromTarget", {"sessionId": self.session_id}, False)
            except Exception:
                pass
            await self.ws.close()
        if self.reader:
            self.reader.cancel()
        if self.client:
            await self.client.close()


class Bridge:
    def __init__(self):
        self.sources, self.peers, self.inputs = {}, {}, {}
        self.source_lock = asyncio.Lock()
        self.shutdown = asyncio.Event()

    async def source_lost(self, track):
        for peer_id in list(track.users):
            await self.close_peer(peer_id)

    async def close_peer(self, peer_id):
        peer = self.peers.pop(peer_id, None)
        if not peer:
            return
        for task in (peer["input_task"], peer["watchdog"]):
            if task is not asyncio.current_task():
                task.cancel()
        await peer["pc"].close()
        track = peer["track"]
        track.users.discard(peer_id)
        if not track.users:
            self.sources.pop(track.source["pageId"], None)
            await track.close()
        emit({"event": "peer_closed", "peerId": peer_id})

    async def dispatch_inputs(self, peer_id, queue, channel):
        while True:
            message = await queue.get()
            request_id = str(uuid.uuid4())
            future = asyncio.get_running_loop().create_future()
            self.inputs[request_id] = future
            try:
                emit({"event": "input", "peerId": peer_id, "requestId": request_id, "payload": message})
                result = await asyncio.wait_for(future, 10)
                if channel.readyState == "open":
                    channel.send(json.dumps({"type": "input_ack", "sequence": message.get("sequence"), **result}))
            except asyncio.TimeoutError:
                if channel.readyState == "open":
                    channel.send(json.dumps({"type": "input_ack", "error": "Input timed out; inspect the page before retrying"}))
            finally:
                self.inputs.pop(request_id, None)

    async def watchdog(self, peer_id):
        await asyncio.sleep(30)
        peer = self.peers.get(peer_id)
        if peer and peer["pc"].connectionState != "connected":
            await self.close_peer(peer_id)

    async def offer(self, request):
        body = await request.json()
        peer_id, source = body["peerId"], body["source"]
        if len(self.peers) >= 4:
            raise web.HTTPConflict(text="Viewer capacity reached")
        async with self.source_lock:
            track = self.sources.get(source["pageId"])
            if not track:
                track = PageVideo(self, source)
                try:
                    await track.start()
                except Exception:
                    await track.close()
                    raise web.HTTPBadGateway(text="Could not attach the task's Steel page")
                self.sources[source["pageId"]] = track
            track.users.add(peer_id)
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        queue = asyncio.Queue(maxsize=128)
        peer = {"pc": pc, "track": track, "input_task": asyncio.create_task(asyncio.sleep(0)),
                "watchdog": asyncio.create_task(self.watchdog(peer_id))}
        self.peers[peer_id] = peer

        @pc.on("connectionstatechange")
        async def changed():
            if pc.connectionState in ("failed", "closed"):
                await self.close_peer(peer_id)

        @pc.on("datachannel")
        def datachannel(channel):
            if channel.label != "point-input":
                channel.close()
                return
            peer["input_task"] = asyncio.create_task(self.dispatch_inputs(peer_id, queue, channel))

            @channel.on("message")
            def incoming(message):
                try:
                    if not isinstance(message, str) or len(message) > 12000:
                        return
                    value = json.loads(message)
                    if not isinstance(value, dict):
                        return
                    queue.put_nowait(value)
                except (ValueError, asyncio.QueueFull):
                    pass

        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=body["sdp"], type="offer"))
            pc.addTrack(track.relay.subscribe(track, buffered=False))
            vp8 = [codec for codec in RTCRtpSender.getCapabilities("video").codecs if codec.mimeType == "video/VP8"]
            for transceiver in pc.getTransceivers():
                if transceiver.kind == "video":
                    transceiver.setCodecPreferences(vp8)
            await pc.setLocalDescription(await pc.createAnswer())
            return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type, "peerId": peer_id})
        except Exception:
            await self.close_peer(peer_id)
            raise

    async def remove(self, request):
        await self.close_peer(request.match_info["peer_id"])
        return web.json_response({"closed": True})

    async def status(self, request):
        return web.json_response({"peers": len(self.peers), "sources": len(self.sources), "pid": os.getpid(),
                                  "captures": [{"frames": track.frame_count, "metadata": track.metadata, "ageSeconds": round(time.monotonic()-track.frame_at, 2) if track.frame_at else None} for track in self.sources.values()]})

    async def parent_messages(self):
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
        while line := await reader.readline():
            try:
                value = json.loads(line)
                future = self.inputs.get(value.get("requestId"))
                if future and not future.done():
                    future.set_result(value["result"])
            except (ValueError, KeyError):
                pass
        self.shutdown.set()  # Parent death/EOF never leaves a capture process behind.


async def main():
    bridge = Bridge()
    token = os.environ["POINT_RTC_TOKEN"]

    @web.middleware
    async def authorize(request, handler):
        if request.headers.get("Authorization") != "Bearer " + token:
            raise web.HTTPForbidden()
        return await handler(request)

    app = web.Application(middlewares=[authorize], client_max_size=256 * 1024)
    app.router.add_post("/offer", bridge.offer)
    app.router.add_delete("/peers/{peer_id}", bridge.remove)
    app.router.add_get("/status", bridge.status)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    emit({"event": "ready", "url": f"http://127.0.0.1:{port}"})
    parent = asyncio.create_task(bridge.parent_messages())
    for signum in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(signum, bridge.shutdown.set)
    await bridge.shutdown.wait()
    await asyncio.gather(*(bridge.close_peer(peer_id) for peer_id in list(bridge.peers)))
    parent.cancel()
    await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
