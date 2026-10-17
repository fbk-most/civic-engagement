"""Workarounds for civic-digital-twins 0.12.0, kept in one place so they can
be dropped (or moved into the framework) one at a time.

1. **No empty axes.** An evaluation rejects an axis of length 0
   (`AxisLayout: sizes must be positive`), yet a scenario routinely has no
   cost items, no new paths, no lamps of its own. Every entity array gets
   one inert entry appended (`with_sentinel`), chosen so that it only ever
   adds exactly 0.0 to a sum; readers drop it again (`n_real`).

2. **Functors see the whole evaluation layout.** A functor's arguments
   arrive with leading sample dimensions followed by *every* domain axis
   of the evaluation, sorted by name, size 1 where the argument doesn't
   carry it — and the functor must answer in that same layout. `on_axes`
   wraps a plain function written against its own axes only: it slices
   each argument down to the axes it declares, calls the function once per
   leading (sample) index, and places the answer back into the layout.
   It needs the evaluation's domain axes up front (`layout_axes`), which
   the evaluator checks against the actual result layout after the run.

3. **Results come in the whole layout too.** `own_axes` reads one output
   back on its own axes, in the order asked for.

4. **Geometry as arrays.** There is no geometry index type, so polygons
   travel through the model as WKB bytes plus offsets (`geometries_to_arrays`
   / `arrays_to_geometries`) — lossless, any geometry type, and plain float
   arrays as far as the framework is concerned.
"""

from collections.abc import Callable, Sequence

import numpy as np
import shapely
from civic_digital_twins.dt_model import DOMAIN, Axis, Functor, NumpyBackend

# --- 1. no empty axes -------------------------------------------------------


def with_sentinel(values: Sequence | np.ndarray, sentinel, dtype=float) -> np.ndarray:
    """`values` as an array along its first dimension, plus one trailing
    inert entry."""
    array = np.asarray(values, dtype=dtype)
    sentinel = np.asarray(sentinel, dtype=dtype)
    if array.size == 0:
        array = array.reshape((0, *sentinel.shape))
    return np.concatenate([array, sentinel[None, ...]], axis=0)


def n_real(array: np.ndarray) -> int:
    """How many entries of an entity array are real, i.e. not the sentinel."""
    return array.shape[0] - 1


# --- 2. functors on their own axes -------------------------------------------


def _domain_block(value: np.ndarray, n_domain: int, lead_index: tuple[int, ...]) -> np.ndarray:
    lead = value.shape[: value.ndim - n_domain]
    index = tuple(i if size > 1 else 0 for i, size in zip(lead_index, lead, strict=True))
    return value[index]


def _to_own(block: np.ndarray, layout: tuple[Axis, ...], axes: tuple[Axis, ...]) -> np.ndarray:
    for position, axis in enumerate(layout):
        if axis not in axes and block.shape[position] != 1:
            raise ValueError(f"functor argument carries axis {axis.name!r}, which it does not declare")
    picked = block[tuple(slice(None) if axis in axes else 0 for axis in layout)]
    present = [axis for axis in layout if axis in axes]
    return np.transpose(picked, [present.index(axis) for axis in axes])


def on_axes(
    fn: Callable[..., np.ndarray],
    input_axes: Sequence[tuple[Axis, ...]],
    output_axes: tuple[Axis, ...],
    layout_axes: Sequence[Axis],
) -> Functor:
    """A functor calling `fn` with each argument on its declared axes (in
    the declared order), expecting an answer on `output_axes`."""
    layout = tuple(sorted(layout_axes, key=lambda axis: axis.name))
    n_domain = len(layout)

    def wrapped(*args: np.ndarray) -> np.ndarray:
        args = tuple(np.asarray(a) for a in args)
        lead_shape = np.broadcast_shapes(*(a.shape[: a.ndim - n_domain] for a in args))
        out = None
        for lead_index in np.ndindex(*lead_shape):
            own = [
                _to_own(_domain_block(a, n_domain, lead_index), layout, axes)
                for a, axes in zip(args, input_axes, strict=True)
            ]
            answer = np.asarray(fn(*own), dtype=float)
            # back into the layout: own axes at their canonical positions, 1 elsewhere
            present = sorted(output_axes, key=lambda axis: layout.index(axis))
            answer = np.transpose(answer, [output_axes.index(axis) for axis in present])
            shape = [answer.shape[present.index(axis)] if axis in output_axes else 1 for axis in layout]
            if out is None:
                out = np.empty((*lead_shape, *shape))
            out[lead_index] = answer.reshape(shape)
        return out

    return NumpyBackend.adapt(wrapped, output_axes=tuple(output_axes))


# --- 3. results on their own axes ---------------------------------------------


def own_axes(value: np.ndarray, result_axes: Sequence[Axis], axes: tuple[Axis, ...]) -> np.ndarray:
    """One deterministic result (a single sample) on `axes`, in that order.

    `result_axes` is the result's full layout (`EvaluationResult.layout.axes`):
    leading sample axes first, then the domain axes."""
    value = np.asarray(value)
    n_lead = len(result_axes) - sum(1 for axis in result_axes if axis.role == DOMAIN)
    if any(size != 1 for size in value.shape[:n_lead]):
        raise ValueError("own_axes reads deterministic results only (one sample)")
    block = value.reshape(value.shape[n_lead:])
    return _to_own(block, tuple(result_axes[n_lead:]), axes)


# --- 4. geometry as arrays -------------------------------------------------------


def geometries_to_arrays(geometries: Sequence) -> tuple[np.ndarray, np.ndarray]:
    """WKB bytes of all geometries back to back (as floats), and the offset
    where each one starts plus a final end offset."""
    blobs = [shapely.to_wkb(g) for g in geometries]
    offsets = np.cumsum([0, *(len(b) for b in blobs)])
    data = np.frombuffer(b"".join(blobs), dtype=np.uint8).astype(float)
    return data, offsets.astype(float)


def arrays_to_geometries(data: np.ndarray, offsets: np.ndarray) -> list:
    raw = np.asarray(data).astype(np.uint8).tobytes()
    bounds = np.asarray(offsets).astype(np.int64)
    return [shapely.from_wkb(raw[a:b]) for a, b in zip(bounds[:-1], bounds[1:])]
