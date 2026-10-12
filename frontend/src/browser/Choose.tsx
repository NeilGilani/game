/**
 * Choosing on the page with the eyes, on a still picture of it (so nothing moves while the person looks):
 *
 * - Choose on page: a big number next to everything that can be chosen, never overlapping, with room around each;
 *   the side list has the same things by name (Buttons, Links, Boxes to type in), repeated names merged.
 * - Zoom to choose: a look at a big, clear button chooses it; a look anywhere else opens a lens there, magnified.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { groupTargets, labelSets, type LabelTarget } from "./labels";
import { directTargets, lensAt, zoomCells, type Lens } from "./magnifier";
import type { PageFrame } from "./store";

export interface ChooseView {
  /** Which set of labels is showing ("More" moves on). */
  set: number;
  /** Only these (a name in the list that appears more than once on the page). */
  only: string[] | null;
}

function targetsOf(frame: PageFrame): LabelTarget[] {
  return frame.targets.map((t) => ({
    ref: t.ref,
    name: t.name,
    kind: t.kind,
    rect: t.rect,
    secure: t.secure,
  }));
}

export function useLabelSets(frame: PageFrame, view: ChooseView) {
  return useMemo(() => {
    const all = targetsOf(frame);
    const pool = view.only ? all.filter((t) => view.only!.includes(t.ref)) : all;
    return labelSets(pool, frame.viewport);
  }, [frame, view.only]);
}

function Still({ frame }: { frame: PageFrame }) {
  if (!frame.image) return <div className="bw-still bw-still-empty" />;
  return (
    <img
      className="bw-still"
      src={frame.image}
      alt=""
      style={{ width: frame.viewport.width, height: frame.viewport.height }}
      draggable={false}
    />
  );
}

export function ChooseLayer({
  frame,
  view,
  onPick,
}: {
  frame: PageFrame;
  view: ChooseView;
  onPick: (ref: string) => void;
}) {
  const sets = useLabelSets(frame, view);
  const labels = sets[Math.min(view.set, Math.max(0, sets.length - 1))] ?? [];
  const names = useMemo(() => new Map(frame.targets.map((t) => [t.ref, t])), [frame]);
  return (
    <div className="bw-choose" role="group" aria-label="Choose on the page: look at a number">
      <Still frame={frame} />
      <div className="bw-choose-dim" aria-hidden />
      {labels.map((l) => (
        <div
          key={`box-${l.ref}`}
          className="bw-target-box"
          aria-hidden
          style={{ left: l.target.x, top: l.target.y, width: l.target.width, height: l.target.height }}
        />
      ))}
      {labels.map((l) => {
        const t = names.get(l.ref);
        return (
          <button
            key={l.ref}
            className="bw-label"
            data-kind={t?.kind}
            style={{ left: l.hit.x, top: l.hit.y, width: l.hit.width, height: l.hit.height }}
            onClick={() => onPick(l.ref)}
            data-dwell
            aria-label={`${l.code}: ${t?.name || t?.kind || "item"}`}
          >
            <span className="bw-label-chip">{l.code}</span>
          </button>
        );
      })}
      {labels.length === 0 && (
        <div className="bw-choose-empty" role="status">
          Nothing to choose on this part of the page. Scroll, or look at Done.
        </div>
      )}
    </div>
  );
}

/** Room for one name in the side list (button, gap, and a group heading now and then). */
const ENTRY_PX = 84;

/** The side list: the same targets by name, grouped, with More and Done. */
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
  const sets = useLabelSets(frame, view);
  const groups = useMemo(() => groupTargets(targetsOf(frame)), [frame]);
  const entries = useMemo(
    () => groups.flatMap((g) => g.entries.map((e, i) => ({ ...e, group: i === 0 ? g.title : null }))),
    [groups],
  );
  const [page, setPage] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [perPage, setPerPage] = useState(4);
  // As many names as fit, decided once per picture so nothing moves while the person looks.
  useLayoutEffect(() => {
    const h = box.current?.clientHeight ?? 0;
    if (h > 0) setPerPage(Math.max(2, Math.floor(h / ENTRY_PX)));
  }, [frame]);
  const pages = Math.max(1, Math.ceil(entries.length / perPage));
  const shown = entries.slice(page * perPage, page * perPage + perPage);
  return (
    <div className="bw-list" role="group" aria-label="Things on the page, by name">
      <button className="bw-rail-btn bw-rail-done" onClick={onDone} data-dwell>
        <Icon name="check" size={30} />
        <span>Done choosing</span>
      </button>
      {view.only ? (
        <button className="bw-rail-btn" onClick={() => onView({ set: 0, only: null })} data-dwell>
          <Icon name="labels" size={30} flat />
          <span>Show all again</span>
        </button>
      ) : (
        sets.length > 1 && (
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
        )
      )}
      <div className="bw-list-items" ref={box}>
        {shown.map((e) => (
          <div key={`${e.name}-${e.refs[0]}`} className="bw-list-entry">
            {e.group && <span className="bw-list-group">{e.group}</span>}
            <button
              className="bw-list-btn"
              onClick={() => (e.refs.length === 1 ? onPick(e.refs[0]!) : onView({ set: 0, only: e.refs }))}
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
      <Still frame={frame} />
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
