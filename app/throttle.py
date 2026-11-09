"""Gentle request pacing, so the collector never floods the Optimizer servers.

All client sites are subdomains of the same domain (optmzr.ru) and most likely live on the
same infrastructure, so limits apply on two levels:

* per site (host):   one request at a time, with a pause between requests;
* per domain:        at most N requests in flight and at most `1 / domain_interval`
                     request starts per second across *all* clients of that domain.
"""
from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict
from dataclasses import dataclass


def domain_of(host: str) -> str:
    parts = host.split(":")[0].split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


@dataclass
class ThrottleConfig:
    host_interval: float = 0.7     # seconds between two requests to one site
    domain_interval: float = 0.3   # seconds between two request starts on the whole domain
    domain_parallel: int = 2       # requests in flight on the whole domain


class Pacer:
    """Guarantees at least `interval` seconds between consecutive starts for a key."""

    def __init__(self) -> None:
        self._next: dict[str, float] = defaultdict(float)
        self._lock = asyncio.Lock()

    async def wait(self, key: str, interval: float) -> None:
        loop = asyncio.get_running_loop()
        async with self._lock:
            now = loop.time()
            start = max(now, self._next[key])
            self._next[key] = start + interval
        if start > now:
            await asyncio.sleep(start - now)

    def push_back(self, key: str, seconds: float) -> None:
        """Delay every future request for the key (used on 429 / Retry-After)."""
        loop = asyncio.get_running_loop()
        self._next[key] = max(self._next[key], loop.time() + seconds)


class Throttle:
    def __init__(self, config: ThrottleConfig | None = None) -> None:
        self.config = config or ThrottleConfig()
        self._pacer = Pacer()
        self._host_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._domain_sems: dict[str, asyncio.Semaphore] = {}
        self._sem_size: dict[str, int] = {}
        self.requests_sent = 0

    def configure(self, config: ThrottleConfig) -> None:
        self.config = config

    def _sem(self, domain: str) -> asyncio.Semaphore:
        size = max(1, self.config.domain_parallel)
        if self._sem_size.get(domain) != size and not self._busy(domain):
            self._domain_sems[domain] = asyncio.Semaphore(size)
            self._sem_size[domain] = size
        return self._domain_sems.setdefault(domain, asyncio.Semaphore(size))

    def _busy(self, domain: str) -> bool:
        sem = self._domain_sems.get(domain)
        return sem is not None and sem._value < self._sem_size.get(domain, 0)  # noqa: SLF001

    @contextlib.asynccontextmanager
    async def slot(self, host: str):
        """Hold this while a request to `host` is in flight."""
        domain = domain_of(host)
        async with self._host_locks[host]:
            await self._pacer.wait("host:" + host, self.config.host_interval)
            async with self._sem(domain):
                await self._pacer.wait("domain:" + domain, self.config.domain_interval)
                self.requests_sent += 1
                yield

    def cool_down(self, host: str, seconds: float) -> None:
        """Server asked us to slow down: pause the whole domain."""
        self._pacer.push_back("domain:" + domain_of(host), seconds)
        self._pacer.push_back("host:" + host, seconds)
