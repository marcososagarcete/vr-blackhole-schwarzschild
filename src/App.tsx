import './App.css'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {  XR, createXRStore, XROrigin, useXRInputSourceEvent, useXRInputSourceState } from '@react-three/xr'
import { useRef, useState, useEffect } from 'react'
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Line as ThreeLine, LineBasicMaterial, Mesh, Object3D, Quaternion, Vector3 } from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import initWasm, { get_radial_velocity, set_params, set_initial, set_initial_3d, step } from './wasm-core/wasm_core'
const xrStore = createXRStore()

const BLACK_HOLE_POSITION = { x: 0, y: 1.4, z: 0 }
const TRAIL_MAX_POINTS = 10_000
const THROW_SAMPLE_CAPACITY = 24
const THROW_SAMPLE_WINDOW_SECONDS = 0.12
const THROW_RELEASE_GUARD_SECONDS = 0.04
const THROW_MIN_SAMPLE_SPAN_SECONDS = 0.025
const INPUT_TO_PHYSICAL_SCALE = 0.2
const MAX_PHYSICAL_SPEED = 0.99

type InitialConditions = {
	r0: number
	phi0: number
	vhat_r: number
	vhat_phi: number
}

type SimulationDebug = {
	r0: number
	position: [number, number, number]
	inputVelocity: [number, number, number]
	inputSpeed: number
	physicalVelocity: [number, number, number]
	physicalSpeed: number
	alpha0: number
	currentR: number
	radialVelocity: number
	status: string
}

type XRRayPointerState = {
	inputSource?: { handedness?: string }
	object?: Object3D
}

type XRThrowPhase = 'idle' | 'grabbed' | 'released'

type XRPositionSample = {
	time: number
	position: Vector3
}

// Aplicar en un único lugar la calibración y el límite usados por el HUD y Rust.
function copyPhysicalVelocity(inputVelocity: Vector3, target: Vector3) {
	target.copy(inputVelocity).multiplyScalar(INPUT_TO_PHYSICAL_SCALE)
	const speedSquared = target.lengthSq()
	if (speedSquared > MAX_PHYSICAL_SPEED * MAX_PHYSICAL_SPEED) {
		target.multiplyScalar(MAX_PHYSICAL_SPEED / Math.sqrt(speedSquared))
	}
	return target
}

function XRResetButton({ onReset }: { onReset: () => void }) {
	const rightController = useXRInputSourceState('controller', 'right')
	const wasPressed = useRef(false)

	useFrame(() => {
		const pressed = 
			rightController?.gamepad['a-button']?.state === 'pressed'
		if (pressed && !wasPressed.current) {
			onReset()
		}
		wasPressed.current = pressed
	})
	return null
}

function App() {


const XRLocomotion = () => {
	const leftController = useXRInputSourceState('controller', 'left')
	const rightController = useXRInputSourceState('controller', 'right')
	const { camera } = useThree()

	const forwardRef = useRef(new Vector3())
	const rightRef = useRef(new Vector3())
	const moveRef = useRef(new Vector3())
	// Vectores reutilizados para girar alrededor de la cabeza, no del origen global.
	const cameraPositionBeforeTurnRef = useRef(new Vector3())
	const cameraPositionAfterTurnRef = useRef(new Vector3())

	useFrame((_, delta) => {
		if (!leftController || !xrOriginRef.current) return

		const leftStick =
			leftController.gamepad['xr-standard-thumbstick']

		if (!leftStick) return

		let x = leftStick.xAxis ?? 0
		let y = leftStick.yAxis ?? 0

		// Evitar drift del joystick
		const DEADZONE = 0.15
		if (Math.abs(x) < DEADZONE) x = 0
		if (Math.abs(y) < DEADZONE) y = 0

		const forward = forwardRef.current
		const right = rightRef.current
		const move = moveRef.current

		// Dirección hacia donde mira el usuario
		camera.getWorldDirection(forward)
		forward.y = 0
		forward.normalize()

		right.crossVectors(forward, camera.up).normalize()

		move.set(0, 0, 0)
		move.addScaledVector(right, x)
		move.addScaledVector(forward, -y)

		if (move.lengthSq() > 1)
			move.normalize()

		const SPEED = 2.5
		move.multiplyScalar(SPEED * delta)

		// IMPORTANTE: no tocamos Y
		xrOriginRef.current.position.x += move.x
		xrOriginRef.current.position.z += move.z
	
		// RS: girar en el lugar alrededor de la posición horizontal actual de la cabeza.
		const rightStick = 
			rightController?.gamepad['xr-standard-thumbstick']

		if (rightStick) {
			let x = rightStick.xAxis ?? 0
			const DEADZONE = 0.15
			if (Math.abs(x) < DEADZONE) x = 0
			const ROTATION_SPEED = 2.2
			const turnAngle = -x * ROTATION_SPEED * delta

			if (turnAngle !== 0) {
				// En VR la cabeza tiene un offset físico respecto a XROrigin. Si solo se
				// rota el grupo, ese offset describe un arco y parece que el jugador camina.
				// Se conserva la posición mundial de la cámara para que el giro sea in situ.
				camera.getWorldPosition(cameraPositionBeforeTurnRef.current)
				xrOriginRef.current.rotation.y += turnAngle
				xrOriginRef.current.updateWorldMatrix(true, true)
				camera.getWorldPosition(cameraPositionAfterTurnRef.current)

				xrOriginRef.current.position.x +=
					cameraPositionBeforeTurnRef.current.x - cameraPositionAfterTurnRef.current.x
				xrOriginRef.current.position.z +=
					cameraPositionBeforeTurnRef.current.z - cameraPositionAfterTurnRef.current.z
			}
		}
	
	// L2/R2: bajar/subir altura
		const leftGrip =
			leftController?.gamepad['xr-standard-squeeze']
		const rightGrip =
			rightController?.gamepad['xr-standard-squeeze']

		const HEIGHT_SPEED = 2.5

		if (leftGrip?.state === 'pressed') {
			xrOriginRef.current.position.y -= HEIGHT_SPEED * delta
		}

		if (rightGrip?.state === 'pressed') {
			xrOriginRef.current.position.y += HEIGHT_SPEED * delta
		}

	} //Fin del useframe del movimiento
		)

	return null
}


	const particleRef = useRef<Mesh>(null)
	// Buffer preasignado para evitar crear memoria nueva durante cada frame.
	const trailPositionsRef = useRef(new Float32Array(TRAIL_MAX_POINTS * 3))
	const trailPointCountRef = useRef(0)
	const trailGeometryRef = useRef<BufferGeometry>(null)
	const trailAttributeRef = useRef<BufferAttribute>(null)

	// Referencia al origen del jugador en XR
	const xrOriginRef = useRef<Group>(null)

	//Indica si la simulacion debe avanza en cada frame
	const simRunningRef = useRef(false)

//Movi ciertas constantes debajo de esto, referentes al modulo wasm

// Indica si el modulo WASM ya fue cargado
	const [wasmReady, setWasmReady] = useState(false)

		const [initialConditions, setInitialConditions] = useState<InitialConditions | null>(null)
//Modulo de velocidad local para mostrar en el HUD
		const [vhatMag, setVhatMag] = useState<number | null>(null)
		const [simulationDebug, setSimulationDebug] = useState<SimulationDebug | null>(null)
		const simulationDebugRef = useRef<SimulationDebug | null>(null)



		// Estado único del agarre y estimador temporal del lanzamiento XR.
		const xrThrowPhaseRef = useRef<XRThrowPhase>('idle')
		const xrGrabIdRef = useRef(0)
		const xrGrabbedHandRef = useRef<'left' | 'right' | null>(null)
		const xrGrabOffsetRef = useRef(new Vector3())
		const xrPreviousParticlePositionRef = useRef(new Vector3())
		const xrPreviousRelativePositionRef = useRef(new Vector3())
		const xrPreviousSampleTimeRef = useRef(0)
		const xrHasPreviousPositionRef = useRef(false)
		const xrPositionSamplesRef = useRef<XRPositionSample[]>(
			Array.from({ length: THROW_SAMPLE_CAPACITY }, () => ({
				time: Number.NEGATIVE_INFINITY,
				position: new Vector3(),
			})),
		)
		const xrVelocitySampleCountRef = useRef(0)
		const xrVelocitySampleIndexRef = useRef(0)
		const xrEstimateSampleCountRef = useRef(0)
		const xrEstimatedVelocityLocalRef = useRef(new Vector3())
		const xrOriginQuaternionRef = useRef(new Quaternion())
		const xrLiveInputVelocityWorldRef = useRef(new Vector3())
		// Velocidad física candidata que se usaría si la pelota se soltara ahora.
		const xrLivePhysicalVelocityRef = useRef(new Vector3())
		// Instrumentación temporal para comparar la última muestra, el promedio y el envío.
		const xrLastPhysicalVelocityRef = useRef(new Vector3())
		const xrSentPhysicalVelocityRef = useRef(new Vector3())
		const xrSentSampleCountRef = useRef(0)
		const xrSentSampleIndexRef = useRef(0)

	const clearXRThrowSamples = () => {
		for (const sample of xrPositionSamplesRef.current) {
			sample.time = Number.NEGATIVE_INFINITY
			sample.position.set(0, 0, 0)
		}
		xrVelocitySampleCountRef.current = 0
		xrVelocitySampleIndexRef.current = 0
		xrEstimateSampleCountRef.current = 0
		xrPreviousSampleTimeRef.current = 0
		xrHasPreviousPositionRef.current = false
	}

// Cargar el modulo Rust/WASM una sola vez al iniciar React
useEffect(() => {
	initWasm()
	.then(() => {
		// Parametros iniciales del solver: M, eps, dt
		set_params(0.25, 1e-3, 1e-3)
		setWasmReady(true)
		console.log('Wasm listo')
	})
	.catch((err) => {
		console.error('Error cargando WASM', err)
	})
}, [])

//Reiniciar la pelota y detiene su movimiento 

useEffect(() => {
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.code === 'Enter') {
			resetParticle()
		}
	}
window.addEventListener('keydown', onKeyDown)
return () => window.removeEventListener('keydown', onKeyDown)
}, [wasmReady])

useEffect(() => {
	// Helpers temporales para probar órbitas desde la consola del navegador.
	;(window as any).setOrbit = applyInitialConditions
	;(window as any).set3d = applyInitialConditions3d
}, [wasmReady])





	const MIN_R0 = 0.05

	const clearTrail = () => {
		trailPointCountRef.current = 0
		trailGeometryRef.current?.setDrawRange(0, 0)

		// Notificar a Three.js que el buffer cambió aunque no se añadan puntos nuevos.
		if (trailAttributeRef.current) {
			trailAttributeRef.current.needsUpdate = true
		}
	}

	const appendTrailPoint = (x: number, y: number, z: number) => {
		const pointIndex = trailPointCountRef.current

		// Se conserva el recorrido desde el inicio hasta alcanzar el límite visual.
		if (pointIndex >= TRAIL_MAX_POINTS) return

		const arrayIndex = pointIndex * 3
		const positions = trailPositionsRef.current
		positions[arrayIndex] = x
		positions[arrayIndex + 1] = y
		positions[arrayIndex + 2] = z
		trailPointCountRef.current += 1

		// Actualizar solo la línea de Three.js, sin causar un re-render de React.
		trailGeometryRef.current?.setDrawRange(0, trailPointCountRef.current)
		if (trailAttributeRef.current) {
			trailAttributeRef.current.needsUpdate = true
		}
	}

	const OrbitTrail = () => {
		const { scene } = useThree()

		useEffect(() => {
			// La línea usa el mismo buffer preasignado que actualiza la simulación.
			const geometry = new BufferGeometry()
			const attribute = new BufferAttribute(trailPositionsRef.current, 3)
			attribute.setUsage(DynamicDrawUsage)
			geometry.setAttribute('position', attribute)
			geometry.setDrawRange(0, trailPointCountRef.current)

			const material = new LineBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.9 })
			const trailLine = new ThreeLine(geometry, material)
			trailLine.frustumCulled = false
			scene.add(trailLine)
			trailGeometryRef.current = geometry
			trailAttributeRef.current = attribute

			return () => {
				scene.remove(trailLine)
				geometry.dispose()
				material.dispose()
				trailGeometryRef.current = null
				trailAttributeRef.current = null
			}
		}, [scene])

		return null
	}

	const resetParticle = () => { 
		// Detener la simulacion actual
		simRunningRef.current = false 

		// Limpiar por completo el ciclo XR antes del próximo lanzamiento.
		xrThrowPhaseRef.current = 'idle'
		xrGrabbedHandRef.current = null
		xrGrabOffsetRef.current.set(0, 0, 0)
		xrPreviousParticlePositionRef.current.set(0, 0, 0)
		xrPreviousRelativePositionRef.current.set(0, 0, 0)
		xrLiveInputVelocityWorldRef.current.set(0, 0, 0)
		xrLivePhysicalVelocityRef.current.set(0, 0, 0)
		xrLastPhysicalVelocityRef.current.set(0, 0, 0)
		xrSentPhysicalVelocityRef.current.set(0, 0, 0)
		xrSentSampleCountRef.current = 0
		xrSentSampleIndexRef.current = 0
		clearXRThrowSamples()

		//Mover la pelota a la posicion inicial
		if (particleRef.current) {
			particleRef.current.position.set(1.4, 1.4, -1)
		}
		clearTrail()
		appendTrailPoint(1.4, 1.4, -1)
		//Limpiar datos de HUD

		setInitialConditions(null)
		setVhatMag(null)
		simulationDebugRef.current = null
		setSimulationDebug(null)

		//Reiniciar estado del solver WASM con velocidad cero

		if (wasmReady) {
			set_initial_3d(1.4, 0.0, -1.0, 0.0, 0.0, 0.0)
		}
	}

//Aplicar condiciones iniciales, esto ayuda a usar la consola del browser y ver orbitas
	const applyInitialConditions = (r0: number, phi0: number, vhat_r: number, vhat_phi: number) => {
		//Detener simulacion antes de cambiar condiciones
		simRunningRef.current = false

		// Mover la particula a (r0, phi0)
		if (particleRef.current) {
			particleRef.current.position.set(
				r0*Math.cos(phi0),
				1.4,
				r0 * Math.sin(phi0),
			)
		}
		clearTrail()
		appendTrailPoint(r0 * Math.cos(phi0), 1.4, r0 * Math.sin(phi0))
	//Guardar datos para HUD
	setInitialConditions({ r0, phi0, vhat_r, vhat_phi })
	setVhatMag(Math.hypot(vhat_r, vhat_phi))

	// Enviar condiciones al solver Rust/WASM
	if (wasmReady) {
		const ok = set_initial(r0, phi0, vhat_r, vhat_phi)
		simRunningRef.current = ok
		console.log('manual set_initial ->', { ok, r0, phi0, vhat_r, vhat_phi })
	}
	}

	// Aplicar condiciones 3D reproducibles desde la consola en coordenadas esféricas.
	const applyInitialConditions3d = (
		r0: number,
		theta0: number,
		phi0: number,
		vhat_r: number,
		vhat_theta: number,
		vhat_phi: number,
	) => {
		// Detener la simulación anterior antes de crear una trayectoria nueva.
		simRunningRef.current = false

		const values = [r0, theta0, phi0, vhat_r, vhat_theta, vhat_phi]
		const vhat2 = vhat_r * vhat_r + vhat_theta * vhat_theta + vhat_phi * vhat_phi
		if (!values.every(Number.isFinite) || r0 <= MIN_R0 || vhat2 >= 1.0) {
			console.warn('set3d inválido: verificar radio, ángulos y |vhat| < 1', {
				r0, theta0, phi0, vhat_r, vhat_theta, vhat_phi,
			})
			return false
		}

		const sinTheta = Math.sin(theta0)
		const cosTheta = Math.cos(theta0)
		const sinPhi = Math.sin(phi0)
		const cosPhi = Math.cos(phi0)

		// Posición relativa al agujero negro, con Y como eje polar vertical.
		const rx = r0 * sinTheta * cosPhi
		const ry = r0 * cosTheta
		const rz = r0 * sinTheta * sinPhi

		// Base esférica ortonormal local: radial, polar y azimutal.
		const er = [sinTheta * cosPhi, cosTheta, sinTheta * sinPhi]
		const eTheta = [cosTheta * cosPhi, -sinTheta, cosTheta * sinPhi]
		const ePhi = [-sinPhi, 0, cosPhi]

		// Convertir la velocidad local física a las coordenadas cartesianas de Rust.
		const vx = vhat_r * er[0] + vhat_theta * eTheta[0] + vhat_phi * ePhi[0]
		const vy = vhat_r * er[1] + vhat_theta * eTheta[1] + vhat_phi * ePhi[1]
		const vz = vhat_r * er[2] + vhat_theta * eTheta[2] + vhat_phi * ePhi[2]

		const worldX = BLACK_HOLE_POSITION.x + rx
		const worldY = BLACK_HOLE_POSITION.y + ry
		const worldZ = BLACK_HOLE_POSITION.z + rz

		// Mostrar la condición inicial y reiniciar la trayectoria visible.
		particleRef.current?.position.set(worldX, worldY, worldZ)
		clearTrail()
		appendTrailPoint(worldX, worldY, worldZ)
		setInitialConditions({ r0, phi0, vhat_r, vhat_phi })
		setVhatMag(Math.sqrt(vhat2))

		if (!wasmReady) {
			console.warn('set3d: WASM todavía no está listo')
			return false
		}

		// Rust construye el frame orbital y acepta o rechaza la condición física.
		const ok = set_initial_3d(rx, ry, rz, vx, vy, vz)
		simRunningRef.current = ok
		console.log('manual set3d ->', {
			ok, r0, theta0, phi0, vhat_r, vhat_theta, vhat_phi, rx, ry, rz, vx, vy, vz,
		})

		return ok
	}


	const updateXRThrowEstimate = (now: number) => {
		const xrOrigin = xrOriginRef.current
		if (!xrOrigin) return

		// La ventana termina antes del instante actual para ignorar la perturbación
		// mecánica que puede producir el dedo al liberar el gatillo.
		const endTime = now - THROW_RELEASE_GUARD_SECONDS
		const startTime = endTime - THROW_SAMPLE_WINDOW_SECONDS
		let count = 0
		let meanTime = 0
		let meanX = 0
		let meanY = 0
		let meanZ = 0
		let firstTime = Number.POSITIVE_INFINITY
		let lastTime = Number.NEGATIVE_INFINITY

		for (const sample of xrPositionSamplesRef.current) {
			if (sample.time < startTime || sample.time > endTime) continue
			count += 1
			meanTime += sample.time
			meanX += sample.position.x
			meanY += sample.position.y
			meanZ += sample.position.z
			firstTime = Math.min(firstTime, sample.time)
			lastTime = Math.max(lastTime, sample.time)
		}

		xrEstimateSampleCountRef.current = count
		const estimatedLocalVelocity = xrEstimatedVelocityLocalRef.current.set(0, 0, 0)
		if (count < 2 || lastTime - firstTime < THROW_MIN_SAMPLE_SPAN_SECONDS) {
			xrLiveInputVelocityWorldRef.current.set(0, 0, 0)
			xrLivePhysicalVelocityRef.current.set(0, 0, 0)
			return
		}

		meanTime /= count
		meanX /= count
		meanY /= count
		meanZ /= count
		let denominator = 0
		let numeratorX = 0
		let numeratorY = 0
		let numeratorZ = 0

		// Regresión lineal: estima una velocidad suave usando posiciones y tiempo real.
		for (const sample of xrPositionSamplesRef.current) {
			if (sample.time < startTime || sample.time > endTime) continue
			const centeredTime = sample.time - meanTime
			denominator += centeredTime * centeredTime
			numeratorX += centeredTime * (sample.position.x - meanX)
			numeratorY += centeredTime * (sample.position.y - meanY)
			numeratorZ += centeredTime * (sample.position.z - meanZ)
		}

		if (denominator <= 1e-9) {
			xrLiveInputVelocityWorldRef.current.set(0, 0, 0)
			xrLivePhysicalVelocityRef.current.set(0, 0, 0)
			return
		}

		estimatedLocalVelocity.set(
			numeratorX / denominator,
			numeratorY / denominator,
			numeratorZ / denominator,
		)

		// La estimación elimina la locomoción en espacio local. Antes de enviarla
		// a Rust se rota nuevamente a los ejes mundiales, sin aplicar traslación.
		xrOrigin.updateWorldMatrix(true, false)
		xrOrigin.getWorldQuaternion(xrOriginQuaternionRef.current)
		xrLiveInputVelocityWorldRef.current
			.copy(estimatedLocalVelocity)
			.applyQuaternion(xrOriginQuaternionRef.current)
		copyPhysicalVelocity(xrLiveInputVelocityWorldRef.current, xrLivePhysicalVelocityRef.current)
	}

	// Ruta común: la estimación XR entrega posición y velocidad mundiales.
	const releaseParticle = (p: Vector3, inputVelocity: Vector3) => {
		// Detener una simulación anterior antes de aceptar un lanzamiento nuevo.
		simRunningRef.current = false

		// La posición que recibe Rust es relativa al centro del agujero negro.
		const rx = p.x - BLACK_HOLE_POSITION.x
		const ry = p.y - BLACK_HOLE_POSITION.y
		const rz = p.z - BLACK_HOLE_POSITION.z
		const r0 = Math.hypot(rx, ry, rz)
		const theta = r0 > 1e-9 ? Math.acos(ry / r0) : 0
		const phi0 = Math.atan2(rz, rx)

		// Rust conserva la autoridad para aceptar o rechazar el radio inicial.
		clearTrail()
		appendTrailPoint(p.x, p.y, p.z)

		// Leer la velocidad de flick estimada en las tres coordenadas del mundo.
		const vx = inputVelocity.x
		const vy = inputVelocity.y
		const vz = inputVelocity.z

		// HUD y Rust usan exactamente la misma calibración y el mismo límite.
		const physicalVelocity = copyPhysicalVelocity(inputVelocity, new Vector3())
		const vhat_x = physicalVelocity.x
		const vhat_y = physicalVelocity.y
		const vhat_z = physicalVelocity.z
		// Descomposición para el HUD; Rust realiza la misma proyección internamente.
		const vhat_r = r0 > 1e-12 ? (vhat_x * rx + vhat_y * ry + vhat_z * rz) / r0 : 0
		const vhat_t = Math.sqrt(Math.max(0, vhat_x * vhat_x + vhat_y * vhat_y + vhat_z * vhat_z - vhat_r * vhat_r))
		const inputSpeed = Math.hypot(vx, vy, vz)
		const physicalSpeed = Math.hypot(vhat_x, vhat_y, vhat_z)
		const alpha0 = physicalSpeed > 1e-12
			? Math.acos(Math.max(-1, Math.min(1, vhat_r / physicalSpeed)))
			: 0
//Guardar |vhat| para visualizar validacion fisica en pantall
		setVhatMag(physicalSpeed)
	



//Guardar condiciones para el solver
		setInitialConditions({ r0, phi0, vhat_r, vhat_phi: vhat_t })
		//Envia condiciones iniciales al solver Rust/WASM
		let ok = false
		if (wasmReady) {
			ok = set_initial_3d(rx, ry, rz, vhat_x, vhat_y, vhat_z)
			console.log('set_initial_3d WASM ->', ok)

			//Activar avance continuo si Rust acepto las condiciones iniciales
			simRunningRef.current = ok
		}

		// Guardar una fotografía completa de los valores enviados a Rust.
		const debugData: SimulationDebug = {
			r0,
			position: [rx, ry, rz],
			inputVelocity: [vx, vy, vz],
			inputSpeed,
			physicalVelocity: [vhat_x, vhat_y, vhat_z],
			physicalSpeed,
			alpha0,
			currentR: r0,
			radialVelocity: ok ? get_radial_velocity() : 0,
			status: ok ? 'READY' : 'INVALID',
		}
		simulationDebugRef.current = debugData
		setSimulationDebug(debugData)

		//Probar un pequeno avance del solver
		//if (ok && particleRef.current) {
		//	const result = step(20000)
		//	const nextR = result[0]
		//	const nextPhi = result[1]
		//	const captured = result[2] === 1

		//	particleRef.current.position.x = nextR * Math.cos(nextPhi)
		//	particleRef.current.position.z = nextR * Math.sin(nextPhi)

		//	console.log('step WASM ->', { nextR, nextPhi, captured }) }
		//

//Debug (Incluyendo 3D)
		console.log('release ->', {
			x: p.x, y: p.y, z: p.z,
			rx, ry, rz, r0, phi0, theta,
			vhat_x, vhat_y, vhat_z, vhat_r, vhat_t,
			inputSpeed, physicalSpeed, alpha0,
		})

		return ok
	}

	const finishXRThrow = (hand: 'left' | 'right') => {
		if (
			xrThrowPhaseRef.current !== 'grabbed'
			|| xrGrabbedHandRef.current !== hand
			|| !particleRef.current
		) return

		// Congelar el último candidato estable: al soltar no se vuelve a medir ni promediar.
		const releasePosition = particleRef.current.getWorldPosition(new Vector3())
		const releaseVelocityWorld = xrLiveInputVelocityWorldRef.current.clone()
		const releasePhysicalVelocity = xrLivePhysicalVelocityRef.current.clone()
		const estimateSampleCount = xrEstimateSampleCountRef.current
		const sampleIndex = xrVelocitySampleIndexRef.current

		// La transición ocurre antes de llamar a Rust y bloquea una segunda liberación.
		xrThrowPhaseRef.current = 'released'
		xrGrabbedHandRef.current = null
		xrSentSampleCountRef.current = estimateSampleCount
		xrSentSampleIndexRef.current = sampleIndex
		xrSentPhysicalVelocityRef.current.copy(releasePhysicalVelocity)
		clearXRThrowSamples()

		console.log('XR release snapshot ->', {
			grabId: xrGrabIdRef.current,
			hand,
			estimateSampleCount,
			inputVelocityWorld: releaseVelocityWorld.toArray(),
			physicalVelocityWorld: releasePhysicalVelocity.toArray(),
		})

		releaseParticle(releasePosition, releaseVelocityWorld)
		// Confirmar en el HUD el mismo valor físico que quedó registrado para Rust.
		if (simulationDebugRef.current) {
			xrSentPhysicalVelocityRef.current.fromArray(simulationDebugRef.current.physicalVelocity)
		}
	}

	const XRThrowTracker = () => {
		const leftController = useXRInputSourceState('controller', 'left')
		const rightController = useXRInputSourceState('controller', 'right')
		const currentParticlePositionRef = useRef(new Vector3())
		const currentRelativePositionRef = useRef(new Vector3())
		const instantaneousLocalVelocityRef = useRef(new Vector3())
		const instantaneousWorldVelocityRef = useRef(new Vector3())

		// Única señal de liberación: funciona aunque el rayo ya no toque la esfera.
		useXRInputSourceEvent(leftController?.inputSource, 'selectend', () => finishXRThrow('left'), [leftController])
		useXRInputSourceEvent(rightController?.inputSource, 'selectend', () => finishXRThrow('right'), [rightController])

		useFrame(() => {
			if (
				xrThrowPhaseRef.current !== 'grabbed'
				|| xrGrabbedHandRef.current === null
				|| !particleRef.current
				|| !xrOriginRef.current
			) return

			const controller = xrGrabbedHandRef.current === 'left' ? leftController : rightController
			if (!controller?.object) return

			// La pelota conserva visualmente el offset remoto respecto al controlador.
			controller.object.updateWorldMatrix(true, false)
			const currentPositionWorld = currentParticlePositionRef.current.copy(xrGrabOffsetRef.current)
			controller.object.localToWorld(currentPositionWorld)
			particleRef.current.position.copy(currentPositionWorld)

			// Medir la trayectoria de la pelota en el espacio local del jugador elimina
			// la traslación y rotación artificial introducidas por la locomoción.
			xrOriginRef.current.updateWorldMatrix(true, false)
			const currentPositionLocal = currentRelativePositionRef.current.copy(currentPositionWorld)
			xrOriginRef.current.worldToLocal(currentPositionLocal)
			const now = performance.now() / 1000

			// LST conserva la muestra instantánea para diagnóstico, pero no se envía a Rust.
			if (xrHasPreviousPositionRef.current) {
				const deltaTime = now - xrPreviousSampleTimeRef.current
				if (deltaTime > 1e-4) {
					instantaneousLocalVelocityRef.current
						.subVectors(currentPositionLocal, xrPreviousRelativePositionRef.current)
						.multiplyScalar(1 / deltaTime)
					xrOriginRef.current.getWorldQuaternion(xrOriginQuaternionRef.current)
					instantaneousWorldVelocityRef.current
						.copy(instantaneousLocalVelocityRef.current)
						.applyQuaternion(xrOriginQuaternionRef.current)
					copyPhysicalVelocity(instantaneousWorldVelocityRef.current, xrLastPhysicalVelocityRef.current)
				}
			}

			xrPreviousParticlePositionRef.current.copy(currentPositionWorld)
			xrPreviousRelativePositionRef.current.copy(currentPositionLocal)
			xrPreviousSampleTimeRef.current = now
			xrHasPreviousPositionRef.current = true

			// Guardar posiciones con tiempo real; la regresión decidirá cuáles usar.
			const sampleIndex = xrVelocitySampleIndexRef.current
			const sample = xrPositionSamplesRef.current[sampleIndex]
			sample.time = now
			sample.position.copy(currentPositionLocal)
			xrVelocitySampleIndexRef.current = (sampleIndex + 1) % THROW_SAMPLE_CAPACITY
			xrVelocitySampleCountRef.current = Math.min(
				xrVelocitySampleCountRef.current + 1,
				THROW_SAMPLE_CAPACITY,
			)

			updateXRThrowEstimate(now)
		})

		return null
	}

	const XRDiagnosticsHud = () => {
		const { camera, gl } = useThree()
		const hudGroupRef = useRef<Group>(null)
		const cameraPositionRef = useRef(new Vector3())
		const cameraQuaternionRef = useRef(camera.quaternion.clone())

		// Desplazamiento moderado para mantener el HUD dentro del campo de visión.
		
		const hudOffsetRef = useRef(new Vector3(-0.10, 0.10, -0.65))
		const hudWorldOffsetRef = useRef(new Vector3())
		const updateAccumulatorRef = useRef(0)
		const [snapshot, setSnapshot] = useState({
			camera: [0, 0, 0] as [number, number, number],
			velocity: [0, 0, 0] as [number, number, number],
			last: [0, 0, 0] as [number, number, number],
			average: [0, 0, 0] as [number, number, number],
			sent: [0, 0, 0] as [number, number, number],
			sampleCount: 0,
			sampleIndex: 0,
		})

		useFrame((_, delta) => {
			if (!hudGroupRef.current) return
			// Este HUD es exclusivo de XR; el HUD desktop estático permanece intacto.
			hudGroupRef.current.visible = gl.xr.isPresenting
			if (!gl.xr.isPresenting) return

			// Seguir la posición y orientación de la cámara del visor.
			camera.getWorldPosition(cameraPositionRef.current)
			camera.getWorldQuaternion(cameraQuaternionRef.current)
			hudGroupRef.current.quaternion.copy(cameraQuaternionRef.current)
			hudGroupRef.current.position
				.copy(cameraPositionRef.current)
				.add(hudWorldOffsetRef.current.copy(hudOffsetRef.current).applyQuaternion(cameraQuaternionRef.current))

			// Actualizar a 20 Hz: suficiente para observar el candidato sin renderizar por frame.
			updateAccumulatorRef.current += delta
			if (updateAccumulatorRef.current < 0.05) return
			updateAccumulatorRef.current = 0

			const releasedVelocity = simulationDebugRef.current?.physicalVelocity ?? [0, 0, 0]
			const velocity = xrGrabbedHandRef.current
				? xrLivePhysicalVelocityRef.current.toArray() as [number, number, number]
				: releasedVelocity
			setSnapshot({
				camera: [
					cameraPositionRef.current.x,
					cameraPositionRef.current.y,
					cameraPositionRef.current.z,
				],
				velocity,
				last: xrLastPhysicalVelocityRef.current.toArray() as [number, number, number],
				average: xrLivePhysicalVelocityRef.current.toArray() as [number, number, number],
				sent: xrSentPhysicalVelocityRef.current.toArray() as [number, number, number],
				sampleCount: xrGrabbedHandRef.current
					? xrEstimateSampleCountRef.current
					: xrSentSampleCountRef.current,
				sampleIndex: xrGrabbedHandRef.current
					? xrVelocitySampleIndexRef.current
					: xrSentSampleIndexRef.current,
			})
		})

		return (
			<group ref={hudGroupRef} visible={false}>
				<mesh position={[0, 0, -0.01]}>
					<planeGeometry args={[0.72, 0.34]} />
					<meshBasicMaterial color="black" transparent opacity={0.60} />
				</mesh>
				<Text
					position={[-0.33, 0.155, 0]}
					anchorX="left"
					anchorY="top"
					fontSize={0.018}
					lineHeight={1.15}
					color="white"
				>
					{[
						`CAM ${snapshot.camera.map(value => value.toFixed(2)).join(' ')}`,
						`V0  ${snapshot.velocity.map(value => value.toFixed(3)).join(' ')}`,
						`LST ${snapshot.last.map(value => value.toFixed(3)).join(' ')}`,
						`AVG ${snapshot.average.map(value => value.toFixed(3)).join(' ')}`,
						`SND ${snapshot.sent.map(value => value.toFixed(3)).join(' ')}`,
						`N ${snapshot.sampleCount}  IDX ${snapshot.sampleIndex}`,
					].join('\n')}
				</Text>
			</group>
		)
	}

	

	const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
		e.stopPropagation()
		if (e.pointerType !== 'ray') return

		const pointerState = (e as unknown as { pointerState?: XRRayPointerState }).pointerState
		const handedness = pointerState?.inputSource?.handedness
		const controllerObject = pointerState?.object
		if (
			(handedness !== 'left' && handedness !== 'right')
			|| !controllerObject
			|| !particleRef.current
			|| !xrOriginRef.current
		) {
			console.warn('No se pudo iniciar el agarre XR', { handedness, controllerObject })
			return
		}

		// Comenzar un ciclo XR nuevo y descartar por completo las muestras anteriores.
		simRunningRef.current = false
		clearXRThrowSamples()
		xrThrowPhaseRef.current = 'grabbed'
		xrGrabIdRef.current += 1
		xrGrabbedHandRef.current = handedness
		xrLiveInputVelocityWorldRef.current.set(0, 0, 0)
		xrLivePhysicalVelocityRef.current.set(0, 0, 0)
		xrLastPhysicalVelocityRef.current.set(0, 0, 0)

		// Conservar la posición visual exacta de la pelota al iniciar el agarre remoto.
		controllerObject.updateWorldMatrix(true, false)
		particleRef.current.getWorldPosition(xrPreviousParticlePositionRef.current)
		xrGrabOffsetRef.current.copy(xrPreviousParticlePositionRef.current)
		controllerObject.worldToLocal(xrGrabOffsetRef.current)

		// Sembrar el historial con la posición inicial relativa al jugador.
		xrOriginRef.current.updateWorldMatrix(true, false)
		xrPreviousRelativePositionRef.current.copy(xrPreviousParticlePositionRef.current)
		xrOriginRef.current.worldToLocal(xrPreviousRelativePositionRef.current)
		const now = performance.now() / 1000
		xrPreviousSampleTimeRef.current = now
		xrHasPreviousPositionRef.current = true
		const initialSample = xrPositionSamplesRef.current[0]
		initialSample.time = now
		initialSample.position.copy(xrPreviousRelativePositionRef.current)
		xrVelocitySampleCountRef.current = 1
		xrVelocitySampleIndexRef.current = 1

		console.log('XR grab ->', {
			grabId: xrGrabIdRef.current,
			hand: handedness,
			pointerType: e.pointerType,
		})
	}

	const SimulationStepper = () => {
		const hudUpdateAccumulatorRef = useRef(0)

		useFrame((_, delta) => {
		//Avanzar solo si WASM esta listo y la simulacion esta activa
		if (!wasmReady || !simRunningRef.current || !particleRef.current) return

			const result = step(1000)
			const nextX = result[0]
			const nextY = result[1]
			const nextZ = result[2]
			const captured = result[3] === 1
			const captureReason = result[4]

		// Rust devuelve posición relativa; Three.js usa posición absoluta de escena.
		particleRef.current.position.set(
			BLACK_HOLE_POSITION.x + nextX,
			BLACK_HOLE_POSITION.y + nextY,
			BLACK_HOLE_POSITION.z + nextZ,
		)
		appendTrailPoint(
			BLACK_HOLE_POSITION.x + nextX,
			BLACK_HOLE_POSITION.y + nextY,
			BLACK_HOLE_POSITION.z + nextZ,
		)

		// Actualizar el HUD a 8 Hz para evitar renderizar React en cada frame XR.
		hudUpdateAccumulatorRef.current += delta
		if (hudUpdateAccumulatorRef.current >= 0.125 || captured) {
			const previousDebug = simulationDebugRef.current
			if (previousDebug) {
				const nextDebug: SimulationDebug = {
					...previousDebug,
					currentR: Math.hypot(nextX, nextY, nextZ),
					radialVelocity: get_radial_velocity(),
					status: captured ? `CAPTURED (${captureReason})` : 'RUNNING',
				}
				simulationDebugRef.current = nextDebug
				setSimulationDebug(nextDebug)
			}
			hudUpdateAccumulatorRef.current = 0
		}

		//Detiene el avanze si la particula fue capturada
		if (captured) {
			simRunningRef.current = false
		}
		})
		return null
	}

//Moverme con w, a, s, d
// Keysref guarda input sin re-render
// forward = mirdada de camara proyectada al plano xz
// right = perpendicular: forward x camera-up
// move acumula direccion y se normaliza y escala por speed*delta
// Se suma a camera.position para mover la camara


	const KeyboardMover = () => {
		const { camera, gl } = useThree()
	// Estado de teclas presionadas
	const keysRef = useRef({ w: false, a: false, s: false, d: false })

	//Vectores reutilizados para evitar crear objectos en cada frame
	const forwardRef = useRef(new Vector3())
	const rightRef = useRef(new Vector3())
	const moveRef = useRef(new Vector3())

	useEffect(() => {
		const setKey = (code: string, pressed: boolean) => {
		if (code === 'KeyW') keysRef.current.w = pressed
		if (code === 'KeyA') keysRef.current.a = pressed
		if (code === 'KeyS') keysRef.current.s = pressed
		if (code === 'KeyD') keysRef.current.d = pressed
		}

// Escuchar teclado global
	const onKeyDown = (e: KeyboardEvent) => setKey(e.code, true) 
	const onKeyUp = (e: KeyboardEvent) => setKey(e.code, false) 

	window.addEventListener('keydown', onKeyDown)
	window.addEventListener('keyup', onKeyUp)

	return () => {
	window.removeEventListener('keydown', onKeyDown)
	window.removeEventListener('keyup', onKeyUp)
	}
	}, [])

	useFrame((_, delta) => {
		const speed = 1.5
		const keys = keysRef.current

		const forward = forwardRef.current
		const right = rightRef.current
		const move = moveRef.current
	
	// Direccion hacia donde mira la camara, proyectada al plano horizontal
		camera.getWorldDirection(forward)
		forward.y = 0
		forward.normalize()
	
	  	right.crossVectors(forward, camera.up).normalize()
		
		//Reinicia el vector
		move.set(0, 0, 0)

	if (keys.w) move.add(forward)
	if (keys.s) move.sub(forward)
	if (keys.d) move.add(right)
	if (keys.a) move.sub(right)

	//Aplicar movimiento si hay alguna tecla presionada
	if (move.lengthSq() > 0) {
		move.normalize().multiplyScalar(speed * delta)
		// En desktop movemos la camera; en Vr movemos el origen XR
		const target = gl.xr.isPresenting && xrOriginRef.current ? xrOriginRef.current: camera
		target.position.add(move)

	}
	})

	return null
	}

	const formatVector = (vector: [number, number, number]) =>
		`${vector[0].toFixed(3)} ${vector[1].toFixed(3)} ${vector[2].toFixed(3)}`

	// Texto compartido por el HUD desktop y el HUD visible dentro del visor.
	const hudText = simulationDebug
		? [
			'IC',
			`r0: ${simulationDebug.r0.toFixed(3)}`,
			`p0 xyz: ${formatVector(simulationDebug.position)}`,
			`vin xyz: ${formatVector(simulationDebug.inputVelocity)}`,
			`|vin|: ${simulationDebug.inputSpeed.toFixed(3)}`,
			`vhat xyz: ${formatVector(simulationDebug.physicalVelocity)}`,
			`|vhat|: ${simulationDebug.physicalSpeed.toFixed(3)}`,
			`alpha0: ${simulationDebug.alpha0.toFixed(3)}`,
			'NOW',
			`r: ${simulationDebug.currentR.toFixed(3)}`,
			`rdot: ${simulationDebug.radialVelocity.toFixed(3)}`,
			`status: ${simulationDebug.status}`,
			'version: 0.26',
		].join('\n')
		: initialConditions
			? `IC\nr0: ${initialConditions.r0.toFixed(3)}\n|vhat|: ${(vhatMag ?? 0).toFixed(3)}\nversion: 0.26`
			: 'Sin condiciones iniciales\nversion: 0.26'


return (

    <div className="App">

      {/* Boton para entrar al modo VR en navegadores compatibles */}
<button
	className="xr-button"
	onClick={() => xrStore.enterVR().catch((e) => console.error('enterVR failed', e))}
>
	Enter VR test
	</button>

	{/* HUD minimo: posicion inicial y modulo de la velocidad */}
	<div 
		style={{
			position: 'fixed',
			top: 156,
			left: 16,
			zIndex: 20,
			color: '#fff',
			background: 'rgba(0,0,0,0.55)',
			padding: '8px 10px',
			borderRadius: 8,
			fontFamily: 'monospace',
			fontSize: 12,
			lineHeight: 1.4,
		}}
	>
	<div style={{ whiteSpace: 'pre-line' }}>{hudText}</div>
	<div>wasm: {wasmReady ? 'ready' : 'loading'}</div>
	</div>


      {/* Lienzo principal de la escena 3D */}
      <Canvas camera={{ position: [-0.3, 1.6, 2.7], rotation: [0, 0, 0], fov: 60 }}>
       
      {/* Contexto XR: todo lo que este dentro puede renderizarse en VR */}
        <XR store={xrStore}>
	{/* Origen del jugador: se mueve en VR en lugar de mover la camara */}
	
	<XROrigin ref={xrOriginRef} />
	<XRLocomotion />
	<XRThrowTracker />
	<XRDiagnosticsHud />

	{/* Para hacer reset con el boton a del metaquest */}

	<XRResetButton onReset={resetParticle} />

	<SimulationStepper />
	<OrbitTrail />
	
	<KeyboardMover />

		<color attach="background" args={['#0b1020']} />

	{/* Luces basicas para poder ver materiales y volumen */}
          <ambientLight intensity={0.4} />
          <directionalLight position={[5, 5, 5]} intensity={1} />

          {/* Agujero negro (marcador visual) */}
          <mesh position={[0, 1.4, 0]}>
            <sphereGeometry args={[0.41, 32, 32]} />
            <meshStandardMaterial color="#111" />
          </mesh>

	{/* Particula Naranja */}

<mesh
	ref={particleRef}
	position={[1.4, 1.4, -0.5]}
	onPointerDown={handlePointerDown}>

	<sphereGeometry args={[0.1,16,16]} />
	<meshStandardMaterial color="orange" />
	</mesh>


          {/* Controladores y manos de XR para interaccion futura */}
        
{/* HUD 3D visible dentro del VR */}
	<group position= {[-1.2, 1.4, -1.3]}>
	{/* Fondo del HUD */}
	<mesh>
	<planeGeometry args={[1.55, 1.10]} />
	<meshBasicMaterial color="black" transparent opacity={0.55} />
	</mesh>

{/* Texto del HUD */}
	<Text
		position={[-0.70, 0.48, 0.01]}
		anchorX="left"
		anchorY="top"
		fontSize={0.032}
		maxWidth={1.40}
		color="white"
		>
		{hudText}
			</Text>
			</group>


	  </XR>
      </Canvas>
    </div>
) 
}

export default App
