import './App.css'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {  XR, createXRStore, XROrigin, useXRInputSourceState } from '@react-three/xr'
import { useRef, useState, useEffect } from 'react'
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Line as ThreeLine, LineBasicMaterial, Mesh, Vector3 } from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import initWasm, { set_params, set_initial, set_initial_3d, step } from './wasm-core/wasm_core'
const xrStore = createXRStore()
const BLACK_HOLE_POSITION = { x: 0, y: 1.4, z: 0 }
const TRAIL_MAX_POINTS = 10_000

type InitialConditions = {
	r0: number
	phi0: number
	vhat_r: number
	vhat_phi: number
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
	
		// RS: rotacion izquierdaderecha
		const rightStick = 
			rightController?.gamepad['xr-standard-thumbstick']

		if (rightStick) {
			let x = rightStick.xAxis ?? 0
			const DEADZONE = 0.15
			if (Math.abs(x) < DEADZONE) x = 0
			const ROTATION_SPEED = 2.2
		xrOriginRef.current.rotation.y -=
			x * ROTATION_SPEED * delta
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

	const draggingRef = useRef(false)

	//Indica si la simulacion debe avanza en cada frame
	const simRunningRef = useRef(false)

//Movi ciertas constantes debajo de esto, referentes al modulo wasm

// Indica si el modulo WASM ya fue cargado
	const [wasmReady, setWasmReady] = useState(false)

	const [initialConditions, setInitialConditions] = useState<InitialConditions | null>(null)
//Modulo de velocidad local para mostrar en el HUD
	const [vhatMag, setVhatMag] = useState<number | null>(null)



//Ultima muestra de posicion/tiempo para derivar velocidad
	const lastSampleRef = useRef<{ x: number; y: number; z: number; t: number } | null>(null)

//Velocidad instantanea 3D al soltar.
	const releaseVelocityRef = useRef<{ vx: number; vy: number; vz: number }>({ vx: 0, vy: 0, vz: 0})

useEffect(() => {

	
	const onPointerMove = (_e: PointerEvent) => {
		//Medir si estamos arrastrando y existe la pelota
		if (!draggingRef.current || !particleRef.current) return
	const now = performance.now()
	const position = particleRef.current.getWorldPosition(new Vector3())
	
	const prev = lastSampleRef.current
	if (prev) {
		// dt en segundos para calcular la velocidad de flick en 3D.
		const dt = (now - prev.t) / 1000
		if (dt > 1e-4) {
			releaseVelocityRef.current = {
				vx: (position.x - prev.x) / dt,
				vy: (position.y - prev.y) / dt,
				vz: (position.z - prev.z) / dt,
			}
		}
	}
//Guardar muestra actual para la siguiente derivada
	lastSampleRef.current = { x: position.x, y: position.y, z: position.z, t: now }
	}

//Listener globar para capturar movimiento continuo
	window.addEventListener('pointermove', onPointerMove)
	return () => window.removeEventListener('pointermove', onPointerMove)
}, [])

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
		if (e.code === 'KeyE') {
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

		//Reiniciar velocidad media por el flick (tal vez sea necesario editar luego)
		releaseVelocityRef.current = { vx: 0, vy: 0, vz: 0}
		lastSampleRef.current = null

		//Mover la pelota a la posicion inicial
		if (particleRef.current) {
			particleRef.current.position.set(1.4, 1.4, -1)
		}
		clearTrail()
		appendTrailPoint(1.4, 1.4, -1)
		//Limpiar datos de HUD

		setInitialConditions(null)
		setVhatMag(null)

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


	const handleParticleRelease = () => {
//Si no hay referencia a la pelota, no se hace nada	
		if (!particleRef.current) return
		const p = new Vector3()
		particleRef.current.getWorldPosition(p)

		// La posición que recibe Rust es relativa al centro del agujero negro.
		const rx = p.x - BLACK_HOLE_POSITION.x
		const ry = p.y - BLACK_HOLE_POSITION.y
		const rz = p.z - BLACK_HOLE_POSITION.z
		const r0 = Math.hypot(rx, ry, rz)
		const theta = r0 > 1e-9 ? Math.acos(ry / r0) : 0
		const phi0 = Math.atan2(rz, rx)

//Evitar caso degenerado cerca del origen

		if (r0 <= MIN_R0) {
			console.warn('Invalido: Particula muy cerca al origen', { r0 })
			return
		}
		clearTrail()
		appendTrailPoint(p.x, p.y, p.z)

		// Leer la velocidad de flick estimada en las tres coordenadas del mundo.
		const vx = releaseVelocityRef.current.vx
		const vy = releaseVelocityRef.current.vy
		const vz = releaseVelocityRef.current.vz

//Escala de calibracion: convierte input del control a velocidad fisica local
	const S = 0.2
	let vhat_x = S * vx
	let vhat_y = S * vy
	let vhat_z = S * vz

//Clamp relativista: mantener |vhat| < (unidades naturales c=1)
	const VMAX = 0.99
	const vhat2 = vhat_x * vhat_x + vhat_y * vhat_y + vhat_z * vhat_z
	if (vhat2 > VMAX * VMAX) {
		const k = VMAX/ Math.sqrt(vhat2)
		vhat_x *= k
		vhat_y *= k
		vhat_z *= k
	}
		// Descomposición para el HUD; Rust realiza la misma proyección internamente.
		const vhat_r = (vhat_x * rx + vhat_y * ry + vhat_z * rz) / r0
		const vhat_t = Math.sqrt(Math.max(0, vhat_x * vhat_x + vhat_y * vhat_y + vhat_z * vhat_z - vhat_r * vhat_r))
//Guardar |vhat| para visualizar validacion fisica en pantall
		setVhatMag(Math.hypot(vhat_x, vhat_y, vhat_z))
	



//Guardar condiciones para el solver
		setInitialConditions({ r0, phi0, vhat_r, vhat_phi: vhat_t })
		//Envia condiciones iniciales al solver Rust/WASM
		if (wasmReady) {
			const ok = set_initial_3d(rx, ry, rz, vhat_x, vhat_y, vhat_z)
			console.log('set_initial_3d WASM ->', ok)
		
		//Activar avance continuo si Rust acepto las condiciones iniciales
		simRunningRef.current = ok

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
			vhat: Math.hypot(vhat_x, vhat_y, vhat_z),
		})
	}
	}

	

	const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
		e.stopPropagation()
		draggingRef.current = true
		const pointerTarget = e.target as EventTarget & { setPointerCapture?: (pointerId: number) => void }
		pointerTarget.setPointerCapture?.(e.pointerId)
		
	// Reiniciar muestreo al comenzar arrastre
	const position = particleRef.current?.getWorldPosition(new Vector3()) ?? new Vector3()
	lastSampleRef.current = {
		x: position.x,
		y: position.y,
		z: position.z,
		t: performance.now(),
	}
	releaseVelocityRef.current = { vx: 0, vy: 0, vz: 0 }
	}

	const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
		if (!draggingRef.current || !particleRef.current) return
			particleRef.current.position.x = e.point.x
			particleRef.current.position.z = e.point.z
			particleRef.current.position.y = e.point.y 
	}

	const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
		e.stopPropagation()
		draggingRef.current = false
		const pointerTarget = e.target as EventTarget & { releasePointerCapture?: (pointerId: number) => void }
		pointerTarget.releasePointerCapture?.(e.pointerId)
		handleParticleRelease()

	//Mostrar velocidad de flick estimada al soltar
	console.log('flick velocity 3D ->', releaseVelocityRef.current)
	lastSampleRef.current = null

	}

	const SimulationStepper = () => {
		useFrame(() => {
		//Avanzar solo si WASM esta listo y la simulacion esta activa
		if (!wasmReady || !simRunningRef.current || !particleRef.current) return

			const result = step(1000)
			const nextX = result[0]
			const nextY = result[1]
			const nextZ = result[2]
			const captured = result[3] === 1

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
	{initialConditions ? (
		<>
		<div>r0: {initialConditions.r0.toFixed(3)}</div>
		<div>phi0: {initialConditions.phi0.toFixed(3)}</div>
		<div>|vhat|: {vhatMag !== null ? vhatMag.toFixed(3) : '0.000'}</div>
		<div>wasm: {wasmReady ? 'ready' : 'loading'}</div>
		</>

	) : (
	<div>Sin condiciones iniciales </div>
	)}
	</div>


      {/* Lienzo principal de la escena 3D */}
      <Canvas camera={{ position: [-0.3, 1.6, 2.7], rotation: [0, 0, 0], fov: 60 }}>
       
      {/* Contexto XR: todo lo que este dentro puede renderizarse en VR */}
        <XR store={xrStore}>
	{/* Origen del jugador: se mueve en VR en lugar de mover la camara */}
	
	<XROrigin ref={xrOriginRef} />
	<XRLocomotion />

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
	onPointerDown={handlePointerDown}
	onPointerMove={handlePointerMove}
	onPointerUp={handlePointerUp}>

	<sphereGeometry args={[0.1,16,16]} />
	<meshStandardMaterial color="orange" />
	</mesh>


          {/* Controladores y manos de XR para interaccion futura */}
        
{/* HUD 3D visible dentro del VR */}
	<group position= {[-1.2, 1.4, -1.3]}>
	{/* Fondo del HUD */}
	<mesh>
	<planeGeometry args={[0.90, 0.50]} />
	<meshBasicMaterial color="black" transparent opacity={0.55} />
	</mesh>

{/* Texto del HUD */}
	<Text
		position={[-0.30, 0, 0.01]}
		anchorX="left"
		anchorY="middle"
		fontSize={0.045}
		color="white"
		>
		{initialConditions
			? `r0: ${initialConditions.r0.toFixed(3)}\nphi0 :${initialConditions.phi0.toFixed(3)}\n|v|: ${(vhatMag ?? 0).toFixed(3)}\n version: 0.15 `
			: 'Sin condiciones \niniciales'}
			</Text>
			</group>


	  </XR>
      </Canvas>
    </div>
) 
}

export default App
