'use client';

import dynamic from 'next/dynamic';
import {
  Component,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ScreenLabel } from '../house/House.tsx';
import { houseLayout } from '../house/layout.ts';
import type { LiveHome } from '../house/looks.ts';
import { webglAvailable } from '../house/webgl.ts';
import {
  browserStorage,
  CHIPS,
  type Chip,
  dayAndTime,
  type Layout,
  readLayout,
  writeLayout,
} from './stage.ts';

// three.js and the scene load in the browser only, and only on this page.
const House = dynamic(() => import('../house/House.tsx'), { ssr: false });

// The device lays out at its full size beside the house and is zoomed out to fit, as a real screen
// looks smaller from further away rather than rearranging itself.
const DEVICE_WIDTH = 1180;
const DEVICE_HEIGHT = DEVICE_WIDTH / 1.6;

export interface StageProps {
  home: LiveHome | null;
  heard: string;
  said: string;
  busy: boolean;
  chip: Chip | null;
  /** The home's state didn't come back as expected: draw no house rather than a wrong one. */
  homeBroken: boolean;
  /** The Echo Show itself. It stays mounted in every layout, so its screen keeps its view. */
  device: ReactNode;
  /** The demo controls: typed input, suggestions, transcript. */
  controls: ReactNode;
}

/**
 * The page: the house in 3D beside the device (split), or the house alone with a caption and the
 * verdict (house only), with the demo controls in a drawer. Without WebGL, or if the house fails,
 * it's the device and its controls as before.
 */
export function Stage(props: StageProps) {
  const [house, setHouse] = useState<'checking' | 'on' | 'off'>('checking');
  const [layout, setLayout] = useState<Layout>('split');
  const [drawer, setDrawer] = useState(false);
  const [labels, setLabels] = useState<ScreenLabel[]>([]);
  const panel = useRef<HTMLElement>(null);
  const scale = useFit(panel);

  // Known only in the browser; deciding after the first render keeps the server's HTML the same.
  useEffect(() => {
    setHouse(webglAvailable() ? 'on' : 'off');
    setLayout(readLayout(browserStorage()));
  }, []);

  const choose = (next: Layout) => {
    setLayout(next);
    writeLayout(browserStorage(), next);
  };
  const fail = useCallback(() => setHouse('off'), []);

  const withHouse = house !== 'off' && !props.homeBroken;
  const houseOnly = withHouse && layout === 'house';
  return (
    <div className={withHouse ? `stage ${houseOnly ? 'house-only' : 'split'}` : 'room'}>
      {withHouse ? (
        <section className="house-panel" aria-label="The house">
          {house === 'on' ? (
            <Contained onError={fail}>
              <House
                home={props.home}
                onFail={fail}
                onLabels={setLabels}
                shift={houseOnly ? 0.08 : 0}
              />
            </Contained>
          ) : null}
          <div className="room-labels" aria-hidden="true">
            {labels.map((l) => (
              <span key={l.id} className="room-label" style={{ left: l.x, top: l.y }}>
                {l.name}
              </span>
            ))}
          </div>
          <HouseCard home={props.home} />
          <button
            type="button"
            className="layout-toggle glass"
            onClick={() => choose(houseOnly ? 'split' : 'house')}
          >
            {houseOnly ? 'Show the device' : 'House only'}
          </button>
          {houseOnly ? <Caption {...props} /> : null}
          <div className={drawer ? 'drawer open' : 'drawer'}>
            <div id="demo-controls" className="drawer-body glass" hidden={!drawer}>
              {props.controls}
            </div>
            <button
              type="button"
              className="drawer-handle glass"
              aria-expanded={drawer}
              aria-controls="demo-controls"
              onClick={() => setDrawer(!drawer)}
            >
              {drawer ? 'Hide demo controls' : 'Demo controls'}
            </button>
          </div>
        </section>
      ) : null}
      <section ref={panel} className="device-panel" aria-label="The device">
        <div className="device-scaled" style={{ '--device-scale': scale } as CSSProperties}>
          {props.device}
        </div>
        {withHouse ? null : props.controls}
      </section>
    </div>
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

/** How far to scale the device down to fit its panel. */
function useFit(panel: { current: HTMLElement | null }): number {
  const [scale, setScale] = useState(0.55);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const fit = () => {
      const style = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height =
        el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setScale(Math.max(0.2, Math.min(1, width / DEVICE_WIDTH, height / DEVICE_HEIGHT)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [panel]);
  return scale;
}

/** The home's name, its time and the two heating zones, on frosted glass. */
function HouseCard({ home }: { home: LiveHome | null }) {
  return (
    <div className="house-card glass">
      <h1 className="house-name">{houseLayout.name}</h1>
      <p className="house-time">{home ? dayAndTime(home.now) : ' '}</p>
      {home ? (
        <dl className="house-zones">
          {home.zones.map((z) => (
            <div key={z.id}>
              <dt>{z.name}</dt>
              <dd>{z.tempC.toFixed(1)} °C</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** In house-only mode, what was heard and said, and the verdict, float over the house. */
function Caption({ heard, said, busy, chip }: StageProps) {
  if (!heard && !said && !chip) return null;
  return (
    <div
      className={busy ? 'float-caption glass thinking' : 'float-caption glass'}
      aria-live="polite"
    >
      {chip ? <VerdictChip chip={chip} /> : null}
      <div className="float-words">
        {heard ? <p className="heard">“{heard}”</p> : null}
        {said ? <p className="said">{said}</p> : null}
      </div>
    </div>
  );
}

function VerdictChip({ chip }: { chip: Chip }) {
  const { icon, tone } = CHIPS[chip];
  return (
    <span className={`verdict-chip ${tone}`}>
      <span aria-hidden="true">{icon}</span> {chip}
    </span>
  );
}
