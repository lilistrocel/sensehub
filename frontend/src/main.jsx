import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
// Fonts are bundled (no Google Fonts) so the UI renders offline on the Pi.
import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import { installResilientFetch } from './utils/resilientFetch'

// Before the first render: every fetch() in the app (and AuthContext's 401
// interceptor, which wraps this) gets resume-tolerant /api GETs. Phones freeze
// background tabs and drop their sockets; see utils/resilientFetch.js.
installResilientFetch()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
