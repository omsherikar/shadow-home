import type { Capability } from './schema.ts';

// Matter clusters the twin models, the attributes each one exposes under our names,
// and the Alexa interface that carries them. A device's capabilities (writable) and
// state (readable) must come from its clusters; validateHome checks that.

export type AttrAccess = 'write' | 'read';

export interface ClusterAttr {
  /** Our attribute name, as used in device capabilities, state, plans and rules. */
  name: string;
  access: AttrAccess;
  /** Alexa interface that exposes this attribute, or null when Alexa has none. */
  alexa: string | null;
  /**
   * Values a read-only attribute can take. Writable attributes get theirs from each device's
   * capabilities instead, since ranges differ by device.
   */
  domain?: Capability;
}

export interface ClusterSpec {
  /** Matter cluster ID. */
  id: string;
  attrs: readonly ClusterAttr[];
}

export const CLUSTER_NAMES = [
  'OnOff',
  'LevelControl',
  'Thermostat',
  'DoorLock',
  'BooleanState',
  'OccupancySensing',
  'ElectricalPowerMeasurement',
  'OperationalState',
  'SmokeCoAlarm',
] as const;

export type ClusterName = (typeof CLUSTER_NAMES)[number];

export const CLUSTERS: Readonly<Record<ClusterName, ClusterSpec>> = {
  OnOff: {
    id: '0x0006',
    attrs: [{ name: 'onOff', access: 'write', alexa: 'Alexa.PowerController' }],
  },
  LevelControl: {
    id: '0x0008',
    attrs: [{ name: 'brightness', access: 'write', alexa: 'Alexa.BrightnessController' }],
  },
  Thermostat: {
    id: '0x0201',
    attrs: [
      { name: 'systemMode', access: 'write', alexa: 'Alexa.ThermostatController' },
      { name: 'heatingSetpointC', access: 'write', alexa: 'Alexa.ThermostatController' },
      {
        name: 'localTemperatureC',
        access: 'read',
        alexa: 'Alexa.TemperatureSensor',
        domain: { type: 'number', min: -50, max: 60, step: 0.01 },
      },
    ],
  },
  DoorLock: {
    id: '0x0101',
    attrs: [{ name: 'lockState', access: 'write', alexa: 'Alexa.LockController' }],
  },
  BooleanState: {
    id: '0x0045',
    attrs: [
      {
        name: 'contact',
        access: 'read',
        alexa: 'Alexa.ContactSensor',
        domain: { type: 'enum', values: ['open', 'closed'] },
      },
    ],
  },
  OccupancySensing: {
    id: '0x0406',
    attrs: [
      {
        name: 'occupied',
        access: 'read',
        alexa: 'Alexa.MotionSensor',
        domain: { type: 'boolean' },
      },
    ],
  },
  ElectricalPowerMeasurement: {
    id: '0x0090',
    // No Alexa interface reports instantaneous power to a skill.
    attrs: [
      {
        name: 'activePowerW',
        access: 'read',
        alexa: null,
        domain: { type: 'number', min: 0, max: 100_000, step: 0.01 },
      },
    ],
  },
  OperationalState: {
    id: '0x0060',
    attrs: [
      {
        name: 'operationalState',
        access: 'read',
        alexa: null,
        domain: { type: 'enum', values: ['stopped', 'running', 'paused', 'error'] },
      },
    ],
  },
  SmokeCoAlarm: {
    id: '0x005C',
    attrs: [
      {
        name: 'smokeState',
        access: 'read',
        alexa: null,
        domain: { type: 'enum', values: ['normal', 'warning', 'critical'] },
      },
      // Matter has no writable "enabled" attribute. It stands for the controller-level
      // switch an assistant could flip to silence the alarm, which R12 forbids.
      { name: 'enabled', access: 'write', alexa: null },
    ],
  },
};

export function isClusterName(name: string): name is ClusterName {
  return (CLUSTER_NAMES as readonly string[]).includes(name);
}

/** The cluster attribute for `attr` among `clusters`, or undefined. */
export function findClusterAttr(
  clusters: readonly string[],
  attr: string,
): (ClusterAttr & { cluster: ClusterName }) | undefined {
  for (const cluster of clusters) {
    if (!isClusterName(cluster)) continue;
    const found = CLUSTERS[cluster].attrs.find((a) => a.name === attr);
    if (found) return { ...found, cluster };
  }
  return undefined;
}
