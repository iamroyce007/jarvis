import { createRoot } from 'react-dom/client'
import { installBridge } from './transport'
import App from './App'
import '../design.css'
import './mobile.css'
import './storyboard.mobile.css'

// The bridge must exist before any component renders: every one of them
// reaches for `window.jarvis` on mount, exactly as it does on the desktop.
installBridge()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)

// The service worker is what makes this installable, which on iOS is what
// gives it a real viewport, no Safari chrome, and a home-screen icon.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
