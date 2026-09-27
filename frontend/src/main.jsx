import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
// Fonts are bundled (no Google Fonts) so the UI renders offline on the Pi.
import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource-variable/jetbrains-mono'
import './i18n/fonts.css'
import './index.css'
import { installResilientFetch } from './utils/resilientFetch'
import { initI18n } from './i18n'

// Before the first render: every fetch() in the app (and AuthContext's 401
// interceptor, which wraps this) gets resume-tolerant /api GETs. Phones freeze
// background tabs and drop their sockets; see utils/resilientFetch.js.
installResilientFetch()

const render = () => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

// Load the language and the shell namespaces (local chunks, a few ms) before
// the first paint so the shell never flashes raw keys. Never block the app on
// it: after 3 s render anyway (Suspense covers the rest).
let rendered = false
const renderOnce = () => { if (!rendered) { rendered = true; render() } }
initI18n().finally(renderOnce)
setTimeout(renderOnce, 3000)
