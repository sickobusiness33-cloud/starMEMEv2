"""Limitador de ventana deslizante en memoria.

Suficiente para una sola instancia del servidor (que es como se despliega
esta app). Con varias réplicas habría que moverlo a Redis o similar.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, max_events: int, window_seconds: float) -> None:
        self.max_events = max_events
        self.window = window_seconds
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str) -> float:
        """Registra un evento. Devuelve 0 si se permite, o los segundos a esperar."""
        now = time.monotonic()
        with self._lock:
            events = self._events[key]
            while events and now - events[0] > self.window:
                events.popleft()
            if len(events) >= self.max_events:
                return max(0.0, self.window - (now - events[0]))
            events.append(now)
            return 0.0

    def reset(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)
