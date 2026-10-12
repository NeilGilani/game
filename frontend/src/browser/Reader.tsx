/**
 * Reader view: just the article, in big, calm type, one page at a time (no scrolling: big Previous and Next page
 * targets on either side), with Read aloud that turns the pages as it goes. The text comes from the page as plain
 * text only (main/browser and Mozilla Readability in the page's preload); nothing from the page runs here.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { readAloud, type Reading } from "./speech";
import type { BrowserApi, BrowserTab, ReaderArticle, ReaderBlock } from "./store";

const SIZE_KEY = "agency.browser.readerSize";
const SIZES = [22, 26, 30, 36, 44];
const GAP = 64;

function loadSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return Number.isInteger(n) && n >= 0 && n < SIZES.length ? n : 2;
  } catch {
    return 2;
  }
}

function blockText(b: ReaderBlock): string {
  return b.type === "image" ? `Picture: ${b.alt}` : b.text;
}

function Block({ b, i, current }: { b: ReaderBlock; i: number; current: boolean }) {
  const props = { "data-block": i, "data-reading": current || undefined };
  if (b.type === "heading") return b.level <= 2 ? <h2 {...props}>{b.text}</h2> : <h3 {...props}>{b.text}</h3>;
  if (b.type === "quote") return <blockquote {...props}>{b.text}</blockquote>;
  if (b.type === "item")
    return (
      <p className="bw-reader-item" {...props}>
        <span aria-hidden>{b.ordered ? `${b.ordered}.` : "•"}</span> {b.text}
      </p>
    );
  if (b.type === "image")
    return (
      <p className="bw-reader-picture" {...props}>
        <Icon name="photo" size={22} flat /> {b.alt}
      </p>
    );
  return <p {...props}>{b.text}</p>;
}

export function Reader({ api, tab, onClose }: { api: BrowserApi; tab: BrowserTab; onClose: () => void }) {
  const [article, setArticle] = useState<ReaderArticle | null | "loading">("loading");
  const [size, setSize] = useState(loadSize);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [current, setCurrent] = useState(-1);
  const reading = useRef<Reading | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const cols = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void api.reader(tab.id).then(
      (a) => live && setArticle(a),
      () => live && setArticle(null),
    );
    return () => {
      live = false;
      reading.current?.stop();
    };
  }, [api, tab.id]);

  const measure = useCallback(() => {
    const el = cols.current;
    if (!el) return;
    const width = el.clientWidth + GAP;
    setPages(Math.max(1, Math.ceil((el.scrollWidth + GAP - 4) / width)));
  }, []);
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (cols.current) ro.observe(cols.current);
    return () => ro.disconnect();
  }, [measure, article, size]);

  useLayoutEffect(() => {
    const el = cols.current;
    if (el) el.scrollTo({ left: page * (el.clientWidth + GAP), behavior: "instant" });
  }, [page, pages, size]);

  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, [page]);

  const setTextSize = (n: number) => {
    const s = Math.max(0, Math.min(SIZES.length - 1, n));
    setSize(s);
    setPage(0);
    try {
      localStorage.setItem(SIZE_KEY, String(s));
    } catch {
      /* ignore */
    }
  };

  /** The page a block is on, from where the columns put it. */
  const pageOf = (i: number): number => {
    const el = cols.current;
    const b = el?.querySelector<HTMLElement>(`[data-block="${i}"]`);
    if (!el || !b) return page;
    const left = b.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    return Math.max(0, Math.floor((left + 4) / (el.clientWidth + GAP)));
  };

  const toggleRead = () => {
    if (reading.current) {
      reading.current.stop();
      reading.current = null;
      setSpeaking(false);
      setCurrent(-1);
      return;
    }
    if (!article || article === "loading") return;
    // From the top of the page being shown (with the title on the first page).
    const first = article.blocks.findIndex((_, i) => pageOf(i) >= page);
    const from = first < 0 ? 0 : first;
    const items: { text: string; block: number }[] = [];
    if (from === 0) items.push({ text: article.title, block: -1 });
    article.blocks.forEach((b, i) => {
      if (i >= from) items.push({ text: blockText(b), block: i });
    });
    setSpeaking(true);
    const r = readAloud(
      items.map((x) => x.text),
      (k) => {
        const block = k < 0 ? -1 : (items[k]?.block ?? -1);
        setCurrent(block);
        if (block >= 0) {
          const p = pageOf(block);
          setPage((cur) => (cur === p ? cur : p));
        }
      },
    );
    reading.current = r;
    void r.done.then(() => {
      if (reading.current === r) {
        reading.current = null;
        setSpeaking(false);
      }
    });
  };

  return (
    <div
      className="bw-reader"
      role="dialog"
      aria-label="Reader view"
      style={{ ["--reader-size" as string]: `${SIZES[size]}px` }}
    >
      <div className="bw-reader-bar">
        <button className="bw-tool" onClick={onClose} data-dwell>
          <Icon name="x" size={26} />
          <span>Close reader</span>
        </button>
        <button className="bw-tool" onClick={() => setTextSize(size - 1)} disabled={size === 0} data-dwell>
          <Icon name="zoom-out" size={26} flat />
          <span>Smaller text</span>
        </button>
        <button
          className="bw-tool"
          onClick={() => setTextSize(size + 1)}
          disabled={size === SIZES.length - 1}
          data-dwell
        >
          <Icon name="zoom-in" size={26} flat />
          <span>Bigger text</span>
        </button>
        <button
          className={`bw-tool ${speaking ? "bw-tool-active" : ""}`}
          onClick={toggleRead}
          disabled={!article || article === "loading"}
          data-dwell
        >
          <Icon name={speaking ? "stop" : "volume"} size={26} flat />
          <span>{speaking ? "Stop reading" : "Read aloud"}</span>
        </button>
        <span className="bw-reader-pageno" aria-live="polite">
          Page {Math.min(page + 1, pages)} of {pages}
        </span>
      </div>
      <div className="bw-reader-body">
        <button
          className="bw-reader-turn"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          data-dwell
          aria-label="Previous page"
        >
          <Icon name="left" size={40} />
          <span>Previous page</span>
        </button>
        <article className="bw-reader-page">
          {article === "loading" ? (
            <p className="muted">Getting the article…</p>
          ) : !article ? (
            <div className="bw-reader-none">
              <h2>No article here</h2>
              <p>This page has nothing to read in Reader view. Close it to see the page.</p>
            </div>
          ) : (
            <div className="bw-reader-cols" ref={cols}>
              <h1>{article.title}</h1>
              <p className="bw-reader-meta">
                {[article.byline, article.site, `${article.minutes} min read`].filter(Boolean).join(" · ")}
                {article.plainText && " · This page isn't an article, so this is all its text."}
              </p>
              {article.blocks.map((b, i) => (
                <Block key={i} b={b} i={i} current={i === current} />
              ))}
            </div>
          )}
        </article>
        <button
          className="bw-reader-turn"
          onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
          disabled={page >= pages - 1}
          data-dwell
          aria-label="Next page"
        >
          <Icon name="right" size={40} />
          <span>Next page</span>
        </button>
      </div>
    </div>
  );
}
