use std::cell::RefCell;
use wasm_bindgen::prelude::*;

// Estado interno del simulador, persistente entre llamadas JS -> WASM.
#[derive(Clone, Copy)]
struct SimState {
    // Parámetros globales.
    m: f64,
    eps: f64,
    delta_tau: f64,

    // Estado dinámico.
    r: f64,
    vr: f64, // vr = dr/dtau, con tau igual al tiempo propio.
    phi: f64, // Ángulo psi dentro del plano orbital fijo.
    t_coord: f64, // Reservado para el tiempo coordenado de Schwarzschild.

    // Base fija del plano orbital expresada en coordenadas 3D del mundo.
    e1: [f64; 3], // Dirección radial en la condición inicial.
    e2: [f64; 3], // Dirección tangencial positiva en la condición inicial.

    // Constantes de movimiento.
    e: f64,
    l: f64,

    // Flags de control y diagnóstico.
    captured: bool,
    initialized: bool,
    motivocaptura: u32,
}

impl Default for SimState {
    fn default() -> Self {
        Self {
            m: 0.5,
            eps: 1e-3,
            delta_tau: 1e-3,
            r: 0.0,
            vr: 0.0,
            phi: 0.0,
            t_coord: 0.0,
            e1: [1.0, 0.0, 0.0],
            e2: [0.0, 1.0, 0.0],
            e: 0.0,
            l: 0.0,
            captured: false,
            initialized: false,
            motivocaptura: 0,
        }
    }
}

// Instancia global del simulador para este módulo WASM.
thread_local! {
    static SIM: RefCell<SimState> = RefCell::new(SimState::default());
}

#[wasm_bindgen]
pub fn set_params(m: f64, eps: f64, delta_tau: f64) {
    SIM.with(|sim| {
        let mut s = sim.borrow_mut();

        // Validaciones básicas para evitar valores no físicos.
        if m.is_finite() && m > 0.0 {
            s.m = m;
        }
        if eps.is_finite() && eps > 0.0 {
            s.eps = eps;
        }
        if delta_tau.is_finite() && delta_tau > 0.0 {
            s.delta_tau = delta_tau;
        }
    });
}

#[wasm_bindgen]
pub fn set_initial(r0: f64, phi0: f64, vhat_r: f64, vhat_phi: f64) -> bool {
    SIM.with(|sim| {
        let mut s = sim.borrow_mut();

        // Validación numérica básica.
        if !r0.is_finite() || !phi0.is_finite() || !vhat_r.is_finite() || !vhat_phi.is_finite() {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 1;
            return false;
        }

        // El radio inicial debe estar fuera del corte del horizonte.
        let horizon_cutoff = 2.0 * s.m + s.eps;
        if r0 <= horizon_cutoff {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 2;
            return false;
        }

        // Velocidad local física: |v_local| < 1, usando c = 1.
        let v2 = vhat_r * vhat_r + vhat_phi * vhat_phi;
        if !(v2.is_finite() && v2 >= 0.0 && v2 < 1.0) {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 3;
            return false;
        }

        // Factor de Schwarzschild en la posición inicial.
        let f0 = schwarzschild_f(s.m, r0);
        if !f0.is_finite() || f0 <= 0.0 {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 4;
            return false;
        }

        // Constantes de movimiento y velocidad radial inicial.
        let gamma = 1.0 / (1.0 - v2).sqrt();
        let e = gamma * f0.sqrt();
        let l = gamma * r0 * vhat_phi;
        let vr0 = e * vhat_r;

        if !e.is_finite() || !l.is_finite() || !vr0.is_finite() {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 4;
            return false;
        }

        // Conservar el plano XZ de la API 2D anterior mediante su frame equivalente.
        let e1 = [phi0.cos(), 0.0, phi0.sin()];
        let e2 = [-phi0.sin(), 0.0, phi0.cos()];

        // psi comienza en cero porque e1 contiene la dirección angular inicial.
        s.r = r0;
        s.vr = vr0;
        s.phi = 0.0;
        s.t_coord = 0.0;
        s.e1 = e1;
        s.e2 = e2;
        s.e = e;
        s.l = l;
        s.captured = false;
        s.initialized = true;
        s.motivocaptura = 0;

        true
    })
}

#[wasm_bindgen]
pub fn set_initial_3d(rx: f64, ry: f64, rz: f64, vx: f64, vy: f64, vz: f64) -> bool {
    SIM.with(|sim| {
        let mut s = sim.borrow_mut();

        // La posición es relativa al agujero negro y la velocidad es local física.
        if !rx.is_finite() || !ry.is_finite() || !rz.is_finite()
            || !vx.is_finite() || !vy.is_finite() || !vz.is_finite()
        {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 1;
            return false;
        }

        let r0_squared = rx * rx + ry * ry + rz * rz;
        let r0 = r0_squared.sqrt();
        let horizon_cutoff = 2.0 * s.m + s.eps;
        if !r0.is_finite() || r0 <= horizon_cutoff {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 2;
            return false;
        }

        // e1 apunta desde el agujero negro hacia la posición inicial.
        let e1 = [rx / r0, ry / r0, rz / r0];
        let vhat_r = vx * e1[0] + vy * e1[1] + vz * e1[2];
        let vt = [
            vx - vhat_r * e1[0],
            vy - vhat_r * e1[1],
            vz - vhat_r * e1[2],
        ];
        let vhat_t = (vt[0] * vt[0] + vt[1] * vt[1] + vt[2] * vt[2]).sqrt();
        let v2 = vx * vx + vy * vy + vz * vz;

        // La velocidad local física debe permanecer por debajo de c = 1.
        if !(v2.is_finite() && v2 >= 0.0 && v2 < 1.0) {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 3;
            return false;
        }

        let f0 = schwarzschild_f(s.m, r0);
        if !f0.is_finite() || f0 <= 0.0 {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 4;
            return false;
        }

        // Para un lanzamiento radial se elige una perpendicular estable a e1.
        let e2 = if vhat_t > 1e-12 {
            [vt[0] / vhat_t, vt[1] / vhat_t, vt[2] / vhat_t]
        } else {
            let axis = if e1[0].abs() <= e1[1].abs() && e1[0].abs() <= e1[2].abs() {
                [1.0, 0.0, 0.0]
            } else if e1[1].abs() <= e1[2].abs() {
                [0.0, 1.0, 0.0]
            } else {
                [0.0, 0.0, 1.0]
            };
            let perpendicular = [
                e1[1] * axis[2] - e1[2] * axis[1],
                e1[2] * axis[0] - e1[0] * axis[2],
                e1[0] * axis[1] - e1[1] * axis[0],
            ];
            let length = (perpendicular[0] * perpendicular[0]
                + perpendicular[1] * perpendicular[1]
                + perpendicular[2] * perpendicular[2])
                .sqrt();
            [
                perpendicular[0] / length,
                perpendicular[1] / length,
                perpendicular[2] / length,
            ]
        };

        // Las constantes reducidas dependen solo de las partes radial y tangencial.
        let gamma = 1.0 / (1.0 - v2).sqrt();
        let e = gamma * f0.sqrt();
        let l = gamma * r0 * vhat_t;
        let vr0 = e * vhat_r;

        if !e.is_finite() || !l.is_finite() || !vr0.is_finite() {
            s.initialized = false;
            s.captured = true;
            s.motivocaptura = 4;
            return false;
        }

        // psi comienza en cero porque e1 ya codifica la dirección inicial.
        s.r = r0;
        s.vr = vr0;
        s.phi = 0.0;
        s.t_coord = 0.0;
        s.e1 = e1;
        s.e2 = e2;
        s.e = e;
        s.l = l;
        s.captured = false;
        s.initialized = true;
        s.motivocaptura = 0;

        true
    })
}

// Factor de Schwarzschild: f(r) = 1 - 2M/r.
fn schwarzschild_f(m: f64, r: f64) -> f64 {
    1.0 - (2.0 * m / r)
}

// Reconstruye la posición espacial desde las coordenadas reducidas del plano orbital.
fn orbital_position(s: &SimState) -> [f64; 3] {
    let cos_psi = s.phi.cos();
    let q = s.phi.sin();

    [
        s.r * (cos_psi * s.e1[0] + q * s.e2[0]),
        s.r * (cos_psi * s.e1[1] + q * s.e2[1]),
        s.r * (cos_psi * s.e1[2] + q * s.e2[2]),
    ]
}

// Residuo de la restricción radial. Es un diagnóstico y no participa
// en la integración normal ni modifica el estado integrado.

#[allow(dead_code)]
fn radial_constraint_residual(s: &SimState, r: f64, vr: f64) -> f64 {
    let inv_r = 1.0 / r;
    let inv_r2 = inv_r * inv_r;
    let f = schwarzschild_f(s.m, r);
    vr * vr + f * (1.0 + s.l * s.l * inv_r2) - s.e * s.e
}

#[wasm_bindgen]
pub fn get_constraint_residual() -> f64 {
    SIM.with(|sim| {
        let s = sim.borrow();

        if !s.initialized || !s.r.is_finite() || s.r <= 0.0 {
            return f64::NAN;
        }

        radial_constraint_residual(&s, s.r, s.vr)
    })
}

#[wasm_bindgen]
pub fn get_energy() -> f64 {
    SIM.with(|sim| sim.borrow().e)
}

#[wasm_bindgen]
pub fn get_radial_velocity() -> f64 {
    SIM.with(|sim| sim.borrow().vr)
}

// Derivadas respecto del tiempo propio tau.
// El signo de vr no se cambia manualmente: su evolución produce naturalmente
// los cambios de dirección en los puntos de retorno.
fn derivatives(s: &SimState, r: f64, vr: f64) -> Option<(f64, f64, f64)> {
    let horizon_cutoff = 2.0 * s.m + s.eps;
    if !r.is_finite() || r <= horizon_cutoff || !vr.is_finite() {
        return None;
    }

    let inv_r = 1.0 / r;
    let inv_r2 = inv_r * inv_r;
    let inv_r3 = inv_r2 * inv_r;
    let inv_r4 = inv_r2 * inv_r2;
    let l2 = s.l * s.l;

    // Ecuaciones geodésicas para (r, vr, phi) en tiempo propio.
    let dr_dtau = vr;
    let dvr_dtau = -s.m * inv_r2 + l2 * inv_r3 - 3.0 * s.m * l2 * inv_r4;
    let dphi_dtau = s.l * inv_r2;

    if dr_dtau.is_finite() && dvr_dtau.is_finite() && dphi_dtau.is_finite() {
        Some((dr_dtau, dvr_dtau, dphi_dtau))
    } else {
        None
    }
}

#[wasm_bindgen]
pub fn step(n: u32) -> Vec<f64> {
    SIM.with(|sim| {
        let mut s = sim.borrow_mut();

        // No avanzar si no hay condición inicial válida o si ya se detuvo.
        if !s.initialized || s.captured {
            let position = orbital_position(&s);
            return vec![
                position[0],
                position[1],
                position[2],
                if s.captured { 1.0 } else { 0.0 },
                s.motivocaptura as f64,
            ];
        }

        for _ in 0..n {
            let horizon_cutoff = 2.0 * s.m + s.eps;
            if s.r <= horizon_cutoff {
                s.captured = true;
                s.motivocaptura = 5;
                break;
            }

            let delta_tau = s.delta_tau;
            let r0 = s.r;
            let vr0 = s.vr;
            let phi0 = s.phi;

            let Some((k1_r, k1_vr, k1_phi)) = derivatives(&s, r0, vr0) else {
                s.captured = true;
                s.motivocaptura = 11;
                break;
            };

            let r_k2 = r0 + 0.5 * delta_tau * k1_r;
            let vr_k2 = vr0 + 0.5 * delta_tau * k1_vr;
            let Some((k2_r, k2_vr, k2_phi)) = derivatives(&s, r_k2, vr_k2) else {
                s.captured = true;
                s.motivocaptura = 12;
                break;
            };

            let r_k3 = r0 + 0.5 * delta_tau * k2_r;
            let vr_k3 = vr0 + 0.5 * delta_tau * k2_vr;
            let Some((k3_r, k3_vr, k3_phi)) = derivatives(&s, r_k3, vr_k3) else {
                s.captured = true;
                s.motivocaptura = 13;
                break;
            };

            let r_k4 = r0 + delta_tau * k3_r;
            let vr_k4 = vr0 + delta_tau * k3_vr;
            let Some((k4_r, k4_vr, k4_phi)) = derivatives(&s, r_k4, vr_k4) else {
                s.captured = true;
                s.motivocaptura = 14;
                break;
            };

            // Combinar las cuatro pendientes con el RK4 clásico.
            let next_r = r0 + (delta_tau / 6.0) * (k1_r + 2.0 * k2_r + 2.0 * k3_r + k4_r);
            let next_vr = vr0 + (delta_tau / 6.0) * (k1_vr + 2.0 * k2_vr + 2.0 * k3_vr + k4_vr);
            let next_phi = phi0 + (delta_tau / 6.0) * (k1_phi + 2.0 * k2_phi + 2.0 * k3_phi + k4_phi);

            // Validar el candidato antes de aceptar el paso.
            if !next_r.is_finite() || !next_vr.is_finite() || !next_phi.is_finite() {
                s.captured = true;
                s.motivocaptura = 20;
                break;
            }

            if next_r <= horizon_cutoff {
                s.r = horizon_cutoff;
                s.vr = next_vr;
                s.phi = next_phi;
                s.captured = true;
                s.motivocaptura = 21;
                break;
            }

            // Aceptar el paso. t_coord permanece reservado y sin cambios.
            s.r = next_r;
            s.vr = next_vr;
            s.phi = next_phi;
        }

        let position = orbital_position(&s);
        vec![
            position[0],
            position[1],
            position[2],
            if s.captured { 1.0 } else { 0.0 },
            s.motivocaptura as f64,
        ]
    })
}
