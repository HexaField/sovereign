// ── ForestCanvas — Three.js 3D scene for the knowledge forest ──────
// Renders nodes as InstancedMesh spheres, links as LineSegments,
// optional cloud as Points. Handles transitions, raycasting, resize.
// SolidJS component — uses onMount/onCleanup/createEffect, not hooks.

import { onMount, onCleanup, createEffect } from 'solid-js'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ForestNode, ForestLink, ForestSettings, Vec3 } from './types.js'
import { applyEasing } from './easing.js'
import { colorForType, colorForPredicate, colorForAge } from './colors.js'

interface ForestCanvasProps {
  nodes: ForestNode[]
  links: ForestLink[]
  positions: Map<string, Vec3>
  settings: ForestSettings
  selectedIri: string | null
  hoveredIri: string | null
  onSelect: (iri: string | null) => void
  onHover: (iri: string | null) => void
}

// ── Transition state ───────────────────────────────────────────────

interface TransitionState {
  prev: Map<string, Vec3>
  target: Map<string, Vec3>
  startTime: number
  duration: number
  easing: ForestSettings['transition']['easing']
  active: boolean
}

// ── Helpers ────────────────────────────────────────────────────────

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  }
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

// ── Component ──────────────────────────────────────────────────────

export default function ForestCanvas(props: ForestCanvasProps) {
  let containerRef: HTMLDivElement | undefined
  let renderer: THREE.WebGLRenderer | undefined
  let scene: THREE.Scene | undefined
  let camera: THREE.PerspectiveCamera | undefined
  let controls: OrbitControls | undefined
  let animFrameId: number | undefined
  let resizeObserver: ResizeObserver | undefined

  // Scene objects
  let graphGroup: THREE.Group
  let cloudGroup: THREE.Group
  let nodeMesh: THREE.InstancedMesh | undefined
  let linkLines: THREE.LineSegments | undefined
  let cloudPoints: THREE.Points | undefined
  let raycaster: THREE.Raycaster
  let mouse = new THREE.Vector2()

  // Node index: instanceId → node IRI
  let nodeIndex: string[] = []

  // Transition
  const transition: TransitionState = {
    prev: new Map(),
    target: new Map(),
    startTime: 0,
    duration: 500,
    easing: 'easeInOut',
    active: false
  }

  // Current interpolated positions (used during render)
  let currentPositions: Map<string, Vec3> = new Map()

  onMount(() => {
    if (!containerRef) return

    // ── Renderer ──────────────────────────────────────────
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      console.error('[forest] WebGL not available')
      return
    }

    const w = containerRef.clientWidth || 800
    const h = containerRef.clientHeight || 600
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    containerRef.appendChild(renderer.domElement)

    // ── Scene ─────────────────────────────────────────────
    scene = new THREE.Scene()
    // No scene.background — renderer alpha:true lets the CSS-themed
    // container background show through. Works with every theme
    // (hex, rgba, glass) without colour-format parsing.

    // ── Camera ────────────────────────────────────────────
    camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500)
    camera.position.set(0, 5, 25)
    camera.lookAt(0, 0, 0)

    // ── Controls ──────────────────────────────────────────
    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 2
    controls.maxDistance = 100

    // ── Lighting ──────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0xffffff, 0.5)
    scene.add(ambient)
    const directional = new THREE.DirectionalLight(0xffffff, 0.8)
    directional.position.set(5, 10, 7)
    scene.add(directional)

    // ── Groups ────────────────────────────────────────────
    graphGroup = new THREE.Group()
    cloudGroup = new THREE.Group()
    scene.add(graphGroup)
    scene.add(cloudGroup)

    // ── Raycaster ─────────────────────────────────────────
    raycaster = new THREE.Raycaster()
    raycaster.params.Points = { threshold: 0.5 }

    // ── Interaction ───────────────────────────────────────
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('click', onClick)

    // ── Resize ────────────────────────────────────────────
    resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef)

    // ── Initial build ─────────────────────────────────────
    buildNodes()
    buildLinks()
    buildCloud()

    // ── Render loop ───────────────────────────────────────
    animate()
  })

  onCleanup(() => {
    if (animFrameId != null) cancelAnimationFrame(animFrameId)
    if (resizeObserver) resizeObserver.disconnect()
    if (renderer) {
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('click', onClick)
      renderer.dispose()
      renderer.domElement.remove()
    }
    if (controls) controls.dispose()
    disposeGroup(graphGroup)
    disposeGroup(cloudGroup)
  })

  // ── Reactive effects ──────────────────────────────────────────────

  // Rebuild node mesh when nodes change
  createEffect(() => {
    void props.nodes
    void props.settings.node
    buildNodes()
  })

  // Start transition when positions change
  createEffect(() => {
    const target = props.positions
    const settings = props.settings.transition

    // Save current as prev, set new target
    transition.prev = new Map(currentPositions)
    transition.target = target
    transition.startTime = performance.now()
    transition.duration = settings.duration
    transition.easing = settings.easing
    transition.active = true
  })

  // Rebuild links when links or settings change
  createEffect(() => {
    void props.links
    void props.settings.link
    buildLinks()
  })

  // Rebuild cloud when nodes change
  createEffect(() => {
    void props.nodes
    void props.settings.styles.cloud
    buildCloud()
  })

  // Toggle group visibility
  createEffect(() => {
    if (graphGroup) graphGroup.visible = props.settings.styles.graph
    if (cloudGroup) cloudGroup.visible = props.settings.styles.cloud
  })

  // Update selection/hover highlighting
  createEffect(() => {
    void props.selectedIri
    void props.hoveredIri
    updateHighlighting()
  })

  // Background handled by CSS (alpha:true renderer) — no scene.background needed.

  // ── Build functions ───────────────────────────────────────────────

  function buildNodes() {
    if (!graphGroup) return

    // Remove old mesh
    if (nodeMesh) {
      graphGroup.remove(nodeMesh)
      nodeMesh.geometry.dispose()
      ;(nodeMesh.material as THREE.Material).dispose()
      nodeMesh = undefined
    }

    const nodes = props.nodes
    if (nodes.length === 0) return

    const geo = new THREE.SphereGeometry(1, 16, 12)
    const mat = new THREE.MeshStandardMaterial({
      transparent: true,
      opacity: props.settings.node.opacity,
      metalness: 0.1,
      roughness: 0.6
    })

    nodeMesh = new THREE.InstancedMesh(geo, mat, nodes.length)
    nodeIndex = []

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()
    const timestamps = nodes.map((n) => n.timestamp)
    const minTs = Math.min(...timestamps.filter((t) => t > 0)) || 0
    const maxTs = Math.max(...timestamps) || 1

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const pos = currentPositions.get(n.iri) ?? props.positions.get(n.iri) ?? ZERO
      const size = props.settings.node.size

      dummy.position.set(pos.x, pos.y, pos.z)
      dummy.scale.setScalar(size)
      dummy.updateMatrix()
      nodeMesh.setMatrixAt(i, dummy.matrix)

      // Color mapping
      const mapping = props.settings.node.colorMapping
      let c: number
      if (mapping === 'byAge') {
        c = colorForAge(n.timestamp, minTs, maxTs)
      } else {
        c = colorForType(n.entityType)
      }
      color.setHex(c)
      nodeMesh.setColorAt(i, color)

      nodeIndex.push(n.iri)
    }

    nodeMesh.instanceMatrix.needsUpdate = true
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true
    graphGroup.add(nodeMesh)
  }

  function buildLinks() {
    if (!graphGroup) return

    // Remove old lines
    if (linkLines) {
      graphGroup.remove(linkLines)
      linkLines.geometry.dispose()
      ;(linkLines.material as THREE.Material).dispose()
      linkLines = undefined
    }

    const links = props.links
    const visibility = props.settings.link.visibility
    if (visibility === 'none' || links.length === 0) return

    // Filter links based on visibility mode
    let visibleLinks = links
    if (visibility === 'selected-neighborhood') {
      const focus = props.selectedIri || props.hoveredIri
      if (focus) {
        visibleLinks = links.filter((l) => l.source === focus || l.target === focus)
      } else {
        visibleLinks = []
      }
    } else if (visibility === 'hover') {
      const focus = props.hoveredIri
      if (focus) {
        visibleLinks = links.filter((l) => l.source === focus || l.target === focus)
      } else {
        visibleLinks = []
      }
    }

    if (visibleLinks.length === 0) return

    const positions: number[] = []
    const colors: number[] = []
    const color = new THREE.Color()
    const mapping = props.settings.link.colorMapping

    for (const link of visibleLinks) {
      const src = currentPositions.get(link.source) ?? props.positions.get(link.source)
      const tgt = currentPositions.get(link.target) ?? props.positions.get(link.target)
      if (!src || !tgt) continue

      positions.push(src.x, src.y, src.z, tgt.x, tgt.y, tgt.z)

      if (mapping === 'byPredicate') {
        color.setHex(colorForPredicate(link.predicate))
      } else {
        color.setHex(0x607d8b)
      }
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: props.settings.link.opacity,
      linewidth: props.settings.link.width
    })

    linkLines = new THREE.LineSegments(geo, mat)
    graphGroup.add(linkLines)
  }

  function buildCloud() {
    if (!cloudGroup) return

    // Remove old points
    if (cloudPoints) {
      cloudGroup.remove(cloudPoints)
      cloudPoints.geometry.dispose()
      ;(cloudPoints.material as THREE.Material).dispose()
      cloudPoints = undefined
    }

    if (!props.settings.styles.cloud || props.nodes.length === 0) return

    const positions: number[] = []
    const colors: number[] = []
    const color = new THREE.Color()

    for (const n of props.nodes) {
      const pos = currentPositions.get(n.iri) ?? props.positions.get(n.iri) ?? ZERO
      positions.push(pos.x, pos.y, pos.z)
      color.setHex(colorForType(n.entityType))
      colors.push(color.r, color.g, color.b)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))

    const mat = new THREE.PointsMaterial({
      size: props.settings.node.size * 3,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true
    })

    cloudPoints = new THREE.Points(geo, mat)
    cloudGroup.add(cloudPoints)
  }

  function updateHighlighting() {
    if (!nodeMesh || nodeIndex.length === 0) return

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()
    const sel = props.selectedIri
    const hov = props.hoveredIri
    const baseSize = props.settings.node.size

    for (let i = 0; i < nodeIndex.length; i++) {
      const iri = nodeIndex[i]
      const pos = currentPositions.get(iri) ?? ZERO
      const selected = iri === sel
      const hovered = iri === hov

      const scale = selected ? baseSize * 1.5 : hovered ? baseSize * 1.2 : baseSize
      dummy.position.set(pos.x, pos.y, pos.z)
      dummy.scale.setScalar(scale)
      dummy.updateMatrix()
      nodeMesh.setMatrixAt(i, dummy.matrix)

      if (selected) {
        color.setHex(0xffd700) // gold accent for selected
      } else {
        color.setHex(colorForType(props.nodes[i]?.entityType ?? ''))
      }
      nodeMesh.setColorAt(i, color)
    }

    nodeMesh.instanceMatrix.needsUpdate = true
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true
  }

  // ── Update positions during transitions ──────────────────────────

  function updateTransition() {
    if (!transition.active) return

    const elapsed = performance.now() - transition.startTime
    const raw = Math.min(elapsed / transition.duration, 1)
    const t = applyEasing(raw, transition.easing)

    let changed = false
    for (const [iri, target] of transition.target) {
      const prev = transition.prev.get(iri) ?? target
      const interp = lerpVec3(prev, target, t)
      currentPositions.set(iri, interp)
      changed = true
    }

    if (raw >= 1) {
      transition.active = false
      // Snap to exact target
      for (const [iri, target] of transition.target) {
        currentPositions.set(iri, target)
      }
    }

    if (changed) {
      updateInstancePositions()
      updateLinkPositions()
      updateCloudPositions()
    }
  }

  function updateInstancePositions() {
    if (!nodeMesh || nodeIndex.length === 0) return

    const dummy = new THREE.Object3D()
    const size = props.settings.node.size

    for (let i = 0; i < nodeIndex.length; i++) {
      const iri = nodeIndex[i]
      const pos = currentPositions.get(iri) ?? ZERO
      const sel = iri === props.selectedIri
      const hov = iri === props.hoveredIri
      const scale = sel ? size * 1.5 : hov ? size * 1.2 : size

      dummy.position.set(pos.x, pos.y, pos.z)
      dummy.scale.setScalar(scale)
      dummy.updateMatrix()
      nodeMesh.setMatrixAt(i, dummy.matrix)
    }
    nodeMesh.instanceMatrix.needsUpdate = true
  }

  function updateLinkPositions() {
    // Rebuild links when positions change (geometry attributes are not easily updated in-place for line segments)
    buildLinks()
  }

  function updateCloudPositions() {
    if (!cloudPoints || props.nodes.length === 0) return

    const posAttr = cloudPoints.geometry.getAttribute('position') as THREE.BufferAttribute
    if (!posAttr) return

    for (let i = 0; i < props.nodes.length; i++) {
      const pos = currentPositions.get(props.nodes[i].iri) ?? ZERO
      posAttr.setXYZ(i, pos.x, pos.y, pos.z)
    }
    posAttr.needsUpdate = true
  }

  // ── Interaction handlers ──────────────────────────────────────────

  function onPointerMove(event: PointerEvent) {
    if (!renderer || !camera || !nodeMesh) return
    const rect = renderer.domElement.getBoundingClientRect()
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1

    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObject(nodeMesh)
    if (hits.length > 0 && hits[0].instanceId != null) {
      const iri = nodeIndex[hits[0].instanceId]
      if (iri) {
        props.onHover(iri)
        renderer.domElement.style.cursor = 'pointer'
        return
      }
    }
    props.onHover(null)
    renderer.domElement.style.cursor = ''
  }

  function onClick() {
    if (!renderer || !camera || !nodeMesh) return
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObject(nodeMesh)
    if (hits.length > 0 && hits[0].instanceId != null) {
      const iri = nodeIndex[hits[0].instanceId]
      if (iri) {
        props.onSelect(props.selectedIri === iri ? null : iri)
        return
      }
    }
    props.onSelect(null)
  }

  function onResize() {
    if (!containerRef || !renderer || !camera) return
    const w = containerRef.clientWidth
    const h = containerRef.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  // ── Render loop ───────────────────────────────────────────────────

  function animate() {
    animFrameId = requestAnimationFrame(animate)
    updateTransition()
    controls?.update()
    if (renderer && scene && camera) {
      renderer.render(scene, camera)
    }
  }

  // ── Dispose helper ────────────────────────────────────────────────

  function disposeGroup(group: THREE.Group | undefined) {
    if (!group) return
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Points) {
        obj.geometry?.dispose()
        const mat = obj.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      }
    })
  }

  return <div ref={(el) => (containerRef = el)} class="h-full w-full" />
}
