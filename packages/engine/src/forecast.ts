import type { Home } from '@shadow-home/twin';
import { toMs } from './time.ts';

/** The forecast as parallel arrays of instants and temperatures, parsed once. */
export interface ForecastSeries {
  ms: number[];
  tempC: number[];
}

export function forecastSeries(home: Home): ForecastSeries {
  return {
    ms: home.forecast.hourly.map((p) => toMs(p.time)),
    tempC: home.forecast.hourly.map((p) => p.tempC),
  };
}

/** Linear interpolation between points; undefined outside the series. */
export function interpolate(series: ForecastSeries, ms: number): number | undefined {
  const { ms: times, tempC } = series;
  for (let i = 0; i < times.length; i++) {
    const t = times[i] as number;
    if (t === ms) return tempC[i];
    if (t > ms) {
      if (i === 0) return undefined;
      const t0 = times[i - 1] as number;
      const c0 = tempC[i - 1] as number;
      return c0 + ((ms - t0) / (t - t0)) * ((tempC[i] as number) - c0);
    }
  }
  return undefined;
}

/**
 * Outdoor temperature at `ms`, linearly interpolated between hourly points and shifted by
 * `offsetC` (the pessimistic and optimistic runs). Undefined outside the forecast.
 */
export function forecastAt(home: Home, ms: number, offsetC = 0): number | undefined {
  const c = interpolate(forecastSeries(home), ms);
  return c === undefined ? undefined : c + offsetC;
}

/** First and last instant the forecast covers. */
export function forecastSpan(home: Home): { startMs: number; endMs: number } {
  const { ms } = forecastSeries(home);
  return { startMs: ms[0] ?? Number.NaN, endMs: ms[ms.length - 1] ?? Number.NaN };
}
