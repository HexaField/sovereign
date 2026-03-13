import { createWsStore, type WsStore } from './ws-store.js'

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const url = `${protocol}//${window.location.host}/ws`

export const wsStore: WsStore = createWsStore({ url, WebSocket: WebSocket as any })
