// System module — architecture and health reporting
export function createSystemModule() {
  return {
    name: 'system',
    status: () => ({ healthy: true })
  }
}
