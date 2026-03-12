import Home from './pages/Home'
import StatusBar from './components/status-bar/StatusBar'

/**
 * The main application component.
 * Renders the Home page with a persistent status bar.
 */
export default function App() {
  return (
    <>
      <Home />
      <StatusBar />
    </>
  )
}
