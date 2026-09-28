import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import math
from time import monotonic

from starlette.responses import JSONResponse

from .config import Settings


@dataclass
class Bucket:
    rate: float
    capacity: float
    tokens: float
    updated: float

    def wait(self, now):
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        return max(0, (1 - self.tokens) / self.rate)


class RateLimiter:
    def __init__(self, settings: Settings, clock=monotonic):
        self.settings = settings
        self.clock = clock
        self.clients = OrderedDict()
        now = clock()
        self.general = self._bucket(settings.global_per_minute, settings.global_burst, now)
        self.search = self._bucket(settings.global_search_per_minute,
                                   settings.global_search_burst, now)

    @staticmethod
    def _bucket(per_minute, burst, now):
        return Bucket(per_minute / 60, burst, burst, now)

    def allow(self, ip, is_search):
        now = self.clock()
        while self.clients and next(iter(self.clients.values()))[2] < now - 600:
            self.clients.popitem(last=False)
        item = self.clients.get(ip)
        if item is None:
            if len(self.clients) >= self.settings.max_clients:
                return 60
            item = (self._bucket(self.settings.ip_per_minute, self.settings.ip_burst, now),
                    self._bucket(self.settings.ip_search_per_minute,
                                 self.settings.ip_search_burst, now), now)
        buckets = [self.general, item[0]]
        if is_search:
            buckets += [self.search, item[1]]
        wait = max(bucket.wait(now) for bucket in buckets)
        self.clients[ip] = (item[0], item[1], now)
        self.clients.move_to_end(ip)
        if wait > 0:
            return max(1, math.ceil(wait))
        for bucket in buckets:
            bucket.tokens -= 1
        return 0


class ApiGuard:
    """Check resource limits before JSON parsing; buffer at most one small body."""

    def __init__(self, app, settings: Settings):
        self.app = app
        self.settings = settings
        self.limiter = RateLimiter(settings)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def secured_send(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).extend([
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"content-security-policy", b"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                ])
                if scope["path"].startswith("/api/"):
                    message["headers"].append((b"cache-control", b"no-store"))
            await send(message)

        async def reject(code, detail, headers=None):
            await JSONResponse({"detail": detail}, status_code=code, headers=headers)(
                scope, receive, secured_send)

        if not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, secured_send)
        if len(scope.get("query_string", b"")) + len(scope["path"].encode()) > 2048:
            return await reject(414, "Слишком длинный запрос")
        ip = (scope.get("client") or ("unknown", 0))[0]
        retry = self.limiter.allow(ip, scope["path"] == "/api/nearest")
        if retry:
            return await reject(429, "Слишком много запросов. Подождите немного.",
                                {"Retry-After": str(retry)})
        headers = dict(scope.get("headers", []))
        try:
            content_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await reject(400, "Некорректный размер запроса")
        if content_length < 0 or content_length > self.settings.max_body_bytes:
            return await reject(413, "Слишком большой запрос")
        body = bytearray()
        try:
            async with asyncio.timeout(self.settings.body_timeout):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    if len(body) + len(chunk) > self.settings.max_body_bytes:
                        return await reject(413, "Слишком большой запрос")
                    body.extend(chunk)
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            return await reject(408, "Истекло время получения запроса")
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, secured_send)
