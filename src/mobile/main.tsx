import React from 'react'
import ReactDOM from 'react-dom/client'
import '../renderer/src/assets/main.css'
import './mobile.css'
import { MobileApp } from './MobileApp'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>
)
