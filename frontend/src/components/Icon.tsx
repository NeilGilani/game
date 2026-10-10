/**
 * One consistent icon set: Lucide (ISC licence), drawn at a heavier stroke for legibility. Icons are decorative: the
 * text next to them carries the meaning. Names are AGENCY's own, so screens never import Lucide directly.
 */
import {
  AlarmClock,
  ArrowLeft,
  BadgeAlert,
  Bell,
  BellOff,
  Calendar,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock,
  Cpu,
  Eye,
  EyeClosed,
  FileText,
  Globe,
  Hand,
  HeartPulse,
  House,
  Info,
  Image,
  Mail,
  Music,
  Newspaper,
  BookOpen,
  CloudSun,
  Tv,
  Keyboard,
  LayoutGrid,
  Laptop,
  List,
  ListChecks,
  MessageCircle,
  MessagesSquare,
  MousePointer2,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanFace,
  Settings,
  Shield,
  ShoppingBag,
  SkipForward,
  Sparkles,
  Square,
  Target,
  TriangleAlert,
  User,
  UtensilsCrossed,
  WifiOff,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  check: Check,
  food: UtensilsCrossed,
  bag: ShoppingBag,
  globe: Globe,
  grid: LayoutGrid,
  speak: MessagesSquare,
  x: X,
  clock: Clock,
  hand: Hand,
  question: CircleHelp,
  alert: TriangleAlert,
  pause: Pause,
  play: Play,
  stop: Square,
  camera: Camera,
  eye: Eye,
  home: House,
  plus: Plus,
  list: List,
  gear: Settings,
  wrench: Wrench,
  calendar: Calendar,
  document: FileText,
  message: MessageCircle,
  resume: RotateCcw,
  info: Info,
  left: ChevronLeft,
  right: ChevronRight,
  shield: Shield,
  chip: Cpu,
  laptop: Laptop,
  offline: WifiOff,
  refresh: RefreshCw,
  sparkle: Sparkles,
  target: Target,
  skip: SkipForward,
  timeline: ListChecks,
  key: Keyboard,
  keyboard: Keyboard,
  head: ScanFace,
  blink: EyeClosed,
  pointer: MousePointer2,
  edit: Pencil,
  back: ArrowLeft,
  bell: Bell,
  mute: BellOff,
  down: ChevronDown,
  lifeline: HeartPulse,
  phone: Phone,
  watch: AlarmClock,
  name: User,
  badge: BadgeAlert,
  music: Music,
  tv: Tv,
  news: Newspaper,
  weather: CloudSun,
  book: BookOpen,
  mail: Mail,
  photo: Image,
};

export function Icon({ name, size = 24, label }: { name: string; size?: number; label?: string }) {
  const Glyph = ICONS[name] ?? Info;
  return (
    <Glyph
      className="ico"
      size={size}
      strokeWidth={2.25}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    />
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <path
        d="M15 46 L32 15 L49 46"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="37.5" r="5.5" fill="var(--focus)" />
    </svg>
  );
}
