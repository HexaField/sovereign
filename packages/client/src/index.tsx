import { render } from 'solid-js/web'
import { registerServiceWorker } from './lib/push.js'
import { registerFileChipHandlers } from './lib/file-chip-handlers.js'
import App from './App'
import './app.css'

render(() => <App />, document.getElementById('root') as HTMLElement)

// Register the Service Worker for Web Push. Silent — does NOT prompt the
// user for notification permission; that's gated behind the explicit
// "Enable browser notifications" button in Settings.
void registerServiceWorker()

// Handle navigation requests from the SW (notificationclick → focus tab).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'sovereign:navigate' && typeof msg.threadId === 'string') {
      window.location.hash = `thread=${msg.threadId}`
    }
  })
}

registerFileChipHandlers()
