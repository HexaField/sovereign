import { describe, it, expect, beforeEach } from 'vitest'
import {
  zoom,
  setZoom,
  panX,
  setPanX,
  panY,
  setPanY,
  selectedNode,
  setSelectedNode,
  drillDownTarget,
  setDrillDownTarget,
  eventSidebarOpen,
  setEventSidebarOpen,
  toggleEventSidebar,
  eventFilterWorkspace,
  setEventFilterWorkspace,
  eventFilterType,
  setEventFilterType,
  resetCanvasView,
  zoomToNode,
  zoomOut,
  applyZoomDelta,
  applyPanDelta,
  MIN_ZOOM,
  MAX_ZOOM
} from './store'

beforeEach(() => {
  resetCanvasView()
  setEventSidebarOpen(false)
  setEventFilterWorkspace(null)
  setEventFilterType(null)
})

describe('Canvas Store', () => {
  describe('§4.1 — Canvas State', () => {
    it('§4.1 — exposes zoom signal with default value 1', () => {
      expect(zoom()).toBe(1)
    })

    it('§4.1 — exposes panX and panY signals with default 0', () => {
      expect(panX()).toBe(0)
      expect(panY()).toBe(0)
    })

    it('§4.4 — exposes selectedNode signal', () => {
      expect(selectedNode()).toBeNull()
      setSelectedNode('org-1')
      expect(selectedNode()).toBe('org-1')
    })
  })

  describe('zoom operations', () => {
    it('setZoom updates the zoom level', () => {
      setZoom(2)
      expect(zoom()).toBe(2)
    })

    it('applyZoomDelta adds delta to current zoom', () => {
      applyZoomDelta(0.5)
      expect(zoom()).toBeCloseTo(1.5)
    })

    it('applyZoomDelta clamps to MIN_ZOOM', () => {
      applyZoomDelta(-100)
      expect(zoom()).toBe(MIN_ZOOM)
    })

    it('applyZoomDelta clamps to MAX_ZOOM', () => {
      applyZoomDelta(100)
      expect(zoom()).toBe(MAX_ZOOM)
    })
  })

  describe('pan operations', () => {
    it('setPanX and setPanY update pan position', () => {
      setPanX(100)
      setPanY(-50)
      expect(panX()).toBe(100)
      expect(panY()).toBe(-50)
    })

    it('applyPanDelta adds delta to current pan', () => {
      applyPanDelta(10, 20)
      expect(panX()).toBe(10)
      expect(panY()).toBe(20)
      applyPanDelta(-5, 15)
      expect(panX()).toBe(5)
      expect(panY()).toBe(35)
    })
  })

  describe('drill-down', () => {
    it('drillDownTarget defaults to null', () => {
      expect(drillDownTarget()).toBeNull()
    })

    it('zoomToNode sets selectedNode, drillDownTarget, and zoom', () => {
      zoomToNode('org-1')
      expect(selectedNode()).toBe('org-1')
      expect(drillDownTarget()).toBe('org-1')
      expect(zoom()).toBe(2.5)
    })

    it('zoomOut resets all view state', () => {
      zoomToNode('org-1')
      setPanX(100)
      setPanY(200)
      zoomOut()
      expect(selectedNode()).toBeNull()
      expect(drillDownTarget()).toBeNull()
      expect(zoom()).toBe(1)
      expect(panX()).toBe(0)
      expect(panY()).toBe(0)
    })
  })

  describe('event sidebar', () => {
    it('eventSidebarOpen defaults to false', () => {
      expect(eventSidebarOpen()).toBe(false)
    })

    it('toggleEventSidebar toggles the sidebar', () => {
      toggleEventSidebar()
      expect(eventSidebarOpen()).toBe(true)
      toggleEventSidebar()
      expect(eventSidebarOpen()).toBe(false)
    })

    it('event filters default to null', () => {
      expect(eventFilterWorkspace()).toBeNull()
      expect(eventFilterType()).toBeNull()
    })

    it('setEventFilterWorkspace sets workspace filter', () => {
      setEventFilterWorkspace('org-1')
      expect(eventFilterWorkspace()).toBe('org-1')
    })

    it('setEventFilterType sets type filter', () => {
      setEventFilterType('issue')
      expect(eventFilterType()).toBe('issue')
    })
  })

  describe('resetCanvasView', () => {
    it('resets all canvas state to defaults', () => {
      setZoom(3)
      setPanX(100)
      setPanY(200)
      setSelectedNode('x')
      setDrillDownTarget('y')
      resetCanvasView()
      expect(zoom()).toBe(1)
      expect(panX()).toBe(0)
      expect(panY()).toBe(0)
      expect(selectedNode()).toBeNull()
      expect(drillDownTarget()).toBeNull()
    })
  })
})
