'use client';

import dynamic from 'next/dynamic';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ScreenLabel } from '../house/House.tsx';
import type { LiveHome } from '../house/looks.ts';
import { webglAvailable } from '../house/webgl.ts';
import { browserStorage, type Layout, readLayout, writeLayout } from './stage.ts';

// three.js and the scene load in the browser only, and only on this page.
const House = dynamic(() => import('../house/House.tsx'), { ssr: false });

export interface StageProps {
  home: LiveHome | null;
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

  const withHouse = house !== 'off';
  const houseOnly = withHouse && layout === 'house';
  return (
    <div className={withHouse ? `stage ${houseOnly ? 'house-only' : 'split'}` : 'room'}>
      {withHouse ? (
        <section className="house-panel" aria-label="The house">
          {house === 'on' ? (
            <House
              home={props.home}
              onFail={fail}
              onLabels={setLabels}
              shift={houseOnly ? 0.08 : 0}
            />
          ) : null}
          <div className="room-labels" aria-hidden="true">
            {labels.map((l) => (
              <span key={l.id} className="room-label" style={{ left: l.x, top: l.y }}>
                {l.name}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="layout-toggle glass"
            onClick={() => choose(houseOnly ? 'split' : 'house')}
          >
            {houseOnly ? 'Show the device' : 'House only'}
          </button>
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
      <section className="device-panel" aria-label="The device">
        <div className="device-scaled">{props.device}</div>
        {withHouse ? null : props.controls}
      </section>
    </div>
  );
}
