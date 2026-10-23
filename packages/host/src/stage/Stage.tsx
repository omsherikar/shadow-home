'use client';

import {
  Component,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { LiveHome } from '../house/looks.ts';
import { drawsInSoftware } from '../house/pace.ts';
import { webglRenderer } from '../house/webgl.ts';
import { HousePanel, type HouseRequest } from './HousePanel.tsx';
import {
  browserStorage,
  DEFAULT_SIZES,
  dragSize,
  keySize,
  type Layout,
  readLayout,
  readSizes,
  SIZE_RANGES,
  type Sizes,
  writeLayout,
  writeSizes,
} from './stage.ts';

// The device lays out at its full size beside the house and is zoomed out to fit, as a real screen
// looks smaller from further away rather than rearranging itself.
const DEVICE_WIDTH = 1180;
const DEVICE_HEIGHT = DEVICE_WIDTH / 1.6;

/** A phone's width, where the page stacks and the device folds into a strip. */
export const NARROW = '(max-width: 760px)';

export interface StageProps {
  home: LiveHome | null;
  /** What the house should play, from the latest tool results. */
  request: HouseRequest | null;
  /** The home's state didn't come back as expected: draw no house rather than a wrong one. */
  homeBroken: boolean;
  /** The Echo Show itself. It stays mounted in every layout, so its screen keeps its view. */
  device: ReactNode;
  /** On a phone, the device folded into a strip; `open` shows the whole screen. */
  strip(open: () => void): ReactNode;
  /** The conversation and the composer: on the page in every layout. */
  chat: ReactNode;
}

/**
 * The page: the house in 3D beside the device with the chat under it (split), or the house alone
 * with a compact chat over it (house only). On a phone they stack: the device folds into a strip
 * that opens to the whole screen, and the house is behind a toggle. Without WebGL, or if the house
 * fails, it's the device with the chat under it.
 */
export function Stage(props: StageProps) {
  const [house, setHouse] = useState<'checking' | 'on' | 'off'>('checking');
  // WebGL that draws on the CPU, where the house draws lean and doesn't sweep.
  const [lean, setLean] = useState(false);
  const [layout, setLayout] = useState<Layout>('split');
  const narrow = useMedia(NARROW);
  // On a phone the house is there only when asked for, and the screen only when opened.
  const [phoneHouse, setPhoneHouse] = useState(false);
  const [open, setOpen] = useState(false);
  const fitBox = useRef<HTMLDivElement>(null);
  const fit = useFit(fitBox);
  // Split on a wide screen, the boundaries drag. The sizes reach the page as custom properties on
  // the stage, so nothing remounts as they change; the device's fit follows its box.
  const [sizes, setSizes] = useState<Sizes>(DEFAULT_SIZES);
  const stageBox = useRef<HTMLDivElement>(null);
  const chatBox = useRef<HTMLDivElement>(null);
  const still = useMedia('(prefers-reduced-motion: reduce)');

  // Known only in the browser; deciding after the first render keeps the server's HTML the same.
  useEffect(() => {
    const renderer = webglRenderer();
    setHouse(renderer === null ? 'off' : 'on');
    setLean(renderer !== null && drawsInSoftware(renderer));
    setLayout(readLayout(browserStorage()));
    setSizes(readSizes(browserStorage()));
  }, []);

  // The whole screen closes with Escape, and on its own when the page widens.
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  const opened = open && narrow;

  const choose = (next: Layout) => {
    setLayout(next);
    writeLayout(browserStorage(), next);
  };
  // A drag moves one boundary at a time, so the other size in `sizes` is current.
  const resize = (which: keyof Sizes, value: number, done: boolean) => {
    const next = { ...sizes, [which]: value };
    setSizes(next);
    if (done) writeSizes(browserStorage(), next);
  };
  const fail = useCallback(() => setHouse('off'), []);
  const show = useCallback(() => setOpen(true), []);

  const canHouse = house !== 'off' && !props.homeBroken;
  const withHouse = canHouse && (!narrow || phoneHouse);
  const houseOnly = withHouse && !narrow && layout === 'house';
  const sized = withHouse && !houseOnly && !narrow;
  const chat = (
    <div ref={chatBox} className="chat-dock">
      {props.chat}
    </div>
  );
  const kind = withHouse ? `stage ${houseOnly ? 'house-only' : 'split'}` : 'room';
  const sizing = { '--house-w': `${sizes.house}%`, '--screen-h': sizes.screen } as CSSProperties;
  return (
    <div ref={stageBox} className={narrow ? `${kind} narrow` : kind} style={sizing}>
      {withHouse ? (
        <section className="house-panel" aria-label="The house">
          {house === 'on' ? (
            <Contained onError={fail}>
              <HousePanel
                home={props.home}
                request={props.request}
                mode={houseOnly ? 'house' : 'split'}
                still={still}
                lean={lean}
                onFail={fail}
              />
            </Contained>
          ) : null}
          {narrow ? null : (
            <button
              type="button"
              className="layout-toggle glass"
              onClick={() => choose(houseOnly ? 'split' : 'house')}
            >
              {houseOnly ? 'Show the device' : 'House only'}
            </button>
          )}
          {houseOnly ? chat : null}
        </section>
      ) : null}
      {sized ? (
        <Splitter
          which="house"
          label="Resize the house and the chat"
          value={sizes.house}
          span={() => stageBox.current?.clientWidth ?? 0}
          onChange={resize}
        />
      ) : null}
      <section className="device-panel" aria-label="The device">
        {narrow && canHouse ? (
          <button
            type="button"
            className="house-toggle"
            aria-pressed={phoneHouse}
            onClick={() => setPhoneHouse(!phoneHouse)}
          >
            {phoneHouse ? 'Hide the house' : 'Show the house'}
          </button>
        ) : null}
        {narrow ? props.strip(show) : null}
        <div
          ref={fitBox}
          className={opened ? 'device-fit opened' : 'device-fit'}
          data-turned={fit.turned ? '' : undefined}
        >
          <div className="device-scaled" style={{ '--device-scale': fit.scale } as CSSProperties}>
            {props.device}
          </div>
          {opened ? (
            <button type="button" className="close-screen" onClick={() => setOpen(false)}>
              Close
            </button>
          ) : null}
        </div>
        {sized ? (
          <Splitter
            which="screen"
            label="Resize the screen and the chat"
            value={sizes.screen}
            span={() => (fitBox.current?.offsetHeight ?? 0) + (chatBox.current?.offsetHeight ?? 0)}
            onChange={resize}
          />
        ) : null}
        {houseOnly ? null : chat}
      </section>
    </div>
  );
}

interface SplitterProps {
  /** The house's width (a bar between left and right), or the screen's height over the chat. */
  which: keyof Sizes;
  label: string;
  value: number;
  /** How many pixels make 100%, measured as a drag starts. */
  span(): number;
  /** A new size; `done` when the drag or the key press is over, so it can be remembered. */
  onChange(which: keyof Sizes, value: number, done: boolean): void;
}

/**
 * A boundary the person drags, or moves with the arrow keys 2% at a time; a double click puts it
 * back. A hairline, with a wider hit area than it shows.
 */
function Splitter({ which, label, value, span, onChange }: SplitterProps) {
  const drag = useRef<{ from: number; start: number; span: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const across = which === 'house';
  const at = (e: ReactPointerEvent) => (across ? e.clientX : e.clientY);
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.last = dragSize(which, d.start, at(e) - d.from, d.span);
    onChange(which, d.last, false);
  };
  // Released, cancelled or capture lost: it stays where it was last moved to, and is remembered.
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    onChange(which, d.last, true);
  };
  const { min, max } = SIZE_RANGES[which];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter, which an <hr> can't be.
    <div
      role="separator"
      tabIndex={0}
      className={`splitter ${across ? 'splitter-x' : 'splitter-y'}`}
      aria-label={label}
      aria-orientation={across ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { from: at(e), start: value, span: span(), last: value };
        setDragging(true);
      }}
      onPointerMove={move}
      onPointerUp={(e) => {
        move(e);
        end();
      }}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        const next = keySize(which, value, e.key);
        if (next === null) return;
        e.preventDefault();
        onChange(which, next, true);
      }}
      onDoubleClick={() => onChange(which, DEFAULT_SIZES[which], true)}
    />
  );
}

/**
 * Keeps whatever goes wrong with the house to the house: its code failing to download (a flaky
 * network, or a new deploy between loading the page and fetching the chunk), an error as it loads,
 * a model or texture that won't load, or the scene throwing. The page then becomes the device alone.
 */
class Contained extends Component<{ onError(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Whether a media query matches, following it as it changes: less motion, a phone's width. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/**
 * How far to scale the device down to fit the room it has. Opened on a phone held upright, the
 * screen turns on its side to fill it, as a person would turn the phone to read it.
 */
function useFit(box: { current: HTMLElement | null }): { scale: number; turned: boolean } {
  const [fit, setFit] = useState({ scale: 0.55, turned: false });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const h = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const turned = el.classList.contains('opened') && h > w;
      const [across, down] = turned ? [h, w] : [w, h];
      const scale = Math.max(0.2, Math.min(1, across / DEVICE_WIDTH, down / DEVICE_HEIGHT));
      setFit((f) => (f.scale === scale && f.turned === turned ? f : { scale, turned }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box]);
  return fit;
}
