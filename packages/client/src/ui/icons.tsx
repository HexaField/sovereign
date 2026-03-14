// Sovereign UI Icons — Lucide-style inline SVG components
// No icon library dependency. Consistent 24x24 viewBox, stroke-width 2.

import type { JSX } from 'solid-js'

interface IconProps {
  class?: string
  style?: JSX.CSSProperties | string
}

const defaults = (props: IconProps) => ({
  class: props.class ?? 'w-5 h-5',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
  ...(props.style ? { style: props.style } : {})
})

// ── Navigation / Shell ───────────────────────────────────────────────

export function DashboardIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

export function WorkspaceIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <rect x="2" y="6" width="15" height="14" rx="2" />
      <path d="M7 6V4a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-2" />
    </svg>
  )
}

export function CanvasIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M12 2l9.196 5.308v10.616L12 23.232 2.804 17.924V7.308z" />
    </svg>
  )
}

export function PlanningIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  )
}

export function SystemIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export function ChatIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export function VoiceIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

export function MicIcon(props: IconProps = {}) {
  return <VoiceIcon {...props} />
}

export function EventsIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

export function NotificationsIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <circle cx="18" cy="4" r="3" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function RecordingIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function LogsIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

export function FilesIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export function FileIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

export function GitIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

export function ThreadsIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="9" y1="9" x2="15" y2="9" />
      <line x1="9" y1="13" x2="13" y2="13" />
    </svg>
  )
}

export function MeetingsIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  )
}

export function TerminalIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

export function SettingsIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  )
}

export function LockIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

export function SendIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

export function ExpandIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

export function CollapseIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

export function MenuIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

export function CloseIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

export function ChevronDownIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

export function ChevronLeftIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

export function ChevronRightIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

export function SearchIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

export function PlusIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function BotIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="9" cy="16" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="16" r="1" fill="currentColor" stroke="none" />
      <path d="M12 2v4" />
      <path d="M8 11V9a4 4 0 0 1 8 0v2" />
    </svg>
  )
}

export function HealthyIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

export function ImportIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

export function PlayIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

export function PauseIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  )
}

export function StopIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    </svg>
  )
}

export function SaveIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  )
}

export function AttachIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

export function ClockIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

export function LoaderIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
      <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
      <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
    </svg>
  )
}

// ── Tool / Work Section Icons ────────────────────────────────────────

export function ReadIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  )
}

export function WriteIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}

export function EditIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M4 13.5V4a2 2 0 0 1 2-2h6.5L18 7.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.5" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="2" y1="17" x2="12" y2="17" />
    </svg>
  )
}

export function ExecIcon(props: IconProps = {}) {
  return <TerminalIcon {...props} />
}

export function ProcessIcon(props: IconProps = {}) {
  return <SystemIcon {...props} />
}

export function BrowserIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

export function PlugIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a6 6 0 0 1-12 0V8z" />
    </svg>
  )
}

export function BrainIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M9.5 2A3.5 3.5 0 0 0 6 5.5c0 .59.15 1.15.41 1.64A3.5 3.5 0 0 0 4 10.5a3.5 3.5 0 0 0 2.39 3.32A3.5 3.5 0 0 0 6 15.5 3.5 3.5 0 0 0 9.5 19h.09A4.49 4.49 0 0 0 12 22a4.49 4.49 0 0 0 2.41-3h.09a3.5 3.5 0 0 0 3.5-3.5c0-.62-.16-1.2-.44-1.7A3.5 3.5 0 0 0 20 10.5a3.5 3.5 0 0 0-2.41-3.33c.26-.5.41-1.05.41-1.67A3.5 3.5 0 0 0 14.5 2 3.5 3.5 0 0 0 12 3.17 3.5 3.5 0 0 0 9.5 2z" />
      <path d="M12 3v19" />
    </svg>
  )
}

export function SpeakerIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

export function FlaskIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M9 3h6" />
      <path d="M10 3v7.5L4 19a1 1 0 0 0 .87 1.5h14.26A1 1 0 0 0 20 19l-6-8.5V3" />
    </svg>
  )
}

export function ListIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

export function ScrollIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h12" />
    </svg>
  )
}

export function PhoneIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  )
}

export function WrenchIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}

export function SignalIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M2 20h.01" />
      <path d="M7 20v-4" />
      <path d="M12 20v-8" />
      <path d="M17 20V8" />
      <path d="M22 4v16" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

export function AlertIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

export function ThoughtIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <circle cx="9" cy="10" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function PinIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z" />
    </svg>
  )
}

export function HeartIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  )
}

export function BroomIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M15 2l-4 10h6L7 22l4-10H5z" />
    </svg>
  )
}

export function SplitIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  )
}

export function EyeIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function TicketIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z" />
    </svg>
  )
}

export function TreeIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M12 22V8" />
      <path d="M5 12l7-8 7 8" />
      <path d="M7 18l5-6 5 6" />
    </svg>
  )
}

export function AxeIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M14 12l-8.5 8.5a2.12 2.12 0 1 1-3-3L11 9" />
      <path d="M15 13L9.6 7.6a2 2 0 0 1 0-2.83l.17-.17a2 2 0 0 1 2.83 0l5.66 5.66a2 2 0 0 1 0 2.83l-.17.17a2 2 0 0 1-2.83 0z" />
    </svg>
  )
}

export function CircleDotIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ImageIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

// ── Language file type icons (simple colored text variants) ──────────

export function CodeTsIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M9 15v-2h6v2" style={{ 'stroke-width': '1.5' }} />
    </svg>
  )
}

export function PaletteIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" stroke="none" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  )
}

// ── Check / Status ───────────────────────────────────────────────────

export function CheckIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export function XCircleIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  )
}

export function AlertCircleIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

export function WarningIcon(props: IconProps = {}) {
  return <AlertIcon {...props} />
}

export function InfoIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}

// ── Misc ─────────────────────────────────────────────────────────────

export function DownloadIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

export function ExternalLinkIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

export function HashIcon(props: IconProps = {}) {
  return (
    <svg {...defaults(props)}>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  )
}
