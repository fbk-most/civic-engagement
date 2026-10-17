"""Machinery for spatial fields a pack computes on demand (the urban felt
temperature, for one): a cache that computes each field once, even when
several requests ask for it together, and the compact encoding they're
served in."""

import base64
import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable
from concurrent.futures import Future
from typing import Generic, TypeVar

import numpy as np

V = TypeVar("V")


class ComputeCache(Generic[V]):
    """The `size` values asked about most recently, by key. A value already
    being computed for another request is waited for, not computed again;
    at most `at_once` are computed side by side (each may take a lot of
    memory while it runs)."""

    def __init__(self, size: int, at_once: int) -> None:
        self._size = size
        self._cache: OrderedDict[Hashable, V] = OrderedDict()
        # Guards the cache and the values being computed, briefly: the
        # computing itself runs outside it, so values asked for together
        # are computed side by side.
        self._lock = threading.Lock()
        self._computing: dict[Hashable, Future] = {}
        self._slots = threading.Semaphore(at_once)

    def get(self, key: Hashable, compute: Callable[[], V]) -> V:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            # Already being computed for another request: wait for that one.
            pending = self._computing.get(key)
            if pending is None:
                pending = self._computing[key] = Future()
                mine = True
            else:
                mine = False
        if not mine:
            return pending.result()
        try:
            with self._slots:
                value = compute()
        except BaseException as error:
            with self._lock:
                del self._computing[key]
            pending.set_exception(error)
            raise
        with self._lock:
            self._cache[key] = value
            if len(self._cache) > self._size:
                self._cache.popitem(last=False)
            del self._computing[key]
        pending.set_result(value)
        return value


def encode_bytes(values: np.ndarray, scale: float, offset: float, nodata: int = 255) -> str:
    """`values` as base64 of one byte per cell, in their array order: byte b
    is offset + b * scale; NaN is `nodata`."""
    quantized = np.round((values - offset) / scale)
    data = np.where(np.isnan(values), nodata, np.clip(quantized, 0, nodata - 1)).astype(np.uint8)
    return base64.b64encode(data.tobytes()).decode("ascii")
