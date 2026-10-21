'use client';

import {
  Component,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { LiveHome } from '../house/looks.ts';
import { drawsInSoftware } from '../house/pace.ts';
import { webglRenderer } from '../house/webgl.ts';
import { HousePanel, type HouseRequest } from './HousePanel.tsx';
import { browserStorage, type Layout, readLayout, writeLayout } from './stage.ts';

// The device lays out at its full size beside the house and is zoomed out to fit, as a real screen
// looks smaller from further away rather than rearranging itself.
const DEVICE_WIDTH = 1180;
const DEVICE_HEIGHT = DEVICE_WIDTH / 1.6;

export interface StageProps {
  home: LiveHome | null;
  /** What the house should play, from the latest tool results. */
  request: HouseRequest | null;
  /** The home's state didn't come back as expected: draw no house rather than a wrong one. */
  homeBroken: boolean;
  /** The Echo Show itself. It stays mounted in every layout, so its screen keeps its view. */
  device: ReactNode;
  /** The conversation and the composer: on the page in every layout. */
  chat: ReactNode;
}

/**
 * The page: the house in 3D beside the device with the chat under it (split), or the house alone
 * with a compact chat over it (house only). Without WebGL, or if the house fails, it's the device
 * with the chat under it.
 */
export function Stage(props: StageProps) {
  const [house, setHouse] = useState<'checking' | 'on' | 'off'>('checking');
  // WebGL that draws on the CPU, where the house draws lean and doesn't sweep.
  const [lean, setLean] = useState(false);
  const [layout, setLayout] = useState<Layout>('split');
  const fitBox = useRef<HTMLDivElement>(null);
  const scale = useFit(fitBox);
  const still = useMedia('(prefers-reduced-motion: reduce)');

  // Known only in the browser; deciding after the first render keeps the server's HTML the same.
  useEffect(() => {
    const renderer = webglRenderer();
    setHouse(renderer === null ? 'off' : 'on');
    setLean(renderer !== null && drawsInSoftware(renderer));
    setLayout(readLayout(browserStorage()));
  }, []);

  const choose = (next: Layout) => {
    setLayout(next);
    writeLayout(browserStorage(), next);
  };
  const fail = useCallback(() => setHouse('off'), []);

  const withHouse = house !== 'off' && !props.homeBroken;
  const houseOnly = withHouse && layout === 'house';
  const chat = <div className="chat-dock">{props.chat}</div>;
  return (
    <div className={withHouse ? `stage ${houseOnly ? 'house-only' : 'split'}` : 'room'}>
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
          <button
            type="button"
            className="layout-toggle glass"
            onClick={() => choose(houseOnly ? 'split' : 'house')}
          >
            {houseOnly ? 'Show the device' : 'House only'}
          </button>
          {houseOnly ? chat : null}
        </section>
      ) : null}
      <section className="device-panel" aria-label="The device">
        <div ref={fitBox} className="device-fit">
          <div className="device-scaled" style={{ '--device-scale': scale } as CSSProperties}>
            {props.device}
          </div>
        </div>
        {houseOnly ? null : chat}
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

/** How far to scale the device down to fit the room it has. */
function useFit(box: { current: HTMLElement | null }): number {
  const [scale, setScale] = useState(0.55);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const h = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setScale(Math.max(0.2, Math.min(1, w / DEVICE_WIDTH, h / DEVICE_HEIGHT)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box]);
  return scale;
}
