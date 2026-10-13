/**
 * Choosing on the page with the eyes, on a still picture of it (so nothing moves while the person looks):
 *
 * - Choose on page: a big number touching everything that can be chosen, the thing outlined in the number's colour,
 *   never overlapping, with room around each. A crowded page first shows a few big lettered areas: choosing one zooms
 *   in on it, and its things get their numbers there. The side list has the same things by name (Buttons, Links,
 *   Boxes to type in), repeated names merged.
 * - Zoom to choose: a look at a big, clear button chooses it; a look anywhere else opens a lens there, magnified.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Icon } from "../components/Icon";
import { center, contains, type Rect } from "./geometry";
import {
  areasOf,
  groupTargets,
  labelSets,
  needsAreas,
  zoomInto,
  zoomRect,
  type Area,
  type LabelTarget,
  type PlacedLabel,
  type Zoom,
} from "./labels";
import { directTargets, lensAt, zoomCells, type Lens } from "./magnifier";
import type { PageFrame } from "./store";

export interface ChooseView {
  /** Which set of numbers is showing ("More numbers" moves on). */
  set: number;
  /** Only these (a name in the list that appears more than once on the page). */
  only: string[] | null;
  /** Zoomed in on this part of the page (page pixels), after choosing a lettered area. */
  area?: Rect | null;
}

export const START_VIEW: ChooseView = { set: 0, only: null, area: null };

function targetsOf(frame: PageFrame): LabelTarget[] {
  return frame.targets.map((t) => ({
    ref: t.ref,
    name: t.name,
    kind: t.kind,
    rect: t.rect,
    secure: t.secure,
  }));
}

export interface Choice {
  /** Zoomed in on an area: how the picture is magnified. */
  zoom: { focus: Rect; z: Zoom } | null;
  /** Lettered areas first (a crowded page), or null. */
  areas: Area[] | null;
  /** Numbers, in sets ("More numbers"); empty while areas show. */
  sets: PlacedLabel[][];
}

/** What "Choose on page" shows for this picture and view. */
export function useChoice(frame: PageFrame, view: ChooseView): Choice {
  return useMemo(() => {
    let pool = targetsOf(frame);
    if (view.only) pool = pool.filter((t) => view.only!.includes(t.ref));
    let zoom: Choice["zoom"] = null;
    if (view.area) {
      const focus = view.area;
      const z = zoomInto(focus, frame.viewport);
      pool = pool
        .filter((t) => contains(focus, center(t.rect)))
        .map((t) => ({ ...t, rect: zoomRect(t.rect, focus, z) }));
      zoom = { focus, z };
    }
    const sets = labelSets(pool, frame.viewport);
    // One level of areas: once zoomed in, the things there are big enough for numbers (in sets if need be).
    const areas = !view.only && !zoom && needsAreas(sets, pool.length) ? areasOf(pool, frame.viewport) : null;
    return areas && areas.length > 1 ? { zoom, areas, sets: [] } : { zoom, areas: null, sets };
  }, [frame, view.only, view.area]);
}

/** An area chosen on screen (maybe already zoomed), as a part of the page to zoom into. */
function areaOnPage(a: Area, zoom: Choice["zoom"]): Rect {
  if (!zoom) return a.focus;
  const { focus, z } = zoom;
  return {
    x: focus.x + (a.focus.x - z.dx) / z.scale,
    y: focus.y + (a.focus.y - z.dy) / z.scale,
    width: a.focus.width / z.scale,
    height: a.focus.height / z.scale,
  };
}

function Still({ frame, zoom }: { frame: PageFrame; zoom: Choice["zoom"] }) {
  if (!frame.image) return <div className="bw-still bw-still-empty" />;
  const style: CSSProperties = { width: frame.viewport.width, height: frame.viewport.height };
  if (zoom) {
    const { focus, z } = zoom;
    style.transformOrigin = "0 0";
    style.transform = `translate(${z.dx - focus.x * z.scale}px, ${z.dy - focus.y * z.scale}px) scale(${z.scale})`;
  }
  return <img className="bw-still" src={frame.image} alt="" style={style} draggable={false} />;
}

const box = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.width, height: r.height });

export function ChooseLayer({
  frame,
  view,
  onView,
  onPick,
}: {
  frame: PageFrame;
  view: ChooseView;
  onView: (v: ChooseView) => void;
  onPick: (ref: string) => void;
}) {
  const choice = useChoice(frame, view);
  const labels = choice.sets[Math.min(view.set, Math.max(0, choice.sets.length - 1))] ?? [];
  const names = useMemo(() => new Map(frame.targets.map((t) => [t.ref, t])), [frame]);
  return (
    <div
      className="bw-choose"
      role="group"
      aria-label={
        choice.areas
          ? "Choose on the page: look at a letter to zoom in"
          : "Choose on the page: look at a number"
      }
      data-zoomed={choice.zoom ? "" : undefined}
    >
      <Still frame={frame} zoom={choice.zoom} />
      <div className="bw-choose-dim" aria-hidden />
      {choice.areas?.map((a) => (
        <button
          key={a.code}
          className="bw-area"
          style={box(a.hit)}
          onClick={() => onView({ set: 0, only: null, area: areaOnPage(a, choice.zoom) })}
          data-dwell
          aria-label={`Area ${a.code}: ${a.refs.length} things. Zoom in here.`}
        >
          <span className="bw-area-chip">{a.code}</span>
          <span className="bw-area-count">{a.refs.length} things</span>
        </button>
      ))}
      {labels.map((l) => {
        const t = names.get(l.ref);
        // The target's outline is part of its label, so a look at the number lights up its own thing.
        return (
          <button
            key={l.ref}
            className="bw-label"
            style={box(l.hit)}
            onClick={() => onPick(l.ref)}
            data-dwell
            aria-label={`${l.code}: ${t?.name || t?.kind || "item"}`}
          >
            <span
              className="bw-target-box"
              aria-hidden
              style={box({ ...l.target, x: l.target.x - l.hit.x, y: l.target.y - l.hit.y })}
            />
            <span className="bw-label-chip">{l.code}</span>
          </button>
        );
      })}
      {!choice.areas && labels.length === 0 && (
        <div className="bw-choose-empty" role="status">
          Nothing to choose on this part of the page. Scroll, or look at Done.
        </div>
      )}
    </div>
  );
}

/** Room for one name in the side list (button, gap, and a group heading now and then). */
const ENTRY_PX = 84;

/** The side list: the same targets by name, grouped, with More numbers, Back to the whole page, and Done. */
function ChooseList({
  frame,
  view,
  onView,
  onPick,
  onDone,
}: {
  frame: PageFrame;
  view: ChooseView;
  onView: (v: ChooseView) => void;
  onPick: (ref: string) => void;
  onDone: () => void;
}) {
  const choice = useChoice(frame, view);
  const sets = choice.sets;
  const groups = useMemo(() => groupTargets(targetsOf(frame)), [frame]);
  const entries = useMemo(
    () => groups.flatMap((g) => g.entries.map((e, i) => ({ ...e, group: i === 0 ? g.title : null }))),
    [groups],
  );
  const [page, setPage] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const [perPage, setPerPage] = useState(4);
  // As many names as fit, decided once per picture and view so nothing moves while the person looks.
  useLayoutEffect(() => {
    const h = list.current?.clientHeight ?? 0;
    if (h > 0) setPerPage(Math.max(2, Math.floor(h / ENTRY_PX)));
  }, [frame, view.area, view.only]);
  const pages = Math.max(1, Math.ceil(entries.length / perPage));
  const shown = entries.slice(page * perPage, page * perPage + perPage);
  return (
    <div className="bw-list" role="group" aria-label="Things on the page, by name">
      <button className="bw-rail-btn bw-rail-done" onClick={onDone} data-dwell>
        <Icon name="check" size={30} />
        <span>Done choosing</span>
      </button>
      {view.only || view.area ? (
        <button className="bw-rail-btn" onClick={() => onView(START_VIEW)} data-dwell>
          <Icon name={view.area ? "zoom-out" : "labels"} size={30} flat />
          <span>{view.area ? "Whole page" : "Show all again"}</span>
        </button>
      ) : null}
      {sets.length > 1 && (
        <button
          className="bw-rail-btn"
          onClick={() => onView({ ...view, set: (view.set + 1) % sets.length })}
          data-dwell
        >
          <Icon name="more" size={30} flat />
          <span>
            More numbers ({Math.min(view.set, sets.length - 1) + 1} of {sets.length})
          </span>
        </button>
      )}
      <div className="bw-list-items" ref={list}>
        {shown.map((e) => (
          <div key={`${e.name}-${e.refs[0]}`} className="bw-list-entry">
            {e.group && <span className="bw-list-group">{e.group}</span>}
            <button
              className="bw-list-btn"
              onClick={() =>
                e.refs.length === 1 ? onPick(e.refs[0]!) : onView({ set: 0, only: e.refs, area: null })
              }
              data-dwell
            >
              <span className="bw-list-name">{e.name}</span>
              {e.refs.length > 1 && <span className="bw-list-count">{e.refs.length} on the page</span>}
            </button>
          </div>
        ))}
      </div>
      {pages > 1 && (
        <div className="bw-list-pager">
          <button
            className="bw-pager-btn"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            data-dwell
            aria-label="Previous names"
          >
            <Icon name="up" size={28} flat />
          </button>
          <span className="muted small">
            {page + 1}/{pages}
          </span>
          <button
            className="bw-pager-btn"
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            data-dwell
            aria-label="More names"
          >
            <Icon name="down" size={28} flat />
          </button>
        </div>
      )}
    </div>
  );
}

ChooseLayer.List = ChooseList;

export function ZoomLayer({
  frame,
  lens,
  onLens,
  onPick,
}: {
  frame: PageFrame;
  lens: Lens | null;
  onLens: (lens: Lens | null) => void;
  onPick: (ref: string) => void;
}) {
  const setLens = onLens;
  const targets = useMemo(
    () => frame.targets.map((t) => ({ ref: t.ref, name: t.name, rect: t.rect })),
    [frame],
  );
  const cells = useMemo(() => zoomCells(frame.viewport), [frame]);
  const direct = useMemo(() => directTargets(targets), [targets]);
  const scale = lens ? lens.zoom : 1;
  return (
    <div className="bw-zoom" role="group" aria-label="Zoom to choose: look at the part of the page you want">
      <Still frame={frame} zoom={null} />
      {!lens && (
        <>
          {cells.map((c, i) => (
            <button
              key={`cell-${i}`}
              className="bw-cell"
              style={{ left: c.x, top: c.y, width: c.width, height: c.height }}
              onClick={() =>
                setLens(lensAt({ x: c.x + c.width / 2, y: c.y + c.height / 2 }, targets, frame.viewport))
              }
              data-dwell
              aria-label={`Zoom in here (row ${Math.floor(i / Math.max(1, Math.round(frame.viewport.width / 150))) + 1})`}
            />
          ))}
          {direct.map((t) => (
            <button
              key={`direct-${t.ref}`}
              className="bw-direct"
              style={{ left: t.rect.x, top: t.rect.y, width: t.rect.width, height: t.rect.height }}
              onClick={() => onPick(t.ref)}
              data-dwell
              aria-label={t.name || "Button"}
            />
          ))}
        </>
      )}
      {lens && (
        <div className="bw-lens-backdrop">
          <div
            className="bw-lens"
            style={{ left: lens.box.x, top: lens.box.y, width: lens.box.width, height: lens.box.height }}
            aria-label={`Magnified ${scale} times`}
          >
            {frame.image && (
              <img
                className="bw-lens-img"
                src={frame.image}
                alt=""
                draggable={false}
                style={{
                  width: frame.viewport.width * scale,
                  height: frame.viewport.height * scale,
                  left: -lens.source.x * scale,
                  top: -lens.source.y * scale,
                }}
              />
            )}
          </div>
          {lens.items.map((it) => (
            <button
              key={`lens-${it.ref}`}
              className="bw-lens-item"
              style={{ left: it.hit.x, top: it.hit.y, width: it.hit.width, height: it.hit.height }}
              onClick={() => onPick(it.ref)}
              data-dwell
              aria-label={it.name || "Item"}
            >
              <span
                className="bw-lens-outline"
                style={{
                  left: it.rect.x - it.hit.x,
                  top: it.rect.y - it.hit.y,
                  width: it.rect.width,
                  height: it.rect.height,
                }}
              />
            </button>
          ))}
          {lens.items.length === 0 && (
            <div className="bw-choose-empty" role="status">
              Nothing to choose here. Close the lens and look somewhere else.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The rail while zooming: Done, Close lens, and what to do. */
export function ZoomRail({
  lens,
  onCloseLens,
  onDone,
}: {
  lens: Lens | null;
  onCloseLens: () => void;
  onDone: () => void;
}) {
  return (
    <div className="bw-list" role="group" aria-label="Zoom to choose">
      <button className="bw-rail-btn bw-rail-done" onClick={onDone} data-dwell>
        <Icon name="check" size={30} />
        <span>Done choosing</span>
      </button>
      {lens && (
        <button className="bw-rail-btn" onClick={onCloseLens} data-dwell>
          <Icon name="zoom-out" size={30} flat />
          <span>Close the lens</span>
        </button>
      )}
      <p className="bw-rail-help">
        {lens
          ? `Magnified ${lens.zoom} times. Look at what you want.`
          : "Look at the part of the page you want. A big button is chosen; anywhere else, a lens opens."}
      </p>
    </div>
  );
}
