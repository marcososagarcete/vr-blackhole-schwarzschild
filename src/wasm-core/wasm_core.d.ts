/* tslint:disable */
/* eslint-disable */

export function get_constraint_residual(): number;

export function get_energy(): number;

export function get_radial_velocity(): number;

export function set_initial(r0: number, phi0: number, vhat_r: number, vhat_phi: number): boolean;

export function set_initial_3d(rx: number, ry: number, rz: number, vx: number, vy: number, vz: number): boolean;

export function set_params(m: number, eps: number, delta_tau: number): void;

export function step(n: number): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly get_constraint_residual: () => number;
    readonly set_initial: (a: number, b: number, c: number, d: number) => number;
    readonly set_initial_3d: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly step: (a: number) => [number, number];
    readonly get_energy: () => number;
    readonly get_radial_velocity: () => number;
    readonly set_params: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
