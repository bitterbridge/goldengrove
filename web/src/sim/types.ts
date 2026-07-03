/** Mirrors gg-gen's SystemDescriptor JSON (schema v2). */

export const AU_M = 1.495978707e11;
export const SCHEMA_VERSION = 2;

export interface OrbitalElements {
  semi_major_axis_m: number;
  eccentricity: number;
  inclination_rad: number;
  raan_rad: number;
  arg_periapsis_rad: number;
  mean_anomaly_epoch_rad: number;
}

export interface SecularRates {
  apsidal_rad_per_s: number;
  nodal_rad_per_s: number;
  migration_m_per_s: number;
}

export interface Star {
  mass_kg: number;
  radius_m: number;
  luminosity_w: number;
  temperature_k: number;
  main_sequence_lifetime_s: number;
  orbit: OrbitalElements | null;
}

export type PlanetClass = 'Rocky' | 'IceGiant' | 'GasGiant';
export type PlanetHost = 'Barycenter' | 'Primary';

export type WorldState =
  | { kind: 'Living' }
  | { kind: 'Dead' }
  | { kind: 'Doomed'; doom_time_s: number };

export interface LeapTerm { every_years: number; add_days: number }
export interface LeapRule { base_days: number; terms: LeapTerm[] }
export interface MonthCycle { moon_index: number; synodic_days: number }

export interface Calendar {
  solar_day_s: number;
  year_solar_days: number;
  leap: LeapRule;
  months: MonthCycle[];
}

export interface Moon {
  mass_kg: number;
  radius_m: number;
  orbit: OrbitalElements;
  secular: SecularRates;
  tidally_locked: boolean;
  rotation_period_s: number;
  doom_time_s: number | null;
}

export interface Planet {
  class: PlanetClass;
  mass_kg: number;
  radius_m: number;
  orbit: OrbitalElements;
  secular: SecularRates;
  axial_tilt_rad: number;
  axial_precession_rad_per_s: number;
  rotation_period_s: number;
  spin_drift_s_per_s: number;
  state: WorldState;
  moons: Moon[];
  calendar: Calendar | null;
}

export interface SystemDescriptor {
  schema_version: number;
  seed: string;
  age_s: number;
  stars: Star[];
  planet_host: PlanetHost;
  planets: Planet[];
  anchor_planet: number;
}

export interface DateTime { year: number; day_of_year: number; day_fraction: number }
